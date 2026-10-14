import { designGenerationTimeout } from '../../application/design-brief.js';
import { CodingAgentError } from '../../domain/agent-error.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentStatus, CodingAgent, CodingAgentRequest, Diagnostic, RunEvent, RunState } from '../../domain/types.js';
import type { ProviderEffort } from '../../domain/providers.js';
import { killCliHandle, runCliTransport, type CliProcessHandle, type CliTransportOptions, type CliTransportResult } from './cli-transport.js';
import { claudeEnvironment } from './claude-runtime.js';
import { lifecycleEvents, parseProviderJson, providerPrompt, resultEvents, ProviderAdapterError } from './shared.js';

export type ClaudeCodeAdapterOptions = CliTransportOptions & {
  executable?: string;
  tempRoot?: string;
  model: string;
  effort: ProviderEffort;
  authSource: 'claude-subscription' | 'anthropic-api-key';
  credential?: string;
};
type ActiveRun = CliProcessHandle & { state: RunState; startedAt: string; finishedAt?: string; diagnostic?: Diagnostic };

const CLAUDE_EFFORTS: readonly ProviderEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export class ClaudeCodeAdapter implements CodingAgent {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly options: ClaudeCodeAdapterOptions & { executable: string };

  constructor(options: ClaudeCodeAdapterOptions) {
    if (!options.model.trim()) throw new RangeError('A Claude model ID is required.');
    if (options.effort !== 'default' && !CLAUDE_EFFORTS.includes(options.effort)) throw new RangeError('The selected effort is unsupported by Claude Code.');
    if (options.authSource === 'anthropic-api-key' && !options.credential) throw new RangeError('An Anthropic API key is required.');
    if (options.authSource === 'claude-subscription' && options.credential) throw new RangeError('Claude subscription authentication uses the local Claude Code account.');
    this.options = { ...options, executable: options.executable ?? 'claude' };
  }

  async *execute(request: CodingAgentRequest, signal: AbortSignal): AsyncIterable<RunEvent | { type: 'response'; response: import('../../domain/types.js').CodingAgentResponse }> {
    if (!request.runId || this.runs.has(request.runId)) throw new ProviderAdapterError('Run ID is missing or already active.', 'run.duplicate');
    const { prompt, capabilities, schema } = providerPrompt(request, 'Claude Code');
    const run: ActiveRun = { cancelRequested: signal.aborted, state: 'QUEUED', startedAt: new Date().toISOString() };
    this.runs.set(request.runId, run);
    yield lifecycleEvents(request.runId, 'QUEUED');
    try {
      if (signal.aborted) { run.state = 'CANCELLED'; run.finishedAt = new Date().toISOString(); yield lifecycleEvents(request.runId, 'CANCELLED'); return; }
      run.state = 'PLANNING'; yield lifecycleEvents(request.runId, 'PLANNING');
      const args = [
        '-p', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(schema), '--model', this.options.model,
        '--no-session-persistence', '--tools', '', '--disallowedTools', 'mcp__*', '--permission-prompts', 'none',
        '--safe-mode', '--restricted',
      ];
      if (this.options.effort !== 'default') args.push('--effort', this.options.effort);
      if (this.options.authSource === 'anthropic-api-key') args.push('--bare');
      const workingDirectory = await mkdtemp(join(this.options.tempRoot ?? tmpdir(), 'codex-design-claude-'));
      let stdout: CliTransportResult | null;
      try {
        stdout = await runCliTransport({ executable: this.options.executable, args, prompt, env: claudeEnvironment(this.options.authSource, this.options.credential), cwd: workingDirectory, signal, handle: run, options: { ...this.options, timeoutMs: designGenerationTimeout(request, this.options.timeoutMs), allowNonzeroExit: true } });
      } finally { await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined); }
      if (run.cancelRequested || signal.aborted || stdout === null) { run.state = 'CANCELLED'; run.finishedAt = new Date().toISOString(); yield lifecycleEvents(request.runId, 'CANCELLED'); return; }
      run.state = 'VALIDATING_OPERATIONS'; yield lifecycleEvents(request.runId, 'VALIDATING_OPERATIONS');
      const responseBody = this.responseBody(stdout.stdout);
      if (stdout.exitCode !== 0) throw new ProviderAdapterError('Claude Code exited unsuccessfully without a recognized structured provider error.', 'provider.cli_failed');
      const response = parseProviderJson(responseBody, capabilities);
      for (const event of resultEvents(request.runId, response)) yield event;
      run.finishedAt = new Date().toISOString(); run.state = 'SUCCEEDED';
      yield lifecycleEvents(request.runId, 'SUCCEEDED');
      yield { type: 'response', response };
    } catch (error) {
      if (run.cancelRequested || signal.aborted) { run.finishedAt = new Date().toISOString(); run.state = 'CANCELLED'; yield lifecycleEvents(request.runId, 'CANCELLED'); return; }
      const safe = error instanceof CodingAgentError ? error : new ProviderAdapterError('Claude Code failed while producing a structured response.', 'agent.adapter_error');
      run.diagnostic = { code: safe.code, message: safe.message, severity: 'error' };
      run.state = 'FAILED'; run.finishedAt = new Date().toISOString();
      yield { type: 'diagnostic', runId: request.runId, diagnostic: run.diagnostic };
      yield lifecycleEvents(request.runId, 'FAILED');
      throw safe;
    }
  }

  async cancel(runId: string): Promise<void> { const run = this.runs.get(runId); if (run && !run.finishedAt) killCliHandle(run, this.options.killGraceMs); }
  async getStatus(runId: string): Promise<AgentStatus> {
    const run = this.runs.get(runId);
    if (!run) throw new ProviderAdapterError('No Claude Code run exists with that ID.', 'run.not_found');
    return { runId, state: run.state, startedAt: run.startedAt, ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}) };
  }

  private responseBody(stdout: string): string {
    let resultOutput: string | undefined;
    const lines = stdout.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop(); // A final newline is standard NDJSON framing.
    for (const line of lines) {
      if (!line.trim()) throw new ProviderAdapterError('Claude Code returned a blank stream event.', 'protocol.invalid_json');
      let event: unknown;
      try { event = JSON.parse(line); } catch { throw new ProviderAdapterError('Claude Code returned a malformed stream event.', 'protocol.invalid_json'); }
      if (!isRecord(event) || typeof event.type !== 'string') throw new ProviderAdapterError('Claude Code returned an invalid stream event.', 'protocol.response_missing');
      if (resultOutput !== undefined) throw new ProviderAdapterError('Claude Code returned data after its final structured result.', 'protocol.response_missing');
      if (event.type === 'error') throw claudeStructuredFailure(event);
      if (event.type === 'result') {
        if (event.is_error === true || event.subtype !== 'success') throw claudeStructuredFailure(event);
        if (event.is_error !== false || !isRecord(event.structured_output)) throw new ProviderAdapterError('Claude Code omitted its structured design response.', 'protocol.response_missing');
        resultOutput = JSON.stringify(event.structured_output);
        continue;
      }
      if (!CLAUDE_STREAM_METADATA_TYPES.has(event.type)) throw new ProviderAdapterError('Claude Code returned an unsupported stream event.', 'protocol.response_missing');
    }
    if (resultOutput === undefined) throw new ProviderAdapterError('Claude Code did not return a final structured result.', 'protocol.response_missing');
    return resultOutput;
  }
}

const CLAUDE_STREAM_METADATA_TYPES = new Set([
  'assistant', 'user', 'system', 'stream_event', 'control_request', 'control_response',
  'tool_progress', 'auth_status', 'rate_limit_event', 'prompt_suggestion', 'task_notification',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function claudeStructuredFailure(record: Record<string, unknown>): ProviderAdapterError {
  const nested = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
    ? record.error as Record<string, unknown> : record;
  // Claude's result envelope can report account usage exhaustion while keeping
  // `subtype: success`; this exact stable code is quota evidence. A bare HTTP
  // 429 or arbitrary prose is intentionally insufficient to classify quota.
  if (record.api_error === 'usage_limit_reached') return new ProviderAdapterError('Claude reports that this account has reached its usage limit.', 'provider.quota');
  // These stable error type identifiers are part of Anthropic's documented
  // API error envelope. Provider prose and stderr are deliberately ignored.
  const type = typeof nested.type === 'string' ? nested.type : undefined;
  if (type === 'authentication_error') return new ProviderAdapterError('Claude rejected this connection. Reconnect it and try again.', 'provider.authentication');
  if (type === 'billing_error') return new ProviderAdapterError('Claude reported a billing or quota problem for this connection.', 'provider.quota');
  if (type === 'rate_limit_error') return new ProviderAdapterError('Claude is rate limiting this connection. Try again later.', 'provider.rate_limit');
  if (record.subtype === 'error_max_structured_output_retries') return new ProviderAdapterError('Claude could not produce valid structured design operations after its bounded format retries. No design was applied.', 'protocol.invalid_response');
  if (record.subtype === 'error_max_turns') return new ProviderAdapterError('Claude stopped after reaching its configured turn limit.', 'provider.execution_limit');
  return new ProviderAdapterError('Claude Code reported a structured execution error.', 'provider.cli_failed');
}
