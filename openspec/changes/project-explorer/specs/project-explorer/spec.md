## Purpose
Make previously saved local design projects discoverable through previews and safe project lifecycle navigation.
## ADDED Requirements
### Requirement: Discoverable local project library
The editor SHALL expose a project menu with grid previews and list views ordered by latest save, showing project names and saved timestamps. Previews SHALL derive from saved DesignDocument without inference or mutation.
#### Scenario: Existing projects
- **WHEN** the explorer opens with multiple saved creations
- **THEN** all valid local projects appear in both views and their previews represent saved first-page content
#### Scenario: Empty or damaged project
- **WHEN** a project is empty or damaged
- **THEN** an explicit empty/unavailable card appears without hiding healthy projects
### Requirement: Create and reopen projects
Users SHALL create named projects and open any available saved project while preserving its design/history and without starting generation.
#### Scenario: Create and return
- **WHEN** a named project is created and a historical project is reopened
- **THEN** the historical document/history remain unchanged and the chosen project remains active after reload
### Requirement: Confirmed recoverable removal
Users SHALL remove a specifically confirmed project from the library; removal SHALL retain its saved envelope in local trash and update active selection safely.
#### Scenario: Remove inactive project
- **WHEN** the user confirms removal of a historical project
- **THEN** it disappears from discovery while the active project is unchanged and its envelope is retained in trash
#### Scenario: Remove active project
- **WHEN** the active project is removed
- **THEN** the editor reaches a valid empty state and reload does not point to the removed project
#### Scenario: Removal failure or cancelled confirmation
- **WHEN** removal fails or confirmation is cancelled
- **THEN** the design and visible current selection remain unchanged with an actionable error for failure
### Requirement: Lifecycle isolation and accessibility
The explorer SHALL block project lifecycle changes during active generation, reject unsafe identifiers and symbolic link project files, and support keyboard navigation and narrow viewport scrolling.
#### Scenario: Active generation
- **WHEN** create/open/remove is requested during an active run
- **THEN** it fails without changing project or run state
#### Scenario: Unsafe storage entry
- **WHEN** discovery or a request encounters an unsafe identifier or symbolic link
- **THEN** no file outside the project store is read or modified
#### Scenario: Accessible navigation
- **WHEN** the explorer is used by keyboard or at a narrow viewport
- **THEN** controls and confirmation are reachable and the library content scrolls without clipping
