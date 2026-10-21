/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { asciiStl, binaryStl, boxTriangles } from '../../test/fixtures/tiny-generator';
import { MAX_STL_BYTES, StlError, binaryLength, sniffStl } from './sniff';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url)));
const cube = boxTriangles([0, 0, 0], [20, 20, 20]);

describe('sniffStl', () => {
  it('reads the binary cube as binary with 12 triangles', () => {
    expect(sniffStl(fixture('cube-20mm-binary.stl'))).toEqual({ format: 'stl-bin', triangles: 12 });
  });

  it('reads the ASCII cube as ASCII', () => {
    expect(sniffStl(fixture('cube-20mm-ascii.stl'))).toEqual({ format: 'stl-ascii' });
  });

  it('reads a binary file whose header starts with "solid" as binary', () => {
    const bytes = fixture('cube-20mm-binary.stl');
    expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe('solid ');
    expect(sniffStl(bytes)).toEqual({ format: 'stl-bin', triangles: 12 });
    // Same for an all-ASCII header padded with spaces rather than NULs.
    const padded = binaryStl(cube, 'solid ' + ' '.repeat(74));
    expect(sniffStl(padded)).toEqual({ format: 'stl-bin', triangles: 12 });
  });

  it('reads a binary file with a plain header as binary', () => {
    expect(sniffStl(binaryStl(cube, 'exported by a CAD program'))).toEqual({ format: 'stl-bin', triangles: 12 });
    expect(sniffStl(fixture('inch-cube.stl'))).toEqual({ format: 'stl-bin', triangles: 12 });
  });

  it('accepts an ArrayBuffer and a Uint8Array view at an offset alike', () => {
    const bytes = fixture('cube-20mm-binary.stl');
    const shifted = new Uint8Array(bytes.length + 16);
    shifted.set(bytes, 16);
    expect(sniffStl(shifted.subarray(16))).toEqual({ format: 'stl-bin', triangles: 12 });
    expect(sniffStl(bytes.slice().buffer)).toEqual({ format: 'stl-bin', triangles: 12 });
  });

  it('refuses a truncated binary file, naming the promised triangle count', () => {
    const bytes = fixture('cube-20mm-binary.stl');
    for (const cut of [bytes.length - 1, bytes.length - 50, 100, 84]) {
      expect(() => sniffStl(bytes.subarray(0, cut))).toThrow(StlError);
      expect(() => sniffStl(bytes.subarray(0, cut))).toThrow(/truncated.*12 triangles/);
    }
  });

  it('refuses a binary file with bytes after its last triangle', () => {
    const bytes = fixture('inch-cube.stl');
    const longer = new Uint8Array(bytes.length + 7);
    longer.set(bytes);
    expect(() => sniffStl(longer)).toThrow(/7 unexpected bytes/);
  });

  it('refuses a truncated ASCII file', () => {
    const bytes = fixture('cube-20mm-ascii.stl');
    for (const cut of [bytes.length - 20, Math.floor(bytes.length / 2), 30]) {
      expect(() => sniffStl(bytes.subarray(0, cut))).toThrow(/ASCII STL is truncated/);
    }
  });

  it('accepts ASCII with CRLF line ends, leading blank lines and upper case keywords', () => {
    const text = new TextDecoder().decode(asciiStl(cube, 'c')).replace(/\n/g, '\r\n').toUpperCase();
    expect(sniffStl(new TextEncoder().encode('\r\n  ' + text))).toEqual({ format: 'stl-ascii' });
  });

  it('refuses an empty file, a file too short to be STL, and a header-only binary with 0 triangles', () => {
    expect(() => sniffStl(new Uint8Array(0))).toThrow(/empty/);
    expect(() => sniffStl(new TextEncoder().encode('hello'))).toThrow(/too short/);
    expect(() => sniffStl(binaryStl([], 'empty'))).toThrow(/no triangles/);
  });

  it('refuses text that is not an STL', () => {
    expect(() => sniffStl(new TextEncoder().encode('x'.repeat(200)))).toThrow(StlError);
    expect(() => sniffStl(new TextEncoder().encode('solidity is a language\n'.repeat(10)))).toThrow(StlError);
  });

  it('refuses a file over the size limit', () => {
    // Zero-filled: without the size check first it would fail differently ("unexpected bytes").
    expect(() => sniffStl(new Uint8Array(MAX_STL_BYTES + 1))).toThrow(/500\.0 MB are refused/);
    expect(() => sniffStl(new Uint8Array(MAX_STL_BYTES + 1))).toThrow(StlError);
  });

  it('computes the binary length from the triangle count', () => {
    expect(binaryLength(0)).toBe(84);
    expect(binaryLength(12)).toBe(684);
  });
});
