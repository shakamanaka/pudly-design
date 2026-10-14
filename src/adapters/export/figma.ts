import { resolveComponentInstance, resolveResponsiveLayout, validateDocument } from '../../domain/index';
import type {
  ComponentInstanceNode,
  DesignDocument,
  DesignExporter,
  DesignNode,
  ExportResult,
  FidelityEntry,
  TemplateNode,
} from '../../domain/index';
import { BundledExporter } from './bundle';

type RenderNode = {
  sourceId: string;
  sourceNodeId: string;
  name: string;
  kind: string;
  visible: boolean;
  layout: DesignNode['layout'] | TemplateNode['layout'];
  constraints: DesignNode['constraints'] | TemplateNode['constraints'];
  style: DesignNode['style'] | TemplateNode['style'];
  responsive: DesignNode['responsive'] | TemplateNode['responsive'];
  text?: string;
  textStyle?: Extract<DesignNode, { kind: 'text' }>['textStyle'];
  pathData?: string;
  viewBox?: [number, number, number, number];
  assetId?: string;
  fit?: string;
  libraryId?: string;
  iconName?: string;
  children: RenderNode[];
};

function resolveTemplateResponsive(document: DesignDocument, node: TemplateNode, viewportWidth: number): { layout: TemplateNode['layout']; visible: boolean } {
  let layout = structuredClone(node.layout);
  let visible = node.visible;
  const rules = [...node.responsive].filter((rule) => {
    const token = document.tokens[rule.breakpointTokenId];
    return token?.category === 'breakpoint' && token.value.valuePx <= viewportWidth;
  }).sort((a, b) => {
    const aw = document.tokens[a.breakpointTokenId];
    const bw = document.tokens[b.breakpointTokenId];
    const widthDelta = (aw?.category === 'breakpoint' ? aw.value.valuePx : 0) - (bw?.category === 'breakpoint' ? bw.value.valuePx : 0);
    return widthDelta || a.priority - b.priority;
  });
  for (const rule of rules) {
    if (rule.overrides.layout) layout = { ...layout, ...rule.overrides.layout, padding: { ...layout.padding, ...rule.overrides.layout.padding } };
    if (rule.overrides.visible !== undefined) visible = rule.overrides.visible;
  }
  return { layout, visible };
}

function renderNode(document: DesignDocument, node: DesignNode, viewportWidth: number, ancestors = new Set<string>()): RenderNode {
  if (ancestors.has(node.id)) throw new Error(`Circular render reference at ${node.id}.`);
  const next = new Set(ancestors).add(node.id);
  if (node.kind !== 'component-instance') {
    const responsive = resolveResponsiveLayout(document, node, viewportWidth);
    const common = {
      sourceId: node.id,
      sourceNodeId: node.id,
      name: node.name,
      kind: node.kind,
      visible: responsive.visible,
      layout: responsive.layout,
      constraints: node.constraints,
      style: node.style,
      responsive: node.responsive,
      children: node.childIds.map((id) => {
        const child = document.nodes[id];
        if (!child) throw new Error(`Missing child ${id}.`);
        return renderNode(document, child, viewportWidth, next);
      }),
    };
    if (node.kind === 'text') return { ...common, text: node.text, textStyle: node.textStyle };
    if (node.kind === 'vector') return { ...common, pathData: node.pathData, viewBox: node.viewBox };
    if (node.kind === 'image') return { ...common, assetId: node.assetId, fit: node.fit };
    if (node.kind === 'icon') return { ...common, libraryId: node.libraryId, iconName: node.iconName };
    return common;
  }
  return renderComponent(document, node, viewportWidth, next);
}

function renderComponent(document: DesignDocument, instance: ComponentInstanceNode, viewportWidth: number, ancestors: Set<string>): RenderNode {
  const resolved = resolveComponentInstance(document, instance);
  if (!resolved) throw new Error(`Component ${instance.componentId}/${instance.variantId} could not be resolved.`);
  const slotsAt = new Map<string, RenderNode[]>();
  for (const slot of Object.values(resolved.slots)) {
    const children = slot.children.map((child) => renderNode(document, child, viewportWidth, ancestors));
    slotsAt.set(slot.anchorTemplateNodeId, [...(slotsAt.get(slot.anchorTemplateNodeId) ?? []), ...children]);
  }
  const buildTemplate = (templateId: string, seen = new Set<string>()): RenderNode => {
    if (seen.has(templateId)) throw new Error(`Circular component template reference at ${templateId}.`);
    const template = resolved.nodes[templateId] as TemplateNode | undefined;
    if (!template) throw new Error(`Missing component template node ${templateId}.`);
    const next = new Set(seen).add(templateId);
    const responsive = resolveTemplateResponsive(document, template, viewportWidth);
    const sourceId = `${instance.id}::${templateId}`;
    const common = {
      sourceId,
      sourceNodeId: instance.id,
      name: template.name,
      kind: template.kind,
      visible: responsive.visible,
      layout: responsive.layout,
      constraints: template.constraints,
      style: template.style,
      responsive: template.responsive,
      children: [...template.childTemplateNodeIds.map((id) => buildTemplate(id, next)), ...(slotsAt.get(templateId) ?? [])],
    };
    return template.kind === 'text'
      ? { ...common, text: template.text, textStyle: template.textStyle }
      : template.kind === 'vector'
        ? { ...common, pathData: template.pathData, viewBox: template.viewBox }
        : template.kind === 'image'
          ? { ...common, assetId: template.assetId, fit: template.fit }
          : template.kind === 'icon'
            ? { ...common, libraryId: template.libraryId, iconName: template.iconName }
            : common;
  };
  const root = buildTemplate(resolved.definition.rootTemplateNodeId);
  const instanceResponsive = resolveResponsiveLayout(document, instance, viewportWidth);
  return {
    ...root,
    sourceId: instance.id,
    sourceNodeId: instance.id,
    name: instance.name,
    constraints: instance.constraints,
    style: { ...root.style, ...instance.style },
    visible: root.visible && instanceResponsive.visible,
    layout: { ...root.layout, width: instanceResponsive.layout.width, height: instanceResponsive.layout.height, ...(instanceResponsive.layout.position ? { position: instanceResponsive.layout.position } : {}) },
  };
}

function fidelityFor(document: DesignDocument): FidelityEntry[] {
  const entries: FidelityEntry[] = [];
  const add = (feature: string, status: FidelityEntry['status'], severity: FidelityEntry['severity'], nodeId?: string, fallback?: string) => {
    entries.push({ ...(nodeId ? { nodeId } : {}), feature, status, severity, ...(fallback ? { fallback } : {}) });
  };
  const selectedPageId = document.pageOrder[0];
  if (selectedPageId) add(`page:${selectedPageId}:name`, 'degraded', 'info', undefined, 'The semantic page label remains in source JSON; the script writes to the selected Figma page without renaming it.');
  for (const pageId of document.pageOrder.slice(1)) {
    add(`page:${pageId}`, 'omitted', 'warning', undefined, 'Figma writes one page per script call; this page is not included in this archive run.');
  }
  const mappedNodeIds = new Set<string>();
  const collectMapped = (id: string): void => {
    if (mappedNodeIds.has(id)) return;
    mappedNodeIds.add(id);
    const node = document.nodes[id];
    if (!node) return;
    node.childIds.forEach(collectMapped);
    if (node.kind === 'component-instance') Object.values(node.slotChildren).flat().forEach(collectMapped);
  };
  if (selectedPageId) document.pages[selectedPageId]?.rootNodeIds.forEach(collectMapped);
  const parentForNode = (nodeId: string): DesignNode | undefined => Object.values(document.nodes).find((candidate) =>
    candidate.childIds.includes(nodeId) || (candidate.kind === 'component-instance' && Object.values(candidate.slotChildren).some((ids) => ids.includes(nodeId))));
  for (const node of Object.values(document.nodes)) {
    if (!mappedNodeIds.has(node.id)) {
      add('node-source-page', 'omitted', 'warning', node.id, 'This node belongs to a semantic page other than the one imported by this script call; it remains in design-document.json.');
      continue;
    }
    if (node.kind === 'image' || node.kind === 'icon') {
      add(`node-kind:${node.kind}`, 'omitted', 'warning', node.id, 'The target layer is omitted because asset data is not bundled; geometry and styling remain in native JSON.');
      add(node.kind === 'image' ? 'image-asset' : 'icon-library-asset', 'omitted', 'warning', node.id, 'Asset data is not bundled and no target layer is created.');
      continue;
    }
    const definition = node.kind === 'component-instance' ? document.components[node.componentId] : undefined;
    const targetKind = definition?.templateNodes[definition.rootTemplateNodeId]?.kind ?? node.kind;
    const addNode: typeof add = (feature, status, severity, nodeId, fallback) => add(feature, node.kind === 'component-instance' && status === 'preserved' ? 'degraded' : status, node.kind === 'component-instance' && status === 'preserved' ? 'warning' : severity, nodeId, node.kind === 'component-instance' && status === 'preserved' ? 'Instance placement and style are composed with a resolved template root; reusable instance semantics and original template relationships are flattened into ordinary layers.' : fallback);
      if (node.kind === 'component-instance') {
        addNode('component-instance', 'degraded', 'warning', node.id, 'Resolved the selected component variant, property bindings, node overrides, and anchored slot children into ordinary target layers; reusable component editing is not preserved.');
        addNode('component-definition-reference', 'degraded', 'warning', node.id, 'Original component definition remains embedded in native source JSON but is not created as a Figma component.');
      } else {
        addNode(`node-kind:${node.kind}`, node.kind === 'group' || node.kind === 'vector' ? 'degraded' : 'preserved', node.kind === 'group' || node.kind === 'vector' ? 'warning' : 'info', node.id,
          node.kind === 'group' ? 'Represented as a Figma frame; native group semantics are not preserved.' : node.kind === 'vector' ? 'SVG path is imported as target vector geometry within a wrapper frame.' : undefined);
      }
      const autoLayout = (node.kind === 'frame' || node.kind === 'group') && node.layout.mode !== 'free';
      addNode(`layout-mode:${node.layout.mode}`, node.kind === 'text' || node.kind === 'vector' ? 'omitted' : 'preserved', node.kind === 'text' || node.kind === 'vector' ? 'warning' : 'info', node.id, node.kind === 'text' || node.kind === 'vector' ? 'Target text/vector layers do not apply container layout mode.' : undefined);
      addNode('name', 'preserved', 'info', node.id);
      addNode('visible', 'preserved', 'info', node.id);
      if (node.layout.position) addNode('layout-position', 'preserved', 'info', node.id);
      for (const axis of ['width', 'height'] as const) {
        const sizing = node.layout[axis];
        const parent = parentForNode(node.id);
        const unsupportedFill = sizing.kind === 'fill' && (!parent || parent.layout.mode === 'free');
        const bounded = sizing.kind !== 'fixed' && (sizing.min !== undefined || sizing.max !== undefined);
        const clamped = sizing.kind === 'fixed' && sizing.value.kind === 'literal' && sizing.value.value < 1;
        const textSizing = node.kind === 'text';
        const degraded = unsupportedFill || bounded || clamped || textSizing;
        addNode(`layout-${axis}:${sizing.kind}`, degraded ? 'degraded' : 'preserved', degraded ? 'warning' : 'info', node.id,
          textSizing ? 'Text sizing uses Figma HEIGHT auto-resize plus explicit width; fixed/hug bounds do not retain the full source sizing semantics.' : clamped ? 'Figma dimensions are clamped to at least 1px.' : unsupportedFill ? 'FILL requires an auto-layout parent; emitted the target default 100px dimension.' : bounded ? 'Minimum/maximum sizing bounds are retained in source JSON but are not applied.' : undefined);
      }
      addNode('layout-spacing-alignment', autoLayout ? 'preserved' : node.kind === 'component-instance' ? 'degraded' : 'omitted', autoLayout ? 'info' : 'warning', node.id, autoLayout ? undefined : node.kind === 'component-instance' ? 'Template root layout controls internal spacing/alignment rather than instance container layout.' : 'Gap, padding and alignment are not applied without target auto-layout.');
      if (node.style.fill) addNode('style-fill', targetKind === 'text' ? 'omitted' : 'preserved', targetKind === 'text' ? 'warning' : 'info', node.id, targetKind === 'text' ? 'Text-layer fills color glyphs rather than a background and may be replaced by textColor; semantic background fill is not retained.' : undefined);
      if (node.style.textColor) addNode('style-text-color', targetKind === 'text' ? 'preserved' : 'omitted', targetKind === 'text' ? 'info' : 'warning', node.id, targetKind === 'text' ? undefined : 'Text color is applied only to target text layers; a frame/vector template root has no mapped text-color field.');
      if (node.style.opacity !== undefined) addNode('style-opacity', 'preserved', 'info', node.id);
      if (node.style.radius) addNode('style-radius', targetKind === 'text' ? 'omitted' : targetKind === 'vector' ? 'degraded' : 'preserved', targetKind === 'text' || targetKind === 'vector' ? 'warning' : 'info', node.id, targetKind === 'text' ? 'Text layers do not map corner radius.' : targetKind === 'vector' ? 'Radius applies to the SVG wrapper frame rather than native vector geometry.' : undefined);
      if (Object.keys(node.constraints).length) addNode('constraints', 'omitted', 'warning', node.id, 'Constraint anchoring is not emitted; only explicit positions and dimensions are applied.');
      if (node.responsive.length) addNode('responsive-rules', 'degraded', 'warning', node.id, 'Applied the active rules at the selected viewport; Figma layers do not retain breakpoint switching.');
      if (node.style.shadowTokenId) addNode('shadow-token', 'omitted', 'warning', node.id, 'Shadow token is retained in native JSON but no target effect is generated.');
      if (node.kind === 'text') {
        addNode('text-content', 'preserved', 'info', node.id);
        addNode('text-typography', 'degraded', 'warning', node.id, 'Font family and weight use installed Figma font names and may fall back to an available style; the token identity is retained only in source JSON.');
      }
  }
  for (const token of Object.values(document.tokens)) {
    const status = token.category === 'motion' || token.category === 'z-index' || token.category === 'shadow' ? 'omitted' : 'degraded';
    add(`token:${token.id}:${token.category}`, status, status === 'omitted' ? 'warning' : 'info', undefined,
      status === 'omitted' ? 'Token values are preserved in design-document.json but are not represented as Figma variables/styles by this exporter.' : 'Token value is resolved to a static property; token identity and live binding are not preserved.');
  }
  for (const component of Object.values(document.components)) {
    const templateParents = new Map<string, TemplateNode>();
    for (const parent of Object.values(component.templateNodes)) {
      for (const childId of parent.childTemplateNodeIds) templateParents.set(childId, parent);
    }
    const used = Object.values(document.nodes).some(node => mappedNodeIds.has(node.id) && node.kind === 'component-instance' && node.componentId === component.id);
    const definitionFallback = 'Definition fields are resolved per instance into ordinary layers; reusable definitions, property bindings and original field identity are retained only in native source JSON.';
    const unusedFallback = 'No instance of this definition is rendered on the exported page; template layers are absent from the Figma target and remain only in native source JSON.';
    add(`component-definition:${component.id}`, used ? 'degraded' : 'omitted', 'warning', undefined, used ? definitionFallback : unusedFallback);
    const addTemplate: typeof add = (feature, status, severity, nodeId, fallback) => add(feature, !used ? 'omitted' : status === 'preserved' ? 'degraded' : status, !used || status === 'preserved' ? 'warning' : severity, nodeId, !used ? unusedFallback : status === 'preserved' ? definitionFallback : fallback);
    for (const template of Object.values(component.templateNodes)) {
      const prefix = `component:${component.id}:template:${template.templateNodeId}`;
      if (template.kind === 'image' || template.kind === 'icon') {
        addTemplate(`${prefix}:node-kind:${template.kind}`, 'omitted', 'warning', undefined, 'The template layer is omitted because asset data is not bundled.');
        addTemplate(`${prefix}:${template.kind === 'image' ? 'image-asset' : 'icon-library-asset'}`, 'omitted', 'warning', undefined, 'Asset data is not bundled and no target layer is created.');
        continue;
      }

      addTemplate(`${prefix}:name`, 'preserved', 'info');
      addTemplate(`${prefix}:visible`, 'preserved', 'info');
      addTemplate(`${prefix}:identity-and-child-order`, 'degraded', 'warning', undefined, definitionFallback);
      if (template.layout.position) addTemplate(`${prefix}:layout-position`, 'degraded', 'warning', undefined, template.templateNodeId === component.rootTemplateNodeId ? 'Template root placement follows the instance projection; definition identity is flattened.' : 'Child coordinates apply relative to a free-layout parent; reusable definition identity is flattened into ordinary instance layers.');
      addTemplate(`${prefix}:node-kind:${template.kind}`, template.kind === 'group' || template.kind === 'vector' ? 'degraded' : 'preserved', template.kind === 'group' || template.kind === 'vector' ? 'warning' : 'info', undefined,
        template.kind === 'group' ? 'Represented as a Figma frame; native group semantics are not preserved.' : template.kind === 'vector' ? 'Imported as SVG geometry inside a Figma wrapper frame.' : undefined);
      const autoLayout = (template.kind === 'frame' || template.kind === 'group') && template.layout.mode !== 'free';
      addTemplate(`${prefix}:layout-mode:${template.layout.mode}`, template.kind === 'frame' || template.kind === 'group' ? 'preserved' : 'omitted', template.kind === 'frame' || template.kind === 'group' ? 'info' : 'warning', undefined, template.kind === 'frame' || template.kind === 'group' ? undefined : 'The target text/vector layer does not apply container auto-layout mode.');
      const parent = templateParents.get(template.templateNodeId);
      for (const axis of ['width', 'height'] as const) {
        const sizing = template.layout[axis];
        const isRoot = template.templateNodeId === component.rootTemplateNodeId;
        const unsupportedFill = sizing.kind === 'fill' && (!parent || parent.layout.mode === 'free');
        const unsupportedHug = sizing.kind === 'hug' && ((isRoot && template.kind === 'text') || (isRoot && template.layout.mode === 'free') || parent?.layout.mode === 'free');
        const bounded = sizing.kind !== 'fixed' && (sizing.min !== undefined || sizing.max !== undefined);
        const clamped = sizing.kind === 'fixed' && sizing.value.kind === 'literal' && sizing.value.value < 1;
        const degraded = unsupportedFill || unsupportedHug || bounded || clamped;
        const fallback = unsupportedFill ? 'No auto-layout parent can apply FILL; the target uses its 100px default dimension.'
          : unsupportedHug ? 'HUG is not applied to this template root by the importer; the target uses its content/default dimension.'
            : bounded ? 'Minimum/maximum sizing bounds remain in source JSON and are not applied.'
              : clamped ? 'Figma dimensions are clamped to at least 1px.' : undefined;
        addTemplate(`${prefix}:layout-${axis}:${sizing.kind}`, degraded ? 'degraded' : 'preserved', degraded ? 'warning' : 'info', undefined, fallback);
      }
      addTemplate(`${prefix}:layout-alignment`, autoLayout ? 'preserved' : 'omitted', autoLayout ? 'info' : 'warning', undefined, autoLayout ? undefined : 'Container alignment is not applied without target auto-layout.');
      const paddingSides = ['top', 'right', 'bottom', 'left'] as const;
      const configuredSpacing = template.layout.gap.kind !== 'literal' || template.layout.gap.value !== 0
        || paddingSides.some((side) => template.layout.padding[side].kind !== 'literal' || template.layout.padding[side].value !== 0);
      const hasSpacing = template.layout.mode !== 'free' || configuredSpacing;
      if (hasSpacing) addTemplate(`${prefix}:layout-spacing-padding`, autoLayout ? 'preserved' : 'omitted', autoLayout ? 'info' : 'warning', undefined,
        autoLayout ? undefined : 'The target layer does not apply auto-layout gap or padding; values remain in source JSON.');
      if (template.style.fill) addTemplate(`${prefix}:style-fill`, template.kind === 'text' ? 'omitted' : 'preserved', template.kind === 'text' ? 'warning' : 'info', undefined, template.kind === 'text' ? 'Text-layer fills color glyphs rather than a background and may be replaced by textColor; semantic background fill is not retained.' : undefined);
      if (template.style.textColor) addTemplate(`${prefix}:style-text-color`, template.kind === 'text' ? 'preserved' : 'omitted', template.kind === 'text' ? 'info' : 'warning', undefined,
        template.kind === 'text' ? undefined : 'The importer applies textColor only to text layers; this template layer has no text fill mapping.');
      if (template.style.opacity !== undefined) addTemplate(`${prefix}:style-opacity`, 'preserved', 'info');
      if (template.style.radius) addTemplate(`${prefix}:style-radius`, template.kind === 'frame' || template.kind === 'group' ? 'preserved' : template.kind === 'vector' ? 'degraded' : 'omitted', template.kind === 'frame' || template.kind === 'group' ? 'info' : 'warning', undefined,
        template.kind === 'frame' || template.kind === 'group' ? undefined : template.kind === 'vector' ? 'Radius applies to the SVG wrapper frame rather than native vector geometry.' : 'The target node type does not expose cornerRadius in the importer.');
      if (Object.keys(template.constraints).length) addTemplate(`${prefix}:constraints`, 'omitted', 'warning', undefined, 'Template anchoring constraints are retained in source JSON but not emitted as Figma constraints.');
      if (template.responsive.length) addTemplate(`${prefix}:responsive`, 'degraded', 'warning', undefined, 'Template breakpoint rules are flattened to one export viewport.');
      if (template.style.shadowTokenId) addTemplate(`${prefix}:shadow`, 'omitted', 'warning', undefined, 'Template shadow is retained in source JSON but not emitted as a Figma effect.');
      if (template.kind === 'text') {
        addTemplate(`${prefix}:text-content`, 'preserved', 'info');
        addTemplate(`${prefix}:text-alignment`, template.textStyle.align ? 'preserved' : 'degraded', template.textStyle.align ? 'info' : 'warning', undefined,
          template.textStyle.align ? undefined : 'The importer leaves Figma text alignment at its default (LEFT).');
        addTemplate(`${prefix}:typography`, 'degraded', 'warning', undefined, 'Font family and weight use installed Figma font names and may fall back; the token identity remains only in source JSON.');
      }
      if (template.kind === 'vector') addTemplate(`${prefix}:vector-geometry`, 'degraded', 'warning', undefined, 'Path geometry is imported from SVG inside a wrapper frame; original vector node semantics are not preserved.');
    }
  }
  add('document-name', 'degraded', 'info', undefined, 'Document name is retained in design-document.json; the importer does not rename the Figma file.');
  add('viewport', 'degraded', 'info', undefined, 'Viewport width is used to select the static page placement; breakpoint behavior is not retained.');
  return entries;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const scriptRuntime = `const __doc = __PAYLOAD__;
const __pageId = __PAGE_ID__;
const __sourcePageId = __SOURCE_PAGE_ID__;
const __viewportWidth = __VIEWPORT__;
const __nodes = Object.create(null);
const __sourceMappings = [];
const __fontReport = [];
const __warnings = [];
const __availableFonts = await figma.listAvailableFontsAsync();
const __fontNames = new Set(__availableFonts.map((entry) => entry.fontName.family + '\\u0000' + entry.fontName.style));
const __measure = (value, fallback = 0) => {
  if (!value) return fallback;
  if (value.kind === 'literal') return value.value;
  const token = __doc.tokens[value.tokenId];
  if (token && token.category === 'typography') return token.value.fontSizePx;
  return token && token.value && typeof token.value.valuePx === 'number' ? token.value.valuePx : fallback;
};
const __color = (value) => {
  if (!value) return null;
  let hex = value.value;
  let alpha = 1;
  if (value.kind === 'token') {
    const token = __doc.tokens[value.tokenId];
    if (!token || token.category !== 'color') return null;
    hex = token.value.hex;
    alpha = token.value.alpha === undefined ? 1 : token.value.alpha;
  }
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) return null;
  if (hex.length === 9) { alpha *= parseInt(hex.slice(7, 9), 16) / 255; hex = hex.slice(0, 7); }
  return { color: { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 }, opacity: alpha };
};
const __sizing = (node, axis) => {
  const sizing = node.layout[axis];
  return sizing && sizing.kind ? sizing : { kind: 'hug' };
};
const __fontSpec = (node) => {
  const token = node.textStyle && node.textStyle.typographyTokenId ? __doc.tokens[node.textStyle.typographyTokenId] : null;
  const family = token && token.category === 'typography' ? token.value.fontFamily.split(',')[0].trim().replace(/^['"]|['"]$/g, '') : 'Inter';
  const weight = node.textStyle && node.textStyle.weight ? node.textStyle.weight : token && token.category === 'typography' ? token.value.weight : 400;
  const styles = [{ max: 450, name: 'Regular' }, { max: 550, name: 'Medium' }, { max: 650, name: 'Semi Bold' }, { max: 750, name: 'Bold' }, { max: 850, name: 'Extra Bold' }, { max: 1000, name: 'Black' }];
  const preferred = styles.find((style) => weight <= style.max).name;
  const exact = [preferred, 'Regular'].find((style) => __fontNames.has(family + '\\u0000' + style));
  if (!exact) {
    const found = __availableFonts.find((entry) => entry.fontName.family === family);
    if (!found) {
      const safeFallback = __availableFonts.find((entry) => entry.fontName.family === 'Inter' && entry.fontName.style === 'Regular') || __availableFonts[0];
      if (!safeFallback) throw new Error('Figma reports no available fonts; text nodes cannot be generated.');
      return { font: safeFallback.fontName, fallback: 'Requested font family is unavailable; used an installed font returned by Figma.' };
    }
    return { font: found.fontName, fallback: 'Requested weight style is unavailable; used the first installed style for this family.' };
  }
  return { font: { family, style: exact }, fallback: exact === preferred ? null : 'Requested weight style is unavailable; used Regular.' };
};
const __decorate = (target, source) => {
  target.name = source.name;
  target.visible = source.visible;
  const style = source.style || {};
  if (typeof style.opacity === 'number') target.opacity = style.opacity;
  const fill = __color(style.fill);
  if (fill && 'fills' in target) target.fills = [{ type: 'SOLID', color: fill.color, opacity: fill.opacity }];
  else if (!fill && target.type === 'FRAME') target.fills = [];
  const textColor = __color(style.textColor);
  if (textColor && source.kind === 'text') target.fills = [{ type: 'SOLID', color: textColor.color, opacity: textColor.opacity }];
  if (style.radius && 'cornerRadius' in target) target.cornerRadius = __measure(style.radius);
};
const __setAutoLayout = (target, source) => {
  const layout = source.layout;
  target.layoutMode = layout.mode === 'horizontal' ? 'HORIZONTAL' : 'VERTICAL';
  target.itemSpacing = __measure(layout.gap);
  target.paddingTop = __measure(layout.padding.top);
  target.paddingRight = __measure(layout.padding.right);
  target.paddingBottom = __measure(layout.padding.bottom);
  target.paddingLeft = __measure(layout.padding.left);
  target.primaryAxisAlignItems = layout.justify === 'center' ? 'CENTER' : layout.justify === 'end' ? 'MAX' : layout.justify === 'space-between' ? 'SPACE_BETWEEN' : 'MIN';
  target.counterAxisAlignItems = layout.align === 'center' ? 'CENTER' : layout.align === 'end' ? 'MAX' : 'MIN';
};
const __dimensions = (target, source) => {
  const width = __sizing(source, 'width');
  const height = __sizing(source, 'height');
  const w = width.kind === 'fixed' ? __measure(width.value, 100) : 100;
  const h = height.kind === 'fixed' ? __measure(height.value, 100) : 100;
  target.resize(Math.max(1, w), Math.max(1, h));
  if (target.type === 'FRAME' && target.layoutMode !== 'NONE') {
    target.primaryAxisSizingMode = (source.layout.mode === 'horizontal' ? width : height).kind === 'hug' ? 'AUTO' : 'FIXED';
    target.counterAxisSizingMode = (source.layout.mode === 'horizontal' ? height : width).kind === 'hug' ? 'AUTO' : 'FIXED';
  }
};
const __make = async (source) => {
  let target;
  if (source.kind === 'text') {
    target = figma.createText();
    const spec = __fontSpec(source);
    await figma.loadFontAsync(spec.font);
    target.fontName = spec.font;
    target.characters = source.text || '';
    const token = source.textStyle && source.textStyle.typographyTokenId ? __doc.tokens[source.textStyle.typographyTokenId] : null;
    const fontSize = source.textStyle && source.textStyle.fontSize ? __measure(source.textStyle.fontSize) : token && token.category === 'typography' ? token.value.fontSizePx : 16;
    target.fontSize = fontSize;
    const lineHeightRatio = source.textStyle && source.textStyle.lineHeight ? source.textStyle.lineHeight : token && token.category === 'typography' ? token.value.lineHeight : 1.2;
    target.lineHeight = { unit: 'PIXELS', value: fontSize * lineHeightRatio };
    if (token && token.category === 'typography' && typeof token.value.letterSpacingPx === 'number') target.letterSpacing = { unit: 'PIXELS', value: token.value.letterSpacingPx };
    if (source.textStyle && source.textStyle.align) target.textAlignHorizontal = source.textStyle.align === 'center' ? 'CENTER' : source.textStyle.align === 'end' ? 'RIGHT' : 'LEFT';
    target.textAutoResize = 'HEIGHT';
    __fontReport.push({ sourceId: source.sourceId, family: spec.font.family, style: spec.font.style, fallback: spec.fallback });
    if (spec.fallback) __warnings.push({ sourceId: source.sourceId, message: spec.fallback });
  } else if (source.kind === 'vector') {
    const vb = source.viewBox || [0, 0, 100, 100];
    const escaped = String(source.pathData || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    target = figma.createNodeFromSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + vb.join(' ') + '"><path d="' + escaped + '"/></svg>');
  } else if (source.kind === 'frame' || source.kind === 'group' || source.kind === 'component-instance') {
    target = source.layout.mode === 'free' ? figma.createFrame() : figma.createAutoLayout(source.layout.mode === 'horizontal' ? 'HORIZONTAL' : 'VERTICAL');
  } else {
    __warnings.push({ sourceId: source.sourceId, message: 'Unsupported node kind: ' + source.kind });
    return null;
  }
  __decorate(target, source);
  if (target.type === 'FRAME' && source.kind !== 'vector' && source.layout.mode !== 'free') __setAutoLayout(target, source);
  __dimensions(target, source);
  __nodes[source.sourceId] = target;
  __sourceMappings.push({ sourceId: source.sourceId, sourceNodeId: source.sourceNodeId, targetId: target.id, kind: source.kind });
  for (const childSource of source.children || []) {
    const child = await __make(childSource);
    if (!child) continue;
    target.appendChild(child);
    if (target.type === 'FRAME' && target.layoutMode !== 'NONE') {
      if (source.layout.align === 'stretch') child.layoutAlign = 'STRETCH';
      const width = __sizing(childSource, 'width');
      const height = __sizing(childSource, 'height');
      if (width.kind === 'fill') child.layoutSizingHorizontal = 'FILL';
      else if (width.kind === 'hug' && (child.type === 'TEXT' || child.type === 'FRAME')) child.layoutSizingHorizontal = 'HUG';
      if (height.kind === 'fill') child.layoutSizingVertical = 'FILL';
      else if (height.kind === 'hug' && (child.type === 'TEXT' || child.type === 'FRAME')) child.layoutSizingVertical = 'HUG';
    } else if (source.layout.mode === 'free') {
      child.x = childSource.layout.position ? childSource.layout.position.x : 0;
      child.y = childSource.layout.position ? childSource.layout.position.y : 0;
    }
  }
  if (source.kind === 'vector' && target.type === 'FRAME') {
    const fill = __color(source.style && source.style.fill);
    for (const descendant of target.findAll(() => true)) {
      if (fill && 'fills' in descendant) descendant.fills = [{ type: 'SOLID', color: fill.color, opacity: fill.opacity }];
      __sourceMappings.push({ sourceId: source.sourceId + '#geometry:' + descendant.id, sourceNodeId: source.sourceNodeId, targetId: descendant.id, kind: 'vector-geometry' });
    }
  }
  return target;
};
if (__pageId !== null) {
  const __targetPage = await figma.getNodeByIdAsync(__pageId);
  if (!__targetPage || __targetPage.type !== 'PAGE') throw new Error('Figma page not found: ' + __pageId);
  await figma.setCurrentPageAsync(__targetPage);
}
const __roots = [];
const __sourcePage = __doc.pages[__sourcePageId];
const __existingRight = Math.max(0, ...figma.currentPage.children.map((node) => node.x + node.width));
let __nextX = Math.max(__viewportWidth + 120, __existingRight + 120);
if (__sourcePage) {
  for (const id of __sourcePage.rootNodeIds) {
    const source = __doc.nodes[id];
    if (!source) continue;
    const renderedSource = __doc.renderTrees[__sourcePage.id].find((node) => node.sourceNodeId === id && node.sourceId === id);
    const target = await __make(renderedSource);
    if (!target) continue;
    target.x = __nextX + (renderedSource.layout.position ? renderedSource.layout.position.x : 0);
    target.y = 120 + (renderedSource.layout.position ? renderedSource.layout.position.y : 0);
    figma.currentPage.appendChild(target);
    __roots.push(target);
    __nextX += target.width + 120;
  }
}
const __bounds = __roots.map((node) => {
  const transform = node.absoluteTransform;
  return { targetId: node.id, x: transform[0][2], y: transform[1][2], width: node.width, height: node.height };
});
const __result = { status: 'written', pageId: figma.currentPage.id, createdNodeIds: __sourceMappings.map((item) => item.targetId), sourceMappings: __sourceMappings, counts: { nodes: __sourceMappings.length, text: __fontReport.length, roots: __roots.length }, bounds: __bounds, fonts: __fontReport, warnings: __warnings };
return __result;`;

function renderTrees(document: DesignDocument, viewportWidth = 1440): Record<string, RenderNode[]> {
  const output: Record<string, RenderNode[]> = Object.create(null) as Record<string, RenderNode[]>;
  for (const pageId of document.pageOrder) {
    const page = document.pages[pageId];
    if (!page) continue;
    output[pageId] = page.rootNodeIds.map((id) => {
      const node = document.nodes[id];
      if (!node) throw new Error(`Missing page root ${id}.`);
      return renderNode(document, node, viewportWidth);
    });
  }
  return output;
}

/** Creates plain JavaScript for one Figma page. Run through use_figma; it deliberately uses top-level await and return. */
export function buildFigmaScript(document: DesignDocument, targetPageId?: string, viewportWidth = 1440, semanticPageId = document.pageOrder[0] ?? ''): string {
  const parsed = validateDocument(document);
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join(' '));
  if (!document.pages[semanticPageId]) throw new Error(`Unknown semantic design page: ${semanticPageId}.`);
  if (!Number.isFinite(viewportWidth) || viewportWidth < 1) throw new Error('Viewport width must be a positive finite number.');
  const renderTreesValue = renderTrees(document, viewportWidth);
  const payload = { ...parsed.value, renderTrees: renderTreesValue };
  return scriptRuntime
    .replace('__PAYLOAD__', () => safeJson(payload))
    .replace('__PAGE_ID__', () => targetPageId === undefined ? 'null' : safeJson(targetPageId))
    .replace('__SOURCE_PAGE_ID__', () => safeJson(semanticPageId))
    .replace('__VIEWPORT__', String(viewportWidth));
}

export class FigmaExporter implements DesignExporter {
  async export(document: DesignDocument): Promise<ExportResult> {
    const parsed = validateDocument(document);
    if (!parsed.ok) return { target: 'figma', status: 'failed', artifacts: [], fidelity: [], diagnostics: parsed.diagnostics };
    let trees: Record<string, RenderNode[]>;
    try { trees = renderTrees(parsed.value); }
    catch (error) {
      return { target: 'figma', status: 'failed', artifacts: [], fidelity: [], diagnostics: [{ code: 'export.figma.render-tree', message: error instanceof Error ? error.message : 'Could not resolve semantic component tree.', severity: 'error' }] };
    }
    const fidelity = fidelityFor(parsed.value);
    const diagnostics = [
      { code: 'export.figma.live-write-unverified', message: 'This archive contains a Figma plugin script; no Figma file was written by the offline exporter.', severity: 'warning' as const },
      { code: 'export.figma.plugin-id-required', message: 'Create a development plugin in Figma and replace the manifest ID placeholder with its Figma-assigned ID before importing this bundle. See README.md in the archive.', severity: 'warning' as const },
    ];
    const artifacts = [
      { name: 'manifest.json', mimeType: 'application/json', encoding: 'utf8' as const, contents: `${JSON.stringify({ name: 'Pudly Semantic Import', id: 'REPLACE_WITH_FIGMA_ASSIGNED_PLUGIN_ID', api: '1.0.0', main: 'code.js', editorType: ['figma'], documentAccess: 'dynamic-page', networkAccess: { allowedDomains: ['none'] } }, null, 2)}\n` },
      { name: 'README.md', mimeType: 'text/markdown', encoding: 'utf8' as const, contents: 'Create a new development plugin in Figma to obtain its assigned plugin ID. Replace the ID placeholder in manifest.json with that ID, import this manifest, and run the plugin in a Figma design file. The plugin imports the first semantic page as editable layers and adds new content beside existing layers. It does not delete or sync prior imports. Review fidelity-report.json for all mapping limits.\n\nManifest reference: https://developers.figma.com/docs/plugins/manifest/\n' },
      { name: 'code.js', mimeType: 'text/javascript', encoding: 'utf8' as const, contents: pluginCode(parsed.value, trees) },
      { name: 'design-document.json', mimeType: 'application/json', encoding: 'utf8' as const, contents: `${JSON.stringify(parsed.value, null, 2)}\n` },
    ];
    const result: ExportResult = { target: 'figma', status: 'partial', artifacts, fidelity, diagnostics };
    return new BundledExporter({ export: async () => result }, 'pudly-figma-plugin.zip').export(parsed.value);
  }
}

function pluginCode(document: DesignDocument, trees: Record<string, RenderNode[]>): string {
  const payload = safeJson({ ...document, renderTrees: trees });
  const body = scriptRuntime
    .replace('__PAYLOAD__', () => payload)
    .replace('__PAGE_ID__', () => 'null')
    .replace('__SOURCE_PAGE_ID__', () => safeJson(document.pageOrder[0] ?? ''))
    .replace('__VIEWPORT__', '1440')
    .replace('if (__pageId !== null) {\n  const __targetPage = await figma.getNodeByIdAsync(__pageId);\n  if (!__targetPage || __targetPage.type !== \'PAGE\') throw new Error(\'Figma page not found: \' + __pageId);\n  await figma.setCurrentPageAsync(__targetPage);\n}', '')
    .replace('return __result;', 'return __result;');
  const stripped = body.slice(0, body.lastIndexOf('return __result;'));
  const runtime = stripped.replaceAll('figma.createAutoLayout(', 'createLayoutFrame(');
  return `const createLayoutFrame = (direction) => { const frame = figma.createFrame(); frame.layoutMode = direction; return frame; };\n(async () => {\n${runtime}\nconst result = __result;\nfigma.closePlugin('Created ' + result.counts.nodes + ' Figma layers from the semantic design document.');\n})().catch((error) => figma.closePlugin(String(error)));\n`;
}
