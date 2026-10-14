import { toRaw, type CSSProperties } from 'vue';
import type {
  ComponentInstanceNode,
  ColorValue,
  DesignDocument,
  DesignNode,
  Layout,
  Measure,
  NodeId,
  SemanticStyle,
  Sizing,
  TextStyle,
  TemplateNode,
  ResolvedComponentInstance,
} from '../domain/types';
import { resolveComponentInstance, resolveMeasure as resolveSemanticMeasure, resolveResponsiveLayout } from '../domain';

export type ResolvedNode = {
  node: DesignNode;
  layout: Layout;
  style: SemanticStyle;
  textStyle?: TextStyle;
  visible: boolean;
};

export function resolveMeasure(
  document: DesignDocument,
  measure: Measure | undefined,
  fallback = 0,
  category: 'spacing' | 'radius' | 'typography' | 'breakpoint' = 'spacing',
): number {
  if (!measure) return fallback;
  return resolveSemanticMeasure(document, measure, category) ?? fallback;
}

export function resolveColor(document: DesignDocument, color: ColorValue | undefined, fallback: string): string {
  if (!color) return fallback;
  if (color.kind === 'literal') return color.value;
  const token = document.tokens[color.tokenId];
  if (token?.category !== 'color') return fallback;
  if (token.value.alpha === undefined || token.value.alpha === 1) return token.value.hex;
  return `color-mix(in srgb, ${token.value.hex} ${token.value.alpha * 100}%, transparent)`;
}

export function resolveNode(document: DesignDocument, nodeId: NodeId, viewportWidth: number): ResolvedNode | null {
  const node = document.nodes[nodeId];
  if (!node) return null;
  // The document lives in Vue state in the editor. Pass its raw backing object
  // into the pure domain helper because structuredClone rejects Vue proxies.
  const responsive = resolveResponsiveLayout(toRaw(document), toRaw(node), viewportWidth);
  return {
    node,
    layout: responsive.layout,
    style: node.style,
    ...(node.kind === 'text' ? { textStyle: node.textStyle } : {}),
    visible: responsive.visible,
  };
}

export function resolveComponent(document: DesignDocument, node: ComponentInstanceNode): ResolvedComponentInstance | null {
  return resolveComponentInstance(toRaw(document), toRaw(node));
}

export function resolveTemplateNode(
  document: DesignDocument,
  instance: ComponentInstanceNode,
  resolvedComponent: ResolvedComponentInstance,
  templateNodeId: string,
  viewportWidth: number,
): ResolvedNode | null {
  const template = resolvedComponent.nodes[templateNodeId] as (TemplateNode & Record<string, unknown>) | undefined;
  if (!template) return null;
  const node = {
    ...template,
    id: `${instance.id}::${templateNodeId}`,
    childIds: template.childTemplateNodeIds,
  } as unknown as DesignNode;
  const responsive = resolveResponsiveLayout(toRaw(document), node, viewportWidth);
  return {
    node,
    layout: responsive.layout,
    style: templateNodeId === resolvedComponent.definition.rootTemplateNodeId ? { ...node.style, ...instance.style } : node.style,
    ...(node.kind === 'text' ? { textStyle: node.textStyle } : {}),
    visible: responsive.visible,
  };
}

function resolveSizing(document: DesignDocument, sizing: Sizing): { value?: number; min?: number; max?: number; mode: Sizing['kind'] } {
  const value = sizing.kind === 'fixed' ? resolveMeasure(document, sizing.value) : undefined;
  const min = 'min' in sizing && sizing.min ? resolveMeasure(document, sizing.min) : undefined;
  const max = 'max' in sizing && sizing.max ? resolveMeasure(document, sizing.max) : undefined;
  return {
    mode: sizing.kind,
    ...(value === undefined ? {} : { value }),
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  };
}

export function nodeStyle(
  document: DesignDocument,
  resolved: ResolvedNode,
  parentLayout: Layout | null,
): CSSProperties {
  const { node, layout, style } = resolved;
  const width = resolveSizing(document, layout.width);
  const height = resolveSizing(document, layout.height);
  const inFreeParent = parentLayout?.mode === 'free';
  const pagePositioned = parentLayout === null && layout.position !== undefined;
  const positioning = inFreeParent || pagePositioned;
  const anchors = resolved.node.constraints;
  const horizontalFill = parentLayout?.mode === 'horizontal' && layout.width.kind === 'fill';
  const verticalFill = parentLayout?.mode === 'vertical' && layout.height.kind === 'fill';
  const horizontalStretch = anchors.left !== undefined && anchors.right !== undefined;
  const verticalStretch = anchors.top !== undefined && anchors.bottom !== undefined;
  const fill = resolveColor(document, style.fill, 'transparent');
  const textColor = resolveColor(document, style.textColor, '#20242b');
  const horizontal = layout.mode === 'horizontal';
  const typography = node.kind === 'text' && node.textStyle.typographyTokenId ? document.tokens[node.textStyle.typographyTokenId] : undefined;
  const textStyle = node.kind === 'text' ? node.textStyle : undefined;
  const typographyValue = typography?.category === 'typography' ? typography.value : undefined;
  const shadow = style.shadowTokenId ? document.tokens[style.shadowTokenId] : undefined;
  return {
    boxSizing: 'border-box',
    display: layout.mode === 'free' ? 'block' : ['frame', 'group', 'component-instance'].includes(node.kind) ? 'flex' : 'block',
    flexDirection: horizontal ? 'row' : 'column',
    alignItems: { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' }[layout.align],
    justifyContent: {
      start: 'flex-start', center: 'center', end: 'flex-end', 'space-between': 'space-between',
    }[layout.justify],
    gap: `${resolveMeasure(document, layout.gap)}px`,
    padding: `${resolveMeasure(document, layout.padding.top)}px ${resolveMeasure(document, layout.padding.right)}px ${resolveMeasure(document, layout.padding.bottom)}px ${resolveMeasure(document, layout.padding.left)}px`,
    width: horizontalStretch ? 'auto' : width.mode === 'fill' ? horizontalFill ? '0px' : '100%' : width.mode === 'hug' ? 'fit-content' : `${width.value ?? 0}px`,
    height: verticalStretch ? 'auto' : height.mode === 'fill' ? verticalFill ? '0px' : '100%' : height.mode === 'hug' ? 'fit-content' : `${height.value ?? 0}px`,
    minWidth: width.min === undefined ? undefined : `${width.min}px`,
    maxWidth: width.max === undefined ? undefined : `${width.max}px`,
    minHeight: height.min === undefined ? undefined : `${height.min}px`,
    maxHeight: height.max === undefined ? undefined : `${height.max}px`,
    position: positioning ? 'absolute' : 'relative',
    left: anchors.centerX ? '50%' : anchors.left !== undefined ? `${resolveMeasure(document, anchors.left)}px` : positioning && layout.position ? `${layout.position.x}px` : undefined,
    right: anchors.right === undefined ? undefined : `${resolveMeasure(document, anchors.right)}px`,
    top: anchors.centerY ? '50%' : anchors.top !== undefined ? `${resolveMeasure(document, anchors.top)}px` : positioning && layout.position ? `${layout.position.y}px` : undefined,
    bottom: anchors.bottom === undefined ? undefined : `${resolveMeasure(document, anchors.bottom)}px`,
    transform: anchors.centerX || anchors.centerY ? `translate(${anchors.centerX ? '-50%' : '0'}, ${anchors.centerY ? '-50%' : '0'})` : undefined,
    backgroundColor: node.kind === 'vector' ? 'transparent' : fill,
    color: node.kind === 'vector' ? resolveColor(document, style.fill ?? style.textColor, '#20242b') : textColor,
    borderRadius: style.radius ? `${resolveMeasure(document, style.radius, 0, 'radius')}px` : undefined,
    opacity: style.opacity,
    fontFamily: typographyValue?.fontFamily,
    fontSize: textStyle?.fontSize ? `${resolveMeasure(document, textStyle.fontSize, 16, 'typography')}px` : typographyValue ? `${typographyValue.fontSizePx}px` : undefined,
    fontWeight: textStyle?.weight ?? typographyValue?.weight,
    lineHeight: textStyle?.lineHeight ?? typographyValue?.lineHeight,
    letterSpacing: typographyValue?.letterSpacingPx === undefined ? undefined : `${typographyValue.letterSpacingPx}px`,
    textAlign: textStyle?.align,
    boxShadow: shadow?.category === 'shadow' ? `${shadow.value.xPx}px ${shadow.value.yPx}px ${shadow.value.blurPx}px ${shadow.value.spreadPx}px ${resolveColor(document, shadow.value.color, 'transparent')}` : undefined,
    alignSelf: layout.mode === 'free' ? 'auto' : (
      (layout.width.kind === 'fill' && parentLayout?.mode === 'vertical')
      || (layout.height.kind === 'fill' && parentLayout?.mode === 'horizontal')
    ) ? 'stretch' : undefined,
    flexGrow: horizontalFill || verticalFill ? 1 : undefined,
    flexShrink: horizontalFill || verticalFill ? 1 : 0,
    flexBasis: horizontalFill || verticalFill ? '0%' : undefined,
  };
}

export function parentLayoutFor(document: DesignDocument, nodeId: NodeId): Layout | null {
  for (const candidate of Object.values(document.nodes)) {
    if (candidate.childIds.includes(nodeId)) return candidate.layout;
    if (candidate.kind === 'component-instance' && Object.values(candidate.slotChildren).some((ids) => ids.includes(nodeId))) {
      return candidate.layout;
    }
  }
  return null;
}

export function pageNodeIds(document: DesignDocument, pageId: string): Set<NodeId> {
  const page = document.pages[pageId];
  const ids = new Set<NodeId>();
  const visit = (id: NodeId) => {
    if (ids.has(id) || !document.nodes[id]) return;
    ids.add(id);
    const node = document.nodes[id];
    for (const childId of node.childIds) visit(childId);
    if (node.kind === 'component-instance') {
      for (const slotIds of Object.values(node.slotChildren)) for (const childId of slotIds) visit(childId);
    }
  };
  page?.rootNodeIds.forEach(visit);
  return ids;
}
