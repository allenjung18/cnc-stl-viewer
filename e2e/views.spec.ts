import { expect, test, type Page } from '@playwright/test';
import { dropFixture, ready } from './helpers';

interface Cam {
  ortho: boolean;
  type: string;
  /** World direction of "up on screen" (the camera's local +Y). */
  screenUp: number[];
  /** World direction of "right on screen" (the camera's local +X). */
  screenRight: number[];
  /** World direction the camera looks. */
  forward: number[];
  up: number[];
  view: string | null;
}

/** Reads the active camera from the dev-only handle; nothing is changed. */
async function cam(page: Page): Promise<Cam> {
  return page.evaluate(() => {
    const h = (window as unknown as {
      __stlViewer: {
        viewport: {
          camera: { type: string; up: { toArray(): number[] }; updateMatrixWorld(f: boolean): void; matrixWorld: { elements: number[] } };
          isOrtho: boolean;
          view: string | null;
        };
      };
    }).__stlViewer;
    const c = h.viewport.camera;
    c.updateMatrixWorld(true);
    const e = c.matrixWorld.elements;
    return {
      ortho: h.viewport.isOrtho,
      type: c.type,
      screenRight: [e[0]!, e[1]!, e[2]!],
      screenUp: [e[4]!, e[5]!, e[6]!],
      forward: [-e[8]!, -e[9]!, -e[10]!],
      up: c.up.toArray(),
      view: h.viewport.view,
    };
  });
}

const near = (got: number[], want: number[], eps = 1e-3): boolean => got.every((v, i) => Math.abs(v - want[i]!) < eps);

test('press 1 (top) then O: the camera is orthographic, looking down -Z with +Y up on screen', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  const canvas = page.locator('#viewport canvas');
  await expect(canvas).toBeVisible();
  expect((await cam(page)).type).toBe('PerspectiveCamera');

  await page.keyboard.press('1');
  await expect.poll(async () => near((await cam(page)).forward, [0, 0, -1])).toBe(true);
  const top = await cam(page);
  expect(top).toMatchObject({ ortho: false, type: 'PerspectiveCamera', view: 'top' });
  expect(near(top.screenUp, [0, 1, 0])).toBe(true);

  await page.keyboard.press('O');
  await expect.poll(async () => (await cam(page)).type).toBe('OrthographicCamera');
  const ortho = await cam(page);
  expect(ortho.ortho).toBe(true);
  expect(ortho.view).toBe('top');
  expect(near(ortho.forward, [0, 0, -1]), `forward ${ortho.forward}`).toBe(true);
  expect(near(ortho.screenUp, [0, 1, 0]), `screen up ${ortho.screenUp}`).toBe(true); // the back of the bed is up on screen
  expect(near(ortho.screenRight, [1, 0, 0]), `screen right ${ortho.screenRight}`).toBe(true);
  expect(ortho.up).toEqual([0, 0, 1]); // the orbit stays Z-up
  await expect(page.getByTestId('ortho-toggle')).toHaveAttribute('aria-pressed', 'true');
  await canvas.screenshot({ path: test.info().outputPath('top-ortho.png') });

  await page.keyboard.press('o');
  await expect.poll(async () => (await cam(page)).type).toBe('PerspectiveCamera');
  await expect(page.getByTestId('ortho-toggle')).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('keys 2-4 and the buttons show front, right and iso; a key typed into a field is the field\'s', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  await dropFixture(page, 'cube-20mm-binary.stl');
  await expect(page.locator('#load-status')).toHaveText('Loaded cube-20mm-binary.stl.');

  await page.keyboard.press('2');
  await expect.poll(async () => near((await cam(page)).forward, [0, 1, 0])).toBe(true);
  expect(near((await cam(page)).screenUp, [0, 0, 1])).toBe(true);
  await page.keyboard.press('3');
  await expect.poll(async () => near((await cam(page)).forward, [-1, 0, 0])).toBe(true);
  await page.getByTestId('view-iso').click();
  const s = 1 / Math.sqrt(3);
  await expect.poll(async () => near((await cam(page)).forward, [-s, s, -s])).toBe(true);
  await page.getByTestId('view-top').click();
  await expect.poll(async () => (await cam(page)).view).toBe('top');
  await page.getByTestId('ortho-toggle').click();
  await expect.poll(async () => (await cam(page)).ortho).toBe(true);

  // Typing "2" into the allowance changes the allowance, not the view.
  await page.getByTestId('allowance-xy').fill('');
  await page.getByTestId('allowance-xy').press('2');
  await expect(page.getByTestId('allowance-xy')).toHaveValue('2');
  const after = await cam(page);
  expect(after.view).toBe('top');
  expect(after.ortho).toBe(true);
  expect(errors).toEqual([]);
});
