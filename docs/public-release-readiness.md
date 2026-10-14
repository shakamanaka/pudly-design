# Public repository readiness

Prepared for Camilo Escobar, contact camilo.escobar2@utp.edu.co. Version 1.0.0 is prepared locally; publication is delegated to the author.

## Source and attribution

- Standard MIT license with Camilo Escobar copyright and author metadata in package.json.
- Third-party notices retain OpenSpec Contributors and DeusData licensing for reused workflow skills and installer code.
- README describes the early-stage product, actual provider/export/image limits, setup and offline checks.
- Source comments were reviewed for decorative AI icons; no such comments needed removal. Intentional UI symbols and test data remain intact.
- Machine-specific MCP configuration, project data, secrets, recordings, dependency trees and build output are excluded. A portable MCP configuration example is included.
- A pattern review of the source candidate set found no private keys, provider/GitHub bearer tokens or personal home-directory paths. This is a bounded review, not a claim of exhaustive security certification.

## Verification

A source-only snapshot under the ignored .codex-design/public-release directory installed from package-lock.json with npm ci. It passed npm run check: lint, strict TypeScript, 376 tests in 61 files, and production build. The clean snapshot's standard Playwright configuration passed nine headed recorded offline browser tests; the single live provider test was intentionally skipped. The workspace's complete offline browser suite also passed. No model account was called for this preparation.

Default browser tests now use deterministic provider fixtures. The explicit live harness selects and verifies a provider/model/effort before generation; its revised live path was typechecked, not exercised with paid inference in this preparation. Recordings and audit manifests remain local and are not part of the public source set.

## Git and publication boundary

The repository is on main. Local author and committer identity resolves to Camilo Escobar <camilo.escobar2@utp.edu.co>; no global identity changed. No commit template or active hook adds co-author trailers. Commits prepared for this project must omit Co-authored-by.

Reviewed source is committed locally, with a separate 1.0.0 release-metadata commit and annotated v1.0.0 tag. The user instructed that they will handle the push. No remote repository creation, push or GitHub publication has been performed.
