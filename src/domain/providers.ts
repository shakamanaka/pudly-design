import type { CodingAgent } from './types.js';

export type ProviderId = 'codex' | 'claude' | 'minimax';
export type ProviderAuthSource = 'chatgpt' | 'openai-api-key' | 'claude-subscription' | 'anthropic-api-key' | 'minimax-api-key' | 'minimax-token-plan';
export type ProviderEffort = 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type ProviderVerificationStatus = 'unverified' | 'verified' | 'failed';
export type ProviderAvailability = 'unknown' | 'available' | 'unavailable';
export type ProviderFailureCategory = 'authentication' | 'quota' | 'rate-limit' | 'network' | 'unsupported' | 'timeout' | 'transport' | 'invalid-response' | 'secret-store';

export type ProviderConnectionInput = {
  providerId: ProviderId;
  authSource: ProviderAuthSource;
  label: string;
  credential?: string;
};
export type ProviderConnectionUpdate = { label?: string; credential?: string };
export type ProviderConnectionMetadata = {
  id: string;
  providerId: ProviderId;
  authSource: ProviderAuthSource;
  label: string;
  verificationStatus: ProviderVerificationStatus;
  verifiedAt?: string;
  lastFailure?: ProviderFailureCategory;
  createdAt: string;
  updatedAt: string;
};
export type ProviderSelection = { connectionId: string; modelId: string; effort: ProviderEffort };
export type ProviderRunSelectionMetadata = {
  version: 1;
  providerId: ProviderId;
  connectionId: string;
  authSource: ProviderAuthSource;
  modelId: string;
  effort: ProviderEffort;
  verificationStatus: 'verified';
  verifiedAt: string;
  policy: 'manual';
};
export type ProviderModelCapability = {
  id: string;
  catalogId?: string;
  label: string;
  availability: ProviderAvailability;
  entitlement: null;
  supportedEfforts: ProviderEffort[];
  defaultEffort?: ProviderEffort;
  hidden?: boolean;
};
export type ProviderCatalog = { providerId: ProviderId; models: ProviderModelCapability[]; catalogStatus: 'known' | 'partial' | 'unknown' };
export type ProviderConnectionView = ProviderConnectionMetadata & { credentialPresent: boolean; cleanupPending: boolean; lastVerifiedSelection?: { modelId: string; effort: ProviderEffort }; localSession?: { status: 'unknown' | 'authenticated' | 'unauthenticated'; checkedAt?: string }; capabilities: ProviderCatalog };
export type ProviderOperationResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string; field?: string };
export type ResolvedProviderRun = { agent: CodingAgent; metadata: ProviderRunSelectionMetadata };

export const PROVIDER_AUTH_SOURCES: Readonly<Record<ProviderId, readonly ProviderAuthSource[]>> = {
  codex: ['chatgpt', 'openai-api-key'],
  claude: ['claude-subscription', 'anthropic-api-key'],
  minimax: ['minimax-api-key', 'minimax-token-plan'],
};
export const PROVIDER_EFFORTS: readonly ProviderEffort[] = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function isProviderId(value: unknown): value is ProviderId {
  return value === 'codex' || value === 'claude' || value === 'minimax';
}
export function isProviderAuthSource(value: unknown): value is ProviderAuthSource {
  return typeof value === 'string' && (PROVIDER_AUTH_SOURCES.codex as readonly string[]).concat(PROVIDER_AUTH_SOURCES.claude, PROVIDER_AUTH_SOURCES.minimax).includes(value);
}
export function isProviderEffort(value: unknown): value is ProviderEffort {
  return typeof value === 'string' && (PROVIDER_EFFORTS as readonly string[]).includes(value);
}
export function isSupportedProviderSource(providerId: unknown, authSource: unknown): providerId is ProviderId {
  return isProviderId(providerId) && isProviderAuthSource(authSource) && PROVIDER_AUTH_SOURCES[providerId].includes(authSource);
}
export function providerIdForAuthSource(source: ProviderAuthSource): ProviderId {
  if (source === 'chatgpt' || source === 'openai-api-key') return 'codex';
  if (source === 'claude-subscription' || source === 'anthropic-api-key') return 'claude';
  return 'minimax';
}
export function validateProviderSelection(input: unknown): ProviderOperationResult<ProviderSelection> {
  if (!isRecord(input) || !hasOnly(input, ['connectionId', 'modelId', 'effort'])) return { ok: false, code: 'provider.selection.shape', message: 'Choose a provider connection, model, and supported effort.' };
  if (typeof input.connectionId !== 'string' || input.connectionId.length < 1 || input.connectionId.length > 128) return { ok: false, code: 'provider.selection.connection', field: 'connectionId', message: 'Choose a valid provider connection.' };
  if (typeof input.modelId !== 'string' || input.modelId.trim().length < 1 || input.modelId.length > 200) return { ok: false, code: 'provider.selection.model', field: 'modelId', message: 'Choose a valid model.' };
  if (!isProviderEffort(input.effort)) return { ok: false, code: 'provider.selection.effort', field: 'effort', message: 'Choose a supported model effort.' };
  return { ok: true, value: { connectionId: input.connectionId, modelId: input.modelId, effort: input.effort } };
}
export function validateProviderRunMetadata(input: unknown): ProviderOperationResult<ProviderRunSelectionMetadata> {
  if (!isRecord(input) || !hasOnly(input, ['version', 'providerId', 'connectionId', 'authSource', 'modelId', 'effort', 'verificationStatus', 'verifiedAt', 'policy'])) return { ok: false, code: 'provider.metadata.shape', message: 'Provider run metadata is malformed.' };
  if (input.version !== 1 || !isProviderId(input.providerId) || !isProviderAuthSource(input.authSource) || !isSupportedProviderSource(input.providerId, input.authSource)) return { ok: false, code: 'provider.metadata.provider', message: 'Provider run metadata contains an unsupported provider or authentication source.' };
  if (typeof input.connectionId !== 'string' || !input.connectionId || input.connectionId.length > 128 || typeof input.modelId !== 'string' || !input.modelId || input.modelId.length > 200 || !isProviderEffort(input.effort) || !isEffortSupportedByProvider(input.providerId, input.effort) || input.verificationStatus !== 'verified' || typeof input.verifiedAt !== 'string' || Number.isNaN(Date.parse(input.verifiedAt)) || input.policy !== 'manual') return { ok: false, code: 'provider.metadata.fields', message: 'Provider run metadata contains invalid selection details.' };
  return { ok: true, value: structuredClone(input) as ProviderRunSelectionMetadata };
}
export function credentialRequired(source: ProviderAuthSource): boolean {
  return source === 'openai-api-key' || source === 'anthropic-api-key' || source === 'minimax-api-key' || source === 'minimax-token-plan';
}
function isEffortSupportedByProvider(providerId: ProviderId, effort: ProviderEffort): boolean {
  if (providerId === 'minimax') return effort === 'default';
  if (providerId === 'claude') return ['default', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort);
  return true;
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function hasOnly(value: Record<string, unknown>, fields: readonly string[]): boolean { return Object.keys(value).every(field => fields.includes(field)); }

export interface ProviderConnectionService {
  list(): Promise<ProviderConnectionView[]>;
  cleanupStatus(): Promise<{ pending: boolean }>;
  create(input: ProviderConnectionInput): Promise<ProviderConnectionMetadata>;
  update(connectionId: string, input: ProviderConnectionUpdate): Promise<ProviderConnectionMetadata>;
  delete(connectionId: string): Promise<void>;
  verify(connectionId: string, selection: Omit<ProviderSelection, 'connectionId'>): Promise<ProviderConnectionView>;
  catalog(providerId: ProviderId, connectionId?: string): Promise<ProviderCatalog>;
  resolve(selection: ProviderSelection): Promise<ResolvedProviderRun>;
}
