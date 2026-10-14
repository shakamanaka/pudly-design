## Purpose

Defines durable document storage and operation-aware recovery so edits remain recoverable across undo, redo, crashes, and schema evolution.

## ADDED Requirements

### Requirement: History records domain mutations
Committed batches MUST be recorded with source, operation data, revision, timestamp, and run linkage when applicable. The system MUST support undo and redo with revision-safe semantics; each undo and redo MUST append an auditable history transition with a strictly increasing document revision, and a new edit after undo MUST discard the redo branch and MUST not use source-control history as the sole design history model.

#### Scenario: Undo then redo an inspector edit
- **WHEN** a committed inspector operation is undone and redone
- **THEN** the document returns to the before state and then the committed after state through validated document transitions

### Requirement: Snapshots are named and restorable
The system MUST support recoverable snapshots associated with revision and relevant request/run metadata. Restore MUST be an explicit validated transition that produces a new revision and preserves later history for comparison.

#### Scenario: Restore a prior named snapshot
- **WHEN** a user restores an earlier snapshot
- **THEN** its content becomes current at a new revision and the restore event remains auditable

### Requirement: Persistence is atomic and corruption-safe
Saving MUST atomically persist one envelope containing the document, operation history and cursor, named snapshots, and applied-batch ID ledger. The ledger MUST survive reopen so a previously committed batch cannot replay after process restart. Saving MUST avoid exposing a partially written document as the latest valid state; document and corresponding history/ledger state MUST never be persisted separately as if they formed one committed revision. On save or load failure, the system MUST report a recoverable error and preserve the last known valid document and stored version. Storage boundaries MUST identify document version and integrity metadata.

#### Scenario: Save fails midway
- **WHEN** persistence fails before durable commit
- **THEN** the previous durable document remains loadable and the UI does not report a successful save

### Requirement: Reopening preserves committed design state
A successfully saved project MUST be reopenable with its document, history references, and schema version intact.

#### Scenario: Reopen after committed operations
- **WHEN** a project with committed operations is closed and reopened
- **THEN** the latest committed document and available history are restored consistently
