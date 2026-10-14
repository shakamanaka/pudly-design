import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { createDocument, createNodeBase } from '../../src/domain';
import type { DesignDocument, TextNode, VectorNode } from '../../src/domain/types';
import CanvasNode from '../../src/ui/components/CanvasNode.vue';
import InspectorPanel from '../../src/ui/components/InspectorPanel.vue';

function textDocument(): DesignDocument {
  const document = createDocument('Renderer test');
  const node: TextNode = {
    ...createNodeBase('text_1', 'Heading'),
    kind: 'text',
    text: 'A real canvas label',
    textStyle: { fontSize: { kind: 'literal', value: 24, unit: 'px' }, weight: 600 },
  };
  document.nodes[node.id] = node;
  document.pages.page_1?.rootNodeIds.push(node.id);
  return document;
}

describe('semantic canvas and inspector', () => {
  it('renders text from the document and emits stable selection IDs', async () => {
    const document = textDocument();
    const wrapper = mount(CanvasNode, {
      props: { document, nodeId: 'text_1', viewportWidth: 1280, selectedNodeIds: new Set<string>() },
    });

    expect(wrapper.get('[data-node-id="text_1"] .canvas-node__text').text()).toBe('A real canvas label');
    await wrapper.get('[data-node-id="text_1"]').trigger('click');
    expect(wrapper.emitted('select')).toEqual([['text_1', false]]);
  });

  it('paints a vector path from semantic fill without painting the wrapper background', () => {
    const document = createDocument('Vector renderer');
    const node: VectorNode = {
      ...createNodeBase('vector_1', 'Accent star'), kind: 'vector',
      pathData: 'M 0 0 L 10 0 L 5 10 Z', viewBox: [0, 0, 10, 10],
      style: { fill: { kind: 'literal', value: '#123456' }, textColor: { kind: 'literal', value: '#ff0000' } },
    };
    document.nodes[node.id] = node;
    document.pages.page_1!.rootNodeIds.push(node.id);
    const wrapper = mount(CanvasNode, { props: { document, nodeId: node.id, viewportWidth: 1280, selectedNodeIds: new Set<string>() } });
    const layer = wrapper.get('[data-node-id="vector_1"]').element as HTMLElement;
    expect(layer.style.color).toBe('rgb(18, 52, 86)');
    expect(layer.style.backgroundColor).toBe('transparent');
    expect(wrapper.get('svg path').attributes('fill')).toBe('currentColor');
  });

  it('emits a content operation without mutating the authoritative document', async () => {
    const document = textDocument();
    const wrapper = mount(InspectorPanel, { props: { document, nodeId: 'text_1' } });
    await wrapper.get('[aria-label="Text content"]').setValue('Edited via inspector');
    await wrapper.get('[aria-label="Text content"]').trigger('change');

    expect(wrapper.emitted('property')?.[0]).toEqual([
      'text_1', { property: 'text', value: 'Edited via inspector' },
    ]);
    expect((document.nodes.text_1 as TextNode).text).toBe('A real canvas label');
  });
});

 it('shows empty shape names only as selected editor hints', async () => {
  const document = createDocument('Shape hint');
  document.nodes.shape = { ...createNodeBase('shape', 'Decorative rule'), kind: 'frame', childIds: [] };
  const before = JSON.stringify(document);
  const wrapper = mount(CanvasNode, { props: { document, nodeId: 'shape', viewportWidth: 1280, selectedNodeIds: new Set<string>() } });
  expect(wrapper.find('.canvas-node__empty').exists()).toBe(false);
  const selected = mount(CanvasNode, { props: { document, nodeId: 'shape', viewportWidth: 1280, selectedNodeIds: new Set(['shape']) } });
  expect(selected.get('.canvas-node__empty').attributes('aria-hidden')).toBe('true');
  selected.unmount();
  expect(JSON.stringify(document)).toBe(before);
  wrapper.unmount();
});
