import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fault = vi.hoisted(() => ({ directory: '', directorySyncFailures: 0, trashDirectorySyncFailures: 0, directoryOpenHits: 0, lockUnlinkFailures: 0, lockCloseFailures: 0 }));

vi.mock('../../src/adapters/persistence/persistence-fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/adapters/persistence/persistence-fs.js')>();
  const realOpen = actual.open as (...args: unknown[]) => Promise<import('node:fs/promises').FileHandle>;
  const realUnlink = actual.unlink;
  return {
    ...actual,
    unlink: vi.fn(async (path: import('node:fs').PathLike) => {
      if (String(path).endsWith('.lock') && fault.lockUnlinkFailures > 0) {
        fault.lockUnlinkFailures -= 1;
        throw Object.assign(new Error('injected lock cleanup failure'), { code: 'EACCES' });
      }
      return realUnlink(path);
    }),
    open: vi.fn(async (...args: unknown[]) => {
      const path = String(args[0]);
      const handle = await realOpen(...args);
      if (path === fault.directory && args[1] === 'r') fault.directoryOpenHits += 1;
      if (path.endsWith('.lock')) return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === 'close') return async () => {
            await target.close();
            if (fault.lockCloseFailures > 0) {
              fault.lockCloseFailures -= 1;
              throw Object.assign(new Error('injected lock close failure'), { code: 'EIO' });
            }
          };
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const isProjectDirectory = path === fault.directory && args[1] === 'r';
      const isTrashDirectory = path === `${fault.directory}/.trash` && args[1] === 'r';
      if (!isProjectDirectory && !isTrashDirectory) return handle;
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === 'sync') return async () => {
            if (isProjectDirectory && fault.directorySyncFailures > 0) {
              fault.directorySyncFailures -= 1;
              throw Object.assign(new Error('injected directory fsync failure'), { code: 'EIO' });
            }
            if (isTrashDirectory && fault.trashDirectorySyncFailures > 0) {
              fault.trashDirectorySyncFailures -= 1;
              throw Object.assign(new Error('injected trash fsync failure'), { code: 'EIO' });
            }
            return target.sync();
          };
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }),
  };
});

import { sealEnvelope } from '../../src/application/integrity.js';
import { LocalDesignPersistence, PersistenceError } from '../../src/adapters/persistence/local-files.js';
import { createDocument } from '../../src/domain/defaults.js';
import type { PersistedProjectEnvelope } from '../../src/domain/index.js';

const directories: string[] = [];

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'codex-design-fault-'));
  directories.push(directory);
  fault.directory = directory;
  fault.directorySyncFailures = 0;
  fault.trashDirectorySyncFailures = 0;
  fault.directoryOpenHits = 0;
  fault.lockUnlinkFailures = 0;
  fault.lockCloseFailures = 0;
  const persistence = new LocalDesignPersistence(directory);
  const initial = sealEnvelope({
    formatVersion: 1,
    document: createDocument('Before', 'fault_document', 'fault_page'),
    history: { undoableEntries: [], cursor: 0, auditTransitions: [], snapshots: [] },
    appliedBatchIds: [], integrityHash: '',
  });
  await persistence.saveAtomically(initial, 0);
  const changed = structuredClone(initial);
  changed.document.name = 'After';
  changed.document.revision = 1;
  return { persistence, initial, changed: sealEnvelope(changed) };
}

afterEach(async () => {
  fault.directory = '';
  fault.directorySyncFailures = 0;
  fault.trashDirectorySyncFailures = 0;
  fault.directoryOpenHits = 0;
  fault.lockUnlinkFailures = 0;
  fault.lockCloseFailures = 0;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('local persistence filesystem failure recovery', () => {
  it('restores the prior envelope when directory fsync fails after rename', async () => {
    const { persistence, initial, changed } = await setup();
    fault.directorySyncFailures = 1;
    await expect(persistence.saveAtomically(changed, 0)).rejects.toMatchObject({ code: 'EIO' });
    expect(fault.directoryOpenHits).toBeGreaterThanOrEqual(2);
    expect(await persistence.load(initial.document.id)).toEqual(initial);
  });

  it('reports indeterminate storage when the rollback fsync also fails', async () => {
    const { persistence, initial, changed } = await setup();
    fault.directorySyncFailures = 2;
    let thrown: unknown;
    try { await persistence.saveAtomically(changed, 0); }
    catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(PersistenceError);
    expect(thrown).toMatchObject({ code: 'project.indeterminate' });
    expect((thrown as Error).message).toContain('Storage state is indeterminate');
    // The replacement may be visible even though its rollback durability could not be confirmed.
    const stored = await persistence.load(initial.document.id) as PersistedProjectEnvelope;
    expect([initial.document.revision, changed.document.revision]).toContain(stored.document.revision);
  });

  it('does not reject a committed save because lock cleanup failed', async () => {
    const { persistence, initial, changed } = await setup();
    fault.lockUnlinkFailures = 1;
    fault.lockCloseFailures = 1;
    await expect(persistence.saveAtomically(changed, 0)).resolves.toEqual({ savedRevision: 1 });
    expect(await persistence.load(initial.document.id)).toMatchObject({ document: { revision: 1, name: 'After' } });
  });

  it('reclaims a lock only when its recorded owner process is gone', async () => {
    const { persistence, initial, changed } = await setup();
    await writeFile(join(fault.directory, `${initial.document.id}.lock`), '2147483647\n');
    await expect(persistence.saveAtomically(changed, 0)).resolves.toEqual({ savedRevision: 1 });
    expect(await persistence.load(initial.document.id)).toMatchObject({ document: { revision: 1, name: 'After' } });
  });

  it('restores the active pointer and original project when trash durability fails after the move', async () => {
    const { persistence, initial } = await setup();
    await persistence.select(initial.document.id);
    fault.trashDirectorySyncFailures = 1;
    await expect(persistence.removeProject(initial.document.id)).rejects.toMatchObject({ code: 'EIO' });
    expect(await persistence.load(initial.document.id)).toEqual(initial);
    expect(await persistence.loadCurrent()).toEqual(initial);
    expect(await readdir(join(fault.directory, '.trash'))).toEqual([]);
  });
});
