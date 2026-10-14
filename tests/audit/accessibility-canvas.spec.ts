import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { createDocument, createNodeBase } from '../../src/domain';
import CanvasNode from '../../src/ui/components/CanvasNode.vue';

describe('canvas accessibility audit', () => {
  it('includes a text node’s visible content in its accessible button name', () => {
    const document = createDocument('Canvas accessibility');
    const base = createNodeBase('heading', 'Heading layer');
    const text = 'Visible heading content';
    document.nodes.heading = {
      ...base,
      kind: 'text',
      text,
      textStyle: {},
      layout: {
        ...base.layout,
        width: { kind: 'hug' },
        height: { kind: 'hug' },
      },
    };
    document.pages.page_1!.rootNodeIds.push('heading');

    const wrapper = mount(CanvasNode, {
      props: {
        document,
        nodeId: 'heading',
        viewportWidth: 1440,
        selectedNodeIds: new Set<string>(),
      },
    });
    const canvasControl = wrapper.get('[data-node-id="heading"]');

    expect(canvasControl.attributes('role')).toBe('button');
    expect(canvasControl.attributes('aria-label')).toBe(text);
    expect(canvasControl.attributes('aria-description')).toBe('text: Heading layer');
    wrapper.unmount();
  });

  it('retains a meaningful name for blank text and selects stable IDs from the keyboard', async () => {
    const document = createDocument('Blank text');
    document.nodes.blank = { ...createNodeBase('blank', 'Empty heading'), kind: 'text', text: '  ', textStyle: {} };
    document.pages.page_1!.rootNodeIds.push('blank');
    const wrapper = mount(CanvasNode, { props: { document, nodeId: 'blank', viewportWidth: 1440, selectedNodeIds: new Set<string>() } });
    const control = wrapper.get('[data-node-id="blank"]');
    expect(control.attributes('aria-label')).toBe('text: Empty heading');
    await control.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('select')).toEqual([['blank', false]]);
    wrapper.unmount();
  });
});
