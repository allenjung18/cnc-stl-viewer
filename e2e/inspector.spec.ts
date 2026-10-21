import { expect, test, type Page } from '@playwright/test';
import { dropFixture, ready } from './helpers';

interface Overlay {
  /** Vertices in the line overlay (2 per edge), or null when it is not drawn. */
  open: number | null;
  nonManifold: number | null;
  openColor: number | null;
  nonManifoldColor: number | null;
  /** World-space box of the open-edge overlay, when drawn. */
  openWorld: { min: number[]; max: number[] } | null;
  volume: number;
}

/** Reads the dev-only handle: the part's problem-edge overlays and the raw stats. */
async function overlay(page: Page): Promise<Overlay> {
  return page.evaluate(() => {
    type Lines = {
      parent: unknown;
      material: { color: { getHex(): number } };
      geometry: {
        getAttribute(n: string): { count: number };
        computeBoundingBox(): void;
        boundingBox: { clone(): { applyMatrix4(m: unknown): { min: { toArray(): number[] }; max: { toArray(): number[] } } } };
      };
      updateMatrixWorld(force: boolean): void;
      matrixWorld: unknown;
    } | null;
    const h = (window as unknown as {
      __stlViewer: { part: { object: unknown; openEdges: Lines; nonManifoldEdges: Lines }; stats: { volumeMm3: number } };
    }).__stlViewer;
    const { openEdges: o, nonManifoldEdges: n } = h.part;
    let openWorld = null;
    if (o) {
      o.updateMatrixWorld(true);
      o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
      openWorld = { min: b.min.toArray(), max: b.max.toArray() };
    }
    return {
      open: o && o.parent === h.part.object ? o.geometry.getAttribute('position').count : null,
      nonManifold: n && n.parent === h.part.object ? n.geometry.getAttribute('position').count : null,
      openColor: o ? o.material.color.getHex() : null,
      nonManifoldColor: n ? n.material.color.getHex() : null,
      openWorld,
      volume: h.stats.volumeMm3,
    };
  });
}

const field = (page: Page, key: string) => page.getByTestId(`part-${key}`);

async function expectPanel(page: Page, want: Record<string, string | RegExp>): Promise<void> {
  for (const [key, value] of Object.entries(want)) await expect(field(page, key), key).toHaveText(value);
}

async function load(page: Page, name: string): Promise<void> {
  await dropFixture(page, name);
  await expect(page.locator('#load-status')).toHaveText(`Loaded ${name}.`);
  await expect(field(page, 'name')).toHaveText(name);
}

const RED = 0xff3b30;
const MAGENTA = 0xff3df5;

for (const name of ['cube-20mm-binary.stl', 'cube-20mm-ascii.stl']) {
  test(`${name}: the panel shows 20 mm, 8000 mm³, 2400 mm², 12 triangles, 8 vertices, watertight`, async ({ page }) => {
    const errors: string[] = [];
    await ready(page, errors, []);
    await load(page, name);
    await expectPanel(page, {
      size: '20 × 20 × 20 mm',
      volume: '8,000 mm³',
      area: '2,400 mm²',
      triangles: '12',
      vertices: '8',
      watertight: 'yes',
      'open-edges': '0',
      'non-manifold-edges': '0',
      degenerate: '0',
      normals: 'outward',
    });
    const o = await overlay(page);
    expect(o).toMatchObject({ open: null, nonManifold: null });
    expect(Math.abs(o.volume - 8000)).toBeLessThanOrEqual(1e-6);
    expect(errors).toEqual([]);
  });
}

test('open-box.stl: 4 open edges, drawn in red along the rim of the missing top', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  await load(page, 'open-box.stl');
  await expectPanel(page, {
    triangles: '10',
    watertight: 'no — 4 open edges',
    'open-edges': '4',
    'non-manifold-edges': '0',
    volume: /^≈ .* mm³ \(mesh is open\)$/,
    normals: 'not judged: the mesh is not closed',
  });
  await expect(field(page, 'open-edges')).toHaveAttribute('data-tone', 'bad');
  await expect(page.locator('#part-info .swatch')).toHaveCount(1);
  const o = await overlay(page);
  expect(o).toMatchObject({ open: 8, nonManifold: null, openColor: RED });
  expect(o.openWorld).toEqual({ min: [0, 0, 20], max: [20, 20, 20] }); // placed with the part
  await page.locator('#viewport canvas').screenshot({ path: test.info().outputPath('open-box.png') });
  expect(errors).toEqual([]);
});

test('bowtie.stl: 1 non-manifold edge, drawn in magenta', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  await load(page, 'bowtie.stl');
  await expectPanel(page, {
    triangles: '24',
    vertices: '14',
    watertight: 'no — 1 non-manifold edge',
    'open-edges': '0',
    'non-manifold-edges': '1',
    volume: '≈ 2,000 mm³ (mesh is not manifold)',
  });
  const o = await overlay(page);
  expect(o).toMatchObject({ open: null, nonManifold: 2, nonManifoldColor: MAGENTA });
  await page.locator('#viewport canvas').screenshot({ path: test.info().outputPath('bowtie.png') });
  expect(errors).toEqual([]);
});

test('cube-reversed-winding.stl: volume -8000 shows the flipped flag', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  await load(page, 'cube-reversed-winding.stl');
  await expectPanel(page, {
    volume: '8,000 mm³ (computed −8,000: normals inward)',
    normals: 'inward (flipped): the volume is negative',
    watertight: 'yes',
  });
  await expect(field(page, 'normals')).toHaveAttribute('data-tone', 'bad');
  expect(Math.abs((await overlay(page)).volume + 8000)).toBeLessThanOrEqual(1e-6);
  expect(errors).toEqual([]);
});

test('inch-cube.stl, then a clean cube after the open box: rows and overlays follow the new part', async ({ page }) => {
  const errors: string[] = [];
  await ready(page, errors, []);
  await load(page, 'inch-cube.stl');
  await expectPanel(page, { size: '1 × 1 × 1 mm', volume: '1 mm³', area: '6 mm²', watertight: 'yes' });

  await load(page, 'open-box.stl');
  expect((await overlay(page)).open).toBe(8);
  await load(page, 'cube-20mm-binary.stl');
  await expectPanel(page, { 'open-edges': '0', watertight: 'yes' });
  await expect(page.locator('#part-info .swatch')).toHaveCount(0);
  expect(await overlay(page)).toMatchObject({ open: null, nonManifold: null });
  expect(errors).toEqual([]);
});
