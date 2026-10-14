import { expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyBatch, createDocument, createNodeBase, validateDocument } from '../../src/domain/index.js';
import type { Operation } from '../../src/domain/types.js';
import { inspectJsonGraph } from '../../src/domain/validation-utils.js';

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? typescriptFiles(path) : entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

test('keeps the domain import graph framework and runtime independent', () => {
  const domainRoot = join(process.cwd(), 'src/domain');
  const forbidden: Array<{ file: string; specifier: string }> = [];
  const importPattern = /\b(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g;

  for (const file of typescriptFiles(domainRoot)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1]!;
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) forbidden.push({ file, specifier });
    }
  }

  expect(forbidden).toEqual([]);
});

test('bounds queued structural work including already scheduled siblings', () => {
  const sharedFanout = new Array(15).fill(0);
  const hostileDag = new Array(10).fill(sharedFanout);

  const diagnostics = inspectJsonGraph(hostileDag, 20, 80);

  expect(diagnostics).toContainEqual(expect.objectContaining({
    code: 'limit.object-count',
    path: '$.0',
  }));
});

test('measures representative 1,000-node operation batch without a timing threshold', () => {
  const document = createDocument('Acceptance workload');
  const operationCount = 100;
  const nodeCount = 1_000;
  const operations: Operation[] = [];

  for (let index = 0; index < nodeCount; index += 1) {
    const id = `text_${index}`;
    document.nodes[id] = {
      ...createNodeBase(id, `Text ${index}`),
      kind: 'text',
      text: `Before ${index}`,
      textStyle: {},
    };
    document.pages.page_1!.rootNodeIds.push(id);
    if (index < operationCount) {
      operations.push({ type: 'property.set', nodeId: id, change: { property: 'text', value: `After ${index}` } });
    }
  }
  expect(validateDocument(document).ok).toBe(true);

  const started = performance.now();
  const result = applyBatch(document, {
    id: 'acceptance-1000x100',
    documentId: document.id,
    expectedRevision: document.revision,
    source: 'inspector',
    capabilitySet: ['property.set'],
    operations,
  }, []);
  const elapsedMs = performance.now() - started;

  expect(result.status).toBe('committed');
  if (result.status === 'committed') {
    expect(result.revision).toBe(1);
    expect(result.document.nodes.text_99).toMatchObject({ text: 'After 99' });
  }
  console.info(`acceptance workload: ${nodeCount} nodes, ${operationCount} operations, ${elapsedMs.toFixed(1)} ms`);
});

test('rejects a maximum-plus-one batch before drafting the document', () => {
  const document = createDocument('Acceptance boundary');
  const operations: Operation[] = Array.from({ length: 501 }, () => ({
    type: 'property.set',
    nodeId: 'missing',
    change: { property: 'name', value: 'Rejected before draft' },
  }));
  const started = performance.now();

  const result = applyBatch(document, {
    id: 'acceptance-501-operations',
    documentId: document.id,
    expectedRevision: document.revision,
    source: 'inspector',
    capabilitySet: ['property.set'],
    operations,
  }, []);
  const elapsedMs = performance.now() - started;

  expect(result.status).toBe('rejected');
  if (result.status === 'rejected') expect(result.diagnostics.some(issue => issue.code === 'limit.operations')).toBe(true);
  expect(document.revision).toBe(0);
  console.info(`acceptance boundary: 501 operations rejected, ${elapsedMs.toFixed(1)} ms`);
});
