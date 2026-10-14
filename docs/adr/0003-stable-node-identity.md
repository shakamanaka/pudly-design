# ADR 0003: Selection and references use stable node IDs

- **Status:** Proposed
- **Context:** Renderer elements are transient and can change during rerendering.
- **Decision:** Persistent references and selection use stable document node identifiers; renderer metadata only maps to those IDs.
- **Alternatives:** DOM selectors; array indexes; generated element handles.
- **Consequences:** Operations and context remain stable across renders; IDs need validation and migration rules.
