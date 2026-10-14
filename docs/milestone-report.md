# Pudly foundation milestone

This report is a historical checkpoint. For current acceptance and limitations, see [design quality verification](design-quality-verification.md) and [project explorer verification](project-explorer-verification.md).

Date: 2026-10-05. Change: `design-engine-foundation`. Historical verdict: **REQUIRES CORRECTION for reliable full-screen generation** after subsequent visible dogfooding. Prior small-card/domain/export verification remains valid. Generation hardening and post-correction verification are reopened; the change remains unarchived. No release, Git commit, push or deployment occurred.

The editor now supports real prompt-to-design generation, semantic selection, inspector and selected AI edits, inspectable context, design-system validation, responsive previews, undo/redo, named snapshots, restore, persistence/reopen, and native/Vue/Figma export. Every mutation uses validated revision-aware atomic operations against the authoritative DesignDocument.

## Verification

| Gate | Result |
| --- | --- |
| OpenSpec | PASS: eight specs, 39 requirements, 50 scenarios reviewed; strict validation and 30/30 task reconciliation |
| Unit | PASS: 54 domain/adapter cases |
| Component | PASS: 8 cases |
| Integration | PASS: 31 cases |
| Export / independent audit | PASS: 25 export + 11 audit cases |
| Combined tests | PASS: 129 cases in 30 files |
| Typecheck / lint / build | PASS: combined npm run check |
| Production E2E | PASS: five browser tests together, including two real Codex requests; four deterministic tests repeated on final build |
| Visual QA | PASS for generated card, editable Figma card, exported Vue applications and tested component/responsive bounds |
| Accessibility | PASS for tested Chromium names/descriptions, keyboard selection and reload; no screen-reader/WCAG certification claimed |
| Security boundary review | PASS for reviewed local request/process/storage/operation/generated-output/ZIP boundaries; historical formal scan remains partial |
| Architecture | PASS: domain import separation, source-of-truth and mutation contracts |
| Performance review | PASS for representative workload and limit rejection; 1,000 nodes/100 edits observed about 0.5–1 second; maximum-size latency/peak memory not certified |
| Dependency audit | Zero production vulnerabilities reported |
| Codebase MCP | Ready: final source reconcile 1,359 nodes / 4,076 edges; two known test mock parser-partial ranges reviewed directly; no unusable files or unexpected skips |

## Integration evidence

Real Codex generation passed validation, committed, rendered, and reached durable success after renderer acknowledgement. A second selected AI edit, inspector change and reload passed. Process exit alone was not acceptance.

Native export round-trips the semantic document. Vue export produces a runnable application; generated applications were installed, built and opened in Chromium without page errors. Component bounds were 300×88 desktop and 220×88 mobile. All three browser downloads were parsed and checked without modifying source state; failed adapter results show actionable diagnostics without false download claims.

Figma export downloads a partial developer-plugin archive with a setup README and per-feature fidelity report. Prior authenticated execution of the generated semantic script created five editable layers, including three text layers, in a 360×254 card. Final root `3:2` was visually inspected in the [verification file](https://www.figma.com/design/IWyN9dZuDRc8rqhpbBFf54?node-id=3-2). Current independent API-double execution verifies template/instance mapping and corrected loss reporting; it is distinct from a live import of every possible schema feature.

See [OpenSpec verification](openspec-verification.md), [scenario traceability](scenario-traceability.md), [accessibility QA](qa-accessibility-verification.md), [Figma fidelity QA](qa-figma-fidelity-verification.md), and [workload/architecture QA](qa-foundation-acceptance.md). Local screenshots/run JSON remain under ignored `.codex-design/evidence/`.

## Known limits and technical debt

Only schema version 1 and the negotiated operation subset are supported. Agent creation advertises frame, group, text and component instance; broader image/icon/vector metadata does not imply asset rendering or agent creation support. Asset binary storage, icon libraries, advanced operations, reusable Figma components/variables, and history compaction are deferred. Figma explicitly reports omitted assets/effects/constraints, flattened definitions, static breakpoints and type-specific losses. Its archive requires a Figma-assigned development plugin ID; it does not claim an automatic authenticated file write.

Large batches still revalidate the full draft after each operation. Screen-reader interoperability, exhaustive fuzzing, maximum-size performance qualification and broader formal security coverage remain future qualifications. The trusted CLI/provider and read-only sandbox are not represented as complete host-read isolation. The Harvest reference repository was not modified.

## Subsequent dogfooding finding

The user stopped the three-design trial after repeated failures. Default 120-second generation was insufficient; a longer bounded runtime produced partial dashboard/cake drafts in 169/131 seconds, while the login stayed empty. One response violated node shape, and generic failure reporting plus brittle automation impaired recovery. All task servers/agents stopped; recordings and drafts preserved. See the development journal and dogfooding failure-review.md. Full-screen generation is not accepted by the earlier small-card evidence.
