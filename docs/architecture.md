# Architecture

CBRE Virtual Walkthrough is a static, build-free web app: trace a floor plan image, furnish it,
and walk through it in 3D. Plain ES modules, Three.js r160 and the libraries below vendored in
`assets/vendor/`, no framework, no bundler. Serve the repo root over HTTP (`npm start`).

## Files and ownership

| File | Purpose |
| --- | --- |
| `index.html`, `assets/css/app.css`, `src/app.js`, `src/ui/*.js` | App shell, panels, dialogs, file handling, wiring |
| `src/model.js` | Plan schema, defaults, `normalizePlan`, entity helpers, `PlanStore` (undo/redo, selection) |
| `src/geometry.js` | Plan-space math, snapping, unit formatting and parsing |
| `src/kit3d.js` | Physically based materials, procedural textures and primitive builders (`createKit()`) |
| `src/catalog/registry.js` | `registerItems`, `getItem`, `itemDims`, `searchItems`, `CATEGORIES` |
| `src/catalog/{lab,medical,office,retail}.js` | Item definitions for each space type (`general` items live in `office.js`) |
| `src/plan-render.js` | Draws a plan onto a 2D canvas (editor and minimap share it) |
| `src/editor2d.js` | `PlanEditor`: interactive 2D tracing and layout editor |
| `src/builder3d.js` | Plan to Three.js scene: walls with openings, floors, ceilings, items, exterior; lighting and the plan light map |
| `src/postfx.js` | Post-processing for the walkthrough: AO, bloom, color grade, AgX, SMAA, quality levels (`createPostFX()`) |
| `src/walkthrough.js` | `Walkthrough`: renderer, first-person and overview cameras, collisions, minimap, quality |
| `src/photo.js` | `renderPhoto()`: ray-traced stills of a walkthrough view (three-gpu-pathtracer) |
| `src/ui/photo.js` | The Render photo button and dialog |
| `src/samples/*.js` | Sample plans; `src/samples/index.js` exports `SAMPLES` |
| `assets/vendor/` | Vendored libraries (see Vendored libraries) |
| `dev/` | Developer-only test pages and the smoke test (see the README) |

## Coordinates and units

- **Plan space** is in **meters**. `x` grows to the right, `y` grows **down** (canvas orientation).
- **World space** (Three.js): `Y` is up. Plan `(x, y)` maps to world `(x, height, y)`, i.e. `world.z = plan.y`.
- **Rotation** of items is in **degrees, clockwise on the plan**. In 3D: `object.rotation.y = -deg * Math.PI / 180`.
- **Item local frame**: footprint centered on the origin, width `w` along local x, depth `d` along local
  y (plan) / local z (3D). The item's **front faces +y on the plan (+z in 3D)**. Placed against a
  wall, an item's back (−y) touches the wall.
- **Camera yaw** is degrees clockwise on the plan, `0` = facing plan −y (up the page). Forward vector
  in world space: `(sin(yaw), 0, -cos(yaw))`. Pitch is degrees, positive looks up.
- Display units are per plan: `plan.units` is `'imperial'` (feet and inches, default) or `'metric'`.
  Always store meters; use `formatLength`, `formatArea` and `parseLength` from `geometry.js` for UI.

## Plan schema (version 1)

```js
{
  version: 1, id, name, units: 'imperial' | 'metric',
  settings: { wallHeight: 2.9, ceiling: 'tile' | 'drywall' | 'open', exterior: 'city' | 'campus' | 'none' },
  underlay: null | {
    src,              // data URL of the traced image
    width, height,    // natural size in px
    x, y,             // plan position (m) of the image's top-left corner
    scale,            // meters per image pixel
    rotation,         // degrees clockwise around the top-left corner
    opacity, visible, locked,
  },
  walls:    [{ id, a: {x, y}, b: {x, y}, kind: 'exterior' | 'interior' | 'glass' | 'partial', thickness, height }],
  openings: [{ id, wallId, type: 'door' | 'double-door' | 'sliding-door' | 'opening' | 'window',
               offset,          // meters from wall.a to the opening's center
               width, height, sill,
               hinge: 'start' | 'end',   // hinge at the end of the opening nearer wall.a or wall.b
               side: 1 | -1 }],          // door swings toward wallNormal(wall) * side
  rooms:    [{ id, name, points: [{x, y}, ...], floor: FloorKey, ceiling: 'tile' | 'drywall' | 'open',
               height? }],          // ceiling height (m); defaults to settings.wallHeight
  items:    [{ id, type, x, y, rotation, w?, d?, h?, elevation?, color?, label? }],   // elevation: base height above floor (m)
  cameras:  [{ id, name, x, y, yaw, pitch }],
}
```

`FloorKey` is a key of `FLOORS` in `model.js`. Walls are independent segments; corners are walls
whose endpoints coincide; a wall ending on another wall's span is a tee, and `moveWall` keeps tees
attached and rooms following. `normalizePlan` accepts untrusted input and always returns a valid
plan: it drops non-finite values and entities beyond 10,000 m, clamps item sizes to 60 m and camera
pitch to ±70°, caps each collection at 20,000 entries, and keeps an underlay only when its `src` is a
`data:image/` URL. `serializePlan` writes `format: 'cbre-walkthrough-plan'` so files can be recognized.

## Module contracts

### `model.js`

- `createPlan(overrides)`, `normalizePlan(json)`, `serializePlan(plan)`, `clonePlan(plan)`, `uid(prefix)`
- Tables: `DEFAULTS`, `WALL_KINDS`, `OPENING_TYPES`, `FLOORS`, `CEILINGS`
- Draft helpers (call inside `store.update`): `addWall`, `addOpening`, `addRoom`, `addItem`, `addCamera`,
  `removeEntity`, `moveWallEndpoint`, `moveWall`, `clampOpenings`, `findEntity`
- `PlanStore` (`EventTarget`)
  - `plan` (read-only snapshot; never mutate), `selection` (`{kind, id}` or `null`), `selected`
  - `update(draft => {...}, { label, coalesce })` — `coalesce` merges a drag into one undo step; call `endCoalesce()` on pointer up
  - `replace(plan)`, `undo()`, `redo()`, `canUndo`, `canRedo`, `select(sel)`, `deleteSelection()`
  - Events: `change` (`detail: {label, replaced?, undo?, redo?}`), `selection`, `history`

### `catalog/registry.js`

See the ItemDef comment in the file. Key rules: models are built from `kit` primitives and materials
only (no external assets), sized to the `opts.w/d/h` passed in (so resized items still fit their
footprint), base at `y = 0`, front `+z`. `draw2d` draws an architectural plan symbol inside the
footprint. Unknown types fall back to a placeholder box.

### `plan-render.js`

```js
export const THEME          // plan colors, CBRE palette
export function fitView(bounds, width, height, padding = 40) -> view
export function toScreen(view, p) -> {x, y}      // plan meters to CSS px
export function toPlan(view, sx, sy) -> {x, y}   // CSS px to plan meters
export function planBounds(plan) -> {minX, minY, maxX, maxY}   // walls, rooms, items, underlay
export function renderPlan(ctx, plan, view, opts)
// view = { scale /* CSS px per meter */, ox, oy /* CSS px of plan origin */, width, height /* CSS px */ }
// ctx is already scaled for devicePixelRatio by the caller.
// opts = { selection, hover, showGrid, showUnderlay, showDimensions, showLabels, mini,
//          walker /* {x, y, yaw} or null: draws a position marker and view cone */ }
```

### `editor2d.js`

```js
export class PlanEditor extends EventTarget {
  constructor(canvas, store)          // owns pointer, wheel and keyboard input on the canvas
  setTool(tool)    // 'select' | 'pan' | 'wall' | 'room' | 'door' | 'double-door' | 'sliding-door'
                   // | 'opening' | 'window' | 'item' | 'camera' | 'calibrate'
  get tool()
  setWallKind(kind)                   // kind used by the wall tool
  setPendingItem(type)                // used by the 'item' tool; also switches to it
  applyCalibration(a, b, meters)      // rescale the underlay so |ab| equals meters; a stays fixed
  setWalker(pose | null)              // show the walkthrough position on the plan
  setOptions({ showGrid, showUnderlay, showDimensions, showLabels })
  zoomToFit(), zoomBy(factor), resize(), render(), destroy()
  // Events:
  //   'toolchange'  {tool}
  //   'status'      {text}          contextual hint for the status bar
  //   'cursor'      {x, y}          plan position under the pointer
  //   'calibrate'   {a, b, meters}  user picked two points; UI asks for the true length, then calls applyCalibration
  //   'teleport'    {x, y}          double-click on the plan while a walker is shown
  //   'view'        {scale, ox, oy} after any zoom, pan or resize
}
```

Keyboard (when the canvas has focus): `V` select, `H` pan, `W` wall, `R` room, `D` door, `N` window,
`C` camera, `Delete`/`Backspace` delete, `Esc` cancel or finish, `Enter` finish, `Ctrl/Cmd+Z` undo,
`Ctrl/Cmd+Shift+Z` or `Ctrl+Y` redo, `Ctrl/Cmd+D` duplicate item, arrows nudge, `Q`/`E` rotate the
selected or pending item by 15° (`Shift` for 90°), `F` flip door swing, `0` zoom to fit.

### `kit3d.js`

One kit per scene owner (the walkthrough, a test page) so the scene reads as one consistent model.
Albedos stay within real-world reflectance (about 2.5 to 90 percent, wall paint at most 80), and
textured surfaces carry albedo, roughness and normal maps painted procedurally at a known
real-world size (UVs are in meters), with a low-frequency macro variation so tiling never shows at
room scale. A background worker generates the common recipes ahead of time
(`prefetchTextures()`, started on import); anything not ready is generated on the main thread.

```js
export function createKit() -> {
  THREE,
  material(color, opts)            // cached MeshStandardMaterial in a plain color (merged by the builder)
  mat.<preset>                     // cached preset finishes (MATERIAL_PRESETS): white, oak, steel, fabricGrey, ...
  floorMaterial(key)               // FLOORS key: maps, macro variation, clearcoat on polished floors
  floorMeters(key)                 // the tile size (m) the floor's UVs repeat over
  paintMaterial(color = '#f1efea', { roughness = 0.6 })   // satin wall paint, orange peel, UVs in meters
  ceilingMaterial('tile' | 'drywall' | 'open')            // acoustic tile on a 0.6096 m grid, gypsum, metal deck
  glassMaterial({ tint = '#edf1ef', frosted = false })    // reflections add over the background; glass, frostedGlass are the defaults
  setEnvironmentIntensity(v)       // envMapIntensity of every kit material (default 0.5; the builder sets 0.75)
  block(parent, material, x0, x1, y0, y1, z0, z1, shadows = true, { bevel = 'auto' })
                                   // box from extents; bevel 'auto' rounds parts at least 18 mm on every side
                                   // (upholstery more), false keeps it sharp, a number is the radius in m
  cyl(parent, material, r, h, x, y0, z, { axis, segments, rTop, bevel })  // eased rims from 20 mm radius
  sphere(...), torus(...), group(), canvasTexture(size, draw, { repeat, srgb })
  dispose()                        // frees every material, texture (albedo, normal, roughness, macro)
                                   // and cached box geometry the kit made
}
export const MATERIAL_PRESETS, FLOOR_FINISHES, CEILING_TYPES   // names, for test pages
export function disposeObject(obj)  // disposes geometries under obj except the kit's shared ones
export function prefetchTextures() -> Promise, rng(seed) -> () => [0, 1)
```

Cached materials and geometry are shared, so never dispose them through a scene; call
`kit.dispose()` once nothing uses the kit (catalog modules may chain their own caches onto it).
Textures from `canvasTexture` belong to the caller.

### `builder3d.js`

```js
export function buildPlanScene(plan, { kit, quality = 'high' }) -> {
  root,          // THREE.Group named 'plan-scene' with child groups 'daylight', 'exterior',
                 // 'structure', 'furnishings', 'shading' (fake contact shadows) and 'ceilings'
  walkable,      // floor meshes for raycasting click-to-walk
  colliders,     // [{a:{x,y}, b:{x,y}, r}] plan-space wall segments (passable openings removed), r = half thickness
  obstacles,     // [{corners:[{x,y}x4]}] footprints of blocking items
  ceilings,      // Object3Ds hidden in overview mode
  bounds,        // plan-space bounds
  lights,        // the real-time area lights at windows and fixtures (reflections only; photos skip them)
  probe,         // {x, y, z} world point captureEnvironment() looks from: the largest room's middle at 1.5 m
  planLight,     // the light map: { cell (m), size [nx, ny], origin {x, y}, ms, spaceAt(x, y), levelAt(x, y),
                 //   meter(x, y, dx, dy) -> { level, daylight }: the light seen looking along (dx, dy) }
  dispose(),     // frees this build's geometry, materials, light map textures and lights
}
export function setupEnvironment(renderer, scene) -> { sun, hemi, fit(bounds), dispose() }
export function captureEnvironment(renderer, scene, built, { position }) -> { texture, dispose() }
```

Lighting works like an architectural rendering. Per build, a plan light map (two half-float
textures over the floor plate) holds the diffuse light each point receives from the ceiling
fixtures and through the windows (walls block it, doorways and glass let it through), the light
bounced around each room, and a per-room adaptation, so windows read as the main source with a
soft falloff and windowless rooms stay evenly lit. Interior materials are swapped for plan-lit
twins (made once per kit and source material) that read the map in place of a uniform fill. A
shadowed sun draws the sun patches, area lights at the windows and fixture lenses nearest the
viewer add their reflections to glossy floors, quartz and metals (only within the room they
light), and the outdoors reads several stops brighter than the interior. Fixture, bounce and fill
light are a neutral 4000 K white. Levels are scene-linear, before exposure.

- `buildPlanScene` calls `kit.setEnvironmentIntensity(0.75)`. Builder materials that do not
  depend on the plan, the plan-lit twins and their uniforms are shared by every build made with
  one kit and live as long as it does (builds never release them; the walkthrough disposes what
  its last scene used when it is disposed). `root.userData` carries `horizon` (the sky dome
  radius, for the camera's far plane), `daylight` (the area light group), `planUniforms` and
  `planLight.bind()`, which points the shared uniforms at this build's light map.
- `setupEnvironment` changes the scene: it initializes the RectAreaLight tables, sets
  `scene.environment` to a neutral interior PMREM, sets `scene.background` (the horizon color at
  daylight strength) and `scene.fog` (a light haze) when they are unset, adds the `sky-fill`
  hemisphere light, the shadow-casting `sun` (2048 or 4096 shadow map) and its target, and wraps
  `scene.onBeforeRender` so every render binds the visible plan's light map and aims its window and
  fixture lights at the camera. `fit(bounds)` aims the sun and its shadow camera at the plan.
  `dispose()` undoes all of it.
- `captureEnvironment` renders the built interior (lights, ceilings and exterior; furnishings,
  the sun and the caller's overlays left out, window lights dimmed) into a 128 px PMREM from
  `position` (default `built.probe`) for reflections and ambient tint, lit by the neutral base
  environment so rebuilds converge on the same look. It leaves the scene as it found it; the
  caller assigns `texture` to `scene.environment` and disposes the previous capture.

`buildPlanScene` throws an `Error` with a readable message when a plan cannot be built (for example
a plan too large to show); the walkthrough displays that message in place of the 3D view.
Colliders also include door leaves, jambs and sliding door glass; passable doorways keep their full
clear width. `ItemDef.contactShadow` may be `true`, `'round'` or `false`. Objects flagged
`userData.overlay` (walk target, walker figure, the daylight group) are UI or real-time stand-ins:
captures and photos leave them out.

### `postfx.js`

```js
export const QUALITIES = ['high', 'balanced', 'fast']
export function createPostFX(renderer, scene, camera, { quality = 'high', onReady }) -> {
  render(camera = api.camera)        // draw one frame; never renders on its own
  setSize(width, height, pixelRatio) // CSS pixels, as given to renderer.setSize
  setQuality(q), quality, camera
  setSceneBounds(box3 | null)        // limit AO to the building, so the sky and far exterior skip it
  passes                             // { composer, renderPass, ao, bloom, grade, output, smaa } or null in 'fast'
  ready                              // resolves (and onReady() runs) once SMAA's lookup textures are decoded
  dispose()
}
export function useGradedToneMapping(renderer)   // the same grade and AgX curve for another renderer
```

| Level | UI name | What it draws |
| --- | --- | --- |
| `high` | Realistic | Scene in half-float HDR with 4x MSAA, GTAO (16 samples, full resolution up to 1.25 AO pixels per CSS pixel), bloom on very bright windows and fixtures, color grade, AgX, SMAA |
| `balanced` | Balanced | The same with 2x MSAA, 8-sample AO at half resolution and no bloom |
| `fast` | Fast | Straight to the canvas with MSAA; the grade and AgX run inside the materials (no AO, bloom or vignette) |

Color pipeline: the scene pass draws scene-linear HDR into a multisampled target of its own (so
edges thinner than a pixel, such as trim and pendant lights, draw as lines; SMAA alone leaves them
dotted) and copies the resolved image into the chain, whose buffers carry no depth. AO, bloom and
the grade work in linear light; `OutputPass` applies `renderer.toneMapping` (AgX) and `toneMappingExposure` exactly once,
then sRGB with half-step dithering; SMAA runs last on display values. The grade (in exposed
units, so it holds if the exposure changes) is a white balance a touch cool (lit warm-white paint
reads white), a log-space contrast below a lit wall that eases to none above it, a small toe and a
smooth shoulder (sun patches, pale floors and the view out of the windows keep their texture
instead of clipping), a little saturation and a barely visible lens falloff. AO reads the
scene pass's resolved depth (no second geometry pass), rebuilds normals from it, denoises with a
cross-bilateral 5 x 5 box that cancels GTAO's rotation pattern, and is multiplied in with a
depth-aware upsample. Positions are always rebuilt at the depth texel they read, which keeps
grazing floors and tops free of false occlusion. `setQuality` switches `renderer.toneMapping`
between `AgXToneMapping` and the graded `CustomToneMapping`, and releases the full-size buffers
while 'fast' is in use.

### `walkthrough.js`

```js
export class Walkthrough extends EventTarget {
  constructor(container, store, { minimap = true, quality = 'high' })
  start(), stop()                // render loop on/off (stop when hidden)
  rebuild()                      // rebuild from store.plan (also done automatically, debounced, on 'change')
  setMode('walk' | 'overview')
  goTo({x, y, yaw, pitch}, { animate = true })
  goToCamera(id)
  setMinimap(on)                 // hide the minimap when a 2D plan is already visible (Split)
  setQuality('high' | 'balanced' | 'fast')   // the level chosen in the UI
  get quality()                  // the level in use: the chosen one, or lower while frames are slow
  get chosenQuality()            // the level last set; automatic changes never go above it
  get renderContext()            // { renderer, scene, camera, built } of the current view, for photo.js
  get pose()                     // {x, y, yaw, pitch}
  renderer                       // the THREE.WebGLRenderer (tests read renderer.info)
  screenshot() -> Promise<Blob>  // PNG of the current view, post-processing included, at full resolution
  resize(), dispose()
  // Events: 'pose' {x, y, yaw, pitch}, 'mode' {mode},
  //         'camera' {id, arriving}: heading to a saved view (arriving true), arrived (false),
  //                                  or the trip was cut short (id null)
  //         'quality' {quality, chosen, auto}: auto is true when the walkthrough lowered it itself
}
```

Rendering: AgX tone mapping at exposure 1.8 (`EXPOSURE`; keep `PHOTO_EXPOSURE` equal) in the overview.
In Walk the exposure is metered per view from the light map (`planLight.meter`, daylight counted
twice): daylit spots by the windows come down to as little as 0.6 times that, views with little
daylight keep 1.8; it eases over about 0.3 s while walking and is set at once on a jump, a rebuild
and for `screenshot()`. Photos take the live exposure. PCF soft shadows updated
only when the scene changes, and frames drawn only when something moved or changed. While moving
stays slower than 40 ms a frame, the walkthrough steps the quality down one level at a time (never
above the chosen level), then lowers the pixel ratio used while moving; idle frames keep the full
pixel ratio. After each build it fits the sun to the plan, captures the interior for reflections
(`captureEnvironment`, when builder3d.js offers it) and limits AO to the building. It owns one kit
for its whole life: rebuilds release only what each build made (`built.dispose()` plus the canvas
textures items drew), and `dispose()` calls `kit.dispose()`, releases the builder's shared
materials the last scene used, the post-processing chain, the environment and the GL context, so
`renderer.info.memory` stays level over rebuilds and mode switches and drops to near zero.

Walk controls: drag to look, `WASD`/arrows to move, `Shift` to walk faster, click the floor to walk
there, `Q`/`E` to turn, scroll to zoom (field of view), `1` to `9` jump to saved views. Collisions keep
a 0.25 m radius from walls and blocking items; doors and cased openings are passable, windows and
glass are not, and the walker stays within the plan bounds plus 15 m outdoors.

### `photo.js` and `ui/photo.js`

```js
export async function renderPhoto({ scene, camera, width = 1280, height = 720, samples = 256,
  onProgress, signal, exposure = PHOTO_EXPOSURE, bounces }) -> Promise<Blob>   // PNG
export function photoSupport() -> { ok, reason }   // WebGL 2 with float render targets
export class PhotoError extends Error { code }     // 'unsupported' | 'empty' | 'context-lost' | 'failed'
export const PHOTO_EXPOSURE                        // the walkthrough's exposure, for callers without one
```

`renderPhoto` path traces `walk.renderContext`'s scene and camera with three-gpu-pathtracer on its
own WebGL context, so the walkthrough keeps running; neither input is changed. It clones the
visible scene without overlays and real-time stand-ins (area lights, fake contact shadows, the sky
dome), lights it with a sky matching the real-time one plus the sun, turns emissive fixtures into
area lights, renders in tiles, denoises (an edge-aware a-trous filter guided by depth, normals and
albedo), adds the same subtle bloom and tone maps with the walkthrough's grade and AgX at the given
exposure (the dialog passes the live view's `toneMappingExposure`), raised by `PHOTO_GAIN` (0.3
stops) because path traced walls and ceilings get no fill light and otherwise read darker than the
live view. `onProgress(done, total,
{ phase, preview, stats })` reports 'prepare', 'compile', 'render' and 'finish'; aborting `signal`
rejects with an `AbortError`.

`createPhotoUI({ anchor, store, prefs, getWalk })` adds the Render photo button after Save image
(hidden in Plan mode). Its dialog offers sizes (`PHOTO_SIZES`: 1280 x 720, 1920 x 1080, 3840 x
2160) and qualities (`PHOTO_QUALITIES`: Draft 64, Standard 256, High 1,024 samples), shows the live
view and then the image as it renders with progress and time left, and saves a PNG named after the
plan and the saved view the walker stands at. It loads `photo.js` and the path tracer on first use.

## Vendored libraries

Everything the app runs is in `assets/vendor/`, mapped by the import map in `index.html` (dev
pages carry the same map):

| Import | Path | Version |
| --- | --- | --- |
| `three` | `three/three.module.min.js` | r160 |
| `three/addons/`, `three/examples/jsm/` | `three/addons/` | r160: OrbitControls, RoomEnvironment, RoundedBoxGeometry, RectAreaLightUniformsLib, SimplexNoise, BufferGeometryUtils, the postprocessing passes and their shaders |
| `three-gpu-pathtracer` | `three-gpu-pathtracer/index.module.js` | 0.0.23 (MIT) |
| `three-mesh-bvh` | `three-mesh-bvh/index.module.js` | 0.8.3 (MIT), used by the path tracer |

three-gpu-pathtracer 0.0.23 expects r162 or later and reads `Scene.backgroundRotation` and
`Scene.environmentRotation`, which r160 lacks; `photo.js` adds both to `THREE.Scene.prototype` as
plain `Euler` properties when they are missing (the Scene shim). Remove it when Three.js is updated.
`postfx.js` patches the stock GTAO shader's point reconstruction at runtime (see the comment there);
check that patch, and the `CustomToneMapping` replacement, when updating Three.js.

## Brand

CBRE palette (from the CBRE brand kit): CBRE green `#003F2D`, dark green `#012A2D`, accent green
`#17E88F` (small highlights only: an active indicator, one focus ring, never large fills), dark grey
`#435254` (default text and headings), light grey `#CAD1D3`, celadon `#80BBAD`, sage `#538184`,
wheat `#DBD99A`, midnight `#032842`, cement `#7F8480`, page tint `#F6F6F6`, divider grey `#C7C8CA`.
Type: Calibre for UI text and Financier Display for display headings. Both are licensed CBRE fonts
and are **not** in this repo; the CSS uses them when installed locally and falls back to system fonts.
