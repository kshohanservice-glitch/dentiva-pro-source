/**
 * Document rendering and printing.
 *
 * Prescriptions, invoices, patient summaries and reports are rendered as
 * self-contained HTML documents and handed to a `PrintHostPort`, which either
 * writes a PDF through a hidden Chromium window or sends the page to a Windows
 * printer. Nothing here talks to Electron directly, so the packaged application,
 * the development bridge and the automated tests all render the very same
 * markup.
 *
 * Two rules are baked into the templates:
 *   • a prescription carries the clinic letterhead *and* the dentist's
 *     signature block with their qualifications;
 *   • an invoice is a clinic document only — it never shows a dentist's
 *     signature, because it is not a clinical record.
 */
import { readFile } from 'node:fs/promises';
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { hasPermission, requirePermission } from '../context';
import { AppError } from '@shared/errors';
import { PAPER_SIZES } from '@shared/constants';
import type { PrintTemplateKind } from '@shared/constants';
import { formatMoney } from '@shared/money';
import { formatDate } from '@shared/dates';
import type {
  InvoiceDetail,
  PatientDetail,
  PrescriptionDetail,
  PrintRenderRequest,
  PrintRenderResult,
  PrinterProfile,
  PrintTemplate,
  ReportRequest,
  ReportResult,
  SystemPrinter,
  TreatmentPlan,
  VisitSummary,
} from '@shared/types';
import type { AttachmentService } from './attachment-service';
import type { PrescriptionService } from './prescription-service';
import type { InvoiceService } from './invoice-service';
import type { PatientService } from './patient-service';
import type { VisitService } from './visit-service';
import type { TreatmentService } from './treatment-service';
import type { ReportPrinterPort, ReportService } from './report-service';

export interface PrintRenderOptions {
  readonly widthMm: number;
  readonly heightMm: number;
  readonly marginTopMm: number;
  readonly marginRightMm: number;
  readonly marginBottomMm: number;
  readonly marginLeftMm: number;
  readonly scalePercent: number;
  readonly orientation: 'portrait' | 'landscape';
  readonly copies: number;
  readonly printerName: string;
  readonly jobName: string;
  readonly isThermal: boolean;
  /** Font-face CSS with the bundled Bengali + Latin faces embedded as data URLs. */
  readonly fontCss: string;
}

/** The platform side of printing: a Chromium window, exposed as four calls. */
export interface PrintHostPort {
  listPrinters(): Promise<SystemPrinter[]>;
  toPdf(html: string, options: PrintRenderOptions): Promise<{ path: string; pageCount: number; bytes: number }>;
  send(html: string, options: PrintRenderOptions): Promise<{ pageCount: number; bytes: number }>;
  reveal(path: string): Promise<void>;
}

interface ResolvedProfile {
  readonly id: number | null;
  readonly name: string;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly orientation: 'portrait' | 'landscape';
  readonly marginTopMm: number;
  readonly marginRightMm: number;
  readonly marginBottomMm: number;
  readonly marginLeftMm: number;
  readonly scalePercent: number;
  readonly copies: number;
  readonly printerName: string;
  readonly isThermal: boolean;
  readonly headerNote: string;
  readonly footerNote: string;
}

interface ClinicHeader {
  readonly name: string;
  readonly address: string;
  readonly phone: string;
  readonly email: string;
  readonly website: string;
  readonly registrationNumber: string;
  readonly visitingHours: string;
  readonly message: string;
  readonly logoDataUrl: string | null;
}

function permissionForKind(kind: PrintTemplateKind): string {
  if (kind === 'prescription') return 'prescription.print';
  if (kind === 'invoice') return 'invoice.print';
  if (kind === 'report') return 'report.export';
  return 'patient.view';
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? fallback : String(value);
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function mapProfile(row: Record<string, unknown>): PrinterProfile {
  return {
    id: asNumber(row['id']),
    name: asString(row['name']),
    kind: asString(row['kind'], 'prescription') as PrinterProfile['kind'],
    printerName: asString(row['printer_name']),
    paperKey: asString(row['paper_key'], 'a4') as PrinterProfile['paperKey'],
    widthMm: asNumber(row['width_mm'], 210),
    heightMm: asNumber(row['height_mm'], 297),
    orientation: asString(row['orientation'], 'portrait') === 'landscape' ? 'landscape' : 'portrait',
    marginTopMm: asNumber(row['margin_top_mm'], 12),
    marginRightMm: asNumber(row['margin_right_mm'], 12),
    marginBottomMm: asNumber(row['margin_bottom_mm'], 12),
    marginLeftMm: asNumber(row['margin_left_mm'], 12),
    scalePercent: asNumber(row['scale_percent'], 100),
    copies: asNumber(row['copies'], 1),
    isThermal: asNumber(row['is_thermal']) === 1,
    isDefault: asNumber(row['is_default']) === 1,
    isActive: asNumber(row['is_active'], 1) === 1,
    headerNote: asString(row['header_note']),
    footerNote: asString(row['footer_note']),
  };
}

function mapProfileToResolved(profile: PrinterProfile): ResolvedProfile {
  return {
    id: profile.id,
    name: profile.name,
    widthMm: profile.widthMm,
    heightMm: profile.heightMm,
    orientation: profile.orientation,
    marginTopMm: profile.marginTopMm,
    marginRightMm: profile.marginRightMm,
    marginBottomMm: profile.marginBottomMm,
    marginLeftMm: profile.marginLeftMm,
    scalePercent: profile.scalePercent,
    copies: profile.copies,
    printerName: profile.printerName,
    isThermal: profile.isThermal,
    headerNote: profile.headerNote,
    footerNote: profile.footerNote,
  };
}

function mapTemplate(row: Record<string, unknown>): PrintTemplate {
  return {
    id: asNumber(row['id']),
    kind: asString(row['kind'], 'prescription') as PrintTemplate['kind'],
    name: asString(row['name']),
    headerText: asString(row['header_text']),
    footerText: asString(row['footer_text']),
    showLogo: asNumber(row['show_logo'], 1) === 1,
    showDentistSignature: asNumber(row['show_dentist_signature'], 1) === 1,
    showDentistQualifications: asNumber(row['show_dentist_qualifications'], 1) === 1,
    signatureLabel: asString(row['signature_label'], 'Dentist'),
    accentColour: asString(row['accent_colour'], '#0f9d8f'),
    isDefault: asNumber(row['is_default'], 1) === 1,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Keep the author's line breaks without letting markup through. */
function textBlock(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, '<br />');
}

const FONT_STACK = `'Dentiva Sans', 'Inter', 'Noto Sans Bengali', 'Segoe UI', 'Nirmala UI', sans-serif`;

function documentCss(): string {
  return `
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: ${FONT_STACK};
      color: #14273d;
      font-size: 10.5pt;
      line-height: 1.45;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .sheet { display: flex; flex-direction: column; }
    .sheet__body { flex: 1 1 auto; }
    .letterhead { display: flex; gap: 12px; align-items: flex-start; border-bottom: 2px solid var(--accent); padding-bottom: 10px; }
    .letterhead__logo { width: 62px; height: 62px; object-fit: contain; }
    .letterhead__name { font-size: 17pt; font-weight: 700; letter-spacing: -0.01em; }
    .letterhead__tagline { color: #5b6b80; font-size: 8.5pt; }
    .letterhead__meta { margin-top: 4px; color: #5b6b80; font-size: 8.5pt; }
    .letterhead__right { margin-left: auto; text-align: right; font-size: 8.5pt; color: #5b6b80; }
    .doc-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin: 12px 0 10px; }
    .doc-title h1 { margin: 0; font-size: 14pt; letter-spacing: 0.02em; text-transform: uppercase; }
    .doc-meta { font-size: 9pt; color: #5b6b80; text-align: right; }
    .rx-symbol { font-size: 20pt; font-weight: 700; color: var(--accent); line-height: 1; }
    .patient-strip {
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 20px;
      border: 1px solid #dfe6ee; border-left: 3px solid var(--accent);
      border-radius: 6px; padding: 9px 12px; margin-bottom: 12px; background: #f7f9fc;
    }
    .patient-strip div { font-size: 9.5pt; }
    .patient-strip span { color: #5b6b80; }
    .section { margin-bottom: 12px; }
    .section__title {
      font-size: 8.5pt; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase;
      color: var(--accent); margin-bottom: 4px;
    }
    table.items { width: 100%; border-collapse: collapse; }
    table.items th {
      text-align: left; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.08em;
      color: #5b6b80; border-bottom: 1px solid #c7d2df; padding: 5px 6px;
    }
    table.items td { border-bottom: 1px solid #eef2f7; padding: 6px; vertical-align: top; }
    table.items td.num, table.items th.num { text-align: right; font-variant-numeric: tabular-nums; }
    table.items tr { page-break-inside: avoid; }
    .rx-item { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 8px; padding: 7px 0; border-bottom: 1px solid #eef2f7; page-break-inside: avoid; }
    .rx-item__index { font-weight: 700; color: var(--accent); }
    .rx-item__name { font-weight: 600; }
    .rx-item__dose { font-size: 9.5pt; color: #33455c; }
    .rx-item__note { font-size: 9pt; color: #5b6b80; font-style: italic; }
    .totals { margin-left: auto; width: 66mm; }
    .totals__row { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0; font-size: 9.5pt; }
    .totals__row--grand { border-top: 1px solid #c7d2df; margin-top: 4px; padding-top: 6px; font-size: 11pt; font-weight: 700; }
    .totals__row--paid { color: #1a8f5a; }
    .totals__row--due { color: #c33f3f; font-weight: 600; }
    .stamp {
      display: inline-block; border: 1.5px solid #c33f3f; color: #c33f3f; border-radius: 6px;
      padding: 2px 10px; font-weight: 700; letter-spacing: 0.14em; font-size: 9pt;
    }
    .signature { margin-top: 24px; display: flex; justify-content: flex-end; page-break-inside: avoid; }
    .signature__block { min-width: 64mm; text-align: center; }
    .signature__line { border-top: 1px solid #33455c; margin-bottom: 4px; }
    .signature__name { font-weight: 600; }
    .signature__credential { font-size: 8.5pt; color: #5b6b80; }
    .footer {
      margin-top: 14px; border-top: 1px solid #dfe6ee; padding-top: 6px;
      font-size: 8pt; color: #5b6b80; display: flex; justify-content: space-between; gap: 12px;
    }
    .note { font-size: 9pt; color: #5b6b80; }
    .grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  `;
}

interface DocumentShellOptions {
  readonly title: string;
  readonly header: ClinicHeader;
  readonly profile: ResolvedProfile;
  readonly template: PrintTemplate | null;
  readonly body: string;
  readonly footerNote?: string;
  readonly accent: string;
}

function documentShell(options: DocumentShellOptions): string {
  const { header, profile, template } = options;
  const accent = template?.accentColour || options.accent;
  const showLogo = header.logoDataUrl && (template === null || template.showLogo);
  const logo = showLogo ? `<img class="letterhead__logo" src="${header.logoDataUrl}" alt="" />` : '';
  const contactLines = [
    header.address,
    [header.phone ? `Tel: ${header.phone}` : '', header.email].filter(Boolean).join('  •  '),
    header.website,
  ]
    .filter((line) => line.trim() !== '')
    .join('\n');
  const rightLines = [
    header.registrationNumber ? `Reg. no: ${header.registrationNumber}` : '',
    header.visitingHours ? `Visiting hours: ${header.visitingHours}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const headerNote = template?.headerText || profile.headerNote;
  const footerBits = [profile.footerNote, options.footerNote ?? '', template?.footerText ?? '', header.name ? `<span>${escapeHtml(header.name)}</span>` : '', '<span>Dentiva Pro</span>'].filter(
    (part) => part !== '',
  );

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(options.title)}</title>
<style>
  :root { --accent: ${accent}; }
  @page { size: ${profile.widthMm}mm ${profile.heightMm}mm; margin: 0; }
  ${documentCss()}
  .sheet {
    width: ${profile.widthMm}mm;
    min-height: ${profile.heightMm}mm;
    padding: ${profile.marginTopMm}mm ${profile.marginRightMm}mm ${profile.marginBottomMm}mm ${profile.marginLeftMm}mm;
  }
  ${profile.isThermal ? '.letterhead__logo { display: none; } body { font-size: 9.5pt; }' : ''}
</style></head>
<body><div class="sheet">
  <div class="letterhead">
    ${logo}
    <div>
      <div class="letterhead__name">${escapeHtml(header.name || 'Dental clinic')}</div>
      ${header.message ? `<div class="letterhead__tagline">${escapeHtml(header.message)}</div>` : ''}
      ${contactLines ? `<div class="letterhead__meta">${textBlock(contactLines)}</div>` : ''}
    </div>
    ${rightLines ? `<div class="letterhead__right">${textBlock(rightLines)}</div>` : ''}
  </div>
  ${headerNote ? `<div class="note" style="margin-top:6px">${textBlock(headerNote)}</div>` : ''}
  <div class="sheet__body">${options.body}</div>
  <div class="footer">${footerBits.join(' ')}</div>
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function patientStrip(entries: ReadonlyArray<readonly [string, string]>): string {
  return `<div class="patient-strip">${entries
    .map(([label, value]) => `<div><span>${escapeHtml(label)}:</span> <strong>${textBlock(value || '—')}</strong></div>`)
    .join('')}</div>`;
}

function section(title: string, body: string): string {
  if (!body.trim()) return '';
  return `<div class="section"><div class="section__title">${escapeHtml(title)}</div><div>${textBlock(body)}</div></div>`;
}

function listSection(title: string, values: readonly string[]): string {
  const lines = values.filter((value) => value.trim() !== '');
  if (lines.length === 0) return '';
  return `<div class="section"><div class="section__title">${escapeHtml(title)}</div><div>${lines
    .map((line) => `• ${escapeHtml(line)}`)
    .join('<br />')}</div></div>`;
}

function doseText(item: PrescriptionDetail['items'][number]): string {
  const doses = [item.doseMorning, item.doseNoon, item.doseNight].map((dose) => (Number.isInteger(dose) ? String(dose) : dose.toFixed(1)));
  const timing = item.foodTiming.replace(/_/g, ' ');
  const duration = item.durationDays ? ` • ${item.durationDays} day${item.durationDays === 1 ? '' : 's'}` : '';
  const quantity = item.quantity ? ` • qty ${item.quantity}` : '';
  return `${doses.join(' + ')} — ${timing}${duration}${quantity}`;
}

function prescriptionBody(
  data: ReturnType<PrescriptionService['forPrint']>,
  template: PrintTemplate | null,
  signatureDataUrl: string | null,
): string {
  const prescription = data.prescription;
  const items = prescription.items
    .map(
      (item, index) => `<div class="rx-item">
        <div class="rx-item__index">${index + 1}.</div>
        <div>
          <div class="rx-item__name">${escapeHtml(item.name)}${item.strength ? ` ${escapeHtml(item.strength)}` : ''} <span class="note">(${escapeHtml(item.form)})</span></div>
          <div class="rx-item__dose">${escapeHtml(doseText(item))}</div>
          ${item.instructions ? `<div class="rx-item__note">${escapeHtml(item.instructions)}</div>` : ''}
        </div>
      </div>`,
    )
    .join('');

  const dentist = data.dentist;
  const showSignature = template?.showDentistSignature !== false;
  const showCredentials = template?.showDentistQualifications !== false;
  const credentialLines = dentist
    ? [...dentist.designations, ...dentist.qualifications, ...dentist.certifications]
    : [];
  const signature = showSignature
    ? `<div class="signature"><div class="signature__block">
        ${signatureDataUrl ? `<img src="${signatureDataUrl}" alt="" style="max-height:16mm;max-width:52mm" />` : '<div style="height:12mm"></div>'}
        <div class="signature__line"></div>
        <div class="signature__name">${escapeHtml(dentist?.name ?? 'Dentist')}</div>
        ${
          showCredentials
            ? credentialLines.map((line) => `<div class="signature__credential">${escapeHtml(line)}</div>`).join('')
            : ''
        }
        <div class="signature__credential">${escapeHtml(template?.signatureLabel ?? 'Dentist')}</div>
      </div></div>`
    : '';

  return `
    <div class="doc-title">
      <h1>Prescription</h1>
      <div class="doc-meta">
        <div class="rx-symbol">℞</div>
        <div>${escapeHtml(prescription.number)}${prescription.isVoid ? ' • <span class="stamp">VOID</span>' : ''}</div>
        <div>${escapeHtml(formatDate(prescription.date))}</div>
      </div>
    </div>
    ${patientStrip([
      ['Patient', `${prescription.patientName} (${prescription.patientCode})`],
      ['Age / Sex', `${prescription.patientAgeText || '—'} • ${prescription.patientGender}`],
      ['Phone', prescription.patientPhone || '—'],
      ['Dentist', dentist?.name ?? '—'],
    ])}
    ${prescription.patientAddress ? `<div class="note" style="margin-bottom:8px">${textBlock(prescription.patientAddress)}</div>` : ''}
    ${listSection('C/C — Chief complaint', prescription.cc)}
    ${listSection('O/E — On examination', prescription.oe)}
    ${listSection('R/E — Radiographic evidence', prescription.re)}
    ${prescription.items.length > 0 ? `<div class="section"><div class="section__title">Medications</div>${items}</div>` : ''}
    ${listSection('Advice', prescription.advice)}
    ${section('Notes', prescription.notes)}
    ${signature}
  `;
}

function invoiceBody(data: ReturnType<InvoiceService['forPrint']>, template: PrintTemplate | null, footerNote: string): string {
  const invoice = data.invoice;
  const rows = invoice.items
    .map(
      (item) => `<tr>
        <td>${escapeHtml(item.code ? `${item.code} — ` : '')}${escapeHtml(item.description)}${item.toothCodes.length > 0 ? `<div class="note">Tooth: ${escapeHtml(item.toothCodes.join(', '))}</div>` : ''}</td>
        <td class="num">${item.quantity}</td>
        <td class="num">${escapeHtml(formatMoney(item.unitPricePaisa))}</td>
        <td class="num">${item.discountPaisa > 0 ? escapeHtml(formatMoney(-item.discountPaisa)) : '—'}</td>
        <td class="num">${escapeHtml(formatMoney(item.lineTotalPaisa))}</td>
      </tr>`,
    )
    .join('');

  const paymentRows = invoice.payments
    .filter((payment) => !payment.isVoid)
    .map(
      (payment) =>
        `<div class="totals__row"><span>${escapeHtml(payment.receiptNumber)} • ${escapeHtml(formatDate(payment.paidDate))} • ${escapeHtml(payment.methodName)}</span><span>${escapeHtml(formatMoney(-payment.amountPaisa))}</span></div>`,
    )
    .join('');

  return `
    <div class="doc-title">
      <h1>Invoice</h1>
      <div class="doc-meta">
        <div>${escapeHtml(invoice.number)}</div>
        <div>${escapeHtml(formatDate(invoice.date))}</div>
        ${invoice.status === 'void' ? '<div class="stamp">VOID</div>' : ''}
      </div>
    </div>
    ${patientStrip([
      ['Patient', `${invoice.patientName} (${invoice.patientCode})`],
      ['Phone', invoice.patientPhone || '—'],
      ['Dentist', invoice.dentistName || '—'],
      ['Status', invoice.status.replace(/_/g, ' ')],
    ])}
    <table class="items">
      <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Discount</th><th class="num">Amount</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="note">No items.</td></tr>'}</tbody>
    </table>
    <div class="totals" style="margin-top:10px">
      <div class="totals__row"><span>Subtotal</span><span>${escapeHtml(formatMoney(invoice.subtotalPaisa))}</span></div>
      ${invoice.discountPaisa > 0 ? `<div class="totals__row"><span>Discount</span><span>${escapeHtml(formatMoney(-invoice.discountPaisa))}</span></div>` : ''}
      <div class="totals__row totals__row--grand"><span>Total</span><span>${escapeHtml(formatMoney(invoice.totalPaisa))}</span></div>
      ${paymentRows}
      <div class="totals__row totals__row--paid"><span>Paid</span><span>${escapeHtml(formatMoney(invoice.paidPaisa))}</span></div>
      <div class="totals__row ${invoice.duePaisa > 0 ? 'totals__row--due' : ''}"><span>Due</span><span>${escapeHtml(formatMoney(invoice.duePaisa))}</span></div>
    </div>
    ${section('Notes', invoice.notes)}
    ${section('Payment terms', footerNote)}
    ${invoice.voidedAt ? `<div class="note" style="margin-top:8px">Voided: ${escapeHtml(invoice.voidReason)}</div>` : ''}
  `;
}

function patientSummaryBody(data: {
  patient: PatientDetail;
  financial: ReturnType<PatientService['financialSummary']> | null;
  visits: readonly VisitSummary[];
  plans: readonly TreatmentPlan[];
  treatments: ReadonlyArray<{ description: string; toothCodes: readonly string[]; totalPaisa: number; performedAt: string }>;
}): string {
  const patient = data.patient;
  const visitRows = data.visits
    .slice(0, 20)
    .map(
      (visit) =>
        `<tr><td>${escapeHtml(formatDate(visit.visitDate))}</td><td>${escapeHtml(visit.dentistName || '—')}</td><td>${escapeHtml(visit.diagnosis || visit.chiefComplaint || '—')}</td><td class="num">${visit.treatmentCount}</td></tr>`,
    )
    .join('');
  const treatmentRows = data.treatments
    .slice(0, 40)
    .map(
      (record) =>
        `<tr><td>${escapeHtml(formatDate(record.performedAt))}</td><td>${escapeHtml(record.description)}${record.toothCodes.length > 0 ? `<div class="note">Tooth: ${escapeHtml(record.toothCodes.join(', '))}</div>` : ''}</td><td class="num">${escapeHtml(formatMoney(record.totalPaisa))}</td></tr>`,
    )
    .join('');
  const planRows = data.plans
    .map(
      (plan) =>
        `<tr><td>${escapeHtml(plan.title)}</td><td>${escapeHtml(plan.status)}</td><td class="num">${plan.completedItems}/${plan.items.length}</td><td class="num">${escapeHtml(formatMoney(plan.estimatedTotalPaisa))}</td></tr>`,
    )
    .join('');

  return `
    <div class="doc-title"><h1>Patient summary</h1><div class="doc-meta">${escapeHtml(formatDate(patient.registeredAt))}<div>${escapeHtml(patient.code)}</div></div></div>
    ${patientStrip([
      ['Patient', patient.name],
      ['Age / Sex', `${patient.ageText || '—'} • ${patient.gender}`],
      ['Phone', patient.phone || '—'],
      ['Blood group', patient.bloodGroup],
      ['Address', patient.address || patient.city || '—'],
      ['Referred by', patient.referredBy || '—'],
    ])}
    ${section('Allergies', patient.allergies)}
    ${section('Medical notes', patient.medicalNotes)}
    ${section('Chief complaint', patient.chiefComplaint)}
    ${section('Previous problems', patient.previousProblems)}
    ${
      data.financial
        ? `<div class="section"><div class="section__title">Account</div>
          <div class="grid-2">
            <div>Invoiced: <strong>${escapeHtml(formatMoney(data.financial.totalInvoicedPaisa))}</strong></div>
            <div>Paid: <strong>${escapeHtml(formatMoney(data.financial.totalPaidPaisa))}</strong></div>
            <div>Outstanding: <strong>${escapeHtml(formatMoney(data.financial.outstandingPaisa))}</strong></div>
            <div>Invoices: <strong>${data.financial.invoiceCount}</strong></div>
          </div></div>`
        : ''
    }
    ${
      visitRows
        ? `<div class="section"><div class="section__title">Recent visits</div><table class="items"><thead><tr><th>Date</th><th>Dentist</th><th>Diagnosis</th><th class="num">Items</th></tr></thead><tbody>${visitRows}</tbody></table></div>`
        : ''
    }
    ${
      treatmentRows
        ? `<div class="section"><div class="section__title">Treatments</div><table class="items"><thead><tr><th>Date</th><th>Treatment</th><th class="num">Amount</th></tr></thead><tbody>${treatmentRows}</tbody></table></div>`
        : ''
    }
    ${
      planRows
        ? `<div class="section"><div class="section__title">Treatment plans</div><table class="items"><thead><tr><th>Plan</th><th>Status</th><th class="num">Done</th><th class="num">Estimate</th></tr></thead><tbody>${planRows}</tbody></table></div>`
        : ''
    }
  `;
}

function reportBody(result: ReportResult): string {
  const columns = result.columns;
  const head = columns.map((column) => `<th class="${column.align === 'right' ? 'num' : ''}">${escapeHtml(column.label)}</th>`).join('');
  const rows = result.rows
    .map(
      (row) =>
        `<tr>${columns
          .map((column) => {
            const raw = row[column.key];
            let text = raw === null || raw === undefined ? '—' : String(raw);
            if (column.type === 'money' && typeof raw === 'number') text = formatMoney(raw);
            if ((column.type === 'date' || column.type === 'datetime') && typeof raw === 'string' && raw.length >= 10) {
              text = formatDate(raw.slice(0, 10));
            }
            return `<td class="${column.align === 'right' ? 'num' : ''}">${escapeHtml(text)}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');

  return `
    <div class="doc-title"><h1>${escapeHtml(result.title)}</h1>
      <div class="doc-meta"><div>${escapeHtml(formatDate(result.range.from))} – ${escapeHtml(formatDate(result.range.to))}</div>
      <div>${result.rowCount} row(s)</div></div></div>
    ${result.subtitle ? `<div class="note" style="margin-bottom:8px">${escapeHtml(result.subtitle)}</div>` : ''}
    ${
      result.summary.length > 0
        ? `<div class="patient-strip">${result.summary
            .map((item) => `<div><span>${escapeHtml(item.label)}:</span> <strong>${escapeHtml(item.value)}</strong></div>`)
            .join('')}</div>`
        : ''
    }
    <table class="items"><thead><tr>${head}</tr></thead><tbody>${
      rows || `<tr><td class="note" colspan="${Math.max(1, columns.length)}">No data in this range.</td></tr>`
    }</tbody></table>
  `;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PrintService implements ReportPrinterPort {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
    private readonly host: PrintHostPort | null,
    private readonly prescriptions: PrescriptionService,
    private readonly invoices: InvoiceService,
    private readonly patients: PatientService,
    private readonly visits: VisitService,
    private readonly treatments: TreatmentService,
    private readonly attachments: AttachmentService,
    private readonly reports: () => ReportService | null,
    private readonly fontCss: string,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  // --- Printers -----------------------------------------------------------

  async systemPrinters(): Promise<SystemPrinter[]> {
    requirePermission(this.context(), 'settings.view');
    if (!this.host) return [];
    const printers = await this.host.listPrinters();
    return [...printers].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.displayName.localeCompare(b.displayName));
  }

  defaultProfile(kind: PrintTemplateKind): PrinterProfile | null {
    requirePermission(this.context(), 'settings.view');
    const row = this.db
      .prepare(
        `SELECT * FROM printer_profiles WHERE kind = ? AND is_default = 1 AND is_active = 1 AND deleted_at IS NULL
          ORDER BY id LIMIT 1`,
      )
      .get(kind) as Record<string, unknown> | undefined;
    if (row) return mapProfile(row);
    const fallback = this.db
      .prepare(`SELECT * FROM printer_profiles WHERE kind = ? AND is_active = 1 AND deleted_at IS NULL ORDER BY id LIMIT 1`)
      .get(kind) as Record<string, unknown> | undefined;
    return fallback ? mapProfile(fallback) : null;
  }

  private template(kind: PrintTemplateKind, templateId?: number | null): PrintTemplate | null {
    const row = templateId
      ? (this.db.prepare(`SELECT * FROM print_templates WHERE id = ? AND deleted_at IS NULL`).get(templateId) as
          | Record<string, unknown>
          | undefined)
      : (this.db
          .prepare(`SELECT * FROM print_templates WHERE kind = ? AND is_default = 1 AND deleted_at IS NULL ORDER BY id LIMIT 1`)
          .get(kind) as Record<string, unknown> | undefined);
    return row ? mapTemplate(row) : null;
  }

  private resolveProfile(kind: PrintTemplateKind, profileId?: number | null): ResolvedProfile {
    const row = profileId
      ? (this.db.prepare(`SELECT * FROM printer_profiles WHERE id = ? AND deleted_at IS NULL`).get(profileId) as
          | Record<string, unknown>
          | undefined)
      : (this.db
          .prepare(
            `SELECT * FROM printer_profiles WHERE kind = ? AND is_default = 1 AND is_active = 1 AND deleted_at IS NULL ORDER BY id LIMIT 1`,
          )
          .get(kind) as Record<string, unknown> | undefined);
    if (row) return mapProfileToResolved(mapProfile(row));
    const paper = PAPER_SIZES[0];
    return {
      id: null,
      name: 'Default A4',
      widthMm: paper?.widthMm ?? 210,
      heightMm: paper?.heightMm ?? 297,
      orientation: 'portrait',
      marginTopMm: 12,
      marginRightMm: 12,
      marginBottomMm: 12,
      marginLeftMm: 12,
      scalePercent: 100,
      copies: 1,
      printerName: '',
      isThermal: false,
      headerNote: '',
      footerNote: '',
    };
  }

  // --- Rendering ----------------------------------------------------------

  async render(request: PrintRenderRequest): Promise<PrintRenderResult> {
    const ctx = this.context();
    if (request.kind === 'report') {
      if (!request.report) throw AppError.validation('Choose a report to print.', { report: 'A report request is required.' });
      const result = await this.renderReport(request.report, request.output === 'print' ? 'print' : 'pdf');
      return {
        kind: 'report',
        output: request.output,
        pdfPath: result.path,
        pageCount: 0,
        widthMm: 210,
        heightMm: 297,
        printerName: null,
        copies: 1,
        bytes: 0,
      };
    }

    requirePermission(ctx, permissionForKind(request.kind));
    const document = await this.buildDocument(request);
    const resolved = this.resolveProfile(request.kind, request.profileId);
    const copies =
      request.copies === null || request.copies === undefined
        ? resolved.copies
        : Math.min(Math.max(Math.round(request.copies), 1), 10);
    const profile: ResolvedProfile = { ...resolved, copies };
    const options: PrintRenderOptions = { ...profile, jobName: document.jobName, fontCss: this.fontCss };

    if (!this.host) {
      throw AppError.precondition('Printing needs the desktop application. Run Dentiva Pro to print or export a PDF.');
    }

    let pdfPath: string | null = null;
    let pageCount = 0;
    let bytes = 0;
    let printerName: string | null = null;

    if (request.output === 'print') {
      // A profile may leave the printer blank to mean "whatever Windows has set
      // as default"; resolve that now so the receipt shows where it went.
      let sendOptions = options;
      if (!sendOptions.printerName) {
        const printers = await this.host.listPrinters();
        const preferred = printers.find((entry) => entry.isDefault) ?? printers[0];
        if (preferred) sendOptions = { ...sendOptions, printerName: preferred.name };
      }
      const printed = await this.host.send(document.html, sendOptions);
      pageCount = printed.pageCount;
      bytes = printed.bytes;
      printerName = sendOptions.printerName || null;
    } else {
      const rendered = await this.host.toPdf(document.html, options);
      pdfPath = rendered.path;
      pageCount = rendered.pageCount;
      bytes = rendered.bytes;
      if (request.output === 'preview') await this.host.reveal(rendered.path);
    }

    if (request.kind === 'prescription' && request.id && request.output === 'print') {
      // Only a real print counts towards the "printed" marker; a PDF preview
      // must not make a prescription look like it was handed to the patient.
      this.prescriptions.markPrinted(request.id);
    }

    ctx.audit.record({
      action: 'print',
      entityType: request.kind,
      entityId: request.id ?? null,
      entityLabel: document.jobName,
      detail:
        request.output === 'print'
          ? `${document.title} sent to ${printerName ?? 'the default printer'} (${profile.copies} cop${profile.copies === 1 ? 'y' : 'ies'})`
          : `${document.title} exported as PDF${pdfPath ? ` to ${pdfPath}` : ''}`,
    });

    return {
      kind: request.kind,
      output: request.output,
      pdfPath,
      pageCount,
      widthMm: profile.widthMm,
      heightMm: profile.heightMm,
      printerName,
      copies: profile.copies,
      bytes,
    };
  }

  /** ReportPrinterPort: used by `reports.export` when the format is pdf/print. */
  async renderReport(request: ReportRequest, output: 'pdf' | 'print'): Promise<{ path: string | null; printed: boolean }> {
    const ctx = this.context();
    requirePermission(ctx, 'report.export');
    const reports = this.reports();
    if (!reports) throw AppError.precondition('Reports are not available yet.');
    const result = reports.run(request);
    const profile = this.resolveProfile('report', null);
    const html = documentShell({
      title: result.title,
      header: await this.clinicHeader(),
      profile,
      template: null,
      accent: '#0e2c49',
      body: reportBody(result),
    });
    const options: PrintRenderOptions = {
      ...profile,
      jobName: `${result.title} ${result.range.from} to ${result.range.to}`,
      fontCss: this.fontCss,
    };
    if (!this.host) throw AppError.precondition('Printing needs the desktop application.');

    if (output === 'print') {
      await this.host.send(html, options);
      ctx.audit.record({
        action: 'print',
        entityType: 'report',
        entityLabel: result.title,
        detail: `${result.title} printed (${result.rowCount} row(s))`,
      });
      return { path: null, printed: true };
    }
    const rendered = await this.host.toPdf(html, options);
    ctx.audit.record({
      action: 'export',
      entityType: 'report',
      entityLabel: result.title,
      detail: `${result.title} exported as PDF (${result.rowCount} row(s))`,
      severity: 'warning',
    });
    return { path: rendered.path, printed: false };
  }

  /**
   * Build the printable HTML for a document. Exposed so tests (and the renderer
   * preview) can inspect the exact markup without a printer.
   */
  async buildDocument(request: PrintRenderRequest): Promise<{ html: string; title: string; jobName: string }> {
    const ctx = this.context();
    requirePermission(ctx, permissionForKind(request.kind));
    const template = this.template(request.kind, request.templateId);
    const profile = this.resolveProfile(request.kind, request.profileId);

    switch (request.kind) {
      case 'prescription': {
        if (!request.id) throw AppError.validation('Choose a prescription to print.', { id: 'A prescription is required.' });
        const data = this.prescriptions.forPrint(request.id);
        const header = await this.clinicHeaderFrom(data.clinic);
        const signature = await this.dataUrlFor(data.dentist?.signaturePath ?? null);
        return {
          html: documentShell({
            title: `Prescription ${data.prescription.number}`,
            header,
            profile,
            template,
            accent: '#0f9d8f',
            body: prescriptionBody(data, template, signature),
          }),
          title: `Prescription ${data.prescription.number}`,
          jobName: `Prescription ${data.prescription.number} — ${data.prescription.patientName}`,
        };
      }
      case 'invoice': {
        if (!request.id) throw AppError.validation('Choose an invoice to print.', { id: 'An invoice is required.' });
        const data = this.invoices.forPrint(request.id);
        const header = await this.clinicHeaderFrom({
          name: data.clinic.name,
          address: data.clinic.address,
          phone: data.clinic.phone,
          email: data.clinic.email,
          logoPath: data.clinic.logoPath,
          clinicMessage: '',
        });
        return {
          html: documentShell({
            title: `Invoice ${data.invoice.number}`,
            header,
            profile,
            template,
            accent: '#0e2c49',
            body: invoiceBody(data, template, data.clinic.footerNote),
          }),
          title: `Invoice ${data.invoice.number}`,
          jobName: `Invoice ${data.invoice.number} — ${data.invoice.patientName}`,
        };
      }
      case 'patient_summary': {
        if (!request.id) throw AppError.validation('Choose a patient.', { id: 'A patient is required.' });
        const data = await this.patientSummary(request.id);
        const header = await this.clinicHeader();
        return {
          html: documentShell({
            title: `Patient summary ${data.patient.name}`,
            header,
            profile,
            template,
            accent: '#0e2c49',
            body: patientSummaryBody(data),
          }),
          title: `Patient summary ${data.patient.name}`,
          jobName: `Patient summary — ${data.patient.name}`,
        };
      }
      default:
        throw AppError.validation('Choose a document to print.', { kind: 'That document type cannot be printed.' });
    }
  }

  async previewHtml(request: PrintRenderRequest): Promise<string> {
    const document = await this.buildDocument(request);
    return document.html;
  }

  private async patientSummary(patientId: number): Promise<{
    patient: PatientDetail;
    financial: ReturnType<PatientService['financialSummary']> | null;
    visits: readonly VisitSummary[];
    plans: readonly TreatmentPlan[];
    treatments: ReadonlyArray<{ description: string; toothCodes: readonly string[]; totalPaisa: number; performedAt: string }>;
  }> {
    const ctx = this.context();
    const patient = this.patients.get(patientId);
    let financial: ReturnType<PatientService['financialSummary']> | null = null;
    if (hasPermission(ctx, 'invoice.view') || hasPermission(ctx, 'report.financial.view')) {
      try {
        financial = this.patients.financialSummary(patientId);
      } catch {
        financial = null;
      }
    }
    const visits = this.visits.byPatient(patientId, 20);
    const plans = this.treatments.listPlans({ patientId, pageSize: 20 }).items;
    const treatments = this.treatments.recordsByPatient(patientId, 40).map((record) => ({
      description: record.description,
      toothCodes: record.toothCodes,
      totalPaisa: record.totalPaisa,
      performedAt: record.performedAt,
    }));
    return { patient, financial, visits, plans, treatments };
  }

  private async dataUrlFor(relativePath: string | null): Promise<string | null> {
    const absolute = this.attachments.profileImagePath(relativePath);
    if (!absolute) return null;
    try {
      const extension = /\.png$/i.test(relativePath ?? '') ? 'image/png' : /\.webp$/i.test(relativePath ?? '') ? 'image/webp' : 'image/jpeg';
      return `data:${extension};base64,${(await readFile(absolute)).toString('base64')}`;
    } catch {
      return null;
    }
  }

  private async clinicHeaderFrom(clinic: {
    name: string;
    address: string;
    phone: string;
    email: string;
    logoPath: string | null;
    clinicMessage: string;
  }): Promise<ClinicHeader> {
    const full = await this.clinicHeader();
    return {
      ...full,
      name: clinic.name || full.name,
      address: clinic.address || full.address,
      phone: clinic.phone || full.phone,
      email: clinic.email || full.email,
      message: clinic.clinicMessage || full.message,
      logoDataUrl: (await this.dataUrlFor(clinic.logoPath)) ?? full.logoDataUrl,
    };
  }

  private async clinicHeader(): Promise<ClinicHeader> {
    const row = this.db.prepare(`SELECT * FROM clinic WHERE id = 1`).get() as Record<string, unknown> | undefined;
    const settings = (key: string): string => {
      const entry = this.db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as { value: string } | undefined;
      if (!entry) return '';
      try {
        const parsed = JSON.parse(entry.value) as unknown;
        return typeof parsed === 'string' ? parsed : '';
      } catch {
        return '';
      }
    };
    return {
      name: asString(row?.['name']),
      address: asString(row?.['address']),
      phone: asString(row?.['phone']),
      email: asString(row?.['email']),
      website: asString(row?.['website']),
      registrationNumber: asString(row?.['registration_number']),
      visitingHours: asString(row?.['visiting_hours']),
      message: asString(row?.['clinic_message']) || settings('prescriptionFooterNote'),
      logoDataUrl: await this.dataUrlFor(asString(row?.['logo_path']) || null),
    };
  }
}
