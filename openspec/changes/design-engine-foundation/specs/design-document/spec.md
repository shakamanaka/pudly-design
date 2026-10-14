## Purpose

Defines the portable, versioned design representation that remains authoritative for editing, rendering, history, and export throughout Codex Design.

## ADDED Requirements

### Requirement: Root-relative graph bounds
Document ownership and component-template ownership MUST reject paths deeper than 64 levels from their actual roots regardless of object-map insertion order. Validation MUST use bounded iterative traversal rather than recursively consuming the process call stack.

#### Scenario: Deepest-first graph order
- **WHEN** a 65-level ownership tree is supplied with deepest nodes inserted first
- **THEN** validation rejects the root-relative depth and preserves the previous document

### Requirement: Document has explicit semantic structure
A design document MUST identify its schema version, stable document identity, revision, ordered pages, semantic nodes, design tokens, component definitions, and metadata. Pages MUST own ordered root nodes; each ordinary node MUST have exactly one parent or be a page root. Supported node kinds MUST include frame, group, text, image, icon, vector, and component instance. Every node MUST have an explicit visibility value and typed layout constraints. Free layout MUST use a finite logical-pixel x/y position; stack layouts MUST omit position. Icon identity MUST consist of library ID and icon name, distinct from the node’s display name. Template nodes in component definitions MUST retain the same content-specific payloads and styles as ordinary supported nodes.

#### Scenario: Read a valid document
- **WHEN** a supported versioned document is loaded
- **THEN** its page order, node identities, parent-child relationships, tokens, and component definitions are available without deriving them from rendered output

### Requirement: Document graph is valid and bounded
The system MUST reject duplicate identities, cycles, dangling references, multiple ownership, invalid component references, incompatible token values, non-finite geometry, unsupported schema versions, and documents exceeding configured node-count or depth limits. Invalid input MUST NOT replace the last valid in-memory or persisted document.

#### Scenario: Reject a cyclic graph
- **WHEN** a proposed document contains a node reachable from itself through child ownership
- **THEN** validation reports the graph error and retains the prior valid document

#### Scenario: Reject an unsupported newer version
- **WHEN** a stored document declares a schema version newer than the reader supports
- **THEN** loading fails with a version diagnostic and does not rewrite or downgrade the stored bytes

#### Scenario: Broad nested input exceeds the structural budget
- **WHEN** children plus already scheduled siblings exceed the validation entry budget
- **THEN** validation rejects before allocating traversal entries beyond the budget and retains the prior document

### Requirement: Design semantics remain target neutral
Layout, sizing, constraints, responsive rules, semantic styles, assets, icons, and vector data MUST be represented without requiring CSS, Vue, browser DOM, or Figma concepts. Layout MUST express arrangement, alignment, gap, padding, typed measures, and fixed/fill/hug sizing. Responsive behavior MUST be explicit breakpoint overrides for supported layout, sizing, or visibility properties. Component definitions MUST be separate from instances; instances MUST reference a definition and variant with validated property overrides. Definitions MUST declare typed properties and may declare typed content slots with an anchor template node, accepted node kinds, and cardinality. Property bindings MUST point to existing template nodes with compatible target types. Required values MUST resolve from instance override, then variant override, then definition default; a missing required value is invalid. Variant property and node overrides MUST target declared properties and existing template nodes.

#### Scenario: Render-equivalent document exports to another target
- **WHEN** a document contains semantic layout, token references, and component instances
- **THEN** its representation can be consumed by the canvas and exporters without storing renderer-generated CSS as source data

### Requirement: Migrations are explicit and loss-aware
The system MUST migrate only explicitly supported older schema versions through deterministic, versioned migrations. It MUST NOT imply support for a prior version that has no defined migration. A migration failure MUST preserve original data and return actionable diagnostics; unknown fields MUST be rejected with a diagnostic and MUST NOT be silently dropped or converted into another semantic value.

#### Scenario: Migrate a supported prior version
- **WHEN** a valid document uses a supported older schema version
- **THEN** the migration produces a valid current document and records the source and target versions

### Requirement: Responsive rules have deterministic evaluation
Responsive breakpoints MUST be typed numeric minimum canvas widths in logical pixels. For canvas width W, the system MUST apply only rules whose breakpoint is <= W, in increasing breakpoint then priority order; later applicable values override only explicitly specified fields. Equal breakpoint-and-priority rules with overlapping fields MUST be rejected. Literal layout measures in this schema MUST use logical pixels; unsupported units MUST be rejected. Token categories MUST have typed category-specific values and references MUST match the consuming category. Free-layout positions and constraints MUST use finite logical-pixel values.

#### Scenario: Resolve responsive overrides
- **WHEN** multiple valid responsive rules match the canvas width
- **THEN** their explicit overrides resolve deterministically in breakpoint and priority order while unspecified base values remain in effect

#### Scenario: Reject ambiguous rules
- **WHEN** two rules at the same breakpoint and priority override the same field
- **THEN** document validation rejects the conflicting rules
