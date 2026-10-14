# Generation runtime correction evidence

## Scope

This note records the runtime corrections prompted by the 2026-10-05 visible dogfooding review. It covers the Codex process boundary, typed failure propagation, bounded timeout configuration, cancellation teardown, and durable run diagnostics. It does not claim that a generated design is visually complete; headed full-screen trials remain with the coordinator after integration.

## Changes

- The default process deadline is 300 seconds. `CODEX_DESIGN_GENERATION_TIMEOUT_MS` configures 30,000 through 600,000 milliseconds, and invalid values stop server startup with a clear configuration error.
- The adapter raises `CodingAgentError` through the domain port. Timeout guidance asks users to generate a smaller section and confirms the saved design remains; server configuration names stay in developer documentation. The adapter converts protocol parser codes to a fixed allowlist of safe messages, omits stderr contents and raw process errors, and the application persists the code/message as a run diagnostic.
- On POSIX, the adapter launches Codex in an owned process group and escalates cancellation from `SIGTERM` to `SIGKILL` after the configured grace period. Windows keeps direct-child termination. Cancellation before commit leaves the document unchanged; the existing committed-revision guard preserves a completed commit and leaves it in rendering/QA.
- The request prompt now describes typed operation objects matching the response schema.

## Automated evidence

`tests/adapters/generation-runtime.test.ts` covers the five-minute default, timeout code, nonzero exit without stderr leakage, protocol error mapping, and cancellation of an owned process group with a SIGTERM-resistant descendant. `tests/integration/generation-runtime.test.ts` covers persistence/reopen of the actionable timeout failure and the bounded environment setting.

The focused run passed 7 tests across those two files. Strict application, server, and test TypeScript checks passed. These tests establish adapter and lifecycle contracts only; the separate real Codex/browser trials establish prompt-to-design acceptance.

## Discovery note

The configured Codebase semantic query for the complete start/cancel/persist error path ranked unrelated symbols above the runtime implementation. Its results were not treated as evidence of absence. Source inspection verified `CodexCliAdapter`, `ProjectService`, the local run store, server construction, and the existing integration lifecycle directly. The post-edit Codebase refresh indexed 1,490 nodes / 4,628 edges with no unusable files; it retained the two documented parser-partial test mock expressions in `persistence-faults.test.ts` and `run-store.test.ts`.
