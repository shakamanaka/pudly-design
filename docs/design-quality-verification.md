# Design composition quality verification — 2026-10-13

The simple request `Generate a puppy store design` now receives a shared, scope-aware composition brief, native vector support and precommit structural review with at most one same-provider repair. Structural checks are proxies, not aesthetic certification.

| Scenario | Evidence |
| --- | --- |
| Complete page versus minimal component or scoped edit; bounded deadlines | tests/application/design-brief.test.ts; tests/quality-qa/deadline-policy.test.ts |
| Visible full-width composition, typography, native visuals, mobile-first min-width overrides | tests/quality-qa/composition.test.ts |
| Commit only accepted repair; incomplete second draft, cancellation and stale revision preserve history | tests/quality-qa/composition-retry.test.ts |
| Claude structured final result, malformed/duplicate/trailing data and tool restrictions | tests/quality-qa/claude-stream.test.ts; tests/adapters/provider-runtime.test.ts; tests/adapters/provider-failures.test.ts |
| Independent source mutation evidence | docs/qa-design-quality.md; 45 quality tests and 13/13 killed mutants, latest report .codex-design/design-quality-mutation/mutation-report-2026-10-14T02-47-20.858Z.json |
| Combined regression gate | npm run check: lint, 376 tests in 61 files, strict TypeScript and production build passed |

## Real generation acceptance

Sol 6.1 low run `e4a0ac86-80cb-43ca-b6fa-c9795fa2eff3` produced 38 nodes including four editable native vectors. Root reviewed complete desktop (1440), tablet (768) and mobile (375) rendered projections. All had zero measured horizontal text overflow; mobile footer was reachable. Native export succeeded and reloaded document was identical. Vue export reports partial fidelity.

Evidence directory: `.codex-design/quality-acceptance/1791924029466/`. `evidence.json` retains run selection, events, export/reload evidence; `complete-process.webm` records the headed generation. `desktop-full.png`, `tablet-full.png`, `mobile-full.png`, `final-review.json` and `final-review.webm` record the final projection review. Projection screenshots clone the actual renderer DOM for full-page capture without changing DesignDocument.

Earlier failed visual and timeout attempts remain recorded. Claude full-page JSON output exhausted structured-output retries; a small vector stream diagnostic succeeded, motivating the strict stream transport correction. Full-page Claude generation has not received real acceptance. No automatic provider/model fallback occurred. Figma vector wrapper degradation and Vue partial export remain explicit; this does not add a photograph/asset pipeline.

## Smaller-model acceptance and correction

The original short prompt was held constant. Separate manually pinned Haiku/high and Luna/medium runs were recorded; no error automatically changed model or billing source. Haiku run59eec6c4-cd8a-4907-af63-8b2f1617647f failed (first incomplete draft, then structured-format repair) withoutcommit; no Haiku visual acceptance is claimed. Luna run1b55eadb-30eb-4851-aff1-08e570a30cc0 passed technical checks but failed actual illustration placement. Luna run0c45d6c3-4d2e-45ff-9f07-be4813a9b72f fixed illustration bounds but failed action contrast and tablet horizontal overflow. Bothfailedvisualrecordings remain available.

The resulting shared brief and objective precommit rules now check native vector fixed/fill bounds, known opaque authored-text contrast, and long tablet hug rows. The canvas radius-token bug was corrected separately; actual CSS16pxmatchesradius.lg. Exactregressions: tests/application/vector-page-quality.test.ts, tests/application/page-legibility.test.ts, tests/quality-qa/page-legibility.test.ts and tests/ui/radius-token.spec.ts. Scoped/minimal requests retain their scope. Transparency/unsupported background effects are inconclusive; authored checks do not certify every resolved component or pixelbackground.

Final same-Luna/medium run `ea51b5dd-99e3-4ee6-8c78-76f742e85d94` SUCCEEDED with40nodes/2vectors in71.7seconds. Evidence `.codex-design/quality-acceptance/1791946151675/` contains realselection/events, headedcomplete-process.webm, desktop/tablet/mobilefullprojections andfinal-review.webm/json. Root reviewed allthree widths: zero horizontal text/scroll overflow, contained aligned illustration layers, visible contrasting actions, two meaningful catalog cards andreachablefooter. Native and Vue export reports both succeeded and reloaded documentwasidentical. Capture strips editor hover/selection outlines only; it does not change DesignDocument.

Independent visual review (docs/qa-design-quality.md) rates desktop/tablet/mobile readability2/1/2, responsivehierarchy2/1/2 anddomain/imagery/distinctiveness1/1/1. This is a usable baseline, not evidence of premium quality on every prompt/model. Tabletdensity, genericart andthinretaildetail remain limitations. The earlier Vuepartial/Claudeunproven statements describe their specific runs; the final Luna exportreports succeeded, and Claude fullpageacceptance remains unproven.

Finalcombinedcheck:376tests61files, lint, strictTypeScript andproductionbuildpass. Fiveheaded recordedproject/providerregressionspass under .codex-design/project-explorer-e2e/2026-10-13-legibility-final/. Scopedquality13mutants andlibrary6mutantsallkilled. Noadditionaltestsneededwithoutnewsourcechanges.
