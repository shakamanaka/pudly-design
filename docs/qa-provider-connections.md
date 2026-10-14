# Provider connections independent QA evidence

Status: partial verification in progress for `provider-model-connections`. This report distinguishes completed fixture evidence from browser and live acceptance still pending. The acceptance source is `openspec/changes/provider-model-connections/specs/provider-model-connections/spec.md`.

## Evidence boundary

Use deterministic fixtures for unit and integration contracts, and label them as fixture evidence. A fixture must never mark a connection live verified. Run provider selection and credential isolation through the browser in headed, video-recorded E2E. Run the real connected Codex acceptance only with the user's already-connected Codex CLI; record the selected model and effort, valid committed revision, rendered result, and video. Do not run headless browser acceptance or paid live provider APIs. A failed real request is a failed/blocked acceptance attempt, not fixture evidence and not a reason to silently switch providers.

## Test layers and ownership

| Layer | Evidence to collect | Boundaries |
| --- | --- | --- |
| Unit | Source/auth pair allowlist; capability catalog lookups; verified/unverified state transitions; model/effort preflight; secret redaction; adapter transport selection; safe provider error classification; typed response parsing | Direct imports of the code under test. Fixtures only. |
| Integration | Connection create/rename/credential rotation/removal across metadata and secret-store boundary; provider invocation spy and no-call preflight failures; immutable run selection snapshot; quota/auth/transport outcomes; atomic operation validation and unchanged revision on failure | Isolated temp data root and fake secret store/provider transports. No real provider network. |
| Component | Explicit connection/model/effort controls; stale or unsupported values shown as actionable errors; no secret values in rendered DOM or browser persistence; selection retained for current run/history | Vue tests remain UI contract evidence, not provider verification. |
| Headed recorded E2E | Create/test/manage a fixture connection; select provider/connection/model/effort; reject unsupported selection; surface quota and auth failures; inspect run history; inspect local/session storage, API responses and downloads for sentinel secrets | Playwright headed with video. Fixture server only. Do not use live paid APIs here. |
| Real connected acceptance | A real Codex CLI call with the explicit selected model and effort commits valid typed operations; browser renders the resulting design; record run metadata and headed video | Must identify the connected account path and selected model/effort. Process exit alone is not success. |
| Mutation testing | Kill each critical mutant below with an identified test; report baseline, killed, survived, and compile-error mutants separately, with survivor explanations | Target provider domain, backend application/routing, secret-store boundary, provider adapters, run serialization and relevant UI selection code. Do not mutate unrelated canvas/export code. |

## Critical behavior mutants

These are deliberate source-level behavior changes. Each must be killed by a test whose assertion observes the externally relevant outcome; merely executing the line or checking a generic error is insufficient.

| Area | Representative mutant | Required killing evidence |
| --- | --- | --- |
| Provider/source allowlist | Accept a disallowed provider/auth-source pair, or normalize it into an allowed pair | Connection creation rejects before secret-store write; metadata and secret store remain unchanged. |
| Model/effort preflight | Skip the supported-effort membership check, or accept a model absent from the selected connection's verified capability snapshot | No adapter invocation, no run launch/paid request, stable field-specific error, and document revision unchanged. Include both unsupported effort and stale/unverified model cases. |
| Connection isolation | Resolve credentials by provider or a shared key instead of the selected connection ID | Two same-provider connections with distinct sentinel credentials; selecting A must only invoke A's adapter auth context, and removing/rotating A must never fall through to B. |
| Manual routing / paid fallback | On auth, quota, timeout, or transport error, invoke another connection/provider/tier | Spy on every configured adapter/transport; only the explicitly selected adapter is called once, and all others remain at zero calls. No automatic retry. |
| Secret leakage / strict shape | Include credential or secret-store key in a DTO, run snapshot, diagnostic, log argument, export, browser storage write, or unknown run-metadata field | Seed distinct sentinel secret and key; assert absence from API/DOM/storage/run record/log capture/diagnostics/export, and reject unknown provider metadata fields. |
| In-flight selection race | Read mutable current UI selection after request start, or allow a later selection change to overwrite the in-flight run's route | Start with selection A, pause its request, switch UI selection to B, then assert the request and immutable run snapshot remain A and B is not called. |
| Wrong transport | Dispatch a connection using another provider's transport/client or auth mechanism | Per-provider adapter contract asserts the selected provider's transport and auth input; other transports receive zero calls. Exercise Codex account/API, Claude subscription/API, MiniMax key/token variants where implemented. |
| Unknown quota/status | Map an unknown provider error/status to quota exhausted (or map quota to generic success/retry) | Unknown status remains safe `unknown/provider-error`; explicit quota remains quota, failed with no retry/fallback. Assert safe diagnostics contain no raw response body or secrets. |
| Credential rotation/removal | Keep using a prior secret after rotation/removal, or persist new metadata while secret replacement fails | Old connection cannot route with old secret; failed rotation/removal leaves no partially usable connection and safe metadata state. Removal/rotation cleanup failure is reviewed as an orphaned-secret risk. |
| Pinned cancellation | Cancel through the mutable default/legacy agent instead of the adapter resolved for this run | Assert only the run-pinned provider adapter receives cancellation, run ends CANCELLED before commit, and document revision/content stay unchanged. |
| Atomic proposal boundary | Treat HTTP/CLI success as generation success or commit valid prefix before rejecting invalid proposal | Malformed, out-of-scope, over-capability, stale-revision, and empty proposals yield no partial mutation; transport success alone never records committed design success. |

## Mutation method

The implemented harness uses deterministic, named semantic source mutants instead of adding a Stryker dependency. `tooling/provider-mutation/run.mjs` first runs the provider QA baseline, then creates a disposable project copy and applies one exact source patch per mutant. Each case runs its named Vitest test, records the expected failed assertion, verifies the patch was applied, and fails the harness for a survivor, an unapplied patch, or unexpected output. The disposable copy excludes user state and secrets and is removed after the run. These are mutations to production decision logic, not data or design-operation mutations.

## Acceptance report

Record exact commit/worktree, Node/npm/Vitest/Stryker versions, baseline test result, mutation command/config, mutated file scope, killed/survived/no-coverage/compile-error counts, and the named test that killed each critical mutant. Explain every survivor, including equivalent or unreachable mutants, with evidence. Separately record fixture E2E video and the real connected Codex headed run/video; do not merge their claims. Preserve blocked or unavailable live acceptance as an explicit gap.

### Initial domain mutation run — 2026-10-08

The independent QA slice is implemented in `tests/provider-qa/unit/`, `tests/provider-qa/integration/`, `tests/provider-qa/fixtures/`, and `tooling/provider-mutation/`. The run used `node tooling/provider-mutation/run.mjs`, which copied the workspace to a disposable OS temp directory, excluded `.codex`, `.codex-design`, `.env*`, and installed dependencies, then applied one exact source patch at a time. The clean baseline passed all 26 provider QA unit and integration tests. Eleven source mutants were each killed by their named assertion: cross-pair authentication accepted, unsupported effort accepted, secret-bearing run metadata accepted, mismatched provider/source metadata accepted, same-provider secret crossed between connections, a model verification reused for the wrong effort, credential rotation retained prior verification, quota mapped to generic transport, Codex routed through the Claude adapter, provider failure falling back to the legacy agent, and provider route metadata omitted from the run record. No survivors in this slice. The JSON report is retained under ignored `.codex-design/provider-mutation/` on the run host.

This was an initial 11-mutant run; a later final run below adds strict unknown-field and pinned-cancellation mutants.

### Headed fixture E2E — passed

`tests/e2e/provider-connections.spec.ts` is configured to record video and uses the test server's injected local provider fixture. It exercises actual local routes through the browser, verifies connection creation and verification, pins the selected route to a committed run, exports, and checks that the credential sentinel is absent from API responses, DOM, and browser storage. The rebuilt application passed `npm run build`; the headed test passed with the provider menu collapsed before generation. Its latest video is retained at `.codex-design/provider-e2e/provider-connections-popover-headed-2026-10-08.webm`. Earlier recordings, including the failed popover-interception attempt, are separately preserved in the same directory.

The combined targeted unit/integration run, including `tests/integration/provider-routes.test.ts`, passed 28 tests across four files. The 11-mutant harness was rerun against the stable source: baseline 26/26 passed, and all 11 named mutants were killed; there were no survivors. Detailed output, including each mutant's named failing assertion, is retained in `.codex-design/provider-mutation/mutation-report-2026-10-08T14-17-59.119Z.json`.

### Real connected Codex acceptance — completed by root

Root reports a successful real connected Codex acceptance using model GPT-6.1 Sol at low effort (run `8db158dc-f187-412c-998d-30b093136058`). This is separate from fixture evidence; root is finalizing its headed recording, exports, and reload evidence.

### Final targeted fixture and mutation run — 2026-10-08

The latest independent provider QA run passed 40 tests across five files (provider unit/integration plus route integration). The mutation harness `node tooling/provider-mutation/run.mjs` passed its 38-test baseline and killed all 21 source mutants, with no survivors, no unapplied patches, and no compile-error mutants. Mutants cover provider/source compatibility, unsupported effort, selected-connection-only credentials, metadata redaction and strictness, quota mapping, exact provider transport, fallback prevention, run pinning/cancellation, verification invalidation and timeout classification, source uniqueness, durable credential cleanup staging/retry, v1 migration, Claude instruction isolation, and adapter timeout classification. Full named test failures are recorded in `.codex-design/provider-mutation/mutation-report-2026-10-08T16-30-46.735Z.json`.

After `npm run build` passed, the headed fixture E2E passed (1 test, 8.7 seconds). The latest recording is `.codex-design/provider-e2e/provider-connections-final-2026-10-08.webm`; prior recordings remain preserved.

### Runtime risk review — 2026-10-08

- **Claude subscription instruction/config scope — addressed:** the adapter now uses a temporary working directory and Claude's `--safe-mode`/`--restricted` flags, disables tools and disallows MCP tools. The fixture asserts these flags and confirms the repository working directory is not used. This test does not execute a Claude CLI or account. Managed policy may still apply according to Claude's CLI behavior ([CLI usage](https://code.claude.com/docs/en/cli-usage)).
- **Claude subscription account identity — addressed in the service contract:** one local-account connection is allowed per provider/source, while multiple credential-bearing API-key connections remain supported. Subscription authentication still resolves through the installed local account; connection labels do not create separate machine identities.
- **Verification timeout classification — addressed:** a service deadline is persisted and reported as timeout; caller cancellation remains distinct, and an adapter cancellation without a deadline is treated as transport failure. Independent regression and source mutant cover these cases.
- **Secret persistence/removal — cleanup tracking addressed; plaintext remains:** secret files are owner-only mode `0700`/`0600`, but credential bytes remain plaintext at rest (also recorded in the development journal). Metadata v2 stages secret references and durably queues deletion before removing old credentials; failed deletions are exposed as pending and retried after reopen. API-key backend encryption remains a separate hardening opportunity.

The Anthropic CLI reference documents the `--tools`/print-mode flags, and its memory guide says project and user memory files load automatically: [CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage), [memory guide](https://docs.anthropic.com/en/docs/claude-code/memory).

### Corrective runtime regressions — 2026-10-09

Added `tests/provider-qa/integration/adapter-corrections.test.ts` for the latest independent runtime corrections. Its cancellation fixture waits for a bounded readiness file written by a grandchild after it installs a SIGTERM handler, then aborts the parent CLI and proves the grandchild cannot write its delayed survival marker. The Claude cases exercise typed error envelopes for authentication, billing/quota, rate limiting, and execution-limit outcomes; they assert stable safe codes and verify provider prose and an API-key sentinel do not appear in thrown errors, diagnostics, or run status. These tests use local fixture processes only and do not make live provider calls.

The two successful legacy Claude fixtures in `tests/provider-qa/integration/adapter-failures.test.ts` now emit the documented typed result envelope (`type: result`, `subtype: success`, `is_error: false`, object `structured_output`) required by strict envelope validation. Malformed-output checks remain unchanged. The two adapter test files passed 11 tests, and `npm run typecheck` passed.

The targeted mutation command `node tooling/provider-mutation/run.mjs` passed its 43-test baseline and killed all 23 named source mutants, with no survivors or unapplied patches. This includes the process-group mutant that disables SIGKILL escalation and the Claude authentication mutant that maps a typed authentication failure to generic CLI failure. Full named failures and source-patch status are retained in `.codex-design/provider-mutation/mutation-report-2026-10-09T22-11-29.623Z.json`. This is fixture evidence only; the existing real Codex acceptance remains the evidence recorded above, and Claude/MiniMax remain live-unverified without credentials.

## References

- [Stryker Vitest runner documentation](https://stryker-mutator.io/docs/stryker-js/vitest-runner/)
- [Stryker Vue guide](https://stryker-mutator.io/docs/stryker-js/guides/vuejs/)
- [Stryker troubleshooting: Vitest related-test discovery](https://stryker-mutator.io/docs/stryker-js/troubleshooting/)
- [Stryker Vitest runner package on npm](https://www.npmjs.com/package/%40stryker-mutator/vitest-runner)

## Real Codex acceptance artifacts

The coordinator completed the real ChatGPT-authenticated Codex workflow on 2026-10-08. Run `8db158dc-f187-412c-998d-30b093136058` selected `gpt-6.1-sol` / `low` through `codex-local`, committed revision 1 with four nodes, and reached SUCCEEDED after render acknowledgement and QA. Native/Vue downloads and unchanged document reload passed; the generated screenshot was visually reviewed. This small-card acceptance does not establish complex UI quality or live Claude/MiniMax access.

Artifacts: `.codex-design/provider-live/1791469322/live-acceptance.json`, `complete-process.webm`, `generated.png`, `reloaded.png`, `design.codex.json`, and `codex-design-vue.zip`. The acceptance server was stopped after video finalization.
