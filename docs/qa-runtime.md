# Runtime lifecycle and adapter QA

## Scope and evidence

This review covers the Codex CLI adapter, local API boundary, run context and application transaction lifecycle. The controlled-agent tests in `tests/integration/run-lifecycle.test.ts` exercise the application contract; they do not qualify as real Codex generation evidence.

The controlled suite covers pre-commit cancellation, post-commit cancellation, stale responses, out-of-scope atomic rejection, nested subtree creation under a selected container, and render acknowledgement/QA with history linkage. After the scope correction in `src/domain/operations.ts`, all 6 lifecycle tests passed. `npm run lint` passed. `npm run typecheck` currently fails in `src/adapters/persistence/local-files.ts` at lines 28 and 158 (`override` modifier and `unknown` narrowing); that file was outside this QA ownership.

The indexed Codebase MCP search retrieved the adapter and service symbols in `src/adapters/codex/codex-cli-adapter.ts` and `src/application/project-service.ts`. Those results were checked against the source. Its separate literal-code search was issued with a regex alternation while regex mode was off and returned no matches; no conclusion was drawn from that search.

## Findings and corrections

- **Nested selected-subtree creation was rejected.** `node.create` checks its parent against the original selection scope, so a second create could not target the first newly-created frame/group. That contradicted the adapter’s parent-before-child instruction and the operation contract requiring empty child lists followed by child operations. `applyBatch` now tracks node IDs only after successful placement and permits subsequent operations on those newly created nodes. Existing page and parent checks still govern placement; unrelated pre-existing nodes remain rejected. The integration test also verifies that a later out-of-scope operation rejects the entire batch without partial edits.
- **Agent history linkage is retained.** `ProjectService.commit` now copies `batch.runId` to the `HistoryEntry`. The integration case verifies the persisted history entry and audit transition reference the successful run and batch.
- **Stale revision details are retained in the run record.** The stale-response integration case verifies that `revision.conflict` remains in `validationResults` and the intervening user edit remains the committed document. One reporting gap remains: `ProjectService.execute` converts any rejected apply result to `agent.rejected` before `fail` emits the run diagnostic (`src/application/project-service.ts`, lines 211–213). API consumers inspecting only the diagnostic event lose the stable `revision.conflict` code even though the run record retains it. Preserve the original diagnostic code when translating the rejection.
- **Selection context assumes the first page.** `buildContext` always picks `document.pageOrder[0]` for the page fragment and resolved page scope (`src/application/context.ts`, lines 18–21 and 30–39), even when selected nodes belong to another page. A selection on a later page therefore receives a mismatched page ID/root list, which can make valid placement proposals fail page ownership checks. Resolve the page from the selected nodes (or include each relevant page explicitly) and add a multi-page selection test.

## Adapter and server review

The Codex adapter invokes an executable with an argument array, `shell: false`, a temporary working directory, read-only sandboxing, and the prompt on stdin (`src/adapters/codex/codex-cli-adapter.ts`). It caps prompt and combined process output, separately caps the structured response file, and terminates on timeout/cancellation. The local server binds to `127.0.0.1`; its router constrains Host and Origin, requires an Origin on mutations, rejects unknown request fields, and bounds JSON bodies (`server/index.ts` and `server/router.ts`). Run records expose request/operation data for inspection but no process paths or credentials.

Cancellation linearization is covered at both sides of commit: before commit, abort leaves revision and content unchanged; after commit, cancellation leaves the run in rendering and preserves the committed revision, after which render acknowledgement can complete QA. Stale proposals and unauthorized targets preserve the newer/current document atomically.

## Real Codex gate

The coordinator’s first live Codex attempt returned a `node.create` missing required `pageId`, `index`, and `node`, leaving the document unchanged. After adding explicit operation examples and field guidance in `src/adapters/codex/operation-reference.ts`, a later live attempt committed revision 1. At the time of this report, that run had not yet received renderer acknowledgement, so prompt-to-render acceptance remains unverified. A process exit or committed revision alone does not satisfy the real-generation gate.
