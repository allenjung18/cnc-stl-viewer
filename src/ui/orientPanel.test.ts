import { describe, expect, it } from 'vitest';
import { boxTriangles } from '../../test/fixtures/tiny-generator';
import { checkFit, DEFAULT_ALLOWANCE } from '../geom/fit';
import { autoOrient, IDENTITY, rotate90 } from '../geom/orient';
import type { Stock, Vec3 } from '../state/model';
import { DEFAULT_PROFILE } from '../state/profiles';
import { orientItems } from './orientPanel';

const box = new Float32Array(boxTriangles([0, 0, 0], [10, 20, 80]).flat(2));
const fitWith = (stock: Stock) => (partSize: Vec3) =>
  checkFit({ partSize, stock, setup: { origin: 'bottom-left-front-top', stockOnBed: [0, 0, 0] }, profile: DEFAULT_PROFILE });
const auto: Stock = { mode: 'auto', allowance: DEFAULT_ALLOWANCE, size: [0, 0, 0] };

describe('orientItems', () => {
  it('shows Z height and fit for each of the top three, best first', () => {
    const items = orientItems(autoOrient(box, { scale: 1, fitOf: fitWith(auto) }), IDENTITY);
    expect(items.map((i) => i.height)).toEqual(['Z 10.0 mm', 'Z 20.0 mm', 'Z 80.0 mm']);
    expect(items.map((i) => i.verdict)).toEqual(['fits', 'fits', 'stock exceeds cutting area Z by 7.0 mm']);
    expect(items.map((i) => i.tone)).toEqual(['ok', 'ok', 'bad']);
    expect(items[0]!.detail).toMatch(/^footprint (20 × 80|80 × 20) mm, 1,600 mm² on the bed$/);
  });

  it('marks the orientation the part has now', () => {
    const ranked = autoOrient(box, { scale: 1, fitOf: fitWith(auto) });
    expect(orientItems(ranked, IDENTITY).map((i) => i.current)).toEqual([false, false, true]);
    expect(orientItems(ranked, ranked[0]!.rotation).map((i) => i.current)).toEqual([true, false, false]);
    expect(orientItems(ranked, rotate90(ranked[0]!.rotation, 'X'))[0]!.current).toBe(false);
  });

  it('counts the further failures, and says when fit was not checked', () => {
    const tiny: Stock = { mode: 'fixed', allowance: DEFAULT_ALLOWANCE, size: [5, 5, 5] };
    const [first] = orientItems(autoOrient(box, { scale: 1, fitOf: fitWith(tiny) }), IDENTITY);
    // lowest first: Z 10 with a 20 × 80 footprint misses a 5 mm block by 20 + 6 − 5 in X, then in Y and Z
    expect(first!.height).toBe('Z 10.0 mm');
    expect(first!.verdict).toBe('part exceeds stock X by 21.0 mm (with margins) (+2 more)');
    const unchecked = orientItems(autoOrient(box, { scale: 1 }), IDENTITY);
    expect(unchecked.map((i) => i.tone)).toEqual(['warn', 'warn', 'warn']);
    expect(unchecked[0]!.verdict).toMatch(/not checked/);
  });
});
