# Release checklist

A release happens only after every gate below passes **on the exact commit being
released**. The order matters: nothing is packaged until the code is proven, and
nothing is published until the packaged artifact is proven too.

## 1. Repository gates (run by `npm run verify` and by CI)

| #   | Gate                 | Command                                                                                                     | Passing means                                                        |
| --- | -------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | Lint                 | `npm run lint`                                                                                              | 0 errors, 0 warnings                                                 |
| 2   | Types, main process  | `npx tsc -p tsconfig.node.json --noEmit`                                                                    | clean                                                                |
| 3   | Types, renderer      | `npx tsc -p tsconfig.web.json --noEmit`                                                                     | clean                                                                |
| 4   | Formatting policy    | `npm run format:check`                                                                                      | line-length rules clean **and** Prettier reports no differences      |
| 5   | Unit tests           | `npx vitest run --project unit`                                                                             | all pass                                                             |
| 6   | Integration tests    | `npx vitest run --project integration`                                                                      | all pass, against a real SQLite file                                 |
| 7   | Interface tests      | `npm run test:ui`                                                                                           | all pass, against the real application over the real core            |
| 8   | Stress test          | `DENTIVA_STRESS_PATIENTS=600 npm run test:stress`                                                           | all pass, budgets held                                               |
| 9   | End-to-end (IPC)     | `npm run test:e2e`                                                                                          | a complete clinic day succeeds                                       |
| 10  | Production build     | `npm run build`                                                                                             | main, preload and renderer bundles build                             |
| 11  | Packaged application | `npm run test:e2e:electron`                                                                                 | the real Electron application activates, sets up, signs in, restarts |
| 12  | Licence audit        | `npm run licenses` then `git diff --exit-code -- THIRD-PARTY-NOTICES.md src/renderer/generated/licenses.ts` | every package approved, notices current                              |
| 13  | Working tree         | `git status --short`                                                                                        | empty — the commit under test is the commit being released           |

## 2. Packaging gates (Windows CI job `windows-installer`)

| #   | Gate                             | Passing means                                                                                                     |
| --- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 14  | Installer and portable built     | `DentivaPro-1.0.0-Windows-x64-Setup.exe` and `…-Portable.exe` produced                                            |
| 15  | Silent install on a clean runner | application executable, uninstaller, Start Menu shortcut, desktop shortcut and uninstall registry entry all exist |
| 16  | Installed application runs       | `Dentiva Pro.exe --self-check` exits `0` with `ok`, `databaseOk`, `integrityOk` and `packaged` all true           |
| 17  | Uninstall removes the app        | the executables are gone and the uninstall entry is gone                                                          |
| 18  | Uninstall keeps the data         | a file written into the data folder before the uninstall is still there after it                                  |
| 19  | Artifacts uploaded               | installer, portable build, `latest.yml` and the installer evidence file are attached to the workflow run          |

The packaging gates are executed by `tools/ci/windows-check.ps1`, which the
`windows-installer` job runs on a clean `windows-latest` runner. The script builds
with `--publish never`: the build scripts must never be able to publish anything on
their own, so no build machine needs a GitHub token. It prints an evidence summary
that the job publishes as an annotation and uploads as
`windows-install-evidence.txt`, which is what the entries above are checked against.

## 3. Human gates

| #   | Gate                        | Owner | Action                                                                                                                                   |
| --- | --------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 20  | Pull request review         | Human | Read the diff, the test report and the CI run; approve                                                                                   |
| 21  | Merge                       | Human | Merge the pull request — **the agent must never merge it**                                                                               |
| 22  | Install on a real clinic PC | Human | Install from the released `.exe` on a Windows machine, activate, complete the wizard, print a prescription and an invoice, take a backup |
| 23  | Publish                     | Human | Tag the merged commit `v1.0.0` and attach the CI artifacts to the release                                                                |

## 4. Release notes must state

- Version and build number, and the minimum Windows version.
- What is new (or, for the first release, what the product does).
- The licence and activation facts: offline product, one-time local code,
  machine-bound, no telemetry — and the honest caveat that a local check cannot be
  made cryptographically strong.
- Where the data lives and where the backups live, with the reminder to keep a copy
  off the clinic computer.
- The checksums (SHA-256) of the uploaded artifacts.
- Known limitations for this release.

## 5. After the release

| Step | What to check                                                                         |
| ---- | ------------------------------------------------------------------------------------- |
| 1    | Download the artifacts from the release, not from a build folder                      |
| 2    | Verify the checksums against the release notes                                        |
| 3    | Install on a clean Windows machine and run `--self-check`                             |
| 4    | Complete the wizard, print one prescription and one invoice                           |
| 5    | Take a backup and restore it on the same machine (the pre-restore backup must appear) |
| 6    | Uninstall and confirm the data folder is kept                                         |

## 6. Rollback

Releases are never overwritten. If a release proves faulty: keep the artifacts,
mark the release as broken in its notes, publish the previous version's artifacts
as the recommended download, and fix forward with a new version. Clinic data is
portable between versions through the backup/restore path, so a clinic can always
return to the previous version by installing it and restoring its own backup.
