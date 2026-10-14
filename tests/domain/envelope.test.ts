import { describe, expect, it } from 'vitest';
import { createDocument, validateEnvelope } from '../../src/domain/index.js';

describe('persisted project envelope validation', () => {
  it('accepts a complete atomic envelope', () => {
    const result = validateEnvelope({
      formatVersion: 1,
      document: createDocument('Envelope', 'doc_envelope', 'page_envelope'),
      history: { undoableEntries: [], cursor: 0, auditTransitions: [], snapshots: [] },
      appliedBatchIds: [],
      integrityHash: 'a'.repeat(64),
    });
    expect(result.ok).toBe(true);
  });

  it('rejects malformed audit revisions and unknown envelope fields', () => {
    const result = validateEnvelope({
      formatVersion: 1,
      document: createDocument('Envelope', 'doc_envelope', 'page_envelope'),
      history: {
        undoableEntries: [], cursor: 0,
        auditTransitions: [
          { id: 'a', kind: 'commit', fromRevision: 0, toRevision: 2, timestamp: '2026-10-04T00:00:00.000Z' },
          { id: 'b', kind: 'undo', fromRevision: 2, toRevision: 1, timestamp: '2026-10-04T00:00:01.000Z' },
        ], snapshots: [],
      },
      appliedBatchIds: [],
      integrityHash: 'a'.repeat(64),
      unexpected: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((item) => item.code === 'history.transition-fields')).toBe(true);
      expect(result.diagnostics.some((item) => item.code === 'payload.unknown-field')).toBe(true);
    }
  });
});
