import { closeSync, openSync, ftruncateSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { gridCubeStl } from '../test/fixtures/tiny-generator';
import { dropFixture, ready } from './helpers';

const field = (page: Page, key: string) => page.getByTestId(`part-${key}`);
const status = (page: Page) => page.locator('#load-status');

async function load(page: Page, name: string): Promise<void> {
  await dropFixture(page, name);
  await expect(status(page)).toHaveText(`Loaded ${name}.`);
  await expect(field(page, 'name')).toHaveText(name);
}

/** Waits for two frames, so a requested render has been drawn. */
const frames = (page: Page): Promise<void> =>
  page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

interface GpuInfo {
  geometries: number;
  textures: number;
  programs: number;
}
async function gpu(page: Page): Promise<GpuInfo> {
  await frames(page);
  return page.evaluate(() => {
    const info = (window as unknown as { __stlViewer: { viewport: { renderer: { info: { memory: { geometries: number; textures: number }; programs: unknown[] | null } } } } })
      .__stlViewer.viewport.renderer.info;
    return { geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs?.length ?? 0 };
  });
}

/** The outline of the part on the bed: vertex count and visibility, or null without one. */
const outline = (page: Page) =>
  page.evaluate(() => {
    const p = (window as unknown as { __stlViewer: { part: { featureEdges: { visible: boolean; geometry: { getAttribute(n: string): { count: number } } } | null } | null } }).__stlViewer.part;
    const f = p?.featureEdges;
    return f ? { vertices: f.geometry.getAttribute('position').count, visible: f.visible } : null;
  });

test('3MF: the cube reads mm from the file with the STL cube’s stats; an inch 3MF reads 25.4 mm; the STL units choice is kept', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  // Set the STL choice to inches first: a 3MF must ignore it, and the next STL must still get it.
  await load(page, 'inch-cube.stl');
  await page.getByTestId('units-toggle').click();
  await expect(page.getByTestId('units-value')).toHaveText('inches (×25.4)');

  await load(page, 'cube-20mm.3mf');
  await expect(field(page, 'format')).toHaveText('3MF');
  await expect(page.getByTestId('units-value')).toHaveText('mm (from the file)');
  await expect(page.getByTestId('units-toggle')).toBeDisabled();
  await expect(page.getByTestId('units-hint')).toBeHidden();
  await expect(field(page, 'size')).toHaveText('20 × 20 × 20 mm');
  await expect(field(page, 'volume')).toHaveText('8,000 mm³');
  await expect(field(page, 'area')).toHaveText('2,400 mm²');
  await expect(field(page, 'triangles')).toHaveText('12');
  await expect(field(page, 'vertices')).toHaveText('8');
  await expect(field(page, 'watertight')).toHaveText('yes');

  await load(page, 'cube-1in.3mf');
  await expect(page.getByTestId('units-value')).toHaveText('inch (from the file, ×25.4 to mm)');
  await expect(field(page, 'size')).toHaveText('25.4 × 25.4 × 25.4 mm');
  await expect(field(page, 'volume')).toHaveText('16,387.064 mm³');
  await page.getByTestId('copy-setup').click();
  expect(await page.evaluate(() => (window as unknown as { __stlViewer: { setupSheet: string } }).__stlViewer.setupSheet)).toContain(
    'Units: inch, stated by the file (×25.4 to mm)',
  );

  await load(page, 'inch-cube.stl');
  await expect(page.getByTestId('units-value')).toHaveText('inches (×25.4)');
  await expect(page.getByTestId('units-toggle')).toBeEnabled();
  await expect(field(page, 'size')).toHaveText('25.4 × 25.4 × 25.4 mm');
  expect(errors).toEqual([]);
});

test('GPU memory: 20 drops leave as many geometries, textures and programs as two (old parts are disposed)', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  // Alternate a part with an outline only and one with problem edges too, so every overlay is made and freed.
  const names = ['cube-20mm-binary.stl', 'bowtie.stl'];
  const seen: GpuInfo[] = [];
  for (let i = 0; i < 20; i++) {
    await load(page, names[i % 2]!);
    seen.push(await gpu(page));
  }
  console.info(`renderer.info after drops 1, 2, 19, 20: ${JSON.stringify([seen[0], seen[1], seen[18], seen[19]])}`);
  expect(seen[19]).toEqual(seen[1]);
  expect(seen[18]).toEqual(seen[0]);
  expect(errors).toEqual([]);
});

test('outline: drawn for the cube (12 edges), hidden and shown by the toggle, kept off for the next part', async ({ page }) => {
  await ready(page, [], []);
  await expect(page.getByTestId('edges-toggle')).toBeDisabled();
  await load(page, 'cube-20mm-binary.stl');
  await expect(page.getByTestId('edges-toggle')).toBeEnabled();
  await expect(page.getByTestId('edges-toggle')).toBeChecked();
  expect(await outline(page)).toEqual({ vertices: 24, visible: true });
  await page.getByTestId('edges-toggle').uncheck();
  expect(await outline(page)).toEqual({ vertices: 24, visible: false });
  await load(page, 'box-10x20x80.stl');
  expect(await outline(page)).toEqual({ vertices: 24, visible: false });
  await page.getByTestId('edges-toggle').check();
  expect(await outline(page)).toEqual({ vertices: 24, visible: true });
  await expect(page.getByTestId('edges-note')).toHaveText('');
});

test('thinnest-slab hint: names the axis, warns below the end mill, follows the orientation, and the tool survives a reload', async ({ page }) => {
  await ready(page, [], []);
  await expect(page.getByTestId('tool-diameter')).toHaveValue('3.175');
  await load(page, 'box-10x20x80.stl');
  await expect(field(page, 'thinnest')).toHaveText('10 mm along X (bounding box only: walls inside the part are not checked)');
  await page.getByTestId('tool-diameter').fill('12');
  await expect(field(page, 'thinnest')).toHaveText(
    '10 mm along X, thinner than the 12 mm end mill: check it can be cut and held (bounding box only: walls inside the part are not checked)',
  );
  await page.getByTestId('rotate-y').click(); // stands the 10 mm side up: X and Z swap
  await expect(field(page, 'thinnest')).toContainText('10 mm along Z, thinner than the 12 mm end mill');
  await page.getByTestId('tool-diameter').fill('0');
  await expect(page.getByTestId('tool-diameter')).toHaveAttribute('aria-invalid', 'true');
  await expect(field(page, 'thinnest')).toContainText('thinner than the 12 mm end mill'); // an invalid entry keeps the last good one
  await page.reload();
  await expect(page.getByTestId('tool-diameter')).toHaveValue('12');
});

test('a file over 500 MB is refused by name before it is read, and the part on the bed stays', async ({ page }, testInfo) => {
  await ready(page, [], []);
  await load(page, 'cube-20mm-binary.stl');
  // A sparse file: 600 MB long, no disk space used, never read by the page.
  const path = testInfo.outputPath('huge.stl');
  const fd = openSync(path, 'w');
  ftruncateSync(fd, 600 * 1024 * 1024);
  closeSync(fd);
  await page.locator('#file-input').setInputFiles(path);
  await expect(status(page)).toHaveText('huge.stl is 600.0 MB; files over 500.0 MB are refused.');
  await expect(status(page)).toHaveClass(/error/);
  await expect(field(page, 'name')).toHaveText('cube-20mm-binary.stl');
});

test('a 100 MB STL loads without freezing the tab: progress shown, the main thread never stalls long, the outline is off', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const n = 419; // 12 · 419² = 2,106,732 triangles, 100.5 MB
  const path = testInfo.outputPath('grid-cube-100mb.stl');
  writeFileSync(path, gridCubeStl(n, 100));
  const errors: string[] = [];
  await ready(page, errors, []);

  // Watch the main thread: a 20 ms timer whose longest gap is the longest freeze, and every status line shown.
  await page.evaluate(() => {
    const w = window as unknown as { __watch: { maxGap: number; statuses: string[]; bar: boolean; stop: () => void } };
    let last = performance.now();
    const watch = { maxGap: 0, statuses: [] as string[], bar: false, stop: () => {} };
    const timer = setInterval(() => {
      const now = performance.now();
      watch.maxGap = Math.max(watch.maxGap, now - last);
      last = now;
    }, 20);
    const statusEl = document.getElementById('load-status')!;
    const bar = document.getElementById('load-progress')!;
    const mo = new MutationObserver(() => {
      watch.statuses.push(statusEl.textContent ?? '');
      if (!bar.hidden) watch.bar = true;
    });
    mo.observe(statusEl, { childList: true, characterData: true, subtree: true });
    watch.stop = () => {
      clearInterval(timer);
      mo.disconnect();
    };
    w.__watch = watch;
  });

  const t0 = Date.now();
  await page.locator('#file-input').setInputFiles(path);
  await expect(status(page)).toHaveText('Loaded grid-cube-100mb.stl.', { timeout: 150_000 });
  await frames(page); // the first frame with the part drawn counts too
  const wall = Date.now() - t0;
  const watch = await page.evaluate(() => {
    const w = (window as unknown as { __watch: { maxGap: number; statuses: string[]; bar: boolean; stop: () => void } }).__watch;
    w.stop();
    return { maxGap: w.maxGap, statuses: w.statuses, bar: w.bar };
  });
  const timings = await page.evaluate(() => (window as unknown as { __stlViewer: { lastLoad: unknown } }).__stlViewer.lastLoad);
  console.info(`100 MB STL: ${wall} ms to loaded; longest main-thread gap ${Math.round(watch.maxGap)} ms; worker ${JSON.stringify(timings)}`);

  await expect(field(page, 'triangles')).toHaveText((12 * n * n).toLocaleString('en-US'));
  await expect(field(page, 'watertight')).toHaveText('yes');
  // Progress came from the worker while it read the triangles, then while it checked the mesh.
  expect(watch.statuses.some((s) => /^Reading grid-cube-100mb\.stl… [\d,]+ of 2,106,732 triangles \(\d+%\)$/.test(s))).toBe(true);
  expect(watch.statuses).toContain('Checking the mesh of grid-cube-100mb.stl (2,106,732 triangles)…');
  expect(watch.bar).toBe(true);
  await expect(page.getByTestId('load-progress')).toBeHidden();
  // Over the cut-off: no outline, and the page says why.
  expect(await outline(page)).toBeNull();
  await expect(page.getByTestId('edges-toggle')).toBeDisabled();
  await expect(page.getByTestId('edges-note')).toHaveText('Outline off: over 2,000,000 triangles.');
  // Not frozen: the page kept running its timers throughout (a freeze is a gap of seconds).
  expect(watch.maxGap).toBeLessThan(1500);
  expect(errors).toEqual([]);
});
