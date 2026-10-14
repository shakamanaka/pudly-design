# Claude session and catalog independent QA

Status: focused deterministic fixtures are implemented. This report is independent fixture and mutation evidence; it does not establish live Claude subscription access or inference success.

## Coverage

`tests/provider-qa/integration/claude-session-catalog.test.ts` directly exercises the Claude environment, bounded read-only auth/catalog helpers, and connection service with local fixture executables and injected callbacks. It checks:

- `USER` and `LOGNAME` survive the process allowlist while ambient Anthropic keys, Bedrock/Vertex routing switches, and `NODE_OPTIONS` do not; an explicitly selected API credential is the only API key forwarded.
- Auth invokes only `claude auth status` in a temporary directory and returns only sanitized status/timestamp fields. `loggedIn: true` with nonzero exit, malformed JSON shape, timeout, and process-start/timeout errors do not become authenticated; explicit `loggedIn: false` remains unauthenticated. Minimal shell timeout fixtures write their PID before sleeping, so cleanup checks prove that a child started and was then reaped under suite contention.
- Catalog discovery sends only the SDK `initialize` control request, uses stream JSON with verbose output and no tools, and never sends a user prompt. Versioned/additional model IDs, labels, and advertised effort order survive parsing. Missing/unknown efforts and malformed records produce partial status; malformed envelopes, oversized output, and timeout produce unknown status.
- Auth/catalog timeouts terminate and reap the fixture process. Discovery is read-only and does not call the injected inference adapter. Subscription session/catalog data stays scoped to the subscription connection, API-key views have no local-session status and retain their independent catalog, catalog entries remain unverified, and an effort absent from model metadata is rejected before adapter creation.
- Typed Claude `usage_limit_reached` output maps to quota without retaining provider prose; an unrecognized 429 stays a generic CLI failure. This evidence does not classify arbitrary status codes or response prose as quota.

The fixtures use temporary directories and local child processes only. They issue no live provider request, design-generation prompt, or paid inference request.

## Mutation coverage

Seven named source mutants were added to `tooling/provider-mutation/mutants.json`: dropping `USER`/`LOGNAME`, accepting nonzero authenticated status, omitting the verbose SDK protocol flag, marking catalog discovery as inference availability, accepting an unadvertised effort, sharing subscription discovery with an API-key connection, and misclassifying the typed usage-limit error. Individual test names and outcomes are recorded by the mutation harness under the ignored `.codex-design/provider-mutation/` run directory.

## Verification record

The focused file passed 7/7 tests after switching timeout fixtures to a minimal `/bin/sh` process that writes its PID marker before execing `sleep`. This ensures the cleanup assertion proves termination of an actually-started child even while the test suite is under parallel load. An earlier Node fixture could hit its deadline before startup during the full gate; that test-only race is removed without weakening the process cleanup assertion.

The targeted fixture suite passed 7/7 tests. `node tooling/provider-mutation/run.mjs` passed its 57-test provider QA baseline and killed all 37 named source mutants, with zero survivors, timeouts, unapplied patches, or unconfirmed failures. The final report is `.codex-design/provider-mutation/mutation-report-2026-10-13T19-19-26.446Z.json`. All 30 prior provider mutants and seven Claude session/catalog mutants were included. The API-key isolation mutant asserts that API-key connections keep their independent static catalog; an earlier broader call-site mutation was equivalent because a second auth-source guard already prevented cross-use, so the final mutant targets the behavioral catalog classification boundary instead.

Root reports a separate headed recorded acceptance with 13 account-advertised Claude models, authenticated local session status, and an exact verification response classified as `provider.quota` and retained as a failed verification after reload. No successful inference is claimed.
