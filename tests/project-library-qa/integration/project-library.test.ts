import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalDesignPersistence } from '../../../src/adapters/persistence/local-files.js';
import { ProjectService, type ProjectPersistence } from '../../../src/application/project-service.js';
import type { ProjectLibrary } from '../../../src/application/project-library.js';
import { createNodeBase } from '../../../src/domain/defaults.js';
import type { CodingAgent, PersistedProjectEnvelope } from '../../../src/domain/index.js';

const roots: string[] = [];
const noAgent: CodingAgent = {
  async *execute() {},
  async cancel() {},
  async getStatus(runId) { return { runId, state: 'FAILED' }; },
};

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'codex-design-project-library-'));
  roots.push(root);
  return root;
}

function library(service: ProjectService): ProjectService & ProjectLibrary {
  return service as ProjectService & ProjectLibrary;
}

function frameBatch(project: PersistedProjectEnvelope, id: string, name: string) {
  const pageId = project.document.pageOrder[0]!;
  return {
    id,
    documentId: project.document.id,
    expectedRevision: project.document.revision,
    source: 'toolbar' as const,
    capabilitySet: ['node.create'],
    operations: [{ type: 'node.create' as const, node: { ...createNodeBase(`${id}_frame`, name), kind: 'frame' as const }, pageId, index: 0 }],
  };
}

async function savedDesign(service: ProjectService, name: string, prefix: string) {
  const created = await service.createProject(name);
  const withFrame = await service.apply(frameBatch(created, prefix, `${name} frame`));
  expect(withFrame.result.status).toBe('committed');
  const edited = await service.apply({
    id: `${prefix}_rename`, documentId: created.document.id, expectedRevision: withFrame.project.document.revision,
    source: 'inspector', capabilitySet: ['property.set'],
    operations: [{ type: 'property.set', nodeId: `${prefix}_frame`, change: { property: 'name', value: `${name} saved frame` } }],
  });
  expect(edited.result.status).toBe('committed');
  return edited.project;
}

async function trashContains(directory: string, id: string): Promise<boolean> {
  const trash = join(directory, '.trash');
  const entries = await readdir(trash).catch(() => []);
  for (const entry of entries) {
    const path = join(trash, entry);
    try {
      const candidate = JSON.parse(await readFile(path, 'utf8')) as { document?: { id?: string } };
      if (candidate.document?.id === id) return true;
    } catch { /* Ignore non-envelope trash metadata. */ }
  }
  return false;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('independent project library boundaries', () => {
  it('previews saved authoritative documents without changing bytes, history, selection, or agent activity', async () => {
    const directory = await makeRoot();
    const persistence = new LocalDesignPersistence(directory);
    let agentExecutions = 0;
    const observingAgent: CodingAgent = {
      async *execute() { agentExecutions += 1; yield { type: 'progress', runId: 'unexpected', phase: 'RUNNING', message: 'unexpected invocation' }; },
      async cancel() {},
      async getStatus(runId) { return { runId, state: 'FAILED' }; },
    };
    const service = await ProjectService.open(persistence, observingAgent);
    const historical = await savedDesign(service, 'Historical design', 'historical');
    const current = await service.createProject('Current design');
    const historicalBytes = await readFile(join(directory, `${historical.document.id}.json`), 'utf8');

    const preview = await library(service).previewProject(historical.document.id);

    expect(preview).toEqual(historical.document);
    expect(preview.nodes.historical_frame?.name).toBe('Historical design saved frame');
    expect(service.getProject()?.document.id).toBe(current.document.id);
    expect(await readFile(join(directory, `${historical.document.id}.json`), 'utf8')).toBe(historicalBytes);
    expect(service.listRuns()).toEqual([]);
    expect(agentExecutions).toBe(0);
  });

  it('isolates a damaged historical file while continuing to list and preview healthy projects', async () => {
    const directory = await makeRoot();
    const persistence = new LocalDesignPersistence(directory);
    const service = await ProjectService.open(persistence, noAgent);
    const healthy = await savedDesign(service, 'Healthy project', 'healthy');
    const active = await service.createProject('Active project');
    const damagedId = 'damaged-project';
    const damagedBytes = '{ not a saved envelope';
    await writeFile(join(directory, `${damagedId}.json`), damagedBytes, { mode: 0o600 });

    const projects = await library(service).listProjects();

    expect(projects.map(project => project.id)).toEqual(expect.arrayContaining([healthy.document.id, active.document.id, damagedId]));
    expect(projects.find(project => project.id === damagedId)).toMatchObject({ status: 'unavailable' });
    const healthySummary = projects.find(project => project.id === healthy.document.id)!;
    expect(healthySummary).toMatchObject({ status: 'available', name: 'Healthy project' });
    expect(Object.keys(healthySummary).sort()).toEqual(['id', 'name', 'nodeCount', 'revision', 'status', 'updatedAt']);
    await expect(library(service).previewProject(damagedId)).rejects.toThrow();
    expect(await library(service).previewProject(healthy.document.id)).toEqual(healthy.document);
    expect(service.getProject()?.document.id).toBe(active.document.id);
    expect(await readFile(join(directory, `${damagedId}.json`), 'utf8')).toBe(damagedBytes);
  });

  it('opens a historical envelope with its complete history and keeps it selected after service reload', async () => {
    const directory = await makeRoot();
    const persistence = new LocalDesignPersistence(directory);
    const service = await ProjectService.open(persistence, noAgent);
    const historical = await savedDesign(service, 'History survives', 'history');
    await service.createProject('Temporary active project');

    const opened = await library(service).openProject(historical.document.id);

    expect(opened).toEqual(historical);
    expect(opened.history.undoableEntries).toHaveLength(2);
    expect(opened.history.auditTransitions).toHaveLength(2);
    expect(service.getProject()).toEqual(historical);
    const reopened = await ProjectService.open(new LocalDesignPersistence(directory), noAgent);
    expect(reopened.getProject()).toEqual(historical);
    expect(reopened.listRuns()).toEqual([]);
  });

  it('trashes inactive projects without changing the active project and removes active pointers safely', async () => {
    const directory = await makeRoot();
    const persistence = new LocalDesignPersistence(directory);
    const service = await ProjectService.open(persistence, noAgent);
    const inactive = await savedDesign(service, 'Inactive project', 'inactive');
    const active = await service.createProject('Active project');

    await library(service).removeProject(inactive.document.id);
    expect(service.getProject()?.document.id).toBe(active.document.id);
    expect((await library(service).listProjects()).some(project => project.id === inactive.document.id)).toBe(false);
    expect(await trashContains(directory, inactive.document.id)).toBe(true);

    await library(service).removeProject(active.document.id);
    expect(service.getProject()).toBeNull();
    expect(await new LocalDesignPersistence(directory).loadCurrent()).toBeNull();
    expect(await trashContains(directory, active.document.id)).toBe(true);
    expect((await ProjectService.open(new LocalDesignPersistence(directory), noAgent)).getProject()).toBeNull();
  });

  it('rejects unsafe identifiers and refuses symlink entries without reading the target', async () => {
    const directory = await makeRoot();
    const store = join(directory, 'projects');
    const outside = join(directory, 'outside.json');
    const service = await ProjectService.open(new LocalDesignPersistence(store), noAgent);
    const valid = await service.createProject('Outside target fixture');
    const outsideBytes = await readFile(join(store, `${valid.document.id}.json`), 'utf8');
    await writeFile(outside, outsideBytes, { mode: 0o600 });
    await rm(join(store, `${valid.document.id}.json`));
    await symlink(outside, join(store, `${valid.document.id}.json`));

    const projects = await library(service).listProjects();
    expect(projects.some(project => project.id === valid.document.id)).toBe(false);
    await expect(library(service).previewProject(valid.document.id)).rejects.toThrow();
    await expect(library(service).openProject('../outside')).rejects.toThrow();
    await expect(library(service).removeProject('../outside')).rejects.toThrow();
    expect(await readFile(outside, 'utf8')).toBe(outsideBytes);
  });

  it('preserves the active project when removal storage fails', async () => {
    const directory = await makeRoot();
    const base = new LocalDesignPersistence(directory);
    const active = await ProjectService.open(base, noAgent);
    const original = await serviceCurrentAfterCreate(active, 'Stay active');
    const proxy = new Proxy(base, {
      get(target, key, receiver) {
        if (key === 'removeProject') return async () => { throw new Error('Trash storage is read-only.'); };
        return Reflect.get(target, key, receiver);
      },
    }) as LocalDesignPersistence & ProjectPersistence;
    const service = await ProjectService.open(proxy, noAgent);

    await expect(library(service).removeProject(original.document.id)).rejects.toThrow(/read-only/i);
    expect(service.getProject()).toEqual(original);
    expect(await base.loadCurrent()).toEqual(original);
  });

  it('blocks create, open, and remove while an agent run is nonterminal', async () => {
    const directory = await makeRoot();
    const persistence = new LocalDesignPersistence(directory);
    const primary = await ProjectService.open(persistence, noAgent);
    const existing = await savedDesign(primary, 'Existing', 'existing');
    const target = await savedDesign(primary, 'Target', 'target');
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const waitingAgent: CodingAgent = {
      async *execute(request) {
        entered();
        yield { type: 'progress', runId: request.runId, phase: 'RUNNING', message: 'Waiting for fixture response.' };
        await held;
      },
      async cancel() { release(); },
      async getStatus(runId) { return { runId, state: 'RUNNING' }; },
    };
    const service = await ProjectService.open(persistence, waitingAgent);
    const active = await service.createProject('Run owner');
    const run = await service.startRun('Wait for external response', [], active.document.revision);
    await started;
    try {
      await expect(library(service).openProject(existing.document.id)).rejects.toMatchObject({ code: 'run.busy' });
      await expect(library(service).removeProject(target.document.id)).rejects.toMatchObject({ code: 'run.busy' });
      await expect(service.createProject('Must not be created')).rejects.toMatchObject({ code: 'run.busy' });
      expect(service.getProject()?.document.id).toBe(active.document.id);
      expect(service.getRun(run.runId).run.state).toBe('RUNNING');
    } finally {
      release();
    }
  });
});

async function serviceCurrentAfterCreate(service: ProjectService, name: string) {
  return service.createProject(name);
}
