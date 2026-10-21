/**
 * Orientation: which way up the part goes on the bed.
 *
 * A rotation is a 3 × 3 matrix, row-major, that takes a point in the file's
 * axes to the machine's (world = R · file). Matrices rather than quaternions
 * because a 90° step is then a signed permutation with entries 0 and ±1:
 * composing it with any matrix only moves and negates entries, so four quarter
 * turns about one axis give back the starting matrix bit for bit, and no
 * amount of clicking drifts.
 *
 * - `rotate90` turns the part a quarter turn about a machine axis.
 * - `layFlat` turns it so a face's outward normal points down (−Z).
 * - `orientCandidates` + `rankOrientations` (`autoOrient` does both) score the
 *   24 axis-aligned orientations and the lay-flat orientations of the largest
 *   flat regions: (1) fits the stock and the machine, (2) lowest Z height,
 *   (3) the most flat area on the bed. The ranking is a suggestion; nothing is
 *   applied until the user picks one. Undercuts are not detected.
 *
 * Lengths here are in file units unless a name says mm. Pure TypeScript, no
 * three.js: it runs in Node tests.
 */
import type { FitReport } from './fit';
import { bboxOf, sizeOf } from './bbox';
import type { BBox, MeshStats, Vec3 } from '../state/model';

/** Row-major 3 × 3 rotation: world = R · file. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];
export type RotationAxis = 'X' | 'Y' | 'Z';

export const IDENTITY: Mat3 = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]) as Mat3;
/** Half a turn about X: up becomes down, front becomes back. */
const TURN_OVER: Mat3 = Object.freeze([1, 0, 0, 0, -1, 0, 0, 0, -1]) as Mat3;

/** A quarter turn (+90°, right-hand rule) about each machine axis, exact. */
const QUARTER: Readonly<Record<RotationAxis, Mat3>> = Object.freeze({
  X: [1, 0, 0, 0, 0, -1, 0, 1, 0],
  Y: [0, 0, 1, 0, 1, 0, -1, 0, 0],
  Z: [0, -1, 0, 1, 0, 0, 0, 0, 1],
});

/** a · b. `+ 0` turns −0 into 0, so exact products compare equal with `toEqual`. */
export function mul(a: Mat3, b: Mat3): Mat3 {
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out.push(a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]! + 0);
    }
  }
  return out as unknown as Mat3;
}

/** R · v. */
export function apply(r: Mat3, v: Vec3): Vec3 {
  return [
    r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
    r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
    r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
  ];
}

/** The rotation `r` followed by a quarter turn about the machine axis `axis` (+90°, right-hand rule). */
export function rotate90(r: Mat3, axis: RotationAxis): Mat3 {
  return mul(QUARTER[axis], r);
}

/** Orthonormal with determinant +1, to `eps`; a mirror or a scale is refused. */
export function isRotation(r: readonly number[], eps = 1e-6): boolean {
  if (r.length !== 9 || !r.every(Number.isFinite)) return false;
  const m = r as unknown as Mat3;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const dot = m[i * 3]! * m[j * 3]! + m[i * 3 + 1]! * m[j * 3 + 1]! + m[i * 3 + 2]! * m[j * 3 + 2]!;
      if (Math.abs(dot - (i === j ? 1 : 0)) > eps) return false;
    }
  }
  const det =
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  return Math.abs(det - 1) <= eps;
}

/** Every entry is 0 or ±1: one of the 24 axis-aligned orientations. */
export function isAxisAligned(r: Mat3): boolean {
  return r.every((v) => v === 0 || v === 1 || v === -1);
}

/** The 24 axis-aligned orientations (signed permutations with determinant +1), the identity first. */
export const AXIS_ORIENTATIONS: readonly Mat3[] = (() => {
  const perms: [number, number, number][] = [
    [0, 1, 2], [1, 2, 0], [2, 0, 1], // even
    [0, 2, 1], [2, 1, 0], [1, 0, 2], // odd
  ];
  const out: Mat3[] = [];
  perms.forEach((p, pi) => {
    const parity = pi < 3 ? 1 : -1;
    for (const sx of [1, -1]) {
      for (const sy of [1, -1]) {
        for (const sz of [1, -1]) {
          if (parity * sx * sy * sz !== 1) continue;
          const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
          [sx, sy, sz].forEach((s, row) => {
            m[row * 3 + p[row]!] = s;
          });
          out.push(Object.freeze(m) as unknown as Mat3);
        }
      }
    }
  });
  return Object.freeze(out);
})();

/** Equal entry by entry to `eps` (0: exactly). */
export function sameRotation(a: Mat3, b: Mat3, eps = 0): boolean {
  return a.every((v, i) => Math.abs(v - b[i]!) <= eps);
}

function unit(v: Vec3): Vec3 | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 0) || !Number.isFinite(len)) return null;
  const u: Vec3 = [v[0] / len, v[1] / len, v[2] / len];
  // A normal within float noise of an axis (the other two parts below 1e-14, an angle of 1e-14 rad)
  // is that axis, so laying a box face flat after an arbitrary turn is still exact.
  for (let i = 0; i < 3; i++) {
    if (Math.abs(u[(i + 1) % 3]!) < 1e-14 && Math.abs(u[(i + 2) % 3]!) < 1e-14) {
      const s: [number, number, number] = [0, 0, 0];
      s[i] = Math.sign(u[i]!);
      return s;
    }
  }
  return u;
}

/**
 * A rotation that turns the direction `n` (machine axes, any length) to point
 * straight down (−Z): the shortest turn when `n` points sideways or down; a
 * direction with any upward part is first turned over about X (which keeps
 * the formula well-conditioned near straight up). Exact for an axis direction.
 * Throws RangeError on a zero or non-finite vector.
 */
export function alignToDown(n: Vec3): Mat3 {
  const u = unit(n);
  if (!u) throw new RangeError(`a face normal must be a finite, non-zero vector, got ${n.join(', ')}`);
  if (u[2] > 0) return mul(alignToDown([u[0], -u[1], -u[2]]), TURN_OVER);
  const c = -u[2]; // u · (0, 0, −1), in [0, 1]
  // Rodrigues: v = u × d, R = I + [v]× + [v]×² / (1 + c), with d = (0, 0, −1) so v = (−u_y, u_x, 0).
  const vx = -u[1];
  const vy = u[0];
  // Only an exactly vertical u needs no turn: c rounds to 1 for a tilt below 1e-8 rad, which still counts.
  if (vx === 0 && vy === 0) return IDENTITY;
  const k = 1 / (1 + c);
  return [
    1 - vy * vy * k, vx * vy * k, vy,
    vx * vy * k, 1 - vx * vx * k, -vx,
    -vy, vx, 1 - (vx * vx + vy * vy) * k,
  ].map((x) => x + 0) as unknown as Mat3;
}

/**
 * `r` followed by the turn that puts the face with outward normal
 * `fileNormal` (file axes, as the triangle was read) down on the bed.
 */
export function layFlat(r: Mat3, fileNormal: Vec3): Mat3 {
  return mul(alignToDown(apply(r, fileNormal)), r);
}

/** Triangle `t`'s unit normal from its winding (right-hand rule), file axes; null for a degenerate triangle. */
export function triangleNormal(positions: ArrayLike<number>, t: number): Vec3 | null {
  const o = t * 9;
  if (!(Number.isInteger(t) && t >= 0 && o + 9 <= positions.length)) return null;
  const ux = positions[o + 3]! - positions[o]!;
  const uy = positions[o + 4]! - positions[o + 1]!;
  const uz = positions[o + 5]! - positions[o + 2]!;
  const vx = positions[o + 6]! - positions[o]!;
  const vy = positions[o + 7]! - positions[o + 1]!;
  const vz = positions[o + 8]! - positions[o + 2]!;
  return unit([uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]);
}

/**
 * The box around the part once rotated by `r`, file units. An axis-aligned
 * rotation only permutes and negates axes, so its box comes from the 8 corners
 * of `fileBBox` (exact); any other rotation scans every vertex.
 */
export function orientedBBox(positions: ArrayLike<number>, r: Mat3, fileBBox: BBox = bboxOf(positions)): BBox {
  if (isAxisAligned(r)) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const p = apply(r, [
        c & 1 ? fileBBox.max[0] : fileBBox.min[0],
        c & 2 ? fileBBox.max[1] : fileBBox.min[1],
        c & 4 ? fileBBox.max[2] : fileBBox.min[2],
      ]);
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i]!, p[i]! + 0);
        max[i] = Math.max(max[i]!, p[i]! + 0);
      }
    }
    return { min: [min[0]!, min[1]!, min[2]!], max: [max[0]!, max[1]!, max[2]!] };
  }
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const px = positions[i]!, py = positions[i + 1]!, pz = positions[i + 2]!;
    const x = r[0] * px + r[1] * py + r[2] * pz;
    const y = r[3] * px + r[4] * py + r[5] * pz;
    const z = r[6] * px + r[7] * py + r[8] * pz;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { min: [x0, y0, z0], max: [x1, y1, z1] };
}

/** The inspected stats with the box and size of the part as oriented (the rest does not change under a rotation). */
export function orientStats(stats: MeshStats, oriented: BBox): MeshStats {
  return { ...stats, bbox: oriented, size: sizeOf(oriented) };
}

/** A direction many triangles face: a flat face, or several parallel ones. */
export interface FlatRegion {
  /** Area-weighted unit normal, file axes. */
  readonly normal: Vec3;
  /** Total area of its triangles, file units². */
  readonly area: number;
  readonly triangles: number;
}

/** Normals are bucketed on a grid this fine (about 0.45° a step) before buckets are merged. */
const NORMAL_GRID = 128;
/** The largest buckets merged into regions; smaller ones cannot make a top region. */
const MAX_BUCKETS = 512;

/**
 * Groups triangles whose normals are within `angleDeg` of each other,
 * weighted by area, and returns the `max` largest groups, largest first.
 * Degenerate triangles are skipped.
 */
export function flatRegions(positions: ArrayLike<number>, { angleDeg = 1, max = 6 } = {}): FlatRegion[] {
  const buckets = new Map<number, { sx: number; sy: number; sz: number; area: number; triangles: number }>();
  const span = 2 * NORMAL_GRID + 1;
  for (let o = 0; o + 9 <= positions.length; o += 9) {
    const ux = positions[o + 3]! - positions[o]!;
    const uy = positions[o + 4]! - positions[o + 1]!;
    const uz = positions[o + 5]! - positions[o + 2]!;
    const vx = positions[o + 6]! - positions[o]!;
    const vy = positions[o + 7]! - positions[o + 1]!;
    const vz = positions[o + 8]! - positions[o + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0) || !Number.isFinite(len)) continue;
    const key =
      (Math.round((nx / len) * NORMAL_GRID) + NORMAL_GRID) * span * span +
      (Math.round((ny / len) * NORMAL_GRID) + NORMAL_GRID) * span +
      (Math.round((nz / len) * NORMAL_GRID) + NORMAL_GRID);
    const b = buckets.get(key);
    // The raw cross product is the normal times twice the area: summing it weights by area.
    if (b) {
      b.sx += nx;
      b.sy += ny;
      b.sz += nz;
      b.area += len / 2;
      b.triangles++;
    } else buckets.set(key, { sx: nx, sy: ny, sz: nz, area: len / 2, triangles: 1 });
  }
  const cos = Math.cos((angleDeg * Math.PI) / 180);
  const regions: { sx: number; sy: number; sz: number; area: number; triangles: number }[] = [];
  const dir = (r: { sx: number; sy: number; sz: number }): Vec3 | null => unit([r.sx, r.sy, r.sz]);
  for (const b of [...buckets.values()].sort((a, c) => c.area - a.area).slice(0, MAX_BUCKETS)) {
    const d = dir(b);
    if (!d) continue;
    const into = regions.find((r) => {
      const rd = dir(r);
      return rd !== null && rd[0] * d[0] + rd[1] * d[1] + rd[2] * d[2] >= cos;
    });
    if (into) {
      into.sx += b.sx;
      into.sy += b.sy;
      into.sz += b.sz;
      into.area += b.area;
      into.triangles += b.triangles;
    } else regions.push({ ...b });
  }
  return regions
    .sort((a, c) => c.area - a.area)
    .slice(0, max)
    .flatMap((r) => {
      const normal = dir(r);
      return normal ? [{ normal, area: r.area, triangles: r.triangles }] : [];
    });
}

/** One way up, with its geometry (file units); `rankOrientations` adds the mm values and the fit. */
export interface OrientCandidate {
  readonly rotation: Mat3;
  /** One of the 24 axis-aligned orientations, or the lay-flat turn of a flat region. */
  readonly source: 'axis' | 'face';
  readonly bbox: BBox;
  readonly size: Vec3;
  /** Area of the triangles lying on the bed (at the lowest Z), file units². */
  readonly contactArea: number;
  /**
   * Lengths closer than this are the same, file units: float32 positions are
   * rounded to about 6e-8 of their largest coordinate, so this is 1e-6 of the
   * larger of that coordinate and the part's size.
   */
  readonly tolerance: number;
}

/** Area of the triangles whose three corners all sit at the lowest Z once rotated by `r`. */
function contactArea(positions: ArrayLike<number>, areas: Float64Array, r: Mat3, minZ: number, tol: number): number {
  let sum = 0;
  const limit = minZ + tol;
  for (let t = 0, o = 0; t < areas.length; t++, o += 9) {
    let low = true;
    for (let k = 0; k < 9 && low; k += 3) {
      low = r[6] * positions[o + k]! + r[7] * positions[o + k + 1]! + r[8] * positions[o + k + 2]! <= limit;
    }
    if (low) sum += areas[t]!;
  }
  return sum;
}

/**
 * The candidates auto-orient scores: the 24 axis-aligned orientations (the
 * identity first) and the lay-flat turn of each of the `regions` largest flat
 * regions, without duplicates. This is the expensive half (it scans the mesh);
 * keep the result per part and re-rank it when the stock changes.
 */
export function orientCandidates(positions: ArrayLike<number>, { regions = 6, angleDeg = 1 } = {}): OrientCandidate[] {
  const triangles = Math.floor(positions.length / 9);
  if (triangles === 0) return [];
  const fileBBox = bboxOf(positions);
  const areas = new Float64Array(triangles);
  for (let t = 0, o = 0; t < triangles; t++, o += 9) {
    const ux = positions[o + 3]! - positions[o]!;
    const uy = positions[o + 4]! - positions[o + 1]!;
    const uz = positions[o + 5]! - positions[o + 2]!;
    const vx = positions[o + 6]! - positions[o]!;
    const vy = positions[o + 7]! - positions[o + 1]!;
    const vz = positions[o + 8]! - positions[o + 2]!;
    areas[t] = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  const rotations: { rotation: Mat3; source: 'axis' | 'face' }[] = AXIS_ORIENTATIONS.map((rotation) => ({
    rotation,
    source: 'axis',
  }));
  for (const region of flatRegions(positions, { angleDeg, max: regions })) {
    const rotation = alignToDown(region.normal);
    if (!rotations.some((c) => sameRotation(c.rotation, rotation, 1e-9))) rotations.push({ rotation, source: 'face' });
  }
  const tolerance = 1e-6 * Math.max(1, ...sizeOf(fileBBox).map(Math.abs), ...fileBBox.min.map(Math.abs), ...fileBBox.max.map(Math.abs));
  return rotations.map(({ rotation, source }) => {
    const bbox = orientedBBox(positions, rotation, fileBBox);
    return {
      rotation,
      source,
      bbox,
      size: sizeOf(bbox),
      contactArea: contactArea(positions, areas, rotation, bbox.min[2], tolerance),
      tolerance,
    };
  });
}

/** A candidate as listed: its size and Z height in mm, its bed contact in mm², and the fit for that size. */
export interface RankedOrientation extends OrientCandidate {
  readonly sizeMm: Vec3;
  readonly zHeightMm: number;
  readonly contactAreaMm2: number;
  /** The fit checks for this orientation's size; null when they could not run (no valid stock input). */
  readonly fit: FitReport | null;
  readonly fits: boolean;
}

export interface RankOptions {
  /** File units -> mm. */
  readonly scale: number;
  /** Runs the fit checks for a part of this size (mm); may throw or return null when the inputs are invalid. */
  readonly fitOf?: ((sizeMm: Vec3) => FitReport | null) | undefined;
  /** How many to return (default 3). */
  readonly top?: number | undefined;
}

/** Lengths in mm differ by more than the candidates' noise. */
const lengthsDiffer = (a: number, b: number, tolMm: number): boolean => Math.abs(a - b) > tolMm;
/** Areas in mm² differ by more than float noise: relative, plus the length noise along a side of the area. */
const areasDiffer = (a: number, b: number, tolMm: number): boolean =>
  Math.abs(a - b) > 1e-6 * Math.max(1, Math.abs(a), Math.abs(b)) + 4 * tolMm * Math.sqrt(Math.max(Math.abs(a), Math.abs(b)));

/**
 * Orders the candidates (1) fits first, (2) lowest Z height, (3) most flat area
 * on the bed, then candidate order, and keeps the first `top`. Orientations
 * that differ only by a turn about Z (same Z height, same footprint either way
 * round, same contact) are listed once, as the best-ranked of them: a quarter
 * turn about Z is one click away.
 */
export function rankOrientations(candidates: readonly OrientCandidate[], { scale, fitOf, top = 3 }: RankOptions): RankedOrientation[] {
  if (!(Number.isFinite(scale) && scale > 0)) throw new RangeError(`unit scale must be a finite number above 0, got ${scale}`);
  const scored = candidates.map((c, index) => {
    const sizeMm: Vec3 = [c.size[0] * scale, c.size[1] * scale, c.size[2] * scale];
    let fit: FitReport | null;
    try {
      fit = fitOf?.(sizeMm) ?? null;
    } catch {
      fit = null; // an invalid input: not checked, never a pass
    }
    const ranked: RankedOrientation = {
      ...c,
      sizeMm,
      zHeightMm: sizeMm[2],
      contactAreaMm2: c.contactArea * scale * scale,
      fit,
      fits: fit?.fits ?? false,
    };
    return { ranked, index, tolMm: c.tolerance * scale };
  });
  scored.sort((a, b) => {
    const x = a.ranked;
    const y = b.ranked;
    if (x.fits !== y.fits) return x.fits ? -1 : 1;
    const tol = Math.max(a.tolMm, b.tolMm);
    if (lengthsDiffer(x.zHeightMm, y.zHeightMm, tol)) return x.zHeightMm - y.zHeightMm;
    if (areasDiffer(x.contactAreaMm2, y.contactAreaMm2, tol)) return y.contactAreaMm2 - x.contactAreaMm2;
    return a.index - b.index;
  });
  const kept: { ranked: RankedOrientation; tolMm: number }[] = [];
  const footprint = (o: RankedOrientation): [number, number] => {
    const [a, b] = [o.sizeMm[0], o.sizeMm[1]].sort((p, q) => p - q);
    return [a!, b!];
  };
  for (const { ranked, tolMm } of scored) {
    const [a, b] = footprint(ranked);
    const same = kept.some((k) => {
      const tol = Math.max(k.tolMm, tolMm);
      const [ka, kb] = footprint(k.ranked);
      return (
        !lengthsDiffer(k.ranked.zHeightMm, ranked.zHeightMm, tol) &&
        !lengthsDiffer(ka, a, tol) &&
        !lengthsDiffer(kb, b, tol) &&
        !areasDiffer(k.ranked.contactAreaMm2, ranked.contactAreaMm2, tol)
      );
    });
    if (same) continue;
    kept.push({ ranked, tolMm });
    if (kept.length >= top) break;
  }
  return kept.map((k) => k.ranked);
}

/** `orientCandidates` then `rankOrientations`: the top orientations for this mesh. */
export function autoOrient(positions: ArrayLike<number>, options: RankOptions): RankedOrientation[] {
  return rankOrientations(orientCandidates(positions), options);
}
