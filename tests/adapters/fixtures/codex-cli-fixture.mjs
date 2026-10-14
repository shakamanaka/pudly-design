import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { setInterval } from "node:timers";

const args = process.argv.slice(2);
if (args[0] === "login") {
  let credential = "";
  for await (const chunk of process.stdin) credential += chunk;
  if (args[1] !== "--with-api-key" || credential !== "fixture-api-key" || !process.env.CODEX_HOME || process.env.OPENAI_API_KEY) {
    process.stderr.write("Isolated stdin API-key login contract failed.\n");
    process.exit(2);
  }
  await writeFile(join(process.env.CODEX_HOME, "fixture-auth-ready"), "ready", { mode: 0o600 });
  process.exit(0);
}
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const resultPath = valueAfter("--output-last-message");
const schemaPath = valueAfter("--output-schema");
const prompt = await new Promise((resolve) => {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => resolve(input));
});

if (!prompt.includes('DESIGN BRIEF') || !prompt.includes('USER DESIGN INTENT (authorized for design decisions)')) {
  process.stderr.write('The Codex design brief or authorized user intent was missing.\n');
  process.exit(2);
}

const configs = args.flatMap((value, index) => value === "-c" ? [args[index + 1]] : []);
if (process.env.CODEX_HOME && process.env.CODEX_HOME.includes("codex-home") && process.env.CODEX_HOME !== process.env.HOME) {
  try { await readFile(join(process.env.CODEX_HOME, "fixture-auth-ready"), "utf8"); }
  catch { process.stderr.write("Isolated API-key login did not precede exec.\n"); process.exit(2); }
  if (process.env.OPENAI_API_KEY) { process.stderr.write("API key leaked into exec environment.\n"); process.exit(2); }
}
if (valueAfter("--model") !== "gpt-6.1-sol" || !configs.includes(prompt.includes("__fixture_effort_high__") ? 'model_reasoning_effort="high"' : 'model_reasoning_effort="low"') || !configs.includes("features.shell_tool=false") || !configs.includes("features.unified_exec=false") || !configs.includes('shell_environment_policy.inherit="none"') || !resultPath || !schemaPath || !args.includes("--ephemeral") ||
    !args.includes("--ignore-user-config") || !args.includes("--sandbox") ||
    args[args.indexOf("--sandbox") + 1] !== "read-only" || !args.includes("--json")) {
  process.stderr.write("Required Codex CLI flags were missing.\n");
  process.exit(2);
}

await readFile(schemaPath, "utf8");
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fixture-thread" }) + "\n");
process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\n");

if (prompt.includes("__fixture_hang__")) {
  await new Promise(() => { setInterval(() => {}, 60_000); });
} else if (prompt.includes("__fixture_fail__")) {
  process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: "fixture failure" } }) + "\n");
  process.exit(1);
} else if (prompt.includes("__fixture_quota__")) {
  process.stdout.write(JSON.stringify({ type: "turn.failed", code: "quota_exceeded", error: { message: "private fixture detail" } }) + "\n");
  process.exit(1);
} else if (prompt.includes("__fixture_unsupported_model__")) {
  process.stdout.write(JSON.stringify({ type: "turn.failed", code: "unsupported_model", error: { message: "private fixture detail" } }) + "\n");
  process.exit(1);
} else if (prompt.includes("__fixture_auth__")) {
  process.stdout.write(JSON.stringify({ type: "turn.failed", code: "invalid_api_key", error: { message: "private fixture detail" } }) + "\n");
  process.exit(1);
} else if (prompt.includes("__fixture_unsupported__")) {
  await writeFile(resultPath, JSON.stringify({ operations: [{ type: "page.delete", pageId: "page_1" }], summary: "unsupported operation" }));
} else {
  await writeFile(resultPath, JSON.stringify({ operations: [], summary: "fixture response" }));
}
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\n");
