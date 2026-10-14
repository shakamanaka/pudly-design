## Context
Existing KNOWN_MODELS contains one Codex candidate. Official app-server model/list reports model IDs, display names, hidden status and ordered supportedReasoningEfforts.

## Goals / Non-Goals
Expose the CLI catalog for the connected local ChatGPT account, with bounded pagination and model-specific effort. Discovery does not establish entitlement or generation acceptance. API-key catalogs may remain explicitly partial if their supported isolated discovery is unavailable; they must never inherit a local subscription catalog. No automatic routing, fallback billing, or quota-consuming model probes.

## Decisions
Use a subprocess with stdio JSON-RPC initialize handshake, model/list pagination, time/output/page limits, safe errors, and complete process-group cleanup. Do not retain raw responses or credentials in public data. Use a short cache and singleflight to avoid spawning duplicate discovery processes. Preserve supported effort ordering and expose default effort/hidden flags when provided. Keep verified tuples connection-specific; do not mark discovered models verified. Testing injects discovery responses; fixture services never contact real providers. UI uses a dropdown plus a manual custom-ID option and invalidates verification when model/effort changes.

## Risks / Trade-offs
CLI capabilities evolve; malformed or unavailable catalogs fail safely with explicit partial status. Some hidden models may not be intended for normal use; retain their hidden marker. Unsupported future effort strings must be explicit rather than silently advertised as executable.
