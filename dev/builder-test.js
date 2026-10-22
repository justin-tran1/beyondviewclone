// Developer preview for src/builder3d.js: builds a representative 20 x 14 m suite in code and
// renders it from eye height or from above. Open /dev/builder-test.html?view=1 (1 to 10, overview,
// outside or stress); add &plan=shapes|items|steps or &sample=<sample id>, &exterior=city|campus|none,
// &quality=low, &ceiling=tile|drywall|open, or &eye=x,y,yaw,pitch[,height] for any view. &checks=1 runs
// the builder regression checks and lists the results over the view. Rendering matches the walkthrough:
// AgX at its exposure, the interior captured for reflections, and post-processing at &fx=high|balanced|fast.
import * as THREE from 'three';
import { createKit } from '../src/kit3d.js';
import { createPlan, normalizePlan, addWall, addOpening, addRoom, addItem, DEFAULTS } from '../src/model.js';
import { buildPlanScene, setupEnvironment, captureEnvironment } from '../src/builder3d.js';
import { createPostFX } from '../src/postfx.js';
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

const STEP_VIEWS = {
  1: { label: 'Hall', x: 24, y: 10, yaw: 250, pitch: 6 },
  2: { label: 'Office box', x: 14.5, y: 11, yaw: 0, pitch: 15 },
  3: { label: 'Studio', x: 6, y: 11, yaw: 0, pitch: 22 },
  4: { label: 'Corridor', x: 1, y: 11, yaw: 0, pitch: 15 },
  5: { label: 'Corridor bend', x: 1, y: 1, yaw: 90, pitch: 15 },
  6: { label: 'Columns', x: 20, y: 10.5, yaw: 0, pitch: 18 },
  7: { label: 'Sliding door', x: 18, y: 1.4, yaw: 340, pitch: 0 },
};

const ITEM_VIEWS = {
  1: { label: 'Items', x: 4, y: 5.6, yaw: 0, pitch: -22 },
  2: { label: 'Contact shadows', x: 4, y: 2.4, yaw: 180, pitch: -40 },
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

// &sample=<id> builds a sample plan instead; its saved views become the numbered views.
const sampleId = params.get('sample');
const sample = sampleId ? await (await import('../src/samples/index.js')).SAMPLES.find((s) => s.id === sampleId)?.build() : null;
const SAMPLE_VIEWS = sample && Object.fromEntries(sample.cameras.map((c, i) => [String(i + 1), { label: c.name, x: c.x, y: c.y, yaw: c.yaw, pitch: c.pitch }]));
const VIEWS = SAMPLE_VIEWS || { shapes: SHAPE_VIEWS, items: ITEM_VIEWS, steps: STEP_VIEWS }[planName] || SUITE_VIEWS;

const nav = document.getElementById('views');
for (const [key, label] of [...Object.entries(VIEWS).map(([k, v]) => [k, v.label]), ['overview', 'Overview'], ['outside', 'Outside'], ['stress', 'Stress test'], ['checks', 'Checks']]) {
  const a = document.createElement('a');
  const q = new URLSearchParams(params);
  q.delete('checks');
  if (key === 'checks') q.set('checks', '1');
  else q.set('view', key);
  a.href = `?${q}`;
  a.textContent = label;
  if (key === 'checks' ? params.has('checks') : key === view && !params.has('checks')) a.setAttribute('aria-current', 'page');
  nav.append(a);
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
    def('test-round', (kit, { w, d, h }) => {
      const g = kit.group();
      const top = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, 0.04, 32), kit.mat.walnut);
      top.position.y = h - 0.02;
      top.scale.z = d / w;
      g.add(top);
      kit.block(g, kit.mat.black, -0.04, 0.04, 0, h - 0.04, -0.04, 0.04);
      return g;
    }, { contactShadow: 'round', w: 1.1, d: 1.1, h: 0.74 }),
    def('test-no-shadow', (kit, { w, d, h }) => {
      const g = kit.group();
      kit.block(g, kit.mat.steel, -w / 2, w / 2, h - 0.03, h, -d / 2, d / 2);
      for (const x of [-1, 1]) kit.block(g, kit.mat.steel, x * (w / 2 - 0.03) - 0.02, x * (w / 2 - 0.03) + 0.02, 0, h - 0.03, -0.02, 0.02);
      return g;
    }, { contactShadow: false }),
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
  // Contact shadow modes: round (elliptical) and none.
  addItem(plan, 'test-round', 1.4, 4.9);
  addItem(plan, 'test-round', 6.6, 4.9, { w: 1.4, d: 0.9, rotation: 30 });
  addItem(plan, 'test-no-shadow', 7.2, 3.4, { rotation: 90 });
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

/**
 * Mixed heights: a 3 m wing with an L-shaped corridor and a room whose ceiling rises above its walls,
 * and a 7 m open hall behind a full height wall, with a low office box inside, columns and a
 * sliding door. Exercises per-room decks, bulkheads, fixture fill and door colliders.
 */
function stepsPlan() {
  const plan = createPlan({ name: 'Steps', settings: { wallHeight: 3, ceiling: 'tile', exterior } });
  const P = (x, y) => ({ x, y });
  const wall = (a, b, kind, props = {}) => addWall(plan, a, b, { kind, ...props });
  const hall = { height: 7 };
  const north = [wall(P(0, 0), P(10, 0), 'exterior'), wall(P(10, 0), P(26, 0), 'exterior', hall)];
  wall(P(26, 0), P(26, 12), 'exterior', hall);
  const south = [wall(P(26, 12), P(17, 12), 'exterior', hall), wall(P(17, 12), P(12, 12), 'exterior', hall), wall(P(12, 12), P(10, 12), 'exterior', hall), wall(P(10, 12), P(0, 12), 'exterior')];
  const west = wall(P(0, 12), P(0, 0), 'exterior');
  const demising = [wall(P(10, 0), P(10, 2), 'interior', hall), wall(P(10, 2), P(10, 12), 'interior', hall)];
  addOpening(plan, demising[1].id, 'double-door', 3, { side: 1 });
  addOpening(plan, north[1].id, 'sliding-door', 8, { width: 1.8 });
  for (const x of [3, 13]) addOpening(plan, north[1].id, 'window', x, { width: 3, sill: 4, height: 1.5 });
  addOpening(plan, south[3].id, 'door', 5, { side: -1 });
  addOpening(plan, west.id, 'window', 7, { width: 3 });
  // The corridor runs along the north and west walls of the wing.
  const corridor = [wall(P(2, 2), P(10, 2), 'interior'), wall(P(2, 12), P(2, 2), 'interior')];
  addOpening(plan, corridor[0].id, 'door', 4, { side: 1 });
  addOpening(plan, corridor[1].id, 'door', 3, { side: 1 });
  // Office box in the hall's south side.
  const office = [wall(P(12, 8), P(17, 8), 'interior'), wall(P(12, 12), P(12, 8), 'interior'), wall(P(17, 8), P(17, 12), 'interior')];
  addOpening(plan, office[0].id, 'door', 3.8, { side: -1 });
  addOpening(plan, office[0].id, 'window', 1.8, { width: 1.8, sill: 0.9, height: 1.2 });

  addRoom(plan, [P(0, 0), P(10, 0), P(10, 2), P(2, 2), P(2, 12), P(0, 12)], { name: 'Corridor', floor: 'vinyl', ceiling: 'tile' });
  addRoom(plan, [P(2, 2), P(10, 2), P(10, 12), P(2, 12)], { name: 'Studio', floor: 'wood', ceiling: 'drywall', height: 3.3 });
  addRoom(plan, [P(10, 0), P(26, 0), P(26, 12), P(17, 12), P(17, 8), P(12, 8), P(12, 12), P(10, 12)], { name: 'Hall', floor: 'concrete', ceiling: 'open', height: 7 });
  addRoom(plan, [P(12, 8), P(17, 8), P(17, 12), P(12, 12)], { name: 'Office', floor: 'carpet', ceiling: 'drywall', height: 2.7 });
  for (const [x, y] of [[18, 4], [22, 4], [18, 8], [22, 8]]) addItem(plan, pick(['column'], 'general', 0), x, y, { h: 7 });
  addItem(plan, pick(['round-table-4'], 'office', 0), 6, 6);
  addItem(plan, pick(['conference-table-6'], 'office', 1), 6, 9.6);
  addItem(plan, pick(['pallet-racking'], 'retail', 0), 21, 2, { rotation: 180 });
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
// As in src/walkthrough.js: AgX at 1.8, applied once by the post-processing chain.
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = Number(params.get('exposure') || 1.8);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const env = setupEnvironment(renderer, scene);
const kit = createKit();
const camera = new THREE.PerspectiveCamera(60, canvas.clientWidth / canvas.clientHeight, 0.05, 2000);
const fxLevel = ['high', 'balanced', 'fast'].includes(params.get('fx')) ? params.get('fx') : 'high';
const fx = createPostFX(renderer, scene, camera, { quality: fxLevel });
fx.setSize(canvas.clientWidth, canvas.clientHeight, renderer.getPixelRatio());

const PLANS = { shapes: shapesPlan, items: itemsPlan, steps: stepsPlan, suite: suitePlan };
const plan = view === 'stress' ? stressPlan() : sample || (PLANS[planName] || suitePlan)();
const t0 = performance.now();
const built = buildPlanScene(plan, { kit, quality });
const buildMs = performance.now() - t0;
scene.add(built.root);
env.fit(built.bounds);
const t1 = performance.now();
const capture = params.get('capture') === '0' ? null : captureEnvironment(renderer, scene, built);
const captureMs = performance.now() - t1;
if (capture) scene.environment = capture.texture;
Object.assign(window, { built, testPlan: plan, testQuality: quality });

const b = built.bounds;
const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2;
const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);

function eye({ x, y, yaw, pitch = 0, height = DEFAULTS.eyeHeight }) {
  const yr = THREE.MathUtils.degToRad(yaw), pr = THREE.MathUtils.degToRad(pitch);
  camera.position.set(x, height, y);
  camera.lookAt(x + Math.sin(yr) * Math.cos(pr), height + Math.sin(pr), y - Math.cos(yr) * Math.cos(pr));
}

if (view === 'overview' || view === 'stress') {
  for (const c of built.ceilings) c.visible = false;
  camera.fov = 45;
  camera.position.set(cx + span * 0.22, span * 1.05, cz + span * 0.82);
  camera.lookAt(cx, 0, cz + span * 0.04);
} else if (view === 'outside') {
  camera.position.set(cx - span * 0.35, 1.7, b.maxY + span * 0.55);
  camera.lookAt(cx, 2.2, b.maxY);
} else if (params.has('eye')) {
  // &eye=x,y,yaw,pitch[,height]: any view, in plan meters and degrees (height defaults to eye height).
  const [x, y, yaw, pitch = 0, height] = params.get('eye').split(',').map(Number);
  eye({ x, y, yaw, pitch, height });
} else {
  eye(VIEWS[view] || VIEWS[1]);
}
camera.updateProjectionMatrix();

// Draw calls and triangles of the scene alone (one pass into a small target), then the full frame.
const probeTarget = new THREE.WebGLRenderTarget(64, 40, { type: THREE.HalfFloatType });
renderer.setRenderTarget(probeTarget);
renderer.render(scene, camera);
const info = { ...renderer.info.render };
renderer.setRenderTarget(null);
probeTarget.dispose();
await fx.ready;
const f0 = performance.now();
fx.render(camera);
renderer.getContext().finish();
const frameMs = performance.now() - f0;
const stats = {
  catalog, quality, fx: fxLevel, buildMs: Math.round(buildMs), captureMs: Math.round(captureMs), frameMs: Math.round(frameMs),
  calls: info.calls, triangles: info.triangles, lights: built.lights?.length ?? 0,
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
  fx.render(camera);
}
window.testStats = stats;
window.rerender = () => fx.render(camera);
window.testEnv = { THREE, renderer, scene, camera, kit, env, fx, capture, buildPlanScene, captureEnvironment };
document.getElementById('stats').textContent = `${stats.buildMs} ms build · ${stats.captureMs} ms capture · ${stats.calls} draw calls · ${(stats.triangles / 1000).toFixed(0)}k triangles · ${stats.lights} area lights · ${catalog}`;
console.log('builder-test', JSON.stringify(stats));
if (params.has('checks')) showChecks(await runChecks());
if (params.get('light') === 'map') showLightMap(built);
window.testReady = true;

/**
 * &light=map: the plan light map over the view, as seen from above: brightness is the diffuse light
 * level (direct plus bounce, white at 10), outdoors is dark green.
 */
function showLightMap(b) {
  const L = b.planLight;
  if (!L) return;
  const [nx, ny] = L.size;
  const map = document.createElement('canvas');
  map.width = nx;
  map.height = ny;
  Object.assign(map.style, { position: 'fixed', left: '16px', top: '60px', width: `${Math.min(900, nx * 4)}px`, imageRendering: 'pixelated', boxShadow: '0 2px 12px rgba(1, 42, 45, 0.18)' });
  const g = map.getContext('2d'), img = g.createImageData(nx, ny);
  // The map covers the building plus a margin; sample cell centers from its own origin.
  const { x: ox, y: oy } = L.origin;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = ox + (i + 0.5) * L.cell, y = oy + (j + 0.5) * L.cell, k = (j * nx + i) * 4;
      const inside = L.spaceAt(x, y) >= 0;
      const v = Math.round(255 * Math.min(1, Math.sqrt(L.levelAt(x, y) / 10)));
      img.data.set(inside ? [v, v, v, 255] : [1, 42, 45, 255], k);
    }
  }
  g.putImageData(img, 0, 0);
  document.body.append(map);
}

/** Regression checks for the builder, on small plans built in code and one sample. Returns [{ name, pass, detail }]. */
async function runChecks() {
  if (!hasItem('test-round')) registerTestItems();
  const results = [];
  const check = (name, fn) => {
    try {
      const [pass, detail] = fn();
      results.push({ name, pass, detail });
    } catch (err) {
      results.push({ name, pass: false, detail: err.message });
    }
  };
  const P = (x, y) => ({ x, y });
  const shell = (plan, pts, kind = 'exterior') => pts.map((p, i) => addWall(plan, p, pts[(i + 1) % pts.length], { kind }));
  const build = (p) => buildPlanScene(normalizePlan(p), { kit });
  const hits = (root, o, d) => new THREE.Raycaster(new THREE.Vector3(...o), new THREE.Vector3(...d).normalize())
    .intersectObject(root, true).filter((h) => h.object.parent.name !== 'exterior');
  const segDist = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
  };
  // Can a 0.25 m walker cross the wall along y = 0 straight at x? Colliders on the wall line only.
  const crosses = (colliders, x) => {
    const wall = colliders.filter((c) => Math.abs(c.a.y + c.b.y) < 2e-3);
    for (let y = -0.6; y <= 0.6; y += 0.01) if (wall.some((c) => segDist(P(x, y), c.a, c.b) < c.r + 0.25)) return false;
    return true;
  };
  const freeSpan = (colliders, x0, x1) => {
    let n = 0;
    for (let x = x0; x <= x1; x += 0.002) if (crosses(colliders, x)) n++;
    return n * 0.002;
  };
  const single = (kind, type, props, thickness) => {
    const plan = createPlan();
    const w = addWall(plan, P(0, 0), P(6, 0), { kind, ...(thickness ? { thickness } : {}) });
    addOpening(plan, w.id, type, 3, props);
    return build(plan);
  };

  check('Doorways are as wide as their opening in any wall thickness', () => {
    const out = [0.127, 0.3048, 0.6096].map((t) => {
      const b = single('interior', 'opening', { width: 0.9144 }, t);
      const span = freeSpan(b.colliders, 2, 4);
      b.dispose();
      return span;
    });
    return [out.every((v) => Math.abs(v - (0.9144 - 0.5)) < 0.01), `free span ${out.map((v) => v.toFixed(3)).join(', ')} m, expected 0.414 m`];
  });

  check('Sliding door glass is solid and the open part is passable', () => {
    const b = single('interior', 'sliding-door', { width: 1.8288, hinge: 'start' });
    const glass = crosses(b.colliders, 2.5), gap = crosses(b.colliders, 3.55);
    b.dispose();
    return [!glass && gap, `through the glass ${glass ? 'passes' : 'blocked'}, through the gap ${gap ? 'passes' : 'blocked'}`];
  });

  check('Overlapping openings both cut the wall', () => {
    const plan = createPlan();
    const [north] = shell(plan, [P(0, 0), P(10, 0), P(10, 6), P(0, 6)]);
    addOpening(plan, north.id, 'door', 3, { width: 3.66 });
    addOpening(plan, north.id, 'window', 5.5);
    const b = build(plan);
    const h = hits(b.root, [5.6, 1.6, 3], [0, 0, -1]).find((x) => x.object.parent.name !== 'shading');
    b.dispose();
    return [h?.object.material.userData.kitFamily === 'glass', `first hit behind the door: ${h ? h.object.material.name || h.object.material.type : 'nothing'}`];
  });

  check('L-shaped rooms get ceiling lights', () => {
    // The medical office corridor: a 6 ft wide L, 480 sq ft.
    const plan = createPlan();
    const pts = [[24, 13], [92, 13], [92, 31], [86, 31], [86, 19], [24, 19]].map(([x, y]) => P(x * 0.3048, y * 0.3048));
    shell(plan, pts);
    addRoom(plan, pts, { ceiling: 'tile' });
    const b = build(plan);
    const centers = [];
    b.ceilings[0].traverse((o) => {
      if (!o.isMesh || !(o.material.emissiveIntensity > 2)) return;
      const a = o.geometry.attributes.position;
      for (let i = 0; i < a.count; i++) if (!centers.some((c) => Math.hypot(c.x - a.getX(i), c.y - a.getZ(i)) < 0.8)) centers.push(P(a.getX(i), a.getZ(i)));
    });
    b.dispose();
    return [centers.length >= 6, `${centers.length} troffers in a 45 m² corridor`];
  });

  const ell = () => {
    const plan = createPlan();
    const pts = [P(0, 0), P(16, 0), P(16, 6), P(8, 6), P(8, 12), P(0, 12)];
    shell(plan, pts);
    return plan;
  };
  // What a walker stands on at plan (x, y): the first floor surface below, else the outdoor ground.
  const floorAt = (b, x, y) => hits(b.root, [x, 5, y], [0, -1, 0])
    .find((h) => !['ceilings', 'shading'].includes(h.object.parent.name))?.object.name || 'ground';
  check('The slab stops at the building outline', () => {
    const b = build(ell());
    const notch = floorAt(b, 12, 9), inside = floorAt(b, 4, 4);
    b.dispose();
    return [notch === 'ground' && inside === 'slab', `outside the L: ${notch}, inside: ${inside}`];
  });

  check('Small gaps in the exterior walls keep the slab continuous', () => {
    // An untraced 1.2 m doorway in the west wall and a 1.2 m gap at the north west corner.
    const plan = createPlan();
    const pts = [[0, 0, 12, 0], [12, 0, 12, 9], [12, 9, 0, 9], [0, 9, 0, 5.2], [0, 4, 0, 1.2]];
    for (const [ax, ay, bx, by] of pts) addWall(plan, P(ax, ay), P(bx, by), { kind: 'exterior' });
    addWall(plan, P(6, 0), P(6, 9), { kind: 'interior' });
    addRoom(plan, [P(6, 0), P(12, 0), P(12, 9), P(6, 9)], { floor: 'carpet' });
    const b = build(plan);
    const doorway = [1, 3, 5].map((x) => floorAt(b, x, 4.6)), corner = [1, 3, 5].map((x) => floorAt(b, x, 0.6));
    const outside = [floorAt(b, -0.5, 4.6), floorAt(b, -0.5, 0.6)];
    b.dispose();
    const pass = [...doorway, ...corner].every((n) => n === 'slab') && outside.every((n) => n === 'ground');
    return [pass, `across the doorway: ${doorway.join(', ')}; along the corner gap: ${corner.join(', ')}; outside: ${outside.join(', ')}`];
  });

  const steps = stepsPlan();
  const bs = buildPlanScene(steps, { kit });
  const topAt = (x, y) => hits(bs.root, [x, 40, y], [0, -1, 0])[0]?.point.y ?? 0;
  check('A lower wing keeps its own roof line', () => {
    // The wing's roof clears its highest ceiling (3.3 m) by the deck rise; the hall's clears 7 m.
    const wing = topAt(5, 0), hall = topAt(20, 0);
    return [Math.abs(wing - 4.2) < 0.02 && Math.abs(hall - 7.9) < 0.02, `wing wall top ${wing.toFixed(2)} m (expected 4.20), hall wall top ${hall.toFixed(2)} m (expected 7.90)`];
  });
  check('A low office inside a tall hall stays a box', () => {
    const h = hits(bs.root, [20, 5, 10], [-1, 0, 0])[0];
    return [h && h.point.x < 12.2, `a ray over the office first hits x = ${h ? h.point.x.toFixed(2) : '-'} m (the office is x 12 to 17)`];
  });
  check('Raised ceilings meet painted walls', () => {
    const h = hits(bs.root, [6, 3.15, 9], [0, 0, 1])[0];
    // Indoor surfaces carry the light map's twin of the kit material; planSource names the original.
    const m = h?.object.material;
    return [(m?.planSource || m) === kit.paintMaterial('#efece6'), `wall face between the 3.0 m wall top and the 3.3 m ceiling: ${m ? m.name || m.type : 'nothing'}`];
  });
  bs.dispose();

  check('Round and absent contact shadows', () => {
    const plan = createPlan();
    addItem(plan, 'test-round', 2, 2);
    addItem(plan, 'test-no-shadow', 5, 2);
    const b = build(plan);
    let near = { round: 0, none: 0 };
    b.root.traverse((o) => {
      if (!o.isMesh || o.material.name !== 'shade-contact') return;
      const a = o.geometry.attributes.position;
      for (let i = 0; i < a.count; i++) {
        if (Math.hypot(a.getX(i) - 2, a.getZ(i) - 2) < 1.2) near.round = Math.max(near.round, Math.hypot(a.getX(i) - 2, a.getZ(i) - 2));
        if (Math.hypot(a.getX(i) - 5, a.getZ(i) - 2) < 1.2) near.none++;
      }
    });
    b.dispose();
    return [near.round > 0.4 && near.round < 0.85 && near.none === 0, `round shadow reaches ${near.round.toFixed(2)} m (1.1 m table), shadow vertices under the open item ${near.none}`];
  });

  check('Absurd plans fail fast with a reason, or build quickly', () => {
    const far = createPlan();
    shell(far, [P(0, 0), P(1e5, 0), P(1e5, 8e4), P(0, 8e4)]);
    let reason = '';
    try { buildPlanScene(far, { kit }).dispose(); } catch (err) { reason = err.message; }
    const stray = createPlan();
    shell(stray, [P(0, 0), P(10, 0), P(10, 8), P(0, 8)]);
    addItem(stray, pick(['desk'], 'office', 0), 9000, 9000);
    const t = performance.now();
    buildPlanScene(normalizePlan(stray), { kit }).dispose();
    const ms = performance.now() - t;
    return [/km/.test(reason) && ms < 3000, `100 km plan: "${reason}"; desk 9 km away: ${Math.round(ms)} ms`];
  });

  // Lighting: the suite is a 20 x 14 m shell with windows on every side.
  const suite = buildPlanScene(suitePlan(), { kit });
  check('Window daylight shines into the rooms, within its budget', () => {
    // Window lights face into the suite; fixture lights face down from the ceiling.
    const windows = suite.lights.filter((l) => l.name === 'window-light'), fixtures = suite.lights.filter((l) => l.name === 'fixture-light');
    const facing = (l) => new THREE.Vector3(0, 0, -1).applyQuaternion(l.quaternion);
    const inside = windows.filter((l) => {
      const p = facing(l).add(l.position);
      return p.x > 0 && p.x < 20 && p.z > 0 && p.z < 14;
    }).length;
    const down = fixtures.filter((l) => facing(l).y < -0.99).length;
    const overlay = suite.root.getObjectByName('daylight').userData.overlay === true;
    return [windows.length > 0 && suite.lights.length <= 10 && inside === windows.length && down === fixtures.length && overlay,
      `${inside} of ${windows.length} window lights face in, ${down} of ${fixtures.length} fixture lights face down; flagged as a real-time overlay: ${overlay}`];
  });
  check('Window daylight follows the viewer', () => {
    // The east facade's 3 m window sits at y = 3; after a render from beside it, a light covers it.
    const s2 = new THREE.Scene();
    const e2 = setupEnvironment(renderer, s2);
    s2.add(suite.root);
    const cam = new THREE.PerspectiveCamera(60, 1.6, 0.05, 2000);
    cam.position.set(18.5, 1.6, 3);
    cam.updateMatrixWorld();
    s2.onBeforeRender(renderer, s2, cam, null);
    const lit = suite.lights.some((l) => Math.abs(l.position.x - 20) < 0.3 && Math.abs(l.position.z - 3) < 0.2 && Math.abs(l.width - 2.9) < 0.15);
    s2.remove(suite.root);
    e2.dispose();
    return [lit, lit ? 'the window beside the viewer has a light' : 'no light on the window beside the viewer'];
  });
  check('Environment capture leaves the scene as it was', () => {
    const before = scene.environment;
    const levels = [];
    scene.traverse((o) => { if (o.isLight) levels.push([o, o.intensity]); });
    const cap = captureEnvironment(renderer, scene, built);
    const restored = levels.every(([o, v]) => o.intensity === v);
    const ok = cap.texture?.mapping === THREE.CubeUVReflectionMapping && scene.environment === before && restored;
    cap.dispose();
    return [ok, `PMREM texture: ${cap.texture?.mapping === THREE.CubeUVReflectionMapping}, environment untouched: ${scene.environment === before}, light levels restored: ${restored}`];
  });
  check('Rounded trims face outward', () => {
    let bad = 0, total = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), f = new THREE.Vector3();
    suite.root.traverse((o) => {
      if (!o.isMesh || (o.material.planSource || o.material) !== kit.material('#b9bdbf', { roughness: 0.34, metalness: 0.65 })) return;
      const p = o.geometry.attributes.position, nr = o.geometry.attributes.normal, idx = o.geometry.index.array;
      for (let i = 0; i < idx.length; i += 3) {
        a.fromBufferAttribute(p, idx[i]);
        b.fromBufferAttribute(p, idx[i + 1]);
        c.fromBufferAttribute(p, idx[i + 2]);
        f.subVectors(b, a).cross(c.clone().sub(a));
        if (f.lengthSq() < 1e-14) continue;
        n.fromBufferAttribute(nr, idx[i]).add(b.fromBufferAttribute(nr, idx[i + 1])).add(c.fromBufferAttribute(nr, idx[i + 2]));
        total++;
        if (f.dot(n) <= 0) bad++;
      }
    });
    return [total > 0 && bad === 0, `${bad} of ${total} aluminum frame triangles wound inward`];
  });
  check('The sky keeps the gradient photos read', () => {
    const sky = suite.root.getObjectByName('sky');
    const pos = sky?.geometry.attributes.position, col = sky?.geometry.attributes.color;
    if (!col) return [false, 'no sky dome with vertex colors'];
    let top = 0, low = 0;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > pos.getY(top)) top = i;
      if (pos.getY(i) >= 0 && pos.getY(i) < pos.getY(low)) low = i;
    }
    const bluer = col.getZ(top) - col.getX(top) > col.getZ(low) - col.getX(low);
    return [bluer && col.getX(low) < 1, `zenith bluer than the horizon: ${bluer}; horizon kept in display range: ${col.getX(low) < 1}`];
  });
  check('Indoor surfaces are lit by the light map, outdoor ones are not', () => {
    let indoor = 0, lit = 0, outdoorLit = 0;
    suite.root.traverse((o) => {
      if (!o.isMesh || !o.material.isMeshStandardMaterial) return;
      const group = ['structure', 'furnishings', 'ceilings'].find((n) => o.parent.name === n);
      if (group && !o.material.userData.outdoor) {
        indoor++;
        if (o.material.planSource) lit++;
      } else if (o.parent.name === 'exterior' && o.material.planSource) {
        outdoorLit++;
      }
    });
    return [indoor > 0 && lit === indoor && outdoorLit === 0, `${lit} of ${indoor} indoor meshes use the light map, ${outdoorLit} outdoor meshes do`];
  });
  check('Area lights reflect only in their own room', () => {
    const g = suite.root.getObjectByName('daylight');
    // Binding the build points the kit's shared uniforms at its own light map and light spaces.
    suite.root.userData.planLight.bind();
    const spaces = g.userData.rectSpace, U = suite.root.userData.planUniforms;
    const bound = U.planRectSpace.value === spaces;
    const ok = bound && g.children.every((l, i) => {
      const run = g.userData.pools.find((pool) => pool.lights.includes(l)).runs[l.userData.run];
      return run && spaces[i] === run.space && run.space >= 0;
    });
    const fixtures = g.children.filter((l) => l.name === 'fixture-light').length;
    return [ok && fixtures > 0 && suite.lights.length <= 12, `${g.children.length - fixtures} window and ${fixtures} fixture lights, each gated to its run's space: ${ok}`];
  });
  suite.dispose();

  check('Walls block the light map, doorways let some through', () => {
    // Two 6 x 5 m rooms side by side, with or without a window in the west room and a doorway between.
    const make = (window, door) => {
      const plan = createPlan({ settings: { wallHeight: 2.9, ceiling: 'drywall', exterior: 'none' } });
      const [w0] = shell(plan, [P(0, 0), P(12, 0), P(12, 5), P(0, 5)]);
      if (window) addOpening(plan, w0.id, 'window', 3, { width: 3 });
      const mid = addWall(plan, P(6, 0), P(6, 5), { kind: 'interior' });
      if (door) addOpening(plan, mid.id, 'opening', 1.5, { width: 1.2 });
      addRoom(plan, [P(0, 0), P(6, 0), P(6, 5), P(0, 5)], { ceiling: 'drywall' });
      addRoom(plan, [P(6, 0), P(12, 0), P(12, 5), P(6, 5)], { ceiling: 'drywall' });
      const b = build(plan);
      const L = b.planLight;
      const out = { west: L.levelAt(3, 1.2), east: L.levelAt(9, 2.5), door: L.levelAt(6.6, 1.5), spaces: [L.spaceAt(3, 2.5), L.spaceAt(9, 2.5)] };
      b.dispose();
      return out;
    };
    const dark = make(false, false), solid = make(true, false), dim = make(false, true), open = make(true, true);
    const blocked = Math.abs(solid.east - dark.east) < 0.01 && Math.abs(solid.door - dark.door) < 0.01;
    const pass = solid.west > dark.west * 1.3 && blocked && open.door > dim.door + 0.05 && solid.spaces[0] !== solid.spaces[1];
    const f = (v) => v.toFixed(2);
    return [pass, `west room ${f(dark.west)} without its window, ${f(solid.west)} with it; east room behind the solid wall ${f(dark.east)} and ${f(solid.east)}; past a doorway ${f(dim.door)} and ${f(open.door)}`];
  });

  check('Windowless rooms are lit evenly by their fixtures', () => {
    const plan = createPlan({ settings: { wallHeight: 2.9, ceiling: 'tile', exterior: 'none' } });
    shell(plan, [P(0, 0), P(6, 0), P(6, 4), P(0, 4)]);
    addRoom(plan, [P(0, 0), P(6, 0), P(6, 4), P(0, 4)], { ceiling: 'tile' });
    const b = build(plan);
    const L = b.planLight, levels = [];
    for (let x = 0.8; x < 5.4; x += 0.4) for (let y = 0.8; y < 3.4; y += 0.4) levels.push(L.levelAt(x, y));
    b.dispose();
    const lo = Math.min(...levels), hi = Math.max(...levels);
    return [lo > 1 && hi / lo < 1.8, `light level ${lo.toFixed(2)} to ${hi.toFixed(2)} across the room's middle (${b.planLight.ms.toFixed(0)} ms light map)`];
  });

  const medical = await (await import('../src/samples/index.js')).SAMPLES.find((x) => x.id === 'medical-office').build();
  check('Collinear wall shading does not double up', () => {
    const b = buildPlanScene(medical, { kit });
    let overlaps = 0;
    b.root.traverse((o) => {
      if (!o.isMesh || !/^shade-(floor|wall|ceiling)$/.test(o.material.name)) return;
      const a = o.geometry.attributes.position, lines = new Map();
      for (let i = 0; i + 3 < a.count; i += 4) {
        const dx = a.getX(i + 1) - a.getX(i), dz = a.getZ(i + 1) - a.getZ(i), L = Math.hypot(dx, dz);
        if (L < 1e-4) continue;
        const ux = dx / L, uz = dz / L;
        const off = [0, 1, 2, 3].map((k) => (-uz * a.getX(i + k) + ux * a.getZ(i + k)) * Math.sign(ux + uz * 1e-3));
        const along = [0, 1].map((k) => ux * a.getX(i + k) + uz * a.getZ(i + k));
        const key = `${Math.abs(ux).toFixed(3)}|${Math.min(...off).toFixed(3)}|${Math.max(...off).toFixed(3)}|${a.getY(i).toFixed(3)}|${a.getY(i + 2).toFixed(3)}`;
        const span = [Math.min(...along), Math.max(...along)];
        for (const q of lines.get(key) || []) if (Math.min(q[1], span[1]) - Math.max(q[0], span[0]) > 0.01) overlaps++;
        lines.set(key, [...(lines.get(key) || []), span]);
      }
    });
    b.dispose();
    return [overlaps === 0, `${overlaps} overlapping shading strips`];
  });

  check('Rebuilding releases what each build made', () => {
    // As the walkthrough does: textures items draw through the kit belong to the build, the rest
    // of the kit's caches (and the builder's per-kit shared materials) outlive it.
    let made = new Set();
    const tracked = { ...kit, canvasTexture: (...args) => { const t = kit.canvasTexture(...args); made.add(t); return t; } };
    const target = new THREE.WebGLRenderTarget(48, 30, { type: THREE.HalfFloatType });
    const cam = new THREE.PerspectiveCamera(70, 1.6, 0.05, 2000);
    const prev = renderer.getRenderTarget();
    const memory = [], perBuild = [], stuck = [];
    let previous = new Set();
    for (let i = 0; i < 4; i++) {
      const b = buildPlanScene(medical, { kit: tracked });
      scene.add(b.root);
      // Render from a saved view and from above, so every part has been uploaded once.
      renderer.setRenderTarget(target);
      for (const at of [{ x: medical.cameras[0].x, y: 1.6, z: medical.cameras[0].y }, { x: (b.bounds.minX + b.bounds.maxX) / 2, y: 40, z: (b.bounds.minY + b.bounds.maxY) / 2 }]) {
        cam.position.set(at.x, at.y, at.z);
        cam.lookAt(at.x + 1, at.y > 10 ? 0 : at.y, at.z + (at.y > 10 ? 0.01 : 1));
        renderer.render(scene, cam);
      }
      renderer.setRenderTarget(prev);
      const mats = new Set();
      b.root.traverse((o) => { for (const m of [o.material].flat()) if (m) mats.add(m); });
      const own = [...mats].filter((m) => !previous.has(m));
      const released = new Set();
      for (const m of own) m.addEventListener('dispose', () => released.add(m));
      b.dispose();
      for (const t of made) t.dispose();
      made = new Set();
      // From the second build on, materials the first did not use belong to this build alone.
      if (i > 0) {
        perBuild.push(own.length);
        stuck.push(...own.filter((m) => !released.has(m)));
      }
      previous = mats;
      memory.push({ ...renderer.info.memory });
    }
    target.dispose();
    const level = memory.slice(1).every((m) => m.geometries === memory[1].geometries && m.textures === memory[1].textures);
    const names = [...new Set(stuck.map((m) => m.name || m.type))].slice(0, 4).join(', ');
    return [level && stuck.length === 0, `GPU geometries ${memory.map((m) => m.geometries).join(', ')}, textures ${memory.map((m) => m.textures).join(', ')} after builds 1 to 4; ${perBuild.join(', ')} per-build materials, ${stuck.length} not released${names ? ` (${names})` : ''}`];
  });
  return results;
}

function showChecks(results) {
  window.testChecks = results;
  const panel = document.getElementById('checks');
  panel.hidden = false;
  const passed = results.filter((r) => r.pass).length;
  panel.innerHTML = `<h2>${passed} of ${results.length} checks pass</h2>`;
  const list = document.createElement('ul');
  for (const r of results) {
    const li = document.createElement('li');
    li.className = r.pass ? 'pass' : 'fail';
    li.innerHTML = '<strong></strong><span></span>';
    li.firstChild.textContent = `${r.pass ? 'Pass' : 'Fail'}: ${r.name}`;
    li.lastChild.textContent = r.detail;
    list.append(li);
  }
  panel.append(list);
  console.log('builder-checks', JSON.stringify(results));
}
