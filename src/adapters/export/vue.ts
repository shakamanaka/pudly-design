import {
  resolveComponentInstance,
  validateDocument,
} from '../../domain/index';
import type {
  ComponentInstanceNode,
  DesignDocument,
  DesignExporter,
  DesignNode,
  ExportArtifact,
  ExportResult,
  FidelityEntry,
  Layout,
  SemanticStyle,
  TemplateNode,
} from '../../domain/index';

type VueRenderNode = Record<string, unknown> & {
  renderId: string;
  sourceId: string;
  kind: string;
  name: string;
  children: VueRenderNode[];
};

type VueRenderPage = { id: string; name: string; roots: VueRenderNode[] };

const packageJson = {
  name: 'pudly-export',
  private: true,
  type: 'module',
  engines: { node: '^22.12.0 || ^24.0.0 || >=26.0.0', npm: '>=10.0.0' },
  scripts: { dev: 'vite', build: 'vite build' },
  dependencies: {
    vue: '3.5.43',
  },
  devDependencies: {
    '@vitejs/plugin-vue': '6.0.9',
    vite: '8.3.2',
  },
};

const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#f4f5f7" />
    <title>Design export</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`;

const viteConfig = `import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({ plugins: [vue()] });
`;

const mainTs = `import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

createApp(App).mount('#app');
`;

const styleCss = `:root { font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #20242b; background: #f4f5f7; font-synthesis: none; text-rendering: optimizeLegibility; }
* { box-sizing: border-box; }
body { min-width: 320px; min-height: 100vh; margin: 0; }
button { color: inherit; font: inherit; }
.export-app { min-height: 100vh; }
.export-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 56px; padding: 10px 20px; border-bottom: 1px solid #dfe2e7; background: #fff; }
.export-header h1 { overflow: hidden; margin: 0; font-size: 15px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.export-header small { color: #747b86; font-size: 11px; }
.export-pages { display: flex; gap: 6px; overflow-x: auto; padding: 12px 20px 0; }
.export-pages button { border: 1px solid transparent; border-radius: 6px 6px 0 0; padding: 7px 10px; background: transparent; cursor: pointer; font-size: 12px; }
.export-pages button[aria-current="page"] { border-color: #dfe2e7; border-bottom-color: #fff; background: #fff; }
.export-canvas { min-height: calc(100vh - 98px); overflow: auto; padding: 28px; background-color: #eef0f3; background-image: radial-gradient(#c8cbd1 0.7px, transparent 0.7px); background-size: 16px 16px; }
.export-artboard { position: relative; min-height: 480px; margin: 0 auto; overflow: hidden; background: #fff; box-shadow: 0 5px 24px rgb(29 34 43 / 10%); }
.export-node { min-width: 0; max-width: 100%; }
.export-node--text { white-space: pre-wrap; }
.export-node--frame, .export-node--group, .export-node--component-instance { flex-shrink: 0; }
.export-node__image, .export-node__icon { display: grid; width: 100%; height: 100%; min-height: 32px; place-items: center; overflow: hidden; color: #667085; border: 1px dashed #aeb4bf; background: rgb(127 137 153 / 8%); font-size: 11px; text-align: center; }
.export-node__vector { display: block; width: 100%; height: 100%; overflow: visible; }
@media (max-width: 600px) { .export-canvas { padding: 12px; } .export-header { padding-inline: 12px; } }
`;

const appVue = `<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import design from './design-document.json';
import pages from './design-tree.json';
import DesignNode from './DesignNode.vue';

const pageId = ref(design.pageOrder[0] ?? '');
const viewportWidth = ref(typeof window === 'undefined' ? 1280 : window.innerWidth);
const page = computed(() => pages.find((candidate) => candidate.id === pageId.value) ?? pages[0]);
function updateViewport() { viewportWidth.value = window.innerWidth; }
onMounted(() => window.addEventListener('resize', updateViewport, { passive: true }));
onBeforeUnmount(() => window.removeEventListener('resize', updateViewport));
</script>

<template>
  <main class="export-app" :aria-label="design.name">
    <header class="export-header">
      <h1>{{ design.name }}</h1>
      <small>Revision {{ design.revision }}</small>
    </header>
    <nav v-if="pages.length > 1" class="export-pages" aria-label="Pages">
      <button
        v-for="item in pages"
        :key="item.id"
        type="button"
        :aria-current="item.id === page?.id ? 'page' : undefined"
        @click="pageId = item.id"
      >{{ item.name }}</button>
    </nav>
    <section v-if="page" class="export-canvas" :aria-label="page.name + ' canvas'">
      <div class="export-artboard" :style="{ width: Math.max(320, viewportWidth) + 'px' }">
        <DesignNode
          v-for="node in page.roots"
          :key="node.renderId"
          :node="node"
          :tokens="design.tokens"
          :viewport-width="viewportWidth"
          :parent-layout="null"
        />
      </div>
    </section>
  </main>
</template>
`;

const designNodeVue = `<script setup lang="ts">
import { computed } from 'vue';
import { nodeStyle, resolveResponsive } from './design-rendering';
import type { VueRenderNode } from './design-rendering';

const props = defineProps<{
  node: VueRenderNode;
  tokens: Record<string, unknown>;
  viewportWidth: number;
  parentLayout: VueRenderNode['layout'] | null;
}>();
const resolved = computed(() => resolveResponsive(props.node, props.tokens, props.viewportWidth));
const style = computed(() => nodeStyle(props.node, resolved.value.layout, props.parentLayout, props.tokens));
</script>

<template>
  <div
    v-if="resolved.visible"
    class="export-node"
    :class="'export-node--' + node.kind"
    :data-render-id="node.renderId"
    :aria-label="node.name"
    :style="style"
  >
    <span v-if="node.kind === 'text'">{{ node.text }}</span>
    <div
      v-else-if="node.kind === 'image'"
      class="export-node__image"
      role="img"
      :aria-label="'Image asset ' + node.assetId"
    >Image asset: {{ node.assetId }}</div>
    <div v-else-if="node.kind === 'icon'" class="export-node__icon" role="img" :aria-label="node.libraryId + ': ' + node.iconName">
      {{ node.iconName }}
    </div>
    <svg v-else-if="node.kind === 'vector'" class="export-node__vector" :viewBox="node.viewBox.join(' ')" aria-hidden="true">
      <path :d="node.pathData" fill="currentColor" />
    </svg>
    <DesignNode
      v-for="child in node.children"
      :key="child.renderId"
      :node="child"
      :tokens="tokens"
      :viewport-width="viewportWidth"
      :parent-layout="resolved.layout"
    />
  </div>
</template>
`;

const designRenderingTs = `export type ExportMeasure = { kind: 'literal'; value: number; unit: 'px' } | { kind: 'token'; tokenId: string };
export type ExportSizing = { kind: 'fixed'; value: ExportMeasure } | { kind: 'fill' | 'hug'; min?: ExportMeasure; max?: ExportMeasure };
export type ExportLayout = {
  mode: 'horizontal' | 'vertical' | 'free';
  position?: { x: number; y: number };
  width: ExportSizing;
  height: ExportSizing;
  align: 'start' | 'center' | 'end' | 'stretch';
  justify: 'start' | 'center' | 'end' | 'space-between';
  gap: ExportMeasure;
  padding: { top: ExportMeasure; right: ExportMeasure; bottom: ExportMeasure; left: ExportMeasure };
};
export type VueRenderNode = {
  instanceRoot?: boolean;
  renderId: string;
  sourceId: string;
  kind: string;
  name: string;
  visible: boolean;
  layout: ExportLayout;
  constraints: Record<string, ExportMeasure | boolean>;
  style: Record<string, unknown>;
  responsive: Array<{ breakpointTokenId: string; priority: number; overrides: { layout?: Partial<ExportLayout>; visible?: boolean } }>;
  children: VueRenderNode[];
  text?: string;
  textStyle?: { typographyTokenId?: string; fontSize?: ExportMeasure; weight?: number; lineHeight?: number; align?: string };
  assetId?: string;
  fit?: string;
  libraryId?: string;
  iconName?: string;
  pathData?: string;
  viewBox?: [number, number, number, number];
};

type StyleMap = Record<string, string | number | undefined>;
type Token = { category?: string; value?: Record<string, unknown> };
type TokenMap = Record<string, Token>;

function tokenMeasure(tokens: TokenMap, measure: ExportMeasure | undefined, category: string, fallback = 0): number {
  if (!measure) return fallback;
  if (measure.kind === 'literal') return measure.value;
  const token = tokens[measure.tokenId];
  if (token?.category !== category) return fallback;
  const value = token.value?.valuePx;
  if (typeof value === 'number') return value;
  const fontSize = token.value?.fontSizePx;
  return typeof fontSize === 'number' && category === 'typography' ? fontSize : fallback;
}

function tokenColor(tokens: TokenMap, value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object') return fallback;
  const color = value as { kind?: string; value?: string; tokenId?: string };
  if (color.kind === 'literal' && typeof color.value === 'string' && /^#[\\da-f]{6}([\\da-f]{2})?$/i.test(color.value)) {
    return hexColor(color.value);
  }
  const token = color.kind === 'token' && color.tokenId ? tokens[color.tokenId] : undefined;
  const hex = token?.category === 'color' ? token.value?.hex : undefined;
  if (typeof hex !== 'string' || !/^#[\\da-f]{6}$/i.test(hex)) return fallback;
  const alpha = token.value?.alpha;
  return typeof alpha === 'number' && alpha < 1 ? alphaColor(hex, alpha) : hex;
}

function hexColor(value: string): string {
  return value.length === 9 ? alphaColor(value.slice(0, 7), Number.parseInt(value.slice(7), 16) / 255) : value;
}

function alphaColor(hex: string, alpha: number): string {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return 'rgba(' + red + ', ' + green + ', ' + blue + ', ' + alpha + ')';
}

export function resolveResponsive(node: VueRenderNode, tokens: TokenMap, viewportWidth: number): { layout: ExportLayout; visible: boolean } {
  const rules = [...node.responsive].filter((rule) => {
    const token = tokens[rule.breakpointTokenId];
    const value = token?.category === 'breakpoint' ? token.value?.valuePx : undefined;
    return typeof value === 'number' && value <= viewportWidth;
  }).sort((a, b) => {
    const aValue = tokens[a.breakpointTokenId]?.value?.valuePx;
    const bValue = tokens[b.breakpointTokenId]?.value?.valuePx;
    return (typeof aValue === 'number' ? aValue : 0) - (typeof bValue === 'number' ? bValue : 0) || a.priority - b.priority;
  });
  let layout: ExportLayout = { ...node.layout, padding: { ...node.layout.padding } };
  let visible = node.visible;
  for (const rule of rules) {
    if (rule.overrides.layout) layout = { ...layout, ...rule.overrides.layout, padding: { ...layout.padding, ...rule.overrides.layout.padding } };
    if (rule.overrides.visible !== undefined) visible = rule.overrides.visible;
  }
  return { layout, visible };
}

function sizing(tokens: TokenMap, value: ExportSizing): { width: string; min?: string; max?: string } {
  const primary = value.kind === 'fixed' ? tokenMeasure(tokens, value.value, 'spacing') : undefined;
  const min = 'min' in value && value.min ? tokenMeasure(tokens, value.min, 'spacing') : undefined;
  const max = 'max' in value && value.max ? tokenMeasure(tokens, value.max, 'spacing') : undefined;
  return {
    width: value.kind === 'fill' ? '100%' : value.kind === 'hug' ? 'fit-content' : (primary ?? 0) + 'px',
    ...(min === undefined ? {} : { min: min + 'px' }),
    ...(max === undefined ? {} : { max: max + 'px' }),
  };
}

function constraintStyle(node: VueRenderNode, tokens: TokenMap, parentLayout: ExportLayout | null): StyleMap {
  if (parentLayout?.mode !== 'free' && parentLayout !== null) return {};
  const constraints = node.constraints;
  const horizontalEdges = ['left', 'right'].filter((key) => typeof constraints[key] === 'object');
  const verticalEdges = ['top', 'bottom'].filter((key) => typeof constraints[key] === 'object');
  const style: StyleMap = {};
  for (const key of horizontalEdges) style[key] = tokenMeasure(tokens, constraints[key] as ExportMeasure, 'spacing') + 'px';
  for (const key of verticalEdges) style[key] = tokenMeasure(tokens, constraints[key] as ExportMeasure, 'spacing') + 'px';
  const transform: string[] = [];
  if (constraints.centerX === true) { style.left = '50%'; transform.push('translateX(-50%)'); }
  if (constraints.centerY === true) { style.top = '50%'; transform.push('translateY(-50%)'); }
  if (horizontalEdges.length === 2 && constraints.centerX !== true) style.width = 'auto';
  if (verticalEdges.length === 2 && constraints.centerY !== true) style.height = 'auto';
  if (transform.length) style.transform = transform.join(' ');
  return style;
}

export function nodeStyle(node: VueRenderNode, layout: ExportLayout, parentLayout: ExportLayout | null, tokens: TokenMap): StyleMap {
  const width = sizing(tokens, layout.width);
  const height = sizing(tokens, layout.height);
  const inFreeParent = parentLayout?.mode === 'free';
  const positioned = inFreeParent || (!parentLayout && layout.position !== undefined);
  const textStyle = node.textStyle;
  const typography = textStyle?.typographyTokenId ? tokens[textStyle.typographyTokenId] : undefined;
  const typographyValue = typography?.category === 'typography' ? typography.value : undefined;
  const shadow = typeof node.style.shadowTokenId === 'string' ? tokens[node.style.shadowTokenId] : undefined;
  const shadowValue = shadow?.category === 'shadow' ? shadow.value : undefined;
  const shadowColor = shadowValue?.color ? tokenColor(tokens, shadowValue.color, 'transparent') : 'transparent';
  const style: StyleMap = {
    boxSizing: 'border-box',
    display: ['frame', 'group', 'component-instance'].includes(node.kind) && layout.mode !== 'free' ? 'flex' : 'block',
    flexDirection: layout.mode === 'horizontal' ? 'row' : 'column',
    alignItems: { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' }[layout.align],
    justifyContent: { start: 'flex-start', center: 'center', end: 'flex-end', 'space-between': 'space-between' }[layout.justify],
    gap: tokenMeasure(tokens, layout.gap, 'spacing') + 'px',
    padding: tokenMeasure(tokens, layout.padding.top, 'spacing') + 'px ' + tokenMeasure(tokens, layout.padding.right, 'spacing') + 'px ' + tokenMeasure(tokens, layout.padding.bottom, 'spacing') + 'px ' + tokenMeasure(tokens, layout.padding.left, 'spacing') + 'px',
    width: width.width,
    height: height.width,
    minWidth: width.min,
    maxWidth: width.max,
    minHeight: height.min,
    maxHeight: height.max,
    position: positioned ? 'absolute' : 'relative',
    left: positioned && layout.position ? layout.position.x + 'px' : undefined,
    top: positioned && layout.position ? layout.position.y + 'px' : undefined,
    backgroundColor: node.kind === 'vector' ? 'transparent' : tokenColor(tokens, node.style.fill, 'transparent'),
    color: node.kind === 'vector' ? tokenColor(tokens, node.style.fill ?? node.style.textColor, '#20242b') : tokenColor(tokens, node.style.textColor, '#20242b'),
    borderRadius: node.style.radius ? tokenMeasure(tokens, node.style.radius as ExportMeasure, 'radius') + 'px' : undefined,
    opacity: typeof node.style.opacity === 'number' ? node.style.opacity : undefined,
    fontFamily: typeof typographyValue?.fontFamily === 'string' ? typographyValue.fontFamily : undefined,
    fontSize: textStyle?.fontSize ? tokenMeasure(tokens, textStyle.fontSize, 'typography', 16) + 'px' : typeof typographyValue?.fontSizePx === 'number' ? typographyValue.fontSizePx + 'px' : undefined,
    fontWeight: typeof textStyle?.weight === 'number' ? textStyle.weight : typeof typographyValue?.weight === 'number' ? typographyValue.weight : undefined,
    lineHeight: typeof textStyle?.lineHeight === 'number' ? textStyle.lineHeight : typeof typographyValue?.lineHeight === 'number' ? typographyValue.lineHeight : undefined,
    letterSpacing: typeof typographyValue?.letterSpacingPx === 'number' ? typographyValue.letterSpacingPx + 'px' : undefined,
    textAlign: textStyle?.align,
    boxShadow: typeof shadowValue?.xPx === 'number' && typeof shadowValue.yPx === 'number' && typeof shadowValue.blurPx === 'number' && typeof shadowValue.spreadPx === 'number'
      ? shadowValue.xPx + 'px ' + shadowValue.yPx + 'px ' + shadowValue.blurPx + 'px ' + shadowValue.spreadPx + 'px ' + shadowColor
      : undefined,
    ...constraintStyle(node, tokens, parentLayout),
  };
  if (parentLayout?.mode === 'horizontal' && layout.width.kind === 'fill') {
    style.width = 'auto';
    style.flex = '1 1 0';
  } else if (parentLayout?.mode === 'vertical' && layout.height.kind === 'fill') {
    style.height = 'auto';
    style.flex = '1 1 0';
  }
  if (node.instanceRoot && parentLayout) {
    if (parentLayout.width.kind !== 'hug') style.width = '100%';
    if (parentLayout.height.kind !== 'hug') style.height = '100%';
    style.flex = '0 0 auto';
    style.position = 'relative';
    style.left = undefined;
    style.top = undefined;
    style.transform = undefined;
  }
  return style;
}
`;

function renderNode(document: DesignDocument, node: DesignNode, runtimeId = node.id): VueRenderNode {
  if (node.kind === 'component-instance') return renderInstance(document, node, runtimeId);
  const children = node.childIds.map((childId) => document.nodes[childId]).filter((child): child is DesignNode => child !== undefined).map((child) => renderNode(document, child));
  return { ...structuredClone(node), renderId: runtimeId, sourceId: node.id, children };
}

function renderInstance(document: DesignDocument, node: ComponentInstanceNode, runtimeId: string): VueRenderNode {
  const resolved = resolveComponentInstance(document, node);
  if (!resolved) throw new Error(`Component instance ${node.id} could not be resolved.`);
  const slotChildren = new Map<string, DesignNode[]>();
  for (const slot of Object.values(resolved.slots)) {
    const children = slotChildren.get(slot.anchorTemplateNodeId) ?? [];
    children.push(...slot.children);
    slotChildren.set(slot.anchorTemplateNodeId, children);
  }
  const active = new Set<string>();
  const renderTemplate = (templateNodeId: string): VueRenderNode => {
    if (active.has(templateNodeId)) throw new Error(`Component template cycle at ${templateNodeId}.`);
    const value = resolved.nodes[templateNodeId];
    if (!value || typeof value !== 'object') throw new Error(`Component template node ${templateNodeId} is missing.`);
    const template = value as TemplateNode;
    active.add(templateNodeId);
    const children = [
      ...template.childTemplateNodeIds.map(renderTemplate),
      ...(slotChildren.get(templateNodeId) ?? []).map((child) => renderNode(document, child)),
    ];
    active.delete(templateNodeId);
    const semantic = structuredClone(template) as unknown as Record<string, unknown>;
    delete semantic.templateNodeId;
    delete semantic.childTemplateNodeIds;
    return { ...semantic, renderId: `template:${encodeURIComponent(node.id)}:${encodeURIComponent(templateNodeId)}`, sourceId: node.id, children } as VueRenderNode;
  };
  const definition = resolved.definition;
  const root = renderTemplate(definition.rootTemplateNodeId);
  root.layout = { ...(root.layout as Layout), width: structuredClone(node.layout.width), height: structuredClone(node.layout.height) };
  root.style = { ...(root.style as SemanticStyle), ...structuredClone(node.style) };
  root.instanceRoot = true;
  const zero = { kind: 'literal' as const, value: 0, unit: 'px' as const };
  return { ...structuredClone(node), style: {}, layout: { ...structuredClone(node.layout), gap: zero, padding: { top: zero, right: zero, bottom: zero, left: zero } }, renderId: runtimeId, sourceId: node.id, children: [root] };
}

function createRenderPages(document: DesignDocument): VueRenderPage[] {
  return document.pageOrder.map((pageId) => {
    const page = document.pages[pageId]!;
    return { id: page.id, name: page.name, roots: page.rootNodeIds.map((id) => document.nodes[id]).filter((node): node is DesignNode => node !== undefined).map((node) => renderNode(document, node)) };
  });
}

function fidelityFor(document: DesignDocument): FidelityEntry[] {
  const entries: FidelityEntry[] = [
    { feature: 'semantic-document', status: 'preserved', severity: 'info' },
    { feature: 'page-order-and-names', status: 'preserved', severity: 'info' },
    { feature: 'design-tokens', status: 'preserved', severity: 'info' },
    { feature: 'document-metadata', status: 'preserved', severity: 'info' },
  ];
  const nodeEntry = (node: DesignNode, feature: string, status: FidelityEntry['status'] = 'preserved', fallback?: string) => entries.push({
    nodeId: node.id,
    feature,
    status,
    severity: status === 'preserved' ? 'info' : 'warning',
    ...(fallback ? { fallback } : {}),
  });
  for (const node of Object.values(document.nodes)) {
    const visualUnsupported = node.kind === 'image' || node.kind === 'icon';
    const fallback = node.kind === 'image'
      ? 'The document contains an asset ID but no asset bytes; the exported app shows an accessible placeholder.'
      : node.kind === 'icon'
        ? 'The document contains an icon library/name but no icon library asset; the exported app shows the icon name.'
        : undefined;
    nodeEntry(node, `node:${node.kind}`, visualUnsupported ? 'degraded' : 'preserved', fallback);
    nodeEntry(node, 'layout-and-sizing');
    nodeEntry(node, 'semantic-style-and-tokens');
    const axisConflict = (node.constraints.centerX && (node.constraints.left || node.constraints.right))
      || (node.constraints.centerY && (node.constraints.top || node.constraints.bottom));
    nodeEntry(node, 'free-layout-constraints', axisConflict ? 'degraded' : 'preserved', axisConflict ? 'Center anchors take precedence over edge anchors on the same axis.' : undefined);
    nodeEntry(node, 'responsive-overrides');
    if (node.kind === 'component-instance') {
      nodeEntry(node, 'component-definition-variant-and-overrides', 'degraded', 'The instance is rendered from its resolved definition, variant, bindings, and slots; reuse is expanded into static render nodes while the original component graph remains in design-document.json.');
    }
  }
  for (const definition of Object.values(document.components)) {
    for (const template of Object.values(definition.templateNodes)) {
      const feature = `component-template:${definition.id}:${template.templateNodeId}`;
      const unsupported = template.kind === 'image' || template.kind === 'icon';
      entries.push({
        feature: `${feature}:node:${template.kind}`,
        status: unsupported ? 'degraded' : 'preserved',
        severity: unsupported ? 'warning' : 'info',
        ...(template.kind === 'image'
          ? { fallback: 'The component template contains an asset ID but no asset bytes; the exported app shows an accessible placeholder.' }
          : template.kind === 'icon'
            ? { fallback: 'The component template contains an icon library/name but no icon library asset; the exported app shows the icon name.' }
            : {}),
      });
      entries.push({ feature: `${feature}:layout-and-sizing`, status: 'preserved', severity: 'info' });
      entries.push({ feature: `${feature}:semantic-style-and-tokens`, status: 'preserved', severity: 'info' });
      const axisConflict = (template.constraints.centerX && (template.constraints.left || template.constraints.right))
        || (template.constraints.centerY && (template.constraints.top || template.constraints.bottom));
      entries.push({
        feature: `${feature}:free-layout-constraints`,
        status: axisConflict ? 'degraded' : 'preserved',
        severity: axisConflict ? 'warning' : 'info',
        ...(axisConflict ? { fallback: 'Center anchors take precedence over edge anchors on the same axis.' } : {}),
      });
      entries.push({ feature: `${feature}:responsive-overrides`, status: 'preserved', severity: 'info' });
    }
  }
  return entries;
}

function artifacts(document: DesignDocument, pages: VueRenderPage[]): ExportArtifact[] {
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  return [
    { name: 'package.json', mimeType: 'application/json', encoding: 'utf8', contents: `${json(packageJson)}\n` },
    { name: 'index.html', mimeType: 'text/html', encoding: 'utf8', contents: indexHtml },
    { name: 'vite.config.js', mimeType: 'text/javascript', encoding: 'utf8', contents: viteConfig },
    { name: 'src/main.ts', mimeType: 'text/typescript', encoding: 'utf8', contents: mainTs },
    { name: 'src/App.vue', mimeType: 'text/x-vue', encoding: 'utf8', contents: appVue },
    { name: 'src/DesignNode.vue', mimeType: 'text/x-vue', encoding: 'utf8', contents: designNodeVue },
    { name: 'src/design-rendering.ts', mimeType: 'text/typescript', encoding: 'utf8', contents: designRenderingTs },
    { name: 'src/style.css', mimeType: 'text/css', encoding: 'utf8', contents: styleCss },
    { name: 'src/design-document.json', mimeType: 'application/json', encoding: 'utf8', contents: `${json(document)}\n` },
    { name: 'src/design-tree.json', mimeType: 'application/json', encoding: 'utf8', contents: `${json(pages)}\n` },
  ];
}

export class VueExporter implements DesignExporter {
  async export(document: DesignDocument): Promise<ExportResult> {
    const parsed = validateDocument(document);
    if (!parsed.ok) return { target: 'vue', status: 'failed', artifacts: [], fidelity: [], diagnostics: parsed.diagnostics };
    try {
      const fidelity = fidelityFor(parsed.value);
      const generated = artifacts(parsed.value, createRenderPages(parsed.value));
      const degraded = fidelity.filter((entry) => entry.status !== 'preserved');
      return {
        target: 'vue',
        status: degraded.length ? 'partial' : 'succeeded',
        artifacts: generated,
        fidelity,
        diagnostics: degraded.map((entry) => ({
          code: 'export.vue.fidelity',
          message: `${entry.feature}${entry.nodeId ? ` on node ${entry.nodeId}` : ''}: ${entry.fallback ?? 'The Vue runtime uses a documented fallback.'}`,
          severity: entry.severity,
        })),
      };
    } catch (error) {
      return {
        target: 'vue',
        status: 'failed',
        artifacts: [],
        fidelity: [],
        diagnostics: [{ code: 'export.vue.generation', message: error instanceof Error ? error.message : 'The Vue export could not be generated.', severity: 'error' }],
      };
    }
  }
}
