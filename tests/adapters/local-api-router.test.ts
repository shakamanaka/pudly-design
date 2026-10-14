import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalApiHandler, type LocalApiService } from "../../server/router";

const servers: Array<ReturnType<typeof createServer>> = [];

async function startRouter(maxBodyBytes = 1024) {
  const service = {
    getProject: () => null,
    getCapabilities: () => ({ operationTypes: ["node.create"], exportTargets: ["native"], nodeKinds: ["frame"] }),
    startRun: async () => ({ runId: 'test-run' }),
  } as unknown as LocalApiService;
  const server = createServer(createLocalApiHandler(service, { maxBodyBytes }));
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address() as AddressInfo;
}

function send(port: number, method: string, path: string, options: {
  origin?: string;
  body?: string;
} = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers: {
        host: "127.0.0.1:5174",
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.body !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(options.body) } : {}),
      },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("local API request boundary", () => {
  it("accepts opaque semantic references in bounded JSON without treating them as paths", async () => {
    const { port } = await startRouter();
    const result = await send(port, 'POST', '/api/runs', { origin: 'http://localhost:5173', body: JSON.stringify({ prompt: 'Edit selection', selectedNodeIds: ['hero.heading', 'action:label', 'café'], expectedRevision: 0, pageId: 'page.one' }) });
    expect(result.status).toBe(202);
  });
  it("serves capabilities only on the expected local host", async () => {
    const { port } = await startRouter();
    const result = await send(port, "GET", "/api/capabilities");
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ operationTypes: ["node.create"], exportTargets: ["native"] });
    const wrongHost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port, method: "GET", path: "/api/project", headers: { host: "attacker.example" } }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      });
      request.on("error", reject);
      request.end();
    });
    expect(wrongHost).toBe(403);
  });

  it("rejects cross-origin, originless, and oversized mutation requests", async () => {
    const { port } = await startRouter(16);
    const crossOrigin = await send(port, "POST", "/api/project/new", { origin: "https://attacker.example", body: "{\"name\":\"x\"}" });
    expect(crossOrigin.status).toBe(403);
    const originless = await send(port, "POST", "/api/project/new", { body: "{\"name\":\"x\"}" });
    expect(originless.status).toBe(403);
    const oversized = await send(port, "POST", "/api/project/new", { origin: "http://localhost:5173", body: "{\"name\":\"name is too long\"}" });
    expect(oversized.status).toBe(413);
  });
});
