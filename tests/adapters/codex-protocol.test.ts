import { describe, expect, it } from "vitest";
import { AgentProtocolError, buildResponseSchema, parseAgentResponse } from "../../src/adapters/codex/protocol";
import type { OperationType } from "../../src/domain/types";

const caps: OperationType[] = ["node.create", "node.delete", "node.move", "property.set", "layout.set", "style.set"];
const baseLayout = {
  mode: "vertical", position: null,
  width: { kind: "fixed", value: { kind: "literal", value: 480, unit: "px" } },
  height: { kind: "hug", min: null, max: null }, align: "stretch", justify: "start",
  gap: { kind: "literal", value: 12, unit: "px" },
  padding: Object.fromEntries(["top", "right", "bottom", "left"].map((side) => [side, { kind: "literal", value: 16, unit: "px" }])),
};
function parse(operations: unknown[], capabilities: OperationType[] = caps) {
  return parseAgentResponse({ operations, summary: "Typed proposal" }, capabilities);
}
function createFrame(overrides: Record<string, unknown> = {}) {
  return { type: "node.create", id: "frame-stable", name: "Card", kind: "frame", pageId: "page_active", parentId: null, index: 2, layout: baseLayout, style: null, visible: true, constraints: { left: null, right: null, top: null, bottom: null, centerX: null, centerY: null }, responsive: [], ...overrides };
}
function createVector(overrides: Record<string, unknown> = {}) {
  return { type: "node.create", id: "vector-stable", name: "Accent star", kind: "vector", pageId: "page_active", parentId: null, index: 0, layout: null, style: null, visible: true, constraints: { left: null, right: null, top: null, bottom: null, centerX: null, centerY: null }, responsive: [], pathData: "M 50 4 L 61 38 L 96 38 L 68 58 L 79 92 L 50 72 L 21 92 L 32 58 L 4 38 L 39 38 Z", viewBox: { x: 0, y: 0, width: 100, height: 100 }, ...overrides };
}

describe("Codex typed response protocol", () => {
  it("builds closed object schemas for only negotiated capabilities", () => {
    const schema = buildResponseSchema(["node.create", "layout.set"]);
    const encoded = JSON.stringify(schema);
    expect((((schema.properties as Record<string, unknown>).operations as { items: { anyOf: unknown[] } }).items.anyOf)).toBeDefined();
    expect(encoded).not.toContain("JSON-encoded");
    expect(schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(encoded).toContain('"node.create"');
    expect(encoded).toContain('"layout.set"');
    expect(encoded).not.toContain('"node.delete"');
    expect(Buffer.byteLength(JSON.stringify(buildResponseSchema(caps)))).toBeLessThan(13_000);
    const definitions = schema.$defs as Record<string, unknown>;
    const refs: string[] = [];
    const collectRefs = (node: unknown) => {
      if (Array.isArray(node)) { node.forEach(collectRefs); return; }
      if (!node || typeof node !== "object") return;
      const object = node as Record<string, unknown>;
      if (typeof object.$ref === "string") refs.push(object.$ref);
      Object.values(object).forEach(collectRefs);
    };
    collectRefs(schema);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((ref) => Object.hasOwn(definitions, ref.replace("#/$defs/", "")))).toBe(true);
    expect((buildResponseSchema(["node.create"]).properties as Record<string, unknown>).operations).toBeDefined();
  });

  it("lowers typed create proposals with documented defaults and stable placement", () => {
    const result = parse([createFrame(), {
      type: "node.create", id: "title-stable", name: "Title", kind: "text", pageId: "page_active", parentId: "frame-stable", index: 0,
      layout: null, style: null, visible: true, constraints: { left: null, right: null, top: null, bottom: null, centerX: null, centerY: null }, responsive: [], text: "Retained copy", textStyle: null,
    }]);
    expect(result.operations[0]).toMatchObject({ type: "node.create", pageId: "page_active", index: 2, node: { id: "frame-stable", name: "Card", kind: "frame", childIds: [], visible: true, constraints: {}, responsive: [], layout: { mode: "vertical", width: baseLayout.width, height: { kind: "hug" } }, style: {} } });
    expect(result.operations[1]).toMatchObject({ type: "node.create", pageId: "page_active", parentId: "frame-stable", index: 0, node: { id: "title-stable", kind: "text", text: "Retained copy", textStyle: {}, childIds: [] } });
  });

  it("lowers native vector proposals to the existing tuple geometry and semantic fill", () => {
    const result = parse([createVector({ style: { fill: { kind: "literal", value: "#123456" }, textColor: null, radius: null, opacity: null, shadowTokenId: null } })]);
    expect(result.operations[0]).toMatchObject({ node: { kind: "vector", pathData: "M 50 4 L 61 38 L 96 38 L 68 58 L 79 92 L 50 72 L 21 92 L 32 58 L 4 38 L 39 38 Z", viewBox: [0, 0, 100, 100], style: { fill: { kind: "literal", value: "#123456" } }, childIds: [] } });
    const schema = JSON.stringify(buildResponseSchema(["node.create"]));
    expect(schema).toContain('"vector"');
    expect(schema).toContain('"pathData"');
    expect(schema).toContain('"viewBox"');
  });

  it.each([
    ["markup", { pathData: 'M 0 0 <svg onload="alert(1)"/>' }],
    ["external reference syntax", { pathData: "M 0 0 url(https://example.test/a.svg)" }],
    ["unknown command", { pathData: "M 0 0 X 1 2" }],
    ["incomplete command", { pathData: "M 0 0 C 1 2 3" }],
    ["invalid arc flag", { pathData: "M 0 0 A 5 5 0 2 0 10 10" }],
    ["non-positive viewBox", { viewBox: { x: 0, y: 0, width: 0, height: 10 } }],
  ])("rejects vector proposal with %s", (_label, fields) => {
    expect(() => parse([createVector(fields)])).toThrow(AgentProtocolError);
  });

  it("preserves free-layout position only when nested in layout", () => {
    const layout = { ...baseLayout, mode: "free", position: { x: 21, y: 37 } };
    const result = parse([createFrame({ layout })]);
    expect((result.operations[0] as { node: { layout: { position?: { x: number; y: number } } } }).node.layout.position).toEqual({ x: 21, y: 37 });
    expect(() => parse([{ ...createFrame(), position: { x: 21, y: 37 } }])).toThrow(/unsupported field position/);
  });

  it("preserves explicit visibility, constraints and responsive partial values", () => {
    const response = parse([createFrame({
      visible: false,
      constraints: { left: { kind: "literal", value: 8, unit: "px" }, right: null, top: null, bottom: null, centerX: null, centerY: null },
      responsive: [{ id: "mobile-rule", breakpointTokenId: "breakpoint.mobile", priority: 2, overrides: {
        layout: { mode: null, position: null, width: { kind: "fill", min: null, max: null }, height: null, align: null, justify: null, gap: null, padding: null }, visible: false,
      } }],
    })]);
    expect(response.operations[0]).toMatchObject({ node: {
      visible: false,
      constraints: { left: { kind: "literal", value: 8, unit: "px" } },
      responsive: [{ id: "mobile-rule", breakpointTokenId: "breakpoint.mobile", priority: 2, overrides: { layout: { width: { kind: "fill" } }, visible: false } }],
    } });
  });

  it.each([
    ["unknown envelope key", { operations: [], summary: "ok", extra: 1 }],
    ["string operation", { operations: ['{"type":"node.delete"}'], summary: "ok" }],
    ["top-level placement", { operations: [{ ...createFrame(), position: { x: 1, y: 2 } }], summary: "ok" }],
    ["bad position", { operations: [createFrame({ layout: { ...baseLayout, position: { x: "1", y: 2 } } })], summary: "ok" }],
    ["wrong kind fields", { operations: [createFrame({ text: null })], summary: "ok" }],
    ["unsupported creation kind", { operations: [createFrame({ kind: "image" })], summary: "ok" }],
  ])("rejects malformed %s with stable protocol errors", (_name, response) => {
    expect(() => parseAgentResponse(response, caps)).toThrow(AgentProtocolError);
  });

  it("lowers nullable layout/style fields and rejects capability escalation", () => {
    const result = parse([
      { type: "layout.set", nodeId: "frame-stable", value: baseLayout },
      { type: "style.set", nodeId: "frame-stable", value: { fill: null, textColor: null, radius: null, opacity: null, shadowTokenId: null } },
    ]);
    expect(result.operations[0]).toMatchObject({ value: { mode: "vertical", width: baseLayout.width, height: { kind: "hug" } } });
    expect(result.operations[1]).toEqual({ type: "style.set", nodeId: "frame-stable", value: {} });
    expect(() => parse([{ type: "node.delete", nodeId: "x", mode: "subtree" }], ["node.create"])).toThrow(/outside the negotiated capabilities/);
  });

  it("rejects duplicate and prototype-sensitive dictionary entry keys", () => {
    const instance = {
      type: "node.create", id: "instance", name: "Primary button", kind: "component-instance", pageId: "page_active", parentId: null, index: 0,
      layout: null, style: null, visible: true, constraints: { left: null, right: null, top: null, bottom: null, centerX: null, centerY: null }, responsive: [], componentId: "button", variantId: "primary", propertyOverrides: [], nodeOverrides: [], slotChildren: [],
    };
    expect(parse([instance]).operations[0]).toMatchObject({ type: "node.create", node: { kind: "component-instance", propertyOverrides: {}, nodeOverrides: {}, slotChildren: {} } });
    expect(() => parse([{ ...instance, propertyOverrides: [{ key: "label", value: "Save" }, { key: "label", value: "Cancel" }] }])).toThrow(/duplicate key/);
    expect(() => parse([{ ...instance, slotChildren: [{ key: "__proto__", value: [] }] }])).toThrow(/unsafe key/);
  });

  it("preserves token references in component property override maps", () => {
    const instance = {
      type: "node.create", id: "instance", name: "Primary button", kind: "component-instance", pageId: "page_active", parentId: null, index: 0,
      layout: null, style: null, visible: true, constraints: { left: null, right: null, top: null, bottom: null, centerX: null, centerY: null }, responsive: [], componentId: "button", variantId: "primary",
      propertyOverrides: [{ key: "color", value: { kind: "token", tokenId: "color.primary" } }], nodeOverrides: [], slotChildren: [],
    };
    expect(parse([instance]).operations[0]).toMatchObject({ node: { propertyOverrides: { color: { kind: "token", tokenId: "color.primary" } } } });
    const update = parse([{ type: "property.set", nodeId: "instance", change: { property: "propertyOverrides", value: [{ key: "color", value: { kind: "token", tokenId: "color.primary" } }] } }]);
    expect(update.operations[0]).toMatchObject({ change: { property: "propertyOverrides", value: { color: { kind: "token", tokenId: "color.primary" } } } });
  });
});
