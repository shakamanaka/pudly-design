import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodingAgentRequest, RunEvent } from "../../src/domain/types";
import { CodexCliAdapter } from "../../src/adapters/codex";

const fixture = join(process.cwd(), "tests", "adapters", "fixtures", "codex-cli-fixture.mjs");
const roots: string[] = [];

async function createAdapter(options: { timeoutMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "codex-design-adapter-test-"));
  roots.push(root);
  const executable = join(root, "codex-fixture");
  await writeFile(executable, "#!/bin/sh\nexec node \"" + fixture + "\" \"$@\"\n", { mode: 0o700 });
  await chmod(executable, 0o700);
  return { root, adapter: new CodexCliAdapter({ executable, tempRoot: root, timeoutMs: options.timeoutMs ?? 5_000 }) };
}

function request(prompt = "Create a small empty frame."): CodingAgentRequest {
  return {
    runId: "run_fixture",
    documentId: "doc_fixture",
    baseRevision: 0,
    prompt,
    selectedNodeIds: [],
    documentFragment: { documentId: "doc_fixture", revision: 0, nodes: {}, tokens: {}, components: {} },
    resolvedContext: [],
    operationCapabilities: ["node.create", "node.delete", "node.move", "property.set", "layout.set", "style.set"],
  };
}

async function collect(adapter: CodexCliAdapter, input: CodingAgentRequest) {
  const events: Array<RunEvent | { type: "response"; response: { operations: unknown[]; summary?: string } }> = [];
  for await (const event of adapter.execute(input, new AbortController().signal)) events.push(event);
  return events;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CodexCliAdapter", () => {
  it("runs the real CLI process boundary with bounded flags and carries prompts on stdin", async () => {
    const { adapter, root } = await createAdapter();
    const marker = join(root, "must-not-exist");
    const events = await collect(adapter, request("Treat this as data: $(touch " + marker + ")"));

    expect(events.some((event) => event.type === "response" && event.response.operations.length === 0)).toBe(true);
    expect(events.some((event) => event.type === "state" && event.state === "RUNNING")).toBe(true);
    expect(events.some((event) => event.type === "state" && event.state === "VALIDATING_OPERATIONS")).toBe(true);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await adapter.getStatus("run_fixture")).state).toBe("VALIDATING_OPERATIONS");
  });

  it("selects a per-run model and effort while disabling model-triggered command access", async () => {
    const { root } = await createAdapter();
    const adapter = new CodexCliAdapter({ executable: join(root, "codex-fixture"), tempRoot: root, effort: "high" });
    const events = await collect(adapter, request("__fixture_effort_high__"));
    expect(events.some((event) => event.type === "response" && event.response.operations.length === 0)).toBe(true);
  });

  it("logs an API key into a private run-local Codex home through stdin before exec", async () => {
    const { root } = await createAdapter();
    const adapter = new CodexCliAdapter({ executable: join(root, "codex-fixture"), tempRoot: root, authSource: "openai-api-key", credential: "fixture-api-key" });
    const events = await collect(adapter, request());
    expect(events.some((event) => event.type === "response" && event.response.operations.length === 0)).toBe(true);
    const runHomes = await import("node:fs/promises").then(({ readdir }) => readdir(root));
    expect(runHomes.some((name) => name.startsWith("codex-design-run-"))).toBe(false);
  });

  it.each([
    ["__fixture_auth__", "auth.rejected"],
    ["__fixture_quota__", "provider.quota"],
    ["__fixture_unsupported_model__", "provider.unsupported"],
  ])("maps recognized provider failures to safe categories", async (prompt, code) => {
    const { adapter } = await createAdapter();
    await expect(async () => {
      for await (const event of adapter.execute(request(prompt), new AbortController().signal)) if (event.type === "response") throw new Error("Unexpected response");
    }).rejects.toMatchObject({ code, message: expect.not.stringContaining("private fixture detail") });
  });

  it("rejects operations outside the negotiated capability set", async () => {
    const { adapter } = await createAdapter();
    const events: RunEvent[] = [];
    await expect(async () => {
      for await (const event of adapter.execute(request("__fixture_unsupported__"), new AbortController().signal)) {
        if (event.type !== "response") events.push(event);
      }
    }).rejects.toMatchObject({ code: "protocol.capability" });
    expect(events.some((event) => event.type === "diagnostic" && event.diagnostic.code === "protocol.capability")).toBe(true);
    expect((await adapter.getStatus("run_fixture")).state).toBe("FAILED");
  });

  it("terminates on timeout and reports a failed process lifecycle", async () => {
    const { adapter } = await createAdapter({ timeoutMs: 300 });
    const events: RunEvent[] = [];
    await expect(async () => {
      for await (const event of adapter.execute(request("__fixture_hang__"), new AbortController().signal)) {
        if (event.type !== "response") events.push(event);
      }
    }).rejects.toMatchObject({ code: "agent.timeout" });
    expect(events.some((event) => event.type === "diagnostic" && event.diagnostic.code === "agent.timeout")).toBe(true);
    expect((await adapter.getStatus("run_fixture")).state).toBe("FAILED");
  });

  it("preserves an explicitly configured deadline for full-page generation", async () => {
    const { adapter } = await createAdapter({ timeoutMs: 300 });
    await expect(async () => {
      for await (const event of adapter.execute(request("Generate a puppy store design __fixture_hang__"), new AbortController().signal)) {
        if (event.type === "response") throw new Error("Unexpected response");
      }
    }).rejects.toMatchObject({ code: "agent.timeout" });
    expect((await adapter.getStatus("run_fixture")).state).toBe("FAILED");
  });

  it("cancels a live process without returning a design response", async () => {
    const { adapter } = await createAdapter();
    const events: RunEvent[] = [];
    const execution = (async () => {
      for await (const event of adapter.execute(request("__fixture_hang__"), new AbortController().signal)) {
        if (event.type !== "response") events.push(event);
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await adapter.cancel("run_fixture");
    await execution;
    expect(events.some((event) => event.type === "state" && event.state === "CANCELLED")).toBe(true);
    expect((await adapter.getStatus("run_fixture")).state).toBe("CANCELLED");
  });
});
