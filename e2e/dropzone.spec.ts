import { expect, test, type Page } from '@playwright/test';
import { dropFixture, ready } from './helpers';

interface PartProbe {
  min: number[];
  max: number[];
  inScene: boolean;
}

/** Reads the dev-only handle main.ts exposes: the placed part's world box, or null. */
async function partProbe(page: Page): Promise<PartProbe | null> {
  return page.evaluate(() => {
    const h = (window as unknown as {
      __stlViewer: {
        part: {
          object: {
            parent: unknown;
            updateMatrixWorld(force: boolean): void;
            geometry: { boundingBox: { clone(): { applyMatrix4(m: unknown): { min: { toArray(): number[] }; max: { toArray(): number[] } } } } };
            matrixWorld: unknown;
          };
        } | null;
        machine: { scene: unknown };
      };
    }).__stlViewer;
    const part = h.part;
    if (!part) return null;
    part.object.updateMatrixWorld(true);
    const box = part.object.geometry.boundingBox.clone().applyMatrix4(part.object.matrixWorld);
    return { min: box.min.toArray(), max: box.max.toArray(), inScene: part.object.parent === h.machine.scene };
  });
}

const triangles = (page: Page) => page.getByTestId('part-triangles');
const status = (page: Page) => page.locator('#load-status');

for (const [name, format] of [
  ['cube-20mm-binary.stl', 'binary STL'],
  ['cube-20mm-ascii.stl', 'ASCII STL'],
] as const) {
  test(`dropping ${name} shows 12 triangles and puts the cube in its stock on the bed, not centred`, async ({ page }) => {
    const errors: string[] = [];
    const workers: string[] = [];
    await ready(page, errors, workers);
    expect(await partProbe(page)).toBeNull();

    const size = await dropFixture(page, name);
    expect(size).toBeGreaterThan(84);

    await expect(triangles(page)).toHaveText('12');
    await expect(page.locator('#part-name')).toHaveText(name);
    await expect(page.locator('#part-format')).toHaveText(format);
    await expect(status(page)).toHaveText(`Loaded ${name}.`);

    const part = await partProbe(page);
    expect(part).not.toBeNull();
    expect(part!.inScene).toBe(true);
    // Placed, not centred (the file has it at (10, -5, 3)): its min corner sits in the default
    // stock (allowance 3 a side, 2 underneath) whose front-left corner is the bed origin.
    expect(part!.min).toEqual([3, 3, 2]);
    expect(part!.max).toEqual([23, 23, 22]);
    // Parsed off the main thread, in the parse worker.
    expect(workers.some((u) => u.includes('parse.worker'))).toBe(true);

    await page.locator('#viewport canvas').screenshot({ path: test.info().outputPath(`${name}.png`) });
    expect(errors).toEqual([]);
  });
}

test('a truncated file shows an error and leaves the previous part on the bed', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);

  await dropFixture(page, 'inch-cube.stl');
  await expect(triangles(page)).toHaveText('12');
  const before = await partProbe(page);
  expect(before!.max).toEqual([4, 4, 3]); // 1 mm cube at (3, 3, 2) in its stock

  await dropFixture(page, 'cube-20mm-binary.stl', 400);
  await expect(status(page)).toHaveText(/^cube-20mm-binary\.stl: The binary STL is truncated/);
  await expect(status(page)).toHaveAttribute('role', 'alert');
  await expect(page.locator('#part-name')).toHaveText('inch-cube.stl');
  expect(await partProbe(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test('the Open button file picker loads a file too', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open STL or 3MF…' }).click();
  await (await chooser).setFiles('test/fixtures/cube-20mm-ascii.stl');
  await expect(triangles(page)).toHaveText('12');
  await expect(page.locator('#part-format')).toHaveText('ASCII STL');
  expect((await partProbe(page))!.min).toEqual([3, 3, 2]);
  expect(errors).toEqual([]);
});
