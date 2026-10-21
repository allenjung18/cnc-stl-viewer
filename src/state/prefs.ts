/**
 * Viewer preferences kept in the browser (`localStorage`). Every read and write
 * is guarded: storage can be missing, blocked or full, and the viewer then
 * runs on its defaults. Never the mesh.
 */
import { DEFAULT_TOOL_DIAMETER_MM, parseToolDiameter } from '../geom/features';
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

export const TOOL_KEY = 'cnc-stl-viewer.tool-diameter';

/** The stored end-mill diameter for the minimum-feature hint, mm; the 1/8 in default when nothing valid is stored. */
export function loadToolDiameter(storage: PrefStorage | null): number {
  try {
    return parseToolDiameter(storage?.getItem(TOOL_KEY) ?? null) ?? DEFAULT_TOOL_DIAMETER_MM;
  } catch {
    return DEFAULT_TOOL_DIAMETER_MM;
  }
}

/** Stores the end-mill diameter; returns false when it is invalid or could not be stored. */
export function saveToolDiameter(storage: PrefStorage | null, mm: number): boolean {
  if (!storage || parseToolDiameter(mm) === null) return false;
  try {
    storage.setItem(TOOL_KEY, String(mm));
    return true;
  } catch {
    return false;
  }
}
