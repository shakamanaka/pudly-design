## 1. Contracts and domain types

- [x] 1.1 Reconcile the provider-selection and connection DTO shapes with `docs/architecture-contracts.md` and local API contracts before exposing behavior; define typed provider IDs, auth sources, capability/verification states, safe selection metadata, and versioned parsers without framework or process imports.
- [x] 1.2 Implement pure provider/source compatibility, catalog capability, model/effort, and preflight selection validation with stable diagnostics for unsupported and unverified values.
- [x] 1.3 Add unit tests for supported and rejected provider/source pairs, unknown-versus-verified capability states, malformed metadata, unsupported model/effort, and immutable metadata snapshots.

## 2. Backend connection and secret lifecycle

- [x] 2.1 Define backend-only `SecretStore` and connection persistence ports plus safe API DTOs; select and document a local secret-store implementation that does not store credential bytes in browser storage, run records, or connection metadata files.
- [x] 2.2 Implement create, list, rename, credential rotation, verification, and delete flows with atomic/compensating cleanup across connection and secret persistence.
- [x] 2.3 Add strict API routes for connection CRUD, catalog/verification status, and credential testing; reject unknown fields and never return secret values, secret references, or raw provider errors.
- [x] 2.4 Add integration tests for persistence/reload, secret rotation/deletion, secret-store failure, unsupported source rejection, and credential redaction across API bodies, logs, diagnostics, run files, and browser persistence.
- [x] 2.5 Add mutation tests for secret serialization/response boundaries and supported-source guards; retain a baseline, killed-mutant inventory, and an explicit survivor report.

## 3. Provider catalogs and real adapters

- [x] 3.1 Implement provider-specific capability discovery and verification with separate product support and account-verified availability; persist only safe status, timestamp, and stable failure category.
- [x] 3.2 Implement real Codex CLI adapters for ChatGPT account and OpenAI API-key authentication, validating selected model and effort and honoring bounded execution, cancellation, and safe error classification.
- [x] 3.3 Implement real Claude Code subscription and Anthropic API-key adapters, validating supported model/effort mappings and handling authentication, quota, timeout, cancellation, and malformed output safely.
- [x] 3.4 Implement real MiniMax API-key and token-plan adapters with the same normalized capability, model/effort, timeout, cancellation, and error contract.
- [x] 3.5 Add adapter contract tests with fixtures for accepted output, invalid JSON/shape, unsupported effort, authentication rejection, quota/rate limits, timeout, cancellation, oversized output, and redaction; label all such evidence fixture-only.
- [x] 3.6 Add integration tests proving each production adapter dispatches only to its selected connection and passes typed proposals into the existing authorization, revision, and atomic-commit pipeline.

## 4. Run selection, routing, and persistence

- [x] 4.1 Implement backend `ProviderRoutingService` and adapter registry; require a concrete provider, connection, model, and effort, run preflight before launch, and forbid implicit provider/model/source fallback or automatic retries.
- [x] 4.2 Extend versioned run persistence with immutable provider/model/effort/auth-source/verification/policy metadata while excluding secret bytes, secret references, process paths, environment values, and raw errors; migrate existing records without changing historical behavior.
- [x] 4.3 Integrate selected adapter output with current typed response parsing, negotiated capability checks, operation scope, base-revision validation, and atomic persistence; preserve existing render and QA lifecycle outcomes.
- [x] 4.4 Add integration tests for preflight rejection with unchanged revision, immutable historical run metadata after connection edits/deletion, quota failure without fallback, explicit retry as a new run, cancellation before commit, stale output rejection, and reopen without rerun.
- [x] 4.5 Add mutation tests for provider selection dispatch, model/effort checks, no-fallback policy, response parser rejection branches, and run metadata redaction; record baseline, killed mutants, and every unexplained survivor.

## 5. Selection interface and acceptance

- [x] 5.1 Add UI for connection management, honest health/capability status, and required per-run provider/model/effort selection; render actionable preflight errors and never request credentials through browser storage.
- [x] 5.2 Add component tests for connection CRUD state, unverified/verified distinctions, unsupported effort, stale selection, credential replacement, provider failure, and no automatic fallback.
- [x] 5.3 Record headed browser E2E covering connection and selection, preflight rejection, a real connected Codex CLI generation, rendered committed document, run metadata, reload, and cancellation/failure behavior.
- [x] 5.4 Run and record strict TypeScript, lint, build, unit, integration, component, headed recorded E2E, and scoped mutation testing; distinguish fixture contract evidence from live provider evidence and leave Claude/MiniMax explicitly unverified if credentials are unavailable.
- [x] 5.5 Reconcile every spec scenario to actual tests and acceptance artifacts; update the development journal and provider connection plan with completed evidence and unresolved live-provider limits.

Acceptance reconciled on 2026-10-09 in docs/provider-verification.md: 12 requirements, 32 scenarios; full check 254 tests, lint, TypeScript and build; two headed recorded fixture flows; mutation baseline 43 and all 23 targeted mutants killed; real Codex Sol6.1/low render/export/reload acceptance. Claude/MiniMax remain live-unverified without credentials, as explicitly permitted by this manual-first scope. Unknown upstream errors retain a safe generic category; credentials use owner-only plaintext storage with durable cleanup. No archive/release/commit/push.
