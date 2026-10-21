/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { Box3, Group } from 'three';
import { describe, expect, it } from 'vitest';
import { CUBE_MIN } from '../../test/fixtures/tiny-generator';
import { parseStl } from '../io/parse';
import { buildPartMesh } from './partMesh';

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
});
