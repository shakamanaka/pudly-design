## ADDED Requirements
### Requirement: Isolated Claude session recognition
The Claude subscription adapter SHALL preserve safe OS identity required by the local login while excluding ambient API credentials and custom execution configuration. Authentication discovery SHALL be read-only, bounded and sanitized.
#### Scenario: Existing local login
- **WHEN** the CLI recognizes the device login with USER present
- **THEN** the isolated app environment also recognizes it without importing credential values
#### Scenario: Missing or failed session check
- **WHEN** authentication discovery fails or finds no login
- **THEN** the UI exposes unknown or signed-out status separately from inference verification
### Requirement: Account-derived Claude catalog
The service SHALL discover the local subscription catalog through bounded read-only SDK controls and preserve model identifiers, labels and supported efforts when advertised. It SHALL NOT claim inference entitlement from discovery or share subscription results with API-key connections.
#### Scenario: More than three aliases
- **WHEN** the installed CLI advertises versioned and additional models
- **THEN** the dropdown presents those model options instead of a fixed three-alias list
#### Scenario: Failed discovery
- **WHEN** discovery times out or returns malformed data
- **THEN** the child processes terminate and catalog status remains explicitly partial or unknown
#### Scenario: API-key isolation
- **WHEN** an API-key connection is selected
- **THEN** the local subscription catalog and authentication evidence are not assigned to it
### Requirement: Honest connection status
The UI SHALL distinguish local session recognition from exact model/effort verification, preserve supported selections across refresh, and invalidate verification after changing the selected tuple.
#### Scenario: Verification fails with a recognized session
- **WHEN** the local session is authenticated but inference verification fails
- **THEN** the UI displays verification failure without asserting the session or model is unavailable
#### Scenario: Model change
- **WHEN** the selected model changes
- **THEN** its advertised effort options apply and prior tuple verification does not authorize generation
