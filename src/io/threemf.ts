/**
 * 3MF -> the same flat triangle soup as an STL, plus the unit the file states.
 *
 * A 3MF is a ZIP package. Its root model part (named by `_rels/.rels`, usually
 * `3D/3dmodel.model`) is XML: `<model unit="...">` holds mesh objects (indexed
 * vertices and triangles) and component objects (other objects under a
 * transform), and `<build>` lists the items to make. Every build item is
 * expanded, its transforms applied, into one soup in the file's units.
 *
 * No DOMParser (the worker has none): the model is scanned tag by tag, which
 * is all the core spec's mesh needs. Extensions are ignored, except an object
 * in another model part (the production extension), which is refused by name.
 *
 * Pure TypeScript on bytes; runs in the parse worker and in Node tests.
 */
import { unzipSync } from 'fflate';
import { formatBytes, MAX_STL_BYTES, StlError } from './sniff';

/** The units a 3MF may state (3MF core spec, `ST_Unit`), and mm per unit. */
export const THREEMF_UNITS = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
} as const;

export type ThreeMfUnit = keyof typeof THREEMF_UNITS;

export interface Parsed3mf {
  readonly triangles: number;
  /** x, y, z per vertex, three vertices per triangle, in the file's unit, build transforms applied. */
  readonly positions: Float32Array;
  readonly unit: ThreeMfUnit;
  /** The file's unit -> mm. */
  readonly mmPerUnit: number;
}

/** The unpacked model is read as one string; past this it is refused, like an STL over the size limit. */
export const MAX_3MF_MODEL_BYTES = MAX_STL_BYTES;

const MODEL_REL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
const DEFAULT_MODEL = '3D/3dmodel.model';
/** Components nested deeper than this are taken for a loop. */
const MAX_DEPTH = 32;

/** "PK\x03\x04": every ZIP starts with a local file header. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** A 3×4 affine transform, 3MF order: m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32 (row vector · M). */
type Affine = readonly number[];
const IDENTITY: Affine = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function parseTransform(text: string | undefined, where: string): Affine {
  if (text === undefined) return IDENTITY;
  const parts = text.trim().split(/\s+/).map(Number);
  if (parts.length !== 12 || !parts.every(Number.isFinite)) {
    throw new StlError(`The 3MF has a transform that is not 12 numbers (${where}): "${text.slice(0, 80)}".`);
  }
  return parts;
}

/** a then b: p · a · b. */
function compose(a: Affine, b: Affine): Affine {
  const out = new Array<number>(12);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      out[3 * r + c] = a[3 * r]! * b[c]! + a[3 * r + 1]! * b[3 + c]! + a[3 * r + 2]! * b[6 + c]! + (r === 3 ? b[9 + c]! : 0);
    }
  }
  return out;
}

const ATTR = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
function attributes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(ATTR)) out[m[1]!] = m[2] ?? m[3] ?? '';
  return out;
}

/** The local name of a tag, without any namespace prefix. */
const local = (name: string): string => name.slice(name.indexOf(':') + 1);

interface MeshObject {
  readonly kind: 'mesh';
  readonly vertices: Float64Array;
  readonly triangles: Uint32Array;
}
interface ComponentsObject {
  readonly kind: 'components';
  readonly parts: { readonly id: string; readonly transform: Affine }[];
}
type ModelObject = (MeshObject | ComponentsObject) & { readonly type: string };

/** Picks the root model part from the package relationships, else the usual name. */
function rootModelPath(files: Record<string, Uint8Array>): string {
  const rels = files['_rels/.rels'];
  if (rels) {
    const text = new TextDecoder().decode(rels);
    for (const m of text.matchAll(/<(?:[\w.-]+:)?Relationship\b([^>]*)>/g)) {
      const a = attributes(m[1]!);
      if (a.Type === MODEL_REL && a.Target) return a.Target.replace(/^\//, '');
    }
  }
  return DEFAULT_MODEL;
}

export function parse3mf(bytes: Uint8Array, onProgress?: (done: number, total: number) => void): Parsed3mf {
  let files: Record<string, Uint8Array>;
  let modelPath = DEFAULT_MODEL;
  try {
    // Only the relationships and the model part are unpacked; textures and thumbnails stay packed.
    const rels = unzipSync(bytes, { filter: (f) => f.name === '_rels/.rels' });
    modelPath = rootModelPath(rels);
    files = unzipSync(bytes, {
      filter: (f) => {
        if (f.name !== modelPath) return false;
        if (f.originalSize > MAX_3MF_MODEL_BYTES) {
          throw new StlError(
            `The 3MF's model is ${formatBytes(f.originalSize)} unpacked; models over ${formatBytes(MAX_3MF_MODEL_BYTES)} are refused.`,
          );
        }
        return true;
      },
    });
  } catch (e) {
    if (e instanceof StlError) throw e;
    throw new StlError(`The 3MF package could not be unpacked (${e instanceof Error ? e.message : String(e)}); it may be corrupt.`);
  }
  const model = files[modelPath];
  if (!model) throw new StlError(`The file is a ZIP but holds no 3D model (${modelPath}): it is not a 3MF.`);
  return parseModelXml(new TextDecoder().decode(model), onProgress);
}

const TAG = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/g;
const NUMBER = (s: string | undefined): number => (s === undefined || s.trim() === '' ? NaN : Number(s));
// One attribute each; `\s` before the name so `v1` never matches inside another name.
const attr = (n: string): RegExp => new RegExp(`(?:^|\\s)${n}\\s*=\\s*["']([^"']*)`);
const VX = attr('x'), VY = attr('y'), VZ = attr('z');
const V1 = attr('v1'), V2 = attr('v2'), V3 = attr('v3');
/** The soup is at most as large as the biggest STL the viewer reads. */
export const MAX_3MF_TRIANGLES = Math.floor(MAX_STL_BYTES / 50);

/** The model part's XML -> the soup. Exported for tests. */
export function parseModelXml(xml: string, onProgress?: (done: number, total: number) => void): Parsed3mf {
  let unit: ThreeMfUnit = 'millimeter';
  let sawModel = false;
  const objects = new Map<string, ModelObject>();
  const build: { id: string; transform: Affine }[] = [];

  // Object being read: its id and type, and its mesh or components so far.
  let current: { id: string; type: string } | null = null;
  let verts: number[] = [];
  let tris: number[] = [];
  let parts: { id: string; transform: Affine }[] = [];
  let inBuild = false;
  let hasMesh = false;

  for (const m of xml.matchAll(TAG)) {
    const closing = m[1] === '/';
    const name = local(m[2]!);
    if (name === 'vertex' && !closing) {
      const body = m[3]!;
      const x = NUMBER(VX.exec(body)?.[1]);
      const y = NUMBER(VY.exec(body)?.[1]);
      const z = NUMBER(VZ.exec(body)?.[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new StlError(`Vertex ${verts.length / 3 + 1} of object ${current?.id ?? '?'} has a coordinate that is not a number.`);
      }
      verts.push(x, y, z);
      continue;
    }
    if (name === 'triangle' && !closing) {
      const body = m[3]!;
      tris.push(NUMBER(V1.exec(body)?.[1]), NUMBER(V2.exec(body)?.[1]), NUMBER(V3.exec(body)?.[1]));
      continue;
    }
    if (closing) {
      if (name === 'object' && current) {
        objects.set(current.id, finishObject(current, hasMesh, verts, tris, parts));
        current = null;
      } else if (name === 'build') inBuild = false;
      continue;
    }
    const a = attributes(m[3]!);
    const selfClosing = m[4] === '/';
    if (name === 'model') {
      sawModel = true;
      const u = a.unit ?? 'millimeter';
      if (!(u in THREEMF_UNITS)) throw new StlError(`The 3MF states a unit this viewer does not know: "${u}".`);
      unit = u as ThreeMfUnit;
    } else if (name === 'object') {
      if (a.id === undefined) throw new StlError('The 3MF has an object without an id.');
      current = { id: a.id, type: a.type ?? 'model' };
      verts = [];
      tris = [];
      parts = [];
      hasMesh = false;
      if (selfClosing) {
        objects.set(current.id, finishObject(current, hasMesh, verts, tris, parts));
        current = null;
      }
    } else if (name === 'mesh') {
      hasMesh = true;
    } else if (name === 'component' && current) {
      if (Object.keys(a).some((k) => local(k) === 'path')) {
        throw new StlError('The 3MF keeps its objects in other model parts (the production extension); this viewer reads single-part 3MF files only.');
      }
      if (a.objectid === undefined) throw new StlError(`A component of object ${current.id} names no object.`);
      parts.push({ id: a.objectid, transform: parseTransform(a.transform, `component of object ${current.id}`) });
    } else if (name === 'build') {
      inBuild = !selfClosing;
    } else if (name === 'item' && inBuild) {
      if (Object.keys(a).some((k) => local(k) === 'path')) {
        throw new StlError('The 3MF builds objects from other model parts (the production extension); this viewer reads single-part 3MF files only.');
      }
      if (a.objectid === undefined) throw new StlError('A build item of the 3MF names no object.');
      build.push({ id: a.objectid, transform: parseTransform(a.transform, `build item ${a.objectid}`) });
    }
  }
  if (!sawModel) throw new StlError('The 3MF model part has no <model> element: it is not a 3MF.');
  if (build.length === 0) throw new StlError('The 3MF builds nothing: its <build> lists no items.');

  // Count first, so the soup is allocated once (memoised: one object may be used many times).
  const counts = new Map<string, number>();
  const countOf = (id: string, depth: number): number => {
    const known = counts.get(id);
    if (known !== undefined) return known;
    const o = lookup(objects, id, depth);
    const n =
      o.type === 'support' || o.type === 'other'
        ? 0
        : o.kind === 'mesh'
          ? o.triangles.length / 3
          : o.parts.reduce((sum, p) => sum + countOf(p.id, depth + 1), 0);
    counts.set(id, n);
    return n;
  };
  const total = build.reduce((n, item) => n + countOf(item.id, 0), 0);
  if (total === 0) throw new StlError('The 3MF holds no triangles to build (only supports, or empty meshes).');
  if (total > MAX_3MF_TRIANGLES) {
    throw new StlError(
      `The 3MF builds ${total.toLocaleString('en-US')} triangles; more than ${MAX_3MF_TRIANGLES.toLocaleString('en-US')} (a ${formatBytes(MAX_STL_BYTES)} STL) are refused.`,
    );
  }

  const positions = new Float32Array(total * 9);
  let out = 0;
  let done = 0;
  const emit = (id: string, t: Affine, depth: number): void => {
    if (counts.get(id) === 0) return; // nothing to build under it: never walked
    const o = lookup(objects, id, depth);
    if (o.kind === 'components') {
      for (const p of o.parts) emit(p.id, compose(p.transform, t), depth + 1);
      return;
    }
    const v = o.vertices;
    const tr = o.triangles;
    for (let i = 0; i < tr.length; i++) {
      const k = 3 * tr[i]!;
      const x = v[k]!, y = v[k + 1]!, z = v[k + 2]!;
      const px = x * t[0]! + y * t[3]! + z * t[6]! + t[9]!;
      const py = x * t[1]! + y * t[4]! + z * t[7]! + t[10]!;
      const pz = x * t[2]! + y * t[5]! + z * t[8]! + t[11]!;
      if (!Number.isFinite(Math.fround(px)) || !Number.isFinite(Math.fround(py)) || !Number.isFinite(Math.fround(pz))) {
        throw new StlError(`Object ${id} has a vertex too large to store once transformed.`);
      }
      positions[out++] = px;
      positions[out++] = py;
      positions[out++] = pz;
      if ((i + 1) % 3 === 0) {
        done++;
        if (onProgress && done % 250_000 === 0) onProgress(done, total);
      }
    }
  };
  for (const item of build) emit(item.id, item.transform, 0);
  return { triangles: total, positions, unit, mmPerUnit: THREEMF_UNITS[unit] };
}

function lookup(objects: Map<string, ModelObject>, id: string, depth: number): ModelObject {
  if (depth > MAX_DEPTH) throw new StlError(`The 3MF's components nest more than ${MAX_DEPTH} deep (a loop at object ${id}?).`);
  const o = objects.get(id);
  if (!o) throw new StlError(`The 3MF refers to object ${id}, which it does not define.`);
  return o;
}

function finishObject(
  current: { id: string; type: string },
  hasMesh: boolean,
  verts: number[],
  tris: number[],
  parts: { id: string; transform: Affine }[],
): ModelObject {
  if (!hasMesh) return { kind: 'components', type: current.type, parts };
  const nv = verts.length / 3;
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i]!;
    if (!(Number.isInteger(t) && t >= 0 && t < nv)) {
      throw new StlError(`Triangle ${Math.floor(i / 3) + 1} of object ${current.id} uses vertex ${Number.isNaN(t) ? '(missing)' : t}, but the object has ${nv}.`);
    }
  }
  return { kind: 'mesh', type: current.type, vertices: Float64Array.from(verts), triangles: Uint32Array.from(tris) };
}
