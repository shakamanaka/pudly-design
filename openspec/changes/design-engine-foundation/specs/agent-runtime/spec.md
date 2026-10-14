## Purpose

Defines a bounded, inspectable agent workflow that turns user intent into validated design operations without coupling domain behavior to a specific coding agent.

## ADDED Requirements

### Requirement: Active-page operation authorization
An unselected request MUST include and authorize only its validated active page subtree and root placement on that page. Selected requests MUST authorize only the selected subtree and in-scope new children. Project and ancestor-frame context references MUST NOT widen these operation grants.

#### Scenario: Known node ID on another page
- **WHEN** an unselected active-page request proposes editing a known node ID or creating a root on another page
- **THEN** the entire batch is rejected and the document remains unchanged

### Requirement: Agent integration uses a bounded port
The application MUST communicate with an agent through a contract supporting execution, cancellation, status, and streamed events. Agent integrations MUST keep process invocation and credentials outside the browser and MUST pass untrusted prompt text as data, never as shell syntax.

#### Scenario: Prompt contains shell metacharacters
- **WHEN** a user prompt contains command-like text or shell metacharacters
- **THEN** the adapter passes it as input data and does not execute it as a command

### Requirement: Run lifecycle distinguishes agent and design success
An agent run MUST expose states QUEUED, PLANNING, RUNNING, VALIDATING_OPERATIONS, APPLYING, RENDERING, QA, SUCCEEDED, FAILED, CANCELLED, and ROLLED_BACK. Allowed transitions are QUEUED→PLANNING|CANCELLED|FAILED; PLANNING→RUNNING|CANCELLED|FAILED; RUNNING→VALIDATING_OPERATIONS|CANCELLED|FAILED; VALIDATING_OPERATIONS→APPLYING|CANCELLED|FAILED; APPLYING→RENDERING|ROLLED_BACK|FAILED; RENDERING→QA|FAILED; QA→SUCCEEDED|FAILED. SUCCEEDED, FAILED, CANCELLED, and ROLLED_BACK are terminal. QA MUST confirm the committed revision, successful rendering of that revision, absence of blocking operation diagnostics, valid document invariants, and passing configured design-system rules. Optional accessibility/visual checks MUST be reported as configured, passed, failed, or not run. Cancellation before commit ends CANCELLED and discards the draft. ROLLED_BACK is reserved for an explicitly discarded pre-commit draft; no post-commit restore occurs as part of the original run. Cancellation after commit MUST NOT claim rollback and the run MUST continue to rendering/QA or report their failure. A successful process exit MUST NOT by itself mark a design run successful.

#### Scenario: Agent exits successfully with invalid operations
- **WHEN** the process exits successfully but returns malformed or semantically invalid operations
- **THEN** the run ends failed and the document remains unchanged

#### Scenario: Cancellation after transaction commit
- **WHEN** cancellation arrives after the atomic document commit has completed
- **THEN** the run continues to render and quality checks; it may end SUCCEEDED only if those checks pass, otherwise it ends FAILED with the committed revision identified and does not claim that cancellation reverted the document

### Requirement: Run context is scoped and inspectable
Each run MUST retain its user request, selected node IDs, resolved context scopes, design-system rules applied, operation capability set, validation outcomes, and before/after revision references. It MUST capture the document base revision when context is assembled. If the document revision changes before apply, the response MUST be rejected as stale; it MUST NOT be silently rebased. Context MUST be limited to relevant document fragments and MUST not expose secrets in logs or design data.

Useful run records MUST survive process restart through a versioned, validated local run-store adapter. This metadata store is separate from the atomic document/history/ledger envelope. A restarted nonterminal run becomes FAILED with an interrupted-run diagnostic; it MUST NOT rerun implicitly. If its linked batch committed before interruption, recovery MUST retain that identifiable committed revision from the durable history. Terminal success MUST not be published before run-record persistence succeeds. Storage errors preserve the committed design and produce actionable failure. The store retains bounded records and cannot accept caller-controlled filesystem paths.

#### Scenario: Restart after generation
- **WHEN** the local service restarts after a generation
- **THEN** the recorded request, context, operations, validation and committed revision remain inspectable, and interrupted work is reported without implicit regeneration or rollback

#### Scenario: Selection narrows context
- **WHEN** the user asks for an edit with a selected section
- **THEN** the run context identifies that selection and supplies relevant document data without requiring the entire document

### Requirement: Agent proposals cannot bypass validation
Agent output MUST be parsed as untrusted data and submitted through the same operation validation and atomic transaction rules as direct user edits.

#### Scenario: Agent proposes an out-of-scope node edit
- **WHEN** an operation targets a node outside the run's authorized scope
- **THEN** the operation is rejected and no partial batch is committed

### Requirement: Run responses cannot overwrite intervening edits
A run MUST bind its operation batch to the revision captured when prompt context was assembled. If a user or another transaction changes the document before apply, the agent response MUST be rejected with a stale-revision diagnostic and leave the newer document untouched.

#### Scenario: User edits during generation
- **WHEN** the document revision advances while an agent run is generating operations
- **THEN** the agent batch is rejected and the user is asked to explicitly retry with fresh context

### Requirement: Generation proposals are structurally constrained
The agent response schema MUST describe capability-filtered operation objects with closed fields. The decoder MUST reject malformed or unknown fields before native batch application. Explicit documented lowering MAY fill defaults but MUST NOT infer repairs or bypass native validation.

#### Scenario: Top-level placement field is proposed
- **WHEN** a node proposal supplies position outside layout
- **THEN** the response is rejected with an actionable diagnostic and the prior document is unchanged

### Requirement: Generation deadlines and failures are actionable
The default generation deadline MUST be bounded at 300 seconds, with trusted server integer configuration between 30 and 600 seconds. Invalid configuration MUST fail startup. Typed adapter failure codes and safe messages MUST survive application processing and run persistence without exposing process stderr or secrets.

#### Scenario: Generation deadline expires
- **WHEN** the configured generation deadline expires before commit
- **THEN** the run terminates with agent.timeout and its safe explanation remains visible after reopen

#### Scenario: User cancels recorded generation
- **WHEN** the user cancels a pre-commit generation
- **THEN** the process stops, run becomes CANCELLED and automation observes cancellation as terminal without retrying implicitly
