# Component canvas QA

Canvas instances now expand their resolved component definition and selected variant. Template render IDs are derived from the instance ID plus template-node ID and exist only in the renderer DOM; selection of template content maps to the persisted instance ID. Slot children render at their declared template anchor as ordinary document nodes, so selecting one still returns its own stable node ID.

Template nodes use the same semantic styling and responsive layout resolution as document nodes. Free-layout parents render as relative blocks, their children use absolute edge/center anchors, and auto-layout fill uses flex growth on the parent's main axis. Token colors, typography, shadows and alpha values flow through the existing style resolver.

`tests/ui/component-renderer.spec.ts` covers Button variants and property binding, a Card with nested text and anchored content, responsive template layout, instance and slot selection, main-axis fill styles, and free-layout anchors. Existing renderer and typography specs also pass. A headless Chromium check using styles produced by `nodeStyle` measured two row-fill children at 195 px each inside a 400 px parent with a 10 px gap.

Focused Vitest: 6 tests pass across the new component, renderer, and typography specs. The current production build and targeted ESLint pass. The browser check covers fixed-size Button/Card roots and hug-sized Button roots; vertical main-axis fill remains covered by renderer tests rather than a browser geometry check.

## Independent browser and architecture audit

`tests/e2e/component-canvas-a11y.spec.ts` seeds default Button and Card definitions and runs against the production bundle through the isolated E2E server. After the canvas wrapper/root sizing fix, the browser check passes for fixed-size Button/Card instances and a hug-sized Button. It checks that rendered template roots match their selectable instance bounds, that no wrapper padding duplicates the Button's 16 px design padding, and that a desktop breakpoint gap override returns to its base gap in mobile preview. Enter selects the instance and exposes its selected state with `aria-pressed`.

The prior accessibility audit found `aria-selected` on `role="button"`, an unsupported role/state combination. Canvas selection now uses `aria-pressed`, which is supported for a button; the production browser test verifies the selected state. Layer rows continue to use `aria-selected` with `role="treeitem"`.

The domain import-boundary scan found no Vue, DOM, filesystem, process, or MCP imports under `src/domain`; the UI renderer imports domain types and pure domain helpers, consistent with the architecture contract. Rebuild `dist` before static-bundle verification so it includes the current renderer.
