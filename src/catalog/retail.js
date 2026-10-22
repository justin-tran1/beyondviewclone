// Retail and industrial catalog: store fixtures (shelving, checkout, display, apparel) and
// warehouse equipment (pallet racking, pallets, forklift, workbench, bollards, floor markings).
// Local frame: x = width, y = up, z = depth with the front facing +z (plan +y).
import { registerItems } from './registry.js';
import { tint, cushion, turned, bent, assembly, barPull, warpAt, shaded } from './lab.js';

const OUT = 1.25;       // plan outline weight in px
const FINE = 0.75;      // plan detail weight in px
const DASH = [4, 3];    // hidden or overhead elements, in px
const TAU = Math.PI * 2;
const MAX_REPEAT = 200; // most bays, frames or braces a run repeats, so absurd sizes stay fast

const PRODUCTS = [
  '#f2f0ea', '#dbd99a', '#80bbad', '#538184', '#032842', '#c8664a', '#e2b04a', '#5b84a8',
  '#b9895a', '#8e4a57', '#cad1d3', '#2f5d50', '#e9d6bf', '#435254', '#a3c2b8',
];
const GARMENTS = [
  '#435254', '#80bbad', '#dbd99a', '#538184', '#e9e4d8', '#032842', '#a5876b', '#7f8480',
  '#b7c9c3', '#8b5e5e', '#f6f4ee', '#2f4f4a', '#c9b79c',
];
const KRAFT = ['#b9895a', '#c49a6c', '#a87c50', '#caa477'];
const LABELS = ['#efeee9', '#e7dcc8', '#30383b'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const repeats = (n, min = 1) => clamp(n, min, MAX_REPEAT);
const isColor = (c) => typeof c === 'string' && c.length > 0;
const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];

function seq(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---- Materials ----------------------------------------------------------------------

/** The item's main finish in the caller's color, keeping the fallback's texture. */
function finish(kit, color, fallback) {
  return tint(kit, fallback, isColor(color) ? color : null);
}

/** A darker (f < 1) or lighter (f > 1) variant of a finish. */
function shade(kit, mat, f) {
  return tint(kit, mat, null, f);
}

/** Painted steel (powder coat) in a color. */
const painted = (kit, hex, roughness = 0.4) => kit.paintMaterial(hex, { roughness });
const fabric = (kit, hex) => tint(kit, kit.mat.fabricGrey, hex);
const packaging = (kit, hex) => kit.material(hex, { roughness: 0.55 });
const glow = (kit, hex, intensity = 1) => kit.material(hex, { roughness: 0.4, emissive: hex, emissiveIntensity: intensity });

// ---- 3D helpers ---------------------------------------------------------------------

/** kit.block with extents in any order; bevel is 'auto', false or a radius in meters. */
function blk(kit, g, mat, x0, x1, y0, y1, z0, z1, shadows = true, bevel = 'auto') {
  return kit.block(g, mat, Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1),
    Math.min(z0, z1), Math.max(z0, z1), shadows, { bevel });
}

/** Box of size (sx, sy, sz) centered at (x, y, z), then rotated. */
function box(kit, g, mat, x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0) {
  const m = kit.block(g, mat, x - sx / 2, x + sx / 2, y - sy / 2, y + sy / 2, z - sz / 2, z + sz / 2);
  m.rotation.set(rx, ry, rz);
  return m;
}

/** Cylinder from point a to point b ([x, y, z]); r at a, rTop at b. */
function rod(kit, g, mat, r, a, b, { rTop = r, segments = 12 } = {}) {
  const T = kit.THREE;
  const dir = new T.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const m = kit.cyl(g, mat, r, dir.length(), 0, 0, 0, { segments, rTop });
  m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dir.normalize());
  return m;
}

function ellipsoid(kit, g, mat, x, y, z, rx, ry, rz, segments = 20) {
  const m = kit.sphere(g, mat, 1, x, y, z, { segments });
  m.scale.set(rx, ry, rz);
  return m;
}

/** Child group posed at (x, y, z) and rotated, for parts modeled in their own frame. */
function sub(kit, g, x, y, z, { yaw = 0, pitch = 0 } = {}) {
  const f = kit.group();
  f.position.set(x, y, z);
  f.rotation.set(pitch, yaw, 0, 'YXZ');
  g.add(f);
  return f;
}

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
  ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  paint(ctx, fill);
}

function rrect(ctx, x0, y0, x1, y1, r, fill) {
  const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  ctx.beginPath();
  ctx.roundRect(Math.min(x0, x1), Math.min(y0, y1), w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
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

function outline(ctx, o, fill = null) {
  pen(ctx, o, OUT);
  rect(ctx, -o.w / 2, -o.d / 2, o.w / 2, o.d / 2, fill);
}

/** Solid fill without a stroke. */
function fillRect(ctx, x0, y0, x1, y1, fill) {
  ctx.fillStyle = fill;
  ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
}

/** True when the symbol is drawn large enough for small details to stay legible. */
const roomy = (o) => o.px < 1 / 40;

// ---- Shelving -----------------------------------------------------------------------

const SHELF = { t: 0.022, kick: 0.12, post: 0.04, bay: 1.22, levels: 12 };

const bayCount = (w) => repeats(Math.round(w / SHELF.bay));

/** Shelf top surfaces from the base deck up; the top shelf leaves `headroom` above it. */
function shelfLevels(h, headroom) {
  const base = SHELF.kick + SHELF.t;
  const top = Math.max(base + 0.25, h - headroom);
  const n = clamp(Math.round((top - base) / 0.4), 1, SHELF.levels);
  const levels = [base];
  for (let k = 1; k <= n; k++) levels.push(base + (k * (top - base)) / n);
  return levels;
}

function shelfMats(kit, color) {
  return {
    frame: painted(kit, isColor(color) ? color : '#e2e4e1'),
    panel: painted(kit, isColor(color) ? `#${new kit.THREE.Color(color).multiplyScalar(0.85).getHexString()}` : '#d2d5d2', 0.5),
    channel: tint(kit, kit.mat.plastic, '#57646a'),
    tag: kit.material('#f3f3ef', { roughness: 0.5 }),
    lid: tint(kit, kit.mat.steel, '#c9cccd'),
  };
}

const LIDS = ['#e9e7e1', '#2b3033', '#a8562e', '#3b6178', '#b8962e'];
// Packaging by weight: printed cartons, plastic bottles, cans and glass jars. Shelves near the
// floor or overhead carry cartons only, where round packs would cost triangles nobody sees.
const STOCK = [['box', 0.6], ['bottle', 0.15], ['can', 0.12], ['jar', 0.13]];
const BOTTLE = [[0, 0], [0.9, 0], [1, 0.03], [1, 0.6], [0.82, 0.72], [0.4, 0.82], [0.4, 0.9]];
const BOTTLE_BACK = [[0, 0], [1, 0], [1, 0.6], [0.4, 0.82], [0.4, 1], [0, 1]];
const JAR = [[0, 0], [0.94, 0], [1, 0.05], [1, 0.84], [0.88, 0.9], [0, 0.9]];

function stockKind(rnd) {
  let t = rnd();
  for (const [k, p] of STOCK) if ((t -= p) < 0) return k;
  return 'box';
}

/**
 * Product facings filling a shelf from x0 to x1, faced up to the shelf edge: each run is one
 * product, as a row of cartons with label panels, or as bottles, cans or jars. A price tag sits on
 * the shelf edge under each run. Shelf depth runs from zb in direction s.
 */
function stockShelf(kit, g, m, rnd, { x0, x1, y, clear, zb, s, dep }) {
  // Facings widen on shelves longer than any real bay (only runs past the bay cap have those).
  const k = Math.max(1, (x1 - x0) / (2 * SHELF.bay));
  // Only shelves well below eye height show what stands behind the front row.
  const round = y > 0.3 && y < 1.45;
  const deep = y < 0.75;
  let x = x0 + 0.015;
  while (x < x1 - 0.08) {
    const run = Math.min(x1 - 0.015 - x, (0.16 + rnd() * 0.3) * k);
    if (run < 0.06) break;
    if (rnd() < 0.05) {
      x += run + 0.012;
      continue;
    }
    const color = pick(rnd, PRODUCTS), label = pick(rnd, LABELS);
    const face = zb + s * (dep - 0.006 - rnd() * 0.012);
    let kind = round ? stockKind(rnd) : 'box';
    if (kind !== 'box' && clear < 0.16) kind = 'box';
    if (kind === 'box') cartons(kit, g, rnd, { x, run, y, clear, zb, s, face, color, label, k });
    else rounds(kit, g, m, rnd, kind, { x, run, y, clear, s, face, dep, deep, color, label });
    const tx = x + Math.min(0.03, run * 0.2), edge = zb + s * (dep + 0.012);
    blk(kit, g, m.tag, tx, tx + 0.045, y - SHELF.t - 0.004, y + 0.012, edge, edge + s * 0.002, false, false);
    x += run + (0.008 + rnd() * 0.01) * k;
  }
}

/** A run of printed cartons standing side by side, each turned a hair off square. */
function cartons(kit, g, rnd, { x, run, y, clear, zb, s, face, color, label, k }) {
  const uw = Math.min(run, (0.055 + rnd() * 0.09) * k), gap = 0.004;
  const n = Math.max(1, Math.floor((run + gap) / (uw + gap))), bw = (run - (n - 1) * gap) / n;
  const ph = Math.min(0.34, clear * (0.45 + rnd() * 0.4));
  const back = zb + s * (0.025 + rnd() * 0.04), d = Math.abs(face - back), zc = (face + back) / 2;
  const body = packaging(kit, color), print = rnd() < 0.8 ? packaging(kit, label) : null;
  const band = rnd() < 0.4;
  for (let i = 0; i < n; i++) {
    const u = sub(kit, g, x + bw / 2 + i * (bw + gap), y, zc, { yaw: (rnd() - 0.5) * 0.03 });
    blk(kit, u, body, -bw / 2, bw / 2, 0, ph, -d / 2, d / 2);
    if (!print || bw < 0.045) continue;
    const zf = s * (d / 2), [lx, ly0, ly1] = band ? [0.5, 0.62, 0.8] : [0.36, 0.4, 0.74];
    blk(kit, u, print, -bw * lx, bw * lx, ph * ly0, ph * ly1, zf, zf + s * 0.0015, false, false);
  }
}

/** A run of round packs (bottles, cans or jars): one row deep, two on low shelves. */
function rounds(kit, g, m, rnd, kind, { x, run, y, clear, s, face, dep, deep, color, label }) {
  const T = (v) => Math.min(clear * 0.88, v);
  const spec = kind === 'bottle' ? { r: 0.026 + rnd() * 0.016, h: T(0.17 + rnd() * 0.13) }
    : kind === 'can' ? { r: 0.032, h: 0.118 }
      : { r: 0.034 + rnd() * 0.014, h: T(0.09 + rnd() * 0.06) };
  const { r, h } = spec, pitch = 2 * r + 0.005;
  const n = Math.max(1, Math.floor((run + 0.005) / pitch));
  const rows = deep && dep > 4 * r + 0.06 ? 2 : 1;
  const stack = kind === 'can' && clear > 2 * h + 0.04 ? 2 : 1;
  const body = kind === 'can' ? kit.material(color, { roughness: 0.3, metalness: 0.35 })
    : kit.material(color, { roughness: kind === 'jar' ? 0.12 : 0.24 });
  const print = packaging(kit, label), lid = kind === 'can' ? m.lid : kit.material(pick(rnd, LIDS), { roughness: 0.35 });
  const x0 = x + (run - n * pitch + 0.005) / 2 + r;
  for (let i = 0; i < n; i++) {
    const cx = x0 + i * pitch;
    for (let j = 0; j < rows; j++) {
      const cz = face - s * (r + 0.002 + j * pitch);
      if (j) {
        // Rows behind the front one are simple silhouettes in the product's color.
        if (kind === 'bottle') turned(kit, g, body, BOTTLE_BACK.map(([u, v]) => [u * r, v * h]), cx, y, cz, { segments: 6 });
        else kit.cyl(g, body, r, h * stack, cx, y, cz, { segments: 6, bevel: false });
        continue;
      }
      if (kind === 'bottle') {
        turned(kit, g, body, BOTTLE.map(([u, v]) => [u * r, v * h]), cx, y, cz, { segments: 8 });
        kit.cyl(g, lid, r * 0.44, h * 0.1, cx, y + h * 0.9, cz, { segments: 8, bevel: false });
        kit.cyl(g, print, r * 1.012, h * 0.3, cx, y + h * 0.2, cz, { segments: 8, bevel: false });
      } else if (kind === 'can') {
        for (let t = 0; t < stack; t++) {
          kit.cyl(g, body, r, h - 0.002, cx, y + t * h, cz, { segments: 8 });
          kit.cyl(g, lid, r * 0.86, 0.002, cx, y + (t + 1) * h - 0.002, cz, { segments: 8, bevel: false });
        }
      } else {
        turned(kit, g, body, JAR.map(([u, v]) => [u * r, v * h]), cx, y, cz, { segments: 8 });
        kit.cyl(g, lid, r * 0.92, h * 0.16, cx, y + h * 0.86, cz, { segments: 8 });
        kit.cyl(g, print, r * 1.012, h * 0.42, cx, y + h * 0.24, cz, { segments: 8, bevel: false });
      }
    }
  }
}

/**
 * One merchandised face of a shelving run. The face starts at the back panel (z = zb) and runs
 * outward in direction s (+1 toward +z, -1 toward -z) for `depth` meters.
 */
function shelfFace(kit, g, m, { w, zb, s, depth, levels, h, seed }) {
  const bays = bayCount(w);
  const bw = w / bays;
  const upper = Math.min(0.45, depth * 0.8);
  const rnd = seq(seed);
  const e = SHELF.post / 2;
  // Shelves, price tags and product facings of the whole face merge into one mesh per material.
  g.add(assembly(kit, null, (a) => {
    levels.forEach((y, li) => {
      const dep = li === 0 ? depth : upper;
      const next = li < levels.length - 1 ? levels[li + 1] - SHELF.t - 0.03 : h - 0.02;
      blk(kit, a, m.frame, -w / 2 + e, w / 2 - e, y - SHELF.t, y, zb + s * 0.004, zb + s * (dep - 0.012));
      blk(kit, a, m.channel, -w / 2 + e, w / 2 - e, y - SHELF.t - 0.012, y + 0.018, zb + s * (dep - 0.012), zb + s * dep);
      for (let b = 0; b < bays; b++) {
        const x0 = -w / 2 + b * bw + (b === 0 ? e : 0.003);
        const x1 = -w / 2 + (b + 1) * bw - (b === bays - 1 ? e : 0.003);
        stockShelf(kit, a, m, rnd, { x0, x1, y, clear: next - y, zb, s, dep: dep - 0.012 });
      }
    });
  }));
}

/** Posts at every bay line, z0..z1 deep, full height. */
function shelfPosts(kit, g, m, w, h, z0, z1) {
  const bays = bayCount(w);
  for (let i = 0; i <= bays; i++) {
    const x = clamp(-w / 2 + (i * w) / bays, -w / 2 + SHELF.post / 2, w / 2 - SHELF.post / 2);
    blk(kit, g, m.frame, x - SHELF.post / 2, x + SHELF.post / 2, 0, h, z0, z1);
  }
}

/** Kick plate and end covers below a base deck that reaches z = zFront. */
function shelfBase(kit, g, m, w, zb, zFront) {
  blk(kit, g, m.panel, -w / 2 + SHELF.post / 2, w / 2 - SHELF.post / 2, 0.008, SHELF.kick - 0.002, zFront - Math.sign(zFront - zb) * 0.016, zFront);
  for (const s of [-1, 1]) {
    blk(kit, g, m.panel, s * (w / 2 - 0.012), s * (w / 2), 0, SHELF.kick + SHELF.t, zb + Math.sign(zFront - zb) * 0.01, zFront);
  }
}

function buildGondola(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = shelfMats(kit, color);
  const spine = 0.022;
  const depth = d / 2 - spine - 0.004;
  const levels = shelfLevels(h, 0.28);
  blk(kit, g, m.panel, -w / 2 + SHELF.post / 2, w / 2 - SHELF.post / 2, SHELF.kick, h - 0.03, -spine + 0.006, spine - 0.006);
  blk(kit, g, m.frame, -w / 2, w / 2, h - 0.03, h, -spine, spine);
  shelfPosts(kit, g, m, w, h - 0.03, -spine - 0.008, spine + 0.008);
  for (const s of [-1, 1]) {
    shelfBase(kit, g, m, w, s * spine, s * (spine + depth));
    shelfFace(kit, g, m, { w, zb: s * spine, s, depth, levels, h, seed: s > 0 ? 11 : 29 });
  }
  return g;
}

function buildWallShelving(kit, { w, d, h, color }) {
  const g = kit.group();
  const m = shelfMats(kit, color);
  const z0 = -d / 2;
  const zb = z0 + 0.03;
  const depth = d - 0.034;
  const header = Math.min(0.16, h * 0.08);
  const levels = shelfLevels(h - header, 0.26);
  blk(kit, g, m.panel, -w / 2 + SHELF.post / 2, w / 2 - SHELF.post / 2, SHELF.kick, h - header, z0 + 0.004, zb - 0.008);
  shelfPosts(kit, g, m, w, h - header - 0.012, z0, zb);
  blk(kit, g, finish(kit, color, tint(kit, kit.mat.laminate, '#557876')), -w / 2, w / 2, h - header, h, z0, zb + 0.02);
  blk(kit, g, m.channel, -w / 2, w / 2, h - header - 0.012, h - header, z0, zb + 0.022);
  shelfBase(kit, g, m, w, zb, zb + depth);
  shelfFace(kit, g, m, { w, zb, s: 1, depth, levels, h: h - header, seed: 7 });
  return g;
}

function drawShelving(ctx, o, double) {
  const { w, d } = o;
  const bays = bayCount(w);
  outline(ctx, o);
  pen(ctx, o, FINE);
  const faces = double ? [[-0.022, -1], [0.022, 1]] : [[-d / 2 + 0.03, 1]];
  if (double) rect(ctx, -w / 2, -0.022, w / 2, 0.022, o.theme.light);
  else rect(ctx, -w / 2, -d / 2, w / 2, -d / 2 + 0.03, o.theme.light);
  for (let i = 1; i < bays; i++) line(ctx, -w / 2 + (i * w) / bays, -d / 2, -w / 2 + (i * w) / bays, d / 2);
  const depth = double ? d / 2 - 0.026 : d - 0.034;
  const upper = Math.min(0.45, depth * 0.8);
  for (const [yb, s] of faces) {
    line(ctx, -w / 2, yb + s * (depth - 0.012), w / 2, yb + s * (depth - 0.012));
    if (roomy(o)) {
      pen(ctx, o, FINE, o.theme.muted, DASH);
      line(ctx, -w / 2, yb + s * upper, w / 2, yb + s * upper);
      pen(ctx, o, FINE);
    }
  }
}

// ---- Checkout counter ---------------------------------------------------------------

const CHECKOUT = {
  top: 0.88, topT: 0.035, kick: 0.1,
  pos: [-0.25, -0.2], reader: [0.14, 0.24], printer: [-0.62, -0.26], impulse: [0.48, 0.8, 0.12, 0.4],
};

function buildCheckout(kit, { w, d, color }) {
  const g = kit.group();
  const C = CHECKOUT;
  const white = kit.mat.casework;
  const slat = finish(kit, color, kit.mat.oak);
  const reveal = kit.material('#2f3538', { roughness: 0.85 });
  const under = C.top - C.topT;
  const zf = d / 2 - 0.045;
  const x0 = -w / 2, x1 = w / 2, z0 = -d / 2;
  // Carcass: end panels, bottom, front backer, divider and drawer pedestal.
  for (const s of [-1, 1]) blk(kit, g, white, s * x1, s * (x1 - 0.025), 0, under, z0, zf);
  blk(kit, g, reveal, x0 + 0.025, x1 - 0.025, 0, C.kick, z0 + 0.04, zf - 0.05);
  blk(kit, g, white, x0 + 0.025, x1 - 0.025, C.kick, C.kick + 0.02, z0, zf);
  blk(kit, g, reveal, x0, x1, C.kick, under, zf, zf + 0.015);
  blk(kit, g, white, 0.24, 0.26, C.kick, under, z0, zf);
  blk(kit, g, white, x0 + 0.025, 0.24, 0.47, 0.49, z0 + 0.02, zf);
  blk(kit, g, white, 0.26, x1 - 0.025, C.kick + 0.02, under, z0 + 0.048, zf);
  // Customer face: vertical slats under a flush top.
  const n = Math.round((w - 0.04) / 0.075);
  const pitch = (w - 0.04) / n;
  for (let i = 0; i < n; i++) {
    const sx = x0 + 0.02 + i * pitch;
    blk(kit, g, slat, sx + 0.006, sx + pitch - 0.006, C.kick + 0.008, under - 0.008, zf + 0.015, d / 2 - 0.012);
  }
  blk(kit, g, slat, x0, x1, C.kick - 0.03, C.kick + 0.008, zf, d / 2 - 0.012);
  blk(kit, g, kit.mat.quartz, x0, x1, under, C.top, z0, d / 2);
  // Cashier side: three drawers on the pedestal and a cash drawer under the register.
  const fronts = [[C.kick + 0.025, 0.38], [0.385, 0.62], [0.625, under - 0.006]];
  for (const [y0, y1] of fronts) {
    blk(kit, g, white, 0.265, x1 - 0.03, y0, y1, z0 + 0.03, z0 + 0.048);
    barPull(kit, g, kit.mat.steel, 0.56, y1 - 0.045, z0 + 0.03, 0.2, { s: -1, reach: 0.022, r: 0.005 });
  }
  blk(kit, g, kit.mat.black, -0.5, 0.0, under - 0.13, under - 0.004, z0 + 0.012, z0 + 0.45);
  blk(kit, g, kit.mat.darkSteel, -0.32, -0.18, under - 0.08, under - 0.068, z0 + 0.002, z0 + 0.012);
  for (const [bx, bh] of [[-0.78, 0.05], [-0.45, 0.035]]) {
    blk(kit, g, kit.mat.cardboard, bx, bx + 0.3, C.kick + 0.02, C.kick + 0.02 + bh, z0 + 0.06, z0 + 0.4);
  }
  // Register: tablet on a swivel stand facing the cashier.
  const [px, pz] = C.pos;
  kit.cyl(g, kit.mat.darkSteel, 0.065, 0.012, px, C.top, pz, { segments: 24 });
  rod(kit, g, kit.mat.darkSteel, 0.014, [px, C.top + 0.01, pz], [px, C.top + 0.075, pz + 0.015]);
  const tab = sub(kit, g, px, C.top + 0.1, pz + 0.01, { pitch: 0.5 });
  cushion(kit, tab, kit.mat.black, -0.13, 0.13, -0.09, 0.09, -0.006, 0.006, { r: 0.006 });
  blk(kit, tab, kit.mat.screen, -0.118, 0.118, -0.078, 0.078, -0.008, -0.006, false);
  // Card reader on a small cradle facing the customer.
  const [rx, rz] = C.reader;
  blk(kit, g, kit.mat.black, rx - 0.05, rx + 0.05, C.top, C.top + 0.02, rz - 0.04, rz + 0.04);
  const rd = sub(kit, g, rx, C.top + 0.075, rz, { pitch: -0.55 });
  blk(kit, rd, kit.mat.black, -0.04, 0.04, -0.07, 0.07, -0.011, 0.011);
  blk(kit, rd, kit.mat.screen, -0.03, 0.03, 0.0, 0.055, 0.011, 0.013, false);
  blk(kit, rd, kit.mat.darkSteel, -0.03, 0.03, -0.058, -0.012, 0.011, 0.013, false);
  // Receipt printer.
  const [qx, qz] = C.printer;
  cushion(kit, g, kit.mat.black, qx - 0.07, qx + 0.07, C.top, C.top + 0.13, qz - 0.09, qz + 0.09, { r: 0.015, crown: 0.004 });
  blk(kit, g, kit.mat.white, qx - 0.04, qx + 0.04, C.top + 0.13, C.top + 0.134, qz - 0.088, qz - 0.06, false);
  // Two-tier impulse display on the customer side.
  const [ix0, ix1, iz0, iz1] = C.impulse;
  const izm = (iz0 + iz1) / 2;
  blk(kit, g, kit.mat.black, ix0, ix1, C.top, C.top + 0.025, iz0, iz1);
  blk(kit, g, kit.mat.black, ix0, ix1, C.top + 0.025, C.top + 0.09, iz0, izm);
  const rnd = seq(23);
  const iw = (ix1 - ix0 - 0.04) / 3;
  for (let i = 0; i < 3; i++) {
    const x = ix0 + 0.02 + i * iw;
    for (const [y, za, zb] of [[C.top + 0.09, iz0 + 0.02, izm - 0.02], [C.top + 0.025, izm + 0.02, iz1 - 0.02]]) {
      blk(kit, g, packaging(kit, pick(rnd, PRODUCTS)), x + 0.008, x + iw - 0.008, y, y + 0.05 + rnd() * 0.03, za, zb, true, 0.004);
    }
  }
  return g;
}

function drawCheckout(ctx, o) {
  const { w, d } = o;
  const C = CHECKOUT;
  outline(ctx, o);
  pen(ctx, o, FINE);
  line(ctx, -w / 2, d / 2 - 0.045, w / 2, d / 2 - 0.045);
  const [px, pz] = C.pos, [rx, rz] = C.reader, [qx, qz] = C.printer;
  circle(ctx, px, pz, 0.065, o.theme.fill);
  rect(ctx, px - 0.13, pz - 0.05, px + 0.13, pz + 0.03, o.theme.light);
  rect(ctx, rx - 0.05, rz - 0.06, rx + 0.05, rz + 0.06, o.theme.fill);
  rect(ctx, qx - 0.07, qz - 0.09, qx + 0.07, qz + 0.09, o.theme.fill);
  const [ix0, ix1, iz0, iz1] = C.impulse;
  rect(ctx, ix0, iz0, ix1, iz1, o.theme.fill);
  line(ctx, ix0, (iz0 + iz1) / 2, ix1, (iz0 + iz1) / 2);
}

// ---- Display table ------------------------------------------------------------------

const TABLE = { top: 0.68, topT: 0.04, leg: 0.045, inset: 0.03 };

function tableStacks(w, d) {
  const out = [];
  const cols = Math.max(1, Math.round((w - 0.2) / 0.47));
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({ x: -w / 2 + ((c + 0.5) * w) / cols, z: (r ? 1 : -1) * Math.min(0.21, d / 4), kind: r === 0 && c === cols - 1 ? 'box' : 'fold' });
    }
  }
  return out;
}

/** Stack of folded garments with the rounded fold toward the shopper (+z). */
function foldedStack(kit, g, rnd, x, y, z, count, color) {
  const mat = fabric(kit, color);
  const th = 0.03;
  g.add(assembly(kit, null, (a) => {
    for (let i = 0; i < count; i++) {
      const f = sub(kit, a, x + (rnd() - 0.5) * 0.014, y + th * i, z + (rnd() - 0.5) * 0.012, { yaw: (rnd() - 0.5) * 0.05 });
      cushion(kit, f, mat, -0.165, 0.165, 0.001, th - 0.001, -0.13, 0.13, { r: 0.012, crown: 0.003 });
    }
  }));
}

function buildDisplayTable(kit, { w, d, h, color }) {
  const g = kit.group();
  const T = TABLE;
  const frame = finish(kit, color, tint(kit, kit.mat.darkSteel, '#353b3e'));
  const under = T.top - T.topT;
  const lx = w / 2 - T.inset, lz = d / 2 - T.inset;
  blk(kit, g, kit.mat.oak, -w / 2, w / 2, under, T.top, -d / 2, d / 2);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) blk(kit, g, frame, sx * lx, sx * (lx - T.leg), 0, under, sz * lz, sz * (lz - T.leg));
  }
  for (const s of [-1, 1]) {
    blk(kit, g, frame, -lx + T.leg, lx - T.leg, under - 0.07, under, s * lz, s * (lz - 0.02));
    blk(kit, g, frame, s * lx, s * (lx - 0.02), under - 0.07, under, -lz + T.leg, lz - T.leg);
    blk(kit, g, frame, -lx + T.leg, lx - T.leg, 0.13, 0.16, s * (lz - 0.005), s * (lz - 0.035));
  }
  blk(kit, g, kit.mat.oak, -lx + T.leg, lx - T.leg, 0.16, 0.185, -lz + T.leg, lz - T.leg);
  // Merchandise: folded garments and gift boxes on top, baskets and denim below.
  const rnd = seq(5);
  const count = Math.max(1, Math.floor((h - T.top) / 0.03));
  for (const s of tableStacks(w, d)) {
    if (s.kind === 'box') {
      const wheat = packaging(kit, '#dbd99a'), white = packaging(kit, '#f2f0ea');
      blk(kit, g, white, s.x - 0.16, s.x + 0.16, T.top, T.top + 0.09, s.z - 0.12, s.z + 0.12);
      blk(kit, g, white, s.x - 0.165, s.x + 0.165, T.top + 0.07, T.top + 0.092, s.z - 0.125, s.z + 0.125);
      blk(kit, g, wheat, s.x - 0.1, s.x + 0.12, T.top + 0.092, T.top + Math.min(0.13, h - T.top), s.z - 0.08, s.z + 0.1);
    } else {
      foldedStack(kit, g, rnd, s.x, T.top, s.z, count - (rnd() < 0.4 ? 1 : 0), pick(rnd, GARMENTS));
    }
  }
  // Woven seagrass baskets: the weave texture in a straw tone, with a darker braided rim.
  const basket = tint(kit, kit.mat.fabricWheat, '#b59b70');
  const rim = shade(kit, basket, 0.78);
  const bw = Math.min(0.38, (2 * (lx - T.leg) - 0.1) / 3);
  const xs = [-(lx - T.leg) + 0.03 + bw / 2, 0, (lx - T.leg) - 0.03 - bw / 2];
  xs.forEach((x, i) => {
    if (i === 1) {
      foldedStack(kit, g, rnd, x, 0.185, 0, 4, '#2c4b63');
      return;
    }
    cushion(kit, g, basket, x - bw / 2, x + bw / 2, 0.185, 0.36, -0.15, 0.15, { r: 0.03 });
    cushion(kit, g, rim, x - bw / 2 - 0.004, x + bw / 2 + 0.004, 0.335, 0.365, -0.154, 0.154, { r: 0.014 });
  });
  return g;
}

function drawDisplayTable(ctx, o) {
  const { w, d } = o;
  outline(ctx, o);
  pen(ctx, o, FINE, o.theme.muted);
  for (const s of tableStacks(w, d)) {
    if (s.kind === 'box') rect(ctx, s.x - 0.16, s.z - 0.12, s.x + 0.16, s.z + 0.12, o.theme.fill);
    else rrect(ctx, s.x - 0.165, s.z - 0.13, s.x + 0.165, s.z + 0.13, 0.02, o.theme.fill);
  }
}

// ---- Clothing rack ------------------------------------------------------------------

const RACK = { ux: 0.03, rail: 0.07, half: 0.22 };

/** Garments along the rail: x, thickness, length and color, from a fixed seed. */
function garmentLayout(w) {
  const rnd = seq(17);
  const ux = w / 2 - RACK.ux;
  const x1 = ux - 0.08;
  const out = [];
  let x = -ux + 0.08;
  while (x <= x1) {
    const color = pick(rnd, GARMENTS);
    const long = rnd() < 0.35;
    const runs = 2 + Math.floor(rnd() * 3);
    for (let k = 0; k < runs && x <= x1; k++) {
      const t = long ? 0.05 + rnd() * 0.015 : 0.032 + rnd() * 0.012;
      out.push({ x, t, len: long ? 0.98 + rnd() * 0.1 : 0.64 + rnd() * 0.08, color, yaw: (rnd() - 0.5) * 0.12, half: RACK.half - rnd() * 0.02 });
      x += t + 0.018 + rnd() * 0.012;
    }
  }
  return out;
}

function caster(kit, g, x, z) {
  kit.cyl(g, kit.mat.rubber, 0.032, 0.022, x, 0.032, z, { axis: 'x', segments: 18 });
  blk(kit, g, kit.mat.darkSteel, x - 0.016, x + 0.016, 0.04, 0.062, z - 0.018, z + 0.018);
}

function buildClothingRack(kit, { w, d, h, color }) {
  const g = kit.group();
  const frame = finish(kit, color, tint(kit, kit.mat.darkSteel, '#2e3336'));
  const railY = h - RACK.rail;
  const ux = w / 2 - RACK.ux;
  for (const s of [-1, 1]) {
    const x = s * ux;
    blk(kit, g, frame, x - 0.016, x + 0.016, 0.085, railY + 0.035, -0.016, 0.016);
    blk(kit, g, frame, x - 0.02, x + 0.02, 0.062, 0.09, -d / 2 + 0.02, d / 2 - 0.02);
    for (const t of [-1, 1]) caster(kit, g, x, t * (d / 2 - 0.05));
  }
  blk(kit, g, frame, -ux + 0.02, ux - 0.02, 0.07, 0.088, -0.012, 0.012);
  kit.cyl(g, kit.mat.chrome, 0.013, 2 * ux, 0, railY, 0, { axis: 'x', segments: 16 });
  // Garments on wood hangers: sloped shoulders over a soft body, merged into a mesh per color.
  const hanger = kit.mat.oak;
  g.add(assembly(kit, `rack|${w}|${d}|${h}`, (a) => {
    for (const gm of garmentLayout(w)) {
      const f = sub(kit, a, gm.x, railY, 0, { yaw: gm.yaw });
      bent(kit, f, kit.mat.chrome, [[0, -0.045, 0], [0, -0.012, 0.012], [0, 0.014, 0], [0, -0.002, -0.014]], 0.0025, { segments: 8, radial: 5 });
      kit.block(f, hanger, -0.006, 0.006, -0.06, -0.045, -gm.half * 0.92, gm.half * 0.92, true, { bevel: 0.004 });
      const mat = fabric(kit, gm.color);
      const top = -0.055;
      for (const s of [-1, 1]) {
        const sh = sub(kit, f, 0, top - 0.035, s * gm.half * 0.45, { pitch: s * 0.32 });
        cushion(kit, sh, mat, -gm.t * 0.45, gm.t * 0.45, -0.025, 0.025, -gm.half * 0.475, gm.half * 0.475, { r: 0.012 });
      }
      // The body hangs in soft vertical folds that deepen toward the hem, which flares a little.
      const y0 = top - gm.len, y1 = top - 0.04, cy = (y0 + y1) / 2, ph = gm.x * 37;
      cushion(kit, f, mat, -gm.t / 2, gm.t / 2, y0, y1, -gm.half, gm.half, {
        r: Math.min(0.012, gm.t * 0.35), k: 1, mid: [1, 2, 6],
        warp: warpAt(`garment-${Math.round(ph * 10)}`, 0, cy, 0, (v) => {
          const down = clamp((y1 - v.y) / gm.len, 0, 1);
          v.x += gm.t * (0.18 + 0.32 * down) * Math.sin(v.z * 46 + ph);
          v.z *= 1 + 0.06 * down * down;
        }),
      });
    }
  }));
  return g;
}

function drawClothingRack(ctx, o) {
  const { w, d } = o;
  const ux = w / 2 - RACK.ux;
  pen(ctx, o, FINE, o.theme.light);
  rect(ctx, -w / 2, -d / 2, w / 2, d / 2);
  pen(ctx, o, FINE);
  for (const s of [-1, 1]) rect(ctx, s * ux - 0.02, -d / 2 + 0.02, s * ux + 0.02, d / 2 - 0.02, o.theme.fill);
  pen(ctx, o, OUT);
  rrect(ctx, -ux + 0.05, -RACK.half - 0.01, ux - 0.05, RACK.half + 0.01, 0.04, o.theme.fill);
  if (roomy(o)) {
    pen(ctx, o, FINE, o.theme.muted);
    for (const gm of garmentLayout(w)) line(ctx, gm.x, -gm.half, gm.x, gm.half);
  }
  pen(ctx, o, OUT);
  line(ctx, -ux, 0, ux, 0);
}

// ---- Mannequin ----------------------------------------------------------------------

/** Faceless form dressed in a simple top and trousers; opts.color sets the top. */
function buildMannequin(kit, { color }) {
  const g = kit.group();
  const form = kit.material('#e6e3dc', { roughness: 0.32 });
  const top = finish(kit, color, fabric(kit, '#86ada4'));
  const pants = fabric(kit, '#303d45');
  const shoe = tint(kit, kit.mat.vinylBlue, '#2c2f31');
  const base = 0.014;
  kit.cyl(g, kit.mat.darkSteel, 0.19, base, 0, 0, -0.005, { segments: 32 });
  rod(kit, g, kit.mat.chrome, 0.009, [-0.075, base, -0.06], [-0.075, 0.36, -0.045]);
  const y = (v) => base + v;
  for (const s of [-1, 1]) {
    ellipsoid(kit, g, shoe, s * 0.075, y(0.03), 0.04, 0.04, 0.032, 0.1);
    rod(kit, g, pants, 0.036, [s * 0.075, y(0.05), 0], [s * 0.08, y(0.48), 0.008], { rTop: 0.05, segments: 16 });
    rod(kit, g, pants, 0.05, [s * 0.08, y(0.46), 0.008], [s * 0.09, y(0.88), 0], { rTop: 0.072, segments: 16 });
    kit.sphere(g, top, 0.044, s * 0.162, y(1.39), -0.005);
    rod(kit, g, top, 0.042, [s * 0.167, y(1.39), -0.005], [s * 0.183, y(1.25), -0.002], { rTop: 0.04, segments: 14 });
    rod(kit, g, form, 0.034, [s * 0.183, y(1.26), -0.002], [s * 0.195, y(1.12), 0], { rTop: 0.03, segments: 14 });
    rod(kit, g, form, 0.03, [s * 0.195, y(1.13), 0], [s * 0.205, y(0.9), 0.045], { rTop: 0.023, segments: 14 });
    ellipsoid(kit, g, form, s * 0.207, y(0.84), 0.052, 0.019, 0.06, 0.034, 14);
  }
  // Torso: a flattened lathe profile from hips to shoulders, capped top and bottom.
  const flat = 0.64;
  const profile = [[0.86, 0.15], [0.95, 0.165], [1.04, 0.142], [1.12, 0.126], [1.21, 0.146], [1.3, 0.165], [1.38, 0.17]];
  // One smooth lathe per garment, split at the waistband so the shirt laps over the trousers.
  const lower = profile.filter(([py]) => py <= 1.04).map(([py, r]) => [r, py - 0.86]);
  const upper = profile.filter(([py]) => py >= 0.95).map(([py, r]) => [r + (py < 1.06 ? 0.004 : 0), py - 0.95]);
  turned(kit, g, pants, lower, 0, y(0.86), 0, { segments: 32 }).scale.z = flat;
  turned(kit, g, top, upper, 0, y(0.95), 0, { segments: 32 }).scale.z = flat;
  ellipsoid(kit, g, pants, 0, y(0.86), 0, 0.15, 0.07, 0.15 * flat, 24);
  ellipsoid(kit, g, top, 0, y(1.38), 0, 0.17, 0.065, 0.17 * flat, 24);
  rod(kit, g, form, 0.046, [0, y(1.4), 0], [0, y(1.58), 0.012], { rTop: 0.04, segments: 16 });
  ellipsoid(kit, g, form, 0, y(1.68), 0.014, 0.083, 0.113, 0.097, 24);
  return g;
}

function drawMannequin(ctx, o) {
  pen(ctx, o, FINE, o.theme.light);
  circle(ctx, 0, 0.005, 0.19);
  pen(ctx, o, FINE);
  for (const s of [-1, 1]) {
    ellipse(ctx, s * 0.075, 0.1, 0.04, 0.07, o.theme.fill);
    ellipse(ctx, s * 0.205, 0.03, 0.03, 0.05, o.theme.fill);
  }
  pen(ctx, o, OUT);
  ellipse(ctx, 0, 0, 0.19, 0.095, o.theme.fill);
  pen(ctx, o, FINE);
  ellipse(ctx, 0, 0.012, 0.085, 0.098, o.theme.light);
}

// ---- Pallets ------------------------------------------------------------------------

/** Block pallet with a carton load; one mesh per board group to suit long rack rows. */
function rackLoad(kit, g, rnd, { cx, y0, pw, pd, loadH, wrap }) {
  const wood = kit.mat.pallet;
  const dark = shade(kit, wood, 0.8);
  blk(kit, g, dark, cx - pw / 2, cx + pw / 2, y0, y0 + 0.02, -pd / 2, pd / 2);
  for (const t of [-1, 0, 1]) {
    const x = cx + t * (pw / 2 - 0.06);
    blk(kit, g, dark, x - 0.05, x + 0.05, y0 + 0.02, y0 + 0.12, -pd / 2, pd / 2);
  }
  blk(kit, g, wood, cx - pw / 2, cx + pw / 2, y0 + 0.12, y0 + 0.14, -pd / 2, pd / 2);
  const layers = clamp(Math.round(loadH / 0.38), 1, 3);
  const cols = pw > 0.9 ? 3 : 2;
  const lh = loadH / layers;
  const lw = pw - 0.04, ld = pd - 0.04;
  const cw = lw / cols;
  for (let l = 0; l < layers; l++) {
    const yb = y0 + 0.14 + l * lh;
    for (let i = 0; i < cols; i++) {
      const x0 = cx - lw / 2 + i * cw + 0.003, jz = (rnd() - 0.5) * 0.012;
      blk(kit, g, carton(kit, pick(rnd, KRAFT)), x0, x0 + cw - 0.006, yb, yb + lh - 0.005, -ld / 2 + jz, ld / 2 + jz, true, 0.004);
    }
  }
  if (wrap) {
    const e = 0.006;
    blk(kit, g, stretchWrap(kit), cx - lw / 2 - e, cx + lw / 2 + e, y0 + 0.13, y0 + 0.11 + loadH, -ld / 2 - e, ld / 2 + e, false);
  }
}

const stretchWrap = (kit) => kit.material('#eef4f4', { roughness: 0.15, transparent: true, opacity: 0.3, depthWrite: false });
/** Corrugated board in a kraft tone. */
const carton = (kit, hex) => tint(kit, kit.mat.cardboard, hex);

function buildPallet(kit, { w, d, h, color }) {
  const g = kit.group();
  const wood = kit.mat.pallet;
  const dark = shade(kit, wood, 0.84);
  const bt = 0.02, st = 0.1;
  // Bottom boards, notched stringers along x, top deck boards along z.
  for (const t of [-1, 0, 1]) {
    const x = t * (w / 2 - 0.07);
    blk(kit, g, dark, x - 0.07, x + 0.07, 0, bt, -d / 2, d / 2);
  }
  for (const t of [-1, 0, 1]) {
    const z = t * (d / 2 - 0.02);
    blk(kit, g, wood, -w / 2, w / 2, bt + 0.04, bt + st, z - 0.019, z + 0.019);
    for (const u of [-1, 0, 1]) {
      const x = u * (w / 2 - 0.1);
      blk(kit, g, wood, x - 0.1, x + 0.1, bt, bt + 0.04, z - 0.019, z + 0.019);
    }
  }
  const boards = 7;
  const bw = 0.14, gap = (w - boards * bw) / (boards - 1);
  for (let i = 0; i < boards; i++) {
    const x = -w / 2 + i * (bw + gap);
    blk(kit, g, i % 3 === 1 ? dark : wood, x, x + bw, bt + st, bt + st + bt, -d / 2, d / 2);
  }
  // Cartons: four layers of six with labels and tape, then stretch wrap.
  const rnd = seq(3);
  const y0 = 2 * bt + st;
  const lw = w - 0.03, ld = d - 0.03;
  const cols = 3, rows = 2, layers = 4;
  const lh = (h - y0 - 0.005) / layers;
  const cw = lw / cols, cd = ld / rows;
  const tones = isColor(color) ? [1, 0.92, 1.06].map((f) => `#${new kit.THREE.Color(color).multiplyScalar(f).getHexString()}`) : KRAFT;
  const tape = kit.material('#c9ad80', { roughness: 0.3 });
  const label = kit.material('#efeee9', { roughness: 0.6 });
  g.add(assembly(kit, null, (a) => {
    for (let l = 0; l < layers; l++) {
      const yb = y0 + l * lh;
      for (let i = 0; i < cols; i++) {
        for (let k = 0; k < rows; k++) {
          const jx = (rnd() - 0.5) * 0.008, jz = (rnd() - 0.5) * 0.008;
          const xa = -lw / 2 + i * cw + 0.003 + jx, xb = xa + cw - 0.006;
          const za = -ld / 2 + k * cd + 0.003 + jz, zb = za + cd - 0.006;
          blk(kit, a, carton(kit, pick(rnd, tones)), xa, xb, yb, yb + lh - 0.004, za, zb, true, 0.004);
          const cx = (xa + xb) / 2;
          if (k === rows - 1 && rnd() < 0.7) blk(kit, a, label, cx - 0.07, cx + 0.04, yb + lh * 0.4, yb + lh * 0.68, zb, zb + 0.002, false, false);
          if (l === layers - 1) blk(kit, a, tape, xa, xb, yb + lh - 0.004, yb + lh - 0.002, (za + zb) / 2 - 0.024, (za + zb) / 2 + 0.024, false, false);
        }
      }
    }
  }));
  const wrap = stretchWrap(kit);
  blk(kit, g, wrap, -lw / 2 - 0.008, lw / 2 + 0.008, y0 - 0.01, h - 0.06, -ld / 2 - 0.008, ld / 2 + 0.008, false);
  return g;
}

function drawPallet(ctx, o) {
  const { w, d } = o;
  outline(ctx, o);
  const lw = w - 0.03, ld = d - 0.03;
  pen(ctx, o, FINE);
  rect(ctx, -lw / 2, -ld / 2, lw / 2, ld / 2, o.theme.fill);
  for (const t of [-1, 1]) line(ctx, (t * lw) / 6, -ld / 2, (t * lw) / 6, ld / 2);
  line(ctx, -lw / 2, 0, lw / 2, 0);
  if (roomy(o)) {
    pen(ctx, o, FINE, o.theme.light);
    for (const t of [-1, 1]) line(ctx, -lw / 2, (t * ld) / 4, lw / 2, (t * ld) / 4);
  }
}

// ---- Pallet racking -----------------------------------------------------------------

const RACKING = { post: 0.076, beamH: 0.11, beamD: 0.05, bay: 2.74, pallet: [1.22, 1.02] };

function rackLayout(w, d, h) {
  const R = RACKING;
  const bays = repeats(Math.round(w / R.bay));
  const bw = w / bays;
  const levels = clamp(Math.round(h / 1.6), 1, 8);
  const pitch = h / (levels + 1);
  const clear = bw - R.post;
  const per = clamp(Math.floor((clear - 0.05) / (R.pallet[0] + 0.05)), 1, 3);
  const pw = Math.min(R.pallet[0], (clear - 0.06 * (per + 1)) / per);
  const pd = Math.min(R.pallet[1], d - 0.02);
  const frames = [];
  for (let i = 0; i <= bays; i++) frames.push(clamp(-w / 2 + i * bw, -w / 2 + R.post / 2, w / 2 - R.post / 2));
  return { bays, bw, levels, pitch, per, pw, pd, frames };
}

function rackFrame(kit, g, mat, guard, { x, w, d, h }) {
  const hw = w / 2;
  const R = RACKING;
  const p = R.post;
  const inner = d / 2 - p;
  for (const s of [-1, 1]) {
    blk(kit, g, mat, x - p / 2, x + p / 2, 0, h, s * (d / 2 - 0.006), s * inner);
    blk(kit, g, kit.mat.darkSteel, Math.max(-hw, x - 0.07), Math.min(hw, x + 0.07), 0, 0.01, s * (d / 2 - 0.008), s * (inner - 0.03));
  }
  blk(kit, g, guard, Math.max(-hw, x - p / 2 - 0.008), Math.min(hw, x + p / 2 + 0.008), 0, 0.4, d / 2 - p - 0.012, d / 2);
  const span = 2 * inner;
  const bottom = 0.15, top = h - 0.12;
  const n = repeats(Math.round((top - bottom) / 0.75), 2);
  const step = (top - bottom) / n;
  for (const y of [bottom, top]) blk(kit, g, mat, x - 0.016, x + 0.016, y - 0.02, y + 0.02, -inner, inner);
  for (let k = 0; k < n; k++) {
    const dz = (k % 2 ? -1 : 1) * span, dy = step;
    const len = Math.hypot(dz, dy);
    box(kit, g, mat, x, bottom + (k + 0.5) * step, 0, 0.03, 0.03, len, Math.atan2(-dy, dz));
  }
}

function buildPalletRacking(kit, { w, d, h, color }) {
  const g = kit.group();
  const R = RACKING;
  const L = rackLayout(w, d, h);
  const blue = finish(kit, color, kit.mat.rackBlue);
  const orange = kit.mat.safetyOrange;
  for (const x of L.frames) rackFrame(kit, g, blue, kit.mat.safetyYellow, { x, w, d, h });
  const rnd = seq(41);
  for (let b = 0; b < L.bays; b++) {
    const xa = L.frames[b] + R.post / 2, xb = L.frames[b + 1] - R.post / 2;
    for (let l = 1; l <= L.levels; l++) {
      const y = l * L.pitch;
      for (const s of [-1, 1]) blk(kit, g, orange, xa, xb, y - R.beamH, y, s * (d / 2 - 0.008), s * (d / 2 - 0.008 - R.beamD));
    }
    const gap = (xb - xa - L.per * L.pw) / (L.per + 1);
    for (let l = 0; l <= L.levels; l++) {
      const y0 = l * L.pitch + 0.001;
      const room = (l < L.levels ? (l + 1) * L.pitch - R.beamH : h) - y0 - 0.14 - 0.1;
      g.add(assembly(kit, null, (a) => {
        for (let k = 0; k < L.per; k++) {
          if (rnd() < 0.12) continue;
          const loadH = Math.max(0.2, Math.min(1.05, room) * (0.72 + rnd() * 0.28));
          const cx = xa + gap + L.pw / 2 + k * (L.pw + gap);
          rackLoad(kit, a, rnd, { cx, y0, pw: L.pw, pd: L.pd, loadH, wrap: rnd() < 0.55 });
        }
      }));
    }
  }
  return g;
}

function drawPalletRacking(ctx, o) {
  const { w, d, h } = o;
  const R = RACKING;
  const L = rackLayout(w, d, h);
  outline(ctx, o);
  pen(ctx, o, FINE, o.theme.light);
  for (let b = 0; b < L.bays; b++) {
    const xa = L.frames[b] + R.post / 2, xb = L.frames[b + 1] - R.post / 2;
    const gap = (xb - xa - L.per * L.pw) / (L.per + 1);
    for (let k = 0; k < L.per; k++) {
      const x0 = xa + gap + k * (L.pw + gap);
      rect(ctx, x0, -L.pd / 2, x0 + L.pw, L.pd / 2);
      line(ctx, x0, -L.pd / 2, x0 + L.pw, L.pd / 2);
      line(ctx, x0 + L.pw, -L.pd / 2, x0, L.pd / 2);
    }
  }
  pen(ctx, o, FINE);
  for (const s of [-1, 1]) {
    rect(ctx, -w / 2, s * (d / 2 - 0.008), w / 2, s * (d / 2 - 0.008 - R.beamD), o.theme.fill);
  }
  const inner = d / 2 - R.post;
  for (const x of L.frames) {
    line(ctx, x, -inner, x, inner);
    for (const s of [-1, 1]) rect(ctx, x - R.post / 2, s * (d / 2), x + R.post / 2, s * inner, o.theme.line);
  }
}

// ---- Forklift -----------------------------------------------------------------------

const LIFT = { forkX: 0.27, forkW: 0.1, forkZ: [0.5, 1.21], mastZ: [0.36, 0.46], guardZ: [-0.75, 0.3] };

function wheel(kit, g, tire, hub, x, r, width, z) {
  kit.cyl(g, tire, r, width, x, r, z, { axis: 'x', segments: 28 });
  kit.cyl(g, hub, r * 0.55, width + 0.012, x, r, z, { axis: 'x', segments: 20 });
}

function buildForklift(kit, { color }) {
  const g = kit.group();
  const L = LIFT;
  const body = finish(kit, color, kit.mat.safetyYellow);
  const black = tint(kit, kit.mat.darkSteel, '#25292b');
  const steel = kit.mat.darkSteel;
  const hub = tint(kit, kit.mat.steel, '#c4c7c6');
  const seat = tint(kit, kit.mat.vinylBlue, '#2a2d2f');
  for (const s of [-1, 1]) {
    wheel(kit, g, kit.mat.rubber, hub, s * 0.5, 0.25, 0.2, 0.12);
    wheel(kit, g, kit.mat.rubber, hub, s * 0.45, 0.2, 0.15, -0.85);
  }
  // Chassis, side skirts, rounded counterweight with a rear bumper.
  blk(kit, g, body, -0.37, 0.37, 0.14, 0.6, -1.0, 0.34);
  for (const s of [-1, 1]) {
    blk(kit, g, body, s * 0.37, s * 0.5, 0.16, 0.6, -0.62, -0.16);
    blk(kit, g, black, s * 0.38, s * 0.6, 0.53, 0.57, -0.17, 0.4);
    blk(kit, g, black, s * 0.5, s * 0.52, 0.16, 0.5, -0.6, -0.18);
  }
  const cw = kit.cyl(g, body, 1, 0.58, 0, 0.42, -0.92, { segments: 36 });
  cw.scale.set(0.56, 1, 0.3);
  const bumper = kit.cyl(g, black, 1, 0.18, 0, 0.24, -0.92, { segments: 36 });
  bumper.scale.set(0.5, 1, 0.295);
  for (const s of [-1, 1]) blk(kit, g, glow(kit, '#d6453d', 0.6), s * 0.2, s * 0.32, 0.86, 0.9, -1.2, -1.17);
  // Hood with seat, operator deck and dash.
  blk(kit, g, body, -0.45, 0.45, 0.6, 0.9, -0.7, -0.1);
  blk(kit, g, black, -0.44, 0.44, 0.9, 0.915, -0.69, -0.11);
  blk(kit, g, black, -0.42, 0.42, 0.58, 0.61, -0.1, 0.24);
  blk(kit, g, body, -0.36, 0.36, 0.6, 1.0, 0.22, 0.34);
  blk(kit, g, black, -0.37, 0.37, 1.0, 1.04, 0.2, 0.35);
  blk(kit, g, black, -0.2, 0.2, 0.915, 0.95, -0.5, -0.18);
  cushion(kit, g, seat, -0.23, 0.23, 0.95, 1.025, -0.52, -0.12, { r: 0.03, crown: 0.012 });
  const back = sub(kit, g, 0, 1.0, -0.56, { pitch: -0.12 });
  cushion(kit, back, seat, -0.22, 0.22, 0, 0.4, -0.04, 0.04, { r: 0.035, crown: 0.012, axis: 'z' });
  // Steering and hydraulic levers.
  rod(kit, g, black, 0.022, [-0.05, 1.02, 0.25], [-0.05, 1.16, 0.1]);
  const sw = kit.torus(g, kit.mat.black, 0.14, 0.016, -0.05, 1.17, 0.09, { axis: 'y' });
  sw.rotation.x = Math.PI / 2 - 0.55;
  for (let i = 0; i < 3; i++) {
    const x = 0.17 + i * 0.05;
    rod(kit, g, steel, 0.007, [x, 1.03, 0.26], [x, 1.2, 0.2], { segments: 6 });
    kit.sphere(g, black, 0.018, x, 1.205, 0.198, { segments: 10 });
  }
  // Mast: outer and inner channels, ties, lift cylinder and chains.
  const [mz0, mz1] = L.mastZ;
  for (const s of [-1, 1]) {
    blk(kit, g, black, s * 0.3, s * 0.37, 0.08, 2.0, mz0, mz1);
    blk(kit, g, steel, s * 0.235, s * 0.29, 0.12, 1.96, mz0 + 0.02, mz1);
    blk(kit, g, steel, s * 0.12, s * 0.14, 0.5, 1.7, mz1 - 0.012, mz1 - 0.002);
    rod(kit, g, steel, 0.018, [s * 0.36, 0.52, 0.3], [s * 0.34, 0.95, mz0], { segments: 8 });
  }
  blk(kit, g, black, -0.37, 0.37, 1.94, 2.0, mz0, mz1);
  blk(kit, g, black, -0.37, 0.37, 1.05, 1.11, mz0, mz0 + 0.05);
  kit.cyl(g, black, 0.045, 0.8, 0, 0.15, mz0 + 0.035, { segments: 16 });
  kit.cyl(g, kit.mat.chrome, 0.03, 0.75, 0, 0.95, mz0 + 0.035, { segments: 16 });
  // Carriage, load backrest and forks.
  const cz0 = mz1, cz1 = mz1 + 0.04;
  for (const [y0, y1] of [[0.12, 0.2], [0.48, 0.56]]) blk(kit, g, black, -0.5, 0.5, y0, y1, cz0, cz1);
  for (const s of [-1, 1]) blk(kit, g, black, s * 0.47, s * 0.5, 0.56, 1.25, cz0, cz1);
  blk(kit, g, black, -0.5, 0.5, 1.21, 1.25, cz0, cz1);
  for (let i = -2; i <= 2; i++) blk(kit, g, black, i * 0.15 - 0.012, i * 0.15 + 0.012, 0.56, 1.21, cz0 + 0.01, cz0 + 0.03);
  const [fz0, fz1] = L.forkZ;
  for (const s of [-1, 1]) {
    const x = s * L.forkX;
    blk(kit, g, steel, x - L.forkW / 2, x + L.forkW / 2, 0.04, 0.58, cz1, cz1 + 0.045);
    blk(kit, g, steel, x - L.forkW / 2, x + L.forkW / 2, 0.035, 0.08, fz0, fz1 - 0.08);
    blk(kit, g, steel, x - L.forkW / 2, x + L.forkW / 2, 0.035, 0.06, fz1 - 0.08, fz1);
  }
  // Overhead guard.
  const [gz0, gz1] = L.guardZ;
  const top = 2.04;
  for (const s of [-1, 1]) {
    blk(kit, g, black, s * 0.42, s * 0.47, 1.0, top, gz0, gz0 + 0.05);
    rod(kit, g, black, 0.024, [s * 0.4, 1.04, 0.27], [s * 0.42, top, gz1 - 0.02], { segments: 10 });
    blk(kit, g, black, s * 0.41, s * 0.48, top - 0.06, top, gz0, gz1);
    blk(kit, g, glow(kit, '#fffaf0', 1.2), s * 0.37, s * 0.43, 1.62, 1.68, 0.29, 0.31);
  }
  for (const z of [gz0 + 0.03, gz1 - 0.03]) blk(kit, g, black, -0.48, 0.48, top - 0.06, top, z - 0.03, z + 0.03);
  for (let i = 1; i < 6; i++) {
    const z = gz0 + ((gz1 - gz0) * i) / 6;
    blk(kit, g, black, -0.41, 0.41, top - 0.035, top - 0.01, z - 0.02, z + 0.02);
  }
  kit.cyl(g, black, 0.04, 0.02, 0, top, gz0 + 0.1, { segments: 16 });
  kit.cyl(g, glow(kit, '#f29a1c', 0.9), 0.032, 0.065, 0, top + 0.02, gz0 + 0.1, { segments: 16 });
  return g;
}

function drawForklift(ctx, o) {
  const L = LIFT;
  pen(ctx, o, FINE);
  for (const s of [-1, 1]) {
    rect(ctx, s * 0.4, -0.13, s * 0.6, 0.37, o.theme.line);
    rect(ctx, s * 0.375, -1.05, s * 0.525, -0.65, o.theme.line);
  }
  pen(ctx, o, OUT);
  ctx.beginPath();
  ctx.moveTo(-0.47, 0.34);
  ctx.lineTo(0.47, 0.34);
  ctx.ellipse(0, -0.92, 0.56, 0.3, 0, 0.575, Math.PI - 0.575, true);
  ctx.closePath();
  paint(ctx, o.theme.fill);
  pen(ctx, o, FINE);
  const [mz0, mz1] = L.mastZ;
  rect(ctx, -0.37, mz0, 0.37, mz1, o.theme.light);
  rect(ctx, -0.5, mz1, 0.5, mz1 + 0.04, o.theme.fill);
  const [fz0, fz1] = L.forkZ;
  for (const s of [-1, 1]) rect(ctx, s * L.forkX - L.forkW / 2, fz0, s * L.forkX + L.forkW / 2, fz1, o.theme.fill);
  rrect(ctx, -0.23, -0.6, 0.23, -0.12, 0.05, o.theme.fill);
  if (roomy(o)) {
    line(ctx, -0.21, -0.52, 0.21, -0.52);
    circle(ctx, -0.05, 0.1, 0.14);
  }
  const [gz0, gz1] = L.guardZ;
  pen(ctx, o, FINE, o.theme.muted, DASH);
  rect(ctx, -0.48, gz0, 0.48, gz1);
}

// ---- Workbench ----------------------------------------------------------------------

const BENCH = { top: 0.9, topT: 0.045, leg: 0.05, peg: 0.02 };

function buildWorkbench(kit, { w, d, h, color }) {
  const g = kit.group();
  const B = BENCH;
  const frame = finish(kit, color, tint(kit, kit.mat.darkSteel, '#46514f'));
  const under = B.top - B.topT;
  const lx = w / 2 - 0.03, zf = d / 2 - 0.03, zb = -d / 2 + B.peg + 0.004;
  for (const sx of [-1, 1]) {
    blk(kit, g, frame, sx * lx, sx * (lx - B.leg), 0.012, under, zf, zf - B.leg);
    blk(kit, g, frame, sx * lx, sx * (lx - B.leg), 0.012, h - 0.045, zb, zb + B.leg);
    for (const z of [zf - B.leg / 2, zb + B.leg / 2]) kit.cyl(g, kit.mat.rubber, 0.03, 0.012, sx * (lx - B.leg / 2), 0, z, { segments: 14 });
    blk(kit, g, frame, sx * (lx - 0.005), sx * (lx - B.leg + 0.005), under - 0.08, under, zb + B.leg, zf - B.leg);
    blk(kit, g, frame, sx * (lx - 0.005), sx * (lx - B.leg + 0.005), 0.12, 0.17, zb + B.leg, zf - B.leg);
  }
  for (const [xa, xb] of [[-lx + B.leg, 0.04], [0.66, lx - B.leg]]) blk(kit, g, frame, xa, xb, under - 0.08, under, zf - 0.005, zf - 0.025);
  blk(kit, g, frame, -lx + B.leg, lx - B.leg, under - 0.08, under, zb + 0.005, zb + 0.025);
  blk(kit, g, frame, -lx + B.leg, lx - B.leg, 0.15, 0.17, zb + 0.01, zf - 0.01);
  blk(kit, g, frame, -lx + B.leg, lx - B.leg, 0.17, 0.2, zf - 0.02, zf - 0.01);
  // Butcher block top: glued flush, so one slab whose grain runs along the bench.
  const z0 = -d / 2 + B.peg + 0.006;
  blk(kit, g, kit.mat.oak, -w / 2, w / 2, under, B.top, z0, d / 2, true, 0.006);
  // Drawer set into the front apron.
  blk(kit, g, shade(kit, frame, 0.8), 0.04, 0.66, under - 0.15, under, -0.2, zf - 0.025);
  blk(kit, g, frame, 0.045, 0.655, under - 0.145, under - 0.005, zf - 0.025, zf - 0.006);
  blk(kit, g, kit.mat.chrome, 0.27, 0.43, under - 0.085, under - 0.07, zf - 0.006, zf + 0.008);
  // Pegboard with a top shelf, task light and tools.
  const peg = painted(kit, '#d6d8d4', 0.6);
  blk(kit, g, peg, -lx + B.leg, lx - B.leg, B.top, h - 0.05, -d / 2 + 0.002, -d / 2 + B.peg);
  blk(kit, g, frame, -lx, lx, h - 0.045, h - 0.02, -d / 2, -d / 2 + 0.2);
  blk(kit, g, frame, -lx, lx, h - 0.065, h - 0.02, -d / 2 + 0.2, -d / 2 + 0.22);
  blk(kit, g, kit.mat.led, -lx + 0.1, lx - 0.1, h - 0.052, h - 0.045, -d / 2 + 0.12, -d / 2 + 0.16, false);
  pegTools(kit, g, -d / 2 + B.peg, B.top, h - 0.05, w);
  // Bench vise at the front right corner.
  const vise = kit.mat.vinylBlue;
  const vx = w / 2 - 0.2;
  blk(kit, g, vise, vx - 0.08, vx + 0.08, B.top, B.top + 0.05, zf - 0.2, zf - 0.04);
  blk(kit, g, vise, vx - 0.06, vx + 0.06, B.top + 0.05, B.top + 0.14, zf - 0.17, zf - 0.11);
  blk(kit, g, vise, vx - 0.06, vx + 0.06, B.top + 0.05, B.top + 0.14, zf - 0.08, zf - 0.02);
  blk(kit, g, kit.mat.darkSteel, vx - 0.06, vx + 0.06, B.top + 0.12, B.top + 0.14, zf - 0.11, zf - 0.08);
  kit.cyl(g, kit.mat.chrome, 0.012, 0.05, vx, B.top + 0.08, zf + 0.0, { axis: 'z', segments: 14 });
  kit.cyl(g, kit.mat.chrome, 0.007, 0.16, vx, B.top + 0.08, d / 2 - 0.012, { axis: 'x', segments: 10 });
  for (const s of [-1, 1]) kit.sphere(g, kit.mat.black, 0.012, vx + s * 0.08, B.top + 0.08, d / 2 - 0.012, { segments: 10 });
  return g;
}

/** Hand tools hanging on the pegboard face at z. */
function pegTools(kit, g, z, y0, y1, w) {
  const steel = kit.mat.steel, dark = kit.mat.darkSteel, wood = kit.mat.oak;
  const orange = kit.mat.safetyOrange, black = kit.mat.black;
  const mid = (y0 + y1) / 2;
  const s = Math.min(1, w / 1.83);
  // Hammer.
  let x = -0.62 * s;
  blk(kit, g, wood, x - 0.014, x + 0.014, mid - 0.2, mid + 0.08, z, z + 0.025);
  blk(kit, g, dark, x - 0.06, x + 0.05, mid + 0.08, mid + 0.115, z, z + 0.03);
  // Screwdrivers.
  for (let i = 0; i < 4; i++) {
    x = -0.42 * s + i * 0.055;
    kit.cyl(g, i % 2 ? black : orange, 0.014, 0.09, x, mid + 0.02, z + 0.02, { segments: 10 });
    kit.cyl(g, steel, 0.004, 0.13 - i * 0.015, x, mid + 0.02 - 0.13 + i * 0.015, z + 0.02, { segments: 6 });
  }
  // Wrenches from small to large.
  for (let i = 0; i < 5; i++) {
    x = -0.1 * s + i * 0.05;
    const len = 0.14 + i * 0.025;
    blk(kit, g, steel, x - 0.007, x + 0.007, mid + 0.12 - len, mid + 0.12, z, z + 0.008);
    blk(kit, g, steel, x - 0.016, x + 0.016, mid + 0.1, mid + 0.135, z, z + 0.008);
  }
  // Hand saw.
  x = 0.32 * s;
  box(kit, g, steel, x + 0.08, mid - 0.04, z + 0.004, 0.34, 0.1, 0.004, 0, 0, -0.08);
  blk(kit, g, orange, x - 0.13, x - 0.03, mid - 0.06, mid + 0.06, z, z + 0.025);
  // Tape measure and pliers.
  x = 0.66 * s;
  blk(kit, g, kit.mat.safetyYellow, x - 0.04, x + 0.04, mid + 0.06, mid + 0.14, z, z + 0.04);
  box(kit, g, orange, x - 0.012, mid - 0.1, z + 0.012, 0.016, 0.12, 0.016, 0, 0, 0.12);
  box(kit, g, orange, x + 0.012, mid - 0.1, z + 0.012, 0.016, 0.12, 0.016, 0, 0, -0.12);
  blk(kit, g, dark, x - 0.016, x + 0.016, mid - 0.04, mid + 0.01, z, z + 0.02);
}

function drawWorkbench(ctx, o) {
  const { w, d } = o;
  const B = BENCH;
  outline(ctx, o);
  pen(ctx, o, FINE);
  rect(ctx, -w / 2, -d / 2, w / 2, -d / 2 + B.peg, o.theme.light);
  if (roomy(o)) {
    pen(ctx, o, FINE, o.theme.light);
    const z0 = -d / 2 + B.peg + 0.006;
    for (let i = 1; i < 9; i++) {
      const y = z0 + ((d / 2 - z0) * i) / 9;
      line(ctx, -w / 2, y, w / 2, y);
    }
    pen(ctx, o, FINE, o.theme.muted, DASH);
    line(ctx, -w / 2 + 0.03, -d / 2 + 0.22, w / 2 - 0.03, -d / 2 + 0.22);
  }
  const zf = d / 2 - 0.03, vx = w / 2 - 0.2;
  pen(ctx, o, FINE);
  rect(ctx, vx - 0.08, zf - 0.2, vx + 0.08, zf - 0.04, o.theme.fill);
  line(ctx, vx, zf - 0.04, vx, d / 2);
  line(ctx, vx - 0.08, d / 2 - 0.012, vx + 0.08, d / 2 - 0.012);
}

// ---- Safety -------------------------------------------------------------------------

function buildBollard(kit, { w, d, h, color }) {
  const g = kit.group();
  const paint = finish(kit, color, kit.mat.safetyYellow);
  const r = Math.min(w, d) * 0.42;
  const plate = 0.012;
  blk(kit, g, kit.mat.darkSteel, -w / 2, w / 2, 0, plate, -d / 2, d / 2);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) kit.cyl(g, kit.mat.steel, 0.009, 0.012, sx * (w / 2 - 0.022), plate, sz * (d / 2 - 0.022), { segments: 8 });
  }
  const cap = r * 0.7;
  // Concrete filled steel pipe in a powder coated sleeve with a domed cap and reflective bands.
  const top = h - plate;
  turned(kit, g, paint, [[r + 0.004, 0], [r, 0.008], [r, top - cap], [r * 0.97, top - cap * 0.6], [r * 0.85, top - cap * 0.28], [r * 0.55, top - cap * 0.06], [0, top]], 0, plate, 0, { segments: 36 });
  const band = kit.material('#23282b', { roughness: 0.35 });
  for (const y of [h * 0.72, h * 0.82]) kit.cyl(g, band, r + 0.002, 0.045, 0, y, 0, { segments: 36, bevel: false });
  return g;
}

function drawBollard(ctx, o) {
  const { w, d } = o;
  const r = Math.min(w, d) * 0.42;
  pen(ctx, o, FINE);
  rect(ctx, -w / 2, -d / 2, w / 2, d / 2);
  pen(ctx, o, OUT);
  circle(ctx, 0, 0, r, o.theme.light);
  if (r / o.px > 6) {
    pen(ctx, o, FINE);
    circle(ctx, 0, 0, r * 0.45);
  }
}

const ZONE = { tape: 0.05, corner: 0.3, plan: '#e8d77a' };

function buildFloorZone(kit, { w, d, color }) {
  const g = kit.group();
  const tape = isColor(color) ? kit.material(color, { roughness: 0.4 }) : kit.material('#dcb83d', { roughness: 0.4 });
  const mark = kit.material('#23282b', { roughness: 0.45 });
  const t = Math.min(ZONE.tape, w / 6, d / 6);
  const c = Math.min(ZONE.corner, w / 4, d / 4);
  const y0 = 0.0015, y1 = 0.004;
  const strip = (mat, x0, x1, z0, z1) => blk(kit, g, mat, x0, x1, y0, y1, z0, z1, false);
  strip(tape, -w / 2, w / 2, -d / 2, -d / 2 + t);
  strip(tape, -w / 2, w / 2, d / 2 - t, d / 2);
  strip(tape, -w / 2, -w / 2 + t, -d / 2 + t, d / 2 - t);
  strip(tape, w / 2 - t, w / 2, -d / 2 + t, d / 2 - t);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * (w / 2 - t), z = sz * (d / 2 - t);
      strip(mark, x, x - sx * c, z, z - sz * t);
      strip(mark, x, x - sx * t, z - sz * t, z - sz * c);
    }
  }
  return g;
}

function drawFloorZone(ctx, o) {
  const { w, d } = o;
  const t = Math.min(ZONE.tape, w / 6, d / 6);
  const c = Math.min(ZONE.corner, w / 4, d / 4);
  const band = new Path2D();
  band.rect(-w / 2, -d / 2, w, d);
  band.rect(-w / 2 + t, -d / 2 + t, w - 2 * t, d - 2 * t);
  ctx.fillStyle = ZONE.plan;
  ctx.fill(band, 'evenodd');
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const x = sx * (w / 2 - t), y = sy * (d / 2 - t);
      fillRect(ctx, x, y, x - sx * c, y - sy * t, o.theme.line);
      fillRect(ctx, x, y - sy * t, x - sx * t, y - sy * c, o.theme.line);
    }
  }
  pen(ctx, o, FINE);
  rect(ctx, -w / 2, -d / 2, w / 2, d / 2);
  rect(ctx, -w / 2 + t, -d / 2 + t, w / 2 - t, d / 2 - t);
}

// ---- Registration -------------------------------------------------------------------

registerItems(shaded([
  {
    type: 'gondola-shelving', name: 'Gondola shelving', category: 'retail',
    w: 2.44, d: 1.22, h: 1.6, resizable: true,
    tags: ['shelves', 'aisle', 'grocery', 'store fixture', 'double sided'],
    build: buildGondola,
    draw2d: (ctx, o) => drawShelving(ctx, o, true),
  },
  {
    type: 'wall-shelving', name: 'Wall shelving', category: 'retail',
    w: 2.44, d: 0.51, h: 2.13, resizable: true,
    tags: ['shelves', 'perimeter', 'store fixture', 'merchandise'],
    build: buildWallShelving,
    draw2d: (ctx, o) => drawShelving(ctx, o, false),
  },
  fixed({
    type: 'checkout-counter', name: 'Checkout counter', category: 'retail',
    w: 1.83, d: 0.91, h: 1.07,
    tags: ['cash wrap', 'register', 'point of sale', 'pos', 'cashier'],
    build: buildCheckout,
    draw2d: drawCheckout,
  }),
  fixed({
    type: 'display-table', name: 'Display table', category: 'retail',
    w: 1.52, d: 0.91, h: 0.81,
    tags: ['merchandise', 'nesting table', 'apparel', 'showroom'],
    build: buildDisplayTable,
    draw2d: drawDisplayTable,
  }),
  fixed({
    type: 'clothing-rack', name: 'Clothing rack', category: 'retail',
    w: 1.52, d: 0.61, h: 1.6,
    tags: ['garment rail', 'apparel', 'hanging', 'fashion'],
    build: buildClothingRack,
    draw2d: drawClothingRack,
  }),
  fixed({
    type: 'mannequin', name: 'Mannequin', category: 'retail',
    w: 0.51, d: 0.41, h: 1.83,
    tags: ['display form', 'apparel', 'window display', 'fashion'],
    build: buildMannequin,
    draw2d: drawMannequin,
  }),
  {
    type: 'pallet-racking', name: 'Pallet racking', category: 'retail',
    w: 2.74, d: 1.07, h: 4.88, resizable: true, resizableHeight: true,
    tags: ['warehouse', 'selective rack', 'storage', 'industrial', 'distribution'],
    build: buildPalletRacking,
    draw2d: drawPalletRacking,
  },
  fixed({
    type: 'pallet', name: 'Pallet with boxes', category: 'retail',
    w: 1.22, d: 1.02, h: 1.37,
    tags: ['warehouse', 'cartons', 'skid', 'inventory', 'shipping'],
    build: buildPallet,
    draw2d: drawPallet,
  }),
  fixed({
    type: 'forklift', name: 'Forklift', category: 'retail',
    w: 1.22, d: 2.44, h: 2.13,
    tags: ['lift truck', 'warehouse', 'material handling', 'industrial'],
    build: buildForklift,
    draw2d: drawForklift,
  }),
  fixed({
    type: 'workbench', name: 'Workbench', category: 'retail',
    w: 1.83, d: 0.76, h: 1.5,
    tags: ['pegboard', 'tools', 'maintenance', 'shop', 'industrial'],
    build: buildWorkbench,
    draw2d: drawWorkbench,
  }),
  fixed({
    type: 'bollard', name: 'Safety bollard', category: 'retail',
    w: 0.2, d: 0.2, h: 1.07,
    tags: ['post', 'barrier', 'protection', 'warehouse'],
    build: buildBollard,
    draw2d: drawBollard,
  }),
  {
    type: 'floor-zone', name: 'Floor marking zone', category: 'retail',
    w: 2.44, d: 2.44, h: 0.005, resizable: true, blocking: false,
    tags: ['tape', 'floor marking', 'staging', 'safety', 'warehouse'],
    build: buildFloorZone,
    draw2d: drawFloorZone,
  },
]));
