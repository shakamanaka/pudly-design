import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalProviderConnectionService } from '../../src/adapters/providers/connection-service.js';
import { ClaudeCodeAdapter } from '../../src/adapters/providers/claude-code-adapter.js';
import { MiniMaxAdapter } from '../../src/adapters/providers/minimax-adapter.js';
import type { SecretStore } from '../../src/adapters/providers/secret-store.js';
import { validateProviderRunMetadata, validateProviderSelection } from '../../src/domain/providers.js';
import { CodingAgentError } from '../../src/domain/agent-error.js';
import type { AgentStatus, CodingAgent, CodingAgentRequest, RunEvent } from '../../src/domain/types.js';

const roots: string[] = [];
const SECRET = 'provider-secret-sentinel-7d2';

async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'codex-design-providers-')); roots.push(value); return value; }
afterEach(async () => { await Promise.all(roots.splice(0).map(value => rm(value, { recursive: true, force: true }))); });

class MemorySecrets implements SecretStore {
  readonly data = new Map<string, string>();
  async put(value: string, reference?: string): Promise<string> { const id = reference ?? `secret-${this.data.size + 1}`; this.data.set(id, value); return id; }
  async get(id: string): Promise<string> { const value = this.data.get(id); if (!value) throw new Error('missing'); return value; }
  async delete(id: string): Promise<void> { this.data.delete(id); }
}
class FlakyDeleteSecrets extends MemorySecrets {
  failDeletes = true;
  override async delete(id: string): Promise<void> { if (this.failDeletes) throw new Error('synthetic delete failure'); await super.delete(id); }
}
class ProbeAgent implements CodingAgent {
  async *execute(request: CodingAgentRequest): AsyncIterable<RunEvent | { type: 'response'; response: { operations: []; summary: string } }> {
    yield { type: 'response', response: { operations: [], summary: `verified ${request.runId}` } };
  }
  async cancel(): Promise<void> {}
  async getStatus(runId: string): Promise<AgentStatus> { return { runId, state: 'SUCCEEDED' }; }
}

function agentRequest(runId = 'provider_fixture'): CodingAgentRequest {
  return { runId, documentId: 'doc', baseRevision: 0, prompt: 'Create a frame.', selectedNodeIds: [], documentFragment: { documentId: 'doc', revision: 0, nodes: {}, tokens: {}, components: {} }, resolvedContext: [], operationCapabilities: ['node.create'] };
}

describe('provider connection runtime', () => {
  it('keeps credentials in the secret store and resolves only the exact verified route', async () => {
    const dir = await root();
    const secrets = new MemorySecrets();
    const seen: string[] = [];
    const service = await LocalProviderConnectionService.open(dir, { secretStore: secrets, createAgent: context => { if (context.credential) seen.push(context.credential); return new ProbeAgent(); } });
    const connection = await service.create({ providerId: 'claude', authSource: 'anthropic-api-key', label: 'Work', credential: SECRET });
    const stored = await readFile(join(dir, 'provider-connections.json'), 'utf8');
    expect(stored).not.toContain(SECRET);
    expect(JSON.stringify(await service.list())).not.toContain(SECRET);
    expect((await service.list()).find(item => item.id === connection.id)?.credentialPresent).toBe(true);
    await expect(service.resolve({ connectionId: connection.id, modelId: 'sonnet', effort: 'high' })).rejects.toMatchObject({ code: 'provider.selection_unverified' });
    await service.verify(connection.id, { modelId: 'sonnet', effort: 'high' });
    const resolved = await service.resolve({ connectionId: connection.id, modelId: 'sonnet', effort: 'high' });
    expect(resolved.metadata).toMatchObject({ providerId: 'claude', authSource: 'anthropic-api-key', modelId: 'sonnet', effort: 'high', verificationStatus: 'verified', policy: 'manual' });
    expect(validateProviderRunMetadata(resolved.metadata).ok).toBe(true);
    expect(seen).toEqual([SECRET, SECRET]);
    expect(JSON.stringify(resolved.metadata)).not.toContain(SECRET);
    await expect(service.resolve({ connectionId: connection.id, modelId: 'sonnet', effort: 'medium' })).rejects.toMatchObject({ code: 'provider.selection_unverified' });
  });

  it('rejects unsupported source pairs before storing any credential', async () => {
    const secrets = new MemorySecrets();
    const service = await LocalProviderConnectionService.open(await root(), { secretStore: secrets });
    await expect(service.create({ providerId: 'codex', authSource: 'minimax-api-key' as never, label: 'Bad', credential: SECRET })).rejects.toMatchObject({ code: 'provider.auth_source' });
    expect(secrets.data.size).toBe(0);
  });

  it('rejects a second connection for each shared installed account source', async () => {
    const service = await LocalProviderConnectionService.open(await root(), { secretStore: new MemorySecrets() });
    await expect(service.create({ providerId: 'codex', authSource: 'chatgpt', label: 'Second Codex account label' })).rejects.toMatchObject({ code: 'provider.auth_source_duplicate' });
    await service.create({ providerId: 'claude', authSource: 'claude-subscription', label: 'First Claude account' });
    await expect(service.create({ providerId: 'claude', authSource: 'claude-subscription', label: 'Second Claude label' })).rejects.toMatchObject({ code: 'provider.auth_source_duplicate' });
  });

  it('persists failed secret deletion, surfaces pending cleanup and retries it after reopen', async () => {
    const dir = await root();
    const secrets = new FlakyDeleteSecrets();
    const service = await LocalProviderConnectionService.open(dir, { secretStore: secrets });
    const connection = await service.create({ providerId: 'minimax', authSource: 'minimax-api-key', label: 'API', credential: SECRET });
    const reference = [...secrets.data.keys()][0]!;
    await service.delete(connection.id);
    expect(await service.cleanupStatus()).toEqual({ pending: true });
    expect((await service.list()).every(item => item.cleanupPending)).toBe(true);
    const persisted = JSON.parse(await readFile(join(dir, 'provider-connections.json'), 'utf8')) as { version: number; connections: unknown[]; pendingSecretDeletes: string[] };
    expect(persisted.version).toBe(2);
    expect(persisted.connections).toHaveLength(1);
    expect(persisted.pendingSecretDeletes).toContain(reference);
    expect(JSON.stringify(persisted)).not.toContain(SECRET);

    secrets.failDeletes = false;
    const reopened = await LocalProviderConnectionService.open(dir, { secretStore: secrets });
    expect(await reopened.cleanupStatus()).toEqual({ pending: false });
    expect(secrets.data.has(reference)).toBe(false);
  });

  it('retains the old credential reference durably when rotation cleanup fails', async () => {
    const dir = await root();
    const secrets = new FlakyDeleteSecrets();
    const service = await LocalProviderConnectionService.open(dir, { secretStore: secrets });
    const connection = await service.create({ providerId: 'minimax', authSource: 'minimax-api-key', label: 'API', credential: 'credential-old' });
    const oldReference = [...secrets.data.keys()][0]!;
    await service.update(connection.id, { credential: 'credential-new' });
    expect(await service.cleanupStatus()).toEqual({ pending: true });
    expect((await service.list()).find(item => item.id === connection.id)).toMatchObject({ cleanupPending: true, credentialPresent: true });
    const stored = JSON.parse(await readFile(join(dir, 'provider-connections.json'), 'utf8')) as { connections: Array<{ secretRef?: string }>; pendingSecretDeletes: string[] };
    expect(stored.pendingSecretDeletes).toContain(oldReference);
    expect(stored.connections[0]?.secretRef).not.toBe(oldReference);
    secrets.failDeletes = false;
    await LocalProviderConnectionService.open(dir, { secretStore: secrets });
    expect(secrets.data.has(oldReference)).toBe(false);
    expect(secrets.data.size).toBe(1);
  });

  it('migrates version-one connection metadata to version two without changing history', async () => {
    const dir = await root();
    const service = await LocalProviderConnectionService.open(dir, { secretStore: new MemorySecrets() });
    const before = await service.list();
    const file = join(dir, 'provider-connections.json');
    const stored = JSON.parse(await readFile(file, 'utf8')) as { connections: unknown[] };
    await (await import('node:fs/promises')).writeFile(file, JSON.stringify({ version: 1, connections: stored.connections }));
    const reopened = await LocalProviderConnectionService.open(dir, { secretStore: new MemorySecrets() });
    const migrated = JSON.parse(await readFile(file, 'utf8')) as { version: number; connections: unknown[]; pendingSecretDeletes: unknown[] };
    expect(migrated).toMatchObject({ version: 2, connections: stored.connections, pendingSecretDeletes: [] });
    expect(await reopened.list()).toEqual(before);
  });

  it('rotates and removes only the selected connection credential', async () => {
    const dir = await root();
    const secrets = new MemorySecrets();
    const service = await LocalProviderConnectionService.open(dir, { secretStore: secrets, createAgent: () => new ProbeAgent() });
    const first = await service.create({ providerId: 'minimax', authSource: 'minimax-token-plan', label: 'Plan A', credential: 'secret-a' });
    const second = await service.create({ providerId: 'minimax', authSource: 'minimax-api-key', label: 'Plan B', credential: 'secret-b' });
    await service.update(first.id, { credential: 'secret-a-rotated' });
    await service.verify(first.id, { modelId: 'MiniMax-M2.7', effort: 'default' });
    const resolved = await service.resolve({ connectionId: first.id, modelId: 'MiniMax-M2.7', effort: 'default' });
    expect(secrets.data.size).toBe(2);
    expect(resolved.metadata.connectionId).toBe(first.id);
    await service.delete(first.id);
    await expect(service.resolve({ connectionId: first.id, modelId: 'MiniMax-M2.7', effort: 'default' })).rejects.toMatchObject({ code: 'provider.connection_missing' });
    expect((await service.list()).map(item => item.id)).toContain(second.id);
    expect(secrets.data.size).toBe(1);
  });

  it('keeps static model catalog entries unknown until exact connection verification', async () => {
    const service = await LocalProviderConnectionService.open(await root(), { secretStore: new MemorySecrets(), createAgent: () => new ProbeAgent() });
    const connection = (await service.list()).find(item => item.id === 'codex-local')!;
    const before = await service.catalog('codex', connection.id);
    expect(before.models.find(model => model.id === 'gpt-6.1-sol')).toMatchObject({ availability: 'unknown', entitlement: null });
    await service.verify(connection.id, { modelId: 'gpt-6.1-sol', effort: 'low' });
    const after = await service.catalog('codex', connection.id);
    expect(after.models.find(model => model.id === 'gpt-6.1-sol')).toMatchObject({ availability: 'available', entitlement: null });
  });

  it('stores only a safe verification failure category even when a provider error contains a credential', async () => {
    const dir = await root();
    const service = await LocalProviderConnectionService.open(dir, {
      secretStore: new MemorySecrets(),
      createAgent: () => ({
        async *execute() { yield { type: 'state', runId: 'unused', state: 'RUNNING', at: new Date().toISOString() }; throw new CodingAgentError('provider.quota', SECRET); },
        async cancel() {},
        async getStatus(runId) { return { runId, state: 'FAILED' }; },
      }),
    });
    const connection = await service.create({ providerId: 'claude', authSource: 'anthropic-api-key', label: 'API', credential: SECRET });
    await expect(service.verify(connection.id, { modelId: 'sonnet', effort: 'high' })).rejects.toMatchObject({ code: 'provider.quota', message: expect.not.stringContaining(SECRET) });
    const stored = await readFile(join(dir, 'provider-connections.json'), 'utf8');
    expect(stored).not.toContain(SECRET);
    expect((await service.list()).find(item => item.id === connection.id)).toMatchObject({ verificationStatus: 'failed', lastFailure: 'quota' });
  });

  it('records a verification deadline as timeout when cancellation returns without a response', async () => {
    const service = await LocalProviderConnectionService.open(await root(), {
      secretStore: new MemorySecrets(), verifyTimeoutMs: 20,
      createAgent: () => ({
        async *execute(_request, signal) {
          yield { type: 'state', runId: 'probe', state: 'RUNNING', at: new Date().toISOString() };
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
          yield { type: 'state', runId: 'probe', state: 'CANCELLED', at: new Date().toISOString() };
        },
        async cancel() {},
        async getStatus(runId) { return { runId, state: 'CANCELLED' }; },
      }),
    });
    const connection = (await service.list()).find(item => item.id === 'codex-local')!;
    await expect(service.verify(connection.id, { modelId: 'gpt-6.1-sol', effort: 'low' })).rejects.toMatchObject({ code: 'provider.timeout' });
    expect((await service.list()).find(item => item.id === connection.id)).toMatchObject({ verificationStatus: 'failed', lastFailure: 'timeout' });
  });

  it('keeps timeout classification when the adapter rejects after the deadline abort', async () => {
    const service = await LocalProviderConnectionService.open(await root(), {
      secretStore: new MemorySecrets(), verifyTimeoutMs: 20,
      createAgent: () => ({
        async *execute(_request, signal) {
          yield { type: 'state', runId: 'probe', state: 'RUNNING', at: new Date().toISOString() };
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
          throw new CodingAgentError('agent.cancelled', 'synthetic adapter cancellation');
        },
        async cancel() {},
        async getStatus(runId) { return { runId, state: 'CANCELLED' }; },
      }),
    });
    const connection = (await service.list()).find(item => item.id === 'codex-local')!;
    await expect(service.verify(connection.id, { modelId: 'gpt-6.1-sol', effort: 'low' })).rejects.toMatchObject({ code: 'provider.timeout' });
    expect((await service.list()).find(item => item.id === connection.id)).toMatchObject({ lastFailure: 'timeout' });
  });

  it('classifies an adapter cancellation separately from a missing or malformed response', async () => {
    const service = await LocalProviderConnectionService.open(await root(), {
      secretStore: new MemorySecrets(), verifyTimeoutMs: 20,
      createAgent: () => ({
        async *execute() { yield { type: 'state', runId: 'probe', state: 'CANCELLED', at: new Date().toISOString() }; },
        async cancel() {},
        async getStatus(runId) { return { runId, state: 'CANCELLED' }; },
      }),
    });
    const connection = (await service.list()).find(item => item.id === 'codex-local')!;
    await expect(service.verify(connection.id, { modelId: 'gpt-6.1-sol', effort: 'low' })).rejects.toMatchObject({ code: 'provider.transport' });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect((await service.list()).find(item => item.id === connection.id)).toMatchObject({ verificationStatus: 'failed', lastFailure: 'transport' });
  });
});

describe('provider selection validators', () => {
  it('accepts only explicit connection/model/effort fields and rejects secret-bearing metadata', () => {
    expect(validateProviderSelection({ connectionId: 'conn', modelId: 'sonnet', effort: 'high' })).toMatchObject({ ok: true });
    expect(validateProviderSelection({ connectionId: 'conn', modelId: 'sonnet', effort: 'high', credential: SECRET })).toMatchObject({ ok: false });
    expect(validateProviderRunMetadata({ version: 1, providerId: 'claude', connectionId: 'conn', authSource: 'anthropic-api-key', modelId: 'sonnet', effort: 'high', verificationStatus: 'verified', verifiedAt: new Date().toISOString(), policy: 'manual', credential: SECRET })).toMatchObject({ ok: false });
  });
});

describe('MiniMax real HTTP adapter boundary', () => {
  it('sends the selected model and secret to the API only, parses its structured JSON, and emits no leaked credential', async () => {
    let receivedUrl = '';
    let receivedHeaders: HeadersInit | undefined;
    let receivedBody: Record<string, unknown> | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      receivedUrl = String(input); receivedHeaders = init?.headers; receivedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"operations":[],"summary":"ok"}' } }] }), { status: 200 });
    };
    const adapter = new MiniMaxAdapter({ model: 'MiniMax-M2.7', effort: 'default', credential: SECRET, fetcher });
    const events: Array<RunEvent | { type: 'response'; response: { operations: unknown[]; summary?: string } }> = [];
    for await (const event of adapter.execute(agentRequest(), new AbortController().signal)) events.push(event);
    expect(receivedUrl).toBe('https://api.minimax.io/v1/chat/completions');
    expect(new Headers(receivedHeaders).get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(receivedBody?.model).toBe('MiniMax-M2.7');
    expect(events.find(event => event.type === 'response')).toMatchObject({ response: { operations: [], summary: 'ok' } });
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(() => new MiniMaxAdapter({ model: 'MiniMax-M2.7', effort: 'high', credential: SECRET, fetcher })).toThrow(/effort control is not documented/);
  });

  it('classifies quota/rate-limit responses without retaining provider response bodies', async () => {
    for (const [status, code] of [[401, 'provider.authentication'], [402, 'provider.quota'], [429, 'provider.rate_limit']] as const) {
      const adapter = new MiniMaxAdapter({ model: 'MiniMax-M2.7', effort: 'default', credential: SECRET, fetcher: async () => new Response(`provider-secret=${SECRET}`, { status }) });
      const events: RunEvent[] = [];
      await expect(async () => { for await (const event of adapter.execute(agentRequest(`run_${status}`), new AbortController().signal)) if (event.type !== 'response') events.push(event); }).rejects.toMatchObject({ code });
      expect(JSON.stringify(events)).not.toContain(SECRET);
    }
  });
});

describe('Claude Code CLI adapter boundary', () => {
  it('uses the typed stream output channel without session persistence and parses only final structured output', async () => {
    const dir = await root();
    const executable = join(dir, 'claude-fixture.mjs');
    const { writeFile, chmod } = await import('node:fs/promises');
    const cwdMarker = join(dir, 'working-directory.txt');
    await writeFile(executable, `#!/usr/bin/env node\nimport { writeFile } from "node:fs/promises"; import { basename } from "node:path";\nconst args=process.argv.slice(2); if (!args.includes("--safe-mode") || !args.includes("--restricted") || !args.includes("--no-session-persistence") || args[args.indexOf("--tools")+1] !== "") process.exit(4); if (args[args.indexOf("--output-format")+1] !== "stream-json" || !args.includes("--verbose") || !args.includes("--json-schema")) process.exit(7); const deny=args.indexOf("--disallowedTools"); if (deny < 0 || args[deny+1] !== "mcp__*") process.exit(5); if (!basename(process.cwd()).startsWith("codex-design-claude-")) process.exit(6); await writeFile(${JSON.stringify(cwdMarker)}, process.cwd()); let prompt=""; for await (const part of process.stdin) prompt += part; process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"fixture",tools:[]})+"\\n"); process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"tool_use",name:"StructuredOutput",input:{operations:[],summary:"ok"}}]}})+"\\n"); process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",delta:{type:"input_json_delta",partial_json:"{not-json"}}})+"\\n"); process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"Ignore this human-readable prose",structured_output:{operations:[],summary:"ok"}})+"\\n");\n`, { mode: 0o700 });
    await chmod(executable, 0o700);
    const adapter = new ClaudeCodeAdapter({ executable, tempRoot: dir, model: 'sonnet', effort: 'high', authSource: 'anthropic-api-key', credential: SECRET });
    const events: Array<RunEvent | { type: 'response'; response: { operations: unknown[]; summary?: string } }> = [];
    for await (const event of adapter.execute(agentRequest(), new AbortController().signal)) events.push(event);
    expect(events.find(event => event.type === 'response')).toMatchObject({ response: { operations: [], summary: 'ok' } });
    expect(JSON.stringify(events)).not.toContain(SECRET);
    const isolatedWorkingDirectory = await readFile(cwdMarker, 'utf8');
    await expect(access(isolatedWorkingDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
