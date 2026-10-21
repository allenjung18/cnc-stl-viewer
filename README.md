# cnc-stl-viewer

A local, client-side web app: drop an STL (later 3MF/OBJ), see it on a to-scale model of the Carbide 3D Nomad's bed, read its true dimensions, volume and mesh health, size a stock block around it with a per-side allowance, and get a clear fits / does not fit answer against the stock and the machine, with help choosing an orientation that fits or minimises Z.

Status: the viewport is up: a Z-up, to-scale model of the Nomad 883 Pro bed (cutting area 203 x 203 x 76 mm inside the 250 x 250 x 100 mm travel) with a 10 mm grid, RGB axes at the origin and orbit controls. Loading parts comes next.

## Conventions

- Machine frame: right-handed, Z up, millimetres. X right, Y toward the back, Z up.
- Origin: the front-left corner of the cutting area, Z = 0 on the bed surface.
- The cutting area (yellow) is what parts and stock are checked against; the travel box (grey) is drawn for reference.

## Development

Requires Node 22.12 or newer.

```sh
npm ci
npm run dev        # http://127.0.0.1:5173
npm test           # unit tests (Vitest, headless)
npm run lint       # ESLint + type check
npm run build      # type check + production build into dist/
npx playwright install chromium   # once
npm run e2e        # browser smoke test (Playwright)
```

Everything runs locally; there is no backend.
