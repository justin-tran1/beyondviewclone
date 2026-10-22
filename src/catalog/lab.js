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
const isColor = (c) => typeof c === 'string' && c.length > 0;
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

/**
 * Lab finishes: white laminate casework, black epoxy resin tops and sinks, brushed stainless,
 * powder coated and enameled steel, molded plastics. A custom color tints the door fronts and the
 * equipment enamel, keeping their texture.
 */
function palette(kit, color) {
  const custom = isColor(color) ? color : null;
  const steel = kit.mat.steel, plastic = kit.mat.plastic;
  const enamel = kit.paintMaterial(custom || '#e8e8e4', { roughness: 0.34 });
  return {
    custom,
    case: kit.mat.casework,
    door: tint(kit, kit.mat.casework, custom),
    body: enamel,
    white: tint(kit, plastic, '#e6e7e4'),
    top: kit.mat.epoxyTop,
    steel,
    darkSteel: kit.mat.darkSteel,
    chrome: kit.mat.chrome,
    pull: steel,
    black: kit.mat.black,
    rubber: kit.mat.rubber,
    screen: kit.mat.screen,
    led: kit.mat.led,
    status: kit.mat.accentGreen,
    yellow: kit.mat.safetyYellow,
    reveal: kit.material('#3d4245', { roughness: 0.9 }),
    plinth: kit.mat.rubber,
    slot: kit.material('#25292c', { roughness: 0.9 }),
    trim: tint(kit, plastic, '#dcdfde'),
    alu: tint(kit, steel, '#cfd2d3'),
    plate: tint(kit, plastic, '#ecebe7'),
    basin: kit.mat.epoxyTop,
    lit: kit.material('#eef1f0', { roughness: 0.6, emissive: '#ffffff', emissiveIntensity: 0.22 }),
    interior: tint(kit, kit.mat.laminate, '#e2e5e3'),
    paper: kit.material('#efeee9', { roughness: 0.85 }),
    // Glass bottles read by their contents: smooth, glossy and tinted.
    liquids: LIQUIDS.map((c) => kit.material(c, { roughness: 0.06 })),
    caps: CAPS.map((c) => kit.material(c, { roughness: 0.4 })),
  };
}

// ---- Finishes and soft shapes (shared by every category file) ----------------------
// tint() recolors a kit preset without losing its textures. The shapes add what the kit's boxes
// and cylinders cannot: crowned cushions, turned (lathe) parts, slabs with rounded corners, bent
// tubes and leaves. Their UVs are in meters, so textures keep their real-world scale.

const TINTS = new WeakMap();

/**
 * `base` in `color` (or in its own color times f), keeping its maps, roughness and sheen (or a new
 * sheen strength). Textured kit maps are normalized to a mean of 0.8, so the color becomes the
 * surface's mean albedo. Plain materials come back as kit.material, which the builder still merges
 * by color.
 */
export function tint(kit, base, color, f = 1, { sheen } = {}) {
  if (!isColor(color) && f === 1 && sheen === undefined) return base;
  const T = kit.THREE;
  const c = isColor(color) ? new T.Color(color) : base.color.clone().multiplyScalar(f);
  if (!base.map) return kit.material(`#${c.getHexString()}`, { roughness: base.roughness, metalness: base.metalness });
  let cache = TINTS.get(kit);
  if (!cache) {
    TINTS.set(kit, (cache = new Map()));
    // The copies share the kit's textures; release them with it.
    const dispose = kit.dispose;
    kit.dispose = () => {
      for (const m of cache.values()) m.dispose();
      cache.clear();
      dispose();
    };
  }
  const key = `${base.uuid}|${color}|${f}|${sheen}`;
  let m = cache.get(key);
  if (!m) {
    m = base.clone();
    if (isColor(color)) {
      const hi = Math.max(c.r, c.g, c.b);
      if (hi > 0.9) c.multiplyScalar(0.9 / hi);
      else if (hi < 0.025) c.setScalar(0.025);
      if (m.sheen) m.sheenColor.copy(c).lerp(new T.Color(1, 1, 1), 0.25);
      c.multiplyScalar(1.25);
    }
    m.color.copy(c);
    if (sheen !== undefined && m.sheen) m.sheen = sheen;
    m.name = `${base.name || 'finish'}-tint`;
    cache.set(key, m);
  }
  m.envMapIntensity = base.envMapIntensity;
  return m;
}

const SHAPES = new Map();
const SHAPE_CAP = 400;

/** Geometry cached by shape key, so repeated parts (seats in a row) share one. */
function shape(key, make) {
  let g = SHAPES.get(key);
  if (!g) {
    if (SHAPES.size >= SHAPE_CAP) SHAPES.delete(SHAPES.keys().next().value);
    SHAPES.set(key, (g = make()));
  }
  return g;
}

const q4 = (v) => Math.round(v * 1e4);

function place(kit, g, geometry, mat, x, y, z, shadows = true) {
  const mesh = new kit.THREE.Mesh(geometry, mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = mesh.receiveShadow = shadows;
  g.add(mesh);
  return mesh;
}

/**
 * Box w x h x d centered on the origin, every edge rounded to r, with its +y face (axis 'y') or
 * +z face (axis 'z') crowned `crown` meters at the middle and easing to flat at the rounds (both
 * faces along that axis when `both`, like a pillow). Normals are analytic, so shading stays smooth.
 */
function cushionGeometry(T, w, h, d, r, crown, axis, both, mid = null, k = 2) {
  const ext = [w, h, d], half = ext.map((v) => v / 2);
  r = Math.max(0.001, Math.min(r, ...half.map((v) => v * 0.98)));
  // mid: segments across the flat middle per axis (more where a warp bends the part).
  const seg = ext.map((v, j) => 2 * k + (mid ? mid[j] : v > 0.3 ? 4 : v > 0.12 ? 2 : 1));
  const g = new T.BoxGeometry(w, h, d, ...seg);
  g.clearGroups();
  const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
  const inner = half.map((v) => v - r);
  const c = axis === 'z' ? 2 : 1, [a, b] = c === 1 ? [0, 2] : [0, 1];
  const p = [0, 0, 0], q = [0, 0, 0], n = [0, 0, 0];
  for (let i = 0; i < pos.count; i++) {
    // The uniform grid is remapped so k rows span each round and the rest the flat middle.
    for (let j = 0; j < 3; j++) {
      const t = Math.round((pos.getComponent(i, j) / ext[j] + 0.5) * seg[j]), m = seg[j] - 2 * k;
      p[j] = t <= k ? -half[j] + (r * t) / k : t >= k + m ? inner[j] + (r * (t - k - m)) / k : -inner[j] + ((t - k) / m) * 2 * inner[j];
    }
    let len = 0;
    for (let j = 0; j < 3; j++) {
      q[j] = Math.max(-inner[j], Math.min(inner[j], p[j]));
      n[j] = p[j] - q[j];
      len += n[j] * n[j];
    }
    len = Math.sqrt(len) || 1;
    for (let j = 0; j < 3; j++) {
      n[j] /= len;
      q[j] += n[j] * r;
    }
    if (crown > 0 && (n[c] > 0 || (both && n[c] < 0))) {
      const ua = q[a] / half[a], ub = q[b] / half[b], fa = 1 - ua * ua, fb = 1 - ub * ub, s = Math.abs(n[c]), sg = Math.sign(n[c]);
      q[c] += sg * crown * fa * fb * s;
      n[a] += ((2 * crown * ua) / half[a]) * fb * s * s;
      n[b] += ((2 * crown * ub) / half[b]) * fa * s * s;
      const l = Math.hypot(n[0], n[1], n[2]);
      for (let j = 0; j < 3; j++) n[j] /= l;
    }
    // Planar UVs per original face, in meters.
    const fx = Math.abs(nor.getX(i)), fy = Math.abs(nor.getY(i));
    if (fx > 0.5) uv.setXY(i, q[2], q[1]);
    else if (fy > 0.5) uv.setXY(i, q[0], q[2]);
    else uv.setXY(i, q[0], q[1]);
    pos.setXYZ(i, q[0], q[1], q[2]);
    nor.setXYZ(i, n[0], n[1], n[2]);
  }
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * Upholstered block over the extents with rounded edges (r) and a crowned top or front. warp
 * ({ key, fn }) then bends it: fn(v) moves a point given relative to the block's center (a
 * THREE.Vector3, changed in place), for bowed backs, waterfall seat fronts and tapered legs; key
 * names the bend for the geometry cache. mid sets the segments across each axis's flat middle
 * and k the segments per round.
 */
export function cushion(kit, g, mat, x0, x1, y0, y1, z0, z1, { r = 0.03, crown = 0, axis = 'y', both = false, warp = null, mid = null, k = 2 } = {}) {
  const w = x1 - x0, h = y1 - y0, d = z1 - z0;
  // Without a crown or a bend the kit's rounded box is the same shape at a fraction of the triangles.
  if (!(crown > 0) && !warp) return kit.block(g, mat, x0, x1, y0, y1, z0, z1, true, { bevel: Math.max(0.0015, Math.min(r, w * 0.45, h * 0.45, d * 0.45)) });
  const key = `c|${q4(w)}|${q4(h)}|${q4(d)}|${q4(r)}|${q4(crown)}|${axis}|${both}|${warp ? warp.key : ''}|${mid || ''}|${k}`;
  const geo = shape(key, () => {
    const c = cushionGeometry(kit.THREE, w, h, d, r, crown, axis, both, mid, k);
    if (warp) bend(kit.THREE, c, warp.fn);
    return c;
  });
  return place(kit, g, geo, mat, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
}

/**
 * Deform a geometry in place by fn (see cushion). Normals follow the deformation through its
 * inverse transpose, estimated by central differences, so bent parts stay smoothly shaded.
 */
export function bend(T, geo, fn) {
  const pos = geo.attributes.position, nor = geo.attributes.normal, e = 1e-4;
  const p = new T.Vector3(), a = new T.Vector3(), b = new T.Vector3(), n = new T.Vector3();
  const cols = [new T.Vector3(), new T.Vector3(), new T.Vector3()], J = new T.Matrix3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    for (let j = 0; j < 3; j++) {
      a.copy(p).setComponent(j, p.getComponent(j) + e);
      b.copy(p).setComponent(j, p.getComponent(j) - e);
      fn(a);
      fn(b);
      cols[j].subVectors(a, b).divideScalar(2 * e);
    }
    J.set(cols[0].x, cols[1].x, cols[2].x, cols[0].y, cols[1].y, cols[2].y, cols[0].z, cols[1].z, cols[2].z);
    if (nor && Math.abs(J.determinant()) > 1e-9) {
      J.invert().transpose();
      n.fromBufferAttribute(nor, i).applyMatrix3(J).normalize();
      nor.setXYZ(i, n.x, n.y, n.z);
    }
    fn(p);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  pos.needsUpdate = true;
  if (nor) nor.needsUpdate = true;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Lathe-turned part standing at (x, y0, z): profile is [[radius, height], ...] from the bottom
 * up. UVs run around the widest circumference and along the profile, in meters.
 */
export function turned(kit, g, mat, profile, x, y0, z, { segments = 32 } = {}) {
  const T = kit.THREE;
  const key = `t|${segments}|${profile.map(([r, y]) => `${q4(r)},${q4(y)}`).join(';')}`;
  const geo = shape(key, () => {
    const lathe = new T.LatheGeometry(profile.map(([r, y]) => new T.Vector2(Math.max(0, r), y)), segments);
    const along = [0];
    for (let j = 1; j < profile.length; j++) along.push(along[j - 1] + Math.hypot(profile[j][0] - profile[j - 1][0], profile[j][1] - profile[j - 1][1]));
    const around = 2 * Math.PI * Math.max(...profile.map(([r]) => r));
    const uv = lathe.attributes.uv, n = profile.length;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * around, along[i % n]);
    lathe.computeBoundingSphere();
    return lathe;
  });
  return place(kit, g, geo, mat, x, y0, z);
}

/**
 * Slab from y0 to y1 over a rectangle with plan corners rounded to `corner` and every edge eased
 * by `edge` (a radius of the whole rectangle's half width makes it round). UVs in meters.
 */
export function slabTop(kit, g, mat, x0, x1, y0, y1, z0, z1, { corner = 0.05, edge = 0.004 } = {}) {
  const T = kit.THREE;
  const w = x1 - x0, d = z1 - z0, t = y1 - y0;
  const e = Math.min(edge, t / 3, w / 4, d / 4);
  const geo = shape(`s|${q4(w)}|${q4(d)}|${q4(t)}|${q4(corner)}|${q4(e)}`, () => {
    const hw = w / 2 - e, hd = d / 2 - e, rc = Math.max(0.001, Math.min(corner - e, hw, hd));
    const s = new T.Shape();
    s.moveTo(-hw + rc, -hd);
    s.lineTo(hw - rc, -hd);
    s.absarc(hw - rc, -hd + rc, rc, -Math.PI / 2, 0, false);
    s.lineTo(hw, hd - rc);
    s.absarc(hw - rc, hd - rc, rc, 0, Math.PI / 2, false);
    s.lineTo(-hw + rc, hd);
    s.absarc(-hw + rc, hd - rc, rc, Math.PI / 2, Math.PI, false);
    s.lineTo(-hw, -hd + rc);
    s.absarc(-hw + rc, -hd + rc, rc, Math.PI, 1.5 * Math.PI, false);
    const geo = new T.ExtrudeGeometry(s, {
      depth: Math.max(0.0005, t - 2 * e), bevelEnabled: e > 0.0005, bevelThickness: e, bevelSize: e, bevelSegments: 2,
      curveSegments: clamp(Math.round(rc * 120), 4, 24),
    });
    // Extruded along +z from the shape in xy: lay it flat (shape y becomes depth toward -z).
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, e - t / 2, 0);
    geo.computeBoundingSphere();
    return geo;
  });
  return place(kit, g, geo, mat, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
}

/** Tube of radius r through the points ([x, y, z]), for bent frames, spouts and cords; closed loops back. */
export function bent(kit, g, mat, points, r, { segments = 24, radial = 10, closed = false } = {}) {
  const T = kit.THREE;
  const curve = new T.CatmullRomCurve3(points.map((p) => new T.Vector3(...p)), closed, 'centripetal');
  const geo = new T.TubeGeometry(curve, segments, r, radial, closed);
  const uv = geo.attributes.uv, len = curve.getLength();
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len, uv.getY(i) * 2 * Math.PI * r);
  return place(kit, g, geo, mat, 0, 0, 0);
}

/**
 * Leaves as one mesh: each is a folded, two-sided oval of `size` meters set at pose(i) =
 * { x, y, z, yaw, pitch, roll, size, width?, droop?, base? } (width and droop scale the outline and
 * the tip's fall, base widens the stalk end; narrow, stiff blades make grasses and sansevieria).
 */
export function leaves(kit, g, mat, count, pose) {
  const T = kit.THREE;
  // Midrib stations and half widths of the outline, for a unit leaf along +z.
  const S = [0, 0.3, 0.68, 1], W = [0, 0.4, 0.33, 0];
  const pos = [], index = [];
  const m = new T.Matrix4(), e = new T.Euler(), v = new T.Vector3();
  for (let i = 0; i < count; i++) {
    const p = pose(i);
    if (!p) continue;
    const L = p.size, fold = 0.12 * L, droop = (p.droop ?? 0.18) * L, wide = p.width ?? 0.62, base = p.base ?? W[0];
    const half = (j) => (j ? W[j] : base) * L * wide;
    m.makeRotationFromEuler(e.set(p.pitch || 0, p.yaw || 0, p.roll || 0, 'YXZ')).setPosition(p.x, p.y, p.z);
    // Vertices: midrib 0..3, left 4..6 and right 7..9 at the first three stations; once per side,
    // so each side shades smoothly across the folded midrib.
    for (let side = 0; side < 2; side++) {
      const o = pos.length / 3;
      for (let j = 0; j < 4; j++) pos.push(...v.set(0, fold - droop * S[j] * S[j], S[j] * L).applyMatrix4(m).toArray());
      for (const sx of [-1, 1]) for (let j = 0; j < 3; j++) pos.push(...v.set(sx * half(j), -droop * S[j] * S[j], S[j] * L).applyMatrix4(m).toArray());
      const tris = [[0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 6], [0, 7, 8], [0, 8, 1], [1, 8, 9], [1, 9, 2], [2, 9, 3]];
      for (const [a, b, c] of tris) index.push(o + a, o + (side ? c : b), o + (side ? b : c));
    }
  }
  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new T.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return place(kit, g, geo, mat, 0, 0, 0);
}

const ASSEMBLIES = new WeakMap();

/**
 * Parts built by make(group) and merged into one mesh per material, cached per kit under `key`
 * (null: not cached, for one-off parts such as a shelf of random bottles).
 * Returns a new group at the origin (shared geometry), so many small parts, or many copies of a
 * part such as the chairs around a table, cost a few meshes.
 */
export function assembly(kit, key, make) {
  const T = kit.THREE;
  let cache = ASSEMBLIES.get(kit);
  if (!cache) ASSEMBLIES.set(kit, (cache = new Map()));
  let parts = key === null ? null : cache.get(key);
  if (!parts) {
    const root = new T.Group();
    make(root);
    root.updateMatrixWorld(true);
    const byMat = new Map();
    root.traverse((o) => {
      if (!o.isMesh) return;
      if (!byMat.has(o.material)) byMat.set(o.material, []);
      byMat.get(o.material).push(o);
    });
    parts = [...byMat].map(([material, meshes]) => ({ material, geometry: bake(T, meshes), cast: meshes.some((o) => o.castShadow) }));
    if (key !== null) {
      if (cache.size > 200) cache.delete(cache.keys().next().value);
      cache.set(key, parts);
    }
  }
  const out = new T.Group();
  for (const p of parts) {
    const mesh = new T.Mesh(p.geometry, p.material);
    mesh.castShadow = p.cast;
    mesh.receiveShadow = true;
    out.add(mesh);
  }
  return out;
}

/** One indexed geometry from meshes (in their parents' common root frame), positions, normals and UVs. */
function bake(T, meshes) {
  let nv = 0, ni = 0;
  for (const o of meshes) {
    const pos = o.geometry.attributes.position;
    nv += pos.count;
    ni += o.geometry.index ? o.geometry.index.count : pos.count;
  }
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), U = new Float32Array(nv * 2);
  const I = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  const nm = new T.Matrix3(), v = new T.Vector3();
  let base = 0, k = 0;
  for (const o of meshes) {
    const g = o.geometry, pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv, idx = g.index;
    nm.getNormalMatrix(o.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      const j = base + i;
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      P[j * 3] = v.x; P[j * 3 + 1] = v.y; P[j * 3 + 2] = v.z;
      if (nor) {
        v.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
        N[j * 3] = v.x; N[j * 3 + 1] = v.y; N[j * 3 + 2] = v.z;
      }
      if (uv) {
        U[j * 2] = uv.getX(i);
        U[j * 2 + 1] = uv.getY(i);
      }
    }
    const flip = o.matrixWorld.determinant() < 0, count = idx ? idx.count : pos.count;
    for (let t = 0; t + 2 < count; t += 3) {
      const a = idx ? idx.getX(t) : t, b = idx ? idx.getX(t + 1) : t + 1, c = idx ? idx.getX(t + 2) : t + 2;
      I[k++] = base + a;
      I[k++] = base + (flip ? c : b);
      I[k++] = base + (flip ? b : c);
    }
    base += pos.count;
  }
  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.BufferAttribute(P, 3));
  geo.setAttribute('normal', new T.BufferAttribute(N, 3));
  geo.setAttribute('uv', new T.BufferAttribute(U, 2));
  geo.setIndex(new T.BufferAttribute(I, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** Arched bar pull of length len standing `reach` off the face at z (s = -1 faces -z). */
export function barPull(kit, g, mat, x, y, z, len, { vertical = false, reach = 0.026, r = 0.0055, s = 1 } = {}) {
  const at = (t, out) => (vertical ? [x, y + t * len / 2, z + s * out] : [x + t * len / 2, y, z + s * out]);
  return bent(kit, g, mat, [at(-1, -0.003), at(-0.97, reach * 0.8), at(0, reach), at(0.97, reach * 0.8), at(1, -0.003)], r, { segments: 18, radial: 8 });
}

/** Round upholstered seat of radius R and height h on y0, its rim rounded and its top crowned. */
export function roundSeat(kit, g, mat, R, h, x, y0, z, { crown = 0.012, rim = 0.022 } = {}) {
  const rr = Math.min(rim, h * 0.45, R * 0.3);
  const arc = [0, 30, 60, 90].map((deg) => [R - rr + rr * Math.cos((deg * Math.PI) / 180), h - rr + rr * Math.sin((deg * Math.PI) / 180)]);
  return turned(kit, g, mat, [[0, 0], [R - rr * 0.6, 0], [R - rr * 0.1, rr * 0.25], [R, rr * 0.7], ...arc, [R * 0.55, h + crown * 0.8], [0, h + crown]], x, y0, z, { segments: 36 });
}

/** A warp for cushion() written in the caller's frame: fn sees points offset by the part's center. */
export function warpAt(key, cx, cy, cz, fn) {
  return {
    key: `${key}@${q4(cx)},${q4(cy)},${q4(cz)}`,
    fn(v) {
      v.x += cx; v.y += cy; v.z += cz;
      fn(v);
      v.x -= cx; v.y -= cy; v.z -= cz;
    },
  };
}

export const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// ---- Shared seating -----------------------------------------------------------------

const CHAIR_SEAT = 0.475; // seat height at the front of the cushion crown

/**
 * Office swivel chair at (x, z) facing local +z turned by yaw. A five-star base with tapered,
 * sloping legs on hooded twin-wheel casters (or glides), a gas lift, a contoured seat with a
 * waterfall front over a molded shell, and a back bowed around the sitter with a lumbar curve:
 * upholstered on a shell, or (mesh) a dark mesh in a molded frame. arms adds T arms (loop arms on
 * glides). Merged into one assembly per variant, so a table of twelve stays light.
 */
export function officeChair(kit, g, x, z, yaw, { fabric = kit.mat.fabricCharcoal, back = 0.47, casters = true, base = kit.mat.black, arms = true, mesh = false } = {}) {
  const black = kit.mat.black, rubber = kit.mat.rubber, chrome = kit.mat.chrome;
  const key = `office-chair|${fabric.uuid}|${base.uuid}|${back}|${casters}|${arms}|${mesh}`;
  const c = assembly(kit, key, (a) => {
    const legY = casters ? 0.066 : 0.018, reach = 0.29;
    // Base: turned hub, five legs that taper and slope toward the casters.
    turned(kit, a, base, [[0, 0], [0.05, 0], [0.055, 0.008], [0.052, 0.036], [0.038, 0.056], [0, 0.056]], 0, legY - 0.004, 0, { segments: 15 });
    const legWarp = warpAt('chair-leg', 0.16, 0, 0, (v) => {
      const t = clamp((v.x - 0.03) / (reach - 0.03), 0, 1);
      v.z *= 1 - 0.3 * t;
      v.y = v.y * (1 - 0.28 * t) - 0.02 * t;
    });
    for (let i = 0; i < 5; i++) {
      const leg = sub(kit, a, 0, 0, 0, { yaw: (i * Math.PI * 2) / 5 + Math.PI / 2 });
      cushion(kit, sub(kit, leg, 0.16, legY + 0.024, 0), base, -0.13, reach - 0.16, -0.017, 0.017, -0.021, 0.021, { r: 0.009, warp: legWarp, mid: [1, 1, 1], k: 1 });
      if (casters) {
        kit.block(leg, black, reach - 0.024, reach + 0.022, 0.034, 0.062, -0.019, 0.019, true, { bevel: 0.008 });
        for (const s of [-1, 1]) kit.cyl(leg, rubber, 0.026, 0.012, reach - 0.002, 0.026, s * 0.011, { axis: 'z', segments: 10 });
      } else {
        turned(kit, leg, rubber, [[0, 0], [0.02, 0], [0.013, 0.016], [0, 0.016]], reach - 0.004, 0, 0, { segments: 10 });
      }
    }
    // Gas lift: a black shroud and the chrome piston up to the tilt mechanism.
    turned(kit, a, black, [[0.031, 0], [0.031, 0.17], [0.028, 0.185], [0.016, 0.188], [0, 0.188]], 0, legY + 0.05, 0, { segments: 18 });
    kit.cyl(a, chrome, 0.0145, 0.36 - legY - 0.22, 0, legY + 0.22, 0, { segments: 14 });
    kit.block(a, black, -0.1, 0.1, 0.355, 0.398, -0.13, 0.1);
    kit.cyl(a, black, 0.02, 0.028, 0, 0.372, 0.1, { axis: 'z', segments: 12, bevel: false });
    bent(kit, a, black, [[0.09, 0.37, 0.03], [0.17, 0.362, 0.04], [0.215, 0.352, 0.07]], 0.006, { segments: 6, radial: 6 });
    // Seat: shell and cushion share one contour, saddled at the sides and rolled down at the front.
    const seatContour = (v) => {
      const t = smooth01((v.z - 0.06) / 0.18);
      v.y += 0.007 * (v.x / 0.25) ** 4 - 0.03 * t * t;
      v.z -= 0.012 * t * t;
      v.x *= 1 - 0.05 * clamp(-v.z / 0.24, 0, 1);
    };
    cushion(kit, a, black, -0.238, 0.238, 0.392, 0.414, -0.23, 0.22, { r: 0.009, warp: warpAt('chair-seat', 0, 0.403, -0.005, seatContour), mid: [3, 1, 3], k: 1 });
    cushion(kit, a, fabric, -0.25, 0.25, 0.408, CHAIR_SEAT - 0.012, -0.238, 0.238, { r: 0.032, crown: 0.012, warp: warpAt('chair-seat', 0, 0.4355, 0, seatContour), mid: [3, 1, 3] });
    // Back: a spine from the mechanism, then the back itself, reclined a little.
    const spineTop = mesh ? [0, 0.545, -0.243] : [0, 0.6, -0.279];
    bent(kit, a, black, [[0, 0.38, -0.1], [0, 0.385, -0.21], [0, 0.45, -0.262], spineTop], 0.017, { segments: 8, radial: 8 });
    const bk = sub(kit, a, 0, 0.53, -0.235, { pitch: -0.08 });
    // Tapered toward the top with its corners rounded in elevation, bowed around the sitter,
    // pushed forward at the lumbar and leaning back toward the shoulders.
    const backContour = (v) => {
      const u = clamp(v.y / back, 0, 1), ux = clamp(v.x / 0.24, -1, 1), uy = 2 * u - 1;
      const top = uy > 0 ? uy : 0, low = uy < 0 ? -uy : 0;
      v.x *= 1 - 0.07 * u * u - 0.1 * top ** 6 - 0.04 * low ** 6;
      v.y += (-0.035 * top * top + 0.012 * low * low) * ux ** 6;
      v.z += (v.x * v.x) / (2 * 0.62) + 0.024 * Math.exp(-(((v.y - 0.13) / 0.1) ** 2)) - 0.03 * u * u;
    };
    if (mesh) {
      // Molded frame around a taut mesh panel.
      cushion(kit, bk, fabric, -0.226, 0.226, 0.012, back - 0.012, -0.004, 0.004, { r: 0.003, warp: warpAt(`chair-mesh-${back}`, 0, back / 2, 0, backContour), mid: [4, 4, 1], k: 1 });
      const ring = [];
      for (let i = 0; i < 20; i++) {
        const t = (i / 20) * Math.PI * 2, cx = Math.cos(t), cy = Math.sin(t);
        const v = new kit.THREE.Vector3(0.232 * Math.sign(cx) * Math.abs(cx) ** 0.25, back / 2 + (back / 2 - 0.006) * Math.sign(cy) * Math.abs(cy) ** 0.25, 0);
        backContour(v);
        ring.push([v.x, v.y, v.z]);
      }
      bent(kit, bk, black, ring, 0.011, { segments: 32, radial: 6, closed: true });
    } else {
      cushion(kit, bk, black, -0.238, 0.238, -0.004, back + 0.004, -0.04, -0.018, { r: 0.009, warp: warpAt(`chair-shell-${back}`, 0, back / 2, -0.029, backContour), mid: [4, 4, 1], k: 1 });
      cushion(kit, bk, fabric, -0.228, 0.228, 0.006, back - 0.006, -0.024, 0.036, { r: 0.026, crown: 0.012, axis: 'z', warp: warpAt(`chair-back-${back}`, 0, back / 2, 0.006, backContour), mid: [4, 4, 1] });
    }
    if (!arms) return;
    for (const s of [-1, 1]) {
      if (casters) {
        // T arm: a bracket under the seat, an upright and a soft pad.
        bent(kit, a, black, [[s * 0.07, 0.386, -0.05], [s * 0.2, 0.386, -0.055], [s * 0.268, 0.41, -0.06]], 0.012, { segments: 6, radial: 6 });
        kit.block(a, black, s * 0.268 - 0.013, s * 0.268 + 0.013, 0.405, 0.64, -0.082, -0.04);
        cushion(kit, a, black, s * 0.268 - 0.032, s * 0.268 + 0.032, 0.635, 0.664, -0.165, 0.09, { r: 0.013 });
      } else {
        // Loop arm in polished metal from the seat back up, forward and down to the seat front.
        bent(kit, a, base, [[s * 0.215, 0.41, -0.17], [s * 0.255, 0.55, -0.19], [s * 0.262, 0.64, -0.1], [s * 0.262, 0.645, 0.06], [s * 0.255, 0.55, 0.13], [s * 0.225, 0.42, 0.15]], 0.011, { segments: 16, radial: 6 });
        cushion(kit, a, black, s * 0.262 - 0.022, s * 0.262 + 0.022, 0.643, 0.662, -0.11, 0.06, { r: 0.009 });
      }
    }
  });
  c.position.set(x, 0, z);
  c.rotation.y = yaw;
  g.add(c);
  return c;
}

/**
 * Item definitions whose every surface receives shadows. Thin overlays (labels, reveals, tape,
 * screens) are built with shadows off so they cast none, but a surface that skips receiving them
 * stays sunlit inside a shaded room and glows.
 */
export function shaded(defs) {
  return defs.map((def) => ({
    ...def,
    build(kit, o) {
      const obj = def.build(kit, o);
      obj?.traverse?.((m) => {
        if (m.isMesh) m.receiveShadow = true;
      });
      return obj;
    },
  }));
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

/** Stainless wire pull on the front face (z = 0). */
function pull(kit, g, mat, x, y, vertical, len) {
  barPull(kit, g, mat, x, y, 0, len, { vertical, reach: 0.015, r: 0.0045 });
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
/** Gooseneck faucet at (x, y, z) arcing `reach` toward its local +x, turned by yaw, with wrist blades. */
function gooseneck(kit, g, mat, x, y, z, rise, reach, yaw) {
  const f = sub(kit, g, x, y, z, { yaw });
  const r = reach / 2, t = 0.011;
  turned(kit, f, mat, [[0, 0], [0.027, 0], [0.027, 0.012], [0.02, 0.024], [0.013, 0.03], [0, 0.03]], 0, 0, 0, { segments: 20 });
  const pts = [[0, 0.02, 0], [0, rise * 0.6, 0]];
  for (let i = 0; i <= 8; i++) {
    const a = Math.PI * (1 - i / 8);
    pts.push([r + r * Math.cos(a), rise + r * Math.sin(a), 0]);
  }
  pts.push([reach, rise - 0.035, 0]);
  bent(kit, f, mat, pts, t, { segments: 40, radial: 10 });
  kit.cyl(f, mat, t * 1.35, 0.03, reach, rise - 0.05, 0, { segments: 12 });
  for (const s of [-1, 1]) {
    kit.cyl(f, mat, 0.015, 0.05, 0, 0, s * 0.07, { segments: 14 });
    bent(kit, f, mat, [[0, 0.046, s * 0.07], [0, 0.05, s * 0.11], [0, 0.056, s * 0.16]], 0.0055, { segments: 6, radial: 8 });
  }
  return f;
}

const span = (a, b) => (a < b ? [a, b] : [b, a]);

/** Duplex outlet on a face at z, facing +z (s = 1) or -z (s = -1). */
function outlet(kit, g, m, x, y, z, s = 1) {
  kit.block(g, m.plate, x - 0.037, x + 0.037, y - 0.06, y + 0.06, ...span(z, z + s * 0.005), false, { bevel: 0.0015 });
  for (const dy of [-0.026, 0.026]) {
    kit.block(g, m.slot, x - 0.018, x + 0.018, y + dy - 0.015, y + dy + 0.015, ...span(z + s * 0.005, z + s * 0.0065), false, { bevel: false });
  }
}

/** Reagent bottle profiles (radius and height fractions): round, square shouldered, wide mouth. */
const BOTTLE_SHAPES = [
  [[0, 0], [0.92, 0], [1, 0.04], [1, 0.62], [0.82, 0.74], [0.42, 0.8], [0.42, 0.84]],
  [[0, 0], [0.95, 0], [1, 0.03], [1, 0.7], [0.6, 0.78], [0.45, 0.8], [0.45, 0.84]],
  [[0, 0], [0.94, 0], [1, 0.03], [1, 0.76], [0.84, 0.8], [0.84, 0.84]],
];

/** A row of reagent bottles centered on x, standing on y, merged into a mesh per color. */
function bottles(kit, g, m, rnd, x, y, z, count, maxH) {
  const specs = Array.from({ length: count }, () => ({
    r: 0.024 + rnd() * 0.02,
    h: Math.min(maxH, 0.1 + rnd() * 0.14),
    body: pick(rnd, m.liquids),
    cap: pick(rnd, m.caps),
    shape: pick(rnd, BOTTLE_SHAPES),
    dz: (rnd() - 0.5) * 0.03,
  }));
  const width = specs.reduce((s, b) => s + 2 * b.r + 0.01, -0.01);
  g.add(assembly(kit, null, (a) => {
    let px = x - width / 2;
    for (const b of specs) {
      px += b.r;
      const top = b.h * b.shape[b.shape.length - 1][1], neck = b.r * b.shape[b.shape.length - 1][0];
      turned(kit, a, b.body, [...b.shape.map(([u, v]) => [u * b.r, v * b.h]), [0, top]], px, y, z + b.dz, { segments: 14 });
      kit.cyl(a, b.cap, neck * 1.08, b.h - top, px, y + top, z + b.dz, { segments: 12 });
      px += b.r + 0.01;
    }
  }));
}

/** Standing binders from x0 toward x1 on a shelf at y, backed against z0, with spine labels. */
function binders(kit, g, rnd, x0, x1, y, z0, depth, maxH) {
  const label = kit.material('#efeee9', { roughness: 0.8 });
  g.add(assembly(kit, null, (a) => {
    let x = x0;
    while (x < x1 - 0.05) {
      const t = 0.04 + rnd() * 0.03;
      const h = Math.min(maxH, 0.24 + rnd() * 0.06);
      kit.block(a, kit.material(pick(rnd, BINDERS), { roughness: 0.55 }), x, x + t, y, y + h, z0, z0 + depth);
      kit.block(a, label, x + 0.008, x + t - 0.008, y + h * 0.55, y + h * 0.8, z0 + depth, z0 + depth + 0.001, false, { bevel: false });
      x += t + 0.004;
    }
  }));
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

/** Benchtop centrifuge: molded housing, domed lid with a viewing window, sloped control panel. */
function benchCentrifuge(kit, g, m, x, y, z) {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) kit.cyl(g, m.rubber, 0.014, 0.008, x + sx * 0.16, y, z + sz * 0.17, { segments: 10 });
  cushion(kit, g, m.white, x - 0.2, x + 0.2, y + 0.008, y + 0.24, z - 0.22, z + 0.2, { r: 0.028 });
  cushion(kit, g, m.trim, x - 0.19, x + 0.19, y + 0.235, y + 0.272, z - 0.21, z + 0.1, { r: 0.018, crown: 0.012 });
  turned(kit, g, kit.material('#1d2326', { roughness: 0.05 }), [[0, 0], [0.11, 0], [0.105, 0.004], [0, 0.006]], x, y + 0.278, z - 0.055, { segments: 32 });
  const panel = sub(kit, g, x, y + 0.13, z + 0.155, { pitch: -0.5 });
  kit.block(panel, m.trim, -0.19, 0.19, -0.02, 0.11, -0.03, 0.02);
  display(kit, panel, m, -0.12, 0.04, 0.02, 0.08, 0.02);
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
  barPull(kit, g, m.alu, 0, sash + 0.022, fz - 0.03, ix1 - ix0 - 0.3, { reach: 0.03, r: 0.009 });
  kit.block(g, kit.glass, ix0 + 0.03, ix1 - 0.03, sash + 0.05, sashTop + 0.02, fz - 0.05, fz - 0.044, false);
  display(kit, g, m, ix1 - 0.34, ix1 - 0.12, bodyTop - 0.22, bodyTop - 0.12, fz);
  kit.cyl(g, m.steel, 0.19, 0.03, 0, bodyTop, H.ductZ, { segments: 32 });
  kit.cyl(g, m.steel, H.ductR, h - bodyTop, 0, bodyTop, H.ductZ, { segments: 32 });
  for (const y of [bodyTop + 0.08, h - 0.1]) kit.cyl(g, m.steel, H.ductR + 0.008, 0.025, 0, y, H.ductZ, { segments: 32 });
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
  kit.block(f, tint(kit, kit.mat.plastic, '#3b6178'), -w / 2 + 0.001, w / 2 - 0.001, 0.97, 1.03, 0, 0.004, true, { bevel: false });
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
  turned(kit, g, m.yellow, [[0, 0], [r * 0.45, 0], [r * 0.6, 0.02], [r * 0.95, 0.055], [r, 0.062], [r * 0.95, 0.064], [r * 0.6, 0.035], [0, 0.03]], x, y + 0.08, z, { segments: 32 });
  kit.cyl(g, tint(kit, kit.mat.safetyYellow, null, 0.82), r * 0.88, 0.003, x, y + 0.14, z, { segments: 28, bevel: false });
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
  turned(kit, g, m.yellow, [[S.head, 0], [S.head, 0.012], [0.09, 0.05], [0.05, 0.085], [0.045, 0.09], [0, 0.09]], 0, armY - 0.16, 0, { segments: 32 });
  kit.cyl(g, m.steel, S.head - 0.01, 0.006, 0, armY - 0.166, 0, { segments: 32, bevel: false });
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

/**
 * Bench height lab stool: five-star base on glides, gas lift with a chrome foot ring, and a
 * crowned, wipeable vinyl seat (opts.color tints the vinyl). Merged into a few meshes.
 */
function buildLabStool(kit, { w, d, h, color }) {
  const m = palette(kit, color);
  const seat = tint(kit, kit.mat.vinylBlue, m.custom || '#2f3b3e');
  const reach = Math.min(w, d) / 2 - 0.025;
  const sy = h - 0.09, ringY = h * 0.4;
  return assembly(kit, `lab-stool|${seat.uuid}|${w}|${d}|${h}`, (g) => {
    kit.cyl(g, m.black, 0.048, 0.05, 0, 0.032, 0, { rTop: 0.038, segments: 18 });
    for (let i = 0; i < 5; i++) {
      const leg = sub(kit, g, 0, 0, 0, { yaw: (i * Math.PI * 2) / 5 + Math.PI / 2 });
      const tilt = sub(kit, leg, 0, 0.056, 0, { roll: -0.06 });
      cushion(kit, tilt, m.black, 0.03, reach, -0.014, 0.014, -0.016, 0.016, { r: 0.01 });
      turned(kit, leg, m.rubber, [[0, 0], [0.022, 0], [0.022, 0.012], [0.012, 0.03], [0, 0.03]], reach - 0.014, 0, 0, { segments: 14 });
    }
    kit.cyl(g, m.black, 0.03, ringY - 0.07, 0, 0.07, 0, { segments: 16 });
    kit.cyl(g, m.chrome, 0.022, sy - ringY + 0.02, 0, ringY - 0.02, 0, { segments: 16 });
    kit.cyl(g, m.black, 0.042, 0.03, 0, ringY - 0.015, 0, { segments: 18 });
    kit.torus(g, m.chrome, 0.165, 0.011, 0, ringY, 0);
    for (let i = 0; i < 3; i++) {
      const a = (i * Math.PI * 2) / 3 + Math.PI / 6;
      rod(kit, g, m.chrome, 0.008, [0.04 * Math.cos(a), ringY, 0.04 * Math.sin(a)], [0.16 * Math.cos(a), ringY, 0.16 * Math.sin(a)]);
    }
    kit.cyl(g, m.black, 0.11, 0.025, 0, sy, 0, { segments: 24 });
    bent(kit, g, m.black, [[0.06, sy + 0.008, 0], [0.13, sy + 0.004, 0], [0.17, sy - 0.012, 0]], 0.006, { segments: 6, radial: 8 });
    roundSeat(kit, g, seat, 0.19, 0.06, 0, sy + 0.022, 0, { crown: 0.012, rim: 0.025 });
  });
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
  const bin = tint(kit, kit.mat.plastic, '#86aaa1');
  cushion(kit, g, bin, C.x0 + 0.06, C.x0 + 0.32, 0.24, 0.36, C.z0 + 0.1, C.z1 - 0.12, { r: 0.012 });
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
  const fascia = m.custom ? m.body : tint(kit, m.steel, '#d8dbdc');
  const dark = m.black;
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

registerItems(shaded([
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
]));
