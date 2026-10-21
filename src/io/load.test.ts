/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadStl, type FileLike, type ParseWorker } from './load';
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
