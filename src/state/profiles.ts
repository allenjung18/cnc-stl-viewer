import { DEFAULT_ALLOWANCE } from '../geom/fit';
import type { MachineProfile, Setup, Stock, Vec3 } from './model';
import type { PrefStorage } from './prefs';

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

/**
 * The saved setup: the machine (with its keep-out box), the stock inputs and
 * the WCS origin. Kept in `localStorage` so it survives a reload, and exported
 * or imported as JSON so it survives a browser reset and moves to another PC.
 * Never the mesh.
 */
export interface SavedProfile {
  readonly machine: MachineProfile;
  readonly stock: Stock;
  readonly setup: Setup;
}

export const PROFILE_KEY = 'cnc-stl-viewer.profile';
/** Marks a file as one of this viewer's profiles. */
export const PROFILE_FORMAT = 'cnc-stl-viewer/profile';
export const PROFILE_VERSION = 1;

/** The fixed block's size before the user enters one, mm. */
export const DEFAULT_BLOCK_SIZE: Vec3 = Object.freeze([25, 25, 25] as const);

export const DEFAULT_SAVED_PROFILE: SavedProfile = Object.freeze({
  machine: DEFAULT_PROFILE,
  stock: Object.freeze({ mode: 'auto', allowance: DEFAULT_ALLOWANCE, size: DEFAULT_BLOCK_SIZE }),
  setup: Object.freeze({ origin: 'bottom-left-front-top', stockOnBed: Object.freeze([0, 0, 0] as const) }),
} as const);

/** The longest machine name or bed note a profile may carry. */
const MAX_TEXT = 500;

/** The profile as the JSON file holds it. */
export function profileToJson(p: SavedProfile): string {
  const { name, units, travel, cuttingArea, keepOut, bedOriginNote } = p.machine;
  return `${JSON.stringify(
    {
      format: PROFILE_FORMAT,
      version: PROFILE_VERSION,
      machine: { name, units, travel, cuttingArea, keepOut: keepOut ?? [], bedOriginNote },
      stock: { mode: p.stock.mode, allowance: p.stock.allowance, size: p.stock.size },
      setup: { origin: p.setup.origin, stockOnBed: p.setup.stockOnBed },
    },
    null,
    2,
  )}\n`;
}

/** A file name for the exported profile: the machine name, kebab-case. */
export function profileFileName(p: SavedProfile): string {
  const slug = p.machine.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'machine'}.profile.json`;
}

export type ProfileParse = { readonly ok: true; readonly profile: SavedProfile } | { readonly ok: false; readonly error: string };

class ProfileError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function field(o: Record<string, unknown>, key: string, path: string): unknown {
  if (!(key in o)) throw new ProfileError(`${path}${key} is missing`);
  return o[key];
}

function objectAt(o: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
  const v = field(o, key, path);
  if (!isObject(v)) throw new ProfileError(`${path}${key} must be an object`);
  return v;
}

function textAt(o: Record<string, unknown>, key: string, path: string, allowEmpty: boolean): string {
  const v = field(o, key, path);
  if (typeof v !== 'string' || (!allowEmpty && v.trim() === '') || v.length > MAX_TEXT) {
    throw new ProfileError(`${path}${key} must be ${allowEmpty ? 'text' : 'a name'} of at most ${MAX_TEXT} characters`);
  }
  return v;
}

type Rule = 'any' | 'non-negative' | 'positive';

function numberOk(n: unknown, rule: Rule): n is number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return false;
  return rule === 'any' || (rule === 'non-negative' ? n >= 0 : n > 0);
}

const RULE_TEXT: Record<Rule, string> = { any: 'finite numbers', 'non-negative': 'numbers 0 or more', positive: 'numbers above 0' };

function vecAt(o: Record<string, unknown>, key: string, path: string, rule: Rule): Vec3 {
  const v = field(o, key, path);
  if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => numberOk(n, rule))) {
    throw new ProfileError(`${path}${key} must be three ${RULE_TEXT[rule]} [x, y, z]`);
  }
  return [(v[0] as number) + 0, (v[1] as number) + 0, (v[2] as number) + 0];
}

function numberAt(o: Record<string, unknown>, key: string, path: string, rule: Rule): number {
  const v = field(o, key, path);
  if (!numberOk(v, rule)) throw new ProfileError(`${path}${key} must be a number${rule === 'any' ? '' : rule === 'positive' ? ' above 0' : ' 0 or more'}`);
  return v + 0;
}

function parseMachine(o: Record<string, unknown>): MachineProfile {
  const path = 'machine.';
  const name = textAt(o, 'name', path, false);
  if (field(o, 'units', path) !== 'mm') throw new ProfileError('machine.units must be "mm"');
  const travel = vecAt(o, 'travel', path, 'positive');
  const cuttingArea = vecAt(o, 'cuttingArea', path, 'positive');
  cuttingArea.forEach((c, i) => {
    if (c > travel[i]!) throw new ProfileError(`machine.cuttingArea ${'XYZ'[i]} (${c}) is larger than the travel (${travel[i]})`);
  });
  const rawKeepOut = 'keepOut' in o ? o.keepOut : [];
  if (!Array.isArray(rawKeepOut)) throw new ProfileError('machine.keepOut must be a list of boxes');
  // The panel edits one keep-out box standing on the bed.
  if (rawKeepOut.length > 1) throw new ProfileError('machine.keepOut holds more than one box; the viewer edits one');
  const keepOut = rawKeepOut.map((b, i) => {
    const bp = `machine.keepOut[${i}].`;
    if (!isObject(b)) throw new ProfileError(`machine.keepOut[${i}] must be a box { min, max }`);
    const min = vecAt(b, 'min', bp, 'any');
    const max = vecAt(b, 'max', bp, 'any');
    if (min[2] !== 0) throw new ProfileError(`${bp}min Z must be 0 (the box stands on the bed)`);
    if (!max.every((v, k) => v > min[k]! && Number.isFinite(v - min[k]!))) {
      throw new ProfileError(`${bp}max must be above min on every axis`);
    }
    return { min, max };
  });
  const bedOriginNote = 'bedOriginNote' in o ? textAt(o, 'bedOriginNote', path, true) : DEFAULT_PROFILE.bedOriginNote;
  return { name, units: 'mm', travel, cuttingArea, keepOut, bedOriginNote };
}

function parseStock(o: Record<string, unknown>): Stock {
  const path = 'stock.';
  const mode = field(o, 'mode', path);
  if (mode !== 'auto' && mode !== 'fixed') throw new ProfileError('stock.mode must be "auto" or "fixed"');
  const a = objectAt(o, 'allowance', path);
  const allowance = {
    xy: numberAt(a, 'xy', 'stock.allowance.', 'non-negative'),
    top: numberAt(a, 'top', 'stock.allowance.', 'non-negative'),
    bottom: numberAt(a, 'bottom', 'stock.allowance.', 'non-negative'),
  };
  return { mode, allowance, size: vecAt(o, 'size', path, 'positive') };
}

function parseSetup(o: Record<string, unknown>): Setup {
  const origin = field(o, 'origin', 'setup.');
  if (origin !== 'bottom-left-front-top' && origin !== 'center-top') {
    throw new ProfileError('setup.origin must be "bottom-left-front-top" or "center-top"');
  }
  const stockOnBed = vecAt(o, 'stockOnBed', 'setup.', 'any');
  if (stockOnBed[2] !== 0) throw new ProfileError('setup.stockOnBed Z must be 0 (the stock sits on the bed)');
  return { origin, stockOnBed };
}

/** Reads a profile file or stored value; every problem is named, nothing is guessed. */
export function parseProfile(text: unknown): ProfileParse {
  if (typeof text !== 'string') return { ok: false, error: 'nothing stored' };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not JSON' };
  }
  try {
    if (!isObject(doc) || doc.format !== PROFILE_FORMAT) throw new ProfileError(`not a ${PROFILE_FORMAT} file`);
    if (doc.version !== PROFILE_VERSION) throw new ProfileError(`version ${String(doc.version)} is not supported (this viewer reads ${PROFILE_VERSION})`);
    const profile: SavedProfile = {
      machine: parseMachine(objectAt(doc, 'machine', '')),
      stock: parseStock(objectAt(doc, 'stock', '')),
      setup: parseSetup(objectAt(doc, 'setup', '')),
    };
    return { ok: true, profile };
  } catch (e) {
    if (e instanceof ProfileError) return { ok: false, error: e.message };
    throw e;
  }
}

/** The stored profile; the defaults when nothing valid is stored or storage is unreadable. */
export function loadProfile(storage: PrefStorage | null): SavedProfile {
  try {
    const parsed = parseProfile(storage?.getItem(PROFILE_KEY));
    return parsed.ok ? parsed.profile : DEFAULT_SAVED_PROFILE;
  } catch {
    return DEFAULT_SAVED_PROFILE;
  }
}

/** Stores the profile; returns false when it could not be stored. */
export function saveProfile(storage: PrefStorage | null, p: SavedProfile): boolean {
  if (!storage) return false;
  try {
    storage.setItem(PROFILE_KEY, profileToJson(p));
    return true;
  } catch {
    return false;
  }
}

/** Same travel and cutting area: the drawn machine does not change. */
export function sameMachineSize(a: MachineProfile, b: MachineProfile): boolean {
  return [0, 1, 2].every((i) => a.travel[i] === b.travel[i] && a.cuttingArea[i] === b.cuttingArea[i]);
}
