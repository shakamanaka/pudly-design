# Independent final QA audit

Date: 2026-10-05

Scope: read-only audit of production source for the active `design-engine-foundation` change. Production files were not edited. The repository index reported `ready` at `2026-10-05T04:37:19Z` (1,252 nodes, 3,841 edges); semantic results for `applyBatch`, `validateDocument`, and related source were verified against the files below. The index marked two new persistence tests parser-partial, so those tests were reviewed as text.

## Finding 1: sparse-array transaction crash

**Malformed sparse operation arrays escape validation and crash the transaction API.** `inspectJsonGraph` builds array children with `Array.map` (`src/domain/validation-utils.ts:108-110`), which skips holes. `parseBatch` then validates operations using `forEach` (`src/domain/operations.ts:132-139`), which also skips holes. A batch whose `operations` is `new Array(1)` therefore passes parsing. `applyBatch` iterates the resulting array with `.entries()` and calls `applyOne` (`src/domain/operations.ts:374-381`); `applyOne` immediately reads `operation.type` (`src/domain/operations.ts:253`), so the caller receives an uncaught `TypeError` instead of a rejected `ApplyResult`.

The initial audit reproduced this on the pre-fix source with Node 22 and `tsx`:

```text
parseBatch({ ..., operations: new Array(1) }) -> { ok: true, ... }
applyBatch(createDocument('x'), batch, []) -> TypeError: Cannot read properties of undefined (reading 'type')
```

The coordinator changed `inspectJsonGraph` to reject missing array indices and bound array length before walking it, added an early operation-count rejection in `parseBatch`, and added a regression in `tests/domain/opaque-ids.test.ts` covering both a one-element hole and a billion-length sparse array. The focused regressions passed after the full check: `vitest run tests/domain/opaque-ids.test.ts tests/export/export-audit.test.ts` (17 tests, 2 files). A separate 501-operation batch returned `limit.operations` in 0.89 ms. The structural guard rejects the billion-length sparse test without iterating its indexes. This was a runtime robustness defect for in-process callers that pass malformed JavaScript data; the HTTP JSON parser cannot represent sparse arrays, so the original repro did not establish a remote JSON exploit.

## Finding 2: Figma image and icon kind fidelity overclaims preservation

The original mismatch was confirmed: `fidelityFor` had marked `node-kind:image` and `node-kind:icon` as `preserved` while the importer returned `null` for both. The coordinator now handles those kinds first, emits omitted node-kind and asset entries, and skips layout/style preservation claims (`src/adapters/export/figma.ts:161-164`). The new regression in `tests/export/export-audit.test.ts` verifies omitted kind entries, no preserved claims for those nodes, and no created target layers. It passed in the focused run above.

## Audited behavior and limits

- Document validation checks JSON graph size/depth, exact shape, scalar metadata, node/page limits, and own page references; operation parsing checks runtime operation shapes, capability membership, and byte/count limits. `applyBatch` validates the base document, applies to a detached draft, validates after each operation, enforces scope, and increments revision only after a successful final validation. The sparse-array gap above is the observed exception to that rejection boundary.
- Own-property checks are used for page-order references, operation targets, component root/template lookup, and property resolution. Opaque IDs such as `toString` are covered by `tests/domain/opaque-ids.test.ts`; its cases were checked against actual source. Dangerous keys are rejected recursively.
- Component-instance slot children, property overrides, variants, bindings, and template trees receive structural and semantic checks in `src/domain/component-validation.ts`; malformed operation payloads and non-scalar metadata have existing coverage in `tests/domain/malformed-values.test.ts`. These checks were source-reviewed, not exhaustively fuzzed.
- Corrupt project envelopes fail before replacing stored project bytes in `src/adapters/persistence/local-files.ts`. Corrupt run records are rejected and preserved by `src/adapters/persistence/local-run-store.ts`; `ProjectService.open` records a separate run-recovery error while retaining `getProject` and normal editing, and disables generation/listing of runs. Those behaviors have persistence fault/history and lifecycle coverage; no storage race was independently re-injected during this audit.
- Agent operations are checked against the advertised creation kinds in `src/application/project-service.ts` before commit. Canvas code has keyboard Enter/Space selection and ARIA button state in `src/ui/components/CanvasNode.vue`; Playwright component QA exercises keyboard selection and state in `tests/e2e/component-canvas-a11y.spec.ts`. The current canvas uses nested `role="button"` articles for nested design nodes (`CanvasNode.vue:42-55,57+`), which warrants assistive-technology review because nested interactive semantics can be flattened by accessibility APIs. I did not run a screen reader or claim accessibility certification.
- Export paths were reviewed in `src/adapters/export/native.ts`, `src/adapters/export/vue.ts`, and `src/adapters/export/figma.ts`, with fidelity reporting and semantic round-trip/export checks in `tests/export/export-audit.test.ts`. Native export preserves the validated document; Vue and Figma explicitly report known mapping losses. Figma remains an offline plugin archive and does not claim a live file write. This audit did not execute a connected Figma import or certify visual fidelity across targets.
- `applyBatch` validates and serializes the full draft after each operation (`src/domain/operations.ts:380-388` and `src/domain/document.ts:15-20`). At the configured ceilings this can repeatedly serialize a document approaching 5 MiB for as many as 500 operations, creating substantial bounded CPU and allocation pressure. I did not benchmark the ceiling; limits are acceptance bounds, not a smooth-performance guarantee.

## Files reviewed

Instructions/contracts: `AGENTS.md`, `docs/development-journal.md`, `docs/architecture-contracts.md`, `docs/codebase-mcp.md`, and all proposal/design/tasks/spec files in `openspec/changes/design-engine-foundation/`.

Validation and transactions: `src/domain/validation-utils.ts`, `src/domain/document-shapes.ts`, `src/domain/document-ownership.ts`, `src/domain/document.ts`, `src/domain/component-validation.ts`, `src/domain/operations.ts`, `src/domain/run-record.ts`, `src/domain/envelope.ts`, `src/application/context.ts`, `src/application/project-service.ts`.

Storage, runtime boundaries and exports: `src/adapters/persistence/local-files.ts`, `src/adapters/persistence/local-run-store.ts`, `src/adapters/persistence/persistence-fs.ts`, `server/index.ts`, `server/router.ts`, `src/adapters/export/native.ts`, `src/adapters/export/vue.ts`, `src/adapters/export/figma.ts`, `src/adapters/export/bundle.ts`.

Editor and QA evidence: `src/App.vue`, `src/ui/components/CanvasNode.vue`, `src/ui/components/LayerTreeNode.vue`, `src/ui/components/InspectorPanel.vue`, `src/ui/components/TemplateCanvasNode.vue`, `src/ui/rendering.ts`, `src/ui/styles.css`, plus `tests/domain/opaque-ids.test.ts`, `tests/domain/malformed-values.test.ts`, `tests/domain/operations.test.ts`, `tests/domain/component-validation.test.ts`, `tests/integration/persistence-faults.test.ts`, `tests/integration/persistence-history.test.ts`, `tests/integration/run-lifecycle.test.ts`, `tests/integration/run-store.test.ts`, `tests/adapters/local-api-router.test.ts`, `tests/export/export-audit.test.ts`, and `tests/e2e/component-canvas-a11y.spec.ts`.

The coordinator reports `npm run check` passed (117 tests plus lint, strict TypeScript, and build). This QA worker independently ran the focused 17-test domain/export set above. No separate Playwright run was performed by this worker. No security phase or additional scan was run. This is a focused final audit, not complete security, accessibility, or performance certification.
