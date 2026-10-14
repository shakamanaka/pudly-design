# ADR 0010: Agent execution is an untrusted adapter

- **Status:** Proposed
- **Context:** Process behavior, credentials, output format, and availability depend on the local environment.
- **Decision:** Keep execution behind a bounded agent port; pass prompts as data, parse output as untrusted, and validate operations before commit.
- **Alternatives:** Let the model rewrite storage directly; invoke shell with interpolated prompt text.
- **Consequences:** Adapter lifecycle and operation validity are separate success conditions; real integration evidence remains necessary.
