# Changelog

## 1.0.0 — 2026-10-14

First basic public-source release, prepared locally for publication by the author.

### Included

- Local-first Vue editor backed by a versioned semantic DesignDocument.
- Validated atomic design operations, canvas selection, inspector and responsive previews.
- Local project library with grid/list previews, create/open/remove, history and snapshots.
- Explicit verified provider/model/effort selection for supported Codex, Claude and MiniMax connections; availability depends on the connected account.
- Bounded prompt-to-design generation and editable native vector illustrations.
- Native document, Vue/Vite and Figma development-plugin exports with fidelity reports.
- MIT license, attribution to Camilo Escobar, third-party notices and offline CI.

### Verification

Pre-release workspace and clean-source checks passed lint, strict types, 376 tests in 61 files and build. The clean-source offline Playwright suite passed nine browser cases; the opt-in live test was skipped. Independent scoped mutation checks are documented in the verification reports.

A separate real Sol 6.1 low professional-services demo retained four successful revisions, ending with 119 editable nodes and four architectural illustrations. Desktop 1440, tablet 768 and mobile 375 checks measured no horizontal overflow; reload preserved the document. This is evidence for one workflow, not a general quality guarantee. The development journal records the private local evidence location.

### Known limits

- Trusted local application, not a hosted multi-user service.
- Model output quality varies; Haiku page-generation acceptance remains unproven.
- Raster uploads, stock image search and stored photo rendering are not implemented.
- Vue exports may expand reusable instances to static nodes; Figma exports can degrade supported representations and require a development-plugin setup.
- Generated visual navigation and controls do not imply working website interactions.
- Tablet card layouts in the recorded demo still have room for polish.
