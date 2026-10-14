import { describe, expect, it } from 'vitest';
import {
  credentialRequired,
  isSupportedProviderSource,
  providerIdForAuthSource,
  validateProviderRunMetadata,
  validateProviderSelection,
} from '../../../src/domain/providers.js';

describe('provider connection domain contracts', () => {
  it('accepts only the supported provider and authentication-source pairs', () => {
    expect(isSupportedProviderSource('codex', 'chatgpt')).toBe(true);
    expect(isSupportedProviderSource('codex', 'openai-api-key')).toBe(true);
    expect(isSupportedProviderSource('claude', 'claude-subscription')).toBe(true);
    expect(isSupportedProviderSource('claude', 'anthropic-api-key')).toBe(true);
    expect(isSupportedProviderSource('minimax', 'minimax-api-key')).toBe(true);
    expect(isSupportedProviderSource('minimax', 'minimax-token-plan')).toBe(true);
  });

  it('rejects unsupported provider and authentication-source combinations', () => {
    expect(isSupportedProviderSource('codex', 'claude-subscription'), 'Codex must reject Claude subscription credentials').toBe(false);
    expect(isSupportedProviderSource('claude', 'minimax-api-key'), 'Claude must reject MiniMax API credentials').toBe(false);
    expect(isSupportedProviderSource('minimax', 'openai-api-key'), 'MiniMax must reject OpenAI API credentials').toBe(false);
    expect(isSupportedProviderSource('other', 'chatgpt'), 'unknown providers must be rejected').toBe(false);
  });

  it('maps every supported authentication source to its owning provider', () => {
    expect(providerIdForAuthSource('chatgpt')).toBe('codex');
    expect(providerIdForAuthSource('openai-api-key')).toBe('codex');
    expect(providerIdForAuthSource('claude-subscription')).toBe('claude');
    expect(providerIdForAuthSource('anthropic-api-key')).toBe('claude');
    expect(providerIdForAuthSource('minimax-api-key')).toBe('minimax');
    expect(providerIdForAuthSource('minimax-token-plan')).toBe('minimax');
  });

  it('requires credentials only for API-key and token-plan sources', () => {
    expect(credentialRequired('chatgpt')).toBe(false);
    expect(credentialRequired('claude-subscription')).toBe(false);
    expect(credentialRequired('openai-api-key')).toBe(true);
    expect(credentialRequired('anthropic-api-key')).toBe(true);
    expect(credentialRequired('minimax-api-key')).toBe(true);
    expect(credentialRequired('minimax-token-plan')).toBe(true);
  });
});

describe('provider run selection validation', () => {
  it('preserves a valid explicit connection, model, and effort selection', () => {
    expect(validateProviderSelection({ connectionId: 'conn-a', modelId: 'model-a', effort: 'high' })).toEqual({
      ok: true,
      value: { connectionId: 'conn-a', modelId: 'model-a', effort: 'high' },
    });
  });

  it('rejects unsupported effort before provider dispatch', () => {
    expect(validateProviderSelection({ connectionId: 'conn-a', modelId: 'model-a', effort: 'turbo' }), 'unsupported effort must fail selection parsing').toMatchObject({
      ok: false,
      code: 'provider.selection.effort',
      field: 'effort',
    });
  });

  it('rejects malformed and secret-bearing selection shapes', () => {
    expect(validateProviderSelection({ connectionId: 'conn-a', modelId: 'model-a', effort: 'low', credential: 'sentinel-credential' })).toMatchObject({
      ok: false,
      code: 'provider.selection.shape',
    });
    expect(validateProviderSelection({ connectionId: '', modelId: 'model-a', effort: 'low' })).toMatchObject({ ok: false, field: 'connectionId' });
    expect(validateProviderSelection({ connectionId: 'conn-a', modelId: ' ', effort: 'low' })).toMatchObject({ ok: false, field: 'modelId' });
  });
});

describe('provider run metadata validation', () => {
  const validMetadata = {
    version: 1,
    providerId: 'codex',
    connectionId: 'conn-a',
    authSource: 'chatgpt',
    modelId: 'gpt-model',
    effort: 'low',
    verificationStatus: 'verified',
    verifiedAt: '2026-10-08T12:00:00.000Z',
    policy: 'manual',
  };

  it('accepts and snapshots safe versioned route metadata', () => {
    const source = structuredClone(validMetadata);
    const result = validateProviderRunMetadata(source);
    expect(result).toMatchObject({ ok: true, value: validMetadata });
    source.modelId = 'changed-after-validation';
    expect(result.ok && result.value.modelId).toBe('gpt-model');
  });

  it('rejects metadata with mismatched provider and authentication source', () => {
    expect(validateProviderRunMetadata({ ...validMetadata, providerId: 'claude' }), 'route metadata must enforce provider/source ownership').toMatchObject({
      ok: false,
      code: 'provider.metadata.provider',
    });
  });

  it('rejects credential values and secret-store keys from persisted metadata', () => {
    expect(validateProviderRunMetadata({ ...validMetadata, credential: 'sentinel-credential' }), 'credential values must not be serialized into run metadata').toMatchObject({
      ok: false,
      code: 'provider.metadata.shape',
    });
    expect(validateProviderRunMetadata({ ...validMetadata, secretRef: 'sentinel-secret-key' }), 'secret-store keys must not be serialized into run metadata').toMatchObject({
      ok: false,
      code: 'provider.metadata.shape',
    });
  });

  it('rejects unknown, stale, or malformed selection fields', () => {
    expect(validateProviderRunMetadata({ ...validMetadata, internalSecretRef: 'sentinel-secret-key' }), 'unknown route metadata fields must be rejected').toMatchObject({ ok: false, code: 'provider.metadata.shape' });
    expect(validateProviderRunMetadata({ ...validMetadata, effort: 'turbo' })).toMatchObject({ ok: false, code: 'provider.metadata.fields' });
    expect(validateProviderRunMetadata({ ...validMetadata, verificationStatus: 'unverified' })).toMatchObject({ ok: false, code: 'provider.metadata.fields' });
    expect(validateProviderRunMetadata({ ...validMetadata, verifiedAt: 'not-a-date' })).toMatchObject({ ok: false, code: 'provider.metadata.fields' });
  });
});
