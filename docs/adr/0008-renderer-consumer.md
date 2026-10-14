# ADR 0008: The canvas is a document consumer

- **Status:** Proposed
- **Context:** Vue is suitable for application UI but must not define the design data model.
- **Decision:** Vue renders the semantic document and emits stable-ID interactions; design mutations return through operations.
- **Alternatives:** Edit an iframe's app DOM; reverse-engineer rendered styles.
- **Consequences:** Renderer logic can change without changing the source document; render failures remain distinct from transaction outcomes.
