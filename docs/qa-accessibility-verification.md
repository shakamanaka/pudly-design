# Canvas accessible-name verification

## Scope

This verification targets the canvas-selection control behavior specified by `canvas-selection-inspector` in the active `design-engine-foundation` change. It checks the accessible name and description exposed by Chromium through Playwright, the empty-text fallback, selection by Enter and Space, stable node identity, and whether inspector text edits remain reflected after a reload.

This is a focused Chromium browser check. It does not establish screen-reader compatibility, WCAG conformance, focus-indicator contrast compliance, or accessibility certification.

## Evidence

- Codebase discovery first: DeusData semantic retrieval for canvas accessible names surfaced `CanvasNode.vue`; the actual implementation was then inspected directly.
- Source behavior observed: nonblank text uses the text content as `aria-label`; the layer name is exposed as `aria-description`. Blank text uses the `text: <layer name>` fallback and omits the supplementary description. The button continues to carry the stable document node ID in `data-node-id` and selection state in `aria-pressed`.
- Browser regression: `tests/e2e/canvas-accessibility.spec.ts` exercises these behaviors against the isolated Playwright service, checks Playwright's Chromium accessibility snapshot for the text button name, and includes a reload after a committed text edit.
- Execution: `npx playwright test tests/e2e/canvas-accessibility.spec.ts` passed against the coordinator-confirmed fresh production bundle served by the isolated harness on port 5174 (1 test passed). Playwright's Chromium accessibility snapshot reported the text control as `button "Welcome"`; role-based assertions confirmed its description, blank-text fallback, and updated accessible name. Enter and Space selected the same stable text node ID while leaving the parent frame unselected. The inspector edit remained present with the same name/description after a full page reload.

## Result

The specified browser regression passed for the current build. This result covers the targeted canvas control behavior only; it does not establish screen-reader compatibility, WCAG conformance, focus-indicator contrast compliance, or accessibility certification.
