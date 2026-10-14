# ADR 0001: Semantic design document is authoritative

- **Status:** Proposed
- **Context:** Codex Design needs one editable source that multiple renderers and exporters can consume.
- **Decision:** Use a versioned, framework-neutral semantic document graph as the source of truth.
- **Alternatives:** Generated Vue/DOM source; screenshots; Figma as canonical storage.
- **Consequences:** Canvas and exports are derived consumers; schema evolution and validation are required.
