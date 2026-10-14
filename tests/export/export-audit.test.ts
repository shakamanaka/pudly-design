import { expect, test } from 'vitest';
import { Buffer } from 'node:buffer';
import { strFromU8, unzipSync } from 'fflate';
import { NativeExporter } from '../../src/adapters/export/native';
import { buildFigmaScript, FigmaExporter } from '../../src/adapters/export/figma';
import { VueExporter } from '../../src/adapters/export/vue';
import { createDefaultDesignSystem, createDocument, createNodeBase } from '../../src/domain';
import type { ComponentInstanceNode, DesignDocument, Layout, TextNode, DesignNode } from '../../src/domain/types';

const px = (value: number) => ({ kind: 'literal' as const, value, unit: 'px' as const });

function componentDocument(): DesignDocument {
  const document = createDocument('Exporter audit');
  const system = createDefaultDesignSystem();
  Object.assign(document.tokens, system.tokens);
  Object.assign(document.components, system.components);
  const base = createNodeBase('component_instance', 'Audit button');
  const layout: Layout = {
    ...base.layout,
    mode: 'vertical',
    width: { kind: 'fixed', value: px(220) },
    height: { kind: 'fixed', value: px(88) },
    gap: px(37),
    padding: { top: px(9), right: px(9), bottom: px(9), left: px(9) },
  };
  const instance: ComponentInstanceNode = {
    ...base,
    kind: 'component-instance',
    componentId: 'button',
    variantId: 'primary',
    propertyOverrides: { label: 'Audit action' },
    nodeOverrides: {},
    slotChildren: {},
    layout,
    style: { fill: { kind: 'literal', value: '#FF0000' }, opacity: 0.7 },
  };
  document.nodes[instance.id] = instance;
  document.pages.page_1!.rootNodeIds.push(instance.id);
  return document;
}

function artifactText(artifacts: Array<{ name: string; contents: string }>, name: string): string {
  const artifact = artifacts.find((item) => item.name === name);
  expect(artifact, `Expected artifact ${name}`).toBeDefined();
  return artifact!.contents;
}

function figmaPayload(script: string): { renderTrees: Record<string, Array<Record<string, unknown>>> } {
  const start = script.indexOf('const __doc = ') + 'const __doc = '.length;
  const end = script.indexOf(';\nconst __pageId', start);
  expect(start).toBeGreaterThan('const __doc = '.length - 1);
  expect(end).toBeGreaterThan(start);
  return JSON.parse(script.slice(start, end)) as { renderTrees: Record<string, Array<Record<string, unknown>>> };
}

class FakeFigmaNode {
  readonly children: FakeFigmaNode[] = [];
  parent: FakeFigmaNode | null = null;
  name = '';
  x = 0;
  y = 0;
  width = 100;
  height = 100;
  layoutMode = 'NONE';
  fontSize = 16;
  itemSpacing = 0;
  paddingTop = 0;
  fills: unknown[] = [];
  constructor(readonly id: string, readonly type: string) {}
  appendChild(child: FakeFigmaNode) { child.parent = this; this.children.push(child); }
  resize(width: number, height: number) { this.width = width; this.height = height; }
  get absoluteTransform(): [[number, number, number], [number, number, number]] {
    const parent = this.parent?.absoluteTransform;
    return [[1, 0, (parent?.[0][2] ?? 0) + this.x], [0, 1, (parent?.[1][2] ?? 0) + this.y]];
  }
}

async function executeFigmaScript(script: string): Promise<FakeFigmaNode[]> {
  let sequence = 0;
  const page = new FakeFigmaNode('page', 'PAGE');
  const created: FakeFigmaNode[] = [];
  const create = (type: string) => {
    const node = new FakeFigmaNode(`target-${++sequence}`, type);
    created.push(node);
    return node;
  };
  const figma = {
    currentPage: page,
    listAvailableFontsAsync: async () => [{ fontName: { family: 'Inter', style: 'Regular' } }],
    createFrame: () => create('FRAME'),
    createAutoLayout: (mode: string) => { const frame = create('FRAME'); frame.layoutMode = mode; return frame; },
    createText: () => create('TEXT'),
    createNodeFromSvg: () => create('FRAME'),
    loadFontAsync: async () => undefined,
    closePlugin: () => undefined,
  };
  const execute = new Function('figma', `return (async () => { ${script} })()`) as unknown as (api: typeof figma) => Promise<unknown>;
  await execute(figma);
  return created;
}

test('native exporter round-trips the complete semantic document losslessly', async () => {
  const document = componentDocument();
  const result = await new NativeExporter().export(document);
  expect(result.status).toBe('succeeded');
  expect(result.fidelity.every((entry) => entry.status === 'preserved')).toBe(true);
  expect(JSON.parse(artifactText(result.artifacts, 'design.codex.json'))).toEqual(document);
});

test('Vue component export preserves the template root internal layout and instance sizing', async () => {
  const document = componentDocument();
  const result = await new VueExporter().export(document);
  const tree = JSON.parse(artifactText(result.artifacts, 'src/design-tree.json')) as Array<{ roots: Array<Record<string, unknown>> }>;
  const instance = tree[0]!.roots[0]!;
  const templateRoot = (instance.children as Array<Record<string, unknown>>)[0]!;
  const instanceLayout = instance.layout as Layout;
  const rootLayout = templateRoot.layout as Layout;
  const definitionLayout = document.components.button!.templateNodes['button-root']!.layout;

  expect(rootLayout.mode).toBe('horizontal');
  expect(rootLayout.gap).toEqual(definitionLayout.gap);
  expect(rootLayout.padding).toEqual(definitionLayout.padding);
  expect(rootLayout.width).toEqual(instanceLayout.width);
  expect(rootLayout.height).toEqual(instanceLayout.height);
});

test('Vue component export applies instance style overrides to the resolved template root', async () => {
  const document = componentDocument();
  const result = await new VueExporter().export(document);
  const tree = JSON.parse(artifactText(result.artifacts, 'src/design-tree.json')) as Array<{ roots: Array<Record<string, unknown>> }>;
  const instance = tree[0]!.roots[0]!;
  const templateRoot = (instance.children as Array<Record<string, unknown>>)[0]!;
  expect(templateRoot.style).toMatchObject({ fill: { kind: 'literal', value: '#FF0000' }, opacity: 0.7 });
});

test('Vue component wrapper does not apply instance gap or padding', async () => {
  const document = componentDocument();
  const result = await new VueExporter().export(document);
  const tree = JSON.parse(artifactText(result.artifacts, 'src/design-tree.json')) as Array<{ roots: Array<Record<string, unknown>> }>;
  const wrapperLayout = tree[0]!.roots[0]!.layout as Layout;
  expect(wrapperLayout.gap).toEqual(px(0));
  expect(wrapperLayout.padding).toEqual({ top: px(0), right: px(0), bottom: px(0), left: px(0) });
});

test('Figma component export keeps template root layout separate from instance geometry', async () => {
  const document = componentDocument();
  const payload = figmaPayload(buildFigmaScript(document));
  const instance = payload.renderTrees.page_1![0]!;

  expect(instance.kind).toBe('frame');
  expect(instance.layout).toMatchObject({
    mode: 'horizontal',
    width: { kind: 'fixed', value: px(220) },
    height: { kind: 'fixed', value: px(88) },
    gap: document.components.button!.templateNodes['button-root']!.layout.gap,
    padding: document.components.button!.templateNodes['button-root']!.layout.padding,
  });
  expect(instance.style).toMatchObject({ fill: { kind: 'literal', value: '#FF0000' }, opacity: 0.7 });
  const [target] = await executeFigmaScript(buildFigmaScript(document));
  expect(target?.layoutMode).toBe('HORIZONTAL');
  expect(target?.width).toBe(220);
  expect(target?.height).toBe(88);
  expect(target?.itemSpacing).toBe(8);
  expect(target?.paddingTop).toBe(16);
});

test('Figma fidelity reports unsupported component-template constraints', async () => {
  const document = componentDocument();
  const root = document.components.button!.templateNodes['button-root']!;
  root.constraints = { left: px(12), top: px(14) };
  const result = await new FigmaExporter().export(document);
  expect(result.fidelity.some((entry) => entry.feature.includes('button-root') && /constraint/i.test(entry.feature) && entry.status !== 'preserved')).toBe(true);
});

test('Figma fidelity reports component-template shadow effects as omitted', async () => {
  const document = componentDocument();
  const root = document.components.button!.templateNodes['button-root']!;
  root.style = { ...root.style, shadowTokenId: 'shadow.card' };
  document.tokens['shadow.card'] = {
    id: 'shadow.card', name: 'Card shadow', category: 'shadow',
    value: { xPx: 0, yPx: 2, blurPx: 8, spreadPx: 0, color: { kind: 'literal', value: '#000000' } },
  };
  const result = await new FigmaExporter().export(document);
  expect(result.fidelity.some((entry) => entry.feature.includes('button-root') && /shadow/i.test(entry.feature) && entry.status !== 'preserved')).toBe(true);
});

test('Figma resolves an explicit typography-token font size instead of emitting zero', async () => {
  const document = createDocument('Typography token export');
  const text: TextNode = {
    ...createNodeBase('token_sized_text', 'Token sized'),
    kind: 'text', text: 'Token sized',
    textStyle: { fontSize: { kind: 'token', tokenId: 'typography.title' } },
  };
  document.nodes[text.id] = text;
  document.pages.page_1!.rootNodeIds.push(text.id);
  const nodes = await executeFigmaScript(buildFigmaScript(document));
  expect(nodes.find((node) => node.type === 'TEXT')?.fontSize).toBe(24);
});

test('Vue and Figma keep injected text in data and use escaped rendering paths', async () => {
  const document = createDocument('</script><script>alert("document")</script>');
  const malicious = '</script><img src=x onerror=alert(1)>';
  const node: TextNode = { ...createNodeBase('unsafe_text', 'Unsafe'), kind: 'text', text: malicious, textStyle: {} };
  document.nodes[node.id] = node;
  document.pages.page_1!.rootNodeIds.push(node.id);

  const vue = await new VueExporter().export(document);
  expect(artifactText(vue.artifacts, 'src/DesignNode.vue')).toContain('{{ node.text }}');
  expect(artifactText(vue.artifacts, 'src/DesignNode.vue')).not.toContain('v-html');
  expect(JSON.parse(artifactText(vue.artifacts, 'src/design-tree.json'))[0].roots[0].text).toBe(malicious);

  const script = buildFigmaScript(document);
  expect(script).not.toContain('</script>');
  expect(script).not.toContain('<img');
  expect(figmaPayload(script).renderTrees.page_1![0]!.text).toBe(malicious);
});

test('native, Vue, and Figma exporters handle a bounded 100-node document graph', async () => {
  const document = createDocument('100 node export smoke');
  const ids: string[] = [];
  for (let index = 0; index < 100; index += 1) {
    const id = `text_${index}`;
    const node: TextNode = { ...createNodeBase(id, `Text ${index}`), kind: 'text', text: `Value ${index}`, textStyle: {} };
    document.nodes[id] = node;
    document.pages.page_1!.rootNodeIds.push(id);
    ids.push(id);
  }

  const [native, vue, figma] = await Promise.all([
    new NativeExporter().export(document),
    new VueExporter().export(document),
    new FigmaExporter().export(document),
  ]);
  expect(JSON.parse(artifactText(native.artifacts, 'design.codex.json')).nodes).toHaveProperty('text_99');
  const tree = JSON.parse(artifactText(vue.artifacts, 'src/design-tree.json')) as Array<{ roots: Array<{ sourceId: string }> }>;
  expect(tree[0]!.roots.map((node) => node.sourceId)).toEqual(ids);
  const archive = unzipSync(Buffer.from(artifactText(figma.artifacts, 'codex-design-figma-plugin.zip'), 'base64'));
  const figmaCode = strFromU8(archive['code.js']!);
  expect(figmaCode).toContain('text_99');
  expect(native.status).toBe('succeeded');
  expect(vue.status).toBe('succeeded');
  expect(figma.status).toBe('partial');
});

 test('Figma never claims preserved features for omitted asset layers', async () => {
  const document = createDocument('Missing assets');
  const nodes: DesignNode[] = [
    { ...createNodeBase('image', 'Image'), kind: 'image', assetId: 'unavailable', fit: 'contain' },
    { ...createNodeBase('icon', 'Icon'), kind: 'icon', libraryId: 'unavailable', iconName: 'star' },
  ];
  for (const node of nodes) { document.nodes[node.id] = node; document.pages.page_1!.rootNodeIds.push(node.id); }
  const result = await new FigmaExporter().export(document);
  for (const node of nodes) {
    const entries = result.fidelity.filter(entry => entry.nodeId === node.id);
    expect(entries.find(entry => entry.feature === `node-kind:${node.kind}`)?.status).toBe('omitted');
    expect(entries.some(entry => entry.status === 'preserved')).toBe(false);
  }
  expect((await executeFigmaScript(buildFigmaScript(document))).length).toBe(0);
});
