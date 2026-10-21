import { scaleStats, unitHint, unitScaleOf, type UnitChoice } from './geom/units';
import { loadStl } from './io/load';
import { StlError, type StlFormat } from './io/sniff';
import type { MeshStats } from './state/model';
import { browserStorage, loadUnits, saveUnits } from './state/prefs';
import { DEFAULT_PROFILE } from './state/profiles';
import { installDropzone } from './ui/dropzone';
import { InspectorPanel, partRows, uninspectedRows, UnitsBadge, unitsBadge, type PanelRow } from './ui/panel';
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
/** The loaded part's stats as inspected, file units. */
let fileStats: MeshStats | null = null;
/** What the panel rows are built from; the stats are scaled in `render`. */
let shown: { name: string; format: StlFormat; triangles: number; inspectionError: string | null } | null = null;
let pending: AbortController | null = null;

// STL is unitless: mm unless the user said inches; the choice is kept for the next visit.
const storage = browserStorage();
let units: UnitChoice = loadUnits(storage);

const setStatus = (text: string, isError = false): void => panel.setStatus(text, isError);

const unitsBadgeEl = new UnitsBadge(
  byId('units-value'),
  byId<HTMLButtonElement>('units-toggle'),
  byId('units-hint'),
  () => {
    units = units === 'in' ? 'mm' : 'in';
    saveUnits(storage, units);
    render();
  },
);

/** Applies the units choice to the mesh, the panel rows and the badge. */
function render(): void {
  const scale = unitScaleOf(units);
  part?.setUnitScale(scale);
  unitsBadgeEl.show(unitsBadge(units, part ? unitHint(part.size, units, DEFAULT_PROFILE.cuttingArea) : null));
  if (shown) {
    const rows: PanelRow[] = fileStats
      ? partRows({ name: shown.name, format: shown.format, stats: scaleStats(fileStats, scale) }, EDGE_COLOURS)
      : uninspectedRows(shown.name, shown.format, shown.triangles, shown.inspectionError ?? 'unknown error');
    panel.show(rows);
  }
  viewport.requestRender();
}
render();

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
    fileStats = stl.inspection?.stats ?? null;
    shown = { name: stl.name, format: stl.format, triangles: stl.triangles, inspectionError: stl.inspectionError ?? null };
    render();
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
    /** The stats as shown, mm (after the units scale). */
    get stats() {
      return fileStats ? scaleStats(fileStats, unitScaleOf(units)) : null;
    },
    get fileStats() {
      return fileStats;
    },
    get units() {
      return units;
    },
  };
}
