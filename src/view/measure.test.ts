/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { OrthographicCamera, PerspectiveCamera, Raycaster, Vector2, Vector3, type Camera } from 'three';
import { describe, expect, it } from 'vitest';
import { rotate90 } from '../geom/orient';
import { parseStl } from '../io/parse';
import type { Vec3 } from '../state/model';
import { buildMeasureOverlay, measureBetween, pickMeasurePoint, SNAP_PX, worldOf } from './measure';
import { buildPartMesh, type PartMesh } from './partMesh';
import { frameView } from './views';

const positionsOf = (name: string): Float32Array =>
  parseStl(new Uint8Array(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url)))).positions;

const SIZE = { width: 800, height: 600 };

function isoCameras(part: PartMesh): { perspective: PerspectiveCamera; ortho: OrthographicCamera } {
  const perspective = new PerspectiveCamera(40, SIZE.width / SIZE.height, 1, 10_000);
  const ortho = new OrthographicCamera(-1, 1, 1, -1, 1, 10_000);
  const at = part.placement;
  const s = part.orientedSize.map((v) => v * part.unitScale);
  frameView('iso', { min: at, max: [at[0] + s[0]!, at[1] + s[1]!, at[2] + s[2]!] }, SIZE.width / SIZE.height, perspective, ortho);
  return { perspective, ortho };
}

function toPx(p: Vector3, camera: Camera): { x: number; y: number } {
  const ndc = p.clone().project(camera);
  return { x: ((ndc.x + 1) / 2) * SIZE.width, y: ((1 - ndc.y) / 2) * SIZE.height };
}

/** Clicks `px` CSS pixels from the world point `p`, toward `toward` on screen (into the part's silhouette). */
function clickNear(part: PartMesh, camera: Camera, p: Vec3, toward: Vec3, px: number) {
  const a = toPx(new Vector3(...p), camera);
  const b = toPx(new Vector3(...toward), camera);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const pointer = { x: a.x + ((b.x - a.x) / len) * px, y: a.y + ((b.y - a.y) / len) * px };
  const raycaster = new Raycaster();
  raycaster.setFromCamera(new Vector2((pointer.x / SIZE.width) * 2 - 1, -(pointer.y / SIZE.height) * 2 + 1), camera);
  return pickMeasurePoint(part, raycaster, camera, pointer, SIZE);
}

describe('measureBetween', () => {
  it('gives the distance and b − a per axis', () => {
    expect(measureBetween([0, 0, 0], [3, 4, 12])).toEqual({ distanceMm: 13, deltaMm: [3, 4, 12] });
    expect(measureBetween([5, 5, 5], [2, 5, 1]).deltaMm).toEqual([-3, 0, -4]);
    expect(measureBetween([1, 2, 3], [1, 2, 3]).distanceMm).toBe(0);
  });

  it('two opposite corners of the 20 mm cube measure 20√3', () => {
    expect(measureBetween([0, 0, 0], [20, 20, 20]).distanceMm).toBeCloseTo(20 * Math.sqrt(3), 12);
  });

  it('keeps a huge coordinate finite (no overflow in the squares)', () => {
    expect(measureBetween([0, 0, 0], [1e200, 1e200, 0]).distanceMm).toBeCloseTo(Math.SQRT2 * 1e200, -190);
  });
});

describe('pickMeasurePoint', () => {
  const centre: Vec3 = [10, 10, 10];

  it.each(['perspective', 'ortho'] as const)('clicks near two opposite cube corners snap to them and measure 20√3 (%s)', (kind) => {
    const part = buildPartMesh(positionsOf('cube-20mm-binary.stl'));
    const camera = isoCameras(part)[kind];
    const a = clickNear(part, camera, [0, 0, 0], centre, 2);
    const b = clickNear(part, camera, [20, 20, 20], centre, 2);
    expect(a?.snapped).toBe(true);
    expect(b?.snapped).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(a!.world[i]).toBeCloseTo(0, 9);
      expect(b!.world[i]).toBeCloseTo(20, 9);
    }
    expect(measureBetween(a!.world, b!.world).distanceMm).toBeCloseTo(20 * Math.sqrt(3), 9);
  });

  it(`does not snap a click more than ${SNAP_PX} px from every corner of the face`, () => {
    const part = buildPartMesh(positionsOf('cube-20mm-binary.stl'));
    const { perspective } = isoCameras(part);
    const p = clickNear(part, perspective, [0, 0, 0], centre, SNAP_PX * 3);
    expect(p).not.toBeNull();
    expect(p!.snapped).toBe(false);
    // Still on the cube's surface: one coordinate is on a face.
    expect(p!.world.some((v) => Math.abs(v) < 1e-6 || Math.abs(v - 20) < 1e-6)).toBe(true);
  });

  it('returns null when the ray misses the part', () => {
    const part = buildPartMesh(positionsOf('cube-20mm-binary.stl'));
    const { perspective } = isoCameras(part);
    const raycaster = new Raycaster();
    raycaster.setFromCamera(new Vector2(0.99, 0.99), perspective);
    expect(pickMeasurePoint(part, raycaster, perspective, { x: 796, y: 4 }, SIZE)).toBeNull();
  });

  it('a measure follows the part: inches scale it ×25.4, a turn or a move leaves it as long', () => {
    const part = buildPartMesh(positionsOf('cube-20mm-binary.stl'));
    const { perspective } = isoCameras(part);
    const a = clickNear(part, perspective, [0, 0, 0], centre, 1)!;
    const b = clickNear(part, perspective, [20, 20, 20], centre, 1)!;
    const length = (): number => measureBetween(worldOf(part, a.local), worldOf(part, b.local)).distanceMm;
    expect(length()).toBeCloseTo(20 * Math.sqrt(3), 9);
    part.setPlacement([3, 3, 2]);
    expect(length()).toBeCloseTo(20 * Math.sqrt(3), 9);
    expect(worldOf(part, a.local)[0]).toBeCloseTo(3, 9);
    part.setRotation(rotate90(part.rotation, 'Z'));
    expect(length()).toBeCloseTo(20 * Math.sqrt(3), 9);
    part.setUnitScale(25.4);
    expect(length()).toBeCloseTo(25.4 * 20 * Math.sqrt(3), 6);
  });
});

describe('buildMeasureOverlay', () => {
  it('shows nothing until a point is picked, a marker for one, the line for two', () => {
    const o = buildMeasureOverlay();
    const line = o.object.children[0]!;
    expect(o.object.visible).toBe(false);
    o.update([1, 2, 3], null);
    expect(o.object.visible).toBe(true);
    expect(line.visible).toBe(false);
    o.update([1, 2, 3], [4, 5, 6]);
    expect(line.visible).toBe(true);
    o.update(null, null);
    expect(o.object.visible).toBe(false);
    o.dispose();
  });
});
