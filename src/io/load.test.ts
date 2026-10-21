/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadStl, progressFraction, progressText, type FileLike, type LoadProgress, type ParseWorker } from './load';
import { handleParseRequest, type ParseRequest, type ParseResponse } from './parse';
import { MAX_STL_BYTES, StlError } from './sniff';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url)));

function fileOf(name: string, bytes: Uint8Array): FileLike {
  return { name, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer };
}

/** Runs the worker body on a later tick, as a real worker would. */
class FakeWorker implements ParseWorker {
  onmessage: ((event: MessageEvent<ParseResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  transferred: Transferable[] = [];
  constructor(private readonly crash = false) {}
  postMessage(message: ParseRequest, transfer: Transferable[]): void {
    this.transferred = transfer;
    setTimeout(() => {
      if (this.terminated) return;
      if (this.crash) {
        this.onerror?.({ message: 'boom', preventDefault() {} } as ErrorEvent);
        return;
      }
      handleParseRequest(message, (msg) => this.onmessage?.({ data: msg } as MessageEvent<ParseResponse>));
    }, 0);
  }
  terminate(): void {
    this.terminated = true;
  }
}

describe('loadStl', () => {
  it('parses the binary cube in the worker and terminates it after', async () => {
    const worker = new FakeWorker();
    const stl = await loadStl(fileOf('cube.stl', fixture('cube-20mm-binary.stl')), { createWorker: () => worker });
    expect(stl).toMatchObject({ name: 'cube.stl', bytes: 684, format: 'stl-bin', triangles: 12 });
    expect(stl.positions).toHaveLength(108);
    expect(stl.inspection!.stats).toMatchObject({ triangles: 12, vertices: 8, watertight: true, size: [20, 20, 20] });
    expect(worker.transferred).toHaveLength(1);
    expect(worker.terminated).toBe(true);
  });

  it('parses the ASCII cube to the same positions', async () => {
    const bin = await loadStl(fileOf('a', fixture('cube-20mm-binary.stl')), { createWorker: () => new FakeWorker() });
    const ascii = await loadStl(fileOf('b', fixture('cube-20mm-ascii.stl')), { createWorker: () => new FakeWorker() });
    expect(ascii.format).toBe('stl-ascii');
    expect(Array.from(ascii.positions)).toEqual(Array.from(bin.positions));
  });

  it('rejects a truncated file with the file name and the reason', async () => {
    const worker = new FakeWorker();
    const load = loadStl(fileOf('broken.stl', fixture('cube-20mm-binary.stl').slice(0, 400)), { createWorker: () => worker });
    await expect(load).rejects.toThrow(StlError);
    await expect(load).rejects.toThrow(/^broken\.stl: The binary STL is truncated/);
    expect(worker.terminated).toBe(true);
  });

  it('refuses empty and oversized files before reading them or starting a worker', async () => {
    let read = 0;
    let started = 0;
    const createWorker = (): ParseWorker => {
      started++;
      return new FakeWorker();
    };
    const huge: FileLike = { name: 'huge.stl', size: MAX_STL_BYTES + 1, arrayBuffer: async () => (read++, new ArrayBuffer(0)) };
    const empty: FileLike = { name: 'empty.stl', size: 0, arrayBuffer: async () => (read++, new ArrayBuffer(0)) };
    await expect(loadStl(huge, { createWorker })).rejects.toThrow(/huge\.stl is 500\.0 MB; files over 500\.0 MB are refused/);
    await expect(loadStl(empty, { createWorker })).rejects.toThrow(/empty\.stl is empty/);
    expect([read, started]).toEqual([0, 0]);
  });

  it('turns a worker crash into a readable error', async () => {
    const worker = new FakeWorker(true);
    await expect(loadStl(fileOf('c.stl', fixture('inch-cube.stl')), { createWorker: () => worker })).rejects.toThrow(
      /c\.stl: the parser stopped unexpectedly \(boom\)/,
    );
    expect(worker.terminated).toBe(true);
  });

  it('an abort terminates the worker and rejects', async () => {
    const worker = new FakeWorker();
    const controller = new AbortController();
    const load = loadStl(fileOf('c.stl', fixture('inch-cube.stl')), { createWorker: () => worker, signal: controller.signal });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(load).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('loadStl: 3MF, progress, the size limit for every format', () => {
  it('loads the 3MF cube with the unit it states and the timings, and reports each phase in order', async () => {
    const seen: LoadProgress[] = [];
    const m = await loadStl(fileOf('cube.3mf', fixture('cube-1in.3mf')), { createWorker: () => new FakeWorker(), onProgress: (p) => seen.push(p) });
    expect(m).toMatchObject({ format: '3mf', triangles: 12, units: { unit: 'inch', mmPerUnit: 25.4 } });
    expect(m.parseMs).toBeGreaterThanOrEqual(0);
    expect(m.inspectMs).toBeGreaterThanOrEqual(0);
    expect(seen.map((p) => p.phase)).toEqual(['read', 'inspect']);
    const stl = await loadStl(fileOf('cube.stl', fixture('cube-20mm-binary.stl')), { createWorker: () => new FakeWorker() });
    expect(stl.units).toBeNull();
  });

  it('refuses a 3MF over 500 MB by name, before reading it', async () => {
    let read = 0;
    const big: FileLike = { name: 'big.3mf', size: 600 * 1024 * 1024, arrayBuffer: async () => (read++, new ArrayBuffer(0)) };
    await expect(loadStl(big, { createWorker: () => new FakeWorker() })).rejects.toThrow(/^big\.3mf is 600\.0 MB; files over 500\.0 MB are refused\.$/);
    expect(read).toBe(0);
  });

  it('progressText and progressFraction for each phase', () => {
    expect(progressText('a.stl', { phase: 'read', done: 0, total: 100 })).toBe('Reading a.stl…');
    expect(progressText('a.stl', { phase: 'parse', done: 500_000, total: 2_000_000 })).toBe('Reading a.stl… 500,000 of 2,000,000 triangles (25%)');
    expect(progressText('a.stl', { phase: 'parse', done: 250_000, total: -1 })).toBe('Reading a.stl… 250,000 triangles');
    expect(progressText('a.stl', { phase: 'inspect', done: 0, total: 2_000_000 })).toBe('Checking the mesh of a.stl (2,000,000 triangles)…');
    expect(progressFraction({ phase: 'read', done: 0, total: 9 })).toBe(0);
    expect(progressFraction({ phase: 'parse', done: 1, total: 4 })).toBe(0.25);
    expect(progressFraction({ phase: 'parse', done: 9, total: 4 })).toBe(1);
    expect(progressFraction({ phase: 'parse', done: 9, total: -1 })).toBeNull();
    expect(progressFraction({ phase: 'parse', done: 0, total: 0 })).toBeNull();
    expect(progressFraction({ phase: 'inspect', done: 0, total: 4 })).toBeNull();
  });
});
