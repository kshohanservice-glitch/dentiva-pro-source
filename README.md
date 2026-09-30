# Dentiva Pro

Offline desktop practice-management software for dental clinics in Bangladesh.

Dentiva Pro records patients, treatments, prescriptions, bills, payments, stock
and accounts in one place, prints the documents a clinic hands to a patient, and
keeps everything on the clinic's own computer. There is no cloud service, no
telemetry, no advertising and no online dependency of any kind: the application
works with the network cable unplugged, for years.

- Money in **৳ (BDT)**, English interface, Bengali Unicode text accepted everywhere.
- Adult **and** pediatric dental chart with FDI numbering, per-tooth findings,
  surfaces, mobility, periodontal charting and an immutable history of every change.
- Multi-medication **prescriptions** with configurable C/C, O/E, R/E and advice
  sections, a dentist signature block with credentials, and a premium print layout.
- **Invoices and payments** (Cash, Bank, Card, bKash, Nagad, Rocket, Upay, Other),
  part payments, voids, refunds and receipts — invoices carry the clinic header
  only, prescriptions carry the dentist's signature.
- **Inventory** with batches, expiry, low-stock alerts and stock movements.
- **Accounting** with income, expenses, categories, periods and daybook reports.
- **Reporting** across clinical and financial activity, exportable to CSV/PDF.
- **Appointments, queue management and referrals**, staff and dentist records,
  granular **roles and permissions** enforced in the core (not just hidden in the UI),
  an **audit log**, a **notification centre** and a **backup/restore** system with
  verification and a pre-restore safety copy.

## Requirements

| Item    | Minimum                                                  |
| ------- | -------------------------------------------------------- |
| Windows | 10 or 11, 64-bit                                         |
| Memory  | 4 GB RAM (8 GB recommended)                              |
| Disk    | 500 MB free, plus room for the clinic's data and backups |
| Display | 1366 × 768 or larger; 100–200 % DPI scaling supported    |
| Network | None — the application never needs the internet          |

A portable `.exe` is produced as well, for running from a USB drive without
installing.

## Install

1. Run `DentivaPro-1.0.0-Windows-x64-Setup.exe` and follow the installer.
2. Start **Dentiva Pro** from the Start Menu or the desktop shortcut.
3. Enter the activation code supplied with your licence.
4. Complete the seven-step setup wizard: clinic profile, dentists, preferences,
   the administrator account, review and finish.
5. Sign in with the administrator account you created.

Full instructions, including silent installation for IT departments, are in
[docs/INSTALL.md](docs/INSTALL.md).

## Where your data lives

Everything the clinic owns is kept under one folder in the Windows user profile:

```
%APPDATA%\Dentiva Pro\
  data\dentiva.sqlite     the clinic database
  attachments\            x-rays, photos, scanned documents
  backups\                verified .dentivabak backups
  logs\                   rotating application logs
  config\                 machine id, window state, activation record
```

Uninstalling the application never deletes this folder. Set the environment
variable `DENTIVA_DATA_DIR` to keep the folder somewhere else (for example a
mapped drive) — see [docs/INSTALL.md](docs/INSTALL.md).

## Backups

The clinic is responsible for its own backups, and Dentiva Pro makes that easy:
scheduled automatic backups, a manual **Back up now** button, verification of
every archive, restore with a mandatory pre-restore safety copy, and an
integrity check after the restore. Read
[docs/BACKUP-AND-RESTORE.md](docs/BACKUP-AND-RESTORE.md) and keep at least one
copy of the backup folder off the clinic computer.

## Documentation

| Document                                                 | What it covers                                           |
| -------------------------------------------------------- | -------------------------------------------------------- |
| [docs/INSTALL.md](docs/INSTALL.md)                       | Installing, silent install, portable use, activation     |
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md)                 | The day-to-day workflows of the clinic                   |
| [docs/BACKUP-AND-RESTORE.md](docs/BACKUP-AND-RESTORE.md) | Backup policy, restore, disaster recovery                |
| [docs/PRINTING.md](docs/PRINTING.md)                     | Prescription, invoice and report printing                |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)       | What to do when something looks wrong                    |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)             | How the application is built (for maintainers)           |
| [docs/TEST-REPORT.md](docs/TEST-REPORT.md)               | What was tested, how, and with what result               |
| [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md)   | Every gate a release must pass                           |
| [docs/BUILD_STATUS.md](docs/BUILD_STATUS.md)             | Live status of the build (kept current while developing) |
| [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)         | Every open-source component and its licence              |

## Development

```bash
npm ci                # Node 22
npm run dev           # Vite dev server + Electron, hot reload
npm run verify        # lint, typecheck, unit/integration/UI tests, production build
npm run test:all      # unit + integration + UI + end-to-end
npm run test:stress   # 150-patient clinic (DENTIVA_STRESS_PATIENTS=600 for CI)
npm run dist          # Windows installer + portable build (needs Windows or Wine)
```

The application is Electron, React and TypeScript over a local SQLite database
(better-sqlite3, FTS5 full-text search). Business rules live in `src/core`, the
IPC surface in `src/shared/api.ts`, the windows in `src/main`, and the interface
in `src/renderer`. Nothing in the renderer is trusted: every rule is enforced
again in the core, including permissions.

The build also accepts `--self-check`, which opens the clinic database, runs the
integrity checks and prints a JSON report before exiting — used by the release
pipeline against the freshly installed application, and by support.

## Licence and support

Dentiva Pro is commercial software, © 2026 Shohan Khan. The end-user licence
agreement is [build/EULA.txt](build/EULA.txt) and is shown by the installer.
Third-party components are used under free and open-source licences; the full
list and texts ship with the application and are reproduced in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Created by **Shohan Khan** — helloiamshohan@gmail.com
