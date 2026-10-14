import { expect, test } from 'vitest';
import { createDocument, createNodeBase, validateDocument } from '../../src/domain';
import type { TemplateNode } from '../../src/domain/types';

test('ownership depth uses the page root even when nodes are inserted deepest-first', () => {
  for (const depth of [64, 65]) {
    const document = createDocument('Ownership bounds');
    for (let index = depth - 1; index >= 0; index -= 1) {
      const id = `node_${index}`;
      document.nodes[id] = { ...createNodeBase(id, id), kind: 'frame', childIds: index + 1 < depth ? [`node_${index + 1}`] : [] };
    }
    document.pages.page_1!.rootNodeIds = ['node_0'];
    const result = validateDocument(document);
    expect(result.ok).toBe(depth === 64);
    if (depth === 65) expect(result.diagnostics.some(issue => issue.code === 'limit.depth')).toBe(true);
  }
});

test('component template depth is bounded from its root without recursive stack growth', () => {
  for (const depth of [64, 65, 2000]) {
    const document = createDocument('Template bounds');
    const base = document.components.button!.templateNodes['button-root']!;
    const templates: Record<string, TemplateNode> = {};
    for (let index = depth - 1; index >= 0; index -= 1) {
      const id = `template_${index}`;
      templates[id] = { ...structuredClone(base), templateNodeId: id, childTemplateNodeIds: index + 1 < depth ? [`template_${index + 1}`] : [] };
    }
    document.components = { bounded: { id: 'bounded', name: 'Bounded', rootTemplateNodeId: 'template_0', templateNodes: templates, properties: {}, variants: { standard: { id: 'standard', name: 'Standard', propertyOverrides: {}, nodeOverrides: {} } }, slots: {} } };
    const result = validateDocument(document);
    expect(result.ok).toBe(depth === 64);
    if (depth > 64) expect(result.diagnostics.some(issue => issue.code === 'component.template-depth')).toBe(true);
  }
});
