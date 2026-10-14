import { describe, expect, it } from 'vitest';
import { createDocument, createNodeBase } from '../../src/domain/defaults';
import { createDefaultDesignSystem, DEFAULT_COMPONENT_CATALOG } from '../../src/domain/default-system';
import { validateDesignSystem, DEFAULT_DESIGN_SYSTEM_POLICY } from '../../src/domain/design-system-policy';
import { resolveComponentInstance, validateDocument } from '../../src/domain/document';
import { applyBatch } from '../../src/domain/operations';
import type { DesignSystemPolicy } from '../../src/domain/types';

function systemDocument() {
  const document = createDocument('System test');
  const system = createDefaultDesignSystem();
  document.tokens = system.tokens;
  document.components = system.components;
  return { document, system };
}

describe('default design system', () => {
  it('provides documented token-driven Button and Card primitives across all token categories', () => {
    const { document, system } = systemDocument();
    const categories = new Set(Object.values(system.tokens).map((token) => token.category));
    expect(categories).toEqual(new Set(['color', 'typography', 'spacing', 'radius', 'shadow', 'breakpoint', 'motion', 'z-index']));
    expect(Object.keys(system.components).sort()).toEqual(['button', 'card']);
    expect(system.catalog).toEqual(DEFAULT_COMPONENT_CATALOG);
    expect(system.catalog['button']!.usageRules.length).toBeGreaterThan(0);
    expect(validateDocument(document)).toMatchObject({ ok: true });
  });

  it('returns independent copies so project changes cannot mutate the shared defaults', () => {
    const first = createDefaultDesignSystem();
    first.tokens['color.primary']!.name = 'Changed locally';
    first.components.button!.name = 'Changed locally';
    const second = createDefaultDesignSystem();
    expect(second.tokens['color.primary']!.name).toBe('Primary');
    expect(second.components.button!.name).toBe('Button');
  });

  it('resolves default and instance-bound Button/Card content through the framework-neutral component port', () => {
    const { document } = systemDocument();
    const button = {
      ...createNodeBase('button-1', 'Primary action'), kind: 'component-instance' as const,
      componentId: 'button', variantId: 'primary', propertyOverrides: { label: 'Save' }, nodeOverrides: {}, slotChildren: {},
    };
    const card = {
      ...createNodeBase('card-1', 'Summary'), kind: 'component-instance' as const,
      componentId: 'card', variantId: 'elevated', propertyOverrides: { title: 'Overview' }, nodeOverrides: {}, slotChildren: {},
    };
    document.nodes[button.id] = button;
    document.nodes[card.id] = card;
    document.pages.page_1!.rootNodeIds.push(button.id, card.id);

    const checked = validateDocument(document);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(resolveComponentInstance(checked.value, button)?.nodes['button-label']).toMatchObject({ text: 'Save' });
    expect(resolveComponentInstance(checked.value, card)?.nodes['card-title']).toMatchObject({ text: 'Overview' });
    expect(resolveComponentInstance(checked.value, card)?.nodes['card-root']).toMatchObject({ style: { shadowTokenId: 'shadow.overlay' } });
  });
});

describe('configurable design-system policy', () => {
  it('reports literal color and spacing at configured warning severity in stable order', () => {
    const { document } = systemDocument();
    const node = { ...createNodeBase('hero', 'Hero'), kind: 'frame' as const };
    node.style = { fill: { kind: 'literal', value: '#FFFFFF' } };
    document.nodes.hero = node;
    document.pages.page_1!.rootNodeIds.push('hero');
    const first = validateDesignSystem(document, DEFAULT_DESIGN_SYSTEM_POLICY);
    const second = validateDesignSystem(document, DEFAULT_DESIGN_SYSTEM_POLICY);
    expect(first).toEqual(second);
    expect(first).toContainEqual(expect.objectContaining({ code: 'design-system.literal-color', severity: 'warning', targetId: 'hero' }));
    expect(first).toContainEqual(expect.objectContaining({ code: 'design-system.literal-spacing', severity: 'warning', targetId: 'hero' }));
  });

  it('checks the configured minimum against resolved spacing tokens and can block with error severity', () => {
    const { document } = systemDocument();
    const node = { ...createNodeBase('small-gap', 'Small gap'), kind: 'frame' as const };
    node.layout.gap = { kind: 'token', tokenId: 'spacing.1' };
    node.layout.padding.top = { kind: 'literal', value: 0, unit: 'px' };
    node.layout.width = { kind: 'fixed', value: { kind: 'literal', value: 240, unit: 'px' } };
    document.nodes['small-gap'] = node;
    document.pages.page_1!.rootNodeIds.push('small-gap');
    const policy: DesignSystemPolicy = {
      rules: { ...DEFAULT_DESIGN_SYSTEM_POLICY.rules, 'literal-color': 'off', 'literal-spacing': 'off', 'minimum-spacing': 'error' },
      minimumSpacingPx: 12,
    };
    const diagnostics = validateDesignSystem(document, policy);
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'design-system.minimum-spacing', severity: 'error', targetId: 'small-gap', path: 'nodes.small-gap.layout.gap' }));
    expect(diagnostics.some((entry) => entry.path === 'nodes.small-gap.layout.padding.top' && entry.code === 'design-system.minimum-spacing')).toBe(false);
    expect(diagnostics.some((entry) => entry.path === 'nodes.small-gap.layout.width.value' && entry.code === 'design-system.literal-spacing')).toBe(false);
  });

  it('applies strict color and spacing rules to component variants and responsive layout overrides', () => {
    const { document } = systemDocument();
    const button = document.components.button!;
    button.variants.primary!.nodeOverrides['button-root'] = { style: { fill: { kind: 'literal', value: '#112233' } } };
    const frame = { ...createNodeBase('responsive-frame', 'Responsive frame'), kind: 'frame' as const };
    frame.responsive = [{ id: 'compact', breakpointTokenId: 'breakpoint.tablet', priority: 0, overrides: { layout: { gap: { kind: 'literal', value: 4, unit: 'px' } } } }];
    const instance = {
      ...createNodeBase('button-instance', 'Button instance'), kind: 'component-instance' as const,
      componentId: 'button', variantId: 'secondary', propertyOverrides: {},
      nodeOverrides: { 'button-root': { style: { fill: { kind: 'literal' as const, value: '#445566' as const } } } }, slotChildren: {},
    };
    document.nodes[frame.id] = frame;
    document.nodes[instance.id] = instance;
    document.pages.page_1!.rootNodeIds.push(frame.id, instance.id);
    const policy: DesignSystemPolicy = {
      rules: { 'literal-color': 'error', 'literal-spacing': 'error', 'minimum-spacing': 'off', 'detached-instance': 'off' },
      minimumSpacingPx: 8,
    };
    const diagnostics = validateDesignSystem(document, policy);
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'design-system.literal-color', severity: 'error', path: 'components.button.variants.primary.nodeOverrides.button-root.style.fill' }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'design-system.literal-spacing', severity: 'error', path: 'nodes.responsive-frame.responsive[0].overrides.layout.gap' }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'design-system.literal-color', severity: 'error', path: 'nodes.button-instance.nodeOverrides.button-root.style.fill' }));
  });

  it('reports an explicitly marked detached node at its configured severity', () => {
    const { document } = systemDocument();
    const node = { ...createNodeBase('detached', 'Detached'), kind: 'group' as const };
    document.nodes.detached = node;
    document.pages.page_1!.rootNodeIds.push('detached');
    document.metadata['detached:detached'] = true;
    const diagnostics = validateDesignSystem(document, {
      ...DEFAULT_DESIGN_SYSTEM_POLICY,
      rules: { ...DEFAULT_DESIGN_SYSTEM_POLICY.rules, 'literal-color': 'off', 'literal-spacing': 'off', 'detached-instance': 'info' },
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'design-system.detached-instance', severity: 'info', targetId: 'detached' }));
  });

  it('rejects invalid policy configuration explicitly', () => {
    const { document } = systemDocument();
    const policy = { ...DEFAULT_DESIGN_SYSTEM_POLICY, minimumSpacingPx: -1 } as DesignSystemPolicy;
    expect(validateDesignSystem(document, policy)).toContainEqual(expect.objectContaining({ code: 'design-system.policy-configuration', severity: 'error' }));
  });

  it('preserves warnings on commit and blocks error-severity policy violations atomically', () => {
    const { document } = systemDocument();
    const node = { ...createNodeBase('hero', 'Hero'), kind: 'frame' as const };
    document.nodes.hero = node;
    document.pages.page_1!.rootNodeIds.push(node.id);
    const batch = {
      id: 'literal-fill', documentId: document.id, expectedRevision: 0, source: 'inspector' as const,
      capabilitySet: ['style.set'], operations: [{ type: 'style.set' as const, nodeId: node.id, value: { fill: { kind: 'literal' as const, value: '#FFFFFF' as const } } }],
    };
    const warningResult = applyBatch(document, batch, []);
    expect(warningResult.status).toBe('committed');
    if (warningResult.status === 'committed') {
      expect(warningResult.diagnostics).toContainEqual(expect.objectContaining({ code: 'design-system.literal-color', severity: 'warning' }));
    }

    const strictPolicy: DesignSystemPolicy = {
      ...DEFAULT_DESIGN_SYSTEM_POLICY,
      rules: { ...DEFAULT_DESIGN_SYSTEM_POLICY.rules, 'literal-color': 'error' },
    };
    const blocked = applyBatch(document, batch, [], { policy: strictPolicy });
    expect(blocked.status).toBe('rejected');
    if (blocked.status === 'rejected') expect(blocked.diagnostics).toContainEqual(expect.objectContaining({ code: 'design-system.literal-color', severity: 'error' }));
    expect(document.revision).toBe(0);
    expect(document.nodes.hero?.style.fill).toBeUndefined();
  });
});
