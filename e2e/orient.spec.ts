import { expect, test, type Page } from '@playwright/test';
import { dropFixture, ready } from './helpers';

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const FITS = 'fits: part in stock with margins, stock in the cutting area';
const TOO_TALL = 'stock exceeds cutting area Z by 7.0 mm'; // 80 + 1 on top + 2 under = 83 > 76

type Probe = { rotation: number[]; part: { min: number[]; max: number[] }; fits: boolean | null; stockSize: number[] | null; picking: boolean };

/** The part's rotation and world box, and the last fit report. */
async function probe(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    type Obj = { updateMatrixWorld(f: boolean): void; matrixWorld: unknown; geometry: { computeBoundingBox(): void; boundingBox: { clone(): { applyMatrix4(m: unknown): { min: { toArray(): number[] }; max: { toArray(): number[] } } } } } };
    const h = (window as unknown as {
      __stlViewer: {
        part: { object: Obj; rotation: number[] };
        fit: { fits: boolean; stockSize: number[] | null } | null;
        picking: boolean;
      };
    }).__stlViewer;
    const o = h.part.object;
    o.updateMatrixWorld(true);
    o.geometry.computeBoundingBox();
    // the box of the rotated vertices (the geometry box turned by the world matrix is the same for a box-shaped part)
    const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
    return {
      rotation: [...h.part.rotation],
      part: { min: b.min.toArray(), max: b.max.toArray() },
      fits: h.fit ? h.fit.fits : null,
      stockSize: h.fit?.stockSize ? [...h.fit.stockSize] : null,
      picking: h.picking,
    };
  });
}

const near = (got: number[], want: number[]): void => {
  expect(got).toHaveLength(want.length);
  got.forEach((v, i) => expect(Math.abs(v - want[i]!), `[${i}] ${v} vs ${want[i]}`).toBeLessThan(1e-4));
};
const verdict = (page: Page) => page.getByTestId('fit-verdict');

async function loadTallBox(page: Page): Promise<void> {
  await dropFixture(page, 'box-10x20x80.stl');
  await expect(page.locator('#load-status')).toHaveText('Loaded box-10x20x80.stl.');
}

test('every rotation re-runs the fit: too tall as read, fits after a quarter turn about X; four turns about Z come back exactly', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  await expect(page.getByTestId('rotate-x')).toBeDisabled();
  await expect(page.getByTestId('auto-orient')).toBeDisabled();

  await loadTallBox(page);
  await expect(page.getByTestId('rotate-x')).toBeEnabled();
  await expect(verdict(page)).toHaveText(TOO_TALL);
  await expect(page.getByTestId('part-size')).toHaveText('10 × 20 × 80 mm');
  expect((await probe(page)).rotation).toEqual(IDENTITY);

  await page.getByTestId('rotate-x').click();
  await expect(verdict(page)).toHaveText(FITS);
  await expect(page.getByTestId('part-size')).toHaveText('10 × 80 × 20 mm');
  await expect(page.getByTestId('fit-stock-size')).toHaveText('16 × 86 × 23 mm');
  let p = await probe(page);
  expect(p.fits).toBe(true);
  near(p.part.min, [3, 3, 2]); // still in its stock after the turn
  near(p.part.max, [13, 83, 22]);

  // Z turns: the footprint swaps each time and the fit follows; four come back to the X turn exactly.
  const afterX = p.rotation;
  const sizes: string[] = [];
  for (let i = 0; i < 4; i++) {
    await page.getByTestId('rotate-z').click();
    await expect(page.getByTestId('part-size')).toHaveText(i % 2 === 0 ? '80 × 10 × 20 mm' : '10 × 80 × 20 mm');
    await expect(page.getByTestId('fit-stock-size')).toHaveText(i % 2 === 0 ? '86 × 16 × 23 mm' : '16 × 86 × 23 mm');
    sizes.push((await probe(page)).stockSize!.join('×'));
  }
  expect(sizes).toEqual(['86×16×23', '16×86×23', '86×16×23', '16×86×23']);
  p = await probe(page);
  expect(p.rotation).toEqual(afterX);

  // three more X turns come back to as read (too tall again); a Y turn lays it down; As read undoes it
  await page.getByTestId('rotate-x').click();
  await page.getByTestId('rotate-x').click();
  await page.getByTestId('rotate-x').click();
  await expect(verdict(page)).toHaveText(TOO_TALL);
  expect((await probe(page)).rotation).toEqual(IDENTITY);
  await page.getByTestId('rotate-y').click();
  await expect(page.getByTestId('part-size')).toHaveText('80 × 20 × 10 mm');
  await expect(verdict(page)).toHaveText(FITS);
  await page.getByTestId('orient-reset').click();
  await expect(verdict(page)).toHaveText(TOO_TALL);
  expect((await probe(page)).rotation).toEqual(IDENTITY);
  expect(errors).toEqual([]);
});

test('auto-orient lists the top three with Z height and fit, applies nothing until asked, and the list follows the stock', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  await loadTallBox(page);
  await expect(page.getByTestId('orient-list')).toBeHidden();

  await page.getByTestId('auto-orient').click();
  const options = page.getByTestId('orient-option');
  await expect(options).toHaveCount(3);
  await expect(page.getByTestId('orient-height')).toHaveText(['Z 10.0 mm', 'Z 20.0 mm', 'Z 80.0 mm']);
  await expect(page.getByTestId('orient-fit')).toHaveText(['fits', 'fits', TOO_TALL]);
  // the part is still as read, which is the third entry
  expect((await probe(page)).rotation).toEqual(IDENTITY);
  await expect(options.nth(2)).toHaveAttribute('data-current', 'true');
  await expect(page.getByTestId('orient-apply').nth(2)).toBeDisabled();
  await expect(verdict(page)).toHaveText(TOO_TALL);

  await page.getByTestId('orient-apply').first().click();
  await expect(verdict(page)).toHaveText(FITS);
  const p = await probe(page);
  near([p.part.max[2]! - p.part.min[2]!], [10]);
  near(p.part.min, [3, 3, 2]);
  await expect(options.first()).toHaveAttribute('data-current', 'true');
  await page.screenshot({ path: test.info().outputPath('auto-orient.png') });

  // A fixed 26 × 26 × 26 block holds at most 20 × 20 × 23 with the margins: no way up fits the 80 mm side,
  // the list re-ranks with the new stock, and the lowest says what misses (the 80 mm side by 80 + 6 − 26).
  await page.getByTestId('stock-mode-fixed').check();
  await page.getByTestId('stock-size-x').fill('26');
  await page.getByTestId('stock-size-y').fill('26');
  await page.getByTestId('stock-size-z').fill('26');
  await expect(page.getByTestId('orient-fit').first()).toHaveText(/^part exceeds stock (X|Y) by 60\.0 mm \(with margins\)/);
  // an invalid stock input: the list says fit was not checked
  await page.getByTestId('allowance-xy').fill('');
  await expect(page.getByTestId('orient-fit')).toHaveText([/not checked/, /not checked/, /not checked/]);
  expect(errors).toEqual([]);
});

test('lay flat: in pick mode a click on a side face puts that face on the bed; a click elsewhere or Esc does not', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  await loadTallBox(page);
  // move the stock towards the middle of the bed so the part is clear of the panel
  await page.getByTestId('stock-bed-x').fill('90');
  await page.getByTestId('stock-bed-y').fill('90');
  await expect(verdict(page)).toHaveText(TOO_TALL);

  // The part is 10 × 20 × 80 at (93, 93, 2). Find a side face the camera sees and where its centre lands on screen.
  const findTarget = () => page.evaluate(() => {
    type V = { clone(): V; set(x: number, y: number, z: number): V; project(c: unknown): V; x: number; y: number; toArray(): number[] };
    const h = (window as unknown as { __stlViewer: { viewport: { camera: { position: V } }; part: { object: { position: V } } } }).__stlViewer;
    const cam = h.viewport.camera.position.toArray();
    const [x0, y0, z0, x1, y1, z1] = [93, 93, 2, 103, 113, 82];
    const zc = (z0 + z1) / 2;
    const faces = [
      { centre: [x1, (y0 + y1) / 2, zc], normal: [1, 0, 0], thickness: 10 },
      { centre: [x0, (y0 + y1) / 2, zc], normal: [-1, 0, 0], thickness: 10 },
      { centre: [(x0 + x1) / 2, y1, zc], normal: [0, 1, 0], thickness: 20 },
      { centre: [(x0 + x1) / 2, y0, zc], normal: [0, -1, 0], thickness: 20 },
    ];
    const canvas = document.querySelector('#viewport canvas')!;
    const rect = canvas.getBoundingClientRect();
    for (const f of faces) {
      const toCam = [0, 1, 2].map((i) => cam[i]! - f.centre[i]!);
      if (toCam[0]! * f.normal[0]! + toCam[1]! * f.normal[1]! + toCam[2]! * f.normal[2]! <= 0) continue;
      const ndc = h.part.object.position.clone().set(f.centre[0]!, f.centre[1]!, f.centre[2]!).project(h.viewport.camera);
      const x = rect.left + ((ndc.x + 1) / 2) * rect.width;
      const y = rect.top + ((1 - ndc.y) / 2) * rect.height;
      if (document.elementFromPoint(x, y) !== canvas) continue;
      return { x, y, thickness: f.thickness };
    }
    return null;
  });
  let target = await findTarget();
  expect(target, 'a side face of the part is visible and not under the panel').not.toBeNull();

  // Not in pick mode, a click does nothing.
  await page.mouse.click(target!.x, target!.y);
  expect((await probe(page)).rotation).toEqual(IDENTITY);

  // Esc leaves pick mode.
  await page.getByTestId('lay-flat').click();
  await expect(page.getByTestId('orient-hint')).toBeVisible();
  await expect(page.getByTestId('lay-flat')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('orient-hint')).toBeHidden();
  await page.mouse.click(target!.x, target!.y);
  expect((await probe(page)).rotation).toEqual(IDENTITY);

  // A click on empty bed misses: still in pick mode, and the hint says so.
  await page.getByTestId('lay-flat').click();
  const rect = await page.locator('#viewport canvas').boundingBox();
  await page.mouse.click(rect!.x + rect!.width - 5, rect!.y + 5);
  await expect(page.getByTestId('orient-hint')).toHaveText(/missed the part/);
  expect((await probe(page)).picking).toBe(true);

  // A drag that ends on the face orbits the view and lays nothing flat.
  await page.mouse.move(target!.x + 12, target!.y);
  await page.mouse.down();
  await page.mouse.move(target!.x + 6, target!.y, { steps: 3 });
  await page.mouse.move(target!.x, target!.y, { steps: 3 });
  await page.mouse.up();
  expect((await probe(page)).rotation).toEqual(IDENTITY);
  expect((await probe(page)).picking).toBe(true);

  // A click on the face lays it flat; the fit re-runs and pick mode ends.
  target = await findTarget(); // the drag moved the camera
  expect(target).not.toBeNull();
  await page.mouse.click(target!.x, target!.y);
  await expect(verdict(page)).toHaveText(FITS);
  const p = await probe(page);
  near([p.part.max[2]! - p.part.min[2]!], [target!.thickness]);
  expect(p.picking).toBe(false);
  await expect(page.getByTestId('orient-hint')).toBeHidden();
  await expect(page.getByTestId('lay-flat')).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('a new file starts as read and clears the suggestions', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  await loadTallBox(page);
  await page.getByTestId('auto-orient').click();
  await page.getByTestId('orient-apply').first().click();
  await expect(verdict(page)).toHaveText(FITS);
  await page.getByTestId('lay-flat').click();

  await loadTallBox(page);
  await expect(verdict(page)).toHaveText(TOO_TALL);
  await expect(page.getByTestId('orient-list')).toBeHidden();
  const p = await probe(page);
  expect(p.rotation).toEqual(IDENTITY);
  expect(p.picking).toBe(false);
  expect(errors).toEqual([]);
});
