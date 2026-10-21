/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { Box3, Group, type LineBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { CUBE_MIN } from '../../test/fixtures/tiny-generator';
import { inspectMesh } from '../geom/stats';
import { parseStl } from '../io/parse';
import { buildPartMesh, NON_MANIFOLD_EDGE_COLOR, OPEN_EDGE_COLOR } from './partMesh';

const positionsOf = (name: string): Float32Array =>
  parseStl(new Uint8Array(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url)))).positions;

describe('buildPartMesh', () => {
  it('lands the cube with its min corner at the origin, not centred', () => {
    const part = buildPartMesh(positionsOf('cube-20mm-binary.stl'));
    const world = new Box3().setFromObject(part.object);
    expect(world.min.toArray()).toEqual([0, 0, 0]);
    expect(world.max.toArray()).toEqual([20, 20, 20]);
    expect(part.object.name).toBe('part');
  });

  it('keeps the file-space box and the positions array as read (no copy, no centring)', () => {
    const positions = positionsOf('cube-20mm-ascii.stl');
    const before = Array.from(positions);
    const part = buildPartMesh(positions);
    expect(part.fileBBox).toEqual({ min: [...CUBE_MIN], max: [30, 15, 23] });
    expect(part.size).toEqual([20, 20, 20]);
    expect(part.object.geometry.getAttribute('position').array).toBe(positions);
    expect(Array.from(positions)).toEqual(before);
  });

  it('places a part that is already at the origin, or entirely negative, the same way', () => {
    const inch = buildPartMesh(positionsOf('inch-cube.stl'));
    expect(new Box3().setFromObject(inch.object).min.toArray()).toEqual([0, 0, 0]);
    const shifted = positionsOf('cube-20mm-binary.stl').map((v) => v - 1000);
    const far = new Box3().setFromObject(buildPartMesh(shifted).object);
    expect(far.min.toArray()).toEqual([0, 0, 0]);
    expect(far.max.toArray()).toEqual([20, 20, 20]);
  });

  it('setUnitScale(25.4) draws the inch cube 25.4 mm on a side, still from the origin', () => {
    const positions = positionsOf('inch-cube.stl').map((v) => v + 2); // file box (2..3)
    const open = Float32Array.from([2, 2, 3, 3, 2, 3]); // one edge on the top, file space
    const part = buildPartMesh(positions, { openEdgeSegments: open, nonManifoldEdgeSegments: new Float32Array(0) });
    expect(part.unitScale).toBe(1);
    part.setUnitScale(25.4);
    expect(part.unitScale).toBe(25.4);
    const world = new Box3().setFromObject(part.object);
    for (const v of world.min.toArray()) expect(v).toBeCloseTo(0, 9);
    for (const v of world.max.toArray()) expect(v).toBeCloseTo(25.4, 9);
    // The overlay scales with the part.
    const edge = new Box3().setFromObject(part.openEdges!);
    expect(edge.max.x).toBeCloseTo(25.4, 9);
    expect(edge.min.z).toBeCloseTo(25.4, 9);
    // The positions and the file-space box are untouched.
    expect(part.object.geometry.getAttribute('position').array).toBe(positions);
    expect(part.fileBBox).toEqual({ min: [2, 2, 2], max: [3, 3, 3] });
    expect(part.size).toEqual([1, 1, 1]);
    // And back.
    part.setUnitScale(1);
    expect(new Box3().setFromObject(part.object).max.toArray()).toEqual([1, 1, 1]);
  });

  it('setUnitScale refuses 0, negative and non-finite scales and keeps the last one', () => {
    const part = buildPartMesh(positionsOf('inch-cube.stl'));
    part.setUnitScale(25.4);
    for (const bad of [0, -1, Number.NaN, Infinity]) expect(() => part.setUnitScale(bad)).toThrow(RangeError);
    expect(part.unitScale).toBe(25.4);
    expect(part.object.scale.toArray()).toEqual([25.4, 25.4, 25.4]);
  });

  it('gives each triangle a flat normal from its winding', () => {
    const part = buildPartMesh(positionsOf('cube-20mm-binary.stl'));
    const normals = part.object.geometry.getAttribute('normal');
    // Triangle 0 is on the bottom face, wound outward: normal -Z.
    expect([normals.getX(0), normals.getY(0), normals.getZ(0)]).toEqual([0, 0, -1]);
  });

  it('refuses an empty array, a partial triangle and a non-finite coordinate', () => {
    expect(() => buildPartMesh(new Float32Array(0))).toThrow(RangeError);
    expect(() => buildPartMesh(new Float32Array(8))).toThrow(RangeError);
    const bad = new Float32Array(9);
    bad[4] = Infinity;
    expect(() => buildPartMesh(bad)).toThrow(/finite/);
    bad[4] = NaN;
    expect(() => buildPartMesh(bad)).toThrow(/finite/);
  });

  it('dispose removes the mesh from its parent', () => {
    const part = buildPartMesh(positionsOf('inch-cube.stl'));
    const group = new Group();
    group.add(part.object);
    part.dispose();
    expect(part.object.parent).toBeNull();
  });

  it('draws open edges red and non-manifold edges magenta, placed with the part', () => {
    const open = positionsOf('open-box.stl');
    const part = buildPartMesh(open, inspectMesh(open));
    expect(part.nonManifoldEdges).toBeNull();
    const lines = part.openEdges!;
    expect(lines.parent).toBe(part.object);
    expect(lines.geometry.getAttribute('position').count).toBe(8); // 4 edges, 2 ends each
    expect((lines.material as LineBasicMaterial).color.getHex()).toBe(OPEN_EDGE_COLOR);
    // The rim of the missing top sits at the top of the placed part: z = 20 in the world.
    const world = new Box3().setFromObject(lines);
    expect(world.min.z).toBe(20);
    expect(world.max.toArray()).toEqual([20, 20, 20]);

    const bow = positionsOf('bowtie.stl');
    const tie = buildPartMesh(bow, inspectMesh(bow));
    expect(tie.openEdges).toBeNull();
    expect(tie.nonManifoldEdges!.geometry.getAttribute('position').count).toBe(2);
    expect((tie.nonManifoldEdges!.material as LineBasicMaterial).color.getHex()).toBe(NON_MANIFOLD_EDGE_COLOR);
  });

  it('draws no overlay for a watertight cube or when no inspection is given', () => {
    const cube = positionsOf('cube-20mm-binary.stl');
    for (const part of [buildPartMesh(cube, inspectMesh(cube)), buildPartMesh(cube)]) {
      expect(part.openEdges).toBeNull();
      expect(part.nonManifoldEdges).toBeNull();
      expect(part.object.children).toHaveLength(0);
    }
  });

  it('refuses a segment array that is not whole segments', () => {
    const cube = positionsOf('cube-20mm-binary.stl');
    const bad = { openEdgeSegments: new Float32Array(5), nonManifoldEdgeSegments: new Float32Array(0) };
    expect(() => buildPartMesh(cube, bad)).toThrow(/whole segments/);
  });
});
