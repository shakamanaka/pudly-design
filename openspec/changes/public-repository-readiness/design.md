## Context
The repository has no commits or remote. Local projects, credentials, recordings and MCP configuration must stay outside the public source set.
## Decisions
Keep MIT standard with Camilo Escobar copyright and public contact. Preserve third-party MIT notices for generated OpenSpec skills and the adapted Codebase installer. Ignore local MCP config and provide a template. Keep runtime data and all acceptance videos outside Git. Default browser tests use offline fixtures; live tests require explicit opt-in and verified provider selection. Review a clean source-only checkout with npm ci and full checks. Configure only local Git author/email and retain no co-author trailers.
## Release Boundary
Do not create/push a GitHub repository in this change. Report readiness for the user's subsequent public publication request. No changes to runtime design semantics.
