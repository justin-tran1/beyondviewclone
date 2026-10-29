// Framed wall art: abstract paintings and prints, the finishing touch archviz tours hang in every
// corridor, waiting room and office. Each piece shows one of a dozen looks (ItemDef.variants): the
// one chosen for it, or one picked from its id, so a run of them along a corridor varies on its own.
// Local frame: x = width, y = up, z = depth with the front facing +z (plan +y), back on the wall.
import { registerItems } from './registry.js';
import { shaded } from './lab.js';

const OUT = 1.25;       // plan outline weight in px
const FINE = 0.75;      // plan detail weight in px
const TAU = Math.PI * 2;
const HANG = 1.52;      // center height of a hung picture, the gallery standard of 60 inches
const PAINT_SIZE = 512; // canvas texels across a painting

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function seq(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];

/**
 * The looks: a painting style, its ground and palette (sRGB, kept inside real pigment
 * reflectance), the frame and whether a white mat surrounds it. Gestural canvases and gray washes
 * as in the reference tours, with color fields, landscapes and prints for variety.
 */
const LOOKS = [
  { name: 'Ember', style: 'gesture', ground: '#2d2622', paint: ['#a8452e', '#d08a3c', '#e0d3ba', '#3f7f7a', '#7a2f2a'], frame: 'black' },
  { name: 'Storm', style: 'storm', ground: '#b3aea6', paint: ['#2e2a27', '#56514c', '#85807a', '#e6e2da'], frame: 'black' },
  { name: 'Terracotta field', style: 'field', ground: '#c9b79c', paint: ['#a5583b', '#3d3430', '#d8c8a8'], frame: 'walnut' },
  { name: 'Nightfall', style: 'gesture', ground: '#1f2730', paint: ['#2f8f9d', '#d9b44a', '#c0436a', '#e3ded3', '#4d6fa8'], frame: 'black' },
  { name: 'Hills at dusk', style: 'land', ground: '#d9c3a5', paint: ['#8d93a0', '#6b7469', '#4c5450', '#2f3532'], frame: 'oak', mat: true },
  { name: 'Mid-century', style: 'geometric', ground: '#e6ddca', paint: ['#d39a2e', '#2f6e6a', '#b5553a', '#2b2b2b'], frame: 'black', mat: true },
  { name: 'Ink circle', style: 'ink', ground: '#e9e5dc', paint: ['#2a2826', '#6b6863', '#a9a59e', '#a33a2c'], frame: 'black', mat: true },
  { name: 'Slate field', style: 'field', ground: '#9fa9ad', paint: ['#38485a', '#6f8798', '#d6d9d4'], frame: 'black' },
  { name: 'Confetti', style: 'gesture', ground: '#e6e1d7', paint: ['#d1513a', '#2f6f9f', '#e2b13c', '#2e2a28', '#5a9a74'], frame: 'white' },
  { name: 'Strata', style: 'strata', ground: '#7a5a43', paint: ['#a7825f', '#c9ae86', '#5b4a3f', '#d8c7a6', '#8a6f58', '#3f342d'], frame: 'walnut' },
  { name: 'Shoreline', style: 'sea', ground: '#cfd4d2', paint: ['#a9b4b8', '#5d7480', '#3c4f59', '#c8b9a0'], frame: 'black' },
  { name: 'Overprint', style: 'blocks', ground: '#e2dbce', paint: ['#2f4f6f', '#c4572f', '#d9a93a', '#2b2b2b', '#7c9a8a'], frame: 'black', mat: true },
];

// ---- Painting -----------------------------------------------------------------------
// Styles paint in a logical W x H space shaped like the picture (U is its mean side), so a stroke or
// a disc keeps its shape whatever the proportions.

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Soft round wash of color fading to nothing at radius r. */
function wash(c, x, y, r, color, alpha) {
  const g = c.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(color, alpha));
  g.addColorStop(1, rgba(color, 0));
  c.fillStyle = g;
  c.beginPath();
  c.arc(x, y, r, 0, TAU);
  c.fill();
}

/** Points of a cubic Bezier. */
function bezier([p0, p1, p2, p3], n = 40) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
    pts.push([a * p0[0] + b * p1[0] + d * p2[0] + e * p3[0], a * p0[1] + b * p1[1] + d * p2[1] + e * p3[1]]);
  }
  return pts;
}

/**
 * A loaded brush dragged along a path of points: parallel bristle marks, as wide as width(t) at
 * each point (t from 0 to 1), that run dry one by one toward the end.
 */
function brush(c, rnd, pts, width, color, alpha = 0.85, { dry = 0.45 } = {}) {
  const n = pts.length - 1, wide = typeof width === 'function' ? width : () => width;
  const normals = pts.map((p, i) => {
    const q = pts[Math.max(0, i - 1)], r = pts[Math.min(n, i + 1)];
    const dx = r[0] - q[0], dy = r[1] - q[1], L = Math.hypot(dx, dy) || 1;
    return [-dy / L, dx / L];
  });
  const W = Math.max(...pts.map((_, i) => wide(i / n)));
  const bristles = clamp(Math.round(W / 2), 6, 36);
  c.lineCap = c.lineJoin = 'round';
  c.strokeStyle = color;
  for (let k = 0; k < bristles; k++) {
    const off = (k + 0.5) / bristles - 0.5;
    const from = Math.floor(n * 0.08 * rnd()), to = Math.ceil(n * (1 - dry * rnd()));
    c.globalAlpha = alpha * (0.45 + 0.55 * rnd());
    c.lineWidth = (W / bristles) * (1.4 + rnd());
    c.beginPath();
    for (let i = from; i <= to; i++) {
      const t = i / n, o = off * wide(t) * (0.6 + 0.4 * Math.sin(Math.PI * clamp(t, 0.06, 0.94)));
      const x = pts[i][0] + normals[i][0] * o, y = pts[i][1] + normals[i][1] * o;
      if (i === from) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.stroke();
  }
  c.globalAlpha = 1;
}

/** A random sweeping curve: from a point, about `len` long, bowed to one side. */
function sweep(rnd, W, H, len) {
  const a = [rnd() * W, rnd() * H], ang = rnd() * TAU, bow = (rnd() - 0.5) * len * 0.9;
  const ux = Math.cos(ang), uy = Math.sin(ang);
  const at = (t, side) => [a[0] + ux * len * t - uy * side, a[1] + uy * len * t + ux * side];
  return bezier([a, at(1 / 3, bow), at(2 / 3, bow * (0.4 + rnd())), at(1, 0)]);
}

/** Rectangle with soft, hand-painted edges: translucent jittered layers over a denser middle. */
function block(c, rnd, x0, y0, x1, y1, color, U) {
  c.fillStyle = color;
  const j = () => (rnd() - 0.5) * U * 0.014;
  for (let i = 0; i < 12; i++) {
    c.globalAlpha = 0.11;
    c.fillRect(x0 + j(), y0 + j(), x1 - x0 + j(), y1 - y0 + j());
  }
  c.globalAlpha = 0.7;
  const m = U * 0.008;
  c.fillRect(x0 + m, y0 + m, x1 - x0 - 2 * m, y1 - y0 - 2 * m);
  c.globalAlpha = 1;
}

/** A ridgeline across the picture: a sum of a few random waves around height y. */
function ridge(rnd, W, y, amp) {
  const waves = [1, 2.3, 5.1].map((f) => ({ f: f * (0.8 + 0.4 * rnd()), p: rnd() * TAU, a: amp / f }));
  return (x) => y + waves.reduce((s, w) => s + w.a * Math.sin((x / W) * TAU * w.f + w.p), 0);
}

function fillBelow(c, W, H, line, color, alpha = 1) {
  c.globalAlpha = alpha;
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(0, H);
  for (let x = 0; x <= W; x += W / 64) c.lineTo(x, line(x));
  c.lineTo(W, H);
  c.closePath();
  c.fill();
  c.globalAlpha = 1;
}

const STYLES = {
  // Expressive abstract: washes, then broad sweeps, then quicker marks and a little spatter.
  gesture(c, W, H, U, rnd, { paint }) {
    for (let i = 0; i < 8; i++) wash(c, rnd() * W, rnd() * H, U * (0.25 + 0.3 * rnd()), pick(rnd, paint), 0.22);
    for (let i = 0; i < 30; i++) {
      const big = i < 10;
      const len = U * (big ? 0.55 + 0.4 * rnd() : 0.2 + 0.35 * rnd());
      brush(c, rnd, sweep(rnd, W, H, len), U * (big ? 0.08 + 0.07 * rnd() : 0.02 + 0.035 * rnd()), pick(rnd, paint), big ? 0.75 : 0.9);
    }
    for (let i = 0; i < 70; i++) {
      c.globalAlpha = 0.5 + 0.5 * rnd();
      c.fillStyle = pick(rnd, paint);
      c.beginPath();
      c.arc(rnd() * W, rnd() * H, U * 0.002 * (1 + 3 * rnd() ** 3), 0, TAU);
      c.fill();
    }
    c.globalAlpha = 1;
  },
  // Gray storm: deep clouds of charcoal against pale gray, cut by dry dark and light sweeps.
  storm(c, W, H, U, rnd, { paint }) {
    for (let i = 0; i < 26; i++) wash(c, W * (0.1 + 0.8 * rnd()), H * (0.1 + 0.8 * rnd()), U * (0.12 + 0.3 * rnd()), paint[i % 3], 0.2 + 0.2 * rnd());
    for (let i = 0; i < 12; i++) wash(c, rnd() * W, rnd() * H, U * (0.06 + 0.15 * rnd()), paint[3], 0.25);
    for (let i = 0; i < 12; i++) brush(c, rnd, sweep(rnd, W, H, U * (0.4 + 0.5 * rnd())), U * (0.04 + 0.07 * rnd()), paint[i % 2], 0.4);
    for (let i = 0; i < 6; i++) brush(c, rnd, sweep(rnd, W, H, U * (0.3 + 0.3 * rnd())), U * (0.02 + 0.04 * rnd()), paint[3], 0.6);
  },
  // Color field: two or three stacked soft-edged blocks on a tinted ground.
  field(c, W, H, U, rnd, { paint }) {
    const n = H > W * 0.9 ? 3 : 2, m = U * 0.08, gap = U * 0.05;
    const span = H - 2 * m - gap * (n - 1);
    const sizes = Array.from({ length: n }, () => 0.6 + rnd());
    const total = sizes.reduce((a, b) => a + b, 0);
    let y = m;
    sizes.forEach((s, i) => {
      const h = (span * s) / total;
      block(c, rnd, m, y, W - m, y + h, paint[i % paint.length], U);
      y += h + gap;
    });
    for (let i = 0; i < 14; i++) wash(c, rnd() * W, rnd() * H, U * (0.1 + 0.2 * rnd()), pick(rnd, paint), 0.06);
  },
  // Abstract landscape: a soft sky over hills that fade with distance.
  land(c, W, H, U, rnd, { ground, paint }) {
    const sky = c.createLinearGradient(0, 0, 0, H * 0.6);
    sky.addColorStop(0, ground);
    sky.addColorStop(1, paint[0]);
    c.fillStyle = sky;
    c.fillRect(0, 0, W, H);
    wash(c, W * (0.2 + 0.6 * rnd()), H * 0.3, U * 0.25, '#f1e6d2', 0.35);
    for (let i = 1; i < paint.length; i++) {
      fillBelow(c, W, H, ridge(rnd, W, H * (0.42 + 0.14 * i), H * (0.09 - 0.015 * i)), paint[i], 0.92);
      for (let k = 0; k < 4; k++) wash(c, rnd() * W, H * (0.45 + 0.14 * i), U * 0.18, ground, 0.12);
    }
  },
  // Seascape: pale sky, a darkening sea and a strip of sand.
  sea(c, W, H, U, rnd, { ground, paint }) {
    const sky = c.createLinearGradient(0, 0, 0, H * 0.55);
    sky.addColorStop(0, ground);
    sky.addColorStop(1, paint[0]);
    c.fillStyle = sky;
    c.fillRect(0, 0, W, H);
    for (let i = 0; i < 12; i++) wash(c, rnd() * W, rnd() * H * 0.45, U * (0.1 + 0.15 * rnd()), '#eeeeea', 0.18);
    const sea = c.createLinearGradient(0, H * 0.55, 0, H);
    sea.addColorStop(0, paint[1]);
    sea.addColorStop(1, paint[2]);
    c.fillStyle = sea;
    c.fillRect(0, H * 0.55, W, H * 0.45);
    c.strokeStyle = '#e3e6e3';
    c.lineWidth = U * 0.002;
    for (let i = 0; i < 40; i++) {
      const y = H * (0.57 + 0.3 * rnd() ** 1.5), x = rnd() * W, l = U * (0.02 + 0.08 * rnd());
      c.globalAlpha = 0.15 + 0.25 * rnd();
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + l, y);
      c.stroke();
    }
    c.globalAlpha = 1;
    fillBelow(c, W, H, ridge(rnd, W, H * 0.86, H * 0.025), paint[3], 0.95);
  },
  // Mid-century shapes: discs, half discs, an arc and a bar in flat color.
  geometric(c, W, H, U, rnd, { paint }) {
    const cells = [[0.3, 0.32], [0.7, 0.3], [0.32, 0.72], [0.7, 0.7]].sort(() => rnd() - 0.5);
    cells.forEach(([x, y], i) => {
      const r = Math.min(W, H) * (0.12 + 0.1 * rnd());
      c.fillStyle = paint[i % paint.length];
      c.globalAlpha = 0.92;
      c.beginPath();
      if (i % 2) {
        const a = rnd() * TAU;
        c.arc(x * W, y * H, r, a, a + Math.PI);
      } else {
        c.arc(x * W, y * H, r, 0, TAU);
      }
      c.fill();
    });
    c.globalAlpha = 1;
    c.lineWidth = U * 0.012;
    c.strokeStyle = paint[3];
    c.beginPath();
    const a = rnd() * TAU;
    c.arc(W * (0.3 + 0.4 * rnd()), H * (0.3 + 0.4 * rnd()), Math.min(W, H) * 0.3, a, a + Math.PI * (0.8 + 0.6 * rnd()));
    c.stroke();
    c.fillStyle = paint[1];
    c.fillRect(W * 0.12, H * (0.48 + 0.04 * rnd()), W * 0.76, U * 0.018);
  },
  // Ink: pale washes and one dry-brush circle, signed with a small red seal.
  ink(c, W, H, U, rnd, { paint }) {
    for (let i = 0; i < 8; i++) wash(c, rnd() * W, rnd() * H, U * (0.15 + 0.2 * rnd()), paint[2], 0.14);
    const r = Math.min(W, H) * 0.3, a0 = rnd() * TAU, n = 90;
    const pts = Array.from({ length: n + 1 }, (_, i) => {
      const t = a0 + (i / n) * TAU * 0.93, rr = r * (1 + 0.03 * Math.sin(i * 0.21));
      return [W / 2 + Math.cos(t) * rr, H / 2 + Math.sin(t) * rr];
    });
    brush(c, rnd, pts, (t) => U * (0.075 - 0.05 * t), paint[0], 0.92, { dry: 0.25 });
    c.fillStyle = paint[3];
    c.globalAlpha = 0.85;
    const s = U * 0.045;
    c.fillRect(W - U * 0.08 - s, H - U * 0.08 - s, s, s);
    c.globalAlpha = 1;
  },
  // Strata: wavy horizontal bands of earth tones, like a cut through sandstone.
  strata(c, W, H, U, rnd, { paint }) {
    let y = 0, prev = null;
    while (y < H * 1.05) {
      let color = pick(rnd, paint);
      if (color === prev) color = paint[(paint.indexOf(color) + 1) % paint.length];
      fillBelow(c, W, H, ridge(rnd, W, y, U * 0.02), color, 0.9);
      prev = color;
      y += U * (0.03 + 0.1 * rnd());
    }
    for (let i = 0; i < 20; i++) wash(c, rnd() * W, rnd() * H, U * (0.1 + 0.2 * rnd()), pick(rnd, paint), 0.08);
  },
  // Overlapping translucent blocks and a disc, multiplied like screen-printed inks.
  blocks(c, W, H, U, rnd, { paint }) {
    c.globalCompositeOperation = 'multiply';
    for (let i = 0; i < 6; i++) {
      const w = W * (0.2 + 0.35 * rnd()), h = H * (0.15 + 0.35 * rnd());
      c.globalAlpha = 0.75;
      c.fillStyle = paint[i % paint.length];
      c.fillRect(W * 0.1 + rnd() * (W * 0.8 - w), H * 0.1 + rnd() * (H * 0.8 - h), w, h);
    }
    c.fillStyle = paint[1];
    c.beginPath();
    c.arc(W * (0.3 + 0.4 * rnd()), H * (0.3 + 0.4 * rnd()), Math.min(W, H) * 0.14, 0, TAU);
    c.fill();
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
  },
};

/** Picture proportions the looks are painted for (width over height); others crop the nearest. */
const SHAPES = [3 / 2, 1, 2 / 3];

const shapeOf = (ratio) => SHAPES.reduce((best, s) => (Math.abs(Math.log(ratio / s)) < Math.abs(Math.log(ratio / best)) ? s : best));

/**
 * Paint look `index` for a picture `shape` wide per unit of height onto a square canvas of S texels
 * (stretched to fill it; the picture's UVs squeeze it back), finished with a fine canvas grain.
 */
export function paintArtwork(c, S, index, shape = 1) {
  const look = LOOKS[index % LOOKS.length];
  const rnd = seq(9973 * (index + 1));
  const W = shape >= 1 ? S : S * shape, H = shape >= 1 ? S / shape : S;
  c.save();
  c.setTransform(S / W, 0, 0, S / H, 0, 0);
  c.fillStyle = look.ground;
  c.fillRect(0, 0, W, H);
  STYLES[look.style](c, W, H, Math.sqrt(W * H), rnd, look);
  c.restore();
  const img = c.getImageData(0, 0, S, S), px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    const n = (rnd() - 0.5) * 10;
    px[i] = clamp(px[i] + n, 24, 236);
    px[i + 1] = clamp(px[i + 1] + n, 24, 236);
    px[i + 2] = clamp(px[i + 2] + n, 24, 236);
  }
  c.putImageData(img, 0, 0);
}

// ---- 3D -----------------------------------------------------------------------------

// Paintings per kit, one material per look and shape: a canvas texture painted on first use and
// released with the kit, so the cache never holds more than LOOKS x SHAPES of them.
const PAINTINGS = new WeakMap();

function paintingMaterial(kit, index, shape) {
  let cache = PAINTINGS.get(kit);
  if (!cache) {
    PAINTINGS.set(kit, (cache = new Map()));
    const dispose = kit.dispose;
    kit.dispose = () => {
      for (const m of cache.values()) {
        m.map?.dispose();
        m.dispose();
      }
      cache.clear();
      dispose();
    };
  }
  const key = `${index}|${shape}`;
  let m = cache.get(key);
  if (!m) {
    // Acrylic on canvas: matte, a little sheen.
    m = kit.material('#ffffff', { roughness: 0.72 }).clone();
    m.name = 'painting';
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = PAINT_SIZE;
      paintArtwork(canvas.getContext('2d'), PAINT_SIZE, index, shape);
      const t = new kit.THREE.CanvasTexture(canvas);
      t.colorSpace = kit.THREE.SRGBColorSpace;
      t.anisotropy = 8;
      m.map = t;
    }
    cache.set(key, m);
  }
  return m;
}

function frameMaterial(kit, frame) {
  if (frame === 'walnut') return kit.mat.walnut;
  if (frame === 'oak') return kit.mat.oak;
  if (frame === 'white') return kit.material('#e6e4de', { roughness: 0.4 });
  return kit.material('#2b2826', { roughness: 0.45 });
}

/**
 * A picture w wide and h tall in a slim frame d deep, its back on the wall at -d/2. The look is
 * painted for the nearest of SHAPES and cropped from the middle to the opening's own proportions,
 * so the brushwork is never stretched.
 */
function buildArt(kit, { w, d, h, variant = 0 }) {
  const T = kit.THREE;
  const g = kit.group();
  const look = LOOKS[variant % LOOKS.length];
  const frame = frameMaterial(kit, look.frame);
  const f = clamp(Math.min(w, h) * 0.03, 0.012, 0.035), t = Math.min(d, 0.05);
  const z0 = -d / 2, z1 = z0 + t;
  kit.block(g, frame, -w / 2, w / 2, h - f, h, z0, z1);
  kit.block(g, frame, -w / 2, w / 2, 0, f, z0, z1);
  kit.block(g, frame, -w / 2, -w / 2 + f, f, h - f, z0, z1);
  kit.block(g, frame, w / 2 - f, w / 2, f, h - f, z0, z1);
  // The face sits a few millimeters behind the frame's front edge, on a backing that closes the box.
  const face = z1 - 0.005;
  kit.block(g, frame, -w / 2 + f, w / 2 - f, f, h - f, z0, face - 0.002, true, { bevel: false });
  let x0 = -w / 2 + f, x1 = w / 2 - f, y0 = f, y1 = h - f;
  if (look.mat) {
    const mat = kit.material('#ebe8e0', { roughness: 0.92 });
    kit.block(g, mat, x0, x1, y0, y1, face - 0.002, face - 0.001, true, { bevel: false });
    const m = clamp(Math.min(x1 - x0, y1 - y0) * 0.14, 0.03, 0.12);
    x0 += m; x1 -= m; y0 += m; y1 -= m;
  }
  const pw = x1 - x0, ph = y1 - y0;
  if (pw <= 0 || ph <= 0) return g;
  const geo = new T.PlaneGeometry(pw, ph);
  const shape = shapeOf(pw / ph), crop = pw / ph / shape;
  const [su, sv] = crop >= 1 ? [1, 1 / crop] : [crop, 1];
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.5 + (uv.getX(i) - 0.5) * su, 0.5 + (uv.getY(i) - 0.5) * sv);
  const mesh = new T.Mesh(geo, paintingMaterial(kit, variant % LOOKS.length, shape));
  mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, face);
  mesh.receiveShadow = true;
  g.add(mesh);
  return g;
}

function drawArt(ctx, { w, d, px, theme }) {
  ctx.setLineDash([]);
  ctx.lineWidth = OUT * px;
  ctx.strokeStyle = theme.line;
  ctx.strokeRect(-w / 2, -d / 2, w, d);
  // The picture's face, along the front of the frame.
  const f = clamp(w * 0.03, 0.012, 0.035);
  ctx.lineWidth = FINE * px;
  ctx.strokeStyle = theme.muted;
  ctx.beginPath();
  ctx.moveTo(-w / 2 + f, d / 4);
  ctx.lineTo(w / 2 - f, d / 4);
  ctx.stroke();
}

registerItems(shaded([
  {
    type: 'wall-art', name: 'Framed art', category: 'general',
    w: 1.22, d: 0.04, h: 0.81, resizable: true, resizableHeight: true,
    blocking: false, planFill: false, contactShadow: false, hang: HANG,
    variants: LOOKS.map((look) => look.name), variantLabel: 'Artwork',
    tags: ['art', 'artwork', 'painting', 'picture', 'print', 'frame', 'decor', 'wall'],
    build: buildArt, draw2d: drawArt,
  },
]));
