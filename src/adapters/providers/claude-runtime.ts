import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProviderEffort } from '../../domain/providers.js';
import { ProviderAdapterError } from './shared.js';

const ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'CLAUDE_CONFIG_DIR'] as const;
const CATALOG_LIMIT = 128 * 1024;
const EFFORTS: readonly ProviderEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export type ClaudeLocalSession = { status: 'unknown' | 'authenticated' | 'unauthenticated'; checkedAt?: string };
export type ClaudeDiscoveredModel = { id: string; label: string; supportedEfforts: ProviderEffort[] };
export type ClaudeModelCatalog = { models: ClaudeDiscoveredModel[]; catalogStatus: 'known' | 'partial' | 'unknown' };

/** Keep only process identity and runtime necessities. Ambient provider credentials never cross this boundary. */
export function claudeEnvironment(authSource: 'claude-subscription' | 'anthropic-api-key', credential?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  if (authSource === 'anthropic-api-key' && credential) env.ANTHROPIC_API_KEY = credential;
  return env;
}

export async function checkClaudeLocalSession(input: { executable?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; tempRoot?: string } = {}): Promise<ClaudeLocalSession> {
  const checkedAt = new Date().toISOString();
  const cwd = await mkdtemp(join(input.tempRoot ?? tmpdir(), 'codex-design-claude-auth-'));
  try {
    const result = await collectCli({ executable: input.executable ?? 'claude', args: ['auth', 'status'], env: input.env ?? claudeEnvironment('claude-subscription'), cwd, timeoutMs: boundedTimeout(input.timeoutMs, 5_000), maxOutputBytes: 16 * 1024 });
    const parsed: unknown = JSON.parse(result.stdout);
    if (!isRecord(parsed) || typeof parsed.loggedIn !== 'boolean') return { status: 'unknown', checkedAt };
    if (parsed.loggedIn && result.exitCode !== 0) return { status: 'unknown', checkedAt };
    return { status: parsed.loggedIn ? 'authenticated' : 'unauthenticated', checkedAt };
  } catch {
    return { status: 'unknown', checkedAt };
  } finally { await rm(cwd, { recursive: true, force: true }).catch(() => undefined); }
}

/** Read the CLI's SDK initialization model list without sending a user message. */
export async function discoverClaudeModels(input: { executable?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; tempRoot?: string } = {}): Promise<ClaudeModelCatalog> {
  const cwd = await mkdtemp(join(input.tempRoot ?? tmpdir(), 'codex-design-claude-models-'));
  try {
    const response = await collectInitialization({
      executable: input.executable ?? 'claude',
      args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--tools', '', '--disallowedTools', 'mcp__*', '--permission-prompts', 'none', '--safe-mode', '--restricted'],
      env: input.env ?? claudeEnvironment('claude-subscription'), cwd,
      timeoutMs: boundedTimeout(input.timeoutMs, 8_000),
    });
    return parseClaudeModels(response);
  } catch {
    return { models: [], catalogStatus: 'unknown' };
  } finally { await rm(cwd, { recursive: true, force: true }).catch(() => undefined); }
}

function parseClaudeModels(systemMessage: unknown): ClaudeModelCatalog {
  if (!isRecord(systemMessage) || !Array.isArray(systemMessage.models)) return { models: [], catalogStatus: 'unknown' };
  const models: ClaudeDiscoveredModel[] = [];
  const seen = new Set<string>();
  let partial = false;
  for (const candidate of systemMessage.models) {
    if (!isRecord(candidate) || typeof candidate.value !== 'string' || !candidate.value.trim() || candidate.value.length > 200 || typeof candidate.displayName !== 'string' || !candidate.displayName.trim() || candidate.displayName.length > 200 || seen.has(candidate.value)) { partial = true; continue; }
    seen.add(candidate.value);
    if (!Array.isArray(candidate.supportedEffortLevels)) partial = true;
    const supportedEfforts = Array.isArray(candidate.supportedEffortLevels)
      ? [...new Set(candidate.supportedEffortLevels.filter((level): level is ProviderEffort => typeof level === 'string' && EFFORTS.includes(level as ProviderEffort)))]
      : [];
    if (Array.isArray(candidate.supportedEffortLevels) && supportedEfforts.length !== candidate.supportedEffortLevels.length) partial = true;
    models.push({ id: candidate.value, label: candidate.displayName, supportedEfforts });
  }
  return { models, catalogStatus: models.length ? partial ? 'partial' : 'known' : 'unknown' };
}

async function collectInitialization(input: { executable: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, { cwd: input.cwd, env: input.env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const groupId = process.platform !== 'win32' ? child.pid : undefined;
    let stdout = '';
    let stderrBytes = 0;
    let bytes = 0;
    let settled = false;
    let finishing = false;
    let pendingError: Error | undefined;
    let pendingValue: unknown;
    const stop = () => {
      if (groupId) { try { process.kill(-groupId, 'SIGTERM'); } catch { /* Process has exited. */ } }
      else child.kill('SIGTERM');
      void delay(250).then(() => { if (groupId) { try { process.kill(-groupId, 'SIGKILL'); } catch { /* Process group has exited. */ } } else child.kill('SIGKILL'); });
    };
    const finish = (error?: Error, value?: unknown) => {
      if (settled || finishing) return;
      finishing = true;
      clearTimeout(timer);
      pendingError = error; pendingValue = value; stop();
    };
    const timer = setTimeout(() => finish(new ProviderAdapterError('Claude model discovery exceeded its time limit.', 'provider.timeout')), input.timeoutMs);
    child.once('error', () => finish(new ProviderAdapterError('Claude model discovery could not start.', 'provider.transport')));
    child.once('close', (code: number | null) => {
      if (settled) return;
      if (!pendingError && !pendingValue) pendingError = new ProviderAdapterError(code === 0 ? 'Claude model discovery returned no SDK response.' : 'Claude model discovery could not complete.', 'provider.invalid_response');
      settled = true; clearTimeout(timer);
      if (pendingError) reject(pendingError);
      else resolve(pendingValue);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes + stderrBytes > CATALOG_LIMIT) { finish(new ProviderAdapterError('Claude model discovery returned too much data.', 'provider.output_too_large')); return; }
      stdout += chunk.toString('utf8');
      for (const line of stdout.split(/\r?\n/)) {
        let message: unknown;
        try { message = JSON.parse(line); } catch { continue; }
        if (isRecord(message) && message.type === 'control_response' && isRecord(message.response) && message.response.request_id === 'codex-design-init') {
          const response = message.response;
          if (response.subtype === 'success' && isRecord(response.response) && Array.isArray(response.response.models)) finish(undefined, response.response);
          else finish(new ProviderAdapterError('Claude model discovery returned an incomplete SDK response.', 'provider.invalid_response'));
          return;
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (bytes + stderrBytes > CATALOG_LIMIT) finish(new ProviderAdapterError('Claude model discovery returned too much data.', 'provider.output_too_large'));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify({ type: 'control_request', request_id: 'codex-design-init', request: { subtype: 'initialize' } }) + '\n');
  });
}

async function collectCli(input: { executable: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number; maxOutputBytes: number }): Promise<{ stdout: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, { cwd: input.cwd, env: input.env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const groupId = process.platform !== 'win32' ? child.pid : undefined;
    let stdout = ''; let bytes = 0; let stderrBytes = 0; let settled = false; let finishing = false;
    let pendingError: Error | undefined;
    let result: { stdout: string; exitCode: number | null } | undefined;
    const terminate = () => { if (groupId) { try { process.kill(-groupId, 'SIGTERM'); } catch { /* Process group exited. */ } } else child.kill('SIGTERM'); void delay(250).then(() => { if (groupId) { try { process.kill(-groupId, 'SIGKILL'); } catch { /* Process group exited. */ } } else child.kill('SIGKILL'); }); };
    const finish = (error?: Error, value?: { stdout: string; exitCode: number | null }) => { if (settled || finishing) return; finishing = true; clearTimeout(timer); pendingError = error; result = value; if (error) terminate(); };
    const timer = setTimeout(() => finish(new ProviderAdapterError('Claude authentication status check exceeded its time limit.', 'provider.timeout')), input.timeoutMs);
    child.once('error', () => finish(new ProviderAdapterError('Claude authentication status could not be read.', 'provider.transport')));
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes + stderrBytes > input.maxOutputBytes) { finish(new ProviderAdapterError('Claude authentication status returned too much data.', 'provider.output_too_large')); return; } stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.byteLength; if (bytes + stderrBytes > input.maxOutputBytes) finish(new ProviderAdapterError('Claude authentication status returned too much data.', 'provider.output_too_large')); });
    child.once('close', code => {
      if (!finishing) { finishing = true; clearTimeout(timer); result = { stdout, exitCode: code }; }
      settled = true;
      if (pendingError) reject(pendingError);
      else resolve(result!);
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function boundedTimeout(value: number | undefined, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? Math.min(30_000, Math.max(1, Math.floor(value))) : fallback; }
