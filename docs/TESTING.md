# Testing

Two layers, both run from `package.json` scripts. Run both before you trust a change.

| Layer | Command | Where |
| --- | --- | --- |
| Unit | `npm test` (`vitest run`); `npm run test:watch` for watch mode | `src/**/*.test.ts`, beside the code they prove (`include` in `vitest.config.ts`) |
| Browser | `npm run e2e` (`playwright test`) | `e2e/*.spec.ts` |

`npm run lint` runs ESLint and `tsc --noEmit`; `npm run build` type-checks and builds. A change is checked with lint, `npm test`, `npm run e2e` and `npm run build`.

## Unit tests (Vitest)

Vitest runs in Node (`environment: 'node'`): no browser, no WebGL. Each module `x.ts` has an `x.test.ts` next to it (for example `src/geom/fit.test.ts` for `fit.ts`). The `geom` and `io` tests build their inputs in memory with the helpers exported from `test/fixtures/tiny-generator.ts` (`boxTriangles`, `reversed`, `gridCubeStl`, and the binary, ASCII and 3MF writers). The `view` tests build three.js objects without rendering. The parse tests also check that the committed fixture files still equal what the generator produces.

One test is large: `src/io/large.test.ts` builds a 1 M-triangle STL in memory (about 50 MB, never written to disk) and runs it through `handleParseRequest`, the function the Web Worker runs. It checks the counts, the progress messages every `PROGRESS_EVERY` triangles, the outline, and the 2,000,000-triangle cut-off (`outlineByDefault`). It logs the parse and inspect times but does not assert on them, and has a 120 s timeout, so a slow machine makes it slow, not red.

## Fixtures

The small files in `test/fixtures/` are committed. `npm run fixtures` rewrites them from `test/fixtures/tiny-generator.ts`, which Node runs directly as TypeScript, hence Node 22.18 or newer. The Playwright specs fetch them from the dev server at `/test/fixtures/<name>`.

| File | What it is |
| --- | --- |
| `cube-20mm-binary.stl` | 20 mm cube, binary, with a header that starts with "solid" |
| `cube-20mm-ascii.stl` | the same cube, ASCII |
| `cube-20mm.3mf`, `cube-1in.3mf` | a 20 mm cube in millimeters, and a 1-inch cube in inches, as 3MF |
| `inch-cube.stl` | a 1 x 1 x 1 cube (an inch part with no unit in the file) |
| `open-box.stl` | the 20 mm cube without its top face: 4 open edges |
| `bowtie.stl` | two 10 mm cubes sharing one edge: 1 non-manifold edge |
| `cube-reversed-winding.stl` | the 20 mm cube wound inward: negative volume, the flipped flag |
| `box-10x20x80.stl` | a 10 x 20 x 80 box off the origin: too tall as read (`TALL_BOX_MIN`, `TALL_BOX_SIZE`) |

Big files are never committed. `gridCubeStl(n, size)` (also exported from the generator) builds a cube whose six faces are each an n x n grid of quads, 12 n^2 triangles in all; the large tests use it.

## Browser tests (Playwright)

`playwright.config.ts` starts `npx vite` on port 5199 (`reuseExistingServer: false`, so a stray server on that port fails the run rather than being reused) and runs Chromium headless on SwiftShader, the software WebGL that headless Chromium has. Install the browser once with `npx playwright install chromium`. `fullyParallel` is on, so specs and tests run in parallel workers. A trace is kept for a failed test (`trace: 'retain-on-failure'`) under `test-results/`; open it with `npx playwright show-trace <trace.zip>`.

`e2e/helpers.ts` holds `ready` (opens the page and waits for the `window.__stlViewer` test hook, which `main.ts` sets only under the dev server, `import.meta.env.DEV`) and `dropFixture` (a real drag-and-drop of a fixture). Most tests also assert that no page error was raised.

| Spec | What it proves |
| --- | --- |
| `viewport.spec.ts` | the machine scene renders Z-up and orbits on drag |
| `dropzone.spec.ts` | dropping each cube format shows 12 triangles and puts the cube in its stock, not centred; a truncated file shows an error and leaves the previous part; the Open button's file picker loads a file too |
| `inspector.spec.ts` | the panel for each cube format (size, volume, area, triangles, vertices, watertight); `open-box.stl` shows 4 open edges in red; `bowtie.stl` shows 1 non-manifold edge in magenta; `cube-reversed-winding.stl` shows the flipped flag; the overlays follow the next part |
| `units.spec.ts` | `inch-cube.stl` shows the "looks like inches" hint, the toggle rescales size, volume and mesh, and the choice survives a reload; the 20 mm cube shows no hint, and as inches it says it does not fit |
| `stock.spec.ts` | the 20 mm cube gets a 26 x 26 x 23 stock with the WCS marker on its front-left top; a 25 mm fixed block fails X and Y by 1 mm and the stock turns red; a 210 mm block fails the cutting area in X; a keep-out box under the stock is flagged and drawn; an empty or overflowing input is refused, never a pass; the centre origin moves the marker |
| `orient.spec.ts` | every rotation re-runs the fit (`box-10x20x80.stl` is too tall as read and fits after a quarter turn about X; four turns about Z come back exactly); auto-orient lists the top three and applies nothing until asked; lay flat puts a clicked face on the bed; a new file starts as read |
| `views.spec.ts` | key 1 then O gives an orthographic camera looking down -Z with +Y up; keys 2-4 and the buttons show front, right and iso; a key typed into a field is the field's |
| `measure.spec.ts` | two-point measure between opposite corners of the 20 mm cube reads 20 x sqrt(3), with a label; Esc clears it |
| `persist.spec.ts` | stock inputs and origin survive a reload; a corrupt stored profile falls back to the defaults; export, edit, import applies at once and a bad file changes nothing; the setup sheet reaches the clipboard; export with an invalid input exports nothing |
| `scale.spec.ts` | 3MF reads its unit (a 1-inch 3MF reads 25.4 mm) and the STL units choice is kept; 20 drops leave as many GPU geometries, textures and programs as two; the outline toggle; the thinnest-slab hint and the tool diameter surviving a reload; the 500 MB refusal; the 100 MB load |

### The 500 MB and 100 MB tests

Both are in `scale.spec.ts`.

- The 500 MB test makes a sparse 600 MB file (`ftruncateSync`, no disk space used), sets it on `#file-input`, and expects `huge.stl is 600.0 MB; files over 500.0 MB are refused.` with the part already on the bed left in place. The page never reads the file.
- The 100 MB test writes a 100 MB STL (`gridCubeStl(419, 100)`, 2,106,732 triangles) under `test-results/` at run time, drops it, and watches the main thread with a 20 ms timer. It expects the progress lines from the worker ("Reading ... of 2,106,732 triangles", then "Checking the mesh of ...") and the progress bar, the triangle count and watertight "yes", the outline off with the note "Outline off: over 2,000,000 triangles.", and the longest main-thread gap under 1500 ms. It has a 180 s timeout and logs its wall time and longest gap.

Both depend on the machine's load. The 100 MB test is the sensitive one: the gap assertion measures real timer delay, so a busy machine (another suite, a build, a laptop on battery) can push it over while nothing is wrong. If that single test fails, re-run it alone (`npx playwright test scale.spec.ts -g "100 MB"`); a failure that repeats on a quiet machine is real.

### Running part of the suite

Spec arguments to `playwright test` are regular expressions matched against the path, not globs: `npx playwright test stock orient` runs the two specs whose names contain those words. Read the "Running N tests" line to see how many you selected.

## Reading the counts

- Vitest ends with `Test Files  N passed (N)` and `Tests  N passed (N)`. Skipped tests are listed separately; a green run with skipped tests is not the same as all passed.
- Playwright ends with `N passed`, plus `N skipped` or `N failed` when there are any (the config sets no retries, so a failure is a failure). Read `Running N tests using W workers` at the top and check that N is what you meant to run.
- The totals grow as tests are added, so this file does not record them; take them from your own run.
