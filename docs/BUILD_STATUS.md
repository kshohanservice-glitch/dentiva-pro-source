# Dentiva Pro — Build Status

> Single source of truth for resuming work. Update at the end of every work session.

| Field         | Value                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| Current phase | Phase 22 — production build + clean-machine verification (Linux gates green; the Windows self-check is being re-run) |
| Version       | 1.0.0 (build 1000)                                                                                                   |
| Branch        | `arena/01a0f0ee-dentiva-pro-source`                                                                                  |
| Base commit   | `b06410d` (main, initial repository state)                                                                           |
| Last updated  | 2026-09-30 (fourteen CI runs; every Linux gate green, Windows install/shortcut/registry gates verified)              |

## Phase tracker

| Phase | Description                                                                                              | Status                                                                                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | Repository inspection                                                                                    | ✅ Complete                                                                                                                                            |
| 1     | Architecture + ADR (`docs/ARCHITECTURE.md`)                                                              | ✅ Complete                                                                                                                                            |
| 2     | Shared contracts (`src/shared`: types, permissions, money, dates, IPC surface)                           | ✅ Complete                                                                                                                                            |
| 3     | Database schema, migrations, connection + SQL helpers                                                    | ✅ Complete                                                                                                                                            |
| 4     | Core services: patients, visits, dental chart, prescriptions, treatments, referrals, appointments, queue | ✅ Complete                                                                                                                                            |
| 5     | Core services: invoices, payments, accounting, inventory                                                 | ✅ Complete                                                                                                                                            |
| 6     | Core services: users, roles, auth, staff, dentists, attachments                                          | ✅ Complete                                                                                                                                            |
| 7     | Core services: seed, backups, setup/activation, app shell, search, dashboard, reports, print, system     | ✅ Complete                                                                                                                                            |
| 8     | Integration tests against a real SQLite file                                                             | ✅ Complete (59 tests, 6 suites)                                                                                                                       |
| 9     | zod validation + main-process IPC router (175 methods)                                                   | ✅ Complete — schemas inferred from the API contract                                                                                                   |
| 10    | Preload bridge + dev bridge (browser preview outside Electron)                                           | ✅ Complete                                                                                                                                            |
| 11    | Design system (tokens + components)                                                                      | ✅ Complete                                                                                                                                            |
| 12    | Renderer screens (dashboard, patients, clinical, billing, admin)                                         | ✅ Complete                                                                                                                                            |
| 13    | Setup wizard + activation UI                                                                             | ✅ Complete                                                                                                                                            |
| 14    | Printing UI (preview, printer profiles, templates)                                                       | ✅ Complete                                                                                                                                            |
| 15    | Global search + notification centre                                                                      | ✅ Complete                                                                                                                                            |
| 16    | UX refinement pass on every screen                                                                       | 🔄 Continuous — responsive/DPI/empty-state review ongoing                                                                                              |
| 17    | Testing: unit, UI, E2E, stress                                                                           | ✅ Complete — 41 unit · 60 integration · 24 UI · 8 stress · 38 E2E checks                                                                              |
| 18    | Security audit (RBAC guards vs catalogue, password, activation, destructive ops)                         | 🔄 Continuous — sweep done, re-run on service changes                                                                                                  |
| 19    | Installer assets (`EULA.txt`, `installer.nsh`, licences bundle, notices)                                 | ✅ Complete                                                                                                                                            |
| 20    | Clean-machine installation test                                                                          | 🔄 Verified in CI: install, shortcuts, uninstall entry, licence bundle, notices; installed self-check and data-survival uninstall pending the next run |
| 21    | Release audit + requirements traceability                                                                | ✅ Complete — `docs/REQUIREMENTS-TRACE.md` maps all 42 requirement groups                                                                              |
| 22    | Production build + final artifact validation                                                             | 🔄 Installer and portable built on Windows CI (`DentivaPro-1.0.0-Windows-x64-Setup.exe`, 106.98 MB)                                                    |
| 23    | GitHub Release / `dist` artifacts                                                                        | ⏳ Pending — human merge gate, then tag and publish                                                                                                    |

## Verification ledger (this session, working tree)

| Gate                                           | Command                                           | Result                                                              |
| ---------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| Typecheck (main/preload/core/tools/tests)      | `npx tsc -p tsconfig.node.json --noEmit`          | ✅ clean                                                            |
| Typecheck (renderer)                           | `npx tsc -p tsconfig.web.json --noEmit`           | ✅ clean                                                            |
| Lint                                           | `npm run lint`                                    | ✅ clean (0 errors, 0 warnings)                                     |
| Format (custom rules + Prettier)               | `npm run format:check`                            | ✅ clean                                                            |
| Unit tests                                     | `npx vitest run --project unit`                   | ✅ 37/37 (5 suites, 3.3 s)                                          |
| Integration tests                              | `npx vitest run --project integration`            | ✅ 59/59 (6 suites, 32.5 s, real SQLite + Argon2id)                 |
| Interface tests (real renderer over real core) | `npm run test:ui`                                 | ✅ 23/23 (6 suites, 48.4 s, jsdom + real IPC router)                |
| Stress test (600 patients)                     | `DENTIVA_STRESS_PATIENTS=600 npm run test:stress` | ✅ 8/8 (9.1 s including backup and staged restore)                  |
| End-to-end against the real stack              | `npm run test:e2e`                                | ✅ 38/38 checks                                                     |
| Packaged application (Playwright + Electron)   | `npm run test:e2e:electron`                       | 🔄 Runs in CI (needs the Electron binary; skips itself locally)     |
| Production build                               | `npm run build`                                   | ✅ main + preload + renderer bundles built                          |
| Licence audit                                  | `npm run licenses`                                | ✅ 574 packages approved (36 direct), notices and texts regenerated |
| Windows installer + clean-machine test         | CI job `windows-installer`                        | 🔄 Pending first run                                                |

## Environment facts (verified 2026-09-30)

| Capability                                        | Local sandbox                            | GitHub Actions      |
| ------------------------------------------------- | ---------------------------------------- | ------------------- |
| Node 22 + `npm ci`                                | ✅ 641 packages, exit 0                  | ✅                  |
| better-sqlite3 13 (N-API, FTS5, WAL, backup API)  | ✅ verified working                      | ✅                  |
| TypeScript typecheck of `src` + `tests` + `tools` | ✅ clean (both tsconfigs)                | ✅                  |
| Unit / integration / UI / stress suites           | ✅ 127 tests, all green                  | ✅                  |
| Renderer build (Vite/React/TS)                    | ✅                                       | ✅                  |
| Playwright driving the built Electron app         | ❌ no Electron binary (download blocked) | ✅                  |
| electron-builder NSIS packaging                   | ❌ Windows-only toolchain                | ✅ `windows-latest` |
| Clean-machine install/uninstall test              | ❌                                       | ✅ `windows-latest` |

Consequence: Windows-specific verification (installer, clean-machine install,
real printer enumeration, packaged `printToPDF`, DPI scaling at 100–200 %) is
executed by the Windows CI job. The sandbox verifies the whole domain layer, the
renderer, the print templates, the packaged main-process self-check logic and the
complete application workflow over the real IPC surface.

## What exists now

- `src/shared` (10 modules): app info, money (integer paisa), dates/zones, errors, constants (clinical,
  billing, inventory, print, 22 report keys), permissions (76 keys + presets), dental numbering, domain
  types, the 175-method typed IPC contract, and the password policy.
- `src/core/db`: forward-only migrations (`0001_baseline` … `0004_searchable_fts`), 53 STRICT tables + 4 FTS5
  virtual tables, connection pragmas (WAL, `synchronous=FULL`, `foreign_keys=ON`), integrity checks, SQL helpers.
- `src/core/util`: rotating logger, id/sequence helpers, safe file storage, ZIP writer, CSV escaping.
- `src/core/security`: Argon2id passwords + policy, offline activation (derived digest only), session manager
  with auto-lock.
- `src/core/services` (30 files): patients, visits, dental chart, prescriptions, treatments, referrals,
  appointments, queue, invoices, payments, accounting, inventory, users/RBAC, auth, staff, dentists,
  attachments, audit, notifications, search, dashboard, reports, print, backup/restore, setup, settings,
  system, app, resources. `system-service.ts` exposes `integrityCheckInternal()` for the pre-login self-check.
- `src/main`: Electron entry point (single instance, paths with the `DENTIVA_DATA_DIR` override, fonts, hidden
  print host, menus, auto-lock, destructive-action guards), the typed IPC router with zod schemas inferred from
  the API contract, and `--self-check` (`src/main/self-check.ts` → `collectSelfCheck()`), which reports the
  installation's health as JSON and exits 0/1.
- `src/preload`: `contextBridge` surface (`window.dentiva`: `invoke`, `on`, `versions`, `env`).
- `src/renderer`: design tokens + component library, application shell (sidebar PRACTICE/CLINICAL/BILLING/
  ADMINISTRATION, header with branding/clinic/date/search/notifications/user menu), and every screen:
  dashboard, patients (+ detail with timeline/chart/attachments), visits, dental chart, prescriptions,
  invoices, payments, treatments, inventory, accounting, reports, appointments, queue, referrals, staff,
  dentists, users/roles, settings centre, backup/restore, audit log, notifications, About, setup wizard,
  lock screen.
- `tests`: `unit/` (5 suites), `integration/` (6 suites incl. `self-check.test.ts`), `ui/` (6 suites over the
  real renderer), `stress/clinic-volume.test.ts`, `e2e/` (Playwright config + two specs driving real
  Electron), harnesses with a real database and a fake print host.
- `tools`: `dev.mjs`, `run-e2e.mjs` (38 checks), `seed-stress.mjs`, `make-icons.mjs`, `license-audit.mjs`
  (notices, generated licence list, packaged plain-text notices and the deduplicated licence-text bundle),
  `format-check.mjs`.
- `build`: multi-resolution `icon.ico` + PNG set, `EULA.txt` (shown by the installer), `installer.nsh`
  (creates the data folder, and the uninstall message that states the data was kept), plus the generated
  `licenses/OPEN-SOURCE-LICENCES.txt` and `THIRD-PARTY-NOTICES.txt` that the installer copies into the package.
- `.github/workflows/ci.yml`: Linux job (lint, both typechecks, format, licence-notice freshness, unit +
  integration + UI + 600-patient stress, build, IPC end-to-end, Playwright-over-Electron under xvfb) and
  Windows job (installer + portable build, silent install, shortcut/uninstall-entry checks, `--self-check` on
  the installed copy, uninstall with data-preservation proof, artifact upload).
- Docs: `README.md`, `ARCHITECTURE.md`, `INSTALL.md`, `USER-GUIDE.md`, `BACKUP-AND-RESTORE.md`, `PRINTING.md`,
  `TROUBLESHOOTING.md`, `TEST-REPORT.md`, `RELEASE-CHECKLIST.md`, `BUILD_STATUS.md`, `DESIGN.md`,
  `REQUIREMENTS-TRACE.md`, `THIRD-PARTY-NOTICES.md`.

## Bugs found and fixed while building the test layers

- `reports.run('dentist_activity')` bound 16 parameters to 14 placeholders and threw
  `RangeError: Too many parameter values were provided` — every call failed. The query now uses named
  `@from`/`@to` parameters, and `tests/integration/reports.test.ts` executes **all 22 report keys** through
  `run`, `exportCsv` and `export` so a catalogue entry can never be unreachable again.
- Report CSV/print tests assert that no cell is `undefined` and that no output contains `[object Object]`,
  which closed the last `no-base-to-string` pockets in the reporting path.
- The UI suite found three real interface bugs, all fixed: `useApi(undefined)` crashed every screen that
  calls a method without a payload; save dialogs for methods that return nothing (`setup.*`, `users.*`,
  `accounting.transactions.*`) treated success as failure and stayed open; the wizard's dentist step seeded
  blank credential rows that the core rejected with an error the screen could not show.
- The installation self-check needed an integrity report before anybody signs in, but
  `system.integrityCheck()` correctly requires `settings.view`. Fixed by splitting the permission check from
  the work (`integrityCheckInternal()`), so no permission is bypassed and the self-check still runs.
- **Interface:** `useAction().run()` returns `null` on failure and the method's own result on success, so
  `result !== undefined` is true for a failure and false for the successful call of any method that returns
  nothing — the setup wizard never advanced after a step, save dialogs for void methods never closed, and
  `queue.setStatus` did not refresh. The wizard and the two dialogs use the new `runOk()`, which answers
  "did it work?" directly, and every remaining `result !== undefined`/`null` guard was audited against the
  method's declared result type.
- **Windows paths:** `path.resolve(new URL('..', import.meta.url).pathname)` keeps the leading slash of a
  file URL and Windows then prefixes the current drive (`D:\D:\a\…`), which broke `npm run dist:all` on the
  Windows runner. Every tool now uses `fileURLToPath`, as the Vite and Vitest configs already did.
- **Packaging:** `electron-builder` saw a CI environment, honoured `publish: github` and demanded a token,
  failing the build after both artifacts were produced. The build scripts pass `--publish never`; publishing
  is a separate, human decision by design.
- **Windows self-check:** the packaged application is a GUI-subsystem executable, so Windows does not
  guarantee that its standard output reaches a calling script and the pipeline read an empty report. The
  self-check now also writes the report to `--self-check-file=<path>`, which is what the pipeline reads and
  the Playwright spec asserts.
- **Playwright vs. the CI logs:** Playwright clears its output folder before a run, and that folder was
  `test-results` itself, so the step transcripts and the suite's diagnostics were deleted just before the
  upload. The suite writes into `test-results/playwright` now.
- The first CI run failed on licence freshness: the generator stamped a wall-clock timestamp into
  `THIRD-PARTY-NOTICES.md` and `src/renderer/generated/licenses.ts`, so regenerating on the runner always
  produced a diff. The generator is deterministic now — package set plus content digest, no clock — and two
  consecutive runs on this machine produce identical bytes (digest `503fccde…`).
- `tools/format-check.mjs` exempted long lines with an unanchored "licen" match, which also excused
  `tools/license-audit.mjs`; the exemption is anchored to the licence/generated directories and to the two
  exempt file names.
- Reading the `HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall` key threw on a machine that has
  never installed a per-user application; the check tolerates a missing key and asserts the absence of the
  entry before the install.

## What the pipeline found that no local gate could

- **The packaged-application suite had never run.** It resolved the repository root
  through `import.meta.url`, and Playwright loads spec files as CommonJS: the file failed
  to load, the run said "No tests found", and the step's `continue-on-error` turned that
  into a green packaged-application gate for six consecutive runs. The suite now resolves
  paths from the working directory with a manifest check, refuses to be skipped in CI, and
  runs the self-check as a process (Playwright's Electron API cannot attach to an
  application that prints a report and exits).
- **Activation never completed through the interface.** `ActivationScreen` discarded the
  result of `activation.activate`, so the correct code left the user on the gate, and a
  refusal explained itself only in a toast — never with the remaining attempts that the
  "Previous attempt" panel exists to show. Fixed with `runOk()` and a status reload; the
  interface suite drives the screen itself now, and the packaged suite drives the real
  application.
- **A silent uninstall waited for a click that never comes.** NSIS shows a
  `MessageBox` even in silent mode, so the message telling a person their clinic
  data had been kept stopped the uninstaller dead on the CI machine — long enough
  that the job would have sat there for hours with no explanation. The dialog is
  now inside `${IfNot} ${Silent}`, and the check gives the uninstaller three
  minutes before failing, so a stuck dialog says so instead of hanging.
- **PowerShell does not wait for a GUI executable.** `& "Dentiva Pro.exe" --self-check`
  returned immediately, so the pipeline read the exit code of a process that had not
  exited and looked for a report that had not been written — and saw `0` for both. Every
  invocation now uses `Start-Process -Wait -PassThru`; the launch trace
  (`DENTIVA_LAUNCH_TRACE=1`) is what proved the main process had not even started.

## Continuous integration

| Run | Commit    | Linux `verify` | Windows `windows-installer` | What it proved                                                                                                                                                                                                                    |
| --- | --------- | -------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `35fbd2e` | failed         | not started                 | licence freshness compared a wall-clock timestamp                                                                                                                                                                                 |
| 2   | `bcd7f45` | failed         | not started                 | licences deterministic; the packaged Playwright spec needed headless switches                                                                                                                                                     |
| 3   | `0a14002` | **passed**     | failed                      | whole Linux chain green incl. Playwright over Electron; `D2:\` path bug on Windows                                                                                                                                                |
| 4   | `5e567ed` | **passed**     | failed                      | `fileURLToPath` fixed; electron-builder tried to publish and demanded a token                                                                                                                                                     |
| 5   | `285aeb1` | **passed**     | failed                      | `--publish never`; the Uninstall registry key threw on a clean machine                                                                                                                                                            |
| 6   | `4d3649a` | **passed**     | failed                      | installer + portable built and installed; shortcuts, uninstall entry, licence bundle and packaged notices verified; the installed `--self-check` printed nothing (GUI-subsystem stdout)                                           |
| 7   | `7b6a815` | **passed**     | failed                      | the installed `--self-check` still produced no report on Windows                                                                                                                                                                  |
| 8   | `0adf955` | **passed**     | failed                      | the `--self-check-file` switch never reached `process.argv` on Windows; an environment variable replaced it                                                                                                                       |
| 9   | `75502b6` | failed         | not started                 | the packaged suite loaded at last — Playwright's Electron API cannot drive a process that exits immediately                                                                                                                       |
| 10  | `7dcfbaf` | failed         | not started                 | the self-check ran as a spawned process; the wizard step hit a strict-mode violation                                                                                                                                              |
| 11  | `7a8043c` | failed         | not started                 | Playwright's output folder moved into the repository root                                                                                                                                                                         |
| 12  | `4197803` | **passed**     | failed                      | **the packaged application walks activation, the wizard, sign-in and a restart on real Electron**; no self-check report on Windows                                                                                                |
| 13  | `0a34805` | **passed**     | failed                      | a launch trace proved the main process had not run at all when the check looked                                                                                                                                                   |
| 14  | `4308c79` | **passed**     | failed                      | `Start-Process -Wait` makes the installed self-check run at last — healthy on the default and the relocated data folder, exit 1 on a broken one — and then the check's own assertion helper threw on a string                     |
| 15  | `16cd816` | **passed**     | cancelled (hung)            | the assertion helper is fixed and the check reached the uninstall — where the "your data was kept" dialog waited for a click on an unattended machine; the next push cancelled it through the workflow's own concurrency rule     |
| 16  | `7b81c15` | **passed**     | **passed**                  | **every gate green**: install, shortcuts, uninstall entry, licence bundle, self-check healthy on the default and relocated folders and exit 1 on a broken one, uninstall removing the application while keeping the clinic's data |

Run 6 built `DentivaPro-1.0.0-Windows-x64-Setup.exe` (106.98 MB) and
`DentivaPro-1.0.0-Windows-x64-Portable.exe` (106.59 MB).

The pipeline publishes its reason where a maintainer always sees it: heavy steps
keep transcripts, the Windows check writes a compact `=== FAILURE ===` block, and
the job turns those into annotations (the raw logs are dominated by bundler
output).

## Resume point (next work session starts here)

**Run 16 (commit `7b81c15`, run `36716332055`) is green on both jobs.** Every release
gate that can be checked by machine has now passed, and the evidence is quoted in
`docs/TEST-REPORT.md`. What remains is the part only a person can do:

1. Wait for the pipeline on the final documentation commit to go green (both the `push`
   and the `pull_request` run) and check that the evidence annotation still matches the
   table in `docs/TEST-REPORT.md`.
2. **`docs/RELEASE-CHECKLIST.md` sections 1 and 2 are complete on commit `06fa577`; the
   remaining gates are the human ones (section 3).** Pull request **#1** is open —
   https://github.com/kshohanservice-glitch/dentiva-pro-source/pull/1 — `main` is
   mergeable and the owner reviews and merges it. The agent must never merge.
3. After the merge: tag `v1.0.0`, attach the two Windows artifacts from the green run and
   follow `docs/RELEASE-CHECKLIST.md` section 4. The `.exe` is deliberately never built or
   published before those gates pass.
4. If the sandbox loses its repository token again, `git fetch origin <branch>` restores
   the history — the working tree survives a sandbox restart even when `.git` does not,
   and the branch pointer in the snapshot may lag behind the remote.

## Known follow-ups

- The Windows-only verification results still have to be recorded in `docs/TEST-REPORT.md` (installer,
  clean-machine install, printer enumeration, packaged `printToPDF`) once the CI job has run.
- `sql.ts` sort allow-list (`ALLOWED_SORT_COLUMNS`/`allowSortColumns`/`resolveSort`) is implemented; list
  endpoints use parameterised ORDER BY clauses directly — decide (adopt or delete) before release.
- Prettier is a dev dependency and the single formatter; `tools/format-check.mjs` keeps the rules Prettier
  cannot express (LF, final newline, no tabs, the 140-character limit excluding licence/generated files and
  Markdown tables).
- The design system's 100–200 % DPI review remains a manual check on real hardware; there is no automated
  visual regression suite.
