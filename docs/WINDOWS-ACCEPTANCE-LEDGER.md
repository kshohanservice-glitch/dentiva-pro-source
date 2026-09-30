# Windows real-user acceptance ledger — release BLOCKED

Status refers to **real installed Windows GUI acceptance**, not Linux component
or packaged E2E tests. This workspace is Linux and has no interactive Windows
session, configured display-scaling controls or physical printer. CI is a clean
Windows runner, but its scripted installation/startup check does not perform the
44-step interactive workflow. `NOT TESTABLE` means not executable here, **not**
passed. Owner or a Windows testing agent must enter dated, machine-identifiable
evidence for each row before changing its status to PASS.

| #   | Real-user action          | Status       | Available related evidence / missing observation                                          |
| --- | ------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| 1   | Clean install             | NOT TESTABLE | CI clean-runner silent install; owner interactive install pending                         |
| 2   | Normal launch             | NOT TESTABLE | CI `windows-check.ps1` verifies window and process alive; user-visible inspection pending |
| 3   | Activation                | NOT TESTABLE | Linux packaged Playwright, not installed Windows GUI                                      |
| 4   | Setup wizard              | NOT TESTABLE | Linux packaged Playwright, not installed Windows GUI                                      |
| 5   | Clinic profile            | NOT TESTABLE | Setup/UI tests; Windows persistence pending                                               |
| 6   | Dentist                   | NOT TESTABLE | UI test; Windows setup pending                                                            |
| 7   | Admin                     | NOT TESTABLE | Linux packaged E2E; Windows setup pending                                                 |
| 8   | Preferences               | NOT TESTABLE | Settings UI test; Windows pending                                                         |
| 9   | Review                    | NOT TESTABLE | Linux packaged E2E only                                                                   |
| 10  | Finish                    | NOT TESTABLE | Linux packaged E2E only                                                                   |
| 11  | Dashboard                 | NOT TESTABLE | Linux packaged E2E; Windows installed GUI not navigated                                   |
| 12  | Logout                    | NOT TESTABLE | UI auth tests only                                                                        |
| 13  | Login                     | NOT TESTABLE | Linux packaged E2E; Windows pending                                                       |
| 14  | Create patient            | NOT TESTABLE | UI/IPC E2E only                                                                           |
| 15  | Search patient            | NOT TESTABLE | UI/IPC E2E only                                                                           |
| 16  | Select patient            | NOT TESTABLE | Invoice UI mouse/keyboard tests; Windows forms pending                                    |
| 17  | Edit patient              | NOT TESTABLE | Core integration; Windows pending                                                         |
| 18  | Create visit              | NOT TESTABLE | Integration/IPC E2E only                                                                  |
| 19  | Dental chart              | NOT TESTABLE | UI chart tests only                                                                       |
| 20  | Treatment                 | NOT TESTABLE | Integration/IPC E2E only                                                                  |
| 21  | Prescription              | NOT TESTABLE | UI/core tests only                                                                        |
| 22  | Prescription preview/PDF  | NOT TESTABLE | HTML/PDF software tests; Windows rendering pending                                        |
| 23  | Invoice                   | NOT TESTABLE | Billing UI/core tests only                                                                |
| 24  | Verify invoice arithmetic | NOT TESTABLE | SQLite integration test covers price 2500 and edits; Windows pending                      |
| 25  | Payment                   | NOT TESTABLE | UI/core tests only                                                                        |
| 26  | Appointment               | NOT TESTABLE | UI/core tests only                                                                        |
| 27  | Queue                     | NOT TESTABLE | UI/core tests only                                                                        |
| 28  | Inventory                 | NOT TESTABLE | UI/core tests only                                                                        |
| 29  | Accounting                | NOT TESTABLE | UI/core tests only                                                                        |
| 30  | Reports                   | NOT TESTABLE | Catalogue integration tests only                                                          |
| 31  | Modify settings           | NOT TESTABLE | UI persistence/error test; Windows categories pending                                     |
| 32  | Restart                   | NOT TESTABLE | Linux packaged E2E; Windows settings pending                                              |
| 33  | Verify persistence        | NOT TESTABLE | UI remount + SQLite persistence; Windows pending                                          |
| 34  | Backup                    | NOT TESTABLE | IPC/integration only                                                                      |
| 35  | Restore                   | NOT TESTABLE | Integration test; Windows pending                                                         |
| 36  | Verify restored data      | NOT TESTABLE | Integration test; Windows pending                                                         |
| 37  | Lock                      | NOT TESTABLE | UI/auth tests only                                                                        |
| 38  | Unlock                    | NOT TESTABLE | UI/auth tests only                                                                        |
| 39  | Verify permissions        | NOT TESTABLE | UI/core restricted-role tests; Windows pending                                            |
| 40  | Audit log                 | NOT TESTABLE | E2E/core tests; Windows pending                                                           |
| 41  | Print prescription        | NOT TESTABLE | No physical printer or Windows print review                                               |
| 42  | Print invoice             | NOT TESTABLE | No physical printer or Windows print review                                               |
| 43  | Uninstall                 | NOT TESTABLE | CI silent uninstall, not interactive Windows acceptance                                   |
| 44  | Verify preserved data     | NOT TESTABLE | CI checks marker and SQLite after uninstall; owner verification pending                   |

## Display and printer matrix

Each resolution (1366×768, 1600×900, 1920×1080, 2560×1440, 3840×2160)
combined with each Windows scale (100%, 125%, 150%, 175%, 200%) is
**NOT TESTABLE in this workspace**: 25/25 interactive combinations outstanding.
The CI GUI-window smoke does not inspect clipping, focus, modals, scrolling or
layout at any of these combinations. A4/A5/thermal/mini prescription and invoice
physical output: **NOT TESTABLE** (no Windows printer hardware). Do not substitute
software HTML/PDF assertions for physical printing.

## Control audit protocol (all controls BLOCKED pending real UI walk)

For each screen in `MASTER-AUDIT-MATRIX.md`, record a control inventory with
locator/label, screenshot at each size/scale, mouse click, keyboard operation,
hover/focus/pressed/disabled/loading/error/success, service result, persistence
and issues. Verify patient picker in invoice, prescription, visit, appointment,
queue, payment and other linked workflows; some flows link patients by invoice
rather than using the shared picker. Log findings with reproduction and regression
coverage. The current automated tests are partial and do not certify this walk.
