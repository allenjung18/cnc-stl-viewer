/**
 * Minimum-feature hint, the cheap version (plan: Inspection): the thinnest
 * bounding slab, the part's smallest extent along a machine axis as oriented,
 * compared with the end mill the user names. A plate's slab is its wall; a
 * thin wall inside a thick part is not seen, and the hint says so. It never
 * changes a fit verdict.
 *
 * Pure TypeScript, no three.js: unit-tested in Node.
 */
import type { Vec3 } from '../state/model';

/** A 1/8 in end mill, the Nomad's usual first tool. */
export const DEFAULT_TOOL_DIAMETER_MM = 3.175;

export interface FeatureHint {
  /** The smallest extent, mm, and the machine axis it lies along. */
  readonly thinnestMm: number;
  readonly axis: 'X' | 'Y' | 'Z';
  /** The slab is thinner than the end mill. */
  readonly belowTool: boolean;
  readonly text: string;
}

const AXES = ['X', 'Y', 'Z'] as const;

/** The thinnest slab of a part of `sizeMm` (as oriented, mm) against `toolMm`; null when the size cannot be judged. */
export function minFeatureHint(sizeMm: Vec3, toolMm: number, fmt: (n: number) => string = String): FeatureHint | null {
  if (!sizeMm.every((v) => Number.isFinite(v) && v >= 0)) return null;
  let i = 0;
  for (let k = 1; k < 3; k++) if (sizeMm[k]! < sizeMm[i]!) i = k;
  const thinnestMm = sizeMm[i]!;
  const axis = AXES[i]!;
  const toolOk = Number.isFinite(toolMm) && toolMm > 0;
  const belowTool = toolOk && thinnestMm < toolMm;
  const box = 'bounding box only: walls inside the part are not checked';
  const text = belowTool
    ? `${fmt(thinnestMm)} mm along ${axis}, thinner than the ${fmt(toolMm)} mm end mill: check it can be cut and held (${box})`
    : `${fmt(thinnestMm)} mm along ${axis} (${box})`;
  return { thinnestMm, axis, belowTool, text };
}

/** Parses a typed end-mill diameter, mm; null unless a finite number above 0 and at most 100. */
export function parseToolDiameter(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
}
