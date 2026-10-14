import { expect, test } from 'vitest';
import { buildContext } from '../../src/application/context';
import { createDocument, createNodeBase } from '../../src/domain';

test('selection on a later page supplies its actual page and only the selected subtree', () => {
  const document = createDocument('Multiple pages');
  document.pages.second = { id: 'second', name: 'Second page', rootNodeIds: ['later'] };
  document.pageOrder.push('second');
  document.nodes.later = { ...createNodeBase('later', 'Later frame'), kind: 'frame' };
  document.nodes.first = { ...createNodeBase('first', 'First frame'), kind: 'frame' };
  document.pages.page_1!.rootNodeIds.push('first');
  const context = buildContext(document, 'run', 'Edit', ['later'], ['property.set']);
  expect(context.documentFragment.page?.id).toBe('second');
  expect(Object.keys(context.documentFragment.nodes)).toEqual(['later']);
  expect(context.resolvedContext).toContainEqual({ scope: 'page', sourceId: 'second' });
  expect(() => buildContext(document, 'run', 'Edit', ['first', 'later'], ['property.set'])).toThrow('one page');
});

test('an unselected run honors the active page and selected descendants include owning frames', () => {
  const document = createDocument('Owning page and frame');
  document.pages.second = { id: 'second', name: 'Second page', rootNodeIds: ['outer'] };
  document.pageOrder.push('second');
  document.nodes.outer = { ...createNodeBase('outer', 'Outer frame'), kind: 'frame', childIds: ['inner'] };
  document.nodes.inner = { ...createNodeBase('inner', 'Inner frame'), kind: 'frame', childIds: ['label'] };
  document.nodes.label = { ...createNodeBase('label', 'Label'), kind: 'text', text: 'Hello', textStyle: {} };
  document.pages.second!.rootNodeIds.push('outer');

  const unselected = buildContext(document, 'run', 'Make a page', [], ['node.create'], 'second');
  expect(unselected.documentFragment.page?.id).toBe('second');
  expect(unselected.resolvedContext).toContainEqual({ scope: 'page', sourceId: 'second' });
  const selected = buildContext(document, 'run2', 'Change label', ['label'], ['property.set'], 'second');
  expect(selected.resolvedContext).toContainEqual({ scope: 'frame', sourceId: 'inner' });
  expect(selected.resolvedContext).toContainEqual({ scope: 'frame', sourceId: 'outer' });
  expect(() => buildContext(document, 'run3', 'Wrong page', ['label'], ['property.set'], 'page_1')).toThrow('do not belong');
});
