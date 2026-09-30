# Dentiva Pro — Build Status

> Single source of truth for resuming work. Update at the end of every work session.

| Field         | Value                                                                        |
| ------------- | ---------------------------------------------------------------------------- |
| Current phase | Phase 17 — test layers (unit/integration/stress/E2E green; UI suite is next) |
| Version       | 1.0.0 (build 1000)                                                           |
| Branch        | `arena/01a0f0ee-dentiva-pro-source`                                          |
| Base commit   | `b06410d` (main, initial repository state)                                   |
| Last updated  | 2026-09-30                                                                   |

## Phase tracker

| Phase | Description                                                                                              | Status                                                           |
| ----- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 0     | Repository inspection                                                                                    | ✅ Complete                                                      |
| 1     | Architecture + ADR (`docs/ARCHITECTURE.md`)                                                              | ✅ Complete                                                      |
| 2     | Shared contracts (`src/shared`: types, permissions, money, dates, IPC surface)                           | ✅ Complete                                                      |
| 3     | Database schema, migrations, connection + SQL helpers                                                    | ✅ Complete                                                      |
| 4     | Core services: patients, visits, dental chart, prescriptions, treatments, referrals, appointments, queue | ✅ Complete                                                      |
| 5     | Core services: invoices, payments, accounting, inventory                                                 | ✅ Complete                                                      |
| 6     | Core services: users, roles, auth, staff, dentists, attachments                                          | ✅ Complete                                                      |
| 7     | Core services: seed, backups, setup/activation, app shell, search, dashboard, reports, print, system     | ✅ Complete                                                      |
| 8     | Integration tests against a real SQLite file                                                             | ✅ Complete (93 unit+integration tests)                          |
| 9     | zod validation + main-process IPC router (175 methods)                                                   | ✅ Complete — schemas inferred from the API contract             |
| 10    | Preload bridge + dev bridge (browser preview outside Electron)                                           | ✅ Complete                                                      |
| 11    | Design system (tokens + components)                                                                      | ✅ Complete                                                      |
| 12    | Renderer screens (dashboard, patients, clinical, billing, admin)                                         | ✅ Complete                                                      |
| 13    | Setup wizard + activation UI                                                                             | ✅ Complete                                                      |
| 14    | Printing UI (preview, printer profiles, templates)                                                       | ✅ Complete                                                      |
| 15    | Global search + notification centre                                                                      | ✅ Complete                                                      |
| 16    | UX refinement pass on every screen                                                                       | 🔄 Continuous — responsive/DPI/empty-state review ongoing        |
| 17    | Testing: unit, UI, E2E, stress                                                                           | 🔄 unit ✅ · integration ✅ · stress ✅ · E2E ✅ · UI suite next |
| 18    | Security audit (RBAC guards vs catalogue, password, activation, destructive ops)                         | 🔄 Continuous — sweep done, re-run on service changes            |
| 19    | Installer (NSIS) + portable build                                                                        | ⏳ Pending — needs `windows-latest`                              |
| 20    | Clean-machine installation test                                                                          | ⏳ Pending — needs `windows-latest`                              |
| 21    | Release audit + requirements traceability                                                                | ⏳ Pending                                                       |
| 22    | Production build + final artifact validation                                                             | ⏳ Pending                                                       |
| 23    | GitHub Release / `dist` artifacts                                                                        | ⏳ Pending                                                       |

## Verification ledger (this session, head + working tree)

| Gate                                         | Command                                                       | Result                                                                   |
| -------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Typecheck (main/preload/core/tools/tests)    | `npx tsc -p tsconfig.node.json --noEmit`                      | ✅ clean                                                                 |
| Typecheck (renderer)                         | `npx tsc -p tsconfig.web.json --noEmit`                       | ✅ clean                                                                 |
| Lint                                         | `npx eslint .`                                                | ✅ clean (0 errors, 0 warnings)                                          |
| Format (custom rules + Prettier)             | `npm run format:check`                                        | ✅ 127 files clean, Prettier reports no differences                      |
| Unit + integration tests                     | `npm test`                                                    | ✅ 93/93 in 10 files                                                     |
| Stress test (150 patients / 600 patients)    | `DENTIVA_STRESS_PATIENTS=600 npx vitest run --project stress` | ✅ 8/8 (600 patients: 8.3 s total, backup of the loaded database 906 ms) |
| End-to-end against the real stack            | `node tools/run-e2e.mjs`                                      | ✅ 38/38 checks against a real SQLite file, IPC router and dev bridge    |
| Production build (main + preload + renderer) | `npm run build`                                               | ✅ Vite build succeeds (renderer 422 kB JS / 31.7 kB CSS before gzip)    |

## Environment facts (verified 2026-09-30)

| Capability                                                 | Local sandbox                                | GitHub Actions      |
| ---------------------------------------------------------- | -------------------------------------------- | ------------------- |
| Node 22 + npm install (`ELECTRON_SKIP_BINARY_DOWNLOAD=1`)  | ✅ 641 packages, exit 0                      | ✅                  |
| better-sqlite3 13 (N-API, FTS5, WAL, backup API)           | ✅ verified working                          | ✅                  |
| TypeScript typecheck of `src` + `tests` + `tools`          | ✅ clean (both tsconfigs)                    | ✅                  |
| Unit / integration / stress suites (real SQLite, Argon2id) | ✅ 101 tests                                 | ✅                  |
| Renderer build (Vite/React/TS)                             | ✅                                           | ✅                  |
| Headless Chromium (E2E + print HTML verification)          | ✅ (bundled via npm, no external CDN needed) | ✅                  |
| Electron runtime/binary download                           | ❌ blocked CDN                               | ✅                  |
| electron-builder NSIS packaging                            | ❌ Windows-only toolchain                    | ✅ `windows-latest` |
| Clean-machine install/uninstall test                       | ❌                                           | ✅ `windows-latest` |

Consequence: Windows-specific verification (installer, clean-machine install, real printer enumeration, packaged
`printToPDF`, DPI scaling at 100–200 %) is executed by the Windows CI jobs, not in the sandbox. The sandbox
verifies the whole domain layer, the renderer bundle, the print templates and the full application workflow over
the real IPC surface.

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
  system, app, resources.
- `src/main`: Electron entry point (single instance, paths, fonts, hidden print host, menus, auto-lock,
  destructive-action guards), typed IPC router with zod schemas inferred from the API contract, and the dev
  bridge that runs the same services in a browser for UI work and E2E.
- `src/preload`: `contextBridge` surface (`window.dentiva`: `invoke`, `on`, `versions`, `env`).
- `src/renderer`: design tokens + component library, application shell (sidebar PRACTICE/CLINICAL/BILLING/
  ADMINISTRATION, header with branding/clinic/date/search/notifications/user menu), and every screen:
  dashboard, patients (+ detail with timeline/chart/attachments), visits, dental chart, prescriptions,
  invoices, payments, treatments, inventory, accounting, reports, appointments, queue, referrals, staff,
  dentists, users/roles, settings centre, backup/restore, audit log, notifications, About, setup wizard,
  lock screen.
- `tests`: `unit/` (5 files), `integration/` (6 files incl. the new `reports.test.ts` catalogue sweep),
  `stress/clinic-volume.test.ts`, harness with a real database and a fake print host.
- `tools`: `dev.mjs`, `run-e2e.mjs` (38 checks), `seed-stress.mjs`, `make-icons.mjs`, `license-audit.mjs`,
  `format-check.mjs`.
- `build`: multi-resolution `icon.ico` + PNG set, generated from `icon-source.png`.
- Docs: `ARCHITECTURE.md` (ADR), `DESIGN.md`, `BUILD_STATUS.md`, `THIRD-PARTY-NOTICES.md`.

## Bugs found and fixed while building the test layers

- `reports.run('dentist_activity')` bound 16 parameters to 14 placeholders and threw
  `RangeError: Too many parameter values were provided` — every call failed. The query now uses named
  `@from`/`@to` parameters, and `tests/integration/reports.test.ts` executes **all 22 report keys** through
  `run`, `exportCsv` and `export` so a catalogue entry can never be unreachable again.
- Report CSV/print tests assert that no cell is `undefined` and that no output contains `[object Object]`,
  which closed the last `no-base-to-string` pockets in the reporting path.

## Resume point (next work session starts here)

1. `tests/ui/setup.ts` + first UI suites (Testing Library + jsdom): shell navigation, patient creation form
   validation, invoice line editor, dental chart keyboard/mouse interaction, empty/loading/error states.
2. `.github/workflows/ci.yml`: push/PR pipeline — install, typecheck, lint, `format:check`, unit +
   integration + stress tests, renderer build, E2E, artifact upload; plus the Windows job for
   `npm run dist` and the installer smoke test.
3. `build/` release assets: `EULA.txt`, `installer.nsh` (shortcuts, uninstall entry, data-preservation
   prompt), `licenses/` copy step, `THIRD-PARTY-NOTICES.txt` for the installer.
4. Docs: `README.md`, `docs/INSTALL.md`, `docs/USER-GUIDE.md`, `docs/BACKUP-RESTORE.md`, `docs/PRINTING.md`,
   `docs/TROUBLESHOOTING.md`, `docs/TEST-REPORT.md`, `docs/RELEASE-CHECKLIST.md`, `docs/REQUIREMENTS-TRACE.md`.
5. Installer build on Windows (CI) → clean-machine install test → attach artifacts to a draft GitHub release.
6. Final release gates: `npm run verify`, license audit re-run, then the human merge gate (never merge).

## Known follow-ups

- Windows-only verification (installer, printers, DPI scaling, packaged `printToPDF`) runs in CI; results must
  be pasted into `docs/TEST-REPORT.md` when the Windows job has run.
- `sql.ts` sort allow-list (`ALLOWED_SORT_COLUMNS`/`allowSortColumns`/`resolveSort`) is implemented; list
  endpoints use parameterised ORDER BY clauses directly — decide (adopt or delete) before release.
- Prettier is now a dev dependency and the single formatter; `tools/format-check.mjs` keeps the project rules
  Prettier cannot express (LF, final newline, tabs, 140-character limit excluding licence/generated files and
  Markdown tables).
