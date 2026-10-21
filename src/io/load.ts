/**
 * A dropped or picked file -> a parsed STL, via the parse worker. Size limits
 * are checked before the file is read; every failure is a StlError whose
 * message can be shown as is.
 */
import type { MeshInspection } from '../state/model';
import type { ParseRequest, ParseResponse } from './parse';
import { MAX_STL_BYTES, StlError, formatBytes, type StlFormat } from './sniff';

export interface LoadedStl {
  readonly name: string;
  readonly bytes: number;
  readonly format: StlFormat;
  readonly triangles: number;
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

export interface LoadOptions {
  readonly createWorker?: () => ParseWorker;
  readonly onProgress?: (done: number, total: number) => void;
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
        onProgress?.(msg.done, msg.total);
      } else if (msg.type === 'done') {
        finish();
        resolve({
          name: file.name,
          bytes: file.size,
          format: msg.format,
          triangles: msg.triangles,
          positions: msg.positions,
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
