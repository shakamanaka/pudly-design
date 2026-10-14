import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { PROVIDER_EFFORTS, type ProviderEffort, type ProviderModelCapability } from '../../domain/providers.js';

export type CodexModelListRequest = { limit: number; includeHidden: true; cursor?: string };
export type CodexModelCatalogResult = { models: ProviderModelCapability[]; catalogStatus: 'known' | 'partial' | 'unknown' };
export type CodexModelPageReader = (request: CodexModelListRequest) => Promise<unknown>;
export type CodexModelCatalogOptions = {
  executable?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxPages?: number;
  pageSize?: number;
  killGraceMs?: number;
};

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_KILL_GRACE_MS = 250;
const EFFORTS: ReadonlySet<string> = new Set(PROVIDER_EFFORTS);

/** Collects the account catalog using only read-only model/list requests. */
export class CodexModelCatalog {
  static async discover(reader?: CodexModelPageReader, options: CodexModelCatalogOptions = {}): Promise<CodexModelCatalogResult> {
    const bounded = normalizeOptions(options);
    let session: AppServerSession | undefined;
    const readPage: CodexModelPageReader = reader ?? (async request => {
      session ??= new AppServerSession(bounded);
      return session.request(request);
    });
    let timeoutReject: ((error: Error) => void) | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => { timeoutReject = reject; });
    const timer = setTimeout(() => {
      session?.terminate();
      timeoutReject?.(new Error('Codex model discovery timed out.'));
    }, bounded.timeoutMs);
    const boundedReader: CodexModelPageReader = request => Promise.race([readPage(request), timeoutPromise]);
    try {
      return await collectPages(boundedReader, bounded);
    } catch {
      return { models: [], catalogStatus: 'unknown' };
    } finally {
      clearTimeout(timer);
      await session?.close();
    }
  }
}

export async function collectCodexModelPages(reader: CodexModelPageReader, options: Pick<CodexModelCatalogOptions, 'maxPages' | 'pageSize'> = {}): Promise<CodexModelCatalogResult> {
  return collectPages(reader, normalizeOptions(options));
}

async function collectPages(reader: CodexModelPageReader, options: Required<CodexModelCatalogOptions>): Promise<CodexModelCatalogResult> {
  const models = new Map<string, ProviderModelCapability>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let partial = false;
  for (let page = 0; page < options.maxPages; page++) {
    let raw: unknown;
    try { raw = await reader({ limit: options.pageSize, includeHidden: true, ...(cursor ? { cursor } : {}) }); }
    catch { partial = true; break; }
    if (!isRecord(raw) || !Array.isArray(raw.data) || !(raw.nextCursor === null || (typeof raw.nextCursor === 'string' && raw.nextCursor.length <= 500))) {
      partial = true;
      break;
    }
    for (const value of raw.data) {
      const parsed = parseModel(value);
      if (!parsed) { partial = true; continue; }
      if (parsed.partial) partial = true;
      if (!models.has(parsed.model.id)) models.set(parsed.model.id, parsed.model);
    }
    if (raw.nextCursor === null) return { models: [...models.values()], catalogStatus: partial ? (models.size ? 'partial' : 'unknown') : 'known' };
    if (cursors.has(raw.nextCursor)) { partial = true; break; }
    cursors.add(raw.nextCursor);
    cursor = raw.nextCursor;
  }
  if (cursor !== undefined) partial = true;
  return { models: [...models.values()], catalogStatus: models.size === 0 ? 'unknown' : partial ? 'partial' : 'known' };
}

function parseModel(input: unknown): { model: ProviderModelCapability; partial: boolean } | undefined {
  if (!isRecord(input) || typeof input.id !== 'string' || !input.id.trim() || input.id.length > 200) return undefined;
  const catalogId = input.id;
  const id = typeof input.model === 'string' && input.model.trim().length > 0 && input.model.length <= 200 ? input.model : catalogId;
  let partial = false;
  const label = typeof input.displayName === 'string' && input.displayName.trim().length > 0 && input.displayName.length <= 240 ? input.displayName : id;
  if (input.displayName !== undefined && label === id && input.displayName !== id) partial = true;
  const supportedEfforts: ProviderEffort[] = [];
  if (Array.isArray(input.supportedReasoningEfforts)) {
    for (const item of input.supportedReasoningEfforts) {
      if (!isRecord(item) || typeof item.reasoningEffort !== 'string' || !EFFORTS.has(item.reasoningEffort)) { partial = true; continue; }
      const effort = item.reasoningEffort as ProviderEffort;
      if (!supportedEfforts.includes(effort)) supportedEfforts.push(effort);
    }
  } else partial = true;
  const hidden = input.hidden;
  if (hidden !== undefined && typeof hidden !== 'boolean') partial = true;
  let defaultEffort: ProviderEffort | undefined;
  if (input.defaultReasoningEffort !== undefined) {
    if (typeof input.defaultReasoningEffort === 'string' && EFFORTS.has(input.defaultReasoningEffort)) defaultEffort = input.defaultReasoningEffort as ProviderEffort;
    else partial = true;
  }
  return {
    model: {
      id,
      label,
      availability: 'unknown',
      entitlement: null,
      supportedEfforts,
      ...(defaultEffort ? { defaultEffort } : {}),
      ...(typeof hidden === 'boolean' ? { hidden } : {}),
      ...(catalogId !== id ? { catalogId } : {}),
    },
    partial,
  };
}

class AppServerSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly rl;
  private nextId = 1;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private closed = false;
  private processError?: Error;
  private initialized: Promise<void>;

  constructor(private readonly options: Required<CodexModelCatalogOptions>) {
    const child = spawn(options.executable, ['app-server', '--listen', 'stdio://', '-c', 'mcp_servers={}'], {
      cwd: tmpdir(),
      env: safeCodexEnvironment(),
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl.on('line', line => this.onLine(line));
    child.stdout.on('data', (chunk: Buffer) => { this.stdoutBytes += chunk.byteLength; this.checkOutput(); });
    child.stderr.on('data', (chunk: Buffer) => { this.stderrBytes += chunk.byteLength; this.checkOutput(); });
    child.once('error', error => { this.processError = error; this.rejectPending(new Error('Codex app-server could not start.')); });
    child.once('close', () => { this.closed = true; this.rejectPending(new Error('Codex app-server closed before replying.')); });
    this.initialized = this.initialize();
  }

  async request(params: CodexModelListRequest): Promise<unknown> {
    await this.initialized;
    const result = await this.sendRequest('model/list', params);
    if (!isRecord(result)) throw new Error('Codex model catalog response is invalid.');
    return result;
  }

  async close(): Promise<void> {
    this.rl.close();
    if (!this.closed) this.child.stdin.end();
    this.terminate();
    await new Promise<void>(resolve => {
      if (this.closed) return resolve();
      const timer = setTimeout(resolve, this.options.killGraceMs + 50);
      this.child.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }

  terminate(): void {
    if (this.child.pid) signalProcessTree(this.child, 'SIGTERM');
    const child = this.child;
    const grace = this.options.killGraceMs;
    // Always signal the captured process group after the grace period, even if the
    // parent closes first and a descendant keeps the original group alive.
    setTimeout(() => signalProcessTree(child, 'SIGKILL'), grace).unref();
  }

  private async initialize(): Promise<void> {
    await this.sendRequest('initialize', { clientInfo: { name: 'pudly_catalog', title: 'Pudly model catalog', version: '1.0.0' } });
    if (!this.closed) this.child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    if (this.closed || this.processError) return Promise.reject(new Error('Codex app-server is unavailable.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, error => {
        if (error) {
          this.pending.delete(id);
          reject(new Error('Codex app-server request could not be sent.'));
        }
      });
    });
  }

  private onLine(line: string): void {
    let message: unknown;
    try { message = JSON.parse(line); } catch { this.rejectPending(new Error('Codex app-server returned malformed JSON.')); this.terminate(); return; }
    if (!isRecord(message) || !Number.isSafeInteger(message.id)) return;
    const pending = this.pending.get(message.id as number);
    if (!pending) return;
    this.pending.delete(message.id as number);
    if (message.error !== undefined) pending.reject(new Error('Codex app-server request failed.'));
    else if (!Object.hasOwn(message, 'result')) pending.reject(new Error('Codex app-server response is malformed.'));
    else pending.resolve(message.result);
  }

  private checkOutput(): void {
    if (this.stdoutBytes + this.stderrBytes <= this.options.maxOutputBytes) return;
    this.rejectPending(new Error('Codex app-server output exceeded its limit.'));
    this.terminate();
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

function normalizeOptions(options: CodexModelCatalogOptions): Required<CodexModelCatalogOptions> {
  const result = {
    executable: options.executable ?? 'codex',
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? MAX_OUTPUT_BYTES,
    maxPages: options.maxPages ?? MAX_PAGES,
    pageSize: options.pageSize ?? PAGE_SIZE,
    killGraceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
  };
  for (const value of [result.timeoutMs, result.maxOutputBytes, result.maxPages, result.pageSize, result.killGraceMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Codex model catalog limits must be positive safe integers.');
  }
  if (result.maxPages > MAX_PAGES || result.pageSize > PAGE_SIZE || result.maxOutputBytes > MAX_OUTPUT_BYTES) throw new RangeError('Codex model catalog limits exceed the safe maximum.');
  return result;
}

function safeCodexEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'CODEX_HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, signal); return; } catch { /* Fall back to the child when the group is gone. */ }
  }
  try { child.kill(signal); } catch { /* A concurrent exit makes signalling unnecessary. */ }
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
