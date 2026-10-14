# Accessibility audit: canvas selection controls

The audit was limited to canvas-node semantics, keyboard selection, and focus indication. I used the Codebase index first; semantic retrieval ranked unrelated entities, while literal search identified `CanvasNode.vue`. I verified the current implementation directly in that source and in the production bundle served from an isolated Vite preview at `127.0.0.1:5187`. The seeded document contained a frame named “Hero section” and a text node named “Heading layer” whose visible content was “Visible heading content”.

## Finding: text-node button name omits its visible text

**Evidence:** Chromium’s accessibility tree exposed the text node as a non-ignored `button` named `text: Heading layer`. The rendered text was `Visible heading content`. A `StaticText` node with that visible text also existed in the full Chromium accessibility tree, so this audit does not claim that the text subtree is wholly absent. The focused control’s accessible name still fails to contain its visible label, creating a label/name mismatch for the canvas selection button.

**Impact:** When a user navigates the text layer as a button, its control name identifies layer metadata rather than the text displayed on the canvas. A user who relies on the button name cannot match the focused control to its visible text from the control name alone.

**Suggested correction:** Include the text node’s current text in its accessible name, or use that text as the button name and expose the layer name and kind as supplementary description. Keep the stable node ID as the selection value.

**Regression check:** `tests/audit/accessibility-canvas.spec.ts` records this known failure with `it.fails`, so the suite passes while the mismatch remains and reports an unexpected pass once the name includes the visible content.

## Keyboard and nested-control observations

In the same Chromium probe, the frame and its child were both retained as non-ignored `button` nodes in the AX tree. The outer button’s AX child was the inner button. Tab moved from the frame to the text node; `:focus-visible` matched on the focused node. Pressing Enter set the child’s `aria-pressed` to `true` while the parent remained `false`. These observations did not reproduce a keyboard selection or focus-navigation failure.

The observed computed focus outline was 2 px solid `rgb(32, 36, 43)`. This probe did not produce a screenshot-based contrast measurement or test across themes, operating systems, browser versions, or screen readers, so it does not establish focus-indicator contrast compliance. The nested button structure remains a reason to test with assistive technologies, but this audit does not treat nesting alone as a reproduced defect: Chromium exposed both controls.

This is a focused Chromium audit, not a screen-reader test, automated WCAG evaluation, or accessibility certification.

## Resolution on resume

The reported name mismatch is corrected. The audit regression is now a normal passing test; blank-text naming and stable keyboard IDs have additional coverage. Independent production Chromium verification is recorded in docs/qa-accessibility-verification.md. The historical it.fails description above refers to the pre-fix checkpoint.
