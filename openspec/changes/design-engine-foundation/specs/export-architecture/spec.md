## Purpose

Defines target-specific export boundaries that translate the same semantic design document while making unsupported or lossy mappings explicit.

## ADDED Requirements

### Requirement: Exporters consume the semantic document
Every exporter MUST consume a validated design document through an exporter boundary and MUST NOT infer design semantics from screenshots, rendered DOM, or generated application code. Export target details MUST remain outside the domain representation.

#### Scenario: Export a document with a component instance
- **WHEN** an exporter processes a document containing a reusable component instance
- **THEN** it maps from the definition, variant, and overrides in the document

### Requirement: Export reports fidelity and unsupported features
An export result MUST identify produced artifacts, warnings, and unsupported or degraded semantics. Each feature/node MUST receive a fidelity status of preserved, degraded, or omitted; degraded entries MUST name the fallback and omitted entries MUST include warning/error severity. Results MUST include target, overall status (`succeeded`, `partial`, or `failed`), artifacts with name/MIME type/encoding/content, fidelity entries, and diagnostics. `succeeded` requires all requested artifacts and all features preserved; `partial` requires at least one artifact and some degraded/omitted feature; `failed` means no artifact was produced. Overall success MUST be reported only when all required artifacts exist and all encountered features are preserved. Native serialization MUST round-trip every supported schema feature without loss; unsupported schema features MUST fail explicitly. The exporter MUST NOT silently discard unsupported design information while claiming full fidelity.

#### Scenario: Target cannot represent a responsive override
- **WHEN** a target lacks a direct mapping for a document responsive rule
- **THEN** the result reports the unsupported rule and its chosen fallback or omission

### Requirement: Initial targets are portable and isolated
The architecture MUST provide for native document serialization, Vue application export, and Figma export behind separate adapters. Target-specific libraries and credentials MUST be isolated from the domain and browser-facing data model.

#### Scenario: Native export round trip
- **WHEN** a supported document is serialized to native format and reopened
- **THEN** semantic content is preserved or any known loss is explicitly reported

### Requirement: Figma export maps semantics directly
Figma export MUST map document semantics to target nodes through the Figma integration boundary and MUST NOT use screenshot capture or DOM reverse engineering as its semantic mapping strategy.

#### Scenario: Figma export is unavailable
- **WHEN** authentication or write access is unavailable
- **THEN** export fails with an actionable status and does not claim that a Figma file was created

#### Scenario: Missing image or icon asset omits the whole target layer
- **WHEN** the Figma adapter cannot create an image or icon without its asset data
- **THEN** the node kind is reported as omitted and no layout or style feature on that omitted node is claimed preserved

#### Scenario: Export adapter returns failure without artifacts
- **WHEN** an export result reports failed or produces no artifacts
- **THEN** the editor displays an actionable error and never claims an artifact was downloaded

#### Scenario: Template definitions are expanded or unused
- **WHEN** a Figma export expands a component template with instance-specific values or leaves an unused definition unrendered
- **THEN** flattened definition fields report degraded semantics and unused fields report omitted target layers, rather than claiming definition preservation
