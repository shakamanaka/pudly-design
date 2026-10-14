## Purpose

Defines the only authorized mutation contract for user, agent, keyboard, and inspector edits to a design document.

## ADDED Requirements

### Requirement: Component inspector property mutations
The supported `property.set` operation MUST accept `variantId` string and `propertyOverrides` typed value map mutations only for component instances. Definition validation MUST reject undefined variants, unknown properties and incompatible values atomically. Undo MUST restore the previous variant or override map.

#### Scenario: Reject an undefined variant
- **WHEN** a property mutation assigns an undefined variant to a component instance
- **THEN** the batch leaves the prior variant and revision unchanged and returns a component validation issue

#### Scenario: Undo a component property change
- **WHEN** a valid instance property override map is replaced and then undone
- **THEN** the prior map is restored through the shared operation pipeline

### Requirement: Operations are typed and serializable
A design operation MUST use a finite, versioned operation vocabulary with explicit target identifiers and values. The complete planned vocabulary MUST cover create, delete, move, duplicate, set property, set layout, set style, set token, set constraint, group, ungroup, create/delete/rename page, create component, create instance, detach instance, create variant, and set variant. At each milestone, the system MUST negotiate and expose only the subset actually implemented and validated; the walking skeleton may begin with create/delete/move and property/layout/style edits. Arbitrary object paths, executable payloads, and prototype-property mutation MUST be rejected.

#### Scenario: Reject an unknown operation
- **WHEN** a batch contains an operation type not supported by the negotiated capability set
- **THEN** validation rejects the batch with an indexed diagnostic and changes no document state

### Requirement: Operation batches are revision-aware and atomic
A batch MUST identify its batch ID, document ID, expected revision, source, capability set, and ordered operations. Operation envelopes and values MUST be immutable snapshots after submission. A per-document transaction sequencer MUST provide a linearization order for concurrent commits. Deleting a parent MUST explicitly choose subtree deletion or rejection when children exist; subtree deletion removes the full owned subtree atomically. Deleting a referenced component definition MUST be rejected until references are removed. The system MUST validate runtime shape, authorization and scope, each operation, and the resulting document graph against an isolated draft before commit. Success commits all operations together and increments revision once; any failure leaves document and revision unchanged. Stale revisions and previously committed batch IDs MUST be rejected without reapplying mutations.

#### Scenario: A later invalid operation aborts the batch
- **WHEN** an operation after one or more otherwise valid operations makes the draft invalid
- **THEN** the system returns the failing operation index and commits none of the batch

#### Scenario: Reject a stale batch
- **WHEN** expected revision differs from the current document revision
- **THEN** no operation is applied and the caller receives a conflict diagnostic

### Requirement: Operation results are auditable and reversible
The system MUST return the batch outcome, resulting revision when committed, diagnostics, and sufficient before/after information for history and recovery. Operation input and output MUST be detached from mutable caller-owned object references.

#### Scenario: Caller mutates a submitted value after commit
- **WHEN** a caller changes an object it previously supplied to a committed operation
- **THEN** the committed document remains unchanged

### Requirement: UI and agent mutations use one pipeline
All document changes initiated by an agent, inspector, toolbar, keyboard action, or future extension MUST pass through the same validation and transaction boundary.

#### Scenario: Inspector changes layout
- **WHEN** a user edits a frame's gap in the inspector
- **THEN** the edit is represented, validated, committed, and recorded as a design operation
