## ADDED Requirements

### Requirement: Dynamic bounded Codex discovery
The backend SHALL obtain the connected local Codex account model catalog through read-only app-server model/list requests, following bounded pagination and preserving model IDs, names and advertised effort order. Discovery SHALL NOT generate designs or alter authentication/configuration.

#### Scenario: Multiple catalog pages
- **WHEN** model/list provides several pages
- **THEN** the catalog includes each model and its own supported efforts without truncating to Sol6.1

#### Scenario: Failed or malformed discovery
- **WHEN** discovery times out, is malformed, or fails
- **THEN** processes terminate and the UI exposes a partial or unknown fallback rather than claiming a complete catalog

### Requirement: Connection-specific catalog evidence
Discovery SHALL NOT imply verified inference access or share a local subscription catalog with API-key connections. Existing verified tuples SHALL remain scoped to their connection.

#### Scenario: Catalog without inference verification
- **WHEN** a model is discovered
- **THEN** generation still requires explicit verification of that model and effort

#### Scenario: Different authentication source
- **WHEN** an OpenAI API-key connection is selected
- **THEN** its catalog does not reuse the local ChatGPT account list

### Requirement: Explicit model and effort controls
The UI SHALL present all discovered models in a dropdown and only the selected model's advertised effort options, preserving valid selection across refresh and exposing manual custom IDs separately.

#### Scenario: Switch model
- **WHEN** the user chooses a model with a different effort set
- **THEN** unsupported prior effort is replaced by its advertised default or first option and the old verification is invalidated

#### Scenario: Refresh preserves choice
- **WHEN** the catalog refreshes and the selected tuple remains supported
- **THEN** the selection is preserved
