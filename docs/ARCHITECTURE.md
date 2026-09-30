# Dentiva Pro — Architecture Decision Record

> Status: **Accepted** · Applies to: Dentiva Pro 1.0.0 (final production release) · Target: Windows 10/11 x64, offline

This document records the architecture decisions for Dentiva Pro, why they were made, what alternatives were
considered, and the constraints each decision imposes on implementation and testing. It is binding for the
codebase: deviations must be recorded here first.

---

## 1. Context and constraints

| Constraint                                        | Consequence                                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Commercial product for real clinics in Bangladesh | Production-quality code, no placeholder behaviour, audit trail, safe data handling              |
| Completely offline                                | No cloud, remote auth, online licensing, web fonts, telemetry or OCR/AI APIs                    |
| Windows desktop                                   | Native printer discovery, Windows dialogs, NSIS installer, `.ico` application icon, DPI scaling |
| BDT currency, Bengali Unicode content             | Integer minor units (paisa) and bundled Bengali-capable fonts                                   |
| Large data volumes (10k+ patients, 50k+ visits)   | Indexed schema, paginated lists, no N+1 queries                                                 |
| Patient data is sensitive                         | Local-only storage, hashed credentials, RBAC enforced in the service layer, audit log           |

## 2. Selected stack

| Layer            | Selection                                                                                                               | Notes                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Desktop shell    | **Electron 39** (Chromium 142 / Node 22)                                                                                | Mature Windows packaging, Chromium print engine, native dialogs and printers |
| UI               | **React 19 + TypeScript 5.9**, Vite 7 build, React Router 7                                                             | Fast dev loop, single renderer codebase                                      |
| Styling          | **Hand-authored design-system CSS** with token layer                                                                    | No CSS framework; full control of the clinical visual language               |
| Icons            | **lucide-react** (ISC)                                                                                                  | One coherent 2px-stroke icon set                                             |
| Database         | **SQLite via better-sqlite3 13** (N-API)                                                                                | Embedded, ACID, WAL, foreign keys, FTS5, online backup API                   |
| Domain layer     | Framework-free TypeScript in `src/core`                                                                                 | Business rules never live in React components                                |
| Validation       | **zod 4** at every IPC boundary + service entry point                                                                   | Rejects malformed payloads before they reach SQL                             |
| Password hashing | **Argon2id via hash-wasm** (WASM, MIT)                                                                                  | Memory-hard KDF, no native build step, works offline                         |
| Archive/backup   | **fflate** (MIT) for zip container                                                                                      | Pure JS, streaming-friendly, no native code                                  |
| Printing         | Chromium print pipeline driven from the main process                                                                    | `printToPDF` for PDF, `webContents.print` for printers                       |
| Installer        | **electron-builder 26 → NSIS x64** (+ portable target)                                                                  | Start-menu/desktop shortcuts, clean uninstall, data preservation             |
| Tests            | **Vitest** (unit/integration/ui), **Playwright-Electron** (Windows E2E), headless-Chromium harness (cross-platform E2E) | See §9                                                                       |
| CI/CD            | **GitHub Actions** (ubuntu quality gate + windows packaging/E2E)                                                        | Reproducible artifacts from a clean checkout                                 |

### Alternatives considered and rejected

| Alternative                                     | Why rejected                                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Tauri + Rust                                    | Great footprint, but printer geometry and Windows printer control are harder than Chromium's, and it adds a second toolchain |
| .NET WPF / WinUI                                | Strong Windows integration, but a second UI language, slower design-system iteration and no shared print templates           |
| Web app + local server (PWA)                    | Cannot reliably drive Windows printers or page geometry, and installs poorly as a desktop product                            |
| Node `node:sqlite` built-in                     | Still experimental and lacks the mature backup/restore ergonomics of better-sqlite3                                          |
| `sql.js` (WASM SQLite)                          | In-memory database: durability and integrity guarantees are far weaker for clinical data                                     |
| Renderer with `nodeIntegration: true` doing SQL | Unacceptable security posture; business rules must not be bypassable from the UI                                             |
| Redux/Zustand-style global store                | The database is the source of truth; a thin query layer with explicit invalidation avoids stale data                         |
| Tailwind/MUI design system                      | Would dictate a generic visual language and a large dependency surface; the product needs a bespoke system                   |

## 3. Process architecture

```
┌──────────────────────────── Electron main process (Node 22) ─────────────────────────────┐
│  src/main        windows, menu/shortcuts, native dialogs, printers, single-instance,     │
│                  crash detection, IPC router (typed, permission-gated)                   │
│  src/core        domain services: patients, visits, dental chart, prescriptions,         │
│                  invoices, payments, inventory, accounting, appointments, queue, staff,  │
│                  users/RBAC, audit, notifications, search, reports, backup/restore,      │
│                  print templates, settings        ← all business rules live here         │
│  better-sqlite3  embedded SQLite (WAL, FK, FTS5) in the per-user data folder             │
└──────────────────────────────────────────────┬───────────────────────────────────────────┘
                      contextBridge (src/preload) — no Node access in the renderer
┌──────────────────────────────────────────────┴───────────────────────────────────────────┐
│  src/renderer    React 19 UI: design system, shell (sidebar/header/search/alerts),       │
│                  every screen, print preview, setup wizard, lock screen                   │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

The renderer is untrusted: every call arrives at the IPC router, is schema-validated, is checked against the
**live session's permission set**, and only then reaches a service. Services re-check permissions for
privileged operations (defence in depth) and write audit entries inside the same SQLite transaction as the
data mutation.

## 4. Database architecture

- One SQLite file per installation: `<userData>/data/dentiva.sqlite` (WAL, `synchronous=FULL`, `foreign_keys=ON`).
- Schema is versioned by a `schema_migrations` table; migrations are forward-only, ordered, idempotent and run
  inside a transaction on startup. Fresh installs apply the consolidated baseline then mark all migrations applied.
- Money is stored as **integer paisa** (`*_paisa` columns). No floating point arithmetic is ever used for money.
- Timestamps are ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SS.sssZ`); business dates are local calendar dates
  (`YYYY-MM-DD`) with times (`HH:MM`) where relevant, so a report for "1 September" means the clinic's local day.
- Deletion policy: clinical/financial records use soft deletion (`deleted_at`) so history is preserved and
  auditable; hard deletion exists only where it is safe (attachments, drafts) and requires explicit permission.
- Referential integrity: `ON DELETE RESTRICT` for clinical/financial links (never silently cascade patient
  history), `ON DELETE CASCADE` only for owned child rows (e.g. invoice items, prescription items, role links).
- Indices are created for every foreign key and every column used by filtering, sorting or search
  (names, phone, codes, dates, statuses, stock and expiry).
- FTS5 virtual tables back the global search over patients, treatments, medications and inventory.

## 5. Rendering strategy

- The renderer is a normal React SPA (hash-free, in-app router) built by Vite; production loads `dist/renderer`
  from the packaged app, development loads the Vite dev server.
- Server state is fetched through a typed bridge with explicit request caching and invalidation on mutation;
  no global client store duplicates clinical data.
- Long lists (patients, invoices, inventory) use windowed rendering and SQL `LIMIT/OFFSET` with indexed
  ordering, so memory stays flat regardless of table size.
- Error boundaries isolate screen failures; every data view implements loading (skeleton), empty and error
  states explicitly.

## 6. Printing / PDF strategy

- Print documents are generated **in the main process** by pure template functions in `src/core/printing`
  that receive already-authorised data. Templates emit a self-contained HTML document (fonts and logo embedded
  as data URLs) so a print job can never reach the network.
- Physical printing: hidden `BrowserWindow` → `webContents.print()` with the profile's page geometry
  (custom micron sizes for thermal/mini printers, standard sizes for A4/A5), `printBackground`, and margins.
- PDF: the same hidden window → `webContents.printToPDF()` — identical layout engine, identical output.
- Print preview: the generated PDF is displayed in-app (Electron PDF viewer via `<webview>`), with automatic
  fallback to a dedicated preview window if the platform PDF viewer is unavailable. Preview and print therefore
  use the same layout engine, which is how "what you see is what prints" is guaranteed.
- Printer profiles (paper width/height, margins, orientation, scale, copies, thermal mode) are stored per
  clinic; a profile may be bound to a Windows printer queue by name.

## 7. Backup / restore strategy

- Backup = `better-sqlite3` online backup of the live database + attachments + a JSON manifest, written into a
  single `.dentivabak` zip (fflate). The zip never overwrites an existing file: names carry
  `DentivaPro_Backup_YYYY-MM-DD_HH-mm-ss`.
- Every backup is verified immediately: the archive is re-opened, the manifest parsed, the embedded database
  opened read-only and `PRAGMA integrity_check` executed.
- Restore = validate → show metadata → explicit confirmation → **automatic pre-restore backup** → atomic
  replacement (write to temp, fsync, rename, rollback on failure) → integrity check → audit → relaunch.
- A failed restore leaves the original database untouched; the pre-restore backup is preserved and reported.

## 8. Security strategy

- Credentials: Argon2id (64 MiB, t=3, p=1, 16-byte random salt), constant-time verification, per-user lockout
  counters with exponential backoff, and password policy enforcement in the service layer.
- Sessions live in the main process only; the renderer holds an opaque session id and permission list. Idle
  auto-lock (configurable 5/10/15/30 minutes, or disabled by the owner) clears the session and re-authenticates.
- Authorisation: granular permission keys (`patient.create`, `payment.delete`, `backup.restore`, …) assigned to
  roles; the owner role is the only implicit superuser. Least privilege is the default for new users.
- Activation: the product code is never stored in plaintext. Only a PBKDF2-SHA512 (high iteration) derived
  digest with an application pepper is compiled in; comparison is constant-time. Activation state is written to
  a machine-bound, HMAC-signed record so casual copying of the data folder does not transfer activation.
  The limitation that a determined attacker with the binary can analyse any local-only scheme is acknowledged
  in the user documentation; the goal is to defeat casual extraction, not to claim mathematical secrecy.
- Input safety: parameterised SQL everywhere, zod validation at boundaries, attachment filenames sanitised and
  stored under generated names (path traversal impossible by construction), file type/size allow-lists,
  sanitised error messages returned to the UI (details go to the local log only).

## 9. Testing strategy

| Layer                       | Tooling                                                    | Coverage                                                                                                              |
| --------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Unit                        | Vitest (node)                                              | money, dates, validation, permissions, calculations, print templates, activation, password policy                     |
| Integration                 | Vitest + real SQLite in temp dirs                          | every service against a real database: clinical and billing chains, inventory→accounting, RBAC matrix, backup→restore |
| UI component                | Vitest + jsdom + Testing Library                           | forms, tables, modals, empty/loading/error states, keyboard access                                                    |
| End-to-end (cross-platform) | Headless Chromium + real core services over the dev bridge | full workflows, print/PDF output, screenshots for visual QA on any runner                                             |
| End-to-end (Windows)        | Playwright-Electron on `windows-latest`                    | packaging flows: real IPC, print pipeline and file dialogs (`--silent-print`)                                         |
| Stress                      | Vitest, opt-in (`npm run test:stress`)                     | Large clinics (thousands of patients, visits and records) with timing assertions                                      |

The installer is built only after the quality gate passes, and the produced `.exe` is exercised by the Windows
E2E job (install → first run → activation → setup → core workflow → uninstall).

## 10. Build / release strategy

- `main` is protected by workflow: work happens on topic branches merged through pull requests that must pass CI.
- CI: `quality` (ubuntu: typecheck, lint, unit+integration+UI tests, renderer build), `windows-e2e`
  (Playwright-Electron workflows on Windows), `package` (electron-builder NSIS + portable artifacts, uploaded
  as workflow artifacts).
- Release: a `v*` tag triggers the release workflow which rebuilds from a clean checkout, produces
  `DentivaPro-1.0.0-Windows-x64-Setup.exe`, `…-Portable.exe`, `SHA256SUMS.txt`, third-party notices and the
  test report, and publishes them to a GitHub Release. The owner authorises the release; the pipeline never
  merges or tags on its own.

## 11. Consequences and known limitations

- Electron increases installer size (~90–120 MB). Accepted: it buys a production print engine, Windows printer
  integration, PDF fidelity and a single UI codebase.
- Windows-only packaging: Linux/macOS builds of the shell are not produced. The domain layer and renderer remain
  platform-neutral so they can be tested on any runner.
- SQLite is single-writer: writes are wrapped in short transactions and long-running work (backup, reports) is
  chunked; the app is designed for the concurrency profile of a single clinic workstation (plus optional
  read-only sharing of a backup file).
- No formal accounting-compliance claim is made; the accounting module is a practical income/expense ledger
  for a dental clinic, and is documented as such.
