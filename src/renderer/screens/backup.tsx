/**
 * Backup and data.
 *
 * Restoring replaces the live database, so the screen walks through it in
 * explicit steps: choose a file, inspect what it contains, type the word the
 * core demands, and only then restore. A pre-restore backup is always taken
 * first and the application restarts afterwards.
 */
import { useEffect, useState } from 'react';
import { DatabaseBackup, FileSpreadsheet, FolderOpen, HardDrive, History, ShieldCheck, Trash2 } from 'lucide-react';
import type { BackupCandidate, BackupRecord, BackupStatus, DataSummary, RestorePreview } from '@shared/types';
import { useAction, useApi, useApp } from '@renderer/state/store';
import { bridge } from '@renderer/lib/bridge';
import { byteSize, fmtDate, fmtInstant, fmtQuantity } from '@renderer/lib/format';
import {
  Badge,
  Banner,
  Button,
  Card,
  DefinitionList,
  Empty,
  Field,
  Input,
  LoadingBlock,
  Modal,
  Page,
  ProgressBar,
  Stat,
  StatusBadge,
  Switch,
  Tabs,
} from '@renderer/components/ui';
import { DataTable, DateField, TextField } from '@renderer/components/forms';

const CSV_SOURCES: ReadonlyArray<{
  value: 'patients' | 'invoices' | 'payments' | 'inventory' | 'accounting' | 'appointments' | 'visits' | 'prescriptions';
  label: string;
}> = [
  { value: 'patients', label: 'Patients' },
  { value: 'appointments', label: 'Appointments' },
  { value: 'visits', label: 'Visits' },
  { value: 'prescriptions', label: 'Prescriptions' },
  { value: 'invoices', label: 'Invoices' },
  { value: 'payments', label: 'Payments' },
  { value: 'inventory', label: 'Inventory' },
  { value: 'accounting', label: 'Accounting' },
];

function BackupsPanel({ status, onRefresh }: { status: BackupStatus | null; onRefresh(): void }): JSX.Element {
  const { confirm, toast } = useApp();
  const { run, busy } = useAction();
  const [note, setNote] = useState('');
  const [progress, setProgress] = useState<{ percent: number; message: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupRecord | null>(null);
  const [deleteFile, setDeleteFile] = useState(true);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [previewPath, setPreviewPath] = useState('');
  const [typed, setTyped] = useState('');
  const [restoreAttachments, setRestoreAttachments] = useState(true);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    return bridge.on('backup.progress', (payload) => {
      if (payload.phase === 'done' || payload.phase === 'failed') {
        if (payload.phase === 'done') toast('success', 'Backup finished', payload.message);
        else toast('error', 'Backup failed', payload.message);
        window.setTimeout(() => setProgress(null), 1200);
        return;
      }
      setProgress({ percent: payload.percent, message: payload.message });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return bridge.on('restore.relaunching', (payload) => {
      setRestoring(true);
      toast('info', 'Restoring', payload.message);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async () => {
    setProgress({ percent: 0, message: 'Starting…' });
    const record = await run(() => bridge.invoke('backup.create', { note, kind: 'manual' }), {
      failure: 'The backup could not be created.',
    });
    setProgress(null);
    if (record) {
      setNote('');
      toast('success', 'Backup created', `${record.fileName} · ${byteSize(record.sizeBytes)}`);
      onRefresh();
    }
  };

  const verify = async (record: BackupRecord) => {
    await run(() => bridge.invoke('backup.verify', { id: record.id }), { success: 'Backup verified.', failure: 'Verification failed.' });
    onRefresh();
  };

  const remove = async () => {
    if (!deleteTarget) return;
    const answer = await confirm({
      title: `Delete ${deleteTarget.fileName}`,
      description: deleteFile
        ? 'The backup record and the file on disk are both removed. This cannot be undone.'
        : 'Only the record is removed; the file stays in the backup folder.',
      confirmLabel: 'Delete backup',
      tone: 'danger',
      typedWord: deleteTarget.fileName,
      reason: true,
    });
    if (!answer.ok || !answer.typed) return;
    await run(() => bridge.invoke('backup.delete', { id: deleteTarget.id, deleteFile, confirmText: answer.typed }), {
      success: 'Backup deleted.',
      failure: 'The backup could not be deleted.',
    });
    setDeleteTarget(null);
    onRefresh();
  };

  const openPreview = async (filePath: string) => {
    const result = await run(() => bridge.invoke('backup.previewRestore', { filePath }), {
      failure: 'That file could not be read as a Dentiva backup.',
    });
    if (result) {
      setPreview(result);
      setPreviewPath(filePath);
      setTyped('');
    }
  };

  const doRestore = async () => {
    if (!preview) return;
    const done = await run(() => bridge.invoke('backup.restore', { filePath: previewPath, confirmText: typed, restoreAttachments }), {
      failure: 'The restore did not start.',
    });
    if (done) {
      toast('success', 'Restore complete', done.message);
      setPreview(null);
      setRestoring(true);
    }
  };

  const backups = status?.backups ?? [];
  const preRestore = status?.preRestoreBackups ?? [];
  const external = status?.externalFiles ?? [];

  return (
    <div className="stack">
      {progress ? <ProgressBar percent={progress.percent} label={progress.message} /> : null}
      {restoring ? (
        <Banner tone="info" title="Restarting">
          The database was replaced. Dentiva Pro restarts itself to reopen the restored data — this window can stay open.
        </Banner>
      ) : null}

      <Card
        title="Backups on this computer"
        subtitle={
          status
            ? `${status.folder}${status.folderWritable ? '' : ' (not writable)'} · last backup ${
                status.lastBackupAt ? fmtInstant(status.lastBackupAt) : 'never'
              }`
            : undefined
        }
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Button
              onClick={async () => {
                const folder = await bridge.invoke('backup.pickFolder');
                if (!folder) return;
                const updated = await run(() => bridge.invoke('backup.setFolder', { folder }), { success: 'Backup folder changed.' });
                if (updated) onRefresh();
              }}
            >
              <FolderOpen size={14} /> Change folder
            </Button>
            <Button variant="ghost" onClick={onRefresh}>
              Refresh
            </Button>
          </div>
        }
        padded={false}
      >
        <div className="stack" style={{ padding: 'var(--space-4) 0 0' }}>
          {status?.isDue ? (
            <div style={{ padding: '0 var(--space-4)' }}>
              <Banner tone="warning" title="A backup is due">
                The configured interval has passed. Create one now — it takes a few seconds and protects everything.
              </Banner>
            </div>
          ) : null}
          {status?.lastFailure ? (
            <div style={{ padding: '0 var(--space-4)' }}>
              <Banner tone="danger" title={`The last automatic backup failed on ${fmtInstant(status.lastFailure.at)}`}>
                {status.lastFailure.message}
              </Banner>
            </div>
          ) : null}
          <div className="row" style={{ padding: '0 var(--space-4) var(--space-4)', gap: 10, alignItems: 'flex-end' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <TextField label="Note (optional)" value={note} onChange={setNote} />
            </div>
            <Button variant="primary" icon={<DatabaseBackup size={15} />} loading={busy} onClick={() => void create()}>
              Create backup now
            </Button>
          </div>
        </div>
        <DataTable
          columns={[
            { key: 'file', label: 'File' },
            { key: 'kind', label: 'Type' },
            { key: 'when', label: 'Created' },
            { key: 'by', label: 'By' },
            { key: 'size', label: 'Size', align: 'right' },
            { key: 'contents', label: 'Contents' },
            { key: 'state', label: 'State' },
            { key: 'actions', label: '', align: 'right' },
          ]}
          rows={backups.map((record) => ({
            file: (
              <div>
                <div className="mono small">{record.fileName}</div>
                <div className="small muted">{record.note || '—'}</div>
              </div>
            ),
            kind:
              record.kind === 'manual' ? (
                <Badge>Manual</Badge>
              ) : record.kind === 'automatic' ? (
                <Badge tone="info">Automatic</Badge>
              ) : (
                <Badge tone="warning">Pre-restore</Badge>
              ),
            when: fmtInstant(record.createdAt),
            by: record.createdByName || '—',
            size: byteSize(record.sizeBytes),
            contents: (
              <span className="small muted">
                {record.patientCount} patient(s) · {record.invoiceCount} invoice(s) · {record.attachmentCount} file(s)
              </span>
            ),
            state:
              record.status === 'completed' ? (
                record.verifiedAt ? (
                  <StatusBadge status="verified" label="Verified" />
                ) : (
                  <StatusBadge status="completed" label="Completed" />
                )
              ) : (
                <StatusBadge status={record.status} />
              ),
            actions: (
              <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                <Button size="sm" variant="ghost" onClick={() => void verify(record)}>
                  Verify
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void openPreview(record.filePath)}>
                  Restore
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDeleteTarget(record);
                    setDeleteFile(true);
                  }}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            ),
          }))}
          loading={!status && busy}
          rowKey={(index) => String(backups[index]?.id ?? index)}
          empty={
            <Empty
              title="No backups yet"
              text="Create the first backup now — it takes a few seconds."
              icon={<DatabaseBackup size={24} />}
            />
          }
        />
      </Card>

      {preRestore.length > 0 ? (
        <Card title="Pre-restore backups" subtitle="Taken automatically before each restore; keep them until you are sure." padded={false}>
          <DataTable
            columns={[
              { key: 'file', label: 'File' },
              { key: 'when', label: 'Created' },
              { key: 'size', label: 'Size', align: 'right' },
              { key: 'actions', label: '', align: 'right' },
            ]}
            rows={preRestore.map((record) => ({
              file: <span className="mono small">{record.fileName}</span>,
              when: fmtInstant(record.createdAt),
              size: byteSize(record.sizeBytes),
              actions: (
                <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                  <Button size="sm" variant="ghost" onClick={() => void openPreview(record.filePath)}>
                    Restore
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDeleteTarget(record);
                      setDeleteFile(true);
                    }}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              ),
            }))}
            rowKey={(index) => String(preRestore[index]?.id ?? index)}
            empty={<Empty title="Nothing here" />}
          />
        </Card>
      ) : null}

      <Card
        title="Backup files found in the backup folder"
        subtitle="Files copied in from another computer appear here and can be restored after inspection."
        actions={
          <Button
            onClick={async () => {
              const found = await run(() => bridge.invoke('backup.scanFolder', {}), { success: 'Folder scanned.' });
              if (found) onRefresh();
            }}
          >
            <HardDrive size={14} /> Scan folder
          </Button>
        }
        padded={false}
      >
        <DataTable
          columns={[
            { key: 'file', label: 'File' },
            { key: 'modified', label: 'Modified' },
            { key: 'size', label: 'Size', align: 'right' },
            { key: 'valid', label: 'Readable' },
            { key: 'problem', label: 'Problem' },
            { key: 'actions', label: '', align: 'right' },
          ]}
          rows={external.map((candidate: BackupCandidate) => ({
            file: <span className="mono small">{candidate.fileName}</span>,
            modified: fmtInstant(candidate.modifiedAt),
            size: byteSize(candidate.sizeBytes),
            valid: candidate.valid ? <StatusBadge status="valid" label="Valid" /> : <StatusBadge status="invalid" label="Unreadable" />,
            problem: candidate.problem || '—',
            actions: (
              <Button size="sm" variant="ghost" disabled={!candidate.valid} onClick={() => void openPreview(candidate.filePath)}>
                Restore
              </Button>
            ),
          }))}
          rowKey={(index) => String(external[index]?.filePath ?? index)}
          empty={<Empty title="No backup files found" text="Copy a .dentivabak file into this folder and scan again." />}
        />
      </Card>

      <Modal
        open={deleteTarget !== null}
        width="narrow"
        title={deleteTarget ? `Delete ${deleteTarget.fileName}` : ''}
        onClose={() => setDeleteTarget(null)}
        footer={
          <div className="row row--end">
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void remove()}>
              Delete backup
            </Button>
          </div>
        }
      >
        <div className="stack">
          <p>Deleting a backup removes a copy of the clinic data. If it is the only copy you have, the data inside it is gone as well.</p>
          <Switch label="Also delete the file from disk" checked={deleteFile} onChange={setDeleteFile} />
          <Banner tone="warning" title="Type the file name to confirm">
            You will be asked for “{deleteTarget?.fileName}” before anything is removed.
          </Banner>
        </div>
      </Modal>

      <Modal
        open={preview !== null}
        width="wide"
        title="Restore from this backup"
        description="Read this carefully — restoring replaces everything currently in the application."
        onClose={() => setPreview(null)}
        footer={
          <div className="row row--end">
            <Button variant="ghost" onClick={() => setPreview(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy || restoring}
              disabled={typed.trim() !== (preview?.requiresTypedConfirmation ?? '')}
              onClick={() => void doRestore()}
            >
              Restore and restart
            </Button>
          </div>
        }
      >
        {preview ? (
          <div className="stack">
            <DefinitionList
              items={[
                { label: 'Backup file', value: <span className="mono small">{preview.candidate.fileName}</span> },
                { label: 'Created', value: fmtInstant(preview.candidate.modifiedAt) },
                { label: 'Size', value: byteSize(preview.candidate.sizeBytes) },
                { label: 'App version', value: preview.candidate.metadata?.appVersion ?? '—' },
                { label: 'Schema', value: String(preview.candidate.metadata?.schemaVersion ?? '—') },
                {
                  label: 'Patients in backup',
                  value: String(preview.candidate.metadata?.patientCount ?? '—'),
                },
                {
                  label: 'Invoices in backup',
                  value: String(preview.candidate.metadata?.invoiceCount ?? '—'),
                },
              ]}
            />
            <Definitions title="Currently in the application" data={preview.currentData} />
            {preview.warnings.length > 0 ? (
              <Banner tone="warning" title="Before you continue">
                <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                  {preview.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </Banner>
            ) : null}
            <Switch label="Also restore attachments and profile images" checked={restoreAttachments} onChange={setRestoreAttachments} />
            <Field label={`Type “${preview.requiresTypedConfirmation}” to confirm`} required>
              <Input value={typed} onChange={(event) => setTyped(event.target.value)} />
            </Field>
            <Banner tone="danger" title="What happens next">
              A safety backup of the current data is taken first, then the database is replaced and the application restarts on its own.
            </Banner>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function Definitions({ title, data }: { title: string; data: { patients: number; invoices: number; visits: number } }): JSX.Element {
  return (
    <DefinitionList
      items={[
        { label: `${title} — patients`, value: String(data.patients) },
        { label: 'Invoices', value: String(data.invoices) },
        { label: 'Visits', value: String(data.visits) },
      ]}
    />
  );
}

function DataPanel(): JSX.Element {
  const { toast } = useApp();
  const { run, busy } = useAction();
  const summary = useApi('system.dataSummary', undefined);
  const integrity = useApi('system.integrityCheck', undefined);
  const logs = useApi('system.logFiles', undefined);
  const [csvSource, setCsvSource] = useState<(typeof CSV_SOURCES)[number]['value']>('patients');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [vacuumResult, setVacuumResult] = useState<{ beforeBytes: number; afterBytes: number } | null>(null);

  const exportCsv = async () => {
    const outcome = await run(() => bridge.invoke('system.exportCsv', { what: csvSource, from: from || undefined, to: to || undefined }), {
      failure: 'The export could not be produced.',
    });
    if (!outcome) return;
    await bridge.invoke('app.openPath', { path: outcome.path, reveal: true });
    toast('info', 'Export saved', `${outcome.rowCount} row(s) · ${outcome.path}`);
  };

  return (
    <div className="stack">
      <Card
        title="What is stored"
        subtitle={
          summary.data
            ? `Oldest record ${fmtDate(summary.data.oldestRecordDate)} · newest ${fmtDate(summary.data.newestRecordDate)}`
            : undefined
        }
        actions={<Button onClick={summary.reload}>Refresh</Button>}
        padded={false}
      >
        {summary.loading && !summary.data ? (
          <LoadingBlock rows={4} />
        ) : summary.data ? (
          <DataTable
            columns={[
              { key: 'label', label: 'Record type' },
              { key: 'count', label: 'Count', align: 'right' },
            ]}
            rows={summaryRows(summary.data).map((row) => ({ label: row.label, count: row.value }))}
            rowKey={(index) => `summary-${index}`}
            empty={<Empty title="Nothing stored" />}
          />
        ) : (
          <Empty title="Summary unavailable" />
        )}
      </Card>

      <Card
        title="Integrity check"
        subtitle={integrity.data ? `Checked ${fmtInstant(integrity.data.checkedAt)}` : undefined}
        actions={
          <Button loading={integrity.loading} onClick={() => integrity.reload()}>
            <ShieldCheck size={14} /> Run check
          </Button>
        }
      >
        {integrity.data ? (
          <div className="stack">
            <Banner
              tone={integrity.data.ok ? 'success' : 'danger'}
              title={integrity.data.ok ? 'Everything is consistent' : 'Problems were found'}
            >
              {integrity.data.ok
                ? 'Foreign keys, indexes and attachment references all check out.'
                : `Foreign key violations: ${integrity.data.foreignKeyViolations}` +
                  ` · missing attachments: ${integrity.data.missingAttachments}`}
            </Banner>
            <div className="stack stack--sm">
              {integrity.data.checks.map((check) => (
                <div key={check.name} className="row row--between">
                  <span>
                    {check.ok ? <Badge tone="success">OK</Badge> : <Badge tone="danger">Fail</Badge>} {check.name}
                  </span>
                  <span className="small muted">{check.detail}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="muted small">Run the check to verify that every reference in the database resolves.</p>
        )}
      </Card>

      <Card title="Export to Excel / CSV" subtitle="UTF-8 with a byte-order mark, so Excel opens Bangla text correctly.">
        <div className="stack">
          <div className="grid-3">
            <Field label="What to export">
              <select className="input" value={csvSource} onChange={(event) => setCsvSource(event.target.value as typeof csvSource)}>
                {CSV_SOURCES.map((source) => (
                  <option key={source.value} value={source.value}>
                    {source.label}
                  </option>
                ))}
              </select>
            </Field>
            <DateField label="From (optional)" value={from} onChange={setFrom} />
            <DateField label="To (optional)" value={to} onChange={setTo} />
          </div>
          <div className="row row--end">
            <Button variant="primary" icon={<FileSpreadsheet size={15} />} loading={busy} onClick={() => void exportCsv()}>
              Export
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Housekeeping" subtitle="Reclaim space and review the technical log.">
        <div className="stack">
          <div className="row row--between">
            <div>
              <div>Compact the database</div>
              <div className="small muted">Removes free pages left behind by deleted records. Safe at any time.</div>
            </div>
            <Button
              loading={busy}
              onClick={async () => {
                const result = await run(() => bridge.invoke('system.vacuum'), { success: 'Database compacted.' });
                if (result) setVacuumResult(result);
              }}
            >
              Compact now
            </Button>
          </div>
          {vacuumResult ? (
            <div className="small muted">
              {byteSize(vacuumResult.beforeBytes)} → {byteSize(vacuumResult.afterBytes)} (
              {fmtQuantity(vacuumResult.beforeBytes - vacuumResult.afterBytes, 'bytes')} freed)
            </div>
          ) : null}
          <div className="divider" />
          <div className="row row--between">
            <div>
              <div>Log files</div>
              <div className="small muted">
                {(logs.data ?? []).length} file(s) · <History size={12} /> technical log for troubleshooting
              </div>
            </div>
            <Button onClick={() => void bridge.invoke('system.openLogFolder')}>
              <FolderOpen size={14} /> Open log folder
            </Button>
          </div>
          {(logs.data ?? []).length > 0 ? (
            <DataTable
              columns={[
                { key: 'name', label: 'File' },
                { key: 'size', label: 'Size', align: 'right' },
                { key: 'modified', label: 'Last written' },
              ]}
              rows={(logs.data ?? []).map((file) => ({
                name: <span className="mono small">{file.name}</span>,
                size: byteSize(file.sizeBytes),
                modified: fmtInstant(file.modifiedAt),
              }))}
              rowKey={(index) => String(logs.data?.[index]?.name ?? index)}
              empty={<Empty title="No log files yet" />}
            />
          ) : null}
        </div>
      </Card>
    </div>
  );
}

function summaryRows(summary: DataSummary): Array<{ label: string; value: string }> {
  return [
    { label: 'Patients', value: String(summary.patients) },
    { label: 'Deleted patients (recoverable)', value: String(summary.deletedPatients) },
    { label: 'Visits', value: String(summary.visits) },
    { label: 'Appointments', value: String(summary.appointments) },
    { label: 'Prescriptions', value: String(summary.prescriptions) },
    { label: 'Invoices', value: String(summary.invoices) },
    { label: 'Payments', value: String(summary.payments) },
    { label: 'Treatment records', value: String(summary.treatments) },
    { label: 'Inventory items', value: String(summary.inventoryItems) },
    { label: 'Stock movements', value: String(summary.stockMovements) },
    { label: 'Accounting entries', value: String(summary.accountingTransactions) },
    { label: 'Attachments', value: String(summary.attachments) },
    { label: 'Audit entries', value: String(summary.auditEntries) },
    { label: 'Notifications', value: String(summary.notifications) },
    { label: 'Database size', value: byteSize(summary.databaseSizeBytes) },
    { label: 'Attachment storage', value: byteSize(summary.attachmentSizeBytes) },
  ];
}

export function BackupScreen(): JSX.Element {
  const [tab, setTab] = useState('backups');
  const status = useApi('backup.status', tab === 'backups' ? undefined : null, [tab]);

  return (
    <Page title="Backup & data" description="Protect the clinic, restore an earlier copy, export and maintain the database">
      <div className="stat-grid">
        <Stat label="Backups kept" value={String(status.data?.backups.length ?? 0)} icon={<DatabaseBackup size={16} />} />
        <Stat
          label="Last backup"
          value={status.data?.lastBackupAt ? fmtInstant(status.data.lastBackupAt) : 'Never'}
          tone={status.data?.isDue ? 'warning' : 'success'}
        />
        <Stat
          label="Next automatic"
          value={status.data?.nextDueAt ? fmtInstant(status.data.nextDueAt) : 'Not scheduled'}
          hint={status.data?.intervalDays ? `Every ${status.data.intervalDays} day(s)` : 'Automatic backups are off'}
        />
        <Stat
          label="Backup folder"
          value={status.data?.folderWritable ? 'Writable' : 'Check folder'}
          tone={status.data?.folderWritable ? 'success' : 'danger'}
        />
      </div>

      {status.data && !status.data.folderWritable ? (
        <Banner tone="danger" title="The backup folder cannot be written to">
          Backups will fail until this is fixed. Choose a folder on a writable drive, ideally a different disk or an external one.
        </Banner>
      ) : null}

      <Tabs
        tabs={[
          { key: 'backups', label: 'Backups & restore' },
          { key: 'data', label: 'Data & maintenance' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'backups' ? <BackupsPanel status={status.data} onRefresh={status.reload} /> : null}
      {tab === 'data' ? <DataPanel /> : null}
    </Page>
  );
}
