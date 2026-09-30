# Test report

Every number below was produced by running the command in the same column on
2026-09-30, against the working tree that this document ships with. Nothing in
this report is estimated.

| Layer                      | Command                                           | Result                                                                  |
| -------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| Unit                       | `npx vitest run --project unit`                   | **37 tests, 5 suites — passed** (3.3 s)                                 |
| Integration (real SQLite)  | `npx vitest run --project integration`            | **59 tests, 6 suites — passed** (32.5 s)                                |
| Interface (real renderer)  | `npm run test:ui`                                 | **23 tests, 6 suites — passed** (48.4 s)                                |
| Stress (600 patients)      | `DENTIVA_STRESS_PATIENTS=600 npm run test:stress` | **8 tests — passed** (9.1 s)                                            |
| End-to-end (IPC surface)   | `npm run test:e2e`                                | **38 checks — passed**                                                  |
| End-to-end (real Electron) | `npm run test:e2e:electron`                       | 2 Playwright specs — run by CI (Linux + Windows)                        |
| Lint                       | `npm run lint`                                    | **0 errors, 0 warnings**                                                |
| Types (main + renderer)    | `npm run typecheck`                               | **clean**                                                               |
| Formatting policy          | `npm run format:check`                            | **clean** (custom rules + Prettier)                                     |
| Production build           | `npm run build`                                   | **succeeds** (main, preload, renderer)                                  |
| Installation self-check    | `--self-check` / `--self-check-file=…`            | 3 integration tests + Playwright over real Electron (both output forms) |
| Windows installer          | CI job `windows-installer`                        | **verified on a clean runner** — see below                              |

## What each layer proves

### Unit — 37 tests

Pure rules with no database: money conversion and formatting (`formatMoney(200000)`
is `৳2,000`), date parsing and formatting across the supported formats and time
zones, the dental chart model (arches, FDI numbering, dentition switching,
findings and surfaces), the security primitives (password hashing parameters,
password policy, activation code derivation and rate-limit arithmetic), and the
IPC schema table (every one of the 175 methods has a schema, and no schema is
missing from the handler map).

### Integration — 59 tests over a real SQLite file

Real migrations, real seeding, real Argon2id hashing, real transactions — no mocks.
The suites cover:

- **Setup and activation** — schema version, STRICT tables rejecting wrong types,
  idempotent migrations, seeded reference data (roles, payment methods,
  medications, treatments, categories, printer profiles, templates, clinical
  options), activation rejected/ accepted/replay-limited, the seven setup steps in
  order, `setup.complete` refusing to finish with a missing step, and the audit
  trail the wizard writes.
- **Clinical** — registration and duplicate detection, appointment booking and
  status changes (including _arrived_ enqueueing the patient), queue ordering and
  statuses, visits with per-tooth findings validation, dental chart save/clear
  with immutable history, prescriptions with multiple medications and sections,
  treatment catalogue rules, referrals, attachments.
- **Back office** — invoices raised from the catalogue with server-computed
  totals and discounts, part payments, over-payment refused, voids, receipts,
  stock purchases and movements with negative stock refused, accounting entries
  and category totals, inventory alerts, purchase-expiry handling.
- **Permissions** — every service refuses the calls its permission catalogue
  denies, for a real non-owner session: the receptionist cannot read accounting,
  reports, the audit log or user administration; the assistant cannot void
  payments; the dentist cannot change prices; and the owner can do both.
- **Printing** — invoices render the clinic header and **no** dentist signature;
  prescriptions render the signature block with the dentist's name,
  qualifications and designations; PDF and print paths both produce documents.
- **Backup and restore** — backup writes a verified archive with a manifest and
  checksums, verification catches a corrupted archive, restore stages the archive
  and applies it on the next start, a pre-restore backup of the current data is
  always taken, attachments are restored only when requested.
- **The installation self-check** — reports a healthy unactivated installation,
  runs without a session even though the settings screen requires one, reports
  the ready clinic after setup, and changes nothing at all while doing it.

### Interface — 23 tests over the real application

Each test renders the actual application tree (providers, router, screens) against
the real core through the real IPC router, in jsdom. Only three operating-system
edges are substituted: file pickers, the print host, and the preload bridge.

- **Shell** — the activation gate refuses everything until the code is entered;
  the seven-step wizard creates a clinic and signs the owner in; lock/unlock and
  sign-out behave; the dashboard is role-aware and starts empty rather than fake.
- **Patients** — register through the form and find the record by its allocated
  code, duplicate detection, the date-range filter (newest first), search by name
  and phone.
- **Clinical** — record a finding on tooth 16 with the mouse and read it back from
  the chart; arrow-key navigation across the arch and between arches; switching to
  the primary dentition; clearing a finding keeps the history row; the prescription
  PDF contains every section plus the signature block.
- **Billing** — raise an invoice from the catalogue and check the exact amounts;
  collect a part payment and see the balance and status change; an over-payment is
  refused and writes nothing; the invoice PDF has the clinic header and no
  signature block.
- **Access** — the sidebar renders exactly the screens the signed-in role may open
  (checked against the permission catalogue, so it cannot drift); the core refuses
  the calls behind the hidden screens; the front desk sees the money cards with the
  amounts withheld instead of a leaked figure.
- **Administration** — create an account, sign in with it and confirm the granted
  role opens clinical work and is refused administration; add a dentist with a
  qualification and see it on the team list; record an expense, check the daybook
  and the summary, then edit it through the update path.

### Stress — 8 tests at 600 patients

Generates a deterministic multi-year clinic (600 patients, visits, findings,
prescriptions, invoices, payments, stock and accounting entries) and asserts the
things that fail first in a busy practice: list latency, newest-first paging,
search, dashboard, reports, money reconciliation, invoice-number uniqueness,
integrity, and backup/restore of the loaded database. Budgets are asserted, not
eyeballed: paging under 400 ms, search under 500 ms, dashboard under 2 s, reports
under 5 s. The 600-patient run completes in 9.1 s including the backup and the
staged restore.

### End-to-end

`npm run test:e2e` starts the real core bridge over the real IPC surface and walks
a complete first day: activation, the setup wizard, sign-in, a patient, an
appointment, the queue, a visit with chart findings, a prescription, an invoice, a
payment, a report export, a backup, a restore preview, an integrity check and the
dashboard — 38 assertions.

`npm run test:e2e:electron` drives the **built Electron application** with
Playwright: the real main process, the real preload bridge and the real renderer in
a throw-away data folder. It rejects a wrong activation code, activates with the
real one, completes all seven wizard steps through the interface, signs in, then
restarts the application over the same folder to prove that the activation and the
clinic's records survive. A second spec runs the binary with `--self-check` and
asserts the JSON report and exit code. This suite runs in CI (it needs the Electron
binary, so it skips itself on a machine where dependencies were installed with
`--ignore-scripts`).

## Windows installer — evidence from the clean-machine job

The `windows-installer` job runs `tools/ci/windows-check.ps1` on a fresh
`windows-latest` runner. Run 6 of the pipeline (commit `4d3649a`) verified:

| Gate                              | Evidence                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Installer and portable built      | `DentivaPro-1.0.0-Windows-x64-Setup.exe` 106.98 MB, `DentivaPro-1.0.0-Windows-x64-Portable.exe` 106.59 MB                                |
| Silent install on a clean machine | nothing installed beforehand; `C:\Users\…\AppData\Local\Programs\Dentiva Pro\Dentiva Pro.exe` and `Uninstall Dentiva Pro.exe` afterwards |
| Start Menu shortcut               | present, target `…\Programs\Dentiva Pro\Dentiva Pro.exe`                                                                                 |
| Desktop shortcut                  | present, same target                                                                                                                     |
| Uninstall entry                   | `Dentiva Pro 1.0.0` · version `1.0.0` · publisher `Shohan Khan`                                                                          |
| Licence bundle                    | `build/licenses/OPEN-SOURCE-LICENCES.txt` generated and packaged                                                                         |
| Third-party notices               | `resources/THIRD-PARTY-NOTICES.txt` present in the packaged application                                                                  |

**Run 19 (commit `115320a`, run
[`36720456407`](https://github.com/kshohanservice-glitch/dentiva-pro-source/actions/runs/36720456407))
passes every Windows gate.** Run 16 was the first to do so; run 19 re-ran the same
checks with the uninstall assertions strengthened after a flake (the check could
outrun the uninstaller's temporary copy — see `docs/BUILD_STATUS.md`). Its evidence
annotation reads:

```
installer: DentivaPro-1.0.0-Windows-x64-Setup.exe (106.98 MB)
portable:  DentivaPro-1.0.0-Windows-x64-Portable.exe (106.59 MB)
start menu shortcut -> C:\Users\runneradmin\AppData\Local\Programs\Dentiva Pro\Dentiva Pro.exe
desktop shortcut  -> C:\Users\runneradmin\AppData\Local\Programs\Dentiva Pro\Dentiva Pro.exe
uninstall entry: Dentiva Pro 1.0.0 · 1.0.0 · Shohan Khan
self-check (default):   state=activation_required licence=False schema=4
                        database=C:\Users\runneradmin\AppData\Roaming\Dentiva Pro\data\dentiva.sqlite stdout=yes
self-check (relocated): state=activation_required licence=False schema=4
                        database=D:\a\_temp\dentiva-relocated-data\data\dentiva.sqlite stdout=yes
self-check (broken data folder) correctly reported ok=false
data after uninstall: 5 files kept in C:\Users\runneradmin\AppData\Roaming\Dentiva Pro
```

| Gate                                    | Evidence                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installer and portable built            | 106.98 MB and 106.59 MB, built from this commit                                                                                                               |
| Silent install on a clean machine       | nothing installed beforehand; `…\Programs\Dentiva Pro\Dentiva Pro.exe` and its uninstaller afterwards                                                         |
| Start Menu and desktop shortcuts        | both present, both pointing at the installed executable                                                                                                       |
| Uninstall entry registered (`HKCU`)     | `Dentiva Pro 1.0.0` · version `1.0.0` · publisher `Shohan Khan`                                                                                               |
| Licence bundle and third-party notices  | generated at build time and present in the packaged resources                                                                                                 |
| Healthy self-check, default data folder | exit 0, `ok: true`, `packaged: true`, database inside `%APPDATA%\Dentiva Pro`                                                                                 |
| Relocated data folder                   | exit 0, `ok: true`, database under `…\dentiva-relocated-data` — `DENTIVA_DATA_DIR` moves the whole folder                                                     |
| Broken installation is reported         | a data folder whose parent is a file: exit **1**, `ok: false`, with a readable reason                                                                         |
| Uninstall removes the application       | executable, uninstaller, Start Menu shortcut, desktop shortcut and registry entry — all asserted after waiting for the uninstaller's temporary copy to finish |
| Uninstall keeps the clinic's records    | 5 files, including `data\dentiva.sqlite` and a marker file written just before the uninstall, still present                                                   |

The self-check reports `state=activation_required` on purpose: it runs on a machine
that has never been set up, which is exactly what a clean-machine check should see.
Two defects the pipeline found on the way are recorded in `docs/BUILD_STATUS.md`
(the packaged suite that had never actually run, and the silent-uninstall dialog).

## What is deliberately not automated

- **Physical printers.** Printing is verified as rendered HTML/PDF output, not by
  sending paper through a device. `Test print` in Settings is the manual check.
- **Screen-reader and colour-contrast audits.** The design system encodes contrast
  and focus rules, and every interactive element is a real button/input, but no
  automated accessibility scanner is wired in.
- **DPI scaling and very large monitors.** The layout is built on rem/px tokens
  with responsive grids and is reviewed manually at 100 %, 125 %, 150 % and 200 %
  scaling and at 1366×768 up to 3840×2160; there is no automated visual regression
  suite.
- **Windows installer behaviour locally.** The Linux development sandbox cannot run
  NSIS or Wine. The installer is built and tested by the Windows CI job, which
  installs it silently, checks the shortcuts and the uninstall entry, runs
  `--self-check` on the installed copy, then uninstalls and proves the clinic's data
  survives.

## Reproducing this report

```bash
npm ci
npm run lint && npm run typecheck && npm run format:check
npm test                       # unit + integration, 101 tests
npm run test:ui                # 24 interface tests
DENTIVA_STRESS_PATIENTS=600 npm run test:stress
npm run build && npm run test:e2e
npm run test:e2e:electron      # needs the Electron binary
```

## Post-merge startup regression (2026-09-30)

A real installed Windows GUI launch of the merged build failed before app readiness.
The earlier self-check green result did **not** cover normal bootstrap. This branch
adds a Windows CI check that starts the installed executable normally and requires
an application window and a surviving process. Local Linux: typecheck, lint,
format, 102 unit/integration tests (including hostile sort/direction/search),
24 UI tests and production build passed. New Windows CI and real-machine
acceptance have not yet passed; release remains blocked.
