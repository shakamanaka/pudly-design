import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectService, type ProjectPersistence } from '../../src/application/project-service.js';
import { LocalDesignPersistence } from '../../src/adapters/persistence/local-files.js';
import { createNodeBase } from '../../src/domain/defaults.js';
import type { CodingAgent, PersistedProjectEnvelope } from '../../src/domain/index.js';

const directories: string[] = [];
const noAgent: CodingAgent = {
  async *execute() { /* These tests exercise explicit operations only. */ },
  async cancel() {},
  async getStatus(runId) { return { runId, state: 'FAILED' }; },
};

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'codex-design-history-'));
  directories.push(directory);
  const persistence = new LocalDesignPersistence(directory);
  const service = await ProjectService.open(persistence, noAgent);
  const project = await service.createProject('Persistence test');
  const frame = { ...createNodeBase('frame_1', 'Frame'), kind: 'frame' as const };
  const created = await service.apply({
    id: 'create-frame', documentId: project.document.id, expectedRevision: 0, source: 'inspector',
    capabilitySet: ['node.create'], operations: [{ type: 'node.create', node: frame, pageId: project.document.pageOrder[0], index: 0 }],
  });
  expect(created.result.status).toBe('committed');
  return { directory, persistence, service, project: created.project };
}

function renameBatch(project: PersistedProjectEnvelope, id: string, name: string, expectedRevision = project.document.revision) {
  return {
    id, documentId: project.document.id, expectedRevision, source: 'inspector', capabilitySet: ['property.set'],
    operations: [{ type: 'property.set', nodeId: 'frame_1', change: { property: 'name', value: name } }],
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('history and durable project persistence', () => {
  it('preserves corrupt and unknown-future-version files during recovery', async () => {
    for (const future of [false, true]) {
      const { directory, project } = await setup();
      const path = join(directory, `${project.document.id}.json`);
      const bytes = future ? JSON.stringify({ ...project, formatVersion: 99 }) : '{ damaged project';
      await writeFile(path, bytes);
      const reopened = await ProjectService.open(new LocalDesignPersistence(directory), noAgent);
      expect(() => reopened.getProject()).toThrow('saved project could not be reopened');
      expect(await readFile(path, 'utf8')).toBe(bytes);
      await reopened.createProject('Recovered workspace');
      expect(await readFile(path, 'utf8')).toBe(bytes);
    }
  });
  it('persists undo, redo, and a new edit as monotonic audited revisions', async () => {
    const { directory, service, project } = await setup();
    const edit = await service.apply(renameBatch(project, 'rename-one', 'Renamed'));
    expect(edit.result.status).toBe('committed');
    const undone = await service.undo(2);
    expect(undone.document.revision).toBe(3);
    expect(undone.document.nodes.frame_1?.name).toBe('Frame');
    const redone = await service.redo(3);
    expect(redone.document.revision).toBe(4);
    expect(redone.document.nodes.frame_1?.name).toBe('Renamed');
    await service.undo(4);
    const branched = await service.apply(renameBatch(service.getProject()!, 'rename-branch', 'Branch'));
    expect(branched.project.document.revision).toBe(6);
    expect(branched.project.history.cursor).toBe(branched.project.history.undoableEntries.length);
    expect(branched.project.history.auditTransitions.map((event) => event.toRevision)).toEqual([1, 2, 3, 4, 5, 6]);

    const reopened = await ProjectService.open(new LocalDesignPersistence(directory), noAgent);
    const saved = reopened.getProject()!;
    expect(saved.document.nodes.frame_1?.name).toBe('Branch');
    expect(saved.history.auditTransitions).toEqual(branched.project.history.auditTransitions);
    expect((await reopened.apply(renameBatch(saved, 'rename-one', 'Replay'))).result).toMatchObject({ status: 'rejected', diagnostics: [{ code: 'batch.duplicate' }] });
  });

  it('linearizes concurrent same-revision commits and rejects the stale contender', async () => {
    const { service, project } = await setup();
    const [left, right] = await Promise.all([
      service.apply(renameBatch(project, 'concurrent-left', 'Left')),
      service.apply(renameBatch(project, 'concurrent-right', 'Right')),
    ]);
    const outcomes = [left.result, right.result];
    expect(outcomes.filter((result) => result.status === 'committed')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected' && result.diagnostics[0]?.code === 'revision.conflict')).toHaveLength(1);
    expect(service.getProject()?.document.revision).toBe(2);
    expect(service.getProject()?.history.undoableEntries).toHaveLength(2);
  });

  it('detaches queued operation input before waiting behind an active save', async () => {
    const { persistence, project } = await setup();
    let releaseFirstSave!: () => void;
    let signalFirstSave!: () => void;
    const firstSaveEntered = new Promise<void>((resolve) => { signalFirstSave = resolve; });
    const firstSaveGate = new Promise<void>((resolve) => { releaseFirstSave = resolve; });
    let pause = true;
    const gatedPersistence: ProjectPersistence = {
      load: (id) => persistence.load(id),
      loadCurrent: () => persistence.loadCurrent(),
      select: (id) => persistence.select(id),
      saveAtomically: async (envelope, expectedRevision) => {
        if (pause && envelope.document.revision === 2) {
          pause = false;
          signalFirstSave();
          await firstSaveGate;
        }
        return persistence.saveAtomically(envelope, expectedRevision);
      },
    };
    const service = await ProjectService.open(gatedPersistence, noAgent);
    const first = service.apply(renameBatch(project, 'first-queued-test', 'First', 1));
    await firstSaveEntered;
    const queuedBatch = renameBatch(project, 'second-queued-test', 'Captured input', 2);
    const queued = service.apply(queuedBatch);
    (queuedBatch.operations[0] as { change: { value: string } }).change.value = 'Caller mutation';
    releaseFirstSave();
    await first;
    const second = await queued;
    expect(second.result.status).toBe('committed');
    expect(second.project.document.nodes.frame_1?.name).toBe('Captured input');
  });

  it('keeps the last durable envelope and in-memory project when a save fails', async () => {
    const { directory, project, persistence } = await setup();
    let failNextSave = false;
    const failingPersistence: ProjectPersistence = {
      load: (id) => persistence.load(id),
      loadCurrent: () => persistence.loadCurrent(),
      select: (id) => persistence.select(id),
      saveAtomically: async (envelope, expectedRevision) => {
        if (failNextSave) { failNextSave = false; throw new Error('simulated disk failure'); }
        return persistence.saveAtomically(envelope, expectedRevision);
      },
    };
    const failingService = await ProjectService.open(failingPersistence, noAgent);
    failNextSave = true;
    await expect(failingService.apply(renameBatch(project, 'save-fails', 'Uncommitted'))).rejects.toThrow('simulated disk failure');
    expect(failingService.getProject()?.document.revision).toBe(1);
    expect(failingService.getProject()?.document.nodes.frame_1?.name).toBe('Frame');
    const reopened = await ProjectService.open(new LocalDesignPersistence(directory), noAgent);
    expect(reopened.getProject()?.document.revision).toBe(1);
    expect(reopened.getProject()?.history.undoableEntries).toHaveLength(1);
    expect(reopened.getProject()?.appliedBatchIds).not.toContain('save-fails');
  });

});
