## 1. Contract review and repository foundation

- [x] 1.1 Review and freeze the eight capability contracts and ten ADR decisions before dependent implementation; resolve contradictions in OpenSpec first.
- [x] 1.2 Establish strict TypeScript, Vue canvas shell, package boundaries, lint, unit/component/integration/browser test commands, and CI build gates.
- [x] 1.3 Verified DeusData/codebase-memory-mcp setup, refreshed index (current product source), and retrieval against the current workspace; recheck after substantial source changes.

## 2. Semantic document and operation core

- [x] 2.1 Implement versioned document schema, stable IDs, semantic nodes, layout/sizing/styles/constraints/responsive values, components/instances, and graph bounds from design-document.
- [x] 2.2 Implement explicit supported-version migrations and rejection/preservation for unknown newer versions.
- [x] 2.3 Implement typed operation envelope, runtime validation, capability negotiation, and the walking-skeleton operation subset: create/delete/move node and set property/layout/style.
- [x] 2.4 Implement isolated draft validation, atomic batch commit, revision conflict handling, duplicate-batch prevention, and indexed diagnostics.
- [x] 2.5 Add domain tests mapped to document and operation scenarios, including cyclic graph, unsupported version, invalid middle operation, stale revision, aliasing, and no-partial-commit evidence.

## 3. Walking-skeleton agent and renderer

- [x] 3.1 Implement the CodingAgent port and bounded Codex adapter with safe argument-based process spawning, prompt data channel, cancellation, timeout, output limits, and lifecycle diagnostics.
- [x] 3.2 Parse agent output as untrusted data; restrict requests to negotiated operations and apply through the atomic transaction service.
- [x] 3.3 Implement Vue canvas rendering from the semantic document with stable node-ID mapping, page navigation, basic pan/zoom, and single/multi-selection.
- [x] 3.4 Implement prompt-to-operation-to-commit-to-canvas vertical integration with before/after revision and operation audit metadata.
- [x] 3.5 Verify a real Codex run can create an editable design and verify malformed, unauthorized, or invalid output leaves the document unchanged; report mock-only environments as incomplete.

## 4. Direct editing, context, and recovery

- [x] 4.1 Implement type-aware inspector fields for supported node properties, emitting the same operation types as agent edits.
- [x] 4.2 Implement scoped context assembly for page, frame, selection, design system, and operation capability scopes, with inspectable run context.
- [x] 4.3 Implement operation-aware undo/redo and named snapshots with restore as a new revision.
- [x] 4.4 Implement atomic local persistence, integrity/version metadata, safe reopen, failure recovery, and migration verification.
- [x] 4.5 Add integration/browser coverage for selection, inspector mutation, context visibility, undo/redo, snapshot restore, reopen, and failed persistence behavior.

## 5. Design system and responsive semantics

- [x] 5.1 Implement framework-neutral typed tokens, default token set, component definitions, variants, properties, and usage constraints.
- [x] 5.2 Implement deterministic configurable validation for token, component property, variant, child, spacing, and detached-instance violations.
- [x] 5.3 Implement explicit breakpoint overrides and canvas behavior for responsive layout, sizing, and visibility.
- [x] 5.4 Add domain and UI tests for token resolution, blocking policy violations, component expansion cycles, and responsive override conflict behavior.

## 6. Export adapters

- [x] 6.1 Implement native document serialization and round-trip validation with version and fidelity reporting.
- [x] 6.2 Implement Vue application export from semantic document data, with escaping/security checks and per-feature loss reports.
- [x] 6.3 Implement Figma semantic mapping behind its adapter, verify auth/write capability, and report unsupported features; do not use screenshot or DOM reconstruction.
- [x] 6.4 Add exporter contract tests for component mapping, responsive loss reporting, native round trip, target failures, and absence of false full-fidelity claims.

## 7. Product acceptance and independent audit

- [ ] 7.1 Complete adversarial transaction, cancellation-race, stale-response, corrupt-persistence, security, accessibility, performance, and architecture reviews.
- [ ] 7.2 Run build, lint, unit, component, integration, and browser checks with traceability from each critical scenario to named evidence.
- [x] 7.3 Report walking-skeleton acceptance separately from full MVP; claim full MVP only after direct editing, inspectable context, history/persistence, design system, responsive behavior, and all three exports pass evidence gates.
- [x] 7.4 Record Codebase MCP health, real Codex and Figma integration evidence, known limitations, and unimplemented operations in the milestone report; leave external blockers explicitly unresolved.

Stop checkpoint 2026-10-05: user requested stop after current subagents finish. Remaining 6.3/6.4 include component-template per-feature Figma fidelity reporting; 7.1 includes the visible-label/accessibility-name correction and remaining hardening coverage; 7.2 must be rerun after those corrections. Walking skeleton is proven with real CLI/browser evidence; full MVP is not accepted.

Acceptance checkpoint 2026-10-05: user resumed; accessible names, Figma template/instance fidelity and export failure diagnostics corrected and independently verified. Combined check passes 129 tests/30 files, lint, strict typecheck and build. All five production browser tests passed together with real Codex; four deterministic browser tests passed again after final metadata corrections. Local MVP accepted within the documented capability/fidelity boundary; formal partial security review is not a repository-wide certification.

Subsequent 2026-10-05 visible dogfooding reopened 7.1/7.2: generation deadlines, operation shape constraints, actionable adapter errors and recorded automation recovery need correction/verification. User stopped all work; partial designs and footage preserved, with no further fixes or retries until resume.
