import type { ProviderConnectionService, ProviderConnectionInput, ProviderConnectionUpdate } from '../src/domain/providers';
import { isProviderId, validateProviderSelection } from '../src/domain/providers';
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProjectService } from "../src/application/project-service";

const MAX_BODY_BYTES = 1_048_576;
const ALLOWED_HOSTS = new Set(["127.0.0.1:5174", "localhost:5174"]);
const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173", "http://127.0.0.1:5173",
  "http://localhost:5174", "http://127.0.0.1:5174",
]);
const EXTENSION_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2",
};

export type LocalApiService = Pick<ProjectService,
  "getProject" | "getCapabilities" | "createProject" | "apply" | "startRun" | "getRun" | "listRuns" |
  "cancelRun" | "acknowledgeRender" | "undo" | "redo" | "snapshot" | "restore" | "export"
> & Partial<Pick<ProjectService, "listProjects" | "previewProject" | "openProject" | "removeProject">>;

export type RouterOptions = { staticDirectory?: string; maxBodyBytes?: number; providers?: ProviderConnectionService };

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function validReferenceId(value: unknown): value is string {
  // Body size is bounded by readJson; semantic IDs are opaque values, not paths.
  return typeof value === "string" && value.trim().length > 0;
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    throw Object.assign(new Error("Use application/json for this request."), { status: 415, code: "request.content_type" });
  }
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) {
    throw Object.assign(new Error("Request body exceeds the configured size limit."), { status: 413, code: "request.too_large" });
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > limit) throw Object.assign(new Error("Request body exceeds the configured size limit."), { status: 413, code: "request.too_large" });
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { status: 400, code: "request.invalid_json" });
  }
}

function assertObject(value: unknown, fields: readonly string[], required: readonly string[] = fields): Record<string, unknown> {
  if (!isRecord(value) || !hasOnlyKeys(value, fields) || required.some((key) => !(key in value))) {
    throw Object.assign(new Error("Request fields are invalid."), { status: 400, code: "request.invalid_shape" });
  }
  return value;
}

function expectedRevision(body: Record<string, unknown>): number {
  const revision = body.expectedRevision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
    throw Object.assign(new Error("expectedRevision must be a non-negative safe integer."), { status: 400, code: "revision.invalid" });
  }
  return revision as number;
}

function localBoundaryError(request: IncomingMessage, mutating: boolean): { status: number; code: string; message: string } | undefined {
  const host = request.headers.host?.toLowerCase();
  if (!host || !ALLOWED_HOSTS.has(host)) return { status: 403, code: "request.host", message: "This local endpoint accepts requests only from the configured local host." };
  if (request.headers.origin !== undefined && !ALLOWED_ORIGINS.has(request.headers.origin)) {
    return { status: 403, code: "request.origin", message: "This local endpoint rejects cross-origin requests." };
  }
  if (mutating && request.headers.origin === undefined) {
    return { status: 403, code: "request.origin_required", message: "A local browser origin is required for changes." };
  }
  return undefined;
}

async function serveStatic(request: IncomingMessage, response: ServerResponse, root: string): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  let pathname: string;
  try { pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname); }
  catch { sendJson(response, 400, errorBody("request.path", "Invalid URL path.")); return true; }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = resolve(root, relative);
  if (file !== root && !file.startsWith(root + sep)) {
    sendJson(response, 404, errorBody("file.not_found", "File was not found."));
    return true;
  }
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
    if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) return false;
    const info = await stat(realFile);
    if (!info.isFile()) return false;
    response.writeHead(200, {
      "content-type": EXTENSION_TYPES[extname(file)] ?? "application/octet-stream",
      "content-length": info.size,
      "x-content-type-options": "nosniff",
      "cache-control": extname(file) === ".html" ? "no-store" : "public, max-age=3600",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(realFile).pipe(response);
    return true;
  } catch {
    return false;
  }
}

function applicationError(error: unknown): { status: number; body: unknown } {
  const value = error as { code?: unknown; message?: unknown; diagnostics?: unknown };
  const code = typeof value?.code === "string" ? value.code : "request.failed";
  const message = typeof value?.message === "string" ? value.message : "The request could not be completed.";
  const status = code === "revision.conflict" ? 409 :
    code === "run.busy" ? 409 :
    code === "project.busy" || code === "project.lock" ? 409 :
    code === "project.missing" ? 404 :
    code === "project.invalid-id" || code === "project.unsafe-entry" ? 400 :
    code === "project.library_unavailable" ? 503 :
    code === "history.empty" || code === "export.unavailable" ? 422 :
    code === "run.missing" || code === "snapshot.missing" ? 404 : 422;
  return { status, body: { error: { code, message, ...(Array.isArray(value?.diagnostics) ? { diagnostics: value.diagnostics } : {}) } } };
}

export function createLocalApiHandler(service: LocalApiService, options: RouterOptions = {}) {
  const bodyLimit = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const staticRoot = options.staticDirectory ? resolve(options.staticDirectory) : undefined;
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const pathname = (() => { try { return new URL(request.url ?? "/", "http://localhost").pathname; } catch { return ""; } })();
    const mutating = ["POST", "PATCH", "DELETE", "PUT"].includes(request.method ?? "");
    const boundaryError = localBoundaryError(request, mutating);
    if (boundaryError) { sendJson(response, boundaryError.status, errorBody(boundaryError.code, boundaryError.message)); return; }
    if (pathname.startsWith("/api/")) {
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("cache-control", "no-store");
      try {
        if (request.method === "GET" && pathname === "/api/project") {
          sendJson(response, 200, { project: service.getProject() }); return;
        }
        if (request.method === "GET" && pathname === "/api/projects") {
          if (!service.listProjects) throw Object.assign(new Error('Project discovery is unavailable.'), { code: 'project.library_unavailable' });
          sendJson(response, 200, { projects: await service.listProjects() }); return;
        }
        const projectMatch = /^\/api\/projects\/([^/]+)(?:\/(preview|open))?$/.exec(pathname);
        if (projectMatch) {
          const id = projectMatch[1]!;
          if (!validId(id)) throw Object.assign(new Error('Project identifier is invalid.'), { status: 400, code: 'project.invalid-id' });
          if (request.method === 'GET' && projectMatch[2] === 'preview') {
            if (!service.previewProject) throw Object.assign(new Error('Project previews are unavailable.'), { code: 'project.library_unavailable' });
            sendJson(response, 200, { document: await service.previewProject(id) }); return;
          }
          if (request.method === 'POST' && projectMatch[2] === 'open') {
            assertObject(await readJson(request, bodyLimit), []);
            if (!service.openProject) throw Object.assign(new Error('Project opening is unavailable.'), { code: 'project.library_unavailable' });
            sendJson(response, 200, { project: await service.openProject(id) }); return;
          }
          if (request.method === 'DELETE' && !projectMatch[2]) {
            if (!service.removeProject) throw Object.assign(new Error('Project removal is unavailable.'), { code: 'project.library_unavailable' });
            sendJson(response, 200, { deleted: true, project: await service.removeProject(id) }); return;
          }
        }
        if (request.method === "GET" && pathname === "/api/capabilities") {
          sendJson(response, 200, service.getCapabilities()); return;
        }
        if (request.method === "POST" && pathname === "/api/project/new") {
          const body = assertObject(await readJson(request, bodyLimit), ["name"]);
          if (typeof body.name !== "string") throw Object.assign(new Error("name must be a string."), { status: 400, code: "project.name" });
          sendJson(response, 201, { project: await service.createProject(body.name) }); return;
        }
        if (request.method === "POST" && pathname === "/api/operations") {
          const body = assertObject(await readJson(request, bodyLimit), ["batch"]);
          const result = await service.apply(body.batch);
          const status = result.result.status === "rejected"
            ? result.result.diagnostics.some((item) => item.code === "revision.conflict") ? 409 : 422
            : 200;
          sendJson(response, status, result); return;
        }
        if (pathname === '/api/providers' && request.method === 'GET') {
          if (!options.providers) { sendJson(response, 404, errorBody('provider.unavailable', 'Provider connections are unavailable.')); return; }
          const providers = await Promise.all(['codex', 'claude', 'minimax'].filter(isProviderId).map(id => options.providers!.catalog(id)));
          sendJson(response, 200, { providers }); return;
        }
        if (pathname === '/api/connections') {
          if (!options.providers) { sendJson(response, 404, errorBody('provider.unavailable', 'Provider connections are unavailable.')); return; }
          if (request.method === 'GET') { sendJson(response, 200, { connections: await options.providers.list(), cleanupPending: (await options.providers.cleanupStatus()).pending }); return; }
          if (request.method === 'POST') {
            const body = assertObject(await readJson(request, bodyLimit), ['providerId', 'authSource', 'label', 'credential'], ['providerId', 'authSource', 'label']);
            sendJson(response, 201, { connection: await options.providers.create(body as ProviderConnectionInput) }); return;
          }
        }
        const connectionMatch = /^\/api\/connections\/([A-Za-z0-9_-]{1,128})(?:\/(verify))?$/.exec(pathname);
        if (connectionMatch) {
          if (!options.providers) { sendJson(response, 404, errorBody('provider.unavailable', 'Provider connections are unavailable.')); return; }
          const id = connectionMatch[1]!;
          if (!connectionMatch[2] && request.method === 'PATCH') {
            const body = assertObject(await readJson(request, bodyLimit), ['label', 'credential'], []);
            sendJson(response, 200, { connection: await options.providers.update(id, body as ProviderConnectionUpdate) }); return;
          }
          if (!connectionMatch[2] && request.method === 'DELETE') { await options.providers.delete(id); sendJson(response, 200, { deleted: true }); return; }
          if (connectionMatch[2] === 'verify' && request.method === 'POST') {
            const body = assertObject(await readJson(request, bodyLimit), ['modelId', 'effort'], ['modelId', 'effort']);
            const parsed = validateProviderSelection({ connectionId: id, ...body });
            if (!parsed.ok) { sendJson(response, 400, errorBody(parsed.code, parsed.message)); return; }
            sendJson(response, 200, { connection: await options.providers.verify(id, { modelId: parsed.value.modelId, effort: parsed.value.effort }) }); return;
          }
        }
        if (request.method === "GET" && pathname === "/api/runs") {
          sendJson(response, 200, { runs: service.listRuns() }); return;
        }
        if (request.method === "POST" && pathname === "/api/runs") {
          const body = assertObject(await readJson(request, bodyLimit), ["prompt", "selectedNodeIds", "expectedRevision", "pageId", "providerSelection"], ["prompt", "selectedNodeIds", "expectedRevision"]);
          if (body.pageId !== undefined && !validReferenceId(body.pageId)) throw Object.assign(new Error("Page ID is invalid."), { status: 400, code: "run.page" });
          if (typeof body.prompt !== "string" || !Array.isArray(body.selectedNodeIds) || !body.selectedNodeIds.every(validReferenceId)) {
            throw Object.assign(new Error("Run request fields are invalid."), { status: 400, code: "run.invalid_request" });
          }
          const selection = body.providerSelection === undefined ? undefined : validateProviderSelection(body.providerSelection);
          if (selection && !selection.ok) { sendJson(response, 400, errorBody(selection.code, selection.message)); return; }
          const result = await service.startRun(body.prompt, body.selectedNodeIds as string[], expectedRevision(body), body.pageId as string | undefined, selection?.ok ? selection.value : undefined);
          sendJson(response, 202, result); return;
        }
        const runMatch = /^\/api\/runs\/([A-Za-z0-9_-]{1,128})(?:\/(cancel|rendered))?$/.exec(pathname);
        if (runMatch && validId(runMatch[1]!)) {
          if (request.method === "GET" && !runMatch[2]) { sendJson(response, 200, service.getRun(runMatch[1]!)); return; }
          if (request.method === "POST" && runMatch[2] === "cancel") {
            assertObject(await readJson(request, bodyLimit), []);
            sendJson(response, 200, { run: await service.cancelRun(runMatch[1]!) }); return;
          }
          if (request.method === "POST" && runMatch[2] === "rendered") {
            const body = assertObject(await readJson(request, bodyLimit), ["revision", "success", "message"], ["revision", "success"]);
            if (!Number.isSafeInteger(body.revision) || typeof body.success !== "boolean" || (body.message !== undefined && typeof body.message !== "string")) {
              throw Object.assign(new Error("Render acknowledgement fields are invalid."), { status: 400, code: "render.invalid_request" });
            }
            const run = await service.acknowledgeRender(runMatch[1]!, body.revision as number, body.success, body.message as string | undefined);
            sendJson(response, 200, { run }); return;
          }
        }
        if (request.method === "POST" && pathname === "/api/history/undo") {
          const body = assertObject(await readJson(request, bodyLimit), ["expectedRevision"]);
          sendJson(response, 200, { project: await service.undo(expectedRevision(body)) }); return;
        }
        if (request.method === "POST" && pathname === "/api/history/redo") {
          const body = assertObject(await readJson(request, bodyLimit), ["expectedRevision"]);
          sendJson(response, 200, { project: await service.redo(expectedRevision(body)) }); return;
        }
        if (request.method === "POST" && pathname === "/api/snapshots") {
          const body = assertObject(await readJson(request, bodyLimit), ["label", "expectedRevision"]);
          if (typeof body.label !== "string") throw Object.assign(new Error("label must be a string."), { status: 400, code: "snapshot.label" });
          sendJson(response, 200, { project: await service.snapshot(body.label, expectedRevision(body)) }); return;
        }
        const restoreMatch = /^\/api\/snapshots\/([A-Za-z0-9_-]{1,128})\/restore$/.exec(pathname);
        if (request.method === "POST" && restoreMatch) {
          const body = assertObject(await readJson(request, bodyLimit), ["expectedRevision"]);
          sendJson(response, 200, { project: await service.restore(restoreMatch[1]!, expectedRevision(body)) }); return;
        }
        if (request.method === "POST" && pathname === "/api/export") {
          const body = assertObject(await readJson(request, bodyLimit), ["target"]);
          if (body.target !== "native" && body.target !== "vue" && body.target !== "figma") {
            throw Object.assign(new Error("Export target is invalid."), { status: 400, code: "export.target" });
          }
          sendJson(response, 200, await service.export(body.target)); return;
        }
        if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE") {
          response.setHeader("allow", pathname.startsWith("/api/") ? "GET, POST, DELETE" : "GET, HEAD");
          sendJson(response, 405, errorBody("request.method", "Method is not supported.")); return;
        }
        sendJson(response, 404, errorBody("route.not_found", "API route was not found."));
      } catch (error) {
        const status = typeof (error as { status?: unknown })?.status === "number"
          ? (error as { status: number }).status
          : applicationError(error).status;
        const body = typeof (error as { status?: unknown })?.status === "number"
          ? errorBody(String((error as { code?: unknown }).code ?? "request.invalid"), String((error as { message?: unknown }).message ?? "Invalid request."))
          : applicationError(error).body;
        sendJson(response, status, body);
      }
      return;
    }
    if (staticRoot && await serveStatic(request, response, staticRoot)) return;
    if (request.method === "GET" && staticRoot) {
      try {
        const html = await readFile(join(staticRoot, "index.html"));
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        response.end(html);
        return;
      } catch { /* handled below */ }
    }
    sendJson(response, 404, errorBody("route.not_found", "Route was not found."));
  };
}
