/**
 * The part panel: what was loaded and what the inspector found. `partRows` is
 * pure (unit-tested in Node); `InspectorPanel` writes the rows into the page.
 *
 * STL carries no units; lengths are shown as millimetres, the machine's units.
 */
import type { StlFormat } from '../io/sniff';
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
  readonly format: StlFormat;
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
    { key: 'format', label: 'Format', value: format === 'stl-bin' ? 'binary STL' : 'ASCII STL' },
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
    {
      key: 'normals',
      label: 'Normals',
      value: s.flippedHint ? 'inward (flipped): the volume is negative' : 'outward',
      tone: s.flippedHint ? 'bad' : 'ok',
    },
  ];
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
