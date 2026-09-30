/**
 * Inventory: items, batches/expiry, purchases, movements and alerts.
 *
 * Quantities are stored in thousandths of a unit (milli) so that half a
 * cartridge or 250 ml can be recorded exactly.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Boxes, Package, Plus, Truck } from 'lucide-react';
import {
  INVENTORY_UNITS,
  STOCK_DECREASE_TYPES,
  STOCK_INCREASE_TYPES,
  STOCK_MOVEMENT_LABELS,
  STOCK_MOVEMENT_TYPES,
} from '@shared/constants';
import type { StockMovementType } from '@shared/constants';
import { todayIso } from '@shared/dates';
import type { InventoryAlerts, InventoryItem, InventoryItemInput, InventoryPurchase, StockMovement } from '@shared/types';
import { useAction, useApi, useApp } from '@renderer/state/store';
import { bridge } from '@renderer/lib/bridge';
import { fmtDate, fmtMoney, fmtQuantity, titleCase } from '@renderer/lib/format';
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
  Tabs,
  TextArea,
} from '@renderer/components/ui';
import { DataTable, DateField, MoneyField, QuantityField, TextField, useListState } from '@renderer/components/forms';
import { OptionSelect, ResourceManager } from '@renderer/components/resource-manager';

const TABS = [
  { key: 'items', label: 'Items' },
  { key: 'movements', label: 'Movements' },
  { key: 'purchases', label: 'Purchases' },
  { key: 'alerts', label: 'Alerts' },
  { key: 'categories', label: 'Categories' },
  { key: 'suppliers', label: 'Suppliers' },
];

function ItemDialog({
  open,
  item,
  onClose,
  onSaved,
}: {
  open: boolean;
  item: InventoryItem | null;
  onClose(): void;
  onSaved(): void;
}): JSX.Element | null {
  const { run, busy } = useAction();
  const [form, setForm] = useState<InventoryItemInput>({
    code: '',
    name: '',
    categoryId: null,
    supplierId: null,
    unit: 'piece',
    purchasePricePaisa: 0,
    sellingPricePaisa: null,
    minimumStockMilli: 0,
    reorderLevelMilli: 0,
    batchNumber: '',
    expiryDate: null,
    purchaseDate: todayIso(),
    storageLocation: '',
    notes: '',
    isActive: true,
  });
  const [stockMilli, setStockMilli] = useState(0);

  useEffect(() => {
    if (item) {
      setForm({
        code: item.code,
        name: item.name,
        categoryId: item.categoryId,
        supplierId: item.supplierId,
        unit: item.unit,
        purchasePricePaisa: item.purchasePricePaisa,
        sellingPricePaisa: item.sellingPricePaisa,
        minimumStockMilli: item.minimumStockMilli,
        reorderLevelMilli: item.reorderLevelMilli,
        batchNumber: item.batchNumber,
        expiryDate: item.expiryDate,
        purchaseDate: item.purchaseDate,
        storageLocation: item.storageLocation,
        notes: item.notes,
        isActive: item.isActive,
      });
    }
  }, [item]);

  const patch = (value: Partial<InventoryItemInput>) => setForm((current) => ({ ...current, ...value }));

  if (!open) return null;

  return (
    <Modal
      open
      width="wide"
      title={item ? `Edit ${item.name}` : 'New inventory item'}
      onClose={onClose}
      footer={
        <div className="row row--end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!form.name.trim()}
            onClick={async () => {
              const saved = await run(
                () =>
                  bridge.invoke('inventory.items.save', {
                    id: item?.id ?? null,
                    input: form,
                    openingStockMilli: item ? undefined : stockMilli,
                  }),
                { success: item ? 'Item updated.' : 'Item created.', failure: 'The item could not be saved.' },
              );
              if (saved) {
                onSaved();
                onClose();
              }
            }}
          >
            Save item
          </Button>
        </div>
      }
    >
      <div className="stack">
        <div className="grid-3">
          <TextField label="Item code" value={form.code} onChange={(value) => patch({ code: value })} hint="Leave empty to auto-number" />
          <TextField label="Name" required value={form.name} onChange={(value) => patch({ name: value })} />
          <Field label="Unit">
            <Select
              value={form.unit}
              options={INVENTORY_UNITS.map((unit) => ({ value: unit, label: titleCase(unit) }))}
              onChange={(event) => patch({ unit: event.target.value as InventoryItemInput['unit'] })}
            />
          </Field>
        </div>
        <div className="grid-3">
          <OptionSelect
            label="Category"
            resource="inventory-categories"
            value={form.categoryId}
            onChange={(value) =>
              patch({
                categoryId: value,
              })
            }
          />
          <OptionSelect label="Supplier" resource="suppliers" value={form.supplierId} onChange={(value) => patch({ supplierId: value })} />
          <TextField label="Storage location" value={form.storageLocation} onChange={(value) => patch({ storageLocation: value })} />
        </div>
        <div className="grid-3">
          <MoneyField
            label="Purchase price"
            valuePaisa={form.purchasePricePaisa}
            onChange={(paisa) => patch({ purchasePricePaisa: paisa })}
          />
          <MoneyField
            label="Selling price"
            valuePaisa={form.sellingPricePaisa ?? 0}
            onChange={(paisa) => patch({ sellingPricePaisa: paisa })}
            hint="Optional"
          />
          {!item ? <QuantityField label="Opening stock" valueMilli={stockMilli} onChange={setStockMilli} unit={form.unit} /> : null}
        </div>
        <div className="grid-3">
          <QuantityField
            label="Minimum stock"
            valueMilli={form.minimumStockMilli}
            onChange={(milli) => patch({ minimumStockMilli: milli })}
          />
          <QuantityField
            label="Reorder level"
            valueMilli={form.reorderLevelMilli}
            onChange={(milli) => patch({ reorderLevelMilli: milli })}
          />
          <TextField label="Batch number" value={form.batchNumber} onChange={(value) => patch({ batchNumber: value })} />
        </div>
        <div className="grid-3">
          <DateField label="Expiry date" value={form.expiryDate ?? ''} onChange={(value) => patch({ expiryDate: value || null })} />
          <DateField label="Purchase date" value={form.purchaseDate ?? ''} onChange={(value) => patch({ purchaseDate: value || null })} />
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Switch label="Active" checked={form.isActive} onChange={(value) => patch({ isActive: value })} />
          </div>
        </div>
        <Field label="Notes">
          <TextArea value={form.notes} rows={2} onChange={(event) => patch({ notes: event.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

function MovementDialog({
  open,
  item,
  onClose,
  onSaved,
}: {
  open: boolean;
  item: InventoryItem | null;
  onClose(): void;
  onSaved(): void;
}): JSX.Element | null {
  const { run, busy } = useAction();
  const items = useApi('inventory.items.options', open ? undefined : null);
  const [itemId, setItemId] = useState<number | null>(item?.id ?? null);
  const [type, setType] = useState<StockMovementType>('consumption');
  const [quantityMilli, setQuantityMilli] = useState(0);
  const [unitCostPaisa, setUnitCostPaisa] = useState(item?.purchasePricePaisa ?? 0);
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');

  if (!open) return null;
  const options = items.data ?? [];
  const selected = options.find((option) => option.value === itemId);

  return (
    <Modal
      open
      width="narrow"
      title="Record a stock movement"
      description="Consumption, damage, expiry, returns and corrections are all movements — stock is never edited directly."
      onClose={onClose}
      footer={
        <div className="row row--end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!itemId || quantityMilli <= 0 || reason.trim().length < 3}
            onClick={async () => {
              const saved = await run(
                () =>
                  bridge.invoke('inventory.movements.create', {
                    input: { itemId: itemId!, type, quantityMilli, unitCostPaisa, reason, reference },
                  }),
                { success: 'Stock movement recorded.', failure: 'The movement could not be recorded.' },
              );
              if (saved) {
                onSaved();
                onClose();
              }
            }}
          >
            Record movement
          </Button>
        </div>
      }
    >
      <div className="stack">
        <Field label="Item" required>
          <Select
            value={itemId === null ? '' : String(itemId)}
            placeholder="Choose an item"
            options={options.map((option) => ({ value: String(option.value), label: option.label }))}
            onChange={(event) => setItemId(event.target.value ? Number(event.target.value) : null)}
          />
        </Field>
        {selected ? <div className="small muted">{selected.meta}</div> : null}
        <Field label="Movement type" required>
          <Select
            value={type}
            options={STOCK_MOVEMENT_TYPES.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(event) => setType(event.target.value as StockMovementType)}
          />
        </Field>
        <QuantityField
          label="Quantity"
          valueMilli={quantityMilli}
          onChange={setQuantityMilli}
          hint="Positive number; the sign comes from the movement type"
        />
        <MoneyField
          label="Unit cost"
          valuePaisa={unitCostPaisa}
          onChange={setUnitCostPaisa}
          hint="Used for stock valuation and expense posting"
        />
        <TextField label="Reference" value={reference} onChange={setReference} />
        <Field label="Reason" required hint="Recorded in the audit log">
          <TextArea value={reason} rows={2} onChange={(event) => setReason(event.target.value)} />
        </Field>
        <div className="small muted">
          Increase: {STOCK_INCREASE_TYPES.map((value) => STOCK_MOVEMENT_LABELS[value]).join(', ')} · Decrease:{' '}
          {STOCK_DECREASE_TYPES.map((value) => STOCK_MOVEMENT_LABELS[value]).join(', ')}
        </div>
      </div>
    </Modal>
  );
}

function PurchaseDialog({ open, onClose, onSaved }: { open: boolean; onClose(): void; onSaved(): void }): JSX.Element | null {
  const { run, busy } = useAction();
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [date, setDate] = useState(todayIso());
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [paidPaisa, setPaidPaisa] = useState(0);
  const [discountPaisa, setDiscountPaisa] = useState(0);
  const [recordAsExpense, setRecordAsExpense] = useState(true);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<
    Array<{
      itemId: number | null;
      itemName: string;
      unit: InventoryItem['unit'];
      quantityMilli: number;
      unitPricePaisa: number;
      batchNumber: string;
      expiryDate: string | null;
    }>
  >([{ itemId: null, itemName: '', unit: 'piece', quantityMilli: 0, unitPricePaisa: 0, batchNumber: '', expiryDate: null }]);
  const items = useApi('inventory.items.options', open ? undefined : null);

  if (!open) return null;
  const options = items.data ?? [];

  return (
    <Modal
      open
      width="wide"
      title="Record a purchase"
      description="Receiving stock can be posted to accounting as an expense in the same step."
      onClose={onClose}
      footer={
        <div className="row row--end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={lines.every((line) => line.quantityMilli <= 0)}
            onClick={async () => {
              const saved = await run(
                () =>
                  bridge.invoke('inventory.purchases.create', {
                    input: {
                      supplierId,
                      date,
                      invoiceNumber,
                      paymentMethodId: null,
                      paidPaisa,
                      discountPaisa,
                      notes,
                      recordAsExpense,
                      items: lines.map((line) => ({
                        itemId: line.itemId,
                        itemName: line.itemName,
                        unit: line.unit,
                        quantityMilli: line.quantityMilli,
                        unitPricePaisa: line.unitPricePaisa,
                        batchNumber: line.batchNumber,
                        expiryDate: line.expiryDate,
                      })),
                    },
                  }),
                { success: 'Purchase recorded.', failure: 'The purchase could not be recorded.' },
              );
              if (saved) {
                onSaved();
                onClose();
              }
            }}
          >
            Record purchase
          </Button>
        </div>
      }
    >
      <div className="stack">
        <div className="grid-3">
          <OptionSelect label="Supplier" resource="suppliers" value={supplierId} onChange={setSupplierId} />
          <DateField label="Purchase date" value={date} onChange={setDate} />
          <TextField label="Supplier invoice number" value={invoiceNumber} onChange={setInvoiceNumber} />
        </div>
        <div className="grid-3">
          <MoneyField label="Paid" valuePaisa={paidPaisa} onChange={setPaidPaisa} />
          <MoneyField label="Discount" valuePaisa={discountPaisa} onChange={setDiscountPaisa} />
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Switch label="Post to accounting" checked={recordAsExpense} onChange={setRecordAsExpense} />
          </div>
        </div>

        <Card
          title="Items received"
          actions={
            <Button
              size="sm"
              icon={<Plus size={14} />}
              onClick={() =>
                setLines((current) => [
                  ...current,
                  { itemId: null, itemName: '', unit: 'piece', quantityMilli: 0, unitPricePaisa: 0, batchNumber: '', expiryDate: null },
                ])
              }
            >
              Add line
            </Button>
          }
        >
          <div className="stack stack--sm">
            {lines.map((line, index) => (
              <div key={index} className="grid-4" style={{ alignItems: 'end' }}>
                <Field label="Item">
                  <Select
                    value={line.itemId === null ? '' : String(line.itemId)}
                    placeholder="Choose an item"
                    options={options.map((option) => ({ value: String(option.value), label: option.label }))}
                    onChange={(event) => {
                      const next = [...lines];
                      const id = event.target.value ? Number(event.target.value) : null;
                      const chosen = options.find((option) => option.value === id);
                      next[index] = { ...line, itemId: id, itemName: chosen?.label ?? line.itemName };
                      setLines(next);
                    }}
                  />
                </Field>
                <QuantityField
                  label="Quantity"
                  valueMilli={line.quantityMilli}
                  onChange={(milli) => {
                    const next = [...lines];
                    next[index] = { ...line, quantityMilli: milli };
                    setLines(next);
                  }}
                />
                <MoneyField
                  label="Unit price"
                  valuePaisa={line.unitPricePaisa}
                  onChange={(paisa) => {
                    const next = [...lines];
                    next[index] = { ...line, unitPricePaisa: paisa };
                    setLines(next);
                  }}
                />
                <TextField
                  label="Batch"
                  value={line.batchNumber}
                  onChange={(value) => {
                    const next = [...lines];
                    next[index] = { ...line, batchNumber: value };
                    setLines(next);
                  }}
                />
              </div>
            ))}
          </div>
        </Card>

        <Field label="Notes">
          <TextArea value={notes} rows={2} onChange={(event) => setNotes(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export function InventoryScreen(): JSX.Element {
  const { confirm } = useApp();
  const lists = useListState();
  const [tab, setTab] = useState('items');
  const [dialogItem, setDialogItem] = useState<InventoryItem | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [movementItem, setMovementItem] = useState<InventoryItem | null>(null);
  const [movementOpen, setMovementOpen] = useState(false);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const { run } = useAction();

  const items = useApi(
    'inventory.items.list',
    { ...lists.state, search: lists.state.search || undefined, lowStockOnly: lowStockOnly || undefined },
    [tab === 'items', lists.state.page, lists.state.search, lowStockOnly],
  );
  const movements = useApi('inventory.movements.list', tab === 'movements' ? lists.state : null, [
    tab,
    lists.state.page,
    lists.state.search,
  ]);
  const purchases = useApi('inventory.purchases.list', tab === 'purchases' ? lists.state : null, [tab, lists.state.page]);
  const alerts = useApi('inventory.alerts', undefined);
  const stats = useApi('inventory.statistics', { preset: 'this_year' }, [tab]);

  const removeItem = async (item: InventoryItem) => {
    const answer = await confirm({
      title: `Remove ${item.name}`,
      description: 'Items with movement history are deactivated so the ledger stays readable.',
      confirmLabel: 'Remove item',
      tone: 'danger',
      reason: true,
    });
    if (!answer.ok || !answer.reason) return;
    await run(() => bridge.invoke('inventory.items.delete', { id: item.id, reason: answer.reason!, confirmText: item.code }), {
      success: 'Item removed.',
    });
    items.reload();
  };

  const rowActions = (item: InventoryItem) => (
    <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setMovementItem(item);
          setMovementOpen(true);
        }}
      >
        Stock
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setDialogItem(item);
          setDialogOpen(true);
        }}
      >
        Edit
      </Button>
      <Button size="sm" variant="ghost" onClick={() => void removeItem(item)}>
        Remove
      </Button>
    </div>
  );

  return (
    <Page
      title="Inventory"
      description="Stock, batches, expiry and supplier purchases"
      actions={
        <>
          <Button icon={<Truck size={15} />} onClick={() => setPurchaseOpen(true)}>
            Record purchase
          </Button>
          <Button
            icon={<Plus size={15} />}
            variant="primary"
            onClick={() => {
              setDialogItem(null);
              setDialogOpen(true);
            }}
          >
            New item
          </Button>
        </>
      }
    >
      <div className="stat-grid">
        <Stat label="Stock value" value={fmtMoney(stats.data?.stockValuePaisa ?? 0)} />
        <Stat label="Items" value={String(stats.data?.itemCount ?? 0)} icon={<Boxes size={16} />} />
        <Stat label="Low stock" value={String(stats.data?.lowStockCount ?? 0)} tone={stats.data?.lowStockCount ? 'warning' : 'default'} />
        <Stat
          label="Expiring soon"
          value={String(stats.data?.expiringSoonCount ?? 0)}
          tone={stats.data?.expiringSoonCount ? 'warning' : 'default'}
        />
        <Stat label="Expired" value={String(stats.data?.expiredCount ?? 0)} tone={stats.data?.expiredCount ? 'danger' : 'default'} />
        <Stat label="Purchases this year" value={fmtMoney(stats.data?.purchaseTotalPaisa ?? 0)} />
      </div>

      <Tabs
        tabs={[
          ...TABS.slice(0, 1),
          { key: 'movements', label: 'Movements' },
          ...TABS.slice(2, 4),
          {
            key: 'alerts',
            label: 'Alerts',
            count: (alerts.data?.lowStock.length ?? 0) + (alerts.data?.expired.length ?? 0) + (alerts.data?.expiringSoon.length ?? 0),
          },
          ...TABS.slice(4),
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'items' ? (
        <Card padded={false}>
          <div className="row" style={{ padding: 'var(--space-4)', gap: 10 }}>
            <div style={{ minWidth: 260, flex: 1 }}>
              <SearchInput
                value={lists.state.search}
                placeholder="Search by name or code…"
                onChange={(value) =>
                  lists.patch({
                    search: value,
                  })
                }
              />
            </div>
            <Switch label="Low stock only" checked={lowStockOnly} onChange={setLowStockOnly} />
          </div>
          <DataTable
            columns={[
              { key: 'code', label: 'Code' },
              { key: 'name', label: 'Item' },
              { key: 'stock', label: 'Stock', align: 'right' },
              { key: 'min', label: 'Minimum', align: 'right' },
              { key: 'expiry', label: 'Expiry' },
              { key: 'value', label: 'Value', align: 'right' },
              { key: 'state', label: 'State' },
              { key: 'actions', label: '', align: 'right' },
            ]}
            rows={(items.data?.items ?? []).map((item) => ({
              code: <span className="mono small">{item.code}</span>,
              name: (
                <div>
                  <div>{item.name}</div>
                  <div className="small muted">
                    {item.categoryName || 'Uncategorised'}
                    {item.supplierName ? ` · ${item.supplierName}` : ''}
                  </div>
                </div>
              ),
              stock: fmtQuantity(item.currentStockMilli, item.unit),
              min: fmtQuantity(item.minimumStockMilli, item.unit),
              expiry: item.expiryDate ? fmtDate(item.expiryDate) : '—',
              value: fmtMoney(item.stockValuePaisa),
              state: item.isExpired ? (
                <StatusBadge status="expired" />
              ) : item.isLowStock ? (
                <StatusBadge status="low" label="Low" />
              ) : item.isExpiringSoon ? (
                <StatusBadge status="expiring" label="Expiring" />
              ) : (
                <StatusBadge status="active" label="OK" />
              ),
              actions: rowActions(item),
            }))}
            loading={items.loading && !items.data}
            error={items.error}
            onRetry={items.reload}
            rowKey={(index) => String(items.data?.items[index]?.id ?? index)}
            empty={
              <Empty title="No inventory items" text="Add the materials and medicines you keep in stock." icon={<Package size={24} />} />
            }
          />
        </Card>
      ) : null}

      {tab === 'movements' ? (
        <Card padded={false}>
          <div className="row" style={{ padding: 'var(--space-4)' }}>
            <div style={{ minWidth: 260, flex: 1 }}>
              <SearchInput
                value={lists.state.search}
                placeholder="Search movements…"
                onChange={(value) =>
                  lists.patch({
                    search: value,
                  })
                }
              />
            </div>
          </div>
          <DataTable
            columns={[
              { key: 'date', label: 'Date' },
              { key: 'item', label: 'Item' },
              { key: 'type', label: 'Type' },
              { key: 'quantity', label: 'Quantity', align: 'right' },
              { key: 'balance', label: 'Balance', align: 'right' },
              { key: 'reason', label: 'Reason' },
              { key: 'by', label: 'Recorded by' },
            ]}
            rows={(movements.data?.items ?? []).map((movement: StockMovement) => ({
              date: fmtDate(movement.movedDate),
              item: movement.itemName,
              type: <Badge tone={movement.signedQuantityMilli >= 0 ? 'success' : 'warning'}>{STOCK_MOVEMENT_LABELS[movement.type]}</Badge>,
              quantity: movement.quantityText,
              balance: fmtQuantity(movement.balanceAfterMilli),
              reason: movement.reason || '—',
              by: movement.movedByName,
            }))}
            loading={movements.loading && !movements.data}
            error={movements.error}
            onRetry={movements.reload}
            rowKey={(index) => String(movements.data?.items[index]?.id ?? index)}
            empty={<Empty title="No stock movements" />}
          />
        </Card>
      ) : null}

      {tab === 'purchases' ? (
        <Card padded={false}>
          <DataTable
            columns={[
              { key: 'reference', label: 'Reference' },
              { key: 'date', label: 'Date' },
              { key: 'supplier', label: 'Supplier' },
              { key: 'items', label: 'Items', align: 'right' },
              { key: 'total', label: 'Total', align: 'right' },
              { key: 'paid', label: 'Paid', align: 'right' },
              { key: 'by', label: 'Recorded by' },
            ]}
            rows={(purchases.data?.items ?? []).map((purchase: InventoryPurchase) => ({
              reference: <span className="mono small">{purchase.reference}</span>,
              date: fmtDate(purchase.date),
              supplier: purchase.supplierName || '—',
              items: String(purchase.itemCount),
              total: fmtMoney(purchase.totalPaisa),
              paid: fmtMoney(purchase.paidPaisa),
              by: purchase.createdByName,
            }))}
            loading={purchases.loading && !purchases.data}
            error={purchases.error}
            onRetry={purchases.reload}
            rowKey={(index) => String(purchases.data?.items[index]?.id ?? index)}
            empty={<Empty title="No purchases recorded" text="Receiving stock creates the batch, expiry and movement records together." />}
          />
        </Card>
      ) : null}

      {tab === 'alerts' ? <AlertsPanel alerts={alerts.data} loading={alerts.loading} onRefresh={alerts.reload} /> : null}

      {tab === 'categories' ? (
        <ResourceManager
          resource="inventory-categories"
          title="Inventory categories"
          emptyText="No categories yet."
          columns={[
            { key: 'name', label: 'Category' },
            { key: 'description', label: 'Description' },
          ]}
          fields={[
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'description', label: 'Description', type: 'textarea' },
          ]}
        />
      ) : null}

      {tab === 'suppliers' ? (
        <ResourceManager
          resource="suppliers"
          title="Suppliers"
          emptyText="No suppliers yet."
          columns={[
            { key: 'name', label: 'Supplier' },
            { key: 'contactPerson', label: 'Contact' },
            { key: 'phone', label: 'Phone' },
            { key: 'email', label: 'Email' },
          ]}
          fields={[
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'contactPerson', label: 'Contact person', type: 'text' },
            { key: 'phone', label: 'Phone', type: 'text' },
            { key: 'email', label: 'Email', type: 'text' },
            { key: 'address', label: 'Address', type: 'textarea' },
            { key: 'notes', label: 'Notes', type: 'textarea' },
            { key: 'isActive', label: 'Active', type: 'switch', defaultValue: true },
          ]}
        />
      ) : null}

      <ItemDialog open={dialogOpen} item={dialogItem} onClose={() => setDialogOpen(false)} onSaved={() => items.reload()} />
      <MovementDialog
        open={movementOpen}
        item={movementItem}
        onClose={() => setMovementOpen(false)}
        onSaved={() => {
          items.reload();
          movements.reload();
          alerts.reload();
        }}
      />
      <PurchaseDialog
        open={purchaseOpen}
        onClose={() => setPurchaseOpen(false)}
        onSaved={() => {
          purchases.reload();
          items.reload();
        }}
      />
    </Page>
  );
}

function AlertsPanel({ alerts, loading, onRefresh }: { alerts: InventoryAlerts | null; loading: boolean; onRefresh(): void }): JSX.Element {
  if (loading && !alerts) return <LoadingBlock rows={5} />;
  const groups: Array<{ title: string; items: readonly InventoryItem[]; tone: 'danger' | 'warning' | 'info' }> = [
    { title: 'Expired', items: alerts?.expired ?? [], tone: 'danger' },
    { title: 'Expiring soon', items: alerts?.expiringSoon ?? [], tone: 'warning' },
    { title: 'Low stock', items: alerts?.lowStock ?? [], tone: 'info' },
  ];
  if (groups.every((group) => group.items.length === 0)) {
    return <Empty title="No stock alerts" text="Nothing is expired, expiring or below its minimum." icon={<AlertTriangle size={24} />} />;
  }
  return (
    <div className="stack">
      {groups.map((group) =>
        group.items.length === 0 ? null : (
          <Card
            key={group.title}
            title={`${group.title} (${group.items.length})`}
            actions={
              <Button size="sm" onClick={onRefresh}>
                Refresh
              </Button>
            }
            padded={false}
          >
            <DataTable
              columns={[
                { key: 'code', label: 'Code' },
                { key: 'name', label: 'Item' },
                { key: 'stock', label: 'Stock', align: 'right' },
                { key: 'expiry', label: 'Expiry' },
                { key: 'location', label: 'Location' },
              ]}
              rows={group.items.map((item) => ({
                code: <span className="mono small">{item.code}</span>,
                name: item.name,
                stock: fmtQuantity(item.currentStockMilli, item.unit),
                expiry: item.expiryDate ? fmtDate(item.expiryDate) : '—',
                location: item.storageLocation || '—',
              }))}
              rowKey={(index) => String(group.items[index]?.id ?? index)}
              empty={<Empty title="Nothing here" />}
            />
          </Card>
        ),
      )}
    </div>
  );
}
