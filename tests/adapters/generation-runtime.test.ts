import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexCliAdapter, DEFAULT_GENERATION_TIMEOUT_MS } from '../../src/adapters/codex';
import type { CodingAgentRequest } from '../../src/domain/types';

const roots: string[] = [];
const fixtureBody = String.raw`
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
let input = '';
for await (const chunk of process.stdin) input += chunk;
if (input.includes('__runtime_hang__')) await new Promise(() => setInterval(() => {}, 1000));
if (input.includes('__runtime_descendant__')) {
  const [output, started] = input.match(/__runtime_descendant__(.*?)['"\\\\]/)?.[1]?.split('|') ?? [];
  spawn(process.execPath, ['-e', "require('fs').writeFileSync(" + JSON.stringify(started) + ", 'started'); process.on('SIGTERM', () => {}); setTimeout(() => require('fs').writeFileSync(" + JSON.stringify(output) + ", 'alive'), 900); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
  await new Promise(() => setInterval(() => {}, 1000));
}
if (input.includes('__runtime_exit__')) { process.stderr.write('credential=must-never-be-persisted'); process.exit(19); }
const resultPath = process.argv[process.argv.indexOf('--output-last-message') + 1];
if (input.includes('__runtime_protocol__')) await writeFile(resultPath, JSON.stringify({ operations: [{}], summary: 'bad operation' }));
else await writeFile(resultPath, JSON.stringify({ operations: [], summary: 'ok' }));
process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
`;

async function setup(timeoutMs = 5_000) {
  const root = await mkdtemp(join(tmpdir(), 'codex-design-runtime-'));
  roots.push(root);
  const fixture = join(root, 'fixture.mjs');
  const executable = join(root, 'codex-fixture');
  await writeFile(fixture, fixtureBody);
  await writeFile(executable, `#!/bin/sh\nexec node "${fixture}" "$@"\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { root, adapter: new CodexCliAdapter({ executable, tempRoot: root, timeoutMs, killGraceMs: 100 }) };
}

function request(prompt: string): CodingAgentRequest {
  return {
    runId: 'run_runtime', documentId: 'doc_runtime', baseRevision: 0, prompt,
    selectedNodeIds: [], documentFragment: { documentId: 'doc_runtime', revision: 0, nodes: {}, tokens: {}, components: {} },
    resolvedContext: [], operationCapabilities: ['node.create', 'node.delete', 'node.move', 'property.set', 'layout.set', 'style.set'],
  };
}

async function collectFailure(adapter: CodexCliAdapter, prompt: string) {
  const events: unknown[] = [];
  await expect(async () => {
    for await (const event of adapter.execute(request(prompt), new AbortController().signal)) events.push(event);
  }).rejects.toMatchObject({ code: expect.any(String), diagnostics: [] });
  return events;
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('generation runtime reliability', () => {
  it('uses a five minute default generation deadline', () => {
    expect(DEFAULT_GENERATION_TIMEOUT_MS).toBe(300_000);
  });

  it('reports timeout as a typed actionable failure', async () => {
    const { adapter } = await setup(100);
    const events = await collectFailure(adapter, '__runtime_hang__');
    expect(events).toContainEqual(expect.objectContaining({ type: 'diagnostic', diagnostic: expect.objectContaining({ code: 'agent.timeout' }) }));
  });

  it('reports nonzero exit without retaining stderr contents', async () => {
    const { adapter } = await setup();
    const events = await collectFailure(adapter, '__runtime_exit__');
    expect(events).toContainEqual(expect.objectContaining({ type: 'diagnostic', diagnostic: expect.objectContaining({ code: 'agent.exit_failed' }) }));
    expect(JSON.stringify(events)).not.toContain('must-never-be-persisted');
  });

  it('keeps protocol validation failures typed and actionable', async () => {
    const { adapter } = await setup();
    const events = await collectFailure(adapter, '__runtime_protocol__');
    expect(events).toContainEqual(expect.objectContaining({ type: 'diagnostic', diagnostic: expect.objectContaining({ code: 'protocol.shape' }) }));
  });

  it('cancels the owned process group, including a child that ignores SIGTERM', async () => {
    const { adapter, root } = await setup(5_000);
    const marker = join(root, 'descendant-survived');
    const started = join(root, 'descendant-started');
    const events: unknown[] = [];
    const execution = (async () => {
      for await (const event of adapter.execute(request('__runtime_descendant__' + marker + '|' + started), new AbortController().signal)) events.push(event);
    })();
    // Wait for the descendant handshake before testing cancellation, rather than
    // assuming process startup completes within 300ms under concurrent tests.
    const deadline = Date.now() + 3_000;
    while (true) {
      try { await readFile(started, 'utf8'); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await adapter.cancel('run_runtime');
    await execution;
    await new Promise((resolve) => setTimeout(resolve, 950));
    expect(events).toContainEqual(expect.objectContaining({ type: 'state', state: 'CANCELLED' }));
    expect(await readFile(started, 'utf8')).toBe('started');
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
