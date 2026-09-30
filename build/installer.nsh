; Dentiva Pro — NSIS installer customisation.
;
; The Windows build uses electron-builder's assisted NSIS installer (per-user by
; default, with the option to install for all users, and a portable build beside
; it). Two things are added here, both about the clinic's data:
;
;   1. the data folder is created at install time, so the first run on a locked
;      down machine never has to guess where it may write; and
;   2. uninstalling says out loud that the clinic's records were kept.
;
; "deleteAppDataOnUninstall" is false in electron-builder.yml. That is a product
; decision, not a default: an uninstall must never destroy a clinic's patient
; records, invoices or backups. The message below is what the user sees, and it
; names the exact folder so nothing has to be guessed.

!macro customInstall
  ; %APPDATA%\Dentiva Pro is where Electron keeps the application's user data:
  ; the SQLite database, attachments, backups, logs and the activation record.
  CreateDirectory "$APPDATA\Dentiva Pro"
!macroend

!macro customUnInstall
  ; A silent uninstall must not wait for someone to click OK. NSIS shows a
  ; MessageBox even in silent mode (only "/SD" suppresses one), so on a machine
  ; with nobody at the keyboard — an unattended rollout, a scripted removal, or
  ; this project's own clean-machine check — the message would leave the
  ; uninstaller running until it is killed, and the application would look as
  ; though it refuses to uninstall. The message is for the person who clicks
  ; Uninstall, so it is shown exactly then.
  ${IfNot} ${Silent}
  MessageBox MB_OK|MB_ICONINFORMATION \
    "Dentiva Pro has been removed from this computer.$\r$\n$\r$\n\
     Your clinic data has been kept in:$\r$\n\
     $APPDATA\Dentiva Pro$\r$\n$\r$\n\
     It contains the patient records, visits, charts, prescriptions, invoices, payments, \
inventory and accounts, together with your backups and the activation record. Nothing in \
that folder is deleted by this uninstaller.$\r$\n$\r$\n\
     Take a backup before reinstalling, and delete the folder yourself only when you are \
certain you no longer need the records."
  ${EndIf}
!macroend
