import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { dropFixture, ready } from './helpers';

const KEY = 'cnc-stl-viewer.profile';

async function loadCube(page: Page): Promise<void> {
  await dropFixture(page, 'cube-20mm-binary.stl');
  await expect(page.locator('#load-status')).toHaveText('Loaded cube-20mm-binary.stl.');
}

/** The cutting-area box as drawn: its size from the scene, mm. */
async function drawnCuttingArea(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    type Box = { min: { toArray(): number[] }; max: { toArray(): number[] } };
    const h = (window as unknown as {
      __stlViewer: { machine: { cuttingBox: { geometry: { computeBoundingBox(): void; boundingBox: Box } } } };
    }).__stlViewer;
    const g = h.machine.cuttingBox.geometry;
    g.computeBoundingBox();
    const min = g.boundingBox.min.toArray();
    const max = g.boundingBox.max.toArray();
    return max.map((v, i) => Math.round((v - min[i]!) * 1000) / 1000);
  });
}

test('the stock inputs and origin survive a reload', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  await page.getByTestId('allowance-xy').fill('5');
  await page.getByTestId('stock-mode-fixed').check();
  await page.getByTestId('stock-size-x').fill('40');
  await page.getByTestId('wcs-origin').selectOption('center-top');
  await page.getByTestId('keep-out-on').check();
  await page.getByTestId('keep-out-x').fill('150');
  await page.getByTestId('stock-bed-y').fill('12.5');

  await page.reload();
  await page.waitForFunction(() => '__stlViewer' in window);
  await expect(page.getByTestId('allowance-xy')).toHaveValue('5');
  await expect(page.getByTestId('stock-mode-fixed')).toBeChecked();
  await expect(page.getByTestId('stock-size-x')).toHaveValue('40');
  await expect(page.getByTestId('stock-size-x')).toBeVisible(); // the fixed-block fields show for a restored fixed mode
  await expect(page.getByTestId('wcs-origin')).toHaveValue('center-top');
  await expect(page.getByTestId('keep-out-on')).toBeChecked();
  await expect(page.getByTestId('keep-out-x')).toHaveValue('150');
  await expect(page.getByTestId('stock-bed-y')).toHaveValue('12.5');
  // The restored inputs are what the fit runs on.
  await loadCube(page);
  await expect(page.getByTestId('fit-stock-size')).toHaveText('40 × 25 × 25 mm');
  expect(errors).toEqual([]);
});

test('a corrupt stored profile falls back to the defaults and the page still works', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  await page.evaluate((key) => localStorage.setItem(key, '{"format":"cnc-stl-viewer/profile","version":1,"machine":{'), KEY);
  await page.reload();
  await page.waitForFunction(() => '__stlViewer' in window);
  await expect(page.getByTestId('allowance-xy')).toHaveValue('3');
  await expect(page.getByTestId('stock-mode-auto')).toBeChecked();
  await expect(page.getByTestId('wcs-origin')).toHaveValue('bottom-left-front-top');
  expect(await drawnCuttingArea(page)).toEqual([203, 203, 76]);
  await loadCube(page);
  await expect(page.getByTestId('fit-stock-size')).toHaveText('26 × 26 × 23 mm');
  expect(errors).toEqual([]);
});

test('export, edit, import: the profile applies at once, the part stays loaded, a bad file changes nothing', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  await loadCube(page);
  await page.getByTestId('allowance-top').fill('1.5');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('profile-export').click()]);
  expect(download.suggestedFilename()).toBe('nomad-883-pro.profile.json');
  const path = await download.path();
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  expect(doc).toMatchObject({
    format: 'cnc-stl-viewer/profile',
    version: 1,
    machine: { name: 'Nomad 883 Pro', travel: [250, 250, 100], cuttingArea: [203, 203, 76] },
    stock: { mode: 'auto', allowance: { xy: 3, top: 1.5, bottom: 2 } },
    setup: { origin: 'bottom-left-front-top', stockOnBed: [0, 0, 0] },
  });

  // A bad file is refused by name and changes nothing.
  await page.getByTestId('profile-file').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{"format":') });
  await expect(page.getByTestId('profile-status')).toHaveText('broken.json: not JSON; nothing changed.');
  await expect(page.getByTestId('allowance-top')).toHaveValue('1.5');

  // A smaller machine and a fixed 190 mm block: the bed redraws and the fit uses the new cutting area.
  doc.machine.cuttingArea = [180, 180, 60];
  doc.stock = { mode: 'fixed', allowance: { xy: 2, top: 1, bottom: 1 }, size: [190, 50, 20] };
  await page.getByTestId('profile-file').setInputFiles({ name: 'shop.profile.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.getByTestId('profile-status')).toHaveText('Imported shop.profile.json.');
  await expect(page.getByTestId('allowance-xy')).toHaveValue('2');
  await expect(page.getByTestId('stock-mode-fixed')).toBeChecked();
  await expect(page.getByTestId('stock-size-x')).toHaveValue('190');
  expect(await drawnCuttingArea(page)).toEqual([180, 180, 60]);
  await expect(page.getByTestId('fit-verdict')).toContainText('stock exceeds cutting area X by 10.0 mm');
  await expect(page.getByTestId('part-name')).toHaveText('cube-20mm-binary.stl');
  const partInScene = await page.evaluate(() => {
    const h = (window as unknown as { __stlViewer: { part: { object: { parent: unknown } }; machine: { scene: unknown } } }).__stlViewer;
    return h.part.object.parent === h.machine.scene;
  });
  expect(partInScene).toBe(true);

  // And it is what the next visit loads.
  await page.reload();
  await page.waitForFunction(() => '__stlViewer' in window);
  await expect(page.getByTestId('stock-size-x')).toHaveValue('190');
  expect(await drawnCuttingArea(page)).toEqual([180, 180, 60]);
  expect(errors).toEqual([]);
});

test('copy setup sheet: stock size, origin and the fit verdict as text on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors: string[] = [];
  await ready(page, errors, []);
  await loadCube(page);
  await page.getByTestId('copy-setup').click();
  await expect(page.getByTestId('profile-status')).toHaveText('Setup sheet copied to the clipboard.');
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain('Part: cube-20mm-binary.stl');
  expect(text).toContain('Stock X × Y × Z: 26 × 26 × 23 mm');
  expect(text).toContain('WCS origin: front-left corner of the stock, Z0 on the stock top');
  expect(text).toContain('Part offset in stock (part min corner from stock front-left-bottom): X 3, Y 3, Z 2 mm');
  expect(text).toContain('Fit: fits');
  await expect(page.getByTestId('setup-sheet')).toBeHidden();
  expect(errors).toEqual([]);
});

test('export with an invalid input on screen exports nothing and says why', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  await page.getByTestId('allowance-top').fill('-1');
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.getByTestId('profile-export').click();
  await expect(page.getByTestId('profile-status')).toHaveText('Not exported: Allowance top must be 0 or more.');
  expect(downloads).toBe(0);
  expect(errors).toEqual([]);
});

test('the setup sheet names a fit check that refused the inputs, never "load a part"', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors: string[] = [];
  await ready(page, errors, []);
  await loadCube(page);
  await page.getByTestId('allowance-xy').fill('1e308');
  await expect(page.getByTestId('fit-verdict')).toContainText('Not checked:');
  await page.getByTestId('copy-setup').click();
  await expect(page.getByTestId('profile-status')).toHaveText('Setup sheet copied to the clipboard.');
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain('Part: cube-20mm-binary.stl');
  expect(text.trimEnd().split('\n').at(-1)).toMatch(/^Not checked: /);
  expect(text).not.toContain('Load a part');
  expect(errors).toEqual([]);
});
