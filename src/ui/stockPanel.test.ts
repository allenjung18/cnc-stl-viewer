import { describe, expect, it } from 'vitest';
import { checkFit } from '../geom/fit';
import { DEFAULT_PROFILE, DEFAULT_SAVED_PROFILE, parseProfile, profileToJson, type SavedProfile } from '../state/profiles';
import { fitRows, fitVerdict, formValuesOf, readStockForm, savedFromForm, type StockFormValues } from './stockPanel';

const DEFAULTS: StockFormValues = {
  mode: 'auto',
  xy: '3',
  top: '1',
  bottom: '2',
  sizeX: '25',
  sizeY: '25',
  sizeZ: '25',
  bedX: '0',
  bedY: '0',
  origin: 'bottom-left-front-top',
  keepOutOn: false,
  keepOutX: '0',
  keepOutY: '0',
  keepOutW: '20',
  keepOutD: '20',
  keepOutH: '10',
};

function fitFor(values: Partial<StockFormValues>, partSize: [number, number, number] | null = [20, 20, 20]) {
  const form = readStockForm({ ...DEFAULTS, ...values });
  if (!form.ok) throw new Error(form.errors.join('; '));
  return checkFit({ partSize, stock: form.stock, setup: form.setup, profile: { ...DEFAULT_PROFILE, keepOut: form.keepOut } });
}

describe('readStockForm', () => {
  it('reads the page defaults: auto stock, allowance 3/1/2, stock at the bed corner, front-left-top origin, no keep-out', () => {
    expect(readStockForm(DEFAULTS)).toEqual({
      ok: true,
      stock: { mode: 'auto', allowance: { xy: 3, top: 1, bottom: 2 }, size: [0, 0, 0] },
      setup: { origin: 'bottom-left-front-top', stockOnBed: [0, 0, 0] },
      keepOut: [],
    });
  });

  it('reads a fixed block and a keep-out box from its corner and size', () => {
    const f = readStockForm({ ...DEFAULTS, mode: 'fixed', sizeX: '76', sizeY: '50', sizeZ: '25', keepOutOn: true, keepOutX: '180', keepOutY: '5', keepOutW: '15', keepOutD: '12', keepOutH: '8' });
    expect(f).toMatchObject({ ok: true, stock: { mode: 'fixed', size: [76, 50, 25] }, keepOut: [{ min: [180, 5, 0], max: [195, 17, 8] }] });
  });

  it('names every bad field: empty, not a number, negative allowance, zero block side', () => {
    const f = readStockForm({ ...DEFAULTS, mode: 'fixed', xy: '', top: 'abc', bottom: '-1', sizeX: '0', bedY: 'Infinity' });
    expect(f).toEqual({
      ok: false,
      errors: [
        'Allowance X/Y is empty',
        'Allowance top must be a number',
        'Allowance bottom must be 0 or more',
        'Block X must be more than 0',
        'Stock on bed Y must be a number',
      ],
    });
  });

  it('ignores the block size in auto mode and the keep-out fields when the box is off', () => {
    expect(readStockForm({ ...DEFAULTS, sizeX: '', keepOutW: '-5' }).ok).toBe(true);
    expect(readStockForm({ ...DEFAULTS, keepOutOn: true, keepOutW: '0' })).toEqual({ ok: false, errors: ['Keep-out width must be more than 0'] });
  });
});

describe('fitVerdict', () => {
  it('auto stock for the 20 mm cube fits', () => {
    expect(fitVerdict(fitFor({}))).toEqual({ tone: 'ok', lines: ['fits: part in stock with margins, stock in the cutting area'] });
  });

  it('a 25 mm block names X and Y and the 1 mm overshoot', () => {
    expect(fitVerdict(fitFor({ mode: 'fixed' }))).toEqual({
      tone: 'bad',
      lines: ['part exceeds stock X by 1.0 mm (with margins)', 'part exceeds stock Y by 1.0 mm (with margins)'],
    });
  });

  it('a 210 mm block names the cutting area, X and 7 mm', () => {
    expect(fitVerdict(fitFor({ mode: 'fixed', sizeX: '210', sizeY: '100', sizeZ: '20' }, null))).toEqual({
      tone: 'bad',
      lines: ['stock exceeds cutting area X by 7.0 mm'],
    });
  });

  it('the keep-out overlap is a failure', () => {
    expect(fitVerdict(fitFor({ keepOutOn: true, keepOutX: '20', keepOutY: '10', keepOutW: '20', keepOutD: '20', keepOutH: '8' })).lines).toEqual([
      'stock overlaps keep-out box 1 by X 6.0 mm, Y 16.0 mm',
    ]);
  });

  it('no part in auto mode asks for one; a fixed block alone is judged on the machine only', () => {
    expect(fitVerdict(fitFor({}, null))).toEqual({ tone: undefined, lines: ['Load a part, or enter a fixed block'] });
    expect(fitVerdict(fitFor({ mode: 'fixed' }, null))).toEqual({ tone: 'ok', lines: ['stock fits the cutting area (no part loaded)'] });
  });

  it('bad inputs are not checked, and say why', () => {
    expect(fitVerdict(null, ['Allowance top is empty'])).toEqual({ tone: 'warn', lines: ['Not checked: Allowance top is empty'] });
  });
});

describe('fitRows', () => {
  it('stock size, part offset, WCS origin and Z left', () => {
    const rows = Object.fromEntries(fitRows(fitFor({})).map((r) => [r.key, r]));
    expect(rows['stock-size']!.value).toBe('26 × 26 × 23 mm');
    expect(rows['part-offset']!.value).toBe('3, 3, 2 mm');
    expect(rows.wcs!.value).toBe('0, 0, 23 mm');
    expect(rows['z-left']).toMatchObject({ value: '53.0 mm', tone: undefined });
  });

  it('a stock taller than the cutting area shows negative Z left, in red', () => {
    const rows = Object.fromEntries(fitRows(fitFor({ mode: 'fixed', sizeZ: '80' }, null)).map((r) => [r.key, r]));
    expect(rows['z-left']).toMatchObject({ value: '-4.0 mm', tone: 'bad' });
    expect(rows['part-offset']).toBeUndefined();
  });

  it('no stock, no rows', () => {
    expect(fitRows(null)).toEqual([]);
    expect(fitRows(fitFor({}, null))).toEqual([]);
  });
});

describe('formValuesOf and savedFromForm', () => {
  const custom: SavedProfile = {
    machine: { ...DEFAULT_PROFILE, keepOut: [{ min: [150, 10, 0], max: [180.5, 40, 12] }] },
    stock: { mode: 'fixed', allowance: { xy: 2.5, top: 0, bottom: 1 }, size: [101.6, 50.8, 19.05] },
    setup: { origin: 'center-top', stockOnBed: [-4, 7.25, 0] },
  };

  it('the default profile shows exactly the page defaults', () => {
    expect(formValuesOf(DEFAULT_SAVED_PROFILE)).toEqual(DEFAULTS);
  });

  it('profile -> inputs -> profile is the identity, through the JSON file too', () => {
    for (const p of [DEFAULT_SAVED_PROFILE, custom]) {
      const back = savedFromForm(formValuesOf(p), p.machine, DEFAULT_SAVED_PROFILE);
      expect(back).toEqual({ ...p, machine: { ...p.machine, keepOut: p.machine.keepOut ?? [] } });
      const file = parseProfile(profileToJson(back!));
      expect(file.ok && file.profile).toEqual(back);
    }
  });

  it('shows the keep-out box as on with its corner and size', () => {
    const v = formValuesOf(custom);
    expect(v).toMatchObject({ keepOutOn: true, keepOutX: '150', keepOutY: '10', keepOutW: '30.5', keepOutD: '30', keepOutH: '12' });
  });

  it('an invalid input saves nothing (the last good profile stays)', () => {
    expect(savedFromForm({ ...DEFAULTS, xy: '' }, DEFAULT_PROFILE, custom)).toBeNull();
    expect(savedFromForm({ ...DEFAULTS, top: '-1' }, DEFAULT_PROFILE, custom)).toBeNull();
    expect(savedFromForm({ ...DEFAULTS, keepOutOn: true, keepOutW: '0' }, DEFAULT_PROFILE, custom)).toBeNull();
  });

  it('in auto mode keeps the block size typed, or the previous one when the block fields are not a size', () => {
    expect(savedFromForm({ ...DEFAULTS, sizeX: '40' }, DEFAULT_PROFILE, custom)!.stock.size).toEqual([40, 25, 25]);
    expect(savedFromForm({ ...DEFAULTS, sizeX: '' }, DEFAULT_PROFILE, custom)!.stock.size).toEqual(custom.stock.size);
    expect(savedFromForm({ ...DEFAULTS, sizeZ: '0' }, DEFAULT_PROFILE, custom)!.stock.size).toEqual(custom.stock.size);
  });

  it('a keep-out box switched off saves none', () => {
    expect(savedFromForm({ ...formValuesOf(custom), keepOutOn: false }, custom.machine, custom)!.machine.keepOut).toEqual([]);
  });
});
