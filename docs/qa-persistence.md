# Persistence and history QA

`tests/integration/persistence-history.test.ts` covers concurrent same-revision commits, reopen with batch-ledger replay rejection, monotonic undo/redo and redo-branch replacement, failed saves before durable write, and caller mutation of a queued batch while an earlier save is blocked. `tests/integration/persistence-faults.test.ts` mocks the adapter filesystem boundary while delegating to real filesystem operations. It injects directory-fsync failures after rename, a second failure during rollback, and lock cleanup failure; it also verifies recovery of a lock whose recorded PID is gone.

`LocalDesignPersistence` now retains the old bytes across replacement. If directory sync fails after rename, it atomically restores those bytes and rejects the save. If restoration also fails, it reports `project.indeterminate` with explicit recovery guidance. Lock files record the owner PID; only a well-formed lock owned by a process confirmed absent with `ESRCH` is reclaimed. Close and unlink errors during final lock cleanup cannot turn a committed save into a rejected call.

Agent run linkage now persists through history validation (`HistoryEntry.runId` and the envelope field allowlist); this was corrected in parallel with the adapter work.

## Verification

The integration suite passes 15 tests across 4 files. ESLint passes on the persistence adapter, filesystem shim, and focused tests. Full `npm run typecheck` passes. Codebase semantic retrieval located the service and persistence symbols; source files were verified directly, and the index was refreshed after edits.
