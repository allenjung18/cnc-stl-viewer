import {
  AxesHelper,
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Scene,
} from 'three';
import type { BBox, MachineProfile, Vec3 } from '../state/model';

/** Grid pitch on the bed, mm. */
export const GRID_MINOR_MM = 10;
/** Every this many mm a grid line is drawn as a major line. */
export const GRID_MAJOR_MM = 50;
/** Length of each RGB axis arrow at the origin, mm. */
export const AXES_LENGTH_MM = 40;

const COLORS = {
  background: 0x1e2227,
  bed: 0x3a3f46,
  gridMinor: 0x4f565f,
  gridMajor: 0x7a838e,
  travel: 0x8aa0b8,
  cutting: 0xffc24b,
} as const;

/**
 * The machine frame is Z-up, right-handed, in mm. three.js defaults to Y-up, so
 * this must run before any camera or controls are created. Geometry is never
 * rotated to compensate: every number in the scene is a machine-axis number.
 */
export function applyZUp(): void {
  Object3D.DEFAULT_UP.set(0, 0, 1);
}

export interface EnvelopeBounds {
  /** The box parts and stock are checked against: front-left corner at the origin, bed at Z = 0. */
  readonly cutting: BBox;
  /** Full axis travel, centred on the cutting area in X and Y, from the bed up. */
  readonly travel: BBox;
}

export function envelopeBounds(profile: MachineProfile): EnvelopeBounds {
  const [cx, cy, cz] = profile.cuttingArea;
  const [tx, ty, tz] = profile.travel;
  const ox = (cx - tx) / 2;
  const oy = (cy - ty) / 2;
  return {
    cutting: { min: [0, 0, 0], max: [cx, cy, cz] },
    travel: { min: [ox, oy, 0], max: [ox + tx, oy + ty, tz] },
  };
}

export interface MachineScene {
  readonly scene: Scene;
  readonly bed: Mesh;
  readonly grid: Group;
  readonly axes: AxesHelper;
  readonly travelBox: LineSegments;
  readonly cuttingBox: LineSegments;
  readonly bounds: EnvelopeBounds;
}

/** Builds the static machine scene: bed plate, grid, axes, travel and cutting-area boxes, lights. */
export function buildScene(profile: MachineProfile): MachineScene {
  applyZUp();
  const bounds = envelopeBounds(profile);
  const [bx, by] = profile.cuttingArea;

  const scene = new Scene();
  scene.background = new Color(COLORS.background);

  const bed = buildBedPlate(bx, by);
  const grid = buildBedGrid(bx, by, GRID_MINOR_MM, GRID_MAJOR_MM);
  const axes = new AxesHelper(AXES_LENGTH_MM); // X red, Y green, Z blue
  axes.name = 'axes';
  // The axes share the origin with the grid and the cutting-area box edges; draw them last
  // and on top so the origin triad is never hidden by a coincident line.
  axes.renderOrder = 10;
  (axes.material as LineBasicMaterial).depthTest = false;
  const travelBox = buildBoxOutline('envelope:travel', bounds.travel, COLORS.travel, 0.35);
  const cuttingBox = buildBoxOutline('envelope:cutting', bounds.cutting, COLORS.cutting, 1);

  const sky = new HemisphereLight(0xffffff, 0x404040, 1.2);
  sky.position.set(0, 0, 1);
  const sun = new DirectionalLight(0xffffff, 1.5);
  sun.position.set(bx + 150, -200, 300);
  sun.target.position.set(bx / 2, by / 2, 0);

  scene.add(bed, grid, axes, travelBox, cuttingBox, sky, sun, sun.target);
  return { scene, bed, grid, axes, travelBox, cuttingBox, bounds };
}

/** The bed surface: a plate the size of the cutting area, top face at Z = 0, facing +Z. */
function buildBedPlate(sizeX: number, sizeY: number): Mesh {
  const geometry = new PlaneGeometry(sizeX, sizeY); // lies in XY, normal +Z
  const material = new MeshStandardMaterial({
    color: COLORS.bed,
    roughness: 0.9,
    metalness: 0,
    // Push the plate back in depth so grid lines at Z = 0 never z-fight with it.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const bed = new Mesh(geometry, material);
  bed.name = 'bed';
  bed.position.set(sizeX / 2, sizeY / 2, 0);
  return bed;
}

/**
 * Grid lines on the bed in the XY plane at Z = 0, anchored at the origin: a line
 * every `minor` mm, heavier every `major` mm, plus the bed's far edges.
 */
export function buildBedGrid(sizeX: number, sizeY: number, minor: number, major: number): Group {
  const minorPts: number[] = [];
  const majorPts: number[] = [];
  const pushLine = (pts: number[], x1: number, y1: number, x2: number, y2: number) => {
    pts.push(x1, y1, 0, x2, y2, 0);
  };
  for (const x of gridStops(sizeX, minor)) {
    pushLine(isMajor(x, sizeX, major) ? majorPts : minorPts, x, 0, x, sizeY);
  }
  for (const y of gridStops(sizeY, minor)) {
    pushLine(isMajor(y, sizeY, major) ? majorPts : minorPts, 0, y, sizeX, y);
  }

  const grid = new Group();
  grid.name = 'grid';
  grid.add(
    lines('grid:minor', minorPts, COLORS.gridMinor),
    lines('grid:major', majorPts, COLORS.gridMajor),
  );
  return grid;
}

/** 0, step, 2·step, … up to size, and size itself when it is not on the pitch. */
function gridStops(size: number, step: number): number[] {
  const stops: number[] = [];
  for (let i = 0; i * step <= size + 1e-9; i++) stops.push(i * step);
  if (size - (stops[stops.length - 1] ?? 0) > 1e-9) stops.push(size);
  return stops;
}

function isMajor(v: number, size: number, major: number): boolean {
  return v === 0 || v === size || Math.abs(v / major - Math.round(v / major)) < 1e-9;
}

function lines(name: string, pts: number[], color: number): LineSegments {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(pts, 3));
  const seg = new LineSegments(geometry, new LineBasicMaterial({ color }));
  seg.name = name;
  return seg;
}

function buildBoxOutline(name: string, box: BBox, color: number, opacity: number): LineSegments {
  const size = sub(box.max, box.min);
  const geometry = new EdgesGeometry(new BoxGeometry(size[0], size[1], size[2]));
  const material = new LineBasicMaterial({ color, transparent: opacity < 1, opacity });
  const outline = new LineSegments(geometry, material);
  outline.name = name;
  outline.position.set(
    box.min[0] + size[0] / 2,
    box.min[1] + size[1] / 2,
    box.min[2] + size[2] / 2,
  );
  return outline;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
