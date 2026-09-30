/**
 * Form building blocks shared by every screen: pickers, money fields and the
 * list chrome (toolbar + table + pagination) so that every list screen looks
 * and behaves the same.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CalendarDays } from 'lucide-react';
import { parseMoney } from '@shared/money';
import { DATE_RANGE_PRESETS } from '@shared/dates';
import type { Paged, PatientSummary, Dentist } from '@shared/types';
import { useApi } from '@renderer/state/store';
import { fmtMoney, fmtQuantity } from '@renderer/lib/format';
import { Button, Empty, ErrorState, Field, Input, LoadingBlock, Pagination, SearchInput, Select } from './ui';

export const RANGE_PRESET_LABELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'All time' },
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last_7_days', label: 'Last 7 days' },
  { value: 'last_30_days', label: 'Last 30 days' },
  { value: 'last_90_days', label: 'Last 90 days' },
  { value: 'this_week', label: 'This week' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'this_year', label: 'This year' },
];

export function rangePresetOptions(): ReadonlyArray<{ value: string; label: string }> {
  // Presets come from the shared contract so the UI can never drift from what
  // the core accepts.
  const known = new Set(DATE_RANGE_PRESETS as readonly string[]);
  return RANGE_PRESET_LABELS.filter((option) => option.value === '' || known.has(option.value));
}

// ---------------------------------------------------------------------------
// Field factories
// ---------------------------------------------------------------------------

export function DateField({
  label,
  value,
  onChange,
  required = false,
  hint,
  error,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  required?: boolean;
  hint?: string;
  error?: string;
}): JSX.Element {
  return (
    <Field label={label} required={required} hint={hint} error={error}>
      <Input type="date" value={value ?? ''} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

export function MoneyField({
  label,
  valuePaisa,
  onChange,
  hint,
  error,
  required = false,
}: {
  label: string;
  valuePaisa: number;
  onChange(paisa: number): void;
  hint?: string;
  error?: string;
  required?: boolean;
}): JSX.Element {
  const [text, setText] = useState(() => (valuePaisa ? String(valuePaisa / 100) : ''));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setText(valuePaisa ? String(valuePaisa / 100) : '');
  }, [valuePaisa]);

  return (
    <Field
      label={label}
      required={required}
      hint={hint ?? 'Amount in BDT, e.g. 1500.50'}
      error={error ?? (invalid ? 'Enter a valid amount.' : undefined)}
    >
      <Input
        className="input--money"
        inputMode="decimal"
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          const parsed = parseMoney(next, { allowEmpty: true });
          setInvalid(!parsed.ok);
          if (parsed.ok) onChange(parsed.paisa);
        }}
      />
    </Field>
  );
}

export function QuantityField({
  label,
  valueMilli,
  onChange,
  unit = '',
  hint,
}: {
  label: string;
  valueMilli: number;
  onChange(milli: number): void;
  unit?: string;
  hint?: string;
}): JSX.Element {
  const [text, setText] = useState(() => (valueMilli ? String(valueMilli / 1000) : ''));
  useEffect(() => {
    setText(valueMilli ? String(valueMilli / 1000) : '');
  }, [valueMilli]);
  return (
    <Field label={label} hint={hint ?? (unit ? `Quantity in ${unit}` : 'Quantity')}>
      <Input
        className="input--numeric"
        inputMode="decimal"
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          const parsed = Number(next);
          if (Number.isFinite(parsed)) onChange(Math.round(parsed * 1000));
        }}
      />
    </Field>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  error,
  required = false,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  type?: 'text' | 'email' | 'tel' | 'password';
}): JSX.Element {
  return (
    <Field label={label} required={required} hint={hint} error={error}>
      <Input type={type} value={value ?? ''} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

export function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange,
  placeholder,
  required = false,
  hint,
  error,
}: {
  label: string;
  value: T | '' | null;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange(value: T): void;
  placeholder?: string;
  required?: boolean;
  hint?: string;
  error?: string;
}): JSX.Element {
  return (
    <Field label={label} required={required} hint={hint} error={error}>
      <Select
        value={value === null ? '' : String(value)}
        placeholder={placeholder}
        options={options.map((option) => ({ value: String(option.value), label: option.label }))}
        onChange={(event) => {
          const selected = options.find((option) => String(option.value) === event.target.value);
          if (selected) onChange(selected.value);
        }}
      />
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Entity pickers
// ---------------------------------------------------------------------------

export function DentistSelect({
  label = 'Dentist',
  value,
  onChange,
  allowEmpty = true,
}: {
  label?: string;
  value: number | null;
  onChange(value: number | null): void;
  allowEmpty?: boolean;
}): JSX.Element | null {
  const dentists = useApi('dentists.list', { includeInactive: false });
  const list: readonly Dentist[] = dentists.data ?? [];
  if (list.length === 0) return null;
  return (
    <SelectField
      label={label}
      value={value}
      placeholder={allowEmpty ? 'Not assigned' : undefined}
      options={list.map((dentist) => ({
        value: dentist.id,
        label: dentist.isDefault ? `${dentist.name} (default)` : dentist.name,
      }))}
      onChange={(selected) => onChange(selected === ('' as unknown as number) ? null : selected)}
    />
  );
}

export function PatientPicker({
  value,
  onChange,
  label = 'Patient',
  required = true,
  autoFocus = false,
}: {
  value: PatientSummary | null;
  onChange(patient: PatientSummary | null): void;
  label?: string;
  required?: boolean;
  autoFocus?: boolean;
}): JSX.Element {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(autoFocus);
  const results = useApi('patients.quickSearch', term.trim().length >= 2 ? { query: term.trim(), limit: 8 } : null);

  return (
    <Field label={label} required={required} hint={value ? `${value.code} · ${value.phone}` : 'Search by name, code or phone'}>
      {value ? (
        <div className="row row--between">
          <span>
            {value.name} <span className="mono small">({value.code})</span>
          </span>
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            Change
          </Button>
        </div>
      ) : (
        <>
          <SearchInput
            value={term}
            autoFocus={autoFocus}
            placeholder="Start typing a name, code or phone…"
            onChange={(next) => {
              setTerm(next);
              setOpen(true);
            }}
          />
          {open && term.trim().length >= 2 ? (
            <div className="menu" style={{ marginTop: 6 }}>
              {results.loading ? (
                <div className="small muted" style={{ padding: 8 }}>
                  Searching…
                </div>
              ) : (results.data ?? []).length === 0 ? (
                <div className="small muted" style={{ padding: 8 }}>
                  No patient matched “{term}”.
                </div>
              ) : (
                (results.data ?? []).map((patient) => (
                  <button
                    key={patient.id}
                    type="button"
                    className="menu__item"
                    onClick={() => {
                      onChange(patient);
                      setOpen(false);
                      setTerm('');
                    }}
                  >
                    <span className="row row--between">
                      <span>{patient.name}</span>
                      <span className="small muted">
                        {patient.code} · {patient.phone}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </>
      )}
    </Field>
  );
}

// ---------------------------------------------------------------------------
// List chrome
// ---------------------------------------------------------------------------

export interface ListState {
  readonly page: number;
  readonly pageSize: number;
  readonly search: string;
  readonly preset: string;
  readonly sort: string;
  readonly direction: 'asc' | 'desc';
}

export const DEFAULT_LIST_STATE: ListState = {
  page: 1,
  pageSize: 25,
  search: '',
  preset: '',
  sort: '',
  direction: 'desc',
};

export function useListState(initial: Partial<ListState> = {}): {
  state: ListState;
  patch(patch: Partial<ListState>): void;
  resetFilters(): void;
} {
  const [state, setState] = useState<ListState>({ ...DEFAULT_LIST_STATE, ...initial });
  return useMemo(
    () => ({
      state,
      patch: (patch: Partial<ListState>) => setState((current) => ({ ...current, page: 1, ...patch })),
      resetFilters: () =>
        setState((current) => ({
          ...DEFAULT_LIST_STATE,
          pageSize: current.pageSize,
          sort: current.sort,
          direction: current.direction,
        })),
    }),
    [state],
  );
}

export function ListToolbar({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="filters">
      <div className="row row--wrap" style={{ gap: 10 }}>
        {children}
      </div>
    </div>
  );
}

export function DataTable({
  columns,
  rows,
  empty,
  loading,
  error,
  onRetry,
  onRowClick,
  rowKey,
}: {
  columns: ReadonlyArray<{ key: string; label: string; align?: 'left' | 'right' | 'center'; width?: string }>;
  rows: ReadonlyArray<Record<string, ReactNode>>;
  empty: ReactNode;
  loading?: boolean;
  error?: string | null;
  onRetry?(): void;
  onRowClick?(index: number): void;
  rowKey(index: number): string;
}): JSX.Element {
  if (loading) return <LoadingBlock rows={5} />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (rows.length === 0) return <>{empty}</>;
  return (
    <div className="table-wrap">
      <table className={`table ${onRowClick ? 'table--clickable' : ''}`}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                className={column.align === 'right' ? 'text-right' : undefined}
                style={column.width ? { width: column.width } : undefined}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={rowKey(index)}
              onClick={onRowClick ? () => onRowClick(index) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (event) => {
                      if (event.key === 'Enter') onRowClick(index);
                    }
                  : undefined
              }
            >
              {columns.map((column) => (
                <td key={column.key} className={column.align === 'right' ? 'text-right table-num' : undefined}>
                  {row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PagedFooter<T>({
  page,
  onPage,
  data,
}: {
  page: number;
  onPage(page: number): void;
  data: Paged<T> | null;
}): JSX.Element | null {
  if (!data || data.total === 0) return null;
  return <Pagination page={page} pageCount={data.pageCount} total={data.total} onPage={onPage} />;
}

export function EmptyWithIcon({ title, text, action }: { title: string; text?: string; action?: ReactNode }): JSX.Element {
  return <Empty title={title} text={text} action={action} icon={<CalendarDays size={24} />} />;
}

export { fmtMoney, fmtQuantity };
