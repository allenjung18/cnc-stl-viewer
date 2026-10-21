/**
 * Mesh inspector: size, volume, surface area, triangle and welded-vertex
 * counts, and the topology flags, from a flat triangle soup.
 *
 * Pure TypeScript on a positions array; the parse worker runs it once per load.
 */
import type { MeshInspection, Vec3 } from '../state/model';
import { bboxOf, centreOf, sizeOf } from './bbox';
import { analyseTopology, flippedHint, triangleArea, weldEpsilon } from './topology';

/**
 * Signed volume by the divergence theorem: the sum over triangles of the signed
 * volume of the tetrahedron from `ref` to the triangle. For a closed mesh the
 * result does not depend on `ref`; taking it near the part (its box centre)
 * keeps the products small, so far-from-origin files lose no precision.
 */
export function signedVolume(p: ArrayLike<number>, ref: Vec3 = [0, 0, 0]): number {
  const [rx, ry, rz] = ref;
  let six = 0;
  for (let i = 0; i + 8 < p.length; i += 9) {
    const ax = p[i]! - rx, ay = p[i + 1]! - ry, az = p[i + 2]! - rz;
    const bx = p[i + 3]! - rx, by = p[i + 4]! - ry, bz = p[i + 5]! - rz;
    const cx = p[i + 6]! - rx, cy = p[i + 7]! - ry, cz = p[i + 8]! - rz;
    six += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return six / 6;
}

/** Total triangle area. */
export function surfaceArea(p: ArrayLike<number>): number {
  let area = 0;
  for (let i = 0; i + 8 < p.length; i += 9) area += triangleArea(p, i);
  return area;
}

/** Faces meeting at more than this many degrees draw a feature edge (plan: Rendering, 20° threshold). */
export const FEATURE_ANGLE_DEG = 20;
/**
 * Above this many triangles the feature-edge overlay is skipped (plan: Workers
 * and large files, "~2 M"): a scanned or sculpted mesh has an edge almost
 * everywhere, the overlay would double the draw and the worker's memory, and a
 * 100 MB STL (2.1 M triangles) is past it.
 */
export const FEATURE_EDGES_MAX_TRIANGLES = 2_000_000;

/** Whether a mesh of this many triangles gets an outline by default. */
export function outlineByDefault(triangles: number): boolean {
  return triangles <= FEATURE_EDGES_MAX_TRIANGLES;
}

export interface InspectOptions {
  /** Collect the feature edges; by default only up to FEATURE_EDGES_MAX_TRIANGLES. */
  readonly featureEdges?: boolean;
}

/** Everything the panel shows about a mesh, plus the problem edges to draw (and the feature edges, below the cut-off). */
export function inspectMesh(positions: ArrayLike<number>, options: InspectOptions = {}): MeshInspection {
  if (positions.length === 0 || positions.length % 9 !== 0) {
    throw new RangeError(`positions must hold whole triangles (9 numbers each), got ${positions.length}`);
  }
  const bbox = bboxOf(positions);
  const eps = weldEpsilon(bbox);
  const wantEdges = options.featureEdges ?? outlineByDefault(positions.length / 9);
  const topo = analyseTopology(positions, bbox, eps, wantEdges ? { featureAngleDeg: FEATURE_ANGLE_DEG } : {});
  const volume = signedVolume(positions, centreOf(bbox));
  return {
    stats: {
      triangles: positions.length / 9,
      vertices: topo.vertices,
      bbox,
      size: sizeOf(bbox),
      volumeMm3: volume,
      areaMm2: surfaceArea(positions),
      watertight: topo.watertight,
      openEdges: topo.openEdges,
      nonManifoldEdges: topo.nonManifoldEdges,
      degenerateTris: topo.degenerateTris,
      flippedHint: flippedHint(volume, bbox, topo.watertight),
      weldEpsilon: eps,
    },
    openEdgeSegments: topo.openEdgeSegments,
    nonManifoldEdgeSegments: topo.nonManifoldEdgeSegments,
    featureEdgeSegments: topo.featureEdgeSegments,
  };
}
