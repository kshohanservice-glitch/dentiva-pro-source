/**
 * Settings centre.
 *
 * Everything the clinic can tune lives here: identity, appearance, formats,
 * clinical defaults, security, printing and — at the bottom, deliberately
 * separated — the destructive operations that require a typed confirmation.
 */
import { useEffect, useState } from 'react';
import { Printer, RotateCcw, Trash2, Upload } from 'lucide-react';
import { APP_BUILD_NUMBER, APP_NAME, APP_VERSION } from '@shared/app-info';
import {
  AUTO_LOCK_OPTIONS,
  BACKUP_INTERVAL_OPTIONS,
  DENSITY_MODES,
  NUMBER_GROUPINGS,
  PAPER_SIZES,
  PRINT_TEMPLATE_KINDS,
  THEME_MODES,
  TOOTH_NUMBERING_SYSTEMS,
  DATE_FORMATS,
  TIME_FORMATS,
  TIME_ZONES,
} from '@shared/constants';
import type { AppSettings, ClinicProfile } from '@shared/types';
import { useAction, useApi, useApp } from '@renderer/state/store';
import { bridge, resolveSourcePath } from '@renderer/lib/bridge';
import { fmtInstant, num, text } from '@renderer/lib/format';
import {
  Banner,
  Button,
  Card,
  DefinitionList,
  Empty,
  Field,
  Input,
  LoadingBlock,
  Modal,
  Page,
  ProgressBar,
  Segmented,
  Select,
  Switch,
  Tabs,
  TextArea,
} from '@renderer/components/ui';
import { DataTable, TextField } from '@renderer/components/forms';
import { ResourceManager } from '@renderer/components/resource-manager';

const TABS = [
  { key: 'clinic', label: 'Clinic' },
  { key: 'appearance', label: 'Appearance & formats' },
  { key: 'clinical', label: 'Clinical defaults' },
  { key: 'security', label: 'Security' },
  { key: 'printing', label: 'Printing' },
  { key: 'data', label: 'Data & danger zone' },
];

function ClinicPanel(): JSX.Element {
  const { refresh, toast } = useApp();
  const { run, busy } = useAction();
  const clinic = useApi('clinic.get', undefined);
  const [form, setForm] = useState<Omit<ClinicProfile, 'id' | 'logoPath' | 'updatedAt'>>({
    name: '',
    address: '',
    phone: '',
    email: '',
    website: '',
    clinicMessage: '',
    visitingHours: '',
    registrationNumber: '',
  });
  const [logoPath, setLogoPath] = useState<string | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);

  useEffect(() => {
    if (!clinic.data) return;
    setForm({
      name: clinic.data.name,
      address: clinic.data.address,
      phone: clinic.data.phone,
      email: clinic.data.email,
      website: clinic.data.website,
      clinicMessage: clinic.data.clinicMessage,
      visitingHours: clinic.data.visitingHours,
      registrationNumber: clinic.data.registrationNumber,
    });
  }, [clinic.data]);

  if (clinic.loading && !clinic.data) return <LoadingBlock rows={6} />;

  return (
    <Card title="Clinic profile" subtitle="Printed on every prescription, invoice, report and receipt.">
      <div className="stack">
        <div className="grid-2">
          <TextField label="Clinic name" required value={form.name} onChange={(value) => setForm({ ...form, name: value })} />
          <TextField
            label="Registration number"
            value={form.registrationNumber}
            onChange={(value) => setForm({ ...form, registrationNumber: value })}
          />
        </div>
        <Field label="Address">
          <TextArea rows={2} value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} />
        </Field>
        <div className="grid-3">
          <TextField label="Phone" value={form.phone} onChange={(value) => setForm({ ...form, phone: value })} />
          <TextField label="Email" value={form.email} onChange={(value) => setForm({ ...form, email: value })} />
          <TextField label="Website" value={form.website} onChange={(value) => setForm({ ...form, website: value })} />
        </div>
        <div className="grid-2">
          <TextField label="Visiting hours" value={form.visitingHours} onChange={(value) => setForm({ ...form, visitingHours: value })} />
          <Field label="Logo">
            <div className="row" style={{ gap: 10 }}>
              <label className="btn btn--ghost btn--sm">
                <Upload size={14} /> Choose image
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  style={{ display: 'none' }}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    setLogoPath(await resolveSourcePath(file));
                    setRemoveLogo(false);
                  }}
                />
              </label>
              {clinic.data?.logoPath ? <Switch label="Remove current logo" checked={removeLogo} onChange={setRemoveLogo} /> : null}
              <span className="small muted">
                {logoPath ? 'New logo selected' : clinic.data?.logoPath ? 'Stored logo in use' : 'No logo yet'}
              </span>
            </div>
          </Field>
        </div>
        <Field label="Message at the foot of documents" hint="A thank-you note or clinic instruction">
          <TextArea rows={2} value={form.clinicMessage} onChange={(event) => setForm({ ...form, clinicMessage: event.target.value })} />
        </Field>
        <div className="row row--end">
          <Button
            variant="primary"
            loading={busy}
            disabled={form.name.trim().length < 2}
            onClick={async () => {
              const saved = await run(
                () =>
                  bridge.invoke('clinic.update', {
                    ...form,
                    logoSourcePath: logoPath,
                    removeLogo: removeLogo || undefined,
                  }),
                { success: 'Clinic profile saved.', failure: 'The clinic profile could not be saved.' },
              );
              if (saved) {
                setLogoPath(null);
                setRemoveLogo(false);
                clinic.reload();
                await refresh();
                toast('success', 'Clinic profile updated');
              }
            }}
          >
            Save clinic profile
          </Button>
        </div>
      </div>
    </Card>
  );
}

function SettingsForm({ settings, onSaved }: { settings: AppSettings | null; onSaved(): void }): JSX.Element {
  const { runOk, busy } = useAction();
  const [patch, setPatch] = useState<Partial<AppSettings>>({});

  useEffect(() => {
    setPatch({});
  }, [settings]);

  const value = <K extends keyof AppSettings>(key: K): AppSettings[K] | undefined =>
    patch[key] !== undefined ? patch[key] : settings?.[key];
  const set = (next: Partial<AppSettings>) => setPatch((current) => ({ ...current, ...next }));
  const dirty = Object.keys(patch).length > 0;

  const save = async () => {
    const saved = await runOk(() => bridge.invoke('settings.update', { patch }), {
      success: 'Settings saved.',
      failure: 'Some settings could not be saved.',
    });
    if (saved) {
      setPatch({});
      onSaved();
    }
  };

  return (
    <div className="stack">
      <Card title="Appearance" subtitle="The interface adapts to the screen; nothing is stored online.">
        <div className="grid-2">
          <Field label="Theme">
            <Segmented
              value={String(value('theme') ?? 'system')}
              options={THEME_MODES.map((option) => ({ value: option.value, label: option.label }))}
              onChange={(next) => set({ theme: next as AppSettings['theme'] })}
            />
          </Field>
          <Field label="Density" hint="Compact fits more rows on a 1366×768 screen.">
            <Segmented
              value={String(value('density') ?? 'comfortable')}
              options={DENSITY_MODES.map((option) => ({ value: option.value, label: option.label }))}
              onChange={(next) => set({ density: next as AppSettings['density'] })}
            />
          </Field>
        </div>
      </Card>

      <Card title="Dates, time and numbers">
        <div className="grid-3">
          <Field label="Date format">
            <Select
              value={String(value('dateFormat') ?? 'DD MMM YYYY')}
              options={DATE_FORMATS.map((option) => ({ value: option.value, label: `${option.label} — ${option.example}` }))}
              onChange={(event) => set({ dateFormat: event.target.value })}
            />
          </Field>
          <Field label="Time format">
            <Select
              value={String(value('timeFormat') ?? 'hh:mm A')}
              options={TIME_FORMATS.map((option) => ({ value: option.value, label: `${option.label} — ${option.example}` }))}
              onChange={(event) => set({ timeFormat: event.target.value })}
            />
          </Field>
          <Field label="Time zone">
            <Select
              value={String(value('timeZone') ?? 'Asia/Dhaka')}
              options={TIME_ZONES.map((zone: string) => ({ value: zone, label: zone }))}
              onChange={(event) => set({ timeZone: event.target.value })}
            />
          </Field>
        </div>
        <div className="stack" style={{ marginTop: 'var(--space-4)' }}>
          <Field label="Number grouping" hint="How thousands are separated in printed amounts">
            <Segmented
              value={String(value('numberGrouping') ?? 'international')}
              options={NUMBER_GROUPINGS.map((option) => ({ value: option.value, label: option.label }))}
              onChange={(next) => set({ numberGrouping: next as AppSettings['numberGrouping'] })}
            />
          </Field>
        </div>
      </Card>

      <Card title="Clinical defaults">
        <div className="grid-3">
          <Field label="Tooth numbering">
            <Select
              value={String(value('defaultToothNumbering') ?? 'fdi')}
              options={TOOTH_NUMBERING_SYSTEMS.map((option) => ({ value: option.value, label: option.label }))}
              onChange={(event) => set({ defaultToothNumbering: event.target.value as AppSettings['defaultToothNumbering'] })}
            />
          </Field>
          <Field label="Default dentition">
            <Select
              value={String(value('defaultDentition') ?? 'permanent')}
              options={[
                { value: 'permanent', label: 'Permanent (adult)' },
                { value: 'primary', label: 'Primary (pediatric)' },
              ]}
              onChange={(event) => set({ defaultDentition: event.target.value as AppSettings['defaultDentition'] })}
            />
          </Field>
          <Field label="Appointment slot (minutes)">
            <Input
              className="input--numeric"
              inputMode="numeric"
              value={String(value('appointmentSlotMinutes') ?? 30)}
              onChange={(event) => set({ appointmentSlotMinutes: Number(event.target.value) || 30 })}
            />
          </Field>
        </div>
        <div className="grid-3" style={{ marginTop: 'var(--space-4)' }}>
          <TextField
            label="Queue prefix"
            hint="Printed on the token, e.g. Q-07"
            value={String(value('queuePrefix') ?? 'Q')}
            onChange={(next) => set({ queuePrefix: next })}
          />
          <TextField
            label="Low-stock warning factor"
            hint="1.0 warns at the reorder level; 1.5 warns earlier"
            value={String(value('lowStockWarningFactor') ?? 1)}
            onChange={(next) => set({ lowStockWarningFactor: Number(next) || 1 })}
          />
          <TextField
            label="Expiry warning (days)"
            hint="How far ahead to warn before a batch expires"
            value={String(value('expiryWarningDays') ?? 60)}
            onChange={(next) => set({ expiryWarningDays: Number(next) || 60 })}
          />
        </div>
        <div className="stack" style={{ marginTop: 'var(--space-4)' }}>
          <Field label="Prescription footer note">
            <TextArea
              rows={2}
              value={String(value('prescriptionFooterNote') ?? '')}
              onChange={(event) => set({ prescriptionFooterNote: event.target.value })}
            />
          </Field>
          <Field label="Invoice footer note">
            <TextArea
              rows={2}
              value={String(value('invoiceFooterNote') ?? '')}
              onChange={(event) => set({ invoiceFooterNote: event.target.value })}
            />
          </Field>
          <Switch
            label="Show financial figures to staff without financial permission"
            checked={Boolean(value('showFinancialWidgetsForStaff'))}
            onChange={(next) => set({ showFinancialWidgetsForStaff: next })}
          />
        </div>
      </Card>

      <Card title="Security">
        <div className="grid-3">
          <Field label="Auto-lock after inactivity">
            <Select
              value={String(value('autoLockMinutes') ?? 10)}
              options={AUTO_LOCK_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))}
              onChange={(event) => set({ autoLockMinutes: Number(event.target.value) as AppSettings['autoLockMinutes'] })}
            />
          </Field>
          <Field label="Minimum password length">
            <Input
              className="input--numeric"
              inputMode="numeric"
              value={String(value('passwordMinLength') ?? 8)}
              onChange={(event) => set({ passwordMinLength: Number(event.target.value) || 8 })}
            />
          </Field>
          <Field label="Automatic backup">
            <Select
              value={String(value('backupIntervalDays') ?? 7)}
              options={BACKUP_INTERVAL_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))}
              onChange={(event) => set({ backupIntervalDays: Number(event.target.value) as AppSettings['backupIntervalDays'] })}
            />
          </Field>
        </div>
        <div className="grid-3" style={{ marginTop: 'var(--space-4)' }}>
          <Field label="Failed sign-ins before lockout">
            <Input
              className="input--numeric"
              inputMode="numeric"
              value={String(value('maxFailedAttempts') ?? 5)}
              onChange={(event) => set({ maxFailedAttempts: Number(event.target.value) || 5 })}
            />
          </Field>
          <Field label="Lockout duration (minutes)">
            <Input
              className="input--numeric"
              inputMode="numeric"
              value={String(value('lockoutMinutes') ?? 15)}
              onChange={(event) => set({ lockoutMinutes: Number(event.target.value) || 15 })}
            />
          </Field>
          <TextField
            label="Backup folder"
            hint="Leave empty to keep backups with the data"
            value={String(value('backupFolder') ?? '')}
            onChange={(next) => set({ backupFolder: next })}
          />
        </div>
        <div className="row row--end" style={{ marginTop: 'var(--space-4)' }}>
          <Button variant="primary" loading={busy} disabled={!dirty} onClick={() => void save()}>
            {dirty ? `Save ${Object.keys(patch).length} change(s)` : 'Saved'}
          </Button>
        </div>
      </Card>

      {settings ? (
        <Card title="Current configuration" padded={false}>
          <div style={{ padding: 'var(--space-4)' }}>
            <DefinitionList
              items={[
                {
                  label: 'Last automatic backup',
                  value: settings.lastAutomaticBackupAt ? fmtInstant(settings.lastAutomaticBackupAt) : 'Never',
                },
                {
                  label: 'Default prescription profile',
                  value: settings.defaultPrescriptionProfileId ? `#${settings.defaultPrescriptionProfileId}` : 'Not set',
                },
                {
                  label: 'Default invoice profile',
                  value: settings.defaultInvoiceProfileId ? `#${settings.defaultInvoiceProfileId}` : 'Not set',
                },
                {
                  label: 'Default report profile',
                  value: settings.defaultReportProfileId ? `#${settings.defaultReportProfileId}` : 'Not set',
                },
              ]}
            />
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function PrintingPanel(): JSX.Element {
  const { toast } = useApp();
  const { busy } = useAction();
  const printers = useApi('print.systemPrinters', undefined);
  const [testKind, setTestKind] = useState<'prescription' | 'invoice'>('prescription');

  const testPage = async () => {
    const profile = await bridge.invoke('print.defaultProfile', { kind: testKind });
    if (!profile) {
      toast('warning', 'No printer profile', `Create a ${testKind} profile below before printing a test page.`);
      return;
    }
    toast(
      'info',
      'Test page',
      `${profile.name} · ${profile.printerName || 'system default printer'} · ${profile.widthMm}×${profile.heightMm} mm`,
    );
  };

  return (
    <div className="stack">
      <Card
        title="Printers available on this computer"
        subtitle={`${(printers.data ?? []).length} printer(s) reported by Windows`}
        actions={<Button onClick={printers.reload}>Refresh</Button>}
        padded={false}
      >
        <DataTable
          columns={[
            { key: 'name', label: 'Printer' },
            { key: 'default', label: 'System default' },
            { key: 'status', label: 'Status' },
          ]}
          rows={(printers.data ?? []).map((printer) => ({
            name: printer.name,
            default: printer.isDefault ? 'Yes' : '—',
            status: printer.status || 'Ready',
          }))}
          loading={printers.loading && !printers.data}
          rowKey={(index) => String(printers.data?.[index]?.name ?? index)}
          empty={<Empty title="No printers detected" text="Install the printer in Windows, then refresh." />}
        />
      </Card>

      <Card
        title="Test print"
        subtitle="Confirms the profile, paper size and printer work together before a patient is waiting."
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Segmented
              value={testKind}
              options={[
                { value: 'prescription', label: 'Prescription' },
                { value: 'invoice', label: 'Invoice' },
              ]}
              onChange={(value) => setTestKind(value as 'prescription' | 'invoice')}
            />
            <Button variant="primary" loading={busy} onClick={() => void testPage()}>
              <Printer size={14} /> Check profile
            </Button>
          </div>
        }
      >
        <p className="small muted" style={{ margin: 0 }}>
          A test page uses the default {testKind} profile. Adjust the profile below if margins or the paper size are wrong.
        </p>
      </Card>

      <ResourceManager
        resource="printer-profiles"
        title="Printer profiles"
        description="One profile per printer and paper combination; the default profile is used unless a document says otherwise."
        includeInactive
        emptyText="No printer profiles yet."
        columns={[
          { key: 'name', label: 'Profile' },
          { key: 'kind', label: 'Document' },
          { key: 'printerName', label: 'Printer', render: (row) => text(row['printerName']) || 'System default' },
          { key: 'paperKey', label: 'Paper', render: (row) => text(row['paperKey']).toUpperCase() },
          { key: 'size', label: 'Size (mm)', render: (row) => `${num(row['widthMm'])} × ${num(row['heightMm'])}` },
          { key: 'isDefault', label: 'Default', render: (row) => (row['isDefault'] ? 'Yes' : '—') },
          { key: 'isActive', label: 'Active', render: (row) => (row['isActive'] ? 'Yes' : 'No') },
        ]}
        fields={[
          { key: 'name', label: 'Profile name', type: 'text', required: true },
          {
            key: 'kind',
            label: 'Document',
            type: 'select',
            required: true,
            defaultValue: 'prescription',
            options: PRINT_TEMPLATE_KINDS.map((option) => ({ value: option.value, label: option.label })),
          },
          { key: 'printerName', label: 'Printer name', type: 'text', hint: 'Leave empty for the Windows default printer' },
          {
            key: 'paperKey',
            label: 'Paper',
            type: 'select',
            required: true,
            defaultValue: 'a4',
            options: PAPER_SIZES.map((size) => ({ value: size.key, label: size.label })),
          },
          { key: 'widthMm', label: 'Width (mm)', type: 'number', defaultValue: 210 },
          { key: 'heightMm', label: 'Height (mm)', type: 'number', defaultValue: 297 },
          {
            key: 'orientation',
            label: 'Orientation',
            type: 'select',
            defaultValue: 'portrait',
            options: [
              { value: 'portrait', label: 'Portrait' },
              { value: 'landscape', label: 'Landscape' },
            ],
          },
          { key: 'marginTopMm', label: 'Margin top (mm)', type: 'number', defaultValue: 10 },
          { key: 'marginRightMm', label: 'Margin right (mm)', type: 'number', defaultValue: 10 },
          { key: 'marginBottomMm', label: 'Margin bottom (mm)', type: 'number', defaultValue: 10 },
          { key: 'marginLeftMm', label: 'Margin left (mm)', type: 'number', defaultValue: 10 },
          { key: 'scalePercent', label: 'Scale (%)', type: 'number', defaultValue: 100 },
          { key: 'copies', label: 'Copies', type: 'number', defaultValue: 1 },
          { key: 'isThermal', label: 'Thermal roll', type: 'switch', defaultValue: false },
          { key: 'isDefault', label: 'Default for this document', type: 'switch', defaultValue: false },
          { key: 'isActive', label: 'Active', type: 'switch', defaultValue: true },
          { key: 'headerNote', label: 'Header note', type: 'text' },
          { key: 'footerNote', label: 'Footer note', type: 'text' },
        ]}
      />

      <ResourceManager
        resource="print-templates"
        title="Document templates"
        description="Layout choices for prescriptions, invoices, reports and patient summaries."
        emptyText="No templates yet."
        columns={[
          { key: 'name', label: 'Template' },
          { key: 'kind', label: 'Document' },
          { key: 'showLogo', label: 'Logo', render: (row) => (row['showLogo'] ? 'Yes' : 'No') },
          {
            key: 'signature',
            label: 'Signature',
            render: (row) => (row['showDentistSignature'] ? 'Shown' : 'Hidden'),
          },
          { key: 'isDefault', label: 'Default', render: (row) => (row['isDefault'] ? 'Yes' : '—') },
        ]}
        fields={[
          {
            key: 'kind',
            label: 'Document',
            type: 'select',
            required: true,
            defaultValue: 'prescription',
            options: PRINT_TEMPLATE_KINDS.map((option) => ({ value: option.value, label: option.label })),
          },
          { key: 'name', label: 'Template name', type: 'text', required: true },
          { key: 'headerText', label: 'Header text', type: 'textarea' },
          { key: 'footerText', label: 'Footer text', type: 'textarea' },
          { key: 'showLogo', label: 'Show clinic logo', type: 'switch', defaultValue: true },
          { key: 'showDentistSignature', label: 'Show dentist signature', type: 'switch', defaultValue: true },
          {
            key: 'showDentistQualifications',
            label: 'Show qualifications under the signature',
            type: 'switch',
            defaultValue: true,
          },
          { key: 'signatureLabel', label: 'Signature label', type: 'text', defaultValue: 'Signature' },
          {
            key: 'accentColour',
            label: 'Accent colour',
            type: 'text',
            defaultValue: '#0f766e',
            hint: 'Hex colour used for rules and headings',
          },
          { key: 'isDefault', label: 'Default for this document', type: 'switch', defaultValue: false },
        ]}
      />
    </div>
  );
}

function DangerPanel(): JSX.Element {
  const { confirm, toast, refresh } = useApp();
  const { run, busy } = useAction();
  const summary = useApi('system.dataSummary', undefined);
  const [resetOpen, setResetOpen] = useState(false);
  const [scope, setScope] = useState<'clinical' | 'financial' | 'all'>('clinical');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState('');
  const [importPreview, setImportPreview] = useState<{
    imported: number;
    skipped: number;
    errors: Array<{ row: number; message: string }>;
    preview: Array<Record<string, string>>;
  } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const reset = async () => {
    const answer = await confirm({
      title: 'Erase data',
      description:
        scope === 'all'
          ? 'Every patient, clinical and financial record is removed. Users, settings and your backups stay.'
          : scope === 'clinical'
            ? 'Patients, visits, appointments, prescriptions, charting and treatment records are removed.'
            : 'Invoices, payments, accounting entries and stock are removed; clinical records stay.',
      confirmLabel: 'Erase data',
      tone: 'danger',
      typedWord: scope === 'all' ? 'RESET ALL' : scope === 'financial' ? 'RESET FINANCIAL' : 'RESET CLINICAL',
      reason: true,
    });
    if (!answer.ok || !answer.typed) return;
    setProgress('A safety backup is being taken…');
    const result = await run(() => bridge.invoke('system.resetData', { scope, confirmText: answer.typed!, backupFirst: true }), {
      failure: 'The data could not be erased.',
    });
    setProgress(null);
    if (result) {
      setResetOpen(false);
      summary.reload();
      toast('success', 'Data erased', result.backupPath ? `Safety backup: ${result.backupPath}` : 'No backup was requested.');
      await refresh();
    }
  };

  const deleteBusiness = async () => {
    const answer = await confirm({
      title: 'Delete the entire clinic',
      description:
        'Patients, documents, invoices, stock, staff, users and settings are all erased and the' +
        ' application returns to first-run setup. Backups survive so the clinic can be restored.',
      confirmLabel: 'Delete everything',
      tone: 'danger',
      typedWord: 'DELETE BUSINESS',
      reason: true,
    });
    if (!answer.ok || !answer.typed) return;
    setProgress('Taking a final safety backup, then erasing…');
    const result = await run(() => bridge.invoke('system.deleteBusiness', { password, confirmText: answer.typed!, backupFirst: true }), {
      failure: 'The clinic could not be deleted.',
    });
    setProgress(null);
    if (result) {
      setDeleteOpen(false);
      toast('success', 'The clinic was deleted', result.backupPath ? `Safety backup kept at ${result.backupPath}` : '');
      await refresh();
    }
  };

  const runImport = async (commit: boolean) => {
    const result = await run(() => bridge.invoke('system.importPatients', { filePath: commit ? importFile || null : null, commit }), {
      failure: 'The file could not be read.',
    });
    if (!result) return;
    setImportPreview(result);
    if (commit) {
      toast('success', 'Import finished', `${result.imported} imported · ${result.skipped} skipped`);
      summary.reload();
    }
  };

  return (
    <div className="stack">
      {progress ? <ProgressBar percent={-1} label={progress} /> : null}
      <Banner tone="warning" title="These actions cannot be undone from the interface">
        Each one asks for a typed confirmation and takes a safety backup first. Store that backup somewhere else before you continue.
      </Banner>

      <Card title="What is currently stored" padded={false}>
        <DataTable
          columns={[
            { key: 'label', label: 'Record type' },
            { key: 'count', label: 'Count', align: 'right' },
          ]}
          rows={[
            { label: 'Patients', count: String(summary.data?.patients ?? 0) },
            { label: 'Visits', count: String(summary.data?.visits ?? 0) },
            { label: 'Prescriptions', count: String(summary.data?.prescriptions ?? 0) },
            { label: 'Invoices', count: String(summary.data?.invoices ?? 0) },
            { label: 'Payments', count: String(summary.data?.payments ?? 0) },
            { label: 'Attachments', count: String(summary.data?.attachments ?? 0) },
          ]}
          rowKey={(index) => `danger-${index}`}
          empty={<Empty title="Nothing stored" />}
        />
      </Card>

      <Card title="Import patients from a spreadsheet">
        <div className="stack">
          <p className="small muted" style={{ margin: 0 }}>
            Prepare a CSV file with a header row. Nothing is written until you press Import: the first pass only shows what would happen.
          </p>
          <div className="row" style={{ gap: 10 }}>
            <Button onClick={() => void runImport(false)} loading={busy}>
              Preview a file
            </Button>
            <Button variant="primary" disabled={!importPreview || importPreview.preview.length === 0} onClick={() => setImportOpen(true)}>
              Import {importPreview?.preview.length ? `${importPreview.preview.length} row(s)` : ''}
            </Button>
          </div>
          {importPreview ? (
            <>
              {importPreview.errors.length > 0 ? (
                <Banner tone="warning" title={`${importPreview.errors.length} row(s) could not be read`}>
                  <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                    {importPreview.errors.slice(0, 6).map((error) => (
                      <li key={`${error.row}-${error.message}`}>
                        Row {error.row}: {error.message}
                      </li>
                    ))}
                  </ul>
                </Banner>
              ) : null}
              <DataTable
                columns={Object.keys(importPreview.preview[0] ?? {}).map((key) => ({ key, label: key }))}
                rows={importPreview.preview.slice(0, 20)}
                rowKey={(index) => `import-${index}`}
                empty={<Empty title="Nothing to import" />}
              />
            </>
          ) : null}
        </div>
      </Card>

      <Card title="Erase data">
        <div className="row row--between">
          <div>
            <div>Erase records while keeping the clinic configured</div>
            <div className="small muted">Useful after training, or to start a fresh financial year.</div>
          </div>
          <Button variant="danger" onClick={() => setResetOpen(true)}>
            <RotateCcw size={14} /> Erase data…
          </Button>
        </div>
      </Card>

      <Card title="Delete the entire clinic">
        <div className="row row--between">
          <div>
            <div>Remove every record, user and setting</div>
            <div className="small muted">The application returns to the first-run wizard. Backups are kept on disk.</div>
          </div>
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>
            <Trash2 size={14} /> Delete everything…
          </Button>
        </div>
      </Card>

      <Modal
        open={resetOpen}
        width="narrow"
        title="Erase data"
        onClose={() => setResetOpen(false)}
        footer={
          <div className="row row--end">
            <Button variant="ghost" onClick={() => setResetOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void reset()}>
              Continue
            </Button>
          </div>
        }
      >
        <div className="stack">
          <Field label="What should be erased?">
            <Select
              value={scope}
              options={[
                { value: 'clinical', label: 'Clinical records only' },
                { value: 'financial', label: 'Financial records only' },
                { value: 'all', label: 'Everything (clinical and financial)' },
              ]}
              onChange={(event) => setScope(event.target.value as typeof scope)}
            />
          </Field>
          <Banner tone="warning" title="A safety backup is taken first">
            You will still be asked to type the confirmation word in the next dialog.
          </Banner>
        </div>
      </Modal>

      <Modal
        open={deleteOpen}
        width="narrow"
        title="Delete the entire clinic"
        onClose={() => setDeleteOpen(false)}
        footer={
          <div className="row row--end">
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} disabled={password.length === 0} onClick={() => void deleteBusiness()}>
              Delete everything
            </Button>
          </div>
        }
      >
        <div className="stack">
          <Field label="Your password" required hint="Confirms that you are the account holder">
            <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </Field>
          <Banner tone="danger" title="This is the last step">
            Enter your password, then type DELETE BUSINESS in the confirmation dialog. The application restarts at the first-run wizard.
          </Banner>
        </div>
      </Modal>

      <Modal
        open={importOpen}
        width="narrow"
        title="Import patients"
        onClose={() => setImportOpen(false)}
        footer={
          <div className="row row--end">
            <Button variant="ghost" onClick={() => setImportOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={async () => {
                await runImport(true);
                setImportOpen(false);
                setImportPreview(null);
              }}
            >
              Import now
            </Button>
          </div>
        }
      >
        <div className="stack">
          <Field label="File" hint="Leave empty to choose the file in the next dialog">
            <Input value={importFile} onChange={(event) => setImportFile(event.target.value)} />
          </Field>
          <p className="small muted">Rows that duplicate an existing patient (same name and phone) are skipped and reported afterwards.</p>
        </div>
      </Modal>
    </div>
  );
}

export function SettingsScreen(): JSX.Element {
  const [tab, setTab] = useState('clinic');
  const clinic = useApi('clinic.get', undefined);
  const settings = useApi('settings.get', undefined);
  const system = useApi('app.systemInfo', tab === 'data' ? undefined : null, [tab]);
  const version = useApi('app.bootstrap', undefined);

  return (
    <Page
      title="Settings"
      description="Clinic identity, behaviour, security and printing"
      actions={
        <span className="small muted">
          {APP_NAME} {version.data?.appVersion ?? APP_VERSION}
        </span>
      }
    >
      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'clinic' ? <ClinicPanel /> : null}
      {tab === 'appearance' ? <SettingsForm settings={settings.data ?? null} onSaved={settings.reload} /> : null}
      {tab === 'clinical' ? <SettingsForm settings={settings.data ?? null} onSaved={settings.reload} /> : null}
      {tab === 'security' ? <SettingsForm settings={settings.data ?? null} onSaved={settings.reload} /> : null}
      {tab === 'printing' ? <PrintingPanel /> : null}
      {tab === 'data' ? (
        <div className="stack">
          <Card title="This installation">
            <DefinitionList
              items={[
                {
                  label: 'Application',
                  value: `${system.data?.appVersion ?? APP_VERSION} (build ${system.data?.appBuild ?? APP_BUILD_NUMBER})`,
                },
                {
                  label: 'Data folder',
                  value: <span className="mono small">{system.data?.userDataPath ?? version.data?.dataDir ?? '—'}</span>,
                },
                { label: 'Database', value: <span className="mono small">{system.data?.databasePath ?? '—'}</span> },
                { label: 'Log folder', value: <span className="mono small">{system.data?.logPath ?? '—'}</span> },
                { label: 'Operating system', value: system.data ? `${system.data.osVersion} (${system.data.architecture})` : '—' },
                {
                  label: 'Electron / Chromium / Node',
                  value: system.data ? `${system.data.electronVersion} / ${system.data.chromeVersion} / ${system.data.nodeVersion}` : '—',
                },
                { label: 'Installed', value: system.data?.installedAt ? fmtInstant(system.data.installedAt) : '—' },
                { label: 'Clinic profile', value: clinic.data?.name ?? '—' },
              ]}
            />
          </Card>
          <DangerPanel />
        </div>
      ) : null}
    </Page>
  );
}
