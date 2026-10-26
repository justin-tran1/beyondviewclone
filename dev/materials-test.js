// Material board for src/kit3d.js: every floor, wall, ceiling, glass and item material as a sphere
// and a beveled box under a soft studio light and an environment, labeled, so the finishes can be
// inspected side by side. Open /dev/materials-test.html?section=floors (all, floors, architecture
// or items); add &focus=<name> to frame one swatch, &env=none to see direct light only,
// &tone=aces to compare tone curves, or &exposure=1.2. Drag to orbit, scroll to zoom.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createKit, MATERIAL_PRESETS, FLOOR_FINISHES, WALL_TYPES, CEILING_TYPES } from '../src/kit3d.js';
import { FLOORS, WALL_FINISHES, CEILINGS } from '../src/finishes.js';

const params = new URLSearchParams(location.search);
const section = params.get('section') || 'all';
const focus = params.get('focus');
const t0 = performance.now();

const label = (table, k) => table[k]?.label || k;
const WALL_LABELS = { panel: 'Impact panel' };

const nav = document.getElementById('views');
for (const [key, label] of [['all', 'All'], ['floors', 'Floors'], ['architecture', 'Walls and ceilings'], ['items', 'Items']]) {
  const a = document.createElement('a');
  const q = new URLSearchParams(params);
  q.set('section', key);
  q.delete('focus');
  a.href = `?${q}`;
  a.textContent = label;
  if (key === section) a.setAttribute('aria-current', 'page');
  nav.append(a);
}

try {
  run();
} catch (err) {
  document.getElementById('err').textContent = err.stack || String(err);
  window.testReady = true;
  window.testError = String(err);
  throw err;
}

function run() {
  const kit = createKit();
  // Studio balance: a moderate environment under one soft key light.
  kit.setEnvironmentIntensity(+(params.get('envIntensity') || 0.7));
  const canvas = document.getElementById('c');
  const stage = document.getElementById('stage');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = params.get('tone') === 'aces' ? THREE.ACESFilmicToneMapping : THREE.AgXToneMapping;
  renderer.toneMappingExposure = +(params.get('exposure') || 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#d9dcda');
  if (params.get('env') !== 'none') {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment(renderer);
    scene.environment = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
  }
  // Soft key from the upper left, a faint cool fill from the right.
  const key = new THREE.DirectionalLight('#fff4e6', 1.8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 4;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.01;
  const fill = new THREE.DirectionalLight('#e6eef5', 0.35);
  scene.add(key, key.target, fill);

  // ---- Swatches ----
  const rows = [];
  const add = (title, list) => rows.push({ title, list });
  if (section === 'all' || section === 'floors') {
    add('Floors', FLOOR_FINISHES.map((k) => ({ name: label(FLOORS, k), sub: `floorMaterial('${k}')`, kind: 'floor', mat: kit.floorMaterial(k), meters: kit.floorMeters(k) })));
    // Each floor in its last colorway, as a room can choose it.
    add('', FLOOR_FINISHES.map((k) => {
      const [hex, name] = FLOORS[k].colors.at(-1);
      return { name: `${label(FLOORS, k)}, ${name.toLowerCase()}`, sub: `floorMaterial('${k}', '${hex}')`, kind: 'floor', mat: kit.floorMaterial(k, hex), meters: kit.floorMeters(k) };
    }));
  }
  if (section === 'all' || section === 'architecture') {
    add('Walls and ceilings', [
      { name: 'Warm white paint', sub: 'paintMaterial()', mat: kit.paintMaterial() },
      { name: 'Celadon accent paint', sub: "paintMaterial('#80bbad')", mat: kit.paintMaterial('#80bbad') },
      { name: 'Dark grey paint', sub: "paintMaterial('#435254')", mat: kit.paintMaterial('#435254') },
      ...WALL_TYPES.filter((t) => t !== 'paint').map((t) => ({ name: WALL_LABELS[t] || label(WALL_FINISHES, t), sub: `wallMaterial('${t}')`, mat: kit.wallMaterial(t) })),
      ...CEILING_TYPES.map((t) => ({ name: label(CEILINGS, t), sub: `ceilingMaterial('${t}')`, kind: 'ceiling', mat: kit.ceilingMaterial(t) })),
      { name: 'Clear glass', sub: 'glassMaterial()', kind: 'glass', mat: kit.glassMaterial() },
      { name: 'Tinted glass', sub: "glassMaterial({ tint: '#9fb8b4' })", kind: 'glass', mat: kit.glassMaterial({ tint: '#9fb8b4' }) },
      { name: 'Frosted glass', sub: 'glassMaterial({ frosted })', kind: 'glass', mat: kit.glassMaterial({ frosted: true }) },
    ]);
  }
  if (section === 'all' || section === 'items') {
    const items = MATERIAL_PRESETS.map((k) => ({ name: k, sub: `kit.mat.${k}`, mat: kit.mat[k] }));
    const per = 9;
    for (let i = 0; i < items.length; i += per) add(i ? '' : 'Item materials', items.slice(i, i + per));
  }

  const cell = 1.1;
  const cols = Math.max(...rows.map((r) => r.list.length));
  const board = new THREE.Group();
  const anchors = [];
  // focus matches a label, a key in quotes or a preset name, exact matches first.
  const all = rows.flatMap((r) => r.list);
  const exact = (s) => s.name === focus || s.sub.includes(`'${focus}'`) || s.sub === `kit.mat.${focus}`;
  const shown = focus ? [...all.filter(exact), ...all.filter((s) => !exact(s) && s.sub.includes(focus))] : null;
  let z = 0;
  for (const row of rows) {
    if (row.title) anchors.push({ kind: 'section', text: row.title, at: new THREE.Vector3(-cols * cell / 2 - 0.1, 0, z) });
    row.list.forEach((sw, i) => {
      const x = (i - (cols - 1) / 2) * cell;
      const g = swatch(kit, sw);
      g.position.set(x, 0, z);
      board.add(g);
      sw.center = new THREE.Vector3(x, 0.2, z);
      anchors.push({ kind: 'label', sw, at: new THREE.Vector3(x, 0, z + 0.34) });
    });
    z += 1.7;
  }
  const depth = z;
  board.position.z = -depth / 2 + 0.6;
  scene.add(board);
  board.updateMatrixWorld(true);
  for (const a of anchors) a.at.applyMatrix4(board.matrixWorld);
  for (const sw of rows.flatMap((r) => r.list)) sw.center.applyMatrix4(board.matrixWorld);

  // Cyclorama floor: one neutral matte plane that fades into the background color.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), kit.material('#c9ccca', { roughness: 0.92 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const span = Math.max(cols * cell, depth);
  key.position.set(-span * 0.5, span * 0.9, span * 0.6);
  key.target.position.set(0, 0, 0);
  fill.position.set(span, span * 0.4, -span * 0.2);
  Object.assign(key.shadow.camera, { left: -span * 0.75, right: span * 0.75, top: span * 0.75, bottom: -span * 0.75, near: 0.5, far: span * 3 });
  key.shadow.camera.updateProjectionMatrix();

  // ---- Camera ----
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 500);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.maxPolarAngle = THREE.MathUtils.degToRad(86);
  // Frame the board (or one swatch) from about 40 degrees up so every swatch and label fits.
  function frame() {
    const aspect = stage.clientWidth / Math.max(1, stage.clientHeight);
    const vf = THREE.MathUtils.degToRad(camera.fov / 2), hf = Math.atan(Math.tan(vf) * aspect);
    const el = THREE.MathUtils.degToRad(focus ? 32 : 58);
    if (shown?.length) {
      const c = shown[0].center;
      controls.target.copy(c);
      camera.position.set(c.x, c.y + Math.sin(el) * 1.6, c.z + Math.cos(el) * 1.6);
    } else {
      // Room on the left for section titles.
      const w = cols * cell + 3, d = depth + 0.4;
      const dist = Math.max(w / 2 / Math.tan(hf), (d * Math.sin(el)) / 2 / Math.tan(vf) + d / 2 * Math.cos(el)) * 1.08;
      controls.target.set(0, 0, 0.2);
      camera.position.set(0, Math.sin(el) * dist, 0.2 + Math.cos(el) * dist);
    }
    controls.update();
  }

  const labels = document.getElementById('labels');
  for (const a of anchors) {
    const el = document.createElement('div');
    el.className = a.kind;
    if (a.kind === 'section') el.textContent = a.text;
    else el.innerHTML = `${html(a.sw.name)}<small>${html(a.sw.sub)}</small>`;
    labels.append(el);
    a.el = el;
  }

  const v = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  function placeLabels() {
  const w = stage.clientWidth, h = stage.clientHeight;
  // Drop the code line under each name when swatches get too small on screen for both.
  v.set(0, 0, 0).project(camera);
  v2.set(cell, 0, 0).project(camera);
  labels.classList.toggle('compact', (Math.abs(v2.x - v.x) / 2) * w < 150);
    for (const a of anchors) {
      v.copy(a.at).project(camera);
      const visible = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      a.el.style.display = visible ? '' : 'none';
      a.el.style.left = `${((v.x + 1) / 2) * w}px`;
      a.el.style.top = `${((1 - v.y) / 2) * h}px`;
    }
  }

  let pending = false;
  function render(timed = false) {
    pending = false;
    const t = performance.now();
    renderer.render(scene, camera);
    // Read a pixel back so the measured time includes the GPU work (finish() does not wait).
    if (timed) {
      const gl = renderer.getContext();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    }
    placeLabels();
    return performance.now() - t;
  }
  const invalidate = () => {
    if (!pending) {
      pending = true;
      requestAnimationFrame(() => render());
    }
  };
  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    invalidate();
  }
  controls.addEventListener('change', invalidate);
  new ResizeObserver(() => resize()).observe(stage);
  resize();
  frame();
  const setupMs = performance.now() - t0;
  // First frame compiles every program; the second is the steady cost.
  render(true);
  const frameMs = render(true);
  const info = renderer.info;
  const swatches = rows.reduce((n, r) => n + r.list.length, 0);
  document.getElementById('stats').textContent = `${swatches} swatches · ${info.memory.textures} textures · ${info.programs.length} programs · ${Math.round(frameMs)} ms per frame`;
  window.testInfo = { swatches, setupMs: Math.round(setupMs), frameMs: Math.round(frameMs), textures: info.memory.textures, programs: info.programs.length, triangles: info.render.triangles, calls: info.render.calls };
  window.testReady = true;
  window.board = { renderer, scene, camera, controls, render, kit };
}

/** A sample of one material: floors as a patch with a sphere, the rest as a sphere and a beveled box. */
function swatch(kit, sw) {
  const g = new THREE.Group();
  const m = sw.mat;
  if (sw.kind === 'floor') {
    // Floor maps expect UVs in plan meters / floorMeters(key).
    const patch = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.02, 0.92), m);
    scaleUVs(patch.geometry, 0.92 / sw.meters, 0.92 / sw.meters);
    patch.position.y = 0.01;
    patch.receiveShadow = true;
    const ball = kit.sphere(g, m, 0.13, 0.2, 0.15, -0.18, { segments: 48 });
    scaleUVs(ball.geometry, 1 / sw.meters, 1 / sw.meters);
    g.add(patch);
    return g;
  }
  if (sw.kind === 'glass') {
    // A striped card behind the pane shows the tint, the transmission and the reflections.
    const card = new THREE.Group();
    for (let i = 0; i < 6; i++) kit.block(card, kit.material(i % 2 ? '#2b3134' : '#e8e6e0', { roughness: 0.8 }), -0.42 + i * 0.14, -0.28 + i * 0.14, 0, 0.62, -0.32, -0.3);
    g.add(card);
    kit.block(g, kit.mat.darkSteel, -0.36, 0.36, 0, 0.03, -0.06, 0.06);
    kit.block(g, m, -0.34, 0.34, 0.03, 0.6, -0.006, 0.006, false);
    kit.sphere(g, m, 0.12, 0.28, 0.12, 0.26, { segments: 48 });
    return g;
  }
  // Spheres show reflections and sheen; the box shows bevels, grain direction and texture scale.
  kit.sphere(g, m, 0.17, -0.22, 0.17, 0, { segments: 48 });
  if (sw.kind === 'ceiling') {
    kit.block(g, m, 0.02, 0.44, 0, 0.36, -0.21, 0.21);
  } else {
    kit.block(g, m, 0.04, 0.42, 0, 0.36, -0.19, 0.19);
  }
  return g;
}

function scaleUVs(geometry, su, sv) {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
}

function html(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
