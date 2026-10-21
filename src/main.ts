import { loadStl } from './io/load';
import { StlError } from './io/sniff';
import { DEFAULT_PROFILE } from './state/profiles';
import { installDropzone } from './ui/dropzone';
import { buildPartMesh, type PartMesh } from './view/partMesh';
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

const panel = {
  name: byId<HTMLOutputElement>('part-name'),
  format: byId<HTMLOutputElement>('part-format'),
  triangles: byId<HTMLOutputElement>('part-triangles'),
  status: byId<HTMLParagraphElement>('load-status'),
};

let part: PartMesh | null = null;
let pending: AbortController | null = null;

function setStatus(text: string, isError = false): void {
  panel.status.textContent = text;
  panel.status.classList.toggle('error', isError);
  panel.status.setAttribute('role', isError ? 'alert' : 'status');
}

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
    const next = buildPartMesh(stl.positions);
    part?.dispose();
    part = next;
    machine.scene.add(next.object);
    viewport.requestRender();
    panel.name.value = stl.name;
    panel.format.value = stl.format === 'stl-bin' ? 'binary STL' : 'ASCII STL';
    panel.triangles.value = stl.triangles.toLocaleString('en-US');
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
  };
}
