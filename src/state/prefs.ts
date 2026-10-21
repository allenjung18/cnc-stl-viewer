/**
 * Viewer preferences kept in the browser (`localStorage`). Every read and write
 * is guarded: storage can be missing, blocked or full, and the viewer then
 * runs on its defaults. Never the mesh.
 */
import { parseUnitChoice, type UnitChoice } from '../geom/units';

/** The subset of `Storage` the preferences use. */
export type PrefStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const UNITS_KEY = 'cnc-stl-viewer.units';

/** The browser's storage, or `null` when the page may not touch it. */
export function browserStorage(): PrefStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The stored units choice; mm when nothing valid is stored or storage is unreadable. */
export function loadUnits(storage: PrefStorage | null): UnitChoice {
  try {
    return parseUnitChoice(storage?.getItem(UNITS_KEY)) ?? 'mm';
  } catch {
    return 'mm';
  }
}

/** Stores the units choice; returns false when it could not be stored. */
export function saveUnits(storage: PrefStorage | null, choice: UnitChoice): boolean {
  if (!storage) return false;
  try {
    storage.setItem(UNITS_KEY, choice);
    return true;
  } catch {
    return false;
  }
}
