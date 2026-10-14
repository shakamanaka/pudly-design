# ADR 0002: Represent design semantics rather than CSS declarations

- **Status:** Proposed
- **Context:** CSS is renderer-specific and does not carry enough intent for reliable multi-target export.
- **Decision:** Model arrangement, spacing, sizing, constraints, responsive overrides, and semantic styles with typed values and token references.
- **Alternatives:** Store CSS-like property bags; store only absolute geometry.
- **Consequences:** Adapters translate semantics; some target mappings need explicit fallback diagnostics.
