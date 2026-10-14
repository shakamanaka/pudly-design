import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalProviderConnectionService } from '../../../src/adapters/providers/connection-service.js';
import { checkClaudeLocalSession, claudeEnvironment, discoverClaudeModels } from '../../../src/adapters/providers/claude-runtime.js';
import { ClaudeCodeAdapter } from '../../../src/adapters/providers/claude-code-adapter.js';
import type { SecretStore } from '../../../src/adapters/providers/secret-store.js';
import type { AgentStatus, CodingAgent, CodingAgentRequest, RunEvent } from '../../../src/domain/types.js';

const roots: string[] = [];
async function createRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'claude-session-catalog-qa-'));
  roots.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function executable(directory: string, name: string, body: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

async function hangingExecutable(directory: string, name: string, marker: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, `#!/bin/sh\nprintf '%s' "$$" > '${marker}'\nexec sleep 30\n`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

function withEnvironment(values: Record<string, string | undefined>): () => void {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

class MemorySecrets implements SecretStore {
  async put(_value: string, reference?: string): Promise<string> { return reference ?? 'claude-qa-secret'; }
  async get(): Promise<string> { return 'claude-api-key-fixture'; }
  async delete(): Promise<void> {}
}

class VerificationAgent implements CodingAgent {
  async *execute(request: CodingAgentRequest): AsyncIterable<RunEvent | { type: 'response'; response: { operations: []; summary: string } }> {
    void request;
    yield { type: 'response', response: { operations: [], summary: 'read-only QA verification fixture' } };
  }
  async cancel(): Promise<void> {}
  async getStatus(runId: string): Promise<AgentStatus> { return { runId, state: 'SUCCEEDED' }; }
}

function verificationRequest(runId: string): CodingAgentRequest {
  return {
    runId, documentId: 'claude-session-catalog-qa', baseRevision: 0,
    prompt: 'Fixture-only exact Claude connection verification.', selectedNodeIds: [],
    documentFragment: { documentId: 'claude-session-catalog-qa', revision: 0, nodes: {}, tokens: {}, components: {} },
    resolvedContext: [], operationCapabilities: ['node.create'],
  };
}

describe('Claude local session and account catalog boundaries', () => {
  it('preserves USER and LOGNAME while excluding ambient provider secrets and custom execution configuration', () => {
    const restore = withEnvironment({
      USER: 'local-user-fixture', LOGNAME: 'local-login-fixture',
      ANTHROPIC_API_KEY: 'ambient-api-key-sentinel', ANTHROPIC_AUTH_TOKEN: 'ambient-auth-token-sentinel',
      CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', NODE_OPTIONS: '--require=ambient-hook-sentinel',
    });
    try {
      const subscription = claudeEnvironment('claude-subscription');
      expect(subscription.USER).toBe('local-user-fixture');
      expect(subscription.LOGNAME).toBe('local-login-fixture');
      expect(subscription.ANTHROPIC_API_KEY).toBeUndefined();
      expect(subscription.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(subscription.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
      expect(subscription.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
      expect(subscription.NODE_OPTIONS).toBeUndefined();

      const api = claudeEnvironment('anthropic-api-key', 'selected-api-key-sentinel');
      expect(api.ANTHROPIC_API_KEY).toBe('selected-api-key-sentinel');
      expect(api.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(JSON.stringify([subscription, api])).not.toContain('ambient-api-key-sentinel');
      expect(JSON.stringify([subscription, api])).not.toContain('ambient-auth-token-sentinel');
    } finally { restore(); }
  });

  it('checks auth through the read-only status command and returns only sanitized session state', async () => {
    const directory = await createRoot();
    const capturePath = join(directory, 'auth-invocation.json');
    const cli = await executable(directory, 'claude-auth-fixture.mjs', `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), user: process.env.USER, logname: process.env.LOGNAME, apiKey: process.env.ANTHROPIC_API_KEY, authToken: process.env.ANTHROPIC_AUTH_TOKEN }));
      process.stdout.write(JSON.stringify({ loggedIn: true, email: 'private@example.test', organization: 'private-org', token: 'private-token-sentinel' }));
    `);
    const restore = withEnvironment({ USER: 'claude-account-user', LOGNAME: 'claude-account-login', ANTHROPIC_API_KEY: 'ambient-claude-key-sentinel', ANTHROPIC_AUTH_TOKEN: 'ambient-claude-token-sentinel' });
    try {
      const result = await checkClaudeLocalSession({ executable: cli, tempRoot: directory, timeoutMs: 5000 });
      expect(result).toMatchObject({ status: 'authenticated' });
      expect(Object.keys(result).sort()).toEqual(['checkedAt', 'status']);
      const call = JSON.parse(await readFile(capturePath, 'utf8')) as { args: string[]; cwd: string; user?: string; logname?: string; apiKey?: string; authToken?: string };
      expect(call.args).toEqual(['auth', 'status']);
      expect(call.cwd).not.toBe(process.cwd());
      expect(call.user).toBe('claude-account-user');
      expect(call.logname).toBe('claude-account-login');
      expect(call.apiKey).toBeUndefined();
      expect(call.authToken).toBeUndefined();
      expect(JSON.stringify(result)).not.toMatch(/private@example|private-org|private-token-sentinel/);
    } finally { restore(); }
  });

  it('keeps missing, malformed and timed-out auth checks distinct from successful recognition', async () => {
    const directory = await createRoot();
    const signedOut = await executable(directory, 'claude-signed-out.mjs', `process.stdout.write(JSON.stringify({ loggedIn: false }));`);
    const malformed = await executable(directory, 'claude-malformed-auth.mjs', `process.stdout.write(JSON.stringify({ email: 'private@example.test' }));`);
    const failed = await executable(directory, 'claude-failed-auth.mjs', `process.stdout.write(JSON.stringify({ loggedIn: true })); process.exitCode = 7;`);
    const failedSignedOut = await executable(directory, 'claude-failed-signed-out.mjs', `process.stdout.write(JSON.stringify({ loggedIn: false })); process.exitCode = 7;`);
    const hangingPath = join(directory, 'auth-child.json');
    const hanging = await hangingExecutable(directory, 'claude-hanging-auth.sh', hangingPath);

    expect(await checkClaudeLocalSession({ executable: signedOut, tempRoot: directory, timeoutMs: 5000 })).toMatchObject({ status: 'unauthenticated' });
    expect(await checkClaudeLocalSession({ executable: malformed, tempRoot: directory, timeoutMs: 5000 })).toMatchObject({ status: 'unknown' });
    expect(await checkClaudeLocalSession({ executable: failed, tempRoot: directory, timeoutMs: 5000 })).toMatchObject({ status: 'unknown' });
    expect(await checkClaudeLocalSession({ executable: failedSignedOut, tempRoot: directory, timeoutMs: 5000 })).toMatchObject({ status: 'unauthenticated' });
    expect(await checkClaudeLocalSession({ executable: hanging, tempRoot: directory, timeoutMs: 1000 })).toMatchObject({ status: 'unknown' });
    const pid = Number(await readFile(hangingPath, 'utf8'));
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0), 'timed-out auth child must be terminated').toThrow();
  }, 25_000);

  it('reads advertised versioned models from SDK initialization without sending a prompt', async () => {
    const directory = await createRoot();
    const capturePath = join(directory, 'catalog-invocation.json');
    const cli = await executable(directory, 'claude-catalog-fixture.mjs', `
      import { writeFileSync } from 'node:fs';
      let input = ''; for await (const chunk of process.stdin) input += chunk;
      writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), user: process.env.USER, key: process.env.ANTHROPIC_API_KEY, input }));
      process.stdout.write(JSON.stringify({ type: 'control_response', response: { request_id: 'codex-design-init', subtype: 'success', response: { models: [
        { value: 'claude-sonnet-4-5-20250929', displayName: 'Claude Sonnet 4.5', supportedEffortLevels: ['low', 'high'] },
        { value: 'claude-opus-4-1-20250805', displayName: 'Claude Opus 4.1', supportedEffortLevels: ['medium', 'high', 'future'] },
        { value: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5' },
        { value: 'claude-extra-model-v1', displayName: 'Extra Model' }
      ] } } }) + '\\n');
      setInterval(() => {}, 1000);
    `);
    const restore = withEnvironment({ USER: 'claude-catalog-user', ANTHROPIC_API_KEY: 'ambient-catalog-key-sentinel' });
    try {
      const result = await discoverClaudeModels({ executable: cli, tempRoot: directory, timeoutMs: 5000 });
      expect(result.catalogStatus).toBe('partial');
      expect(result.models).toEqual([
        { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', supportedEfforts: ['low', 'high'] },
        { id: 'claude-opus-4-1-20250805', label: 'Claude Opus 4.1', supportedEfforts: ['medium', 'high'] },
        { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', supportedEfforts: [] },
        { id: 'claude-extra-model-v1', label: 'Extra Model', supportedEfforts: [] },
      ]);
      const call = JSON.parse(await readFile(capturePath, 'utf8')) as { args: string[]; cwd: string; user?: string; key?: string; input: string };
      expect(call.args).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--tools', '', '--disallowedTools', 'mcp__*', '--permission-prompts', 'none', '--safe-mode', '--restricted']);
      expect(call.cwd).not.toBe(process.cwd());
      expect(call.user).toBe('claude-catalog-user');
      expect(call.key).toBeUndefined();
      expect(call.input).toBe(JSON.stringify({ type: 'control_request', request_id: 'codex-design-init', request: { subtype: 'initialize' } }) + '\n');
      expect(call.input).not.toMatch(/user message|design prompt/i);
    } finally { restore(); }
  });

  it('bounds malformed, oversized and hanging catalogs and terminates the timed-out child', async () => {
    const directory = await createRoot();
    const malformed = await executable(directory, 'claude-malformed-catalog.mjs', `process.stdout.write(JSON.stringify({ type: 'control_response', response: { request_id: 'codex-design-init', subtype: 'success', response: { models: 'not-an-array' } } }) + '\\n');`);
    const partial = await executable(directory, 'claude-partial-catalog.mjs', `process.stdout.write(JSON.stringify({ type: 'control_response', response: { request_id: 'codex-design-init', subtype: 'success', response: { models: [
      { value: 'claude-known', displayName: 'Known', supportedEffortLevels: ['low', 'future-effort'] },
      { value: 'claude-malformed', displayName: 42, supportedEffortLevels: ['high'] }
    ] } } }) + '\\n');`);
    const oversized = await executable(directory, 'claude-oversized-catalog.mjs', `process.stdout.write('x'.repeat(140000)); setInterval(() => {}, 1000);`);
    const hangingPath = join(directory, 'catalog-child.json');
    const hanging = await hangingExecutable(directory, 'claude-hanging-catalog.sh', hangingPath);

    expect(await discoverClaudeModels({ executable: malformed, tempRoot: directory, timeoutMs: 5000 })).toEqual({ models: [], catalogStatus: 'unknown' });
    expect(await discoverClaudeModels({ executable: partial, tempRoot: directory, timeoutMs: 5000 })).toEqual({
      models: [{ id: 'claude-known', label: 'Known', supportedEfforts: ['low'] }], catalogStatus: 'partial',
    });
    expect(await discoverClaudeModels({ executable: oversized, tempRoot: directory, timeoutMs: 5000 })).toEqual({ models: [], catalogStatus: 'unknown' });
    expect(await discoverClaudeModels({ executable: hanging, tempRoot: directory, timeoutMs: 1000 })).toEqual({ models: [], catalogStatus: 'unknown' });
    const pid = Number(await readFile(hangingPath, 'utf8'));
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0), 'timed-out catalog child must be terminated').toThrow();
  });

  it('keeps subscription evidence scoped and catalog discovery separate from exact inference verification', async () => {
    const directory = await createRoot();
    let sessionCalls = 0;
    let catalogCalls = 0;
    let adapterCreations = 0;
    const service = await LocalProviderConnectionService.open(directory, {
      secretStore: new MemorySecrets(),
      createAgent: () => { adapterCreations++; return new VerificationAgent(); },
      discoverClaudeSession: async () => { sessionCalls++; return { status: 'authenticated', checkedAt: '2026-10-13T00:00:00.000Z' }; },
      discoverClaudeModels: async () => {
        catalogCalls++;
        return { catalogStatus: 'known', models: [
          { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', supportedEfforts: ['low', 'high'] },
          { id: 'claude-opus-4-1-20250805', label: 'Claude Opus 4.1', supportedEfforts: ['medium'] },
          { id: 'claude-extra-model-v1', label: 'Extra model', supportedEfforts: [] },
          { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', supportedEfforts: [] },
        ] };
      },
    });
    const subscription = await service.create({ providerId: 'claude', authSource: 'claude-subscription', label: 'Local Claude' });
    const apiKey = await service.create({ providerId: 'claude', authSource: 'anthropic-api-key', label: 'Claude API key', credential: 'selected-claude-api-key-sentinel' });

    const views = await service.list();
    const subscriptionView = views.find(view => view.id === subscription.id)!;
    const apiKeyView = views.find(view => view.id === apiKey.id)!;
    expect(subscriptionView.localSession).toMatchObject({ status: 'authenticated' });
    expect(subscriptionView.capabilities.catalogStatus).toBe('known');
    expect(subscriptionView.capabilities.models.map(model => model.id)).toEqual([
      'claude-sonnet-4-5-20250929', 'claude-opus-4-1-20250805', 'claude-extra-model-v1', 'claude-haiku-4-5-20251001',
    ]);
    expect(subscriptionView.capabilities.models.every(model => model.availability === 'unknown'), 'catalog discovery must remain unverified until exact model/effort verification').toBe(true);
    expect(apiKeyView.localSession).toBeUndefined();
    expect(apiKeyView.capabilities.models.map(model => model.id), 'API-key connection must keep its independent static catalog').toEqual(['sonnet', 'opus', 'haiku']);
    const apiKeyCatalog = await service.catalog('claude', apiKey.id);
    expect(apiKeyCatalog.models.map(model => model.id), 'API-key catalog must retain its independent static model options').toEqual(['sonnet', 'opus', 'haiku']);
    expect(sessionCalls).toBe(1);
    expect(catalogCalls).toBe(1);
    expect(adapterCreations, 'session/catalog discovery must not dispatch an inference verification').toBe(0);

    await expect(service.verify(subscription.id, { modelId: 'claude-opus-4-1-20250805', effort: 'high' }))
      .rejects.toMatchObject({ code: 'provider.effort_unsupported' });
    expect(catalogCalls).toBe(1);
    expect((await service.list()).find(view => view.id === subscription.id)?.lastVerifiedSelection).toBeUndefined();
    await service.verify(subscription.id, { modelId: 'claude-sonnet-4-5-20250929', effort: 'low' });
    expect((await service.list()).find(view => view.id === subscription.id)?.lastVerifiedSelection).toEqual({ modelId: 'claude-sonnet-4-5-20250929', effort: 'low' });
    expect(sessionCalls).toBe(1);
    expect(adapterCreations).toBe(1);
  });

  it('classifies only Claude usage_limit_reached as quota and keeps provider details out of the error', async () => {
    const directory = await createRoot();
    const body = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', api_error_status: 429, api_error: 'usage_limit_reached', result: 'private provider detail and subscription account sentinel' });
    const cli = await executable(directory, 'claude-quota-fixture.mjs', `for await (const part of process.stdin) void part; process.stdout.write(${JSON.stringify(body)});`);
    const adapter = new ClaudeCodeAdapter({ executable: cli, tempRoot: directory, model: 'claude-sonnet-4-5-20250929', effort: 'low', authSource: 'claude-subscription' });
    let failure: unknown;
    try {
      for await (const event of adapter.execute(verificationRequest('claude-usage-limit'), new AbortController().signal)) void event;
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'provider.quota' });
    expect(String(failure)).not.toMatch(/private provider detail|subscription account sentinel/);

    const bare429 = await executable(directory, 'claude-bare-429-fixture.mjs', `for await (const part of process.stdin) void part; process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', api_error_status: 429, api_error: 'unknown', result: 'provider prose sentinel' }));`);
    const unknownAdapter = new ClaudeCodeAdapter({ executable: bare429, tempRoot: directory, model: 'claude-sonnet-4-5-20250929', effort: 'low', authSource: 'claude-subscription' });
    await expect(async () => { for await (const event of unknownAdapter.execute(verificationRequest('claude-unknown-429'), new AbortController().signal)) void event; })
      .rejects.toMatchObject({ code: 'provider.cli_failed' });
  });
});
