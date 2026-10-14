import type { ComponentDefinition, DesignToken, Diagnostic, TokenReference } from './types.js';
import { addDiagnostic, getOwnValue, isFiniteNumber, isNonNegativeInteger, isRecord } from './validation-utils.js';
import { exact, NODE_BASE_KEYS, stringField, validateConstraints, validateLayout, validateResponsive, validateStyle, validateTextStyle } from './document-shapes.js';

const tokenCategories: readonly DesignToken['category'][] = ['color', 'typography', 'spacing', 'radius', 'shadow', 'breakpoint', 'motion', 'z-index'];
const templateKinds = ['frame', 'group', 'text', 'image', 'icon', 'vector'] as const;

function record(value: unknown, code: string, message: string, path: string, ds: Diagnostic[]): value is Record<string, unknown> {
  if (isRecord(value)) return true;
  addDiagnostic(ds, code, message, path);
  return false;
}

function stringList(value: unknown, path: string, ds: Diagnostic[]): value is string[] {
  if (!Array.isArray(value)) {
    addDiagnostic(ds, 'component.array', 'Expected an array of strings.', path);
    return false;
  }
  let valid = true;
  value.forEach((item, index) => { if (!stringField(item, `${path}[${index}]`, ds)) valid = false; });
  return valid;
}

function validateDefinitionShape(value: unknown, path: string, tokens: Map<string, DesignToken>, ds: Diagnostic[]): value is ComponentDefinition {
  if (!record(value, 'component.definition', 'Component definition must be an object.', path, ds)) return false;
  exact(value, ['id', 'name', 'rootTemplateNodeId', 'templateNodes', 'properties', 'variants', 'slots'], path, ds);
  stringField(value.id, `${path}.id`, ds);
  stringField(value.name, `${path}.name`, ds);
  stringField(value.rootTemplateNodeId, `${path}.rootTemplateNodeId`, ds);
  let valid = true;
  for (const field of ['templateNodes', 'properties', 'variants', 'slots']) {
    if (!isRecord(value[field])) {
      addDiagnostic(ds, 'component.record', `${field} must be an object.`, `${path}.${field}`);
      valid = false;
    }
  }
  if (!valid) return false;
  const templates = value.templateNodes as Record<string, unknown>;
  for (const [templateId, template] of Object.entries(templates)) validateTemplate(template, templateId, `${path}.templateNodes.${templateId}`, tokens, ds);
  return true;
}

function validateTemplate(value: unknown, templateId: string, path: string, tokens: Map<string, DesignToken>, ds: Diagnostic[]): void {
  if (!record(value, 'component.template', 'Template node must be an object.', path, ds)) return;
  const kind = value.kind;
  if (!templateKinds.includes(kind as typeof templateKinds[number])) {
    addDiagnostic(ds, 'component.template-kind', 'Template node kind must be a supported non-component node kind.', `${path}.kind`);
    return;
  }
  const specific = kind === 'text' ? ['text', 'textStyle'] : kind === 'image' ? ['assetId', 'fit'] : kind === 'icon' ? ['libraryId', 'iconName'] : kind === 'vector' ? ['pathData', 'viewBox'] : [];
  exact(value, [...NODE_BASE_KEYS.filter((key) => key !== 'id' && key !== 'childIds'), 'templateNodeId', 'childTemplateNodeIds', 'kind', ...specific], path, ds);
  if (value.templateNodeId !== templateId) addDiagnostic(ds, 'component.template-id', 'Template key must match templateNodeId.', `${path}.templateNodeId`);
  stringField(value.name, `${path}.name`, ds);
  stringList(value.childTemplateNodeIds, `${path}.childTemplateNodeIds`, ds);
  if (typeof value.visible !== 'boolean') addDiagnostic(ds, 'component.template-visible', 'Template visible must be boolean.', `${path}.visible`);
  validateLayout(value.layout, `${path}.layout`, ds, tokens);
  validateConstraints(value.constraints, `${path}.constraints`, ds, tokens);
  validateStyle(value.style, `${path}.style`, ds, tokens);
  if (!validateResponsive(value.responsive, `${path}.responsive`, ds, tokens)) addDiagnostic(ds, 'component.template-responsive', 'Template responsive rules are invalid.', `${path}.responsive`);
  if (kind !== 'frame' && kind !== 'group' && Array.isArray(value.childTemplateNodeIds) && value.childTemplateNodeIds.length) addDiagnostic(ds, 'component.template-leaf', 'Leaf template nodes cannot own children.', `${path}.childTemplateNodeIds`);
  if (kind === 'text') {
    stringField(value.text, `${path}.text`, ds, true);
    if (!validateTextStyle(value.textStyle, `${path}.textStyle`, ds, tokens)) addDiagnostic(ds, 'component.template-text-style', 'Template text style is invalid.', `${path}.textStyle`);
  } else if (kind === 'image') {
    stringField(value.assetId, `${path}.assetId`, ds);
    if (!['cover', 'contain', 'fill'].includes(String(value.fit))) addDiagnostic(ds, 'component.template-fit', 'Image fit must be cover, contain, or fill.', `${path}.fit`);
  } else if (kind === 'icon') {
    stringField(value.libraryId, `${path}.libraryId`, ds);
    stringField(value.iconName, `${path}.iconName`, ds);
  } else if (kind === 'vector') {
    stringField(value.pathData, `${path}.pathData`, ds);
    if (!Array.isArray(value.viewBox) || value.viewBox.length !== 4 || value.viewBox.some((part) => !isFiniteNumber(part))) addDiagnostic(ds, 'component.template-viewbox', 'Vector viewBox must contain four finite numbers.', `${path}.viewBox`);
  }
}

function validateConstraintsShape(value: unknown, type: string, path: string, tokens: Map<string, DesignToken>, ds: Diagnostic[]): void {
  if (value === undefined) return;
  if (!record(value, 'component.constraints', 'Property constraints must be an object.', path, ds)) return;
  exact(value, ['min', 'max', 'enum', 'tokenCategory'], path, ds);
  if (value.min !== undefined && !isFiniteNumber(value.min)) addDiagnostic(ds, 'component.constraint-min', 'Minimum must be a finite number.', `${path}.min`);
  if (value.max !== undefined && !isFiniteNumber(value.max)) addDiagnostic(ds, 'component.constraint-max', 'Maximum must be a finite number.', `${path}.max`);
  if (isFiniteNumber(value.min) && isFiniteNumber(value.max) && value.min > value.max) addDiagnostic(ds, 'component.constraint-range', 'Minimum cannot exceed maximum.', path);
  if ((value.min !== undefined || value.max !== undefined) && type !== 'number') addDiagnostic(ds, 'component.constraint-type', 'Minimum and maximum constraints require a number property.', path);
  if (value.tokenCategory !== undefined && !tokenCategories.includes(value.tokenCategory as DesignToken['category'])) addDiagnostic(ds, 'component.constraint-category', 'Token category constraint is unsupported.', `${path}.tokenCategory`);
  if (value.tokenCategory !== undefined && type !== 'token') addDiagnostic(ds, 'component.constraint-type', 'tokenCategory requires a token property.', `${path}.tokenCategory`);
  if (value.enum !== undefined && !Array.isArray(value.enum)) addDiagnostic(ds, 'component.constraint-enum', 'Enum constraint must be an array.', `${path}.enum`);
  if (Array.isArray(value.enum)) value.enum.forEach((candidate, index) => {
    const candidatePath = `${path}.enum[${index}]`;
    if (!propertyValueShapeMatches(candidate, type)) addDiagnostic(ds, 'component.constraint-enum-value', `Enum value must match the declared ${type} property type.`, candidatePath);
    else if (type === 'token') validPropertyValue(candidate, type, candidatePath, tokens, ds, value.tokenCategory === undefined ? undefined : { tokenCategory: value.tokenCategory });
  });
}

function validateNodeOverride(value: unknown, template: Record<string, unknown>, path: string, tokens: Map<string, DesignToken>, ds: Diagnostic[]): void {
  if (!record(value, 'component.node-override', 'Node override must be an object.', path, ds)) return;
  exact(value, ['text', 'visible', 'style', 'textStyle'], path, ds);
  if (value.text !== undefined) {
    if (template.kind !== 'text') addDiagnostic(ds, 'component.override-incompatible', 'Text overrides require a text template node.', `${path}.text`);
    if (typeof value.text !== 'string') addDiagnostic(ds, 'component.override-text', 'Text override must be a string.', `${path}.text`);
  }
  if (value.visible !== undefined && typeof value.visible !== 'boolean') addDiagnostic(ds, 'component.override-visible', 'Visible override must be boolean.', `${path}.visible`);
  if (value.style !== undefined) validateStyle(value.style, `${path}.style`, ds, tokens);
  if (value.textStyle !== undefined) {
    if (template.kind !== 'text') addDiagnostic(ds, 'component.override-incompatible', 'Text style overrides require a text template node.', `${path}.textStyle`);
    if (!validateTextStyle(value.textStyle, `${path}.textStyle`, ds, tokens)) addDiagnostic(ds, 'component.override-text-style', 'Override text style is invalid.', `${path}.textStyle`);
  }
}

function validateBindingConflict(target: string, property: 'text' | 'visible', overrides: unknown, path: string, ds: Diagnostic[]): void {
  if (!isRecord(overrides)) return;
  const direct = overrides[target];
  if (isRecord(direct) && direct[property] !== undefined) addDiagnostic(ds, 'component.binding-conflict', 'A directly overridden field cannot also receive a bound property.', `${path}.${target}.${property}`);
}

export function validateComponents(doc: Record<string, unknown>, ds: Diagnostic[]): void {
  const components = isRecord(doc.components) ? doc.components : {};
  const nodes = isRecord(doc.nodes) ? doc.nodes : {};
  const tokens = new Map<string, DesignToken>(Object.entries(isRecord(doc.tokens) ? doc.tokens : {}).filter((entry): entry is [string, DesignToken] => isRecord(entry[1]) && typeof entry[1].category === 'string') as [string, DesignToken][]);

  for (const [componentId, raw] of Object.entries(components)) {
    const path = `components.${componentId}`;
    if (!validateDefinitionShape(raw, path, tokens, ds)) continue;
    const definition = raw as unknown as ComponentDefinition;
    if (definition.id !== componentId) addDiagnostic(ds, 'component.id', 'Component record key must match id.', `${path}.id`);
    const templates = definition.templateNodes as Record<string, unknown>;
    if (typeof definition.rootTemplateNodeId !== 'string' || !Object.hasOwn(templates, definition.rootTemplateNodeId)) addDiagnostic(ds, 'component.root', 'Root template node must identify an existing template node.', `${path}.rootTemplateNodeId`);

    const parentCount = new Map<string, number>();
    for (const [templateId, template] of Object.entries(templates)) {
      if (!isRecord(template) || !Array.isArray(template.childTemplateNodeIds)) continue;
      for (const child of template.childTemplateNodeIds) if (typeof child === 'string') parentCount.set(child, (parentCount.get(child) ?? 0) + 1);
      for (const child of template.childTemplateNodeIds) if (typeof child !== 'string' || !Object.hasOwn(templates, child)) addDiagnostic(ds, 'component.template-child', 'Template child must reference an existing template node.', `${path}.templateNodes.${templateId}.childTemplateNodeIds`);
    }
    for (const [id, count] of parentCount) {
      if (count > 1) addDiagnostic(ds, 'component.template-owner', 'Template node has multiple owners.', `${path}.templateNodes.${id}`);
      if (id === definition.rootTemplateNodeId && count > 0) addDiagnostic(ds, 'component.template-root-owner', 'Root template node cannot have a parent.', `${path}.templateNodes.${id}`);
    }
    for (const templateId of Object.keys(templates)) if (templateId !== definition.rootTemplateNodeId && parentCount.get(templateId) !== 1) addDiagnostic(ds, 'component.template-unowned', 'Every non-root template node must have exactly one parent.', `${path}.templateNodes.${templateId}`);

    for (const [propertyName, rawProperty] of Object.entries(definition.properties as Record<string, unknown>)) {
      const propertyPath = `${path}.properties.${propertyName}`;
      if (!record(rawProperty, 'component.property', 'Property definition must be an object.', propertyPath, ds)) continue;
      exact(rawProperty, ['type', 'required', 'defaultValue', 'binding', 'constraints'], propertyPath, ds);
      const type = rawProperty.type;
      if (!['string', 'number', 'boolean', 'token'].includes(String(type))) { addDiagnostic(ds, 'component.property-type', 'Property type must be string, number, boolean, or token.', `${propertyPath}.type`); continue; }
      if (typeof rawProperty.required !== 'boolean') addDiagnostic(ds, 'component.property-required', 'Property required flag must be boolean.', `${propertyPath}.required`);
      validateConstraintsShape(rawProperty.constraints, String(type), `${propertyPath}.constraints`, tokens, ds);
      if (rawProperty.defaultValue !== undefined) validPropertyValue(rawProperty.defaultValue, String(type), `${propertyPath}.defaultValue`, tokens, ds, rawProperty.constraints);
      if (rawProperty.binding !== undefined) {
        if (!record(rawProperty.binding, 'component.binding', 'Property binding must be an object.', `${propertyPath}.binding`, ds)) continue;
        exact(rawProperty.binding, ['templateNodeId', 'property'], `${propertyPath}.binding`, ds);
        const targetId = rawProperty.binding.templateNodeId;
        const targetProperty = rawProperty.binding.property;
        if (typeof targetId !== 'string' || !isRecord(templates[targetId])) { addDiagnostic(ds, 'component.binding-node', 'Property binding target must identify an existing template node.', `${propertyPath}.binding.templateNodeId`); continue; }
        if ((type === 'string' && (targetProperty !== 'text' || templates[targetId]?.kind !== 'text')) || (type === 'boolean' && targetProperty !== 'visible') || !['string', 'boolean'].includes(String(type))) addDiagnostic(ds, 'component.binding-type', 'Only string-to-text and boolean-to-visible bindings are supported.', `${propertyPath}.binding`);
        if (targetProperty === 'text' || targetProperty === 'visible') {
          for (const [variantId, variant] of Object.entries(definition.variants as Record<string, unknown>)) if (isRecord(variant)) validateBindingConflict(targetId, targetProperty, variant.nodeOverrides, `${path}.variants.${variantId}.nodeOverrides`, ds);
          for (const [nodeId, node] of Object.entries(nodes)) if (isRecord(node) && node.kind === 'component-instance' && node.componentId === componentId && isRecord(node.nodeOverrides)) validateBindingConflict(targetId, targetProperty, node.nodeOverrides, `nodes.${nodeId}.nodeOverrides`, ds);
        }
      }
    }

    for (const [variantId, rawVariant] of Object.entries(definition.variants as Record<string, unknown>)) {
      const variantPath = `${path}.variants.${variantId}`;
      if (!record(rawVariant, 'component.variant-shape', 'Variant must be an object.', variantPath, ds)) continue;
      exact(rawVariant, ['id', 'name', 'propertyOverrides', 'nodeOverrides'], variantPath, ds);
      if (rawVariant.id !== variantId) addDiagnostic(ds, 'component.variant-id', 'Variant key must match its id.', `${variantPath}.id`);
      stringField(rawVariant.name, `${variantPath}.name`, ds);
      const propertyOverrides = record(rawVariant.propertyOverrides, 'component.variant-properties', 'Variant propertyOverrides must be an object.', `${variantPath}.propertyOverrides`, ds) ? rawVariant.propertyOverrides : {};
      for (const [propertyName, value] of Object.entries(propertyOverrides)) {
        const property = definition.properties[propertyName];
        if (property === undefined) addDiagnostic(ds, 'component.unknown-property', 'Variant refers to an unknown property.', `${variantPath}.propertyOverrides.${propertyName}`);
        else validPropertyValue(value, property.type, `${variantPath}.propertyOverrides.${propertyName}`, tokens, ds, property.constraints);
      }
      const nodeOverrides = record(rawVariant.nodeOverrides, 'component.variant-nodes', 'Variant nodeOverrides must be an object.', `${variantPath}.nodeOverrides`, ds) ? rawVariant.nodeOverrides : {};
      for (const [target, override] of Object.entries(nodeOverrides)) {
        const template = templates[target];
        if (!isRecord(template)) { addDiagnostic(ds, 'component.override-node', 'Variant override target must identify an existing template node.', `${variantPath}.nodeOverrides.${target}`); continue; }
        validateNodeOverride(override, template, `${variantPath}.nodeOverrides.${target}`, tokens, ds);
      }
    }

    for (const [slotId, rawSlot] of Object.entries(definition.slots as Record<string, unknown>)) {
      const slotPath = `${path}.slots.${slotId}`;
      if (!record(rawSlot, 'component.slot-shape', 'Slot must be an object.', slotPath, ds)) continue;
      exact(rawSlot, ['id', 'name', 'templateAnchorNodeId', 'allowedKinds', 'minItems', 'maxItems'], slotPath, ds);
      if (rawSlot.id !== slotId) addDiagnostic(ds, 'component.slot-id', 'Slot key must match its id.', `${slotPath}.id`);
      stringField(rawSlot.name, `${slotPath}.name`, ds);
      if (typeof rawSlot.templateAnchorNodeId !== 'string' || !isRecord(templates[rawSlot.templateAnchorNodeId])) addDiagnostic(ds, 'component.slot-anchor', 'Slot anchor must identify an existing template node.', `${slotPath}.templateAnchorNodeId`);
      if (!Array.isArray(rawSlot.allowedKinds) || rawSlot.allowedKinds.some((kind) => !['frame', 'group', 'text', 'image', 'icon', 'vector'].includes(String(kind)))) addDiagnostic(ds, 'component.slot-kinds', 'Slot allowedKinds must contain supported node kinds.', `${slotPath}.allowedKinds`);
      if (!isNonNegativeInteger(rawSlot.minItems)) addDiagnostic(ds, 'component.slot-min', 'Slot minItems must be a non-negative integer.', `${slotPath}.minItems`);
      if (rawSlot.maxItems !== undefined && (!isNonNegativeInteger(rawSlot.maxItems) || (isNonNegativeInteger(rawSlot.minItems) && rawSlot.maxItems < rawSlot.minItems))) addDiagnostic(ds, 'component.slot-max', 'Slot maxItems must be a non-negative integer at least minItems.', `${slotPath}.maxItems`);
    }

    validateTemplateCycles(definition, componentId, ds);
  }

  for (const [nodeId, rawNode] of Object.entries(nodes)) {
    if (!isRecord(rawNode) || rawNode.kind !== 'component-instance') continue;
    const path = `nodes.${nodeId}`;
    const componentId = rawNode.componentId;
    if (typeof componentId !== 'string' || !isRecord(components[componentId])) { addDiagnostic(ds, 'component.missing', 'Instance component definition is missing or malformed.', `${path}.componentId`, typeof componentId === 'string' ? componentId : undefined); continue; }
    const def = components[componentId] as unknown as ComponentDefinition;
    const variantId = rawNode.variantId;
    const variant = typeof variantId === 'string' && isRecord(def.variants) && isRecord(def.variants[variantId]) ? def.variants[variantId] : undefined;
    if (!variant) addDiagnostic(ds, 'component.variant', 'Instance variant does not exist or is malformed.', `${path}.variantId`, nodeId);
    const propertyOverrides = record(rawNode.propertyOverrides, 'component.instance-properties', 'Instance propertyOverrides must be an object.', `${path}.propertyOverrides`, ds) ? rawNode.propertyOverrides : {};
    const nodeOverrides = record(rawNode.nodeOverrides, 'component.instance-nodes', 'Instance nodeOverrides must be an object.', `${path}.nodeOverrides`, ds) ? rawNode.nodeOverrides : {};
    const slotChildren = record(rawNode.slotChildren, 'component.instance-slots', 'Instance slotChildren must be an object.', `${path}.slotChildren`, ds) ? rawNode.slotChildren : {};
    for (const [propertyName, value] of Object.entries(propertyOverrides)) {
      const property = isRecord(def.properties) ? def.properties[propertyName] : undefined;
      if (!property) addDiagnostic(ds, 'component.unknown-property', 'Instance overrides an undeclared property.', `${path}.propertyOverrides.${propertyName}`, nodeId);
      else validPropertyValue(value, property.type, `${path}.propertyOverrides.${propertyName}`, tokens, ds, property.constraints);
    }
    for (const [propertyName, rawProperty] of Object.entries(isRecord(def.properties) ? def.properties : {})) {
      if (!isRecord(rawProperty)) continue;
      const variantValue = isRecord(variant?.propertyOverrides) ? getOwnValue(variant.propertyOverrides, propertyName) : undefined;
      const instanceValue = getOwnValue(propertyOverrides, propertyName);
      if (rawProperty.required && rawProperty.defaultValue === undefined && variantValue === undefined && instanceValue === undefined) addDiagnostic(ds, 'component.required-property', 'Required property has no instance, variant, or default value.', `${path}.propertyOverrides.${propertyName}`, nodeId);
    }
    for (const [target, override] of Object.entries(nodeOverrides)) {
      const template = isRecord(def.templateNodes) ? def.templateNodes[target] : undefined;
      if (!isRecord(template)) { addDiagnostic(ds, 'component.override-node', 'Instance override target must identify an existing template node.', `${path}.nodeOverrides.${target}`, nodeId); continue; }
      validateNodeOverride(override, template, `${path}.nodeOverrides.${target}`, tokens, ds);
    }
    for (const [slotId, childrenRaw] of Object.entries(slotChildren)) {
      const slot = isRecord(def.slots) ? def.slots[slotId] : undefined;
      if (!isRecord(slot)) { addDiagnostic(ds, 'component.slot-missing', 'Instance uses an undeclared slot.', `${path}.slotChildren.${slotId}`, nodeId); continue; }
      if (!Array.isArray(childrenRaw)) { addDiagnostic(ds, 'component.slot-children', 'Slot children must be an array of node IDs.', `${path}.slotChildren.${slotId}`, nodeId); continue; }
    }
    for (const [slotId, slot] of Object.entries(isRecord(def.slots) ? def.slots : {})) {
      if (!isRecord(slot)) continue;
      const children = getOwnValue(slotChildren, slotId) ?? [];
      if (!Array.isArray(children)) continue;
      if (children.length < (isNonNegativeInteger(slot.minItems) ? slot.minItems : 0) || (isNonNegativeInteger(slot.maxItems) && children.length > slot.maxItems)) addDiagnostic(ds, 'component.slot-cardinality', 'Slot child count is outside declared bounds.', `${path}.slotChildren.${slotId}`, nodeId);
      children.forEach((childId, index) => {
        if (typeof childId !== 'string') { addDiagnostic(ds, 'component.slot-child-id', 'Slot child ID must be a string.', `${path}.slotChildren.${slotId}[${index}]`, nodeId); return; }
        const child = nodes[childId];
        if (isRecord(child) && Array.isArray(slot.allowedKinds) && !slot.allowedKinds.includes(child.kind as never)) addDiagnostic(ds, 'component.slot-kind', 'Slot child kind is not allowed.', `${path}.slotChildren.${slotId}`, childId);
      });
    }
  }
}

function validateTemplateCycles(definition: ComponentDefinition, componentId: string, ds: Diagnostic[]): void {
  const templates = definition.templateNodes as Record<string, unknown>;
  const color = new Map<string, 0 | 1 | 2>();
  for (const start of [definition.rootTemplateNodeId, ...Object.keys(templates)]) {
    if ((color.get(start) ?? 0) !== 0) continue;
    const stack: Array<{ id: string; depth: number; exiting: boolean }> = [{ id: start, depth: 1, exiting: false }];
    while (stack.length) {
      const item = stack.pop()!;
      if (item.exiting) { color.set(item.id, 2); continue; }
      const state = color.get(item.id) ?? 0;
      if (state === 1) { addDiagnostic(ds, 'component.template-cycle', 'Component template has a cycle.', `components.${componentId}.templateNodes.${item.id}`); continue; }
      if (state === 2) continue;
      if (item.depth > 64) { addDiagnostic(ds, 'component.template-depth', 'Component template ownership exceeds depth 64.', `components.${componentId}.templateNodes.${item.id}`); continue; }
      const node = templates[item.id];
      if (!isRecord(node) || !Array.isArray(node.childTemplateNodeIds)) { color.set(item.id, 2); continue; }
      color.set(item.id, 1);
      stack.push({ ...item, exiting: true });
      for (const child of node.childTemplateNodeIds) if (typeof child === 'string' && Object.hasOwn(templates, child)) stack.push({ id: child, depth: item.depth + 1, exiting: false });
    }
  }
}

function propertyValueShapeMatches(value: unknown, type: string): boolean {
  return type === 'string' ? typeof value === 'string'
    : type === 'number' ? isFiniteNumber(value)
      : type === 'boolean' ? typeof value === 'boolean'
        : type === 'token' ? isRecord(value) && value.kind === 'token' && typeof value.tokenId === 'string' && value.tokenId.length > 0 && Object.keys(value).every((key) => ['kind', 'tokenId'].includes(key))
          : false;
}

function validPropertyValue(value: unknown, type: string, path: string, tokens: Map<string, DesignToken>, ds: Diagnostic[], constraints?: unknown): boolean {
  const valid = propertyValueShapeMatches(value, type);
  if (!valid) { addDiagnostic(ds, 'component.property-type', `Value does not match declared ${type} type.`, path); return false; }
  const rule = isRecord(constraints) ? constraints : {};
  if (type === 'number' && isFiniteNumber(value)) {
    if (isFiniteNumber(rule.min) && value < rule.min) addDiagnostic(ds, 'component.property-min', 'Value is below the declared minimum.', path);
    if (isFiniteNumber(rule.max) && value > rule.max) addDiagnostic(ds, 'component.property-max', 'Value is above the declared maximum.', path);
  }
  if (type === 'token' && isRecord(value)) {
    const reference = value as unknown as TokenReference;
    if (Object.keys(value).some((key) => !['kind', 'tokenId'].includes(key))) addDiagnostic(ds, 'component.property-token-shape', 'Token property references may contain only kind and tokenId.', path);
    const token = tokens.get(reference.tokenId);
    if (!token) addDiagnostic(ds, 'component.property-token-missing', 'Token property references a token that does not exist.', `${path}.tokenId`, reference.tokenId);
    else if (typeof rule.tokenCategory === 'string' && token.category !== rule.tokenCategory) addDiagnostic(ds, 'component.property-token-category', `Expected a ${rule.tokenCategory} token, received ${token.category}.`, `${path}.tokenId`, reference.tokenId);
  }
  if (Array.isArray(rule.enum) && !rule.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) addDiagnostic(ds, 'component.property-enum', 'Value is not in the declared enum.', path);
  return true;
}
