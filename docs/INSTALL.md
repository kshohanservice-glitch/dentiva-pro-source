# Installing Dentiva Pro

Dentiva Pro is a Windows desktop application. It installs per user by default
and needs no internet connection, no server and no database engine — everything
it needs is inside the installer.

## What the installer does

| Step              | Detail                                                                        |
| ----------------- | ----------------------------------------------------------------------------- |
| Welcome / licence | The end-user licence agreement (`build/EULA.txt`) — read it before continuing |
| Choose folder     | `%LOCALAPPDATA%\Programs\Dentiva Pro` by default; any folder may be chosen    |
| Install           | Application files, the Electron runtime and the local database engine         |
| Shortcuts         | Start Menu entry and, by default, a desktop shortcut                          |
| Uninstall entry   | Registered in **Settings → Apps → Installed apps** as _Dentiva Pro 1.0.0_     |
| Launch afterwards | Ticked by default; the activation screen opens on first start                 |

Administrator rights are only needed if the installation folder requires them;
the application itself runs as the signed-in user and never asks for elevation.

## First start

1. **Activation.** Enter the 16-digit activation code supplied with your licence.
   The code is verified on this machine and stored in the clinic's data folder.
   There is no server call; the application never touches the network. If the
   code is rejected, count the remaining attempts on screen — after five failed
   attempts activation is blocked for a while, and the supplier must be
   contacted.
2. **Setup wizard.** Seven steps, all of which can be left and resumed later
   (the wizard remembers completed steps):

   | Step          | What it asks for                                                      |
   | ------------- | --------------------------------------------------------------------- |
   | Welcome       | Where the data lives, and what the wizard will set up                 |
   | Clinic        | Clinic name, address, phone, email, website and optional logo         |
   | Dentists      | Name, registration number, visiting hours and credentials (BDS, etc.) |
   | Preferences   | Date/time formats, number grouping, auto-lock, backup schedule        |
   | Administrator | The owner account: username, full name and password                   |
   | Review        | A summary of everything entered                                       |
   | Finish        | Completes setup and opens the sign-in screen                          |

3. **Sign in** with the administrator account. The account is locked to the
   clinic's chosen auto-lock interval and can be locked manually at any time
   (Ctrl+L).

## Where the data is stored

```
%APPDATA%\Dentiva Pro\
  data\dentiva.sqlite        patients, visits, charts, prescriptions, invoices, payments, stock, accounts
  attachments\               x-rays, intra-oral photos and scanned documents
  backups\                   verified .dentivabak archives
  logs\                      rotating text logs (also shown in Settings → About/Diagnostics)
  config\                    machine identifier, activation record, window state
```

The whole folder is the clinic's record. Copying it — while Dentiva Pro is
closed — is a complete disaster-recovery copy of everything.

### Putting the data somewhere else

Set `DENTIVA_DATA_DIR` to an absolute path before starting the application (a
system environment variable, or a shortcut that sets it), for example:

```
DENTIVA_DATA_DIR=D:\ClinicData\DentivaPro
```

Everything above is then created under `D:\ClinicData\DentivaPro`. Useful for
keeping records on a chosen drive, for IT-managed deployments, and for support,
who use it to open a copy of a clinic's folder without touching the original.

## Silent installation (IT departments)

The NSIS installer understands the usual switches:

```powershell
# per-user install, no prompts, no automatic launch
.\DentivaPro-1.0.0-Windows-x64-Setup.exe /S

# choose the folder explicitly and skip shortcut creation
.\DentivaPro-1.0.0-Windows-x64-Setup.exe /S /D=C:\Clinics\DentivaPro
```

The portable build (`DentivaPro-1.0.0-Windows-x64-Portable.exe`) needs no
installation at all: run it, and it unpacks into a temporary folder and starts.
Useful for a demonstration machine or a USB stick — pair it with
`DENTIVA_DATA_DIR` so the data is kept with the stick.

## Verifying an installation

The application can check itself without opening a window:

```powershell
& "$env:LOCALAPPDATA\Programs\Dentiva Pro\Dentiva Pro.exe" --self-check
```

It prints a JSON report (database opened, schema version, integrity checks,
licence state, data folder) and exits with code `0` when the installation is
healthy, `1` when it is not. This is the same check the release pipeline runs
against a freshly installed copy.

A packaged Windows build is a graphical executable, so its standard output is not
always connected when another program starts it. Set `DENTIVA_SELF_CHECK_FILE` to
have the identical report written to a file as well; this is the form an IT script
should read, and the form the release pipeline uses:

```powershell
$env:DENTIVA_SELF_CHECK_FILE = "$env:TEMP\dentiva-report.json"
& "$env:LOCALAPPDATA\Programs\Dentiva Pro\Dentiva Pro.exe" --self-check
Get-Content $env:DENTIVA_SELF_CHECK_FILE
```

`--self-check-file=<path>` does the same when the platform passes switches through.
Every run also leaves a copy at `%APPDATA%\Dentiva Pro\logs\self-check.json`, so a
report can always be found afterwards. Either way the exit code tells the story on
its own: `0` healthy, `1` not healthy —
and on `1` the report explains why. If the data folder cannot even be opened (a
locked drive, a read-only folder, a full disk) the report says so instead of
failing silently.

## Updating

Run the newer installer over the existing installation; the application folder
is replaced and the clinic's data folder is left untouched. The database schema
is upgraded automatically on the next start, and a backup is worth taking before
an upgrade: **Administration → Backup & data → Back up now**.

## Uninstalling

Use **Settings → Apps → Installed apps → Dentiva Pro → Uninstall**, or the
uninstaller in the installation folder. The application files, shortcuts and
registry entry are removed. **The clinic's data folder is deliberately kept**,
and the uninstaller says so, printing the exact path. Delete that folder
yourself only when you are certain the records are no longer needed — and take a
backup first.
