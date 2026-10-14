# Codex model catalog QA

## Independent fixture coverage

`tests/provider-qa/integration/model-catalog.test.ts` exercises the read-only catalog collector and provider service through injected model/list pages. It covers multi-page collection, `includeHidden`, hidden model metadata, exact per-model effort ordering, duplicate IDs, repeated cursors, the page bound, malformed/failed page fallback, and the distinction between account discovery and exact model/effort verification. A fake app-server executable checks the bounded timeout, process termination, stdio app-server launch arguments, temporary working directory, and exclusion of ambient API credentials. These tests do not contact a real provider or establish account entitlement.

Run the focused fixtures with:

```sh
npx vitest run tests/provider-qa/integration/model-catalog.test.ts
```

The Codex API-key connection path is asserted to remain `unknown` and empty without invoking local ChatGPT discovery. Dynamic account catalog output does not append the previous static Codex entry. An advertised effort unsupported by the selected model is rejected before verification; discovery alone leaves model availability unknown.

## Mutation coverage

`tooling/provider-mutation/mutants.json` includes source mutants for hidden model requests, cursor-loop detection, duplicate model stability, availability claims, API-key/account catalog isolation, model-specific verification efforts, and accidental static fallback addition. The shared mutation runner verifies its baseline in a disposable copy and applies each source mutant in a separate copy.

The 2026-10-13 mutation run passed its 50-test baseline and killed all 30 configured provider mutants, including all seven catalog-specific mutants. Full report: `.codex-design/provider-mutation/mutation-report-2026-10-13T16-29-26.222Z.json`.

## Live qualification

The fixtures above validate adapter and service contracts only. Real account discovery and headed dropdown/effort behavior require the coordinator's explicitly read-only connected Codex session; no fixture result should be reported as live catalog or generation acceptance evidence.

## Coordinator acceptance — 2026-10-13

The full gate passed 267 tests in 46 files, strict TypeScript, lint and production build. Two headed, recorded provider browser flows passed using isolated fixture port 5292. Recordings, including prior failed attempts, remain under `.codex-design/provider-e2e/2026-10-13-catalog-final-port5292/` and earlier attempt directories.

Real read-only account discovery returned 10 models, including three marked hidden. Headed Playwright compared the visible model dropdown against that actual catalog and checked the exact advertised effort order for Sol 6.1 and Astra. No generation requests were sent. Evidence, screenshot and finalized recording: `.codex-design/catalog-ui/evidence.json`, `models.png`, and `complete-process.webm`. Catalog discovery establishes advertised options, not inference entitlement. Claude login was reported successful by the user; live Claude inference was not tested.

Scenario traceability: multiple pages and failed/malformed discovery map to `tests/adapters/codex-model-catalog.test.ts` and `tests/provider-qa/integration/model-catalog.test.ts`; discovery versus verification and authentication isolation map to the independent integration suite; model switching and refresh preservation map to `tests/ui/provider-connections.spec.ts`, with real dropdown/effort acceptance in the coordinator evidence above. All six scenarios have verification evidence.
