/**
 * The orientation controls: quarter turns about X, Y and Z, back to as read,
 * lay flat on a picked face, and auto-orient's top three. `orientItems` is
 * pure (unit-tested in Node); `OrientPanel` writes it into the page and
 * reports the clicks. Nothing is applied until the user clicks.
 */
import { failureText, formatMm } from '../geom/fit';
import { sameRotation, type Mat3, type RankedOrientation, type RotationAxis } from '../geom/orient';
import { formatNumber, type RowTone } from './panel';

/** One line of the auto-orient list. */
export interface OrientItem {
  /** "Z 10.0 mm" */
  readonly height: string;
  /** "fits", the first failure, or why fit was not checked. */
  readonly verdict: string;
  readonly tone: RowTone | undefined;
  /** "footprint 20 × 60 mm, 1,200 mm² on the bed" */
  readonly detail: string;
  /** This is the orientation the part has now. */
  readonly current: boolean;
}

/** The auto-orient list as shown: Z height and fit for each, best first. */
export function orientItems(ranked: readonly RankedOrientation[], current: Mat3): OrientItem[] {
  return ranked.map((o) => {
    let verdict = 'fit not checked: fix the stock inputs';
    let tone: RowTone | undefined = 'warn';
    if (o.fit) {
      if (o.fits) {
        verdict = 'fits';
        tone = 'ok';
      } else {
        const [first, ...rest] = o.fit.failures;
        verdict = first ? failureText(first) + (rest.length > 0 ? ` (+${rest.length} more)` : '') : 'no stock to check';
        tone = 'bad';
      }
    }
    return {
      height: `Z ${formatMm(o.zHeightMm)} mm`,
      verdict,
      tone,
      detail: `footprint ${formatNumber(o.sizeMm[0])} × ${formatNumber(o.sizeMm[1])} mm, ${formatNumber(o.contactAreaMm2)} mm² on the bed`,
      current: sameRotation(o.rotation, current, 1e-9),
    };
  });
}

export interface OrientHandlers {
  rotate(axis: RotationAxis): void;
  reset(): void;
  /** Lay-flat pick mode on (true) or off. */
  pick(on: boolean): void;
  auto(): void;
  /** Apply the list's entry `index`. */
  apply(index: number): void;
}

/** The orientation section in the page. */
export class OrientPanel {
  private readonly doc: Document;

  constructor(
    private readonly root: HTMLElement,
    handlers: OrientHandlers,
  ) {
    this.doc = root.ownerDocument;
    root.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement | null)?.closest('button');
      if (!button || !root.contains(button) || button.disabled) return;
      const { action, axis, index } = button.dataset;
      if (action === 'rotate' && (axis === 'X' || axis === 'Y' || axis === 'Z')) handlers.rotate(axis);
      else if (action === 'reset') handlers.reset();
      else if (action === 'lay-flat') handlers.pick(button.getAttribute('aria-pressed') !== 'true');
      else if (action === 'auto') handlers.auto();
      else if (action === 'apply' && index !== undefined) handlers.apply(Number(index));
    });
  }

  private el<T extends HTMLElement>(id: string): T {
    const e = this.doc.getElementById(id);
    if (!e) throw new Error(`missing #${id} element`);
    return e as T;
  }

  /** Enables the buttons only while a part is loaded. */
  setEnabled(on: boolean): void {
    for (const b of this.root.querySelectorAll<HTMLButtonElement>("button[data-action]:not([data-action='apply'])")) b.disabled = !on;
  }

  /** Shows lay-flat pick mode as pressed, with its hint (or `hint` instead of the default). */
  setPicking(on: boolean, hint?: string): void {
    this.el('lay-flat').setAttribute('aria-pressed', String(on));
    const p = this.el('orient-hint');
    p.hidden = !on;
    if (on) p.textContent = hint ?? 'Click a face of the part to put it down on the bed (Esc cancels).';
  }

  /** Shows the auto-orient list, or hides it (null). */
  showList(items: readonly OrientItem[] | null): void {
    const list = this.el<HTMLOListElement>('orient-list');
    list.hidden = items === null;
    list.replaceChildren(
      ...(items ?? []).map((item, index) => {
        const li = this.doc.createElement('li');
        li.dataset.testid = 'orient-option';
        if (item.current) li.dataset.current = 'true';
        const height = this.doc.createElement('strong');
        height.dataset.testid = 'orient-height';
        height.textContent = item.height;
        const verdict = this.doc.createElement('output');
        verdict.dataset.testid = 'orient-fit';
        verdict.textContent = item.verdict;
        if (item.tone) verdict.dataset.tone = item.tone;
        const detail = this.doc.createElement('small');
        detail.textContent = item.detail;
        const button = this.doc.createElement('button');
        button.type = 'button';
        button.dataset.action = 'apply';
        button.dataset.index = String(index);
        button.dataset.testid = 'orient-apply';
        button.textContent = item.current ? 'Current' : 'Apply';
        button.disabled = item.current;
        li.append(height, ' · ', verdict, this.doc.createElement('br'), detail, ' ', button);
        return li;
      }),
    );
  }
}
