/**
 * About — product identity, version, the author, the offline promise, the
 * licence of the application itself and the bundled third-party notices.
 */
import { useMemo, useState } from 'react';
import { Ban, Cpu, Database, HardDrive, Mail, RefreshCw, ScrollText, ShieldCheck, WifiOff } from 'lucide-react';
import {
  APP_AUTHOR_EMAIL,
  APP_AUTHOR_NAME,
  APP_BUILD_NUMBER,
  APP_COPYRIGHT,
  APP_COUNTRY,
  APP_CURRENCY_CODE,
  APP_NAME,
  APP_TAGLINE,
  APP_VERSION,
} from '@shared/app-info';
import { LICENSES_DIGEST, LICENSES_PACKAGE_SET, THIRD_PARTY_NOTICES } from '@renderer/generated/licenses';
import { useApi } from '@renderer/state/store';
import { bridge } from '@renderer/lib/bridge';
import { byteSize, fmtInstant } from '@renderer/lib/format';
import {
  Badge,
  Banner,
  Button,
  Card,
  DefinitionList,
  Empty,
  Field,
  Page,
  SearchInput,
  Segmented,
  Spinner,
  Stat,
} from '@renderer/components/ui';
import { DataTable } from '@renderer/components/forms';

const RELEASES_URL = 'https://github.com/kshohanservice-glitch/dentiva-pro-source/releases';

export function AboutScreen(): JSX.Element {
  const system = useApi('app.systemInfo', undefined);
  const health = useApi('app.health', undefined);
  const bootstrap = useApi('app.bootstrap', undefined);
  const [filter, setFilter] = useState('');
  const [scope, setScope] = useState<'direct' | 'all'>('direct');

  const notices = useMemo(() => {
    const term = filter.trim().toLowerCase();
    return THIRD_PARTY_NOTICES.filter((entry) => {
      if (scope === 'direct' && !entry.direct) return false;
      if (!term) return true;
      return `${entry.name} ${entry.license} ${entry.copyright ?? ''}`.toLowerCase().includes(term);
    });
  }, [filter, scope]);

  const openExternal = async (url: string) => {
    try {
      await bridge.invoke('app.openExternal', { url });
    } catch {
      /* the dev bridge has no browser to open; the address is shown as text */
    }
  };

  return (
    <Page
      title={`About ${APP_NAME}`}
      description={APP_TAGLINE}
      actions={
        <Button
          icon={<Mail size={15} />}
          onClick={() => void openExternal(`mailto:${APP_AUTHOR_EMAIL}?subject=${encodeURIComponent(`${APP_NAME} ${APP_VERSION}`)}`)}
        >
          Contact the author
        </Button>
      }
    >
      <div className="stat-grid">
        <Stat label="Version" value={system.data?.appVersion ?? APP_VERSION} hint={`Build ${system.data?.appBuild ?? APP_BUILD_NUMBER}`} />
        <Stat label="Created by" value={APP_AUTHOR_NAME} />
        <Stat label="Country" value={APP_COUNTRY} />
        <Stat label="Currency" value={APP_CURRENCY_CODE} />
      </div>

      <Card title="Product information">
        <div className="grid-2">
          <DefinitionList
            items={[
              { label: 'Product', value: `${APP_NAME} — ${APP_TAGLINE}` },
              { label: 'Version', value: APP_VERSION },
              { label: 'Build', value: APP_BUILD_NUMBER },
              { label: 'Author', value: APP_AUTHOR_NAME },
              { label: 'Email', value: <span className="mono small">{APP_AUTHOR_EMAIL}</span> },
              { label: 'Copyright', value: APP_COPYRIGHT },
            ]}
          />
          <DefinitionList
            items={[
              { label: 'Operating system', value: system.data ? `${system.data.osVersion} (${system.data.architecture})` : '—' },
              { label: 'Electron', value: system.data?.electronVersion ?? '—' },
              { label: 'Chromium', value: system.data?.chromeVersion ?? '—' },
              { label: 'Node', value: system.data?.nodeVersion ?? '—' },
              {
                label: 'Data folder',
                value: <span className="mono small">{system.data?.userDataPath ?? bootstrap.data?.dataDir ?? '—'}</span>,
              },
              { label: 'Licence', value: 'Proprietary — see LICENSE in the installation folder' },
            ]}
          />
        </div>
      </Card>

      <Card
        title="This installation"
        actions={
          <Button
            size="sm"
            onClick={() => {
              system.reload();
              health.reload();
            }}
          >
            Refresh
          </Button>
        }
      >
        {health.loading && !health.data ? (
          <Spinner />
        ) : (
          <div className="grid-2">
            <DefinitionList
              items={[
                {
                  label: 'Database',
                  value: health.data?.databaseOk ? <Badge tone="success">Open</Badge> : <Badge tone="danger">Unavailable</Badge>,
                },
                {
                  label: 'Integrity',
                  value: health.data?.integrityOk ? <Badge tone="success">Checked</Badge> : <Badge tone="warning">Needs a check</Badge>,
                },
                { label: 'Schema version', value: String(health.data?.schemaVersion ?? '—') },
                { label: 'Database size', value: byteSize(health.data?.databaseSizeBytes) },
                { label: 'Attachments', value: `${health.data?.attachmentCount ?? 0} file(s)` },
                { label: 'Uptime', value: health.data ? `${Math.round(health.data.uptimeMs / 1000)} seconds` : '—' },
              ]}
            />
            <DefinitionList
              items={[
                { label: 'Data folder', value: <span className="mono small">{health.data?.dataDir ?? '—'}</span> },
                { label: 'Log folder', value: <span className="mono small">{health.data?.logDir ?? '—'}</span> },
                { label: 'Attachment storage', value: <span className="mono small">{health.data?.attachmentsDir ?? '—'}</span> },
                { label: 'Backups', value: <span className="mono small">{health.data?.backupsDir ?? '—'}</span> },
                {
                  label: 'Activated',
                  value: bootstrap.data?.activation.activated ? fmtInstant(bootstrap.data.activation.activatedAt) : 'Not activated',
                },
                { label: 'Machine bound', value: bootstrap.data?.activation.machineBound ? 'Yes' : 'No' },
              ]}
            />
          </div>
        )}
      </Card>

      <Card title="Works without the internet">
        <div className="stack">
          <Banner tone="success" title="Fully offline">
            {APP_NAME} never contacts a server. There is no cloud account, no telemetry, no online activation and no artificial-intelligence
            service. Every record, image and report stays inside the folder above, on this computer.
          </Banner>
          <div className="grid-3">
            <div className="row" style={{ gap: 10 }}>
              <WifiOff size={18} />
              <div>
                <div>No network calls</div>
                <div className="small muted">The application works with the network cable unplugged.</div>
              </div>
            </div>
            <div className="row" style={{ gap: 10 }}>
              <Database size={18} />
              <div>
                <div>One SQLite file</div>
                <div className="small muted">Copy it, back it up or move it — nothing is hidden in a cloud.</div>
              </div>
            </div>
            <div className="row" style={{ gap: 10 }}>
              <ShieldCheck size={18} />
              <div>
                <div>Local activation</div>
                <div className="small muted">
                  The activation code is checked on this machine. It proves nothing cryptographically — it is a good-faith licence check,
                  and the records are protected by your own accounts and passwords.
                </div>
              </div>
            </div>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <Ban size={18} />
            <div>
              <div>No hidden dependencies</div>
              <div className="small muted">Only free and open-source libraries are used; every one is listed below with its licence.</div>
            </div>
          </div>
        </div>
      </Card>

      <Card
        title="Third-party notices"
        subtitle={`${LICENSES_PACKAGE_SET} · digest ${LICENSES_DIGEST.slice(0, 16)}…`}
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Segmented
              value={scope}
              options={[
                { value: 'direct', label: 'Direct' },
                { value: 'all', label: 'All packages' },
              ]}
              onChange={(value) => setScope(value as 'direct' | 'all')}
            />
            <Button size="sm" icon={<RefreshCw size={14} />} onClick={() => void openExternal(RELEASES_URL)}>
              Release notes
            </Button>
          </div>
        }
        padded={false}
      >
        <div className="row" style={{ padding: 'var(--space-4)' }}>
          <div style={{ minWidth: 260, flex: 1 }}>
            <SearchInput value={filter} placeholder="Search a package or licence…" onChange={setFilter} />
          </div>
          <span className="small muted">{notices.length} shown</span>
        </div>
        <DataTable
          columns={[
            { key: 'name', label: 'Package' },
            { key: 'version', label: 'Version' },
            { key: 'license', label: 'Licence' },
            { key: 'copyright', label: 'Copyright' },
          ]}
          rows={notices.map((entry) => ({
            name: (
              <span className="mono small">
                {entry.name}
                {entry.direct ? <Badge>direct</Badge> : null}
              </span>
            ),
            version: entry.version,
            license: entry.license,
            copyright: entry.copyright ?? '—',
          }))}
          rowKey={(index) => `${notices[index]?.name ?? index}@${notices[index]?.version ?? ''}`}
          empty={<Empty title="No package matches that search" icon={<ScrollText size={24} />} />}
        />
      </Card>

      <Card title="Keeping this copy up to date">
        <div className="stack">
          <p className="small muted" style={{ margin: 0 }}>
            Dentiva Pro is installed manually and updated by running a newer installer. An update never touches the data folder: patients,
            images, invoices, backups and settings stay exactly where they are.
          </p>
          <div className="row" style={{ gap: 10 }}>
            <Cpu size={18} />
            <span className="small">
              Current build {APP_VERSION} ({APP_BUILD_NUMBER}) on {system.data?.architecture ?? '—'}
            </span>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <HardDrive size={18} />
            <span className="small">Before updating, create a backup from Backup &amp; data and copy it to another drive.</span>
          </div>
        </div>
      </Card>

      <Card title="Support">
        <div className="stack">
          <p style={{ margin: 0 }}>
            Write to <span className="mono">{APP_AUTHOR_EMAIL}</span> and include the version above, what you were doing, and any message
            shown on screen. The technical log can be opened from Backup &amp; data → Data &amp; maintenance.
          </p>
          <Field label="Author">
            <span>
              {APP_AUTHOR_NAME} · {APP_AUTHOR_EMAIL}
            </span>
          </Field>
          <Banner tone="info" title="Your data is yours">
            Because everything is local, support can only help with the application itself. Keep your own backups — the application will
            never send your records anywhere, not even for troubleshooting.
          </Banner>
        </div>
      </Card>
    </Page>
  );
}
