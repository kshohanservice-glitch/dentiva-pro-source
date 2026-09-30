/**
 * Appointment calendar: day, week, month and list views over the same data.
 *
 * Status changes go through the same guarded service the queue uses, so
 * checking a patient in from here creates exactly the same queue entry as
 * checking in from the queue screen.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Printer } from 'lucide-react';
import { resolveScreenPath } from '@shared/api';
import {
  ACTIVE_APPOINTMENT_STATUSES,
  APPOINTMENT_STATUSES,
  APPOINTMENT_STATUS_LABELS,
  CLOSED_APPOINTMENT_STATUSES,
  DEFAULT_APPOINTMENT_MINUTES,
} from '@shared/constants';
import { addDays, endOfMonth, endOfWeek, startOfMonth, startOfWeek, todayIso } from '@shared/dates';
import type { AppointmentStatus } from '@shared/constants';
import type { Appointment, AppointmentInput, Dentist, PatientSummary } from '@shared/types';
import { useAction, useApi, useApp } from '@renderer/state/store';
import { bridge } from '@renderer/lib/bridge';
import { fmtDate, fmtTime } from '@renderer/lib/format';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorState,
  Field,
  LoadingBlock,
  Modal,
  Page,
  Segmented,
  Select,
  Stat,
  StatusBadge,
  TextArea,
} from '@renderer/components/ui';
import { DataTable, DateField, DentistSelect, PatientPicker, TextField, rangePresetOptions } from '@renderer/components/forms';

type ViewMode = 'day' | 'week' | 'month' | 'list';

const EMPTY: AppointmentInput = {
  patientId: 0,
  dentistId: null,
  date: todayIso(),
  startTime: '10:00',
  endTime: '10:30',
  reason: '',
  notes: '',
  status: 'scheduled',
  reminderNote: '',
};

function addMinutesToTime(time: string, minutes: number): string {
  const [hours, mins] = time.split(':').map(Number);
  const total = (hours ?? 0) * 60 + (mins ?? 0) + minutes;
  const normalised = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalised / 60)).padStart(2, '0')}:${String(normalised % 60).padStart(2, '0')}`;
}

function AppointmentDialog({
  open,
  appointmentId,
  defaultDate,
  defaultPatientId,
  onClose,
  onSaved,
}: {
  open: boolean;
  appointmentId: number | null;
  defaultDate: string;
  defaultPatientId: number | null;
  onClose(): void;
  onSaved(): void;
}): JSX.Element | null {
  const { toast } = useApp();
  const { run, busy } = useAction();
  const [form, setForm] = useState<AppointmentInput>({ ...EMPTY, date: defaultDate });
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const existing = useApi('appointments.get', appointmentId ? { id: appointmentId } : null);
  const patients = useApi('patients.quickSearch', defaultPatientId ? { query: String(defaultPatientId), limit: 5 } : null);
  const settings = useApi('settings.get', open ? undefined : null);
  const slot = settings.data?.appointmentSlotMinutes ?? DEFAULT_APPOINTMENT_MINUTES;

  useEffect(() => {
    if (!open) return;
    if (!appointmentId) {
      setForm({ ...EMPTY, date: defaultDate });
      setPatient(null);
      return;
    }
    if (existing.data) setForm({ ...existing.data, reminderNote: existing.data.reminderNote });
  }, [defaultDate, existing.data, open, appointmentId]);

  // Pre-select the patient when the screen was opened with ?patient=<id>.
  useEffect(() => {
    const candidates = patients.data ?? [];
    const match = defaultPatientId ? candidates.find((candidate) => candidate.id === defaultPatientId) : undefined;
    if (match && !patient) setPatient(match);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patients.data, defaultPatientId]);

  const patch = (value: Partial<AppointmentInput>) => setForm((current) => ({ ...current, ...value }));
  const patientId = patient?.id ?? form.patientId;

  const save = async () => {
    if (!patientId) {
      toast('warning', 'Choose a patient first');
      return;
    }
    const payload: AppointmentInput = { ...form, patientId };
    const saved = await run(
      () =>
        appointmentId
          ? bridge.invoke('appointments.update', { id: appointmentId, input: payload }).then(() => true)
          : bridge.invoke('appointments.create', { input: payload }).then(() => true),
      { success: appointmentId ? 'Appointment updated.' : 'Appointment booked.' },
    );
    if (saved) {
      onSaved();
      onClose();
    }
  };

  if (!open) return null;

  const availability = (
    <AvailabilityHint
      dentistId={form.dentistId}
      date={form.date}
      excludeId={appointmentId}
      onPick={(start) => patch({ startTime: start, endTime: addMinutesToTime(start, slot) })}
    />
  );

  return (
    <Modal
      open
      title={appointmentId ? 'Edit appointment' : 'Book an appointment'}
      description="Appointments in the same slot are rejected by the database, not just by this form."
      onClose={onClose}
      footer={
        <div className="row row--end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!patient && !form.patientId} onClick={() => void save()}>
            {appointmentId ? 'Save changes' : 'Book appointment'}
          </Button>
        </div>
      }
    >
      <div className="stack">
        <PatientPicker value={patient} onChange={setPatient} autoFocus={!appointmentId && !defaultPatientId} />
        <div className="grid-3">
          <DateField label="Date" required value={form.date} onChange={(value) => patch({ date: value })} />
          <Field label="Start time" required>
            <input
              className="input"
              type="time"
              value={form.startTime}
              onChange={(event) => patch({ startTime: event.target.value, endTime: addMinutesToTime(event.target.value, slot) })}
            />
          </Field>
          <Field label="End time" required hint={`${slot}-minute slots`}>
            <input className="input" type="time" value={form.endTime} onChange={(event) => patch({ endTime: event.target.value })} />
          </Field>
        </div>
        {availability}
        <DentistSelect value={form.dentistId} onChange={(value) => patch({ dentistId: value })} />
        <TextField
          label="Reason"
          value={form.reason}
          onChange={(value) => patch({ reason: value })}
          placeholder="Scaling, root canal review…"
        />
        <div className="grid-2">
          <Field label="Status">
            <Select
              value={form.status}
              options={APPOINTMENT_STATUSES.map((option) => ({ value: option.value, label: option.label }))}
              onChange={(event) => patch({ status: event.target.value as AppointmentStatus })}
            />
          </Field>
          <TextField label="Reminder note" value={form.reminderNote} onChange={(value) => patch({ reminderNote: value })} />
        </div>
        <Field label="Notes">
          <TextArea value={form.notes} rows={2} onChange={(event) => patch({ notes: event.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

function AvailabilityHint({
  dentistId,
  date,
  excludeId,
  onPick,
}: {
  dentistId: number | null;
  date: string;
  excludeId: number | null;
  onPick(start: string): void;
}): JSX.Element | null {
  const availability = useApi('appointments.availability', dentistId && date ? { dentistId, date, excludeId } : null);
  const items = availability.data ?? [];
  if (!dentistId) return null;
  return (
    <div className="card">
      <div className="card__body">
        <div className="field__label">{items.length === 0 ? 'The whole day is free' : `Booked on ${fmtDate(date)}`}</div>
        {items.length > 0 ? (
          <div className="chip-row">
            {items.slice(0, 12).map((slot) => (
              <Badge key={slot.appointmentId} tone="info">
                {fmtTime(slot.startTime)} · {slot.patientName}
              </Badge>
            ))}
          </div>
        ) : (
          <div className="small muted">Suggested slots:</div>
        )}
        <div className="chip-row" style={{ marginTop: 6 }}>
          {['09:00', '10:00', '11:00', '12:00', '16:00', '17:00', '18:00'].map((time) => (
            <Button key={time} size="sm" variant="ghost" onClick={() => onPick(time)}>
              {fmtTime(time)}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function AppointmentsScreen(): JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const patientParam = Number(params.get('patient'));
  const { run } = useAction();
  const { toast } = useApp();
  const today = todayIso();
  const [view, setView] = useState<ViewMode>('day');
  const [anchor, setAnchor] = useState(today);
  const [dentistId, setDentistId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [preset, setPreset] = useState('');
  const [dialogOpen, setDialogOpen] = useState(Boolean(patientParam));
  const [editing, setEditing] = useState<number | null>(null);

  const dentists = useApi('dentists.list', { includeInactive: false });
  const range = useMemo(() => {
    if (view === 'day') return { from: anchor, to: anchor };
    if (view === 'week') return { from: startOfWeek(anchor), to: endOfWeek(anchor) };
    if (view === 'month') return { from: startOfMonth(anchor), to: endOfMonth(anchor) };
    return { from: undefined, to: undefined };
  }, [anchor, view]);

  const list = useApi(
    'appointments.list',
    view === 'list'
      ? {
          view: 'list',
          pageSize: 100,
          dentistId,
          status: statusFilter ? [statusFilter as AppointmentStatus] : undefined,
          preset: preset || undefined,
        }
      : { view, date: anchor, dentistId, pageSize: 200 },
    [view, anchor, dentistId, statusFilter, preset],
  );
  const appointments = useMemo(() => list.data?.items ?? [], [list.data]);

  const grouped = useMemo(() => {
    const map = new Map<string, Appointment[]>();
    for (const appointment of appointments) {
      const bucket = map.get(appointment.date) ?? [];
      bucket.push(appointment);
      map.set(appointment.date, bucket);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [appointments]);

  const stats = useMemo(() => {
    const counts = { total: appointments.length, completed: 0, cancelled: 0, noShow: 0 };
    for (const appointment of appointments) {
      if (appointment.status === 'completed') counts.completed += 1;
      if (appointment.status === 'cancelled') counts.cancelled += 1;
      if (appointment.status === 'no_show') counts.noShow += 1;
    }
    return counts;
  }, [appointments]);

  const shift = (direction: -1 | 1) => {
    if (view === 'day') setAnchor((current) => addDays(current, direction));
    else if (view === 'week') setAnchor((current) => addDays(current, direction * 7));
    else setAnchor((current) => addDays(direction === 1 ? endOfMonth(current) : startOfMonth(current), direction));
  };

  const setStatus = async (appointment: Appointment, status: AppointmentStatus) => {
    if (status === 'cancelled' || status === 'no_show') {
      const reason = window.prompt(`Reason for marking this appointment as ${APPOINTMENT_STATUS_LABELS[status].toLowerCase()}:`);
      if (!reason || reason.trim().length < 3) return;
      const done = await run(() => bridge.invoke('appointments.setStatus', { id: appointment.id, status, note: reason }), {
        success: 'Appointment updated.',
      });
      if (done !== null) list.reload();
      return;
    }
    const done = await run(() => bridge.invoke('appointments.setStatus', { id: appointment.id, status }), {
      success: status === 'arrived' ? 'Checked in and added to the queue.' : 'Appointment updated.',
    });
    if (done !== null) list.reload();
  };

  const remove = async (appointment: Appointment) => {
    const reason = window.prompt('Why is this appointment being deleted?');
    if (!reason || reason.trim().length < 3) return;
    const done = await run(() => bridge.invoke('appointments.delete', { id: appointment.id, reason }), {
      success: 'Appointment deleted.',
    });
    if (done !== null) list.reload();
  };

  const bookVisit = async (appointment: Appointment) => {
    const result = await run(
      () =>
        bridge.invoke('visits.create', {
          input: {
            patientId: appointment.patientId,
            dentistId: appointment.dentistId,
            visitDate: appointment.date,
            visitTime: appointment.startTime,
            chiefComplaint: appointment.reason,
            history: '',
            examination: '',
            diagnosis: '',
            ccOptions: [],
            oeOptions: [],
            reOptions: [],
            adviceOptions: [],
            advice: '',
            notes: appointment.notes,
            followUpDate: null,
            treatments: [],
            dentalFindings: [],
            prescriptionId: null,
          },
        }),
      { success: 'Visit started from this appointment.', failure: 'The visit could not be started.' },
    );
    if (result) {
      toast('success', 'Visit created', 'Continue in the visits screen.');
      void navigate(resolveScreenPath('visits'));
    }
  };

  return (
    <Page
      title="Appointments"
      description={`${stats.total} appointment(s) · ${stats.completed} completed · ${stats.cancelled} cancelled · ${stats.noShow} no-show`}
      actions={
        <>
          <Button
            icon={<Printer size={15} />}
            onClick={() =>
              void run(() => bridge.invoke('print.render', { kind: 'report', id: 0, output: 'pdf' }), {
                failure: 'The day list could not be printed.',
              })
            }
          >
            Day list PDF
          </Button>
          <Button
            variant="primary"
            icon={<Plus size={15} />}
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            Book appointment
          </Button>
        </>
      }
    >
      <div className="filters">
        <div className="row row--wrap" style={{ gap: 10 }}>
          <Segmented
            options={[
              { value: 'day', label: 'Day' },
              { value: 'week', label: 'Week' },
              { value: 'month', label: 'Month' },
              { value: 'list', label: 'List' },
            ]}
            value={view}
            onChange={(value) => setView(value as ViewMode)}
          />
          {view !== 'list' ? (
            <div className="row" style={{ gap: 6 }}>
              <Button size="sm" onClick={() => shift(-1)} aria-label="Previous">
                <ChevronLeft size={15} />
              </Button>
              <Button size="sm" onClick={() => setAnchor(today)}>
                Today
              </Button>
              <Button size="sm" onClick={() => shift(1)} aria-label="Next">
                <ChevronRight size={15} />
              </Button>
              <span className="small muted">{view === 'day' ? fmtDate(anchor) : `${fmtDate(range.from)} – ${fmtDate(range.to)}`}</span>
            </div>
          ) : (
            <Select
              value={preset}
              placeholder="All time"
              options={rangePresetOptions().filter((option) => option.value !== '')}
              onChange={(event) => setPreset(event.target.value)}
            />
          )}
          <Select
            value={dentistId === null ? '' : String(dentistId)}
            placeholder="All dentists"
            options={(dentists.data ?? []).map((dentist: Dentist) => ({ value: String(dentist.id), label: dentist.name }))}
            onChange={(event) => setDentistId(event.target.value ? Number(event.target.value) : null)}
          />
          <Select
            value={statusFilter}
            placeholder="Any status"
            options={APPOINTMENT_STATUSES.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(event) => setStatusFilter(event.target.value)}
          />
        </div>
      </div>

      <div className="stat-grid">
        <Stat label="Scheduled" value={String(appointments.filter((a) => a.status === 'scheduled').length)} />
        <Stat label="Confirmed" value={String(appointments.filter((a) => a.status === 'confirmed').length)} />
        <Stat
          label="In clinic"
          value={String(appointments.filter((a) => ['arrived', 'in_queue', 'in_treatment'].includes(a.status)).length)}
          tone="accent"
        />
        <Stat label="Completed" value={String(stats.completed)} tone="success" />
      </div>

      {list.loading && !list.data ? (
        <LoadingBlock rows={6} />
      ) : list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : appointments.length === 0 ? (
        <Empty
          title="No appointments in this view"
          text="Choose another day, or book a new appointment."
          icon={<CalendarDays size={24} />}
          action={
            <Button
              variant="primary"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              Book appointment
            </Button>
          }
        />
      ) : (
        <div className="stack">
          {grouped.map(([date, items]) => (
            <Card key={date} title={fmtDate(date)} subtitle={`${items.length} appointment(s)`} padded={false}>
              <DataTable
                columns={[
                  { key: 'time', label: 'Time', width: '130px' },
                  { key: 'patient', label: 'Patient' },
                  { key: 'dentist', label: 'Dentist' },
                  { key: 'reason', label: 'Reason' },
                  { key: 'status', label: 'Status' },
                  { key: 'actions', label: '', align: 'right' },
                ]}
                rows={items.map((appointment) => ({
                  time: `${fmtTime(appointment.startTime)} – ${fmtTime(appointment.endTime)}`,
                  patient: (
                    <button
                      type="button"
                      className="btn btn--link"
                      onClick={() => navigate(resolveScreenPath('patient', appointment.patientId))}
                    >
                      {appointment.patientName}
                      <span className="small muted"> · {appointment.patientCode}</span>
                    </button>
                  ),
                  dentist: appointment.dentistName || 'Unassigned',
                  reason: appointment.reason || '—',
                  status: <StatusBadge status={appointment.status} label={APPOINTMENT_STATUS_LABELS[appointment.status]} />,
                  actions: (
                    <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      {ACTIVE_APPOINTMENT_STATUSES.includes(appointment.status) ? (
                        <>
                          {['scheduled', 'confirmed'].includes(appointment.status) ? (
                            <Button size="sm" onClick={() => void setStatus(appointment, 'arrived')}>
                              Check in
                            </Button>
                          ) : null}
                          {['arrived', 'in_queue'].includes(appointment.status) ? (
                            <Button size="sm" onClick={() => void bookVisit(appointment)}>
                              Start visit
                            </Button>
                          ) : null}
                          <Button size="sm" variant="ghost" onClick={() => void setStatus(appointment, 'completed')}>
                            Complete
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => void setStatus(appointment, 'no_show')}>
                            No-show
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => void setStatus(appointment, 'cancelled')}>
                            Cancel
                          </Button>
                        </>
                      ) : CLOSED_APPOINTMENT_STATUSES.includes(appointment.status) ? (
                        <Badge>Closed</Badge>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditing(appointment.id);
                          setDialogOpen(true);
                        }}
                      >
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void remove(appointment)}>
                        Delete
                      </Button>
                    </div>
                  ),
                }))}
                rowKey={(index) => String(items[index]?.id ?? index)}
                empty={<Empty title="Nothing booked" />}
              />
            </Card>
          ))}
        </div>
      )}

      <AppointmentDialog
        open={dialogOpen}
        appointmentId={editing}
        defaultDate={view === 'day' ? anchor : today}
        defaultPatientId={Number.isFinite(patientParam) && patientParam > 0 ? patientParam : null}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSaved={() => list.reload()}
      />
    </Page>
  );
}
