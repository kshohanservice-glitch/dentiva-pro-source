# Dentiva Pro — master audit matrix (OPEN)

This is a **coverage inventory**, not a certificate of completion. The full
original application specification is not present as a standalone file in this
checkout; the closest source is `docs/REQUIREMENTS-TRACE.md` (42 groups), the
shared API/types/constants and the owner's extended audit request. Cross-check
that request with this inventory before release. "Automated" means a test exists
for at least one path, **not** every control, resolution, role or error state.

| Area / requirement                           | UI                                                              | Service and IPC                                         | Data                            | Authorization                  | Existing evidence                | Manual acceptance / status                                |
| -------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------- | ------------------------------ | -------------------------------- | --------------------------------------------------------- |
| Dashboard metrics, charts, actions           | dashboard.tsx                                                   | dashboard-service; dashboard.get                        | invoices, appointments, visits  | role-filtered cards            | UI access, E2E                   | widgets, role variants, scaling **OPEN**                  |
| Patient list, profile, timeline, attachments | patients, patient-detail                                        | patient-, attachment-service; patients._, attachments._ | patients, contacts, attachments | patient/medical permissions    | clinical + patients UI, stress   | CRUD, date presets, keyboard, restart **OPEN**            |
| Patient selection in linked forms            | shared forms.tsx, invoices, visits, prescriptions, appointments | patients.quickSearch                                    | patients, downstream FK         | patient.view + form permission | invoice UI keyboard/mouse test   | all linked forms, scroll/z-index on Windows **OPEN**      |
| Appointments and queue                       | appointments, queue                                             | appointment-, queue-service                             | appointments, queue_entries     | appointment/queue permissions  | clinical IT, IPC E2E             | day/week/month, status transitions **OPEN**               |
| Visits and dental chart                      | visits, dental-chart                                            | visit-, dental-service                                  | visits, findings, tooth history | clinical permissions           | clinical IT/UI                   | pediatric numbering, history/restart **OPEN**             |
| Treatments, plans, referrals                 | treatments, referrals                                           | treatment-, referral-service                            | catalogue, plans, referrals     | clinical permissions           | clinical IT/UI                   | every catalog/referral state **OPEN**                     |
| Prescriptions and medicines                  | prescriptions                                                   | prescription-, print-service                            | prescriptions, items            | prescription permissions       | clinical IT/UI                   | multiple medicines, real A4/A5/thermal/mini **OPEN**      |
| Invoice math, links and print                | invoices                                                        | invoice-, print-service                                 | invoices, lines                 | billing permissions            | backoffice IT, billing UI        | all edits/discounts, hardware/PDF **OPEN**                |
| Payment methods, void and receipt            | payments                                                        | payment-service                                         | payments, invoices              | financial permissions          | backoffice IT, billing UI        | every method, totals, refund flow **OPEN**                |
| Stock, batches and suppliers                 | inventory                                                       | inventory-, resource-service                            | items, batches, movements       | inventory permissions          | backoffice IT, stress            | expiry/returns/damaged workflow **OPEN**                  |
| Accounts, periods and reports                | accounting, reports                                             | accounting-, report-service                             | transactions, periods           | finance/report permissions     | backoffice + report IT/UI        | date ranges, every export/print **OPEN**                  |
| Staff, dentists, users and roles             | staff, users                                                    | staff-, dentist-, user-service                          | staff, dentists, users, roles   | owner/admin and role grants    | administration UI, backoffice IT | all roles, direct IPC probes **OPEN**                     |
| Clinic/settings and print preferences        | settings                                                        | settings-, setup-, print-service                        | settings, profiles              | settings permissions           | setup UI/IT                      | save/reload/restart every field **OPEN**                  |
| Backup, restore and recovery                 | backup                                                          | backup-, system-service                                 | SQLite + attachments            | backup permissions             | restore IT, stress               | corrupt file and real restart **OPEN**                    |
| Audit log                                    | audit                                                           | audit-service                                           | audit_events                    | audit permission               | backoffice IT, E2E               | actor/event completeness **OPEN**                         |
| Setup, activation and auth                   | gate, setup-wizard, change-password                             | setup-, auth-, activation services                      | activation, users, sessions     | bootstrap/owner                | setup IT/UI, packaged E2E        | real machine/wizard/resume **OPEN**                       |
| Navigation, search, notices, About           | layout, about                                                   | search-, notification-service                           | FTS, notifications              | result-level guards            | backoffice IT, UI shell          | every target/menu/key action **OPEN**                     |
| Electron lifecycle, IPC, file access         | main/index, IPC router, preload                                 | router + ports                                          | data directory                  | schema + service checks        | packaged Linux/Windows CI        | real installed GUI and OS file picker **OPEN**            |
| Installer, portable, uninstall               | Windows NSIS                                                    | windows-check.ps1                                       | user data                       | OS user context                | CI 36731076623                   | real Windows install, manual UI and preservation **OPEN** |

For **each row**, the remaining manual protocol is: load, display, interact,
create/read/update/delete where applicable, search/filter/sort/page, save,
reload, restart, restricted-role attempt, empty/loading/error/success state,
keyboard access and visual check at the specified resolutions and DPI levels.
No row is marked complete by the inventory alone. Detailed prior mapping and
automated coverage: `docs/REQUIREMENTS-TRACE.md`, `docs/TEST-REPORT.md`.

## Cross-cutting verification still open

- Screen-by-screen packaged Windows review at 1366×768, 1600×900, 1920×1080,
  2560×1440 and 3840×2160; 100/125/150/175/200% DPI.
- Physical prescription/invoice printing on clinic printers and paper sizes;
  software-generated HTML/PDF tests are not physical-print evidence.
- All interactive controls, RBAC presets and settings after restart; full
  backup→modify→restore→restart; normal-error and recovery states.
- Download new exact-commit artifacts and compute SHA-256, then owner acceptance.

## Real Windows acceptance status

The 44-step item-by-item evidence ledger and all 25 required resolution × DPI
combinations are in `WINDOWS-ACCEPTANCE-LEDGER.md`. Every unexecuted interactive
Windows entry is **NOT TESTABLE in this workspace**, not PASS. The settings save
failure and invoice edit paths found in the source audit have code and regression
tests, but this does not close the manual gates.
