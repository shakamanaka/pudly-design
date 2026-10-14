# Local application API

Implementation contract for the local trusted adapter. Source behavior is specified by the active design-engine-foundation change. This is a single-user local modular monolith, bound to 127.0.0.1:5174. Vite UI uses /api through its proxy. Production serves static assets from the same server. Cross-origin websites cannot invoke mutating endpoints: enforce expected Host and allow only local UI/server Origins, JSON Content-Type and bounded JSON body. No user-controlled executable paths or filesystem paths are accepted.

## Endpoint contract

- GET /api/capabilities → { operationTypes: string[], exportTargets: (native|vue|figma)[], nodeKinds: string[] }. Advertise only implemented, validated behavior.

- GET /api/project → { project: PersistedProjectEnvelope | null }. Default project can be created by the application service on first launch; absent persisted project is not corruption.
- POST /api/project/new { name: string } → { project: PersistedProjectEnvelope }. Preserve existing projects; new UUID ID and default page. The server stores project envelopes under ignored .codex-design/projects; names do not become filesystem paths.
- POST /api/operations { batch: OperationBatch } → { result: ApplyResult, project: PersistedProjectEnvelope }. Rejection uses HTTP 422 or 409 on revision conflict; still returns current valid project and diagnostic result.
- POST /api/runs { prompt: string, selectedNodeIds: string[], expectedRevision: number } → HTTP202 { runId: string }. Capture document context/baseRevision in server before starting actual agent. Only one generation per current document; a second concurrent run gets409. Return immediately and poll state separately. No hardcoded agent result.
- GET /api/runs/:id → { run: AgentRunRecord, events: RunEvent[] }. Includes inspectable resolved context and validation/QA diagnostics; excludes credentials and process paths. State indicates committed revision even if rendering/QA later fails.
- POST /api/runs/:id/cancel {} → { run: AgentRunRecord }. Precommit stops process/draft; postcommit preserves revision. Clear operation progress messaging distinguishes generation, validating, applying, checking, complete, failed and cancelled.
- POST /api/runs/:id/rendered { revision: number, success: boolean, message?: string } → { run: AgentRunRecord }. Renderer acknowledgement MUST equal committed revision; success proceeds QA validating document/invariants/design system and marks SUCCEEDED only if checks pass. Failed renderer acknowledgement marks FAILED retaining committed state. Until acknowledged, state remains RENDERING, never fabricated success. Timeout after a bounded render acknowledgement wait is FAILED with committed revision.
- POST /api/history/:action { expectedRevision: number }, action undo|redo → { project: PersistedProjectEnvelope }. Durable, monotonic revision semantics; no available history returns actionable422.
- POST /api/snapshots { label: string, expectedRevision: number } → { project: PersistedProjectEnvelope }. Snapshot metadata save is durable but does not change design revision; conflicts rejected.
- POST /api/snapshots/:id/restore { expectedRevision: number } → { project: PersistedProjectEnvelope }. Restores semantic content at a new monotonic revision and appends audit transition.
- POST /api/export { target: native|vue|figma } → ExportResult. Only implemented exporters exposed. No live Figma file claim for a generated plugin artifact; plugin export must be explicitly distinguished from live export until real target writing exists.

Errors return { error: { code: string, message: string, diagnostics?: Diagnostic[] } }. Unknown keys, invalid identifiers and oversize input reject before mutation. Browser UI refreshes current project after run commit and acknowledges that exact revision after next Vue render tick. A run cannot apply against a newer revision than its context base; stale output rejects without overriding manual edits. Caller supplies no model/executable/working directory override.

## Shared application service

The application service owns the current project envelope, per-document promise sequencer, run registry and all mutation/history/persistence flows. Its public API follows endpoint behavior above. Domain apply is pure; service builds history and ledger then calls saveAtomically before publishing new state. No UI-specific direct document mutation and no process-specific imports in the domain. Persistence is a local-filesystem adapter with UUID-only filenames, integrity checksum, exclusive lock or single-process ownership, temp-file write/fsync and atomic rename. On failure preserve both old in-memory and durable envelopes.

Implementation owners must message the coordinator before changing these endpoints or shared shapes. Unsupported milestone features remain explicitly unavailable and unchecked in OpenSpec.
