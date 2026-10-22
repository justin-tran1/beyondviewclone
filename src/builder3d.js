// Plan to Three.js scene: walls with openings, floors, ceilings, furnished items and the exterior.
// Static geometry is written straight into per-material buckets and merged at the end, so large
// plans stay at a few dozen draw calls. Contract: docs/architecture.md (builder3d.js).
//
// Lighting is set up like an architectural rendering. A plan light map, computed per build, holds
// the diffuse light every point of the floor plate receives from the ceiling fixtures and through
// the windows (walls block it, doorways and glass let it through) plus the light bounced around each
// room, so windows read as the main light source with a soft falloff and windowless rooms stay
// evenly lit by their fixtures. Interior materials read it in their shaders in place of a uniform
// fill. A shadowed sun casts the sun patches, area lights at the windows nearest the viewer add their
// reflections to glossy floors, quartz and metals (only within the room they light), the outdoors
// reads several stops brighter than the interior, and captureEnvironment() renders the finished
// interior into the image based lighting, scaled per room by the light map. Levels are scene-linear.
import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { OPENING_TYPES } from './model.js';
import {
  add, sub, dot, norm, clamp, cross, samePoint, wallLength, wallDir, openingSpan, pointOnWall, pointInPolygon,
  polygonArea, polygonSignedArea, polygonCentroid, boundsOf, unionBounds, emptyBounds, itemCorners, normDeg, projectToSegment,
} from './geometry.js';
import { rng, disposeObject } from './kit3d.js';
import { getItem, itemDims } from './catalog/registry.js';

const TILE = 0.6096;
const TROFFER_STEP = 4 * TILE;
const DOWNLIGHT_STEP = 1.8;
const CELL_SIZE = 80;
const DECK_RISE = 0.9;
// Work limits, so an absurd plan builds quickly or fails with a reason instead of hanging.
const MAX_SPAN = 20000;
const MAX_MASK_CELLS = 250000;
const MAX_FIXTURES = 20000;
const MAX_SAMPLES = 4000;
const MAX_ITEM = 60;
const MAX_ITEM_VERTS = 3e6;
// Bulkheads taller than this stop at a white fascia instead of reading as a dark wall.
const DARK_STEP_MAX = 1.5;
const SLAB_Y = -0.003;
// Gaps in the walls up to this wide (m) still get slab: doorways not traced yet, slips in the tracing.
const SLAB_GAP = 1.5;
const GROUND_Y = -0.06;
const SKY_RATIO = 0.2;
const MULLION_STEP = 1.5;
const JOIN = 0.002;
const LEAF_T = 0.044;
const OPEN_COS = Math.cos((80 * Math.PI) / 180);
const OPEN_SIN = Math.sin((80 * Math.PI) / 180);
const BASE = { h: 0.1, out: 0.006 };
const CASING = { out: 0.035, in: 0.015, proud: 0.012 };
const MAX_ITEM_LIGHTS = 8;
const UP = [0, 1, 0];
const DOWN = [0, -1, 0];
const WORLD = { o: { x: 0, y: 0 }, d: { x: 1, y: 0 }, n: { x: 0, y: 1 } };
// Afternoon sun from the south west, about 40 degrees up, so sun patches reach into the room.
const SUN_DIR = new THREE.Vector3(-0.6, 0.64, 0.48).normalize();

// ---- Light levels (scene-linear; the walkthrough exposes by 1.8 and grades around a lit wall at 0.45).
// Sky radiance is the dome's vertex colors times SKY_SCALE, the same daylight scale photo.js uses.
const SKY_SCALE = 4;
const SKY = { horizon: '#e6ecee', zenith: '#93b6d3' };
// Exponential haze density (per meter): under 1 percent at 60 m, about a third at 500 m.
const HAZE = 0.0013;
// The sun is daylight strong: outdoors and sun patches read several stops above the interior.
const SUN = { color: '#ffecd6', intensity: 11 };
// Skylight on outdoor surfaces in shade, as emission of albedo times this (the fill light below
// cannot tell outdoors from indoors, and must stay at interior level).
const OUTDOOR_FILL = 1.6;
// The uniform fill: strong from above, weak from below, so floors read brightest, walls mid and
// ceilings darker. It lights the outdoors and anything the plan light map does not cover; indoors
// the map takes over and keeps PLAN_LIGHT.hemi of it.
const FILL = { sky: '#fbf6ef', ground: '#8f877c', intensity: 1.9 };
// Sky light through the windows: radiance of the area lights at the glass, at most `max` of them
// (aimed at the runs nearest the viewer), and the gap (m) under which windows in a row share one.
// They add only reflections; the light map carries the diffuse daylight from every window.
const DAYLIGHT = { color: '#f1f4f8', radiance: 3.5, max: 6, maxLow: 3, merge: 1.6 };
// Fixture lenses nearest the viewer that get an area light for their reflections.
const FIXTURE_LIGHTS = 4;
const LED = { color: '#fff5ea', troffer: 4.5, downlight: 7, pendant: 5, reflector: 0.28 };
// The plan light map. cell: texel size (m), grown so the map stays under maxCells; height: where
// light is evaluated (m above the floor). Emitter output is per fixture (per sample for pendant runs,
// every `pendantStep` m), set so a grid of them gives about 3 on a desk (scene-linear irradiance)
// before adaptation.
// sky: radiance of a window as seen from inside (sky above, sunlit ground below, through the glass),
// integrated in strips up to `strip` m wide. reach: how far (m) fixtures and windows light.
// bounce: interreflection as a share of the direct light, spread `spread` m locally and averaged
// over the room (plus `uplight` under open ceilings, whose pendants light the deck); walls and
// ceilings get most of their light from it, as in real offices, and `tilt` gives floors more of it
// (they see the white ceiling) than ceilings (they see the darker floor). exposure: per room
// adaptation toward `reference` (see buildPlanLight): daylit rooms stay brighter than the core, by
// less than they would in a single exposure, as a photographer shooting each room would have it.
// shade: [isotropic, directional] split of the irradiance model (windows light the wall opposite
// them, not their own wall), hemi: share of the uniform fill kept indoors, ibl: share of the image
// based diffuse light kept indoors (the bounce stands in for the rest). budget: ray steps per build.
const PLAN_LIGHT = {
  cell: 0.25, maxCells: 32000, height: 0.6,
  troffer: 6.5, downlight: 5.5, pendant: 2.4, pendantStep: 0.6,
  sky: 2.4, glass: 0.8, strip: 0.5, reach: { fixture: 5.5, window: 11 },
  bounce: { local: 0.3, room: 0.25, uplight: 0.25, spread: 1.1, tilt: 0.3 },
  exposure: { reference: 4.2, adapt: 0.6, range: [0.45, 1.7] },
  shade: [0.2, 0.8], hemi: 0.12, ibl: 0.15,
  colors: { fixture: '#fff5ea', day: '#f2f5f9', bounce: '#f7f4ef' },
  budget: 6e6,
};
// Furniture shading the light below it (the light map itself does not see items; see itemCover).
// Horizontal surfaces from `min` to `max` m above an item's base count, rasterized every `step` m
// (at most `cells` per item) in height `bands` (m); each band's penumbra reaches `penumbra` times
// its height past its edges, within `soft` (m), as light from fixtures spread over the ceiling
// would have it. Full cover takes `strength` of the light map's light. The plan's cover map has
// texels of at least `texel` m, at most `texels` of them. A kit keeps up to `cache` item cover grids.
const COVER = {
  step: 0.05, cells: 20000, min: 0.15, max: 2.4, bands: [0.35, 0.6, 0.9, 1.4], penumbra: 0.8, soft: [0.1, 0.6],
  strength: 0.6, texel: 0.08, texels: 250000, cache: 400,
};
// The light map's view meter (planLight.meter): ray directions off the view axis (radians, about
// the horizontal field of view) and the distances (m) sampled along each.
const METER = { fan: [-0.7, -0.35, 0, 0.35, 0.7], reach: [0.6, 1.3, 2.2, 3.3, 4.8, 6.6, 9] };
// Image based lighting strength for every material once the interior has been captured.
const ENV_INTENSITY = 0.75;
// While capturing, the fill and window lights are this much weaker (bright windows and fixtures keep
// full strength, plan-lit surfaces their light map level), so reflections stay vivid.
const CAPTURE_DIM = 0.4;
// Cube face size for the base and captured environments; both match so shaders are shared.
const ENV_SIZE = 128;
const PROBE_HEIGHT = 1.5;
const PAINT = '#efece6';
const WINDOW_TINT = '#dfe9e6';
const PARTITION_TINT = '#edf1ef';

const _m = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _y = new THREE.Vector3(0, 1, 0);

// ---- Public API -------------------------------------------------------------

/**
 * Build the 3D scene for a plan. opts.kit comes from createKit(); quality is 'high' or 'low'.
 * Throws an Error whose message gives the reason when the plan cannot be shown.
 */
export function buildPlanScene(plan, { kit, quality = 'high' } = {}) {
  if (!kit) throw new Error('buildPlanScene needs opts.kit from createKit()');
  checkPlan(plan);
  // Kit materials reflect the captured interior at a physically sensible strength.
  kit.setEnvironmentIntensity?.(ENV_INTENSITY);
  const owned = { geometries: [], materials: [], textures: [], extra: [] };
  const loose = [];
  try {
    return buildScene(createContext(plan, kit, quality, owned, loose));
  } catch (err) {
    release(owned, loose);
    throw new Error(`Building the 3D scene failed: ${err.message}`, { cause: err });
  }
}

/** Reject plans the builder cannot show, with a reason a person can act on. */
function checkPlan(plan) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let finite = true;
  const at = (p) => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { finite = false; return; }
    b.minX = Math.min(b.minX, p.x); b.maxX = Math.max(b.maxX, p.x);
    b.minY = Math.min(b.minY, p.y); b.maxY = Math.max(b.maxY, p.y);
  };
  const num = (...values) => { if (!values.every(Number.isFinite)) finite = false; };
  for (const w of plan.walls) { at(w.a); at(w.b); num(w.thickness, w.height); }
  for (const r of plan.rooms) { r.points.forEach(at); num(r.height ?? 0); }
  for (const o of plan.openings) num(o.offset, o.width, o.height, o.sill);
  for (const it of plan.items) { at(it); num(it.rotation || 0, it.w ?? 0, it.d ?? 0, it.h ?? 0, it.elevation ?? 0); }
  if (!finite) throw new Error('The plan has a position or size that is not a number.');
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  if (span > MAX_SPAN) {
    const km = Math.round(span / 1000).toLocaleString('en-US');
    throw new Error(`The plan is ${km} km across, and the 3D view shows plans up to ${MAX_SPAN / 1000} km across.`);
  }
}

function release(owned, loose) {
  for (const g of owned.geometries) g.dispose();
  for (const m of owned.materials) m.dispose();
  for (const key of owned.textures) releaseTexture(key);
  for (const fn of owned.extra || []) fn();
  for (const o of loose) disposeObject(o);
  owned.geometries.length = owned.materials.length = owned.textures.length = loose.length = 0;
  if (owned.extra) owned.extra.length = 0;
}

function buildScene(ctx) {
  const root = new THREE.Group();
  root.name = 'plan-scene';
  const structure = namedGroup('structure');
  const furnishings = namedGroup('furnishings');
  const ceilings = namedGroup('ceilings');
  const exterior = namedGroup('exterior');
  const shading = namedGroup('shading');

  buildWalls(ctx);
  buildFloors(ctx);
  buildCeilings(ctx);
  buildItems(ctx);
  buildExterior(ctx, exterior);
  const light = buildPlanLight(ctx);
  ctx.owned.extra.push(() => light.dispose());
  ctx.planLight = light;
  const probe = environmentProbe(ctx);
  const daylight = buildDaylight(ctx, probe);

  flush(ctx.main, structure, ctx.owned);
  flush(ctx.items, furnishings, ctx.owned);
  const walkable = flush(ctx.floors, structure, ctx.owned);
  walkable.push(buildSlab(ctx, structure));
  flush(ctx.ceil, ceilings, ctx.owned);
  for (const m of flush(ctx.fx, shading, ctx.owned)) m.renderOrder = -1;
  flush(ctx.ext, exterior, ctx.owned);
  for (const o of ctx.loose) structure.add(o);
  // Everything indoors is lit by the light map.
  for (const group of [structure, furnishings, ceilings]) {
    group.traverse((o) => {
      if (!o.isMesh) return;
      o.material = Array.isArray(o.material) ? o.material.map((m) => planMaterial(ctx.kit, m)) : planMaterial(ctx.kit, o.material);
    });
  }
  // The kit's plan-lit materials share one set of uniforms: this build binds its light map now, and
  // again before every render of a scene from setupEnvironment() that shows it (see aimSceneDaylight).
  const U = planUniforms(ctx.kit);
  const bind = () => usePlanLight(U, light, probe, daylight.userData.rectSpace);
  bind();

  // The window lights come first, so their indices in the shaders match planRectSpace.
  root.add(daylight, exterior, structure, furnishings, shading, ceilings);
  root.userData.horizon = exterior.userData.horizon;
  root.userData.daylight = daylight;
  root.userData.planUniforms = U;
  root.userData.planLight = { bind };
  root.updateMatrixWorld(true);

  return {
    root,
    walkable,
    colliders: ctx.colliders,
    obstacles: ctx.obstacles,
    ceilings: [ceilings],
    bounds: { ...ctx.bounds },
    // Real-time lights the build created (window and fixture reflections); photo.js skips them via
    // userData.overlay.
    lights: daylight.children.slice(),
    // Where captureEnvironment() looks from by default: the largest room's middle, at 1.5 m.
    probe,
    // The diffuse light map: cell size (m), grid size and origin, build time, lookups by plan point
    // and the view meter the walkthrough exposes by.
    planLight: { cell: light.cell, size: light.size, origin: light.origin, ms: light.ms, spaceAt: light.spaceAt, levelAt: light.levelAt, meter: light.meter },
    dispose() {
      root.removeFromParent();
      for (const l of daylight.children) l.dispose();
      // Let go of the light map if this build is the one bound.
      if (U.planMapA.value === light.maps[0]) usePlanLight(U, null);
      release(ctx.owned, ctx.loose);
    },
  };
}

// Per scene: the PMREM generator, cube target and base environment from setupEnvironment().
const ENV_STATE = new WeakMap();
let areaLightsReady = false;

function initAreaLights() {
  if (areaLightsReady) return;
  RectAreaLightUniformsLib.init();
  areaLightsReady = true;
}

/**
 * Image based lighting, a soft fill from above and a warm shadow casting sun. fit(bounds) re-aims
 * the sun. The environment starts as a neutral interior (so materials never look like chrome in a
 * void) and is replaced per build by captureEnvironment().
 */
export function setupEnvironment(renderer, scene) {
  initAreaLights();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const cube = new THREE.WebGLCubeRenderTarget(ENV_SIZE, { type: THREE.HalfFloatType });
  const env = baseEnvironment(renderer, pmrem, cube);
  scene.environment = env.texture;
  // The horizon at daylight strength, in case a short camera far plane clips the dome.
  const background = scene.background ? null : new THREE.Color(SKY.horizon).multiplyScalar(SKY_SCALE);
  if (background) scene.background = background;

  const hemi = new THREE.HemisphereLight(FILL.sky, FILL.ground, FILL.intensity);
  hemi.name = 'sky-fill';
  const sun = new THREE.DirectionalLight(SUN.color, SUN.intensity);
  sun.name = 'sun';
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 2;
  scene.add(hemi, sun, sun.target);
  ENV_STATE.set(scene, { pmrem, cube, base: env });
  // A light haze toward the horizon color: nothing indoors, a soft fade on distant buildings.
  const fog = scene.fog ? null : new THREE.FogExp2(new THREE.Color(SKY.horizon).multiplyScalar(SKY_SCALE * 0.9), HAZE);
  if (fog) scene.fog = fog;
  // Window daylight follows the viewer; scene.onBeforeRender runs before three gathers the lights.
  const hook = scene.onBeforeRender;
  scene.onBeforeRender = function (r, sc, camera, target) {
    hook.call(this, r, sc, camera, target);
    aimSceneDaylight(sc, camera);
  };

  function fit(bounds) {
    const b = emptyBounds(bounds) ? { minX: -10, minY: -10, maxX: 10, maxY: 10 } : bounds;
    const pad = 3;
    const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2;
    const reach = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2 + pad + 30;
    sun.target.position.set(cx, 0, cz);
    sun.position.set(cx + SUN_DIR.x * reach, SUN_DIR.y * reach, cz + SUN_DIR.z * reach);
    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
    const cam = sun.shadow.camera;
    cam.position.copy(sun.position);
    cam.lookAt(sun.target.position);
    cam.updateMatrixWorld();
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const x of [b.minX - pad, b.maxX + pad]) {
      for (const z of [b.minY - pad, b.maxY + pad]) {
        for (const y of [-0.2, 6]) {
          _v.set(x, y, z).applyMatrix4(cam.matrixWorldInverse);
          lo.min(_v);
          hi.max(_v);
        }
      }
    }
    Object.assign(cam, { left: lo.x, right: hi.x, bottom: lo.y, top: hi.y, near: Math.max(0.5, -hi.z - 2), far: -lo.z + 2 });
    cam.updateProjectionMatrix();
    const size = Math.max(hi.x - lo.x, hi.y - lo.y) > 70 ? 4096 : 2048;
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
  }
  fit(null);

  return {
    sun,
    hemi,
    fit,
    dispose() {
      scene.remove(hemi, sun, sun.target);
      scene.onBeforeRender = hook;
      sun.dispose();
      hemi.dispose();
      if (scene.environment === env.texture) scene.environment = null;
      if (background && scene.background === background) scene.background = null;
      if (fog && scene.fog === fog) scene.fog = null;
      if (ENV_STATE.get(scene)?.base === env) ENV_STATE.delete(scene);
      env.dispose();
      cube.dispose();
      pmrem.dispose();
    },
  };
}

/**
 * A neutral stand-in interior, rendered like a capture so its PMREM has the same size (and the
 * materials the same shader variants): grey floor, light walls and ceiling, a band of daylight.
 */
function baseEnvironment(renderer, pmrem, cube) {
  const scene = new THREE.Scene();
  const g = new THREE.BoxGeometry(12, 4, 12, 1, 8, 1);
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y > 1.99) c.setRGB(0.32, 0.31, 0.3);
    else if (y < -1.99) c.setRGB(0.09, 0.09, 0.09);
    else if (y > -0.6 && y < 1.2) c.setRGB(1.6, 1.7, 1.8);
    else c.setRGB(0.36, 0.35, 0.33);
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
  scene.add(new THREE.Mesh(g, m));
  const cam = new THREE.CubeCamera(0.1, 50, cube);
  cam.position.set(0, -0.5, 0);
  const prev = renderer.getRenderTarget();
  try {
    cam.update(renderer, scene);
    return pmrem.fromCubemap(cube.texture);
  } finally {
    renderer.setRenderTarget(prev);
    g.dispose();
    m.dispose();
  }
}

/**
 * Render the built interior into a PMREM environment for reflections and ambient tint, from
 * `position` (world, default built.probe: the largest room's middle at 1.5 m). Lights, ceilings
 * and the exterior are included, furnishings are left out (they are most of the geometry and
 * barely show in blurred reflections); the caller hides its own overlays first. The capture sees the
 * scene lit by the neutral base environment, never by an earlier capture, so rebuilds converge on
 * the same look. The caller assigns texture to scene.environment and disposes the previous one.
 */
export function captureEnvironment(renderer, scene, built, { position } = {}) {
  initAreaLights();
  const state = ENV_STATE.get(scene);
  const pmrem = state?.pmrem || new THREE.PMREMGenerator(renderer);
  const cube = state?.cube || new THREE.WebGLCubeRenderTarget(ENV_SIZE, { type: THREE.HalfFloatType });
  const p = position || built?.probe || { x: 0, y: PROBE_HEIGHT, z: 0 };
  const far = Math.max(600, (built?.root?.userData.horizon || 1000) * 1.3);
  const cam = new THREE.CubeCamera(0.05, far, cube);
  cam.position.set(p.x, p.y, p.z);
  cam.updateMatrixWorld(true);
  const prev = { target: renderer.getRenderTarget(), env: scene.environment };
  if (state) scene.environment = state.base.texture;
  // Aim the window lights at the probe; the scene hook would otherwise re-aim them for every face.
  // Where they were is put back afterwards, so the capture leaves the scene as it found it.
  const hook = scene.onBeforeRender;
  scene.onBeforeRender = THREE.Object3D.prototype.onBeforeRender;
  const daylight = built?.root?.userData.daylight;
  const placed = daylight && daylightState(daylight);
  built?.root?.userData.planLight?.bind();
  if (daylight) aimDaylight(daylight, p.x, p.z);
  // Sun patches are local: left in, they would brighten every room's ambient like the sunniest one.
  // The fill and window lights are dimmed by CAPTURE_DIM so surfaces they light stay modest next to
  // the windows and fixtures that reflections need. Plan-lit surfaces keep their light map level:
  // indoors only PLAN_LIGHT.ibl of the captured diffuse light is used, so their true brightness
  // makes reflections right (metals, glossy floors) without flattening the rooms. Only intensities
  // change, so shaders are reused.
  const saved = [];
  scene.traverseVisible((o) => {
    if (!o.isDirectionalLight && !o.isHemisphereLight && !o.isRectAreaLight) return;
    saved.push([o, o.intensity]);
    o.intensity *= o.isDirectionalLight ? 0 : CAPTURE_DIM;
  });
  // Furniture barely shows in blurred reflections and ambient, and is most of the geometry.
  const furnishings = built?.root?.getObjectByName('furnishings');
  const shown = furnishings?.visible;
  if (furnishings) furnishings.visible = false;
  // The sun is off, so its shadow map can wait for the next frame (which sees the furniture too).
  const shadows = renderer.shadowMap, shadowState = [shadows.autoUpdate, shadows.needsUpdate];
  shadows.autoUpdate = shadows.needsUpdate = false;
  let rt = null;
  try {
    cam.update(renderer, scene);
    rt = pmrem.fromCubemap(cube.texture);
  } finally {
    [shadows.autoUpdate, shadows.needsUpdate] = shadowState;
    scene.onBeforeRender = hook;
    if (furnishings) furnishings.visible = shown;
    for (const [o, v] of saved) o.intensity = v;
    if (placed) restoreDaylight(daylight, placed);
    scene.environment = prev.env;
    renderer.setRenderTarget(prev.target);
    if (!state) {
      pmrem.dispose();
      cube.dispose();
    }
  }
  return { texture: rt.texture, dispose: () => rt.dispose() };
}

// ---- Context, materials and textures ------------------------------------------

function createContext(plan, kit, quality, owned, loose) {
  const low = quality === 'low';
  const rooms = roomRecords(plan);
  const bounds = sceneBounds(plan, rooms);
  // The mask and wall lookups cover the building only, so a stray far item costs nothing.
  const building = buildingBounds(plan, rooms) || bounds;
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  const ctx = {
    plan, kit, low, owned, loose, rooms, bounds,
    settings: plan.settings,
    main: createBuckets(low ? Infinity : Math.max(CELL_SIZE, span / 16), { x: bounds.minX, y: bounds.minY }),
    // Furnishings merge on their own, so the environment capture can leave them out.
    items: createBuckets(low ? Infinity : Math.max(CELL_SIZE, span / 16), { x: bounds.minX, y: bounds.minY }),
    floors: createBuckets(),
    ceil: createBuckets(),
    fx: createBuckets(),
    ext: createBuckets(),
    colliders: [],
    obstacles: [],
    // Glazing that lets daylight in: the light map's windows and candidates for the area lights.
    windows: [],
    // Ceiling fixtures for the light map: { x, y (plan), h, power, cone }.
    emitters: [],
    // Placed items' cover grids for the light map: { cover, x, y (plan), y0 (elevation), rotation }.
    covers: [],
    // Fixture lenses for reflections: { x, z (plan x, y), y (height), length, breadth, dir, radiance }.
    luminaires: [],
    lights: 0,
    fixtures: MAX_FIXTURES,
    itemVerts: 0,
    unit: new Map(),
    tints: sharedStore(kit).tints,
  };
  ctx.mats = createMaterials(kit);
  ctx.mask = buildMask(plan, rooms, building);
  const H = plan.settings.wallHeight;
  // Untraced building area, one space per connected patch of the mask.
  ctx.generals = Array.from({ length: ctx.mask.freeCount }, (_, i) => ({
    index: rooms.length + i, ceiling: plan.settings.ceiling, height: H, ceilY: H,
  }));
  ctx.walls = analyzeWalls(plan.walls);
  ctx.wallInfo = [];
  for (const info of ctx.walls) ctx.wallInfo[info.index] = info;
  ctx.wallTop = wallTopIndex(plan.walls, building);
  assignDecks(ctx);
  ctx.tall = tallItems(plan);
  return ctx;
}

// Builder materials that do not depend on the plan are shared by every build made with one kit, so
// a rebuild neither recompiles their shaders nor re-uploads their textures. They live as long as
// the kit does (textures they use stay acquired for that long).
const SHARED = new WeakMap();

function sharedStore(kit) {
  let store = SHARED.get(kit);
  if (!store) SHARED.set(kit, (store = { materials: new Map(), owned: { geometries: [], materials: [], textures: [] }, tints: new Map(), lit: new Map(), plan: null, covers: new Map() }));
  return store;
}

/** The kit's shared material under `key`, made once by make(owned), where owned keeps its textures. */
function sharedMaterial(kit, key, make) {
  const store = sharedStore(kit);
  let m = store.materials.get(key);
  if (!m) {
    m = make(store.owned);
    store.materials.set(key, m);
    store.owned.materials.push(m);
  }
  return m;
}

function createMaterials(kit) {
  // Builder-made standard materials take the same image based lighting strength as the kit's.
  const standard = (opts) => new THREE.MeshStandardMaterial({ envMapIntensity: ENV_INTENSITY, ...opts });
  // Outdoor surfaces: skylight fill on top of the sun, and little of the interior's reflections.
  const outside = (opts, fill) => outdoor(standard({ envMapIntensity: 0.3, ...opts }), fill);
  const textured = {
    diffuser: (owned) => standard({ map: acquireTexture(owned, 'diffuser'), roughness: 0.45 }),
    // Exterior paving: the kit's broom finished concrete with room-scale variation, offset under the slab.
    paving: () => outdoor(Object.assign(kit.floorMaterial('concrete').clone(), {
      envMapIntensity: 0.3, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4,
    })),
    grass: (owned) => outside({ map: acquireTexture(owned, 'grass'), roughness: 1 }),
    neutral: () => outside({ color: '#c9cbc8', roughness: 0.95 }),
    facadeGlass: (owned) => outside({ map: acquireTexture(owned, 'facade-glass'), roughness: 0.35, metalness: 0.2 }),
    facadePrecast: (owned) => outside({ map: acquireTexture(owned, 'facade-precast'), roughness: 0.85 }),
    asphalt: (owned) => outside({ map: acquireTexture(owned, 'asphalt'), roughness: 0.88 }),
    stripe: () => outside({ color: '#dddbd3', roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
    roof: () => outside({ color: '#9a9e9f', roughness: 0.9 }),
    // Canopies shade themselves, so foliage takes a third of the open-sky fill.
    trunk: () => outside({ color: '#4f4339', roughness: 0.95 }, OUTDOOR_FILL / 3),
    foliage: (owned) => outside({ map: acquireTexture(owned, 'foliage'), alphaTest: 0.5, roughness: 0.8 }, OUTDOOR_FILL / 3),
    aoFloor: (owned) => shadeMaterial(owned, 0.22, 'shade-floor'),
    aoWall: (owned) => shadeMaterial(owned, 0.13, 'shade-wall'),
    aoCeiling: (owned) => shadeMaterial(owned, 0.12, 'shade-ceiling'),
    blob: (owned) => shadeMaterial(owned, 0.46, 'shade-contact'),
    // The polished slab under the building, depth-offset so rooms never z-fight with it.
    slab: () => Object.assign(kit.floorMaterial('polished-concrete').clone(), { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2 }),
    sky: () => skyMaterial(),
    'skyline-city': (owned) => skylineMaterial(owned, 'skyline-city'),
    'skyline-campus': (owned) => skylineMaterial(owned, 'skyline-campus'),
  };
  const lit = (color, emissiveIntensity, roughness = 0.3) => kit.material(color, { roughness, emissive: LED.color, emissiveIntensity });
  const mats = {
    paint: kit.paintMaterial(PAINT),
    // The outside face of exterior walls: the kit's paint in a warm grey, with the outdoor fill.
    facade: sharedMaterial(kit, 'facade', () => outdoor(kit.paintMaterial('#cbc7be', { roughness: 0.8 }).clone())),
    cut: kit.material('#454d4f', { roughness: 0.9 }),
    // Rubber cove base in a soft charcoal, so it grounds the walls without drawing a black line.
    base: kit.material('#4b4f4f', { roughness: 0.62 }),
    // Satin painted hollow metal door frames in a warm light grey (dark frames read as outlines),
    // and clear anodized aluminum storefront and window frames.
    frame: kit.material('#a9aaa5', { roughness: 0.42 }),
    alu: kit.material('#b9bdbf', { roughness: 0.34, metalness: 0.65 }),
    leaf: kit.mat.oak,
    handle: kit.mat.steel,
    sill: kit.mat.quartz,
    cap: kit.mat.oak,
    glass: kit.glassMaterial({ tint: WINDOW_TINT }),
    partition: kit.glassMaterial({ tint: PARTITION_TINT }),
    frosted: kit.glassMaterial({ frosted: true }),
    tile: kit.ceilingMaterial('tile'),
    drywall: kit.ceilingMaterial('drywall'),
    deckSoffit: kit.ceilingMaterial('open'),
    trim: kit.material('#eeede9', { roughness: 0.36 }),
    // Fixture faces: bright enough to bloom a little in the 'high' pipeline; reflectors read as lit.
    led: lit('#f6f5f1', LED.troffer),
    spot: lit('#f6f5f1', LED.downlight),
    strip: lit('#f6f5f1', LED.pendant),
    reflector: lit('#e9e8e4', LED.reflector, 0.45),
    deck: kit.material('#353d40', { roughness: 0.95 }),
    beam: kit.material('#2d3437', { roughness: 0.7 }),
    duct: kit.material('#aab0b2', { roughness: 0.38, metalness: 1 }),
    pendant: kit.mat.black,
    // White-painted pendent heads, as in a finished ceiling: polished chrome this small mirrors the
    // dark floor and reads as black specks.
    sprinkler: kit.material('#e3e2de', { roughness: 0.3 }),
    get(name) {
      return sharedMaterial(kit, name, textured[name]);
    },
  };
  Object.defineProperties(mats, {
    roof: { get: () => mats.get('roof') },
    trunk: { get: () => mats.get('trunk') },
  });
  return mats;
}

/**
 * Give an outdoor material a skylight fill: emission of its albedo times `fill`, so shaded facades
 * and ground read as daylit without brightening the interior. Keeps any shader patch the material
 * already has (kit materials). photo.js clones materials without it, as the path tracer finds the
 * real skylight.
 */
function outdoor(m, fill = OUTDOOR_FILL) {
  const base = m.onBeforeCompile, key = m.customProgramCacheKey;
  m.userData.outdoor = true;
  m.onBeforeCompile = function (shader, renderer) {
    base.call(this, shader, renderer);
    shader.uniforms.outdoorFill = { value: fill };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float outdoorFill;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * outdoorFill;');
  };
  m.customProgramCacheKey = function () {
    return `${key.call(this)}|outdoor`;
  };
  return m;
}

/** Unlit dark overlay whose alpha comes from the shared falloff texture: fake ambient occlusion. */
function shadeMaterial(owned, opacity, name) {
  return new THREE.MeshBasicMaterial({
    name, color: '#1d2321', alphaMap: acquireTexture(owned, 'falloff'), transparent: true, opacity, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
}

const TEXTURES = new Map();

/** Shared procedural textures, reference counted so rebuilds neither redraw nor re-upload them. */
function acquireTexture(owned, key) {
  let entry = TEXTURES.get(key);
  if (!entry) {
    entry = { texture: TEXTURE_MAKERS[key](), refs: 0 };
    TEXTURES.set(key, entry);
  }
  entry.refs++;
  owned.textures.push(key);
  return entry.texture;
}

function releaseTexture(key) {
  const entry = TEXTURES.get(key);
  if (entry && --entry.refs === 0) entry.texture.dispose();
}

function canvasTexture(width, height, draw, repeat = [1, 1]) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  draw(c.getContext('2d'), width, height);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 8;
  return t;
}

function skylineTexture(draw) {
  const t = canvasTexture(4096, 512, draw);
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

const TEXTURE_MAKERS = {
  diffuser: () => canvasTexture(256, 256, drawDiffuser),
  grass: () => canvasTexture(512, 512, drawGrass, [1 / 9, 1 / 9]),
  'facade-glass': () => canvasTexture(256, 256, drawGlassFacade, [1 / 3, 1 / 4]),
  'facade-precast': () => canvasTexture(256, 256, drawPrecastFacade, [1 / 3, 1 / 4]),
  asphalt: () => canvasTexture(256, 256, drawAsphalt, [1 / 4, 1 / 4]),
  foliage: () => {
    const t = canvasTexture(1024, 1024, drawFoliage);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  },
  falloff: () => {
    const t = canvasTexture(64, 64, drawFalloff);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  },
  'skyline-city': () => skylineTexture(drawCitySkyline),
  'skyline-campus': () => skylineTexture(drawCampusSkyline),
};

// ---- Geometry buckets -------------------------------------------------------------

/** Accumulates triangles per (material, shadow flags, spatial cell) for merging into one mesh each. */
function createBuckets(cellSize = Infinity, origin = { x: 0, y: 0 }) {
  const map = new Map();
  let cell = '';
  return {
    map,
    at(x, z) {
      cell = Number.isFinite(cellSize) ? `${Math.floor((x - origin.x) / cellSize)},${Math.floor((z - origin.y) / cellSize)}` : '';
      return this;
    },
    get(material, cast = true, receive = true) {
      const key = `${material.uuid}|${cast ? 1 : 0}${receive ? 1 : 0}|${cell}`;
      let b = map.get(key);
      if (!b) {
        b = { material, cast, receive, count: 0, pos: new Grow(Float32Array), nrm: new Grow(Float32Array), uv: new Grow(Float32Array), idx: new Grow(Uint32Array) };
        map.set(key, b);
      }
      return b;
    },
  };
}

/** Growable typed array. */
class Grow {
  constructor(Type, size = 192) {
    this.a = new Type(size);
    this.n = 0;
  }

  reserve(k) {
    if (this.n + k > this.a.length) {
      let size = this.a.length * 2;
      while (size < this.n + k) size *= 2;
      const next = new this.a.constructor(size);
      next.set(this.a.subarray(0, this.n));
      this.a = next;
    }
    return this.a;
  }

  copy() {
    return this.a.slice(0, this.n);
  }
}

/** Append one vertex to a bucket and return its index. */
function vert(b, x, y, z, nx, ny, nz, u, v) {
  const p = b.pos.reserve(3), n = b.nrm.reserve(3), t = b.uv.reserve(2);
  let k = b.pos.n;
  p[k] = x; p[k + 1] = y; p[k + 2] = z;
  b.pos.n = k + 3;
  k = b.nrm.n;
  n[k] = nx; n[k + 1] = ny; n[k + 2] = nz;
  b.nrm.n = k + 3;
  k = b.uv.n;
  t[k] = u; t[k + 1] = v;
  b.uv.n = k + 2;
  return b.count++;
}

function tri(b, i, j, k) {
  const a = b.idx.reserve(3);
  const n = b.idx.n;
  a[n] = i; a[n + 1] = j; a[n + 2] = k;
  b.idx.n = n + 3;
}

function flush(buckets, parent, owned) {
  const meshes = [];
  for (const b of buckets.map.values()) {
    if (!b.idx.n) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(b.pos.copy(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(b.nrm.copy(), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(b.uv.copy(), 2));
    g.setIndex(new THREE.BufferAttribute(b.count > 65535 ? b.idx.copy() : Uint16Array.from(b.idx.a.subarray(0, b.idx.n)), 1));
    if (b.tints) g.setAttribute('color', tintColors(b));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    owned.geometries.push(g);
    const mesh = new THREE.Mesh(g, b.material);
    mesh.castShadow = b.cast;
    mesh.receiveShadow = b.receive;
    mesh.matrixAutoUpdate = false;
    parent.add(mesh);
    meshes.push(mesh);
  }
  buckets.map.clear();
  return meshes;
}

/** Per-vertex colors from the (from, to, color) runs recorded while stamping into a tinted bucket. */
function tintColors(b) {
  const col = new Float32Array(b.count * 3).fill(1);
  for (let i = 0; i < b.tints.length; i += 3) {
    const c = b.tints[i + 2];
    for (let v = b.tints[i]; v < b.tints[i + 1]; v++) {
      col[v * 3] = c.r;
      col[v * 3 + 1] = c.g;
      col[v * 3 + 2] = c.b;
    }
  }
  return new THREE.BufferAttribute(col, 3);
}

/** Quad c0..c3 (world [x, y, z]) wound counter-clockwise around normal n, with a planar uv rectangle. */
function quad(b, c0, c1, c2, c3, n, u0, v0, u1, v1) {
  const i = vert(b, c0[0], c0[1], c0[2], n[0], n[1], n[2], u0, v0);
  vert(b, c1[0], c1[1], c1[2], n[0], n[1], n[2], u1, v0);
  vert(b, c2[0], c2[1], c2[2], n[0], n[1], n[2], u1, v1);
  vert(b, c3[0], c3[1], c3[2], n[0], n[1], n[2], u0, v1);
  const ax = c1[0] - c0[0], ay = c1[1] - c0[1], az = c1[2] - c0[2];
  const bx = c2[0] - c0[0], by = c2[1] - c0[1], bz = c2[2] - c0[2];
  const f = (ay * bz - az * by) * n[0] + (az * bx - ax * bz) * n[1] + (ax * by - ay * bx) * n[2];
  if (f >= 0) {
    tri(b, i, i + 1, i + 2);
    tri(b, i, i + 2, i + 3);
  } else {
    tri(b, i, i + 2, i + 1);
    tri(b, i, i + 3, i + 2);
  }
}

/** A plan frame: origin o, unit axis d and normal n (d turned 90 degrees clockwise, like wallNormal). */
const frameOf = (o, d) => ({ o, d, n: { x: -d.y, y: d.x } });
const all = (b) => ({ pu: b, nu: b, top: b, bottom: b, s0: b, s1: b });
const noBottom = (b) => ({ pu: b, nu: b, top: b, s0: b, s1: b });
const faces2 = (b) => ({ pu: b, nu: b });

/**
 * Box spanning s (along F.d), u (along F.n) and world y. `faces` maps pu, nu, top, bottom, s0 and
 * s1 to buckets; missing faces are skipped (hidden faces cost nothing).
 */
function box(F, faces, s0, s1, u0, u1, y0, y1) {
  if (s1 - s0 < 1e-5 || u1 - u0 < 1e-5 || y1 - y0 < 1e-5) return;
  const { o, d, n } = F;
  const P = (s, u, y) => [o.x + d.x * s + n.x * u, y, o.y + d.y * s + n.y * u];
  const a = P(s0, u0, y0), b = P(s1, u0, y0), c = P(s1, u1, y0), e = P(s0, u1, y0);
  const a2 = P(s0, u0, y1), b2 = P(s1, u0, y1), c2 = P(s1, u1, y1), e2 = P(s0, u1, y1);
  if (faces.pu) quad(faces.pu, e, c, c2, e2, [n.x, 0, n.y], s0, y0, s1, y1);
  if (faces.nu) quad(faces.nu, a, b, b2, a2, [-n.x, 0, -n.y], s0, y0, s1, y1);
  if (faces.top) quad(faces.top, a2, b2, c2, e2, UP, s0, u0, s1, u1);
  if (faces.bottom) quad(faces.bottom, a, b, c, e, DOWN, s0, u0, s1, u1);
  if (faces.s1) quad(faces.s1, b, c, c2, b2, [d.x, 0, d.y], u0, y0, u1, y1);
  if (faces.s0) quad(faces.s0, a, e, e2, a2, [-d.x, 0, -d.y], u0, y0, u1, y1);
}

/** Triangle or quad of [x, y, z, nx, ny, nz, u, v] vertices, wound to face along its normals. */
function poly(b, vs) {
  const i0 = b.count;
  for (const v of vs) vert(b, ...v);
  const [a, p, q] = vs;
  const ax = p[0] - a[0], ay = p[1] - a[1], az = p[2] - a[2], bx = q[0] - a[0], by = q[1] - a[1], bz = q[2] - a[2];
  let nx = 0, ny = 0, nz = 0;
  for (const v of vs) { nx += v[3]; ny += v[4]; nz += v[5]; }
  const f = (ay * bz - az * by) * nx + (az * bx - ax * bz) * ny + (ax * by - ay * bx) * nz;
  const order = f >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
  for (let k = 0; k < (vs.length === 4 ? 6 : 3); k += 3) tri(b, i0 + order[k], i0 + order[k + 1], i0 + order[k + 2]);
}

const FACE_KEYS = [['s0', 's1'], ['nu', 'pu'], ['bottom', 'top']];

/**
 * Box like box() whose edges between drawn faces are rounded off to radius r: each face is inset by
 * r, joined to its neighbors by a strip whose normals turn from one face to the other, and closed at
 * corners by a small triangle, so edges catch highlights instead of reading razor sharp. One bucket
 * for every face; `faces` lists the faces to draw (all by default). UVs are in meters like box();
 * grain: true turns them a quarter so wood grain runs up a door leaf. 44 triangles for a full box.
 */
function rbox(ctx, F, b, s0, s1, u0, u1, y0, y1, r, { faces = null, grain = false } = {}) {
  const lo = [s0, u0, y0], hi = [s1, u1, y1];
  const has = FACE_KEYS.map((pair) => pair.map((k) => !faces || faces.includes(k)));
  const size = [s1 - s0, u1 - u0, y1 - y0];
  if (size.some((v) => v < 1e-5)) return;
  r = Math.min(r, ...size.map((v) => v * 0.45));
  if (ctx.low || r < 0.0008) {
    const set = {};
    FACE_KEYS.forEach((pair, i) => pair.forEach((k, side) => { if (has[i][side]) set[k] = b; }));
    box(F, set, s0, s1, u0, u1, y0, y1);
    return;
  }
  const { o, d, n } = F;
  const axisN = [[d.x, 0, d.y], [n.x, 0, n.y], [0, 1, 0]];
  // A vertex on the face of axis i, side `side`, at local point c, with that face's normal and uv.
  const V = (i, side, c) => {
    const sg = side ? 1 : -1;
    const x = o.x + d.x * c[0] + n.x * c[1], z = o.y + d.y * c[0] + n.y * c[1];
    const [pu, pv] = i === 0 ? [c[1], c[2]] : i === 1 ? [c[0], c[2]] : [c[0], c[1]];
    const [uu, vv] = grain ? [pv, pu] : [pu, pv];
    return [x, c[2], z, axisN[i][0] * sg, axisN[i][1] * sg, axisN[i][2] * sg, uu, vv];
  };
  // Inset of axis j at its low or high end: r where the face there is drawn (that edge is rounded).
  const lim = (j, side) => (side ? hi[j] - (has[j][1] ? r : 0) : lo[j] + (has[j][0] ? r : 0));
  const at = (i, side) => (side ? hi[i] : lo[i]);
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3, k = (i + 2) % 3;
    for (const side of [0, 1]) {
      if (!has[i][side]) continue;
      const c = (sj, sk) => {
        const p = [0, 0, 0];
        p[i] = at(i, side);
        p[j] = lim(j, sj);
        p[k] = lim(k, sk);
        return V(i, side, p);
      };
      poly(b, [c(0, 0), c(1, 0), c(1, 1), c(0, 1)]);
    }
  }
  // Edges between faces of axes i and j, along axis k.
  for (let k = 0; k < 3; k++) {
    const i = (k + 1) % 3, j = (k + 2) % 3;
    for (const si of [0, 1]) {
      for (const sj of [0, 1]) {
        if (!has[i][si] || !has[j][sj]) continue;
        const e = (sk, onI) => {
          const p = [0, 0, 0];
          p[k] = lim(k, sk);
          p[i] = onI ? at(i, si) : lim(i, si);
          p[j] = onI ? lim(j, sj) : at(j, sj);
          return V(onI ? i : j, onI ? si : sj, p);
        };
        poly(b, [e(0, true), e(1, true), e(1, false), e(0, false)]);
      }
    }
  }
  // Corners where three drawn faces meet.
  for (const ss of [0, 1]) {
    for (const su of [0, 1]) {
      for (const sy of [0, 1]) {
        const sides = [ss, su, sy];
        if (![0, 1, 2].every((a) => has[a][sides[a]])) continue;
        poly(b, [0, 1, 2].map((a) => {
          const p = [0, 1, 2].map((m) => (m === a ? at(m, sides[m]) : lim(m, sides[m])));
          return V(a, sides[a], p);
        }));
      }
    }
  }
}

/** Append a BufferGeometry transformed by matrix; range limits it to one geometry group. */
function appendGeometry(b, g, matrix, range = null) {
  const pos = g.attributes.position;
  if (!pos) return;
  if (!g.attributes.normal) g.computeVertexNormals();
  const nrm = g.attributes.normal, uv = g.attributes.uv, index = g.index;
  const raw = (a, size) => (a && !a.isInterleavedBufferAttribute && !a.normalized && a.itemSize === size ? a.array : null);
  const P = raw(pos, 3), N = raw(nrm, 3), T = raw(uv, 2);
  const e = matrix.elements;
  const nm = _nm.getNormalMatrix(matrix).elements;
  const n = pos.count;
  const PA = b.pos.reserve(n * 3), NA = b.nrm.reserve(n * 3), TA = b.uv.reserve(n * 2);
  let pk = b.pos.n, nk = b.nrm.n, tk = b.uv.n;
  for (let i = 0; i < n; i++) {
    const x = P ? P[i * 3] : pos.getX(i), y = P ? P[i * 3 + 1] : pos.getY(i), z = P ? P[i * 3 + 2] : pos.getZ(i);
    const nx = N ? N[i * 3] : nrm.getX(i), ny = N ? N[i * 3 + 1] : nrm.getY(i), nz = N ? N[i * 3 + 2] : nrm.getZ(i);
    const wx = nm[0] * nx + nm[3] * ny + nm[6] * nz, wy = nm[1] * nx + nm[4] * ny + nm[7] * nz, wz = nm[2] * nx + nm[5] * ny + nm[8] * nz;
    const l = Math.hypot(wx, wy, wz) || 1;
    PA[pk++] = e[0] * x + e[4] * y + e[8] * z + e[12];
    PA[pk++] = e[1] * x + e[5] * y + e[9] * z + e[13];
    PA[pk++] = e[2] * x + e[6] * y + e[10] * z + e[14];
    NA[nk++] = wx / l;
    NA[nk++] = wy / l;
    NA[nk++] = wz / l;
    TA[tk++] = T ? T[i * 2] : uv ? uv.getX(i) : 0;
    TA[tk++] = T ? T[i * 2 + 1] : uv ? uv.getY(i) : 0;
  }
  b.pos.n = pk;
  b.nrm.n = nk;
  b.uv.n = tk;
  const base = b.count;
  b.count += n;
  const I = index ? index.array : null;
  const total = I ? index.count : n;
  const start = range ? range.start : 0;
  const end = range ? Math.min(total, range.start + range.count) : total;
  const flip = matrix.determinant() < 0;
  const IA = b.idx.reserve(Math.max(0, end - start));
  let ik = b.idx.n;
  for (let k = start; k + 2 < end; k += 3) {
    const i0 = base + (I ? I[k] : k), i1 = base + (I ? I[k + 1] : k + 1), i2 = base + (I ? I[k + 2] : k + 2);
    IA[ik++] = i0;
    IA[ik++] = flip ? i2 : i1;
    IA[ik++] = flip ? i1 : i2;
  }
  b.idx.n = ik;
}

function unitGeometry(ctx, key, make) {
  let g = ctx.unit.get(key);
  if (!g) ctx.unit.set(key, (g = make()));
  return g;
}

/** Vertical cylinder standing on y0. */
function cylinder(ctx, b, x, y0, z, r, h, segments = 16) {
  const g = unitGeometry(ctx, `cyl${segments}`, () => new THREE.CylinderGeometry(1, 1, 1, segments));
  _m.compose(_v.set(x, y0 + h / 2, z), _q.identity(), _s.set(r, h, r));
  appendGeometry(b, g, _m);
}

/** Cylinder between two world points. */
function tube(ctx, b, p0, p1, r, segments = 16) {
  const g = unitGeometry(ctx, `cyl${segments}`, () => new THREE.CylinderGeometry(1, 1, 1, segments));
  const dir = new THREE.Vector3().subVectors(p1, p0);
  const len = dir.length();
  if (len < 1e-3) return;
  _q.setFromUnitVectors(_y, dir.normalize());
  _m.compose(_v.addVectors(p0, p1).multiplyScalar(0.5), _q, _s.set(r, len, r));
  appendGeometry(b, g, _m);
}

function sphere(ctx, b, x, y, z, r, segments = 12, scaleY = 1) {
  const g = unitGeometry(ctx, `sph${segments}`, () => new THREE.SphereGeometry(1, segments, Math.max(6, segments >> 1)));
  _m.compose(_v.set(x, y, z), _q.identity(), _s.set(r, r * scaleY, r));
  appendGeometry(b, g, _m);
}

const namedGroup = (name) => Object.assign(new THREE.Group(), { name });

// ---- Plan analysis --------------------------------------------------------------

function cleanPolygon(points) {
  const out = [];
  for (const p of points) if (!out.length || !samePoint(out[out.length - 1], p)) out.push({ x: p.x, y: p.y });
  if (out.length > 1 && samePoint(out[0], out[out.length - 1])) out.pop();
  return out;
}

/** Polygon offset outward by d (mitered, limited at sharp corners); falls back to the input if it folds. */
function grownPolygon(points, d) {
  const n = points.length;
  const area = polygonSignedArea(points);
  const s = area > 0 ? 1 : -1;
  const out = points.map((p, i) => {
    const a = points[(i - 1 + n) % n], b = points[(i + 1) % n];
    const e1 = norm(sub(p, a)), e2 = norm(sub(b, p));
    const n1 = { x: e1.y * s, y: -e1.x * s }, n2 = { x: e2.y * s, y: -e2.x * s };
    const m = norm(add(n1, n2));
    const k = d / Math.max(0.35, dot(m, n1));
    return { x: p.x + m.x * k, y: p.y + m.y * k };
  });
  return Math.abs(polygonSignedArea(out)) > Math.abs(area) ? out : points;
}

function triangulate(points) {
  const contour = points.map((p) => new THREE.Vector2(p.x, p.y));
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);
  return { contour, faces };
}

function roomRecords(plan) {
  const H = plan.settings.wallHeight;
  return plan.rooms.map((r, i) => {
    const points = cleanPolygon(r.points);
    if (points.length < 3 || polygonArea(points) < 0.05) return null;
    const bounds = boundsOf(points);
    const bw = bounds.maxX - bounds.minX, bh = bounds.maxY - bounds.minY;
    return {
      room: r, points, bounds,
      height: r.height ?? H,
      ceiling: r.ceiling,
      floor: r.floor,
      centroid: polygonCentroid(points),
      // Flat ceilings sit 1 to 4 mm under their nominal height: below wall tops and apart from neighbors.
      ceilY: (r.height ?? H) - (1 + (i % 4)) * 0.001,
      rect: points.length === 4 && Math.abs(polygonArea(points) - bw * bh) < 1e-3 * bw * bh,
      contains: (p) => p.x >= bounds.minX && p.x <= bounds.maxX && p.y >= bounds.minY && p.y <= bounds.maxY && pointInPolygon(p, points),
      ...triangulate(points),
      // Ceilings and decks are grown slightly so neighbors overlap without cracks.
      grown: triangulate(grownPolygon(points, 0.02)),
    };
  }).filter(Boolean).map((rm, index) => Object.assign(rm, { index }));
}

function wallBounds(w) {
  const t = w.thickness / 2;
  return { minX: Math.min(w.a.x, w.b.x) - t, minY: Math.min(w.a.y, w.b.y) - t, maxX: Math.max(w.a.x, w.b.x) + t, maxY: Math.max(w.a.y, w.b.y) + t };
}

/** Bounds of the walls and rooms, or null when there are none. */
function buildingBounds(plan, rooms) {
  let b = null;
  for (const bb of [...plan.walls.map(wallBounds), ...rooms.map((r) => r.bounds)]) b = b ? unionBounds(b, bb) : bb;
  return b && !emptyBounds(b) ? b : null;
}

function sceneBounds(plan, rooms) {
  let b = null;
  const grow = (bb) => { b = b ? unionBounds(b, bb) : bb; };
  for (const w of plan.walls) grow(wallBounds(w));
  for (const r of rooms) grow(r.bounds);
  for (const item of plan.items) grow(boundsOf(itemCorners(item, itemSize(item))));
  return b && !emptyBounds(b) ? b : { minX: -5, minY: -5, maxX: 5, maxY: 5 };
}

/**
 * Raster of the building: which cells are inside (in a room, or enclosed by walls along both
 * axes) and which room covers each cell center. Drives exterior wall faces and the ceilings of
 * areas that are not traced as rooms.
 */
function buildMask(plan, rooms, bounds) {
  const pad = 1;
  const minX = bounds.minX - pad, minY = bounds.minY - pad;
  const w = bounds.maxX - bounds.minX + pad * 2, h = bounds.maxY - bounds.minY + pad * 2;
  const c = Math.max(clamp(Math.sqrt((w * h) / 60000), 0.1, 0.6), Math.sqrt((w * h) / MAX_MASK_CELLS));
  const nx = Math.ceil(w / c), ny = Math.ceil(h / c);
  const room = new Int32Array(nx * ny).fill(-1);
  const cx = (i) => minX + (i + 0.5) * c, cy = (j) => minY + (j + 0.5) * c;
  rooms.forEach((rm, ri) => {
    const b = rm.bounds;
    const i0 = Math.max(0, Math.floor((b.minX - minX) / c)), i1 = Math.min(nx - 1, Math.floor((b.maxX - minX) / c));
    const j0 = Math.max(0, Math.floor((b.minY - minY) / c)), j1 = Math.min(ny - 1, Math.floor((b.maxY - minY) / c));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * nx + i;
        if (room[k] < 0 && pointInPolygon({ x: cx(i), y: cy(j) }, rm.points)) room[k] = ri;
      }
    }
  });
  const walls = plan.walls.filter((wl) => wl.kind !== 'partial');
  // Per row (or column) of cell centers, the outermost wall crossings; each wall visits only the rows it spans.
  const crossings = (count, at, origin, along, across) => {
    const lo = new Float64Array(count).fill(Infinity), hi = new Float64Array(count).fill(-Infinity);
    for (const wl of walls) {
      const a0 = wl.a[across], b0 = wl.b[across];
      if (a0 === b0) continue;
      const j0 = Math.max(0, Math.ceil((Math.min(a0, b0) - origin) / c - 0.5));
      const j1 = Math.min(count - 1, Math.floor((Math.max(a0, b0) - origin) / c - 0.5));
      for (let j = j0; j <= j1; j++) {
        const x = wl.a[along] + ((at(j) - a0) / (b0 - a0)) * (wl.b[along] - wl.a[along]);
        if (x < lo[j]) lo[j] = x;
        if (x > hi[j]) hi[j] = x;
      }
    }
    return { lo, hi };
  };
  const rows = crossings(ny, cy, minY, 'x', 'y');
  const cols = crossings(nx, cx, minX, 'y', 'x');
  const inside = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i, x = cx(i), y = cy(j);
      inside[k] = room[k] >= 0 || (x > rows.lo[j] && x < rows.hi[j] && y > cols.lo[i] && y < cols.hi[i]) ? 1 : 0;
    }
  }
  const index = (x, y) => {
    const i = Math.floor((x - minX) / c), j = Math.floor((y - minY) / c);
    return i < 0 || j < 0 || i >= nx || j >= ny ? -1 : j * nx + i;
  };
  return {
    minX, minY, c, nx, ny, room, inside, index,
    ...freePatches(nx, ny, room, inside),
    insideAt: (x, y) => {
      const k = index(x, y);
      return k >= 0 ? inside[k] : 0;
    },
  };
}

/** Inside cells that no room covers, labeled by 4-connected patch (-1 elsewhere). */
function freePatches(nx, ny, room, inside) {
  const n = nx * ny;
  const free = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const open = (k) => free[k] < 0 && inside[k] === 1 && room[k] < 0;
  let freeCount = 0;
  for (let k0 = 0; k0 < n; k0++) {
    if (!open(k0)) continue;
    let top = 0;
    const take = (k) => { free[k] = freeCount; stack[top++] = k; };
    take(k0);
    while (top) {
      const k = stack[--top], i = k % nx;
      if (i > 0 && open(k - 1)) take(k - 1);
      if (i < nx - 1 && open(k + 1)) take(k + 1);
      if (k >= nx && open(k - nx)) take(k - nx);
      if (k + nx < n && open(k + nx)) take(k + nx);
    }
    freeCount++;
  }
  return { free, freeCount };
}

/**
 * Tallest wall that a plan point lies on (within half its thickness plus 5 cm), from a grid of walls.
 * heightOf(index, p) can count more than the wall's own height.
 */
function wallTopIndex(walls, bounds) {
  const cell = Math.max(2, Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 256);
  const cells = new Map();
  const ci = (x) => Math.floor((x - bounds.minX) / cell), cj = (y) => Math.floor((y - bounds.minY) / cell);
  walls.forEach((w, n) => {
    // Samples every half cell, padded by the sampling slack, reach every cell the wall's band touches.
    const pad = w.thickness / 2 + 0.05 + cell / 4;
    const steps = Math.max(1, Math.ceil(wallLength(w) / (cell / 2)));
    for (let k = 0; k <= steps; k++) {
      const x = w.a.x + ((w.b.x - w.a.x) * k) / steps, y = w.a.y + ((w.b.y - w.a.y) * k) / steps;
      for (let i = ci(x - pad); i <= ci(x + pad); i++) {
        for (let j = cj(y - pad); j <= cj(y + pad); j++) {
          const key = `${i},${j}`;
          if (!cells.has(key)) cells.set(key, []);
          const list = cells.get(key);
          if (list[list.length - 1] !== n) list.push(n);
        }
      }
    }
  });
  return (p, heightOf = (n) => walls[n].height) => {
    let top = 0;
    for (const n of cells.get(`${ci(p.x)},${cj(p.y)}`) || []) {
      const w = walls[n];
      if (distToSegment(p, w.a, w.b) < w.thickness / 2 + 0.05) top = Math.max(top, heightOf(n, p));
    }
    return top;
  };
}

/** Grow a cell mask by `steps` cells (8-connected) into cells that `allow` accepts. */
function dilate(mask, src, steps, allow = () => true) {
  const { nx, ny } = mask;
  let cur = src;
  for (let s = 0; s < steps; s++) {
    const out = cur.slice();
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (cur[k] || !allow(k)) continue;
        let hit = false;
        for (let dj = -1; dj <= 1 && !hit; dj++) {
          for (let di = -1; di <= 1 && !hit; di++) {
            const ii = i + di, jj = j + dj;
            if (ii >= 0 && jj >= 0 && ii < nx && jj < ny && cur[jj * nx + ii]) hit = true;
          }
        }
        if (hit) out[k] = 1;
      }
    }
    cur = out;
  }
  return cur;
}

/**
 * Square morphology on a cell mask: every cell within `steps` cells (along both axes) of one holding
 * `value` takes that value, so 1 grows the set and 0 shrinks it. Cells off the grid hold 0.
 */
function spreadCells(mask, cells, steps, value) {
  const { nx, ny } = mask;
  let cur = cells;
  // A square is a row sweep then a column sweep; each line is swept both ways from the last `value`.
  for (const [n, lines, along, across] of [[nx, ny, 1, nx], [ny, nx, nx, 1]]) {
    const out = cur.slice();
    for (let l = 0; l < lines; l++) {
      for (const back of [false, true]) {
        let d = value ? Infinity : 0;
        for (let t = 0; t < n; t++) {
          const k = l * across + (back ? n - 1 - t : t) * along;
          d = cur[k] === value ? 0 : d + 1;
          if (d <= steps) out[k] = value;
        }
      }
    }
    cur = out;
  }
  return cur;
}

/** Merge set cells into axis-aligned rectangles (row runs stacked while they line up). */
function maskRects(mask, cells) {
  const { nx, ny, c, minX, minY } = mask;
  const rects = [];
  let open = new Map();
  for (let j = 0; j < ny; j++) {
    const next = new Map();
    for (let i = 0; i < nx;) {
      if (!cells[j * nx + i]) { i++; continue; }
      const i0 = i;
      while (i < nx && cells[j * nx + i]) i++;
      const key = i0 * 1e6 + i;
      const r = open.get(key);
      if (r) r.j1 = j + 1;
      const rect = r || { i0, i1: i, j0: j, j1: j + 1 };
      if (!r) rects.push(rect);
      next.set(key, rect);
    }
    open = next;
  }
  return rects.map((r) => ({ minX: minX + r.i0 * c, maxX: minX + r.i1 * c, minY: minY + r.j0 * c, maxY: minY + r.j1 * c }));
}

/**
 * The room at plan point p (by its polygon; the mask only proposes candidates), else the untraced
 * building area there, else null outdoors.
 */
function spaceAt(ctx, p) {
  const { mask, rooms } = ctx;
  const i = Math.floor((p.x - mask.minX) / mask.c), j = Math.floor((p.y - mask.minY) / mask.c);
  let best = -1;
  for (let jj = j - 1; jj <= j + 1; jj++) {
    for (let ii = i - 1; ii <= i + 1; ii++) {
      if (ii < 0 || jj < 0 || ii >= mask.nx || jj >= mask.ny) continue;
      const ri = mask.room[jj * mask.nx + ii];
      if (ri >= 0 && (best < 0 || ri < best) && rooms[ri].contains(p)) best = ri;
    }
  }
  if (best >= 0) return rooms[best];
  const k = mask.index(p.x, p.y);
  return k >= 0 && mask.free[k] >= 0 ? ctx.generals[mask.free[k]] : null;
}

/** A room's edges sampled about every 0.4 m: the space just outside each sample and the tallest wall on it. */
function edgeSamples(ctx, rm) {
  if (rm.edges) return rm.edges;
  rm.edges = [];
  const n = rm.points.length;
  const sign = polygonSignedArea(rm.points) > 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const a = rm.points[i], b = rm.points[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 0.05) continue;
    const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const out = { x: d.y * sign, y: -d.x * sign };
    const steps = clamp(Math.round(len / 0.4), 1, 1000);
    const samples = [];
    for (let k = 0; k < steps; k++) {
      const s0 = (len * k) / steps, s1 = (len * (k + 1)) / steps, sm = (s0 + s1) / 2;
      const p = { x: a.x + d.x * sm, y: a.y + d.y * sm };
      samples.push({ s0, s1, p, other: spaceAt(ctx, { x: p.x + out.x * 0.3, y: p.y + out.y * 0.3 }), wallTop: ctx.wallTop(p) });
    }
    rm.edges.push({ F: frameOf(a, d), sign, samples });
  }
  return rm.edges;
}

/**
 * Deck (roof soffit) heights. Spaces share a deck, the highest DECK_RISE above any of their
 * ceilings, unless a wall between them is as tall as the taller ceiling and clears the lower
 * side's deck: a low office inside a warehouse sits under the warehouse deck, while a lower wing
 * behind a full height wall keeps its own lower roof.
 */
function assignDecks(ctx) {
  const spaces = [...ctx.rooms, ...ctx.generals];
  const parent = spaces.map((s, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (const rm of ctx.rooms) {
    for (const { samples } of edgeSamples(ctx, rm)) {
      for (const { other, wallTop } of samples) {
        if (!other || other === rm) continue;
        const hi = Math.max(rm.height, other.height), lo = Math.min(rm.height, other.height);
        if (wallTop < Math.max(hi, lo + DECK_RISE) - 0.05) parent[find(rm.index)] = find(other.index);
      }
    }
  }
  const top = new Map();
  spaces.forEach((s, i) => top.set(find(i), Math.max(top.get(find(i)) ?? 0, s.height + DECK_RISE)));
  spaces.forEach((s, i) => { s.deck = top.get(find(i)); });
}

/** An item's size, capped like normalizePlan caps it, so a raw plan cannot ask for a kilometer-long shelf. */
function itemSize(item) {
  const { w, d, h } = itemDims(item);
  return { w: Math.min(w, MAX_ITEM), d: Math.min(d, MAX_ITEM), h: Math.min(h, MAX_ITEM) };
}

/** Footprints and tops of blocking items, for keeping ceiling fixtures clear of columns and the like. */
function tallItems(plan) {
  return plan.items.filter((item) => getItem(item.type).blocking !== false).map((item) => {
    const dims = itemSize(item);
    return { item, dims, top: (item.elevation ?? 0) + dims.h, bounds: boundsOf(itemCorners(item, dims)) };
  });
}

// ---- Walls -------------------------------------------------------------------

function buildWalls(ctx) {
  const byWall = new Map();
  for (const o of ctx.plan.openings) {
    if (!byWall.has(o.wallId)) byWall.set(o.wallId, []);
    byWall.get(o.wallId).push(o);
  }
  // First what each wall borders and how high it reaches at its ends, which its neighbors' end faces need.
  for (const info of ctx.walls) {
    info.spans = openingSpans(info.w, byWall.get(info.w.id) || []);
    info.inner = interiorSide(ctx, info);
    info.sides = sideRuns(ctx, info);
    info.tops = info.sides.map((run) => runTop(info.w, run));
    info.reach = { a: info.tops[0], b: info.tops[info.tops.length - 1] };
  }
  for (const info of ctx.walls) {
    const { w, L } = info;
    const mid = pointOnWall(w, L / 2);
    ctx.main.at(mid.x, mid.y);
    ctx.ceil.at(mid.x, mid.y);
    ctx.fx.at(mid.x, mid.y);
    if (w.kind === 'glass') glassWall(ctx, info);
    else if (w.kind === 'partial') partialWall(ctx, info);
    else paintedWall(ctx, info);
    upperWall(ctx, info);
    addColliders(ctx, info);
  }
}

/** Walls with an endpoint within samePoint tolerance of p, from a 1 cm hash of the endpoints. */
function endpointIndex(walls) {
  const map = new Map();
  walls.forEach((w, n) => {
    for (const p of [w.a, w.b]) {
      const key = `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(n);
    }
  });
  return (p) => {
    const out = new Set();
    const i = Math.round(p.x * 100), j = Math.round(p.y * 100);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) for (const n of map.get(`${i + di},${j + dj}`) || []) out.add(n);
    return out;
  };
}

/**
 * Per wall: length, frame and how each end joins its neighbors. A collinear neighbor continues the
 * wall (the two overlap by a hair). A tee into a through wall stops at that wall's centerline, well
 * behind its far face, so nothing bleeds through the facade. At a corner the end extends by the
 * neighbor's half thickness, so faces meet flush and the corner closes. `buriers` are the neighbors
 * that hide the end face.
 */
function analyzeWalls(walls) {
  const out = [];
  const dirs = walls.map(wallDir);
  const near = endpointIndex(walls);
  walls.forEach((w, i) => {
    const L = wallLength(w);
    if (L < 0.01) return;
    const d = dirs[i];
    const F = frameOf(w.a, d);
    const ends = {};
    for (const end of ['a', 'b']) {
      const p = w[end];
      const along = [], across = [];
      for (const j of near(p)) {
        const other = walls[j];
        if (j === i || wallLength(other) < 0.01) continue;
        const otherEnd = samePoint(p, other.a) ? 'a' : samePoint(p, other.b) ? 'b' : null;
        if (!otherEnd) continue;
        const n = { j, end: otherEnd, other, far: otherEnd === 'a' ? other.b : other.a };
        (Math.abs(cross(d, dirs[j])) < 0.1 ? along : across).push(n);
      }
      const e = { ext: 0, side: 0, corner: false, tee: false, buriers: [] };
      if (along.length) {
        e.ext = JOIN / 2;
        e.buriers = along.filter((n) => n.other.thickness >= w.thickness - 1e-3);
      } else if (across.length) {
        const through = across.filter((n) => across.some((m) => m !== n
          && Math.abs(cross(dirs[n.j], dirs[m.j])) < 0.1 && dot(sub(n.far, p), sub(m.far, p)) < 0));
        if (through.length) {
          e.tee = true;
          e.buriers = through;
        } else {
          e.corner = true;
          for (const n of across) {
            if (n.other.thickness / 2 >= e.ext) {
              e.ext = n.other.thickness / 2;
              e.side = Math.sign(dot(sub(n.far, p), F.n));
            }
          }
          e.buriers = across;
        }
      }
      ends[end] = e;
    }
    out.push({ w, L, d, F, ends, ext: { a: ends.a.ext, b: ends.b.ext }, index: i });
  });
  return out;
}

/** Height up to which a wall's end face is hidden inside the neighbors at that end. */
function cover(ctx, info, end) {
  const e = info.ends[end];
  const reach = e.buriers.map((n) => ctx.wallInfo[n.j]?.reach?.[n.end] ?? 0);
  if (!reach.length) return 0;
  // At a tee the end face shows above the lower of the two through pieces.
  return e.tee ? Math.min(...reach) : Math.max(...reach);
}

/** Face set with the end faces dropped where the neighbors hide them up to `top`. */
function endFaces(ctx, info, faces, first, last, top) {
  return {
    ...faces,
    s0: first && cover(ctx, info, 'a') >= top - 1e-3 ? null : faces.s0,
    s1: last && cover(ctx, info, 'b') >= top - 1e-3 ? null : faces.s1,
  };
}

/**
 * Opening spans that fit this wall, sorted along it. Where openings overlap, doors keep their full
 * width and windows keep what is left beside them, so every opening still cuts the wall; before and
 * after link spans that touch.
 */
function openingSpans(w, list) {
  const spans = list
    .filter((o) => OPENING_TYPES[o.type])
    .filter((o) => o.type !== 'window' || (w.kind !== 'glass' && w.kind !== 'partial' && o.sill < w.height - 0.3))
    .map((o, k) => ({ o, k, ...openingSpan(w, o) }))
    .sort((p, q) => OPENING_TYPES[q.o.type].passable - OPENING_TYPES[p.o.type].passable || p.k - q.k);
  const taken = [];
  const out = [];
  for (const s of spans) {
    let pieces = [[s.start, s.end]];
    for (const [a, b] of taken) pieces = pieces.flatMap(([p, q]) => (b <= p || a >= q ? [[p, q]] : [[p, Math.min(q, a)], [Math.max(p, b), q]]));
    for (const [p, q] of pieces) if (q - p > 0.15) out.push({ o: s.o, start: p, end: q });
    taken.push([s.start, s.end]);
  }
  out.sort((p, q) => p.start - q.start);
  out.forEach((sp, i) => {
    sp.before = i > 0 && out[i - 1].end > sp.start - 1e-3 ? out[i - 1] : null;
    sp.after = i < out.length - 1 && out[i + 1].start < sp.end + 1e-3 ? out[i + 1] : null;
  });
  return out;
}

/**
 * The spaces on each side of a wall along its length (pu along F.n, nu against it; null outdoors), as
 * runs over which the ceilings and decks stay the same. Boundaries are found to about 5 mm.
 */
function sideRuns(ctx, { w, L, F, ext }) {
  const off = w.thickness / 2 + 0.25;
  const side = (s, sign) => spaceAt(ctx, { x: F.o.x + F.d.x * s + F.n.x * off * sign, y: F.o.y + F.d.y * s + F.n.y * off * sign });
  const key = (sp) => (sp ? `${sp.ceiling === 'open' ? 'open' : sp.ceilY.toFixed(3)}/${sp.deck.toFixed(3)}` : 'out');
  const probe = (s) => {
    const pu = side(s, 1), nu = side(s, -1);
    return { s, pu, nu, key: `${key(pu)}|${key(nu)}` };
  };
  const s0 = -ext.a, s1 = L + ext.b;
  const n = clamp(Math.ceil((s1 - s0) / 0.5), 1, 200);
  const runs = [];
  let run = null, last = null;
  for (let k = 0; k < n; k++) {
    const p = probe(s0 + ((k + 0.5) * (s1 - s0)) / n);
    if (run && p.key === run.key) {
      last = p;
      continue;
    }
    if (run) {
      let lo = last.s, hi = p.s;
      for (let t = 0; t < 7; t++) {
        const m = (lo + hi) / 2;
        if (probe(m).key === run.key) lo = m;
        else hi = m;
      }
      run.s1 = (lo + hi) / 2;
      runs.push(run);
    }
    run = { s0: run ? run.s1 : s0, s1, pu: p.pu, nu: p.nu, key: p.key };
    last = p;
  }
  run.s1 = s1;
  runs.push(run);
  return runs;
}

/**
 * How high a wall rises over a side run: to the higher deck where a side is outdoors or the decks
 * differ, and between two spaces at least to a flat ceiling above it, so the ceiling meets the wall.
 */
function runTop(w, { pu, nu }) {
  if (w.kind === 'partial' || (!pu && !nu)) return w.height;
  if (!pu || !nu || Math.abs(pu.deck - nu.deck) > 1e-3) return Math.max(w.height, pu?.deck ?? 0, nu?.deck ?? 0);
  const flat = (space) => (space.ceiling === 'open' ? 0 : space.height);
  return pu === nu ? w.height : Math.max(w.height, flat(pu), flat(nu));
}

/**
 * Material bands up a wall face that looks into `space` (null outdoors): `base` up to the wall top
 * (or a flat ceiling above it), then the dark plenum or open structure up to the space's deck, then
 * facade above a lower roof. Each band is [top, material].
 */
function faceBands(ctx, space, base, H) {
  const M = ctx.mats;
  if (!space) return [[H, base], [Infinity, M.facade]];
  // Paint runs 5 cm past a flat ceiling into the plenum, so no dark sliver shows along the ceiling edge.
  const paintTop = Math.min(space.deck, Math.max(H, space.ceiling === 'open' ? 0 : space.height + 0.05));
  return [[paintTop, base], [space.deck, M.deck], [Infinity, M.facade]];
}

const bandAt = (bands, y) => bands.find(([top]) => y < top)[1];

/** Height layers [y0, y1, pu, nu] between y0 and y1 over which both faces keep one material. */
function wallLayers(ctx, run, base, H, y0, y1) {
  const pu = faceBands(ctx, run.pu, base.pu, H), nu = faceBands(ctx, run.nu, base.nu, H);
  const cuts = [y0, y1, ...pu.map((b) => b[0]), ...nu.map((b) => b[0])].filter((y) => y >= y0 && y <= y1).sort((a, b) => a - b);
  const layers = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const ya = cuts[k], yb = cuts[k + 1];
    if (yb - ya < 1e-4) continue;
    const m = (ya + yb) / 2;
    const prev = layers[layers.length - 1];
    const layer = [ya, yb, bandAt(pu, m), bandAt(nu, m)];
    if (prev && prev[2] === layer[2] && prev[3] === layer[3]) prev[1] = yb;
    else layers.push(layer);
  }
  return layers;
}

const sameLayers = (a, b) => a.length === b.length && a.every((l, k) => l.every((v, i) => v === b[k][i]));

/**
 * A wall box from s0 to s1 (half thickness u) and y0 to y1. Each face takes the material its side
 * calls for at each height (see faceBands); f gives the base side materials and the top and bottom.
 * caps.a and caps.b, when set, draw the end face at s0 or s1 from that height up.
 */
function wallBox(ctx, info, get, f, s0, s1, u, y0, y1, caps = {}) {
  const { F, w } = info;
  const pieces = [];
  for (const run of info.sides) {
    const a = Math.max(s0, run.s0), b = Math.min(s1, run.s1);
    if (b - a < 1e-6) continue;
    const layers = wallLayers(ctx, run, f, w.height, y0, y1);
    const prev = pieces[pieces.length - 1];
    if (prev && sameLayers(prev.layers, layers)) prev.s1 = b;
    else pieces.push({ s0: a, s1: b, layers });
  }
  for (const p of pieces) {
    p.layers.forEach(([ya, yb, pu, nu], k) => box(F, {
      pu: get(pu), nu: get(nu),
      top: f.top && k === p.layers.length - 1 ? get(f.top) : null,
      bottom: f.bottom && k === 0 ? get(f.bottom) : null,
    }, p.s0, p.s1, -u, u, ya, yb));
  }
  if (caps.a != null) endCap(ctx, info, get, 'a', s0, u, Math.max(y0, caps.a), y1);
  if (caps.b != null) endCap(ctx, info, get, 'b', s1, u, Math.max(y0, caps.b), y1);
}

/** End face at s looking away from the wall (end 'a' toward -d), in the materials of the space it faces. */
function endCap(ctx, info, get, end, s, u, y0, y1) {
  if (y1 - y0 < 1e-4) return;
  const { F, w } = info;
  const dir = end === 'a' ? -1 : 1;
  const off = w.thickness / 2 + 0.25, along = s + dir * 0.3;
  const at = (sign) => spaceAt(ctx, { x: F.o.x + F.d.x * along + F.n.x * off * sign, y: F.o.y + F.d.y * along + F.n.y * off * sign });
  const space = at(1) || at(-1);
  const bands = faceBands(ctx, space, space ? ctx.mats.paint : ctx.mats.facade, w.height);
  let lo = y0;
  for (const [top, mat] of bands) {
    const hi = Math.min(top, y1);
    if (hi - lo > 1e-4) box(F, { [end === 'a' ? 's0' : 's1']: get(mat) }, end === 'a' ? s : s - 1e-3, end === 'a' ? s + 1e-3 : s, -u, u, lo, hi);
    lo = Math.max(lo, hi);
    if (lo >= y1) break;
  }
}

/** +1 or -1 when only that side of the wall is inside the building, 0 when both or neither are. */
function interiorSide(ctx, { w, L, F }) {
  const off = w.thickness / 2 + 0.25;
  let score = 0;
  for (const t of [0.15, 0.5, 0.85]) {
    const p = pointOnWall(w, L * t);
    score += ctx.mask.insideAt(p.x + F.n.x * off, p.y + F.n.y * off) - ctx.mask.insideAt(p.x - F.n.x * off, p.y - F.n.y * off);
  }
  return Math.sign(score);
}

function paintedWall(ctx, info) {
  const { w, L, ext, spans, inner } = info;
  const M = ctx.mats;
  const ht = w.thickness / 2, H = w.height;
  const outer = w.kind === 'exterior' ? -inner : 0;
  const f = { pu: outer === 1 ? M.facade : M.paint, nu: outer === -1 ? M.facade : M.paint, top: M.cut };
  const get = (m) => ctx.main.get(m);
  // No end faces at openings: door casings cover their jambs and windows draw their own reveals.
  let cursor = -ext.a;
  spans.forEach((sp, i) => {
    wallBox(ctx, info, get, f, cursor, sp.start, ht, 0, H, { a: i === 0 ? cover(ctx, info, 'a') : null });
    if (sp.o.type === 'window') windowOpening(ctx, info, sp, f, get);
    else doorOpening(ctx, info, sp, f, get);
    cursor = sp.end;
  });
  wallBox(ctx, info, get, f, cursor, L + ext.b, ht, 0, H, { a: spans.length ? null : cover(ctx, info, 'a'), b: cover(ctx, info, 'b') });
  floorTrim(ctx, info, floorRuns(info, true));
  ceilingShade(ctx, info);
}

/** Height range an opening leaves open in a painted wall, a door's casing included. */
function openRange(o, H) {
  if (o.type !== 'window') return [0, Math.min(H, clamp(o.height, 0.6, H) + CASING.out)];
  const sill = clamp(o.sill, 0, H - 0.3);
  return [sill, Math.min(sill + o.height, H - 0.05)];
}

/**
 * Stretches of a wall that meet the floor (window sills count when keepWindows is set). Ends at
 * door openings are flagged so the soft floor shading fades out there.
 */
function floorRuns({ L, ext, spans }, keepWindows) {
  const runs = [];
  let start = -ext.a, fade = false;
  for (const sp of spans) {
    if (keepWindows && sp.o.type === 'window' && sp.o.sill > 0.002) continue;
    runs.push({ s0: start, s1: sp.start, fade0: fade, fade1: true });
    start = sp.end;
    fade = true;
  }
  runs.push({ s0: start, s1: L + ext.b, fade0: fade, fade1: false });
  return runs.filter((r) => r.s1 - r.s0 > 1e-3);
}

/** Rubber base and soft contact shading on the floor along the interior faces of a wall. */
function floorTrim(ctx, info, runs, { base = true, width = 0.3 } = {}) {
  const { w, F, inner, ext, ends, L } = info;
  const b = ctx.main.get(ctx.mats.base, false);
  const ht = w.thickness / 2;
  // Wrap the base around convex corners only; on the concave side, or at a tee, it would poke through the neighbor.
  const wrap = (end, side) => (ends[end].corner && ends[end].side !== side ? BASE.out : 0);
  for (const side of [1, -1]) {
    if (inner !== 0 && side !== inner) continue;
    for (const r of runs) {
      const s0 = r.s0 - (r.s0 <= -ext.a + 1e-6 ? wrap('a', side) : 0);
      const s1 = r.s1 + (r.s1 >= L + ext.b - 1e-6 ? wrap('b', side) : 0);
      if (base) {
        // Rubber cove base with an eased top edge; the face against the wall and the floor are hidden.
        const faces = ['top', 's0', 's1', side > 0 ? 'pu' : 'nu'];
        if (side > 0) rbox(ctx, F, b, s0, s1, ht, ht + BASE.out, 0, BASE.h, 0.0025, { faces });
        else rbox(ctx, F, b, s0, s1, -ht - BASE.out, -ht, 0, BASE.h, 0.0025, { faces });
      }
      floorShade(ctx, F, side, ht + (base ? BASE.out : 0), s0, s1, r.fade0, r.fade1, width);
    }
  }
}

function floorShade(ctx, F, side, face, s0, s1, fade0, fade1, width) {
  const b = ctx.fx.get(ctx.mats.get('aoFloor'), false, false);
  const P = (s, u) => [F.o.x + F.d.x * s + F.n.x * u, 0.0025, F.o.y + F.d.y * s + F.n.y * u];
  const near = side * face, far = side * (face + width);
  const r = Math.min(0.3, (s1 - s0) / 2);
  const a = fade0 ? s0 + r : s0, c = fade1 ? s1 - r : s1;
  const strip = (p, q, ua, ub) => quad(b, P(p, near), P(q, near), P(q, far), P(p, far), UP, ua, 1, ub, 0);
  if (c > a) strip(a, c, 1, 1);
  if (fade0) strip(s0, a, 0, 1);
  if (fade1) strip(c, s1, 1, 0);
}

/** Soft shading where a wall meets a flat ceiling, on the wall face and on the ceiling. */
function ceilingShade(ctx, info) {
  const { w, L, F, ext, spans, inner } = info;
  // A tall, soft band on the wall reads like the falloff of light from fixtures set back from it.
  const ht = w.thickness / 2, band = 0.7, cband = 0.35;
  const mid = pointOnWall(w, L / 2);
  for (const side of [1, -1]) {
    if (inner !== 0 && side !== inner) continue;
    const off = side * (ht + 0.4);
    const space = spaceAt(ctx, { x: mid.x + F.n.x * off, y: mid.y + F.n.y * off });
    if (!space || space.ceiling === 'open' || space.height > w.height + 0.01) continue;
    const h = space.ceilY;
    const wallB = ctx.ceil.get(ctx.mats.get('aoWall'), false, false);
    const ceilB = ctx.ceil.get(ctx.mats.get('aoCeiling'), false, false);
    const P = (s, u, y) => [F.o.x + F.d.x * s + F.n.x * u, y, F.o.y + F.d.y * s + F.n.y * u];
    const n = [F.n.x * side, 0, F.n.y * side];
    const u0 = side * (ht + 0.0015), u1 = side * ht, u2 = side * (ht + cband), yc = h - 0.0015;
    let cursor = -ext.a;
    const run = (s0, s1) => {
      if (s1 - s0 < 0.01) return;
      quad(wallB, P(s0, u0, h - band), P(s1, u0, h - band), P(s1, u0, h), P(s0, u0, h), n, 1, 0, 1, 1);
      quad(ceilB, P(s0, u1, yc), P(s1, u1, yc), P(s1, u2, yc), P(s0, u2, yc), DOWN, 1, 1, 1, 0);
    };
    for (const sp of spans) {
      const top = sp.o.type === 'window' ? sp.o.sill + sp.o.height : sp.o.height;
      if (top < h - band) continue;
      run(cursor, sp.start);
      cursor = sp.end;
    }
    run(cursor, L + ext.b);
  }
}

/** Overlap of a head or sill box into the wall beside it (none toward a neighboring opening). */
const joins = (sp) => [sp.before ? 0 : JOIN, sp.after ? 0 : JOIN];

function doorOpening(ctx, info, sp, f, get) {
  const { w } = info;
  const { o, start, end } = sp;
  const ht = w.thickness / 2, H = w.height;
  const oh = clamp(o.height, 0.6, H);
  const [j0, j1] = joins(sp);
  if (H - oh > 0.005) wallBox(ctx, info, get, { ...f, bottom: ctx.mats.paint }, start - j0, end + j1, ht, oh, H);
  // Doors in exterior walls are aluminum storefront entries with glass leaves.
  const storefront = w.kind === 'exterior';
  casing(ctx, info, start, end, oh, storefront ? ctx.mats.alu : ctx.mats.frame);
  // Storefront glass lets daylight in too, a little less than a window (rails and stiles).
  if (storefront && info.inner !== 0) {
    ctx.windows.push({ info, s0: start + CASING.in, s1: end - CASING.in, y0: 0.2, y1: oh - CASING.in, u: 0, side: info.inner, weight: 0.7 });
  }
  const leaf = storefront ? 'storefront' : 'wood';
  const s0 = start + CASING.in, s1 = end - CASING.in, top = oh - CASING.in;
  if (o.type === 'door') {
    const hingeEnd = o.hinge === 'end';
    swingLeaf(ctx, info, hingeEnd ? s1 : s0, hingeEnd ? -1 : 1, o.side, s1 - s0 - 0.006, top, leaf);
  } else if (o.type === 'double-door') {
    const half = (s1 - s0) / 2 - 0.004;
    swingLeaf(ctx, info, s0, 1, o.side, half, top, leaf);
    swingLeaf(ctx, info, s1, -1, o.side, half, top, leaf);
  } else if (o.type === 'sliding-door') {
    slidingPanels(ctx, info, sp, s0, s1, top);
  }
}

/** Door frame that wraps the jambs and shows as a slim casing on both wall faces. */
function casing(ctx, { w, F }, start, end, oh, material) {
  const b = ctx.main.get(material, !ctx.low);
  const u = w.thickness / 2 + CASING.proud;
  const head = Math.min(w.height, oh + CASING.out);
  const faces = ['s0', 's1', 'pu', 'nu', 'top'];
  rbox(ctx, F, b, start - CASING.out, start + CASING.in, -u, u, 0, head, 0.004, { faces });
  rbox(ctx, F, b, end - CASING.in, end + CASING.out, -u, u, 0, head, 0.004, { faces });
  if (head > oh - CASING.in + 0.001) rbox(ctx, F, b, start + CASING.in, end - CASING.in, -u, u, oh - CASING.in, head, 0.004);
}

/**
 * One swinging leaf hinged at pivotS, closing toward dirSign along the wall, open 80 degrees toward
 * wallNormal * side. kind: 'wood', 'glass' (frameless with rails) or 'storefront' (aluminum stiles).
 */
function swingLeaf(ctx, { w, F }, pivotS, dirSign, side, width, top, kind) {
  const glass = kind !== 'wood';
  if (width < 0.2) return;
  const c = { x: F.d.x * dirSign, y: F.d.y * dirSign };
  const o = { x: c.x * OPEN_COS + F.n.x * side * OPEN_SIN, y: c.y * OPEN_COS + F.n.y * side * OPEN_SIN };
  const T = glass ? 0.04 : LEAF_T;
  const u = side * Math.max(0, w.thickness / 2 - T / 2);
  const p = { x: F.o.x + F.d.x * pivotS + F.n.x * u, y: F.o.y + F.d.y * pivotS + F.n.y * u };
  const LF = frameOf(p, o);
  const y0 = 0.012, y1 = top - 0.004;
  if (glass) glassLeaf(ctx, LF, width, y0, y1, kind === 'storefront');
  else woodLeaf(ctx, LF, width, y0, y1);
  const end = { x: p.x + o.x * width, y: p.y + o.y * width };
  ctx.colliders.push({ a: { x: p.x + o.x * 0.05, y: p.y + o.y * 0.05 }, b: end, r: T / 2 });
}

function woodLeaf(ctx, LF, width, y0, y1) {
  // Veneer grain runs up the leaf, and its eased edges catch the light.
  rbox(ctx, LF, ctx.main.get(ctx.mats.leaf), 0, width, -LEAF_T / 2, LEAF_T / 2, y0, y1, 0.003, { grain: true });
  lever(ctx, LF, width - 0.065, Math.min(1.0, y1 - 0.2), LEAF_T / 2);
}

/** Lever handle pair on both faces of a leaf, pointing back toward the hinge. */
function lever(ctx, LF, s, y, face) {
  const b = ctx.main.get(ctx.mats.handle, false);
  for (const sign of [1, -1]) {
    const u = (a, z) => (sign > 0 ? [face + a, face + z] : [-face - z, -face - a]);
    box(LF, noBottom(b), s - 0.022, s + 0.022, ...u(0, 0.01), y - 0.035, y + 0.035);
    box(LF, all(b), s - 0.008, s + 0.008, ...u(0.01, 0.05), y - 0.008, y + 0.008);
    box(LF, all(b), s - 0.125, s + 0.01, ...u(0.045, 0.063), y - 0.01, y + 0.01);
  }
}

function glassLeaf(ctx, LF, width, y0, y1, stiles) {
  const alu = ctx.main.get(ctx.mats.alu, !ctx.low);
  const st = stiles ? 0.07 : 0, bottom = stiles ? 0.18 : 0.09, face = stiles ? 0.02 : 0.006;
  // Storefront leaves are exterior glazing; frameless interior leaves match the partitions.
  box(LF, faces2(ctx.main.get(stiles ? ctx.mats.glass : ctx.mats.partition, false)), st, width - st, -0.006, 0.006, y0 + bottom, y1 - 0.06);
  rbox(ctx, LF, alu, 0, width, -0.02, 0.02, y0, y0 + bottom, 0.003);
  rbox(ctx, LF, alu, 0, width, -0.02, 0.02, y1 - 0.06, y1, 0.003);
  if (stiles) {
    rbox(ctx, LF, alu, 0, st, -0.02, 0.02, y0 + bottom, y1 - 0.06, 0.003, { faces: ['s0', 's1', 'pu', 'nu'] });
    rbox(ctx, LF, alu, width - st, width, -0.02, 0.02, y0 + bottom, y1 - 0.06, 0.003, { faces: ['s0', 's1', 'pu', 'nu'] });
  }
  pullBar(ctx, LF, width - (stiles ? 0.035 : 0.09), face, Math.min(1.45, y1 - 0.2));
}

/** Vertical pull bar on the given faces (+1, -1) of a glass panel. */
function pullBar(ctx, LF, s, face, yTop, signs = [1, -1]) {
  const b = ctx.main.get(ctx.mats.handle, false);
  const y0 = Math.max(0.5, yTop - 0.8);
  for (const sign of signs) {
    const u = (a, z) => (sign > 0 ? [face + a, face + z] : [-face - z, -face - a]);
    box(LF, all(b), s - 0.0125, s + 0.0125, ...u(0.05, 0.075), y0, yTop);
    box(LF, all(b), s - 0.008, s + 0.008, ...u(0, 0.05), y0 + 0.1, y0 + 0.12);
    box(LF, all(b), s - 0.008, s + 0.008, ...u(0, 0.05), yTop - 0.12, yTop - 0.1);
  }
}

/**
 * Two glass panels in an aluminum frame; the one away from the hinge side slides open behind the
 * fixed one. The glass is solid to walk into; only the open part of the doorway is passable.
 */
function slidingPanels(ctx, info, sp, s0, s1, top) {
  const { F, w } = info;
  const { o } = sp;
  const alu = ctx.main.get(ctx.mats.alu, !ctx.low);
  const trackTop = top, trackBottom = top - 0.05;
  rbox(ctx, F, alu, s0, s1, -0.05, 0.05, trackBottom, trackTop, 0.004);
  box(F, noBottom(alu), s0, s1, -0.05, 0.05, 0, 0.008);
  const clear = s1 - s0;
  const pw = clear / 2 + 0.03;
  // Open to 2 cm short of the fixed panel, so both leading stiles show.
  const slide = Math.max(0, pw - 0.08);
  const fixedAtStart = o.hinge !== 'end';
  const fixed = fixedAtStart ? [s0, s0 + pw] : [s1 - pw, s1];
  const moving = fixedAtStart ? [s1 - pw - slide, s1 - slide] : [s0 + slide, s0 + pw + slide];
  const side = o.side;
  const r = 0.04;
  const glass = fixedAtStart ? [sp.start, s1 - slide - r] : [s0 + slide + r, sp.end];
  if (glass[1] > glass[0]) ctx.colliders.push({ a: pointOnWall(w, glass[0]), b: pointOnWall(w, glass[1]), r });
  const pane = w.kind === 'exterior' ? ctx.mats.glass : ctx.mats.partition;
  glassPanel(ctx, F, fixed[0], fixed[1], -side * 0.022, 0.008, trackBottom, pane);
  glassPanel(ctx, F, moving[0], moving[1], side * 0.022, 0.008, trackBottom, pane);
  const lead = fixedAtStart ? moving[1] - 0.06 : moving[0] + 0.06;
  const u = side * 0.022;
  const PF = { o: { x: F.o.x + F.n.x * u, y: F.o.y + F.n.y * u }, d: F.d, n: F.n };
  pullBar(ctx, PF, lead, 0.0175, Math.min(1.45, trackBottom - 0.2), [side]);
}

/** Framed glass panel centered at uc: stiles, rails and a glass light. */
function glassPanel(ctx, F, s0, s1, uc, y0, y1, glass = ctx.mats.partition) {
  const alu = ctx.main.get(ctx.mats.alu, !ctx.low);
  const g = ctx.main.get(glass, false);
  const t = 0.0175, st = 0.045, r = 0.003;
  rbox(ctx, F, alu, s0, s0 + st, uc - t, uc + t, y0, y1, r);
  rbox(ctx, F, alu, s1 - st, s1, uc - t, uc + t, y0, y1, r);
  rbox(ctx, F, alu, s0 + st, s1 - st, uc - t, uc + t, y0, y0 + 0.09, r, { faces: ['pu', 'nu', 'top', 'bottom'] });
  rbox(ctx, F, alu, s0 + st, s1 - st, uc - t, uc + t, y1 - 0.06, y1, r, { faces: ['pu', 'nu', 'top', 'bottom'] });
  box(F, faces2(g), s0 + st, s1 - st, uc - 0.005, uc + 0.005, y0 + 0.09, y1 - 0.06);
}

function windowOpening(ctx, info, sp, f, get) {
  const { w, F, inner } = info;
  const { o, start, end } = sp;
  const { main: B, mats: M } = ctx;
  const ht = w.thickness / 2, H = w.height;
  const [sill, top] = openRange(o, H);
  const [j0, j1] = joins(sp);
  if (sill > 0.002) wallBox(ctx, info, get, { ...f, top: M.paint }, start - j0, end + j1, ht, 0, sill);
  wallBox(ctx, info, get, { ...f, bottom: M.paint }, start - j0, end + j1, ht, top, H);
  // Reveals where the wall beside the window is solid; beside another opening only where that one is not open.
  const paint = B.get(M.paint);
  for (const [nb, s, face] of [[sp.before, start, 's1'], [sp.after, end, 's0']]) {
    const [n0, n1] = nb ? openRange(nb.o, H) : [0, 0];
    for (const [ya, yb] of [[sill, Math.min(top, n0)], [Math.max(sill, n1), top]]) {
      if (yb - ya > 1e-3) box(F, { [face]: paint }, face === 's1' ? s - JOIN : s, face === 's1' ? s : s + JOIN, -ht, ht, ya, yb);
    }
  }

  const fd = Math.min(0.1, w.thickness * 0.6), fw = 0.05;
  const uc = inner !== 0 ? -inner * Math.max(0, ht - fd / 2 - 0.03) : 0;
  const u0 = uc - fd / 2, u1 = uc + fd / 2;
  const fr = B.get(M.alu, !ctx.low);
  // Extruded aluminum frame and mullions with eased edges; the glass sits in the middle of the frame.
  const r = 0.003;
  rbox(ctx, F, fr, start, start + fw, u0, u1, sill, top, r, { faces: ['s1', 'pu', 'nu'] });
  rbox(ctx, F, fr, end - fw, end, u0, u1, sill, top, r, { faces: ['s0', 'pu', 'nu'] });
  rbox(ctx, F, fr, start + fw, end - fw, u0, u1, sill, sill + fw, r, { faces: ['top', 'pu', 'nu'] });
  rbox(ctx, F, fr, start + fw, end - fw, u0, u1, top - fw, top, r, { faces: ['bottom', 'pu', 'nu'] });
  const bays = clamp(Math.round((end - start) / MULLION_STEP), 1, 200);
  const bay = (end - start - 2 * fw) / bays;
  for (let k = 1; k < bays; k++) {
    const s = start + fw + k * bay;
    rbox(ctx, F, fr, s - 0.025, s + 0.025, u0 + 0.01, u1 - 0.01, sill + fw, top - fw, r, { faces: ['s0', 's1', 'pu', 'nu'] });
  }
  box(F, faces2(B.get(inner !== 0 ? M.glass : M.partition, false)), start + fw, end - fw, uc - 0.005, uc + 0.005, sill + fw, top - fw);
  // Glazing between inside and outdoors lets daylight in.
  if (inner !== 0) ctx.windows.push({ info, s0: start + fw, s1: end - fw, y0: sill + fw, y1: top - fw, u: uc, side: inner, weight: 1 });

  if (sill < 0.05) return;
  const ledge = B.get(M.sill, !ctx.low);
  for (const side of inner !== 0 ? [inner] : [1, -1]) {
    if (side > 0) rbox(ctx, F, ledge, start - 0.04, end + 0.04, uc, ht + 0.035, sill, sill + 0.025, 0.004, { faces: ['s0', 's1', 'pu', 'top', 'bottom'] });
    else rbox(ctx, F, ledge, start - 0.04, end + 0.04, -ht - 0.035, uc, sill, sill + 0.025, 0.004, { faces: ['s0', 's1', 'nu', 'top', 'bottom'] });
  }
}

/** Glass partition: aluminum head and base, mullions about every 1.5 m, a frosted privacy band, glass doors. */
function glassWall(ctx, info) {
  const { w, L, F, ext, spans } = info;
  const { main: B, mats: M } = ctx;
  const ht = w.thickness / 2, H = w.height;
  const head = 0.05, foot = 0.07;
  const alu = B.get(M.alu);
  const glass = faces2(B.get(M.partition, false));
  const frost = faces2(B.get(M.frosted, false));
  box(F, endFaces(ctx, info, { ...noBottom(alu), top: B.get(M.cut) }, true, true, H), -ext.a, L + ext.b, -ht, ht, H - head, H);

  const post = (s) => rbox(ctx, F, alu, s - 0.02, s + 0.02, -ht, ht, foot, H - head, 0.003, { faces: ['s0', 's1', 'pu', 'nu'] });
  const pane = (s0, s1, y0) => {
    box(F, glass, s0, s1, -0.006, 0.006, y0, H - head);
    if (H - head > 1.25 && y0 < 1.05) box(F, frost, s0, s1, -0.0075, 0.0075, 1.05, 1.2);
  };
  const solid = (s0, s1, v0, v1, postA, postB) => {
    if (s1 - s0 < 1e-3) return;
    box(F, endFaces(ctx, info, noBottom(alu), postA, postB, foot), s0, s1, -ht, ht, 0, foot);
    pane(s0, s1, foot);
    const bays = clamp(Math.round((v1 - v0) / MULLION_STEP), 1, 2000);
    for (let k = postA ? 0 : 1; k <= (postB ? bays : bays - 1); k++) post(clamp(v0 + ((v1 - v0) * k) / bays, v0 + 0.02, v1 - 0.02));
  };
  let cursor = -ext.a, visible = ext.a;
  spans.forEach((sp, i) => {
    solid(cursor, sp.start, visible, sp.start, i === 0, false);
    glassDoor(ctx, info, sp, alu, pane);
    cursor = visible = sp.end;
  });
  solid(cursor, L + ext.b, visible, L - ext.b, spans.length === 0, true);
  floorTrim(ctx, info, floorRuns(info, false), { base: false, width: 0.18 });
}

function glassDoor(ctx, info, sp, alu, pane) {
  const { w, F } = info;
  const { o, start, end } = sp;
  const ht = w.thickness / 2;
  const oh = Math.min(o.height, w.height - 0.12);
  const jamb = 0.045;
  rbox(ctx, F, alu, start, start + jamb, -ht, ht, 0, oh, 0.003, { faces: ['s0', 's1', 'pu', 'nu', 'top'] });
  rbox(ctx, F, alu, end - jamb, end, -ht, ht, 0, oh, 0.003, { faces: ['s0', 's1', 'pu', 'nu', 'top'] });
  rbox(ctx, F, alu, start, end, -ht, ht, oh, oh + 0.05, 0.003);
  pane(start + jamb, end - jamb, oh + 0.05);
  const s0 = start + jamb, s1 = end - jamb;
  if (o.type === 'door') {
    const hingeEnd = o.hinge === 'end';
    swingLeaf(ctx, info, hingeEnd ? s1 : s0, hingeEnd ? -1 : 1, o.side, s1 - s0 - 0.006, oh, 'glass');
  } else if (o.type === 'double-door') {
    const half = (s1 - s0) / 2 - 0.004;
    swingLeaf(ctx, info, s0, 1, o.side, half, oh, 'glass');
    swingLeaf(ctx, info, s1, -1, o.side, half, oh, 'glass');
  } else if (o.type === 'sliding-door') {
    slidingPanels(ctx, info, sp, s0, s1, oh);
  }
}

/** Half-height wall with a wood cap; door openings become plain gaps. */
function partialWall(ctx, info) {
  const { w, L, F, ext, spans } = info;
  const { main: B, mats: M } = ctx;
  const ht = w.thickness / 2, H = w.height;
  const paint = B.get(M.paint);
  const cap = B.get(M.cap);
  const piece = (s0, s1, first, last) => {
    if (s1 - s0 < 1e-3) return;
    box(F, endFaces(ctx, info, { pu: paint, nu: paint, s0: paint, s1: paint }, first, last, H), s0, s1, -ht, ht, 0, H);
    // Wood cap with rounded edges; ends buried in a neighbor stay square.
    const ends = endFaces(ctx, info, all(cap), first, last, H + 0.03);
    const faces = Object.keys(ends).filter((k) => ends[k]);
    rbox(ctx, F, cap, s0, s1, -ht - 0.015, ht + 0.015, H, H + 0.03, 0.006, { faces });
  };
  let cursor = -ext.a;
  spans.forEach((sp, i) => {
    piece(cursor, sp.start, i === 0, false);
    cursor = sp.end;
  });
  piece(cursor, L + ext.b, spans.length === 0, true);
  floorTrim(ctx, info, floorRuns(info, false));
}

/**
 * Above its own height a wall rises to the deck wherever one side is outdoors or the decks on its two
 * sides differ (see runTop), so nothing above a ceiling looks outdoors and a lower wing keeps its
 * lower roof line. Its faces follow faceBands: paint up to a raised flat ceiling, dark in a plenum or
 * open structure, facade above a lower roof.
 */
function upperWall(ctx, info) {
  const { w, sides, tops } = info;
  const M = ctx.mats;
  // Paint and facade take shadows like the wall below them; the dark plenum faces need not.
  // Every face takes shadows: under an open ceiling the sun would otherwise light them through the roof.
  const get = (m) => ctx.ceil.get(m, m !== M.cut, true);
  const f = { pu: M.paint, nu: M.paint, top: M.cut };
  // Recessed a hair behind the wall faces: it hides the seam without ever peeking out below a ceiling.
  const u = w.thickness / 2 - 0.0008;
  const last = sides.length - 1;
  for (let k = 0; k <= last;) {
    let m = k;
    while (m < last && Math.abs(tops[m + 1] - tops[k]) < 1e-4) m++;
    if (tops[k] > w.height + 0.01) {
      const caps = { a: k === 0 ? cover(ctx, info, 'a') : tops[k - 1], b: m === last ? cover(ctx, info, 'b') : tops[m + 1] };
      wallBox(ctx, info, get, f, sides[k].s0, sides[m].s1, u, w.height - JOIN, tops[k], caps);
    }
    k = m + 1;
  }
}

/**
 * Plan-space colliders for the walk view. Wall runs are capsules of the wall's half thickness; at a
 * doorway a run stops short by that radius and a flat jamb closes it, so the clear width is the
 * opening width. Windows stay solid; door leaves and sliding glass add their own colliders.
 */
function addColliders(ctx, { w, L, F, spans }) {
  const r = w.thickness / 2;
  const at = (s, u = 0) => ({ x: F.o.x + F.d.x * s + F.n.x * u, y: F.o.y + F.d.y * s + F.n.y * u });
  const run = (s0, s1, jamb0, jamb1) => {
    if (s1 - s0 < 0.01) return;
    const a = s0 + (jamb0 ? r : 0), b = s1 - (jamb1 ? r : 0);
    if (b - a > 1e-3) ctx.colliders.push({ a: at(a), b: at(b), r });
    else for (const u of [-r, r]) ctx.colliders.push({ a: at(s0, u), b: at(s1, u), r: 0 });
    if (jamb0) ctx.colliders.push({ a: at(s0, -r), b: at(s0, r), r: 0 });
    if (jamb1) ctx.colliders.push({ a: at(s1, -r), b: at(s1, r), r: 0 });
  };
  let cursor = 0, open = false;
  for (const sp of spans) {
    if (!OPENING_TYPES[sp.o.type].passable) continue;
    run(cursor, sp.start, open, true);
    cursor = sp.end;
    open = true;
  }
  run(cursor, L, open, false);
}

// ---- Floors and slab --------------------------------------------------------------

/** Horizontal polygon at height y, facing up or down, with uv in meters / uvMeters. */
function horizontalPolygon(b, contour, faces, y, up, uvMeters) {
  const i0 = b.count;
  const ny = up ? 1 : -1;
  for (const p of contour) vert(b, p.x, y, p.y, 0, ny, 0, p.x / uvMeters, -p.y / uvMeters);
  for (const [i, j, k] of faces) {
    const a = contour[i], p = contour[j], q = contour[k];
    const area = (p.x - a.x) * (q.y - a.y) - (p.y - a.y) * (q.x - a.x);
    // On the y-down plan, a negative signed area faces world +Y.
    if ((area < 0) === up) tri(b, i0 + i, i0 + j, i0 + k);
    else tri(b, i0 + i, i0 + k, i0 + j);
  }
}

function buildFloors(ctx) {
  ctx.rooms.forEach((rm, i) => {
    const mat = ctx.kit.floorMaterial(rm.floor);
    ctx.floors.at(rm.centroid.x, rm.centroid.y);
    horizontalPolygon(ctx.floors.get(mat, false, true), rm.contour, rm.faces, (i % 4) * 0.0005, true, ctx.kit.floorMeters(rm.floor));
  });
}

/**
 * Cells under the slab: the building mask with gaps in its walls up to SLAB_GAP wide closed, so the
 * outdoor ground never runs in through them. Wider notches, like the yard of an L, stay open.
 */
function slabCells(ctx) {
  const { mask } = ctx;
  const { c, nx } = mask;
  const steps = Math.ceil(SLAB_GAP / 2 / c);
  // Work on the mask padded past the closing's reach, so its edge never clips the closing.
  const m = steps + 1, grid = { nx: nx + 2 * m, ny: mask.ny + 2 * m };
  const at = (i, j) => (j + m) * grid.nx + i + m;
  const src = new Uint8Array(grid.nx * grid.ny);
  mask.inside.forEach((v, k) => { src[at(k % nx, Math.floor(k / nx))] = v; });
  // Mark every cell that a band of width t along a-b touches.
  const band = (a, b, t) => {
    const L = Math.hypot(b.x - a.x, b.y - a.y), d = L ? { x: (b.x - a.x) / L, y: (b.y - a.y) / L } : { x: 1, y: 0 };
    const ns = Math.ceil(L / (c / 2)), nu = Math.ceil(t / (c / 2));
    for (let i = 0; i <= ns; i++) {
      for (let j = 0; j <= nu; j++) {
        const s = ns ? (L * i) / ns : 0, u = t * (j / nu - 0.5);
        const x = a.x + d.x * s - d.y * u, y = a.y + d.y * s + d.x * u;
        src[at(Math.floor((x - mask.minX) / c), Math.floor((y - mask.minY) / c))] = 1;
      }
    }
  };
  // The walls bound the closing too, so a gap at a corner closes like one mid-wall.
  const walls = ctx.walls.filter((info) => info.w.kind !== 'partial');
  for (const { w, L, F, ends, ext } of walls) {
    const P = (s) => ({ x: F.o.x + F.d.x * s, y: F.o.y + F.d.y * s });
    band(P(-ext.a), P(L + ext.b), w.thickness);
    // A free end bridges to the nearest wall within SLAB_GAP, which closes a gap's throat at any angle.
    for (const end of ['a', 'b']) {
      const e = ends[end], p = w[end];
      if (e.corner || e.tee || e.ext) continue;
      let near = null;
      for (const o of walls) {
        const q = o.w === w ? null : projectToSegment(p, o.w.a, o.w.b);
        if (q && (!near || q.dist < near.dist)) near = q;
      }
      if (near && near.dist > JOIN && near.dist <= SLAB_GAP) band(p, near.point, w.thickness);
    }
  }
  const closed = spreadCells(grid, spreadCells(grid, src, steps, 1), steps, 0);
  // The closed area's outer ring straddles the walls' outside faces; their footprints cover the part inside.
  const core = spreadCells(grid, closed, 1, 0);
  return mask.inside.map((v, k) => v | core[at(k % nx, Math.floor(k / nx))]);
}

/**
 * Polished concrete slab under the building: the rooms and the area the walls enclose, plus every
 * wall's footprint so door thresholds are covered. Set slightly low and depth-offset so rooms never
 * z-fight with it. A plan without walls or rooms gets a slab under its items.
 */
function buildSlab(ctx, parent) {
  const mat = ctx.mats.get('slab');
  const m = ctx.kit.floorMeters('polished-concrete');
  const buckets = createBuckets();
  const b = buckets.get(mat, false, true);
  const square = [[0, 1, 2], [0, 2, 3]];
  const rect = (r) => {
    const corners = [{ x: r.minX, y: r.minY }, { x: r.maxX, y: r.minY }, { x: r.maxX, y: r.maxY }, { x: r.minX, y: r.maxY }];
    horizontalPolygon(b, corners, square, SLAB_Y, true, m);
  };
  for (const r of maskRects(ctx.mask, slabCells(ctx))) rect(r);
  for (const { w, L, F, ext } of ctx.walls) {
    const ht = w.thickness / 2;
    const P = (s, u) => ({ x: F.o.x + F.d.x * s + F.n.x * u, y: F.o.y + F.d.y * s + F.n.y * u });
    horizontalPolygon(b, [P(-ext.a, -ht), P(L + ext.b, -ht), P(L + ext.b, ht), P(-ext.a, ht)], square, SLAB_Y, true, m);
  }
  if (!b.idx.n) rect(ctx.bounds);
  const [mesh] = flush(buckets, parent, ctx.owned);
  mesh.name = 'slab';
  return mesh;
}

// ---- Ceilings -------------------------------------------------------------------

function buildCeilings(ctx) {
  const B = ctx.ceil;
  ctx.rooms.forEach((rm) => {
    B.at(rm.centroid.x, rm.centroid.y);
    const region = { bounds: rm.bounds, height: rm.ceilY, deck: rm.deck, rect: rm.rect, contains: rm.contains };
    if (rm.ceiling === 'open') {
      openCeiling(ctx, { ...region, height: rm.height });
      return;
    }
    const tile = rm.ceiling === 'tile';
    // Grown slightly so neighbors overlap without cracks; ceilY staggers them so the overlap never z-fights.
    horizontalPolygon(B.get(tile ? ctx.mats.tile : ctx.mats.drywall, false, false), rm.grown.contour, rm.grown.faces, rm.ceilY, false, 1);
    if (tile) tileFixtures(ctx, region, fixtureGrid(ctx, region, TROFFER_STEP, TILE / 2 + 0.1, true));
    else drywallFixtures(ctx, region, fixtureGrid(ctx, region, DOWNLIGHT_STEP, 0.35, false));
  });
  generalCeiling(ctx);
  structuralDeck(ctx);
  bulkheads(ctx);
}

/**
 * Where a room edge meets a higher (or open) neighbor and no wall reaches the higher side, close the
 * step with a bulkhead: a white drywall edge band, dark above it like the rest of an exposed ceiling
 * (between two spaces only when the step is no taller than DARK_STEP_MAX, so a low room inside a tall
 * hall does not grow a dark tower). A wall that reaches the lower ceiling hides the band.
 */
function bulkheads(ctx) {
  const B = ctx.ceil;
  // Vertical faces take shadows, so the sun never reaches them through the roof.
  const band = all(B.get(ctx.mats.drywall, false, true)), dark = all(B.get(ctx.mats.deck, false, true));
  // Above a wall the band carries the wall on up, in its paint.
  const onWall = all(B.get(ctx.mats.paint, false, true));
  const topOf = (space) => (space.ceiling === 'open' ? space.deck : space.ceilY);
  // Walls count with the part that rises above them (upperWall).
  const reach = (n, p) => {
    const info = ctx.wallInfo[n];
    if (!info) return ctx.plan.walls[n].height;
    const s = dot(sub(p, info.F.o), info.F.d);
    const k = info.sides.findIndex((run) => s <= run.s1);
    return info.tops[k < 0 ? info.tops.length - 1 : k];
  };
  for (const rm of ctx.rooms) {
    const own = topOf(rm);
    for (const { F, sign, samples } of edgeSamples(ctx, rm)) {
      let run = null;
      const flushRun = () => {
        if (!run) return;
        const { s0, s1, lo, hi, from, exposed, closes } = run;
        const fascia = exposed ? Math.min(hi, from + 0.1) : hi;
        if (from === lo) {
          box(F, band, s0, s1, -0.01, 0.01, lo, fascia);
          // A short return toward the lower ceiling covers any gap at its edge.
          const r = run.lowerOut ? -sign : sign;
          box(F, band, s0, s1, Math.min(0, r * 0.14), Math.max(0, r * 0.14), lo - 0.004, lo + 0.002);
        } else if (!exposed) {
          box(F, onWall, s0, s1, -0.01, 0.01, from, hi);
        }
        if (closes) box(F, dark, s0, s1, -0.01, 0.01, from === lo ? fascia : from, hi);
        run = null;
      };
      for (const { s0, s1, p, other } of samples) {
        const wallTop = ctx.wallTop(p, reach);
        // Outdoors, the step closes the room's own plenum up to its deck.
        const top = other ? topOf(other) : rm.deck;
        const lo = Math.min(own, top), hi = Math.max(own, top);
        const upper = own < top ? other : rm;
        const exposed = !upper || upper.ceiling === 'open';
        const from = wallTop >= lo - 0.05 ? Math.max(lo, wallTop) : lo;
        // The dark part closes the room's own envelope outdoors, but between spaces only a modest step.
        const closes = exposed && (!other || hi - lo <= DARK_STEP_MAX);
        const emit = hi - lo > 0.01 && (other?.points ? own < top : true) && wallTop < hi - 0.05 && (from === lo || !exposed || closes);
        const key = emit ? `${lo.toFixed(3)}|${hi.toFixed(3)}|${from.toFixed(3)}` : null;
        if (!emit || run?.key !== key) flushRun();
        if (!emit) continue;
        if (!run) run = { key, s0, s1, lo, hi, from, exposed, closes, lowerOut: own > top };
        run.s1 = s1;
      }
      flushRun();
    }
  }
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}

/** Ceiling for building areas that are not traced as rooms, using settings.ceiling. */
function generalCeiling(ctx) {
  const { mask, rooms, settings, generals } = ctx;
  if (!generals.length) return;
  const H = settings.wallHeight;
  const free = mask.free.map((v) => (v >= 0 ? 1 : 0));
  const rects = maskRects(mask, free);
  const bounds = rects.reduce(unionBounds);
  const region = {
    bounds,
    height: H,
    deck: generals.reduce((top, g) => Math.max(top, g.deck), 0),
    contains: (p) => {
      const k = mask.index(p.x, p.y);
      return k >= 0 && free[k] === 1;
    },
  };
  ctx.ceil.at((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2);
  if (settings.ceiling === 'open') {
    openCeiling(ctx, region);
    return;
  }
  // Grow one cell into walls and flat neighbors so the edges tuck under rooms and into walls.
  const plane = dilate(mask, free, 1, (k) => {
    const ri = mask.room[k];
    return ri < 0 || (rooms[ri].ceiling !== 'open' && Math.abs(rooms[ri].height - H) < 0.01);
  });
  const tile = settings.ceiling === 'tile';
  const b = ctx.ceil.get(tile ? ctx.mats.tile : ctx.mats.drywall, false, false);
  for (const r of maskRects(mask, plane)) rectQuad(b, r, H, DOWN);
  if (tile) tileFixtures(ctx, region, fixtureGrid(ctx, region, TROFFER_STEP, TILE / 2 + 0.1, true));
  else drywallFixtures(ctx, region, fixtureGrid(ctx, region, DOWNLIGHT_STEP, 0.35, false));
}

/**
 * Dark structural deck: the visible soffit of open ceilings and the lid over every plenum. Each room
 * gets its own deck height; the untraced area is grown under the walls, but never into a room whose
 * deck is higher.
 */
function structuralDeck(ctx) {
  const { mask, rooms, generals } = ctx;
  const b = ctx.ceil.get(ctx.mats.deckSoffit, true, false);
  for (const rm of rooms) horizontalPolygon(b, rm.grown.contour, rm.grown.faces, rm.deck, false, 1);
  for (const deck of new Set(generals.map((g) => g.deck))) {
    const src = mask.free.map((v) => (v >= 0 && generals[v].deck === deck ? 1 : 0));
    const cells = dilate(mask, src, 2, (k) => {
      const ri = mask.room[k], gi = mask.free[k];
      return ri >= 0 ? rooms[ri].deck <= deck + 1e-3 : gi < 0 || generals[gi].deck <= deck + 1e-3;
    });
    for (const r of maskRects(mask, cells)) rectQuad(b, r, deck, DOWN);
  }
}

/** Horizontal quad over a plan rectangle, padded so neighboring rectangles overlap instead of cracking. */
function rectQuad(b, r, y, n, pad = 0.004) {
  const x0 = r.minX - pad, x1 = r.maxX + pad, z0 = r.minY - pad, z1 = r.maxY + pad;
  quad(b, [x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], n, x0, -z0, x1, -z1);
}

const snapTile = (v) => (Math.round(v / TILE - 0.5) + 0.5) * TILE;

/** A grid centered on the region, optionally snapped to acoustic tile centers. */
function centeredGrid(region, step, snap) {
  const b = region.bounds;
  const nx = Math.max(1, Math.round((b.maxX - b.minX) / step)), ny = Math.max(1, Math.round((b.maxY - b.minY) / step));
  let x0 = (b.minX + b.maxX) / 2 - ((nx - 1) * step) / 2, y0 = (b.minY + b.maxY) / 2 - ((ny - 1) * step) / 2;
  if (snap) {
    x0 = snapTile(x0);
    y0 = snapTile(y0);
  }
  const pts = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) pts.push({ x: x0 + i * step, y: y0 + j * step });
  return pts;
}

/**
 * Light fixture positions for a ceiling region, `half` being the clearance a fixture needs: a centered
 * grid for a rectangular room, else fillGrid. Draws from the plan's fixture budget.
 */
function fixtureGrid(ctx, region, step, half, snap) {
  const b = region.bounds;
  const estimate = ((b.maxX - b.minX) / step + 1) * ((b.maxY - b.minY) / step + 1);
  if (estimate > ctx.fixtures) return [];
  const pts = region.rect ? centeredGrid(region, step, snap) : fillGrid(region, step, half, snap);
  ctx.fixtures -= pts.length;
  return pts;
}

/**
 * Fixture positions that fill any outline (L, U and T shapes, long corridors): the cells where a
 * fixture fits (tile centers when snapped) are covered by rectangles, largest first, each holding a
 * centered grid. Points closer than 0.75 step to an earlier one are dropped.
 */
function fillGrid(region, step, half, snap) {
  const b = region.bounds;
  const c = snap ? TILE : step / 3;
  const x0 = snap ? Math.floor(b.minX / TILE) * TILE : b.minX, y0 = snap ? Math.floor(b.minY / TILE) * TILE : b.minY;
  const nx = Math.max(1, Math.ceil((b.maxX - x0) / c)), ny = Math.max(1, Math.ceil((b.maxY - y0) / c));
  if (nx * ny > MAX_MASK_CELLS) return [];
  const cx = (i) => x0 + (i + 0.5) * c, cy = (j) => y0 + (j + 0.5) * c;
  const ok = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) ok[j * nx + i] = fits(region, { x: cx(i), y: cy(j) }, half) ? 1 : 0;
  const minDist = step * 0.75, reach = Math.ceil(minDist / c);
  // How far past a cell center (up to one cell) a fixture still fits, so a rectangle spans its true width.
  const slack = (x, y, dx, dy) => {
    let t = 0;
    while (t < c && fits(region, { x: x + dx * (t + 0.05), y: y + dy * (t + 0.05) }, half)) t += 0.05;
    return t;
  };
  const pts = [];
  // Placed points hashed on a minDist grid, so the spacing test only looks at neighbors.
  const near = new Map();
  const crowded = (p) => {
    const i = Math.floor(p.x / minDist), j = Math.floor(p.y / minDist);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        for (const q of near.get(`${i + di},${j + dj}`) || []) if (Math.hypot(q.x - p.x, q.y - p.y) < minDist) return true;
      }
    }
    return false;
  };
  // Each pass scans every cell, so very large regions get fewer passes.
  const passes = Math.min(400, Math.ceil(2e7 / (nx * ny)));
  for (let pass = 0; pass < passes; pass++) {
    const r = largestRect(ok, nx, ny);
    if (!r) break;
    const mx = cx((r.i0 + r.i1 - 1) >> 1), my = cy((r.j0 + r.j1 - 1) >> 1);
    const bounds = {
      minX: cx(r.i0) - slack(cx(r.i0), my, -1, 0) - half, maxX: cx(r.i1 - 1) + slack(cx(r.i1 - 1), my, 1, 0) + half,
      minY: cy(r.j0) - slack(mx, cy(r.j0), 0, -1) - half, maxY: cy(r.j1 - 1) + slack(mx, cy(r.j1 - 1), 0, 1) + half,
    };
    for (let j = r.j0; j < r.j1; j++) ok.fill(0, j * nx + r.i0, j * nx + r.i1);
    for (const p of centeredGrid({ bounds }, step, snap)) {
      if (!fits(region, p, half) || crowded(p)) continue;
      pts.push(p);
      const k = `${Math.floor(p.x / minDist)},${Math.floor(p.y / minDist)}`;
      if (!near.has(k)) near.set(k, []);
      near.get(k).push(p);
      // Cells this close to a fixture can no longer hold one.
      const pi = Math.floor((p.x - x0) / c), pj = Math.floor((p.y - y0) / c);
      for (let j = Math.max(0, pj - reach); j <= Math.min(ny - 1, pj + reach); j++) {
        for (let i = Math.max(0, pi - reach); i <= Math.min(nx - 1, pi + reach); i++) {
          if (Math.hypot(cx(i) - p.x, cy(j) - p.y) < minDist) ok[j * nx + i] = 0;
        }
      }
    }
  }
  return pts;
}

/** Largest rectangle of set cells, as cell ranges [i0, i1) x [j0, j1), or null when none are set. */
function largestRect(ok, nx, ny) {
  const h = new Int32Array(nx), stack = new Int32Array(nx + 1);
  let best = null, area = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) h[i] = ok[j * nx + i] ? h[i] + 1 : 0;
    let top = 0;
    for (let i = 0; i <= nx; i++) {
      const hi = i < nx ? h[i] : 0;
      while (top && h[stack[top - 1]] >= hi) {
        const height = h[stack[--top]];
        const left = top ? stack[top - 1] + 1 : 0;
        if (height * (i - left) > area) {
          area = height * (i - left);
          best = { i0: left, i1: i, j0: j - height + 1, j1: j + 1 };
        }
      }
      stack[top++] = i;
    }
  }
  return best;
}

function fits(region, p, half) {
  const c = region.contains;
  return c(p) && c({ x: p.x - half, y: p.y - half }) && c({ x: p.x + half, y: p.y - half })
    && c({ x: p.x + half, y: p.y + half }) && c({ x: p.x - half, y: p.y + half });
}

/** LED troffers on the tile grid, plus supply diffusers and sprinkler heads between them. */
function tileFixtures(ctx, region, points) {
  const h = region.height;
  for (const p of points) if (fits(region, p, TILE / 2 + 0.1)) troffer(ctx, p, h);
  if (ctx.low) return;
  const half = TROFFER_STEP / 2;
  points.forEach((p, i) => {
    const d = { x: p.x + half, y: p.y + half };
    if (i % 2 === 0 && fits(region, d, TILE / 2 + 0.1)) diffuser(ctx, d, h);
    const s = { x: p.x + half, y: p.y };
    if (fits(region, s, 0.3)) sprinkler(ctx, s, h);
  });
}

function drywallFixtures(ctx, region, points) {
  const h = region.height;
  for (const p of points) if (fits(region, p, 0.35)) downlight(ctx, p, h);
  if (ctx.low) return;
  for (const p of points) {
    const s = { x: p.x + DOWNLIGHT_STEP / 2, y: p.y + DOWNLIGHT_STEP / 2 };
    if (fits(region, s, 0.5)) sprinkler(ctx, s, h);
  }
}

/**
 * 2 x 2 LED troffer: a slim white frame with eased edges, a short reflector sloping up to a lens
 * recessed about a centimeter into it, and the glowing lens itself.
 */
function troffer(ctx, p, h) {
  const B = ctx.ceil;
  const hs = TILE / 2 - 0.004, rim = 0.024, depth = 0.014;
  const lens = B.get(ctx.mats.led, false, false);
  ctx.emitters.push({ x: p.x, y: p.y, h, power: PLAN_LIGHT.troffer, cone: 1 });
  if (ctx.low) {
    box(WORLD, { bottom: lens }, p.x - hs, p.x + hs, p.y - hs, p.y + hs, h - 0.002, h);
    return;
  }
  const trim = B.get(ctx.mats.trim, false, true), y0 = h - depth, r = 0.003;
  const long = ['bottom', 'pu', 'nu', 's0', 's1'], short = ['bottom', 'pu', 'nu'];
  rbox(ctx, WORLD, trim, p.x - hs, p.x + hs, p.y - hs, p.y - hs + rim, y0, h, r, { faces: long });
  rbox(ctx, WORLD, trim, p.x - hs, p.x + hs, p.y + hs - rim, p.y + hs, y0, h, r, { faces: long });
  const side = { o: { x: 0, y: 0 }, d: { x: 0, y: 1 }, n: { x: -1, y: 0 } };
  rbox(ctx, side, trim, p.y - hs + rim, p.y + hs - rim, -(p.x - hs + rim), -(p.x - hs), y0, h, r, { faces: short });
  rbox(ctx, side, trim, p.y - hs + rim, p.y + hs - rim, -(p.x + hs), -(p.x + hs - rim), y0, h, r, { faces: short });
  // Reflector bands from the frame's inner edge up to the lens, facing down and in.
  const a = hs - rim, l = a - 0.012, yl = h - 0.004;
  const rise = yl - y0, run = a - l, k = Math.hypot(rise, run);
  const refl = B.get(ctx.mats.reflector, false, false);
  for (const [tx, tz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    // Corners of the band on the side opposite (tx, tz): outer low edge, then inner high edge.
    const ox = -tx, oz = -tz, px = -oz, pz = ox;
    const at = (d, along, y) => [p.x + ox * d + px * along, y, p.y + oz * d + pz * along];
    const nrm = [tx * rise / k, -run / k, tz * rise / k];
    const V = (c) => [...c, ...nrm, c[0], -c[2]];
    poly(refl, [V(at(a, -a, y0)), V(at(a, a, y0)), V(at(l, l, yl)), V(at(l, -l, yl))]);
  }
  quad(lens, [p.x - l, yl, p.y - l], [p.x + l, yl, p.y - l], [p.x + l, yl, p.y + l], [p.x - l, yl, p.y + l], DOWN, 0, 1, 1, 0);
  ctx.luminaires.push({ x: p.x, y: yl - 0.002, z: p.y, length: 2 * l, breadth: 2 * l, dir: { x: 1, y: 0 }, radiance: LED.troffer });
}

function diffuser(ctx, p, h) {
  const b = ctx.ceil.get(ctx.mats.get('diffuser'), false, false);
  const hs = TILE / 2 - 0.01, y = h - 0.003;
  quad(b, [p.x - hs, y, p.y - hs], [p.x + hs, y, p.y - hs], [p.x + hs, y, p.y + hs], [p.x - hs, y, p.y + hs], DOWN, 0, 1, 1, 0);
}

/** Recessed LED downlight: a white trim ring around a bright lens. */
function downlight(ctx, p, h) {
  const seg = ctx.low ? 12 : 24;
  // Reflector downlights throw a narrower beam than a troffer's lambertian lens.
  ctx.emitters.push({ x: p.x, y: p.y, h, power: PLAN_LIGHT.downlight, cone: 2 });
  cylinder(ctx, ctx.ceil.get(ctx.mats.trim, false, true), p.x, h - 0.008, p.y, 0.09, 0.008, seg);
  cylinder(ctx, ctx.ceil.get(ctx.mats.spot, false, false), p.x, h - 0.0086, p.y, 0.064, 0.0006, seg);
  // A square of the lens's area.
  ctx.luminaires.push({ x: p.x, y: h - 0.009, z: p.y, length: 0.113, breadth: 0.113, dir: { x: 1, y: 0 }, radiance: LED.downlight });
}

function sprinkler(ctx, p, h) {
  const f = { ...faces2(ctx.ceil.get(ctx.mats.sprinkler, false, true)) };
  f.s0 = f.s1 = f.bottom = f.pu;
  box(WORLD, f, p.x - 0.022, p.x + 0.022, p.y - 0.022, p.y + 0.022, h - 0.003, h);
  box(WORLD, f, p.x - 0.006, p.x + 0.006, p.y - 0.006, p.y + 0.006, h - 0.026, h - 0.003);
  box(WORLD, f, p.x - 0.013, p.x + 0.013, p.y - 0.013, p.y + 0.013, h - 0.03, h - 0.026);
}

/**
 * Exposed structure: no ceiling plane, pendant linear lights in rows and round ducts below the deck.
 * Pendants and ducts stop short of columns and other items that reach up to them.
 */
function openCeiling(ctx, region) {
  const { deck } = region;
  const b = region.bounds;
  const alongX = b.maxX - b.minX >= b.maxY - b.minY;
  const [l0, l1] = alongX ? [b.minX, b.maxX] : [b.minY, b.maxY];
  const [c0, c1] = alongX ? [b.minY, b.maxY] : [b.minX, b.maxX];
  const short = c1 - c0;
  const rows = clamp(Math.round(short / 2.4), 1, 200);
  const step = short / rows;
  const at = (c, s) => (alongX ? { x: s, y: c } : { x: c, y: s });
  const runs = (c, margin, blocked) => insideRuns(region, at(c, l0), at(c, l1), margin, blocked);
  const pendantClear = obstructions(ctx, region, region.height - 0.25);
  for (let r = 0; r < rows; r++) {
    const c = c0 + step * (r + 0.5);
    for (const [s0, s1] of runs(c, 0.7, pendantClear)) pendantRun(ctx, at, c, l0 + s0, l0 + s1, region.height, deck);
  }
  const radius = short < 4 ? 0.17 : 0.22;
  const ductClear = obstructions(ctx, region, deck - 0.45 - 2 * radius);
  const lines = short > 6 ? [c0 + short / 3, c0 + (2 * short) / 3] : [c0 + short / 2];
  for (let c of lines) {
    // Keep ducts clear of the pendant cables.
    const row = c0 + step * (Math.round((c - c0) / step - 0.5) + 0.5);
    if (Math.abs(c - row) < 0.6) c = row + Math.min(step / 2, 0.9) * (c >= c0 + short / 2 ? -1 : 1);
    for (const [s0, s1] of runs(c, 0.5, ductClear)) {
      if (ctx.fixtures < 10) break;
      ctx.fixtures -= 10;
      duct(ctx, at(c, l0 + s0), at(c, l0 + s1), radius, deck);
    }
  }
  if (ctx.low) return;
  // Exposed structure takes shadows (the deck above shades it from the sun).
  const beam = all(ctx.ceil.get(ctx.mats.beam, false, true));
  const bays = clamp(Math.round((l1 - l0) / 3), 1, 400);
  for (let k = 1; k < bays; k++) {
    const l = l0 + ((l1 - l0) * k) / bays;
    const a = alongX ? { x: l, y: c0 } : { x: c0, y: l }, e = alongX ? { x: l, y: c1 } : { x: c1, y: l };
    for (const [s0, s1] of insideRuns(region, a, e, 0)) {
      const F = frameOf(alongX ? { x: l, y: c0 } : { x: c0, y: l }, alongX ? { x: 0, y: 1 } : { x: 1, y: 0 });
      box(F, beam, s0, s1, -0.075, 0.075, deck - 0.36, deck);
    }
  }
}

/** A test for plan points within 0.2 m of an item in the region that reaches up to height y, or null. */
function obstructions(ctx, region, y) {
  const pad = 0.2, rb = region.bounds;
  const near = (b, p0, p1) => p1.x > b.minX - pad && p0.x < b.maxX + pad && p1.y > b.minY - pad && p0.y < b.maxY + pad;
  const list = ctx.tall
    .filter(({ top, bounds }) => top > y && near(bounds, { x: rb.minX, y: rb.minY }, { x: rb.maxX, y: rb.maxY }))
    .map(({ item, dims, bounds }) => ({ bounds, corners: itemCorners(item, { w: dims.w + 2 * pad, d: dims.d + 2 * pad }) }));
  if (!list.length) return null;
  return (p) => list.some(({ bounds, corners }) => near(bounds, p, p) && pointInPolygon(p, corners));
}

/** Sampled stretches of the segment a..b that lie inside the region (and clear of `blocked`), shrunk by margin at each end. */
function insideRuns(region, a, b, margin, blocked = null) {
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  const n = clamp(Math.ceil(L / 0.15), 1, MAX_SAMPLES);
  const runs = [];
  let start = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const ok = region.contains(p) && !blocked?.(p);
    if (ok && start === null) start = t * L;
    if ((!ok || i === n) && start !== null) {
      const end = ok ? L : ((i - 1) / n) * L;
      if (end - start - 2 * margin > 0.6) runs.push([start + margin, end - margin]);
      start = null;
    }
  }
  return runs;
}

function pendantRun(ctx, at, c, s0, s1, h, deck) {
  const len = s1 - s0;
  const L = 2.4, gap = 0.9;
  const n = Math.max(1, Math.floor((len + gap) / (L + gap)));
  const lp = n === 1 ? Math.min(L, len) : L;
  if (lp < 0.9 || n > ctx.fixtures) return;
  ctx.fixtures -= n;
  let s = s0 + (len - (n * lp + (n - 1) * gap)) / 2;
  for (let i = 0; i < n; i++, s += lp + gap) pendant(ctx, at(c, s), at(c, s + lp), h, deck);
}

function pendant(ctx, p0, p1, h, deck) {
  const B = ctx.ceil;
  const d = { x: p1.x - p0.x, y: p1.y - p0.y };
  const len = Math.hypot(d.x, d.y);
  const F = frameOf(p0, { x: d.x / len, y: d.y / len });
  const y0 = h - 0.18, y1 = h - 0.1;
  const n = Math.max(1, Math.round(len / PLAN_LIGHT.pendantStep));
  for (let k = 0; k < n; k++) {
    const s = ((k + 0.5) * len) / n;
    ctx.emitters.push({ x: p0.x + F.d.x * s, y: p0.y + F.d.y * s, h: y0, power: (PLAN_LIGHT.pendant * len) / n / PLAN_LIGHT.pendantStep, cone: 1 });
  }
  box(F, all(B.get(ctx.mats.pendant, false, true)), 0, len, -0.03, 0.03, y0, y1);
  box(F, { bottom: B.get(ctx.mats.strip, false, false) }, 0.01, len - 0.01, -0.02, 0.02, y0 - 0.002, y0);
  ctx.luminaires.push({ x: p0.x + F.d.x * len / 2, y: y0 - 0.004, z: p0.y + F.d.y * len / 2, length: len - 0.02, breadth: 0.04, dir: F.d, radiance: LED.pendant });
  const cable = all(B.get(ctx.mats.duct, false, true));
  for (const s of [0.25, len - 0.25]) box(F, cable, s - 0.002, s + 0.002, -0.002, 0.002, y1, deck);
}

/** Round duct that drops from the deck at p0 and runs to p1, with seam rings and hanger rods. */
function duct(ctx, p0, p1, r, deck) {
  const B = ctx.ceil.get(ctx.mats.duct, false, true);
  const y = deck - 0.45 - r;
  const seg = ctx.low ? 12 : 20;
  const a = new THREE.Vector3(p0.x, y, p0.y);
  tube(ctx, B, a, new THREE.Vector3(p1.x, y, p1.y), r, seg);
  tube(ctx, B, a, new THREE.Vector3(p0.x, deck, p0.y), r, seg);
  sphere(ctx, B, p0.x, y, p0.y, r, seg);
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const d = { x: (p1.x - p0.x) / len, y: (p1.y - p0.y) / len };
  const F = frameOf(p0, d);
  const rod = all(ctx.ceil.get(ctx.mats.beam, false, true));
  // Spacing grows on absurdly long runs so the part count stays bounded.
  const rodStep = Math.max(2.4, len / 400), ringStep = Math.max(1.5, len / 400);
  for (let s = rodStep / 2; s < len - 0.3; s += rodStep) {
    box(F, rod, s - 0.006, s + 0.006, -r - 0.018, -r - 0.006, y, deck - 0.36);
    box(F, rod, s - 0.006, s + 0.006, r + 0.006, r + 0.018, y, deck - 0.36);
  }
  if (ctx.low) return;
  for (let s = ringStep / 2; s < len - 0.1; s += ringStep) {
    const c = new THREE.Vector3(p0.x + d.x * s, y, p0.y + d.y * s);
    tube(ctx, B, c.clone().addScaledVector(new THREE.Vector3(d.x, 0, d.y), -0.015), c.clone().addScaledVector(new THREE.Vector3(d.x, 0, d.y), 0.015), r + 0.008, seg);
  }
}

// ---- Daylight and the environment probe -------------------------------------------

/**
 * Area lights for reflections: one-sided lights at the glass of the windows, facing in, and on the
 * lenses of the ceiling fixtures, facing down, so glossy floors, quartz and metals mirror the windows
 * and fixtures around the viewer. Their diffuse light is left to the light map. Windows in a row
 * (same line, sill and head, gaps under DAYLIGHT.merge, one space) form one run whose radiance is
 * scaled by its glass share. Fixed sets of at most DAYLIGHT.max window lights and FIXTURE_LIGHTS
 * fixture lights are aimed at the runs and fixtures nearest the viewer, in the viewer's space first,
 * before every render (see aimDaylight; the counts never change, so shaders stay compiled). They are
 * real-time stand-ins (the path traced photo finds the real light), so the group is flagged as an
 * overlay that photo.js leaves out.
 */
function buildDaylight(ctx, probe) {
  const group = namedGroup('daylight');
  group.userData.overlay = true;
  group.userData.realtimeOnly = true;
  const pools = [
    { runs: daylightRuns(ctx), max: ctx.low ? DAYLIGHT.maxLow : DAYLIGHT.max, name: 'window-light', place: placeWindow, lights: [] },
    { runs: fixtureRuns(ctx), max: ctx.low ? 0 : FIXTURE_LIGHTS, name: 'fixture-light', place: placeFixture, lights: [] },
  ];
  group.userData.pools = pools;
  group.userData.runs = pools[0].runs;
  group.userData.spaceAt = ctx.planLight.spaceAt;
  for (const pool of pools) {
    const n = Math.min(pool.runs.length, pool.max);
    if (n) initAreaLights();
    for (let i = 0; i < n; i++) {
      const light = new THREE.RectAreaLight(DAYLIGHT.color, 0, 1, 1);
      light.name = pool.name;
      light.userData.run = -1;
      pool.lights.push(light);
      group.add(light);
    }
  }
  // Per light, the space its run lights; shaders only take a light's reflection within that space.
  group.userData.rectSpace = new Float32Array(Math.max(1, group.children.length)).fill(-2);
  // Until a render aims them, the lights sit on the runs nearest the environment probe.
  aimDaylight(group, probe.x, probe.z);
  return group;
}

/**
 * Put each pool's lights on the runs nearest plan point (x, z), those of the space there first
 * (other rooms' lights reflect only in those rooms). Lights already on a chosen run stay, so only
 * the farthest lights ever move as the viewer walks.
 */
function aimDaylight(group, x, z) {
  const pools = group.userData.pools;
  if (!pools) return;
  // Every render calls this; a viewer standing still needs no new choice.
  const last = group.userData.aim;
  if (last && Math.abs(last.x - x) < 0.01 && Math.abs(last.z - z) < 0.01) return;
  group.userData.aim = { x, z };
  const here = group.userData.spaceAt?.(x, z) ?? -1;
  for (const { runs, lights, place } of pools) {
    if (!runs.length || !lights.length) continue;
    const near = nearestRuns(runs, lights.length, (r) => runDistance(r, x, z) + (here >= 0 && r.space !== here ? 12 : 0));
    const chosen = new Set(near), kept = new Set(), free = [];
    for (const l of lights) {
      if (chosen.has(l.userData.run) && !kept.has(l.userData.run)) kept.add(l.userData.run);
      else free.push(l);
    }
    for (const i of near) {
      if (kept.has(i)) continue;
      const l = free.pop();
      l.userData.run = i;
      l.userData.space = runs[i].space;
      place(l, runs[i]);
      l.updateMatrixWorld();
    }
  }
  const spaces = group.userData.rectSpace;
  group.children.forEach((l, i) => { if (i < spaces.length) spaces[i] = l.userData.space ?? -2; });
}

/** Indices of the k runs with the smallest cost(run), nearest first (k is small; plans have thousands of fixtures). */
function nearestRuns(runs, k, cost) {
  const best = [];
  for (let i = 0; i < runs.length; i++) {
    const c = cost(runs[i]);
    if (best.length === k && c >= best[k - 1][0]) continue;
    let j = best.length < k ? best.length : k - 1;
    while (j > 0 && best[j - 1][0] > c) {
      best[j] = best[j - 1];
      j--;
    }
    best[j] = [c, i];
  }
  return best.map((e) => e[1]);
}

/** Plan distance from (x, z) to a run: the nearest point of a window run's span, a fixture's center. */
function runDistance(r, x, z) {
  if (!r.normal) return Math.hypot(x - r.center.x, z - r.center.y);
  const t = clamp((z - r.center.y) * r.normal.x - (x - r.center.x) * r.normal.y, -r.width / 2, r.width / 2);
  // Along the run from its center on its tangent (-normal.y, normal.x).
  return Math.hypot(x - (r.center.x - r.normal.y * t), z - (r.center.y + r.normal.x * t));
}

function placeWindow(l, r) {
  l.width = r.width;
  l.height = r.height;
  l.intensity = DAYLIGHT.radiance * r.weight * Math.min(1, r.glass / r.area) * r.sun;
  l.color.copy(r.tint);
  // Just inside the glass, emitting into the room (a RectAreaLight shines along its -z, which lookAt aims).
  const y = (r.y0 + r.y1) / 2;
  l.position.set(r.center.x + r.normal.x * 0.02, y, r.center.y + r.normal.y * 0.02);
  l.lookAt(l.position.x + r.normal.x, y, l.position.z + r.normal.y);
}

function placeFixture(l, r) {
  l.width = r.length;
  l.height = r.breadth;
  l.intensity = r.radiance;
  l.color.set(LED.color);
  l.position.set(r.center.x, r.y, r.center.y);
  // Face down (local -z to world -y), its width along the fixture.
  l.rotation.set(-Math.PI / 2, Math.atan2(-r.dir.y, r.dir.x), 0, 'YXZ');
}

/** Ceiling fixture lenses as reflection light candidates, in their spaces. */
function fixtureRuns(ctx) {
  return ctx.luminaires.map((f) => ({ ...f, center: { x: f.x, y: f.z }, space: ctx.planLight.spaceAt(f.x, f.z) }));
}

/**
 * Before each render of a scene from setupEnvironment(): bind the light map of the built plan in it
 * (with several, the last one's) and aim every built plan's daylight at the camera.
 */
function aimSceneDaylight(scene, camera) {
  let p = null;
  for (const c of scene.children) {
    c.userData.planLight?.bind();
    const group = c.userData.daylight;
    if (!group?.children.length) continue;
    p ||= new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    aimDaylight(group, p.x, p.z);
  }
}

/** Where the daylight group's lights are, for restoreDaylight(). */
function daylightState(group) {
  return {
    aim: group.userData.aim,
    spaces: group.userData.rectSpace.slice(),
    lights: group.children.map((l) => ({
      l, run: l.userData.run, space: l.userData.space, width: l.width, height: l.height, intensity: l.intensity,
      color: l.color.clone(), position: l.position.clone(), quaternion: l.quaternion.clone(),
    })),
  };
}

function restoreDaylight(group, state) {
  group.userData.aim = state.aim;
  group.userData.rectSpace.set(state.spaces);
  for (const s of state.lights) {
    const { l } = s;
    Object.assign(l.userData, { run: s.run, space: s.space });
    Object.assign(l, { width: s.width, height: s.height, intensity: s.intensity });
    l.color.copy(s.color);
    l.position.copy(s.position);
    l.quaternion.copy(s.quaternion);
    l.updateMatrixWorld();
  }
}

/** Glazing grouped into runs along each facade line: { center, normal, width, height, y0, y1, glass, area, weight }. */
function daylightRuns(ctx) {
  const lines = new Map();
  for (const w of ctx.windows) {
    if (w.s1 - w.s0 < 0.2 || w.y1 - w.y0 < 0.2) continue;
    const { F } = w.info;
    const N = { x: F.n.x * w.side, y: F.n.y * w.side }, T = { x: -N.y, y: N.x };
    const P = (s) => ({ x: F.o.x + F.d.x * s + F.n.x * w.u, y: F.o.y + F.d.y * s + F.n.y * w.u });
    const ta = dot(P(w.s0), T), tb = dot(P(w.s1), T), off = dot(P(w.s0), N);
    // Runs never cross from one space into the next.
    const mid = P((w.s0 + w.s1) / 2), ht = w.info.w.thickness / 2 + 0.3;
    const space = ctx.planLight.spaceAt(mid.x + N.x * (ht - w.u * w.side), mid.y + N.y * (ht - w.u * w.side));
    const key = `${N.x.toFixed(2)}|${N.y.toFixed(2)}|${Math.round(off / 0.05)}|${w.y0.toFixed(2)}|${w.y1.toFixed(2)}|${w.weight}|${space}`;
    if (!lines.has(key)) lines.set(key, { N, T, off, y0: w.y0, y1: w.y1, weight: w.weight, space, spans: [] });
    lines.get(key).spans.push([Math.min(ta, tb), Math.max(ta, tb)]);
  }
  const runs = [];
  for (const line of lines.values()) {
    line.spans.sort((p, q) => p[0] - q[0]);
    let run = null;
    const close = () => {
      if (!run) return;
      const tm = (run.t0 + run.t1) / 2, h = line.y1 - line.y0;
      runs.push({
        center: { x: line.N.x * line.off + line.T.x * tm, y: line.N.y * line.off + line.T.y * tm },
        normal: line.N, width: run.t1 - run.t0, height: h, y0: line.y0, y1: line.y1,
        glass: run.glass * h, area: (run.t1 - run.t0) * h, weight: line.weight, space: line.space, ...sunSide(line.N),
      });
    };
    for (const [t0, t1] of line.spans) {
      if (run && t0 - run.t1 < DAYLIGHT.merge) {
        run.t1 = Math.max(run.t1, t1);
        run.glass += t1 - t0;
      } else {
        close();
        run = { t0, t1, glass: t1 - t0 };
      }
    }
    close();
  }
  return runs;
}

/**
 * How a window's daylight changes with its facing: glazing toward the sun sees sunlit ground and
 * the bright sky around the sun (brighter, warmer); glazing away from it sees blue sky (cooler).
 */
function sunSide(N) {
  const h = Math.hypot(SUN_DIR.x, SUN_DIR.z);
  // N points into the room, so the window looks out along -N.
  const toward = clamp(-(N.x * SUN_DIR.x + N.y * SUN_DIR.z) / h, -1, 1);
  const tint = new THREE.Color(DAYLIGHT.color).lerp(new THREE.Color(toward > 0 ? '#fff3e2' : '#e8f0fb'), Math.abs(toward) * 0.6);
  return { sun: 1 + 0.3 * toward, tint };
}

/**
 * Default viewpoint for captureEnvironment(): the middle of the largest room (the point nearest its
 * centroid that lies inside it and clear of tall items) at PROBE_HEIGHT, kept under its ceiling.
 */
function environmentProbe(ctx) {
  const clear = (p, y) => ctx.tall.every((t) => t.top < y - 0.3 || p.x < t.bounds.minX - 0.4 || p.x > t.bounds.maxX + 0.4 || p.y < t.bounds.minY - 0.4 || p.y > t.bounds.maxY + 0.4);
  const rooms = ctx.rooms.slice().sort((a, b) => polygonArea(b.points) - polygonArea(a.points));
  for (const rm of rooms.slice(0, 3)) {
    const y = Math.min(PROBE_HEIGHT, rm.ceilY - 0.3);
    const c = rm.centroid, b = rm.bounds;
    if (rm.contains(c) && clear(c, y)) return { x: c.x, y, z: c.y };
    const step = Math.max(0.3, Math.max(b.maxX - b.minX, b.maxY - b.minY) / 40);
    let best = null, bestD = Infinity;
    for (let x = b.minX + step / 2; x < b.maxX; x += step) {
      for (let z = b.minY + step / 2; z < b.maxY; z += step) {
        const d = Math.hypot(x - c.x, z - c.y), p = { x, y: z };
        if (d < bestD && rm.contains(p) && clear(p, y)) { best = p; bestD = d; }
      }
    }
    if (best) return { x: best.x, y, z: best.y };
  }
  const b = ctx.bounds;
  return { x: (b.minX + b.maxX) / 2, y: Math.min(PROBE_HEIGHT, ctx.settings.wallHeight - 0.3), z: (b.minY + b.maxY) / 2 };
}

// ---- Plan light map -------------------------------------------------------------

/**
 * The diffuse light over the floor plate, on a grid of cells over the building. Each cell holds the
 * light it receives at PLAN_LIGHT.height from the fixtures and windows that see it, as a scalar
 * irradiance S and a vector irradiance E (shaders light a surface with normal n by
 * shade[0] * S + shade[1] * n.E), the daylight share of it, the light bounced around it, whether it
 * is indoors and which space it belongs to. Visibility: a cell sees an emitter in its own space
 * (rooms are close to convex); otherwise a ray across the grid decides, through doorways and glass
 * but not walls. Uploaded as two half float textures (see planPatch).
 */
function buildPlanLight(ctx) {
  const t0 = performance.now();
  const { mask } = ctx;
  const minX = mask.minX, minY = mask.minY, W = mask.nx * mask.c, H = mask.ny * mask.c;
  const g = Math.max(PLAN_LIGHT.cell, Math.sqrt((W * H) / PLAN_LIGHT.maxCells));
  const nx = Math.max(2, Math.ceil(W / g)), ny = Math.max(2, Math.ceil(H / g)), n = nx * ny;
  const cx = (i) => minX + (i + 0.5) * g, cy = (j) => minY + (j + 0.5) * g;
  const cell = (x, y) => {
    const i = Math.floor((x - minX) / g), j = Math.floor((y - minY) / g);
    return i < 0 || j < 0 || i >= nx || j >= ny ? -1 : j * nx + i;
  };
  // Space per cell: room index, then untraced patches after the rooms, -1 outdoors.
  const spaceOf = (x, y) => {
    const k = mask.index(x, y);
    if (k < 0 || !mask.inside[k]) return -1;
    return mask.room[k] >= 0 ? mask.room[k] : mask.free[k] >= 0 ? ctx.rooms.length + mask.free[k] : -1;
  };
  const space = new Int32Array(n);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) space[j * nx + i] = spaceOf(cx(i), cy(j));

  // Walls on the grid: 2 blocks light, 1 is glass. Doorways stay open; windows in exterior walls stay
  // solid (their daylight is added as a source), interior windows pass light like glass.
  const occ = new Uint8Array(n);
  const stamp = (F, half, s0, s1, value) => {
    const pad = 0.35 * g, reach = half + g;
    const ax = F.o.x + F.d.x * s0, ay = F.o.y + F.d.y * s0, bx = F.o.x + F.d.x * s1, by = F.o.y + F.d.y * s1;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - minX) / g)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx) + reach - minX) / g));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - reach - minY) / g)), j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by) + reach - minY) / g));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const px = cx(i) - F.o.x, py = cy(j) - F.o.y;
        const s = px * F.d.x + py * F.d.y, u = px * F.n.x + py * F.n.y;
        if (s < s0 - pad || s > s1 + pad || Math.abs(u) > half) continue;
        const k = j * nx + i;
        if (occ[k] < value) occ[k] = value;
      }
    }
  };
  for (const info of ctx.walls) {
    const { w, F, L, ext, spans, inner } = info;
    if (w.kind === 'partial') continue;
    const value = w.kind === 'glass' ? 1 : 2, half = w.thickness / 2 + 0.6 * g;
    let cursor = -ext.a;
    for (const sp of spans) {
      if (OPENING_TYPES[sp.o.type].passable) {
        stamp(F, half, cursor, sp.start, value);
        cursor = sp.end;
      } else if (sp.o.type === 'window' && inner === 0 && value === 2) {
        stamp(F, half, cursor, sp.start, value);
        stamp(F, half, sp.start, sp.end, 1);
        cursor = sp.end;
      }
    }
    stamp(F, half, cursor, L + ext.b, value);
  }

  // Transmittance along a ray from plan point (x, y) to the center of cell (i, j), in half-cell steps.
  let budget = PLAN_LIGHT.budget;
  const reaches = (x, y, i, j) => {
    const fx = (x - minX) / g, fy = (y - minY) / g, dx = i + 0.5 - fx, dy = j + 0.5 - fy;
    const steps = Math.ceil(Math.hypot(dx, dy) * 2);
    // Past the work budget (absurdly large plans) light stays within its own space.
    if ((budget -= steps) < 0) return 0;
    let t = 1, glass = false;
    for (let s = 1; s < steps; s++) {
      const o = occ[Math.floor(fy + (dy * s) / steps) * nx + Math.floor(fx + (dx * s) / steps)];
      if (o === 2) return 0;
      if (o === 1 && !glass) t *= PLAN_LIGHT.glass;
      glass = o === 1;
    }
    return t;
  };

  // Spaces that touch through open cells: by how many cell edges without a wall or glass, and
  // whether through glass at all. Daylight crosses any such link (doorways, glass partitions);
  // fixture light only open boundaries (rooms traced without a wall between them), since every room
  // has its own fixtures. Rays are cast only across links.
  const links = new Map();
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i, a = space[k];
      if (a < 0 || occ[k] === 2) continue;
      for (const q of [i + 1 < nx ? k + 1 : -1, j + 1 < ny ? k + nx : -1]) {
        const b = q >= 0 ? space[q] : -1;
        if (b < 0 || b === a || occ[q] === 2) continue;
        const key = a < b ? a * 65536 + b : b * 65536 + a;
        links.set(key, (links.get(key) || 0) + (occ[k] === 0 && occ[q] === 0 ? 1 : 0.001));
      }
    }
  }
  const pair = (a, b) => (a < 0 ? 0 : links.get(a < b ? a * 65536 + b : b * 65536 + a) || 0);
  const OPEN_EDGES = 2.4 / g;

  const S = new Float32Array(n), EX = new Float32Array(n), EY = new Float32Array(n), EZ = new Float32Array(n), D = new Float32Array(n);
  // The fixtures' height as each cell sees them (weighted by their light), for how walls fall off
  // toward the ceiling line: FH / FW.
  const FH = new Float32Array(n), FW = new Float32Array(n);
  const Y = PLAN_LIGHT.height;
  const X = Float64Array.from({ length: nx }, (_, i) => cx(i)), Z = Float64Array.from({ length: ny }, (_, j) => cy(j));
  // Cells within R of (x, y), optionally only on the side a unit normal N faces.
  const box = (x, y, R, N = null) => [
    Math.max(0, Math.floor((x - (N && N.x > 0.5 ? g : R) - minX) / g)), Math.min(nx - 1, Math.floor((x + (N && N.x < -0.5 ? g : R) - minX) / g)),
    Math.max(0, Math.floor((y - (N && N.y > 0.5 ? g : R) - minY) / g)), Math.min(ny - 1, Math.floor((y + (N && N.y < -0.5 ? g : R) - minY) / g)),
  ];

  // Ceiling fixtures: downward emitters with a cos^cone intensity falloff. Each one lights from its
  // cell's center (at most an eighth of a meter off, lost in the smoothing below), so its footprint
  // is a table per height and beam, shared by every fixture like it.
  const RF = PLAN_LIGHT.reach.fixture, R = Math.floor(RF / g), KW = 2 * R + 1;
  const kernels = new Map();
  const kernel = (dh, cone) => {
    const key = `${dh}|${cone}`;
    let t = kernels.get(key);
    if (t) return t;
    t = new Float32Array(KW * KW * 4);
    for (let b = -R; b <= R; b++) {
      for (let a = -R; a <= R; a++) {
        // From the lit cell to the fixture.
        const dx = -a * g, dy = -b * g, h2 = dx * dx + dy * dy;
        if (h2 > RF * RF) continue;
        const r2 = h2 + dh * dh, r = Math.sqrt(r2), c = dh / r, v = (cone === 2 ? c * c : c) / r2;
        const o = ((b + R) * KW + a + R) * 4;
        t[o] = v;
        t[o + 1] = (v * dx) / r;
        t[o + 2] = (v * dh) / r;
        t[o + 3] = (v * dy) / r;
      }
    }
    kernels.set(key, t);
    return t;
  };
  for (const e of ctx.emitters) {
    const dh = Math.round((e.h - Y) * 20) / 20, own = spaceOf(e.x, e.y);
    if (dh < 0.2 || cell(e.x, e.y) < 0) continue;
    const ie = Math.floor((e.x - minX) / g), je = Math.floor((e.y - minY) / g), t = kernel(dh, e.cone), P = e.power;
    const i0 = Math.max(0, ie - R), i1 = Math.min(nx - 1, ie + R), j0 = Math.max(0, je - R), j1 = Math.min(ny - 1, je + R);
    for (let j = j0; j <= j1; j++) {
      let o = ((j - je + R) * KW + i0 - ie + R) * 4;
      for (let i = i0, k = j * nx + i0; i <= i1; i++, k++, o += 4) {
        if (!t[o]) continue;
        const sp = space[k];
        if (sp < 0 || occ[k] === 2) continue;
        const v = sp === own ? P : pair(own, sp) >= OPEN_EDGES ? P * reaches(e.x, e.y, i, j) : 0;
        if (!v) continue;
        S[k] += v * t[o];
        FW[k] += v * t[o];
        FH[k] += v * t[o] * e.h;
        EX[k] += v * t[o + 1];
        EY[k] += v * t[o + 2];
        EZ[k] += v * t[o + 3];
      }
    }
  }

  // Windows: vertical strips up to PLAN_LIGHT.strip wide, integrated exactly over the glass height.
  // The integrals depend only on the distance from the strip (per sill and head height), so they
  // are tabulated every 2 cm and interpolated.
  const RW = PLAN_LIGHT.reach.window, STEP = 0.02;
  const profiles = new Map();
  const profile = (t0, t1) => {
    const key = `${t0.toFixed(3)}|${t1.toFixed(3)}`;
    let tab = profiles.get(key);
    if (tab) return tab;
    const m = Math.ceil(RW / STEP) + 2;
    tab = new Float32Array(m * 3);
    for (let q = 0; q < m; q++) {
      // Closer than 0.3 m the strip is no longer thin; hold the value there.
      const p = Math.max(q * STEP, 0.3), p2 = p * p, q0 = p2 + t0 * t0, q1 = p2 + t1 * t1;
      tab[q * 3] = t1 / (p * Math.sqrt(q1)) - t0 / (p * Math.sqrt(q0));
      tab[q * 3 + 1] = t1 / (2 * q1) + Math.atan(t1 / p) / (2 * p) - t0 / (2 * q0) - Math.atan(t0 / p) / (2 * p);
      tab[q * 3 + 2] = p / (2 * q0) - p / (2 * q1);
    }
    profiles.set(key, tab);
    return tab;
  };
  for (const win of ctx.windows) {
    const { info, s0, s1, y0, y1, side, weight } = win;
    const { F } = info, ht = info.w.thickness / 2;
    if (s1 - s0 < 0.1 || y1 - y0 < 0.1) continue;
    const N = { x: F.n.x * side, y: F.n.y * side };
    const strips = Math.ceil((s1 - s0) / PLAN_LIGHT.strip), sw = (s1 - s0) / strips;
    const L = PLAN_LIGHT.sky * weight * sunSide(N).sun * sw;
    const tab = profile(y0 - Y, y1 - Y);
    for (let q = 0; q < strips; q++) {
      const s = s0 + (q + 0.5) * sw;
      // The strip at the inner wall face, and a start for rays just inside the room.
      const fx = F.o.x + F.d.x * s + N.x * ht, fy = F.o.y + F.d.y * s + N.y * ht;
      const rx = fx + N.x * 0.7 * g, ry = fy + N.y * 0.7 * g;
      if (cell(rx, ry) < 0) continue;
      const own = spaceOf(fx + N.x * 0.3, fy + N.y * 0.3);
      const [i0, i1, j0, j1] = box(fx, fy, RW, N);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * nx + i, sp = space[k];
          if (sp < 0 || occ[k] === 2) continue;
          const vx = X[i] - fx, vy = Z[j] - fy, f = vx * N.x + vy * N.y;
          if (f <= 0) continue;
          const r2 = vx * vx + vy * vy;
          if (r2 > RW * RW) continue;
          const rho = Math.sqrt(r2), cw = f / rho;
          if (cw < 0.02) continue;
          const v = sp === own ? 1 : pair(own, sp) > 0 ? reaches(rx, ry, i, j) : 0;
          if (!v) continue;
          const u = rho / STEP, n0 = u | 0, w = u - n0, o = n0 * 3, k0 = v * L * cw;
          const sv = k0 * (tab[o] + (tab[o + 3] - tab[o]) * w);
          const eh = k0 * (tab[o + 1] + (tab[o + 4] - tab[o + 1]) * w);
          const ev = k0 * (tab[o + 2] + (tab[o + 5] - tab[o + 2]) * w);
          S[k] += sv;
          D[k] += sv;
          EX[k] -= (eh * vx) / rho;
          EZ[k] -= (eh * vy) / rho;
          EY[k] += ev;
        }
      }
    }
  }

  // A diffusion over the open cells that walls stop: `iterations` passes spread a field about
  // g * sqrt(iterations) meters.
  const open = (k) => space[k] >= 0 && occ[k] < 2;
  let scratch = new Float32Array(n);
  const diffuse = (field, iterations) => {
    let cur = field, next = scratch;
    for (let it = 0; it < iterations; it++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i;
          if (!open(k)) { next[k] = 0; continue; }
          let sum = cur[k], count = 1;
          if (i > 0 && open(k - 1)) { sum += cur[k - 1]; count++; }
          if (i < nx - 1 && open(k + 1)) { sum += cur[k + 1]; count++; }
          if (j > 0 && open(k - nx)) { sum += cur[k - nx]; count++; }
          if (j < ny - 1 && open(k + nx)) { sum += cur[k + nx]; count++; }
          next[k] = sum / count;
        }
      }
      [cur, next] = [next, cur];
    }
    if (cur !== field) {
      field.set(cur);
      scratch = cur;
    }
    return field;
  };
  // Soften the edges of light let through doorways (penumbras the grid cannot resolve).
  for (const f of [S, EX, EY, EZ, D, FH, FW]) diffuse(f, 3);
  // Bounce: the direct light spread locally plus the space's average.
  const cur = diffuse(S.slice(), clamp(Math.round((PLAN_LIGHT.bounce.spread / g) ** 2), 1, 60));
  const spaces = ctx.rooms.length + ctx.generals.length;
  const sum = new Float64Array(spaces + 1), count = new Float64Array(spaces + 1);
  for (let k = 0; k < n; k++) {
    if (!open(k)) continue;
    sum[space[k]] += S[k];
    count[space[k]]++;
  }
  const B = new Float32Array(n);
  // Open ceilings take more: pendants send part of their light up onto the deck.
  const room = [...ctx.rooms, ...ctx.generals].map((sp) => PLAN_LIGHT.bounce.room + (sp.ceiling === 'open' ? PLAN_LIGHT.bounce.uplight : 0));
  for (let k = 0; k < n; k++) if (open(k)) B[k] = PLAN_LIGHT.bounce.local * cur[k] + (room[space[k]] * sum[space[k]]) / count[space[k]];

  // Adaptation, as a photographer exposes each room: every space's light is pulled toward the
  // reference level by `adapt` (in log terms), so sunny rooms stay brighter than windowless ones
  // without washing out. The scale is softened across doorways.
  const { reference, adapt, range } = PLAN_LIGHT.exposure;
  const gain = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    if (!open(k)) continue;
    const avg = (sum[space[k]] / count[space[k]]) * (1 + PLAN_LIGHT.bounce.room) + 1e-3;
    gain[k] = clamp(Math.pow(reference / avg, adapt), range[0], range[1]);
  }
  diffuse(gain, 6);
  for (const f of [S, EX, EY, EZ, D, B]) for (let k = 0; k < n; k++) f[k] *= gain[k];

  // Cells under walls take their open neighbors' light, so surfaces near walls never sample black.
  const inside = new Float32Array(n);
  for (let k = 0; k < n; k++) inside[k] = open(k) ? 1 : 0;
  const fields = [S, EX, EY, EZ, D, B, FH, FW];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (open(k)) continue;
      let m = 0, first = -1;
      const acc = fields.map(() => 0);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj, q = jj * nx + ii;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny || !open(q)) continue;
          fields.forEach((f, c) => { acc[c] += f[q]; });
          if (first < 0) first = q;
          m++;
        }
      }
      if (!m) continue;
      fields.forEach((f, c) => { f[k] = acc[c] / m; });
      inside[k] = 1;
      space[k] = space[first];
    }
  }

  const half = THREE.DataUtils.toHalfFloat;
  const a = new Uint16Array(n * 4), b = new Uint16Array(n * 4);
  for (let k = 0; k < n; k++) {
    a[k * 4] = half(S[k]);
    a[k * 4 + 1] = half(EX[k]);
    a[k * 4 + 2] = half(EY[k]);
    a[k * 4 + 3] = half(EZ[k]);
    b[k * 4] = half(S[k] > 1e-4 ? D[k] / S[k] : 0);
    b[k * 4 + 1] = half(B[k]);
    b[k * 4 + 2] = half(inside[k]);
    // Space ids up to 2048 are exact in half floats; beyond that a rare shared id only loosens the gating.
    b[k * 4 + 3] = half(space[k] % 2048);
  }
  const texture = (data, w = nx, h = ny) => {
    const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
    t.magFilter = t.minFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  };
  const fixture = new Uint16Array(n), wallHeight = half(ctx.settings.wallHeight);
  for (let k = 0; k < n; k++) fixture[k] = FW[k] > 1e-6 ? half(FH[k] / FW[k]) : wallHeight;
  const cover = coverMap(ctx, minX, minY, W, H, (x, y) => fixture[cell(x, y)] ?? wallHeight);
  const maps = [texture(a), texture(b), texture(cover.data, cover.size[0], cover.size[1])];
  return {
    maps,
    cover: { cell: cover.cell, size: cover.size },
    cell: g, size: [nx, ny], origin: { x: minX, y: minY },
    ms: performance.now() - t0,
    /** Space id at plan (x, y), -1 outdoors. */
    spaceAt: (x, y) => {
      const k = cell(x, y);
      return k < 0 || !inside[k] ? -1 : space[k] % 2048;
    },
    /** Diffuse light level at plan (x, y): direct plus bounce, 0 outdoors. */
    levelAt: (x, y) => {
      const k = cell(x, y);
      return k < 0 ? 0 : S[k] + B[k];
    },
    /**
     * The light a viewer at plan (x, y) looking along (dx, dy) sees, like an incident light meter
     * pointed into the view: { level, daylight }, the map's level (as levelAt) and its share from
     * the windows, averaged over a fan of rays ahead, each held at its last open cell once it meets
     * a wall (that wall fills the rest of its direction). Zeros outdoors.
     */
    meter: (x, y, dx, dy) => {
      const k0 = cell(x, y);
      if (k0 < 0 || space[k0] < 0) return { level: 0, daylight: 0 };
      const len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      let level = 0, daylight = 0, count = 0;
      for (const a of METER.fan) {
        const c = Math.cos(a), s = Math.sin(a), rx = ux * c - uy * s, ry = uy * c + ux * s;
        let at = k0, blocked = false, d = 0;
        for (const to of METER.reach) {
          // Half-cell steps up to the next sample, stopping at a wall or the edge of the building.
          for (; !blocked && d < to; d = Math.min(to, d + g / 2)) {
            const k = cell(x + rx * d, y + ry * d);
            if (k < 0 || occ[k] === 2 || space[k] < 0) blocked = true;
          }
          if (!blocked) at = cell(x + rx * to, y + ry * to);
          level += S[at] + B[at];
          daylight += D[at];
          count++;
        }
      }
      return { level: level / count, daylight: daylight / count };
    },
    dispose() {
      for (const t of maps) t.dispose();
    },
  };
}

/**
 * The plan's cover map over the light map's area, finer than the light map so a stool still shades
 * its own patch of floor: every placed item's cover grid (see itemCover) stamped in with its
 * placement, as half floats (cover, lowest covering height above the floor, fixture height, unused);
 * fixtureAt(x, y) returns the fixture height as half-float bits.
 */
function coverMap(ctx, minX, minY, W, H, fixtureAt) {
  const c = Math.max(COVER.texel, Math.sqrt((W * H) / COVER.texels));
  const nx = Math.max(2, Math.ceil(W / c)), ny = Math.max(2, Math.ceil(H / c)), n = nx * ny;
  const C = new Float32Array(n), Y = new Float32Array(n).fill(99);
  for (const { cover: g, x, y, y0, rotation } of ctx.covers) {
    const cos = Math.cos(rotation), sin = Math.sin(rotation);
    // The item's grid corners in plan space bound the cells it can reach.
    let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (const [lx, lz] of [[g.x0, g.z0], [-g.x0, g.z0], [g.x0, -g.z0], [-g.x0, -g.z0]]) {
      const px = x + cos * lx + sin * lz, py = y - sin * lx + cos * lz;
      lo = [Math.min(lo[0], px), Math.min(lo[1], py)];
      hi = [Math.max(hi[0], px), Math.max(hi[1], py)];
    }
    const i0 = Math.max(0, Math.floor((lo[0] - minX) / c)), i1 = Math.min(nx - 1, Math.floor((hi[0] - minX) / c));
    const j0 = Math.max(0, Math.floor((lo[1] - minY) / c)), j1 = Math.min(ny - 1, Math.floor((hi[1] - minY) / c));
    for (let j = j0; j <= j1; j++) {
      const dy = minY + (j + 0.5) * c - y;
      for (let i = i0; i <= i1; i++) {
        const dx = minX + (i + 0.5) * c - x;
        const gi = Math.floor((cos * dx - sin * dy - g.x0) / g.step), gj = Math.floor((sin * dx + cos * dy - g.z0) / g.step);
        if (gi < 0 || gj < 0 || gi >= g.nx || gj >= g.nz) continue;
        const q = gj * g.nx + gi, v = g.cover[q];
        if (v < 0.004) continue;
        const k = j * nx + i;
        if (v > C[k]) C[k] = v;
        if (g.low[q] + y0 < Y[k]) Y[k] = g.low[q] + y0;
      }
    }
  }
  const half = THREE.DataUtils.toHalfFloat, data = new Uint16Array(n * 4);
  const none = half(99);
  for (let j = 0, k = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++, k++) {
      data[k * 4] = C[k] ? half(C[k]) : 0;
      data[k * 4 + 1] = C[k] ? half(Y[k]) : none;
      data[k * 4 + 2] = fixtureAt(minX + (i + 0.5) * c, minY + (j + 0.5) * c);
    }
  }
  return { data, cell: c, size: [nx, ny] };
}

/** The light map uniforms shared by every plan-lit material of a kit, bound to one build at a time. */
function planUniforms(kit) {
  const store = sharedStore(kit);
  if (!store.plan) {
    const tint = (hex) => {
      const c = new THREE.Color(hex);
      return c.multiplyScalar(1 / (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b));
    };
    const { shade, hemi, ibl, colors } = PLAN_LIGHT;
    store.plan = {
      planMapA: { value: null },
      planMapB: { value: null },
      planMapC: { value: null },
      planBox: { value: new THREE.Vector4(0, 0, 1, 1) },
      planCoverBox: { value: new THREE.Vector4(0, 0, 1, 1) },
      planCover: { value: COVER.strength },
      planSize: { value: new THREE.Vector2(1, 1) },
      planShade: { value: new THREE.Vector4(shade[0], shade[1], hemi, ibl) },
      planFixColor: { value: tint(colors.fixture) },
      planDayColor: { value: tint(colors.day) },
      planBounceColor: { value: tint(colors.bounce) },
      planBounceTilt: { value: PLAN_LIGHT.bounce.tilt },
      planEnvRef: { value: 1 },
      planOffset: { value: 0.22 },
      planRectSpace: { value: new Float32Array(1).fill(-2) },
    };
  }
  return store.plan;
}

/**
 * Point the shared uniforms U at a build's light map; probe is where the environment is captured.
 * With no light map, plan-lit materials fall back to the uniform fill (no texel reads as indoors).
 */
function usePlanLight(U, light, probe, rectSpace) {
  if (!light) {
    U.planMapA.value = U.planMapB.value = U.planMapC.value = null;
    U.planRectSpace.value = new Float32Array(1).fill(-2);
    return;
  }
  U.planMapA.value = light.maps[0];
  U.planMapB.value = light.maps[1];
  U.planMapC.value = light.maps[2];
  const [nx, ny] = light.size;
  U.planBox.value.set(light.origin.x, light.origin.y, 1 / (nx * light.cell), 1 / (ny * light.cell));
  const { cell, size } = light.cover;
  U.planCoverBox.value.set(light.origin.x, light.origin.y, 1 / (size[0] * cell), 1 / (size[1] * cell));
  U.planSize.value.set(nx, ny);
  // Sample wall faces a cell and a bit in front of them, clear of the wall's own cells.
  U.planOffset.value = 1.1 * light.cell;
  U.planEnvRef.value = Math.max(0.3, light.levelAt(probe.x, probe.z));
  U.planRectSpace.value = rectSpace;
}

// GLSL for the light map, spliced into standard and physical materials by planPatch().
const PLAN_PARS = /* glsl */`
uniform sampler2D planMapA;
uniform sampler2D planMapB;
uniform sampler2D planMapC;
uniform vec4 planBox;
uniform vec4 planCoverBox;
uniform float planCover;
uniform vec2 planSize;
uniform vec4 planShade;
uniform vec3 planFixColor;
uniform vec3 planDayColor;
uniform vec3 planBounceColor;
uniform float planBounceTilt;
uniform float planEnvRef;
uniform float planOffset;
#if NUM_RECT_AREA_LIGHTS > 0
uniform float planRectSpace[ NUM_RECT_AREA_LIGHTS ];
#endif
varying vec3 vPlanWorld;`;

// Window area lights add their reflection only (the light map carries their diffuse light), also on
// clearcoats, so polished floors mirror the windows.
const PLAN_RECT = /* glsl */`
#if NUM_RECT_AREA_LIGHTS > 0
void planRectSpecular( const in RectAreaLight light, const in vec3 position, const in vec3 normal, const in vec3 viewDir, const in vec3 clearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  vec3 rectCoords[ 4 ];
  rectCoords[ 0 ] = light.position + light.halfWidth - light.halfHeight;
  rectCoords[ 1 ] = light.position - light.halfWidth - light.halfHeight;
  rectCoords[ 2 ] = light.position - light.halfWidth + light.halfHeight;
  rectCoords[ 3 ] = light.position + light.halfWidth + light.halfHeight;
  vec2 uv = LTC_Uv( normal, viewDir, material.roughness );
  vec4 t1 = texture2D( ltc_1, uv );
  vec4 t2 = texture2D( ltc_2, uv );
  mat3 mInv = mat3( vec3( t1.x, 0, t1.y ), vec3( 0, 1, 0 ), vec3( t1.z, 0, t1.w ) );
  vec3 fresnel = material.specularColor * t2.x + ( vec3( 1.0 ) - material.specularColor ) * t2.y;
  reflectedLight.directSpecular += light.color * fresnel * LTC_Evaluate( normal, viewDir, position, mInv, rectCoords );
  #ifdef USE_CLEARCOAT
    uv = LTC_Uv( clearcoatNormal, viewDir, material.clearcoatRoughness );
    t1 = texture2D( ltc_1, uv );
    t2 = texture2D( ltc_2, uv );
    mInv = mat3( vec3( t1.x, 0, t1.y ), vec3( 0, 1, 0 ), vec3( t1.z, 0, t1.w ) );
    vec3 ccFresnel = material.clearcoatF0 * t2.x + ( material.clearcoatF90 - material.clearcoatF0 ) * t2.y;
    clearcoatSpecularDirect += light.color * ccFresnel * LTC_Evaluate( clearcoatNormal, viewDir, position, mInv, rectCoords );
  #endif
}
#endif`;

// Before the lights: where this surface samples the map (a little in front of it), and its space.
const PLAN_SAMPLE = /* glsl */`
  vec3 planN = inverseTransformDirection( normal, viewMatrix );
  vec2 planUV = ( vPlanWorld.xz + planN.xz * planOffset - planBox.xy ) * planBox.zw;
  vec4 planA = texture2D( planMapA, planUV );
  vec4 planB = texture2D( planMapB, planUV );
  vec2 planEdge = step( vec2( 0.0 ), planUV ) * step( planUV, vec2( 1.0 ) );
  float planIn = clamp( planB.z, 0.0, 1.0 ) * planEdge.x * planEdge.y;
  float planSpace = planIn > 0.0 ? texture2D( planMapB, ( floor( planUV * planSize ) + 0.5 ) / planSize ).w : - 1.0;
  // Furniture over this point takes part of the light, unless this surface is the furniture's own top.
  vec3 planC = texture2D( planMapC, ( vPlanWorld.xz + planN.xz * planOffset - planCoverBox.xy ) * planCoverBox.zw ).xyz;
  float planShadow = 1.0 - planCover * planIn * clamp( planC.x, 0.0, 1.0 ) * ( 1.0 - smoothstep( planC.y - 0.1, planC.y - 0.03, vPlanWorld.y ) );`;

// After the lights: the map's diffuse light in place of the uniform fill, indoors. The map holds the
// light at PLAN_LIGHT.height; on walls and other upright faces the fixtures' direct light follows
// the surface's height instead. A downward emitter rho meters out and h above a point lights an upright
// face there in proportion to h * rho / (rho^2 + h^2)^2, so walls fade toward the ceiling line and,
// less, toward the floor. rho comes from the map's horizontal to vertical light; fixtures on either
// side of a point cancel in it, so it is held to at least 1.5 m, about where the fixtures lighting a
// wall really are once those along it count too.
const PLAN_IRRADIANCE = /* glsl */`
#if defined( RE_IndirectDiffuse )
  float planH0 = max( planC.z - ${PLAN_LIGHT.height.toFixed(2)}, 0.2 );
  float planRho = clamp( planH0 * length( planA.yw ) / max( planA.z, 1e-4 ), 1.5, 6.0 ) + planOffset;
  float planDrop = clamp( planC.z - vPlanWorld.y, 0.0, planC.z );
  float planRise = ( planRho * planRho + planH0 * planH0 ) / ( planRho * planRho + planDrop * planDrop );
  float planWall = mix( clamp( planDrop / planH0 * planRise * planRise, 0.0, 1.5 ), 1.0, clamp( planB.x, 0.0, 1.0 ) );
  float planSide = planShade.x * planA.x + planShade.y * dot( planN.xz, planA.yw );
  float planE = max( 0.0, planSide * mix( 1.0, planWall, 1.0 - abs( planN.y ) ) + planShade.y * planN.y * planA.z );
  vec3 planIrr = planE * mix( planFixColor, planDayColor, clamp( planB.x, 0.0, 1.0 ) )
    + planB.y * ( 1.0 + planBounceTilt * planN.y ) * planBounceColor;
  irradiance = mix( irradiance, ( planIrr + irradiance * planShade.z ) * planShadow, planIn );
#endif`;

// After the environment maps: image based light scaled to this spot's light level against the probe's.
const PLAN_ENV = /* glsl */`
  float planEnv = mix( 1.0, clamp( ( planA.x + planB.y ) / planEnvRef, 0.08, 1.6 ), planIn ) * planShadow;
#if defined( RE_IndirectDiffuse )
  iblIrradiance *= planEnv * mix( 1.0, planShade.w, planIn );
#endif
#if defined( RE_IndirectSpecular )
  radiance *= planEnv;
  clearcoatRadiance *= planEnv;
#endif`;

const RECT_CALL = 'RE_Direct_RectArea( rectAreaLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
const RECT_GATED = 'if ( abs( planRectSpace[ i ] - planSpace ) < 0.5 ) planRectSpecular( rectAreaLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';

function planPatch(shader, U) {
  Object.assign(shader.uniforms, U);
  const begin = THREE.ShaderChunk.lights_fragment_begin;
  const gated = begin.includes(RECT_CALL) ? begin.replace(RECT_CALL, RECT_GATED) : begin;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vPlanWorld;')
    .replace('#include <project_vertex>', `#include <project_vertex>
  vec4 planWorld = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    planWorld = instanceMatrix * planWorld;
  #endif
  vPlanWorld = ( modelMatrix * planWorld ).xyz;`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${PLAN_PARS}`)
    .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${PLAN_RECT}`)
    .replace('#include <lights_fragment_begin>', `${PLAN_SAMPLE}\n${gated}\n${PLAN_IRRADIANCE}`)
    .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>\n${PLAN_ENV}`);
}

/**
 * The plan-lit twin of an interior material: same look, lit by the light map. Made once per kit and
 * source material; outdoor and unlit materials stay as they are. `planSource` names the original.
 */
function planMaterial(kit, m) {
  if (!m?.isMeshStandardMaterial || m.userData.outdoor || m.planSource) return m;
  const store = sharedStore(kit);
  let p = store.lit.get(m);
  if (!p) {
    p = m.clone();
    Object.defineProperty(p, 'planSource', { value: m });
    const U = planUniforms(kit);
    const base = m.onBeforeCompile, key = m.customProgramCacheKey;
    p.onBeforeCompile = function (shader, renderer) {
      base.call(this, shader, renderer);
      planPatch(shader, U);
    };
    p.customProgramCacheKey = function () {
      return `${key.call(this)}|plan-light`;
    };
    store.lit.set(m, p);
    store.owned.materials.push(p);
  }
  p.envMapIntensity = m.envMapIntensity;
  return p;
}

// ---- Items ---------------------------------------------------------------------

/**
 * Items are built once per distinct (type, size, color) as a template of mesh parts, then stamped
 * into the buckets with each instance's placement. Templates with lights, lines or skinned meshes
 * are rebuilt per instance so those objects stay unique.
 */
function buildItems(ctx) {
  const templates = new Map();
  const covers = sharedStore(ctx.kit).covers;
  const place = new THREE.Matrix4();
  for (const item of ctx.plan.items) {
    const def = getItem(item.type);
    const dims = itemSize(item);
    const key = `${item.type}|${dims.w}|${dims.d}|${dims.h}|${item.color ?? ''}`;
    let parts = templates.get(key);
    if (parts === undefined) templates.set(key, (parts = itemTemplate(ctx, buildItem(ctx, def, dims, item))));
    const rotation = (-normDeg(item.rotation || 0) * Math.PI) / 180;
    place.compose(_v.set(item.x, item.elevation ?? 0, item.y), _q.setFromAxisAngle(_y, rotation), _s.set(1, 1, 1));
    ctx.items.at(item.x, item.y);
    // What the item shades below it, once per template (see itemCover); rugs and the like shade nothing.
    const blocking = def.blocking !== false;
    let cover = null;
    try {
      // Past the detail budget items are plain blocks, so a plan with thousands of items stays quick.
      if (ctx.itemVerts > MAX_ITEM_VERTS) {
        itemBlock(ctx, item, dims);
        cover = blocking && cachedCover(covers, `block|${dims.w}|${dims.d}|${dims.h}`, () => itemCover(blockTris(dims), dims));
      } else if (parts) {
        stampParts(ctx, parts, place);
        cover = blocking && cachedCover(covers, key, () => itemCover(coverTris(parts), dims));
      } else {
        const obj = buildItem(ctx, def, dims, item);
        cover = blocking && cachedCover(covers, key, () => itemCover(coverTris(objectParts(ctx, obj)), dims));
        collectObject(ctx, obj, place);
      }
    } catch (err) {
      console.warn(`Could not place item "${item.type}"`, err);
    }
    if (!blocking) continue;
    if (cover) ctx.covers.push({ cover, x: item.x, y: item.y, y0: item.elevation ?? 0, rotation });
    ctx.obstacles.push({ corners: itemCorners(item, dims) });
    const shadow = def.contactShadow ?? true;
    if ((item.elevation ?? 0) < 0.05 && shadow) blobShadow(ctx, item, dims, shadow === 'round');
  }
}

/** A plain box over an item's footprint. */
function itemBlock(ctx, item, dims) {
  const r = (normDeg(item.rotation || 0) * Math.PI) / 180;
  const F = frameOf({ x: item.x, y: item.y }, { x: Math.cos(r), y: Math.sin(r) });
  const y0 = item.elevation ?? 0;
  box(F, noBottom(ctx.items.get(ctx.kit.mat.plastic, false)), -dims.w / 2, dims.w / 2, -dims.d / 2, dims.d / 2, y0, y0 + dims.h);
}

/**
 * Soft contact shadow under an item's footprint: a 9-slice of the falloff texture, or for round
 * items an ellipse inscribed in the footprint that fades out just past its edge.
 */
function blobShadow(ctx, item, dims, round) {
  const r = (normDeg(item.rotation || 0) * Math.PI) / 180;
  const F = frameOf({ x: item.x, y: item.y }, { x: Math.cos(r), y: Math.sin(r) });
  // The soft margin widens with the item's height (a taller top throws a wider penumbra).
  const m = clamp(0.06 + 0.06 * Math.min(dims.w, dims.d) + 0.12 * Math.min(dims.h, 1), 0.12, 0.28);
  const inset = Math.min(0.08, dims.w / 4, dims.d / 4);
  const b = ctx.fx.at(item.x, item.y).get(ctx.mats.get('blob'), false, false);
  const P = (s, u) => [F.o.x + F.d.x * s + F.n.x * u, 0.003, F.o.y + F.d.y * s + F.n.y * u];
  if (round) {
    const n = 32;
    const ring = (k, grow) => P(Math.cos((k / n) * Math.PI * 2) * (dims.w / 2 + grow), Math.sin((k / n) * Math.PI * 2) * (dims.d / 2 + grow));
    const center = P(0, 0);
    // uv (1, 1) is full shadow and u falls to 0 across the rim; the inner quads collapse to the center.
    for (let k = 0; k < n; k++) {
      quad(b, center, ring(k, -inset), ring(k + 1, -inset), center, UP, 1, 1, 1, 1);
      quad(b, ring(k, -inset), ring(k, m), ring(k + 1, m), ring(k + 1, -inset), UP, 1, 1, 0, 1);
    }
    return;
  }
  const xs = [-dims.w / 2 - m, -dims.w / 2 + inset, dims.w / 2 - inset, dims.w / 2 + m];
  const ys = [-dims.d / 2 - m, -dims.d / 2 + inset, dims.d / 2 - inset, dims.d / 2 + m];
  const t = [0, 1, 1, 0];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) quad(b, P(xs[i], ys[j]), P(xs[i + 1], ys[j]), P(xs[i + 1], ys[j + 1]), P(xs[i], ys[j + 1]), UP, t[i], t[j], t[i + 1], t[j + 1]);
  }
}

/** An item's cover grid from the kit's cache (an item's geometry depends only on its key), or make(). */
function cachedCover(covers, key, make) {
  if (!covers.has(key)) {
    // A long session of resizing items would otherwise keep every size it ever built.
    if (covers.size >= COVER.cache) covers.clear();
    covers.set(key, make());
  }
  return covers.get(key);
}

/** Mesh parts of an item that is rebuilt per instance (see collectObject), for its cover. */
function objectParts(ctx, obj) {
  obj.updateMatrixWorld(true);
  const parts = [];
  obj.traverseVisible((o) => {
    if (mergeable(o)) parts.push(...meshParts(ctx, o));
  });
  return parts;
}

/**
 * The roughly horizontal triangles of an item's parts between COVER.min and COVER.max above its
 * base, in item space, as [ax, az, bx, bz, cx, cz, y] runs: its tops, seats, shelves and undersides.
 */
function coverTris(parts) {
  const out = [];
  for (const p of parts) {
    const pos = p.g.attributes.position, idx = p.g.index?.array;
    const P = !pos.isInterleavedBufferAttribute && !pos.normalized && pos.itemSize === 3 ? pos.array : null;
    const m = p.local.elements;
    const total = idx ? idx.length : pos.count;
    const start = p.range ? p.range.start : 0, end = p.range ? Math.min(total, p.range.start + p.range.count) : total;
    const v = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let t = start; t + 2 < end; t += 3) {
      for (let c = 0; c < 3; c++) {
        const i = idx ? idx[t + c] : t + c;
        const x = P ? P[i * 3] : pos.getX(i), y = P ? P[i * 3 + 1] : pos.getY(i), z = P ? P[i * 3 + 2] : pos.getZ(i);
        v[c * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
        v[c * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        v[c * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      }
      const ux = v[3] - v[0], uy = v[4] - v[1], uz = v[5] - v[2], wx = v[6] - v[0], wy = v[7] - v[1], wz = v[8] - v[2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const area = Math.hypot(nx, ny, nz);
      if (area < 1e-7 || Math.abs(ny) < 0.7 * area) continue;
      const y = (v[1] + v[4] + v[7]) / 3;
      if (y < COVER.min || y > COVER.max) continue;
      out.push(v[0], v[2], v[3], v[5], v[6], v[8], y);
    }
  }
  return out;
}

/** The top of a plain block (see itemBlock), in coverTris' form. */
function blockTris(dims) {
  const x = dims.w / 2, z = dims.d / 2, y = dims.h;
  return y < COVER.min || y > COVER.max ? [] : [-x, -z, x, -z, x, z, y, -x, -z, x, z, -x, z, y];
}

/**
 * An item's cover grid, in item space: how much of the overhead light its horizontal surfaces take
 * from whatever is under them, and the height of the lowest of them, so the light map can shade the
 * floor under a table, the chair tucked beneath it and its lower shelf, but not the table top. The
 * surfaces are rasterized per height band, each softened by a penumbra that grows with its height
 * (so a small stool seat ends up blocking less than a broad table top, as it subtends less of the
 * ceiling); each cell takes the lowest surface of the bands that reach it. Null when nothing in the
 * item covers anything.
 */
function itemCover(tris, dims) {
  if (!tris.length) return null;
  let top = 0;
  for (let t = 6; t < tris.length; t += 7) top = Math.max(top, tris[t]);
  const reach = (h) => clamp(COVER.penumbra * h, COVER.soft[0], COVER.soft[1]);
  const pad = reach(top) + COVER.step;
  const step = Math.max(COVER.step, Math.sqrt(((dims.w + 2 * pad) * (dims.d + 2 * pad)) / COVER.cells));
  const nx = Math.ceil((dims.w + 2 * pad) / step), nz = Math.ceil((dims.d + 2 * pad) / step), n = nx * nz;
  const x0 = -dims.w / 2 - pad, z0 = -dims.d / 2 - pad;
  const bands = COVER.bands.map(() => null).concat(null);
  for (let t = 0; t < tris.length; t += 7) {
    const ax = tris[t], az = tris[t + 1], bx = tris[t + 2], bz = tris[t + 3], cx = tris[t + 4], cz = tris[t + 5], y = tris[t + 6];
    const d = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    if (Math.abs(d) < 1e-9) continue;
    const at = COVER.bands.findIndex((edge) => y < edge);
    const band = (bands[at < 0 ? COVER.bands.length : at] ||= { hard: new Float32Array(n), sum: 0, count: 0, low: Infinity });
    band.low = Math.min(band.low, y);
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - x0) / step - 0.5)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - x0) / step - 0.5));
    const j0 = Math.max(0, Math.ceil((Math.min(az, bz, cz) - z0) / step - 0.5)), j1 = Math.min(nz - 1, Math.floor((Math.max(az, bz, cz) - z0) / step - 0.5));
    for (let j = j0; j <= j1; j++) {
      const pz = z0 + (j + 0.5) * step;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * step;
        // Barycentric weights, the same sign as d inside the triangle.
        const w0 = ((bx - px) * (cz - pz) - (bz - pz) * (cx - px)) / d, w1 = ((cx - px) * (az - pz) - (cz - pz) * (ax - px)) / d;
        if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
        const k = j * nx + i;
        if (!band.hard[k]) {
          band.hard[k] = 1;
          band.sum += y;
          band.count++;
        }
      }
    }
  }
  // Two box passes make a tent-shaped penumbra about `reach` wide either side of each edge.
  const cover = new Float32Array(n), low = new Float32Array(n).fill(Infinity);
  let any = false;
  for (const band of bands) {
    if (!band?.count) continue;
    const h = Math.max(1, Math.round(reach(band.sum / band.count) / 2 / step));
    const soft = boxBlur(boxBlur(band.hard, nx, nz, h), nx, nz, h);
    for (let k = 0; k < n; k++) {
      if (soft[k] < 0.004) continue;
      if (soft[k] > cover[k]) cover[k] = soft[k];
      if (band.low < low[k]) low[k] = band.low;
    }
    any = true;
  }
  return any ? { x0, z0, step, nx, nz, cover, low } : null;
}

/** Separable box blur of an nx by nz grid, half-width h cells, edges padded with zero (running sums). */
function boxBlur(src, nx, nz, h) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length), k = 1 / (2 * h + 1);
  for (let j = 0; j < nz; j++) {
    const row = j * nx;
    let s = 0;
    for (let q = 0; q < Math.min(h, nx); q++) s += src[row + q];
    for (let i = 0; i < nx; i++) {
      if (i + h < nx) s += src[row + i + h];
      if (i - h - 1 >= 0) s -= src[row + i - h - 1];
      tmp[row + i] = s * k;
    }
  }
  for (let i = 0; i < nx; i++) {
    let s = 0;
    for (let q = 0; q < Math.min(h, nz); q++) s += tmp[q * nx + i];
    for (let j = 0; j < nz; j++) {
      if (j + h < nz) s += tmp[(j + h) * nx + i];
      if (j - h - 1 >= 0) s -= tmp[(j - h - 1) * nx + i];
      out[j * nx + i] = s * k;
    }
  }
  return out;
}

function buildItem(ctx, def, dims, item) {
  try {
    const obj = def.build(ctx.kit, { ...dims, color: item.color });
    if (obj?.isObject3D) return obj;
    throw new Error('build() did not return an Object3D');
  } catch (err) {
    console.warn(`Could not build item "${item.type}", using a placeholder`, err);
    const g = ctx.kit.group();
    ctx.kit.block(g, ctx.kit.mat.plastic, -dims.w / 2, dims.w / 2, 0, dims.h, -dims.d / 2, dims.d / 2);
    return g;
  }
}

const mergeable = (o) => o.isMesh && !o.isSkinnedMesh && !o.morphTargetInfluences && o.geometry?.attributes?.position;

/** Mesh parts of an item built at the origin, or null when it holds objects that cannot be merged. */
function itemTemplate(ctx, obj) {
  obj.updateMatrixWorld(true);
  const parts = [];
  let plain = true;
  obj.traverseVisible((o) => {
    if (mergeable(o)) parts.push(...meshParts(ctx, o));
    else if (o.isLight || o.isMesh || o.isLine || o.isPoints || o.isSprite) plain = false;
  });
  return plain ? parts : null;
}

/** One part per material (group) and instance: geometry, item-local matrix and shadow flags. */
function meshParts(ctx, mesh) {
  const g = mesh.geometry;
  if (!g.boundingSphere) g.computeBoundingSphere();
  if (!g.attributes.normal) g.computeVertexNormals();
  const small = g.boundingSphere.radius * mesh.matrixWorld.getMaxScaleOnAxis() < 0.03;
  // Low quality merges harder: items skip sun shadows (blob shadows still ground them).
  const flags = (mat) => (ctx.low ? { cast: false, receive: true } : { cast: mesh.castShadow && !mat.transparent && !small, receive: mesh.receiveShadow });
  const mats = Array.isArray(mesh.material) ? mesh.material : null;
  const locals = [];
  if (mesh.isInstancedMesh) {
    for (let n = 0; n < mesh.count; n++) {
      const m = new THREE.Matrix4();
      mesh.getMatrixAt(n, m);
      locals.push(m.premultiply(mesh.matrixWorld));
    }
  } else {
    locals.push(mesh.matrixWorld.clone());
  }
  const parts = [];
  for (const local of locals) {
    if (!mats) parts.push({ g, local, mat: mesh.material, range: null, ...flags(mesh.material) });
    else if (!g.groups.length) parts.push({ g, local, mat: mats[0], range: null, ...flags(mats[0]) });
    else for (const grp of g.groups) if (mats[grp.materialIndex]) parts.push({ g, local, mat: mats[grp.materialIndex], range: grp, ...flags(mats[grp.materialIndex]) });
  }
  return parts.filter((p) => p.mat);
}

const _w = new THREE.Matrix4();

function stampParts(ctx, parts, place) {
  for (const p of parts) {
    ctx.itemVerts += p.g.attributes.position.count;
    const tint = tintedMaterial(ctx, p.mat);
    const b = ctx.items.get(tint || p.mat, p.cast, p.receive);
    const from = b.count;
    appendGeometry(b, p.g, _w.multiplyMatrices(place, p.local), p.range);
    if (tint) (b.tints ||= []).push(from, b.count, p.mat.color);
  }
}

const MAP_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'envMap', 'lightMap', 'bumpMap', 'displacementMap'];

/**
 * Plain opaque standard materials that differ only in color share one vertex-colored material, so
 * a furnished floor needs a draw call per finish rather than per paint color.
 */
function tintedMaterial(ctx, m) {
  let shared = ctx.tints.get(m.uuid);
  if (shared !== undefined) return shared;
  shared = null;
  const plain = m.type === 'MeshStandardMaterial' && !m.transparent && !m.vertexColors && m.opacity === 1 && !m.alphaTest
    && !m.polygonOffset && !m.wireframe && m.depthWrite && !MAP_SLOTS.some((k) => m[k]);
  if (plain) {
    const sig = [m.roughness, m.metalness, m.emissive.getHex(), m.emissiveIntensity, m.envMapIntensity, m.side, m.flatShading].join('|');
    shared = ctx.tints.get(sig);
    if (!shared) {
      shared = m.clone();
      shared.vertexColors = true;
      shared.color.set('#ffffff');
      sharedStore(ctx.kit).owned.materials.push(shared);
      ctx.tints.set(sig, shared);
    }
  }
  ctx.tints.set(m.uuid, shared);
  return shared;
}

/** Per-instance path for items with lights, lines or skinned meshes: merge the meshes, keep the rest. */
function collectObject(ctx, obj, place) {
  obj.updateMatrixWorld(true);
  const keep = [];
  const meshes = [];
  obj.traverseVisible((o) => {
    if (mergeable(o)) meshes.push(o);
    else if (o.isLight) { if (ctx.lights++ < MAX_ITEM_LIGHTS) keep.push(o); }
    else if (o.isMesh || o.isLine || o.isPoints || o.isSprite) keep.push(o);
  });
  for (const m of meshes) stampParts(ctx, meshParts(ctx, m), place);
  const holder = new THREE.Group();
  holder.matrixAutoUpdate = false;
  holder.matrix.copy(place);
  for (const o of keep) {
    holder.add(o.removeFromParent());
    o.matrixAutoUpdate = false;
    o.matrix.copy(o.matrixWorld);
  }
  if (keep.length) ctx.loose.push(holder);
}

// ---- Exterior ---------------------------------------------------------------------

function buildExterior(ctx, group) {
  const kind = ctx.settings.exterior;
  const b = ctx.bounds;
  const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2;
  const size = Math.max(b.maxX - b.minX, b.maxY - b.minY, 10);
  const R = clamp(size * 3, 160, 900);
  group.add(skyDome(ctx, cx, cz, R * 1.12, kind));
  group.add(groundDisc(ctx, cx, cz, R + 6, kind));
  if (kind === 'city') {
    group.add(skylineRing(ctx, cx, cz, R, 'skyline-city'));
    cityBlocks(ctx, b, R);
    cityStreets(ctx, b);
    streetTrees(ctx, b);
  } else if (kind === 'campus') {
    group.add(skylineRing(ctx, cx, cz, R, 'skyline-campus'));
    campusGrounds(ctx, b, R);
  }
  group.userData.horizon = R * 1.12;
}

/**
 * Sky dome. Its vertex colors hold the plain horizon to zenith gradient (photo.js reads them to
 * build its own sky); the shader lifts them to daylight strength and adds the bright, warm haze
 * along the horizon toward the sun and a soft glow around it.
 */
function skyDome(ctx, cx, cz, radius, kind) {
  const g = new THREE.SphereGeometry(radius, 48, 24);
  const zenith = new THREE.Color(kind === 'none' ? '#d3dce2' : SKY.zenith);
  const horizon = new THREE.Color(kind === 'none' ? '#eceff0' : SKY.horizon);
  const pos = g.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    c.copy(horizon).lerp(zenith, Math.pow(clamp(pos.getY(i) / radius, 0, 1), 0.55));
    colors.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  ctx.owned.geometries.push(g);
  const mesh = new THREE.Mesh(g, ctx.mats.get('sky'));
  mesh.position.set(cx, 0, cz);
  mesh.renderOrder = -1;
  mesh.name = 'sky';
  return mesh;
}

/** The dome's shader: vertex colors at daylight strength, the warm horizon toward the sun and its glow. */
function skyMaterial() {
  return new THREE.ShaderMaterial({
    name: 'sky',
    vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { sunDir: { value: SUN_DIR.clone() }, scale: { value: SKY_SCALE } },
    vertexShader: /* glsl */`
      varying vec3 vSkyDir;
      varying vec3 vSkyColor;
      void main() {
        vSkyDir = position;
        vSkyColor = color;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 sunDir;
      uniform float scale;
      varying vec3 vSkyDir;
      varying vec3 vSkyColor;
      void main() {
        vec3 d = normalize( vSkyDir );
        float mu = max( dot( d, sunDir ), 0.0 );
        float low = 1.0 - clamp( d.y, 0.0, 1.0 );
        vec3 c = vSkyColor * scale * ( 1.0 + 0.25 * pow( low, 8.0 ) );
        c += vec3( 1.0, 0.92, 0.8 ) * ( 1.1 * pow( mu, 5.0 ) * pow( low, 3.0 ) + 1.4 * pow( mu, 40.0 ) );
        gl_FragColor = vec4( c, 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

function groundDisc(ctx, cx, cz, radius, kind) {
  const g = new THREE.CircleGeometry(radius, 96);
  g.rotateX(-Math.PI / 2);
  // City paving is the kit's concrete, whose maps repeat every floorMeters; grass repeats in meters.
  const k = kind === 'city' ? 1 / ctx.kit.floorMeters('concrete') : 1;
  const pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + cx) * k, -(pos.getZ(i) + cz) * k);
  const mat = ctx.mats.get(kind === 'city' ? 'paving' : kind === 'campus' ? 'grass' : 'neutral');
  Object.assign(mat, { polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 });
  ctx.owned.geometries.push(g);
  const mesh = new THREE.Mesh(g, mat);
  mesh.position.set(cx, GROUND_Y, cz);
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  return mesh;
}

/**
 * Distant skyline on a ring, unlit like the sky and lifted by the same SKY_SCALE (photo.js lights
 * unlit backdrops at that scale too, so both agree).
 */
function skylineRing(ctx, cx, cz, R, key) {
  const h = R * SKY_RATIO;
  const g = new THREE.CylinderGeometry(R, R, h, 128, 1, true);
  ctx.owned.geometries.push(g);
  const mesh = new THREE.Mesh(g, ctx.mats.get(key));
  mesh.position.set(cx, h / 2 - 1.5, cz);
  mesh.name = 'skyline';
  return mesh;
}

function skylineMaterial(owned, key) {
  // Blended edges keep the hazy silhouettes soft; depth is still written, so photo.js keeps the ring.
  const mat = new THREE.MeshBasicMaterial({ map: acquireTexture(owned, key), side: THREE.BackSide, transparent: true, alphaTest: 0.02, fog: false });
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `outgoingLight *= ${SKY_SCALE.toFixed(1)};\n#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'skyline-daylight';
  return mat;
}

/** Place footprints in a ring around the building without overlaps. */
function scatter(r, cx, cz, near, far, count, size, gap) {
  const placed = [];
  for (let n = 0; placed.length < count && n < count * 40; n++) {
    const a = r() * Math.PI * 2, dist = near + r() * (far - near);
    const s = size(r, dist);
    const p = { x: cx + Math.cos(a) * dist, y: cz + Math.sin(a) * dist, ...s };
    const ext = Math.hypot(p.w, p.d) / 2;
    if (placed.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < ext + Math.hypot(q.w, q.d) / 2 + gap)) continue;
    placed.push(p);
  }
  return placed;
}

function massing(ctx, list, facade) {
  const B = ctx.ext;
  const side = B.get(facade, false, true), roof = B.get(ctx.mats.roof, false, true);
  for (const m of list) {
    const F = frameOf({ x: m.x, y: m.y }, { x: Math.cos(m.rot), y: Math.sin(m.rot) });
    box(F, { pu: side, nu: side, s0: side, s1: side, top: roof }, -m.w / 2, m.w / 2, -m.d / 2, m.d / 2, GROUND_Y, m.h);
  }
}

function cityBlocks(ctx, b, R) {
  const r = rng(4242);
  const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2;
  const near = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2 + 34;
  const far = Math.max(near + 60, Math.min(R * 0.72, near + 150));
  const blocks = scatter(r, cx, cz, near, far, ctx.low ? 12 : 26, (rr, dist) => ({
    w: 16 + rr() * 22, d: 14 + rr() * 18, h: 10 + rr() * (dist < near + 40 ? 22 : 55), rot: Math.round(rr() * 3) * 0.12 - 0.12,
  }), 10);
  massing(ctx, blocks, ctx.mats.get('facadeGlass'));
}

/** A street ring around the block with a dashed center line. */
function cityStreets(ctx, b) {
  const asphalt = ctx.ext.get(ctx.mats.get('asphalt'), false, true);
  const paint = ctx.ext.get(ctx.mats.get('stripe'), false, true);
  const gap = 13, width = 10, y = GROUND_Y + 0.015;
  const x0 = b.minX - gap - width, x1 = b.maxX + gap + width, z0 = b.minY - gap - width, z1 = b.maxY + gap + width;
  const rect = (bucket, ax, az, bx, bz, yy) => quad(bucket, [ax, yy, az], [bx, yy, az], [bx, yy, bz], [ax, yy, bz], UP, ax, -az, bx, -bz);
  rect(asphalt, x0, z0, x1, z0 + width, y);
  rect(asphalt, x0, z1 - width, x1, z1, y);
  rect(asphalt, x0, z0 + width, x0 + width, z1 - width, y);
  rect(asphalt, x1 - width, z0 + width, x1, z1 - width, y);
  const dashes = (ax, az, bx, bz) => {
    const len = Math.hypot(bx - ax, bz - az), dx = (bx - ax) / len, dz = (bz - az) / len;
    for (let s = 1.5; s + 3 < len; s += Math.max(7.5, len / 400)) {
      const p = [ax + dx * s, az + dz * s], q = [ax + dx * (s + 3), az + dz * (s + 3)];
      const hx = -dz * 0.075, hz = dx * 0.075;
      quad(paint, [p[0] - hx, y, p[1] - hz], [q[0] - hx, y, q[1] - hz], [q[0] + hx, y, q[1] + hz], [p[0] + hx, y, p[1] + hz], UP, 0, 0, 1, 1);
    }
  };
  const h = width / 2;
  dashes(x0 + width, z0 + h, x1 - width, z0 + h);
  dashes(x0 + width, z1 - h, x1 - width, z1 - h);
  dashes(x0 + h, z0 + width, x0 + h, z1 - width);
  dashes(x1 - h, z0 + width, x1 - h, z1 - width);
}

function streetTrees(ctx, b) {
  const r = rng(77);
  const off = 9;
  const minX = b.minX - off, maxX = b.maxX + off, minY = b.minY - off, maxY = b.maxY + off;
  const step = ctx.low ? 14 : 9;
  const edges = [[minX, minY, maxX, minY], [maxX, minY, maxX, maxY], [maxX, maxY, minX, maxY], [minX, maxY, minX, minY]];
  for (const [x0, y0, x1, y1] of edges) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = clamp(Math.round(len / step), 1, 60);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      tree(ctx, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 0.85 + r() * 0.3, r);
    }
  }
}

function campusGrounds(ctx, b, R) {
  const r = rng(909);
  const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2;
  const near = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2;
  const apron = ctx.ext.get(ctx.mats.get('paving'), false, true);
  const y = GROUND_Y + 0.02, p = 4, k = 1 / ctx.kit.floorMeters('concrete');
  quad(apron, [b.minX - p, y, b.minY - p], [b.maxX + p, y, b.minY - p], [b.maxX + p, y, b.maxY + p], [b.minX - p, y, b.maxY + p], UP,
    (b.minX - p) * k, -(b.minY - p) * k, (b.maxX + p) * k, -(b.maxY + p) * k);
  const clusters = scatter(r, cx, cz, near + 14, Math.min(R * 0.6, near + 110), ctx.low ? 14 : 30, () => ({ w: 9, d: 9 }), 4);
  for (const c of clusters) {
    const n = 2 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) tree(ctx, c.x + (r() - 0.5) * 8, c.y + (r() - 0.5) * 8, 0.8 + r() * 0.6, r);
  }
  const halls = scatter(r, cx, cz, near + 60, Math.min(R * 0.75, near + 170), ctx.low ? 3 : 6, (rr) => ({
    w: 28 + rr() * 30, d: 16 + rr() * 10, h: 8 + rr() * 8, rot: rr() * Math.PI,
  }), 18);
  massing(ctx, halls, ctx.mats.get('facadePrecast'));
}

/**
 * A street tree: a slender trunk that forks into the crown, and a canopy of crossed foliage cards
 * (a procedural leaf cluster texture, alpha tested) plus one flat card for views from above.
 */
function tree(ctx, x, z, s, r) {
  const B = ctx.ext;
  const bark = B.get(ctx.mats.trunk, false, false);
  const H = (3.9 + r() * 0.8) * s, fork = H - 1.1 * s;
  cylinder(ctx, bark, x, GROUND_Y, z, 0.11 * s, fork - GROUND_Y, 7);
  for (let k = 0; k < 3; k++) {
    const a = r() * Math.PI * 2, reach = (0.6 + r() * 0.5) * s;
    tube(ctx, bark, new THREE.Vector3(x, fork - 0.05, z), new THREE.Vector3(x + Math.cos(a) * reach, fork + (0.9 + r() * 0.5) * s, z + Math.sin(a) * reach), 0.05 * s, 6);
  }
  const leaf = B.get(ctx.mats.get('foliage'), false, false);
  const w = (3.7 + r() * 1.3) * s, h = w * (0.8 + r() * 0.15);
  // Each tree takes one of the four clusters in the texture, and a random turn.
  const q = Math.floor(r() * 4), u0 = (q % 2) * 0.5, v0 = Math.floor(q / 2) * 0.5;
  const a0 = r() * Math.PI;
  for (let k = 0; k < (ctx.low ? 2 : 3); k++) foliageCard(leaf, x, H, z, w, h, a0 + (k * Math.PI) / 3, u0, v0);
  // From above: a level card just under the crown's top.
  const c = w * 0.42, y = H + h * 0.18;
  const n = [0, 1, 0];
  const V = (dx, dz, u, v) => [x + dx * c, y, z + dz * c, ...n, u0 + u * 0.5, v0 + v * 0.5];
  const ca = Math.cos(a0), sa = Math.sin(a0);
  const rot = (dx, dz) => [dx * ca - dz * sa, dx * sa + dz * ca];
  poly(leaf, [V(...rot(-1, -1), 0, 0), V(...rot(1, -1), 1, 0), V(...rot(1, 1), 1, 1), V(...rot(-1, 1), 0, 1)]);
  treeShadow(ctx, x, z, w * 0.45);
}

/**
 * One vertical foliage card, drawn as two front-facing quads (one per side) whose normals lean up,
 * so both sides take light like the top of a crown instead of going dark from behind.
 */
function foliageCard(b, x, yc, z, w, h, angle, u0, v0) {
  const dx = Math.cos(angle) * (w / 2), dz = Math.sin(angle) * (w / 2);
  const y0 = yc - h / 2, y1 = yc + h / 2;
  for (const side of [1, -1]) {
    const nx = -Math.sin(angle) * side * 0.45, nz = Math.cos(angle) * side * 0.45, l = Math.hypot(nx, 0.9, nz);
    const N = [nx / l, 0.9 / l, nz / l];
    const V = (sx, y, u, v) => [x + dx * sx, y, z + dz * sx, ...N, u0 + u * 0.5, v0 + v * 0.5];
    poly(b, [V(-1, y0, 0, 0), V(1, y0, 1, 0), V(1, y1, 1, 1), V(-1, y1, 0, 1)]);
  }
}

/** Soft round shade on the ground under a tree's crown. */
function treeShadow(ctx, x, z, radius) {
  const b = ctx.fx.at(x, z).get(ctx.mats.get('blob'), false, false);
  const y = GROUND_Y + 0.03, n = 16;
  const ring = (k, rr) => [x + Math.cos((k / n) * Math.PI * 2) * rr, y, z + Math.sin((k / n) * Math.PI * 2) * rr];
  for (let k = 0; k < n; k++) {
    quad(b, [x, y, z], ring(k, radius * 0.4), ring(k + 1, radius * 0.4), [x, y, z], UP, 0.7, 0.7, 0.7, 0.7);
    quad(b, ring(k, radius * 0.4), ring(k, radius), ring(k + 1, radius), ring(k + 1, radius * 0.4), UP, 0.7, 0.7, 0, 0.7);
  }
}

// ---- Procedural textures -------------------------------------------------------

/** f(u) * f(v) with a smooth ramp from 0 at the edges to 1 at u = v = 1 (used as an alpha map). */
function drawFalloff(g, s) {
  const img = g.createImageData(s, s);
  const f = (t) => t * t * (3 - 2 * t);
  for (let j = 0; j < s; j++) {
    for (let i = 0; i < s; i++) {
      const v = Math.round(255 * f(i / (s - 1)) * f(1 - j / (s - 1)));
      const k = (j * s + i) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = v;
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}

/**
 * Four leaf clusters (2 x 2) on transparent ground: thousands of small leaves, darker and denser
 * inside the crown, lighter toward the sunlit upper edge, with a few branches showing through.
 */
function drawFoliage(g, s) {
  const r = rng(31);
  g.clearRect(0, 0, s, s);
  const half = s / 2;
  for (let q = 0; q < 4; q++) {
    const ox = (q % 2) * half, oy = Math.floor(q / 2) * half, cx = ox + half / 2, cy = oy + half * 0.5, R = half * 0.44;
    const ph = [r() * 6.28, r() * 6.28, r() * 6.28];
    const shape = (a) => 1 + 0.12 * Math.sin(3 * a + ph[0]) + 0.08 * Math.sin(5 * a + ph[1]) + 0.05 * Math.sin(9 * a + ph[2]);
    g.save();
    g.beginPath();
    g.rect(ox + 2, oy + 2, half - 4, half - 4);
    g.clip();
    g.strokeStyle = 'rgba(70,58,48,0.9)';
    for (let k = 0; k < 6; k++) {
      g.lineWidth = 2 + r() * 3;
      g.beginPath();
      g.moveTo(cx + (r() - 0.5) * 10, oy + half * 0.98);
      g.quadraticCurveTo(cx + (r() - 0.5) * R, cy + R * 0.3, cx + (r() - 0.5) * R * 1.4, cy - R * (0.2 + r() * 0.5));
      g.stroke();
    }
    // Inner leaves first (in shade), then the outer shell, lit from the upper left.
    for (let pass = 0; pass < 2; pass++) {
      const count = pass ? 2600 : 1600;
      for (let i = 0; i < count; i++) {
        const a = r() * Math.PI * 2, rr = Math.sqrt(r()) * (pass ? 0.75 + 0.25 * r() : 0.8);
        const px = Math.cos(a) * rr * shape(a), py = Math.sin(a) * rr * shape(a) * 0.9;
        const light = Math.max(0, Math.min(1, 0.5 - 0.35 * px - 0.45 * py + (r() - 0.5) * 0.35)) * (pass ? 1 : 0.45);
        const tone = [[52, 68, 42], [64, 82, 48], [74, 90, 54], [58, 74, 40]][Math.floor(r() * 4)];
        const k = 0.75 + light * 0.75;
        g.fillStyle = `rgb(${Math.round(tone[0] * k)},${Math.round(tone[1] * k)},${Math.round(tone[2] * k)})`;
        g.beginPath();
        g.ellipse(cx + px * R, cy + py * R, 3 + r() * 5, 2 + r() * 3, r() * Math.PI, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.restore();
  }
}

function drawAsphalt(g, s) {
  const r = rng(8);
  g.fillStyle = '#6a6e70';
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 5000; i++) {
    g.fillStyle = r() < 0.5 ? 'rgba(40,44,46,0.35)' : 'rgba(160,160,155,0.3)';
    g.fillRect(r() * s, r() * s, 1.2, 1.2);
  }
}

function drawDiffuser(g, s) {
  g.fillStyle = '#f3f3f1';
  g.fillRect(0, 0, s, s);
  for (let k = 0; k < 5; k++) {
    const inset = 22 + k * 20;
    g.strokeStyle = `rgba(80,86,88,${0.5 - k * 0.05})`;
    g.lineWidth = 4;
    g.strokeRect(inset, inset, s - inset * 2, s - inset * 2);
  }
  g.fillStyle = 'rgba(70,76,78,0.35)';
  g.fillRect(s / 2 - 16, s / 2 - 16, 32, 32);
}

function drawGrass(g, s) {
  const r = rng(12);
  // Mown lawn: a muted, slightly dry green (about 15 percent reflectance), patchy at meter scale.
  g.fillStyle = '#66784a';
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 70; i++) {
    const x = r() * s, y = r() * s, rad = s * (0.05 + r() * 0.16);
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, i % 2 ? 'rgba(78,100,56,0.2)' : 'rgba(132,140,92,0.18)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    for (const dx of [-s, 0, s]) for (const dy of [-s, 0, s]) g.fillRect(x - rad + dx, y - rad + dy, rad * 2, rad * 2);
  }
  for (let i = 0; i < 16000; i++) {
    g.fillStyle = r() < 0.5 ? 'rgba(58,78,42,0.35)' : 'rgba(146,156,104,0.3)';
    g.fillRect(r() * s, r() * s, 1, 2 + r() * 2);
  }
}

function drawGlassFacade(g, s) {
  const grad = g.createLinearGradient(0, 0, 0, s);
  grad.addColorStop(0, '#9fb5c2');
  grad.addColorStop(1, '#6d8593');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const spandrel = s * (0.9 / 4);
  g.fillStyle = '#56636a';
  g.fillRect(0, s - spandrel, s, spandrel);
  g.fillStyle = '#c3cacd';
  g.fillRect(0, 0, 6, s);
  g.fillRect(0, s - spandrel - 3, s, 4);
}

function drawPrecastFacade(g, s) {
  g.fillStyle = '#cfc8bb';
  g.fillRect(0, 0, s, s);
  const w = s * (1.6 / 3), h = s * (1.8 / 4);
  const x = (s - w) / 2, y = s * 0.2;
  // Punched windows read darker than the panel, reflecting a little sky at the head.
  g.fillStyle = '#46535a';
  g.fillRect(x, y, w, h);
  g.fillStyle = 'rgba(170,190,200,0.3)';
  g.fillRect(x, y, w, h * 0.3);
  g.fillStyle = '#bab3a5';
  g.fillRect(x - 4, y + h, w + 8, 6);
}

/** Skyline canvases span 360 degrees across; vertically they cover atan(SKY_RATIO) of elevation. */
function skylineDrawer(width, height) {
  const maxElev = (Math.atan(SKY_RATIO) * 180) / Math.PI;
  const kx = width / 360, ky = height / maxElev;
  const wrap = (x, w, fn) => {
    const px = (((x * kx) % width) + width) % width;
    fn(px, w * kx);
    if (px + w * kx > width) fn(px - width, w * kx);
  };
  return { kx, ky, wrap, yOf: (elev) => height - elev * ky };
}

function drawCitySkyline(g, W, Hh) {
  const r = rng(2024);
  g.clearRect(0, 0, W, Hh);
  // Far to near, each layer a little darker and crisper: atmospheric haze flattens distant towers.
  // Distant layers are drawn at lower resolution, so upscaling softens their edges.
  const layers = [
    { rgb: [199, 209, 216], bands: 0.05, count: 150, w: [0.5, 1.8], h: [1.6, 8.2], scale: 4 },
    { rgb: [181, 193, 201], bands: 0.07, count: 120, w: [0.7, 2.4], h: [1, 4.8], scale: 3 },
    { rgb: [160, 174, 183], bands: 0.09, count: 95, w: [1, 3.2], h: [0.5, 2.6], scale: 2 },
  ];
  for (const L of layers) {
    softLayer(g, W, Hh, L.scale, (c, { wrap, yOf, ky }, H) => {
      for (let i = 0; i < L.count; i++) {
        const x = r() * 360, w = L.w[0] + r() * (L.w[1] - L.w[0]);
        const h = L.h[0] + Math.pow(r(), 1.6) * (L.h[1] - L.h[0]);
        const top = yOf(h), tone = 1 + (r() - 0.5) * 0.07, lit = r() < 0.55;
        const setback = r() < 0.3;
        const rgb = (k) => `rgb(${L.rgb.map((v) => Math.round(Math.min(255, v * tone * k))).join(',')})`;
        wrap(x, w, (px, pw) => {
          c.fillStyle = rgb(1);
          c.fillRect(px, top, pw, H - top);
          if (setback) c.fillRect(px + pw * 0.2, top - ky * h * 0.08, pw * 0.6, ky * h * 0.08 + 1);
          // The face toward the afternoon sun reads a touch brighter.
          if (lit) {
            c.fillStyle = rgb(1.06);
            c.fillRect(px, top, pw * 0.38, H - top);
          }
          c.fillStyle = `rgba(236,242,245,${L.bands})`;
          for (let y = top + ky * 0.12; y < H; y += ky * 0.22) c.fillRect(px + pw * 0.06, y, pw * 0.88, Math.max(0.5, ky * 0.07));
        });
      }
    });
  }
  softLayer(g, W, Hh, 2, (c, { wrap, yOf, ky }, H) => {
    for (let i = 0; i < 90; i++) {
      const x = r() * 360, rad = 0.3 + r() * 0.45;
      const tone = ['#7f9584', '#8a9e8b', '#768c7b'][i % 3];
      wrap(x, rad * 2, (px, pw) => {
        c.fillStyle = tone;
        c.beginPath();
        c.ellipse(px + pw / 2, yOf(rad * 0.6), pw / 2, rad * ky * 0.6, 0, 0, Math.PI * 2);
        c.fill();
        c.fillRect(px, yOf(rad * 0.6), pw, H);
      });
    }
  });
  hazeBase(g, W, Hh);
}

/** Draw into a canvas `scale` times smaller (skylineDrawer coordinates), then upscale it onto g. */
function softLayer(g, W, Hh, scale, draw) {
  const c = document.createElement('canvas');
  c.width = Math.ceil(W / scale);
  c.height = Math.ceil(Hh / scale);
  const ctx = c.getContext('2d');
  draw(ctx, skylineDrawer(c.width, c.height), c.height);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(c, 0, 0, W, Hh);
}

function drawCampusSkyline(g, W, Hh) {
  const r = rng(77);
  g.clearRect(0, 0, W, Hh);
  const hills = [
    { color: '#bccac6', amp: 2.4, base: 1.2, f: [2, 5, 9], scale: 4 },
    { color: '#a6b8ae', amp: 1.4, base: 0.6, f: [3, 7, 13], scale: 3 },
  ];
  for (const Hl of hills) {
    const ph = Hl.f.map(() => r() * Math.PI * 2);
    softLayer(g, W, Hh, Hl.scale, (c, { yOf }, H) => {
      const w = c.canvas.width;
      c.fillStyle = Hl.color;
      c.beginPath();
      c.moveTo(0, H);
      for (let x = 0; x <= w; x += 2) {
        const a = (x / w) * Math.PI * 2;
        const e = Hl.base + Hl.amp * (0.5 + 0.5 * Hl.f.reduce((acc, f, i) => acc + Math.sin(a * f + ph[i]) / (i + 1.5), 0) / 1.4);
        c.lineTo(x, yOf(Math.max(0.2, e)));
      }
      c.lineTo(w, H);
      c.fill();
    });
  }
  softLayer(g, W, Hh, 2, (c, { wrap, yOf, ky }, H) => {
    for (let i = 0; i < 9; i++) {
      const x = r() * 360, w = 1.5 + r() * 3, h = 0.4 + r() * 0.6;
      wrap(x, w, (px, pw) => {
        c.fillStyle = '#ccd1ce';
        c.fillRect(px, yOf(h), pw, H);
        c.fillStyle = 'rgba(130,145,150,0.4)';
        c.fillRect(px + 1, yOf(h * 0.7), pw - 2, Math.max(1, ky * 0.08));
      });
    }
    for (let i = 0; i < 520; i++) {
      const x = r() * 360, rad = 0.25 + r() * 0.45, lift = r() * 0.4;
      const tone = ['#7a9480', '#869f88', '#6f8a75', '#91a88f'][i % 4];
      wrap(x, rad * 2, (px, pw) => {
        c.fillStyle = tone;
        c.beginPath();
        c.ellipse(px + pw / 2, yOf(lift + rad * 0.8), pw / 2, rad * ky * 0.8, 0, 0, Math.PI * 2);
        c.fill();
        c.fillRect(px, yOf(lift + rad * 0.8), pw, H);
      });
    }
  });
  hazeBase(g, W, Hh);
}

/** Atmospheric haze toward the horizon, painted only over existing silhouettes. */
function hazeBase(g, W, Hh) {
  g.save();
  g.globalCompositeOperation = 'source-atop';
  const grad = g.createLinearGradient(0, 0, 0, Hh);
  grad.addColorStop(0, 'rgba(226,234,238,0.12)');
  grad.addColorStop(0.55, 'rgba(226,234,238,0.3)');
  grad.addColorStop(1, 'rgba(230,236,238,0.7)');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, Hh);
  g.restore();
}
