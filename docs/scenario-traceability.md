# Verified scenario traceability

These are actual test locations, replacing the planned names in architecture-contracts.md. Fixtures establish contracts; only the live browser run establishes real Codex acceptance.

| Contract scenario | Actual evidence |
| --- | --- |
| Semantic document, stable ownership, no renderer source data | tests/domain/document.test.ts: valid semantic document; unknown fields and ownership cycle |
| Unsupported schema and retained original bytes | tests/domain/document.test.ts; tests/integration/persistence-history.test.ts: corrupt and unknown-future-version files survive reopen and recovery |
| Root-relative graph bounds independent of insertion order | tests/domain/graph-depth.test.ts: 64 levels accepted, 65 rejected; 2,000-template hostile chain rejected without recursive stack growth |
| Invalid middle operation, stale revision, duplicate ID and no partial commit | tests/domain/operations.test.ts; tests/integration/persistence-history.test.ts: concurrent same-revision commits |
| Own references, opaque IDs, malformed metadata and sparse arrays | tests/domain/opaque-ids.test.ts; tests/adapters/local-api-router.test.ts |
| Submitted values are detached before queued work | tests/domain/operations.test.ts; tests/integration/persistence-history.test.ts: blocked-save caller mutation |
| Prompt is stdin data, process bounded, capability negotiation | tests/adapters/codex-cli-adapter.test.ts: actual fixture executable boundary, timeout/cancellation/capability rejection |
| Agent stale response and selected subtree authorization | tests/integration/run-lifecycle.test.ts: stale/out-of-scope rejection and selected-container nested creation |
| Active-page authorization does not grant other-page edits or roots | tests/integration/run-lifecycle.test.ts: known other-page ID; tests/integration/context.test.ts: active page and owning frame |
| Cancellation before/after commit and renderer failure recovery | tests/integration/run-lifecycle.test.ts: cancellation and render.failed retain the committed revision |
| Durable run context, terminal publication and interrupted restart | tests/integration/run-store.test.ts: exact fragment/policy, history linkage, no rerun, failed terminal save, concurrent starts and cancellation during blocked status save |
| History, named snapshots and monotonic recovery revisions | tests/integration/persistence-history.test.ts; tests/e2e/workspace.spec.ts: real local service edit/undo/redo/restore/reload |
| Filesystem interruption and rollback | tests/integration/persistence-faults.test.ts; tests/integration/run-store.test.ts: fsync failure, prior bytes restored, indeterminate rollback fails closed |
| Default tokens, components, variants, bindings and slots | tests/domain/design-system.test.ts; tests/domain/component-validation.test.ts; tests/domain/component-mutations.test.ts |
| Configured blocking policy, deterministic responsive conflicts | tests/domain/design-system.test.ts; tests/domain/document.test.ts; tests/domain/malformed-values.test.ts; tests/domain/template-values.test.ts |
| Type-aware inspector validation and rejected variant stays displayed | tests/ui/component-inspector.spec.ts: parent validation feedback, committed variant, actionable local spacing error |
| Component expansion, ephemeral render IDs, slot selection and typography | tests/ui/component-renderer.spec.ts; tests/ui/renderer.spec.ts; tests/ui/typography.spec.ts |
| Actual browser bounds, responsive template rules, keyboard selection and reachable artboard | tests/e2e/component-canvas-a11y.spec.ts: fixed/hug Button/Card, padding once, breakpoint change, aria-pressed, desktop origin before/after reload |
| Native round trip and invalid-version target failure | tests/export/native-export.test.ts; tests/export/export-audit.test.ts |
| Vue semantic component mapping, escaped data, runnable ZIP and honest loss | tests/export/vue-export.test.ts; tests/export/vue-bundle.test.ts; tests/export/export-audit.test.ts |
| Actual exported Vue application | Coordinator built and opened generated apps in Chromium; ignored evidence: .codex-design/evidence/vue-export.png and vue-component-browser.json (300×88 desktop, 220×88 mobile; no page errors) |
| Figma direct semantic mapping, safe JSON, font-size/line-height units, templates and loss reporting | tests/export/figma-export.test.ts executes the generated script in a Plugin API mock; tests/export/export-audit.test.ts checks mapped component geometry and omitted template features |
| Real authenticated Figma write, editable output and visual inspection | Figma verification file IWyN9dZuDRc8rqhpbBFf54, final root 3:2: five editable layers, three text layers, 360×254, title 30px line height, no font fallback warnings; ignored figma-write-final.json |
| Bounded exporter workload smoke | tests/export/export-audit.test.ts: 100-node native/Vue/Figma graph; this is not a worst-case performance certification |
| Actual Codex prompt → operations → commit → canvas → selected AI edit | tests/e2e/live-codex.spec.ts with CODEX_DESIGN_LIVE=1: real CLI, renderer acknowledgement, stable IDs, second scoped AI request, inspector edit, revision progression, persisted reload and title in viewport |
| Local host/origin/body boundary | tests/adapters/local-api-router.test.ts; parent Codex Security source review of HTTP/process/persistence/transaction/ZIP boundaries |

Only schema version 1 is supported. No older migration is advertised; unsupported versions fail without rewriting stored bytes. Asset binaries/icon libraries, advanced unimplemented operation types, reusable Figma components/variables, and history compaction are not accepted capabilities.

The independent security auditor hit the account usage limit. Its unfinished repository-wide coverage is recorded in the completed partial Codex Security report, not presented as a clean audit. Current source-backed boundary, keyboard/accessibility, architecture and representative-workload reviews are completed separately. They do not turn the historical partial security scan into a complete scan or establish screen-reader/WCAG certification or a maximum-size performance guarantee.

Independent final QA identified and verified corrections for sparse operation arrays and omitted Figma asset fidelity. See docs/qa-final.md. Corrupt run metadata isolation and unsupported agent creation-kind rejection are covered by run-store and run-lifecycle tests.

## Resumed final verification

| Scenario | Current passing evidence |
| --- | --- |
| Text control name matches visible content, metadata description, blank fallback, edit and reload | tests/audit/accessibility-canvas.spec.ts; tests/e2e/canvas-accessibility.spec.ts; docs/qa-accessibility-verification.md |
| Queued structural work bounded before descendant scheduling | tests/audit/acceptance-boundaries.test.ts: rejects at $.0 with pending siblings |
| Framework/runtime-independent domain import graph | tests/audit/acceptance-boundaries.test.ts |
| Representative transaction workload and over-limit rejection | tests/audit/acceptance-boundaries.test.ts: 1,000 nodes/100 operations; 501 operations reject |
| Figma per-template feature reporting and unused definitions | tests/export/figma-template-fidelity.test.ts; tests/audit/figma-fidelity-claims.test.ts |
| Instance-projected name/sizing/styles, ignored textColor, text fill, vector radius, and free-layout child coordinates | tests/audit/figma-fidelity-claims.test.ts executes generated importer |
| All three actual browser downloads retain source and report fidelity | tests/e2e/export-downloads.spec.ts: parses downloaded JSON/ZIP artifacts |
| Failed exporter yields actionable diagnostic without false download announcement | tests/e2e/export-downloads.spec.ts: explicit failed adapter response |

Final combined check: 129 tests in 30 files, lint, strict TypeScript and build passed. Browser combined gate: five tests passed with two real CLI requests. Deterministic browser gate repeated on final build: four passed. Existing schema-version migration scenario is conditional: no prior version is supported, so it is not advertised or fabricated; unsupported versions are tested for rejection and byte preservation.
