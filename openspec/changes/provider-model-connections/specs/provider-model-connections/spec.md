## Purpose

Lets users connect supported AI providers, verify what each connection can run, and explicitly select a model configuration for design generation while protecting credentials and retaining the existing validated design transaction boundary.

## ADDED Requirements

### Requirement: Supported provider connection sources
The system SHALL allow users to create and manage named connections for Codex CLI using a ChatGPT account or OpenAI API key, Claude Code using a subscription or Anthropic API key, and MiniMax using an API key or token plan. Each connection SHALL identify its provider and authentication source. Unsupported provider/source combinations SHALL be rejected before credentials are stored.

#### Scenario: Create supported connection
- **WHEN** a user submits a supported provider and authentication source with required credentials
- **THEN** the backend creates a stable connection identifier and reports non-secret connection metadata

#### Scenario: Reject unsupported source combination
- **WHEN** a user submits a source that is not supported for the selected provider
- **THEN** the request is rejected with a stable actionable error and no connection or secret is created

#### Scenario: Update and remove a connection
- **WHEN** a user renames, replaces credentials for, or removes a connection
- **THEN** the backend persists the metadata change, rotates or deletes the associated secret as appropriate, and subsequent routing cannot use a removed or superseded secret

### Requirement: Backend-only credential handling
Credentials SHALL be accepted and used only by trusted backend components through a secret-store boundary. The system SHALL never return credential values or secret-store keys to browser clients, store credentials in browser storage, include them in run metadata, operation payloads, diagnostics, logs, exports, or error messages, or expose them through connection listing or health responses.

#### Scenario: Credential redaction across observable outputs
- **WHEN** a credential is created, tested, used for a run, or rejected by a provider
- **THEN** API responses, persisted browser state, run records, diagnostics, logs, and exported artifacts contain no credential value or secret-store key

#### Scenario: Sentinel credentials remain private on success and failure
- **WHEN** tests seed distinct sentinel credential values and secret-store keys and exercise successful verification, successful execution, provider rejection, and secret-store failure
- **THEN** assertions find neither sentinel in any API response, rendered DOM, browser storage, run record, captured log argument, diagnostic, or export

#### Scenario: Secret storage unavailable
- **WHEN** the backend cannot securely persist a submitted credential
- **THEN** connection creation or credential replacement fails without reporting a usable connection and without retaining a partial secret

### Requirement: Honest connection and capability status
The system SHALL represent connection health and provider/model/effort availability as unknown until a successful provider-specific verification establishes the corresponding fact. Cached catalog presence or fixture responses SHALL NOT be represented as live account availability. Verification status SHALL include a timestamp and a safe reason when verification fails.

#### Scenario: New connection is unverified
- **WHEN** a connection is created but no live verification has succeeded
- **THEN** its health and account-specific model availability are shown as unknown or unverified

#### Scenario: Live verification updates availability
- **WHEN** the backend successfully verifies a connection and retrieves or validates its supported models and effort levels
- **THEN** it records the verification time and reports only the capabilities supported by that provider response

#### Scenario: Verification fails
- **WHEN** verification fails due to authentication, quota, network, or unsupported capability
- **THEN** the system preserves the distinction in a stable safe status and does not claim the connection or requested model is verified

### Requirement: Explicit model and effort selection
Before a run starts, the user SHALL be able to select an active connection, a model supported by that provider, and an effort value supported by that model. The backend SHALL validate the complete selection against the provider catalog and connection verification state before launching the provider. Unsupported or unverified selections SHALL fail preflight with a stable actionable error and no provider request or design mutation.

#### Scenario: Valid explicit selection passes preflight
- **WHEN** a user selects a verified connection, supported model, and supported effort
- **THEN** preflight accepts that exact selection and passes it to the selected provider adapter

#### Scenario: Preflight rejection launches no provider request
- **WHEN** model or effort validation fails
- **THEN** no adapter or transport is invoked, no run is launched, and the document revision remains unchanged

#### Scenario: Unsupported effort is rejected
- **WHEN** a user selects an effort value unsupported by the selected model
- **THEN** preflight identifies the invalid field, does not launch a provider request, and leaves the document revision unchanged

#### Scenario: Stale or invalid model selection is rejected
- **WHEN** a selected model is absent, no longer supported, or not verified for that connection
- **THEN** preflight rejects the run before provider launch and asks the user to refresh or choose a valid selection

### Requirement: Explicit manual routing and no silent paid fallback
The system SHALL route each run only to the provider and connection explicitly selected for that run. It SHALL NOT silently switch provider, connection, model, authentication source, or paid usage tier after an error. Automatic selection and fallback are not available unless a later explicit user policy enables them and identifies permitted alternatives and spending constraints.

#### Scenario: Provider failure does not trigger fallback
- **WHEN** the selected provider returns an authentication, quota, rate-limit, timeout, or transport failure
- **THEN** the run fails with an actionable safe diagnostic and no other connection or potentially paid service is invoked

#### Scenario: Only the selected connection supplies authentication
- **WHEN** two connections for the same provider have different credentials and a run selects one connection
- **THEN** only the selected connection's secret is supplied to its adapter, and rotating or removing it never causes dispatch through the other connection

#### Scenario: Automatic routing is unavailable by default
- **WHEN** no explicit automatic-routing policy has been configured
- **THEN** every run requires a concrete provider, connection, model, and effort selection

### Requirement: Immutable safe provider run metadata
Each accepted run SHALL capture an immutable snapshot of provider ID, connection ID, authentication source, model ID, effort, capability verification status and time, and routing policy used. The snapshot SHALL be versioned and SHALL exclude credential values, secret-store keys, and process secrets. Reopening a run SHALL display its original selection and SHALL NOT rerun it.

#### Scenario: Run metadata records the chosen route
- **WHEN** a run passes preflight and starts
- **THEN** its durable run record contains the exact safe provider selection and verification snapshot used for execution

#### Scenario: Connection changes do not rewrite past runs
- **WHEN** a connection is renamed, rotated, or removed after a run
- **THEN** the historical run retains its original provider/model/effort/auth-source metadata without exposing a secret

### Requirement: Provider adapters preserve validated atomic design operations
Every provider adapter SHALL return untrusted typed operation proposals to the existing application validation pipeline. Provider output SHALL pass capability, scope, runtime-shape, final graph, and expected-revision checks and commit as one atomic batch. Provider transport success SHALL NOT itself count as successful design generation.

#### Scenario: Valid provider output commits atomically
- **WHEN** a selected provider returns a complete valid in-scope operation batch against the run's base revision
- **THEN** the application validates and commits one atomic batch and records the committed revision

#### Scenario: Invalid or stale provider output is rejected
- **WHEN** provider output has malformed operations, exceeds negotiated capabilities, violates scope or document invariants, or targets a stale base revision
- **THEN** the whole batch is rejected, no partial design mutation occurs, and the run records a safe actionable outcome

#### Scenario: Provider failure before commit leaves design unchanged
- **WHEN** execution fails, is cancelled before commit, or returns no acceptable operations
- **THEN** the document revision and content remain unchanged

### Requirement: Reliable provider run lifecycle
Provider execution SHALL honor bounded request/output/time limits and cancellation. Quota, rate-limit, authentication, timeout, transport, malformed-response, cancellation, validation, commit, render, and QA outcomes SHALL remain distinguishable in run status and safe diagnostics. Retrying a failed request SHALL require a new explicit user action and run identity.

#### Scenario: Quota and rate limit remain actionable
- **WHEN** a provider reports quota exhaustion or rate limiting
- **THEN** the run is recorded as failed with a stable safe category, the selected connection remains visible, and no automatic retry or fallback occurs

#### Scenario: Cancellation terminates selected provider work
- **WHEN** a user cancels before commit
- **THEN** the adapter terminates or aborts the active request, the run becomes cancelled, and no operation is committed

#### Scenario: Retry creates a distinct run
- **WHEN** a user explicitly retries after failure
- **THEN** the system creates a new run ID with a fresh preflight and immutable selection snapshot rather than replaying a possibly billable request invisibly

### Requirement: Evidence distinguishes contract fixtures from live providers
Provider fixtures SHALL be used to prove adapter contracts and deterministic failure handling only. A provider SHALL be described as live verified only after a real authenticated request succeeds. The acceptance record SHALL include unit, integration, headed recorded browser E2E, and mutation-testing evidence for provider selection, credential isolation, model/effort validation, routing, and safe parsing.

#### Scenario: Fixture execution is not reported as live verification
- **WHEN** an adapter test uses a fixture or mock response
- **THEN** its result is labeled contract evidence and does not mark the user's connection or provider as live verified

#### Scenario: Real connected Codex acceptance
- **WHEN** acceptance is claimed for the Codex CLI provider
- **THEN** a real connected Codex execution produces a valid committed design that is rendered and recorded in a headed browser session with the prompt, run ID, selected model and effort, committed revision, and finalized video identified

#### Scenario: Mutation report discloses survivors
- **WHEN** mutation testing is completed
- **THEN** the report lists baseline, killed and survived mutations by behavior area, explains surviving mutations, and does not hide survivors behind aggregate thresholds

### Requirement: Honest local subscription identity and isolated instructions
A local subscription connection SHALL represent the provider CLI's current local account. The application SHALL reject creation of a second local subscription connection for the same provider rather than claim independent account identities. Claude generation SHALL use a disposable working directory and supported instruction/config isolation while retaining the selected authentication mechanism.

#### Scenario: Duplicate local account labels do not create identities
- **WHEN** a user creates a second subscription connection for a provider that already has one
- **THEN** creation is rejected with a safe actionable message before any metadata or secret write

#### Scenario: Local instructions do not enter design generation
- **WHEN** Claude generates a design using subscription authentication
- **THEN** project and user instruction/config sources are excluded using supported isolation controls and the adapter runs in a disposable directory

### Requirement: Verification timeout and durable credential cleanup
Verification abort caused by its time bound SHALL report timeout. Credential cleanup failures SHALL retain backend-only pending cleanup references and expose a safe actionable status, with retries on reopen. Cleanup references and credential bytes SHALL never be returned through public connection or run DTOs.

#### Scenario: Aborted verification returns no response
- **WHEN** verification expires and an adapter exits without a response
- **THEN** verification fails with the timeout category rather than malformed response

#### Scenario: Old credential deletion fails
- **WHEN** credential rotation or connection removal cannot delete an obsolete secret
- **THEN** the obsolete reference remains durably tracked for cleanup, public output reports the safe pending-cleanup status, and the obsolete credential cannot be used for a run

### Requirement: Provider recovery preserves design access
Malformed or unreadable provider connection metadata SHALL NOT prevent access to an otherwise valid saved DesignDocument. Provider selection and generation SHALL fail closed with a safe recovery diagnostic, without overwriting connection data or falling back to another account.

#### Scenario: Corrupt connection store on reopen
- **WHEN** the provider connection store is malformed while the saved design remains valid
- **THEN** the editor can reopen the saved design, connection operations and generation report recovery failure, no run is launched, and the original connection files remain preserved
