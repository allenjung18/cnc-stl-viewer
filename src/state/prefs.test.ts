import { describe, expect, it } from 'vitest';
import { loadToolDiameter, loadUnits, saveToolDiameter, saveUnits, TOOL_KEY, UNITS_KEY, type PrefStorage } from './prefs';

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

describe('units preference', () => {
  it('defaults to mm with nothing stored, no storage, or unreadable storage', () => {
    expect(loadUnits(memory())).toBe('mm');
    expect(loadUnits(null)).toBe('mm');
    expect(loadUnits(throwing)).toBe('mm');
  });

  it('a saved choice is what the next visit loads', () => {
    const store = memory();
    expect(saveUnits(store, 'in')).toBe(true);
    expect(store.data[UNITS_KEY]).toBe('in');
    expect(loadUnits(store)).toBe('in');
    expect(saveUnits(store, 'mm')).toBe(true);
    expect(loadUnits(store)).toBe('mm');
  });

  it('a stored value that is not a choice reads as mm', () => {
    for (const bad of ['', 'inch', 'IN', '25.4', 'null']) expect(loadUnits(memory({ [UNITS_KEY]: bad }))).toBe('mm');
  });

  it('a failed write is reported, not thrown', () => {
    expect(saveUnits(throwing, 'in')).toBe(false);
    expect(saveUnits(null, 'in')).toBe(false);
  });
});

describe('end-mill diameter preference', () => {
  const memory = (init: Record<string, string> = {}): PrefStorage & { data: Record<string, string> } => {
    const data = { ...init };
    return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
  };
  it('defaults to 1/8 in, round-trips a valid value, ignores a corrupt one', () => {
    expect(loadToolDiameter(null)).toBe(3.175);
    const s = memory();
    expect(loadToolDiameter(s)).toBe(3.175);
    expect(saveToolDiameter(s, 6)).toBe(true);
    expect(s.data[TOOL_KEY]).toBe('6');
    expect(loadToolDiameter(s)).toBe(6);
    for (const bad of ['', 'abc', '-2', '0', '1e9']) expect(loadToolDiameter(memory({ [TOOL_KEY]: bad }))).toBe(3.175);
  });
  it('refuses to store an invalid value, and survives a storage that throws', () => {
    const s = memory();
    expect(saveToolDiameter(s, 0)).toBe(false);
    expect(saveToolDiameter(s, Number.NaN)).toBe(false);
    expect(s.data).toEqual({});
    const throwing: PrefStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    expect(loadToolDiameter(throwing)).toBe(3.175);
    expect(saveToolDiameter(throwing, 6)).toBe(false);
    expect(saveToolDiameter(null, 6)).toBe(false);
  });
});
