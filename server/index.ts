import { CodingAgentError } from '../src/domain/agent-error';
import { LocalProviderConnectionService } from '../src/adapters/providers';
import type { ProviderConnectionService } from '../src/domain/providers';
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexCliAdapter, DEFAULT_GENERATION_TIMEOUT_MS } from "../src/adapters/codex/index";
import { NativeExporter } from "../src/adapters/export/native";
import { FigmaExporter } from "../src/adapters/export/figma";
import { VueExporter } from '../src/adapters/export/vue';
import { BundledExporter } from '../src/adapters/export/bundle';
import { LocalDesignPersistence } from "../src/adapters/persistence/local-files";
import { LocalAgentRunStore } from "../src/adapters/persistence/local-run-store";
import { ProjectService } from "../src/application/project-service";
import { createLocalApiHandler } from "./router";

export type LocalServerOptions = { dataDirectory?: string; staticDirectory?: string; providers?: ProviderConnectionService };
const MIN_GENERATION_TIMEOUT_MS = 30_000;
const MAX_GENERATION_TIMEOUT_MS = 600_000;

export function generationTimeoutFromEnvironment(value = process.env.CODEX_DESIGN_GENERATION_TIMEOUT_MS): number {
  if (value === undefined || value.trim() === "") return DEFAULT_GENERATION_TIMEOUT_MS;
  if (!/^[0-9]+$/.test(value)) throw new RangeError("CODEX_DESIGN_GENERATION_TIMEOUT_MS must be an integer from 30000 through 600000.");
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < MIN_GENERATION_TIMEOUT_MS || timeout > MAX_GENERATION_TIMEOUT_MS) {
    throw new RangeError("CODEX_DESIGN_GENERATION_TIMEOUT_MS must be an integer from 30000 through 600000.");
  }
  return timeout;
}

/** Preserve editor access when connection metadata cannot be recovered; never route to a fallback account. */
export async function openProviderRegistry(dataDirectory: string): Promise<ProviderConnectionService> {
  try { return await LocalProviderConnectionService.open(dataDirectory); }
  catch {
    const unavailable = () => Promise.reject(new CodingAgentError('provider.recovery', 'Saved provider connections could not be recovered. Their files were preserved. Design editing remains available; provider generation is disabled until the connection data is repaired.'));
    return { list: unavailable, create: unavailable, update: unavailable, delete: unavailable, verify: unavailable, catalog: unavailable, resolve: unavailable, cleanupStatus: unavailable };
  }
}

export async function startServer(options: LocalServerOptions = {}): Promise<ReturnType<typeof createServer>> {
  const root = process.cwd();
  const dataDirectory = options.dataDirectory ?? join(root, ".codex-design", "projects");
  const persistence = new LocalDesignPersistence(dataDirectory);
  const providers = options.providers ?? await openProviderRegistry(join(dataDirectory, "provider-connections"));
  const agent = new CodexCliAdapter({ timeoutMs: generationTimeoutFromEnvironment() });
  const service = await ProjectService.open(persistence, agent, new LocalAgentRunStore(join(dataDirectory, "runs")), providers);
  service.registerExporter("native", new NativeExporter());
  service.registerExporter("figma", new FigmaExporter());
  service.registerExporter('vue', new BundledExporter(new VueExporter(), 'codex-design-vue.zip'));
  const dist = options.staticDirectory ?? join(root, "dist");
  const server = createServer(createLocalApiHandler(service, { ...(existsSync(dist) ? { staticDirectory: dist } : {}), providers }));
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(5174, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void startServer().then((server) => {
    server.on("error", (error) => {
      process.stderr.write("Local server failed: " + error.message + "\n");
      process.exitCode = 1;
    });
    process.stdout.write("Codex Design server listening on http://127.0.0.1:5174\n");
  }).catch((error: unknown) => {
    process.stderr.write("Could not start Codex Design server: " + (error instanceof Error ? error.message : "unknown error") + "\n");
    process.exitCode = 1;
  });
}
