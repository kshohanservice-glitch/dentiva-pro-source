# Dentiva Pro — Build Status

> Single source of truth for resuming work. Update at the end of every work session.

| Field         | Value                                                                     |
| ------------- | ------------------------------------------------------------------------- |
| Current phase | Phase 20 — Windows installer + clean-machine test (built; CI run pending) |
| Version       | 1.0.0 (build 1000)                                                        |
| Branch        | `arena/01a0f0ee-dentiva-pro-source`                                       |
| Base commit   | `b06410d` (main, initial repository state)                                |
| Last updated  | 2026-09-30                                                                |

## Phase tracker

| Phase | Description                                                                                              | Status                                                                    |
| ----- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 0     | Repository inspection                                                                                    | ✅ Complete                                                               |
| 1     | Architecture + ADR (`docs/ARCHITECTURE.md`)                                                              | ✅ Complete                                                               |
| 2     | Shared contracts (`src/shared`: types, permissions, money, dates, IPC surface)                           | ✅ Complete                                                               |
| 3     | Database schema, migrations, connection + SQL helpers                                                    | ✅ Complete                                                               |
| 4     | Core services: patients, visits, dental chart, prescriptions, treatments, referrals, appointments, queue | ✅ Complete                                                               |
| 5     | Core services: invoices, payments, accounting, inventory                                                 | ✅ Complete                                                               |
| 6     | Core services: users, roles, auth, staff, dentists, attachments                                          | ✅ Complete                                                               |
| 7     | Core services: seed, backups, setup/activation, app shell, search, dashboard, reports, print, system     | ✅ Complete                                                               |
| 8     | Integration tests against a real SQLite file                                                             | ✅ Complete (59 tests, 6 suites)                                          |
| 9     | zod validation + main-process IPC router (175 methods)                                                   | ✅ Complete — schemas inferred from the API contract                      |
| 10    | Preload bridge + dev bridge (browser preview outside Electron)                                           | ✅ Complete                                                               |
| 11    | Design system (tokens + components)                                                                      | ✅ Complete                                                               |
| 12    | Renderer screens (dashboard, patients, clinical, billing, admin)                                         | ✅ Complete                                                               |
| 13    | Setup wizard + activation UI                                                                             | ✅ Complete                                                               |
| 14    | Printing UI (preview, printer profiles, templates)                                                       | ✅ Complete                                                               |
| 15    | Global search + notification centre                                                                      | ✅ Complete                                                               |
| 16    | UX refinement pass on every screen                                                                       | 🔄 Continuous — responsive/DPI/empty-state review ongoing                 |
| 17    | Testing: unit, UI, E2E, stress                                                                           | ✅ Complete — 37 unit · 59 integration · 23 UI · 8 stress · 38 E2E checks |
| 18    | Security audit (RBAC guards vs catalogue, password, activation, destructive ops)                         | 🔄 Continuous — sweep done, re-run on service changes                     |
| 19    | Installer assets (`EULA.txt`, `installer.nsh`, licences bundle, notices)                                 | ✅ Complete                                                               |
| 20    | Clean-machine installation test                                                                          | 🔄 Implemented in CI (`windows-installer` job); first run pending         |
| 21    | Release audit + requirements traceability                                                                | 🔄 In progress — docs set written; trace pending                          |
| 22    | Production build + final artifact validation                                                             | ⏳ Pending — after the CI run                                             |
| 23    | GitHub Release / `dist` artifacts                                                                        | ⏳ Pending — human merge gate, then tag and publish                       |

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
  `THIRD-PARTY-NOTICES.md`.

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

## Resume point (next work session starts here)

1. Push the branch and let CI run: the Linux `verify` job and the Windows `windows-installer` job.
2. Paste the Windows job's evidence (installer size, shortcut/uninstall checks, self-check report, data
   preserved after uninstall) into `docs/TEST-REPORT.md`, and record the CI run URL in this file.
3. Re-run the packaged-application Playwright spec on Linux CI; if the Electron build needs an argument in a
   headless runner, adjust `tests/e2e/app.spec.ts` (the xvfb wrapper is already in the workflow).
4. Finish the requirements trace (`docs/REQUIREMENTS-TRACE.md`) and mark phase 21 complete.
5. Stop at the human merge gate: the pull request is opened and reviewed by the owner, who merges it. The
   agent must never merge.
6. After the merge, tag `v1.0.0`, attach the artifacts produced by the Windows job, and follow
   `docs/RELEASE-CHECKLIST.md` section 4.

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
