import { describe, expect, it } from 'vitest';
import { boxTriangles, reversed } from '../../test/fixtures/tiny-generator';
import { bboxOf } from './bbox';
import { analyseTopology, flippedHint, MIN_WELD_EPSILON, normalCos, ShardedMap, weldEpsilon, weldVertices } from './topology';

const soup = (tris: readonly (readonly (readonly number[])[])[]): Float32Array => Float32Array.from(tris.flat(2));
const topo = (p: Float32Array) => {
  const box = bboxOf(p);
  return analyseTopology(p, box, weldEpsilon(box));
};

describe('weldEpsilon', () => {
  it('is 1e-4 of the bbox diagonal, floored at 1e-6', () => {
    expect(weldEpsilon({ min: [0, 0, 0], max: [30, 40, 0] })).toBeCloseTo(5e-3, 15);
    expect(weldEpsilon({ min: [0, 0, 0], max: [0, 0, 0] })).toBe(MIN_WELD_EPSILON);
    expect(weldEpsilon({ min: [1, 1, 1], max: [1.001, 1, 1] })).toBe(MIN_WELD_EPSILON);
  });
});

describe('weldVertices', () => {
  it('merges points closer than the tolerance and keeps the first one seen', () => {
    const p = Float32Array.from([0, 0, 0, 10, 0, 0, 0.0001, 0, 0, 10, 10, 10]);
    const w = weldVertices(p, bboxOf(p), 0.001);
    expect(w.count).toBe(3);
    expect(Array.from(w.index)).toEqual([0, 1, 0, 2]);
    expect(Array.from(w.vertices.slice(0, 3))).toEqual([0, 0, 0]);
  });

  it('keeps points further apart than the tolerance', () => {
    const p = Float32Array.from([0, 0, 0, 0.01, 0, 0, 10, 0, 0]);
    expect(weldVertices(p, bboxOf(p), 0.001).count).toBe(3);
  });

  it('refuses a tolerance that is zero, negative or not a number', () => {
    const p = Float32Array.from([0, 0, 0]);
    for (const eps of [0, -1, Number.NaN]) expect(() => weldVertices(p, bboxOf(p), eps)).toThrow(RangeError);
  });

  it('refuses a tolerance too small for an exact grid key', () => {
    const p = Float32Array.from([0, 0, 0, 1e6, 0, 0]);
    expect(() => weldVertices(p, bboxOf(p), 1e-6)).toThrow(/too small/);
  });
});

describe('analyseTopology', () => {
  it('welds a cube whose shared corners differ by float noise below the tolerance', () => {
    const tris = boxTriangles([0, 0, 0], [20, 20, 20]).map((t, i) =>
      t.map(([x, y, z]) => [x + (i % 2) * 1e-5, y, z]),
    );
    const t = topo(soup(tris));
    expect(t.vertices).toBe(8);
    expect(t.watertight).toBe(true);
  });

  it('a triangle that collapses when welded is degenerate and adds no edges', () => {
    const cube = boxTriangles([0, 0, 0], [20, 20, 20]);
    const t = topo(soup([...cube, [[0, 0, 0], [0, 0, 0], [20, 0, 0]]]));
    expect(t.degenerateTris).toBe(1);
    expect(t.openEdges).toBe(0);
    expect(t.nonManifoldEdges).toBe(0);
    expect(t.watertight).toBe(true);
  });

  it('a zero-area sliver with distinct corners is degenerate, and its edges still count', () => {
    const t = topo(soup([[[0, 0, 0], [5, 0, 0], [10, 0, 0]]]));
    expect(t.degenerateTris).toBe(1);
    expect(t.openEdges).toBe(3);
  });

  it('a mesh made only of collapsed triangles is not watertight', () => {
    const t = topo(soup([[[1, 1, 1], [1, 1, 1], [1, 1, 1]]]));
    expect(t.vertices).toBe(1);
    expect(t.degenerateTris).toBe(1);
    expect(t.watertight).toBe(false);
  });

  it('two coincident cubes make every edge non-manifold', () => {
    const cube = boxTriangles([0, 0, 0], [10, 10, 10]);
    const t = topo(soup([...cube, ...cube]));
    expect(t.nonManifoldEdges).toBe(18); // 12 box edges + 6 face diagonals
    expect(t.nonManifoldEdgeSegments).toHaveLength(18 * 6);
  });

  it('winding does not change the edge census', () => {
    const t = topo(soup(reversed(boxTriangles([0, 0, 0], [10, 10, 10]))));
    expect(t.watertight).toBe(true);
    expect(t.vertices).toBe(8);
  });

  it('refuses a positions array that is not whole triangles', () => {
    const p = Float32Array.from([0, 0, 0, 1, 1, 1]);
    expect(() => analyseTopology(p, bboxOf(p), 1e-3)).toThrow(RangeError);
  });
});

describe('flippedHint', () => {
  const box = { min: [0, 0, 0], max: [10, 10, 10] } as const;
  it('flags a clearly negative volume only', () => {
    expect(flippedHint(-1000, box, true)).toBe(true);
    expect(flippedHint(1000, box, true)).toBe(false);
    expect(flippedHint(0, box, true)).toBe(false);
    expect(flippedHint(-0, box, true)).toBe(false);
    expect(flippedHint(-1e-12, box, true)).toBe(false); // rounding noise on a flat mesh
  });

  it('never flags an open mesh, whatever the sign of its volume', () => {
    expect(flippedHint(-1000, box, false)).toBe(false);
  });
});

describe('ShardedMap', () => {
  it('gets, sets, counts and iterates across its shards', () => {
    const m = new ShardedMap(4);
    for (let k = 0; k < 1000; k++) m.set(k * 7, k);
    m.set(7, -1); // overwrite, not a new entry
    expect(m.size).toBe(1000);
    expect(m.get(7)).toBe(-1);
    expect(m.get(14)).toBe(2);
    expect(m.get(15)).toBeUndefined();
    expect(m.largestShard).toBe(250); // spread evenly, not piled in one Map
    expect([...m.entries()]).toHaveLength(1000);
  });

  it('places keys near 2^53 too', () => {
    const m = new ShardedMap();
    const big = Number.MAX_SAFE_INTEGER;
    m.set(big, 1);
    m.set(big - 1, 2);
    expect([m.get(big), m.get(big - 1)]).toEqual([1, 2]);
  });

  it('refuses a shard count that is not a positive integer', () => {
    for (const n of [0, -1, 1.5, Number.NaN]) expect(() => new ShardedMap(n)).toThrow(RangeError);
  });
});

describe('analyseTopology: feature edges (the outline)', () => {
  const flat = (tris: ReturnType<typeof boxTriangles>): Float32Array => Float32Array.from(tris.flat(2));
  const run = (p: Float32Array, deg?: number) => {
    const box = bboxOf(p);
    return analyseTopology(p, box, weldEpsilon(box), deg === undefined ? {} : { featureAngleDeg: deg });
  };
  /** Two triangles sharing the edge (0,0,0)-(0,1,0) with `deg` between their half-planes (180 is flat). */
  const fold = (deg: number): Float32Array => {
    const r = (deg * Math.PI) / 180;
    return Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, Math.cos(r), 0, Math.sin(r)]);
  };

  it('off unless asked: null, and the census is unchanged', () => {
    const p = flat(boxTriangles([0, 0, 0], [20, 20, 20]));
    const off = run(p);
    const on = run(p, 20);
    expect(off.featureEdgeSegments).toBeNull();
    expect({ ...on, featureEdgeSegments: null }).toEqual(off);
  });

  it('a cube: its 12 edges, never the face diagonals', () => {
    const t = run(flat(boxTriangles([0, 0, 0], [20, 20, 20])), 20);
    expect(t.featureEdgeSegments!.length / 6).toBe(12);
    // Every outline segment is a cube edge: its two ends differ along exactly one axis.
    const s = t.featureEdgeSegments!;
    for (let i = 0; i < s.length; i += 6) {
      const moved = [0, 1, 2].filter((k) => s[i + k] !== s[i + 3 + k]).length;
      expect(moved).toBe(1);
    }
  });

  it('the angle is a strict threshold between the two normals', () => {
    // Folded up by 30° from flat, the normals differ by 30°: sharp at 20, not at 40.
    expect(run(fold(150), 20).featureEdgeSegments!.length).toBe(6);
    expect(run(fold(150), 40).featureEdgeSegments!.length).toBe(0);
    expect(run(fold(180), 20).featureEdgeSegments!.length).toBe(0); // coplanar
    expect(run(fold(170), 20).featureEdgeSegments!.length).toBe(0); // 10° apart
  });

  it('open and non-manifold edges are not outline edges (they have their own overlays)', () => {
    const open = run(flat(boxTriangles([0, 0, 0], [20, 20, 20]).slice(2)), 20); // no bottom
    expect(open.openEdges).toBe(4);
    expect(open.featureEdgeSegments!.length / 6).toBe(8); // the 4 rim edges are open, not outline
    const bow = run(flat(boxTriangles([0, 0, 0], [10, 10, 10]).concat(boxTriangles([10, 10, 0], [10, 10, 10]))), 20);
    expect(bow.nonManifoldEdges).toBe(1);
    expect(bow.featureEdgeSegments!.length / 6).toBe(22);
  });

  it('a degenerate neighbour never makes an edge sharp', () => {
    expect(normalCos(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 0, 1)).toBe(1);
  });

  it.each([0, 180, -5, Number.NaN, Infinity])('refuses a feature angle of %s', (deg) => {
    expect(() => run(fold(150), deg)).toThrow(RangeError);
  });
});
