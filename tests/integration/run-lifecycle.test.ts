import { describe, expect, it } from 'vitest';
import { createDocument, createNodeBase } from '../../src/domain/defaults';
import { sealEnvelope } from '../../src/application/integrity';
import type {
  CodingAgent, CodingAgentRequest, CodingAgentResponse, Operation,
  PersistedProjectEnvelope, RunEvent,
} from '../../src/domain/types';
import { ProjectService, type ProjectPersistence } from '../../src/application/project-service';

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
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

class ControlledAgent implements CodingAgent {
  readonly started = deferred<CodingAgentRequest>();
  private readonly answer = deferred<CodingAgentResponse>();
  async *execute(request: CodingAgentRequest): AsyncIterable<RunEvent | { type: 'response'; response: CodingAgentResponse }> {
    this.started.resolve(structuredClone(request));
    yield { type: 'state', runId: request.runId, state: 'RUNNING', at: new Date().toISOString() };
    yield { type: 'response', response: await this.answer.promise };
  }
  respond(operations: Operation[]): void { this.answer.resolve({ operations }); }
  async cancel(): Promise<void> { this.answer.resolve({ operations: [] }); }
  async getStatus(runId: string) { return { runId, state: 'RUNNING' as const }; }
}

async function setup() {
  const agent = new ControlledAgent();
  const service = await ProjectService.open(new MemoryPersistence(), agent);
  const created = await service.createProject('Lifecycle integration');
  const pageId = created.document.pageOrder[0]!;
  const node = { ...createNodeBase('title', 'Title'), kind: 'text' as const, text: 'Original', textStyle: {} };
  const other = { ...createNodeBase('subtitle', 'Subtitle'), kind: 'text' as const, text: 'Private sibling', textStyle: {} };
  const container = { ...createNodeBase('container', 'Container'), kind: 'frame' as const };
  const initial: Operation[] = [
    { type: 'node.create', node, pageId, index: 0 },
    { type: 'node.create', node: other, pageId, index: 1 },
    { type: 'node.create', node: container, pageId, index: 2 },
  ];
  await service.apply({ id: 'initial', documentId: created.document.id, expectedRevision: 0, source: 'toolbar', capabilitySet: ['node.create'], operations: initial });
  return { service, agent, documentId: created.document.id, pageId };
}

function setText(value: string): Operation {
  return { type: 'property.set', nodeId: 'title', change: { property: 'text', value } };
}

describe('agent run lifecycle and transaction integration', () => {
  it('rejects unadvertised creation kinds instead of declaring placeholder media ready', async () => {
    const { service, agent, pageId } = await setup();
    const before = service.getProject();
    const { runId } = await service.startRun('Create a photo', [], 1);
    await agent.started.promise;
    agent.respond([{ type: 'node.create', pageId, index: 3, node: { ...createNodeBase('photo', 'Photo'), kind: 'image', assetId: 'unavailable-photo', fit: 'cover' } }]);
    for (let tries = 0; tries < 50 && service.getRun(runId).run.state !== 'FAILED'; tries += 1) await new Promise(resolve => setTimeout(resolve, 0));
    expect(service.getRun(runId).run.state).toBe('FAILED');
    expect(service.getRun(runId).run.validationResults.some(issue => issue.code === 'agent.node-kind')).toBe(true);
    expect(service.getProject()).toEqual(before);
  });
  it('restricts an unselected run to active-page nodes and root placement even when another page ID is known', async () => {
    for (const mode of ['edit', 'create'] as const) {
      const document = createDocument('Page scope', 'page_scope_document', 'page_one');
      document.pages.page_two = { id: 'page_two', name: 'Other page', rootNodeIds: ['other_page_text'] };
      document.pageOrder.push('page_two');
      document.nodes.other_page_text = { ...createNodeBase('other_page_text', 'Other page'), kind: 'text', text: 'Preserved', textStyle: {} };
      const persistence = new MemoryPersistence();
      await persistence.saveAtomically(sealEnvelope({ formatVersion: 1, document, history: { undoableEntries: [], cursor: 0, auditTransitions: [], snapshots: [] }, appliedBatchIds: [], integrityHash: '' }), 0);
      const agent = new ControlledAgent();
      const service = await ProjectService.open(persistence, agent);
      const { runId } = await service.startRun('Edit this page', [], 0, 'page_one');
      await agent.started.promise;
      agent.respond(mode === 'edit'
        ? [{ type: 'property.set', nodeId: 'other_page_text', change: { property: 'text', value: 'Forbidden' } }]
        : [{ type: 'node.create', node: { ...createNodeBase('foreign_root', 'Foreign root'), kind: 'frame' }, pageId: 'page_two', index: 1 }]);
      for (let tries = 0; tries < 50 && service.getRun(runId).run.state !== 'FAILED'; tries += 1) await new Promise(resolve => setTimeout(resolve, 0));
      expect(service.getRun(runId).run.state).toBe('FAILED');
      expect(service.getRun(runId).run.validationResults.some(issue => issue.code === (mode === 'edit' ? 'scope.node' : 'scope.page'))).toBe(true);
      expect(service.getProject()!.document).toEqual(document);
    }
  });
  it('rejects a stale response with its revision diagnostic and preserves the intervening user edit', async () => {
    const { service, agent, documentId } = await setup();
    const { runId } = await service.startRun('Change the title', ['title'], 1);
    await agent.started.promise;

    const manual = await service.apply({ id: 'manual-edit', documentId, expectedRevision: 1, source: 'inspector', capabilitySet: ['property.set'], operations: [setText('User edit')] });
    expect(manual.result.status).toBe('committed');
    agent.respond([setText('Stale agent edit')]);

    for (let tries = 0; tries < 50 && service.getRun(runId).run.state !== 'FAILED'; tries += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    const { run } = service.getRun(runId);
    const project = service.getProject()!;
    expect(run.state).toBe('FAILED');
    expect(run.validationResults.some((item) => item.code === 'revision.conflict')).toBe(true);
    expect(project.document.revision).toBe(2);
    expect(project.document.nodes.title).toMatchObject({ text: 'User edit' });
  });

  it('rejects an out-of-scope proposal atomically', async () => {
    const { service, agent } = await setup();
    const { runId } = await service.startRun('Change the selected title', ['title'], 1);
    await agent.started.promise;
    agent.respond([setText('Would be a partial edit'), { type: 'property.set', nodeId: 'subtitle', change: { property: 'text', value: 'Unauthorized' } }]);

    for (let tries = 0; tries < 50 && service.getRun(runId).run.state !== 'FAILED'; tries += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    const { run } = service.getRun(runId);
    const project = service.getProject()!;
    expect(run.state).toBe('FAILED');
    expect(run.validationResults.some((item) => item.code === 'scope.node')).toBe(true);
    expect(project.document.revision).toBe(1);
    expect(project.document.nodes.title).toMatchObject({ text: 'Original' });
    expect(project.document.nodes.subtitle).toMatchObject({ text: 'Private sibling' });
  });

  it('allows a selected container to receive a newly composed nested subtree', async () => {
    const { service, agent, pageId } = await setup();
    const { runId } = await service.startRun('Add a nested card inside the selected container', ['container'], 1);
    await agent.started.promise;
    const group = { ...createNodeBase('new-group', 'Card'), kind: 'group' as const };
    const label = { ...createNodeBase('new-label', 'Label'), kind: 'text' as const, text: 'Card title', textStyle: {} };
    agent.respond([
      { type: 'node.create', node: group, pageId, parentId: 'container', index: 0 },
      { type: 'node.create', node: label, pageId, parentId: 'new-group', index: 0 },
    ]);

    for (let tries = 0; tries < 50 && !['RENDERING', 'FAILED'].includes(service.getRun(runId).run.state); tries += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    const run = service.getRun(runId).run;
    expect(run.state).toBe('RENDERING');
    expect(service.getProject()!.document.nodes['new-group']?.childIds).toEqual(['new-label']);
  });

  it('keeps a committed run linked to its durable history entry and proceeds through render QA', async () => {
    const { service, agent } = await setup();
    const { runId } = await service.startRun('Change the title', ['title'], 1);
    await agent.started.promise;
    agent.respond([setText('Agent edit')]);

    for (let tries = 0; tries < 50 && service.getRun(runId).run.state !== 'RENDERING'; tries += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    const beforeRender = service.getRun(runId).run;
    expect(beforeRender.state).toBe('RENDERING');
    expect(beforeRender.committedRevision).toBe(2);
    const project = service.getProject()!;
    expect(project.history.undoableEntries.at(-1)?.runId).toBe(runId);
    expect(project.history.auditTransitions.at(-1)?.batchId).toBe(beforeRender.batchId);

    const afterRender = await service.acknowledgeRender(runId, 2, true);
    expect(afterRender.state).toBe('SUCCEEDED');
    expect(afterRender.qaResults.some((item) => item.severity === 'error')).toBe(false);
    expect(afterRender.qaResults).toContainEqual(expect.objectContaining({ code: 'design-system.literal-spacing', severity: 'warning' }));
  });

  it('does not undo or relabel a commit when cancellation arrives after commit', async () => {
    const { service, agent } = await setup();
    const { runId } = await service.startRun('Change the title', ['title'], 1);
    await agent.started.promise;
    agent.respond([setText('Committed edit')]);
    for (let tries = 0; tries < 50 && service.getRun(runId).run.state !== 'RENDERING'; tries += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    const cancelled = await service.cancelRun(runId);
    expect(cancelled.state).toBe('RENDERING');
    expect(cancelled.committedRevision).toBe(2);
    expect(service.getProject()!.document.nodes.title).toMatchObject({ text: 'Committed edit' });
    expect((await service.acknowledgeRender(runId, 2, true)).state).toBe('SUCCEEDED');
  });

  it('cancels before commit without changing the document', async () => {
    const { service, agent } = await setup();
    const { runId } = await service.startRun('Change the title', ['title'], 1);
    await agent.started.promise;
    const cancelled = await service.cancelRun(runId);
    expect(cancelled.state).toBe('CANCELLED');
    expect(service.getProject()!.document.revision).toBe(1);
    expect(service.getProject()!.document.nodes.title).toMatchObject({ text: 'Original' });
  });
  it('preserves the committed revision when the renderer reports failure', async () => {
    const { service, agent } = await setup();
    const { runId } = await service.startRun('Change the title', ['title'], 1);
    await agent.started.promise;
    agent.respond([setText('Saved despite rendering failure')]);
    for (let tries = 0; tries < 50 && service.getRun(runId).run.state !== 'RENDERING'; tries += 1) await new Promise(resolve => setTimeout(resolve, 0));
    const saved = service.getProject()!;
    const record = await service.acknowledgeRender(runId, 2, false, 'Canvas component failed');
    expect(record.state).toBe('FAILED');
    expect(record.committedRevision).toBe(2);
    expect(record.validationResults.some(issue => issue.code === 'render.failed')).toBe(true);
    expect(service.getProject()).toEqual(saved);
    expect(service.getProject()!.document.nodes.title).toMatchObject({ text: 'Saved despite rendering failure' });
  });
});
