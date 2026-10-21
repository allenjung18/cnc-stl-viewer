import { expect, test, type Page } from '@playwright/test';
import { dropFixture, ready } from './helpers';

const field = (page: Page, key: string) => page.getByTestId(`part-${key}`);

async function load(page: Page, name: string): Promise<void> {
  await dropFixture(page, name);
  await expect(page.locator('#load-status')).toHaveText(`Loaded ${name}.`);
  await expect(field(page, 'name')).toHaveText(name);
}

/** The drawn part's world box and scale, and the units the page reports. */
async function drawn(page: Page): Promise<{ min: number[]; max: number[]; scale: number; units: string; volume: number }> {
  return page.evaluate(() => {
    type Box = { min: { toArray(): number[] }; max: { toArray(): number[] } };
    const h = (window as unknown as {
      __stlViewer: {
        part: { object: { updateMatrixWorld(f: boolean): void; geometry: { computeBoundingBox(): void; boundingBox: { clone(): { applyMatrix4(m: unknown): Box } } }; matrixWorld: unknown }; unitScale: number };
        units: string;
        stats: { volumeMm3: number };
      };
    }).__stlViewer;
    const o = h.part.object;
    o.updateMatrixWorld(true);
    o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
    return { min: b.min.toArray(), max: b.max.toArray(), scale: h.part.unitScale, units: h.units, volume: h.stats.volumeMm3 };
  });
}

const close = (got: number[], want: number[]): void => {
  expect(got).toHaveLength(want.length);
  got.forEach((v, i) => expect(Math.abs(v - want[i]!), `[${i}] ${v} vs ${want[i]}`).toBeLessThan(1e-4));
};

test('inch cube: the hint shows, ×25.4 rescales size, volume and mesh, and the choice survives a reload', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  await expect(page.getByTestId('units-value')).toHaveText('mm (STL has no units)');
  await expect(page.getByTestId('units-hint')).toBeHidden();

  await load(page, 'inch-cube.stl');
  await expect(page.getByTestId('units-hint')).toHaveText('looks like inches');
  await expect(page.getByTestId('units-hint')).toBeVisible();
  await expect(field(page, 'size')).toHaveText('1 × 1 × 1 mm');
  await expect(field(page, 'volume')).toHaveText('1 mm³');
  close((await drawn(page)).max, [1, 1, 1]);

  await page.getByTestId('units-toggle').click();
  await expect(page.getByTestId('units-value')).toHaveText('inches (×25.4)');
  await expect(page.getByTestId('units-toggle')).toHaveText('Treat as mm');
  await expect(page.getByTestId('units-hint')).toBeHidden();
  await expect(field(page, 'size')).toHaveText('25.4 × 25.4 × 25.4 mm');
  await expect(field(page, 'volume')).toHaveText('16,387.064 mm³');
  await expect(field(page, 'area')).toHaveText('3,870.96 mm²');
  const after = await drawn(page);
  expect(after).toMatchObject({ scale: 25.4, units: 'in' });
  close(after.min, [0, 0, 0]);
  close(after.max, [25.4, 25.4, 25.4]);
  expect(Math.abs(after.volume - 16387.064)).toBeLessThanOrEqual(1e-6);

  // A reload keeps the choice: the next part loads as inches.
  await page.reload();
  await page.waitForFunction(() => '__stlViewer' in window);
  await expect(page.getByTestId('units-value')).toHaveText('inches (×25.4)');
  await load(page, 'inch-cube.stl');
  await expect(field(page, 'size')).toHaveText('25.4 × 25.4 × 25.4 mm');
  close((await drawn(page)).max, [25.4, 25.4, 25.4]);

  // And back to mm, which is kept too.
  await page.getByTestId('units-toggle').click();
  await expect(field(page, 'size')).toHaveText('1 × 1 × 1 mm');
  close((await drawn(page)).max, [1, 1, 1]);
  await page.reload();
  await page.waitForFunction(() => '__stlViewer' in window);
  await expect(page.getByTestId('units-value')).toHaveText('mm (STL has no units)');
  expect(errors).toEqual([]);
});

test('20 mm cube: no hint; treated as inches it says it does not fit', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  await load(page, 'cube-20mm-binary.stl');
  await expect(field(page, 'size')).toHaveText('20 × 20 × 20 mm');
  await expect(page.getByTestId('units-hint')).toBeHidden();
  await page.getByTestId('units-toggle').click();
  await expect(field(page, 'size')).toHaveText('508 × 508 × 508 mm');
  await expect(page.getByTestId('units-hint')).toHaveText(/larger than the cutting area/);
  expect(errors).toEqual([]);
});
