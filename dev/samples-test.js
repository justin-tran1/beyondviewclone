// Developer check for the sample plans: renders a sample (plan, clearance overlay or a 3D camera view)
// and validates it. Open /dev/samples-test.html?sample=lab-suite&view=plan|width|3d|overview&cam=1
// (3D views also take &x=&y= in feet and &yaw=&pitch= in degrees to try a camera pose; add
// &fallback to draw with the built-in renderer instead of src/plan-render.js).
// Results are also exposed as window.samplesReport once window.samplesReady is true.
import {
  FOOT, add, sub, dot, len, norm, dist, cross, wallLength, wallDir, wallNormal, pointOnWall, openingSpan,
  polygonArea, polygonCentroid, pointInPolygon, segmentIntersection, boundsOf, itemCorners, formatArea,
} from '../src/geometry.js';
import { FLOORS, OPENING_TYPES, DEFAULTS } from '../src/model.js';
import { getItem, hasItem } from '../src/catalog/registry.js';

const params = new URLSearchParams(location.search);
const view = params.get('view') || 'plan';
const SQFT = FOOT * FOOT;
const CELL = 0.1;
const WALKER = 0.25;
const AISLE = 3.5 * FOOT;

/** Canonical catalog: type -> [w, d, h, resizable, blocking]. */
const CANONICAL = {
  'lab-bench-island': [3.66, 1.52, 2.13, true], 'lab-bench-wall': [3.05, 0.76, 2.13, true],
  'fume-hood': [1.83, 0.91, 2.44], 'biosafety-cabinet': [1.52, 0.84, 2.24], 'ult-freezer': [0.89, 0.94, 1.98],
  'lab-refrigerator': [0.76, 0.81, 1.98], 'tall-storage-cabinet': [1.22, 0.61, 2.13], 'lab-sink': [1.22, 0.76, 1.1],
  'safety-shower': [0.91, 0.91, 2.29], 'lab-stool': [0.46, 0.46, 0.76], 'equipment-cart': [0.91, 0.61, 1.0],
  autoclave: [0.91, 0.91, 1.75],
  'exam-table': [1.83, 0.71, 1.0], 'exam-casework': [2.13, 0.61, 2.13, true], casework: [1.83, 0.61, 2.13, true],
  'physician-stool': [0.51, 0.51, 0.6],
  'side-chair': [0.56, 0.56, 0.84], 'reception-desk': [3.05, 0.91, 1.07, true], 'waiting-chairs': [2.44, 0.71, 0.84, true],
  'nurse-station': [2.44, 0.91, 1.07, true], 'hospital-bed': [1.02, 2.24, 1.0], 'patient-recliner': [0.86, 1.02, 1.07],
  'ct-scanner': [2.13, 4.27, 1.93], 'privacy-curtain': [2.44, 0.1, 3.05, false, false], 'supply-cart': [0.61, 0.51, 1.0],
  workstation: [1.52, 1.37, 1.2], desk: [1.52, 0.76, 0.74, true], 'task-chair': [0.66, 0.66, 1.05],
  'benching-4': [3.05, 2.9, 1.2], 'executive-desk': [1.83, 1.83, 0.74], 'conference-table-6': [3.05, 2.44, 0.75],
  'conference-table-10': [4.88, 2.74, 0.75], 'round-table-4': [1.83, 1.83, 0.75], sofa: [2.13, 0.91, 0.84],
  'lounge-chair': [0.86, 0.86, 0.84], 'coffee-table': [1.22, 0.61, 0.41], 'filing-cabinet': [0.91, 0.51, 1.32],
  bookshelf: [0.91, 0.36, 1.83], 'phone-booth': [1.07, 1.07, 2.29], 'pantry-counter': [3.05, 0.66, 2.13, true],
  'tv-display': [1.83, 0.46, 1.6], table: [1.52, 0.76, 0.75, true], 'round-table': [0.91, 0.91, 0.75, true],
  column: [0.61, 0.61, 2.9, true], plant: [0.61, 0.61, 1.52], planter: [1.83, 0.46, 0.91, true],
  'area-rug': [2.44, 1.83, 0.01, true, false], printer: [0.66, 0.66, 1.17], 'trash-recycling': [0.76, 0.41, 0.91],
  toilet: [0.51, 0.71, 0.79], vanity: [1.22, 0.56, 0.86, true],
  'gondola-shelving': [2.44, 1.22, 1.6, true], 'wall-shelving': [2.44, 0.51, 2.13, true],
  'checkout-counter': [1.83, 0.91, 1.07], 'display-table': [1.52, 0.91, 0.81], 'clothing-rack': [1.52, 0.61, 1.6],
  mannequin: [0.51, 0.41, 1.83], 'pallet-racking': [2.74, 1.07, 4.88, true], pallet: [1.22, 1.02, 1.37],
  forklift: [1.22, 2.44, 2.13], workbench: [1.83, 0.76, 1.5], bollard: [0.2, 0.2, 1.07],
  'floor-zone': [2.44, 2.44, 0.005, true, false],
};

/** Target gross area (sq ft) from the brief, per sample. */
const TARGET_AREA = { 'lab-suite': 5000, 'medical-office': 4500, 'office-floor': 9000, 'retail-warehouse': 7000 };

const errBox = document.getElementById('err');
const fail = (e) => { errBox.textContent += `${e.stack || e}\n`; console.error(e); };
window.addEventListener('error', (e) => fail(e.error || e.message));

// ---- Loading ----------------------------------------------------------------

const catalogStatus = await Promise.allSettled(['lab', 'medical', 'office', 'retail'].map((c) => import(`../src/catalog/${c}.js`)));
const catalogLoaded = ['lab', 'medical', 'office', 'retail'].filter((c, i) => catalogStatus[i].status === 'fulfilled');
const { SAMPLES } = await import('../src/samples/index.js');
let planRender = null;
try {
  if (!params.has('fallback')) planRender = await import('../src/plan-render.js');
} catch (e) {
  console.warn('plan-render.js is not available, using the fallback renderer:', e.message);
}

const sample = SAMPLES.find((s) => s.id === params.get('sample')) || SAMPLES[0];
buildNav();
const plan = await sample.build();

const dims = (item) => {
  const c = CANONICAL[item.type] || [0.6, 0.6, 0.9];
  return { w: item.w ?? c[0], d: item.d ?? c[1], h: item.h ?? c[2] };
};
const blocking = (item) => (CANONICAL[item.type] ? CANONICAL[item.type][4] !== false : true);

function buildNav() {
  const nav = document.getElementById('samples');
  for (const s of SAMPLES) {
    const a = document.createElement('a');
    const q = new URLSearchParams(params);
    q.set('sample', s.id);
    a.href = `?${q}`;
    a.textContent = s.name;
    if (s === sample) a.setAttribute('aria-current', 'page');
    nav.append(a);
  }
}

function buildViewNav() {
  const nav = document.getElementById('views');
  const entries = [['plan', null, 'Plan'], ['width', null, 'Aisles'], ['overview', null, 'Overview']];
  plan.cameras.forEach((c, i) => entries.push(['3d', String(i + 1), c.name]));
  for (const [v, cam, label] of entries) {
    const a = document.createElement('a');
    const q = new URLSearchParams(params);
    q.set('view', v);
    if (cam) q.set('cam', cam); else q.delete('cam');
    a.href = `?${q}`;
    a.textContent = label;
    if (v === view && (cam === null || cam === (params.get('cam') || '1'))) a.setAttribute('aria-current', 'page');
    nav.append(a);
  }
}

// ---- Geometry helpers ---------------------------------------------------------

function wallBody(w, s0 = 0, s1 = wallLength(w)) {
  const d = wallDir(w), n = wallNormal(w), h = w.thickness / 2;
  const p0 = pointOnWall(w, s0), p1 = pointOnWall(w, s1);
  return [add(p0, mul(n, h)), add(p1, mul(n, h)), sub(p1, mul(n, h)), sub(p0, mul(n, h))].map((p) => ({ ...p, d }));
}
function mul(p, s) { return { x: p.x * s, y: p.y * s }; }

/** Overlap depth of two convex polygons along their best separating axis (0 when apart). */
function satDepth(A, B) {
  let best = Infinity;
  for (const poly of [A, B]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const axis = norm({ x: -(q.y - p.y), y: q.x - p.x });
      if (!axis.x && !axis.y) continue;
      const pa = A.map((v) => dot(v, axis)), pb = B.map((v) => dot(v, axis));
      const overlap = Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb));
      if (overlap <= 0) return 0;
      best = Math.min(best, overlap);
    }
  }
  return best;
}

function sector(center, u, v, r, steps = 8) {
  const pts = [center];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * (Math.PI / 2);
    pts.push(add(center, add(mul(u, Math.cos(t) * r), mul(v, Math.sin(t) * r))));
  }
  return pts;
}

/** Swing sectors (convex polygons) of a hinged door, on its swing side. */
function swingAreas(w, o) {
  if (o.type !== 'door' && o.type !== 'double-door') return [];
  const s = openingSpan(w, o);
  const d = wallDir(w), n = mul(wallNormal(w), o.side), h = w.thickness / 2;
  const at = (off) => add(pointOnWall(w, off), mul(n, h));
  if (o.type === 'double-door') {
    const r = (s.end - s.start) / 2;
    return [sector(at(s.start), d, n, r), sector(at(s.end), mul(d, -1), n, r)];
  }
  const r = s.end - s.start;
  return o.hinge === 'end' ? [sector(at(s.end), mul(d, -1), n, r)] : [sector(at(s.start), d, n, r)];
}

/** Clear zone either side of a passable opening (36" deep). */
function doorwayZone(w, o) {
  const s = openingSpan(w, o);
  const n = wallNormal(w), h = w.thickness / 2 + 0.9;
  const p0 = pointOnWall(w, s.start + 0.05), p1 = pointOnWall(w, s.end - 0.05);
  return [add(p0, mul(n, h)), add(p1, mul(n, h)), sub(p1, mul(n, h)), sub(p0, mul(n, h))];
}

const ft = (m) => `${(m / FOOT).toFixed(1)}'`;
const label = (item) => `${item.type} (${item.id})`;

// ---- Validation -------------------------------------------------------------

const report = { errors: [], warnings: [], notes: [], marks: [] };
const error = (text, mark) => { report.errors.push(text); if (mark) report.marks.push({ ...mark, level: 'error' }); };
const warn = (text, mark) => { report.warnings.push(text); if (mark) report.marks.push({ ...mark, level: 'warn' }); };
const note = (text) => report.notes.push(text);

function checkItems() {
  for (const item of plan.items) {
    const c = CANONICAL[item.type];
    if (!c) { error(`Unknown item type "${item.type}" (${item.id})`, { point: item }); continue; }
    if (!c[3] && (item.w !== undefined || item.d !== undefined)) warn(`${label(item)} is not resizable but has a size override`, { point: item });
    if (hasItem(item.type)) {
      const def = getItem(item.type);
      if (Math.abs(def.w - c[0]) > 0.01 || Math.abs(def.d - c[1]) > 0.01) warn(`Catalog size of ${item.type} differs from the brief`);
    }
  }
}

function checkWalls() {
  const walls = plan.walls;
  for (const w of walls) if (wallLength(w) < 0.05) error(`Wall ${w.id} has zero length`, { point: w.a });
  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      const a = walls[i], b = walls[j];
      const da = wallDir(a), db = wallDir(b);
      if (Math.abs(cross(da, db)) < 1e-3) {
        const off = Math.abs(cross(da, sub(b.a, a.a)));
        if (off > 0.02) continue;
        const t0 = dot(sub(b.a, a.a), da), t1 = dot(sub(b.b, a.a), da);
        const overlap = Math.min(wallLength(a), Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1));
        if (overlap > 0.02) error(`Walls ${a.id} and ${b.id} overlap by ${ft(overlap)}`, { poly: wallBody(a) });
        continue;
      }
      const hit = segmentIntersection(a.a, a.b, b.a, b.b);
      if (!hit) continue;
      const atEndA = hit.t < 1e-3 || hit.t > 1 - 1e-3, atEndB = hit.u < 1e-3 || hit.u > 1 - 1e-3;
      if (!atEndA && !atEndB) warn(`Walls ${a.id} and ${b.id} cross without a junction`, { point: hit.point });
      else if (atEndA !== atEndB) warn(`Wall ${atEndA ? a.id : b.id} tees into ${atEndA ? b.id : a.id} without a shared endpoint`, { point: hit.point });
    }
  }
}

function checkOpenings() {
  const byWall = new Map(plan.walls.map((w) => [w.id, w]));
  const groups = new Map();
  for (const o of plan.openings) {
    const w = byWall.get(o.wallId);
    if (!w) { error(`Opening ${o.id} has no wall`); continue; }
    const L = wallLength(w);
    const start = o.offset - o.width / 2, end = o.offset + o.width / 2;
    const joined = (p) => Math.max(0, ...plan.walls.filter((x) => x !== w && (near(x.a, p) || near(x.b, p)) && Math.abs(cross(wallDir(x), wallDir(w))) > 0.1).map((x) => x.thickness / 2));
    const mark = { poly: wallBody(w, Math.max(0, start), Math.min(L, end)) };
    if (start < -1e-3 || end > L + 1e-3) error(`${o.type} ${o.id} does not fit on wall ${w.id} (${ft(o.width)} on ${ft(L)})`, mark);
    else if (start < joined(w.a) + 0.03 || end > L - joined(w.b) - 0.03) warn(`${o.type} ${o.id} runs into the corner of wall ${w.id}`, mark);
    if (o.type !== 'window' && o.height > w.height + 1e-3) error(`${o.type} ${o.id} is taller than its wall`, mark);
    if (o.type === 'window' && (w.kind === 'glass' || w.kind === 'partial')) warn(`Window ${o.id} on a ${w.kind} wall`, mark);
    if (o.type === 'window' && o.sill + o.height > w.height - 0.05) warn(`Window ${o.id} reaches the top of its wall`, mark);
    if (!groups.has(w.id)) groups.set(w.id, []);
    groups.get(w.id).push({ o, start, end });
  }
  for (const [id, list] of groups) {
    list.sort((p, q) => p.start - q.start);
    for (let i = 1; i < list.length; i++) {
      if (list[i].start < list[i - 1].end - 1e-3) error(`Openings ${list[i - 1].o.id} and ${list[i].o.id} overlap on wall ${id}`);
    }
  }
}
const near = (p, q) => dist(p, q) < 1e-3;

function checkCollisions() {
  const items = plan.items.map((it) => ({ it, poly: itemCorners(it, dims(it)), block: blocking(it) }));
  const curtains = (x) => x.it.type === 'privacy-curtain';
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const relevant = (a.block && b.block) || (curtains(a) && b.block) || (curtains(b) && a.block);
      if (!relevant) continue;
      const depth = satDepth(a.poly, b.poly);
      if (depth > 0.03) error(`${label(a.it)} overlaps ${label(b.it)} by ${ft(depth)}`, { poly: a.poly, poly2: b.poly });
    }
  }
  for (const x of items) {
    for (const w of plan.walls) {
      if (w.kind === 'partial' && !x.block) continue;
      const depth = satDepth(x.poly, wallBody(w));
      if (depth > 0.02) error(`${label(x.it)} cuts into wall ${w.id} by ${ft(depth)}`, { poly: x.poly });
    }
    const corners = x.poly.map((p) => add(p, mul(sub(polygonCentroid(x.poly), p), 0.02)));
    if (!plan.rooms.some((r) => pointInPolygon(x.it, r.points))) error(`${label(x.it)} is outside every room`, { poly: x.poly });
    else if (!corners.every((p) => plan.rooms.some((r) => pointInPolygon(p, r.points)))) warn(`${label(x.it)} sticks out of the rooms`, { poly: x.poly });
  }
  const byWall = new Map(plan.walls.map((w) => [w.id, w]));
  for (const o of plan.openings) {
    const w = byWall.get(o.wallId);
    if (!w || !OPENING_TYPES[o.type]?.passable) continue;
    const zones = [...swingAreas(w, o).map((poly) => ({ poly, what: 'swing' })), { poly: doorwayZone(w, o), what: 'doorway' }];
    for (const z of zones) {
      for (const x of items) {
        if (!x.block) continue;
        const depth = satDepth(z.poly, x.poly);
        if (depth > 0.03) warn(`${label(x.it)} blocks the ${z.what} of ${o.type} ${o.id}`, { poly: z.poly, poly2: x.poly });
      }
    }
  }
}

function checkRooms() {
  for (const r of plan.rooms) {
    const pts = r.points;
    if (polygonArea(pts) < 0.5) error(`Room "${r.name}" has almost no area`);
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        if (j === i + 1 || (i === 0 && j === pts.length - 1)) continue;
        if (segmentIntersection(pts[i], pts[(i + 1) % pts.length], pts[j], pts[(j + 1) % pts.length])) {
          error(`Room "${r.name}" outline crosses itself`, { poly: pts });
        }
      }
    }
  }
  const shell = boundsOf(plan.walls.flatMap((w) => [w.a, w.b]));
  const inside = (c) => (plan.rooms.length
    ? plan.rooms.some((r) => pointInPolygon(c, r.points))
    : c.x > shell.minX && c.x < shell.maxX && c.y > shell.minY && c.y < shell.maxY);
  for (const c of plan.cameras) if (!inside(c)) error(`Camera "${c.name}" is outside the ${plan.rooms.length ? 'rooms' : 'walls'}`, { point: c });
}

// ---- Raster analysis: room coverage, clearance and reachability ----------------

function rasterize() {
  const b = boundsOf(plan.walls.flatMap((w) => [w.a, w.b]).concat(plan.rooms.flatMap((r) => r.points)));
  const minX = b.minX - 1, minY = b.minY - 1;
  const nx = Math.ceil((b.maxX - minX + 1) / CELL), ny = Math.ceil((b.maxY - minY + 1) / CELL);
  const N = nx * ny;
  const center = (i, j) => ({ x: minX + (i + 0.5) * CELL, y: minY + (j + 0.5) * CELL });
  const room = new Int16Array(N).fill(-1);
  const roomCount = new Uint8Array(N);
  const wall = new Uint8Array(N);
  const solid = new Uint8Array(N);
  const doorway = new Uint8Array(N);

  const fillPoly = (poly, fn) => {
    const bb = boundsOf(poly);
    const i0 = Math.max(0, Math.floor((bb.minX - minX) / CELL)), i1 = Math.min(nx - 1, Math.ceil((bb.maxX - minX) / CELL));
    const j0 = Math.max(0, Math.floor((bb.minY - minY) / CELL)), j1 = Math.min(ny - 1, Math.ceil((bb.maxY - minY) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (pointInPolygon(center(i, j), poly)) fn(j * nx + i);
  };
  plan.rooms.forEach((r, ri) => fillPoly(r.points, (k) => { roomCount[k]++; if (room[k] < 0) room[k] = ri; }));
  const byWall = new Map();
  for (const o of plan.openings) {
    if (!byWall.has(o.wallId)) byWall.set(o.wallId, []);
    byWall.get(o.wallId).push(o);
  }
  for (const w of plan.walls) {
    const pad = { ...w, thickness: w.thickness + CELL };
    fillPoly(wallBody(pad, -CELL / 2, wallLength(w) + CELL / 2), (k) => { wall[k] = 1; });
  }
  for (const w of plan.walls) {
    for (const o of byWall.get(w.id) || []) {
      if (!OPENING_TYPES[o.type]?.passable) continue;
      const s = openingSpan(w, o);
      fillPoly(wallBody({ ...w, thickness: w.thickness + 2 * CELL }, s.start, s.end), (k) => { wall[k] = 0; doorway[k] = 1; });
    }
  }
  for (const it of plan.items) if (blocking(it)) fillPoly(itemCorners(it, dims(it)), (k) => { solid[k] = 1; });
  return { minX, minY, nx, ny, N, center, room, roomCount, wall, solid, doorway, index: (p) => {
    const i = Math.floor((p.x - minX) / CELL), j = Math.floor((p.y - minY) / CELL);
    return i >= 0 && j >= 0 && i < nx && j < ny ? j * nx + i : -1;
  } };
}

/** Exact Euclidean distance transform (Felzenszwalb) of a binary grid; returns distances in cells. */
function distanceTransform(blocked, nx, ny) {
  const INF = 1e12;
  const f = new Float64Array(Math.max(nx, ny));
  const d = new Float64Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) d[k] = blocked[k] ? 0 : INF;
  const pass = (get, set, n) => {
    for (let q = 0; q < n; q++) f[q] = get(q);
    const v = new Int32Array(n), z = new Float64Array(n + 1);
    let k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let s;
      do {
        const p = v[k];
        s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
      } while (s <= z[k] && --k >= 0);
      k++;
      v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      set(q, (q - v[k]) * (q - v[k]) + f[v[k]]);
    }
  };
  for (let i = 0; i < nx; i++) pass((q) => d[q * nx + i], (q, val) => { d[q * nx + i] = val; }, ny);
  for (let j = 0; j < ny; j++) pass((q) => d[j * nx + q], (q, val) => { d[j * nx + q] = val; }, nx);
  for (let k = 0; k < nx * ny; k++) d[k] = Math.sqrt(d[k]);
  return d;
}

function analyzeSpace() {
  const g = rasterize();
  const { N, nx, ny } = g;
  let overlap = 0, pockets = 0;
  for (let k = 0; k < N; k++) if (g.roomCount[k] > 1) overlap++;
  if (overlap * CELL * CELL > 0.5) warn(`Rooms overlap by about ${Math.round((overlap * CELL * CELL) / SQFT)} sq ft`);

  // Untraced pockets: cells enclosed by walls that belong to no room.
  const outside = new Uint8Array(N);
  const closed = new Uint8Array(N);
  for (const w of plan.walls) {
    const pad = { ...w, thickness: w.thickness + CELL };
    const poly = wallBody(pad, -CELL / 2, wallLength(w) + CELL / 2);
    const bb = boundsOf(poly);
    for (let j = Math.max(0, Math.floor((bb.minY - g.minY) / CELL)); j <= Math.min(ny - 1, Math.ceil((bb.maxY - g.minY) / CELL)); j++) {
      for (let i = Math.max(0, Math.floor((bb.minX - g.minX) / CELL)); i <= Math.min(nx - 1, Math.ceil((bb.maxX - g.minX) / CELL)); i++) {
        if (pointInPolygon(g.center(i, j), poly)) closed[j * nx + i] = 1;
      }
    }
  }
  const stack = [0];
  outside[0] = 1;
  while (stack.length) {
    const k = stack.pop();
    const i = k % nx, j = (k - i) / nx;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
      const q = b * nx + a;
      if (outside[q] || closed[q]) continue;
      outside[q] = 1;
      stack.push(q);
    }
  }
  for (let k = 0; k < N; k++) if (!outside[k] && !closed[k] && g.room[k] < 0) pockets++;
  if (pockets * CELL * CELL > 1) warn(`About ${Math.round((pockets * CELL * CELL) / SQFT)} sq ft inside the walls is not in any room`);

  // Clearance: distance to walls, blocking items and the area outside the rooms.
  const blocked = new Uint8Array(N);
  for (let k = 0; k < N; k++) blocked[k] = g.wall[k] || g.solid[k] || (g.room[k] < 0 && !g.doorway[k]) ? 1 : 0;
  const clear = distanceTransform(blocked, nx, ny);
  for (let k = 0; k < N; k++) clear[k] = Math.max(0, clear[k] * CELL - CELL / 2);

  // Widest path from the first camera: best[k] is the narrowest clearance on the best route to k,
  // ignoring the first meter around the camera itself.
  const best = new Float64Array(N).fill(-1);
  const start = plan.cameras.length ? g.index(plan.cameras[0]) : -1;
  if (start >= 0 && clear[start] > 0) {
    const si = start % nx, sj = (start - si) / nx;
    const heap = new MaxHeap();
    best[start] = Infinity;
    heap.push(start, best[start]);
    while (heap.size) {
      const [k, b] = heap.pop();
      if (b < best[k]) continue;
      const i = k % nx, j = (k - i) / nx;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const a = i + di, c = j + dj;
        if (a < 0 || c < 0 || a >= nx || c >= ny) continue;
        const q = c * nx + a;
        if (blocked[q]) continue;
        const nb = Math.hypot(a - si, c - sj) * CELL < 1 ? Infinity : Math.min(b, clear[q]);
        if (nb > best[q]) { best[q] = nb; heap.push(q, nb); }
      }
    }
  } else {
    error('The first camera is not on open floor, so circulation could not be checked');
  }

  // Local aisle width: the widest empty circle covering each reachable cell.
  const width = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const r = clear[k];
    if (best[k] < WALKER || r < WALKER) continue;
    const i = k % nx, j = (k - i) / nx, rc = Math.floor(r / CELL);
    for (let dj = -rc; dj <= rc; dj++) {
      const span = Math.floor(Math.sqrt(rc * rc - dj * dj));
      const row = (j + dj) * nx;
      if (j + dj < 0 || j + dj >= ny) continue;
      for (let di = Math.max(-span, -i); di <= Math.min(span, nx - 1 - i); di++) {
        const q = row + i + di;
        if (2 * r > width[q]) width[q] = 2 * r;
      }
    }
  }

  const roomStats = plan.rooms.map(() => ({ reach: 0, narrow: 0, cells: 0 }));
  for (let k = 0; k < N; k++) {
    const ri = g.room[k];
    if (ri < 0 || blocked[k]) continue;
    const s = roomStats[ri];
    s.cells++;
    s.reach = Math.max(s.reach, best[k]);
    if (best[k] >= WALKER && clear[k] >= WALKER && width[k] > 0 && width[k] < AISLE - 0.02 && !nearDoorway(g, k)) s.narrow++;
  }
  plan.rooms.forEach((r, ri) => {
    const s = roomStats[ri];
    if (s.reach < WALKER) error(`"${r.name}" cannot be reached from the first camera`, { poly: r.points });
    else if (s.reach < 0.42) warn(`"${r.name}" is only reachable through a ${ft(2 * s.reach)} gap`, { poly: r.points });
  });
  for (const c of plan.cameras) {
    const k = g.index(c);
    if (k < 0 || clear[k] < WALKER) error(`Camera "${c.name}" stands in or against an obstacle`, { point: c });
    else if (best[k] < WALKER) error(`Camera "${c.name}" cannot be reached on foot`, { point: c });
  }
  return { g, clear, best, width, blocked, roomStats };
}

function nearDoorway(g, k) {
  const i = k % g.nx, j = (k - i) / g.nx, r = 6;
  for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
    const a = i + di, b = j + dj;
    if (a >= 0 && b >= 0 && a < g.nx && b < g.ny && g.doorway[b * g.nx + a]) return true;
  }
  return false;
}

class MaxHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const { k, v } = this;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (v[p] >= v[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const { k, v } = this;
    const top = [k[0], v[0]];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && v[l] > v[m]) m = l;
        if (r < k.length && v[r] > v[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Fraction of traced wall centerline that lands on dark poché in the underlay image. */
async function checkUnderlay() {
  const u = plan.underlay;
  if (!u) return null;
  const img = new Image();
  img.src = u.src;
  await img.decode();
  if (img.naturalWidth !== u.width || img.naturalHeight !== u.height) {
    error(`Underlay size ${u.width} x ${u.height} does not match the image (${img.naturalWidth} x ${img.naturalHeight})`);
  }
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  let hit = 0, total = 0;
  const byWall = new Map();
  for (const o of plan.openings) {
    if (!byWall.has(o.wallId)) byWall.set(o.wallId, []);
    byWall.get(o.wallId).push(openingSpan(plan.walls.find((w) => w.id === o.wallId), o));
  }
  for (const w of plan.walls) {
    const L = wallLength(w), spans = byWall.get(w.id) || [];
    for (let s = 0.2; s < L - 0.2; s += 0.1) {
      if (spans.some((sp) => s > sp.start - 0.1 && s < sp.end + 0.1)) continue;
      const p = pointOnWall(w, s);
      const px = Math.round((p.x - u.x) / u.scale), py = Math.round((p.y - u.y) / u.scale);
      total++;
      if (px < 0 || py < 0 || px >= c.width || py >= c.height) continue;
      const q = (py * c.width + px) * 4;
      if (data[q] + data[q + 1] + data[q + 2] < 3 * 110 && data[q + 3] > 200) hit++;
    }
  }
  const share = total ? hit / total : 0;
  if (share < 0.95) error(`Traced walls only cover the drawing's walls ${Math.round(share * 100)}% of the time`);
  return { share, natural: [img.naturalWidth, img.naturalHeight] };
}

// ---- Run checks ---------------------------------------------------------------

checkItems();
checkWalls();
checkOpenings();
checkCollisions();
checkRooms();
const space = plan.rooms.length ? analyzeSpace() : null;
const underlay = await checkUnderlay().catch((e) => { error(`Underlay failed to load: ${e.message}`); return null; });

const totalArea = plan.rooms.reduce((s, r) => s + polygonArea(r.points), 0) / SQFT;
const target = TARGET_AREA[sample.id];
if (target && Math.abs(totalArea - target) / target > 0.1) warn(`Rooms add up to ${Math.round(totalArea)} sq ft, the brief asks for about ${target}`);
const shell = boundsOf(plan.walls.flatMap((w) => [w.a, w.b]));
const stats = {
  walls: plan.walls.length, openings: plan.openings.length, rooms: plan.rooms.length, items: plan.items.length,
  cameras: plan.cameras.length, area: Math.round(totalArea), target,
  size: `${((shell.maxX - shell.minX) / FOOT).toFixed(0)}' x ${((shell.maxY - shell.minY) / FOOT).toFixed(0)}'`,
  catalog: catalogLoaded.join(', '), renderer: planRender ? 'plan-render.js' : 'fallback',
};
if (!planRender) note('plan-render.js failed to load, so the plan is drawn with the simple fallback');
if (underlay) note(`Underlay ${underlay.natural.join(' x ')} px, ${Math.round(underlay.share * 100)}% of traced wall length sits on drawn walls`);
for (const t of new Set(plan.items.map((i) => i.type))) if (!hasItem(t)) note(`${t} is not registered yet, so it draws as a placeholder`);

window.samplesReport = { id: sample.id, errors: report.errors, warnings: report.warnings, notes: report.notes, stats };
console.log('samples-test', JSON.stringify({ id: sample.id, errors: report.errors.length, warnings: report.warnings.length, stats }));
for (const e of report.errors) console.log('ERROR', e);
for (const w of report.warnings) console.log('WARN', w);

buildViewNav();
renderReport();
if (view === '3d' || view === 'overview') await render3d();
else renderPlanView();
window.samplesReady = true;

// ---- Report panel -------------------------------------------------------------

function renderReport() {
  const el = document.getElementById('report');
  const h = (tag, text, cls) => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  };
  el.append(h('h1', sample.name), h('p', sample.description, 'desc'));
  const summary = h('div');
  summary.id = 'summary';
  summary.append(
    h('span', `${report.errors.length} errors`, report.errors.length ? 'bad' : 'good'),
    h('span', `${report.warnings.length} warnings`),
  );
  el.append(summary);

  el.append(h('h2', 'Plan'));
  const t = h('table');
  const row = (k, v) => { const tr = h('tr'); tr.append(h('td', k), h('td', String(v))); t.append(tr); };
  row('Shell', stats.size);
  row('Room area', `${stats.area.toLocaleString('en-US')} sq ft${target ? ` (brief ${target.toLocaleString('en-US')})` : ''}`);
  row('Walls, openings', `${stats.walls}, ${stats.openings}`);
  row('Rooms, items, cameras', `${stats.rooms}, ${stats.items}, ${stats.cameras}`);
  row('Settings', `${(plan.settings.wallHeight / FOOT).toFixed(1)}' ceiling, ${plan.settings.ceiling}, ${plan.settings.exterior}`);
  row('Catalog loaded', stats.catalog || 'none');
  el.append(t);

  const list = (title, items, cls) => {
    if (!items.length) return;
    el.append(h('h2', title));
    const ul = h('ul');
    for (const text of items) ul.append(h('li', text, cls));
    el.append(ul);
  };
  list('Errors', report.errors, 'error');
  list('Warnings', report.warnings, 'warn');

  if (plan.rooms.length) {
    el.append(h('h2', 'Rooms'));
    const rt = h('table');
    plan.rooms.forEach((r, i) => {
      const s = space?.roomStats[i];
      const tr = h('tr');
      const narrow = s && s.narrow ? `, ${Math.round((s.narrow * CELL * CELL) / SQFT)} sq ft under 3' 6"` : '';
      tr.append(h('td', `${r.name} (${FLOORS[r.floor]?.label || r.floor}${narrow})`), h('td', formatArea(polygonArea(r.points))));
      rt.append(tr);
    });
    el.append(rt);
  }
  list('Cameras', plan.cameras.map((c) => `${c.name}: ${ft(c.x)}, ${ft(c.y)}, facing ${c.yaw} degrees`), 'ok');
  list('Notes', report.notes);
}

// ---- Plan view ------------------------------------------------------------------

function renderPlanView() {
  const canvas = document.getElementById('plan');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  const draw = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bounds = planRender ? planRender.planBounds(plan) : boundsOf(plan.walls.flatMap((w) => [w.a, w.b]));
    const v = planRender ? planRender.fitView(bounds, W, H, 48) : fallbackView(bounds, W, H);
    if (planRender) {
      planRender.renderPlan(ctx, plan, v, { showGrid: false, showDimensions: true, showLabels: true, showUnderlay: true, onLoad: draw });
    } else {
      fallbackRender(ctx, v, W, H);
    }
    if (view === 'width' && space) drawWidthOverlay(ctx, v);
    drawMarks(ctx, v);
  };
  draw();
}

function fallbackView(b, W, H) {
  const pad = 48;
  const scale = Math.min((W - 2 * pad) / (b.maxX - b.minX), (H - 2 * pad) / (b.maxY - b.minY));
  return { scale, ox: W / 2 - ((b.minX + b.maxX) / 2) * scale, oy: H / 2 - ((b.minY + b.maxY) / 2) * scale, width: W, height: H };
}

function screen(v, p) {
  return { x: v.ox + p.x * v.scale, y: v.oy + p.y * v.scale };
}

function polyPath(ctx, v, pts) {
  ctx.beginPath();
  pts.forEach((p, i) => { const s = screen(v, p); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); });
  ctx.closePath();
}

function fallbackRender(ctx, v, W, H) {
  ctx.fillStyle = '#fbfbfb';
  ctx.fillRect(0, 0, W, H);
  for (const r of plan.rooms) {
    polyPath(ctx, v, r.points);
    ctx.fillStyle = FLOORS[r.floor]?.color2d || '#eee';
    ctx.fill();
  }
  for (const it of plan.items) {
    polyPath(ctx, v, itemCorners(it, dims(it)));
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = blocking(it) ? '#435254' : '#80bbad';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  const byWall = new Map();
  for (const o of plan.openings) {
    if (!byWall.has(o.wallId)) byWall.set(o.wallId, []);
    byWall.get(o.wallId).push(o);
  }
  for (const w of plan.walls) {
    const cuts = (byWall.get(w.id) || []).map((o) => openingSpan(w, o)).sort((a, b) => a.start - b.start);
    let at = 0;
    const pieces = [];
    for (const c of cuts) { pieces.push([at, c.start]); at = c.end; }
    pieces.push([at, wallLength(w)]);
    ctx.strokeStyle = { exterior: '#435254', interior: '#6b7779', glass: '#80bbad', partial: '#b3bcbe' }[w.kind];
    ctx.lineWidth = Math.max(1.5, w.thickness * v.scale);
    ctx.lineCap = 'butt';
    for (const [s0, s1] of pieces) {
      if (s1 - s0 < 0.01) continue;
      const a = screen(v, pointOnWall(w, s0)), b = screen(v, pointOnWall(w, s1));
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
  }
  ctx.fillStyle = '#435254';
  ctx.font = '600 12px Calibre, system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (const r of plan.rooms) {
    const c = screen(v, polygonCentroid(r.points));
    ctx.fillText(r.name, c.x, c.y);
  }
}

function drawWidthOverlay(ctx, v) {
  const { g, width, best, clear } = space;
  const s = CELL * v.scale;
  for (let k = 0; k < g.N; k++) {
    if (best[k] < WALKER || clear[k] < WALKER * 0.6 || width[k] <= 0) continue;
    const w = width[k];
    const color = w < 3 * FOOT ? 'rgba(168, 51, 44, 0.55)' : w < AISLE ? 'rgba(217, 164, 58, 0.5)' : 'rgba(23, 232, 143, 0.16)';
    const i = k % g.nx, j = (k - i) / g.nx;
    const p = screen(v, { x: g.minX + i * CELL, y: g.minY + j * CELL });
    ctx.fillStyle = color;
    ctx.fillRect(p.x, p.y, s + 0.5, s + 0.5);
  }
}

function drawMarks(ctx, v) {
  for (const m of report.marks) {
    ctx.strokeStyle = m.level === 'error' ? '#a8332c' : '#d9a43a';
    ctx.fillStyle = m.level === 'error' ? 'rgba(168, 51, 44, 0.18)' : 'rgba(217, 164, 58, 0.18)';
    ctx.lineWidth = 2;
    for (const poly of [m.poly, m.poly2]) {
      if (!poly) continue;
      polyPath(ctx, v, poly);
      ctx.fill();
      ctx.stroke();
    }
    if (m.point) {
      const p = screen(v, m.point);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}

// ---- 3D views ---------------------------------------------------------------------

async function render3d() {
  const THREE = await import('three');
  const { createKit } = await import('../src/kit3d.js');
  const { buildPlanScene, setupEnvironment } = await import('../src/builder3d.js');
  const old = document.getElementById('plan');
  const canvas = document.createElement('canvas');
  old.replaceWith(canvas);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(W, H, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const env = setupEnvironment(renderer, scene);
  const built = buildPlanScene(plan, { kit: createKit(), quality: 'high' });
  scene.add(built.root);
  env.fit(built.bounds);
  const camera = new THREE.PerspectiveCamera(62, W / H, 0.05, 2000);
  if (view === 'overview') {
    for (const c of built.ceilings) c.visible = false;
    const b = built.bounds;
    const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2, span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    camera.fov = 45;
    camera.position.set(cx + span * 0.15, span * 0.95, cz + span * 0.75);
    camera.lookAt(cx, 0, cz + span * 0.05);
  } else {
    const saved = plan.cameras[Math.max(0, Number(params.get('cam') || 1) - 1)] || plan.cameras[0];
    const pose = (k) => (params.has(k) ? Number(params.get(k)) * (k === 'yaw' || k === 'pitch' ? 1 : FOOT) : saved[k]);
    const cam = { x: pose('x'), y: pose('y'), yaw: pose('yaw'), pitch: pose('pitch') };
    const yaw = THREE.MathUtils.degToRad(cam.yaw), pitch = THREE.MathUtils.degToRad(cam.pitch);
    camera.position.set(cam.x, DEFAULTS.eyeHeight, cam.y);
    camera.lookAt(cam.x + Math.sin(yaw) * Math.cos(pitch), DEFAULTS.eyeHeight + Math.sin(pitch), cam.y - Math.cos(yaw) * Math.cos(pitch));
  }
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  renderer.render(scene, camera);
}
