/// <reference types="node" />
/**
 * Writes the STL test fixtures in this folder. The files are committed; run
 * `npm run fixtures` after changing anything here, and the parse tests check
 * that the committed bytes still match what this file builds.
 *
 * Every coordinate is a small integer, so the ASCII and binary forms of the
 * same shape decode to bit-identical float32 positions.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Point = readonly [number, number, number];
export type Triangle = readonly [Point, Point, Point];

/**
 * The 12 triangles of an axis-aligned box from `min` with edge lengths `size`,
 * wound counter-clockwise seen from outside (outward normals).
 */
export function boxTriangles(min: Point, size: Point): Triangle[] {
  const [x0, y0, z0] = min;
  const x1 = x0 + size[0];
  const y1 = y0 + size[1];
  const z1 = z0 + size[2];
  const quads: [Point, Point, Point, Point][] = [
    // bottom (-Z), seen from below
    [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]],
    // top (+Z)
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
    // front (-Y)
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
    // back (+Y)
    [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]],
    // left (-X)
    [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
    // right (+X)
    [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
  ];
  return quads.flatMap(([a, b, c, d]) => [
    [a, b, c],
    [a, c, d],
  ]);
}

/** Every triangle with its winding reversed (normals point inward). */
export function reversed(tris: readonly Triangle[]): Triangle[] {
  return tris.map(([a, b, c]) => [a, c, b]);
}

/** Unit normal from the winding (right-hand rule); zero for a degenerate triangle. */
export function faceNormal([a, b, c]: Triangle): Point {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: [number, number, number] = [
    u[1]! * v[2]! - u[2]! * v[1]!,
    u[2]! * v[0]! - u[0]! * v[2]!,
    u[0]! * v[1]! - u[1]! * v[0]!,
  ];
  const len = Math.hypot(n[0], n[1], n[2]);
  return len === 0 ? [0, 0, 0] : [n[0] / len, n[1] / len, n[2] / len];
}

/** A binary STL: 80-byte header, uint32 count, 50 bytes per triangle (little-endian). */
export function binaryStl(tris: readonly Triangle[], header: string): Uint8Array {
  if (header.length > 80) throw new RangeError('STL header is at most 80 bytes');
  const bytes = new Uint8Array(84 + 50 * tris.length);
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i) & 0x7f;
  const view = new DataView(bytes.buffer);
  view.setUint32(80, tris.length, true);
  let at = 84;
  for (const tri of tris) {
    for (const p of [faceNormal(tri), ...tri]) {
      view.setFloat32(at, p[0], true);
      view.setFloat32(at + 4, p[1], true);
      view.setFloat32(at + 8, p[2], true);
      at += 12;
    }
    at += 2; // attribute byte count, 0
  }
  return bytes;
}

/** An ASCII STL with one facet per triangle. */
export function asciiStl(tris: readonly Triangle[], name: string): Uint8Array {
  const fmt = (p: Point): string => p.map((n) => String(n)).join(' ');
  const lines = [`solid ${name}`];
  for (const tri of tris) {
    lines.push(`  facet normal ${fmt(faceNormal(tri))}`, '    outer loop');
    for (const p of tri) lines.push(`      vertex ${fmt(p)}`);
    lines.push('    endloop', '  endfacet');
  }
  lines.push(`endsolid ${name}`, '');
  return new TextEncoder().encode(lines.join('\n'));
}

/**
 * The cube is placed off the origin in file space on purpose: the viewer must
 * move its min corner to the origin, so a test can tell "placed" from "as read".
 */
export const CUBE_MIN: Point = [10, -5, 3];
export const CUBE_SIZE: Point = [20, 20, 20];

const cube = boxTriangles(CUBE_MIN, CUBE_SIZE);
const openBox = cube.slice(0, 2).concat(cube.slice(4)); // no top face: 10 triangles
const bowtie = boxTriangles([0, 0, 0], [10, 10, 10]).concat(boxTriangles([10, 10, 0], [10, 10, 10]));

/** File name -> bytes, for every fixture this folder holds. */
export function buildFixtures(): Record<string, Uint8Array> {
  return {
    // Header deliberately starts with "solid", as some exporters write it.
    'cube-20mm-binary.stl': binaryStl(cube, 'solid cube-20mm (binary despite the header)'),
    'cube-20mm-ascii.stl': asciiStl(cube, 'cube-20mm'),
    'inch-cube.stl': binaryStl(boxTriangles([0, 0, 0], [1, 1, 1]), 'binary inch cube 1 x 1 x 1'),
    'open-box.stl': binaryStl(openBox, 'binary open box: 20 mm cube without its top face'),
    'bowtie.stl': binaryStl(bowtie, 'binary bowtie: two 10 mm cubes sharing one edge'),
    'cube-reversed-winding.stl': binaryStl(reversed(cube), 'binary 20 mm cube, every triangle wound inward'),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  for (const [name, bytes] of Object.entries(buildFixtures())) {
    writeFileSync(`${dir}${name}`, bytes);
    console.log(`wrote ${name} (${bytes.length} bytes)`);
  }
}
