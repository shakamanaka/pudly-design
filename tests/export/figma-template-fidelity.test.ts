import { unzipSync, strFromU8 } from 'fflate';
import { expect, test } from 'vitest';
import { FigmaExporter } from '../../src/adapters/export/figma';
import { createDocument, createNodeBase } from '../../src/domain';
import type { TemplateNode } from '../../src/domain';

test('Figma reports component template mappings, target defaults, and losses per feature', async () => {
  const document = createDocument('Template fidelity');
  for (const [componentId, variantId] of [['button', 'primary'], ['card', 'standard']] as const) {
    const id = `${componentId}_instance`;
    document.nodes[id] = { ...createNodeBase(id, id), kind: 'component-instance', componentId, variantId, propertyOverrides: {}, nodeOverrides: {}, slotChildren: {} };
    document.pages.page_1!.rootNodeIds.push(id);
  }
  const button = document.components.button!;
  const root = button.templateNodes['button-root']!;
  root.childTemplateNodeIds.push('mark', 'unbundled-icon');
  root.constraints = { left: { kind: 'literal', value: 12, unit: 'px' } };
  root.responsive = [{ id: 'compact', breakpointTokenId: 'breakpoint.tablet', priority: 0, overrides: { visible: false } }];

  const vector: TemplateNode = {
    templateNodeId: 'mark', name: 'Mark', childTemplateNodeIds: [], visible: true,
    layout: structuredClone(root.layout), constraints: {}, style: { fill: { kind: 'literal', value: '#123456' } }, responsive: [],
    kind: 'vector', pathData: 'M0 0 L10 10 Z', viewBox: [0, 0, 10, 10],
  };
  const icon: TemplateNode = {
    templateNodeId: 'unbundled-icon', name: 'Missing icon', childTemplateNodeIds: [], visible: true,
    layout: structuredClone(root.layout), constraints: {}, style: { opacity: 0.5 }, responsive: [],
    kind: 'icon', libraryId: 'symbols', iconName: 'missing',
  };
  button.templateNodes.mark = vector;
  button.templateNodes['unbundled-icon'] = icon;

  const result = await new FigmaExporter().export(document);
  const archive = unzipSync(Buffer.from(result.artifacts[0]!.contents, 'base64'));
  const report = JSON.parse(strFromU8(archive['fidelity-report.json']!)) as {
    fidelity: Array<{ feature: string; status: string; fallback?: string }>;
  };
  const byFeature = new Map(report.fidelity.map((entry) => [entry.feature, entry]));
  const feature = (templateId: string, name: string, componentId = 'button') => byFeature.get(`component:${componentId}:template:${templateId}:${name}`);

  for (const name of [
    'name', 'visible', 'node-kind:frame', 'layout-mode:horizontal', 'layout-width:hug',
    'layout-height:fixed', 'layout-alignment', 'layout-spacing-padding', 'style-fill', 'style-radius',
    'constraints', 'responsive',
  ]) expect(feature('button-root', name), `missing template feature ${name}`).toBeDefined();
  expect(feature('button-root', 'name')?.status).toBe('degraded');
  expect(feature('button-root', 'visible')?.status).toBe('degraded');
  expect(feature('button-root', 'layout-width:hug')?.status).toBe('degraded');
  expect(feature('button-root', 'constraints')?.status).toBe('omitted');
  expect(feature('button-root', 'responsive')?.status).toBe('degraded');

  expect(feature('button-label', 'text-content')?.status).toBe('degraded');
  expect(feature('button-label', 'text-alignment')?.status).toBe('degraded');
  expect(feature('button-label', 'typography')?.status).toBe('degraded');
  expect(feature('card-title', 'text-alignment', 'card')?.status).toBe('degraded');
  expect(feature('card-title', 'text-alignment', 'card')?.fallback).toContain('default (LEFT)');
  expect(feature('card-root', 'layout-width:fill', 'card')?.status).toBe('degraded');
  expect(feature('card-root', 'layout-width:fill', 'card')?.fallback).toContain('100px default dimension');

  expect(feature('mark', 'vector-geometry')?.status).toBe('degraded');
  expect(feature('mark', 'node-kind:vector')?.fallback).toContain('wrapper frame');
  expect(feature('unbundled-icon', 'node-kind:icon')?.status).toBe('omitted');
  expect(feature('unbundled-icon', 'icon-library-asset')?.status).toBe('omitted');
  expect([...byFeature.keys()].some((key) => key.startsWith('component:button:template:unbundled-icon:') && !key.endsWith(':node-kind:icon') && !key.endsWith(':icon-library-asset'))).toBe(false);
});
