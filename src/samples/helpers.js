// Layout helpers for the sample plans. Samples are written in feet on the plan's y-down axes
// (x east, y south, north up the page). build() converts everything to meters, splits walls
// wherever another wall tees into or crosses them so every junction shares an exact endpoint,
// and returns a plan that has been through normalizePlan.
import { FOOT } from '../geometry.js';
import { createPlan, normalizePlan, uid, WALL_KINDS, OPENING_TYPES } from '../model.js';

/** Default footprint (meters) of every catalog type a sample may place. */
export const ITEM_SIZES = {
  'lab-bench-island': [3.66, 1.52], 'lab-bench-wall': [3.05, 0.76], 'fume-hood': [1.83, 0.91],
  'biosafety-cabinet': [1.52, 0.84], 'ult-freezer': [0.89, 0.94], 'lab-refrigerator': [0.76, 0.81],
  'tall-storage-cabinet': [1.22, 0.61], 'lab-sink': [1.22, 0.76], 'safety-shower': [0.91, 0.91],
  'lab-stool': [0.46, 0.46], 'equipment-cart': [0.91, 0.61], autoclave: [0.91, 0.91],
  'exam-table': [1.83, 0.71], 'exam-casework': [2.13, 0.61], 'physician-stool': [0.51, 0.51],
  'side-chair': [0.56, 0.56], 'reception-desk': [3.05, 0.91], 'waiting-chairs': [2.44, 0.71],
  'nurse-station': [2.44, 0.91], 'hospital-bed': [1.02, 2.24], 'patient-recliner': [0.86, 1.02],
  'ct-scanner': [2.13, 4.27], 'privacy-curtain': [2.44, 0.1], 'supply-cart': [0.61, 0.51],
  workstation: [1.52, 1.37], desk: [1.52, 0.76], 'task-chair': [0.66, 0.66], 'benching-4': [3.05, 2.9],
  'executive-desk': [1.83, 1.83], 'conference-table-6': [3.05, 2.44], 'conference-table-10': [4.88, 2.74],
  'round-table-4': [1.83, 1.83], sofa: [2.13, 0.91], 'lounge-chair': [0.86, 0.86], 'coffee-table': [1.22, 0.61],
  'filing-cabinet': [0.91, 0.51], bookshelf: [0.91, 0.36], 'phone-booth': [1.07, 1.07],
  'pantry-counter': [3.05, 0.66], 'tv-display': [1.83, 0.46],
  column: [0.61, 0.61], plant: [0.61, 0.61], planter: [1.83, 0.46], 'area-rug': [2.44, 1.83],
  printer: [0.66, 0.66], 'trash-recycling': [0.76, 0.41], toilet: [0.51, 0.71], vanity: [1.22, 0.56],
  'gondola-shelving': [2.44, 1.22], 'wall-shelving': [2.44, 0.51], 'checkout-counter': [1.83, 0.91],
  'display-table': [1.52, 0.91], 'clothing-rack': [1.52, 0.61], mannequin: [0.51, 0.41],
  'pallet-racking': [2.74, 1.07], pallet: [1.22, 1.02], forklift: [1.22, 2.44], workbench: [1.83, 0.76],
  bollard: [0.2, 0.2], 'floor-zone': [2.44, 2.44],
};

const TOL = 0.01;
const COMPASS = { n: { x: 0, y: -1 }, s: { x: 0, y: 1 }, e: { x: 1, y: 0 }, w: { x: -1, y: 0 } };
const ROTATION = { s: 0, w: 90, n: 180, e: 270 };
const m = (feet) => feet * FOOT;

function compass(dir) {
  const v = COMPASS[dir];
  if (!v) throw new Error(`Unknown direction "${dir}" (use n, s, e or w)`);
  return v;
}

const halfFt = (wall) => wall.thickness / FOOT / 2;
const isHorizontal = (wall) => Math.abs(wall.b.y - wall.a.y) < TOL;
const isVertical = (wall) => Math.abs(wall.b.x - wall.a.x) < TOL;
const lengthFt = (wall) => Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y);

/** Distance (ft) from wall.a to a position given on the wall's own axis (x or y in feet). */
function along(wall, at) {
  if (isHorizontal(wall)) return Math.abs(at - wall.a.x);
  if (isVertical(wall)) return Math.abs(at - wall.a.y);
  return at;
}

/** +1 or -1: which side of the wall (relative to its plan normal) a compass direction points to. */
function sideToward(wall, dir) {
  const v = compass(dir);
  const L = lengthFt(wall);
  const n = { x: -(wall.b.y - wall.a.y) / L, y: (wall.b.x - wall.a.x) / L };
  const s = n.x * v.x + n.y * v.y;
  if (Math.abs(s) < 1e-6) throw new Error(`Direction "${dir}" runs along the wall`);
  return s > 0 ? 1 : -1;
}

/** 'start' when the hinge direction points toward wall.a, else 'end'. */
function hingeToward(wall, dir) {
  const v = compass(dir);
  const s = (wall.b.x - wall.a.x) * v.x + (wall.b.y - wall.a.y) * v.y;
  if (Math.abs(s) < 1e-6) throw new Error(`Hinge direction "${dir}" crosses the wall`);
  return s < 0 ? 'start' : 'end';
}

/** Item footprint in feet: instance overrides first, then the catalog default. */
function footprint(type, opts = {}) {
  const size = ITEM_SIZES[type];
  return { w: opts.w ?? size[0] / FOOT, d: opts.d ?? size[1] / FOOT };
}

export class Layout {
  /** All lengths in feet. wallHeight is the default ceiling height. */
  constructor({ name, wallHeight = 9.5, ceiling = 'tile', exterior = 'city' }) {
    this.meta = { name, settings: { wallHeight: m(wallHeight), ceiling, exterior } };
    this.walls = [];
    this.openings = [];
    this.rooms = [];
    this.items = [];
    this.cameras = [];
    this.underlay = null;
  }

  /** Straight wall from a to b ([x, y] in feet). kind: exterior, interior, glass or partial. */
  wall(a, b, kind = 'interior', { height, thickness } = {}) {
    const k = WALL_KINDS[kind];
    if (!k) throw new Error(`Unknown wall kind "${kind}"`);
    const wall = {
      a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] }, kind,
      thickness: thickness !== undefined ? m(thickness) : k.thickness,
      height: height !== undefined ? m(height) : k.height,
    };
    this.walls.push(wall);
    return wall;
  }

  /** Walls along a polyline; closed joins the last point back to the first. */
  chain(points, kind = 'interior', { closed = false, height, thickness } = {}) {
    const out = [];
    const n = closed ? points.length : points.length - 1;
    for (let i = 0; i < n; i++) out.push(this.wall(points[i], points[(i + 1) % points.length], kind, { height, thickness }));
    return out;
  }

  /** Four walls around a rectangle, drawn clockwise. Returns { n, e, s, w }. */
  rect(x0, y0, x1, y1, kind = 'interior', opts = {}) {
    const [nw, ne, se, sw] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const [n, e, s, w] = this.chain([nw, ne, se, sw], kind, { ...opts, closed: true });
    return { n, e, s, w };
  }

  /** Coordinate (ft) of a wall face: the face on the `toward` side of a straight N-S or E-W wall. */
  face(wall, toward) {
    const v = compass(toward);
    const h = halfFt(wall);
    if (isHorizontal(wall) && v.y) return wall.a.y + v.y * h;
    if (isVertical(wall) && v.x) return wall.a.x + v.x * h;
    throw new Error('face() needs an axis-aligned wall and a direction across it');
  }

  /**
   * Door or other opening centered at `at` (the x of a horizontal wall, the y of a vertical one).
   * swing: compass direction the leaf opens toward; hinge: compass end of the opening it hangs on.
   */
  door(wall, at, { type = 'door', width, height, swing, hinge, sill } = {}) {
    const t = OPENING_TYPES[type];
    if (!t) throw new Error(`Unknown opening type "${type}"`);
    const opening = {
      wall, offset: along(wall, at), type,
      width: width !== undefined ? m(width) : t.width,
      height: height !== undefined ? m(height) : t.height,
      sill: sill !== undefined ? m(sill) : t.sill,
      side: swing ? sideToward(wall, swing) : 1,
      hinge: hinge ? hingeToward(wall, hinge) : 'start',
    };
    this.openings.push(opening);
    return opening;
  }

  /** Cased opening (no leaf). */
  opening(wall, at, { width = 4, height } = {}) {
    return this.door(wall, at, { type: 'opening', width, height });
  }

  window(wall, at, { width = 5, height = 5, sill = 3 } = {}) {
    return this.door(wall, at, { type: 'window', width, height, sill });
  }

  /** Evenly spaced windows between two axis positions, at least `gap` feet of wall between them. */
  windows(wall, from, to, { width = 5, height = 5, sill = 3, gap = 1.5, count } = {}) {
    const span = Math.abs(to - from);
    const n = count ?? Math.max(1, Math.floor((span + gap) / (width + gap)));
    const lo = Math.min(from, to);
    const out = [];
    for (let i = 0; i < n; i++) out.push(this.window(wall, lo + ((i + 0.5) * span) / n, { width, height, sill }));
    return out;
  }

  /** Rectangular room [x0, y0, x1, y1] on wall centerlines. */
  room(name, [x0, y0, x1, y1], floor, opts = {}) {
    return this.polygonRoom(name, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], floor, opts);
  }

  polygonRoom(name, points, floor, { ceiling, height } = {}) {
    const room = { name, points: points.map(([x, y]) => ({ x, y })), floor, ceiling };
    if (height) room.height = height;
    this.rooms.push(room);
    return room;
  }

  /** Item centered at (x, y). rotation: degrees clockwise, or the compass direction its front faces. */
  item(type, x, y, rotation = 0, { w, d, h, elevation, color, label } = {}) {
    if (!ITEM_SIZES[type]) throw new Error(`Unknown item type "${type}"`);
    const rot = typeof rotation === 'string' ? ROTATION[rotation] : rotation;
    if (rot === undefined) throw new Error(`Unknown facing "${rotation}"`);
    const item = { type, x, y, rotation: rot };
    if (w !== undefined) item.w = w;
    if (d !== undefined) item.d = d;
    if (h !== undefined) item.h = h;
    if (elevation !== undefined) item.elevation = elevation;
    if (color) item.color = color;
    if (label) item.label = label;
    this.items.push(item);
    return item;
  }

  /**
   * Item with its back against a wall face, centered at `at` along the wall and facing `toward`.
   * gap leaves room between the wall and the item's back.
   */
  against(wall, at, type, toward, { gap = 0, ...opts } = {}) {
    const { d } = footprint(type, opts);
    const v = compass(toward);
    const c = this.face(wall, toward) + (v.x + v.y) * (gap + d / 2);
    return isHorizontal(wall) ? this.item(type, at, c, toward, opts) : this.item(type, c, at, toward, opts);
  }

  /** `count` items starting at [x, y], stepping by [dx, dy]. */
  row(type, [x, y], [dx, dy], count, rotation = 0, opts = {}) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(this.item(type, x + dx * i, y + dy * i, rotation, opts));
    return out;
  }

  /** Items along a wall face, one per position in `ats`. */
  alongWall(wall, ats, type, toward, opts = {}) {
    return ats.map((at) => this.against(wall, at, type, toward, opts));
  }

  /** Saved view at eye height. yaw: degrees clockwise from north (up the page). */
  camera(name, x, y, yaw, pitch = 0) {
    const camera = { name, x, y, yaw, pitch };
    this.cameras.push(camera);
    return camera;
  }

  /** Traced image under the plan. scale is feet per image pixel; x, y place its top-left corner. */
  setUnderlay({ src, width, height, scale, x = 0, y = 0, opacity = 0.6 }) {
    this.underlay = { src, width, height, scale, x, y, opacity };
  }

  build() {
    const walls = splitWalls(this.walls);
    const plan = createPlan({
      id: uid('plan'),
      name: this.meta.name,
      units: 'imperial',
      settings: this.meta.settings,
    });
    const P = (p) => ({ x: m(p.x), y: m(p.y) });
    let n = 0;
    const ids = new Map();
    for (const piece of walls) {
      const id = `w${++n}`;
      ids.set(piece, id);
      plan.walls.push({ id, a: P(piece.a), b: P(piece.b), kind: piece.kind, thickness: piece.thickness, height: piece.height ?? plan.settings.wallHeight });
    }
    n = 0;
    for (const o of this.openings) {
      const { piece, offset } = locateOpening(walls, o);
      plan.openings.push({
        id: `o${++n}`, wallId: ids.get(piece), type: o.type, offset: m(offset),
        width: o.width, height: o.height, sill: o.sill, hinge: o.hinge, side: o.side,
      });
    }
    n = 0;
    for (const r of this.rooms) {
      const room = { id: `r${++n}`, name: r.name, points: r.points.map(P), floor: r.floor, ceiling: r.ceiling ?? plan.settings.ceiling };
      if (r.height) room.height = m(r.height);
      plan.rooms.push(room);
    }
    n = 0;
    for (const it of this.items) {
      const item = { id: `i${++n}`, type: it.type, x: m(it.x), y: m(it.y), rotation: it.rotation };
      for (const k of ['w', 'd', 'h', 'elevation']) if (it[k] !== undefined) item[k] = m(it[k]);
      if (it.color) item.color = it.color;
      if (it.label) item.label = it.label;
      plan.items.push(item);
    }
    n = 0;
    for (const c of this.cameras) plan.cameras.push({ id: `c${++n}`, name: c.name, x: m(c.x), y: m(c.y), yaw: c.yaw, pitch: c.pitch });
    if (this.underlay) {
      const u = this.underlay;
      plan.underlay = {
        src: u.src, width: u.width, height: u.height, x: m(u.x), y: m(u.y), scale: m(u.scale),
        rotation: 0, opacity: u.opacity, visible: true, locked: true,
      };
    }
    return normalizePlan(plan);
  }
}

export const createLayout = (opts) => new Layout(opts);

// ---- Wall splitting --------------------------------------------------------

/** Split every wall where another wall ends on it or crosses it. */
function splitWalls(walls) {
  const out = [];
  for (const w of walls) {
    const L = lengthFt(w);
    const ux = (w.b.x - w.a.x) / L, uy = (w.b.y - w.a.y) / L;
    const cuts = [];
    const cut = (p) => {
      const t = (p.x - w.a.x) * ux + (p.y - w.a.y) * uy;
      const off = Math.abs((p.x - w.a.x) * uy - (p.y - w.a.y) * ux);
      if (off < TOL && t > TOL && t < L - TOL && !cuts.some((c) => Math.abs(c - t) < TOL)) cuts.push(t);
    };
    for (const other of walls) {
      if (other === w) continue;
      cut(other.a);
      cut(other.b);
      const hit = crossing(w, other);
      if (hit) cut(hit);
    }
    cuts.sort((p, q) => p - q);
    const stops = [0, ...cuts, L];
    for (let i = 0; i < stops.length - 1; i++) {
      const at = (t) => ({ x: round(w.a.x + ux * t), y: round(w.a.y + uy * t) });
      out.push({ ...w, a: at(stops[i]), b: at(stops[i + 1]), source: w, start: stops[i], end: stops[i + 1] });
    }
  }
  return out;
}

const round = (v) => Math.round(v * 1e6) / 1e6;

/** Point where two walls cross, or null when they are parallel or miss. */
function crossing(p, q) {
  const r = { x: p.b.x - p.a.x, y: p.b.y - p.a.y }, s = { x: q.b.x - q.a.x, y: q.b.y - q.a.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9) return null;
  const d = { x: q.a.x - p.a.x, y: q.a.y - p.a.y };
  const t = (d.x * s.y - d.y * s.x) / den, u = (d.x * r.y - d.y * r.x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p.a.x + r.x * t, y: p.a.y + r.y * t };
}

/** The piece of the split wall that holds an opening, and the opening's offset along that piece. */
function locateOpening(pieces, o) {
  const own = pieces.filter((p) => p.source === o.wall);
  const half = o.width / FOOT / 2;
  const fits = own.find((p) => o.offset - half >= p.start - TOL && o.offset + half <= p.end + TOL);
  const piece = fits || own.find((p) => o.offset >= p.start && o.offset <= p.end) || own[0];
  if (!fits) console.warn(`Sample opening at ${o.offset.toFixed(2)} ft does not fit between wall junctions`);
  return { piece, offset: o.offset - piece.start };
}
