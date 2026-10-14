## Why
Claude Code is logged in, but the adapter removes USER and fails to recognize the local session. Its fixed three-alias catalog and generic Unavailable badge obscure the cause and omit account-advertised models.
## What Changes
- Preserve safe OS identity in the isolated Claude environment.
- Discover local authentication and model options through bounded read-only CLI/SDK controls.
- Separate session status, model catalog and exact inference verification.
- Keep API credentials isolated and preserve manual routing.
## Capabilities
### New Capabilities
- `claude-session-catalog`: isolated local-session recognition and account-derived model options.
### Modified Capabilities
None.
## Impact
Claude adapter, provider service/view DTO, connection UI, tests and recorded acceptance. No design operation or billing fallback changes.
