## Purpose
Provide consistent Pudly product identity while preserving existing saved creations and provider integrations.

## ADDED Requirements
### Requirement: Pudly product identity
The application SHALL identify the product as Pudly in its header, accessible workspace name, browser title, package metadata and newly generated export branding. References to the Codex provider SHALL retain that provider name.
#### Scenario: Open the editor
- **WHEN** the user opens the editor
- **THEN** the header, workspace accessible name and browser title identify Pudly, while Codex connection choices retain their names.
#### Scenario: Export a design
- **WHEN** the user exports Vue or a Figma plugin
- **THEN** newly generated archive/package/plugin branding uses Pudly and export fidelity behavior remains unchanged.
### Requirement: Existing creation compatibility
The rename SHALL retain existing persistence paths, storage keys, configuration variables and native document format.
#### Scenario: Reopen prior creations
- **WHEN** Pudly starts using the existing local data directory
- **THEN** previous projects and history remain available without data migration.
