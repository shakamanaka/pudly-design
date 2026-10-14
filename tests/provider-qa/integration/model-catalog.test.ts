import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexModelCatalog, collectCodexModelPages } from '../../../src/adapters/providers/codex-model-catalog.js';
import { LocalProviderConnectionService } from '../../../src/adapters/providers/connection-service.js';
import type { SecretStore } from '../../../src/adapters/providers/secret-store.js';
import type { AgentStatus, CodingAgent, CodingAgentRequest, RunEvent } from '../../../src/domain/types.js';

const roots: string[] = [];
async function createRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'model-catalog-qa-'));
  roots.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

class MemorySecrets implements SecretStore {
  async put(_value: string, reference?: string): Promise<string> { return reference ?? 'fixture-secret'; }
  async get(): Promise<string> { return 'fixture-api-key'; }
  async delete(): Promise<void> {}
}

class VerificationAgent implements CodingAgent {
  async *execute(request: CodingAgentRequest): AsyncIterable<RunEvent | { type: 'response'; response: { operations: []; summary: string } }> {
    void request;
    yield { type: 'response', response: { operations: [], summary: 'verification fixture' } };
  }
  async cancel(): Promise<void> {}
  async getStatus(runId: string): Promise<AgentStatus> { return { runId, state: 'SUCCEEDED' }; }
}

describe('Codex model catalog pagination', () => {
  it('requests every page including hidden models and preserves per-model effort order', async () => {
    const requests: Array<{ limit: number; includeHidden: true; cursor?: string }> = [];
    const result = await collectCodexModelPages(async request => {
      requests.push(request);
      if (!request.cursor) return {
        data: [
          { id: 'gpt-account-alpha', displayName: 'Account Alpha', hidden: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
          { id: 'gpt-account-hidden', displayName: 'Account Hidden', hidden: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
        ],
        nextCursor: 'page-two',
      };
      return {
        data: [{ id: 'gpt-account-beta', displayName: 'Account Beta', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }, { reasoningEffort: 'default' }] }],
        nextCursor: null,
      };
    });

    expect(requests, 'includeHidden must be true for every account catalog page').toEqual([
      { limit: 100, includeHidden: true },
      { limit: 100, includeHidden: true, cursor: 'page-two' },
    ]);
    expect(result.catalogStatus).toBe('known');
    expect(result.models.map(model => model.id)).toEqual(['gpt-account-alpha', 'gpt-account-hidden', 'gpt-account-beta']);
    expect(result.models[0], "discovery availability must remain 'unknown' until exact verification").toMatchObject({
      label: 'Account Alpha', availability: 'unknown', entitlement: null,
      defaultEffort: 'low', supportedEfforts: ['low', 'high'],
    });
    expect(result.models[1]).toMatchObject({ label: 'Account Hidden', hidden: true, supportedEfforts: ['medium'] });
    expect(result.models[2]?.supportedEfforts).toEqual(['xhigh', 'default']);
    expect(result.models.some(model => model.id === 'gpt-6.1-sol')).toBe(false);
  });

  it('deduplicates repeated IDs without merging unrelated effort sets', async () => {
    const result = await collectCodexModelPages(async ({ cursor }) => cursor
      ? { data: [{ id: 'gpt-shared', displayName: 'later duplicate', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null }
      : { data: [{ id: 'gpt-shared', displayName: 'first record', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: 'next' });

    expect(result.models).toHaveLength(1);
    expect(result.models[0], 'first record and its effort set must remain stable across duplicate IDs').toMatchObject({ label: 'first record', supportedEfforts: ['low'] });
  });

  it('returns a partial catalog when a later page fails and unknown when the first page fails', async () => {
    const partial = await collectCodexModelPages(async ({ cursor }) => {
      if (cursor) throw new Error('private transport detail');
      return { data: [{ id: 'gpt-partial', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }], nextCursor: 'next' };
    });
    const unknown = await collectCodexModelPages(async () => { throw new Error('private transport detail'); });

    expect(partial).toMatchObject({ catalogStatus: 'partial', models: [{ id: 'gpt-partial' }] });
    expect(unknown).toEqual({ models: [], catalogStatus: 'unknown' });
    expect(JSON.stringify([partial, unknown])).not.toContain('private transport detail');
  });

  it('detects repeated cursors and marks malformed model records as partial', async () => {
    let calls = 0;
    const repeatedCursor = await collectCodexModelPages(async () => {
      calls++;
      return { data: [{ id: 'gpt-safe', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: 'same' };
    });
    const malformed = await collectCodexModelPages(async () => ({
      data: [
        { id: 'gpt-partial-efforts', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'future-effort' }] },
        { id: '   ', supportedReasoningEfforts: [] },
      ], nextCursor: null,
    }));

    expect(calls, 'repeated cursors must stop pagination promptly').toBe(2);
    expect(repeatedCursor.catalogStatus).toBe('partial');
    expect(malformed).toMatchObject({ catalogStatus: 'partial', models: [{ id: 'gpt-partial-efforts', supportedEfforts: ['low'] }] });
  });

  it('caps pages even when the server keeps issuing fresh cursors', async () => {
    const requests: Array<{ limit: number; includeHidden: true; cursor?: string }> = [];
    const result = await collectCodexModelPages(async request => {
      requests.push(request);
      return { data: [{ id: `gpt-page-${requests.length}`, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: `cursor-${requests.length}` };
    }, { maxPages: 2 });

    expect(requests).toHaveLength(2);
    expect(result.catalogStatus).toBe('partial');
    expect(result.models.map(model => model.id)).toEqual(['gpt-page-1', 'gpt-page-2']);
  });

  it('times out and terminates the app-server process without retaining provider output', async () => {
    const directory = await createRoot();
    const invocationPath = join(directory, 'invocation.json');
    const executable = join(directory, 'codex-fixture.mjs');
    await writeFile(executable, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(invocationPath)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), pid: process.pid, hasAmbientSecret: Boolean(process.env.OPENAI_API_KEY) }));
process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', chunk => {
  input += chunk;
  for (;;) {
    const newline = input.indexOf('\\n');
    if (newline < 0) break;
    const line = input.slice(0, newline); input = input.slice(newline + 1);
    let request; try { request = JSON.parse(line); } catch { continue; }
    if (request.method === 'initialize') process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`, { mode: 0o700 });
    await chmod(executable, 0o700);
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'ambient-should-not-enter-catalog-process';
    try {
      const result = await CodexModelCatalog.discover(undefined, { executable, timeoutMs: 2_500, killGraceMs: 20 });
      expect(result).toEqual({ models: [], catalogStatus: 'unknown' });
      const invocation = JSON.parse(await readFile(invocationPath, 'utf8')) as { args: string[]; cwd: string; pid: number; hasAmbientSecret: boolean };
      expect(invocation.args).toEqual(['app-server', '--listen', 'stdio://', '-c', 'mcp_servers={}']);
      expect(invocation.cwd).not.toBe(process.cwd());
      expect(invocation.hasAmbientSecret).toBe(false);
      expect(() => process.kill(invocation.pid, 0), 'the timed-out app-server process must be gone').toThrow();
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
    }
  });

  it('keeps the ChatGPT account catalog separate from API-key connections and exact verification', async () => {
    const discoveryRequests: Array<{ limit: number; includeHidden: true; cursor?: string }> = [];
    const service = await LocalProviderConnectionService.open(await createRoot(), {
      secretStore: new MemorySecrets(),
      createAgent: () => new VerificationAgent(),
      discoverCodexModels: async request => {
        discoveryRequests.push(request);
        return { data: [{ id: 'gpt-account-only', displayName: 'Account Only', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null };
      },
    });
    const apiKey = await service.create({ providerId: 'codex', authSource: 'openai-api-key', label: 'API key', credential: 'api-key-fixture' });

    const apiCatalog = await service.catalog('codex', apiKey.id);
    expect(apiCatalog, 'API-key connections must never reuse the local ChatGPT account catalog').toEqual({ providerId: 'codex', models: [], catalogStatus: 'unknown' });
    expect(discoveryRequests).toHaveLength(0);

    const localCatalog = await service.catalog('codex', 'codex-local');
    expect(localCatalog.catalogStatus).toBe('known');
    expect(localCatalog.models).toMatchObject([{ id: 'gpt-account-only', availability: 'unknown', supportedEfforts: ['low'] }]);
    expect(localCatalog.models.some(model => model.id === 'gpt-6.1-sol'), 'account discovery must not append the global static Codex fallback').toBe(false);
    expect(discoveryRequests).toEqual([{ limit: 100, includeHidden: true }]);

    await expect(service.verify('codex-local', { modelId: 'gpt-account-only', effort: 'high' }), 'unsupported per-model effort must be rejected before verification')
      .rejects.toMatchObject({ code: 'provider.effort_unsupported' });
    const verified = await service.verify('codex-local', { modelId: 'gpt-account-only', effort: 'low' });
    expect(verified.capabilities.models).toMatchObject([{ id: 'gpt-account-only', availability: 'available', supportedEfforts: ['low'] }]);
    await expect(service.resolve({ connectionId: 'codex-local', modelId: 'gpt-account-only', effort: 'high' }))
      .rejects.toMatchObject({ code: 'provider.selection_unverified' });
    expect(discoveryRequests).toHaveLength(1);
  });
});
