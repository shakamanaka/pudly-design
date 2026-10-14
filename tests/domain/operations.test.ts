import { describe, expect, it } from 'vitest';
import { applyBatch, createDocument, createNodeBase, parseBatch } from '../../src/domain/index.js';
import type { DesignDocument, FrameNode, OperationBatch, TextNode } from '../../src/domain/index.js';

function setup(): DesignDocument {
  const document = createDocument('Test', 'doc_test', 'page_test');
  const root: FrameNode = { ...createNodeBase('root', 'Root'), kind: 'frame' };
  root.layout.mode = 'free';
  const title: TextNode = { ...createNodeBase('title', 'Title'), kind: 'text', text: 'Before', textStyle: {}, layout: { ...createNodeBase('title', 'Title').layout, position: { x: 0, y: 0 } } };
  root.childIds = ['title'];
  document.nodes.root = root;
  document.nodes.title = title;
  document.pages.page_test!.rootNodeIds = ['root'];
  return document;
}
function batch(operations: OperationBatch['operations'], revision = 0, id = 'batch_test'): OperationBatch {
  return { id, documentId: 'doc_test', expectedRevision: revision, source: 'inspector', capabilitySet: ['node.create', 'node.delete', 'node.move', 'property.set', 'layout.set', 'style.set'], operations };
}

describe('operation batches', () => {
  it('commits a typed edit as one revision and returns detached reversible values', () => {
    const document = setup();
    const operation: { type: 'property.set'; nodeId: string; change: { property: 'text'; value: string } } = { type: 'property.set', nodeId: 'title', change: { property: 'text', value: 'After' } };
    const result = applyBatch(document, batch([operation]), []);
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    expect(result.revision).toBe(1);
    expect(result.document.nodes.title).toMatchObject({ text: 'After' });
    operation.change.value = 'Mutated after submit';
    expect(result.document.nodes.title).toMatchObject({ text: 'After' });
    expect(result.inverseOperations).toEqual([{ type: 'property.set', nodeId: 'title', change: { property: 'text', value: 'Before' } }]);
  });

  it('rejects an invalid middle operation with no partial changes', () => {
    const document = setup();
    const result = applyBatch(document, batch([
      { type: 'property.set', nodeId: 'title', change: { property: 'text', value: 'First' } },
      { type: 'property.set', nodeId: 'root', change: { property: 'text', value: 'Invalid on frame' } },
      { type: 'property.set', nodeId: 'title', change: { property: 'text', value: 'Never' } },
    ]), []);
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.revision).toBe(0);
      expect(result.diagnostics[0]?.operationIndex).toBe(1);
    }
    expect(document.revision).toBe(0);
    expect(document.nodes.title).toMatchObject({ text: 'Before' });
  });

  it('rejects stale revisions, duplicate batch IDs, and unsupported operations', () => {
    const document = setup();
    const stale = applyBatch(document, batch([{ type: 'property.set', nodeId: 'title', change: { property: 'text', value: 'X' } }], 9), []);
    expect(stale.status).toBe('rejected');
    if (stale.status === 'rejected') expect(stale.diagnostics[0]?.code).toBe('revision.conflict');
    const duplicate = applyBatch(document, batch([{ type: 'property.set', nodeId: 'title', change: { property: 'text', value: 'X' } }]), ['batch_test']);
    expect(duplicate.status).toBe('rejected');
    if (duplicate.status === 'rejected') expect(duplicate.diagnostics[0]?.code).toBe('batch.duplicate');
    const unsupported = parseBatch({ ...batch([{ type: 'page.delete', pageId: 'page_test' } as never]), operations: [{ type: 'page.delete', pageId: 'page_test' }] });
    expect(unsupported.ok).toBe(false);
  });

  it('deletes subtrees and returns create operations to restore them', () => {
    const document = setup();
    const result = applyBatch(document, batch([{ type: 'node.delete', nodeId: 'root', mode: 'subtree' }]), []);
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    expect(Object.keys(result.document.nodes)).toHaveLength(0);
    expect(result.document.pages.page_test?.rootNodeIds).toEqual([]);
    expect(result.inverseOperations.map((operation) => operation.type)).toEqual(['node.create', 'node.create']);
  });

  it('rejects unnegotiated and out-of-scope edits', () => {
    const document = setup();
    const input = { ...batch([{ type: 'property.set', nodeId: 'title', change: { property: 'text', value: 'X' } }]), capabilitySet: [] };
    expect(parseBatch(input).ok).toBe(false);
    const scope = applyBatch(document, batch([{ type: 'property.set', nodeId: 'root', change: { property: 'name', value: 'X' } }]), [], { allowedNodeIds: ['title'] });
    expect(scope.status).toBe('rejected');
  });
});
