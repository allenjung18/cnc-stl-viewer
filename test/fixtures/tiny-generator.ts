/// <reference types="node" />
/**
 * Writes the STL and 3MF test fixtures in this folder. The files are committed; run
 * `npm run fixtures` (Node 22.18 or later: it runs this .ts file directly)
 * after changing anything here, and the parse tests check
 * that the committed bytes still match what this file builds.
 *
 * Every coordinate is a small integer, so the ASCII and binary forms of the
 * same shape decode to bit-identical float32 positions.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

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
 * A binary STL of an axis-aligned cube of edge `size` from `min`, each face cut
 * into an n × n grid of two triangles per cell: 12·n² triangles, watertight,
 * outward. Written straight into the bytes (no per-triangle objects), so a
 * 100 MB file builds in well under a second. Used for the large-file tests,
 * which write it at test time; it is never committed.
 */
export function gridCubeStl(n: number, size: number, min: Point = [0, 0, 0]): Uint8Array {
  if (!(Number.isInteger(n) && n >= 1)) throw new RangeError(`grid must be a whole number >= 1, got ${n}`);
  const triangles = 12 * n * n;
  const bytes = new Uint8Array(84 + 50 * triangles);
  const header = `binary grid cube ${n} x ${n} per face, ${triangles} triangles`;
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i) & 0x7f;
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangles, true);
  let at = 84;
  const put = (x: number, y: number, z: number): void => {
    view.setFloat32(at, x, true);
    view.setFloat32(at + 4, y, true);
    view.setFloat32(at + 8, z, true);
    at += 12;
  };
  const step = size / n;
  // Each face: an origin corner, two in-face axes (u then v gives the outward normal), the normal.
  const faces: [Point, Point, Point, Point][] = [];
  const [x0, y0, z0] = min;
  const s = size;
  faces.push([[x0, y0, z0], [0, 1, 0], [1, 0, 0], [0, 0, -1]]); // bottom
  faces.push([[x0, y0, z0 + s], [1, 0, 0], [0, 1, 0], [0, 0, 1]]); // top
  faces.push([[x0, y0, z0], [1, 0, 0], [0, 0, 1], [0, -1, 0]]); // front
  faces.push([[x0, y0 + s, z0], [0, 0, 1], [1, 0, 0], [0, 1, 0]]); // back
  faces.push([[x0, y0, z0], [0, 0, 1], [0, 1, 0], [-1, 0, 0]]); // left
  faces.push([[x0 + s, y0, z0], [0, 1, 0], [0, 0, 1], [1, 0, 0]]); // right
  for (const [o, u, v, nrm] of faces) {
    const p = (i: number, j: number): Point => [
      o[0] + step * (i * u[0] + j * v[0]),
      o[1] + step * (i * u[1] + j * v[1]),
      o[2] + step * (i * u[2] + j * v[2]),
    ];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const a = p(i, j), b = p(i + 1, j), c = p(i + 1, j + 1), d = p(i, j + 1);
        for (const tri of [[a, b, c], [a, c, d]] as const) {
          put(nrm[0], nrm[1], nrm[2]);
          for (const q of tri) put(q[0], q[1], q[2]);
          at += 2;
        }
      }
    }
  }
  return bytes;
}

/** One file in a ZIP: its name, its bytes, and whether to deflate it. */
export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly deflate?: boolean | undefined;
}

/** A ZIP package (no timestamps, so the bytes depend only on the entries). */
export function zip(entries: readonly ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = new TextEncoder().encode(e.name);
    const body = e.deflate ? new Uint8Array(deflateRawSync(e.data)) : e.data;
    const crc = crc32(e.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, e.deflate ? 8 : 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const dir = new Uint8Array(46 + name.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(10, e.deflate ? 8 : 0, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, body.length, true);
    dv.setUint32(24, e.data.length, true);
    dv.setUint16(28, name.length, true);
    dv.setUint32(42, offset, true);
    dir.set(name, 46);
    chunks.push(local, body);
    central.push(dir);
    offset += local.length + body.length;
  }
  const dirSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + dirSize + 22);
  let at = 0;
  for (const c of [...chunks, ...central, end]) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** An indexed mesh: shared vertices, triangles as vertex indices (what a 3MF stores). */
export interface IndexedMesh {
  readonly vertices: readonly Point[];
  readonly triangles: readonly (readonly [number, number, number])[];
}

/** Indexes a triangle soup by exact coordinates, keeping the triangles' order and winding. */
export function indexed(tris: readonly Triangle[]): IndexedMesh {
  const vertices: Point[] = [];
  const seen = new Map<string, number>();
  const at = (p: Point): number => {
    const key = p.join(',');
    let i = seen.get(key);
    if (i === undefined) {
      i = vertices.length;
      vertices.push(p);
      seen.set(key, i);
    }
    return i;
  };
  return { vertices, triangles: tris.map(([a, b, c]) => [at(a), at(b), at(c)] as const) };
}

/** The XML of a 3MF mesh object. */
export function meshObjectXml(id: number, mesh: IndexedMesh, type = 'model'): string {
  const v = mesh.vertices.map((p) => `      <vertex x="${p[0]}" y="${p[1]}" z="${p[2]}" />`).join('\n');
  const t = mesh.triangles.map(([a, b, c]) => `      <triangle v1="${a}" v2="${b}" v3="${c}" />`).join('\n');
  return `   <object id="${id}" type="${type}">\n    <mesh>\n     <vertices>\n${v}\n     </vertices>\n     <triangles>\n${t}\n     </triangles>\n    </mesh>\n   </object>`;
}

/** A 3MF model part: `<model unit>` with the given objects and build items. */
export function modelXml(unit: string | null, objects: readonly string[], items: readonly string[]): string {
  const unitAttr = unit === null ? '' : ` unit="${unit}"`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<model${unitAttr} xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">`,
    '  <resources>',
    ...objects,
    '  </resources>',
    '  <build>',
    ...items.map((i) => `    ${i}`),
    '  </build>',
    '</model>',
    '',
  ].join('\n');
}

/** A whole 3MF package around one model part (at `3D/3dmodel.model` unless named). */
export function threeMf(model: string, options: { deflate?: boolean; modelPath?: string } = {}): Uint8Array {
  const path = options.modelPath ?? '3D/3dmodel.model';
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  const types =
    '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" /></Types>\n';
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Target="/${path}" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" /></Relationships>\n`;
  return zip([
    { name: '[Content_Types].xml', data: enc(types), deflate: options.deflate },
    { name: '_rels/.rels', data: enc(rels), deflate: options.deflate },
    { name: path, data: enc(model), deflate: options.deflate },
  ]);
}

/**
 * The cube is placed off the origin in file space on purpose: the viewer must
 * move its min corner to the origin, so a test can tell "placed" from "as read".
 */
export const CUBE_MIN: Point = [10, -5, 3];
export const CUBE_SIZE: Point = [20, 20, 20];

export const TALL_BOX_MIN: Point = [5, 7, -3];
export const TALL_BOX_SIZE: Point = [10, 20, 80];

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
    // Too tall for the cutting area as read (80 + 3 mm of allowance > 76); fits lying down.
    'box-10x20x80.stl': binaryStl(boxTriangles(TALL_BOX_MIN, TALL_BOX_SIZE), 'binary box 10 x 20 x 80, off the origin'),
    // The same 20 mm cube as a 3MF that states millimetres; stored, not deflated, so the bytes never depend on zlib.
    'cube-20mm.3mf': threeMf(modelXml('millimeter', [meshObjectXml(1, indexed(cube))], ['<item objectid="1" />'])),
    // A 1 x 1 x 1 cube in a 3MF that states inches: it must read as 25.4 mm with no toggle.
    'cube-1in.3mf': threeMf(modelXml('inch', [meshObjectXml(1, indexed(boxTriangles([0, 0, 0], [1, 1, 1])))], ['<item objectid="1" />'])),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  for (const [name, bytes] of Object.entries(buildFixtures())) {
    writeFileSync(`${dir}${name}`, bytes);
    console.log(`wrote ${name} (${bytes.length} bytes)`);
  }
}
