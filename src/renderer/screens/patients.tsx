/**
 * Patient register: search, filter, sort, paginate, register and edit.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Plus, Tag, UserPlus } from 'lucide-react';
import { resolveScreenPath } from '@shared/api';
import { BLOOD_GROUPS, GENDERS, GENDER_LABELS, PATIENT_STATUSES, PATIENT_STATUS_LABELS, PREFERRED_CONTACTS } from '@shared/constants';
import type { PatientInput, PatientSummary, PatientTag } from '@shared/types';
import { useAction, useApi, useApp } from '@renderer/state/store';
import { bridge } from '@renderer/lib/bridge';
import { fmtDate, fmtMoney } from '@renderer/lib/format';
import { Badge, Button, Chip, Empty, Field, Input, Modal, Page, SearchInput, Select, StatusBadge, Switch, TextArea } from '@renderer/components/ui';
import {
  DataTable,
  DateField,
  PagedFooter,
  SelectField,
  TextField,
  useListState,
  rangePresetOptions,
} from '@renderer/components/forms';

const EMPTY_PATIENT: PatientInput = {
  firstName: '',
  lastName: '',
  gender: 'male',
  dob: null,
  ageYears: null,
  bloodGroup: 'unknown',
  phone: '',
  alternatePhone: '',
  email: '',
  address: '',
  city: '',
  emergencyContactName: '',
  emergencyPhone: '',
  chiefComplaint: '',
  previousProblems: '',
  medicalNotes: '',
  allergies: '',
  notes: '',
  preferredContact: 'mobile',
  status: 'active',
  referredBy: '',
  tagIds: [],
};

export function PatientForm({
  open,
  onClose,
  onSaved,
  patientId,
}: {
  open: boolean;
  onClose(): void;
  onSaved(id: number): void;
  patientId: number | null;
}): JSX.Element | null {
  const { toast } = useApp();
  const { run, busy } = useAction();
  const [form, setForm] = useState<PatientInput>(EMPTY_PATIENT);
  const [ageYears, setAgeYears] = useState('');
  const [duplicates, setDuplicates] = useState<Array<{ id: number; code: string; name: string; phone: string }>>([]);
  const tags = useApi('resource.list', { resource: 'patient-tags', query: { pageSize: 100 } });
  const existing = useApi('patients.get', patientId ? { id: patientId } : null);

  useEffect(() => {
    if (!open) return;
    if (!patientId) {
      setForm(EMPTY_PATIENT);
      setAgeYears('');
      setDuplicates([]);
      return;
    }
    const detail = existing.data;
    if (!detail) return;
    setForm({
      firstName: detail.firstName,
      lastName: detail.lastName,
      gender: detail.gender,
      dob: detail.dob,
      ageYears: detail.ageYears,
      bloodGroup: detail.bloodGroup,
      phone: detail.phone,
      alternatePhone: detail.alternatePhone,
      email: detail.email,
      address: detail.address,
      city: detail.city,
      emergencyContactName: detail.emergencyContactName,
      emergencyPhone: detail.emergencyPhone,
      chiefComplaint: detail.chiefComplaint,
      previousProblems: detail.previousProblems,
      medicalNotes: detail.medicalNotes,
      allergies: detail.allergies,
      notes: detail.notes,
      preferredContact: detail.preferredContact,
      status: detail.status,
      referredBy: detail.referredBy,
      tagIds: [],
    });
    setAgeYears(detail.ageYears ? String(detail.ageYears) : '');
  }, [existing.data, open, patientId]);

  const patch = (patchValue: Partial<PatientInput>) => setForm((current) => ({ ...current, ...patchValue }));

  const checkDuplicates = async () => {
    const name = `${form.firstName} ${form.lastName}`.trim();
    if (!name && !form.phone) return;
    const result = await run(() =>
      bridge.invoke('patients.checkDuplicate', {
        name,
        phone: form.phone,
        excludeId: patientId ?? undefined,
      }),
    );
    if (result) setDuplicates(result.matches);
  };

  const save = async () => {
    const payload: PatientInput = {
      ...form,
      ageYears: form.dob ? null : ageYears.trim() ? Number(ageYears) : null,
    };
    const saved = await run(
      () =>
        patientId
          ? bridge.invoke('patients.update', { id: patientId, input: payload }).then(() => ({ id: patientId }))
          : bridge.invoke('patients.create', { input: payload }),
      { success: patientId ? 'Patient updated.' : 'Patient registered.', failure: 'The patient could not be saved.' },
    );
    if (saved) {
      toast('success', patientId ? 'Patient updated' : 'Patient registered');
      onSaved(saved.id);
    }
  };

  if (!open) return null;
  const tagOptions = (tags.data?.items ?? []) as unknown as PatientTag[];

  return (
    <Modal
      open
      width="wide"
      title={patientId ? 'Edit patient' : 'Register a patient'}
      description="Fields marked with * are required. Bengali names, addresses and notes are fully supported."
      onClose={onClose}
      footer={
        <div className="row row--end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!form.firstName.trim() || !form.phone.trim()} onClick={() => void save()}>
            {patientId ? 'Save changes' : 'Register patient'}
          </Button>
        </div>
      }
    >
      <div className="stack">
        <div className="grid-3">
          <TextField label="First name" required value={form.firstName} onChange={(value) => patch({ firstName: value })} />
          <TextField label="Last name" value={form.lastName} onChange={(value) => patch({ lastName: value })} />
          <SelectField
            label="Gender"
            required
            value={form.gender}
            options={GENDERS.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(value) => patch({ gender: value })}
          />
        </div>

        <div className="grid-3">
          <DateField label="Date of birth" value={form.dob ?? ''} onChange={(value) => patch({ dob: value || null })} hint="Leave empty to record an age instead" />
          <Field label="Age in years" hint="Used when the date of birth is unknown">
            <Input
              className="input--numeric"
              inputMode="numeric"
              value={ageYears}
              disabled={Boolean(form.dob)}
              onChange={(event) => setAgeYears(event.target.value.replace(/[^0-9]/g, ''))}
            />
          </Field>
          <SelectField
            label="Blood group"
            value={form.bloodGroup}
            options={BLOOD_GROUPS.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(value) => patch({ bloodGroup: value })}
          />
        </div>

        <div className="grid-3">
          <TextField
            label="Mobile number"
            required
            type="tel"
            value={form.phone}
            onChange={(value) => patch({ phone: value })}
            placeholder="01XXXXXXXXX"
          />
          <TextField label="Alternate number" type="tel" value={form.alternatePhone} onChange={(value) => patch({ alternatePhone: value })} />
          <TextField label="Email" type="email" value={form.email} onChange={(value) => patch({ email: value })} />
        </div>

        <div className="grid-2">
          <TextField label="Address" value={form.address} onChange={(value) => patch({ address: value })} />
          <TextField label="City / district" value={form.city} onChange={(value) => patch({ city: value })} />
        </div>

        <div className="grid-3">
          <TextField
            label="Emergency contact"
            value={form.emergencyContactName}
            onChange={(value) => patch({ emergencyContactName: value })}
          />
          <TextField label="Emergency phone" type="tel" value={form.emergencyPhone} onChange={(value) => patch({ emergencyPhone: value })} />
          <SelectField
            label="Preferred contact"
            value={form.preferredContact}
            options={PREFERRED_CONTACTS.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(value) => patch({ preferredContact: value })}
          />
        </div>

        <div className="grid-2">
          <Field label="Chief complaint" hint="What the patient came in with">
            <TextArea value={form.chiefComplaint} rows={2} onChange={(event) => patch({ chiefComplaint: event.target.value })} />
          </Field>
          <Field label="Allergies" hint="Shown as a red alert on the patient profile">
            <TextArea value={form.allergies} rows={2} onChange={(event) => patch({ allergies: event.target.value })} />
          </Field>
        </div>

        <div className="grid-2">
          <Field label="Previous problems / medical history">
            <TextArea value={form.previousProblems} rows={2} onChange={(event) => patch({ previousProblems: event.target.value })} />
          </Field>
          <Field label="Medical notes">
            <TextArea value={form.medicalNotes} rows={2} onChange={(event) => patch({ medicalNotes: event.target.value })} />
          </Field>
        </div>

        <div className="grid-3">
          <SelectField
            label="Status"
            value={form.status}
            options={PATIENT_STATUSES.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(value) => patch({ status: value })}
          />
          <TextField label="Referred by" value={form.referredBy} onChange={(value) => patch({ referredBy: value })} />
          <Field label="Tags">
            <div className="chip-row">
              {tagOptions.length === 0 ? <span className="small muted">No tags yet</span> : null}
              {tagOptions.map((tag) => {
                const selected = form.tagIds.includes(tag.id);
                return (
                  <Chip
                    key={tag.id}
                    selected={selected}
                    onClick={() =>
                      patch({
                        tagIds: selected ? form.tagIds.filter((id) => id !== tag.id) : [...form.tagIds, tag.id],
                      })
                    }
                  >
                    {tag.name}
                  </Chip>
                );
              })}
            </div>
          </Field>
        </div>

        <Field label="Internal notes">
          <TextArea value={form.notes} rows={2} onChange={(event) => patch({ notes: event.target.value })} />
        </Field>

        {!patientId ? (
          <div className="card">
            <div className="card__body">
              <div className="row row--between">
                <div>
                  <strong>Possible duplicates</strong>
                  <div className="small muted">Check before saving to avoid two records for the same person.</div>
                </div>
                <Button size="sm" onClick={() => void checkDuplicates()}>
                  Check
                </Button>
              </div>
              {duplicates.length > 0 ? (
                <div className="stack stack--sm" style={{ marginTop: 10 }}>
                  {duplicates.map((match) => (
                    <div key={match.id} className="row row--between">
                      <span>
                        {match.name} <span className="mono small">{match.code}</span>
                      </span>
                      <span className="small muted">{match.phone}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

export function PatientsScreen(): JSX.Element {
  const navigate = useNavigate();
  const lists = useListState({ sort: 'registered_at', direction: 'desc' });
  const [statusFilter, setStatusFilter] = useState('');
  const [genderFilter, setGenderFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [outstandingOnly, setOutstandingOnly] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const { run, busy } = useAction();
  const tags = useApi('resource.list', { resource: 'patient-tags', query: { pageSize: 100 } });

  const query = {
    page: lists.state.page,
    pageSize: lists.state.pageSize,
    search: lists.state.search || undefined,
    preset: lists.state.preset || undefined,
    sort: lists.state.sort || undefined,
    direction: lists.state.direction,
    status: statusFilter ? [statusFilter as PatientSummary['status']] : undefined,
    gender: genderFilter ? [genderFilter as PatientSummary['gender']] : undefined,
    tagIds: tagFilter ? [Number(tagFilter)] : undefined,
    hasOutstanding: outstandingOnly || undefined,
  };
  const patients = useApi('patients.list', query, [lists.state.page, JSON.stringify(query)]);

  const exportCsv = async () => {
    const result = await run(() => bridge.invoke('system.exportCsv', { what: 'patients', from: undefined, to: undefined }), {
      success: 'Patient list exported.',
      failure: 'The export failed.',
    });
    if (result?.path) await run(() => bridge.invoke('app.openPath', { path: result.path, reveal: true }));
  };

  const rows = (patients.data?.items ?? []).map((patient) => ({
    patient: (
      <div className="row" style={{ gap: 10 }}>
        <div>
          <div>{patient.name}</div>
          <div className="small muted">
            <span className="mono">{patient.code}</span>
            {patient.phone ? ` · ${patient.phone}` : ''}
          </div>
        </div>
        {patient.tags.length > 0 ? <Badge>{patient.tags[0]}</Badge> : null}
      </div>
    ),
    age: patient.ageText || '—',
    gender: GENDER_LABELS[patient.gender],
    lastVisit: patient.lastVisitDate ? fmtDate(patient.lastVisitDate) : 'Never',
    visits: String(patient.visitCount),
    outstanding: patient.outstandingPaisa === null ? '—' : fmtMoney(patient.outstandingPaisa),
    status: <StatusBadge status={patient.status} label={PATIENT_STATUS_LABELS[patient.status]} />,
  }));

  return (
    <Page
      title="Patients"
      description={`${patients.data?.total ?? 0} record(s)`}
      actions={
        <>
          <Button icon={<Download size={15} />} loading={busy} onClick={() => void exportCsv()}>
            Export CSV
          </Button>
          <Button variant="primary" icon={<UserPlus size={15} />} onClick={() => setCreating(true)}>
            Register patient
          </Button>
        </>
      }
    >
      <div className="filters">
        <div className="row row--wrap" style={{ gap: 10 }}>
          <div style={{ minWidth: 260, flex: 1 }}>
            <SearchInput
              value={lists.state.search}
              onChange={(value) => lists.patch({ search: value })}
              placeholder="Search by name, code, phone or city…"
            />
          </div>
          <Select
            value={statusFilter}
            placeholder="Any status"
            options={PATIENT_STATUSES.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(event) => {
              setStatusFilter(event.target.value);
              lists.patch({});
            }}
          />
          <Select
            value={genderFilter}
            placeholder="Any gender"
            options={GENDERS.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(event) => {
              setGenderFilter(event.target.value);
              lists.patch({});
            }}
          />
          <Select
            value={tagFilter}
            placeholder="Any tag"
            options={((tags.data?.items ?? []) as unknown as PatientTag[]).map((tag) => ({
              value: String(tag.id),
              label: tag.name,
            }))}
            onChange={(event) => {
              setTagFilter(event.target.value);
              lists.patch({});
            }}
          />
          <Select
            value={lists.state.preset}
            placeholder="Registered"
            options={rangePresetOptions().filter((option) => option.value !== '')}
            onChange={(event) => lists.patch({ preset: event.target.value })}
          />
          <Switch
            label="With dues"
            checked={outstandingOnly}
            onChange={(value) => {
              setOutstandingOnly(value);
              lists.patch({});
            }}
          />
          {(statusFilter || genderFilter || tagFilter || lists.state.search || lists.state.preset || outstandingOnly) ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setStatusFilter('');
                setGenderFilter('');
                setTagFilter('');
                setOutstandingOnly(false);
                lists.resetFilters();
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
      </div>

      <div className="card">
        <DataTable
          columns={[
            { key: 'patient', label: 'Patient' },
            { key: 'age', label: 'Age' },
            { key: 'gender', label: 'Gender' },
            { key: 'lastVisit', label: 'Last visit' },
            { key: 'visits', label: 'Visits', align: 'right' },
            { key: 'outstanding', label: 'Outstanding', align: 'right' },
            { key: 'status', label: 'Status' },
          ]}
          rows={rows}
          loading={patients.loading && !patients.data}
          error={patients.error}
          onRetry={patients.reload}
          onRowClick={(index) => {
            const patient = patients.data?.items[index];
            if (patient) navigate(resolveScreenPath('patient', patient.id));
          }}
          rowKey={(index) => String(patients.data?.items[index]?.id ?? index)}
          empty={
            <Empty
              title="No patients matched your filters"
              text="Try a different search, or register the patient now."
              action={
                <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>
                  Register patient
                </Button>
              }
              icon={<Tag size={24} />}
            />
          }
        />
        <PagedFooter page={lists.state.page} onPage={(page) => lists.patch({ page })} data={patients.data} />
      </div>

      <PatientForm
        open={creating}
        patientId={null}
        onClose={() => setCreating(false)}
        onSaved={(id) => {
          setCreating(false);
          patients.reload();
          navigate(resolveScreenPath('patient', id));
        }}
      />
      <PatientForm
        open={editing !== null}
        patientId={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          patients.reload();
        }}
      />
    </Page>
  );
}
