// Developer preview for src/builder3d.js: builds a representative 20 x 14 m suite in code and
// renders it from eye height or from above. Open /dev/builder-test.html?view=1 (1 to 6, overview,
// outside or stress); add &exterior=city|campus|none, &quality=low, &ceiling=tile|drywall|open.
import * as THREE from 'three';
import { createKit } from '../src/kit3d.js';
import { createPlan, normalizePlan, addWall, addOpening, addRoom, addItem, DEFAULTS } from '../src/model.js';
import { buildPlanScene, setupEnvironment } from '../src/builder3d.js';
import { getItem, hasItem, listItems, registerItems } from '../src/catalog/registry.js';

const params = new URLSearchParams(location.search);
const view = params.get('view') || '1';
const planName = params.get('plan') || 'suite';
const quality = params.get('quality') === 'low' ? 'low' : 'high';
const exterior = params.get('exterior') || 'city';
const ceiling = params.get('ceiling') || 'tile';

const SHAPE_VIEWS = {
  1: { label: 'Hub', x: 2.2, y: 11.2, yaw: 22, pitch: 4 },
  2: { label: 'Work', x: 15.2, y: 5.4, yaw: 290, pitch: 2 },
  3: { label: 'Angled wall', x: 4, y: 7.5, yaw: 110, pitch: 0 },
};

const ITEM_VIEWS = {
  1: { label: 'Items', x: 4, y: 5.6, yaw: 0, pitch: -22 },
};

const SUITE_VIEWS = {
  1: { label: 'Open office', x: 0.9, y: 6.4, yaw: 66, pitch: -2 },
  2: { label: 'Conference', x: 19.2, y: 5.4, yaw: 305, pitch: 0 },
  3: { label: 'Cafe', x: 12.9, y: 13.2, yaw: 40, pitch: 4 },
  4: { label: 'Reception', x: 11.4, y: 12.6, yaw: 308, pitch: -2 },
  5: { label: 'Corridor', x: 6, y: 13.4, yaw: 4, pitch: 0 },
  6: { label: 'Lab', x: 4.5, y: 8.5, yaw: 232, pitch: -10 },
  7: { label: 'Sliding door', x: 8.6, y: 11.6, yaw: 98, pitch: -4 },
  8: { label: 'Window', x: 18.3, y: 4.2, yaw: 62, pitch: -6 },
  9: { label: 'Entry', x: 9.4, y: 10.6, yaw: 172, pitch: -6 },
  10: { label: 'Glass door', x: 9.6, y: 3.8, yaw: 75, pitch: -4 },
};
const VIEWS = { shapes: SHAPE_VIEWS, items: ITEM_VIEWS }[planName] || SUITE_VIEWS;

const nav = document.getElementById('views');
for (const [key, label] of [...Object.entries(VIEWS).map(([k, v]) => [k, v.label]), ['overview', 'Overview'], ['outside', 'Outside'], ['stress', 'Stress test']]) {
  const a = document.createElement('a');
  const q = new URLSearchParams(params);
  q.set('view', key);
  a.href = `?${q}`;
  a.textContent = label;
  if (key === view) a.setAttribute('aria-current', 'page');
  nav.append(a);
}

let catalog = 'catalog';
try {
  await import('../src/catalog/index.js');
} catch (err) {
  // Category modules land independently; load whichever exist and use placeholders for the rest.
  const loaded = await Promise.allSettled(['lab', 'medical', 'office', 'retail'].map((c) => import(`../src/catalog/${c}.js`)));
  const ready = ['lab', 'medical', 'office', 'retail'].filter((c, i) => loaded[i].status === 'fulfilled');
  catalog = ready.length ? `partial catalog (${ready.join(', ')})` : 'placeholders';
  console.warn('Catalog index is not ready:', err.message);
}

/** First registered type from `preferred`, else the n-th item of a category, else a placeholder. */
function pick(preferred, category, n = 0) {
  for (const t of preferred) if (hasItem(t)) return t;
  const list = listItems(category);
  return list.length ? list[n % list.length].type : `placeholder-${category}`;
}

function suitePlan() {
  const plan = createPlan({ name: 'Builder test suite', settings: { wallHeight: DEFAULTS.wallHeight, ceiling, exterior } });
  const wall = (ax, ay, bx, by, kind) => addWall(plan, { x: ax, y: ay }, { x: bx, y: by }, { kind });
  const open = (w, type, offset, props) => addOpening(plan, w.id, type, offset, props);

  const north = wall(0, 0, 20, 0, 'exterior');
  const east = wall(20, 0, 20, 14, 'exterior');
  const south = wall(20, 14, 0, 14, 'exterior');
  const west = wall(0, 14, 0, 0, 'exterior');
  for (const x of [1.8, 4.6, 7.4, 10.2]) open(north, 'window', x);
  for (const x of [14.5, 17.6]) open(north, 'window', x, { width: 2.4 });
  open(east, 'window', 3, { width: 3 });
  for (const y of [9, 12]) open(east, 'window', y, { width: 2.4 });
  for (const x of [17.5, 14.5]) open(south, 'window', 20 - x);
  open(south, 'double-door', 20 - 9.5, { side: 1 });
  open(south, 'window', 20 - 6, { width: 1.2 });
  open(south, 'window', 20 - 2.5);
  for (const y of [2.5, 5.5]) open(west, 'window', 14 - y);
  open(west, 'window', 14 - 11);

  const glass = wall(12, 0, 12, 6, 'glass');
  open(glass, 'door', 3, { side: -1, hinge: 'start' });
  const confCafe = wall(12, 6, 20, 6, 'interior');
  open(confCafe, 'double-door', 4, { side: 1 });
  const receptionCafe = wall(12, 6, 12, 14, 'interior');
  open(receptionCafe, 'sliding-door', 5, { side: -1 });
  const labTop = wall(0, 8, 5, 8, 'interior');
  open(labTop, 'door', 2.5, { side: -1, hinge: 'end' });
  const labEast = wall(5, 8, 5, 14, 'interior');
  open(labEast, 'window', 3, { width: 1.8, height: 1.2, sill: 0.9 });
  const corridor = wall(7, 8, 7, 14, 'interior');
  open(corridor, 'opening', 3.5, { width: 1.22 });
  wall(7, 8, 10, 8, 'partial');

  addRoom(plan, [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 8 }, { x: 0, y: 8 }], { name: 'Open office', floor: 'carpet', ceiling: 'tile' });
  addRoom(plan, [{ x: 12, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 6 }, { x: 12, y: 6 }], { name: 'Conference', floor: 'wood', ceiling: 'drywall' });
  addRoom(plan, [{ x: 12, y: 6 }, { x: 20, y: 6 }, { x: 20, y: 14 }, { x: 12, y: 14 }], { name: 'Cafe', floor: 'vinyl', ceiling: 'open' });
  addRoom(plan, [{ x: 0, y: 8 }, { x: 5, y: 8 }, { x: 5, y: 14 }, { x: 0, y: 14 }], { name: 'Lab', floor: 'epoxy', ceiling: 'tile' });
  addRoom(plan, [{ x: 7, y: 8 }, { x: 12, y: 8 }, { x: 12, y: 14 }, { x: 7, y: 14 }], { name: 'Reception', floor: 'tile', ceiling: 'drywall' });

  const item = (type, x, y, rotation = 0, { elevation, ...dims } = {}) => {
    const it = addItem(plan, type, x, y, { rotation, ...dims });
    if (elevation) it.elevation = elevation;
    return it;
  };
  const desk = pick(['workstation', 'desk', 'office-desk'], 'office', 0);
  const chair = pick(['task-chair', 'office-chair', 'chair'], 'office', 1);
  for (let i = 0; i < 4; i++) {
    for (const [y, rot] of [[2.6, 180], [3.6, 0]]) {
      item(desk, 2.2 + i * 1.7, y, rot, { w: 1.5, d: 0.75, h: 0.74 });
      item(chair, 2.2 + i * 1.7, y + (rot ? -0.65 : 0.65), rot, { w: 0.62, d: 0.62, h: 1.0 });
    }
  }
  item(pick(['sofa', 'lounge-sofa'], 'office', 2), 3, 6.8, 0, { w: 2.1, d: 0.85, h: 0.8 });
  item(pick(['planter', 'plant', 'floor-plant'], 'general', 0), 11.3, 0.8, 0, { w: 0.6, d: 0.6, h: 1.4 });
  item(pick(['conference-table'], 'office', 3), 16, 3, 0, { w: 3.6, d: 1.2, h: 0.74 });
  for (let i = 0; i < 4; i++) {
    item(chair, 14.8 + i * 0.8, 2.0, 180, { w: 0.6, d: 0.6, h: 1.0 });
    item(chair, 14.8 + i * 0.8, 4.0, 0, { w: 0.6, d: 0.6, h: 1.0 });
  }
  item(pick(['display', 'tv-display', 'wall-display'], 'office', 4), 14, 5.88, 180, { w: 1.6, d: 0.1, h: 0.95, elevation: 1.0 });
  for (const [x, y] of [[14, 9], [16.5, 9], [14, 11.5], [16.5, 11.5]]) item(pick(['cafe-table', 'bistro-table'], 'office', 5), x, y, 0, { w: 0.9, d: 0.9, h: 0.74 });
  item(pick(['kitchen-counter', 'counter'], 'retail', 0), 19.6, 10.5, 270, { w: 4, d: 0.65, h: 0.92 });
  // Lab items use their catalog sizes, backs against the wall faces (inner faces at x 0.15, x 4.94, y 13.85).
  const depth = (t) => getItem(t).d / 2;
  const bench = pick(['lab-bench-island', 'lab-bench'], 'lab', 0);
  item(bench, 2.5, 11.1, 90);
  const hood = pick(['fume-hood'], 'lab', 1);
  item(hood, 0.15 + depth(hood), 9.6, 270);
  const bsc = pick(['biosafety-cabinet'], 'lab', 2);
  item(bsc, 1.3, 13.85 - depth(bsc), 180);
  const freezer = pick(['ult-freezer'], 'lab', 3);
  item(freezer, 4.94 - depth(freezer), 12.9, 90);
  for (const y of [10.4, 11.8]) item(pick(['lab-stool'], 'lab', 4), 3.55, y, 270);
  item(pick(['reception-desk'], 'medical', 0), 9.5, 10.2, 0, { w: 2.4, d: 0.8, h: 1.05 });
  item(pick(['lounge-chair', 'guest-chair'], 'medical', 1), 8, 12.6, 30, { w: 0.75, d: 0.75, h: 0.8 });
  item(pick(['planter', 'plant'], 'general', 0), 11.4, 8.7, 0, { w: 0.6, d: 0.6, h: 1.4 });
  return normalizePlan(plan);
}

/** Items that stress the merge path: failures, groups, instancing, odd attributes, mirroring. */
function registerTestItems() {
  const draw2d = (ctx, { w, d, px, theme }) => {
    ctx.strokeStyle = theme.line;
    ctx.lineWidth = 1.25 * px;
    ctx.strokeRect(-w / 2, -d / 2, w, d);
  };
  const def = (type, build, extra = {}) => ({ type, name: type, category: 'general', w: 0.8, d: 0.6, h: 0.9, build, draw2d, ...extra });
  registerItems([
    def('test-throws', () => { throw new Error('deliberate failure'); }),
    def('test-null', () => null),
    def('test-multi', (kit, { w, d, h }) => {
      const g = new THREE.BoxGeometry(w, h, d);
      g.translate(0, h / 2, 0);
      return new THREE.Mesh(g, [kit.mat.cbreGreen, kit.mat.white, kit.mat.oak, kit.mat.oak, kit.mat.white, kit.mat.accentGreen]);
    }),
    def('test-instanced', (kit, { w, d, h }) => {
      const m = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.06, h, 12), kit.mat.steel, 4);
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([x, z], i) => m.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x * (w / 2 - 0.06), h / 2, z * (d / 2 - 0.06))));
      const g = kit.group();
      g.add(m);
      kit.block(g, kit.mat.walnut, -w / 2, w / 2, h - 0.04, h, -d / 2, d / 2);
      return g;
    }),
    def('test-nonindexed', (kit, { w, d, h }) => {
      const src = new THREE.ConeGeometry(Math.min(w, d) / 2, h, 5).toNonIndexed();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', src.getAttribute('position'));
      g.translate(0, h / 2, 0);
      return new THREE.Mesh(g, kit.mat.safetyOrange);
    }),
    def('test-mirror', (kit, { w, d, h }) => {
      const g = kit.group();
      kit.block(g, kit.mat.fabricSage, -w / 2, w / 2, 0, h * 0.45, -d / 2, d / 2);
      kit.block(g, kit.mat.fabricSage, -w / 2, -w / 2 + 0.15, 0, h, -d / 2, d / 2);
      g.scale.x = -1;
      const outer = kit.group();
      outer.add(g);
      return outer;
    }),
    def('test-light-line', (kit, { w, d, h }) => {
      const g = kit.group();
      kit.block(g, kit.mat.black, -0.05, 0.05, 0, h, -0.05, 0.05);
      const light = new THREE.PointLight('#fff2dd', 0.6, 4);
      light.position.set(0, h, 0);
      g.add(light);
      const line = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, 0.01, d)), new THREE.LineBasicMaterial({ color: '#17e88f' }));
      g.add(line);
      return g;
    }),
    def('test-glass', (kit, { w, d, h }) => {
      const g = kit.group();
      kit.block(g, kit.mat.steel, -w / 2, w / 2, 0, 0.05, -d / 2, d / 2);
      kit.block(g, kit.glass, -w / 2, w / 2, 0.05, h, -0.01, 0.01);
      return g;
    }),
    def('test-interleaved', (kit, { w, d, h }) => {
      const base = new THREE.BoxGeometry(w, h, d);
      base.translate(0, h / 2, 0);
      const pos = base.getAttribute('position'), nrm = base.getAttribute('normal');
      const data = new Float32Array(pos.count * 6);
      for (let i = 0; i < pos.count; i++) data.set([pos.getX(i), pos.getY(i), pos.getZ(i), nrm.getX(i), nrm.getY(i), nrm.getZ(i)], i * 6);
      const buf = new THREE.InterleavedBuffer(data, 6);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.InterleavedBufferAttribute(buf, 3, 0));
      g.setAttribute('normal', new THREE.InterleavedBufferAttribute(buf, 3, 3));
      g.setIndex(base.getIndex());
      return new THREE.Mesh(g, kit.mat.fabricCeladon);
    }),
    def('test-rug', (kit, { w, d }) => {
      const g = kit.group();
      kit.block(g, kit.mat.fabricWheat, -w / 2, w / 2, 0, 0.01, -d / 2, d / 2, false);
      return g;
    }, { blocking: false, w: 2, d: 1.4, h: 0.01 }),
  ]);
}

function itemsPlan() {
  registerTestItems();
  const plan = createPlan({ name: 'Item checks', settings: { wallHeight: DEFAULTS.wallHeight, ceiling: 'drywall', exterior } });
  const P = (x, y) => ({ x, y });
  const shell = [P(0, 0), P(8, 0), P(8, 6), P(0, 6)];
  shell.forEach((p, i) => addWall(plan, p, shell[(i + 1) % 4], { kind: 'exterior' }));
  addRoom(plan, shell, { name: 'Checks', floor: 'tile', ceiling: 'drywall' });
  const types = ['test-throws', 'test-null', 'test-multi', 'test-instanced', 'test-nonindexed', 'test-mirror', 'test-light-line', 'test-glass', 'test-interleaved', 'not-registered'];
  types.forEach((t, i) => addItem(plan, t, 1.2 + (i % 5) * 1.4, 1.6 + Math.floor(i / 5) * 2.2, { rotation: i * 25 }));
  addItem(plan, 'test-rug', 4, 4.8);
  return normalizePlan(plan);
}

/** L-shaped shell with an angled wall, rooms that meet without walls and a few awkward openings. */
function shapesPlan() {
  const plan = createPlan({ name: 'Shapes', settings: { wallHeight: DEFAULTS.wallHeight, ceiling: params.get('ceiling') || 'drywall', exterior } });
  const P = (x, y) => ({ x, y });
  const shell = [P(0, 0), P(16, 0), P(16, 6), P(10, 6), P(8, 12), P(0, 12)];
  const walls = shell.map((p, i) => addWall(plan, p, shell[(i + 1) % shell.length], { kind: 'exterior' }));
  addOpening(plan, walls[0].id, 'window', 3, { width: 1.5 });
  addOpening(plan, walls[0].id, 'window', 3.6, { width: 1.5 });
  addOpening(plan, walls[0].id, 'window', 8, { width: 3 });
  addOpening(plan, walls[0].id, 'window', 13, { width: 3 });
  addOpening(plan, walls[1].id, 'window', 3, { width: 3, sill: 0, height: 2.4 });
  addOpening(plan, walls[3].id, 'door', 3.2, { side: 1 });
  addOpening(plan, walls[4].id, 'window', 4, { width: 1.8 });
  addOpening(plan, walls[5].id, 'window', 6, { width: 25 });

  const glass = [P(11, 1), P(15, 1), P(15, 4.5), P(11, 4.5)];
  const room = glass.map((p, i) => addWall(plan, p, glass[(i + 1) % glass.length], { kind: 'glass' }));
  addOpening(plan, room[2].id, 'sliding-door', 2, { side: 1 });
  addOpening(plan, room[3].id, 'double-door', 1.75, { side: -1 });
  addOpening(plan, room[0].id, 'window', 2);
  const diag = addWall(plan, P(1, 7.5), P(4, 10.5), { kind: 'interior' });
  addOpening(plan, diag.id, 'door', 2.1, { side: -1 });
  addWall(plan, P(6.5, 7), P(6.5, 9), { kind: 'partial' });

  addRoom(plan, [P(0, 0), P(6, 0), P(6, 6), P(0, 6)], { name: 'Lounge', floor: 'wood', ceiling: 'open' });
  addRoom(plan, [P(6, 0), P(16, 0), P(16, 6), P(6, 6)], { name: 'Work', floor: 'carpet', ceiling: 'tile' });
  addRoom(plan, [P(0, 6), P(6, 6), P(6, 12), P(0, 12)], { name: 'Hub', floor: 'rubber', ceiling: 'tile', height: 3.2 });
  const chair = pick(['task-chair', 'office-chair'], 'office', 1);
  for (let i = 0; i < 3; i++) addItem(plan, pick(['lounge-chair'], 'office', 2), 1.5 + i * 1.5, 2, { rotation: 180 + i * 20 });
  addItem(plan, pick(['conference-table'], 'office', 3), 13, 2.75, { rotation: 0, w: 2.4, d: 1.1, h: 0.74 });
  for (const x of [12.3, 13.7]) for (const [y, r] of [[1.9, 180], [3.6, 0]]) addItem(plan, chair, x, y, { rotation: r, w: 0.6, d: 0.6, h: 1 });
  addItem(plan, pick(['planter', 'plant'], 'general', 0), 7.5, 10.5, { w: 0.6, d: 0.6, h: 1.4 });
  return normalizePlan(plan);
}

/** A grid of 12 x 12 rooms (312 walls) with doors, windows and 600 items, for timing. */
function stressPlan() {
  const plan = createPlan({ name: 'Stress plan', settings: { wallHeight: DEFAULTS.wallHeight, ceiling, exterior } });
  const n = 12, cell = 5;
  const floors = ['carpet', 'wood', 'vinyl', 'tile', 'epoxy', 'rubber', 'polished-concrete', 'concrete'];
  const ceilings = ['tile', 'drywall', 'open'];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i < n; i++) {
      const edge = j === 0 || j === n;
      const w = addWall(plan, { x: i * cell, y: j * cell }, { x: (i + 1) * cell, y: j * cell }, { kind: edge ? 'exterior' : (i + j) % 7 === 0 ? 'glass' : 'interior' });
      addOpening(plan, w.id, edge ? 'window' : ['door', 'double-door', 'sliding-door', 'opening'][(i + j) % 4], cell / 2, { side: (i % 2) * 2 - 1 });
    }
  }
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j < n; j++) {
      const edge = i === 0 || i === n;
      const w = addWall(plan, { x: i * cell, y: j * cell }, { x: i * cell, y: (j + 1) * cell }, { kind: edge ? 'exterior' : 'interior' });
      if (edge || (i + j) % 3 === 0) addOpening(plan, w.id, edge ? 'window' : 'door', cell / 2, { hinge: j % 2 ? 'end' : 'start' });
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = i * cell, y = j * cell;
      addRoom(plan, [{ x, y }, { x: x + cell, y }, { x: x + cell, y: y + cell }, { x, y: y + cell }],
        { floor: floors[(i * 3 + j) % floors.length], ceiling: ceilings[(i + j * 2) % 3] });
    }
  }
  const types = [...new Set(['office', 'lab', 'medical', 'retail', 'general'].flatMap((c) => listItems(c).map((d) => d.type)))];
  for (let k = 0; k < 600; k++) {
    const room = k % (n * n);
    const i = room % n, j = Math.floor(room / n), slot = Math.floor(k / (n * n));
    const type = types.length ? types[k % types.length] : 'placeholder';
    addItem(plan, type, i * cell + 1.2 + (slot % 3) * 1.3, j * cell + 1.2 + Math.floor(slot / 3) * 2.2, { rotation: (k * 37) % 360 });
  }
  return normalizePlan(plan);
}

const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = Number(params.get('exposure') || 1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#e8eff2');
const env = setupEnvironment(renderer, scene);
const kit = createKit();
const camera = new THREE.PerspectiveCamera(60, canvas.clientWidth / canvas.clientHeight, 0.05, 2000);

const PLANS = { shapes: shapesPlan, items: itemsPlan, suite: suitePlan };
const plan = view === 'stress' ? stressPlan() : (PLANS[planName] || suitePlan)();
const t0 = performance.now();
const built = buildPlanScene(plan, { kit, quality });
const buildMs = performance.now() - t0;
scene.add(built.root);
env.fit(built.bounds);
Object.assign(window, { built, testPlan: plan, testQuality: quality });

const b = built.bounds;
const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2;
const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);

function eye({ x, y, yaw, pitch = 0 }) {
  const yr = THREE.MathUtils.degToRad(yaw), pr = THREE.MathUtils.degToRad(pitch);
  camera.position.set(x, DEFAULTS.eyeHeight, y);
  camera.lookAt(x + Math.sin(yr) * Math.cos(pr), DEFAULTS.eyeHeight + Math.sin(pr), y - Math.cos(yr) * Math.cos(pr));
}

if (view === 'overview' || view === 'stress') {
  for (const c of built.ceilings) c.visible = false;
  camera.fov = 45;
  camera.position.set(cx + span * 0.22, span * 1.05, cz + span * 0.82);
  camera.lookAt(cx, 0, cz + span * 0.04);
} else if (view === 'outside') {
  camera.position.set(cx - span * 0.35, 1.7, b.maxY + span * 0.55);
  camera.lookAt(cx, 2.2, b.maxY);
} else {
  eye(VIEWS[view] || VIEWS[1]);
}
camera.updateProjectionMatrix();

renderer.render(scene, camera);
renderer.render(scene, camera);
const info = renderer.info.render;
const stats = {
  catalog, quality, buildMs: Math.round(buildMs), calls: info.calls, triangles: info.triangles,
  walls: plan.walls.length, items: plan.items.length, colliders: built.colliders.length, obstacles: built.obstacles.length,
};
if (view === 'stress') {
  for (const c of built.ceilings) c.visible = true;
  eye({ x: 2.5, y: 2.5, yaw: 135 });
  camera.fov = 60;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  stats.walkCalls = renderer.info.render.calls;
  stats.walkTriangles = renderer.info.render.triangles;
  for (const c of built.ceilings) c.visible = false;
  camera.fov = 45;
  camera.position.set(cx + span * 0.22, span * 1.05, cz + span * 0.82);
  camera.lookAt(cx, 0, cz + span * 0.04);
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
}
window.testStats = stats;
window.rerender = () => renderer.render(scene, camera);
window.testEnv = { THREE, renderer, scene, camera, kit, env, buildPlanScene };
document.getElementById('stats').textContent = `${stats.buildMs} ms build · ${stats.calls} draw calls · ${(stats.triangles / 1000).toFixed(0)}k triangles · ${catalog}`;
console.log('builder-test', JSON.stringify(stats));
window.testReady = true;
