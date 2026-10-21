import { describe, expect, it } from 'vitest';
import { boxTriangles, type Point, type Triangle } from '../../test/fixtures/tiny-generator';
import type { MeshStats, Stock, Vec3 } from '../state/model';
import { DEFAULT_PROFILE } from '../state/profiles';
import { checkFit, DEFAULT_ALLOWANCE } from './fit';
import {
  alignToDown,
  apply,
  AXIS_ORIENTATIONS,
  autoOrient,
  flatRegions,
  IDENTITY,
  isAxisAligned,
  isRotation,
  layFlat,
  mul,
  orientCandidates,
  orientedBBox,
  orientStats,
  rankOrientations,
  rotate90,
  sameRotation,
  triangleNormal,
  type Mat3,
} from './orient';

const soup = (tris: readonly Triangle[]): Float32Array => new Float32Array(tris.flat(2));

/** A right-angled wedge: legs 30 (X) and 10 (Z), 20 deep (Y). Its sloping face (√1000 × 20 ≈ 632.5 mm²) is the largest. */
function wedge(): Float32Array {
  const P = (x: number, y: number, z: number): Point => [x, y, z];
  const [a0, b0, c0] = [P(0, 0, 0), P(30, 0, 0), P(0, 0, 10)];
  const [a1, b1, c1] = [P(0, 20, 0), P(30, 20, 0), P(0, 20, 10)];
  return soup([
    [a0, a1, b1], [a0, b1, b0], // bottom, −Z (600 mm²)
    [a0, c0, c1], [a0, c1, a1], // back, −X (200 mm²)
    [b0, b1, c1], [b0, c1, c0], // slope, +X+Z (632.5 mm²)
    [a0, b0, c0], // front, −Y
    [a1, c1, b1], // back, +Y
  ]);
}
const SLOPE_AREA = Math.sqrt(1000) * 20;
const SLOPE_HEIGHT = 300 / Math.sqrt(1000); // the right-angle corner's distance from the slope

const autoStock: Stock = { mode: 'auto', allowance: DEFAULT_ALLOWANCE, size: [0, 0, 0] };
const fitWith = (stock: Stock) => (partSize: Vec3) =>
  checkFit({ partSize, stock, setup: { origin: 'bottom-left-front-top', stockOnBed: [0, 0, 0] }, profile: DEFAULT_PROFILE });

const near = (got: readonly number[], want: readonly number[], eps = 1e-9): void => {
  expect(got).toHaveLength(want.length);
  got.forEach((v, i) => expect(Math.abs(v - want[i]!), `[${i}] ${v} vs ${want[i]}`).toBeLessThanOrEqual(eps));
};

describe('rotate90', () => {
  it('four quarter turns about Z return the identity exactly', () => {
    let r: Mat3 = IDENTITY;
    const seen: Mat3[] = [];
    for (let i = 0; i < 4; i++) {
      r = rotate90(r, 'Z');
      seen.push(r);
    }
    expect(r).toEqual(IDENTITY);
    r.forEach((v, i) => expect(Object.is(v, IDENTITY[i]), `entry ${i} is ${v}`).toBe(true));
    // and the three in between are not the identity
    expect(seen.slice(0, 3).some((m) => sameRotation(m, IDENTITY))).toBe(false);
  });

  it('four quarter turns about X and about Y return the identity exactly too', () => {
    for (const axis of ['X', 'Y'] as const) {
      let r: Mat3 = IDENTITY;
      for (let i = 0; i < 4; i++) r = rotate90(r, axis);
      expect(r).toEqual(IDENTITY);
    }
  });

  it('four quarter turns about Z return any rotation bit for bit, even one that is not axis-aligned', () => {
    const start = layFlat(IDENTITY, [1, 2, 3]);
    expect(isAxisAligned(start)).toBe(false);
    let r = start;
    for (let i = 0; i < 4; i++) r = rotate90(r, 'Z');
    expect(r).toEqual(start);
  });

  it('turns +90° by the right-hand rule about the machine axis', () => {
    near(apply(rotate90(IDENTITY, 'Z'), [1, 0, 0]), [0, 1, 0]);
    near(apply(rotate90(IDENTITY, 'X'), [0, 1, 0]), [0, 0, 1]);
    near(apply(rotate90(IDENTITY, 'Y'), [0, 0, 1]), [1, 0, 0]);
  });

  it('turns about the machine axis, after the rotation already applied', () => {
    // X then Z: the part's +Y went to +Z (X turn); a Z turn leaves +Z where it is.
    const r = rotate90(rotate90(IDENTITY, 'X'), 'Z');
    near(apply(r, [0, 1, 0]), [0, 0, 1]);
    near(apply(r, [1, 0, 0]), [0, 1, 0]);
  });
});

describe('AXIS_ORIENTATIONS', () => {
  it('holds 24 distinct proper rotations, the identity first', () => {
    expect(AXIS_ORIENTATIONS).toHaveLength(24);
    expect(AXIS_ORIENTATIONS[0]).toEqual(IDENTITY);
    for (const r of AXIS_ORIENTATIONS) {
      expect(isRotation(r)).toBe(true);
      expect(isAxisAligned(r)).toBe(true);
    }
    const keys = new Set(AXIS_ORIENTATIONS.map((r) => r.join(',')));
    expect(keys.size).toBe(24);
  });

  it('is closed under quarter turns', () => {
    const keys = new Set(AXIS_ORIENTATIONS.map((r) => r.join(',')));
    for (const r of AXIS_ORIENTATIONS) for (const axis of ['X', 'Y', 'Z'] as const) expect(keys.has(rotate90(r, axis).join(','))).toBe(true);
  });
});

describe('isRotation', () => {
  it('refuses a mirror, a scale, a wrong length and a non-finite entry', () => {
    expect(isRotation([1, 0, 0, 0, 1, 0, 0, 0, -1])).toBe(false);
    expect(isRotation([2, 0, 0, 0, 1, 0, 0, 0, 1])).toBe(false);
    expect(isRotation([1, 0, 0, 0, 1, 0, 0, 0])).toBe(false);
    expect(isRotation([1, 0, 0, 0, 1, 0, 0, 0, Infinity])).toBe(false);
    expect(isRotation([1, 0, 0, 0, 1, 0, 0, 0, NaN])).toBe(false);
  });
});

describe('alignToDown / layFlat', () => {
  it('turns any direction straight down with a proper rotation', () => {
    for (const n of [[1, 0, 0], [0, -1, 0], [1, 2, 3], [-0.3, 0.1, -0.9], [1e-9, 0, 1], [0, 1e-9, -1], [1e12, -3e11, 5]] as Vec3[]) {
      const r = alignToDown(n);
      expect(isRotation(r, 1e-12), `rotation for ${n}`).toBe(true);
      const len = Math.hypot(...n);
      near(apply(r, [n[0] / len, n[1] / len, n[2] / len]), [0, 0, -1], 1e-12);
    }
  });

  it('is the identity for a face already down, and a turn over about X for one facing up', () => {
    expect(alignToDown([0, 0, -1])).toEqual(IDENTITY);
    expect(alignToDown([0, 0, -5])).toEqual(IDENTITY);
    expect(alignToDown([0, 0, 1])).toEqual([1, 0, 0, 0, -1, 0, 0, 0, -1]);
  });

  it('is exact for an axis normal, so laying a box face flat stays axis-aligned', () => {
    for (const n of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]] as Vec3[]) {
      const r = alignToDown(n);
      expect(isAxisAligned(r), `${n} -> ${r}`).toBe(true);
      expect(apply(r, n)).toEqual([0, 0, -1]);
    }
  });

  it('refuses a zero or non-finite normal', () => {
    expect(() => alignToDown([0, 0, 0])).toThrow(RangeError);
    expect(() => alignToDown([NaN, 0, 1])).toThrow(RangeError);
    expect(() => alignToDown([Infinity, 0, 0])).toThrow(RangeError);
  });

  it('lays a face flat from the current orientation: the file normal is taken through the rotation first', () => {
    const r = rotate90(IDENTITY, 'X'); // file +Y now points up
    const flat = layFlat(r, [0, 1, 0]);
    near(apply(flat, [0, 1, 0]), [0, 0, -1]);
  });

  it('lays the wedge flat on its largest face', () => {
    const positions = wedge();
    const [largest] = flatRegions(positions);
    expect(largest!.area).toBeCloseTo(SLOPE_AREA, 9);
    expect(largest!.triangles).toBe(2);
    const r = layFlat(IDENTITY, largest!.normal);
    near(apply(r, largest!.normal), [0, 0, -1], 1e-12);
    const box = orientedBBox(positions, r);
    // every corner of the sloping face (triangles 4 and 5) is on the bed, at the lowest Z
    for (let t = 4; t <= 5; t++) {
      for (let k = 0; k < 3; k++) {
        const o = t * 9 + k * 3;
        const z = apply(r, [positions[o]!, positions[o + 1]!, positions[o + 2]!])[2];
        expect(Math.abs(z - box.min[2])).toBeLessThan(1e-9);
      }
    }
    expect(box.max[2] - box.min[2]).toBeCloseTo(SLOPE_HEIGHT, 9);
  });
});

describe('triangleNormal', () => {
  it('follows the winding, and is null for a degenerate or missing triangle', () => {
    const p = soup(boxTriangles([0, 0, 0], [10, 20, 60]));
    expect(triangleNormal(p, 0)).toEqual([0, 0, -1]);
    expect(triangleNormal(p, 2)).toEqual([0, 0, 1]);
    expect(triangleNormal(new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]), 0)).toBeNull();
    expect(triangleNormal(p, 12)).toBeNull();
    expect(triangleNormal(p, -1)).toBeNull();
  });
});

describe('orientedBBox', () => {
  it('permutes the box for an axis turn (no vertex scan) and matches a scan for any rotation', () => {
    const p = soup(boxTriangles([5, 7, -3], [10, 20, 60]));
    const r = rotate90(IDENTITY, 'X');
    const fast = orientedBBox(p, r);
    expect(fast.max[0] - fast.min[0]).toBe(10);
    expect(fast.max[1] - fast.min[1]).toBe(60);
    expect(fast.max[2] - fast.min[2]).toBe(20);
    const general = layFlat(IDENTITY, [1, 1, 1]);
    const scanned = orientedBBox(p, general);
    // the 8 box corners are the only vertices, so the scan equals the corners' extremes
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((c) =>
      apply(general, [c & 1 ? 15 : 5, c & 2 ? 27 : 7, c & 4 ? 57 : -3]),
    );
    for (let i = 0; i < 3; i++) {
      expect(scanned.min[i]).toBeCloseTo(Math.min(...corners.map((q) => q[i]!)), 9);
      expect(scanned.max[i]).toBeCloseTo(Math.max(...corners.map((q) => q[i]!)), 9);
    }
  });
});

describe('orientStats', () => {
  it('replaces the box and size, and keeps what a rotation does not change', () => {
    const stats = { triangles: 12, volumeMm3: 12000, areaMm2: 3200, bbox: { min: [0, 0, 0], max: [10, 20, 60] }, size: [10, 20, 60] } as unknown as MeshStats;
    const s = orientStats(stats, { min: [1, 2, 3], max: [61, 22, 13] });
    expect(s.size).toEqual([60, 20, 10]);
    expect(s.bbox.min).toEqual([1, 2, 3]);
    expect(s.volumeMm3).toBe(12000);
    expect(s.areaMm2).toBe(3200);
  });
});

describe('flatRegions', () => {
  it('merges normals within 1° and keeps 2° apart separate, weighted by area, largest first', () => {
    const tri = (deg: number, size: number): Triangle => {
      // a triangle in a plane tilted `deg` about Y from the XY plane
      const c = Math.cos((deg * Math.PI) / 180);
      const s = Math.sin((deg * Math.PI) / 180);
      return [[0, 0, 0], [size * c, 0, -size * s], [0, size, 0]];
    };
    const merged = flatRegions(soup([tri(0, 10), tri(0.5, 10)]));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.triangles).toBe(2);
    const apart = flatRegions(soup([tri(0, 10), tri(2, 20)]));
    expect(apart).toHaveLength(2);
    expect(apart[0]!.area).toBeGreaterThan(apart[1]!.area);
  });

  it('skips degenerate triangles and returns at most `max` regions', () => {
    expect(flatRegions(new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]))).toEqual([]);
    expect(flatRegions(soup(boxTriangles([0, 0, 0], [10, 20, 60])), { max: 2 })).toHaveLength(2);
  });
});

describe('orientCandidates', () => {
  it('scores the 24 axis orientations plus lay-flat turns that are not among them', () => {
    const box = orientCandidates(soup(boxTriangles([0, 0, 0], [10, 20, 60])));
    expect(box).toHaveLength(24); // every face of a box is already an axis orientation
    expect(box[0]!.rotation).toEqual(IDENTITY);
    expect(box[0]!.contactArea).toBeCloseTo(200, 9); // the 10 × 20 bottom
    const w = orientCandidates(wedge());
    expect(w.length).toBe(25); // + the slope
    expect(w.filter((c) => c.source === 'face')).toHaveLength(1);
  });

  it('returns nothing for an empty mesh', () => {
    expect(orientCandidates(new Float32Array(0))).toEqual([]);
  });
});

describe('autoOrient', () => {
  it('lays a 10 × 20 × 60 box down to Z = 10, and lists Z 10, 20, 60', () => {
    for (const size of [[10, 20, 60], [60, 10, 20], [20, 60, 10]] as Point[]) {
      const top = autoOrient(soup(boxTriangles([5, 7, -3], size)), { scale: 1, fitOf: fitWith(autoStock) });
      expect(top.map((o) => o.zHeightMm), `as read ${size}`).toEqual([10, 20, 60]);
      expect(top[0]!.fits).toBe(true);
      expect([...top[0]!.sizeMm].sort((a, b) => a - b)).toEqual([10, 20, 60]);
      expect(top[0]!.contactAreaMm2).toBeCloseTo(1200, 9); // 20 × 60 on the bed
    }
  });

  it('puts a fitting orientation ahead of a lower one that does not fit', () => {
    // a 66 × 16 × 26 block holds the part only as 60 × 10 × 20 (margins 3 a side, 1 on top, 2 under)
    const fixed: Stock = { mode: 'fixed', allowance: DEFAULT_ALLOWANCE, size: [66, 16, 26] };
    const top = autoOrient(soup(boxTriangles([0, 0, 0], [10, 20, 60])), { scale: 1, fitOf: fitWith(fixed) });
    expect(top[0]!.fits).toBe(true);
    expect(top[0]!.sizeMm).toEqual([60, 10, 20]);
    expect(top[1]!.fits).toBe(false);
    expect(top[1]!.zHeightMm).toBe(10);
  });

  it('a part too tall as read fails the cutting area, and a lower orientation fits', () => {
    const top = autoOrient(soup(boxTriangles([0, 0, 0], [10, 20, 80])), { scale: 1, fitOf: fitWith(autoStock), top: 24 });
    const asRead = top.find((o) => o.zHeightMm === 80)!;
    expect(asRead.fits).toBe(false);
    expect(asRead.fit!.failures.map((f) => f.kind === 'stock-exceeds-cutting-area' && f.axis)).toContain('Z');
    expect(top[0]!.zHeightMm).toBe(10);
    expect(top[0]!.fits).toBe(true);
  });

  it('lays the wedge on its sloping face: lower than any axis orientation and the most contact', () => {
    const [best] = autoOrient(wedge(), { scale: 1, fitOf: fitWith(autoStock) });
    expect(best!.source).toBe('face');
    expect(best!.zHeightMm).toBeCloseTo(SLOPE_HEIGHT, 9);
    expect(best!.contactAreaMm2).toBeCloseTo(SLOPE_AREA, 6);
  });

  it('breaks a Z tie on the bed contact: the wedge on its 600 mm² bottom before upside down on its ridge', () => {
    // with the slope region left out, the axis heights are 10, 20 and 30
    const ranked = rankOrientations(orientCandidates(wedge(), { regions: 0 }), { scale: 1, top: 24 });
    expect(ranked[0]!.zHeightMm).toBe(10);
    expect(ranked[0]!.contactAreaMm2).toBeCloseTo(600, 9);
    // the same height turned over stands on one edge: no flat area on the bed, so it comes second
    expect(ranked[1]!.zHeightMm).toBe(10);
    expect(ranked[1]!.contactAreaMm2).toBe(0);
    expect(ranked[2]!.zHeightMm).toBe(20);
  });

  it('the bed contact decides a Z tie even when the lower-contact way up comes first (a wedge read upside down)', () => {
    const p = wedge();
    const flipped = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
      const q = apply([1, 0, 0, 0, -1, 0, 0, 0, -1], [p[i]!, p[i + 1]!, p[i + 2]!]);
      flipped.set(q, i);
    }
    const cands = orientCandidates(flipped, { regions: 0 });
    expect(cands[0]!.contactArea).toBe(0); // as read it stands on its ridge
    const [best] = rankOrientations(cands, { scale: 1 });
    expect(best!.zHeightMm).toBe(10);
    expect(best!.contactAreaMm2).toBeCloseTo(600, 9);
  });
});

describe('rankOrientations', () => {
  const cands = orientCandidates(soup(boxTriangles([0, 0, 0], [10, 20, 60])));

  it('applies the unit scale to the size, the Z height and the contact', () => {
    const [best] = rankOrientations(cands, { scale: 25.4 });
    expect(best!.zHeightMm).toBeCloseTo(254, 9);
    expect(best!.contactAreaMm2).toBeCloseTo(1200 * 25.4 * 25.4, 6);
  });

  it('without a fit check, or when it throws, nothing is said to fit and the order is by Z height', () => {
    for (const fitOf of [undefined, () => null, () => { throw new RangeError('bad input'); }]) {
      const top = rankOrientations(cands, { scale: 1, fitOf });
      expect(top.map((o) => o.fits)).toEqual([false, false, false]);
      expect(top.map((o) => o.fit)).toEqual([null, null, null]);
      expect(top.map((o) => o.zHeightMm)).toEqual([10, 20, 60]);
    }
  });

  it('lists a quarter turn about Z once, and returns `top` entries at most', () => {
    const all = rankOrientations(cands, { scale: 1, top: 100 });
    // 24 orientations of a box come down to 3 heights, each with one footprint either way round
    expect(all.map((o) => o.zHeightMm)).toEqual([10, 20, 60]);
    expect(rankOrientations(cands, { scale: 1, top: 1 })).toHaveLength(1);
  });

  it('refuses a scale that is not a finite number above 0', () => {
    for (const scale of [0, -1, NaN, Infinity]) expect(() => rankOrientations(cands, { scale })).toThrow(RangeError);
  });
});

describe('mul', () => {
  it('composes left after right and gives +0, never −0', () => {
    const r = mul(rotate90(IDENTITY, 'Z'), rotate90(IDENTITY, 'Z'));
    expect(r).toEqual([-1, 0, 0, 0, -1, 0, 0, 0, 1]);
    r.forEach((v) => expect(Object.is(v, -0)).toBe(false));
    // −1·0 + 0·(−1) + 0·(−1) is −0 in floating point; the product says 0
    const z = mul([-1, 0, 0, 0, -1, 0, 0, 0, 1] as Mat3, [0, 0, 0, -1, -1, -1, -1, -1, -1] as Mat3);
    z.forEach((v, i) => expect(Object.is(v, -0), `entry ${i}`).toBe(false));
  });
});
