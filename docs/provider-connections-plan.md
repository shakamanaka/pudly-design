# Provider connections implementation plan

Status: proposed OpenSpec implementation plan for `provider-model-connections`. No provider adapter, connection UI, or connection store is claimed implemented by this plan.

## Scope and release order

The first release uses manual provider selection. It supports connection sources for Codex CLI (ChatGPT account or OpenAI API key), Claude Code (subscription or Anthropic API key), and MiniMax (API key or token plan). A provider/model/effort choice is required before generation. Automatic model selection, retries, and cross-provider fallback remain outside this release; any later fallback needs a separate explicit policy including the allowed alternatives and spending limits.

Implement in this order:

1. Freeze framework-free provider, source, capability, selection, verification, and safe run metadata types in the architecture/API contracts.
2. Implement strict parsers and deterministic selection/catalog validation.
3. Add backend connection persistence and secret-store boundary, then CRUD, verification, safe DTOs, and cleanup behavior.
4. Implement real provider adapters, beginning with Codex CLI, then Claude Code and MiniMax. Each adapter owns authentication, model/effort mapping, limits, cancellation, response parsing, and safe failure classification.
5. Add the backend routing service and immutable run metadata extension. All adapter output continues through the existing typed operation, scope, revision, document-validation, and atomic-persistence path.
6. Add connection/selection UI, component coverage, headed recorded acceptance, and mutation analysis.

## Boundaries that must hold

- `DesignDocument` remains authoritative. Provider configuration never enters design nodes, operations, exports, or design document metadata.
- Domain code contains no browser, Vue, process, filesystem, or MCP imports. Provider processes and network calls remain in backend adapters.
- The browser sends credentials only to a trusted local API operation that writes through the backend secret store. Responses never contain credential bytes or secret-store references.
- Run metadata snapshots provider ID, connection ID, authentication source, model ID, effort, verification state/time, and policy version. It excludes secrets, secret references, executable paths, environment variables, and raw provider payloads/errors.
- Unknown account availability remains unknown until live verification. Static catalogs and fixtures cannot establish a live account capability.
- Preflight validates provider/source, active connection, model, effort, verification, and policy before any potentially billable provider call.
- One failed or unavailable provider ends the selected run. There is no hidden provider switch, effort substitution, paid tier switch, or automatic retry.
- Valid provider output is untrusted and must pass the established capability negotiation, typed parser, operation authorization, base-revision check, final graph validation, and atomic batch commit. Process exit success is not design acceptance.

## Evidence and acceptance gates

| Area | Required evidence | What the evidence establishes |
| --- | --- | --- |
| Domain | Unit tests for connection/source compatibility, catalog status, model/effort selection, metadata parsing, and safe diagnostics | Pure validation and stable rejection behavior |
| Persistence and API | Integration tests for CRUD, secret lifecycle, reload, failure cleanup, unknown fields, and redaction | Backend isolation and durable connection behavior |
| Routing | Integration tests for selected adapter dispatch, preflight, no fallback, quota/timeout/cancel, immutable run metadata, and atomic operation commits | Correct backend orchestration and unchanged design transaction semantics |
| UI | Component tests for connection state, model/effort selection, unverified status, and actionable errors | Honest and usable selection controls |
| Live acceptance | Headed recorded browser E2E using a real connected Codex CLI account, selected model and effort, rendered committed design, run record and reload | Retain prompt, run ID, selected model/effort, committed revision, semantic document, screenshot, and finalized video; process exit alone does not pass |
| Other providers | Real authenticated runs only when Claude Code or MiniMax credentials are available | Live behavior for that specific account/source; fixtures cannot substitute |
| Mutation analysis | Baseline plus targeted mutations in provider dispatch, credential redaction, selection guards, no-fallback rules, and safe parsers; list killed and survived mutants and explain survivors | Whether tests detect regressions in critical routing and isolation branches |
| Build checks | Strict TypeScript, lint, build, unit, integration, component, headed E2E, and scoped mutation run | Project-level implementation readiness |

A missing credential or unavailable provider is recorded as unverified/unavailable, not passed. A test using fixtures proves only the adapter contract. Preflight rejection must assert zero adapter/transport calls and unchanged revision. Connection isolation must seed distinct sentinels and assert only the selected connection reaches its adapter; rotation/removal must not dispatch through another connection. No-fallback cases must assert all unselected adapters have zero calls. Redaction checks search sentinel credentials and secret keys across API responses, DOM, browser storage, persisted runs, captured log arguments, diagnostics, and exports. Each critical OpenSpec scenario must map to a concrete test or a live acceptance record before its task is marked complete. Mutation survivors remain visible in the acceptance report even when the test command exits successfully.

## Failure and rollback behavior

Connection creation is usable only when both safe connection metadata and the secret are durably stored. Credential replacement must rotate the secret and metadata coherently; failed writes must clean up the newly written secret or leave the prior connection intact. Removing a connection removes its secret and prevents future dispatch; historical run snapshots remain readable.

A provider error before commit leaves the document revision unchanged. Cancellation before commit ends provider work and commits nothing. Once the existing transaction pipeline commits, rendering and QA retain the committed revision under the established run lifecycle. Retrying requires a new explicit user action and new run ID. Rolling back code disables new provider routing while preserving user connection data and historical safe metadata.

## Verified manual-selection delivery — 2026-10-09

The manual provider-connection change is implemented and its 24 tasks are reconciled in `docs/provider-verification.md`. All 12 requirements and 32 scenarios map to code, tests or retained acceptance artifacts. Full checks passed 254 tests, lint, strict TypeScript and build; two headed recorded fixture E2E flows passed. The named source-mutation harness passed its 43-test baseline and killed all 23 mutants without survivors. Real ChatGPT-authenticated Codex Sol6.1/low generation committed, rendered, exported and reloaded unchanged.

Claude/MiniMax adapters have fixture contract coverage and remain live-unverified until credentials and an explicit connection test succeed. Multiple API-key/token connections are supported; a local subscription source refers to one current device CLI login. Opaque upstream errors remain safe generic transport failures. Credential storage is an owner-only plaintext file fallback, not encryption or OS keychain. Automatic routing and paid fallback remain outside this change. No archive, release, commit or push occurred.
