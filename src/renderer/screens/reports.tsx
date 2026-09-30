/**
 * Reports.
 *
 * Every report is described by the core layer (columns, totals, summary and an
 * optional chart), so this screen renders whatever the service returns instead
 * of re-implementing each report in the UI.
 */
import { useEffect, useMemo, useState } from 'react';
import { BarChart3, Download, FileSpreadsheet, Printer } from 'lucide-react';
import { resolveDateRange, todayIso } from '@shared/dates';
import type { DateRangePreset } from '@shared/dates';
import { permissionMatches } from '@shared/permissions';
import type { ReportColumn, ReportKey, ReportRequest, ReportResult } from '@shared/types';
import { useAction, useApi, useApp } from '@renderer/state/store';
import { bridge } from '@renderer/lib/bridge';
import { fmtDate, fmtInstant, fmtMoney, fmtPercent, sharePercent } from '@renderer/lib/format';
import {
  Banner,
  Button,
  Card,
  Empty,
  Field,
  LoadingBlock,
  Page,
  Select,
  Stat,
  StatusBadge,
} from '@renderer/components/ui';
import { DataTable, DateField, rangePresetOptions } from '@renderer/components/forms';

interface CatalogueEntry {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly group: string;
  readonly requiresFinancialPermission: boolean;
}

function cellValue(column: ReportColumn, value: string | number | null): JSX.Element | string {
  if (value === null || value === undefined) return '—';
  switch (column.type) {
    case 'money':
      return fmtMoney(Number(value));
    case 'date':
      return fmtDate(String(value));
    case 'datetime':
      return fmtInstant(String(value));
    case 'status':
      return <StatusBadge status={String(value)} />;
    case 'number':
      return typeof value === 'number' ? value.toLocaleString('en-US') : String(value);
    default:
      return String(value);
  }
}

export function ReportsScreen(): JSX.Element {
  const { session, toast } = useApp();
  const { run, busy } = useAction();
  const catalogue = useApi('reports.catalogue', undefined);
  const [reportKey, setReportKey] = useState<ReportKey | ''>('');
  const [from, setFrom] = useState(todayIso().slice(0, 8) + '01');
  const [to, setTo] = useState(todayIso());
  const [preset, setPreset] = useState('this_month');
  const [groupBy, setGroupBy] = useState('');
  const [dentistId, setDentistId] = useState<number | null>(null);
  const [result, setResult] = useState<ReportResult | null>(null);

  const dentists = useApi('dentists.list', { pageSize: 100 });

  useEffect(() => {
    if (!reportKey && catalogue.data && catalogue.data.length > 0) setReportKey(catalogue.data[0]!.key as ReportKey);
  }, [catalogue.data, reportKey]);

  useEffect(() => {
    if (!preset || preset === 'custom') return;
    const range = resolveDateRange(preset as DateRangePreset);
    setFrom(range.from);
    setTo(range.to);
  }, [preset]);

  const groups = useMemo(() => {
    const map = new Map<string, CatalogueEntry[]>();
    for (const entry of (catalogue.data ?? []) as CatalogueEntry[]) {
      const list = map.get(entry.group) ?? [];
      list.push(entry);
      map.set(entry.group, list);
    }
    return [...map.entries()];
  }, [catalogue.data]);

  const selected = (catalogue.data ?? []).find((entry) => entry.key === reportKey) as CatalogueEntry | undefined;
  const canViewFinancial = permissionMatches(session?.permissions ?? [], 'report.financial.view');

  const request = (): ReportRequest => ({
    reportKey: reportKey as ReportKey,
    from,
    to,
    groupBy: (groupBy || null) as ReportRequest['groupBy'],
    filters: { dentistId },
  });

  const runReport = async () => {
    if (!reportKey) return;
    const data = await run(() => bridge.invoke('reports.run', request()), { failure: 'The report could not be generated.' });
    if (data) setResult(data);
  };

  const exportReport = async (format: 'csv' | 'pdf' | 'print') => {
    if (!reportKey) return;
    const outcome = await run(() => bridge.invoke('reports.export', { request: request(), format }), {
      success: format === 'print' ? 'Sent to the printer.' : 'Export ready.',
      failure: 'The export could not be produced.',
    });
    if (!outcome) return;
    if (outcome.path) {
      await bridge.invoke('app.openPath', { path: outcome.path, reveal: true });
      toast('info', 'Export saved', outcome.path);
    }
  };

  return (
    <Page
      title="Reports"
      description="Clinical, billing, stock and administrative reporting over any date range"
      actions={
        <>
          <Button icon={<FileSpreadsheet size={15} />} loading={busy} disabled={!reportKey} onClick={() => void exportReport('csv')}>
            Excel / CSV
          </Button>
          <Button icon={<Printer size={15} />} loading={busy} disabled={!reportKey} onClick={() => void exportReport('print')}>
            Print
          </Button>
          <Button variant="primary" icon={<Download size={15} />} loading={busy} disabled={!reportKey} onClick={() => void exportReport('pdf')}>
            Save PDF
          </Button>
        </>
      }
    >
      <Card title="Choose a report">
        <div className="grid-4">
          <Field label="Report" required>
            <Select
              value={reportKey}
              placeholder="Select a report"
              options={groups.flatMap(([group, entries]) =>
                entries.map((entry) => ({ value: entry.key, label: `${group} · ${entry.title}` })),
              )}
              onChange={(event) => {
                setReportKey(event.target.value as ReportKey);
                setResult(null);
              }}
            />
          </Field>
          <Field label="Date range">
            <Select
              value={preset}
              options={rangePresetOptions()}
              onChange={(event) => setPreset(event.target.value)}
            />
          </Field>
          <DateField label="From" value={from} onChange={(value) => { setFrom(value); setPreset('custom'); }} />
          <DateField label="To" value={to} onChange={(value) => { setTo(value); setPreset('custom'); }} />
        </div>
        <div className="grid-3" style={{ marginTop: 'var(--space-4)' }}>
          <Field label="Group by">
            <Select
              value={groupBy}
              placeholder="Report default"
              options={[
                { value: 'day', label: 'Day' },
                { value: 'week', label: 'Week' },
                { value: 'month', label: 'Month' },
                { value: 'category', label: 'Category' },
                { value: 'dentist', label: 'Dentist' },
                { value: 'patient', label: 'Patient' },
                { value: 'method', label: 'Payment method' },
              ]}
              onChange={(event) => setGroupBy(event.target.value)}
            />
          </Field>
          <Field label="Dentist">
            <Select
              value={dentistId === null ? '' : String(dentistId)}
              placeholder="All dentists"
              options={((dentists.data?.items ?? []) as unknown as Array<{ id: number; fullName: string }>).map((dentist) => ({
                value: String(dentist.id),
                label: dentist.fullName,
              }))}
              onChange={(event) => setDentistId(event.target.value ? Number(event.target.value) : null)}
            />
          </Field>
          <div className="row" style={{ alignItems: 'flex-end', gap: 8 }}>
            <Button variant="primary" loading={busy} disabled={!reportKey} onClick={() => void runReport()}>
              Run report
            </Button>
            {result ? (
              <Button variant="ghost" onClick={() => setResult(null)}>
                Clear
              </Button>
            ) : null}
          </div>
        </div>
        {selected ? <p className="small muted" style={{ marginTop: 'var(--space-3)' }}>{selected.description}</p> : null}
        {selected?.requiresFinancialPermission && !canViewFinancial ? (
          <Banner tone="warning" title="Limited report">
            This report contains financial figures. Ask an administrator for the “View financial reports” permission.
          </Banner>
        ) : null}
      </Card>

      {result ? (
        <div className="stack">
          <div className="stat-grid">
            {result.summary.map((entry) => (
              <Stat key={entry.label} label={entry.label} value={entry.value} tone={entry.tone ?? 'default'} />
            ))}
          </div>

          {result.chart && result.chart.length > 0 ? (
            <Card title="Trend" subtitle={`${result.chart.length} point(s)`}>
              <div className="chart">
                {result.chart.map((point) => {
                  const max = Math.max(...result.chart!.map((entry) => entry.value));
                  return (
                    <div key={point.label} className="chart__row">
                      <span className="chart__label">{point.label}</span>
                      <span className="chart__track">
                        <span className="chart__bar" style={{ width: `${sharePercent(point.value, max || 1)}%` }} />
                      </span>
                      <span className="chart__value">{fmtMoney(point.value)}</span>
                    </div>
                  );
                })}
              </div>
            </Card>
          ) : null}

          <Card
            title={result.title}
            subtitle={`${result.subtitle} · ${result.rowCount} row(s) · generated ${fmtInstant(result.generatedAt)}`}
            padded={false}
            actions={
              <Button size="sm" icon={<BarChart3 size={14} />} onClick={() => void runReport()}>
                Refresh
              </Button>
            }
          >
            <DataTable
              columns={result.columns.map((column) => ({ key: column.key, label: column.label, align: column.align }))}
              rows={result.rows.map((row) => {
                const rendered: Record<string, JSX.Element | string> = {};
                for (const column of result.columns) rendered[column.key] = cellValue(column, row[column.key] ?? null);
                return rendered;
              })}
              rowKey={(index) => String(index)}
              empty={<Empty title="No data for this selection" text="Try a wider date range." />}
            />
          </Card>
        </div>
      ) : (
        <Empty
          title="No report generated yet"
          text="Pick a report and a date range, then choose Run report."
          icon={<BarChart3 size={24} />}
          action={
            <Button variant="primary" disabled={!reportKey} onClick={() => void runReport()}>
              Run report
            </Button>
          }
        />
      )}
    </Page>
  );
}

export function ReportPercentCell({ value, total }: { value: number; total: number }): JSX.Element {
  return <span>{fmtPercent(sharePercent(value, total), 1)}</span>;
}
