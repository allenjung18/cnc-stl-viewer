import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Raycaster,
} from 'three';
import { sizeOf } from '../geom/bbox';
import { apply, IDENTITY, isRotation, orientedBBox, triangleNormal, type Mat3 } from '../geom/orient';
import type { BBox, Vec3 } from '../state/model';

/** The loaded part as drawn on the bed. */
export interface PartMesh {
  readonly object: Mesh;
  /** Bounding box of the positions as read from the file, file units. */
  readonly fileBBox: BBox;
  /** Extent of the part along each axis, file units. */
  readonly size: Vec3;
  /** Open edges drawn over the part, or null when there are none. */
  readonly openEdges: LineSegments | null;
  /** Non-manifold edges drawn over the part, or null when there are none. */
  readonly nonManifoldEdges: LineSegments | null;
  /** The outline (feature edges), or null when there are none or they were skipped on a large mesh. */
  readonly featureEdges: LineSegments | null;
  /** Shows or hides the outline; a no-op without one. */
  setFeatureEdgesVisible(on: boolean): void;
  /** File units -> mm, as drawn (1 until set). */
  readonly unitScale: number;
  /**
   * Draws the part at `scale` mm per file unit (25.4 for an inch file), still
   * with its min corner at the placement point. The positions are not touched:
   * the mesh's own scale does it, and the edge overlays scale with it.
   */
  setUnitScale(scale: number): void;
  /** Where the part's bbox min corner sits on the bed, mm (the origin until set). */
  readonly placement: Vec3;
  /** Moves the part so its bbox min corner sits at `at` (bed frame, mm), at the current unit scale. */
  setPlacement(at: Vec3): void;
  /** The triangle soup as read, file units (never rotated or scaled in place). */
  readonly positions: Float32Array;
  /** File axes -> machine axes (the identity until set). */
  readonly rotation: Mat3;
  /** The box around the part once rotated, file units (min and max; translate and scale it to place it). */
  readonly orientedBBox: BBox;
  /** Extent of the rotated part along each machine axis, file units. */
  readonly orientedSize: Vec3;
  /**
   * Turns the part to `rotation` (world = R · file), keeping its bbox min corner
   * at the placement point. Throws RangeError on a matrix that is not a proper
   * rotation (a mirror, a scale, a non-finite entry).
   */
  setRotation(rotation: Mat3): void;
  /**
   * The triangle under the ray, nearest first, with its normal in file axes
   * turned to face the viewer (so a face seen from outside gives its outward
   * normal even when the mesh is wound inward); null on a miss or a
   * degenerate triangle. The edge overlays are not hit.
   */
  pickFace(raycaster: Raycaster): FacePick | null;
  dispose(): void;
}

/** A picked face of the part. */
export interface FacePick {
  readonly triangle: number;
  /** Unit normal in file axes, facing the viewer. */
  readonly normal: Vec3;
  /** Where the ray hit, machine axes, mm. */
  readonly point: Vec3;
}

/** Problem edges to draw, as segment endpoints in the same file space as the positions (6 numbers per edge). */
export interface ProblemEdges {
  readonly openEdgeSegments: Float32Array;
  readonly nonManifoldEdgeSegments: Float32Array;
  /** The outline to draw, same layout; null or absent for none. */
  readonly featureEdgeSegments?: Float32Array | null;
}

/** The outline is drawn in this colour, under the problem edges. */
export const FEATURE_EDGE_COLOR = 0x1d2b3a;

/** Open edges (a hole's rim) are drawn in this colour. */
export const OPEN_EDGE_COLOR = 0xff3b30;
/** Non-manifold edges (shared by more than two triangles) are drawn in this colour. */
export const NON_MANIFOLD_EDGE_COLOR = 0xff3df5;

function edgeOverlay(segments: Float32Array, color: number, name: string, throughPart = true): LineSegments | null {
  if (segments.length === 0) return null;
  if (segments.length % 6 !== 0) {
    throw new RangeError(`${name} must hold whole segments (6 numbers each), got ${segments.length}`);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(segments, 3));
  // Problem edges are drawn through the part, so an edge on the far side or inside still shows;
  // the outline is depth-tested, so only the edges in view draw.
  const material = throughPart
    ? new LineBasicMaterial({ color, depthTest: false, transparent: true })
    : new LineBasicMaterial({ color });
  const lines = new LineSegments(geometry, material);
  lines.name = name;
  lines.renderOrder = throughPart ? 1 : 0;
  return lines;
}

/**
 * A mesh over the parsed triangle soup, drawn at the unit scale (1 until
 * `setUnitScale`) and placed so the part's bounding-box min corner sits at the
 * placement point: the origin (the bed's front-left corner, Z = 0 on the bed)
 * until `setPlacement` puts it inside the stock.
 *
 * The part is never centred: centring would put half of it below the bed. The
 * positions array is used as is (no copy) and stays in file space; placement
 * is the mesh's own translation, so the file-space box stays available.
 *
 * Orientation (`setRotation`) is the mesh's own rotation too: the box of the
 * rotated vertices is recomputed from the positions (exactly, from the file
 * box's corners, for a quarter-turn orientation) and its min corner is what
 * sits on the placement point.
 *
 * `problems`, when given, are drawn as coloured lines that are children of the
 * mesh, so they move with it: open edges red, non-manifold edges magenta (the cutting-area box is already orange),
 * and the outline (feature edges) dark, depth-tested.
 */
export function buildPartMesh(positions: Float32Array, problems?: ProblemEdges): PartMesh {
  if (positions.length === 0 || positions.length % 9 !== 0) {
    throw new RangeError(`positions must hold whole triangles (9 numbers each), got ${positions.length}`);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box || ![box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z].every(Number.isFinite)) {
    geometry.dispose();
    throw new RangeError('positions hold a coordinate that is not a finite number');
  }
  geometry.computeVertexNormals(); // non-indexed: one flat normal per triangle, from its winding

  const material = new MeshStandardMaterial({
    color: 0x6fa8dc,
    roughness: 0.55,
    metalness: 0.05,
    // Open or inward-wound meshes still draw; the inspector reports them.
    side: DoubleSide,
    // Pushed back a little, so the outline drawn on its edges wins the depth test.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'part';
  const fileBBox: BBox = { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
  let unitScale = 1;
  let placement: Vec3 = [0, 0, 0];
  let rotation: Mat3 = IDENTITY;
  let oriented: BBox = fileBBox;
  const m4 = new Matrix4();
  // world = placement + scale · (R · p − orientedMin): the rotated box's min corner lands on the placement point.
  const place = (): void => {
    m4.set(rotation[0], rotation[1], rotation[2], 0, rotation[3], rotation[4], rotation[5], 0, rotation[6], rotation[7], rotation[8], 0, 0, 0, 0, 1);
    mesh.quaternion.setFromRotationMatrix(m4);
    mesh.scale.setScalar(unitScale);
    mesh.position.set(
      placement[0] - oriented.min[0] * unitScale,
      placement[1] - oriented.min[1] * unitScale,
      placement[2] - oriented.min[2] * unitScale,
    );
  };
  place();

  let openEdges: LineSegments | null = null;
  let nonManifoldEdges: LineSegments | null = null;
  let featureEdges: LineSegments | null = null;
  try {
    featureEdges = edgeOverlay(problems?.featureEdgeSegments ?? new Float32Array(0), FEATURE_EDGE_COLOR, 'feature-edges', false);
    openEdges = edgeOverlay(problems?.openEdgeSegments ?? new Float32Array(0), OPEN_EDGE_COLOR, 'open-edges');
    nonManifoldEdges = edgeOverlay(
      problems?.nonManifoldEdgeSegments ?? new Float32Array(0),
      NON_MANIFOLD_EDGE_COLOR,
      'non-manifold-edges',
    );
  } catch (e) {
    for (const o of [openEdges, nonManifoldEdges, featureEdges]) disposeLines(o);
    geometry.dispose();
    material.dispose();
    throw e;
  }
  for (const o of [featureEdges, openEdges, nonManifoldEdges]) if (o) mesh.add(o);
  mesh.updateMatrixWorld(true);

  return {
    object: mesh,
    fileBBox,
    size: [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z],
    openEdges,
    nonManifoldEdges,
    featureEdges,
    setFeatureEdgesVisible(on: boolean) {
      if (featureEdges) featureEdges.visible = on;
    },
    get unitScale() {
      return unitScale;
    },
    setUnitScale(scale: number) {
      if (!(Number.isFinite(scale) && scale > 0)) {
        throw new RangeError(`unit scale must be a finite number above 0, got ${scale}`);
      }
      unitScale = scale;
      place();
      mesh.updateMatrixWorld(true);
    },
    get placement() {
      return placement;
    },
    setPlacement(at: Vec3) {
      if (!at.every(Number.isFinite)) throw new RangeError(`placement must be finite numbers, got ${at.join(', ')}`);
      placement = [at[0], at[1], at[2]];
      place();
      mesh.updateMatrixWorld(true);
    },
    positions,
    get rotation() {
      return rotation;
    },
    get orientedBBox() {
      return oriented;
    },
    get orientedSize() {
      return sizeOf(oriented);
    },
    setRotation(r: Mat3) {
      if (!isRotation(r)) throw new RangeError(`rotation must be a proper rotation matrix, got ${r.join(', ')}`);
      rotation = [...r] as unknown as Mat3;
      oriented = orientedBBox(positions, rotation, fileBBox);
      place();
      mesh.updateMatrixWorld(true);
    },
    pickFace(raycaster: Raycaster) {
      mesh.updateMatrixWorld(true);
      for (const hit of raycaster.intersectObject(mesh, false)) {
        if (hit.faceIndex == null) continue;
        const n = triangleNormal(positions, hit.faceIndex);
        if (!n) return null;
        const w = apply(rotation, n);
        const d = raycaster.ray.direction;
        const facing = w[0] * d.x + w[1] * d.y + w[2] * d.z > 0 ? ([-n[0] + 0, -n[1] + 0, -n[2] + 0] as Vec3) : n;
        return { triangle: hit.faceIndex, normal: facing, point: [hit.point.x, hit.point.y, hit.point.z] };
      }
      return null;
    },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
      disposeLines(openEdges);
      disposeLines(nonManifoldEdges);
      disposeLines(featureEdges);
    },
  };
}

function disposeLines(lines: LineSegments | null): void {
  if (!lines) return;
  lines.geometry.dispose();
  (lines.material as LineBasicMaterial).dispose();
}
