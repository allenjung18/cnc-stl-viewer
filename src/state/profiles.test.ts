import { describe, expect, it } from 'vitest';
import type { PrefStorage } from './prefs';
import {
  DEFAULT_PROFILE,
  DEFAULT_SAVED_PROFILE,
  loadProfile,
  NOMAD_883_PRO_CUTTING_AREA,
  NOMAD_883_PRO_TRAVEL,
  parseProfile,
  PROFILE_FORMAT,
  PROFILE_KEY,
  profileFileName,
  profileToJson,
  saveProfile,
  sameMachineSize,
  type SavedProfile,
} from './profiles';

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

function memory(initial: Record<string, string> = {}): PrefStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const throwing: PrefStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

const custom: SavedProfile = {
  machine: {
    name: 'Shop Nomad',
    units: 'mm',
    travel: [250, 250, 100],
    cuttingArea: [200, 190, 70],
    keepOut: [{ min: [180, 0, 0], max: [203, 25, 12.5] }],
    bedOriginNote: 'front-left',
  },
  stock: { mode: 'fixed', allowance: { xy: 4, top: 0.5, bottom: 0 }, size: [101.6, 50.8, 19.05] },
  setup: { origin: 'center-top', stockOnBed: [12, -3, 0] },
};

/** The JSON of `p` with `edit` applied to the parsed document. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a test edits arbitrary fields of the parsed file
type Doc = any;
function edited(p: SavedProfile, edit: (doc: Doc) => void): string {
  const doc: Doc = JSON.parse(profileToJson(p));
  edit(doc);
  return JSON.stringify(doc);
}

describe('profile JSON', () => {
  it('round-trips the default and a custom profile exactly', () => {
    for (const p of [DEFAULT_SAVED_PROFILE, custom]) {
      const parsed = parseProfile(profileToJson(p));
      expect(parsed).toEqual({ ok: true, profile: { ...p, machine: { ...p.machine, keepOut: p.machine.keepOut ?? [] } } });
    }
  });

  it('marks the file with its format and version', () => {
    const doc = JSON.parse(profileToJson(custom));
    expect(doc.format).toBe(PROFILE_FORMAT);
    expect(doc.version).toBe(1);
  });

  it('names the file after the machine', () => {
    expect(profileFileName(DEFAULT_SAVED_PROFILE)).toBe('nomad-883-pro.profile.json');
    expect(profileFileName({ ...custom, machine: { ...custom.machine, name: '  ///  ' } })).toBe('machine.profile.json');
  });

  it.each([
    ['not JSON', '{', /not JSON/],
    ['another file', '{"hello": 1}', /not a cnc-stl-viewer\/profile file/],
    ['a JSON array', '[1,2,3]', /not a cnc-stl-viewer\/profile file/],
    ['a newer version', edited(custom, (d) => (d.version = 2)), /version 2 is not supported/],
    ['no machine', edited(custom, (d) => delete d.machine), /machine is missing/],
    ['inch machine', edited(custom, (d) => (d.machine.units = 'in')), /machine.units must be "mm"/],
    ['negative travel', edited(custom, (d) => (d.machine.travel = [250, -1, 100])), /machine.travel must be three numbers above 0/],
    ['two-number travel', edited(custom, (d) => (d.machine.travel = [250, 250])), /machine.travel must be three/],
    ['string in travel', edited(custom, (d) => (d.machine.travel = [250, '250', 100])), /machine.travel/],
    ['huge number overflows to Infinity', '{"format":"cnc-stl-viewer/profile","version":1,"machine":{"name":"x","units":"mm","travel":[1e999,1,1],"cuttingArea":[1,1,1]},"stock":{},"setup":{}}', /machine.travel/],
    ['cutting area above travel', edited(custom, (d) => (d.machine.cuttingArea = [260, 190, 70])), /cuttingArea X \(260\) is larger than the travel/],
    ['empty name', edited(custom, (d) => (d.machine.name = '  ')), /machine.name must be a name/],
    ['two keep-out boxes', edited(custom, (d) => d.machine.keepOut.push(d.machine.keepOut[0])), /more than one box/],
    ['floating keep-out box', edited(custom, (d) => (d.machine.keepOut[0].min[2] = 5)), /min Z must be 0/],
    ['inside-out keep-out box', edited(custom, (d) => (d.machine.keepOut[0].max[0] = 100)), /max must be above min/],
    ['negative allowance', edited(custom, (d) => (d.stock.allowance.top = -1)), /stock.allowance.top must be a number 0 or more/],
    ['null allowance', edited(custom, (d) => (d.stock.allowance.xy = null)), /stock.allowance.xy/],
    ['zero block', edited(custom, (d) => (d.stock.size = [0, 10, 10])), /stock.size must be three numbers above 0/],
    ['bad mode', edited(custom, (d) => (d.stock.mode = 'magic')), /stock.mode/],
    ['bad origin', edited(custom, (d) => (d.setup.origin = 'top-left')), /setup.origin/],
    ['stock lifted off the bed', edited(custom, (d) => (d.setup.stockOnBed = [0, 0, 3])), /stockOnBed Z must be 0/],
  ])('refuses %s, naming the problem', (_name, text, message) => {
    const parsed = parseProfile(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(message);
  });

  it('accepts a file without a keep-out box or a bed note, using none and the default note', () => {
    const parsed = parseProfile(
      edited(custom, (d) => {
        delete d.machine.keepOut;
        delete d.machine.bedOriginNote;
      }),
    );
    expect(parsed.ok && parsed.profile.machine.keepOut).toEqual([]);
    expect(parsed.ok && parsed.profile.machine.bedOriginNote).toBe(DEFAULT_PROFILE.bedOriginNote);
  });

  it('reads -0 as 0', () => {
    const parsed = parseProfile(profileToJson(custom).replace('"stockOnBed": [\n      12', '"stockOnBed": [\n      -0'));
    expect(parsed.ok && Object.is(parsed.profile.setup.stockOnBed[0], 0)).toBe(true);
  });
});

describe('profile in localStorage', () => {
  it('a saved profile is what the next visit loads', () => {
    const store = memory();
    expect(saveProfile(store, custom)).toBe(true);
    expect(JSON.parse(store.data[PROFILE_KEY]!).machine.name).toBe('Shop Nomad');
    expect(loadProfile(store)).toEqual(custom);
  });

  it('falls back to the defaults with nothing stored, no storage, or unreadable storage', () => {
    expect(loadProfile(memory())).toBe(DEFAULT_SAVED_PROFILE);
    expect(loadProfile(null)).toBe(DEFAULT_SAVED_PROFILE);
    expect(loadProfile(throwing)).toBe(DEFAULT_SAVED_PROFILE);
  });

  it.each([
    ['truncated JSON', profileToJson(custom).slice(0, 40)],
    ['garbage', '\u0000\u0001 not json'],
    ['the string "null"', 'null'],
    ['an empty string', ''],
    ['valid JSON, wrong shape', JSON.stringify({ format: PROFILE_FORMAT, version: 1, machine: 42 })],
    ['a field out of range', edited(custom, (d) => (d.stock.allowance.xy = -3))],
  ])('a corrupt stored value (%s) falls back to the defaults, whole', (_name, value) => {
    expect(loadProfile(memory({ [PROFILE_KEY]: value }))).toBe(DEFAULT_SAVED_PROFILE);
  });

  it('a failed write is reported, not thrown', () => {
    expect(saveProfile(throwing, custom)).toBe(false);
    expect(saveProfile(null, custom)).toBe(false);
  });

  it('the defaults are frozen', () => {
    expect(Object.isFrozen(DEFAULT_SAVED_PROFILE)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SAVED_PROFILE.stock)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SAVED_PROFILE.setup.stockOnBed)).toBe(true);
  });
});

describe('sameMachineSize', () => {
  it('compares travel and cutting area only', () => {
    expect(sameMachineSize(DEFAULT_PROFILE, { ...DEFAULT_PROFILE, name: 'other', keepOut: [] })).toBe(true);
    expect(sameMachineSize(DEFAULT_PROFILE, custom.machine)).toBe(false);
    expect(sameMachineSize(DEFAULT_PROFILE, { ...DEFAULT_PROFILE, travel: [250, 250, 101] })).toBe(false);
  });
});
