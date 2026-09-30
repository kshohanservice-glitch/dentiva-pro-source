/**
 * First-run setup wizard — seven steps, restart safe.
 *
 * The wizard reads `setup.status` on mount and reopens on the first step that
 * has not been completed, so closing the application halfway through setup
 * never loses the work already saved.
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Plus, Trash2, Upload } from 'lucide-react';
import { APP_NAME } from '@shared/app-info';
import {
  AUTO_LOCK_OPTIONS,
  BACKUP_INTERVAL_OPTIONS,
  DENTIST_CREDENTIAL_TYPES,
  DATE_FORMATS,
  TIME_FORMATS,
  TIME_ZONES,
} from '@shared/constants';
import type { DentistInput } from '@shared/types';
import { useAction, useApi, useApp } from '@renderer/state/store';
import { bridge, resolveSourcePath } from '@renderer/lib/bridge';
import { validatePassword } from '@shared/password-policy';
import { Banner, Button, Card, Field, Input, Page, Segmented, Select, Spinner, TextArea } from '@renderer/components/ui';
import { TextField } from '@renderer/components/forms';

const STEPS = [
  { key: 'welcome', title: 'Welcome', description: 'What the wizard sets up and where your data lives.' },
  { key: 'clinic', title: 'Clinic profile', description: 'Printed on every prescription, invoice and report.' },
  { key: 'dentists', title: 'Dentists', description: 'Designations, qualifications and certifications.' },
  { key: 'preferences', title: 'Preferences', description: 'Formats, security and backups.' },
  { key: 'administrator', title: 'Administrator', description: 'The owner account you will sign in with.' },
  { key: 'review', title: 'Review', description: 'Check everything before finishing.' },
  { key: 'finish', title: 'Finish', description: 'Open the clinic system.' },
] as const;

function blankDentist(primary = false): DentistInput {
  return {
    name: '',
    phone: '',
    email: '',
    registrationNumber: '',
    visitingHours: '',
    isActive: true,
    isDefault: primary,
    credentials: [
      { id: null, type: 'designation', title: '', institution: '', year: null, sortOrder: 10, showOnPrescription: true },
      { id: null, type: 'qualification', title: '', institution: '', year: null, sortOrder: 20, showOnPrescription: true },
    ],
  };
}

export function SetupWizard(): JSX.Element {
  const { bootstrap, refresh, toast } = useApp();
  const { busy } = useAction();
  const status = useApi('setup.status', undefined);
  const [stepIndex, setStepIndex] = useState(0);
  const [touched, setTouched] = useState(false);

  // Resume: land on the first step that still needs attention.
  useEffect(() => {
    if (!status.data || touched) return;
    const done = status.data;
    const firstOpen = STEPS.findIndex((step) => step.key !== 'welcome' && step.key !== 'finish' && !isComplete(step.key, done));
    setStepIndex(firstOpen === -1 ? STEPS.length - 1 : firstOpen);
  }, [status.data, touched]);

  const step = STEPS[stepIndex]!;

  const go = (index: number) => {
    setTouched(true);
    setStepIndex(Math.max(0, Math.min(STEPS.length - 1, index)));
  };

  if (!status.data) {
    return (
      <div className="gate">
        <div className="gate__panel" style={{ maxWidth: 520 }}>
          <div className="row" style={{ gap: 12 }}>
            <Spinner />
            <span className="muted">Reading setup progress…</span>
          </div>
        </div>
      </div>
    );
  }

  const done = status.data;

  return (
    <Page
      title={`${APP_NAME} setup`}
      description="Seven short steps, saved as you go."
      actions={<span className="small muted">Data folder: {bootstrap?.dataDir ?? '—'}</span>}
    >
      <div className="gate__steps" style={{ marginBottom: 'var(--space-5)' }}>
        {STEPS.map((entry, index) => {
          const complete = entry.key === 'welcome' || isComplete(entry.key, done);
          return (
            <button
              key={entry.key}
              type="button"
              className={`gate__step ${index === stepIndex ? 'is-active' : ''} ${complete ? 'is-done' : ''}`}
              onClick={() => go(index)}
            >
              <span className="gate__step-index">{complete ? <Check size={14} /> : index + 1}</span>
              <span>
                <strong>{entry.title}</strong>
                <span className="small muted" style={{ display: 'block' }}>
                  {entry.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {step.key === 'welcome' ? <WelcomeStep /> : null}
      {step.key === 'clinic' ? (
        <ClinicStep
          onDone={() => {
            status.reload();
            go(stepIndex + 1);
          }}
        />
      ) : null}
      {step.key === 'dentists' ? (
        <DentistsStep
          onDone={() => {
            status.reload();
            go(stepIndex + 1);
          }}
        />
      ) : null}
      {step.key === 'preferences' ? (
        <PreferencesStep
          onDone={() => {
            status.reload();
            go(stepIndex + 1);
          }}
        />
      ) : null}
      {step.key === 'administrator' ? (
        <AdministratorStep
          onDone={() => {
            status.reload();
            go(stepIndex + 1);
          }}
        />
      ) : null}
      {step.key === 'review' ? <ReviewStep /> : null}
      {step.key === 'finish' ? <FinishStep /> : null}

      <div className="row row--between" style={{ marginTop: 'var(--space-5)' }}>
        <Button icon={<ChevronLeft size={15} />} disabled={stepIndex === 0} onClick={() => go(stepIndex - 1)}>
          Back
        </Button>
        <div className="row" style={{ gap: 8 }}>
          <Button
            variant="ghost"
            onClick={async () => {
              await refresh();
              toast('info', 'Setup progress reloaded', 'Steps you already completed were kept.');
            }}
          >
            Reload
          </Button>
          {stepIndex < STEPS.length - 1 ? (
            <Button variant="primary" onClick={() => go(stepIndex + 1)}>
              {busy ? 'Working…' : 'Continue'} <ChevronRight size={15} />
            </Button>
          ) : null}
        </div>
      </div>
    </Page>
  );
}

function isComplete(
  key: string,
  status: { clinicComplete: boolean; dentistsComplete: boolean; preferencesComplete: boolean; administratorComplete: boolean },
): boolean {
  switch (key) {
    case 'clinic':
      return status.clinicComplete;
    case 'dentists':
      return status.dentistsComplete;
    case 'preferences':
      return status.preferencesComplete;
    case 'administrator':
      return status.administratorComplete;
    default:
      return true;
  }
}

function WelcomeStep(): JSX.Element {
  const { bootstrap } = useApp();
  return (
    <Card title="Welcome to Dentiva Pro">
      <div className="stack">
        <p>
          This wizard configures the clinic once. Everything runs on this computer — there is no cloud account, no internet call and no
          external service. Your patient records stay inside the data folder below.
        </p>
        <div className="grid-2">
          <div className="definition">
            <dt>Application</dt>
            <dd>
              {APP_NAME} {bootstrap ? `${bootstrap.appVersion} (build ${bootstrap.appBuild})` : ''}
            </dd>
            <dt>Data folder</dt>
            <dd className="mono small">{bootstrap?.dataDir ?? '—'}</dd>
            <dt>Activation</dt>
            <dd>{bootstrap?.activation.activated ? 'Activated on this machine' : 'Not activated'}</dd>
          </div>
          <div className="definition">
            <dt>You will set</dt>
            <dd>1 · Clinic identity &nbsp; 2 · Dentists &nbsp; 3 · Formats, auto-lock and backups &nbsp; 4 · The administrator password</dd>
            <dt>You can change it later</dt>
            <dd>Everything except the activation code is editable in Settings.</dd>
            <dt>Advice</dt>
            <dd>Choose a backup folder on a different drive if you have one.</dd>
          </div>
        </div>
        <Banner tone="info" title="Nothing is shared">
          Backups are plain files you can copy. Keep at least one copy outside this computer.
        </Banner>
      </div>
    </Card>
  );
}

function ClinicStep({ onDone }: { onDone(): void }): JSX.Element {
  const { runOk, busy } = useAction();
  const [form, setForm] = useState({ name: '', address: '', phone: '', email: '', website: '' });
  const [logoPath, setLogoPath] = useState<string | null>(null);
  const [logoName, setLogoName] = useState('');

  const patch = (value: Partial<typeof form>) => setForm((current) => ({ ...current, ...value }));

  return (
    <Card title="Clinic profile" subtitle="Appears on prescriptions, invoices, reports and receipts.">
      <div className="stack">
        <div className="grid-2">
          <TextField label="Clinic name" required value={form.name} onChange={(value) => patch({ name: value })} />
          <TextField label="Phone" value={form.phone} onChange={(value) => patch({ phone: value })} />
        </div>
        <Field label="Address">
          <TextArea rows={2} value={form.address} onChange={(event) => patch({ address: event.target.value })} />
        </Field>
        <div className="grid-2">
          <TextField label="Email" value={form.email} onChange={(value) => patch({ email: value })} />
          <TextField label="Website" value={form.website} onChange={(value) => patch({ website: value })} />
        </div>
        <Field label="Clinic logo" hint="PNG or JPG; shown on printed documents">
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
                  try {
                    setLogoPath(await resolveSourcePath(file));
                    setLogoName(file.name);
                  } catch {
                    setLogoName('');
                  }
                }}
              />
            </label>
            <span className="small muted">{logoName || 'No logo chosen yet'}</span>
          </div>
        </Field>
        <div className="row row--end">
          <Button
            variant="primary"
            loading={busy}
            disabled={form.name.trim().length < 2}
            onClick={async () => {
              const saved = await runOk(() => bridge.invoke('setup.saveClinic', { ...form, logoSourcePath: logoPath }), {
                success: 'Clinic profile saved.',
                failure: 'The clinic profile could not be saved.',
              });
              if (saved) onDone();
            }}
          >
            Save clinic profile
          </Button>
        </div>
      </div>
    </Card>
  );
}

function DentistsStep({ onDone }: { onDone(): void }): JSX.Element {
  const { runOk, busy } = useAction();
  const [dentists, setDentists] = useState<DentistInput[]>([blankDentist(true)]);
  const [problem, setProblem] = useState<string | null>(null);

  const patchDentist = (index: number, value: Partial<DentistInput>) =>
    setDentists((current) => current.map((entry, position) => (position === index ? { ...entry, ...value } : entry)));

  /**
   * Credential rows start empty on purpose — plenty of dentists have nothing to
   * list. Blank rows are dropped before saving, while a row that has been
   * started but has no title is reported in plain language (the core's field
   * keys would otherwise point at nothing on screen).
   */
  const prepared = (): { dentists: DentistInput[]; problem: string | null } => {
    const incomplete: string[] = [];
    const cleaned = dentists.map((dentist, index) => ({
      ...dentist,
      credentials: dentist.credentials.filter((credential) => {
        const blank = credential.title.trim() === '' && credential.institution.trim() === '' && credential.year === null;
        if (!blank && credential.title.trim() === '') incomplete.push(`${dentist.name.trim() || `Dentist ${index + 1}`}`);
        return !blank;
      }),
    }));
    if (incomplete.length > 0) {
      return { dentists: cleaned, problem: `Every credential needs a title: ${[...new Set(incomplete)].join(', ')}.` };
    }
    return { dentists: cleaned, problem: null };
  };

  return (
    <Card
      title="Dentists"
      subtitle="Designations, qualifications and certifications print under the signature on prescriptions."
      actions={
        <Button
          size="sm"
          icon={<Plus size={14} />}
          onClick={() => setDentists((current) => [...current, blankDentist(current.length === 0)])}
        >
          Add dentist
        </Button>
      }
    >
      <div className="stack">
        {dentists.map((dentist, index) => (
          <Card key={index} title={`Dentist ${index + 1}`} subtitle={dentist.isDefault ? 'Default dentist' : undefined}>
            <div className="stack">
              <div className="grid-3">
                <TextField label="Full name" required value={dentist.name} onChange={(value) => patchDentist(index, { name: value })} />
                <TextField
                  label="BDS / registration number"
                  value={dentist.registrationNumber}
                  onChange={(value) => patchDentist(index, { registrationNumber: value })}
                />
                <TextField
                  label="Visiting hours"
                  hint="e.g. Sat–Thu, 5 pm – 9 pm"
                  value={dentist.visitingHours}
                  onChange={(value) => patchDentist(index, { visitingHours: value })}
                />
              </div>
              <div className="grid-3">
                <TextField label="Phone" value={dentist.phone} onChange={(value) => patchDentist(index, { phone: value })} />
                <TextField label="Email" value={dentist.email} onChange={(value) => patchDentist(index, { email: value })} />
                <div className="row" style={{ alignItems: 'flex-end', gap: 8 }}>
                  <Button size="sm" variant="ghost" onClick={() => patchDentist(index, { isDefault: true })} disabled={dentist.isDefault}>
                    Make default
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={dentists.length === 1}
                    onClick={() => setDentists((current) => current.filter((_, position) => position !== index))}
                  >
                    <Trash2 size={14} /> Remove
                  </Button>
                </div>
              </div>

              <div className="stack stack--sm">
                <div className="row row--between">
                  <strong className="small">Credentials shown on prescriptions</strong>
                  <Button
                    size="sm"
                    icon={<Plus size={14} />}
                    onClick={() =>
                      patchDentist(index, {
                        credentials: [
                          ...dentist.credentials,
                          {
                            id: null,
                            type: 'certification',
                            title: '',
                            institution: '',
                            year: null,
                            sortOrder: dentist.credentials.length * 10 + 10,
                            showOnPrescription: true,
                          },
                        ],
                      })
                    }
                  >
                    Add line
                  </Button>
                </div>
                {dentist.credentials.map((credential, credentialIndex) => (
                  <div key={credentialIndex} className="grid-4">
                    <Field label="Type">
                      <Select
                        value={credential.type}
                        options={DENTIST_CREDENTIAL_TYPES.map((option) => ({ value: option.value, label: option.label }))}
                        onChange={(event) => {
                          const next = [...dentist.credentials];
                          next[credentialIndex] = { ...credential, type: event.target.value as typeof credential.type };
                          patchDentist(index, { credentials: next });
                        }}
                      />
                    </Field>
                    <TextField
                      label="Title"
                      value={credential.title}
                      onChange={(value) => {
                        const next = [...dentist.credentials];
                        next[credentialIndex] = { ...credential, title: value };
                        patchDentist(index, { credentials: next });
                      }}
                    />
                    <TextField
                      label="Institution"
                      value={credential.institution}
                      onChange={(value) => {
                        const next = [...dentist.credentials];
                        next[credentialIndex] = { ...credential, institution: value };
                        patchDentist(index, { credentials: next });
                      }}
                    />
                    <div className="row" style={{ alignItems: 'flex-end', gap: 8 }}>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          patchDentist(index, { credentials: dentist.credentials.filter((_, position) => position !== credentialIndex) })
                        }
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        ))}
        {problem ? (
          <Banner tone="warning" title="Check the credentials">
            {problem}
          </Banner>
        ) : null}
        <div className="row row--end">
          <Button
            variant="primary"
            loading={busy}
            disabled={dentists.some((dentist) => dentist.name.trim().length < 2)}
            onClick={async () => {
              const { dentists: payload, problem: found } = prepared();
              setProblem(found);
              if (found) return;
              const saved = await runOk(() => bridge.invoke('setup.saveDentists', { dentists: payload }), {
                success: 'Dentists saved.',
                failure: 'The dentist list could not be saved.',
              });
              if (saved) onDone();
            }}
          >
            Save dentists
          </Button>
        </div>
      </div>
    </Card>
  );
}

function PreferencesStep({ onDone }: { onDone(): void }): JSX.Element {
  const { runOk, busy } = useAction();
  const [form, setForm] = useState({
    dateFormat: 'DD MMM YYYY',
    timeFormat: 'hh:mm A',
    timeZone: 'Asia/Dhaka',
    numberGrouping: 'international' as 'international' | 'south_asian',
    autoLockMinutes: 10,
    backupFolder: '',
    backupIntervalDays: 7,
    defaultPrinterName: '',
  });
  const printers = useApi('print.systemPrinters', undefined);

  const patch = (value: Partial<typeof form>) => setForm((current) => ({ ...current, ...value }));

  return (
    <Card title="Preferences" subtitle="Sensible defaults are pre-selected; change what you need.">
      <div className="stack">
        <div className="grid-3">
          <Field label="Date format">
            <Select
              value={form.dateFormat}
              options={DATE_FORMATS.map((option) => ({ value: option.value, label: `${option.label} — ${option.value}` }))}
              onChange={(event) => patch({ dateFormat: event.target.value })}
            />
          </Field>
          <Field label="Time format">
            <Select
              value={form.timeFormat}
              options={TIME_FORMATS.map((option) => ({ value: option.value, label: `${option.label} — ${option.value}` }))}
              onChange={(event) => patch({ timeFormat: event.target.value })}
            />
          </Field>
          <Field label="Time zone">
            <Select
              value={form.timeZone}
              options={TIME_ZONES.map((zone: string) => ({ value: zone, label: zone }))}
              onChange={(event) => patch({ timeZone: event.target.value })}
            />
          </Field>
        </div>
        <div className="grid-3">
          <Field label="Number grouping" hint="How thousands are separated in amounts">
            <Segmented
              value={form.numberGrouping}
              options={[
                { value: 'international', label: '1,234,567' },
                { value: 'south_asian', label: '12,34,567' },
              ]}
              onChange={(value) => patch({ numberGrouping: value as 'international' | 'south_asian' })}
            />
          </Field>
          <Field label="Auto-lock" hint="Locks the screen after inactivity">
            <Select
              value={String(form.autoLockMinutes)}
              options={AUTO_LOCK_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))}
              onChange={(event) => patch({ autoLockMinutes: Number(event.target.value) })}
            />
          </Field>
          <Field label="Automatic backup">
            <Select
              value={String(form.backupIntervalDays)}
              options={BACKUP_INTERVAL_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))}
              onChange={(event) => patch({ backupIntervalDays: Number(event.target.value) })}
            />
          </Field>
        </div>
        <div className="grid-2">
          <TextField
            label="Backup folder"
            hint="Leave empty to keep backups inside the data folder"
            value={form.backupFolder}
            onChange={(value) => patch({ backupFolder: value })}
          />
          <div className="row" style={{ alignItems: 'flex-end', gap: 8 }}>
            <Button
              onClick={async () => {
                const folder = await bridge.invoke('backup.pickFolder');
                if (folder) patch({ backupFolder: folder });
              }}
            >
              Choose folder…
            </Button>
          </div>
        </div>
        <Field label="Default printer" hint="Prescriptions and invoices use this printer unless changed later">
          <Select
            value={form.defaultPrinterName}
            placeholder="System default printer"
            options={(printers.data ?? []).map((printer) => ({
              value: printer.name,
              label: `${printer.name}${printer.isDefault ? ' (default)' : ''}`,
            }))}
            onChange={(event) => patch({ defaultPrinterName: event.target.value })}
          />
        </Field>
        <Banner tone="warning" title="Keep backups outside this computer">
          A backup on the same disk does not protect against a disk failure, theft or fire.
        </Banner>
        <div className="row row--end">
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              const saved = await runOk(() => bridge.invoke('setup.savePreferences', form), {
                success: 'Preferences saved.',
                failure: 'The preferences could not be saved.',
              });
              if (saved) onDone();
            }}
          >
            Save preferences
          </Button>
        </div>
      </div>
    </Card>
  );
}

function AdministratorStep({ onDone }: { onDone(): void }): JSX.Element {
  const { runOk, busy } = useAction();
  const [form, setForm] = useState({ username: '', fullName: '', password: '', confirm: '' });
  const patch = (value: Partial<typeof form>) => setForm((current) => ({ ...current, ...value }));

  const problems = useMemo(() => {
    if (form.password === '') return [] as string[];
    const policy = validatePassword(form.password, { username: form.username, fullName: form.fullName });
    return policy.ok ? [] : policy.problems;
  }, [form.password, form.username, form.fullName]);

  const mismatch = form.confirm !== '' && form.confirm !== form.password;
  const ready =
    /^[a-z0-9._-]{3,24}$/.test(form.username.trim().toLowerCase()) &&
    form.fullName.trim().length >= 2 &&
    form.password !== '' &&
    problems.length === 0 &&
    form.confirm === form.password;

  return (
    <Card title="Administrator account" subtitle="This is the owner account — it can never lose access to the clinic.">
      <div className="stack">
        <div className="grid-2">
          <TextField
            label="Username"
            required
            hint="3–24 characters: letters, numbers, dot, hyphen or underscore"
            value={form.username}
            onChange={(value) => patch({ username: value })}
          />
          <TextField label="Full name" required value={form.fullName} onChange={(value) => patch({ fullName: value })} />
        </div>
        <div className="grid-2">
          <Field label="Password" required hint="At least 8 characters with letters and numbers">
            <Input type="password" value={form.password} onChange={(event) => patch({ password: event.target.value })} />
          </Field>
          <Field label="Repeat password" required error={mismatch ? 'The two passwords do not match.' : undefined}>
            <Input type="password" value={form.confirm} onChange={(event) => patch({ confirm: event.target.value })} />
          </Field>
        </div>
        {problems.length > 0 ? (
          <Banner tone="warning" title="The password needs work">
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </Banner>
        ) : null}
        <Banner tone="info" title="Write this password down somewhere safe">
          There is no password reset by email — Dentiva Pro is fully offline. If you lose it, an administrator can reset it from another
          account.
        </Banner>
        <div className="row row--end">
          <Button
            variant="primary"
            loading={busy}
            disabled={!ready}
            onClick={async () => {
              const saved = await runOk(
                () =>
                  bridge.invoke('setup.createAdministrator', { username: form.username, fullName: form.fullName, password: form.password }),
                { success: 'Administrator created.', failure: 'The administrator could not be created.' },
              );
              if (saved) onDone();
            }}
          >
            Create administrator
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ReviewStep(): JSX.Element {
  const review = useApi('setup.review', undefined);
  if (review.loading && !review.data) {
    return (
      <Card title="Review">
        <Spinner />
      </Card>
    );
  }
  const data = review.data;
  return (
    <Card title="Review" subtitle="Everything below is editable later from Settings.">
      <div className="stack">
        <div className="grid-2">
          <div className="definition">
            <dt>Clinic</dt>
            <dd>{data?.clinic?.name ?? '— not set —'}</dd>
            <dt>Address</dt>
            <dd>{data?.clinic?.address || '—'}</dd>
            <dt>Phone</dt>
            <dd>{data?.clinic?.phone || '—'}</dd>
            <dt>Email</dt>
            <dd>{data?.clinic?.email || '—'}</dd>
          </div>
          <div className="definition">
            <dt>Dentists</dt>
            <dd>{(data?.dentists ?? []).map((dentist) => dentist.name).join(', ') || '— none —'}</dd>
            <dt>Administrator</dt>
            <dd>{data?.administrator ?? '— not set —'}</dd>
            <dt>Date / time</dt>
            <dd>
              {data?.preferences?.dateFormat ?? '—'} · {data?.preferences?.timeFormat ?? '—'} · {data?.preferences?.timeZone ?? '—'}
            </dd>
            <dt>Auto-lock / backup</dt>
            <dd>
              {data?.preferences?.autoLockMinutes ? `${data.preferences.autoLockMinutes} minutes` : 'Disabled'} ·{' '}
              {data?.preferences?.backupIntervalDays ? `every ${data.preferences.backupIntervalDays} days` : 'Disabled'}
            </dd>
          </div>
        </div>
        <Banner tone="info" title="Still editable">
          You can add more dentists, change the logo, adjust formats and configure printers and templates at any time.
        </Banner>
      </div>
    </Card>
  );
}

function FinishStep(): JSX.Element {
  const { refresh, toast } = useApp();
  const { runOk, busy } = useAction();
  const status = useApi('setup.status', undefined);

  return (
    <Card title="Finish setup">
      <div className="stack">
        <p>
          Step five completes the wizard and opens the clinic system. The owner account you created signs in first; add staff accounts
          afterwards from Users &amp; roles.
        </p>
        <div className="definition">
          <dt>Wizard progress</dt>
          <dd>
            {status.data
              ? `${
                  [
                    status.data.clinicComplete,
                    status.data.dentistsComplete,
                    status.data.preferencesComplete,
                    status.data.administratorComplete,
                  ].filter(Boolean).length
                } of 4 data steps complete`
              : '—'}
          </dd>
          <dt>Completed at</dt>
          <dd>{status.data?.completedAt ?? 'Not completed yet'}</dd>
        </div>
        <div className="row row--end">
          <Button
            variant="primary"
            loading={busy}
            disabled={Boolean(status.data?.completedAt)}
            onClick={async () => {
              const finished = await runOk(() => bridge.invoke('setup.complete'), {
                success: 'Setup complete.',
                failure: 'Setup could not be completed.',
              });
              if (finished) {
                await refresh();
                toast('success', 'Setup complete', 'Sign in with the administrator account you created.');
              }
            }}
          >
            Complete setup and open Dentiva Pro
          </Button>
        </div>
      </div>
    </Card>
  );
}
