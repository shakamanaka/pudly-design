import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_PROVIDER_OUTPUT_BYTES, ProviderAdapterError } from './shared.js';

export type CliTransportOptions = { timeoutMs?: number; maxOutputBytes?: number; killGraceMs?: number; allowNonzeroExit?: boolean };
export type CliProcessHandle = { child?: ChildProcessWithoutNullStreams; cancelRequested: boolean };
export type CliTransportResult = { stdout: string; exitCode: number | null };

export async function runCliTransport(input: {
  executable: string;
  args: string[];
  prompt: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  signal: AbortSignal;
  handle: CliProcessHandle;
  options?: CliTransportOptions;
}): Promise<CliTransportResult | null> {
  const timeoutMs = input.options?.timeoutMs ?? 300_000;
  const maxOutputBytes = input.options?.maxOutputBytes ?? MAX_PROVIDER_OUTPUT_BYTES;
  const killGraceMs = input.options?.killGraceMs ?? 1_000;
  if (input.signal.aborted) { input.handle.cancelRequested = true; return null; }
  let stdout = '';
  let outputBytes = 0;
  let processError: Error | undefined;
  let timedOut = false;
  let exitCode: number | null = null;
  let stderrBytes = 0;
  const child = spawn(input.executable, input.args, {
    cwd: input.cwd,
    env: input.env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  input.handle.child = child;
  // Keep the group id independently of the child object's close state. The
  // parent can exit on SIGTERM while a descendant in its process group stays
  // alive; that group still needs the scheduled SIGKILL.
  const processGroupId = process.platform !== 'win32' ? child.pid : undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (processGroupId) {
      try { process.kill(-processGroupId, signal); } catch { /* The process group already exited. */ }
    } else child.kill(signal);
  };
  const terminate = () => {
    kill('SIGTERM');
    void delay(killGraceMs).then(() => kill('SIGKILL'));
  };
  const onAbort = () => { input.handle.cancelRequested = true; terminate(); };
  input.signal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
  child.once('error', error => { processError = error; });
  child.once('close', code => { exitCode = code; });
  child.stdout.on('data', (chunk: Buffer) => {
    outputBytes += chunk.byteLength;
    if (outputBytes + stderrBytes > maxOutputBytes) { processError = new ProviderAdapterError('Provider output exceeded the configured size limit.', 'agent.output_too_large'); terminate(); return; }
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (outputBytes + stderrBytes > maxOutputBytes) { processError = new ProviderAdapterError('Provider output exceeded the configured size limit.', 'agent.output_too_large'); terminate(); }
  });
  child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') processError = error; });
  child.stdin.end(input.prompt, 'utf8');
  try {
    await new Promise<void>(resolve => child.once('close', () => resolve()));
    if (input.handle.cancelRequested || input.signal.aborted) return null;
    if (timedOut) throw new ProviderAdapterError('The provider exceeded the run time limit.', 'agent.timeout');
    if (processError instanceof ProviderAdapterError) throw processError;
    if (processError) throw new ProviderAdapterError('The provider CLI could not be started or its process failed.', 'agent.process_error');
    if (exitCode !== 0 && !input.options?.allowNonzeroExit) throw new ProviderAdapterError('The provider CLI exited unsuccessfully. Check its authentication and model selection.', 'provider.cli_failed');
    return { stdout, exitCode };
  } finally {
    clearTimeout(timeout);
    input.signal.removeEventListener('abort', onAbort);
    delete input.handle.child;
  }
}

export function killCliHandle(handle: CliProcessHandle, graceMs = 1_000): void {
  const child = handle.child;
  if (!child) { handle.cancelRequested = true; return; }
  handle.cancelRequested = true;
  const kill = (signal: NodeJS.Signals) => {
    if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, signal); } catch { /* Already exited. */ } }
    else child.kill(signal);
  };
  kill('SIGTERM');
  void delay(graceMs).then(() => kill('SIGKILL'));
}
