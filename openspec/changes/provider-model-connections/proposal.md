## Why

Codex Design currently has one fixed local Codex CLI generation path and cannot honestly represent other connected providers, model choices, or effort limits. Users need to choose a real account or API connection and a verified model configuration while keeping credentials in the trusted backend and preserving the existing atomic design-operation boundary.

## What Changes

- Add manually managed connections for Codex CLI with ChatGPT account or OpenAI API key, Claude Code with subscription or Anthropic API key, and MiniMax with API key or token plan.
- Add honest provider/model/effort capability and connection health states, including unknown until verified.
- Add explicit per-run provider, connection, model, and effort selection with preflight validation and immutable safe run metadata.
- Store secrets only in a backend secret store; never return, log, export, or persist credentials in browser storage or run records.
- Route real provider requests through backend-owned adapters while validating all returned design operations through the existing typed, scoped, revision-aware atomic operation pipeline.
- Make manual routing the initial behavior. Automatic routing and fallback are excluded from this change; any later fallback must require explicit user policy and cannot silently incur paid usage.

## Capabilities

### New Capabilities
- `provider-model-connections`: Manage provider connections and credentials, inspect verified capabilities, select a provider/model/effort for a run, and safely route and record provider execution.

### Modified Capabilities
- None. This adds a separately selectable generation capability without changing the existing design-operation contract.

## Impact

Adds provider connection, secret-store, capability-catalog, routing, and adapter boundaries in the local backend; local API endpoints and UI connection/selection controls; versioned non-secret connection/run metadata; and unit, integration, component, headed recorded E2E, and mutation-test evidence. Existing DesignDocument, operation validation, atomic persistence, and renderer contracts remain authoritative.
