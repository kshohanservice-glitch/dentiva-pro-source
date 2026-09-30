# v1.0.0 release audit — BLOCKED

The installed Windows GUI crashed before readiness on the merged main build. The
old draft/tag and the 4bb2172 artifacts MUST NOT be published. The main process
called `session.defaultSession` synchronously from `bootstrap()` before Electron
had become ready. The self-check bypassed `bootstrap()`, hiding the failure.

This branch registers the webview guard before readiness and installs the same
packaged response-header CSP inside `app.whenReady()`, before restore, container,
IPC registration or window creation. The Windows clean-machine script now launches
the installed EXE without flags, waits for a Dentiva Pro window and checks that
the process remains alive. This is a regression gate, not a substitute for an
owner's real-machine acceptance test of activation, wizard and dashboard.

Release remains blocked until the new commit passes both CI jobs and a new
installer and portable build from that commit pass real Windows GUI acceptance.
Record the downloaded artifact's SHA-256 using `node tools/release-checksums.mjs`.
Do not reuse historical artifact checksums.

## Subsequent audit pass — still blocked

The shared patient picker had no arrow/Enter/Escape selection or accessible
combobox semantics; it has been rebuilt with request cancellation, explicit
selected IDs, clear/change, loading/empty/error states and an anchored listbox.
The enclosing generic label previously made a nested action's accessible name
include unrelated field text; this picker now uses non-interactive field chrome.
An invoice UI regression exercises keyboard and mouse selection of distinct
patient IDs. Full patient-linked-form and Windows DPI review remains open; see
`MASTER-AUDIT-MATRIX.md`. CI for this subsequent commit must pass independently.
