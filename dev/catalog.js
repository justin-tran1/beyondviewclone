// Developer preview of the item catalog.
//   ?category=lab (or medical, office, retail, general; add &view=top): every item of a category in
//   3D, framed to fit and labeled, with plan symbols below in cells sized to each symbol (&px= sets
//   the plan scale in px per meter, 90 by default).
//   ?item=fume-hood (add &w=, &d=, &h= in meters to try other sizes, up to 60): one item from four
//   sides, its model bounds checked against the footprint, and its plan symbol at three zoom levels.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createKit } from '../src/kit3d.js';
import { CATEGORIES, getItem, hasItem, listItems } from '../src/catalog/index.js';

const params = new URLSearchParams(location.search);
const itemType = params.get('item');
const view = params.get('view') || 'front';
const category = itemType && hasItem(itemType) ? getItem(itemType).category : params.get('category') || 'lab';

const THEME = { line: '#435254', fill: '#ffffff', accent: '#003f2d', muted: '#7f8480', light: '#cad1d3', glass: '#80bbad' };
const MARK = '#17e88f';  // footprint outlines and front markers
const GAP = 0.7;         // meters between items in the 3D grid

const $ = (id) => document.getElementById(id);
const fmt = (v) => (Math.abs(v) < 0.0005 ? '0' : v.toFixed(3).replace(/\.?0+$/, ''));
const size = (o) => `${o.w.toFixed(2)} × ${o.d.toFixed(2)} × ${o.h.toFixed(2)} m`;

document.title = itemType ? `Catalog: ${itemType}` : 'Catalog Preview';
$('nav').append(...CATEGORIES.map((c) => {
  const a = document.createElement('a');
  a.href = `?category=${c.id}${view === 'top' ? '&view=top' : ''}`;
  a.textContent = c.label;
  if (c.id === category) a.setAttribute('aria-current', 'page');
  return a;
}));

// ---- 3D -----------------------------------------------------------------------------

function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#e9eef1');
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture;
  const sun = new THREE.DirectionalLight('#fff4e5', 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun, sun.target, new THREE.HemisphereLight('#ffffff', '#b9b2a6', 0.4));
  return { renderer, scene, sun };
}

/** Floor under the box, and a sun whose shadow camera covers it. */
function light(stage, box) {
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const r = Math.max(s.x, s.z) / 2 + 2;
  const span = Math.max(s.x, s.z) * 3 + 30;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(span, span), new THREE.MeshStandardMaterial({ color: '#d9dcd8' }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(c.x, -0.001, c.z);
  floor.receiveShadow = true;
  stage.scene.add(floor);
  stage.sun.position.set(c.x + r * 0.4, Math.max(12, s.y * 3, r * 2), c.z + r * 0.6);
  stage.sun.target.position.set(c.x, 0, c.z);
  Object.assign(stage.sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, far: Math.max(60, r * 6) });
  stage.sun.shadow.camera.updateProjectionMatrix();
}

/** Green footprint outline with a small arrow at the front (+z). */
function footprint(w, d) {
  const g = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: MARK });
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, 0.001, d)), mat));
  const a = Math.min(0.12, w / 4, d / 2);
  const tri = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-a, 0.002, d / 2 + 0.03), new THREE.Vector3(0, 0.002, d / 2 + 0.03 + a), new THREE.Vector3(a, 0.002, d / 2 + 0.03),
  ]);
  g.add(new THREE.Mesh(tri, new THREE.MeshBasicMaterial({ color: MARK, side: THREE.DoubleSide })));
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

function renderGrid(items) {
  const canvas = $('stage');
  const stage = createStage(canvas);
  const kit = createKit();
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const camera = view === 'top' ? topCamera(W / H) : new THREE.PerspectiveCamera(35, W / H, 0.05, 500);
  // Laid out by footprint and by how tall each model really stands (mirrors and monitors included).
  const entries = items.map((def) => {
    const obj = def.build(kit, { w: def.w, d: def.d, h: def.h });
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
  for (const { def, x, z } of placed) pin(camera, rect, new THREE.Vector3(x, 0, z + def.d / 2), def.name, `?item=${def.type}`);
}

function renderCloseUp(def, o) {
  const canvas = $('stage');
  const stage = createStage(canvas);
  const kit = createKit();
  const obj = def.build(kit, o);
  const fp = footprint(o.w, o.d);
  const volume = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(o.w, o.h, o.d)),
    new THREE.LineBasicMaterial({ color: MARK, transparent: true, opacity: 0.45 }));
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
    const tag = document.createElement('span');
    tag.className = 'view';
    tag.textContent = label;
    Object.assign(tag.style, { left: `${rect.x + 8}px`, top: `${rect.y + 8}px` });
    $('labels').append(tag);
  });
  renderer.setScissorTest(false);

  let meshes = 0;
  obj.traverse((m) => { if (m.isMesh) meshes++; });
  const over = [
    ['left', -o.w / 2 - model.min.x], ['right', model.max.x - o.w / 2], ['back', -o.d / 2 - model.min.z],
    ['front', model.max.z - o.d / 2], ['below the floor', -model.min.y], ['top', model.max.y - o.h],
  ].filter(([, v]) => v > 0.005).map(([k, v]) => `${k} ${fmt(v)} m`);
  const flags = [`resizable: ${def.resizable ? (def.resizableHeight ? 'width, depth and height' : 'width and depth') : 'no'}`,
    `blocking: ${def.blocking !== false ? 'yes' : 'no'}`, `contact shadow: ${def.blocking === false || def.contactShadow === false ? 'none' : def.contactShadow === 'round' ? 'round' : 'footprint'}`];
  $('report').textContent = [
    `${def.name} (${def.type}), ${size(o)}${o.w !== def.w || o.d !== def.d || o.h !== def.h ? `, default ${size(def)}` : ''}`,
    `Model bounds: x ${fmt(model.min.x)} to ${fmt(model.max.x)}, y ${fmt(model.min.y)} to ${fmt(model.max.y)}, z ${fmt(model.min.z)} to ${fmt(model.max.z)} (${meshes} meshes)`,
    over.length ? `Past its footprint: ${over.join(', ')}` : 'Inside its footprint',
    flags.join(', '),
  ].join('\n');
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
    const o = { w: num('w'), d: num('d'), h: num('h') };
    renderCloseUp(def, o);
    const fit = Math.min(300, Math.max(80, 400 / Math.max(o.w, o.d)));
    renderSymbols([30, 60, Math.round(fit)].map((px) => ({ def, o, px, title: `${px} px per m`, note: px < 40 ? 'Zoomed out, no small details' : 'Zoomed in' })));
    window.previewItems = [def.type];
  } else {
    const items = listItems(category);
    if (!items.length) throw new Error(`No items registered for category "${category}"`);
    renderGrid(items);
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
