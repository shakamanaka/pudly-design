# Project explorer independent QA

This record maps the `project-explorer` OpenSpec scenarios to independent evidence. The browser suite uses the isolated temporary store configured by `playwright.config.ts`; it creates fixture projects through the local API and never opens or mutates a user's normal project store. No model inference is used.

## Scenario traceability

| OpenSpec scenario | Evidence |
| --- | --- |
| Existing projects and saved first-page preview | `tests/e2e/project-explorer.spec.ts`: grid preview is rendered from persisted semantic nodes; `tests/project-library-qa/integration/project-library.test.ts`: preview bytes and current selection remain unchanged. |
| Empty or damaged project isolation | `tests/project-library-qa/integration/project-library.test.ts`: damaged historical JSON is reported unavailable while healthy entries remain discoverable and previewable. |
| Create and return with history preserved | `tests/e2e/project-explorer.spec.ts`: create by name, open a historical design, assert its saved document/history, then reload the new project. `tests/project-library-qa/integration/project-library.test.ts`: reopen preserves the entire envelope and current pointer after service restart. |
| Remove inactive project | Browser confirmation and active-selection assertion; integration confirms removal from discovery and envelope retention in `.trash`. |
| Remove active project | Browser flow asserts `/api/project` returns null and remains null after reload; integration verifies current-pointer clearing and recoverable trash contents. |
| Canceled removal and storage failure | Browser cancellation keeps the card and current selection; browser API failure response is shown as an actionable alert with the project still selected; integration injects a real persistence failure and checks in-memory and persisted selection remain unchanged. |
| Active generation blocks lifecycle changes | Integration holds a real service run nonterminal and checks create, open, and remove reject with `run.busy` while run/project state stays unchanged. |
| Unsafe IDs and symlink entries | Integration rejects traversal-shaped IDs and a symlink project entry, checks it is excluded from discovery, and compares outside-target bytes. |
| Keyboard and narrow viewport access | Headed browser test checks initial focus, focus cycling, Escape return focus, narrow dialog bounds, and scrollable library content. |

## Discovery notes

The configured Codebase MCP returned relevant `ProjectService`, `LocalDesignPersistence`, router and local API symbols for project-library queries. The result was checked against current source. The index was not refreshed by this QA assignment because implementation owners were still making substantial production edits; the coordinator should refresh the index after integration.

## Verification record

The final focused typecheck passed. All 7 service/persistence tests passed, and all 3 headed Chromium tests passed with video recording enabled. Videos are in `test-results/project-explorer-grid-and--389d8-d-creating-durable-projects/video.webm`, `test-results/project-explorer-canceled--4725c-rrow-dialog-content-scrolls/video.webm`, and `test-results/project-explorer-a-trash-s-95acd-he-user-an-actionable-error/video.webm`.

The source mutation baseline passed and all 6 named mutants were killed: preview returning history, damaged-entry discovery isolation, symlink following, stale active pointer after deletion, and active-run gating for open/remove. The report is `.codex-design/project-explorer-mutation/mutation-report-2026-10-13T21-02-55.069Z.json`; the runner and exact patches are in `tooling/project-explorer-mutation/`.
