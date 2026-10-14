## Purpose

Defines reusable, framework-neutral visual tokens and component contracts with deterministic checks that guide and constrain both human and agent edits.

## ADDED Requirements

### Requirement: Design systems are framework-neutral
A design system MUST represent typed tokens, component definitions, variants, properties, constraints, semantic roles, documentation, and usage rules independently of any renderer or export framework. Supported token categories MUST include color, typography, spacing, radius, shadow, breakpoint, motion, and z-index.

#### Scenario: Resolve a spacing token
- **WHEN** a layout value references a valid spacing token
- **THEN** consumers can resolve its typed value without interpreting framework source code

### Requirement: Components and variants are validated
Component instances MUST refer to a known definition and supported variant, and property overrides MUST conform to declared property types and constraints. Required property resolution MUST follow instance override, variant override, then definition default. A bound property MUST target an existing compatible template-node field; conflicting direct node overrides MUST be rejected. Slots MUST identify a template anchor and validate supplied child kinds and cardinality. Definitions MUST not contain cyclic component expansion.

#### Scenario: Unknown variant is proposed
- **WHEN** an instance selects an undeclared variant
- **THEN** deterministic validation reports an error and the instance remains unchanged

### Requirement: Design-system validation is deterministic and configurable
Validation MUST identify violations such as unknown tokens, arbitrary un-tokenized values, invalid component properties, unknown variants, invalid children, spacing violations, and detached instances. Rules MUST support configured severity levels; a blocking error MUST prevent transaction commit.

#### Scenario: Arbitrary color violates strict policy
- **WHEN** a style introduces a literal color under a policy requiring color tokens
- **THEN** validation reports the policy violation at its configured severity and blocks commit when severity is error

The foundation policy profile defines `literal-color`, `literal-spacing`, `minimum-spacing`, and `detached-instance` rules with `off`, `info`, `warning`, or `error` severity, plus a finite nonnegative `minimumSpacingPx`. The default profile warns on literal colors, literal spacing and explicit detached provenance; minimum-spacing is off. Structural token/component errors always block. Explicit detached provenance uses the reserved document metadata key `detached:<nodeId>` with boolean true; this convention does not advertise an unimplemented detach operation. Component usage documentation may remain a separate framework-neutral catalog consumed by agent context.

### Requirement: Default system supports representative interfaces
The product MUST provide a coherent token-driven default system with a focused set of primitives sufficient for representative product interfaces. The initial scope MUST avoid requiring a marketplace or an exhaustive component catalog.

#### Scenario: Create an interface using default primitives
- **WHEN** a new project is created with the default system
- **THEN** its initial system provides documented tokens and basic components usable by the canvas and agent context
