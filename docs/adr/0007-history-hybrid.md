# ADR 0007: Combine operation history with snapshots

- **Status:** Proposed
- **Context:** Users need fine-grained undo and named recoverable milestones.
- **Decision:** Record committed operation batches and maintain snapshots for efficient restore and comparison.
- **Alternatives:** Snapshots only; Git as the only history model.
- **Consequences:** Storage must preserve ordering and integrity; restore is a new auditable transition.
