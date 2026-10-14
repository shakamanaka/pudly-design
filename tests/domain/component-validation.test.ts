import { describe, expect, it } from 'vitest';
import { createDocument, createNodeBase, resolveComponentInstance, validateDocument } from '../../src/domain/index.js';
import type { ComponentDefinition, ComponentInstanceNode, DesignDocument, TextNode } from '../../src/domain/index.js';

function setup(): DesignDocument {
  const document = createDocument('Components', 'component_doc', 'component_page');
  const text: TextNode = { ...createNodeBase('tmp', 'Label'), kind: 'text', text: 'Default', textStyle: {} };
  const root = { ...createNodeBase('tmp-root', 'Root'), kind: 'frame' as const };
  const definition: ComponentDefinition = {
    id: 'button', name: 'Button', rootTemplateNodeId: 'root',
    templateNodes: {
      root: { ...root, templateNodeId: 'root', childTemplateNodeIds: ['label'] },
      label: { ...text, templateNodeId: 'label', childTemplateNodeIds: [], style: { fill: { kind: 'literal', value: '#FFFFFF' }, radius: { kind: 'literal', value: 8, unit: 'px' } }, textStyle: { fontSize: { kind: 'literal', value: 16, unit: 'px' }, weight: 400 } },
    },
    properties: { label: { type: 'string', required: true, defaultValue: 'Default', binding: { templateNodeId: 'label', property: 'text' } } },
    variants: { standard: { id: 'standard', name: 'Standard', propertyOverrides: {}, nodeOverrides: {} } },
    slots: {},
  };
  document.components.button = definition;
  const instance: ComponentInstanceNode = {
    ...createNodeBase('instance', 'Button'), kind: 'component-instance', componentId: 'button', variantId: 'standard',
    propertyOverrides: {}, nodeOverrides: {}, slotChildren: {},
  };
  document.nodes.instance = instance;
  document.pages.component_page!.rootNodeIds.push('instance');
  return document;
}

function diagnostic(document: DesignDocument, code: string) {
  const result = validateDocument(document);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error(`Expected blocking ${code} diagnostic.`);
  expect(result.diagnostics.map((item) => item.code)).toContain(code);
}

function mutate(document: DesignDocument, callback: (raw: Record<string, unknown>) => void): DesignDocument {
  const raw = structuredClone(document) as unknown as Record<string, unknown>;
  callback(raw);
  return raw as unknown as DesignDocument;
}

function component(raw: Record<string, unknown>): Record<string, unknown> {
  return (raw.components as Record<string, unknown>).button as Record<string, unknown>;
}

describe('component validation fails closed on malformed definitions and overrides', () => {
  it('reports malformed definition record shapes', () => {
    const malformed = mutate(setup(), (raw) => { component(raw).properties = null; });
    diagnostic(malformed, 'component.record');

    const badRoot = mutate(setup(), (raw) => { component(raw).rootTemplateNodeId = null; });
    diagnostic(badRoot, 'value.string');
  });

  it('reports malformed template-node payloads and child lists', () => {
    const malformed = mutate(setup(), (raw) => {
      const definition = component(raw);
      (definition.templateNodes as Record<string, unknown>).label = { templateNodeId: 'label', kind: 'text', childTemplateNodeIds: 'none' };
    });
    diagnostic(malformed, 'component.array');
  });

  it('reports missing variant override maps', () => {
    const malformed = mutate(setup(), (raw) => {
      const variants = component(raw).variants as Record<string, Record<string, unknown>>;
      variants.standard!.propertyOverrides = null;
    });
    diagnostic(malformed, 'component.variant-properties');

    const badValue = mutate(setup(), (raw) => {
      const variants = component(raw).variants as Record<string, Record<string, unknown>>;
      variants.standard!.propertyOverrides = { label: false };
    });
    diagnostic(badValue, 'component.property-type');
  });

  it('reports malformed instance override records without throwing', () => {
    const malformed = mutate(setup(), (raw) => {
      const nodes = raw.nodes as Record<string, Record<string, unknown>>;
      nodes.instance!.nodeOverrides = null;
    });
    diagnostic(malformed, 'component.instance-nodes');
  });

  it('rejects incompatible bindings and conflicting direct node overrides', () => {
    const incompatible = mutate(setup(), (raw) => {
      const properties = component(raw).properties as Record<string, Record<string, unknown>>;
      properties.label!.binding = { templateNodeId: 'label', property: 'visible' };
    });
    diagnostic(incompatible, 'component.binding-type');

    const conflict = mutate(setup(), (raw) => {
      const variants = component(raw).variants as Record<string, Record<string, unknown>>;
      variants.standard!.nodeOverrides = { label: { text: 'Direct text' } };
    });
    diagnostic(conflict, 'component.binding-conflict');

    const instanceConflict = mutate(setup(), (raw) => {
      const nodes = raw.nodes as Record<string, Record<string, unknown>>;
      nodes.instance!.nodeOverrides = { label: { text: 'Direct instance text' } };
    });
    diagnostic(instanceConflict, 'component.binding-conflict');
  });

  it('rejects incompatible node override fields and token category constraints', () => {
    const incompatible = mutate(setup(), (raw) => {
      const variants = component(raw).variants as Record<string, Record<string, unknown>>;
      variants.standard!.nodeOverrides = { root: { text: 'not text' } };
    });
    diagnostic(incompatible, 'component.override-incompatible');

    const category = mutate(setup(), (raw) => {
      const properties = component(raw).properties as Record<string, Record<string, unknown>>;
      properties.label = { type: 'token', required: true, defaultValue: { kind: 'token', tokenId: 'color.primary' }, constraints: { tokenCategory: 'spacing' } };
    });
    diagnostic(category, 'component.property-token-category');
  });

  it('rejects token category constraints on non-token properties', () => {
    const malformed = mutate(setup(), (raw) => {
      const properties = component(raw).properties as Record<string, Record<string, unknown>>;
      properties.label!.constraints = { tokenCategory: 'color' };
    });
    diagnostic(malformed, 'component.constraint-type');
  });

  it('rejects enum members that do not satisfy the declared property type', () => {
    const malformed = mutate(setup(), (raw) => {
      const properties = component(raw).properties as Record<string, Record<string, unknown>>;
      properties.label!.constraints = { enum: ['Allowed', false] };
    });
    diagnostic(malformed, 'component.constraint-enum-value');
  });

  it('deep merges partial style and text style overrides without aliasing template values', () => {
    const document = setup();
    const definition = document.components.button!;
    definition.variants.standard!.nodeOverrides.label = {
      style: { opacity: 0.5 }, textStyle: { weight: 700 },
    };
    const instance = document.nodes.instance as ComponentInstanceNode;
    instance.nodeOverrides.label = { style: { radius: { kind: 'literal', value: 12, unit: 'px' } }, textStyle: { align: 'center' } };
    const resolved = resolveComponentInstance(document, instance);
    expect(resolved?.nodes.label).toMatchObject({
      style: { fill: { value: '#FFFFFF' }, radius: { value: 12 }, opacity: 0.5 },
      textStyle: { fontSize: { value: 16 }, weight: 700, align: 'center' },
    });
    const rendered = resolved!.nodes.label as { style: Record<string, unknown>; textStyle: Record<string, unknown> };
    rendered.style.opacity = 0.25;
    rendered.textStyle.weight = 900;
    expect(definition.variants.standard!.nodeOverrides.label?.style?.opacity).toBe(0.5);
    expect(definition.templateNodes.label?.kind).toBe('text');
    const labelTemplate = definition.templateNodes.label;
    if (labelTemplate?.kind !== 'text') throw new Error('Expected a text template node.');
    expect(labelTemplate.textStyle.weight).toBe(400);
  });
});
