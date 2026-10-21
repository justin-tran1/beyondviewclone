// Medical office catalog: exam rooms, reception and waiting, patient care and imaging.
// Local frame: x = width, y = up, z = depth with the front facing +z (plan +y).
import { registerItems } from './registry.js';

const TOP = 0.9;        // casework counter height
const DESK = 0.74;      // work surface height
const TOE = 0.1;        // toe kick height
const GAP = 0.004;      // half the reveal between fronts
const FRONT_T = 0.018;  // door and drawer front thickness
const OUT = 1.25;       // plan outline weight in px
const FINE = 0.75;      // plan detail weight in px
const DASH = [4, 3];    // hidden or overhead elements, in px

const VINYL = '#538184';            // clinical upholstery (sage)
const GLOVES = ['#80bbad', '#538184', '#032842'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const custom = (color) => (typeof color === 'string' && color ? color : null);
const span = (a, b) => (a < b ? [a, b] : [b, a]);

// ---- Materials ----------------------------------------------------------------------

function palette(kit) {
  return {
    white: kit.mat.white,
    case: kit.mat.casework,
    quartz: kit.mat.quartz,
    laminate: kit.mat.laminate,
    steel: kit.mat.steel,
    darkSteel: kit.mat.darkSteel,
    chrome: kit.mat.chrome,
    black: kit.mat.black,
    rubber: kit.mat.rubber,
    screen: kit.mat.screen,
    led: kit.mat.led,
    oak: kit.mat.oak,
    status: kit.mat.accentGreen,
    reveal: kit.material('#8d969a', { roughness: 0.85 }),
    plinth: kit.material('#3b4246', { roughness: 0.85 }),
    trim: kit.material('#dfe3e3', { roughness: 0.45 }),
    shell: kit.material('#eef0ef', { roughness: 0.38 }),
    slot: kit.material('#2a2f33', { roughness: 0.9 }),
    alu: kit.material('#a9b1b5', { roughness: 0.35, metalness: 0.6 }),
    sharps: kit.material('#b8322d', { roughness: 0.5 }),
  };
}

/** The item's main finish: the user's color when given, otherwise the default material. */
function finish(kit, color, fallback, roughness = 0.6) {
  const c = custom(color);
  return c ? kit.material(c, { roughness }) : fallback;
}

const vinyl = (kit, color) => finish(kit, color, kit.material(VINYL, { roughness: 0.5 }), 0.5);

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

/** Upholstered pad: a body plus an inset crown on its top (face 'y') or front (face 'z'). */
function pad(kit, g, mat, x0, x1, y0, y1, z0, z1, face = 'y') {
  const i = 0.012;
  if (face === 'y') {
    const c = Math.min(0.014, (y1 - y0) * 0.3);
    kit.block(g, mat, x0, x1, y0, y1 - c, z0, z1);
    kit.block(g, mat, x0 + i, x1 - i, y1 - c, y1, z0 + i, z1 - i);
  } else {
    const c = Math.min(0.014, (z1 - z0) * 0.3);
    kit.block(g, mat, x0, x1, y0, y1, z0, z1 - c);
    kit.block(g, mat, x0 + i, x1 - i, y0 + i, y1 - i, z1 - c, z1);
  }
}

/** Door or drawer front whose face is at z, facing +z (s = 1) or -z (s = -1). */
function front(kit, g, mat, x0, x1, y0, y1, z, s = 1) {
  kit.block(g, mat, x0 + GAP, x1 - GAP, y0 + GAP, y1 - GAP, ...span(z, z - s * FRONT_T));
}

function pull(kit, g, mat, x, y, z, vertical, len, s = 1) {
  const [z0, z1] = span(z, z + s * 0.016);
  if (vertical) kit.block(g, mat, x - 0.006, x + 0.006, y - len / 2, y + len / 2, z0, z1);
  else kit.block(g, mat, x - len / 2, x + len / 2, y - 0.006, y + 0.006, z0, z1);
}

/** Door bay from y0 to y1: one door, or a pair when the bay is wide. Pulls near pullY. */
function doors(kit, g, m, mat, a, b, y0, y1, z, pullY, hand = 1) {
  const cx = (a + b) / 2;
  if (b - a >= 0.66) {
    front(kit, g, mat, a, cx, y0, y1, z);
    front(kit, g, mat, cx, b, y0, y1, z);
    pull(kit, g, m.steel, cx - 0.04, pullY, z, true, 0.12);
    pull(kit, g, m.steel, cx + 0.04, pullY, z, true, 0.12);
  } else {
    front(kit, g, mat, a, b, y0, y1, z);
    pull(kit, g, m.steel, hand > 0 ? b - 0.045 : a + 0.045, pullY, z, true, 0.12);
  }
}

/** Swivel caster with its wheel of radius r resting on the floor. */
function caster(kit, g, m, x, z, r) {
  kit.cyl(g, m.rubber, r, r * 0.75, x, r, z, { axis: 'x', segments: 14 });
  kit.block(g, m.darkSteel, x - r * 0.5, x + r * 0.5, r * 1.3, r * 2.4, z - r * 0.55, z + r * 0.55);
}

/** Five-star base on casters, hub at the origin, legs reaching `reach`. */
function starBase(kit, g, m, reach, r = 0.025) {
  const y = 2 * r + 0.006;
  kit.cyl(g, m.black, 0.05, 0.05, 0, y - 0.008, 0, { segments: 16 });
  for (let i = 0; i < 5; i++) {
    const leg = sub(kit, g, 0, 0, 0, { yaw: (i * Math.PI * 2) / 5 + Math.PI / 2 });
    kit.block(leg, m.black, 0.03, reach - r + 0.008, y, y + 0.028, -0.017, 0.017);
    kit.cyl(leg, m.rubber, r, r * 0.9, reach - r, r, 0, { axis: 'z', segments: 12 });
  }
}

/** Office task chair facing +z, centered at (x, z). */
function taskChair(kit, g, m, fabric, x, z) {
  const c = sub(kit, g, x, 0, z);
  starBase(kit, c, m, 0.29);
  kit.cyl(c, m.black, 0.032, 0.16, 0, 0.09, 0, { segments: 14 });
  kit.cyl(c, m.chrome, 0.022, 0.16, 0, 0.25, 0, { segments: 14 });
  kit.block(c, m.black, -0.11, 0.11, 0.4, 0.44, -0.13, 0.1);
  pad(kit, c, fabric, -0.24, 0.24, 0.44, 0.51, -0.22, 0.24);
  kit.block(c, m.black, -0.035, 0.035, 0.4, 0.62, -0.28, -0.24);
  kit.block(c, m.black, -0.035, 0.035, 0.4, 0.44, -0.24, -0.12);
  const back = sub(kit, c, 0, 0.56, -0.25, { pitch: -0.1 });
  pad(kit, back, fabric, -0.22, 0.22, 0, 0.46, -0.03, 0.03, 'z');
  for (const s of [-1, 1]) {
    kit.block(c, m.black, s * 0.215 - 0.014, s * 0.215 + 0.014, 0.44, 0.64, -0.08, -0.04);
    kit.block(c, m.black, s * 0.215 - 0.03, s * 0.215 + 0.03, 0.64, 0.665, -0.17, 0.11);
  }
  return c;
}

/** Flat-panel monitor on a stand, screen facing its local +z. */
function monitor(kit, g, m, x, y, z, yaw, size = 0.55) {
  const f = sub(kit, g, x, y, z, { yaw });
  const sh = size * 0.6;
  kit.block(f, m.darkSteel, -0.1, 0.1, 0, 0.012, -0.08, 0.06);
  kit.block(f, m.darkSteel, -0.025, 0.025, 0.012, 0.3, -0.06, -0.035);
  kit.block(f, m.black, -size / 2, size / 2, 0.1, 0.1 + sh, -0.035, -0.012);
  kit.block(f, m.screen, -size / 2 + 0.008, size / 2 - 0.008, 0.108, 0.1 + sh - 0.008, -0.012, -0.009, false);
  return f;
}

/** Slab with an optional rectangular hole {x0, x1, z0, z1}. */
function slab(kit, g, mat, x0, x1, y0, y1, z0, z1, hole) {
  if (!hole) {
    kit.block(g, mat, x0, x1, y0, y1, z0, z1);
    return;
  }
  const parts = [
    [x0, x1, z0, hole.z0], [x0, x1, hole.z1, z1],
    [x0, hole.x0, hole.z0, hole.z1], [hole.x1, x1, hole.z0, hole.z1],
  ];
  for (const [a, b, c, e] of parts) if (b - a > 1e-3 && e - c > 1e-3) kit.block(g, mat, a, b, y0, y1, c, e);
}

/** Sink bowl hanging below a hole in a top whose surface is at y. */
function basin(kit, g, m, hole, y, depth) {
  const t = 0.01, yb = y - depth, yt = y - 0.002;
  const { x0, x1, z0, z1 } = hole;
  kit.block(g, m.steel, x0, x1, yb - t, yb, z0, z1);
  kit.block(g, m.steel, x0, x1, yb, yt, z0, z0 + t);
  kit.block(g, m.steel, x0, x1, yb, yt, z1 - t, z1);
  kit.block(g, m.steel, x0, x0 + t, yb, yt, z0 + t, z1 - t);
  kit.block(g, m.steel, x1 - t, x1, yb, yt, z0 + t, z1 - t);
  kit.cyl(g, m.darkSteel, 0.026, 0.004, (x0 + x1) / 2, yb, (z0 + z1) / 2, { segments: 16 });
}

/** Gooseneck faucet at (x, y, z) arcing `reach` toward +z, with wrist blade handles. */
function gooseneck(kit, g, m, x, y, z, rise, reach) {
  const f = sub(kit, g, x, y, z, { yaw: -Math.PI / 2 });
  const r = reach / 2, t = 0.01;
  kit.cyl(f, m.chrome, 0.024, 0.022, 0, 0, 0, { segments: 16 });
  kit.cyl(f, m.chrome, t, rise, 0, 0, 0, { segments: 10 });
  let prev = [0, rise, 0];
  for (let i = 1; i <= 7; i++) {
    const a = Math.PI * (1 - i / 7);
    const p = [r + r * Math.cos(a), rise + r * Math.sin(a), 0];
    rod(kit, f, m.chrome, t, prev, p, { over: 0.006 });
    prev = p;
  }
  kit.cyl(f, m.chrome, t * 1.3, 0.035, reach, rise - 0.035, 0, { segments: 10 });
  for (const s of [-1, 1]) {
    kit.cyl(f, m.chrome, 0.014, 0.045, 0, 0, s * 0.075, { segments: 10 });
    kit.block(f, m.chrome, -0.008, 0.008, 0.04, 0.05, s * 0.075, s * 0.075 + s * 0.1);
  }
}

// ---- 2D helpers ---------------------------------------------------------------------

function pen(ctx, o, weight = FINE, color = o.theme.line, dash = null) {
  ctx.lineWidth = weight * o.px;
  ctx.strokeStyle = color;
  ctx.setLineDash(dash ? dash.map((v) => v * o.px) : []);
}

function box(ctx, x0, y0, x1, y1, fill) {
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
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

function rounded(ctx, x0, y0, x1, y1, r, fill) {
  ctx.beginPath();
  ctx.roundRect(x0, y0, x1 - x0, y1 - y0, Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2)));
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.stroke();
}

function outline(ctx, o) {
  pen(ctx, o, OUT);
  box(ctx, -o.w / 2, -o.d / 2, o.w / 2, o.d / 2);
}

/** True when the symbol is drawn large enough for small details to stay legible. */
const roomy = (o) => o.px < 1 / 40;

/** Plan symbol of a task chair facing +y at (x, y): seat, back and arms over a white fill. */
function chair2d(ctx, o, x, y) {
  pen(ctx, o, FINE);
  rounded(ctx, x - 0.24, y - 0.22, x + 0.24, y + 0.24, 0.06, o.theme.fill);
  rounded(ctx, x - 0.22, y - 0.31, x + 0.22, y - 0.22, 0.03, o.theme.fill);
  if (roomy(o)) for (const s of [-1, 1]) box(ctx, x + s * 0.215 - 0.03, y - 0.17, x + s * 0.215 + 0.03, y + 0.11);
}

/** Star base legs and casters, drawn the same way the 3D star base is built. */
function star2d(ctx, o, reach, r) {
  pen(ctx, o, FINE, o.theme.muted);
  for (let i = 0; i < 5; i++) {
    const a = (i * Math.PI * 2) / 5 + Math.PI / 2;
    const dx = Math.cos(a), dz = -Math.sin(a);
    line(ctx, 0, 0, (reach - r) * dx, (reach - r) * dz);
    if (roomy(o)) circle(ctx, (reach - r) * dx, (reach - r) * dz, r * 0.9);
  }
}

// ---- Exam table ---------------------------------------------------------------------

function examLayout(w, d) {
  const x0 = -w / 2 + 0.03, x1 = w / 2 - 0.03;
  const pivot = x0 + (x1 - x0) * 0.36;
  const tilt = 0.38;
  const back = pivot - x0;
  return {
    x0, x1, pivot, tilt, back, head: pivot - back * Math.cos(tilt),
    bx0: -w / 2 + 0.12, bx1: w / 2 - 0.1, bz0: -d / 2 + 0.08, bz1: d / 2 - 0.15,
  };
}

function buildExamTable(kit, { w, d, color }) {
  const g = kit.group();
  const m = palette(kit);
  const top = vinyl(kit, color);
  const L = examLayout(w, d);
  const { bx0, bx1, bz0, bz1 } = L;
  const z0 = -d / 2 + 0.005, z1 = d / 2 - 0.005;
  const seat = 0.66, padT = 0.1, paper = 0.26;
  const face = bz1 - FRONT_T;

  kit.block(g, m.plinth, bx0 + 0.03, bx1 - 0.03, 0, 0.06, bz0 + 0.03, bz1 - 0.05);
  kit.block(g, m.case, bx0, bx1, 0.06, 0.62, bz0, face - 0.004);
  kit.block(g, m.reveal, bx0 + 0.006, bx1 - 0.006, 0.062, 0.618, face - 0.004, face, false);
  kit.block(g, m.plinth, bx0 + 0.02, bx1 - 0.02, 0.62, seat, bz0 + 0.02, bz1 - 0.05);

  const a = bx0 + 0.006, b = bx0 + (bx1 - bx0) * 0.32, c = bx0 + (bx1 - bx0) * 0.66, e = bx1 - 0.006;
  const fy0 = 0.065, fy1 = 0.615;
  for (const [y0, y1] of [[fy0, 0.34], [0.34, fy1]]) {
    front(kit, g, m.case, a, b, y0, y1, bz1);
    pull(kit, g, m.steel, (a + b) / 2, y1 - 0.06, bz1, false, 0.14);
  }
  front(kit, g, m.case, b, c, 0.4, fy1, bz1);
  pull(kit, g, m.steel, (b + c) / 2, fy1 - 0.06, bz1, false, 0.16);
  const sx0 = b + 0.02, sx1 = c - 0.02, sz1 = bz1 + 0.12;
  kit.block(g, m.case, sx0, sx1, 0.07, 0.3, bz1 - 0.05, sz1);
  kit.block(g, m.black, sx0 - 0.005, sx1 + 0.005, 0.3, 0.322, bz1 - 0.05, sz1 + 0.006);
  kit.block(g, m.slot, sx0 + 0.06, sx1 - 0.06, 0.17, 0.2, sz1, sz1 + 0.003, false);
  for (const [y0, y1] of [[fy0, 0.25], [0.25, 0.43], [0.43, fy1]]) {
    front(kit, g, m.case, c, e, y0, y1, bz1);
    pull(kit, g, m.steel, (c + e) / 2, y1 - 0.05, bz1, false, 0.14);
  }

  pad(kit, g, top, L.pivot + 0.006, L.x1, seat, seat + padT, z0, z1);
  kit.block(g, m.white, L.pivot + 0.02, L.x1, seat + padT, seat + padT + 0.003, -paper, paper, false);
  kit.block(g, m.white, L.x1, L.x1 + 0.003, seat + 0.03, seat + padT + 0.003, -paper, paper, false);

  const br = sub(kit, g, L.pivot, seat, 0, { roll: -L.tilt });
  const len = L.back;
  kit.block(br, m.plinth, -len + 0.05, -0.04, -0.035, 0, -d / 2 + 0.07, d / 2 - 0.07);
  pad(kit, br, top, -len, -0.006, 0, padT, z0, z1);
  kit.block(br, m.white, -len + 0.01, -0.02, padT, padT + 0.003, -paper, paper, false);
  kit.block(br, m.white, -len - 0.003, -len, -0.06, padT + 0.003, -paper, paper, false);
  kit.cyl(br, m.white, 0.05, paper * 2 + 0.02, -len + 0.05, -0.065, 0, { axis: 'z', segments: 20 });
  for (const s of [-1, 1]) kit.block(br, m.alu, -len + 0.03, -len + 0.07, -0.1, -0.035, s * (paper + 0.02), s * (paper + 0.032));
  const sp = Math.sin(L.tilt), cp = Math.cos(L.tilt);
  const mount = (lx, ly) => [L.pivot + lx * cp + ly * sp, seat - lx * sp + ly * cp];
  const [qx, qy] = mount(-0.36, -0.035);
  rod(kit, g, m.chrome, 0.012, [L.pivot - 0.14, 0.62, 0], [qx, qy, 0]);
  rod(kit, g, m.darkSteel, 0.018, [L.pivot - 0.14, 0.62, 0], [L.pivot - 0.2, 0.68, 0]);
  return g;
}

function drawExamTable(ctx, o) {
  const L = examLayout(o.w, o.d);
  const z0 = -o.d / 2 + 0.005, z1 = o.d / 2 - 0.005;
  const b = L.bx0 + (L.bx1 - L.bx0) * 0.32, c = L.bx0 + (L.bx1 - L.bx0) * 0.66;
  pen(ctx, o, FINE, o.theme.muted, DASH);
  box(ctx, b + 0.02, L.bz1 - 0.05, c - 0.02, Math.min(z1, L.bz1 + 0.126));
  pen(ctx, o, FINE, o.theme.muted);
  box(ctx, L.head + 0.09, -0.26, L.x1, 0.26);
  pen(ctx, o);
  line(ctx, L.pivot, z0, L.pivot, z1);
  rounded(ctx, L.head + 0.02, -0.28, L.head + 0.09, 0.28, 0.03);
  pen(ctx, o, OUT);
  rounded(ctx, L.head, z0, L.x1, z1, 0.035);
}

// ---- Exam room casework -------------------------------------------------------------

function caseworkLayout(w, d, h) {
  const n = Math.max(1, Math.round(w / 0.6));
  const mw = w / n;
  const sink = n === 1 ? 0 : Math.floor(n / 2);
  const fz = d / 2 - 0.025;
  const sx = -w / 2 + (sink + 0.5) * mw;
  const bowlW = clamp(mw - 0.16, 0.28, 0.5), bowlD = clamp(d - 0.25, 0.22, 0.38);
  const hole = { x0: sx - bowlW / 2, x1: sx + bowlW / 2, z0: fz - 0.06 - bowlD, z1: fz - 0.06 };
  const upperY = TOP + 0.46;
  const glove = sink > 0 ? sink - 1 : (n > 1 ? 1 : -1);
  const towel = [sink + 1, sink + 2, sink - 1].find((i) => i >= 0 && i < n && i !== glove) ?? -1;
  return {
    n, mw, sink, fz, sx, hole, glove, towel,
    faucetZ: hole.z0 - 0.055,
    upperD: Math.min(0.33, d * 0.55), upperY, uppers: h - upperY >= 0.3,
    mid: (i) => -w / 2 + (i + 0.5) * mw,
  };
}

function gloveHolder(kit, g, m, x, y, z, width) {
  const gw = Math.min(0.42, width), bw = (gw - 0.03) / 3, y1 = y + 0.25;
  kit.block(g, m.steel, x - gw / 2, x + gw / 2, y, y1, z, z + 0.006);
  kit.block(g, m.steel, x - gw / 2, x + gw / 2, y, y + 0.012, z + 0.006, z + 0.105);
  kit.block(g, m.steel, x - gw / 2, x + gw / 2, y + 0.06, y + 0.07, z + 0.1, z + 0.108);
  for (let k = 0; k < 3; k++) {
    const bx = x - gw / 2 + 0.01 + k * (bw + 0.005);
    const fz = z + 0.1;
    kit.block(g, m.white, bx, bx + bw, y + 0.012, y1 - 0.01, z + 0.008, fz);
    kit.block(g, kit.material(GLOVES[k], { roughness: 0.5 }), bx + 0.008, bx + bw - 0.008, y + 0.075, y + 0.13, fz, fz + 0.002, false);
    kit.block(g, m.slot, bx + 0.025, bx + bw - 0.025, y1 - 0.085, y1 - 0.045, fz, fz + 0.002, false);
  }
}

function towelDispenser(kit, g, m, x, y, z) {
  kit.block(g, m.shell, x - 0.13, x + 0.13, y, y + 0.28, z, z + 0.1);
  kit.block(g, m.trim, x - 0.12, x + 0.12, y + 0.02, y + 0.27, z + 0.1, z + 0.106);
  kit.block(g, m.slot, x - 0.09, x + 0.09, y + 0.18, y + 0.22, z + 0.106, z + 0.108, false);
  kit.block(g, m.white, x - 0.09, x + 0.09, y - 0.04, y + 0.005, z + 0.05, z + 0.058);
}

function sharpsBox(kit, g, m, x, y, z) {
  kit.block(g, m.trim, x - 0.11, x + 0.11, y - 0.01, y + 0.28, z, z + 0.012);
  kit.block(g, m.sharps, x - 0.1, x + 0.1, y, y + 0.22, z + 0.012, z + 0.11);
  kit.block(g, m.shell, x - 0.1, x + 0.1, y + 0.22, y + 0.27, z + 0.012, z + 0.11);
  kit.block(g, m.slot, x - 0.06, x + 0.06, y + 0.235, y + 0.255, z + 0.11, z + 0.112, false);
}

function buildCasework(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = palette(kit);
  const door = finish(kit, color, m.case, 0.5);
  const L = caseworkLayout(w, d, h);
  const ct = TOP - 0.03, bowlDepth = 0.18, cutY = TOP - bowlDepth - 0.03;
  const back = -d / 2, carcass = L.fz - FRONT_T - 0.004;
  const sa = -w / 2 + L.sink * L.mw, sb = sa + L.mw;

  kit.block(g, m.plinth, -w / 2 + 0.01, w / 2 - 0.01, 0, TOE, back, L.fz - 0.06);
  for (const [a, b, y] of [[-w / 2, sa, ct], [sa, sb, cutY], [sb, w / 2, ct]]) {
    if (b - a > 0.002) kit.block(g, m.case, a, b, TOE, y, back, carcass);
  }
  kit.block(g, m.reveal, -w / 2 + 0.005, w / 2 - 0.005, TOE, ct, carcass, L.fz - FRONT_T, false);
  for (let i = 0; i < L.n; i++) {
    const a = -w / 2 + i * L.mw, b = a + L.mw, cx = (a + b) / 2;
    const plen = Math.min(0.16, L.mw * 0.3);
    if (i === 0 && L.sink !== 0) {
      const ys = [ct, ct - 0.16, ct - 0.36, ct - 0.56, TOE];
      for (let k = 0; k < 4; k++) {
        front(kit, g, door, a, b, ys[k + 1], ys[k], L.fz);
        pull(kit, g, m.steel, cx, ys[k] - 0.06, L.fz, false, plen);
      }
      continue;
    }
    front(kit, g, door, a, b, ct - 0.16, ct, L.fz);
    if (i !== L.sink) pull(kit, g, m.steel, cx, ct - 0.06, L.fz, false, plen);
    doors(kit, g, m, door, a, b, TOE, ct - 0.16, L.fz, ct - 0.25, i % 2 ? -1 : 1);
  }

  slab(kit, g, m.quartz, -w / 2, w / 2, ct, TOP, back, d / 2, L.hole);
  kit.block(g, m.quartz, -w / 2, w / 2, TOP, TOP + 0.1, back, back + 0.02);
  basin(kit, g, m, L.hole, TOP, bowlDepth);
  const bowlZ = (L.hole.z0 + L.hole.z1) / 2;
  gooseneck(kit, g, m, L.sx, TOP, L.faucetZ, 0.2, Math.min(0.22, bowlZ - L.faucetZ));
  if (L.hole.x1 + 0.1 < sb) {
    kit.cyl(g, m.chrome, 0.018, 0.09, L.hole.x1 + 0.05, TOP, L.faucetZ, { segments: 12 });
    kit.block(g, m.chrome, L.hole.x1 + 0.044, L.hole.x1 + 0.056, TOP + 0.075, TOP + 0.087, L.faucetZ, L.faucetZ + 0.06);
  }

  const wallY = TOP + 0.13;
  const room = (L.uppers ? L.upperY : h) - wallY - 0.03;
  if (L.glove >= 0 && room >= 0.25) gloveHolder(kit, g, m, L.mid(L.glove), wallY, back, L.mw - 0.08);
  if (L.towel >= 0 && room >= 0.3) {
    const tx = L.mid(L.towel);
    if (L.mw >= 0.53) {
      towelDispenser(kit, g, m, tx - L.mw / 2 + 0.155, wallY + 0.02, back);
      sharpsBox(kit, g, m, tx + L.mw / 2 - 0.125, wallY, back);
    } else {
      towelDispenser(kit, g, m, tx, wallY + 0.02, back);
    }
  }

  if (L.uppers) {
    const uf = back + L.upperD, uc = uf - FRONT_T - 0.004;
    kit.block(g, m.case, -w / 2, w / 2, L.upperY, h, back, uc);
    kit.block(g, m.reveal, -w / 2 + 0.005, w / 2 - 0.005, L.upperY + 0.005, h - 0.005, uc, uf - FRONT_T, false);
    for (let i = 0; i < L.n; i++) {
      const a = -w / 2 + i * L.mw;
      doors(kit, g, m, door, a, a + L.mw, L.upperY, h, uf, L.upperY + 0.1, i % 2 ? 1 : -1);
    }
    kit.block(g, m.led, -w / 2 + 0.05, w / 2 - 0.05, L.upperY - 0.008, L.upperY, uf - 0.07, uf - 0.04, false);
  }
  return g;
}

function drawCasework(ctx, o) {
  const L = caseworkLayout(o.w, o.d, o.h);
  const { hole } = L;
  const back = -o.d / 2;
  if (L.uppers) {
    pen(ctx, o, FINE, o.theme.muted, DASH);
    line(ctx, -o.w / 2, back + L.upperD, o.w / 2, back + L.upperD);
  }
  pen(ctx, o);
  line(ctx, -o.w / 2, back + 0.02, o.w / 2, back + 0.02);
  rounded(ctx, hole.x0, hole.z0, hole.x1, hole.z1, 0.04);
  circle(ctx, L.sx, (hole.z0 + hole.z1) / 2, 0.025);
  circle(ctx, L.sx, L.faucetZ, 0.022);
  line(ctx, L.sx, L.faucetZ, L.sx, L.faucetZ + Math.min(0.22, (hole.z0 + hole.z1) / 2 - L.faucetZ));
  outline(ctx, o);
}

// ---- Physician stool ----------------------------------------------------------------

function buildPhysicianStool(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = palette(kit);
  const seat = vinyl(kit, color);
  const reach = Math.min(w, d) / 2 - 0.005;
  const sy = h - 0.09;
  starBase(kit, g, m, reach, 0.028);
  kit.cyl(g, m.black, 0.032, 0.2, 0, 0.09, 0, { segments: 14 });
  kit.cyl(g, m.chrome, 0.022, sy - 0.31, 0, 0.29, 0, { segments: 14 });
  kit.cyl(g, m.black, 0.15, 0.022, 0, sy - 0.022, 0, { segments: 24 });
  kit.block(g, m.black, 0.08, 0.2, sy - 0.03, sy - 0.018, -0.01, 0.01);
  kit.cyl(g, seat, 0.19, 0.07, 0, sy, 0, { rTop: 0.2, segments: 32 });
  kit.sphere(g, seat, 0.2, 0, sy + 0.07, 0, { segments: 32, scaleY: 0.1 });
  return g;
}

function drawPhysicianStool(ctx, o) {
  const reach = Math.min(o.w, o.d) / 2 - 0.005;
  star2d(ctx, o, reach, 0.028);
  pen(ctx, o, OUT);
  circle(ctx, 0, 0, 0.2, o.theme.fill);
  pen(ctx, o);
  circle(ctx, 0, 0, 0.16);
}

// ---- Side chair ---------------------------------------------------------------------

function sideChairLayout(w, d) {
  return { hx: w / 2 - 0.035, hz: d / 2 - 0.035, t: 0.019, seatY: 0.44, armY: 0.62 };
}

function buildSideChair(kit, { w, d, h, color }) {
  const g = kit.group();
  const wood = kit.mat.oak;
  const fabric = finish(kit, color, kit.mat.fabricSage, 0.95);
  const { hx, hz, t, seatY, armY } = sideChairLayout(w, d);
  for (const s of [-1, 1]) {
    const x = s * hx;
    kit.block(g, wood, x - t, x + t, 0, armY, hz - t, hz + t);
    kit.block(g, wood, x - t, x + t, 0, h - 0.01, -hz - t, -hz + t);
    kit.block(g, wood, x - 0.03, x + 0.03, armY, armY + 0.026, -hz - t, hz + t + 0.012);
    kit.block(g, wood, x - 0.016, x + 0.016, seatY - 0.09, seatY - 0.03, -hz, hz);
    kit.block(g, wood, x - 0.012, x + 0.012, 0.14, 0.17, -hz, hz);
  }
  kit.block(g, wood, -hx, hx, seatY - 0.09, seatY - 0.03, hz - 0.016, hz + 0.016);
  kit.block(g, wood, -hx, hx, seatY - 0.09, seatY - 0.03, -hz - 0.016, -hz + 0.016);
  pad(kit, g, fabric, -hx + t, hx - t, seatY - 0.03, seatY + 0.04, -hz + t, hz + 0.02);
  kit.block(g, wood, -hx, hx, h - 0.06, h - 0.01, -hz - 0.016, -hz + 0.016);
  pad(kit, g, fabric, -hx + t, hx - t, seatY + 0.07, h - 0.07, -hz - 0.012, -hz + 0.035, 'z');
  return g;
}

function drawSideChair(ctx, o) {
  const { hx, hz, t } = sideChairLayout(o.w, o.d);
  pen(ctx, o);
  for (const s of [-1, 1]) line(ctx, s * (hx - 0.03), -hz + t, s * (hx - 0.03), hz + t + 0.012);
  rounded(ctx, -hx + t + 0.008, -hz + 0.035, hx - t - 0.008, hz + 0.02, 0.04);
  pen(ctx, o, OUT);
  rounded(ctx, -hx - 0.03, -hz - t, hx + 0.03, hz + t + 0.012, 0.03);
}

// ---- Reception desk and nurse station -----------------------------------------------

function deskLayout(w, d, pitch) {
  const front = d / 2;
  const faceT = 0.06;
  const inner = front - 0.012 - faceT;
  const ledgeD = Math.min(0.3, d * 0.34);
  const ledge0 = front - ledgeD;
  const chairs = d >= 0.75;
  const chairZ = Math.min(-d / 2 + 0.34, inner - 0.3);
  const work0 = Math.max(-d / 2 + 0.18, inner - 0.62);
  const n = Math.max(1, Math.round(w / pitch));
  const xs = Array.from({ length: n }, (_, i) => -w / 2 + ((i + 0.5) * w) / n);
  const monZ = ledge0 - 0.09;
  const kbZ = Math.max(work0 + 0.075, monZ - 0.26);
  const pedW = 0.42;
  const ped = w / 2 - 0.025 - pedW > xs[n - 1] + 0.3 ? { x0: w / 2 - 0.025 - pedW, x1: w / 2 - 0.025 } : null;
  return { front, faceT, inner, ledgeD, ledge0, chairs, chairZ, work0, xs, monZ, kbZ, ped };
}

function keyboard(kit, g, m, x, z) {
  kit.block(g, m.black, x - 0.21, x + 0.21, DESK, DESK + 0.018, z - 0.07, z + 0.07);
  kit.block(g, m.darkSteel, x - 0.2, x + 0.2, DESK + 0.018, DESK + 0.022, z - 0.06, z + 0.06, false);
  kit.block(g, m.black, x + 0.27, x + 0.33, DESK, DESK + 0.025, z - 0.04, z + 0.05);
}

function deskPhone(kit, g, m, x, z) {
  kit.block(g, m.black, x - 0.1, x + 0.1, DESK, DESK + 0.05, z - 0.09, z + 0.09);
  kit.block(g, m.screen, x - 0.03, x + 0.07, DESK + 0.05, DESK + 0.052, z - 0.06, z, false);
  kit.block(g, m.plinth, x - 0.1, x - 0.04, DESK + 0.05, DESK + 0.075, z - 0.09, z + 0.09);
}

function sanitizer(kit, g, m, x, y, z) {
  kit.cyl(g, m.white, 0.034, 0.12, x, y, z, { segments: 16 });
  kit.cyl(g, kit.material('#80bbad', { roughness: 0.5 }), 0.0345, 0.04, x, y + 0.04, z, { segments: 16 });
  kit.cyl(g, m.trim, 0.018, 0.03, x, y + 0.12, z, { segments: 12 });
  kit.block(g, m.trim, x - 0.006, x + 0.006, y + 0.135, y + 0.15, z, z + 0.045);
}

function buildDesk(kit, { w, d, h, color }, variant) {
  const g = kit.group();
  const m = palette(kit);
  const L = deskLayout(w, d, variant.pitch);
  const face = finish(kit, color, variant.face(kit), 0.55);
  const work = m.laminate;
  const fz = L.front - 0.012;
  const ledgeY = h - 0.03;

  kit.block(g, m.plinth, -w / 2 + 0.015, w / 2 - 0.015, 0, 0.08, L.inner + 0.01, fz - 0.025);
  kit.block(g, m.laminate, -w / 2, w / 2, 0.08, ledgeY, L.inner, fz - 0.02);
  kit.block(g, face, -w / 2, w / 2, 0.08, ledgeY, fz - 0.02, fz);
  variant.dress(kit, g, m, w, fz, ledgeY);
  kit.block(g, m.quartz, -w / 2, w / 2, ledgeY, h, L.ledge0, L.front);
  kit.block(g, m.led, -w / 2 + 0.06, w / 2 - 0.06, ledgeY - 0.006, ledgeY, L.ledge0 + 0.02, L.ledge0 + 0.04, false);
  const brackets = Math.max(2, Math.round(w / 0.9) + 1);
  for (let i = 0; i < brackets; i++) {
    const x = -w / 2 + 0.12 + (i * (w - 0.24)) / (brackets - 1);
    kit.block(g, m.darkSteel, x - 0.005, x + 0.005, ledgeY - 0.16, ledgeY, L.ledge0 + 0.04, L.inner);
  }

  kit.block(g, work, -w / 2 + 0.025, w / 2 - 0.025, DESK - 0.03, DESK, L.work0, L.inner);
  for (const s of [-1, 1]) {
    const x = s * w / 2;
    kit.block(g, m.white, ...span(x, x - s * 0.025), 0, DESK, L.work0, L.inner);
  }
  if (L.ped) {
    const { x0, x1 } = L.ped;
    const pz = L.work0 + 0.03;
    kit.block(g, m.white, x0, x1, 0.04, DESK - 0.03, pz + FRONT_T, L.inner);
    for (const [y0, y1] of [[0.04, 0.4], [0.4, 0.56], [0.56, DESK - 0.035]]) {
      front(kit, g, m.white, x0, x1, y0, y1, pz, -1);
      pull(kit, g, m.steel, (x0 + x1) / 2, y1 - 0.05, pz, false, 0.14, -1);
    }
  }

  const fabric = kit.mat.fabricCharcoal;
  for (const [i, x] of L.xs.entries()) {
    monitor(kit, g, m, x, DESK, L.monZ, Math.PI);
    keyboard(kit, g, m, x - 0.04, L.kbZ);
    if (L.chairs) taskChair(kit, g, m, fabric, x, L.chairZ);
    if (i === 0 && w >= 1.4) deskPhone(kit, g, m, x - 0.5 >= -w / 2 + 0.14 ? x - 0.5 : x + 0.46, L.monZ - 0.05);
  }
  if (w >= 1.2) sanitizer(kit, g, m, w / 2 - 0.3, h, (L.ledge0 + L.front) / 2);
  return g;
}

function drawDesk(ctx, o, variant) {
  const L = deskLayout(o.w, o.d, variant.pitch);
  if (L.ped) {
    pen(ctx, o, FINE, o.theme.muted, DASH);
    box(ctx, L.ped.x0, L.work0 + 0.03, L.ped.x1, L.inner);
  }
  pen(ctx, o, FINE, o.theme.muted);
  line(ctx, -o.w / 2, L.inner, o.w / 2, L.inner);
  pen(ctx, o);
  line(ctx, -o.w / 2, L.ledge0, o.w / 2, L.ledge0);
  if (roomy(o)) for (const x of L.xs) box(ctx, x - 0.25, L.kbZ - 0.07, x + 0.17, L.kbZ + 0.07);
  pen(ctx, o, OUT);
  box(ctx, -o.w / 2, L.work0, o.w / 2, L.front);
  if (L.chairs) for (const x of L.xs) chair2d(ctx, o, x, L.chairZ);
  pen(ctx, o);
  for (const x of L.xs) box(ctx, x - 0.275, L.monZ + 0.012, x + 0.275, L.monZ + 0.035, o.theme.light);
}

const RECEPTION = {
  pitch: 1.5,
  face: (kit) => kit.mat.oak,
  dress(kit, g, m, w, fz, ledgeY) {
    const n = clamp(Math.round(w / 0.16), 2, 20);
    for (let i = 1; i < n; i++) {
      const x = -w / 2 + (i * w) / n;
      kit.block(g, m.plinth, x - 0.004, x + 0.004, 0.08, ledgeY, fz, fz + 0.002, false);
    }
    kit.block(g, kit.mat.cbreGreen, -w / 2, w / 2, 0.08, 0.1, fz - 0.002, fz + 0.004, false);
  },
};

const NURSE = {
  pitch: 1.2,
  face: (kit) => kit.material('#538184', { roughness: 0.55 }),
  dress(kit, g, m, w, fz, ledgeY) {
    const n = Math.max(1, Math.round(w / 0.8));
    for (let i = 1; i < n; i++) {
      const x = -w / 2 + (i * w) / n;
      kit.block(g, m.plinth, x - 0.003, x + 0.003, 0.08, ledgeY - 0.2, fz, fz + 0.002, false);
    }
    kit.block(g, m.white, -w / 2, w / 2, ledgeY - 0.2, ledgeY, fz - 0.002, fz + 0.006);
    kit.block(g, m.plinth, -w / 2, w / 2, ledgeY - 0.206, ledgeY - 0.2, fz, fz + 0.007, false);
  },
};

// ---- Waiting chairs -----------------------------------------------------------------

function waitingLayout(w, d) {
  const n = Math.max(1, Math.round(w / 0.61));
  const p = w / n, armT = 0.05;
  const arms = Array.from({ length: n + 1 }, (_, i) => clamp(-w / 2 + i * p, -w / 2 + armT / 2, w / 2 - armT / 2));
  const seatZ1 = d / 2 - 0.04, seatZ0 = seatZ1 - clamp(d - 0.19, 0.3, 0.52);
  return { n, armT, arms, seatZ0, seatZ1, backZ: seatZ0 - 0.005, beamZ: (seatZ0 + seatZ1) / 2 - 0.1, foot: d / 2 - 0.05 };
}

function buildWaitingChairs(kit, { w, d, color }) {
  const g = kit.group();
  const m = palette(kit);
  const fabric = finish(kit, color, kit.mat.fabricGreen, 0.95);
  const frame = m.darkSteel;
  const L = waitingLayout(w, d);
  const bz = L.beamZ;
  kit.block(g, frame, -w / 2 + 0.04, w / 2 - 0.04, 0.3, 0.36, bz - 0.03, bz + 0.03);
  for (const [i, x] of L.arms.entries()) {
    kit.block(g, frame, x - 0.012, x + 0.012, 0.36, 0.6, bz + 0.065, bz + 0.105);
    kit.block(g, frame, x - 0.012, x + 0.012, 0.33, 0.37, bz - 0.015, bz + 0.105);
    kit.block(g, m.oak, x - L.armT / 2, x + L.armT / 2, 0.6, 0.63, L.seatZ0 - 0.02, L.seatZ1 - 0.02);
    if (i % 2 && i !== L.n) continue;
    kit.block(g, frame, x - 0.02, x + 0.02, 0.03, 0.3, bz - 0.025, bz + 0.015);
    kit.block(g, frame, x - 0.022, x + 0.022, 0.012, 0.045, -L.foot, L.foot);
    for (const z of [-L.foot + 0.02, L.foot - 0.02]) kit.block(g, m.rubber, x - 0.02, x + 0.02, 0, 0.012, z - 0.02, z + 0.02);
  }
  for (let i = 0; i < L.n; i++) {
    const x0 = L.arms[i] + L.armT / 2 + 0.008, x1 = L.arms[i + 1] - L.armT / 2 - 0.008, cx = (x0 + x1) / 2;
    kit.block(g, frame, cx - 0.16, cx + 0.16, 0.36, 0.4, L.seatZ0 + 0.04, L.seatZ1 - 0.06);
    pad(kit, g, fabric, x0, x1, 0.4, 0.47, L.seatZ0, L.seatZ1);
    kit.block(g, frame, cx - 0.02, cx + 0.02, 0.3, 0.34, L.backZ, bz - 0.03);
    kit.block(g, frame, cx - 0.02, cx + 0.02, 0.3, 0.56, L.backZ - 0.04, L.backZ);
    const back = sub(kit, g, cx, 0.5, L.backZ + 0.005, { pitch: -0.14 });
    kit.block(back, frame, -(x1 - x0) / 2 + 0.01, (x1 - x0) / 2 - 0.01, 0.0, 0.32, -0.035, -0.015);
    pad(kit, back, fabric, -(x1 - x0) / 2, (x1 - x0) / 2, 0.01, 0.34, -0.015, 0.04, 'z');
  }
  return g;
}

function drawWaitingChairs(ctx, o) {
  const L = waitingLayout(o.w, o.d);
  pen(ctx, o);
  line(ctx, -o.w / 2 + L.armT, L.backZ + 0.045, o.w / 2 - L.armT, L.backZ + 0.045);
  for (let i = 0; i < L.n; i++) {
    const x0 = L.arms[i] + L.armT / 2 + 0.008, x1 = L.arms[i + 1] - L.armT / 2 - 0.008;
    rounded(ctx, x0, L.backZ + 0.045, x1, L.seatZ1, 0.04);
  }
  if (roomy(o)) for (const x of L.arms) box(ctx, x - L.armT / 2, L.seatZ0 - 0.02, x + L.armT / 2, L.seatZ1 - 0.02);
  pen(ctx, o, OUT);
  rounded(ctx, -o.w / 2, L.backZ - 0.075, o.w / 2, L.seatZ1, 0.03);
}

// ---- Hospital bed -------------------------------------------------------------------

const BED = { pivot: -0.3, deck: 0.56, mT: 0.14, tilt: 0.42, headLen: 0.7, fold: 0.1 };

function buildHospitalBed(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = palette(kit);
  const blanket = finish(kit, color, kit.mat.fabricCeladon, 0.95);
  const mattress = kit.material('#3f5f72', { roughness: 0.55 });
  const board = kit.material('#e7eae9', { roughness: 0.42 });
  const hz = d / 2, bx = w / 2 - 0.06, mx = w / 2 - 0.07;
  const { pivot, deck, mT, tilt, headLen, fold } = BED;
  const top = deck + mT;

  for (const sx of [-1, 1]) for (const sz of [-1, 1]) caster(kit, g, m, sx * 0.36, sz * (hz - 0.2), 0.065);
  kit.block(g, m.darkSteel, -0.4, 0.4, 0.15, 0.2, -hz + 0.12, hz - 0.12);
  kit.block(g, m.shell, -0.34, 0.34, 0.2, 0.3, -hz + 0.3, hz - 0.3);
  for (const z of [-0.5, 0.5]) kit.block(g, m.darkSteel, -0.1, 0.1, 0.3, deck - 0.06, z - 0.08, z + 0.08);
  kit.block(g, m.shell, -mx + 0.01, mx - 0.01, deck - 0.06, deck, -hz + 0.1, hz - 0.07);

  kit.block(g, mattress, -mx, mx, deck, top - 0.012, pivot, hz - 0.08);
  kit.block(g, m.white, -mx + 0.005, mx - 0.005, top - 0.012, top, pivot, fold + 0.02);
  kit.block(g, blanket, -mx - 0.012, mx + 0.012, top - 0.012, top + 0.012, fold, hz - 0.075);
  for (const s of [-1, 1]) kit.block(g, blanket, ...span(s * mx, s * (mx + 0.012)), deck + 0.03, top, fold, hz - 0.075);
  kit.block(g, blanket, -mx - 0.012, mx + 0.012, deck + 0.03, top + 0.012, hz - 0.087, hz - 0.075);
  kit.cyl(g, m.white, 0.028, 2 * mx, 0, top + 0.012, fold + 0.012, { axis: 'x', segments: 14 });

  const hs = sub(kit, g, 0, deck, pivot, { pitch: tilt });
  kit.block(hs, m.shell, -mx + 0.01, mx - 0.01, -0.04, 0, -headLen, 0);
  kit.block(hs, mattress, -mx, mx, 0, mT - 0.012, -headLen, 0);
  kit.block(hs, m.white, -mx + 0.005, mx - 0.005, mT - 0.012, mT, -headLen, 0);
  const p0 = -headLen + 0.06, p1 = -headLen + 0.36, pr = 0.05;
  kit.block(hs, m.white, -0.27, 0.27, mT, mT + 2 * pr, p0 + pr, p1 - pr);
  for (const z of [p0 + pr, p1 - pr]) kit.cyl(hs, m.white, pr, 0.54, 0, mT + pr, z, { axis: 'x', segments: 16 });

  kit.block(g, board, -bx, bx, 0.4, h - 0.03, -hz + 0.004, -hz + 0.04);
  kit.cyl(g, board, 0.028, 2 * bx, 0, h - 0.03, -hz + 0.03, { axis: 'x', segments: 14 });
  for (const s of [-1, 1]) kit.block(g, m.slot, ...span(s * 0.14, s * 0.32), h - 0.13, h - 0.09, -hz + 0.003, -hz + 0.041, false);
  const fy = 0.86;
  kit.block(g, board, -bx, bx, 0.45, fy, hz - 0.045, hz - 0.012);
  kit.cyl(g, board, 0.028, 2 * bx, 0, fy, hz - 0.0285, { axis: 'x', segments: 14 });
  kit.block(g, m.trim, -0.16, 0.16, 0.66, 0.8, hz - 0.012, hz - 0.006);
  kit.block(g, m.screen, -0.13, 0.05, 0.69, 0.77, hz - 0.006, hz - 0.004, false);
  kit.block(g, m.status, 0.08, 0.1, 0.75, 0.765, hz - 0.006, hz - 0.003, false);

  const rails = [[-hz + 0.14, -hz + 0.72], [0.02, 0.68]];
  for (const s of [-1, 1]) {
    const x0 = s * (w / 2 - 0.035), x1 = s * (w / 2 - 0.005);
    for (const [k, [z0, z1]] of rails.entries()) {
      kit.block(g, board, ...span(x0, x1), 0.88, 0.93, z0, z1);
      kit.block(g, board, ...span(x0, x1), 0.6, 0.64, z0, z1);
      for (const z of [z0, (z0 + z1) / 2, z1 - 0.04]) kit.block(g, board, ...span(x0, x1), 0.64, 0.88, z, z + 0.04);
      const zm = (z0 + z1) / 2;
      kit.block(g, m.darkSteel, ...span(s * (mx - 0.02), x0), 0.52, 0.6, zm - 0.05, zm + 0.05);
      if (k === 0) kit.block(g, m.screen, ...span(x1, x1 + s * 0.003), 0.72, 0.82, z0 + 0.08, z0 + 0.2, false);
    }
  }
  return g;
}

function drawHospitalBed(ctx, o) {
  const hz = o.d / 2, bx = o.w / 2 - 0.06, mx = o.w / 2 - 0.07;
  const { pivot, tilt, headLen, fold } = BED;
  const headEnd = pivot - headLen * Math.cos(tilt);
  pen(ctx, o, FINE);
  for (const s of [-1, 1]) {
    const [x0, x1] = span(s * (o.w / 2 - 0.035), s * (o.w / 2 - 0.005));
    for (const [z0, z1] of [[-hz + 0.14, -hz + 0.72], [0.02, 0.68]]) box(ctx, x0, z0, x1, z1);
  }
  box(ctx, -mx, headEnd, mx, hz - 0.08);
  line(ctx, -mx, pivot, mx, pivot);
  rounded(ctx, -0.3, headEnd + 0.04, 0.3, headEnd + 0.3, 0.06);
  line(ctx, -mx, fold, mx, fold);
  line(ctx, mx - 0.3, fold, mx, fold + 0.3);
  pen(ctx, o, OUT);
  box(ctx, -bx, -hz, bx, -hz + 0.035, o.theme.light);
  box(ctx, -bx, hz - 0.045, bx, hz - 0.012, o.theme.light);
  box(ctx, -bx, -hz, bx, hz - 0.012);
}

// ---- Treatment recliner -------------------------------------------------------------

function reclinerLayout(w, d) {
  const cw = Math.min(0.7, w - 0.16);
  return { cw, cx: -w / 2 + cw / 2 + 0.01, poleX: w / 2 - 0.06, poleZ: -d / 2 + 0.2 };
}

function buildRecliner(kit, { w, d, color }) {
  const g = kit.group();
  const m = palette(kit);
  const up = vinyl(kit, color);
  const seam = kit.material('#2f4f52', { roughness: 0.6 });
  const L = reclinerLayout(w, d);
  const hw = L.cw / 2, iw = hw - 0.1;
  const c = sub(kit, g, L.cx, 0, 0);

  kit.block(c, m.plinth, -hw + 0.05, hw - 0.05, 0.07, 0.13, -0.36, 0.24);
  for (const sx of [-1, 1]) for (const z of [-0.31, 0.19]) caster(kit, c, m, sx * (hw - 0.09), z, 0.03);
  for (const s of [-1, 1]) {
    const [x0, x1] = span(s * iw, s * hw), xm = (x0 + x1) / 2, ar = (x1 - x0) / 2;
    kit.block(c, up, x0, x1, 0.13, 0.62, -0.38, 0.27 - ar);
    kit.cyl(c, up, ar, 0.49, xm, 0.13, 0.27 - ar, { segments: 18 });
    pad(kit, c, up, x0 - 0.008, x1 + 0.008, 0.62, 0.68, -0.4, 0.3 - ar - 0.008);
    kit.cyl(c, up, ar + 0.008, 0.06, xm, 0.62, 0.3 - ar - 0.008, { segments: 18 });
  }
  kit.block(c, up, -iw, iw, 0.13, 0.38, -0.3, 0.26);
  pad(kit, c, up, -iw, iw, 0.38, 0.5, -0.2, 0.31);

  const back = sub(kit, c, 0, 0.42, -0.19, { pitch: -0.26 });
  kit.block(back, up, -iw + 0.005, iw - 0.005, 0, 0.62, -0.13, -0.04);
  kit.cyl(back, up, 0.045, 2 * iw - 0.01, 0, 0.62, -0.085, { axis: 'x', segments: 18 });
  for (const s of [-1, 1]) kit.block(back, m.darkSteel, s * 0.16 - 0.01, s * 0.16 + 0.01, 0.48, 0.5, -0.17, -0.13);
  kit.cyl(back, m.chrome, 0.011, 0.36, 0, 0.49, -0.17, { axis: 'x', segments: 12 });
  pad(kit, back, up, -iw + 0.015, iw - 0.015, 0.06, 0.6, -0.04, 0.02, 'z');
  for (const y of [0.24, 0.4]) kit.block(back, seam, -iw + 0.03, iw - 0.03, y, y + 0.006, 0.02, 0.022, false);
  pad(kit, back, up, -0.17, 0.17, 0.48, 0.64, 0.01, 0.07, 'z');

  const leg = sub(kit, c, 0, 0.42, 0.3, { pitch: -0.25 });
  pad(kit, leg, up, -iw + 0.02, iw - 0.02, -0.3, 0, 0, 0.06, 'z');

  const px = L.poleX, pz = L.poleZ, top = 1.8;
  for (const y of [0.3, 0.56]) {
    kit.block(g, m.darkSteel, L.cx + hw, px, y, y + 0.03, pz - 0.015, pz + 0.015);
    kit.cyl(g, m.darkSteel, 0.022, 0.05, px, y - 0.01, pz, { segments: 12 });
  }
  kit.cyl(g, m.chrome, 0.0125, top - 0.22, px, 0.22, pz, { segments: 12 });
  kit.cyl(g, m.black, 0.016, 0.03, px, 0.2, pz, { segments: 12 });
  for (const [dx, dz] of [[0.045, 0], [-0.045, 0], [0, 0.08], [0, -0.08]]) {
    rod(kit, g, m.chrome, 0.005, [px, top, pz], [px + dx, top + 0.015, pz + dz], { segments: 6 });
    kit.sphere(g, m.chrome, 0.008, px + dx, top + 0.02, pz + dz, { segments: 8 });
  }
  const bag = kit.material('#e9f3f1', { roughness: 0.2, transparent: true, opacity: 0.7 });
  kit.block(g, bag, px - 0.045, px + 0.045, top - 0.3, top - 0.08, pz + 0.065, pz + 0.095);
  kit.block(g, m.white, px - 0.01, px + 0.01, top - 0.08, top + 0.01, pz + 0.075, pz + 0.085);
  rod(kit, g, m.white, 0.003, [px, top - 0.3, pz + 0.08], [px + 0.02, 1.2, pz + 0.055], { segments: 6 });
  kit.block(g, m.shell, px - 0.055, px + 0.055, 1.02, 1.2, pz - 0.03, pz + 0.06);
  kit.block(g, m.screen, px - 0.04, px + 0.04, 1.11, 1.17, pz + 0.06, pz + 0.063, false);
  kit.block(g, m.status, px - 0.04, px - 0.02, 1.06, 1.075, pz + 0.06, pz + 0.064, false);
  return g;
}

function drawRecliner(ctx, o) {
  const L = reclinerLayout(o.w, o.d);
  const hw = L.cw / 2, iw = hw - 0.1, x0 = L.cx - hw, x1 = L.cx + hw;
  pen(ctx, o);
  for (const s of [-1, 1]) line(ctx, L.cx + s * iw, -0.3, L.cx + s * iw, 0.3);
  line(ctx, L.cx - iw, -0.22, L.cx + iw, -0.22);
  box(ctx, L.cx - iw + 0.02, 0.31, L.cx + iw - 0.02, 0.44);
  line(ctx, x1, L.poleZ, L.poleX, L.poleZ);
  pen(ctx, o, FINE, o.theme.muted);
  line(ctx, L.poleX - 0.045, L.poleZ, L.poleX + 0.045, L.poleZ);
  line(ctx, L.poleX, L.poleZ - 0.08, L.poleX, L.poleZ + 0.08);
  pen(ctx, o, OUT);
  circle(ctx, L.poleX, L.poleZ, 0.022, o.theme.fill);
  rounded(ctx, x0, -o.d / 2 + 0.02, x1, 0.31, 0.05);
}

// ---- CT scanner ---------------------------------------------------------------------

function ctLayout(w, d, h) {
  const ro = Math.min(w / 2 - 0.08, h / 2);
  const gz0 = -d / 2 + 0.1, gz1 = gz0 + 0.86;
  return { ro, rb: 0.39, cy: h - ro, gz0, gz1, bezel: 0.47, tube: 0.09, ped0: gz1 + 0.16, ped1: gz1 + 1.9, tip: d / 2 - 0.06 };
}

/** Polygonal annulus of `n` radial blocks in the xy plane, spanning z0..z1. */
function annulus(kit, g, mat, cy, rIn, rOut, z0, z1, n) {
  const hw = rOut * Math.tan(Math.PI / n) + 0.002;
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) * Math.PI * 2) / n;
    const seg = sub(kit, g, 0, cy, 0, { roll: a - Math.PI / 2 });
    kit.block(seg, mat, -hw, hw, rIn, rOut, z0, z1);
  }
}

function buildCT(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = palette(kit);
  const body = kit.material('#f4f5f4', { roughness: 0.35 });
  const cushion = vinyl(kit, color);
  const glow = kit.material('#bfe9dc', { emissive: '#80bbad', emissiveIntensity: 1.2, roughness: 0.4 });
  const C = ctLayout(w, d, h);
  const { ro, rb, cy, gz0, gz1 } = C;

  annulus(kit, g, body, cy, rb, ro, gz0, gz1, 48);
  const inset = 0.002;
  kit.block(g, body, -ro, -rb, 0.07, cy, gz0 + inset, gz1 - inset);
  kit.block(g, body, rb, ro, 0.07, cy, gz0 + inset, gz1 - inset);
  kit.block(g, body, -rb, rb, 0.07, cy - rb, gz0 + inset, gz1 - inset);
  kit.block(g, m.plinth, -ro + 0.04, ro - 0.04, 0, 0.07, gz0 + 0.04, gz1 - 0.04);
  kit.block(g, m.trim, -ro - 0.002, ro + 0.002, 0.07, 0.24, gz1 - 0.3, gz1 + 0.002);
  for (const z of [gz1, gz0]) kit.torus(g, m.trim, C.bezel, C.tube, 0, cy, z, { axis: 'z' });
  kit.torus(g, glow, C.bezel + C.tube + 0.03, 0.008, 0, cy, gz1 + 0.004, { axis: 'z' });
  for (const s of [-1, 1]) {
    const x = s * (ro - 0.24);
    kit.block(g, m.slot, x - 0.1, x + 0.1, cy + 0.05, cy + 0.2, gz1, gz1 + 0.006);
    kit.block(g, m.screen, x - 0.085, x + 0.085, cy + 0.065, cy + 0.185, gz1 + 0.006, gz1 + 0.008, false);
    for (const k of [-1, 0, 1]) kit.cyl(g, m.trim, 0.016, 0.01, x + k * 0.05, cy - 0.02, gz1, { axis: 'z', segments: 12 });
  }

  kit.block(g, m.plinth, -0.34, 0.34, 0, 0.04, C.ped0, C.ped1);
  kit.block(g, body, -0.27, 0.27, 0.04, 0.6, C.ped0 + 0.08, C.ped1 - 0.3);
  kit.block(g, body, -0.24, 0.24, 0.6, 0.68, C.ped0 + 0.02, C.ped1 - 0.15);
  kit.block(g, m.trim, -0.27, 0.27, 0.04, 0.1, C.ped0 + 0.08, C.ped1 - 0.3);
  kit.block(g, m.trim, -0.2, 0.2, 0.68, 0.73, C.ped0 - 0.1, C.ped1);
  kit.block(g, body, -0.25, 0.25, 0.73, 0.77, gz0 + 0.04, C.tip);
  kit.cyl(g, body, 0.02, 0.5, 0, 0.75, C.tip, { axis: 'x', segments: 14 });
  pad(kit, g, cushion, -0.22, 0.22, 0.77, 0.815, gz0 + 0.35, C.tip - 0.05);
  kit.block(g, m.trim, -0.13, 0.13, 0.77, 0.83, gz0 + 0.08, gz0 + 0.34);
  kit.block(g, m.darkSteel, -0.25, 0.25, 0.745, 0.755, C.tip - 0.3, C.tip - 0.04, false);
  return g;
}

function drawCT(ctx, o) {
  const C = ctLayout(o.w, o.d, o.h);
  const front = C.gz1 + C.tube;
  pen(ctx, o, FINE, o.theme.muted, DASH);
  line(ctx, -C.rb, C.gz0, -C.rb, C.gz1);
  line(ctx, C.rb, C.gz0, C.rb, C.gz1);
  line(ctx, -0.25, C.gz0 + 0.04, -0.25, front);
  line(ctx, 0.25, C.gz0 + 0.04, 0.25, front);
  box(ctx, -0.34, C.ped0, 0.34, C.ped1);
  pen(ctx, o);
  box(ctx, -C.bezel - C.tube, C.gz1, C.bezel + C.tube, front);
  box(ctx, -0.22, Math.max(front, C.gz0 + 0.35), 0.22, C.tip - 0.05);
  for (const s of [-1, 1]) box(ctx, s * (C.ro - 0.24) - 0.1, C.gz1, s * (C.ro - 0.24) + 0.1, C.gz1 + 0.03);
  pen(ctx, o, OUT);
  box(ctx, -C.ro, C.gz0, C.ro, C.gz1);
  line(ctx, -0.25, front, -0.25, C.tip, 0.25, C.tip, 0.25, front);
}

// ---- Privacy curtain ----------------------------------------------------------------

function curtainLayout(w, d) {
  const n = Math.max(2, 2 * Math.round(w / 0.24));
  return { n, s: w / n, a: Math.min(0.03, d / 2 - 0.012) };
}

function buildCurtain(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = palette(kit);
  const fabric = finish(kit, color, kit.mat.fabricCeladon, 0.95);
  const mesh = kit.material('#f4f6f5', { roughness: 0.9, transparent: true, opacity: 0.5, depthWrite: false });
  const C = curtainLayout(w, d);
  const trackY = h - 0.035, meshTop = h - 0.08, meshBot = Math.max(0.8, h - 0.56), hem = Math.min(0.35, h * 0.15);
  const zAt = (i) => (i % 2 ? C.a : -C.a);
  for (let i = 0; i < C.n; i++) {
    const xa = -w / 2 + i * C.s, za = zAt(i), zb = zAt(i + 1);
    const len = Math.hypot(C.s, zb - za) + 0.004;
    const f = sub(kit, g, xa + C.s / 2, 0, (za + zb) / 2, { yaw: -Math.atan2(zb - za, C.s) });
    kit.block(f, fabric, -len / 2, len / 2, hem, meshBot, -0.003, 0.003);
    kit.block(f, mesh, -len / 2, len / 2, meshBot, meshTop - 0.025, -0.002, 0.002, false);
    kit.block(f, m.white, -len / 2, len / 2, meshTop - 0.025, meshTop, -0.0035, 0.0035);
  }
  for (let i = 0; i <= C.n; i += 2) {
    const x = clamp(-w / 2 + i * C.s, -w / 2 + 0.01, w / 2 - 0.01);
    rod(kit, g, m.alu, 0.003, [x, meshTop - 0.01, zAt(i)], [x, trackY, 0], { segments: 5 });
  }
  kit.block(g, m.alu, -w / 2, w / 2, trackY, h, -0.018, 0.018);
  for (const s of [-1, 1]) kit.block(g, m.darkSteel, ...span(s * w / 2, s * (w / 2 - 0.02)), trackY - 0.008, h, -0.02, 0.02);
  return g;
}

function drawCurtain(ctx, o) {
  const amp = clamp(2 * o.px, 0.02, o.d / 2);
  const period = Math.max(0.24, 10 * o.px);
  const waves = Math.max(1, Math.round(o.w / period));
  pen(ctx, o, FINE, o.theme.muted, DASH);
  line(ctx, -o.w / 2, 0, o.w / 2, 0);
  pen(ctx, o, OUT);
  ctx.beginPath();
  const steps = waves * 12;
  for (let i = 0; i <= steps; i++) {
    const x = -o.w / 2 + (i / steps) * o.w;
    const y = amp * Math.sin((i / 12) * Math.PI * 2);
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  ctx.stroke();
  for (const s of [-1, 1]) line(ctx, s * o.w / 2, -o.d / 2, s * o.w / 2, o.d / 2);
}

// ---- Supply cart --------------------------------------------------------------------

function cartLayout(w, d, h) {
  return { x0: -w / 2 + 0.05, x1: w / 2 - 0.012, z0: -d / 2 + 0.015, z1: d / 2 - 0.015, by0: 0.13, by1: h - 0.07 };
}

function buildSupplyCart(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = palette(kit);
  const drawer = finish(kit, color, kit.material('#80bbad', { roughness: 0.45 }), 0.45);
  const body = kit.material('#e6e9e8', { roughness: 0.4 });
  const C = cartLayout(w, d, h);
  const { x0, x1, z0, z1, by0, by1 } = C;
  const face = z1 - FRONT_T;

  for (const x of [x0 + 0.05, x1 - 0.05]) for (const z of [z0 + 0.05, z1 - 0.05]) caster(kit, g, m, x, z, 0.04);
  kit.block(g, m.plinth, x0, x1, 0.1, by0, z0, z1);
  kit.block(g, body, x0 + 0.008, x1 - 0.008, by0, by1, z0 + 0.008, face - 0.003);
  kit.block(g, m.reveal, x0 + 0.012, x1 - 0.012, by0, by1, face - 0.003, face, false);
  const heights = [0.12, 0.12, 0.17, 0.24, 0.35];
  const total = by1 - by0 - 0.01;
  let y = by1 - 0.005;
  for (const [i, f] of heights.entries()) {
    const y0 = y - f * total;
    front(kit, g, drawer, x0 + 0.02, x1 - 0.02, y0, y, z1);
    kit.block(g, m.slot, -0.1 + (x0 + x1) / 2, 0.1 + (x0 + x1) / 2, y - 0.035, y - 0.018, z1, z1 + 0.002, false);
    kit.block(g, m.white, x0 + 0.05, x0 + 0.13, y - 0.035, y - 0.018, z1, z1 + 0.002, false);
    if (i === 0) kit.cyl(g, m.chrome, 0.011, 0.008, x1 - 0.06, y - 0.027, z1, { axis: 'z', segments: 12 });
    y = y0;
  }
  for (const x of [x0, x1 - 0.022]) for (const z of [z0, z1 - 0.022]) kit.block(g, m.plinth, x, x + 0.022, by0, by1, z, z + 0.022);
  kit.block(g, body, x0 - 0.004, x1 + 0.004, by1, by1 + 0.025, z0 - 0.004, z1 + 0.004);
  kit.block(g, body, x0 - 0.004, x1 + 0.004, by1 + 0.025, h, z0 - 0.004, z0 + 0.016);
  for (const x of [x0 - 0.004, x1 - 0.016]) kit.block(g, body, x, x + 0.02, by1 + 0.025, h, z0 + 0.016, z1 + 0.004);

  const hx = -w / 2 + 0.014;
  for (const z of [z0 + 0.06, z1 - 0.06]) kit.block(g, m.darkSteel, hx, x0, by1 - 0.14, by1 - 0.11, z - 0.012, z + 0.012);
  kit.cyl(g, m.chrome, 0.012, z1 - z0 - 0.08, hx, by1 - 0.125, (z0 + z1) / 2, { axis: 'z', segments: 12 });

  const ty = by1 + 0.025;
  kit.block(g, m.white, x0 + 0.03, x0 + 0.27, ty, ty + 0.09, z0 + 0.05, z0 + 0.175);
  kit.block(g, kit.material(GLOVES[0], { roughness: 0.5 }), x0 + 0.03, x0 + 0.27, ty + 0.03, ty + 0.06, z0 + 0.175, z0 + 0.177, false);
  kit.block(g, m.slot, x0 + 0.09, x0 + 0.21, ty + 0.09, ty + 0.092, z0 + 0.09, z0 + 0.135, false);
  kit.block(g, m.sharps, x1 - 0.17, x1 - 0.04, ty, ty + 0.075, z0 + 0.04, z0 + 0.15);
  kit.block(g, m.shell, x1 - 0.17, x1 - 0.04, ty + 0.075, ty + 0.095, z0 + 0.04, z0 + 0.15);
  return g;
}

function drawSupplyCart(ctx, o) {
  const C = cartLayout(o.w, o.d, o.h);
  const hx = -o.w / 2 + 0.014;
  pen(ctx, o);
  box(ctx, C.x0 + 0.016, C.z0 + 0.016, C.x1 - 0.016, C.z1);
  line(ctx, hx, C.z0 + 0.04, hx, C.z1 - 0.04);
  for (const z of [C.z0 + 0.06, C.z1 - 0.06]) line(ctx, hx, z, C.x0, z);
  if (roomy(o)) {
    pen(ctx, o, FINE, o.theme.muted);
    box(ctx, C.x0 + 0.03, C.z0 + 0.05, C.x0 + 0.27, C.z0 + 0.175);
    box(ctx, C.x1 - 0.17, C.z0 + 0.04, C.x1 - 0.04, C.z0 + 0.15);
  }
  pen(ctx, o, OUT);
  box(ctx, C.x0 - 0.004, C.z0 - 0.004, C.x1 + 0.004, C.z1 + 0.004);
}

// ---- Registration -------------------------------------------------------------------

registerItems([
  fixed({
    type: 'exam-table', name: 'Exam table', category: 'medical', colorable: true,
    w: 1.83, d: 0.71, h: 1.0,
    tags: ['exam', 'treatment table', 'patient', 'clinic'],
    build: buildExamTable, draw2d: drawExamTable,
  }),
  {
    type: 'exam-casework', name: 'Exam room casework', category: 'medical',
    w: 2.13, d: 0.61, h: 2.13, resizable: true,
    tags: ['casework', 'sink', 'cabinets', 'counter', 'gloves'],
    build: buildCasework, draw2d: drawCasework,
  },
  fixed({
    type: 'physician-stool', name: 'Physician stool', category: 'medical', colorable: true, planFill: false,
    w: 0.51, d: 0.51, h: 0.6,
    tags: ['stool', 'rolling', 'doctor', 'seating'],
    build: buildPhysicianStool, draw2d: drawPhysicianStool,
  }),
  fixed({
    type: 'side-chair', name: 'Side chair', category: 'medical', colorable: true,
    w: 0.56, d: 0.56, h: 0.84,
    tags: ['chair', 'guest', 'visitor', 'seating'],
    build: buildSideChair, draw2d: drawSideChair,
  }),
  {
    type: 'reception-desk', name: 'Reception desk', category: 'medical',
    w: 3.05, d: 0.91, h: 1.07, resizable: true,
    tags: ['reception', 'front desk', 'check-in', 'transaction counter'],
    build: (kit, o) => buildDesk(kit, o, RECEPTION), draw2d: (ctx, o) => drawDesk(ctx, o, RECEPTION),
  },
  {
    type: 'waiting-chairs', name: 'Waiting chairs', category: 'medical', colorable: true,
    w: 2.44, d: 0.71, h: 0.84, resizable: true,
    tags: ['waiting room', 'beam seating', 'lobby', 'seating'],
    build: buildWaitingChairs, draw2d: drawWaitingChairs,
  },
  {
    type: 'nurse-station', name: 'Nurse station', category: 'medical',
    w: 2.44, d: 0.91, h: 1.07, resizable: true,
    tags: ['nurse', 'care station', 'charting', 'desk'],
    build: (kit, o) => buildDesk(kit, o, NURSE), draw2d: (ctx, o) => drawDesk(ctx, o, NURSE),
  },
  fixed({
    type: 'hospital-bed', name: 'Hospital bed', category: 'medical',
    w: 1.02, d: 2.24, h: 1.0,
    tags: ['bed', 'patient', 'inpatient', 'recovery'],
    build: buildHospitalBed, draw2d: drawHospitalBed,
  }),
  fixed({
    type: 'patient-recliner', name: 'Treatment recliner', category: 'medical', colorable: true,
    w: 0.86, d: 1.02, h: 1.07,
    tags: ['infusion', 'recliner', 'iv pole', 'dialysis', 'chemo'],
    build: buildRecliner, draw2d: drawRecliner,
  }),
  fixed({
    type: 'ct-scanner', name: 'CT scanner', category: 'medical',
    w: 2.13, d: 4.27, h: 1.93,
    tags: ['imaging', 'radiology', 'ct', 'scanner'],
    build: buildCT, draw2d: drawCT,
  }),
  fixed({
    type: 'privacy-curtain', name: 'Privacy curtain', category: 'medical', colorable: true,
    w: 2.44, d: 0.1, h: 2.29, blocking: false,
    tags: ['cubicle curtain', 'privacy', 'track', 'patient bay'],
    build: buildCurtain, draw2d: drawCurtain,
  }),
  fixed({
    type: 'supply-cart', name: 'Supply cart', category: 'medical',
    w: 0.61, d: 0.51, h: 1.0,
    tags: ['cart', 'supplies', 'drawers', 'mobile'],
    build: buildSupplyCart, draw2d: drawSupplyCart,
  }),
]);
