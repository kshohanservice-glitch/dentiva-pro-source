# Dentiva Pro — Build Status

> Single source of truth for resuming work. Update at the end of every work session.

| Field | Value |
| --- | --- |
| Current phase | Phase 3–7 complete (data layer, seed, every core service) → Phase 9 (IPC router) is next |
| Version | 1.0.0 |
| Branch | `arena/01a0f0ee-dentiva-pro-source` |
| Base commit | `b06410d` (main, initial repository state) |
| Last updated | 2026-09-30 |

## Phase tracker

| Phase | Description | Status |
| --- | --- | --- |
| 0 | Repository inspection | ✅ Complete |
| 1 | Architecture + ADR (`docs/ARCHITECTURE.md`) | ✅ Complete |
| 2 | Shared contracts (`src/shared`: types, permissions, money, dates, IPC surface) | ✅ Complete |
| 3 | Database schema, migrations, connection + SQL helpers | ✅ Complete |
| 4 | Core services: patients, visits, dental chart, prescriptions, treatments, referrals, appointments, queue | ✅ Complete |
| 5 | Core services: invoices, payments, accounting, inventory | ✅ Complete |
| 6 | Core services: users, roles, auth, staff, dentists, attachments | ✅ Complete |
| 7 | Core services: seed, backups, setup/activation, app shell, search, dashboard, reports, print, system | ✅ Complete |
| 8 | Integration tests against a real SQLite file (41 passing) | ✅ Complete for the core layer |
| 9 | zod validation + main-process IPC router (175 methods) | ⏳ Next |
| 10 | Preload bridge + dev bridge (Chrome preview outside Electron) | ⏳ Pending |
| 11 | Design system (tokens + components) | ⏳ Pending |
| 12 | Renderer screens (dashboard, patients, clinical, billing, admin) | ⏳ Pending |
| 13 | Setup wizard + activation UI | ⏳ Pending |
| 14 | Printing UI (preview, printer profiles, templates) | ⏳ Pending |
| 15 | Global search + notification centre | ⏳ Pending |
| 16 | UX refinement pass on every screen | ⏳ Pending |
| 17 | Testing: unit, UI, E2E, stress | ⏳ Pending |
| 18 | Security audit (RBAC guards vs catalogue, password, activation, destructive ops) | 🔄 Continuous — first sweep done, re-run after every service change |
| 19 | Installer (NSIS) + portable build | ⏳ Pending |
| 20 | Clean-machine installation test | ⏳ Pending (requires Windows runner) |
| 21 | Release audit + requirements traceability | ⏳ Pending |
| 22 | Production build + final artifact validation | ⏳ Pending |
| 23 | GitHub Release / `dist` artifacts | ⏳ Pending |

## Environment facts (verified 2026-09-30)

| Capability | Local sandbox | GitHub Actions |
| --- | --- | --- |
| Node 22 + npm install (`ELECTRON_SKIP_BINARY_DOWNLOAD=1`) | ✅ 641 packages, exit 0 | ✅ |
| better-sqlite3 13 (N-API, FTS5, WAL, backup API) | ✅ verified working | ✅ |
| TypeScript typecheck of `src/shared` + `src/core` + tests | ✅ clean (`tsc -p tsconfig.node.json --noEmit`) | ✅ |
| Integration tests (real SQLite file, migrations, seed, Argon2id) | ✅ 41/41 (`vitest run --project integration`) | ✅ |
| Renderer build (Vite/React/TS) | ✅ | ✅ |
| Headless Chromium (UI + PDF verification) | ✅ (bundled via npm, no external CDN needed) | ✅ |
| Electron runtime/binary download | ❌ blocked CDN | ✅ |
| electron-builder NSIS packaging | ❌ Windows-only toolchain | ✅ `windows-latest` |
| Clean-machine install/uninstall test | ❌ | ✅ `windows-latest` |

Consequence: Windows-specific verification (installer, clean-machine install, real printer enumeration, packaged
`printToPDF`) is executed by the Windows CI jobs, not in the sandbox. The sandbox verifies the entire domain
layer, the renderer, print-template layout and PDF generation through a headless Chromium harness that runs the
real production code paths.

## What exists now

- `src/shared` (9 modules): app info, money (integer paisa), dates/zones, errors, constants, permissions
  (catalogue + presets), dental numbering, domain types, and the 175-method typed IPC contract.
- `src/core/db`: forward-only migrations (`0001_baseline`, `0002_performance_indexes`, `0003_referrals`,
  `0004_searchable_fts`), connection pragmas, integrity checks, FTS rebuild, SQL helpers.
- `src/core/util`: rotating logger, id/sequence helpers, safe file storage, stored-entry ZIP writer.
- `src/core/security`: Argon2id passwords + policy, offline activation (digest only), session manager with
  auto-lock.
- `src/core/services` (30 files): audit, settings, notification, patient, visit, dental, prescription,
  treatment, referral, appointment, invoice, payment, accounting, accounting-categories, inventory, queue,
  user, auth, staff, dentist, attachment, backup, search, dashboard, resource, setup, system, app, report,
  print.
- `src/core/seed.ts`: system roles, clinic row, payment methods, clinical options, medications, treatment
  catalog, accounting + inventory categories, printer profiles, print templates.
- `src/core/container.ts`: composition root (one database, one logger, one session, one context) with
  injectable clock, printer host and runtime info.
- `tests/integration`: harness + 41 tests (setup/auth/RBAC, patients/visits/chart/prescriptions/plans/
  referrals/appointments/queue, invoices/payments/accounting, inventory, reports, printing, search,
  dashboard, app/system status, master data, settings audit).

## Resume point (next work session starts here)

1. `src/main` — Electron entry point: single instance, data paths, logger, container bootstrap, window
   management, session lock/logout, auto-lock, menu, shortcuts, protocol handler.
2. `src/main/ipc` — zod schemas for all 175 `API_METHOD_NAMES` entries plus the router that dispatches to
   core services, converts `AppError` into the wire envelope, and re-checks permissions.
3. `src/main/print` — hidden `BrowserWindow` adapter implementing `PrintHostPort` (`toPdf`, `send`,
   `listPrinters`, `reveal`) plus the embedded font CSS (Inter + Noto Sans Bengali as data URLs).
4. `src/preload` — `contextBridge` surface for `window.dentiva` (invoke + event subscription) and the dev
   bridge on `DENTIVA_DEV_BRIDGE_PORT` (default 4319) so the renderer can run in a browser for UI checks.
5. Renderer: design tokens, design-system components, then the screens (dashboard, patients, clinical,
   billing, inventory, accounting, reports, administration) and the setup/activation wizard.
6. Then the remaining test layers (unit, UI, E2E, stress), docs, CI workflow, installer and release gates.

## Known follow-ups

- `build/icons/icon.ico` (multi-resolution) still pending; `build/icon-source.png` exists.
- Tool scripts referenced by `package.json` are not written yet:
  `tools/{dev,run-e2e,make-icons,license-audit,seed-stress,format-check}.mjs`.
- `build/{EULA.txt,installer.nsh,licenses/}` and `tests/ui/setup.ts` are not written yet.
- `.github/workflows` (Windows CI: typecheck, tests, renderer build, installer, E2E) is not written yet.
- `sql.ts` sort allow-list (`ALLOWED_SORT_COLUMNS`/`allowSortColumns`/`resolveSort`) is implemented but the
  list endpoints do not use it yet — either adopt it or delete it before release.
- Superseded by the items above: the report + print services are complete (this closed the last gap in the
  core service list).

## Current task

Core layer complete and verified end-to-end on a real database: **41/41 integration tests pass** and
`tsc -p tsconfig.node.json --noEmit` is clean. Work continues with the main-process IPC layer (`src/main`),
then the preload bridge and the renderer. Nothing is committed yet — every file is untracked on the working
branch, and the first commit is taken as soon as the main process can open the database through the real
container.
