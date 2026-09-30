# Troubleshooting

Start with the installation self-check: it answers most questions in one command
and never changes anything.

```powershell
& "$env:LOCALAPPDATA\Programs\Dentiva Pro\Dentiva Pro.exe" --self-check
```

It prints a JSON report — `ok`, `state`, `databaseOk`, `integrityOk`,
`schemaVersion`, `databaseFile`, `licenceActivated`, `problems` — and exits `0`
when healthy. Copy that report into a support e-mail. If Windows did not connect
the output, ask for a file instead — this also works from a script or a remote
session, where standard output is often not attached:

```powershell
$env:DENTIVA_SELF_CHECK_FILE = "$env:TEMP\dentiva-report.json"
& "$env:LOCALAPPDATA\Programs\Dentiva Pro\Dentiva Pro.exe" --self-check
Get-Content $env:DENTIVA_SELF_CHECK_FILE
```

An exit code of `1` with `"ok": false` means the application found a real problem;
the `error` or `problems` field names it.

## The application does not start

1. Look in the log folder: `%APPDATA%\Dentiva Pro\logs`. The newest file is the
   current session; `crash.log`, if present, holds the last unhandled failure.
2. Run the application with the self-check flag above. If it reports a database
   problem, read the next section.
3. If the window never appears but the process is running, close Dentiva Pro and
   delete `%APPDATA%\Dentiva Pro\config\window-state.json` — a monitor change can
   leave the saved window position off-screen. The application recreates it.
4. Antivirus software occasionally quarantines `better_sqlite3.node` inside the
   installation folder. Restore it or reinstall, and add the installation folder
   to the antivirus exclusions.

## "Your session has ended" or the sign-in screen keeps returning

That message means the action was attempted without a valid session, which is how
the core protects itself. Sign in again. If it happens immediately after signing
in, check the system clock — a clock that jumps far backwards or forwards expires
sessions — and correct it, then restart the application.

## Sign-in problems

| Symptom                                   | Cause and fix                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| "The username or password is not correct" | Wrong credentials. Five failures lock the account for the cooldown set in Settings |
| Account locked                            | Wait for the cooldown, or have an administrator reset the password                 |
| "Must change password"                    | The account was created with that flag; set a new password when prompted           |
| Password rejected as too weak             | Minimum length and the letter/number rule from **Settings → Security** apply       |
| The owner account is unavailable          | Every other administrator can reset it; otherwise contact the supplier             |

## The database looks wrong

**Administration → Settings → Data → Integrity check** reports SQLite integrity,
foreign-key violations, orphaned attachment links and missing files, and shows the
report on screen.

- **Missing attachment files** (x-rays, photos) mean the `attachments` folder was
  moved, deleted or restored without its files. Restore a backup that includes
  attachments — the restore screen has a switch for that.
- **Foreign-key violations or a failed SQLite check** mean the database file is
  damaged. Restore the most recent verified backup: **Backup & data → Restore →
  Restore and restart**. A pre-restore backup of the current data is taken
  automatically, so the current state is never thrown away.
- Never edit the database with an external SQLite tool while Dentiva Pro is
  running, and never copy the database file while the application is running: use
  the backup tools, which use SQLite's own online backup API.

## Backups

| Symptom                               | Cause and fix                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| "A backup is due" will not go away    | The last automatic backup failed; the reason is shown on **Backup & data**                   |
| The automatic backup cannot write     | The backup folder is unavailable (removed drive, network share offline). Choose a new folder |
| A backup file "cannot be verified"    | The file was truncated or copied incompletely; take a fresh backup                           |
| Restore says it will apply on restart | That is the designed two-stage restore: confirm, and the application relaunches              |
| Restore failed at start-up            | Current data was not changed. The reason is in the audit log and the notification centre     |

## Printing

See [PRINTING.md](PRINTING.md) for paper, margin and template problems. If nothing
prints at all, check the Windows print queue first: a stuck job stops everything
behind it.

## Performance on a busy day

Dentiva Pro is designed for a clinic of thousands of patients on ordinary office
hardware; the automated stress test seeds 600 patients with several years of
visits and asserts that lists, search, dashboards and reports stay well inside
interactive budgets (see [TEST-REPORT.md](TEST-REPORT.md)). If a screen feels slow:

1. Run **Settings → Data → Integrity check**.
2. Check that the data folder is on a local disk, not a network share, and that
   the disk is not nearly full.
3. Narrow list filters (patients has a date range; every list has a search box) —
   the largest tables page, they do not load everything at once.

## Moving the application to another computer

Install and activate on the new machine, close the application, copy the whole
`%APPDATA%\Dentiva Pro` folder across (or restore a `.dentivabak` backup), and start
it. The activation record travels with the folder, so the new machine does not ask
for the code again — see [BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md).

## Resetting the application

- **Forgotten administrator password:** any other administrator can reset it from
  **Users & roles**. With no reachable administrator, contact the supplier.
- **Start the wizard again:** the wizard is for a new installation. After setup it
  is closed on purpose; change the same values in **Settings** instead.
- **Wipe the machine and start over:** uninstall, delete
  `%APPDATA%\Dentiva Pro`, reinstall and activate with the same code.

## What to send to support

1. The output of `--self-check`.
2. The newest file in `%APPDATA%\Dentiva Pro\logs`.
3. What was being done when the problem appeared, and the exact on-screen message.

Support: **helloiamshohan@gmail.com**
