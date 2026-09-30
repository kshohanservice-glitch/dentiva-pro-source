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
