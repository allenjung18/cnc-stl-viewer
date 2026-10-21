/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CUBE_MIN, CUBE_SIZE, asciiStl, binaryStl, boxTriangles, buildFixtures } from '../../test/fixtures/tiny-generator';
import { PROGRESS_EVERY, handleParseRequest, parseStl, type ParseResponse } from './parse';
import { StlError } from './sniff';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url)));

function bounds(p: Float32Array): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    const a = i % 3;
    min[a] = Math.min(min[a]!, p[i]!);
    max[a] = Math.max(max[a]!, p[i]!);
  }
  return { min, max };
}

describe('parseStl', () => {
  it('reads both 20 mm cubes as 12 triangles with identical positions', () => {
    const bin = parseStl(fixture('cube-20mm-binary.stl'));
    const ascii = parseStl(fixture('cube-20mm-ascii.stl'));
    expect(bin.format).toBe('stl-bin');
    expect(ascii.format).toBe('stl-ascii');
    expect(bin.triangles).toBe(12);
    expect(ascii.triangles).toBe(12);
    expect(bin.positions).toHaveLength(12 * 9);
    expect(Array.from(ascii.positions)).toEqual(Array.from(bin.positions));
  });

  it('keeps file-space coordinates: the cube spans its file box, not the origin', () => {
    const { min, max } = bounds(parseStl(fixture('cube-20mm-binary.stl')).positions);
    expect(min).toEqual([...CUBE_MIN]);
    expect(max).toEqual(CUBE_MIN.map((m, i) => m + CUBE_SIZE[i]!));
  });

  it('reads vertices in file order, skipping the facet normal', () => {
    const tris = boxTriangles([1, 2, 3], [4, 5, 6]);
    const expected = tris.flatMap((t) => t.flatMap((p) => [...p]));
    expect(Array.from(parseStl(binaryStl(tris, 'x')).positions)).toEqual(expected);
    expect(Array.from(parseStl(asciiStl(tris, 'x')).positions)).toEqual(expected);
  });

  it('reads the other fixtures with their triangle counts', () => {
    expect(parseStl(fixture('inch-cube.stl')).triangles).toBe(12);
    expect(bounds(parseStl(fixture('inch-cube.stl')).positions).max).toEqual([1, 1, 1]);
    expect(parseStl(fixture('open-box.stl')).triangles).toBe(10);
    expect(parseStl(fixture('bowtie.stl')).triangles).toBe(24);
    expect(parseStl(fixture('cube-reversed-winding.stl')).triangles).toBe(12);
  });

  it('reads ASCII with exponents, signs, CRLF, tabs and upper-case keywords', () => {
    const text = [
      'SOLID  part with spaces in its name',
      '\tFACET NORMAL 0 0 1',
      '\t\tOUTER LOOP',
      '\t\t\tVERTEX 1e1 -2.5E+0 +0.0',
      '\t\t\tVERTEX 1.5e-1 0 0',
      '\t\t\tVERTEX 0 1 0',
      '\t\tENDLOOP',
      '\tENDFACET',
      'ENDSOLID part',
      '',
    ].join('\r\n');
    const parsed = parseStl(new TextEncoder().encode(text));
    expect(parsed.triangles).toBe(1);
    expect(Array.from(parsed.positions)).toEqual([10, -2.5, 0, Math.fround(0.15), 0, 0, 0, 1, 0]);
  });

  it('refuses ASCII facets with the wrong vertex count or a bad number', () => {
    const facet = (verts: string[]): string =>
      ['solid s', 'facet normal 0 0 1', 'outer loop', ...verts.map((v) => `vertex ${v}`), 'endloop', 'endfacet', 'endsolid s', ''].join('\n');
    const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
    expect(() => parseStl(enc(facet(['0 0 0', '1 0 0'])))).toThrow(/exactly 3 vertices/);
    expect(() => parseStl(enc(facet(['0 0 0', '1 0 0', '0 1 0', '1 1 0'])))).toThrow(/exactly 3 vertices/);
    expect(() => parseStl(enc(facet(['0 0 0', '1 0 x', '0 1 0'])))).toThrow(/not a number: "x"/);
    expect(() => parseStl(enc(facet(['0 0 0', '1 0 Infinity', '0 1 0'])))).toThrow(StlError);
    // Finite as a double, Infinity as float32.
    expect(() => parseStl(enc(facet(['0 0 0', '1e39 0 0', '0 1 0'])))).toThrow(/Vertex 2 has a coordinate too large to store: "1e39"/);
    expect(() => parseStl(enc(facet(['0 0 0', '0 -3.5e38 0', '0 1 0'])))).toThrow(/too large to store/);
    // The float32 maximum itself still reads.
    expect(parseStl(enc(facet(['0 0 0', '3.4e38 0 0', '0 1 0']))).positions[3]).toBe(Math.fround(3.4e38));
    expect(() => parseStl(enc('solid s\nendsolid s\n'))).toThrow(/no triangles/);
  });

  it('refuses binary triangles with a NaN or infinite coordinate', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const bytes = binaryStl(boxTriangles([0, 0, 0], [1, 1, 1]), 'x');
      new DataView(bytes.buffer).setFloat32(84 + 50 * 3 + 12 + 4, bad, true);
      expect(() => parseStl(bytes)).toThrow(/Triangle 4 has a coordinate that is not a finite number/);
    }
  });

  it('reads large coordinates and tiny ones without change (float32)', () => {
    const tris = boxTriangles([-1e12, 1e-9, 0], [1e12, 1e-9, 3]);
    const parsed = parseStl(binaryStl(tris, 'x'));
    expect(Array.from(parsed.positions)).toEqual(tris.flatMap((t) => t.flatMap((p) => p.map(Math.fround))));
  });

  it('reports progress every PROGRESS_EVERY triangles', () => {
    const tris = boxTriangles([0, 0, 0], [1, 1, 1]);
    const many = Array.from({ length: Math.ceil((PROGRESS_EVERY * 2 + 5) / 12) }, () => tris).flat();
    const calls: [number, number][] = [];
    parseStl(binaryStl(many, 'x'), (done, total) => calls.push([done, total]));
    expect(calls).toEqual([
      [PROGRESS_EVERY, many.length],
      [PROGRESS_EVERY * 2, many.length],
    ]);
  });
});

describe('handleParseRequest (the worker body)', () => {
  it('posts done with the positions transferred', () => {
    const bytes = fixture('cube-20mm-ascii.stl');
    const posted: [ParseResponse, Transferable[]][] = [];
    handleParseRequest({ id: 7, buffer: bytes.slice().buffer }, (m, t) => posted.push([m, t]));
    expect(posted).toHaveLength(1);
    const [msg, transfer] = posted[0]!;
    if (msg.type !== 'done') throw new Error(`expected done, got ${msg.type}`);
    expect(msg.id).toBe(7);
    expect(msg.triangles).toBe(12);
    expect(transfer).toEqual([msg.positions.buffer]);
  });

  it('posts a readable error for a truncated file', () => {
    const bytes = fixture('cube-20mm-binary.stl').slice(0, 300);
    const posted: ParseResponse[] = [];
    handleParseRequest({ id: 1, buffer: bytes.buffer }, (m) => posted.push(m));
    expect(posted).toEqual([{ id: 1, type: 'error', message: expect.stringMatching(/truncated/) }]);
  });
});

describe('fixtures', () => {
  it('the committed files match what the generator writes', () => {
    for (const [name, bytes] of Object.entries(buildFixtures())) {
      expect(fixture(name), name).toEqual(bytes);
    }
  });
});
