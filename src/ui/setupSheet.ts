/**
 * The setup sheet: a plain-text block for CAM (stock size, WCS origin, part
 * offset in the stock, orientation, fit verdict), copied to the clipboard.
 * `setupSheet` is pure (unit-tested in Node).
 */
import { formatMm, type FitReport } from '../geom/fit';
import { isAxisAligned, type Mat3 } from '../geom/orient';
import type { UnitChoice } from '../geom/units';
import type { FileUnits } from '../io/parse';
import type { MachineProfile, Setup, Stock, Vec3 } from '../state/model';
import { formatNumber } from './panel';
import { fitVerdict } from './stockPanel';

export interface SetupSheetInput {
  readonly partName: string | null;
  readonly units: UnitChoice;
  /** The unit the file states (3MF); it wins over `units`. */
  readonly fileUnits?: FileUnits | null;
  /** The part's size as shown, mm (oriented, scaled); null with no part. */
  readonly partSizeMm: Vec3 | null;
  readonly rotation: Mat3 | null;
  readonly machine: MachineProfile;
  /** The stock inputs, or the reasons they could not be read. */
  readonly form: { readonly stock: Stock; readonly setup: Setup } | { readonly errors: readonly string[] };
  readonly fit: FitReport | null;
}

const mm = (v: Vec3): string => `${v.map(formatNumber).join(' × ')} mm`;
const at = (v: Vec3): string => `X ${formatNumber(v[0])}, Y ${formatNumber(v[1])}, Z ${formatNumber(v[2])} mm`;

const AXES = ['X', 'Y', 'Z'] as const;

/** Where each file axis points on the machine, e.g. "file X → +X, file Y → −Z, file Z → +Y"; matrix rows otherwise. */
export function orientationText(r: Mat3): string {
  if (r.every((v, i) => v === (i % 4 === 0 ? 1 : 0))) return 'as read from the file';
  if (isAxisAligned(r)) {
    const parts = AXES.map((fileAxis, col) => {
      const row = [0, 1, 2].find((k) => r[3 * k + col] !== 0)!;
      return `file ${fileAxis} → ${r[3 * row + col]! > 0 ? '+' : '−'}${AXES[row]}`;
    });
    return `turned: ${parts.join(', ')}`;
  }
  const rows = [0, 1, 2].map((k) => `[${[0, 1, 2].map((c) => (r[3 * k + c]! + 0).toFixed(4)).join(', ')}]`);
  return `turned (machine = R · file), R = ${rows.join(' ')}`;
}

const ORIGIN_TEXT: Record<Setup['origin'], string> = {
  'bottom-left-front-top': 'front-left corner of the stock, Z0 on the stock top',
  'center-top': 'centre of the stock, Z0 on the stock top',
};

/** The sheet as text, one fact per line. */
export function setupSheet(i: SetupSheetInput): string {
  const lines: string[] = ['STL stock-fit setup sheet'];
  lines.push(`Machine: ${i.machine.name} (cutting area ${mm(i.machine.cuttingArea)})`);
  if (i.partName && i.partSizeMm) {
    lines.push(`Part: ${i.partName}`);
    lines.push(
      i.fileUnits
        ? `Units: ${i.fileUnits.unit}, stated by the file${i.fileUnits.mmPerUnit === 1 ? '' : ` (×${i.fileUnits.mmPerUnit} to mm)`}`
        : `Units: ${i.units === 'in' ? 'file read as inches (×25.4)' : 'file read as mm'}`,
    );
    lines.push(`Part X × Y × Z: ${mm(i.partSizeMm)}`);
    if (i.rotation) lines.push(`Orientation: ${orientationText(i.rotation)}`);
  } else {
    lines.push('Part: none loaded');
  }
  if ('errors' in i.form) {
    lines.push(fitVerdict(null, i.form.errors).lines[0]!);
    return `${lines.join('\n')}\n`;
  }
  const { stock, setup } = i.form;
  const a = stock.allowance;
  const r = i.fit;
  if (r?.stockSize) {
    const how =
      stock.mode === 'fixed'
        ? 'fixed block'
        : `part + allowance X/Y ${formatNumber(a.xy)}, top ${formatNumber(a.top)}, bottom ${formatNumber(a.bottom)} mm per side`;
    lines.push(`Stock X × Y × Z: ${mm(r.stockSize)} (${how})`);
  } else {
    lines.push('Stock: not sized (load a part, or enter a fixed block)');
  }
  lines.push(`Stock on the bed (front-left corner): X ${formatNumber(setup.stockOnBed[0])}, Y ${formatNumber(setup.stockOnBed[1])} mm`);
  lines.push(`WCS origin: ${ORIGIN_TEXT[setup.origin]}`);
  if (r?.wcs) lines.push(`WCS origin on the bed: ${at(r.wcs)}`);
  if (r?.partOffset) lines.push(`Part offset in stock (part min corner from stock front-left-bottom): ${at(r.partOffset)}`);
  if (r?.zLeftMm != null) lines.push(`Z left for tool + clamps: ${formatMm(r.zLeftMm)} mm`);
  const keepOut = i.machine.keepOut ?? [];
  if (keepOut.length > 0) lines.push(`Keep-out boxes checked: ${keepOut.length}`);
  const verdict = fitVerdict(r);
  lines.push(`Fit: ${verdict.lines.join('; ')}`);
  return `${lines.join('\n')}\n`;
}
