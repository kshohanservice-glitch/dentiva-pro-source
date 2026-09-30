/**
 * Audit log.
 *
 * Every change to a record, every sign-in, every destructive action and every
 * permission change is written here by the business layer. The screen is
 * read-only by design — an audit trail that can be edited is worthless.
 */
import { useState } from 'react';
import { FileSpreadsheet, History, Printer, ShieldAlert } from 'lucide-react';
import { todayIso } from '@shared/dates';
import type { AuditEntryDetail } from '@shared/types';
import { useAction, useApi, useApp } from '@renderer/state/store';
import { bridge } from '@renderer/lib/bridge';
import { fmtInstant } from '@renderer/lib/format';
import {
  Badge,
  Banner,
  Button,
  Card,
  DefinitionList,
  Drawer,
  Empty,
  Field,
  LoadingBlock,
  Page,
  SearchInput,
  Select,
  Stat,
  StatusBadge,
  Switch,
} from '@renderer/components/ui';
import { DataTable, DateField, PagedFooter, useListState } from '@renderer/components/forms';

const SEVERITIES = [
  { value: 'info', label: 'Information' },
  { value: 'warning', label: 'Warning' },
  { value: 'critical', label: 'Critical' },
];

export function AuditScreen(): JSX.Element {
  const { toast } = useApp();
  const { run, busy } = useAction();
  const lists = useListState();
  const [action, setAction] = useState('');
  const [severity, setSeverity] = useState('');
  const [entityType, setEntityType] = useState('');
  const [userId, setUserId] = useState<number | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);

  const actions = useApi('audit.actions', undefined);
  const users = useApi('users.list', { page: 1, pageSize: 200 });
  const list = useApi(
    'audit.list',
    {
      page: lists.state.page,
      pageSize: lists.state.pageSize,
      search: lists.state.search || undefined,
      action: action ? [action] : undefined,
      severity: criticalOnly ? ['critical'] : severity ? [severity as 'info' | 'warning' | 'critical'] : undefined,
      entityType: entityType || undefined,
      userId,
      from: from || undefined,
      to: to || undefined,
    },
    [lists.state.page, lists.state.pageSize, lists.state.search, action, severity, entityType, userId, from, to, criticalOnly],
  );
  const detail = useApi('audit.get', selected === null ? null : { id: selected });

  const rows = list.data?.items ?? [];
  const entityTypes = [...new Set(rows.map((row) => row.entityType))].sort();

  const exportLog = async (format: 'csv' | 'pdf') => {
    const outcome = await run(() => bridge.invoke('audit.export', { from: from || undefined, to: to || undefined, format }), {
      success: 'Audit export created.',
      failure: 'The audit log could not be exported.',
    });
    if (!outcome) return;
    await bridge.invoke('app.openPath', { path: outcome.path, reveal: true });
    toast('info', 'Export saved', outcome.path);
  };

  return (
    <Page
      title="Audit log"
      description="Who changed what, when and from where"
      actions={
        <>
          <Button icon={<FileSpreadsheet size={15} />} loading={busy} onClick={() => void exportLog('csv')}>
            Export CSV
          </Button>
          <Button icon={<Printer size={15} />} loading={busy} onClick={() => void exportLog('pdf')}>
            Save PDF
          </Button>
        </>
      }
    >
      <Banner tone="info" title="Read-only trail">
        The audit log cannot be edited or deleted from the interface. Entries are kept indefinitely so a record can always be explained —
        deactivate users instead of deleting them.
      </Banner>

      <div className="stat-grid">
        <Stat label="Entries in view" value={String(list.data?.total ?? 0)} icon={<History size={16} />} />
        <Stat label="Distinct actions" value={String(actions.data?.length ?? 0)} />
        <Stat
          label="Critical"
          value={String(rows.filter((row) => row.severity === 'critical').length)}
          tone="danger"
          icon={<ShieldAlert size={16} />}
        />
      </div>

      <div className="filters">
        <div className="row row--wrap" style={{ gap: 10 }}>
          <div style={{ minWidth: 240, flex: 1 }}>
            <SearchInput
              value={lists.state.search}
              placeholder="Search the detail text…"
              onChange={(value) => lists.patch({ search: value })}
            />
          </div>
          <Select
            value={action}
            placeholder="All actions"
            options={(actions.data ?? []).map((entry) => ({ value: entry.action, label: `${entry.label} (${entry.count})` }))}
            onChange={(event) => setAction(event.target.value)}
          />
          <Select
            value={severity}
            placeholder="All severities"
            options={SEVERITIES}
            onChange={(event) => setSeverity(event.target.value)}
          />
          <Select
            value={entityType}
            placeholder="All record types"
            options={entityTypes.map((type) => ({ value: type, label: type.replace(/_/g, ' ') }))}
            onChange={(event) => setEntityType(event.target.value)}
          />
          <Select
            value={userId === null ? '' : String(userId)}
            placeholder="All users"
            options={((users.data?.items ?? []) as unknown as Array<{ id: number; username: string; fullName: string }>).map((user) => ({
              value: String(user.id),
              label: `${user.fullName} (${user.username})`,
            }))}
            onChange={(event) => setUserId(event.target.value ? Number(event.target.value) : null)}
          />
          <Switch label="Critical only" checked={criticalOnly} onChange={setCriticalOnly} />
        </div>
        <div className="row row--wrap" style={{ gap: 10, marginTop: 10 }}>
          <DateField label="From" value={from} onChange={setFrom} />
          <DateField label="To" value={to} onChange={setTo} />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setFrom(`${todayIso().slice(0, 4)}-01-01`);
              setTo(todayIso());
            }}
          >
            This year
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setFrom('');
              setTo('');
              setAction('');
              setSeverity('');
              setEntityType('');
              setUserId(null);
              setCriticalOnly(false);
              lists.resetFilters();
            }}
          >
            Clear filters
          </Button>
        </div>
      </div>

      <Card padded={false}>
        <DataTable
          columns={[
            { key: 'when', label: 'When' },
            { key: 'user', label: 'User' },
            { key: 'action', label: 'Action' },
            { key: 'record', label: 'Record' },
            { key: 'detail', label: 'Detail' },
            { key: 'severity', label: 'Severity' },
          ]}
          rows={rows.map((entry) => ({
            when: <span className="small">{fmtInstant(entry.createdAt)}</span>,
            user: entry.userName || '— system —',
            action: (
              <div>
                <div>{entry.actionLabel}</div>
                <div className="small muted mono">{entry.action}</div>
              </div>
            ),
            record: (
              <div>
                <div>{entry.entityLabel || entry.entityType}</div>
                <div className="small muted">
                  {entry.entityType}
                  {entry.entityId !== null ? ` #${entry.entityId}` : ''}
                </div>
              </div>
            ),
            detail: <span className="small">{entry.detail || '—'}</span>,
            severity:
              entry.severity === 'critical' ? (
                <Badge tone="danger">Critical</Badge>
              ) : entry.severity === 'warning' ? (
                <Badge tone="warning">Warning</Badge>
              ) : (
                <Badge>Info</Badge>
              ),
          }))}
          loading={list.loading && !list.data}
          error={list.error}
          onRetry={list.reload}
          onRowClick={(index) => setSelected(rows[index]?.id ?? null)}
          rowKey={(index) => String(rows[index]?.id ?? index)}
          empty={<Empty title="Nothing recorded for this filter" text="Widen the date range or clear the filters." />}
        />
        <PagedFooter page={lists.state.page} onPage={(page) => lists.patch({ page })} data={list.data} />
      </Card>

      <Drawer
        open={selected !== null}
        title={detail.data ? `Audit entry — ${detail.data.actionLabel}` : 'Audit entry'}
        onClose={() => setSelected(null)}
      >
        {detail.loading && !detail.data ? (
          <LoadingBlock rows={6} />
        ) : detail.data ? (
          <AuditDetail entry={detail.data} />
        ) : (
          <Empty title="Entry unavailable" />
        )}
      </Drawer>
    </Page>
  );
}

function AuditDetail({ entry }: { entry: AuditEntryDetail }): JSX.Element {
  return (
    <div className="stack">
      <DefinitionList
        items={[
          { label: 'Action', value: <span className="mono small">{entry.action}</span> },
          { label: 'Severity', value: <StatusBadge status={entry.severity} label={entry.severity} /> },
          { label: 'User', value: entry.userName || '— system —' },
          { label: 'Record', value: `${entry.entityType}${entry.entityId !== null ? ` #${entry.entityId}` : ''}` },
          { label: 'Label', value: entry.entityLabel || '—' },
          { label: 'Recorded', value: fmtInstant(entry.createdAt) },
        ]}
      />
      <Field label="Detail">
        <p>{entry.detail || 'No detail text was recorded.'}</p>
      </Field>
      {Object.keys(entry.context).length > 0 ? (
        <DefinitionList items={Object.entries(entry.context).map(([key, value]) => ({ label: key, value }))} />
      ) : null}
      <div className="grid-2">
        <JsonBlock title="Before" value={entry.before} />
        <JsonBlock title="After" value={entry.after} />
      </div>
      <Banner tone="info" title="Why this is kept">
        Audit entries let the clinic explain a change months later — for example what an invoice said before it was edited, or which account
        exported patient data.
      </Banner>
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }): JSX.Element {
  if (value === null || value === undefined) {
    return (
      <Card title={title}>
        <p className="muted small">Nothing recorded.</p>
      </Card>
    );
  }
  return (
    <Card title={title}>
      <pre className="mono small" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {JSON.stringify(value, null, 2)}
      </pre>
    </Card>
  );
}
