import { Raycaster, Vector2, Vector3, type Mesh, type Object3D } from 'three';
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
import type { BBox, MachineProfile, MeshStats, Vec3 } from './state/model';
import { browserStorage, loadUnits, saveUnits } from './state/prefs';
import {
  loadProfile,
  parseProfile,
  profileFileName,
  profileToJson,
  sameMachineSize,
  saveProfile,
  type SavedProfile,
} from './state/profiles';
import { installDropzone } from './ui/dropzone';
import { formatNumber, InspectorPanel, partRows, uninspectedRows, UnitsBadge, unitsBadge, type PanelRow } from './ui/panel';
import { OrientPanel, orientItems } from './ui/orientPanel';
import { setupSheet } from './ui/setupSheet';
import { fitRows, fitVerdict, formValuesOf, readStockForm, savedFromForm, StockPanel, type StockForm } from './ui/stockPanel';
import { buildMeasureOverlay, measureBetween, pickMeasurePoint, worldOf, type Measurement } from './view/measure';
import { buildPartMesh, NON_MANIFOLD_EDGE_COLOR, OPEN_EDGE_COLOR, type PartMesh } from './view/partMesh';
import { buildScene, type MachineScene } from './view/scene';
import { buildKeepOutMesh, buildStockMesh } from './view/stockMesh';
import { STANDARD_VIEWS, VIEW_KEYS, type StandardView } from './view/views';
import { Viewport } from './view/viewport';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id} element`);
  return el as T;
}

// The machine, the stock inputs and the origin are kept in the browser (a corrupt value reads as the defaults).
const storage = browserStorage();
let saved: SavedProfile = loadProfile(storage);
let machineProfile: MachineProfile = saved.machine;

const container = byId('viewport');
let machine: MachineScene = buildScene(machineProfile);
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
let units: UnitChoice = loadUnits(storage);

const setStatus = (text: string, isError = false): void => panel.setStatus(text, isError);

// The stock, the keep-out box and the WCS origin follow the stock inputs and the part's size in mm.
const stockMesh = buildStockMesh();
const keepOutMesh = buildKeepOutMesh();
machine.scene.add(stockMesh.object, keepOutMesh.object);
let profile: MachineProfile = machineProfile;
let fit: FitReport | null = null;
const stockPanel = new StockPanel(byId('stock'), () => {
  render();
  persist();
});
stockPanel.write(formValuesOf(saved));

/** Saves the stock inputs with the machine; an invalid input keeps the last good profile saved. */
function persist(): void {
  const next = savedFromForm(stockPanel.read(), machineProfile, saved);
  if (!next) return;
  saved = next;
  saveProfile(storage, next);
}

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
  return checkFit({ partSize, stock: form.stock, setup: form.setup, profile: { ...machineProfile, keepOut: form.keepOut } });
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
  profile = { ...machineProfile, keepOut: form.keepOut };
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
  if (picking) setMeasuring(false);
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

// Two-point measure: in measure mode a click (not a drag) on the part picks a point; the third click starts over.
const measureOverlay = buildMeasureOverlay();
machine.scene.add(measureOverlay.object);
const measureToggle = byId<HTMLButtonElement>('measure-toggle');
const measureInfo = byId('measure-info');
const measureLabel = byId('measure-label');
let measuring = false;
/** The picked points in the part's own space (so they follow the part); a then b. */
let measurePoints: Vec3[] = [];
let measurement: Measurement | null = null;
let measureWorld: Vec3[] = [];

function setMeasuring(on: boolean): void {
  measuring = on && part !== null;
  if (measuring && picking) setPicking(false);
  measureToggle.setAttribute('aria-pressed', String(measuring));
  renderMeasure();
}

function clearMeasure(): void {
  measurePoints = [];
  renderMeasure();
}

measureToggle.addEventListener('click', () => {
  if (measuring) {
    setMeasuring(false);
    clearMeasure();
  } else setMeasuring(true);
});

const mmText = (n: number): string => `${formatNumber(n)} mm`;

/** Draws the points and the line where the part is now, and writes the read-out. */
function renderMeasure(): void {
  measureToggle.disabled = part === null;
  measureWorld = part ? measurePoints.map((p) => worldOf(part!, p)) : [];
  const [a, b] = measureWorld;
  measureOverlay.update(a ?? null, b ?? null);
  measurement = a && b ? measureBetween(a, b) : null;
  if (measurement) {
    const [dx, dy, dz] = measurement.deltaMm;
    measureInfo.textContent = `Distance ${mmText(measurement.distanceMm)} (ΔX ${formatNumber(dx)}, ΔY ${formatNumber(dy)}, ΔZ ${formatNumber(dz)} mm)`;
  } else if (measuring) {
    measureInfo.textContent = a ? 'Click the second point (Esc to stop).' : 'Click a point on the part; a corner snaps (Esc to stop).';
  } else {
    measureInfo.textContent = '';
  }
  placeMeasureLabel();
  viewport.requestRender();
}

/** Keeps the distance label over the middle of the line, on screen. */
function placeMeasureLabel(): void {
  const [a, b] = measureWorld;
  if (!measurement || !a || !b) {
    measureLabel.hidden = true;
    return;
  }
  const mid = new Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2).project(viewport.camera);
  const rect = viewport.renderer.domElement.getBoundingClientRect();
  if (!Number.isFinite(mid.x) || !Number.isFinite(mid.y) || Math.abs(mid.z) > 1) {
    measureLabel.hidden = true;
    return;
  }
  measureLabel.hidden = false;
  measureLabel.textContent = mmText(measurement.distanceMm);
  measureLabel.style.left = `${rect.left + ((mid.x + 1) / 2) * rect.width}px`;
  measureLabel.style.top = `${rect.top + ((1 - mid.y) / 2) * rect.height}px`;
}
viewport.onAfterRender(placeMeasureLabel);

/** Applies the units choice and the orientation to the mesh, the panel rows and the badge, then re-runs the fit. */
function render(): void {
  const scale = unitScaleOf(units);
  part?.setUnitScale(scale);
  unitsBadgeEl.show(unitsBadge(units, part ? unitHint(part.size, units, machineProfile.cuttingArea) : null));
  if (shown) {
    const stats = shownStats(scale);
    const rows: PanelRow[] = stats
      ? partRows({ name: shown.name, format: shown.format, stats }, EDGE_COLOURS)
      : uninspectedRows(shown.name, shown.format, shown.triangles, shown.inspectionError ?? 'unknown error');
    panel.show(rows);
  }
  renderFit(scale);
  renderOrient(scale);
  renderMeasure();
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
  if (!(picking || measuring) || !part || !start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return;
  const rect = canvas.getBoundingClientRect();
  const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, viewport.camera);
  if (measuring) {
    const point = pickMeasurePoint(
      part,
      raycaster,
      viewport.camera,
      { x: e.clientX - rect.left, y: e.clientY - rect.top },
      { width: rect.width, height: rect.height },
    );
    if (!point) return; // a miss keeps the points picked so far
    measurePoints = measurePoints.length >= 2 ? [point.local] : [...measurePoints, point.local];
    renderMeasure();
    return;
  }
  const hit = part.pickFace(raycaster);
  if (!hit) {
    setPicking(true, 'That missed the part (or hit a degenerate triangle): click a face of the part, or Esc to cancel.');
    return;
  }
  setRotation(layFlat(part.rotation, hit.normal));
});
/** Keys typed into a field are the field's, never a view shortcut. */
function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName));
}

/** The box the standard views and Fit frame: the stock, else the part, else the machine's travel. */
function focusFrame(): BBox {
  if (fit?.stockBox) return fit.stockBox;
  if (part) {
    const at = part.placement;
    const size = part.orientedSize.map((v) => v * part!.unitScale);
    return { min: at, max: [at[0] + size[0]!, at[1] + size[1]!, at[2] + size[2]!] };
  }
  return machine.bounds.travel;
}

const orthoToggle = byId<HTMLButtonElement>('ortho-toggle');
function syncViewControls(): void {
  orthoToggle.setAttribute('aria-pressed', String(viewport.isOrtho));
  renderMeasure(); // the label follows the camera
}
const showView = (view: StandardView): void => {
  viewport.setView(view, focusFrame());
  syncViewControls();
};
for (const view of STANDARD_VIEWS) {
  byId<HTMLButtonElement>('view').querySelector<HTMLButtonElement>(`[data-view='${view}']`)?.addEventListener('click', () => showView(view));
}
orthoToggle.addEventListener('click', () => {
  viewport.toggleOrtho();
  syncViewControls();
});
byId('view-fit').addEventListener('click', () => {
  viewport.fit(focusFrame());
  syncViewControls();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (picking) setPicking(false);
    if (measuring || measurePoints.length > 0) {
      setMeasuring(false);
      clearMeasure();
    }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || typingIn(e.target)) return;
  const view = VIEW_KEYS[e.key];
  if (view) showView(view);
  else if (e.key === 'o' || e.key === 'O') {
    viewport.toggleOrtho();
    syncViewControls();
  } else if (e.key === 'f' || e.key === 'F') {
    viewport.fit(focusFrame());
    syncViewControls();
  } else return;
  e.preventDefault();
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
    measurePoints = []; // a measure belongs to the part it was taken on
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

// Profile: export and import as JSON; the setup sheet for CAM, copied as text.
const profileStatus = byId('profile-status');
const sheetBox = byId<HTMLTextAreaElement>('setup-sheet');
let lastSheet: string | null = null;
function setProfileStatus(text: string, tone: 'ok' | 'bad' | null = null): void {
  profileStatus.textContent = text;
  if (tone) profileStatus.dataset.tone = tone;
  else delete profileStatus.dataset.tone;
}

/** Disposes every geometry and material still in a scene that is being replaced. */
function disposeScene(root: Object3D): void {
  root.traverse((o) => {
    const m = o as Partial<Mesh>;
    m.geometry?.dispose();
    const mats = m.material === undefined ? [] : Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) mat.dispose();
  });
}

/** Uses `next` as the machine: redraws the bed and the boxes when its size changed, keeping the part, stock and measure. */
function setMachine(next: MachineProfile): void {
  if (!sameMachineSize(machineProfile, next)) {
    const rebuilt = buildScene(next);
    for (const o of [part?.object, stockMesh.object, keepOutMesh.object, measureOverlay.object]) if (o) rebuilt.scene.add(o);
    disposeScene(machine.scene);
    machine = rebuilt;
    viewport.setScene(rebuilt.scene, rebuilt.bounds.travel);
  }
  machineProfile = next;
}

byId('profile-export').addEventListener('click', () => {
  persist();
  const url = URL.createObjectURL(new Blob([profileToJson(saved)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = profileFileName(saved);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  setProfileStatus(`Exported ${a.download}.`, 'ok');
});

const profileFile = byId<HTMLInputElement>('profile-file');
byId('profile-import').addEventListener('click', () => profileFile.click());
/** A profile is a few hundred bytes; anything this big is not one. */
const MAX_PROFILE_BYTES = 1_000_000;
profileFile.addEventListener('change', async () => {
  const file = profileFile.files?.[0];
  profileFile.value = ''; // the same file can be picked again
  if (!file) return;
  if (file.size > MAX_PROFILE_BYTES) {
    setProfileStatus(`${file.name} is not a profile (${file.size.toLocaleString('en-US')} bytes); nothing changed.`, 'bad');
    return;
  }
  let text: string;
  try {
    text = await file.text();
  } catch (e) {
    setProfileStatus(`Could not read ${file.name}: ${String(e)}; nothing changed.`, 'bad');
    return;
  }
  const parsed = parseProfile(text);
  if (!parsed.ok) {
    setProfileStatus(`${file.name}: ${parsed.error}; nothing changed.`, 'bad');
    return;
  }
  setMachine(parsed.profile.machine);
  stockPanel.write(formValuesOf(parsed.profile));
  saved = parsed.profile;
  const kept = saveProfile(storage, saved);
  render();
  setProfileStatus(`Imported ${file.name}${kept ? '' : ' (this browser would not store it: it lasts until a reload)'}.`, kept ? 'ok' : 'bad');
});

/** The setup sheet for the current part, stock and origin. */
function currentSheet(): string {
  const form = readStockForm(stockPanel.read());
  const scale = unitScaleOf(units);
  return setupSheet({
    partName: shown?.name ?? null,
    units,
    partSizeMm: partSizeMm(scale),
    rotation: part?.rotation ?? null,
    machine: { ...machineProfile, keepOut: form.ok ? form.keepOut : [] },
    form: form.ok ? { stock: form.stock, setup: form.setup } : { errors: form.errors },
    fit: form.ok ? fit : null,
  });
}

byId('copy-setup').addEventListener('click', async () => {
  const text = currentSheet();
  lastSheet = text;
  try {
    if (!navigator.clipboard) throw new Error('no clipboard');
    await navigator.clipboard.writeText(text);
    sheetBox.hidden = true;
    setProfileStatus('Setup sheet copied to the clipboard.', 'ok');
  } catch {
    // No clipboard (blocked, or not a secure page): show the text to copy by hand.
    sheetBox.value = text;
    sheetBox.hidden = false;
    sheetBox.select();
    setProfileStatus('Could not reach the clipboard: the sheet is below, select it and copy.', 'bad');
  }
});

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
    get machine() {
      return machine;
    },
    /** The measure as shown: the picked points (machine axes, mm) and the distance; null until two are picked. */
    get measure() {
      return { points: measureWorld, measurement, measuring };
    },
    /** The profile as saved in this browser. */
    get savedProfile() {
      return saved;
    },
    /** The last setup sheet copied (or shown). */
    get setupSheet() {
      return lastSheet;
    },
  };
}
