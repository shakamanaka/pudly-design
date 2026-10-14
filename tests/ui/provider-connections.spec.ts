import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConnectionMetadata, ProviderConnectionView } from '../../src/domain/providers';
import { LocalApiError, localApi } from '../../src/ui/services/local-api';
import ProviderConnections from '../../src/ui/components/ProviderConnections.vue';

afterEach(() => vi.restoreAllMocks());

const now = '2026-10-08T12:00:00.000Z';
function connection(overrides: Partial<ProviderConnectionView> = {}): ProviderConnectionView {
  const base: ProviderConnectionView = {
    cleanupPending: false, id: 'codex-work', providerId: 'codex', authSource: 'chatgpt', label: 'Work account',
    verificationStatus: 'unverified', credentialPresent: false, createdAt: now, updatedAt: now,
    capabilities: {
      providerId: 'codex', catalogStatus: 'known', models: [
        { id: 'gpt-6.1-sol', label: 'GPT 6.1 Sol', availability: 'unknown', entitlement: null, supportedEfforts: ['low', 'high'] },
        { id: 'gpt-6.1-custom', label: 'Custom selection model', availability: 'unknown', entitlement: null, supportedEfforts: ['medium'] },
      ],
    },
    ...overrides,
  };
  return base;
}
function metadata(view: ProviderConnectionView): ProviderConnectionMetadata {
  return {
    id: view.id, providerId: view.providerId, authSource: view.authSource, label: view.label,
    verificationStatus: view.verificationStatus, ...(view.verifiedAt ? { verifiedAt: view.verifiedAt } : {}),
    ...(view.lastFailure ? { lastFailure: view.lastFailure } : {}), createdAt: view.createdAt, updatedAt: view.updatedAt,
  };
}
function setup(initial: ProviderConnectionView[] = [connection()]) {
  vi.spyOn(localApi, 'listConnections').mockResolvedValue({ connections: initial });
  vi.spyOn(localApi, 'getProviderCatalog').mockResolvedValue({
    providers: [{ providerId: 'codex', catalogStatus: 'known', models: [
      { id: 'gpt-6.1-sol', label: 'GPT 6.1 Sol', availability: 'unknown', entitlement: null, supportedEfforts: ['low', 'high'] },
      { id: 'gpt-6.1-custom', label: 'Custom selection model', availability: 'unknown', entitlement: null, supportedEfforts: ['medium'] },
    ] },
      { providerId: 'claude', catalogStatus: 'unknown', models: [] },
      { providerId: 'minimax', catalogStatus: 'unknown', models: [] }],
  });
  return mount(ProviderConnections);
}

describe('AI connection selection', () => {
  it('keeps unknown availability honest and does not verify on mount', async () => {
    const verify = vi.spyOn(localApi, 'verifyConnection');
    const wrapper = setup();
    await flushPromises();

    expect(wrapper.text()).toContain('Unknown');
    expect(wrapper.text()).toContain('Availability is unknown');
    expect(verify).not.toHaveBeenCalled();
    expect(wrapper.emitted('selection')?.at(-1)).toEqual([null]);
    wrapper.unmount();
  });

  it('marks legacy server support unavailable only for a missing provider endpoint', async () => {
    vi.spyOn(localApi, 'listConnections').mockRejectedValue(new LocalApiError('Not found', 404, 'route.notFound'));
    vi.spyOn(localApi, 'getProviderCatalog').mockResolvedValue({ providers: [] });
    const wrapper = mount(ProviderConnections);
    await flushPromises();
    expect(wrapper.emitted('configured')).toEqual([[false]]);
    wrapper.unmount();

    vi.restoreAllMocks();
    vi.spyOn(localApi, 'listConnections').mockRejectedValue(new LocalApiError('Service unavailable', 503, 'service.unavailable'));
    vi.spyOn(localApi, 'getProviderCatalog').mockResolvedValue({ providers: [] });
    const failedService = mount(ProviderConnections);
    await flushPromises();
    expect(failedService.emitted('configured')).toEqual([[true]]);
    failedService.unmount();
  });

  it('emits only the exact verified model and effort, then invalidates on either change', async () => {
    const verified = connection({
      verificationStatus: 'verified', verifiedAt: now,
      lastVerifiedSelection: { modelId: 'gpt-6.1-sol', effort: 'low' },
      capabilities: { providerId: 'codex', catalogStatus: 'known', models: [
        { id: 'gpt-6.1-sol', label: 'GPT 6.1 Sol', availability: 'available', entitlement: null, supportedEfforts: ['low', 'high'] },
      ] },
    });
    const wrapper = setup([verified]);
    await flushPromises();

    expect(wrapper.emitted('selection')?.at(-1)).toEqual([{ connectionId: 'codex-work', modelId: 'gpt-6.1-sol', effort: 'low' }]);
    await wrapper.get('[aria-label="Model effort"]').setValue('high');
    expect(wrapper.emitted('selection')?.at(-1)).toEqual([null]);
    await wrapper.get('[aria-label="Model effort"]').setValue('low');
    expect(wrapper.emitted('selection')?.at(-1)).toEqual([{ connectionId: 'codex-work', modelId: 'gpt-6.1-sol', effort: 'low' }]);
    await wrapper.get('[aria-label="Model"]').setValue('unverified-model');
    expect(wrapper.emitted('selection')?.at(-1)).toEqual([null]);
    wrapper.unmount();
  });

  it('verifies only when requested and binds verification to the submitted model and effort', async () => {
    const verified = connection({
      verificationStatus: 'verified', verifiedAt: now,
      lastVerifiedSelection: { modelId: 'gpt-6.1-sol', effort: 'low' },
      capabilities: { providerId: 'codex', catalogStatus: 'known', models: [
        { id: 'gpt-6.1-sol', label: 'GPT 6.1 Sol', availability: 'available', entitlement: null, supportedEfforts: ['low', 'high'] },
      ] },
    });
    const verify = vi.spyOn(localApi, 'verifyConnection').mockResolvedValue({ connection: verified });
    const wrapper = setup([connection()]);
    await flushPromises();
    expect(verify).not.toHaveBeenCalled();

    await wrapper.get('[aria-label="Model"]').setValue('gpt-6.1-sol');
    await wrapper.get('[aria-label="Test connection"]').trigger('click');
    await flushPromises();

    expect(verify).toHaveBeenCalledWith('codex-work', { modelId: 'gpt-6.1-sol', effort: 'low' });
    expect(wrapper.text()).toContain('This model and effort are verified');
    expect(wrapper.emitted('selection')?.at(-1)).toEqual([{ connectionId: 'codex-work', modelId: 'gpt-6.1-sol', effort: 'low' }]);
    wrapper.unmount();
  });

  it('preserves a verified custom model and medium effort when the connection is reopened', async () => {
    const initial = connection();
    const verified = connection({
      verificationStatus: 'verified', verifiedAt: now,
      lastVerifiedSelection: { modelId: 'gpt-6.1-custom', effort: 'medium' },
      capabilities: { providerId: 'codex', catalogStatus: 'known', models: [
        { id: 'gpt-6.1-sol', label: 'GPT 6.1 Sol', availability: 'unknown', entitlement: null, supportedEfforts: ['low', 'high'] },
        { id: 'gpt-6.1-custom', label: 'Custom selection model', availability: 'available', entitlement: null, supportedEfforts: ['medium'] },
      ] },
    });
    vi.spyOn(localApi, 'listConnections')
      .mockResolvedValueOnce({ connections: [initial] })
      .mockResolvedValue({ connections: [verified] });
    vi.spyOn(localApi, 'verifyConnection').mockResolvedValue({ connection: verified });
    vi.spyOn(localApi, 'getProviderCatalog').mockResolvedValue({
      providers: [{ providerId: 'codex', catalogStatus: 'known', models: verified.capabilities.models },
        { providerId: 'claude', catalogStatus: 'unknown', models: [] },
        { providerId: 'minimax', catalogStatus: 'unknown', models: [] }],
    });
    const wrapper = mount(ProviderConnections);
    await flushPromises();
    await wrapper.get('[aria-label="Model"]').setValue('gpt-6.1-custom');
    await wrapper.get('[aria-label="Model effort"]').setValue('medium');
    await wrapper.get('[aria-label="Test connection"]').trigger('click');
    await flushPromises();
    expect(wrapper.emitted('selection')?.at(-1)).toEqual([{ connectionId: 'codex-work', modelId: 'gpt-6.1-custom', effort: 'medium' }]);
    wrapper.unmount();

    const reopened = mount(ProviderConnections);
    await flushPromises();
    expect((reopened.get('[aria-label="Model"]').element as HTMLInputElement).value).toBe('gpt-6.1-custom');
    expect((reopened.get('[aria-label="Model effort"]').element as HTMLSelectElement).value).toBe('medium');
    expect(reopened.emitted('selection')?.at(-1)).toEqual([{ connectionId: 'codex-work', modelId: 'gpt-6.1-custom', effort: 'medium' }]);
    reopened.unmount();
  });

  it('allows testing a custom Codex model with a candidate effort but emits only after exact verification', async () => {
    const verified = connection({
      verificationStatus: 'verified', verifiedAt: now,
      lastVerifiedSelection: { modelId: 'custom-preview-model', effort: 'medium' },
      capabilities: { providerId: 'codex', catalogStatus: 'partial', models: [
        { id: 'custom-preview-model', label: 'custom-preview-model', availability: 'available', entitlement: null, supportedEfforts: ['medium'] },
      ] },
    });
    const verify = vi.spyOn(localApi, 'verifyConnection').mockResolvedValue({ connection: verified });
    const wrapper = setup([connection()]);
    await flushPromises();
    await wrapper.get('[aria-label="Model"]').setValue('custom-preview-model');
    await wrapper.get('[aria-label="Model effort"]').setValue('medium');

    expect(wrapper.text()).toContain('unknown until you test this connection');
    expect((wrapper.get('[aria-label="Test connection"]').element as HTMLButtonElement).disabled).toBe(false);
    expect(wrapper.emitted('selection')?.at(-1)).toEqual([null]);
    expect(verify).not.toHaveBeenCalled();

    await wrapper.get('[aria-label="Test connection"]').trigger('click');
    await flushPromises();
    expect(verify).toHaveBeenCalledWith('codex-work', { modelId: 'custom-preview-model', effort: 'medium' });
    expect(wrapper.emitted('selection')?.at(-1)).toEqual([{ connectionId: 'codex-work', modelId: 'custom-preview-model', effort: 'medium' }]);
    wrapper.unmount();
  });

  it('offers only default effort for an unknown MiniMax model', async () => {
    const minimax = connection({
      id: 'minimax-plan', providerId: 'minimax', authSource: 'minimax-token-plan',
      capabilities: { providerId: 'minimax', catalogStatus: 'unknown', models: [] },
    });
    const wrapper = setup([minimax]);
    await flushPromises();
    await wrapper.get('[aria-label="Model"]').setValue('minimax-custom-model');
    const effortOptions = wrapper.findAll('[aria-label="Model effort"] option');
    expect(effortOptions.map(option => option.text())).toEqual(['Default']);
    expect(wrapper.text()).toContain('unknown until you test this connection');
    expect(wrapper.emitted('selection')?.at(-1)).toEqual([null]);
    wrapper.unmount();
  });

  it('clears the active verified selection after credential rotation', async () => {
    const verified = connection({
      verificationStatus: 'verified', verifiedAt: now,
      lastVerifiedSelection: { modelId: 'gpt-6.1-sol', effort: 'low' },
      capabilities: { providerId: 'codex', catalogStatus: 'known', models: [
        { id: 'gpt-6.1-sol', label: 'GPT 6.1 Sol', availability: 'available', entitlement: null, supportedEfforts: ['low', 'high'] },
      ] },
    });
    const rotated = connection({ verificationStatus: 'unverified', credentialPresent: true });
    vi.spyOn(localApi, 'listConnections').mockResolvedValueOnce({ connections: [verified] }).mockResolvedValue({ connections: [rotated] });
    vi.spyOn(localApi, 'getProviderCatalog').mockResolvedValue({ providers: [] });
    vi.spyOn(localApi, 'updateConnection').mockResolvedValue({ connection: metadata(rotated) });
    const wrapper = mount(ProviderConnections);
    await flushPromises();
    expect(wrapper.emitted('selection')?.at(-1)).toEqual([{ connectionId: 'codex-work', modelId: 'gpt-6.1-sol', effort: 'low' }]);
    await wrapper.get('[aria-label="Replacement credential"]').setValue('rotated-secret');
    await wrapper.get('[aria-label="Save changes"]').trigger('click');
    await flushPromises();

    expect(wrapper.emitted('selection')?.at(-1)).toEqual([null]);
    expect(wrapper.text()).toContain('Unknown');
    expect((wrapper.get('[aria-label="Replacement credential"]').element as HTMLInputElement).value).toBe('');
    wrapper.unmount();
  });

  it('clears credential input after connection creation succeeds or fails', async () => {
    const list = vi.spyOn(localApi, 'listConnections');
    vi.spyOn(localApi, 'createConnection').mockResolvedValue({ connection: metadata(connection({ id: 'openai-key', authSource: 'openai-api-key', label: 'Personal' })) });
    const wrapper = setup([]);
    await flushPromises();
    await wrapper.get('[aria-label="Provider connection"]').setValue('codex');
    await wrapper.get('[aria-label="Authentication source"]').setValue('openai-api-key');
    await wrapper.get('[aria-label="New connection name"]').setValue('Personal');
    await wrapper.get('[aria-label="Credential"]').setValue('sentinel-secret');
    list.mockResolvedValue({ connections: [connection({ id: 'openai-key', authSource: 'openai-api-key', label: 'Personal' })] });
    await wrapper.get('[aria-label="Add connection"]').trigger('click');
    await flushPromises();

    expect((wrapper.get('[aria-label="Replacement credential"]').element as HTMLInputElement).value).toBe('');
    const create = vi.mocked(localApi.createConnection);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ credential: 'sentinel-secret', authSource: 'openai-api-key' });
    expect(wrapper.text()).not.toContain('sentinel-secret');

    await wrapper.get('[aria-label="Provider connection"]').setValue('claude');
    await wrapper.get('[aria-label="Authentication source"]').setValue('anthropic-api-key');
    await wrapper.get('[aria-label="New connection name"]').setValue('Claude');
    await wrapper.get('[aria-label="Credential"]').setValue('failed-sentinel');
    create.mockRejectedValueOnce(new Error('Credential failed-sentinel was rejected'));
    await wrapper.get('[aria-label="Add connection"]').trigger('click');
    await flushPromises();

    expect((wrapper.get('[aria-label="Credential"]').element as HTMLInputElement).value).toBe('');
    expect(wrapper.text()).not.toContain('failed-sentinel');
    expect(wrapper.get('[role="alert"]').text()).toContain('[redacted]');
    wrapper.unmount();
  });

  it('requires a credential for key and token sources before making a request', async () => {
    const create = vi.spyOn(localApi, 'createConnection');
    const wrapper = setup([]);
    await flushPromises();
    await wrapper.get('[aria-label="Provider connection"]').setValue('minimax');
    await wrapper.get('[aria-label="Authentication source"]').setValue('minimax-token-plan');
    await wrapper.get('[aria-label="New connection name"]').setValue('MiniMax plan');
    expect(wrapper.get('[aria-label="Add connection"]').attributes('disabled')).toBeDefined();
    expect(create).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('shows quota unavailability without selecting another provider', async () => {
    const quota = connection({ verificationStatus: 'failed', lastFailure: 'quota' });
    const wrapper = setup([quota]);
    await flushPromises();
    expect(wrapper.text()).toContain('Verification failed');
    expect(wrapper.text()).toContain('Quota unavailable. No other provider will be selected automatically.');
    expect(wrapper.emitted('selection')?.at(-1)).toEqual([null]);
    wrapper.unmount();
  });
});

 it('lists every supplied model and switches to the advertised effort without implying verification', async () => {
  setup(); const wrapper = mount(ProviderConnections); await flushPromises();
  expect(wrapper.get('[aria-label="Model picker"]').findAll('option').map(option => option.attributes('value'))).toContain('gpt-6.1-custom');
  await wrapper.get('[aria-label="Model picker"]').setValue('gpt-6.1-custom'); await flushPromises();
  expect(wrapper.get('[aria-label="Model effort"]').findAll('option').map(option => option.attributes('value'))).toEqual(['medium']);
  expect(wrapper.emitted('selection')?.at(-1)).toEqual([null]);
  wrapper.unmount();
});
 it('catalog refresh preserves a supported selected model and effort', async () => {
  setup(); const wrapper = mount(ProviderConnections); await flushPromises();
  await wrapper.get('[aria-label="Model picker"]').setValue('gpt-6.1-custom'); await flushPromises();
  const refresh = wrapper.findAll('button').find(button => button.text() === 'Refresh models');
  await refresh!.trigger('click'); await flushPromises();
  expect((wrapper.get('[aria-label="Model picker"]').element as HTMLSelectElement).value).toBe('gpt-6.1-custom');
  expect((wrapper.get('[aria-label="Model effort"]').element as HTMLSelectElement).value).toBe('medium');
  wrapper.unmount();
});

 it('distinguishes a recognized Claude session from a failed exact verification', async () => {
  const claude = connection({ id: 'claude-local', providerId: 'claude', authSource: 'claude-subscription', verificationStatus: 'failed', lastFailure: 'transport', localSession: { status: 'authenticated' }, capabilities: { providerId: 'claude', catalogStatus: 'known', models: [{ id: 'haiku-versioned', label: 'Haiku versioned', supportedEfforts: ['default'], availability: 'unknown', entitlement: null }] } });
  const verify = vi.spyOn(localApi, 'verifyConnection');
  const wrapper = setup([claude]); await flushPromises();
  expect(wrapper.get('[aria-label="Claude session status"]').text()).toContain('Claude session recognized');
  expect(wrapper.text()).toContain('Verification failed');
  expect(wrapper.text()).not.toContain('Unavailable');
  expect(wrapper.emitted('selection')?.at(-1)).toEqual([null]);
  expect(verify).not.toHaveBeenCalled(); wrapper.unmount();
});
 it('offers login recovery only for a confirmed signed-out Claude session', async () => {
  const claude = connection({ providerId: 'claude', authSource: 'claude-subscription', localSession: { status: 'unauthenticated' } });
  const wrapper = setup([claude]); await flushPromises();
  expect(wrapper.get('[aria-label="Claude session status"]').text()).toContain('Run claude auth login'); wrapper.unmount();
  const unknown = setup([{ ...claude, localSession: { status: 'unknown' } }]); await flushPromises();
  expect(unknown.get('[aria-label="Claude session status"]').text()).toContain('could not be checked');
  expect(unknown.text()).not.toContain('Run claude auth login'); unknown.unmount();
});
 it('reloads persisted verification failure without losing independent session evidence', async () => {
  const initial = connection({ id: 'claude-local', providerId: 'claude', authSource: 'claude-subscription', localSession: { status: 'authenticated' } });
  const wrapper = setup([initial]); await flushPromises();
  vi.mocked(localApi.listConnections).mockResolvedValue({ connections: [{ ...initial, verificationStatus: 'failed', lastFailure: 'transport' }] });
  vi.spyOn(localApi, 'verifyConnection').mockRejectedValue(new LocalApiError('The provider could not complete verification.', 502, 'provider.transport'));
  await wrapper.get('[aria-label="Test connection"]').trigger('click'); await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('could not complete verification');
  expect(wrapper.get('[aria-label="Claude session status"]').text()).toContain('session recognized');
  expect(wrapper.text()).toContain('Verification failed');
  expect(wrapper.emitted('selection')?.at(-1)).toEqual([null]); wrapper.unmount();
});
