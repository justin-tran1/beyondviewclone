# Architecture

CBRE Virtual Walkthrough is a static, build-free web app: trace a floor plan image, furnish it,
and walk through it in 3D. Plain ES modules, Three.js r160 vendored in `assets/vendor/three/`,
no framework, no bundler. Serve the repo root over HTTP (`npm start`).

## Files and ownership

| File | Purpose |
| --- | --- |
| `index.html`, `assets/css/app.css`, `src/app.js`, `src/ui/*.js` | App shell, panels, dialogs, file handling, wiring |
| `src/model.js` | Plan schema, defaults, `normalizePlan`, entity helpers, `PlanStore` (undo/redo, selection) |
| `src/geometry.js` | Plan-space math, snapping, unit formatting and parsing |
| `src/kit3d.js` | Shared Three.js materials, floor textures and primitive builders (`createKit()`) |
| `src/catalog/registry.js` | `registerItems`, `getItem`, `itemDims`, `searchItems`, `CATEGORIES` |
| `src/catalog/{lab,medical,office,retail}.js` | Item definitions for each space type (`general` items live in `office.js`) |
| `src/plan-render.js` | Draws a plan onto a 2D canvas (editor and minimap share it) |
| `src/editor2d.js` | `PlanEditor`: interactive 2D tracing and layout editor |
| `src/builder3d.js` | Plan to Three.js scene: walls with openings, floors, ceilings, items, exterior |
| `src/walkthrough.js` | `Walkthrough`: renderer, first-person and overview cameras, collisions, minimap |
| `src/samples/*.js` | Sample plans; `src/samples/index.js` exports `SAMPLES` |
| `dev/` | Developer-only preview pages (catalog preview) |

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
whose endpoints coincide. `normalizePlan` accepts untrusted input and always returns a valid plan.

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

### `builder3d.js`

```js
export function buildPlanScene(plan, { kit, quality = 'high' }) -> {
  root,          // THREE.Group with everything, including ground and skyline
  walkable,      // floor meshes for raycasting click-to-walk
  colliders,     // [{a:{x,y}, b:{x,y}, r}] plan-space wall segments (passable openings removed), r = half thickness
  obstacles,     // [{corners:[{x,y}x4]}] footprints of blocking items
  ceilings,      // Object3Ds hidden in overview mode
  bounds,        // plan-space bounds
  dispose(),
}
export function setupEnvironment(renderer, scene) -> { sun, fit(bounds), dispose() }
```

### `walkthrough.js`

```js
export class Walkthrough extends EventTarget {
  constructor(container, store, { minimap = true })
  start(), stop()                // render loop on/off (stop when hidden)
  rebuild()                      // rebuild from store.plan (also done automatically, debounced, on 'change')
  setMode('walk' | 'overview')
  goTo({x, y, yaw, pitch}, { animate = true })
  goToCamera(id)
  setMinimap(on)                 // hide the minimap when a 2D plan is already visible (Split)
  get pose()                     // {x, y, yaw, pitch}
  screenshot() -> Promise<Blob>  // PNG of the current view
  resize(), dispose()
  // Events: 'pose' {x, y, yaw, pitch}, 'mode' {mode}
}
```

Walk controls: drag to look, `WASD`/arrows to move, `Shift` to walk faster, click the floor to walk
there, scroll to zoom (field of view), `1`–`9` jump to saved views. Collisions keep a 0.25 m radius
from walls and blocking items; doors and cased openings are passable, windows and glass are not.

## Brand

CBRE palette (from the CBRE brand kit): CBRE green `#003F2D`, dark green `#012A2D`, accent green
`#17E88F` (small highlights only: an active indicator, one focus ring, never large fills), dark grey
`#435254` (default text and headings), light grey `#CAD1D3`, celadon `#80BBAD`, sage `#538184`,
wheat `#DBD99A`, midnight `#032842`, cement `#7F8480`, page tint `#F6F6F6`, divider grey `#C7C8CA`.
Type: Calibre for UI text and Financier Display for display headings. Both are licensed CBRE fonts
and are **not** in this repo; the CSS uses them when installed locally and falls back to system fonts.
