/**
 * Invoices: raise, adjust, take payment, void, print.
 *
 * The invoice sheet carries the clinic header only — invoices are never signed
 * by a dentist — while prescriptions carry the dentist's credentials.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FileText, Plus, Printer, Receipt, Trash2 } from 'lucide-react';
import { resolveScreenPath } from '@shared/api';
import { INVOICE_STATUSES, INVOICE_STATUS_LABELS } from '@shared/constants';
import type { InvoiceStatus } from '@shared/constants';
import { todayIso } from '@shared/dates';
import { applyDiscount } from '@shared/money';
import type {
  InvoiceDetail,
  InvoiceInput,
  InvoiceItemInput,
  InvoiceSummary,
  PatientSummary,
  PaymentMethod,
  Treatment,
} from '@shared/types';
import { useAction, useApi, useApp } from '@renderer/state/store';
import { bridge } from '@renderer/lib/bridge';
import { fmtDate, fmtMoney, fmtTime } from '@renderer/lib/format';
import {
  Badge,
  Button,
  Card,
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
  Switch,
  TextArea,
} from '@renderer/components/ui';
import { DataTable, DentistSelect, MoneyField, PatientPicker, TextField, rangePresetOptions } from '@renderer/components/forms';

function emptyItem(sortOrder: number): InvoiceItemInput {
  return {
    treatmentId: null,
    code: '',
    description: '',
    toothCodes: [],
    quantity: 1,
    unitPricePaisa: 0,
    discountType: 'none',
    discountValue: 0,
    sortOrder,
  };
}

function emptyInvoice(patientId = 0): InvoiceInput {
  return {
    patientId,
    visitId: null,
    dentistId: null,
    date: todayIso(),
    notes: '',
    items: [emptyItem(1)],
    discountType: 'none',
    discountValue: 0,
  };
}

function InvoiceEditor({
  open,
  invoiceId,
  defaultPatientId,
  onClose,
  onSaved,
}: {
  open: boolean;
  invoiceId: number | null;
  defaultPatientId: number | null;
  onClose(): void;
  onSaved(id: number): void;
}): JSX.Element | null {
  const { toast } = useApp();
  const { run, busy } = useAction();
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [form, setForm] = useState<InvoiceInput>(emptyInvoice());
  const existing = useApi('invoices.get', invoiceId ? { id: invoiceId } : null);
  const prefill = useApi('patients.quickSearch', defaultPatientId ? { query: String(defaultPatientId), limit: 5 } : null);
  const editPatient = useApi('patients.quickSearch', existing.data ? { query: existing.data.patientCode, limit: 5 } : null);
  const treatments = useApi('resource.list', { resource: 'treatments', query: { pageSize: 300 } });
  const options = (treatments.data?.items ?? []) as unknown as Treatment[];

  useEffect(() => {
    const match = defaultPatientId ? (prefill.data ?? []).find((candidate) => candidate.id === defaultPatientId) : undefined;
    if (match && !invoiceId) {
      setPatient(match);
      setForm(emptyInvoice(match.id));
    }
  }, [defaultPatientId, prefill.data, invoiceId]);

  useEffect(() => {
    const match = editPatient.data?.find((candidate) => candidate.id === existing.data?.patientId);
    if (match) setPatient(match);
  }, [editPatient.data, existing.data]);

  useEffect(() => {
    const detail = existing.data;
    if (!detail) return;
    setForm({
      patientId: detail.patientId,
      visitId: detail.visitId,
      dentistId: detail.dentistId,
      date: detail.date,
      notes: detail.notes,
      discountType: detail.invoiceDiscountType,
      discountValue: detail.invoiceDiscountValue,
      items: detail.items.map((item, index) => ({
        id: item.id,
        treatmentId: item.treatmentId,
        code: item.code,
        description: item.description,
        toothCodes: [...item.toothCodes],
        quantity: item.quantity,
        unitPricePaisa: item.unitPricePaisa,
        discountType: item.discountType,
        discountValue: item.discountValue,
        sortOrder: index + 1,
      })),
    });
  }, [existing.data]);

  const totals = useMemo(() => {
    const subtotal = form.items.reduce((sum, item) => sum + item.unitPricePaisa * item.quantity, 0);
    const lineDiscounts = form.items.reduce((sum, item) => {
      const discount = applyDiscount(item.unitPricePaisa * item.quantity, {
        type: item.discountType === 'none' ? 'amount' : item.discountType,
        value: item.discountType === 'none' ? 0 : item.discountValue,
      });
      return sum + discount.discount;
    }, 0);
    const base = subtotal - lineDiscounts;
    const invoiceDiscount = applyDiscount(base, {
      type: form.discountType === 'amount' ? 'amount' : 'percent',
      value: form.discountType === 'none' ? 0 : (form.discountValue ?? 0),
    });
    return { subtotal, lineDiscounts, total: form.discountType === 'none' ? base : invoiceDiscount.total };
  }, [form]);

  const save = async () => {
    const patientId = patient?.id ?? form.patientId;
    if (!patientId) {
      toast('warning', 'Choose a patient first');
      return;
    }
    const input: InvoiceInput = {
      ...form,
      patientId,
      items: form.items
        .filter((item) => item.description.trim() && item.unitPricePaisa >= 0)
        .map((item, index) => ({ ...item, sortOrder: index + 1 })),
    };
    if (input.items.length === 0) {
      toast('warning', 'Add at least one line');
      return;
    }
    if (input.items.some((item) => !Number.isInteger(item.quantity) || item.quantity <= 0)) {
      toast('warning', 'Every line needs a whole-number quantity greater than zero.');
      return;
    }
    const saved = await run(
      () =>
        invoiceId
          ? bridge.invoke('invoices.update', { id: invoiceId, input }).then(() => ({ id: invoiceId, number: '' }))
          : bridge.invoke('invoices.create', { input }),
      { success: invoiceId ? 'Invoice updated.' : 'Invoice raised.', failure: 'The invoice could not be saved.' },
    );
    if (saved) {
      onSaved(saved.id);
      onClose();
    }
  };

  if (!open) return null;

  return (
    <Modal
      open
      width="wide"
      title={invoiceId ? 'Edit invoice' : 'Raise an invoice'}
      description="Amounts are entered in BDT. Discounts can be set per line or on the whole invoice."
      onClose={onClose}
      footer={
        <div className="row row--between" style={{ width: '100%' }}>
          <div className="row" style={{ gap: 16 }}>
            <span className="small muted">Subtotal {fmtMoney(totals.subtotal)}</span>
            <span className="small muted">Discount {fmtMoney(totals.lineDiscounts)}</span>
            <strong>Total {fmtMoney(totals.total)}</strong>
          </div>
          <div className="row row--end">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              {invoiceId ? 'Save invoice' : 'Raise invoice'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="stack">
        <PatientPicker value={patient} onChange={setPatient} autoFocus={!invoiceId && !defaultPatientId} />
        <div className="grid-3">
          <Field label="Date" required>
            <Input type="date" value={form.date} onChange={(event) => setForm((current) => ({ ...current, date: event.target.value }))} />
          </Field>
          <DentistSelect value={form.dentistId} onChange={(value) => setForm((current) => ({ ...current, dentistId: value }))} />
          <Field label="Visit ID" hint="Optional link to a visit">
            <Input
              className="input--numeric"
              value={form.visitId === null ? '' : String(form.visitId)}
              onChange={(event) => setForm((current) => ({ ...current, visitId: event.target.value ? Number(event.target.value) : null }))}
            />
          </Field>
        </div>

        <Card
          title="Lines"
          actions={
            <Button
              size="sm"
              icon={<Plus size={14} />}
              onClick={() => setForm((current) => ({ ...current, items: [...current.items, emptyItem(current.items.length + 1)] }))}
            >
              Add line
            </Button>
          }
        >
          <div className="stack stack--sm">
            {form.items.map((item, index) => (
              <div key={index} className="card">
                <div className="card__body stack stack--sm">
                  <div className="grid-3" style={{ alignItems: 'end' }}>
                    <Field label="Treatment">
                      <Select
                        value={item.treatmentId === null ? '' : String(item.treatmentId)}
                        placeholder="Free text below"
                        options={options.map((treatment) => ({
                          value: String(treatment.id),
                          label: `${treatment.name} · ${fmtMoney(treatment.pricePaisa)}`,
                        }))}
                        onChange={(event) => {
                          const selected = options.find((treatment) => String(treatment.id) === event.target.value);
                          const items = [...form.items];
                          items[index] = {
                            ...item,
                            treatmentId: selected?.id ?? null,
                            code: selected?.code ?? item.code,
                            description: selected?.name ?? item.description,
                            unitPricePaisa: selected?.pricePaisa ?? item.unitPricePaisa,
                          };
                          setForm((current) => ({ ...current, items }));
                        }}
                      />
                    </Field>
                    <TextField
                      label="Description"
                      value={item.description}
                      onChange={(value) => {
                        const items = [...form.items];
                        items[index] = { ...item, description: value };
                        setForm((current) => ({ ...current, items }));
                      }}
                    />
                    <TextField
                      label="Teeth"
                      value={item.toothCodes.join(', ')}
                      hint="FDI codes"
                      onChange={(value) => {
                        const items = [...form.items];
                        items[index] = {
                          ...item,
                          toothCodes: value
                            .split(',')
                            .map((part) => part.trim())
                            .filter(Boolean),
                        };
                        setForm((current) => ({ ...current, items }));
                      }}
                    />
                  </div>
                  <div className="grid-4" style={{ alignItems: 'end' }}>
                    <MoneyField
                      label="Unit price"
                      valuePaisa={item.unitPricePaisa}
                      onChange={(paisa) => {
                        const items = [...form.items];
                        items[index] = { ...item, unitPricePaisa: paisa };
                        setForm((current) => ({ ...current, items }));
                      }}
                    />
                    <Field label="Quantity">
                      <Input
                        className="input--numeric"
                        inputMode="numeric"
                        value={item.quantity === 0 ? '' : String(item.quantity)}
                        onChange={(event) => {
                          const items = [...form.items];
                          items[index] = { ...item, quantity: event.target.value === '' ? 0 : Number(event.target.value) };
                          setForm((current) => ({ ...current, items }));
                        }}
                      />
                    </Field>
                    <Field label="Line discount">
                      <Select
                        value={item.discountType}
                        options={[
                          { value: 'none', label: 'No discount' },
                          { value: 'percent', label: 'Percent' },
                          { value: 'amount', label: 'Amount (৳)' },
                        ]}
                        onChange={(event) => {
                          const items = [...form.items];
                          items[index] = { ...item, discountType: event.target.value as InvoiceItemInput['discountType'] };
                          setForm((current) => ({ ...current, items }));
                        }}
                      />
                    </Field>
                    <div className="row" style={{ alignItems: 'end', gap: 8 }}>
                      <Field label="Value">
                        <Input
                          className="input--numeric"
                          inputMode="decimal"
                          disabled={item.discountType === 'none'}
                          value={String(item.discountValue)}
                          onChange={(event) => {
                            const items = [...form.items];
                            items[index] = { ...item, discountValue: Number(event.target.value) || 0 };
                            setForm((current) => ({ ...current, items }));
                          }}
                        />
                      </Field>
                      <Button
                        variant="ghost"
                        aria-label="Remove line"
                        onClick={() =>
                          setForm((current) => ({
                            ...current,
                            items: current.items.filter((_, position) => position !== index),
                          }))
                        }
                      >
                        <Trash2 size={15} />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <div className="grid-3" style={{ alignItems: 'end' }}>
          <Field label="Invoice discount">
            <Select
              value={form.discountType ?? 'none'}
              options={[
                { value: 'none', label: 'No discount' },
                { value: 'percent', label: 'Percent' },
                { value: 'amount', label: 'Amount (৳)' },
              ]}
              onChange={(event) => setForm((current) => ({ ...current, discountType: event.target.value as InvoiceInput['discountType'] }))}
            />
          </Field>
          <Field label="Discount value">
            <Input
              className="input--numeric"
              disabled={form.discountType === 'none'}
              value={String(form.discountValue ?? 0)}
              onChange={(event) => setForm((current) => ({ ...current, discountValue: Number(event.target.value) || 0 }))}
            />
          </Field>
          <div className="text-right">
            <div className="small muted">Total after discount</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{fmtMoney(totals.total)}</div>
          </div>
        </div>

        <Field label="Notes on the invoice">
          <TextArea value={form.notes} rows={2} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} />
        </Field>
      </div>
    </Modal>
  );
}

function PaymentDialog({
  open,
  invoice,
  onClose,
  onSaved,
}: {
  open: boolean;
  invoice: InvoiceDetail | null;
  onClose(): void;
  onSaved(): void;
}): JSX.Element | null {
  const { run, busy } = useAction();
  const methods = useApi('resource.list', { resource: 'payment-methods', query: { pageSize: 100 }, includeInactive: false });
  const [methodId, setMethodId] = useState<number | null>(null);
  const [amount, setAmount] = useState(0);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (invoice) setAmount(invoice.duePaisa);
  }, [invoice]);

  if (!open || !invoice) return null;
  const methodList = (methods.data?.items ?? []) as unknown as PaymentMethod[];
  const selectedMethod = methodList.find((method) => method.id === methodId);

  const save = async () => {
    const done = await run(
      () =>
        bridge.invoke('payments.create', {
          input: { invoiceId: invoice.id, amountPaisa: amount, methodId, reference, note },
        }),
      { success: 'Payment recorded.', failure: 'The payment could not be recorded.' },
    );
    if (done) {
      onSaved();
      onClose();
    }
  };

  return (
    <Modal
      open
      width="narrow"
      title={`Take payment · ${invoice.number}`}
      description={`Outstanding ${fmtMoney(invoice.duePaisa)} of ${fmtMoney(invoice.totalPaisa)}`}
      onClose={onClose}
      footer={
        <div className="row row--end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={amount <= 0} onClick={() => void save()}>
            Record payment
          </Button>
        </div>
      }
    >
      <div className="stack">
        <MoneyField label="Amount received" valuePaisa={amount} onChange={setAmount} required />
        <Field label="Payment method" required>
          <Select
            value={methodId === null ? '' : String(methodId)}
            placeholder="Choose a method"
            options={methodList.map((method) => ({ value: String(method.id), label: method.name }))}
            onChange={(event) => setMethodId(event.target.value ? Number(event.target.value) : null)}
          />
        </Field>
        {selectedMethod?.requiresReference ? (
          <TextField
            label="Reference"
            required
            hint="Transaction id, cheque number or mobile wallet reference"
            value={reference}
            onChange={setReference}
          />
        ) : null}
        <Field label="Note">
          <TextArea value={note} rows={2} onChange={(event) => setNote(event.target.value)} />
        </Field>
        <div className="row">
          {[invoice.duePaisa, Math.round(invoice.duePaisa / 2)].map((preset) => (
            <Button key={preset} size="sm" variant="ghost" onClick={() => setAmount(preset)}>
              {fmtMoney(preset)}
            </Button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function InvoiceDrawer({
  invoiceId,
  onClose,
  onChanged,
  onEdit,
}: {
  invoiceId: number | null;
  onClose(): void;
  onChanged(): void;
  onEdit(id: number): void;
}): JSX.Element | null {
  const { confirm } = useApp();
  const { run } = useAction();
  const invoice = useApi('invoices.get', invoiceId ? { id: invoiceId } : null);
  const detail = invoice.data;
  const [payOpen, setPayOpen] = useState(false);

  if (!invoiceId) return null;

  const print = async (output: 'pdf' | 'print') => {
    const result = await run(() => bridge.invoke('print.render', { kind: 'invoice', id: invoiceId, output }), {
      success: output === 'print' ? 'Sent to the printer.' : 'PDF generated.',
      failure: 'Printing failed.',
    });
    if (result?.pdfPath) await run(() => bridge.invoke('app.openPath', { path: result.pdfPath! }));
  };

  const voidInvoice = async () => {
    const answer = await confirm({
      title: 'Void this invoice',
      description: 'Voiding keeps the invoice in the ledger but removes it from outstanding balances.',
      confirmLabel: 'Void invoice',
      tone: 'danger',
      reason: true,
    });
    if (!answer.ok || !answer.reason) return;
    const done = await run(() => bridge.invoke('invoices.void', { id: invoiceId, reason: answer.reason! }), {
      success: 'Invoice voided.',
    });
    if (done !== null) {
      onChanged();
      invoice.reload();
    }
  };

  const voidPayment = async (paymentId: number, receiptNumber: string) => {
    const answer = await confirm({
      title: `Void receipt ${receiptNumber}`,
      description: 'The receipt is cancelled and the invoice balance is restored.',
      confirmLabel: 'Void receipt',
      tone: 'danger',
      reason: true,
    });
    if (!answer.ok || !answer.reason) return;
    const done = await run(() => bridge.invoke('payments.void', { id: paymentId, reason: answer.reason!, confirmText: receiptNumber }), {
      success: 'Receipt voided.',
    });
    if (done !== null) {
      onChanged();
      invoice.reload();
    }
  };

  return (
    <Drawer
      open
      title={detail ? `Invoice ${detail.number}` : 'Invoice'}
      onClose={onClose}
      footer={
        detail ? (
          <div className="row row--end">
            <Button variant="ghost" icon={<Printer size={15} />} onClick={() => void print('pdf')}>
              PDF
            </Button>
            <Button variant="ghost" icon={<Printer size={15} />} onClick={() => void print('print')}>
              Print
            </Button>
            {detail.status !== 'void' ? (
              <Button variant="ghost" onClick={() => onEdit(detail.id)}>
                Edit
              </Button>
            ) : null}
            {detail.status !== 'void' && detail.duePaisa > 0 ? (
              <Button variant="primary" icon={<Receipt size={15} />} onClick={() => setPayOpen(true)}>
                Take payment
              </Button>
            ) : null}
            {detail.status !== 'void' ? (
              <Button variant="danger" onClick={() => void voidInvoice()}>
                Void
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      {invoice.loading && !detail ? (
        <LoadingBlock rows={6} />
      ) : !detail ? (
        <ErrorState message={invoice.error ?? 'Not found'} onRetry={invoice.reload} />
      ) : (
        <div className="stack">
          <div className="row row--between">
            <StatusBadge status={detail.status} label={INVOICE_STATUS_LABELS[detail.status]} />
            {detail.status === 'void' ? <Badge tone="danger">Voided</Badge> : null}
          </div>
          <DefinitionList
            items={[
              { label: 'Patient', value: `${detail.patientName} (${detail.patientCode})` },
              { label: 'Phone', value: detail.patientPhone },
              { label: 'Date', value: fmtDate(detail.date) },
              { label: 'Dentist', value: detail.dentistName || '—' },
              { label: 'Subtotal', value: fmtMoney(detail.subtotalPaisa) },
              { label: 'Discount', value: fmtMoney(detail.discountPaisa) },
              { label: 'Total', value: <strong>{fmtMoney(detail.totalPaisa)}</strong> },
              { label: 'Paid', value: fmtMoney(detail.paidPaisa) },
              { label: 'Due', value: <strong>{fmtMoney(detail.duePaisa)}</strong> },
              { label: 'Notes', value: detail.notes },
            ]}
          />

          <Card title="Lines" padded={false}>
            <DataTable
              columns={[
                { key: 'description', label: 'Treatment' },
                { key: 'teeth', label: 'Teeth' },
                { key: 'qty', label: 'Qty', align: 'right' },
                { key: 'price', label: 'Price', align: 'right' },
                { key: 'total', label: 'Total', align: 'right' },
              ]}
              rows={detail.items.map((item) => ({
                description: item.description,
                teeth: item.toothCodes.join(', ') || '—',
                qty: String(item.quantity),
                price: fmtMoney(item.unitPricePaisa),
                total: fmtMoney(item.lineTotalPaisa),
              }))}
              rowKey={(index) => String(detail.items[index]?.id ?? index)}
              empty={<Empty title="No lines" />}
            />
          </Card>

          <Card title={`Payments (${detail.payments.length})`}>
            {detail.payments.length === 0 ? (
              <Empty title="No payment received yet" />
            ) : (
              <div className="stack stack--sm">
                {detail.payments.map((payment) => (
                  <div key={payment.id} className="row row--between">
                    <div>
                      <div className="mono small">{payment.receiptNumber}</div>
                      <div className="small muted">
                        {fmtDate(payment.paidDate)} {fmtTime(payment.paidAt.slice(11, 16))} · {payment.methodName}
                        {payment.reference ? ` · ${payment.reference}` : ''}
                      </div>
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="numerical">{fmtMoney(payment.amountPaisa)}</span>
                      {payment.isVoid ? (
                        <Badge tone="danger">Void</Badge>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => void voidPayment(payment.id, payment.receiptNumber)}>
                          Void
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      <PaymentDialog
        open={payOpen}
        invoice={detail}
        onClose={() => setPayOpen(false)}
        onSaved={() => {
          onChanged();
          invoice.reload();
        }}
      />
    </Drawer>
  );
}

export function InvoicesScreen(): JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const defaultPatientId = Number(params.get('patient')) || null;
  const [search, setSearch] = useState('');
  const [preset, setPreset] = useState('');
  const [status, setStatus] = useState('');
  const [outstandingOnly, setOutstandingOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(Boolean(defaultPatientId));
  const [editing, setEditing] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const list = useApi(
    'invoices.list',
    {
      page,
      pageSize: 25,
      search: search || undefined,
      preset: preset || undefined,
      status: status ? [status as InvoiceStatus] : undefined,
      hasOutstanding: outstandingOnly || undefined,
    },
    [page, search, preset, status, outstandingOnly],
  );
  const items = list.data?.items ?? [];

  return (
    <Page
      title="Invoices"
      description={`${list.data?.total ?? 0} invoice(s)`}
      actions={
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>
          Raise invoice
        </Button>
      }
    >
      <div className="filters">
        <div className="row row--wrap" style={{ gap: 10 }}>
          <div style={{ minWidth: 260, flex: 1 }}>
            <SearchInput
              value={search}
              placeholder="Search by number or patient…"
              onChange={(value) => {
                setSearch(value);
                setPage(1);
              }}
            />
          </div>
          <Select
            value={status}
            placeholder="Any status"
            options={INVOICE_STATUSES.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          />
          <Select
            value={preset}
            placeholder="All time"
            options={rangePresetOptions().filter((option) => option.value !== '')}
            onChange={(event) => {
              setPreset(event.target.value);
              setPage(1);
            }}
          />
          <Switch
            label="With dues"
            checked={outstandingOnly}
            onChange={(value) => {
              setOutstandingOnly(value);
              setPage(1);
            }}
          />
        </div>
      </div>

      <Card padded={false}>
        <DataTable
          columns={[
            { key: 'number', label: 'Number' },
            { key: 'date', label: 'Date' },
            { key: 'patient', label: 'Patient' },
            { key: 'total', label: 'Total', align: 'right' },
            { key: 'paid', label: 'Paid', align: 'right' },
            { key: 'due', label: 'Due', align: 'right' },
            { key: 'status', label: 'Status' },
          ]}
          rows={items.map((invoice: InvoiceSummary) => ({
            number: <span className="mono small">{invoice.number}</span>,
            date: fmtDate(invoice.date),
            patient: (
              <button
                type="button"
                className="btn btn--link"
                onClick={(event) => {
                  event.stopPropagation();
                  void navigate(resolveScreenPath('patient', invoice.patientId));
                }}
              >
                {invoice.patientName}
              </button>
            ),
            total: fmtMoney(invoice.totalPaisa),
            paid: fmtMoney(invoice.paidPaisa),
            due: invoice.duePaisa > 0 ? <strong>{fmtMoney(invoice.duePaisa)}</strong> : fmtMoney(0),
            status: <StatusBadge status={invoice.status} label={INVOICE_STATUS_LABELS[invoice.status]} />,
          }))}
          loading={list.loading && !list.data}
          error={list.error}
          onRetry={list.reload}
          onRowClick={(index) => setSelected(items[index]?.id ?? null)}
          rowKey={(index) => String(items[index]?.id ?? index)}
          empty={
            <Empty
              title="No invoices matched"
              text="Raise an invoice after a visit, or clear the filters."
              icon={<FileText size={24} />}
              action={
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  Raise invoice
                </Button>
              }
            />
          }
        />
        {list.data && list.data.total > 0 ? (
          <div className="pagination">
            <span>
              Page {list.data.page} of {Math.max(1, list.data.pageCount)} · {list.data.total} invoice(s)
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

      <InvoiceEditor
        open={createOpen}
        invoiceId={null}
        defaultPatientId={defaultPatientId}
        onClose={() => setCreateOpen(false)}
        onSaved={(id) => {
          list.reload();
          setSelected(id);
        }}
      />
      <InvoiceEditor
        open={editing !== null}
        invoiceId={editing}
        defaultPatientId={null}
        onClose={() => setEditing(null)}
        onSaved={(id) => {
          setEditing(null);
          list.reload();
          setSelected(id);
        }}
      />
      <InvoiceDrawer
        invoiceId={selected}
        onClose={() => setSelected(null)}
        onChanged={() => list.reload()}
        onEdit={(id) => {
          setSelected(null);
          setEditing(id);
        }}
      />
    </Page>
  );
}

export function OutstandingSummary(): JSX.Element {
  const outstanding = useApi('invoices.outstanding', { page: 1, pageSize: 10 });
  const rows = outstanding.data?.items ?? [];
  if (rows.length === 0) return <Empty title="Nothing outstanding" />;
  return (
    <DataTable
      columns={[
        { key: 'patient', label: 'Patient' },
        { key: 'invoices', label: 'Invoices', align: 'right' },
        { key: 'due', label: 'Due', align: 'right' },
      ]}
      rows={rows.map((row) => ({
        patient: row.patientName,
        invoices: String(row.invoiceCount),
        due: fmtMoney(row.duePaisa),
      }))}
      rowKey={(index) => String(rows[index]?.patientId ?? index)}
      empty={<Empty title="Nothing outstanding" />}
    />
  );
}
