import type { Page } from '@playwright/test';

/**
 * Fetches a fixture from the dev server and dispatches a real drag-and-drop of
 * it (dragenter, dragover, drop) on the page, as a file dragged from the desktop.
 * `cut` keeps only the first bytes, to make a truncated file.
 */
export async function dropFixture(page: Page, name: string, cut?: number): Promise<number> {
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

export async function ready(page: Page, errors: string[], workers: string[]): Promise<void> {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('worker', (w) => workers.push(w.url()));
  await page.goto('/');
  await page.waitForFunction(() => '__stlViewer' in window);
}
