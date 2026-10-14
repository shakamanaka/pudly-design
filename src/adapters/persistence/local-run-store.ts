import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { lstat, mkdir, open, readFile, rename, unlink } from './persistence-fs.js';
import { MAX_RUN_RECORD_BYTES, validateAgentRunRecord } from '../../domain/run-record.js';
import type { AgentRunRecord, AgentRunStore } from '../../domain/types.js';

const MAX_FILES = 200;
const VERSION = 1;
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'ROLLED_BACK']);

export class RunStoreError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'RunStoreError'; }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
function safeRunId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new RunStoreError('run-store.id', 'Run record ID must be a UUID.');
  return id;
}
class AtomicRunWriteFailure extends Error {
  constructor(readonly originalError: unknown, readonly destinationChanged: boolean) { super('Atomic run record write failed.'); }
}

/** Stores bounded run metadata separately from authoritative project history. */
export class LocalAgentRunStore implements AgentRunStore {
  private sequence: Promise<void> = Promise.resolve();
  constructor(readonly directory: string) {}

  async loadAll(): Promise<AgentRunRecord[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    if (names.some(name => /^[0-9a-f-]{36}\.indeterminate$/i.test(name))) throw new RunStoreError('run-store.indeterminate', 'A run record rollback could not be confirmed. Preserve the run store and recover it before reopening.');
    const files = names.filter(name => name.endsWith('.json'));
    if (files.length > MAX_FILES) throw new RunStoreError('run-store.capacity', 'Run store contains too many records.');
    const records: AgentRunRecord[] = [];
    for (const name of files) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i.test(name)) throw new RunStoreError('run-store.path', 'Run store contains an unexpected filename.');
      const path = join(this.directory, name);
      const meta = await lstat(path);
      if (!meta.isFile() || meta.isSymbolicLink() || meta.size > MAX_RUN_RECORD_BYTES + 1024) throw new RunStoreError('run-store.file', 'Run record file is unsafe or exceeds its size limit.');
      let parsed: unknown;
      try { parsed = JSON.parse(await readFile(path, 'utf8')); }
      catch { throw new RunStoreError('run-store.corrupt', 'A run record is corrupt. The saved file was preserved.'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some(key => !['formatVersion', 'record'].includes(key)) || (parsed as {formatVersion?: unknown}).formatVersion !== VERSION) throw new RunStoreError('run-store.version', 'A run record has an unsupported or invalid envelope.');
      const result = validateAgentRunRecord((parsed as {record?: unknown}).record);
      if (!result.ok || result.value.id.toLowerCase() !== name.slice(0, -5).toLowerCase()) throw new RunStoreError('run-store.invalid', result.ok ? 'Run record filename does not match its ID.' : result.diagnostics.map(item => item.message).join('; '));
      records.push(structuredClone(result.value));
    }
    return records.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  save(record: AgentRunRecord): Promise<void> {
    const result = validateAgentRunRecord(record);
    if (!result.ok) return Promise.reject(new RunStoreError('run-store.invalid', result.diagnostics.map(item => item.message).join('; ')));
    const captured = structuredClone(result.value);
    const work = this.sequence.then(() => this.saveOne(captured), () => this.saveOne(captured));
    this.sequence = work.catch(() => undefined);
    return work;
  }

  private async saveOne(record: AgentRunRecord): Promise<void> {
    const id = safeRunId(record.id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = await readdir(this.directory);
    const files = names.filter(name => name.endsWith('.json'));
    if (!files.includes(`${id}.json`) && files.length >= MAX_FILES) {
      const records = await this.loadAll();
      const removable = records.filter(item => TERMINAL.has(item.state)).sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
      if (!removable) throw new RunStoreError('run-store.capacity', 'Run store is full of active runs.');
      await unlink(join(this.directory, `${safeRunId(removable.id)}.json`));
    }
    const destination = join(this.directory, `${id}.json`);
    const text = JSON.stringify({ formatVersion: VERSION, record });
    if (Buffer.byteLength(text) > MAX_RUN_RECORD_BYTES + 1024) throw new RunStoreError('run-store.size', 'Run record exceeds its storage limit.');
    await this.atomicWrite(destination, text);
  }

  private async atomicWrite(destination: string, text: string): Promise<void> {
    let previous: string | null = null;
    try { previous = await readFile(destination, 'utf8'); }
    catch (error) { if (!isMissing(error)) throw error; }
    try { await this.writeAndSyncDirectory(destination, text); }
    catch (error) {
      if (!(error instanceof AtomicRunWriteFailure)) throw error;
      if (!error.destinationChanged) throw new RunStoreError('run-store.write', error.originalError instanceof Error ? error.originalError.message : 'Could not save run record.');
      try {
        if (previous === null) {
          await unlink(destination).catch(removeError => { if (!isMissing(removeError)) throw removeError; });
          await this.syncDirectory();
        } else await this.writeAndSyncDirectory(destination, previous);
      } catch (rollbackError) {
        const message = rollbackError instanceof Error ? rollbackError.message : 'Unknown rollback error.';
        const id = basename(destination, '.json');
        await this.writeIndeterminateMarker(id).catch(() => undefined);
        throw new RunStoreError('run-store.indeterminate', `Run record replacement failed and rollback could not be confirmed (${message}). Storage state is indeterminate; preserve the run store and recover it before reopening.`);
      }
      throw new RunStoreError('run-store.write', error.originalError instanceof Error ? error.originalError.message : 'Could not save run record.');
    }
  }

  private async writeAndSyncDirectory(destination: string, text: string): Promise<void> {
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(text, 'utf8'); await file.sync(); }
    catch (error) { await file.close(); await unlink(temporary).catch(() => undefined); throw error; }
    await file.close();
    let destinationChanged = false;
    try {
      await rename(temporary, destination);
      destinationChanged = true;
      await this.syncDirectory();
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new AtomicRunWriteFailure(error, destinationChanged);
    }
  }

  private async syncDirectory(): Promise<void> {
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }

  private async writeIndeterminateMarker(id: string): Promise<void> {
    const marker = join(this.directory, `${safeRunId(id)}.indeterminate`);
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ formatVersion: VERSION, state: 'indeterminate' }), 'utf8'); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, marker);
    await this.syncDirectory();
  }
}
