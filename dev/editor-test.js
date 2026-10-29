// Developer test bed for the 2D plan editor. Mounts a full-window PlanEditor on a plan built in
// code (every wall kind, every opening type, T-junctions, rooms, items, a labeled item, a view).
// Query options:
//   ?empty=1      start from an empty plan      ?units=metric   metric display units
//   ?bare=1       hide the toolbar and status   ?walker=1       show a walkthrough marker
import { PlanStore, createPlan, addWall, addOpening, addRoom, addItem, addCamera } from '../src/model.js';
import { FOOT, formatLength, parseLength } from '../src/geometry.js';
import { PlanEditor, findEnclosure } from '../src/editor2d.js';
import * as render from '../src/plan-render.js';

const params = new URLSearchParams(location.search);
if (params.has('bare')) document.body.classList.add('bare');

const catalog = await loadCatalog();
const store = new PlanStore(params.has('empty') ? createPlan({ name: 'Empty plan' }) : samplePlan(catalog));
if (params.get('units') === 'metric') store.update((d) => { d.units = 'metric'; }, { label: 'Units' });
store.endCoalesce();

const canvas = document.getElementById('plan');
const editor = new PlanEditor(canvas, store);
if (params.has('walker')) editor.setWalker({ x: 8 * FOOT, y: 21 * FOOT, yaw: 90 });
wireToolbar(editor, store, catalog);

Object.assign(window, { editor, store, catalog, render, findEnclosure, testReady: true });

async function loadCatalog() {
  let registry;
  try {
    registry = await import('../src/catalog/index.js');
  } catch {
    registry = await import('../src/catalog/registry.js');
    await Promise.allSettled(['lab', 'medical', 'office', 'retail', 'art'].map((c) => import(`../src/catalog/${c}.js`)));
  }
  if (!registry.allItems().length) registry.registerItems(fallbackItems());
  const all = registry.allItems();
  const pick = (...words) => all.find((d) => words.some((w) => d.type.includes(w)))?.type || all[0].type;
  return {
    registry,
    items: all.map((d) => ({ type: d.type, name: d.name })),
    desk: pick('desk', 'workstation'),
    chair: pick('task-chair', 'chair'),
    table: pick('conference-table', 'table'),
    sofa: pick('sofa', 'lounge', 'couch'),
    bench: pick('lab-bench', 'bench', 'casework'),
  };
}

/** Simple local items, used only when no catalog category modules exist yet. */
function fallbackItems() {
  const box = (type, name, w, d, h, detail) => ({
    type, name, category: 'general', w, d, h,
    build: (kit) => kit.group(),
    draw2d(ctx, o) {
      ctx.strokeStyle = o.theme.line;
      ctx.lineWidth = 1.25 * o.px;
      ctx.strokeRect(-o.w / 2, -o.d / 2, o.w, o.d);
      detail?.(ctx, o);
    },
  });
  return [
    box('test-desk', 'Desk', 1.524, 0.762, 0.74, (ctx, o) => {
      ctx.beginPath();
      ctx.arc(0, o.d / 2 - 0.05, 0.22, Math.PI, 0);
      ctx.stroke();
    }),
    box('test-chair', 'Task chair', 0.66, 0.66, 1, (ctx, o) => {
      ctx.strokeRect(-o.w / 2 + 0.06, -o.d / 2, o.w - 0.12, 0.12);
    }),
    box('test-table', 'Conference table', 3.6, 1.2, 0.74),
    box('test-sofa', 'Sofa', 2.1, 0.9, 0.85, (ctx, o) => {
      ctx.strokeRect(-o.w / 2, -o.d / 2, o.w, 0.2);
    }),
    box('test-bench', 'Lab bench', 3.6, 0.76, 0.9),
  ];
}

function samplePlan(cat) {
  const plan = createPlan({ name: 'Editor test suite' });
  const P = (x, y) => ({ x: x * FOOT, y: y * FOOT });
  const ids = {};
  const wall = (key, a, b, kind) => { ids[key] = addWall(plan, P(...a), P(...b), { kind }).id; };
  wall('top', [0, 0], [60, 0], 'exterior');
  wall('right', [60, 0], [60, 40], 'exterior');
  wall('bottom', [60, 40], [0, 40], 'exterior');
  wall('left', [0, 40], [0, 0], 'exterior');
  wall('glass', [0, 18], [20, 18], 'glass');
  wall('corridor', [20, 18], [60, 18], 'interior');
  wall('o1', [20, 0], [20, 18], 'interior');
  wall('o2', [32, 0], [32, 18], 'interior');
  wall('o3', [44, 0], [44, 18], 'interior');
  wall('break', [36, 24], [60, 24], 'interior');
  wall('breakSide', [36, 24], [36, 40], 'interior');
  wall('counter', [8, 32], [20, 32], 'partial');

  const opening = (key, type, offsetFt, props = {}) => addOpening(plan, ids[key], type, offsetFt * FOOT, props);
  opening('corridor', 'door', 9, { side: -1, hinge: 'end' });
  opening('corridor', 'door', 21, { side: -1, hinge: 'start' });
  opening('corridor', 'double-door', 32, { side: -1 });
  opening('glass', 'sliding-door', 14);
  opening('break', 'opening', 6);
  opening('left', 'door', 19, { side: 1, hinge: 'start' });
  for (const x of [10, 26, 38, 52]) opening('top', 'window', x);
  for (const x of [12, 30, 48]) opening('bottom', 'window', 60 - x);
  opening('right', 'window', 32);

  const room = (name, pts, floor) => addRoom(plan, pts.map((p) => P(...p)), { name, floor });
  room('Conference', [[0, 0], [20, 0], [20, 18], [0, 18]], 'carpet');
  room('Office', [[20, 0], [32, 0], [32, 18], [20, 18]], 'wood');
  room('Office', [[32, 0], [44, 0], [44, 18], [32, 18]], 'wood');
  room('Lab', [[44, 0], [60, 0], [60, 18], [44, 18]], 'epoxy');
  room('Open office', [[0, 18], [60, 18], [60, 24], [36, 24], [36, 40], [0, 40]], 'carpet');
  room('Break room', [[36, 24], [60, 24], [60, 40], [36, 40]], 'vinyl');

  const item = (type, x, y, rotation = 0, props = {}) => addItem(plan, type, x * FOOT, y * FOOT, { rotation, ...props });
  item(cat.table, 10, 9);
  item(cat.desk, 26, 2.5);
  item(cat.chair, 26, 5.5, 180);
  item(cat.desk, 38, 2.5);
  item(cat.bench, 52, 1.8, 0, { label: 'Bench 1' });
  for (const x of [6, 14, 22, 30]) item(cat.desk, x, 37.2, 180);
  item(cat.sofa, 48, 37.5, 180);
  addCamera(plan, 4 * FOOT, 21 * FOOT, 90, { name: 'Entry' });
  return plan;
}

function wireToolbar(ed, st, cat) {
  const buttons = [...document.querySelectorAll('[data-tool]')];
  const syncTools = () => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === ed.tool)));
  buttons.forEach((b) => b.addEventListener('click', () => { ed.setTool(b.dataset.tool); canvas.focus(); }));
  ed.addEventListener('toolchange', syncTools);
  syncTools();

  const kind = document.getElementById('kind');
  kind.addEventListener('change', () => { ed.setWallKind(kind.value); ed.setTool('wall'); canvas.focus(); });

  const itemSelect = document.getElementById('item');
  itemSelect.innerHTML = '<option value="">Place item</option>' + cat.items.map((i) => `<option value="${i.type}">${i.name}</option>`).join('');
  itemSelect.addEventListener('change', () => {
    if (itemSelect.value) ed.setPendingItem(itemSelect.value);
    canvas.focus();
  });

  let dims = false;
  const dimsBtn = document.getElementById('dims');
  dimsBtn.addEventListener('click', () => {
    dims = !dims;
    dimsBtn.setAttribute('aria-pressed', String(dims));
    ed.setOptions({ showDimensions: dims });
  });
  const unitsBtn = document.getElementById('units');
  const syncUnits = () => { unitsBtn.textContent = st.plan.units === 'metric' ? 'Imperial' : 'Metric'; };
  unitsBtn.addEventListener('click', () => {
    st.update((d) => { d.units = d.units === 'metric' ? 'imperial' : 'metric'; }, { label: 'Change units' });
    syncUnits();
  });
  syncUnits();
  document.getElementById('fit').addEventListener('click', () => ed.zoomToFit());

  const status = document.getElementById('status');
  const cursor = document.getElementById('cursor');
  ed.addEventListener('status', (e) => { status.textContent = e.detail.text; });
  ed.addEventListener('cursor', (e) => {
    const u = st.plan.units;
    cursor.textContent = `${formatLength(e.detail.x, u)}, ${formatLength(e.detail.y, u)}`;
  });
  ed.addEventListener('calibrate', (e) => {
    window.lastCalibration = e.detail;
    const answer = window.calibrationAnswer ?? prompt(`Measured ${formatLength(e.detail.meters, st.plan.units)}. Enter the true length:`);
    const meters = answer ? parseLength(answer, st.plan.units) : NaN;
    if (meters > 0) ed.applyCalibration(e.detail.a, e.detail.b, meters);
  });
}
