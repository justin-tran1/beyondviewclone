// Lab and life sciences catalog: benches, hoods, cold storage, safety fixtures and lab seating.
// Local frame: x = width, y = up, z = depth with the front facing +z (plan +y).
import { registerItems } from './registry.js';

const TOP = 0.9;        // bench work surface height
const TOP_T = 0.032;    // epoxy top thickness
const TOE = 0.1;        // toe kick height
const GAP = 0.004;      // half the reveal between door fronts
const FRONT_T = 0.018;  // door and drawer front thickness
const END_T = 0.019;    // cabinet end panel thickness
const MODULE = 0.9;     // nominal base cabinet module width
const MAX_REPEAT = 200; // most modules, posts or outlets a run repeats, so absurd sizes stay fast
const OUT = 1.25;       // plan outline weight in px
const FINE = 0.75;      // plan detail weight in px
const DASH = [4, 3];    // overhead elements, in px

const LIQUIDS = ['#93612b', '#dfe6e4', '#80bbad', '#3d6f8e', '#dbd99a', '#c9d3d2'];
const CAPS = ['#2a5d84', '#f2f2ef', '#22272b'];
const BINDERS = ['#538184', '#80bbad', '#dbd99a', '#435254', '#cad1d3', '#003f2d'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];
const repeats = (n, min = 1) => clamp(n, min, MAX_REPEAT);
const moduleCount = (len) => repeats(Math.round(len / MODULE));

function seq(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---- Materials ----------------------------------------------------------------------

function palette(kit, color) {
  const custom = typeof color === 'string' && color ? kit.material(color, { roughness: 0.5 }) : null;
  return {
    custom,
    case: kit.mat.casework,
    door: custom || kit.mat.casework,
    body: custom || kit.mat.white,
    white: kit.mat.white,
    top: kit.mat.epoxyTop,
    steel: kit.mat.steel,
    darkSteel: kit.mat.darkSteel,
    chrome: kit.mat.chrome,
    pull: kit.mat.darkSteel,
    black: kit.mat.black,
    rubber: kit.mat.rubber,
    screen: kit.mat.screen,
    led: kit.mat.led,
    status: kit.mat.accentGreen,
    yellow: kit.mat.safetyYellow,
    reveal: kit.material('#8d969a', { roughness: 0.85 }),
    plinth: kit.material('#3b4246', { roughness: 0.85 }),
    slot: kit.material('#2a2f33', { roughness: 0.9 }),
    trim: kit.material('#e1e5e5', { roughness: 0.45 }),
    alu: kit.material('#a9b1b5', { roughness: 0.35, metalness: 0.6 }),
    plate: kit.material('#f7f7f4', { roughness: 0.4 }),
    basin: kit.material('#353b3f', { roughness: 0.35 }),
    lit: kit.material('#f1f4f3', { roughness: 0.6, emissive: '#ffffff', emissiveIntensity: 0.22 }),
    interior: kit.material('#e3e7e6', { roughness: 0.6 }),
    liquids: LIQUIDS.map((c) => kit.material(c, { roughness: 0.3 })),
    caps: CAPS.map((c) => kit.material(c, { roughness: 0.45 })),
  };
}

// ---- 3D helpers ---------------------------------------------------------------------

/** Non-resizable items are modeled at their default size and scaled to any other size. */
function fixed(def) {
  const build = def.build;
  return {
    ...def,
    build(kit, o = {}) {
      const g = build(kit, { w: def.w, d: def.d, h: def.h, color: o.color });
      const s = [(o.w || def.w) / def.w, (o.h || def.h) / def.h, (o.d || def.d) / def.d];
      if (s.some((v) => Math.abs(v - 1) > 1e-6)) g.scale.set(...s);
      return g;
    },
  };
}

/** Cylinder between two points [x, y, z]. */
function rod(kit, g, mat, r, a, b, { segments = 10, over = 0 } = {}) {
  const T = kit.THREE;
  const dir = new T.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const mesh = kit.cyl(g, mat, r, dir.length() + over, 0, 0, 0, { segments });
  mesh.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  mesh.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}

/** Child group posed at (x, y, z) and rotated, for parts modeled in their own frame. */
function sub(kit, g, x, y, z, { yaw = 0, pitch = 0, roll = 0 } = {}) {
  const f = kit.group();
  f.position.set(x, y, z);
  f.rotation.set(pitch, yaw, roll);
  g.add(f);
  return f;
}

function front(kit, g, mat, x0, x1, y0, y1) {
  kit.block(g, mat, x0 + GAP, x1 - GAP, y0 + GAP, y1 - GAP, -FRONT_T, 0);
}

function pull(kit, g, mat, x, y, vertical, len) {
  if (vertical) kit.block(g, mat, x - 0.006, x + 0.006, y - len / 2, y + len / 2, 0, 0.018);
  else kit.block(g, mat, x - len / 2, x + len / 2, y - 0.006, y + 0.006, 0, 0.018);
}

function doorModule(kit, g, m, a, b, top, drawer, hand) {
  const cx = (a + b) / 2;
  let y1 = top;
  if (drawer) {
    front(kit, g, m.door, a, b, top - 0.16, top);
    pull(kit, g, m.pull, cx, top - 0.075, false, Math.min(0.16, (b - a) * 0.35));
    y1 = top - 0.16;
  }
  const py = y1 - 0.13;
  if (b - a >= 0.6) {
    front(kit, g, m.door, a, cx, TOE, y1);
    front(kit, g, m.door, cx, b, TOE, y1);
    pull(kit, g, m.pull, cx - 0.04, py, true, 0.12);
    pull(kit, g, m.pull, cx + 0.04, py, true, 0.12);
  } else {
    front(kit, g, m.door, a, b, TOE, y1);
    pull(kit, g, m.pull, hand > 0 ? b - 0.045 : a + 0.045, py, true, 0.12);
  }
}

function drawerStack(kit, g, m, a, b, top) {
  const cx = (a + b) / 2;
  const rest = (top - 0.16 - TOE) / 3;
  const ys = [top, top - 0.16, top - 0.16 - rest, top - 0.16 - 2 * rest, TOE];
  for (let i = 0; i < 4; i++) {
    front(kit, g, m.door, a, b, ys[i + 1], ys[i]);
    pull(kit, g, m.pull, cx, ys[i] - 0.07, false, Math.min(0.16, (b - a) * 0.35));
  }
}

/** Carcass blocks [x0, x1, y1, z0, z1] over x0..x1 and z0..z1, with the cut pocket dropped to cut.y. */
function carcassBlocks(x0, x1, z0, z1, top, cut) {
  if (!cut) return [[x0, x1, top, z0, z1]];
  const a = clamp(cut.x0, x0, x1), b = clamp(cut.x1, x0, x1);
  const c = clamp(cut.z0 ?? z0, z0, z1), e = clamp(cut.z1 ?? z1, z0, z1);
  return [
    [x0, a, top, z0, z1], [b, x1, top, z0, z1],
    [a, b, top, z0, c], [a, b, top, e, z1], [a, b, cut.y, c, e],
  ].filter(([p, q, , r, s]) => q - p > 0.002 && s - r > 0.002);
}

/**
 * Base cabinet run of `len` x `depth`, carcass top at `height`, front face at z = 0.
 * cut lowers a pocket of the carcass (cut.x0..cut.x1, and cut.z0..cut.z1 in run coordinates or
 * else the full depth) to cut.y so a sink bowl can drop in.
 */
function cabinetRun(kit, m, len, depth, height, { stack = -1, doorsOnly = false, cut = null, ends = true } = {}) {
  const g = kit.group();
  const e = ends ? END_T : 0;
  const x0 = -len / 2 + e, x1 = len / 2 - e;
  const back = -FRONT_T - 0.004;
  kit.block(g, m.plinth, x0, x1, 0, TOE, -depth, -0.06);
  if (ends) {
    kit.block(g, m.case, -len / 2, x0, 0, height, -depth, 0);
    kit.block(g, m.case, x1, len / 2, 0, height, -depth, 0);
  }
  for (const [a, b, y, za, zb] of carcassBlocks(x0, x1, -depth, back, height, cut)) kit.block(g, m.case, a, b, TOE, y, za, zb);
  kit.block(g, m.reveal, x0, x1, TOE, height, back, -FRONT_T, false);
  const n = moduleCount(x1 - x0);
  const mw = (x1 - x0) / n;
  for (let i = 0; i < n; i++) {
    const a = x0 + i * mw;
    if (i === stack) drawerStack(kit, g, m, a, a + mw, height);
    else doorModule(kit, g, m, a, a + mw, height, !doorsOnly, i % 2 ? -1 : 1);
  }
  return g;
}

/** Slab with an optional rectangular hole {x0, x1, z0, z1}. */
function slab(kit, g, mat, x0, x1, y0, y1, z0, z1, hole) {
  if (!hole) {
    kit.block(g, mat, x0, x1, y0, y1, z0, z1);
    return;
  }
  const parts = [
    [x0, hole.x0, z0, z1], [hole.x1, x1, z0, z1],
    [hole.x0, hole.x1, z0, hole.z0], [hole.x0, hole.x1, hole.z1, z1],
  ];
  for (const [a, b, c, e] of parts) if (b - a > 1e-3 && e - c > 1e-3) kit.block(g, mat, a, b, y0, y1, c, e);
}

/** Sink bowl hanging below a hole in a top whose surface is at y. */
function basin(kit, g, mat, drain, hole, y, depth) {
  const t = 0.012, yb = y - depth, yt = y - 0.002;
  const { x0, x1, z0, z1 } = hole;
  kit.block(g, mat, x0, x1, yb - t, yb, z0, z1);
  kit.block(g, mat, x0, x1, yb, yt, z0, z0 + t);
  kit.block(g, mat, x0, x1, yb, yt, z1 - t, z1);
  kit.block(g, mat, x0, x0 + t, yb, yt, z0 + t, z1 - t);
  kit.block(g, mat, x1 - t, x1, yb, yt, z0 + t, z1 - t);
  kit.cyl(g, drain, 0.028, 0.004, (x0 + x1) / 2, yb, (z0 + z1) / 2, { segments: 16 });
}

/** Gooseneck faucet at (x, y, z) arcing `reach` toward its local +x, turned by yaw. */
function gooseneck(kit, g, mat, x, y, z, rise, reach, yaw) {
  const f = sub(kit, g, x, y, z, { yaw });
  const r = reach / 2, t = 0.011;
  kit.cyl(f, mat, 0.026, 0.025, 0, 0, 0, { segments: 16 });
  kit.cyl(f, mat, t, rise, 0, 0, 0, { segments: 10 });
  let prev = [0, rise, 0];
  for (let i = 1; i <= 9; i++) {
    const a = Math.PI * (1 - i / 9);
    const p = [r + r * Math.cos(a), rise + r * Math.sin(a), 0];
    rod(kit, f, mat, t, prev, p, { over: 0.006 });
    prev = p;
  }
  kit.cyl(f, mat, t * 1.3, 0.04, reach, rise - 0.04, 0, { segments: 10 });
  for (const s of [-1, 1]) {
    kit.cyl(f, mat, 0.015, 0.05, 0, 0, s * 0.07, { segments: 10 });
    kit.block(f, mat, -0.007, 0.007, 0.042, 0.052, s * 0.07, s * 0.07 + s * 0.09);
  }
  return f;
}

const span = (a, b) => (a < b ? [a, b] : [b, a]);

/** Duplex outlet on a face at z, facing +z (s = 1) or -z (s = -1). */
function outlet(kit, g, m, x, y, z, s = 1) {
  kit.block(g, m.plate, x - 0.037, x + 0.037, y - 0.06, y + 0.06, ...span(z, z + s * 0.004), false);
  for (const dy of [-0.026, 0.026]) {
    kit.block(g, m.slot, x - 0.018, x + 0.018, y + dy - 0.015, y + dy + 0.015, ...span(z + s * 0.004, z + s * 0.006), false);
  }
}

/** A row of reagent bottles centered on x, standing on y. */
function bottles(kit, g, m, rnd, x, y, z, count, maxH) {
  const specs = Array.from({ length: count }, () => ({
    r: 0.024 + rnd() * 0.02,
    h: Math.min(maxH, 0.1 + rnd() * 0.14),
    body: pick(rnd, m.liquids),
    cap: pick(rnd, m.caps),
    dz: (rnd() - 0.5) * 0.03,
  }));
  const width = specs.reduce((s, b) => s + 2 * b.r + 0.01, -0.01);
  let px = x - width / 2;
  for (const b of specs) {
    px += b.r;
    kit.cyl(g, b.body, b.r, b.h * 0.8, px, y, z + b.dz, { segments: 12, rTop: b.r * 0.9 });
    kit.cyl(g, b.cap, b.r * 0.42, b.h * 0.2, px, y + b.h * 0.8, z + b.dz, { segments: 10 });
    px += b.r + 0.01;
  }
}

/** Standing binders from x0 toward x1 on a shelf at y, backed against z0. */
function binders(kit, g, rnd, x0, x1, y, z0, depth, maxH) {
  let x = x0;
  while (x < x1 - 0.05) {
    const t = 0.04 + rnd() * 0.03;
    const h = Math.min(maxH, 0.24 + rnd() * 0.06);
    kit.block(g, kit.material(pick(rnd, BINDERS), { roughness: 0.7 }), x, x + t, y, y + h, z0, z0 + depth);
    x += t + 0.004;
  }
}

/** Steel shelf with front and back lips, spanning x0..x1 at y, centered on z. */
function lippedShelf(kit, g, mat, x0, x1, y, z, depth) {
  kit.block(g, mat, x0, x1, y, y + 0.016, z - depth / 2, z + depth / 2);
  kit.block(g, mat, x0, x1, y + 0.016, y + 0.05, z + depth / 2 - 0.008, z + depth / 2);
  kit.block(g, mat, x0, x1, y + 0.016, y + 0.05, z - depth / 2, z - depth / 2 + 0.008);
}

/** Small status display: screen plus one accent indicator, on a face at z facing +z. */
function display(kit, g, m, x0, x1, y0, y1, z) {
  kit.block(g, m.screen, x0, x1, y0, y1, z, z + 0.004, false);
  kit.block(g, m.status, x1 + 0.02, x1 + 0.032, y1 - 0.016, y1 - 0.004, z, z + 0.005, false);
}

// ---- 2D helpers ---------------------------------------------------------------------

function pen(ctx, o, weight = FINE, color = o.theme.line, dash = null) {
  ctx.lineWidth = weight * o.px;
  ctx.strokeStyle = color;
  ctx.setLineDash(dash ? dash.map((v) => v * o.px) : []);
}

function box(ctx, x0, y0, x1, y1) {
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
}

function line(ctx, ...p) {
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
  ctx.stroke();
}

function circle(ctx, x, y, r, fill) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.stroke();
}

function rounded(ctx, x0, y0, x1, y1, r) {
  ctx.beginPath();
  ctx.roundRect(x0, y0, x1 - x0, y1 - y0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2));
  ctx.stroke();
}

function outline(ctx, o) {
  pen(ctx, o, OUT);
  box(ctx, -o.w / 2, -o.d / 2, o.w / 2, o.d / 2);
}

/** True when the symbol is drawn large enough for small details to stay legible. */
const roomy = (o) => o.px < 1 / 40;

// ---- Island lab bench ---------------------------------------------------------------

function islandLayout(w, d) {
  const sinkW = clamp(w * 0.17, 0.35, 0.6);
  const sinkD = clamp(d * 0.3, 0.28, 0.46);
  const sink = { x0: w / 2 - 0.14 - sinkW, x1: w / 2 - 0.14, z0: -sinkD / 2, z1: sinkD / 2 };
  const faucetX = sink.x0 - 0.07;
  const sp0 = -w / 2 + 0.1, sp1 = faucetX - 0.07;
  return {
    sink, faucetX, reach: sink.x0 + sinkW / 2 - faucetX, sp0, sp1,
    spine: sp1 - sp0 > 0.4, spineW: 0.075, shelfD: Math.min(0.6, d * 0.4),
  };
}

function serviceSpine(kit, g, m, L, top, h, rnd) {
  const { sp0, sp1, spineW: sw, shelfD } = L;
  const sh = 0.24, ys = [top + (h - top) * 0.42, top + (h - top) * 0.76];
  kit.block(g, m.trim, sp0, sp1, top, top + sh, -sw, sw);
  kit.block(g, m.steel, sp0 - 0.004, sp1 + 0.004, top + sh, top + sh + 0.012, -sw - 0.004, sw + 0.004);
  const n = repeats(Math.floor((sp1 - sp0) / 1.1));
  for (let i = 0; i < n; i++) {
    const x = sp0 + ((i + 0.5) * (sp1 - sp0)) / n;
    outlet(kit, g, m, x, top + 0.13, sw, 1);
    outlet(kit, g, m, x, top + 0.13, -sw, -1);
  }
  for (const x of [sp0 + 0.12, sp1 - 0.12]) kit.cyl(g, m.chrome, 0.014, 0.05, x, top + sh + 0.012, 0, { segments: 10 });
  const posts = repeats(Math.ceil((sp1 - sp0) / 1.2) + 1, 2);
  for (let i = 0; i < posts; i++) {
    const x = sp0 + 0.03 + (i * (sp1 - sp0 - 0.06)) / (posts - 1);
    kit.block(g, m.steel, x - 0.016, x + 0.016, top + sh + 0.012, h - 0.01, -0.016, 0.016);
    for (const y of ys) kit.block(g, m.darkSteel, x - 0.012, x + 0.012, y - 0.04, y, -shelfD / 2 + 0.02, shelfD / 2 - 0.02);
  }
  for (const y of ys) lippedShelf(kit, g, m.steel, sp0, sp1, y, 0, shelfD);
  const len = sp1 - sp0;
  const clusters = repeats(Math.round(len / 1.6));
  for (const [k, y] of ys.entries()) {
    for (let c = 0; c < clusters; c++) {
      const x = sp0 + ((c + 0.3 + 0.4 * rnd()) * len) / clusters;
      const z = ((k + c) % 2 ? 1 : -1) * shelfD / 4;
      bottles(kit, g, m, rnd, x, y + 0.016, z, 3 + Math.floor(rnd() * 2), (h - top) * (k ? 0.2 : 0.26));
    }
  }
}

function buildIsland(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = palette(kit, color);
  const L = islandLayout(w, d);
  const top = Math.min(TOP, h), ct = top - TOP_T;
  const inset = 0.03, chase = 0.03, sinkDepth = 0.22;
  const runLen = w - 2 * inset - 2 * END_T;
  const depth = d / 2 - inset - chase;
  const n = moduleCount(runLen);
  const cutY = top - sinkDepth - 0.03;
  for (const side of [1, -1]) {
    const cut = side > 0
      ? { x0: L.sink.x0 - 0.02, x1: L.sink.x1 + 0.02, y: cutY }
      : { x0: -L.sink.x1 - 0.02, x1: -L.sink.x0 + 0.02, y: cutY };
    const run = cabinetRun(kit, m, runLen, depth, ct, { ends: false, cut, stack: n >= 3 ? 1 : -1 });
    run.position.z = side * (d / 2 - inset);
    if (side < 0) run.rotation.y = Math.PI;
    g.add(run);
  }
  for (const s of [-1, 1]) {
    const x = s * (w / 2 - inset);
    kit.block(g, m.case, Math.min(x, x - s * END_T), Math.max(x, x - s * END_T), 0, ct, -d / 2 + inset, d / 2 - inset);
  }
  slab(kit, g, m.top, -w / 2, w / 2, ct, top, -d / 2, d / 2, L.sink);
  basin(kit, g, m.steel, m.darkSteel, L.sink, top, sinkDepth);
  gooseneck(kit, g, m.chrome, L.faucetX, top, 0, Math.min(0.26, (h - top) * 0.25), L.reach, 0);
  if (L.spine) serviceSpine(kit, g, m, L, top, h, seq(Math.round(w * 100) + 7));
  return g;
}

function drawIsland(ctx, o) {
  const L = islandLayout(o.w, o.d);
  const { sink } = L;
  if (L.spine) {
    pen(ctx, o, FINE, o.theme.muted, DASH);
    box(ctx, L.sp0, -L.shelfD / 2, L.sp1, L.shelfD / 2);
  }
  pen(ctx, o);
  if (L.spine) box(ctx, L.sp0, -L.spineW, L.sp1, L.spineW);
  rounded(ctx, sink.x0, sink.z0, sink.x1, sink.z1, 0.04);
  circle(ctx, (sink.x0 + sink.x1) / 2, 0, 0.025);
  circle(ctx, L.faucetX, 0, 0.022);
  line(ctx, L.faucetX, 0, L.faucetX + L.reach, 0);
  outline(ctx, o);
}

// ---- Wall lab bench -----------------------------------------------------------------

const wallShelfDepth = (d) => Math.min(0.33, d * 0.45);
const hasCentrifuge = (w, d) => w >= 1.4 && d >= 0.5;

function benchCentrifuge(kit, g, m, x, y, z) {
  kit.block(g, m.white, x - 0.2, x + 0.2, y, y + 0.24, z - 0.22, z + 0.2);
  kit.block(g, m.trim, x - 0.19, x + 0.19, y + 0.24, y + 0.27, z - 0.21, z + 0.1);
  kit.cyl(g, m.darkSteel, 0.13, 0.006, x, y + 0.27, z - 0.055, { segments: 28 });
  kit.block(g, m.trim, x - 0.19, x + 0.19, y + 0.12, y + 0.24, z + 0.1, z + 0.2);
  display(kit, g, m, x - 0.12, x + 0.04, y + 0.15, y + 0.21, z + 0.2);
}

function buildWallBench(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = palette(kit, color);
  const rnd = seq(Math.round(w * 100) + 3);
  const top = Math.min(TOP, h), ct = top - TOP_T;
  const back = -d / 2, sd = wallShelfDepth(d);
  const n = moduleCount(w - 2 * END_T);
  const run = cabinetRun(kit, m, w - 0.01, d - 0.03 - 0.02, ct, { stack: n >= 2 ? 1 : -1 });
  run.position.z = d / 2 - 0.03;
  g.add(run);
  slab(kit, g, m.top, -w / 2, w / 2, ct, top, back, d / 2);
  kit.block(g, m.top, -w / 2, w / 2, top, top + 0.1, back, back + 0.019);
  const rw = Math.max(0.2, w - 0.1);
  kit.block(g, m.trim, -rw / 2, rw / 2, top + 0.17, top + 0.27, back, back + 0.045);
  const outlets = repeats(Math.floor(w / 0.9));
  for (let i = 0; i < outlets; i++) outlet(kit, g, m, -rw / 2 + ((i + 0.5) * rw) / outlets, top + 0.22, back + 0.045, 1);
  const ys = [top + (h - top) * 0.45, top + (h - top) * 0.8];
  const standards = repeats(Math.ceil(w / 1.2) + 1, 2);
  const sx = (i) => -w / 2 + 0.12 + (i * (w - 0.24)) / (standards - 1);
  for (let i = 0; i < standards; i++) {
    const x = sx(i);
    kit.block(g, m.darkSteel, x - 0.014, x + 0.014, top + 0.36, h - 0.02, back, back + 0.012);
    for (const y of ys) kit.block(g, m.darkSteel, x - 0.01, x + 0.01, y - 0.05, y, back + 0.012, back + sd - 0.03);
  }
  for (const [k, y] of ys.entries()) {
    kit.block(g, m.steel, -w / 2 + 0.03, w / 2 - 0.03, y, y + 0.018, back + 0.012, back + sd);
    kit.cyl(g, m.steel, 0.005, w - 0.08, 0, y + 0.07, back + sd - 0.012, { axis: 'x', segments: 6 });
    const clusters = repeats(Math.round(w / 1.3));
    for (let c = 0; c < clusters; c++) {
      const x = -w / 2 + ((c + 0.25 + 0.5 * rnd()) * w) / clusters;
      bottles(kit, g, m, rnd, x, y + 0.018, back + sd / 2, 3 + Math.floor(rnd() * 2), (ys[1] - ys[0]) * (k ? 0.6 : 0.7));
    }
  }
  if (hasCentrifuge(w, d)) benchCentrifuge(kit, g, m, w / 2 - 0.42, top, 0.02);
  return g;
}

function drawWallBench(ctx, o) {
  const sd = wallShelfDepth(o.d);
  pen(ctx, o, FINE, o.theme.muted, DASH);
  line(ctx, -o.w / 2, -o.d / 2 + sd, o.w / 2, -o.d / 2 + sd);
  pen(ctx, o);
  line(ctx, -o.w / 2, -o.d / 2 + 0.02, o.w / 2, -o.d / 2 + 0.02);
  if (hasCentrifuge(o.w, o.d)) box(ctx, o.w / 2 - 0.62, -0.2, o.w / 2 - 0.22, 0.22);
  outline(ctx, o);
}

// ---- Fume hood ----------------------------------------------------------------------

function hoodLayout(w, d, h) {
  const post = Math.min(0.15, w * 0.09);
  const bodyTop = h - 0.14;
  return { post, fz: d / 2 - 0.03, bodyTop, sashTop: bodyTop - 0.4, sash: TOP + 0.46, ductZ: -d * 0.1, ductR: 0.16 };
}

function buildFumeHood(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = palette(kit, color);
  const H = hoodLayout(w, d, h);
  const { post, fz, bodyTop, sashTop, sash } = H;
  const ix0 = -w / 2 + post, ix1 = w / 2 - post;
  const run = cabinetRun(kit, m, w, d - 0.05, TOP - TOP_T, { doorsOnly: true });
  run.position.z = d / 2 - 0.05;
  g.add(run);
  kit.block(g, m.top, -w / 2, w / 2, TOP - TOP_T, TOP, -d / 2, fz);
  kit.block(g, m.top, ix0, ix1, TOP, TOP + 0.012, fz - 0.1, fz - 0.07);
  kit.block(g, m.steel, ix0, ix1, TOP + 0.004, TOP + 0.03, fz - 0.06, fz);
  for (const s of [-1, 1]) {
    const [a, b] = s < 0 ? [-w / 2, ix0] : [ix1, w / 2];
    kit.block(g, m.body, a, b, TOP, bodyTop, -d / 2, fz);
    const x = (a + b) / 2;
    outlet(kit, g, m, x, TOP + 0.26, fz, 1);
    for (const y of [TOP + 0.48, TOP + 0.6]) kit.cyl(g, m.chrome, 0.016, 0.025, x, y, fz + 0.012, { axis: 'z', segments: 12 });
  }
  kit.block(g, m.body, ix0, ix1, sashTop, bodyTop, -d / 2, fz);
  kit.block(g, m.reveal, ix0, ix1, sashTop - 0.004, sashTop + 0.002, fz - 0.002, fz + 0.002, false);
  kit.block(g, m.lit, ix0, ix1, TOP, sashTop, -d / 2, -d / 2 + 0.08);
  for (const s of [-1, 1]) kit.block(g, m.lit, s < 0 ? ix0 : ix1 - 0.004, s < 0 ? ix0 + 0.004 : ix1, TOP, sashTop, -d / 2 + 0.08, fz - 0.08);
  for (const y of [TOP + 0.08, sashTop - 0.12]) kit.block(g, m.slot, ix0 + 0.08, ix1 - 0.08, y, y + 0.02, -d / 2 + 0.08, -d / 2 + 0.083, false);
  kit.block(g, m.led, ix0 + 0.1, ix1 - 0.1, sashTop - 0.012, sashTop, -d / 2 + 0.2, fz - 0.15, false);
  for (const s of [-1, 1]) {
    const x = s < 0 ? ix0 : ix1 - 0.03;
    kit.block(g, m.alu, x, x + 0.03, sash, sashTop, fz - 0.06, fz - 0.03);
  }
  kit.block(g, m.alu, ix0 + 0.03, ix1 - 0.03, sash, sash + 0.05, fz - 0.06, fz - 0.03);
  kit.block(g, m.darkSteel, ix0 + 0.15, ix1 - 0.15, sash + 0.012, sash + 0.03, fz - 0.03, fz);
  kit.block(g, kit.glass, ix0 + 0.03, ix1 - 0.03, sash + 0.05, sashTop + 0.02, fz - 0.05, fz - 0.044, false);
  display(kit, g, m, ix1 - 0.34, ix1 - 0.12, bodyTop - 0.22, bodyTop - 0.12, fz);
  kit.cyl(g, m.steel, 0.19, 0.03, 0, bodyTop, H.ductZ, { segments: 28 });
  kit.cyl(g, m.steel, H.ductR, h - bodyTop, 0, bodyTop, H.ductZ, { segments: 28 });
  return g;
}

function drawFumeHood(ctx, o) {
  const H = hoodLayout(o.w, o.d, o.h);
  const x0 = -o.w / 2 + H.post, x1 = o.w / 2 - H.post, y0 = -o.d / 2 + 0.08, y1 = H.fz - 0.047;
  pen(ctx, o);
  line(ctx, x0, y1, x0, y0, x1, y0, x1, y1);
  line(ctx, -o.w / 2, H.fz, o.w / 2, H.fz);
  pen(ctx, o, OUT, o.theme.glass);
  line(ctx, x0, y1, x1, y1);
  pen(ctx, o, FINE, o.theme.muted, DASH);
  circle(ctx, 0, H.ductZ, H.ductR);
  const k = H.ductR * 0.7;
  line(ctx, -k, H.ductZ - k, k, H.ductZ + k);
  line(ctx, -k, H.ductZ + k, k, H.ductZ - k);
  outline(ctx, o);
}

// ---- Biosafety cabinet --------------------------------------------------------------

const BSC = { stand: 0.74, deck: 0.96, side: 0.07, slope: 0.17, face: 1.12 };

function bscLayout(d) {
  const zf = d / 2 - 0.04;
  return { zf, zTop: zf - BSC.face * Math.sin(BSC.slope) };
}

function bscStand(kit, g, m, w, d) {
  const xs = [-w / 2 + 0.08, w / 2 - 0.08], zs = [-d / 2 + 0.1, d / 2 - 0.14];
  for (const x of xs) {
    for (const z of zs) {
      kit.block(g, m.darkSteel, x - 0.02, x + 0.02, 0.03, BSC.stand, z - 0.02, z + 0.02);
      kit.cyl(g, m.rubber, 0.024, 0.03, x, 0, z, { segments: 12 });
    }
    kit.block(g, m.darkSteel, x - 0.015, x + 0.015, 0.16, 0.19, zs[0], zs[1]);
  }
  kit.block(g, m.darkSteel, xs[0], xs[1], 0.16, 0.19, zs[0] - 0.015, zs[0] + 0.015);
  kit.block(g, m.darkSteel, xs[0] - 0.02, xs[1] + 0.02, BSC.stand - 0.04, BSC.stand, zs[1] - 0.02, zs[1] + 0.02);
}

function buildBiosafety(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = palette(kit, color);
  const { deck, side, slope, face } = BSC;
  const { zf, zTop } = bscLayout(d);
  const ix0 = -w / 2 + side, ix1 = w / 2 - side;
  const ceil = deck + face * Math.cos(slope) - 0.04;
  bscStand(kit, g, m, w, d);
  kit.block(g, m.body, -w / 2, w / 2, BSC.stand, deck - 0.02, -d / 2, zf);
  kit.block(g, m.steel, ix0, ix1, deck - 0.02, deck, -d / 2 + 0.05, zf - 0.08);
  kit.block(g, m.darkSteel, ix0, ix1, deck - 0.02, deck + 0.002, zf - 0.08, zf - 0.03);
  kit.cyl(g, m.steel, 0.026, ix1 - ix0, 0, deck, zf - 0.008, { axis: 'x', segments: 16 });
  kit.block(g, m.body, -w / 2, w / 2, deck - 0.02, h, -d / 2, -d / 2 + 0.05);
  kit.block(g, m.lit, ix0, ix1, deck, ceil, -d / 2 + 0.05, -d / 2 + 0.056);
  kit.block(g, m.slot, ix0 + 0.02, ix1 - 0.02, deck + 0.015, deck + 0.055, -d / 2 + 0.056, -d / 2 + 0.06, false);
  for (const s of [-1, 1]) {
    kit.block(g, m.body, s < 0 ? -w / 2 : ix1, s < 0 ? ix0 : w / 2, deck - 0.02, h, -d / 2, zTop);
    kit.block(g, m.lit, s < 0 ? ix0 : ix1 - 0.004, s < 0 ? ix0 + 0.004 : ix1, deck, ceil, -d / 2 + 0.05, zTop);
  }
  kit.block(g, m.body, -w / 2, w / 2, ceil, h, -d / 2, zTop);
  kit.block(g, m.led, ix0 + 0.08, ix1 - 0.08, ceil - 0.015, ceil, -d / 2 + 0.1, zTop - 0.1, false);
  const f = sub(kit, g, 0, deck, zf, { pitch: -slope });
  for (const s of [-1, 1]) kit.block(f, m.body, s < 0 ? -w / 2 + 0.001 : ix1, s < 0 ? ix0 : w / 2 - 0.001, 0, face, -0.26, 0);
  kit.block(f, m.alu, ix0, ix1, 0.24, 0.29, -0.035, 0);
  kit.block(f, kit.glass, ix0, ix1, 0.29, 0.8, -0.024, -0.018, false);
  kit.block(f, m.body, ix0, ix1, 0.78, face, -0.22, 0);
  kit.block(f, m.reveal, ix0, ix1, 0.776, 0.784, -0.002, 0.002, false);
  kit.block(f, kit.material('#2d6a93', { roughness: 0.5 }), -w / 2 + 0.001, w / 2 - 0.001, 0.97, 1.03, 0, 0.004);
  display(kit, f, m, ix1 - 0.34, ix1 - 0.1, 0.83, 0.92, 0);
  return g;
}

function drawBiosafety(ctx, o) {
  const { zf, zTop } = bscLayout(o.d);
  const x0 = -o.w / 2 + BSC.side, x1 = o.w / 2 - BSC.side, y0 = -o.d / 2 + 0.05;
  ctx.fillStyle = o.theme.light;
  ctx.fillRect(x0, y0, x1 - x0, 0.14);
  pen(ctx, o);
  box(ctx, x0, y0, x1, zf - 0.03);
  if (roomy(o)) {
    pen(ctx, o, FINE, o.theme.muted);
    for (let x = x0 + 0.06; x < x1 - 0.03; x += 0.06) line(ctx, x, y0, x, y0 + 0.14);
  }
  pen(ctx, o, FINE, o.theme.glass);
  line(ctx, x0, zTop, x1, zTop);
  pen(ctx, o, OUT, o.theme.glass);
  line(ctx, x0, zf - 0.03, x1, zf - 0.03);
  outline(ctx, o);
}

// ---- Ultra-low freezer --------------------------------------------------------------

function buildUltFreezer(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = palette(kit, color);
  const fz = d / 2 - 0.08;
  const dy0 = 0.37, dy1 = h - 0.3;
  kit.block(g, m.plinth, -w / 2 + 0.03, w / 2 - 0.03, 0, 0.08, -d / 2 + 0.03, fz - 0.02);
  kit.block(g, m.body, -w / 2, w / 2, 0.08, h, -d / 2, fz);
  kit.block(g, m.trim, -w / 2 + 0.01, w / 2 - 0.01, 0.1, 0.34, fz, fz + 0.01);
  for (let i = 0; i < 4; i++) {
    const y = 0.14 + i * 0.045;
    kit.block(g, m.slot, -w / 2 + 0.08, w / 2 - 0.08, y, y + 0.02, fz + 0.01, fz + 0.012, false);
  }
  kit.block(g, m.reveal, -w / 2 + 0.006, w / 2 - 0.006, dy0 - 0.006, dy1 + 0.006, fz, fz + 0.006);
  kit.block(g, m.body, -w / 2 + 0.012, w / 2 - 0.012, dy0, dy1, fz + 0.006, fz + 0.05);
  if (!m.custom) kit.block(g, m.trim, -w / 2 + 0.06, w / 2 - 0.16, dy0 + 0.08, dy1 - 0.08, fz + 0.05, fz + 0.052, false);
  for (const y of [dy0 + 0.12, dy1 - 0.12]) kit.block(g, m.trim, -w / 2 + 0.004, -w / 2 + 0.04, y - 0.05, y + 0.05, fz + 0.006, fz + 0.054);
  const hx = w / 2 - 0.085, hy = (dy0 + dy1) / 2 + 0.05;
  kit.block(g, m.darkSteel, hx - 0.03, hx + 0.03, hy - 0.2, hy + 0.2, fz + 0.05, fz + 0.062);
  kit.block(g, m.chrome, hx - 0.014, hx + 0.014, hy - 0.17, hy + 0.17, fz + 0.062, fz + 0.078);
  kit.cyl(g, m.chrome, 0.012, 0.01, hx, hy + 0.24, fz + 0.055, { axis: 'z', segments: 12 });
  kit.block(g, m.trim, -w / 2 + 0.01, w / 2 - 0.01, h - 0.27, h - 0.02, fz, fz + 0.02);
  display(kit, g, m, -w / 2 + 0.08, -w / 2 + 0.32, h - 0.2, h - 0.08, fz + 0.02);
  for (let i = 0; i < 3; i++) {
    const x = w / 2 - 0.3 + i * 0.07;
    kit.block(g, m.darkSteel, x, x + 0.045, h - 0.16, h - 0.13, fz + 0.02, fz + 0.026, false);
  }
  return g;
}

function snowflake(ctx, x, y, r) {
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI) / 3 + Math.PI / 2;
    line(ctx, x - r * Math.cos(a), y - r * Math.sin(a), x + r * Math.cos(a), y + r * Math.sin(a));
  }
}

function drawUltFreezer(ctx, o) {
  const fz = o.d / 2 - 0.08;
  pen(ctx, o);
  line(ctx, -o.w / 2, fz, o.w / 2, fz);
  box(ctx, o.w / 2 - 0.115, fz + 0.03, o.w / 2 - 0.055, fz + 0.075);
  pen(ctx, o, FINE, o.theme.muted);
  snowflake(ctx, 0, -0.04, Math.min(o.w, o.d) * 0.17);
  outline(ctx, o);
}

// ---- Lab refrigerator ---------------------------------------------------------------

function buildLabFridge(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = palette(kit, color);
  const rnd = seq(41);
  const fz = d / 2 - 0.06, t = 0.045, base = 0.16, cap = 0.15;
  const y0 = base, y1 = h - cap, ix0 = -w / 2 + t, ix1 = w / 2 - t;
  kit.block(g, m.plinth, -w / 2 + 0.02, w / 2 - 0.02, 0, 0.04, -d / 2 + 0.02, fz - 0.02);
  kit.block(g, m.body, -w / 2, w / 2, 0.04, y0, -d / 2, fz);
  kit.block(g, m.slot, -w / 2 + 0.06, w / 2 - 0.06, 0.06, y0 - 0.03, fz, fz + 0.003, false);
  for (let i = 1; i < 4; i++) {
    const y = 0.06 + (i * (y0 - 0.09)) / 4;
    kit.block(g, m.body, -w / 2 + 0.06, w / 2 - 0.06, y - 0.006, y + 0.006, fz, fz + 0.005, false);
  }
  kit.block(g, m.body, -w / 2, w / 2, y1, h, -d / 2, fz);
  for (const s of [-1, 1]) {
    kit.block(g, m.body, s < 0 ? -w / 2 : ix1, s < 0 ? ix0 : w / 2, y0, y1, -d / 2, fz);
    kit.block(g, m.lit, s < 0 ? ix0 : ix1 - 0.004, s < 0 ? ix0 + 0.004 : ix1, y0, y1, -d / 2 + t, fz);
  }
  kit.block(g, m.body, ix0, ix1, y0, y1, -d / 2, -d / 2 + t);
  kit.block(g, m.lit, ix0, ix1, y0, y1, -d / 2 + t, -d / 2 + t + 0.004);
  kit.block(g, m.lit, ix0, ix1, y0, y0 + 0.02, -d / 2 + t, fz);
  kit.block(g, m.led, ix0 + 0.04, ix1 - 0.04, y1 - 0.012, y1, -d / 2 + 0.1, fz - 0.12, false);
  const levels = 5;
  for (let k = 0; k < levels; k++) {
    const y = y0 + 0.02 + (k * (y1 - y0 - 0.02)) / levels;
    if (k > 0) {
      kit.block(g, m.steel, ix0, ix1, y - 0.01, y, -d / 2 + t + 0.02, fz - 0.06);
      kit.cyl(g, m.steel, 0.005, ix1 - ix0, 0, y + 0.02, fz - 0.065, { axis: 'x', segments: 6 });
    }
    const room = (y1 - y0) / levels - 0.06;
    bottles(kit, g, m, rnd, (rnd() - 0.5) * 0.1, y, -0.15, 5, room);
    if (k % 2) kit.block(g, m.plate, ix0 + 0.04, ix0 + 0.3, y, y + Math.min(0.1, room), -0.02, 0.16);
    else bottles(kit, g, m, rnd, (rnd() - 0.5) * 0.1, y, 0.06, 4, room * 0.8);
  }
  const frame = m.trim;
  for (const s of [-1, 1]) kit.block(g, frame, s < 0 ? -w / 2 : w / 2 - 0.06, s < 0 ? -w / 2 + 0.06 : w / 2, y0 + 0.004, y1 - 0.004, fz, fz + 0.035);
  kit.block(g, frame, -w / 2 + 0.06, w / 2 - 0.06, y1 - 0.074, y1 - 0.004, fz, fz + 0.035);
  kit.block(g, frame, -w / 2 + 0.06, w / 2 - 0.06, y0 + 0.004, y0 + 0.09, fz, fz + 0.035);
  kit.block(g, kit.glass, -w / 2 + 0.06, w / 2 - 0.06, y0 + 0.09, y1 - 0.074, fz + 0.014, fz + 0.02, false);
  const gx = w / 2 - 0.06, gz0 = fz + 0.035, gz1 = fz + 0.037;
  for (const s of [-1, 1]) kit.block(g, m.plinth, s * gx - 0.008, s * gx + 0.008, y0 + 0.09, y1 - 0.074, gz0, gz1, false);
  for (const y of [y0 + 0.09, y1 - 0.074]) kit.block(g, m.plinth, -gx, gx, y - 0.008, y + 0.008, gz0, gz1, false);
  const hx = -w / 2 + 0.03;
  for (const y of [0.78, 1.42]) kit.block(g, m.steel, hx - 0.008, hx + 0.008, y - 0.015, y + 0.015, fz + 0.035, fz + 0.05);
  kit.block(g, m.steel, hx - 0.011, hx + 0.011, 0.74, 1.46, fz + 0.05, fz + 0.06);
  display(kit, g, m, w / 2 - 0.3, w / 2 - 0.12, h - 0.11, h - 0.05, fz);
  return g;
}

function drawLabFridge(ctx, o) {
  const fz = o.d / 2 - 0.06, t = 0.045;
  pen(ctx, o, FINE, o.theme.muted, DASH);
  box(ctx, -o.w / 2 + t, -o.d / 2 + t, o.w / 2 - t, fz - 0.03);
  pen(ctx, o);
  line(ctx, -o.w / 2, fz, o.w / 2, fz);
  box(ctx, -o.w / 2 + 0.015, fz + 0.035, -o.w / 2 + 0.045, fz + 0.06);
  pen(ctx, o, OUT, o.theme.glass);
  line(ctx, -o.w / 2 + 0.06, fz + 0.017, o.w / 2 - 0.06, fz + 0.017);
  outline(ctx, o);
}

// ---- Tall storage cabinet -----------------------------------------------------------

function tallLayout(w, d, h) {
  const fz = d / 2 - 0.02;
  return { fz, split: clamp(h * 0.44, 0.6, 1.1), inner: [-w / 2 + END_T, w / 2 - END_T] };
}

/** Framed glass door with its front face at z = 0. */
function glassDoor(kit, g, m, x0, x1, y0, y1) {
  const s = 0.055;
  kit.block(g, m.door, x0, x0 + s, y0, y1, -FRONT_T, 0);
  kit.block(g, m.door, x1 - s, x1, y0, y1, -FRONT_T, 0);
  kit.block(g, m.door, x0 + s, x1 - s, y0, y0 + s, -FRONT_T, 0);
  kit.block(g, m.door, x0 + s, x1 - s, y1 - s, y1, -FRONT_T, 0);
  kit.block(g, kit.glass, x0 + s, x1 - s, y0 + s, y1 - s, -0.011, -0.007, false);
}

function buildTallCabinet(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = palette(kit, color);
  const rnd = seq(17);
  const { fz, split, inner: [ix0, ix1] } = tallLayout(w, d, h);
  const back = fz - FRONT_T - 0.004;
  const cx = (ix0 + ix1) / 2;
  kit.block(g, m.plinth, ix0, ix1, 0, TOE, -d / 2 + 0.02, fz - 0.06);
  for (const s of [-1, 1]) kit.block(g, m.case, s < 0 ? -w / 2 : ix1, s < 0 ? ix0 : w / 2, 0, h, -d / 2, fz);
  kit.block(g, m.case, ix0, ix1, TOE, split, -d / 2, back);
  kit.block(g, m.reveal, ix0, ix1, TOE, split, back, fz - FRONT_T, false);
  kit.block(g, m.case, ix0, ix1, h - END_T, h, -d / 2, back);
  kit.block(g, m.interior, ix0, ix1, split, h - END_T, -d / 2, -d / 2 + END_T);
  const shelves = [split + (h - split) * 0.36, split + (h - split) * 0.68];
  for (const y of shelves) kit.block(g, m.case, ix0, ix1, y, y + END_T, -d / 2 + END_T, back - 0.02);
  const zBack = -d / 2 + END_T;
  const room = (h - split) * 0.3;
  bottles(kit, g, m, rnd, ix0 + (ix1 - ix0) * 0.3, split, zBack + 0.14, 5, room);
  kit.block(g, m.plate, ix1 - 0.34, ix1 - 0.06, split, split + 0.18, zBack + 0.04, zBack + 0.32);
  binders(kit, g, rnd, ix0 + 0.03, ix0 + (ix1 - ix0) * 0.55, shelves[0] + END_T, zBack + 0.02, 0.26, room);
  bottles(kit, g, m, rnd, ix1 - (ix1 - ix0) * 0.25, shelves[0] + END_T, zBack + 0.14, 4, room);
  bottles(kit, g, m, rnd, cx, shelves[1] + END_T, zBack + 0.14, 6, room);
  const doors = sub(kit, g, 0, 0, fz);
  for (const [a, b, s] of [[ix0, cx, 1], [cx, ix1, -1]]) {
    front(kit, doors, m.door, a, b, TOE, split);
    pull(kit, doors, m.pull, cx - s * 0.04, split - 0.14, true, 0.14);
    glassDoor(kit, doors, m, a + GAP, b - GAP, split + GAP, h - GAP);
    pull(kit, doors, m.pull, cx - s * 0.04, split + 0.14, true, 0.12);
  }
  return g;
}

function drawTallCabinet(ctx, o) {
  const { fz, inner: [ix0, ix1] } = tallLayout(o.w, o.d, o.h);
  const yb = fz - FRONT_T;
  pen(ctx, o, FINE, o.theme.muted);
  line(ctx, ix0, -o.d / 2 + END_T, ix1, yb);
  pen(ctx, o);
  line(ctx, ix0, -o.d / 2, ix0, yb);
  line(ctx, ix1, -o.d / 2, ix1, yb);
  box(ctx, ix0, yb, ix1, fz);
  line(ctx, (ix0 + ix1) / 2, yb, (ix0 + ix1) / 2, fz);
  outline(ctx, o);
}

// ---- Lab sink with eyewash ----------------------------------------------------------

function sinkLayout(w, d) {
  const x0 = -w / 2 + 0.12;
  const hole = { x0, x1: Math.min(w / 2 - 0.45, x0 + 0.6), z0: -d / 2 + 0.17, z1: d / 2 - 0.12 };
  const faucetZ = -d / 2 + 0.08;
  return {
    hole, faucetZ,
    reach: Math.min(0.17, hole.z1 - faucetZ - 0.1),
    eye: { x: w / 2 - 0.2, z: 0.02, r: 0.13 },
  };
}

function eyewash(kit, g, m, x, y, z, r) {
  kit.cyl(g, m.chrome, 0.02, 0.08, x, y, z, { segments: 12 });
  kit.cyl(g, m.yellow, r * 0.45, 0.06, x, y + 0.08, z, { rTop: r, segments: 28 });
  kit.cyl(g, kit.material('#c9a52e', { roughness: 0.6 }), r * 0.88, 0.003, x, y + 0.14, z, { segments: 28 });
  for (const s of [-1, 1]) {
    kit.cyl(g, m.chrome, 0.013, 0.03, x + s * 0.045, y + 0.12, z, { segments: 10 });
    kit.cyl(g, m.status, 0.019, 0.008, x + s * 0.045, y + 0.15, z, { segments: 12 });
  }
  kit.block(g, m.yellow, x - 0.035, x + 0.035, y + 0.085, y + 0.135, z + r + 0.002, z + r + 0.01);
}

function buildLabSink(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = palette(kit, color);
  const S = sinkLayout(w, d);
  const top = TOP, ct = top - TOP_T, depth = 0.25;
  // The pocket under the bowl stops short of the back panel, so the back stays closed.
  const zr = d / 2 - 0.03, { hole } = S;
  const cut = { x0: hole.x0 - 0.02, x1: hole.x1 + 0.02, z0: hole.z0 - 0.02 - zr, z1: hole.z1 + 0.02 - zr, y: top - depth - 0.03 };
  const run = cabinetRun(kit, m, w, d - 0.05, ct, { cut });
  run.position.z = zr;
  g.add(run);
  slab(kit, g, m.top, -w / 2, w / 2, ct, top, -d / 2, d / 2, S.hole);
  kit.block(g, m.top, -w / 2, w / 2, top, top + 0.1, -d / 2, -d / 2 + 0.019);
  basin(kit, g, m.basin, m.darkSteel, S.hole, top, depth);
  const cx = (S.hole.x0 + S.hole.x1) / 2;
  const rise = Math.max(0.06, h - top - 0.1);
  gooseneck(kit, g, m.chrome, cx, top, S.faucetZ, rise, S.reach, -Math.PI / 2);
  eyewash(kit, g, m, S.eye.x, top, S.eye.z, S.eye.r);
  return g;
}

function drawLabSink(ctx, o) {
  const S = sinkLayout(o.w, o.d);
  const { hole, eye } = S;
  const cx = (hole.x0 + hole.x1) / 2;
  pen(ctx, o);
  line(ctx, -o.w / 2, -o.d / 2 + 0.02, o.w / 2, -o.d / 2 + 0.02);
  rounded(ctx, hole.x0, hole.z0, hole.x1, hole.z1, 0.04);
  circle(ctx, cx, (hole.z0 + hole.z1) / 2, 0.025);
  circle(ctx, cx, S.faucetZ, 0.022);
  line(ctx, cx, S.faucetZ, cx, S.faucetZ + S.reach);
  circle(ctx, eye.x, eye.z, eye.r);
  line(ctx, eye.x - 0.05, eye.z + eye.r + 0.012, eye.x + 0.05, eye.z + eye.r + 0.012);
  if (roomy(o)) for (const s of [-1, 1]) circle(ctx, eye.x + s * 0.045, eye.z, 0.016);
  outline(ctx, o);
}

// ---- Safety shower ------------------------------------------------------------------

function showerLayout(d, h) {
  const pz = -d / 2 + 0.085;
  return { pz, armY: h - 0.07, valveZ: pz + 0.16, handleX: 0.2, head: 0.14 };
}

function buildSafetyShower(kit, { w, d, h }) {
  const g = kit.group();
  const m = palette(kit);
  const S = showerLayout(d, h);
  const { pz, armY, valveZ, handleX: hx } = S;
  const plate = Math.min(0.2, w * 0.22);
  kit.block(g, m.steel, -plate, plate, 0, 0.006, -plate, plate);
  for (let i = 0; i < 5; i++) {
    const x = -plate * 0.6 + (i * plate * 1.2) / 4;
    kit.block(g, m.slot, x - 0.01, x + 0.01, 0.006, 0.007, -plate * 0.7, plate * 0.7, false);
  }
  kit.cyl(g, m.yellow, 0.075, 0.02, 0, 0, pz, { segments: 20 });
  kit.cyl(g, m.yellow, 0.03, armY - 0.02, 0, 0.02, pz, { segments: 16 });
  kit.sphere(g, m.yellow, 0.036, 0, armY, pz);
  kit.cyl(g, m.yellow, 0.028, -pz, 0, armY, pz / 2, { axis: 'z', segments: 16 });
  kit.sphere(g, m.yellow, 0.034, 0, armY, 0);
  kit.cyl(g, m.yellow, 0.026, 0.07, 0, armY - 0.07, 0, { segments: 14 });
  kit.cyl(g, m.yellow, S.head, 0.09, 0, armY - 0.16, 0, { rTop: 0.045, segments: 28 });
  kit.cyl(g, kit.material('#9aa1a5', { roughness: 0.5 }), S.head - 0.01, 0.006, 0, armY - 0.166, 0, { segments: 28 });
  kit.block(g, m.chrome, -0.035, 0.035, armY - 0.045, armY + 0.04, valveZ - 0.04, valveZ + 0.04);
  kit.block(g, m.steel, 0, hx + 0.01, armY - 0.012, armY + 0.008, valveZ - 0.01, valveZ + 0.01);
  const rodBottom = 1.78;
  kit.cyl(g, m.steel, 0.006, armY - rodBottom, hx, rodBottom, valveZ, { segments: 8 });
  const tri = [[hx, rodBottom, valveZ], [hx - 0.1, rodBottom - 0.2, valveZ], [hx + 0.1, rodBottom - 0.2, valveZ]];
  for (let i = 0; i < 3; i++) rod(kit, g, m.yellow, 0.011, tri[i], tri[(i + 1) % 3], { over: 0.02 });
  const sign = kit.material('#1f7a4d', { roughness: 0.55 });
  const sz = pz + 0.03, sy = 1.98;
  kit.block(g, sign, -0.11, 0.11, sy - 0.11, sy + 0.11, sz, sz + 0.006);
  kit.block(g, m.plate, -0.06, 0.06, sy + 0.055, sy + 0.075, sz + 0.006, sz + 0.009, false);
  for (const x of [-0.04, 0, 0.04]) kit.block(g, m.plate, x - 0.006, x + 0.006, sy - 0.07, sy + 0.035, sz + 0.006, sz + 0.009, false);
  return g;
}

function drawSafetyShower(ctx, o) {
  const S = showerLayout(o.d, o.h);
  const plate = Math.min(0.2, o.w * 0.22);
  pen(ctx, o, FINE, o.theme.muted);
  box(ctx, -plate, -plate, plate, plate);
  if (roomy(o)) for (const y of [-plate * 0.5, 0, plate * 0.5]) line(ctx, -plate * 0.6, y, plate * 0.6, y);
  pen(ctx, o, FINE, o.theme.line, DASH);
  circle(ctx, 0, 0, S.head);
  line(ctx, 0, S.pz, 0, -S.head);
  pen(ctx, o);
  line(ctx, S.handleX - 0.1, S.valveZ, S.handleX + 0.1, S.valveZ);
  circle(ctx, 0, S.pz, 0.03, o.theme.line);
  outline(ctx, o);
}

// ---- Lab stool ----------------------------------------------------------------------

function buildLabStool(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = palette(kit, color);
  const seat = m.custom || kit.material('#2e3b3e', { roughness: 0.55 });
  const reach = Math.min(w, d) / 2 - 0.025;
  const sy = h - 0.09, ringY = h * 0.4;
  kit.cyl(g, m.black, 0.045, 0.05, 0, 0.035, 0, { segments: 16 });
  for (let i = 0; i < 5; i++) {
    const leg = sub(kit, g, 0, 0, 0, { yaw: (i * Math.PI * 2) / 5 + Math.PI / 2 });
    kit.block(leg, m.black, 0.03, reach, 0.04, 0.068, -0.016, 0.016);
    kit.cyl(leg, m.rubber, 0.022, 0.04, reach - 0.012, 0, 0, { segments: 12 });
  }
  kit.cyl(g, m.black, 0.03, ringY - 0.07, 0, 0.07, 0, { segments: 14 });
  kit.cyl(g, m.chrome, 0.022, sy - ringY + 0.02, 0, ringY - 0.02, 0, { segments: 14 });
  kit.cyl(g, m.black, 0.042, 0.03, 0, ringY - 0.015, 0, { segments: 16 });
  kit.torus(g, m.chrome, 0.165, 0.011, 0, ringY, 0);
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI * 2) / 3 + Math.PI / 6;
    rod(kit, g, m.chrome, 0.008, [0.04 * Math.cos(a), ringY, 0.04 * Math.sin(a)], [0.16 * Math.cos(a), ringY, 0.16 * Math.sin(a)]);
  }
  kit.cyl(g, m.black, 0.11, 0.025, 0, sy, 0, { segments: 20 });
  kit.block(g, m.black, 0.06, 0.17, sy + 0.004, sy + 0.014, -0.008, 0.008);
  kit.cyl(g, seat, 0.178, 0.055, 0, sy + 0.025, 0, { rTop: 0.19, segments: 32 });
  kit.sphere(g, seat, 0.19, 0, sy + 0.08, 0, { segments: 32, scaleY: 0.05 });
  return g;
}

function drawLabStool(ctx, o) {
  const reach = Math.min(o.w, o.d) / 2 - 0.02;
  pen(ctx, o, FINE, o.theme.muted);
  for (let i = 0; i < 5; i++) {
    const a = (i * Math.PI * 2) / 5 - Math.PI / 2;
    line(ctx, 0, 0, reach * Math.cos(a), -reach * Math.sin(a));
    if (roomy(o)) circle(ctx, (reach - 0.012) * Math.cos(a), -(reach - 0.012) * Math.sin(a), 0.018);
  }
  pen(ctx, o, OUT);
  circle(ctx, 0, 0, 0.19, o.theme.fill);
  pen(ctx, o);
  circle(ctx, 0, 0, 0.155);
}

// ---- Equipment cart -----------------------------------------------------------------

function cartLayout(w, d) {
  const x0 = -w / 2 + 0.07, x1 = w / 2 - 0.01, z0 = -d / 2 + 0.01, z1 = d / 2 - 0.01;
  return { x0, x1, z0, z1, xs: [x0 + 0.025, x1 - 0.025], zs: [z0 + 0.025, z1 - 0.025] };
}

function tray(kit, g, mat, x0, x1, y, z0, z1) {
  kit.block(g, mat, x0, x1, y, y + 0.02, z0, z1);
  for (const z of [z0, z1 - 0.012]) kit.block(g, mat, x0, x1, y + 0.02, y + 0.05, z, z + 0.012);
  for (const x of [x0, x1 - 0.012]) kit.block(g, mat, x, x + 0.012, y + 0.02, y + 0.05, z0 + 0.012, z1 - 0.012);
}

/** Benchtop analyzer with a small terminal beside it, standing on y. */
function cartInstrument(kit, g, m, x, y, h) {
  kit.block(g, m.white, x - 0.3, x + 0.1, y, y + 0.15, -0.2, 0.1);
  kit.block(g, m.trim, x - 0.29, x + 0.09, y + 0.15, y + 0.162, -0.19, 0.09);
  kit.block(g, m.slot, x - 0.27, x - 0.05, y + 0.035, y + 0.095, 0.1, 0.103, false);
  kit.block(g, m.trim, x - 0.26, x - 0.06, y + 0.045, y + 0.085, 0.1, 0.112);
  display(kit, g, m, x - 0.02, x + 0.05, y + 0.07, y + 0.12, 0.1);
  const tx = x + 0.27, sh = Math.min(0.13, h - y - 0.05);
  kit.block(g, m.darkSteel, tx - 0.06, tx + 0.06, y, y + 0.01, -0.12, -0.01);
  kit.block(g, m.darkSteel, tx - 0.012, tx + 0.012, y + 0.01, y + 0.06, -0.08, -0.06);
  const s = sub(kit, g, tx, y + 0.035, -0.055, { pitch: -0.15 });
  kit.block(s, m.black, -0.13, 0.13, 0, sh, -0.012, 0);
  kit.block(s, m.screen, -0.12, 0.12, 0.01, sh - 0.01, 0, 0.003, false);
}

function buildCart(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = palette(kit, color);
  const C = cartLayout(w, d);
  const shelf = m.custom || m.steel;
  const top = h - 0.2;
  for (const x of C.xs) {
    for (const z of C.zs) {
      kit.cyl(g, m.rubber, 0.035, 0.025, x, 0.04, z, { axis: 'z', segments: 16 });
      kit.block(g, m.darkSteel, x - 0.025, x + 0.025, 0.075, 0.1, z - 0.02, z + 0.02);
      kit.block(g, m.steel, x - 0.014, x + 0.014, 0.1, x < 0 ? h - 0.06 : top + 0.05, z - 0.014, z + 0.014);
    }
  }
  tray(kit, g, shelf, C.x0, C.x1, 0.22, C.z0, C.z1);
  tray(kit, g, shelf, C.x0, C.x1, top, C.z0, C.z1);
  const gx = -w / 2 + 0.02, gy = h - 0.08;
  for (const z of C.zs) kit.cyl(g, m.steel, 0.011, C.xs[0] - gx, (gx + C.xs[0]) / 2, gy, z, { axis: 'x', segments: 10 });
  kit.cyl(g, m.black, 0.016, C.zs[1] - C.zs[0] + 0.04, gx, gy, 0, { axis: 'z', segments: 14 });
  cartInstrument(kit, g, m, (C.x0 + C.x1) / 2, top + 0.02, h);
  const bin = kit.material('#80bbad', { roughness: 0.55 });
  kit.block(g, bin, C.x0 + 0.06, C.x0 + 0.32, 0.24, 0.36, C.z0 + 0.1, C.z1 - 0.12);
  kit.block(g, kit.mat.cardboard, C.x1 - 0.3, C.x1 - 0.08, 0.24, 0.39, C.z0 + 0.12, C.z1 - 0.16);
  return g;
}

function drawCart(ctx, o) {
  const C = cartLayout(o.w, o.d);
  const dx = (C.x0 + C.x1) / 2;
  pen(ctx, o);
  box(ctx, C.x0, C.z0, C.x1, C.z1);
  box(ctx, dx - 0.3, -0.2, dx + 0.1, 0.1);
  box(ctx, dx + 0.14, -0.07, dx + 0.4, -0.04);
  const gx = -o.w / 2 + 0.02;
  line(ctx, gx, C.zs[0] - 0.02, gx, C.zs[1] + 0.02);
  for (const z of C.zs) line(ctx, gx, z, C.x0, z);
  if (roomy(o)) {
    pen(ctx, o, FINE, o.theme.muted);
    for (const x of C.xs) for (const z of C.zs) circle(ctx, x, z, 0.02);
  }
  outline(ctx, o);
}

// ---- Autoclave ----------------------------------------------------------------------

function autoclaveLayout(w, d, h) {
  return { fz: d / 2 - 0.1, cy: (0.44 + h - 0.34) / 2, R: Math.min(0.3, w * 0.33) };
}

function buildAutoclave(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = palette(kit, color);
  const { fz, cy, R } = autoclaveLayout(w, d, h);
  const fascia = m.custom || kit.material('#e4e8e9', { roughness: 0.35, metalness: 0.25 });
  const dark = kit.material('#2b3236', { roughness: 0.3 });
  const fp = fz + 0.012;
  kit.block(g, m.plinth, -w / 2 + 0.03, w / 2 - 0.03, 0, 0.08, -d / 2 + 0.03, fz - 0.02);
  kit.block(g, m.steel, -w / 2, w / 2, 0.08, h, -d / 2, fz);
  kit.block(g, fascia, -w / 2 + 0.012, w / 2 - 0.012, 0.1, 0.42, fz, fp);
  for (let i = 0; i < 4; i++) {
    const y = 0.17 + i * 0.05;
    kit.block(g, m.slot, -w / 2 + 0.1, w / 2 - 0.1, y, y + 0.018, fp, fp + 0.002, false);
  }
  kit.block(g, fascia, -w / 2 + 0.012, w / 2 - 0.012, 0.44, h - 0.34, fz, fp);
  kit.block(g, dark, -w / 2 + 0.012, w / 2 - 0.012, h - 0.32, h - 0.02, fz, fp);
  kit.torus(g, m.darkSteel, R + 0.012, 0.018, 0, cy, fp + 0.006, { axis: 'z' });
  kit.cyl(g, m.steel, R, 0.05, 0, cy, fp + 0.025, { axis: 'z', segments: 40 });
  kit.cyl(g, kit.mat.chrome, R * 0.78, 0.006, 0, cy, fp + 0.053, { axis: 'z', segments: 40 });
  kit.cyl(g, m.darkSteel, 0.06, 0.03, 0, cy, fp + 0.065, { axis: 'z', segments: 20 });
  for (let i = 0; i < 3; i++) {
    const spoke = sub(kit, g, 0, cy, fp + 0.064, { roll: (i * Math.PI * 2) / 3 });
    kit.block(spoke, m.chrome, -0.01, 0.01, 0.05, R * 0.72, -0.008, 0.008);
    kit.sphere(spoke, m.black, 0.02, 0, R * 0.72, 0, { segments: 14 });
  }
  kit.block(g, m.darkSteel, -R - 0.07, -R + 0.03, cy - 0.07, cy + 0.07, fp, fp + 0.045);
  display(kit, g, m, -w / 2 + 0.09, -w / 2 + 0.37, h - 0.25, h - 0.1, fp);
  for (let i = 0; i < 3; i++) {
    const x = -w / 2 + 0.44 + i * 0.065;
    kit.block(g, m.trim, x, x + 0.045, h - 0.2, h - 0.165, fp, fp + 0.006, false);
  }
  const gx = w / 2 - 0.15, gy = h - 0.17;
  kit.cyl(g, m.chrome, 0.058, 0.02, gx, gy, fp + 0.01, { axis: 'z', segments: 24 });
  kit.cyl(g, kit.mat.white, 0.048, 0.004, gx, gy, fp + 0.021, { axis: 'z', segments: 24 });
  kit.block(g, dark, gx - 0.003, gx + 0.003, gy, gy + 0.038, fp + 0.023, fp + 0.025, false);
  return g;
}

function drawAutoclave(ctx, o) {
  const { fz, R } = autoclaveLayout(o.w, o.d, o.h);
  const fp = fz + 0.012;
  pen(ctx, o, FINE, o.theme.muted, DASH);
  box(ctx, -R * 0.85, -o.d / 2 + 0.1, R * 0.85, fz);
  pen(ctx, o);
  line(ctx, -o.w / 2, fp, o.w / 2, fp);
  box(ctx, -R, fp, R, fp + 0.05);
  box(ctx, -0.06, fp + 0.05, 0.06, fp + 0.08);
  outline(ctx, o);
}

// ---- Registration -------------------------------------------------------------------

registerItems([
  {
    type: 'lab-bench-island', name: 'Island lab bench', category: 'lab',
    w: 3.66, d: 1.52, h: 2.13, resizable: true,
    tags: ['bench', 'casework', 'wet lab', 'reagent shelf', 'sink'],
    build: buildIsland, draw2d: drawIsland,
  },
  {
    type: 'lab-bench-wall', name: 'Wall lab bench', category: 'lab',
    w: 3.05, d: 0.76, h: 2.13, resizable: true,
    tags: ['bench', 'casework', 'perimeter', 'counter', 'shelving'],
    build: buildWallBench, draw2d: drawWallBench,
  },
  fixed({
    type: 'fume-hood', name: 'Fume hood', category: 'lab',
    w: 1.83, d: 0.91, h: 2.44,
    tags: ['hood', 'chemical', 'exhaust', 'ventilation'],
    build: buildFumeHood, draw2d: drawFumeHood,
  }),
  fixed({
    type: 'biosafety-cabinet', name: 'Biosafety cabinet', category: 'lab',
    w: 1.52, d: 0.84, h: 2.24,
    tags: ['bsc', 'hood', 'tissue culture', 'sterile'],
    build: buildBiosafety, draw2d: drawBiosafety,
  }),
  fixed({
    type: 'ult-freezer', name: 'Ultra-low freezer', category: 'lab',
    w: 0.89, d: 0.94, h: 1.98,
    tags: ['freezer', '-80', 'cold storage', 'ult'],
    build: buildUltFreezer, draw2d: drawUltFreezer,
  }),
  fixed({
    type: 'lab-refrigerator', name: 'Lab refrigerator', category: 'lab',
    w: 0.76, d: 0.81, h: 1.98,
    tags: ['fridge', 'cold storage', 'glass door', 'reagents'],
    build: buildLabFridge, draw2d: drawLabFridge,
  }),
  fixed({
    type: 'tall-storage-cabinet', name: 'Tall storage cabinet', category: 'lab',
    w: 1.22, d: 0.61, h: 2.13,
    tags: ['cabinet', 'storage', 'casework', 'glass door'],
    build: buildTallCabinet, draw2d: drawTallCabinet,
  }),
  fixed({
    type: 'lab-sink', name: 'Lab sink with eyewash', category: 'lab',
    w: 1.22, d: 0.76, h: 1.1,
    tags: ['sink', 'eyewash', 'safety', 'faucet'],
    build: buildLabSink, draw2d: drawLabSink,
  }),
  fixed({
    type: 'safety-shower', name: 'Safety shower', category: 'lab', contactShadow: false,
    w: 0.91, d: 0.91, h: 2.29,
    tags: ['emergency', 'shower', 'safety', 'drench'],
    build: buildSafetyShower, draw2d: drawSafetyShower,
  }),
  fixed({
    type: 'lab-stool', name: 'Lab stool', category: 'lab', colorable: true, planFill: false, contactShadow: 'round',
    w: 0.46, d: 0.46, h: 0.76,
    tags: ['stool', 'seating', 'chair', 'bench height'],
    build: buildLabStool, draw2d: drawLabStool,
  }),
  fixed({
    type: 'equipment-cart', name: 'Equipment cart', category: 'lab',
    w: 0.91, d: 0.61, h: 1.0,
    tags: ['cart', 'trolley', 'mobile', 'instrument'],
    build: buildCart, draw2d: drawCart,
  }),
  fixed({
    type: 'autoclave', name: 'Autoclave', category: 'lab',
    w: 0.91, d: 0.91, h: 1.75,
    tags: ['sterilizer', 'steam', 'glass wash', 'equipment'],
    build: buildAutoclave, draw2d: drawAutoclave,
  }),
]);
