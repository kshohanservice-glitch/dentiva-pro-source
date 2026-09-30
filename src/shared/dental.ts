/**
 * Dental chart model.
 *
 * FDI (ISO 3950) is the canonical internal notation: a tooth is identified by
 * its two-digit FDI code. Universal and Palmer notations are *display*
 * projections of the same tooth, so switching the display system can never
 * change the underlying clinical data.
 *
 *   Permanent quadrants: 1 = upper right, 2 = upper left, 3 = lower left, 4 = lower right
 *   Primary quadrants:   5 = upper right, 6 = upper left, 7 = lower left, 8 = lower right
 *
 * Verified Universal mapping (anatomical order, clockwise from the upper-right
 * third molar):
 *   18→1 … 11→8, 21→9 … 28→16, 38→17 … 31→24, 41→25 … 48→32  (1–32)
 *   55→A … 51→E, 61→F … 65→J, 75→K … 71→O, 81→P … 85→T  (A–T)
 */
import type { DentitionType, MobilityGrade, ToothFindingType, ToothNumberingSystem, ToothSurface } from './constants';

export interface ToothDefinition {
  /** FDI two-digit code, the canonical identifier (e.g. '36'). */
  readonly fdi: string;
  readonly dentition: DentitionType;
  readonly quadrant: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  /** Position inside the quadrant: 1 = central incisor … 8 = third molar. */
  readonly position: number;
  readonly name: string;
  readonly shortName: string;
  /** Universal number (permanent) or 1–20 index (primary, rendered as A–T). */
  readonly universal: number;
  readonly palmer: string;
  readonly arch: 'upper' | 'lower';
  readonly side: 'right' | 'left';
  readonly kind: 'incisor' | 'canine' | 'premolar' | 'molar';
  readonly surfaces: readonly ToothSurface[];
}

interface PositionDefinition {
  readonly position: number;
  readonly name: string;
  readonly shortName: string;
  readonly kind: ToothDefinition['kind'];
}

const PERMANENT_POSITIONS: readonly PositionDefinition[] = [
  { position: 1, name: 'central incisor', shortName: 'CI', kind: 'incisor' },
  { position: 2, name: 'lateral incisor', shortName: 'LI', kind: 'incisor' },
  { position: 3, name: 'canine', shortName: 'C', kind: 'canine' },
  { position: 4, name: 'first premolar', shortName: 'PM1', kind: 'premolar' },
  { position: 5, name: 'second premolar', shortName: 'PM2', kind: 'premolar' },
  { position: 6, name: 'first molar', shortName: 'M1', kind: 'molar' },
  { position: 7, name: 'second molar', shortName: 'M2', kind: 'molar' },
  { position: 8, name: 'third molar', shortName: 'M3', kind: 'molar' },
];

const PRIMARY_POSITIONS: readonly PositionDefinition[] = [
  { position: 1, name: 'primary central incisor', shortName: 'Ci', kind: 'incisor' },
  { position: 2, name: 'primary lateral incisor', shortName: 'Li', kind: 'incisor' },
  { position: 3, name: 'primary canine', shortName: 'c', kind: 'canine' },
  { position: 4, name: 'primary first molar', shortName: 'm1', kind: 'molar' },
  { position: 5, name: 'primary second molar', shortName: 'm2', kind: 'molar' },
];

const ANTERIOR_SURFACES: readonly ToothSurface[] = ['mesial', 'distal', 'buccal', 'lingual', 'incisal'];
const POSTERIOR_SURFACES: readonly ToothSurface[] = ['mesial', 'distal', 'buccal', 'lingual', 'occlusal'];

const PALMER_QUADRANT: Readonly<Record<number, string>> = { 1: '\u2310', 2: '\u00AC', 3: 'L', 4: 'J', 5: '\u2310', 6: '\u00AC', 7: 'L', 8: 'J' };

/** Universal numbering for permanent teeth, per FDI quadrant. */
function permanentUniversal(quadrant: number, position: number): number {
  if (quadrant === 1) return 9 - position;
  if (quadrant === 2) return 8 + position;
  if (quadrant === 3) return 25 - position;
  // Quadrant 4 runs with the numbering, not against it: 41 → 25 … 48 → 32.
  return 24 + position;
}

/** Universal letter order for primary teeth (A–T). */
const PRIMARY_UNIVERSAL_ORDER: readonly string[] = [
  '55', '54', '53', '52', '51', '61', '62', '63', '64', '65',
  '75', '74', '73', '72', '71', '81', '82', '83', '84', '85',
];

function buildPermanent(): ToothDefinition[] {
  const teeth: ToothDefinition[] = [];
  for (const quadrant of [1, 2, 3, 4] as const) {
    const upper = quadrant === 1 || quadrant === 2;
    const right = quadrant === 1 || quadrant === 4;
    for (const entry of PERMANENT_POSITIONS) {
      teeth.push({
        fdi: `${quadrant}${entry.position}`,
        dentition: 'permanent',
        quadrant,
        position: entry.position,
        name: `${upper ? 'Upper' : 'Lower'} ${right ? 'right' : 'left'} ${entry.name}`,
        shortName: entry.shortName,
        universal: permanentUniversal(quadrant, entry.position),
        palmer: `${PALMER_QUADRANT[quadrant] ?? ''}${entry.position}`,
        arch: upper ? 'upper' : 'lower',
        side: right ? 'right' : 'left',
        kind: entry.kind,
        surfaces: entry.kind === 'incisor' || entry.kind === 'canine' ? ANTERIOR_SURFACES : POSTERIOR_SURFACES,
      });
    }
  }
  return teeth;
}

function buildPrimary(): ToothDefinition[] {
  const teeth: ToothDefinition[] = [];
  for (const quadrant of [5, 6, 7, 8] as const) {
    const upper = quadrant === 5 || quadrant === 6;
    const right = quadrant === 5 || quadrant === 8;
    for (const entry of PRIMARY_POSITIONS) {
      const fdi = `${quadrant}${entry.position}`;
      teeth.push({
        fdi,
        dentition: 'primary',
        quadrant,
        position: entry.position,
        name: `${upper ? 'Upper' : 'Lower'} ${right ? 'right' : 'left'} ${entry.name}`,
        shortName: entry.shortName,
        universal: PRIMARY_UNIVERSAL_ORDER.indexOf(fdi) + 1,
        palmer: `${PALMER_QUADRANT[quadrant] ?? ''}${entry.position}`,
        arch: upper ? 'upper' : 'lower',
        side: right ? 'right' : 'left',
        kind: entry.kind,
        surfaces: entry.kind === 'incisor' || entry.kind === 'canine' ? ANTERIOR_SURFACES : POSTERIOR_SURFACES,
      });
    }
  }
  return teeth;
}

export const PERMANENT_TEETH: readonly ToothDefinition[] = buildPermanent();
export const PRIMARY_TEETH: readonly ToothDefinition[] = buildPrimary();
export const ALL_TEETH: readonly ToothDefinition[] = [...PERMANENT_TEETH, ...PRIMARY_TEETH];

const TOOTH_BY_FDI = new Map(ALL_TEETH.map((tooth) => [tooth.fdi, tooth]));

export function toothByFdi(fdi: string): ToothDefinition | undefined {
  return TOOTH_BY_FDI.get(fdi);
}

export function isToothFdi(value: string): boolean {
  return TOOTH_BY_FDI.has(value);
}

export function teethForDentition(dentition: DentitionType): readonly ToothDefinition[] {
  return dentition === 'primary' ? PRIMARY_TEETH : PERMANENT_TEETH;
}

/** Upper arch in clinical display order: patient's right → patient's left. */
export function archLayout(dentition: DentitionType): { upper: ToothDefinition[]; lower: ToothDefinition[] } {
  const pick = (codes: readonly string[]): ToothDefinition[] =>
    codes.map((code) => TOOTH_BY_FDI.get(code)).filter((tooth): tooth is ToothDefinition => tooth !== undefined);
  if (dentition === 'primary') {
    return {
      upper: pick(['55', '54', '53', '52', '51', '61', '62', '63', '64', '65']),
      lower: pick(['85', '84', '83', '82', '81', '71', '72', '73', '74', '75']),
    };
  }
  return {
    upper: pick(['18', '17', '16', '15', '14', '13', '12', '11', '21', '22', '23', '24', '25', '26', '27', '28']),
    lower: pick(['48', '47', '46', '45', '44', '43', '42', '41', '31', '32', '33', '34', '35', '36', '37', '38']),
  };
}

export interface QuadrantLayout {
  readonly quadrant: number;
  readonly label: string;
  readonly teeth: ToothDefinition[];
}

export function quadrants(dentition: DentitionType): QuadrantLayout[] {
  const teeth = dentition === 'primary' ? PRIMARY_TEETH : PERMANENT_TEETH;
  const definitions: Array<{ quadrant: number; label: string }> = dentition === 'primary'
    ? [
        { quadrant: 5, label: 'Upper right (primary)' },
        { quadrant: 6, label: 'Upper left (primary)' },
        { quadrant: 7, label: 'Lower left (primary)' },
        { quadrant: 8, label: 'Lower right (primary)' },
      ]
    : [
        { quadrant: 1, label: 'Upper right' },
        { quadrant: 2, label: 'Upper left' },
        { quadrant: 3, label: 'Lower left' },
        { quadrant: 4, label: 'Lower right' },
      ];
  return definitions.map((definition) => ({
    ...definition,
    teeth: teeth.filter((tooth) => tooth.quadrant === definition.quadrant),
  }));
}

export function formatToothCode(tooth: ToothDefinition, system: ToothNumberingSystem): string {
  switch (system) {
    case 'universal':
      return tooth.dentition === 'primary'
        ? String.fromCharCode(64 + tooth.universal)
        : String(tooth.universal);
    case 'palmer':
      return tooth.palmer;
    case 'fdi':
    default:
      return tooth.fdi;
  }
}

export function numberingSample(system: ToothNumberingSystem, dentition: DentitionType = 'permanent'): string {
  const reference = dentition === 'primary' ? '55' : '16';
  const tooth = TOOTH_BY_FDI.get(reference);
  return tooth ? formatToothCode(tooth, system) : reference;
}

/** Findings that visually mark the whole tooth rather than a single surface. */
export const WHOLE_TOOTH_FINDINGS: readonly ToothFindingType[] = [
  'missing', 'extracted', 'crown', 'root_canal', 'impacted', 'implant', 'mobility', 'pontic', 'bridge_abutment', 'other',
];

export function findingAppliesToSurfaces(finding: ToothFindingType): boolean {
  return !WHOLE_TOOTH_FINDINGS.includes(finding);
}

export function surfaceLabel(surface: ToothSurface, tooth?: ToothDefinition): string {
  if (surface === 'occlusal' && tooth && (tooth.kind === 'incisor' || tooth.kind === 'canine')) return 'Incisal';
  return surface.charAt(0).toUpperCase() + surface.slice(1);
}

export interface MobilityDescriptor {
  readonly grade: MobilityGrade;
  readonly label: string;
  readonly description: string;
}

export const MOBILITY_GRADES: readonly MobilityDescriptor[] = [
  { grade: 0, label: 'None', description: 'No detectable mobility' },
  { grade: 1, label: 'Grade I', description: 'Up to 1 mm horizontal movement' },
  { grade: 2, label: 'Grade II', description: 'More than 1 mm horizontal movement' },
  { grade: 3, label: 'Grade III', description: 'Depressible / vertically mobile' },
];

export function mobilityLabel(grade: number): string {
  return MOBILITY_GRADES.find((entry) => entry.grade === grade)?.label ?? 'None';
}

/**
 * Periodontal probing model — six sites per tooth, matching common clinical
 * charting practice. Values are millimetres (0–15).
 */
export type PerioSite = 'mb' | 'b' | 'db' | 'ml' | 'l' | 'dl';
export const PERIO_SITES: ReadonlyArray<{ site: PerioSite; label: string }> = [
  { site: 'mb', label: 'Mesio-buccal' },
  { site: 'b', label: 'Buccal' },
  { site: 'db', label: 'Disto-buccal' },
  { site: 'ml', label: 'Mesio-lingual' },
  { site: 'l', label: 'Lingual' },
  { site: 'dl', label: 'Disto-lingual' },
];
export const MAX_POCKET_DEPTH_MM = 15;

/** Stable anatomical ordering used for chart summaries and printouts. */
export function sortByFdiOrder(codes: readonly string[]): string[] {
  const index = new Map(ALL_TEETH.map((tooth, position) => [tooth.fdi, position]));
  return [...codes].sort((a, b) => (index.get(a) ?? 999) - (index.get(b) ?? 999));
}

export function describeToothChartSummary(findings: ReadonlyArray<{ toothFdi: string; finding: ToothFindingType }>): string {
  if (findings.length === 0) return 'No dental chart findings recorded';
  const byFinding = new Map<ToothFindingType, string[]>();
  for (const finding of findings) {
    const list = byFinding.get(finding.finding) ?? [];
    list.push(finding.toothFdi);
    byFinding.set(finding.finding, list);
  }
  return [...byFinding.entries()]
    .map(([finding, teeth]) => `${finding.replace(/_/g, ' ')}: ${sortByFdiOrder(teeth).join(', ')}`)
    .join(' · ');
}
