# Codebase MCP

This repository uses the native [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) MCP server. The checked release is v0.11.0 (2026-10-04). `tooling/codebase/install-v0.11.0.sh` is the installer fetched from the matching Git tag and reviewed before execution. It downloads the matching macOS arm64 release archive, verifies the archive against the release's published SHA-256 checksums, and invokes the archive's own install command. The installed binary is in the ignored `.codex-design/bin/` directory; the graph cache is in ignored `.codex-design/cache/`.

Copy `.codex/config.example.toml` to the ignored `.codex/config.toml` and replace its launcher path with this checkout's absolute path. The local config is machine-specific and must not be committed. Its launcher sets `CBM_ALLOWED_ROOT` to this repository and `CBM_CACHE_DIR` to the ignored local cache, changes to the repository root, and starts the installed server. No global Codex MCP configuration is needed. The native installer appended the local binary path to `~/.zshrc` even with `--skip-config`; that exact PATH addition was removed after installation.

## Commands

Refresh the current checkout's graph after adding or changing source files:

```sh
tooling/codebase/launch.sh cli index_repository --repo-path "$PWD"
```

Use the project ID returned by `index_repository` in place of `YOUR_INDEX_PROJECT_ID`. Check freshness, root, graph counts and parser coverage:

```sh
tooling/codebase/launch.sh cli index_status --project YOUR_INDEX_PROJECT_ID --diagnostics summary
```

Run a graph semantic query:

```sh
tooling/codebase/launch.sh cli search_graph \
  --project YOUR_INDEX_PROJECT_ID \
  --semantic-query 'Which function validates the final graph before committing one revision?'
```

The local launcher passes the same root and cache settings used by the MCP entry. Index files under `.codex-design/` and `.git/` are excluded. The background watcher can refresh an active, registered MCP project; the explicit `index_repository` command is the reliable refresh command for scripts and one-shot checks.

## Verification record

- Installed binary: `codebase-memory-mcp 0.11.0`; upstream installer verified the release archive checksum before activation.
- MCP stdio handshake succeeded with protocol `2025-03-26`; `tools/list` returned all 17 server tools, including `index_repository`, `search_graph`, `index_status`, and `check_index_coverage`.
- Index root: the current repository checkout. Latest resumed-session reconcile reported ready, 1,359 nodes / 4,076 edges at the final 2026-10-05 reconcile. Two parser-partial ranges occur in valid Vitest `vi.hoisted` mock expressions (`persistence-faults.test.ts:9`, `run-store.test.ts:13`); those tests were inspected directly and passed strict TypeScript/runtime checks. No unusable parser files or unexpected skips were reported. Refresh again after further source edits. `.codex-design`, `.git`, `node_modules` and browser results are excluded by design. No Git commit exists yet.
- A temporary TypeScript fixture proved semantic retrieval and rename refresh, then was removed. Product TypeScript/Vue source now exists. Indexed searches retrieve `applyBatch`, `validateDocument`, `ProjectService`, Codex adapter and Vue UI symbols, verified against actual source.
- Semantic query ranks code entities; literal `search_code` retrieves Markdown contracts. During the original planning-only checkpoint, semantic queries had no product symbols. That limitation no longer describes the current source tree. Never infer absent contracts from zero semantic results.

Indexed source/section search is also available for planning documents:

```sh
tooling/codebase/launch.sh cli search_code \
  --project YOUR_INDEX_PROJECT_ID \
  --pattern 'Operation batches are revision-aware' --file-pattern '*spec.md'
```

Coordinator independently verified this returned the exact OpenSpec operation-batch section. Markdown outlines and product code entities are indexed; verify current source whenever freshness or parser coverage is uncertain.

Final semantic retrieval for queued traversal budgeting ranked unrelated helpers ahead of the validator. Literal indexed source search is therefore used to locate pendingValues/inspectJsonGraph, followed by source verification; semantic ranking is not treated as proof of absence or conformance.
