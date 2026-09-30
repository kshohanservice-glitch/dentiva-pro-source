/**
 * Role-aware dashboard.
 *
 * Every card comes from the core (`dashboard.get`), which already filters out
 * anything the signed-in role may not see — a receptionist never receives
 * financial figures, an assistant never receives revenue charts.
 */
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CalendarCheck, Clock, RefreshCw, ShieldCheck, Users } from 'lucide-react';
import { resolveScreenPath } from '@shared/api';
import { APPOINTMENT_STATUS_LABELS } from '@shared/constants';
import type { DashboardCard } from '@shared/types';
import { useAction, useApi } from '@renderer/state/store';
import { bridge } from '@renderer/lib/bridge';
import { fmtDate, fmtInstant, fmtMoney, fmtTime } from '@renderer/lib/format';
import { Badge, Banner, Button, Card, Empty, ErrorState, LoadingBlock, Page, Stat, StatusBadge } from '@renderer/components/ui';

export function DashboardScreen(): JSX.Element {
  const navigate = useNavigate();
  const { run } = useAction();
  const dashboard = useApi('dashboard.get', undefined);
  const data = dashboard.data;

  const toneOf = (card: DashboardCard): 'default' | 'accent' | 'success' | 'warning' | 'danger' => {
    if (card.tone === 'danger') return 'danger';
    if (card.tone === 'warning') return 'warning';
    if (card.tone === 'success') return 'success';
    if (card.tone === 'info') return 'accent';
    return 'default';
  };

  const checkIn = async (appointmentId: number) => {
    await run(() => bridge.invoke('appointments.setStatus', { id: appointmentId, status: 'arrived' }), {
      success: 'Patient checked in and added to the queue.',
      failure: 'The patient could not be checked in.',
    });
    dashboard.reload();
  };

  if (dashboard.loading && !data) {
    return (
      <Page title="Dashboard" description="Today at a glance">
        <LoadingBlock rows={6} />
      </Page>
    );
  }

  if (dashboard.error && !data) {
    return (
      <Page title="Dashboard">
        <ErrorState message={dashboard.error} onRetry={dashboard.reload} />
      </Page>
    );
  }
  if (!data)
    return (
      <Page title="Dashboard">
        <LoadingBlock />
      </Page>
    );

  const trendTotal = data.paymentTrend.reduce((sum, point) => sum + point.amountPaisa, 0);
  const trendPeak = Math.max(1, ...data.paymentTrend.map((point) => point.amountPaisa));

  return (
    <Page
      title="Dashboard"
      description={`Updated ${fmtInstant(data.generatedAt)}`}
      actions={
        <>
          <Button icon={<RefreshCw size={15} />} onClick={() => dashboard.reload()} loading={dashboard.loading}>
            Refresh
          </Button>
          <Button variant="primary" icon={<Users size={15} />} onClick={() => navigate(resolveScreenPath('patients'))}>
            Patients
          </Button>
        </>
      }
    >
      {data.backup.isDue ? (
        <Banner
          tone="warning"
          title="A backup is due."
          actions={
            <Button size="sm" onClick={() => navigate(resolveScreenPath('backup'))}>
              Open backup
            </Button>
          }
        >
          {data.backup.lastBackupAt
            ? `Last backup ${fmtInstant(data.backup.lastBackupAt)}. Automatic backups run every ${data.backup.intervalDays} day(s).`
            : `No backup has been taken yet. Automatic backups run every ${data.backup.intervalDays} day(s).`}
        </Banner>
      ) : null}

      <div className="stat-grid">
        {data.cards.map((card) => (
          <Stat
            key={card.key}
            label={card.label}
            value={card.value}
            hint={card.hint}
            tone={toneOf(card)}
            onClick={() => navigate(resolveScreenPath(card.screen))}
          />
        ))}
      </div>

      <div className="split">
        <Card
          title="Today's appointments"
          subtitle={`${data.todayAppointments.length} booked · ${data.noShowsToday} no-show(s)`}
          actions={
            <Button size="sm" onClick={() => navigate(resolveScreenPath('appointments'))}>
              Calendar
            </Button>
          }
        >
          {data.todayAppointments.length === 0 ? (
            <Empty
              title="Nothing booked for today"
              text="Walk-in patients can still be added to the queue."
              icon={<CalendarCheck size={24} />}
              action={
                <Button size="sm" onClick={() => navigate(resolveScreenPath('appointments'))}>
                  Book an appointment
                </Button>
              }
            />
          ) : (
            <div className="stack stack--sm">
              {data.todayAppointments.slice(0, 8).map((appointment) => (
                <div key={appointment.id} className="row row--between">
                  <div className="row" style={{ gap: 10 }}>
                    <span className="mono small">{fmtTime(appointment.startTime)}</span>
                    <button
                      type="button"
                      className="btn btn--link"
                      onClick={() => navigate(resolveScreenPath('patient', appointment.patientId))}
                    >
                      {appointment.patientName}
                    </button>
                    <span className="small muted">{appointment.dentistName || 'Unassigned'}</span>
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    <StatusBadge status={appointment.status} label={APPOINTMENT_STATUS_LABELS[appointment.status]} />
                    {['scheduled', 'confirmed'].includes(appointment.status) ? (
                      <Button size="sm" onClick={() => void checkIn(appointment.id)}>
                        Check in
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card
          title="Queue now"
          subtitle={data.queue.length > 0 ? `${data.queue.length} patient(s) waiting` : 'The queue is clear'}
          actions={
            <Button size="sm" onClick={() => navigate(resolveScreenPath('queue'))}>
              Open queue
            </Button>
          }
        >
          {data.queue.length === 0 ? (
            <Empty title="No one is waiting" text="Checked-in patients appear here in order." icon={<Clock size={24} />} />
          ) : (
            <div className="stack stack--sm">
              {data.queue.slice(0, 8).map((entry) => (
                <div key={entry.id} className="row row--between">
                  <div className="row" style={{ gap: 10 }}>
                    <Badge tone="accent">{entry.queueLabel}</Badge>
                    <span>{entry.patientName}</span>
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    {entry.waitingMinutes !== null ? <span className="small muted">{entry.waitingMinutes} min</span> : null}
                    <StatusBadge status={entry.status} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="split">
        <Card title="Follow-ups due" subtitle="Patients whose follow-up date has arrived or passed">
          {data.followUpsDue.length === 0 ? (
            <Empty title="No follow-ups due" text="Follow-up dates recorded on visits appear here." />
          ) : (
            <div className="stack stack--sm">
              {data.followUpsDue.slice(0, 8).map((followUp) => (
                <div key={`${followUp.patientId}-${followUp.followUpDate}`} className="row row--between">
                  <div>
                    <button
                      type="button"
                      className="btn btn--link"
                      onClick={() => navigate(resolveScreenPath('patient', followUp.patientId))}
                    >
                      {followUp.patientName}
                    </button>
                    <span className="small muted"> · {followUp.patientCode}</span>
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="small">{fmtDate(followUp.followUpDate)}</span>
                    {followUp.phone ? <span className="small muted">{followUp.phone}</span> : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card
          title="Inventory alerts"
          subtitle={[
            `${data.inventoryAlerts.lowStock} low`,
            `${data.inventoryAlerts.expiringSoon} expiring`,
            `${data.inventoryAlerts.expired} expired`,
          ].join(' · ')}
          actions={
            <Button size="sm" onClick={() => navigate(resolveScreenPath('inventory'))}>
              Open inventory
            </Button>
          }
        >
          {data.inventoryAlerts.items.length === 0 ? (
            <Empty title="Stock levels look healthy" icon={<ShieldCheck size={24} />} />
          ) : (
            <div className="stack stack--sm">
              {data.inventoryAlerts.items.slice(0, 8).map((item) => (
                <div key={item.id} className="row row--between">
                  <span>{item.name}</span>
                  <span className="small muted">
                    {item.code} · {item.unit}
                  </span>
                </div>
              ))}
            </div>
          )}
          {data.inventoryAlerts.expired > 0 ? (
            <Banner tone="danger" title="Expired stock on hand">
              <AlertTriangle size={14} /> {data.inventoryAlerts.expired} item(s) have passed their expiry date.
            </Banner>
          ) : null}
        </Card>
      </div>

      <div className="split">
        <Card title="Recent prescriptions" subtitle="Latest clinical documents">
          {data.recentPrescriptions.length === 0 ? (
            <Empty title="No prescriptions yet" />
          ) : (
            <div className="stack stack--sm">
              {data.recentPrescriptions.slice(0, 6).map((prescription) => (
                <div key={prescription.id} className="row row--between">
                  <div>
                    <span className="mono small">{prescription.number}</span> · {prescription.patientName}
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="small muted">{fmtDate(prescription.date)}</span>
                    {prescription.isVoid ? <Badge tone="danger">Void</Badge> : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Recent invoices" subtitle="Latest billing documents">
          {data.recentInvoices.length === 0 ? (
            <Empty title="No invoices yet" />
          ) : (
            <div className="stack stack--sm">
              {data.recentInvoices.slice(0, 6).map((invoice) => (
                <div key={invoice.id} className="row row--between">
                  <div>
                    <span className="mono small">{invoice.number}</span> · {invoice.patientName}
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="numerical small">{fmtMoney(invoice.totalPaisa)}</span>
                    <StatusBadge status={invoice.status} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {data.paymentTrend.length > 0 ? (
        <Card title="Collections" subtitle={`${fmtMoney(trendTotal)} received in the last ${data.paymentTrend.length} day(s)`}>
          <div className="row row--end" style={{ alignItems: 'flex-end', gap: 6, height: 120 }}>
            {data.paymentTrend.map((point) => (
              <div
                key={point.date}
                title={`${fmtDate(point.date)} · ${fmtMoney(point.amountPaisa)}`}
                style={{
                  flex: 1,
                  height: `${Math.max(4, Math.round((point.amountPaisa / trendPeak) * 100))}%`,
                  background: 'var(--accent)',
                  borderRadius: 4,
                  opacity: 0.85,
                }}
              />
            ))}
          </div>
        </Card>
      ) : null}
    </Page>
  );
}
