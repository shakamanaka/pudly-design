import { designGenerationTimeout } from '../../application/design-brief.js';
import { CodingAgentError } from '../../domain/agent-error.js';
import type { AgentStatus, CodingAgent, CodingAgentRequest, Diagnostic, RunEvent, RunState } from '../../domain/types.js';
import type { ProviderEffort } from '../../domain/providers.js';
import { lifecycleEvents, parseProviderJson, providerPrompt, resultEvents, ProviderAdapterError } from './shared.js';

export type MiniMaxAdapterOptions = {
  model: string;
  effort: ProviderEffort;
  credential: string;
  endpoint?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  fetcher?: typeof fetch;
};
type ActiveRun = { controller?: AbortController; state: RunState; startedAt: string; finishedAt?: string; cancelRequested: boolean; diagnostic?: Diagnostic };
type MiniMaxResponse = { choices?: Array<{ message?: { content?: unknown } }> };

/** MiniMax's public OpenAI-compatible text endpoint; no model effort knob is assumed. */
export class MiniMaxAdapter implements CodingAgent {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly explicitTimeout: number | undefined;
  private readonly options: MiniMaxAdapterOptions & { endpoint: string; timeoutMs: number; maxOutputBytes: number; fetcher: typeof fetch };
  constructor(options: MiniMaxAdapterOptions) {
    if (!options.model.trim()) throw new RangeError('A MiniMax model ID is required.');
    if (!options.credential) throw new RangeError('A MiniMax credential is required.');
    if (options.effort !== 'default') throw new RangeError('MiniMax effort control is not documented by this adapter; use provider default.');
    this.explicitTimeout = options.timeoutMs;
    const timeoutMs = options.timeoutMs ?? 300_000;
    const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new RangeError('Provider limits must be positive safe integers.');
    this.options = { ...options, endpoint: options.endpoint ?? 'https://api.minimax.io/v1/chat/completions', timeoutMs, maxOutputBytes, fetcher: options.fetcher ?? fetch };
  }

  async *execute(request: CodingAgentRequest, signal: AbortSignal): AsyncIterable<RunEvent | { type: 'response'; response: import('../../domain/types.js').CodingAgentResponse }> {
    if (!request.runId || this.runs.has(request.runId)) throw new ProviderAdapterError('Run ID is missing or already active.', 'run.duplicate');
    const { prompt, capabilities, schema } = providerPrompt(request, 'MiniMax');
    const run: ActiveRun = { cancelRequested: signal.aborted, state: 'QUEUED', startedAt: new Date().toISOString() };
    this.runs.set(request.runId, run);
    yield lifecycleEvents(request.runId, 'QUEUED');
    try {
      if (signal.aborted) { run.state = 'CANCELLED'; run.finishedAt = new Date().toISOString(); yield lifecycleEvents(request.runId, 'CANCELLED'); return; }
      run.state = 'PLANNING'; yield lifecycleEvents(request.runId, 'PLANNING');
      const controller = new AbortController(); run.controller = controller;
      const abort = () => { run.cancelRequested = true; controller.abort(); };
      signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(() => controller.abort(), designGenerationTimeout(request, this.explicitTimeout));
      run.state = 'RUNNING'; yield lifecycleEvents(request.runId, 'RUNNING');
      let response: Response;
      let raw: string;
      try {
        response = await this.options.fetcher(this.options.endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.options.credential}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.options.model, messages: [{ role: 'user', content: `${prompt}\n\nThe required response schema is:\n${JSON.stringify(schema)}` }], response_format: { type: 'json_object' }, stream: false }),
          signal: controller.signal,
        });
        raw = await readBoundedBody(response, this.options.maxOutputBytes);
        if (!response.ok) throw minimaxHttpFailure(response.status, raw);
      } catch (error) {
        if (error instanceof ProviderAdapterError) throw error;
        if (run.cancelRequested || signal.aborted) { run.state = 'CANCELLED'; run.finishedAt = new Date().toISOString(); yield lifecycleEvents(request.runId, 'CANCELLED'); return; }
        if (controller.signal.aborted) throw new ProviderAdapterError('MiniMax exceeded the run time limit.', 'agent.timeout');
        throw new ProviderAdapterError('MiniMax could not be reached. Check the connection and try again.', 'provider.network');
      } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); delete run.controller; }
      let envelope: MiniMaxResponse;
      try { envelope = JSON.parse(raw) as MiniMaxResponse; } catch { throw new ProviderAdapterError('MiniMax returned invalid JSON output.', 'protocol.invalid_json'); }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || 'error' in envelope) {
        throw new ProviderAdapterError('MiniMax returned an invalid response envelope.', 'protocol.response_missing');
      }
      const content = envelope.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new ProviderAdapterError('MiniMax omitted its structured design response.', 'protocol.response_missing');
      run.state = 'VALIDATING_OPERATIONS'; yield lifecycleEvents(request.runId, 'VALIDATING_OPERATIONS');
      const result = parseProviderJson(content, capabilities);
      for (const event of resultEvents(request.runId, result)) yield event;
      run.state = 'SUCCEEDED'; run.finishedAt = new Date().toISOString();
      yield lifecycleEvents(request.runId, 'SUCCEEDED');
      yield { type: 'response', response: result };
    } catch (error) {
      if (run.cancelRequested || signal.aborted) { run.finishedAt = new Date().toISOString(); run.state = 'CANCELLED'; yield lifecycleEvents(request.runId, 'CANCELLED'); return; }
      const safe = error instanceof CodingAgentError ? error : new ProviderAdapterError('MiniMax failed while producing a structured response.', 'agent.adapter_error');
      run.diagnostic = { code: safe.code, message: safe.message, severity: 'error' };
      run.state = 'FAILED'; run.finishedAt = new Date().toISOString();
      yield { type: 'diagnostic', runId: request.runId, diagnostic: run.diagnostic };
      yield lifecycleEvents(request.runId, 'FAILED');
      throw safe;
    }
  }

  async cancel(runId: string): Promise<void> { const run = this.runs.get(runId); if (!run || run.finishedAt) return; run.cancelRequested = true; run.controller?.abort(); }
  async getStatus(runId: string): Promise<AgentStatus> {
    const run = this.runs.get(runId);
    if (!run) throw new ProviderAdapterError('No MiniMax run exists with that ID.', 'run.not_found');
    return { runId, state: run.state, startedAt: run.startedAt, ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}) };
  }
}

function minimaxHttpFailure(status: number, body: string): ProviderAdapterError {
  let type: string | undefined;
  try {
    const value: unknown = JSON.parse(body);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const root = value as Record<string, unknown>;
      const error = root.error && typeof root.error === 'object' && !Array.isArray(root.error)
        ? root.error as Record<string, unknown> : root;
      if (typeof error.type === 'string') type = error.type;
      else if (typeof error.code === 'string') type = error.code;
    }
  } catch { /* Provider error bodies are untrusted; status remains authoritative. */ }
  if (status === 401 || type === 'authentication_error' || type === 'invalid_api_key') {
    return new ProviderAdapterError('MiniMax rejected this connection. Reconnect it and try again.', 'provider.authentication');
  }
  if (status === 402 || type === 'billing_error' || type === 'insufficient_quota' || type === 'quota_exceeded') {
    return new ProviderAdapterError('MiniMax reported a billing or quota problem for this connection.', 'provider.quota');
  }
  if (status === 429 || type === 'rate_limit_error' || type === 'rate_limit_exceeded') {
    return new ProviderAdapterError('MiniMax is rate limiting this connection. Try again later.', 'provider.rate_limit');
  }
  return new ProviderAdapterError('MiniMax could not complete the request. Check the connection and model selection.', 'provider.transport');
}

async function readBoundedBody(response: Response, limit: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > limit) throw new ProviderAdapterError('MiniMax output exceeded the configured size limit.', 'agent.output_too_large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderAdapterError('MiniMax output exceeded the configured size limit.', 'agent.output_too_large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}
