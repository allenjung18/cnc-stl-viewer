/**
 * Decides whether a buffer is a binary or an ASCII STL before anything parses
 * it, so a bad file gives a readable error instead of an empty scene.
 *
 * Pure TypeScript on bytes: no DOM, no three.js. It runs in Node tests and in
 * the parse worker unchanged.
 */

export type StlFormat = 'stl-bin' | 'stl-ascii';

/** Larger files are refused before they are read (plan: Workers and large files). */
export const MAX_STL_BYTES = 500 * 1024 * 1024;

const HEADER_BYTES = 80;
const BINARY_PREAMBLE = 84;
const BINARY_TRIANGLE = 50;
/** How far into the file the text test looks. */
const TEXT_PROBE = 1024;
/** How far back from the end the ASCII completeness test looks. */
const TAIL_PROBE = 512;

/** A file the viewer cannot read; `message` is written for the person who dropped it. */
export class StlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StlError';
  }
}

export type SniffResult =
  | { readonly format: 'stl-bin'; readonly triangles: number }
  | { readonly format: 'stl-ascii' };

function asBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/** Expected byte length of a binary STL with `n` triangles. */
export function binaryLength(n: number): number {
  return BINARY_PREAMBLE + BINARY_TRIANGLE * n;
}

function startsWithSolid(bytes: Uint8Array): boolean {
  let i = 0;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  const word = String.fromCharCode(...bytes.subarray(i, i + 5)).toLowerCase();
  if (word !== 'solid') return false;
  const next = bytes[i + 5];
  return next === undefined || next === 0x20 || next === 0x09 || next === 0x0a || next === 0x0d;
}

/** True when the first bytes hold no NUL or control byte other than tab, CR and LF. */
function looksLikeText(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, TEXT_PROBE);
  for (let i = 0; i < end; i++) {
    const b = bytes[i]!;
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return false;
    if (b === 0x7f) return false;
  }
  return true;
}

/** The last non-blank line of the file starts with `endsolid`. */
function endsWithEndsolid(bytes: Uint8Array): boolean {
  const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - TAIL_PROBE)));
  const lines = tail.trimEnd().split(/\r?\n|\r/);
  const last = lines[lines.length - 1]?.trim().toLowerCase() ?? '';
  return last === 'endsolid' || last.startsWith('endsolid ') || last.startsWith('endsolid\t');
}

/**
 * Binary when the triangle count in the header accounts for the file size
 * exactly (`84 + 50·n === byteLength`), even if the header starts with "solid";
 * ASCII when the file starts with `solid`, reads as text, and ends with an
 * `endsolid` line. Anything else throws a StlError that says what is wrong.
 */
export function sniffStl(data: ArrayBuffer | Uint8Array): SniffResult {
  const bytes = asBytes(data);
  const size = bytes.length;
  if (size === 0) throw new StlError('The file is empty.');
  if (size > MAX_STL_BYTES) {
    throw new StlError(`The file is ${formatBytes(size)}; files over ${formatBytes(MAX_STL_BYTES)} are refused.`);
  }

  const count = size >= BINARY_PREAMBLE ? new DataView(bytes.buffer, bytes.byteOffset, size).getUint32(HEADER_BYTES, true) : -1;
  if (count >= 0 && binaryLength(count) === size) {
    if (count === 0) throw new StlError('The STL holds no triangles.');
    return { format: 'stl-bin', triangles: count };
  }

  if (startsWithSolid(bytes) && looksLikeText(bytes)) {
    if (!endsWithEndsolid(bytes)) {
      throw new StlError('The ASCII STL is truncated: it does not end with an "endsolid" line.');
    }
    return { format: 'stl-ascii' };
  }

  if (size < BINARY_PREAMBLE) {
    throw new StlError(`The file is ${size} bytes: too short to be an STL (a binary STL needs at least 84).`);
  }
  const expected = binaryLength(count);
  if (expected > size) {
    throw new StlError(
      `The binary STL is truncated: its header promises ${count} triangles (${formatBytes(expected)}) but the file is ${formatBytes(size)}.`,
    );
  }
  throw new StlError(
    `The binary STL has ${size - expected} unexpected bytes after its last triangle (header: ${count} triangles); it may be corrupt.`,
  );
}

/** Human-readable byte size: B, kB, MB (powers of 1024). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
