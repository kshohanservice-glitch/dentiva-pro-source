/**
 * Queue management for today.
 *
 * The queue is the operational heart of a Bangladeshi dental clinic: patients
 * arrive without appointments, so a walk-in has to be added in two clicks and
 * moved up or down as reality changes.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowUp, Clock, Plus, UserMinus } from 'lucide-react';
import { resolveScreenPath } from '@shared/api';
import { QUEUE_PRIORITIES, QUEUE_STATUS_LABELS, QUEUE_STATUSES } from '@shared/constants';
import type { QueuePriority, QueueStatus } from '@shared/constants';
import { todayIso } from '@shared/dates';
import type { PatientSummary, QueueEntry } from '@shared/types';
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
  Select,
  Stat,
  StatusBadge,
  TextArea,
} from '@renderer/components/ui';
import { DentistSelect, PatientPicker } from '@renderer/components/forms';

export function QueueScreen(): JSX.Element {
  const navigate = useNavigate();
  const { toast } = useApp();
  const { run, busy } = useAction();
  const [date, setDate] = useState(todayIso());
  const [includeClosed, setIncludeClosed] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [dentistId, setDentistId] = useState<number | null>(null);
  const [priority, setPriority] = useState<QueuePriority>('normal');
  const [notes, setNotes] = useState('');

  const queue = useApi('queue.list', { date, includeClosed }, [date, includeClosed]);
  const stats = useApi('queue.statistics', { date }, [date]);
  const items = queue.data ?? [];

  const addWalkIn = async () => {
    if (!patient) {
      toast('warning', 'Choose a patient first');
      return;
    }
    const result = await run(
      () =>
        bridge.invoke('queue.add', {
          input: { patientId: patient.id, dentistId, appointmentId: null, priority, notes },
        }),
      { success: 'Patient added to the queue.', failure: 'The patient could not be added to the queue.' },
    );
    if (result) {
      setAddOpen(false);
      setPatient(null);
      setNotes('');
      setPriority('normal');
      queue.reload();
      stats.reload();
    }
  };

  const setStatus = async (entry: QueueEntry, status: QueueStatus) => {
    const done = await run(
      () =>
        bridge.invoke('queue.setStatus', {
          id: entry.id,
          status,
          note: status === 'cancelled' ? 'Removed by staff' : undefined,
        }),
      { success: `Queue ${entry.queueLabel} → ${QUEUE_STATUS_LABELS[status]}.` },
    );
    if (done !== undefined) {
      queue.reload();
      stats.reload();
    }
  };

  const move = async (entry: QueueEntry, direction: 'up' | 'down') => {
    const done = await run(() => bridge.invoke('queue.move', { id: entry.id, direction }));
    if (done) queue.reload();
  };

  const remove = async (entry: QueueEntry) => {
    const reason = window.prompt(`Why is ${entry.patientName} being removed from the queue?`);
    if (!reason || reason.trim().length < 3) return;
    const done = await run(() => bridge.invoke('queue.remove', { id: entry.id, reason }), {
      success: 'Removed from the queue.',
    });
    if (done !== null) {
      queue.reload();
      stats.reload();
    }
  };

  const startVisit = async (entry: QueueEntry) => {
    const visit = await run(
      () =>
        bridge.invoke('visits.create', {
          input: {
            patientId: entry.patientId,
            dentistId: entry.dentistId,
            visitDate: date,
            visitTime: entry.arrivalTime,
            chiefComplaint: '',
            history: '',
            examination: '',
            diagnosis: '',
            ccOptions: [],
            oeOptions: [],
            reOptions: [],
            adviceOptions: [],
            advice: '',
            notes: entry.notes,
            followUpDate: null,
            treatments: [],
            dentalFindings: [],
            prescriptionId: null,
          },
        }),
      { success: 'Visit started.', failure: 'The visit could not be started.' },
    );
    if (visit) {
      queue.reload();
      navigate(resolveScreenPath('visits'));
    }
  };

  return (
    <Page
      title="Queue"
      description={fmtDate(date)}
      actions={
        <>
          <input
            className="input"
            type="date"
            value={date}
            style={{ width: 160 }}
            onChange={(event) => setDate(event.target.value)}
          />
          <Button
            variant={includeClosed ? 'default' : 'ghost'}
            onClick={() => setIncludeClosed((current) => !current)}
          >
            {includeClosed ? 'Showing closed' : 'Open only'}
          </Button>
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => setAddOpen(true)}>
            Add walk-in
          </Button>
        </>
      }
    >
      <div className="stat-grid">
        <Stat label="Waiting" value={String(stats.data?.waiting ?? 0)} tone="accent" icon={<Clock size={16} />} />
        <Stat label="Called" value={String(stats.data?.called ?? 0)} />
        <Stat label="In consultation" value={String(stats.data?.inConsultation ?? 0)} tone="warning" />
        <Stat
          label="Average wait"
          value={stats.data?.averageWaitMinutes === null || stats.data?.averageWaitMinutes === undefined ? '—' : `${stats.data.averageWaitMinutes} min`}
          hint={stats.data?.longestWaitMinutes ? `Longest ${stats.data.longestWaitMinutes} min` : undefined}
        />
      </div>

      {queue.loading && !queue.data ? (
        <LoadingBlock rows={6} />
      ) : queue.error ? (
        <ErrorState message={queue.error} onRetry={queue.reload} />
      ) : items.length === 0 ? (
        <Empty
          title="The queue is empty"
          text="Check in an appointment or add a walk-in patient to start the day."
          action={
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              Add walk-in
            </Button>
          }
        />
      ) : (
        <div className="stack">
          {items.map((entry, index) => (
            <Card key={entry.id} padded={false}>
              <div className="row row--between" style={{ padding: 'var(--space-4)' }}>
                <div className="row" style={{ gap: 14 }}>
                  <Badge tone={entry.status === 'waiting' ? 'accent' : entry.status === 'in_consultation' ? 'warning' : 'default'}>
                    {entry.queueLabel}
                  </Badge>
                  <div>
                    <button
                      type="button"
                      className="btn btn--link"
                      onClick={() => navigate(resolveScreenPath('patient', entry.patientId))}
                    >
                      {entry.patientName}
                    </button>
                    <div className="small muted">
                      {entry.patientCode}
                      {entry.patientPhone ? ` · ${entry.patientPhone}` : ''}
                      {entry.dentistName ? ` · ${entry.dentistName}` : ''}
                    </div>
                  </div>
                  {entry.priority !== 'normal' ? <Badge tone="danger">{entry.priority}</Badge> : null}
                  <StatusBadge status={entry.status} label={QUEUE_STATUS_LABELS[entry.status]} />
                </div>

                <div className="row" style={{ gap: 6 }}>
                  <span className="small muted">
                    Arrived {fmtTime(entry.arrivalTime)}
                    {entry.waitingMinutes !== null ? ` · waiting ${entry.waitingMinutes} min` : ''}
                  </span>
                  <Button size="sm" variant="ghost" disabled={index === 0} aria-label="Move up" onClick={() => void move(entry, 'up')}>
                    <ArrowUp size={14} />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={index === items.length - 1}
                    aria-label="Move down"
                    onClick={() => void move(entry, 'down')}
                  >
                    <ArrowDown size={14} />
                  </Button>

                  {entry.status === 'waiting' ? (
                    <Button size="sm" onClick={() => void setStatus(entry, 'called')}>
                      Call
                    </Button>
                  ) : null}
                  {entry.status === 'called' ? (
                    <Button size="sm" onClick={() => void setStatus(entry, 'in_consultation')}>
                      Start
                    </Button>
                  ) : null}
                  {entry.status === 'in_consultation' ? (
                    <>
                      <Button size="sm" onClick={() => void startVisit(entry)}>
                        Record visit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void setStatus(entry, 'completed')}>
                        Done
                      </Button>
                    </>
                  ) : null}
                  {['waiting', 'called'].includes(entry.status) ? (
                    <Button size="sm" variant="ghost" icon={<UserMinus size={14} />} onClick={() => void remove(entry)}>
                      Remove
                    </Button>
                  ) : null}
                </div>
              </div>
              {entry.notes ? <div className="small muted" style={{ padding: '0 var(--space-4) var(--space-3)' }}>{entry.notes}</div> : null}
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={addOpen}
        title="Add a walk-in patient"
        description="A queue number is issued automatically for today."
        onClose={() => setAddOpen(false)}
        footer={
          <div className="row row--end">
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={!patient} onClick={() => void addWalkIn()}>
              Add to queue
            </Button>
          </div>
        }
      >
        <div className="stack">
          <PatientPicker value={patient} onChange={setPatient} autoFocus />
          <DentistSelect value={dentistId} onChange={setDentistId} />
          <Field label="Priority">
            <Select
              value={priority}
              options={QUEUE_PRIORITIES.map((option) => ({ value: option.value, label: option.label }))}
              onChange={(event) => setPriority(event.target.value as QueuePriority)}
            />
          </Field>
          <Field label="Notes" hint="Pain level, referral, anything the dentist should know">
            <TextArea value={notes} rows={2} onChange={(event) => setNotes(event.target.value)} />
          </Field>
          <div className="small muted">
            Statuses available: {QUEUE_STATUSES.map((option) => option.label).join(' → ')}
          </div>
        </div>
      </Modal>
    </Page>
  );
}
