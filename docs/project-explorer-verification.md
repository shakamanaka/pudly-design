# Project explorer verification — 2026-10-13

The Projects menu exposes real saved first-page previews, grid/list preferences, named creation, history-preserving open, confirmed recoverable removal, and bounded responsive scrolling. Previews invoke no model. The library is ordered by last save, not last view or invocation.

Independent scenario mapping: [qa-project-explorer.md](qa-project-explorer.md). Seven independent integration cases and three headed recorded browser cases passed; all six scoped library mutants were killed. Combined regression with provider browser tests passed five cases in `.codex-design/project-explorer-e2e/2026-10-13-verified/`; responsive preview fitting was then separately rerun with all three explorer cases passing in `.codex-design/project-explorer-e2e/2026-10-13-preview-fit/`.

## Actual saved library acceptance

The final headed run against existing saved data is `.codex-design/project-explorer-acceptance/1791926128975/`. It discovered18projects, opened a historical populated envelope with exact document/history equality, created a specifically named temporary project, verified reload selection, cancelled removal without deletion, confirmed active removal into trash, verified a null current selection after reload, and restored the original active project. All18original saved-envelope files remained byte-identical. At375×812 the dialog was x8/y8/359×796 and its content scrolled; Escape restored focus. Root reviewed `grid.png`, `list.png`, `mobile.png` and the older-creation `legacy-grid.png` preview. `complete-process.webm` records the flow. The earlier7-project acceptance is also retained.

## Earlier real-run store adoption

Ten validated envelopes were copied from known earlier real-run saved stores under `.codex-design/dogfood/*/project-storage` and `.codex-design/live-projects` into the canonical library. All source files remain untouched, canonical files are private0600, original save timestamps and complete document/history were preserved, and existing IDs were never overwritten. `legacy-import.json` records paths, IDs and source checksums. No fixture stores, provider credentials, generated duplicate checkpoints or raw provider logs were imported. Some historical projects retain their original generic `New design` name; their real previews distinguish them.

The feature adds no cloud sync, arbitrary-folder import UI or trash restore UI. Removed envelopes remain recoverable in the local `.trash` directory. Failed generation projects remain inspectable in the library as empty saved projects.

Finalcombinedgate afterallqualitycorrections:376tests61files/lint/typecheck/buildpassed. Allfive headedproject/providerbrowserregressionspassed in .codex-design/project-explorer-e2e/2026-10-13-legibility-final/. Project-explorer OpenSpec tasks arecomplete andthechange remainsunarchived.
