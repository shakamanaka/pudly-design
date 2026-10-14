import { openProviderRegistry } from '../../server/index';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createLocalApiHandler } from '../../server/router';
import { ProjectService } from '../../src/application/project-service';
import { LocalDesignPersistence } from '../../src/adapters/persistence/local-files';
import { LocalAgentRunStore } from '../../src/adapters/persistence/local-run-store';
import { createBrowserProviderFixture } from '../provider-qa/fixtures/browser-provider';
import type { CodingAgent } from '../../src/domain/types';

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'provider-route-')); roots.push(root);
  const providers = await createBrowserProviderFixture(join(root, 'providers'));
  const legacy: CodingAgent = { async *execute() { yield { type: 'response', response: { operations: [] } }; throw new Error('Legacy fallback must never execute'); }, async cancel() { throw new Error('Wrong cancellation route'); }, async getStatus(runId) { return { runId, state: 'FAILED' }; } };
  const persistence = new LocalDesignPersistence(join(root, 'projects'));
  const runStore = new LocalAgentRunStore(join(root, 'runs'));
  const service = await ProjectService.open(persistence, legacy, runStore, providers);
  await service.createProject('Route fixture');
  const server = createServer(createLocalApiHandler(service, { providers })); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  async function send(method: string, path: string, body?: unknown, origin = 'http://127.0.0.1:5174') {
    const text = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<{ status: number; text: string; body: Record<string, unknown> }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { host: '127.0.0.1:5174', origin, ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }) } }, res => {
        let data = ''; res.setEncoding('utf8'); res.on('data', chunk => data += chunk); res.on('end', () => resolve({ status: res.statusCode!, text: data, body: JSON.parse(data) as Record<string, unknown> }));
      }); req.on('error', reject); req.end(text);
    });
  }
  return { send, service, providers, persistence, runStore, legacy };
}
test('provider API rejects cross-origin PATCH/DELETE and secret-bearing extra fields', async () => {
  const { send } = await setup();
  for (const method of ['PATCH', 'DELETE']) expect((await send(method, '/api/connections/codex-local', undefined, 'https://evil.example')).status).toBe(403);
  expect((await send('POST', '/api/connections', { providerId: 'codex', authSource: 'chatgpt', label: 'Safe', secretRef: 'not-allowed' })).status).toBe(400);
  expect((await send('POST', '/api/runs', { prompt: 'Hi', selectedNodeIds: [], expectedRevision: 0, providerSelection: { connectionId: 'codex-local', modelId: 'gpt-6.1-sol', effort: 'low', credential: 'sentinel' } })).status).toBe(400);
});
test('provider run preflight, atomic render lifecycle and immutable metadata survive connection deletion and reopen', async () => {
  const { send, service, providers, persistence, runStore, legacy } = await setup();
  const selection = { connectionId: 'codex-local', modelId: 'gpt-6.1-sol', effort: 'low' };
  expect((await send('POST', '/api/runs', { prompt: 'Card', selectedNodeIds: [], expectedRevision: 0, providerSelection: selection })).status).toBe(422);
  expect(service.getProject()?.document.revision).toBe(0);
  expect(service.listRuns()).toHaveLength(0);
  expect((await send('POST', '/api/connections/codex-local/verify', { modelId: selection.modelId, effort: selection.effort })).status).toBe(200);
  const result = await send('POST', '/api/runs', { prompt: 'Card', selectedNodeIds: [], expectedRevision: 0, providerSelection: selection });
  expect(result.status).toBe(202); const id = result.body.runId as string;
  for (let i = 0; i < 100 && service.getRun(id).run.state !== 'RENDERING'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(service.getProject()?.document.revision).toBe(1);
  await service.acknowledgeRender(id, 1, true);
  expect(service.getRun(id).run.state).toBe('SUCCEEDED');
  const metadata = service.getRun(id).run.providerSelection;
  expect(metadata).toMatchObject({ ...selection, providerId: 'codex', authSource: 'chatgpt', version: 1, policy: 'manual' });
  expect((await send('DELETE', '/api/connections/codex-local')).status).toBe(200);
  const reopened = await ProjectService.open(persistence, legacy, runStore, providers);
  expect(reopened.getRun(id).run.providerSelection).toEqual(metadata);
  expect(reopened.getRun(id).run.state).toBe('SUCCEEDED');
});

 test('corrupt provider metadata leaves saved design readable and fails generation closed without fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provider-recovery-')); roots.push(root);
  const persistence = new LocalDesignPersistence(join(root, 'projects'));
  const legacy: CodingAgent = { async *execute() { yield { type: 'response', response: { operations: [] } }; throw new Error('Must not fallback'); }, async cancel() {}, async getStatus(runId) { return { runId, state: 'FAILED' }; } };
  const initial = await ProjectService.open(persistence, legacy);
  const saved = await initial.createProject('Preserved design');
  const directory = join(root, 'connections'); await mkdir(directory);
  const corrupt = '{"version":999,"secret":"redaction-sentinel"}';
  await writeFile(join(directory, 'provider-connections.json'), corrupt);
  const providers = await openProviderRegistry(directory);
  const reopened = await ProjectService.open(persistence, legacy, undefined, providers);
  expect(reopened.getProject()?.document).toEqual(saved.document);
  await expect(providers.list()).rejects.toMatchObject({ code: 'provider.recovery', message: expect.not.stringContaining('redaction-sentinel') });
  await expect(reopened.startRun('Card', [], 0, undefined, { connectionId: 'codex-local', modelId: 'gpt-6.1-sol', effort: 'low' })).rejects.toMatchObject({ code: 'provider.recovery' });
  expect(reopened.listRuns()).toHaveLength(0);
  expect(await readFile(join(directory, 'provider-connections.json'), 'utf8')).toBe(corrupt);
});
