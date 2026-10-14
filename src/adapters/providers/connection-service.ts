import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CodingAgentError } from '../../domain/agent-error.js';
import type { CodingAgent, CodingAgentRequest, OperationType } from '../../domain/types.js';
import { credentialRequired, isProviderAuthSource, isProviderEffort, isProviderId, isSupportedProviderSource, PROVIDER_EFFORTS, type ProviderAuthSource, type ProviderCatalog, type ProviderConnectionInput, type ProviderConnectionMetadata, type ProviderConnectionUpdate, type ProviderConnectionView, type ProviderEffort, type ProviderFailureCategory, type ProviderId, type ProviderModelCapability, type ProviderRunSelectionMetadata, type ProviderSelection } from '../../domain/providers.js';
import { CodexCliAdapter } from '../codex/codex-cli-adapter.js';
import { CodexModelCatalog, type CodexModelPageReader, type CodexModelCatalogResult } from './codex-model-catalog.js';
import { ClaudeCodeAdapter } from './claude-code-adapter.js';
import { checkClaudeLocalSession, discoverClaudeModels, type ClaudeLocalSession, type ClaudeModelCatalog } from './claude-runtime.js';
import { MiniMaxAdapter } from './minimax-adapter.js';
import { FileSecretStore, type SecretStore } from './secret-store.js';
import { ProviderAdapterError } from './shared.js';

type StoredConnection = ProviderConnectionMetadata & { secretRef?: string; verifiedSelections: Array<{ modelId: string; effort: ProviderEffort }> };
export type ProviderAgentFactoryContext = { providerId: ProviderId; authSource: ProviderAuthSource; modelId: string; effort: ProviderEffort; credential?: string };
export type ProviderServiceOptions = {
  secretStore?: SecretStore;
  createAgent?: (context: ProviderAgentFactoryContext) => CodingAgent;
  discoverCodexModels?: CodexModelPageReader;
  idFactory?: () => string;
  clock?: () => Date;
  verifyTimeoutMs?: number;
  codexCatalogTimeoutMs?: number;
  claudeExecutable?: string;
  discoverClaudeSession?: () => Promise<ClaudeLocalSession>;
  discoverClaudeModels?: () => Promise<ClaudeModelCatalog>;
};
const VALID_EFFORTS: readonly ProviderEffort[] = PROVIDER_EFFORTS;
const VALID_FAILURES: ReadonlySet<ProviderFailureCategory> = new Set(['authentication', 'quota', 'rate-limit', 'network', 'unsupported', 'timeout', 'transport', 'invalid-response', 'secret-store']);
const KNOWN_MODELS: Readonly<Record<ProviderId, readonly { id: string; label: string; efforts: readonly ProviderEffort[] }[]>> = {
  codex: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'] }],
  claude: [
    { id: 'sonnet', label: 'Claude Sonnet (latest alias)', efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'opus', label: 'Claude Opus (latest alias)', efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'haiku', label: 'Claude Haiku (latest alias)', efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'] },
  ],
  minimax: [{ id: 'MiniMax-M2.7', label: 'MiniMax M2.7', efforts: ['default'] }, { id: 'MiniMax-M3', label: 'MiniMax M3', efforts: ['default'] }],
};

/** Local backend registry. Secrets are stored separately from connection metadata. */
export class LocalProviderConnectionService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly codexCatalogCache = new Map<string, { expiresAt: number; result: CodexModelCatalogResult }>();
  private readonly codexCatalogFlights = new Map<string, Promise<CodexModelCatalogResult>>();
  private readonly claudeCatalogCache = new Map<string, { expiresAt: number; result: ClaudeModelCatalog }>();
  private readonly claudeCatalogFlights = new Map<string, Promise<ClaudeModelCatalog>>();
  private readonly claudeSessionCache = new Map<string, { expiresAt: number; result: ClaudeLocalSession }>();
  private readonly claudeSessionFlights = new Map<string, Promise<ClaudeLocalSession>>();
  private constructor(private readonly metadataPath: string, private readonly secretStore: SecretStore, private readonly options: ProviderServiceOptions, private connections: StoredConnection[], private pendingSecretDeletes: string[]) {}

  static async open(dataDirectory: string, options: ProviderServiceOptions = {}): Promise<LocalProviderConnectionService> {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const metadataPath = join(dataDirectory, 'provider-connections.json');
    let connections: StoredConnection[] = [];
    let pendingSecretDeletes: string[] = [];
    let exists = true;
    let needsMigration = false;
    try {
      const raw: unknown = JSON.parse(await readFile(metadataPath, 'utf8'));
      const parsed = parseProviderFile(raw);
      connections = parsed.connections;
      pendingSecretDeletes = parsed.pendingSecretDeletes;
      needsMigration = isRecord(raw) && raw.version === 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
      else throw new ProviderAdapterError('Provider connection data is invalid or could not be read.', 'provider.store_corrupt');
    }
    const secretStore = options.secretStore ?? new FileSecretStore(join(dataDirectory, 'provider-secrets'));
    const service = new LocalProviderConnectionService(metadataPath, secretStore, options, connections, pendingSecretDeletes);
    if (!exists) {
      const now = service.now();
      service.connections.push({ id: 'codex-local', providerId: 'codex', authSource: 'chatgpt', label: 'Codex CLI account', verificationStatus: 'unverified', createdAt: now, updatedAt: now, verifiedSelections: [] });
      await service.save();
    } else if (needsMigration) await service.save();
    await service.drainCleanupQueue();
    return service;
  }

  async list(): Promise<ProviderConnectionView[]> { return Promise.all(this.connections.map(connection => this.view(structuredClone(connection)))); }
  async cleanupStatus(): Promise<{ pending: boolean }> { return this.exclusive(() => Promise.resolve({ pending: this.pendingSecretDeletes.length > 0 })); }

  async create(input: ProviderConnectionInput): Promise<ProviderConnectionMetadata> { return this.exclusive(() => this.createInner(input)); }
  private async createInner(input: ProviderConnectionInput): Promise<ProviderConnectionMetadata> {
    this.validateCreate(input);
    if (!credentialRequired(input.authSource) && this.connections.some(connection => connection.providerId === input.providerId && connection.authSource === input.authSource)) throw new ProviderAdapterError('A connection for this installed provider account already exists on this device.', 'provider.auth_source_duplicate');
    const now = this.now();
    const id = this.id();
    let secretRef: string | undefined;
    if (input.credential !== undefined) {
      secretRef = randomUUID();
      const priorQueue = this.pendingSecretDeletes;
      this.pendingSecretDeletes = enqueueDelete(priorQueue, secretRef);
      try { await this.save(); }
      catch { this.pendingSecretDeletes = priorQueue; throw new ProviderAdapterError('The credential could not be safely staged. No connection was created.', 'provider.secret_store'); }
      try {
        const storedRef = await this.secretStore.put(input.credential, secretRef);
        if (storedRef !== secretRef) { this.pendingSecretDeletes = enqueueDelete(this.pendingSecretDeletes, storedRef); await this.save(); throw new Error('secret reference mismatch'); }
      } catch {
        await this.drainCleanupQueue();
        throw new ProviderAdapterError('The credential could not be securely stored. No connection was created.', 'provider.secret_store');
      }
    }
    const record: StoredConnection = { id, providerId: input.providerId, authSource: input.authSource, label: input.label.trim(), verificationStatus: 'unverified', createdAt: now, updatedAt: now, verifiedSelections: [], ...(secretRef ? { secretRef } : {}) };
    if (secretRef) this.pendingSecretDeletes = this.pendingSecretDeletes.filter(reference => reference !== secretRef);
    this.connections.push(record);
    try { await this.save(); }
    catch {
      this.connections = this.connections.filter(item => item.id !== id);
      if (secretRef) this.pendingSecretDeletes = enqueueDelete(this.pendingSecretDeletes, secretRef);
      await this.save().catch(() => undefined);
      await this.drainCleanupQueue();
      throw new ProviderAdapterError('Provider connection metadata could not be saved. No usable connection was created.', 'provider.connection_store');
    }
    await this.drainCleanupQueue();
    return publicMetadata(record);
  }

  async update(connectionId: string, input: ProviderConnectionUpdate): Promise<ProviderConnectionMetadata> { return this.exclusive(() => this.updateInner(connectionId, input)); }
  private async updateInner(connectionId: string, input: ProviderConnectionUpdate): Promise<ProviderConnectionMetadata> {
    if (!isRecord(input) || Object.keys(input).some(key => !['label', 'credential'].includes(key)) || (input.label === undefined && input.credential === undefined)) throw new ProviderAdapterError('Connection update fields are invalid.', 'provider.connection_update');
    const index = this.findIndex(connectionId);
    const previous = this.connections[index]!;
    if (input.label !== undefined && (typeof input.label !== 'string' || !input.label.trim() || input.label.trim().length > 120)) throw new ProviderAdapterError('Enter a connection name of 1–120 characters.', 'provider.label');
    if (input.credential !== undefined && (!credentialRequired(previous.authSource) || typeof input.credential !== 'string' || input.credential.length === 0 || Buffer.byteLength(input.credential) > 16_384)) throw new ProviderAdapterError('A valid replacement credential is required for this connection.', 'provider.credential');
    let nextSecretRef = previous.secretRef;
    if (input.credential !== undefined) {
      nextSecretRef = randomUUID();
      const priorQueue = this.pendingSecretDeletes;
      this.pendingSecretDeletes = enqueueDelete(priorQueue, nextSecretRef);
      try { await this.save(); }
      catch { this.pendingSecretDeletes = priorQueue; throw new ProviderAdapterError('The replacement credential could not be safely staged. The existing connection was preserved.', 'provider.secret_store'); }
      try {
        const storedRef = await this.secretStore.put(input.credential, nextSecretRef);
        if (storedRef !== nextSecretRef) { this.pendingSecretDeletes = enqueueDelete(this.pendingSecretDeletes, storedRef); await this.save(); throw new Error('secret reference mismatch'); }
      } catch {
        await this.drainCleanupQueue();
        throw new ProviderAdapterError('The replacement credential could not be securely stored. The existing connection was preserved.', 'provider.secret_store');
      }
    }
    const credentialChanged = input.credential !== undefined;
    if (credentialChanged) { this.invalidateCatalog(connectionId); this.invalidateClaude(connectionId); }
    const next: StoredConnection = {
      ...previous,
      ...(input.label !== undefined ? { label: input.label.trim() } : {}),
      ...(nextSecretRef ? { secretRef: nextSecretRef } : {}),
      updatedAt: this.now(),
      ...(credentialChanged ? { verificationStatus: 'unverified' as const, verifiedSelections: [] } : {}),
    };
    if (credentialChanged) { delete next.verifiedAt; delete next.lastFailure; }
    const stagedQueue = this.pendingSecretDeletes;
    if (input.credential !== undefined && nextSecretRef) this.pendingSecretDeletes = this.pendingSecretDeletes.filter(reference => reference !== nextSecretRef);
    if (previous.secretRef && nextSecretRef !== previous.secretRef) this.pendingSecretDeletes = enqueueDelete(this.pendingSecretDeletes, previous.secretRef);
    this.connections[index] = next;
    try { await this.save(); }
    catch {
      this.connections[index] = previous;
      this.pendingSecretDeletes = stagedQueue;
      await this.drainCleanupQueue();
      throw new ProviderAdapterError('Connection changes could not be saved. The existing connection was preserved.', 'provider.connection_store');
    }
    await this.drainCleanupQueue();
    return publicMetadata(next);
  }

  async delete(connectionId: string): Promise<void> { return this.exclusive(() => this.deleteInner(connectionId)); }
  private async deleteInner(connectionId: string): Promise<void> {
    const index = this.findIndex(connectionId);
    const previous = this.connections[index]!;
    const priorCleanup = this.pendingSecretDeletes;
    if (previous.secretRef) this.pendingSecretDeletes = enqueueDelete(this.pendingSecretDeletes, previous.secretRef);
    this.connections.splice(index, 1);
    this.invalidateCatalog(connectionId);
    this.invalidateClaude(connectionId);
    try { await this.save(); }
    catch { this.connections.splice(index, 0, previous); this.pendingSecretDeletes = priorCleanup; throw new ProviderAdapterError('Connection could not be removed. It remains available unchanged.', 'provider.connection_store'); }
    await this.drainCleanupQueue();
  }

  async verify(connectionId: string, selection: { modelId: string; effort: ProviderEffort }): Promise<ProviderConnectionView> { return this.exclusive(() => this.verifyInner(connectionId, selection)); }
  private async verifyInner(connectionId: string, selection: { modelId: string; effort: ProviderEffort }): Promise<ProviderConnectionView> {
    const index = this.findIndex(connectionId);
    const prior = this.connections[index]!;
    if (typeof selection?.modelId !== 'string' || !selection.modelId.trim() || selection.modelId.length > 200 || !isProviderEffort(selection.effort)) throw new ProviderAdapterError('Choose a valid model and effort to verify.', 'provider.selection');
    if (!modelEffortSupported(prior.providerId, selection.modelId, selection.effort)) throw new ProviderAdapterError('This effort is not supported by the selected provider transport.', 'provider.effort_unsupported');
    if (prior.providerId === 'codex') {
      const discovered = await this.codexModelsFor(prior);
      const model = discovered.models.find(candidate => candidate.id === selection.modelId);
      if (model && !model.supportedEfforts.includes(selection.effort)) throw new ProviderAdapterError('This effort is not supported by the selected model.', 'provider.effort_unsupported');
    }
    if (prior.providerId === 'claude' && prior.authSource === 'claude-subscription') {
      const discovered = await this.claudeModelsFor(prior);
      const model = discovered.models.find(candidate => candidate.id === selection.modelId);
      if (model && selection.effort !== 'default' && !model.supportedEfforts.includes(selection.effort)) throw new ProviderAdapterError('This effort is not supported by the selected Claude model.', 'provider.effort_unsupported');
    }
    const credential = await this.credentialFor(prior);
    let verificationTimedOut = false;
    try {
      const agent = this.createAgent({ providerId: prior.providerId, authSource: prior.authSource, modelId: selection.modelId, effort: selection.effort, ...(credential ? { credential } : {}) });
      const request = verificationRequest(randomUUID());
      const controller = new AbortController();
      const timeoutMs = this.options.verifyTimeoutMs ?? 30_000;
      const timer = setTimeout(() => { verificationTimedOut = true; controller.abort(); }, timeoutMs);
      let count = 0;
      let agentCancelled = false;
      try {
        for await (const event of agent.execute(request, controller.signal)) {
          if (event.type === 'response') {
            if (event.response.operations.length !== 0) throw new ProviderAdapterError('Provider verification returned unexpected design operations.', 'provider.verify_response');
            count++;
          } else if (event.type === 'state' && event.state === 'CANCELLED') agentCancelled = true;
        }
      } finally { clearTimeout(timer); }
      if (verificationTimedOut) throw new ProviderAdapterError('Provider verification exceeded its time limit.', 'provider.verify_timeout');
      if (agentCancelled) throw new ProviderAdapterError('The provider cancelled verification before returning a response.', 'provider.verify_cancelled');
      if (count !== 1) throw new ProviderAdapterError('The provider did not return the expected verification response.', 'provider.verify_response');
      const verifiedAt = this.now();
      const updated: StoredConnection = { ...prior, verificationStatus: 'verified', verifiedAt, updatedAt: verifiedAt, verifiedSelections: [...prior.verifiedSelections.filter(item => item.modelId !== selection.modelId || item.effort !== selection.effort), { modelId: selection.modelId, effort: selection.effort }] };
      delete updated.lastFailure;
      this.connections[index] = updated;
      await this.save();
      return await this.view(updated);
    } catch (error) {
      const category = verificationTimedOut || (error instanceof ProviderAdapterError && error.code === 'provider.verify_timeout') ? 'timeout' : classifyFailure(error);
      const failed: StoredConnection = { ...prior, verificationStatus: 'failed', updatedAt: this.now(), lastFailure: category, verifiedSelections: [] };
      delete failed.verifiedAt;
      this.connections[index] = failed;
      await this.save().catch(() => undefined);
      const safeMessage: Record<ProviderFailureCategory, string> = {
        authentication: 'The provider rejected this connection. Reconnect it and try again.',
        quota: 'The provider reports no available quota for this connection.',
        'rate-limit': 'The provider is rate limiting this connection. Try again later.',
        network: 'The provider could not be reached. Check the connection and try again.',
        unsupported: 'The selected model or effort is unsupported by this provider.',
        timeout: 'Provider verification exceeded its time limit.',
        transport: 'The provider could not complete verification. Check the connection and model selection.',
        'invalid-response': 'The provider returned an invalid verification response.',
        'secret-store': 'The saved connection credential could not be read from secure storage.',
      };
      throw new ProviderAdapterError(safeMessage[category], `provider.${category.replace('-', '_')}`);
    }
  }

  async catalog(providerId: ProviderId, connectionId?: string): Promise<ProviderCatalog> { return this.catalogInner(providerId, connectionId); }
  private async catalogInner(providerId: ProviderId, connectionId?: string): Promise<ProviderCatalog> {
    if (!isProviderId(providerId)) throw new ProviderAdapterError('The provider is unsupported.', 'provider.unsupported');
    if (connectionId) {
      const connection = structuredClone(this.connections[this.findIndex(connectionId)]!);
      if (connection.providerId !== providerId) throw new ProviderAdapterError('The connection does not belong to this provider.', 'provider.connection_mismatch');
      const discovery = providerId === 'codex' ? await this.codexModelsFor(connection) : undefined;
      const claudeDiscovery = providerId === 'claude' && connection.authSource === 'claude-subscription' ? await this.claudeModelsFor(connection) : undefined;
      return catalogFor(providerId, [connection], discovery, claudeDiscovery);
    }
    const connections = this.connections.filter(connection => connection.providerId === providerId);
    if (providerId === 'claude') {
      const subscription = connections.find(connection => connection.authSource === 'claude-subscription');
      if (subscription) return catalogFor(providerId, [subscription], undefined, await this.claudeModelsFor(subscription));
      return catalogFor(providerId, connections);
    }
    if (providerId !== 'codex') return catalogFor(providerId, connections);
    // A provider-level request has no selected API-key identity. Prefer the one
    // honest local-account connection, and never merge catalogs across accounts.
    const local = connections.find(connection => connection.authSource === 'chatgpt');
    if (!local) return catalogFor(providerId, []);
    const snapshot = structuredClone(local);
    return catalogFor(providerId, [snapshot], await this.codexModelsFor(snapshot));
  }

  private async codexModelsFor(connection: StoredConnection): Promise<CodexModelCatalogResult> {
    if (connection.authSource !== 'chatgpt') return { models: [], catalogStatus: 'unknown' };
    const cached = this.codexCatalogCache.get(connection.id);
    if (cached && cached.expiresAt > Date.now()) return structuredClone(cached.result);
    const pending = this.codexCatalogFlights.get(connection.id);
    if (pending) return structuredClone(await pending);
    const flight = (async () => {
      let result: CodexModelCatalogResult;
      try {
        if (this.options.discoverCodexModels) result = await CodexModelCatalog.discover(this.options.discoverCodexModels, { timeoutMs: this.options.codexCatalogTimeoutMs ?? 8_000 });
        else if (this.options.createAgent) result = legacyCatalogFixture();
        else result = await CodexModelCatalog.discover(undefined, { timeoutMs: this.options.codexCatalogTimeoutMs ?? 8_000 });
      } catch { result = { models: [], catalogStatus: 'unknown' }; }
      this.codexCatalogCache.set(connection.id, { expiresAt: Date.now() + 30_000, result: structuredClone(result) });
      return result;
    })();
    this.codexCatalogFlights.set(connection.id, flight);
    try { return structuredClone(await flight); }
    finally { if (this.codexCatalogFlights.get(connection.id) === flight) this.codexCatalogFlights.delete(connection.id); }
  }

  private invalidateCatalog(connectionId: string): void { this.codexCatalogCache.delete(connectionId); }
  private invalidateClaude(connectionId: string): void { this.claudeCatalogCache.delete(connectionId); this.claudeSessionCache.delete(connectionId); }

  async resolve(selection: ProviderSelection): Promise<{ agent: CodingAgent; metadata: ProviderRunSelectionMetadata }> { return this.exclusive(() => this.resolveInner(selection)); }
  private async resolveInner(selection: ProviderSelection): Promise<{ agent: CodingAgent; metadata: ProviderRunSelectionMetadata }> {
    if (!isRecord(selection) || typeof selection.connectionId !== 'string' || typeof selection.modelId !== 'string' || !isProviderEffort(selection.effort)) throw new ProviderAdapterError('Choose a connection, model, and supported effort.', 'provider.selection_invalid');
    const connection = this.connections[this.findIndex(selection.connectionId)]!;
    if (connection.verificationStatus !== 'verified' || !connection.verifiedAt || !connection.verifiedSelections.some(item => item.modelId === selection.modelId && item.effort === selection.effort)) throw new ProviderAdapterError('Verify this exact connection, model, and effort before starting a run.', 'provider.selection_unverified');
    const credential = await this.credentialFor(connection);
    const agent = this.createAgent({ providerId: connection.providerId, authSource: connection.authSource, modelId: selection.modelId, effort: selection.effort, ...(credential ? { credential } : {}) });
    const metadata: ProviderRunSelectionMetadata = { version: 1, providerId: connection.providerId, connectionId: connection.id, authSource: connection.authSource, modelId: selection.modelId, effort: selection.effort, verificationStatus: 'verified', verifiedAt: connection.verifiedAt, policy: 'manual' };
    return { agent, metadata };
  }

  private validateCreate(input: ProviderConnectionInput): void {
    if (!isRecord(input) || Object.keys(input).some(key => !['providerId', 'authSource', 'label', 'credential'].includes(key))) throw new ProviderAdapterError('Connection fields are invalid.', 'provider.connection_shape');
    if (!isSupportedProviderSource(input.providerId, input.authSource)) throw new ProviderAdapterError('The selected authentication source is not supported for this provider.', 'provider.auth_source');
    if (typeof input.label !== 'string' || !input.label.trim() || input.label.trim().length > 120) throw new ProviderAdapterError('Enter a connection name of 1–120 characters.', 'provider.label');
    if (credentialRequired(input.authSource) && (typeof input.credential !== 'string' || !input.credential || Buffer.byteLength(input.credential) > 16_384)) throw new ProviderAdapterError('Enter a valid provider credential.', 'provider.credential');
    if (!credentialRequired(input.authSource) && input.credential !== undefined) throw new ProviderAdapterError('This authentication source uses the installed provider CLI account and does not accept a credential.', 'provider.credential_unexpected');
  }
  private async credentialFor(connection: StoredConnection): Promise<string | undefined> {
    if (!credentialRequired(connection.authSource)) return undefined;
    if (!connection.secretRef) throw new ProviderAdapterError('The saved connection credential is missing. Replace it before continuing.', 'provider.credential_missing');
    try { return await this.secretStore.get(connection.secretRef); }
    catch { throw new ProviderAdapterError('The saved connection credential could not be read from secure storage.', 'provider.secret_store'); }
  }
  private createAgent(context: ProviderAgentFactoryContext): CodingAgent {
    if (this.options.createAgent) return this.options.createAgent(context);
    switch (context.providerId) {
      case 'codex': return new CodexCliAdapter({ authSource: context.authSource as 'chatgpt' | 'openai-api-key', ...(context.credential ? { credential: context.credential } : {}), model: context.modelId, effort: context.effort });
      case 'claude': return new ClaudeCodeAdapter({ authSource: context.authSource as 'claude-subscription' | 'anthropic-api-key', ...(context.credential ? { credential: context.credential } : {}), model: context.modelId, effort: context.effort });
      case 'minimax': return new MiniMaxAdapter({ credential: context.credential ?? '', model: context.modelId, effort: context.effort });
    }
  }
  private async view(connection: StoredConnection): Promise<ProviderConnectionView> {
    const discovery = connection.providerId === 'codex' ? await this.codexModelsFor(connection) : undefined;
    const claudeDiscovery = connection.providerId === 'claude' && connection.authSource === 'claude-subscription' ? await this.claudeModelsFor(connection) : undefined;
    const localSession = connection.providerId === 'claude' && connection.authSource === 'claude-subscription' ? await this.claudeSessionFor(connection) : undefined;
    return { ...publicMetadata(connection), credentialPresent: !!connection.secretRef, cleanupPending: this.pendingSecretDeletes.length > 0, ...(connection.verifiedSelections.at(-1) ? { lastVerifiedSelection: { ...connection.verifiedSelections.at(-1)! } } : {}), ...(localSession ? { localSession } : {}), capabilities: catalogFor(connection.providerId, [connection], discovery, claudeDiscovery) };
  }

  private async claudeSessionFor(connection: StoredConnection): Promise<ClaudeLocalSession> {
    const cached = this.claudeSessionCache.get(connection.id);
    if (cached && cached.expiresAt > Date.now()) return structuredClone(cached.result);
    const pending = this.claudeSessionFlights.get(connection.id);
    if (pending) return structuredClone(await pending);
    const discover = this.options.discoverClaudeSession;
    const flight = (discover ? boundedDiscovery(discover(), 5_000, { status: 'unknown' as const })
      : this.options.createAgent ? Promise.resolve({ status: 'unknown' as const })
      : checkClaudeLocalSession(this.options.claudeExecutable ? { executable: this.options.claudeExecutable } : {})).catch(() => ({ status: 'unknown' as const }));
    this.claudeSessionFlights.set(connection.id, flight);
    try {
      const result = await flight;
      this.claudeSessionCache.set(connection.id, { expiresAt: Date.now() + 15_000, result: structuredClone(result) });
      return structuredClone(result);
    } finally { if (this.claudeSessionFlights.get(connection.id) === flight) this.claudeSessionFlights.delete(connection.id); }
  }

  private async claudeModelsFor(connection: StoredConnection): Promise<ClaudeModelCatalog> {
    if (connection.authSource !== 'claude-subscription') return { models: [], catalogStatus: 'unknown' };
    const cached = this.claudeCatalogCache.get(connection.id);
    if (cached && cached.expiresAt > Date.now()) return structuredClone(cached.result);
    const pending = this.claudeCatalogFlights.get(connection.id);
    if (pending) return structuredClone(await pending);
    const discover = this.options.discoverClaudeModels;
    const flight = (discover ? boundedDiscovery(discover(), 8_000, { models: [], catalogStatus: 'unknown' as const })
      : this.options.createAgent ? Promise.resolve({ models: [], catalogStatus: 'unknown' as const })
      : discoverClaudeModels(this.options.claudeExecutable ? { executable: this.options.claudeExecutable } : {})).catch(() => ({ models: [], catalogStatus: 'unknown' as const }));
    this.claudeCatalogFlights.set(connection.id, flight);
    try {
      const result = await flight;
      this.claudeCatalogCache.set(connection.id, { expiresAt: Date.now() + 30_000, result: structuredClone(result) });
      return structuredClone(result);
    } finally { if (this.claudeCatalogFlights.get(connection.id) === flight) this.claudeCatalogFlights.delete(connection.id); }
  }
  private findIndex(id: string): number { const index = this.connections.findIndex(connection => connection.id === id); if (index < 0) throw new ProviderAdapterError('Provider connection was not found.', 'provider.connection_missing'); return index; }
  private id(): string { const id = (this.options.idFactory ?? randomUUID)(); if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || this.connections.some(connection => connection.id === id)) throw new ProviderAdapterError('A unique connection identifier could not be created.', 'provider.id'); return id; }
  private now(): string { return this.options.clock?.().toISOString() ?? new Date().toISOString(); }
  private async save(): Promise<void> {
    await mkdir(dirname(this.metadataPath), { recursive: true, mode: 0o700 });
    const temp = `${this.metadataPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ version: 2, connections: this.connections, pendingSecretDeletes: this.pendingSecretDeletes }, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, this.metadataPath);
    } catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error; }
  }
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async drainCleanupQueue(): Promise<void> {
    for (const reference of [...this.pendingSecretDeletes]) {
      try { await this.secretStore.delete(reference); }
      catch { continue; }
      this.pendingSecretDeletes = this.pendingSecretDeletes.filter(item => item !== reference);
      try { await this.save(); }
      catch {
        this.pendingSecretDeletes = enqueueDelete(this.pendingSecretDeletes, reference);
        return;
      }
    }
  }
}

function publicMetadata(connection: StoredConnection): ProviderConnectionMetadata {
  const { id, providerId, authSource, label, verificationStatus, verifiedAt, lastFailure, createdAt, updatedAt } = connection;
  return { id, providerId, authSource, label, verificationStatus, ...(verifiedAt ? { verifiedAt } : {}), ...(lastFailure ? { lastFailure } : {}), createdAt, updatedAt };
}
function catalogFor(providerId: ProviderId, connections: StoredConnection[], codexDiscovery?: CodexModelCatalogResult, claudeDiscovery?: ClaudeModelCatalog): ProviderCatalog {
  const models = new Map<string, ProviderModelCapability>();
  const subscription = providerId === 'claude' && connections.some(connection => connection.authSource === 'claude-subscription');
  const knownModels: ProviderModelCapability[] = providerId === 'codex'
    ? (codexDiscovery?.models ?? [])
    : providerId === 'claude' && subscription
      ? []
      : KNOWN_MODELS[providerId].map(model => ({ id: model.id, label: model.label, availability: 'unknown', entitlement: null, supportedEfforts: [...model.efforts] }));
  if (providerId === 'claude' && subscription) {
    // Account discovery is model availability metadata only, never inference proof.
    // `default` remains a no-effort selection; advertised effort levels are exact.
    for (const model of claudeDiscovery?.models ?? []) {
      models.set(model.id, { id: model.id, label: model.label, availability: 'unknown', entitlement: null, supportedEfforts: ['default', ...model.supportedEfforts] });
    }
  }
  for (const model of knownModels) models.set(model.id, structuredClone(model));
  for (const connection of connections) for (const selection of connection.verifiedSelections) {
    const known = models.get(selection.modelId);
    models.set(selection.modelId, { ...known, id: selection.modelId, label: known?.label ?? selection.modelId, availability: 'available', entitlement: null, supportedEfforts: [...new Set([...(known?.supportedEfforts ?? []), selection.effort])] });
  }
  const catalogStatus = providerId === 'codex' ? (codexDiscovery?.catalogStatus ?? 'unknown') : providerId === 'claude' && subscription ? (claudeDiscovery?.catalogStatus ?? 'unknown') : (models.size ? 'partial' : 'unknown');
  return { providerId, models: [...models.values()], catalogStatus };
}
function legacyCatalogFixture(): CodexModelCatalogResult {
  return { models: KNOWN_MODELS.codex.map(model => ({ id: model.id, label: model.label, availability: 'unknown', entitlement: null, supportedEfforts: [...model.efforts] })), catalogStatus: 'partial' };
}
function modelEffortSupported(providerId: ProviderId, modelId: string, effort: ProviderEffort): boolean {
  if (!isProviderEffort(effort) || !modelId.trim()) return false;
  if (providerId === 'minimax') return effort === 'default';
  if (providerId === 'claude') return ['default', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort);
  return VALID_EFFORTS.includes(effort);
}
function classifyFailure(error: unknown): ProviderFailureCategory {
  if (error instanceof CodingAgentError) {
    const code = error.code.toLowerCase();
    if (code.includes('authentication') || code.includes('auth')) return 'authentication';
    if (code.includes('quota') || code.includes('billing')) return 'quota';
    if (code.includes('rate')) return 'rate-limit';
    if (code.includes('unsupported') || code.includes('model_not_found')) return 'unsupported';
    if (code.includes('timeout')) return 'timeout';
    if (code.includes('network')) return 'network';
    if (code.includes('protocol') || code.includes('response')) return 'invalid-response';
    if (code.includes('secret')) return 'secret-store';
  }
  return 'transport';
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function parseProviderFile(input: unknown): { connections: StoredConnection[]; pendingSecretDeletes: string[] } {
  if (!isRecord(input) || (input.version !== 1 && input.version !== 2) || !Array.isArray(input.connections) || Object.keys(input).some(key => !['version', 'connections', ...(input.version === 2 ? ['pendingSecretDeletes'] : [])].includes(key))) throw new Error('bad provider store');
  const pendingSecretDeletes = input.version === 1 ? [] : input.pendingSecretDeletes;
  if (!Array.isArray(pendingSecretDeletes) || pendingSecretDeletes.some(ref => typeof ref !== 'string' || !/^[0-9a-f-]{36}$/i.test(ref)) || new Set(pendingSecretDeletes).size !== pendingSecretDeletes.length) throw new Error('bad cleanup queue');
  const ids = new Set<string>();
  const connections = input.connections.map(value => {
    if (!isRecord(value) || Object.keys(value).some(key => !['id', 'providerId', 'authSource', 'label', 'verificationStatus', 'verifiedAt', 'lastFailure', 'createdAt', 'updatedAt', 'secretRef', 'verifiedSelections'].includes(key))) throw new Error('bad provider record');
    if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) || ids.has(value.id) || !isProviderId(value.providerId) || !isSupportedProviderSource(value.providerId, value.authSource) || typeof value.label !== 'string' || !value.label || value.label.length > 120 || !['unverified', 'verified', 'failed'].includes(String(value.verificationStatus)) || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt)) || typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt)) || !Array.isArray(value.verifiedSelections)) throw new Error('bad provider fields');
    if (value.secretRef !== undefined && (typeof value.secretRef !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.secretRef))) throw new Error('bad secret ref');
    if (!isProviderAuthSource(value.authSource) || credentialRequired(value.authSource) !== (typeof value.secretRef === 'string')) throw new Error('missing credential reference');
    if (value.verifiedAt !== undefined && (typeof value.verifiedAt !== 'string' || Number.isNaN(Date.parse(value.verifiedAt)))) throw new Error('bad verification time');
    if (value.lastFailure !== undefined && (typeof value.lastFailure !== 'string' || !VALID_FAILURES.has(value.lastFailure as ProviderFailureCategory))) throw new Error('bad failure category');
    ids.add(value.id);
    const verifiedSelections = value.verifiedSelections.map(selection => {
      if (!isRecord(selection) || Object.keys(selection).some(key => !['modelId', 'effort'].includes(key)) || typeof selection.modelId !== 'string' || !selection.modelId || !isProviderEffort(selection.effort)) throw new Error('bad verified selection');
      return { modelId: selection.modelId, effort: selection.effort };
    });
    if (value.verificationStatus === 'verified' && (!value.verifiedAt || verifiedSelections.length === 0)) throw new Error('verified connection lacks evidence');
    return structuredClone(value) as StoredConnection;
  });
  const connectedReferences = new Set(connections.flatMap(connection => connection.secretRef ? [connection.secretRef] : []));
  if ((pendingSecretDeletes as string[]).some(reference => connectedReferences.has(reference))) throw new Error('cleanup queue references an active credential');
  return { connections, pendingSecretDeletes: [...pendingSecretDeletes] as string[] };
}
function enqueueDelete(queue: string[], reference: string): string[] { return queue.includes(reference) ? queue : [...queue, reference]; }
function boundedDiscovery<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    promise.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}
function verificationRequest(runId: string): CodingAgentRequest {
  return {
    runId, documentId: 'provider-probe', baseRevision: 0, prompt: 'Connection verification only. Return an empty operations array and a short summary. Do not propose any design operations.', selectedNodeIds: [],
    documentFragment: { documentId: 'provider-probe', revision: 0, nodes: {}, tokens: {}, components: {} }, resolvedContext: [], operationCapabilities: ['node.create'] as OperationType[],
  };
}
