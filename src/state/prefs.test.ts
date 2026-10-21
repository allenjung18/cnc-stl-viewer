import { describe, expect, it } from 'vitest';
import { loadUnits, saveUnits, UNITS_KEY, type PrefStorage } from './prefs';

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
