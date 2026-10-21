import { Frustum, Matrix4, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { BBox } from '../state/model';
import { DEFAULT_PROFILE } from '../state/profiles';
import { envelopeBounds } from './scene';
import {
  frameSphere,
  frameView,
  orthoToPerspective,
  perspectiveToOrtho,
  screenAxes,
  STANDARD_VIEWS,
  VIEW_KEYS,
  viewDirection,
  type StandardView,
} from './views';

const travel = envelopeBounds(DEFAULT_PROFILE).travel;
const cube: BBox = { min: [3, 3, 2], max: [23, 23, 22] };

function cameras(aspect = 16 / 9): { perspective: PerspectiveCamera; ortho: OrthographicCamera } {
  return { perspective: new PerspectiveCamera(40, aspect, 1, 10_000), ortho: new OrthographicCamera(-1, 1, 1, -1, 1, 10_000) };
}

function corners(b: BBox): Vector3[] {
  const out: Vector3[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push(new Vector3(x, y, z));
  return out;
}

function inView(camera: PerspectiveCamera | OrthographicCamera, b: BBox): boolean {
  camera.updateMatrixWorld(true);
  const f = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  return corners(b).every((c) => f.containsPoint(c));
}

const close = (v: Vector3, x: number, y: number, z: number, eps = 1e-4): void => {
  expect(v.x).toBeCloseTo(x, -Math.log10(eps));
  expect(v.y).toBeCloseTo(y, -Math.log10(eps));
  expect(v.z).toBeCloseTo(z, -Math.log10(eps));
};

describe('standard views', () => {
  it('keys 1-4 are top, front, right, iso', () => {
    expect(VIEW_KEYS).toEqual({ '1': 'top', '2': 'front', '3': 'right', '4': 'iso' });
    expect(STANDARD_VIEWS).toEqual(['top', 'front', 'right', 'iso']);
  });

  it.each(STANDARD_VIEWS)('%s: a unit direction', (view) => {
    expect(viewDirection(view).length()).toBeCloseTo(1, 12);
  });

  // Each view: where the camera looks (forward), and the machine axes up and right on screen.
  const expected: Record<StandardView, { forward: [number, number, number]; up: [number, number, number]; right: [number, number, number] }> = {
    top: { forward: [0, 0, -1], up: [0, 1, 0], right: [1, 0, 0] }, // front of the bed at the bottom of the screen
    front: { forward: [0, 1, 0], up: [0, 0, 1], right: [1, 0, 0] },
    right: { forward: [-1, 0, 0], up: [0, 0, 1], right: [0, 1, 0] },
    iso: { forward: [-1 / Math.sqrt(3), 1 / Math.sqrt(3), -1 / Math.sqrt(3)], up: [-1 / Math.sqrt(6), 1 / Math.sqrt(6), 2 / Math.sqrt(6)], right: [Math.SQRT1_2, Math.SQRT1_2, 0] },
  };

  it.each(STANDARD_VIEWS)('%s: looks the right way with the right axes on screen, in both projections', (view) => {
    const { perspective, ortho } = cameras();
    frameView(view, cube, 16 / 9, perspective, ortho);
    for (const cam of [perspective, ortho]) {
      const e = expected[view];
      close(cam.getWorldDirection(new Vector3()), ...e.forward);
      const { up, right } = screenAxes(cam);
      close(up, ...e.up);
      close(right, ...e.right);
      expect(cam.up.toArray()).toEqual([0, 0, 1]); // the orbit stays Z-up
    }
  });

  it.each(STANDARD_VIEWS)('%s: frames every corner of the box at 16:9, 1:1 and 9:16', (view) => {
    for (const aspect of [16 / 9, 1, 9 / 16]) {
      for (const frame of [cube, travel]) {
        const { perspective, ortho } = cameras(aspect);
        const target = frameView(view, frame, aspect, perspective, ortho);
        expect(target.toArray()).toEqual(frameSphere(frame).centre.toArray());
        expect(inView(perspective, frame)).toBe(true);
        expect(inView(ortho, frame)).toBe(true);
      }
    }
  });

  it('the top view leans less than 1e-4 from straight down', () => {
    const d = viewDirection('top');
    expect(d.z).toBeGreaterThan(1 - 1e-8);
    expect(d.y).toBeLessThan(0);
    expect(Math.abs(d.y)).toBeLessThan(1e-4);
  });

  it('frames a zero-size box and refuses a non-finite one', () => {
    const { perspective, ortho } = cameras();
    expect(() => frameView('iso', { min: [5, 5, 5], max: [5, 5, 5] }, 1, perspective, ortho)).not.toThrow();
    expect(Number.isFinite(perspective.position.x)).toBe(true);
    expect(() => frameView('iso', { min: [0, 0, 0], max: [Infinity, 1, 1] }, 1, perspective, ortho)).toThrow(RangeError);
    expect(() => frameView('iso', { min: [0, 0, 0], max: [Number.NaN, 1, 1] }, 1, perspective, ortho)).toThrow(RangeError);
  });
});

describe('orthographic toggle', () => {
  it('perspective -> ortho keeps the position, the direction and the size of the target plane', () => {
    const { perspective, ortho } = cameras();
    const target = frameView('iso', travel, 16 / 9, perspective, ortho);
    perspective.position.add(new Vector3(30, -10, 5)); // as if orbited
    perspective.lookAt(target);
    perspectiveToOrtho(perspective, ortho, target, 16 / 9);
    expect(ortho.position.toArray()).toEqual(perspective.position.toArray());
    close(ortho.getWorldDirection(new Vector3()), ...perspective.getWorldDirection(new Vector3()).toArray());
    const halfHeight = perspective.position.distanceTo(target) * Math.tan((20 * Math.PI) / 180);
    expect(ortho.top).toBeCloseTo(halfHeight, 9);
    expect(ortho.right / ortho.top).toBeCloseTo(16 / 9, 9);
    expect(ortho.zoom).toBe(1);
  });

  it('ortho -> perspective -> ortho round-trips, and the ortho zoom becomes distance', () => {
    const { perspective, ortho } = cameras();
    const target = frameView('top', cube, 1, perspective, ortho);
    ortho.zoom = 2;
    ortho.updateProjectionMatrix();
    const shownHalf = ortho.top / ortho.zoom; // the half-height the zoomed ortho view shows
    orthoToPerspective(ortho, perspective, target, 1);
    // The target plane shows the same half-height in perspective.
    expect(perspective.position.distanceTo(target) * Math.tan((20 * Math.PI) / 180)).toBeCloseTo(shownHalf, 6);
    close(perspective.getWorldDirection(new Vector3()), 0, 0, -1);
    close(screenAxes(perspective).up, 0, 1, 0);
    perspectiveToOrtho(perspective, ortho, target, 1);
    expect(ortho.zoom).toBe(1);
    expect(ortho.top).toBeCloseTo(orthoHalfOf(cube) / 2, 6);
  });
});

/** The ortho half-height frameView gives this box at aspect 1. */
function orthoHalfOf(b: BBox): number {
  return frameSphere(b).radius * 1.05;
}
