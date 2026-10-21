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

/** Everything the panel shows about a mesh, plus the problem edges to draw. */
export function inspectMesh(positions: ArrayLike<number>): MeshInspection {
  if (positions.length === 0 || positions.length % 9 !== 0) {
    throw new RangeError(`positions must hold whole triangles (9 numbers each), got ${positions.length}`);
  }
  const bbox = bboxOf(positions);
  const eps = weldEpsilon(bbox);
  const topo = analyseTopology(positions, bbox, eps);
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
      flippedHint: flippedHint(volume, bbox),
      weldEpsilon: eps,
    },
    openEdgeSegments: topo.openEdgeSegments,
    nonManifoldEdgeSegments: topo.nonManifoldEdgeSegments,
  };
}
