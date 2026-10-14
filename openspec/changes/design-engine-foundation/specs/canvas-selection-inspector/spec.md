## Purpose

Defines how users see and directly edit the semantic design document through an interactive canvas and inspector.

## ADDED Requirements

### Requirement: Canvas renders the design document
The canvas MUST render from the current design document and MUST NOT use arbitrary generated application code or a DOM snapshot as its design source. Rendering metadata MAY map rendered elements to stable node IDs but MUST NOT become persisted design identity.

#### Scenario: Render a frame from semantic data
- **WHEN** a valid document is opened on a page
- **THEN** the canvas presents that page's design nodes using their semantic layout and style values

### Requirement: Selection uses stable node identities
Canvas selection MUST identify one or more stable design node IDs. DOM selectors and transient renderer element identities MUST NOT be exposed as selection identity. Selection operations MUST reject IDs outside the active document or currently visible page scope.

#### Scenario: Select a rendered text node
- **WHEN** a user selects a text layer on the canvas
- **THEN** selection state contains the corresponding document node ID

### Requirement: Inspector edits are type-aware operations
The inspector MUST expose editable properties appropriate to selected node types and MUST submit edits through the shared design-operation pipeline. Invalid values MUST be shown with actionable validation and MUST leave the document unchanged.

#### Scenario: Inspector submits an invalid component variant
- **WHEN** the selected instance is assigned an undefined variant
- **THEN** the operation is rejected, the prior variant remains displayed, and the validation issue is visible

### Requirement: Canvas interaction has recoverable states
Asynchronous canvas actions MUST communicate loading, success, failure, cancellation, and recovery outcomes in user-understandable terms.

#### Scenario: Renderer fails after a valid commit
- **WHEN** the document commits successfully but canvas rendering fails
- **THEN** the committed revision remains identifiable and the user receives a recoverable rendering error rather than a false rollback claim

### Requirement: Canvas controls expose their visible text
A selectable text node with nonblank visible content MUST include that content in its accessible control name. Layer kind and name MAY be supplementary description. Empty text nodes MUST retain a meaningful layer-based control name. Keyboard selection MUST continue to use the stable node ID.

#### Scenario: Text content differs from layer name
- **WHEN** a text layer named Heading contains visible content Welcome
- **THEN** its selection control exposes Welcome in its accessible name and Enter selects the same stable node ID
