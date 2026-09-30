/**
 * Dental chart.
 *
 * Findings are stored per tooth in FDI notation with an append-friendly model:
 * writing a tooth's state deactivates that tooth's previous active findings and
 * inserts the new set, so the full clinical history of every tooth remains
 * queryable (`dental.history`) and nothing is destroyed.
 */
import type { SqliteDatabase } from '../db/connection';
import type { CoreContext } from '../context';
import { currentUserId, requirePermission } from '../context';
import type { DentalChart, PerioRecord, ToothFinding, ToothFindingInput } from '@shared/types';
import type { DentitionType, MobilityGrade, ToothFindingType, ToothNumberingSystem, ToothSurface } from '@shared/constants';
import { AppError } from '@shared/errors';
import { formatToothCode, isToothFdi, toothByFdi } from '@shared/dental';
import { asNumber, asString, fromBoolInt, parseJsonArray, toJsonArray } from '../db/sql';
import { describeToothChartSummary } from '@shared/dental';

export interface SaveFindingsInput {
  patientId: number;
  dentition: DentitionType;
  findings: ToothFindingInput[];
  visitId: number | null;
  clearTeeth: string[];
  userId: number | null;
}

export class DentalService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  mapFindingRow(row: Record<string, unknown>): ToothFinding {
    return {
      id: asNumber(row['id']),
      patientId: asNumber(row['patient_id']),
      toothFdi: asString(row['tooth_fdi']),
      finding: asString(row['finding'], 'healthy') as ToothFindingType,
      surfaces: parseJsonArray(row['surfaces']) as ToothSurface[],
      mobilityGrade: asNumber(row['mobility_grade']) as MobilityGrade,
      note: asString(row['note']),
      visitId: row['visit_id'] === null || row['visit_id'] === undefined ? null : asNumber(row['visit_id']),
      visitDate: row['visit_date'] === null || row['visit_date'] === undefined ? null : asString(row['visit_date']),
      recordedAt: asString(row['recorded_at'], this.context().instant()),
      recordedByName: asString(row['recorded_by_name'], '—'),
      isActive: fromBoolInt(row['is_active']),
    };
  }

  private ensureChart(patientId: number, dentition: DentitionType): number {
    const existing = this.db.prepare(`SELECT id FROM dental_charts WHERE patient_id = ? AND dentition = ?`).get(patientId, dentition) as
      | { id: number }
      | undefined;
    if (existing) return existing.id;
    const numbering = this.context().db.prepare(`SELECT value FROM app_settings WHERE key = 'defaultToothNumbering'`).get() as
      | { value: string }
      | undefined;
    let numberingSystem: ToothNumberingSystem = 'fdi';
    if (numbering) {
      try {
        const parsed = JSON.parse(numbering.value) as unknown;
        if (parsed === 'universal' || parsed === 'palmer' || parsed === 'fdi') numberingSystem = parsed;
      } catch {
        numberingSystem = 'fdi';
      }
    }
    const result = this.db
      .prepare(`INSERT INTO dental_charts (patient_id, dentition, numbering_system, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(patientId, dentition, numberingSystem, currentUserId(this.context()), this.context().instant());
    return Number(result.lastInsertRowid);
  }

  getChart(input: { patientId: number; dentition?: DentitionType; numberingSystem?: ToothNumberingSystem }): DentalChart {
    requirePermission(this.context(), 'chart.view');
    if (!isToothFdi('11')) throw AppError.integrity('Tooth catalogue is unavailable');
    const dentition = input.dentition ?? 'permanent';
    const patient = this.db.prepare(`SELECT id FROM patients WHERE id = ? AND deleted_at IS NULL`).get(input.patientId) as
      | { id: number }
      | undefined;
    if (!patient) throw AppError.notFound('Patient');
    const chartId = this.ensureChart(input.patientId, dentition);
    if (input.numberingSystem) {
      this.db.prepare(`UPDATE dental_charts SET numbering_system = ? WHERE id = ?`).run(input.numberingSystem, chartId);
    }
    const chartRow = this.db.prepare(`SELECT numbering_system, updated_at, updated_by FROM dental_charts WHERE id = ?`).get(chartId) as {
      numbering_system: string;
      updated_at: string;
      updated_by: number | null;
    };
    const findings = this.db
      .prepare(
        `SELECT tf.*, u.full_name AS recorded_by_name, v.visit_date FROM tooth_findings tf
           LEFT JOIN users u ON u.id = tf.recorded_by
           LEFT JOIN visits v ON v.id = tf.visit_id
          WHERE tf.chart_id = ? AND tf.is_active = 1
          ORDER BY tf.tooth_fdi, tf.id`,
      )
      .all(chartId) as Array<Record<string, unknown>>;
    const perio = this.db
      .prepare(
        `SELECT id, patient_id, tooth_fdi, site, depth_mm, recorded_at FROM perio_records
          WHERE patient_id = ? ORDER BY recorded_at DESC LIMIT 400`,
      )
      .all(input.patientId) as Array<Record<string, unknown>>;
    const updatedBy = chartRow.updated_by
      ? (this.db.prepare(`SELECT full_name FROM users WHERE id = ?`).get(chartRow.updated_by) as { full_name: string } | undefined)
      : undefined;
    return {
      patientId: input.patientId,
      dentition,
      numberingSystem: chartRow.numbering_system as ToothNumberingSystem,
      findings: findings.map((row) => this.mapFindingRow(row)),
      perio: perio.map((row) => this.mapPerioRow(row)),
      updatedAt: findings.length > 0 ? chartRow.updated_at : null,
      updatedByName: updatedBy?.full_name ?? null,
    };
  }

  private mapPerioRow(row: Record<string, unknown>): PerioRecord {
    return {
      id: asNumber(row['id']),
      patientId: asNumber(row['patient_id']),
      toothFdi: asString(row['tooth_fdi']),
      site: asString(row['site']),
      depthMm: asNumber(row['depth_mm']),
      recordedAt: asString(row['recorded_at'], this.context().instant()),
    };
  }

  saveFindings(input: {
    patientId: number;
    dentition: DentitionType;
    findings: ToothFindingInput[];
    visitId?: number | null;
    clearTeeth?: string[];
  }): DentalChart {
    requirePermission(this.context(), 'chart.edit');
    this.saveFindingsInternal({
      patientId: input.patientId,
      dentition: input.dentition,
      findings: input.findings,
      visitId: input.visitId ?? null,
      clearTeeth: input.clearTeeth ?? [],
      userId: currentUserId(this.context()),
    });
    return this.getChart({ patientId: input.patientId, dentition: input.dentition });
  }

  /** Internal entry point used by the visit service (permission already checked). */
  saveFindingsInternal(input: SaveFindingsInput): void {
    const ctx = this.context();
    for (const finding of input.findings) {
      if (!isToothFdi(finding.toothFdi)) {
        throw AppError.validation(`Tooth code ${finding.toothFdi} is not a valid FDI tooth.`, { toothFdi: 'Unknown tooth.' });
      }
      const tooth = toothByFdi(finding.toothFdi);
      if (tooth && tooth.dentition !== input.dentition) {
        throw AppError.validation(`Tooth ${finding.toothFdi} belongs to the ${tooth.dentition} dentition, not ${input.dentition}.`, {
          toothFdi: 'Wrong dentition for this tooth.',
        });
      }
      if (finding.mobilityGrade < 0 || finding.mobilityGrade > 3) {
        throw AppError.validation('Mobility must be between 0 and III.', { mobilityGrade: 'Select a valid mobility grade.' });
      }
      for (const surface of finding.surfaces) {
        const valid = tooth?.surfaces.includes(surface) ?? false;
        if (!valid) {
          throw AppError.validation(`Surface “${surface}” does not apply to tooth ${finding.toothFdi}.`, {
            surfaces: `Surface “${surface}” is not valid for this tooth.`,
          });
        }
      }
    }

    const chartId = this.ensureChart(input.patientId, input.dentition);
    const now = this.context().instant();
    const affectedTeeth = new Set<string>([...input.findings.map((finding) => finding.toothFdi), ...input.clearTeeth]);

    const run = this.db.transaction(() => {
      const deactivate = this.db.prepare(`UPDATE tooth_findings SET is_active = 0 WHERE chart_id = ? AND tooth_fdi = ? AND is_active = 1`);
      const insert = this.db.prepare(
        `INSERT INTO tooth_findings
           (patient_id, chart_id, tooth_fdi, finding, surfaces, mobility_grade, note, visit_id, recorded_by, recorded_at, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      );
      for (const toothFdi of affectedTeeth) deactivate.run(chartId, toothFdi);
      for (const finding of input.findings) {
        if (finding.finding === 'healthy' && finding.surfaces.length === 0) continue;
        insert.run(
          input.patientId,
          chartId,
          finding.toothFdi,
          finding.finding,
          toJsonArray(finding.surfaces),
          finding.mobilityGrade,
          finding.note.trim(),
          input.visitId,
          input.userId,
          now,
        );
      }
      this.db.prepare(`UPDATE dental_charts SET updated_at = ?, updated_by = ? WHERE id = ?`).run(now, input.userId, chartId);
      this.db.prepare(`UPDATE dental_charts SET numbering_system = numbering_system WHERE id = ?`).run(chartId);
      ctx.audit.record({
        action: 'update',
        entityType: 'dental_chart',
        entityId: chartId,
        entityLabel: `Dental chart (${input.dentition})`,
        detail: `Chart updated for ${affectedTeeth.size} tooth/teeth`,
        after: {
          teeth: [...affectedTeeth].sort(),
          findings: input.findings.map((finding) => ({
            tooth: finding.toothFdi,
            finding: finding.finding,
            surfaces: finding.surfaces,
            mobility: finding.mobilityGrade,
          })),
        },
      });
    });
    run();
    ctx.notify?.('dental.changed', { patientId: input.patientId });
  }

  history(patientId: number, toothFdi: string): ToothFinding[] {
    requirePermission(this.context(), 'chart.view');
    const rows = this.db
      .prepare(
        `SELECT tf.*, u.full_name AS recorded_by_name, v.visit_date FROM tooth_findings tf
           LEFT JOIN users u ON u.id = tf.recorded_by
           LEFT JOIN visits v ON v.id = tf.visit_id
          WHERE tf.patient_id = ? AND tf.tooth_fdi = ?
          ORDER BY tf.recorded_at DESC, tf.id DESC`,
      )
      .all(patientId, toothFdi) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapFindingRow(row));
  }

  savePerio(input: { patientId: number; records: Array<{ toothFdi: string; site: string; depthMm: number }> }): DentalChart {
    requirePermission(this.context(), 'chart.edit');
    const now = this.context().instant();
    const userId = currentUserId(this.context());
    const validSites = new Set(['mb', 'b', 'db', 'ml', 'l', 'dl']);
    const run = this.db.transaction(() => {
      const insert = this.db.prepare(
        `INSERT INTO perio_records (patient_id, tooth_fdi, site, depth_mm, recorded_at, recorded_by) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const record of input.records) {
        if (!isToothFdi(record.toothFdi)) throw AppError.validation(`Invalid tooth code ${record.toothFdi}.`);
        if (!validSites.has(record.site)) throw AppError.validation(`Invalid periodontal site ${record.site}.`);
        if (!Number.isFinite(record.depthMm) || record.depthMm < 0 || record.depthMm > 15) {
          throw AppError.validation('Pocket depth must be between 0 and 15 mm.', { depthMm: 'Enter 0–15 mm.' });
        }
        insert.run(input.patientId, record.toothFdi, record.site, Math.round(record.depthMm), now, userId);
      }
      this.context().audit.record({
        action: 'update',
        entityType: 'perio_chart',
        entityId: input.patientId,
        entityLabel: 'Periodontal chart',
        detail: `Recorded ${input.records.length} probing measurement(s)`,
      });
    });
    run();
    return this.getChart({ patientId: input.patientId });
  }

  clear(input: { patientId: number; dentition: DentitionType; confirmText?: string }): DentalChart {
    requirePermission(this.context(), 'chart.edit');
    if (input.confirmText?.trim().toUpperCase() !== 'CLEAR') {
      throw AppError.validation('Type CLEAR to remove every finding on this chart.', { confirmText: 'Type CLEAR to confirm.' });
    }
    const chart = this.db
      .prepare(`SELECT id FROM dental_charts WHERE patient_id = ? AND dentition = ?`)
      .get(input.patientId, input.dentition) as { id: number } | undefined;
    if (!chart) return this.getChart({ patientId: input.patientId, dentition: input.dentition });
    const ctx = this.context();
    const now = this.context().instant();
    this.db.transaction(() => {
      const count = asNumber(
        (
          this.db.prepare(`SELECT COUNT(*) AS total FROM tooth_findings WHERE chart_id = ? AND is_active = 1`).get(chart.id) as {
            total: number;
          }
        ).total,
      );
      this.db.prepare(`DELETE FROM tooth_findings WHERE chart_id = ?`).run(chart.id);
      this.db.prepare(`UPDATE dental_charts SET updated_at = ?, updated_by = ? WHERE id = ?`).run(now, currentUserId(ctx), chart.id);
      ctx.audit.record({
        action: 'destructive',
        entityType: 'dental_chart',
        entityId: chart.id,
        entityLabel: `Dental chart (${input.dentition})`,
        detail: `Chart cleared (${count} finding row(s) removed). Reason: chart reset by user`,
        severity: 'critical',
        before: { activeFindings: count },
        after: { activeFindings: 0 },
      });
    })();
    return this.getChart({ patientId: input.patientId, dentition: input.dentition });
  }

  /** Convenience for the visit print/report layer. */
  summary(patientId: number, dentition: DentitionType = 'permanent'): string {
    const rows = this.db
      .prepare(`SELECT tooth_fdi AS toothFdi, finding FROM tooth_findings WHERE patient_id = ? AND is_active = 1`)
      .all(patientId) as Array<{ toothFdi: string; finding: ToothFindingType }>;
    void dentition;
    return describeToothChartSummary(rows);
  }

  /** Format a tooth code for display in a chart summary. */
  formatCode(toothFdi: string, system: ToothNumberingSystem): string {
    const tooth = toothByFdi(toothFdi);
    return tooth ? formatToothCode(tooth, system) : toothFdi;
  }
}
