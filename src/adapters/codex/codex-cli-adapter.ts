import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CodingAgentError } from "../../domain/agent-error";
import type { AgentStatus, CodingAgent, CodingAgentRequest, CodingAgentResponse, Diagnostic, OperationType, RunEvent, RunState } from "../../domain/types";
import { AgentProtocolError, buildResponseSchema, parseAgentResponse } from "./protocol";
import { operationReference } from './operation-reference';
import { buildDesignBrief, designGenerationTimeout } from '../../application/design-brief';

export type CodexCliAdapterOptions = {
  executable?: string;
  model?: string;
  effort?: "default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  authSource?: "chatgpt" | "openai-api-key";
  credential?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxPromptBytes?: number;
  tempRoot?: string;
  killGraceMs?: number;
};

type ActiveRun = {
  process?: ChildProcessWithoutNullStreams;
  state: RunState;
  startedAt: string;
  finishedAt?: string;
  cancelRequested: boolean;
  outputExceeded: boolean;
  diagnostic?: Diagnostic;
};

export class CodexAdapterError extends CodingAgentError {
  constructor(message: string, code: string, readonly exitCode?: number | null) {
    super(code, message);
    this.name = "CodexAdapterError";
  }
}

export const DEFAULT_GENERATION_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_MAX_PROMPT_BYTES = 262_144;
const DEFAULT_KILL_GRACE_MS = 1_000;
const CODEX_ENV_ALLOWLIST = [
  "PATH", "HOME", "CODEX_HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "APPDATA", "LOCALAPPDATA",
  "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
];

function codexEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CODEX_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

const SAFE_PROTOCOL_ERRORS: Readonly<Record<string, string>> = {
  "protocol.capability": "Codex returned an operation outside the negotiated design capabilities.",
  "protocol.unknown_field": "Codex returned an unsupported field in its design response.",
  "protocol.missing_field": "Codex omitted a required field from its design response.",
  "protocol.shape": "Codex returned a design operation with invalid field values or structure.",
  "protocol.unsafe_key": "Codex returned an unsafe key in its design response.",
  "protocol.duplicate_key": "Codex returned duplicate keys in its design response.",
  "protocol.response_shape": "Codex returned a response that is not a plain JSON object.",
  "protocol.operation_count": "Codex returned more than 500 design operations.",
  "protocol.summary_limit": "Codex returned a summary that exceeds the supported length.",
  "protocol.response_limit": "Codex returned a response that exceeds the supported size limit.",
  "protocol.operation_shape": "Codex returned a design operation with an invalid structure.",
};

export class CodexCliAdapter implements CodingAgent {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly options: Required<CodexCliAdapterOptions>;
  private readonly explicitTimeoutMs: number | undefined;

  constructor(options: CodexCliAdapterOptions = {}) {
    this.explicitTimeoutMs = options.timeoutMs;
    this.options = {
      executable: options.executable ?? "codex",
      model: options.model ?? "gpt-6.1-sol",
      effort: options.effort ?? "low",
      authSource: options.authSource ?? "chatgpt",
      credential: options.credential ?? "",
      timeoutMs: options.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      maxPromptBytes: options.maxPromptBytes ?? DEFAULT_MAX_PROMPT_BYTES,
      tempRoot: options.tempRoot ?? tmpdir(),
      killGraceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    };
    if (this.options.authSource === "openai-api-key" && !this.options.credential) throw new RangeError("An OpenAI API key is required for API-key authentication.");
    if (this.options.authSource === "chatgpt" && this.options.credential) throw new RangeError("ChatGPT authentication uses the local Codex CLI account.");
    for (const [name, value] of [
      ["timeoutMs", this.options.timeoutMs],
      ["maxOutputBytes", this.options.maxOutputBytes],
      ["maxPromptBytes", this.options.maxPromptBytes],
      ["killGraceMs", this.options.killGraceMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(String(name) + " must be a positive safe integer.");
    }
  }

  async *execute(request: CodingAgentRequest, signal: AbortSignal): AsyncIterable<RunEvent | { type: "response"; response: CodingAgentResponse }> {
    if (!request.runId || this.runs.has(request.runId)) throw new CodexAdapterError("Run ID is missing or already active.", "run.duplicate");
    const capabilities = this.readCapabilities(request.operationCapabilities);
    const prompt = this.buildPrompt(request);
    if (Buffer.byteLength(prompt, "utf8") > this.options.maxPromptBytes) {
      throw new CodexAdapterError("The scoped design prompt exceeds the configured size limit.", "prompt.too_large");
    }
    const run: ActiveRun = {
      state: "QUEUED",
      startedAt: new Date().toISOString(),
      cancelRequested: signal.aborted,
      outputExceeded: false,
    };
    this.runs.set(request.runId, run);
    let tempDirectory: string | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    let processError: Error | undefined;
    let exitCode: number | null = null;
    let stderrBytes = 0;
    let stdoutBytes = 0;
    let stdoutBuffer = "";
    let child: ChildProcessWithoutNullStreams | undefined;
    let settled = false;
    const events: RunEvent[] = [];
    let wake: (() => void) | undefined;
    const push = (event: RunEvent) => { events.push(event); wake?.(); wake = undefined; };
    const setState = (state: RunState) => {
      run.state = state;
      push({ type: "state", runId: request.runId, state, at: new Date().toISOString() });
    };
    const fail = (code: string, message: string) => {
      const diagnostic: Diagnostic = { code, message, severity: "error" };
      run.diagnostic = diagnostic;
      push({ type: "diagnostic", runId: request.runId, diagnostic });
      setState("FAILED");
    };
    const parseLine = (line: string) => {
      if (!line.trim()) return;
      let event: unknown;
      try { event = JSON.parse(line); } catch { throw new CodexAdapterError("Codex emitted malformed JSONL output.", "protocol.invalid_jsonl"); }
      if (!event || typeof event !== "object") throw new CodexAdapterError("Codex emitted an invalid JSONL event.", "protocol.invalid_event");
      const record = event as Record<string, unknown>;
      if (record.type === "error" || record.type === "turn.failed") {
        throw codexTurnError(record);
      }
      if (record.type === "item.started" || record.type === "item.completed" || record.type === "turn.started") {
        push({ type: "progress", runId: request.runId, phase: "RUNNING", message: "Codex is preparing design operations." });
      }
    };
    const terminate = (signalName: NodeJS.Signals = "SIGTERM") => {
      if (!child || settled) return;
      killOwnedProcess(child, signalName);
      const current = child;
      void delay(this.options.killGraceMs).then(() => {
        // The parent may close while a descendant keeps running; signal the
        // captured process group even if the adapter stream already settled.
        killOwnedProcess(current, "SIGKILL");
      });
    };

    try {
      setState("QUEUED");
      if (signal.aborted) { setState("CANCELLED"); yield* events.splice(0); return; }
      setState("PLANNING");
      tempDirectory = await mkdtemp(join(this.options.tempRoot, "codex-design-run-"));
      const schemaPath = join(tempDirectory, "response.schema.json");
      const resultPath = join(tempDirectory, "response.json");
      if (this.options.authSource === "openai-api-key") {
        const codexHome = join(tempDirectory, "codex-home");
        await mkdir(codexHome, { recursive: true, mode: 0o700 });
        await this.loginWithApiKey(codexHome, run, signal);
      }
      await writeFile(schemaPath, JSON.stringify(buildResponseSchema(capabilities)), { encoding: "utf8", flag: "wx", mode: 0o600 });
      if (signal.aborted || run.cancelRequested) { setState("CANCELLED"); yield* events.splice(0); return; }

      const args = [
        "exec", "--model", this.options.model,
        ...(this.options.effort === "default" ? [] : ["-c", `model_reasoning_effort=${JSON.stringify(this.options.effort)}`]),
        // Design generation is a structured transform of supplied context; do not give the model
        // command execution that could inspect process credentials or unrelated local files.
        "-c", "features.shell_tool=false", "-c", "features.unified_exec=false", "-c", "features.multi_agent=false", "-c", "features.web_search=false",
        "-c", 'shell_environment_policy.inherit="none"',
        "--json", "--output-schema", schemaPath, "--output-last-message", resultPath,
        "--ephemeral", "--ignore-user-config", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", tempDirectory, "-",
      ];
      child = spawn(this.options.executable, args, {
        cwd: tempDirectory, env: this.codexRunEnvironment(tempDirectory), shell: false, windowsHide: true,
        detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      });
      run.process = child;
      setState("RUNNING");
      child.once("error", (error) => { processError = error; });
      child.once("close", (code) => {
        exitCode = code;
        settled = true;
        wake?.();
        wake = undefined;
      });
      abortListener = () => { run.cancelRequested = true; terminate(); };
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted || run.cancelRequested) abortListener();
      timeout = setTimeout(() => {
        run.diagnostic = { code: "agent.timeout", message: "Codex exceeded the run time limit.", severity: "error" };
        terminate();
      }, designGenerationTimeout(request, this.explicitTimeoutMs));

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes + stderrBytes > this.options.maxOutputBytes) {
          run.outputExceeded = true;
          run.diagnostic = { code: "agent.output_too_large", message: "Codex output exceeded the configured size limit.", severity: "error" };
          terminate();
          return;
        }
        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        try { for (const line of lines) parseLine(line); }
        catch (error) { processError = error instanceof Error ? error : new Error("Codex event parsing failed."); terminate(); }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stdoutBytes + stderrBytes > this.options.maxOutputBytes) {
          run.outputExceeded = true;
          run.diagnostic = { code: "agent.output_too_large", message: "Codex output exceeded the configured size limit.", severity: "error" };
          terminate();
          return;
        }
        // Count stderr for resource bounds, but never retain or publish its contents.
      });
      child.stdin.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "EPIPE") processError = error;
      });
      child.stdin.end(prompt, "utf8");

      while (!settled || events.length > 0) {
        if (events.length) { yield events.shift()!; continue; }
        if (!settled) await new Promise<void>((resolve) => { wake = resolve; });
      }
      if (stdoutBuffer.trim() && !processError) {
        try { parseLine(stdoutBuffer); } catch (error) { processError = error instanceof Error ? error : new Error("Codex event parsing failed."); }
      }
      while (events.length) yield events.shift()!;

      if (run.cancelRequested || signal.aborted) { setState("CANCELLED"); yield* events.splice(0); return; }
      if (run.outputExceeded) throw new CodexAdapterError("Codex output exceeded the configured size limit.", "agent.output_too_large");
      if (run.diagnostic?.code === "agent.timeout") throw new CodexAdapterError("Generation took longer than the configured time limit. Try generating a smaller section; your saved design is preserved.", run.diagnostic.code, exitCode);
      if (processError instanceof CodexAdapterError) throw processError;
      if (processError instanceof AgentProtocolError) throw protocolError(processError, exitCode);
      if (processError) throw new CodexAdapterError("Codex could not be started or its process failed. Check that the configured CLI is available.", "agent.process_error", exitCode);
      if (exitCode !== 0) throw new CodexAdapterError("Codex exited unsuccessfully. Review the request and retry.", "agent.exit_failed", exitCode);

      const resultStats = await stat(resultPath).catch(() => undefined);
      if (!resultStats?.isFile()) throw new CodexAdapterError("Codex completed without writing its structured response.", "protocol.response_missing", exitCode);
      if (resultStats.size > this.options.maxOutputBytes) throw new CodexAdapterError("Codex response exceeded the configured size limit.", "agent.output_too_large");
      let value: unknown;
      try { value = JSON.parse(await readFile(resultPath, "utf8")); }
      catch { throw new CodexAdapterError("Codex final response is not valid JSON.", "protocol.invalid_response"); }
      const response = parseAgentResponse(value, capabilities);
      if (run.cancelRequested || signal.aborted) { setState("CANCELLED"); yield* events.splice(0); return; }
      for (const [index, operation] of response.operations.entries()) {
        push({ type: "operation-proposed", runId: request.runId, index, operationType: operation.type });
      }
      setState("VALIDATING_OPERATIONS");
      run.finishedAt = new Date().toISOString();
      while (events.length) yield events.shift()!;
      yield { type: "response", response };
    } catch (error) {
      const adapterError = error instanceof CodexAdapterError
        ? error
        : error instanceof AgentProtocolError
          ? protocolError(error, exitCode)
        : new CodexAdapterError("Codex adapter failed while preparing the structured response.", "agent.adapter_error", exitCode);
      if (run.cancelRequested || signal.aborted) {
        setState("CANCELLED");
        yield* events.splice(0);
      } else {
        fail(adapterError.code, adapterError.message);
        run.finishedAt = new Date().toISOString();
        while (events.length) yield events.shift()!;
        throw adapterError;
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortListener) signal.removeEventListener("abort", abortListener);
      delete run.process;
      if (!run.finishedAt) run.finishedAt = new Date().toISOString();
      if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private codexRunEnvironment(tempDirectory: string): NodeJS.ProcessEnv {
    const env = codexEnvironment();
    if (this.options.authSource === "openai-api-key") {
      // API-key runs get a run-local Codex home and never read or mutate the user's CLI login.
      env.CODEX_HOME = join(tempDirectory, "codex-home");
    }
    return env;
  }

  private async loginWithApiKey(codexHome: string, run: ActiveRun, signal: AbortSignal): Promise<void> {
    const env = codexEnvironment();
    env.CODEX_HOME = codexHome;
    const child = spawn(this.options.executable, ["login", "--with-api-key"], {
      cwd: codexHome, env, shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    run.process = child;
    let outputBytes = 0;
    let spawnError: Error | undefined;
    let timedOut = false;
    const countOutput = (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 16_384) killOwnedProcess(child, "SIGTERM");
      // Auth output is deliberately discarded; never retain provider or credential text.
    };
    child.stdout.on("data", countOutput);
    child.stderr.on("data", countOutput);
    child.stdin.on("error", () => { /* The child may exit before consuming stdin; report only a safe auth failure. */ });
    child.once("error", error => { spawnError = error; });
    const abort = () => killOwnedProcess(child, "SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; killOwnedProcess(child, "SIGTERM"); }, Math.min(this.options.timeoutMs, 20_000));
    const forceTimer = setTimeout(() => killOwnedProcess(child, "SIGKILL"), Math.min(this.options.timeoutMs, 20_000) + this.options.killGraceMs);
    try {
      if (signal.aborted) abort();
      child.stdin.end(this.options.credential, "utf8");
      const close = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
        child.once("close", (code, childSignal) => resolve({ code, signal: childSignal }));
      });
      if (signal.aborted || run.cancelRequested) throw new CodexAdapterError("The run was cancelled during provider authentication.", "agent.cancelled");
      if (timedOut) throw new CodexAdapterError("Codex API-key authentication exceeded its time limit.", "auth.timeout");
      if (outputBytes > 16_384) throw new CodexAdapterError("Codex authentication output exceeded the configured size limit.", "auth.output_too_large");
      if (spawnError || close.code !== 0) throw new CodexAdapterError("Codex API-key authentication failed in the isolated run environment.", "auth.failed", close.code);
    } finally {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal.removeEventListener("abort", abort);
      delete run.process;
    }
  }

  async cancel(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.finishedAt || !run.process) return;
    run.cancelRequested = true;
    const child = run.process;
    killOwnedProcess(child, "SIGTERM");
    void delay(this.options.killGraceMs).then(() => {
      killOwnedProcess(child, "SIGKILL");
    });
  }

  async getStatus(runId: string): Promise<AgentStatus> {
    const run = this.runs.get(runId);
    if (!run) throw new CodexAdapterError("No Codex run exists with that ID.", "run.not_found");
    return {
      runId, state: run.state, startedAt: run.startedAt,
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    };
  }

  private readCapabilities(input: readonly string[]): OperationType[] {
    if (input.length === 0) throw new CodexAdapterError("No design operation capabilities were negotiated.", "capability.empty");
    const known = new Set<OperationType>(["node.create", "node.delete", "node.move", "property.set", "layout.set", "style.set"]);
    const capabilities = [...new Set(input)];
    const unknown = capabilities.find((value) => !known.has(value as OperationType));
    if (unknown) throw new CodexAdapterError("The run requested an unsupported operation capability.", "capability.unsupported");
    return capabilities as OperationType[];
  }

  private buildPrompt(request: CodingAgentRequest): string {
    return [
      "You produce semantic design operations for Codex Design.",
      "Return the JSON object required by the supplied output schema. Put complete typed operation objects in the operations array, and include a summary string. Do not write files or run commands.",
      buildDesignBrief(request),
      "Only propose operation types listed in operationCapabilities. Do not modify existing nodes outside the provided document fragment. New nodes require new unique IDs.",
      "Use operations to create or edit the design. The application will validate all output and may reject it.",
      operationReference(request),
      "Input JSON follows:",
      JSON.stringify(request),
    ].join("\n");
  }
}

function protocolError(error: AgentProtocolError, exitCode?: number | null): CodexAdapterError {
  const message = SAFE_PROTOCOL_ERRORS[error.code];
  return new CodexAdapterError(message ?? "Codex returned a design response that could not be validated.", message ? error.code : "protocol.invalid_response", exitCode);
}

function codexTurnError(event: Record<string, unknown>): CodexAdapterError {
  const detail = [event.code, event.error && typeof event.error === "object" ? (event.error as Record<string, unknown>).code : undefined, event.type]
    .filter((value): value is string => typeof value === "string").join(" ").toLowerCase();
  if (/auth|unauthorized|invalid[_ -]?api[_ -]?key/.test(detail)) return new CodexAdapterError("Codex rejected the configured authentication.", "auth.rejected");
  if (/quota|billing|insufficient[_ -]?credit/.test(detail)) return new CodexAdapterError("The provider reports no available quota for this connection.", "provider.quota");
  if (/unsupported[_ -]?(model|parameter)|model[_ -]?not[_ -]?found/.test(detail)) return new CodexAdapterError("The selected model or effort is unsupported by this provider.", "provider.unsupported");
  return new CodexAdapterError("Codex reported a failed turn. Review the request and retry.", "codex.turn_failed");
}

function killOwnedProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); return; }
    catch { /* Fall back to the direct child if the process group is no longer signalable. */ }
  }
  try { child.kill(signal); }
  catch { /* A concurrent process exit or OS teardown can make the signal unavailable. */ }
}
