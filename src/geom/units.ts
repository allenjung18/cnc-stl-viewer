/**
 * Units. STL carries none: a file's numbers are read as millimetres (the
 * machine's units) unless the user says the file is in inches. The choice is a
 * scale from file units to mm, applied to the stats and to the drawn mesh; the
 * positions stay in file units.
 *
 * The hints are heuristics and never change the scale on their own.
 *
 * Pure TypeScript, no three.js: unit-tested in Node.
 */
import type { BBox, MeshStats, Vec3 } from '../state/model';

/** What the file's numbers are taken to be. */
export type UnitChoice = 'mm' | 'in';

export const MM_PER_INCH = 25.4;

/** File units -> millimetres. */
export function unitScaleOf(choice: UnitChoice): number {
  return choice === 'in' ? MM_PER_INCH : 1;
}

/** Parses a stored or typed choice; anything else is `null`. */
export function parseUnitChoice(value: unknown): UnitChoice | null {
  return value === 'mm' || value === 'in' ? value : null;
}

/** The largest dimension below which a file may be in inches (plan: "< 12"). */
export const INCH_HINT_MAX_DIMENSION = 12;
/** The largest dimension, read as mm, above which a file is probably not in mm. */
export const LARGE_HINT_MIN_DIMENSION = 1000;

export type UnitHint =
  /** Small as mm, and ×25.4 still fits the machine. */
  | { readonly kind: 'looks-like-inches'; readonly text: string }
  /** Over a metre as mm. */
  | { readonly kind: 'looks-too-large'; readonly text: string }
  /** Treated as inches, but ×25.4 does not fit the machine: probably a mm file. */
  | { readonly kind: 'inches-do-not-fit'; readonly text: string };

const finitePositive = (n: number): boolean => Number.isFinite(n) && n > 0;

/**
 * Whether `size` fits in `envelope` in some axis-aligned orientation: the sizes
 * and the envelope are compared largest to largest, so a part that only fits
 * lying on its side still counts (orienting it is the user's step).
 */
export function fitsSomeWay(size: Vec3, envelope: Vec3): boolean {
  const a = [...size].sort((p, q) => q - p);
  const b = [...envelope].sort((p, q) => q - p);
  return a.every((v, i) => Number.isFinite(v) && v >= 0 && v <= b[i]!);
}

/**
 * The hint for a part's size in FILE units, given the current choice and the
 * box it must fit (the machine's cutting area, mm). `null` means nothing to say.
 */
export function unitHint(fileSize: Vec3, choice: UnitChoice, envelope: Vec3): UnitHint | null {
  if (!fileSize.every((v) => Number.isFinite(v) && v >= 0)) return null;
  const largest = Math.max(...fileSize);
  if (!(largest > 0)) return null; // empty or collapsed: no size to judge
  const asInches = fileSize.map((v) => v * MM_PER_INCH) as unknown as Vec3;
  if (choice === 'in') {
    return fitsSomeWay(asInches, envelope)
      ? null
      : { kind: 'inches-do-not-fit', text: 'as inches this is larger than the cutting area: is the file in mm?' };
  }
  if (largest < INCH_HINT_MAX_DIMENSION && fitsSomeWay(asInches, envelope)) {
    return { kind: 'looks-like-inches', text: 'looks like inches' };
  }
  if (largest > LARGE_HINT_MIN_DIMENSION) {
    return { kind: 'looks-too-large', text: 'over 1 m as mm: may be in microns or another small unit' };
  }
  return null;
}

const scaleVec = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];

/**
 * The stats of a mesh whose coordinates are multiplied by `scale`: lengths × s,
 * area × s², volume × s³. Counts and flags do not change (the weld tolerance is
 * relative to the part's size, so it scales with it).
 */
export function scaleStats(stats: MeshStats, scale: number): MeshStats {
  if (!finitePositive(scale)) throw new RangeError(`unit scale must be a finite number above 0, got ${scale}`);
  if (scale === 1) return stats;
  const bbox: BBox = { min: scaleVec(stats.bbox.min, scale), max: scaleVec(stats.bbox.max, scale) };
  return {
    ...stats,
    bbox,
    size: scaleVec(stats.size, scale),
    volumeMm3: stats.volumeMm3 * scale * scale * scale,
    areaMm2: stats.areaMm2 * scale * scale,
    weldEpsilon: stats.weldEpsilon * scale,
  };
}
