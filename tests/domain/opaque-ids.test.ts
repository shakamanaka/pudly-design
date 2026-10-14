import { expect, test } from 'vitest';
import { applyBatch, createDocument, createNodeBase, parseBatch, resolveComponentInstance, validateDocument } from '../../src/domain';
import type { ComponentInstanceNode, Operation } from '../../src/domain/types';

const makeBatch = (operations: Operation[]) => ({ id: 'opaque-check', documentId: 'doc_1', expectedRevision: 0, source: 'inspector', capabilitySet: ['node.create', 'style.set', 'property.set'], operations });

test('inherited target names reject without mutating JavaScript prototypes', () => {
  for (const id of ['toString', '__proto__', 'constructor']) {
    const document = createDocument('Own references');
    const objectBefore = Object.getOwnPropertyDescriptor(Object.prototype, 'style');
    const functionBefore = Object.getOwnPropertyDescriptor(Object.prototype.toString, 'style');
    const result = applyBatch(document, makeBatch([{ type: 'style.set', nodeId: id, value: { opacity: 0.5 } }]), []);
    expect(result.status).toBe('rejected');
    expect(result.diagnostics.some(issue => issue.code === 'node.missing')).toBe(true);
    expect(document.revision).toBe(0);
    expect(Object.getOwnPropertyDescriptor(Object.prototype, 'style')).toEqual(objectBefore);
    expect(Object.getOwnPropertyDescriptor(Object.prototype.toString, 'style')).toEqual(functionBefore);
  }
});

test('an own node named toString remains a valid opaque identifier', () => {
  const document = createDocument('Opaque identifier');
  const node = { ...createNodeBase('toString', 'Actual node'), kind: 'text' as const, text: 'Actual content', textStyle: {} };
  const result = applyBatch(document, makeBatch([{ type: 'node.create', node, pageId: 'page_1', index: 0 }]), []);
  expect(result.status).toBe('committed');
  if (result.status === 'committed') expect(Object.hasOwn(result.document.nodes, 'toString')).toBe(true);
});

test('inherited names cannot satisfy page, node or component template references', () => {
  const page = createDocument('Missing page'); page.pages = {}; page.pageOrder = ['toString'];
  expect(validateDocument(page).diagnostics.some(issue => issue.code === 'page.order-missing')).toBe(true);
  const node = createDocument('Missing node'); node.pages.page_1!.rootNodeIds = ['toString'];
  expect(validateDocument(node).diagnostics.some(issue => issue.code === 'node.missing')).toBe(true);
  const template = createDocument('Missing template');
  template.components.button!.templateNodes = {};
  template.components.button!.rootTemplateNodeId = 'toString';
  expect(validateDocument(template).diagnostics.some(issue => issue.code === 'component.root')).toBe(true);
});

test('component properties named toString use declared defaults rather than inherited functions', () => {
  const document = createDocument('Own component values');
  const definition = document.components.button!;
  definition.properties = { toString: { type: 'string' as const, required: true, defaultValue: 'Declared default', binding: { templateNodeId: 'button-label', property: 'text' as const } } };
  const instance: ComponentInstanceNode = { ...createNodeBase('instance', 'Own property'), kind: 'component-instance', componentId: 'button', variantId: 'primary', propertyOverrides: {}, nodeOverrides: {}, slotChildren: {} };
  document.nodes.instance = instance; document.pages.page_1!.rootNodeIds = ['instance'];
  expect(validateDocument(document).ok).toBe(true);
  const resolved = resolveComponentInstance(document, instance);
  expect(resolved?.properties.toString).toBe('Declared default');
  expect(resolved?.nodes['button-label']).toMatchObject({ text: 'Declared default' });
});

test('malformed operation changes and non-JSON metadata fail with diagnostics', () => {
  expect(parseBatch(makeBatch([{ type: 'property.set', nodeId: 'missing', change: null } as unknown as Operation])).ok).toBe(false);
  for (const value of [() => 'not data', Number.POSITIVE_INFINITY, { nested: true }]) {
    const document = createDocument('Bad metadata');
    (document.metadata as Record<string, unknown>).bad = value;
    const result = validateDocument(document);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  }
});

 test('sparse operation arrays reject atomically without throwing', () => {
  for (const length of [1, 1_000_000_000]) {
    const document = createDocument('Sparse batch');
    const batch = makeBatch(new Array<Operation>(length));
    expect(parseBatch(batch).ok).toBe(false);
    const result = applyBatch(document, batch, []);
    expect(result.status).toBe('rejected');
    expect(document.revision).toBe(0);
  }
});
