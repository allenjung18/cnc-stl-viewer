/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { boxTriangles, type Triangle } from '../../test/fixtures/tiny-generator';
import { parseStl } from '../io/parse';
import { inspectMesh, signedVolume, surfaceArea } from './stats';

const fixture = (name: string): Float32Array =>
  parseStl(new Uint8Array(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url)))).positions;

const soup = (tris: readonly Triangle[]): Float32Array => Float32Array.from(tris.flat(2));

describe('inspectMesh on the fixtures', () => {
  for (const name of ['cube-20mm-binary.stl', 'cube-20mm-ascii.stl']) {
    it(`${name}: 20 mm cube, 8000 mm³, 2400 mm², 12 triangles, 8 welded vertices, watertight`, () => {
      const { stats, openEdgeSegments, nonManifoldEdgeSegments } = inspectMesh(fixture(name));
      expect(stats.size).toEqual([20, 20, 20]);
      expect(stats.bbox).toEqual({ min: [10, -5, 3], max: [30, 15, 23] }); // file space, as read
      expect(Math.abs(stats.volumeMm3 - 8000)).toBeLessThanOrEqual(1e-6);
      expect(stats.areaMm2).toBeCloseTo(2400, 9);
      expect(stats.triangles).toBe(12);
      expect(stats.vertices).toBe(8);
      expect(stats.watertight).toBe(true);
      expect(stats.openEdges).toBe(0);
      expect(stats.nonManifoldEdges).toBe(0);
      expect(stats.degenerateTris).toBe(0);
      expect(stats.flippedHint).toBe(false);
      expect(openEdgeSegments).toHaveLength(0);
      expect(nonManifoldEdgeSegments).toHaveLength(0);
    });
  }

  it('open-box.stl: the missing top leaves 4 open edges, not watertight', () => {
    const { stats, openEdgeSegments } = inspectMesh(fixture('open-box.stl'));
    expect(stats.triangles).toBe(10);
    expect(stats.vertices).toBe(8);
    expect(stats.openEdges).toBe(4);
    expect(stats.nonManifoldEdges).toBe(0);
    expect(stats.watertight).toBe(false);
    expect(stats.size).toEqual([20, 20, 20]);
    // The four open edges are the rim of the missing top face, at the cube's top (z = 23 in file space).
    expect(openEdgeSegments).toHaveLength(4 * 6);
    for (let i = 2; i < openEdgeSegments.length; i += 3) expect(openEdgeSegments[i]).toBe(23);
  });

  it('bowtie.stl: two cubes sharing one edge give exactly 1 non-manifold edge', () => {
    const { stats, nonManifoldEdgeSegments } = inspectMesh(fixture('bowtie.stl'));
    expect(stats.triangles).toBe(24);
    expect(stats.vertices).toBe(14); // 8 + 8, less the 2 ends of the shared edge
    expect(stats.nonManifoldEdges).toBe(1);
    expect(stats.openEdges).toBe(0);
    expect(stats.watertight).toBe(false);
    expect(stats.volumeMm3).toBeCloseTo(2000, 9);
    // The shared edge: x = 10, y = 10, z from 0 to 10.
    const seg = Array.from(nonManifoldEdgeSegments);
    expect(seg).toHaveLength(6);
    expect([seg[0], seg[1], seg[3], seg[4]]).toEqual([10, 10, 10, 10]);
    expect([seg[2], seg[5]].sort((a, b) => a! - b!)).toEqual([0, 10]);
  });

  it('cube-reversed-winding.stl: volume -8000 gives the flipped flag, and it is still watertight', () => {
    const { stats } = inspectMesh(fixture('cube-reversed-winding.stl'));
    expect(Math.abs(stats.volumeMm3 + 8000)).toBeLessThanOrEqual(1e-6);
    expect(stats.flippedHint).toBe(true);
    expect(stats.watertight).toBe(true);
    expect(stats.areaMm2).toBeCloseTo(2400, 9);
  });

  it('inch-cube.stl: 1 x 1 x 1, volume 1, area 6, watertight', () => {
    const { stats } = inspectMesh(fixture('inch-cube.stl'));
    expect(stats.size).toEqual([1, 1, 1]);
    expect(stats.volumeMm3).toBeCloseTo(1, 12);
    expect(stats.areaMm2).toBeCloseTo(6, 12);
    expect(stats.watertight).toBe(true);
    expect(stats.vertices).toBe(8);
  });
});

describe('volume and area', () => {
  it('the volume of a closed mesh does not depend on the reference point', () => {
    const p = fixture('cube-20mm-binary.stl');
    for (const ref of [[0, 0, 0], [20, 5, 13], [-1e6, 3e5, 7]] as const) {
      expect(signedVolume(p, ref)).toBeCloseTo(8000, 6);
    }
  });

  it('keeps precision for a part far from the file origin', () => {
    // A 20 mm cube at 1e6 mm: float32 still holds these integers exactly.
    const { stats } = inspectMesh(soup(boxTriangles([1e6, 1e6, 1e6], [20, 20, 20])));
    expect(Math.abs(stats.volumeMm3 - 8000)).toBeLessThanOrEqual(1e-6);
    expect(stats.vertices).toBe(8);
    expect(stats.watertight).toBe(true);
  });

  it('handles a huge part (1e12 mm³ and beyond) without overflow', () => {
    const { stats } = inspectMesh(soup(boxTriangles([0, 0, 0], [1e5, 1e5, 1e5])));
    expect(stats.volumeMm3).toBeCloseTo(1e15, 0);
    expect(stats.areaMm2).toBeCloseTo(6e10, 0);
    expect(Number.isFinite(stats.volumeMm3)).toBe(true);
    expect(stats.flippedHint).toBe(false);
  });

  it('handles a tiny part (1e-3 mm) at the weld floor', () => {
    const { stats } = inspectMesh(soup(boxTriangles([0, 0, 0], [1e-3, 1e-3, 1e-3])));
    expect(stats.vertices).toBe(8);
    expect(stats.watertight).toBe(true);
    expect(stats.volumeMm3).toBeGreaterThan(0);
    expect(stats.weldEpsilon).toBe(1e-6);
  });

  it('a single flat triangle has zero volume, is open and is not flagged flipped', () => {
    const { stats } = inspectMesh(Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0]));
    expect(stats.volumeMm3).toBe(0);
    expect(stats.flippedHint).toBe(false);
    expect(stats.openEdges).toBe(3);
    expect(stats.watertight).toBe(false);
    expect(stats.areaMm2).toBe(50);
    expect(stats.size).toEqual([10, 10, 0]);
  });

  it('surfaceArea sums the triangles', () => {
    expect(surfaceArea(Float32Array.from([0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 0, 3, 0, 0, 0, 4]))).toBe(2 + 6);
  });

  it('refuses an empty or partial positions array', () => {
    expect(() => inspectMesh(new Float32Array(0))).toThrow(RangeError);
    expect(() => inspectMesh(new Float32Array(10))).toThrow(RangeError);
  });
});
