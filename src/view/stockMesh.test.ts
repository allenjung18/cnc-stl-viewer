import { Box3, Group, type LineSegments, type MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { checkFit } from '../geom/fit';
import { DEFAULT_PROFILE } from '../state/profiles';
import { buildKeepOutMesh, buildStockMesh, hatchSegments, STOCK_COLOR, STOCK_FAIL_COLOR } from './stockMesh';

const boxOf = (o: Parameters<Box3['setFromObject']>[0]) => {
  const b = new Box3().setFromObject(o);
  return { min: b.min.toArray(), max: b.max.toArray() };
};

describe('buildStockMesh', () => {
  it('is hidden until there is a stock', () => {
    const s = buildStockMesh();
    expect(s.object.visible).toBe(false);
    s.update({ stockBox: null, wcs: null, failed: false });
    expect(s.object.visible).toBe(false);
  });

  it('draws the auto stock of the 20 mm cube as a 26 × 26 × 23 box from the bed, WCS marker at its front-left top', () => {
    const r = checkFit({
      partSize: [20, 20, 20],
      stock: { mode: 'auto', allowance: { xy: 3, top: 1, bottom: 2 }, size: [0, 0, 0] },
      setup: { origin: 'bottom-left-front-top', stockOnBed: [0, 0, 0] },
      profile: DEFAULT_PROFILE,
    });
    const s = buildStockMesh();
    s.update({ stockBox: r.stockBox, wcs: r.wcs, failed: !r.fits });
    expect(s.object.visible).toBe(true);
    expect(boxOf(s.box)).toEqual({ min: [0, 0, 0], max: [26, 26, 23] });
    expect(boxOf(s.outline)).toEqual({ min: [0, 0, 0], max: [26, 26, 23] });
    expect(s.marker.position.toArray()).toEqual([0, 0, 23]);
    expect(s.marker.visible).toBe(true);
    expect(s.color).toBe(STOCK_COLOR);
    expect((s.box.material as MeshStandardMaterial).transparent).toBe(true);
  });

  it('turns red on a failure and back when it passes', () => {
    const s = buildStockMesh();
    const stockBox = { min: [0, 0, 0] as const, max: [210, 100, 20] as const };
    s.update({ stockBox, wcs: [0, 0, 20], failed: true });
    expect(s.color).toBe(STOCK_FAIL_COLOR);
    expect((s.box.material as MeshStandardMaterial).color.getHex()).toBe(STOCK_FAIL_COLOR);
    expect(((s.outline as LineSegments).material as MeshStandardMaterial).color.getHex()).toBe(STOCK_FAIL_COLOR);
    s.update({ stockBox, wcs: [0, 0, 20], failed: false });
    expect((s.box.material as MeshStandardMaterial).color.getHex()).toBe(STOCK_COLOR);
  });

  it('draws a zero-height stock without a degenerate matrix', () => {
    const s = buildStockMesh();
    s.update({ stockBox: { min: [0, 0, 0], max: [10, 10, 0] }, wcs: [0, 0, 0], failed: false });
    expect(s.box.scale.z).toBeGreaterThan(0);
    expect(s.box.matrixWorld.determinant()).not.toBe(0);
  });

  it('dispose detaches it', () => {
    const s = buildStockMesh();
    const g = new Group();
    g.add(s.object);
    s.dispose();
    expect(s.object.parent).toBeNull();
  });
});

describe('keep-out', () => {
  it('draws each box as an outline and a hatched top, and redraws from scratch', () => {
    const k = buildKeepOutMesh();
    k.update([{ min: [20, 10, 0], max: [40, 30, 8] }]);
    expect(k.object.children.map((c) => c.name)).toEqual(['keep-out:0:outline', 'keep-out:0:hatch']);
    expect(boxOf(k.object.children[0]!)).toEqual({ min: [20, 10, 0], max: [40, 30, 8] });
    const hatch = boxOf(k.object.children[1]!);
    expect(hatch.min[2]).toBe(8);
    expect(hatch.max[2]).toBe(8);
    k.update([]);
    expect(k.object.children).toEqual([]);
  });

  it('hatch lines stay inside the rectangle and are capped in number', () => {
    const pts = hatchSegments(20, 10, 5);
    expect(pts.length % 6).toBe(0);
    for (let i = 0; i < pts.length; i += 3) {
      expect(pts[i]!).toBeGreaterThanOrEqual(0);
      expect(pts[i]!).toBeLessThanOrEqual(20);
      expect(pts[i + 1]!).toBeGreaterThanOrEqual(0);
      expect(pts[i + 1]!).toBeLessThanOrEqual(10 + 1e-9);
    }
    expect(hatchSegments(1e13, 1e13, 1).length / 6).toBeLessThanOrEqual(400);
    expect(hatchSegments(0, 10, 1)).toEqual([]);
    expect(hatchSegments(Infinity, 10, 1)).toEqual([]);
  });
});
