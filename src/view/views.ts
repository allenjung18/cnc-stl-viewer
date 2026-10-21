/**
 * Standard views (top, front, right, iso) and the orthographic toggle, as pure
 * camera maths: no renderer, so it unit-tests in Node. `Viewport` wires it to
 * the keys and the orbit controls.
 *
 * The machine frame is Z-up and the front of the bed is -Y. Every camera keeps
 * `up` = +Z (what the orbit controls orbit about); the top view looks down -Z
 * from a hair in front of straight above, so +Y (the back of the bed) is up on
 * screen and the front of the bed is at the bottom.
 */
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import type { BBox } from '../state/model';

export type StandardView = 'top' | 'front' | 'right' | 'iso';

export const STANDARD_VIEWS: readonly StandardView[] = ['top', 'front', 'right', 'iso'];

/** Keys 1-4 pick the standard views. */
export const VIEW_KEYS: Readonly<Record<string, StandardView>> = Object.freeze({ '1': 'top', '2': 'front', '3': 'right', '4': 'iso' });

/**
 * How far the top view's camera leans toward the front (radians). Straight
 * above, `lookAt` with up = +Z has no defined screen-up; this lean fixes it to
 * +Y and stays above the orbit controls' pole clamp (1e-6), so orbiting from
 * the top view starts where it shows.
 */
export const TOP_VIEW_LEAN = 1e-5;

/** Unit direction from the target to the camera for each view. */
export function viewDirection(view: StandardView): Vector3 {
  switch (view) {
    case 'top':
      return new Vector3(0, -Math.sin(TOP_VIEW_LEAN), Math.cos(TOP_VIEW_LEAN));
    case 'front':
      return new Vector3(0, -1, 0);
    case 'right':
      return new Vector3(1, 0, 0);
    case 'iso':
      return new Vector3(1, -1, 1).normalize();
  }
}

/** Centre and bounding-sphere radius of a box, mm (a zero-size box gets a 1 mm radius so it can be framed). */
export function frameSphere(frame: BBox): { centre: Vector3; radius: number } {
  const min = new Vector3(...frame.min);
  const max = new Vector3(...frame.max);
  if (![min.x, min.y, min.z, max.x, max.y, max.z].every(Number.isFinite)) {
    throw new RangeError(`frame must be finite numbers, got ${frame.min.join(', ')} / ${frame.max.join(', ')}`);
  }
  const centre = min.clone().add(max).multiplyScalar(0.5);
  const radius = max.clone().sub(min).length() / 2;
  return { centre, radius: radius > 0 && Number.isFinite(radius) ? radius : 1 };
}

/** Margin around a framed box. */
const FRAME_MARGIN = 1.05;

/** Distance at which a perspective camera of this field of view and aspect shows a sphere of `radius` whole. */
export function frameDistance(fovDeg: number, aspect: number, radius: number): number {
  const vHalf = (fovDeg / 2) * (Math.PI / 180);
  const hHalf = Math.atan(Math.tan(vHalf) * aspect);
  return (radius / Math.sin(Math.min(vHalf, hHalf))) * FRAME_MARGIN;
}

/** Half the height of an orthographic view that shows a sphere of `radius` whole at this aspect. */
export function orthoHalfHeight(aspect: number, radius: number): number {
  return radius * FRAME_MARGIN * Math.max(1, 1 / aspect);
}

/** Sets an orthographic camera's frustum to `halfHeight` (at zoom 1) at this aspect. */
export function setOrthoFrustum(camera: OrthographicCamera, aspect: number, halfHeight: number): void {
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
  camera.left = -halfHeight * aspect;
  camera.right = halfHeight * aspect;
  camera.updateProjectionMatrix();
}

function look(camera: PerspectiveCamera | OrthographicCamera, target: Vector3, direction: Vector3, distance: number): void {
  camera.up.set(0, 0, 1);
  camera.position.copy(target).addScaledVector(direction, distance);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
}

/**
 * Puts both cameras in `view` of `frame`: looking at its centre along the
 * view's direction, the whole frame in sight. Returns the target the orbit
 * controls should use. The orthographic camera's zoom is reset to 1.
 */
export function frameView(
  view: StandardView | Vector3,
  frame: BBox,
  aspect: number,
  perspective: PerspectiveCamera,
  ortho: OrthographicCamera,
): Vector3 {
  const { centre, radius } = frameSphere(frame);
  const direction = view instanceof Vector3 ? view.clone().normalize() : viewDirection(view);
  const distance = frameDistance(perspective.fov, aspect, radius);
  perspective.aspect = aspect;
  perspective.updateProjectionMatrix();
  look(perspective, centre, direction, distance);
  ortho.zoom = 1;
  setOrthoFrustum(ortho, aspect, orthoHalfHeight(aspect, radius));
  look(ortho, centre, direction, distance);
  return centre;
}

/**
 * Moves the orthographic camera to where the perspective one is, sized so the
 * plane through the target looks the same size in both.
 */
export function perspectiveToOrtho(from: PerspectiveCamera, to: OrthographicCamera, target: Vector3, aspect: number): void {
  const distance = from.position.distanceTo(target);
  const halfHeight = distance * Math.tan(((from.fov / 2) * Math.PI) / 180);
  to.zoom = 1;
  setOrthoFrustum(to, aspect, halfHeight > 0 ? halfHeight : 1);
  to.up.copy(from.up);
  to.position.copy(from.position);
  to.quaternion.copy(from.quaternion);
  to.updateMatrixWorld(true);
}

/**
 * Moves the perspective camera to where the orthographic one looks from, at
 * the distance that shows the target plane at the orthographic view's size
 * (its zoom included).
 */
export function orthoToPerspective(from: OrthographicCamera, to: PerspectiveCamera, target: Vector3, aspect: number): void {
  const halfHeight = (from.top - from.bottom) / 2 / from.zoom;
  const distance = halfHeight / Math.tan(((to.fov / 2) * Math.PI) / 180);
  const direction = from.position.clone().sub(target);
  if (direction.lengthSq() === 0) direction.set(0, -1, 0);
  direction.normalize();
  to.aspect = aspect;
  to.updateProjectionMatrix();
  to.up.copy(from.up);
  look(to, target, direction, distance);
}

/** World direction of "up on screen" and "right on screen" for a camera. */
export function screenAxes(camera: PerspectiveCamera | OrthographicCamera): { up: Vector3; right: Vector3 } {
  camera.updateMatrixWorld(true);
  return {
    up: new Vector3(0, 1, 0).transformDirection(camera.matrixWorld),
    right: new Vector3(1, 0, 0).transformDirection(camera.matrixWorld),
  };
}
