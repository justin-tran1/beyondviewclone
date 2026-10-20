// Floor plan document model, defaults, entity helpers and the undoable PlanStore.
// See docs/architecture.md for the schema and coordinate conventions.
import { FOOT, INCH, dist, samePoint, wallLength, clamp } from './geometry.js';

export const PLAN_VERSION = 1;

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
const toPoint = (p) => (Array.isArray(p) ? { x: num(p[0], 0), y: num(p[1], 0) } : { x: num(p?.x, 0), y: num(p?.y, 0) });
const oneOf = (v, table, fallback) => (Object.prototype.hasOwnProperty.call(table, v) ? v : fallback);

/**
 * Turn untrusted JSON (a saved file, a sample, older versions) into a valid Plan.
 * Fills defaults, coerces numbers, drops entities that cannot be repaired and de-duplicates ids.
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
  const settings = { ...base.settings, ...(input.settings || {}) };
  settings.wallHeight = clamp(num(settings.wallHeight, DEFAULTS.wallHeight), 2, 12);
  settings.ceiling = oneOf(settings.ceiling, CEILINGS, 'tile');
  settings.exterior = ['city', 'campus', 'none'].includes(settings.exterior) ? settings.exterior : 'city';

  const walls = (input.walls || []).map((w) => {
    const kind = oneOf(w.kind, WALL_KINDS, 'interior');
    const k = WALL_KINDS[kind];
    return {
      id: id(w.id, 'w'),
      a: toPoint(w.a),
      b: toPoint(w.b),
      kind,
      thickness: clamp(num(w.thickness, k.thickness), 0.02, 1.5),
      height: clamp(num(w.height, k.height ?? settings.wallHeight), 0.3, 12),
    };
  }).filter((w) => dist(w.a, w.b) > 0.01);
  const wallIds = new Set(walls.map((w) => w.id));

  const openings = (input.openings || []).map((o) => {
    const type = oneOf(o.type, OPENING_TYPES, 'door');
    const t = OPENING_TYPES[type];
    return {
      id: id(o.id, 'o'),
      wallId: o.wallId,
      type,
      offset: num(o.offset, 0),
      width: clamp(num(o.width, t.width), 0.2, 20),
      height: clamp(num(o.height, t.height), 0.2, 12),
      sill: clamp(num(o.sill, t.sill), 0, 6),
      hinge: o.hinge === 'end' ? 'end' : 'start',
      side: num(o.side, 1) < 0 ? -1 : 1,
    };
  }).filter((o) => wallIds.has(o.wallId));

  const rooms = (input.rooms || []).map((r) => ({
    id: id(r.id, 'r'),
    name: typeof r.name === 'string' ? r.name : 'Room',
    points: (r.points || []).map(toPoint),
    floor: oneOf(r.floor, FLOORS, 'carpet'),
    ceiling: oneOf(r.ceiling, CEILINGS, settings.ceiling),
    ...(Number.isFinite(+r.height) && +r.height > 0 ? { height: clamp(+r.height, 2, 20) } : {}),
  })).filter((r) => r.points.length >= 3);

  const items = (input.items || []).filter((i) => i && typeof i.type === 'string').map((i) => {
    const out = { id: id(i.id, 'i'), type: i.type, x: num(i.x, 0), y: num(i.y, 0), rotation: num(i.rotation, 0) };
    for (const k of ['w', 'd', 'h', 'elevation']) if (Number.isFinite(+i[k]) && +i[k] > 0) out[k] = +i[k];
    if (typeof i.color === 'string') out.color = i.color;
    if (typeof i.label === 'string') out.label = i.label;
    return out;
  });

  const cameras = (input.cameras || []).map((c, n) => ({
    id: id(c.id, 'c'),
    name: typeof c.name === 'string' && c.name ? c.name : `View ${n + 1}`,
    x: num(c.x, 0),
    y: num(c.y, 0),
    yaw: num(c.yaw, 0),
    pitch: clamp(num(c.pitch, 0), -60, 60),
  }));

  let underlay = null;
  if (input.underlay && typeof input.underlay.src === 'string' && input.underlay.src) {
    const u = input.underlay;
    underlay = {
      src: u.src,
      width: num(u.width, 0),
      height: num(u.height, 0),
      x: num(u.x, 0),
      y: num(u.y, 0),
      scale: num(u.scale, 0.02) > 0 ? num(u.scale, 0.02) : 0.02,
      rotation: num(u.rotation, 0),
      opacity: clamp(num(u.opacity, 0.5), 0, 1),
      visible: u.visible !== false,
      locked: u.locked !== false,
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

export const serializePlan = (plan) => JSON.stringify({ ...plan, version: PLAN_VERSION }, null, 2);

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
    name: props.name ?? `Room ${draft.rooms.length + 1}`,
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
  draft.items.push(item);
  return item;
}

export function addCamera(draft, x, y, yaw = 0, props = {}) {
  const camera = {
    id: uid('c'),
    name: props.name ?? `View ${draft.cameras.length + 1}`,
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

/**
 * Move one endpoint of a wall. With connected=true, endpoints of other walls that shared the old
 * position move too, so corners stay joined. Openings keep their offset, clamped to the new length.
 */
export function moveWallEndpoint(draft, wallId, end, p, { connected = true } = {}) {
  const wall = draft.walls.find((w) => w.id === wallId);
  if (!wall) return;
  const old = { ...wall[end] };
  wall[end] = { x: p.x, y: p.y };
  if (connected) {
    for (const w of draft.walls) {
      if (w === wall) continue;
      if (samePoint(w.a, old)) w.a = { x: p.x, y: p.y };
      if (samePoint(w.b, old)) w.b = { x: p.x, y: p.y };
    }
  }
  clampOpenings(draft);
}

/** Translate a wall by (dx, dy). Connected endpoints of other walls follow when connected=true. */
export function moveWall(draft, wallId, dx, dy, { connected = true } = {}) {
  const wall = draft.walls.find((w) => w.id === wallId);
  if (!wall) return;
  const oldA = { ...wall.a }, oldB = { ...wall.b };
  wall.a = { x: oldA.x + dx, y: oldA.y + dy };
  wall.b = { x: oldB.x + dx, y: oldB.y + dy };
  if (connected) {
    for (const w of draft.walls) {
      if (w === wall) continue;
      for (const end of ['a', 'b']) {
        if (samePoint(w[end], oldA)) w[end] = { ...wall.a };
        else if (samePoint(w[end], oldB)) w[end] = { ...wall.b };
      }
    }
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
    if (keepHistory) this._undo.push({ plan: this._plan, label });
    else this._undo = [];
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
