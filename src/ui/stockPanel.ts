/**
 * The stock section of the panel: the inputs (auto or fixed stock, allowance,
 * placement on the bed, WCS origin, keep-out box) and the fit verdict.
 *
 * `readStockForm`, `fitVerdict` and `fitRows` are pure (unit-tested in Node);
 * `StockPanel` reads the inputs from the page and writes the verdict into it.
 */
import { failureText, formatMm, type FitReport } from '../geom/fit';
import type { BBox, MachineProfile, Setup, Stock, Vec3, WcsOrigin } from '../state/model';
import { parseProfile, profileToJson, type SavedProfile } from '../state/profiles';
import { formatNumber, type PanelRow, type RowTone } from './panel';

/** The raw input values, as the page holds them. */
export interface StockFormValues {
  readonly mode: string;
  readonly xy: string;
  readonly top: string;
  readonly bottom: string;
  readonly sizeX: string;
  readonly sizeY: string;
  readonly sizeZ: string;
  readonly bedX: string;
  readonly bedY: string;
  readonly origin: string;
  readonly keepOutOn: boolean;
  readonly keepOutX: string;
  readonly keepOutY: string;
  readonly keepOutW: string;
  readonly keepOutD: string;
  readonly keepOutH: string;
}

export type StockForm =
  | { readonly ok: true; readonly stock: Stock; readonly setup: Setup; readonly keepOut: readonly BBox[] }
  | { readonly ok: false; readonly errors: readonly string[] };

type Rule = 'any' | 'non-negative' | 'positive';

/** Reads and checks the inputs; every bad field is named, nothing is guessed. */
export function readStockForm(v: StockFormValues): StockForm {
  const errors: string[] = [];
  const num = (label: string, raw: string, rule: Rule): number => {
    const text = raw.trim();
    const n = text === '' ? NaN : Number(text);
    if (text === '') errors.push(`${label} is empty`);
    else if (!Number.isFinite(n)) errors.push(`${label} must be a number`);
    else if (rule === 'non-negative' && n < 0) errors.push(`${label} must be 0 or more`);
    else if (rule === 'positive' && n <= 0) errors.push(`${label} must be more than 0`);
    return n;
  };

  const mode = v.mode === 'fixed' ? 'fixed' : 'auto';
  const allowance = {
    xy: num('Allowance X/Y', v.xy, 'non-negative'),
    top: num('Allowance top', v.top, 'non-negative'),
    bottom: num('Allowance bottom', v.bottom, 'non-negative'),
  };
  const size: Vec3 =
    mode === 'fixed'
      ? [num('Block X', v.sizeX, 'positive'), num('Block Y', v.sizeY, 'positive'), num('Block Z', v.sizeZ, 'positive')]
      : [0, 0, 0];
  const stockOnBed: Vec3 = [num('Stock on bed X', v.bedX, 'any'), num('Stock on bed Y', v.bedY, 'any'), 0];
  const origin: WcsOrigin = v.origin === 'center-top' ? 'center-top' : 'bottom-left-front-top';

  const keepOut: BBox[] = [];
  if (v.keepOutOn) {
    const x = num('Keep-out X', v.keepOutX, 'any');
    const y = num('Keep-out Y', v.keepOutY, 'any');
    const w = num('Keep-out width', v.keepOutW, 'positive');
    const d = num('Keep-out depth', v.keepOutD, 'positive');
    const h = num('Keep-out height', v.keepOutH, 'positive');
    keepOut.push({ min: [x, y, 0], max: [x + w, y + d, h] });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, stock: { mode, allowance, size }, setup: { origin, stockOnBed }, keepOut };
}

/** The keep-out fields' values while the box is off and nothing was saved. */
export const KEEP_OUT_FIELD_DEFAULTS = Object.freeze({ keepOutX: '0', keepOutY: '0', keepOutW: '20', keepOutD: '20', keepOutH: '10' });

/** The inputs that show a saved profile. */
export function formValuesOf(p: SavedProfile): StockFormValues {
  const s = String;
  // A width is stored as max − min; 15 significant digits drop the float noise of the subtraction (150.1 + 20.2 − 150.1).
  const span = (hi: number, lo: number): string => String(Number((hi - lo).toPrecision(15)));
  const box = p.machine.keepOut?.[0];
  return {
    mode: p.stock.mode,
    xy: s(p.stock.allowance.xy),
    top: s(p.stock.allowance.top),
    bottom: s(p.stock.allowance.bottom),
    sizeX: s(p.stock.size[0]),
    sizeY: s(p.stock.size[1]),
    sizeZ: s(p.stock.size[2]),
    bedX: s(p.setup.stockOnBed[0]),
    bedY: s(p.setup.stockOnBed[1]),
    origin: p.setup.origin,
    keepOutOn: box !== undefined,
    ...(box
      ? {
          keepOutX: s(box.min[0]),
          keepOutY: s(box.min[1]),
          keepOutW: span(box.max[0], box.min[0]),
          keepOutD: span(box.max[1], box.min[1]),
          keepOutH: s(box.max[2]),
        }
      : KEEP_OUT_FIELD_DEFAULTS),
  };
}

/**
 * The profile to save for these inputs on `machine`, or null while an input is
 * invalid, or when the profile would not read back (a keep-out box whose
 * width vanishes next to a huge corner, or overflows: the next visit would
 * refuse it and lose every setting). In auto mode the block size is
 * not checked by the form; it is kept from the inputs when they hold a valid
 * size, else from `previous`.
 */
export function savedFromForm(values: StockFormValues, machine: MachineProfile, previous: SavedProfile): SavedProfile | null {
  const form = readStockForm(values);
  if (!form.ok) return null;
  let size = form.stock.size;
  if (form.stock.mode === 'auto') {
    const block = readStockForm({ ...values, mode: 'fixed' });
    size = block.ok ? block.stock.size : previous.stock.size;
  }
  const next: SavedProfile = {
    machine: { ...machine, keepOut: form.keepOut },
    stock: { ...form.stock, size },
    setup: form.setup,
  };
  return parseProfile(profileToJson(next)).ok ? next : null;
}

export interface FitVerdict {
  readonly tone: RowTone | undefined;
  readonly lines: readonly string[];
}

/** The verdict: "fits", or one line per failed check naming the axis and the overshoot. */
export function fitVerdict(report: FitReport | null, errors: readonly string[] = []): FitVerdict {
  if (errors.length > 0) return { tone: 'warn', lines: [`Not checked: ${errors.join('; ')}`] };
  if (!report || !report.stockSize) return { tone: undefined, lines: ['Load a part, or enter a fixed block'] };
  if (report.fits) {
    return {
      tone: 'ok',
      lines: [report.partOffset ? 'fits: part in stock with margins, stock in the cutting area' : 'stock fits the cutting area (no part loaded)'],
    };
  }
  return { tone: 'bad', lines: report.failures.map(failureText) };
}

const vec = (v: Vec3): string => `${v.map(formatNumber).join(' × ')} mm`;
const point = (v: Vec3): string => `${v.map(formatNumber).join(', ')} mm`;

/** The read-outs under the verdict. */
export function fitRows(report: FitReport | null): PanelRow[] {
  if (!report || !report.stockSize || !report.stockBox) return [];
  const rows: PanelRow[] = [{ key: 'stock-size', label: 'Stock X × Y × Z', value: vec(report.stockSize) }];
  if (report.partOffset) rows.push({ key: 'part-offset', label: 'Part offset in stock', value: point(report.partOffset) });
  if (report.wcs) rows.push({ key: 'wcs', label: 'WCS origin on bed', value: point(report.wcs) });
  if (report.zLeftMm !== null) {
    rows.push({
      key: 'z-left',
      label: 'Z left for tool + clamps',
      value: `${formatMm(report.zLeftMm)} mm`,
      tone: report.zLeftMm < 0 ? 'bad' : undefined,
    });
  }
  return rows;
}

/** The stock inputs and the verdict in the page. */
export class StockPanel {
  private readonly doc: Document;

  constructor(root: HTMLElement, onChange: () => void) {
    this.doc = root.ownerDocument;
    const changed = (): void => {
      this.syncControls();
      onChange();
    };
    root.addEventListener('input', changed);
    root.addEventListener('change', changed);
    this.syncControls();
  }

  private el<T extends HTMLElement>(id: string): T {
    const e = this.doc.getElementById(id);
    if (!e) throw new Error(`missing #${id} element`);
    return e as T;
  }

  private value(id: string): string {
    return this.el<HTMLInputElement>(id).value;
  }

  read(): StockFormValues {
    const fixed = this.el<HTMLInputElement>('stock-mode-fixed').checked;
    return {
      mode: fixed ? 'fixed' : 'auto',
      xy: this.value('allowance-xy'),
      top: this.value('allowance-top'),
      bottom: this.value('allowance-bottom'),
      sizeX: this.value('stock-size-x'),
      sizeY: this.value('stock-size-y'),
      sizeZ: this.value('stock-size-z'),
      bedX: this.value('stock-bed-x'),
      bedY: this.value('stock-bed-y'),
      origin: this.el<HTMLSelectElement>('wcs-origin').value,
      keepOutOn: this.el<HTMLInputElement>('keep-out-on').checked,
      keepOutX: this.value('keep-out-x'),
      keepOutY: this.value('keep-out-y'),
      keepOutW: this.value('keep-out-w'),
      keepOutD: this.value('keep-out-d'),
      keepOutH: this.value('keep-out-h'),
    };
  }

  /** Puts `v` into the inputs (a loaded or imported profile). Fires no change event. */
  write(v: StockFormValues): void {
    this.el<HTMLInputElement>('stock-mode-fixed').checked = v.mode === 'fixed';
    this.el<HTMLInputElement>('stock-mode-auto').checked = v.mode !== 'fixed';
    const set = (id: string, value: string): void => {
      this.el<HTMLInputElement>(id).value = value;
    };
    set('allowance-xy', v.xy);
    set('allowance-top', v.top);
    set('allowance-bottom', v.bottom);
    set('stock-size-x', v.sizeX);
    set('stock-size-y', v.sizeY);
    set('stock-size-z', v.sizeZ);
    set('stock-bed-x', v.bedX);
    set('stock-bed-y', v.bedY);
    this.el<HTMLSelectElement>('wcs-origin').value = v.origin;
    this.el<HTMLInputElement>('keep-out-on').checked = v.keepOutOn;
    set('keep-out-x', v.keepOutX);
    set('keep-out-y', v.keepOutY);
    set('keep-out-w', v.keepOutW);
    set('keep-out-d', v.keepOutD);
    set('keep-out-h', v.keepOutH);
    this.syncControls();
  }

  /** Shows the block size only for fixed stock, and the keep-out fields only when the box is on. */
  private syncControls(): void {
    this.el('stock-size').hidden = !this.el<HTMLInputElement>('stock-mode-fixed').checked;
    this.el('keep-out-fields').hidden = !this.el<HTMLInputElement>('keep-out-on').checked;
  }

  show(verdict: FitVerdict, rows: readonly PanelRow[]): void {
    const out = this.el<HTMLOutputElement>('fit-verdict');
    out.replaceChildren(
      ...verdict.lines.map((line) => {
        const span = this.doc.createElement('span');
        span.textContent = line;
        return span;
      }),
    );
    if (verdict.tone) out.dataset.tone = verdict.tone;
    else delete out.dataset.tone;

    const list = this.el<HTMLDListElement>('fit-info');
    const nodes: HTMLElement[] = [];
    for (const row of rows) {
      const dt = this.doc.createElement('dt');
      dt.textContent = row.label;
      const dd = this.doc.createElement('dd');
      const o = this.doc.createElement('output');
      o.id = `fit-${row.key}`;
      o.dataset.testid = `fit-${row.key}`;
      o.textContent = row.value;
      if (row.tone) o.dataset.tone = row.tone;
      dd.append(o);
      nodes.push(dt, dd);
    }
    list.replaceChildren(...nodes);
  }
}
