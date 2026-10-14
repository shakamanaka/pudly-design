# ADR 0005: Commit operation batches atomically

- **Status:** Proposed
- **Context:** A partially applied agent response can leave a design in an unintended state.
- **Decision:** Apply batches to isolated drafts, validate the resulting graph, then commit once at an expected revision.
- **Alternatives:** Incremental visible mutation with compensating undo; last-write-wins.
- **Consequences:** Failures preserve prior state; draft validation has bounded memory cost.
