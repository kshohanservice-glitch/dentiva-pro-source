import { describe, expect, it } from 'vitest';
import {
  ALL_TEETH,
  formatToothCode,
  archLayout,
  describeToothChartSummary,
  findingAppliesToSurfaces,
  isToothFdi,
  MAX_POCKET_DEPTH_MM,
  mobilityLabel,
  PERIO_SITES,
  PERMANENT_TEETH,
  PRIMARY_TEETH,
  quadrants,
  sortByFdiOrder,
  toothByFdi,
} from '@shared/dental';

describe('dental chart', () => {
  it('holds the full adult and primary dentitions', () => {
    expect(PERMANENT_TEETH).toHaveLength(32);
    expect(PRIMARY_TEETH).toHaveLength(20);
    expect(ALL_TEETH).toHaveLength(52);
    expect(isToothFdi('16')).toBe(true);
    expect(isToothFdi('99')).toBe(false);
    // FDI quadrant 3 is the lower left; position 6 is the first molar.
    expect(toothByFdi('36')?.quadrant).toBe(3);
    expect(toothByFdi('36')?.position).toBe(6);
    expect(toothByFdi('36')?.side).toBe('left');
  });

  it('converts between FDI, Universal and Palmer consistently', () => {
    // Universal numbering for adults: 18 → 1 … 28 → 16, 38 → 17 … 48 → 32.
    const upperRightThirdMolar = toothByFdi('18');
    const lowerRightThirdMolar = toothByFdi('38');
    const lowerLeftThirdMolar = toothByFdi('48');
    expect(upperRightThirdMolar?.universal).toBe(1);
    expect(lowerRightThirdMolar?.universal).toBe(17);
    expect(lowerLeftThirdMolar?.universal).toBe(32);

    // Palmer is a display string built from the quadrant and the position.
    expect(toothByFdi('11')?.palmer).toContain('1');
    expect(formatToothCode(toothByFdi('11')!, 'palmer')).toBe(toothByFdi('11')?.palmer);
    expect(toothByFdi('11')?.palmer.endsWith('1')).toBe(true);

    // Primary teeth use letters A–T in the Universal system.
    expect(formatToothCode(toothByFdi('55')!, 'universal')).toBe('A');
    expect(formatToothCode(toothByFdi('85')!, 'universal')).toBe('T');
    expect(formatToothCode(toothByFdi('36')!, 'fdi')).toBe('36');
  });

  it('lays the teeth out arch by arch and quadrant by quadrant', () => {
    const permanent = archLayout('permanent');
    expect(permanent.upper.map((tooth) => tooth.fdi)).toEqual([
      '18', '17', '16', '15', '14', '13', '12', '11', '21', '22', '23', '24', '25', '26', '27', '28',
    ]);
    expect(permanent.lower[0]?.fdi).toBe('48');
    expect(permanent.lower[15]?.fdi).toBe('38');

    const quadrantsList = quadrants('permanent');
    expect(quadrantsList.map((entry) => entry.quadrant)).toEqual([1, 2, 3, 4]);
    expect(quadrantsList[0]?.label).toBe('Upper right');
    expect(quadrantsList[0]?.teeth).toHaveLength(8);
    expect(quadrants('primary')[0]?.teeth).toHaveLength(5);
  });

  it('knows which findings carry surface detail', () => {
    expect(findingAppliesToSurfaces('caries')).toBe(true);
    expect(findingAppliesToSurfaces('filled')).toBe(true);
    expect(findingAppliesToSurfaces('missing')).toBe(false);
    expect(findingAppliesToSurfaces('implant')).toBe(false);
  });

  it('orders tooth codes the way a dentist reads them', () => {
    expect(sortByFdiOrder(['36', '11', '46', '21'])).toEqual(['11', '21', '36', '46']);
  });

  it('describes pocket depths and mobility grades', () => {
    expect(PERIO_SITES.map((site) => site.site)).toEqual(['mb', 'b', 'db', 'ml', 'l', 'dl']);
    expect(MAX_POCKET_DEPTH_MM).toBe(15);
    expect(mobilityLabel(0)).toMatch(/no/i);
    expect(mobilityLabel(2)).toBe('Grade II');
  });

  it('summarises a chart in words', () => {
    const summary = describeToothChartSummary([
      { toothFdi: '16', finding: 'caries' },
      { toothFdi: '26', finding: 'caries' },
      { toothFdi: '36', finding: 'missing' },
    ]);
    expect(summary).toContain('3');
  });
});
