/**
 * Prescriptions: list, write, print.
 *
 * The editor mirrors the paper prescription a Bangladeshi patient expects —
 * C/C, O/E, R/E and advice sections plus a medication table with
 * morning/noon/night doses — and the printed sheet comes from the template in
 * Settings → Printing.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FileText, Pill, Plus, Printer, X } from 'lucide-react';
import { resolveScreenPath } from '@shared/api';
import { FOOD_TIMINGS, MEDICATION_FORMS } from '@shared/constants';
import { todayIso } from '@shared/dates';
import type { ClinicalOptionCategory, FoodTiming, MedicationForm } from '@shared/constants';
import type {
  Medication,
  PatientSummary,
  PrescriptionDetail,
  PrescriptionInput,
  PrescriptionItemInput,
  PrescriptionSummary,
} from '@shared/types';
import { useAction, useApi, useApp } from '@renderer/state/store';
import { bridge } from '@renderer/lib/bridge';
import { fmtDate, fmtInstant } from '@renderer/lib/format';
import {
  Badge,
  Button,
  Card,
  Chip,
  DefinitionList,
  Drawer,
  Empty,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  Modal,
  Page,
  SearchInput,
  Select,
  StatusBadge,
  TextArea,
} from '@renderer/components/ui';
import { DataTable, DentistSelect, PatientPicker, TextField, rangePresetOptions } from '@renderer/components/forms';

function emptyItem(sortOrder: number): PrescriptionItemInput {
  return {
    medicationId: null,
    name: '',
    form: 'tablet',
    strength: '',
    doseMorning: 1,
    doseNoon: 1,
    doseNight: 1,
    foodTiming: 'after_food',
    durationDays: 5,
    quantity: null,
    instructions: '',
    sortOrder,
  };
}

function emptyPrescription(patientId = 0): PrescriptionInput {
  return {
    patientId,
    dentistId: null,
    visitId: null,
    date: todayIso(),
    cc: [],
    oe: [],
    re: [],
    advice: [],
    notes: '',
    items: [emptyItem(1)],
  };
}

function OptionSection({
  title,
  category,
  selected,
  onToggle,
}: {
  title: string;
  category: ClinicalOptionCategory;
  selected: string[];
  onToggle(label: string): void;
}): JSX.Element {
  const options = useApi('resource.list', { resource: 'clinical-options', query: { pageSize: 200 }, includeInactive: false });
  const list = (options.data?.items ?? []).filter((option) => (option as { category: string }).category === category);
  return (
    <Field label={title} hint={list.length === 0 ? 'Add options in Settings → Clinical options' : undefined}>
      <div className="chip-row">
        {list.map((option) => {
          const label = (option as { label: string }).label;
          return (
            <Chip key={(option as { id: number }).id} selected={selected.includes(label)} onClick={() => onToggle(label)}>
              {label}
            </Chip>
          );
        })}
        {list.length === 0 ? <span className="small muted">No {title.toLowerCase()} options configured.</span> : null}
      </div>
    </Field>
  );
}

function PrescriptionEditor({
  open,
  prescriptionId,
  defaultPatientId,
  onClose,
  onSaved,
}: {
  open: boolean;
  prescriptionId: number | null;
  defaultPatientId: number | null;
  onClose(): void;
  onSaved(id: number): void;
}): JSX.Element | null {
  const { toast } = useApp();
  const { run, busy } = useAction();
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [form, setForm] = useState<PrescriptionInput>(emptyPrescription());
  const existing = useApi('prescriptions.get', prescriptionId ? { id: prescriptionId } : null);
  const prefill = useApi('patients.quickSearch', defaultPatientId ? { query: String(defaultPatientId), limit: 5 } : null);
  const medications = useApi('resource.list', { resource: 'medications', query: { pageSize: 300 } });

  useEffect(() => {
    const match = defaultPatientId ? (prefill.data ?? []).find((candidate) => candidate.id === defaultPatientId) : undefined;
    if (match && !prescriptionId) {
      setPatient(match);
      setForm(emptyPrescription(match.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultPatientId, prefill.data, prescriptionId]);

  useEffect(() => {
    const detail = existing.data as PrescriptionDetail | null;
    if (!detail) return;
    setForm({
      patientId: detail.patientId,
      dentistId: detail.dentistId,
      visitId: detail.visitId,
      date: detail.date,
      cc: [...detail.cc],
      oe: [...detail.oe],
      re: [...detail.re],
      advice: [...detail.advice],
      notes: detail.notes,
      items: detail.items.map((item, index) => ({ ...item, sortOrder: index + 1 })),
    });
  }, [existing.data]);

  const patch = (value: Partial<PrescriptionInput>) => setForm((current) => ({ ...current, ...value }));

  const patchItems = (items: PrescriptionItemInput[]) => patch({ items });

  const applyMedication = (index: number, medicationId: number) => {
    const catalog = (medications.data?.items ?? []) as unknown as Medication[];
    const medication = catalog.find((entry) => entry.id === medicationId);
    const items = [...form.items];
    items[index] = medication
      ? {
          ...items[index]!,
          medicationId: medication.id,
          name: medication.name,
          form: medication.form,
          strength: medication.strength,
          doseMorning: medication.defaultDoseMorning,
          doseNoon: medication.defaultDoseNoon,
          doseNight: medication.defaultDoseNight,
          foodTiming: medication.defaultFoodTiming,
          durationDays: medication.defaultDurationDays ?? items[index]!.durationDays,
        }
      : { ...items[index]!, medicationId: null };
    patchItems(items);
  };

  const save = async () => {
    const patientId = patient?.id ?? form.patientId;
    if (!patientId) {
      toast('warning', 'Choose a patient first');
      return;
    }
    const input: PrescriptionInput = {
      ...form,
      patientId,
      items: form.items
        .filter((item) => item.name.trim())
        .map((item, index) => ({ ...item, sortOrder: index + 1 })),
    };
    if (input.items.length === 0) {
      toast('warning', 'Add at least one medication');
      return;
    }
    const saved = await run(
      () =>
        prescriptionId
          ? bridge.invoke('prescriptions.update', { id: prescriptionId, input }).then(() => ({ id: prescriptionId }))
          : bridge.invoke('prescriptions.create', { input }),
      { success: 'Prescription saved.', failure: 'The prescription could not be saved.' },
    );
    if (saved) {
      toast('success', prescriptionId ? 'Prescription updated' : 'Prescription written');
      onSaved(saved.id);
      onClose();
    }
  };

  if (!open) return null;

  return (
    <Modal
      open
      width="wide"
      title={prescriptionId ? 'Edit prescription' : 'Write a prescription'}
      description="Doses are recorded as morning / noon / night so the printed sheet is unambiguous."
      onClose={onClose}
      footer={
        <div className="row row--end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            <Pill size={15} /> Save prescription
          </Button>
        </div>
      }
    >
      <div className="stack">
        <PatientPicker value={patient} onChange={setPatient} autoFocus={!prescriptionId && !defaultPatientId} />
        <div className="grid-3">
          <Field label="Date" required>
            <Input type="date" value={form.date} onChange={(event) => patch({ date: event.target.value })} />
          </Field>
          <DentistSelect value={form.dentistId} onChange={(value) => patch({ dentistId: value })} />
          <TextField
            label="Visit ID"
            value={form.visitId === null ? '' : String(form.visitId)}
            hint="Links this prescription to a visit"
            onChange={(value) => patch({ visitId: value ? Number(value) : null })}
          />
        </div>

        <div className="grid-2">
          <OptionSection title="C/C — Chief complaint" category="cc" selected={form.cc} onToggle={(label) => patch({ cc: form.cc.includes(label) ? form.cc.filter((item) => item !== label) : [...form.cc, label] })} />
          <OptionSection title="O/E — On examination" category="oe" selected={form.oe} onToggle={(label) => patch({ oe: form.oe.includes(label) ? form.oe.filter((item) => item !== label) : [...form.oe, label] })} />
          <OptionSection title="R/E — Diagnosis" category="re" selected={form.re} onToggle={(label) => patch({ re: form.re.includes(label) ? form.re.filter((item) => item !== label) : [...form.re, label] })} />
          <OptionSection title="Advice" category="advice" selected={form.advice} onToggle={(label) => patch({ advice: form.advice.includes(label) ? form.advice.filter((item) => item !== label) : [...form.advice, label] })} />
        </div>

        <Card
          title="Medications"
          actions={
            <Button size="sm" icon={<Plus size={14} />} onClick={() => patchItems([...form.items, emptyItem(form.items.length + 1)])}>
              Add medicine
            </Button>
          }
        >
          <div className="stack stack--sm">
            {form.items.map((item, index) => (
              <div key={index} className="card">
                <div className="card__body stack stack--sm">
                  <div className="grid-4" style={{ alignItems: 'end' }}>
                    <Field label="From catalogue">
                      <Select
                        value={item.medicationId === null ? '' : String(item.medicationId)}
                        placeholder="Type below instead"
                        options={((medications.data?.items ?? []) as unknown as Medication[]).map((medication) => ({
                          value: String(medication.id),
                          label: `${medication.name}${medication.strength ? ` ${medication.strength}` : ''}`,
                        }))}
                        onChange={(event) => applyMedication(index, Number(event.target.value))}
                      />
                    </Field>
                    <TextField
                      label="Medicine name"
                      value={item.name}
                      onChange={(value) => {
                        const items = [...form.items];
                        items[index] = { ...item, name: value, medicationId: null };
                        patchItems(items);
                      }}
                    />
                    <TextField
                      label="Strength"
                      value={item.strength}
                      onChange={(value) => {
                        const items = [...form.items];
                        items[index] = { ...item, strength: value };
                        patchItems(items);
                      }}
                    />
                    <Field label="Form">
                      <Select
                        value={item.form}
                        options={MEDICATION_FORMS.map((option) => ({ value: option.value, label: option.label }))}
                        onChange={(event) => {
                          const items = [...form.items];
                          items[index] = { ...item, form: event.target.value as MedicationForm };
                          patchItems(items);
                        }}
                      />
                    </Field>
                  </div>

                  <div className="grid-4" style={{ alignItems: 'end' }}>
                    <Field label="Morning">
                      <Input
                        className="input--numeric"
                        inputMode="decimal"
                        value={String(item.doseMorning)}
                        onChange={(event) => {
                          const items = [...form.items];
                          items[index] = { ...item, doseMorning: Number(event.target.value) || 0 };
                          patchItems(items);
                        }}
                      />
                    </Field>
                    <Field label="Noon">
                      <Input
                        className="input--numeric"
                        inputMode="decimal"
                        value={String(item.doseNoon)}
                        onChange={(event) => {
                          const items = [...form.items];
                          items[index] = { ...item, doseNoon: Number(event.target.value) || 0 };
                          patchItems(items);
                        }}
                      />
                    </Field>
                    <Field label="Night">
                      <Input
                        className="input--numeric"
                        inputMode="decimal"
                        value={String(item.doseNight)}
                        onChange={(event) => {
                          const items = [...form.items];
                          items[index] = { ...item, doseNight: Number(event.target.value) || 0 };
                          patchItems(items);
                        }}
                      />
                    </Field>
                    <Field label="Food timing">
                      <Select
                        value={item.foodTiming}
                        options={FOOD_TIMINGS.map((option) => ({ value: option.value, label: option.label }))}
                        onChange={(event) => {
                          const items = [...form.items];
                          items[index] = { ...item, foodTiming: event.target.value as FoodTiming };
                          patchItems(items);
                        }}
                      />
                    </Field>
                  </div>

                  <div className="grid-3" style={{ alignItems: 'end' }}>
                    <Field label="Days">
                      <Input
                        className="input--numeric"
                        inputMode="numeric"
                        value={item.durationDays === null ? '' : String(item.durationDays)}
                        onChange={(event) => {
                          const items = [...form.items];
                          items[index] = { ...item, durationDays: event.target.value ? Number(event.target.value) : null };
                          patchItems(items);
                        }}
                      />
                    </Field>
                    <TextField
                      label="Instructions"
                      value={item.instructions}
                      onChange={(value) => {
                        const items = [...form.items];
                        items[index] = { ...item, instructions: value };
                        patchItems(items);
                      }}
                    />
                    <Button
                      variant="ghost"
                      onClick={() => patchItems(form.items.filter((_, position) => position !== index))}
                    >
                      <X size={15} /> Remove
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Field label="Notes for the patient">
          <TextArea value={form.notes} rows={2} onChange={(event) => patch({ notes: event.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

function PrescriptionDrawer({
  prescriptionId,
  onClose,
  onChanged,
}: {
  prescriptionId: number | null;
  onClose(): void;
  onChanged(): void;
}): JSX.Element | null {
  const { confirm } = useApp();
  const { run } = useAction();
  const prescription = useApi('prescriptions.get', prescriptionId ? { id: prescriptionId } : null);
  const detail = prescription.data as PrescriptionDetail | null;

  if (!prescriptionId) return null;

  const print = async (output: 'pdf' | 'print') => {
    const result = await run(
      () => bridge.invoke('print.render', { kind: 'prescription', id: prescriptionId, output }),
      { success: output === 'print' ? 'Sent to the printer.' : 'PDF generated.', failure: 'Printing failed.' },
    );
    if (result?.pdfPath) await run(() => bridge.invoke('app.openPath', { path: result.pdfPath! }));
    prescription.reload();
  };

  const voidPrescription = async () => {
    const answer = await confirm({
      title: 'Void this prescription',
      description: 'A void prescription stays in the history and is marked as cancelled.',
      confirmLabel: 'Void prescription',
      tone: 'danger',
      reason: true,
    });
    if (!answer.ok || !answer.reason) return;
    const done = await run(() => bridge.invoke('prescriptions.void', { id: prescriptionId, reason: answer.reason! }), {
      success: 'Prescription voided.',
    });
    if (done !== null) {
      onChanged();
      prescription.reload();
    }
  };

  return (
    <Drawer
      open
      title={detail ? `Prescription ${detail.number}` : 'Prescription'}
      onClose={onClose}
      footer={
        detail ? (
          <div className="row row--end">
            <Button variant="ghost" icon={<Printer size={15} />} onClick={() => void print('pdf')}>
              PDF
            </Button>
            <Button variant="primary" icon={<Printer size={15} />} onClick={() => void print('print')}>
              Print
            </Button>
            {!detail.isVoid ? (
              <Button variant="danger" onClick={() => void voidPrescription()}>
                Void
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      {prescription.loading && !detail ? (
        <LoadingBlock rows={6} />
      ) : !detail ? (
        <ErrorState message={prescription.error ?? 'Not found'} onRetry={prescription.reload} />
      ) : (
        <div className="stack">
          <DefinitionList
            items={[
              { label: 'Patient', value: `${detail.patientName} (${detail.patientCode})` },
              { label: 'Age / gender', value: `${detail.patientAgeText || '—'} · ${detail.patientGender}` },
              { label: 'Dentist', value: detail.dentistName || '—' },
              { label: 'Date', value: fmtDate(detail.date) },
              { label: 'C/C', value: detail.cc.join(', ') },
              { label: 'O/E', value: detail.oe.join(', ') },
              { label: 'R/E', value: detail.re.join(', ') },
              { label: 'Advice', value: detail.advice.join(', ') },
              { label: 'Notes', value: detail.notes },
              { label: 'Written by', value: `${detail.createdByName} · ${fmtInstant(detail.createdAt)}` },
            ]}
          />

          {detail.isVoid ? <Badge tone="danger">Void — {detail.voidReason}</Badge> : null}

          <Card title={`Medications (${detail.items.length})`}>
            <div className="stack stack--sm">
              {detail.items.map((item) => (
                <div key={item.id} className="row row--between">
                  <div>
                    <div>
                      {item.name} {item.strength}
                    </div>
                    <div className="small muted">
                      {item.form} · {item.doseMorning}-{item.doseNoon}-{item.doseNight} · {item.foodTiming.replace(/_/g, ' ')}
                      {item.durationDays ? ` · ${item.durationDays} day(s)` : ''}
                    </div>
                  </div>
                  {item.instructions ? <span className="small muted">{item.instructions}</span> : null}
                </div>
              ))}
            </div>
          </Card>

          {detail.supersededById ? (
            <div className="small muted">This prescription was superseded by a newer one (#{detail.supersededById}).</div>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}

export function PrescriptionsScreen(): JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const defaultPatientId = Number(params.get('patient')) || null;
  const [search, setSearch] = useState('');
  const [preset, setPreset] = useState('');
  const [includeVoid, setIncludeVoid] = useState(false);
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(Boolean(defaultPatientId));
  const [selected, setSelected] = useState<number | null>(null);

  const list = useApi(
    'prescriptions.list',
    { page, pageSize: 25, search: search || undefined, preset: preset || undefined, includeVoid },
    [page, search, preset, includeVoid],
  );
  const items = list.data?.items ?? [];

  return (
    <Page
      title="Prescriptions"
      description={`${list.data?.total ?? 0} prescription(s)`}
      actions={
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>
          Write prescription
        </Button>
      }
    >
      <div className="filters">
        <div className="row row--wrap" style={{ gap: 10 }}>
          <div style={{ minWidth: 260, flex: 1 }}>
            <SearchInput
              value={search}
              placeholder="Search by number, patient or medicine…"
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
          <Button variant={includeVoid ? 'navy' : 'ghost'} onClick={() => setIncludeVoid((current) => !current)}>
            {includeVoid ? 'Hiding nothing' : 'Hide voided'}
          </Button>
        </div>
      </div>

      <Card padded={false}>
        <DataTable
          columns={[
            { key: 'number', label: 'Number' },
            { key: 'date', label: 'Date' },
            { key: 'patient', label: 'Patient' },
            { key: 'dentist', label: 'Dentist' },
            { key: 'diagnosis', label: 'Diagnosis' },
            { key: 'items', label: 'Meds', align: 'right' },
            { key: 'status', label: 'Status' },
          ]}
          rows={items.map((prescription: PrescriptionSummary) => ({
            number: <span className="mono small">{prescription.number}</span>,
            date: fmtDate(prescription.date),
            patient: (
              <button
                type="button"
                className="btn btn--link"
                onClick={(event) => {
                  event.stopPropagation();
                  navigate(resolveScreenPath('patient', prescription.patientId));
                }}
              >
                {prescription.patientName}
              </button>
            ),
            dentist: prescription.dentistName || '—',
            diagnosis: prescription.diagnosis || '—',
            items: String(prescription.itemCount),
            status: prescription.isVoid ? (
              <Badge tone="danger">Void</Badge>
            ) : prescription.printedAt ? (
              <Badge tone="success">Printed {fmtDate(prescription.printedAt.slice(0, 10))}</Badge>
            ) : (
              <Badge>Not printed</Badge>
            ),
          }))}
          loading={list.loading && !list.data}
          error={list.error}
          onRetry={list.reload}
          onRowClick={(index) => setSelected(items[index]?.id ?? null)}
          rowKey={(index) => String(items[index]?.id ?? index)}
          empty={
            <Empty
              title="No prescriptions yet"
              text="Write the first prescription — it takes less than a minute."
              icon={<FileText size={24} />}
              action={
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  Write prescription
                </Button>
              }
            />
          }
        />
        {list.data && list.data.total > 0 ? (
          <div className="pagination">
            <span>
              Page {list.data.page} of {Math.max(1, list.data.pageCount)} · {list.data.total} prescription(s)
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

      <PrescriptionEditor
        open={createOpen}
        prescriptionId={null}
        defaultPatientId={defaultPatientId}
        onClose={() => setCreateOpen(false)}
        onSaved={(id) => {
          list.reload();
          setSelected(id);
        }}
      />
      <PrescriptionDrawer
        prescriptionId={selected}
        onClose={() => setSelected(null)}
        onChanged={() => {
          list.reload();
          setSelected(null);
        }}
      />
    </Page>
  );
}
