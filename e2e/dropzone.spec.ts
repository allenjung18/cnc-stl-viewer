import { expect, test, type Page } from '@playwright/test';

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

/**
 * Fetches a fixture from the dev server and dispatches a real drag-and-drop of
 * it (dragenter, dragover, drop) on the page, as a file dragged from the desktop.
 * `cut` keeps only the first bytes, to make a truncated file.
 */
async function dropFixture(page: Page, name: string, cut?: number): Promise<number> {
  return page.evaluate(
    async ({ name, cut }) => {
      const res = await fetch(`/test/fixtures/${name}`);
      if (!res.ok) throw new Error(`fixture ${name}: HTTP ${res.status}`);
      const bytes = (await res.arrayBuffer()).slice(0, cut ?? undefined);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: 'model/stl' }));
      for (const type of ['dragenter', 'dragover', 'drop']) {
        document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
      return bytes.byteLength;
    },
    { name, cut: cut ?? null },
  );
}

async function ready(page: Page, errors: string[], workers: string[]): Promise<void> {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('worker', (w) => workers.push(w.url()));
  await page.goto('/');
  await page.waitForFunction(() => '__stlViewer' in window);
}

const triangles = (page: Page) => page.getByTestId('part-triangles');
const status = (page: Page) => page.locator('#load-status');

for (const [name, format] of [
  ['cube-20mm-binary.stl', 'binary STL'],
  ['cube-20mm-ascii.stl', 'ASCII STL'],
] as const) {
  test(`dropping ${name} shows 12 triangles and puts the cube on the bed, min corner at the origin`, async ({ page }) => {
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
    expect(part!.min).toEqual([0, 0, 0]); // placed, not centred: the file has it at (10, -5, 3)
    expect(part!.max).toEqual([20, 20, 20]);
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
  expect(before!.max).toEqual([1, 1, 1]);

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
  await page.getByRole('button', { name: 'Open STL…' }).click();
  await (await chooser).setFiles('test/fixtures/cube-20mm-ascii.stl');
  await expect(triangles(page)).toHaveText('12');
  await expect(page.locator('#part-format')).toHaveText('ASCII STL');
  expect((await partProbe(page))!.min).toEqual([0, 0, 0]);
  expect(errors).toEqual([]);
});
