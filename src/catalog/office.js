// Office and general catalog: workstations, meeting tables, lounge seating, storage, pantry and
// media, plus building elements, greenery, printers and restroom fixtures.
// Local frame: x = width, y = up, z = depth with the front facing +z (plan +y).
import { registerItems } from './registry.js';

const OUT = 1.25;       // plan outline weight in px
const FINE = 0.75;      // plan detail weight in px
const DASH = [4, 3];    // hidden or overhead elements, in px
const TOP_T = 0.025;    // worksurface thickness
const GAP = 0.003;      // half the reveal between fronts
const TAU = Math.PI * 2;
const MAX_REPEAT = 200; // most modules, seats or bushes a run repeats, so absurd sizes stay fast

const BOOKS = ['#003f2d', '#538184', '#80bbad', '#dbd99a', '#435254', '#cad1d3', '#032842', '#7f8480', '#f1f0ea', '#8c5a44'];
const LEAVES = ['#4f7a4a', '#5f8b52', '#3d6741', '#6d9a5c'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const repeats = (n, min = 1) => clamp(n, min, MAX_REPEAT);
const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];
const isColor = (c) => typeof c === 'string' && c.length > 0;

function seq(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---- Materials ----------------------------------------------------------------------

function mats(kit) {
  return {
    oak: kit.mat.oak,
    walnut: kit.mat.walnut,
    white: kit.mat.white,
    casework: kit.mat.casework,
    laminate: kit.mat.laminate,
    quartz: kit.mat.quartz,
    black: kit.mat.black,
    rubber: kit.mat.rubber,
    chrome: kit.mat.chrome,
    steel: kit.mat.steel,
    screen: kit.mat.screen,
    fabric: kit.mat.fabricCharcoal,
    sage: kit.mat.fabricSage,
    celadon: kit.mat.fabricCeladon,
    wheat: kit.mat.fabricWheat,
    green: kit.mat.fabricGreen,
    accent: kit.mat.accentGreen,
    frame: kit.material('#30373a', { roughness: 0.42, metalness: 0.35 }),
    frameLight: kit.material('#e6e8e6', { roughness: 0.4, metalness: 0.15 }),
    alu: kit.material('#b4bbbf', { roughness: 0.32, metalness: 0.75 }),
    reveal: kit.material('#3a4043', { roughness: 0.9 }),
    leather: kit.material('#2b3033', { roughness: 0.55 }),
    sagePaint: kit.material('#538184', { roughness: 0.5 }),
    porcelain: kit.material('#f7f7f5', { roughness: 0.15 }),
    mirror: kit.material('#dfe6e9', { roughness: 0.04, metalness: 1 }),
    panelLight: kit.material('#ffffff', { roughness: 0.6, emissive: '#fff4e2', emissiveIntensity: 0.9 }),
    paper: kit.material('#f4f4f0', { roughness: 0.8 }),
  };
}

/** The caller's color as a material, or the fallback when no color is set. */
function finish(kit, color, fallback, roughness = 0.6) {
  return isColor(color) ? kit.material(color, { roughness }) : fallback;
}

/** A slightly darker variant of mat, for laminate edges and cushion piping. */
function shade(kit, mat, f = 0.82) {
  const c = mat.color.clone().multiplyScalar(f);
  return kit.material(`#${c.getHexString()}`, { roughness: mat.roughness, metalness: mat.metalness });
}

// ---- 3D helpers ---------------------------------------------------------------------

/** Non-resizable items are modeled at their default size and scaled to any other size. */
function fixed(def) {
  const { build, draw2d } = def;
  return {
    ...def,
    build(kit, o = {}) {
      const g = build(kit, { w: def.w, d: def.d, h: def.h, color: o.color });
      const s = [(o.w || def.w) / def.w, (o.h || def.h) / def.h, (o.d || def.d) / def.d];
      if (s.some((v) => Math.abs(v - 1) > 1e-6)) g.scale.set(...s);
      return g;
    },
    draw2d(ctx, o) {
      const sx = (o.w || def.w) / def.w, sy = (o.d || def.d) / def.d;
      if (Math.abs(sx - 1) < 1e-6 && Math.abs(sy - 1) < 1e-6) {
        draw2d(ctx, o);
        return;
      }
      ctx.save();
      ctx.scale(sx, sy);
      draw2d(ctx, { ...o, w: def.w, d: def.d, h: def.h, px: o.px / Math.sqrt(sx * sy) });
      ctx.restore();
    },
  };
}

/** Child group posed at (x, y, z) and rotated, for parts modeled in their own frame. */
function sub(kit, g, x, y, z, { yaw = 0, pitch = 0, roll = 0 } = {}) {
  const f = kit.group();
  f.position.set(x, y, z);
  f.rotation.set(pitch, yaw, roll);
  g.add(f);
  return f;
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

/** Slab with rounded vertical corners of radius r. */
function roundedSlab(kit, g, mat, x0, x1, y0, y1, z0, z1, r) {
  r = Math.min(r, (x1 - x0) / 2, (z1 - z0) / 2);
  kit.block(g, mat, x0 + r, x1 - r, y0, y1, z0, z1);
  kit.block(g, mat, x0, x1, y0, y1, z0 + r, z1 - r);
  for (const x of [x0 + r, x1 - r]) for (const z of [z0 + r, z1 - r]) kit.cyl(g, mat, r, y1 - y0, x, y0, z, { segments: 12 });
}

/** Worksurface with a darker edge band, top face at y = top. */
function worksurface(kit, g, mat, x0, x1, z0, z1, top, t = TOP_T) {
  kit.block(g, mat, x0, x1, top - 0.004, top, z0, z1);
  kit.block(g, shade(kit, mat, 0.86), x0 + 0.0015, x1 - 0.0015, top - t, top - 0.004, z0 + 0.0015, z1 - 0.0015);
}

/** Closed sled leg at x spanning z0..z1, under a top whose underside is at y = under. */
function sledLeg(kit, g, mat, x, z0, z1, under) {
  const a = x - 0.02, b = x + 0.02, t = 0.03;
  kit.block(g, mat, a, b, 0, t, z0, z1);
  kit.block(g, mat, a, b, under - t, under, z0, z1);
  kit.block(g, mat, a, b, t, under - t, z0, z0 + 0.05);
  kit.block(g, mat, a, b, t, under - t, z1 - 0.05, z1);
}

/** Front panel with a horizontal bar pull, on the face at z (front facing +z). */
function drawerFront(kit, g, m, mat, x0, x1, y0, y1, z, pull = 0.16) {
  kit.block(g, mat, x0 + GAP, x1 - GAP, y0 + GAP, y1 - GAP, z, z + 0.018);
  if (pull > 0) {
    const cx = (x0 + x1) / 2, py = y1 - Math.min(0.05, (y1 - y0) / 2);
    kit.block(g, m.alu, cx - pull / 2, cx + pull / 2, py - 0.007, py + 0.007, z + 0.018, z + 0.03);
  }
}

/** Mobile pedestal (box, box, file) between x0..x1 and z0..z1, fronts facing +z, top at y1. */
function pedestal(kit, g, m, x0, x1, z0, z1, y1, mat = m.frameLight) {
  const zf = z1 - 0.03;
  kit.block(g, m.reveal, x0 + 0.03, x1 - 0.03, 0, 0.04, z0 + 0.03, zf - 0.03);
  kit.block(g, mat, x0, x1, 0.04, y1, z0, zf);
  const ys = [y1, y1 - 0.13, y1 - 0.26, 0.04];
  for (let i = 0; i < 3; i++) drawerFront(kit, g, m, mat, x0, x1, ys[i + 1], ys[i], zf, 0.14);
}

/** Monitor head with its screen facing local +z: housing and lit panel, bottom edge at y = 0. */
function monitorHead(kit, f, m, mw) {
  const mh = mw * 0.58;
  kit.block(f, m.black, -mw / 2, mw / 2, 0, mh, -0.03, -0.008);
  kit.block(f, m.screen, -mw / 2 + 0.008, mw / 2 - 0.008, 0.018, mh - 0.008, -0.008, -0.005, false);
}

/** Single monitor on a desk stand at (x, z), its base on the surface at y = top. */
function deskMonitor(kit, g, m, x, top, z, yaw = 0, mw = 0.58) {
  const f = sub(kit, g, x, top, z, { yaw });
  kit.block(f, m.frame, -0.11, 0.11, 0, 0.012, -0.1, 0.04);
  kit.block(f, m.frame, -0.025, 0.025, 0.012, 0.28, -0.07, -0.045);
  monitorHead(kit, sub(kit, f, 0, 0.1, 0), m, mw);
}

/** Two monitors on a shared arm clamped to the surface at (cx, z); screens face +z. */
function dualMonitors(kit, g, m, cx, top, z, mw = 0.56) {
  kit.block(g, m.frame, cx - 0.05, cx + 0.05, top, top + 0.012, z - 0.08, z + 0.02);
  kit.cyl(g, m.frame, 0.017, 0.32, cx, top, z - 0.03, { segments: 12 });
  kit.block(g, m.frame, cx - mw + 0.1, cx + mw - 0.1, top + 0.26, top + 0.29, z - 0.04, z - 0.02);
  for (const s of [-1, 1]) monitorHead(kit, sub(kit, g, cx + s * (mw / 2 + 0.012), top + 0.1, z + 0.005, { yaw: -s * 0.14 }), m, mw);
}

function keyboard(kit, g, m, x, top, z, yaw = 0, mouse = true) {
  const f = sub(kit, g, x, top, z, { yaw });
  kit.block(f, m.frameLight, -0.21, 0.21, 0, 0.014, -0.065, 0.065);
  if (mouse) kit.block(f, m.frameLight, 0.29, 0.35, 0, 0.022, -0.04, 0.03);
}

const CHAIR = { seat: 0.47 };

/**
 * Swivel chair centered at (x, z), facing local +z turned by yaw. back is the backrest height;
 * lite drops small parts for rooms that seat many people.
 */
function swivelChair(kit, g, m, x, z, yaw, { fabric = m.fabric, back = 0.47, casters = true, base = m.frame, lite = false } = {}) {
  const c = sub(kit, g, x, 0, z, { yaw });
  const legY = casters ? 0.057 : 0.004;
  kit.cyl(c, base, 0.045, 0.055, 0, legY, 0, { segments: 14 });
  for (let i = 0; i < 5; i++) {
    const leg = sub(kit, c, 0, 0, 0, { yaw: (i * TAU) / 5 + Math.PI / 2 });
    kit.block(leg, base, 0.03, 0.29, legY, legY + 0.03, -0.017, 0.017);
    if (casters) kit.cyl(leg, m.rubber, 0.027, 0.028, 0.282, 0.028, 0, { axis: 'z', segments: 12 });
  }
  kit.cyl(c, m.black, 0.027, 0.37 - legY - 0.05, 0, legY + 0.05, 0, { segments: 12 });
  if (!lite) kit.block(c, m.black, -0.11, 0.11, 0.36, 0.41, -0.13, 0.1);
  kit.block(c, fabric, -0.25, 0.25, 0.4, CHAIR.seat, -0.24, 0.215);
  if (!lite) kit.cyl(c, fabric, 0.035, 0.5, 0, CHAIR.seat - 0.035, 0.215, { axis: 'x', segments: 12 });
  kit.block(c, m.black, -0.035, 0.035, 0.38, 0.62, -0.272, -0.24);
  const b = sub(kit, c, 0, 0.55, -0.245, { pitch: -0.1 });
  if (lite) {
    kit.block(b, fabric, -0.235, 0.235, 0, back, -0.03, 0.012);
  } else {
    archPanel(kit, b, m.black, -0.235, 0.235, 0, back, -0.03, -0.01, 0.09);
    archPanel(kit, b, fabric, -0.215, 0.215, 0.02, back - 0.02, -0.01, 0.012, 0.075);
  }
  for (const s of [-1, 1]) {
    kit.block(c, m.black, s * 0.265 - 0.012, s * 0.265 + 0.012, 0.42, 0.64, -0.08, -0.045);
    kit.block(c, m.black, s * 0.265 - 0.028, s * 0.265 + 0.028, 0.64, 0.665, -0.17, 0.09);
  }
  return c;
}

/** Upright panel in the x-y plane whose top corners are rounded with radius r. */
function archPanel(kit, g, mat, x0, x1, y0, y1, z0, z1, r) {
  kit.block(g, mat, x0, x1, y0, y1 - r, z0, z1);
  kit.block(g, mat, x0 + r, x1 - r, y1 - r, y1, z0, z1);
  for (const x of [x0 + r, x1 - r]) kit.cyl(g, mat, r, z1 - z0, x, y1 - r, (z0 + z1) / 2, { axis: 'z', segments: 14 });
}

/** Four-leg side chair centered at (x, z), facing local +z turned by yaw. */
function sideChair(kit, g, m, x, z, yaw, { fabric = m.sage, wood = m.oak } = {}) {
  const c = sub(kit, g, x, 0, z, { yaw });
  for (const lx of [-0.19, 0.19]) {
    for (const lz of [-0.18, 0.18]) kit.cyl(c, wood, 0.016, 0.4, lx, 0, lz, { rTop: 0.021, segments: 10 });
  }
  kit.block(c, wood, -0.22, 0.22, 0.38, 0.41, -0.2, 0.21);
  kit.block(c, fabric, -0.225, 0.225, 0.41, 0.46, -0.2, 0.225);
  const b = sub(kit, c, 0, 0.41, -0.2, { pitch: -0.14 });
  for (const lx of [-0.19, 0.19]) kit.block(b, wood, lx - 0.016, lx + 0.016, 0, 0.3, -0.03, 0);
  kit.block(b, wood, -0.225, 0.225, 0.16, 0.42, -0.045, -0.012);
  return c;
}

// ---- 2D helpers ---------------------------------------------------------------------

function pen(ctx, o, weight = FINE, color = o.theme.line, dash = null) {
  ctx.lineWidth = weight * o.px;
  ctx.strokeStyle = color;
  ctx.setLineDash(dash ? dash.map((v) => v * o.px) : []);
}

function paint(ctx, fill) {
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.stroke();
}

function rect(ctx, x0, y0, x1, y1, fill) {
  ctx.beginPath();
  ctx.rect(x0, y0, x1 - x0, y1 - y0);
  paint(ctx, fill);
}

function rrect(ctx, x0, y0, x1, y1, r, fill) {
  ctx.beginPath();
  ctx.roundRect(x0, y0, x1 - x0, y1 - y0, Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2)));
  paint(ctx, fill);
}

function line(ctx, ...p) {
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
  ctx.stroke();
}

function circle(ctx, x, y, r, fill) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  paint(ctx, fill);
}

function ellipse(ctx, x, y, rx, ry, fill) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
  paint(ctx, fill);
}

function outline(ctx, o) {
  pen(ctx, o, OUT);
  rect(ctx, -o.w / 2, -o.d / 2, o.w / 2, o.d / 2);
}

/** Hairline around the footprint, for symbols that do not fill it (furniture groups). */
function zone(ctx, o) {
  pen(ctx, o, FINE, o.theme.light);
  rect(ctx, -o.w / 2, -o.d / 2, o.w / 2, o.d / 2);
}

/** True when the symbol is drawn large enough for small details to stay legible. */
const roomy = (o) => o.px < 1 / 40;

/** Runs draw in a frame at plan (x, y) turned to match a 3D yaw. */
function posed(ctx, x, y, yaw, draw) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-yaw);
  draw();
  ctx.restore();
}

/** Swivel chair in plan: seat, backrest and arms, front toward local +y. */
function drawChair(ctx, o, x, y, yaw) {
  posed(ctx, x, y, yaw, () => {
    pen(ctx, o);
    rrect(ctx, -0.25, -0.24, 0.25, 0.25, 0.07, o.theme.fill);
    rrect(ctx, -0.235, -0.325, 0.235, -0.255, 0.03, o.theme.fill);
    for (const s of [-1, 1]) rrect(ctx, s * 0.265 - 0.028, -0.17, s * 0.265 + 0.028, 0.09, 0.02, o.theme.fill);
  });
}

function drawSideChair(ctx, o, x, y, yaw) {
  posed(ctx, x, y, yaw, () => {
    pen(ctx, o);
    rrect(ctx, -0.225, -0.2, 0.225, 0.225, 0.05, o.theme.fill);
    ctx.beginPath();
    ctx.moveTo(-0.225, -0.215);
    ctx.quadraticCurveTo(0, -0.28, 0.225, -0.215);
    ctx.lineTo(0.225, -0.245);
    ctx.quadraticCurveTo(0, -0.31, -0.225, -0.245);
    ctx.closePath();
    paint(ctx, o.theme.fill);
  });
}

/** Monitor in plan: a thin housing seen from above, screen facing local +y. */
function drawMonitor(ctx, o, x, y, yaw, mw) {
  posed(ctx, x, y, yaw, () => {
    pen(ctx, o);
    rect(ctx, -mw / 2, -0.03, mw / 2, -0.005, o.theme.line);
  });
}

function drawDualMonitors(ctx, o, cx, z, mw = 0.56) {
  for (const s of [-1, 1]) drawMonitor(ctx, o, cx + s * (mw / 2 + 0.012), z + 0.005, -s * 0.14, mw);
  if (roomy(o)) {
    pen(ctx, o, FINE, o.theme.muted);
    circle(ctx, cx, z - 0.03, 0.017);
  }
}

function drawKeyboard(ctx, o, x, y, yaw = 0, mouse = true) {
  if (!roomy(o)) return;
  posed(ctx, x, y, yaw, () => {
    pen(ctx, o, FINE, o.theme.muted);
    rrect(ctx, -0.21, -0.065, 0.21, 0.065, 0.01);
    if (mouse) rrect(ctx, 0.29, -0.04, 0.35, 0.03, 0.025);
  });
}

/** Leafy plan symbol: a scalloped canopy with veins toward the center. */
function drawFoliage(ctx, o, x, y, r, lobes = 9, seed = 1) {
  const rnd = seq(seed);
  const pts = [];
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * TAU + rnd() * 0.25;
    pts.push([a, r * (0.82 + rnd() * 0.12)]);
  }
  ctx.beginPath();
  pts.forEach(([a, rr], i) => {
    const [b, rn] = pts[(i + 1) % lobes];
    const end = b < a ? b + TAU : b;
    const mid = (a + end) / 2;
    if (i === 0) ctx.moveTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
    const k = r * 1.08;
    ctx.quadraticCurveTo(x + k * Math.cos(mid), y + k * Math.sin(mid), x + rn * Math.cos(b), y + rn * Math.sin(b));
  });
  ctx.closePath();
  paint(ctx, o.theme.fill);
  if (r / o.px > 10) {
    pen(ctx, o, FINE * 0.8, o.theme.muted);
    for (const [a, rr] of pts) line(ctx, x + rr * 0.25 * Math.cos(a + 0.3), y + rr * 0.25 * Math.sin(a + 0.3), x + rr * 0.78 * Math.cos(a + 0.18), y + rr * 0.78 * Math.sin(a + 0.18));
  }
}

// ---- Desk ---------------------------------------------------------------------------

/**
 * Freestanding desk over x0..x1, z0..z1 (users sit at z1) with its top at y = top: sled legs,
 * a back beam, a modesty panel and an optional mobile pedestal at the +x end.
 */
function deskUnit(kit, g, m, { x0, x1, z0, z1, top, surface, ped = false, modesty = true }) {
  worksurface(kit, g, surface, x0, x1, z0, z1, top);
  const under = top - TOP_T;
  const legs = [x0 + 0.06, x1 - 0.06];
  for (const x of legs) sledLeg(kit, g, m.frame, x, z0 + 0.04, z1 - 0.04, under);
  kit.block(g, m.frame, legs[0] + 0.02, legs[1] - 0.02, under - 0.06, under, z0 + 0.06, z0 + 0.1);
  if (modesty) kit.block(g, m.frame, legs[0] + 0.02, legs[1] - 0.02, under - 0.38, under - 0.06, z0 + 0.075, z0 + 0.085);
  const pd = Math.min(0.55, z1 - z0 - 0.2);
  if (ped && x1 - x0 >= 1.0 && pd > 0.3) pedestal(kit, g, m, x1 - 0.5, x1 - 0.1, z1 - 0.05 - pd, z1 - 0.05, under - 0.02);
}

function drawDeskTop(ctx, o, x0, y0, x1, y1, ped) {
  pen(ctx, o, OUT);
  rect(ctx, x0, y0, x1, y1, o.theme.fill);
  if (ped && roomy(o) && x1 - x0 >= 1.0) {
    const pd = Math.min(0.55, y1 - y0 - 0.2);
    pen(ctx, o, FINE, o.theme.muted, DASH);
    rect(ctx, x1 - 0.5, y1 - 0.05 - pd, x1 - 0.1, y1 - 0.05);
    ctx.setLineDash([]);
  }
}

function buildDesk(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = mats(kit);
  deskUnit(kit, g, m, { x0: -w / 2, x1: w / 2, z0: -d / 2, z1: d / 2, top: h, surface: finish(kit, color, m.oak, 0.5), ped: true });
  return g;
}

function drawDesk(ctx, o) {
  drawDeskTop(ctx, o, -o.w / 2, -o.d / 2, o.w / 2, o.d / 2, true);
}

// ---- Workstation --------------------------------------------------------------------

const WS = { deskD: 0.76, top: 0.74, chairZ: 0.32, chairYaw: Math.PI - 0.18 };

function buildWorkstation(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = mats(kit);
  const z0 = -d / 2, z1 = z0 + WS.deskD;
  deskUnit(kit, g, m, { x0: -w / 2, x1: w / 2, z0, z1, top: WS.top, surface: m.oak, ped: true });
  privacyScreen(kit, g, m, finish(kit, color, m.sage, 0.95), -w / 2 + 0.01, w / 2 - 0.01, z0 + 0.004, WS.top, h);
  dualMonitors(kit, g, m, 0, WS.top, z0 + 0.2);
  keyboard(kit, g, m, -0.03, WS.top, z0 + 0.5);
  kit.cyl(g, m.white, 0.04, 0.095, -0.55, WS.top, z0 + 0.42, { segments: 16 });
  kit.block(g, m.green, 0.45, 0.66, WS.top, WS.top + 0.012, z0 + 0.3, z0 + 0.58);
  swivelChair(kit, g, m, 0.04, WS.chairZ, WS.chairYaw);
  return g;
}

/** Desk-mounted fabric screen along x0..x1, back face at z, from the surface at top up to h. */
function privacyScreen(kit, g, m, fabric, x0, x1, z, top, h) {
  kit.block(g, fabric, x0, x1, top + 0.03, h - 0.012, z, z + 0.026);
  kit.block(g, m.alu, x0, x1, h - 0.012, h, z - 0.002, z + 0.028);
  for (const x of [x0 + 0.18, x1 - 0.18]) kit.block(g, m.alu, x - 0.02, x + 0.02, top, top + 0.06, z - 0.002, z + 0.045);
}

function drawWorkstation(ctx, o) {
  zone(ctx, o);
  const y0 = -o.d / 2, y1 = y0 + WS.deskD;
  drawDeskTop(ctx, o, -o.w / 2, y0, o.w / 2, y1, true);
  pen(ctx, o);
  rect(ctx, -o.w / 2 + 0.01, y0 + 0.004, o.w / 2 - 0.01, y0 + 0.03, o.theme.light);
  drawDualMonitors(ctx, o, 0, y0 + 0.2);
  drawKeyboard(ctx, o, -0.03, y0 + 0.5);
  drawChair(ctx, o, 0.04, WS.chairZ, WS.chairYaw);
}

// ---- Task chair ---------------------------------------------------------------------

function buildTaskChair(kit, { color }) {
  const g = kit.group();
  const m = mats(kit);
  swivelChair(kit, g, m, 0, 0.015, 0, { fabric: finish(kit, color, m.fabric, 0.95) });
  return g;
}

function drawTaskChair(ctx, o) {
  zone(ctx, o);
  drawChair(ctx, o, 0, 0.015, 0);
  if (roomy(o)) {
    pen(ctx, o, FINE, o.theme.muted);
    circle(ctx, 0, 0.015, 0.06);
  }
}

// ---- Benching -----------------------------------------------------------------------

const BENCH = { gap: 0.01, deskD: 0.76, top: 0.74, chairZ: 1.09 };

/** Seats of a 2 x 2 bench: one row in front (+z) and a mirrored row behind. */
function benchSeats(w) {
  const jitter = [0.12, -0.1, -0.08, 0.14];
  return [1, -1].flatMap((side, r) => [-w / 4, w / 4].map((x, i) => ({ x, side, jitter: jitter[r * 2 + i] })));
}

function buildBenching(kit, { w, h, color }) {
  const g = kit.group();
  const m = mats(kit);
  const top = BENCH.top, under = top - TOP_T, half = BENCH.gap / 2;
  for (const side of [1, -1]) {
    const r = sub(kit, g, 0, 0, 0, { yaw: side > 0 ? 0 : Math.PI });
    for (const [a, b] of [[-w / 2, -half], [half, w / 2]]) worksurface(kit, r, m.oak, a, b, half, BENCH.deskD + half, top);
  }
  for (const x of [-w / 2 + 0.06, 0, w / 2 - 0.06]) sledLeg(kit, g, m.frame, x, -BENCH.deskD + 0.04, BENCH.deskD - 0.04, under);
  kit.block(g, m.frame, -w / 2 + 0.08, w / 2 - 0.08, under - 0.07, under, -0.05, 0.05);
  privacyScreen(kit, g, m, finish(kit, color, m.sage, 0.95), -w / 2 + 0.02, w / 2 - 0.02, -0.013, top, h);
  for (const s of benchSeats(w)) {
    const r = sub(kit, g, 0, 0, 0, { yaw: s.side > 0 ? 0 : Math.PI });
    const x = s.side * s.x;
    dualMonitors(kit, r, m, x, top, 0.2);
    keyboard(kit, r, m, x - 0.03, top, 0.5, 0, false);
    swivelChair(kit, r, m, x + s.jitter * 0.3, BENCH.chairZ, Math.PI + s.jitter, { lite: true });
  }
  return g;
}

function drawBenching(ctx, o) {
  zone(ctx, o);
  const half = BENCH.gap / 2;
  for (const side of [1, -1]) {
    posed(ctx, 0, 0, side > 0 ? 0 : Math.PI, () => {
      for (const [a, b] of [[-o.w / 2, -half], [half, o.w / 2]]) drawDeskTop(ctx, o, a, half, b, BENCH.deskD + half, false);
    });
  }
  pen(ctx, o);
  rect(ctx, -o.w / 2 + 0.02, -0.013, o.w / 2 - 0.02, 0.013, o.theme.light);
  for (const s of benchSeats(o.w)) {
    posed(ctx, 0, 0, s.side > 0 ? 0 : Math.PI, () => {
      const x = s.side * s.x;
      drawDualMonitors(ctx, o, x, 0.2);
      drawKeyboard(ctx, o, x - 0.03, 0.5, 0, false);
      drawChair(ctx, o, x + s.jitter * 0.3, BENCH.chairZ, Math.PI + s.jitter);
    });
  }
}

// ---- Private office desk ------------------------------------------------------------

function execLayout(w, d) {
  const mainZ0 = d / 2 - 0.76;
  const retX0 = w / 2 - 0.56;
  return { mainZ0, retX0, chair: { x: -0.26, z: mainZ0 - 0.12, yaw: 0.35 }, monitor: { x: w / 2 - 0.14, z: -0.14 } };
}

function buildExecutiveDesk(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = mats(kit);
  const L = execLayout(w, d);
  const top = finish(kit, color, m.walnut, 0.5);
  const t = 0.035, under = h - t;
  worksurface(kit, g, top, -w / 2, w / 2, L.mainZ0, d / 2, h, t);
  worksurface(kit, g, top, L.retX0, w / 2, -d / 2, L.mainZ0, h, t);
  kit.block(g, top, -w / 2, -w / 2 + 0.04, 0, under, L.mainZ0 + 0.03, d / 2 - 0.03);
  kit.block(g, top, -w / 2 + 0.04, L.retX0, 0.22, under, d / 2 - 0.07, d / 2 - 0.05);
  kit.block(g, top, L.retX0 + 0.02, w / 2 - 0.02, 0, under, -d / 2 + 0.02, -d / 2 + 0.06);
  kit.block(g, top, w / 2 - 0.04, w / 2, 0, under, L.mainZ0 + 0.03, d / 2 - 0.03);
  const p = sub(kit, g, (L.retX0 + w / 2) / 2 + 0.01, 0, -d / 2 + 0.31, { yaw: -Math.PI / 2 });
  pedestal(kit, p, m, -0.24, 0.24, -0.25, 0.25, under - 0.02, top);
  deskMonitor(kit, g, m, L.monitor.x, h, L.monitor.z, -Math.PI / 2, 0.62);
  keyboard(kit, g, m, L.retX0 + 0.2, h, L.monitor.z + 0.02, -Math.PI / 2);
  laptop(kit, g, m, -0.3, h, d / 2 - 0.36);
  deskLamp(kit, g, m, -w / 2 + 0.16, h, d / 2 - 0.2);
  swivelChair(kit, g, m, L.chair.x, L.chair.z, L.chair.yaw, { fabric: m.leather, back: 0.52 });
  return g;
}

function laptop(kit, g, m, x, top, z) {
  const f = sub(kit, g, x, top, z, { yaw: 0.2 });
  kit.block(f, m.alu, -0.16, 0.16, 0, 0.018, -0.11, 0.11);
}

function deskLamp(kit, g, m, x, top, z) {
  kit.cyl(g, m.frame, 0.07, 0.015, x, top, z, { segments: 18 });
  rod(kit, g, m.frame, 0.008, [x, top + 0.015, z], [x + 0.06, top + 0.36, z - 0.04]);
  rod(kit, g, m.frame, 0.008, [x + 0.06, top + 0.36, z - 0.04], [x + 0.24, top + 0.38, z - 0.1]);
  const head = kit.cyl(g, m.frame, 0.05, 0.08, x + 0.26, top + 0.33, z - 0.11, { rTop: 0.02, segments: 16 });
  head.rotation.z = -0.2;
}

function drawExecutiveDesk(ctx, o) {
  const { w, d } = o;
  const L = execLayout(w, d);
  zone(ctx, o);
  drawChair(ctx, o, L.chair.x, L.chair.z, L.chair.yaw);
  pen(ctx, o, OUT);
  ctx.beginPath();
  ctx.moveTo(-w / 2, L.mainZ0);
  ctx.lineTo(L.retX0, L.mainZ0);
  ctx.lineTo(L.retX0, -d / 2);
  ctx.lineTo(w / 2, -d / 2);
  ctx.lineTo(w / 2, d / 2);
  ctx.lineTo(-w / 2, d / 2);
  ctx.closePath();
  paint(ctx, o.theme.fill);
  pen(ctx, o);
  drawMonitor(ctx, o, L.monitor.x, L.monitor.z, -Math.PI / 2, 0.62);
  drawKeyboard(ctx, o, L.retX0 + 0.2, L.monitor.z + 0.02, -Math.PI / 2);
  if (roomy(o)) {
    pen(ctx, o, FINE, o.theme.muted);
    posed(ctx, -0.3, d / 2 - 0.36, 0.2, () => rrect(ctx, -0.16, -0.11, 0.16, 0.11, 0.01));
    circle(ctx, -w / 2 + 0.16, d / 2 - 0.2, 0.07);
    pen(ctx, o, FINE, o.theme.muted, DASH);
    rect(ctx, L.retX0 + 0.06, -d / 2 + 0.07, w / 2 - 0.04, -d / 2 + 0.55);
    ctx.setLineDash([]);
  }
}

// ---- Conference and round tables ----------------------------------------------------

const CONF = {
  6: { tw: 2.13, td: 1.07, sides: 3, ends: false, seed: 6 },
  10: { tw: 3.66, td: 1.22, sides: 4, ends: true, seed: 10 },
};

function confSeats(spec) {
  const rnd = seq(spec.seed);
  const out = [];
  const pitch = spec.tw / spec.sides;
  const reach = 0.245;
  for (const side of [1, -1]) {
    for (let i = 0; i < spec.sides; i++) {
      const jx = (rnd() - 0.5) * 0.08, jz = rnd() * 0.06, jy = (rnd() - 0.5) * 0.24;
      out.push({ x: -spec.tw / 2 + pitch * (i + 0.5) + jx, z: side * (spec.td / 2 + reach + jz), yaw: (side > 0 ? Math.PI : 0) + jy });
    }
  }
  if (spec.ends) {
    for (const side of [1, -1]) out.push({ x: side * (spec.tw / 2 + reach), z: (rnd() - 0.5) * 0.06, yaw: -side * Math.PI / 2 + (rnd() - 0.5) * 0.16 });
  }
  return out;
}

function buildConference(seats) {
  const spec = CONF[seats];
  return (kit, { h, color }) => {
    const g = kit.group();
    const m = mats(kit);
    const { tw, td } = spec;
    const t = 0.04, under = h - t;
    roundedSlab(kit, g, finish(kit, color, m.oak, 0.5), -tw / 2, tw / 2, under, h, -td / 2, td / 2, 0.06);
    for (const s of [-1, 1]) {
      const x = s * (tw / 2 - 0.5);
      kit.block(g, m.frame, x - 0.04, x + 0.04, 0.03, under, -td / 2 + 0.28, td / 2 - 0.28);
      kit.block(g, m.frame, x - 0.05, x + 0.05, 0, 0.03, -td / 2 + 0.16, td / 2 - 0.16);
      kit.block(g, m.frame, x - 0.05, x + 0.05, under - 0.03, under, -td / 2 + 0.12, td / 2 - 0.12);
    }
    kit.block(g, m.frame, -tw / 2 + 0.5, tw / 2 - 0.5, under - 0.09, under, -0.06, 0.06);
    kit.block(g, m.black, -0.17, 0.17, h - 0.002, h + 0.003, -0.06, 0.06);
    kit.block(g, m.alu, -0.15, 0.15, h + 0.003, h + 0.005, -0.045, 0.045);
    for (const c of confSeats(spec)) swivelChair(kit, g, m, c.x, c.z, c.yaw, { back: 0.36, casters: false, base: m.chrome, lite: true });
    return g;
  };
}

function drawConference(seats) {
  const spec = CONF[seats];
  return (ctx, o) => {
    zone(ctx, o);
    for (const c of confSeats(spec)) drawChair(ctx, o, c.x, c.z, c.yaw);
    pen(ctx, o, OUT);
    rrect(ctx, -spec.tw / 2, -spec.td / 2, spec.tw / 2, spec.td / 2, 0.06, o.theme.fill);
    if (roomy(o)) {
      pen(ctx, o, FINE, o.theme.muted);
      rect(ctx, -0.17, -0.06, 0.17, 0.06);
      pen(ctx, o, FINE, o.theme.muted, DASH);
      for (const s of [-1, 1]) line(ctx, s * (spec.tw / 2 - 0.5), -spec.td / 2 + 0.16, s * (spec.tw / 2 - 0.5), spec.td / 2 - 0.16);
      ctx.setLineDash([]);
    }
  };
}

const ROUND = { r: 0.535, seatR: 0.71 };

function roundSeats() {
  return [0.25, 0.75, 1.25, 1.75].map((f, i) => {
    const a = f * Math.PI + [0.04, -0.06, 0.05, -0.03][i];
    const x = ROUND.seatR * Math.cos(a), z = ROUND.seatR * Math.sin(a);
    return { x, z, yaw: Math.atan2(-x, -z) };
  });
}

function buildRoundTable(kit, { h, color }) {
  const g = kit.group();
  const m = mats(kit);
  const top = finish(kit, color, m.oak, 0.5);
  kit.cyl(g, top, ROUND.r, 0.03, 0, h - 0.03, 0, { segments: 48 });
  kit.cyl(g, shade(kit, top), ROUND.r - 0.004, 0.012, 0, h - 0.042, 0, { segments: 48 });
  kit.cyl(g, m.frame, 0.14, 0.02, 0, h - 0.062, 0, { segments: 24 });
  kit.cyl(g, m.frame, 0.04, h - 0.08, 0, 0.02, 0, { segments: 16 });
  kit.cyl(g, m.frame, 0.27, 0.02, 0, 0, 0, { rTop: 0.25, segments: 32 });
  for (const s of roundSeats()) sideChair(kit, g, m, s.x, s.z, s.yaw);
  return g;
}

function drawRoundTable(ctx, o) {
  zone(ctx, o);
  for (const s of roundSeats()) drawSideChair(ctx, o, s.x, s.z, s.yaw);
  pen(ctx, o, OUT);
  circle(ctx, 0, 0, ROUND.r, o.theme.fill);
  if (roomy(o)) {
    pen(ctx, o, FINE, o.theme.muted, DASH);
    circle(ctx, 0, 0, 0.27);
    ctx.setLineDash([]);
  }
}

// ---- Sofa and lounge chair ----------------------------------------------------------

/** Upholstered seating facing +z: `seats` cushions between two rolled arms. */
function upholstered(kit, g, m, { w, d, h, seats, fabric, arm, armH, seatH, leg, legMat, tapered, backH = h - 0.2 }) {
  const backT = 0.17;
  const ix0 = -w / 2 + arm, ix1 = w / 2 - arm;
  const lx = w / 2 - 0.06, lz = d / 2 - 0.07;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      if (tapered) kit.cyl(g, legMat, 0.015, leg, sx * lx, 0, sz * lz, { rTop: 0.024, segments: 10 });
      else kit.block(g, legMat, sx * lx - 0.025, sx * lx + 0.025, 0, leg, sz * lz - 0.025, sz * lz + 0.025);
    }
  }
  const deck = seatH - 0.13;
  kit.block(g, fabric, ix0, ix1, leg, deck, -d / 2 + 0.04, d / 2 - 0.03);
  for (const s of [-1, 1]) {
    const x0 = s < 0 ? -w / 2 : ix1, x1 = s < 0 ? ix0 : w / 2;
    kit.block(g, fabric, x0, x1, leg, armH - arm / 2, -d / 2, d / 2);
    kit.cyl(g, fabric, arm / 2, d, (x0 + x1) / 2, armH - arm / 2, 0, { axis: 'z', segments: 16 });
  }
  kit.block(g, fabric, ix0, ix1, leg, backH, -d / 2, -d / 2 + backT);
  const piping = shade(kit, fabric, 0.7);
  const sw = (ix1 - ix0) / seats;
  for (let i = 0; i < seats; i++) {
    const a = ix0 + i * sw + 0.006, b = ix0 + (i + 1) * sw - 0.006;
    kit.block(g, fabric, a, b, deck, seatH, -d / 2 + backT + 0.16, d / 2 - 0.012);
    kit.block(g, piping, a + 0.004, b - 0.004, deck + 0.004, seatH - 0.004, d / 2 - 0.012, d / 2 - 0.006);
    const bc = sub(kit, g, 0, deck, -d / 2 + backT - 0.005, { pitch: -0.12 });
    kit.block(bc, fabric, a, b, 0, h - deck - 0.012, 0, 0.17);
  }
  return { deck, backT, ix0, ix1 };
}

function buildSofa(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = mats(kit);
  const S = upholstered(kit, g, m, {
    w, d, h, seats: 3, fabric: finish(kit, color, m.green, 0.95),
    arm: 0.16, armH: 0.62, seatH: 0.45, leg: 0.07, legMat: m.frame, tapered: false,
  });
  for (const s of [-1, 1]) {
    const p = sub(kit, g, s * (S.ix1 - 0.24), 0.45, -d / 2 + S.backT + 0.22, { yaw: -s * 0.25, pitch: -0.3, roll: s * 0.06 });
    kit.block(p, m.wheat, -0.2, 0.2, 0, 0.36, -0.06, 0.06);
  }
  return g;
}

function buildLounge(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = mats(kit);
  upholstered(kit, g, m, {
    w, d, h, seats: 1, fabric: finish(kit, color, m.celadon, 0.95),
    arm: 0.13, armH: 0.6, seatH: 0.44, leg: 0.15, legMat: m.walnut, tapered: true, backH: h,
  });
  return g;
}

function drawUpholstered(ctx, o, seats, arm) {
  const { w, d } = o;
  const backT = 0.17, ix0 = -w / 2 + arm, ix1 = w / 2 - arm;
  pen(ctx, o, OUT);
  rrect(ctx, -w / 2, -d / 2, w / 2, d / 2, 0.05, o.theme.fill);
  pen(ctx, o);
  rrect(ctx, -w / 2, -d / 2, ix0, d / 2, arm / 2);
  rrect(ctx, ix1, -d / 2, w / 2, d / 2, arm / 2);
  line(ctx, ix0, -d / 2 + backT, ix1, -d / 2 + backT);
  const sw = (ix1 - ix0) / seats;
  for (let i = 0; i < seats; i++) {
    const a = ix0 + i * sw, b = a + sw;
    if (i > 0) line(ctx, a, -d / 2 + backT, a, d / 2);
    if (roomy(o)) {
      pen(ctx, o, FINE, o.theme.muted);
      line(ctx, a + 0.02, -d / 2 + backT + 0.16, b - 0.02, -d / 2 + backT + 0.16);
      pen(ctx, o);
    }
  }
}

function drawSofa(ctx, o) {
  drawUpholstered(ctx, o, 3, 0.16);
}

function drawLounge(ctx, o) {
  drawUpholstered(ctx, o, 1, 0.13);
}

// ---- Coffee table -------------------------------------------------------------------

function buildCoffeeTable(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = mats(kit);
  const top = finish(kit, color, m.oak, 0.5);
  roundedSlab(kit, g, top, -w / 2, w / 2, h - 0.03, h, -d / 2, d / 2, 0.07);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) kit.cyl(g, m.walnut, 0.016, h - 0.03, sx * (w / 2 - 0.1), 0, sz * (d / 2 - 0.09), { rTop: 0.022, segments: 10 });
  }
  kit.block(g, m.walnut, -w / 2 + 0.1, w / 2 - 0.1, 0.12, 0.14, -d / 2 + 0.09, d / 2 - 0.09);
  kit.block(g, kit.material(BOOKS[1], { roughness: 0.7 }), -0.38, -0.12, h, h + 0.025, -0.13, 0.06);
  kit.block(g, kit.material(BOOKS[3], { roughness: 0.7 }), -0.36, -0.15, h + 0.025, h + 0.045, -0.11, 0.04);
  kit.cyl(g, m.white, 0.08, 0.045, 0.28, h, 0.02, { rTop: 0.1, segments: 20 });
  return g;
}

function drawCoffeeTable(ctx, o) {
  pen(ctx, o, OUT);
  rrect(ctx, -o.w / 2, -o.d / 2, o.w / 2, o.d / 2, 0.07, o.theme.fill);
  if (roomy(o)) {
    pen(ctx, o, FINE, o.theme.muted);
    rect(ctx, -0.38, -0.13, -0.12, 0.06);
    circle(ctx, 0.28, 0.02, 0.1);
  }
}

// ---- Lateral file -------------------------------------------------------------------

function buildFiling(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = mats(kit);
  const paint = finish(kit, color, m.frameLight, 0.45);
  const zf = d / 2 - 0.032, base = 0.06, top = h - 0.025;
  kit.block(g, m.reveal, -w / 2 + 0.03, w / 2 - 0.03, 0, base, -d / 2 + 0.02, zf - 0.04);
  kit.block(g, paint, -w / 2 + 0.004, w / 2 - 0.004, base, top, -d / 2, zf);
  kit.block(g, paint, -w / 2, w / 2, top, h, -d / 2, zf + 0.014);
  const n = 4, dh = (top - base) / n;
  for (let i = 0; i < n; i++) {
    const y0 = base + i * dh, y1 = y0 + dh;
    kit.block(g, paint, -w / 2 + 0.008, w / 2 - 0.008, y0 + GAP, y1 - GAP, zf, zf + 0.018);
    kit.block(g, m.alu, -0.22, 0.22, y1 - 0.06, y1 - 0.045, zf + 0.018, zf + 0.03);
    kit.block(g, m.alu, -0.05, 0.05, y1 - 0.12, y1 - 0.085, zf + 0.018, zf + 0.021);
  }
  kit.cyl(g, m.chrome, 0.011, 0.01, w / 2 - 0.06, h - 0.07, zf + 0.018, { axis: 'z', segments: 12 });
  return g;
}

function drawFiling(ctx, o) {
  outline(ctx, o);
  pen(ctx, o);
  line(ctx, -o.w / 2, o.d / 2 - 0.032, o.w / 2, o.d / 2 - 0.032);
  if (roomy(o)) {
    pen(ctx, o, FINE, o.theme.muted);
    for (const x of [-0.22, 0.22]) line(ctx, x, o.d / 2 - 0.032, x, o.d / 2);
  }
}

// ---- Bookshelf ----------------------------------------------------------------------

function shelfLevels(h) {
  const base = 0.07, top = h - 0.022, n = 5, t = 0.02;
  const step = (top - base - t) / n;
  return Array.from({ length: n }, (_, i) => ({ y: base + t + i * step, h: step - t }));
}

/** Books, stacks and the odd object on a shelf from x0 to x1, standing on y, backed at z0. */
function fillShelf(kit, g, rnd, x0, x1, y, z0, depth, maxH) {
  let x = x0 + 0.01 + rnd() * 0.04;
  let placedObject = false;
  while (x < x1 - 0.05) {
    const r = rnd();
    if (r < 0.12 && x1 - x > 0.3) {
      let sy = y;
      const len = 0.2 + rnd() * 0.06;
      for (let i = 0; i < 2 + Math.floor(rnd() * 3); i++) {
        const t = 0.025 + rnd() * 0.02, inset = rnd() * 0.02;
        kit.block(g, kit.material(pick(rnd, BOOKS), { roughness: 0.75 }), x + inset, x + len - inset, sy, sy + t, z0 + 0.04, z0 + depth - 0.02);
        sy += t;
      }
      x += len + 0.02;
    } else if (r < 0.2 && !placedObject && x1 - x > 0.18) {
      kit.cyl(g, kit.material(pick(rnd, ['#f1f0ea', '#80bbad', '#435254']), { roughness: 0.35 }), 0.045, Math.min(maxH, 0.12 + rnd() * 0.08), x + 0.07, y, z0 + depth / 2 + 0.02, { segments: 16, rTop: 0.035 });
      placedObject = true;
      x += 0.16;
    } else if (r < 0.28) {
      x += 0.05 + rnd() * 0.08;
    } else {
      const run = 3 + Math.floor(rnd() * 6);
      for (let i = 0; i < run && x < x1 - 0.04; i++) {
        const t = 0.018 + rnd() * 0.03, bh = Math.min(maxH, 0.17 + rnd() * 0.12), bd = 0.17 + rnd() * 0.08;
        kit.block(g, kit.material(pick(rnd, BOOKS), { roughness: 0.75 }), x, x + t, y, y + bh, z0 + 0.02, z0 + 0.02 + Math.min(bd, depth - 0.03));
        x += t + 0.002;
      }
      x += 0.01;
    }
  }
}

function buildBookshelf(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = mats(kit);
  const body = finish(kit, color, m.oak, 0.55);
  const t = 0.02, zb = -d / 2 + 0.012;
  kit.block(g, body, -w / 2, -w / 2 + t, 0, h, -d / 2, d / 2);
  kit.block(g, body, w / 2 - t, w / 2, 0, h, -d / 2, d / 2);
  kit.block(g, body, -w / 2 + t, w / 2 - t, h - 0.022, h, -d / 2, d / 2);
  kit.block(g, m.reveal, -w / 2 + t, w / 2 - t, 0, 0.07, -d / 2 + 0.02, d / 2 - 0.03);
  kit.block(g, shade(kit, body, 0.9), -w / 2 + t, w / 2 - t, 0.07, h - 0.022, -d / 2, zb);
  const rnd = seq(17);
  for (const L of shelfLevels(h)) {
    kit.block(g, body, -w / 2 + t, w / 2 - t, L.y - t, L.y, zb, d / 2);
    fillShelf(kit, g, rnd, -w / 2 + t, w / 2 - t, L.y, zb, d / 2 - zb - 0.01, L.h - 0.02);
  }
  return g;
}

function drawBookshelf(ctx, o) {
  const { w, d } = o;
  outline(ctx, o);
  pen(ctx, o);
  rect(ctx, -w / 2 + 0.02, -d / 2 + 0.012, w / 2 - 0.02, d / 2);
  if (roomy(o)) {
    const rnd = seq(5);
    pen(ctx, o, FINE, o.theme.muted);
    let x = -w / 2 + 0.04;
    while (x < w / 2 - 0.08) {
      const t = 0.03 + rnd() * 0.05;
      rect(ctx, x, -d / 2 + 0.03, x + t, -d / 2 + 0.03 + 0.17 + rnd() * 0.08);
      x += t + (rnd() < 0.15 ? 0.08 : 0.004);
    }
  }
}

// ---- Phone booth --------------------------------------------------------------------

const BOOTH = { wall: 0.06, roof: 0.11, shelfY: 1.04, stoolZ: 0.06 };

function buildPhoneBooth(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = mats(kit);
  const shell = finish(kit, color, kit.material('#e7e9e6', { roughness: 0.5 }), 0.5);
  const felt = kit.material('#5d8a83', { roughness: 0.98 });
  const t = BOOTH.wall, fz = d / 2 - 0.05, base = 0.06, ceil = h - BOOTH.roof;
  kit.block(g, m.reveal, -w / 2 + 0.03, w / 2 - 0.03, 0, base, -d / 2 + 0.03, d / 2 - 0.03);
  kit.block(g, kit.material('#454c4f', { roughness: 0.98 }), -w / 2 + t, w / 2 - t, base, base + 0.02, -d / 2 + t, fz);
  kit.block(g, shell, -w / 2, w / 2, base, ceil, -d / 2, -d / 2 + t);
  for (const s of [-1, 1]) kit.block(g, shell, s < 0 ? -w / 2 : w / 2 - t, s < 0 ? -w / 2 + t : w / 2, base, ceil, -d / 2 + t, d / 2);
  kit.block(g, shell, -w / 2, w / 2, ceil, h, -d / 2, d / 2);
  kit.block(g, felt, -w / 2 + t, w / 2 - t, base + 0.02, ceil, -d / 2 + t, -d / 2 + t + 0.02);
  for (const s of [-1, 1]) kit.block(g, felt, s * (w / 2 - t) - (s > 0 ? 0.02 : 0), s * (w / 2 - t) + (s < 0 ? 0.02 : 0), base + 0.02, ceil, -d / 2 + t + 0.02, fz - 0.01);
  kit.block(g, felt, -w / 2 + t, w / 2 - t, ceil - 0.02, ceil, -d / 2 + t, fz);
  kit.block(g, m.panelLight, -0.26, 0.26, ceil - 0.026, ceil - 0.02, -0.28, 0.18, false);
  boothDoor(kit, g, m, -w / 2 + t, w / 2 - t, base, ceil, fz);
  kit.block(g, m.oak, -w / 2 + t + 0.02, w / 2 - t - 0.02, BOOTH.shelfY - 0.03, BOOTH.shelfY, -d / 2 + t + 0.02, -d / 2 + t + 0.32);
  kit.block(g, m.frame, -0.05, 0.05, BOOTH.shelfY - 0.08, BOOTH.shelfY - 0.03, -d / 2 + t + 0.02, -d / 2 + t + 0.06);
  stool(kit, g, m, 0, BOOTH.stoolZ, base + 0.02, felt);
  return g;
}

/** Glass door with an aluminum frame filling the front between x0 and x1, outer face at z + 0.03. */
function boothDoor(kit, g, m, x0, x1, y0, y1, z) {
  const f = 0.035;
  kit.block(g, m.alu, x0, x0 + f, y0, y1, z, z + 0.03);
  kit.block(g, m.alu, x1 - f, x1, y0, y1, z, z + 0.03);
  kit.block(g, m.alu, x0 + f, x1 - f, y0, y0 + f, z, z + 0.03);
  kit.block(g, m.alu, x0 + f, x1 - f, y1 - f, y1, z, z + 0.03);
  kit.block(g, kit.glass, x0 + f, x1 - f, y0 + f, y1 - f, z + 0.012, z + 0.02, false);
  kit.block(g, m.frame, x1 - 0.1, x1 - 0.075, 0.85, 1.35, z + 0.03, z + 0.05);
}

function stool(kit, g, m, x, z, y0, seat) {
  kit.cyl(g, m.frame, 0.19, 0.015, x, y0, z, { segments: 24 });
  kit.cyl(g, m.chrome, 0.022, 0.5, x, y0 + 0.015, z, { segments: 12 });
  kit.cyl(g, m.frame, 0.16, 0.025, x, y0 + 0.515, z, { segments: 24 });
  kit.cyl(g, seat, 0.17, 0.05, x, y0 + 0.54, z, { segments: 24, rTop: 0.165 });
}

function drawPhoneBooth(ctx, o) {
  const { w, d } = o;
  const t = BOOTH.wall, fz = d / 2 - 0.05;
  pen(ctx, o, OUT);
  ctx.beginPath();
  ctx.moveTo(-w / 2, d / 2);
  ctx.lineTo(-w / 2, -d / 2);
  ctx.lineTo(w / 2, -d / 2);
  ctx.lineTo(w / 2, d / 2);
  ctx.lineTo(w / 2 - t, d / 2);
  ctx.lineTo(w / 2 - t, -d / 2 + t);
  ctx.lineTo(-w / 2 + t, -d / 2 + t);
  ctx.lineTo(-w / 2 + t, d / 2);
  ctx.closePath();
  paint(ctx, o.theme.light);
  pen(ctx, o, OUT, o.theme.glass);
  rect(ctx, -w / 2 + t, fz, w / 2 - t, fz + 0.03);
  pen(ctx, o);
  rect(ctx, -w / 2 + t + 0.02, -d / 2 + t + 0.02, w / 2 - t - 0.02, -d / 2 + t + 0.32);
  circle(ctx, 0, BOOTH.stoolZ, 0.17);
  if (roomy(o)) {
    // The door hangs on the left jamb and swings out, so the plan shows the clearance it needs.
    const hx = -w / 2 + t, hy = fz + 0.03, leaf = w - 2 * t;
    line(ctx, hx, hy, hx, hy + leaf);
    pen(ctx, o, FINE, o.theme.muted, DASH);
    ctx.beginPath();
    ctx.arc(hx, hy, leaf, 0, Math.PI / 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ---- Pantry counter -----------------------------------------------------------------

const PANTRY = { top: 0.9, toe: 0.1, upperGap: 0.52, module: 0.6, fridgeW: 0.76 };

function pantryLayout(w, d, h) {
  const fridgeW = w >= 1.6 ? PANTRY.fridgeW : 0;
  const cx0 = -w / 2, cx1 = w / 2 - fridgeW;
  const len = cx1 - cx0;
  const n = repeats(Math.round(len / PANTRY.module));
  const mw = len / n;
  // A middle module holds the sink; a two-module run puts it first so the far end stays free for coffee.
  const sink = n >= 3 ? Math.floor(n / 2) : 0;
  const dish = n >= 3 ? sink + 1 : -1;
  const sinkW = Math.min(0.52, mw - 0.12);
  const sx = cx0 + (sink + 0.5) * mw;
  const coffeeX = cx1 - 0.28;
  return {
    fridgeW, cx0, cx1, n, mw, sink, dish, sinkW, sx, coffeeX,
    zf: d / 2 - 0.05,
    upperD: Math.min(0.34, d * 0.55),
    upperY: Math.min(PANTRY.top + PANTRY.upperGap, h - 0.4),
    sinkZ0: -d / 2 + 0.13,
    sinkZ1: Math.min(d / 2 - 0.04, -d / 2 + 0.13 + clamp(d - 0.29, 0.12, 0.37)),
    // The machine only goes where it clears the sink and the faucet lever beside it.
    coffee: len > 1.2 && d >= 0.55 && coffeeX - 0.14 > sx + sinkW / 2 + 0.05,
  };
}

function buildPantry(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = mats(kit);
  const P = pantryLayout(w, d, h);
  const doors = finish(kit, color, m.sagePaint, 0.5);
  const { top, toe } = PANTRY;
  const ct = 0.03, base = top - ct, zf = P.zf, bowl = 0.2;
  kit.block(g, m.reveal, P.cx0, P.cx1, 0, toe, -d / 2, zf - 0.06);
  const { sx } = P;
  const hole = { x0: sx - P.sinkW / 2, x1: sx + P.sinkW / 2, z0: P.sinkZ0, z1: P.sinkZ1 };
  // The carcass leaves a pocket for the bowl, so the sink reads deep and the back stays closed.
  const p = { x0: hole.x0 - 0.01, x1: hole.x1 + 0.01, z0: hole.z0 - 0.01, z1: Math.min(zf - 0.01, hole.z1 + 0.01) };
  const parts = [
    [P.cx0, p.x0, base, -d / 2, zf], [p.x1, P.cx1, base, -d / 2, zf],
    [p.x0, p.x1, base, -d / 2, p.z0], [p.x0, p.x1, base, p.z1, zf], [p.x0, p.x1, top - bowl - 0.03, p.z0, p.z1],
  ];
  for (const [a, b, y, za, zb] of parts) if (b - a > 0.002 && zb - za > 0.002) kit.block(g, m.casework, a, b, toe, y, za, zb);
  for (let i = 0; i < P.n; i++) {
    const a = P.cx0 + i * P.mw, b = a + P.mw;
    if (i === P.dish) dishwasher(kit, g, m, a, b, toe, base, zf);
    else if (i === 0 && P.n >= 3) drawerStack(kit, g, m, doors, a, b, toe, base, zf);
    else doorModule(kit, g, m, doors, a, b, toe, base, zf, i === P.sink);
  }
  slab(kit, g, m.quartz, P.cx0, P.cx1, base, top, -d / 2, d / 2, hole);
  basin(kit, g, m, hole, top, bowl);
  faucet(kit, g, m, sx, top, -d / 2 + 0.07, Math.min(0.2, (hole.z0 + hole.z1) / 2 + d / 2 - 0.07));
  const uy = P.upperY;
  kit.block(g, m.quartz, P.cx0, P.cx1, top, uy, -d / 2, -d / 2 + 0.012);
  upperRun(kit, g, m, P.cx0, P.cx1, uy, h, -d / 2, -d / 2 + P.upperD, P.n);
  if (P.coffee) coffeeMachine(kit, g, m, P.coffeeX, top, -d / 2 + 0.24);
  if (P.fridgeW) fridgeColumn(kit, g, m, P.cx1, w / 2, h, d, zf);
  return g;
}

function doorModule(kit, g, m, mat, a, b, y0, y1, zf, falseFront) {
  const dt = y1 - 0.17;
  drawerFront(kit, g, m, mat, a, b, dt, y1, zf, falseFront ? 0 : 0.14);
  if (b - a >= 0.5) {
    const c = (a + b) / 2;
    kit.block(g, mat, a + GAP, c - GAP, y0 + GAP, dt - GAP, zf, zf + 0.018);
    kit.block(g, mat, c + GAP, b - GAP, y0 + GAP, dt - GAP, zf, zf + 0.018);
    for (const x of [c - 0.04, c + 0.04]) kit.block(g, m.alu, x - 0.006, x + 0.006, dt - 0.18, dt - 0.05, zf + 0.018, zf + 0.03);
  } else {
    kit.block(g, mat, a + GAP, b - GAP, y0 + GAP, dt - GAP, zf, zf + 0.018);
    kit.block(g, m.alu, b - 0.05, b - 0.038, dt - 0.18, dt - 0.05, zf + 0.018, zf + 0.03);
  }
}

function drawerStack(kit, g, m, mat, a, b, y0, y1, zf) {
  const ys = [y1, y1 - 0.17, y1 - 0.17 - (y1 - 0.17 - y0) / 2, y0];
  for (let i = 0; i < 3; i++) drawerFront(kit, g, m, mat, a, b, ys[i + 1], ys[i], zf, 0.18);
}

function dishwasher(kit, g, m, a, b, y0, y1, zf) {
  kit.block(g, m.steel, a + GAP, b - GAP, y0 + GAP, y1 - GAP, zf, zf + 0.02);
  kit.block(g, m.reveal, a + GAP, b - GAP, y1 - 0.09, y1 - 0.085, zf + 0.02, zf + 0.021);
  kit.block(g, m.chrome, a + 0.05, b - 0.05, y1 - 0.06, y1 - 0.045, zf + 0.02, zf + 0.035);
}

/** Slab with an optional rectangular hole {x0, x1, z0, z1}. */
function slab(kit, g, mat, x0, x1, y0, y1, z0, z1, hole) {
  const parts = hole
    ? [[x0, hole.x0, z0, z1], [hole.x1, x1, z0, z1], [hole.x0, hole.x1, z0, hole.z0], [hole.x0, hole.x1, hole.z1, z1]]
    : [[x0, x1, z0, z1]];
  for (const [a, b, c, e] of parts) if (b - a > 1e-3 && e - c > 1e-3) kit.block(g, mat, a, b, y0, y1, c, e);
}

/** Stainless sink bowl hanging below a hole in a top whose surface is at y. */
function basin(kit, g, m, hole, y, depth) {
  const t = 0.01, yb = y - depth, yt = y - 0.002;
  const { x0, x1, z0, z1 } = hole;
  kit.block(g, m.steel, x0, x1, yb - t, yb, z0, z1);
  kit.block(g, m.steel, x0, x1, yb, yt, z0, z0 + t);
  kit.block(g, m.steel, x0, x1, yb, yt, z1 - t, z1);
  kit.block(g, m.steel, x0, x0 + t, yb, yt, z0 + t, z1 - t);
  kit.block(g, m.steel, x1 - t, x1, yb, yt, z0 + t, z1 - t);
  kit.cyl(g, m.reveal, 0.03, 0.003, (x0 + x1) / 2, yb, (z0 + z1) / 2 - 0.05, { segments: 16 });
}

/** Arched pull-down faucet at (x, z) on a surface at y, its spout `reach` toward +z. */
function faucet(kit, g, m, x, y, z, reach = 0.2) {
  const rise = 0.3;
  kit.cyl(g, m.chrome, 0.028, 0.03, x, y, z, { segments: 16 });
  kit.cyl(g, m.chrome, 0.014, rise, x, y + 0.03, z, { segments: 12 });
  let prev = [x, y + 0.03 + rise, z];
  for (let i = 1; i <= 6; i++) {
    const a = Math.PI * (1 - i / 6);
    const p = [x, y + 0.03 + rise + (reach / 2) * Math.sin(a), z + reach / 2 + (reach / 2) * Math.cos(a)];
    rod(kit, g, m.chrome, 0.013, prev, p, { over: 0.008 });
    prev = p;
  }
  kit.cyl(g, m.chrome, 0.018, 0.07, x, y + rise - 0.04, z + reach, { segments: 12 });
  kit.block(g, m.chrome, x + 0.04, x + 0.05, y + 0.06, y + 0.14, z - 0.01, z + 0.01);
}

function upperRun(kit, g, m, x0, x1, y0, y1, z0, z1, n) {
  const zf = z1 - 0.02;
  kit.block(g, m.casework, x0, x1, y0, y1, z0 + 0.012, zf);
  kit.block(g, m.panelLight, x0 + 0.03, x1 - 0.03, y0 - 0.006, y0, zf - 0.06, zf - 0.03, false);
  const mw = (x1 - x0) / n;
  for (let i = 0; i < n; i++) {
    const a = x0 + i * mw, b = a + mw;
    const halves = mw >= 0.5 ? [[a, (a + b) / 2, 1], [(a + b) / 2, b, -1]] : [[a, b, i % 2 ? 1 : -1]];
    for (const [p, q, hand] of halves) {
      kit.block(g, m.white, p + GAP, q - GAP, y0 + GAP, y1 - GAP, zf, z1);
      const px = hand > 0 ? q - 0.035 : p + 0.035;
      kit.block(g, m.alu, px - 0.006, px + 0.006, y0 + 0.05, y0 + 0.17, z1, z1 + 0.012);
    }
  }
}

function coffeeMachine(kit, g, m, x, y, z) {
  kit.block(g, m.black, x - 0.14, x + 0.14, y, y + 0.4, z - 0.17, z + 0.15);
  kit.block(g, m.steel, x - 0.1, x + 0.1, y, y + 0.02, z + 0.06, z + 0.17);
  kit.block(g, m.reveal, x - 0.08, x + 0.08, y + 0.1, y + 0.26, z + 0.15, z + 0.152, false);
  kit.block(g, m.screen, x - 0.06, x + 0.06, y + 0.3, y + 0.36, z + 0.15, z + 0.153, false);
  kit.cyl(g, m.white, 0.035, 0.09, x, y + 0.02, z + 0.1, { segments: 14 });
}

function fridgeColumn(kit, g, m, x0, x1, h, d, zf) {
  const t = 0.02;
  kit.block(g, m.casework, x0, x0 + t, 0, h, -d / 2, zf + 0.02);
  kit.block(g, m.casework, x1 - t, x1, 0, h, -d / 2, zf + 0.02);
  kit.block(g, m.reveal, x0 + t, x1 - t, 0, PANTRY.toe, -d / 2, zf - 0.04);
  kit.block(g, m.reveal, x0 + t, x1 - t, PANTRY.toe, h - 0.38, -d / 2, zf - 0.005);
  const a = x0 + t, b = x1 - t, split = 0.78, cab = h - 0.38;
  kit.block(g, m.steel, a + GAP, b - GAP, PANTRY.toe + GAP, split - GAP, zf - 0.005, zf + 0.02);
  kit.block(g, m.steel, a + GAP, b - GAP, split + GAP, cab - GAP, zf - 0.005, zf + 0.02);
  kit.block(g, m.chrome, a + 0.12, b - 0.12, split - 0.09, split - 0.07, zf + 0.02, zf + 0.045);
  kit.block(g, m.chrome, a + 0.05, a + 0.07, split + 0.18, cab - 0.25, zf + 0.02, zf + 0.045);
  kit.block(g, m.casework, a, b, cab, h, -d / 2, zf - 0.005);
  kit.block(g, m.white, a + GAP, b - GAP, cab + GAP, h - GAP, zf - 0.005, zf + 0.015);
  kit.block(g, m.alu, (a + b) / 2 - 0.06, (a + b) / 2 + 0.06, cab + 0.05, cab + 0.062, zf + 0.015, zf + 0.027);
}

function drawPantry(ctx, o) {
  const { w, d, h } = o;
  const P = pantryLayout(w, d, h);
  pen(ctx, o, OUT);
  rect(ctx, P.cx0, -d / 2, P.cx1, d / 2, o.theme.fill);
  pen(ctx, o);
  const { sx } = P;
  rrect(ctx, sx - P.sinkW / 2, P.sinkZ0, sx + P.sinkW / 2, P.sinkZ1, 0.04);
  if (roomy(o)) {
    rrect(ctx, sx - P.sinkW / 2 + 0.025, P.sinkZ0 + 0.025, sx + P.sinkW / 2 - 0.025, P.sinkZ1 - 0.025, 0.03);
    circle(ctx, sx, -d / 2 + 0.07, 0.025);
    line(ctx, sx, -d / 2 + 0.07, sx, -d / 2 + 0.27);
    if (P.coffee) rect(ctx, P.coffeeX - 0.14, -d / 2 + 0.07, P.coffeeX + 0.14, -d / 2 + 0.39);
  }
  pen(ctx, o, FINE, o.theme.muted, DASH);
  line(ctx, P.cx0, -d / 2 + P.upperD, P.cx1, -d / 2 + P.upperD);
  ctx.setLineDash([]);
  if (P.fridgeW) {
    pen(ctx, o, OUT);
    rect(ctx, P.cx1, -d / 2, w / 2, d / 2, o.theme.fill);
    pen(ctx, o);
    const a = P.cx1 + 0.02, b = w / 2 - 0.02;
    rect(ctx, a, -d / 2 + 0.02, b, P.zf - 0.005);
    line(ctx, a, P.zf + 0.02, b, P.zf + 0.02);
    if (roomy(o)) {
      pen(ctx, o, FINE, o.theme.muted);
      line(ctx, a, -d / 2 + 0.02, b, P.zf - 0.005);
      line(ctx, b, -d / 2 + 0.02, a, P.zf - 0.005);
    }
  }
}

// ---- Media display ------------------------------------------------------------------

const MEDIA = { legH: 0.12, top: 0.62, screenW: 1.44, screenY: 0.77 };

function buildMedia(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = mats(kit);
  const doors = finish(kit, color, m.sagePaint, 0.5);
  const zf = d / 2 - 0.035, { legH, top } = MEDIA;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) kit.block(g, m.frame, sx * (w / 2 - 0.08) - 0.02, sx * (w / 2 - 0.08) + 0.02, 0, legH, sz * (d / 2 - 0.08) - 0.02, sz * (d / 2 - 0.08) + 0.02);
  }
  kit.block(g, m.oak, -w / 2, w / 2, legH, top, -d / 2 + 0.06, zf);
  kit.block(g, m.oak, -w / 2, w / 2, top - 0.02, top, -d / 2 + 0.05, d / 2 - 0.01);
  const n = Math.max(2, Math.round((w - 0.04) / 0.45)), dw = (w - 0.04) / n;
  for (let i = 0; i < n; i++) {
    const a = -w / 2 + 0.02 + i * dw;
    kit.block(g, doors, a + GAP, a + dw - GAP, legH + 0.02, top - 0.035, zf, zf + 0.018);
    const px = i % 2 ? a + 0.035 : a + dw - 0.035;
    kit.block(g, m.alu, px - 0.006, px + 0.006, top - 0.2, top - 0.07, zf + 0.018, zf + 0.03);
  }
  const sw = Math.min(MEDIA.screenW, w - 0.2), sh = sw * 0.5625, sy = Math.min(MEDIA.screenY, h - sh - 0.01), z0 = -d / 2;
  kit.block(g, m.frame, -0.25, 0.25, sy + 0.15, sy + sh - 0.15, z0, z0 + 0.015);
  kit.block(g, m.black, -sw / 2, sw / 2, sy, sy + sh, z0 + 0.015, z0 + 0.05);
  kit.block(g, m.screen, -sw / 2 + 0.008, sw / 2 - 0.008, sy + 0.012, sy + sh - 0.008, z0 + 0.05, z0 + 0.053, false);
  kit.block(g, m.black, -0.45, 0.45, top, top + 0.07, z0 + 0.09, z0 + 0.19);
  kit.block(g, m.reveal, -0.44, 0.44, top + 0.012, top + 0.058, z0 + 0.19, z0 + 0.192, false);
  kit.block(g, kit.material(BOOKS[0], { roughness: 0.7 }), -w / 2 + 0.12, -w / 2 + 0.38, top, top + 0.03, z0 + 0.22, z0 + 0.4);
  kit.block(g, kit.material(BOOKS[3], { roughness: 0.7 }), -w / 2 + 0.14, -w / 2 + 0.36, top + 0.03, top + 0.055, z0 + 0.24, z0 + 0.39);
  kit.cyl(g, m.white, 0.05, 0.2, w / 2 - 0.2, top, z0 + 0.3, { rTop: 0.035, segments: 16 });
  return g;
}

function drawMedia(ctx, o) {
  const { w, d } = o;
  outline(ctx, o);
  pen(ctx, o);
  line(ctx, -w / 2, d / 2 - 0.035, w / 2, d / 2 - 0.035);
  const sw = Math.min(MEDIA.screenW, w - 0.2);
  rect(ctx, -sw / 2, -d / 2 + 0.015, sw / 2, -d / 2 + 0.053, o.theme.line);
  if (roomy(o)) {
    pen(ctx, o, FINE, o.theme.muted);
    rect(ctx, -0.45, -d / 2 + 0.09, 0.45, -d / 2 + 0.19);
    circle(ctx, w / 2 - 0.2, -d / 2 + 0.3, 0.05);
  }
}

// ---- Column -------------------------------------------------------------------------

function buildColumn(kit, { w, d, h, color }) {
  const g = kit.group();
  const paint = finish(kit, color, kit.material('#eeeeea', { roughness: 0.7 }), 0.7);
  kit.block(g, kit.material('#5d6466', { roughness: 0.8 }), -w / 2, w / 2, 0, 0.1, -d / 2, d / 2);
  kit.block(g, paint, -w / 2 + 0.006, w / 2 - 0.006, 0.1, h, -d / 2 + 0.006, d / 2 - 0.006);
  return g;
}

function drawColumn(ctx, o) {
  pen(ctx, o, OUT);
  rect(ctx, -o.w / 2, -o.d / 2, o.w / 2, o.d / 2, o.theme.line);
}

// ---- Plant and planter --------------------------------------------------------------

function buildPlant(kit, { w, d, h, color }) {
  const g = kit.group();
  const pot = finish(kit, color, kit.mat.potWhite, 0.6);
  const R = Math.min(w, d) / 2;
  kit.cyl(g, pot, 0.16, 0.4, 0, 0, 0, { rTop: 0.2, segments: 28 });
  kit.cyl(g, pot, 0.215, 0.035, 0, 0.395, 0, { rTop: 0.215, segments: 28 });
  kit.cyl(g, kit.mat.soil, 0.195, 0.01, 0, 0.415, 0, { segments: 24 });
  const trunk = kit.material('#6b5a45', { roughness: 0.9 });
  rod(kit, g, trunk, 0.018, [0, 0.42, 0], [0.03, 0.95, -0.02]);
  rod(kit, g, trunk, 0.012, [0.01, 0.7, 0], [-0.12, 1.02, 0.05]);
  rod(kit, g, trunk, 0.012, [0.02, 0.8, -0.01], [0.13, 1.1, 0.06]);
  const leaves = LEAVES.map((c) => kit.material(c, { roughness: 0.8 }));
  const rnd = seq(23);
  const y0 = 0.62, yc = (y0 + h) / 2, hh = (h - y0) / 2;
  for (let i = 0; i < 24; i++) {
    const r = 0.09 + rnd() * 0.05;
    const y = y0 + r * 0.6 + (i / 23) * (h - y0 - r * 1.4);
    const k = Math.sqrt(Math.max(0, 1 - ((y - yc) / hh) ** 2));
    const lim = R - r - 0.005;
    const spread = Math.min(lim, (R - 0.06) * (0.35 + 0.65 * k) * (0.75 + rnd() * 0.25));
    const a = i * 2.39996 + rnd() * 0.4;
    kit.sphere(g, leaves[i % leaves.length], r, clamp(spread * Math.cos(a), -lim, lim), y, clamp(spread * Math.sin(a), -lim, lim), { segments: 12, scaleY: 0.8 });
  }
  return g;
}

function drawPlant(ctx, o) {
  const R = Math.min(o.w, o.d) / 2;
  zone(ctx, o);
  pen(ctx, o, FINE, o.theme.muted);
  circle(ctx, 0, 0, 0.215);
  pen(ctx, o, OUT);
  drawFoliage(ctx, o, 0, 0, R - 0.01, 9, 3);
}

function planterLayout(w, d) {
  const n = repeats(Math.round((w - 0.1) / 0.22), 2);
  return { n, pitch: (w - 0.1) / n, rim: 0.03, r: clamp(d * 0.3, 0.09, 0.18) };
}

/** Two staggered rows of shrubs along the planter. */
function planterBushes(w, d, L) {
  const out = [];
  for (let i = 0; i < L.n; i++) {
    const x = -w / 2 + 0.05 + L.pitch * (i + 0.5);
    out.push({ x, z: -d * 0.12, r: L.r });
    if (i < L.n - 1) out.push({ x: x + L.pitch / 2, z: d * 0.12, r: L.r * 0.9 });
  }
  return out;
}

function buildPlanter(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = mats(kit);
  const box = finish(kit, color, kit.material('#3e4548', { roughness: 0.55, metalness: 0.2 }), 0.55);
  const L = planterLayout(w, d);
  const bh = Math.min(0.6, h * 0.66);
  kit.block(g, m.reveal, -w / 2 + 0.03, w / 2 - 0.03, 0, 0.04, -d / 2 + 0.03, d / 2 - 0.03);
  kit.block(g, box, -w / 2, w / 2, 0.04, bh - 0.02, -d / 2, d / 2);
  kit.block(g, box, -w / 2, w / 2, bh - 0.02, bh, -d / 2, -d / 2 + L.rim);
  kit.block(g, box, -w / 2, w / 2, bh - 0.02, bh, d / 2 - L.rim, d / 2);
  kit.block(g, box, -w / 2, -w / 2 + L.rim, bh - 0.02, bh, -d / 2 + L.rim, d / 2 - L.rim);
  kit.block(g, box, w / 2 - L.rim, w / 2, bh - 0.02, bh, -d / 2 + L.rim, d / 2 - L.rim);
  kit.block(g, kit.mat.soil, -w / 2 + L.rim, w / 2 - L.rim, bh - 0.035, bh - 0.025, -d / 2 + L.rim, d / 2 - L.rim);
  const leaves = LEAVES.map((c) => kit.material(c, { roughness: 0.8 }));
  const rnd = seq(31);
  const lim = d / 2 - L.rim;
  for (const bush of planterBushes(w, d, L)) {
    const r = Math.min(bush.r * (0.85 + rnd() * 0.3), lim);
    const z = clamp(bush.z, -lim + r, lim - r);
    const x = clamp(bush.x, -w / 2 + L.rim + r, w / 2 - L.rim - r);
    const y = Math.min(bh - 0.02 + r * (0.45 + rnd() * 0.35), h - r * 0.75);
    kit.sphere(g, pick(rnd, leaves), r, x, y, z, { segments: 12, scaleY: 0.75 });
  }
  return g;
}

function drawPlanter(ctx, o) {
  const L = planterLayout(o.w, o.d);
  outline(ctx, o);
  pen(ctx, o);
  rect(ctx, -o.w / 2 + L.rim, -o.d / 2 + L.rim, o.w / 2 - L.rim, o.d / 2 - L.rim);
  const lim = o.d / 2 - L.rim;
  planterBushes(o.w, o.d, L).forEach((b, i) => {
    const r = Math.min(b.r, lim);
    pen(ctx, o);
    drawFoliage(ctx, o, b.x, clamp(b.z, -lim + r, lim - r), r, 7, i + 2);
  });
}

// ---- Area rug -----------------------------------------------------------------------

function rugLayout(w, d) {
  const band = clamp(Math.min(w, d) * 0.07, 0.06, 0.16);
  return { band, line: band + clamp(Math.min(w, d) * 0.04, 0.03, 0.08) };
}

function buildRug(kit, { w, d, h, color }) {
  const g = kit.group();
  const field = finish(kit, color, kit.material('#bcc7c0', { roughness: 1 }), 1);
  const border = kit.material('#538184', { roughness: 1 });
  const stripe = kit.material('#dbd99a', { roughness: 1 });
  const R = rugLayout(w, d);
  const t = Math.max(0.004, h), b = R.band;
  kit.block(g, field, -w / 2 + b, w / 2 - b, 0, t * 0.9, -d / 2 + b, d / 2 - b, false);
  kit.block(g, border, -w / 2, w / 2, 0, t, -d / 2, -d / 2 + b, false);
  kit.block(g, border, -w / 2, w / 2, 0, t, d / 2 - b, d / 2, false);
  kit.block(g, border, -w / 2, -w / 2 + b, 0, t, -d / 2 + b, d / 2 - b, false);
  kit.block(g, border, w / 2 - b, w / 2, 0, t, -d / 2 + b, d / 2 - b, false);
  const s = R.line, k = 0.012;
  kit.block(g, stripe, -w / 2 + s, w / 2 - s, 0, t * 0.95, -d / 2 + s, -d / 2 + s + k, false);
  kit.block(g, stripe, -w / 2 + s, w / 2 - s, 0, t * 0.95, d / 2 - s - k, d / 2 - s, false);
  kit.block(g, stripe, -w / 2 + s, -w / 2 + s + k, 0, t * 0.95, -d / 2 + s + k, d / 2 - s - k, false);
  kit.block(g, stripe, w / 2 - s - k, w / 2 - s, 0, t * 0.95, -d / 2 + s + k, d / 2 - s - k, false);
  return g;
}

function drawRug(ctx, o) {
  const R = rugLayout(o.w, o.d);
  outline(ctx, o);
  pen(ctx, o, FINE, o.theme.muted);
  rect(ctx, -o.w / 2 + R.band, -o.d / 2 + R.band, o.w / 2 - R.band, o.d / 2 - R.band);
  if (roomy(o)) rect(ctx, -o.w / 2 + R.line, -o.d / 2 + R.line, o.w / 2 - R.line, o.d / 2 - R.line);
}

// ---- Printer and copier -------------------------------------------------------------

function buildPrinter(kit, { w, d, color }) {
  const g = kit.group();
  const m = mats(kit);
  const body = finish(kit, color, kit.material('#eef0ef', { roughness: 0.45 }), 0.45);
  const trim = kit.material('#cdd2d3', { roughness: 0.5 });
  const x0 = -w / 2 + 0.01, x1 = w / 2 - 0.01, z0 = -d / 2 + 0.02, zf = d / 2 - 0.06;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) kit.cyl(g, m.rubber, 0.022, 0.022, sx * (w / 2 - 0.06), 0.022, sz * (d / 2 - 0.08), { axis: 'z', segments: 10 });
  kit.block(g, m.reveal, x0 + 0.02, x1 - 0.02, 0.03, 0.06, z0 + 0.02, zf - 0.02);
  kit.block(g, trim, x0 + 0.01, x1 - 0.01, 0.06, 0.5, z0, zf - 0.01);
  for (const [a, b] of [[0.07, 0.28], [0.29, 0.49]]) {
    kit.block(g, body, x0 + 0.015, x1 - 0.015, a, b, zf - 0.01, zf + 0.01);
    kit.block(g, m.reveal, -0.08, 0.08, b - 0.04, b - 0.025, zf + 0.01, zf + 0.012, false);
  }
  kit.block(g, body, x0, x1, 0.5, 0.86, z0, zf);
  kit.block(g, body, x0 + 0.005, x1 - 0.005, 0.52, 0.84, zf, zf + 0.012);
  kit.block(g, trim, x0 + 0.02, x0 + 0.06, 0.56, 0.8, zf + 0.012, zf + 0.016);
  kit.block(g, m.reveal, x0 + 0.02, x1 - 0.17, 0.86, 0.95, z0 + 0.02, zf - 0.04);
  kit.block(g, body, x1 - 0.17, x1, 0.86, 0.95, z0, zf);
  kit.block(g, body, x0, x1 - 0.17, 0.86, 0.95, z0, z0 + 0.05);
  kit.block(g, m.paper, x0 + 0.06, x1 - 0.24, 0.865, 0.88, z0 + 0.08, zf - 0.08);
  kit.block(g, body, x0, x1, 0.95, 1.06, z0, zf - 0.02);
  kit.block(g, trim, x0 + 0.02, x1 - 0.06, 1.06, 1.12, z0 + 0.03, zf - 0.1);
  const tray = sub(kit, g, -0.02, 1.12, zf - 0.12, { pitch: 0.12 });
  kit.block(tray, trim, -0.2, 0.2, 0, 0.012, -0.3, 0);
  kit.block(tray, m.paper, -0.15, 0.15, 0.012, 0.03, -0.27, -0.03);
  const panel = sub(kit, g, 0.12, 1.0, zf - 0.04, { pitch: 0.55 });
  kit.block(panel, m.black, -0.14, 0.14, -0.012, 0, 0, 0.1);
  kit.block(panel, m.screen, -0.1, 0.1, 0, 0.003, 0.015, 0.085, false);
  kit.block(g, m.accent, x1 - 0.06, x1 - 0.04, 0.985, 0.995, zf - 0.02, zf - 0.015, false);
  return g;
}

function drawPrinter(ctx, o) {
  const { w, d } = o;
  const x0 = -w / 2 + 0.01, x1 = w / 2 - 0.01, z0 = -d / 2 + 0.02, zf = d / 2 - 0.06;
  pen(ctx, o, OUT);
  rect(ctx, x0, z0, x1, zf + 0.012, o.theme.fill);
  pen(ctx, o);
  rect(ctx, x0 + 0.02, z0 + 0.03, x1 - 0.06, zf - 0.1);
  posed(ctx, 0.12, zf - 0.04, 0, () => rect(ctx, -0.14, 0, 0.14, 0.086));
  if (roomy(o)) {
    pen(ctx, o, FINE, o.theme.muted);
    rect(ctx, -0.17, z0 + 0.08, 0.13, zf - 0.13);
  }
}

// ---- Waste and recycling ------------------------------------------------------------

const BINS = [{ lid: '#2f6f9f', hole: 'round' }, { lid: '#3e7d55', hole: 'slot' }];

function buildBins(kit, { w, d, h }) {
  const g = kit.group();
  const m = mats(kit);
  const body = kit.material('#d9dddd', { roughness: 0.35, metalness: 0.5 });
  const bw = (w - 0.02) / 2;
  BINS.forEach((b, i) => {
    const x0 = -w / 2 + i * (bw + 0.02), x1 = x0 + bw, cx = (x0 + x1) / 2;
    const lid = kit.material(b.lid, { roughness: 0.5 });
    kit.block(g, m.reveal, x0 + 0.02, x1 - 0.02, 0, 0.02, -d / 2 + 0.02, d / 2 - 0.02);
    kit.block(g, body, x0 + 0.008, x1 - 0.008, 0.02, h - 0.05, -d / 2 + 0.008, d / 2 - 0.008);
    kit.block(g, lid, x0, x1, h - 0.05, h - 0.012, -d / 2, d / 2);
    kit.block(g, lid, x0 + 0.02, x1 - 0.02, h - 0.012, h, -d / 2 + 0.02, d / 2 - 0.02);
    if (b.hole === 'round') kit.cyl(g, m.black, 0.075, 0.004, cx, h - 0.002, 0, { segments: 24 });
    else kit.block(g, m.black, cx - 0.12, cx + 0.12, h - 0.002, h + 0.002, -0.025, 0.025);
    kit.block(g, lid, x0 + 0.06, x1 - 0.06, h - 0.32, h - 0.2, d / 2 - 0.008, d / 2 - 0.004, false);
  });
  return g;
}

function drawBins(ctx, o) {
  const { w, d } = o;
  const bw = (w - 0.02) / 2;
  BINS.forEach((b, i) => {
    const x0 = -w / 2 + i * (bw + 0.02), x1 = x0 + bw, cx = (x0 + x1) / 2;
    pen(ctx, o, OUT);
    rrect(ctx, x0, -d / 2, x1, d / 2, 0.02, o.theme.fill);
    pen(ctx, o);
    if (b.hole === 'round') circle(ctx, cx, 0, 0.075);
    else rect(ctx, cx - 0.12, -0.025, cx + 0.12, 0.025);
  });
}

// ---- Toilet -------------------------------------------------------------------------

const WC = { tankZ0: 0.02, tankD: 0.19, bowlZ: 0.07, rx: 0.19, rz: 0.26 };

function buildToilet(kit, { d, h }) {
  const g = kit.group();
  const m = mats(kit);
  const p = m.porcelain;
  const tz0 = -d / 2 + WC.tankZ0, tz1 = tz0 + WC.tankD;
  kit.block(g, p, -0.21, 0.21, 0.42, h - 0.03, tz0, tz1);
  kit.block(g, p, -0.225, 0.225, h - 0.03, h, tz0 - 0.01, tz1 + 0.012);
  kit.block(g, m.chrome, -0.2, -0.15, h - 0.12, h - 0.1, tz1, tz1 + 0.02);
  kit.block(g, p, -0.11, 0.11, 0.2, 0.43, tz1 - 0.04, tz1 + 0.08);
  const e = WC.rz / WC.rx;
  kit.cyl(g, p, 0.12, 0.3, 0, 0, WC.bowlZ - 0.02, { rTop: 0.15, segments: 28 }).scale.z = e;
  kit.cyl(g, p, 0.155, 0.1, 0, 0.3, WC.bowlZ, { rTop: WC.rx, segments: 32 }).scale.z = e;
  kit.cyl(g, kit.material('#c3d3d7', { roughness: 0.1 }), 0.12, 0.004, 0, 0.36, WC.bowlZ + 0.01, { segments: 28 }).scale.z = e * 0.95;
  const seat = kit.torus(g, m.white, 0.155, 0.03, 0, 0.415, WC.bowlZ);
  seat.scale.set(1, e * 0.98, 0.45);
  kit.block(g, m.chrome, -0.09, 0.09, 0.4, 0.43, tz1 + 0.02, tz1 + 0.05);
  return g;
}

function drawToilet(ctx, o) {
  const { d } = o;
  const tz0 = -d / 2 + WC.tankZ0;
  zone(ctx, o);
  pen(ctx, o, OUT);
  ellipse(ctx, 0, WC.bowlZ, WC.rx, WC.rz, o.theme.fill);
  rrect(ctx, -0.225, tz0 - 0.01, 0.225, tz0 + WC.tankD + 0.012, 0.025, o.theme.fill);
  pen(ctx, o);
  ellipse(ctx, 0, WC.bowlZ + 0.01, WC.rx * 0.62, WC.rz * 0.62);
}

// ---- Restroom vanity ----------------------------------------------------------------

function vanityLayout(w, d) {
  const n = repeats(Math.round(w / 0.61));
  return { n, pitch: w / n, bowlZ: clamp(d * 0.08, 0, 0.06), r: Math.min(0.19, w / n / 2 - 0.06, d * 0.35) };
}

function buildVanity(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = mats(kit);
  const V = vanityLayout(w, d);
  const apron = finish(kit, color, m.oak, 0.55);
  const t = 0.04;
  kit.block(g, m.quartz, -w / 2, w / 2, h - t, h, -d / 2, d / 2);
  kit.block(g, apron, -w / 2, w / 2, h - 0.22, h - t, d / 2 - 0.03, d / 2 - 0.005);
  kit.block(g, apron, -w / 2, -w / 2 + 0.03, h - 0.22, h - t, -d / 2, d / 2 - 0.03);
  kit.block(g, apron, w / 2 - 0.03, w / 2, h - 0.22, h - t, -d / 2, d / 2 - 0.03);
  kit.block(g, m.quartz, -w / 2, w / 2, h, h + 0.1, -d / 2, -d / 2 + 0.015);
  const inner = kit.material('#e3e6e5', { roughness: 0.2 });
  for (let i = 0; i < V.n; i++) {
    const x = -w / 2 + V.pitch * (i + 0.5);
    kit.cyl(g, m.porcelain, V.r * 0.7, 0.12, x, h, V.bowlZ, { rTop: V.r, segments: 28 });
    kit.cyl(g, inner, V.r * 0.88, 0.004, x, h + 0.1, V.bowlZ, { segments: 28 });
    const fz = -d / 2 + 0.06;
    kit.cyl(g, m.chrome, 0.02, 0.025, x, h, fz, { segments: 14 });
    kit.cyl(g, m.chrome, 0.012, 0.25, x, h + 0.025, fz, { segments: 12 });
    kit.block(g, m.chrome, x - 0.012, x + 0.012, h + 0.25, h + 0.27, fz, V.bowlZ - V.r * 0.35);
    if (V.pitch > 0.5) kit.cyl(g, m.chrome, 0.018, 0.12, x + V.r + 0.07, h, fz + 0.01, { segments: 12, rTop: 0.014 });
  }
  const legs = repeats(Math.ceil(w / 1.5) + 1, 2);
  for (let i = 0; i < legs; i++) {
    const x = -w / 2 + 0.07 + (i * (w - 0.14)) / (legs - 1);
    kit.cyl(g, m.steel, 0.019, h - 0.22, x, 0, d / 2 - 0.07, { segments: 14 });
  }
  const my0 = h + 0.25, my1 = h + 1.05;
  kit.block(g, m.frame, -w / 2 + 0.03, w / 2 - 0.03, my0, my1, -d / 2, -d / 2 + 0.012);
  kit.block(g, m.mirror, -w / 2 + 0.045, w / 2 - 0.045, my0 + 0.015, my1 - 0.015, -d / 2 + 0.012, -d / 2 + 0.018);
  return g;
}

function drawVanity(ctx, o) {
  const { w, d } = o;
  const V = vanityLayout(w, d);
  outline(ctx, o);
  pen(ctx, o);
  for (let i = 0; i < V.n; i++) {
    const x = -w / 2 + V.pitch * (i + 0.5);
    ellipse(ctx, x, V.bowlZ, V.r, V.r);
    if (roomy(o)) {
      ellipse(ctx, x, V.bowlZ, V.r * 0.7, V.r * 0.7);
      circle(ctx, x, -d / 2 + 0.06, 0.02);
    }
  }
  pen(ctx, o, FINE, o.theme.muted, DASH);
  line(ctx, -w / 2 + 0.03, -d / 2 + 0.03, w / 2 - 0.03, -d / 2 + 0.03);
  ctx.setLineDash([]);
}

// ---- Registration -------------------------------------------------------------------

registerItems([
  fixed({
    type: 'workstation', name: 'Workstation', category: 'office', colorable: true,
    w: 1.52, d: 1.37, h: 1.2,
    tags: ['desk', 'workstation', 'cubicle', 'monitor', 'open office'],
    build: buildWorkstation, draw2d: drawWorkstation,
  }),
  {
    type: 'desk', name: 'Desk', category: 'office',
    w: 1.52, d: 0.76, h: 0.74, resizable: true,
    tags: ['desk', 'table', 'worksurface', 'pedestal'],
    build: buildDesk, draw2d: drawDesk,
  },
  fixed({
    type: 'task-chair', name: 'Task chair', category: 'office', colorable: true, planFill: false, contactShadow: 'round',
    w: 0.66, d: 0.66, h: 1.05,
    tags: ['chair', 'seating', 'office chair', 'swivel'],
    build: buildTaskChair, draw2d: drawTaskChair,
  }),
  fixed({
    type: 'benching-4', name: 'Benching (4 seats)', category: 'office', colorable: true, contactShadow: false,
    w: 3.05, d: 2.9, h: 1.2,
    tags: ['bench', 'desk', 'open office', 'workstation', 'hot desk'],
    build: buildBenching, draw2d: drawBenching,
  }),
  fixed({
    type: 'executive-desk', name: 'Private office desk', category: 'office',
    w: 1.83, d: 1.83, h: 0.74,
    tags: ['desk', 'l-shaped', 'executive', 'private office', 'return'],
    build: buildExecutiveDesk, draw2d: drawExecutiveDesk,
  }),
  fixed({
    type: 'conference-table-6', name: 'Conference table (6)', category: 'office', contactShadow: false,
    w: 3.05, d: 2.44, h: 0.75,
    tags: ['meeting', 'conference', 'table', 'boardroom', 'huddle'],
    build: buildConference(6), draw2d: drawConference(6),
  }),
  fixed({
    type: 'conference-table-10', name: 'Conference table (10)', category: 'office', contactShadow: false,
    w: 4.88, d: 2.74, h: 0.75,
    tags: ['meeting', 'conference', 'table', 'boardroom'],
    build: buildConference(10), draw2d: drawConference(10),
  }),
  fixed({
    type: 'round-table-4', name: 'Round table (4)', category: 'office', planFill: false, contactShadow: 'round',
    w: 1.83, d: 1.83, h: 0.75,
    tags: ['table', 'round', 'meeting', 'cafe', 'breakout'],
    build: buildRoundTable, draw2d: drawRoundTable,
  }),
  fixed({
    type: 'sofa', name: 'Sofa', category: 'office', colorable: true,
    w: 2.13, d: 0.91, h: 0.84,
    tags: ['sofa', 'couch', 'lounge', 'seating', 'reception'],
    build: buildSofa, draw2d: drawSofa,
  }),
  fixed({
    type: 'lounge-chair', name: 'Lounge chair', category: 'office', colorable: true,
    w: 0.86, d: 0.86, h: 0.84,
    tags: ['armchair', 'lounge', 'seating', 'club chair'],
    build: buildLounge, draw2d: drawLounge,
  }),
  fixed({
    type: 'coffee-table', name: 'Coffee table', category: 'office',
    w: 1.22, d: 0.61, h: 0.41,
    tags: ['table', 'lounge', 'low table', 'reception'],
    build: buildCoffeeTable, draw2d: drawCoffeeTable,
  }),
  fixed({
    type: 'filing-cabinet', name: 'Lateral file', category: 'office',
    w: 0.91, d: 0.51, h: 1.32,
    tags: ['filing', 'cabinet', 'storage', 'drawers'],
    build: buildFiling, draw2d: drawFiling,
  }),
  fixed({
    type: 'bookshelf', name: 'Bookshelf', category: 'office',
    w: 0.91, d: 0.36, h: 1.83,
    tags: ['shelving', 'books', 'storage', 'library'],
    build: buildBookshelf, draw2d: drawBookshelf,
  }),
  fixed({
    type: 'phone-booth', name: 'Phone booth', category: 'office', colorable: true,
    w: 1.07, d: 1.07, h: 2.29,
    tags: ['booth', 'pod', 'focus room', 'acoustic', 'call'],
    build: buildPhoneBooth, draw2d: drawPhoneBooth,
  }),
  {
    type: 'pantry-counter', name: 'Pantry counter', category: 'office',
    w: 3.05, d: 0.66, h: 2.13, resizable: true,
    tags: ['kitchen', 'pantry', 'break room', 'sink', 'fridge'],
    build: buildPantry, draw2d: drawPantry,
  },
  fixed({
    type: 'tv-display', name: 'Media display', category: 'office',
    w: 1.83, d: 0.46, h: 1.6,
    tags: ['tv', 'screen', 'display', 'credenza', 'av'],
    build: buildMedia, draw2d: drawMedia,
  }),
  {
    type: 'column', name: 'Column', category: 'general',
    w: 0.61, d: 0.61, h: 2.9, resizable: true, resizableHeight: true,
    tags: ['column', 'structure', 'pillar', 'post'],
    build: buildColumn, draw2d: drawColumn,
  },
  fixed({
    type: 'plant', name: 'Floor plant', category: 'general', planFill: false, contactShadow: 'round',
    w: 0.61, d: 0.61, h: 1.52,
    tags: ['plant', 'greenery', 'biophilic', 'tree'],
    build: buildPlant, draw2d: drawPlant,
  }),
  {
    type: 'planter', name: 'Planter box', category: 'general',
    w: 1.83, d: 0.46, h: 0.91, resizable: true,
    tags: ['planter', 'greenery', 'divider', 'biophilic'],
    build: buildPlanter, draw2d: drawPlanter,
  },
  {
    type: 'area-rug', name: 'Area rug', category: 'general', colorable: true,
    w: 2.44, d: 1.83, h: 0.01, resizable: true, blocking: false,
    tags: ['rug', 'carpet', 'lounge', 'floor'],
    build: buildRug, draw2d: drawRug,
  },
  fixed({
    type: 'printer', name: 'Printer and copier', category: 'general',
    w: 0.66, d: 0.66, h: 1.17,
    tags: ['printer', 'copier', 'mfp', 'scanner'],
    build: buildPrinter, draw2d: drawPrinter,
  }),
  fixed({
    type: 'trash-recycling', name: 'Waste and recycling', category: 'general',
    w: 0.76, d: 0.41, h: 0.91,
    tags: ['trash', 'recycling', 'bin', 'waste'],
    build: buildBins, draw2d: drawBins,
  }),
  fixed({
    type: 'toilet', name: 'Toilet', category: 'general',
    w: 0.51, d: 0.71, h: 0.79,
    tags: ['toilet', 'wc', 'restroom', 'plumbing'],
    build: buildToilet, draw2d: drawToilet,
  }),
  {
    type: 'vanity', name: 'Restroom vanity', category: 'general',
    w: 1.22, d: 0.56, h: 0.86, resizable: true,
    tags: ['vanity', 'sink', 'restroom', 'lavatory', 'mirror'],
    build: buildVanity, draw2d: drawVanity,
  },
]);
