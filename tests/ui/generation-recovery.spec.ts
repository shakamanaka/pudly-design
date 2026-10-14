import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../../src/App.vue';
import { localApi, LocalApiError } from '../../src/ui/services/local-api';
import { createDocument } from '../../src/domain';
import type { AgentRunRecord, PersistedProjectEnvelope } from '../../src/domain';

afterEach(() => vi.restoreAllMocks());

function setup() {
  vi.spyOn(localApi, 'listConnections').mockRejectedValue(new LocalApiError('Legacy fixture has no provider registry.', 404));
  vi.spyOn(localApi, 'getProviderCatalog').mockRejectedValue(new LocalApiError('Legacy fixture has no provider registry.', 404));
  const document = createDocument('Polling recovery');
  const project: PersistedProjectEnvelope = { formatVersion: 1, document, history: { undoableEntries: [], cursor: 0, auditTransitions: [], snapshots: [] }, appliedBatchIds: [], integrityHash: 'ui-fixture' };
  const run = (id: string, state: AgentRunRecord['state']): AgentRunRecord => ({ id, documentId: document.id, baseRevision: 0, userRequest: id, selectedNodeIds: [], resolvedContext: [], operationCapabilities: [], state, startedAt: '2026-10-06T00:00:00Z', validationResults: [], qaResults: [] });
  vi.spyOn(localApi, 'getCapabilities').mockResolvedValue({ operationTypes: ['node.create'], exportTargets: [], nodeKinds: ['frame', 'text'] });
  vi.spyOn(localApi, 'getProject').mockResolvedValue({ project });
  vi.spyOn(localApi, 'listRuns').mockResolvedValue({ runs: [run('old', 'RUNNING')] });
  vi.spyOn(localApi, 'cancelRun').mockResolvedValue({ run: run('old', 'CANCELLED') });
  return { run };
}

test('an in-flight pre-cancel poll cannot restore cancelled work or overwrite a new run', async () => {
  const { run } = setup();
  let resolveOld!: (result: { run: AgentRunRecord; events: [] }) => void;
  const oldResponse = new Promise<{ run: AgentRunRecord; events: [] }>(resolve => { resolveOld = resolve; });
  vi.spyOn(localApi, 'getRun').mockImplementation(id => id === 'old' ? oldResponse : Promise.resolve({ run: run('new', 'RUNNING'), events: [] }));
  vi.spyOn(localApi, 'startRun').mockResolvedValue({ runId: 'new' });
  const wrapper = mount(App);
  try {
    await flushPromises();
    const cancel = wrapper.findAll('button').find(button => button.text() === 'Cancel run');
    expect(cancel).toBeDefined();
    await cancel!.trigger('click');
    await flushPromises();
    expect(wrapper.get('.run-sidebar__state').text()).toBe('Cancelled');
    await wrapper.get('textarea#design-prompt').setValue('New design');
    await wrapper.get('form.prompt-form').trigger('submit');
    await flushPromises();
    resolveOld({ run: { ...run('old', 'FAILED'), validationResults: [{ code: 'old.failure', message: 'Stale failure', severity: 'error' }] }, events: [] });
    await flushPromises();
    expect(wrapper.get('.run-sidebar__state').text()).toBe('Generating');
    expect(wrapper.text()).not.toContain('Stale failure');
  } finally { wrapper.unmount(); }
});

test('late initialization cannot start polling after the editor is unmounted', async () => {
  const { run } = setup();
  let resolveRuns!: (result: { runs: AgentRunRecord[] }) => void;
  vi.mocked(localApi.listRuns).mockImplementation(() => new Promise(resolve => { resolveRuns = resolve; }));
  const getRun = vi.spyOn(localApi, 'getRun').mockResolvedValue({ run: run('old', 'RUNNING'), events: [] });
  const wrapper = mount(App);
  await flushPromises();
  wrapper.unmount();
  resolveRuns({ runs: [run('old', 'RUNNING')] });
  await flushPromises();
  expect(getRun).not.toHaveBeenCalled();
});

 test('reopened failed runs display their actionable adapter message', async () => {
  const { run } = setup();
  const failure = { ...run('failed', 'FAILED'), validationResults: [{ code: 'agent.timeout', message: 'Generation exceeded the time limit. Try a smaller section.', severity: 'error' as const }] };
  vi.mocked(localApi.listRuns).mockResolvedValue({ runs: [failure] });
  const getRun = vi.spyOn(localApi, 'getRun');
  const wrapper = mount(App);
  try {
    await flushPromises();
    expect(wrapper.get('.run-sidebar__state').text()).toBe('Run failed');
    expect(wrapper.text()).toContain('Generation exceeded the time limit. Try a smaller section.');
    expect(getRun).not.toHaveBeenCalled();
  } finally { wrapper.unmount(); }
});

 test('a successful terminal poll does not report monitoring exhaustion', async () => {
  const { run } = setup();
  vi.spyOn(localApi, 'getRun').mockResolvedValue({ run: run('old', 'SUCCEEDED'), events: [] });
  const wrapper = mount(App);
  try {
    await flushPromises();
    expect(wrapper.text()).not.toContain('Run monitoring paused');
  } finally { wrapper.unmount(); }
});
