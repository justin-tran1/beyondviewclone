# CBRE Virtual Walkthrough

Internal CBRE tool for turning a floor plan into a space you can walk through. Trace a plan image,
lay out furniture and equipment, then explore it in 3D at eye height or from an overview.

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
2. **Set the scale**: after importing an image, click two points of a known distance and type the
   real length, for example `24' 6"` or `7.5m`.
3. **Trace**: draw walls (exterior, interior, glass partition or half-height), place doors, windows
   and openings on them, and outline rooms to set floor finishes and ceilings. Type a length while
   drawing a wall and press Enter for exact dimensions.
4. **Furnish**: pick items from the library (lab and life sciences, medical office, general office,
   retail and industrial, general). Items snap flush to walls; `Q` and `E` rotate.
5. **Walk**: switch to **Walk** or **Split**. Drag to look, `W A S D` to move, click the floor to
   walk there, save viewpoints, and use **Overview** for a dollhouse view. Save images of any view.

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
src/builder3d.js, kit3d.js       Plan to 3D scene, shared materials and primitives
src/walkthrough.js               First-person and overview viewer
src/catalog/                     Furniture and equipment library
src/samples/                     Sample plans
dev/                             Developer test pages and the smoke test
```

Module contracts and coordinate conventions are in [docs/architecture.md](docs/architecture.md).

## Developer checks

```bash
npm install                      # Playwright, for tests only
npm start                        # in one terminal
npm run smoke                    # opens every sample in Plan, Split and Walk; screenshots to smoke-out/
node scripts/shot.mjs <url> <out.png> [--wait=expr]   # screenshot any page and report console errors
```

Test pages: `dev/catalog.html?category=lab` (every item in 3D and plan form), `dev/editor-test.html`,
`dev/builder-test.html?view=overview`, `dev/walkthrough-test.html` and `dev/samples-test.html?sample=lab-suite`.
