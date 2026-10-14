import { createNodeBase } from "../../domain/defaults";
import type { CodingAgentResponse, ConstraintSet, DesignNode, Layout, Operation, OperationType, ResponsiveRule, SemanticStyle } from "../../domain/types";

const MAX_OPERATIONS = 500;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_RESPONSE_BYTES = 1_000_000;

export class AgentProtocolError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "AgentProtocolError"; }
}

type Schema = Record<string, unknown>;
const str: Schema = { type: "string" };
const nonEmpty: Schema = { type: "string", minLength: 1 };
const num: Schema = { type: "number" };
const integer: Schema = { type: "integer", minimum: 0 };
const bool: Schema = { type: "boolean" };
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: "null" }] });
const obj = (properties: Record<string, Schema>): Schema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items: Schema): Schema => ({ type: "array", items });
const enumeration = (...values: string[]): Schema => ({ type: "string", enum: values });
const measure: Schema = { anyOf: [obj({ kind: enumeration("literal"), value: num, unit: enumeration("px") }), obj({ kind: enumeration("token"), tokenId: nonEmpty })] };
const sizing: Schema = { anyOf: [obj({ kind: enumeration("fixed"), value: measure }), obj({ kind: enumeration("hug"), min: nullable(measure), max: nullable(measure) }), obj({ kind: enumeration("fill"), min: nullable(measure), max: nullable(measure) })] };
const layout: Schema = obj({
  mode: enumeration("horizontal", "vertical", "free"), position: nullable(obj({ x: num, y: num })), width: sizing, height: sizing,
  align: enumeration("start", "center", "end", "stretch"), justify: enumeration("start", "center", "end", "space-between"), gap: measure,
  padding: obj({ top: measure, right: measure, bottom: measure, left: measure }),
});
const color: Schema = { anyOf: [obj({ kind: enumeration("literal"), value: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" } }), obj({ kind: enumeration("token"), tokenId: nonEmpty })] };
const style: Schema = obj({ fill: nullable(color), textColor: nullable(color), radius: nullable(measure), opacity: nullable({ type: "number", minimum: 0, maximum: 1 }), shadowTokenId: nullable(nonEmpty) });
const textStyle: Schema = obj({ typographyTokenId: nullable(nonEmpty), fontSize: nullable(measure), weight: nullable(num), lineHeight: nullable(num), align: nullable(enumeration("start", "center", "end")) });
const constraints: Schema = obj({ left: nullable(measure), right: nullable(measure), top: nullable(measure), bottom: nullable(measure), centerX: nullable(bool), centerY: nullable(bool) });
const partialPadding: Schema = obj({ top: nullable(measure), right: nullable(measure), bottom: nullable(measure), left: nullable(measure) });
const partialLayout: Schema = obj({ mode: nullable(enumeration("horizontal", "vertical", "free")), position: nullable(obj({ x: num, y: num })), width: nullable(sizing), height: nullable(sizing), align: nullable(enumeration("start", "center", "end", "stretch")), justify: nullable(enumeration("start", "center", "end", "space-between")), gap: nullable(measure), padding: nullable(partialPadding) });
const responsive: Schema = arr(obj({ id: nonEmpty, breakpointTokenId: nonEmpty, priority: num, overrides: obj({ layout: nullable(partialLayout), visible: nullable(bool) }) }));
const propertyValue: Schema = { anyOf: [str, num, bool, obj({ kind: enumeration("token"), tokenId: nonEmpty })] };
const propertyEntries: Schema = arr(obj({ key: nonEmpty, value: propertyValue }));
const overrideEntries: Schema = arr(obj({ key: nonEmpty, value: obj({ text: nullable(str), visible: nullable(bool), style: nullable(style), textStyle: nullable(textStyle) }) }));
const slotEntries: Schema = arr(obj({ key: nonEmpty, value: arr(nonEmpty) }));
const viewBox: Schema = obj({ x: num, y: num, width: num, height: num });

const createBase = { id: nonEmpty, name: nonEmpty, pageId: nonEmpty, parentId: nullable(nonEmpty), index: integer, layout: nullable(layout), style: nullable(style), visible: bool, constraints, responsive };
const createWireSchema: Schema = { anyOf: [
  obj({ type: enumeration("node.create"), kind: enumeration("frame"), ...createBase }),
  obj({ type: enumeration("node.create"), kind: enumeration("group"), ...createBase }),
  obj({ type: enumeration("node.create"), kind: enumeration("text"), ...createBase, text: nullable(str), textStyle: nullable(textStyle) }),
  obj({ type: enumeration("node.create"), kind: enumeration("vector"), ...createBase, pathData: { type: "string", minLength: 1, maxLength: 8192 }, viewBox }),
  obj({ type: enumeration("node.create"), kind: enumeration("component-instance"), ...createBase, componentId: nonEmpty, variantId: nonEmpty, propertyOverrides: propertyEntries, nodeOverrides: overrideEntries, slotChildren: slotEntries }),
] };
const operationSchemas: Record<OperationType, Schema> = {
  "node.create": createWireSchema,
  "node.delete": obj({ type: enumeration("node.delete"), nodeId: nonEmpty, mode: enumeration("subtree", "reject-if-children") }),
  "node.move": obj({ type: enumeration("node.move"), nodeId: nonEmpty, parentId: nullable(nonEmpty), pageId: nonEmpty, index: integer }),
  "property.set": obj({ type: enumeration("property.set"), nodeId: nonEmpty, change: obj({ property: enumeration("name", "text", "visible", "variantId", "propertyOverrides"), value: { anyOf: [str, bool, propertyEntries] } }) }),
  "layout.set": obj({ type: enumeration("layout.set"), nodeId: nonEmpty, value: layout }),
  "style.set": obj({ type: enumeration("style.set"), nodeId: nonEmpty, value: style }),
};

/** Reuse provider-supported $defs/$ref nodes to keep the strict schema compact. */
function compactSchema(root: Schema): Schema {
  const counts = new Map<string, number>();
  const nodes = new Map<string, Schema>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!record(value)) return;
    if (value.type !== undefined || value.anyOf !== undefined) {
      const key = JSON.stringify(value);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      nodes.set(key, value);
    }
    Object.values(value).forEach(visit);
  };
  visit(root);
  const names = new Map<string, string>();
  for (const [key, count] of counts) if (count > 1 && key.length > 120) names.set(key, `schema_${names.size + 1}`);
  const rewrite = (value: unknown, definitionRoot = false): unknown => {
    if (Array.isArray(value)) return value.map((item) => rewrite(item));
    if (!record(value)) return value;
    const name = names.get(JSON.stringify(value));
    if (name && !definitionRoot) return { $ref: `#/$defs/${name}` };
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
  };
  const definitions: Record<string, unknown> = {};
  for (const [key, name] of names) definitions[name] = rewrite(nodes.get(key), true);
  return { ...(rewrite(root, true) as Schema), $defs: definitions };
}

/** Strict Structured Outputs schema: operation values are objects, never JSON-in-strings. */
export function buildResponseSchema(capabilities: readonly OperationType[]): Record<string, unknown> {
  const supported = [...new Set(capabilities)];
  if (supported.length === 0) throw new AgentProtocolError("protocol.capability", "At least one operation capability must be negotiated.");
  const variants = supported.map((capability) => operationSchemas[capability]).filter((schema): schema is Schema => schema !== undefined);
  if (variants.length !== supported.length) throw new AgentProtocolError("protocol.capability", "Cannot build a response schema for an unsupported operation capability.");
  return compactSchema(obj({ operations: arr({ anyOf: variants }), summary: { type: "string", maxLength: MAX_SUMMARY_CHARS } }));
}

function fail(code: string, message: string): never { throw new AgentProtocolError(code, message); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exact(value: Record<string, unknown>, keys: readonly string[], at: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail("protocol.unknown_field", `${at} contains unsupported field ${key}.`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail("protocol.missing_field", `${at}.${key} is required.`);
}
function strField(value: unknown, at: string, nonblank = false): string {
  if (typeof value !== "string" || (nonblank && !value.trim())) fail("protocol.shape", `${at} must be ${nonblank ? "a non-empty" : "a"} string.`);
  return value;
}
function finite(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("protocol.shape", `${at} must be finite.`);
  return value;
}
const PATH_TOKEN = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;
const PATH_ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
function checkPathData(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192) fail("protocol.vector_path", `${at} must be non-empty SVG path data no longer than 8192 characters.`);
  let position = 0; let command: string | undefined; let argumentsInCommand = 0; let segmentCount = 0; let firstCommand = true;
  while (position < value.length) {
    const separatorStart = position;
    while (position < value.length && /[\s,]/.test(value[position]!)) position++;
    if (position === value.length) break;
    PATH_TOKEN.lastIndex = position;
    const match = PATH_TOKEN.exec(value);
    if (!match) fail("protocol.vector_path", `${at} contains unsupported SVG path syntax.`);
    position = PATH_TOKEN.lastIndex;
    if (match[1]) {
      if (command !== undefined && PATH_ARITY[command.toUpperCase()]! > 0 && (argumentsInCommand === 0 || argumentsInCommand % PATH_ARITY[command.toUpperCase()]! !== 0)) fail("protocol.vector_path", `${at} has an incomplete path command.`);
      command = match[1]; argumentsInCommand = 0;
      if (firstCommand && command.toUpperCase() !== "M") fail("protocol.vector_path", `${at} must begin with a move command.`);
      firstCommand = false;
      if (command.toUpperCase() === "Z") { segmentCount++; command = undefined; }
    } else {
      if (command === undefined) fail("protocol.vector_path", `${at} contains coordinates without a path command.`);
      const number = Number(match[2]);
      if (!Number.isFinite(number) || Math.abs(number) > 100_000) fail("protocol.vector_path", `${at} contains a non-finite or out-of-bounds coordinate.`);
      if (command.toUpperCase() === "A" && (argumentsInCommand % 7 === 3 || argumentsInCommand % 7 === 4) && number !== 0 && number !== 1) fail("protocol.vector_path", `${at} arc flags must be 0 or 1.`);
      argumentsInCommand++;
      const arity = PATH_ARITY[command.toUpperCase()]!;
      if (argumentsInCommand % arity === 0) segmentCount++;
    }
    if (segmentCount > 512) fail("protocol.vector_path", `${at} contains more than 512 path segments.`);
    // A comma is only a separator between numeric arguments, never before a command.
    if (position > separatorStart && value.slice(separatorStart, position).includes(",") && match[1]) fail("protocol.vector_path", `${at} has an invalid comma separator.`);
  }
  if (firstCommand || command !== undefined && PATH_ARITY[command.toUpperCase()]! > 0 && (argumentsInCommand === 0 || argumentsInCommand % PATH_ARITY[command.toUpperCase()]! !== 0)) fail("protocol.vector_path", `${at} has an incomplete path.`);
  return value;
}
function checkViewBox(value: unknown, at: string): [number, number, number, number] {
  if (!record(value)) fail("protocol.shape", `${at} must be an object with x, y, width and height.`);
  exact(value, ["x", "y", "width", "height"], at);
  const x = finite(value.x, `${at}.x`); const y = finite(value.y, `${at}.y`); const width = finite(value.width, `${at}.width`); const height = finite(value.height, `${at}.height`);
  if (Math.abs(x) > 100_000 || Math.abs(y) > 100_000 || width <= 0 || height <= 0 || width > 100_000 || height > 100_000) fail("protocol.shape", `${at} coordinates must be bounded and dimensions must be positive.`);
  return [x, y, width, height];
}
function checkMeasure(value: unknown, at: string): void {
  if (!record(value)) fail("protocol.shape", `${at} must be a measure object.`);
  if (value.kind === "literal") { exact(value, ["kind", "value", "unit"], at); finite(value.value, `${at}.value`); if (value.unit !== "px") fail("protocol.shape", `${at}.unit must be px.`); }
  else if (value.kind === "token") { exact(value, ["kind", "tokenId"], at); strField(value.tokenId, `${at}.tokenId`, true); }
  else fail("protocol.shape", `${at}.kind must be literal or token.`);
}
function checkLayout(value: unknown, at: string): asserts value is Layout {
  if (!record(value)) fail("protocol.shape", `${at} must be an object.`);
  exact(value, ["mode", "position", "width", "height", "align", "justify", "gap", "padding"], at);
  if (!(["horizontal", "vertical", "free"] as unknown[]).includes(value.mode)) fail("protocol.shape", `${at}.mode is invalid.`);
  if (value.position !== null) { if (!record(value.position)) fail("protocol.shape", `${at}.position must be an object or null.`); exact(value.position, ["x", "y"], `${at}.position`); finite(value.position.x, `${at}.position.x`); finite(value.position.y, `${at}.position.y`); }
  for (const key of ["width", "height"] as const) { const s = value[key]; if (!record(s)) fail("protocol.shape", `${at}.${key} must be a sizing object.`); if (s.kind === "fixed") { exact(s, ["kind", "value"], `${at}.${key}`); checkMeasure(s.value, `${at}.${key}.value`); } else if (s.kind === "hug" || s.kind === "fill") { exact(s, ["kind", "min", "max"], `${at}.${key}`); for (const field of ["min", "max"]) if (s[field] !== null) checkMeasure(s[field], `${at}.${key}.${field}`); } else fail("protocol.shape", `${at}.${key}.kind is invalid.`); }
  if (!(["start", "center", "end", "stretch"] as unknown[]).includes(value.align) || !(["start", "center", "end", "space-between"] as unknown[]).includes(value.justify)) fail("protocol.shape", `${at} alignment is invalid.`);
  checkMeasure(value.gap, `${at}.gap`);
  if (!record(value.padding)) fail("protocol.shape", `${at}.padding must be an object.`); exact(value.padding, ["top", "right", "bottom", "left"], `${at}.padding`); for (const k of ["top", "right", "bottom", "left"]) checkMeasure(value.padding[k], `${at}.padding.${k}`);
}
function checkStyle(value: unknown, at: string): asserts value is SemanticStyle {
  if (!record(value)) fail("protocol.shape", `${at} must be an object.`);
  exact(value, ["fill", "textColor", "radius", "opacity", "shadowTokenId"], at);
  for (const key of ["fill", "textColor"] as const) if (value[key] !== null) { const c = value[key]; if (!record(c)) fail("protocol.shape", `${at}.${key} must be a color object or null.`); if (c.kind === "token") { exact(c, ["kind", "tokenId"], `${at}.${key}`); strField(c.tokenId, `${at}.${key}.tokenId`, true); } else if (c.kind === "literal") { exact(c, ["kind", "value"], `${at}.${key}`); if (typeof c.value !== "string" || !/^#[0-9a-f]{6}$/i.test(c.value)) fail("protocol.shape", `${at}.${key}.value must be #RRGGBB.`); } else fail("protocol.shape", `${at}.${key}.kind is invalid.`); }
  if (value.radius !== null) checkMeasure(value.radius, `${at}.radius`);
  if (value.opacity !== null && (typeof value.opacity !== "number" || !Number.isFinite(value.opacity) || value.opacity < 0 || value.opacity > 1)) fail("protocol.shape", `${at}.opacity must be between 0 and 1 or null.`);
  if (value.shadowTokenId !== null) strField(value.shadowTokenId, `${at}.shadowTokenId`, true);
}
function entries(value: unknown, at: string, validate: (v: unknown, p: string) => void): Record<string, unknown> {
  if (!Array.isArray(value)) fail("protocol.shape", `${at} must be an array of key/value entries.`);
  const result: Record<string, unknown> = {};
  for (const [index, item] of value.entries()) {
    if (!record(item)) fail("protocol.shape", `${at}[${index}] must be an object.`);
    exact(item, ["key", "value"], `${at}[${index}]`); const key = strField(item.key, `${at}[${index}].key`, true);
    if (key === "__proto__" || key === "prototype" || key === "constructor") fail("protocol.unsafe_key", `${at} contains unsafe key ${key}.`);
    if (Object.hasOwn(result, key)) fail("protocol.duplicate_key", `${at} contains duplicate key ${key}.`);
    validate(item.value, `${at}[${index}].value`); result[key] = item.value;
  }
  return result;
}
function lowerLayout(value: Layout): Layout {
  const out = structuredClone(value) as Layout & { position?: Layout["position"] };
  if (out.position === null) delete out.position;
  out.width = lowerSizing(out.width);
  out.height = lowerSizing(out.height);
  return out;
}
function lowerSizing(value: Layout["width"]): Layout["width"] {
  if (value.kind === "fixed") return value;
  const out = structuredClone(value) as { kind: "hug" | "fill"; min?: Layout["gap"] | null; max?: Layout["gap"] | null };
  if (out.min === null) delete out.min;
  if (out.max === null) delete out.max;
  return out as Layout["width"];
}
function lowerStyle(value: SemanticStyle): SemanticStyle {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null)) as SemanticStyle;
}
function lowerTextStyle(value: unknown, at: string): Record<string, unknown> {
  if (!record(value)) fail("protocol.shape", `${at} must be an object.`);
  exact(value, ["typographyTokenId", "fontSize", "weight", "lineHeight", "align"], at);
  if (value.typographyTokenId !== null) strField(value.typographyTokenId, `${at}.typographyTokenId`, true);
  if (value.fontSize !== null) checkMeasure(value.fontSize, `${at}.fontSize`);
  if (value.weight !== null) finite(value.weight, `${at}.weight`);
  if (value.lineHeight !== null) finite(value.lineHeight, `${at}.lineHeight`);
  if (value.align !== null && !( ["start", "center", "end"] as unknown[]).includes(value.align)) fail("protocol.shape", `${at}.align is invalid.`);
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null));
}
function lowerConstraints(value: unknown, at: string): ConstraintSet {
  if (!record(value)) fail("protocol.shape", `${at} must be an object.`);
  exact(value, ["left", "right", "top", "bottom", "centerX", "centerY"], at);
  const out: Record<string, unknown> = {};
  for (const key of ["left", "right", "top", "bottom"]) if (value[key] !== null) { checkMeasure(value[key], `${at}.${key}`); out[key] = value[key]; }
  for (const key of ["centerX", "centerY"]) if (value[key] !== null) { if (typeof value[key] !== "boolean") fail("protocol.shape", `${at}.${key} must be boolean or null.`); out[key] = value[key]; }
  return out as ConstraintSet;
}
function lowerPartialLayout(value: unknown, at: string): Partial<Layout> {
  if (!record(value)) fail("protocol.shape", `${at} must be an object.`);
  exact(value, ["mode", "position", "width", "height", "align", "justify", "gap", "padding"], at);
  const out: Record<string, unknown> = {};
  if (value.mode !== null) { if (!( ["horizontal", "vertical", "free"] as unknown[]).includes(value.mode)) fail("protocol.shape", `${at}.mode is invalid.`); out.mode = value.mode; }
  if (value.position !== null) { if (!record(value.position)) fail("protocol.shape", `${at}.position must be an object or null.`); exact(value.position, ["x", "y"], `${at}.position`); finite(value.position.x, `${at}.position.x`); finite(value.position.y, `${at}.position.y`); out.position = value.position; }
  for (const key of ["width", "height"] as const) if (value[key] !== null) { const sizingValue = value[key]; if (!record(sizingValue)) fail("protocol.shape", `${at}.${key} must be a sizing object.`); if (sizingValue.kind === "fixed") { exact(sizingValue, ["kind", "value"], `${at}.${key}`); checkMeasure(sizingValue.value, `${at}.${key}.value`); } else if (sizingValue.kind === "hug" || sizingValue.kind === "fill") { exact(sizingValue, ["kind", "min", "max"], `${at}.${key}`); for (const bound of ["min", "max"]) if (sizingValue[bound] !== null) checkMeasure(sizingValue[bound], `${at}.${key}.${bound}`); } else fail("protocol.shape", `${at}.${key}.kind is invalid.`); out[key] = lowerSizing(sizingValue as Layout["width"]); }
  if (value.align !== null) { if (!( ["start", "center", "end", "stretch"] as unknown[]).includes(value.align)) fail("protocol.shape", `${at}.align is invalid.`); out.align = value.align; }
  if (value.justify !== null) { if (!( ["start", "center", "end", "space-between"] as unknown[]).includes(value.justify)) fail("protocol.shape", `${at}.justify is invalid.`); out.justify = value.justify; }
  if (value.gap !== null) { checkMeasure(value.gap, `${at}.gap`); out.gap = value.gap; }
  if (value.padding !== null) { if (!record(value.padding)) fail("protocol.shape", `${at}.padding must be an object or null.`); exact(value.padding, ["top", "right", "bottom", "left"], `${at}.padding`); const padding: Record<string, unknown> = {}; for (const key of ["top", "right", "bottom", "left"]) if (value.padding[key] !== null) { checkMeasure(value.padding[key], `${at}.padding.${key}`); padding[key] = value.padding[key]; } out.padding = padding; }
  return out as Partial<Layout>;
}
function lowerResponsive(value: unknown, at: string): ResponsiveRule[] {
  if (!Array.isArray(value)) fail("protocol.shape", `${at} must be an array.`);
  return value.map((entry, index) => {
    const path = `${at}[${index}]`;
    if (!record(entry)) fail("protocol.shape", `${path} must be an object.`);
    exact(entry, ["id", "breakpointTokenId", "priority", "overrides"], path);
    const id = strField(entry.id, `${path}.id`, true); const breakpointTokenId = strField(entry.breakpointTokenId, `${path}.breakpointTokenId`, true); const priority = finite(entry.priority, `${path}.priority`);
    if (!record(entry.overrides)) fail("protocol.shape", `${path}.overrides must be an object.`);
    exact(entry.overrides, ["layout", "visible"], `${path}.overrides`);
    const overrides: ResponsiveRule["overrides"] = {};
    if (entry.overrides.layout !== null) overrides.layout = lowerPartialLayout(entry.overrides.layout, `${path}.overrides.layout`);
    if (entry.overrides.visible !== null) { if (typeof entry.overrides.visible !== "boolean") fail("protocol.shape", `${path}.overrides.visible must be boolean or null.`); overrides.visible = entry.overrides.visible; }
    return { id, breakpointTokenId, priority, overrides };
  });
}
function compileCreate(value: Record<string, unknown>, at: string): Operation {
  const kind = strField(value.kind, `${at}.kind`, true);
  const common = ["type", "id", "name", "kind", "pageId", "parentId", "index", "layout", "style", "visible", "constraints", "responsive"];
  const kindFields: Record<string, string[]> = { frame: [], group: [], text: ["text", "textStyle"], vector: ["pathData", "viewBox"], "component-instance": ["componentId", "variantId", "propertyOverrides", "nodeOverrides", "slotChildren"] };
  if (!Object.hasOwn(kindFields, kind)) fail("protocol.shape", `${at}.kind is unsupported.`);
  const allowed = [...common, ...kindFields[kind]!];
  exact(value, allowed, at);
  for (const key of kindFields[kind]!) if (!Object.hasOwn(value, key)) fail("protocol.missing_field", `${at}.${key} is required for ${kind}.`);
  const id = strField(value.id, `${at}.id`, true); const name = strField(value.name, `${at}.name`, true);
  const pageId = strField(value.pageId, `${at}.pageId`, true); const parentId = value.parentId === null ? undefined : strField(value.parentId, `${at}.parentId`, true);
  if (!Number.isSafeInteger(value.index) || (value.index as number) < 0) fail("protocol.shape", `${at}.index must be a non-negative safe integer.`);
  const node = { ...createNodeBase(id, name), kind } as unknown as Record<string, unknown>;
  if (typeof value.visible !== "boolean") fail("protocol.shape", `${at}.visible must be boolean.`);
  node.visible = value.visible;
  node.constraints = lowerConstraints(value.constraints, `${at}.constraints`);
  node.responsive = lowerResponsive(value.responsive, `${at}.responsive`);
  if (value.layout !== null) { checkLayout(value.layout, `${at}.layout`); node.layout = lowerLayout(value.layout); }
  if (value.style !== null) { checkStyle(value.style, `${at}.style`); node.style = lowerStyle(value.style); }
  if (kind === "text") { node.text = strField(value.text, `${at}.text`); node.textStyle = value.textStyle === null ? {} : lowerTextStyle(value.textStyle, `${at}.textStyle`); }
  if (kind === "vector") { node.pathData = checkPathData(value.pathData, `${at}.pathData`); node.viewBox = checkViewBox(value.viewBox, `${at}.viewBox`); }
  if (kind === "component-instance") {
    node.componentId = strField(value.componentId, `${at}.componentId`, true); node.variantId = strField(value.variantId, `${at}.variantId`, true);
    node.propertyOverrides = entries(value.propertyOverrides, `${at}.propertyOverrides`, (v, p) => { if (typeof v === "string" || typeof v === "boolean" || typeof v === "number") return; if (!record(v)) fail("protocol.shape", `${p} is not a property value.`); exact(v, ["kind", "tokenId"], p); if (v.kind !== "token") fail("protocol.shape", `${p}.kind must be token.`); strField(v.tokenId, `${p}.tokenId`, true); });
    node.nodeOverrides = entries(value.nodeOverrides, `${at}.nodeOverrides`, (v, p) => { if (!record(v)) fail("protocol.shape", `${p} must be an override object.`); exact(v, ["text", "visible", "style", "textStyle"], p); if (v.text !== null && typeof v.text !== "string" || v.visible !== null && typeof v.visible !== "boolean") fail("protocol.shape", `${p} contains invalid text/visible values.`); if (v.style !== null) checkStyle(v.style, `${p}.style`); if (v.textStyle !== null) lowerTextStyle(v.textStyle, `${p}.textStyle`); });
    node.nodeOverrides = Object.fromEntries(Object.entries(node.nodeOverrides as Record<string, Record<string, unknown>>).map(([key, override]) => [key, Object.fromEntries(Object.entries(override).filter(([, field]) => field !== null).map(([field, data]) => [field, field === "style" ? lowerStyle(data as SemanticStyle) : field === "textStyle" ? lowerTextStyle(data, `${at}.nodeOverrides.${key}.textStyle`) : data]))]));
    node.slotChildren = entries(value.slotChildren, `${at}.slotChildren`, (v, p) => { if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) fail("protocol.shape", `${p} must be an ID array.`); });
  }
  return { type: "node.create", node: node as unknown as DesignNode, pageId, ...(parentId === undefined ? {} : { parentId }), index: value.index as number };
}

export function parseAgentResponse(value: unknown, capabilities: readonly OperationType[]): CodingAgentResponse {
  if (!record(value)) fail("protocol.response_shape", "Codex final response must be a plain JSON object.");
  exact(value, ["operations", "summary"], "response");
  if (!Array.isArray(value.operations) || value.operations.length > MAX_OPERATIONS) fail("protocol.operation_count", "Codex final response must contain at most 500 operations.");
  const summary = strField(value.summary, "response.summary"); if (summary.length > MAX_SUMMARY_CHARS) fail("protocol.summary_limit", "Codex summary exceeds 4000 characters.");
  let serialized: string; try { serialized = JSON.stringify(value); } catch { fail("protocol.response_shape", "Codex response is not serializable JSON."); }
  if (Buffer.byteLength(serialized!, "utf8") > MAX_RESPONSE_BYTES) fail("protocol.response_limit", "Codex response exceeds the 1 MB protocol limit.");
  const allowed = new Set<OperationType>(capabilities);
  const operations = value.operations.map((item, index): Operation => {
    const at = `operations[${index}]`;
    if (!record(item)) fail("protocol.operation_shape", `${at} must be an object.`);
    const type = strField(item.type, `${at}.type`, true) as OperationType;
    if (!allowed.has(type)) fail("protocol.capability", `${at} uses an operation outside the negotiated capabilities.`);
    if (type === "node.create") return compileCreate(item, at);
    if (type === "node.delete") { exact(item, ["type", "nodeId", "mode"], at); strField(item.nodeId, `${at}.nodeId`, true); if (item.mode !== "subtree" && item.mode !== "reject-if-children") fail("protocol.shape", `${at}.mode is invalid.`); return item as unknown as Operation; }
    if (type === "node.move") { exact(item, ["type", "nodeId", "parentId", "pageId", "index"], at); strField(item.nodeId, `${at}.nodeId`, true); strField(item.pageId, `${at}.pageId`, true); if (item.parentId !== null) strField(item.parentId, `${at}.parentId`, true); if (!Number.isSafeInteger(item.index) || (item.index as number) < 0) fail("protocol.shape", `${at}.index must be a non-negative safe integer.`); const { parentId, ...rest } = item; return { ...rest, ...(parentId === null ? {} : { parentId }) } as unknown as Operation; }
    if (type === "property.set") {
      exact(item, ["type", "nodeId", "change"], at); strField(item.nodeId, `${at}.nodeId`, true);
      if (!record(item.change)) fail("protocol.shape", `${at}.change must be an object.`);
      exact(item.change, ["property", "value"], `${at}.change`);
      const property = strField(item.change.property, `${at}.change.property`, true);
      if (!["name", "text", "visible", "variantId", "propertyOverrides"].includes(property)) fail("protocol.shape", `${at}.change.property is unsupported.`);
      if (property === "visible" ? typeof item.change.value !== "boolean" : property === "propertyOverrides" ? !Array.isArray(item.change.value) : typeof item.change.value !== "string") fail("protocol.shape", `${at}.change.value has the wrong type.`);
      const change = property === "propertyOverrides" ? { property, value: entries(item.change.value, `${at}.change.value`, (v, p) => {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return;
        if (!record(v)) fail("protocol.shape", `${p} must be a property value.`);
        exact(v, ["kind", "tokenId"], p);
        if (v.kind !== "token") fail("protocol.shape", `${p}.kind must be token.`);
        strField(v.tokenId, `${p}.tokenId`, true);
      }) } : item.change;
      return { type, nodeId: item.nodeId, change } as unknown as Operation;
    }
    if (type === "layout.set") { exact(item, ["type", "nodeId", "value"], at); strField(item.nodeId, `${at}.nodeId`, true); checkLayout(item.value, `${at}.value`); return { ...item, value: lowerLayout(item.value) } as unknown as Operation; }
    if (type === "style.set") { exact(item, ["type", "nodeId", "value"], at); strField(item.nodeId, `${at}.nodeId`, true); checkStyle(item.value, `${at}.value`); return { ...item, value: lowerStyle(item.value) } as unknown as Operation; }
    fail("protocol.capability", `${at} uses an unsupported operation capability.`);
  });
  return { operations, summary };
}
