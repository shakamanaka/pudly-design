import { mount } from '@vue/test-utils';
import { expect, test } from 'vitest';
import { createDocument, createNodeBase } from '../../src/domain';
import CanvasNode from '../../src/ui/components/CanvasNode.vue';

test('canvas renders semantic typography token with explicit node overrides', () => {
  const document = createDocument('Typography');
  document.nodes.title = {
    ...createNodeBase('title', 'Title'), kind: 'text', text: 'Harvest',
    textStyle: { typographyTokenId: 'typography.body', fontSize: { kind: 'literal', value: 24, unit: 'px' }, weight: 600, align: 'center' },
  };
  document.pages.page_1!.rootNodeIds.push('title');
  const wrapper = mount(CanvasNode, { props: { document, nodeId: 'title', viewportWidth: 1440, selectedNodeIds: new Set<string>() } });
  const element = wrapper.get('[data-node-id="title"]').element as HTMLElement;
  expect(element.style.fontSize).toBe('24px');
  expect(element.style.fontWeight).toBe('600');
  expect(element.style.fontFamily).toContain('Inter');
  expect(element.style.lineHeight).toBe('1.5');
  expect(element.style.textAlign).toBe('center');
});
