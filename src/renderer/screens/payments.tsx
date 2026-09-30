/**
 * Payments and receipts.
 *
 * Payment methods are configurable (cash, bank, card, bKash, Nagad, Rocket,
 * Upay or anything the clinic adds); wallet and card methods can demand a
 * reference number before the receipt is accepted.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Banknote, Plus, Receipt } from 'lucide-react';
import { resolveScreenPath } from '@shared/api';
import { PAYMENT_METHOD_CATEGORY_LABELS } from '@shared/constants';
import type { PaymentMethod, PaymentStats, PaymentSummary } from '@shared/types';
import { useAction, useApi, useApp } from '@renderer/state/store';
import { bridge } from '@renderer/lib/bridge';
import { fmtDate, fmtMoney } from '@renderer/lib/format';
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  LoadingBlock,
  Modal,
  Page,
  SearchInput,
  Select,
  Stat,
  StatusBadge,
  Switch,
  TextArea,
} from '@renderer/components/ui';
import { DataTable, MoneyField, TextField, rangePresetOptions } from '@renderer/components/forms';

function RecordPaymentDialog({ open, onClose, onSaved }: { open: boolean; onClose(): void; onSaved(): void }): JSX.Element | null {
  const { run, busy } = useAction();
  const outstanding = useApi('invoices.list', open ? { page: 1, pageSize: 50, hasOutstanding: true } : null);
  const methods = useApi('resource.list', { resource: 'payment-methods', query: { pageSize: 100 }, includeInactive: false });
  const [invoiceId, setInvoiceId] = useState<number | null>(null);
  const [amount, setAmount] = useState(0);
  const [methodId, setMethodId] = useState<number | null>(null);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');

  const rows = outstanding.data?.items ?? [];
  const selected = rows.find((row) => row.id === invoiceId);

  useEffect(() => {
    if (selected) setAmount(selected.duePaisa);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceId]);

  const methodList = (methods.data?.items ?? []) as unknown as PaymentMethod[];
  const method = methodList.find((entry) => entry.id === methodId);

  if (!open) return null;

  return (
    <Modal
      open
      title="Record a payment"
      description="Choose the patient account, then the invoice to settle."
      onClose={onClose}
      footer={
        <div className="row row--end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!invoiceId || amount <= 0 || !methodId || (method?.requiresReference && reference.trim().length === 0)}
            onClick={async () => {
              const done = await run(
                () =>
                  bridge.invoke('payments.create', {
                    input: { invoiceId: invoiceId!, amountPaisa: amount, methodId, reference, note },
                  }),
                { success: 'Payment recorded.', failure: 'The payment could not be recorded.' },
              );
              if (done) {
                onSaved();
                onClose();
              }
            }}
          >
            Record payment
          </Button>
        </div>
      }
    >
      <div className="stack">
        {outstanding.loading && !outstanding.data ? (
          <LoadingBlock rows={4} />
        ) : rows.length === 0 ? (
          <Empty title="Nothing outstanding" text="Every invoice is settled." />
        ) : (
          <>
            <Field label="Outstanding invoice" required hint="Only invoices with a balance are listed">
              <Select
                value={invoiceId === null ? '' : String(invoiceId)}
                placeholder="Choose an invoice"
                options={rows.map((row) => ({
                  value: String(row.id),
                  label: `${row.number} · ${row.patientName} (${row.patientCode}) · due ${fmtMoney(row.duePaisa)}`,
                }))}
                onChange={(event) => setInvoiceId(event.target.value ? Number(event.target.value) : null)}
              />
            </Field>
            <div style={{ maxHeight: 220, overflowY: 'auto' }}>
              {rows.slice(0, 20).map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className="menu__item"
                  style={row.id === invoiceId ? { background: 'var(--surface-3)' } : undefined}
                  onClick={() => setInvoiceId(row.id)}
                >
                  <span className="row row--between">
                    <span>
                      {row.patientName} <span className="mono small">{row.number}</span>
                    </span>
                    <span className="small">{fmtMoney(row.duePaisa)}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        <MoneyField label="Amount received" required valuePaisa={amount} onChange={setAmount} />
        <Field label="Payment method" required>
          <Select
            value={methodId === null ? '' : String(methodId)}
            placeholder="Choose a method"
            options={methodList.map((entry) => ({
              value: String(entry.id),
              label: `${entry.name} · ${PAYMENT_METHOD_CATEGORY_LABELS[entry.category]}`,
            }))}
            onChange={(event) => setMethodId(event.target.value ? Number(event.target.value) : null)}
          />
        </Field>
        {method?.requiresReference ? (
          <TextField
            label="Reference"
            required
            hint="Transaction id, cheque number or wallet reference"
            value={reference}
            onChange={setReference}
          />
        ) : null}
        <Field label="Note">
          <TextArea value={note} rows={2} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export function PaymentsScreen(): JSX.Element {
  const navigate = useNavigate();
  const { confirm } = useApp();
  const { run } = useAction();
  const [search, setSearch] = useState('');
  const [preset, setPreset] = useState('');
  const [methodId, setMethodId] = useState<number | null>(null);
  const [includeVoid, setIncludeVoid] = useState(false);
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selected, setSelected] = useState<PaymentSummary | null>(null);

  const methods = useApi('resource.list', { resource: 'payment-methods', query: { pageSize: 100 }, includeInactive: true });
  const list = useApi(
    'payments.list',
    { page, pageSize: 25, search: search || undefined, preset: preset || undefined, methodId, includeVoid },
    [page, search, preset, methodId, includeVoid],
  );
  const stats = useApi('payments.statistics', { preset: preset || undefined }, [preset]);
  const items = list.data?.items ?? [];
  const methodList = (methods.data?.items ?? []) as unknown as PaymentMethod[];

  const voidPayment = async (payment: PaymentSummary) => {
    const answer = await confirm({
      title: `Void receipt ${payment.receiptNumber}`,
      description: 'The receipt is cancelled and the money is no longer counted as collected.',
      confirmLabel: 'Void receipt',
      tone: 'danger',
      reason: true,
    });
    if (!answer.ok || !answer.reason) return;
    const done = await run(
      () =>
        bridge.invoke('payments.void', {
          id: payment.id,
          reason: answer.reason!,
          confirmText: payment.receiptNumber,
        }),
      { success: 'Receipt voided.' },
    );
    if (done !== null) {
      list.reload();
      stats.reload();
    }
  };

  return (
    <Page
      title="Payments"
      description={`${list.data?.total ?? 0} receipt(s)`}
      actions={
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => setDialogOpen(true)}>
          Record payment
        </Button>
      }
    >
      <div className="stat-grid">
        <Stat label="Collected" value={fmtMoney(stats.data?.totalPaisa ?? 0)} tone="success" icon={<Banknote size={16} />} />
        <Stat label="Cash" value={fmtMoney(stats.data?.cashPaisa ?? 0)} />
        <Stat label="Bank" value={fmtMoney(stats.data?.bankPaisa ?? 0)} />
        <Stat label="Card" value={fmtMoney(stats.data?.cardPaisa ?? 0)} />
        <Stat label="Mobile wallet" value={fmtMoney(stats.data?.mobileWalletPaisa ?? 0)} />
        <Stat label="Outstanding" value={fmtMoney(stats.data?.outstandingPaisa ?? 0)} tone="warning" />
      </div>

      <div className="filters">
        <div className="row row--wrap" style={{ gap: 10 }}>
          <div style={{ minWidth: 260, flex: 1 }}>
            <SearchInput
              value={search}
              placeholder="Search by receipt, patient or reference…"
              onChange={(value) => {
                setSearch(value);
                setPage(1);
              }}
            />
          </div>
          <Select
            value={methodId === null ? '' : String(methodId)}
            placeholder="All methods"
            options={methodList.map((entry) => ({ value: String(entry.id), label: entry.name }))}
            onChange={(event) => {
              setMethodId(event.target.value ? Number(event.target.value) : null);
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
            label="Show voided"
            checked={includeVoid}
            onChange={(value) => {
              setIncludeVoid(value);
              setPage(1);
            }}
          />
        </div>
      </div>

      <Card padded={false}>
        <DataTable
          columns={[
            { key: 'receipt', label: 'Receipt' },
            { key: 'date', label: 'Date' },
            { key: 'patient', label: 'Patient' },
            { key: 'invoice', label: 'Invoice' },
            { key: 'method', label: 'Method' },
            { key: 'amount', label: 'Amount', align: 'right' },
            { key: 'status', label: 'Status' },
          ]}
          rows={items.map((payment) => ({
            receipt: <span className="mono small">{payment.receiptNumber}</span>,
            date: fmtDate(payment.paidDate),
            patient: (
              <button
                type="button"
                className="btn btn--link"
                onClick={(event) => {
                  event.stopPropagation();
                  void navigate(resolveScreenPath('patient', payment.patientId));
                }}
              >
                {payment.patientName}
              </button>
            ),
            invoice: <span className="mono small">{payment.invoiceNumber}</span>,
            method: payment.methodName || '—',
            amount: fmtMoney(payment.amountPaisa),
            status: payment.isVoid ? <Badge tone="danger">Void</Badge> : <StatusBadge status="paid" label="Received" />,
          }))}
          loading={list.loading && !list.data}
          error={list.error}
          onRetry={list.reload}
          onRowClick={(index) => setSelected(items[index] ?? null)}
          rowKey={(index) => String(items[index]?.id ?? index)}
          empty={
            <Empty
              title="No payments recorded"
              text="Receipts appear here as soon as money is taken."
              icon={<Receipt size={24} />}
              action={
                <Button variant="primary" onClick={() => setDialogOpen(true)}>
                  Record payment
                </Button>
              }
            />
          }
        />
        {list.data && list.data.total > 0 ? (
          <div className="pagination">
            <span>
              Page {list.data.page} of {Math.max(1, list.data.pageCount)} · {list.data.total} receipt(s)
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

      <RecordPaymentDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSaved={() => {
          list.reload();
          stats.reload();
        }}
      />

      <Modal
        open={selected !== null}
        width="narrow"
        title={selected ? `Receipt ${selected.receiptNumber}` : ''}
        onClose={() => setSelected(null)}
        footer={
          selected && !selected.isVoid ? (
            <div className="row row--end">
              <Button variant="ghost" onClick={() => setSelected(null)}>
                Close
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  await voidPayment(selected);
                  setSelected(null);
                }}
              >
                Void receipt
              </Button>
            </div>
          ) : (
            <Button variant="ghost" onClick={() => setSelected(null)}>
              Close
            </Button>
          )
        }
      >
        {selected ? (
          <div className="stack">
            <div className="row row--between">
              <span>{selected.patientName}</span>
              <strong>{fmtMoney(selected.amountPaisa)}</strong>
            </div>
            <div className="small muted">
              {fmtDate(selected.paidDate)} · {selected.methodName}
              {selected.reference ? ` · ${selected.reference}` : ''}
            </div>
            <div className="small muted">Invoice {selected.invoiceNumber}</div>
            {selected.note ? <div>{selected.note}</div> : null}
            {selected.isVoid ? <Badge tone="danger">Void — {selected.voidReason}</Badge> : null}
            <div className="small muted">Received by {selected.receivedByName}</div>
          </div>
        ) : null}
      </Modal>

      <PaymentMethodStats stats={stats.data} />
    </Page>
  );
}

function PaymentMethodStats({ stats }: { stats: PaymentStats | null }): JSX.Element | null {
  if (!stats || stats.byMethod.length === 0) return null;
  return (
    <Card title="Collections by method" subtitle={`${stats.paymentCount} receipt(s) · ${stats.invoiceCount} invoice(s)`}>
      <DataTable
        columns={[
          { key: 'method', label: 'Method' },
          { key: 'category', label: 'Type' },
          { key: 'count', label: 'Receipts', align: 'right' },
          { key: 'amount', label: 'Amount', align: 'right' },
        ]}
        rows={stats.byMethod.map((entry) => ({
          method: entry.methodName,
          category: PAYMENT_METHOD_CATEGORY_LABELS[entry.category],
          count: String(entry.count),
          amount: fmtMoney(entry.amountPaisa),
        }))}
        rowKey={(index) => String(stats.byMethod[index]?.methodId ?? index)}
        empty={<Empty title="No payments in this period" />}
      />
    </Card>
  );
}
