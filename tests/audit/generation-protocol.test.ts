import { describe, expect, it } from "vitest";
import { buildResponseSchema, parseAgentResponse } from "../../src/adapters/codex/protocol";
import { applyBatch, createDocument, parseBatch } from "../../src/domain";
import type { OperationType } from "../../src/domain/types";

const capabilities: OperationType[] = ["node.create", "node.delete", "node.move", "property.set", "layout.set", "style.set"];

function frameCreate(id = "frame_one") {
  return {
    type: "node.create",
    id,
    name: "Frame",
    kind: "frame",
    pageId: "page_1",
    parentId: null,
    index: 0,
    layout: null,
    style: null,
    visible: true,
    constraints: { left: null, right: null, top: null, bottom: null, centerX: null, centerY: null },
    responsive: [],
  };
}

function assertClosedRequiredObjects(schema: unknown): void {
  if (Array.isArray(schema)) {
    for (const entry of schema) assertClosedRequiredObjects(entry);
    return;
  }
  if (!schema || typeof schema !== "object") return;
  const object = schema as Record<string, unknown>;
  if (object.type === "object") {
    expect(object.additionalProperties).toBe(false);
    expect(Array.isArray(object.required)).toBe(true);
    expect(object.required).toEqual(Object.keys(object.properties as Record<string, unknown>));
  }
  for (const value of Object.values(object)) assertClosedRequiredObjects(value);
}

function assertProviderSubset(schema: unknown): void {
  const supported = new Set([
    "type", "properties", "required", "additionalProperties", "anyOf", "items", "enum", "$defs", "$ref",
    "pattern", "minLength", "maxLength", "minimum", "maximum",
    "description",
  ]);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      expect(supported.has(key), `schema keyword ${key} is outside the constrained-output subset`).toBe(true);
      if (key === "properties") Object.values(nested as Record<string, unknown>).forEach(visit);
      else if (key === "$defs") Object.values(nested as Record<string, unknown>).forEach(visit);
      else if (key === "items") visit(nested);
      else if (key === "anyOf") visit(nested);
    }
  };
  visit(schema);
}

describe("generation protocol acceptance boundary", () => {
  it("emits a closed object schema for each negotiated operation instead of JSON-in-string payloads", () => {
    const schema = buildResponseSchema(capabilities) as Record<string, unknown>;
    const operations = schema.properties as Record<string, Record<string, unknown>>;
    const operationItems = operations.operations!.items as Record<string, unknown>;
    const branches = operationItems.anyOf as unknown[];

    expect(operationItems.type).not.toBe("string");
    expect(branches).toHaveLength(capabilities.length);
    assertClosedRequiredObjects(schema);
    assertProviderSubset(schema);

    const onlyCreate = buildResponseSchema(["node.create"]) as Record<string, unknown>;
    const createBranches = (((onlyCreate.properties as Record<string, Record<string, unknown>>).operations!.items as Record<string, unknown>).anyOf as unknown[]);
    expect(createBranches).toHaveLength(1);
  });

  it("rejects unknown capabilities instead of silently widening or dropping their schema", () => {
    expect(() => buildResponseSchema(["page.delete" as OperationType])).toThrow();
  });

  it.each([
    ["string-encoded operation", [JSON.stringify(frameCreate())]],
    ["unknown operation field", [{ ...frameCreate(), position: { x: 0, y: 0 } }]],
    ["field from a different node kind", [{ ...frameCreate(), text: "not a frame" }]],
    ["missing conditional text fields", [{ ...frameCreate(), kind: "text" }]],
  ])("rejects %s before the transaction boundary", (_label, operations) => {
    expect(() => parseAgentResponse({ operations, summary: "proposal" }, capabilities)).toThrow();
  });

  it("accepts a valid strict proposal only after it lowers to the existing atomic batch contract", () => {
    const proposal = parseAgentResponse({ operations: [frameCreate()], summary: "Create a card." }, capabilities);
    const document = createDocument("Protocol test", "doc_protocol", "page_1");
    const batch = parseBatch({
      id: "batch_protocol",
      documentId: document.id,
      expectedRevision: document.revision,
      source: "agent",
      capabilitySet: capabilities,
      operations: proposal.operations,
    });

    expect(batch.ok).toBe(true);
    if (batch.ok) {
      const result = parseBatch({ ...batch.value, operations: proposal.operations });
      expect(result.ok).toBe(true);
    }
  });

  it("accepts native vector geometry through node.create and the atomic document validator", () => {
    const proposal = parseAgentResponse({ operations: [{
      type: "node.create", id: "vector_star", name: "Accent star", kind: "vector", pageId: "page_1", parentId: null, index: 0,
      layout: null, style: { fill: { kind: "literal", value: "#123456" }, textColor: null, radius: null, opacity: null, shadowTokenId: null }, visible: true,
      constraints: { left: null, right: null, top: null, bottom: null, centerX: null, centerY: null }, responsive: [],
      pathData: "M 50 4 L 61 38 L 96 38 L 68 58 L 79 92 L 50 72 L 21 92 L 32 58 L 4 38 L 39 38 Z", viewBox: { x: 0, y: 0, width: 100, height: 100 },
    }], summary: "Add native vector artwork." }, capabilities);
    const document = createDocument("Vector protocol", "doc_vector_protocol", "page_1");
    const result = applyBatch(document, { id: "batch_vector", documentId: document.id, expectedRevision: 0, source: "agent", capabilitySet: capabilities, operations: proposal.operations }, []);
    expect(result.status).toBe("committed");
    if (result.status === "committed") expect(result.document.nodes.vector_star).toMatchObject({ kind: "vector", viewBox: [0, 0, 100, 100], pathData: expect.stringContaining("Z"), style: { fill: { kind: "literal", value: "#123456" } } });
  });

  it("keeps structural protocol acceptance separate from semantic document validation", () => {
    const proposal = parseAgentResponse({ operations: [frameCreate("duplicate_id"), frameCreate("duplicate_id")], summary: "Duplicate IDs." }, capabilities);
    const document = createDocument("Protocol test", "doc_protocol", "page_1");
    const batch = parseBatch({
      id: "batch_duplicate",
      documentId: document.id,
      expectedRevision: document.revision,
      source: "agent",
      capabilitySet: capabilities,
      operations: proposal.operations,
    });

    expect(batch.ok).toBe(true);
    // The wire parser recognizes shape and operation types. The transaction layer
    // still owns graph invariants and rejects duplicate identities atomically.
    const result = applyBatch(document, batch.ok ? batch.value : {}, []);
    expect(result.status).toBe("rejected");
    expect(result.revision).toBe(0);
    expect(document.revision).toBe(0);
  });
});
