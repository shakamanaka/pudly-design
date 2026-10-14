import { describe, expect, it } from 'vitest';
import { ProjectService, type ProjectPersistence } from '../../src/application/project-service';
import { createNodeBase } from '../../src/domain/defaults';
import type {
  CodingAgent, CodingAgentRequest, CodingAgentResponse, Operation,
  PersistedProjectEnvelope, RunEvent,
} from '../../src/domain/types';

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

class SequenceAgent implements CodingAgent {
  readonly requests: CodingAgentRequest[] = [];
  readonly cancelledRunIds: string[] = [];
  private readonly responses: Array<CodingAgentResponse | Promise<CodingAgentResponse> | ((request: CodingAgentRequest) => CodingAgentResponse)>;
  private releasePending: (() => void) | undefined;

  constructor(responses: Array<CodingAgentResponse | Promise<CodingAgentResponse> | ((request: CodingAgentRequest) => CodingAgentResponse)>) { this.responses = responses; }

  async *execute(request: CodingAgentRequest): AsyncIterable<RunEvent | { type: 'response'; response: CodingAgentResponse }> {
    this.requests.push(structuredClone(request));
    const configured = this.responses[this.requests.length - 1];
    if (!configured) throw new Error('No QA response configured for this attempt.');
    const response = typeof configured === 'function' ? configured(request) : configured;
    if (response instanceof Promise) {
      this.releasePending = () => undefined;
      const resolved = await response;
      yield { type: 'progress', runId: request.runId, phase: 'RUNNING', message: 'QA fixture response ready.' };
      yield { type: 'response', response: resolved };
    } else {
      yield { type: 'progress', runId: request.runId, phase: 'RUNNING', message: 'QA fixture response ready.' };
      yield { type: 'response', response };
    }
  }

  async cancel(runId?: string): Promise<void> { if (runId) this.cancelledRunIds.push(runId); this.releasePending?.(); }
  async getStatus(runId: string) { return { runId, state: 'RUNNING' as const }; }
}

function pageProposal(pageId: string): Operation[] {
  const root = { ...createNodeBase('page-root', 'Page'), kind: 'frame' as const };
  root.layout.width = { kind: 'fill' };
  const sections = ['navigation', 'hero', 'catalog', 'footer'];
  const operations: Operation[] = [{ type: 'node.create', node: root, pageId, index: 0 }];
  sections.forEach((id, index) => operations.push({
    type: 'node.create', node: { ...createNodeBase(id, id), kind: 'frame' }, pageId, parentId: 'page-root', index,
  }));
  const copy = [
    ['brand', 'Paws & Co', 'navigation', 24], ['nav-shop', 'Shop', 'navigation', 16],
    ['hero-heading', 'A happier walk starts here', 'hero', 40], ['hero-copy', 'Everyday gear made for curious dogs.', 'hero', 18],
    ['catalog-heading', 'Find their new favorite', 'catalog', 28], ['catalog-copy', 'Comfortable collars and leads.', 'catalog', 16],
    ['trust-copy', 'Loved by dogs and their people.', 'footer', 16], ['footer-copy', 'Thoughtful essentials for every walk.', 'footer', 14],
  ] as const;
  for (const [id, text, parentId, size] of copy) operations.push({
    type: 'node.create', node: { ...createNodeBase(id, id), kind: 'text', text, textStyle: { fontSize: { kind: 'literal', value: size, unit: 'px' }, weight: size >= 24 ? 700 : 400 } },
    pageId, parentId, index: operations.filter(operation => operation.type === 'node.create' && operation.parentId === parentId).length,
  });
  const heroArt = {
    ...createNodeBase('hero-art', 'Puppy illustration'), kind: 'vector' as const,
    pathData: 'M 5 40 C 20 10 30 10 40 35 L 55 20 L 75 35 L 90 55 L 70 75 L 35 80 Z', viewBox: [0, 0, 100, 100] as [number, number, number, number],
  };
  heroArt.layout.width = { kind: 'fixed', value: { kind: 'literal', value: 240, unit: 'px' } };
  heroArt.layout.height = { kind: 'fill' };
  operations.push({
    type: 'node.create', node: {
      ...heroArt,
    }, pageId, parentId: 'hero', index: 2,
  });
  return operations;
}

function skeletonProposal(pageId: string): Operation[] {
  const frame = { ...createNodeBase('draft-card', 'Card'), kind: 'frame' as const };
  const label = { ...createNodeBase('draft-label', 'Label'), kind: 'text' as const, text: 'Puppy shop', textStyle: {} };
  return [
    { type: 'node.create', node: frame, pageId, index: 0 },
    { type: 'node.create', node: label, pageId, parentId: frame.id, index: 0 },
  ];
}

function waitForState(service: ProjectService, runId: string, accepted: string[]): Promise<void> {
  return (async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (accepted.includes(service.getRun(runId).run.state)) return;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    throw new Error(`Run did not reach ${accepted.join(' or ')}.`);
  })();
}

async function createService(agent: CodingAgent) {
  const service = await ProjectService.open(new MemoryPersistence(), agent);
  const project = await service.createProject('Composition QA');
  return { service, document: project.document };
}

describe('precommit composition repair integration', () => {
  it('repairs a text-only puppy-shop skeleton once and commits only the complete proposal', async () => {
    const agent = new SequenceAgent([
      request => ({ operations: skeletonProposal(request.documentFragment.page!.id) }),
      request => ({ operations: pageProposal(request.documentFragment.page!.id) }),
    ]);
    const { service, document } = await createService(agent);
    const pageId = document.pageOrder[0]!;
    const { runId } = await service.startRun('Build a simple puppy shop page', [], 0);
    await waitForState(service, runId, ['RENDERING', 'FAILED']);

    const run = service.getRun(runId).run;
    const project = service.getProject()!;
    expect(agent.requests).toHaveLength(2);
    expect(agent.requests[1]?.runId).toBe(`${runId}-repair`);
    expect(agent.requests[1]?.prompt).toContain('Composition repair feedback:');
    expect(run.state).toBe('RENDERING');
    expect(run.operations).toEqual(pageProposal(pageId));
    expect(project.document.revision).toBe(1);
    expect(project.history.undoableEntries).toHaveLength(1);
    expect(project.history.undoableEntries[0]?.operations).toEqual(pageProposal(pageId));
    expect(project.document.nodes['hero-art']?.kind).toBe('vector');
    expect(service.getRun(runId).events.every(event => event.runId === runId)).toBe(true);
  });

  it('fails after one incomplete repair and preserves the original document and history', async () => {
    const agent = new SequenceAgent([
      request => ({ operations: skeletonProposal(request.documentFragment.page!.id) }),
      request => ({ operations: skeletonProposal(request.documentFragment.page!.id) }),
    ]);
    const { service: configuredService } = await createService(agent);
    const before = configuredService.getProject()!;
    const { runId } = await configuredService.startRun('Build a simple puppy shop page', [], 0);
    await waitForState(configuredService, runId, ['FAILED', 'RENDERING']);

    const run = configuredService.getRun(runId).run;
    expect(agent.requests).toHaveLength(2);
    expect(run.state).toBe('FAILED');
    expect(run.validationResults.some(issue => issue.code === 'quality.incomplete')).toBe(true);
    expect(run.qaResults.map(issue => issue.code)).toContain('quality.visual-content');
    expect(configuredService.getProject()).toEqual(before);
  });

  it('keeps the user edit and rejects a repair response based on a stale revision', async () => {
    let releaseRepair!: (response: CodingAgentResponse) => void;
    const repair = new Promise<CodingAgentResponse>(resolve => { releaseRepair = resolve; });
    const agent = new SequenceAgent([request => ({ operations: skeletonProposal(request.documentFragment.page!.id) }), repair]);
    const { service, document } = await createService(agent);
    const pageId = document.pageOrder[0]!;
    const { runId } = await service.startRun('Build a simple puppy shop page', [], 0);
    for (let attempt = 0; attempt < 100 && agent.requests.length < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0));
    expect(agent.requests).toHaveLength(2);

    const manual = await service.apply({
      id: 'manual-during-repair', documentId: document.id, expectedRevision: 0, source: 'toolbar',
      capabilitySet: ['node.create'], operations: [{ type: 'node.create', node: { ...createNodeBase('user-note', 'User note'), kind: 'text', text: 'Keep this edit', textStyle: {} }, pageId, index: 0 }],
    });
    expect(manual.result.status).toBe('committed');
    releaseRepair({ operations: pageProposal(pageId) });
    await waitForState(service, runId, ['FAILED', 'RENDERING']);

    expect(service.getRun(runId).run.state).toBe('FAILED');
    expect(service.getRun(runId).run.validationResults.some(issue => issue.code === 'revision.conflict')).toBe(true);
    expect(service.getProject()!.document.revision).toBe(1);
    expect(service.getProject()!.document.nodes['user-note']).toMatchObject({ text: 'Keep this edit' });
    expect(service.getProject()!.document.nodes['page-root']).toBeUndefined();
  });

  it('cancels during the repair attempt without committing either proposal', async () => {
    let releaseRepair!: (response: CodingAgentResponse) => void;
    const repair = new Promise<CodingAgentResponse>(resolve => { releaseRepair = resolve; });
    const agent = new SequenceAgent([request => ({ operations: skeletonProposal(request.documentFragment.page!.id) }), repair]);
    const { service, document } = await createService(agent);
    const { runId } = await service.startRun('Build a simple puppy shop page', [], 0);
    for (let attempt = 0; attempt < 100 && agent.requests.length < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0));
    expect(agent.requests).toHaveLength(2);

    const cancelled = await service.cancelRun(runId);
    releaseRepair({ operations: pageProposal(document.pageOrder[0]!) });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(cancelled.state).toBe('CANCELLED');
    expect(service.getRun(runId).run.state).toBe('CANCELLED');
    expect(agent.cancelledRunIds).toEqual([`${runId}-repair`]);
    expect(service.getProject()!.document.revision).toBe(0);
    expect(service.getProject()!.history.undoableEntries).toEqual([]);
  });
});
