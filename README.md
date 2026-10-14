# Codex Design

Codex Design is an early-stage, local-first visual design environment. Users describe a page, edit its elements on a canvas, and export the resulting design. The versioned `DesignDocument` is authoritative; the Vue canvas and export files are derived from it.

Generation is bounded to five minutes for ordinary requests and ten minutes for full-page creation by default. Provider connections let users select a verified provider, model, and effort for each run; the app does not silently switch providers or paid tiers. A recorded Luna/medium run establishes a usable baseline for one bounded page-generation workflow. It does not establish a general quality pass rate. Haiku generation has not passed acceptance, so its design quality remains unproven. See [design quality evidence](docs/design-quality-verification.md) for the recorded result and current limits.

## Requirements

- Node.js 22.12+ within 22.x, 24.x, or 26+ (see `package.json` engines)
- npm 10 or newer
- Codex CLI logged in for a local ChatGPT account connection, or credentials for another supported provider
- Playwright Chromium for browser tests (`npx playwright install chromium`)

## Run locally

```sh
npm ci
npm run dev:server
```

In a second terminal, run:

```sh
npm run dev
```

Open <http://127.0.0.1:5173>. Add or verify a provider connection in the editor before generating a design. The connection screen supports Codex CLI with a ChatGPT account or OpenAI API key, Claude Code with a subscription or Anthropic API key, and MiniMax with an API key or token plan. Availability depends on the signed-in account, provider, and selected model. The app validates the selected configuration before a run and does not automatically fall back to another connection.

For a local production build, run `npm run build` and then `npx tsx server/index.ts`; open <http://127.0.0.1:5174>. Projects and run records stay in local storage under the ignored `.codex-design/projects` directory. This trusted local server is not a hosted multi-user service.

Ordinary requests default to five minutes; full-page creation defaults to ten minutes. For the server's base Codex adapter, `CODEX_DESIGN_GENERATION_TIMEOUT_MS` sets a bounded timeout from `30000` through `600000` milliseconds. Invalid values prevent startup. A longer limit does not bypass operation validation or trigger an automatic retry.

## Current capabilities and limits

- Create and edit validated design documents, select canvas elements, use the inspector, and review history, snapshots, and saved projects.
- Generate bounded designs through an explicitly selected, verified provider. A successful provider response alone does not mean a design was accepted; operations must validate, commit, render, and pass the applicable checks.
- Create editable native vector illustrations. Image upload, photo rendering, generated raster images, and stock search are not implemented. Image nodes currently hold asset references without stored image bytes.
- Export the supported semantic document as native data, a runnable Vue/Vite application, or a Figma development-plugin archive. Each export reports preserved, degraded, or omitted features. Vue and Figma exports can be partial. The Figma archive requires a plugin ID assigned by Figma and must be run in a Figma design file; it does not create or sync a Figma file automatically.

Read [image and asset scope](docs/image-strategy-analysis.md) and the [export fidelity contract](openspec/changes/design-engine-foundation/specs/export-architecture/spec.md) before relying on image or export behavior.

## Checks

- `npm run typecheck` — strict Vue, TypeScript, tooling, and test type checks
- `npm run lint` — ESLint checks for TypeScript and Vue
- `npm run test:unit` — domain and adapter tests
- `npm run test:component` — Vue component tests
- `npm run test:integration` — application integration tests
- `npm test` — all Vitest suites
- `npm run test:e2e` — build and run Playwright browser tests with deterministic provider fixtures; the default suite does not call a model account
- `npm run build` — type checks and production Vite build
- `npm run check` — lint, all Vitest suites, and production build

Browser tests use the local service and disposable storage, and record videos. Add `-- --headed` to `npm run test:e2e` to watch the browser. `CODEX_DESIGN_LIVE=1 npm run test:e2e -- tests/e2e/live-codex.spec.ts` disables provider fixtures and uses the verified Codex CLI account for a real verification request and two design requests. Run it only when you intend to use that account. Provider-fixture tests are skipped in live mode. Fixtures verify adapter contracts only; they do not establish live provider availability or design quality. See [generation quality evidence](docs/design-quality-verification.md) for the current recorded acceptance and limitations.

## Architecture

- `src/domain` — framework-neutral document, operations, and validation
- `src/application` — transactions, context, history, and orchestration
- `src/adapters` — local persistence, providers, and exporters
- `src/ui` — Vue renderer, canvas, selection, and inspector
- `server` — trusted local process and filesystem boundary
- `tests` — unit, component, integration, quality, and browser evidence

Domain modules must not import Vue, browser, process, filesystem, or MCP APIs. All design changes pass through typed, validated, revision-aware atomic operation batches. See [architecture contracts](docs/architecture-contracts.md) and the [design engine specification](openspec/changes/design-engine-foundation/) for the normative behavior.

## Author and license

Created by Camilo Escobar ([camilo.escobar2@utp.edu.co](mailto:camilo.escobar2@utp.edu.co)). This project is licensed under the [MIT License](LICENSE). Reuse must preserve the copyright and license notices. See [third-party notices](THIRD_PARTY_NOTICES.md) for reused tooling.
