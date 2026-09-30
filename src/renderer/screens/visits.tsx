/**
 * Visit records — the clinical core.
 *
 * A visit is written once and then immutable: corrections are recorded as a new
 * visit, which is what keeps a patient's history trustworthy. This screen
 * creates and reads visits, records treatment lines, and links prescriptions.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ClipboardCheck, Plus, Trash2 } from 'lucide-react';
import { resolveScreenPath } from '@shared/api';
import { todayIso } from '@shared/dates';
import type { ClinicalOptionCategory } from '@shared/constants';
import type {
  Dentist,
  PatientSummary,
  Treatment,
  TreatmentRecordInput,
  VisitDetail,
  VisitInput,
  VisitSummary,
} from '@shared/types';
import { useAction, useApi, useApp } from '@renderer/state/store';
import { bridge } from '@renderer/lib/bridge';
import { fmtDate, fmtMoney, fmtTime } from '@renderer/lib/format';
import {
  Badge,
  Banner,
  Button,
  Card,
  Chip,
  DefinitionList,
  Drawer,
  Empty,
  ErrorState,
  Field,
  LoadingBlock,
  Modal,
  Page,
  SearchInput,
  Select,
  StatusBadge,
  TextArea,
  Input,
} from '@renderer/components/ui';
import { DataTable, DentistSelect, PatientPicker, SelectField, TextField, rangePresetOptions, MoneyField } from '@renderer/components/forms';

const EMPTY_VISIT = (patientId = 0): VisitInput => ({
  patientId,
  dentistId: null,
  visitDate: todayIso(),
  visitTime: '10:00',
  chiefComplaint: '',
  history: '',
  examination: '',
  diagnosis: '',
  ccOptions: [],
  oeOptions: [],
  reOptions: [],
  adviceOptions: [],
  advice: '',
  notes: '',
  followUpDate: null,
  treatments: [],
  dentalFindings: [],
  prescriptionId: null,
});

function ClinicalOptionChips({
  category,
  selected,
  onToggle,
}: {
  category: ClinicalOptionCategory;
  selected: string[];
  onToggle(label: string): void;
}): JSX.Element | null {
  const options = useApi('resource.list', { resource: 'clinical-options', query: { pageSize: 200 }, includeInactive: false });
  const list = (options.data?.items ?? []).filter((option) => (option as { category: string }).category === category);
  if (list.length === 0) return null;
  return (
    <div className="chip-row">
      {list.map((option) => {
        const label = (option as { label: string }).label;
        return (
          <Chip key={(option as { id: number }).id} selected={selected.includes(label)} onClick={() => onToggle(label)}>
            {label}
          </Chip>
        );
      })}
    </div>
  );
}

function TreatmentLines({
  lines,
  onChange,
}: {
  lines: TreatmentRecordInput[];
  onChange(lines: TreatmentRecordInput[]): void;
}): JSX.Element {
  const treatments = useApi('resource.list', { resource: 'treatments', query: { pageSize: 300 } });
  const options = (treatments.data?.items ?? []) as unknown as Treatment[];

  const addLine = () =>
    onChange([
      ...lines,
      { treatmentId: null, description: '', toothCodes: [], quantity: 1, unitPricePaisa: 0, discountPaisa: 0, notes: '' },
    ]);

  return (
    <div className="stack stack--sm">
      {lines.length === 0 ? (
        <div className="small muted">No treatment recorded for this visit yet.</div>
      ) : null}
      {lines.map((line, index) => (
        <div key={index} className="grid-4" style={{ alignItems: 'end' }}>
          <Field label="Treatment">
            <Select
              value={line.treatmentId === null ? '' : String(line.treatmentId)}
              placeholder="Choose or type below"
              options={options.map((treatment) => ({
                value: String(treatment.id),
                label: `${treatment.name} · ${fmtMoney(treatment.pricePaisa)}`,
              }))}
              onChange={(event) => {
                const selected = options.find((treatment) => String(treatment.id) === event.target.value);
                const next = [...lines];
                next[index] = {
                  ...line,
                  treatmentId: selected?.id ?? null,
                  description: selected?.name ?? line.description,
                  unitPricePaisa: selected?.pricePaisa ?? line.unitPricePaisa,
                };
                onChange(next);
              }}
            />
          </Field>
          <TextField
            label="Description"
            value={line.description}
            onChange={(value) => {
              const next = [...lines];
              next[index] = { ...line, description: value };
              onChange(next);
            }}
          />
          <TextField
            label="Teeth"
            value={line.toothCodes.join(', ')}
            hint="FDI codes, comma separated"
            onChange={(value) => {
              const next = [...lines];
              next[index] = {
                ...line,
                toothCodes: value
                  .split(',')
                  .map((part) => part.trim())
                  .filter(Boolean),
              };
              onChange(next);
            }}
          />
          <div className="row" style={{ gap: 8 }}>
            <MoneyField
              label="Unit price"
              valuePaisa={line.unitPricePaisa}
              onChange={(paisa) => {
                const next = [...lines];
                next[index] = { ...line, unitPricePaisa: paisa };
                onChange(next);
              }}
            />
            <Field label="Qty">
              <Input
                className="input--numeric"
                style={{ width: 70 }}
                inputMode="numeric"
                value={String(line.quantity)}
                onChange={(event) => {
                  const next = [...lines];
                  next[index] = { ...line, quantity: Math.max(1, Number(event.target.value) || 1) };
                  onChange(next);
                }}
              />
            </Field>
            <Button
              variant="ghost"
              onClick={() => onChange(lines.filter((_, position) => position !== index))}
              aria-label="Remove treatment line"
            >
              <Trash2 size={15} />
            </Button>
          </div>
        </div>
      ))}
      <div className="row">
        <Button size="sm" icon={<Plus size={14} />} onClick={addLine}>
          Add treatment
        </Button>
        {options.length === 0 ? (
          <span className="small muted">Add treatments in Settings → Treatments to pick them here.</span>
        ) : null}
      </div>
    </div>
  );
}

function VisitDialog({
  open,
  onClose,
  onSaved,
  defaultPatientId,
}: {
  open: boolean;
  onClose(): void;
  onSaved(id: number): void;
  defaultPatientId: number | null;
}): JSX.Element | null {
  const { toast } = useApp();
  const { run, busy } = useAction();
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [form, setForm] = useState<VisitInput>(EMPTY_VISIT());
  const prefill = useApi('patients.quickSearch', defaultPatientId ? { query: String(defaultPatientId), limit: 5 } : null);

  useEffect(() => {
    const match = defaultPatientId ? (prefill.data ?? []).find((candidate) => candidate.id === defaultPatientId) : undefined;
    if (match) {
      setPatient(match);
      setForm(EMPTY_VISIT(match.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultPatientId, prefill.data]);

  const patch = (value: Partial<VisitInput>) => setForm((current) => ({ ...current, ...value }));

  const toggle = (key: 'ccOptions' | 'oeOptions' | 'reOptions' | 'adviceOptions', label: string) =>
    patch({
      [key]: form[key].includes(label) ? form[key].filter((item) => item !== label) : [...form[key], label],
    } as Partial<VisitInput>);

  const save = async () => {
    const patientId = patient?.id ?? form.patientId;
    if (!patientId) {
      toast('warning', 'Choose a patient first');
      return;
    }
    const saved = await run(
      () => bridge.invoke('visits.create', { input: { ...form, patientId } }),
      { success: 'Visit recorded.', failure: 'The visit could not be saved.' },
    );
    if (saved) {
      onSaved(saved.id);
      onClose();
      setPatient(null);
      setForm(EMPTY_VISIT());
    }
  };

  if (!open) return null;

  return (
    <Modal
      open
      width="wide"
      title="Record a visit"
      description="Chief complaint, examination, diagnosis and treatment in one pass."
      onClose={onClose}
      footer={
        <div className="row row--end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            Save visit
          </Button>
        </div>
      }
    >
      <div className="stack">
        <PatientPicker value={patient} onChange={(value) => setPatient(value)} autoFocus={!defaultPatientId} />
        <div className="grid-3">
          <Field label="Visit date" required>
            <Input type="date" value={form.visitDate} onChange={(event) => patch({ visitDate: event.target.value })} />
          </Field>
          <Field label="Visit time" required>
            <Input type="time" value={form.visitTime} onChange={(event) => patch({ visitTime: event.target.value })} />
          </Field>
          <DentistSelect value={form.dentistId} onChange={(value) => patch({ dentistId: value })} />
        </div>

        <Card title="Chief complaint" subtitle="Pick from the configured list or type free text">
          <div className="stack stack--sm">
            <ClinicalOptionChips category="cc" selected={form.ccOptions} onToggle={(label) => toggle('ccOptions', label)} />
            <TextArea value={form.chiefComplaint} rows={2} onChange={(event) => patch({ chiefComplaint: event.target.value })} />
          </div>
        </Card>

        <Card title="Examination">
          <div className="stack stack--sm">
            <ClinicalOptionChips category="oe" selected={form.oeOptions} onToggle={(label) => toggle('oeOptions', label)} />
            <TextArea value={form.examination} rows={2} onChange={(event) => patch({ examination: event.target.value })} />
          </div>
        </Card>

        <Card title="Diagnosis">
          <div className="stack stack--sm">
            <ClinicalOptionChips category="re" selected={form.reOptions} onToggle={(label) => toggle('reOptions', label)} />
            <TextArea value={form.diagnosis} rows={2} onChange={(event) => patch({ diagnosis: event.target.value })} />
          </div>
        </Card>

        <Card title="Treatment performed">
          <TreatmentLines lines={form.treatments} onChange={(lines) => patch({ treatments: lines })} />
        </Card>

        <Card title="Advice">
          <div className="stack stack--sm">
            <ClinicalOptionChips category="advice" selected={form.adviceOptions} onToggle={(label) => toggle('adviceOptions', label)} />
            <TextArea value={form.advice} rows={2} onChange={(event) => patch({ advice: event.target.value })} />
          </div>
        </Card>

        <div className="grid-3">
          <Field label="Follow-up date" hint="Appears on the dashboard when it is due">
            <Input
              type="date"
              value={form.followUpDate ?? ''}
              onChange={(event) => patch({ followUpDate: event.target.value || null })}
            />
          </Field>
          <TextField label="History" value={form.history} onChange={(value) => patch({ history: value })} />
          <Field label="Notes">
            <TextArea value={form.notes} rows={1} onChange={(event) => patch({ notes: event.target.value })} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function VisitDetailDrawer({ visitId, onClose }: { visitId: number | null; onClose(): void }): JSX.Element | null {
  const visit = useApi('visits.get', visitId ? { id: visitId } : null);
  const detail = visit.data as VisitDetail | null;
  if (!visitId) return null;
  return (
    <Drawer open title={detail ? `Visit · ${fmtDate(detail.visitDate)}` : 'Visit'} onClose={onClose}>
      {visit.loading && !detail ? <LoadingBlock rows={6} /> : !detail ? <ErrorState message={visit.error ?? 'Not found'} /> : (
        <div className="stack">
          <DefinitionList
            items={[
              { label: 'Patient', value: detail.patientName },
              { label: 'Dentist', value: detail.dentistName || '—' },
              { label: 'Time', value: fmtTime(detail.visitTime) },
              { label: 'Chief complaint', value: detail.chiefComplaint },
              { label: 'Examination', value: detail.examination },
              { label: 'Diagnosis', value: detail.diagnosis },
              { label: 'Advice', value: detail.advice },
              { label: 'Follow-up', value: detail.followUpDate ? fmtDate(detail.followUpDate) : '—' },
              { label: 'Notes', value: detail.notes },
              { label: 'Recorded', value: detail.createdAt.slice(0, 10) },
            ]}
          />
          <Card title={`Treatments (${detail.treatments.length})`}>
            {detail.treatments.length === 0 ? (
              <Empty title="No treatment lines" />
            ) : (
              <div className="stack stack--sm">
                {detail.treatments.map((record) => (
                  <div key={record.id} className="row row--between">
                    <div>
                      <div>{record.description}</div>
                      <div className="small muted">
                        {record.toothCodes.join(', ') || 'all teeth'} · {record.dentistName || '—'}
                      </div>
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="numerical">{fmtMoney(record.totalPaisa)}</span>
                      {record.invoiceItemId ? <Badge tone="info">Invoiced</Badge> : <Badge>Unbilled</Badge>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card title={`Tooth findings (${detail.findings.length})`}>
            {detail.findings.length === 0 ? (
              <Empty title="No findings recorded" />
            ) : (
              <div className="chip-row">
                {detail.findings.map((finding) => (
                  <Badge key={finding.id} tone="accent">
                    {finding.toothFdi} · {finding.finding.replace(/_/g, ' ')}
                  </Badge>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </Drawer>
  );
}

export function VisitsScreen(): JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const defaultPatientId = Number(params.get('patient')) || null;
  const [createOpen, setCreateOpen] = useState(Boolean(defaultPatientId));
  const [search, setSearch] = useState('');
  const [preset, setPreset] = useState('');
  const [dentistId, setDentistId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number | null>(null);

  const list = useApi(
    'visits.list',
    { page, pageSize: 25, search: search || undefined, preset: preset || undefined, dentistId },
    [page, search, preset, dentistId],
  );
  const items = list.data?.items ?? [];

  return (
    <Page
      title="Visits"
      description={`${list.data?.total ?? 0} visit(s) recorded`}
      actions={
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>
          Record visit
        </Button>
      }
    >
      <div className="filters">
        <div className="row row--wrap" style={{ gap: 10 }}>
          <div style={{ minWidth: 260, flex: 1 }}>
            <SearchInput
              value={search}
              placeholder="Search by patient, diagnosis or complaint…"
              onChange={(value) => {
                setSearch(value);
                setPage(1);
              }}
            />
          </div>
          <Select
            value={preset}
            placeholder="All time"
            options={rangePresetOptions().filter((option) => option.value !== '')}
            onChange={(event) => {
              setPreset(event.target.value);
              setPage(1);
            }}
          />
          <DentistFilter value={dentistId} onChange={(value) => { setDentistId(value); setPage(1); }} />
        </div>
      </div>

      <Card padded={false}>
        <DataTable
          columns={[
            { key: 'date', label: 'Date' },
            { key: 'patient', label: 'Patient' },
            { key: 'dentist', label: 'Dentist' },
            { key: 'complaint', label: 'Chief complaint' },
            { key: 'diagnosis', label: 'Diagnosis' },
            { key: 'treatment', label: 'Treatment', align: 'right' },
            { key: 'invoice', label: 'Billing' },
          ]}
          rows={items.map((visit: VisitSummary) => ({
            date: (
              <div>
                <div>{fmtDate(visit.visitDate)}</div>
                <div className="small muted">{fmtTime(visit.visitTime)}</div>
              </div>
            ),
            patient: (
              <button
                type="button"
                className="btn btn--link"
                onClick={(event) => {
                  event.stopPropagation();
                  navigate(resolveScreenPath('patient', visit.patientId));
                }}
              >
                {visit.patientName}
              </button>
            ),
            dentist: visit.dentistName || '—',
            complaint: visit.chiefComplaint || '—',
            diagnosis: visit.diagnosis || '—',
            treatment: visit.treatmentCount > 0 ? `${visit.treatmentCount} item(s)` : '—',
            invoice: visit.invoiceNumber ? (
              <span className="mono small">{visit.invoiceNumber}</span>
            ) : visit.hasPrescription ? (
              <Badge tone="info">Prescription</Badge>
            ) : (
              <Badge>Unbilled</Badge>
            ),
          }))}
          loading={list.loading && !list.data}
          error={list.error}
          onRetry={list.reload}
          onRowClick={(index) => setSelected(items[index]?.id ?? null)}
          rowKey={(index) => String(items[index]?.id ?? index)}
          empty={
            <Empty
              title="No visits yet"
              text="Record the first visit to build the clinical history."
              icon={<ClipboardCheck size={24} />}
              action={
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  Record visit
                </Button>
              }
            />
          }
        />
        {list.data && list.data.total > 0 ? (
          <div className="pagination">
            <span>
              Page {list.data.page} of {Math.max(1, list.data.pageCount)} · {list.data.total} visit(s)
            </span>
            <div className="pagination__pages">
              <Button size="sm" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
                Previous
              </Button>
              <Button size="sm" disabled={page >= list.data.pageCount} onClick={() => setPage((current) => current + 1)}>
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      <Banner tone="info" title="Visits are immutable.">
        A saved visit is never silently rewritten — correcting a record means recording a new visit, so the history
        stays auditable.
      </Banner>

      <VisitDialog
        open={createOpen}
        defaultPatientId={defaultPatientId}
        onClose={() => setCreateOpen(false)}
        onSaved={(id) => {
          list.reload();
          setSelected(id);
        }}
      />
      <VisitDetailDrawer visitId={selected} onClose={() => setSelected(null)} />
    </Page>
  );
}

function DentistFilter({ value, onChange }: { value: number | null; onChange(value: number | null): void }): JSX.Element {
  const dentists = useApi('dentists.list', { includeInactive: false });
  return (
    <Select
      value={value === null ? '' : String(value)}
      placeholder="All dentists"
      options={(dentists.data ?? []).map((dentist: Dentist) => ({ value: String(dentist.id), label: dentist.name }))}
      onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}
    />
  );
}
