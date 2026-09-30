# Printing

Dentiva Pro prints four kinds of document — **prescriptions**, **invoices**,
**reports** and **patient summaries** — and can also save any of them as PDF
instead of sending them to a printer. Both paths use the same layout engine, so
what the clinic sees on screen is what the printer produces.

## The two rules that matter

- **A prescription is signed by the dentist:** dentist name, qualification,
  designation and certification lines, plus the signature image when one has been
  uploaded — optionally with the credentials hidden, per clinic preference.
- **An invoice is issued by the clinic:** clinic header only. An invoice never
  carries a doctor's signature, because it is the clinic's financial document.

Both rules are applied in the core when the document is rendered, and both are
covered by automated tests: the invoice template is asserted _not_ to contain a
signature block, the prescription template is asserted to contain one.

## Printer profiles

**Administration → Settings → Printers** lists the printers Windows reports, and
below it the **printer profiles**. A profile binds a document kind to a printer
and a paper setup:

| Setting          | Meaning                                                              |
| ---------------- | -------------------------------------------------------------------- |
| Name             | A label the clinic recognises, e.g. "Front desk — prescriptions"     |
| Document kind    | Prescription, invoice, report or patient summary                     |
| Printer          | Any printer installed in Windows, including thermal receipt printers |
| Paper            | A4, A5, Letter, Legal, 80 mm / 58 mm thermal rolls, or custom        |
| Orientation      | Portrait or landscape                                                |
| Margins          | Top, right, bottom and left, in millimetres                          |
| Scale            | 50–150 %                                                             |
| Copies           | How many copies each print produces                                  |
| Thermal          | Tells the renderer to use the narrow, high-contrast thermal layout   |
| Default for kind | The profile used when nobody chooses another one                     |

Several profiles may exist for the same document kind (for example an A5 pad for
the surgery and an 80 mm roll at the front desk), with one default. The profile
used for a document can be changed in the print dialog for that document without
changing the default.

**Test print** renders a sample of the selected profile on the selected printer —
do this when a printer, paper size or margin is first configured, not while a
patient is waiting.

## Document templates

**Administration → Settings → Document templates** controls what appears on each
kind of document:

| Setting                     | Effect                                                         |
| --------------------------- | -------------------------------------------------------------- |
| Header text                 | Printed under the clinic name                                  |
| Footer text                 | Printed at the foot of the page                                |
| Show logo                   | Prints the clinic logo from the clinic profile                 |
| Show dentist signature      | Prescriptions only; the invoice template ignores it            |
| Show dentist qualifications | Prints BDS/MDS, designations and certifications under the name |
| Signature label             | The line above the signature, e.g. "Consultant, Orthodontics"  |
| Accent colour               | The rule and heading colour of the document                    |
| Default for kind            | Which template is used when none is chosen                     |

The clinic profile (**Settings → Clinic profile**) supplies the header itself: name,
registration number, address, phone, email, website and visiting hours, plus the
optional message printed at the foot of documents.

## Printing and saving PDFs

Every document screen — a prescription, an invoice, a report — offers:

- **Print** — renders the document and sends it to the chosen printer, with the
  profile's copies, paper size and margins.
- **PDF** — renders the same document to a PDF file in
  `%APPDATA%\Dentiva Pro\exports` (also reachable from **Backup & data**, which
  lists recent exports), ready to be attached to an email or copied to a patient's
  record.

Both use the fonts bundled with the application, including **Noto Sans Bengali**,
so Bengali names, addresses and clinical notes print correctly on a machine with
no Bengali fonts installed.

If a printer is offline, out of paper or out of toner, the print job fails with a
message naming the printer; the document itself is not lost and can be reprinted.

## Reports

Reports print in landscape on A4 by default, with the clinic header, the report
name, the period it covers and the generation timestamp, followed by the table.
Every report can also be exported to **CSV** for Excel (see
[USER-GUIDE.md](USER-GUIDE.md#7-reports)).

## If something prints wrongly

| Symptom                       | What to check                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------- |
| Text cut off at the edge      | Margins in the printer profile (most inkjet printers need ≥ 5 mm)                |
| Wrong paper size              | The profile's paper setting, and the printer's own default paper                 |
| Thermal roll prints too wide  | The profile must use an 80 mm or 58 mm paper key and have **Thermal** ticked     |
| Bengali text shows as boxes   | The document is being printed by another application; print from Dentiva Pro     |
| Signature missing             | Template → _Show dentist signature_, and a signature image on the dentist record |
| Logo missing                  | Clinic profile → Logo, or template → _Show logo_                                 |
| Nothing happens when printing | Windows printer queue; see [TROUBLESHOOTING.md](TROUBLESHOOTING.md)              |
