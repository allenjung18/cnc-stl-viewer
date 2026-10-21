import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
} from 'three';
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
  /** File units -> mm, as drawn (1 until set). */
  readonly unitScale: number;
  /**
   * Draws the part at `scale` mm per file unit (25.4 for an inch file), still
   * with its min corner at the origin. The positions are not touched: the
   * mesh's own scale does it, and the edge overlays scale with it.
   */
  setUnitScale(scale: number): void;
  dispose(): void;
}

/** Problem edges to draw, as segment endpoints in the same file space as the positions (6 numbers per edge). */
export interface ProblemEdges {
  readonly openEdgeSegments: Float32Array;
  readonly nonManifoldEdgeSegments: Float32Array;
}

/** Open edges (a hole's rim) are drawn in this colour. */
export const OPEN_EDGE_COLOR = 0xff3b30;
/** Non-manifold edges (shared by more than two triangles) are drawn in this colour. */
export const NON_MANIFOLD_EDGE_COLOR = 0xff3df5;

function edgeOverlay(segments: Float32Array, color: number, name: string): LineSegments | null {
  if (segments.length === 0) return null;
  if (segments.length % 6 !== 0) {
    throw new RangeError(`${name} must hold whole segments (6 numbers each), got ${segments.length}`);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(segments, 3));
  // Drawn through the part, so an edge on the far side or inside still shows.
  const material = new LineBasicMaterial({ color, depthTest: false, transparent: true });
  const lines = new LineSegments(geometry, material);
  lines.name = name;
  lines.renderOrder = 1;
  return lines;
}

/**
 * A mesh over the parsed triangle soup, drawn at the unit scale (1 until
 * `setUnitScale`) and placed so the part's bounding-box min
 * corner sits at the origin (the bed's front-left corner, Z = 0 on the bed).
 *
 * The part is never centred: centring would put half of it below the bed. The
 * positions array is used as is (no copy) and stays in file space; placement
 * is the mesh's own translation, so the file-space box stays available.
 *
 * `problems`, when given, are drawn as coloured lines that are children of the
 * mesh, so they move with it: open edges red, non-manifold edges magenta (the cutting-area box is already orange).
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
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'part';
  let unitScale = 1;
  const place = (): void => {
    mesh.scale.setScalar(unitScale);
    mesh.position.set(-box.min.x * unitScale, -box.min.y * unitScale, -box.min.z * unitScale);
  };
  place();

  let openEdges: LineSegments | null = null;
  let nonManifoldEdges: LineSegments | null = null;
  try {
    openEdges = edgeOverlay(problems?.openEdgeSegments ?? new Float32Array(0), OPEN_EDGE_COLOR, 'open-edges');
    nonManifoldEdges = edgeOverlay(
      problems?.nonManifoldEdgeSegments ?? new Float32Array(0),
      NON_MANIFOLD_EDGE_COLOR,
      'non-manifold-edges',
    );
  } catch (e) {
    for (const o of [openEdges, nonManifoldEdges]) disposeLines(o);
    geometry.dispose();
    material.dispose();
    throw e;
  }
  for (const o of [openEdges, nonManifoldEdges]) if (o) mesh.add(o);
  mesh.updateMatrixWorld(true);

  const fileBBox: BBox = { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
  return {
    object: mesh,
    fileBBox,
    size: [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z],
    openEdges,
    nonManifoldEdges,
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
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
      disposeLines(openEdges);
      disposeLines(nonManifoldEdges);
    },
  };
}

function disposeLines(lines: LineSegments | null): void {
  if (!lines) return;
  lines.geometry.dispose();
  (lines.material as LineBasicMaterial).dispose();
}
