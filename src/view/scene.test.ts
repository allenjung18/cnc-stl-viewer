import { Box3, BufferAttribute, LineSegments, Object3D, Vector3, type Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import type { MachineProfile } from '../state/model';
import { DEFAULT_PROFILE } from '../state/profiles';
import { AXES_LENGTH_MM, buildBedGrid, buildScene, envelopeBounds } from './scene';

const EPS = 1e-6;

function worldPoints(root: Object3D): Vector3[] {
  root.updateMatrixWorld(true);
  const pts: Vector3[] = [];
  root.traverse((o) => {
    if (!(o instanceof LineSegments)) return;
    const pos = o.geometry.getAttribute('position') as BufferAttribute;
    for (let i = 0; i < pos.count; i++) pts.push(new Vector3().fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld));
  });
  return pts;
}

/** Unit normal of a planar line set: the cross product of its first two non-parallel segment directions. */
function lineSetNormal(root: Object3D): Vector3 {
  const pts = worldPoints(root);
  const dirs: Vector3[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) dirs.push(pts[i + 1]!.clone().sub(pts[i]!).normalize());
  const first = dirs[0]!;
  const second = dirs.find((d) => d.clone().cross(first).length() > 0.5);
  if (!second) throw new Error('line set has no two non-parallel segments');
  // Order the pair so the X-running line comes first: X × Y = +Z in a right-handed frame.
  const [a, b] = Math.abs(first.x) > Math.abs(second.x) ? [first, second] : [second, first];
  return a.clone().cross(b).normalize();
}

function expectVec(v: Vector3, x: number, y: number, z: number) {
  expect(v.x).toBeCloseTo(x, 6);
  expect(v.y).toBeCloseTo(y, 6);
  expect(v.z).toBeCloseTo(z, 6);
}

describe('buildScene (headless)', () => {
  const machine = buildScene(DEFAULT_PROFILE);
  machine.scene.updateMatrixWorld(true);

  it('sets the global up axis to +Z', () => {
    expectVec(Object3D.DEFAULT_UP, 0, 0, 1);
    expectVec(new Object3D().up, 0, 0, 1);
  });

  it('lays the grid flat in XY at Z = 0, with its normal +Z', () => {
    const pts = worldPoints(machine.grid);
    expect(pts.length).toBeGreaterThan(0);
    for (const p of pts) expect(Math.abs(p.z)).toBeLessThan(EPS);
    expectVec(lineSetNormal(machine.grid), 0, 0, 1);
  });

  it('covers the cutting area with the grid, anchored at the origin', () => {
    const box = new Box3().setFromObject(machine.grid);
    expectVec(box.min, 0, 0, 0);
    expectVec(box.max, 203, 203, 0);
    const xs = new Set(worldPoints(machine.grid).filter((p) => p.y === 0).map((p) => Math.round(p.x * 1e6) / 1e6));
    for (const x of [0, 10, 50, 100, 200, 203]) expect(xs.has(x)).toBe(true);
  });

  it('faces the bed plate up (+Z) at Z = 0 over the cutting area', () => {
    const bed = machine.bed as Mesh;
    const normal = new Vector3()
      .fromBufferAttribute(bed.geometry.getAttribute('normal') as BufferAttribute, 0)
      .transformDirection(bed.matrixWorld);
    expectVec(normal, 0, 0, 1);
    const box = new Box3().setFromObject(bed);
    expectVec(box.min, 0, 0, 0);
    expectVec(box.max, 203, 203, 0);
  });

  it('draws the cutting-area box exactly as the profile says, from the origin up', () => {
    const box = new Box3().setFromObject(machine.cuttingBox);
    expectVec(box.min, 0, 0, 0);
    expectVec(box.max, 203, 203, 76);
  });

  it('draws the travel box at the profile travel, centred on the cutting area in XY', () => {
    const box = new Box3().setFromObject(machine.travelBox);
    expectVec(box.getSize(new Vector3()), 250, 250, 100);
    expect(box.min.z).toBeCloseTo(0, 6);
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(101.5, 6);
    expect((box.min.y + box.max.y) / 2).toBeCloseTo(101.5, 6);
  });

  it('puts RGB axes at the origin: X red, Y green, Z blue', () => {
    expectVec(machine.axes.getWorldPosition(new Vector3()), 0, 0, 0);
    const pos = machine.axes.geometry.getAttribute('position') as BufferAttribute;
    const col = machine.axes.geometry.getAttribute('color') as BufferAttribute;
    // AxesHelper: vertex pairs (0,1) X, (2,3) Y, (4,5) Z.
    expectVec(new Vector3().fromBufferAttribute(pos, 1), AXES_LENGTH_MM, 0, 0);
    expectVec(new Vector3().fromBufferAttribute(pos, 3), 0, AXES_LENGTH_MM, 0);
    expectVec(new Vector3().fromBufferAttribute(pos, 5), 0, 0, AXES_LENGTH_MM);
    expectVec(new Vector3().fromBufferAttribute(col, 0), 1, 0, 0);
    expectVec(new Vector3().fromBufferAttribute(col, 2), 0, 1, 0);
    expectVec(new Vector3().fromBufferAttribute(col, 4), 0, 0, 1);
  });

  it('names every machine object so later chunks and the smoke test can find them', () => {
    for (const name of ['bed', 'grid', 'axes', 'envelope:travel', 'envelope:cutting']) {
      expect(machine.scene.getObjectByName(name)).toBeDefined();
    }
  });
});

describe('envelope boxes follow the profile, not fixed numbers', () => {
  const custom: MachineProfile = {
    name: 'test mill',
    units: 'mm',
    travel: [300, 180, 90],
    cuttingArea: [120, 85, 40],
    bedOriginNote: 'test',
  };

  it('computes both bounds from the profile', () => {
    const b = envelopeBounds(custom);
    expect(b.cutting).toEqual({ min: [0, 0, 0], max: [120, 85, 40] });
    expect(b.travel).toEqual({ min: [-90, -47.5, 0], max: [210, 132.5, 90] });
  });

  it('builds a scene whose boxes and grid match a non-default profile', () => {
    const m = buildScene(custom);
    m.scene.updateMatrixWorld(true);
    const cut = new Box3().setFromObject(m.cuttingBox);
    expectVec(cut.max, 120, 85, 40);
    expectVec(new Box3().setFromObject(m.travelBox).getSize(new Vector3()), 300, 180, 90);
    expectVec(new Box3().setFromObject(m.grid).max, 120, 85, 0);
  });
});

describe('buildBedGrid refuses sizes it cannot draw', () => {
  it.each([
    ['zero pitch', 203, 203, 0, 50],
    ['negative size', -1, 203, 10, 50],
    ['zero size', 0, 203, 10, 50],
    ['infinite size', Infinity, 203, 10, 50],
    ['NaN size', 203, NaN, 10, 50],
    ['too many lines', 1e12, 203, 10, 50],
    ['tiny pitch', 203, 203, 1e-9, 50],
  ])('throws on %s instead of hanging', (_label, sx, sy, minor, major) => {
    expect(() => buildBedGrid(sx, sy, minor, major)).toThrow(RangeError);
  });

  it('still draws a bed smaller than one grid pitch', () => {
    const grid = buildBedGrid(5, 5, 10, 50);
    expectVec(new Box3().setFromObject(grid).max, 5, 5, 0);
  });
});
