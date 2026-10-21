/**
 * Stock sizing and fit checks, in machine axes and millimetres (bed frame:
 * the cutting area's front-left corner at the origin, Z = 0 on the bed).
 *
 * - `auto` stock is the part plus the allowance on every side, with the part at
 *   (xy, xy, bottom) inside it.
 * - `fixed` stock is the block the user has; the part needs its allowance as
 *   margins, and every axis it misses by is reported. The part is centred in X
 *   and Y and sits `top` below the stock top, so spare height goes underneath.
 * - The stock, placed on the bed, must sit inside the cutting area (never just
 *   the travel, which is checked as the outer limit too) and must not overlap a
 *   keep-out box in plan view.
 *
 * Pure TypeScript, no three.js: it runs in Node tests and anywhere else.
 */
import type { Allowance, BBox, MachineProfile, Setup, Stock, Vec3, WcsOrigin } from '../state/model';

export type Axis = 'X' | 'Y' | 'Z';
const AXES: readonly Axis[] = ['X', 'Y', 'Z'];

/** The plan's per-side defaults: room for a facing pass on top and tape or tabs underneath. */
export const DEFAULT_ALLOWANCE: Allowance = Object.freeze({ xy: 3, top: 1, bottom: 2 });

export type FitFailure =
  | { readonly kind: 'part-exceeds-stock'; readonly axis: Axis; readonly overshootMm: number }
  | { readonly kind: 'stock-exceeds-cutting-area'; readonly axis: Axis; readonly overshootMm: number }
  | { readonly kind: 'stock-exceeds-travel'; readonly axis: Axis; readonly overshootMm: number }
  | { readonly kind: 'stock-over-keep-out'; readonly index: number; readonly overlapMm: readonly [number, number] };

export interface FitInput {
  /** The part's size after the unit scale, mm; null when no part is loaded. */
  readonly partSize: Vec3 | null;
  readonly stock: Stock;
  readonly setup: Setup;
  readonly profile: MachineProfile;
}

export interface FitReport {
  /** Null when there is no stock to draw (auto mode and no part). */
  readonly stockSize: Vec3 | null;
  /** The stock on the bed. */
  readonly stockBox: BBox | null;
  /** Offset of the part's bbox min corner inside the stock, mm; null without a part. */
  readonly partOffset: Vec3 | null;
  /** Where the part's bbox min corner sits on the bed, mm. */
  readonly partOnBed: Vec3 | null;
  /** The WCS origin on the bed, mm. */
  readonly wcs: Vec3 | null;
  /** Cutting-area height left above the stock for the tool and clamps, mm (may be negative). */
  readonly zLeftMm: number | null;
  readonly failures: readonly FitFailure[];
  /** A stock exists and nothing failed. */
  readonly fits: boolean;
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/**
 * Whether `a - b` is a real overshoot. Float noise must not fail a part that
 * fits exactly (0.1 + 0.2 > 0.3), so the difference must clear a tolerance
 * relative to the two numbers subtracted, and only those: a far-away
 * coordinate elsewhere must never widen it.
 */
function exceeds(a: number, b: number): boolean {
  return a - b > 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

function assertFiniteBox(label: string, box: BBox): void {
  if (![...box.min, ...box.max].every(Number.isFinite)) {
    throw new RangeError(`${label} must have finite corners, got ${box.min.join(', ')} to ${box.max.join(', ')}`);
  }
}

function assertFinite(label: string, v: Vec3 | readonly number[], min: number, inclusive: boolean): void {
  v.forEach((n, i) => {
    if (!Number.isFinite(n) || (inclusive ? n < min : n <= min)) {
      throw new RangeError(`${label}[${i}] must be a finite number ${inclusive ? '>=' : '>'} ${min}, got ${n}`);
    }
  });
}

function assertAllowance(a: Allowance): void {
  assertFinite('allowance', [a.xy, a.top, a.bottom], 0, true);
}

/** The size the part needs with its margins: part + 2·xy in X and Y, + top + bottom in Z. */
export function requiredStockSize(partSize: Vec3, allowance: Allowance): Vec3 {
  assertFinite('part size', partSize, 0, true);
  assertAllowance(allowance);
  return [partSize[0] + 2 * allowance.xy, partSize[1] + 2 * allowance.xy, partSize[2] + allowance.top + allowance.bottom];
}

/** Auto stock: the part plus the allowance, with the part's min corner at (xy, xy, bottom) inside it. */
export function stockFromPart(partSize: Vec3, allowance: Allowance): { size: Vec3; partOffset: Vec3 } {
  return { size: requiredStockSize(partSize, allowance), partOffset: [allowance.xy, allowance.xy, allowance.bottom] };
}

/** Where the part sits in a fixed block: centred in X and Y, its top `allowance.top` below the stock top. */
export function partOffsetInFixedStock(partSize: Vec3, stockSize: Vec3, allowance: Allowance): Vec3 {
  assertFinite('part size', partSize, 0, true);
  assertFinite('stock size', stockSize, 0, false);
  assertAllowance(allowance);
  return [
    (stockSize[0] - partSize[0]) / 2,
    (stockSize[1] - partSize[1]) / 2,
    stockSize[2] - allowance.top - partSize[2],
  ];
}

/** Every axis on which the part with its margins does not fit the block, and by how much. */
export function partInStockFailures(partSize: Vec3, stockSize: Vec3, allowance: Allowance): FitFailure[] {
  assertFinite('stock size', stockSize, 0, false);
  const need = requiredStockSize(partSize, allowance);
  const out: FitFailure[] = [];
  AXES.forEach((axis, i) => {
    const over = need[i]! - stockSize[i]!;
    if (exceeds(need[i]!, stockSize[i]!)) out.push({ kind: 'part-exceeds-stock', axis, overshootMm: over });
  });
  return out;
}

/**
 * How far `box` reaches outside `limit` on each axis: the sum of what pokes out
 * below the min and above the max (0 when inside).
 */
export function outsideBy(box: BBox, limit: BBox): Vec3 {
  const o = [0, 1, 2].map((i) => {
    const below = exceeds(limit.min[i]!, box.min[i]!) ? limit.min[i]! - box.min[i]! : 0;
    const above = exceeds(box.max[i]!, limit.max[i]!) ? box.max[i]! - limit.max[i]! : 0;
    return below + above;
  });
  return [o[0]!, o[1]!, o[2]!];
}

/** Plan-view (X, Y) overlap of two boxes, mm per axis; null when they do not overlap (touching is not overlap). */
export function footprintOverlap(a: BBox, b: BBox): [number, number] | null {
  const hiX = Math.min(a.max[0], b.max[0]);
  const loX = Math.max(a.min[0], b.min[0]);
  const hiY = Math.min(a.max[1], b.max[1]);
  const loY = Math.max(a.min[1], b.min[1]);
  if (!exceeds(hiX, loX) || !exceeds(hiY, loY)) return null;
  return [hiX - loX, hiY - loY];
}

/** The WCS origin for a stock box on the bed: Z0 on the stock top, at its front-left corner or its centre. */
export function wcsOrigin(stockBox: BBox, origin: WcsOrigin): Vec3 {
  const top = stockBox.max[2];
  if (origin === 'center-top') {
    return [(stockBox.min[0] + stockBox.max[0]) / 2, (stockBox.min[1] + stockBox.max[1]) / 2, top];
  }
  return [stockBox.min[0], stockBox.min[1], top];
}

/** The cutting area and the travel as boxes on the bed (travel centred on the cutting area in X and Y). */
export function machineBoxes(profile: MachineProfile): { cutting: BBox; travel: BBox } {
  const [cx, cy, cz] = profile.cuttingArea;
  const [tx, ty, tz] = profile.travel;
  const ox = (cx - tx) / 2;
  const oy = (cy - ty) / 2;
  return {
    cutting: { min: [0, 0, 0], max: [cx, cy, cz] },
    travel: { min: [ox, oy, 0], max: [ox + tx, oy + ty, tz] },
  };
}

/** Sizes the stock, places it and the part, and runs every check. Throws RangeError on an invalid input. */
export function checkFit({ partSize, stock, setup, profile }: FitInput): FitReport {
  assertAllowance(stock.allowance);
  assertFinite('stock on bed', setup.stockOnBed, -Infinity, false);
  if (partSize) assertFinite('part size', partSize, 0, true);

  let stockSize: Vec3 | null = null;
  let partOffset: Vec3 | null = null;
  const failures: FitFailure[] = [];
  if (stock.mode === 'fixed') {
    assertFinite('stock size', stock.size, 0, false);
    stockSize = stock.size;
    if (partSize) {
      partOffset = partOffsetInFixedStock(partSize, stockSize, stock.allowance);
      failures.push(...partInStockFailures(partSize, stockSize, stock.allowance));
    }
  } else if (partSize) {
    ({ size: stockSize, partOffset } = stockFromPart(partSize, stock.allowance));
  }

  if (!stockSize) {
    return { stockSize: null, stockBox: null, partOffset: null, partOnBed: null, wcs: null, zLeftMm: null, failures, fits: false };
  }

  // Finite inputs can still sum to Infinity (an allowance of 1e308); that is an input error, never a pass.
  const stockBox: BBox = { min: setup.stockOnBed, max: add(setup.stockOnBed, stockSize) };
  assertFiniteBox('stock on the bed', stockBox);
  const partOnBed = partOffset ? add(setup.stockOnBed, partOffset) : null;
  if (partOnBed) assertFinite('part on the bed', partOnBed, -Infinity, false);
  (profile.keepOut ?? []).forEach((box, i) => assertFiniteBox(`keep-out box ${i + 1}`, box));
  const { cutting, travel } = machineBoxes(profile);
  const outCutting = outsideBy(stockBox, cutting);
  const outTravel = outsideBy(stockBox, travel);
  AXES.forEach((axis, i) => {
    if (outCutting[i]! > 0) failures.push({ kind: 'stock-exceeds-cutting-area', axis, overshootMm: outCutting[i]! });
  });
  AXES.forEach((axis, i) => {
    if (outTravel[i]! > 0) failures.push({ kind: 'stock-exceeds-travel', axis, overshootMm: outTravel[i]! });
  });
  (profile.keepOut ?? []).forEach((box, index) => {
    const overlapMm = footprintOverlap(stockBox, box);
    if (overlapMm) failures.push({ kind: 'stock-over-keep-out', index, overlapMm });
  });

  return {
    stockSize,
    stockBox,
    partOffset,
    partOnBed,
    wcs: wcsOrigin(stockBox, setup.origin),
    zLeftMm: cutting.max[2] - stockBox.max[2],
    failures,
    fits: failures.length === 0,
  };
}

/** A length for a verdict line: one decimal, or more when that would round a real overshoot to 0. */
export function formatMm(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? '∞' : n < 0 ? '−∞' : 'not a number';
  const a = Math.abs(n);
  if (a >= 1e12 || (a > 0 && a < 1e-3)) return n.toExponential(2).replace('e+', 'e');
  const digits = a >= 0.05 || a === 0 ? 1 : 3;
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** One plain-English line per failure: names the check, the axis and the overshoot. */
export function failureText(f: FitFailure): string {
  switch (f.kind) {
    case 'part-exceeds-stock':
      return `part exceeds stock ${f.axis} by ${formatMm(f.overshootMm)} mm (with margins)`;
    case 'stock-exceeds-cutting-area':
      return `stock exceeds cutting area ${f.axis} by ${formatMm(f.overshootMm)} mm`;
    case 'stock-exceeds-travel':
      return `stock exceeds travel ${f.axis} by ${formatMm(f.overshootMm)} mm`;
    case 'stock-over-keep-out':
      return `stock overlaps keep-out box ${f.index + 1} by X ${formatMm(f.overlapMm[0])} mm, Y ${formatMm(f.overlapMm[1])} mm`;
  }
}
