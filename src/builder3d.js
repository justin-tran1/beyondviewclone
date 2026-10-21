// Plan to Three.js scene: walls with openings, floors, ceilings, furnished items and the exterior.
// Static geometry is written straight into per-material buckets and merged at the end, so large
// plans stay at a few dozen draw calls. Contract: docs/architecture.md (builder3d.js).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { OPENING_TYPES } from './model.js';
import {
  add, sub, dot, norm, clamp, cross, samePoint, wallLength, wallDir, openingSpan, pointOnWall, pointInPolygon,
  polygonArea, polygonSignedArea, polygonCentroid, boundsOf, unionBounds, emptyBounds, itemCorners, normDeg,
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
const SUN_DIR = new THREE.Vector3(-0.48, 0.8, 0.36).normalize();

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
  const owned = { geometries: [], materials: [], textures: [] };
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
  for (const o of loose) disposeObject(o);
  owned.geometries.length = owned.materials.length = owned.textures.length = loose.length = 0;
}

function buildScene(ctx) {
  const root = new THREE.Group();
  root.name = 'plan-scene';
  const structure = namedGroup('structure');
  const ceilings = namedGroup('ceilings');
  const exterior = namedGroup('exterior');
  const shading = namedGroup('shading');

  buildWalls(ctx);
  buildFloors(ctx);
  buildCeilings(ctx);
  buildItems(ctx);
  buildExterior(ctx, exterior);

  flush(ctx.main, structure, ctx.owned);
  const walkable = flush(ctx.floors, structure, ctx.owned);
  walkable.push(buildSlab(ctx, structure));
  flush(ctx.ceil, ceilings, ctx.owned);
  for (const m of flush(ctx.fx, shading, ctx.owned)) m.renderOrder = -1;
  flush(ctx.ext, exterior, ctx.owned);
  for (const o of ctx.loose) structure.add(o);

  root.add(exterior, structure, shading, ceilings);
  root.userData.horizon = exterior.userData.horizon;
  root.updateMatrixWorld(true);

  return {
    root,
    walkable,
    colliders: ctx.colliders,
    obstacles: ctx.obstacles,
    ceilings: [ceilings],
    bounds: { ...ctx.bounds },
    dispose() {
      root.removeFromParent();
      release(ctx.owned, ctx.loose);
    },
  };
}

/** Image based lighting, sky fill and a warm shadow casting sun. fit(bounds) re-aims the sun. */
export function setupEnvironment(renderer, scene) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment(renderer);
  const env = pmrem.fromScene(room, 0.04);
  room.dispose();
  pmrem.dispose();
  scene.environment = env.texture;
  // Matches the sky dome's horizon, in case a short camera far plane clips the dome.
  const background = scene.background ? null : new THREE.Color('#e8eff2');
  if (background) scene.background = background;

  const hemi = new THREE.HemisphereLight('#eef3f8', '#e2dcd1', 1.0);
  hemi.name = 'sky-fill';
  const sun = new THREE.DirectionalLight('#fff1dc', 2.2);
  sun.name = 'sun';
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 2;
  scene.add(hemi, sun, sun.target);

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
      sun.dispose();
      if (scene.environment === env.texture) scene.environment = null;
      if (background && scene.background === background) scene.background = null;
      env.dispose();
    },
  };
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
    floors: createBuckets(),
    ceil: createBuckets(),
    fx: createBuckets(),
    ext: createBuckets(),
    colliders: [],
    obstacles: [],
    lights: 0,
    fixtures: MAX_FIXTURES,
    itemVerts: 0,
    unit: new Map(),
    tints: new Map(),
  };
  ctx.mats = createMaterials(kit, owned);
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

function createMaterials(kit, owned) {
  const own = (m) => (owned.materials.push(m), m);
  const cache = {};
  const textured = {
    tile: () => new THREE.MeshStandardMaterial({ map: acquireTexture(owned, 'ceiling-tile'), roughness: 0.95, envMapIntensity: 0.75 }),
    diffuser: () => new THREE.MeshStandardMaterial({ map: acquireTexture(owned, 'diffuser'), roughness: 0.55, envMapIntensity: 0.6 }),
    paving: () => new THREE.MeshStandardMaterial({ map: acquireTexture(owned, 'paving'), roughness: 0.92 }),
    grass: () => new THREE.MeshStandardMaterial({ map: acquireTexture(owned, 'grass'), roughness: 1 }),
    neutral: () => new THREE.MeshStandardMaterial({ color: '#d7dad9', roughness: 0.95 }),
    facadeGlass: () => new THREE.MeshStandardMaterial({ map: acquireTexture(owned, 'facade-glass'), roughness: 0.4, metalness: 0.1 }),
    facadePrecast: () => new THREE.MeshStandardMaterial({ map: acquireTexture(owned, 'facade-precast'), roughness: 0.85 }),
    asphalt: () => new THREE.MeshStandardMaterial({ map: acquireTexture(owned, 'asphalt'), roughness: 0.9 }),
    deck: () => new THREE.MeshStandardMaterial({ map: acquireTexture(owned, 'deck'), roughness: 0.9, metalness: 0.15 }),
    aoFloor: () => shadeMaterial(owned, 0.28),
    aoWall: () => shadeMaterial(owned, 0.14),
    aoCeiling: () => shadeMaterial(owned, 0.16),
    blob: () => shadeMaterial(owned, 0.42),
  };
  return {
    paint: kit.material('#f3f1ec', { roughness: 0.9, envMapIntensity: 0.6 }),
    facade: kit.material('#d5d8d5', { roughness: 0.85 }),
    cut: kit.material('#435254', { roughness: 0.9 }),
    base: kit.material('#3a4143', { roughness: 0.7 }),
    frame: kit.material('#5f696c', { roughness: 0.45, metalness: 0.3 }),
    alu: kit.material('#c6cbce', { roughness: 0.38, metalness: 0.55 }),
    leaf: kit.mat.oak,
    handle: kit.mat.chrome,
    sill: kit.mat.quartz,
    cap: kit.mat.oak,
    glass: kit.glass,
    frosted: kit.frostedGlass,
    drywall: kit.material('#f6f6f3', { roughness: 0.95, envMapIntensity: 0.75 }),
    trim: kit.material('#f1f1ee', { roughness: 0.5 }),
    led: kit.mat.led,
    deck: kit.material('#353d40', { roughness: 0.95 }),
    beam: kit.material('#2b3235', { roughness: 0.8, metalness: 0.2 }),
    duct: kit.material('#a9b0b3', { roughness: 0.42, metalness: 0.6 }),
    pendant: kit.mat.black,
    sprinkler: kit.mat.chrome,
    trunk: kit.material('#6a5646', { roughness: 0.95 }),
    leaves: [kit.material('#5c7d4c', { roughness: 0.9 }), kit.material('#6d8f56', { roughness: 0.9 }), kit.material('#4f6f45', { roughness: 0.9 })],
    roof: kit.material('#9da3a5', { roughness: 0.9 }),
    get(name) {
      return cache[name] || (cache[name] = own(textured[name]()));
    },
  };
}

/** Unlit dark overlay whose alpha comes from the shared falloff texture: fake ambient occlusion. */
function shadeMaterial(owned, opacity) {
  return new THREE.MeshBasicMaterial({
    color: '#1d2527', alphaMap: acquireTexture(owned, 'falloff'), transparent: true, opacity, depthWrite: false,
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
  'ceiling-tile': () => canvasTexture(512, 512, drawCeilingTile, [1 / TILE, 1 / TILE]),
  diffuser: () => canvasTexture(256, 256, drawDiffuser),
  paving: () => canvasTexture(512, 512, drawPaving, [1 / 4.8, 1 / 4.8]),
  grass: () => canvasTexture(512, 512, drawGrass, [1 / 9, 1 / 9]),
  'facade-glass': () => canvasTexture(256, 256, drawGlassFacade, [1 / 3, 1 / 4]),
  'facade-precast': () => canvasTexture(256, 256, drawPrecastFacade, [1 / 3, 1 / 4]),
  asphalt: () => canvasTexture(256, 256, drawAsphalt, [1 / 4, 1 / 4]),
  deck: () => canvasTexture(256, 64, drawDeck, [1 / (4 * 0.1524), 1]),
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
        const f = { top: b, s0: b, s1: b, [side > 0 ? 'pu' : 'nu']: b };
        if (side > 0) box(F, f, s0, s1, ht, ht + BASE.out, 0, BASE.h);
        else box(F, f, s0, s1, -ht - BASE.out, -ht, 0, BASE.h);
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
  const ht = w.thickness / 2, band = 0.35;
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
    const u0 = side * (ht + 0.0015), u1 = side * ht, u2 = side * (ht + band), yc = h - 0.0015;
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
  const f = noBottom(b);
  box(F, f, start - CASING.out, start + CASING.in, -u, u, 0, head);
  box(F, f, end - CASING.in, end + CASING.out, -u, u, 0, head);
  if (head > oh - CASING.in + 0.001) box(F, all(b), start + CASING.in, end - CASING.in, -u, u, oh - CASING.in, head);
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
  box(LF, all(ctx.main.get(ctx.mats.leaf)), 0, width, -LEAF_T / 2, LEAF_T / 2, y0, y1);
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
  const alu = all(ctx.main.get(ctx.mats.alu, !ctx.low));
  const st = stiles ? 0.07 : 0, bottom = stiles ? 0.18 : 0.09, face = stiles ? 0.02 : 0.006;
  box(LF, faces2(ctx.main.get(ctx.mats.glass, false)), st, width - st, -0.006, 0.006, y0 + bottom, y1 - 0.06);
  box(LF, alu, 0, width, -0.02, 0.02, y0, y0 + bottom);
  box(LF, alu, 0, width, -0.02, 0.02, y1 - 0.06, y1);
  if (stiles) {
    box(LF, alu, 0, st, -0.02, 0.02, y0 + bottom, y1 - 0.06);
    box(LF, alu, width - st, width, -0.02, 0.02, y0 + bottom, y1 - 0.06);
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
  box(F, all(alu), s0, s1, -0.05, 0.05, trackBottom, trackTop);
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
  glassPanel(ctx, F, fixed[0], fixed[1], -side * 0.022, 0.008, trackBottom);
  glassPanel(ctx, F, moving[0], moving[1], side * 0.022, 0.008, trackBottom);
  const lead = fixedAtStart ? moving[1] - 0.06 : moving[0] + 0.06;
  const u = side * 0.022;
  const PF = { o: { x: F.o.x + F.n.x * u, y: F.o.y + F.n.y * u }, d: F.d, n: F.n };
  pullBar(ctx, PF, lead, 0.0175, Math.min(1.45, trackBottom - 0.2), [side]);
}

/** Framed glass panel centered at uc: stiles, rails and a glass light. */
function glassPanel(ctx, F, s0, s1, uc, y0, y1) {
  const alu = ctx.main.get(ctx.mats.alu, !ctx.low);
  const g = ctx.main.get(ctx.mats.glass, false);
  const t = 0.0175, st = 0.045;
  box(F, all(alu), s0, s0 + st, uc - t, uc + t, y0, y1);
  box(F, all(alu), s1 - st, s1, uc - t, uc + t, y0, y1);
  box(F, all(alu), s0 + st, s1 - st, uc - t, uc + t, y0, y0 + 0.09);
  box(F, all(alu), s0 + st, s1 - st, uc - t, uc + t, y1 - 0.06, y1);
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
  const fr = all(B.get(M.alu, !ctx.low));
  box(F, fr, start, start + fw, u0, u1, sill, top);
  box(F, fr, end - fw, end, u0, u1, sill, top);
  box(F, fr, start + fw, end - fw, u0, u1, sill, sill + fw);
  box(F, fr, start + fw, end - fw, u0, u1, top - fw, top);
  const bays = clamp(Math.round((end - start) / MULLION_STEP), 1, 200);
  const bay = (end - start - 2 * fw) / bays;
  for (let k = 1; k < bays; k++) {
    const s = start + fw + k * bay;
    box(F, fr, s - 0.025, s + 0.025, u0 + 0.01, u1 - 0.01, sill + fw, top - fw);
  }
  box(F, faces2(B.get(M.glass, false)), start + fw, end - fw, uc - 0.005, uc + 0.005, sill + fw, top - fw);

  if (sill < 0.05) return;
  const ledge = all(B.get(M.sill, !ctx.low));
  for (const side of inner !== 0 ? [inner] : [1, -1]) {
    if (side > 0) box(F, ledge, start - 0.04, end + 0.04, uc, ht + 0.035, sill, sill + 0.025);
    else box(F, ledge, start - 0.04, end + 0.04, -ht - 0.035, uc, sill, sill + 0.025);
  }
}

/** Glass partition: aluminum head and base, mullions about every 1.5 m, a frosted privacy band, glass doors. */
function glassWall(ctx, info) {
  const { w, L, F, ext, spans } = info;
  const { main: B, mats: M } = ctx;
  const ht = w.thickness / 2, H = w.height;
  const head = 0.05, foot = 0.07;
  const alu = B.get(M.alu);
  const glass = faces2(B.get(M.glass, false));
  const frost = faces2(B.get(M.frosted, false));
  box(F, endFaces(ctx, info, { ...noBottom(alu), top: B.get(M.cut) }, true, true, H), -ext.a, L + ext.b, -ht, ht, H - head, H);

  const post = (s) => box(F, all(alu), s - 0.02, s + 0.02, -ht, ht, foot, H - head);
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
  box(F, all(alu), start, start + jamb, -ht, ht, 0, oh);
  box(F, all(alu), end - jamb, end, -ht, ht, 0, oh);
  box(F, all(alu), start, end, -ht, ht, oh, oh + 0.05);
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
    box(F, endFaces(ctx, info, all(cap), first, last, H + 0.03), s0, s1, -ht - 0.015, ht + 0.015, H, H + 0.03);
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
  const get = (m) => ctx.ceil.get(m, m !== M.cut, m === M.paint || m === M.facade);
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
 * Polished concrete slab under the building: the rooms and the area the walls enclose, plus every
 * wall's footprint so door thresholds are covered. Set slightly low and depth-offset so rooms never
 * z-fight with it. A plan without walls or rooms gets a slab under its items.
 */
function buildSlab(ctx, parent) {
  const mat = ctx.kit.floorMaterial('polished-concrete').clone();
  Object.assign(mat, { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2 });
  ctx.owned.materials.push(mat);
  const m = ctx.kit.floorMeters('polished-concrete');
  const buckets = createBuckets();
  const b = buckets.get(mat, false, true);
  const square = [[0, 1, 2], [0, 2, 3]];
  const rect = (r) => {
    const corners = [{ x: r.minX, y: r.minY }, { x: r.maxX, y: r.minY }, { x: r.maxX, y: r.maxY }, { x: r.minX, y: r.maxY }];
    horizontalPolygon(b, corners, square, SLAB_Y, true, m);
  };
  for (const r of maskRects(ctx.mask, ctx.mask.inside)) rect(r);
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
    horizontalPolygon(B.get(tile ? ctx.mats.get('tile') : ctx.mats.drywall, false, false), rm.grown.contour, rm.grown.faces, rm.ceilY, false, 1);
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
  const band = all(B.get(ctx.mats.drywall, false, false)), dark = all(B.get(ctx.mats.deck, false, false));
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
  const b = ctx.ceil.get(tile ? ctx.mats.get('tile') : ctx.mats.drywall, false, false);
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
  const b = ctx.ceil.get(ctx.mats.get('deck'), true, false);
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

function troffer(ctx, p, h) {
  const B = ctx.ceil;
  const hs = TILE / 2 - 0.004, rim = 0.03;
  const led = { bottom: B.get(ctx.mats.led, false, false) };
  if (ctx.low) {
    box(WORLD, led, p.x - hs, p.x + hs, p.y - hs, p.y + hs, h - 0.002, h);
    return;
  }
  box(WORLD, led, p.x - hs + rim, p.x + hs - rim, p.y - hs + rim, p.y + hs - rim, h - 0.006, h);
  const f = { ...faces2(B.get(ctx.mats.trim, false, false)), bottom: B.get(ctx.mats.trim, false, false), s0: B.get(ctx.mats.trim, false, false), s1: B.get(ctx.mats.trim, false, false) };
  const y0 = h - 0.014;
  box(WORLD, f, p.x - hs, p.x + hs, p.y - hs, p.y - hs + rim, y0, h);
  box(WORLD, f, p.x - hs, p.x + hs, p.y + hs - rim, p.y + hs, y0, h);
  box(WORLD, f, p.x - hs, p.x - hs + rim, p.y - hs + rim, p.y + hs - rim, y0, h);
  box(WORLD, f, p.x + hs - rim, p.x + hs, p.y - hs + rim, p.y + hs - rim, y0, h);
}

function diffuser(ctx, p, h) {
  const b = ctx.ceil.get(ctx.mats.get('diffuser'), false, false);
  const hs = TILE / 2 - 0.01, y = h - 0.003;
  quad(b, [p.x - hs, y, p.y - hs], [p.x + hs, y, p.y - hs], [p.x + hs, y, p.y + hs], [p.x - hs, y, p.y + hs], DOWN, 0, 1, 1, 0);
}

function downlight(ctx, p, h) {
  const seg = ctx.low ? 12 : 24;
  cylinder(ctx, ctx.ceil.get(ctx.mats.trim, false, false), p.x, h - 0.006, p.y, 0.085, 0.006, seg);
  cylinder(ctx, ctx.ceil.get(ctx.mats.led, false, false), p.x, h - 0.008, p.y, 0.06, 0.004, seg);
}

function sprinkler(ctx, p, h) {
  const f = { ...faces2(ctx.ceil.get(ctx.mats.sprinkler, false, false)) };
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
  const beam = all(ctx.ceil.get(ctx.mats.beam, false, false));
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
  box(F, all(B.get(ctx.mats.pendant, false, false)), 0, len, -0.03, 0.03, y0, y1);
  box(F, { bottom: B.get(ctx.mats.led, false, false) }, 0.01, len - 0.01, -0.02, 0.02, y0 - 0.002, y0);
  const cable = all(B.get(ctx.mats.duct, false, false));
  for (const s of [0.25, len - 0.25]) box(F, cable, s - 0.002, s + 0.002, -0.002, 0.002, y1, deck);
}

/** Round duct that drops from the deck at p0 and runs to p1, with seam rings and hanger rods. */
function duct(ctx, p0, p1, r, deck) {
  const B = ctx.ceil.get(ctx.mats.duct, false, false);
  const y = deck - 0.45 - r;
  const seg = ctx.low ? 12 : 20;
  const a = new THREE.Vector3(p0.x, y, p0.y);
  tube(ctx, B, a, new THREE.Vector3(p1.x, y, p1.y), r, seg);
  tube(ctx, B, a, new THREE.Vector3(p0.x, deck, p0.y), r, seg);
  sphere(ctx, B, p0.x, y, p0.y, r, seg);
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const d = { x: (p1.x - p0.x) / len, y: (p1.y - p0.y) / len };
  const F = frameOf(p0, d);
  const rod = all(ctx.ceil.get(ctx.mats.beam, false, false));
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

// ---- Items ---------------------------------------------------------------------

/**
 * Items are built once per distinct (type, size, color) as a template of mesh parts, then stamped
 * into the buckets with each instance's placement. Templates with lights, lines or skinned meshes
 * are rebuilt per instance so those objects stay unique.
 */
function buildItems(ctx) {
  const templates = new Map();
  const place = new THREE.Matrix4();
  for (const item of ctx.plan.items) {
    const def = getItem(item.type);
    const dims = itemSize(item);
    const key = `${item.type}|${dims.w}|${dims.d}|${dims.h}|${item.color ?? ''}`;
    let parts = templates.get(key);
    if (parts === undefined) templates.set(key, (parts = itemTemplate(ctx, buildItem(ctx, def, dims, item))));
    const rotation = (-normDeg(item.rotation || 0) * Math.PI) / 180;
    place.compose(_v.set(item.x, item.elevation ?? 0, item.y), _q.setFromAxisAngle(_y, rotation), _s.set(1, 1, 1));
    ctx.main.at(item.x, item.y);
    try {
      // Past the detail budget items are plain blocks, so a plan with thousands of items stays quick.
      if (ctx.itemVerts > MAX_ITEM_VERTS) itemBlock(ctx, item, dims);
      else if (parts) stampParts(ctx, parts, place);
      else collectObject(ctx, buildItem(ctx, def, dims, item), place);
    } catch (err) {
      console.warn(`Could not place item "${item.type}"`, err);
    }
    if (def.blocking === false) continue;
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
  box(F, noBottom(ctx.main.get(ctx.kit.mat.plastic, false)), -dims.w / 2, dims.w / 2, -dims.d / 2, dims.d / 2, y0, y0 + dims.h);
}

/**
 * Soft contact shadow under an item's footprint: a 9-slice of the falloff texture, or for round
 * items an ellipse inscribed in the footprint that fades out just past its edge.
 */
function blobShadow(ctx, item, dims, round) {
  const r = (normDeg(item.rotation || 0) * Math.PI) / 180;
  const F = frameOf({ x: item.x, y: item.y }, { x: Math.cos(r), y: Math.sin(r) });
  const m = clamp(0.1 + 0.08 * Math.min(dims.w, dims.d), 0.12, 0.28);
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
    const b = ctx.main.get(tint || p.mat, p.cast, p.receive);
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
      ctx.owned.materials.push(shared);
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

function ownMesh(ctx, geometry, material) {
  ctx.owned.geometries.push(geometry);
  ctx.owned.materials.push(material);
  return new THREE.Mesh(geometry, material);
}

function skyDome(ctx, cx, cz, radius, kind) {
  const g = new THREE.SphereGeometry(radius, 32, 16);
  const zenith = new THREE.Color(kind === 'none' ? '#d6dfe5' : '#8ab7da');
  const horizon = new THREE.Color(kind === 'none' ? '#f1f3f4' : '#e8eff2');
  const pos = g.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    c.copy(horizon).lerp(zenith, Math.pow(clamp(pos.getY(i) / radius, 0, 1), 0.55));
    colors.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mesh = ownMesh(ctx, g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false }));
  mesh.position.set(cx, 0, cz);
  mesh.renderOrder = -1;
  mesh.name = 'sky';
  return mesh;
}

function groundDisc(ctx, cx, cz, radius, kind) {
  const g = new THREE.CircleGeometry(radius, 96);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) + cx, -(pos.getZ(i) + cz));
  const mat = ctx.mats.get(kind === 'city' ? 'paving' : kind === 'campus' ? 'grass' : 'neutral');
  Object.assign(mat, { polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 });
  ctx.owned.geometries.push(g);
  const mesh = new THREE.Mesh(g, mat);
  mesh.position.set(cx, GROUND_Y, cz);
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  return mesh;
}

function skylineRing(ctx, cx, cz, R, key) {
  const h = R * SKY_RATIO;
  const g = new THREE.CylinderGeometry(R, R, h, 128, 1, true);
  const mat = new THREE.MeshBasicMaterial({ map: acquireTexture(ctx.owned, key), side: THREE.BackSide, alphaTest: 0.5, fog: false, toneMapped: false });
  const mesh = ownMesh(ctx, g, mat);
  mesh.position.set(cx, h / 2 - 1.5, cz);
  mesh.name = 'skyline';
  return mesh;
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
  const paint = ctx.ext.get(ctx.kit.material('#e6e4dc', { roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }), false, true);
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
  const y = GROUND_Y + 0.02, p = 4;
  quad(apron, [b.minX - p, y, b.minY - p], [b.maxX + p, y, b.minY - p], [b.maxX + p, y, b.maxY + p], [b.minX - p, y, b.maxY + p], UP,
    b.minX - p, -(b.minY - p), b.maxX + p, -(b.maxY + p));
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

function tree(ctx, x, z, s, r) {
  const B = ctx.ext;
  const seg = ctx.low ? 8 : 16;
  cylinder(ctx, B.get(ctx.mats.trunk, false, false), x, GROUND_Y, z, 0.12 * s, 2.6 * s, 7);
  const n = ctx.low ? 2 : 3;
  for (let k = 0; k < n; k++) {
    const leaf = ctx.mats.leaves[Math.floor(r() * ctx.mats.leaves.length)];
    const rad = (1.3 + r() * 0.7) * s;
    sphere(ctx, B.get(leaf, false, false), x + (r() - 0.5) * 1.6 * s, (3.3 + r() * 1.3) * s, z + (r() - 0.5) * 1.6 * s, rad, seg, 0.85);
  }
}

// ---- Procedural textures -------------------------------------------------------

function drawCeilingTile(g, s) {
  const r = rng(17);
  g.fillStyle = '#eeede9';
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 3400; i++) {
    g.fillStyle = `rgba(112,110,102,${0.05 + r() * 0.15})`;
    g.fillRect(r() * s, r() * s, 1 + r() * 3, 1 + r() * 1.3);
  }
  const tee = Math.round(s * 0.024);
  g.fillStyle = 'rgba(70,72,68,0.22)';
  g.fillRect(tee / 2, tee / 2, s - tee, 3);
  g.fillRect(tee / 2, tee / 2, 3, s - tee);
  g.fillStyle = '#f8f8f6';
  g.fillRect(0, 0, s, tee / 2);
  g.fillRect(0, s - tee / 2, s, tee / 2);
  g.fillRect(0, 0, tee / 2, s);
  g.fillRect(s - tee / 2, 0, tee / 2, s);
}

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

/** Composite metal deck: four 6 inch flutes across the tile. */
function drawDeck(g, w, h) {
  const rib = w / 4;
  for (let i = 0; i < 4; i++) {
    const x = i * rib;
    const grad = g.createLinearGradient(x, 0, x + rib, 0);
    grad.addColorStop(0, '#2c3336');
    grad.addColorStop(0.18, '#454e52');
    grad.addColorStop(0.5, '#3b4347');
    grad.addColorStop(0.82, '#30383b');
    grad.addColorStop(1, '#2c3336');
    g.fillStyle = grad;
    g.fillRect(x, 0, rib, h);
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

function drawPaving(g, s) {
  const r = rng(5);
  const n = 8, cell = s / n;
  g.fillStyle = '#a19d95';
  g.fillRect(0, 0, s, s);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const t = 184 + Math.floor(r() * 16);
      g.fillStyle = `rgb(${t + 6},${t + 3},${t - 4})`;
      g.fillRect(i * cell + 1.5, j * cell + 1.5, cell - 3, cell - 3);
    }
  }
  for (let i = 0; i < 4000; i++) {
    g.fillStyle = r() < 0.5 ? 'rgba(120,115,108,0.25)' : 'rgba(255,255,255,0.25)';
    g.fillRect(r() * s, r() * s, 1.5, 1.5);
  }
}

function drawGrass(g, s) {
  const r = rng(12);
  g.fillStyle = '#7c9a58';
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 70; i++) {
    const x = r() * s, y = r() * s, rad = s * (0.05 + r() * 0.16);
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, i % 2 ? 'rgba(98,128,66,0.16)' : 'rgba(150,170,100,0.14)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    for (const dx of [-s, 0, s]) for (const dy of [-s, 0, s]) g.fillRect(x - rad + dx, y - rad + dy, rad * 2, rad * 2);
  }
  for (let i = 0; i < 16000; i++) {
    g.fillStyle = r() < 0.5 ? 'rgba(70,96,48,0.35)' : 'rgba(170,190,120,0.3)';
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
  g.fillStyle = '#ddd6c9';
  g.fillRect(0, 0, s, s);
  const w = s * (1.6 / 3), h = s * (1.8 / 4);
  const x = (s - w) / 2, y = s * 0.2;
  g.fillStyle = '#5d6c74';
  g.fillRect(x, y, w, h);
  g.fillStyle = 'rgba(200,215,222,0.35)';
  g.fillRect(x, y, w, h * 0.35);
  g.fillStyle = '#c9c2b4';
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
  const { wrap, yOf, ky } = skylineDrawer(W, Hh);
  g.clearRect(0, 0, W, Hh);
  const layers = [
    { color: '#c6d1d8', window: 'rgba(225,233,238,0.55)', count: 150, w: [0.5, 1.8], h: [1.6, 8.2], rows: 0.3 },
    { color: '#a9b8c0', window: 'rgba(205,216,223,0.6)', count: 120, w: [0.7, 2.4], h: [1, 4.8], rows: 0.24 },
    { color: '#8d9da6', window: 'rgba(188,201,209,0.7)', count: 95, w: [1, 3.2], h: [0.5, 2.6], rows: 0.18 },
  ];
  for (const L of layers) {
    for (let i = 0; i < L.count; i++) {
      const x = r() * 360, w = L.w[0] + r() * (L.w[1] - L.w[0]);
      const h = L.h[0] + Math.pow(r(), 1.6) * (L.h[1] - L.h[0]);
      const top = yOf(h);
      const setback = r() < 0.3;
      wrap(x, w, (px, pw) => {
        g.fillStyle = L.color;
        g.fillRect(px, top, pw, Hh - top);
        if (setback) g.fillRect(px + pw * 0.2, top - ky * h * 0.08, pw * 0.6, ky * h * 0.08 + 1);
        g.fillStyle = L.window;
        for (let y = top + ky * 0.12; y < Hh - ky * 0.1; y += ky * L.rows) {
          g.fillRect(px + pw * 0.08, y, pw * 0.84, Math.max(1, ky * L.rows * 0.42));
        }
      });
    }
  }
  for (let i = 0; i < 70; i++) {
    const x = r() * 360, rad = 0.35 + r() * 0.5;
    const tone = ['#6f8a76', '#7d977f', '#647f6c'][i % 3];
    wrap(x, rad * 2, (px, pw) => {
      g.fillStyle = tone;
      g.beginPath();
      g.ellipse(px + pw / 2, yOf(rad * 0.75), pw / 2, rad * ky * 0.75, 0, 0, Math.PI * 2);
      g.fill();
      g.fillRect(px, yOf(rad * 0.75), pw, Hh);
    });
  }
  hazeBase(g, W, Hh);
}

function drawCampusSkyline(g, W, Hh) {
  const r = rng(77);
  const { wrap, yOf, ky } = skylineDrawer(W, Hh);
  g.clearRect(0, 0, W, Hh);
  const hills = [
    { color: '#b7c7c2', amp: 2.4, base: 1.2, f: [2, 5, 9] },
    { color: '#9db3a8', amp: 1.4, base: 0.6, f: [3, 7, 13] },
  ];
  for (const H of hills) {
    const ph = H.f.map(() => r() * Math.PI * 2);
    g.fillStyle = H.color;
    g.beginPath();
    g.moveTo(0, Hh);
    for (let x = 0; x <= W; x += 4) {
      const a = (x / W) * Math.PI * 2;
      const e = H.base + H.amp * (0.5 + 0.5 * H.f.reduce((acc, f, i) => acc + Math.sin(a * f + ph[i]) / (i + 1.5), 0) / 1.4);
      g.lineTo(x, yOf(Math.max(0.2, e)));
    }
    g.lineTo(W, Hh);
    g.fill();
  }
  for (let i = 0; i < 9; i++) {
    const x = r() * 360, w = 1.5 + r() * 3, h = 0.4 + r() * 0.6;
    wrap(x, w, (px, pw) => {
      g.fillStyle = '#c9cfcb';
      g.fillRect(px, yOf(h), pw, Hh);
      g.fillStyle = 'rgba(120,135,140,0.5)';
      g.fillRect(px + 2, yOf(h * 0.7), pw - 4, Math.max(2, ky * 0.08));
    });
  }
  for (let i = 0; i < 520; i++) {
    const x = r() * 360, rad = 0.25 + r() * 0.45, lift = r() * 0.4;
    const tone = ['#6b8a6f', '#7a977a', '#5f7d64', '#87a283'][i % 4];
    wrap(x, rad * 2, (px, pw) => {
      g.fillStyle = tone;
      g.beginPath();
      g.ellipse(px + pw / 2, yOf(lift + rad * 0.8), pw / 2, rad * ky * 0.8, 0, 0, Math.PI * 2);
      g.fill();
      g.fillRect(px, yOf(lift + rad * 0.8), pw, Hh);
    });
  }
  hazeBase(g, W, Hh);
}

/** Atmospheric haze toward the horizon, painted only over existing silhouettes. */
function hazeBase(g, W, Hh) {
  g.save();
  g.globalCompositeOperation = 'source-atop';
  const grad = g.createLinearGradient(0, Hh * 0.35, 0, Hh);
  grad.addColorStop(0, 'rgba(232,239,242,0)');
  grad.addColorStop(1, 'rgba(232,239,242,0.55)');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, Hh);
  g.restore();
}
