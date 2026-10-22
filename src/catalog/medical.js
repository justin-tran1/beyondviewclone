// Medical office catalog: exam rooms, reception and waiting, patient care and imaging.
// Local frame: x = width, y = up, z = depth with the front facing +z (plan +y).
import { registerItems } from './registry.js';
import { tint, cushion, turned, bent, assembly, barPull, roundSeat, officeChair, warpAt, smooth01, shaded } from './lab.js';

const TOP = 0.9;        // casework counter height
const DESK = 0.74;      // work surface height
const TOE = 0.1;        // toe kick height
const GAP = 0.004;      // half the reveal between fronts
const FRONT_T = 0.018;  // door and drawer front thickness
const OUT = 1.25;       // plan outline weight in px
const FINE = 0.75;      // plan detail weight in px
const DASH = [4, 3];    // hidden or overhead elements, in px
const MAX_REPEAT = 200; // most modules or seats a run repeats, so absurd sizes stay fast

const VINYL = '#557b7a';            // clinical upholstery (sage)
const GLOVES = ['#80bbad', '#538184', '#032842'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const repeats = (n, min = 1) => clamp(n, min, MAX_REPEAT);
const custom = (color) => (typeof color === 'string' && color ? color : null);
const span = (a, b) => (a < b ? [a, b] : [b, a]);
const q = (v) => Math.round(v * 1e4);

// ---- Materials ----------------------------------------------------------------------

/** Clinical finishes: laminate casework, quartz tops, brushed stainless, molded plastics, vinyl. */
function palette(kit) {
  const plastic = kit.mat.plastic;
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
    reveal: kit.material('#3d4245', { roughness: 0.9 }),
    plinth: kit.mat.rubber,
    trim: tint(kit, plastic, '#dadedd'),
    shell: tint(kit, plastic, '#eaecea'),
    slot: kit.material('#25292c', { roughness: 0.9 }),
    alu: tint(kit, kit.mat.steel, '#cfd2d3'),
    sharps: tint(kit, plastic, '#a63a31'),
    paper: kit.material('#efeee9', { roughness: 0.85 }),
    linen: tint(kit, kit.mat.fabricGrey, '#e7e6e1'),
  };
}

/** The item's main finish in the caller's color, keeping the fallback's texture. */
function finish(kit, color, fallback) {
  return tint(kit, fallback, custom(color));
}

/** Wipeable vinyl upholstery, sage unless the caller picks a color. */
const vinyl = (kit, color) => tint(kit, kit.mat.vinylBlue, custom(color) || VINYL);

/** A darker variant of a finish, for seams and welts. */
const shadeOf = (kit, mat, f = 0.72) => tint(kit, mat, null, f);

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

/** Upholstered pad with rounded edges and a crown on its top (face 'y') or front (face 'z'). */
function pad(kit, g, mat, x0, x1, y0, y1, z0, z1, face = 'y') {
  const t = face === 'y' ? y1 - y0 : z1 - z0;
  const crown = Math.min(0.012, t * 0.25);
  const r = Math.min(0.03, t * 0.4, (x1 - x0) * 0.3);
  if (face === 'y') cushion(kit, g, mat, x0, x1, y0, y1 - crown, z0, z1, { r, crown });
  else cushion(kit, g, mat, x0, x1, y0, y1, z0, z1 - crown, { r, crown, axis: 'z' });
}

/** Door or drawer front whose face is at z, facing +z (s = 1) or -z (s = -1). */
function front(kit, g, mat, x0, x1, y0, y1, z, s = 1) {
  kit.block(g, mat, x0 + GAP, x1 - GAP, y0 + GAP, y1 - GAP, ...span(z, z - s * FRONT_T));
}

/** Stainless wire pull on a face at z, facing +z (s = 1) or -z (s = -1). */
function pull(kit, g, mat, x, y, z, vertical, len, s = 1) {
  barPull(kit, g, mat, x, y, z, len, { vertical, reach: 0.015, r: 0.0045, s });
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

/** Swivel caster with its wheel of radius r resting on the floor: twin wheels under a fork. */
function caster(kit, g, m, x, z, r) {
  for (const s of [-1, 1]) kit.cyl(g, m.rubber, r, r * 0.34, x + s * r * 0.22, r, z, { axis: 'x', segments: 16 });
  kit.cyl(g, m.darkSteel, r * 0.3, r * 0.9, x, r, z, { axis: 'x', segments: 10 });
  kit.block(g, m.darkSteel, x - r * 0.5, x + r * 0.5, r * 1.4, r * 2.4, z - r * 0.55, z + r * 0.55);
}

/** Five-star base on casters, hub at the origin, legs reaching `reach`. */
function starBase(kit, g, m, reach, r = 0.025) {
  const y = 2 * r + 0.006;
  kit.cyl(g, m.black, 0.052, 0.05, 0, y - 0.008, 0, { rTop: 0.04, segments: 18 });
  for (let i = 0; i < 5; i++) {
    const leg = sub(kit, g, 0, 0, 0, { yaw: (i * Math.PI * 2) / 5 + Math.PI / 2 });
    const tilt = sub(kit, leg, 0, y + 0.014, 0, { roll: -0.04 });
    cushion(kit, tilt, m.black, 0.03, reach - r + 0.008, -0.014, 0.014, -0.018, 0.018, { r: 0.01 });
    for (const s of [-1, 1]) kit.cyl(leg, m.rubber, r, r * 0.42, reach - r, r, s * r * 0.3, { axis: 'z', segments: 14 });
  }
}

/** Office task chair facing +z, centered at (x, z) (officeChair in lab.js). */
function taskChair(kit, g, m, fabric, x, z) {
  return officeChair(kit, g, x, z, 0, { fabric });
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
  turned(kit, f, m.chrome, [[0, 0], [0.025, 0], [0.025, 0.01], [0.018, 0.02], [0.012, 0.026], [0, 0.026]], 0, 0, 0, { segments: 20 });
  const pts = [[0, 0.02, 0], [0, rise * 0.6, 0]];
  for (let i = 0; i <= 8; i++) {
    const a = Math.PI * (1 - i / 8);
    pts.push([r + r * Math.cos(a), rise + r * Math.sin(a), 0]);
  }
  pts.push([reach, rise - 0.03, 0]);
  bent(kit, f, m.chrome, pts, t, { segments: 36, radial: 10 });
  kit.cyl(f, m.chrome, t * 1.35, 0.03, reach, rise - 0.045, 0, { segments: 12 });
  for (const s of [-1, 1]) {
    kit.cyl(f, m.chrome, 0.014, 0.045, 0, 0, s * 0.075, { segments: 14 });
    bent(kit, f, m.chrome, [[0, 0.042, s * 0.075], [0, 0.046, s * 0.12], [0, 0.052, s * 0.175]], 0.005, { segments: 6, radial: 8 });
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
  kit.block(g, m.paper, L.pivot + 0.02, L.x1, seat + padT, seat + padT + 0.002, -paper, paper, false, { bevel: false });
  kit.block(g, m.paper, L.x1, L.x1 + 0.002, seat + 0.03, seat + padT + 0.002, -paper, paper, false, { bevel: false });

  const br = sub(kit, g, L.pivot, seat, 0, { roll: -L.tilt });
  const len = L.back;
  kit.block(br, m.plinth, -len + 0.05, -0.04, -0.035, 0, -d / 2 + 0.07, d / 2 - 0.07);
  pad(kit, br, top, -len, -0.006, 0, padT, z0, z1);
  kit.block(br, m.paper, -len + 0.01, -0.02, padT, padT + 0.002, -paper, paper, false, { bevel: false });
  kit.block(br, m.paper, -len - 0.002, -len, -0.06, padT + 0.002, -paper, paper, false, { bevel: false });
  kit.cyl(br, m.paper, 0.05, paper * 2 + 0.02, -len + 0.05, -0.065, 0, { axis: 'z', segments: 24 });
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
  const n = repeats(Math.round(w / 0.6));
  const mw = w / n;
  const sink = n === 1 ? 0 : Math.floor(n / 2);
  const fz = d / 2 - 0.025;
  const sx = -w / 2 + (sink + 0.5) * mw;
  // The bowl stays 3 cm inside its module, so an end module keeps a closed side, and on shallow
  // counters it gets shallower so the faucet behind it stays on the counter.
  const bowlW = Math.min(clamp(mw - 0.16, 0.28, 0.5), mw - 0.06);
  const bowlD = Math.min(clamp(d - 0.25, 0.22, 0.38), d - 0.19);
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
    kit.block(g, kit.material(GLOVES[k], { roughness: 0.6 }), bx + 0.008, bx + bw - 0.008, y + 0.075, y + 0.13, fz, fz + 0.002, false, { bevel: false });
    kit.block(g, m.slot, bx + 0.025, bx + bw - 0.025, y1 - 0.085, y1 - 0.045, fz, fz + 0.002, false);
  }
}

function towelDispenser(kit, g, m, x, y, z) {
  kit.block(g, m.shell, x - 0.13, x + 0.13, y, y + 0.28, z, z + 0.1);
  kit.block(g, m.trim, x - 0.12, x + 0.12, y + 0.02, y + 0.27, z + 0.1, z + 0.106);
  kit.block(g, m.slot, x - 0.09, x + 0.09, y + 0.18, y + 0.22, z + 0.106, z + 0.108, false);
  kit.block(g, m.paper, x - 0.09, x + 0.09, y - 0.04, y + 0.005, z + 0.05, z + 0.058);
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
  const door = finish(kit, color, m.case);
  const L = caseworkLayout(w, d, h);
  const ct = TOP - 0.03, bowlDepth = 0.18, cutY = TOP - bowlDepth - 0.03;
  const back = -d / 2, carcass = L.fz - FRONT_T - 0.004;
  const sb = -w / 2 + (L.sink + 1) * L.mw;

  kit.block(g, m.plinth, -w / 2 + 0.01, w / 2 - 0.01, 0, TOE, back, L.fz - 0.06);
  // Only a pocket around the bowl drops below the counter, so the back and both ends stay closed.
  const p = { x0: L.hole.x0 - 0.01, x1: L.hole.x1 + 0.01, z0: Math.max(back, L.hole.z0 - 0.01), z1: Math.min(carcass, L.hole.z1 + 0.01) };
  const parts = [
    [-w / 2, p.x0, ct, back, carcass], [p.x1, w / 2, ct, back, carcass],
    [p.x0, p.x1, ct, back, p.z0], [p.x0, p.x1, ct, p.z1, carcass], [p.x0, p.x1, cutY, p.z0, p.z1],
  ];
  for (const [a, b, y, za, zb] of parts) if (b - a > 0.002 && zb - za > 0.002) kit.block(g, m.case, a, b, TOE, y, za, zb);
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
  kit.cyl(g, m.black, 0.15, 0.022, 0, sy - 0.022, 0, { segments: 28 });
  bent(kit, g, m.black, [[0.08, sy - 0.024, 0], [0.16, sy - 0.03, 0], [0.2, sy - 0.05, 0]], 0.006, { segments: 6, radial: 8 });
  roundSeat(kit, g, seat, 0.2, 0.07, 0, sy - 0.002, 0, { crown: 0.016, rim: 0.03 });
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
  const fabric = finish(kit, color, kit.mat.fabricSage);
  const { hx, hz, t, seatY, armY } = sideChairLayout(w, d);
  // Solid oak frame with softened edges; legs taper toward the floor glides.
  const ease = { bevel: 0.006 };
  const taper = (y1) => warpAt(`side-leg-${q(y1)}`, 0, y1 / 2, 0, (v) => {
    const k = 1 - 0.22 * clamp(1 - v.y / y1, 0, 1);
    v.x *= k;
    v.z *= k;
  });
  for (const s of [-1, 1]) {
    const x = s * hx;
    cushion(kit, sub(kit, g, x, 0, hz), wood, -t, t, 0, armY, -t, t, { r: 0.006, warp: taper(armY), mid: [1, 2, 1], k: 1 });
    cushion(kit, sub(kit, g, x, 0, -hz), wood, -t, t, 0, h - 0.01, -t, t, { r: 0.006, warp: taper(h - 0.01), mid: [1, 2, 1], k: 1 });
    cushion(kit, g, wood, x - 0.03, x + 0.03, armY, armY + 0.028, -hz - t, hz + t + 0.012, { r: 0.012 });
    kit.block(g, wood, x - 0.016, x + 0.016, seatY - 0.09, seatY - 0.03, -hz, hz, true, ease);
    kit.block(g, wood, x - 0.012, x + 0.012, 0.14, 0.17, -hz, hz, true, ease);
    for (const z of [-hz, hz]) kit.cyl(g, kit.mat.black, 0.014, 0.004, x, 0, z, { segments: 10 });
  }
  kit.block(g, wood, -hx, hx, seatY - 0.09, seatY - 0.03, hz - 0.016, hz + 0.016, true, ease);
  kit.block(g, wood, -hx, hx, seatY - 0.09, seatY - 0.03, -hz - 0.016, -hz + 0.016, true, ease);
  // Seat rolled down at the front edge; back padded and gently bowed.
  const z0 = -hz + t, z1 = hz + 0.02;
  cushion(kit, g, fabric, -hx + t, hx - t, seatY - 0.03, seatY + 0.03, z0, z1, {
    r: 0.026, crown: 0.012, mid: [3, 1, 3],
    warp: warpAt(`side-seat-${q(z1)}`, 0, seatY, (z0 + z1) / 2, (v) => {
      const k = smooth01((v.z - z1 + 0.12) / 0.11);
      v.y -= 0.016 * k * k;
    }),
  });
  kit.block(g, wood, -hx, hx, h - 0.06, h - 0.01, -hz - 0.016, -hz + 0.016, true, ease);
  cushion(kit, g, fabric, -hx + t, hx - t, seatY + 0.07, h - 0.07, -hz - 0.012, -hz + 0.025, {
    r: 0.02, crown: 0.01, axis: 'z', mid: [3, 3, 1],
    warp: warpAt(`side-back-${q(hx)}`, 0, (seatY + h) / 2, -hz + 0.0065, (v) => {
      v.z += (v.x * v.x) / (2 * 0.9);
    }),
  });
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
  const n = repeats(Math.round(w / pitch));
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
  kit.cyl(g, tint(kit, kit.mat.plastic, '#86aaa1'), 0.0345, 0.04, x, y + 0.04, z, { segments: 16 });
  kit.cyl(g, m.trim, 0.018, 0.03, x, y + 0.12, z, { segments: 12 });
  kit.block(g, m.trim, x - 0.006, x + 0.006, y + 0.135, y + 0.15, z, z + 0.045);
}

function buildDesk(kit, { w, d, h, color }, variant) {
  const g = kit.group();
  const m = palette(kit);
  const L = deskLayout(w, d, variant.pitch);
  const face = finish(kit, color, variant.face(kit));
  const work = m.laminate;
  const fz = L.front - 0.012;
  const ledgeY = h - 0.03;

  kit.block(g, m.plinth, -w / 2 + 0.015, w / 2 - 0.015, 0, 0.08, L.inner + 0.01, fz - 0.025);
  kit.block(g, m.laminate, -w / 2, w / 2, 0.08, ledgeY, L.inner, fz - 0.02);
  variant.dress(kit, g, m, w, fz, ledgeY, face);
  kit.block(g, m.quartz, -w / 2, w / 2, ledgeY, h, L.ledge0, L.front);
  kit.block(g, m.led, -w / 2 + 0.06, w / 2 - 0.06, ledgeY - 0.006, ledgeY, L.ledge0 + 0.02, L.ledge0 + 0.04, false);
  const brackets = repeats(Math.round(w / 0.9) + 1, 2);
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
  /** Vertical oak slats with dark shadow gaps over a recessed backer, wrapping the ends. */
  dress(kit, g, m, w, fz, ledgeY, face) {
    // A dark stained backer keeps the gaps reading as shadow without the hard contrast that
    // shimmers when the desk is seen from across a room.
    const backer = kit.material('#43372c', { roughness: 0.8 });
    kit.block(g, backer, -w / 2 + 0.006, w / 2 - 0.006, 0.08, ledgeY, fz - 0.02, fz - 0.012);
    const n = clamp(Math.round((w - 0.02) / 0.076), 2, MAX_REPEAT), p = (w - 0.02) / n, sw = p - 0.013;
    g.add(assembly(kit, `reception-slats|${face.uuid}|${q(w)}|${q(ledgeY)}`, (a) => {
      for (let i = 0; i < n; i++) {
        const x = -w / 2 + 0.01 + (i + 0.5) * p;
        kit.block(a, face, x - sw / 2, x + sw / 2, 0.09, ledgeY - 0.006, fz - 0.012, fz + 0.006);
      }
      for (const s of [-1, 1]) kit.block(a, face, ...span(s * w / 2, s * (w / 2 - 0.02)), 0.09, ledgeY - 0.006, fz - 0.24, fz + 0.006);
    }));
  },
};

const NURSE = {
  pitch: 1.2,
  face: (kit) => tint(kit, kit.mat.laminate, '#5b7e7c'),
  /** Laminate panels with vertical reveals under a white solid surface band with a steel reveal. */
  dress(kit, g, m, w, fz, ledgeY, face) {
    kit.block(g, face, -w / 2, w / 2, 0.08, ledgeY, fz - 0.02, fz);
    const n = repeats(Math.round(w / 0.8));
    for (let i = 1; i < n; i++) {
      const x = -w / 2 + (i * w) / n;
      kit.block(g, m.reveal, x - 0.003, x + 0.003, 0.08, ledgeY - 0.2, fz - 0.001, fz + 0.0012, false, { bevel: false });
    }
    kit.block(g, m.white, -w / 2, w / 2, ledgeY - 0.2, ledgeY, fz - 0.002, fz + 0.006);
    kit.block(g, m.steel, -w / 2, w / 2, ledgeY - 0.208, ledgeY - 0.2, fz - 0.001, fz + 0.004, false, { bevel: false });
  },
};

// ---- Waiting chairs -----------------------------------------------------------------

function waitingLayout(w, d) {
  const n = repeats(Math.round(w / 0.61));
  const p = w / n, armT = 0.05;
  const arms = Array.from({ length: n + 1 }, (_, i) => clamp(-w / 2 + i * p, -w / 2 + armT / 2, w / 2 - armT / 2));
  // Shallow rows get a shallower seat so the reclined back stays inside the footprint.
  const seatZ1 = d / 2 - 0.04, seatZ0 = seatZ1 - Math.min(clamp(d - 0.19, 0.3, 0.52), d - 0.13);
  return { n, armT, arms, seatZ0, seatZ1, backZ: seatZ0 - 0.005, beamZ: (seatZ0 + seatZ1) / 2 - 0.1, foot: d / 2 - 0.05 };
}

function buildWaitingChairs(kit, { w, d, color }) {
  const g = kit.group();
  const m = palette(kit);
  const fabric = finish(kit, color, kit.mat.fabricGreen);
  const frame = m.darkSteel;
  const L = waitingLayout(w, d);
  const bz = L.beamZ;
  kit.block(g, frame, -w / 2 + 0.04, w / 2 - 0.04, 0.3, 0.36, bz - 0.03, bz + 0.03);
  for (const [i, x] of L.arms.entries()) {
    kit.block(g, frame, x - 0.012, x + 0.012, 0.36, 0.6, bz + 0.065, bz + 0.105);
    kit.block(g, frame, x - 0.012, x + 0.012, 0.33, 0.37, bz - 0.015, bz + 0.105);
    cushion(kit, g, m.oak, x - L.armT / 2, x + L.armT / 2, 0.6, 0.63, L.seatZ0 - 0.02, L.seatZ1 - 0.02, { r: 0.01 });
    if (i % 2 && i !== L.n) continue;
    kit.block(g, frame, x - 0.02, x + 0.02, 0.03, 0.3, bz - 0.025, bz + 0.015);
    kit.block(g, frame, x - 0.022, x + 0.022, 0.012, 0.045, -L.foot, L.foot);
    for (const z of [-L.foot + 0.02, L.foot - 0.02]) kit.block(g, m.rubber, x - 0.02, x + 0.02, 0, 0.012, z - 0.02, z + 0.02);
  }
  // Seats roll down at the front edge; backs bow around the sitter with a soft lumbar.
  const zf = L.seatZ1;
  const seatContour = (v) => {
    const t = smooth01((v.z - zf + 0.13) / 0.12);
    v.y -= 0.022 * t * t;
    v.z -= 0.008 * t * t;
  };
  const backContour = (v) => {
    v.z += (v.x * v.x) / (2 * 0.75) + 0.014 * Math.exp(-(((v.y - 0.1) / 0.09) ** 2));
  };
  for (let i = 0; i < L.n; i++) {
    const x0 = L.arms[i] + L.armT / 2 + 0.008, x1 = L.arms[i + 1] - L.armT / 2 - 0.008, cx = (x0 + x1) / 2, hw = (x1 - x0) / 2;
    const mid = [4, 1, 4];
    kit.block(g, frame, cx - 0.16, cx + 0.16, 0.36, 0.4, L.seatZ0 + 0.04, L.seatZ1 - 0.06);
    cushion(kit, g, frame, x0 + 0.005, x1 - 0.005, 0.392, 0.41, L.seatZ0 + 0.005, L.seatZ1 - 0.01, { r: 0.007, warp: warpAt('wait-shell', 0, 0.401, (L.seatZ0 + L.seatZ1 - 0.005) / 2, seatContour), mid, k: 1 });
    cushion(kit, g, fabric, x0, x1, 0.405, 0.458, L.seatZ0, L.seatZ1, { r: 0.026, crown: 0.012, warp: warpAt('wait-seat', 0, 0.4315, (L.seatZ0 + L.seatZ1) / 2, seatContour), mid });
    kit.block(g, frame, cx - 0.02, cx + 0.02, 0.3, 0.34, L.backZ, bz - 0.03);
    kit.block(g, frame, cx - 0.02, cx + 0.02, 0.3, 0.56, L.backZ - 0.04, L.backZ);
    const back = sub(kit, g, cx, 0.5, L.backZ + 0.005, { pitch: -0.14 });
    cushion(kit, back, frame, -hw + 0.008, hw - 0.008, 0, 0.32, -0.035, -0.015, { r: 0.007, warp: warpAt('wait-back-shell', 0, 0.16, -0.025, backContour), mid: [4, 4, 1], k: 1 });
    cushion(kit, back, fabric, -hw, hw, 0.01, 0.34, -0.018, 0.03, { r: 0.022, crown: 0.01, axis: 'z', warp: warpAt('wait-back', 0, 0.175, 0.006, backContour), mid: [4, 4, 1] });
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
  const blanket = finish(kit, color, kit.mat.fabricCeladon);
  const mattress = tint(kit, kit.mat.vinylBlue, '#45606e');
  const board = tint(kit, kit.mat.plastic, '#e4e7e6');
  const hz = d / 2, bx = w / 2 - 0.06, mx = w / 2 - 0.07;
  const { pivot, deck, mT, tilt, headLen, fold } = BED;
  const top = deck + mT;

  for (const sx of [-1, 1]) for (const sz of [-1, 1]) caster(kit, g, m, sx * 0.36, sz * (hz - 0.2), 0.065);
  kit.block(g, m.darkSteel, -0.4, 0.4, 0.15, 0.2, -hz + 0.12, hz - 0.12);
  kit.block(g, m.shell, -0.34, 0.34, 0.2, 0.3, -hz + 0.3, hz - 0.3);
  for (const z of [-0.5, 0.5]) kit.block(g, m.darkSteel, -0.1, 0.1, 0.3, deck - 0.06, z - 0.08, z + 0.08);
  kit.block(g, m.shell, -mx + 0.01, mx - 0.01, deck - 0.06, deck, -hz + 0.1, hz - 0.07);

  // Mattress in a fitted sheet, a blanket draped over the foot and a folded sheet cuff.
  cushion(kit, g, mattress, -mx, mx, deck, top - 0.006, pivot, hz - 0.08, { r: 0.03 });
  cushion(kit, g, m.linen, -mx + 0.004, mx - 0.004, top - 0.02, top + 0.002, pivot, fold + 0.03, { r: 0.008 });
  cushion(kit, g, blanket, -mx - 0.012, mx + 0.012, top - 0.014, top + 0.014, fold, hz - 0.075, { r: 0.012, crown: 0.006 });
  for (const s of [-1, 1]) cushion(kit, g, blanket, ...span(s * (mx - 0.004), s * (mx + 0.012)), deck + 0.03, top + 0.004, fold, hz - 0.075, { r: 0.006 });
  cushion(kit, g, blanket, -mx - 0.012, mx + 0.012, deck + 0.03, top + 0.014, hz - 0.087, hz - 0.071, { r: 0.006 });
  kit.cyl(g, m.linen, 0.026, 2 * mx + 0.02, 0, top + 0.012, fold + 0.012, { axis: 'x', segments: 18 });

  const hs = sub(kit, g, 0, deck, pivot, { pitch: tilt });
  kit.block(hs, m.shell, -mx + 0.01, mx - 0.01, -0.04, 0, -headLen, 0);
  cushion(kit, hs, mattress, -mx, mx, 0, mT - 0.006, -headLen, 0.02, { r: 0.03 });
  cushion(kit, hs, m.linen, -mx + 0.004, mx - 0.004, mT - 0.02, mT + 0.002, -headLen + 0.004, 0.02, { r: 0.008 });
  const p0 = -headLen + 0.06, p1 = -headLen + 0.36, pr = 0.05;
  cushion(kit, hs, m.linen, -0.28, 0.28, mT - 0.004, mT + 2 * pr - 0.04, p0, p1, { r: 0.04, crown: 0.02, both: true });

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
  const seam = shadeOf(kit, up);
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
  const bag = kit.glassMaterial({ tint: '#eef5f3', frosted: true });
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

/** Gantry ring in the xy plane centered at height cy, spanning z0..z1, its edges radiused by e. */
function annulus(kit, g, mat, cy, rIn, rOut, z0, z1, e = 0.04) {
  const d = z1 - z0, arc = (cx, cz, a0) => [0, 1, 2, 3].map((k) => {
    const a = a0 + (k * Math.PI) / 6;
    return [cx + e * Math.cos(a), cz + e * Math.sin(a)];
  });
  // Profile [radius, depth] around the ring: front face out, outer wall, back face in, bore.
  const profile = [
    [rIn + e, 0], ...arc(rOut - e, e, -Math.PI / 2), ...arc(rOut - e, d - e, 0),
    ...arc(rIn + e, d - e, Math.PI / 2), ...arc(rIn + e, e, Math.PI), [rIn + e, 0],
  ];
  const ring = turned(kit, g, mat, profile, 0, cy, z0, { segments: 64 });
  ring.rotation.x = Math.PI / 2;
  return ring;
}

function buildCT(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = palette(kit);
  const body = tint(kit, kit.mat.plastic, '#eef0ee');
  const mat = vinyl(kit, color);
  const glow = kit.material('#bfe9dc', { emissive: '#80bbad', emissiveIntensity: 1.2, roughness: 0.4 });
  const C = ctLayout(w, d, h);
  const { ro, rb, cy, gz0, gz1 } = C;

  annulus(kit, g, body, cy, rb, ro, gz0, gz1);
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
  pad(kit, g, mat, -0.22, 0.22, 0.77, 0.815, gz0 + 0.35, C.tip - 0.05);
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

// The track sits just under a 9 ft ceiling, hung from drop rods that reach 10 ft (the item's height),
// so it reads as ceiling mounted under any ceiling in that range; lower ceilings hide the rod tops.
const CURTAIN = { track: 2.7, rod: 1.2 };

function curtainLayout(w, d, h) {
  const n = 2 * repeats(Math.round(w / 0.24));
  const top = Math.min(CURTAIN.track, h);
  return { n, s: w / n, a: Math.min(0.03, d / 2 - 0.012), top, rods: repeats(Math.round(w / CURTAIN.rod) + 1, 2) };
}

function buildCurtain(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = palette(kit);
  const fabric = finish(kit, color, kit.mat.fabricCeladon);
  const mesh = kit.material('#f1f3f2', { roughness: 0.9, transparent: true, opacity: 0.5, depthWrite: false });
  const C = curtainLayout(w, d, h);
  const { top } = C;
  const trackY = top - 0.035, meshTop = top - 0.08, meshBot = Math.max(0.8, top - 0.56), hem = Math.min(0.35, top * 0.15);
  const zAt = (i) => (i % 2 ? C.a : -C.a);
  // Soft folds through the same points the carriers hang from: fabric, open mesh and a header band.
  pleats(kit, g, fabric, w, hem, meshBot, C);
  pleats(kit, g, mesh, w, meshBot, meshTop - 0.025, C);
  pleats(kit, g, m.linen, w, meshTop - 0.025, meshTop, C);
  for (let i = 0; i <= C.n; i += 2) {
    const x = clamp(-w / 2 + i * C.s, -w / 2 + 0.01, w / 2 - 0.01);
    rod(kit, g, m.alu, 0.003, [x, meshTop - 0.01, zAt(i)], [x, trackY, 0], { segments: 5 });
  }
  kit.block(g, m.alu, -w / 2, w / 2, trackY, top, -0.018, 0.018);
  for (const s of [-1, 1]) kit.block(g, m.darkSteel, ...span(s * w / 2, s * (w / 2 - 0.02)), trackY - 0.008, top, -0.02, 0.02);
  if (h - top > 0.01) {
    for (let i = 0; i < C.rods; i++) {
      const x = -w / 2 + 0.15 + (i * (w - 0.3)) / (C.rods - 1);
      kit.block(g, m.darkSteel, x - 0.03, x + 0.03, top, top + 0.012, -0.016, 0.016);
      kit.cyl(g, m.alu, 0.008, h - top - 0.012, x, top + 0.012, 0, { segments: 10 });
      kit.cyl(g, m.white, 0.035, 0.008, x, h - 0.008, 0, { segments: 16 });
    }
  }
  return g;
}

/**
 * Two-sided curtain sheet from y0 to y1 whose folds pass through +-C.a at every half pleat (C.s),
 * with UVs in meters along the cloth.
 */
function pleats(kit, g, mat, w, y0, y1, C) {
  const T = kit.THREE;
  const steps = C.n * 4, rows = Math.max(1, Math.round((y1 - y0) / 0.4));
  const pos = [], nrm = [], uv = [];
  let u = 0, px = -w / 2, pz = 0;
  const cols = [];
  for (let i = 0; i <= steps; i++) {
    const x = -w / 2 + (i / steps) * w, ph = (Math.PI * x) / C.s, z = -C.a * Math.cos(ph + Math.PI * (w / 2 / C.s));
    const dz = C.a * Math.sin(ph + Math.PI * (w / 2 / C.s)) * (Math.PI / C.s);
    if (i) u += Math.hypot(x - px, z - pz);
    px = x;
    pz = z;
    const l = Math.hypot(dz, 1);
    cols.push({ x, z, u, nx: -dz / l, nz: 1 / l });
  }
  for (const side of [1, -1]) {
    for (const c of cols) {
      for (let j = 0; j <= rows; j++) {
        const y = y0 + ((y1 - y0) * j) / rows;
        pos.push(c.x, y, c.z + side * 0.0015);
        nrm.push(side * c.nx, 0, side * c.nz);
        uv.push(c.u, y);
      }
    }
  }
  const idx = [], per = (steps + 1) * (rows + 1);
  for (const [side, base] of [[1, 0], [-1, per]]) {
    for (let i = 0; i < steps; i++) {
      for (let j = 0; j < rows; j++) {
        const a = base + i * (rows + 1) + j, b = a + rows + 1;
        if (side > 0) idx.push(a, b, a + 1, b, b + 1, a + 1);
        else idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
  }
  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new T.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mesh = new T.Mesh(geo, mat);
  mesh.castShadow = !mat.transparent;
  mesh.receiveShadow = true;
  g.add(mesh);
  return mesh;
}

function drawCurtain(ctx, o) {
  const amp = clamp(2 * o.px, 0.02, o.d / 2);
  const period = Math.max(0.24, 10 * o.px);
  const waves = repeats(Math.round(o.w / period));
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
  const drawer = finish(kit, color, tint(kit, kit.mat.plastic, '#8db3a9'));
  const body = tint(kit, kit.mat.plastic, '#e4e7e6');
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
    kit.block(g, m.paper, x0 + 0.05, x0 + 0.13, y - 0.035, y - 0.018, z1, z1 + 0.002, false);
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
  kit.block(g, kit.material(GLOVES[0], { roughness: 0.6 }), x0 + 0.03, x0 + 0.27, ty + 0.03, ty + 0.06, z0 + 0.175, z0 + 0.177, false, { bevel: false });
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

registerItems(shaded([
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
    type: 'physician-stool', name: 'Physician stool', category: 'medical', colorable: true, planFill: false, contactShadow: 'round',
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
    w: 2.44, d: 0.1, h: 3.05, blocking: false,
    tags: ['cubicle curtain', 'privacy', 'track', 'patient bay'],
    build: buildCurtain, draw2d: drawCurtain,
  }),
  fixed({
    type: 'supply-cart', name: 'Supply cart', category: 'medical',
    w: 0.61, d: 0.51, h: 1.0,
    tags: ['cart', 'supplies', 'drawers', 'mobile'],
    build: buildSupplyCart, draw2d: drawSupplyCart,
  }),
]));
