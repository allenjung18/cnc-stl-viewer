import { loadStl } from './io/load';
import { StlError } from './io/sniff';
import type { MeshStats } from './state/model';
import { DEFAULT_PROFILE } from './state/profiles';
import { installDropzone } from './ui/dropzone';
import { InspectorPanel, partRows, uninspectedRows } from './ui/panel';
import { buildPartMesh, NON_MANIFOLD_EDGE_COLOR, OPEN_EDGE_COLOR, type PartMesh } from './view/partMesh';
import { buildScene } from './view/scene';
import { Viewport } from './view/viewport';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id} element`);
  return el as T;
}

const container = byId('viewport');
const machine = buildScene(DEFAULT_PROFILE);
const viewport = new Viewport(container, machine.scene, machine.bounds.travel);

const panel = new InspectorPanel(byId<HTMLDListElement>('part-info'), byId('load-status'));
const css = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`;
const EDGE_COLOURS = { open: css(OPEN_EDGE_COLOR), nonManifold: css(NON_MANIFOLD_EDGE_COLOR) };

let part: PartMesh | null = null;
let stats: MeshStats | null = null;
let pending: AbortController | null = null;

const setStatus = (text: string, isError = false): void => panel.setStatus(text, isError);

async function open(file: File): Promise<void> {
  pending?.abort();
  const controller = new AbortController();
  pending = controller;
  setStatus(`Reading ${file.name}…`);
  try {
    const stl = await loadStl(file, {
      signal: controller.signal,
      onProgress: (done) => setStatus(`Reading ${file.name}… ${done.toLocaleString()} triangles`),
    });
    const next = buildPartMesh(stl.positions, stl.inspection ?? undefined);
    part?.dispose();
    part = next;
    machine.scene.add(next.object);
    viewport.requestRender();
    panel.show(
      stl.inspection
        ? partRows({ name: stl.name, format: stl.format, stats: stl.inspection.stats }, EDGE_COLOURS)
        : uninspectedRows(stl.name, stl.format, stl.triangles, stl.inspectionError ?? 'unknown error'),
    );
    stats = stl.inspection?.stats ?? null;
    setStatus(`Loaded ${stl.name}.`);
  } catch (e) {
    if (controller.signal.aborted) return; // a newer file replaced this one
    // A failed load keeps the previous part on the bed and says why.
    setStatus(e instanceof StlError ? e.message : `Could not load ${file.name}: ${String(e)}`, true);
  } finally {
    if (pending === controller) pending = null;
  }
}

installDropzone({
  target: window,
  overlay: byId('drop-overlay'),
  input: byId<HTMLInputElement>('file-input'),
  button: byId('open-file'),
  onFile: (file) => void open(file),
  onReject: (message) => setStatus(message, true),
});

if (import.meta.env.DEV) {
  // Read-only handle for the browser smoke tests; not present in a production build.
  (window as unknown as { __stlViewer: unknown }).__stlViewer = {
    machine,
    viewport,
    get part() {
      return part;
    },
    get stats() {
      return stats;
    },
  };
}
