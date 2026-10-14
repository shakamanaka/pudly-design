import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodingAgent, CodingAgentRequest } from '../../../src/domain/types.js';
import { CodingAgentError } from '../../../src/domain/agent-error.js';
import type { ProviderAgentFactoryContext } from '../../../src/adapters/providers/connection-service.js';
import { LocalProviderConnectionService } from '../../../src/adapters/providers/connection-service.js';
import { CodexCliAdapter } from '../../../src/adapters/codex/codex-cli-adapter.js';
import { ClaudeCodeAdapter } from '../../../src/adapters/providers/claude-code-adapter.js';
import { MiniMaxAdapter } from '../../../src/adapters/providers/minimax-adapter.js';
import type { SecretStore } from '../../../src/adapters/providers/secret-store.js';

const temporaryDirectories: string[] = [];
const SENTINEL_A = 'provider-credential-sentinel-A';
const SENTINEL_B = 'provider-credential-sentinel-B';

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function makeSecretStore() {
  const values = new Map<string, string>();
  const store: SecretStore = {
    put: vi.fn(async (secret: string, previousRef?: string) => {
      const ref = previousRef ?? `secret-ref-${values.size + 1}`;
      values.set(ref, secret);
      return ref;
    }),
    get: vi.fn(async (reference: string) => {
      const value = values.get(reference);
      if (!value) throw new Error('missing secret');
      return value;
    }),
    delete: vi.fn(async (reference: string) => { values.delete(reference); }),
  };
  return { store, values };
}

function successfulAgent(): CodingAgent {
  return {
    async *execute() { yield { type: 'response', response: { operations: [], summary: 'verified' } }; },
    async cancel() {},
    async getStatus(runId) { return { runId, state: 'SUCCEEDED' }; },
  };
}

async function setup(options: {
  secretStore?: SecretStore;
  createAgent?: (context: ProviderAgentFactoryContext) => CodingAgent;
  idFactory?: () => string;
  verifyTimeoutMs?: number;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'provider-qa-'));
  temporaryDirectories.push(directory);
  let nextId = 0;
  const service = await LocalProviderConnectionService.open(directory, {
    idFactory: options.idFactory ?? (() => `connection-${++nextId}`),
    ...(options.secretStore ? { secretStore: options.secretStore } : {}),
    createAgent: options.createAgent ?? (() => successfulAgent()),
    ...(options.verifyTimeoutMs ? { verifyTimeoutMs: options.verifyTimeoutMs } : {}),
    clock: () => new Date('2026-10-08T12:00:00.000Z'),
  });
  return { directory, service };
}

describe('provider connection service integration', () => {
  it('keeps newly created connection capabilities unknown until provider verification succeeds', async () => {
    const { service } = await setup();
    const initial = await service.list();
    expect(initial[0]).toMatchObject({
      id: 'codex-local',
      providerId: 'codex',
      verificationStatus: 'unverified',
      capabilities: { catalogStatus: 'partial' },
    });
    expect(initial[0]?.capabilities.models.find(model => model.id === 'gpt-6.1-sol')).toMatchObject({ availability: 'unknown' });
  });

  it('rejects unsupported source combinations before putting credentials', async () => {
    const { store } = makeSecretStore();
    const { service } = await setup({ secretStore: store });

    await expect(service.create({ providerId: 'codex', authSource: 'anthropic-api-key', label: 'bad', credential: SENTINEL_A }))
      .rejects.toMatchObject({ code: 'provider.auth_source' });
    expect(store.put).not.toHaveBeenCalled();
    expect((await service.list()).map(connection => connection.id)).toEqual(['codex-local']);
  });

  it('allows only one connection for each installed local-account source', async () => {
    const { service } = await setup();
    const duplicateCodex = await service.create({ providerId: 'codex', authSource: 'chatgpt', label: 'Second Codex account' }).then(() => null, error => error);
    expect(duplicateCodex, 'duplicate local-account identities must be rejected').toMatchObject({ code: 'provider.auth_source_duplicate' });
    const claude = await service.create({ providerId: 'claude', authSource: 'claude-subscription', label: 'Claude subscription' });
    expect(claude.providerId).toBe('claude');
    const duplicateClaude = await service.create({ providerId: 'claude', authSource: 'claude-subscription', label: 'Second Claude account' }).then(() => null, error => error);
    expect(duplicateClaude, 'duplicate local-account identities must be rejected').toMatchObject({ code: 'provider.auth_source_duplicate' });
  });

  it('continues loading legacy metadata that already contains duplicate local-account records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'provider-legacy-duplicates-'));
    temporaryDirectories.push(directory);
    const timestamp = '2026-10-08T12:00:00.000Z';
    await writeFile(join(directory, 'provider-connections.json'), JSON.stringify({ version: 1, connections: [
      { id: 'codex-local', providerId: 'codex', authSource: 'chatgpt', label: 'Existing primary', verificationStatus: 'unverified', createdAt: timestamp, updatedAt: timestamp, verifiedSelections: [] },
      { id: 'legacy-codex-account', providerId: 'codex', authSource: 'chatgpt', label: 'Existing secondary', verificationStatus: 'unverified', createdAt: timestamp, updatedAt: timestamp, verifiedSelections: [] },
    ] }));

    const service = await LocalProviderConnectionService.open(directory, { secretStore: makeSecretStore().store });
    expect((await service.list()).map(item => item.id)).toEqual(['codex-local', 'legacy-codex-account']);
    const migrated = JSON.parse(await readFile(join(directory, 'provider-connections.json'), 'utf8')) as { version: number };
    expect(migrated.version, 'legacy metadata must migrate to the durable cleanup schema').toBe(2);
  });

  it('stores credentials separately and excludes credential values and internal references from public metadata and views', async () => {
    const { store, values } = makeSecretStore();
    const { directory, service } = await setup({ secretStore: store });

    const created = await service.create({ providerId: 'codex', authSource: 'openai-api-key', label: 'Work API', credential: SENTINEL_A });
    const listed = (await service.list()).find(connection => connection.id === created.id)!;
    const serialized = await readFile(join(directory, 'provider-connections.json'), 'utf8');
    expect(created).not.toHaveProperty('credential');
    expect(created).not.toHaveProperty('secretRef');
    expect(listed).not.toHaveProperty('credential');
    expect(listed).not.toHaveProperty('secretRef');
    expect(listed.credentialPresent).toBe(true);
    expect(serialized).not.toContain(SENTINEL_A);
    expect(serialized).toContain([...values.keys()][0]!);
    expect(values.size).toBe(1);
  });

  it('routes only the selected same-provider connection secret after exact model and effort verification', async () => {
    const { store } = makeSecretStore();
    const contexts: ProviderAgentFactoryContext[] = [];
    const { service } = await setup({
      secretStore: store,
      createAgent: context => { contexts.push(context); return successfulAgent(); },
    });
    const connectionA = await service.create({ providerId: 'codex', authSource: 'openai-api-key', label: 'A', credential: SENTINEL_A });
    const connectionB = await service.create({ providerId: 'codex', authSource: 'openai-api-key', label: 'B', credential: SENTINEL_B });
    await service.verify(connectionA.id, { modelId: 'gpt-6.1-sol', effort: 'low' });
    await service.verify(connectionB.id, { modelId: 'gpt-6.1-sol', effort: 'low' });
    contexts.length = 0;

    const resolved = await service.resolve({ connectionId: connectionA.id, modelId: 'gpt-6.1-sol', effort: 'low' });
    expect(contexts).toHaveLength(1);
    expect(contexts[0], 'resolution must use the selected connection only').toMatchObject({ providerId: 'codex', authSource: 'openai-api-key', credential: SENTINEL_A });
    expect(resolved.metadata).toMatchObject({ connectionId: connectionA.id, providerId: 'codex', modelId: 'gpt-6.1-sol', effort: 'low', policy: 'manual' });
    expect(JSON.stringify(resolved.metadata)).not.toContain(SENTINEL_A);
    expect(JSON.stringify(resolved.metadata)).not.toContain(SENTINEL_B);
  });

  it('requires the exact verified effort for the selected model', async () => {
    const createAgent = vi.fn(() => successfulAgent());
    const { service } = await setup({ createAgent });
    const connection = (await service.list()).find(item => item.id === 'codex-local')!;
    await service.verify(connection.id, { modelId: 'gpt-6.1-sol', effort: 'low' });
    createAgent.mockClear();

    await expect(service.resolve({ connectionId: connection.id, modelId: 'gpt-6.1-sol', effort: 'high' }), 'a different effort must not reuse verification for the same model').rejects.toMatchObject({
      code: 'provider.selection_unverified',
    });
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('constructs the selected provider transport without crossing adapter families', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'provider-registry-qa-'));
    temporaryDirectories.push(directory);
    const secretRef = '00000000-0000-4000-8000-000000000001';
    const { store } = makeSecretStore();
    await store.put(SENTINEL_A, secretRef);
    const verifiedAt = '2026-10-08T12:00:00.000Z';
    const records = [
      { id: 'codex-account', providerId: 'codex', authSource: 'chatgpt', label: 'Codex', verificationStatus: 'verified', verifiedAt, createdAt: verifiedAt, updatedAt: verifiedAt, verifiedSelections: [{ modelId: 'gpt-6.1-sol', effort: 'low' }] },
      { id: 'claude-subscription', providerId: 'claude', authSource: 'claude-subscription', label: 'Claude', verificationStatus: 'verified', verifiedAt, createdAt: verifiedAt, updatedAt: verifiedAt, verifiedSelections: [{ modelId: 'sonnet', effort: 'low' }] },
      { id: 'minimax-token-plan', providerId: 'minimax', authSource: 'minimax-token-plan', label: 'MiniMax', verificationStatus: 'verified', verifiedAt, createdAt: verifiedAt, updatedAt: verifiedAt, secretRef, verifiedSelections: [{ modelId: 'MiniMax-M2.7', effort: 'default' }] },
    ];
    await writeFile(join(directory, 'provider-connections.json'), JSON.stringify({ version: 1, connections: records }));
    const service = await LocalProviderConnectionService.open(directory, { secretStore: store });

    const codex = await service.resolve({ connectionId: 'codex-account', modelId: 'gpt-6.1-sol', effort: 'low' });
    const claude = await service.resolve({ connectionId: 'claude-subscription', modelId: 'sonnet', effort: 'low' });
    const minimax = await service.resolve({ connectionId: 'minimax-token-plan', modelId: 'MiniMax-M2.7', effort: 'default' });
    expect(codex.agent).toBeInstanceOf(CodexCliAdapter);
    expect(claude.agent).toBeInstanceOf(ClaudeCodeAdapter);
    expect(minimax.agent).toBeInstanceOf(MiniMaxAdapter);
  });

  it('does not create an agent for an unsupported effort or an unverified model selection', async () => {
    const createAgent = vi.fn(() => successfulAgent());
    const { service } = await setup({ createAgent });
    const connection = await service.create({ providerId: 'minimax', authSource: 'minimax-api-key', label: 'MiniMax', credential: SENTINEL_A });

    await expect(service.verify(connection.id, { modelId: 'MiniMax-M2.7', effort: 'high' })).rejects.toMatchObject({ code: 'provider.effort_unsupported' });
    await expect(service.resolve({ connectionId: connection.id, modelId: 'stale-model', effort: 'default' })).rejects.toMatchObject({ code: 'provider.selection_unverified' });
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('invalidates prior verification on credential rotation and deletes the superseded secret', async () => {
    const { store, values } = makeSecretStore();
    const contexts: ProviderAgentFactoryContext[] = [];
    const { service } = await setup({ secretStore: store, createAgent: context => { contexts.push(context); return successfulAgent(); } });
    const connection = await service.create({ providerId: 'codex', authSource: 'openai-api-key', label: 'Rotating', credential: SENTINEL_A });
    const oldRef = [...values.keys()][0]!;
    await service.verify(connection.id, { modelId: 'gpt-6.1-sol', effort: 'low' });

    await service.update(connection.id, { credential: SENTINEL_B });
    await expect(service.resolve({ connectionId: connection.id, modelId: 'gpt-6.1-sol', effort: 'low' }), 'credential rotation must require a new provider verification').rejects.toMatchObject({ code: 'provider.selection_unverified' });
    expect(values.has(oldRef)).toBe(false);
    await service.verify(connection.id, { modelId: 'gpt-6.1-sol', effort: 'low' });
    expect(contexts.at(-1)?.credential).toBe(SENTINEL_B);
  });

  it('fails credential-store writes without creating a usable connection', async () => {
    const { store } = makeSecretStore();
    vi.mocked(store.put).mockRejectedValue(new Error('raw sentinel failure detail'));
    const { service } = await setup({ secretStore: store });

    await expect(service.create({ providerId: 'claude', authSource: 'anthropic-api-key', label: 'Claude', credential: SENTINEL_A }))
      .rejects.toMatchObject({ code: 'provider.secret_store' });
    expect((await service.list()).map(connection => connection.id)).toEqual(['codex-local']);
  });

  it('removes a connection and prevents later resolution through that connection ID', async () => {
    const { store, values } = makeSecretStore();
    const { service } = await setup({ secretStore: store });
    const connection = await service.create({ providerId: 'codex', authSource: 'openai-api-key', label: 'To remove', credential: SENTINEL_A });
    const secretRef = [...values.keys()][0]!;
    await service.verify(connection.id, { modelId: 'gpt-6.1-sol', effort: 'low' });
    await service.delete(connection.id);

    expect(values.has(secretRef)).toBe(false);
    await expect(service.resolve({ connectionId: connection.id, modelId: 'gpt-6.1-sol', effort: 'low' })).rejects.toMatchObject({ code: 'provider.connection_missing' });
  });

  it('records quota as a safe verification failure without selecting a second provider', async () => {
    const contexts: ProviderAgentFactoryContext[] = [];
    const createAgent = (context: ProviderAgentFactoryContext): CodingAgent => {
      contexts.push(context);
      return {
        async *execute(request) {
          yield { type: 'state', runId: request.runId, state: 'RUNNING', at: new Date().toISOString() };
          throw new CodingAgentError('provider.quota', 'safe quota response');
        },
        async cancel() {},
        async getStatus(runId) { return { runId, state: 'FAILED' }; },
      };
    };
    const { service } = await setup({ createAgent });
    const connection = (await service.list()).find(item => item.id === 'codex-local')!;

    await expect(service.verify(connection.id, { modelId: 'gpt-6.1-sol', effort: 'low' })).rejects.toMatchObject({ code: 'provider.quota' });
    const current = (await service.list()).find(item => item.id === connection.id)!;
    expect(current.verificationStatus).toBe('failed');
    expect(current.lastFailure).toBe('quota');
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.providerId).toBe('codex');
  });

  it('records a verification deadline as timeout rather than malformed response', async () => {
    const createAgent = () => ({
      async *execute(request: CodingAgentRequest, signal: AbortSignal) {
        yield { type: 'state' as const, runId: request.runId, state: 'RUNNING' as const, at: new Date().toISOString() };
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        yield { type: 'state' as const, runId: request.runId, state: 'CANCELLED' as const, at: new Date().toISOString() };
      },
      async cancel() {},
      async getStatus(runId: string) { return { runId, state: 'CANCELLED' as const }; },
    });
    const { service } = await setup({ createAgent, verifyTimeoutMs: 10 });
    const connection = await service.create({ providerId: 'claude', authSource: 'claude-subscription', label: 'Timeout probe' });

    await expect(service.verify(connection.id, { modelId: 'sonnet', effort: 'low' })).rejects.toMatchObject({ code: 'provider.timeout' });
    expect((await service.list()).find(item => item.id === connection.id)).toMatchObject({ verificationStatus: 'failed', lastFailure: 'timeout' });
  });

  it('preserves a safe cancellation category when the adapter cancels a probe before its deadline', async () => {
    const createAgent = () => ({
      async *execute(request: CodingAgentRequest) {
        yield { type: 'state' as const, runId: request.runId, state: 'CANCELLED' as const, at: new Date().toISOString() };
      },
      async cancel() {},
      async getStatus(runId: string) { return { runId, state: 'CANCELLED' as const }; },
    });
    const { service } = await setup({ createAgent, verifyTimeoutMs: 1000 });
    const connection = await service.create({ providerId: 'claude', authSource: 'claude-subscription', label: 'Cancelled probe' });

    await expect(service.verify(connection.id, { modelId: 'sonnet', effort: 'low' })).rejects.toMatchObject({ code: 'provider.transport' });
    expect((await service.list()).find(item => item.id === connection.id)).toMatchObject({ verificationStatus: 'failed', lastFailure: 'transport' });
  });

  it('tracks a failed old-secret deletion durably and retries it after reopening the service', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'provider-cleanup-qa-'));
    temporaryDirectories.push(directory);
    const values = new Map<string, string>();
    let failDelete = false;
    let next = 0;
    const store: SecretStore = {
      put: vi.fn(async (secret: string, previousRef?: string) => {
        const reference = previousRef ?? `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
        values.set(reference, secret);
        return reference;
      }),
      get: vi.fn(async (reference: string) => {
        const value = values.get(reference);
        if (!value) throw new Error('missing secret');
        return value;
      }),
      delete: vi.fn(async (reference: string) => {
        if (failDelete) throw new Error('temporary cleanup failure');
        values.delete(reference);
      }),
    };
    const service = await LocalProviderConnectionService.open(directory, { secretStore: store, createAgent: () => successfulAgent() });
    const connection = await service.create({ providerId: 'codex', authSource: 'openai-api-key', label: 'Rotate safely', credential: SENTINEL_A });
    const oldReference = [...values.keys()][0]!;
    failDelete = true;

    await service.update(connection.id, { credential: SENTINEL_B });
    expect((await service.list()).find(item => item.id === connection.id)?.cleanupPending, 'cleanup failure must remain durable and visible').toBe(true);
    expect(await service.cleanupStatus(), 'pending cleanup state must be visible').toEqual({ pending: true });
    expect(values.get(oldReference)).toBe(SENTINEL_A);
    const persisted = JSON.parse(await readFile(join(directory, 'provider-connections.json'), 'utf8')) as { version: number; pendingSecretDeletes: string[] };
    expect(persisted.version).toBe(2);
    expect(persisted.pendingSecretDeletes).toContain(oldReference);

    failDelete = false;
    const reopened = await LocalProviderConnectionService.open(directory, { secretStore: store, createAgent: () => successfulAgent() });
    expect(await reopened.cleanupStatus(), 'pending secret deletes must retry when the service reopens').toEqual({ pending: false });
    expect(values.has(oldReference)).toBe(false);
    expect((await reopened.list()).find(item => item.id === connection.id)?.cleanupPending).toBe(false);
  });

  it('stages a credential reference before secret write and recovers a partial create after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'provider-create-cleanup-qa-'));
    temporaryDirectories.push(directory);
    const values = new Map<string, string>();
    let failDelete = true;
    let next = 0;
    const store: SecretStore = {
      put: vi.fn(async (secret: string, previousRef?: string) => {
        const reference = previousRef ?? `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
        values.set(reference, secret);
        throw new Error('simulated interrupted secret write after bytes persisted');
      }),
      get: vi.fn(async (reference: string) => values.get(reference) ?? ''),
      delete: vi.fn(async (reference: string) => {
        if (failDelete) throw new Error('temporary cleanup failure');
        values.delete(reference);
      }),
    };
    const service = await LocalProviderConnectionService.open(directory, { secretStore: store });

    await expect(service.create({ providerId: 'claude', authSource: 'anthropic-api-key', label: 'Interrupted create', credential: SENTINEL_A }))
      .rejects.toMatchObject({ code: 'provider.secret_store' });
    expect(await service.cleanupStatus(), 'secret reference must be durably staged before the secret write').toEqual({ pending: true });
    expect((await service.list()).map(item => item.label)).not.toContain('Interrupted create');
    const staged = JSON.parse(await readFile(join(directory, 'provider-connections.json'), 'utf8')) as { pendingSecretDeletes: string[] };
    expect(staged.pendingSecretDeletes).toHaveLength(1);
    expect(values.get(staged.pendingSecretDeletes[0]!)).toBe(SENTINEL_A);

    failDelete = false;
    const reopened = await LocalProviderConnectionService.open(directory, { secretStore: store });
    expect(await reopened.cleanupStatus()).toEqual({ pending: false });
    expect(values.size).toBe(0);
  });
});
