import { describe, expect, it } from 'vitest';
import { checkFit } from '../geom/fit';
import { IDENTITY, rotate90 } from '../geom/orient';
import type { Setup, Stock, Vec3 } from '../state/model';
import { DEFAULT_PROFILE } from '../state/profiles';
import { orientationText, setupSheet, type SetupSheetInput } from './setupSheet';

const stock: Stock = { mode: 'auto', allowance: { xy: 3, top: 1, bottom: 2 }, size: [25, 25, 25] };
const setup: Setup = { origin: 'bottom-left-front-top', stockOnBed: [0, 0, 0] };

function input(over: Partial<SetupSheetInput> = {}, partSize: Vec3 | null = [20, 20, 20]): SetupSheetInput {
  const s = over.form && 'stock' in over.form ? over.form : { stock, setup };
  return {
    partName: partSize ? 'cube-20mm-binary.stl' : null,
    units: 'mm',
    partSizeMm: partSize,
    rotation: partSize ? IDENTITY : null,
    machine: DEFAULT_PROFILE,
    form: s,
    fit: checkFit({ partSize, stock: s.stock, setup: s.setup, profile: DEFAULT_PROFILE }),
    ...over,
  };
}

describe('setupSheet', () => {
  it('the 20 mm cube with the default allowance: stock, origin, offset and verdict', () => {
    const text = setupSheet(input());
    const lines = text.trimEnd().split('\n');
    expect(lines).toEqual([
      'STL stock-fit setup sheet',
      'Machine: Nomad 883 Pro (cutting area 203 × 203 × 76 mm)',
      'Part: cube-20mm-binary.stl',
      'Units: file read as mm',
      'Part X × Y × Z: 20 × 20 × 20 mm',
      'Orientation: as read from the file',
      'Stock X × Y × Z: 26 × 26 × 23 mm (part + allowance X/Y 3, top 1, bottom 2 mm per side)',
      'Stock on the bed (front-left corner): X 0, Y 0 mm',
      'WCS origin: front-left corner of the stock, Z0 on the stock top',
      'WCS origin on the bed: X 0, Y 0, Z 23 mm',
      'Part offset in stock (part min corner from stock front-left-bottom): X 3, Y 3, Z 2 mm',
      'Z left for tool + clamps: 53.0 mm',
      'Fit: fits: part in stock with margins, stock in the cutting area',
    ]);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('a fixed block that is too small names each failing axis', () => {
    const fixed = { stock: { ...stock, mode: 'fixed' as const, size: [25, 25, 25] as Vec3 }, setup: { ...setup, origin: 'center-top' as const } };
    const text = setupSheet(input({ form: fixed }));
    expect(text).toContain('Stock X × Y × Z: 25 × 25 × 25 mm (fixed block)');
    expect(text).toContain('WCS origin: centre of the stock, Z0 on the stock top');
    expect(text).toContain('Fit: part exceeds stock X by 1.0 mm (with margins); part exceeds stock Y by 1.0 mm (with margins)');
  });

  it('with no part: says so, and the stock is not sized in auto mode', () => {
    const text = setupSheet(input({}, null));
    expect(text).toContain('Part: none loaded');
    expect(text).toContain('Stock: not sized (load a part, or enter a fixed block)');
    expect(text).not.toContain('Part offset');
    expect(text).toContain('Fit: Load a part, or enter a fixed block');
  });

  it('invalid inputs: the sheet says it was not checked, and why', () => {
    const text = setupSheet(input({ form: { errors: ['Allowance X/Y is empty'] }, fit: null }));
    expect(text.trimEnd().split('\n').at(-1)).toBe('Not checked: Allowance X/Y is empty');
    expect(text).not.toContain('Stock X');
  });

  it('inches and a keep-out box are named', () => {
    const machine = { ...DEFAULT_PROFILE, keepOut: [{ min: [150, 0, 0] as Vec3, max: [180, 30, 10] as Vec3 }] };
    const text = setupSheet(input({ units: 'in', machine }, [25.4, 25.4, 25.4]));
    expect(text).toContain('Units: file read as inches (×25.4)');
    expect(text).toContain('Keep-out boxes checked: 1');
  });
});

describe('orientationText', () => {
  it('names where each file axis points after quarter turns', () => {
    expect(orientationText(IDENTITY)).toBe('as read from the file');
    expect(orientationText(rotate90(IDENTITY, 'Z'))).toBe('turned: file X → +Y, file Y → −X, file Z → +Z');
    expect(orientationText(rotate90(IDENTITY, 'X'))).toBe('turned: file X → +X, file Y → +Z, file Z → −Y');
  });

  it('prints the matrix for a turn that is not a quarter turn', () => {
    const c = Math.SQRT1_2;
    expect(orientationText([c, -c, 0, c, c, 0, 0, 0, 1])).toBe('turned (machine = R · file), R = [0.7071, -0.7071, 0.0000] [0.7071, 0.7071, 0.0000] [0.0000, 0.0000, 1.0000]');
  });
});
