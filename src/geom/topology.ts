/**
 * Mesh topology of an STL triangle soup: weld coincident vertices, then count
 * how many triangles use each undirected edge. An edge used once is open (a
 * hole's rim), one used more than twice is non-manifold, and a mesh where every
 * edge is used exactly twice is watertight.
 *
 * Pure TypeScript on a positions array; runs in the parse worker.
 */
import type { BBox } from '../state/model';
import { diagonalOf } from './bbox';

/** Smallest welding tolerance, file units (mm). */
export const MIN_WELD_EPSILON = 1e-6;

/** Welding tolerance for a part: 1e-4 of its bounding-box diagonal, never below MIN_WELD_EPSILON. */
export function weldEpsilon(box: BBox): number {
  return Math.max(1e-4 * diagonalOf(box), MIN_WELD_EPSILON);
}

export interface Welded {
  /** Welded vertex index for every input vertex. */
  readonly index: Uint32Array;
  /** x, y, z of each welded vertex (the first input vertex that landed on it). */
  readonly vertices: Float64Array;
  readonly count: number;
}

/**
 * Snaps every vertex to a grid of pitch `eps` from the box's min corner and
 * merges vertices that land on the same grid point. Identical coordinates
 * always merge; two points closer than `eps` merge unless a grid cell boundary
 * falls between them (quantised welding: cheap, and exporters write shared
 * corners as identical floats).
 *
 * The grid key is exact: eps >= 1e-4 of the diagonal, so each axis has at most
 * 10 002 grid points and the key stays far below 2^53.
 */
export function weldVertices(positions: ArrayLike<number>, box: BBox, eps: number): Welded {
  if (!(eps > 0)) throw new RangeError(`weld tolerance must be positive, got ${eps}`);
  const n = positions.length / 3;
  const extent = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
  const k = Math.floor(extent / eps) + 2;
  if (k ** 3 > Number.MAX_SAFE_INTEGER) throw new RangeError(`weld tolerance ${eps} is too small for a part of extent ${extent}`);
  const [mx, my, mz] = box.min;
  const index = new Uint32Array(n);
  const seen = new ShardedMap();
  const vertices = new Float64Array(positions.length);
  let count = 0;
  for (let v = 0; v < n; v++) {
    const x = positions[3 * v]!, y = positions[3 * v + 1]!, z = positions[3 * v + 2]!;
    const key = Math.round((x - mx) / eps) + k * (Math.round((y - my) / eps) + k * Math.round((z - mz) / eps));
    let w = seen.get(key);
    if (w === undefined) {
      w = count++;
      seen.set(key, w);
      vertices[3 * w] = x;
      vertices[3 * w + 1] = y;
      vertices[3 * w + 2] = z;
    }
    index[v] = w;
  }
  return { index, vertices: vertices.slice(0, 3 * count), count };
}

export interface Topology {
  /** Distinct vertices after welding. */
  readonly vertices: number;
  readonly openEdges: number;
  readonly nonManifoldEdges: number;
  readonly watertight: boolean;
  readonly degenerateTris: number;
  /** Open edges as segment endpoints (x0 y0 z0 x1 y1 z1 per edge), file space. */
  readonly openEdgeSegments: Float32Array;
  /** Non-manifold edges, same layout. */
  readonly nonManifoldEdgeSegments: Float32Array;
}

/**
 * Edge census of a triangle soup. A triangle that collapses when welded (two
 * corners on one vertex) is degenerate and adds no edges; a sliver whose area
 * is below eps² but whose corners stay distinct is counted degenerate and its
 * edges still count, since its neighbours share them.
 */
export function analyseTopology(positions: ArrayLike<number>, box: BBox, eps: number): Topology {
  if (positions.length === 0 || positions.length % 9 !== 0) {
    throw new RangeError(`positions must hold whole triangles (9 numbers each), got ${positions.length}`);
  }
  const welded = weldVertices(positions, box, eps);
  const { index, vertices: wv, count: nv } = welded;
  const edges = new ShardedMap();
  const addEdge = (a: number, b: number): void => {
    const key = a < b ? a * nv + b : b * nv + a;
    edges.set(key, (edges.get(key) ?? 0) + 1);
  };
  const minArea = eps * eps;
  let degenerate = 0;
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t]!, b = index[t + 1]!, c = index[t + 2]!;
    if (a === b || b === c || a === c) {
      degenerate++;
      continue;
    }
    if (triangleArea(positions, 3 * t) < minArea) degenerate++;
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }

  const open: number[] = [];
  const nonManifold: number[] = [];
  for (const [key, uses] of edges.entries()) {
    if (uses === 2) continue;
    const a = Math.floor(key / nv);
    const b = key - a * nv;
    (uses === 1 ? open : nonManifold).push(
      wv[3 * a]!, wv[3 * a + 1]!, wv[3 * a + 2]!,
      wv[3 * b]!, wv[3 * b + 1]!, wv[3 * b + 2]!,
    );
  }
  const openEdges = open.length / 6;
  const nonManifoldEdges = nonManifold.length / 6;
  return {
    vertices: nv,
    openEdges,
    nonManifoldEdges,
    // A mesh whose every triangle collapsed has no edges at all; that is not a closed solid.
    watertight: edges.size > 0 && openEdges === 0 && nonManifoldEdges === 0,
    degenerateTris: degenerate,
    openEdgeSegments: Float32Array.from(open),
    nonManifoldEdgeSegments: Float32Array.from(nonManifold),
  };
}

/** Area of the triangle whose first coordinate is at `at`. */
export function triangleArea(p: ArrayLike<number>, at: number): number {
  const ux = p[at + 3]! - p[at]!, uy = p[at + 4]! - p[at + 1]!, uz = p[at + 5]! - p[at + 2]!;
  const vx = p[at + 6]! - p[at]!, vy = p[at + 7]! - p[at + 1]!, vz = p[at + 8]! - p[at + 2]!;
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}

/**
 * The triangles are wound inward: the mesh is watertight and its signed volume
 * is negative beyond rounding noise. A flat or empty mesh (volume ~0) and an
 * open mesh are never flagged.
 */
export function flippedHint(volume: number, box: BBox, watertight: boolean): boolean {
  // On an open mesh the sum depends on the reference point, so its sign says nothing about the winding.
  return watertight && volume < -1e-9 * diagonalOf(box) ** 3;
}

/** One V8 Map holds at most 2^24 entries; this many shards keep each far below that for any file under the size limit. */
export const MAP_SHARDS = 16;

/**
 * A number -> number map split over several Maps, so a mesh with more than
 * 2^24 distinct vertices or edges (a 500 MB STL can have 31 M of either) does
 * not hit V8's per-Map limit. Keys are non-negative integers below 2^53.
 */
export class ShardedMap {
  private readonly shards: Map<number, number>[];
  constructor(shards = MAP_SHARDS) {
    if (!(Number.isInteger(shards) && shards > 0)) throw new RangeError(`shard count must be a positive integer, got ${shards}`);
    this.shards = Array.from({ length: shards }, () => new Map<number, number>());
  }
  private shard(key: number): Map<number, number> {
    return this.shards[key % this.shards.length]!;
  }
  get(key: number): number | undefined {
    return this.shard(key).get(key);
  }
  set(key: number, value: number): void {
    this.shard(key).set(key, value);
  }
  get size(): number {
    let n = 0;
    for (const m of this.shards) n += m.size;
    return n;
  }
  /** Largest single shard, for tests. */
  get largestShard(): number {
    return Math.max(...this.shards.map((m) => m.size));
  }
  *entries(): IterableIterator<[number, number]> {
    for (const m of this.shards) yield* m.entries();
  }
}
