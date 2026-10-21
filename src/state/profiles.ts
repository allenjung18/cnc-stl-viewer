import type { MachineProfile, Vec3 } from './model';

/** Carbide 3D Nomad 883 Pro axis travel, measured from the controller's max-travel settings. */
export const NOMAD_883_PRO_TRAVEL: Vec3 = Object.freeze([250, 250, 100] as const);

/**
 * Carbide 3D Nomad 883 Pro cutting area (8 x 8 x 3 in, rounded down to whole mm).
 * Parts and stock are checked against this box, never against travel.
 */
export const NOMAD_883_PRO_CUTTING_AREA: Vec3 = Object.freeze([203, 203, 76] as const);

export const DEFAULT_PROFILE: MachineProfile = Object.freeze({
  name: 'Nomad 883 Pro',
  units: 'mm',
  travel: NOMAD_883_PRO_TRAVEL,
  cuttingArea: NOMAD_883_PRO_CUTTING_AREA,
  bedOriginNote:
    'Origin at the front-left corner of the cutting area, Z = 0 on the bed surface; X right, Y to the back, Z up.',
});
