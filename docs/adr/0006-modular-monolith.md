# ADR 0006: Begin with a modular monolith

- **Status:** Proposed
- **Context:** The repository is empty and domain boundaries are more important than deployment boundaries.
- **Decision:** Separate domain, application, and adapter modules in one application; keep external systems behind ports.
- **Alternatives:** Microservices; a single framework-coupled module.
- **Consequences:** Local deployment stays simple while imports enforce portability; module boundaries require review.
