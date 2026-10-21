# Architecture

A client-side app: TypeScript, Vite and three.js, no backend. `src/main.ts` is the one place that wires the modules to the page (`index.html`); everything else is a module with one job. Symbols are named so each claim can be checked with a search.

## Module map

| Folder | Role | Main symbols |
| --- | --- | --- |
| `src/io` | Bytes in, triangles out. No DOM, no three.js. | `sniffStl` (`sniff.ts`), `parseMesh` and `handleParseRequest` (`parse.ts`), `parse3mf` (`threemf.ts`), `loadStl` (`load.ts`), the worker shell `parse.worker.ts` |
| `src/geom` | Pure maths on triangle soups, boxes and sizes. Runs in Node tests. | `inspectMesh` (`stats.ts`), `weldEpsilon` (`topology.ts`), `unitHint` and `scaleStats` (`units.ts`), `checkFit` (`fit.ts`), `rotate90`, `layFlat`, `orientCandidates`, `rankOrientations` (`orient.ts`), `minFeatureHint` (`features.ts`), `bboxOf` (`bbox.ts`) |
| `src/view` | three.js objects and cameras. | `buildScene` (`scene.ts`), `buildPartMesh` (`partMesh.ts`), `buildStockMesh` and `buildKeepOutMesh` (`stockMesh.ts`), `Viewport` (`viewport.ts`), `VIEW_KEYS` (`views.ts`), `pickMeasurePoint` and `measureBetween` (`measure.ts`) |
| `src/ui` | Page panels; each takes plain values and writes the DOM. | `installDropzone` (`dropzone.ts`), `InspectorPanel` and `UnitsBadge` (`panel.ts`), `StockPanel` and `fitVerdict` (`stockPanel.ts`), `OrientPanel` (`orientPanel.ts`), `setupSheet` (`setupSheet.ts`) |
| `src/state` | Types and what is kept in the browser. | the types in `model.ts`, `loadUnits` and `loadToolDiameter` (`prefs.ts`), `loadProfile`, `parseProfile`, `profileToJson` (`profiles.ts`) |

The `geom` modules take and return plain arrays and numbers (`Vec3`, `BBox`, `Mat3`), which is why they are unit-tested in Node (`vitest.config.ts` sets `environment: 'node'`). The `view` modules are tested in Node too, because three.js scene objects do not need a browser; what needs WebGL and a real page is covered by the Playwright specs (see TESTING.md).

## Load pipeline

1. `installDropzone` (whole window) or the Open button gives `main.ts` a `File`; `open` in `main.ts` aborts a load already running and calls `loadStl`.
2. `loadStl` refuses an empty file and one over `MAX_STL_BYTES` (500 MB, `sniff.ts`) before reading it, reads the bytes, creates a module worker (`createParseWorker`) and posts the buffer to it as a transferable.
3. In the worker, `handleParseRequest` runs `parseMesh`. `parseMesh` tells a 3MF from an STL by the ZIP signature (`isZip`), never by the file name; an STL goes through `sniffStl` (binary-first size test, so a binary file whose header starts with "solid" is still read as binary; truncated, oversized and trailing-byte files are refused with a message).
4. Progress messages (`type: 'progress'`) go back every `PROGRESS_EVERY` triangles while parsing, then one with `phase: 'inspect'` before the mesh check. `loadStl` hands them to `onProgress`; `progressText` and `progressFraction` (`load.ts`) turn them into the status line and the bar.
5. Still in the worker, `inspectMesh` computes size, signed volume, area, welded vertex count, the open and non-manifold edges, degenerate triangles and, up to `FEATURE_EDGES_MAX_TRIANGLES`, the feature edges (faces meeting at more than `FEATURE_ANGLE_DEG`). If the inspector throws, the file still loads: the response carries `inspection: null` and `inspectionError`, and the panel shows the part without the checks (`uninspectedRows`).
6. The result comes back as a `done` message; the position and edge arrays are transferred, not copied. Any error becomes an `error` message, which `loadStl` rejects as an `StlError` that is shown as it stands.
7. `open` in `main.ts` builds the part with `buildPartMesh` and calls `render`, which applies the unit scale (`setUnitScale`) and runs `renderFit`; `renderFit` places the part in its stock (`setPlacement`). A new part starts as read (no rotation) with no orientation suggestions until asked.

An earlier part is released with `PartMesh.dispose` (geometry, materials and the three edge overlays) when the next one replaces it.

## Frames and units

- The machine frame is right-handed, millimetres, Z up: X right, Y toward the back. The origin is the front-left corner of the cutting area, Z = 0 on the bed (`DEFAULT_PROFILE.bedOriginNote` in `profiles.ts`; `applyZUp` in `scene.ts`).
- `MachineProfile` (`model.ts`) has a `travel` and a smaller `cuttingArea`. The defaults are the Nomad 883 Pro values `NOMAD_883_PRO_TRAVEL` and `NOMAD_883_PRO_CUTTING_AREA`. `machineBoxes` (`fit.ts`) draws the cutting area from the origin and centres the travel box on it in X and Y, so the travel box reaches below zero on X and Y.
- Positions from the worker stay in the file's own units and axes. The drawn mesh and the numbers shown are scaled by the unit scale: `unitScaleOf` gives 1 for `mm` and `MM_PER_INCH` (25.4) for `in`, and `scaleStats` multiplies lengths by s, area by s squared and volume by s cubed.
- An STL has no units, so the user's choice (`UnitChoice`) applies, and `unitHint` only suggests ("looks like inches", an over-1000 hint, or "as inches this is larger than the cutting area"); it never changes the scale itself.
- A 3MF states its unit. `THREEMF_UNITS` (`threemf.ts`) maps micron, millimeter, centimeter, inch, foot and meter to mm; `parse3mf` returns it with the soup (build transforms and components applied), `FileUnits` carries it to the page, and `unitsBadge` shows it and locks the toggle (`locked: true`) while the user's choice for STL files is kept for the next STL. A unit name the viewer does not know is refused.
- The part is placed with the min corner of its (rotated, scaled) bounding box on a placement point, never centred. In `auto` stock mode that point is inside the stock, so the part sits in its block on the bed.

## The fit model (`geom/fit.ts`)

`checkFit({ partSize, stock, setup, profile })` returns a `FitReport`. Sizes are millimetres after the unit scale and the rotation.

- `auto` stock: `stockFromPart` gives the part size plus twice the X/Y allowance, plus top and bottom in Z, with the part's min corner at (xy, xy, bottom) in the stock. Defaults are `DEFAULT_ALLOWANCE`.
- `fixed` stock: the block size is the input. `partOffsetInFixedStock` centres the part in X and Y and puts its top `allowance.top` under the stock top; `partInStockFailures` reports every axis where the part plus its margins (`requiredStockSize`) does not fit, as `part-exceeds-stock`.
- Placement: `setup.stockOnBed` is the stock's front-left-bottom corner on the bed (Z is 0). The stock box is then compared with the cutting area (`stock-exceeds-cutting-area`), with the travel as an outer limit (`stock-exceeds-travel`), and in plan view (X and Y only) with each keep-out box (`stock-over-keep-out`, touching is not overlap, `footprintOverlap`).
- Each failure names the axis and the overshoot, and `failureText` writes it; `fitVerdict` (`stockPanel.ts`) shows the lines and the stock mesh turns `STOCK_FAIL_COLOR` when any failure exists.
- Tolerance: `exceeds` treats a difference as real only above 1e-9 relative to the two numbers compared, so 0.1 + 0.2 against 0.3 is not a failure.
- Non-finite or out-of-range inputs throw `RangeError`; the page shows these as "Not checked: ..." rather than a pass, and an empty field is reported by name (`readStockForm`).
- `wcsOrigin` puts Z0 on the stock top, at the front-left corner or the stock centre (`WcsOrigin`). `zLeftMm` is the cutting-area height above the stock top.
- The keep-out box is off until the user switches it on (`KEEP_OUT_FIELD_DEFAULTS`); it lives in `machine.keepOut` of the profile, and `parseProfile` accepts at most one box.

## Orientation (`geom/orient.ts`)

- A rotation is a row-major 3x3 matrix `Mat3` with world = R . file. `rotate90(r, axis)` composes a quarter turn about a machine axis; the entries stay 0 and +-1, so four quarter turns return `IDENTITY` exactly.
- `layFlat(r, fileNormal)` turns a picked face's normal to point down (`alignToDown`). `PartMesh.pickFace` finds the face from a ray; `main.ts` runs it in pick mode (Lay flat on a face...).
- `orientCandidates` lists the `AXIS_ORIENTATIONS` (24 of them) plus lay-flat orientations of the largest `flatRegions`; `rankOrientations` sorts by fits first, then lowest Z, then most contact with the bed, one entry per way up, and keeps the top three. It only suggests: nothing is applied until an entry's Apply is pressed.
- Every rotation, apply or reset re-runs `renderFit`, so the verdict follows the orientation. Undercuts are not checked.

## Views and measure

- `Viewport` holds a perspective and an orthographic camera on one orbit; `perspectiveToOrtho` and `orthoToPerspective` keep the apparent size on a switch.
- `VIEW_KEYS` maps 1-4 to `top`, `front`, `right`, `iso`; the top view looks down -Z with +Y up on screen (`TOP_VIEW_LEAN`). `main.ts` handles O (orthographic), F (fit) and Escape; keys typed into a field, and with Ctrl, Meta or Alt held, are ignored (`typingIn`). `focusFrame` frames the stock, else the part, else the travel box.
- Measure: in measure mode a click (not a drag) calls `pickMeasurePoint`, which snaps to a corner within `SNAP_PX`; two points give `measureBetween` (distance and delta per axis). Points are kept in the part's own space (`worldOf`), so a measure follows the part when it is turned.

## Persistence

Three `localStorage` keys, all guarded (`browserStorage` returns `null` when storage may not be touched, and every read falls back to a default):

| Key | Constant | Holds |
| --- | --- | --- |
| `cnc-stl-viewer.units` | `UNITS_KEY` | `mm` or `in` |
| `cnc-stl-viewer.tool-diameter` | `TOOL_KEY` | the end-mill diameter in mm for the thinnest-slab hint (`DEFAULT_TOOL_DIAMETER_MM`, 3.175, when nothing valid is stored) |
| `cnc-stl-viewer.profile` | `PROFILE_KEY` | the machine, stock and WCS origin as JSON |

The profile JSON is the same text as the exported file (`profileToJson`): `format` `cnc-stl-viewer/profile` (`PROFILE_FORMAT`), `version` (`PROFILE_VERSION`), then `machine`, `stock` and `setup`. `parseProfile` validates a stored or imported value as a whole; a corrupt stored profile gives `DEFAULT_SAVED_PROFILE`, a bad imported file changes nothing and says why. The mesh is never stored. The setup sheet (`setupSheet`) is plain text built from the current inputs and verdict.

## Large files

The worker keeps the page responsive; the outline is skipped above `FEATURE_EDGES_MAX_TRIANGLES`, the 500 MB refusal is checked in `loadStl`, `sniffStl` and `parseMesh`, and the edge census uses sharded maps past V8's map size limit (`topology.ts`). The browser test for a 100 MB file is described in TESTING.md.
