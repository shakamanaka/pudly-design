import type { CodingAgentRequest, ColorValue, DesignDocument, DesignNode, Diagnostic } from '../domain/types';
import { resolveMeasure, resolveResponsiveLayout } from '../domain';
import { inferDesignIntent } from './design-brief';

type Rgb = readonly [number, number, number];

function opaqueRgb(document: DesignDocument, color: ColorValue): Rgb | null {
  let hex: string;
  let alpha = 1;
  if (color.kind === 'literal') {
    if (/^#[0-9a-f]{3}$/i.test(color.value)) {
      hex = `#${[...color.value.slice(1)].map(channel => channel + channel).join('')}`;
    } else if (/^#[0-9a-f]{6}$/i.test(color.value)) {
      hex = color.value;
    } else if (/^#[0-9a-f]{8}$/i.test(color.value)) {
      hex = color.value.slice(0, 7);
      alpha = Number.parseInt(color.value.slice(7), 16) / 255;
    } else {
      return null;
    }
  } else {
    const token = document.tokens[color.tokenId];
    if (token?.category !== 'color') return null;
    hex = token.value.hex;
    alpha = token.value.alpha ?? 1;
    if (/^#[0-9a-f]{3}$/i.test(hex)) {
      hex = `#${[...hex.slice(1)].map(channel => channel + channel).join('')}`;
    } else if (!/^#[0-9a-f]{6}$/i.test(hex)) {
      return null;
    }
  }
  if (alpha !== 1) return null;
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function walkVisiblePage(
  document: DesignDocument,
  page: { rootNodeIds: string[] },
  viewportWidth: number,
  visit: (node: DesignNode, ancestors: DesignNode[]) => void,
): void {
  const seen = new Set<string>();
  const walk = (id: string, ancestors: DesignNode[]): void => {
    if (seen.has(id)) return;
    const node = document.nodes[id];
    if (!node || !resolveResponsiveLayout(document, node, viewportWidth).visible) return;
    seen.add(id);
    visit(node, ancestors);
    const children = [
      ...node.childIds,
      ...(node.kind === 'component-instance' ? Object.values(node.slotChildren).flat() : []),
    ];
    children.forEach(childId => walk(childId, [node, ...ancestors]));
  };
  page.rootNodeIds.forEach(rootId => walk(rootId, []));
}

function relativeLuminance([red, green, blue]: Rgb): number {
  const linear = (channel: number): number => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function contrastRatio(first: Rgb, second: Rgb): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function textContrastFails(document: DesignDocument, text: Extract<DesignNode, { kind: 'text' }>, ancestors: DesignNode[]): boolean {
  const foreground = text.style.textColor === undefined
    ? [32, 36, 43] as const
    : opaqueRgb(document, text.style.textColor);
  if (!foreground) return false;

  const backgroundChain = [text, ...ancestors];
  if (backgroundChain.some(node => node.style.opacity !== undefined && node.style.opacity !== 1)) return false;
  let background: Rgb | null = null;
  for (const node of backgroundChain) {
    if (node.style.fill === undefined) continue;
    background = opaqueRgb(document, node.style.fill);
    // Unsupported or translucent paint makes the rendered background inconclusive.
    if (!background) return false;
    break;
  }
  background ??= [255, 255, 255]; // Canvas artboard background.

  const typographyToken = text.textStyle.typographyTokenId
    ? document.tokens[text.textStyle.typographyTokenId]
    : undefined;
  const typography = typographyToken?.category === 'typography' ? typographyToken.value : undefined;
  const fontSize = text.textStyle.fontSize
    ? resolveMeasure(document, text.textStyle.fontSize, 'typography') ?? 16
    : typography?.fontSizePx ?? 16;
  const weight = text.textStyle.weight ?? typography?.weight ?? 400;
  const largeText = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700);
  return contrastRatio(foreground, background) < (largeText ? 3 : 4.5);
}

/** Objective composition checks; this is not a certification of visual taste. */
export function assessPageComposition(document: DesignDocument, request: CodingAgentRequest): Diagnostic[] {
  if (inferDesignIntent(request) !== 'page') return [];
  const page = document.pages[request.documentFragment.page?.id ?? document.pageOrder[0] ?? ''];
  if (!page) return [{ code: 'quality.page', message: 'Compose the requested page inside its authorized page.', severity: 'error' }];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    const node = document.nodes[id];
    if (!node?.visible) return;
    seen.add(id); node.childIds.forEach(visit);
    if (node.kind === 'component-instance') Object.values(node.slotChildren).flat().forEach(visit);
  };
  page.rootNodeIds.forEach(visit);
  const nodes = [...seen].map(id => document.nodes[id]!);
  const issues: Diagnostic[] = [];
  const error = (code: string, message: string) => issues.push({ code, message, severity: 'error' });
  const roots = page.rootNodeIds.map(id => document.nodes[id]).filter(node => node?.visible);
  if (!roots.some(node => node && (node.layout.width.kind === 'fill' || (node.layout.width.kind === 'fixed' && node.layout.width.value.kind === 'literal' && node.layout.width.value.value >= 1280)))) error('quality.page-width', 'Use a full-width page root (fill, or the 1440px desktop width) instead of a small card surrounded by empty canvas.');
  if (nodes.filter(node => node.kind === 'frame' || node.kind === 'group').length < 4) error('quality.structure', 'Compose distinct page sections with a clear navigation/hero/content/footer hierarchy rather than a sparse skeleton.');
  const texts = nodes.filter(node => node.kind === 'text' && node.text.trim());
  if (texts.length < 6) error('quality.content', 'Provide meaningful page copy, navigation, content and actions instead of a few placeholder labels.');
  const textRoles = new Set(texts.map(node => node.kind === 'text' ? JSON.stringify([node.textStyle.typographyTokenId, node.textStyle.fontSize, node.textStyle.weight]) : ''));
  if (textRoles.size < 2) error('quality.typography', 'Give headings and body content visibly distinct typography using supported tokens or explicit sizes.');
  const imageLed = /\b(store|shop|blog|landing)\b/i.test(request.prompt) && !/\b(no images?|without (images?|illustrations?)|text[- ]only)\b/i.test(request.prompt);
  if (imageLed && !nodes.some(node => node.kind === 'vector' && node.pathData.trim())) error('quality.visual-content', 'Add authored native vector illustration content for this image-led page. Do not substitute empty media boxes, labels or emoji for the visual composition.');
  if (imageLed) {
    for (const node of nodes) {
      const mobile = resolveResponsiveLayout(document, node, 375);
      if (!mobile.visible || mobile.layout.mode !== 'horizontal') continue;
      const children = node.childIds.map(id => document.nodes[id]).filter(child => child && resolveResponsiveLayout(document, child, 375).visible);
      const fills = children.filter(child => resolveResponsiveLayout(document, child!, 375).layout.width.kind === 'fill');
      const longNavigation = children.some(child => child?.kind === 'text' && child.text.length > 32 && resolveResponsiveLayout(document, child, 375).layout.width.kind === 'hug');
      if (fills.length >= 2 || (children.length >= 2 && longNavigation)) {
        error('quality.mobile-layout', 'At 375px, stack multi-column hero/catalog content and keep navigation compact. Breakpoint rules activate at min-width, so mobile layouts must be the base and wider rows belong in tablet/desktop overrides.');
        break;
      }
    }
  }
  if (imageLed) {
    let longTabletRow = false;
    walkVisiblePage(document, page, 768, (node) => {
      if (resolveResponsiveLayout(document, node, 768).layout.mode !== 'horizontal') return;
      const childIds = [
        ...node.childIds,
        ...(node.kind === 'component-instance' ? Object.values(node.slotChildren).flat() : []),
      ];
      const visibleChildren = childIds
        .map(id => document.nodes[id])
        .filter((child): child is DesignNode => child !== undefined && resolveResponsiveLayout(document, child, 768).visible);
      if (visibleChildren.length < 2) return;
      longTabletRow ||= visibleChildren.some(child => child.kind === 'text'
        && child.text.length > 32
        && resolveResponsiveLayout(document, child, 768).layout.width.kind === 'hug');
    });
    if (longTabletRow) error(
      'quality.tablet-layout',
      'At 768px, keep rows with long copy vertical until desktop, or give long text a fill width that fits beside its siblings; short labels can stay in a horizontal row.',
    );
  }
  let lowContrastText = false;
  for (const viewportWidth of [375, 1440]) {
    walkVisiblePage(document, page, viewportWidth, (node, ancestors) => {
      if (node.kind === 'text' && node.text.trim() && textContrastFails(document, node, ancestors)) lowContrastText = true;
    });
  }
  if (lowContrastText) error(
    'quality.text-contrast',
    'Give authored text at least 4.5:1 contrast, or 3:1 for large text (24px regular or 18.66px bold). Use a readable foreground and an opaque text or parent fill; light action text needs a visibly dark filled surface.',
  );
  const vectorVisibility = new Map<string, Set<number>>();
  for (const viewportWidth of [375, 1440]) {
    const viewportSeen = new Set<string>();
    const visitVisible = (id: string): void => {
      if (viewportSeen.has(id)) return;
      const node = document.nodes[id];
      if (!node) return;
      const resolved = resolveResponsiveLayout(document, node, viewportWidth);
      if (!resolved.visible) return;
      viewportSeen.add(id);
      if (node.kind === 'vector') {
        const widths = vectorVisibility.get(id) ?? new Set<number>();
        widths.add(viewportWidth);
        vectorVisibility.set(id, widths);
      }
      node.childIds.forEach(visitVisible);
      if (node.kind === 'component-instance') Object.values(node.slotChildren).flat().forEach(visitVisible);
    };
    page.rootNodeIds.forEach(visitVisible);
  }
  const unboundedVector = [...vectorVisibility].some(([id, widths]) => {
    const vector = document.nodes[id];
    return vector?.kind === 'vector' && [...widths].some((viewportWidth) => {
      const layout = resolveResponsiveLayout(document, vector, viewportWidth).layout;
      return layout.width.kind === 'hug' || layout.height.kind === 'hug';
    });
  });
  if (unboundedVector) error(
    'quality.vector-bounds',
    'Give every visible native vector fixed or fill width and height at both 375px and 1440px; hug can inherit browser SVG intrinsic dimensions and overflow its panel. For one layered illustration, place paths with a shared viewBox inside a bounded free-layout parent, give each path the same explicit local bounds and position, and order layers background/accent first, silhouette next, and details last.',
  );
  return issues;
}
