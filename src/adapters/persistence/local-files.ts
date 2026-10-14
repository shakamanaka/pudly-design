import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { sealEnvelope } from '../../application/integrity';
import { lstat, mkdir, open, readdir, rename, unlink } from './persistence-fs.js';
import { join } from 'node:path';
import { validateEnvelope } from '../../domain/index';
import type { DesignPersistence, PersistedProjectEnvelope } from '../../domain/index';
import type { ProjectSummary } from '../../application/project-library.js';

export class PersistenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PersistenceError';
  }
}


function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new PersistenceError('project.invalid-id', 'Invalid project identifier.');
  }
  return id;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

class AtomicWriteFailure extends Error {
  constructor(readonly originalError: unknown, readonly destinationChanged: boolean) {
    super('Atomic project write failed.');
    this.name = 'AtomicWriteFailure';
  }
}

function causeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown filesystem error.';
}

function summaryDiagnostic(error: unknown): string {
  if (error instanceof PersistenceError && error.code === 'project.size-limit') return 'Saved project exceeds the local storage limit.';
  if (error instanceof PersistenceError && error.code === 'project.integrity') return 'Saved project integrity could not be verified.';
  return 'Saved project data is damaged or unsupported.';
}

/** One durable envelope is published only after its atomic filesystem save succeeds. */
export class LocalDesignPersistence implements DesignPersistence {
  constructor(readonly directory: string) {}

  async load(id: string): Promise<PersistedProjectEnvelope | null> {
    const file = join(this.directory, `${safeId(id)}.json`);
    let source: string;
    let handle;
    try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof Error && 'code' in error && error.code === 'ELOOP') throw new PersistenceError('project.unsafe-entry', 'Symbolic link project files are not supported.');
      throw error;
    }
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new PersistenceError('project.unsafe-entry', 'Project storage entry is not a regular file.');
      if (metadata.size > 64 * 1024 * 1024) throw new PersistenceError('project.size-limit', 'Stored project exceeds the storage limit.');
      source = await handle.readFile('utf8');
    } finally { await handle.close(); }
    if (Buffer.byteLength(source) > 64 * 1024 * 1024) {
      throw new PersistenceError('project.size-limit', 'Stored project exceeds the storage limit.');
    }
    let data: unknown;
    try { data = JSON.parse(source); }
    catch { throw new PersistenceError('project.corrupt', 'Project JSON is damaged. The saved file was preserved.'); }
    const result = validateEnvelope(data);
    if (!result.ok) {
      throw new PersistenceError('project.invalid', result.diagnostics.map(item => item.message).join('; '));
    }
    const envelope = result.value;
    if (envelope.document.id !== id || sealEnvelope(envelope).integrityHash !== envelope.integrityHash) {
      throw new PersistenceError('project.integrity', 'Project integrity check failed. The saved file was preserved.');
    }
    return structuredClone(envelope);
  }

  async listProjects(): Promise<ProjectSummary[]> {
    let entries;
    try { entries = await readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    const names = entries
      .filter(entry => entry.isFile() && /^[A-Za-z0-9_-]{1,128}\.json$/.test(entry.name))
      .map(entry => entry.name)
      .sort();
    const projects: ProjectSummary[] = [];
    for (const name of names) {
      const id = name.slice(0, -5);
      try {
        const metadata = await lstat(join(this.directory, name));
        if (!metadata.isFile()) continue;
        const updatedAt = metadata.mtime.toISOString();
        try {
          const project = await this.load(id);
          if (!project) continue;
          projects.push({ id, name: project.document.name, revision: project.document.revision, updatedAt, nodeCount: Object.keys(project.document.nodes).length, status: 'available' });
        } catch (error) {
          if (error instanceof PersistenceError && error.code === 'project.unsafe-entry') continue;
          projects.push({ id, name: 'Unavailable project', revision: 0, updatedAt, nodeCount: 0, status: 'unavailable', diagnostic: summaryDiagnostic(error) });
        }
      } catch (error) {
        if (isMissing(error)) continue;
        if (error instanceof PersistenceError && error.code === 'project.unsafe-entry') continue;
        throw error;
      }
    }
    return projects.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  }

  async previewProject(id: string) {
    const project = await this.load(id);
    if (!project) throw new PersistenceError('project.missing', 'The saved project could not be found.');
    return structuredClone(project.document);
  }

  async removeProject(id: string): Promise<void> {
    const projectId = safeId(id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = join(this.directory, `${projectId}.lock`);
    const lock = await this.acquireLock(lockPath);
    const currentLockPath = join(this.directory, 'current.lock');
    let currentLock;
    try {
      currentLock = await this.acquireLock(currentLockPath);
      const projectPath = join(this.directory, `${projectId}.json`);
      const sourceMetadata = await this.safeRegularFile(projectPath);
      if (!sourceMetadata) throw new PersistenceError('project.missing', 'The saved project could not be found.');
      const trash = join(this.directory, '.trash');
      await this.ensurePrivateTrash(trash);
      const currentId = await this.readCurrentId();
      const wasCurrent = currentId === projectId;
      let moved = false;
      let pointerCleared = false;
      const destination = join(trash, `${projectId}.${Date.now()}.${randomUUID()}.json`);
      try {
        if (wasCurrent) {
          await unlink(join(this.directory, 'current'));
          pointerCleared = true;
          await this.syncDirectory(this.directory);
        }
        await rename(projectPath, destination);
        moved = true;
        await this.syncDirectory(this.directory);
        await this.syncDirectory(trash);
      } catch (error) {
        try {
          if (moved) {
            await rename(destination, projectPath);
            await this.syncDirectory(this.directory);
            await this.syncDirectory(trash);
          }
          if (pointerCleared && currentId) await this.atomicWrite(join(this.directory, 'current'), currentId);
        } catch (rollbackError) {
          throw new PersistenceError('project.indeterminate', `Project removal failed and its rollback could not be completed (${causeMessage(rollbackError)}). Preserve the project directory and recover it before reopening.`);
        }
        throw error;
      }
    } finally {
      if (currentLock) {
        await currentLock.close().catch(() => undefined);
        await unlink(currentLockPath).catch(() => undefined);
      }
      await lock.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private async safeRegularFile(path: string) {
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw new PersistenceError('project.unsafe-entry', 'Project storage entry is not a regular file.');
      return metadata;
    } catch (error) { if (isMissing(error)) return null; throw error; }
  }

  private async ensurePrivateTrash(path: string): Promise<void> {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error; }
    let metadata;
    try { metadata = await lstat(path); }
    catch (error) { throw new PersistenceError('project.trash', `The recovery trash could not be inspected (${causeMessage(error)}).`); }
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
      throw new PersistenceError('project.trash', 'The recovery trash must be a private directory owned by this user.');
    }
    const verified = await lstat(path);
    if (!verified.isDirectory() || verified.isSymbolicLink() || (verified.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && verified.uid !== process.getuid())) {
      throw new PersistenceError('project.trash', 'The recovery trash must be a private directory owned by this user.');
    }
  }

  private async readCurrentId(): Promise<string | null> {
    const path = join(this.directory, 'current');
    let handle;
    try { handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof Error && 'code' in error && error.code === 'ELOOP') throw new PersistenceError('project.unsafe-entry', 'The active project pointer is not a regular file.');
      throw error;
    }
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > 256) throw new PersistenceError('project.unsafe-entry', 'The active project pointer is invalid.');
      const id = (await handle.readFile('utf8')).trim();
      if (!id) return null;
      return safeId(id);
    } finally { await handle.close(); }
  }

  async loadCurrent(): Promise<PersistedProjectEnvelope | null> {
    const id = await this.readCurrentId();
    if (!id) return null;
    const project = await this.load(id);
    if (!project) throw new PersistenceError('project.missing', 'The active project could not be found.');
    return project;
  }

  async select(id: string): Promise<void> {
    safeId(id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const projectLockPath = join(this.directory, `${id}.lock`);
    const projectLock = await this.acquireLock(projectLockPath);
    const currentLockPath = join(this.directory, 'current.lock');
    let currentLock;
    try {
      currentLock = await this.acquireLock(currentLockPath);
      if (!await this.load(id)) throw new PersistenceError('project.missing', 'Cannot select a project that was not saved.');
      await this.atomicWrite(join(this.directory, 'current'), id);
    } finally {
      if (currentLock) {
        await currentLock.close().catch(() => undefined);
        await unlink(currentLockPath).catch(() => undefined);
      }
      await projectLock.close().catch(() => undefined);
      await unlink(projectLockPath).catch(() => undefined);
    }
  }

  async saveAtomically(project: PersistedProjectEnvelope, expectedRevision: number): Promise<{ savedRevision: number }> {
    const id = safeId(project.document.id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = join(this.directory, `${id}.lock`);
    const lock = await this.acquireLock(lockPath);
    try {
      const current = await this.load(id);
      if ((current?.document.revision ?? 0) !== expectedRevision) {
        throw new PersistenceError('revision.conflict', 'Saved project has a newer revision. Reopen it before editing.');
      }
      const sealed = sealEnvelope(project);
      const validation = validateEnvelope(sealed);
      if (!validation.ok) throw new PersistenceError('project.invalid', validation.diagnostics.map(item => item.message).join('; '));
      const text = JSON.stringify(sealed);
      if (Buffer.byteLength(text) > 64 * 1024 * 1024) throw new PersistenceError('project.size-limit', 'Project history exceeds the storage limit.');
      const projectPath = join(this.directory, `${id}.json`);
      await this.atomicWrite(projectPath, text);
      return { savedRevision: sealed.document.revision };
    } finally {
      await lock.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private async acquireLock(lockPath: string) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const lock = await open(lockPath, 'wx', 0o600);
        try {
          await lock.writeFile(`${process.pid}\n`, 'utf8');
          await lock.sync();
          return lock;
        } catch (error) {
          await lock.close().catch(() => undefined);
          await unlink(lockPath).catch(() => undefined);
          throw new PersistenceError('project.lock', `Could not initialize the project lock: ${causeMessage(error)}`);
        }
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        if (attempt === 0 && await this.removeStaleLock(lockPath)) continue;
        throw new PersistenceError('project.busy', 'Another process is writing this project. Try again.');
      }
    }
    throw new PersistenceError('project.busy', 'Another process is writing this project. Try again.');
  }

  private async removeStaleLock(lockPath: string): Promise<boolean> {
    try {
      const before = await lstat(lockPath);
      if (before.isSymbolicLink() || !before.isFile()) return false;
      const handle = await open(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let contents: string;
      try { contents = await handle.readFile('utf8'); } finally { await handle.close(); }
      const after = await lstat(lockPath);
      if (before.ino !== after.ino || before.dev !== after.dev) return false;
      const pidText = contents.trim();
      if (!/^\d+$/.test(pidText)) return false;
      const pid = Number(pidText);
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      try { process.kill(pid, 0); return false; }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') return false;
      }
      const finalStat = await lstat(lockPath);
      if (finalStat.ino !== after.ino || finalStat.dev !== after.dev) return false;
      await unlink(lockPath);
      return true;
    } catch { return false; }
  }

  private async atomicWrite(path: string, text: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const previous = await this.readRegularText(path);
    try {
      await this.writeAndSyncDirectory(path, text);
    } catch (error) {
      if (!(error instanceof AtomicWriteFailure)) throw error;
      if (!error.destinationChanged) throw error.originalError;
      try {
        if (previous === null) {
          await unlink(path).catch((removeError) => { if (!isMissing(removeError)) throw removeError; });
          await this.syncDirectory();
        } else {
          await this.writeAndSyncDirectory(path, previous);
        }
      } catch (rollbackError) {
        throw new PersistenceError('project.indeterminate', `The save failed after replacing the project, and rollback also failed (${causeMessage(rollbackError)}). Storage state is indeterminate; preserve the project directory and reopen only after recovery.`);
      }
      throw error.originalError;
    }
  }

  private async readRegularText(path: string): Promise<string | null> {
    let handle;
    try { handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof Error && 'code' in error && error.code === 'ELOOP') throw new PersistenceError('project.unsafe-entry', 'Symbolic link storage entries are not supported.');
      throw error;
    }
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new PersistenceError('project.unsafe-entry', 'Storage entry is not a regular file.');
      return await handle.readFile('utf8');
    } finally { await handle.close(); }
  }

  private async writeAndSyncDirectory(path: string, text: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(text, 'utf8');
      await file.sync();
    } catch (error) {
      await file.close();
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await file.close();
    let destinationChanged = false;
    try {
      await rename(temporary, path);
      destinationChanged = true;
      await this.syncDirectory();
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new AtomicWriteFailure(error, destinationChanged);
    }
  }

  private async syncDirectory(path = this.directory): Promise<void> {
    // fsync the containing directory so an acknowledged rename survives a crash.
    const directory = await open(path, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
