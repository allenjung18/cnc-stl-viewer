# Try it by hand

A walk-through you can follow in about twenty minutes to see that the viewer does what it says. Nothing here needs a machine or a CAM program.

## Start it

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173 in a current Chromium-based browser (the automated tests run in Chromium). Drag a file onto the window, or press **Open STL or 3MF...** and pick one. The sample files are in `test/fixtures/`. A fresh browser profile (or a private window) starts from the defaults; to reset a normal window, clear the site's data for 127.0.0.1.

The machine is drawn to scale: the cutting area (yellow) inside the travel box (grey), a 10 mm grid on the bed, X right, Y toward the back, Z up. Drag to orbit.

## Each sample file

| Drop this | You should see |
| --- | --- |
| `cube-20mm-binary.stl` | the status "Loaded cube-20mm-binary.stl."; size 20 x 20 x 20 mm, volume 8,000 mm^3, area 2,400 mm^2, 12 triangles, 8 vertices, watertight yes, normals outward; a 26 x 26 x 23 mm stock (default allowance 3 mm a side, 1 mm on top, 2 mm under) around the cube, the cube not centred on the bed but sitting in its stock at the front-left corner, and the verdict starting "fits" |
| `cube-20mm-ascii.stl` | the same numbers; the format row says ASCII STL |
| `cube-20mm.3mf` | the same numbers; the units line reads "mm (from the file)" and the toggle reads "Set by the file" and is disabled |
| `cube-1in.3mf` | size 25.4 x 25.4 x 25.4 mm: the file states inches, so the units line reads "inch (from the file, x25.4 to mm)" |
| `inch-cube.stl` | size 1 x 1 x 1 mm and the hint "looks like inches" (see below) |
| `open-box.stl` | watertight no, 4 open edges, drawn in red along the rim of the missing top face |
| `bowtie.stl` | 1 non-manifold edge, drawn in magenta |
| `cube-reversed-winding.stl` | volume "8,000 mm³ (computed −8,000: normals inward)" and "inward (flipped): the volume is negative" in the Normals row |
| `box-10x20x80.stl` | 10 x 20 x 80 mm; the verdict is red: "stock exceeds cutting area Z by 7.0 mm" (80 + 1 + 2 = 83 against a 76 mm cutting height) |

Dropping a second file replaces the first. A truncated or unreadable file shows an error in red and leaves the part that was there.

## Inches

1. Drop `inch-cube.stl`. It is 1 unit across and reads as 1 mm, with the hint "looks like inches".
2. Press **Treat as inches (x25.4)**. The size becomes 25.4 mm, the volume scales with it, and the drawn cube grows. The hint goes away. Reload the page: the choice is kept and applies to the next STL.
3. Drop `cube-20mm-binary.stl` with the inch choice still on: it says "as inches this is larger than the cutting area: is the file in mm?". Press **Treat as mm** to go back.

## Stock and the verdict

Use `cube-20mm-binary.stl`.

1. **Part + allowance** (auto): change the allowance fields (X/Y, top, bottom) and watch the stock size follow: part + 2 x X/Y in X and Y, + top + bottom in Z.
2. Choose **Fixed block** and enter 25 x 25 x 25. The verdict turns red and names each failing axis, "part exceeds stock X by 1.0 mm (with margins)" and the same for Y, and the stock turns red in the view. Enter 26 x 26 x 26 and it fits again.
3. Enter a block of 210 x 30 x 30: "stock exceeds cutting area X by 7.0 mm" (the cutting area is 203 mm wide).
4. Set an allowance field to a negative number or leave it empty: the verdict says "Not checked: ..." with the field name and the stock is not drawn, never a pass.
5. **WCS origin**: switch between the front-left corner and the centre; the triad moves, always on the stock top. "Z left for tool + clamps" is the cutting-area height above the stock.
6. **Stock on the bed**: change X and Y to move the stock on the bed.

## A keep-out box

Tick **Keep-out box on the bed** and enter X 20, Y 10, width 20, depth 20, height 8. A hatched box is drawn and the verdict names it: "stock overlaps keep-out box 1 by X 6.0 mm, Y 16.0 mm" (with the default 26 x 26 stock at the origin). Move the stock to X = 100 under **Stock on the bed** and the verdict goes back to "fits".

## Rotate, lay flat, auto-orient

Use `box-10x20x80.stl`, which is too tall as read.

1. Press **X** under Rotate 90 degrees. The size becomes 10 x 80 x 20, the verdict turns to "fits" and the stock is 16 x 86 x 23 mm. Press **As read** to go back. Pressing a rotation four times gives back the starting orientation exactly.
2. Press **Lay flat on a face...**, then click a face of the part: that face goes down on the bed. A click that misses the part leaves the mode on with a hint; Esc leaves it.
3. Press **Auto-orient**. The top three ways up are listed with their Z height and fit (for this box: Z 10, Z 20, Z 80 mm). Nothing changes until you press **Apply** on one; the entry that matches the part now says **Current**.

## Views, orthographic, fit, measure

- Keys **1**, **2**, **3**, **4** (or the View buttons) show the top, front, right and iso views. In the top view +Y is up on screen.
- **O** toggles orthographic (true scale; the apparent size is kept); **F** re-frames the stock, or the part if there is no stock.
- Keys are ignored while you type in a field.
- **Measure...**: press it (it is enabled once a part is loaded), click a point on the part, then a second one. Near a corner the click snaps to it. The panel shows the distance and the X, Y and Z differences, and a label sits in the view. On the 20 mm cube, opposite corners read 34.641 mm (20 x sqrt(3)); press **4** first so both corners are in sight. A third click starts over; **Esc** clears and leaves measure mode.

## Profile, reload and the setup sheet

1. Set a fixed block, an allowance and the centre origin. Reload the page: they are still there (they are kept in the browser).
2. **Export profile** downloads a file named `<machine-name>.profile.json`. Open it in a text editor, change a number (for instance the allowance) and save.
3. **Import profile...** and pick it: the new values apply at once and the part stays loaded. Import a file that is not a profile (any other JSON or text): the status line says why and nothing changes.
4. **Copy setup sheet** puts a text block on the clipboard: machine, part and its size, orientation, the stock size and how it was made, the stock on the bed, the WCS origin and where it is on the bed, the part offset, Z left, and the fit verdict. Paste it into a text editor to read it. If the browser blocks the clipboard, the text appears in a box below to copy by hand.

## The thinnest-slab hint and large files

- The **End mill** field (default 3.175 mm) sets the diameter the hint compares with. With `box-10x20x80.stl` the hint names the thinnest extent and its axis; enter 12 and it reads "thinner than the 12 mm end mill" and warns that the slab is thinner than the end mill. It looks at the bounding box only. The value is kept in the browser.
- A file over 500 MB is refused with a message before it is read. A big STL (100 MB, around 2 million triangles) loads with a progress bar and status line while the page stays responsive; above 2,000,000 triangles the outline is off and says so.

## Reporting what broke

Please send, in one message:

1. **The file** you used: its name, and the file itself if it is not one from `test/fixtures/` (a ZIP of it is fine).
2. **The steps**, numbered, from a fresh page load. Include what you typed in any field and in what order.
3. **Expected** and **seen**: what you thought would happen, and what did, with the exact text of any message or verdict.
4. **A screenshot** of the whole window, including the panel.
5. **The browser console**: open the developer tools (F12, or Cmd+Option+I on a Mac), choose Console, reload, repeat the steps, and copy any red lines. Say which browser and version, and the operating system.
