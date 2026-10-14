## Why

Codex Design has no existing application or domain model, so implementation without shared behavioral contracts risks making renderer code, generated Vue, or an external design tool the accidental source of truth. This change establishes the framework-neutral design engine and an honest initial walking-skeleton boundary before implementation begins.

## What Changes

- Define versioned document semantics, stable identity, graph invariants, component definitions and instances, layout, styles, responsive rules, and explicit migrations.
- Define validated serializable operations and atomic revision-aware batches as the sole mutation path.
- Specify a renderer-backed canvas, stable-ID selection, and an inspector that emits the same operations.
- Specify bounded agent runs, inspectable scoped context, and safe operation application independent of any specific agent process.
- Define framework-neutral design-system contracts and deterministic validation.
- Define operation-aware history, durable persistence, and failure recovery.
- Define target-neutral exporter contracts and semantic fidelity reporting for native, Vue, and Figma outputs.
- Scope the first implementation milestone to a vertical skeleton; defer complete product MVP capabilities to explicitly sequenced follow-on milestones in this change's task plan.

## Capabilities

### New Capabilities
- `design-document`: Versioned semantic IR and graph invariants.
- `design-operations`: Typed operations, validation, and atomic batches.
- `canvas-selection-inspector`: Rendering, stable selection, and shared editing pipeline.
- `agent-runtime`: Run lifecycle, safe agent port, and inspectable context.
- `design-system`: Framework-neutral tokens, components, variants, and validation.
- `history-persistence`: Reversible history, snapshots, durable saves, and migration safety.
- `export-architecture`: Isolated exporters and semantic loss reporting.
- `product-mvp`: User-visible product flows, operational states, and staged MVP acceptance.

### Modified Capabilities

None.

## Impact

New domain, application, and adapter modules; project documentation and OpenSpec workflow; eventual Vue canvas and local runtime; persistence and export adapters; and unit, integration, browser, accessibility, security, and export fidelity checks. The user-selected DeusData/codebase-memory-mcp is installed and initial workspace retrieval has been verified; refresh after implementation changes remains required.
