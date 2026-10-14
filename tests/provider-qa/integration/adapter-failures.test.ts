import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../../src/adapters/providers/claude-code-adapter.js';
import { MiniMaxAdapter } from '../../../src/adapters/providers/minimax-adapter.js';
import type { CodingAgentRequest, RunEvent } from '../../../src/domain/types.js';

const roots: string[] = [];
async function createRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'provider-adapter-qa-'));
  roots.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

function request(runId: string): CodingAgentRequest {
  return {
    runId,
    documentId: 'provider-adapter-qa',
    baseRevision: 0,
    prompt: 'Return no design operations for this deterministic adapter QA probe.',
    selectedNodeIds: [],
    documentFragment: { documentId: 'provider-adapter-qa', revision: 0, nodes: {}, tokens: {}, components: {} },
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

async function collect(adapter: ClaudeCodeAdapter, runId: string, signal = new AbortController().signal): Promise<Array<RunEvent | { type: 'response'; response: unknown }>> {
  const events: Array<RunEvent | { type: 'response'; response: unknown }> = [];
  for await (const event of adapter.execute(request(runId), signal)) events.push(event);
  return events;
}

describe('Claude Code adapter failure boundary', () => {
  it('launches in a temporary working directory with user/project customizations disabled', async () => {
    const directory = await createRoot();
    const capturePath = join(directory, 'launch.json');
    const executable = await makeClaudeFixture(directory, `
      import { writeFileSync } from 'node:fs';
      let prompt = ''; for await (const part of process.stdin) prompt += part;
      writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME, configDir: process.env.CLAUDE_CONFIG_DIR, apiKey: process.env.ANTHROPIC_API_KEY, authToken: process.env.ANTHROPIC_AUTH_TOKEN }));
      process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:{operations:[],summary:'ok'}}));
    `);
    const previousHome = process.env.HOME;
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = directory;
    process.env.CLAUDE_CONFIG_DIR = join(directory, 'claude-account-config');
    try {
      const adapter = new ClaudeCodeAdapter({ executable, tempRoot: directory, model: 'sonnet', effort: 'low', authSource: 'claude-subscription' });
      const events = await collect(adapter, 'claude-isolated-subscription');
      const captured = JSON.parse(await readFile(capturePath, 'utf8')) as { args: string[]; cwd: string; home?: string; configDir?: string; apiKey?: string; authToken?: string };
      expect(captured.cwd).not.toBe(process.cwd());
      expect(basename(captured.cwd).startsWith('codex-design-claude-')).toBe(true);
      expect(captured.home).toBe(directory);
      expect(captured.configDir).toBe(join(directory, 'claude-account-config'));
      expect(captured.args, 'Claude subscription must isolate local customizations and MCP tools')
        .toEqual(expect.arrayContaining(['--safe-mode', '--restricted', '--tools', '', '--disallowedTools', 'mcp__*']));
      expect(captured.args).toContain('--no-session-persistence');
      expect(captured.args).not.toContain('--bare');
      expect(captured.apiKey).toBeUndefined();
      expect(captured.authToken).toBeUndefined();
      expect(events.some(event => event.type === 'response')).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
  });

  it('uses only the selected Anthropic API credential through the API-key CLI path', async () => {
    const directory = await createRoot();
    const capturePath = join(directory, 'api-key-launch.json');
    const executable = await makeClaudeFixture(directory, `
      import { writeFileSync } from 'node:fs';
      for await (const part of process.stdin) void part;
      writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args: process.argv.slice(2), apiKey: process.env.ANTHROPIC_API_KEY, authToken: process.env.ANTHROPIC_AUTH_TOKEN }));
      process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:{operations:[],summary:'ok'}}));
    `);
    const previousKey = process.env.ANTHROPIC_API_KEY;
    const previousToken = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = 'ambient-wrong-key-sentinel';
    process.env.ANTHROPIC_AUTH_TOKEN = 'ambient-wrong-token-sentinel';
    try {
      const adapter = new ClaudeCodeAdapter({ executable, tempRoot: directory, model: 'sonnet', effort: 'low', authSource: 'anthropic-api-key', credential: 'selected-claude-api-key-sentinel' });
      await collect(adapter, 'claude-api-key-auth');
      const captured = JSON.parse(await readFile(capturePath, 'utf8')) as { args: string[]; apiKey?: string; authToken?: string };
      expect(captured.args).toContain('--bare');
      expect(captured.apiKey).toBe('selected-claude-api-key-sentinel');
      expect(captured.authToken).toBeUndefined();
      expect(captured.args.join(' ')).not.toContain('selected-claude-api-key-sentinel');
    } finally {
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previousKey;
      if (previousToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = previousToken;
    }
  });

  it('classifies malformed and oversized CLI responses without exposing raw output', async () => {
    const directory = await createRoot();
    const malformed = await makeClaudeFixture(directory, `for await (const part of process.stdin) void part; process.stdout.write('raw-provider-body-sentinel');`);
    const malformedAdapter = new ClaudeCodeAdapter({ executable: malformed, tempRoot: directory, model: 'sonnet', effort: 'low', authSource: 'claude-subscription' });
    await expect(collect(malformedAdapter, 'claude-malformed')).rejects.toMatchObject({ code: 'protocol.invalid_json' });

    const oversized = await makeClaudeFixture(directory, `for await (const part of process.stdin) void part; process.stdout.write('x'.repeat(2048));`);
    const oversizedAdapter = new ClaudeCodeAdapter({ executable: oversized, tempRoot: directory, model: 'sonnet', effort: 'low', authSource: 'claude-subscription', maxOutputBytes: 128 });
    await expect(collect(oversizedAdapter, 'claude-oversized')).rejects.toMatchObject({ code: 'agent.output_too_large' });
  });

  it('terminates on deadline and caller cancellation with distinct terminal outcomes', async () => {
    const directory = await createRoot();
    const executable = await makeClaudeFixture(directory, `for await (const part of process.stdin) void part; setInterval(() => {}, 1000);`);
    const timeoutAdapter = new ClaudeCodeAdapter({ executable, tempRoot: directory, model: 'sonnet', effort: 'low', authSource: 'claude-subscription', timeoutMs: 50, killGraceMs: 20 });
    await expect(collect(timeoutAdapter, 'claude-timeout')).rejects.toMatchObject({ code: 'agent.timeout' });

    const cancelAdapter = new ClaudeCodeAdapter({ executable, tempRoot: directory, model: 'sonnet', effort: 'low', authSource: 'claude-subscription', timeoutMs: 3000, killGraceMs: 20 });
    const controller = new AbortController();
    const run = collect(cancelAdapter, 'claude-cancelled', controller.signal);
    await new Promise(resolve => setTimeout(resolve, 30));
    controller.abort();
    const events = await run;
    expect(events.some(event => event.type === 'state' && event.state === 'CANCELLED')).toBe(true);
    expect(events.some(event => event.type === 'response')).toBe(false);
    expect((await cancelAdapter.getStatus('claude-cancelled')).state).toBe('CANCELLED');
  });
});

describe('MiniMax HTTP adapter failure boundary', () => {
  it('rejects malformed response envelopes and oversized bodies safely', async () => {
    const malformed = new MiniMaxAdapter({ model: 'MiniMax-M2.7', effort: 'default', credential: 'minimax-api-key-sentinel', fetcher: async () => new Response('raw-provider-body-sentinel') });
    await expect(async () => { for await (const event of malformed.execute(request('minimax-malformed'), new AbortController().signal)) void event; })
      .rejects.toMatchObject({ code: 'protocol.invalid_json' });

    const oversized = new MiniMaxAdapter({ model: 'MiniMax-M2.7', effort: 'default', credential: 'minimax-api-key-sentinel', maxOutputBytes: 32, fetcher: async () => new Response('x'.repeat(128), { headers: { 'content-length': '128' } }) });
    await expect(async () => { for await (const event of oversized.execute(request('minimax-oversized'), new AbortController().signal)) void event; })
      .rejects.toMatchObject({ code: 'agent.output_too_large' });
  });

  it('distinguishes fetch timeout from caller cancellation without emitting a response', async () => {
    const fetcher: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    const timeout = new MiniMaxAdapter({ model: 'MiniMax-M2.7', effort: 'default', credential: 'minimax-api-key-sentinel', timeoutMs: 10, fetcher });
    await expect(async () => { for await (const event of timeout.execute(request('minimax-timeout'), new AbortController().signal)) void event; })
      .rejects.toMatchObject({ code: 'agent.timeout' });

    const cancelled = new MiniMaxAdapter({ model: 'MiniMax-M2.7', effort: 'default', credential: 'minimax-api-key-sentinel', timeoutMs: 1000, fetcher });
    const controller = new AbortController();
    const events: RunEvent[] = [];
    const run = (async () => { for await (const event of cancelled.execute(request('minimax-cancelled'), controller.signal)) if (event.type !== 'response') events.push(event); })();
    await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort();
    await run;
    expect(events.some(event => event.type === 'state' && event.state === 'CANCELLED')).toBe(true);
    expect(events.some(event => event.type === 'diagnostic')).toBe(false);
  });
});
