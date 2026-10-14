## Context
Saved authoritative envelopes live in the local project directory; only a current pointer and create API are exposed. See proposal.md.
## Goals / Non-Goals
Expose durable project navigation and previews without mutating designs or invoking models. Image uploads/stock remain analysis-only this change; low-model quality acceptance is a separate continuation of composition evidence.
## Decisions
GET /api/projects returns {projects: ProjectSummary[]} with id,name,revision,updatedAt,nodeCount,status (available/unavailable), safe optional diagnostic. Sort descending saved-file timestamp, id tie-break. GET /api/projects/:id/preview returns {document: DesignDocument}; read-only, no history/credentials. POST /api/projects/:id/open returns {project: envelope}; DELETE /api/projects/:id returns {deleted:true,project: envelope|null}. Existing POST /api/project/new retained. Expose optional persistence discovery/removal capabilities for older memory test adapters, failing explicitly when absent.
Render previews from authoritative first-page document using existing canvas rendering at desktop width in inert scaled wrappers; fetch lazily/bounded and show unavailable/empty fallback. No synthetic pictures presented as actual preview. Grid/list toggles persist view in localStorage. UI creation uses name form; deletion has named inline confirmation. Successful switch resets selection/page/run display and never reruns history.
Removal moves an envelope to owner-only .trash under same filesystem, clears current pointer when necessary, under existing lock/serialization. Retain run records for audit; deleted project is excluded from normal list. Surface errors and keep current UI unchanged on failures. Symlinks/non-project files excluded; validate IDs and envelopes. Damaged entries do not hide healthy ones. Reject lifecycle mutations while any run is nonterminal.
## Risks / Trade-offs
Document previews can be large: load on demand rather than returning histories or every document in list. Removal is recoverable storage-level trash, not a new restore UI. Local multi-process races require shared file locks and pointer-safe ordering; test failures explicitly.
## Migration Plan
No schema migration: discover existing validated project JSON and timestamps. Preserve old envelopes and current selection.
## Open Questions
None for this bounded local explorer.

## Existing workspace adoption
The user's earlier real UI runs used isolated saved stores under .codex-design/dogfood/*/project-storage and .codex-design/live-projects. A one-time reviewed local import copies only validated envelopes from those known real-run stores into the canonical library, skips existing IDs without overwriting them, preserves original saved timestamps, verifies envelope/source-byte equality and uses private0600files. Original stores/checkpoints and run records remain untouched. Fixture test stores and provider credentials are excluded. This is workspace adoption, not an advertised arbitrary filesystem import UI. Evidence: .codex-design/project-explorer-acceptance/legacy-import.json.
