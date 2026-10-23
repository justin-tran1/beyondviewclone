// Walkthrough: renders the plan in 3D with a first-person walker, an overview orbit camera,
// wall and furniture collisions, click to walk and a minimap. Contract: docs/architecture.md.
// Plan (x, y) in meters maps to world (x, height, y). Yaw is degrees clockwise, 0 facing plan -y.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DEFAULTS } from './model.js';
import {
  clamp, deg2rad, normDeg, polygonArea, polygonCentroid, polygonSignedArea, pointInPolygon,
  segmentIntersection, boundsOf, itemCorners,
} from './geometry.js';
import { createKit } from './kit3d.js';
import { getItem, itemDims } from './catalog/registry.js';
import * as builder from './builder3d.js';
import { createPostFX, QUALITIES } from './postfx.js';
import { renderPlan, fitView, planBounds, toPlan } from './plan-render.js';

const { buildPlanScene, setupEnvironment } = builder;

const EYE = DEFAULTS.eyeHeight;
const RADIUS = 0.25;
const SPEED = { walk: 1.4, run: 3, glide: 2.2, turn: 90 };
const ACCEL = 8;
const FOV = { walk: 70, min: 35, max: 80, overview: 45 };
const PITCH_LIMIT = 70; // matches the camera pitch limit in normalizePlan
const MAX_STEP = 0.05;
const PUSH_ITERATIONS = 8;
const OUTDOOR_MARGIN = 15; // how far outside the plan bounds the walker may go
const REACH = RADIUS + 0.8;
const SLOP = { mouse: 4, pen: 4, touch: 10 };
const REBUILD_DELAY = 300;
const SLOW_BUILD = 120;
const POSE_INTERVAL = 100;
const SLOW_FRAME = 40;
// The frame governor judges the median of the last GOVERNOR_FRAMES motion frames (or of fewer, once
// they span GOVERNOR_SPAN ms), so a hitch or two, such as a garbage collection, never changes the level.
const GOVERNOR_FRAMES = 20;
const GOVERNOR_MIN_FRAMES = 5;
const GOVERNOR_SPAN = 1000;
// Frame times left out after work that has nothing to do with moving (the first render of a motion,
// compiling shaders, redrawing the shadow map): the browser can report its cost a frame late.
const SKIP_FRAMES = 2;
// Motion time (ms) with three frames in four under HEADROOM_FRAME before a lowered level steps back
// up one notch. It doubles each time a raised level turns out too slow within STEP_UP_TRIAL.
const HEADROOM_FRAME = 24;
const STEP_UP_AFTER = 3000;
const STEP_UP_TRIAL = 10000;
const MIN_RATIO = 0.5;
// AgX keeps highlights from clipping and shadows from crushing, and the post grade adds the contrast
// back. Calibrated against the plan light map over every sample's saved views: on average a little
// brighter than the original ACES look (interiors read as well-lit offices, not dim ones), with sun
// patches by the windows kept below clipping by the grade's shoulder. Keep photo.js PHOTO_EXPOSURE equal.
const EXPOSURE = 1.8;
// In Walk the exposure follows the light where the walker looks, as a photographer meters each
// view: daylit spots by the windows come down toward the level the exposure was calibrated for,
// so their floors and white casework keep their texture. The meter is the light map's view meter
// (builder3d.js planLight.meter) with its daylight weighted `daylight` times, as the window reveals,
// the floor by the glass and the view out are what blow out first, while a well lit office with
// dark carpet and an open deck keeps its exposure. Exposure is EXPOSURE times
// (reference / meter) ^ strength, within `range`; it eases over about `ease` seconds while walking
// and is set at once on a jump or a rebuild. The overview keeps EXPOSURE. Photos take the live
// exposure (src/ui/photo.js).
const METER = { daylight: 2, reference: 7.3, strength: 0.9, range: [0.6, 1], ease: 0.3 };
const MAX_DT = 0.25;
const TRANSITION = 1.1;
const OVERVIEW_ELEVATION = 52;
const GREEN = '#003F2D';
const ACCENT = '#17E88F';
const TEXT = '#435254';
const FONT = 'Calibre, "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
const EMPTY_PLAN = { units: 'imperial', underlay: null, walls: [], openings: [], rooms: [], items: [], cameras: [] };
const MOVE_KEYS = {
  KeyW: 'forward', ArrowUp: 'forward', KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  KeyQ: 'turnLeft', KeyE: 'turnRight',
};

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const angleDelta = (from, to) => ((((to - from) % 360) + 540) % 360) - 180;
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const finite = (v, fallback) => (Number.isFinite(v) ? v : fallback);

// ---- Collision world ----------------------------------------------------------------

/** Uniform grid over plan space so collision and visibility queries only look at nearby shapes. */
class Grid {
  constructor(size = 2) {
    this.size = size;
    this.cells = new Map();
    this.big = [];
    this.mark = 0;
  }

  add(entry, minX, minY, maxX, maxY) {
    entry.mark = 0;
    const s = this.size;
    const i0 = Math.floor(minX / s), i1 = Math.floor(maxX / s), j0 = Math.floor(minY / s), j1 = Math.floor(maxY / s);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 400) {
      this.big.push(entry);
      return;
    }
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const key = `${i},${j}`;
        let list = this.cells.get(key);
        if (!list) this.cells.set(key, (list = []));
        list.push(entry);
      }
    }
  }

  query(minX, minY, maxX, maxY, out) {
    const s = this.size;
    const mark = ++this.mark;
    out.length = 0;
    const take = (e) => {
      if (e.mark !== mark) {
        e.mark = mark;
        out.push(e);
      }
    };
    const i0 = Math.floor(minX / s), i1 = Math.floor(maxX / s), j0 = Math.floor(minY / s), j1 = Math.floor(maxY / s);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const list = this.cells.get(`${i},${j}`);
        if (list) for (const e of list) take(e);
      }
    }
    for (const e of this.big) take(e);
    return out;
  }
}

/** Walls and obstacles in a grid, plus the outdoor limits (plan bounds grown by OUTDOOR_MARGIN) when bounds are given. */
function collisionWorld(colliders, obstacles, bounds = null) {
  const grid = new Grid(2);
  const m = OUTDOOR_MARGIN;
  grid.limits = bounds ? { minX: bounds.minX - m, minY: bounds.minY - m, maxX: bounds.maxX + m, maxY: bounds.maxY + m } : null;
  for (const c of colliders || []) {
    if (!c?.a || !c?.b) continue;
    const r = Math.max(0, finite(c.r, 0));
    grid.add({ seg: true, a: c.a, b: c.b, r },
      Math.min(c.a.x, c.b.x) - r, Math.min(c.a.y, c.b.y) - r, Math.max(c.a.x, c.b.x) + r, Math.max(c.a.y, c.b.y) + r);
  }
  for (const o of obstacles || []) {
    const pts = o?.corners;
    if (!pts || pts.length < 3) continue;
    const b = boundsOf(pts);
    grid.add({ seg: false, pts, center: polygonCentroid(pts) }, b.minX, b.minY, b.maxX, b.maxY);
  }
  return grid;
}

/** Blocking items with their heights, for line of sight checks (items can hide the floor behind them). */
function itemOccluders(plan) {
  const grid = new Grid(2);
  for (const item of plan.items) {
    if (getItem(item.type).blocking === false) continue;
    const dims = itemDims(item);
    const pts = itemCorners(item, dims);
    const b = boundsOf(pts);
    const bottom = item.elevation || 0;
    grid.add({ pts, sign: polygonSignedArea(pts) > 0 ? 1 : -1, bottom, top: bottom + dims.h }, b.minX, b.minY, b.maxX, b.maxY);
  }
  return grid;
}

const _near = [];
const _q = { x: 0, y: 0 };

function closestOnSegment(px, py, a, b, out) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 < 1e-12 ? 0 : clamp(((px - a.x) * dx + (py - a.y) * dy) / l2, 0, 1);
  out.x = a.x + dx * t;
  out.y = a.y + dy * t;
  return out;
}

/** Closest point on a polygon outline to (px, py), written to out; returns the distance. */
function closestOnPolygon(px, py, pts, out) {
  let best = Infinity, bx = 0, by = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const q = closestOnSegment(px, py, pts[i], pts[(i + 1) % n], _q);
    const d2 = (px - q.x) ** 2 + (py - q.y) ** 2;
    if (d2 < best) {
      best = d2;
      bx = q.x;
      by = q.y;
    }
  }
  out.x = bx;
  out.y = by;
  return Math.sqrt(best);
}

function pushFromSegment(e, p, prev) {
  const q = closestOnSegment(p.x, p.y, e.a, e.b, _q);
  const min = e.r + RADIUS;
  let dx = p.x - q.x, dy = p.y - q.y;
  let d = Math.hypot(dx, dy);
  if (d >= min) return false;
  if (d < 1e-6) {
    const ex = e.b.x - e.a.x, ey = e.b.y - e.a.y, l = Math.hypot(ex, ey) || 1;
    const nx = -ey / l, ny = ex / l;
    const side = (prev.x - e.a.x) * nx + (prev.y - e.a.y) * ny >= 0 ? 1 : -1;
    dx = nx * side;
    dy = ny * side;
    d = 1;
  }
  p.x = q.x + (dx / d) * min;
  p.y = q.y + (dy / d) * min;
  return true;
}

const _edge = { x: 0, y: 0 };

function pushFromPolygon(e, p) {
  const d = closestOnPolygon(p.x, p.y, e.pts, _edge);
  const inside = pointInPolygon(p, e.pts);
  if (!inside && d >= RADIUS) return false;
  let nx, ny;
  if (d < 1e-6) {
    nx = p.x - e.center.x;
    ny = p.y - e.center.y;
  } else if (inside) {
    nx = _edge.x - p.x;
    ny = _edge.y - p.y;
  } else {
    nx = p.x - _edge.x;
    ny = p.y - _edge.y;
  }
  const l = Math.hypot(nx, ny) || 1;
  p.x = _edge.x + (nx / l) * RADIUS;
  p.y = _edge.y + (ny / l) * RADIUS;
  return true;
}

const outside = (lim, x, y) => !!lim && !(x >= lim.minX && x <= lim.maxX && y >= lim.minY && y <= lim.maxY);

/**
 * Push p (mutated) inside the outdoor limits and out of walls and obstacles; resolving along contact
 * normals keeps the slide. Returns false when p still overlaps something (a gap narrower than the walker).
 */
function pushOut(world, p, prev) {
  const lim = world.limits;
  if (lim) {
    p.x = clamp(p.x, lim.minX, lim.maxX);
    p.y = clamp(p.y, lim.minY, lim.maxY);
  }
  const near = world.query(p.x - REACH, p.y - REACH, p.x + REACH, p.y + REACH, _near);
  for (let iter = 0; iter < PUSH_ITERATIONS; iter++) {
    let hit = false;
    for (const e of near) if (e.seg ? pushFromSegment(e, p, prev) : pushFromPolygon(e, p)) hit = true;
    if (!hit) return true;
  }
  return isFree(world, p.x, p.y);
}

/**
 * Move p by (dx, dy) in short substeps so fast moves never skip through thin walls. A substep that
 * cannot be resolved is undone, so the walker never squeezes through a gap narrower than itself,
 * whatever the frame rate. Returns the distance covered.
 */
function moveWithCollisions(world, p, dx, dy) {
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return 0;
  const n = Math.ceil(L / MAX_STEP);
  const x0 = p.x, y0 = p.y;
  const prev = { x: p.x, y: p.y };
  for (let i = 0; i < n; i++) {
    prev.x = p.x;
    prev.y = p.y;
    p.x += dx / n;
    p.y += dy / n;
    if (!pushOut(world, p, prev) && isFree(world, prev.x, prev.y)) {
      p.x = prev.x;
      p.y = prev.y;
    }
  }
  return Math.hypot(p.x - x0, p.y - y0);
}

function isFree(world, x, y, clearance = 0) {
  if (outside(world.limits, x, y)) return false;
  const R = RADIUS + clearance - 1e-4;
  const near = world.query(x - REACH - clearance, y - REACH - clearance, x + REACH + clearance, y + REACH + clearance, _near);
  const p = { x, y };
  for (const e of near) {
    if (e.seg) {
      const q = closestOnSegment(x, y, e.a, e.b, _q);
      if (Math.hypot(x - q.x, y - q.y) < e.r + R) return false;
    } else if (pointInPolygon(p, e.pts) || closestOnPolygon(x, y, e.pts, _edge) < R) {
      return false;
    }
  }
  return true;
}

/** Nearest free spot to p, searching outward in rings; optionally kept inside a region polygon. */
function findFree(world, p, { region = null, clearance = 0, maxRadius = 10 } = {}) {
  const ok = (x, y) => isFree(world, x, y, clearance) && (!region || pointInPolygon({ x, y }, region));
  if (ok(p.x, p.y)) return { x: p.x, y: p.y };
  for (let r = 0.15; r <= maxRadius; r += 0.15) {
    const n = Math.max(8, Math.ceil((2 * Math.PI * r) / 0.15));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const x = p.x + Math.cos(a) * r, y = p.y + Math.sin(a) * r;
      if (ok(x, y)) return { x, y };
    }
  }
  return null;
}

/** Free distance from p along a plan direction, in 0.25 m steps. */
function clearDistance(world, p, dx, dy, max = 40) {
  let d = 0;
  while (d < max && isFree(world, p.x + dx * (d + 0.25), p.y + dy * (d + 0.25))) d += 0.25;
  return d;
}

/** Parameter range [t0, t1] of segment a->b inside a convex polygon, or null (Cyrus-Beck). */
function clipConvex(ax, ay, bx, by, pts, sign) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const nx = (q.y - p.y) * sign, ny = -(q.x - p.x) * sign;
    const num = (ax - p.x) * nx + (ay - p.y) * ny;
    const den = dx * nx + dy * ny;
    if (Math.abs(den) < 1e-12) {
      if (num > 0) return null;
      continue;
    }
    const t = -num / den;
    if (den < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

const sceneKey = (plan) => JSON.stringify([plan.walls, plan.openings, plan.rooms, plan.items, plan.settings]);

// ---- Scene helpers --------------------------------------------------------------------

/**
 * createKit() with the canvas textures items draw tracked per build. The kit's own caches
 * (materials, maps, rounded box geometry) live as long as the walkthrough and go with kit.dispose().
 * The wrapper object stays the same for the walkthrough's life: builder3d.js keys its per-kit
 * shared materials on it.
 */
function trackedKit() {
  const base = createKit();
  let textures = new Set();
  const kit = {
    ...base,
    canvasTexture: (...args) => {
      const t = base.canvasTexture(...args);
      textures.add(t);
      return t;
    },
  };
  return {
    kit,
    /** Textures items made during the last build; they belong to that build. */
    takeTextures() {
      const out = textures;
      textures = new Set();
      return out;
    },
    dispose() {
      for (const t of textures) t.dispose();
      textures.clear();
      // Through the wrapper: catalog modules chain their own kit caches onto its dispose().
      kit.dispose();
    },
  };
}

/** Materials under obj and the textures they hold (maps and texture uniforms). */
function sceneResources(obj) {
  const materials = new Set(), textures = new Set();
  const take = (v) => { if (v?.isTexture) textures.add(v); };
  obj.traverse((o) => {
    for (const m of [].concat(o.material || [])) {
      if (materials.has(m)) continue;
      materials.add(m);
      for (const v of Object.values(m)) take(v);
      for (const u of Object.values(m.uniforms || {})) take(u?.value);
    }
  });
  return { materials, textures };
}

function ringMesh() {
  const group = new THREE.Group();
  group.name = 'walk-target';
  const ringMat = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.75, depthWrite: false, toneMapped: false });
  const discMat = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.14, depthWrite: false, toneMapped: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.21, 0.26, 48).rotateX(-Math.PI / 2), ringMat);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.21, 48).rotateX(-Math.PI / 2), discMat);
  group.add(disc, ring);
  group.renderOrder = 3;
  for (const m of group.children) m.renderOrder = 3;
  group.visible = false;
  group.userData.mats = [ringMat, discMat];
  group.userData.overlay = true; // UI, not part of the space: kept out of captures and photos
  return group;
}

/**
 * Small figure standing at the walker pose in overview, with a view wedge pointing forward (-z).
 * The wedge and base ring draw through walls so the position always reads. Like the walk target,
 * it is drawn in the overlay scene, so the body is lit by that scene's own lights (see _setupScene).
 */
function walkerFigure() {
  const group = new THREE.Group();
  group.name = 'walker';
  // Transparent pass so the body draws after the overlays below and stays in front of its own ring.
  const body = new THREE.MeshStandardMaterial({ color: GREEN, roughness: 0.5, emissive: GREEN, emissiveIntensity: 0.35, transparent: true });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.72, 6, 18), body);
  torso.position.y = 0.72;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.125, 20, 14), body);
  head.position.y = 1.42;
  const half = deg2rad(40);
  const wedgeGeo = new THREE.CircleGeometry(2.4, 28, Math.PI / 2 - half, half * 2).rotateX(-Math.PI / 2);
  const n = wedgeGeo.attributes.position.count;
  const colors = new Float32Array(n * 4);
  const c = new THREE.Color(ACCENT);
  for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b, i === 0 ? 0.5 : 0], i * 4);
  wedgeGeo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  const overlay = { transparent: true, depthWrite: false, depthTest: false, toneMapped: false };
  const wedge = new THREE.Mesh(wedgeGeo, new THREE.MeshBasicMaterial({ vertexColors: true, ...overlay }));
  wedge.position.y = 0.02;
  const base = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.4, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: ACCENT, opacity: 0.95, ...overlay }));
  base.position.y = 0.025;
  wedge.renderOrder = base.renderOrder = 10;
  torso.renderOrder = head.renderOrder = 11;
  group.add(wedge, base, torso, head);
  group.visible = false;
  group.userData.overlay = true;
  return group;
}

/** Places cam on target + dir * d with the smallest d that keeps the plan box inside the view. */
function fitDistance(cam, target, dir, box, margin = { x: 0.88, y: 0.8 }) {
  const corners = [];
  for (const x of [box.minX, box.maxX]) for (const z of [box.minY, box.maxY]) for (const y of [0, box.top]) corners.push(new THREE.Vector3(x, y, z));
  const v = new THREE.Vector3();
  const fits = (d) => {
    cam.position.copy(target).addScaledVector(dir, d);
    cam.lookAt(target);
    cam.updateMatrixWorld();
    return corners.every((c) => {
      v.copy(c).applyMatrix4(cam.matrixWorldInverse);
      if (v.z > -cam.near) return false;
      v.applyMatrix4(cam.projectionMatrix);
      return Math.abs(v.x) <= margin.x && Math.abs(v.y) <= margin.y;
    });
  };
  let lo = 1, hi = 4000;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  fits(hi);
  return hi;
}

/** World box AO is limited to: the plan bounds and the ceiling height, plus a margin. */
function aoBounds(b, top) {
  if (![b?.minX, b?.minY, b?.maxX, b?.maxY].every(Number.isFinite)) return null;
  const m = 1;
  return new THREE.Box3(new THREE.Vector3(b.minX - m, -m, b.minY - m), new THREE.Vector3(b.maxX + m, top + m, b.maxY + m));
}

function disposeTree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    if (o.material) for (const m of [].concat(o.material)) m.dispose();
  });
}

function styled(tag, style) {
  const el = document.createElement(tag);
  Object.assign(el.style, style);
  return el;
}

// ---- Walkthrough ------------------------------------------------------------------------

export class Walkthrough extends EventTarget {
  constructor(container, store, { minimap = true, quality = 'high' } = {}) {
    super();
    if (!QUALITIES.includes(quality)) throw new Error(`Unknown walkthrough quality "${quality}"`);
    this._chosenQuality = quality;
    this._quality = quality;
    this._envCapture = null;
    this._orphans = null;
    this.container = container;
    this.store = store;
    this._mode = 'walk';
    this._running = false;
    this._visible = true;
    this._raf = 0;
    this._inFrame = false;
    this._again = false;
    this._last = 0;
    this._dirty = true;
    this._size = { w: 0, h: 0 };
    this._pose = { x: 0, y: 0, yaw: 0, pitch: 0 };
    this._poseDirty = false;
    this._poseAt = -Infinity;
    this._poseTimer = 0;
    this._vel = { x: 0, y: 0 };
    this._keys = new Set();
    this._run = false;
    this._glide = null;
    this._anim = null;
    this._tween = null;
    this._inertia = null;
    this._fov = FOV.walk;
    this._fovTarget = FOV.walk;
    this._snapExposure = true;
    this._pointers = new Map();
    this._look = null;
    this._pinch = null;
    this._click = null;
    this._hoverPos = null;
    this._hoverMoved = false;
    this._built = null;
    this._failure = null;
    this._buildTextures = new Set();
    this._buildMs = 0;
    this._key = '';
    this._stale = false;
    this._resetPose = true;
    this._rebuildTimer = 0;
    this._ceilingsShown = true;
    this._ceilTop = DEFAULTS.wallHeight + 1.2;
    this._world = collisionWorld([], []);
    this._occluders = new Grid();
    this._ringHit = false;
    // Frame governor state: recent motion frame times, frames to leave out, motion time with headroom,
    // the headroom needed before stepping up, and the motion time since the last step up.
    this._perf = { win: [], skip: 0, calm: 0, upAfter: STEP_UP_AFTER, since: Infinity };
    this._fastScene = false;
    this._casters = [];
    this._restore = {};

    this._setupDom();
    this._setupRenderer();
    this._setupScene();
    if (minimap) this._setupMinimap();
    this._setupInput();
    this._setupObservers();
    this._applySize();
    this.rebuild();
  }

  // ---- Public API -----------------------------------------------------------------------

  get pose() {
    const p = this._pose;
    return { x: p.x, y: p.y, yaw: normDeg(p.yaw), pitch: p.pitch };
  }

  get mode() { return this._mode; }

  /** The rendering quality in use: the chosen level, or lower while frames are too slow. */
  get quality() { return this._quality; }

  /** The level last set with setQuality (or the constructor); automatic changes never go above it. */
  get chosenQuality() { return this._chosenQuality; }

  /**
   * 'high' (ambient occlusion, bloom, color grade, SMAA), 'balanced' (cheaper AO, no bloom) or
   * 'fast' (the color grade only). Emits 'quality' {quality, chosen, auto}. Where post-processing
   * cannot run (no WebGL 2), the level in use stays 'fast' and auto is true.
   */
  setQuality(quality) {
    if (!QUALITIES.includes(quality)) throw new Error(`Unknown walkthrough quality "${quality}"`);
    const chosenChanged = quality !== this._chosenQuality;
    this._chosenQuality = quality;
    // A deliberate choice starts the automatic changes over, from full motion resolution.
    this._motionRatio = this._baseRatio;
    this._perf.upAfter = STEP_UP_AFTER;
    this._perf.since = Infinity;
    this._resetGovernor(0);
    if (quality !== this._quality || chosenChanged) this._applyQuality(quality, false);
  }

  /** What another renderer needs to draw the current view (the photo renderer, for example). */
  get renderContext() {
    this._syncWalkCamera();
    return { renderer: this._renderer, scene: this._scene, camera: this._activeCamera(), built: this._built };
  }

  start() {
    if (this._running) return;
    this._running = true;
    if (this._stale) this._autoRebuild();
    this._invalidate();
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._last = 0;
    this._resetInput();
  }

  /** Rebuild the 3D scene from store.plan now, keeping the current pose. */
  rebuild() {
    clearTimeout(this._rebuildTimer);
    this._rebuildTimer = 0;
    const plan = this.store.plan;
    const t0 = performance.now();
    let built;
    try {
      built = buildPlanScene(plan, { kit: this._kit.kit, quality: 'high' });
    } catch (err) {
      this._buildMs = performance.now() - t0;
      this._buildFailed(plan, err);
      return;
    }
    this._buildMs = performance.now() - t0;
    const textures = this._kit.takeTextures();
    if (this._built) this._disposeBuilt();
    this._built = built;
    this._orphans = null;
    this._buildTextures = textures;
    this._key = sceneKey(plan);
    this._stale = false;
    this._showFailure(null);
    this._scene.add(built.root);
    this._env.fit(built.bounds);
    this._world = collisionWorld(built.colliders, built.obstacles, built.bounds);
    this._occluders = itemOccluders(plan);
    this._ceilTop = Math.max(plan.settings.wallHeight, ...plan.rooms.map((r) => r.height || 0)) + 1.2;
    this._renderer.shadowMap.needsUpdate = true;
    this._captureEnvironment(built);
    // The item meshes this build lets cast sun shadows, which 'fast' turns off; the capture above saw
    // the full scene, so the reflections are the same at every level.
    this._casters = [];
    built.root.getObjectByName('furnishings')?.traverse((o) => { if (o.isMesh && o.castShadow) this._casters.push(o); });
    this._fastScene = false;
    this._setFastScene(this._quality === 'fast');
    this._postfx.setSceneBounds(aoBounds(built.bounds, this._ceilTop));
    const far = Math.max(600, (built.root.userData.horizon || 1000) * 1.3);
    for (const cam of [this._camera, this._orbitCam, this._tweenCam]) {
      cam.far = far;
      cam.updateProjectionMatrix();
    }
    this._setCeilings(this._mode === 'walk' && !this._tween, true);
    this._renderer.shadowMap.needsUpdate = true;

    const span = Math.max(built.bounds.maxX - built.bounds.minX, built.bounds.maxY - built.bounds.minY);
    this._figure.scale.setScalar(clamp(span / 28, 1, 3));
    if (this._resetPose) {
      this._resetPose = false;
      Object.assign(this._pose, this._startPose(plan, built));
      this._cancelMotion();
      if (this._mode === 'overview') this._frameOverview();
    } else {
      this._settlePose();
    }
    this._layoutMinimap();
    this._poseChanged();
    this._snapExposure = true;
    // The build and the shadow map redraw it asks for land in the next frame times.
    this._skipFrames();
    this._invalidate();
  }

  setMode(mode) {
    if (mode !== 'walk' && mode !== 'overview') throw new Error(`Unknown walkthrough mode "${mode}"`);
    if (mode === this._mode) return;
    this._syncWalkCamera();
    const from = this._activeCamera();
    const fromState = { pos: from.position.clone(), quat: from.quaternion.clone(), fov: from.fov };
    this._mode = mode;
    this._resetInput();
    this._cancelMotion();
    this._controls.enabled = false;
    if (mode === 'overview') this._frameOverview();
    this._figure.visible = true;
    this._showMinimap(false);
    if (reducedMotion() || !this._canRender()) this._finishMode();
    else this._tween = { t: 0, from: fromState, to: mode === 'overview' ? this._orbitCam : this._camera };
    this._canvas.style.cursor = 'grab';
    this.dispatchEvent(new CustomEvent('mode', { detail: { mode } }));
    this._invalidate();
  }

  goTo(target, { animate = true } = {}) {
    const cur = this._pose;
    const to = {
      x: finite(+target?.x, cur.x),
      y: finite(+target?.y, cur.y),
      yaw: normDeg(finite(+target?.yaw, cur.yaw)),
      pitch: clamp(finite(+target?.pitch, cur.pitch), -PITCH_LIMIT, PITCH_LIMIT),
    };
    Object.assign(to, this._freeSpot(to));
    this._cancelMotion();
    const dist = Math.hypot(to.x - cur.x, to.y - cur.y);
    const turn = Math.abs(angleDelta(cur.yaw, to.yaw));
    if (animate && !reducedMotion() && this._canRender() && (dist > 0.01 || turn > 0.5 || Math.abs(to.pitch - cur.pitch) > 0.5)) {
      this._anim = { from: { ...cur }, to, dyaw: angleDelta(cur.yaw, to.yaw), t: 0, dur: clamp(0.7 + dist * 0.025 + turn / 900, 0.7, 1.2) };
    } else {
      Object.assign(cur, to);
      this._poseChanged();
      this._snapExposure = true;
    }
    this._invalidate();
  }

  /** Go to a saved view. Emits 'camera' {id, arriving} so the views strip can follow, whatever started the jump. */
  goToCamera(id) {
    const cam = this.store.plan.cameras.find((c) => c.id === id);
    if (!cam) return false;
    const pose = { x: cam.x, y: cam.y, yaw: cam.yaw, pitch: cam.pitch };
    if (this._mode === 'overview') {
      this.goTo(pose, { animate: false });
      this.setMode('walk');
    } else {
      this.goTo(pose);
    }
    if (this._anim) this._anim.camera = id;
    this._emitCamera(id, !!this._anim);
    return true;
  }

  /**
   * PNG of the current view, post-processing included, rendered fresh at full resolution and at the
   * chosen quality: a still has no frame budget, so a level lowered for moving does not apply.
   */
  screenshot() {
    const check = () => {
      if (!this._built) throw new Error('This plan could not be shown in 3D, so there is no 3D view to save.');
      if (this._disposed || !this._applySize()) throw new Error('The 3D view is not visible, so there is nothing to capture.');
    };
    try {
      check();
    } catch (err) {
      return Promise.reject(err);
    }
    // Asking for `ready` at the chosen level starts loading what that level's chain needs; frames
    // drawn while it loads stay at the level in use.
    const level = this._chosenQuality, inUse = this._postfx.quality;
    if (inUse !== level) this._postfx.setQuality(level);
    const ready = this._postfx.ready;
    if (inUse !== level) this._postfx.setQuality(inUse);
    return ready.then(() => new Promise((resolve, reject) => {
      check();
      const renderer = this._renderer;
      if (renderer.getPixelRatio() !== this._baseRatio) {
        renderer.setPixelRatio(this._baseRatio);
        this._applySize();
      }
      const ring = this._ring.visible, fastScene = this._fastScene;
      this._ring.visible = false;
      try {
        if (this._postfx.quality !== level) this._postfx.setQuality(level);
        this._setFastScene(this._postfx.quality === 'fast');
        // The view as it settles, even if the exposure is still easing toward it.
        this._snapExposure = true;
        this._stepExposure(0);
        this._render();
        this._canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not capture the 3D view.'))), 'image/png');
      } finally {
        this._setFastScene(fastScene);
        if (this._postfx.quality !== this._quality) this._postfx.setQuality(this._quality);
        this._ring.visible = ring;
        this._skipFrames();
        this._invalidate();
      }
    }));
  }

  resize() {
    this._baseRatio = Math.min(window.devicePixelRatio || 1, 2);
    this._motionRatio = Math.min(this._motionRatio, this._baseRatio);
    const before = this._size;
    if (!this._applySize()) return;
    if (this._size !== before) {
      this._layoutMinimap();
      if (this._canRender() && !this._raf) this._render();
      // New buffers, and perhaps a frame drawn here: not the cost of moving.
      this._skipFrames();
    }
    this._invalidate();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.stop();
    clearTimeout(this._rebuildTimer);
    clearTimeout(this._poseTimer);
    this._resizeObserver.disconnect();
    this._intersection.disconnect();
    for (const [target, type, fn, opts] of this._listeners) target.removeEventListener(type, fn, opts);
    this._listeners = [];
    this._controls.dispose();
    // builder3d.js shares some materials (and their textures) across every build made with this
    // kit and has no hook to release them, so whatever the last build used goes here too.
    const shared = this._built ? sceneResources(this._built.root) : this._orphans;
    if (this._built) this._disposeBuilt();
    this._built = null;
    disposeTree(this._ring);
    disposeTree(this._figure);
    this._kit.dispose();
    if (shared) {
      for (const m of shared.materials) m.dispose();
      for (const t of shared.textures) t.dispose();
    }
    this._postfx.dispose();
    if (this._envCapture) {
      if (this._scene.environment === this._envCapture.texture) this._scene.environment = null;
      this._envCapture.dispose?.();
      this._envCapture = null;
    }
    this._env.dispose();
    this._renderer.dispose();
    this._renderer.forceContextLoss();
    for (const el of [this._canvas, this._mini?.el, this._badge, this._failure]) el?.remove();
    const r = this._restore;
    if (r.tabindex) this.container.removeAttribute('tabindex');
    if (r.ariaLabel) this.container.removeAttribute('aria-label');
    if ('position' in r) this.container.style.position = r.position;
  }

  // ---- Setup -----------------------------------------------------------------------------

  _setupDom() {
    const c = this.container;
    if (getComputedStyle(c).position === 'static') {
      this._restore.position = c.style.position;
      c.style.position = 'relative';
    }
    if (!c.hasAttribute('tabindex')) {
      c.tabIndex = 0;
      this._restore.tabindex = true;
    }
    if (!c.hasAttribute('aria-label')) {
      this._restore.ariaLabel = true;
      c.setAttribute('aria-label', '3D walkthrough. Drag to look around, use W, A, S, D or the arrow keys to move, and click the floor to walk there.');
    }
    this._badge = styled('div', {
      position: 'absolute', right: '16px', bottom: '16px', zIndex: '3', display: 'flex', alignItems: 'center', gap: '8px',
      padding: '6px 12px 6px 10px', borderRadius: '999px', background: 'rgba(1, 42, 45, 0.88)', color: '#FFFFFF',
      font: `500 12px/16px ${FONT}`, letterSpacing: '0.01em', pointerEvents: 'none', userSelect: 'none',
      opacity: '0', transition: 'opacity 150ms ease',
    });
    this._badge.setAttribute('role', 'status');
    c.append(this._badge);
  }

  _setupRenderer() {
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this._baseRatio = Math.min(window.devicePixelRatio || 1, 2);
    this._motionRatio = this._baseRatio;
    renderer.setPixelRatio(this._baseRatio);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // AgX, applied once by the post-processing chain after the grade at every level (postfx.js
    // switches to the graded curve inside the materials where the chain cannot run).
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = EXPOSURE;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;
    this._renderer = renderer;
    this.renderer = renderer;
    const canvas = renderer.domElement;
    Object.assign(canvas.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block',
      touchAction: 'none', cursor: 'grab', outline: 'none', userSelect: 'none',
    });
    this._canvas = canvas;
    this.container.prepend(canvas);
  }

  _setupScene() {
    this._scene = new THREE.Scene();
    this._env = setupEnvironment(this._renderer, this._scene);
    this._kit = trackedKit();
    this._camera = new THREE.PerspectiveCamera(FOV.walk, 1, 0.05, 1500);
    this._camera.rotation.order = 'YXZ';
    this._orbitCam = new THREE.PerspectiveCamera(FOV.overview, 1, 0.1, 1500);
    this._tweenCam = new THREE.PerspectiveCamera(FOV.walk, 1, 0.05, 1500);
    this._ring = ringMesh();
    this._figure = walkerFigure();
    // UI drawn after post-processing, straight onto the canvas, so the accent keeps its exact color
    // (toneMapped: false) instead of being graded and tone mapped with the scene. Not in the scene,
    // so captures and photos never see it.
    this._overlay = new THREE.Scene();
    const key = new THREE.DirectionalLight(0xffffff, 7);
    key.position.set(0.5, 1, 0.8);
    // About as bright as the room lit the walker's body when it was part of the scene.
    this._overlay.add(this._ring, this._figure, new THREE.HemisphereLight(0xffffff, 0x445544, 8), key);
    this._postfx = createPostFX(this._renderer, this._scene, this._camera, {
      quality: this._quality,
      onReady: () => this._invalidate(),
      overlay: this._overlay,
    });
    this._quality = this._postfx.quality;
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();

    const controls = new OrbitControls(this._orbitCam, this._canvas);
    Object.assign(controls, {
      enabled: false, enableDamping: true, dampingFactor: 0.1, screenSpacePanning: false, zoomToCursor: true,
      minDistance: 2, maxDistance: 400, maxPolarAngle: deg2rad(86), rotateSpeed: 0.8,
    });
    controls.addEventListener('change', () => this._invalidate());
    controls.addEventListener('start', () => { this._canvas.style.cursor = 'grabbing'; });
    controls.addEventListener('end', () => { this._canvas.style.cursor = 'grab'; });
    this._controls = controls;
  }

  _setupMinimap() {
    const el = styled('canvas', {
      position: 'absolute', left: '16px', bottom: '16px', zIndex: '2', display: 'block', borderRadius: '10px',
      boxShadow: '0 6px 20px rgba(1, 42, 45, 0.18), 0 0 0 1px rgba(1, 42, 45, 0.10)',
      cursor: 'pointer', touchAction: 'none', opacity: '0', pointerEvents: 'none', transition: 'opacity 200ms ease',
    });
    el.title = 'Click a spot to go there';
    el.setAttribute('aria-hidden', 'true');
    this.container.append(el);
    this._mini = { el, ctx: el.getContext('2d'), cache: document.createElement('canvas'), view: null, enabled: false, shown: false, dpr: 1, down: null };
  }

  _setupInput() {
    this._listeners = [];
    const on = (target, type, fn, opts) => {
      const bound = fn.bind(this);
      target.addEventListener(type, bound, opts);
      this._listeners.push([target, type, bound, opts]);
    };
    const canvas = this._canvas;
    on(canvas, 'pointerdown', this._onPointerDown);
    on(canvas, 'pointermove', this._onPointerMove);
    on(canvas, 'pointerup', this._onPointerUp);
    on(canvas, 'pointercancel', this._onPointerCancel);
    on(canvas, 'lostpointercapture', this._onPointerCancel);
    on(canvas, 'pointerleave', this._onPointerLeave);
    on(canvas, 'dblclick', this._onDoubleClick);
    on(canvas, 'wheel', this._onWheel, { passive: false });
    on(canvas, 'contextmenu', (e) => e.preventDefault());
    on(this.container, 'keydown', this._onKeyDown);
    on(this.container, 'keyup', this._onKeyUp);
    on(this.container, 'focusout', this._onBlur);
    on(document, 'visibilitychange', this._onVisibility);
    on(this.store, 'change', this._onStoreChange);
    if (this._mini) {
      const el = this._mini.el;
      on(el, 'pointerdown', this._onMiniDown);
      on(el, 'pointerup', this._onMiniUp);
      on(el, 'pointercancel', () => { this._mini.down = null; });
      on(el, 'wheel', (e) => { e.preventDefault(); e.stopPropagation(); }, { passive: false });
      on(el, 'contextmenu', (e) => e.preventDefault());
    }
  }

  _setupObservers() {
    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(this.container);
    this._intersection = new IntersectionObserver((entries) => {
      this._visible = entries[entries.length - 1].isIntersecting;
      if (!this._visible) {
        this._resetInput();
        return;
      }
      if (this._stale && !this._rebuildTimer) this._autoRebuild();
      this._invalidate();
    });
    this._intersection.observe(this.container);
  }

  // ---- Rebuilds ----------------------------------------------------------------------------

  _onStoreChange(e) {
    if (e.detail?.replaced) this._resetPose = true;
    this._stale = true;
    clearTimeout(this._rebuildTimer);
    this._rebuildTimer = setTimeout(() => {
      this._rebuildTimer = 0;
      this._autoRebuild();
    }, REBUILD_DELAY);
  }

  /** Debounced rebuild. Skipped while hidden (done on start), and when only non-3D fields changed. */
  _autoRebuild() {
    if (!this._stale || this._disposed) return;
    if (!this._running || !this._visible) return;
    if (!this._resetPose && sceneKey(this.store.plan) === this._key) {
      this._stale = false;
      this._layoutMinimap();
      this._invalidate();
      return;
    }
    if (this._buildMs < SLOW_BUILD) {
      this.rebuild();
      return;
    }
    this._setBadge(true);
    requestAnimationFrame(() => setTimeout(() => {
      if (!this._disposed && this._stale) this.rebuild();
      this._setBadge(false);
    }, 0));
  }

  _setBadge(on) {
    const b = this._badge;
    if (on && !b.childElementCount) {
      const dot = styled('span', { width: '8px', height: '8px', borderRadius: '50%', background: ACCENT, flex: 'none' });
      b.append(dot, 'Updating...');
      dot.animate?.([{ opacity: 1 }, { opacity: 0.25 }], { duration: 650, iterations: Infinity, direction: 'alternate' });
    } else if (!on) {
      b.replaceChildren();
    }
    b.style.opacity = on ? '1' : '0';
  }

  /**
   * Reflections and ambient tint from the built interior, when builder3d.js offers a capture.
   * Until one succeeds the current environment stays.
   */
  _captureEnvironment(built) {
    const capture = builder.captureEnvironment;
    if (typeof capture !== 'function') return;
    let next = null;
    try {
      next = capture(this._renderer, this._scene, built);
    } catch (err) {
      console.warn('Could not capture the interior for reflections; keeping the previous environment.', err);
    } finally {
      this._renderer.setRenderTarget(null);
    }
    if (!next?.texture) {
      next?.dispose?.();
      return;
    }
    const prev = this._envCapture;
    this._envCapture = next;
    this._scene.environment = next.texture;
    prev?.dispose?.();
  }

  _disposeBuilt() {
    this._casters = [];
    this._built.dispose();
    for (const t of this._buildTextures) t.dispose();
    this._buildTextures = new Set();
  }

  /** The plan has no 3D scene: drop the previous one so it is not taken for this plan, and say why. */
  _buildFailed(plan, err) {
    console.error('Could not build the 3D view', err);
    for (const t of this._kit.takeTextures()) t.dispose();
    if (this._built) {
      // Kept for dispose(): the builder's shared materials the dropped scene used.
      this._orphans = sceneResources(this._built.root);
      this._disposeBuilt();
    }
    this._built = null;
    this._key = sceneKey(plan);
    this._stale = false;
    this._world = collisionWorld([], []);
    this._occluders = new Grid();
    this._cancelMotion();
    this._ring.visible = false;
    this._renderer.shadowMap.needsUpdate = true;
    this._layoutMinimap();
    this._showFailure(err);
    this._invalidate();
  }

  /** In-view message shown while the plan cannot be built; null hides it. */
  _showFailure(err) {
    if (!err) {
      this._failure?.remove();
      this._failure = null;
      return;
    }
    if (!this._failure) {
      this._failure = styled('div', {
        position: 'absolute', inset: '0', zIndex: '3', display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: '6px', padding: '24px', background: '#E8EFF2', color: TEXT, textAlign: 'center',
      });
      this._failure.setAttribute('role', 'alert');
      this.container.append(this._failure);
    }
    const title = styled('strong', { font: `600 16px/22px ${FONT}` });
    title.textContent = 'This plan could not be shown in 3D';
    const reason = styled('span', { maxWidth: '440px', font: `400 13px/18px ${FONT}`, overflowWrap: 'anywhere' });
    reason.textContent = err?.message || '';
    this._failure.replaceChildren(title, reason);
  }

  /** First saved camera, else the largest room or the plan center, moved to a free spot and facing the long axis. */
  _startPose(plan, built) {
    const cam = plan.cameras[0];
    if (cam) {
      const p = this._freeSpot(cam);
      return { x: p.x, y: p.y, yaw: normDeg(finite(cam.yaw, 0)), pitch: clamp(finite(cam.pitch, 0), -PITCH_LIMIT, PITCH_LIMIT) };
    }
    const b = built.bounds;
    let room = null;
    for (const r of plan.rooms) if (!room || polygonArea(r.points) > polygonArea(room.points)) room = r;
    const seed = room ? polygonCentroid(room.points) : { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    const region = room?.points || null;
    const p = findFree(this._world, seed, { region, clearance: 0.4 }) || findFree(this._world, seed, { region })
      || findFree(this._world, seed) || seed;
    const wide = b.maxX - b.minX >= b.maxY - b.minY;
    const options = wide ? [[90, 1, 0], [270, -1, 0]] : [[180, 0, 1], [0, 0, -1]];
    const [yaw] = options
      .map(([deg, dx, dy]) => [deg, clearDistance(this._world, p, dx, dy)])
      .sort((m, n) => n[1] - m[1])[0];
    return { x: p.x, y: p.y, yaw, pitch: 0 };
  }

  /** Where the walker can actually stand near p: pushed out of walls, or the nearest free spot. */
  _freeSpot(p) {
    if (!this._world || isFree(this._world, p.x, p.y)) return { x: p.x, y: p.y };
    const q = { x: p.x, y: p.y };
    pushOut(this._world, q, this._pose);
    if (isFree(this._world, q.x, q.y)) return q;
    return findFree(this._world, p, { maxRadius: 4 }) || { x: p.x, y: p.y };
  }

  _settlePose() {
    const p = this._freeSpot(this._pose);
    this._pose.x = p.x;
    this._pose.y = p.y;
  }

  // ---- Frame loop ------------------------------------------------------------------------

  _canRender() {
    return this._running && this._visible && !document.hidden && !this._disposed && this._size.w > 0 && this._size.h > 0;
  }

  /** Ask for a frame. At most one is ever pending; a request made during a frame queues the next one. */
  _kick() {
    if (this._inFrame) this._again = true;
    else if (!this._raf && this._canRender()) this._raf = requestAnimationFrame((t) => this._frame(t));
  }

  _invalidate() {
    this._dirty = true;
    this._kick();
  }

  _frame(now) {
    this._raf = 0;
    if (!this._canRender()) {
      this._last = 0;
      return;
    }
    const frameMs = this._last ? now - this._last : 0;
    const dt = Math.min(MAX_DT, frameMs / 1000);
    this._last = now;
    this._inFrame = true;
    this._again = false;
    const programs = this._renderer.info.programs;
    let active = false, heavy = false;
    try {
      active = this._update(dt);
      const moving = active || this._look?.moved || this._pinch;
      // Changing the 'fast' scene recompiles the lit materials, so it waits until the view is still.
      if (!moving) this._setFastScene(this._quality === 'fast');
      const ratio = moving ? this._motionRatio : this._baseRatio;
      if (this._renderer.getPixelRatio() !== ratio) {
        this._renderer.setPixelRatio(ratio);
        this._applySize();
      }
      if (active || this._dirty) {
        const compiled = programs.length;
        heavy = this._renderer.shadowMap.needsUpdate;
        this._render();
        heavy ||= programs.length > compiled;
      }
    } finally {
      this._inFrame = false;
    }
    if (active) {
      this._governor(frameMs);
      // Compiling shaders or redrawing the shadow map is not the cost of moving.
      if (heavy) this._skipFrames();
    } else {
      this._last = 0;
      // The first frames of the next motion carry the work of starting it.
      this._skipFrames();
    }
    if (active || this._again) this._kick();
  }

  /**
   * While moving stays slow, steps the quality down one level at a time (never above the chosen
   * level), and once at 'fast' lowers the pixel ratio used while moving. After a few seconds of
   * moving with headroom it undoes those steps one at a time, the pixel ratio first. Idle frames
   * keep the full pixel ratio.
   */
  _governor(frameMs) {
    if (!frameMs || frameMs > 5000) return;
    const g = this._perf;
    if (g.skip > 0) {
      g.skip--;
      return;
    }
    const ms = Math.min(frameMs, 250);
    g.since += ms;
    const win = g.win;
    win.push(ms);
    if (win.length > GOVERNOR_FRAMES) win.shift();
    if (win.length < GOVERNOR_FRAMES && (win.length < GOVERNOR_MIN_FRAMES || win.reduce((a, b) => a + b, 0) < GOVERNOR_SPAN)) return;
    const sorted = win.slice().sort((a, b) => a - b);
    // The lower median: more than half of the frames have to be slow.
    if (sorted[(sorted.length - 1) >> 1] > SLOW_FRAME) {
      g.calm = 0;
      this._stepDown();
    } else if (sorted[Math.ceil(sorted.length * 0.75) - 1] < HEADROOM_FRAME && this._lowered()) {
      g.calm += ms;
      if (g.calm >= g.upAfter) this._stepUp();
    } else {
      g.calm = 0;
    }
  }

  /** True while the governor has lowered the quality or the motion pixel ratio. */
  _lowered() {
    return this._quality !== this._chosenQuality || this._motionRatio < this._baseRatio;
  }

  _stepDown() {
    const g = this._perf;
    const lower = QUALITIES[QUALITIES.indexOf(this._quality) + 1];
    if (!lower && this._motionRatio <= MIN_RATIO) return;
    // A step up that did not hold: wait twice as long before the next try, so the level settles.
    if (g.since < STEP_UP_TRIAL) g.upAfter *= 2;
    g.since = Infinity;
    if (lower) this._applyQuality(lower, true);
    else this._setMotionRatio(Math.max(MIN_RATIO, Math.round(this._motionRatio * 80) / 100));
  }

  _stepUp() {
    this._perf.since = 0;
    // The pixel ratio comes back in one step; if that is too much, it steps down again in small ones.
    if (this._motionRatio < this._baseRatio) this._setMotionRatio(this._baseRatio);
    else this._applyQuality(QUALITIES[QUALITIES.indexOf(this._quality) - 1], true);
  }

  _setMotionRatio(ratio) {
    this._motionRatio = ratio;
    // The next frame reallocates the buffers at the new size.
    this._resetGovernor(SKIP_FRAMES);
  }

  /** Forget the frames measured so far: they say nothing about a new level or pixel ratio. */
  _resetGovernor(skip) {
    const g = this._perf;
    g.win.length = 0;
    g.calm = 0;
    g.skip = Math.max(g.skip, skip);
  }

  /** Leave the next frame times out: they carry work that is not the cost of moving. */
  _skipFrames() {
    this._perf.skip = Math.max(this._perf.skip, SKIP_FRAMES);
  }

  _applyQuality(quality, auto) {
    this._postfx.setQuality(quality);
    // The level postfx.js can draw here: 'fast' only, without WebGL 2.
    const level = this._postfx.quality;
    const changed = level !== this._quality;
    this._quality = level;
    // The first frames at a new level compile its shaders.
    this._resetGovernor(changed ? SKIP_FRAMES : 0);
    this.dispatchEvent(new CustomEvent('quality', { detail: { quality: level, chosen: this._chosenQuality, auto: auto || level !== quality } }));
    this._invalidate();
  }

  /**
   * In 'fast' the view also leaves out the window and fixture reflections (area lights, evaluated on
   * every pixel) and the items' sun shadows, so redrawing the shadow map (as when the ceilings
   * toggle) costs less. Each build starts with the full scene; rebuild() applies the level in use.
   */
  _setFastScene(on) {
    const built = this._built;
    if (!built || on === this._fastScene) return;
    this._fastScene = on;
    const daylight = built.root.userData.daylight;
    if (daylight) daylight.visible = !on;
    for (const mesh of this._casters) mesh.castShadow = !on;
    if (this._casters.length) this._renderer.shadowMap.needsUpdate = true;
    this._dirty = true;
  }

  _update(dt) {
    let active = false;
    if (this._tween) active = this._stepTween(dt);
    else if (this._mode === 'overview' && this._controls.update()) active = true;
    if (this._anim) active = this._stepAnim(dt) || active;
    if (this._mode === 'walk' && !this._tween) {
      active = this._stepWalk(dt) || active;
      active = this._stepInertia(dt) || active;
    }
    active = this._stepFov(dt) || active;
    if (this._poseDirty) this._poseChanged();
    active = this._stepExposure(dt) || active;
    this._updateRing(active);
    return active;
  }

  /** The exposure for the current view: metered in Walk (see METER), EXPOSURE in the overview. */
  _exposureTarget() {
    const L = this._built?.planLight;
    if (this._mode !== 'walk' || !L?.meter) return EXPOSURE;
    const p = this._pose, yaw = deg2rad(p.yaw);
    const m = L.meter(p.x, p.y, Math.sin(yaw), -Math.cos(yaw));
    const level = m.level + (METER.daylight - 1) * m.daylight;
    if (!(level > 0)) return EXPOSURE;
    return EXPOSURE * clamp((METER.reference / level) ** METER.strength, METER.range[0], METER.range[1]);
  }

  /**
   * Ease the exposure toward its target (at once after a jump). True while it is still easing; a
   * value set at once only marks this frame dirty, so it costs no extra frame.
   */
  _stepExposure(dt) {
    const r = this._renderer, target = this._exposureTarget(), cur = r.toneMappingExposure;
    const snap = this._snapExposure || Math.abs(target - cur) < 0.002 * target;
    this._snapExposure = false;
    if (cur === target) return false;
    r.toneMappingExposure = snap ? target : cur + (target - cur) * (1 - Math.exp(-dt / METER.ease));
    this._dirty = true;
    return !snap;
  }

  _render() {
    this._syncWalkCamera();
    this._postfx.render(this._activeCamera());
    this._dirty = false;
  }

  _activeCamera() {
    if (this._tween) return this._tweenCam;
    return this._mode === 'overview' ? this._orbitCam : this._camera;
  }

  _syncWalkCamera() {
    const c = this._camera, p = this._pose;
    c.position.set(p.x, EYE, p.y);
    c.rotation.set(deg2rad(p.pitch), -deg2rad(p.yaw), 0, 'YXZ');
    if (c.fov !== this._fov) {
      c.fov = this._fov;
      c.updateProjectionMatrix();
    }
    c.updateMatrixWorld();
  }

  _syncFigure() {
    const f = this._figure;
    f.position.set(this._pose.x, 0, this._pose.y);
    f.rotation.y = -deg2rad(this._pose.yaw);
  }

  /** Match the canvas to the container. Returns false while the container has no size. */
  _applySize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return false;
    const ratio = this._renderer.getPixelRatio();
    const s = this._size;
    if (s.w === w && s.h === h && s.ratio === ratio) return true;
    this._size = { w, h, ratio };
    this._renderer.setSize(w, h, false);
    this._postfx.setSize(w, h, ratio);
    for (const cam of [this._camera, this._orbitCam, this._tweenCam]) {
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }
    this._dirty = true;
    return true;
  }

  _setCeilings(visible, force = false) {
    if (!this._built || (!force && visible === this._ceilingsShown)) return;
    this._ceilingsShown = visible;
    for (const c of this._built.ceilings) c.visible = visible;
    this._renderer.shadowMap.needsUpdate = true;
  }

  // ---- Motion ------------------------------------------------------------------------------

  _touchPose() {
    this._poseDirty = true;
  }

  _move(dx, dy) {
    const moved = moveWithCollisions(this._world, this._pose, dx, dy);
    if (moved > 1e-7) this._touchPose();
    return moved;
  }

  _stepWalk(dt) {
    const k = this._keys;
    const f = (k.has('forward') ? 1 : 0) - (k.has('back') ? 1 : 0);
    const s = (k.has('right') ? 1 : 0) - (k.has('left') ? 1 : 0);
    const turn = (k.has('turnRight') ? 1 : 0) - (k.has('turnLeft') ? 1 : 0);
    let active = f !== 0 || s !== 0 || turn !== 0;
    if (turn) {
      this._pose.yaw = normDeg(this._pose.yaw + turn * SPEED.turn * dt);
      this._touchPose();
    }
    const yaw = deg2rad(this._pose.yaw);
    let tx = Math.sin(yaw) * f + Math.cos(yaw) * s;
    let ty = -Math.cos(yaw) * f + Math.sin(yaw) * s;
    const l = Math.hypot(tx, ty);
    if (l > 0) {
      const speed = this._run ? SPEED.run : SPEED.walk;
      tx = (tx / l) * speed;
      ty = (ty / l) * speed;
    }
    const v = this._vel;
    const a = 1 - Math.exp(-ACCEL * dt);
    v.x += (tx - v.x) * a;
    v.y += (ty - v.y) * a;
    if (!l && Math.hypot(v.x, v.y) < 0.03) v.x = v.y = 0;
    if (v.x || v.y) {
      this._move(v.x * dt, v.y * dt);
      active = true;
    }
    if (this._glide) active = this._stepGlide(dt) || active;
    return active;
  }

  _stepGlide(dt) {
    const g = this._glide, p = this._pose;
    const dx = g.x - p.x, dy = g.y - p.y, d = Math.hypot(dx, dy);
    if (d < 0.03) {
      this._glide = null;
      return true;
    }
    const want = Math.min(SPEED.glide, Math.sqrt(2 * 2.5 * d));
    g.speed = Math.min(want, g.speed + 3.5 * dt);
    const step = Math.min(d, g.speed * dt);
    const moved = this._move((dx / d) * step, (dy / d) * step);
    g.stuck = step > 0 && moved < step * 0.3 ? g.stuck + dt : 0;
    if (g.stuck > 0.3) this._glide = null;
    return true;
  }

  _stepAnim(dt) {
    const a = this._anim, p = this._pose;
    a.t = Math.min(1, a.t + dt / a.dur);
    const e = easeInOut(a.t);
    p.x = a.from.x + (a.to.x - a.from.x) * e;
    p.y = a.from.y + (a.to.y - a.from.y) * e;
    p.yaw = normDeg(a.from.yaw + a.dyaw * e);
    p.pitch = a.from.pitch + (a.to.pitch - a.from.pitch) * e;
    if (a.t >= 1) {
      Object.assign(p, a.to);
      this._anim = null;
      if (a.camera) this._emitCamera(a.camera, false);
    }
    this._touchPose();
    return true;
  }

  /** End a goTo transition early. Its straight path ignores walls, so settle on a spot the walker can stand on. */
  _stopAnim() {
    const a = this._anim;
    if (!a) return;
    this._anim = null;
    this._settlePose();
    this._touchPose();
    if (a.camera) this._emitCamera(null, false);
  }

  _emitCamera(id, arriving) {
    this.dispatchEvent(new CustomEvent('camera', { detail: { id, arriving } }));
  }

  _stepInertia(dt) {
    const v = this._inertia;
    if (!v) return false;
    this._turnView(v.yaw * dt, v.pitch * dt);
    const decay = Math.exp(-7 * dt);
    v.yaw *= decay;
    v.pitch *= decay;
    if (Math.hypot(v.yaw, v.pitch) < 2) this._inertia = null;
    return true;
  }

  _stepFov(dt) {
    const d = this._fovTarget - this._fov;
    if (Math.abs(d) < 0.02) {
      if (d) {
        this._fov = this._fovTarget;
        this._dirty = true;
      }
      return false;
    }
    this._fov += d * (1 - Math.exp(-14 * dt));
    this._dirty = true;
    return true;
  }

  _stepTween(dt) {
    const tw = this._tween, cam = this._tweenCam;
    if (tw.to === this._camera) this._syncWalkCamera();
    tw.t = Math.min(1, tw.t + dt / TRANSITION);
    const e = easeInOut(tw.t);
    cam.position.lerpVectors(tw.from.pos, tw.to.position, e);
    cam.quaternion.slerpQuaternions(tw.from.quat, tw.to.quaternion, e);
    cam.fov = tw.from.fov + (tw.to.fov - tw.from.fov) * e;
    cam.near = tw.to.near;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this._setCeilings(cam.position.y < this._ceilTop);
    if (tw.t >= 1) this._finishMode();
    return true;
  }

  _finishMode() {
    this._tween = null;
    const overview = this._mode === 'overview';
    this._controls.enabled = overview;
    this._figure.visible = overview;
    this._setCeilings(!overview);
    this._showMinimap(!overview);
    this._syncFigure();
    this._dirty = true;
  }

  /** Place the orbit camera behind the walker's view direction, looking down at the plan center. */
  _frameOverview() {
    if (!this._built) return;
    const b = this._built.bounds;
    const target = new THREE.Vector3((b.minX + b.maxX) / 2, 0, (b.minY + b.maxY) / 2);
    const yaw = deg2rad(this._pose.yaw), elev = deg2rad(OVERVIEW_ELEVATION);
    const dir = new THREE.Vector3(-Math.sin(yaw) * Math.cos(elev), Math.sin(elev), Math.cos(yaw) * Math.cos(elev));
    const controls = this._controls;
    controls.enableDamping = false;
    controls.update();
    const dist = fitDistance(this._orbitCam, target, dir, { ...b, top: this._ceilTop - 1.2 });
    controls.target.copy(target);
    controls.maxDistance = Math.max(30, dist * 3);
    controls.update();
    controls.enableDamping = true;
    this._orbitCam.updateMatrixWorld();
  }

  _cancelMotion() {
    this._stopAnim();
    this._glide = null;
    this._inertia = null;
    this._vel.x = this._vel.y = 0;
  }

  _resetInput() {
    this._keys.clear();
    this._run = false;
    this._look = null;
    this._pinch = null;
    this._click = null;
    this._pointers.clear();
    this._hoverPos = null;
  }

  _turnView(dyaw, dpitch) {
    const p = this._pose;
    p.yaw = normDeg(p.yaw + dyaw);
    p.pitch = clamp(p.pitch + dpitch, -PITCH_LIMIT, PITCH_LIMIT);
    this._touchPose();
  }

  // ---- Pose events -------------------------------------------------------------------------

  /** Sync everything that follows the pose and emit a throttled 'pose' event. */
  _poseChanged() {
    this._poseDirty = false;
    this._dirty = true;
    this._syncFigure();
    this._drawMinimap();
    const now = performance.now();
    if (now - this._poseAt >= POSE_INTERVAL) this._flushPose();
    else if (!this._poseTimer) this._poseTimer = setTimeout(() => this._flushPose(), POSE_INTERVAL - (now - this._poseAt));
  }

  _flushPose() {
    clearTimeout(this._poseTimer);
    this._poseTimer = 0;
    this._poseAt = performance.now();
    this.dispatchEvent(new CustomEvent('pose', { detail: this.pose }));
  }

  // ---- Floor picking and the target ring -------------------------------------------------------

  _pickFloor(clientX, clientY, camera) {
    if (!this._built) return null;
    const rect = this._canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this._ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this._raycaster.setFromCamera(this._ndc, camera);
    const hit = this._raycaster.intersectObjects(this._built.walkable, false)[0];
    return hit ? { x: hit.point.x, y: hit.point.z } : null;
  }

  /** Floor point under the cursor that the walker can see and head toward, or null. */
  _walkTarget(clientX, clientY) {
    this._syncWalkCamera();
    const p = this._pickFloor(clientX, clientY, this._camera);
    if (!p || !this._lineOfSight(p)) return null;
    return p;
  }

  /** True when nothing (a wall, a door leaf or a tall item) hides plan point p from the walker's eye. */
  _lineOfSight(p) {
    const a = this._pose;
    const minX = Math.min(a.x, p.x) - 0.1, minY = Math.min(a.y, p.y) - 0.1;
    const maxX = Math.max(a.x, p.x) + 0.1, maxY = Math.max(a.y, p.y) + 0.1;
    for (const e of this._world.query(minX, minY, maxX, maxY, _near)) {
      if (e.seg && segmentIntersection(a, p, e.a, e.b)) return false;
    }
    for (const o of this._occluders.query(minX, minY, maxX, maxY, _near)) {
      const span = clipConvex(a.x, a.y, p.x, p.y, o.pts, o.sign);
      if (!span) continue;
      if (span[1] > 0.999) return false;
      const hi = EYE * (1 - span[0]), lo = EYE * (1 - span[1]);
      if (lo < o.top && hi > o.bottom) return false;
    }
    return true;
  }

  _updateRing(active) {
    const ring = this._ring;
    let show = false;
    if (this._mode === 'walk' && !this._tween) {
      if (this._glide) {
        const d = Math.hypot(this._glide.x - this._pose.x, this._glide.y - this._pose.y);
        ring.position.set(this._glide.x, 0.012, this._glide.y);
        this._ringOpacity(clamp(d / 0.5, 0, 1));
        show = true;
      } else if (this._hoverPos && !this._pointers.size) {
        if (this._hoverMoved || active || !ring.visible) {
          const p = this._walkTarget(this._hoverPos.x, this._hoverPos.y);
          if (p) {
            ring.position.set(p.x, 0.012, p.y);
            this._ringOpacity(1);
          }
          this._ringHit = !!p;
          this._dirty = true;
        }
        show = this._ringHit;
      }
    }
    this._hoverMoved = false;
    if (ring.visible !== show) {
      ring.visible = show;
      this._dirty = true;
    }
  }

  _ringOpacity(k) {
    const [ringMat, discMat] = this._ring.userData.mats;
    ringMat.opacity = 0.75 * k;
    discMat.opacity = 0.14 * k;
  }

  _startGlide(p) {
    const target = { x: p.x, y: p.y };
    pushOut(this._world, target, this._pose);
    this._cancelMotion();
    if (reducedMotion()) {
      this._move(target.x - this._pose.x, target.y - this._pose.y);
      this._poseChanged();
    } else {
      this._glide = { x: target.x, y: target.y, speed: 0, stuck: 0 };
    }
    this._invalidate();
  }

  // ---- Pointer input ---------------------------------------------------------------------------

  _onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0 && this._mode === 'walk') return;
    this.container.focus({ preventScroll: true });
    e.preventDefault();
    if (this._mode === 'overview' || this._tween) {
      this._click = this._tween ? null : { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, button: e.button, type: e.pointerType };
      return;
    }
    this._canvas.setPointerCapture?.(e.pointerId);
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this._stopAnim();
    this._inertia = null;
    if (this._pointers.size === 2) {
      const [p, q] = [...this._pointers.values()];
      this._pinch = { d: Math.hypot(p.x - q.x, p.y - q.y) || 1, fov: this._fovTarget };
      if (this._look) this._look.moved = true;
    } else if (this._pointers.size === 1) {
      this._look = {
        id: e.pointerId, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, t: e.timeStamp,
        moved: false, slop: SLOP[e.pointerType] || 4, vyaw: 0, vpitch: 0,
      };
    }
    this._invalidate();
  }

  _onPointerMove(e) {
    if (this._mode === 'overview' || this._tween) return;
    const ptr = this._pointers.get(e.pointerId);
    if (!ptr) {
      if (e.pointerType !== 'touch') {
        this._hoverPos = { x: e.clientX, y: e.clientY };
        this._hoverMoved = true;
        this._invalidate();
      }
      return;
    }
    ptr.x = e.clientX;
    ptr.y = e.clientY;
    if (this._pinch && this._pointers.size >= 2) {
      const [p, q] = [...this._pointers.values()];
      const d = Math.hypot(p.x - q.x, p.y - q.y) || 1;
      this._fovTarget = this._fov = clamp(this._pinch.fov * (this._pinch.d / d), FOV.min, FOV.max);
      this._invalidate();
      return;
    }
    const look = this._look;
    if (!look || look.id !== e.pointerId) return;
    if (!look.moved && Math.hypot(e.clientX - look.sx, e.clientY - look.sy) > look.slop) {
      look.moved = true;
      this._canvas.style.cursor = 'grabbing';
    }
    if (!look.moved) return;
    const k = this._fov / Math.max(1, this._size.h);
    const dyaw = -(e.clientX - look.x) * k, dpitch = (e.clientY - look.y) * k;
    const dt = Math.max(1, e.timeStamp - look.t) / 1000;
    look.vyaw = look.vyaw * 0.5 + (dyaw / dt) * 0.5;
    look.vpitch = look.vpitch * 0.5 + (dpitch / dt) * 0.5;
    look.x = e.clientX;
    look.y = e.clientY;
    look.t = e.timeStamp;
    this._turnView(dyaw, dpitch);
    this._invalidate();
  }

  _onPointerUp(e) {
    if (this._mode === 'overview' || this._tween) {
      this._overviewClick(e);
      return;
    }
    const ptr = this._pointers.get(e.pointerId);
    if (!ptr) return;
    this._pointers.delete(e.pointerId);
    if (this._canvas.hasPointerCapture?.(e.pointerId)) this._canvas.releasePointerCapture(e.pointerId);
    if (this._pinch) {
      if (this._pointers.size < 2) this._pinch = null;
      if (this._pointers.size === 1) {
        const [[id, p]] = [...this._pointers.entries()];
        this._look = { id, sx: p.x, sy: p.y, x: p.x, y: p.y, t: e.timeStamp, moved: true, slop: 0, vyaw: 0, vpitch: 0 };
      } else {
        this._look = null;
      }
      return;
    }
    const look = this._look;
    if (!look || look.id !== e.pointerId) return;
    this._look = null;
    this._canvas.style.cursor = 'grab';
    if (!look.moved) {
      const p = this._walkTarget(e.clientX, e.clientY);
      if (p) this._startGlide(p);
    } else if (e.timeStamp - look.t < 80 && Math.hypot(look.vyaw, look.vpitch) > 30 && !reducedMotion()) {
      const cap = (v) => clamp(v, -360, 360);
      this._inertia = { yaw: cap(look.vyaw), pitch: cap(look.vpitch) };
    }
    if (e.pointerType !== 'touch') {
      this._hoverPos = { x: e.clientX, y: e.clientY };
      this._hoverMoved = true;
    }
    this._invalidate();
  }

  _onPointerCancel(e) {
    if (!this._pointers.has(e.pointerId)) return;
    this._pointers.delete(e.pointerId);
    if (this._pointers.size < 2) this._pinch = null;
    if (this._look?.id === e.pointerId) this._look = null;
    this._canvas.style.cursor = 'grab';
  }

  _onPointerLeave() {
    if (!this._hoverPos) return;
    this._hoverPos = null;
    this._invalidate();
  }

  /** Overview: a still click on the floor moves the walker there. */
  _overviewClick(e) {
    const c = this._click;
    this._click = null;
    if (!c || c.id !== e.pointerId || c.button !== 0 || this._tween) return;
    if (Math.hypot(e.clientX - c.x, e.clientY - c.y) > (SLOP[c.type] || 4) || e.timeStamp - c.t > 500) return;
    const p = this._pickFloor(e.clientX, e.clientY, this._orbitCam);
    if (p) this.goTo({ x: p.x, y: p.y, yaw: this._pose.yaw, pitch: 0 });
  }

  _onDoubleClick(e) {
    if (this._mode !== 'overview' || this._tween) return;
    const p = this._pickFloor(e.clientX, e.clientY, this._orbitCam);
    if (!p) return;
    this.goTo({ x: p.x, y: p.y, yaw: this._pose.yaw, pitch: 0 }, { animate: false });
    this.setMode('walk');
  }

  _onWheel(e) {
    if (this._mode !== 'walk' || this._tween) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    this._fovTarget = clamp(this._fovTarget * Math.exp(clamp(dy, -200, 200) * 0.0012), FOV.min, FOV.max);
    this._invalidate();
  }

  // ---- Keyboard ------------------------------------------------------------------------------

  _onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target !== this.container && e.target.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    this._run = e.shiftKey;
    const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
    if (digit) {
      e.preventDefault();
      const cam = this.store.plan.cameras[+digit[1] - 1];
      if (cam && !e.repeat) this.goToCamera(cam.id);
      return;
    }
    const move = MOVE_KEYS[e.code];
    if (!move || this._mode !== 'walk') return;
    e.preventDefault();
    if (!this._keys.has(move)) {
      this._keys.add(move);
      this._glide = null;
      this._stopAnim();
    }
    this._invalidate();
  }

  _onKeyUp(e) {
    this._run = e.shiftKey;
    const move = MOVE_KEYS[e.code];
    if (move) this._keys.delete(move);
  }

  _onBlur() {
    this._keys.clear();
    this._run = false;
  }

  _onVisibility() {
    if (document.hidden) this._resetInput();
    else this._invalidate();
  }

  // ---- Minimap -------------------------------------------------------------------------------

  _layoutMinimap() {
    const m = this._mini;
    if (!m) return;
    const plan = this.store.plan;
    const { w: W, h: H } = this._size;
    const b = planBounds(plan, { underlay: false });
    m.enabled = !!this._built && (plan.walls.length > 0 || plan.rooms.length > 0) && Number.isFinite(b.minX) && W >= 420 && H >= 320;
    if (!m.enabled) {
      this._showMinimap(false);
      return;
    }
    const pad = 12;
    const maxW = W < 760 ? 170 : 224, maxH = H < 560 ? 128 : 180;
    const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY);
    let w = maxW, h = (maxW - pad * 2) * (bh / bw) + pad * 2;
    if (h > maxH) {
      h = maxH;
      w = Math.max(110, (maxH - pad * 2) * (bw / bh) + pad * 2);
    }
    w = Math.round(w);
    h = Math.round(Math.max(h, 80));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    m.dpr = dpr;
    for (const c of [m.el, m.cache]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    m.el.style.width = `${w}px`;
    m.el.style.height = `${h}px`;
    m.view = fitView(b, w, h, pad);
    const cctx = m.cache.getContext('2d');
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cctx.clearRect(0, 0, w, h);
    renderPlan(cctx, plan, m.view, { mini: true, showGrid: false, showUnderlay: false });
    this._showMinimap(this._mode === 'walk' && !this._tween);
    this._drawMinimap();
  }

  _drawMinimap() {
    const m = this._mini;
    if (!m?.enabled || !m.view) return;
    const { ctx, dpr, view } = m;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, m.el.width, m.el.height);
    ctx.drawImage(m.cache, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const p = this._pose;
    renderPlan(ctx, EMPTY_PLAN, view, { mini: true, background: null, showGrid: false, showUnderlay: false, showLabels: false, walker: { x: p.x, y: p.y, yaw: p.yaw } });
  }

  /** Show or hide the minimap overlay, for example when a 2D plan is already visible beside the view. */
  setMinimap(on) {
    this._miniAllowed = on;
    this._showMinimap(this._mode === 'walk' && !this._tween);
  }

  _showMinimap(on) {
    const m = this._mini;
    if (!m) return;
    const show = on && m.enabled && this._miniAllowed !== false;
    if (show === m.shown) return;
    m.shown = show;
    m.el.style.opacity = show ? '1' : '0';
    m.el.style.pointerEvents = show ? 'auto' : 'none';
  }

  _onMiniDown(e) {
    e.preventDefault();
    e.stopPropagation();
    this.container.focus({ preventScroll: true });
    this._mini.el.setPointerCapture?.(e.pointerId);
    this._mini.down = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }

  _onMiniUp(e) {
    e.stopPropagation();
    const m = this._mini, down = m.down;
    m.down = null;
    if (!down || down.id !== e.pointerId || !m.view || this._mode !== 'walk' || this._tween) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
    const rect = m.el.getBoundingClientRect();
    const p = toPlan(m.view, e.clientX - rect.left, e.clientY - rect.top);
    this.goTo({ x: p.x, y: p.y, yaw: this._pose.yaw, pitch: this._pose.pitch });
  }
}
