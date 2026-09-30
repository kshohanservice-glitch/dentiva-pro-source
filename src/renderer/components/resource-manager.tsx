/**
 * Generic master-data manager.
 *
 * Eleven reference lists (treatments, medications, clinical options, payment
 * methods, suppliers, …) share the same shape, so they share the same screen:
 * a searchable, paged table with a create/edit dialog and a guarded delete.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { ResourceName } from '@shared/api';
import type { ListQuery, Paged } from '@shared/types';
import { useAction, useApi, useApp } from '@renderer/state/store';
import { bridge } from '@renderer/lib/bridge';
import { fmtMoney } from '@renderer/lib/format';
import { Button, Empty, Field, Input, Modal, Page, SearchInput, Select, Switch, TextArea } from './ui';
import { DataTable, PagedFooter, TextField, useListState } from './forms';

export type FieldType = 'text' | 'textarea' | 'money' | 'number' | 'switch' | 'select' | 'colour';

export interface FieldSpec {
  readonly key: string;
  readonly label: string;
  readonly type: FieldType;
  readonly required?: boolean;
  readonly hint?: string;
  readonly options?: ReadonlyArray<{ value: string; label: string }>;
  readonly defaultValue?: unknown;
}

export interface ColumnSpec {
  readonly key: string;
  readonly label: string;
  readonly align?: 'left' | 'right' | 'center';
  readonly render?: (row: Record<string, unknown>) => ReactNode;
}

export function ResourceManager({
  resource,
  title,
  description,
  columns,
  fields,
  emptyText,
  includeInactive = false,
  onChanged,
}: {
  resource: ResourceName;
  title: string;
  description?: string;
  columns: readonly ColumnSpec[];
  fields: readonly FieldSpec[];
  emptyText: string;
  includeInactive?: boolean;
  onChanged?(): void;
}): JSX.Element {
  const { toast, confirm } = useApp();
  const { run, busy } = useAction();
  const lists = useListState();
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [showInactive, setShowInactive] = useState(includeInactive);

  const list = useApi(
    'resource.list',
    {
      resource,
      includeInactive: showInactive,
      query: { page: lists.state.page, pageSize: 25, search: lists.state.search || undefined } as ListQuery,
    },
    [resource, lists.state.page, lists.state.search, showInactive],
  );
  const items = (list.data?.items ?? []) as unknown as Array<Record<string, unknown>>;

  const blank = (): Record<string, unknown> => {
    const draft: Record<string, unknown> = {};
    for (const field of fields) draft[field.key] = field.defaultValue ?? (field.type === 'switch' ? true : field.type === 'number' || field.type === 'money' ? 0 : '');
    return draft;
  };

  const save = async () => {
    if (!editing) return;
    const id = typeof editing['id'] === 'number' ? (editing['id'] as number) : null;
    const payload: Record<string, unknown> = {};
    for (const field of fields) payload[field.key] = editing[field.key] ?? null;
    const saved = await run(
      () => bridge.invoke('resource.save', { resource, id, input: payload }),
      { success: id ? 'Saved.' : 'Created.', failure: 'The record could not be saved.' },
    );
    if (saved) {
      setEditing(null);
      list.reload();
      onChanged?.();
    }
  };

  const remove = async (row: Record<string, unknown>) => {
    const id = Number(row['id']);
    const usage = Number(row['usageCount'] ?? 0);
    const answer = await confirm({
      title: `Delete “${String(row['name'] ?? row['label'] ?? row['code'] ?? id)}”`,
      description:
        usage > 0
          ? `This entry has been used ${usage} time(s). It will be deactivated so history stays readable.`
          : 'The entry is removed from the active list.',
      confirmLabel: 'Delete',
      tone: 'danger',
      reason: true,
    });
    if (!answer.ok) return;
    const done = await run(
      () => bridge.invoke('resource.delete', { resource, id, options: { reason: answer.reason } }),
      { success: 'Deleted.', failure: 'The record could not be deleted.' },
    );
    if (done !== null) {
      list.reload();
      onChanged?.();
    }
  };

  const restore = async (row: Record<string, unknown>) => {
    const done = await run(() => bridge.invoke('resource.restore', { resource, id: Number(row['id']) }), {
      success: 'Restored.',
    });
    if (done !== null) list.reload();
  };

  return (
    <Page
      title={title}
      description={description}
      actions={
        <>
          <Switch label="Show inactive" checked={showInactive} onChange={setShowInactive} />
          <Button
            variant="primary"
            icon={<Plus size={15} />}
            onClick={() => setEditing(blank())}
          >
            New
          </Button>
        </>
      }
    >
      <div className="filters">
        <div style={{ minWidth: 280 }}>
          <SearchInput
            value={lists.state.search}
            onChange={(value) => lists.patch({ search: value })}
            placeholder="Search…"
          />
        </div>
      </div>

      <div className="card">
        <DataTable
          columns={columns.map((column) => ({ key: column.key, label: column.label, align: column.align }))}
          rows={items.map((row) => {
            const rendered: Record<string, ReactNode> = {};
            for (const column of columns) {
              rendered[column.key] = column.render ? column.render(row) : ((row[column.key] as ReactNode) ?? '—');
            }
            rendered['actions'] = (
              <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                <Button size="sm" variant="ghost" aria-label="Edit" onClick={() => setEditing({ ...row })}>
                  <Pencil size={14} />
                </Button>
                {row['isActive'] === false ? (
                  <Button size="sm" variant="ghost" aria-label="Restore" onClick={() => void restore(row)}>
                    <RotateCcw size={14} />
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" aria-label="Delete" onClick={() => void remove(row)}>
                    <Trash2 size={14} />
                  </Button>
                )}
              </div>
            );
            return rendered;
          })}
          loading={list.loading && !list.data}
          error={list.error}
          onRetry={list.reload}
          rowKey={(index) => String(items[index]?.['id'] ?? index)}
          empty={<Empty title={emptyText} />}
        />
        <PagedFooter page={lists.state.page} onPage={(page) => lists.patch({ page })} data={list.data as Paged<never> | null} />
      </div>

      <Modal
        open={editing !== null}
        title={`${typeof editing?.['id'] === 'number' ? 'Edit' : 'New'} ${title.toLowerCase().replace(/s$/, '')}`}
        onClose={() => setEditing(null)}
        footer={
          <div className="row row--end">
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              Save
            </Button>
          </div>
        }
      >
        {editing ? (
          <div className="stack">
            {fields.map((field) => {
              const value = editing[field.key];
              if (field.type === 'switch') {
                return (
                  <Switch
                    key={field.key}
                    label={field.label}
                    checked={Boolean(value)}
                    onChange={(next) => setEditing({ ...editing, [field.key]: next })}
                  />
                );
              }
              if (field.type === 'select') {
                return (
                  <Field key={field.key} label={field.label} required={field.required} hint={field.hint}>
                    <Select
                      value={value === null || value === undefined ? '' : String(value)}
                      placeholder={field.required ? undefined : 'None'}
                      options={field.options ?? []}
                      onChange={(event) =>
                        setEditing({
                          ...editing,
                          [field.key]: event.target.value === '' ? null : Number.isNaN(Number(event.target.value)) ? event.target.value : (field.defaultValue !== undefined && typeof field.defaultValue === 'number' ? Number(event.target.value) : event.target.value),
                        })
                      }
                    />
                  </Field>
                );
              }
              if (field.type === 'textarea') {
                return (
                  <Field key={field.key} label={field.label} hint={field.hint}>
                    <TextArea
                      rows={3}
                      value={String(value ?? '')}
                      onChange={(event) => setEditing({ ...editing, [field.key]: event.target.value })}
                    />
                  </Field>
                );
              }
              if (field.type === 'money') {
                const paisa = Number(value ?? 0);
                return (
                  <Field key={field.key} label={field.label} required={field.required} hint={field.hint ?? 'Amount in BDT'}>
                    <Input
                      className="input--money"
                      inputMode="decimal"
                      value={paisa ? String(paisa / 100) : ''}
                      onChange={(event) => {
                        const parsed = Number(event.target.value);
                        setEditing({ ...editing, [field.key]: Number.isFinite(parsed) ? Math.round(parsed * 100) : 0 });
                      }}
                    />
                  </Field>
                );
              }
              if (field.type === 'number') {
                return (
                  <Field key={field.key} label={field.label} required={field.required} hint={field.hint}>
                    <Input
                      className="input--numeric"
                      inputMode="numeric"
                      value={String(value ?? 0)}
                      onChange={(event) => setEditing({ ...editing, [field.key]: Number(event.target.value) || 0 })}
                    />
                  </Field>
                );
              }
              return (
                <TextField
                  key={field.key}
                  label={field.label}
                  required={field.required}
                  hint={field.hint}
                  value={String(value ?? '')}
                  onChange={(next) => setEditing({ ...editing, [field.key]: next })}
                />
              );
            })}
            <div className="small muted">
              Amounts are stored in paisa and printed with the ৳ symbol, so {fmtMoney(150000)} is entered as 1500.
            </div>
          </div>
        ) : null}
      </Modal>
    </Page>
  );
}

/** Small helper for the many two-column master-data tables. */
export function useResourceOptions(resource: ResourceName): Array<{ value: number; label: string; meta?: string }> {
  const options = useApi('resource.options', { resource });
  return options.data ?? [];
}

export function OptionSelect({
  label,
  resource,
  value,
  onChange,
  allowEmpty = true,
}: {
  label: string;
  resource: ResourceName;
  value: number | null;
  onChange(value: number | null): void;
  allowEmpty?: boolean;
}): JSX.Element {
  const [options, setOptions] = useState<Array<{ value: number; label: string; meta?: string }>>([]);
  const loaded = useApi('resource.options', { resource });
  useEffect(() => {
    setOptions(loaded.data ?? []);
  }, [loaded.data]);
  return (
    <Field label={label}>
      <Select
        value={value === null ? '' : String(value)}
        placeholder={allowEmpty ? 'None' : undefined}
        options={options.map((option) => ({
          value: String(option.value),
          label: option.meta ? `${option.label} · ${option.meta}` : option.label,
        }))}
        onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}
      />
    </Field>
  );
}
