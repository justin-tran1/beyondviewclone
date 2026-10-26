// PlanEditor: interactive 2D tracing and layout editor on a canvas. Owns pointer, wheel and
// keyboard input on the canvas; every edit goes through store.update so it is undoable.
// See docs/architecture.md for the contract.
import {
  OPENING_TYPES, WALL_KINDS, OPENING_GAP, addWall, addOpening, addRoom, addItem, addCamera,
  moveWall, moveWallEndpoint, isWallJoined, findEntity, clonePlan, nextName, scalePlan,
} from './model.js';
import { getItem, itemDims } from './catalog/registry.js';
import {
  FOOT, INCH, add, sub, scale as mul, dot, cross, len, dist, lerp, norm, samePoint, clamp,
  rad2deg, deg2rad, normDeg, projectToSegment, segmentIntersection,
  wallLength, wallDir, wallNormal, openingSpan, polygonSignedArea, polygonArea, pointInPolygon,
  pointInItem, snapValue, snapToGrid, parseLength, formatLength, formatArea,
} from './geometry.js';
import {
  THEME, HANDLE, renderPlan, toScreen, toPlan, fitView, planBounds,
  drawDimension, drawSnapMarker, drawPill, itemHandlePoint, cameraHandlePoint,
} from './plan-render.js';

const TOOLS = ['select', 'pan', 'wall', 'room', 'door', 'double-door', 'sliding-door', 'opening', 'window', 'item', 'camera', 'calibrate'];
const OPENING_TOOLS = new Set(['door', 'double-door', 'sliding-door', 'opening', 'window']);
const KEY_TOOLS = { v: 'select', h: 'pan', w: 'wall', r: 'room', d: 'door', n: 'window', c: 'camera' };
const SNAP_PX = 10;
const DRAG_PX = 4;
const MIN_SCALE = 2;
const MAX_SCALE = 900;
const ANGLE_TOL = 8;
const ITEM_WALL_SNAP = 0.4;
const ITEM_CORNER_SNAP = 0.25;
const PREVIEW_WALL = '__preview-wall';
const GHOST_OPENING = '__ghost-opening';
const GHOST_ITEM = '__ghost-item';
const GHOST_CAMERA = '__ghost-camera';
const KIND_LABEL = { wall: 'wall', opening: 'opening', room: 'room', item: 'item', camera: 'view' };

const isTextTarget = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
const angleDiff = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;

/**
 * Smallest region enclosed by wall centerlines that contains p, inset to the wall faces.
 * Returns an array of points or null. Openings do not break enclosure.
 */
export function findEnclosure(walls, p) {
  const segs = walls.filter((w) => dist(w.a, w.b) > 1e-3);
  if (segs.length < 3) return null;
  const cuts = segs.map(() => [0, 1]);
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const A = segs[i], B = segs[j];
      const hit = segmentIntersection(A.a, A.b, B.a, B.b);
      if (hit) { cuts[i].push(hit.t); cuts[j].push(hit.u); }
      for (const [S, k, q] of [[A, i, B.a], [A, i, B.b], [B, j, A.a], [B, j, A.b]]) {
        const pr = projectToSegment(q, S.a, S.b);
        if (pr.dist < 0.004) cuts[k].push(pr.t);
      }
    }
  }
  const nodes = [];
  const cells = new Map();
  const nodeAt = (pt) => {
    const kx = Math.round(pt.x / 0.005), ky = Math.round(pt.y / 0.005);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const idx of cells.get(`${kx + dx},${ky + dy}`) || []) if (dist(nodes[idx], pt) < 0.004) return idx;
      }
    }
    nodes.push({ x: pt.x, y: pt.y });
    const key = `${kx},${ky}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(nodes.length - 1);
    return nodes.length - 1;
  };
  const edges = new Map();
  segs.forEach((w, i) => {
    const ts = [...new Set(cuts[i].map((t) => Math.round(clamp(t, 0, 1) * 1e6) / 1e6))].sort((a, b) => a - b);
    for (let k = 1; k < ts.length; k++) {
      const na = nodeAt(lerp(w.a, w.b, ts[k - 1])), nb = nodeAt(lerp(w.a, w.b, ts[k]));
      if (na === nb) continue;
      const key = na < nb ? `${na}-${nb}` : `${nb}-${na}`;
      const prev = edges.get(key);
      edges.set(key, { a: Math.min(na, nb), b: Math.max(na, nb), h: Math.max(prev?.h || 0, w.thickness / 2) });
    }
  });
  const adj = nodes.map(() => new Map());
  for (const e of edges.values()) { adj[e.a].set(e.b, e.h); adj[e.b].set(e.a, e.h); }
  let pruned = true;
  while (pruned) {
    pruned = false;
    adj.forEach((m, i) => {
      if (m.size === 1) {
        const [j] = m.keys();
        adj[j].delete(i);
        m.clear();
        pruned = true;
      }
    });
  }
  const order = adj.map((m, i) => [...m.keys()].sort((x, y) => {
    const ax = Math.atan2(nodes[x].y - nodes[i].y, nodes[x].x - nodes[i].x);
    const ay = Math.atan2(nodes[y].y - nodes[i].y, nodes[y].x - nodes[i].x);
    return ax - ay;
  }));
  const seen = new Set();
  let best = null;
  for (let u = 0; u < nodes.length; u++) {
    for (const v of order[u]) {
      if (seen.has(`${u}>${v}`)) continue;
      const poly = [], halves = [];
      let cu = u, cv = v;
      for (let guard = 0; guard < 20000; guard++) {
        seen.add(`${cu}>${cv}`);
        poly.push(nodes[cu]);
        halves.push(adj[cu].get(cv));
        const list = order[cv];
        const k = list.indexOf(cu);
        const next = list[(k - 1 + list.length) % list.length];
        cu = cv; cv = next;
        if (cu === u && cv === v) break;
      }
      if (poly.length < 3) continue;
      const area = polygonArea(poly);
      if (area < 0.25 || !pointInPolygon(p, poly)) continue;
      if (!best || area < best.area) best = { area, poly, halves };
    }
  }
  if (!best) return null;
  const { poly, halves } = simplifyRing(best.poly, best.halves);
  if (poly.length < 3) return null;
  return insetRing(poly, halves) || poly.map((q) => ({ x: q.x, y: q.y }));
}

function simplifyRing(pts, offs) {
  const poly = pts.map((q) => ({ x: q.x, y: q.y }));
  const halves = [...offs];
  let changed = true;
  while (changed && poly.length >= 3) {
    changed = false;
    for (let i = 0; i < poly.length; i++) {
      const n = poly.length;
      const prev = poly[(i - 1 + n) % n], cur = poly[i], next = poly[(i + 1) % n];
      const d1 = norm(sub(cur, prev)), d2 = norm(sub(next, cur));
      const spike = dist(prev, next) < 1e-4;
      const straight = Math.abs(cross(d1, d2)) < 1e-4 && dot(d1, d2) > 0;
      if (spike || straight) {
        const ip = (i - 1 + n) % n;
        halves[ip] = straight ? (halves[ip] + halves[i]) / 2 : halves[ip];
        poly.splice(i, 1);
        halves.splice(i, 1);
        if (spike && poly.length >= 3) {
          const j = i % poly.length;
          poly.splice(j, 1);
          halves.splice(j, 1);
        }
        changed = true;
        break;
      }
    }
  }
  return { poly, halves };
}

function insetRing(poly, halves) {
  const n = poly.length;
  const sign = polygonSignedArea(poly) > 0 ? 1 : -1;
  const lines = poly.map((a, i) => {
    const d = norm(sub(poly[(i + 1) % n], a));
    const m = mul({ x: -d.y, y: d.x }, sign);
    return { p: add(a, mul(m, halves[i])), d, m };
  });
  const out = poly.map((q, i) => {
    const L0 = lines[(i - 1 + n) % n], L1 = lines[i];
    const c = cross(L0.d, L1.d);
    if (Math.abs(c) < 1e-6) return add(q, mul(L1.m, halves[i]));
    const s = cross(sub(L1.p, L0.p), L1.d) / c;
    return add(L0.p, mul(L0.d, s));
  });
  const a0 = polygonSignedArea(poly), a1 = polygonSignedArea(out);
  if (Math.sign(a0) !== Math.sign(a1) || Math.abs(a1) < 0.2 || Math.abs(a1) > Math.abs(a0)) return null;
  for (let i = 0; i < n; i++) {
    if (dot(sub(out[(i + 1) % n], out[i]), lines[i].d) <= 0) return null;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentIntersection(out[i], out[(i + 1) % n], out[j], out[(j + 1) % n])) return null;
    }
  }
  return out;
}

const cornerCache = new WeakMap();

/** True if p is inside a wall's body (the rectangle around its centerline). */
function insideWall(p, w) {
  const L = wallLength(w);
  if (L < 1e-6) return false;
  const rel = sub(p, w.a);
  const along = dot(rel, wallDir(w));
  return along > 0 && along < L && Math.abs(dot(rel, wallNormal(w))) < w.thickness / 2;
}

/**
 * Corners where the faces of two walls meet at L, T and X junctions, each with the two unit
 * directions (`free`) that point away from those walls into the space the corner bounds.
 * Cached per walls array.
 */
function faceCorners(walls) {
  let out = cornerCache.get(walls);
  if (out) return out;
  out = [];
  const info = walls.filter((w) => wallLength(w) > 1e-3).map((w) => {
    const h = w.thickness / 2;
    return {
      w, h, u: wallDir(w), n: wallNormal(w),
      box: { x0: Math.min(w.a.x, w.b.x) - h, x1: Math.max(w.a.x, w.b.x) + h, y0: Math.min(w.a.y, w.b.y) - h, y1: Math.max(w.a.y, w.b.y) + h },
    };
  });
  for (let i = 0; i < info.length; i++) {
    for (let j = i + 1; j < info.length; j++) {
      const A = info[i], B = info[j];
      if (A.box.x0 > B.box.x1 || B.box.x0 > A.box.x1 || A.box.y0 > B.box.y1 || B.box.y0 > A.box.y1) continue;
      const c = cross(A.u, B.u);
      if (Math.abs(c) < 0.05) continue;
      for (const sa of [1, -1]) {
        for (const sb of [1, -1]) {
          const pa = add(A.w.a, mul(A.n, sa * A.h)), pb = add(B.w.a, mul(B.n, sb * B.h));
          const pt = add(pa, mul(A.u, cross(sub(pb, pa), B.u) / c));
          if (projectToSegment(pt, A.w.a, A.w.b).dist > A.h + 1e-6 || projectToSegment(pt, B.w.a, B.w.b).dist > B.h + 1e-6) continue;
          const free = [mul(A.n, sa), mul(B.n, sb)];
          const probe = add(pt, mul(add(free[0], free[1]), 1e-3));
          if (!walls.some((w) => insideWall(probe, w))) out.push({ point: pt, free });
        }
      }
    }
  }
  cornerCache.set(walls, out);
  return out;
}

export class PlanEditor extends EventTarget {
  constructor(canvas, store) {
    super();
    this.canvas = canvas;
    this.store = store;
    this.ctx = canvas.getContext('2d');
    this.view = { scale: 40, ox: 0, oy: 0, width: 0, height: 0 };
    this._dpr = 1;
    this._fitted = false;
    this._tool = 'select';
    this._wallKind = 'interior';
    this._pendingItem = null;
    this._pendingRotation = 0;
    this._walker = null;
    this._options = { showGrid: true, showUnderlay: true, showDimensions: false, showLabels: true };
    this._cursor = null;
    this._pointerSp = null;
    this._shift = false;
    this._hover = null;
    this._snap = null;
    this._ghost = null;
    this._draft = null;
    this._typed = '';
    this._gesture = null;
    this._gestureSerial = 0;
    this._spaceDown = false;
    this._touches = new Map();
    this._pinch = null;
    this._raf = 0;
    this._dirty = false;
    this._cursorDirty = false;
    this._status = '';
    this._cursorStyle = '';
    this._lastYaw = 0;
    this._destroyed = false;

    if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;
    canvas.style.touchAction = 'none';
    canvas.style.userSelect = 'none';
    canvas.style.webkitUserSelect = 'none';

    this._frame = this._frame.bind(this);
    this._onImage = () => this._invalidate();
    this._listeners = [];
    const on = (target, type, fn, opts) => {
      const bound = fn.bind(this);
      target.addEventListener(type, bound, opts);
      this._listeners.push([target, type, bound, opts]);
    };
    on(canvas, 'pointerdown', this._onPointerDown);
    on(canvas, 'pointermove', this._onPointerMove);
    on(canvas, 'pointerup', this._onPointerUp);
    on(canvas, 'pointercancel', this._onPointerUp);
    on(canvas, 'pointerleave', this._onPointerLeave);
    on(canvas, 'wheel', this._onWheel, { passive: false });
    on(canvas, 'dblclick', this._onDblClick);
    on(canvas, 'contextmenu', (e) => e.preventDefault());
    on(canvas, 'keydown', this._onKeyDown);
    on(canvas, 'keyup', this._onKeyUp);
    on(canvas, 'blur', this._onBlur);
    on(store, 'change', this._onStoreChange);
    on(store, 'selection', () => this._invalidate());

    this._resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.resize()) : null;
    this._resizeObserver?.observe(canvas);
    this._watchPixelRatio();
    this.resize();
    this._setCursor();
    this._invalidate();
  }

  // ---- Public API ------------------------------------------------------------

  get tool() { return this._tool; }
  get wallKind() { return this._wallKind; }
  get pendingItem() { return this._pendingItem; }

  setTool(tool) {
    if (!TOOLS.includes(tool)) return;
    if (tool === this._tool) {
      this._invalidate();
      return;
    }
    this._tool = tool;
    this._resetTransient();
    this._refreshHover();
    this._setCursor();
    this.dispatchEvent(new CustomEvent('toolchange', { detail: { tool } }));
    this._invalidate();
  }

  setWallKind(kind) {
    if (!WALL_KINDS[kind]) return;
    this._wallKind = kind;
    this._invalidate();
  }

  setPendingItem(type) {
    this._pendingItem = type || null;
    this._pendingRotation = 0;
    if (this._tool !== 'item') this.setTool('item');
    else this._refreshHover();
    this._invalidate();
  }

  applyCalibration(a, b, meters) {
    const u = this.store.plan.underlay;
    const d0 = a && b ? dist(a, b) : 0;
    if (!u || !(d0 > 1e-6) || !(meters > 0) || !Number.isFinite(meters)) return false;
    const k = meters / d0;
    this.store.update((d) => {
      const U = d.underlay;
      U.scale *= k;
      U.x = a.x - k * (a.x - U.x);
      U.y = a.y - k * (a.y - U.y);
      U.calibrated = true;
      // A plan traced from the image is resized with it.
      if (U.traced) scalePlan(d, a, k);
    }, { label: 'Calibrate image scale' });
    if (this._draft?.type === 'calibrate') this._draft = null;
    this.zoomToFit();
    return true;
  }

  setWalker(pose) {
    this._walker = pose && Number.isFinite(pose.x) && Number.isFinite(pose.y)
      ? { x: pose.x, y: pose.y, yaw: pose.yaw || 0 } : null;
    this._invalidate();
  }

  setOptions(opts = {}) {
    for (const key of Object.keys(this._options)) if (key in opts) this._options[key] = !!opts[key];
    this._invalidate();
  }

  zoomToFit() {
    const { width, height } = this.view;
    if (!width || !height) {
      this._fitted = false;
      return;
    }
    const v = fitView(planBounds(this.store.plan), width, height, 56);
    const scale = clamp(v.scale, MIN_SCALE, MAX_SCALE);
    const cx = (width / 2 - v.ox) / v.scale, cy = (height / 2 - v.oy) / v.scale;
    this.view = { scale, ox: width / 2 - cx * scale, oy: height / 2 - cy * scale, width, height };
    this._fitted = true;
    this._refreshHover();
    this._invalidate();
  }

  zoomBy(factor, anchor) {
    const at = anchor || { x: this.view.width / 2, y: this.view.height / 2 };
    this._zoomAt(at, factor);
  }

  resize() {
    if (this._destroyed) return;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (!w || !h) return;
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
    const v = this.view;
    if (v.width && v.height) {
      v.ox += (w - v.width) / 2;
      v.oy += (h - v.height) / 2;
    }
    v.width = w;
    v.height = h;
    if (dpr !== this._dpr) {
      this._dpr = dpr;
      this._watchPixelRatio();
    }
    if (!this._fitted) this.zoomToFit();
    this.render();
  }

  render() {
    if (this._destroyed) return;
    const { ctx, view } = this;
    if (!view.width || !view.height) return;
    this._dirty = false;
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    const scene = this._scene();
    renderPlan(ctx, scene.plan, view, scene.opts);
    this._drawOverlays(ctx, scene.plan);
    const key = `${view.scale}|${view.ox}|${view.oy}|${view.width}|${view.height}`;
    if (key !== this._viewKey) {
      this._viewKey = key;
      this.dispatchEvent(new CustomEvent('view', { detail: { scale: view.scale, ox: view.ox, oy: view.oy } }));
    }
  }

  destroy() {
    this._destroyed = true;
    for (const [target, type, fn, opts] of this._listeners) target.removeEventListener(type, fn, opts);
    this._listeners = [];
    this._resizeObserver?.disconnect();
    this._dprQuery?.removeEventListener?.('change', this._dprHandler);
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  // ---- Frame scheduling ----------------------------------------------------------

  _invalidate() {
    this._dirty = true;
    this._schedule();
  }

  _schedule() {
    if (!this._raf && !this._destroyed) this._raf = requestAnimationFrame(this._frame);
  }

  _frame() {
    this._raf = 0;
    if (this._cursorDirty && this._cursor) {
      this._cursorDirty = false;
      this.dispatchEvent(new CustomEvent('cursor', { detail: { x: this._cursor.x, y: this._cursor.y } }));
    }
    if (this._dirty) this.render();
    this._emitStatus();
  }

  _watchPixelRatio() {
    if (typeof window.matchMedia !== 'function') return;
    this._dprQuery?.removeEventListener?.('change', this._dprHandler);
    this._dprHandler = () => this.resize();
    this._dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this._dprQuery.addEventListener?.('change', this._dprHandler);
  }

  // ---- Helpers -------------------------------------------------------------------

  get _units() { return this.store.plan.units; }

  _gridStep() { return this._units === 'metric' ? 0.1 : 6 * INCH; }

  _gridActive() { return this._gridStep() * this.view.scale >= 6; }

  _screenPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _px(n) { return n / this.view.scale; }

  _zoomAt(sp, factor) {
    const v = this.view;
    const scale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
    const k = scale / v.scale;
    if (Math.abs(k - 1) < 1e-9) return;
    v.ox = sp.x - (sp.x - v.ox) * k;
    v.oy = sp.y - (sp.y - v.oy) * k;
    v.scale = scale;
    this._refreshHover();
    this._invalidate();
  }

  _setCursor() {
    let c = 'default';
    const g = this._gesture;
    if (g?.type === 'pan' || this._pinch) c = 'grabbing';
    else if (g?.cursor) c = g.cursor;
    else if (this._spaceDown || this._tool === 'pan') c = 'grab';
    else if (this._tool === 'select') c = this._hoverCursor || 'default';
    else if (this._tool === 'item' && !this._pendingItem) c = 'not-allowed';
    else c = 'crosshair';
    if (c !== this._cursorStyle) {
      this._cursorStyle = c;
      this.canvas.style.cursor = c;
    }
  }

  _resetTransient() {
    this._draft = null;
    this._ghost = null;
    this._snap = null;
    this._hover = null;
    this._typed = '';
    this._itemContact = null;
  }

  _emitStatus() {
    const text = this._statusText();
    if (text !== this._status) {
      this._status = text;
      this.dispatchEvent(new CustomEvent('status', { detail: { text } }));
    }
  }

  _flash(text) {
    this._flashText = text;
    this._flashUntil = performance.now() + 2200;
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => this._schedule(), 2300);
    this._schedule();
  }

  _statusText() {
    if (this._flashText && performance.now() < this._flashUntil) return this._flashText;
    const d = this._draft;
    const plan = this.store.plan;
    switch (this._tool) {
      case 'select': {
        const sel = this.store.selection;
        if (!sel) {
          return this._walker
            ? 'Click to select. Drag to move. Double-click the plan to walk there.'
            : 'Click to select. Drag to move. Scroll to zoom.';
        }
        return {
          wall: 'Drag to move the wall, or drag an end to reshape it. Delete to remove.',
          room: 'Drag to move the room, or drag a corner to reshape it. Delete to remove.',
          item: 'Drag to move. Drag the handle or press Q or E to rotate. Ctrl+D duplicates.',
          opening: 'Drag along the wall to move. F flips the swing, Shift+F the hinge. Delete to remove.',
          camera: 'Drag to move the view, or drag its handle to aim it. Delete to remove.',
        }[sel.kind] || '';
      }
      case 'pan':
        return 'Drag to pan. Scroll to zoom.';
      case 'wall':
        if (this._typed) return `Length ${this._typed}. Press Enter to place, Esc to clear.`;
        return d
          ? 'Click to add a corner. Type a length and press Enter for exact lengths. Double-click or Esc to finish.'
          : 'Click to start a wall. Type a length and press Enter for exact lengths.';
      case 'room':
        if (d?.points?.length) {
          if (this._typed) return `Length ${this._typed}. Press Enter to place, Esc to clear.`;
          return 'Click to add a corner. Click the first point, double-click or press Enter to finish.';
        }
        return 'Click inside closed walls to fill a room, click corners to trace one, or drag a rectangle.';
      case 'item':
        if (!this._pendingItem) return 'Choose an item to place.';
        if (this._itemContact) return 'Click to place against the wall. Hold Shift to place freely. Esc to finish.';
        return 'Click to place. Q or E to rotate. Esc to finish.';
      case 'camera':
        return 'Press to place a view, drag to aim it, then release.';
      case 'calibrate':
        if (!plan.underlay) return 'Add a floor plan image first, then calibrate its scale.';
        if (!d) return 'Click the start of a known length on the floor plan image.';
        if (!d.b) return 'Click the end of the known length.';
        return 'Enter the true length to scale the image.';
      default: {
        if (!OPENING_TOOLS.has(this._tool)) return '';
        const label = OPENING_TYPES[this._tool].label.toLowerCase();
        if (this._ghost && !this._ghost.valid) return `There is no room for a ${label} here.`;
        if (this._tool === 'door') return 'Click a wall to place a door. The cursor side sets the swing, the nearer jamb the hinge.';
        if (this._tool === 'double-door') return 'Click a wall to place a double door. The cursor side sets the swing.';
        return `Click a wall to place a ${label}.`;
      }
    }
  }

  // ---- Scene composition -----------------------------------------------------------

  _scene() {
    let plan = this.store.plan;
    const ghosts = new Set();
    const dimensions = [];
    const d = this._draft;
    const tool = this._tool;
    if (tool === 'wall' && d?.type === 'wall') {
      const end = this._wallPreviewEnd();
      if (end && dist(end, d.start) > 1e-3) {
        const k = WALL_KINDS[this._wallKind];
        const wall = {
          id: PREVIEW_WALL, a: { ...d.start }, b: end, kind: this._wallKind,
          thickness: k.thickness, height: k.height ?? plan.settings.wallHeight,
        };
        plan = { ...plan, walls: [...plan.walls, wall] };
        ghosts.add(PREVIEW_WALL);
        dimensions.push({ wallId: PREVIEW_WALL, tone: this._typed ? 'input' : 'active', text: this._typed || undefined });
      }
    }
    const g = this._ghost;
    if (g?.type === 'opening' && g.valid) {
      const o = {
        id: GHOST_OPENING, wallId: g.wallId, type: g.openingType, offset: g.center, width: g.width,
        height: OPENING_TYPES[g.openingType].height, sill: OPENING_TYPES[g.openingType].sill, hinge: g.hinge, side: g.side,
      };
      plan = { ...plan, openings: [...plan.openings, o] };
      ghosts.add(GHOST_OPENING);
    }
    if (g?.type === 'item') {
      const it = { id: GHOST_ITEM, type: g.itemType, x: g.x, y: g.y, rotation: g.rotation };
      plan = { ...plan, items: [...plan.items, it] };
      ghosts.add(GHOST_ITEM);
    }
    if (d?.type === 'camera') {
      plan = { ...plan, cameras: [...plan.cameras, { id: GHOST_CAMERA, name: d.name, x: d.x, y: d.y, yaw: d.yaw, pitch: 0 }] };
      ghosts.add(GHOST_CAMERA);
    }
    const opts = {
      ...this._options,
      selection: this.store.selection,
      hover: this._tool === 'select' && !this._gesture ? this._hover : null,
      walker: this._walker,
      ghosts,
      dimensions,
      onLoad: this._onImage,
    };
    return { plan, opts };
  }

  _drawOverlays(ctx, plan) {
    const view = this.view;
    const d = this._draft;
    const snap = this._snap;
    if (snap?.guides && this._cursor) for (const g of snap.guides) this._drawGuide(ctx, g.from, g.dir);
    if (d?.type === 'room') this._drawRoomDraft(ctx, plan, d);
    if (d?.type === 'calibrate') this._drawCalibration(ctx, plan, d);
    if (this._itemContact) {
      const [a, b] = this._itemContact.map((p) => toScreen(view, p));
      ctx.save();
      ctx.strokeStyle = THEME.snap;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }
    if (snap?.kind && snap.kind !== 'angle' && this._snapVisible()) drawSnapMarker(ctx, view, snap.point, snap.kind);
  }

  _snapVisible() {
    if (this._gesture?.snaps) return true;
    return ['wall', 'room', 'calibrate'].includes(this._tool) && !!this._cursor;
  }

  _drawGuide(ctx, from, dir) {
    const a = toScreen(this.view, from);
    const far = Math.hypot(this.view.width, this.view.height) + Math.hypot(a.x - this.view.width / 2, a.y - this.view.height / 2);
    ctx.save();
    ctx.strokeStyle = THEME.guide;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x - dir.x * far, a.y - dir.y * far);
    ctx.lineTo(a.x + dir.x * far, a.y + dir.y * far);
    ctx.globalAlpha = 0.75;
    ctx.stroke();
    ctx.restore();
  }

  _drawRoomDraft(ctx, plan, d) {
    const view = this.view;
    let pts;
    if (d.rect) {
      const [a, b] = d.rect;
      pts = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
    } else {
      pts = [...d.points];
      const end = this._roomPreviewEnd();
      if (end) pts.push(end);
    }
    if (!pts.length) return;
    const sp = pts.map((p) => toScreen(view, p));
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(sp[0].x, sp[0].y);
    for (const p of sp.slice(1)) ctx.lineTo(p.x, p.y);
    if (pts.length >= 3) {
      ctx.fillStyle = 'rgba(0, 63, 45, 0.08)';
      ctx.fill();
    }
    if (d.rect) ctx.closePath();
    ctx.strokeStyle = THEME.selection;
    ctx.lineWidth = 1.75;
    ctx.lineJoin = 'round';
    ctx.stroke();
    if (!d.rect && pts.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(sp[sp.length - 1].x, sp[sp.length - 1].y);
      ctx.lineTo(sp[0].x, sp[0].y);
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const p of d.rect ? sp : sp.slice(0, d.points.length)) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
    if (d.rect) {
      const [a, b] = d.rect;
      const top = { a: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, b: { x: Math.max(a.x, b.x), y: Math.min(a.y, b.y) } };
      const left = { a: top.a, b: { x: top.a.x, y: Math.max(a.y, b.y) } };
      drawDimension(ctx, view, top.a, top.b, { units: plan.units, offset: 16, tone: 'active' });
      drawDimension(ctx, view, left.a, left.b, { units: plan.units, offset: 16, tone: 'active' });
      const area = Math.abs((b.x - a.x) * (b.y - a.y));
      const c = toScreen(view, lerp(a, b, 0.5));
      if (area > 0.01) drawPill(ctx, c.x, c.y, formatArea(area, plan.units), { tone: 'plain' });
    } else if (pts.length >= 2) {
      const a = pts[pts.length - 2], b = pts[pts.length - 1];
      if (dist(a, b) > 1e-3) {
        drawDimension(ctx, view, a, b, {
          units: plan.units, offset: 14, tone: this._typed ? 'input' : 'active', text: this._typed || undefined,
        });
      }
    }
  }

  _drawCalibration(ctx, plan, d) {
    const view = this.view;
    const b = d.b || this._calibrateEnd();
    const A = toScreen(view, d.a);
    ctx.save();
    ctx.strokeStyle = THEME.selection;
    ctx.fillStyle = '#FFFFFF';
    const marker = (P) => {
      ctx.beginPath();
      ctx.arc(P.x, P.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(P.x - 10, P.y); ctx.lineTo(P.x + 10, P.y);
      ctx.moveTo(P.x, P.y - 10); ctx.lineTo(P.x, P.y + 10);
      ctx.lineWidth = 1;
      ctx.stroke();
    };
    if (b && dist(b, d.a) > 1e-6) {
      const B = toScreen(view, b);
      ctx.beginPath();
      ctx.moveTo(A.x, A.y);
      ctx.lineTo(B.x, B.y);
      ctx.lineWidth = 2;
      if (!d.b) ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      marker(B);
    }
    marker(A);
    ctx.restore();
    if (b && dist(b, d.a) > 1e-6) {
      const A2 = toScreen(view, d.a), B2 = toScreen(view, b);
      const m = { x: (A2.x + B2.x) / 2, y: (A2.y + B2.y) / 2 };
      let angle = Math.atan2(B2.y - A2.y, B2.x - A2.x);
      if (angle > Math.PI / 2) angle -= Math.PI;
      if (angle < -Math.PI / 2) angle += Math.PI;
      const n = { x: Math.sin(angle), y: -Math.cos(angle) };
      drawPill(ctx, m.x + n.x * 16, m.y + n.y * 16, `Measured ${formatLength(dist(d.a, b), plan.units)}`, { angle, tone: 'active' });
    }
  }

  // ---- Snapping ----------------------------------------------------------------------

  /**
   * Snap a plan point. Order: extra points, wall endpoints and room vertices, wall midpoints,
   * angle (relative to `from` and any other `refs`), points along walls, then the grid.
   * With `faces` (room outlines) it also snaps to the corners where wall faces meet, uses the wall
   * face on the cursor side instead of the centerline, and ignores points across a wall.
   * Shift disables all of it.
   */
  _snapPoint(raw, opts = {}) {
    const { from = null, shift = false, excludeEnds = null, excludeWalls = null, excludeVertices = null, extra = [], faces = false, points = true } = opts;
    const refs = (opts.refs || (from ? [from] : [])).filter(Boolean);
    if (shift) return { point: { x: raw.x, y: raw.y }, kind: null };
    const plan = this.store.plan;
    const r = this._px(SNAP_PX);
    const seen = faces ? (q) => this._inSight(plan.walls, raw, q) : null;
    const faceSide = (w) => {
      if (!faces) return { x: 0, y: 0 };
      const n = wallNormal(w);
      return mul(n, (dot(sub(raw, w.a), n) >= 0 ? 1 : -1) * w.thickness / 2);
    };
    let best = null, bestD = r;
    const consider = (pt, kind, check) => {
      const dd = dist(raw, pt);
      if (dd < bestD && (!check || check(pt))) { bestD = dd; best = { point: { x: pt.x, y: pt.y }, kind }; }
    };
    if (points) {
      for (const e of extra) consider(e.point, e.kind);
      if (best) return best;
      for (const w of plan.walls) {
        for (const end of ['a', 'b']) if (!excludeEnds?.has(`${w.id}:${end}`)) consider(w[end], 'endpoint', seen);
      }
      for (const room of plan.rooms) {
        room.points.forEach((q, i) => {
          if (!excludeVertices?.has(`${room.id}:${i}`)) consider(q, 'vertex', seen);
        });
      }
      if (faces) {
        const tol = this._px(2);
        for (const c of faceCorners(plan.walls)) {
          const rel = sub(raw, c.point);
          if (dot(rel, c.free[0]) >= -tol && dot(rel, c.free[1]) >= -tol) consider(c.point, 'endpoint', seen);
        }
      }
      if (best) return best;
      for (const w of plan.walls) if (!excludeWalls?.has(w.id)) consider(add(lerp(w.a, w.b, 0.5), faceSide(w)), 'midpoint', seen);
      if (best) return best;
    }
    let point = { x: raw.x, y: raw.y }, kind = null, guide = null, guides = [];
    const angle = this._multiAngleSnap(raw, refs, r);
    if (angle) {
      point = angle.point;
      kind = 'angle';
      guides = angle.guides;
      if (guides.length === 1) guide = guides[0];
    }
    if (points && guides.length < 2) {
      let wbest = null, wd = r;
      for (const w of plan.walls) {
        if (excludeWalls?.has(w.id)) continue;
        const off = faceSide(w);
        const a = add(w.a, off), b = add(w.b, off);
        if (guide) {
          const far = add(guide.from, mul(guide.dir, 1e4));
          const hit = segmentIntersection(guide.from, far, a, b);
          if (hit && hit.t > 1e-9) {
            const dd = dist(hit.point, point);
            if (dd < wd) { wd = dd; wbest = hit.point; }
          }
        } else {
          const pr = projectToSegment(raw, a, b);
          if (pr.dist < wd) { wd = pr.dist; wbest = pr.point; }
        }
      }
      if (wbest) return { point: { x: wbest.x, y: wbest.y }, kind: 'on-wall', guides };
    }
    if (this._gridActive() && guides.length < 2) {
      const step = this._gridStep();
      const base = guide?.from || from;
      if (base) {
        const L = dist(base, point);
        if (L > 1e-6) point = add(base, mul(norm(sub(point, base)), Math.max(step, snapValue(L, step))));
      } else {
        point = snapToGrid(raw, step);
        kind = 'grid';
      }
    }
    return { point, kind, guides };
  }

  /** True if the straight line from p to q crosses no wall centerline (q is not across a wall). */
  _inSight(walls, p, q) {
    for (const w of walls) {
      const hit = segmentIntersection(p, q, w.a, w.b);
      if (hit && hit.t > 1e-6 && hit.t < 1 - 1e-6) return false;
    }
    return true;
  }

  /**
   * Angle snap against several reference points. Uses the intersection of two guides when the
   * cursor is near it, otherwise the snapped candidate closest to the cursor.
   */
  _multiAngleSnap(raw, refs, r) {
    const cands = [];
    refs.forEach((ref, i) => {
      const a = this._angleSnap(ref, raw, i === 0);
      if (a) cands.push({ ...a, from: ref, dev: dist(a.point, raw) });
    });
    if (!cands.length) return null;
    let inter = null;
    for (let i = 0; i < cands.length; i++) {
      for (let j = i + 1; j < cands.length; j++) {
        const A = cands[i], B = cands[j];
        const c = cross(A.dir, B.dir);
        if (Math.abs(c) < 1e-6) continue;
        const t = cross(sub(B.from, A.from), B.dir) / c;
        const X = add(A.from, mul(A.dir, t));
        const dX = dist(X, raw);
        if (dX <= r * 1.5 && (!inter || dX < inter.d)) inter = { point: X, d: dX, guides: [A, B] };
      }
    }
    if (inter) return { point: inter.point, guides: inter.guides.map((g) => ({ from: g.from, dir: g.dir })) };
    const best = cands.reduce((m, c) => (c.dev < m.dev ? c : m));
    return { point: best.point, guides: [{ from: best.from, dir: best.dir }] };
  }

  _angleSnap(from, p, useReference = true) {
    const d = sub(p, from);
    const L = len(d);
    if (L < this._px(6)) return null;
    const ang = rad2deg(Math.atan2(d.y, d.x));
    const cands = [0, 45, 90, 135, 180, 225, 270, 315];
    const ref = useReference ? this._referenceAngle() : null;
    if (ref !== null) for (const k of [0, 90, 180, 270]) cands.push(ref + k);
    let best = null, bestDiff = ANGLE_TOL;
    for (const c of cands) {
      const diff = Math.abs(angleDiff(ang, c));
      if (diff < bestDiff - 1e-9) { bestDiff = diff; best = c; }
    }
    if (best === null) return null;
    const dir = { x: Math.cos(deg2rad(best)), y: Math.sin(deg2rad(best)) };
    return { point: add(from, mul(dir, dot(d, dir))), dir };
  }

  /** Direction (degrees) of the previous segment of the wall chain or room outline. */
  _referenceAngle() {
    const d = this._draft;
    let a = null, b = null;
    if (d?.type === 'wall' && d.ids.length) {
      const w = findEntity(this.store.plan, 'wall', d.ids[d.ids.length - 1]);
      if (w) { a = w.a; b = w.b; }
    } else if (d?.type === 'room' && d.points?.length >= 2) {
      a = d.points[d.points.length - 2];
      b = d.points[d.points.length - 1];
    }
    if (!a || dist(a, b) < 1e-6) return null;
    return rad2deg(Math.atan2(b.y - a.y, b.x - a.x));
  }

  _wallSnap(p, shift) {
    const d = this._draft?.type === 'wall' ? this._draft : null;
    const extra = d && d.ids.length >= 2 ? [{ point: d.first, kind: 'close' }] : [];
    const refs = d ? [d.start, d.ids.length >= 1 ? d.first : null] : [];
    return this._snapPoint(p, { from: d?.start || null, refs, shift, extra });
  }

  _roomSnap(p, shift) {
    const d = this._draft;
    const pts = d?.points || [];
    const extra = pts.length >= 3 ? [{ point: pts[0], kind: 'close' }] : [];
    const last = pts.length ? pts[pts.length - 1] : null;
    const refs = last ? [last, pts.length >= 2 ? pts[0] : null] : [];
    return this._snapPoint(p, { from: last, refs, shift, extra, faces: true });
  }

  // ---- Typed lengths ------------------------------------------------------------------

  _acceptsLength() {
    const d = this._draft;
    return (this._tool === 'wall' && d?.type === 'wall') || (this._tool === 'room' && d?.type === 'room' && d.points?.length > 0);
  }

  _typedLength() {
    if (!this._typed) return NaN;
    return parseLength(this._typed, this._units);
  }

  _typedEnd(start, target, refDir) {
    const L = this._typedLength();
    if (!(L > 0)) return null;
    let dir = target ? sub(target, start) : { x: 0, y: 0 };
    dir = len(dir) > 1e-6 ? norm(dir) : refDir || { x: 1, y: 0 };
    return add(start, mul(dir, L));
  }

  _refDir() {
    const ang = this._referenceAngle();
    return ang === null ? null : { x: Math.cos(deg2rad(ang)), y: Math.sin(deg2rad(ang)) };
  }

  _wallPreviewEnd() {
    const d = this._draft;
    if (!d || d.type !== 'wall') return null;
    const target = this._snap?.point || this._cursor;
    return this._typedEnd(d.start, target, this._refDir()) || target;
  }

  _roomPreviewEnd() {
    const d = this._draft;
    if (!d?.points?.length) return null;
    const last = d.points[d.points.length - 1];
    const target = this._snap?.point || this._cursor;
    return this._typedEnd(last, target, this._refDir()) || target;
  }

  _calibrateEnd() {
    const d = this._draft;
    if (!d || !this._cursor) return null;
    if (this._shift) return this._cursor;
    return this._angleSnap(d.a, this._cursor)?.point || this._cursor;
  }

  // ---- Hit testing ------------------------------------------------------------------

  _hitTest(sp, p) {
    const plan = this.store.plan;
    const view = this.view;
    const tol = this._px(4);
    const sel = this.store.selection;
    const selected = this.store.selected;
    if (sel?.kind === 'item' && selected && dist(sp, itemHandlePoint(view, selected)) <= HANDLE.rotate + 4) {
      return { kind: 'item', id: sel.id, part: 'rotate' };
    }
    if (sel?.kind === 'camera' && selected && dist(sp, cameraHandlePoint(view, selected)) <= 8) {
      return { kind: 'camera', id: sel.id, part: 'aim' };
    }
    for (let i = plan.cameras.length - 1; i >= 0; i--) {
      if (dist(sp, toScreen(view, plan.cameras[i])) <= 10) return { kind: 'camera', id: plan.cameras[i].id };
    }
    for (let i = plan.items.length - 1; i >= 0; i--) {
      const it = plan.items[i];
      const dims = itemDims(it);
      if (pointInItem(p, it, { w: dims.w + tol * 2, d: dims.d + tol * 2 })) return { kind: 'item', id: it.id };
    }
    const walls = new Map(plan.walls.map((w) => [w.id, w]));
    for (let i = plan.openings.length - 1; i >= 0; i--) {
      const o = plan.openings[i];
      const w = walls.get(o.wallId);
      if (w && this._pointOnOpening(p, w, o, tol)) return { kind: 'opening', id: o.id };
    }
    const handleR = 8;
    if (sel?.kind === 'wall' && selected) {
      for (const end of ['a', 'b']) {
        if (dist(sp, toScreen(view, selected[end])) <= handleR) return { kind: 'wall', id: sel.id, part: end };
      }
    }
    if (sel?.kind === 'room' && selected) {
      for (let i = 0; i < selected.points.length; i++) {
        if (dist(sp, toScreen(view, selected.points[i])) <= handleR) return { kind: 'room', id: sel.id, part: 'vertex', index: i };
      }
    }
    let wallHit = null, wallD = Infinity;
    for (const w of plan.walls) {
      const pr = projectToSegment(p, w.a, w.b);
      const limit = w.thickness / 2 + tol;
      if (pr.dist <= limit && pr.dist < wallD) { wallD = pr.dist; wallHit = w; }
    }
    if (wallHit) return { kind: 'wall', id: wallHit.id };
    let roomHit = null, roomA = Infinity;
    for (const room of plan.rooms) {
      if (room.points.length >= 3 && pointInPolygon(p, room.points)) {
        const a = polygonArea(room.points);
        if (a < roomA) { roomA = a; roomHit = room; }
      }
    }
    return roomHit ? { kind: 'room', id: roomHit.id } : null;
  }

  _pointOnOpening(p, w, o, tol) {
    const u = wallDir(w), n = wallNormal(w);
    const rel = sub(p, w.a);
    const along = dot(rel, u), dn = dot(rel, n);
    const span = openingSpan(w, o);
    const h = w.thickness / 2;
    if (along >= span.start - tol && along <= span.end + tol && Math.abs(dn) <= h + tol) return true;
    if (o.type !== 'door' && o.type !== 'double-door') return false;
    const s = o.side < 0 ? -1 : 1;
    if (dn * s < h || along < span.start || along > span.end) return false;
    const width = span.end - span.start;
    const leaves = o.type === 'door'
      ? [{ at: o.hinge === 'end' ? span.end : span.start, r: width }]
      : [{ at: span.start, r: width / 2 }, { at: span.end, r: width / 2 }];
    return leaves.some(({ at, r }) => Math.hypot(along - at, dn * s - h) <= r);
  }

  _refreshHover() {
    if (!this._pointerSp || this._gesture) return;
    const sp = this._pointerSp;
    this._cursor = toPlan(this.view, sp.x, sp.y);
    this._updateHover(sp, this._cursor, this._shift);
  }

  _updateHover(sp, p, shift) {
    this._snap = null;
    this._ghost = null;
    this._hover = null;
    this._hoverCursor = '';
    switch (this._tool) {
      case 'select': {
        const hit = this._hitTest(sp, p);
        this._hover = hit ? { kind: hit.kind, id: hit.id } : null;
        const sel = this.store.selection;
        if (!hit) this._hoverCursor = this._underlayMovable() ? 'move' : 'default';
        else if (hit.part === 'rotate' || hit.part === 'aim') this._hoverCursor = 'grab';
        else if (hit.part) this._hoverCursor = 'crosshair';
        else if (sel && sel.kind === hit.kind && sel.id === hit.id) this._hoverCursor = 'move';
        else this._hoverCursor = 'pointer';
        break;
      }
      case 'wall':
        this._snap = this._wallSnap(p, shift);
        break;
      case 'room':
        if (!this._draft?.rect) this._snap = this._roomSnap(p, shift);
        break;
      case 'calibrate':
        break;
      case 'item':
        this._updateItemGhost(p, shift);
        break;
      default:
        if (OPENING_TOOLS.has(this._tool)) this._updateOpeningGhost(p);
    }
    this._setCursor();
  }

  _underlayMovable() {
    const u = this.store.plan.underlay;
    return !!u && u.visible !== false && !u.locked;
  }

  // ---- Openings -------------------------------------------------------------------------

  _nearestWall(p, maxDist, excludeId) {
    let best = null;
    for (const w of this.store.plan.walls) {
      if (w.id === excludeId) continue;
      const pr = projectToSegment(p, w.a, w.b);
      const limit = maxDist + w.thickness / 2;
      if (pr.dist <= limit && (!best || pr.dist - w.thickness / 2 < best.d)) {
        best = { wall: w, proj: pr, d: pr.dist - w.thickness / 2 };
      }
    }
    return best;
  }

  /** Clearance (m) needed at a wall end so an opening stays clear of joined walls. */
  _endMargin(wall, end) {
    let m = 0;
    for (const w of this.store.plan.walls) {
      if (w.id === wall.id) continue;
      if (projectToSegment(wall[end], w.a, w.b).dist < 2e-3) m = Math.max(m, w.thickness / 2);
    }
    return m > 0 ? m + OPENING_GAP : 0;
  }

  /** Nearest center (m from wall.a) where an opening of this width fits, or null. */
  _fitOpening(wall, width, desired, excludeId) {
    const plan = this.store.plan;
    const L = wallLength(wall);
    const lo = this._endMargin(wall, 'a') + width / 2;
    const hi = L - this._endMargin(wall, 'b') - width / 2;
    if (hi < lo - 1e-9) return null;
    const blocked = [];
    for (const o of plan.openings) {
      if (o.wallId !== wall.id || o.id === excludeId) continue;
      const s = openingSpan(wall, o);
      blocked.push([s.start - width / 2 - OPENING_GAP, s.end + width / 2 + OPENING_GAP]);
    }
    const u = wallDir(wall);
    for (const w of plan.walls) {
      if (w.id === wall.id) continue;
      for (const end of ['a', 'b']) {
        const pr = projectToSegment(w[end], wall.a, wall.b);
        if (pr.dist > 2e-3 || pr.t <= 1e-6 || pr.t >= 1 - 1e-6) continue;
        const along = dot(sub(w[end], wall.a), u);
        const half = w.thickness / 2 + OPENING_GAP + width / 2;
        blocked.push([along - half, along + half]);
      }
    }
    const free = (c) => c >= lo - 1e-9 && c <= hi + 1e-9 && blocked.every(([s, e]) => c <= s + 1e-9 || c >= e - 1e-9);
    const cands = [clamp(desired, lo, hi), lo, hi, ...blocked.flat()].filter(free);
    if (!cands.length) return null;
    return cands.reduce((b, c) => (Math.abs(c - desired) < Math.abs(b - desired) ? c : b));
  }

  _openingWidth(wall, type) {
    const spec = OPENING_TYPES[type];
    const avail = wallLength(wall) - this._endMargin(wall, 'a') - this._endMargin(wall, 'b');
    if (avail >= spec.width) return spec.width;
    const min = type === 'window' ? 0.3 : 0.6;
    return avail >= min ? Math.floor(avail / INCH) * INCH : null;
  }

  _updateOpeningGhost(p) {
    const type = this._tool;
    const prev = this._lastOpeningGhost;
    const near = this._nearestWall(p, Math.max(0.5, this._px(12)));
    if (!near) {
      this._ghost = null;
      this._lastOpeningGhost = null;
      return;
    }
    const wall = near.wall;
    const u = wallDir(wall), n = wallNormal(wall);
    const along = dot(sub(p, wall.a), u);
    const width = this._openingWidth(wall, type);
    if (!width) {
      this._ghost = { type: 'opening', valid: false, wallId: wall.id };
      return;
    }
    let desired = along;
    if (prev && prev.wallId === wall.id && prev.type === type) {
      desired = prev.desired;
      if (along > desired + width / 2) desired = along - width / 2;
      else if (along < desired - width / 2) desired = along + width / 2;
    }
    const center = this._fitOpening(wall, width, desired, null);
    const side = dot(sub(p, wall.a), n) >= 0 ? 1 : -1;
    this._lastOpeningGhost = { wallId: wall.id, type, desired };
    if (center === null) {
      this._ghost = { type: 'opening', valid: false, wallId: wall.id };
      return;
    }
    const hinge = type === 'door' ? (along < center ? 'start' : 'end') : 'start';
    this._ghost = { type: 'opening', valid: true, openingType: type, wallId: wall.id, center, width, side, hinge };
  }

  _placeOpening() {
    const g = this._ghost;
    if (!g || g.type !== 'opening' || !g.valid) return false;
    const label = `Add ${OPENING_TYPES[g.openingType].label.toLowerCase()}`;
    this.store.update((d) => {
      addOpening(d, g.wallId, g.openingType, g.center, { width: g.width, side: g.side, hinge: g.hinge });
    }, { label });
    this._lastOpeningGhost = null;
    this._refreshHover();
    return true;
  }

  // ---- Items ----------------------------------------------------------------------------

  /** Pose for an item near p: flush against a wall face (back to the wall) when close enough. */
  _snapItemPose(dims, p, rotation, shift) {
    const free = { x: p.x, y: p.y, rotation, contact: null };
    if (shift) return free;
    const walls = this.store.plan.walls;
    let best = null;
    for (const w of walls) {
      const L = wallLength(w);
      if (L < 0.2) continue;
      const u = wallDir(w), n = wallNormal(w);
      const rel = sub(p, w.a);
      const along = dot(rel, u), dn = dot(rel, n);
      if (along < -0.05 || along > L + 0.05) continue;
      const h = w.thickness / 2;
      const gap = Math.abs(dn) - h - dims.d / 2;
      if (gap > ITEM_WALL_SNAP || gap < -dims.d / 2 - h) continue;
      if (!best || gap < best.gap) best = { w, u, n, along, side: dn >= 0 ? 1 : -1, gap, h };
    }
    if (!best) return free;
    const face = mul(best.n, best.side);
    const rot = normDeg(Math.round(rad2deg(Math.atan2(-face.x, face.y)) * 1e6) / 1e6);
    let center = add(add(best.w.a, mul(best.u, best.along)), mul(face, best.h + dims.d / 2));
    let shiftBy = null;
    for (const w2 of walls) {
      if (w2 === best.w) continue;
      const u2 = wallDir(w2);
      if (Math.abs(dot(u2, best.u)) > 0.15) continue;
      const n2 = wallNormal(w2), L2 = wallLength(w2), h2 = w2.thickness / 2;
      const rel = sub(center, w2.a);
      const along2 = dot(rel, u2), dn2 = dot(rel, n2);
      if (along2 + dims.d / 2 < -h2 || along2 - dims.d / 2 > L2 + h2) continue;
      if (Math.abs(dn2) < h2) continue;
      const gap2 = Math.abs(dn2) - h2 - dims.w / 2;
      if (gap2 > ITEM_CORNER_SNAP || gap2 < -dims.w / 2) continue;
      if (!shiftBy || Math.abs(gap2) < Math.abs(shiftBy.gap)) shiftBy = { gap: gap2, v: mul(n2, -Math.sign(dn2) * gap2) };
    }
    if (shiftBy) center = add(center, shiftBy.v);
    const back = sub(center, mul(face, dims.d / 2));
    const contact = [add(back, mul(best.u, -dims.w / 2)), add(back, mul(best.u, dims.w / 2))];
    return { x: center.x, y: center.y, rotation: rot, contact };
  }

  _updateItemGhost(p, shift) {
    this._itemContact = null;
    if (!this._pendingItem) { this._ghost = null; return; }
    const dims = itemDims({ type: this._pendingItem });
    const pose = this._snapItemPose(dims, p, this._pendingRotation, shift);
    this._itemContact = pose.contact;
    this._ghost = { type: 'item', itemType: this._pendingItem, x: pose.x, y: pose.y, rotation: pose.rotation };
  }

  _placeItem() {
    const g = this._ghost;
    if (!g || g.type !== 'item') return false;
    const name = getItem(g.itemType).name || 'item';
    this.store.update((d) => {
      addItem(d, g.itemType, g.x, g.y, { rotation: g.rotation });
    }, { label: `Add ${name.toLowerCase()}` });
    return true;
  }

  // ---- Pointer input -----------------------------------------------------------------------

  _onPointerDown(e) {
    if (e.pointerType === 'touch') {
      this._touches.set(e.pointerId, this._screenPoint(e));
      if (this._touches.size === 2) {
        this._startPinch();
        return;
      }
      if (this._touches.size > 2) return;
    }
    this.canvas.focus({ preventScroll: true });
    const sp = this._screenPoint(e);
    const p = toPlan(this.view, sp.x, sp.y);
    this._pointerSp = sp;
    this._cursor = p;
    this._shift = e.shiftKey;
    if (e.button === 2) {
      if (this._draft) this._finishDraft();
      this._invalidate();
      return;
    }
    if (e.button === 1 || (e.button === 0 && (this._spaceDown || this._tool === 'pan'))) {
      e.preventDefault();
      this._capture(e);
      this._beginPan(e, sp);
      return;
    }
    if (e.button !== 0) return;
    this._capture(e);
    switch (this._tool) {
      case 'select': this._selectDown(e, sp, p); break;
      case 'wall': this._wallDown(e, p); break;
      case 'room': this._roomDown(e, sp, p); break;
      case 'item':
        this._updateItemGhost(p, e.shiftKey);
        this._placeItem();
        break;
      case 'camera': this._cameraDown(e, sp, p); break;
      case 'calibrate': this._calibrateDown(e, sp, p); break;
      default:
        if (OPENING_TOOLS.has(this._tool)) {
          this._updateOpeningGhost(p);
          this._placeOpening();
        }
    }
    this._setCursor();
    this._invalidate();
  }

  _onPointerMove(e) {
    if (e.pointerType === 'touch' && this._touches.has(e.pointerId)) {
      this._touches.set(e.pointerId, this._screenPoint(e));
      if (this._pinch) {
        this._updatePinch();
        return;
      }
    }
    const sp = this._screenPoint(e);
    const p = toPlan(this.view, sp.x, sp.y);
    this._pointerSp = sp;
    this._cursor = p;
    this._cursorDirty = true;
    this._shift = e.shiftKey;
    const g = this._gesture;
    if (g && g.pointerId === e.pointerId) {
      if (!g.moved && dist(sp, g.start) < (g.threshold ?? DRAG_PX)) {
        this._schedule();
        return;
      }
      g.moved = true;
      g.move?.(sp, p, e);
      this._setCursor();
    } else if (!g) {
      this._updateHover(sp, p, e.shiftKey);
    }
    this._invalidate();
  }

  _onPointerUp(e) {
    if (e.pointerType === 'touch') {
      this._touches.delete(e.pointerId);
      if (this._pinch) {
        if (this._touches.size < 2) this._pinch = null;
        this._setCursor();
        return;
      }
    }
    const g = this._gesture;
    if (g && g.pointerId === e.pointerId) {
      const sp = this._screenPoint(e);
      const p = toPlan(this.view, sp.x, sp.y);
      this._gesture = null;
      if (e.type !== 'pointercancel' || g.moved) g.end?.(sp, p, e, g.moved);
      this.store.endCoalesce();
      this._snap = null;
      this._updateHover(sp, p, e.shiftKey);
    }
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    this._setCursor();
    this._invalidate();
  }

  _onPointerLeave() {
    if (this._gesture) return;
    this._pointerSp = null;
    this._hover = null;
    if (this._tool !== 'wall' && this._tool !== 'room' && this._tool !== 'calibrate') this._cursor = null;
    this._ghost = null;
    this._itemContact = null;
    this._snap = null;
    this._invalidate();
  }

  _capture(e) {
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
  }

  _beginPan(e, sp) {
    let last = sp;
    this._gesture = {
      type: 'pan', pointerId: e.pointerId, start: sp, moved: false, threshold: 0,
      move: (sp2) => {
        this.view.ox += sp2.x - last.x;
        this.view.oy += sp2.y - last.y;
        last = sp2;
      },
    };
    this._setCursor();
  }

  _startPinch() {
    if (this._gesture) {
      const g = this._gesture;
      this._gesture = null;
      if (g.moved) g.end?.(g.start, toPlan(this.view, g.start.x, g.start.y), {}, true);
      this.store.endCoalesce();
    }
    const [a, b] = [...this._touches.values()];
    this._pinch = { mid: lerp(a, b, 0.5), d: Math.max(1, dist(a, b)) };
    this._setCursor();
  }

  _updatePinch() {
    const pts = [...this._touches.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const mid = lerp(a, b, 0.5), d = Math.max(1, dist(a, b));
    this.view.ox += mid.x - this._pinch.mid.x;
    this.view.oy += mid.y - this._pinch.mid.y;
    this._zoomAt(mid, d / this._pinch.d);
    this._pinch = { mid, d };
    this._invalidate();
  }

  _onWheel(e) {
    e.preventDefault();
    const sp = this._screenPoint(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.view.height : 1;
    const dx = e.deltaX * unit, dy = e.deltaY * unit;
    if (!e.ctrlKey && Math.abs(dx) > Math.abs(dy)) {
      this.view.ox -= dx;
      this._refreshHover();
      this._invalidate();
      return;
    }
    const k = e.ctrlKey ? 0.01 : 0.0015;
    this._zoomAt(sp, Math.exp(-clamp(dy, -300, 300) * k));
  }

  _onDblClick(e) {
    const sp = this._screenPoint(e);
    const p = toPlan(this.view, sp.x, sp.y);
    const d = this._draft;
    if (this._tool === 'wall' && d?.type === 'wall') {
      this._finishDraft();
    } else if (this._tool === 'room' && d?.points) {
      this._finishRoom();
    } else if (this._tool === 'select' && this._walker) {
      const hit = this._hitTest(sp, p);
      if (!hit || hit.kind === 'room') this.dispatchEvent(new CustomEvent('teleport', { detail: { x: p.x, y: p.y } }));
    }
    this._invalidate();
  }

  // ---- Select tool -------------------------------------------------------------------------

  _selectDown(e, sp, p) {
    const hit = this._hitTest(sp, p);
    if (hit) {
      this.store.select({ kind: hit.kind, id: hit.id });
      this._gesture = this._dragGesture(hit, e, sp, p);
      return;
    }
    if (this._underlayMovable()) {
      const u = this.store.plan.underlay;
      const orig = { x: u.x, y: u.y };
      const key = `underlay-${++this._gestureSerial}`;
      this._gesture = {
        pointerId: e.pointerId, start: sp, moved: false, cursor: 'move',
        move: (sp2, p2) => {
          const delta = sub(p2, p);
          this.store.update((d) => { d.underlay.x = orig.x + delta.x; d.underlay.y = orig.y + delta.y; }, { label: 'Move image', coalesce: key });
        },
        end: (sp2, p2, ev, moved) => { if (!moved) this.store.select(null); },
      };
      return;
    }
    let last = sp;
    this._gesture = {
      type: 'pan', pointerId: e.pointerId, start: sp, moved: false,
      move: (sp2) => {
        this.view.ox += sp2.x - last.x;
        this.view.oy += sp2.y - last.y;
        last = sp2;
      },
      end: (sp2, p2, ev, moved) => { if (!moved) this.store.select(null); },
    };
  }

  _endsAt(plan, pos) {
    const out = [];
    for (const w of plan.walls) for (const end of ['a', 'b']) if (samePoint(w[end], pos)) out.push({ id: w.id, end });
    return out;
  }

  /** Room corners sitting exactly on a point, so they can follow a wall corner that moves. */
  _verticesAt(plan, pos) {
    const out = [];
    for (const r of plan.rooms) r.points.forEach((q, index) => { if (samePoint(q, pos)) out.push({ id: r.id, index }); });
    return out;
  }

  /**
   * Run a wall edit on the walls, openings and rooms of `start` (the plan when the gesture began),
   * so every pointer move starts fresh: a door clipped by a briefly shorter wall gets its size and
   * place back. Returns the new parts, or null when the edit would shrink a wall to a few
   * centimeters or, unless `turn` is set (end drags rotate walls freely), reverse its direction.
   */
  _rebuildWalls(start, fn, { turn = false } = {}) {
    const next = { walls: clonePlan(start.walls), openings: clonePlan(start.openings), rooms: clonePlan(start.rooms) };
    fn(next);
    const broken = next.walls.some((w, i) => {
      const w0 = start.walls[i];
      return wallLength(w) < Math.min(0.05, wallLength(w0)) || (!turn && dot(wallDir(w), wallDir(w0)) < 0);
    });
    return broken ? null : next;
  }

  _dragGesture(hit, e, sp, p) {
    const plan = this.store.plan;
    const key = `drag-${hit.kind}-${hit.id}-${++this._gestureSerial}`;
    const base = { pointerId: e.pointerId, start: sp, moved: false, threshold: DRAG_PX, cursor: 'move' };
    const entity = findEntity(plan, hit.kind, hit.id);
    if (!entity) return null;
    const update = (fn, label) => this.store.update(fn, { label, coalesce: key });
    switch (hit.kind) {
      case 'item': {
        if (hit.part === 'rotate') {
          return {
            ...base, threshold: 0, cursor: 'grabbing',
            move: (sp2, p2, ev) => {
              const v = sub(p2, entity);
              if (len(v) < 1e-6) return;
              let r = rad2deg(Math.atan2(-v.x, v.y));
              r = ev.shiftKey ? Math.round(r * 10) / 10 : snapValue(r, 15);
              update((d) => { const it = findEntity(d, 'item', hit.id); if (it) it.rotation = normDeg(r); }, 'Rotate item');
            },
          };
        }
        const orig = { x: entity.x, y: entity.y, rotation: entity.rotation || 0 };
        const dims = itemDims(entity);
        return {
          ...base,
          move: (sp2, p2, ev) => {
            const target = add(orig, sub(p2, p));
            const pose = this._snapItemPose(dims, target, orig.rotation, ev.shiftKey);
            this._itemContact = pose.contact;
            update((d) => {
              const it = findEntity(d, 'item', hit.id);
              if (it) { it.x = pose.x; it.y = pose.y; it.rotation = pose.rotation; }
            }, 'Move item');
          },
          end: () => { this._itemContact = null; },
        };
      }
      case 'camera': {
        if (hit.part === 'aim') {
          return {
            ...base, threshold: 0, cursor: 'grabbing',
            move: (sp2, p2, ev) => {
              const v = sub(p2, entity);
              if (len(v) < 1e-6) return;
              let yaw = rad2deg(Math.atan2(v.x, -v.y));
              if (!ev.shiftKey) yaw = snapValue(yaw, 5);
              update((d) => { const c = findEntity(d, 'camera', hit.id); if (c) c.yaw = normDeg(yaw); }, 'Aim view');
            },
          };
        }
        const orig = { x: entity.x, y: entity.y };
        return {
          ...base,
          move: (sp2, p2) => {
            const t = add(orig, sub(p2, p));
            update((d) => { const c = findEntity(d, 'camera', hit.id); if (c) { c.x = t.x; c.y = t.y; } }, 'Move view');
          },
        };
      }
      case 'opening': return this._openingDrag(base, entity, p, update);
      case 'wall': return hit.part ? this._wallEndDrag(base, entity, hit.part, update) : this._wallDrag(base, entity, p, update);
      case 'room': {
        if (hit.part === 'vertex') {
          const n = entity.points.length;
          return {
            ...base, snaps: true, cursor: 'crosshair',
            move: (sp2, p2, ev) => {
              const room = findEntity(this.store.plan, 'room', hit.id);
              if (!room) return;
              const from = room.points[(hit.index - 1 + n) % n];
              const refs = [from, room.points[(hit.index + 1) % n]];
              const excludeVertices = new Set([`${hit.id}:${hit.index}`]);
              const snap = this._snapPoint(p2, { from, refs, shift: ev.shiftKey, excludeVertices, faces: true });
              this._snap = snap;
              update((d) => {
                const r = findEntity(d, 'room', hit.id);
                if (r) r.points[hit.index] = { x: snap.point.x, y: snap.point.y };
              }, 'Move room corner');
            },
          };
        }
        const orig = entity.points.map((q) => ({ ...q }));
        return {
          ...base,
          move: (sp2, p2, ev) => {
            let delta = sub(p2, p);
            if (!ev.shiftKey && this._gridActive()) delta = snapToGrid(delta, this._gridStep());
            update((d) => {
              const r = findEntity(d, 'room', hit.id);
              if (r) r.points = orig.map((q) => add(q, delta));
            }, 'Move room');
          },
        };
      }
      default:
        return null;
    }
  }

  _openingDrag(base, opening, p, update) {
    const plan = this.store.plan;
    let wall = findEntity(plan, 'wall', opening.wallId);
    if (!wall) return null;
    let grab = dot(sub(p, wall.a), wallDir(wall)) - opening.offset;
    const id = opening.id;
    return {
      ...base,
      move: (sp2, p2) => {
        const cur = this.store.plan;
        const o = findEntity(cur, 'opening', id);
        wall = findEntity(cur, 'wall', o?.wallId);
        if (!o || !wall) return;
        const here = projectToSegment(p2, wall.a, wall.b);
        const near = this._nearestWall(p2, Math.max(0.3, this._px(12)), wall.id);
        if (near && here.dist > wall.thickness / 2 + this._px(10) && near.d < here.dist - wall.thickness / 2) {
          const width = Math.min(o.width, this._openingWidth(near.wall, o.type) || 0);
          const c = width ? this._fitOpening(near.wall, width, near.proj.along, id) : null;
          if (c !== null) {
            const side = dot(sub(p2, near.wall.a), wallNormal(near.wall)) >= 0 ? 1 : -1;
            grab = 0;
            update((d) => {
              const op = findEntity(d, 'opening', id);
              if (op) Object.assign(op, { wallId: near.wall.id, offset: c, width, side: o.type === 'window' ? op.side : side });
            }, 'Move opening');
            return;
          }
        }
        const along = dot(sub(p2, wall.a), wallDir(wall)) - grab;
        const c = this._fitOpening(wall, Math.min(o.width, wallLength(wall)), along, id);
        if (c === null) return;
        update((d) => { const op = findEntity(d, 'opening', id); if (op) op.offset = c; }, 'Move opening');
      },
    };
  }

  _wallDrag(base, wall, p, update) {
    const start = this.store.plan;
    const joined = isWallJoined(start, wall.id);
    const n = wallNormal(wall);
    return {
      ...base,
      move: (sp2, p2, ev) => {
        let delta = sub(p2, p);
        const step = this._gridStep();
        if (joined) {
          let dn = dot(delta, n);
          if (!ev.shiftKey && this._gridActive()) dn = snapValue(dn, step);
          delta = mul(n, dn);
        } else if (!ev.shiftKey && this._gridActive()) {
          delta = snapToGrid(delta, step);
        }
        const next = this._rebuildWalls(start, (d) => moveWall(d, wall.id, delta.x, delta.y));
        if (next) update((d) => Object.assign(d, next), 'Move wall');
      },
    };
  }

  _wallEndDrag(base, wall, end, update) {
    const start = this.store.plan;
    const pos = { ...wall[end] };
    const group = this._endsAt(start, pos);
    const other = { ...wall[end === 'a' ? 'b' : 'a'] };
    const excludeEnds = new Set(group.map((g) => `${g.id}:${g.end}`));
    const excludeWalls = new Set(group.map((g) => g.id));
    const excludeVertices = new Set(this._verticesAt(start, pos).map((v) => `${v.id}:${v.index}`));
    const others = group.map((g) => {
      const w = findEntity(start, 'wall', g.id);
      return w[g.end === 'a' ? 'b' : 'a'];
    });
    return {
      ...base, snaps: true, cursor: 'crosshair',
      move: (sp2, p2, ev) => {
        const snap = this._snapPoint(p2, { from: other, refs: [other, ...others], shift: ev.shiftKey, excludeEnds, excludeWalls, excludeVertices });
        this._snap = snap;
        const q = snap.point;
        if (others.some((o) => dist(o, q) < 0.05)) return;
        const next = this._rebuildWalls(start, (d) => moveWallEndpoint(d, wall.id, end, q), { turn: true });
        if (next) update((d) => Object.assign(d, next), 'Move wall end');
      },
      end: () => { this._snap = null; },
    };
  }

  // ---- Wall tool -----------------------------------------------------------------------------

  _wallDown(e, p) {
    const snap = this._wallSnap(p, e.shiftKey);
    this._snap = snap;
    const d = this._draft;
    if (!d || d.type !== 'wall') {
      this._draft = { type: 'wall', start: { ...snap.point }, first: { ...snap.point }, ids: [] };
      this._typed = '';
      return;
    }
    const end = this._typedEnd(d.start, snap.point, this._refDir()) || snap.point;
    this._commitWallSegment(end);
  }

  _commitWallSegment(end) {
    const d = this._draft;
    if (!d || d.type !== 'wall') return false;
    const minLen = Math.max(0.05, this._px(4));
    if (dist(end, d.start) < minLen) return false;
    const a = { ...d.start }, b = { x: end.x, y: end.y };
    const plan = this.store.plan;
    const dup = plan.walls.find((w) => (samePoint(w.a, a) && samePoint(w.b, b)) || (samePoint(w.a, b) && samePoint(w.b, a)));
    if (!dup) {
      let id = null;
      this.store.update((draft) => { id = addWall(draft, a, b, { kind: this._wallKind }).id; }, { label: 'Draw wall' });
      d.ids.push(id);
    }
    this._typed = '';
    if (d.ids.length >= 2 && samePoint(b, d.first)) {
      this._finishDraft();
      return true;
    }
    d.start = b;
    this._refreshHover();
    return true;
  }

  // ---- Room tool -----------------------------------------------------------------------------

  _roomDown(e, sp, p) {
    const snap = this._roomSnap(p, e.shiftKey);
    const d = this._draft;
    if (d?.type === 'room' && d.points?.length) {
      const first = d.points[0];
      if (d.points.length >= 3 && (snap.kind === 'close' || dist(toScreen(this.view, snap.point), toScreen(this.view, first)) <= SNAP_PX)) {
        this._finishRoom();
        return;
      }
      const last = d.points[d.points.length - 1];
      const q = this._typedEnd(last, snap.point, this._refDir()) || snap.point;
      if (dist(toScreen(this.view, q), toScreen(this.view, last)) < 4) return;
      d.points.push({ x: q.x, y: q.y });
      this._typed = '';
      this._refreshHover();
      return;
    }
    const start = { ...snap.point };
    const startKind = snap.kind;
    this._gesture = {
      pointerId: e.pointerId, start: sp, moved: false, threshold: DRAG_PX, snaps: true, cursor: 'crosshair',
      move: (sp2, p2, ev) => {
        const s2 = this._snapPoint(p2, { shift: ev.shiftKey, faces: true });
        this._snap = s2;
        this._draft = { type: 'room', rect: [start, s2.point] };
      },
      end: (sp2, p2, ev, moved) => {
        if (moved && this._draft?.rect) {
          const [a, b] = this._draft.rect;
          this._draft = null;
          if (Math.abs(b.x - a.x) > 0.15 && Math.abs(b.y - a.y) > 0.15) {
            this._createRoom([a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]);
          }
          return;
        }
        if (!startKind || startKind === 'grid') {
          const plan = this.store.plan;
          const onWall = plan.walls.some((w) => projectToSegment(p, w.a, w.b).dist <= w.thickness / 2 + this._px(4));
          const room = onWall ? null : this._roomAt(p);
          if (room) {
            this.store.select({ kind: 'room', id: room.id });
            this._flash('This area already has a room. To trace another one inside it, start on a wall or drag a rectangle.');
            return;
          }
          const face = !onWall ? findEnclosure(plan.walls, p) : null;
          if (face) {
            this._createRoom(face);
            this._flash(`Room created from the surrounding walls (${formatArea(polygonArea(face), plan.units)}).`);
            return;
          }
        }
        this._draft = { type: 'room', points: [start] };
      },
    };
  }

  /** The smallest room containing p, or null. */
  _roomAt(p) {
    let best = null, bestA = Infinity;
    for (const r of this.store.plan.rooms) {
      if (r.points.length < 3 || !pointInPolygon(p, r.points)) continue;
      const a = polygonArea(r.points);
      if (a < bestA) { bestA = a; best = r; }
    }
    return best;
  }

  _createRoom(points) {
    const pts = polygonSignedArea(points) < 0 ? [...points].reverse() : points;
    let id = null;
    this.store.update((d) => { id = addRoom(d, pts).id; }, { label: 'Add room' });
    if (id) this.store.select({ kind: 'room', id });
    return id;
  }

  _finishRoom() {
    const d = this._draft;
    this._draft = null;
    this._typed = '';
    if (d?.points?.length >= 3 && polygonArea(d.points) > 0.05) this._createRoom(d.points);
    this._refreshHover();
  }

  // ---- Camera and calibrate tools ----------------------------------------------------------

  _cameraDown(e, sp, p) {
    this._draft = { type: 'camera', x: p.x, y: p.y, yaw: this._lastYaw, name: nextName(this.store.plan.cameras, 'View') };
    this._gesture = {
      pointerId: e.pointerId, start: sp, moved: false, threshold: 0, cursor: 'crosshair',
      move: (sp2, p2, ev) => {
        const d = this._draft;
        if (!d || dist(sp2, sp) < 6) return;
        let yaw = rad2deg(Math.atan2(p2.x - d.x, -(p2.y - d.y)));
        if (!ev.shiftKey) yaw = snapValue(yaw, 5);
        d.yaw = normDeg(yaw);
      },
      end: () => {
        const d = this._draft;
        this._draft = null;
        if (!d) return;
        this._lastYaw = d.yaw;
        let id = null;
        this.store.update((draft) => { id = addCamera(draft, d.x, d.y, d.yaw, { name: d.name }).id; }, { label: 'Add view' });
        if (id) this.store.select({ kind: 'camera', id });
      },
    };
  }

  _calibrateDown(e, sp, p) {
    if (!this.store.plan.underlay) {
      this._flash('Add a floor plan image first, then calibrate its scale.');
      return;
    }
    const d = this._draft;
    if (!d || d.type !== 'calibrate' || d.b) {
      this._draft = { type: 'calibrate', a: { x: p.x, y: p.y }, b: null };
      return;
    }
    // The end point is set on release, and the length is asked for once the click is over, so
    // the dialog that opens keeps keyboard focus.
    this._gesture = {
      pointerId: e.pointerId, start: sp, moved: false, threshold: 0,
      move: () => {},
      end: (sp2, p2, ev) => {
        if (ev.type === 'pointercancel' || this._draft !== d) return;
        const b = ev.shiftKey ? { ...p2 } : (this._angleSnap(d.a, p2)?.point || { ...p2 });
        if (dist(toScreen(this.view, b), toScreen(this.view, d.a)) < 4) return;
        d.b = b;
        const detail = { a: { ...d.a }, b: { ...b }, meters: dist(d.a, b) };
        setTimeout(() => {
          if (!this._destroyed && this._draft === d) this.dispatchEvent(new CustomEvent('calibrate', { detail }));
        }, 0);
      },
    };
  }

  // ---- Drafts ---------------------------------------------------------------------------------

  _finishDraft() {
    const d = this._draft;
    if (!d) return;
    if (d.type === 'room' && d.points) {
      this._finishRoom();
      return;
    }
    this._draft = null;
    this._typed = '';
    this._snap = null;
    this._refreshHover();
  }

  _onStoreChange(e) {
    const detail = e.detail || {};
    if (detail.replaced) {
      this._gesture = null;
      this._resetTransient();
      this._lastOpeningGhost = null;
      this.zoomToFit();
    } else if (detail.undo || detail.redo) {
      const d = this._draft;
      if (d?.type === 'wall') {
        const plan = this.store.plan;
        const before = d.ids.length;
        d.ids = d.ids.filter((id) => findEntity(plan, 'wall', id));
        if (d.ids.length !== before) {
          const last = d.ids.length ? findEntity(plan, 'wall', d.ids[d.ids.length - 1]) : null;
          d.start = last ? { ...last.b } : { ...d.first };
        }
      }
    }
    this._refreshHover();
    this._invalidate();
  }

  // ---- Keyboard -------------------------------------------------------------------------------

  _onKeyDown(e) {
    if (isTextTarget(e.target) && e.target !== this.canvas) return;
    const key = e.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    const mod = e.ctrlKey || e.metaKey;
    this._shift = e.shiftKey;

    if (!mod && !e.altKey && this._acceptsLength() && this._typeLengthKey(e)) {
      e.preventDefault();
      this._invalidate();
      return;
    }
    if (mod && lower === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.store.redo(); else this.store.undo();
      return;
    }
    if (mod && lower === 'y') {
      e.preventDefault();
      this.store.redo();
      return;
    }
    if (mod && lower === 'd') {
      e.preventDefault();
      this._duplicateSelection();
      return;
    }
    if (mod || e.altKey) return;

    switch (key) {
      case ' ':
        e.preventDefault();
        if (!this._spaceDown) {
          this._spaceDown = true;
          this._setCursor();
        }
        return;
      case 'Escape':
        e.preventDefault();
        this._escape();
        break;
      case 'Enter':
        e.preventDefault();
        if (this._draft) this._finishDraft();
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        if (this._draft?.type === 'room' && this._draft.points?.length > 1) {
          this._draft.points.pop();
        } else if (!this._draft && this.store.selection) {
          this.store.deleteSelection();
        }
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown':
        e.preventDefault();
        this._nudge(key, e.shiftKey);
        break;
      case '0':
        this.zoomToFit();
        break;
      case '=':
      case '+':
        this.zoomBy(1.25);
        break;
      case '-':
      case '_':
        this.zoomBy(0.8);
        break;
      default:
        if (lower === 'q' || lower === 'e') {
          e.preventDefault();
          this._rotateKey(lower === 'q' ? -1 : 1, e.shiftKey);
        } else if (lower === 'f') {
          this._flipOpening(e.shiftKey);
        } else if (KEY_TOOLS[lower]) {
          this.setTool(KEY_TOOLS[lower]);
        } else {
          return;
        }
    }
    this._refreshHover();
    this._invalidate();
  }

  _onKeyUp(e) {
    if (e.key === ' ') {
      this._spaceDown = false;
      this._setCursor();
    }
    if (e.key.startsWith('Arrow') || /^[qQeE]$/.test(e.key)) {
      this.store.endCoalesce();
      this._nudgeRun = null;
    }
    if (e.key === 'Shift') {
      this._shift = false;
      this._refreshHover();
      this._invalidate();
    }
  }

  _onBlur() {
    this._spaceDown = false;
    this._setCursor();
  }

  /** Handle a key while a length can be typed. Returns true when the key was consumed. */
  _typeLengthKey(e) {
    const key = e.key;
    if (key === 'Enter' && this._typed) {
      this._applyTypedLength();
      return true;
    }
    if (key === 'Backspace' && this._typed) {
      this._typed = this._typed.slice(0, -1);
      return true;
    }
    if (key === 'Escape' && this._typed) {
      this._typed = '';
      return true;
    }
    if (key.length !== 1) return false;
    if (!this._typed) {
      if (!/[0-9.]/.test(key)) return false;
    } else if (!/^[0-9.,'"/ mcftine-]$/i.test(key)) {
      return false;
    }
    if (this._typed.length >= 16) return true;
    this._typed += key;
    return true;
  }

  _applyTypedLength() {
    const L = this._typedLength();
    if (!(L > 0)) {
      this._flash(`"${this._typed}" is not a length. Try 12' 6" or 3.5m.`);
      this._typed = '';
      return;
    }
    const d = this._draft;
    if (d.type === 'wall') {
      const end = this._wallPreviewEnd();
      if (end) this._commitWallSegment(end);
    } else if (d.type === 'room') {
      const end = this._roomPreviewEnd();
      if (end) {
        d.points.push({ x: end.x, y: end.y });
        this._typed = '';
      }
    }
  }

  _escape() {
    if (this._typed) { this._typed = ''; return; }
    if (this._gesture) return;
    if (this._draft) {
      if (this._draft.type === 'room' && this._draft.points) {
        this._draft = null;
      } else {
        this._finishDraft();
      }
      return;
    }
    if (this._tool !== 'select') {
      this.setTool('select');
      return;
    }
    this.store.select(null);
  }

  _nudge(key, big) {
    const sel = this.store.selection;
    if (!sel) return;
    const metric = this._units === 'metric';
    const step = metric ? (big ? 0.1 : 0.01) : (big ? FOOT : INCH);
    const v = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } }[key];
    const opts = { label: `Nudge ${KIND_LABEL[sel.kind]}`, coalesce: `nudge-${sel.kind}-${sel.id}` };
    if (sel.kind === 'wall') {
      // A run of nudges (one key press or a held key) rebuilds from where it began, like a drag.
      const run = this._nudgeRun?.key === opts.coalesce && this._nudgeRun.plan === this.store.plan
        ? this._nudgeRun : { key: opts.coalesce, start: this.store.plan, total: { x: 0, y: 0 } };
      // As when dragging, a wall joined to others only moves across its length.
      const wall = findEntity(run.start, 'wall', sel.id);
      if (!wall) return;
      const n = wallNormal(wall);
      const step = isWallJoined(run.start, sel.id) ? mul(n, dot(v, n)) : v;
      if (len(step) < 1e-9) {
        this._flash('Joined walls move only across their length. Drag an end to reshape the wall.');
        return;
      }
      const total = add(run.total, step);
      const next = this._rebuildWalls(run.start, (d) => moveWall(d, sel.id, total.x, total.y));
      if (!next) return;
      this.store.update((d) => Object.assign(d, next), opts);
      this._nudgeRun = { ...run, total, plan: this.store.plan };
      return;
    }
    this.store.update((d) => {
      const ent = findEntity(d, sel.kind, sel.id);
      if (!ent) return;
      if (sel.kind === 'item' || sel.kind === 'camera') {
        ent.x += v.x;
        ent.y += v.y;
      } else if (sel.kind === 'room') {
        ent.points = ent.points.map((q) => add(q, v));
      } else if (sel.kind === 'opening') {
        const w = findEntity(d, 'wall', ent.wallId);
        if (!w) return;
        const along = dot(v, wallDir(w));
        if (Math.abs(along) < 1e-9) return;
        const c = this._fitOpening(w, ent.width, ent.offset + along, ent.id);
        if (c !== null) ent.offset = c;
      }
    }, opts);
  }

  _rotateKey(dir, big) {
    const delta = dir * (big ? 90 : 15);
    if (this._tool === 'item') {
      this._pendingRotation = normDeg(this._pendingRotation + delta);
      return;
    }
    const sel = this.store.selection;
    if (sel?.kind === 'item') {
      this.store.update((d) => {
        const it = findEntity(d, 'item', sel.id);
        if (it) it.rotation = normDeg((it.rotation || 0) + delta);
      }, { label: 'Rotate item', coalesce: `rotate-${sel.id}` });
    } else if (sel?.kind === 'camera') {
      this.store.update((d) => {
        const c = findEntity(d, 'camera', sel.id);
        if (c) c.yaw = normDeg((c.yaw || 0) + delta);
      }, { label: 'Aim view', coalesce: `aim-${sel.id}` });
    }
  }

  _flipOpening(hinge) {
    const sel = this.store.selection;
    if (sel?.kind !== 'opening') return;
    this.store.update((d) => {
      const o = findEntity(d, 'opening', sel.id);
      if (!o) return;
      if (hinge) o.hinge = o.hinge === 'end' ? 'start' : 'end';
      else o.side = o.side < 0 ? 1 : -1;
    }, { label: hinge ? 'Flip door hinge' : 'Flip door swing' });
  }

  _duplicateSelection() {
    const sel = this.store.selection;
    if (sel?.kind !== 'item' && sel?.kind !== 'camera') return;
    const src = this.store.selected;
    if (!src) return;
    let id = null;
    if (sel.kind === 'item') {
      this.store.update((d) => {
        const props = { rotation: src.rotation };
        for (const k of ['w', 'd', 'h', 'color', 'label']) if (src[k] !== undefined) props[k] = src[k];
        const it = addItem(d, src.type, src.x + 0.3, src.y + 0.3, props);
        if (src.elevation !== undefined) it.elevation = src.elevation;
        id = it.id;
      }, { label: 'Duplicate item' });
    } else {
      this.store.update((d) => { id = addCamera(d, src.x + 0.3, src.y + 0.3, src.yaw, { pitch: src.pitch }).id; }, { label: 'Duplicate view' });
    }
    if (id) this.store.select({ kind: sel.kind, id });
  }
}
