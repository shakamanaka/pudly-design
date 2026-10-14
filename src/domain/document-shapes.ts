import type { DesignNode, DesignToken, Diagnostic, Layout, Measure, ResponsiveRule, TokenReference } from './types.js';
import { addDiagnostic, hasOnlyKeys, isFiniteNumber, isNonNegativeInteger, isRecord } from './validation-utils.js';

export const DOCUMENT_KEYS = ['schemaVersion', 'id', 'name', 'revision', 'pageOrder', 'pages', 'nodes', 'tokens', 'components', 'metadata'];
export const NODE_BASE_KEYS = ['id', 'name', 'childIds', 'visible', 'layout', 'constraints', 'style', 'responsive'];
const TOKEN_CATEGORIES = ['color', 'typography', 'spacing', 'radius', 'shadow', 'breakpoint', 'motion', 'z-index'];
export type TokenIndex = Map<string, DesignToken>;

export function exact(value: unknown, keys: readonly string[], path: string, ds: Diagnostic[]): value is Record<string, unknown> {
  if (!isRecord(value)) {
    addDiagnostic(ds, 'shape.object', 'Expected a plain object.', path);
    return false;
  }
  hasOnlyKeys(value, keys, path, ds);
  return true;
}
export function stringField(value: unknown, path: string, ds: Diagnostic[], allowEmpty = false): value is string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    addDiagnostic(ds, 'value.string', 'Expected a non-empty string.', path);
    return false;
  }
  return true;
}
function finite(value: unknown, path: string, ds: Diagnostic[], min?: number): value is number {
  if (!isFiniteNumber(value) || (min !== undefined && value < min)) {
    addDiagnostic(ds, 'value.number', `Expected a finite number${min === undefined ? '' : ` greater than or equal to ${min}`}.`, path);
    return false;
  }
  return true;
}
export function stringArray(value: unknown, path: string, ds: Diagnostic[]): value is string[] {
  if (!Array.isArray(value)) {
    addDiagnostic(ds, 'shape.array', 'Expected an array.', path);
    return false;
  }
  value.forEach((entry, index) => stringField(entry, `${path}[${index}]`, ds));
  return true;
}
export function validateTokenReference(value: unknown, tokens: TokenIndex, path: string, ds: Diagnostic[], category?: DesignToken['category'], allowForwardReference = false): value is TokenReference {
  if (!exact(value, ['kind', 'tokenId'], path, ds)) return false;
  if (value.kind !== 'token') addDiagnostic(ds, 'token.reference-kind', 'Expected token reference kind.', `${path}.kind`);
  if (!stringField(value.tokenId, `${path}.tokenId`, ds)) return false;
  const token = tokens.get(value.tokenId);
  if (token === undefined && !allowForwardReference) addDiagnostic(ds, 'token.missing', 'Referenced token does not exist.', `${path}.tokenId`, value.tokenId);
  else if (token !== undefined && category !== undefined && token.category !== category) {
    addDiagnostic(ds, 'token.category', `Expected a ${category} token, received ${token.category}.`, `${path}.tokenId`, value.tokenId);
  }
  return value.kind === 'token' && typeof value.tokenId === 'string';
}
export function validateMeasure(value: unknown, path: string, ds: Diagnostic[], tokens: TokenIndex, category: DesignToken['category']): value is Measure {
  if (!exact(value, ['kind', 'value', 'unit', 'tokenId'], path, ds)) return false;
  if (value.kind === 'token') return validateTokenReference(value, tokens, path, ds, category);
  if (value.kind !== 'literal') {
    addDiagnostic(ds, 'measure.kind', 'Measure kind must be literal or token.', `${path}.kind`);
    return false;
  }
  let valid = finite(value.value, `${path}.value`, ds, 0);
  if (value.unit !== 'px') {
    addDiagnostic(ds, 'measure.unit', 'Only logical pixel measures are supported.', `${path}.unit`);
    valid = false;
  }
  return valid;
}
export function validateSizing(value: unknown, path: string, ds: Diagnostic[], tokens: TokenIndex): boolean {
  if (!isRecord(value)) {
    addDiagnostic(ds, 'sizing.object', 'Expected a sizing object.', path);
    return false;
  }
  const kind = value.kind;
  const allowed = kind === 'fixed' ? ['kind', 'value'] : ['kind', 'min', 'max'];
  exact(value, allowed, path, ds);
  let valid = kind === 'fixed' || kind === 'fill' || kind === 'hug';
  if (!valid) addDiagnostic(ds, 'sizing.kind', 'Sizing kind must be fixed, fill, or hug.', `${path}.kind`);
  if (kind === 'fixed') valid = validateMeasure(value.value, `${path}.value`, ds, tokens, 'spacing') && valid;
  if ((kind === 'fill' || kind === 'hug') && value.min !== undefined) valid = validateMeasure(value.min, `${path}.min`, ds, tokens, 'spacing') && valid;
  if ((kind === 'fill' || kind === 'hug') && value.max !== undefined) valid = validateMeasure(value.max, `${path}.max`, ds, tokens, 'spacing') && valid;
  return valid;
}
export function validateConstraints(value: unknown, path: string, ds: Diagnostic[], tokens: TokenIndex): boolean {
  if (!exact(value, ['left', 'right', 'top', 'bottom', 'centerX', 'centerY'], path, ds)) return false;
  let valid = true;
  for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
    if (value[edge] !== undefined) valid = validateMeasure(value[edge], `${path}.${edge}`, ds, tokens, 'spacing') && valid;
  }
  for (const center of ['centerX', 'centerY'] as const) {
    if (value[center] !== undefined && typeof value[center] !== 'boolean') {
      addDiagnostic(ds, 'constraint.boolean', 'Center constraint must be boolean.', `${path}.${center}`);
      valid = false;
    }
  }
  if (value.left !== undefined && value.right !== undefined && value.centerX === true) {
    addDiagnostic(ds, 'constraint.horizontal-conflict', 'Left/right and centerX cannot all constrain one axis.', path);
    valid = false;
  }
  if (value.top !== undefined && value.bottom !== undefined && value.centerY === true) {
    addDiagnostic(ds, 'constraint.vertical-conflict', 'Top/bottom and centerY cannot all constrain one axis.', path);
    valid = false;
  }
  return valid;
}
export function validateLayout(value: unknown, path: string, ds: Diagnostic[], tokens: TokenIndex): value is Layout {
  if (!exact(value, ['mode', 'position', 'width', 'height', 'align', 'justify', 'gap', 'padding'], path, ds)) return false;
  let valid = ['horizontal', 'vertical', 'free'].includes(String(value.mode));
  if (!valid) addDiagnostic(ds, 'layout.mode', 'Layout mode is invalid.', `${path}.mode`);
  if (value.position !== undefined) {
    if (!exact(value.position, ['x', 'y'], `${path}.position`, ds)) valid = false;
    else {
      valid = finite(value.position.x, `${path}.position.x`, ds) && valid;
      valid = finite(value.position.y, `${path}.position.y`, ds) && valid;
    }
  }
  valid = validateSizing(value.width, `${path}.width`, ds, tokens) && valid;
  valid = validateSizing(value.height, `${path}.height`, ds, tokens) && valid;
  if (!['start', 'center', 'end', 'stretch'].includes(String(value.align))) {
    addDiagnostic(ds, 'layout.align', 'Layout alignment is invalid.', `${path}.align`);
    valid = false;
  }
  if (!['start', 'center', 'end', 'space-between'].includes(String(value.justify))) {
    addDiagnostic(ds, 'layout.justify', 'Layout justification is invalid.', `${path}.justify`);
    valid = false;
  }
  valid = validateMeasure(value.gap, `${path}.gap`, ds, tokens, 'spacing') && valid;
  if (!exact(value.padding, ['top', 'right', 'bottom', 'left'], `${path}.padding`, ds)) valid = false;
  else {
    for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
      valid = validateMeasure(value.padding[edge], `${path}.padding.${edge}`, ds, tokens, 'spacing') && valid;
    }
  }
  return valid;
}
export function validateColor(value: unknown, path: string, ds: Diagnostic[], tokens: TokenIndex, allowForwardReference = false): boolean {
  if (isRecord(value) && value.kind === 'token') return validateTokenReference(value, tokens, path, ds, 'color', allowForwardReference);
  if (!exact(value, ['kind', 'value'], path, ds)) return false;
  if (value.kind !== 'literal' || typeof value.value !== 'string' || !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value.value)) {
    addDiagnostic(ds, 'color.value', 'Color must be a #RRGGBB or #RRGGBBAA literal.', path);
    return false;
  }
  return true;
}
export function validateStyle(value: unknown, path: string, ds: Diagnostic[], tokens: TokenIndex): boolean {
  if (!exact(value, ['fill', 'textColor', 'radius', 'opacity', 'shadowTokenId'], path, ds)) return false;
  let valid = true;
  for (const key of ['fill', 'textColor'] as const) {
    if (value[key] !== undefined) valid = validateColor(value[key], `${path}.${key}`, ds, tokens) && valid;
  }
  if (value.radius !== undefined) valid = validateMeasure(value.radius, `${path}.radius`, ds, tokens, 'radius') && valid;
  if (value.opacity !== undefined) {
    valid = finite(value.opacity, `${path}.opacity`, ds, 0) && valid;
    if (typeof value.opacity === 'number' && value.opacity > 1) {
      addDiagnostic(ds, 'style.opacity', 'Opacity must not exceed 1.', `${path}.opacity`);
      valid = false;
    }
  }
  if (value.shadowTokenId !== undefined) {
    const token = tokens.get(String(value.shadowTokenId));
    if (token?.category !== 'shadow') {
      addDiagnostic(ds, 'token.category', 'shadowTokenId must reference a shadow token.', `${path}.shadowTokenId`);
      valid = false;
    }
  }
  return valid;
}
export function validateTextStyle(value: unknown, path: string, ds: Diagnostic[], tokens: TokenIndex): boolean {
  if (!exact(value, ['typographyTokenId', 'fontSize', 'weight', 'lineHeight', 'align'], path, ds)) return false;
  let valid = true;
  if (value.typographyTokenId !== undefined) {
    const token = tokens.get(String(value.typographyTokenId));
    if (token?.category !== 'typography') {
      addDiagnostic(ds, 'token.category', 'typographyTokenId must reference a typography token.', `${path}.typographyTokenId`);
      valid = false;
    }
  }
  if (value.fontSize !== undefined) valid = validateMeasure(value.fontSize, `${path}.fontSize`, ds, tokens, 'typography') && valid;
  if (value.weight !== undefined) {
    valid = finite(value.weight, `${path}.weight`, ds, 1) && valid;
    if (typeof value.weight === 'number' && value.weight > 1000) valid = false;
  }
  if (value.lineHeight !== undefined) valid = finite(value.lineHeight, `${path}.lineHeight`, ds, Number.MIN_VALUE) && valid;
  if (value.align !== undefined && !['start', 'center', 'end'].includes(String(value.align))) {
    addDiagnostic(ds, 'text.align', 'Text alignment is invalid.', `${path}.align`);
    valid = false;
  }
  return valid;
}
export function validateToken(value: unknown, path: string, ds: Diagnostic[]): value is DesignToken {
  if (!isRecord(value)) {
    addDiagnostic(ds, 'token.object', 'Token must be an object.', path);
    return false;
  }
  const base = ['id', 'name', 'category', 'value'];
  if (!hasOnlyKeys(value, base, path, ds)) return false;
  let valid = stringField(value.id, `${path}.id`, ds) && stringField(value.name, `${path}.name`, ds);
  const category = value.category;
  if (typeof category !== 'string' || !TOKEN_CATEGORIES.includes(category)) {
    addDiagnostic(ds, 'token.category', 'Unknown token category.', `${path}.category`);
    return false;
  }
  const v = value.value;
  const finiteMin = (x: unknown, field: string, min = 0) => finite(x, `${path}.value.${field}`, ds, min);
  switch (category) {
    case 'color':
      if (!exact(v, ['hex', 'alpha'], `${path}.value`, ds)) valid = false;
      else {
        if (typeof v.hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v.hex)) valid = false;
        if (v.alpha !== undefined && (!finite(v.alpha, `${path}.value.alpha`, ds, 0) || v.alpha > 1)) valid = false;
      }
      break;
    case 'typography':
      if (!exact(v, ['fontFamily', 'fontSizePx', 'weight', 'lineHeight', 'letterSpacingPx'], `${path}.value`, ds)) valid = false;
      else {
        valid = stringField(v.fontFamily, `${path}.value.fontFamily`, ds) && valid;
        valid = finiteMin(v.fontSizePx, 'fontSizePx', Number.MIN_VALUE) && valid;
        valid = finiteMin(v.weight, 'weight', 1) && valid;
        valid = finiteMin(v.lineHeight, 'lineHeight', Number.MIN_VALUE) && valid;
        if (v.letterSpacingPx !== undefined) valid = finite(v.letterSpacingPx, `${path}.value.letterSpacingPx`, ds) && valid;
        if (typeof v.weight === 'number' && v.weight > 1000) valid = false;
      }
      break;
    case 'spacing':
    case 'radius':
    case 'breakpoint':
      if (!exact(v, ['valuePx'], `${path}.value`, ds)) valid = false;
      else valid = finiteMin(v.valuePx, 'valuePx') && valid;
      break;
    case 'shadow':
      if (!exact(v, ['xPx', 'yPx', 'blurPx', 'spreadPx', 'color'], `${path}.value`, ds)) valid = false;
      else {
        valid = finite(v.xPx, `${path}.value.xPx`, ds) && valid;
        valid = finite(v.yPx, `${path}.value.yPx`, ds) && valid;
        valid = finiteMin(v.blurPx, 'blurPx') && valid;
        valid = finite(v.spreadPx, `${path}.value.spreadPx`, ds) && valid;
        valid = validateColor(v.color, `${path}.value.color`, ds, new Map(), true) && valid;
      }
      break;
    case 'motion':
      if (!exact(v, ['durationMs', 'easing'], `${path}.value`, ds)) valid = false;
      else {
        valid = finiteMin(v.durationMs, 'durationMs') && valid;
        if (!['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out'].includes(String(v.easing))) valid = false;
      }
      break;
    case 'z-index':
      if (!exact(v, ['order'], `${path}.value`, ds)) valid = false;
      else if (!isNonNegativeInteger(v.order)) {
        addDiagnostic(ds, 'token.value', 'z-index order must be a non-negative safe integer.', `${path}.value.order`);
        valid = false;
      }
      break;
  }
  return valid;
}
export function validateResponsive(value: unknown, path: string, ds: Diagnostic[], tokens: TokenIndex): value is ResponsiveRule[] {
  if (!Array.isArray(value)) {
    addDiagnostic(ds, 'responsive.array', 'Responsive rules must be an array.', path);
    return false;
  }
  let valid = true;
  const collisionKeys = new Set<string>();
  value.forEach((entry, index) => {
    const rulePath = `${path}[${index}]`;
    if (!exact(entry, ['id', 'breakpointTokenId', 'priority', 'overrides'], rulePath, ds)) {
      valid = false;
      return;
    }
    valid = stringField(entry.id, `${rulePath}.id`, ds) && valid;
    const token = tokens.get(String(entry.breakpointTokenId));
    if (token?.category !== 'breakpoint') {
      addDiagnostic(ds, 'responsive.breakpoint', 'Rule requires a breakpoint token.', `${rulePath}.breakpointTokenId`);
      valid = false;
    }
    if (!Number.isSafeInteger(entry.priority)) {
      addDiagnostic(ds, 'responsive.priority', 'Priority must be a safe integer.', `${rulePath}.priority`);
      valid = false;
    }
    if (!exact(entry.overrides, ['layout', 'visible'], `${rulePath}.overrides`, ds)) {
      valid = false;
      return;
    }
    const fields: string[] = [];
    if (entry.overrides.visible !== undefined) {
      fields.push('visible');
      if (typeof entry.overrides.visible !== 'boolean') valid = false;
    }
    if (entry.overrides.layout !== undefined) {
      fields.push(...(isRecord(entry.overrides.layout) ? Object.keys(entry.overrides.layout).map((key) => `layout.${key}`) : ['layout']));
    }
    for (const field of fields) {
      const key = `${entry.breakpointTokenId}:${entry.priority}:${field}`;
      if (collisionKeys.has(key)) {
        addDiagnostic(ds, 'responsive.conflict', 'Rules at the same breakpoint and priority cannot override the same field.', rulePath);
        valid = false;
      }
      collisionKeys.add(key);
    }
  });
  return valid;
}
export function validateNode(node: unknown, path: string, ds: Diagnostic[], tokens: TokenIndex): node is DesignNode {
  if (!isRecord(node)) {
    addDiagnostic(ds, 'node.object', 'Node must be an object.', path);
    return false;
  }
  const kind = node.kind;
  const extra = kind === 'text' ? ['text', 'textStyle']
    : kind === 'image' ? ['assetId', 'fit']
      : kind === 'icon' ? ['libraryId', 'iconName']
        : kind === 'vector' ? ['pathData', 'viewBox']
          : kind === 'component-instance' ? ['componentId', 'variantId', 'propertyOverrides', 'nodeOverrides', 'slotChildren']
            : [];
  if (!['frame', 'group', 'text', 'image', 'icon', 'vector', 'component-instance'].includes(String(kind))) {
    addDiagnostic(ds, 'node.kind', 'Unsupported node kind.', `${path}.kind`);
    return false;
  }
  let valid = hasOnlyKeys(node, [...NODE_BASE_KEYS, 'kind', ...extra], path, ds);
  valid = stringField(node.id, `${path}.id`, ds) && valid;
  valid = stringField(node.name, `${path}.name`, ds) && valid;
  if (!Array.isArray(node.childIds)) {
    addDiagnostic(ds, 'node.children', 'childIds must be an array.', `${path}.childIds`);
    valid = false;
  } else node.childIds.forEach((id, index) => { if (!stringField(id, `${path}.childIds[${index}]`, ds)) valid = false; });
  if (typeof node.visible !== 'boolean') {
    addDiagnostic(ds, 'node.visible', 'visible must be boolean.', `${path}.visible`);
    valid = false;
  }
  valid = validateLayout(node.layout, `${path}.layout`, ds, tokens) && valid;
  valid = validateConstraints(node.constraints, `${path}.constraints`, ds, tokens) && valid;
  valid = validateStyle(node.style, `${path}.style`, ds, tokens) && valid;
  valid = validateResponsive(node.responsive, `${path}.responsive`, ds, tokens) && valid;
  if ((kind === 'frame' || kind === 'group') && node.childIds !== undefined) {
    // containers are the only ordinary nodes allowed to own childIds
  } else if (kind !== 'component-instance' && Array.isArray(node.childIds) && node.childIds.length > 0) {
    addDiagnostic(ds, 'node.leaf-children', 'Leaf nodes cannot own child nodes.', `${path}.childIds`);
    valid = false;
  }
  if (kind === 'text') {
    valid = stringField(node.text, `${path}.text`, ds, true) && valid;
    valid = validateTextStyle(node.textStyle, `${path}.textStyle`, ds, tokens) && valid;
  } else if (kind === 'image') {
    valid = stringField(node.assetId, `${path}.assetId`, ds) && valid;
    if (!['cover', 'contain', 'fill'].includes(String(node.fit))) valid = false;
  } else if (kind === 'icon') {
    valid = stringField(node.libraryId, `${path}.libraryId`, ds) && valid;
    valid = stringField(node.iconName, `${path}.iconName`, ds) && valid;
  } else if (kind === 'vector') {
    valid = stringField(node.pathData, `${path}.pathData`, ds) && valid;
    if (!Array.isArray(node.viewBox) || node.viewBox.length !== 4 || node.viewBox.some((n) => !isFiniteNumber(n))) {
      addDiagnostic(ds, 'vector.viewbox', 'viewBox must contain four finite numbers.', `${path}.viewBox`);
      valid = false;
    }
  } else if (kind === 'component-instance') {
    valid = stringField(node.componentId, `${path}.componentId`, ds) && valid;
    valid = stringField(node.variantId, `${path}.variantId`, ds) && valid;
    for (const field of ['propertyOverrides', 'nodeOverrides', 'slotChildren'] as const) {
      if (!isRecord(node[field])) {
        addDiagnostic(ds, field === 'nodeOverrides' ? 'component.instance-nodes' : 'component.record', `${field} must be an object.`, `${path}.${field}`);
        valid = false;
      }
    }
  }
  return valid;
}
