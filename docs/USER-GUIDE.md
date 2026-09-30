# Dentiva Pro — user guide

This guide follows a clinic's day. Every screen is reached from the sidebar,
which is grouped the way a practice works: **Practice**, **Clinical**, **Billing**
and **Administration**. Only the parts a signed-in user is allowed to open are
shown, and the core refuses anything else even if the screen were opened directly.

Two keyboard shortcuts are always available: **Ctrl+K** opens the global search
(patients, documents and settings the user may see) and **Ctrl+L** locks the
screen immediately.

---

## 1. Patients

**Practice → Patients** is the register. It opens on the newest patients first and
carries a date-range filter (today, this week, this month, this year, custom) plus
search over name, patient code, phone and address.

- **Register patient** records name, phone, address, date of birth, gender, blood
  group, medical alerts, notes and a photo. The patient code (`P-000001`) is
  allocated by the database, never by the screen.
- If a similar name/phone already exists, the dialog warns before the duplicate is
  saved.
- Clicking a patient opens the profile: demographics, medical alerts, the clinical
  timeline (visits, prescriptions, invoices, payments, attachments), the dental
  chart and the patient's documents.
- **Attachments** (x-rays, photos, scans) are copied into the clinic's own
  attachments folder with a generated name — a file name typed by a user can never
  escape that folder.

## 2. Appointments and the queue

**Practice → Appointments** offers day, week, month and list views. Appointments
carry a patient, a dentist, a date, a 30-minute slot, a treatment, a status and
notes. Statuses: booked, confirmed, arrived, in treatment, completed, cancelled,
no-show. Moving an appointment to **arrived** puts the patient in the queue
automatically.

**Practice → Queue** is the waiting room, in order, with waiting time, priority
(normal/urgent), status and the ability to call, start, skip or complete an entry.
The queue carries over between days — nothing is lost at midnight.

## 3. Visits, chart and prescriptions (Clinical)

**Clinical → Visits** records what happened: date, time, dentist, treatment lines
taken from the treatment catalogue, dental findings per tooth, notes and a
follow-up date. A visit's clinical history is immutable — corrections are added as
new findings, and the old ones remain visible with their timestamps.

**The dental chart** is available on the patient profile and inside a visit:

- Adult and pediatric dentitions, FDI numbering, upper and lower arches.
- Whole-tooth findings (caries, restoration, missing, crown, implant, root canal,
  fracture, mobility, sensitivity and more), surfaces (M/D/B/L/O/I), mobility
  grades and a free-text note per tooth.
- Multi-select with the mouse (Ctrl/Shift) or move with the arrow keys and mark
  with the keyboard alone.
- Periodontal mode records a six-site probing table per tooth.
- **Save findings** writes the chart; **Clear chart** retires the findings without
  erasing history — the chart history for each tooth stays queryable forever.

**Clinical → Prescriptions** creates a prescription for a patient: multiple
medications with dose, frequency, duration, food timing and instructions, plus the
four configurable sections — **C/C** (chief complaint), **O/E** (on examination),
**R/E** (advice) and treatment advice — and the dentist who signs it. Printing is
described in [PRINTING.md](PRINTING.md).

**Clinical → Treatments** is the catalogue: code, name, category, price and
duration. Prices are what invoices start from; changing a price never changes a
document that has already been issued.

## 4. Invoices and payments (Billing)

**Billing → Invoices**: raise an invoice for a patient with lines taken from the
catalogue (quantity, unit price, discount), a whole-invoice discount and notes.
The detail view offers **PDF**, **Print**, **Take payment** and **Void**.

- Invoice numbers are `INV-2026-000001`, allocated inside the database.
- Amounts are stored in paisa; totals are computed by the core, not by the screen.
- An invoice with money against it cannot be edited — void it and raise a new one,
  so the audit trail stays honest.

**Billing → Payments** lists receipts (`RCP-2026-00001`) with method, reference,
date and the invoice they settle. Methods are configurable (Cash, Bank, Card,
bKash, Nagad, Rocket, Upay, Other). Part payments are normal; an over-payment is
refused. Voiding a payment is a confirmed, audited action.

## 5. Inventory

**Billing → Inventory** keeps stock of materials and medicines: items with
category, unit, reorder level and current stock; **batches** with expiry dates;
**purchases** from suppliers; and a full movement ledger (purchase, usage,
adjustment, expiry write-off, return). Stock cannot go negative, and expired
stock is called out on the dashboard. Low-stock and expiry alerts appear in the
notification centre.

## 6. Accounting

**Billing → Accounting** holds income and expenses with categories, payment
methods, references and notes, plus a daybook, a period filter and summaries by
category, month and payment method. Invoices and payments feed the summary
automatically; manual entries are marked as such. Periods can be closed so that
reported numbers stop moving.

## 7. Reports

**Billing → Reports** produces the clinic's reports (patient activity, procedures,
dentist productivity, collections, outstanding dues, stock, expenses and more).
Every report can be printed, saved as PDF or exported to CSV for Excel.

## 8. Staff, dentists, users and roles

**Administration → Staff & dentists** keeps two lists. _Staff_ are the people who
work at the clinic (designation, department, phone, joining date, salary). _Dentists_
are the clinicians who appear on prescriptions and appointments, each with a
registration number, visiting hours, and any number of **designations,
qualifications and certifications** — each of which can be marked as shown on
prescriptions.

**Administration → Users & roles** creates the accounts that sign in and the roles
that decide what they can do. Seven preset roles are seeded (Owner, Administrator,
Dentist, Receptionist, Assistant, Accountant, Inventory manager) and new roles can
be composed from the permission catalogue. Permissions are enforced in the core:
hiding a button is a convenience, never the protection.

## 9. Backup, audit and notifications

- **Administration → Backup & data**: back up now, verify an archive, browse the
  backup folder, restore (with a mandatory safety copy) and export data. See
  [BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md).
- **Administration → Audit log**: who did what, when, and to which record —
  sign-ins, record changes, voids, permission changes, restores, resets.
- **Notifications** (the bell in the header) is filled from real conditions: stock
  low or expiring, appointments due, follow-ups overdue, a backup that is due, a
  failed restore. Nothing is invented for show.
- **Global search** (Ctrl+K) searches patients, documents and settings the signed-in
  user is allowed to see, and respects permissions.

## 10. Settings

**Administration → Settings** centralises clinic details, formats, printing
templates and printers, backup schedule, security (auto-lock), data maintenance
(integrity check, vacuum, export) and the destructive actions — reset clinical or
financial data, delete business data — each of which requires typing an exact
confirmation phrase and is recorded in the audit log.

## 11. Signing in, locking and signing out

The application locks itself after the configured idle interval (5, 10, 15, 30
minutes, or never). Locking keeps the session and the work in progress; unlocking
asks for that user's password. **Ctrl+L** locks immediately. Signing out returns to
the sign-in screen; closing the window quits the application. Five failed sign-in
attempts lock the account for a short cooldown, and every attempt is recorded.
