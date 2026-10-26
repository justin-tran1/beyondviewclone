# CBRE Virtual Walkthrough

Internal CBRE tool for turning a floor plan into a space you can walk through. Import a plan image
and its walls, doors, windows and rooms are found for you; lay out furniture and equipment, then
explore it in 3D at eye height or from an overview.

## Run it

```bash
npm start            # serves the repo at http://localhost:8080
```

Any static server works; the app needs HTTP (not `file://`) because it uses ES modules. There is no
build step, and Three.js is vendored, so it runs offline apart from the CBRE fonts.

## Deployment

Every push to `main` publishes the app to GitHub Pages at
<https://justin-tran1.github.io/beyondviewclone/> through `.github/workflows/pages.yml`. Only
`index.html`, `assets/` and `src/` are published; the `dev/` test pages stay local. To re-deploy
without a code change, run the workflow from the Actions tab.

## Workflow

1. **Start**: open a sample from the welcome screen, start a blank plan, or import a floor plan image
   (PNG, JPG, WebP or SVG; export PDFs to PNG first).
2. **Detect**: an imported image is traced straight away. Its walls, doors, windows and rooms are
   found in the drawing, its scale is taken from the door widths (3'-0" doors), and the plan opens
   in Split beside the 3D view. **Detect walls** in the image panel traces it again; Undo removes
   what was found.
3. **Check the scale**: use **Calibrate scale** to click two points of a known distance and type the
   real length, for example `24' 6"` or `7.5m`; a traced plan is resized with its image.
4. **Trace**: fix or add anything the detection missed. Draw walls (exterior, interior, glass
   partition or half-height), place doors, windows and openings on them, and outline rooms to set
   floor finishes and ceilings. Type a length while drawing a wall and press Enter for exact
   dimensions.
5. **Furnish**: pick items from the library (lab and life sciences, medical office, general office,
   retail and industrial, general). Items snap flush to walls; `Q` and `E` rotate.
6. **Walk**: switch to **Walk** or **Split**. Drag to look, `W A S D` to move, click the floor to
   walk there, save viewpoints, and use **Overview** for a dollhouse view. Save images of any view.
7. **Render photo**: the camera button beside Save image path traces the current view into a
   photographic still for client decks (1280 x 720 up to 4K; Draft, Standard or High quality). It
   takes a minute or more on the graphics card while the 3D view keeps running; save the PNG when
   it is done.

The quality menu on the 3D view sets how it is drawn: **Realistic** (soft contact shadows, window
glow, filmic color and smooth edges), **Balanced** (lighter shading for smoother movement) or
**Fast** (plain shading for older computers). If moving gets slow, the view steps down on its own
and the menu says so; once moving is smooth again it steps back up, never above the level you picked.
Saved images always use the level you picked. Browsers without WebGL 2 always draw Fast.

Plans save as `.cbreplan.json` files (the traced image is embedded) and autosave in the browser.
Press `?` in the app for every keyboard shortcut.

## Fonts

The UI uses CBRE's Calibre and Financier Display when they are installed on the computer, as on CBRE
laptops. They are licensed and intentionally not included in this repo; without them the app falls
back to system fonts.

## Project layout

```
index.html, assets/css/app.css   App shell and styles
src/app.js, src/ui/              Wiring, panels, dialogs, file handling
src/model.js, src/geometry.js    Plan data model, undo/redo, geometry and units
src/editor2d.js, plan-render.js  2D tracing and layout editor
src/autotrace.js, src/ui/trace.js  Finding walls, doors, windows and rooms in a plan image
src/builder3d.js, kit3d.js       Plan to 3D scene and lighting, shared materials and primitives
src/walkthrough.js, postfx.js    First-person and overview viewer, post-processing and quality
src/photo.js, src/ui/photo.js    Ray-traced Render photo
assets/vendor/                   Three.js r160, three-gpu-pathtracer and three-mesh-bvh
src/catalog/                     Furniture and equipment library
src/samples/                     Sample plans
dev/                             Developer test pages and the smoke test
```

Module contracts and coordinate conventions are in [docs/architecture.md](docs/architecture.md).

## Developer checks

```bash
npm install                      # Playwright, for tests only
npm start                        # in one terminal
npm run smoke                    # opens every sample, and an imported drawing it traces, in Plan, Split and Walk; screenshots to smoke-out/, fails on any error
node scripts/shot.mjs <url> <out.png> [--wait=expr]   # screenshot any page and report console errors
```

Test pages: `dev/catalog.html?category=lab` (every item in 3D and plan form; add `&view=room` for
the walkthrough's lighting and post-processing), `dev/editor-test.html`, `dev/builder-test.html?view=overview`
(`&checks=1` runs the builder checks), `dev/walkthrough-test.html`, `dev/materials-test.html` (every
finish side by side), `dev/photo-test.html?realtime=1` (a photo beside the live view) and
`dev/samples-test.html?sample=lab-suite`.
