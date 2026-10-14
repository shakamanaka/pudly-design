import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/providers/claude-code-adapter.js';
import type { CodingAgentRequest, RunEvent } from '../../src/domain/types.js';

const temporaryRoots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codex-design-claude-stream-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function request(runId: string): CodingAgentRequest {
  return {
    runId,
    documentId: 'claude-stream-qa',
    baseRevision: 0,
    prompt: 'Return a fixture-only structured design response.',
    selectedNodeIds: [],
    documentFragment: { documentId: 'claude-stream-qa', revision: 0, nodes: {}, tokens: {}, components: {} },
    resolvedContext: [],
    operationCapabilities: ['node.create'],
  };
}

async function createFixture(root: string, lines: string[], captureArgs = false): Promise<{ executable: string; argsPath: string }> {
  const executable = join(root, 'claude-stream-fixture.mjs');
  const argsPath = join(root, 'args.json');
  const serializedLines = JSON.stringify(lines);
  await writeFile(executable, `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
if (${captureArgs ? 'true' : 'false'}) await writeFile(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
for await (const chunk of process.stdin) void chunk;
for (const line of ${serializedLines}) process.stdout.write(line + "\\n");
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { executable, argsPath };
}

function metadataEvents(): string[] {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fixture-session', tools: [] }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: { operations: [{ type: 'invalid-partial-op' }], summary: 'untrusted partial' } }] } }),
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"operations":[not complete' } } }),
    JSON.stringify({ type: 'tool_progress', tool_name: 'StructuredOutput', content: 'partial generation metadata' }),
  ];
}

function resultEvent(structuredOutput: unknown = { operations: [], summary: 'final structured payload' }): string {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: 'Ignore this human-readable explanation and partial tool content.',
    structured_output: structuredOutput,
  });
}

async function collect(adapter: ClaudeCodeAdapter, runId: string): Promise<Array<RunEvent | { type: 'response'; response: unknown }>> {
  const events: Array<RunEvent | { type: 'response'; response: unknown }> = [];
  for await (const event of adapter.execute(request(runId), new AbortController().signal)) events.push(event);
  return events;
}

async function fixtureAdapter(lines: string[], options: { maxOutputBytes?: number; timeoutMs?: number; captureArgs?: boolean } = {}) {
  const root = await createRoot();
  const fixture = await createFixture(root, lines, options.captureArgs);
  const adapter = new ClaudeCodeAdapter({
    executable: fixture.executable,
    tempRoot: root,
    model: 'sonnet',
    effort: 'low',
    authSource: 'claude-subscription',
    maxOutputBytes: options.maxOutputBytes ?? 32_768,
    timeoutMs: options.timeoutMs ?? 3_000,
  });
  return { adapter, ...fixture };
}

describe('Claude typed stream validation', () => {
  it('accepts metadata and partial tool events only when followed by one final structured success', async () => {
    const { adapter, argsPath } = await fixtureAdapter([...metadataEvents(), resultEvent()], { captureArgs: true });
    const events = await collect(adapter, 'claude-stream-valid');
    const responses = events.filter(event => event.type === 'response');

    expect(responses).toEqual([{ type: 'response', response: { operations: [], summary: 'final structured payload' } }]);
    expect(JSON.stringify(events)).not.toContain('untrusted partial');
    expect(JSON.stringify(events)).not.toContain('Ignore this human-readable explanation');
    const args = JSON.parse(await readFile(argsPath, 'utf8')) as string[];
    expect(args).toEqual(expect.arrayContaining([
      '--output-format', 'stream-json', '--verbose', '--json-schema', '--no-session-persistence',
      '--tools', '', '--disallowedTools', 'mcp__*', '--safe-mode', '--restricted',
    ]));
  });

  it.each([
    ['malformed NDJSON line', ['not-json'], 'protocol.invalid_json'],
    ['primitive event line', ['17'], 'protocol.response_missing'],
    ['missing final result', metadataEvents(), 'protocol.response_missing'],
    ['duplicate final result', [resultEvent(), resultEvent()], 'protocol.response_missing'],
    ['event after final result', [resultEvent(), JSON.stringify({ type: 'system', subtype: 'late' })], 'protocol.response_missing'],
  ])('rejects %s without emitting a partial response', async (_label, lines, code) => {
    const { adapter } = await fixtureAdapter(lines);
    const yielded: Array<RunEvent | { type: 'response'; response: unknown }> = [];
    await expect(async () => {
      for await (const event of adapter.execute(request(`claude-stream-${code}`), new AbortController().signal)) yielded.push(event);
    }).rejects.toMatchObject({ code });
    expect(yielded.some(event => event.type === 'response')).toBe(false);
  });

  it('treats a typed final failure after assistant/tool data as failure, never as structured success', async () => {
    const failure = JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'private provider details' } });
    const { adapter } = await fixtureAdapter([...metadataEvents(), failure]);
    const yielded: Array<RunEvent | { type: 'response'; response: unknown }> = [];
    await expect(async () => {
      for await (const event of adapter.execute(request('claude-stream-final-error'), new AbortController().signal)) yielded.push(event);
    }).rejects.toMatchObject({ code: 'provider.authentication' });
    expect(yielded.some(event => event.type === 'response')).toBe(false);
    expect(JSON.stringify(yielded)).not.toContain('private provider details');
  });

  it('rejects an output stream above the configured bound before accepting its result', async () => {
    const oversizedLine = JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(512) } });
    const { adapter } = await fixtureAdapter([oversizedLine, resultEvent()], { maxOutputBytes: 128 });
    const yielded: Array<RunEvent | { type: 'response'; response: unknown }> = [];
    await expect(async () => {
      for await (const event of adapter.execute(request('claude-stream-oversized'), new AbortController().signal)) yielded.push(event);
    }).rejects.toMatchObject({ code: 'agent.output_too_large' });
    expect(yielded.some(event => event.type === 'response')).toBe(false);
  });
});
