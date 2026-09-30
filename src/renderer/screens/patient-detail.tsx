/**
 * Patient profile — the clinical home page for one person.
 *
 * Everything the clinic knows about a patient is reachable from here, in tabs,
 * with the financial sections hidden from roles that may not see money.
 */
import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, CalendarPlus, FileText, History, Paperclip, Phone, Pill, Receipt, Stethoscope, Trash2, Upload } from 'lucide-react';
import { resolveScreenPath } from '@shared/api';
import { ATTACHMENT_CATEGORIES, GENDER_LABELS, PATIENT_STATUS_LABELS } from '@shared/constants';
import type { AttachmentCategory } from '@shared/constants';
import type { Attachment, InvoiceSummary, PatientDetail, PrescriptionSummary, VisitSummary } from '@shared/types';
import { useAction, useApi, useApp } from '@renderer/state/store';
import { bridge, resolveSourcePath } from '@renderer/lib/bridge';
import { fmtDate, fmtDateTime, fmtMoney } from '@renderer/lib/format';
import {
  Badge,
  Banner,
  Button,
  Card,
  Chip,
  DefinitionList,
  Empty,
  ErrorState,
  LoadingBlock,
  Modal,
  Page,
  Select,
  StatusBadge,
  Tabs,
  Timeline,
} from '@renderer/components/ui';
import { DataTable } from '@renderer/components/forms';
import { DentalChartView } from '@renderer/components/dental-chart';
import { PatientForm } from './patients';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'timeline', label: 'Timeline' },
  { key: 'chart', label: 'Dental chart' },
  { key: 'visits', label: 'Visits' },
  { key: 'prescriptions', label: 'Prescriptions' },
  { key: 'plans', label: 'Treatment plans' },
  { key: 'billing', label: 'Billing' },
  { key: 'files', label: 'Files' },
  { key: 'referrals', label: 'Referrals' },
];

export function PatientDetailScreen(): JSX.Element {
  const params = useParams();
  const patientId = Number(params.id);
  const navigate = useNavigate();
  const { session, toast } = useApp();
  const { run, busy } = useAction();
  const [tab, setTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const patient = useApi('patients.get', Number.isFinite(patientId) ? { id: patientId } : null);
  const detail = patient.data;
  const can = (permission: string) => {
    if (!session) return false;
    if (session.isOwner) return true;
    return session.permissions.some(
      (grant) => grant === '*' || grant === permission || (grant.endsWith('.*') && permission.startsWith(grant.slice(0, -1))),
    );
  };

  if (!Number.isFinite(patientId)) {
    return (
      <Page title="Patient">
        <Banner tone="danger" title="That patient link is not valid." />
      </Page>
    );
  }

  if (patient.loading && !detail) {
    return (
      <Page title="Patient">
        <LoadingBlock rows={6} />
      </Page>
    );
  }
  if (patient.error && !detail) {
    return (
      <Page title="Patient">
        <ErrorState message={patient.error} onRetry={patient.reload} />
      </Page>
    );
  }
  if (!detail)
    return (
      <Page title="Patient">
        <LoadingBlock />
      </Page>
    );

  return (
    <Page
      title={detail.name}
      description={
        <span className="row" style={{ gap: 8 }}>
          <span className="mono">{detail.code}</span>
          <StatusBadge status={detail.status} label={PATIENT_STATUS_LABELS[detail.status]} />
          {detail.hasMedicalAlerts ? (
            <Badge tone="danger">
              <AlertTriangle size={12} /> Medical alert
            </Badge>
          ) : null}
          {detail.deletedAt ? <Badge tone="danger">Deleted</Badge> : null}
        </span>
      }
      actions={
        <>
          <Button icon={<Phone size={15} />} onClick={() => void navigator.clipboard?.writeText(detail.phone)} title="Copy phone number">
            {detail.phone || 'No phone'}
          </Button>
          <Button icon={<CalendarPlus size={15} />} onClick={() => navigate(`${resolveScreenPath('appointments')}?patient=${detail.id}`)}>
            Book
          </Button>
          <Button
            variant="primary"
            icon={<Stethoscope size={15} />}
            onClick={() => navigate(`${resolveScreenPath('visits')}?patient=${detail.id}`)}
          >
            New visit
          </Button>
          <Button variant="ghost" onClick={() => setEditing(true)}>
            Edit
          </Button>
          {detail.deletedAt && can('patient.delete') ? (
            <Button
              onClick={() =>
                void run(() => bridge.invoke('patients.restore', { id: detail.id }), { success: 'Patient restored.' }).then(() =>
                  patient.reload(),
                )
              }
            >
              Restore
            </Button>
          ) : null}
          {!detail.deletedAt && can('patient.delete') ? (
            <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setDeleteOpen(true)}>
              Delete
            </Button>
          ) : null}
        </>
      }
    >
      {detail.allergies ? (
        <Banner tone="danger" title="Allergies">
          {detail.allergies}
        </Banner>
      ) : null}

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'overview' ? <OverviewTab detail={detail} canSeeMoney={can('invoice.view')} /> : null}
      {tab === 'timeline' ? <TimelineTab patientId={detail.id} /> : null}
      {tab === 'chart' ? <DentalChartView patientId={detail.id} canEdit={can('chart.edit')} /> : null}
      {tab === 'visits' ? <VisitsTab patientId={detail.id} /> : null}
      {tab === 'prescriptions' ? <PrescriptionsTab patientId={detail.id} /> : null}
      {tab === 'plans' ? <PlansTab patientId={detail.id} /> : null}
      {tab === 'billing' ? <BillingTab patientId={detail.id} canSeeMoney={can('invoice.view')} /> : null}
      {tab === 'files' ? <FilesTab patientId={detail.id} canManage={can('patient.attachment.manage')} /> : null}
      {tab === 'referrals' ? <ReferralsTab patientId={detail.id} /> : null}

      <PatientForm
        open={editing}
        patientId={detail.id}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          patient.reload();
        }}
      />

      <Modal
        open={deleteOpen}
        width="narrow"
        title="Delete this patient"
        description={
          'Patients with clinical or financial history are archived, never destroyed. ' +
          'Existing visits, prescriptions and invoices stay readable.'
        }
        onClose={() => setDeleteOpen(false)}
        footer={
          <div className="row row--end">
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() =>
                void run(
                  () =>
                    bridge.invoke('patients.delete', {
                      id: detail.id,
                      reason: `Removed from the register by ${session?.fullName ?? 'a user'}`,
                      confirmText: detail.code,
                    }),
                  { success: 'Patient removed from the register.' },
                ).then(() => {
                  setDeleteOpen(false);
                  toast('info', 'Patient removed', 'The record can be restored from the patient list filter “include deleted”.');
                  patient.reload();
                })
              }
            >
              Delete patient
            </Button>
          </div>
        }
      >
        <div className="small muted">
          Future appointments and open queue entries for this patient will be cancelled. The action is recorded in the audit log.
        </div>
      </Modal>
    </Page>
  );
}

function OverviewTab({ detail, canSeeMoney }: { detail: PatientDetail; canSeeMoney: boolean }): JSX.Element {
  const financial = useApi('patients.financialSummary', canSeeMoney ? { id: detail.id } : null);
  return (
    <div className="detail-layout">
      <div className="stack">
        <Card title="Patient details">
          <DefinitionList
            items={[
              { label: 'Full name', value: detail.name },
              { label: 'Patient code', value: <span className="mono">{detail.code}</span> },
              { label: 'Age', value: detail.ageText || '—' },
              { label: 'Date of birth', value: detail.dob ? fmtDate(detail.dob) : 'Not recorded' },
              { label: 'Gender', value: GENDER_LABELS[detail.gender] },
              { label: 'Blood group', value: detail.bloodGroup === 'unknown' ? 'Unknown' : detail.bloodGroup },
              { label: 'Mobile', value: detail.phone },
              { label: 'Alternate phone', value: detail.alternatePhone },
              { label: 'Email', value: detail.email },
              { label: 'Address', value: [detail.address, detail.city].filter(Boolean).join(', ') },
              { label: 'Emergency contact', value: [detail.emergencyContactName, detail.emergencyPhone].filter(Boolean).join(' · ') },
              { label: 'Referred by', value: detail.referredBy },
              { label: 'Registered', value: fmtDate(detail.registeredAt) },
              { label: 'Last visit', value: detail.lastVisitDate ? fmtDate(detail.lastVisitDate) : 'Never' },
            ]}
          />
        </Card>

        <Card title="Clinical background">
          <DefinitionList
            items={[
              { label: 'Chief complaint', value: detail.chiefComplaint },
              { label: 'Previous problems', value: detail.previousProblems },
              { label: 'Medical notes', value: detail.medicalNotes },
              { label: 'Allergies', value: detail.allergies || 'None recorded' },
              { label: 'Notes', value: detail.notes },
            ]}
          />
        </Card>
      </div>

      <aside className="detail-aside stack">
        <Card title="At a glance">
          <DefinitionList
            items={[
              { label: 'Visits', value: String(detail.visitCount) },
              { label: 'Open plans', value: String(detail.openTreatmentPlanCount) },
              { label: 'Next appointment', value: detail.lastAppointmentDate ? fmtDate(detail.lastAppointmentDate) : '—' },
              {
                label: 'Outstanding',
                value: detail.outstandingPaisa === null ? '—' : fmtMoney(detail.outstandingPaisa),
              },
            ]}
          />
        </Card>

        {canSeeMoney ? (
          <Card title="Financial summary">
            {financial.loading ? (
              <LoadingBlock rows={3} />
            ) : !financial.data ? (
              <Empty title="No billing history" />
            ) : (
              <>
                <DefinitionList
                  items={[
                    { label: 'Invoiced', value: fmtMoney(financial.data.totalInvoicedPaisa) },
                    { label: 'Paid', value: fmtMoney(financial.data.totalPaidPaisa) },
                    { label: 'Due', value: fmtMoney(financial.data.outstandingPaisa) },
                    { label: 'Invoices', value: String(financial.data.invoiceCount) },
                  ]}
                />
                {financial.data.openInvoices.length > 0 ? (
                  <div className="stack stack--sm" style={{ marginTop: 12 }}>
                    <div className="field__label">Open invoices</div>
                    {financial.data.openInvoices.map((invoice) => (
                      <div key={invoice.id} className="row row--between">
                        <span className="mono small">{invoice.number}</span>
                        <span className="small">{fmtMoney(invoice.duePaisa)}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </Card>
        ) : null}

        {detail.contacts.length > 0 ? (
          <Card title="Additional contacts">
            <div className="stack stack--sm">
              {detail.contacts.map((contact) => (
                <div key={contact.id}>
                  <div>{contact.name}</div>
                  <div className="small muted">
                    {contact.relation} · {contact.value}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        ) : null}
      </aside>
    </div>
  );
}

function TimelineTab({ patientId }: { patientId: number }): JSX.Element {
  const timeline = useApi('patients.timeline', { id: patientId, limit: 200 });
  if (timeline.loading && !timeline.data) return <LoadingBlock rows={6} />;
  if (timeline.error) return <ErrorState message={timeline.error} onRetry={timeline.reload} />;
  const events = timeline.data ?? [];
  if (events.length === 0) {
    return (
      <Empty title="Nothing recorded yet" text="Visits, prescriptions, invoices and payments appear here." icon={<History size={24} />} />
    );
  }
  return (
    <Card title="Clinical timeline" subtitle={`${events.length} event(s)`}>
      <Timeline
        items={events.map((event) => ({
          key: event.id,
          title: (
            <span className="row" style={{ gap: 8 }}>
              {event.title}
              {event.amountPaisa !== null ? <span className="numerical small">{fmtMoney(event.amountPaisa)}</span> : null}
              {event.status ? <StatusBadge status={event.status} /> : null}
            </span>
          ),
          detail: (
            <>
              {event.subtitle}
              {event.detail ? <div className="small muted">{event.detail}</div> : null}
            </>
          ),
          date: (
            <span className="small muted">
              {fmtDate(event.date)}
              {event.dentistName ? ` · ${event.dentistName}` : ''}
            </span>
          ),
        }))}
      />
    </Card>
  );
}

function VisitsTab({ patientId }: { patientId: number }): JSX.Element {
  const navigate = useNavigate();
  const visits = useApi('visits.byPatient', { patientId, limit: 100 });
  const items = visits.data ?? [];
  return (
    <Card title="Visit history" subtitle="Visits are immutable — corrections are recorded as a new visit.">
      <DataTable
        columns={[
          { key: 'date', label: 'Date' },
          { key: 'dentist', label: 'Dentist' },
          { key: 'complaint', label: 'Chief complaint' },
          { key: 'diagnosis', label: 'Diagnosis' },
          { key: 'treatments', label: 'Treatments', align: 'right' },
          { key: 'invoice', label: 'Invoice' },
        ]}
        rows={items.map((visit: VisitSummary) => ({
          date: `${fmtDate(visit.visitDate)} ${visit.visitTime}`,
          dentist: visit.dentistName || '—',
          complaint: visit.chiefComplaint || '—',
          diagnosis: visit.diagnosis || '—',
          treatments: String(visit.treatmentCount),
          invoice: visit.invoiceNumber ? (
            <span className="mono small">{visit.invoiceNumber}</span>
          ) : visit.hasPrescription ? (
            <Badge tone="info">Rx</Badge>
          ) : (
            '—'
          ),
        }))}
        loading={visits.loading && !visits.data}
        error={visits.error}
        onRetry={visits.reload}
        onRowClick={() => navigate(resolveScreenPath('visits'))}
        rowKey={(index) => String(items[index]?.id ?? index)}
        empty={<Empty title="No visits recorded" text="Record a visit to start the clinical history." />}
      />
    </Card>
  );
}

function PrescriptionsTab({ patientId }: { patientId: number }): JSX.Element {
  const prescriptions = useApi('prescriptions.byPatient', { patientId, limit: 100 });
  const items = prescriptions.data ?? [];
  const [printing, setPrinting] = useState<number | null>(null);
  const { run } = useAction();
  return (
    <Card
      title="Prescriptions"
      actions={
        <Button
          size="sm"
          variant="primary"
          icon={<Pill size={14} />}
          onClick={() => window.location.assign(`#${resolveScreenPath('prescriptions')}?patient=${patientId}`)}
        >
          New prescription
        </Button>
      }
    >
      <DataTable
        columns={[
          { key: 'number', label: 'Number' },
          { key: 'date', label: 'Date' },
          { key: 'diagnosis', label: 'Diagnosis' },
          { key: 'items', label: 'Meds', align: 'right' },
          { key: 'status', label: 'Status' },
          { key: 'actions', label: '' },
        ]}
        rows={items.map((prescription: PrescriptionSummary) => ({
          number: <span className="mono small">{prescription.number}</span>,
          date: fmtDate(prescription.date),
          diagnosis: prescription.diagnosis || '—',
          items: String(prescription.itemCount),
          status: prescription.isVoid ? (
            <Badge tone="danger">Void</Badge>
          ) : prescription.printedAt ? (
            <Badge tone="success">Printed</Badge>
          ) : (
            <Badge>Draft</Badge>
          ),
          actions: (
            <Button
              size="sm"
              variant="ghost"
              loading={printing === prescription.id}
              onClick={async () => {
                setPrinting(prescription.id);
                const result = await run(() =>
                  bridge.invoke('print.render', {
                    kind: 'prescription',
                    id: prescription.id,
                    output: 'pdf',
                  }),
                );
                setPrinting(null);
                if (result?.pdfPath) await run(() => bridge.invoke('app.openPath', { path: result.pdfPath! }));
              }}
            >
              PDF
            </Button>
          ),
        }))}
        loading={prescriptions.loading && !prescriptions.data}
        error={prescriptions.error}
        onRetry={prescriptions.reload}
        rowKey={(index) => String(items[index]?.id ?? index)}
        empty={<Empty title="No prescriptions" text="Prescriptions written for this patient appear here." />}
      />
    </Card>
  );
}

function PlansTab({ patientId }: { patientId: number }): JSX.Element {
  const plans = useApi('treatmentPlans.list', { patientId, pageSize: 50 });
  const items = plans.data?.items ?? [];
  if (plans.loading && !plans.data) return <LoadingBlock rows={5} />;
  if (items.length === 0) {
    return (
      <Empty
        title="No treatment plans"
        text="Long treatments are tracked as plans with sessions and items."
        icon={<Stethoscope size={24} />}
      />
    );
  }
  return (
    <div className="stack">
      {items.map((plan) => (
        <Card
          key={plan.id}
          title={plan.title}
          subtitle={`${plan.completedItems} of ${plan.items.length} item(s) complete · estimated ${fmtMoney(plan.estimatedTotalPaisa)}`}
          actions={<StatusBadge status={plan.status} />}
        >
          <DataTable
            columns={[
              { key: 'session', label: 'Session', align: 'right' },
              { key: 'description', label: 'Treatment' },
              { key: 'teeth', label: 'Teeth' },
              { key: 'estimate', label: 'Estimate', align: 'right' },
              { key: 'status', label: 'Status' },
            ]}
            rows={plan.items.map((item) => ({
              session: String(item.sessionNumber),
              description: item.description,
              teeth: item.toothCodes.join(', ') || '—',
              estimate: fmtMoney(item.estimatedPaisa),
              status: <StatusBadge status={item.status} />,
            }))}
            empty={<Empty title="This plan has no items yet" />}
            rowKey={(index) => String(plan.items[index]?.id ?? index)}
          />
        </Card>
      ))}
    </div>
  );
}

function BillingTab({ patientId, canSeeMoney }: { patientId: number; canSeeMoney: boolean }): JSX.Element {
  const navigate = useNavigate();
  const invoices = useApi('invoices.byPatient', canSeeMoney ? { patientId, limit: 100 } : null);
  const payments = useApi('payments.byPatient', canSeeMoney ? { patientId, limit: 100 } : null);
  if (!canSeeMoney) {
    return (
      <Banner tone="info" title="Billing is restricted">
        Your role does not include permission to view invoices and payments.
      </Banner>
    );
  }
  const invoiceItems = invoices.data ?? [];
  const paymentItems = payments.data ?? [];
  return (
    <div className="stack">
      <Card
        title="Invoices"
        actions={
          <Button size="sm" variant="primary" icon={<Receipt size={14} />} onClick={() => navigate(resolveScreenPath('invoices'))}>
            New invoice
          </Button>
        }
      >
        <DataTable
          columns={[
            { key: 'number', label: 'Number' },
            { key: 'date', label: 'Date' },
            { key: 'total', label: 'Total', align: 'right' },
            { key: 'paid', label: 'Paid', align: 'right' },
            { key: 'due', label: 'Due', align: 'right' },
            { key: 'status', label: 'Status' },
          ]}
          rows={invoiceItems.map((invoice: InvoiceSummary) => ({
            number: <span className="mono small">{invoice.number}</span>,
            date: fmtDate(invoice.date),
            total: fmtMoney(invoice.totalPaisa),
            paid: fmtMoney(invoice.paidPaisa),
            due: fmtMoney(invoice.duePaisa),
            status: <StatusBadge status={invoice.status} />,
          }))}
          loading={invoices.loading && !invoices.data}
          error={invoices.error}
          onRetry={invoices.reload}
          rowKey={(index) => String(invoiceItems[index]?.id ?? index)}
          empty={<Empty title="No invoices" icon={<FileText size={24} />} />}
        />
      </Card>

      <Card title="Payments">
        <DataTable
          columns={[
            { key: 'receipt', label: 'Receipt' },
            { key: 'date', label: 'Date' },
            { key: 'method', label: 'Method' },
            { key: 'amount', label: 'Amount', align: 'right' },
            { key: 'status', label: 'Status' },
          ]}
          rows={paymentItems.map((payment) => ({
            receipt: <span className="mono small">{payment.receiptNumber}</span>,
            date: fmtDate(payment.paidDate),
            method: payment.methodName || '—',
            amount: fmtMoney(payment.amountPaisa),
            status: payment.isVoid ? <Badge tone="danger">Void</Badge> : <Badge tone="success">Received</Badge>,
          }))}
          loading={payments.loading && !payments.data}
          error={payments.error}
          onRetry={payments.reload}
          rowKey={(index) => String(paymentItems[index]?.id ?? index)}
          empty={<Empty title="No payments recorded" />}
        />
      </Card>
    </div>
  );
}

function FilesTab({ patientId, canManage }: { patientId: number; canManage: boolean }): JSX.Element {
  const { toast } = useApp();
  const { run, busy } = useAction();
  const files = useApi('attachments.list', { patientId });
  const [category, setCategory] = useState<AttachmentCategory>('xray');
  const [description, setDescription] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const items = files.data ?? [];

  const upload = async (file: File) => {
    const path = await resolveSourcePath(file);
    const added = await run(
      () =>
        bridge.invoke('attachments.pickAndAdd', {
          entityType: 'patient',
          entityId: patientId,
          patientId,
          category,
          description,
          copyFromPath: path,
        }),
      { success: 'File attached.', failure: 'The file could not be attached.' },
    );
    if (added) {
      setDescription('');
      files.reload();
      if (added.some((attachment) => attachment.missingFile)) {
        toast('warning', 'Stored, but the preview is unavailable', 'The file was copied into the patient folder.');
      }
    }
  };

  return (
    <Card
      title="Files & images"
      subtitle="X-rays, photographs, reports and signed consent forms — stored inside the clinic data folder."
      actions={
        canManage ? (
          <>
            <Select
              value={category}
              options={ATTACHMENT_CATEGORIES.map((option) => ({ value: option.value, label: option.label }))}
              onChange={(event) => setCategory(event.target.value as AttachmentCategory)}
            />
            <Button icon={<Upload size={15} />} loading={busy} onClick={() => input.current?.click()}>
              Attach file
            </Button>
          </>
        ) : null
      }
    >
      <input
        ref={input}
        type="file"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = '';
        }}
      />
      <DataTable
        columns={[
          { key: 'name', label: 'File' },
          { key: 'category', label: 'Category' },
          { key: 'description', label: 'Description' },
          { key: 'size', label: 'Size', align: 'right' },
          { key: 'uploaded', label: 'Uploaded' },
          { key: 'actions', label: '' },
        ]}
        rows={items.map((attachment: Attachment) => ({
          name: (
            <span className="row" style={{ gap: 8 }}>
              <Paperclip size={14} />
              {attachment.fileName}
              {attachment.missingFile ? <Badge tone="danger">Missing</Badge> : null}
            </span>
          ),
          category: ATTACHMENT_CATEGORIES.find((option) => option.value === attachment.category)?.label ?? attachment.category,
          description: attachment.description || '—',
          size: `${Math.round(attachment.sizeBytes / 1024)} KB`,
          uploaded: `${fmtDateTime(attachment.createdAt)} · ${attachment.uploadedByName}`,
          actions: (
            <div className="row" style={{ gap: 6 }}>
              <Button size="sm" variant="ghost" onClick={() => void run(() => bridge.invoke('attachments.open', { id: attachment.id }))}>
                Open
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void run(() => bridge.invoke('attachments.revealInFolder', { id: attachment.id }))}
              >
                Folder
              </Button>
            </div>
          ),
        }))}
        loading={files.loading && !files.data}
        error={files.error}
        onRetry={files.reload}
        rowKey={(index) => String(items[index]?.id ?? index)}
        empty={<Empty title="No files yet" text="Attach an X-ray, photo or scanned document." icon={<Paperclip size={24} />} />}
      />
    </Card>
  );
}

function ReferralsTab({ patientId }: { patientId: number }): JSX.Element {
  const referrals = useApi('referrals.byPatient', { patientId });
  const items = referrals.data ?? [];
  return (
    <Card
      title="Referrals"
      actions={
        <Button size="sm" onClick={() => window.location.assign('#/referrals')}>
          Manage referrals
        </Button>
      }
    >
      <DataTable
        columns={[
          { key: 'date', label: 'Date' },
          { key: 'doctor', label: 'Referred to' },
          { key: 'specialty', label: 'Specialty' },
          { key: 'reason', label: 'Reason' },
          { key: 'status', label: 'Status' },
        ]}
        rows={items.map((referral) => ({
          date: fmtDate(referral.date),
          doctor: referral.doctorName,
          specialty: referral.specialty || '—',
          reason: referral.reason || '—',
          status: <StatusBadge status={referral.status} />,
        }))}
        loading={referrals.loading && !referrals.data}
        error={referrals.error}
        onRetry={referrals.reload}
        rowKey={(index) => String(items[index]?.id ?? index)}
        empty={<Empty title="No referrals" text="Referrals to specialists are recorded here." />}
      />
    </Card>
  );
}

export function PatientSummaryChips({ patient }: { patient: PatientDetail }): JSX.Element {
  const chips = useMemo(
    () => [patient.ageText, GENDER_LABELS[patient.gender], patient.bloodGroup === 'unknown' ? '' : patient.bloodGroup].filter(Boolean),
    [patient],
  );
  return (
    <div className="chip-row">
      {chips.map((chip) => (
        <Chip key={chip}>{chip}</Chip>
      ))}
    </div>
  );
}
