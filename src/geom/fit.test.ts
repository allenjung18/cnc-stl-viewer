/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseStl } from '../io/parse';
import type { BBox, MachineProfile, Setup, Stock, Vec3 } from '../state/model';
import { DEFAULT_PROFILE } from '../state/profiles';
import {
  checkFit,
  DEFAULT_ALLOWANCE,
  failureText,
  footprintOverlap,
  formatMm,
  outsideBy,
  partInStockFailures,
  partOffsetInFixedStock,
  requiredStockSize,
  stockFromPart,
  wcsOrigin,
  type FitFailure,
} from './fit';
import { inspectMesh } from './stats';
import { scaleStats } from './units';

/** The 20 mm cube fixture's size, as the panel gets it: inspected, then scaled to mm. */
function cubeSize(scale = 1): Vec3 {
  const bytes = new Uint8Array(readFileSync(new URL('../../test/fixtures/cube-20mm-binary.stl', import.meta.url)));
  return scaleStats(inspectMesh(parseStl(bytes).positions).stats, scale).size;
}

const ALLOW_312 = { xy: 3, top: 1, bottom: 2 };
const AT_ORIGIN: Setup = { origin: 'bottom-left-front-top', stockOnBed: [0, 0, 0] };
const auto = (allowance = ALLOW_312): Stock => ({ mode: 'auto', allowance, size: [0, 0, 0] });
const fixed = (size: Vec3, allowance = ALLOW_312): Stock => ({ mode: 'fixed', allowance, size });
const withKeepOut = (...keepOut: BBox[]): MachineProfile => ({ ...DEFAULT_PROFILE, keepOut });
const kinds = (fs: readonly FitFailure[]): string[] =>
  fs.map((f) => (f.kind === 'stock-over-keep-out' ? `${f.kind}#${f.index}` : `${f.kind}:${f.axis}:${f.overshootMm}`));

describe('stock from part (auto)', () => {
  it('20 mm cube + allowance 3, 1, 2 gives stock 26 × 26 × 23 with the part at (3, 3, 2)', () => {
    expect(cubeSize()).toEqual([20, 20, 20]);
    const { size, partOffset } = stockFromPart(cubeSize(), ALLOW_312);
    expect(size).toEqual([26, 26, 23]);
    expect(partOffset).toEqual([3, 3, 2]);

    const r = checkFit({ partSize: cubeSize(), stock: auto(), setup: AT_ORIGIN, profile: DEFAULT_PROFILE });
    expect(r.stockSize).toEqual([26, 26, 23]);
    expect(r.partOffset).toEqual([3, 3, 2]);
    expect(r.partOnBed).toEqual([3, 3, 2]);
    expect(r.stockBox).toEqual({ min: [0, 0, 0], max: [26, 26, 23] });
    expect(r.failures).toEqual([]);
    expect(r.fits).toBe(true);
  });

  it('the plan default allowance is 3 mm a side, 1 mm on top, 2 mm underneath', () => {
    expect(DEFAULT_ALLOWANCE).toEqual({ xy: 3, top: 1, bottom: 2 });
  });

  it('the part follows the stock on the bed: offset added to the stock corner', () => {
    const r = checkFit({ partSize: cubeSize(), stock: auto(), setup: { ...AT_ORIGIN, stockOnBed: [50, 40, 0] }, profile: DEFAULT_PROFILE });
    expect(r.partOnBed).toEqual([53, 43, 2]);
    expect(r.stockBox).toEqual({ min: [50, 40, 0], max: [76, 66, 23] });
  });

  it('uses the scaled size: an inch-scaled 20-unit cube needs 514 × 514 × 511 mm and fails every cutting axis', () => {
    const r = checkFit({ partSize: cubeSize(25.4), stock: auto(), setup: AT_ORIGIN, profile: DEFAULT_PROFILE });
    expect(r.stockSize![0]).toBeCloseTo(514, 9);
    expect(r.stockSize![2]).toBeCloseTo(511, 9);
    const cut = r.failures.filter((f) => f.kind === 'stock-exceeds-cutting-area');
    expect(cut.map((f) => f.kind === 'stock-exceeds-cutting-area' && f.axis)).toEqual(['X', 'Y', 'Z']);
    expect(r.fits).toBe(false);
  });

  it('no part, auto stock: nothing to size, nothing drawn, not a pass', () => {
    const r = checkFit({ partSize: null, stock: auto(), setup: AT_ORIGIN, profile: DEFAULT_PROFILE });
    expect(r).toMatchObject({ stockSize: null, stockBox: null, wcs: null, fits: false, failures: [] });
  });

  it('zero allowance gives stock equal to the part, and it fits', () => {
    const r = checkFit({ partSize: cubeSize(), stock: auto({ xy: 0, top: 0, bottom: 0 }), setup: AT_ORIGIN, profile: DEFAULT_PROFILE });
    expect(r.stockSize).toEqual([20, 20, 20]);
    expect(r.fits).toBe(true);
  });

  it('a flat part (zero height) still gets a stock from its allowance', () => {
    expect(requiredStockSize([10, 10, 0], ALLOW_312)).toEqual([16, 16, 3]);
  });
});

describe('fixed stock', () => {
  it('25 × 25 × 25 fails X and Y by 1 mm each with the margins, and Z passes', () => {
    const fails = partInStockFailures(cubeSize(), [25, 25, 25], ALLOW_312);
    expect(fails).toEqual([
      { kind: 'part-exceeds-stock', axis: 'X', overshootMm: 1 },
      { kind: 'part-exceeds-stock', axis: 'Y', overshootMm: 1 },
    ]);
    const r = checkFit({ partSize: cubeSize(), stock: fixed([25, 25, 25]), setup: AT_ORIGIN, profile: DEFAULT_PROFILE });
    expect(r.failures).toEqual(fails);
    expect(r.fits).toBe(false);
    expect(r.failures.map(failureText)).toEqual([
      'part exceeds stock X by 1.0 mm (with margins)',
      'part exceeds stock Y by 1.0 mm (with margins)',
    ]);
  });

  it('26 × 26 × 23 is exactly enough, and the part is centred in X/Y with its top 1 mm under the stock top', () => {
    const r = checkFit({ partSize: cubeSize(), stock: fixed([26, 26, 23]), setup: AT_ORIGIN, profile: DEFAULT_PROFILE });
    expect(r.fits).toBe(true);
    expect(r.partOffset).toEqual([3, 3, 2]);
    expect(partOffsetInFixedStock(cubeSize(), [40, 30, 30], ALLOW_312)).toEqual([10, 5, 9]);
  });

  it('float noise is not an overshoot: 0.1 + 2 × 0.1 fits a 0.3 block', () => {
    expect(0.1 + 2 * 0.1).toBeGreaterThan(0.3);
    expect(partInStockFailures([0.1, 0.1, 0.1], [0.3, 0.3, 0.3], { xy: 0.1, top: 0.1, bottom: 0.1 })).toEqual([]);
  });

  it('a 1e-6 mm real overshoot still fails', () => {
    const f = partInStockFailures([20, 20, 20], [26 - 1e-6, 26, 23], ALLOW_312);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'part-exceeds-stock', axis: 'X' });
  });

  it('no part: the block alone is checked against the machine', () => {
    const r = checkFit({ partSize: null, stock: fixed([25, 25, 25]), setup: AT_ORIGIN, profile: DEFAULT_PROFILE });
    expect(r).toMatchObject({ stockSize: [25, 25, 25], partOffset: null, partOnBed: null, fits: true });
  });

  it('a 0, negative, NaN or infinite block size is refused', () => {
    for (const bad of [0, -1, Number.NaN, Infinity]) {
      expect(() => checkFit({ partSize: null, stock: fixed([bad, 25, 25]), setup: AT_ORIGIN, profile: DEFAULT_PROFILE }), String(bad)).toThrow(RangeError);
    }
  });
});

describe('the stock against the machine', () => {
  it('stock 210 × 100 × 20 against the 203 mm cutting area fails X by 7 mm, and only X', () => {
    const r = checkFit({ partSize: null, stock: fixed([210, 100, 20]), setup: AT_ORIGIN, profile: DEFAULT_PROFILE });
    expect(r.failures).toEqual([{ kind: 'stock-exceeds-cutting-area', axis: 'X', overshootMm: 7 }]);
    expect(failureText(r.failures[0]!)).toBe('stock exceeds cutting area X by 7.0 mm');
    expect(r.fits).toBe(false);
  });

  it('checks the cutting area, not the travel: 210 mm is inside the 250 mm travel and still fails', () => {
    const r = checkFit({ partSize: null, stock: fixed([210, 100, 20]), setup: AT_ORIGIN, profile: DEFAULT_PROFILE });
    expect(r.failures.some((f) => f.kind === 'stock-exceeds-travel')).toBe(false);
  });

  it('past the travel too: a 260 mm block fails the cutting area by 57 and the travel by 33.5', () => {
    const r = checkFit({ partSize: null, stock: fixed([260, 100, 20]), setup: AT_ORIGIN, profile: DEFAULT_PROFILE });
    expect(kinds(r.failures)).toEqual(['stock-exceeds-cutting-area:X:57', 'stock-exceeds-travel:X:33.5']);
  });

  it('a block placed off the front-left edge fails by how far it pokes out', () => {
    const r = checkFit({ partSize: null, stock: fixed([25, 25, 25]), setup: { ...AT_ORIGIN, stockOnBed: [-4, 190, 0] }, profile: DEFAULT_PROFILE });
    expect(kinds(r.failures)).toEqual(['stock-exceeds-cutting-area:X:4', 'stock-exceeds-cutting-area:Y:12']);
  });

  it('too tall for the cutting area: fails Z, and Z left for the tool is negative', () => {
    const r = checkFit({ partSize: null, stock: fixed([50, 50, 80]), setup: AT_ORIGIN, profile: DEFAULT_PROFILE });
    expect(kinds(r.failures)).toEqual(['stock-exceeds-cutting-area:Z:4']);
    expect(r.zLeftMm).toBe(-4);
  });

  it('Z left for tool + clamps is cutting Z minus the stock top', () => {
    const r = checkFit({ partSize: cubeSize(), stock: auto(), setup: AT_ORIGIN, profile: DEFAULT_PROFILE });
    expect(r.zLeftMm).toBe(76 - 23);
  });

  it('outsideBy adds what pokes out on both sides of an axis', () => {
    expect(outsideBy({ min: [-2, 0, 0], max: [205, 10, 10] }, { min: [0, 0, 0], max: [203, 203, 76] })).toEqual([4, 0, 0]);
  });

  it('a huge allowance (above 1e12 mm) fails every axis by a finite, readable amount', () => {
    const r = checkFit({ partSize: cubeSize(), stock: auto({ xy: 1e13, top: 1e13, bottom: 1e13 }), setup: AT_ORIGIN, profile: DEFAULT_PROFILE });
    const cut = r.failures.filter((f): f is Extract<FitFailure, { kind: 'stock-exceeds-cutting-area' }> => f.kind === 'stock-exceeds-cutting-area');
    expect(cut.map((f) => f.axis)).toEqual(['X', 'Y', 'Z']);
    for (const f of cut) expect(Number.isFinite(f.overshootMm) && f.overshootMm > 1e13).toBe(true);
    expect(failureText(cut[0]!)).toBe('stock exceeds cutting area X by 2.00e13 mm');
  });

  it('a far stock placement (1e12 mm) still fails the cutting area by the right amount', () => {
    const r = checkFit({ partSize: null, stock: fixed([25, 25, 25]), setup: { ...AT_ORIGIN, stockOnBed: [1e12, 0, 0] }, profile: DEFAULT_PROFILE });
    expect(r.fits).toBe(false);
    expect(r.failures[0]).toMatchObject({ kind: 'stock-exceeds-cutting-area', axis: 'X' });
  });

  it('sizes that overflow to Infinity (allowance or placement 1e308) are refused, never "fits"', () => {
    const big = { xy: 1e308, top: 1, bottom: 2 };
    expect(() => checkFit({ partSize: cubeSize(), stock: auto(big), setup: AT_ORIGIN, profile: DEFAULT_PROFILE })).toThrow(/finite/);
    expect(() => checkFit({ partSize: null, stock: fixed([1e308, 25, 25]), setup: { ...AT_ORIGIN, stockOnBed: [1.7e308, 0, 0] }, profile: DEFAULT_PROFILE })).toThrow(/finite/);
    expect(() => checkFit({ partSize: cubeSize(), stock: fixed([1e308, 25, 25]), setup: { ...AT_ORIGIN, stockOnBed: [1e308, 0, 0] }, profile: DEFAULT_PROFILE })).toThrow(/finite/);
  });

  it('a 1e-9 mm allowance is accepted and the part fits', () => {
    const r = checkFit({ partSize: cubeSize(), stock: auto({ xy: 1e-9, top: 1e-9, bottom: 1e-9 }), setup: AT_ORIGIN, profile: DEFAULT_PROFILE });
    expect(r.fits).toBe(true);
  });

  it('a negative, NaN or infinite allowance, part size or placement is refused', () => {
    const run = (o: Partial<Parameters<typeof checkFit>[0]>) => () =>
      checkFit({ partSize: cubeSize(), stock: auto(), setup: AT_ORIGIN, profile: DEFAULT_PROFILE, ...o });
    for (const bad of [-1, Number.NaN, Infinity, -Infinity]) {
      expect(run({ stock: auto({ xy: bad, top: 1, bottom: 2 })}), `allowance ${bad}`).toThrow(RangeError);
      expect(run({ partSize: [20, bad, 20] }), `part ${bad}`).toThrow(RangeError);
    }
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(run({ setup: { ...AT_ORIGIN, stockOnBed: [bad, 0, 0] } }), `placement ${bad}`).toThrow(RangeError);
    }
  });
});

describe('keep-out', () => {
  const sensor: BBox = { min: [20, 10, 0], max: [40, 30, 8] };

  it('a stock footprint over the keep-out box is detected, with the overlap per axis', () => {
    const r = checkFit({ partSize: cubeSize(), stock: auto(), setup: AT_ORIGIN, profile: withKeepOut(sensor) });
    expect(r.failures).toEqual([{ kind: 'stock-over-keep-out', index: 0, overlapMm: [6, 16] }]);
    expect(r.fits).toBe(false);
    expect(failureText(r.failures[0]!)).toBe('stock overlaps keep-out box 1 by X 6.0 mm, Y 16.0 mm');
  });

  it('clear of the box, or only touching its edge, is not an overlap', () => {
    expect(footprintOverlap({ min: [0, 0, 0], max: [20, 50, 5] }, sensor)).toBeNull(); // touches x = 20
    expect(footprintOverlap({ min: [100, 100, 0], max: [126, 126, 23] }, sensor)).toBeNull();
    const r = checkFit({ partSize: cubeSize(), stock: auto(), setup: { ...AT_ORIGIN, stockOnBed: [100, 100, 0] }, profile: withKeepOut(sensor) });
    expect(r.fits).toBe(true);
  });

  it('a far keep-out side (1e10 or 1e12 mm wide) does not hide a real 6 × 16 mm overlap', () => {
    for (const w of [1e10, 1e12]) {
      const wide: BBox = { min: [20, 10, 0], max: [20 + w, 30, 8] };
      const r = checkFit({ partSize: cubeSize(), stock: auto(), setup: AT_ORIGIN, profile: withKeepOut(wide) });
      expect(r.fits, `width ${w}`).toBe(false);
      expect(r.failures).toEqual([{ kind: 'stock-over-keep-out', index: 0, overlapMm: [6, 16] }]);
    }
  });

  it('a keep-out box with a non-finite corner is refused, not passed', () => {
    const bad: BBox = { min: [20, 10, 0], max: [Infinity, 30, 8] };
    expect(() => checkFit({ partSize: cubeSize(), stock: auto(), setup: AT_ORIGIN, profile: withKeepOut(bad) })).toThrow(RangeError);
  });

  it('the default profile has no keep-out box until it is measured', () => {
    expect(DEFAULT_PROFILE.keepOut ?? []).toEqual([]);
  });
});

describe('WCS origin', () => {
  const box: BBox = { min: [10, 20, 0], max: [36, 46, 23] };

  it('bottom-left-front-top puts the marker at the stock (min x, min y, max z)', () => {
    expect(wcsOrigin(box, 'bottom-left-front-top')).toEqual([10, 20, 23]);
    const r = checkFit({ partSize: cubeSize(), stock: auto(), setup: { ...AT_ORIGIN, stockOnBed: [10, 20, 0] }, profile: DEFAULT_PROFILE });
    expect(r.wcs).toEqual([10, 20, 23]);
  });

  it('center-top puts it at the stock centre in X/Y, still Z0 on top', () => {
    expect(wcsOrigin(box, 'center-top')).toEqual([23, 33, 23]);
  });
});

describe('formatMm', () => {
  it('one decimal, more for a tiny overshoot, exponent past 1e12', () => {
    expect(formatMm(7)).toBe('7.0');
    expect(formatMm(1234.56)).toBe('1,234.6');
    expect(formatMm(0)).toBe('0.0');
    expect(formatMm(0.004)).toBe('0.004');
    expect(formatMm(1e-6)).toBe('1.00e-6');
    expect(formatMm(2e13)).toBe('2.00e13');
    expect(formatMm(-4)).toBe('-4.0');
    expect(formatMm(Infinity)).toBe('∞');
    expect(formatMm(Number.NaN)).toBe('not a number');
  });
});
