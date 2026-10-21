/** A point or size in machine axes, millimetres: [x, y, z]. */
export type Vec3 = readonly [number, number, number];

/** An axis-aligned box in machine axes, millimetres. */
export interface BBox {
  readonly min: Vec3;
  readonly max: Vec3;
}

/**
 * What the viewer knows about the machine.
 *
 * `travel` is the full axis travel the controller allows; `cuttingArea` is the
 * smaller box a tool can actually reach on the bed, and is what parts and stock
 * are checked against. Both are drawn, with the bed's front-left corner at the
 * origin and Z = 0 at the bed surface.
 */
export interface MachineProfile {
  readonly name: string;
  readonly units: 'mm';
  readonly travel: Vec3;
  readonly cuttingArea: Vec3;
  readonly keepOut?: readonly BBox[];
  readonly bedOriginNote: string;
}

/**
 * What the inspector reports about a mesh. Lengths are in file units, which
 * are millimetres until a unit scale is applied; the axes are the file's.
 */
export interface MeshStats {
  readonly triangles: number;
  /** Distinct vertices after welding points closer than `weldEpsilon`. */
  readonly vertices: number;
  readonly bbox: BBox;
  readonly size: Vec3;
  /**
   * Signed volume (divergence theorem). Exact for a closed, consistently wound
   * mesh; negative when the normals face inward; only an estimate when the mesh
   * is open.
   */
  readonly volumeMm3: number;
  readonly areaMm2: number;
  /** No open and no non-manifold edges. */
  readonly watertight: boolean;
  /** Edges used by exactly one triangle. */
  readonly openEdges: number;
  /** Edges used by more than two triangles. */
  readonly nonManifoldEdges: number;
  /** Triangles that collapse when welded, or whose area is below weldEpsilon². */
  readonly degenerateTris: number;
  /** Watertight and the volume is negative: the triangles are wound inward. Never set on an open mesh. */
  readonly flippedHint: boolean;
  /** The welding tolerance used, file units. */
  readonly weldEpsilon: number;
}

/** The stats plus the problem edges to draw, as segment endpoints in file space (6 numbers per edge). */
export interface MeshInspection {
  readonly stats: MeshStats;
  readonly openEdgeSegments: Float32Array;
  readonly nonManifoldEdgeSegments: Float32Array;
  /** The part's outline (faces meeting at more than 20°), same layout; null when skipped on a large mesh. */
  readonly featureEdgeSegments: Float32Array | null;
}

/** Material left around the part on each side, mm: X and Y each side, above and below. */
export interface Allowance {
  readonly xy: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * The block the part is cut from. `auto` sizes it from the part plus the
 * allowance on every side; `fixed` is the block the user actually has, and the
 * part must fit in it with the allowance as margins.
 */
export interface Stock {
  readonly mode: 'auto' | 'fixed';
  readonly allowance: Allowance;
  /** The fixed block's size, mm (used in `fixed` mode only). */
  readonly size: Vec3;
}

/** Where the work zero (the WCS origin CAM uses) sits on the stock; Z0 is always the stock top. */
export type WcsOrigin = 'bottom-left-front-top' | 'center-top';

export interface Setup {
  readonly origin: WcsOrigin;
  /** Where the stock's front-left-bottom corner sits on the bed, mm (bed frame; Z is 0: the stock sits on the bed). */
  readonly stockOnBed: Vec3;
}
