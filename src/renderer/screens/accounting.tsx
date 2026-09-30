/**
 * Accounting: income and expense book, category breakdown, daybook and the
 * financial periods that freeze a month once it has been reported on.
 */
import { useEffect, useState } from 'react';
import { BookOpen, CalendarClock, Plus, TrendingDown, TrendingUp } from 'lucide-react';
import { ACCOUNTING_DIRECTIONS } from '@shared/constants';
import type { AccountingDirection } from '@shared/constants';
import { todayIso } from '@shared/dates';
import type { AccountingTransaction, AccountingTransactionInput, FinancialPeriod } from '@shared/types';
import { useAction, useApi, useApp } from '@renderer/state/store';
import { bridge } from '@renderer/lib/bridge';
import { fmtDate, fmtMoney, num } from '@renderer/lib/format';
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
  Segmented,
  Select,
  Stat,
  StatusBadge,
  Switch,
  Tabs,
  TextArea,
} from '@renderer/components/ui';
import { DataTable, DateField, MoneyField, TextField, rangePresetOptions, useListState } from '@renderer/components/forms';
import { OptionSelect, ResourceManager } from '@renderer/components/resource-manager';

const TABS = [
  { key: 'book', label: 'Income & expense' },
  { key: 'summary', label: 'Summary' },
  { key: 'daybook', label: 'Daybook' },
  { key: 'periods', label: 'Periods' },
  { key: 'categories', label: 'Categories' },
];

function TransactionDialog({
  open,
  transaction,
  direction,
  onClose,
  onSaved,
}: {
  open: boolean;
  transaction: AccountingTransaction | null;
  direction: AccountingDirection;
  onClose(): void;
  onSaved(): void;
}): JSX.Element | null {
  const { runOk, busy } = useAction();
  const [form, setForm] = useState<AccountingTransactionInput>({
    direction,
    date: todayIso(),
    categoryId: 0,
    amountPaisa: 0,
    paymentMethodId: null,
    reference: '',
    note: '',
  });

  useEffect(() => {
    if (transaction) {
      setForm({
        direction: transaction.direction,
        date: transaction.date,
        categoryId: transaction.categoryId,
        amountPaisa: transaction.amountPaisa,
        paymentMethodId: transaction.paymentMethodId,
        reference: transaction.reference,
        note: transaction.note,
      });
    } else {
      setForm((current) => ({ ...current, direction, date: todayIso() }));
    }
  }, [transaction, direction]);

  const patch = (value: Partial<AccountingTransactionInput>) => setForm((current) => ({ ...current, ...value }));

  if (!open) return null;

  return (
    <Modal
      open
      title={transaction ? 'Edit transaction' : `Record ${form.direction === 'income' ? 'income' : 'expense'}`}
      description="Every entry carries a category, so reports never rely on free text."
      onClose={onClose}
      footer={
        <div className="row row--end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!form.categoryId || form.amountPaisa <= 0 || form.note.trim().length < 3}
            onClick={async () => {
              const saved = await runOk(
                () =>
                  transaction
                    ? bridge.invoke('accounting.transactions.update', { id: transaction.id, input: form })
                    : bridge.invoke('accounting.transactions.create', { input: form }),
                { success: transaction ? 'Transaction updated.' : 'Transaction recorded.', failure: 'The entry could not be saved.' },
              );
              if (saved) {
                onSaved();
                onClose();
              }
            }}
          >
            Save entry
          </Button>
        </div>
      }
    >
      <div className="stack">
        <Field label="Entry type">
          <Segmented
            value={form.direction}
            options={ACCOUNTING_DIRECTIONS.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(value) => patch({ direction: value as AccountingDirection, categoryId: 0 })}
          />
        </Field>
        <div className="grid-2">
          <DateField label="Date" required value={form.date} onChange={(value) => patch({ date: value })} />
          <MoneyField label="Amount" required valuePaisa={form.amountPaisa} onChange={(paisa) => patch({ amountPaisa: paisa })} />
        </div>
        <div className="grid-2">
          <OptionSelect
            label="Category"
            resource="accounting-categories"
            value={form.categoryId || null}
            onChange={(value) => patch({ categoryId: value ?? 0 })}
            allowEmpty={false}
          />
          <OptionSelect
            label="Payment method"
            resource="payment-methods"
            value={form.paymentMethodId}
            onChange={(value) => patch({ paymentMethodId: value })}
          />
        </div>
        <TextField label="Reference" value={form.reference} onChange={(value) => patch({ reference: value })} />
        <Field label="Note" required hint="Explain the entry — this text appears in the daybook">
          <TextArea rows={2} value={form.note} onChange={(event) => patch({ note: event.target.value })} />
        </Field>
        <div className="small muted">Categories belong to one direction only; switching type clears the chosen category.</div>
      </div>
    </Modal>
  );
}

function ClosePeriodDialog({ open, onClose, onSaved }: { open: boolean; onClose(): void; onSaved(): void }): JSX.Element | null {
  const { run, busy } = useAction();
  const [periodStart, setPeriodStart] = useState(todayIso().slice(0, 8) + '01');
  const [periodEnd, setPeriodEnd] = useState(todayIso());
  const [notes, setNotes] = useState('');

  if (!open) return null;

  return (
    <Modal
      open
      width="narrow"
      title="Close a financial period"
      description="A closed period rejects new entries, so reported numbers stay final. Reopen it only with an authorised reason."
      onClose={onClose}
      footer={
        <div className="row row--end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={notes.trim().length < 3 || periodEnd < periodStart}
            onClick={async () => {
              const saved = await run(() => bridge.invoke('accounting.periods.close', { periodStart, periodEnd, notes }), {
                success: 'Period closed.',
                failure: 'The period could not be closed.',
              });
              if (saved) {
                onSaved();
                onClose();
              }
            }}
          >
            Close period
          </Button>
        </div>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <DateField label="From" required value={periodStart} onChange={setPeriodStart} />
          <DateField label="To" required value={periodEnd} onChange={setPeriodEnd} />
        </div>
        <Field label="Notes" required>
          <TextArea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export function AccountingScreen(): JSX.Element {
  const { confirm } = useApp();
  const { run } = useAction();
  const lists = useListState();
  const [tab, setTab] = useState('book');
  const [direction, setDirection] = useState<AccountingDirection>('expense');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [includeVoid, setIncludeVoid] = useState(false);
  const [editing, setEditing] = useState<AccountingTransaction | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [daybookFrom, setDaybookFrom] = useState(todayIso().slice(0, 8) + '01');
  const [daybookTo, setDaybookTo] = useState(todayIso());

  const list = useApi(
    'accounting.transactions.list',
    tab === 'book'
      ? {
          page: lists.state.page,
          pageSize: lists.state.pageSize,
          search: lists.state.search || undefined,
          preset: lists.state.preset || undefined,
          sort: lists.state.sort || undefined,
          direction,
          categoryId,
          includeVoid: includeVoid || undefined,
        }
      : null,
    [tab, lists.state.page, lists.state.search, direction, categoryId, includeVoid],
  );
  const summary = useApi('accounting.summary', { preset: lists.state.preset || 'this_month' }, [tab, lists.state.preset]);
  const daybook = useApi('accounting.daybook', tab === 'daybook' ? { from: daybookFrom, to: daybookTo } : null, [
    tab,
    daybookFrom,
    daybookTo,
  ]);
  const periods = useApi('accounting.periods.list', tab === 'periods' ? undefined : null, [tab]);
  const categories = useApi('resource.list', { resource: 'accounting-categories', query: { pageSize: 200 }, includeInactive: true });

  const rows = list.data?.items ?? [];

  const voidTransaction = async (transaction: AccountingTransaction) => {
    const answer = await confirm({
      title: 'Void this entry',
      description: `${
        transaction.direction === 'income' ? 'Income' : 'Expense'
      } of ${fmtMoney(transaction.amountPaisa)} on ${fmtDate(transaction.date)}.`,
      confirmLabel: 'Void entry',
      tone: 'danger',
      reason: true,
    });
    if (!answer.ok || !answer.reason) return;
    await run(() => bridge.invoke('accounting.transactions.void', { id: transaction.id, reason: answer.reason! }), {
      success: 'Entry voided.',
    });
    list.reload();
    summary.reload();
  };

  const deleteTransaction = async (transaction: AccountingTransaction) => {
    const answer = await confirm({
      title: 'Delete this entry',
      description: 'Deleting is only allowed for entries without a linked source document.',
      confirmLabel: 'Delete entry',
      tone: 'danger',
      reason: true,
    });
    if (!answer.ok || !answer.reason) return;
    await run(() => bridge.invoke('accounting.transactions.delete', { id: transaction.id, reason: answer.reason! }), {
      success: 'Entry deleted.',
    });
    list.reload();
    summary.reload();
  };

  const reopenPeriod = async (period: FinancialPeriod) => {
    const answer = await confirm({
      title: `Reopen ${period.label}`,
      description: 'Reopening allows new entries in a period that was already reported on.',
      confirmLabel: 'Reopen period',
      tone: 'danger',
      reason: true,
      typedWord: 'REOPEN',
    });
    if (!answer.ok || !answer.typed) return;
    await run(() => bridge.invoke('accounting.periods.reopen', { id: period.id, reason: answer.reason ?? '', confirmText: answer.typed }), {
      success: 'Period reopened.',
    });
    periods.reload();
  };

  return (
    <Page
      title="Accounting"
      description="Income, expenses and the periods that lock reported numbers"
      actions={
        <>
          <Button icon={<CalendarClock size={15} />} onClick={() => setCloseOpen(true)}>
            Close period
          </Button>
          <Button
            variant="primary"
            icon={<Plus size={15} />}
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            New entry
          </Button>
        </>
      }
    >
      <div className="stat-grid">
        <Stat label="Income" value={fmtMoney(summary.data?.incomePaisa ?? 0)} tone="success" icon={<TrendingUp size={16} />} />
        <Stat label="Expenses" value={fmtMoney(summary.data?.expensePaisa ?? 0)} tone="danger" icon={<TrendingDown size={16} />} />
        <Stat label="Net" value={fmtMoney(summary.data?.netPaisa ?? 0)} tone={(summary.data?.netPaisa ?? 0) >= 0 ? 'success' : 'danger'} />
        <Stat label="Collected from invoices" value={fmtMoney(summary.data?.collectedFromInvoicesPaisa ?? 0)} />
        <Stat label="Patient dues" value={fmtMoney(summary.data?.outstandingPaisa ?? 0)} tone="warning" />
      </div>

      <div className="filters">
        <div className="row row--wrap" style={{ gap: 10 }}>
          <Select
            value={lists.state.preset}
            placeholder="This month"
            options={rangePresetOptions().filter((option) => option.value !== '')}
            onChange={(event) => lists.patch({ preset: event.target.value })}
          />
          {tab === 'book' ? (
            <Select
              value={categoryId === null ? '' : String(categoryId)}
              placeholder="All categories"
              options={((categories.data?.items ?? []) as unknown as Array<{ id: number; name: string }>).map((category) => ({
                value: String(category.id),
                label: category.name,
              }))}
              onChange={(event) => setCategoryId(event.target.value ? Number(event.target.value) : null)}
            />
          ) : null}
        </div>
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'book' ? (
        <Card padded={false}>
          <div className="row row--wrap" style={{ padding: 'var(--space-4)', gap: 10 }}>
            <div style={{ minWidth: 240, flex: 1 }}>
              <SearchInput
                value={lists.state.search}
                placeholder="Search note or reference…"
                onChange={(value) => lists.patch({ search: value })}
              />
            </div>
            <Segmented
              value={direction}
              options={ACCOUNTING_DIRECTIONS.map((option) => ({ value: option.value, label: option.label }))}
              onChange={(value) => setDirection(value as AccountingDirection)}
            />
            <Switch label="Show voided" checked={includeVoid} onChange={setIncludeVoid} />
          </div>
          <DataTable
            columns={[
              { key: 'date', label: 'Date' },
              { key: 'category', label: 'Category' },
              { key: 'note', label: 'Note' },
              { key: 'method', label: 'Method' },
              { key: 'source', label: 'Source' },
              { key: 'amount', label: 'Amount', align: 'right' },
              { key: 'actions', label: '', align: 'right' },
            ]}
            rows={rows.map((transaction) => ({
              date: fmtDate(transaction.date),
              category: (
                <div>
                  <div>{transaction.categoryName}</div>
                  <div className="small muted">{transaction.reference || '—'}</div>
                </div>
              ),
              note: transaction.note || '—',
              method: transaction.paymentMethodName || '—',
              source:
                transaction.sourceType === 'manual' ? (
                  <Badge>Manual</Badge>
                ) : (
                  <Badge tone="info">{transaction.sourceType.replace(/_/g, ' ')}</Badge>
                ),
              amount: (
                <span className={transaction.direction === 'income' ? 'text--success' : 'text--danger'}>
                  {transaction.direction === 'income' ? '+' : '−'}
                  {fmtMoney(transaction.amountPaisa)}
                </span>
              ),
              actions: (
                <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={transaction.sourceType !== 'manual'}
                    onClick={() => {
                      setEditing(transaction);
                      setDialogOpen(true);
                    }}
                  >
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void voidTransaction(transaction)}>
                    Void
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void deleteTransaction(transaction)}>
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
                title="No entries in this period"
                text="Record income and expenses to build the daybook."
                icon={<BookOpen size={24} />}
              />
            }
          />
          {list.data && list.data.total > 0 ? (
            <div className="pagination">
              <span>
                Page {list.data.page} of {Math.max(1, list.data.pageCount)} · {list.data.total} entry(ies)
              </span>
              <div className="pagination__pages">
                <Button size="sm" disabled={lists.state.page <= 1} onClick={() => lists.patch({ page: lists.state.page - 1 })}>
                  Previous
                </Button>
                <Button
                  size="sm"
                  disabled={lists.state.page >= list.data.pageCount}
                  onClick={() => lists.patch({ page: lists.state.page + 1 })}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}

      {tab === 'summary' ? (
        summary.loading && !summary.data ? (
          <LoadingBlock rows={6} />
        ) : (
          <div className="stack">
            <Card title="By category" padded={false}>
              <DataTable
                columns={[
                  { key: 'category', label: 'Category' },
                  { key: 'direction', label: 'Type' },
                  { key: 'count', label: 'Entries', align: 'right' },
                  { key: 'amount', label: 'Amount', align: 'right' },
                ]}
                rows={(summary.data?.byCategory ?? []).map((entry) => ({
                  category: entry.categoryName,
                  direction: entry.direction === 'income' ? <Badge tone="success">Income</Badge> : <Badge tone="danger">Expense</Badge>,
                  count: String(entry.count),
                  amount: fmtMoney(entry.amountPaisa),
                }))}
                rowKey={(index) => String(summary.data?.byCategory[index]?.categoryId ?? index)}
                empty={<Empty title="Nothing recorded in this period" />}
              />
            </Card>
            <Card title="By month" padded={false}>
              <DataTable
                columns={[
                  { key: 'month', label: 'Month' },
                  { key: 'income', label: 'Income', align: 'right' },
                  { key: 'expense', label: 'Expense', align: 'right' },
                  { key: 'net', label: 'Net', align: 'right' },
                ]}
                rows={(summary.data?.byMonth ?? []).map((entry) => ({
                  month: entry.month,
                  income: fmtMoney(entry.incomePaisa),
                  expense: fmtMoney(entry.expensePaisa),
                  net: fmtMoney(entry.netPaisa),
                }))}
                rowKey={(index) => String(summary.data?.byMonth[index]?.month ?? index)}
                empty={<Empty title="No monthly history yet" />}
              />
            </Card>
            <Card title="By payment method" padded={false}>
              <DataTable
                columns={[
                  { key: 'method', label: 'Method' },
                  { key: 'amount', label: 'Amount', align: 'right' },
                ]}
                rows={(summary.data?.byMethod ?? []).map((entry) => ({
                  method: entry.methodName || 'Unassigned',
                  amount: fmtMoney(entry.amountPaisa),
                }))}
                rowKey={(index) => String(summary.data?.byMethod[index]?.methodId ?? index)}
                empty={<Empty title="No method breakdown" />}
              />
            </Card>
          </div>
        )
      ) : null}

      {tab === 'daybook' ? (
        <Card
          title="Daybook"
          actions={
            <div className="row" style={{ gap: 8 }}>
              <DateField label="From" value={daybookFrom} onChange={setDaybookFrom} />
              <DateField label="To" value={daybookTo} onChange={setDaybookTo} />
            </div>
          }
          padded={false}
        >
          <DataTable
            columns={[
              { key: 'date', label: 'Date' },
              { key: 'entries', label: 'Entries', align: 'right' },
              { key: 'opening', label: 'Opening', align: 'right' },
              { key: 'income', label: 'Income', align: 'right' },
              { key: 'expense', label: 'Expense', align: 'right' },
              { key: 'closing', label: 'Closing', align: 'right' },
            ]}
            rows={(daybook.data ?? []).map((row) => ({
              date: fmtDate(row.date),
              entries: String(row.entries),
              opening: fmtMoney(row.openingPaisa),
              income: fmtMoney(row.incomePaisa),
              expense: fmtMoney(row.expensePaisa),
              closing: fmtMoney(row.closingPaisa),
            }))}
            loading={daybook.loading && !daybook.data}
            rowKey={(index) => String(daybook.data?.[index]?.date ?? index)}
            empty={<Empty title="No activity in this range" />}
          />
        </Card>
      ) : null}

      {tab === 'periods' ? (
        <Card padded={false}>
          <DataTable
            columns={[
              { key: 'label', label: 'Period' },
              { key: 'range', label: 'Range' },
              { key: 'income', label: 'Income', align: 'right' },
              { key: 'expense', label: 'Expense', align: 'right' },
              { key: 'closed', label: 'Closed by' },
              { key: 'state', label: 'State' },
              { key: 'actions', label: '', align: 'right' },
            ]}
            rows={(periods.data ?? []).map((period) => ({
              label: period.label,
              range: `${fmtDate(period.periodStart)} – ${fmtDate(period.periodEnd)}`,
              income: fmtMoney(period.incomePaisa),
              expense: fmtMoney(period.expensePaisa),
              closed: period.closedByName ? `${period.closedByName} · ${fmtDate(period.closedAt?.slice(0, 10))}` : '—',
              state: period.isClosed ? <StatusBadge status="closed" label="Closed" /> : <StatusBadge status="open" label="Open" />,
              actions: period.isClosed ? (
                <Button size="sm" variant="ghost" onClick={() => void reopenPeriod(period)}>
                  Reopen
                </Button>
              ) : null,
            }))}
            loading={periods.loading && !periods.data}
            rowKey={(index) => String(periods.data?.[index]?.id ?? index)}
            empty={<Empty title="No closed periods" text="Close a month once its numbers are final." />}
          />
        </Card>
      ) : null}

      {tab === 'categories' ? (
        <ResourceManager
          resource="accounting-categories"
          title="Accounting categories"
          description="Every entry is filed under one of these; income and expense categories are separate."
          emptyText="No categories yet."
          columns={[
            { key: 'name', label: 'Category' },
            { key: 'direction', label: 'Type', render: (row) => (row['direction'] === 'income' ? 'Income' : 'Expense') },
            { key: 'usageCount', label: 'Used', align: 'right', render: (row) => String(num(row['usageCount'])) },
            {
              key: 'isActive',
              label: 'State',
              render: (row) => (row['isActive'] === false ? <Badge>Inactive</Badge> : <Badge tone="success">Active</Badge>),
            },
          ]}
          fields={[
            { key: 'name', label: 'Name', type: 'text', required: true },
            {
              key: 'direction',
              label: 'Type',
              type: 'select',
              required: true,
              defaultValue: 'expense',
              options: ACCOUNTING_DIRECTIONS.map((option) => ({ value: option.value, label: option.label })),
            },
            { key: 'isActive', label: 'Active', type: 'switch', defaultValue: true },
          ]}
        />
      ) : null}

      <TransactionDialog
        open={dialogOpen}
        transaction={editing}
        direction={direction}
        onClose={() => setDialogOpen(false)}
        onSaved={() => {
          list.reload();
          summary.reload();
          daybook.reload();
        }}
      />
      <ClosePeriodDialog open={closeOpen} onClose={() => setCloseOpen(false)} onSaved={() => periods.reload()} />
    </Page>
  );
}
