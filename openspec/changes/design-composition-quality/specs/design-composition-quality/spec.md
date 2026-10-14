## ADDED Requirements
### Requirement: Scope-aware shared composition brief
All supported adapters SHALL honor the authorized design prompt and share composition guidance for complete page requests without expanding scoped edits or explicit minimal component requests.
#### Scenario: Simple store page
- **WHEN** a user requests a store page with a simple prompt
- **THEN** the brief calls for coherent full-width responsive brand/navigation/hero/catalog/trust/footer composition with authored visual content
#### Scenario: Small scoped edit
- **WHEN** a user requests a component, minimal design or selected-subtree edit
- **THEN** page-completeness requirements do not expand its scope
### Requirement: Verified native illustrations
Typed agent operations SHALL support native vector creation only through validated semantic pathData and viewBox fields, with canvas and export evidence.
#### Scenario: Native vector proposal
- **WHEN** a valid vector is proposed
- **THEN** the atomic batch preserves editable vector semantics and renders real SVG paths
#### Scenario: Unsafe visual proposal
- **WHEN** invalid path data or unsupported SVG markup is proposed
- **THEN** it is rejected without committing design changes
### Requirement: Bounded composition review
Page proposals SHALL be checked for objective completeness before commit, and incomplete proposals SHALL receive at most one repair attempt on the same selected provider/model. Discovery or structural validation SHALL NOT be represented as aesthetic certification.
#### Scenario: Skeleton repaired
- **WHEN** a full-page proposal lacks page width, composed structure or requested authored visual content
- **THEN** actionable feedback is supplied to one repair attempt before any persistence
#### Scenario: Repair remains incomplete
- **WHEN** both proposals fail composition checks
- **THEN** the run fails with quality diagnostics and the original document/history remains unchanged
#### Scenario: Cancellation or stale revision
- **WHEN** a retry is cancelled or the document revision changes
- **THEN** no retry bypasses cancellation, scope or revision validation
#### Scenario: Reversed responsive layout
- **WHEN** an image-led page retains multiple fill columns or long unbounded navigation in a horizontal mobile row
- **THEN** it receives min-width/mobile-first repair guidance before persistence
#### Scenario: Bounded page illustrations
- **WHEN** a full-page candidate has native vector axes sized only by unconstrained hug at mobile or desktop
- **THEN** it receives explicit fixed/fill bounding and layered-frame guidance before persistence, without applying implicit geometry changes
#### Scenario: Opaque authored text contrast
- **WHEN** supported opaque authored text/background colors in a full-page candidate make copy or an action unreadable under4.5:1normal or3:1large contrast
- **THEN** the proposal receives contrast feedback before persistence; unsupported transparency remains inconclusive
#### Scenario: Long tablet row
- **WHEN** an image-led page places long hug text beside other content in a768px horizontal row
- **THEN** it receives tablet stacking or fill-bounds guidance before persistence
#### Scenario: Full-page runtime budget
- **WHEN** a page is generated without an explicit caller deadline
- **THEN** each of at most two attempts is bounded to 600 seconds, while explicit deadlines and non-page 300-second defaults remain authoritative
#### Scenario: Claude streamed result validation
- **WHEN** Claude emits metadata and assistant events followed by a final SDK result
- **THEN** only exactly one successful typed result with validated structured_output authorizes operations, and malformed/duplicate/missing/error results fail without accepting partial tool input
### Requirement: Real visual acceptance
The feature SHALL be accepted using real provider generation and recorded headed browser review of a simple store prompt, including desktop/mobile composition, readable non-overlapping content, exports and reload.
#### Scenario: Puppy store acceptance
- **WHEN** the simple puppy-store prompt is tested
- **THEN** actual generated design and responsive browser evidence are reviewed independently of fixture results
