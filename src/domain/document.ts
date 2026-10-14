import { DOCUMENT_SCHEMA_VERSION } from './defaults.js';
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENT_NODES, addDiagnostic, getOwnValue, inspectJsonGraph, isFiniteNumber, isNonNegativeInteger, isRecord, safeSerializedSize, validationFailure, validationOk } from './validation-utils.js';
import type { DesignDocument, DesignNode, DesignToken, Diagnostic, Layout, Measure, ValidationResult, ResolvedColor, ResolvedComponentInstance } from './types.js';
import { DOCUMENT_KEYS, validateNode, validateToken, exact, stringField, stringArray, type TokenIndex } from './document-shapes.js';
import { validateOwnership } from './document-ownership.js';
import { validateComponents } from './component-validation.js';

export function migrateDocument(input: unknown): ValidationResult<DesignDocument> {
  if (!isRecord(input) || input.schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
    const diagnostics: Diagnostic[] = [{ code: 'document.migration-unsupported', message: 'No migration is registered for this schema version; stored input is preserved.', severity: 'error', path: '$.schemaVersion' }];
    return validationFailure(diagnostics);
  }
  return validateDocument(input);
}

export function validateDocument(input: unknown): ValidationResult<DesignDocument> {
  const diagnostics = inspectJsonGraph(input, 1_000_000, 80);
  if (diagnostics.length > 0) return validationFailure(diagnostics);
  const size = safeSerializedSize(input);
  if (size === null || size > MAX_DOCUMENT_BYTES) {
    addDiagnostic(diagnostics, 'limit.document-bytes', `Document exceeds ${MAX_DOCUMENT_BYTES} serialized bytes.`, '$');
    return validationFailure(diagnostics);
  }
  if (!exact(input, DOCUMENT_KEYS, '$', diagnostics)) return validationFailure(diagnostics);
  if (input.schemaVersion !== DOCUMENT_SCHEMA_VERSION) addDiagnostic(diagnostics, 'document.version', `Only schema version ${DOCUMENT_SCHEMA_VERSION} is supported.`, '$.schemaVersion');
  if (!stringField(input.id, '$.id', diagnostics) || !stringField(input.name, '$.name', diagnostics)) { /* diagnostics recorded */ }
  if (!isNonNegativeInteger(input.revision)) addDiagnostic(diagnostics, 'document.revision', 'Revision must be a non-negative safe integer.', '$.revision');
  if (!stringArray(input.pageOrder, '$.pageOrder', diagnostics)) return validationFailure(diagnostics);
  for (const key of ['pages', 'nodes', 'tokens', 'components', 'metadata']) if (!isRecord(input[key])) addDiagnostic(diagnostics, 'document.record', `${key} must be an object.`, `$.${key}`);
  if (diagnostics.length > 0) return validationFailure(diagnostics);
  const pages = input.pages as Record<string, unknown>;
  const nodes = input.nodes as Record<string, unknown>;
  const tokensRaw = input.tokens as Record<string, unknown>;
  for (const [key, value] of Object.entries(input.metadata as Record<string, unknown>)) {
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) addDiagnostic(diagnostics, 'document.metadata-value', 'Metadata values must be JSON scalars.', `$.metadata.${key}`);
  }
  if (Object.keys(nodes).length > MAX_DOCUMENT_NODES) addDiagnostic(diagnostics, 'limit.nodes', `Document exceeds ${MAX_DOCUMENT_NODES} nodes.`, '$.nodes');
  if (input.pageOrder.length === 0) addDiagnostic(diagnostics, 'page.required', 'A document must contain at least one page.', '$.pageOrder');
  const seenPages = new Set<string>();
  for (const [pageId, page] of Object.entries(pages)) {
    if (!exact(page, ['id', 'name', 'rootNodeIds'], `$.pages.${pageId}`, diagnostics)) continue;
    if (page.id !== pageId) addDiagnostic(diagnostics, 'page.id', 'Page map key must match page.id.', `$.pages.${pageId}.id`);
    stringField(page.name, `$.pages.${pageId}.name`, diagnostics);
    if (!stringArray(page.rootNodeIds, `$.pages.${pageId}.rootNodeIds`, diagnostics)) continue;
  }
  for (const id of input.pageOrder) {
    if (seenPages.has(id)) addDiagnostic(diagnostics, 'page.order-duplicate', 'Page order contains duplicate IDs.', '$.pageOrder', id);
    seenPages.add(id);
    if (!Object.hasOwn(pages, id)) addDiagnostic(diagnostics, 'page.order-missing', 'Page order references missing page.', '$.pageOrder', id);
  }
  for (const id of Object.keys(pages)) if (!seenPages.has(id)) addDiagnostic(diagnostics, 'page.order-incomplete', 'Every page must appear in pageOrder.', '$.pageOrder', id);
  const tokens: TokenIndex = new Map();
  for (const [tokenId, token] of Object.entries(tokensRaw)) {
    const before = diagnostics.length;
    if (validateToken(token, `$.tokens.${tokenId}`, diagnostics)) {
      if (token.id !== tokenId) addDiagnostic(diagnostics, 'token.id', 'Token map key must match id.', `$.tokens.${tokenId}.id`);
      tokens.set(tokenId, token);
    } else if (diagnostics.length === before) addDiagnostic(diagnostics, 'token.invalid', 'Token payload contains an invalid value.', `$.tokens.${tokenId}`, tokenId);
  }
  for (const [nodeId, node] of Object.entries(nodes)) {
    const before = diagnostics.length;
    if (validateNode(node, `$.nodes.${nodeId}`, diagnostics, tokens)) {
      if (node.id !== nodeId) addDiagnostic(diagnostics, 'node.id', 'Node map key must match node.id.', `$.nodes.${nodeId}.id`);
    } else if (diagnostics.length === before) addDiagnostic(diagnostics, 'node.invalid', 'Node payload contains an invalid value.', `$.nodes.${nodeId}`, nodeId);
  }
  if (diagnostics.length > 0) return validationFailure(diagnostics);
  for (const [tokenId, token] of Object.entries(tokens)) {
    if (token.category !== 'shadow' || !('color' in token.value) || !isRecord(token.value.color) || token.value.color.kind !== 'token') continue;
    const colorToken = tokens.get(String(token.value.color.tokenId));
    if (colorToken?.category !== 'color') addDiagnostic(diagnostics, 'token.category', 'Shadow color reference must resolve to a color token.', `$.tokens.${tokenId}.value.color.tokenId`, String(token.value.color.tokenId));
  }
  const ownerLayout = new Map<string, unknown>();
  for (const rawPage of Object.values(pages)) if (isRecord(rawPage) && Array.isArray(rawPage.rootNodeIds)) for (const childId of rawPage.rootNodeIds) if (typeof childId === 'string') ownerLayout.set(childId, undefined);
  for (const rawParent of Object.values(nodes)) {
    if (!isRecord(rawParent)) continue;
    if (Array.isArray(rawParent.childIds)) for (const childId of rawParent.childIds) if (typeof childId === 'string') ownerLayout.set(childId, rawParent.layout);
    if (isRecord(rawParent.slotChildren)) for (const children of Object.values(rawParent.slotChildren)) if (Array.isArray(children)) for (const childId of children) if (typeof childId === 'string') ownerLayout.set(childId, rawParent.layout);
  }
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (!isRecord(node)) continue;
    const parentLayout = ownerLayout.get(nodeId);
    const layout = node.layout;
    if (isRecord(parentLayout) && parentLayout.mode === 'free') {
      if (!isRecord(layout) || !isRecord(layout.position) || !isFiniteNumber(layout.position.x) || !isFiniteNumber(layout.position.y)) addDiagnostic(diagnostics, 'layout.position-required', 'Node in a free-layout parent requires finite x/y position.', `$.nodes.${nodeId}.layout.position`, nodeId);
    } else if (parentLayout !== undefined && isRecord(layout) && layout.position !== undefined) addDiagnostic(diagnostics, 'layout.position-forbidden', 'Node in an auto-layout parent must omit position.', `$.nodes.${nodeId}.layout.position`, nodeId);
    if (parentLayout !== undefined && isRecord(parentLayout) && parentLayout.mode !== 'free' && isRecord(node.constraints) && Object.keys(node.constraints).length > 0) addDiagnostic(diagnostics, 'layout.constraints-forbidden', 'Anchor constraints are only valid in free-layout parents.', `$.nodes.${nodeId}.constraints`, nodeId);
  }
  validateComponents(input, diagnostics);
  validateOwnership(input, diagnostics);
  if (diagnostics.length > 0) return validationFailure(diagnostics);
  return validationOk(input as unknown as DesignDocument, diagnostics);
}

export function resolveMeasure(document: DesignDocument, measure: Measure, expected: DesignToken['category']): number | null {
  if (measure.kind === 'literal') return measure.value;
  const token = document.tokens[measure.tokenId];
  if (token === undefined || token.category !== expected) return null;
  if ('valuePx' in token.value) return token.value.valuePx;
  if (token.category === 'typography') return token.value.fontSizePx;
  return null;
}

export function resolveResponsiveLayout(document: DesignDocument, node: DesignNode, canvasWidth: number): { layout: Layout; visible: boolean } {
  const breakpointWidth = (tokenId: string): number | null => {
    const token = document.tokens[tokenId];
    return token?.category === 'breakpoint' && 'valuePx' in token.value ? token.value.valuePx : null;
  };
  const rules = [...node.responsive].filter((rule) => {
    const width = breakpointWidth(rule.breakpointTokenId);
    return width !== null && width <= canvasWidth;
  }).sort((a, b) => {
    const av = breakpointWidth(a.breakpointTokenId) ?? 0;
    const bv = breakpointWidth(b.breakpointTokenId) ?? 0;
    return av - bv || a.priority - b.priority;
  });
  let layout = structuredClone(node.layout);
  let visible = node.visible;
  for (const rule of rules) {
    if (rule.overrides.layout !== undefined) layout = { ...layout, ...rule.overrides.layout, padding: { ...layout.padding, ...rule.overrides.layout.padding } };
    if (rule.overrides.visible !== undefined) visible = rule.overrides.visible;
  }
  return { layout, visible };
}

export function resolveComponentInstance(document: DesignDocument, node: DesignNode & { kind: 'component-instance' }): ResolvedComponentInstance | null {
  const definition = getOwnValue(document.components, node.componentId);
  if (definition === undefined) return null;
  const variant = getOwnValue(definition.variants, node.variantId);
  if (variant === undefined) return null;
  const properties: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(definition.properties)) {
    const value = getOwnValue(node.propertyOverrides, name) ?? getOwnValue(variant.propertyOverrides, name) ?? property.defaultValue;
    properties[name] = value === undefined ? undefined : structuredClone(value);
  }
  const nodes: Record<string, unknown> = {};
  for (const [templateId, template] of Object.entries(definition.templateNodes)) {
    const variantOverride = getOwnValue(variant.nodeOverrides, templateId);
    const instanceOverride = getOwnValue(node.nodeOverrides, templateId);
    nodes[templateId] = {
      ...structuredClone(template),
      ...structuredClone(variantOverride ?? {}),
      ...structuredClone(instanceOverride ?? {}),
      style: { ...structuredClone(template.style), ...structuredClone(variantOverride?.style ?? {}), ...structuredClone(instanceOverride?.style ?? {}) },
      ...(template.kind === 'text' ? { textStyle: { ...structuredClone(template.textStyle), ...structuredClone(variantOverride?.textStyle ?? {}), ...structuredClone(instanceOverride?.textStyle ?? {}) } } : {}),
    };
  }
  for (const [name, property] of Object.entries(definition.properties)) {
    if (property.binding === undefined) continue;
    const boundNode = getOwnValue(nodes, property.binding.templateNodeId);
    if (boundNode !== undefined && isRecord(boundNode)) boundNode[property.binding.property] = properties[name];
  }
  const slots = Object.fromEntries(Object.entries(definition.slots).map(([slotId, slot]) => [slotId, { anchorTemplateNodeId: slot.templateAnchorNodeId, children: (getOwnValue(node.slotChildren, slotId) ?? []).map((id) => getOwnValue(document.nodes, id)).filter((child): child is DesignNode => child !== undefined).map(child => structuredClone(child)) }]));
  return { definition, properties, nodes, slots };
}

export function resolveColor(document: DesignDocument, color: import('./types.js').ColorValue): ResolvedColor | null {
  if (color.kind === 'literal') {
    const value = color.value;
    if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)) return null;
    const hex = value.slice(0, 7).toUpperCase();
    const alpha = value.length === 9 ? Number.parseInt(value.slice(7), 16) / 255 : 1;
    return { hex, alpha };
  }
  const token = document.tokens[color.tokenId];
  if (token?.category !== 'color') return null;
  return { hex: token.value.hex.toUpperCase(), alpha: token.value.alpha ?? 1 };
}
