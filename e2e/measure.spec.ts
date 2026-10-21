import { expect, test, type Page } from '@playwright/test';
import { dropFixture, ready } from './helpers';

/** Where a point of the part's own (file) space lands on the page, CSS px. */
async function onScreen(page: Page, world: [number, number, number]): Promise<{ x: number; y: number }> {
  return page.evaluate((w) => {
    type V = { set(x: number, y: number, z: number): V; project(c: unknown): V; x: number; y: number };
    const h = (window as unknown as {
      __stlViewer: { viewport: { camera: unknown; renderer: { domElement: HTMLCanvasElement } }; part: { object: { position: { clone(): V } } } };
    }).__stlViewer;
    const ndc = h.part.object.position.clone().set(w[0], w[1], w[2]).project(h.viewport.camera);
    const r = h.viewport.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((ndc.x + 1) / 2) * r.width, y: r.top + ((1 - ndc.y) / 2) * r.height };
  }, world);
}

async function measured(page: Page): Promise<{ points: number[][]; distance: number | null; measuring: boolean }> {
  return page.evaluate(() => {
    const m = (window as unknown as {
      __stlViewer: { measure: { points: number[][]; measurement: { distanceMm: number } | null; measuring: boolean } };
    }).__stlViewer.measure;
    return { points: m.points, distance: m.measurement?.distanceMm ?? null, measuring: m.measuring };
  });
}

/** A click a few px from `p` toward `toward` (inside the part's outline), so the snap has to do the rest. */
async function clickNear(page: Page, p: { x: number; y: number }, toward: { x: number; y: number }, px = 3): Promise<void> {
  const len = Math.hypot(toward.x - p.x, toward.y - p.y);
  await page.mouse.click(p.x + ((toward.x - p.x) / len) * px, p.y + ((toward.y - p.y) / len) * px);
}

test('two-point measure: opposite corners of the 20 mm cube read 20√3, with a label; Esc clears', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  await expect(page.getByTestId('measure-toggle')).toBeDisabled();
  await dropFixture(page, 'cube-20mm-binary.stl');
  await expect(page.locator('#load-status')).toHaveText('Loaded cube-20mm-binary.stl.');
  await page.keyboard.press('4'); // iso: the near-bottom-left and far-top-right corners are both in sight

  await page.getByTestId('measure-toggle').click();
  await expect(page.getByTestId('measure-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('measure-info')).toContainText('Click a point on the part');

  // The part sits at (3, 3, 2) in its stock: its corners on the bed are (3, 3, 2) and (23, 23, 22).
  const a = await onScreen(page, [3, 3, 2]);
  const b = await onScreen(page, [23, 23, 22]);
  const mid = await onScreen(page, [13, 13, 12]);
  await clickNear(page, a, mid);
  await expect(page.getByTestId('measure-info')).toContainText('Click the second point');
  await clickNear(page, b, mid);

  await expect.poll(async () => (await measured(page)).distance).not.toBeNull();
  const m = await measured(page);
  expect(Math.abs(m.distance! - 20 * Math.sqrt(3))).toBeLessThan(1e-4);
  m.points[0]!.forEach((v, i) => expect(Math.abs(v - [3, 3, 2][i]!)).toBeLessThan(1e-4));
  m.points[1]!.forEach((v, i) => expect(Math.abs(v - [23, 23, 22][i]!)).toBeLessThan(1e-4));
  await expect(page.getByTestId('measure-info')).toHaveText('Distance 34.641 mm (ΔX 20, ΔY 20, ΔZ 20 mm)');
  await expect(page.getByTestId('measure-label')).toBeVisible();
  await expect(page.getByTestId('measure-label')).toHaveText('34.641 mm');
  await page.locator('#viewport canvas').screenshot({ path: test.info().outputPath('measure-iso.png') });

  // The measure follows the part: as inches it reads 25.4 × as long.
  await page.getByTestId('units-toggle').click();
  await expect(page.getByTestId('measure-info')).toHaveText('Distance 879.882 mm (ΔX 508, ΔY 508, ΔZ 508 mm)');
  await page.getByTestId('units-toggle').click();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('measure-label')).toBeHidden();
  await expect(page.getByTestId('measure-info')).toHaveText('');
  expect(await measured(page)).toMatchObject({ points: [], distance: null, measuring: false });
  expect(errors).toEqual([]);
});
