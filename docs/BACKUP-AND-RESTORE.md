# Backup and restore

The clinic's records live on the clinic's computer, so backups are the clinic's
insurance policy. Dentiva Pro makes a backup a single click, schedules them
automatically, verifies every archive it creates, and refuses to restore anything
without first taking a safety copy of the current data.

## What a backup contains

Every backup is one file — `dentiva-<date>-<time>.dentivabak` — which is a ZIP
archive holding:

| Entry             | Contents                                                               |
| ----------------- | ---------------------------------------------------------------------- |
| `manifest.json`   | Application version, schema version, clinic name, counts, checksums    |
| `database.sqlite` | The complete clinic database, captured with SQLite's online backup API |
| `attachments/`    | X-rays, photos and scans (optional, chosen at restore time)            |
| `profiles/`       | Clinic logo and dentist signature images                               |

Because the database is captured with SQLite's backup API, a backup taken while
the clinic is working is consistent — it is not a half-written copy of the file.

## Backing up

**Administration → Backup & data → Back up now** writes a manual backup to the
backup folder and reports where it went.

Automatic backups run on the schedule set during setup (every 1, 3, 7, 14 or 30
days, default 7). If a backup is due, the dashboard says so and the notification
centre keeps saying so until it is taken. If the last automatic backup failed,
the reason is shown on the same screen.

The backup folder defaults to `%APPDATA%\Dentiva Pro\backups`. Change it — and it
is worth changing — to a folder on a different physical disk, an external drive,
or a network share the clinic can write to. **A backup on the same disk as the
database does not protect against disk failure, theft or fire.** The clinic should
regularly copy the backup folder somewhere else entirely.

## Verifying

**Verify** re-opens an archive, checks its manifest against the checksums inside
it, and confirms that the database it contains opens and passes an integrity
check. Verification is what makes a backup trustworthy; a file that cannot be
verified is reported as such instead of being quietly accepted.

**Scan folder** picks up backup files that were copied into the backup folder
from another computer (for example a USB stick brought from a branch, or the
previous machine after a hardware failure), lists them, and lets them be restored
after inspection.

## Restoring

Restoring replaces everything currently in the application, so the flow is
deliberately in two stages.

1. **Choose the backup and read the preview.** The preview shows what is in the
   archive (patients, visits, invoices, payments, users…) next to what is
   currently in the application, together with warnings: an older application
   version, a different clinic name, an archive more than a year old. Choose
   whether attachments and profile images are restored too.
2. **Type `RESTORE` to confirm**, then press **Restore and restart**.

Before anything is replaced, Dentiva Pro takes a **pre-restore backup** of the
current data and lists it under _Pre-restore backups_ on the same screen. That
archive is the undo button: it is kept until deleted, and can be restored with the
same flow.

The restore itself is applied on the next start: the application stages the
archive (writing the database and attachments next to the live files), records the
outcome in the audit log, raises a notification, and then relaunches. If the
staged restore cannot be applied — for example the archive is truncated — the
application starts normally, reports the failure at critical severity, and the
clinic's current data is untouched.

After a restore, run **Settings → Data → Integrity check** and open a few patients
before continuing with the day.

## Restoring on a new computer

1. Install Dentiva Pro on the new machine and activate it.
2. Close the application.
3. Copy the clinic's data folder (or just a `.dentivabak` file) onto the new
   machine — into `%APPDATA%\Dentiva Pro\backups` for a backup file, or replace the
   whole folder for a folder copy.
4. Start the application, open **Backup & data**, **Scan folder** if you copied a
   file in, then restore it and confirm with `RESTORE`.

A whole-folder copy is the fastest recovery: it brings back data, attachments,
settings, backups and the activation record in one move.

## Exporting data

The same screen exports the clinic's data to CSV files (patients, visits,
prescriptions, invoices, payments, stock, accounts and the audit log) into
`%APPDATA%\Dentiva Pro\exports`. Use it for year-end archives, accountants'
requests or migrating to another system — the CSV export is plain data, readable
by Excel and by any other clinic software.

## Destructive actions

**Administration → Settings → Data** also offers the deliberate, irreversible
operations — reset clinical data, reset financial data, delete all business data.
Each one requires typing an exact confirmation phrase (`RESET CLINICAL`,
`RESET FINANCIAL`, `DELETE BUSINESS`), each one takes a pre-action backup, and each
one is recorded in the audit log with the user's name. Read the warning text on
screen before typing the phrase: these are the actions that make a backup
non-optional.
