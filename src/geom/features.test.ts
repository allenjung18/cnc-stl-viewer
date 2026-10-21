import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOL_DIAMETER_MM, minFeatureHint, parseToolDiameter } from './features';

describe('minFeatureHint (the thinnest bounding slab)', () => {
  it('names the smallest extent and its axis; a hint, labelled box-only', () => {
    const h = minFeatureHint([60, 40, 2], DEFAULT_TOOL_DIAMETER_MM)!;
    expect(h).toMatchObject({ thinnestMm: 2, axis: 'Z', belowTool: true });
    expect(h.text).toMatch(/^2 mm along Z, thinner than the 3.175 mm end mill/);
    expect(h.text).toMatch(/walls inside the part are not checked/);
  });

  it('at or above the tool: no warning', () => {
    expect(minFeatureHint([20, 20, 20], 3.175)).toMatchObject({ thinnestMm: 20, axis: 'X', belowTool: false });
    expect(minFeatureHint([10, 3.175, 10], 3.175)).toMatchObject({ axis: 'Y', belowTool: false });
    expect(minFeatureHint([10, 3.175, 10], 3.175)!.text).not.toMatch(/thinner/);
  });

  it('follows the orientation: the same plate stood on edge is thin along X', () => {
    expect(minFeatureHint([2, 40, 60], 3.175)).toMatchObject({ axis: 'X', thinnestMm: 2 });
  });

  it('extremes: a flat part (0), a sliver (1e-9), a huge part (1e13); no tool → no warning', () => {
    expect(minFeatureHint([10, 10, 0], 3.175)).toMatchObject({ thinnestMm: 0, belowTool: true });
    expect(minFeatureHint([1e-9, 10, 10], 3.175)).toMatchObject({ thinnestMm: 1e-9, belowTool: true });
    expect(minFeatureHint([1e13, 2e13, 3e13], 3.175)).toMatchObject({ thinnestMm: 1e13, belowTool: false });
    for (const tool of [0, -1, Number.NaN, Infinity]) expect(minFeatureHint([10, 10, 1], tool)!.belowTool).toBe(false);
  });

  it('a size it cannot judge gives no hint', () => {
    for (const bad of [Number.NaN, Infinity, -1]) expect(minFeatureHint([bad, 10, 10], 3.175)).toBeNull();
  });

  it('formats with the panel formatter it is given', () => {
    expect(minFeatureHint([1.23456, 10, 10], 3.175, (n) => n.toFixed(1))!.text).toMatch(/^1.2 mm along X, thinner than the 3.2 mm/);
  });
});

describe('parseToolDiameter', () => {
  it.each([
    ['3.175', 3.175],
    [' 6 ', 6],
    [0.5, 0.5],
    ['100', 100],
  ])('%s → %s', (v, n) => expect(parseToolDiameter(v)).toBe(n));
  it.each(['', '  ', 'abc', '0', '-1', '100.5', 'Infinity', 'NaN', null, undefined, {}])('refuses %s', (v) => {
    expect(parseToolDiameter(v)).toBeNull();
  });
});
