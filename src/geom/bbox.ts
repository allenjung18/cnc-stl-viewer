/**
 * Bounding box of a flat positions array (x, y, z per vertex). Pure TypeScript,
 * no three.js: it runs in the parse worker and in Node tests.
 */
import type { BBox, Vec3 } from '../state/model';

/** The axis-aligned box around every vertex. Refuses an empty array or one with a non-finite coordinate. */
export function bboxOf(positions: ArrayLike<number>): BBox {
  if (positions.length === 0 || positions.length % 3 !== 0) {
    throw new RangeError(`positions must hold whole vertices (3 numbers each), got ${positions.length}`);
  }
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new RangeError(`vertex ${i / 3} has a coordinate that is not a finite number`);
    }
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { min: [x0, y0, z0], max: [x1, y1, z1] };
}

/** Extent along each axis. */
export function sizeOf(box: BBox): Vec3 {
  return [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
}

/** Length of the box's space diagonal. */
export function diagonalOf(box: BBox): number {
  const [x, y, z] = sizeOf(box);
  return Math.hypot(x, y, z);
}

/** The box's centre. */
export function centreOf(box: BBox): Vec3 {
  return [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
}
