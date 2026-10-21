/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { boxTriangles } from '../../test/fixtures/tiny-generator';
import { parseStl } from '../io/parse';
import { NOMAD_883_PRO_CUTTING_AREA } from '../state/profiles';
import type { Vec3 } from '../state/model';
import { inspectMesh } from './stats';
import { fitsSomeWay, MM_PER_INCH, parseUnitChoice, scaleStats, unitHint, unitScaleOf } from './units';

const ENVELOPE = NOMAD_883_PRO_CUTTING_AREA; // 203 × 203 × 76

const statsOf = (name: string) =>
  inspectMesh(parseStl(new Uint8Array(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url)))).positions)
    .stats;

describe('the inch cube and the 20 mm cube', () => {
  it('inch-cube.stl (1 × 1 × 1) gets the hint "looks like inches"', () => {
    const s = statsOf('inch-cube.stl');
    expect(s.size).toEqual([1, 1, 1]);
    expect(unitHint(s.size, 'mm', ENVELOPE)).toEqual({ kind: 'looks-like-inches', text: 'looks like inches' });
  });

  it('after ×25.4 the inch cube is 25.4 mm on a side and 16387.064 mm³', () => {
    const s = scaleStats(statsOf('inch-cube.stl'), unitScaleOf('in'));
    for (const v of s.size) expect(v).toBeCloseTo(25.4, 12);
    expect(Math.abs(s.volumeMm3 - 16387.064)).toBeLessThanOrEqual(1e-6);
    expect(s.areaMm2).toBeCloseTo(6 * 25.4 * 25.4, 9); // 3870.96 mm²
    expect(s.bbox).toEqual({ min: [0, 0, 0], max: [25.4, 25.4, 25.4] });
    // Counts and flags are the same mesh.
    expect(s).toMatchObject({ triangles: 12, vertices: 8, watertight: true, openEdges: 0, flippedHint: false });
    // Treated as inches, the cube fits: nothing more to say.
    expect(unitHint(statsOf('inch-cube.stl').size, 'in', ENVELOPE)).toBeNull();
  });

  for (const name of ['cube-20mm-binary.stl', 'cube-20mm-ascii.stl']) {
    it(`${name} gets no hint`, () => {
      expect(unitHint(statsOf(name).size, 'mm', ENVELOPE)).toBeNull();
    });
  }

  it('the 20 mm cube treated as inches would be 508 mm: the hint says it does not fit', () => {
    expect(unitHint(statsOf('cube-20mm-binary.stl').size, 'in', ENVELOPE)?.kind).toBe('inches-do-not-fit');
  });
});

describe('unitHint edges', () => {
  const hint = (size: Vec3) => unitHint(size, 'mm', ENVELOPE)?.kind ?? null;

  it('the inch hint needs the largest side under 12 and ×25.4 to fit the cutting area', () => {
    expect(hint([11.99, 1, 1])).toBeNull(); // 304.5 mm long: no orientation fits 203
    expect(hint([7.99, 7.99, 2.99])).toBe('looks-like-inches'); // 203 × 203 × 76 mm, just
    expect(hint([2.99, 7.99, 7.99])).toBe('looks-like-inches'); // the same part standing up
    expect(hint([8, 8, 8])).toBeNull(); // 203.2 mm on every side: too tall in any orientation
    expect(hint([12, 0.1, 0.1])).toBeNull(); // not under 12
    expect(hint([1e-9, 1e-9, 1e-9])).toBe('looks-like-inches');
  });

  it('over 1000 as mm: "may be in microns"; exactly 1000 is not', () => {
    expect(hint([1000.001, 1, 1])).toBe('looks-too-large');
    expect(hint([1e13, 1e13, 1e13])).toBe('looks-too-large');
    expect(hint([1000, 1, 1])).toBeNull();
  });

  it('no size, a collapsed size or a non-finite size: no hint', () => {
    expect(hint([0, 0, 0])).toBeNull();
    expect(hint([Number.NaN, 1, 1])).toBeNull();
    expect(hint([Infinity, 1, 1])).toBeNull();
    expect(hint([-1, 1, 1])).toBeNull();
    expect(unitHint([0, 0, 0], 'in', ENVELOPE)).toBeNull();
    expect(unitHint([Infinity, 1, 1], 'in', ENVELOPE)).toBeNull();
  });

  it('a flat part (zero thickness) still gets the inch hint', () => {
    expect(hint([2, 3, 0])).toBe('looks-like-inches');
  });
});

describe('fitsSomeWay', () => {
  it('compares largest to largest', () => {
    expect(fitsSomeWay([76, 203, 203], [203, 203, 76])).toBe(true);
    expect(fitsSomeWay([77, 203, 203], [203, 203, 76])).toBe(false);
    expect(fitsSomeWay([0, 0, 0], [203, 203, 76])).toBe(true);
    expect(fitsSomeWay([Number.NaN, 1, 1], [203, 203, 76])).toBe(false);
  });
});

describe('scaleStats', () => {
  const cube = inspectMesh(Float32Array.from(boxTriangles([0, 0, 0], [2, 3, 4]).flat(2))).stats;

  it('lengths × s, area × s², volume × s³; counts and flags unchanged', () => {
    const s = scaleStats(cube, 10);
    expect(s.size).toEqual([20, 30, 40]);
    expect(s.volumeMm3).toBeCloseTo(24 * 1000, 9);
    expect(s.areaMm2).toBeCloseTo(2 * (6 + 8 + 12) * 100, 9);
    expect(s.weldEpsilon).toBeCloseTo(cube.weldEpsilon * 10, 15);
    expect({ ...s, size: 0, bbox: 0, volumeMm3: 0, areaMm2: 0, weldEpsilon: 0 }).toEqual({
      ...cube,
      size: 0,
      bbox: 0,
      volumeMm3: 0,
      areaMm2: 0,
      weldEpsilon: 0,
    });
  });

  it('keeps the sign of an inward-wound volume', () => {
    const reversed = statsOf('cube-reversed-winding.stl');
    const s = scaleStats(reversed, MM_PER_INCH);
    expect(s.volumeMm3).toBeCloseTo(-8000 * MM_PER_INCH ** 3, 3);
    expect(s.flippedHint).toBe(true);
  });

  it('×1 returns the stats unchanged', () => {
    expect(scaleStats(cube, 1)).toBe(cube);
  });

  it('refuses 0, negative, NaN and infinite scales', () => {
    for (const bad of [0, -25.4, Number.NaN, Infinity, -Infinity]) {
      expect(() => scaleStats(cube, bad)).toThrow(RangeError);
    }
  });

  it('a tiny scale stays finite and positive', () => {
    const s = scaleStats(cube, 1e-9);
    expect(s.volumeMm3).toBeGreaterThan(0);
    expect(s.size[0]).toBeCloseTo(2e-9, 20);
  });
});

describe('unit choice', () => {
  it('mm is ×1, inches ×25.4', () => {
    expect(unitScaleOf('mm')).toBe(1);
    expect(unitScaleOf('in')).toBe(25.4);
  });

  it('parses only "mm" and "in"', () => {
    expect(parseUnitChoice('mm')).toBe('mm');
    expect(parseUnitChoice('in')).toBe('in');
    for (const bad of [null, undefined, '', 'IN', 'inch', 25.4, {}]) expect(parseUnitChoice(bad)).toBeNull();
  });
});
