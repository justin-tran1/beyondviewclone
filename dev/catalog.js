// Developer preview of the item catalog.
//   ?category=lab (or medical, office, retail, general; add &view=top): every item of a category in
//   3D, framed to fit and labeled, with plan symbols below in cells sized to each symbol (&px= sets
//   the plan scale in px per meter, 90 by default).
//   ?item=fume-hood (add &w=, &d=, &h= in meters to try other sizes, up to 60, &color=%23rrggbb
//   for a custom finish, &top= for a worksurface, a WORKSURFACES key, and &variant= for one of the
//   looks of an item that comes in several, such as wall-art): one item from four sides,
//   its model bounds checked against the footprint, and its plan symbol at three zoom levels.
//   &view=room (with ?category or ?item): the same items built into a daylit room by builder3d.js
//   and drawn through the walkthrough's pipeline (captured environment, AO, grade and AgX), as in
//   the walk view. For one item, &yaw= turns the camera around it (degrees, 0 = front, positive to
//   its right), &dist= scales the camera distance and &eye= sets the camera height in meters;
//   &fx=high|balanced|fast picks the post-processing level (high by default).
//   Artifact hunting in room views: &ao=0 skips only the ambient occlusion pass (high, balanced), and
//   &maps=0 drops the normal and roughness maps of the items' materials, so either cause can be ruled
//   out with an otherwise identical frame.
// Studio views use the walkthrough's tone curve and light levels too, so finishes read as in the app.
import * as THREE from 'three';
import { createKit } from '../src/kit3d.js';
import { normalizePlan } from '../src/model.js';
import { CATEGORIES, getItem, hasItem, listItems } from '../src/catalog/index.js';

// The lighting and post-processing modules are optional, so the page still previews items while
// they change; without them it falls back to a plain studio.
const optional = async (path) => {
  try {
    return await import(path);
  } catch (err) {
    console.warn(`Catalog preview: ${path} is unavailable, using a plain studio`, err);
    return {};
  }
};
const builder = await optional('../src/builder3d.js');
const postfx = await optional('../src/postfx.js');

const params = new URLSearchParams(location.search);
const itemType = params.get('item');
const view = params.get('view') || 'front';
const room = view === 'room' && typeof builder.buildPlanScene === 'function';
const custom = /^#[0-9a-f]{6}$/i.test(params.get('color') || '') ? params.get('color') : undefined;
const top = params.get('top') || undefined;
const category = itemType && hasItem(itemType) ? getItem(itemType).category : params.get('category') || 'lab';

const THEME = { line: '#435254', fill: '#ffffff', accent: '#003f2d', muted: '#7f8480', light: '#cad1d3', glass: '#80bbad' };
const MARK = '#17e88f';  // footprint outlines and front markers
const GAP = 0.7;         // meters between items in the 3D grid
// Room views take the walkthrough's exposure (src/walkthrough.js EXPOSURE); the studio keeps its own,
// with lights at interior levels (scene-linear).
const EXPOSURE = room ? 0.66 : 1.8;
const STUDIO = { key: 3.2, fill: 1.9, env: 0.75, floor: '#cfd1cc' };
// Floor finish of the preview room per category.
const ROOM_FLOOR = { lab: 'epoxy', medical: 'vinyl', office: 'carpet', retail: 'polished-concrete', general: 'wood' };

const $ = (id) => document.getElementById(id);
const fmt = (v) => (Math.abs(v) < 0.0005 ? '0' : v.toFixed(3).replace(/\.?0+$/, ''));
const size = (o) => `${o.w.toFixed(2)} × ${o.d.toFixed(2)} × ${o.h.toFixed(2)} m`;
const query = (extra) => {
  const q = new URLSearchParams(extra);
  if (view !== 'front') q.set('view', view);
  return `?${q}`;
};

document.title = itemType ? `Catalog: ${itemType}` : 'Catalog Preview';
$('nav').append(...CATEGORIES.map((c) => {
  const a = document.createElement('a');
  a.href = query({ category: c.id });
  a.textContent = c.label;
  if (c.id === category) a.setAttribute('aria-current', 'page');
  return a;
}));

// ---- 3D -----------------------------------------------------------------------------

function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = EXPOSURE;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}

/**
 * Studio: a light floor, the walkthrough's neutral interior environment and fill, and a soft key
 * light from the front right, tone mapped with the walkthrough's graded AgX curve.
 */
function createStage(canvas, kit) {
  const renderer = createRenderer(canvas);
  postfx.useGradedToneMapping?.(renderer);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#e9eef1');
  let sun, env = null;
  if (typeof builder.setupEnvironment === 'function') {
    env = builder.setupEnvironment(renderer, scene);
    sun = env.sun;
    sun.intensity = STUDIO.key;
    env.hemi.intensity = STUDIO.fill;
    scene.fog = null;
  } else {
    sun = new THREE.DirectionalLight('#fff4e5', STUDIO.key);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    scene.add(sun, sun.target, new THREE.HemisphereLight('#fff1df', '#8f877c', STUDIO.fill));
  }
  sun.shadow.radius = 4;
  kit.setEnvironmentIntensity?.(STUDIO.env);
  return { renderer, scene, sun, env };
}

/** Floor under the box, and a key light whose shadow camera covers it. */
function light(stage, box) {
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const r = Math.max(s.x, s.z) / 2 + 2;
  const span = Math.max(s.x, s.z) * 3 + 30;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(span, span), new THREE.MeshStandardMaterial({ color: STUDIO.floor, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(c.x, -0.001, c.z);
  floor.receiveShadow = true;
  stage.scene.add(floor);
  stage.sun.position.set(c.x + r * 0.5, Math.max(12, s.y * 3, r * 2), c.z + r * 0.8);
  stage.sun.target.position.set(c.x, 0, c.z);
  stage.sun.target.updateMatrixWorld();
  Object.assign(stage.sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 0.5, far: Math.max(60, r * 6) });
  stage.sun.shadow.camera.updateProjectionMatrix();
}

/** Green footprint outline with a small arrow at the front (+z). */
function footprint(w, d) {
  const g = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: MARK, toneMapped: false });
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, 0.001, d)), mat));
  const a = Math.min(0.12, w / 4, d / 2);
  const tri = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-a, 0.002, d / 2 + 0.03), new THREE.Vector3(0, 0.002, d / 2 + 0.03 + a), new THREE.Vector3(a, 0.002, d / 2 + 0.03),
  ]);
  g.add(new THREE.Mesh(tri, new THREE.MeshBasicMaterial({ color: MARK, side: THREE.DoubleSide, toneMapped: false })));
  return g;
}

/** Orthographic camera looking straight down, for top views. */
function topCamera(aspect) {
  const camera = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, 0.1, 100);
  camera.up.set(0, 0, -1);
  return camera;
}

/**
 * Places the camera along dir from the box center, just far enough for every corner to fit, or for
 * an orthographic camera straight above it with plan +y (3D +z) down the picture. Returns the
 * distance or half height, smaller when the box comes out larger.
 */
function frame(camera, box, dir, pad = 1.06) {
  const target = box.getCenter(new THREE.Vector3());
  if (camera.isOrthographicCamera) {
    const s = box.getSize(new THREE.Vector3());
    const aspect = (camera.right - camera.left) / (camera.top - camera.bottom);
    const half = pad * Math.max(s.z / 2, s.x / 2 / aspect);
    Object.assign(camera, { left: -half * aspect, right: half * aspect, top: half, bottom: -half, near: 0.1, far: s.y + 20 });
    camera.position.set(target.x, box.max.y + 10, target.z);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    return half;
  }
  const back = dir.clone().normalize();
  camera.position.copy(target).add(back);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / pad, tanH = tanV * camera.aspect;
  let dist = 0.1;
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        const v = new THREE.Vector3(x, y, z).sub(target);
        dist = Math.max(dist, v.dot(back) + Math.abs(v.dot(right)) / tanH, v.dot(back) + Math.abs(v.dot(up)) / tanV);
      }
    }
  }
  camera.position.copy(target).addScaledVector(back, dist);
  camera.near = dist / 200;
  camera.far = dist * 4;
  camera.updateProjectionMatrix();
  return dist;
}

/** HTML label pinned to a world point, in CSS px relative to a viewport rectangle. */
function pin(camera, rect, p, text, href) {
  const v = p.clone().project(camera);
  if (v.z > 1) return;
  const el = document.createElement(href ? 'a' : 'span');
  if (href) el.href = href;
  el.textContent = text;
  el.style.left = `${rect.x + ((v.x + 1) / 2) * rect.w}px`;
  el.style.top = `${rect.y + ((1 - v.y) / 2) * rect.h + 4}px`;
  $('labels').append(el);
}

/**
 * Rows no wider than maxRow, first row at the back. Seen from the front, each gap leaves room for
 * the height of the row in front, so it hides little of the row behind.
 */
function gridLayout(entries, maxRow) {
  const tilt = view === 'top' ? 0 : 1;
  const rows = [];
  let row = null;
  for (const e of entries) {
    if (!row || row.w + GAP + e.w > maxRow) rows.push((row = { entries: [], w: -GAP, d: 0, h: 0 }));
    row.entries.push(e);
    row.w += GAP + e.w;
    row.d = Math.max(row.d, e.d);
    row.h = Math.max(row.h, e.h);
  }
  const placed = [];
  let z = 0;
  rows.forEach((r, i) => {
    if (i) z += rows[i - 1].d / 2 + Math.max(GAP + 0.3, tilt * r.h) + r.d / 2;
    let x = -r.w / 2;
    for (const e of r.entries) {
      placed.push({ ...e, x: x + e.w / 2, z });
      x += e.w + GAP;
    }
  });
  return placed;
}

const gridDir = () => (view === 'top' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 1, 1.15));

/** Box around placed items, with room for their labels in front. */
function gridBox(placed) {
  const box = new THREE.Box3();
  for (const { w, d, h, x, z } of placed) {
    box.expandByPoint(new THREE.Vector3(x - w / 2, 0, z - d / 2));
    box.expandByPoint(new THREE.Vector3(x + w / 2, h, z + d / 2 + 0.3));
  }
  return box;
}

/** The row width whose layout the camera can frame from closest, so items come out largest. */
function bestLayout(entries, camera) {
  const widest = Math.max(...entries.map((e) => e.w));
  const total = entries.reduce((s, e) => s + e.w + GAP, 0);
  let best = null;
  for (let k = 0; k <= 24; k++) {
    const placed = gridLayout(entries, widest * (total / widest) ** (k / 24));
    const dist = frame(camera, gridBox(placed), gridDir());
    if (!best || dist < best.dist) best = { placed, dist };
  }
  return best.placed;
}

/** Mesh, triangle and material counts of a built model. */
function modelStats(obj) {
  let meshes = 0, tris = 0;
  const mats = new Set(), textured = new Set();
  obj.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    for (const m of [].concat(o.material)) {
      mats.add(m);
      if (m.map || m.normalMap) textured.add(m);
    }
  });
  return { meshes, tris: Math.round(tris), materials: mats.size, textured: textured.size };
}

function renderGrid(items) {
  const canvas = $('stage');
  const kit = createKit();
  const stage = createStage(canvas, kit);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const camera = view === 'top' ? topCamera(W / H) : new THREE.PerspectiveCamera(35, W / H, 0.05, 500);
  // Laid out by footprint and by how tall each model really stands (mirrors and monitors included).
  const entries = items.map((def) => {
    const obj = def.build(kit, { w: def.w, d: def.d, h: def.h, color: custom, top });
    obj.updateMatrixWorld(true);
    return { def, obj, w: def.w, d: def.d, h: Math.max(def.h, new THREE.Box3().setFromObject(obj).max.y) };
  });
  // Seen from the front, taller items go to the back rows so they hide nothing behind them.
  const placed = bestLayout(view === 'top' ? entries : [...entries].sort((a, b) => b.h - a.h), camera);
  const box = gridBox(placed);
  for (const { def, obj, x, z } of placed) {
    obj.position.set(x, 0, z);
    const fp = footprint(def.w, def.d);
    fp.position.copy(obj.position);
    stage.scene.add(obj, fp);
    box.expandByObject(obj);
  }
  light(stage, box);
  frame(camera, box, gridDir());
  stage.renderer.render(stage.scene, camera);
  const rect = { x: 0, y: 0, w: W, h: H };
  for (const { def, x, z } of placed) pin(camera, rect, new THREE.Vector3(x, 0, z + def.d / 2), def.name, query({ item: def.type }));
  const stats = entries.map((e) => ({ type: e.def.type, ...modelStats(e.obj) }));
  window.previewStats = stats;
  $('report').textContent = stats.map((s) => `${s.type}: ${s.meshes} meshes, ${s.tris} triangles, ${s.materials} materials (${s.textured} textured)`).join('\n');
}

function renderCloseUp(def, o) {
  const canvas = $('stage');
  const kit = createKit();
  const stage = createStage(canvas, kit);
  const obj = def.build(kit, o);
  const fp = footprint(o.w, o.d);
  const volume = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(o.w, o.h, o.d)),
    new THREE.LineBasicMaterial({ color: MARK, transparent: true, opacity: 0.45, toneMapped: false }));
  volume.position.y = o.h / 2;
  stage.scene.add(obj, fp, volume);
  obj.updateMatrixWorld(true);
  const model = new THREE.Box3().setFromObject(obj);
  const box = model.clone().union(new THREE.Box3(new THREE.Vector3(-o.w / 2, 0, -o.d / 2), new THREE.Vector3(o.w / 2, o.h, o.d / 2 + 0.2)));
  light(stage, box);

  const W = canvas.clientWidth, H = canvas.clientHeight, hw = Math.floor(W / 2), hh = Math.floor(H / 2);
  const views = [
    ['Front', new THREE.Vector3(0.75, 0.55, 1)], ['Back', new THREE.Vector3(-0.75, 0.55, -1)],
    ['Right side', new THREE.Vector3(1, 0.3, 0.04)], ['Top, front down', new THREE.Vector3(0, 1, 0)],
  ];
  const { renderer } = stage;
  renderer.setScissorTest(true);
  views.forEach(([label, dir], i) => {
    const rect = { x: (i % 2) * hw, y: Math.floor(i / 2) * hh, w: hw, h: hh };
    const camera = i === 3 ? topCamera(rect.w / rect.h) : new THREE.PerspectiveCamera(30, rect.w / rect.h, 0.01, 100);
    frame(camera, box, dir);
    renderer.setViewport(rect.x, H - rect.y - rect.h, rect.w, rect.h);
    renderer.setScissor(rect.x, H - rect.y - rect.h, rect.w, rect.h);
    renderer.render(stage.scene, camera);
    viewTag(label, rect);
  });
  renderer.setScissorTest(false);
  report(def, o, obj, model);
}

function viewTag(label, rect) {
  const tag = document.createElement('span');
  tag.className = 'view';
  tag.textContent = label;
  Object.assign(tag.style, { left: `${rect.x + 8}px`, top: `${rect.y + 8}px` });
  $('labels').append(tag);
}

function report(def, o, obj, model) {
  const stats = modelStats(obj);
  const over = [
    ['left', -o.w / 2 - model.min.x], ['right', model.max.x - o.w / 2], ['back', -o.d / 2 - model.min.z],
    ['front', model.max.z - o.d / 2], ['below the floor', -model.min.y], ['top', model.max.y - o.h],
  ].filter(([, v]) => v > 0.005).map(([k, v]) => `${k} ${fmt(v)} m`);
  const flags = [`resizable: ${def.resizable ? (def.resizableHeight ? 'width, depth and height' : 'width and depth') : 'no'}`,
    `blocking: ${def.blocking !== false ? 'yes' : 'no'}`, `contact shadow: ${def.blocking === false || def.contactShadow === false ? 'none' : def.contactShadow === 'round' ? 'round' : 'footprint'}`];
  window.previewStats = { type: def.type, ...stats };
  $('report').textContent = [
    `${def.name} (${def.type}), ${size(o)}${o.w !== def.w || o.d !== def.d || o.h !== def.h ? `, default ${size(def)}` : ''}${o.color ? `, color ${o.color}` : ''}`,
    `Model bounds: x ${fmt(model.min.x)} to ${fmt(model.max.x)}, y ${fmt(model.min.y)} to ${fmt(model.max.y)}, z ${fmt(model.min.z)} to ${fmt(model.max.z)}`,
    `${stats.meshes} meshes, ${stats.tris} triangles, ${stats.materials} materials (${stats.textured} textured)`,
    over.length ? `Past its footprint: ${over.join(', ')}` : 'Inside its footprint',
    flags.join(', '),
  ].join('\n');
}

// ---- Room views (the walk view's lighting) ------------------------------------------

const WALL_T = 0.2;

/**
 * A plan with one rectangular room around the placed items (plan x, y = 3D x, z): exterior walls
 * with windows along the back and left, a door on the right, and no front wall when `open`.
 */
function roomPlan(placed, { x0, x1, z0, z1, height, floor, open, exterior }) {
  const corners = [{ x: x0, y: z0 }, { x: x1, y: z0 }, { x: x1, y: z1 }, { x: x0, y: z1 }];
  const sides = [['back', 0, 1], ['right', 1, 2], ['front', 2, 3], ['left', 3, 0]];
  const walls = [], openings = [];
  for (const [name, a, b] of sides) {
    if (open && name === 'front') continue;
    const id = `wall-${name}`;
    walls.push({ id, a: corners[a], b: corners[b], kind: 'exterior', thickness: WALL_T, height });
    const len = Math.hypot(corners[b].x - corners[a].x, corners[b].y - corners[a].y);
    if (name === 'back' || name === 'left') {
      const n = Math.max(1, Math.floor((len - 0.6) / 2.4));
      for (let i = 0; i < n; i++) {
        openings.push({ id: `${id}-win-${i}`, wallId: id, type: 'window', offset: (len * (i + 0.5)) / n, width: Math.min(1.8, len / n - 0.5), height: Math.min(1.9, height - 1), sill: 0.75 });
      }
    } else if (name === 'right' && len > 2) {
      openings.push({ id: `${id}-door`, wallId: id, type: 'door', offset: len * 0.75, width: 0.91, height: 2.13, sill: 0, hinge: 'start', side: 1 });
    }
  }
  return normalizePlan({
    version: 1, name: 'Catalog room', units: 'metric',
    settings: { wallHeight: height, ceiling: 'tile', exterior },
    walls, openings,
    rooms: [{ id: 'room', name: 'Room', points: corners, floor, ceiling: 'tile' }],
    items: placed.map((p, i) => ({ id: `item-${i}`, type: p.def.type, x: p.x, y: p.z, rotation: 0, ...p.size, ...(custom ? { color: custom } : {}), ...(top ? { top } : {}) })),
    cameras: [],
  });
}

/** Builds the plan and lights it as the walkthrough does; returns what render() needs. */
function roomStage(canvas, plan, camera) {
  const renderer = createRenderer(canvas);
  const scene = new THREE.Scene();
  const env = builder.setupEnvironment(renderer, scene);
  const kit = createKit();
  const built = builder.buildPlanScene(plan, { kit, quality: 'high' });
  scene.add(built.root);
  if (params.get('maps') === '0') flatten(built.root.getObjectByName('furnishings') || built.root);
  env.fit(built.bounds);
  renderer.shadowMap.needsUpdate = true;
  if (typeof builder.captureEnvironment === 'function') {
    const capture = builder.captureEnvironment(renderer, scene, built);
    scene.environment = capture.texture;
  }
  renderer.setRenderTarget(null);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const quality = ['high', 'balanced', 'fast'].includes(params.get('fx')) ? params.get('fx') : 'high';
  const fx = typeof postfx.createPostFX === 'function' ? postfx.createPostFX(renderer, scene, camera, { quality }) : null;
  fx?.setSize(W, H, 1);
  const top = plan.settings.wallHeight + 1.2, b = built.bounds;
  fx?.setSceneBounds(new THREE.Box3(new THREE.Vector3(b.minX - 1, -1, b.minY - 1), new THREE.Vector3(b.maxX + 1, top, b.maxY + 1)));
  const ready = fx ? fx.ready : Promise.resolve();
  if (params.get('ao') === '0' && fx?.passes) fx.passes.ao.enabled = false;
  const draw = () => {
    if (fx) fx.render(camera);
    else renderer.render(scene, camera);
  };
  window.previewStage = { renderer, scene, camera, built, fx };
  return { renderer, scene, built, kit, draw, ready };
}

/** Drops normal and roughness maps under obj (in place: surfaces sharing a material lose them too). */
function flatten(obj) {
  obj.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material)) {
      if (!m.normalMap && !m.roughnessMap && !m.clearcoatNormalMap) continue;
      m.normalMap = m.roughnessMap = m.clearcoatNormalMap = null;
      m.needsUpdate = true;
    }
  });
}

/** Category showroom: the grid layout in a daylit room with its front wall and ceiling left out. */
async function renderRoomGrid(items) {
  const canvas = $('stage');
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const camera = new THREE.PerspectiveCamera(35, W / H, 0.05, 2000);
  const kit = createKit();
  const entries = items.map((def) => {
    const obj = def.build(kit, { w: def.w, d: def.d, h: def.h, color: custom, top });
    obj.updateMatrixWorld(true);
    return { def, w: def.w, d: def.d, h: Math.max(def.h, new THREE.Box3().setFromObject(obj).max.y) };
  });
  kit.dispose();
  const placed = bestLayout([...entries].sort((a, b) => b.h - a.h), camera);
  const box = gridBox(placed);
  const m = 1.2, height = Math.max(2.9, box.max.y + 0.4);
  const plan = roomPlan(placed, {
    x0: box.min.x - m, x1: box.max.x + m, z0: box.min.z - m, z1: box.max.z + m, height,
    floor: ROOM_FLOOR[category] || 'vinyl', open: true, exterior: 'none',
  });
  const stage = roomStage(canvas, plan, camera);
  for (const c of stage.built.ceilings) c.visible = false;
  frame(camera, box, gridDir());
  camera.far = 2000;
  camera.updateProjectionMatrix();
  stage.draw();
  await stage.ready;
  stage.draw();
  const rect = { x: 0, y: 0, w: W, h: H };
  for (const { def, x, z } of placed) pin(camera, rect, new THREE.Vector3(x, 0, z + def.d / 2), def.name, query({ item: def.type }));
}

/** One item in a daylit room, seen at eye height from the front three-quarter (or &yaw=). */
async function renderRoomItem(def, o) {
  const canvas = $('stage');
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const kit = createKit();
  const obj = def.build(kit, o);
  obj.updateMatrixWorld(true);
  const model = new THREE.Box3().setFromObject(obj);
  report(def, o, obj, model);
  kit.dispose();
  const camera = new THREE.PerspectiveCamera(40, W / H, 0.05, 2000);
  const yaw = THREE.MathUtils.degToRad(Number(params.get('yaw') ?? 28));
  const box = model.clone().union(new THREE.Box3(new THREE.Vector3(-o.w / 2, 0, -o.d / 2), new THREE.Vector3(o.w / 2, o.h, o.d / 2)));
  const centre = box.getCenter(new THREE.Vector3());
  const eye = Number(params.get('eye')) || Math.min(1.6, Math.max(1.1, box.max.y * 0.9));
  const dist = frame(camera, box, new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), 1.18) * (Number(params.get('dist')) || 1);
  camera.position.set(centre.x + Math.sin(yaw) * dist, eye, centre.z + Math.cos(yaw) * dist);
  camera.lookAt(centre.x, Math.min(centre.y, eye - 0.25), centre.z);
  // The room reaches past the camera, with the windows behind the item and to its left.
  const reach = Math.max(1.5, dist + 1.2), side = Math.max(1.6, o.w / 2 + 1.4);
  const plan = roomPlan([{ def, x: 0, z: 0, size: { w: o.w, d: o.d, h: o.h, ...(o.variant === undefined ? {} : { variant: o.variant }) } }], {
    x0: -side - Math.max(0, -Math.sin(yaw) * reach), x1: side + Math.max(0, Math.sin(yaw) * reach),
    z0: -o.d / 2 - 1.1, z1: Math.max(o.d / 2 + 1.2, Math.cos(yaw) * reach + 0.6),
    height: Math.max(2.9, box.max.y + 0.3), floor: ROOM_FLOOR[def.category] || 'vinyl', open: false, exterior: 'campus',
  });
  const stage = roomStage(canvas, plan, camera);
  stage.draw();
  await stage.ready;
  stage.draw();
  viewTag(`In a room, ${Math.round(THREE.MathUtils.radToDeg(yaw))} degrees`, { x: 0, y: 0 });
}

// ---- Plan symbols -------------------------------------------------------------------

/** Draws one symbol on its own canvas with room around the footprint, then crops it to the ink. */
function symbolCell(def, o, pxPerM, dpr) {
  const margin = 1.5;  // meters around the footprint for parts drawn past it, like door swings
  const c = document.createElement('canvas');
  c.width = Math.ceil((o.w + 2 * margin) * pxPerM * dpr);
  c.height = Math.ceil((o.d + 2 * margin) * pxPerM * dpr);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.scale(dpr, dpr);
  ctx.translate((o.w / 2 + margin) * pxPerM, (o.d / 2 + margin) * pxPerM);
  ctx.scale(pxPerM, pxPerM);
  if (def.planFill !== false && def.blocking !== false) {
    ctx.fillStyle = THEME.fill;
    ctx.fillRect(-o.w / 2, -o.d / 2, o.w, o.d);
  }
  def.draw2d(ctx, { ...o, px: 1 / pxPerM, theme: THEME });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (data[(y * c.width + x) * 4 + 3] < 8) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < x0) [x0, y0, x1, y1] = [0, 0, 1, 1];
  // The middle of the footprint's front edge, for the front marker.
  const fx = (o.w / 2 + margin) * pxPerM * dpr - x0, fy = ((o.d + margin) * pxPerM) * dpr - y0;
  return { c, sx: x0, sy: y0, sw: x1 - x0 + 1, sh: y1 - y0 + 1, fx, fy };
}

/** Lays out symbol cells in wrapping rows, each cell as wide as its symbol or its label. */
function renderSymbols(entries) {
  const plan = $('plan');
  const dpr = window.devicePixelRatio || 1;
  const pad = 28, labelH = 34, width = plan.clientWidth;
  const measure = plan.getContext('2d');
  measure.font = '12px system-ui';
  const cells = entries.map((e) => {
    const cell = symbolCell(e.def, e.o, e.px, dpr);
    const tw = Math.max(measure.measureText(e.title).width, measure.measureText(e.note).width);
    return { ...e, ...cell, w: Math.max(cell.sw / dpr, tw), h: cell.sh / dpr };
  });
  let x = pad, y = pad, rowH = 0;
  for (const cell of cells) {
    if (x > pad && x + cell.w > width - pad) {
      x = pad;
      y += rowH + labelH + pad;
      rowH = 0;
    }
    Object.assign(cell, { x, y });
    x += cell.w + pad;
    rowH = Math.max(rowH, cell.h);
  }
  plan.style.height = `${y + rowH + labelH + pad}px`;
  plan.width = Math.round(width * dpr);
  plan.height = Math.round(plan.clientHeight * dpr);
  const ctx = plan.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.textAlign = 'center';
  for (const cell of cells) {
    const sx = cell.x + (cell.w - cell.sw / dpr) / 2;
    ctx.drawImage(cell.c, cell.sx, cell.sy, cell.sw, cell.sh, sx, cell.y, cell.sw / dpr, cell.sh / dpr);
    ctx.fillStyle = MARK;
    const mx = sx + cell.fx / dpr, my = cell.y + cell.fy / dpr;
    ctx.beginPath();
    ctx.moveTo(mx - 4, my + 3);
    ctx.lineTo(mx, my + 8);
    ctx.lineTo(mx + 4, my + 3);
    ctx.fill();
    const cx = cell.x + cell.w / 2, ty = cell.y + cell.h + 22;
    ctx.font = '12px system-ui';
    ctx.fillStyle = '#435254';
    ctx.fillText(cell.title, cx, ty);
    ctx.font = '11px system-ui';
    ctx.fillStyle = '#7f8480';
    ctx.fillText(cell.note, cx, ty + 14);
  }
}

// ---- Page ---------------------------------------------------------------------------

try {
  if (itemType) {
    if (!hasItem(itemType)) throw new Error(`No item "${itemType}" in the catalog`);
    const def = getItem(itemType);
    const num = (k) => (Number(params.get(k)) > 0 ? Math.min(60, Number(params.get(k))) : def[k]);
    const look = Number(params.get('variant'));
    const o = { w: num('w'), d: num('d'), h: num('h'), color: custom, top, variant: Number.isInteger(look) && look >= 0 ? look : undefined };
    if (room) await renderRoomItem(def, o);
    else renderCloseUp(def, o);
    const fit = Math.min(300, Math.max(80, 400 / Math.max(o.w, o.d)));
    renderSymbols([30, 60, Math.round(fit)].map((px) => ({ def, o, px, title: `${px} px per m`, note: px < 40 ? 'Zoomed out, no small details' : 'Zoomed in' })));
    window.previewItems = [def.type];
  } else {
    const items = listItems(category);
    if (!items.length) throw new Error(`No items registered for category "${category}"`);
    if (room) await renderRoomGrid(items);
    else renderGrid(items);
    const px = Number(params.get('px')) || 90;
    renderSymbols(items.map((def) => ({ def, o: { w: def.w, d: def.d, h: def.h }, px, title: def.name, note: `${def.w.toFixed(2)} × ${def.d.toFixed(2)} m` })));
    window.previewItems = items.map((d) => d.type);
  }
  window.previewReady = true;
} catch (err) {
  $('err').textContent = err.stack || String(err);
  window.previewError = String(err);
  window.previewReady = true;
}
