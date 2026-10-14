import { validateDocument } from './document.js';
import type { Diagnostic, HistoryEntry, HistoryState, PersistedProjectEnvelope, ValidationResult } from './types.js';
import { addDiagnostic, hasOnlyKeys, inspectJsonGraph, isNonNegativeInteger, isRecord, safeSerializedSize, validationFailure, validationOk } from './validation-utils.js';

function checkEntry(value: unknown, path: string, diagnostics: Diagnostic[]): value is HistoryEntry {
  if (!isRecord(value)) { addDiagnostic(diagnostics, 'history.entry', 'History entry must be an object.', path); return false; }
  hasOnlyKeys(value, ['batchId', 'beforeRevision', 'afterRevision', 'operations', 'inverseOperations', 'source', 'timestamp', 'runId'], path, diagnostics);
  if (value.runId !== undefined && (typeof value.runId !== 'string' || !value.runId)) addDiagnostic(diagnostics, 'history.run-id', 'Run linkage must be a non-empty string.', `${path}.runId`);
  if (typeof value.batchId !== 'string' || !isNonNegativeInteger(value.beforeRevision) || !isNonNegativeInteger(value.afterRevision) || value.afterRevision <= value.beforeRevision) addDiagnostic(diagnostics, 'history.entry-fields', 'History entry identity or revisions are invalid.', path);
  if (!Array.isArray(value.operations) || !Array.isArray(value.inverseOperations)) addDiagnostic(diagnostics, 'history.operations', 'History operations must be arrays.', path);
  if (!['agent', 'inspector', 'toolbar', 'keyboard', 'system'].includes(String(value.source))) addDiagnostic(diagnostics, 'history.source', 'History source is invalid.', `${path}.source`);
  if (typeof value.timestamp !== 'string' || Number.isNaN(Date.parse(value.timestamp))) addDiagnostic(diagnostics, 'history.timestamp', 'History timestamp must be an ISO date string.', `${path}.timestamp`);
  return true;
}
function checkHistory(value: unknown, path: string, diagnostics: Diagnostic[]): value is HistoryState {
  if (!isRecord(value)) { addDiagnostic(diagnostics, 'history.object', 'History must be an object.', path); return false; }
  hasOnlyKeys(value, ['undoableEntries', 'cursor', 'auditTransitions', 'snapshots'], path, diagnostics);
  if (!Array.isArray(value.undoableEntries) || !Array.isArray(value.auditTransitions) || !Array.isArray(value.snapshots)) { addDiagnostic(diagnostics, 'history.arrays', 'History collections must be arrays.', path); return false; }
  value.undoableEntries.forEach((entry, index) => checkEntry(entry, `${path}.undoableEntries[${index}]`, diagnostics));
  if (!isNonNegativeInteger(value.cursor) || value.cursor > value.undoableEntries.length) addDiagnostic(diagnostics, 'history.cursor', 'History cursor is outside the edit list.', `${path}.cursor`);
  let previousRevision = -1;
  value.auditTransitions.forEach((transition, index) => {
    const tpath = `${path}.auditTransitions[${index}]`;
    if (!isRecord(transition)) { addDiagnostic(diagnostics, 'history.transition', 'Transition must be an object.', tpath); return; }
    hasOnlyKeys(transition, ['id', 'kind', 'fromRevision', 'toRevision', 'batchId', 'entryId', 'timestamp'], tpath, diagnostics);
    if (typeof transition.id !== 'string' || !['commit', 'undo', 'redo', 'restore'].includes(String(transition.kind)) || !isNonNegativeInteger(transition.fromRevision) || !isNonNegativeInteger(transition.toRevision) || transition.toRevision <= transition.fromRevision) addDiagnostic(diagnostics, 'history.transition-fields', 'Transition fields or revisions are invalid.', tpath);
    if (isNonNegativeInteger(transition.toRevision)) {
      if (transition.toRevision <= previousRevision) addDiagnostic(diagnostics, 'history.audit-order', 'Audit transition revisions must increase monotonically.', tpath);
      previousRevision = transition.toRevision;
    }
  });
  value.snapshots.forEach((snapshot, index) => {
    const spath = `${path}.snapshots[${index}]`;
    if (!isRecord(snapshot)) { addDiagnostic(diagnostics, 'history.snapshot', 'Snapshot must be an object.', spath); return; }
    hasOnlyKeys(snapshot, ['id', 'revision', 'label', 'timestamp', 'document'], spath, diagnostics);
    if (typeof snapshot.id !== 'string' || typeof snapshot.label !== 'string' || !isNonNegativeInteger(snapshot.revision) || typeof snapshot.timestamp !== 'string') addDiagnostic(diagnostics, 'history.snapshot-fields', 'Snapshot fields are invalid.', spath);
    const doc = validateDocument(snapshot.document);
    if (!doc.ok) diagnostics.push(...doc.diagnostics.map((d) => ({ ...d, path: `${spath}.document${d.path?.slice(1) ?? ''}` })));
  });
  return true;
}
export function validateProjectEnvelope(input: unknown): ValidationResult<PersistedProjectEnvelope> {
  const diagnostics = inspectJsonGraph(input, 1_000_000, 100);
  if (diagnostics.length > 0) return validationFailure(diagnostics);
  const size = safeSerializedSize(input);
  if (size === null || size > 64 * 1024 * 1024) { addDiagnostic(diagnostics, 'limit.envelope-bytes', 'Project envelope exceeds 64 MiB.', '$'); return validationFailure(diagnostics); }
  if (!isRecord(input)) { addDiagnostic(diagnostics, 'envelope.object', 'Envelope must be a plain object.', '$'); return validationFailure(diagnostics); }
  hasOnlyKeys(input, ['formatVersion', 'document', 'history', 'appliedBatchIds', 'integrityHash'], '$', diagnostics);
  if (input.formatVersion !== 1) addDiagnostic(diagnostics, 'envelope.version', 'Only envelope format version 1 is supported.', '$.formatVersion');
  const doc = validateDocument(input.document);
  if (!doc.ok) diagnostics.push(...doc.diagnostics.map((d) => ({ ...d, path: `$.document${d.path?.slice(1) ?? ''}` })));
  checkHistory(input.history, '$.history', diagnostics);
  if (!Array.isArray(input.appliedBatchIds) || input.appliedBatchIds.some((id) => typeof id !== 'string' || id.length === 0)) addDiagnostic(diagnostics, 'envelope.batch-ledger', 'Applied batch ledger must contain non-empty string IDs.', '$.appliedBatchIds');
  if (new Set(Array.isArray(input.appliedBatchIds) ? input.appliedBatchIds : []).size !== (Array.isArray(input.appliedBatchIds) ? input.appliedBatchIds.length : 0)) addDiagnostic(diagnostics, 'envelope.batch-ledger-duplicate', 'Batch ledger contains duplicate IDs.', '$.appliedBatchIds');
  if (typeof input.integrityHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.integrityHash)) addDiagnostic(diagnostics, 'envelope.integrity', 'integrityHash must be 64 lowercase hexadecimal characters.', '$.integrityHash');
  if (diagnostics.length > 0) return validationFailure(diagnostics);
  return validationOk(input as unknown as PersistedProjectEnvelope, diagnostics);
}

export const validateEnvelope = validateProjectEnvelope;
