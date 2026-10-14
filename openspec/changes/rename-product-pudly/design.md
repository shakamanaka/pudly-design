## Context
Product names appear in UI, prompts, docs and exporter metadata; existing users already have private data and preferences.
## Goals / Non-Goals
Goals: consistent Pudly branding. Non-goals: moving the checkout, repository remote, credentials, data or changing native formats.
## Decisions
Update human product names and public package/archive names. Keep `.codex-design/`, CODEX_DESIGN_* variables, local-storage key and temporary/internal prefixes to preserve compatibility. Document legacy names. Keep real Codex tool/provider references. Historical artifact paths remain factual.
## Risks / Trade-offs
Legacy internal identifiers remain → explain compatibility in README. Export-name assertions change → update existing tests and run export/browser checks.
