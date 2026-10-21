import { expect, test, type Page } from '@playwright/test';

interface Probe {
  names: string[];
  up: number[];
  cameraPos: number[];
  aspect: number;
  drawCalls: number;
  canvas: { w: number; h: number };
}

/** Reads the dev-only handle main.ts exposes; plain numbers only, nothing is changed. */
async function probe(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const h = (window as unknown as {
      __stlViewer: {
        machine: { scene: { traverse(fn: (o: { name: string }) => void): void } };
        viewport: {
          camera: { up: { toArray(): number[] }; position: { toArray(): number[] }; aspect: number };
          renderer: { info: { render: { calls: number } }; domElement: HTMLCanvasElement };
        };
      };
    }).__stlViewer;
    const names: string[] = [];
    h.machine.scene.traverse((o) => names.push(o.name));
    const c = h.viewport.renderer.domElement;
    return {
      names,
      up: h.viewport.camera.up.toArray(),
      cameraPos: h.viewport.camera.position.toArray(),
      aspect: h.viewport.camera.aspect,
      drawCalls: h.viewport.renderer.info.render.calls,
      canvas: { w: c.width, h: c.height },
    };
  });
}

test('the machine scene renders Z-up and orbits on drag', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');

  const canvas = page.locator('#viewport canvas');
  await expect(canvas).toBeVisible();
  await page.waitForFunction(() => '__stlViewer' in window);
  await expect.poll(async () => (await probe(page)).drawCalls).toBeGreaterThan(0);

  const before = await probe(page);
  expect(before.up).toEqual([0, 0, 1]);
  for (const name of ['bed', 'grid', 'axes', 'envelope:travel', 'envelope:cutting']) {
    expect(before.names).toContain(name);
  }
  expect(before.canvas.w).toBeGreaterThan(0);
  expect(before.canvas.h).toBeGreaterThan(0);
  await canvas.screenshot({ path: test.info().outputPath('viewport-home.png') });

  // Before the user moves the view, a resize re-frames the home view for the new shape.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await probe(page)).aspect).toBeCloseTo(390 / 844, 3);
  const narrow = await probe(page);
  expect(narrow.cameraPos).not.toEqual(before.cameraPos);
  await canvas.screenshot({ path: test.info().outputPath('viewport-narrow.png') });

  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 150, cy + 40, { steps: 10 });
  await page.mouse.up();

  await expect.poll(async () => (await probe(page)).cameraPos).not.toEqual(narrow.cameraPos);
  const after = await probe(page);
  expect(after.up).toEqual([0, 0, 1]);
  await canvas.screenshot({ path: test.info().outputPath('viewport-orbited.png') });

  expect(errors).toEqual([]);
});
