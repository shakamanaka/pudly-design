## Why
The Codex selector exposes only a static Sol6.1 entry instead of the connected CLI account catalog. Users need all account-reported Codex models and their advertised reasoning choices without mistaking discovery for successful generation verification.

## What Changes
- Discover Codex models through bounded read-only app-server model/list calls, including pagination.
- Present a real model dropdown with per-model efforts and preserve selection when refreshing.
- Keep connection-specific verification separate from catalog support; expose honest fallback status on discovery failure.
- Keep API-key account catalogs isolated from local ChatGPT credentials.

## Capabilities
### New Capabilities
- `codex-model-catalog`: Dynamic account-scoped model discovery and selection.
### Modified Capabilities
- None; typed atomic operations remain unchanged.

## Impact
Provider registry, domain effort/model DTOs, Codex catalog adapter, UI selection and independent fixture/browser/mutation tests. No authentication or billing fallback, global config writes, or design generation during discovery.
