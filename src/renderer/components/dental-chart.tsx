/**
 * Interactive dental chart.
 *
 * Design goals:
 *   • the same component renders the adult and the primary dentition,
 *   • FDI is the identity of the tooth; Universal/Palmer are display only,
 *   • findings are structured (type + surfaces + mobility + note) — never free
 *     text smuggled into a colour,
 *   • fully operable with the mouse and the keyboard (arrows move, Enter opens),
 *   • every save goes through `dental.saveFindings`, which keeps the previous
 *     state as history inside the same transaction.
 */
import { useEffect, useMemo, useState } from 'react';
import { Eraser, Info, Keyboard, Save, Stethoscope } from 'lucide-react';
import {
  SURFACE_SCOPED_FINDINGS,
  TOOTH_FINDING_COLOURS,
  TOOTH_FINDING_LABELS,
  TOOTH_FINDING_TYPES,
  TOOTH_NUMBERING_SYSTEMS,
  TOOTH_SURFACES,
} from '@shared/constants';
import type { DentitionType, MobilityGrade, ToothFindingType, ToothNumberingSystem, ToothSurface } from '@shared/constants';
import { archLayout, formatToothCode, MAX_POCKET_DEPTH_MM, MOBILITY_GRADES, PERIO_SITES } from '@shared/dental';
import type { DentalChart, ToothFinding, ToothFindingInput } from '@shared/types';
import { useAction, useApp } from '@renderer/state/store';
import { bridge } from '@renderer/lib/bridge';
import { fmtDate, fmtDateTime } from '@renderer/lib/format';
import { Badge, Button, Chip, Empty, Input, Segmented, Select, Switch, TextArea } from './ui';

interface Draft {
  findings: ToothFindingType[];
  surfaces: ToothSurface[];
  mobility: MobilityGrade;
  note: string;
}

const EMPTY_DRAFT: Draft = { findings: [], surfaces: [], mobility: 0, note: '' };

function draftFrom(findings: readonly ToothFinding[]): Draft {
  const active = findings.filter((finding) => finding.isActive);
  return {
    findings: active.map((finding) => finding.finding),
    surfaces: [...new Set(active.flatMap((finding) => finding.surfaces))],
    mobility: (active.find((finding) => finding.mobilityGrade > 0)?.mobilityGrade ?? 0) as MobilityGrade,
    note: active.map((finding) => finding.note).filter(Boolean).join(' '),
  };
}

export function DentalChartView({
  patientId,
  canEdit,
  dentition: initialDentition,
  numberingSystem: initialNumbering,
  compact = false,
}: {
  patientId: number;
  canEdit: boolean;
  dentition?: DentitionType;
  numberingSystem?: ToothNumberingSystem;
  compact?: boolean;
}): JSX.Element {
  const { toast } = useApp();
  const { run, busy } = useAction();
  const [dentition, setDentition] = useState<DentitionType>(initialDentition ?? 'permanent');
  const [numbering, setNumbering] = useState<ToothNumberingSystem>(initialNumbering ?? 'fdi');
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [perioMode, setPerioMode] = useState(false);
  const [perio, setPerio] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<readonly ToothFinding[]>([]);
  const [chart, setChart] = useState<DentalChart | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const result = await bridge.invoke('dental.getChart', { patientId, dentition, numberingSystem: numbering });
      setChart(result);
    } catch (error) {
      toast('error', 'The dental chart could not be loaded.', (error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId, dentition, numbering]);

  const arches = useMemo(() => archLayout(dentition), [dentition]);
  const findings = chart?.findings.filter((finding) => finding.isActive) ?? [];
  const byTooth = useMemo(() => {
    const map = new Map<string, ToothFinding[]>();
    for (const finding of findings) {
      const list = map.get(finding.toothFdi) ?? [];
      list.push(finding);
      map.set(finding.toothFdi, list);
    }
    return map;
  }, [findings]);

  const perioByTooth = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    for (const record of chart?.perio ?? []) {
      const sites = map.get(record.toothFdi) ?? new Map<string, number>();
      sites.set(record.site, record.depthMm);
      map.set(record.toothFdi, sites);
    }
    return map;
  }, [chart]);

  useEffect(() => {
    if (!selected) return;
    const toothFindings = byTooth.get(selected) ?? [];
    setDraft(draftFrom(toothFindings));
    void bridge
      .invoke('dental.history', { patientId, toothFdi: selected })
      .then(setHistory)
      .catch(() => setHistory([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, chart]);

  const toothColour = (fdi: string): string | undefined => {
    const list = byTooth.get(fdi);
    if (!list || list.length === 0) return undefined;
    const priority: ToothFindingType[] = [
      'missing', 'extracted', 'implant', 'caries', 'root_canal', 'crown', 'filled', 'fracture', 'mobility',
      'impacted', 'bridge_abutment', 'pontic', 'sealant',
    ];
    for (const type of priority) {
      if (list.some((finding) => finding.finding === type)) return TOOTH_FINDING_COLOURS[type];
    }
    return TOOTH_FINDING_COLOURS[list[0]!.finding];
  };

  const toggleFinding = (type: ToothFindingType) => {
    setDraft((current) => {
      const has = current.findings.includes(type);
      const next = has ? current.findings.filter((value) => value !== type) : [...current.findings, type];
      // A whole-tooth finding carries no surface information.
      const surfaces = next.some((value) => SURFACE_SCOPED_FINDINGS.includes(value)) ? current.surfaces : [];
      return { ...current, findings: next, surfaces };
    });
  };

  const toggleSurface = (surface: ToothSurface) => {
    setDraft((current) => ({
      ...current,
      surfaces: current.surfaces.includes(surface)
        ? current.surfaces.filter((value) => value !== surface)
        : [...current.surfaces, surface],
    }));
  };

  const saveTooth = async () => {
    if (!selected) return;
    const list: ToothFindingInput[] = draft.findings.map((finding) => ({
      toothFdi: selected,
      finding,
      surfaces: SURFACE_SCOPED_FINDINGS.includes(finding) ? draft.surfaces : [],
      mobilityGrade: finding === 'mobility' ? draft.mobility : 0,
      note: draft.note,
    }));
    const result = await run(
      () =>
        bridge.invoke('dental.saveFindings', {
          patientId,
          dentition,
          findings: list,
          clearTeeth: list.length === 0 ? [selected] : [],
        }),
      { success: `Tooth ${selected} updated.`, failure: 'The tooth could not be saved.' },
    );
    if (result) setChart(result);
  };

  const savePerio = async () => {
    const records = Object.entries(perio)
      .map(([key, value]) => {
        const [toothFdi, site] = key.split(':');
        const depthMm = Number(value);
        return { toothFdi: toothFdi ?? '', site: site ?? '', depthMm };
      })
      .filter((record) => record.toothFdi && record.site && Number.isFinite(record.depthMm) && record.depthMm > 0);
    if (records.length === 0) {
      toast('info', 'Nothing to save', 'Enter at least one pocket depth.');
      return;
    }
    const result = await run(() => bridge.invoke('dental.savePerio', { patientId, records }), {
      success: `${records.length} pocket depth reading(s) saved.`,
      failure: 'The perio chart could not be saved.',
    });
    if (result) {
      setChart(result);
      setPerio({});
    }
  };

  const clearChart = async () => {
    const confirmed = await run(() =>
      bridge.invoke('dental.clear', { patientId, dentition, confirmText: 'CLEAR' }),
    );
    if (confirmed) {
      setChart(confirmed);
      toast('warning', 'Chart cleared', 'The previous findings remain in the audit history.');
    }
  };

  const surfaceScope = draft.findings.some((finding) => SURFACE_SCOPED_FINDINGS.includes(finding));

  if (loading && !chart) {
    return <div className="skeleton" style={{ height: compact ? 120 : 220 }} />;
  }

  return (
    <div className="chart">
      <div className="row row--between row--wrap">
        <div className="row" style={{ gap: 10 }}>
          <Segmented
            options={[
              { value: 'permanent', label: 'Adult' },
              { value: 'primary', label: 'Child (primary)' },
            ]}
            value={dentition}
            onChange={(value) => setDentition(value as DentitionType)}
          />
          <Segmented
            options={TOOTH_NUMBERING_SYSTEMS.map((option) => ({ value: option.value, label: option.label }))}
            value={numbering}
            onChange={(value) => setNumbering(value as ToothNumberingSystem)}
          />
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Switch label="Perio charting" checked={perioMode} onChange={setPerioMode} />
          {canEdit ? (
            <Button size="sm" variant="ghost" icon={<Eraser size={14} />} loading={busy} onClick={() => void clearChart()}>
              Clear chart
            </Button>
          ) : null}
        </div>
      </div>

      {perioMode ? (
        <div className="stack">
          <div className="banner banner--info">
            <Info size={16} />
            <div className="grow">
              Six sites per tooth (mesio-buccal, buccal, disto-buccal, mesio-lingual, lingual, disto-lingual) in
              millimetres, 1–{MAX_POCKET_DEPTH_MM}. Rows left empty are ignored.
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Tooth</th>
                  {PERIO_SITES.map((site) => (
                    <th key={site.site} title={site.label}>
                      {site.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...arches.upper, ...arches.lower].map((tooth) => {
                  const recorded = perioByTooth.get(tooth.fdi);
                  return (
                    <tr key={tooth.fdi}>
                      <td className="mono">{formatToothCode(tooth, numbering)}</td>
                      {PERIO_SITES.map((site) => (
                        <td key={site.site}>
                          <Input
                            className="input--numeric"
                            inputMode="numeric"
                            style={{ width: 64 }}
                            value={perio[`${tooth.fdi}:${site.site}`] ?? (recorded?.get(site.site)?.toString() ?? '')}
                            onChange={(event) =>
                              setPerio((current) => ({ ...current, [`${tooth.fdi}:${site.site}`]: event.target.value }))
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="row row--end">
            <Button variant="primary" icon={<Save size={15} />} loading={busy} onClick={() => void savePerio()}>
              Save pocket depths
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="chart__arch">
            {(['upper', 'lower'] as const).map((arch) => (
              <div key={arch} className="chart__row">
                {arches[arch].map((tooth) => {
                  const colour = toothColour(tooth.fdi);
                  const isSelected = selected === tooth.fdi;
                  const findingsForTooth = byTooth.get(tooth.fdi) ?? [];
                  return (
                    <button
                      key={tooth.fdi}
                      type="button"
                      className={`tooth ${isSelected ? 'is-selected' : ''}`}
                      style={colour ? { borderColor: colour, background: `${colour}22` } : undefined}
                      title={`${tooth.name} — ${findingsForTooth.map((finding) => TOOTH_FINDING_LABELS[finding.finding]).join(', ') || 'no findings'}`}
                      aria-pressed={isSelected}
                      onMouseDown={() => setSelected(tooth.fdi)}
                      onKeyDown={(event) => {
                        const list = arch === 'upper' ? arches.upper : arches.lower;
                        const index = list.findIndex((entry) => entry.fdi === tooth.fdi);
                        if (event.key === 'ArrowRight') setSelected(list[Math.min(list.length - 1, index + 1)]?.fdi ?? tooth.fdi);
                        if (event.key === 'ArrowLeft') setSelected(list[Math.max(0, index - 1)]?.fdi ?? tooth.fdi);
                        if (event.key === 'ArrowDown') setSelected((arch === 'upper' ? arches.lower : arches.upper)[index]?.fdi ?? tooth.fdi);
                        if (event.key === 'ArrowUp') setSelected((arch === 'lower' ? arches.upper : arches.lower)[index]?.fdi ?? tooth.fdi);
                      }}
                    >
                      <span className="tooth__code">{formatToothCode(tooth, numbering)}</span>
                      <span className="tooth__mark" style={colour ? { background: colour } : undefined} aria-hidden />
                      <span className="tooth__surfaces" aria-hidden>
                        {findingsForTooth.some((finding) => finding.surfaces.length > 0)
                          ? findingsForTooth.flatMap((finding) => finding.surfaces).slice(0, 4).join('·')
                          : ''}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="chart__legend">
            {TOOTH_FINDING_TYPES.map((option) => (
              <span key={option.value} className="chart__legend-item">
                <span className="chart__swatch" style={{ background: TOOTH_FINDING_COLOURS[option.value] }} aria-hidden />
                {option.label}
              </span>
            ))}
          </div>

          {findings.length === 0 ? (
            <Empty
              title="No findings recorded yet"
              text="Pick a tooth above to record caries, restorations, missing teeth and more."
              icon={<Stethoscope size={24} />}
            />
          ) : null}

          {selected ? (
            <div className="card">
              <div className="card__header">
                <div>
                  <h3 className="card__title">
                    Tooth {formatToothCode(
                      [...arches.upper, ...arches.lower].find((tooth) => tooth.fdi === selected)!,
                      numbering,
                    )}
                    <span className="small muted"> ({selected})</span>
                  </h3>
                  <p className="card__subtitle">
                    {[...arches.upper, ...arches.lower].find((tooth) => tooth.fdi === selected)?.name}
                  </p>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
                    Close
                  </Button>
                  {canEdit ? (
                    <Button size="sm" variant="primary" icon={<Save size={14} />} loading={busy} onClick={() => void saveTooth()}>
                      Save findings
                    </Button>
                  ) : null}
                </div>
              </div>
              <div className="card__body stack">
                <div>
                  <div className="field__label">Findings (multiple allowed)</div>
                  <div className="chip-row">
                    {TOOTH_FINDING_TYPES.map((option) => (
                      <Chip
                        key={option.value}
                        selected={draft.findings.includes(option.value)}
                        onClick={canEdit ? () => toggleFinding(option.value) : undefined}
                      >
                        {option.label}
                      </Chip>
                    ))}
                  </div>
                </div>

                {surfaceScope ? (
                  <div>
                    <div className="field__label">Surfaces</div>
                    <div className="chip-row">
                      {TOOTH_SURFACES.map((surface) => (
                        <Chip
                          key={surface.value}
                          selected={draft.surfaces.includes(surface.value)}
                          onClick={canEdit ? () => toggleSurface(surface.value) : undefined}
                        >
                          {surface.label}
                        </Chip>
                      ))}
                    </div>
                  </div>
                ) : null}

                {draft.findings.includes('mobility') ? (
                  <label className="field" style={{ maxWidth: 240 }}>
                    <span className="field__label">Mobility grade</span>
                    <Select
                      value={String(draft.mobility)}
                      options={MOBILITY_GRADES.map((grade) => ({ value: String(grade.grade), label: grade.label }))}
                      onChange={(event) => setDraft((current) => ({ ...current, mobility: Number(event.target.value) as MobilityGrade }))}
                    />
                  </label>
                ) : null}

                <label className="field">
                  <span className="field__label">Note for this tooth</span>
                  <TextArea
                    rows={2}
                    value={draft.note}
                    disabled={!canEdit}
                    onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))}
                  />
                </label>

                <div>
                  <div className="field__label">Tooth history</div>
                  {history.length === 0 ? (
                    <div className="small muted">No previous findings for this tooth.</div>
                  ) : (
                    <div className="stack stack--sm">
                      {history.slice(0, 6).map((entry) => (
                        <div key={entry.id} className="row row--between">
                          <span>
                            {TOOTH_FINDING_LABELS[entry.finding]}
                            {entry.surfaces.length > 0 ? ` · ${entry.surfaces.join(', ')}` : ''}
                            {entry.isActive ? null : <span className="small muted"> (superseded)</span>}
                          </span>
                          <span className="small muted">
                            {entry.visitDate ? `${fmtDate(entry.visitDate)} · ` : ''}
                            {entry.recordedByName} · {fmtDateTime(entry.recordedAt)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="row row--wrap small muted" style={{ gap: 8 }}>
                  <Keyboard size={14} /> Arrow keys move between teeth; Enter opens the selected tooth.
                  {chart?.updatedAt ? <Badge>Updated {fmtDateTime(chart.updatedAt)}</Badge> : null}
                  {chart?.updatedByName ? <span>by {chart.updatedByName}</span> : null}
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
