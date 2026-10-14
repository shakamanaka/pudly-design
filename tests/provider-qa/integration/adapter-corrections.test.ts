import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../../src/adapters/providers/claude-code-adapter.js';
import type { CodingAgentRequest, RunEvent } from '../../../src/domain/types.js';

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'provider-correction-qa-'));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function request(runId: string): CodingAgentRequest {
  return {
    runId,
    documentId: 'provider-correction-qa',
    baseRevision: 0,
    prompt: 'Return no design operations for this deterministic provider QA probe.',
    selectedNodeIds: [],
    documentFragment: { documentId: 'provider-correction-qa', revision: 0, nodes: {}, tokens: {}, components: {} },
    resolvedContext: [],
    operationCapabilities: ['node.create'],
  };
}

async function makeClaudeFixture(directory: string, scriptBody: string): Promise<string> {
  const executable = join(directory, 'claude-fixture.mjs');
  await writeFile(executable, `#!/usr/bin/env node\n${scriptBody}\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

async function collect(adapter: ClaudeCodeAdapter, runId: string, signal: AbortSignal): Promise<Array<RunEvent | { type: 'response'; response: unknown }>> {
  const events: Array<RunEvent | { type: 'response'; response: unknown }> = [];
  for await (const event of adapter.execute(request(runId), signal)) events.push(event);
  return events;
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const contents = await readFile(path, 'utf8');
      if (contents) return contents;
    } catch { /* The child has not published its handshake yet. */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`The process startup handshake was not observed within ${timeoutMs}ms.`);
}

describe('provider runtime correction regressions', () => {
  it.skipIf(process.platform === 'win32')('kills a surviving process-group grandchild after its parent exits on abort', async () => {
    const directory = await createRoot();
    const handshakePath = join(directory, 'grandchild-ready.txt');
    const markerPath = join(directory, 'grandchild-survived.txt');
    const executable = await makeClaudeFixture(directory, `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const grandchildSource = [
        "process.on('SIGTERM', () => {});",
        "require('node:fs').writeFileSync(process.argv[2], 'ready');",
        "setTimeout(() => { require('node:fs').writeFileSync(process.argv[1], 'survived'); process.exit(0); }, 800);",
      ].join('');
      spawn(process.execPath, ['-e', grandchildSource, ${JSON.stringify(markerPath)}, ${JSON.stringify(handshakePath)}], { stdio: 'ignore' });
      setInterval(() => {}, 1000);
    `);
    const adapter = new ClaudeCodeAdapter({
      executable,
      tempRoot: directory,
      model: 'sonnet',
      effort: 'low',
      authSource: 'claude-subscription',
      timeoutMs: 5000,
      killGraceMs: 100,
    });
    const controller = new AbortController();
    const run = collect(adapter, 'claude-grandchild-abort', controller.signal);
    const runResult = run.then(events => ({ events }), error => ({ error }));
    let events: Array<RunEvent | { type: 'response'; response: unknown }> | undefined;
    try {
      expect(await waitForFile(handshakePath, 2000)).toBe('ready');
      controller.abort();
      const outcome = await runResult;
      expect(outcome).not.toHaveProperty('error');
      if ('events' in outcome) events = outcome.events;
    } finally {
      controller.abort();
      await runResult;
    }

    expect(events?.some(event => event.type === 'state' && event.state === 'CANCELLED')).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 900));
    await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['authentication_error', 'provider.authentication'],
    ['billing_error', 'provider.quota'],
    ['rate_limit_error', 'provider.rate_limit'],
  ])('classifies structured Claude %s failures without retaining provider prose or credentials', async (subtype, expectedCode) => {
    const directory = await createRoot();
    const secret = 'claude-error-secret-sentinel';
    const rawProviderText = `provider raw error prose ${secret}`;
    const executable = await makeClaudeFixture(directory, `
      for await (const part of process.stdin) void part;
      process.stdout.write(JSON.stringify({
        type: 'error',
        error: { type: ${JSON.stringify(subtype)}, message: ${JSON.stringify(rawProviderText)} },
      }));
    `);
    const adapter = new ClaudeCodeAdapter({
      executable,
      tempRoot: directory,
      model: 'sonnet',
      effort: 'low',
      authSource: 'anthropic-api-key',
      credential: secret,
    });

    const events: Array<RunEvent | { type: 'response'; response: unknown }> = [];
    let caught: unknown;
    try {
      for await (const event of adapter.execute(request(`claude-${subtype}`), new AbortController().signal)) events.push(event);
    } catch (error) { caught = error; }

    expect(caught).toMatchObject({ code: expectedCode });
    expect(String(caught)).not.toContain(rawProviderText);
    expect(String(caught)).not.toContain(secret);
    const diagnostics = events.filter((event): event is Extract<RunEvent, { type: 'diagnostic' }> => event.type === 'diagnostic');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.diagnostic.code).toBe(expectedCode);
    expect(JSON.stringify(diagnostics)).not.toContain(rawProviderText);
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
    const status = await adapter.getStatus(`claude-${subtype}`);
    expect(JSON.stringify(status)).not.toContain(rawProviderText);
    expect(JSON.stringify(status)).not.toContain(secret);
  });

  it('maps Claude execution-limit subtype to a distinct safe code', async () => {
    const directory = await createRoot();
    const executable = await makeClaudeFixture(directory, `
      for await (const part of process.stdin) void part;
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }));
    `);
    const adapter = new ClaudeCodeAdapter({ executable, tempRoot: directory, model: 'sonnet', effort: 'low', authSource: 'claude-subscription' });
    const events: Array<RunEvent | { type: 'response'; response: unknown }> = [];
    let caught: unknown;
    try {
      for await (const event of adapter.execute(request('claude-limit'), new AbortController().signal)) events.push(event);
    } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: 'provider.execution_limit' });
    expect(events.some(event => event.type === 'diagnostic' && event.diagnostic.code === 'provider.execution_limit')).toBe(true);
  });
});
