import { OrthographicCamera, PerspectiveCamera, Vector3, WebGLRenderer, type Scene } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { BBox } from '../state/model';
import { applyZUp } from './scene';
import { frameView, orthoToPerspective, perspectiveToOrtho, setOrthoFrustum, type StandardView } from './views';

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

/** Renderer, a perspective and an orthographic camera, and orbit controls bound to one container element. Renders on demand. */
export class Viewport {
  readonly renderer: WebGLRenderer;
  readonly perspective: PerspectiveCamera;
  /** True scale: what CNC people check dimensions in. Toggled with `O`. */
  readonly ortho: OrthographicCamera;
  readonly controls: OrbitControls;
  private active: PerspectiveCamera | OrthographicCamera;
  private readonly resizeObserver: ResizeObserver;
  private frameRequested = false;
  /** Until the user orbits, pans, zooms or picks a view, a resize re-frames the home view for the new aspect. */
  private userMoved = false;
  private readonly afterRender: Array<() => void> = [];
  /** The standard view last picked, or null once the user orbits away from it (or before any). */
  private currentView: StandardView | null = null;

  constructor(
    private readonly container: HTMLElement,
    private scene: Scene,
    private frame: BBox,
  ) {
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    const aspect = this.aspect();
    this.perspective = createCamera(aspect, frame);
    this.ortho = new OrthographicCamera(-1, 1, 1, -1, 1, 10_000);
    perspectiveToOrtho(this.perspective, this.ortho, boxCentre(frame), aspect);
    this.active = this.perspective;
    this.controls = new OrbitControls(this.perspective, this.renderer.domElement);
    this.controls.target.copy(boxCentre(frame));
    this.controls.update();
    this.controls.addEventListener('change', () => this.requestRender());
    this.controls.addEventListener('start', () => {
      this.userMoved = true;
      this.currentView = null;
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  /** The camera the view is drawn with. */
  get camera(): PerspectiveCamera | OrthographicCamera {
    return this.active;
  }

  get isOrtho(): boolean {
    return this.active === this.ortho;
  }

  get view(): StandardView | null {
    return this.currentView;
  }

  private aspect(): number {
    return Math.max(1, this.container.clientWidth) / Math.max(1, this.container.clientHeight);
  }

  /** Swaps in a rebuilt scene (a new machine profile) and the box the home view frames. */
  setScene(scene: Scene, frame: BBox): void {
    this.scene = scene;
    this.frame = frame;
    if (!this.userMoved) this.home();
    this.requestRender();
  }

  /** Runs `fn` after every frame is drawn (overlays that follow the camera). */
  onAfterRender(fn: () => void): void {
    this.afterRender.push(fn);
  }

  private home(): void {
    const aspect = this.aspect();
    const target = boxCentre(this.frame);
    frameHome(this.perspective, aspect, this.frame);
    if (this.isOrtho) perspectiveToOrtho(this.perspective, this.ortho, target, aspect);
    this.controls.target.copy(target);
    this.controls.update();
  }

  /** Shows `frame` (default: the machine's travel) from a standard view, in the current projection. */
  setView(view: StandardView, frame: BBox = this.frame): void {
    const target = frameView(view, frame, this.aspect(), this.perspective, this.ortho);
    this.userMoved = true;
    this.controls.target.copy(target);
    this.controls.update();
    this.currentView = view;
    this.requestRender();
  }

  /** Re-frames `frame` from the current viewing direction. */
  fit(frame: BBox = this.frame): void {
    const direction = this.active.position.clone().sub(this.controls.target);
    if (direction.lengthSq() === 0) direction.set(0, -1, 0);
    const view = this.currentView;
    const target = frameView(view ?? direction, frame, this.aspect(), this.perspective, this.ortho);
    this.userMoved = true;
    this.controls.target.copy(target);
    this.controls.update();
    this.currentView = view;
    this.requestRender();
  }

  /** Orthographic (true scale) on or off; the view direction, target and apparent size are kept. */
  setOrtho(on: boolean): void {
    if (on === this.isOrtho) return;
    const aspect = this.aspect();
    const target = this.controls.target;
    if (on) perspectiveToOrtho(this.perspective, this.ortho, target, aspect);
    else orthoToPerspective(this.ortho, this.perspective, target, aspect);
    this.active = on ? this.ortho : this.perspective;
    const view = this.currentView;
    this.controls.object = this.active;
    this.controls.update();
    this.currentView = view;
    this.requestRender();
  }

  toggleOrtho(): void {
    this.setOrtho(!this.isOrtho);
  }

  requestRender(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.renderer.render(this.scene, this.active);
      for (const fn of this.afterRender) fn();
    });
  }

  resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    if (this.userMoved) {
      const aspect = width / height;
      this.perspective.aspect = aspect;
      this.perspective.updateProjectionMatrix();
      setOrthoFrustum(this.ortho, aspect, (this.ortho.top - this.ortho.bottom) / 2);
    } else {
      this.home();
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
