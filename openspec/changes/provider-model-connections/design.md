## Context

See [proposal.md](proposal.md) for motivation and [provider-model-connections spec](specs/provider-model-connections/spec.md) for observable behavior. The current runtime has one `CodingAgent` implementation and a separate safe run store. The application owns context assembly, operation parsing, authorization, revision checks and atomic persistence. Browser code calls the loopback API and must remain outside provider process, filesystem, and secret access. The architecture contract also excludes secrets and process details from run records.

## Goals / Non-Goals

**Goals:**
- Add backend-owned provider connections, verified capability discovery, explicit run selection and real adapters behind the existing `CodingAgent` boundary.
- Keep all provider credentials in a backend `SecretStore` port and keep selection data separate from secrets.
- Preserve the existing typed operation proposal validation and single atomic commit pipeline for every provider.
- Make test evidence clearly distinguish deterministic adapter contract coverage from live authenticated provider acceptance.

**Non-Goals:**
- Automatic model/provider selection, retries, or fallback in the initial release.
- Browser-managed API keys, direct browser-to-provider requests, or provider-specific document mutation paths.
- Claims of live Claude Code or MiniMax acceptance without working user credentials for those providers.
- Changing the DesignDocument or design operation schema to carry provider credentials or run configuration.

## Decisions

### Separate catalog, connection, secret, and routing boundaries

Define framework-free domain records for provider IDs, authentication source, capability entries, selection, verification status, and immutable run selection metadata. Catalog and selection validation receive values and return typed diagnostics; they do not import Node, Vue, browser, process, filesystem, or MCP APIs. Backend application ports provide `ConnectionStore`, `SecretStore`, `ProviderCatalog`, and `ProviderAdapter`. The adapter registry maps a validated provider ID to its actual transport implementation. A `ProviderRoutingService` coordinates connection resolution, preflight, secret retrieval, adapter invocation, and safe metadata creation.

A persisted connection contains stable connection ID, provider ID, auth source, user label, secret reference usable only by the backend, created/updated timestamps, and last verification summary. Credential bytes are stored separately by the backend secret store; neither the connection store nor run store may serialize them. The secret reference is an internal capability and is never part of an API DTO or run metadata. API DTOs use allowlisted fields and strict runtime parsing.

### Explicit source and provider adapters

Initial provider/source pairs are Codex CLI with ChatGPT account or OpenAI API key, Claude Code with subscription or Anthropic API key, and MiniMax with API key or token plan. Provider adapters own provider-specific authentication, model discovery/validation, effort mapping, transport, output bounds, cancellation, and safe error classification. The UI consumes a normalized catalog and cannot make provider-specific request assumptions.

The catalog separates static provider support from live connection verification. A model may be known in product metadata while account availability remains unknown. A successful live verification records a timestamp and only capabilities actually established for that connection. Unsupported or unknown effort values fail closed at preflight; no adapter may silently drop or substitute effort.

### Extend run selection without forking operation execution

The UI submits a run selection with provider ID, connection ID, model ID, and effort. The backend resolves its internal secret reference and verifies the catalog/connection before constructing the selected `CodingAgent`. It passes a normalized provider request to the adapter, then sends returned typed proposals through the existing parser, operation capability/scope authorization, final document validation, expected-revision check, and atomic operation batch. Provider success is only an intermediate state; rendering and QA remain part of the existing lifecycle.

Persist an optional versioned provider selection snapshot on each run. It includes provider, connection, auth source, model, effort, verification status/time, and an explicit manual routing policy marker. It excludes secret values, secret references, executable paths, environment values, and raw provider errors. Historical snapshots do not change when connections are edited or deleted. Run-store parsing rejects unknown fields and malformed snapshots rather than accepting secret-bearing extras.

### No implicit fallback or retry

The routing service targets exactly the user-selected connection and model. Authentication, quota, transport, timeout, parse, and validation failures end that run with a safe category. A user retry makes a new run after fresh preflight. This keeps account choice and potentially billable routing visible. If automatic routing is proposed later, it requires a separate explicit policy contract naming allowed alternatives and cost constraints.

### Provider status uses honest evidence levels

Connection status is `unverified`, `verified`, or `failed` with a bounded stable category and timestamp. Catalog support and account verification are separate fields so a cached model list never implies a working credential. Fixture adapters are registered only in tests and cannot write a verified connection state. Production adapter health probes make a real provider request and redact response details before persistence.

### Layered validation and mutation evidence

Unit tests cover pure source/selection parsing, catalog constraints, metadata parsing, and secret-redaction helpers. Integration tests exercise connection CRUD, backend secret-store behavior, routing, provider failure mapping, run persistence, and atomic operation application. UI component tests cover connection state and preflight errors. Headed recorded E2E drives connection/selection flows and a real connected Codex generation through rendered committed state. Claude/MiniMax may be exercised against real credentials when available; absent credentials are explicitly marked unverified rather than replaced by fixtures in acceptance claims.

Mutation testing targets selected-provider dispatch, secret isolation/redaction, model/effort guards, routing/fallback policy, and safe response parsers. Preserve baseline, mutation inventory, killed/survived status, and reasons for every survivor. A mutation tool may be selected during implementation if none is installed, but its output and exact scope must be recorded; broad aggregate thresholds cannot conceal survivors.

## Risks / Trade-offs

- Provider APIs and CLI capabilities evolve → Keep provider-specific behavior behind adapters, make catalogs versioned, and fail preflight when live capability evidence is stale or insufficient.
- Subscription credentials may rely on local CLI sessions rather than transferable tokens → Let the adapter use an explicitly supported local account mechanism; never copy credentials into browser state or pretend a session exists when it does not.
- A provider may return malformed or oversized output → Apply bounded transport/output parsing and pass only parsed typed proposals to existing validation; keep raw output out of logs and run records.
- Secret-store failure can leave connection metadata inconsistent → Order secret writes and connection commits with compensation/cleanup and expose a connection as usable only after both are durable.
- Live acceptance depends on provider access → Require real Codex acceptance for the connected provider and report unavailable Claude/MiniMax credentials as unverified, with fixture evidence separately labeled.
- Mutation tooling can be noisy or expensive → Limit mutation scope to the specified security and selection branches and publish surviving mutants individually.

## Migration Plan

1. Add optional versioned provider-selection metadata to run records with a backward-compatible migration that maps old records to no provider selection; preserve the old Codex request default only for existing callers during rollout.
2. Add backend secret and connection stores with startup validation and no credential import from browser or existing run records.
3. Implement Codex CLI as the first production adapter and keep other provider controls disabled until their adapters and capability verification are available.
4. Enable explicit manual selection after connection, selection, and no-fallback tests pass. Keep legacy generation entry points mapped to the established Codex configuration until the UI requires a selection.
5. Roll back by disabling provider selection and retaining safe historical run metadata; never delete a user's connections or secrets as part of a code rollback. Provide an explicit connection removal path for cleanup.

## Open Questions

None that change the specified behavior or implementation sequence. Provider-specific exact model catalogs and authentication mechanics must be established from current official interfaces while implementing each adapter; unsupported capability remains unavailable until proven.
