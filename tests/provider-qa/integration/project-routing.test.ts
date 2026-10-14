import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectService, type ProjectPersistence } from '../../../src/application/project-service.js';
import { LocalProviderConnectionService } from '../../../src/adapters/providers/connection-service.js';
import { CodingAgentError } from '../../../src/domain/agent-error.js';
import { createNodeBase } from '../../../src/domain/defaults.js';
import type {
  CodingAgent, CodingAgentRequest, CodingAgentResponse, Operation, PersistedProjectEnvelope, RunEvent,
} from '../../../src/domain/types.js';

const temporaryDirectories: string[] = [];
const selectedRunMetadata = {
  version: 1,
  providerId: 'codex',
  connectionId: 'codex-local',
  authSource: 'chatgpt',
  modelId: 'gpt-6.1-sol',
  effort: 'low',
  verificationStatus: 'verified',
  verifiedAt: '2026-10-08T12:00:00.000Z',
  policy: 'manual',
} as const;

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class MemoryPersistence implements ProjectPersistence {
  private saved: PersistedProjectEnvelope | null = null;
  async loadCurrent(): Promise<PersistedProjectEnvelope | null> { return structuredClone(this.saved); }
  async load(): Promise<PersistedProjectEnvelope | null> { return structuredClone(this.saved); }
  async select(): Promise<void> {}
  async saveAtomically(envelope: PersistedProjectEnvelope, expectedRevision: number): Promise<{ savedRevision: number }> {
    const actual = this.saved?.document.revision ?? 0;
    if (actual !== expectedRevision) throw new Error('revision conflict');
    this.saved = structuredClone(envelope);
    return { savedRevision: envelope.document.revision };
  }
}

class ControlledProviderAgent implements CodingAgent {
  readonly started = deferred<CodingAgentRequest>();
  private readonly answer = deferred<CodingAgentResponse>();
  cancelCalls = 0;
  wasStarted = false;

  constructor(private readonly failure?: CodingAgentError) {}

  async *execute(request: CodingAgentRequest, signal: AbortSignal): AsyncIterable<RunEvent | { type: 'response'; response: CodingAgentResponse }> {
    if (request.prompt.startsWith('Connection verification only.')) {
      yield { type: 'response', response: { operations: [], summary: 'fixture verification' } };
      return;
    }
    this.wasStarted = true;
    this.started.resolve(structuredClone(request));
    yield { type: 'state', runId: request.runId, state: 'RUNNING', at: new Date().toISOString() };
    if (this.failure) throw this.failure;
    const response = await this.answer.promise;
    if (signal.aborted) return;
    yield { type: 'response', response };
  }

  respond(operations: Operation[]): void { this.answer.resolve({ operations, summary: 'provider QA response' }); }
  async cancel(): Promise<void> { this.cancelCalls += 1; this.answer.resolve({ operations: [] }); }
  async getStatus(runId: string) { return { runId, state: 'RUNNING' as const }; }
}

async function setup(options: { generationFailure?: CodingAgentError } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'provider-project-qa-'));
  temporaryDirectories.push(directory);
  const agents: ControlledProviderAgent[] = [];
  const providers = await LocalProviderConnectionService.open(join(directory, 'provider-connections'), {
    clock: () => new Date('2026-10-08T12:00:00.000Z'),
    createAgent: () => {
      const agent = new ControlledProviderAgent(agents.length > 0 ? options.generationFailure : undefined);
      agents.push(agent);
      return agent;
    },
  });
  const legacyAgent = {
    execute: vi.fn(async function* () { yield { type: 'response' as const, response: { operations: [] } }; }),
    cancel: vi.fn(async () => undefined),
    getStatus: vi.fn(async (runId: string) => ({ runId, state: 'RUNNING' as const })),
  } satisfies CodingAgent;
  const service = await ProjectService.open(new MemoryPersistence(), legacyAgent, undefined, providers);
  const project = await service.createProject('Provider routing QA');
  const connection = (await providers.list()).find(item => item.id === 'codex-local')!;
  await providers.verify(connection.id, { modelId: selectedRunMetadata.modelId, effort: selectedRunMetadata.effort });
  return { service, providers, connection, agents, legacyAgent, project };
}

function createText(id: string, text: string, pageId: string, index = 0): Operation {
  return {
    type: 'node.create',
    pageId,
    index,
    node: { ...createNodeBase(id, text), kind: 'text', text, textStyle: {} },
  };
}

async function waitForRunState(service: ProjectService, runId: string, state: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = service.getRun(runId).run;
    if (run.state === state) return run;
    if (['FAILED', 'CANCELLED', 'SUCCEEDED'].includes(run.state) && run.state !== state) throw new Error(`Run stopped at ${run.state} before ${state}.`);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error(`Run did not reach ${state}.`);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('provider selection through the design run lifecycle', () => {
  it('pins safe route metadata to a committed run after the connection is renamed and removed', async () => {
    const { service, providers, connection, agents, project } = await setup();
    const { runId } = await service.startRun('Create a fixture text label', [], project.document.revision, project.document.pageOrder[0], {
      connectionId: connection.id, modelId: selectedRunMetadata.modelId, effort: selectedRunMetadata.effort,
    });
    const recordAtStart = service.getRun(runId).run;
    expect(recordAtStart.providerSelection, 'accepted provider run must persist the exact safe selection snapshot').toEqual(selectedRunMetadata);
    const providerAgent = agents.at(-1)!;
    await providerAgent.started.promise;
    await providers.update(connection.id, { label: 'Renamed account' });
    providerAgent.respond([createText('provider-committed-title', 'Provider committed title', project.document.pageOrder[0]!)]);

    const rendering = await waitForRunState(service, runId, 'RENDERING');
    expect(rendering.committedRevision).toBe(1);
    expect(service.getProject()?.document.nodes['provider-committed-title']).toMatchObject({ text: 'Provider committed title' });
    await providers.delete(connection.id);
    expect(service.getRun(runId).run.providerSelection).toEqual(selectedRunMetadata);
    expect(JSON.stringify(service.getRun(runId).run.providerSelection)).not.toMatch(/credential|secretRef|secretKey/i);
    expect((await service.acknowledgeRender(runId, 1, true)).state).toBe('SUCCEEDED');
  });

  it('cancels the selected adapter before commit and leaves the design revision unchanged', async () => {
    const { service, connection, agents, legacyAgent, project } = await setup();
    const { runId } = await service.startRun('Create a label then cancel', [], project.document.revision, project.document.pageOrder[0], {
      connectionId: connection.id, modelId: selectedRunMetadata.modelId, effort: selectedRunMetadata.effort,
    });
    const providerAgent = agents.at(-1)!;
    await providerAgent.started.promise;

    const cancelled = await service.cancelRun(runId);
    expect(cancelled.state).toBe('CANCELLED');
    expect(providerAgent.cancelCalls, 'cancellation must use the run-pinned provider adapter').toBe(1);
    expect(legacyAgent.cancel).not.toHaveBeenCalled();
    expect(service.getProject()?.document.revision).toBe(0);
    expect(service.getProject()?.document.nodes).toEqual({});
  });

  it('rejects a stale provider response atomically and preserves only the intervening user edit', async () => {
    const { service, connection, agents, project } = await setup();
    const { runId } = await service.startRun('Create a provider label', [], project.document.revision, project.document.pageOrder[0], {
      connectionId: connection.id, modelId: selectedRunMetadata.modelId, effort: selectedRunMetadata.effort,
    });
    const providerAgent = agents.at(-1)!;
    await providerAgent.started.promise;
    const pageId = project.document.pageOrder[0]!;
    const manual = await service.apply({
      id: 'intervening-user-edit', documentId: project.document.id, expectedRevision: 0, source: 'toolbar',
      capabilitySet: ['node.create'], operations: [createText('manual-title', 'User edit', pageId)],
    });
    expect(manual.result.status).toBe('committed');
    providerAgent.respond([createText('stale-provider-title', 'Stale provider edit', pageId, 1)]);

    const failed = await waitForRunState(service, runId, 'FAILED');
    expect(failed.validationResults.some(issue => issue.code === 'revision.conflict')).toBe(true);
    expect(service.getProject()?.document.revision).toBe(1);
    expect(service.getProject()?.document.nodes['manual-title']).toMatchObject({ text: 'User edit' });
    expect(service.getProject()?.document.nodes['stale-provider-title']).toBeUndefined();
  });

  it('does not fall back to the legacy agent after the selected provider fails with quota', async () => {
    const { service, connection, agents, legacyAgent, project } = await setup({ generationFailure: new CodingAgentError('provider.quota', 'safe quota rejection') });
    const { runId } = await service.startRun('Create a provider label', [], project.document.revision, project.document.pageOrder[0], {
      connectionId: connection.id, modelId: selectedRunMetadata.modelId, effort: selectedRunMetadata.effort,
    });
    const providerAgent = agents.at(-1)!;
    const failed = await waitForRunState(service, runId, 'FAILED');

    expect(providerAgent.wasStarted, 'quota failure must come from the selected provider adapter').toBe(true);
    expect(failed.validationResults).toContainEqual(expect.objectContaining({ code: 'provider.quota', message: 'safe quota rejection' }));
    expect(agents.at(-1)).toBe(providerAgent);
    expect(legacyAgent.execute).not.toHaveBeenCalled();
    expect(service.getProject()?.document.revision).toBe(0);
  });
});
