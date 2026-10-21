import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE, NOMAD_883_PRO_CUTTING_AREA, NOMAD_883_PRO_TRAVEL } from './profiles';

describe('default Nomad 883 Pro profile', () => {
  it('has the measured travel of 250 x 250 x 100 mm', () => {
    expect(DEFAULT_PROFILE.travel).toEqual([250, 250, 100]);
    expect(NOMAD_883_PRO_TRAVEL).toEqual([250, 250, 100]);
  });

  it('has the published cutting area of 203 x 203 x 76 mm', () => {
    expect(DEFAULT_PROFILE.cuttingArea).toEqual([203, 203, 76]);
    expect(NOMAD_883_PRO_CUTTING_AREA).toEqual([203, 203, 76]);
  });

  it('keeps the cutting area at or under travel on every axis', () => {
    for (const axis of [0, 1, 2] as const) {
      expect(DEFAULT_PROFILE.cuttingArea[axis]).toBeGreaterThan(0);
      expect(DEFAULT_PROFILE.cuttingArea[axis]).toBeLessThanOrEqual(DEFAULT_PROFILE.travel[axis]);
    }
  });

  it('is in millimetres and names the machine', () => {
    expect(DEFAULT_PROFILE.units).toBe('mm');
    expect(DEFAULT_PROFILE.name).toBe('Nomad 883 Pro');
  });

  it('cannot be mutated by a caller', () => {
    expect(Object.isFrozen(DEFAULT_PROFILE)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PROFILE.travel)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PROFILE.cuttingArea)).toBe(true);
  });
});
