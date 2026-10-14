import { unzipSync, strFromU8 } from 'fflate';
import { expect, test } from 'vitest';
import { buildFigmaScript, FigmaExporter } from '../../src/adapters/export/figma';
import { createDocument, createNodeBase } from '../../src/domain';

function sampleDocument() {
  const document = createDocument('Harvest card');
  document.nodes.card = {
    ...createNodeBase('card', 'Card'), kind: 'frame', childIds: ['title', 'art'],
    layout: { ...createNodeBase('layout', 'layout').layout, mode: 'free', width: { kind: 'fixed', value: { kind: 'literal', value: 440, unit: 'px' } }, height: { kind: 'fixed', value: { kind: 'literal', value: 300, unit: 'px' } }, padding: { top: { kind: 'literal', value: 24, unit: 'px' }, right: { kind: 'literal', value: 24, unit: 'px' }, bottom: { kind: 'literal', value: 24, unit: 'px' }, left: { kind: 'literal', value: 24, unit: 'px' } } },
    style: { fill: { kind: 'token', tokenId: 'color.surface' }, radius: { kind: 'token', tokenId: 'radius.md' } },
  };
  document.nodes.title = {
    ...createNodeBase('title', 'Harvest title'), kind: 'text', text: "Harvest starts here </script>'; figma.closePlugin('injected')",
    textStyle: { typographyTokenId: 'typography.title' }, style: { textColor: { kind: 'token', tokenId: 'color.text' } },
    layout: { ...createNodeBase('layout', 'layout').layout, position: { x: 20, y: 20 } },
  };
  document.nodes.art = {
    ...createNodeBase('art', 'Leaf mark'), kind: 'vector', pathData: 'M0 0 L12 12 Z', viewBox: [0, 0, 12, 12],
    layout: { ...createNodeBase('layout', 'layout').layout, position: { x: 20, y: 80 }, width: { kind: 'fixed', value: { kind: 'literal', value: 12, unit: 'px' } }, height: { kind: 'fixed', value: { kind: 'literal', value: 12, unit: 'px' } } },
  };
  document.pages.page_1!.rootNodeIds.push('card');
  return document;
}

class MockFigmaNode {
  readonly children: MockFigmaNode[] = [];
  parent: MockFigmaNode | null = null;
  name = '';
  x = 0;
  y = 0;
  width = 100;
  height = 100;
  layoutMode = 'NONE';
  characters = '';
  fontSize = 16;
  fontName: { family: string; style: string } = { family: 'Inter', style: 'Regular' };
  lineHeight: { unit: string; value: number } = { unit: 'PIXELS', value: 19.2 };
  fills: unknown[] = [];
  [key: string]: unknown;

  constructor(readonly id: string, readonly type: string) {}
  appendChild(child: MockFigmaNode) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = this;
    this.children.push(child);
  }
  findAll(predicate: (node: MockFigmaNode) => boolean): MockFigmaNode[] {
    return this.children.flatMap((child) => [ ...(predicate(child) ? [child] : []), ...child.findAll(predicate) ]);
  }
  resize(width: number, height: number) { this.width = width; this.height = height; }
  get absoluteTransform(): [[number, number, number], [number, number, number]] {
    const parent = this.parent?.absoluteTransform;
    return [[1, 0, (parent?.[0][2] ?? 0) + this.x], [0, 1, (parent?.[1][2] ?? 0) + this.y]];
  }
}

function mockFigma() {
  let nextId = 0;
  const page = new MockFigmaNode('figma-page', 'PAGE');
  const make = (type: string) => {
    const node = new MockFigmaNode(`target-${++nextId}`, type);
    page.appendChild(node);
    return node;
  };
  let closed = false;
  const api = {
    currentPage: page,
    listAvailableFontsAsync: async () => [{ fontName: { family: 'Inter', style: 'Regular' } }, { fontName: { family: 'Inter', style: 'Bold' } }],
    getNodeByIdAsync: async (id: string) => id === page.id ? page : null,
    setCurrentPageAsync: async (target: MockFigmaNode) => { api.currentPage = target; },
    createFrame: () => make('FRAME'),
    createAutoLayout: (direction: string) => { const frame = make('FRAME'); frame.layoutMode = direction; return frame; },
    createText: () => make('TEXT'),
    createNodeFromSvg: () => { const svg = make('FRAME'); svg.appendChild(new MockFigmaNode(`target-${++nextId}`, 'VECTOR')); return svg; },
    loadFontAsync: async () => undefined,
    closePlugin: () => { closed = true; },
  };
  return { api, page, wasClosed: () => closed };
}

test('Figma script maps a validated semantic page directly and returns IDs, mapping, counts, bounds, and fonts', () => {
  const document = sampleDocument();
  const script = buildFigmaScript(document, undefined, 1280, 'page_1');

  expect(script).toContain('await figma.getNodeByIdAsync(__pageId)');
  expect(script).toContain('await figma.setCurrentPageAsync(__targetPage)');
  expect(script).toContain('const __sourcePageId = "page_1"');
  expect(script).toContain("await figma.listAvailableFontsAsync()");
  expect(script.indexOf('await figma.loadFontAsync(spec.font)')).toBeLessThan(script.indexOf('target.characters = source.text'));
  expect(script).toContain('createdNodeIds');
  expect(script).toContain('sourceMappings');
  expect(script).toContain('counts: { nodes:');
  expect(script).toContain('bounds: __bounds');
  expect(script).toContain('fonts: __fontReport');
  expect(script).not.toContain("figma.closePlugin('Created");
  expect(script).not.toContain('(async () =>');
  expect(script).toContain('1280');
  expect(script).toContain('"sourceId":"title"');
  expect(script).toContain('\\u003c/script>');
  expect(() => new Function('figma', `return (async () => { ${script} })`)).not.toThrow();
});

test('executing the generated script preserves text line-height ratios and returns concrete target IDs and geometry', async () => {
  const document = sampleDocument();
  const script = buildFigmaScript(document, undefined, 1280, 'page_1');
  const { api, page, wasClosed } = mockFigma();
  const execute = new Function('figma', `return (async () => { ${script} })()`) as (figma: ReturnType<typeof mockFigma>['api']) => Promise<{ createdNodeIds: string[]; sourceMappings: Array<{ sourceId: string; targetId: string; kind: string }>; counts: { nodes: number; text: number }; bounds: Array<{ x: number; y: number; width: number; height: number }> }>;
  const result = await execute(api);
  const title = page.findAll((node) => node.type === 'TEXT').find((node) => node.name === 'Harvest title');
  expect(title?.characters).toBe(document.nodes.title?.kind === 'text' ? document.nodes.title.text : '');
  expect(title?.fontSize).toBe(24);
  expect(title?.lineHeight).toEqual({ unit: 'PIXELS', value: 30 });
  expect(result.counts).toEqual({ nodes: 4, text: 1, roots: 1 });
  expect(result.createdNodeIds).toHaveLength(4);
  expect(result.sourceMappings.some((mapping) => mapping.sourceId === 'art#geometry:target-4' && mapping.kind === 'vector-geometry')).toBe(true);
  expect(result.bounds[0]).toMatchObject({ x: 1400, y: 120, width: 440, height: 300 });
  expect(wasClosed()).toBe(false);
});

test('Figma exporter creates a partial developer-plugin bundle with explicit setup and unsupported semantics', async () => {
  const document = sampleDocument();
  const result = await new FigmaExporter().export(document);
  expect(result.target).toBe('figma');
  expect(result.status).toBe('partial');
  expect(result.diagnostics.some((item) => item.code === 'export.figma.live-write-unverified')).toBe(true);
  expect(result.diagnostics.some((item) => item.code === 'export.figma.plugin-id-required')).toBe(true);
  expect(result.artifacts).toHaveLength(1);
  expect(result.artifacts[0]?.mimeType).toBe('application/zip');

  const archive = unzipSync(Buffer.from(result.artifacts[0]!.contents, 'base64'));
  const manifest = JSON.parse(strFromU8(archive['manifest.json']!)) as { main: string; editorType: string[] };
  expect(manifest.main).toBe('code.js');
  expect(manifest.editorType).toEqual(['figma']);
  const code = strFromU8(archive['code.js']!);
  expect(code).toContain('figma.closePlugin');
  expect(code).toContain('async () =>');
  expect(() => new Function(code)).not.toThrow();
  expect(JSON.parse(strFromU8(archive['design-document.json']!))).toEqual(document);
  const fidelity = JSON.parse(strFromU8(archive['fidelity-report.json']!)) as { status: string; fidelity: Array<{ feature: string; status: string }> };
  expect(fidelity.status).toBe('partial');
  expect(fidelity.fidelity.some((entry) => entry.feature === 'node-kind:frame' && entry.status === 'preserved')).toBe(true);
  expect(fidelity.fidelity.some((entry) => entry.feature === 'node-kind:vector' && entry.status === 'degraded')).toBe(true);
  expect(fidelity.fidelity.some((entry) => entry.feature.startsWith('token:') && entry.status === 'degraded')).toBe(true);
  expect(fidelity.fidelity.some((entry) => entry.feature === 'responsive-rules' && entry.status === 'omitted')).toBe(false);
});

test('Figma exporter reports each encountered loss and fails closed for invalid schema', async () => {
  const document = sampleDocument();
  document.nodes.title!.responsive = [{ id: 'compact', breakpointTokenId: 'breakpoint.tablet', priority: 0, overrides: { visible: false } }];
  document.nodes.art!.constraints = { left: { kind: 'literal', value: 8, unit: 'px' } };
  const result = await new FigmaExporter().export(document);
  expect(result.fidelity.some((entry) => entry.nodeId === 'title' && entry.feature === 'responsive-rules' && entry.status === 'degraded')).toBe(true);
  expect(result.fidelity.some((entry) => entry.nodeId === 'art' && entry.feature === 'constraints' && entry.status === 'omitted')).toBe(true);
  expect(result.fidelity.some((entry) => entry.feature === 'token:motion.fast:motion' && entry.status === 'omitted')).toBe(true);

  document.schemaVersion = 999;
  const invalid = await new FigmaExporter().export(document);
  expect(invalid.status).toBe('failed');
  expect(invalid.artifacts).toEqual([]);
});

test('component mapping uses instance bounds and overrides on the template root without an extra wrapper', () => {
  const document = createDocument('Component bounds');
  document.nodes.instance = {
    ...createNodeBase('instance', 'Compact action'), kind: 'component-instance', componentId: 'button', variantId: 'primary',
    propertyOverrides: { label: 'Continue' }, nodeOverrides: {}, slotChildren: {},
    layout: {
      ...createNodeBase('layout', 'layout').layout,
      position: { x: 40, y: 24 },
      width: { kind: 'fixed', value: { kind: 'literal', value: 240, unit: 'px' } },
      height: { kind: 'fixed', value: { kind: 'literal', value: 56, unit: 'px' } },
    },
    style: { fill: { kind: 'literal', value: '#008844' } },
  };
  document.pages.page_1!.rootNodeIds.push('instance');
  const script = buildFigmaScript(document);
  const payloadText = /^const __doc = (.*);$/m.exec(script)?.[1];
  expect(payloadText).toBeDefined();
  const payload = JSON.parse(payloadText!) as { renderTrees: Record<string, Array<{ sourceId: string; kind: string; layout: { width: unknown; height: unknown; padding: Record<string, unknown> }; style: { fill?: unknown }; children: Array<{ sourceId: string; text?: string }> }>> };
  const [root] = payload.renderTrees.page_1!;
  expect(root?.sourceId).toBe('instance');
  expect(root?.kind).toBe('frame');
  expect(root?.layout.width).toEqual({ kind: 'fixed', value: { kind: 'literal', value: 240, unit: 'px' } });
  expect(root?.layout.height).toEqual({ kind: 'fixed', value: { kind: 'literal', value: 56, unit: 'px' } });
  expect(root?.layout.padding).toEqual(document.components.button!.templateNodes['button-root']!.layout.padding);
  expect(root?.style.fill).toEqual({ kind: 'literal', value: '#008844' });
  expect(root?.children).toHaveLength(1);
  expect(root?.children[0]?.sourceId).toBe('instance::button-label');
  expect(root?.children[0]?.text).toBe('Continue');
});
