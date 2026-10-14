import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeBase } from '../../src/domain/defaults';
import type { AgentRunRecord, AgentRunStore, CodingAgent, CodingAgentRequest, CodingAgentResponse, Operation, PersistedProjectEnvelope, RunEvent } from '../../src/domain/types';
import { LocalAgentRunStore } from '../../src/adapters/persistence/local-run-store';
import { ProjectService, type ProjectPersistence } from '../../src/application/project-service';
import { validateAgentRunRecord } from '../../src/domain/run-record';

const filesystemFault = vi.hoisted(() => ({ directory: '', directorySyncFailures: 0 }));
vi.mock('../../src/adapters/persistence/persistence-fs.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/adapters/persistence/persistence-fs.js')>();
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const path = String(args[0]);
      const handle = await actual.open(...args);
      if (path !== filesystemFault.directory || args[1] !== 'r') return handle;
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === 'sync') return async () => {
            if (filesystemFault.directorySyncFailures > 0) {
              filesystemFault.directorySyncFailures -= 1;
              throw Object.assign(new Error('injected directory fsync failure'), { code: 'EIO' });
            }
            return target.sync();
          };
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }),
  };
});

class ProjectMemory implements ProjectPersistence {
  saved: PersistedProjectEnvelope | null = null;
  async loadCurrent(): Promise<PersistedProjectEnvelope | null> { return structuredClone(this.saved); }
  async load(): Promise<PersistedProjectEnvelope | null> { return structuredClone(this.saved); }
  async select(): Promise<void> {}
  async saveAtomically(project: PersistedProjectEnvelope, expectedRevision: number): Promise<{ savedRevision: number }> {
    if ((this.saved?.document.revision ?? 0) !== expectedRevision) throw new Error('revision conflict');
    this.saved = structuredClone(project);
    return { savedRevision: project.document.revision };
  }
}

class AnswerAgent implements CodingAgent {
  called = 0;
  constructor(private readonly operations: Operation[]) {}
  async *execute(request: CodingAgentRequest): AsyncIterable<RunEvent | { type: 'response'; response: CodingAgentResponse }> {
    this.called += 1;
    yield { type: 'response', response: { operations: structuredClone(this.operations) } };
    void request;
  }
  async cancel(): Promise<void> {}
  async getStatus(runId: string) { return { runId, state: 'RUNNING' as const }; }
}

class FailingSuccessStore implements AgentRunStore {
  readonly records = new Map<string, AgentRunRecord>();
  async loadAll(): Promise<AgentRunRecord[]> { return [...this.records.values()].map(value => structuredClone(value)); }
  async save(record: AgentRunRecord): Promise<void> {
    if (record.state === 'SUCCEEDED') throw new Error('simulated durable-store outage');
    this.records.set(record.id, structuredClone(record));
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
class BlockingRunStore implements AgentRunStore {
  readonly records = new Map<string, AgentRunRecord>();
  readonly entered = deferred();
  readonly release = deferred();
  private blocked = false;
  constructor(private readonly blockState: AgentRunRecord['state']) {}
  async loadAll(): Promise<AgentRunRecord[]> { return [...this.records.values()].map(value => structuredClone(value)); }
  async save(record: AgentRunRecord): Promise<void> {
    if (record.state === this.blockState && !this.blocked) { this.blocked = true; this.entered.resolve(); await this.release.promise; }
    this.records.set(record.id, structuredClone(record));
  }
}

class DirectorySyncFailureStore implements AgentRunStore {
  private readonly store: LocalAgentRunStore;
  constructor(private readonly directory: string) { this.store = new LocalAgentRunStore(directory); }
  loadAll(): Promise<AgentRunRecord[]> { return this.store.loadAll(); }
  save(record: AgentRunRecord): Promise<void> {
    if (record.state === 'SUCCEEDED') {
      filesystemFault.directory = this.directory;
      filesystemFault.directorySyncFailures = 1;
    }
    return this.store.save(record);
  }
}

async function fixture(failTerminalSync = false) {
  const persistence = new ProjectMemory();
  const storeDirectory = await mkdtemp(join(tmpdir(), 'codex-design-run-store-'));
  const store: AgentRunStore = failTerminalSync ? new DirectorySyncFailureStore(storeDirectory) : new LocalAgentRunStore(storeDirectory);
  const agent = new AnswerAgent([changeTitle('Persisted title')]);
  const service = await ProjectService.open(persistence, agent, store);
  const project = await service.createProject('Run persistence');
  const pageId = project.document.pageOrder[0]!;
  const node = { ...createNodeBase('title', 'Title'), kind: 'text' as const, text: 'Initial', textStyle: {} };
  await service.apply({ id: 'seed-title', documentId: project.document.id, expectedRevision: 0, source: 'toolbar', capabilitySet: ['node.create'], operations: [{ type: 'node.create', node, pageId, index: 0 }] });
  return { persistence, store, storeDirectory, service, projectId: project.document.id };
}

const changeTitle = (text: string): Operation => ({ type: 'property.set', nodeId: 'title', change: { property: 'text', value: text } });
async function until(service: ProjectService, runId: string, states: string[]): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!states.includes(service.getRun(runId).run.state) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  expect(states).toContain(service.getRun(runId).run.state);
}
afterEach(() => { filesystemFault.directory = ''; filesystemFault.directorySyncFailures = 0; });

describe('durable agent run records', () => {
  it('keeps the authoritative design editable when corrupt optional run metadata blocks generation', async () => {
    const { service, persistence, storeDirectory } = await fixture();
    const { runId } = await service.startRun('Change title', ['title'], 1);
    await until(service, runId, ['RENDERING', 'FAILED']);
    await service.acknowledgeRender(runId, 2, true);
    const before = service.getProject()!;
    const path = join(storeDirectory, `${runId}.json`);
    const corruptBytes = '{ corrupted generation metadata';
    await writeFile(path, corruptBytes);
    const agent = new AnswerAgent([]);
    const reopened = await ProjectService.open(persistence, agent, new LocalAgentRunStore(storeDirectory));
    expect(reopened.getProject()).toEqual(before);
    expect(() => reopened.listRuns()).toThrow('generation is disabled');
    await expect(reopened.startRun('Retry', ['title'], 2)).rejects.toMatchObject({ code: 'run.recovery' });
    const outcome = await reopened.apply({ id: 'manual-recovery-edit', documentId: before.document.id, expectedRevision: 2, source: 'inspector', capabilitySet: ['property.set'], operations: [{ type: 'property.set', nodeId: 'title', change: { property: 'text', value: 'Still editable' } }] });
    expect(outcome.result.status).toBe('committed');
    expect(reopened.getProject()!.document.nodes.title).toMatchObject({ text: 'Still editable' });
    expect(agent.called).toBe(0);
    expect(await readFile(path, 'utf8')).toBe(corruptBytes);
    await rm(storeDirectory, { recursive: true, force: true });
  });
  it('persists bounded versioned run data with fragment and design-system context, and strictly rejects unknown schema fields', async () => {
    const { service, store, storeDirectory } = await fixture();
    const { runId } = await service.startRun('Update title', ['title'], 1);
    await until(service, runId, ['FAILED', 'RENDERING']);
    const record = (await store.loadAll()).find(item => item.id === runId)!;
    expect(record.documentFragment?.nodes.title).toMatchObject({ text: 'Initial' });
    expect(record.designSystemContext?.policy.rules['literal-color']).toBe('warning');
    expect(record.designSystemContext?.catalog.button?.semanticRole).toBe('action');
    const stored = JSON.parse(await readFile(join(storeDirectory, `${runId}.json`), 'utf8')) as Record<string, unknown>;
    expect(stored.formatVersion).toBe(1);
    expect(await store.loadAll()).toHaveLength(1);
    stored.unrecognized = true;
    await writeFile(join(storeDirectory, `${runId}.json`), JSON.stringify(stored));
    await expect(store.loadAll()).rejects.toMatchObject({ code: 'run-store.version' });
    await rm(storeDirectory, { recursive: true, force: true });
  });

  it('reopens a terminal successful record without losing its scoped context', async () => {
    const { persistence, store, storeDirectory, service } = await fixture();
    const { runId } = await service.startRun('Change title', ['title'], 1);
    await until(service, runId, ['RENDERING', 'FAILED']);
    expect((await service.acknowledgeRender(runId, 2, true)).state).toBe('SUCCEEDED');
    const reopened = await ProjectService.open(persistence, new AnswerAgent([]), new LocalAgentRunStore(storeDirectory));
    const record = reopened.getRun(runId).run;
    expect(record.state).toBe('SUCCEEDED');
    expect(record.documentFragment?.nodes.title).toMatchObject({ text: 'Initial' });
    expect(record.designSystemContext?.catalog.card?.semanticRole).toBe('content-container');
    expect(reopened.listRuns().map(item => item.id)).toContain(runId);
    expect((await store.loadAll()).find(item => item.id === runId)?.state).toBe('SUCCEEDED');
    await rm(storeDirectory, { recursive: true, force: true });
  });

  it('reopens terminal metadata and recovers an interrupted committed run through history linkage without rerunning', async () => {
    const { persistence, store, storeDirectory, service, projectId } = await fixture();
    const { runId } = await service.startRun('Change title', ['title'], 1);
    await until(service, runId, ['RENDERING', 'FAILED']);
    expect(service.getRun(runId).run.state).toBe('RENDERING');
    const committed = service.getRun(runId).run;
    const interrupted = structuredClone(committed);
    interrupted.state = 'APPLYING';
    delete interrupted.committedRevision;
    delete interrupted.finishedAt;
    await store.save(interrupted);

    const restartedAgent = new AnswerAgent([changeTitle('Must never run')]);
    const reopened = await ProjectService.open(persistence, restartedAgent, new LocalAgentRunStore(storeDirectory));
    const recovered = reopened.getRun(runId).run;
    expect(recovered.state).toBe('FAILED');
    expect(recovered.committedRevision).toBe(2);
    expect(recovered.validationResults.some(item => item.code === 'run.interrupted')).toBe(true);
    expect(reopened.listRuns().map(item => item.id)).toContain(runId);
    expect(reopened.getProject()!.document.id).toBe(projectId);
    expect(restartedAgent.called).toBe(0);
    const persisted = (await store.loadAll()).find(item => item.id === runId)!;
    expect(persisted.state).toBe('FAILED');
    expect(persisted.committedRevision).toBe(2);
    await rm(storeDirectory, { recursive: true, force: true });
  });

  it('does not publish SUCCEEDED when the terminal record cannot be durably saved', async () => {
    const persistence = new ProjectMemory();
    const store = new FailingSuccessStore();
    const agent = new AnswerAgent([changeTitle('Saved edit')]);
    const service = await ProjectService.open(persistence, agent, store);
    const project = await service.createProject('Terminal store failure');
    const pageId = project.document.pageOrder[0]!;
    const node = { ...createNodeBase('title', 'Title'), kind: 'text' as const, text: 'Initial', textStyle: {} };
    await service.apply({ id: 'seed', documentId: project.document.id, expectedRevision: 0, source: 'toolbar', capabilitySet: ['node.create'], operations: [{ type: 'node.create', node, pageId, index: 0 }] });
    const { runId } = await service.startRun('Change title', ['title'], 1);
    await until(service, runId, ['RENDERING', 'FAILED']);
    const result = await service.acknowledgeRender(runId, 2, true);
    expect(result.state).toBe('FAILED');
    expect(result.committedRevision).toBe(2);
    expect(result.validationResults.some(item => item.code === 'run.store-save')).toBe(true);
    expect(store.records.get(runId)?.state).toBe('FAILED');
    expect(service.getProject()!.document.nodes.title).toMatchObject({ text: 'Saved edit' });
  });

  it('restores the previous record bytes when directory fsync fails after rename', async () => {
    const { service, store, storeDirectory } = await fixture();
    const { runId } = await service.startRun('Change title', ['title'], 1);
    await until(service, runId, ['RENDERING', 'FAILED']);
    const before = (await store.loadAll()).find(item => item.id === runId)!;
    expect(before.state).toBe('RENDERING');
    filesystemFault.directory = storeDirectory;
    filesystemFault.directorySyncFailures = 1;
    await expect(store.save({ ...before, state: 'SUCCEEDED', finishedAt: new Date().toISOString() })).rejects.toMatchObject({ code: 'run-store.write' });
    const after = (await store.loadAll()).find(item => item.id === runId)!;
    expect(after).toEqual(before);
    await rm(storeDirectory, { recursive: true, force: true });
  });

  it('marks the run store indeterminate when rollback fsync also fails and refuses to report success on reopen', async () => {
    const { service, store, storeDirectory } = await fixture();
    const { runId } = await service.startRun('Change title', ['title'], 1);
    await until(service, runId, ['RENDERING', 'FAILED']);
    const before = (await store.loadAll()).find(item => item.id === runId)!;
    filesystemFault.directory = storeDirectory;
    filesystemFault.directorySyncFailures = 2;
    await expect(store.save({ ...before, state: 'SUCCEEDED', finishedAt: new Date().toISOString() })).rejects.toMatchObject({ code: 'run-store.indeterminate' });
    await expect(store.loadAll()).rejects.toMatchObject({ code: 'run-store.indeterminate' });
    await rm(storeDirectory, { recursive: true, force: true });
  });

  it('records failure after terminal fsync failure so a restart cannot report false SUCCEEDED', async () => {
    const { persistence, store, storeDirectory, service } = await fixture(true);
    filesystemFault.directory = storeDirectory;
    const { runId } = await service.startRun('Change title', ['title'], 1);
    await until(service, runId, ['RENDERING', 'FAILED']);
    const result = await service.acknowledgeRender(runId, 2, true);
    expect(result.state).toBe('FAILED');
    expect(result.committedRevision).toBe(2);
    expect(result.validationResults.some(item => item.code === 'run.store-save')).toBe(true);
    expect((await store.loadAll()).find(item => item.id === runId)?.state).toBe('FAILED');

    const reopened = await ProjectService.open(persistence, new AnswerAgent([]), new LocalAgentRunStore(storeDirectory));
    expect(reopened.getRun(runId).run.state).toBe('FAILED');
    expect(reopened.getRun(runId).run.committedRevision).toBe(2);
    await rm(storeDirectory, { recursive: true, force: true });
  });

  it('fails closed when persisted nested run fields have primitive shapes', async () => {
    const { service, store, storeDirectory } = await fixture();
    const { runId } = await service.startRun('Change title', ['title'], 1);
    await until(service, runId, ['RENDERING', 'FAILED']);
    const good = (await store.loadAll()).find(item => item.id === runId)!;
    const malformed: unknown[] = [];
    malformed.push({ ...good, validationResults: [null] });
    malformed.push({ ...good, resolvedContext: [42] });
    malformed.push({ ...good, documentFragment: null });
    malformed.push({ ...good, designSystemContext: { ...good.designSystemContext, policy: null } });
    malformed.push({ ...good, startedAt: undefined });
    malformed.push({ ...good, documentFragment: { ...good.documentFragment, page: 42 } });
    malformed.push({ ...good, designSystemContext: { ...good.designSystemContext, catalog: { button: null } } });
    for (const record of malformed) expect(validateAgentRunRecord(record).ok).toBe(false);
    await rm(storeDirectory, { recursive: true, force: true });
  });

  it('serializes start reservations so concurrent callers cannot both pass the busy check', async () => {
    const persistence = new ProjectMemory();
    const store = new BlockingRunStore('QUEUED');
    const agent = new AnswerAgent([changeTitle('one edit')]);
    const service = await ProjectService.open(persistence, agent, store);
    const project = await service.createProject('Concurrent start');
    const pageId = project.document.pageOrder[0]!;
    const node = { ...createNodeBase('title', 'Title'), kind: 'text' as const, text: 'Initial', textStyle: {} };
    await service.apply({ id: 'seed', documentId: project.document.id, expectedRevision: 0, source: 'toolbar', capabilitySet: ['node.create'], operations: [{ type: 'node.create', node, pageId, index: 0 }] });
    const first = service.startRun('First', ['title'], 1);
    await store.entered.promise;
    const second = service.startRun('Second', ['title'], 1);
    store.release.resolve();
    const started = await first;
    await expect(second).rejects.toMatchObject({ code: 'run.busy' });
    expect(service.listRuns().map(record => record.id)).toContain(started.runId);
    for (let i = 0; i < 100 && agent.called === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
    expect(agent.called).toBe(1);
  });

  it('serializes cancel after an in-flight RUNNING save and never starts the agent afterward', async () => {
    const persistence = new ProjectMemory();
    const store = new BlockingRunStore('RUNNING');
    const agent = new AnswerAgent([changeTitle('must not apply')]);
    const service = await ProjectService.open(persistence, agent, store);
    const project = await service.createProject('Cancel while saving');
    const pageId = project.document.pageOrder[0]!;
    const node = { ...createNodeBase('title', 'Title'), kind: 'text' as const, text: 'Initial', textStyle: {} };
    await service.apply({ id: 'seed', documentId: project.document.id, expectedRevision: 0, source: 'toolbar', capabilitySet: ['node.create'], operations: [{ type: 'node.create', node, pageId, index: 0 }] });
    const { runId } = await service.startRun('Cancel me', ['title'], 1);
    await store.entered.promise;
    const cancel = service.cancelRun(runId);
    store.release.resolve();
    const result = await cancel;
    expect(result.state).toBe('CANCELLED');
    expect(agent.called).toBe(0);
    expect(service.getProject()!.document.revision).toBe(1);
  });
});
