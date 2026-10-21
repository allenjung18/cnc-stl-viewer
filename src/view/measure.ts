/**
 * Two-point measure: click two points on the part, read the distance and
 * ΔX / ΔY / ΔZ. A click within `SNAP_PX` of a corner of the face under the
 * pointer snaps to that vertex, so corner-to-corner reads exact.
 *
 * Points are kept in the part's own (file) space and turned into machine
 * coordinates when drawn or read, so a measure follows the part when it is
 * turned, re-scaled for inches or moved in its stock.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Line,
  LineBasicMaterial,
  Points,
  PointsMaterial,
  Vector3,
  type Camera,
  type Object3D,
  type Raycaster,
} from 'three';
import type { Vec3 } from '../state/model';

/** How near (CSS px) a click must be to a vertex of the clicked face to snap to it. */
export const SNAP_PX = 6;

export const MEASURE_COLOR = 0xffd479;

export interface Measurement {
  readonly distanceMm: number;
  /** b − a, machine axes, mm. */
  readonly deltaMm: Vec3;
}

/** The distance and per-axis difference from `a` to `b`, machine axes, mm. */
export function measureBetween(a: Vec3, b: Vec3): Measurement {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  return { distanceMm: Math.hypot(d[0], d[1], d[2]), deltaMm: d };
}

/** A picked point: where it is on the part (file space) and on the bed (machine axes, mm). */
export interface MeasurePoint {
  /** Part (file) space: follows the part's rotation, scale and placement. */
  readonly local: Vec3;
  readonly world: Vec3;
  /** Snapped to a vertex of the clicked face. */
  readonly snapped: boolean;
}

/** The part as the measure tool needs it: its mesh and the triangle soup it draws, file units. */
export interface MeasureTarget {
  readonly object: Object3D;
  readonly positions: ArrayLike<number>;
}

const toVec3 = (v: Vector3): Vec3 => [v.x, v.y, v.z];

/**
 * The point under the ray on the part, snapped to the nearest corner of the hit
 * face when that corner lands within `snapPx` of `pointerPx` on screen; null on
 * a miss. `sizePx` is the canvas size in CSS px.
 */
export function pickMeasurePoint(
  target: MeasureTarget,
  raycaster: Raycaster,
  camera: Camera,
  pointerPx: { x: number; y: number },
  sizePx: { width: number; height: number },
  snapPx = SNAP_PX,
): MeasurePoint | null {
  target.object.updateMatrixWorld(true);
  const hit = raycaster.intersectObject(target.object, false).find((h) => h.faceIndex != null);
  if (!hit || hit.faceIndex == null) return null;
  const p = target.positions;
  const base = hit.faceIndex * 9;
  let best: { local: Vector3; world: Vector3; px: number } | null = null;
  for (let k = 0; k < 3; k++) {
    const local = new Vector3(p[base + 3 * k]!, p[base + 3 * k + 1]!, p[base + 3 * k + 2]!);
    const world = local.clone().applyMatrix4(target.object.matrixWorld);
    const ndc = world.clone().project(camera);
    const sx = ((ndc.x + 1) / 2) * sizePx.width;
    const sy = ((1 - ndc.y) / 2) * sizePx.height;
    const px = Math.hypot(sx - pointerPx.x, sy - pointerPx.y);
    if (Number.isFinite(px) && px <= snapPx && (!best || px < best.px)) best = { local, world, px };
  }
  if (best) return { local: toVec3(best.local), world: toVec3(best.world), snapped: true };
  const local = target.object.worldToLocal(hit.point.clone());
  return { local: toVec3(local), world: toVec3(hit.point), snapped: false };
}

/** A point kept in part space, where it is on the bed now. */
export function worldOf(target: MeasureTarget, local: Vec3): Vec3 {
  target.object.updateMatrixWorld(true);
  return toVec3(new Vector3(...local).applyMatrix4(target.object.matrixWorld));
}

/** The markers and the line between the two points, drawn over everything. */
export interface MeasureOverlay {
  readonly object: Object3D;
  /** Draws the points given (machine axes, mm); null hides them. */
  update(a: Vec3 | null, b: Vec3 | null): void;
  dispose(): void;
}

export function buildMeasureOverlay(): MeasureOverlay {
  const pointsGeometry = new BufferGeometry();
  pointsGeometry.setAttribute('position', new BufferAttribute(new Float32Array(6), 3));
  const pointsMaterial = new PointsMaterial({ color: MEASURE_COLOR, size: 8, sizeAttenuation: false, depthTest: false, transparent: true });
  const points = new Points(pointsGeometry, pointsMaterial);
  points.name = 'measure-points';
  points.renderOrder = 20;
  points.frustumCulled = false;

  const lineGeometry = new BufferGeometry();
  lineGeometry.setAttribute('position', new BufferAttribute(new Float32Array(6), 3));
  const lineMaterial = new LineBasicMaterial({ color: MEASURE_COLOR, depthTest: false, transparent: true });
  const line = new Line(lineGeometry, lineMaterial);
  line.name = 'measure-line';
  line.renderOrder = 20;
  line.frustumCulled = false;

  points.add(line);
  points.visible = false;
  line.visible = false;

  return {
    object: points,
    update(a, b) {
      const pts = [a, b].filter((v): v is Vec3 => v !== null);
      points.visible = pts.length > 0;
      line.visible = a !== null && b !== null;
      const pa = pointsGeometry.getAttribute('position') as BufferAttribute;
      pts.forEach((v, i) => pa.setXYZ(i, v[0], v[1], v[2]));
      pa.needsUpdate = true;
      pointsGeometry.setDrawRange(0, pts.length);
      if (a && b) {
        const la = lineGeometry.getAttribute('position') as BufferAttribute;
        la.setXYZ(0, a[0], a[1], a[2]);
        la.setXYZ(1, b[0], b[1], b[2]);
        la.needsUpdate = true;
      }
    },
    dispose() {
      points.removeFromParent();
      pointsGeometry.dispose();
      pointsMaterial.dispose();
      lineGeometry.dispose();
      lineMaterial.dispose();
    },
  };
}
