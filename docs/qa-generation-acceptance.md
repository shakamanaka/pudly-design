# Generation acceptance gate

## Scope and baseline

This independent review covers recovery from the 2026-10-05 visible-generation failures and evidence needed to accept three designs: Meridian Analytics dashboard, Sugar & Crumb cake landing page, and NIGHTFALL shooter login. It does not expand the advertised operation family or certify general generation quality.

Primary discovery used the configured Codebase MCP (`tooling/codebase/launch.sh cli index_status` and semantic search for the Codex adapter protocol). The index was ready at 1,359 nodes / 4,076 edges, rooted at this repository. Its only parser-partial ranges were known `vi.hoisted` expressions in two unrelated integration tests. Semantic results ranked the Codex adapter and tests; source was then read directly. The failure baseline is `.codex-design/dogfood/2026-10-05-visible-designs-1791223995730/failure-review.md` plus the preserved browser scripts and run records.

The baseline is concrete: a 120-second deadline failed six earlier requests; bounded 300-second attempts later committed a partial dashboard in 168.967 seconds and a cake hero in 131.437 seconds; a cake operation with top-level `position` was rejected; a generic banner hid the adapter's timeout; the shooter script used the wrong textbox label; dashboard terminal polling omitted Cancelled; and browser teardown produced closed-page waits. These observations motivate narrow fixes. They do not prove that a longer timeout guarantees completion.

## Independent acceptance conditions

Three separate live Codex runs must each produce a design in its own isolated project and recorded browser session. For each design, retain the exact prompt, run ID, configured timeout, wall duration, terminal run record, base/committed revision, diagnostics, semantic document JSON, screenshot, and finalized video. A fixture, mocked provider response, successful CLI exit, partial commit, or screenshot without a matching semantic document is insufficient evidence.

Each accepted initial generation must advance its own project from revision 0 to revision 1, contain a non-empty semantically valid document, render that committed revision in the visible canvas, and finish the configured run QA in `SUCCEEDED`. The run's QA record must identify the same committed revision and include no blocking operation or design-system diagnostics. Preserve partial revisions and their evidence when a later run fails; do not label the whole design complete from an intermediate stage.

The artifact must visibly and semantically include the core content from its prompt:

- Meridian: branded header/navigation and date range; greeting and supporting sentence; at least three meaningful metric cards; a chart or trend; and recent activity. A hero/header shell alone is partial.
- Sugar & Crumb: brand/navigation, a complete landing hero with CTA and cake illustration; three product cards with prices; and an order/contact footer. The saved hero-only revision is partial.
- NIGHTFALL: distinct game branding and atmosphere, legible visual username and password fields, sign-in, forgot-password, and sign-up controls. This proves a visual mockup, not backend authentication. A blank revision is failure.

For each artifact, compare visible screenshot and document text/geometry so all required elements are present, legible, inside the intended composition, and not merely hidden in the document. Inspect hierarchy, contrast, spacing, and clipping at the recorded viewport; include an independent human visual review. The user also requires a selected AI edit or meaningful inspector edit, reload proving persistence, a named snapshot, and native and Vue exports downloaded through the visible UI for each design. Read-only API inspection may verify revision, nodes, and run records, but must not seed or mutate the design. These criteria prove the three named outcomes only; they are not a general visual-design certification.

## Protocol and failure boundaries

The constrained provider response schema must constrain each operation as a typed JSON object (including its `type`-specific required fields and forbidden extras), rather than hiding unbounded operation strings inside an array. Since the Codex CLI accepts a restricted JSON Schema subset, verify the exact emitted schema against that subset and keep application-side structural parsing authoritative. Tests must show malformed JSON, unsupported types, missing/extra fields, invalid nested node shapes, and oversized arrays reject before operations reach the transaction service. A valid wire proposal still goes through existing `parseBatch`, scope authorization, final graph validation and atomic commit; schema validity is not semantic validity.

Provider fixtures can establish schema construction, parser rejection, process argument/data-channel handling, timeout and cancellation mechanics. They cannot establish provider compliance with the schema, useful design quality, render completion, or user-facing behavior. Only live recorded runs can pass the three-design acceptance gate.

Timeouts remain finite and bounded, with a practical default appropriate to the observed 131–169 second cases. Timeout/exit/protocol failures must persist a stable allowlisted diagnostic code and specific actionable message in the run record and visible UI. Do not copy raw stderr, prompts, environment values, or other credentials into diagnostics. A timeout, malformed response, empty operation list, rejected transaction, and render/QA failure are distinct outcomes. Every rejection leaves the pre-run revision intact; if commit already happened, later failure must identify and preserve the committed revision.

Cancellation before commit must settle promptly as `CANCELLED`, terminate the owned process (including descendants where supported), and leave the document unchanged. Cancellation after commit must preserve the revision and continue render/QA or report their failure, never claim rollback. Test cancellation at queued, active-process, validating, applying, and post-commit/render boundaries where controllable; assert terminal state, persisted record, process exit, and revision/content together to catch races.

## Recorded browser lifecycle

The next recorder should use the visible textbox role/name from the app (`Describe a design or edit`) and derive its wait budget from the configured server timeout plus a small bounded UI-settlement margin. Poll a single observed run ID and enumerate all terminal states (`SUCCEEDED`, `FAILED`, `CANCELLED`, `ROLLED_BACK`) instead of racing selector waits that can mislabel a state as timeout. A page closure is a recorder failure with its own timestamp and last known run ID; it must not be converted into a generation timeout or trigger an unrecorded retry.

Give every attempt a unique artifact directory and log append-only timestamped actions and outcomes. In a `finally` path, take a last screenshot only when the page is open, close the page/context once, then await video finalization for that page and verify a non-empty file. Do not rename the first arbitrary WebM in a shared directory; map a recording explicitly to its attempt. Persist a machine-readable manifest even when setup, generation, or teardown fails. Record retries only after a terminal failure has been captured and diagnosed, and cap attempts. Do not close/relaunch a browser context while an operation still owns its page; if interrupted, retain all partial logs and artifacts.

## Evidence still required

This audit is a gate definition and a review of the prior failures. It does not claim that the three new live runs, screenshots, QA outcomes, follow-up edits, reloads, snapshots, or exports pass. The root coordinator owns the visible runner and run evidence. Before accepting all three, inspect one evidence manifest per design and verify the linked source records, rendered screenshot, video finalization, terminal `SUCCEEDED` state, matching revision, required visible content and no unreported failure. The default production timeout and settings must pass; a special timeout workaround is not acceptance evidence. No image/icon/vector capability expansion or other new feature is claimed.
