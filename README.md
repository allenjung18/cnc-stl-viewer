# cnc-stl-viewer

A local, client-side web app: drop an STL or a 3MF (OBJ later), see it on a to-scale model of the Carbide 3D Nomad's bed, read its true dimensions, volume and mesh health, size a stock block around it with a per-side allowance, and get a clear fits / does not fit answer against the stock and the machine, with help choosing an orientation that fits or minimises Z.

Status: a Z-up, to-scale model of the Nomad 883 Pro bed (cutting area 203 x 203 x 76 mm inside the 250 x 250 x 100 mm travel); drop or open a binary or ASCII STL to see it on the bed with its size, volume, area and mesh health, read as mm or as inches (x25.4). The stock is sized from the part plus a per-side allowance (default 3 mm a side, 1 mm on top, 2 mm underneath) or entered as a fixed block, placed on the bed, and checked against the part's margins, the cutting area, the travel and an optional keep-out box; the verdict names each failing axis and the overshoot in mm, and the stock turns red on any failure. The WCS origin marker sits on the stock top, at its front-left corner by default. The part can be turned 90° about X, Y or Z, laid flat on a face you click, or auto-oriented: the top three ways up are listed with their Z height and fit (fits first, then lowest Z, then the most flat area on the bed), and nothing is applied until you pick one; the fit re-runs after every turn. Undercuts are not checked (3-axis).

Views: keys 1-4 (or the View buttons) show the stock (or the part, or the whole machine) from the top, front, right and iso; O toggles orthographic (true scale), F re-frames. Measure picks two points on the part (a click near a corner snaps to it) and shows the distance and ΔX / ΔY / ΔZ, with a label in the view; Esc clears it. The machine, the stock inputs and the WCS origin are kept in the browser (a corrupt stored value falls back to the defaults) and can be exported and imported as a JSON profile; the units choice is kept too. Copy setup sheet puts the stock size, origin, part offset, orientation and fit verdict on the clipboard as text for CAM.

Files: binary and ASCII STL, and 3MF (core spec: mesh objects, components and build transforms; support objects (both kinds) are skipped; objects in other model parts are refused). A 3MF states its unit, so its size is read in that unit with no inch toggle; an STL keeps the units choice. Files over 500 MB are refused with a message before they are read. Parsing and the mesh check run in a Web Worker with progress in the panel, so a 100 MB STL (2 M triangles) loads without freezing the page. The part is drawn with an outline (edges where faces meet at more than 20°), which can be switched off and is skipped above 2,000,000 triangles. The thinnest-slab hint gives the part's smallest extent along a machine axis, as oriented, and warns when it is under the end-mill diameter you enter (default 1/8 in, kept in the browser); it looks at the bounding box only, never at walls inside the part.

## Conventions

- Machine frame: right-handed, Z up, millimetres. X right, Y toward the back, Z up.
- Origin: the front-left corner of the cutting area, Z = 0 on the bed surface.
- The cutting area (yellow) is what parts and stock are checked against; the travel box (grey) is drawn for reference.
- Work zero (WCS) is on the stock top, so cuts go negative in Z; "Z left for tool + clamps" is the cutting-area height above the stock, and the tool length is left to you.

## Development

Requires Node 22.18.0 or newer (`engines` in `package.json`; `npm run fixtures` runs a TypeScript file directly).

```sh
npm ci
npm run dev          # http://127.0.0.1:5173
npm run preview      # serve the production build from dist/ (run npm run build first)
npm test             # unit tests (Vitest, headless)
npm run test:watch   # Vitest in watch mode
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint + type check
npm run build        # type check + production build into dist/
npx playwright install chromium   # once
npm run e2e          # browser tests (Playwright); the large-file test writes a 100 MB STL under test-results/ at run time
npm run fixtures     # rewrite the small committed STL and 3MF fixtures
```

Everything runs locally; there is no backend.

## Docs

- [docs/TRY-IT.md](docs/TRY-IT.md): a hand acceptance guide (what to drop, what you should see) and how to report what broke.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the modules, the load pipeline, the frames and units, the fit model, persistence.
- [docs/TESTING.md](docs/TESTING.md): the unit and browser tests, the fixtures, and how to read the counts.
