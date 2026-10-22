// Shared 3D materials, procedural textures and primitive builders. Everything 3D (catalog items,
// the plan builder) goes through one kit so the scene reads as a single, consistent model.
// Item-local axes: x = width, y = up, z = depth with the item's FRONT facing +z.
//
// Surfaces are physically based: albedos stay inside real-world reflectance (no pure white or
// black), roughness and metalness follow the material family, and textured surfaces carry albedo,
// roughness and normal detail generated procedurally at a known real-world size. Boxes get small
// rounded edges so they catch highlights, and their UVs are in meters so textures keep true scale.
import * as THREE from 'three';

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
// Linear albedo limits: the brightest real whites (ceiling tile, white laminate) reflect about 90
// percent, wall paint about 80 (PAINT_MAX), black plastic about 3.
const ALBEDO_MAX = 0.9;
const PAINT_MAX = 0.8;
const ALBEDO_MIN = 0.025;
// Preset maps are normalized to this linear mean so material.color stays the surface's average tone.
const MAP_MEAN = 0.8;
// Boxes whose smallest side is at least this get a rounded edge unless { bevel: false }.
const BEVEL_MIN = 0.018;
// Cylinders need at least this radius (and BEVEL_MIN of height) for eased rims; legs stay plain.
const CYL_BEVEL_MIN = 0.02;
const GEOMETRY_CAP = 6000;
const ENV_DEFAULT = 0.5;
const UV_VARIANTS = [[0, 0], [0.37, 0.11], [0.71, 0.53], [0.19, 0.83]];

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function canvasTexture(size, draw, { repeat = 1, srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  return t;
}

// ---- Procedural texture library -------------------------------------------------------------------
// Self-contained (no imports, no outer references) so it can also run in a background worker that
// generates textures ahead of time; createKit() falls back to generating on demand.

function textureLibrary() {
  const TILE = 0.6096;
  const MAP_MEAN = 0.8;
  // Same generator as the exported rng().
  const rng = (seed) => {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  };

  // ---- Tiling noise fields ----------------------------------------------------------------------
  // Fields are Float32Arrays of S x S texels that wrap at every edge, so textures tile seamlessly.

  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const smooth = (a, b, x) => {
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  };
  const hex = (h) => {
    const c = parseInt(h.slice(1), 16);
    return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
  };
  const wrap = (v, S) => ((v % S) + S) % S;
  // Sine by table, for per-texel grain rings: sin(x) = SIN[(x * SIN_K) & SIN_M].
  const SIN_N = 4096, SIN_M = SIN_N - 1, SIN_K = SIN_N / (2 * Math.PI);
  const SIN = Float32Array.from({ length: SIN_N }, (_, i) => Math.sin((i * 2 * Math.PI) / SIN_N));

  /** Add amp * value noise (cx by cy lattice cells across the texture) into out. */
  function addNoise(out, S, cx, cy, seed, amp = 1) {
    const r = rng(seed * 7919 + 17);
    const lat = new Float32Array(cx * cy);
    for (let i = 0; i < lat.length; i++) lat[i] = r() * amp;
    if (cx === S && cy === S) {
      for (let i = 0; i < lat.length; i++) out[i] += lat[i];
      return out;
    }
    const x0 = new Int32Array(S), x1 = new Int32Array(S), tx = new Float32Array(S);
    for (let x = 0; x < S; x++) {
      const f = (x * cx) / S, i = Math.floor(f);
      x0[x] = i % cx;
      x1[x] = (i + 1) % cx;
      tx[x] = fade(f - i);
    }
    // The two lattice rows around y, interpolated along x once per lattice row.
    const row0 = new Float32Array(S), row1 = new Float32Array(S);
    let last = -1;
    for (let y = 0; y < S; y++) {
      const f = (y * cy) / S, j = Math.floor(f), ty = fade(f - j);
      if (j !== last) {
        const r0 = (j % cy) * cx, r1 = ((j + 1) % cy) * cx;
        for (let x = 0; x < S; x++) {
          const a = x0[x], b = x1[x], t = tx[x], p = lat[r0 + a], q = lat[r1 + a];
          row0[x] = p + (lat[r0 + b] - p) * t;
          row1[x] = q + (lat[r1 + b] - q) * t;
        }
        last = j;
      }
      for (let x = 0, k = y * S; x < S; x++, k++) {
        const a = row0[x];
        out[k] += a + (row1[x] - a) * ty;
      }
    }
    return out;
  }

  /**
   * Add amp * gradient (Perlin) noise, about [-0.7, 0.7], with cx by cy lattice cells. Free of the
   * blocky lattice look of value noise, which shows in broad mottling. A lattice row's dot products
   * split into an x term and a y slope, so each row pair is interpolated along x only once.
   */
  function addGradient(out, S, cx, cy, seed, amp = 1) {
    const r = rng(seed * 7919 + 29);
    const gx = new Float32Array(cx * cy), gy = new Float32Array(cx * cy);
    for (let i = 0; i < gx.length; i++) {
      const a = r() * Math.PI * 2;
      gx[i] = Math.cos(a) * amp;
      gy[i] = Math.sin(a) * amp;
    }
    const x0 = new Int32Array(S), x1 = new Int32Array(S), fx = new Float32Array(S), tx = new Float32Array(S);
    for (let x = 0; x < S; x++) {
      const f = (x * cx) / S, i = Math.floor(f);
      x0[x] = i % cx;
      x1[x] = (i + 1) % cx;
      fx[x] = f - i;
      tx[x] = fade(f - i);
    }
    // Per lattice row: the x part of the dot product and the y gradient, interpolated along x.
    const ax0 = new Float32Array(S), ay0 = new Float32Array(S), ax1 = new Float32Array(S), ay1 = new Float32Array(S);
    let last = -1;
    for (let y = 0; y < S; y++) {
      const f = (y * cy) / S, j = Math.floor(f), dy = f - j, ty = fade(dy);
      if (j !== last) {
        const r0 = (j % cy) * cx, r1 = ((j + 1) % cy) * cx;
        for (let x = 0; x < S; x++) {
          const a = x0[x], b = x1[x], t = tx[x], d = fx[x];
          let p = gx[r0 + a] * d, q = gx[r0 + b] * (d - 1);
          ax0[x] = p + (q - p) * t;
          ay0[x] = gy[r0 + a] + (gy[r0 + b] - gy[r0 + a]) * t;
          p = gx[r1 + a] * d;
          q = gx[r1 + b] * (d - 1);
          ax1[x] = p + (q - p) * t;
          ay1[x] = gy[r1 + a] + (gy[r1 + b] - gy[r1 + a]) * t;
        }
        last = j;
      }
      for (let x = 0, k = y * S; x < S; x++, k++) {
        const v0 = ax0[x] + ay0[x] * dy, v1 = ax1[x] + ay1[x] * (dy - 1);
        out[k] += v0 + (v1 - v0) * ty;
      }
    }
    return out;
  }

  /** Value noise in [0, 1] with cx by cy lattice cells across the texture. */
  const noise = (S, cx, cy, seed) => addNoise(new Float32Array(S * S), S, cx, cy, seed);

  /** Fractal value noise; ax and ay stretch the lattice per axis for streaks and grain. */
  function fbm(S, cells, octaves, seed, { gain = 0.5, ax = 1, ay = 1 } = {}) {
    const out = new Float32Array(S * S);
    let amp = 1, total = 0;
    for (let o = 0; o < octaves; o++) {
      const cx = Math.min(S, (cells * ax) << o), cy = Math.min(S, (cells * ay) << o);
      // Gradient noise while the lattice is coarser than 4 texels; value noise near texel scale.
      if (cx * 4 <= S && cy * 4 <= S) addGradient(out, S, cx, cy, seed * 31 + o, amp);
      else addNoise(out, S, cx, cy, seed * 31 + o, amp);
      total += amp;
      amp *= gain;
      if (cx >= S && cy >= S) break;
    }
    return stretch(out, total);
  }

  /** Rescale a field to span [0, 1] (divide by total first when given). */
  function stretch(a, total = 1) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < a.length; i++) {
      const v = (a[i] /= total);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const k = hi > lo ? 1 / (hi - lo) : 0;
    for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) * k;
    return a;
  }

  /** Separable box blur with wrap-around, radius r texels. */
  function blur(a, S, r) {
    const tmp = new Float32Array(S * S), out = new Float32Array(S * S), n = 2 * r + 1;
    const add = Int32Array.from({ length: S }, (_, x) => (x + r + 1) % S);
    const sub = Int32Array.from({ length: S }, (_, x) => wrap(x - r, S));
    for (let y = 0; y < S; y++) {
      const row = y * S;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += a[row + wrap(k, S)];
      for (let x = 0; x < S; x++) {
        tmp[row + x] = sum / n;
        sum += a[row + add[x]] - a[row + sub[x]];
      }
    }
    // Vertical pass row by row with running column sums, which keeps memory access sequential.
    const col = new Float32Array(S);
    for (let k = -r; k <= r; k++) {
      const row = wrap(k, S) * S;
      for (let x = 0; x < S; x++) col[x] += tmp[row + x];
    }
    for (let y = 0; y < S; y++) {
      const row = y * S, ra = add[y] * S, rs = sub[y] * S;
      for (let x = 0; x < S; x++) {
        out[row + x] = col[x] / n;
        col[x] += tmp[ra + x] - tmp[rs + x];
      }
    }
    return out;
  }

  /** Raise a coverage mask toward 1 inside a soft disc at (x, y), wrapping across edges. */
  function mark(m, S, x, y, rad) {
    const r2 = rad * rad;
    for (let py = Math.floor(y - rad); py <= Math.ceil(y + rad); py++) {
      const dy = py + 0.5 - y, row = wrap(py, S) * S;
      for (let px = Math.floor(x - rad); px <= Math.ceil(x + rad); px++) {
        const dx = px + 0.5 - x, d2 = dx * dx + dy * dy;
        if (d2 >= r2) continue;
        const k = row + wrap(px, S), w = 1 - d2 / r2;
        if (w > m[k]) m[k] = w;
      }
    }
  }

  /** A wandering line (crack, fissure) stamped into a coverage mask. */
  function trail(m, S, r, x, y, length, angle, { turn = 0.3, width = 0.7 } = {}) {
    for (let s = 0; s < length; s += 0.6) {
      mark(m, S, x, y, width);
      angle += (r() - 0.5) * turn;
      x += Math.cos(angle) * 0.6;
      y += Math.sin(angle) * 0.6;
    }
  }

  /** Set a disc of texels to an sRGB color (chips, specks). */
  function chip(s, x, y, rad, c) {
    const { S } = s, r2 = rad * rad;
    for (let py = Math.floor(y - rad); py <= Math.ceil(y + rad); py++) {
      const dy = py + 0.5 - y, row = wrap(py, S) * S;
      for (let px = Math.floor(x - rad); px <= Math.ceil(x + rad); px++) {
        const dx = px + 0.5 - x;
        if (dx * dx + dy * dy > r2 + 0.25) continue;
        const k = row + wrap(px, S);
        s.R[k] = c[0];
        s.G[k] = c[1];
        s.B[k] = c[2];
      }
    }
  }

  function surface(S) {
    const n = S * S;
    return { S, R: new Float32Array(n), G: new Float32Array(n), B: new Float32Array(n), H: new Float32Array(n), Ro: new Float32Array(n) };
  }

  /** Write one texel: sRGB color times v, height in mm, absolute roughness. */
  function put(s, i, c, v, h, ro) {
    s.R[i] = c[0] * v;
    s.G[i] = c[1] * v;
    s.B[i] = c[2] * v;
    s.H[i] = h;
    s.Ro[i] = ro;
  }

  // ---- Noise bank ---------------------------------------------------------------------------------
  // Recipes sample offset windows of a few shared fields instead of generating their own noise, so a
  // 1024 floor texture costs well under 100 ms. The bank is dropped once recipes have gone quiet.

  const BANK_S = 1024;
  const BANK_M = BANK_S - 1;
  let BANK = null;
  let bankTimer = 0;

  function bank() {
    clearTimeout(bankTimer);
    bankTimer = setTimeout(() => { BANK = null; }, 20000);
    if (BANK) return BANK;
    const S = BANK_S;
    const streakU = fbm(S, 2, 5, 301, { ay: 16 });
    BANK = {
      cloud: fbm(S, 4, 5, 302), // broad mottling, 256 to 16 texel features
      mid: fbm(S, 32, 3, 303), // 32 to 8 texel blobs
      fine: noise(S, 512, 512, 304), // 2 texel grain
      white: noise(S, S, S, 305), // independent per texel
      streakU, // long streaks along u
      streakV: transpose(streakU, S),
      dash: noise(S, 64, S, 306), // 16 texel dashes along u, one texel wide
    };
    return BANK;
  }

  function transpose(a, S) {
    const out = new Float32Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) out[x * S + y] = a[y * S + x];
    return out;
  }

  /** An S x S window of a bank field offset by (ox, oy) bank texels; S is 1024 or 512. */
  function view(field, S, ox = 0, oy = 0, transposed = false) {
    const out = new Float32Array(S * S), step = BANK_S / S;
    if (transposed) {
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) out[y * S + x] = field[((x * step + ox) & BANK_M) * BANK_S + ((y * step + oy) & BANK_M)];
      }
      return out;
    }
    if (step === 1) {
      // Full-size window: two row copies per row around the wrap.
      ox &= BANK_M;
      for (let y = 0; y < S; y++) {
        const row = ((y + oy) & BANK_M) * S, k = y * S;
        out.set(field.subarray(row + ox, row + S), k);
        if (ox) out.set(field.subarray(row, row + ox), k + S - ox);
      }
      return out;
    }
    for (let y = 0; y < S; y++) {
      const row = ((y * step + oy) & BANK_M) * BANK_S, k = y * S;
      for (let x = 0; x < S; x++) out[k + x] = field[row + ((x * step + ox) & BANK_M)];
    }
    return out;
  }

  // ---- Surface recipes ----------------------------------------------------------------------------
  // Each recipe paints albedo (sRGB), height (mm) and roughness for one tile of `meters` square.
  // Heights are physical, so normal maps come out at the right strength for the texel size.

  function carpetTile(S, B, n) {
    // n by n 24 in loop pile tiles laid quarter turned: heathered yarn, a fine linear striation that
    // turns with each tile, faint tonal runs, and barely visible seams.
    const s = surface(S), tp = S / n, r = rng(41);
    const yarn = view(B.white, S, 7, 3), loops = view(B.fine, S, 101, 37);
    const lineA = view(B.dash, S, 0, 0), lineB = view(B.dash, S, 500, 211, true);
    const runA = view(B.streakU, S, 40, 600), runB = view(B.streakV, S, 300, 500);
    const dark = hex('#4d5456'), light = hex('#737a7c');
    // Dye-lot tones, chosen so they do not line up with the quarter turns.
    const tone = Array.from({ length: n * n }, (_, t) => [1.012, 1.004, 0.99, 0.994][t % 4] + (r() - 0.5) * 0.004);
    for (let y = 0; y < S; y++) {
      const tj = Math.floor(y / tp), ly = y - tj * tp;
      for (let x = 0; x < S; x++) {
        const i = y * S + x, ti = Math.floor(x / tp), lx = x - ti * tp, turned = (ti + tj) & 1;
        const line = turned ? lineB[i] : lineA[i], run = turned ? runB[i] : runA[i];
        const edge = Math.min(lx, ly, tp - 1 - lx, tp - 1 - ly);
        const seam = edge < 1 ? 1 : 0;
        const mix = clamp01(0.5 + 0.55 * (yarn[i] - 0.5) + 0.35 * (loops[i] - 0.5) + 0.4 * (line - 0.5));
        const v = (1 + 0.08 * (run - 0.5)) * (1 - 0.12 * seam);
        s.R[i] = lerp(dark[0], light[0], mix) * v;
        s.G[i] = lerp(dark[1], light[1], mix) * v;
        s.B[i] = lerp(dark[2], light[2], mix) * v;
        s.H[i] = 1.1 * loops[i] + 0.5 * line + 0.3 * yarn[i] - 1.0 * seam;
        s.Ro[i] = 0.9 + 0.1 * yarn[i];
      }
    }
    // Even out each tile's mean so only the chosen dye-lot tone tells the tiles apart; otherwise
    // the noise regions under turned and unturned tiles read as a loud checkerboard.
    const sums = new Float64Array(n * n), counts = new Float64Array(n * n);
    for (let i = 0; i < S * S; i++) {
      const t = Math.floor(((i / S) | 0) / tp) * n + Math.floor((i % S) / tp);
      sums[t] += s.G[i];
      counts[t]++;
    }
    const mean = sums.reduce((a, v) => a + v, 0) / (S * S);
    for (let i = 0; i < S * S; i++) {
      const t = Math.floor(((i / S) | 0) / tp) * n + Math.floor((i % S) / tp), k = (mean * tone[t]) / (sums[t] / counts[t]);
      s.R[i] *= k;
      s.G[i] *= k;
      s.B[i] *= k;
    }
    return s;
  }

  function concreteFloor(S, B, polished) {
    const s = surface(S), r = rng(polished ? 11 : 7), f = S / 1024;
    const o = polished ? 0 : 517;
    const cloud = view(B.cloud, S, o, 91), mott = view(B.mid, S, 220 + o, 40), gloss = view(B.cloud, S, 333, 777 + o);
    const tint = view(B.cloud, S, 600, 100 + o), aggSign = view(B.fine, S, 50, 900);
    const grain = new Float32Array(S * S), pits = new Float32Array(S * S), agg = new Float32Array(S * S);
    // Fines in the paste, scattered aggregate and pores (no cracks: they would repeat every tile).
    for (let k = 0; k < S * S * 0.04; k++) grain[(r() * S * S) | 0] += (r() - 0.5) * (polished ? 0.1 : 0.18);
    for (let k = 0; k < (polished ? 1800 : 600) * f * f; k++) mark(agg, S, r() * S, r() * S, (0.8 + r() * 2) * Math.max(0.6, f));
    for (let k = 0; k < (polished ? 260 : 2600) * f * f; k++) mark(pits, S, r() * S, r() * S, 0.6 + r() * (polished ? 0.7 : 1.3));
    const base = hex(polished ? '#a9a59e' : '#93908a');
    const [cc, pc, pd, hg, r0, rg, rp] = polished
      ? [0.22, 0.22, 0.3, 0, 0.3, 0.28, 0.4]
      : [0.28, 0.3, 0.6, 0.05, 0.82, 0.12, 0.06];
    const { R, G, B: Bl, H, Ro } = s;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const a = agg[i] * (aggSign[i] > 0.5 ? 0.08 : -0.1);
        const v = (0.86 + cc * cloud[i] + 0.1 * mott[i] + grain[i] + a) * (1 - pc * pits[i]);
        const warm = (tint[i] - 0.5) * 0.05;
        R[i] = base[0] * v * (1 + warm);
        G[i] = base[1] * v;
        Bl[i] = base[2] * v * (1 - warm);
        H[i] = 0.05 * mott[i] - pd * pits[i] + hg * grain[i];
        Ro[i] = r0 + rg * gloss[i] + rp * pits[i];
      }
    }
    return s;
  }

  function epoxyFloor(S, B) {
    // Seamless lab epoxy with broadcast flake under a glossy topcoat.
    const s = surface(S), r = rng(3);
    const peel = view(B.mid, S, 700, 300), cloud = view(B.cloud, S, 140, 620);
    const base = hex('#c3c7c7');
    const flakes = [hex('#6a7073'), hex('#8f9597'), hex('#e4e6e5'), hex('#a9a296'), hex('#d6d9d8'), hex('#9fa5a6')];
    for (let i = 0; i < S * S; i++) put(s, i, base, 0.97 + 0.06 * cloud[i], 0.05 * peel[i], 0.28 + 0.1 * cloud[i]);
    for (let k = 0; k < S * S * 0.022; k++) chip(s, r() * S, r() * S, 0.5 + r() * 1.1, flakes[(r() * flakes.length) | 0]);
    return s;
  }

  /**
   * Rows of planks running along u. Each row's planks wrap around the tile so rows tile seamlessly;
   * every plank samples the grain at its own offset so neighbors never repeat each other.
   */
  function plankFloor(S, B, { rows, minLen, maxLen, palette, seed, contrast, rings, rough, bevel }) {
    const s = surface(S), r = rng(seed), step = BANK_S / S;
    const tones = palette.map(hex);
    const rowY = Array.from({ length: rows + 1 }, (_, j) => Math.round((j * S) / rows));
    const rowMaps = [], planks = [];
    for (let j = 0; j < rows; j++) {
      const map = new Int16Array(S), start = Math.floor(r() * S);
      for (let at = 0; at < S;) {
        let L = Math.round((minLen + r() * (maxLen - minLen)) * S);
        if (S - at - L < minLen * S * 0.5) L = S - at;
        const tone = tones[(r() * tones.length) | 0], k = 1 + (r() - 0.5) * 0.1;
        planks.push({
          c: [tone[0] * k, tone[1] * k, tone[2] * k], ox: (r() * BANK_S) | 0, oy: (r() * BANK_S) | 0, b: (start + at) % S, L,
          // Each plank has its own grain spacing, figure and grain strength.
          w: (2 * Math.PI) / (10 + r() * 26), warp: 60 + r() * 110, ring: rings * (0.4 + r() * 0.8),
        });
        for (let x = at; x < at + L; x++) map[(start + x) % S] = planks.length - 1;
        at += L;
      }
      rowMaps.push(map);
    }
    const { streakU, dash, cloud, mid } = B;
    for (let j = 0; j < rows; j++) {
      const map = rowMaps[j], y0 = rowY[j], y1 = rowY[j + 1];
      for (let y = y0; y < y1; y++) {
        const dSide = Math.min(y - y0, y1 - 1 - y);
        for (let x = 0; x < S; x++) {
          const i = y * S + x, p = planks[map[x]];
          let lx = x - p.b;
          if (lx < 0) lx += S;
          const dEnd = Math.min(lx, p.L - 1 - lx);
          const g = ((y * step + p.oy) & BANK_M) * BANK_S + ((x * step + p.ox) & BANK_M);
          // Latewood lines: warped, unevenly spaced, fading in and out along the plank.
          const ring = 0.5 + 0.5 * SIN[((y + p.oy + cloud[g] * p.warp) * p.w * SIN_K) & SIN_M];
          const late = smooth(0.75, 1, ring) * p.ring * smooth(0.3, 0.7, mid[g]);
          const pore = dash[g] > 0.85 ? 1 : 0;
          const edge = Math.min(dSide, dEnd);
          const bev = edge < 1 ? 1 : edge < 2 ? 0.3 : 0;
          const v = (1 + contrast * (streakU[g] - 0.5) * 2 + 0.07 * (dash[g] - 0.5) - 0.08 * late - 0.05 * pore) * (1 - 0.16 * bev);
          // Darker grain is warmer: blue falls off faster than red (first order of v^1.15).
          s.R[i] = p.c[0] * v;
          s.G[i] = p.c[1] * (1.05 * v - 0.05);
          s.B[i] = p.c[2] * (1.15 * v - 0.15);
          s.H[i] = 0.04 * streakU[g] - 0.03 * late - 0.04 * pore - bevel * bev;
          s.Ro[i] = rough + 0.08 * pore + 0.04 * late + 0.15 * bev;
        }
      }
    }
    return s;
  }

  function porcelainFloor(S, B, n) {
    // n by n 24 in porcelain tiles with eased edges and 1/8 in grout (texels of about 2.4 mm).
    const s = surface(S), r = rng(21), tp = S / n, step = BANK_S / S;
    const { cloud, fine, streakU } = B;
    const tile = hex('#c9c5bd'), grout = hex('#98938c');
    const tiles = Array.from({ length: n * n }, () => ({ k: 1 + (r() - 0.5) * 0.08, ox: (r() * BANK_S) | 0, oy: (r() * BANK_S) | 0 }));
    for (let y = 0; y < S; y++) {
      const tj = Math.min(n - 1, Math.floor((y + 0.5) / tp)), ly = y + 0.5 - tj * tp;
      for (let x = 0; x < S; x++) {
        const i = y * S + x, ti = Math.min(n - 1, Math.floor((x + 0.5) / tp)), lx = x + 0.5 - ti * tp;
        const t = tiles[tj * n + ti], g = ((y * step + t.oy) & BANK_M) * BANK_S + ((x * step + t.ox) & BANK_M);
        const d = Math.min(lx, ly, tp - lx, tp - ly);
        const gr = clamp01(1 - d);
        const ease = smooth(0.8, 3, d);
        const v = t.k * (0.9 + 0.18 * cloud[g] + 0.04 * fine[i] - 0.06 * smooth(0.6, 0.9, streakU[g]));
        s.R[i] = lerp(tile[0] * v, grout[0], gr);
        s.G[i] = lerp(tile[1] * v, grout[1], gr);
        s.B[i] = lerp(tile[2] * v, grout[2], gr);
        s.H[i] = -1.4 * (1 - ease) - 0.8 * gr + 0.02 * cloud[g];
        s.Ro[i] = lerp(0.3 + 0.08 * cloud[g], 0.88, gr);
      }
    }
    return s;
  }

  function rubberFloor(S, B) {
    const s = surface(S), r = rng(5);
    const hammer = view(B.mid, S, 830, 210), cloud = view(B.cloud, S, 450, 880);
    const base = hex('#b6c3be'), specks = [hex('#7b8f88'), hex('#e3e9e6'), hex('#93a7a0')];
    for (let i = 0; i < S * S; i++) put(s, i, base, 0.96 + 0.07 * cloud[i], 0.06 * hammer[i], 0.56 + 0.1 * hammer[i]);
    for (let k = 0; k < S * S * 0.09; k++) chip(s, r() * S, r() * S, 0.5 + r() * 0.6, specks[(r() * specks.length) | 0]);
    return s;
  }

  function paintFinish(S, B) {
    // Rolled paint: near-uniform color, fine orange peel, slight sheen variation.
    const s = surface(S);
    const peel = stretch(blur(view(B.fine, S, 77, 5), S, 1)), lap = view(B.cloud, S, 260, 40);
    for (let i = 0; i < S * S; i++) put(s, i, [0.8, 0.8, 0.8], 0.99 + 0.015 * lap[i], 0.05 * peel[i] + 0.02 * lap[i], 0.92 + 0.1 * peel[i]);
    return s;
  }

  function ceilingTile(S, B) {
    // Two by two 24 in mineral fiber tiles: fissured face, pinholes, and the 15/16 in T-bar grid.
    const s = surface(S), r = rng(43), tp = S / 2, f = S / 1024;
    const fiss = new Float32Array(S * S), pins = new Float32Array(S * S);
    for (let k = 0; k < 3400 * f * f; k++) trail(fiss, S, r, r() * S, r() * S, (4 + r() * 14) * f, r() * 6.28, { turn: 0.9, width: 0.6 });
    for (let k = 0; k < 7000 * f * f; k++) mark(pins, S, r() * S, r() * S, 0.5 + r() * 0.5);
    const nod = view(B.mid, S, 15, 615);
    const face = hex('#e7e5df'), tee = hex('#eeeeeb');
    const half = (0.024 / 2 / (2 * TILE)) * S;
    const tones = Array.from({ length: 4 }, () => 1 + (r() - 0.5) * 0.035);
    for (let y = 0; y < S; y++) {
      const ly = (y + 0.5) % tp, dy = Math.min(ly, tp - ly), tj = Math.floor((y + 0.5) / tp) % 2;
      for (let x = 0; x < S; x++) {
        const i = y * S + x, lx = (x + 0.5) % tp, dx = Math.min(lx, tp - lx), ti = Math.floor((x + 0.5) / tp) % 2;
        const d = Math.min(dx, dy);
        if (d < half) {
          put(s, i, tee, 1, 2.2, 0.42);
          continue;
        }
        const lip = smooth(half + 3 * f, half, d);
        const v = tones[tj * 2 + ti] * (0.97 + 0.05 * nod[i]) * (1 - 0.22 * fiss[i]) * (1 - 0.14 * pins[i]) * (1 - 0.16 * lip);
        put(s, i, face, v, 0.25 * nod[i] - 0.7 * fiss[i] - 0.35 * pins[i] - 0.4 * lip, 0.97);
      }
    }
    return s;
  }

  function metalDeck(S, B) {
    // Painted 1.5 in composite deck: four 6 in flutes per tile, ridges running along u.
    const s = surface(S), pitch = S / 4;
    const spray = view(B.mid, S, 333, 444);
    const c = hex('#40474a');
    for (let y = 0; y < S; y++) {
      const t = ((y + 0.5) % pitch) / pitch;
      // Trapezoid: top flange, sloped web, bottom flange, web back up (mm of depth).
      const h = t < 0.23 ? 0 : t < 0.4 ? -38 * smooth(0.23, 0.4, t) : t < 0.73 ? -38 : t < 0.9 ? -38 * (1 - smooth(0.73, 0.9, t)) : 0;
      const shade = h < -37 ? 0.92 : h > -1 ? 1.04 : 0.98;
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        put(s, i, c, shade * (0.95 + 0.08 * spray[i]), h + 0.05 * spray[i], 0.72 + 0.12 * spray[i]);
      }
    }
    return s;
  }

  function fabricWeave(S, B) {
    // Plain weave of about 1 mm yarns with heathered threads and slub streaks.
    const s = surface(S), r = rng(71), p = 4, n = S / p;
    const warpTone = Array.from({ length: n }, () => r()), weftTone = Array.from({ length: n }, () => r());
    const slub = view(B.streakU, S, 512, 77), fuzz = view(B.white, S, 3, 9), heather = view(B.fine, S, 64, 900), mott = view(B.mid, S, 9, 400);
    for (let y = 0; y < S; y++) {
      const tj = Math.floor(y / p), fy = ((y % p) + 0.5) / p;
      for (let x = 0; x < S; x++) {
        const i = y * S + x, ti = Math.floor(x / p), fx = ((x % p) + 0.5) / p;
        const warpUp = (ti + tj) & 1;
        const hw = Math.sin(Math.PI * fx), hf = Math.sin(Math.PI * fy);
        const h = warpUp ? 0.25 + 0.2 * hw * (0.6 + 0.4 * hf) : 0.25 + 0.2 * hf * (0.6 + 0.4 * hw);
        // Color comes from heathered yarn and slubs; the weave itself is only in the relief, so it
        // filters down cleanly instead of shimmering as a grid at a distance.
        const yarn = warpUp ? warpTone[ti] : weftTone[tj];
        const v = 0.9 + 0.04 * (yarn - 0.5) + 0.04 * (slub[i] - 0.5) + 0.07 * (heather[i] - 0.5) + 0.05 * (mott[i] - 0.5) + 0.03 * fuzz[i];
        put(s, i, [0.8, 0.8, 0.8], v, h, 0.9 + 0.1 * fuzz[i]);
      }
    }
    return s;
  }

  /** Sliced veneer: leaves of straight grain along u, each with its own tone and grain offset. */
  function veneer(S, B, { base, seed, figure, period, contrast, pores }) {
    const s = surface(S), r = rng(seed), c = hex(base), step = BANK_S / S;
    const { streakU, cloud, dash } = B;
    const leaves = [];
    for (let at = 0; at < S;) {
      let h = Math.round(S * (0.1 + r() * 0.06));
      if (S - at - h < S * 0.06) h = S - at;
      leaves.push({
        y0: at, y1: at + h, k: 1 + (r() - 0.5) * 0.12, ox: (r() * BANK_S) | 0, oy: (r() * BANK_S) | 0,
        w: (2 * Math.PI) / (period * (0.7 + r() * 0.9)), ring: 0.5 + r() * 0.7,
      });
      at += h;
    }
    const { mid } = B;
    for (const leaf of leaves) {
      for (let y = leaf.y0; y < leaf.y1; y++) {
        const row = ((y * step + leaf.oy) & BANK_M) * BANK_S;
        for (let x = 0; x < S; x++) {
          const i = y * S + x, g = row + ((x * step + leaf.ox) & BANK_M);
          // Latewood lines with uneven spacing that fade in and out; open pores as short dashes.
          const ring = 0.5 + 0.5 * SIN[((y + leaf.oy + cloud[g] * figure) * leaf.w * SIN_K) & SIN_M];
          const late = smooth(0.72, 1, ring) * leaf.ring * smooth(0.25, 0.75, mid[g]);
          const pore = dash[g] > 1 - pores ? 1 : 0;
          const v = leaf.k * (1 + contrast * (streakU[g] - 0.5) * 2 + 0.05 * (dash[g] - 0.5)) * (1 - 0.12 * late) * (1 - 0.12 * pore);
          s.R[i] = c[0] * (0.9 * v + 0.1);
          s.G[i] = c[1] * v;
          s.B[i] = c[2] * (1.2 * v - 0.2);
          s.H[i] = -0.04 * pore - 0.015 * late;
          s.Ro[i] = 0.42 + 0.3 * pore + 0.06 * late;
        }
      }
    }
    return s;
  }

  /** Near-uniform finish detail (laminate suede, plastic stipple, powder coat): grey modulation. */
  function finishDetail(S, B, { radius, height, seed, flake = 0 }) {
    const s = surface(S), r = rng(seed);
    const bump = stretch(blur(view(B.fine, S, seed, 2 * seed), S, radius)), tone = view(B.cloud, S, 3 * seed, seed);
    for (let i = 0; i < S * S; i++) {
      const f = flake && r() < flake ? (r() - 0.5) * 0.3 : 0;
      put(s, i, [0.8, 0.8, 0.8], 0.985 + 0.03 * tone[i] + f, height * bump[i], 0.9 + 0.2 * bump[i]);
    }
    return s;
  }

  function brushedMetal(S, B) {
    // Hairline brushing along u: long fine streaks in tone and roughness.
    const s = surface(S);
    const a = view(B.dash, S, 0, 31), b = view(B.streakU, S, 200, 3), c = view(B.cloud, S, 9, 9);
    for (let i = 0; i < S * S; i++) {
      const st = 0.6 * a[i] + 0.4 * b[i];
      put(s, i, [0.8, 0.8, 0.8], 0.95 + 0.08 * st + 0.03 * c[i], 0.004 * st, 0.75 + 0.5 * st);
    }
    return s;
  }

  function resinTop(S, B) {
    // Black epoxy resin lab top: soft mottling and a satin sheen that varies with wear.
    const s = surface(S);
    const mott = view(B.cloud, S, 70, 70), wear = view(B.cloud, S, 590, 310), fine = view(B.fine, S, 8, 8);
    for (let i = 0; i < S * S; i++) put(s, i, [0.8, 0.8, 0.8], 0.92 + 0.14 * mott[i], 0.01 * fine[i], 0.8 + 0.4 * wear[i] + 0.1 * fine[i]);
    return s;
  }

  function quartzSlab(S, B) {
    const s = surface(S), r = rng(95);
    const cloud = view(B.cloud, S, 820, 160);
    const base = hex('#e3e1db'), specks = [hex('#b8b6b0'), hex('#f3f2ee'), hex('#8e8c88'), hex('#cfc9bd')];
    for (let i = 0; i < S * S; i++) put(s, i, base, 0.97 + 0.05 * cloud[i], 0, 0.1 + 0.03 * cloud[i]);
    for (let k = 0; k < S * S * 0.04; k++) chip(s, r() * S, r() * S, 0.5 + r() * 1.3, specks[(r() * specks.length) | 0]);
    return s;
  }

  function leatherGrain(S, B) {
    // Pebbled vinyl or leather upholstery.
    const s = surface(S);
    const pebble = stretch(blur(view(B.white, S, 5, 17), S, 1)), tone = view(B.cloud, S, 40, 940);
    for (let i = 0; i < S * S; i++) {
      const p = smooth(0.35, 0.75, pebble[i]);
      put(s, i, [0.8, 0.8, 0.8], 0.95 + 0.07 * p + 0.03 * tone[i], 0.06 * p, 0.8 + 0.35 * (1 - p));
    }
    return s;
  }

  /**
   * Texture recipes: size in texels, the real-world size of one tile, and the painter. Floors keep
   * their authored colors; item finishes are normalized so material.color sets the average tone.
   */
  const RECIPES = {
    carpet: { size: 512, meters: 2 * TILE, make: (S, B) => carpetTile(S, B, 2) },
    'polished-concrete': { size: 512, meters: 2.4, make: (S, B) => concreteFloor(S, B, true) },
    concrete: { size: 512, meters: 2.4, make: (S, B) => concreteFloor(S, B, false) },
    epoxy: { size: 512, meters: 1, make: epoxyFloor },
    vinyl: {
      size: 1024, meters: 4 * TILE,
      make: (S, B) => plankFloor(S, B, { rows: 12, minLen: 0.5, maxLen: 0.5, palette: ['#a89884', '#9c8b77', '#b2a28e', '#a1907c', '#ab9a85', '#958571'], seed: 21, contrast: 0.12, rings: 0.8, rough: 0.42, bevel: 0.25 }),
    },
    wood: {
      size: 1024, meters: 4 * TILE,
      make: (S, B) => plankFloor(S, B, { rows: 12, minLen: 0.22, maxLen: 0.62, palette: ['#ab8963', '#9c7a56', '#b5936d', '#93714f', '#a5835c', '#b99a74'], seed: 9, contrast: 0.16, rings: 1, rough: 0.5, bevel: 0.5 }),
    },
    tile: { size: 512, meters: 2 * TILE, make: (S, B) => porcelainFloor(S, B, 2) },
    rubber: { size: 512, meters: 1, make: rubberFloor },
    paint: { size: 512, meters: 0.5, make: paintFinish, normalize: true },
    'ceiling-tile': { size: 512, meters: 2 * TILE, make: ceilingTile },
    deck: { size: 512, meters: TILE, make: metalDeck },
    fabric: { size: 512, meters: 0.12, make: fabricWeave, normalize: true },
    oak: { size: 1024, meters: 1.2, make: (S, B) => veneer(S, B, { base: '#bf9a6e', seed: 111, figure: 24, period: 7, contrast: 0.12, pores: 0.16 }), normalize: true },
    walnut: { size: 1024, meters: 1.2, make: (S, B) => veneer(S, B, { base: '#6a4834', seed: 121, figure: 60, period: 11, contrast: 0.18, pores: 0.1 }), normalize: true },
    laminate: { size: 512, meters: 0.3, make: (S, B) => finishDetail(S, B, { radius: 1, height: 0.012, seed: 131 }), normalize: true },
    stipple: { size: 512, meters: 0.15, make: (S, B) => finishDetail(S, B, { radius: 2, height: 0.02, seed: 141 }), normalize: true },
    powder: { size: 512, meters: 0.25, make: (S, B) => finishDetail(S, B, { radius: 2, height: 0.02, seed: 151, flake: 0.08 }), normalize: true },
    brushed: { size: 512, meters: 0.25, make: brushedMetal, normalize: true },
    resin: { size: 512, meters: 0.8, make: resinTop, normalize: true },
    quartz: { size: 512, meters: 0.5, make: quartzSlab, normalize: true },
    leather: { size: 512, meters: 0.15, make: leatherGrain, normalize: true },
    'raw-concrete': { size: 512, meters: 1.5, make: (S, B) => concreteFloor(S, B, false), normalize: true },
  };

  // sRGB transfer through lookup tables: recipes convert millions of texels.
  const LUT = 4096;
  const TO_LINEAR = Float32Array.from({ length: LUT + 1 }, (_, i) => {
    const c = i / LUT;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  const TO_SRGB8 = Uint8Array.from({ length: LUT + 1 }, (_, i) => {
    const c = i / LUT;
    return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
  });

  // Generated texel data is shared by every kit; GPU textures are per kit and released by dispose().
  const DATA = new Map();

  /** Albedo, normal and roughness texels for a recipe, generated once per page. */
  function recipeData(key) {
    let d = DATA.get(key);
    if (d) return d;
    const spec = RECIPES[key];
    const t0 = performance.now();
    const S = spec.size, s = spec.make(S, bank()), n = S * S;
    // Albedo: optional normalization to a linear mean of MAP_MEAN per channel (mean sampled on a
    // sparse grid), applied through one lookup table per channel.
    const chans = [s.R, s.G, s.B], mean = [0, 0, 0], luts = [];
    for (let c = 0; c < 3; c++) {
      let k = 1;
      if (spec.normalize) {
        const ch = chans[c];
        let sum = 0, count = 0;
        for (let i = 0; i < n; i += 7) {
          sum += TO_LINEAR[(clamp01(ch[i]) * LUT + 0.5) | 0];
          count++;
        }
        mean[c] = sum / count;
        k = MAP_MEAN / Math.max(1e-4, mean[c]);
      }
      luts.push(Uint8Array.from({ length: LUT + 1 }, (_, q) => TO_SRGB8[(Math.min(1, TO_LINEAR[q] * k) * LUT + 0.5) | 0]));
    }
    const albedo = new Uint8Array(n * 4);
    const [lr, lg, lb] = luts, [cr, cg, cb] = chans;
    const q = (v) => ((v < 0 ? 0 : v > 1 ? 1 : v) * LUT + 0.5) | 0;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      albedo[j] = lr[q(cr[i])];
      albedo[j + 1] = lg[q(cg[i])];
      albedo[j + 2] = lb[q(cb[i])];
      albedo[j + 3] = 255;
    }
    // Normal from height (mm) at the texel size (mm per texel); at most 512 square, since relief
    // filters away first and half the texels save a quarter of the memory.
    const N = Math.min(S, 512), hs = S / N;
    let H = s.H;
    if (hs > 1) {
      H = new Float32Array(N * N);
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const i = 2 * y * S + 2 * x;
          H[y * N + x] = (s.H[i] + s.H[i + 1] + s.H[i + S] + s.H[i + S + 1]) / 4;
        }
      }
    }
    const normal = normalFromHeight(H, N, (spec.meters * 1000) / N);
    // Roughness at half resolution, stored relative to its peak.
    const R = S / 2, ro = new Float32Array(R * R);
    let peak = 0, sum = 0;
    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        const i = 2 * y * S + 2 * x;
        const v = clamp01((s.Ro[i] + s.Ro[i + 1] + s.Ro[i + S] + s.Ro[i + S + 1]) / 4);
        ro[y * R + x] = v;
        peak = Math.max(peak, v);
        sum += v;
      }
    }
    const rough = new Uint8Array(R * R * 4);
    for (let i = 0; i < R * R; i++) {
      const v = Math.round((255 * ro[i]) / peak);
      rough[i * 4] = rough[i * 4 + 1] = rough[i * 4 + 2] = v;
      rough[i * 4 + 3] = 255;
    }
    d = {
      key, S, N, R, meters: spec.meters, albedo, normal, rough, normalized: !!spec.normalize,
      roughPeak: peak, roughMean: sum / (R * R), mean, ms: performance.now() - t0,
    };
    DATA.set(key, d);
    return d;
  }

  function normalFromHeight(h, S, px) {
    const out = new Uint8Array(S * S * 4), k = 1 / (2 * px);
    const left = Int32Array.from({ length: S }, (_, x) => (x + S - 1) % S);
    const right = Int32Array.from({ length: S }, (_, x) => (x + 1) % S);
    for (let y = 0; y < S; y++) {
      const row = y * S, up = left[y] * S, dn = right[y] * S;
      for (let x = 0; x < S; x++) {
        const sx = (h[row + right[x]] - h[row + left[x]]) * k;
        const sy = (h[dn + x] - h[up + x]) * k;
        const inv = 127.5 / Math.sqrt(sx * sx + sy * sy + 1), i = (row + x) * 4;
        out[i] = 127.5 - sx * inv + 0.5;
        out[i + 1] = 127.5 - sy * inv + 0.5;
        out[i + 2] = 127.5 + inv + 0.5;
        out[i + 3] = 255;
      }
    }
    return out;
  }

  /** Two channels of low-frequency noise for breaking up tiling at room scale. */
  function macroData() {
    let d = DATA.get('macro');
    if (d) return d;
    const S = 256, a = fbm(S, 4, 5, 201), b = fbm(S, 4, 5, 202), out = new Uint8Array(S * S * 4);
    for (let i = 0; i < S * S; i++) {
      out[i * 4] = Math.round(a[i] * 255);
      out[i * 4 + 1] = Math.round(b[i] * 255);
      out[i * 4 + 3] = 255;
    }
    d = { S, data: out };
    DATA.set('macro', d);
    return d;
  }

  /** Accept texel data generated elsewhere (the prefetch worker). */
  const store = (key, d) => {
    if (!DATA.has(key)) DATA.set(key, d);
  };
  const meters = (key) => RECIPES[key].meters;
  return { recipeData, macroData, store, meters, has: (key) => DATA.has(key), keys: Object.keys(RECIPES) };
}

const TEX = textureLibrary();

// Recipes the samples and the catalog use, most used first. A background worker generates them
// ahead of time so the first 3D build does not stall; any other recipe, or one not ready yet, is
// generated on demand on the main thread instead.
const PREFETCH = [
  'polished-concrete', 'carpet', 'tile', 'vinyl', 'laminate', 'stipple', 'oak', 'brushed', 'powder', 'resin',
  'fabric', 'quartz', 'rubber', 'epoxy', 'walnut', 'paint', 'ceiling-tile', 'leather', 'deck',
];
let prefetched = null;

/**
 * Start generating every texture in a background worker (once per page); resolves when done or
 * when workers are unavailable. createKit() never waits for it.
 */
export function prefetchTextures() {
  if (prefetched) return prefetched;
  prefetched = new Promise((resolve) => {
    const queue = PREFETCH.slice();
    let worker = null, url = null;
    const finish = () => {
      worker?.terminate();
      if (url) URL.revokeObjectURL(url);
      resolve();
    };
    // One recipe per message, so recipes generated on demand meanwhile are skipped.
    const next = () => {
      while (queue.length && TEX.has(queue[0])) queue.shift();
      if (queue.length) worker.postMessage(queue.shift());
      else finish();
    };
    try {
      if (typeof Worker === 'undefined' || typeof Blob === 'undefined') throw new Error('no workers');
      const src = `const TEX = (${textureLibrary.toString()})();
self.onmessage = (e) => {
  const d = TEX.recipeData(e.data);
  self.postMessage({ key: e.data, d }, [d.albedo.buffer, d.normal.buffer, d.rough.buffer]);
};`;
      url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = (e) => {
        TEX.store(e.data.key, e.data.d);
        next();
      };
      worker.onerror = (e) => {
        e.preventDefault();
        finish();
      };
      next();
    } catch {
      finish();
    }
  });
  return prefetched;
}

if (typeof window !== 'undefined') setTimeout(prefetchTextures, 0);

function dataTexture(data, size, { srgb = false, anisotropy = 8 } = {}) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = anisotropy;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// ---- Material classes ------------------------------------------------------------------------------
// Kit materials are standard or physical materials with an optional shader patch:
//   macro: two low-frequency noise samples modulate albedo and roughness so tiled textures do not
//          repeat visibly at room scale (needs a map; ignored by the path tracer, which is fine)
//   micro: the same noise at 0.4 m and 2.7 m in UV meters gives plain colored materials a faint,
//          uneven sheen and tone, so they stop reading as flawless plastic (no maps, so the
//          builder still merges them by color)
//   glass: reflections add on top of the background instead of fading with opacity
// The patch survives clone(), so derived materials (the builder's slab) keep it.

const patched = (Base) => class extends Base {
  constructor(params) {
    super(params);
    this.kitPatch = null;
  }

  copy(source) {
    super.copy(source);
    this.kitPatch = source.kitPatch;
    return this;
  }

  customProgramCacheKey() {
    return this.kitPatch ? this.kitPatch.key : '';
  }

  onBeforeCompile(shader) {
    const p = this.kitPatch;
    if (!p) return;
    let fs = shader.fragmentShader;
    if (p.macro) {
      shader.uniforms.kitMacroMap = { value: p.macro.map };
      shader.uniforms.kitMacroScale = { value: new THREE.Vector2(...p.macro.scale) };
      shader.uniforms.kitMacroAmount = { value: new THREE.Vector2(...p.macro.amount) };
      fs = fs.replace('#include <common>', '#include <common>\nuniform sampler2D kitMacroMap;\nuniform vec2 kitMacroScale;\nuniform vec2 kitMacroAmount;')
        .replace('#include <map_fragment>', `#include <map_fragment>
#ifdef USE_MAP
  float kitMacro = texture2D( kitMacroMap, vMapUv * kitMacroScale.x ).r + texture2D( kitMacroMap, vMapUv * kitMacroScale.y + vec2( 0.37, 0.61 ) ).g - 1.0;
  diffuseColor.rgb *= 1.0 + kitMacroAmount.x * kitMacro;
#endif`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
#ifdef USE_MAP
  roughnessFactor = clamp( roughnessFactor * ( 1.0 + kitMacroAmount.y * kitMacro ), 0.03, 1.0 );
#endif`);
    }
    if (p.micro) {
      shader.uniforms.kitMacroMap = { value: p.micro.map };
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vKitUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vKitUv = uv;');
      fs = fs.replace('#include <common>', '#include <common>\nuniform sampler2D kitMacroMap;\nvarying vec2 vKitUv;')
        .replace('#include <map_fragment>', `#include <map_fragment>
  float kitMicro = texture2D( kitMacroMap, vKitUv * 2.5 ).r + texture2D( kitMacroMap, vKitUv * 0.37 + vec2( 0.21, 0.73 ) ).g - 1.0;
  diffuseColor.rgb *= 1.0 + ${p.micro.amount[0].toFixed(3)} * kitMicro;`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = clamp( roughnessFactor * ( 1.0 + ${p.micro.amount[1].toFixed(3)} * kitMicro ), 0.03, 1.0 );`);
    }
    if (p.glass) {
      fs = fs.replace('vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;',
        'vec3 outgoingLight = totalDiffuse * diffuseColor.a + totalSpecular + totalEmissiveRadiance;')
        .replace('#include <opaque_fragment>', 'gl_FragColor = vec4( outgoingLight, 1.0 );');
    }
    shader.fragmentShader = fs;
  }
};

const KitStandardMaterial = patched(THREE.MeshStandardMaterial);
const KitPhysicalMaterial = patched(THREE.MeshPhysicalMaterial);

/** Clamp a color to real-world albedo, keeping its hue. Idempotent, so derived colors stay put. */
function plausible(color, max = ALBEDO_MAX) {
  const c = color instanceof THREE.Color ? color.clone() : new THREE.Color(color);
  const m = Math.max(c.r, c.g, c.b);
  if (m > max) c.multiplyScalar(max / m);
  else if (m < ALBEDO_MIN) {
    if (m <= 1e-6) c.setRGB(ALBEDO_MIN, ALBEDO_MIN, ALBEDO_MIN, THREE.LinearSRGBColorSpace);
    else c.multiplyScalar(ALBEDO_MIN / m);
  }
  return c;
}

// ---- Floors, presets and architectural finishes --------------------------------------------------

/**
 * Floor finishes keyed like FLOORS in model.js. roughness is the mean roughness; macro is
 * [albedo, roughness] variation at room scale. Polished floors get a clearcoat that mirrors windows.
 */
const FLOOR_SPECS = {
  carpet: { roughness: 0.96, normal: 0.8, macro: [0.08, 0.04] },
  'polished-concrete': { roughness: 0.42, normal: 0.6, macro: [0.06, 0.25], clearcoat: 0.75, clearcoatRoughness: 0.09 },
  concrete: { roughness: 0.88, normal: 0.8, macro: [0.12, 0.08] },
  epoxy: { roughness: 0.32, normal: 0.6, macro: [0.03, 0.25], clearcoat: 1, clearcoatRoughness: 0.05 },
  vinyl: { roughness: 0.44, normal: 0.7, macro: [0.05, 0.2] },
  wood: { roughness: 0.5, normal: 0.8, macro: [0.06, 0.2], clearcoat: 0.8, clearcoatRoughness: 0.16 },
  tile: { roughness: 0.36, normal: 0.8, macro: [0.03, 0.15] },
  rubber: { roughness: 0.6, normal: 0.6, macro: [0.04, 0.12] },
};

/**
 * Material presets used by catalog items (kit.mat.<name>). Keys are stable; add new ones rather
 * than renaming. color is the surface's average albedo (sRGB), detail names a texture recipe.
 */
const PRESETS = {
  white: { color: '#eeede8', roughness: 0.4, detail: 'laminate' },
  casework: { color: '#ebeae5', roughness: 0.38, detail: 'laminate' },
  laminate: { color: '#e3e0d9', roughness: 0.46, detail: 'laminate' },
  epoxyTop: { color: '#26292b', roughness: 0.3, detail: 'resin' },
  quartz: { color: '#e4e2dc', roughness: 0.11, detail: 'quartz' },
  steel: { color: '#c5c6c6', roughness: 0.32, metalness: 1, detail: 'brushed', anisotropy: 0.55 },
  darkSteel: { color: '#585e63', roughness: 0.42, metalness: 0.7, detail: 'powder' },
  chrome: { color: '#d2d4d6', roughness: 0.06, metalness: 1 },
  black: { color: '#2b2f32', roughness: 0.46, detail: 'stipple' },
  plastic: { color: '#d3d5d4', roughness: 0.52, detail: 'stipple' },
  rubber: { color: '#2f3335', roughness: 0.85, detail: 'stipple' },
  screen: { color: '#101417', roughness: 0.07, emissive: '#1b3a4f', emissiveIntensity: 0.3 },
  led: { color: '#ffffff', emissive: '#fff6e8', emissiveIntensity: 1.6 },
  oak: { color: '#b48c60', roughness: 0.5, detail: 'oak', clearcoat: 0.45, clearcoatRoughness: 0.28 },
  walnut: { color: '#644531', roughness: 0.46, detail: 'walnut', clearcoat: 0.5, clearcoatRoughness: 0.26 },
  fabricCharcoal: { color: '#3e4446', roughness: 0.95, detail: 'fabric', fabric: true },
  fabricGrey: { color: '#858b8b', roughness: 0.95, detail: 'fabric', fabric: true },
  fabricGreen: { color: '#38574d', roughness: 0.95, detail: 'fabric', fabric: true },
  fabricSage: { color: '#5a7c7d', roughness: 0.95, detail: 'fabric', fabric: true },
  fabricCeladon: { color: '#8bb0a6', roughness: 0.95, detail: 'fabric', fabric: true },
  fabricWheat: { color: '#c7c194', roughness: 0.95, detail: 'fabric', fabric: true },
  vinylBlue: { color: '#30495b', roughness: 0.5, detail: 'leather' },
  leaf: { color: '#4f7349', roughness: 0.55 },
  soil: { color: '#46392c', roughness: 0.98, detail: 'stipple' },
  potWhite: { color: '#e6e4de', roughness: 0.24 },
  cardboard: { color: '#b28a5f', roughness: 0.92, detail: 'stipple' },
  safetyOrange: { color: '#d8692c', roughness: 0.45, detail: 'powder' },
  safetyYellow: { color: '#dcb83c', roughness: 0.45, detail: 'powder' },
  rackBlue: { color: '#30597f', roughness: 0.42, detail: 'powder' },
  pallet: { color: '#c1a275', roughness: 0.86, detail: 'oak' },
  concrete: { color: '#a5a29c', roughness: 0.88, detail: 'raw-concrete' },
  cbreGreen: { color: '#0f3f31', roughness: 0.48, detail: 'powder' },
  accentGreen: { color: '#17e88f', roughness: 0.45 },
};

const CEILINGS = {
  tile: { recipe: 'ceiling-tile', color: null, roughness: 0.92, normal: 0.8, macro: [0.03, 0.04] },
  drywall: { recipe: 'paint', color: '#edebe6', roughness: 0.86, normal: 0.6, macro: [0.015, 0.05] },
  open: { recipe: 'deck', color: null, roughness: 0.76, normal: 0.9, macro: [0.05, 0.08] },
};

/** Names for test pages and tools: kit.mat keys, floorMaterial keys, ceilingMaterial types. */
export const MATERIAL_PRESETS = Object.keys(PRESETS);
export const FLOOR_FINISHES = Object.keys(FLOOR_SPECS);
export const CEILING_TYPES = Object.keys(CEILINGS);

// ---- The kit ------------------------------------------------------------------------------------------

export function createKit() {
  const cache = new Map();
  const textures = [];
  const sets = new Map();
  const geometries = new Map();
  // Image-based lighting strength for kit materials. 0.5 matches the kit's original default; materials
  // made with an explicit envMapIntensity keep their ratio to it (see setEnvironmentIntensity).
  let envIntensity = ENV_DEFAULT;
  let macroMap = null;

  const remember = (key, m) => {
    m.userData.kitEnv ??= 1;
    m.envMapIntensity = envIntensity * m.userData.kitEnv;
    cache.set(key, m);
    return m;
  };

  /**
   * A cached MeshStandardMaterial in a plain color (no maps, so the builder merges it with others
   * that differ only in color). Same arguments return the same material instance.
   */
  function material(color, opts = {}) {
    const key = `${color}|${JSON.stringify(opts)}`;
    let m = cache.get(key);
    if (!m) {
      const { envMapIntensity, ...rest } = opts;
      m = new KitStandardMaterial({ roughness: 0.75, metalness: 0, ...rest });
      m.kitPatch = microPatch();
      m.color.copy(plausible(color ?? '#ffffff'));
      if (envMapIntensity !== undefined) m.userData.kitEnv = envMapIntensity / ENV_DEFAULT;
      remember(key, m);
    }
    return m;
  }

  /** GPU textures for a recipe; perMeter clones repeat once per `meters` for UVs in meters. */
  function textureSet(key, perMeter) {
    const id = `${key}|${perMeter ? 'm' : 't'}`;
    let set = sets.get(id);
    if (set) return set;
    if (perMeter) {
      const base = textureSet(key, false), k = 1 / base.data.meters;
      const at = (t) => {
        const c = t.clone();
        c.repeat.set(k, k);
        textures.push(c);
        return c;
      };
      set = { data: base.data, map: at(base.map), normalMap: at(base.normalMap), roughnessMap: at(base.roughnessMap) };
    } else {
      const d = TEX.recipeData(key);
      set = {
        data: d,
        map: dataTexture(d.albedo, d.S, { srgb: true }),
        normalMap: dataTexture(d.normal, d.N),
        roughnessMap: dataTexture(d.rough, d.R, { anisotropy: 4 }),
      };
      textures.push(set.map, set.normalMap, set.roughnessMap);
    }
    sets.set(id, set);
    return set;
  }

  function macroTexture() {
    if (!macroMap) {
      const d = TEX.macroData();
      macroMap = dataTexture(d.data, d.S, { anisotropy: 1 });
      textures.push(macroMap);
    }
    return macroMap;
  }

  function macro(meters, amount, periods = [7.3, 2.9]) {
    return { map: macroTexture(), scale: [meters / periods[0], meters / periods[1]], amount };
  }

  // One micro patch shared by every plain material: [albedo, roughness] variation.
  let micro = null;
  const microPatch = () => (micro ||= { key: 'kit-micro', micro: { map: macroTexture(), amount: [0.03, 0.16] } });

  /**
   * A textured surface: maps from a recipe, mean roughness `roughness`, albedo `color` (or the
   * recipe's own colors when null), optional clearcoat, sheen and anisotropy, optional macro.
   */
  function surfaceMaterial(set, { color = null, albedoMax = ALBEDO_MAX, roughness, metalness = 0, normal = 1, clearcoat = 0, clearcoatRoughness = 0.1, sheen = 0, anisotropy = 0, macroAmount = null, emissive, emissiveIntensity }) {
    const d = set.data;
    const physical = clearcoat || sheen || anisotropy;
    const Cls = physical ? KitPhysicalMaterial : KitStandardMaterial;
    const m = new Cls({
      map: set.map, normalMap: set.normalMap, roughnessMap: set.roughnessMap,
      normalScale: new THREE.Vector2(normal, normal),
      // The map holds roughness relative to its peak; scale so the mean lands on `roughness`.
      roughness: Math.min(1, (roughness * d.roughPeak) / d.roughMean),
      metalness,
    });
    if (color && d.normalized) {
      const c = plausible(color, albedoMax);
      m.color.setRGB(c.r / MAP_MEAN, c.g / MAP_MEAN, c.b / MAP_MEAN, THREE.LinearSRGBColorSpace);
    } else if (color) {
      m.color.copy(plausible(color, albedoMax));
    }
    if (emissive) {
      m.emissive.set(emissive);
      m.emissiveIntensity = emissiveIntensity ?? 1;
    }
    if (physical) {
      m.clearcoat = clearcoat;
      m.clearcoatRoughness = clearcoatRoughness;
      if (sheen) {
        m.sheen = sheen;
        m.sheenRoughness = 0.65;
        m.sheenColor.copy(plausible(color || '#bbbbbb')).lerp(new THREE.Color(1, 1, 1), 0.25);
      }
      m.anisotropy = anisotropy;
    }
    if (macroAmount) m.kitPatch = { key: 'kit-macro', macro: macro(d.meters, macroAmount) };
    return m;
  }

  function preset(name) {
    const key = `preset:${name}`;
    let m = cache.get(key);
    if (m) return m;
    const p = PRESETS[name];
    if (!p.detail) {
      const opts = { roughness: p.roughness ?? 0.75 };
      if (p.metalness) opts.metalness = p.metalness;
      if (p.emissive) Object.assign(opts, { emissive: p.emissive, emissiveIntensity: p.emissiveIntensity });
      m = material(p.color, opts);
      cache.set(key, m);
      return m;
    }
    m = surfaceMaterial(textureSet(p.detail, true), {
      color: p.color, roughness: p.roughness, metalness: p.metalness || 0, normal: p.normal ?? 1,
      clearcoat: p.clearcoat || 0, clearcoatRoughness: p.clearcoatRoughness, anisotropy: p.anisotropy || 0,
      sheen: p.fabric ? 0.45 : 0,
    });
    m.name = name;
    m.userData.kitFamily = p.fabric ? 'fabric' : p.detail;
    return remember(key, m);
  }

  const mat = new Proxy({}, {
    get(_, name) {
      if (!Object.hasOwn(PRESETS, name)) throw new Error(`Unknown kit material "${String(name)}"`);
      return preset(name);
    },
  });

  /** Floor material for a FLOORS key. Its maps assume UVs in plan meters / floorMeters(key). */
  function floorMaterial(key) {
    const k = Object.hasOwn(FLOOR_SPECS, key) ? key : 'carpet';
    const cacheKey = `floor:${k}`;
    let m = cache.get(cacheKey);
    if (!m) {
      const f = FLOOR_SPECS[k];
      m = surfaceMaterial(textureSet(k, false), {
        roughness: f.roughness, normal: f.normal, clearcoat: f.clearcoat || 0, clearcoatRoughness: f.clearcoatRoughness,
        sheen: f.sheen || 0, macroAmount: f.macro,
      });
      m.name = `floor-${k}`;
      m.userData.meters = TEX.meters(k);
      remember(cacheKey, m);
    }
    return m;
  }

  const floorMeters = (key) => TEX.meters(Object.hasOwn(FLOOR_SPECS, key) ? key : 'carpet');

  /** Satin wall paint in any color (UVs in meters), with orange peel and faint roller variation. */
  function paintMaterial(color = '#f1efea', { roughness = 0.6 } = {}) {
    const key = `paint:${color}|${roughness}`;
    let m = cache.get(key);
    if (!m) {
      m = surfaceMaterial(textureSet('paint', true), { color, albedoMax: PAINT_MAX, roughness, normal: 0.7, macroAmount: [0.015, 0.06] });
      m.kitPatch.macro.scale = [0.5 / 3.1, 0.5 / 1.1];
      m.name = 'paint';
      remember(key, m);
    }
    return m;
  }

  /**
   * Ceiling finish, UVs in meters: 'tile' is 24 in acoustic tile whose T-bar grid lines sit on
   * multiples of 0.6096 m in u and v; 'drywall' is flat painted gypsum; 'open' is painted metal deck
   * with 6 in flutes whose ridges run along u.
   */
  function ceilingMaterial(type = 'tile') {
    const k = Object.hasOwn(CEILINGS, type) ? type : 'tile';
    const key = `ceiling:${k}`;
    let m = cache.get(key);
    if (!m) {
      const c = CEILINGS[k];
      m = surfaceMaterial(textureSet(c.recipe, true), { color: c.color, albedoMax: PAINT_MAX, roughness: c.roughness, normal: c.normal, macroAmount: c.macro });
      m.name = `ceiling-${k}`;
      remember(key, m);
    }
    return m;
  }

  /**
   * Architectural glass. Reflections add over the background (Fresnel-weighted, so panes read as
   * glass from any angle) and the background shows through tinted by `tint`. The path tracer sees
   * a thin transparent dielectric through opacity, so photos stay correct too.
   */
  function glassMaterial({ tint = '#edf1ef', frosted = false } = {}) {
    const key = `glass:${tint}|${frosted}`;
    let m = cache.get(key);
    if (!m) {
      const t = new THREE.Color(tint);
      m = new KitStandardMaterial({
        color: frosted ? '#e9eceb' : '#1d2223', roughness: frosted ? 0.42 : 0.03, metalness: 0,
        transparent: true, opacity: frosted ? 0.72 : 0.14, depthWrite: false,
      });
      m.color.copy(plausible(m.color));
      m.blending = THREE.CustomBlending;
      m.blendEquation = THREE.AddEquation;
      m.blendSrc = THREE.OneFactor;
      m.blendDst = THREE.ConstantColorFactor;
      // Transmittance: the tint's hue at 88 percent for clear glass (about a quarter when frosted).
      m.blendColor.copy(t).multiplyScalar((frosted ? 0.26 : 0.88) / Math.max(t.r, t.g, t.b, 1e-4));
      m.kitPatch = { key: 'kit-glass', glass: true };
      m.name = frosted ? 'glass-frosted' : 'glass';
      m.userData.kitFamily = 'glass';
      remember(key, m);
    }
    return m;
  }

  const glass = glassMaterial();
  const frostedGlass = glassMaterial({ frosted: true });

  /**
   * Set the envMapIntensity of every kit material (default 0.5). 1 is physically consistent once
   * scene.environment is a capture of the lit interior; materials made with an explicit
   * envMapIntensity scale with it, keeping their ratio to the default.
   */
  function setEnvironmentIntensity(v) {
    envIntensity = v;
    for (const m of cache.values()) m.envMapIntensity = v * (m.userData.kitEnv ?? 1);
  }

  // ---- Geometry ----

  /** Cached geometry; the oldest entries are dropped (and disposed) past GEOMETRY_CAP. */
  function cachedGeometry(key, make) {
    let g = geometries.get(key);
    if (g) return g;
    if (geometries.size >= GEOMETRY_CAP) {
      let n = GEOMETRY_CAP / 4;
      for (const [k, old] of geometries) {
        old.dispose();
        geometries.delete(k);
        if (--n <= 0) break;
      }
    }
    g = make();
    g.userData.kitShared = true;
    geometries.set(key, g);
    return g;
  }

  const textured = (m) => !!(m && (m.map || m.normalMap || m.roughnessMap));

  /** Edge radius for a part: soft upholstery rounds generously, everything else gets an eased edge. */
  function autoRadius(material, min) {
    if (min < BEVEL_MIN) return 0;
    if (material?.userData?.kitFamily === 'fabric') return Math.min(0.03, min * 0.22);
    if (material?.transparent) return 0;
    return Math.min(0.006, Math.max(0.002, min * 0.1));
  }

  /**
   * Box from extents (meters, item-local). Shadows on by default. Parts at least BEVEL_MIN on
   * every side get a small rounded edge (bevel: 'auto'); pass bevel: false for a sharp box or a
   * number for an explicit radius in meters. UVs are in meters.
   */
  function block(parent, material, x0, x1, y0, y1, z0, z1, shadows = true, { bevel = 'auto' } = {}) {
    const w = Math.max(1e-4, x1 - x0), h = Math.max(1e-4, y1 - y0), d = Math.max(1e-4, z1 - z0);
    const min = Math.min(w, h, d);
    let r = 0;
    if (bevel === 'auto' || bevel === true) r = autoRadius(material, min);
    else if (typeof bevel === 'number' && bevel > 0) r = bevel;
    r = Math.min(r, min * 0.45);
    const tex = textured(material);
    // Textured parts sample one of a few UV offsets, so repeated parts do not share one grain.
    const variant = tex ? Math.abs(Math.round(x0 * 997 + y0 * 613 + z0 * 389)) % UV_VARIANTS.length : 0;
    const q = (v) => Math.round(v * 1e4);
    let m;
    if (r >= 0.0015) {
      const n = r >= 0.02 ? 3 : r >= 0.01 ? 2 : 1;
      const key = `r|${q(w)}|${q(h)}|${q(d)}|${q(r)}|${n}|${variant}`;
      m = new THREE.Mesh(cachedGeometry(key, () => roundedBox(w, h, d, r, n, UV_VARIANTS[variant])), material);
    } else if (tex) {
      const key = `b|${q(w)}|${q(h)}|${q(d)}|${variant}`;
      m = new THREE.Mesh(cachedGeometry(key, () => roundedBox(w, h, d, 0, 0, UV_VARIANTS[variant])), material);
    } else {
      m = new THREE.Mesh(UNIT_BOX, material);
      m.scale.set(w, h, d);
    }
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    m.castShadow = m.receiveShadow = shadows;
    parent.add(m);
    return m;
  }

  /**
   * Cylinder standing on y0 (axis 'y'), or lying centered at (x, y0, z) along 'x' or 'z'. Discs and
   * drums of at least CYL_BEVEL_MIN radius and height get eased rims (bevel: false for sharp ones).
   */
  function cyl(parent, material, r, h, x, y0, z, { axis = 'y', segments = 20, rTop = r, bevel = 'auto' } = {}) {
    let e = 0;
    if (bevel !== false && !material?.transparent && Math.min(r, rTop) >= CYL_BEVEL_MIN && h >= BEVEL_MIN) {
      e = typeof bevel === 'number' ? bevel : Math.min(0.005, Math.max(0.0015, 0.1 * Math.min(r, rTop, h)));
      e = Math.min(e, 0.45 * Math.min(r, rTop, h));
    }
    const g = e > 0 ? roundedCylinder(rTop, r, h, segments, e) : new THREE.CylinderGeometry(rTop, r, h, segments);
    if (!e) cylinderUVs(g, (r + rTop) / 2, h, segments);
    const m = new THREE.Mesh(g, material);
    if (axis === 'y') m.position.set(x, y0 + h / 2, z);
    if (axis === 'x') { m.rotation.z = Math.PI / 2; m.position.set(x, y0, z); }
    if (axis === 'z') { m.rotation.x = Math.PI / 2; m.position.set(x, y0, z); }
    m.castShadow = m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  function sphere(parent, material, r, x, y, z, { segments = 16, scaleY = 1 } = {}) {
    const g = new THREE.SphereGeometry(r, segments, Math.max(8, segments / 2));
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2 * Math.PI * r, uv.getY(i) * Math.PI * r);
    const m = new THREE.Mesh(g, material);
    m.position.set(x, y, z);
    m.scale.y = scaleY;
    m.castShadow = m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  function torus(parent, material, r, tube, x, y, z, { axis = 'y' } = {}) {
    const m = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 8, 28), material);
    if (axis === 'y') m.rotation.x = Math.PI / 2;
    if (axis === 'x') m.rotation.y = Math.PI / 2;
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }

  /** Release every cached material, texture and geometry. Call once the scene using this kit is gone. */
  function dispose() {
    for (const m of cache.values()) m.dispose();
    for (const t of textures) t.dispose();
    for (const g of geometries.values()) g.dispose();
    cache.clear();
    sets.clear();
    geometries.clear();
    textures.length = 0;
    macroMap = null;
    micro = null;
  }

  return {
    THREE,
    dispose,
    material,
    mat,
    glass,
    frostedGlass,
    floorMaterial,
    floorMeters,
    paintMaterial,
    ceilingMaterial,
    glassMaterial,
    setEnvironmentIntensity,
    canvasTexture,
    block,
    cyl,
    sphere,
    torus,
    group: () => new THREE.Group(),
  };
}

// ---- Geometry builders ----------------------------------------------------------------------------

/**
 * Topology of a rounded box with n segments per round (n = 0: sharp box with a vertex set per
 * face), built once per n: per vertex its corner signs, unit normal and UV face axis, plus
 * triangles wound outward. Faces stay single quads, so the cost is 12 + 24n + 8n^2 triangles
 * (44 for n = 1, against 12 for a sharp box), and vertices are shared so normals curve smoothly
 * over the rounds and edges catch highlights.
 */
const BOX_TEMPLATES = new Map();

function boxTemplate(n) {
  let t = BOX_TEMPLATES.get(n);
  if (t) return t;
  const verts = [], index = [], ids = new Map();
  const L = n || 1;
  // Lattice point on corner s whose normal leans i : j : k toward x, y and z.
  const at = (s, [i, j, k], faceAxis = -1) => {
    const key = `${s}|${i}|${j}|${k}|${n ? -1 : faceAxis}`;
    let id = ids.get(key);
    if (id !== undefined) return id;
    const nv = [i * s[0], j * s[1], k * s[2]], l = Math.hypot(...nv);
    const nn = nv.map((v) => v / l), a = nn.map(Math.abs);
    const axis = faceAxis >= 0 ? faceAxis : a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2;
    id = verts.length;
    verts.push({ s, n: nn, axis });
    ids.set(key, id);
    return id;
  };
  // Wind each triangle outward, judged on a reference box (orientation holds for any size).
  const ref = (q) => verts[q].s.map((sv, c) => sv + 0.5 * verts[q].n[c]);
  const tri = (a, b, c) => {
    const [A, B, C] = [ref(a), ref(b), ref(c)];
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const f = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const dot = [a, b, c].reduce((sum, q) => sum + verts[q].n[0] * f[0] + verts[q].n[1] * f[1] + verts[q].n[2] * f[2], 0);
    if (dot >= 0) index.push(a, b, c);
    else index.push(a, c, b);
  };
  const quad = (a, b, c, e) => { tri(a, b, c); tri(a, c, e); };
  const signs = [-1, 1];
  const place = (axes, values) => {
    const v = [0, 0, 0];
    axes.forEach((ax, m) => { v[ax] = values[m]; });
    return v;
  };
  for (let axis = 0; axis < 3; axis++) {
    const b = (axis + 1) % 3, c = (axis + 2) % 3;
    for (const sa of signs) {
      const corner = (sb, sc) => at(place([axis, b, c], [sa, sb, sc]), place([axis], [L]), n ? -1 : axis);
      quad(corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1));
    }
  }
  if (n) {
    // Edge strips: the arc from face a to face b, swept along axis c.
    for (let c = 0; c < 3; c++) {
      const a = (c + 1) % 3, b = (c + 2) % 3;
      for (const sa of signs) {
        for (const sb of signs) {
          const p = (sc, tt) => at(place([a, b, c], [sa, sb, sc]), place([a, b], [n - tt, tt]));
          for (let tt = 0; tt < n; tt++) quad(p(-1, tt), p(-1, tt + 1), p(1, tt + 1), p(1, tt));
        }
      }
    }
    // Corner patches: a triangular lattice over each octant.
    for (const sx of signs) {
      for (const sy of signs) {
        for (const sz of signs) {
          const s = [sx, sy, sz];
          for (let i = 0; i < n; i++) {
            for (let j = 0; i + j < n; j++) {
              const k = n - 1 - i - j;
              tri(at(s, [i + 1, j, k]), at(s, [i, j + 1, k]), at(s, [i, j, k + 1]));
              if (k > 0) tri(at(s, [i + 1, j + 1, k - 1]), at(s, [i + 1, j, k]), at(s, [i, j + 1, k]));
            }
          }
        }
      }
    }
  }
  // Flat arrays for the per-size fill.
  const count = verts.length;
  t = { count, s: new Float32Array(count * 3), n: new Float32Array(count * 3), axis: new Uint8Array(count), index: Uint16Array.from(index) };
  verts.forEach((v, q) => {
    t.s.set(v.s, q * 3);
    t.n.set(v.n, q * 3);
    t.axis[q] = v.axis;
  });
  BOX_TEMPLATES.set(n, t);
  return t;
}

/** Box of w x h x d centered on the origin, edges rounded to radius r (n segments), UVs in meters. */
function roundedBox(w, h, d, r, n, [ou, ov] = [0, 0]) {
  const t = boxTemplate(n), N = t.count;
  const half = [w / 2 - r, h / 2 - r, d / 2 - r], ext = [w, h, d];
  const pos = new Float32Array(N * 3), uv = new Float32Array(N * 2), p = [0, 0, 0];
  for (let q = 0; q < N; q++) {
    for (let c = 0; c < 3; c++) p[c] = pos[q * 3 + c] = t.s[q * 3 + c] * half[c] + r * t.n[q * 3 + c];
    // Planar UVs per face, unmirrored seen from outside: +x u = -z, +y v = -z, +z u = x.
    const axis = t.axis[q], side = t.s[q * 3 + axis];
    let u, v;
    if (axis === 0) { u = -p[2] * side; v = p[1]; } else if (axis === 1) { u = p[0]; v = -p[2] * side; } else { u = p[0] * side; v = p[1]; }
    // Grain and brushing run along u, so turn u onto the face's longer side.
    if (ext[axis === 1 ? 2 : 1] > ext[axis === 0 ? 2 : 0]) [u, v] = [v, -u];
    uv[q * 2] = u + ou;
    uv[q * 2 + 1] = v + ov;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(t.n.slice(), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(t.index.slice(), 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * Cylinder of height h centered on the origin with both rims eased by a chamfer of size e whose
 * normals curve from the cap to the side, so rims catch light like a rounded edge. Flat caps keep
 * flat normals. 8 * segments triangles (twice a plain CylinderGeometry). UVs in meters.
 */
function roundedCylinder(rTop, rBot, h, segments, e) {
  const y0 = -h / 2, y1 = h / 2;
  // Side normal of a tapered wall, in (radial, y).
  const sl = Math.hypot(h, rBot - rTop), sn = [h / sl, (rBot - rTop) / sl];
  // Profile rings from the bottom center to the top center: [radius, y, normal radial, normal y].
  const rings = [
    [0, y0, 0, -1], [rBot - e, y0, 0, -1], [rBot, y0 + e, sn[0], sn[1]],
    [rTop, y1 - e, sn[0], sn[1]], [rTop - e, y1, 0, 1], [0, y1, 0, 1],
  ];
  const n = segments + 1, around = Math.PI * (rTop + rBot);
  const pos = new Float32Array(rings.length * n * 3), nrm = new Float32Array(rings.length * n * 3), uv = new Float32Array(rings.length * n * 2);
  rings.forEach(([rad, y, nr, ny], j) => {
    for (let i = 0; i < n; i++) {
      const a = (i / segments) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), k = j * n + i;
      pos.set([rad * s, y, rad * c], k * 3);
      nrm.set([nr * s, ny, nr * c], k * 3);
      // Caps map in plan; the wall and rims unroll around the circumference.
      if (j === 0 || j === 5 || ny * ny > 0.99 && (j === 1 || j === 4)) uv.set([rad * s, rad * c], k * 2);
      else uv.set([(i / segments) * around, y], k * 2);
    }
  });
  const index = [];
  for (let j = 0; j < rings.length - 1; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      if (j !== 0) index.push(a, b, c);
      if (j !== rings.length - 2) index.push(b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** Cylinder UVs in meters with u along the longer of height and circumference. */
function cylinderUVs(g, r, h, segments) {
  const a = g.attributes.uv.array, side = (segments + 1) * 2, around = 2 * Math.PI * r, swap = h > around;
  for (let i = 0; i < a.length / 2; i++) {
    const x = a[i * 2], y = a[i * 2 + 1];
    if (i >= side) {
      a[i * 2] = (x - 0.5) * 2 * r;
      a[i * 2 + 1] = (y - 0.5) * 2 * r;
    } else if (swap) {
      a[i * 2] = y * h;
      a[i * 2 + 1] = x * around;
    } else {
      a[i * 2] = x * around;
      a[i * 2 + 1] = y * h;
    }
  }
}

/** Dispose geometries under obj, except the kit's shared ones (released by kit.dispose()). */
export function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry && o.geometry !== UNIT_BOX && !o.geometry.userData?.kitShared) o.geometry.dispose();
  });
}
