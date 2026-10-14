## Purpose

Defines product-level user outcomes and honest staged acceptance for an AI-native design environment whose editable document remains the source of truth.

## ADDED Requirements

### Requirement: Product edits begin with intent and produce editable design
The product MUST support a user submitting a natural-language design request that can produce an editable design through the defined agent and operation pipeline. Completion MUST be shown only after valid operations commit and the resulting document is available to the renderer.

#### Scenario: Create a design from a prompt
- **WHEN** a user submits a supported design prompt
- **THEN** the product presents run progress and the committed editable result, or a clear failure with no false success state

### Requirement: Product preserves source-of-truth boundaries
The product MUST treat the design document as authoritative for canvas, inspector, history, and exports. Generated Vue, HTML, CSS, DOM, screenshots, and Figma files MUST remain derived outputs.

#### Scenario: Export differs from editable document
- **WHEN** an exported artifact cannot preserve an editable semantic feature
- **THEN** the product retains the source document and communicates the export limitation

### Requirement: Product provides recoverable editing
Users MUST be able to select semantic nodes, edit supported properties through the inspector, and recover from a committed edit using history. Every asynchronous action MUST communicate progress, failure, cancellation, and recovery in understandable language.

#### Scenario: Recover after an unwanted edit
- **WHEN** a user applies an unwanted supported edit
- **THEN** the product offers a history action that restores the prior design state

### Requirement: Milestone claims match delivered behavior
Each milestone MUST report its delivered user behavior and evidence separately from deferred scope. The walking skeleton is accepted only when a real prompt-to-operation-to-commit-to-render path and stable-ID selection work, and invalid operations leave state unchanged. Full MVP acceptance additionally requires direct inspector edits, inspectable scoped context, persistence and history, responsive design-system behavior, and native, Vue, and Figma export with fidelity reporting. A mock agent response MUST NOT substitute for required real Codex integration evidence.

#### Scenario: Walking skeleton lacks real Codex evidence
- **WHEN** an implementation only exercises a mock response or the real Codex adapter is unavailable
- **THEN** the milestone is marked incomplete for the real prompt-to-design path

#### Scenario: Full MVP exporter is unavailable
- **WHEN** any required target exporter is absent or has unreported semantic loss
- **THEN** full MVP is not declared accepted and the missing capability is reported

### Requirement: Product access follows local trust boundaries
The product MUST keep process execution, filesystem access, and secrets behind a trusted local boundary with bounded requests from the browser. User-controlled prompts and design values MUST be handled as untrusted data.

#### Scenario: Browser requests agent execution
- **WHEN** the browser submits an agent request
- **THEN** a bounded local interface validates its scope before trusted process execution
