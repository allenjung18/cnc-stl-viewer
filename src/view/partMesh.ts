import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshStandardMaterial } from 'three';
import type { BBox, Vec3 } from '../state/model';

/** The loaded part as drawn on the bed. */
export interface PartMesh {
  readonly object: Mesh;
  /** Bounding box of the positions as read from the file, file units. */
  readonly fileBBox: BBox;
  /** Extent of the part along each axis, file units. */
  readonly size: Vec3;
  dispose(): void;
}

/**
 * A mesh over the parsed triangle soup, placed so the part's bounding-box min
 * corner sits at the origin (the bed's front-left corner, Z = 0 on the bed).
 *
 * The part is never centred: centring would put half of it below the bed. The
 * positions array is used as is (no copy) and stays in file space; placement
 * is the mesh's own translation, so the file-space box stays available.
 */
export function buildPartMesh(positions: Float32Array): PartMesh {
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
  mesh.position.set(-box.min.x, -box.min.y, -box.min.z);
  mesh.updateMatrixWorld(true);

  const fileBBox: BBox = { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
  return {
    object: mesh,
    fileBBox,
    size: [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z],
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
