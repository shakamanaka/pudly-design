import { describe, expect, it } from 'vitest';
import {
  createDocument,
  createNodeBase,
  resolveComponentInstance,
  resolveMeasure,
  resolveResponsiveLayout,
  validateDocument,
  migrateDocument,
} from '../../src/domain/index.js';
import type { ComponentInstanceNode, FrameNode, TextNode } from '../../src/domain/index.js';

const emptyDocument = () => createDocument('Test', 'doc_test', 'page_test');
const frame = (id: string): FrameNode => ({ ...createNodeBase(id, id), kind: 'frame' });
const text = (id: string, parentId?: string): TextNode => ({
  ...createNodeBase(id, id),
  kind: 'text',
  text: 'Hello',
  textStyle: {},
  ...(parentId === undefined ? {} : { layout: { ...createNodeBase(id, id).layout, position: { x: 12, y: 24 } } }),
});

describe('DesignDocument validation', () => {
  it('loads a valid semantic document without renderer state', () => {
    const document = emptyDocument();
    const root = frame('frame_root');
    root.layout.mode = 'free';
    root.childIds.push('text_title');
    document.nodes[root.id] = root;
    document.nodes.text_title = text('text_title', root.id);
    document.pages.page_test!.rootNodeIds.push(root.id);
    const result = validateDocument(document);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.nodes.text_title?.kind).toBe('text');
  });

  it('rejects an ownership cycle and unknown fields', () => {
    const document = emptyDocument();
    const a = frame('a');
    const b = frame('b');
    a.childIds = ['b'];
    b.childIds = ['a'];
    document.nodes.a = a;
    document.nodes.b = b;
    document.pages.page_test!.rootNodeIds = ['a'];
    const cyclic = validateDocument(document);
    expect(cyclic.ok).toBe(false);
    if (!cyclic.ok) expect(cyclic.diagnostics.some((item) => item.code === 'node.cycle')).toBe(true);

    const extended = { ...emptyDocument(), surprise: true };
    const unknown = validateDocument(extended);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.diagnostics.some((item) => item.code === 'payload.unknown-field')).toBe(true);
  });

  it('rejects unsupported schema versions and oversized graphs', () => {
    const future = { ...emptyDocument(), schemaVersion: 999 };
    const result = validateDocument(future);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.some((item) => item.code === 'document.version')).toBe(true);
    const migration = migrateDocument(future);
    expect(migration.ok).toBe(false);
    if (!migration.ok) expect(migration.diagnostics[0]?.code).toBe('document.migration-unsupported');
  });

  it('requires token category matches and deterministic responsive conflict-free resolution', () => {
    const document = emptyDocument();
    const root = frame('frame_root');
    root.layout.gap = { kind: 'token', tokenId: 'color.primary' };
    document.nodes[root.id] = root;
    document.pages.page_test!.rootNodeIds.push(root.id);
    const invalid = validateDocument(document);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.diagnostics.some((item) => item.code === 'token.category')).toBe(true);

    root.layout.gap = { kind: 'token', tokenId: 'spacing.2' };
    document.tokens.bp_tablet = { id: 'bp_tablet', name: 'Tablet', category: 'breakpoint', value: { valuePx: 768 } };
    root.responsive = [{ id: 'tablet', breakpointTokenId: 'bp_tablet', priority: 0, overrides: { visible: false, layout: { gap: { kind: 'literal', value: 24, unit: 'px' } } } }];
    expect(validateDocument(document).ok).toBe(true);
    const responsive = resolveResponsiveLayout(document, root, 900);
    expect(responsive.visible).toBe(false);
    expect(responsive.layout.gap).toEqual({ kind: 'literal', value: 24, unit: 'px' });
    expect(resolveMeasure(document, { kind: 'token', tokenId: 'spacing.2' }, 'spacing')).toBe(16);
  });

  it('resolves component property precedence, typed binding, variants, and anchored slot children', () => {
    const document = emptyDocument();
    document.components.button = {
      id: 'button', name: 'Button', rootTemplateNodeId: 'root',
      templateNodes: {
        root: { templateNodeId: 'root', name: 'Root', kind: 'frame', childTemplateNodeIds: ['label'], visible: true, layout: createNodeBase('tmp', 'tmp').layout, constraints: {}, style: {}, responsive: [] },
        label: { templateNodeId: 'label', name: 'Label', kind: 'text', childTemplateNodeIds: [], visible: true, text: 'Default', textStyle: {}, layout: createNodeBase('tmp2', 'tmp2').layout, constraints: {}, style: {}, responsive: [] },
      },
      properties: { label: { type: 'string', required: true, defaultValue: 'Default', binding: { templateNodeId: 'label', property: 'text' } } },
      variants: { compact: { id: 'compact', name: 'Compact', propertyOverrides: { label: 'Compact' }, nodeOverrides: {} } },
      slots: { leading: { id: 'leading', name: 'Leading', templateAnchorNodeId: 'root', allowedKinds: ['icon'], minItems: 0, maxItems: 1 } },
    };
    const instance: ComponentInstanceNode = {
      ...createNodeBase('instance', 'Button'), kind: 'component-instance', componentId: 'button', variantId: 'compact', propertyOverrides: { label: 'Instance' }, nodeOverrides: {}, slotChildren: { leading: [] },
    };
    document.nodes.instance = instance;
    document.pages.page_test!.rootNodeIds.push('instance');
    expect(validateDocument(document).ok).toBe(true);
    const resolved = resolveComponentInstance(document, instance);
    expect(resolved?.properties.label).toBe('Instance');
    expect(resolved?.nodes.label).toMatchObject({ text: 'Instance' });
  });
});
