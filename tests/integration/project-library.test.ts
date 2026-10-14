import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createLocalApiHandler } from '../../server/router.js';
import { LocalDesignPersistence } from '../../src/adapters/persistence/local-files.js';
import { ProjectService } from '../../src/application/project-service.js';
import type { CodingAgent } from '../../src/domain/index.js';

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const noAgent: CodingAgent = {
  async *execute() { /* Project library tests never invoke generation. */ },
  async cancel() {},
  async getStatus(runId) { return { runId, state: 'FAILED' }; },
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'project-library-'));
  roots.push(root);
  const directory = join(root, 'projects');
  const persistence = new LocalDesignPersistence(directory);
  const service = await ProjectService.open(persistence, noAgent);
  const server = createServer(createLocalApiHandler(service));
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  async function send(method: string, path: string, body?: unknown) {
    const text = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<{ status: number; text: string; body: Record<string, unknown> }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { host: '127.0.0.1:5174', origin: 'http://127.0.0.1:5174', ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }) } }, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode!, text: data, body: JSON.parse(data) as Record<string, unknown> }));
      });
      req.on('error', reject);
      req.end(text);
    });
  }
  return { root, directory, persistence, service, send };
}

test('project API discovers, previews, opens and recoverably removes saved envelopes', async () => {
  const { directory, persistence, service, send } = await setup();
  const older = await service.createProject('Older project');
  const olderWithHistory = await service.snapshot('Keep this history', 0);
  const newer = await service.createProject('Newer project');
  await utimes(join(directory, `${older.document.id}.json`), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  await utimes(join(directory, `${newer.document.id}.json`), new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'));

  const listed = await send('GET', '/api/projects');
  expect(listed.status).toBe(200);
  expect(listed.body.projects).toMatchObject([
    { id: newer.document.id, name: 'Newer project', revision: 0, status: 'available' },
    { id: older.document.id, name: 'Older project', revision: 0, status: 'available' },
  ]);

  const beforePreview = await persistence.load(older.document.id);
  const preview = await send('GET', `/api/projects/${older.document.id}/preview`);
  expect(preview.status).toBe(200);
  expect(preview.body).toEqual({ document: olderWithHistory.document });
  expect(await persistence.load(older.document.id)).toEqual(beforePreview);
  expect(service.getProject()?.document.id).toBe(newer.document.id);

  const opened = await send('POST', `/api/projects/${older.document.id}/open`, {});
  expect(opened.status).toBe(200);
  expect(opened.body.project).toEqual(olderWithHistory);
  expect((await persistence.loadCurrent())?.document.id).toBe(older.document.id);

  const deleted = await send('DELETE', `/api/projects/${newer.document.id}`);
  expect(deleted.status).toBe(200);
  expect(deleted.body).toEqual({ deleted: true, project: olderWithHistory });
  expect(await persistence.load(newer.document.id)).toBeNull();
  const trashedNames = await readdir(join(directory, '.trash'));
  expect(trashedNames.some(name => name.startsWith(`${newer.document.id}.`))).toBe(true);
  expect(await ProjectService.open(persistence, noAgent).then(reopened => reopened.getProject()?.document.id)).toBe(older.document.id);
});

test('damaged projects remain isolated and symlink entries are excluded and rejected', async () => {
  const { root, directory, persistence, service } = await setup();
  const healthy = await service.createProject('Healthy');
  await writeFile(join(directory, 'damaged.json'), '{not valid json');
  const outside = join(root, 'outside.json');
  await writeFile(outside, '{"outside":"must remain untouched"}');
  await symlink(outside, join(directory, 'linked.json'));

  const summaries = await persistence.listProjects();
  expect(summaries).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: healthy.document.id, name: 'Healthy', status: 'available' }),
    expect.objectContaining({ id: 'damaged', name: 'Unavailable project', status: 'unavailable', diagnostic: expect.any(String) }),
  ]));
  expect(summaries.some(project => project.id === 'linked')).toBe(false);
  await expect(persistence.previewProject('linked')).rejects.toMatchObject({ code: 'project.unsafe-entry' });
  await expect(persistence.removeProject('linked')).rejects.toMatchObject({ code: 'project.unsafe-entry' });
  expect(await readFile(outside, 'utf8')).toBe('{"outside":"must remain untouched"}');
});

test('active removal leaves a valid empty pointer and API rejects unsafe identifiers', async () => {
  const { persistence, service, send } = await setup();
  const project = await service.createProject('Active');
  expect((await send('DELETE', '/api/projects/bad.id')).status).toBe(400);
  const result = await send('DELETE', `/api/projects/${project.document.id}`);
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ deleted: true, project: null });
  expect(await persistence.loadCurrent()).toBeNull();
  expect((await ProjectService.open(persistence, noAgent)).getProject()).toBeNull();
});

test('create, open and remove are rejected while a generation is nonterminal', async () => {
  const { directory, persistence, service: initial } = await setup();
  const project = await initial.createProject('Busy guard');
  const blockedAgent: CodingAgent = {
    async *execute(_request, signal) {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      if (signal.aborted) throw new Error('Generation cancelled for the lifecycle isolation test.');
      yield { type: 'response', response: { operations: [] } };
    },
    async cancel() {},
    async getStatus(runId) { return { runId, state: 'RUNNING' }; },
  };
  const service = await ProjectService.open(persistence, blockedAgent);
  const { runId } = await service.startRun('Hold project open', [], 0);
  expect(service.getRun(runId).run.state).not.toMatch(/^(SUCCEEDED|FAILED|CANCELLED|ROLLED_BACK)$/);
  await expect(service.createProject('Blocked')).rejects.toMatchObject({ code: 'run.busy' });
  await expect(service.openProject(project.document.id)).rejects.toMatchObject({ code: 'run.busy' });
  await expect(service.removeProject(project.document.id)).rejects.toMatchObject({ code: 'run.busy' });
  expect((await persistence.load(project.document.id))?.document.id).toBe(project.document.id);
  expect((await persistence.loadCurrent())?.document.id).toBe(project.document.id);
  await service.cancelRun(runId);
  expect(service.getRun(runId).run.state).toBe('CANCELLED');
  expect(await readFile(join(directory, `${project.document.id}.json`), 'utf8')).toContain(project.document.id);
});
