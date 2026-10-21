import { Raycaster, Vector2 } from 'three';
import { checkFit, type FitReport } from './geom/fit';
import {
  IDENTITY,
  layFlat,
  orientCandidates,
  orientStats,
  rankOrientations,
  rotate90,
  type OrientCandidate,
  type RankedOrientation,
} from './geom/orient';
import { scaleStats, unitHint, unitScaleOf, type UnitChoice } from './geom/units';
import { loadStl } from './io/load';
import { StlError, type StlFormat } from './io/sniff';
import type { MachineProfile, MeshStats, Vec3 } from './state/model';
import { browserStorage, loadUnits, saveUnits } from './state/prefs';
import { DEFAULT_PROFILE } from './state/profiles';
import { installDropzone } from './ui/dropzone';
import { InspectorPanel, partRows, uninspectedRows, UnitsBadge, unitsBadge, type PanelRow } from './ui/panel';
import { OrientPanel, orientItems } from './ui/orientPanel';
import { fitRows, fitVerdict, readStockForm, StockPanel, type StockForm } from './ui/stockPanel';
import { buildPartMesh, NON_MANIFOLD_EDGE_COLOR, OPEN_EDGE_COLOR, type PartMesh } from './view/partMesh';
import { buildScene } from './view/scene';
import { buildKeepOutMesh, buildStockMesh } from './view/stockMesh';
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

// The stock, the keep-out box and the WCS origin follow the stock inputs and the part's size in mm.
const stockMesh = buildStockMesh();
const keepOutMesh = buildKeepOutMesh();
machine.scene.add(stockMesh.object, keepOutMesh.object);
let profile: MachineProfile = DEFAULT_PROFILE;
let fit: FitReport | null = null;
const stockPanel = new StockPanel(byId('stock'), () => render());

/** The inspected stats as shown: turned to the part's orientation, then × the units scale. */
function shownStats(scale: number): MeshStats | null {
  return part && fileStats ? scaleStats(orientStats(fileStats, part.orientedBBox), scale) : null;
}

/** The part's size as shown, mm: the box of the part as oriented, × the units scale. */
function partSizeMm(scale: number): Vec3 | null {
  if (!part) return null;
  const size = shownStats(scale)?.size ?? part.orientedSize.map((v) => v * scale);
  return [size[0]!, size[1]!, size[2]!];
}

/** The fit checks for a part of `partSize` (mm) with the current stock inputs. */
function fitFor(form: StockForm & { ok: true }, partSize: Vec3 | null): FitReport {
  return checkFit({ partSize, stock: form.stock, setup: form.setup, profile: { ...DEFAULT_PROFILE, keepOut: form.keepOut } });
}

/** Sizes the stock, runs the fit checks, and draws the stock, the keep-out box, the part placement and the verdict. */
function renderFit(scale: number): void {
  const form = readStockForm(stockPanel.read());
  if (!form.ok) {
    fit = null;
    stockMesh.update({ stockBox: null, wcs: null, failed: false });
    stockPanel.show(fitVerdict(null, form.errors), []);
    return;
  }
  profile = { ...DEFAULT_PROFILE, keepOut: form.keepOut };
  try {
    fit = fitFor(form, partSizeMm(scale));
    keepOutMesh.update(form.keepOut); // drawn only once checkFit has found its corners finite
    part?.setPlacement(fit.partOnBed ?? [0, 0, 0]);
  } catch (e) {
    fit = null;
    stockMesh.update({ stockBox: null, wcs: null, failed: false });
    stockPanel.show(fitVerdict(null, [e instanceof Error ? e.message : String(e)]), []);
    return;
  }
  stockMesh.update({ stockBox: fit.stockBox, wcs: fit.wcs, failed: !fit.fits });
  stockPanel.show(fitVerdict(fit), fitRows(fit));
}

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

// Orientation: quarter turns, lay flat on a picked face, and auto-orient's suggestions (never applied unasked).
/** Auto-orient's candidates for the loaded part, kept so the list re-ranks cheaply when the stock changes. */
let candidates: OrientCandidate[] | null = null;
/** The list as shown, best first; null while it is hidden. */
let ranked: RankedOrientation[] | null = null;
let listShown = false;
let picking = false;

function setRotation(next: Parameters<PartMesh['setRotation']>[0]): void {
  if (!part) return;
  part.setRotation(next);
  setPicking(false);
  render(); // the size, the stock and every fit check follow the new orientation
}

function setPicking(on: boolean, hint?: string): void {
  picking = on && part !== null;
  orientPanel.setPicking(picking, hint);
}

const orientPanel = new OrientPanel(byId('orient'), {
  rotate: (axis) => {
    if (part) setRotation(rotate90(part.rotation, axis));
  },
  reset: () => setRotation(IDENTITY),
  pick: (on) => setPicking(on),
  auto: () => {
    if (!part) return;
    candidates ??= orientCandidates(part.positions);
    listShown = true;
    render();
  },
  apply: (index) => {
    const choice = ranked?.[index];
    if (choice) setRotation(choice.rotation);
  },
});

/** Re-ranks the suggestions with the current stock inputs and units, so each one's fit is current. */
function renderOrient(scale: number): void {
  orientPanel.setEnabled(part !== null);
  if (!part || !listShown || !candidates) {
    ranked = null;
    orientPanel.showList(null);
    return;
  }
  const form = readStockForm(stockPanel.read());
  ranked = rankOrientations(candidates, {
    scale,
    fitOf: form.ok ? (size) => fitFor(form, size) : undefined,
  });
  orientPanel.showList(orientItems(ranked, part.rotation));
}

/** Applies the units choice and the orientation to the mesh, the panel rows and the badge, then re-runs the fit. */
function render(): void {
  const scale = unitScaleOf(units);
  part?.setUnitScale(scale);
  unitsBadgeEl.show(unitsBadge(units, part ? unitHint(part.size, units, DEFAULT_PROFILE.cuttingArea) : null));
  if (shown) {
    const stats = shownStats(scale);
    const rows: PanelRow[] = stats
      ? partRows({ name: shown.name, format: shown.format, stats }, EDGE_COLOURS)
      : uninspectedRows(shown.name, shown.format, shown.triangles, shown.inspectionError ?? 'unknown error');
    panel.show(rows);
  }
  renderFit(scale);
  renderOrient(scale);
  viewport.requestRender();
}
render();

// Lay flat: in pick mode a click (not a drag: that orbits) on the part puts the clicked face down.
const canvas = viewport.renderer.domElement;
const raycaster = new Raycaster();
let down: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
});
canvas.addEventListener('pointerup', (e) => {
  const start = down;
  down = null;
  if (!picking || !part || !start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return;
  const rect = canvas.getBoundingClientRect();
  const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, viewport.camera);
  const hit = part.pickFace(raycaster);
  if (!hit) {
    setPicking(true, 'That missed the part (or hit a degenerate triangle): click a face of the part, or Esc to cancel.');
    return;
  }
  setRotation(layFlat(part.rotation, hit.normal));
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && picking) setPicking(false);
});

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
    candidates = null; // a new part starts as read, with no suggestions until asked
    listShown = false;
    setPicking(false);
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
    stockMesh,
    keepOutMesh,
    /** The last fit report, or null when the inputs are invalid. */
    get fit() {
      return fit;
    },
    get profile() {
      return profile;
    },
    /** Auto-orient's list as shown, best first; null while hidden. */
    get ranked() {
      return ranked;
    },
    get picking() {
      return picking;
    },
  };
}
