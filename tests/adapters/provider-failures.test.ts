import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/providers/claude-code-adapter.js';
import { MiniMaxAdapter } from '../../src/adapters/providers/minimax-adapter.js';
import type { CodingAgentRequest, RunEvent } from '../../src/domain/types.js';

const directories: string[] = [];
const SECRET = 'provider-fixture-secret-sentinel';
const RAW = 'provider-raw-error-sentinel';
const VALID = { operations: [], summary: 'fixture accepted' };

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'provider-failure-fixture-'));
  directories.push(path);
  return path;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function request(runId: string): CodingAgentRequest {
  return {
    runId, documentId: 'provider-fixture', baseRevision: 0,
    prompt: 'Return an empty operation list for this provider adapter fixture.', selectedNodeIds: [],
    documentFragment: { documentId: 'provider-fixture', revision: 0, nodes: {}, tokens: {}, components: {} },
    resolvedContext: [], operationCapabilities: ['node.create'],
  };
}

async function executable(directory: string, source: string): Promise<string> {
  const path = join(directory, 'provider-fixture.mjs');
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

async function collect(adapter: ClaudeCodeAdapter | MiniMaxAdapter, runId: string, signal = new AbortController().signal): Promise<Array<RunEvent | { type: 'response'; response: unknown }>> {
  const events: Array<RunEvent | { type: 'response'; response: unknown }> = [];
  for await (const event of adapter.execute(request(runId), signal)) events.push(event);
  return events;
}

function claudeEnvelope(extra: Record<string, unknown> = {}) {
  return { type: 'result', subtype: 'success', is_error: false, structured_output: VALID, ...extra };
}
function miniMaxResponse(content: unknown = JSON.stringify(VALID)) {
  return { choices: [{ message: { content } }] };
}

async function waitForFile(path: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const value = await readFile(path, 'utf8'); if (value.trim()) return value; } catch { /* The fixture has not created the file yet. */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Fixture did not write its startup handshake.');
}

function safeFailure(error: unknown, code: string) {
  expect(error).toMatchObject({ code });
  const serialized = error instanceof Error ? `${error.message}\n${JSON.stringify(error)}` : String(error);
  expect(serialized).not.toContain(SECRET);
  expect(serialized).not.toContain(RAW);
}

describe('provider adapter failure contracts (deterministic fixtures only)', () => {
  it('accepts a valid structured response from each provider adapter', async () => {
    const directory = await temporaryDirectory();
    const cli = await executable(directory, `for await (const part of process.stdin) void part; process.stdout.write(${JSON.stringify(JSON.stringify(claudeEnvelope()))});`);
    const claude = new ClaudeCodeAdapter({ executable: cli, tempRoot: directory, model: 'sonnet', effort: 'low', authSource: 'claude-subscription' });
    expect((await collect(claude, 'claude-accepted')).some(event => event.type === 'response')).toBe(true);

    const minimax = new MiniMaxAdapter({ model: 'MiniMax-M2.7', effort: 'default', credential: SECRET, fetcher: async () => Response.json(miniMaxResponse()) });
    expect((await collect(minimax, 'minimax-accepted')).some(event => event.type === 'response')).toBe(true);
  });

  it('rejects invalid JSON and invalid or error-shaped response envelopes without raw content', async () => {
    const directory = await temporaryDirectory();
    const invalidJson = await executable(directory, `for await (const part of process.stdin) void part; process.stdout.write(${JSON.stringify(RAW)});`);
    const invalidClaude = new ClaudeCodeAdapter({ executable: invalidJson, tempRoot: directory, model: 'sonnet', effort: 'low', authSource: 'claude-subscription' });
    await expect(collect(invalidClaude, 'claude-invalid-json')).rejects.toMatchObject({ code: 'protocol.invalid_json' });

    const badShape = await executable(directory, `for await (const part of process.stdin) void part; process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(JSON.stringify(VALID))}}));`);
    const malformedClaude = new ClaudeCodeAdapter({ executable: badShape, tempRoot: directory, model: 'sonnet', effort: 'low', authSource: 'claude-subscription' });
    await expect(collect(malformedClaude, 'claude-invalid-shape')).rejects.toMatchObject({ code: 'protocol.response_missing' });

    const errorWithPayload = await executable(directory, `for await (const part of process.stdin) void part; process.stdout.write(JSON.stringify(${JSON.stringify({ ...claudeEnvelope(), subtype: 'error_during_execution', is_error: true, error: { type: 'api_error', message: RAW } })})); process.exitCode=1;`);
    const errorClaude = new ClaudeCodeAdapter({ executable: errorWithPayload, tempRoot: directory, model: 'sonnet', effort: 'low', authSource: 'claude-subscription' });
    const error = await collect(errorClaude, 'claude-error-envelope').then(() => undefined, value => value);
    safeFailure(error, 'provider.cli_failed');

    const malformedMini = new MiniMaxAdapter({ model: 'MiniMax-M2.7', effort: 'default', credential: SECRET, fetcher: async () => new Response(RAW) });
    const miniJsonFailure = await collect(malformedMini, 'minimax-invalid-json').then(() => undefined, value => value);
    safeFailure(miniJsonFailure, 'protocol.invalid_json');
    const malformedEnvelope = new MiniMaxAdapter({ model: 'MiniMax-M2.7', effort: 'default', credential: SECRET, fetcher: async () => Response.json({ choices: [] }) });
    const miniShapeFailure = await collect(malformedEnvelope, 'minimax-invalid-shape').then(() => undefined, value => value);
    safeFailure(miniShapeFailure, 'protocol.response_missing');
  });

  it('fails closed for unsupported provider effort', () => {
    expect(() => new MiniMaxAdapter({ model: 'MiniMax-M2.7', effort: 'high', credential: SECRET })).toThrow(/effort control is not documented/);
    expect(() => new ClaudeCodeAdapter({ model: 'sonnet', effort: 'default', authSource: 'anthropic-api-key', credential: SECRET })).not.toThrow();
    expect(() => new ClaudeCodeAdapter({ model: 'sonnet', effort: 'none' as never, authSource: 'anthropic-api-key', credential: SECRET }))
      .toThrow(/effort is unsupported/);
  });

  it.each([
    ['authentication_error', 'provider.authentication'],
    ['billing_error', 'provider.quota'],
    ['rate_limit_error', 'provider.rate_limit'],
  ])('maps Claude structured error type %s safely', async (type, code) => {
    const directory = await temporaryDirectory();
    const output = { type: 'error', error: { type, message: RAW } };
    const cli = await executable(directory, `for await (const part of process.stdin) void part; process.stdout.write(${JSON.stringify(JSON.stringify(output))}); process.exitCode=1;`);
    const adapter = new ClaudeCodeAdapter({ executable: cli, tempRoot: directory, model: 'sonnet', effort: 'low', authSource: 'claude-subscription' });
    const error = await collect(adapter, `claude-${type}`).then(() => undefined, value => value);
    safeFailure(error, code);
    const status = await adapter.getStatus(`claude-${type}`);
    expect(status.state).toBe('FAILED');
  });

  it('maps Claude usage_limit_reached result metadata to quota without relying on HTTP status alone', async () => {
    const directory = await temporaryDirectory();
    const output = claudeEnvelope({ is_error: true, terminal_reason: 'api_error', api_error_status: 429, api_error: 'usage_limit_reached' });
    const cli = await executable(directory, `for await (const part of process.stdin) void part; process.stdout.write(${JSON.stringify(JSON.stringify(output))});`);
    const adapter = new ClaudeCodeAdapter({ executable: cli, tempRoot: directory, model: 'haiku', effort: 'default', authSource: 'claude-subscription' });
    const error = await collect(adapter, 'claude-usage-limit').then(() => undefined, value => value);
    safeFailure(error, 'provider.quota');
  });

  it.each([
    [401, 'provider.authentication'], [402, 'provider.quota'], [429, 'provider.rate_limit'],
    [400, 'provider.quota', { error: { type: 'billing_error', message: RAW } }],
    [400, 'provider.rate_limit', { error: { type: 'rate_limit_error', message: RAW } }],
  ])('maps MiniMax HTTP/typed failure %i to a safe stable category', async (status, code, body: unknown = { error: { type: 'generic_error', message: RAW } }) => {
    const adapter = new MiniMaxAdapter({ model: 'MiniMax-M2.7', effort: 'default', credential: SECRET, fetcher: async () => Response.json(body, { status }) });
    const error = await collect(adapter, `minimax-http-${status}-${code}`).then(() => undefined, value => value);
    safeFailure(error, code);
  });

  it('distinguishes timeout from cancellation for both transports', async () => {
    const directory = await temporaryDirectory();
    const hangingCli = await executable(directory, `for await (const part of process.stdin) void part; setInterval(() => {}, 1000);`);
    const timedClaude = new ClaudeCodeAdapter({ executable: hangingCli, tempRoot: directory, model: 'sonnet', effort: 'low', authSource: 'claude-subscription', timeoutMs: 40, killGraceMs: 10 });
    const timeout = await collect(timedClaude, 'claude-timeout').then(() => undefined, error => error);
    safeFailure(timeout, 'agent.timeout');

    const waiting = new MiniMaxAdapter({ model: 'MiniMax-M2.7', effort: 'default', credential: SECRET, timeoutMs: 40, fetcher: async (_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })) });
    const miniTimeout = await collect(waiting, 'minimax-timeout').then(() => undefined, error => error);
    safeFailure(miniTimeout, 'agent.timeout');

    const marker = join(directory, 'cancel-started');
    const cancelFixture = await executable(directory, `import { writeFile } from 'node:fs/promises'; await writeFile(${JSON.stringify(marker)}, 'started'); for await (const part of process.stdin) void part; setInterval(() => {}, 1000);`);
    const cancelController = new AbortController();
    const cancelCli = new ClaudeCodeAdapter({ executable: cancelFixture, tempRoot: directory, model: 'sonnet', effort: 'low', authSource: 'claude-subscription', timeoutMs: 5000, killGraceMs: 10 });
    const cancelled = collect(cancelCli, 'claude-cancel', cancelController.signal);
    await waitForFile(marker);
    cancelController.abort();
    const events = await cancelled;
    expect(events.some(event => event.type === 'state' && event.state === 'CANCELLED')).toBe(true);
    expect(events.some(event => event.type === 'response')).toBe(false);

    const miniController = new AbortController();
    let fetchStarted!: () => void;
    const started = new Promise<void>(resolve => { fetchStarted = resolve; });
    const miniCancel = new MiniMaxAdapter({ model: 'MiniMax-M2.7', effort: 'default', credential: SECRET, timeoutMs: 5000, fetcher: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      fetchStarted();
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }) });
    const miniRun = collect(miniCancel, 'minimax-cancel', miniController.signal);
    await started;
    miniController.abort();
    const miniEvents = await miniRun;
    expect(miniEvents.some(event => event.type === 'state' && event.state === 'CANCELLED')).toBe(true);
    expect(miniEvents.some(event => event.type === 'response')).toBe(false);
  });

  it('bounds oversized output and redacts provider body and credential sentinels', async () => {
    const directory = await temporaryDirectory();
    const largeCli = await executable(directory, `for await (const part of process.stdin) void part; process.stdout.write('x'.repeat(2048));`);
    const claude = new ClaudeCodeAdapter({ executable: largeCli, tempRoot: directory, model: 'sonnet', effort: 'low', authSource: 'claude-subscription', maxOutputBytes: 128 });
    const cliError = await collect(claude, 'claude-large').then(() => undefined, error => error);
    safeFailure(cliError, 'agent.output_too_large');

    const mini = new MiniMaxAdapter({ model: 'MiniMax-M2.7', effort: 'default', credential: SECRET, maxOutputBytes: 32, fetcher: async () => new Response(RAW.repeat(20)) });
    const miniError = await collect(mini, 'minimax-large').then(() => undefined, error => error);
    safeFailure(miniError, 'agent.output_too_large');
  });

  it('reports exhausted Claude structured-output retries without leaking tool input', async () => {
    const directory = await temporaryDirectory();
    const cli = await executable(directory, `process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I will format the structured response.' }] }}) + '\\n'); process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, errors: [${JSON.stringify(RAW + SECRET)}] }) + '\\n'); process.exitCode = 1;`);
    const adapter = new ClaudeCodeAdapter({ executable: cli, tempRoot: directory, model: 'haiku', effort: 'high', authSource: 'claude-subscription', timeoutMs: 5000 });
    const error = await collect(adapter, 'claude-format-retries').then(() => undefined, failure => failure);
    safeFailure(error, 'protocol.invalid_response');
    expect(error.message).toContain('structured design operations');
  });

  it.each([
    ['assistant text without a result', `JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Here is a design.' }] } }) + '\\n'`, 'protocol.response_missing'],
    ['a malformed NDJSON line', `JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\\nnot-json\\n'`, 'protocol.invalid_json'],
    ['multiple final results', `[${JSON.stringify(JSON.stringify(claudeEnvelope()))}, ${JSON.stringify(JSON.stringify(claudeEnvelope()))}].join('\\n') + '\\n'`, 'protocol.response_missing'],
    ['metadata after the final result', `${JSON.stringify(JSON.stringify(claudeEnvelope()))} + '\\n' + JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\\n'`, 'protocol.response_missing'],
  ])('rejects Claude stream with %s', async (_label, output, code) => {
    const directory = await temporaryDirectory();
    const cli = await executable(directory, `process.stdout.write(${output});`);
    const adapter = new ClaudeCodeAdapter({ executable: cli, tempRoot: directory, model: 'haiku', effort: 'default', authSource: 'claude-subscription' });
    const error = await collect(adapter, `claude-stream-${code}`).then(() => undefined, value => value);
    safeFailure(error, code);
  });

  it('kills a resistant descendant after its parent exits on SIGTERM', async () => {
    if (process.platform === 'win32') return;
    const directory = await temporaryDirectory();
    const marker = join(directory, 'descendant.pid');
    const fixture = await executable(directory, `
      import { spawn } from 'node:child_process';
      import { writeFile } from 'node:fs/promises';
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: 'ignore' });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      await writeFile(${JSON.stringify(marker)}, String(child.pid));
      process.once('SIGTERM', () => process.exit(0));
      for await (const part of process.stdin) void part;
      setInterval(() => {}, 1000);
    `);
    const adapter = new ClaudeCodeAdapter({ executable: fixture, tempRoot: directory, model: 'sonnet', effort: 'low', authSource: 'claude-subscription', timeoutMs: 5000, killGraceMs: 30 });
    const run = collect(adapter, 'claude-descendant');
    const descendantPid = Number(await waitForFile(marker));
    expect(Number.isSafeInteger(descendantPid) && descendantPid > 1).toBe(true);
    await adapter.cancel('claude-descendant');
    const events = await run;
    expect(events.some(event => event.type === 'state' && event.state === 'CANCELLED')).toBe(true);
    const deadline = Date.now() + 3000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try { process.kill(descendantPid, 0); await new Promise(resolve => setTimeout(resolve, 10)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw error; }
    }
    expect(alive, `descendant ${descendantPid} should be gone after group SIGKILL`).toBe(false);
  });
});
