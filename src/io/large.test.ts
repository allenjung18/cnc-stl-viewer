import { describe, expect, it } from 'vitest';
import { boxTriangles, gridCubeStl } from '../../test/fixtures/tiny-generator';
import { FEATURE_EDGES_MAX_TRIANGLES, inspectMesh, outlineByDefault } from '../geom/stats';
import { handleParseRequest, PROGRESS_EVERY, type ParseResponse } from './parse';

/**
 * A generated 1 M-triangle STL through the worker body (the same function the
 * Web Worker runs). The bytes are built in memory at test time, never written
 * to the repo. The time is logged, not asserted: a busy machine is not a bug.
 */
describe('a 1 M-triangle STL in the worker', () => {
  it('parses, inspects and draws an outline, with progress every 250 k triangles and the time logged', () => {
    const n = 289; // 12 · 289² = 1,002,252 triangles, ~50 MB
    const bytes = gridCubeStl(n, 100);
    const triangles = 12 * n * n;
    expect(bytes.length).toBe(84 + 50 * triangles);

    const posted: ParseResponse[] = [];
    const t0 = performance.now();
    handleParseRequest({ id: 1, buffer: bytes.buffer as ArrayBuffer }, (m) => posted.push(m));
    const wall = performance.now() - t0;

    const done = posted.at(-1)!;
    if (done.type !== 'done') throw new Error(`expected done, got ${done.type}: ${JSON.stringify(done)}`);
    console.info(
      `1 M-triangle STL (${triangles.toLocaleString('en-US')} triangles, ${(bytes.length / 2 ** 20).toFixed(1)} MB): ` +
        `parsed ${Math.round(done.parseMs)} ms, inspected ${Math.round(done.inspectMs)} ms, ${Math.round(wall)} ms in all`,
    );
    expect(done.triangles).toBe(triangles);
    const progress = posted.filter((m) => m.type === 'progress');
    expect(progress.filter((m) => m.phase === 'parse').map((m) => m.done)).toEqual([1, 2, 3, 4].map((k) => k * PROGRESS_EVERY));
    expect(progress.at(-1)).toMatchObject({ phase: 'inspect', total: triangles });
    const s = done.inspection!.stats;
    expect(s).toMatchObject({ watertight: true, openEdges: 0, nonManifoldEdges: 0, degenerateTris: 0, vertices: 6 * n * n + 2 });
    expect(s.volumeMm3).toBeCloseTo(1e6, 0);
    // Below the cut-off: the outline is the cube's 12 edges, each cut into n segments by the grid.
    expect(triangles).toBeLessThan(FEATURE_EDGES_MAX_TRIANGLES);
    expect(done.inspection!.featureEdgeSegments!.length / 6).toBe(12 * n);
  }, 120_000);

  it('the outline is on by default up to the cut-off, off above it, and the option overrides the count', () => {
    expect(FEATURE_EDGES_MAX_TRIANGLES).toBe(2_000_000);
    expect(outlineByDefault(FEATURE_EDGES_MAX_TRIANGLES)).toBe(true);
    expect(outlineByDefault(FEATURE_EDGES_MAX_TRIANGLES + 1)).toBe(false);
    expect(outlineByDefault(12 * 419 * 419)).toBe(false); // the 100 MB grid cube of the browser test
    const cube = Float32Array.from(boxTriangles([0, 0, 0], [10, 10, 10]).flat(2));
    expect(inspectMesh(cube).featureEdgeSegments).not.toBeNull();
    expect(inspectMesh(cube, { featureEdges: false }).featureEdgeSegments).toBeNull();
  });
});
