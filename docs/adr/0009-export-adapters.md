# ADR 0009: Export targets are isolated adapters

- **Status:** Proposed
- **Context:** Vue, Figma, and native formats have different capabilities and dependencies.
- **Decision:** Each exporter translates the same validated document and reports unsupported or degraded semantics.
- **Alternatives:** Put target fields throughout the domain; export from screenshots or rendered DOM.
- **Consequences:** Export fidelity is explicit and target integrations can evolve independently.
