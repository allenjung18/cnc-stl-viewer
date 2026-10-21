import { Frustum, Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { BBox } from '../state/model';
import { DEFAULT_PROFILE } from '../state/profiles';
import { envelopeBounds } from './scene';
import { boxCentre, createCamera, frameHome } from './viewport';

function corners(b: BBox): Vector3[] {
  const out: Vector3[] = [];
  for (const x of [b.min[0], b.max[0]])
    for (const y of [b.min[1], b.max[1]])
      for (const z of [b.min[2], b.max[2]]) out.push(new Vector3(x, y, z));
  return out;
}

describe('createCamera', () => {
  const frame = envelopeBounds(DEFAULT_PROFILE).travel;
  const camera = createCamera(16 / 9, frame);

  it('is Z-up', () => {
    expect(camera.up.toArray()).toEqual([0, 0, 1]);
  });

  it('looks at the centre of the frame from the front, above the bed', () => {
    const target = boxCentre(frame);
    expect(target.toArray()).toEqual([101.5, 101.5, 50]);
    const forward = camera.getWorldDirection(new Vector3());
    const toTarget = target.clone().sub(camera.position).normalize();
    expect(forward.dot(toTarget)).toBeCloseTo(1, 6);
    expect(camera.position.z).toBeGreaterThan(frame.max[2]); // above the envelope
    expect(camera.position.y).toBeLessThan(frame.min[1]); // in front of the bed (-Y)
  });

  it('shows world +Z pointing up on screen', () => {
    const screenUp = new Vector3(0, 1, 0).transformDirection(camera.matrixWorld);
    expect(screenUp.z).toBeGreaterThan(0.5);
  });

  it.each([16 / 9, 1, 9 / 16])('keeps every corner of the frame in view at aspect %f', (aspect) => {
    const cam = createCamera(aspect, frame);
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
    );
    for (const c of corners(frame)) expect(frustum.containsPoint(c)).toBe(true);
  });

  it('re-frames for a narrower window: a 16:9 camera reset to 9:16 still shows every corner', () => {
    const cam = createCamera(16 / 9, frame);
    frameHome(cam, 9 / 16, frame);
    expect(cam.aspect).toBeCloseTo(9 / 16, 9);
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
    );
    for (const c of corners(frame)) expect(frustum.containsPoint(c)).toBe(true);
  });
});
