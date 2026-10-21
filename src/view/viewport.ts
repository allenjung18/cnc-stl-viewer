import { PerspectiveCamera, Vector3, WebGLRenderer, type Scene } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { BBox } from '../state/model';
import { applyZUp } from './scene';

/** Centre of a box, mm. */
export function boxCentre(box: BBox): Vector3 {
  return new Vector3(
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  );
}

/** Direction from the target to the camera in the home view: front-right, above the bed (front is -Y). */
const HOME_DIRECTION = new Vector3(0.7, -1.2, 0.9).normalize();
const FOV_DEG = 40;

/**
 * A Z-up perspective camera looking at the centre of `frame` from the
 * front-right, above the bed, far enough back that the whole frame is in view
 * at this aspect ratio.
 */
export function createCamera(aspect: number, frame: BBox): PerspectiveCamera {
  applyZUp();
  const camera = new PerspectiveCamera(FOV_DEG, aspect, 1, 10_000);
  frameHome(camera, aspect, frame);
  return camera;
}

/**
 * Puts `camera` in the home view for `frame` at this aspect ratio: looking at the
 * frame's centre from the front-right, above the bed, far enough back that every
 * corner of the frame is in view.
 */
export function frameHome(camera: PerspectiveCamera, aspect: number, frame: BBox): void {
  const target = boxCentre(frame);
  const radius = new Vector3(
    frame.max[0] - frame.min[0],
    frame.max[1] - frame.min[1],
    frame.max[2] - frame.min[2],
  ).length() / 2;
  const vHalf = ((camera.fov / 2) * Math.PI) / 180;
  const hHalf = Math.atan(Math.tan(vHalf) * aspect);
  const distance = (radius / Math.sin(Math.min(vHalf, hHalf))) * 1.05;
  camera.aspect = aspect;
  camera.position.copy(target).addScaledVector(HOME_DIRECTION, distance);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

/** Renderer, camera and orbit controls bound to one container element. Renders on demand. */
export class Viewport {
  readonly renderer: WebGLRenderer;
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private frameRequested = false;
  /** Until the user orbits, pans or zooms, a resize re-frames the home view for the new aspect. */
  private userMoved = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly scene: Scene,
    private readonly frame: BBox,
  ) {
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    const aspect = Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight);
    this.camera = createCamera(aspect, frame);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(boxCentre(frame));
    this.controls.update();
    this.controls.addEventListener('change', () => this.requestRender());
    this.controls.addEventListener('start', () => {
      this.userMoved = true;
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  requestRender(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.renderer.render(this.scene, this.camera);
    });
  }

  resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    if (this.userMoved) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    } else {
      frameHome(this.camera, width / height, this.frame);
      this.controls.target.copy(boxCentre(this.frame));
      this.controls.update();
    }
    this.requestRender();
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
