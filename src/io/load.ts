/**
 * A dropped or picked file -> a parsed mesh (STL or 3MF), via the parse
 * worker. Size limits are checked before the file is read; every failure is a
 * StlError whose message can be shown as is.
 */
import type { MeshInspection } from '../state/model';
import type { FileUnits, ParseRequest, ParseResponse } from './parse';
import { MAX_STL_BYTES, StlError, formatBytes, type MeshFormat } from './sniff';

export interface LoadedStl {
  readonly name: string;
  readonly bytes: number;
  readonly format: MeshFormat;
  readonly triangles: number;
  /** The unit the file states (3MF), or null (STL: the user's units choice applies). */
  readonly units: FileUnits | null;
  /** Worker time, ms: reading the triangles, then the inspector. */
  readonly parseMs: number;
  readonly inspectMs: number;
  /** x, y, z per vertex, three vertices per triangle, file units and file axes. */
  readonly positions: Float32Array;
  /** Size, volume, area, counts and the problem edges, computed in the worker; null when that failed. */
  readonly inspection: MeshInspection | null;
  /** Why the inspection failed, when it did. */
  readonly inspectionError?: string;
}

/** The part of a Worker that `loadStl` uses, so tests can stand in for one. */
export interface ParseWorker {
  onmessage: ((event: MessageEvent<ParseResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: ParseRequest, transfer: Transferable[]): void;
  terminate(): void;
}

/** The real worker. Vite bundles `parse.worker.ts` from this exact expression. */
export function createParseWorker(): ParseWorker {
  return new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' }) as unknown as ParseWorker;
}

/** Where a load is: reading the file into memory, reading its triangles, or checking the mesh. */
export interface LoadProgress {
  readonly phase: 'read' | 'parse' | 'inspect';
  readonly done: number;
  /** -1 while unknown. */
  readonly total: number;
}

/** The status line for a load in progress. */
export function progressText(name: string, p: LoadProgress): string {
  if (p.phase === 'read') return `Reading ${name}…`;
  const n = (v: number): string => v.toLocaleString('en-US');
  if (p.phase === 'inspect') return `Checking the mesh of ${name} (${n(p.total)} triangles)…`;
  if (p.total > 0) return `Reading ${name}… ${n(p.done)} of ${n(p.total)} triangles (${Math.floor((100 * p.done) / p.total)}%)`;
  return `Reading ${name}… ${n(p.done)} triangles`;
}

/** 0..1 for a progress bar, or null when the end is unknown (indeterminate). */
export function progressFraction(p: LoadProgress): number | null {
  if (p.phase === 'read') return 0;
  if (p.phase === 'inspect') return null;
  return p.total > 0 ? Math.min(1, Math.max(0, p.done / p.total)) : null;
}

export interface LoadOptions {
  readonly createWorker?: () => ParseWorker;
  readonly onProgress?: (progress: LoadProgress) => void;
  /** Aborting terminates the worker and rejects with an AbortError. */
  readonly signal?: AbortSignal;
}

/** The file fields `loadStl` reads; a DOM File has them all. */
export interface FileLike {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

let nextId = 1;

export async function loadStl(file: FileLike, options: LoadOptions = {}): Promise<LoadedStl> {
  const { createWorker = createParseWorker, onProgress, signal } = options;
  if (file.size === 0) throw new StlError(`${file.name} is empty.`);
  if (file.size > MAX_STL_BYTES) {
    throw new StlError(`${file.name} is ${formatBytes(file.size)}; files over ${formatBytes(MAX_STL_BYTES)} are refused.`);
  }
  signal?.throwIfAborted();
  onProgress?.({ phase: 'read', done: 0, total: file.size });
  const buffer = await file.arrayBuffer();
  signal?.throwIfAborted();

  const id = nextId++;
  const worker = createWorker();
  return new Promise<LoadedStl>((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };
    const onAbort = (): void => {
      finish();
      reject(signal?.reason ?? new DOMException('The load was cancelled.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.id !== id) return;
      if (msg.type === 'progress') {
        onProgress?.({ phase: msg.phase, done: msg.done, total: msg.total });
      } else if (msg.type === 'done') {
        finish();
        resolve({
          name: file.name,
          bytes: file.size,
          format: msg.format,
          triangles: msg.triangles,
          positions: msg.positions,
          units: msg.units,
          parseMs: msg.parseMs,
          inspectMs: msg.inspectMs,
          inspection: msg.inspection,
          ...(msg.inspectionError === undefined ? {} : { inspectionError: msg.inspectionError }),
        });
      } else {
        finish();
        reject(new StlError(`${file.name}: ${msg.message}`));
      }
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      finish();
      reject(new StlError(`${file.name}: the parser stopped unexpectedly (${event.message || 'no detail'}).`));
    };
    worker.postMessage({ id, buffer }, [buffer]);
  });
}
