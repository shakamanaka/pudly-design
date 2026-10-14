# Browser QA

Run the end-to-end suite with `npm run test:e2e`. Playwright starts the Vite UI and the actual local HTTP application service on ports 5173 and 5174. The service's working directory is a newly created temporary folder, so its `.codex-design/projects` store is separate from the normal user project data and is removed after the run.

The suite covers creating a blank project, keyboard selection of a semantic canvas node, inspector edits committed through the operation API, undo/redo, named snapshot restore, and reopening from durable service state. It also checks accessible names and keyboard focus for core canvas and prompt controls.

The standard browser journey does not submit a design prompt or exercise Codex generation. It also does not claim automated WCAG conformance or cover failure injection for disk persistence.

To run the separate real-integration gate, set `CODEX_DESIGN_LIVE=1` and run `npx playwright test tests/e2e/live-codex.spec.ts`. This requires an authenticated Codex CLI and may take several minutes. That scenario creates an onboarding card through the UI, waits for the run to reach its rendered success state, checks stable canvas IDs, edits the selected title through the inspector, and reloads the saved project. It is the only browser scenario that exercises prompt-to-design generation; a skipped test is not acceptance evidence.
