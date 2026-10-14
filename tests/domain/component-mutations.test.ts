import { describe, expect, it } from 'vitest';
import { applyBatch, createDocument, createNodeBase, validateDocument } from '../../src/domain';
import type { ComponentInstanceNode, DesignDocument, Operation, OperationBatch, TextNode } from '../../src/domain/types';

function componentDocument(): DesignDocument {
  const document = createDocument('Component property mutation');
  const instance: ComponentInstanceNode = {
    ...createNodeBase('button-instance', 'Action'), kind: 'component-instance', componentId: 'button', variantId: 'primary',
    propertyOverrides: { label: 'Continue' }, nodeOverrides: {}, slotChildren: {},
  };
  document.nodes[instance.id] = instance;
  document.pages.page_1!.rootNodeIds.push(instance.id);
  const checked = validateDocument(document);
  if (!checked.ok) throw new Error(checked.diagnostics.map(issue => issue.message).join('; '));
  return checked.value;
}
function batch(document: DesignDocument, id: string, operations: Operation[]): OperationBatch {
  return { id, documentId: document.id, expectedRevision: document.revision, source: 'inspector', capabilitySet: ['property.set'], operations };
}
const set = (nodeId: string, property: 'variantId' | 'propertyOverrides', value: string | Record<string, string | boolean | number>): Operation => ({ type: 'property.set', nodeId, change: { property, value } } as Operation);

describe('component instance inspector mutations', () => {
  it('rejects unknown variants and incompatible overrides without changing the instance', () => {
    const original = componentDocument();
    const invalidVariant = applyBatch(original, batch(original, 'bad-variant', [set('button-instance', 'variantId', 'missing')]), []);
    expect(invalidVariant.status).toBe('rejected');
    expect(invalidVariant.diagnostics.some(item => item.code === 'component.variant')).toBe(true);
    expect(original.nodes['button-instance']).toMatchObject({ variantId: 'primary', propertyOverrides: { label: 'Continue' } });

    const invalidOverrides = applyBatch(original, batch(original, 'bad-overrides', [set('button-instance', 'propertyOverrides', { label: 'Save', size: 'extra-wide', surprise: true })]), []);
    expect(invalidOverrides.status).toBe('rejected');
    expect(invalidOverrides.diagnostics.some(item => item.code === 'component.constraint-enum-value' || item.code === 'component.unknown-property')).toBe(true);
    expect(original.nodes['button-instance']).toMatchObject({ variantId: 'primary', propertyOverrides: { label: 'Continue' } });
  });

  it('commits a valid property override and its inverse restores the exact prior map', () => {
    const original = componentDocument();
    const changed = applyBatch(original, batch(original, 'valid-override', [set('button-instance', 'propertyOverrides', { label: 'Save', size: 'small' })]), []);
    expect(changed.status).toBe('committed');
    if (changed.status !== 'committed') return;
    expect(changed.document.nodes['button-instance']).toMatchObject({ propertyOverrides: { label: 'Save', size: 'small' } });
    expect(changed.inverseOperations).toEqual([set('button-instance', 'propertyOverrides', { label: 'Continue' })]);
    const undone = applyBatch(changed.document, batch(changed.document, 'undo-override', changed.inverseOperations), []);
    expect(undone.status).toBe('committed');
    if (undone.status === 'committed') expect(undone.document.nodes['button-instance']).toMatchObject({ propertyOverrides: { label: 'Continue' } });
  });

  it('rejects component-only fields on ordinary nodes', () => {
    const document = componentDocument();
    const text: TextNode = { ...createNodeBase('caption', 'Caption'), kind: 'text', text: 'Original', textStyle: {} };
    document.nodes.caption = text;
    document.pages.page_1!.rootNodeIds.push(text.id);
    const result = applyBatch(document, batch(document, 'wrong-kind', [set('caption', 'variantId', 'secondary')]), []);
    expect(result.status).toBe('rejected');
    expect(result.diagnostics[0]?.code).toBe('node.property-kind');
    expect(document.nodes.caption).toMatchObject({ text: 'Original' });
  });
});
