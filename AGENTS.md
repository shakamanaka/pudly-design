# Pudly

The full product directive is in docs/master-build-directive.txt. Read docs/development-journal.md and the active OpenSpec change before working.

## Architecture

DesignDocument is authoritative. Canvas and exporters consume it. Vue, CSS, DOM and Figma are derived representations. Domain code must not import framework, browser, process, filesystem or MCP APIs. All design mutations pass through typed, validated, revision-aware atomic operation batches. Do not advertise an operation until implemented and verified.

## Workflow

Use installed OpenSpec (currently 1.9.0): inspect instructions, review proposal/specs/design/tasks, implement, verify scenarios, archive only on accepted implementation. A structurally complete plan is not a completed product. The user's master directive explicitly authorizes autonomous implementation following reviewed specifications; do not introduce redundant approval steps from generic planning skills.

Use the configured DeusData/codebase-memory-mcp as primary indexed discovery. Project MCP entry is .codex/config.toml; one-shot native tools are available through tooling/codebase/launch.sh cli. See docs/codebase-mcp.md for exact root, health and refresh commands. Verify indexed results against actual source and refresh after substantial edits. If semantic retrieval has no relevant symbols, inspect source and record the limitation rather than inventing results.

Read docs/architecture-contracts.md for cross-module contracts and invariants. Update contracts/specs before changing externally observable behavior. Keep implementation and independent QA assignments separate. Use Luna agents for substantial independent work and explicit file ownership; coordinate interfaces before parallel implementation. Do not modify the Harvest reference repository.

## Evidence

Strict TypeScript, meaningful domain/unit/integration/component/browser tests, lint, build, and applicable accessibility/security/export checks. A real Codex run is required for prompt-to-design acceptance; fixtures verify only adapter contracts. Never claim successful design generation solely from process exit zero. Maintain the journal and traceability from critical specification scenarios to actual tests. Mark OpenSpec tasks complete only after all specified behavior passes verification.

## Language preference

Use English for all future subagent assignments, messages, and reasoning, regardless of the language used by the user. Preserve this preference across resumed sessions.
