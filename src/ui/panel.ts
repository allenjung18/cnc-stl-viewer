/**
 * The part panel: what was loaded and what the inspector found. `partRows` is
 * pure (unit-tested in Node); `InspectorPanel` writes the rows into the page.
 *
 * STL carries no units; lengths are shown as millimetres, the machine's units,
 * after the units badge's scale (×1, or ×25.4 for an inch file). `unitsBadge`
 * is pure too; `UnitsBadge` writes it into the page and reports the toggle.
 */
import { MM_PER_INCH, type UnitChoice, type UnitHint } from '../geom/units';
import type { FileUnits } from '../io/parse';
import { formatName, type MeshFormat } from '../io/sniff';
import type { MeshStats } from '../state/model';

export type RowTone = 'ok' | 'warn' | 'bad';

export interface PanelRow {
  /** Stable id: the row's value is `#part-<key>`, test id `part-<key>`. */
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly tone?: RowTone | undefined;
  /** CSS colour of a legend swatch, for rows whose edges are drawn in that colour. */
  readonly swatch?: string | undefined;
}

export interface PartSummary {
  readonly name: string;
  readonly format: MeshFormat;
  readonly stats: MeshStats;
}

/** A number for the panel: up to 3 decimals with grouping; exponent form for very small or very large values. */
export function formatNumber(n: number): string {
  if (Number.isNaN(n)) return 'not a number';
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '−∞';
  if (n === 0) return '0';
  const a = Math.abs(n);
  if (a < 1e-3 || a >= 1e12) return n.toExponential(3).replace('e+', 'e');
  return n.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

const count = (n: number): string => n.toLocaleString('en-US');
const plural = (n: number, one: string, many: string): string => `${count(n)} ${n === 1 ? one : many}`;

export function partRows({ name, format, stats: s }: PartSummary, colours: { open: string; nonManifold: string }): PanelRow[] {
  const volume = formatNumber(Math.abs(s.volumeMm3));
  let volumeText = `${volume} mm³`;
  if (!s.watertight) {
    // The sum only means something for a closed, manifold surface.
    const why = s.openEdges > 0 ? 'mesh is open' : s.nonManifoldEdges > 0 ? 'mesh is not manifold' : 'mesh has no edges';
    volumeText = `≈ ${volumeText} (${why})`;
  }
  else if (s.flippedHint) volumeText = `${volumeText} (computed −${volume}: normals inward)`;

  const problems: string[] = [];
  if (s.openEdges > 0) problems.push(plural(s.openEdges, 'open edge', 'open edges'));
  if (s.nonManifoldEdges > 0) problems.push(plural(s.nonManifoldEdges, 'non-manifold edge', 'non-manifold edges'));
  if (problems.length === 0 && !s.watertight) problems.push('no edges');

  return [
    { key: 'name', label: 'Part', value: name },
    { key: 'format', label: 'Format', value: formatName(format) },
    { key: 'size', label: 'Size X × Y × Z', value: `${s.size.map(formatNumber).join(' × ')} mm` },
    { key: 'volume', label: 'Volume', value: volumeText, tone: s.watertight && !s.flippedHint ? undefined : 'warn' },
    { key: 'area', label: 'Surface area', value: `${formatNumber(s.areaMm2)} mm²` },
    { key: 'triangles', label: 'Triangles', value: count(s.triangles) },
    { key: 'vertices', label: 'Vertices (welded)', value: count(s.vertices) },
    {
      key: 'watertight',
      label: 'Watertight',
      value: s.watertight ? 'yes' : `no — ${problems.join(', ')}`,
      tone: s.watertight ? 'ok' : 'bad',
    },
    {
      key: 'open-edges',
      label: 'Open edges',
      value: count(s.openEdges),
      tone: s.openEdges > 0 ? 'bad' : undefined,
      swatch: s.openEdges > 0 ? colours.open : undefined,
    },
    {
      key: 'non-manifold-edges',
      label: 'Non-manifold edges',
      value: count(s.nonManifoldEdges),
      tone: s.nonManifoldEdges > 0 ? 'bad' : undefined,
      swatch: s.nonManifoldEdges > 0 ? colours.nonManifold : undefined,
    },
    {
      key: 'degenerate',
      label: 'Degenerate triangles',
      value: count(s.degenerateTris),
      tone: s.degenerateTris > 0 ? 'warn' : undefined,
    },
    s.watertight
      ? {
          key: 'normals',
          label: 'Normals',
          value: s.flippedHint ? 'inward (flipped): the volume is negative' : 'outward',
          tone: s.flippedHint ? 'bad' : 'ok',
        }
      : { key: 'normals', label: 'Normals', value: 'not judged: the mesh is not closed', tone: 'warn' },
  ];
}

/** The rows for a part that loaded but could not be inspected. */
export function uninspectedRows(name: string, format: MeshFormat, triangles: number, reason: string): PanelRow[] {
  return [
    { key: 'name', label: 'Part', value: name },
    { key: 'format', label: 'Format', value: formatName(format) },
    { key: 'triangles', label: 'Triangles', value: count(triangles) },
    { key: 'inspection', label: 'Inspection', value: `not run: ${reason}`, tone: 'warn' },
  ];
}

/** What the units badge shows. */
export interface UnitsBadgeView {
  /** The current reading of the file's numbers. */
  readonly value: string;
  /** The toggle's label: what pressing it switches to. */
  readonly toggleLabel: string;
  /** A heuristic hint, or null; never acted on without the user. */
  readonly hint: string | null;
  readonly hintTone: RowTone | undefined;
  /** The file states its unit (3MF): the toggle is disabled. */
  readonly locked: boolean;
}

/** The badge for a units choice and the hint for the loaded part (`null` when none or no part). */
export function unitsBadge(choice: UnitChoice, hint: UnitHint | null, fileUnits?: FileUnits | null): UnitsBadgeView {
  if (fileUnits) {
    // The file says: no guess, no toggle, and the user's choice for STL files is kept for the next one.
    const value =
      fileUnits.mmPerUnit === 1 ? 'mm (from the file)' : `${fileUnits.unit} (from the file, ×${fileUnits.mmPerUnit} to mm)`;
    return { value, toggleLabel: 'Set by the file', hint: null, hintTone: undefined, locked: true };
  }
  return {
    locked: false,
    value: choice === 'in' ? `inches (×${MM_PER_INCH})` : 'mm (STL has no units)',
    toggleLabel: choice === 'in' ? 'Treat as mm' : `Treat as inches (×${MM_PER_INCH})`,
    hint: hint ? hint.text : null,
    hintTone: hint ? 'warn' : undefined,
  };
}

/** The units badge in the page: the value, the hint, and a toggle button. */
export class UnitsBadge {
  constructor(
    private readonly value: HTMLElement,
    private readonly toggle: HTMLButtonElement,
    private readonly hint: HTMLElement,
    onToggle: () => void,
  ) {
    toggle.addEventListener('click', () => onToggle());
  }

  show(view: UnitsBadgeView): void {
    this.value.textContent = view.value;
    this.toggle.textContent = view.toggleLabel;
    this.toggle.disabled = view.locked;
    this.hint.textContent = view.hint ?? '';
    this.hint.hidden = view.hint === null;
    if (view.hintTone) this.hint.dataset.tone = view.hintTone;
    else delete this.hint.dataset.tone;
  }
}

/** Writes rows into a `<dl>` and messages into a status line. */
export class InspectorPanel {
  constructor(
    private readonly list: HTMLDListElement,
    private readonly status: HTMLElement,
  ) {}

  show(rows: readonly PanelRow[]): void {
    const doc = this.list.ownerDocument;
    const nodes: HTMLElement[] = [];
    for (const row of rows) {
      const dt = doc.createElement('dt');
      dt.textContent = row.label;
      const dd = doc.createElement('dd');
      if (row.swatch) {
        const sw = doc.createElement('span');
        sw.className = 'swatch';
        sw.style.background = row.swatch;
        sw.setAttribute('aria-hidden', 'true');
        dd.append(sw);
      }
      const out = doc.createElement('output');
      out.id = `part-${row.key}`;
      out.dataset.testid = `part-${row.key}`;
      out.textContent = row.value;
      if (row.tone) out.dataset.tone = row.tone;
      dd.append(out);
      nodes.push(dt, dd);
    }
    this.list.replaceChildren(...nodes);
  }

  setStatus(text: string, isError = false): void {
    this.status.textContent = text;
    this.status.classList.toggle('error', isError);
    this.status.setAttribute('role', isError ? 'alert' : 'status');
  }
}
