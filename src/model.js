// Floor plan document model, defaults, entity helpers and the undoable PlanStore.
// See docs/architecture.md for the schema and coordinate conventions.
import {
  FOOT, INCH, add, sub, scale, dot, cross, norm, dist, samePoint, clamp, normDeg,
  projectToSegment, wallLength, wallDir, wallNormal,
} from './geometry.js';

export const PLAN_VERSION = 1;
/** Top-level marker written by serializePlan so files can be recognized as plans. */
export const PLAN_FORMAT = 'cbre-walkthrough-plan';

/** Limits normalizePlan applies to untrusted input. */
export const LIMITS = {
  coord: 10000,      // meters from the origin; anything farther is treated as corrupt
  entities: 20000,   // per collection (and per room outline)
  itemSize: 60,      // meters, for item w, d, h and elevation
  pitch: 70,         // degrees up or down, the walkthrough's look limit
};

export const DEFAULTS = {
  wallHeight: 2.9, // ~9' 6" finished ceiling
  doorHeight: 7 * FOOT,
  windowSill: 3 * FOOT,
  eyeHeight: 1.6,
  gridStep: 6 * INCH,
};

export const WALL_KINDS = {
  exterior: { label: 'Exterior wall', thickness: 12 * INCH },
  interior: { label: 'Interior wall', thickness: 5 * INCH },
  glass: { label: 'Glass partition', thickness: 2.5 * INCH },
  partial: { label: 'Half-height wall', thickness: 5 * INCH, height: 42 * INCH },
};

export const OPENING_TYPES = {
  door: { label: 'Door', width: 3 * FOOT, height: 7 * FOOT, sill: 0, passable: true },
  'double-door': { label: 'Double door', width: 6 * FOOT, height: 7 * FOOT, sill: 0, passable: true },
  'sliding-door': { label: 'Sliding door', width: 4 * FOOT, height: 7 * FOOT, sill: 0, passable: true },
  opening: { label: 'Cased opening', width: 4 * FOOT, height: 7 * FOOT, sill: 0, passable: true },
  window: { label: 'Window', width: 5 * FOOT, height: 5 * FOOT, sill: 3 * FOOT, passable: false },
};

/** Floor finishes. color2d tints the plan; the 3D builder owns the real materials. */
export const FLOORS = {
  carpet: { label: 'Carpet tile', color2d: '#e3e6e2' },
  'polished-concrete': { label: 'Polished concrete', color2d: '#e8e6e1' },
  concrete: { label: 'Raw concrete', color2d: '#dcdad5' },
  epoxy: { label: 'Epoxy (lab)', color2d: '#e6ecee' },
  vinyl: { label: 'Luxury vinyl', color2d: '#ece4d8' },
  wood: { label: 'Wood', color2d: '#eadcc6' },
  tile: { label: 'Porcelain tile', color2d: '#ececea' },
  rubber: { label: 'Rubber (clinical)', color2d: '#dfe7e4' },
};

export const CEILINGS = {
  tile: { label: 'Acoustic tile' },
  drywall: { label: 'Drywall' },
  open: { label: 'Open to structure' },
};

export const ENTITY_KINDS = ['wall', 'opening', 'room', 'item', 'camera'];
const COLLECTION = { wall: 'walls', opening: 'openings', room: 'rooms', item: 'items', camera: 'cameras' };
export const collectionOf = (kind) => COLLECTION[kind];

let counter = 0;
/** Short unique id with a readable prefix, e.g. "w-lq3k2a-7". */
export function uid(prefix = 'e') {
  counter = (counter + 1) % 1e6;
  return `${prefix}-${Date.now().toString(36).slice(-6)}-${counter.toString(36)}`;
}

export function createPlan(overrides = {}) {
  return {
    version: PLAN_VERSION,
    id: uid('plan'),
    name: 'Untitled plan',
    units: 'imperial',
    settings: { wallHeight: DEFAULTS.wallHeight, ceiling: 'tile', exterior: 'city' },
    underlay: null,
    walls: [],
    openings: [],
    rooms: [],
    items: [],
    cameras: [],
    ...overrides,
  };
}

/** Deep copy that shares string references (keeps large underlay data URLs cheap to snapshot). */
export function clonePlan(value) {
  if (Array.isArray(value)) return value.map(clonePlan);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = clonePlan(value[k]);
    return out;
  }
  return value;
}

const num = (v, fallback) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : fallback);
const coord = (v) => {
  const n = num(v, NaN);
  return Math.abs(n) <= LIMITS.coord ? n : NaN;
};
/** A plan point, or null when a coordinate is missing, not finite or out of range. */
const toPoint = (p) => {
  const x = coord(Array.isArray(p) ? p[0] : p?.x), y = coord(Array.isArray(p) ? p[1] : p?.y);
  return Number.isNaN(x) || Number.isNaN(y) ? null : { x, y };
};
/** The objects of an untrusted array, capped in length. */
const list = (v) => (Array.isArray(v) ? v.slice(0, LIMITS.entities).filter((e) => e && typeof e === 'object') : []);
const oneOf = (v, table, fallback) => (Object.prototype.hasOwnProperty.call(table, v) ? v : fallback);

/** A default name such as "Room 3" that no entity in the list uses yet. */
export function nextName(entities, prefix) {
  const taken = new Set(entities.map((e) => e.name));
  let n = entities.length + 1;
  while (taken.has(`${prefix} ${n}`)) n++;
  return `${prefix} ${n}`;
}

/**
 * Turn untrusted JSON (a saved file, a sample, older versions) into a valid Plan.
 * Fills defaults, coerces numbers, clamps sizes, drops entities that cannot be repaired (missing,
 * non-finite or far-off coordinates) and de-duplicates ids. Underlays must be data:image URLs.
 */
export function normalizePlan(input) {
  if (!input || typeof input !== 'object') throw new Error('Not a floor plan file.');
  const base = createPlan();
  const seen = new Set();
  const id = (v, prefix) => {
    let s = typeof v === 'string' && v ? v : uid(prefix);
    while (seen.has(s)) s = uid(prefix);
    seen.add(s);
    return s;
  };
  const settings = { ...base.settings, ...(input.settings && typeof input.settings === 'object' ? input.settings : {}) };
  settings.wallHeight = clamp(num(settings.wallHeight, DEFAULTS.wallHeight), 2, 12);
  settings.ceiling = oneOf(settings.ceiling, CEILINGS, 'tile');
  settings.exterior = ['city', 'campus', 'none'].includes(settings.exterior) ? settings.exterior : 'city';

  const walls = list(input.walls).map((w) => {
    const a = toPoint(w.a), b = toPoint(w.b);
    if (!a || !b || dist(a, b) <= 0.01) return null;
    const kind = oneOf(w.kind, WALL_KINDS, 'interior');
    const k = WALL_KINDS[kind];
    return {
      id: id(w.id, 'w'),
      a,
      b,
      kind,
      thickness: clamp(num(w.thickness, k.thickness), 0.02, 1.5),
      height: clamp(num(w.height, k.height ?? settings.wallHeight), 0.3, 12),
    };
  }).filter(Boolean);
  const wallById = new Map(walls.map((w) => [w.id, w]));

  const openings = list(input.openings).map((o) => {
    const wall = wallById.get(o.wallId);
    if (!wall) return null;
    const type = oneOf(o.type, OPENING_TYPES, 'door');
    const t = OPENING_TYPES[type];
    const L = wallLength(wall);
    const width = Math.min(clamp(num(o.width, t.width), 0.2, 20), Math.max(0.2, L));
    return {
      id: id(o.id, 'o'),
      wallId: o.wallId,
      type,
      offset: clamp(num(o.offset, L / 2), width / 2, Math.max(width / 2, L - width / 2)),
      width,
      height: clamp(num(o.height, t.height), 0.2, 12),
      sill: clamp(num(o.sill, t.sill), 0, 6),
      hinge: o.hinge === 'end' ? 'end' : 'start',
      side: num(o.side, 1) < 0 ? -1 : 1,
    };
  }).filter(Boolean);

  const rooms = list(input.rooms).map((r) => {
    const points = Array.isArray(r.points) ? r.points.slice(0, LIMITS.entities).map(toPoint) : [];
    if (points.length < 3 || points.some((q) => !q)) return null;
    return {
      id: id(r.id, 'r'),
      name: typeof r.name === 'string' ? r.name : 'Room',
      points,
      floor: oneOf(r.floor, FLOORS, 'carpet'),
      ceiling: oneOf(r.ceiling, CEILINGS, settings.ceiling),
      ...(Number.isFinite(+r.height) && +r.height > 0 ? { height: clamp(+r.height, 2, 20) } : {}),
    };
  }).filter(Boolean);

  const items = list(input.items).map((i) => {
    const at = toPoint(i);
    if (!at || typeof i.type !== 'string') return null;
    const out = { id: id(i.id, 'i'), type: i.type, x: at.x, y: at.y, rotation: normDeg(num(i.rotation, 0)) };
    for (const k of ['w', 'd', 'h', 'elevation']) {
      const v = num(i[k], 0);
      if (v > 0) out[k] = Math.min(v, LIMITS.itemSize);
    }
    if (typeof i.color === 'string' && /^#(?:[0-9a-f]{3}){1,2}$/i.test(i.color)) out.color = i.color;
    if (typeof i.label === 'string') out.label = i.label;
    // Found in the floor plan image: detecting its walls again replaces it.
    if (i.traced === true) out.traced = true;
    return out;
  }).filter(Boolean);

  const cameras = list(input.cameras).map((c, n) => {
    const at = toPoint(c);
    if (!at) return null;
    return {
      id: id(c.id, 'c'),
      name: typeof c.name === 'string' && c.name ? c.name : `View ${n + 1}`,
      x: at.x,
      y: at.y,
      yaw: normDeg(num(c.yaw, 0)),
      pitch: clamp(num(c.pitch, 0), -LIMITS.pitch, LIMITS.pitch),
    };
  }).filter(Boolean);

  let underlay = null;
  const u = input.underlay;
  const at = u && typeof u.src === 'string' && u.src.startsWith('data:image/') ? toPoint({ x: num(u.x, 0), y: num(u.y, 0) }) : null;
  if (at) {
    underlay = {
      src: u.src,
      width: clamp(num(u.width, 0), 0, 1e5),
      height: clamp(num(u.height, 0), 0, 1e5),
      x: at.x,
      y: at.y,
      scale: num(u.scale, 0.02) > 0 ? num(u.scale, 0.02) : 0.02,
      rotation: num(u.rotation, 0),
      opacity: clamp(num(u.opacity, 0.5), 0, 1),
      visible: u.visible !== false,
      locked: u.locked !== false,
      ...(u.calibrated === true ? { calibrated: true } : {}),
      ...(u.traced === true ? { traced: true } : {}),
    };
  }

  return {
    version: PLAN_VERSION,
    id: typeof input.id === 'string' && input.id ? input.id : base.id,
    name: typeof input.name === 'string' && input.name ? input.name : base.name,
    units: input.units === 'metric' ? 'metric' : 'imperial',
    settings,
    underlay,
    walls,
    openings,
    rooms,
    items,
    cameras,
  };
}

export const serializePlan = (plan) => JSON.stringify({ format: PLAN_FORMAT, ...plan, version: PLAN_VERSION }, null, 2);

// ---- Entity helpers (operate on a draft inside store.update) --------------

export function findEntity(plan, kind, id) {
  const list = plan[COLLECTION[kind]];
  return list ? list.find((e) => e.id === id) || null : null;
}

export function addWall(draft, a, b, props = {}) {
  const kind = oneOf(props.kind, WALL_KINDS, 'interior');
  const k = WALL_KINDS[kind];
  const wall = {
    id: uid('w'),
    a: { ...a },
    b: { ...b },
    kind,
    thickness: props.thickness ?? k.thickness,
    height: props.height ?? k.height ?? draft.settings.wallHeight,
  };
  draft.walls.push(wall);
  return wall;
}

export function addOpening(draft, wallId, type, offset, props = {}) {
  const t = OPENING_TYPES[oneOf(type, OPENING_TYPES, 'door')];
  const opening = {
    id: uid('o'),
    wallId,
    type: oneOf(type, OPENING_TYPES, 'door'),
    offset,
    width: props.width ?? t.width,
    height: props.height ?? t.height,
    sill: props.sill ?? t.sill,
    hinge: props.hinge === 'end' ? 'end' : 'start',
    side: props.side === -1 ? -1 : 1,
  };
  draft.openings.push(opening);
  return opening;
}

export function addRoom(draft, points, props = {}) {
  const room = {
    id: uid('r'),
    name: props.name ?? nextName(draft.rooms, 'Room'),
    points: points.map((p) => ({ x: p.x, y: p.y })),
    floor: oneOf(props.floor, FLOORS, 'carpet'),
    ceiling: oneOf(props.ceiling, CEILINGS, draft.settings.ceiling),
  };
  if (props.height > 0) room.height = props.height;
  draft.rooms.push(room);
  return room;
}

export function addItem(draft, type, x, y, props = {}) {
  const item = { id: uid('i'), type, x, y, rotation: props.rotation ?? 0 };
  for (const k of ['w', 'd', 'h', 'color', 'label']) if (props[k] !== undefined) item[k] = props[k];
  if (props.traced) item.traced = true;
  draft.items.push(item);
  return item;
}

export function addCamera(draft, x, y, yaw = 0, props = {}) {
  const camera = {
    id: uid('c'),
    name: props.name ?? nextName(draft.cameras, 'View'),
    x, y, yaw, pitch: props.pitch ?? 0,
  };
  draft.cameras.push(camera);
  return camera;
}

/** Remove an entity. Removing a wall also removes its openings. Returns true if removed. */
export function removeEntity(draft, kind, id) {
  const key = COLLECTION[kind];
  if (!key) return false;
  const before = draft[key].length;
  draft[key] = draft[key].filter((e) => e.id !== id);
  if (kind === 'wall') draft.openings = draft.openings.filter((o) => o.wallId !== id);
  return draft[key].length !== before;
}

// ---- Wall graph ----------------------------------------------------------------

const JOIN_TOL = 2e-3;
/** Clearance (m) kept between an opening and the face of a wall joined at its wall's end. */
export const OPENING_GAP = 0.05;
/** True if p lies on wall w's span, away from both of its ends (a T-junction). */
const onSpan = (p, w) => !samePoint(p, w.a) && !samePoint(p, w.b) && projectToSegment(p, w.a, w.b).dist < JOIN_TOL;

/** Intersection of the lines p + s*d and q + t*e (unit directions), or null when nearly parallel. */
function meet(p, d, q, e) {
  const c = cross(d, e);
  if (Math.abs(c) < 0.05) return null;
  return add(p, scale(d, cross(sub(q, p), e) / c));
}

/**
 * How other walls join a wall: corners share one of its ends ({id, end, at}), tees end on its
 * span ({id, end}), and hosts are the walls its own ends rest on mid-span ({a, b}: id or null).
 */
export function wallLinks(plan, wallId) {
  const wall = plan.walls.find((w) => w.id === wallId);
  const links = { corners: [], tees: [], hosts: { a: null, b: null } };
  if (!wall) return links;
  for (const w of plan.walls) {
    if (w === wall) continue;
    for (const end of ['a', 'b']) {
      const at = samePoint(w[end], wall.a) ? 'a' : samePoint(w[end], wall.b) ? 'b' : null;
      if (at) links.corners.push({ id: w.id, end, at });
      else if (onSpan(w[end], wall)) links.tees.push({ id: w.id, end });
      if (!links.hosts[end] && onSpan(wall[end], w)) links.hosts[end] = w.id;
    }
  }
  return links;
}

export const isWallJoined = (plan, wallId) => {
  const l = wallLinks(plan, wallId);
  return l.corners.length > 0 || l.tees.length > 0 || !!l.hosts.a || !!l.hosts.b;
};

/** Half the thickness of the thickest wall other than `wall` that meets p, at an end or mid-span. */
function jointHalf(draft, wall, p) {
  let h = 0;
  for (const w of draft.walls) {
    if (w !== wall && projectToSegment(p, w.a, w.b).dist < JOIN_TOL) h = Math.max(h, w.thickness / 2);
  }
  return h;
}

/**
 * Move one end of a wall. Its openings keep their place on the plan, except that one the moving
 * end runs into is carried along, OPENING_GAP clear of the walls joined there, so it never ends
 * up inside a joined partition.
 */
function setEnd(draft, wall, end, p) {
  const L0 = wallLength(wall), old = wall[end];
  wall[end] = { x: p.x, y: p.y };
  const ops = draft.openings.filter((o) => o.wallId === wall.id);
  if (!ops.length) return;
  const L = wallLength(wall), grow = L - L0;
  const h = Math.max(jointHalf(draft, wall, old), jointHalf(draft, wall, p));
  const keep = h > 0 ? h + OPENING_GAP : 0;
  for (const o of ops) {
    // Gap from this end to the opening's nearer edge; it never drops below `keep`, or below
    // what it already was if that is less.
    const gap = end === 'a' ? o.offset - o.width / 2 : L0 - o.offset - o.width / 2;
    const next = Math.max(gap + grow, Math.min(gap, keep));
    o.offset = end === 'a' ? next + o.width / 2 : L - next - o.width / 2;
  }
}

/** Walls ending on `wall` (tees) slide along their own direction to stay on its centerline. */
function followTees(draft, wall, tees) {
  const u = wallDir(wall);
  for (const t of tees) {
    const w = draft.walls.find((x) => x.id === t.id);
    if (!w) continue;
    const hit = meet(w[t.end === 'a' ? 'b' : 'a'], wallDir(w), wall.a, u);
    if (hit) setEnd(draft, w, t.end, hit);
  }
}

const copyWalls = (walls) => walls.map((w) => ({ ...w, a: { ...w.a }, b: { ...w.b } }));

/**
 * Move one endpoint of a wall. With connected=true, walls that shared the old position move too
 * (corners stay joined), walls ending on this wall's span stay on it, and room outlines along the
 * moved walls follow. Openings keep their place unless the moving end reaches them (see setEnd).
 */
export function moveWallEndpoint(draft, wallId, end, p, { connected = true } = {}) {
  const wall = draft.walls.find((w) => w.id === wallId);
  if (!wall) return;
  const links = connected ? wallLinks(draft, wallId) : null;
  const before = connected ? copyWalls(draft.walls) : null;
  setEnd(draft, wall, end, p);
  if (connected) {
    for (const c of links.corners) {
      const w = draft.walls.find((x) => x.id === c.id);
      if (w && c.at === end) setEnd(draft, w, c.end, p);
    }
    followTees(draft, wall, links.tees);
    followRooms(draft, before);
  }
  clampOpenings(draft);
}

/**
 * Translate a wall by (dx, dy). With connected=true, joined walls follow: corners move with its
 * ends, its ends slide along walls they rest on, walls ending on it stay on it, and room outlines
 * along the moved walls follow.
 */
export function moveWall(draft, wallId, dx, dy, { connected = true } = {}) {
  const wall = draft.walls.find((w) => w.id === wallId);
  if (!wall) return;
  const links = connected ? wallLinks(draft, wallId) : null;
  const before = connected ? copyWalls(draft.walls) : null;
  wall.a = { x: wall.a.x + dx, y: wall.a.y + dy };
  wall.b = { x: wall.b.x + dx, y: wall.b.y + dy };
  if (connected) {
    const u = wallDir(wall);
    for (const end of ['a', 'b']) {
      const host = draft.walls.find((w) => w.id === links.hosts[end]);
      const hit = host && meet(wall.a, u, host.a, wallDir(host));
      if (hit) wall[end] = hit;
    }
    for (const c of links.corners) {
      const w = draft.walls.find((x) => x.id === c.id);
      if (w) setEnd(draft, w, c.end, wall[c.at]);
    }
    followTees(draft, wall, links.tees);
    followRooms(draft, before);
  }
  clampOpenings(draft);
}

/**
 * The moved line of a room edge pq that lies along a moved wall's centerline or one of its faces,
 * within that wall's own span. An edge that runs on along collinear walls, or only touches the
 * wall's end, does not follow it.
 */
function movedEdgeLine(p, q, moved, after) {
  let best = null;
  for (const w of moved) {
    const L = wallLength(w);
    if (L < 1e-6) continue;
    const u = wallDir(w), n = wallNormal(w), h = w.thickness / 2;
    const dp = dot(sub(p, w.a), n), dq = dot(sub(q, w.a), n);
    if (Math.abs(dp - dq) > JOIN_TOL) continue;
    const off = [0, h, -h].find((o) => Math.abs(dp - o) <= JOIN_TOL);
    if (off === undefined) continue;
    // Both ends must project onto the wall (a face corner may sit half a thickness past an end),
    // and the edge must overlap the wall itself.
    const s0 = dot(sub(p, w.a), u), s1 = dot(sub(q, w.a), u);
    const lo = Math.min(s0, s1), hi = Math.max(s0, s1);
    if (lo < -h - JOIN_TOL || hi > L + h + JOIN_TOL) continue;
    const overlap = Math.min(hi, L) - Math.max(lo, 0);
    if (overlap <= 0.01 || (best && overlap <= best.overlap)) continue;
    const nw = after.get(w.id);
    best = { p: add(nw.a, scale(wallNormal(nw), off)), d: wallDir(nw), overlap };
  }
  return best;
}

/**
 * After walls move (beforeWalls holds their old positions), move room corners to match: a corner
 * on a moved wall end follows the end, and an edge along a moved wall's centerline or face follows
 * that line, with its corners re-intersected with the neighboring edges.
 */
export function followRooms(draft, beforeWalls) {
  const after = new Map(draft.walls.map((w) => [w.id, w]));
  const moved = beforeWalls.filter((w) => {
    const now = after.get(w.id);
    return now && (!samePoint(now.a, w.a, 1e-9) || !samePoint(now.b, w.b, 1e-9));
  });
  if (!moved.length) return;
  const endAt = (p) => {
    for (const w of moved) for (const end of ['a', 'b']) if (samePoint(p, w[end])) return { ...after.get(w.id)[end] };
    return null;
  };
  for (const room of draft.rooms) {
    const pts = room.points, n = pts.length;
    const ends = pts.map(endAt);
    const lines = pts.map((p, i) => movedEdgeLine(p, pts[(i + 1) % n], moved, after));
    if (!ends.some(Boolean) && !lines.some(Boolean)) continue;
    room.points = pts.map((p, i) => {
      if (ends[i]) return ends[i];
      const prev = lines[(i - 1 + n) % n], next = lines[i];
      if (!prev && !next) return { ...p };
      const lp = prev || { p, d: norm(sub(p, pts[(i - 1 + n) % n])) };
      const ln = next || { p, d: norm(sub(pts[(i + 1) % n], p)) };
      const hit = meet(lp.p, lp.d, ln.p, ln.d);
      if (hit) return hit;
      const L = prev || next;
      return add(L.p, scale(L.d, dot(sub(p, L.p), L.d)));
    });
  }
}

/**
 * Scale the plan by k about point p: wall ends, opening offsets and widths, room outlines, and the
 * positions of items and viewpoints (walls keep their thickness, and items their sizes unless they
 * were measured from the image). Used when the image a plan was traced from is calibrated.
 */
export function scalePlan(draft, p, k) {
  const at = (q) => ({ x: p.x + k * (q.x - p.x), y: p.y + k * (q.y - p.y) });
  for (const w of draft.walls) {
    w.a = at(w.a);
    w.b = at(w.b);
  }
  for (const o of draft.openings) {
    o.offset *= k;
    o.width = clamp(o.width * k, 0.2, 20);
  }
  for (const r of draft.rooms) r.points = r.points.map(at);
  for (const e of [...draft.items, ...draft.cameras]) Object.assign(e, at(e));
  for (const e of draft.items) {
    if (!e.traced) continue;
    for (const key of ['w', 'd']) if (e[key]) e[key] = clamp(e[key] * k, 0.05, LIMITS.itemSize);
  }
  clampOpenings(draft);
}

/** Keep every opening inside its wall after geometry changes. */
export function clampOpenings(draft) {
  const byId = new Map(draft.walls.map((w) => [w.id, w]));
  for (const o of draft.openings) {
    const w = byId.get(o.wallId);
    if (!w) continue;
    const L = wallLength(w);
    o.width = Math.min(o.width, Math.max(0.2, L));
    o.offset = clamp(o.offset, o.width / 2, Math.max(o.width / 2, L - o.width / 2));
  }
}

// ---- Store ----------------------------------------------------------------

/**
 * Holds the current plan, the selection and undo/redo history.
 * Never mutate store.plan directly: call store.update(draft => { ... }).
 * Events: 'change' {label, coalesce}, 'selection' {selection}, 'history' {canUndo, canRedo}.
 */
export class PlanStore extends EventTarget {
  constructor(plan = createPlan(), { historyLimit = 200 } = {}) {
    super();
    this._plan = normalizePlan(plan);
    this._selection = null;
    this._undo = [];
    this._redo = [];
    this._limit = historyLimit;
    this._lastCoalesce = null;
  }

  get plan() { return this._plan; }
  get selection() { return this._selection; }
  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }

  /**
   * Apply a change. `coalesce` merges consecutive updates with the same key into one undo step
   * (use a per-gesture key such as `drag-${id}`; call endCoalesce() when the gesture ends).
   */
  update(mutator, { label = 'Edit', coalesce = null } = {}) {
    const draft = clonePlan(this._plan);
    mutator(draft);
    const merging = coalesce !== null && coalesce === this._lastCoalesce && this._undo.length > 0;
    if (!merging) {
      this._undo.push({ plan: this._plan, label });
      if (this._undo.length > this._limit) this._undo.shift();
    }
    this._redo = [];
    this._lastCoalesce = coalesce;
    this._plan = draft;
    this._validateSelection();
    this._emit('change', { label, coalesce });
    this._emit('history', { canUndo: this.canUndo, canRedo: this.canRedo });
    return draft;
  }

  endCoalesce() { this._lastCoalesce = null; }

  /** Replace the whole document (open file, load sample). Clears history unless keepHistory. */
  replace(plan, { label = 'Open plan', keepHistory = false } = {}) {
    const next = normalizePlan(plan);
    if (keepHistory) {
      this._undo.push({ plan: this._plan, label });
      while (this._undo.length > this._limit) this._undo.shift();
    } else {
      this._undo = [];
    }
    this._redo = [];
    this._lastCoalesce = null;
    this._plan = next;
    this._selection = null;
    this._emit('change', { label, replaced: true });
    this._emit('selection', { selection: null });
    this._emit('history', { canUndo: this.canUndo, canRedo: this.canRedo });
  }

  undo() {
    const entry = this._undo.pop();
    if (!entry) return false;
    this._redo.push({ plan: this._plan, label: entry.label });
    this._plan = entry.plan;
    this._lastCoalesce = null;
    this._validateSelection();
    this._emit('change', { label: `Undo ${entry.label}`, undo: true });
    this._emit('history', { canUndo: this.canUndo, canRedo: this.canRedo });
    return true;
  }

  redo() {
    const entry = this._redo.pop();
    if (!entry) return false;
    this._undo.push({ plan: this._plan, label: entry.label });
    this._plan = entry.plan;
    this._lastCoalesce = null;
    this._validateSelection();
    this._emit('change', { label: `Redo ${entry.label}`, redo: true });
    this._emit('history', { canUndo: this.canUndo, canRedo: this.canRedo });
    return true;
  }

  /** sel = { kind: 'wall'|'opening'|'room'|'item'|'camera', id } or null. */
  select(sel) {
    const next = sel && findEntity(this._plan, sel.kind, sel.id) ? { kind: sel.kind, id: sel.id } : null;
    if (next?.kind === this._selection?.kind && next?.id === this._selection?.id) return;
    this._selection = next;
    this._emit('selection', { selection: next });
  }

  /** The selected entity object (read-only), or null. */
  get selected() {
    return this._selection ? findEntity(this._plan, this._selection.kind, this._selection.id) : null;
  }

  deleteSelection() {
    const sel = this._selection;
    if (!sel) return false;
    this.update((d) => removeEntity(d, sel.kind, sel.id), { label: `Delete ${sel.kind}` });
    return true;
  }

  _validateSelection() {
    if (this._selection && !findEntity(this._plan, this._selection.kind, this._selection.id)) {
      this._selection = null;
      this._emit('selection', { selection: null });
    }
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
