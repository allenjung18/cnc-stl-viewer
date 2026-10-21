import { describe, expect, it } from 'vitest';
import { checkFit } from '../geom/fit';
import { DEFAULT_PROFILE } from '../state/profiles';
import { fitRows, fitVerdict, readStockForm, type StockFormValues } from './stockPanel';

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
