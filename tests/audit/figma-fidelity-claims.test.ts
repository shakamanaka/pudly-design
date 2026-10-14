import { expect, test } from 'vitest';
import { FigmaExporter, buildFigmaScript } from '../../src/adapters/export/figma';
import { createDocument, createNodeBase } from '../../src/domain';
import type { TemplateNode } from '../../src/domain';

const px = (value: number) => ({ kind: 'literal' as const, value, unit: 'px' as const });

class ImportedNode {
  readonly children: ImportedNode[] = [];
  parent: ImportedNode | null = null;
  name = '';
  visible = true;
  x = 0;
  y = 0;
  width = 100;
  height = 100;
  layoutMode = 'NONE';
  cornerRadius = 0;
  fills: Array<{ type: string; color: { r: number; g: number; b: number }; opacity: number }> = [];
  characters = '';
  fontSize = 16;
  fontName = { family: 'Inter', style: 'Regular' };
  lineHeight = { unit: 'PIXELS', value: 19.2 };
  [key: string]: unknown;

  constructor(readonly id: string, readonly type: string) {}

  appendChild(child: ImportedNode) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = this;
    this.children.push(child);
  }

  findAll(predicate: (node: ImportedNode) => boolean): ImportedNode[] {
    return this.children.flatMap((child) => [ ...(predicate(child) ? [child] : []), ...child.findAll(predicate) ]);
  }

  resize(width: number, height: number) { this.width = width; this.height = height; }
  get absoluteTransform(): [[number, number, number], [number, number, number]] {
    const parent = this.parent?.absoluteTransform;
    return [[1, 0, (parent?.[0][2] ?? 0) + this.x], [0, 1, (parent?.[1][2] ?? 0) + this.y]];
  }
}

async function runImport(document: ReturnType<typeof createDocument>) {
  let id = 0;
  const page = new ImportedNode('page', 'PAGE');
  const create = (type: string) => new ImportedNode(`target-${++id}`, type);
  const figma = {
    currentPage: page,
    listAvailableFontsAsync: async () => [{ fontName: { family: 'Inter', style: 'Regular' } }, { fontName: { family: 'Inter', style: 'Semi Bold' } }],
    getNodeByIdAsync: async () => null,
    setCurrentPageAsync: async () => undefined,
    createFrame: () => create('FRAME'),
    createAutoLayout: (mode: string) => { const frame = create('FRAME'); frame.layoutMode = mode; return frame; },
    createText: () => create('TEXT'),
    createNodeFromSvg: () => { const frame = create('FRAME'); frame.appendChild(create('VECTOR')); return frame; },
    loadFontAsync: async () => undefined,
    closePlugin: () => undefined,
  };
  const script = buildFigmaScript(document);
  const execute = new Function('figma', `return (async () => { ${script} })()`) as (api: typeof figma) => Promise<unknown>;
  await execute(figma);
  return page;
}

function templateFeature(fidelity: Array<{ feature: string; status: string; fallback?: string }>, componentId: string, templateId: string, name: string) {
  return fidelity.find((entry) => entry.feature === `component:${componentId}:template:${templateId}:${name}`);
}

test('component-template root fidelity accounts for the instance projection used by the importer', async () => {
  const document = createDocument('Template projection');
  document.nodes.instance = {
    ...createNodeBase('instance', 'Runtime button'), kind: 'component-instance', componentId: 'button', variantId: 'primary',
    propertyOverrides: {}, nodeOverrides: {}, slotChildren: {},
    layout: {
      ...createNodeBase('layout', 'layout').layout,
      width: { kind: 'fixed', value: px(237) },
      height: { kind: 'fixed', value: px(53) },
    },
    style: {
      fill: { kind: 'literal', value: '#D02020' },
      textColor: { kind: 'literal', value: '#228844' },
    },
  };
  document.pages.page_1!.rootNodeIds.push('instance');

  const report = await new FigmaExporter().export(document);
  const page = await runImport(document);
  const importedRoot = page.children.find((node) => node.name === 'Runtime button');
  expect(importedRoot).toMatchObject({ name: 'Runtime button', width: 237, height: 53 });
  expect(importedRoot?.fills[0]?.color).toEqual({ r: 208 / 255, g: 32 / 255, b: 32 / 255 });
  const instanceTextColor = report.fidelity.find((entry) => entry.nodeId === 'instance' && entry.feature === 'style-text-color');
  expect(instanceTextColor?.status).toBe('omitted');
  expect(instanceTextColor?.fallback).toMatch(/text|frame|target/i);

  for (const feature of ['name', 'layout-width:hug', 'layout-height:fixed', 'style-fill']) {
    const entry = templateFeature(report.fidelity, 'button', 'button-root', feature);
    expect(entry?.status, `${feature} must not claim the definition value survived root projection`).not.toBe('preserved');
    expect(entry?.fallback, `${feature} needs to explain the instance projection`).toMatch(/instance|override|projection|flatten/i);
  }
});

test('unused component templates are not reported as preserved Figma layers', async () => {
  const document = createDocument('Unused components');
  const result = await new FigmaExporter().export(document);

  for (const [componentId, templateId, feature] of [
    ['button', 'button-root', 'name'],
    ['button', 'button-label', 'text-content'],
    ['card', 'card-root', 'layout-spacing-padding'],
  ]) {
    const entry = templateFeature(result.fidelity, componentId!, templateId!, feature!);
    expect(entry?.status, `unused ${componentId}/${templateId} ${feature} has no imported target layer`).toBe('omitted');
    expect(entry?.fallback).toMatch(/no (?:mapped )?instance|not (?:imported|emitted)|source JSON/i);
  }
});

test('text fill and text color fidelity matches the single Figma text fills property', async () => {
  const document = createDocument('Text fills');
  const label = document.components.button!.templateNodes['button-label']!;
  label.style = {
    fill: { kind: 'literal', value: '#E02020' },
    textColor: { kind: 'literal', value: '#20A060' },
  };
  label.visible = false;
  if (label.kind !== 'text') throw new Error('Expected a text template');
  label.textStyle.align = 'end';
  document.nodes.instance = {
    ...createNodeBase('instance', 'Button'), kind: 'component-instance', componentId: 'button', variantId: 'primary',
    propertyOverrides: {}, nodeOverrides: {}, slotChildren: {},
  };
  document.pages.page_1!.rootNodeIds.push('instance');

  const report = await new FigmaExporter().export(document);
  const page = await runImport(document);
  const importedLabel = page.findAll((node) => node.type === 'TEXT')[0];
  expect(importedLabel?.fills[0]?.color).toEqual({ r: 32 / 255, g: 160 / 255, b: 96 / 255 });
  expect(importedLabel).toMatchObject({ visible: false, textAlignHorizontal: 'RIGHT' });
  const fillEntry = templateFeature(report.fidelity, 'button', 'button-label', 'style-fill');
  expect(fillEntry?.status).not.toBe('preserved');
  expect(fillEntry?.fallback).toMatch(/text|glyph|background|fill/i);
});

test('vector wrapper reports layout fields the importer does not apply', async () => {
  const document = createDocument('Vector layout');
  const buttonRoot = document.components.button!.templateNodes['button-root']!;
  buttonRoot.childTemplateNodeIds.push('layout-vector');
  const vector: TemplateNode = {
    templateNodeId: 'layout-vector', name: 'Layout vector', childTemplateNodeIds: [], visible: true,
    layout: {
      ...structuredClone(buttonRoot.layout), mode: 'horizontal', align: 'end', justify: 'center', gap: px(11),
      padding: { top: px(5), right: px(6), bottom: px(7), left: px(8) },
      width: { kind: 'fixed', value: px(24) }, height: { kind: 'fixed', value: px(24) },
    },
    constraints: {}, style: { fill: { kind: 'literal', value: '#345678' }, opacity: 0.65, radius: px(3) }, responsive: [],
    kind: 'vector', pathData: 'M0 0 L10 10 Z', viewBox: [0, 0, 10, 10],
  };
  document.components.button!.templateNodes['layout-vector'] = vector;
  buttonRoot.childTemplateNodeIds.push('unbundled-icon');
  document.components.button!.templateNodes['unbundled-icon'] = {
    templateNodeId: 'unbundled-icon', name: 'Missing icon', childTemplateNodeIds: [], visible: true,
    layout: structuredClone(vector.layout), constraints: {}, style: {}, responsive: [],
    kind: 'icon', libraryId: 'symbols', iconName: 'missing',
  };
  document.nodes.instance = {
    ...createNodeBase('instance', 'Button'), kind: 'component-instance', componentId: 'button', variantId: 'primary',
    propertyOverrides: {}, nodeOverrides: {}, slotChildren: {},
  };
  document.pages.page_1!.rootNodeIds.push('instance');

  const report = await new FigmaExporter().export(document);
  const page = await runImport(document);
  const vectorWrapper = page.findAll((node) => node.name === 'Layout vector')[0];
  expect(vectorWrapper).toMatchObject({ type: 'FRAME', layoutMode: 'NONE', width: 24, height: 24, opacity: 0.65, cornerRadius: 3 });
  expect(vectorWrapper?.itemSpacing).toBeUndefined();
  expect(vectorWrapper?.children[0]?.fills[0]?.color).toEqual({ r: 52 / 255, g: 86 / 255, b: 120 / 255 });
  expect(page.findAll((node) => node.name === 'Missing icon')).toHaveLength(0);
  expect(templateFeature(report.fidelity, 'button', 'unbundled-icon', 'node-kind:icon')?.status).toBe('omitted');
  for (const feature of ['layout-alignment', 'layout-spacing-padding']) {
    const entry = templateFeature(report.fidelity, 'button', 'layout-vector', feature);
    expect(entry?.status, `vector ${feature} is not applied by the wrapper importer`).not.toBe('preserved');
  }
  const vectorRadius = templateFeature(report.fidelity, 'button', 'layout-vector', 'style-radius');
  expect(vectorRadius?.status).toBe('degraded');
  expect(vectorRadius?.fallback).toMatch(/wrapper/i);
});

test('free-layout component frames report unapplied alignment and spacing', async () => {
  const document = createDocument('Free layout');
  const root = document.components.button!.templateNodes['button-root']!;
  const label = document.components.button!.templateNodes['button-label']!;
  root.layout = {
    ...root.layout, mode: 'free', align: 'center', justify: 'space-between', gap: px(13),
    padding: { top: px(4), right: px(5), bottom: px(6), left: px(7) },
  };
  label.layout = { ...label.layout, position: { x: 17, y: 23 } };
  document.nodes.instance = {
    ...createNodeBase('instance', 'Free button'), kind: 'component-instance', componentId: 'button', variantId: 'primary',
    propertyOverrides: {}, nodeOverrides: {}, slotChildren: {},
  };
  document.pages.page_1!.rootNodeIds.push('instance');

  const report = await new FigmaExporter().export(document);
  const page = await runImport(document);
  const importedRoot = page.children.find((node) => node.name === 'Free button');
  const importedLabel = page.findAll((node) => node.type === 'TEXT')[0];
  expect(importedRoot).toMatchObject({ type: 'FRAME', layoutMode: 'NONE' });
  expect(importedRoot?.itemSpacing).toBeUndefined();
  expect(importedRoot?.paddingTop).toBeUndefined();
  expect(importedLabel).toMatchObject({ x: 17, y: 23 });
  for (const feature of ['layout-alignment', 'layout-spacing-padding']) {
    const entry = templateFeature(report.fidelity, 'button', 'button-root', feature);
    expect(entry?.status).toBe('omitted');
  }
  const labelPosition = templateFeature(report.fidelity, 'button', 'button-label', 'layout-position');
  expect(labelPosition?.status).toBe('degraded');
  expect(labelPosition?.fallback).not.toMatch(/template root placement/i);
});
