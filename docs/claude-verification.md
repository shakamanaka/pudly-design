# Claude session and catalog verification

Change: `claude-session-catalog`. Local account recognition, catalog discovery and exact model/effort inference verification are independent evidence.

## Live acceptance — 2026-10-13

A real read-only account check recognized the existing Claude Pro login with the corrected isolated environment. SDK initialize, without a user prompt, returned 13 model entries rather than three static aliases. The catalog remains partial because some entries omit effort metadata; the UI offers the CLI default without inventing extra supported levels.

Headed Playwright recorded the actual provider UI, compared every visible model identifier with the account catalog and verified selected model effort options. An explicit Haiku verification returned Claude's structured `usage_limit_reached` quota error. The corrected app displayed the quota failure while retaining authenticated session evidence; both states survived reload. This proves session recognition, catalog display and quota recovery messaging, not successful Claude inference. No design generation request or automatic provider fallback occurred.

Evidence: `.codex-design/claude-acceptance/evidence.json`, `catalog.png`, `quota-recognized-session.png`, finalized `complete-process-*.webm`. Earlier failed browser attempts are preserved with separate attempt evidence and recordings. A direct minimal diagnostic received zero input/output tokens and zero cost in the CLI result; raw account fields and credentials were not persisted.

## Scenario traceability

| Scenario | Evidence |
| --- | --- |
| Existing local login | adapter/independent integration env assertions; real session status |
| Missing or failed session check | independent signed-out/malformed/nonzero/timeout fixtures; UI signed-out versus unknown tests |
| More than three aliases | read-only SDK fixtures and real 13-option dropdown comparison |
| Failed discovery | bounded timeout/output/malformed/termination integration cases |
| API-key isolation | independent service connection tests; ambient-key exclusion assertions |
| Verification fails with recognized session | component failure/reload tests and real quota screenshot/reload |
| Model change | existing exact-tuple component tests, advertised-effort tests and live selection |

Independent test/mutation results are recorded in `docs/qa-claude-session-catalog.md`. Final full check passed279tests in48files, lint, strict TypeScript andbuild; bothheaded recorded fixture browserregressions passed. Independent mutationbaseline57passed andall37mutantskilled; see the QA report for exact paths. No archive, release or deployment is implied.
