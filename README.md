# CBRE Virtual Walkthrough

Internal CBRE tool for turning a floor plan into a space you can walk through. Import a plan image
and its walls, doors, windows, rooms and the furniture drawn in it are found for you; add or change
furniture and equipment, then explore it in 3D at eye height or from an overview.

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

1. **Start**: open a sample from the welcome screen, start a blank plan, or import a floor plan PDF
   or image (PDF, PNG, JPG, WebP or SVG).
2. **Detect**: an imported image is traced straight away. Its walls, doors, windows and rooms are
   found in the drawing, its scale is taken from the door widths (3'-0" doors), and the plan opens
   in Split beside the 3D view. Furniture and fixtures drawn in the rooms (desks, counters with
   their sinks, tables, chairs, sofas, exam tables, toilets, sinks, cabinets, refrigerators) are
   placed as library items, sized to the drawing and turned to face the way it shows. Rooms whose
   furniture shows their use (an exam room's casework, a restroom's toilet, a lab's benches) get
   the finishes for it. **Detect walls** in the image panel traces it again; Undo removes what was
   found.
   - **PDFs** open in a dialog that shows every page, picks the one most like a floor plan, and
     outlines the plan on it. The sheet's frame, title block, notes and schedules are left out.
     Drag the outline or its corners to change what is imported, or choose another page.
   - A drawing in vector form is imported sharp. A scanned page, or a plan placed on the page as a
     picture, keeps its own pixels.
   - When the drawing has a scale note (`1/4" = 1'-0"`, `1" = 20'-0"`, `1:100`), it sets the scale.
     The door widths check it. A sheet printed to fit a smaller page, whose note no longer holds,
     takes its scale from the doors instead.
   - **Pages with no text of their own** (a scan, or a CAD export that draws its text as lines) are
     read with OCR, in the browser: their scale notes and sheet titles count as they do on any
     other page. The dialog reads the page shown first and shows its progress. Import waits for
     the page shown to be read. A sheet's titles pick the floor plan over a reflected ceiling
     plan or a schedule.
   - **Rooms are named from the drawing's labels**: a room tagged OFFICE over 102 is Office 102,
     and EXAM ROOM #4 is Exam Room #4. A PDF's labels come from its text, or by OCR from a page
     with none. A PNG, JPG, WebP or SVG drawing is read with OCR once it is traced, and its rooms
     are named a few seconds later, in a step of their own that Undo takes back. A room's name
     sets its finishes (an exam room, a soiled utility room, a wet lab), and where it says nothing
     (Room 3, Workroom), its furniture does. Labels read best at about 6 px tall or more in the
     image; on smaller or blurred text, OCR may miss or misread a room's number.
3. **Check the scale**: use **Calibrate scale** to click two points of a known distance and type the
   real length, for example `24' 6"` or `7.5m`; a traced plan is resized with its image.
4. **Trace**: fix or add anything the detection missed. Draw walls (exterior, interior, glass
   partition or half-height), place doors, windows and openings on them, and outline rooms. Type a
   length while drawing a wall and press Enter for exact dimensions.
5. **Finish**: select a room to set its interior finishes.
   - **Packages** set every finish at once for a type of space:
     - Healthcare: exam, patient, procedure and operating rooms, imaging, clinical corridor, waiting
       and reception, nurse station, restroom, clean and soiled utility.
     - Lab: wet and dry labs, tissue culture (BSL-2), cleanroom, vivarium, glass wash and lab support.
     - Workplace and support: office, conference, break room, lobby, storage.
   - **Floor**: sheet vinyl, rubber, epoxy flake, seamless resinous, static-control tile and
     linoleum, then luxury vinyl plank, carpet tile, porcelain tile, terrazzo, wood and concrete.
     Each comes in its own colors.
   - **Walls**: paint or a washable epoxy coating in any color, FRP panels, ceramic tile or wood
     veneer.
   - **Wainscot** (ceramic tile, FRP, impact panel or wood) with a cap along its top.
   - **Base**: rubber, an integral cove (the floor run up the wall), tile, or none.
   - **Wall protection**: corner guards, a crash rail or a handrail on brackets.
   - **Ceiling**: acoustic tile, washable tile, drywall or open to structure, and its height.
   - **Apply to all exam rooms** (or whatever use the room's name or furniture shows) and **Apply to
     all rooms** copy one room's finishes to others. **Match finishes to room use** in the plan
     overview sets each room from its name, else the furniture in it.
   - The plan tints each room by its floor color.
6. **Furnish**: pick items from the library (lab and life sciences, medical office, general office,
   retail and industrial, general). Items snap flush to walls; `Q` and `E` rotate. Casework, lab
   benches and sinks, pantry counters, vanities, nurse stations and reception desks take a casework
   color (laminates or wood veneers) and a worksurface: quartz, solid surface, epoxy or phenolic
   resin, stainless steel or laminate. **Framed art** hangs at eye level on any wall in one of a
   dozen abstract paintings and prints: each piece picks its own, or choose one under **Artwork**.
7. **Walk**: switch to **Walk** or **Split**. Drag to look, `W A S D` to move, click the floor to
   walk there, save viewpoints, and use **Overview** for a dollhouse view. Save images of any view.
   Spaces look like a rendered architectural tour: warm greige walls on an espresso base, walnut
   doors and glass partitions in dark bronze frames, acoustic tile ceilings with 2 x 4 troffers, oak
   plank floors (weathered in corridors, waiting rooms and lobbies, natural in offices), walnut
   casework under white quartz or black epoxy tops, and warm light. Labs keep white coated walls
   and washable ceilings over warm tan epoxy or sand sheet floors.
8. **Render photo**: the camera button beside Save image path traces the current view into a
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
src/autotrace-items.js           Finding the furniture and fixtures drawn in it
src/pdf-scan.js, src/ui/pdf.js   PDF import: the plan on a drawing sheet, its scale note, the dialog
src/ui/ocr.js                    OCR for pages with no text in them (Tesseract)
src/ui/image-labels.js           Room labels read on floor plan images with OCR
src/room-names.js                Room names from the tags drawn in a drawing's rooms
src/builder3d.js, kit3d.js       Plan to 3D scene and lighting, shared materials and primitives
src/walkthrough.js, postfx.js    First-person and overview viewer, post-processing and quality
src/photo.js, src/ui/photo.js    Ray-traced Render photo
assets/vendor/                   Three.js r160, three-gpu-pathtracer, three-mesh-bvh, pdf.js and tesseract.js
src/catalog/                     Furniture and equipment library
src/samples/                     Sample plans
dev/                             Developer test pages and the smoke test
```

Module contracts and coordinate conventions are in [docs/architecture.md](docs/architecture.md).

## Developer checks

```bash
npm install                      # Playwright, for tests only
npm start                        # in one terminal
npm run smoke                    # opens every sample, an imported drawing (SVG, PNG, JPG) and a PDF drawing set it traces, in Plan, Split and Walk, PDFs read with OCR and the rooms named from their labels; screenshots to smoke-out/, fails on any error
node dev/tests/pdf-sheets.mjs http://localhost:8080/ pdf-out   # the smoke test's PDFs: a drawing set, a sheet printed to fit, scans, a sheet with outlined text
node dev/tests/pdf-text.mjs      # scale notes, OCR's misreads of them and sheet titles (no browser)
node dev/tests/room-names.mjs    # room tags to room names, OCR's room words put right, and the room use names tell (no browser)
node scripts/shot.mjs <url> <out.png> [--wait=expr]   # screenshot any page and report console errors
```

Test pages: `dev/catalog.html?category=lab` (every item in 3D and plan form; add `&view=room` for
the walkthrough's lighting and post-processing), `dev/editor-test.html`, `dev/builder-test.html?view=overview`
(`&checks=1` runs the builder checks), `dev/walkthrough-test.html`, `dev/materials-test.html` (every
finish side by side), `dev/photo-test.html?realtime=1` (a photo beside the live view),
`dev/pdf-test.html` (choose a PDF to see the plan area, rank and scale note found on each page,
with the text OCR reads) and
`dev/samples-test.html?sample=lab-suite`.
