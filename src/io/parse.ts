/**
 * STL bytes -> a flat triangle soup: `positions` holds x, y, z for each of the
 * three vertices of every triangle, in file units and file axes, unwelded.
 * Facet normals in the file are ignored (they are often wrong); the viewer
 * derives normals from the winding.
 *
 * Pure TypeScript on bytes, shared by the parse worker and the Node tests.
 */
import { inspectMesh } from '../geom/stats';
import type { MeshInspection } from '../state/model';
import { formatBytes, MAX_STL_BYTES, StlError, sniffStl, type MeshFormat, type StlFormat } from './sniff';
import { isZip, parse3mf, type ThreeMfUnit } from './threemf';

export interface ParsedStl {
  readonly format: StlFormat;
  readonly triangles: number;
  readonly positions: Float32Array;
}

/** Called with (triangles done, triangles expected or -1 when unknown, as for ASCII). */
export type ProgressFn = (done: number, total: number) => void;

/** A progress callback fires every this many triangles. */
export const PROGRESS_EVERY = 250_000;

export function parseStl(data: ArrayBuffer | Uint8Array, onProgress?: ProgressFn): ParsedStl {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const sniff = sniffStl(bytes);
  const positions = sniff.format === 'stl-bin' ? parseBinary(bytes, sniff.triangles, onProgress) : parseAscii(bytes, onProgress);
  return { format: sniff.format, triangles: positions.length / 9, positions };
}

/** The unit a file states (3MF does; STL never). */
export interface FileUnits {
  readonly unit: ThreeMfUnit;
  /** The file's unit -> mm. */
  readonly mmPerUnit: number;
}

export interface ParsedMesh {
  readonly format: MeshFormat;
  readonly triangles: number;
  /** As for ParsedStl: file units, file axes (a 3MF's build transforms applied). */
  readonly positions: Float32Array;
  /** null for STL, which carries no units. */
  readonly units: FileUnits | null;
}

/** STL or 3MF, told apart by the bytes (a 3MF is a ZIP), never by the file name. */
export function parseMesh(data: ArrayBuffer | Uint8Array, onProgress?: ProgressFn): ParsedMesh {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length > MAX_STL_BYTES) {
    throw new StlError(`The file is ${formatBytes(bytes.length)}; files over ${formatBytes(MAX_STL_BYTES)} are refused.`);
  }
  if (isZip(bytes)) {
    const m = parse3mf(bytes, onProgress);
    return { format: '3mf', triangles: m.triangles, positions: m.positions, units: { unit: m.unit, mmPerUnit: m.mmPerUnit } };
  }
  return { ...parseStl(bytes, onProgress), units: null };
}

function parseBinary(bytes: Uint8Array, triangles: number, onProgress?: ProgressFn): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const positions = new Float32Array(triangles * 9);
  let out = 0;
  for (let t = 0; t < triangles; t++) {
    const base = 84 + 50 * t + 12; // skip the facet normal
    for (let k = 0; k < 9; k++) {
      const v = view.getFloat32(base + 4 * k, true);
      if (!Number.isFinite(v)) throw new StlError(`Triangle ${t + 1} has a coordinate that is not a finite number.`);
      positions[out++] = v;
    }
    if (onProgress && (t + 1) % PROGRESS_EVERY === 0) onProgress(t + 1, triangles);
  }
  return positions;
}

function isSpace(b: number): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0b || b === 0x0c;
}

/**
 * Walks the text token by token. A facet is `facet ... outer loop vertex×3
 * endloop endfacet`; only the counts and the vertex numbers are checked, so
 * extra tokens some exporters write (colour, names) do not break it.
 */
function parseAscii(bytes: Uint8Array, onProgress?: ProgressFn): Float32Array {
  let capacity = 1024;
  let positions = new Float32Array(capacity);
  let count = 0;
  let facets = 0;
  let endfacets = 0;
  let solids = 0;
  let endsolids = 0;

  const n = bytes.length;
  let i = 0;
  const nextToken = (): string | null => {
    while (i < n && isSpace(bytes[i]!)) i++;
    if (i >= n) return null;
    const start = i;
    while (i < n && !isSpace(bytes[i]!)) i++;
    let s = '';
    for (let k = start; k < i; k++) s += String.fromCharCode(bytes[k]!);
    return s;
  };
  const skipLine = (): void => {
    while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
  };

  for (let tok = nextToken(); tok !== null; tok = nextToken()) {
    const word = tok.toLowerCase();
    if (word === 'vertex') {
      if (count + 3 > capacity) {
        capacity *= 2; // the file is at most MAX_STL_BYTES (sniff), which bounds this
        const grown = new Float32Array(capacity);
        grown.set(positions);
        positions = grown;
      }
      for (let k = 0; k < 3; k++) {
        const t = nextToken();
        const v = t === null ? NaN : Number(t);
        if (t === null || t === '' || !Number.isFinite(v)) {
          throw new StlError(`Vertex ${count / 3 + 1} has a coordinate that is not a number: "${t ?? 'end of file'}".`);
        }
        // Stored as float32: a finite double such as 1e39 would become Infinity.
        if (!Number.isFinite(Math.fround(v))) {
          throw new StlError(`Vertex ${count / 3 + 1} has a coordinate too large to store: "${t}".`);
        }
        positions[count++] = v;
      }
    } else if (word === 'facet') {
      facets++;
      if (facets !== endfacets + 1) throw new StlError(`Facet ${facets} starts before facet ${facets - 1} has ended.`);
      if (count !== (facets - 1) * 9) throw new StlError(`Facet ${facets - 1} does not have exactly 3 vertices.`);
      skipLine(); // "normal nx ny nz"
      if (onProgress && facets % PROGRESS_EVERY === 0) onProgress(facets, -1);
    } else if (word === 'endfacet') {
      endfacets++;
      if (endfacets !== facets) throw new StlError(`"endfacet" ${endfacets} has no matching "facet".`);
      if (count !== facets * 9) throw new StlError(`Facet ${facets} does not have exactly 3 vertices.`);
    } else if (word === 'solid') {
      solids++;
      skipLine(); // the solid's name may hold any text
    } else if (word === 'endsolid') {
      endsolids++;
      skipLine();
    }
  }

  if (solids === 0 || endsolids !== solids) throw new StlError('The ASCII STL is truncated: "solid" and "endsolid" do not match.');
  if (facets !== endfacets) throw new StlError(`The ASCII STL is truncated inside facet ${facets}.`);
  if (count !== facets * 9) throw new StlError('The ASCII STL has vertices outside any facet.');
  if (facets === 0) throw new StlError('The STL holds no triangles.');
  return positions.slice(0, count);
}

/** Main thread -> worker: one file to parse. The buffer is transferred, not copied. */
export interface ParseRequest {
  readonly id: number;
  readonly buffer: ArrayBuffer;
}

/** Worker -> main thread. `positions` and the edge segments on `done` are transferred, not copied. */
export type ParseResponse =
  | {
      readonly id: number;
      readonly type: 'progress';
      /** Reading the triangles, then checking the mesh (welding and the edge census). */
      readonly phase: 'parse' | 'inspect';
      readonly done: number;
      /** -1 while unknown (an ASCII STL). */
      readonly total: number;
    }
  | {
      readonly id: number;
      readonly type: 'done';
      readonly format: MeshFormat;
      readonly triangles: number;
      readonly positions: Float32Array;
      readonly units: FileUnits | null;
      /** Milliseconds spent reading the triangles and inspecting them, in the worker. */
      readonly parseMs: number;
      readonly inspectMs: number;
      /** null when the inspector failed; the part still loads and `inspectionError` says why. */
      readonly inspection: MeshInspection | null;
      readonly inspectionError?: string;
    }
  | { readonly id: number; readonly type: 'error'; readonly message: string };

/** What the worker does with one request; separate from the worker shell so Node tests can run it. */
export function handleParseRequest(
  req: ParseRequest,
  post: (msg: ParseResponse, transfer: Transferable[]) => void,
  inspect: (positions: Float32Array) => MeshInspection = inspectMesh,
): void {
  try {
    const t0 = performance.now();
    const parsed = parseMesh(req.buffer, (done, total) => post({ id: req.id, type: 'progress', phase: 'parse', done, total }, []));
    const t1 = performance.now();
    post({ id: req.id, type: 'progress', phase: 'inspect', done: 0, total: parsed.triangles }, []);
    // The inspector runs here too, off the main thread: welding and the edge census are the slow part.
    // A file that parsed still loads when the inspector fails (out of memory on a huge mesh, say).
    let inspection: MeshInspection | null = null;
    let inspectionError: string | undefined;
    try {
      inspection = inspect(parsed.positions);
    } catch (e) {
      inspectionError = e instanceof Error ? e.message : String(e);
    }
    const base = {
      id: req.id,
      type: 'done',
      format: parsed.format,
      triangles: parsed.triangles,
      positions: parsed.positions,
      units: parsed.units,
      parseMs: t1 - t0,
      inspectMs: performance.now() - t1,
    } as const;
    const transfer: Transferable[] = [parsed.positions.buffer];
    if (inspection) {
      transfer.push(inspection.openEdgeSegments.buffer, inspection.nonManifoldEdgeSegments.buffer);
      if (inspection.featureEdgeSegments) transfer.push(inspection.featureEdgeSegments.buffer);
    }
    post(inspection ? { ...base, inspection } : { ...base, inspection: null, inspectionError: inspectionError ?? 'unknown error' }, transfer);
  } catch (e) {
    const message = e instanceof StlError ? e.message : `The file could not be read: ${e instanceof Error ? e.message : String(e)}`;
    post({ id: req.id, type: 'error', message }, []);
  }
}
