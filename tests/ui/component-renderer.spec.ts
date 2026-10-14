import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { createDocument, createNodeBase } from '../../src/domain';
import type {
  ComponentDefinition,
  ComponentInstanceNode,
  DesignDocument,
  FrameNode,
  IconNode,
  Layout,
  TextNode,
} from '../../src/domain/types';
import CanvasNode from '../../src/ui/components/CanvasNode.vue';

const px = (value: number) => ({ kind: 'literal' as const, value, unit: 'px' as const });
const fixed = (value: number) => ({ kind: 'fixed' as const, value: px(value) });

function frame(id: string, name: string, layout: Layout, children: string[] = []): FrameNode {
  return { ...createNodeBase(id, name), kind: 'frame', childIds: children, layout };
}

function text(id: string, name: string, value: string, layout: Layout): TextNode {
  return { ...createNodeBase(id, name), kind: 'text', text: value, textStyle: {}, layout };
}

function buttonDefinition(): ComponentDefinition {
  const rootBase = createNodeBase('root', 'Button');
  const rootLayout: Layout = { ...rootBase.layout, mode: 'horizontal', width: fixed(180), height: fixed(44), gap: px(8), padding: { top: px(8), right: px(12), bottom: px(8), left: px(12) } };
  const labelLayout: Layout = { ...createNodeBase('label', 'Label').layout, width: { kind: 'hug' }, height: { kind: 'hug' } };
  const label = text('label', 'Label', 'Default', labelLayout);
  return {
    id: 'button', name: 'Button', rootTemplateNodeId: 'root',
    templateNodes: {
      root: { ...rootBase, templateNodeId: 'root', childTemplateNodeIds: ['label'], kind: 'frame', layout: rootLayout, style: { fill: { kind: 'literal', value: '#4F46E5' }, radius: px(6) }, responsive: [
        { id: 'desktop-gap', breakpointTokenId: 'breakpoint.desktop', priority: 1, overrides: { layout: { gap: px(20) } } },
      ] },
      label: { ...label, templateNodeId: 'label', childTemplateNodeIds: [] },
    },
    properties: { label: { type: 'string', required: true, defaultValue: 'Default', binding: { templateNodeId: 'label', property: 'text' } } },
    variants: {
      primary: { id: 'primary', name: 'Primary', propertyOverrides: { label: 'Continue' }, nodeOverrides: { root: { style: { opacity: 0.9 } } } },
      secondary: { id: 'secondary', name: 'Secondary', propertyOverrides: { label: 'Cancel' }, nodeOverrides: { root: { style: { fill: { kind: 'literal', value: '#222222' } } } } },
    },
    slots: { leading: { id: 'leading', name: 'Leading icon', templateAnchorNodeId: 'root', allowedKinds: ['icon'], minItems: 0, maxItems: 1 } },
  };
}

function buttonDocument(): DesignDocument {
  const document = createDocument('Component render');
  document.components.button = buttonDefinition();
  const first: ComponentInstanceNode = {
    ...createNodeBase('button_one', 'Purchase'), kind: 'component-instance', componentId: 'button', variantId: 'primary',
    propertyOverrides: { label: 'Buy now' }, nodeOverrides: {}, slotChildren: { leading: ['leading_icon'] },
    layout: { ...createNodeBase('button_one', 'Purchase').layout, width: fixed(180), height: fixed(44) },
  };
  const second: ComponentInstanceNode = {
    ...createNodeBase('button_two', 'Cancel'), kind: 'component-instance', componentId: 'button', variantId: 'secondary',
    propertyOverrides: {}, nodeOverrides: {}, slotChildren: {},
    layout: { ...createNodeBase('button_two', 'Cancel').layout, width: fixed(180), height: fixed(44) },
  };
  const icon: IconNode = { ...createNodeBase('leading_icon', 'Cart'), kind: 'icon', libraryId: 'lucide', iconName: 'shopping-cart' };
  document.nodes.button_one = first;
  document.nodes.button_two = second;
  document.nodes.leading_icon = icon;
  document.pages.page_1!.rootNodeIds.push('button_one', 'button_two');
  return document;
}

function fillDocument(mode: 'horizontal' | 'vertical'): DesignDocument {
  const document = createDocument('Fill layout');
  const parentLayout: Layout = { ...createNodeBase('parent', 'Parent').layout, mode, width: fixed(400), height: fixed(300), gap: px(10) };
  const childLayout: Layout = { ...createNodeBase('fill', 'Fill').layout, width: { kind: 'fill' }, height: { kind: 'fill' } };
  document.nodes.parent = frame('parent', 'Parent', parentLayout, ['fill_one', 'fill_two']);
  document.nodes.fill_one = frame('fill_one', 'First', childLayout);
  document.nodes.fill_two = frame('fill_two', 'Second', childLayout);
  document.pages.page_1!.rootNodeIds.push('parent');
  return document;
}

describe('component template renderer', () => {
  it('renders button variants and bound properties from templates with responsive layout and anchored slot children', async () => {
    const document = buttonDocument();
    const wrapper = mount(CanvasNode, { props: { document, nodeId: 'button_one', viewportWidth: 900, selectedNodeIds: new Set<string>() } });
    const first = wrapper.get('[data-node-id="button_one"]');
    expect(first.find('[data-template-node-id="root"]').exists()).toBe(true);
    expect(first.find('[data-template-node-id="label"] .canvas-node__text').text()).toBe('Buy now');
    expect(first.find('[data-node-id="leading_icon"]').attributes('data-node-kind')).toBe('icon');
    expect(first.find('[data-template-node-id="root"]').element.getAttribute('style')).toContain('gap: 8px');

    const desktop = mount(CanvasNode, { props: { document, nodeId: 'button_one', viewportWidth: 1280, selectedNodeIds: new Set<string>() } });
    expect(desktop.get('[data-template-node-id="root"]').element.getAttribute('style')).toContain('gap: 20px');
    const second = mount(CanvasNode, { props: { document, nodeId: 'button_two', viewportWidth: 900, selectedNodeIds: new Set<string>() } });
    expect(second.get('[data-template-node-id="label"] .canvas-node__text').text()).toBe('Cancel');
    expect(second.get('[data-template-node-id="root"]').element.getAttribute('style')).toContain('rgb(34, 34, 34)');

    await first.find('[data-template-node-id="label"] .canvas-node__text').trigger('click');
    expect(wrapper.emitted('select')).toEqual([['button_one', false]]);
    await first.get('[data-node-id="leading_icon"]').trigger('click');
    expect(wrapper.emitted('select')).toEqual([['button_one', false], ['leading_icon', false]]);
    await first.trigger('keydown.enter');
    expect(wrapper.emitted('select')).toEqual([['button_one', false], ['leading_icon', false], ['button_one', false]]);
  });

  it('renders a card component’s nested template structure and selected property binding', () => {
    const document = createDocument('Card');
    const base = createNodeBase('card', 'Card');
    const rootLayout: Layout = { ...base.layout, mode: 'vertical', width: fixed(320), height: { kind: 'hug' }, gap: px(12), padding: { top: px(16), right: px(16), bottom: px(16), left: px(16) } };
    const childLayout: Layout = { ...createNodeBase('title', 'Title').layout, width: { kind: 'fill' }, height: { kind: 'hug' } };
    document.components.card = {
      id: 'card', name: 'Card', rootTemplateNodeId: 'card_root',
      templateNodes: {
        card_root: { ...base, templateNodeId: 'card_root', childTemplateNodeIds: ['title', 'body'], kind: 'frame', layout: rootLayout, style: { fill: { kind: 'literal', value: '#FFFFFF' }, radius: px(10), shadowTokenId: 'shadow.card' } },
        title: { ...text('title', 'Title', 'Default title', childLayout), templateNodeId: 'title', childTemplateNodeIds: [], textStyle: { typographyTokenId: 'typography.body', weight: 700 } },
        body: { ...text('body', 'Body', 'Details', childLayout), templateNodeId: 'body', childTemplateNodeIds: [] },
      },
      properties: { title: { type: 'string', required: true, defaultValue: 'Default title', binding: { templateNodeId: 'title', property: 'text' } } },
      variants: { featured: { id: 'featured', name: 'Featured', propertyOverrides: { title: 'Featured item' }, nodeOverrides: { card_root: { style: { opacity: 0.95 } } } } },
      slots: { content: { id: 'content', name: 'Content', templateAnchorNodeId: 'card_root', allowedKinds: ['text'], minItems: 0, maxItems: 2 } },
    };
    document.tokens['shadow.card'] = { id: 'shadow.card', name: 'Card shadow', category: 'shadow', value: { xPx: 0, yPx: 2, blurPx: 8, spreadPx: 0, color: { kind: 'literal', value: '#00000044' } } };
    const body = text('slot_body', 'Custom content', 'Added content', childLayout);
    document.nodes.slot_body = body;
    document.nodes.card_instance = {
      ...createNodeBase('card_instance', 'Card instance'), kind: 'component-instance', componentId: 'card', variantId: 'featured',
      propertyOverrides: {}, nodeOverrides: {}, slotChildren: { content: ['slot_body'] },
    };
    document.pages.page_1!.rootNodeIds.push('card_instance');
    const wrapper = mount(CanvasNode, { props: { document, nodeId: 'card_instance', viewportWidth: 1440, selectedNodeIds: new Set<string>() } });
    expect(wrapper.get('[data-template-node-id="title"] .canvas-node__text').text()).toBe('Featured item');
    expect(wrapper.get('[data-template-node-id="body"] .canvas-node__text').text()).toBe('Details');
    expect(wrapper.get('[data-node-id="slot_body"] .canvas-node__text').text()).toBe('Added content');
    const root = wrapper.get('[data-template-node-id="card_root"]').element as HTMLElement;
    expect(root.style.borderRadius).toBe('10px');
    expect(root.style.opacity).toBe('0.95');
    expect(root.style.boxShadow).toContain('#00000044');
    expect((wrapper.get('[data-template-node-id="title"]').element as HTMLElement).style.fontFamily).toContain('Inter');
  });

  it('uses flex growth for main-axis fill and positions free-layout anchors', () => {
    for (const mode of ['horizontal', 'vertical'] as const) {
      const document = fillDocument(mode);
      const wrapper = mount(CanvasNode, { props: { document, nodeId: 'parent', viewportWidth: 1000, selectedNodeIds: new Set<string>() } });
      for (const id of ['fill_one', 'fill_two']) {
        const element = wrapper.get(`[data-node-id="${id}"]`).element as HTMLElement;
        expect(element.style.flexGrow).toBe('1');
        expect(element.style.flexBasis).toBe('0%');
        expect(element.style[mode === 'horizontal' ? 'width' : 'height']).toBe('0px');
        expect(element.style[mode === 'horizontal' ? 'height' : 'width']).toBe('100%');
        expect(element.style.alignSelf).toBe('stretch');
      }
    }

    const document = createDocument('Anchors');
    const parentLayout: Layout = { ...createNodeBase('free_parent', 'Free').layout, mode: 'free', width: fixed(400), height: fixed(300) };
    const child = frame('anchored', 'Anchored', { ...createNodeBase('anchored', 'Anchored').layout, width: fixed(100), height: fixed(40), position: { x: 12, y: 14 } });
    child.constraints = { right: px(20), centerY: true };
    document.nodes.free_parent = frame('free_parent', 'Free', parentLayout, ['anchored']);
    document.nodes.anchored = child;
    document.pages.page_1!.rootNodeIds.push('free_parent');
    const wrapper = mount(CanvasNode, { props: { document, nodeId: 'free_parent', viewportWidth: 1000, selectedNodeIds: new Set<string>() } });
    const parentStyle = wrapper.get('[data-node-id="free_parent"]').element as HTMLElement;
    const childStyle = wrapper.get('[data-node-id="anchored"]').element as HTMLElement;
    expect(parentStyle.style.display).toBe('block');
    expect(parentStyle.style.position).toBe('relative');
    expect(childStyle.style.position).toBe('absolute');
    expect(childStyle.style.right).toBe('20px');
    expect(childStyle.style.top).toBe('50%');
    expect(childStyle.style.transform).toBe('translate(0, -50%)');
  });
});
