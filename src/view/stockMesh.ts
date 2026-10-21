import {
  AxesHelper,
  BoxGeometry,
  BufferGeometry,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
} from 'three';
import type { BBox, Vec3 } from '../state/model';

/** The stock block when every check passes. */
export const STOCK_COLOR = 0xd9b77e;
/** The stock block when any check fails. */
export const STOCK_FAIL_COLOR = 0xff3b30;
/** Keep-out boxes on the bed. */
export const KEEP_OUT_COLOR = 0xff3b30;
/** Length of each arm of the WCS origin triad, mm. */
export const WCS_AXES_MM = 15;

/** Size used for a zero-thickness side, so the box's matrix stays invertible. */
const MIN_DRAWN_MM = 1e-6;

/** What the stock view draws: the stock on the bed, the WCS origin, and whether a check failed. */
export interface StockView {
  readonly stockBox: BBox | null;
  readonly wcs: Vec3 | null;
  readonly failed: boolean;
}

/** The stock block (translucent box + outline) and the WCS origin marker. */
export interface StockMesh {
  readonly object: Group;
  readonly box: Mesh;
  readonly outline: LineSegments;
  /** RGB triad and a dot at the work zero. */
  readonly marker: Group;
  /** The colour drawn now (`STOCK_COLOR` or `STOCK_FAIL_COLOR`). */
  readonly color: number;
  update(view: StockView): void;
  dispose(): void;
}

export function buildStockMesh(): StockMesh {
  const object = new Group();
  object.name = 'stock';

  const unit = new BoxGeometry(1, 1, 1);
  const boxMaterial = new MeshStandardMaterial({
    color: STOCK_COLOR,
    transparent: true,
    opacity: 0.25,
    depthWrite: false, // the part inside stays visible
    roughness: 0.8,
    metalness: 0,
  });
  const box = new Mesh(unit, boxMaterial);
  box.name = 'stock:box';
  box.renderOrder = 2;

  const edges = new EdgesGeometry(unit);
  const outlineMaterial = new LineBasicMaterial({ color: STOCK_COLOR });
  const outline = new LineSegments(edges, outlineMaterial);
  outline.name = 'stock:outline';
  outline.renderOrder = 2;

  const marker = new Group();
  marker.name = 'wcs-origin';
  const axes = new AxesHelper(WCS_AXES_MM);
  const axesMaterial = axes.material as LineBasicMaterial;
  axesMaterial.depthTest = false; // seen through the stock and the part
  axes.renderOrder = 11;
  const dotGeometry = new SphereGeometry(1.2, 12, 8);
  const dotMaterial = new MeshBasicMaterial({ color: 0xffffff, depthTest: false });
  const dot = new Mesh(dotGeometry, dotMaterial);
  dot.renderOrder = 11;
  marker.add(axes, dot);

  object.add(box, outline, marker);
  object.visible = false;
  let color = STOCK_COLOR;

  return {
    object,
    box,
    outline,
    marker,
    get color() {
      return color;
    },
    update({ stockBox, wcs, failed }: StockView) {
      if (!stockBox) {
        object.visible = false;
        return;
      }
      const size = [0, 1, 2].map((i) => Math.max(stockBox.max[i]! - stockBox.min[i]!, MIN_DRAWN_MM));
      const centre = [0, 1, 2].map((i) => (stockBox.min[i]! + stockBox.max[i]!) / 2);
      for (const o of [box, outline]) {
        o.scale.set(size[0]!, size[1]!, size[2]!);
        o.position.set(centre[0]!, centre[1]!, centre[2]!);
      }
      color = failed ? STOCK_FAIL_COLOR : STOCK_COLOR;
      boxMaterial.color.setHex(color);
      outlineMaterial.color.setHex(color);
      marker.visible = wcs !== null;
      if (wcs) marker.position.set(wcs[0], wcs[1], wcs[2]);
      object.visible = true;
      object.updateMatrixWorld(true);
    },
    dispose() {
      object.removeFromParent();
      unit.dispose();
      edges.dispose();
      boxMaterial.dispose();
      outlineMaterial.dispose();
      axes.geometry.dispose();
      axesMaterial.dispose();
      dotGeometry.dispose();
      dotMaterial.dispose();
    },
  };
}

/** Hatch pitch on a keep-out box's top, mm; widened so one box never needs more than this many lines. */
const HATCH_PITCH_MM = 5;
const HATCH_MAX_LINES = 400;

/**
 * Diagonal hatch lines (x + y = const) clipped to a w × d rectangle at height z,
 * as segment endpoints relative to the rectangle's min corner.
 */
export function hatchSegments(w: number, d: number, z: number): number[] {
  const pts: number[] = [];
  if (!(w > 0 && d > 0) || !Number.isFinite(w + d + z)) return pts;
  const pitch = Math.max(HATCH_PITCH_MM, (w + d) / HATCH_MAX_LINES);
  for (let k = pitch; k < w + d; k += pitch) {
    const x1 = Math.max(0, k - d);
    const x2 = Math.min(w, k);
    pts.push(x1, k - x1, z, x2, k - x2, z);
  }
  return pts;
}

/** The keep-out boxes on the bed: a red outline with a hatched top each. */
export interface KeepOutMesh {
  readonly object: Group;
  update(boxes: readonly BBox[]): void;
  dispose(): void;
}

export function buildKeepOutMesh(): KeepOutMesh {
  const object = new Group();
  object.name = 'keep-out';
  const material = new LineBasicMaterial({ color: KEEP_OUT_COLOR });
  const clear = (): void => {
    for (const child of [...object.children]) {
      (child as LineSegments).geometry.dispose();
      child.removeFromParent();
    }
  };
  return {
    object,
    update(boxes) {
      clear();
      boxes.forEach((b, i) => {
        const size = [0, 1, 2].map((k) => Math.max(b.max[k]! - b.min[k]!, MIN_DRAWN_MM));
        const unit = new BoxGeometry(size[0], size[1], size[2]);
        const outline = new LineSegments(new EdgesGeometry(unit), material);
        unit.dispose();
        outline.name = `keep-out:${i}:outline`;
        outline.position.set(b.min[0] + size[0]! / 2, b.min[1] + size[1]! / 2, b.min[2] + size[2]! / 2);
        const hatchGeometry = new BufferGeometry();
        hatchGeometry.setAttribute('position', new Float32BufferAttribute(hatchSegments(size[0]!, size[1]!, size[2]!), 3));
        const hatch = new LineSegments(hatchGeometry, material);
        hatch.name = `keep-out:${i}:hatch`;
        hatch.position.set(b.min[0], b.min[1], b.min[2]);
        object.add(outline, hatch);
      });
      object.updateMatrixWorld(true);
    },
    dispose() {
      clear();
      object.removeFromParent();
      material.dispose();
    },
  };
}
