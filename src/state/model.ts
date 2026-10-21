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
