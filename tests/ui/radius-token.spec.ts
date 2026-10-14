import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { createDocument, createNodeBase } from '../../src/domain';
import type { ComponentDefinition, ComponentInstanceNode, FrameNode } from '../../src/domain/types';
import CanvasNode from '../../src/ui/components/CanvasNode.vue';

const px = (value: number) => ({ kind: 'literal' as const, value, unit: 'px' as const });
const token = (tokenId: string) => ({ kind: 'token' as const, tokenId });

describe('canvas radius tokens', () => {
  it('resolves radius-category tokens for ordinary nodes and component templates, preserving literal radii', () => {
    const document = createDocument('Radius tokens');
    document.tokens['radius.lg'] = { id: 'radius.lg', name: 'Large radius', category: 'radius', value: { valuePx: 18 } };
    // This deliberately differs from the radius value so a spacing-category lookup cannot pass.
    document.tokens['spacing.sm'] = { id: 'spacing.sm', name: 'Small spacing', category: 'spacing', value: { valuePx: 6 } };

    const ordinary: FrameNode = {
      ...createNodeBase('ordinary', 'Ordinary frame'),
      kind: 'frame',
      childIds: [],
      style: { radius: token('radius.lg') },
    };
    const literal: FrameNode = {
      ...createNodeBase('literal', 'Literal radius'),
      kind: 'frame',
      childIds: [],
      style: { radius: px(11) },
    };
    document.nodes.ordinary = ordinary;
    document.nodes.literal = literal;

    const templateBase = createNodeBase('template-root', 'Template root');
    const definition: ComponentDefinition = {
      id: 'rounded',
      name: 'Rounded component',
      rootTemplateNodeId: 'root',
      templateNodes: {
        root: {
          ...templateBase,
          templateNodeId: 'root',
          childTemplateNodeIds: [],
          kind: 'frame',
          style: { radius: token('radius.lg') },
        },
      },
      properties: {},
      variants: { default: { id: 'default', name: 'Default', propertyOverrides: {}, nodeOverrides: {} } },
      slots: {},
    };
    document.components.rounded = definition;
    const instance: ComponentInstanceNode = {
      ...createNodeBase('instance', 'Rounded instance'),
      kind: 'component-instance',
      componentId: 'rounded',
      variantId: 'default',
      propertyOverrides: {},
      nodeOverrides: {},
      slotChildren: {},
    };
    document.nodes.instance = instance;

    const render = (nodeId: string) => mount(CanvasNode, {
      props: { document, nodeId, viewportWidth: 1280, selectedNodeIds: new Set<string>() },
    });
    const ordinaryWrapper = render('ordinary');
    const literalWrapper = render('literal');
    const instanceWrapper = render('instance');

    expect((ordinaryWrapper.get('[data-node-id="ordinary"]').element as HTMLElement).style.borderRadius).toBe('18px');
    expect((literalWrapper.get('[data-node-id="literal"]').element as HTMLElement).style.borderRadius).toBe('11px');
    expect((instanceWrapper.get('[data-template-node-id="root"]').element as HTMLElement).style.borderRadius).toBe('18px');

    ordinaryWrapper.unmount();
    literalWrapper.unmount();
    instanceWrapper.unmount();
  });
});
