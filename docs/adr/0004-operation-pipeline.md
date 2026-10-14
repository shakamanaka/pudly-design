# ADR 0004: All edits flow through typed operations

- **Status:** Proposed
- **Context:** AI, inspector, toolbar, and keyboard changes need consistent validation and audit.
- **Decision:** Represent each edit as a typed serializable operation applied by one domain pipeline.
- **Alternatives:** Direct state writes per UI surface; whole-document agent replacement.
- **Consequences:** Operation versions and capability negotiation are required; all mutation paths become auditable.
