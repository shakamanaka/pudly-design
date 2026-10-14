## Context
Read-only diagnostic proved full environment and allowlist+USER authenticate, while allowlist and full environment minus USER do not. Current Claude catalog is static and verification failure is labeled Unavailable.
## Decisions
Share a sanitized Claude environment preserving USER and LOGNAME with adapter and discovery. Use auth status and stream-json SDK initialize control without sending a user prompt, with timeout/output bounds, temporary cwd, safe mode/restricted/no-tools and process-group cleanup. Cache/singleflight discovery per connection and do not borrow subscription results for API keys. Expose only authenticated/signed-out/unknown session status, not email, org or tokens. Models remain unverified until exact explicit verification; efforts come from model metadata when supplied and missing metadata must not fabricate guarantees.
## Risks
SDK controls change across CLI versions. Failed discovery must remain honest and recoverable. One explicit real subscription verification is permitted as acceptance; no automatic repeated inference, routing or paid fallback.
