/**
 * Referrals — patients sent to a specialist, and the follow-up that comes back.
 */
import { useEffect, useState } from 'react';
import { Send, Share2 } from 'lucide-react';
import { REFERRAL_SPECIALTIES, REFERRAL_STATUSES, REFERRAL_STATUS_LABELS } from '@shared/constants';
import type { ReferralStatus } from '@shared/constants';
import { resolveDateRange, todayIso } from '@shared/dates';
import type { DateRangePreset } from '@shared/dates';
import type { PatientSummary, Referral, ReferralInput } from '@shared/types';
import { useAction, useApi, useApp } from '@renderer/state/store';
import { bridge } from '@renderer/lib/bridge';
import { fmtDate } from '@renderer/lib/format';
import {
  Button,
  Card,
  Empty,
  Field,
  Modal,
  Page,
  SearchInput,
  Select,
  Stat,
  StatusBadge,
  TextArea,
} from '@renderer/components/ui';
import { DataTable, DateField, PatientPicker, PagedFooter, TextField, rangePresetOptions, useListState } from '@renderer/components/forms';

const EMPTY: ReferralInput = {
  patientId: 0,
  visitId: null,
  referralDoctorId: null,
  doctorName: '',
  specialty: '',
  organisation: '',
  contact: '',
  reason: '',
  date: todayIso(),
  followUpDate: null,
  status: 'pending',
  notes: '',
};

function ReferralDialog({
  open,
  referral,
  onClose,
  onSaved,
}: {
  open: boolean;
  referral: Referral | null;
  onClose(): void;
  onSaved(): void;
}): JSX.Element | null {
  const { run, busy } = useAction();
  const [form, setForm] = useState<ReferralInput>(EMPTY);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [doctorOptions, setDoctorOptions] = useState<Array<{ label: string; value: number; meta?: string }>>([]);
  const patch = (value: Partial<ReferralInput>) => setForm((current) => ({ ...current, ...value }));

  const doctors = useApi('resource.list', { resource: 'referral-doctors', query: { pageSize: 200 }, includeInactive: false });

  useEffect(() => {
    if (referral) {
      setPatient({
        id: referral.patientId,
        code: referral.patientCode,
        name: referral.patientName,
        phone: '',
        ageYears: null,
        gender: 'other',
        status: 'active',
        lastVisitDate: null,
        outstandingPaisa: 0,
        updatedAt: referral.createdAt,
      } as unknown as PatientSummary);
      setForm({
        patientId: referral.patientId,
        visitId: referral.visitId,
        referralDoctorId: referral.referralDoctorId,
        doctorName: referral.doctorName,
        specialty: referral.specialty,
        organisation: referral.organisation,
        contact: referral.contact,
        reason: referral.reason,
        date: referral.date,
        followUpDate: referral.followUpDate,
        status: referral.status,
        notes: referral.notes,
      });
    } else {
      setPatient(null);
      setForm({ ...EMPTY });
    }
  }, [referral]);

  useEffect(() => {
    const rows = (doctors.data?.items ?? []) as unknown as Array<Record<string, unknown>>;
    setDoctorOptions(
      rows.map((row) => ({
        label: String(row['name'] ?? ''),
        value: Number(row['id']),
        meta: [row['specialty'], row['organisation']].filter(Boolean).join(' · '),
      })),
    );
  }, [doctors.data]);

  if (!open) return null;

  return (
    <Modal
      open
      width="wide"
      title={referral ? `Referral — ${referral.patientName}` : 'New referral'}
      description="Record where the patient was sent and when the result is expected back."
      onClose={onClose}
      footer={
        <div className="row row--end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!form.patientId || form.reason.trim().length < 3 || (form.doctorName.trim() === '' && !form.referralDoctorId)}
            onClick={async () => {
              const saved = await run(() => bridge.invoke('referrals.save', { id: referral?.id ?? null, input: form }), {
                success: referral ? 'Referral updated.' : 'Referral recorded.',
                failure: 'The referral could not be saved.',
              });
              if (saved) {
                onSaved();
                onClose();
              }
            }}
          >
            Save referral
          </Button>
        </div>
      }
    >
      <div className="stack">
        {referral ? null : (
          <PatientPicker
            label="Patient"
            required
            value={patient}
            onChange={(next) => {
              setPatient(next);
              patch({ patientId: next?.id ?? 0 });
            }}
          />
        )}
        <div className="grid-2">
          <Field label="Referred to" hint="Pick a saved doctor or type a new name below">
            <Select
              value={form.referralDoctorId === null ? '' : String(form.referralDoctorId)}
              placeholder="Not from the list"
              options={doctorOptions.map((doctor) => ({
                value: String(doctor.value),
                label: doctor.meta ? `${doctor.label} · ${doctor.meta}` : doctor.label,
              }))}
              onChange={(event) => {
                const id = event.target.value ? Number(event.target.value) : null;
                const chosen = (doctors.data?.items ?? []) as unknown as Array<Record<string, unknown>>;
                const match = chosen.find((row) => Number(row['id']) === id);
                patch({
                  referralDoctorId: id,
                  doctorName: match ? String(match['name'] ?? '') : form.doctorName,
                  specialty: match && !form.specialty ? String(match['specialty'] ?? '') : form.specialty,
                  organisation: match && !form.organisation ? String(match['organisation'] ?? '') : form.organisation,
                  contact: match && !form.contact ? String(match['phone'] ?? '') : form.contact,
                });
              }}
            />
          </Field>
          <TextField label="Doctor name" required value={form.doctorName} onChange={(value) => patch({ doctorName: value })} />
        </div>
        <div className="grid-3">
          <Field label="Specialty">
            <Select
              value={form.specialty}
              placeholder="Choose a specialty"
              options={REFERRAL_SPECIALTIES.map((specialty) => ({ value: specialty, label: specialty }))}
              onChange={(event) => patch({ specialty: event.target.value })}
            />
          </Field>
          <TextField label="Organisation" value={form.organisation} onChange={(value) => patch({ organisation: value })} />
          <TextField label="Contact" value={form.contact} onChange={(value) => patch({ contact: value })} />
        </div>
        <div className="grid-3">
          <DateField label="Referral date" required value={form.date} onChange={(value) => patch({ date: value })} />
          <DateField label="Follow-up date" value={form.followUpDate ?? ''} onChange={(value) => patch({ followUpDate: value || null })} />
          <Field label="Status">
            <Select
              value={form.status}
              options={REFERRAL_STATUSES.map((option) => ({ value: option.value, label: option.label }))}
              onChange={(event) => patch({ status: event.target.value as ReferralStatus })}
            />
          </Field>
        </div>
        <Field label="Reason for referral" required>
          <TextArea rows={2} value={form.reason} onChange={(event) => patch({ reason: event.target.value })} />
        </Field>
        <Field label="Notes">
          <TextArea rows={2} value={form.notes} onChange={(event) => patch({ notes: event.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

export function ReferralsScreen(): JSX.Element {
  const { confirm } = useApp();
  const { run } = useAction();
  const lists = useListState();
  const [status, setStatus] = useState<ReferralStatus | ''>('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Referral | null>(null);

  const list = useApi(
    'referrals.list',
    {
      page: lists.state.page,
      pageSize: lists.state.pageSize,
      search: lists.state.search || undefined,
      status: status || undefined,
    },
    [lists.state.page, lists.state.pageSize, lists.state.search, status],
  );
  const statistics = useApi(
    'referrals.statistics',
    lists.state.preset
      ? (() => {
          const range = resolveDateRange(lists.state.preset as DateRangePreset);
          return { from: range.from, to: todayIso() };
        })()
      : { from: `${todayIso().slice(0, 4)}-01-01`, to: todayIso() },
    [lists.state.preset],
  );

  const rows = list.data?.items ?? [];

  const remove = async (referral: Referral) => {
    const answer = await confirm({
      title: `Delete the referral for ${referral.patientName}`,
      description: 'The referral is removed from the patient timeline as well.',
      confirmLabel: 'Delete referral',
      tone: 'danger',
      reason: true,
    });
    if (!answer.ok || !answer.reason) return;
    await run(() => bridge.invoke('referrals.delete', { id: referral.id, reason: answer.reason! }), { success: 'Referral deleted.' });
    list.reload();
    statistics.reload();
  };

  return (
    <Page
      title="Referrals"
      description="Specialist referrals and their follow-up"
      actions={
        <Button
          variant="primary"
          icon={<Send size={15} />}
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          New referral
        </Button>
      }
    >
      <div className="stat-grid">
        <Stat label="Referrals" value={String(statistics.data?.total ?? 0)} />
        {(statistics.data?.byStatus ?? []).map((entry) => (
          <Stat key={entry.label} label={REFERRAL_STATUS_LABELS[entry.label as ReferralStatus] ?? entry.label} value={String(entry.value)} />
        ))}
      </div>

      <div className="filters">
        <div className="row row--wrap" style={{ gap: 10 }}>
          <div style={{ minWidth: 260, flex: 1 }}>
            <SearchInput
              value={lists.state.search}
              placeholder="Search patient, doctor or reason…"
              onChange={(value) => lists.patch({ search: value })}
            />
          </div>
          <Select
            value={status}
            placeholder="All statuses"
            options={REFERRAL_STATUSES.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(event) => setStatus(event.target.value as ReferralStatus | '')}
          />
          <Select
            value={lists.state.preset}
            placeholder="All time"
            options={rangePresetOptions().filter((option) => option.value !== '')}
            onChange={(event) => lists.patch({ preset: event.target.value })}
          />
        </div>
      </div>

      <Card padded={false}>
        <DataTable
          columns={[
            { key: 'date', label: 'Date' },
            { key: 'patient', label: 'Patient' },
            { key: 'doctor', label: 'Referred to' },
            { key: 'specialty', label: 'Specialty' },
            { key: 'reason', label: 'Reason' },
            { key: 'followUp', label: 'Follow-up' },
            { key: 'status', label: 'Status' },
            { key: 'actions', label: '', align: 'right' },
          ]}
          rows={rows.map((referral) => ({
            date: fmtDate(referral.date),
            patient: (
              <div>
                <div>{referral.patientName}</div>
                <div className="small muted mono">{referral.patientCode}</div>
              </div>
            ),
            doctor: (
              <div>
                <div>{referral.doctorName || '—'}</div>
                <div className="small muted">{referral.organisation || referral.contact || '—'}</div>
              </div>
            ),
            specialty: referral.specialty || '—',
            reason: referral.reason,
            followUp: referral.followUpDate ? fmtDate(referral.followUpDate) : '—',
            status: <StatusBadge status={referral.status} label={REFERRAL_STATUS_LABELS[referral.status]} />,
            actions: (
              <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                <Button size="sm" variant="ghost" onClick={() => { setEditing(referral); setDialogOpen(true); }}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void remove(referral)}>
                  Delete
                </Button>
              </div>
            ),
          }))}
          loading={list.loading && !list.data}
          error={list.error}
          onRetry={list.reload}
          rowKey={(index) => String(rows[index]?.id ?? index)}
          empty={
            <Empty
              title="No referrals recorded"
              text="Send a patient summary to a specialist and keep the follow-up here."
              icon={<Share2 size={24} />}
              action={
                <Button variant="primary" onClick={() => { setEditing(null); setDialogOpen(true); }}>
                  New referral
                </Button>
              }
            />
          }
        />
        <PagedFooter page={lists.state.page} onPage={(page) => lists.patch({ page })} data={list.data} />
      </Card>

      {statistics.data && statistics.data.bySpecialty.length > 0 ? (
        <Card
          title="Referrals by specialty"
          subtitle={lists.state.preset ? `Period: ${lists.state.preset.replace(/_/g, ' ')}` : 'Current year'}
          padded={false}
        >
          <DataTable
            columns={[
              { key: 'specialty', label: 'Specialty' },
              { key: 'count', label: 'Referrals', align: 'right' },
            ]}
            rows={statistics.data.bySpecialty.map((entry) => ({ specialty: entry.label || 'Unspecified', count: String(entry.value) }))}
            rowKey={(index) => `specialty-${statistics.data?.bySpecialty[index]?.label ?? index}`}
            empty={<Empty title="Nothing yet" />}
          />
        </Card>
      ) : null}

      <ReferralDialog
        open={dialogOpen}
        referral={editing}
        onClose={() => setDialogOpen(false)}
        onSaved={() => {
          list.reload();
          statistics.reload();
        }}
      />
    </Page>
  );
}
