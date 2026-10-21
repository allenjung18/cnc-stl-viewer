/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inspectMesh } from '../geom/stats';
import { parseStl } from '../io/parse';
import { formatNumber, partRows, type PanelRow } from './panel';

const COLOURS = { open: '#ff3b30', nonManifold: '#ff3df5' };

function rowsFor(name: string): Record<string, PanelRow> {
  const parsed = parseStl(new Uint8Array(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url))));
  const rows = partRows({ name, format: parsed.format, stats: inspectMesh(parsed.positions).stats }, COLOURS);
  return Object.fromEntries(rows.map((r) => [r.key, r]));
}

describe('partRows', () => {
  it('the 20 mm cube: size, volume, area, counts, watertight, outward', () => {
    const r = rowsFor('cube-20mm-binary.stl');
    expect(r.name!.value).toBe('cube-20mm-binary.stl');
    expect(r.format!.value).toBe('binary STL');
    expect(r.size!.value).toBe('20 × 20 × 20 mm');
    expect(r.volume!.value).toBe('8,000 mm³');
    expect(r.volume!.tone).toBeUndefined();
    expect(r.area!.value).toBe('2,400 mm²');
    expect(r.triangles!.value).toBe('12');
    expect(r.vertices!.value).toBe('8');
    expect(r.watertight!).toMatchObject({ value: 'yes', tone: 'ok' });
    expect(r['open-edges']!).toMatchObject({ value: '0', swatch: undefined });
    expect(r['non-manifold-edges']!).toMatchObject({ value: '0', swatch: undefined });
    expect(r.degenerate!.value).toBe('0');
    expect(r.normals!).toMatchObject({ value: 'outward', tone: 'ok' });
  });

  it('the ASCII cube reads the same apart from the format', () => {
    const r = rowsFor('cube-20mm-ascii.stl');
    expect(r.format!.value).toBe('ASCII STL');
    expect(r.volume!.value).toBe('8,000 mm³');
  });

  it('the open box: 4 open edges with the red swatch, volume marked approximate', () => {
    const r = rowsFor('open-box.stl');
    expect(r.watertight!).toMatchObject({ value: 'no — 4 open edges', tone: 'bad' });
    expect(r['open-edges']!).toMatchObject({ value: '4', tone: 'bad', swatch: COLOURS.open });
    expect(r.volume!.value).toMatch(/^≈ .* mm³ \(mesh is open\)$/);
    expect(r.volume!.tone).toBe('warn');
  });

  it('the bowtie: 1 non-manifold edge with the magenta swatch', () => {
    const r = rowsFor('bowtie.stl');
    expect(r.watertight!.value).toBe('no — 1 non-manifold edge');
    expect(r['non-manifold-edges']!).toMatchObject({ value: '1', tone: 'bad', swatch: COLOURS.nonManifold });
    expect(r['open-edges']!.value).toBe('0');
    expect(r.vertices!.value).toBe('14');
    expect(r.volume!.value).toBe('≈ 2,000 mm³ (mesh is not manifold)');
  });

  it('the reversed cube: |V| shown, the negative volume named, normals flagged inward', () => {
    const r = rowsFor('cube-reversed-winding.stl');
    expect(r.volume!.value).toBe('8,000 mm³ (computed −8,000: normals inward)');
    expect(r.watertight!.value).toBe('yes');
    expect(r.normals!).toMatchObject({ value: 'inward (flipped): the volume is negative', tone: 'bad' });
  });

  it('a mesh of collapsed triangles only: no edges, volume marked approximate', () => {
    const stats = inspectMesh(Float32Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1])).stats;
    const r = Object.fromEntries(partRows({ name: 'dot.stl', format: 'stl-bin', stats }, COLOURS).map((x) => [x.key, x]));
    expect(r.watertight!.value).toBe('no — no edges');
    expect(r.volume!.value).toBe('≈ 0 mm³ (mesh has no edges)');
    expect(r.degenerate!).toMatchObject({ value: '1', tone: 'warn' });
  });

  it('the inch cube: 1 × 1 × 1 mm until a unit scale is applied', () => {
    const r = rowsFor('inch-cube.stl');
    expect(r.size!.value).toBe('1 × 1 × 1 mm');
    expect(r.volume!.value).toBe('1 mm³');
    expect(r.area!.value).toBe('6 mm²');
  });
});

describe('formatNumber', () => {
  it('formats the extremes readably', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(-0)).toBe('0');
    expect(formatNumber(1e-9)).toBe('1.000e-9');
    expect(formatNumber(0.0005)).toBe('5.000e-4');
    expect(formatNumber(0.001)).toBe('0.001');
    expect(formatNumber(25.4)).toBe('25.4');
    expect(formatNumber(16387.064)).toBe('16,387.064');
    expect(formatNumber(19.99999)).toBe('20');
    expect(formatNumber(999_999_999_999)).toBe('999,999,999,999');
    expect(formatNumber(1e12)).toBe('1.000e12');
    expect(formatNumber(2.5e15)).toBe('2.500e15');
    expect(formatNumber(Infinity)).toBe('∞');
    expect(formatNumber(-Infinity)).toBe('−∞');
    expect(formatNumber(Number.NaN)).toBe('not a number');
  });
});
