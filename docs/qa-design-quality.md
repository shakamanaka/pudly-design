# Design composition quality QA

This QA scope verifies the objective pre-commit completeness checks and their single same-adapter repair path. It does not certify visual taste, prove that a provider can produce a successful result, or replace the change's required headed desktop/mobile review.

The unit fixtures cover a composed store page with a full-width root, four named structural containers, varied copy styles and a native vector; fixed/fill vector axes at 375px and 1440px; rejection when either vector axis resolves to hug, including a desktop override; a vector hidden at the viewport where it has hug sizing; component and scoped-edit exemptions; supported literal and color-token contrast, normal and large-text thresholds, own/ancestor/default backgrounds, visibility and inconclusive translucent colors; long hug text in a tablet row, fill-width text, desktop-only rows, two fill columns at tablet and the preserved mobile stack guard; a tiny text-only skeleton; an explicit minimal component; a selected-subtree edit; explicit text-only page intent; hidden content; a reversed tablet breakpoint that leaves horizontal columns at mobile width; a mobile-first vertical base with a wider-screen horizontal override; the design-generation timeout policy for full pages, components, edits and explicit adapter deadlines; and Claude NDJSON result validation. Claude stream fixtures accept only one final successful structured result after any metadata/partial tool stream, and reject malformed or primitive lines, absent/duplicate/following results, typed failure events, and oversized output. The ProjectService integration fixtures prove that an incomplete puppy-shop draft is not committed, a complete replacement is the only batch written to history, a second incomplete proposal fails without document/history mutation, a stale repair keeps the intervening user edit, and cancellation during repair leaves the draft uncommitted. Fixture agent outputs are local and make no provider or paid inference request.

The structural signals are proxies. Container counts do not establish semantic roles, text/style counts do not establish readability, and a vector node proves authored path data rather than visual quality. Current image and icon canvas nodes render placeholders. Browser overflow, responsive legibility, export fidelity and reload behavior require the separate real headed acceptance evidence described by the OpenSpec change.

## Verification

- `npm exec vitest -- run tests/quality-qa`: 45 tests passed across composition, page legibility, retry, timeout and Claude stream coverage.
- `npm exec vitest -- run tests/provider-qa/integration/adapter-failures.test.ts`: 6 Claude and MiniMax fixture tests passed, including explicit timeout and cancellation behavior, without contacting a provider.
- `npm run typecheck`: passed, including app, server and test projects.
- `node tooling/design-quality-mutation/run.mjs`: passed; all thirteen source mutants were killed, including removal of the vector-bounds, text-contrast and tablet-layout reviews.
- Mutation report: `.codex-design/design-quality-mutation/mutation-report-2026-10-14T02-47-20.858Z.json`.

The mutation manifest exercises page-width, section-container, meaningful-copy, typography, native-vector, mobile-layout, vector-bound review, text-contrast review, tablet-layout review, default full-page timeout, explicit timeout preservation, retry acceptance and duplicate Claude final-result rejection. It contains only thirteen focused quality mutants; it does not invoke the unrelated provider mutation suite. The runner copies the checkout to a disposable temporary directory, applies one exact source edit at a time, records the baseline and mutant outcomes, and removes each temporary checkout after completion.

## Independent visual review — Luna/medium retest

I independently reviewed the full-page projections for real run `ea51b5dd-99e3-4ee6-8c78-76f742e85d94` in `.codex-design/quality-acceptance/1791946151675/`: `desktop-full.png` at 1440px, `tablet-full.png` at 768px and `mobile-full.png` at 375px. The brief rubric scores each dimension 0–2; no viewport has a zero.

| Dimension | Desktop | Tablet | Mobile | Evidence |
| --- | ---: | ---: | ---: | --- |
| Readability | 2 | 1 | 2 | Desktop and mobile have clear type hierarchy and readable contrast. At tablet, the hero headline breaks into three short lines and catalog copy wraps tightly, though all text remains legible. |
| Responsive hierarchy | 2 | 1 | 2 | Desktop composition is balanced and mobile stacks the hero, art and cards cleanly. Tablet fits its two-column hero and catalog, but feels cramped; card copy has uneven visual weight and CTA alignment. |
| Domain relevance | 1 | 1 | 1 | The puppy-care brand and breed/age details fit the prompt, but “Meet the pups” and two puppy cards read more like adoption than a developed store; product, availability and price details are absent. |
| Imagery | 1 | 1 | 1 | The editable puppy-head illustration is relevant and coherent with the palette, but simple and generic, with no distinct supporting product imagery. |
| Visual distinctiveness | 1 | 1 | 1 | Cream, orange, sage and dark brown form a consistent identity, while the layout and illustration remain conventional. |

This is a usable visual baseline, not a strong design. There are no critical readability, overflow, action-visibility or section-order problems in these projections. The tablet density, generic illustration and thin retail details remain clear quality limitations. In the final evidence for this real 40-node run, `mobileOverflow` is empty, `reloadIdentical` is true, and both `nativeExport` and `vueExport` report `succeeded`. This subagent review covers the three saved screenshots only.
