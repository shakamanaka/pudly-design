import { createHash } from 'node:crypto';
import type { PersistedProjectEnvelope } from '../domain/index';

export function sealEnvelope(project: PersistedProjectEnvelope): PersistedProjectEnvelope {
  const copy = structuredClone(project);
  copy.integrityHash = '';
  copy.integrityHash = createHash('sha256').update(JSON.stringify(copy)).digest('hex');
  return copy;
}
