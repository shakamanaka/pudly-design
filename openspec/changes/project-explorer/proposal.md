## Why
Saved creations exist locally but the editor offers no discoverable way to browse, reopen, create or remove them. A project explorer makes the existing durable designs accessible.
## What Changes
- Add an editor project menu opening a responsive explorer with grid previews and a list view, newest saved first.
- Create named projects, open historical projects without generation, and remove projects from the library through a recoverable local trash transition.
- Preserve history and block project transitions during active generation; isolate damaged projects.
## Capabilities
### New Capabilities
- `project-explorer`: local library discovery, previews and project lifecycle UI.
### Modified Capabilities
None.
## Impact
Persistence adapter, application project service, local API, Vue explorer and independent integration/browser tests. No cloud accounts, billing changes or model inference for previews.
