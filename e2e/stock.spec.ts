import { expect, test, type Page } from '@playwright/test';
import { dropFixture, ready } from './helpers';

const STOCK_COLOR = 0xd9b77e;
const STOCK_FAIL_COLOR = 0xff3b30;

type WorldBox = { min: number[]; max: number[] };

/** The drawn stock, its colour, the WCS marker, the part's world box and the keep-out drawing. */
async function probe(page: Page): Promise<{
  visible: boolean;
  color: number;
  stock: WorldBox;
  marker: number[];
  part: WorldBox | null;
  keepOut: string[];
}> {
  return page.evaluate(() => {
    type Obj = {
      visible: boolean;
      updateMatrixWorld(f: boolean): void;
      matrixWorld: unknown;
      geometry: { computeBoundingBox(): void; boundingBox: { clone(): { applyMatrix4(m: unknown): { min: { toArray(): number[] }; max: { toArray(): number[] } } } } };
    };
    const h = (window as unknown as {
      __stlViewer: {
        stockMesh: { object: Obj; box: Obj; color: number; marker: { position: { toArray(): number[] } } };
        keepOutMesh: { object: { children: { name: string }[] } };
        part: { object: Obj } | null;
      };
    }).__stlViewer;
    const world = (o: Obj) => {
      o.updateMatrixWorld(true);
      o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
      return { min: b.min.toArray(), max: b.max.toArray() };
    };
    return {
      visible: h.stockMesh.object.visible,
      color: h.stockMesh.color,
      stock: world(h.stockMesh.box),
      marker: h.stockMesh.marker.position.toArray(),
      part: h.part ? world(h.part.object) : null,
      keepOut: h.keepOutMesh.object.children.map((c) => c.name),
    };
  });
}

const near = (got: number[], want: number[]): void => {
  expect(got).toHaveLength(want.length);
  got.forEach((v, i) => expect(Math.abs(v - want[i]!), `[${i}] ${v} vs ${want[i]}`).toBeLessThan(1e-4));
};

const verdict = (page: Page) => page.getByTestId('fit-verdict');

async function loadCube(page: Page): Promise<void> {
  await dropFixture(page, 'cube-20mm-binary.stl');
  await expect(page.locator('#load-status')).toHaveText('Loaded cube-20mm-binary.stl.');
}

async function setNumber(page: Page, id: string, value: string): Promise<void> {
  await page.getByTestId(id).fill(value);
}

test('the 20 mm cube gets a 26 × 26 × 23 stock with the part inside and the WCS marker on its front-left top', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  await expect(verdict(page)).toHaveText('Load a part, or enter a fixed block');
  expect((await probe(page)).visible).toBe(false);

  await loadCube(page);
  await expect(verdict(page)).toHaveText('fits: part in stock with margins, stock in the cutting area');
  await expect(verdict(page)).toHaveAttribute('data-tone', 'ok');
  await expect(page.getByTestId('fit-stock-size')).toHaveText('26 × 26 × 23 mm');
  await expect(page.getByTestId('fit-part-offset')).toHaveText('3, 3, 2 mm');
  await expect(page.getByTestId('fit-wcs')).toHaveText('0, 0, 23 mm');
  await expect(page.getByTestId('fit-z-left')).toHaveText('53.0 mm');

  const p = await probe(page);
  expect(p.visible).toBe(true);
  expect(p.color).toBe(STOCK_COLOR);
  near(p.stock.min, [0, 0, 0]);
  near(p.stock.max, [26, 26, 23]);
  near(p.marker, [0, 0, 23]);
  near(p.part!.min, [3, 3, 2]);
  near(p.part!.max, [23, 23, 22]);
  await page.locator('#viewport canvas').screenshot({ path: test.info().outputPath('stock-fits.png') });

  // A bigger allowance grows the stock; the part moves with its offset.
  await setNumber(page, 'allowance-xy', '5');
  await expect(page.getByTestId('fit-stock-size')).toHaveText('30 × 30 × 23 mm');
  near((await probe(page)).part!.min, [5, 5, 2]);
  expect(errors).toEqual([]);
});

test('a 25 mm block fails X and Y by 1 mm and the stock turns red; a fitting block turns it back', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  await loadCube(page);
  await expect(page.getByTestId('stock-size-x')).toBeHidden();
  await page.getByTestId('stock-mode-fixed').check();
  await expect(page.getByTestId('stock-size-x')).toBeVisible();

  await expect(verdict(page)).toHaveText(
    'part exceeds stock X by 1.0 mm (with margins)part exceeds stock Y by 1.0 mm (with margins)',
  );
  await expect(verdict(page).locator('span')).toHaveText([
    'part exceeds stock X by 1.0 mm (with margins)',
    'part exceeds stock Y by 1.0 mm (with margins)',
  ]);
  await expect(verdict(page)).toHaveAttribute('data-tone', 'bad');
  let p = await probe(page);
  expect(p.color).toBe(STOCK_FAIL_COLOR);
  near(p.stock.max, [25, 25, 25]);
  near(p.part!.min, [2.5, 2.5, 4]); // centred in X/Y, top 1 mm under the stock top
  await page.locator('#viewport canvas').screenshot({ path: test.info().outputPath('stock-fails.png') });

  await setNumber(page, 'stock-size-x', '26');
  await setNumber(page, 'stock-size-y', '26');
  await expect(verdict(page)).toHaveText('fits: part in stock with margins, stock in the cutting area');
  p = await probe(page);
  expect(p.color).toBe(STOCK_COLOR);
  expect(errors).toEqual([]);
});

test('a 210 mm block fails the cutting area in X by 7 mm', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  await page.getByTestId('stock-mode-fixed').check();
  await expect(verdict(page)).toHaveText('stock fits the cutting area (no part loaded)');
  await setNumber(page, 'stock-size-x', '210');
  await setNumber(page, 'stock-size-y', '100');
  await setNumber(page, 'stock-size-z', '20');
  await expect(verdict(page)).toHaveText('stock exceeds cutting area X by 7.0 mm');
  const p = await probe(page);
  expect(p.visible).toBe(true);
  expect(p.color).toBe(STOCK_FAIL_COLOR);
  near(p.stock.max, [210, 100, 20]);
  expect(errors).toEqual([]);
});

test('a keep-out box under the stock is flagged and drawn; moving the stock clears it', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  await loadCube(page);
  expect((await probe(page)).keepOut).toEqual([]);
  await expect(page.getByTestId('keep-out-x')).toBeHidden();
  await page.getByTestId('keep-out-on').check();
  await expect(page.getByTestId('keep-out-x')).toBeVisible();
  for (const [id, v] of [['keep-out-x', '20'], ['keep-out-y', '10'], ['keep-out-w', '20'], ['keep-out-d', '20'], ['keep-out-h', '8']] as const) {
    await setNumber(page, id, v);
  }
  await expect(verdict(page)).toHaveText('stock overlaps keep-out box 1 by X 6.0 mm, Y 16.0 mm');
  let p = await probe(page);
  expect(p.color).toBe(STOCK_FAIL_COLOR);
  expect(p.keepOut).toEqual(['keep-out:0:outline', 'keep-out:0:hatch']);

  await setNumber(page, 'stock-bed-x', '100');
  await expect(verdict(page)).toHaveText('fits: part in stock with margins, stock in the cutting area');
  p = await probe(page);
  expect(p.color).toBe(STOCK_COLOR);
  near(p.stock.min, [100, 0, 0]);
  near(p.marker, [100, 0, 23]);
  near(p.part!.min, [103, 3, 2]);
  expect(errors).toEqual([]);
});

test('an empty allowance is not checked: the verdict names the field and the stock is hidden', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  await loadCube(page);
  await expect(verdict(page)).toHaveAttribute('data-tone', 'ok');
  await setNumber(page, 'allowance-top', '');
  await expect(verdict(page)).toHaveText('Not checked: Allowance top is empty');
  await expect(verdict(page)).toHaveAttribute('data-tone', 'warn');
  expect((await probe(page)).visible).toBe(false);
  await setNumber(page, 'allowance-top', '1');
  await expect(verdict(page)).toHaveAttribute('data-tone', 'ok');
  expect((await probe(page)).visible).toBe(true);
  expect(errors).toEqual([]);
});

test('the centre origin moves the WCS marker to the stock centre, still on top', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  await loadCube(page);
  await page.getByTestId('wcs-origin').selectOption('center-top');
  await expect(page.getByTestId('fit-wcs')).toHaveText('13, 13, 23 mm');
  near((await probe(page)).marker, [13, 13, 23]);
  expect(errors).toEqual([]);
});
