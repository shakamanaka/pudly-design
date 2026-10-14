import type { Diagnostic } from './types';

export const MAX_DOCUMENT_NODES = 10_000;
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_BATCH_OPERATIONS = 500;
export const MAX_BATCH_BYTES = 1024 * 1024;
export const MAX_OWNERSHIP_DEPTH = 64;
export const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
export function getOwnValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function addDiagnostic(
  diagnostics: Diagnostic[],
  code: string,
  message: string,
  path?: string,
  targetId?: string,
  operationIndex?: number,
): void {
  const diagnostic: Diagnostic = { code, message, severity: 'error' };
  if (path !== undefined) diagnostic.path = path;
  if (targetId !== undefined) diagnostic.targetId = targetId;
  if (operationIndex !== undefined) diagnostic.operationIndex = operationIndex;
  diagnostics.push(diagnostic);
}

export function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  diagnostics: Diagnostic[],
): boolean {
  let valid = true;
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      addDiagnostic(diagnostics, 'payload.dangerous-key', `Forbidden key "${key}".`, `${path}.${key}`);
      valid = false;
    } else if (!keys.includes(key)) {
      addDiagnostic(diagnostics, 'payload.unknown-field', `Unknown field "${key}".`, `${path}.${key}`);
      valid = false;
    }
  }
  return valid;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function safeSerializedSize(value: unknown): number | null {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return null;
  }
}

/** Iterative structural guard prevents cycles, exotic object prototypes, and deep hostile values. */
export function inspectJsonGraph(value: unknown, maxNodes: number, maxDepth: number): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const active = new WeakSet<object>();
  const stack: Array<{ value: unknown; path: string; depth: number; leave?: boolean }> = [
    { value, path: '$', depth: 0 },
  ];
  let count = 0;
  let pendingValues = 1;
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    if (entry.leave) {
      if (typeof entry.value === 'object' && entry.value !== null) active.delete(entry.value);
      continue;
    }
    pendingValues -= 1;
    count += 1;
    if (count > maxNodes) {
      addDiagnostic(diagnostics, 'limit.object-count', 'Payload exceeds the structural object limit.', entry.path);
      break;
    }
    if (entry.depth > maxDepth) {
      addDiagnostic(diagnostics, 'limit.depth', 'Payload exceeds the maximum nesting depth.', entry.path);
      continue;
    }
    if (['function', 'symbol', 'bigint'].includes(typeof entry.value) || (typeof entry.value === 'number' && !Number.isFinite(entry.value))) {
      addDiagnostic(diagnostics, 'payload.non-json-value', 'Payload values must be JSON data with finite numbers.', entry.path);
      continue;
    }
    if (typeof entry.value !== 'object' || entry.value === null) continue;
    if (active.has(entry.value)) {
      addDiagnostic(diagnostics, 'payload.cycle', 'Payload contains a cyclic reference.', entry.path);
      continue;
    }
    if (!Array.isArray(entry.value) && !isRecord(entry.value)) {
      addDiagnostic(diagnostics, 'payload.object-type', 'Payload must use plain objects and arrays.', entry.path);
      continue;
    }
    active.add(entry.value);
    stack.push({ ...entry, leave: true });
    const keys = Array.isArray(entry.value) ? null : Object.keys(entry.value);
    const length = Array.isArray(entry.value) ? entry.value.length : keys!.length;
    if (length > maxNodes - count - pendingValues) {
      addDiagnostic(diagnostics, 'limit.object-count', 'Payload exceeds the structural object limit.', entry.path);
      break;
    }
    pendingValues += length;
    for (let index = length - 1; index >= 0; index -= 1) {
      const key = keys === null ? String(index) : keys[index]!;
      if (!Object.hasOwn(entry.value, key)) {
        addDiagnostic(diagnostics, 'payload.sparse-array', 'Payload arrays must contain every indexed value.', `${entry.path}.${key}`);
        return diagnostics;
      }
      if (DANGEROUS_KEYS.has(key)) {
        addDiagnostic(diagnostics, 'payload.dangerous-key', `Forbidden key "${key}".`, `${entry.path}.${key}`);
      }
      stack.push({ value: (entry.value as Record<string, unknown>)[key], path: `${entry.path}.${key}`, depth: entry.depth + 1 });
    }
  }
  return diagnostics;
}

export function validationOk<T>(value: T, diagnostics: Diagnostic[]) {
  return { ok: true as const, value, diagnostics };
}
export function validationFailure(diagnostics: Diagnostic[]) {
  return { ok: false as const, diagnostics };
}
