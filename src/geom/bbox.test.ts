import { describe, expect, it } from 'vitest';
import { bboxOf, centreOf, diagonalOf, sizeOf } from './bbox';

describe('bbox', () => {
  it('spans every vertex, including negative coordinates', () => {
    const box = bboxOf(Float32Array.from([1, -2, 3, -4, 5, -6, 0, 0, 0]));
    expect(box).toEqual({ min: [-4, -2, -6], max: [1, 5, 3] });
    expect(sizeOf(box)).toEqual([5, 7, 9]);
    expect(centreOf(box)).toEqual([-1.5, 1.5, -1.5]);
  });

  it('a single point has zero size and diagonal', () => {
    const box = bboxOf([7, 7, 7]);
    expect(sizeOf(box)).toEqual([0, 0, 0]);
    expect(diagonalOf(box)).toBe(0);
  });

  it('refuses empty, partial and non-finite input', () => {
    expect(() => bboxOf(new Float32Array(0))).toThrow(RangeError);
    expect(() => bboxOf([1, 2])).toThrow(RangeError);
    expect(() => bboxOf([0, Number.NaN, 0])).toThrow(/not a finite number/);
    expect(() => bboxOf([0, 0, Infinity])).toThrow(/not a finite number/);
  });
});
