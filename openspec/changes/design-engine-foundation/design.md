## Context

See proposal.md for motivation. The repository is an empty initialized workspace; OpenSpec 1.9.0 uses the spec-driven schema. The execution brief records the proposed model and integration reconnaissance. The selected DeusData/codebase-memory-mcp integration is installed and its initial workspace index/retrieval are verified; final refresh-after-change verification remains a task. Source remains authoritative if index results disagree.

## Goals / Non-Goals

**Goals:**
- Freeze shared behavioral boundaries before parallel implementation.
- Prove an initial vertical slice while sequencing full MVP capabilities explicitly.
- Keep domain behavior portable across renderer, agent, persistence, and export adapters.

**Non-Goals:**
- Claim that planning artifacts constitute implemented or accepted product behavior.
- Introduce microservices, a marketplace, arbitrary source-code editing, or a Figma clone.
- Assume live Codex authentication, Figma write access, or Codebase MCP health without evidence.

## Decisions

1. **Semantic, versioned document graph is authoritative.** Nodes and design values express layout, sizing, styles, constraints, responsive overrides, tokens, and component relationships. Renderer-specific CSS is derived. Alternatives: DOM/source-first editing (rejected because it loses portable design semantics); screenshot-first generation (rejected because it cannot preserve editability).
2. **All changes use serializable typed operations and isolated atomic batches.** Validate the final graph before one revision increment; stale revisions and duplicate batch IDs fail. Alternatives: whole-document agent rewrites (too difficult to audit and recover); direct component state mutation (creates competing mutation semantics).
3. **Domain, application, and adapters form a modular monolith.** Domain packages import no Vue, browser APIs, process APIs, MCP, or Figma SDK. Alternatives: microservices (unjustified operational complexity); framework-coupled domain (compromises portability).
4. **Canvas and exporters are independent document consumers.** Vue may render the canvas; Vue and Figma exports translate the same document through separate adapters. Alternatives: generated app inside an iframe or DOM scraping (breaks source-of-truth boundary); screenshot export (lossy and non-editable).
5. **One transaction pipeline serves AI and direct manipulation.** Selection identifies stable node IDs; inspector edits produce the same operations as agent edits. Alternatives: inspector-specific mutations (inconsistent validation/history).
6. **History combines operation records with snapshots.** Operation-aware undo/redo and named snapshots provide efficient audit and recovery; storage writes are atomic and migrations explicit. Alternatives: snapshots only (coarse history) or Git only (source-control semantics do not express design edits).
7. **The walking skeleton is a gate inside a larger staged MVP.** First prove prompt → safe agent → typed operations → atomic commit → renderer → stable-ID selection, including invalid-batch rollback. Add inspector/context, persistence/history, design-system/responsive behavior, and exporters in later milestones. A successful process exit or mock output is not end-to-end acceptance.
8. **Agent and index integrations are ports.** The initial agent adapter passes prompt via stdin or an equivalent data channel, safely spawns without shell interpolation, applies time/output limits, and treats output as untrusted. Use the DeusData/codebase-memory-mcp integration behind the repository-index port; its initial index is verified, and refresh/retrieval checks remain required after source changes.

## Risks / Trade-offs

- Semantic IR may evolve as layout/export edge cases appear → keep schema versioned, maintain migration fixtures, and change specs before incompatible implementation.
- Transaction atomicity can increase memory cost for large documents → bound document size and measure before optimizing with structural sharing.
- Target exporters may not preserve every semantic → provide explicit per-feature fidelity diagnostics and keep the source document intact.
- Real agent execution and Figma access remain environment-dependent → report each as unverified until integration evidence exists; the Codebase MCP initial baseline is verified and must be refreshed/rechecked after substantial source changes.
- Shared contracts are broad for an empty repository → implement the walking skeleton first and negotiate capability sets so incomplete operation families are not advertised.

## Migration Plan

There is no existing application data to migrate. Add the first document schema as a versioned format, persist version and integrity metadata, and test explicit migrations before introducing later schema versions. Rollback consists of reopening the last valid persisted revision; never rewrite unknown newer document versions.


The normative cross-module declarations, limits, diagnostics, and test traceability live in [architecture-contracts.md](../../../docs/architecture-contracts.md). Treat them as the shared freeze point for parallel implementation; changes to these contracts require updating this OpenSpec change first.
