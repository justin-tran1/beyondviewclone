// Draws a plan onto a 2D canvas: grid, underlay, rooms, walls, openings, items, cameras,
// dimensions, selection and the walkthrough marker. Pure drawing, no DOM listeners.
// Shared by the editor and the walkthrough minimap. All drawing happens in CSS pixels;
// the caller has already scaled ctx for devicePixelRatio.
import { FLOORS } from './model.js';
import { getItem, itemDims } from './catalog/registry.js';
import {
  FOOT, INCH, add, sub, scale as mul, dot, cross, dist, len, clamp, deg2rad, rotate,
  wallLength, wallDir, wallNormal, pointOnWall, openingSpan,
  polygonArea, polygonCentroid, pointInPolygon, projectToSegment, boundsOf, emptyBounds,
  itemCorners, formatLength, formatArea,
} from './geometry.js';

const FONT_STACK = 'Calibre, "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

export const THEME = {
  fontFamily: FONT_STACK,
  background: '#FBFBFB',
  miniBackground: 'rgba(251, 251, 251, 0.94)',
  gridMinor: '#ECEFEF',
  gridMajor: '#DDE2E3',
  walls: { exterior: '#435254', interior: '#6B7779', partial: '#B3BCBE', glass: '#80BBAD' },
  partialHatch: 'rgba(67, 82, 84, 0.55)',
  glassFill: '#D5E9E3',
  glassLine: '#538184',
  symbol: '#435254',
  symbolSoft: '#7F8480',
  windowFill: '#FFFFFF',
  roomEdge: 'rgba(67, 82, 84, 0.28)',
  text: '#435254',
  textSoft: '#7F8480',
  halo: 'rgba(251, 251, 251, 0.92)',
  divider: '#C7C8CA',
  dimension: '#7F8480',
  selection: '#003F2D',
  selectionFill: 'rgba(0, 63, 45, 0.07)',
  hover: 'rgba(0, 63, 45, 0.42)',
  hoverFill: 'rgba(0, 63, 45, 0.05)',
  handleFill: '#FFFFFF',
  snap: '#17E88F',
  snapStroke: '#012A2D',
  guide: '#80BBAD',
  camera: '#003F2D',
  walker: '#003F2D',
  ghost: '#003F2D',
  item: { line: '#435254', fill: '#FFFFFF', accent: '#003F2D', muted: '#7F8480', light: '#CAD1D3', glass: '#80BBAD' },
};

/** CSS font shorthand in the UI family. */
export const fontSpec = (size, weight = 400) => `${weight} ${size}px ${FONT_STACK}`;

export const HANDLE = { wall: 8, vertex: 4.5, rotate: 5.5, rotateGap: 20, camera: 7, cameraAim: 30 };

const KIND_ORDER = ['glass', 'partial', 'interior', 'exterior'];
const KIND_RANK = { glass: 0, partial: 1, interior: 2, exterior: 3 };
const DEFAULT_BOUNDS = { minX: 0, minY: 0, maxX: 20, maxY: 12 };

// ---- View transforms -------------------------------------------------------

export function fitView(bounds, width, height, padding = 40) {
  const b = { ...(emptyBounds(bounds) ? DEFAULT_BOUNDS : bounds) };
  const minSpan = 2;
  for (const [lo, hi] of [['minX', 'maxX'], ['minY', 'maxY']]) {
    const span = b[hi] - b[lo];
    if (span < minSpan) {
      const c = (b[hi] + b[lo]) / 2;
      b[lo] = c - minSpan / 2;
      b[hi] = c + minSpan / 2;
    }
  }
  const pad = Math.min(padding, width / 4, height / 4);
  const s = Math.min((width - pad * 2) / (b.maxX - b.minX), (height - pad * 2) / (b.maxY - b.minY));
  const scale = Number.isFinite(s) && s > 0 ? s : 40;
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  return { scale, ox: width / 2 - cx * scale, oy: height / 2 - cy * scale, width, height };
}

export const toScreen = (view, p) => ({ x: view.ox + p.x * view.scale, y: view.oy + p.y * view.scale });
export const toPlan = (view, sx, sy) => ({ x: (sx - view.ox) / view.scale, y: (sy - view.oy) / view.scale });

/** Plan-space corners of the underlay image (clockwise from its top-left). */
export function underlayCorners(u) {
  const w = (u.width || 0) * u.scale, h = (u.height || 0) * u.scale;
  const o = { x: u.x, y: u.y };
  return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]
    .map((p) => rotate(add(o, p), u.rotation || 0, o));
}

/** Bounds of walls, rooms, items, cameras and (unless { underlay: false }) the underlay image. */
export function planBounds(plan, { underlay = true } = {}) {
  const pts = [];
  for (const w of plan.walls || []) {
    const h = (w.thickness || 0) / 2;
    for (const p of [w.a, w.b]) pts.push({ x: p.x - h, y: p.y - h }, { x: p.x + h, y: p.y + h });
  }
  for (const r of plan.rooms || []) pts.push(...r.points);
  for (const it of plan.items || []) pts.push(...itemCorners(it, itemDims(it)));
  for (const c of plan.cameras || []) pts.push(c);
  const u = plan.underlay;
  if (underlay && u && u.width > 0 && u.height > 0) pts.push(...underlayCorners(u));
  return boundsOf(pts);
}

/** Bounds of walls only (outer faces), or of rooms when there are no walls. */
function shellBounds(plan) {
  const pts = [];
  for (const w of plan.walls) {
    const h = w.thickness / 2;
    for (const p of [w.a, w.b]) pts.push({ x: p.x - h, y: p.y - h }, { x: p.x + h, y: p.y + h });
  }
  if (!pts.length) for (const r of plan.rooms) pts.push(...r.points);
  return boundsOf(pts);
}

// ---- Underlay images -------------------------------------------------------

const IMAGES = new Map();
const IMAGE_CACHE_LIMIT = 4;

function imageEntry(src) {
  let entry = IMAGES.get(src);
  if (entry) {
    IMAGES.delete(src);
    IMAGES.set(src, entry);
    return entry;
  }
  const img = new Image();
  entry = { img, ready: false, failed: false, listeners: new Set(), promise: null };
  entry.promise = new Promise((resolve) => {
    img.onload = () => { entry.ready = true; resolve(img); };
    img.onerror = () => { entry.failed = true; resolve(null); };
  }).then((result) => {
    for (const fn of entry.listeners) fn(result);
    entry.listeners.clear();
    return result;
  });
  img.decoding = 'async';
  img.src = src;
  IMAGES.set(src, entry);
  while (IMAGES.size > IMAGE_CACHE_LIMIT) IMAGES.delete(IMAGES.keys().next().value);
  return entry;
}

/** Start (or reuse) loading an underlay image. Resolves with the image, or null if it failed. */
export const loadUnderlayImage = (src) => imageEntry(src).promise;

// ---- Small drawing helpers -------------------------------------------------

function deviceScale(ctx) {
  const t = ctx.getTransform ? ctx.getTransform() : null;
  return t ? Math.hypot(t.a, t.b) || 1 : 1;
}

function polyPath(path, view, pts) {
  const p0 = toScreen(view, pts[0]);
  path.moveTo(p0.x, p0.y);
  for (let i = 1; i < pts.length; i++) {
    const p = toScreen(view, pts[i]);
    path.lineTo(p.x, p.y);
  }
  path.closePath();
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const uprightAngle = (a) => (a > Math.PI / 2 + 1e-3 ? a - Math.PI : a <= -Math.PI / 2 + 1e-3 ? a + Math.PI : a);

/**
 * A rounded label. tone: 'plain' (white, grey border), 'active' (CBRE green) or 'input'
 * (white with a green border, used while typing a length). Returns the pill width.
 */
export function drawPill(ctx, x, y, text, { angle = 0, size = 11.5, weight = 600, tone = 'plain' } = {}) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.font = fontSpec(size, weight);
  const w = Math.ceil(ctx.measureText(text).width) + 12;
  const h = Math.round(size + 8);
  roundRectPath(ctx, -w / 2, -h / 2, w, h, 4);
  const active = tone === 'active';
  ctx.fillStyle = active ? THEME.selection : '#FFFFFF';
  ctx.fill();
  if (!active) {
    ctx.lineWidth = tone === 'input' ? 1.5 : 1;
    ctx.strokeStyle = tone === 'input' ? THEME.selection : THEME.divider;
    ctx.stroke();
  }
  ctx.fillStyle = active ? '#FFFFFF' : tone === 'input' ? THEME.selection : THEME.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 0.5);
  ctx.restore();
  return w;
}

/**
 * Architectural dimension between plan points a and b: extension lines, tick marks and a label.
 * base: px from the a-b line where extension lines start. offset: px from a-b to the dimension
 * line. side: 1 or -1 relative to the screen normal of a->b; 0 picks the side above or left.
 */
export function drawDimension(ctx, view, a, b, { text, units = 'imperial', base = 0, offset = 16, side = 0, tone = 'plain' } = {}) {
  const A = toScreen(view, a), B = toScreen(view, b);
  const L = dist(A, B);
  if (L < 1) return;
  const d = { x: (B.x - A.x) / L, y: (B.y - A.y) / L };
  let n = { x: d.y, y: -d.x };
  if (side) n = mul(n, side);
  else if (n.y > 1e-3 || (Math.abs(n.y) <= 1e-3 && n.x > 0)) n = mul(n, -1);
  const A1 = add(A, mul(n, offset)), B1 = add(B, mul(n, offset));
  ctx.save();
  ctx.strokeStyle = tone === 'plain' ? THEME.dimension : THEME.selection;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const P of [A, B]) {
    const s = add(P, mul(n, base + 3)), e = add(P, mul(n, offset + 4));
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(e.x, e.y);
  }
  ctx.moveTo(A1.x, A1.y);
  ctx.lineTo(B1.x, B1.y);
  const tick = mul({ x: (d.x + n.x) * Math.SQRT1_2, y: (d.y + n.y) * Math.SQRT1_2 }, 4);
  for (const P of [A1, B1]) {
    ctx.moveTo(P.x - tick.x, P.y - tick.y);
    ctx.lineTo(P.x + tick.x, P.y + tick.y);
  }
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
  const label = text ?? formatLength(dist(a, b), units);
  const angle = uprightAngle(Math.atan2(d.y, d.x));
  ctx.save();
  ctx.font = fontSpec(11.5, 600);
  const tw = ctx.measureText(label).width + 12;
  ctx.restore();
  const mid = mul(add(A1, B1), 0.5);
  const pos = L < tw + 14 ? add(mid, mul(n, 13)) : mid;
  drawPill(ctx, pos.x, pos.y, label, { angle, tone });
}

/** Small accent-green marker for a snap target. kind: endpoint, vertex, midpoint, on-wall, close, grid. */
export function drawSnapMarker(ctx, view, p, kind) {
  const s = toScreen(view, p);
  ctx.save();
  ctx.fillStyle = THEME.snap;
  ctx.strokeStyle = THEME.snapStroke;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  if (kind === 'midpoint') {
    ctx.moveTo(s.x, s.y - 5.5);
    ctx.lineTo(s.x + 5.5, s.y + 4);
    ctx.lineTo(s.x - 5.5, s.y + 4);
    ctx.closePath();
  } else if (kind === 'on-wall') {
    ctx.moveTo(s.x, s.y - 5.5);
    ctx.lineTo(s.x + 5.5, s.y);
    ctx.lineTo(s.x, s.y + 5.5);
    ctx.lineTo(s.x - 5.5, s.y);
    ctx.closePath();
  } else if (kind === 'close') {
    ctx.arc(s.x, s.y, 6.5, 0, Math.PI * 2);
  } else if (kind === 'grid') {
    ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
  } else {
    ctx.rect(s.x - 4.5, s.y - 4.5, 9, 9);
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Screen position of an item's rotate handle (beyond its front edge). */
export function itemHandlePoint(view, item) {
  const { d } = itemDims(item);
  const local = { x: 0, y: d / 2 + HANDLE.rotateGap / view.scale };
  return toScreen(view, rotate(add(item, local), item.rotation || 0, item));
}

/** Screen position of a camera's aim handle (at the tip of its view wedge). */
export function cameraHandlePoint(view, cam) {
  const c = toScreen(view, cam);
  const a = deg2rad((cam.yaw || 0) - 90);
  return { x: c.x + Math.cos(a) * HANDLE.cameraAim, y: c.y + Math.sin(a) * HANDLE.cameraAim };
}

// ---- Grid --------------------------------------------------------------------

// Finest first: 6 in and 10 cm lines (the editor's snap step) appear once zoomed in far enough.
const GRID_LEVELS = {
  imperial: [[6 * INCH, 5 * FOOT], [FOOT, 5 * FOOT], [5 * FOOT, 25 * FOOT], [25 * FOOT, 100 * FOOT], [100 * FOOT, 500 * FOOT]],
  metric: [[0.1, 1], [0.5, 1], [1, 5], [5, 25], [25, 100], [100, 500]],
};

/** Minor and major grid spacing (meters) for a units system at a zoom level. */
export function gridSpacing(units, scale) {
  const levels = GRID_LEVELS[units] || GRID_LEVELS.imperial;
  for (const [minor, major] of levels) if (minor * scale >= 8) return { minor, major };
  const [minor, major] = levels[levels.length - 1];
  return { minor, major };
}

function drawGrid(ctx, view, units) {
  const { minor, major } = gridSpacing(units, view.scale);
  const dpr = deviceScale(ctx);
  const hair = 1 / dpr;
  const x0 = -view.ox / view.scale, x1 = (view.width - view.ox) / view.scale;
  const y0 = -view.oy / view.scale, y1 = (view.height - view.oy) / view.scale;
  const lines = (step, color, alpha, skipEvery) => {
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha;
    const ratio = skipEvery ? Math.round(skipEvery / step) : 0;
    for (let i = Math.ceil(x0 / step); i <= Math.floor(x1 / step); i++) {
      if (ratio && i % ratio === 0) continue;
      const sx = Math.round((view.ox + i * step * view.scale) * dpr) / dpr;
      ctx.fillRect(sx, 0, hair * Math.max(1, Math.round(dpr * 0.75)), view.height);
    }
    for (let j = Math.ceil(y0 / step); j <= Math.floor(y1 / step); j++) {
      if (ratio && j % ratio === 0) continue;
      const sy = Math.round((view.oy + j * step * view.scale) * dpr) / dpr;
      ctx.fillRect(0, sy, view.width, hair * Math.max(1, Math.round(dpr * 0.75)));
    }
  };
  ctx.save();
  const fade = clamp((minor * view.scale - 8) / 12, 0, 1);
  lines(minor, THEME.gridMinor, 0.45 + 0.55 * fade, major);
  lines(major, THEME.gridMajor, 1, 0);
  ctx.restore();
}

// ---- Underlay ---------------------------------------------------------------

function drawUnderlay(ctx, view, u, onLoad) {
  const entry = imageEntry(u.src);
  if (!entry.ready) {
    if (!entry.failed && typeof onLoad === 'function') entry.listeners.add(onLoad);
    return;
  }
  const img = entry.img;
  const o = toScreen(view, u);
  const s = u.scale * view.scale;
  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.rotate(deg2rad(u.rotation || 0));
  ctx.scale(s, s);
  ctx.globalAlpha = clamp(u.opacity ?? 0.5, 0, 1);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, u.width || img.naturalWidth, u.height || img.naturalHeight);
  ctx.restore();
}

// ---- Wall geometry (mitered joints, cached per walls array) ------------------

const geometryCache = new WeakMap();

const nodeKey = (p) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;

function lineIntersect(p, d, q, e) {
  const c = cross(d, e);
  if (Math.abs(c) < 1e-9) return null;
  const s = cross(sub(q, p), e) / c;
  return add(p, mul(d, s));
}

function convexHull(points) {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const turn = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

const signedArea = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
};

/** Orient a polygon the same way as wall pieces (negative signed area) so nonzero fills union. */
const orientLikeWalls = (pts) => (signedArea(pts) > 0 ? [...pts].reverse() : pts);

function endInfo(gi, end) {
  return gi.ends[end];
}

function outward(gi, end) {
  return end === 'a' ? gi.u : mul(gi.u, -1);
}

function joinPair(e1, e2, P, hulls) {
  const g1 = e1.gi, g2 = e2.gi;
  const v1 = outward(g1, e1.end), v2 = outward(g2, e2.end);
  if (Math.abs(cross(v1, v2)) < 0.02) return;
  const r1 = KIND_RANK[g1.wall.kind] ?? 2, r2 = KIND_RANK[g2.wall.kind] ?? 2;
  if (r1 !== r2) {
    const [hi, lo] = r1 > r2 ? [e1, e2] : [e2, e1];
    const ext = mul(outward(hi.gi, hi.end), -lo.gi.h);
    const info = endInfo(hi.gi, hi.end);
    info.P = add(info.P, ext);
    info.N = add(info.N, ext);
    return;
  }
  const s1 = Math.sign(dot(g1.n, v2)), s2 = Math.sign(dot(g2.n, v1));
  const inner = lineIntersect(add(P, mul(g1.n, s1 * g1.h)), v1, add(P, mul(g2.n, s2 * g2.h)), v2);
  const outer = lineIntersect(sub(P, mul(g1.n, s1 * g1.h)), v1, sub(P, mul(g2.n, s2 * g2.h)), v2);
  const limit = 4 * Math.max(g1.h, g2.h);
  const fits = (pt) => pt && dist(pt, P) <= limit
    && dot(sub(pt, P), v1) < g1.L * 0.9 && dot(sub(pt, P), v2) < g2.L * 0.9;
  if (!fits(inner) || !fits(outer)) {
    const i1 = endInfo(g1, e1.end), i2 = endInfo(g2, e2.end);
    hulls.push({ kind: g1.wall.kind, points: orientLikeWalls(convexHull([P, i1.P, i1.N, i2.P, i2.N])) });
    return;
  }
  const set = (e, s) => {
    const info = endInfo(e.gi, e.end);
    if (s > 0) { info.P = inner; info.N = outer; } else { info.N = inner; info.P = outer; }
  };
  set(e1, s1);
  set(e2, s2);
}

/** At a junction of 3+ walls, run each end through to the far faces of the walls it meets. */
function extendIntoJunction(ends) {
  const shifts = ends.map((e) => {
    const v = outward(e.gi, e.end);
    let ext = 0;
    for (const o of ends) {
      if (o !== e && Math.abs(cross(v, outward(o.gi, o.end))) > 0.1) ext = Math.max(ext, o.gi.h);
    }
    return mul(v, -ext);
  });
  ends.forEach((e, k) => {
    const info = endInfo(e.gi, e.end);
    info.P = add(info.P, shifts[k]);
    info.N = add(info.N, shifts[k]);
  });
}

/**
 * Geometry for every wall: unit direction u, normal n, half thickness h and end corners on the
 * +n (P) and -n (N) sides, mitered at two-wall corners. Junctions of 3+ walls get a hull patch.
 */
export function wallGeometry(walls) {
  let geo = geometryCache.get(walls);
  if (geo) return geo;
  const info = new Map();
  for (const w of walls) {
    const L = wallLength(w);
    if (L < 1e-4) continue;
    const u = wallDir(w), n = wallNormal(w), h = w.thickness / 2;
    info.set(w.id, {
      wall: w, L, u, n, h,
      ends: {
        a: { P: add(w.a, mul(n, h)), N: sub(w.a, mul(n, h)), joined: false },
        b: { P: add(w.b, mul(n, h)), N: sub(w.b, mul(n, h)), joined: false },
      },
    });
  }
  const nodes = new Map();
  for (const gi of info.values()) {
    for (const end of ['a', 'b']) {
      const key = nodeKey(gi.wall[end]);
      let node = nodes.get(key);
      if (!node) nodes.set(key, (node = { p: gi.wall[end], ends: [] }));
      node.ends.push({ gi, end });
    }
  }
  const hulls = [];
  for (const node of nodes.values()) {
    const { ends } = node;
    if (ends.length < 2) continue;
    for (const e of ends) e.gi.ends[e.end].joined = true;
    if (ends.length === 2) {
      joinPair(ends[0], ends[1], node.p, hulls);
    } else {
      const pts = [node.p];
      let kind = ends[0].gi.wall.kind;
      for (const e of ends) {
        const i = endInfo(e.gi, e.end);
        pts.push(i.P, i.N);
        if ((KIND_RANK[e.gi.wall.kind] ?? 2) > (KIND_RANK[kind] ?? 2)) kind = e.gi.wall.kind;
      }
      hulls.push({ kind, points: orientLikeWalls(convexHull(pts)) });
      extendIntoJunction(ends);
    }
  }
  geo = { info, hulls };
  geometryCache.set(walls, geo);
  return geo;
}

function groupOpenings(openings) {
  const map = new Map();
  for (const o of openings) {
    if (!map.has(o.wallId)) map.set(o.wallId, []);
    map.get(o.wallId).push(o);
  }
  return map;
}

/** Solid spans of a wall between its openings, as [start, end] offsets from wall.a. */
function solidSpans(gi, openings, filter) {
  const cuts = (openings || []).filter(filter || (() => true)).map((o) => openingSpan(gi.wall, o))
    .sort((p, q) => p.start - q.start);
  const spans = [];
  let at = 0;
  for (const c of cuts) {
    if (c.start > at + 1e-4) spans.push([at, c.start]);
    at = Math.max(at, c.end);
  }
  if (gi.L > at + 1e-4) spans.push([at, gi.L]);
  return spans;
}

function piecePolygon(gi, s0, s1) {
  const w = gi.wall;
  const at = (s, side) => {
    if (s <= 1e-6) return gi.ends.a[side];
    if (s >= gi.L - 1e-6) return gi.ends.b[side];
    return add(pointOnWall(w, s), mul(gi.n, side === 'P' ? gi.h : -gi.h));
  };
  return [at(s0, 'P'), at(s1, 'P'), at(s1, 'N'), at(s0, 'N')];
}

/** Full outline of a wall (ignoring openings). */
const wallOutline = (gi) => [gi.ends.a.P, gi.ends.b.P, gi.ends.b.N, gi.ends.a.N];

// ---- Layers --------------------------------------------------------------------

function drawRoomTint(ctx, view, plan, sel, color) {
  const room = plan.rooms.find((r) => r.id === sel.id);
  if (!room || room.points.length < 3) return;
  const path = new Path2D();
  polyPath(path, view, room.points);
  ctx.fillStyle = color;
  ctx.fill(path);
}

function drawRooms(ctx, view, rooms, alpha) {
  for (const room of rooms) {
    if (!room.points || room.points.length < 3) continue;
    const path = new Path2D();
    polyPath(path, view, room.points);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = FLOORS[room.floor]?.color2d || FLOORS.carpet.color2d;
    ctx.fill(path);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = THEME.roomEdge;
    ctx.lineWidth = 1;
    ctx.stroke(path);
  }
}

function drawWalls(ctx, view, plan, geo, { ghosts, mini }) {
  const byWall = groupOpenings(plan.openings);
  const paths = {};
  const ghostPaths = {};
  const thinPaths = {};
  const glassEdges = new Path2D();
  const ghostOutline = new Path2D();
  const minPx = mini ? 2.2 : 1.4;
  for (const kind of KIND_ORDER) {
    paths[kind] = new Path2D();
    ghostPaths[kind] = new Path2D();
    thinPaths[kind] = new Path2D();
  }
  for (const gi of geo.info.values()) {
    const kind = paths[gi.wall.kind] ? gi.wall.kind : 'interior';
    const ghost = ghosts.has(gi.wall.id);
    const thin = gi.h * 2 * view.scale < minPx;
    const target = ghost ? ghostPaths[kind] : paths[kind];
    const openings = byWall.get(gi.wall.id);
    const spans = solidSpans(gi, openings, mini ? (o) => o.type !== 'window' : null);
    for (const [s0, s1] of spans) {
      const poly = piecePolygon(gi, s0, s1);
      polyPath(target, view, poly);
      if (thin) {
        const a = toScreen(view, pointOnWall(gi.wall, s0)), b = toScreen(view, pointOnWall(gi.wall, s1));
        thinPaths[kind].moveTo(a.x, a.y);
        thinPaths[kind].lineTo(b.x, b.y);
      }
      if (ghost) polyPath(ghostOutline, view, poly);
      if (kind === 'glass' && !mini) {
        const [p0, p1, n1, n0] = poly.map((p) => toScreen(view, p));
        glassEdges.moveTo(p0.x, p0.y); glassEdges.lineTo(p1.x, p1.y);
        glassEdges.moveTo(n0.x, n0.y); glassEdges.lineTo(n1.x, n1.y);
        if (s0 <= 1e-6 && !gi.ends.a.joined) { glassEdges.moveTo(p0.x, p0.y); glassEdges.lineTo(n0.x, n0.y); }
        if (s1 >= gi.L - 1e-6 && !gi.ends.b.joined) { glassEdges.moveTo(p1.x, p1.y); glassEdges.lineTo(n1.x, n1.y); }
      }
    }
  }
  for (const hull of geo.hulls) {
    const kind = paths[hull.kind] ? hull.kind : 'interior';
    polyPath(paths[kind], view, hull.points);
  }

  for (const kind of KIND_ORDER) {
    const color = THEME.walls[kind];
    ctx.fillStyle = kind === 'glass' && !mini ? THEME.glassFill : color;
    ctx.fill(paths[kind]);
    if (kind === 'partial' && !mini) hatch(ctx, view, paths[kind]);
    if (kind === 'glass' && !mini) {
      ctx.strokeStyle = THEME.glassLine;
      ctx.lineWidth = 1;
      ctx.stroke(glassEdges);
    }
    ctx.strokeStyle = kind === 'glass' && !mini ? THEME.glassLine : color;
    ctx.lineWidth = minPx;
    ctx.lineCap = 'square';
    ctx.stroke(thinPaths[kind]);
    ctx.lineCap = 'butt';
  }
  if (ghosts.size) {
    ctx.save();
    ctx.globalAlpha = 0.55;
    for (const kind of KIND_ORDER) {
      ctx.fillStyle = kind === 'glass' ? THEME.walls.glass : THEME.walls[kind];
      ctx.fill(ghostPaths[kind]);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = THEME.ghost;
    ctx.lineWidth = 1;
    ctx.stroke(ghostOutline);
    ctx.restore();
  }
}

function hatch(ctx, view, path) {
  ctx.save();
  ctx.clip(path);
  ctx.strokeStyle = THEME.partialHatch;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const step = 5;
  const span = view.width + view.height;
  for (let k = -view.height; k < span; k += step) {
    ctx.moveTo(k, 0);
    ctx.lineTo(k + view.height, view.height);
  }
  ctx.stroke();
  ctx.restore();
}

function strokeJambs(ctx, W, T) {
  ctx.moveTo(-W / 2, -T / 2); ctx.lineTo(-W / 2, T / 2);
  ctx.moveTo(W / 2, -T / 2); ctx.lineTo(W / 2, T / 2);
}

function drawSwing(ctx, hx, toward, T, leaf, s, leafT, color, soft) {
  const y0 = s * T / 2;
  ctx.beginPath();
  ctx.rect(Math.min(hx, hx + toward * leafT), Math.min(y0, y0 + s * leaf), leafT, leaf);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
  const a0 = s > 0 ? Math.PI / 2 : -Math.PI / 2;
  const a1 = toward > 0 ? 0 : Math.PI;
  let delta = a1 - a0;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  ctx.beginPath();
  ctx.arc(hx, y0, leaf, a0, a1, delta < 0);
  ctx.strokeStyle = soft;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function arrow(ctx, x0, x1, y) {
  const dir = Math.sign(x1 - x0) || 1;
  ctx.moveTo(x0, y); ctx.lineTo(x1, y);
  ctx.moveTo(x1 - dir * 4, y - 2.5); ctx.lineTo(x1, y); ctx.lineTo(x1 - dir * 4, y + 2.5);
}

/** Draws one opening symbol in a frame centered on the opening: x along the wall, y along its normal. */
function drawOpeningSymbol(ctx, view, gi, o, { ghost = false } = {}) {
  const span = openingSpan(gi.wall, o);
  const c = toScreen(view, pointOnWall(gi.wall, span.center));
  const S = view.scale;
  const W = (span.end - span.start) * S;
  const T = Math.max(gi.wall.thickness * S, 2);
  const s = o.side < 0 ? -1 : 1;
  const color = ghost ? THEME.ghost : THEME.symbol;
  const soft = ghost ? THEME.ghost : THEME.symbolSoft;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(Math.atan2(gi.u.y, gi.u.x));
  if (ghost) {
    ctx.fillStyle = 'rgba(0, 63, 45, 0.12)';
    ctx.fillRect(-W / 2, -T / 2, W, T);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const leafT = clamp(0.045 * S, 1.5, 4);
  switch (o.type) {
    case 'door': {
      const hx = o.hinge === 'end' ? W / 2 : -W / 2;
      drawSwing(ctx, hx, -Math.sign(hx), T, W, s, leafT, color, soft);
      break;
    }
    case 'double-door': {
      drawSwing(ctx, -W / 2, 1, T, W / 2, s, leafT, color, soft);
      drawSwing(ctx, W / 2, -1, T, W / 2, s, leafT, color, soft);
      break;
    }
    case 'sliding-door': {
      // As in 3D: the fixed panel is at the hinge end on the -side face, and the other panel
      // slides toward it on the +side face.
      const f = o.hinge === 'end' ? -1 : 1;
      const pt = clamp(0.035 * S, 1.5, Math.max(1.5, T / 3));
      const ov = Math.min(W * 0.06, 0.05 * S + 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.rect((-W / 2) * f, -pt * s, (W / 2 + ov) * f, pt * s);
      ctx.rect(-ov * f, 0, (W / 2 + ov) * f, pt * s);
      ctx.fill();
      ctx.stroke();
      if (W > 24) {
        ctx.beginPath();
        arrow(ctx, W * 0.38 * f, W * 0.12 * f, (T / 2 + 5) * s);
        ctx.strokeStyle = soft;
        ctx.stroke();
      }
      break;
    }
    case 'window': {
      ctx.fillStyle = THEME.windowFill;
      ctx.fillRect(-W / 2, -T / 2, W, T);
      ctx.beginPath();
      ctx.moveTo(-W / 2, -T / 2); ctx.lineTo(W / 2, -T / 2);
      ctx.moveTo(-W / 2, 0); ctx.lineTo(W / 2, 0);
      ctx.moveTo(-W / 2, T / 2); ctx.lineTo(W / 2, T / 2);
      ctx.stroke();
      break;
    }
    default:
      break;
  }
  ctx.beginPath();
  strokeJambs(ctx, W, T);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function drawOpenings(ctx, view, plan, geo, ghosts) {
  for (const o of plan.openings) {
    const gi = geo.info.get(o.wallId);
    if (!gi) continue;
    drawOpeningSymbol(ctx, view, gi, o, { ghost: ghosts.has(o.id) });
  }
}

function onScreen(view, c, r) {
  return c.x + r >= 0 && c.x - r <= view.width && c.y + r >= 0 && c.y - r <= view.height;
}

function drawItems(ctx, view, items, { ghosts, mini }) {
  const px = 1 / view.scale;
  // Floor-level items (rugs, floor markings) go first so furniture standing on them stays visible.
  const ordered = [...items].sort((a, b) => (getItem(a.type).blocking === false ? 0 : 1) - (getItem(b.type).blocking === false ? 0 : 1));
  for (const item of ordered) {
    const def = getItem(item.type);
    const dims = itemDims(item);
    const c = toScreen(view, item);
    // Margin of 1 m: some symbols (door swings) reach past the footprint.
    if (!onScreen(view, c, (Math.hypot(dims.w, dims.d) / 2 + 1) * view.scale + 4)) continue;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(deg2rad(item.rotation || 0));
    ctx.scale(view.scale, view.scale);
    if (ghosts.has(item.id)) ctx.globalAlpha = 0.72;
    if (def.planFill !== false && def.blocking !== false) {
      ctx.fillStyle = THEME.item.fill;
      ctx.fillRect(-dims.w / 2, -dims.d / 2, dims.w, dims.d);
    }
    if (mini) {
      ctx.strokeStyle = THEME.item.light;
      ctx.lineWidth = px;
      ctx.strokeRect(-dims.w / 2, -dims.d / 2, dims.w, dims.d);
    } else {
      ctx.save();
      try {
        def.draw2d(ctx, { ...dims, px, theme: THEME.item });
      } catch {
        ctx.restore();
        ctx.save();
        getItem('').draw2d(ctx, { ...dims, px, theme: THEME.item });
      }
      ctx.restore();
    }
    ctx.restore();
  }
}

const labelCache = new WeakMap();

function edgeDistance(p, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) best = Math.min(best, projectToSegment(p, pts[i], pts[(i + 1) % pts.length]).dist);
  return best;
}

/** A point well inside the room for its label: the centroid, or the most interior grid sample. */
function roomLabelPoint(room) {
  let p = labelCache.get(room);
  if (p) return p;
  const pts = room.points;
  const c = polygonCentroid(pts);
  const b = boundsOf(pts);
  const size = Math.min(b.maxX - b.minX, b.maxY - b.minY);
  if (pointInPolygon(c, pts) && edgeDistance(c, pts) > size * 0.25) {
    p = c;
  } else {
    let best = -1;
    p = c;
    const n = 14;
    for (let i = 1; i < n; i++) {
      for (let j = 1; j < n; j++) {
        const q = { x: b.minX + ((b.maxX - b.minX) * i) / n, y: b.minY + ((b.maxY - b.minY) * j) / n };
        if (!pointInPolygon(q, pts)) continue;
        const dq = edgeDistance(q, pts) - dist(q, c) * 0.05;
        if (dq > best) { best = dq; p = q; }
      }
    }
  }
  labelCache.set(room, p);
  return p;
}

function haloText(ctx, text, x, y) {
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

/** "12' x 18'" for rectangular rooms (any orientation), otherwise null. */
function rectSize(points, units) {
  if (points.length !== 4) return null;
  const e = points.map((p, i) => sub(points[(i + 1) % 4], p));
  for (let i = 0; i < 4; i++) {
    const a = e[i], b = e[(i + 1) % 4];
    if (Math.abs(dot(a, b)) > 1e-3 * len(a) * len(b)) return null;
  }
  return `${formatLength(len(e[0]), units)} \u00d7 ${formatLength(len(e[1]), units)}`;
}

/** Draws room names and areas. Returns the screen boxes it used so other labels can avoid them. */
function drawRoomLabels(ctx, view, plan, { mini, sizes }) {
  const placed = [];
  const size = mini ? 10 : clamp(view.scale * 0.3, 11, 15);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = THEME.halo;
  ctx.lineWidth = 3;
  for (const room of plan.rooms) {
    if (!room.points || room.points.length < 3) continue;
    const b = boundsOf(room.points);
    const bw = (b.maxX - b.minX) * view.scale, bh = (b.maxY - b.minY) * view.scale;
    const p = toScreen(view, roomLabelPoint(room));
    if (!onScreen(view, p, 80)) continue;
    const name = room.name || '';
    const area = formatArea(polygonArea(room.points), plan.units);
    ctx.font = fontSpec(size, 600);
    const nameW = ctx.measureText(name).width;
    ctx.font = fontSpec(size * 0.86, 400);
    const areaW = ctx.measureText(area).width;
    const fitsName = name && bw > nameW + 10 && bh > size * 1.6;
    if (!fitsName) continue;
    const showArea = !mini && bw > areaW + 10 && bh > size * 3;
    const dims = showArea && sizes ? rectSize(room.points, plan.units) : null;
    const showDims = dims && bw > ctx.measureText(dims).width + 10 && bh > size * 4.2;
    const lines = 1 + (showArea ? 1 : 0) + (showDims ? 1 : 0);
    const y0 = p.y - ((lines - 1) * size * 1.15) / 2;
    ctx.strokeStyle = FLOORS[room.floor]?.color2d || THEME.halo;
    ctx.font = fontSpec(size, 600);
    ctx.fillStyle = THEME.text;
    haloText(ctx, name, p.x, y0);
    ctx.font = fontSpec(size * 0.86, 400);
    ctx.fillStyle = THEME.textSoft;
    if (showArea) haloText(ctx, area, p.x, y0 + size * 1.15);
    if (showDims) haloText(ctx, dims, p.x, y0 + size * 2.3);
    const half = Math.max(nameW, showArea ? areaW : 0, showDims ? ctx.measureText(dims).width : 0) / 2 + 3;
    placed.push({ x0: p.x - half, x1: p.x + half, y0: y0 - size * 0.65, y1: y0 + (lines - 1) * size * 1.15 + size * 0.65 });
  }
  ctx.restore();
  return placed;
}

const overlaps = (r, boxes) => boxes.some((b) => r.x0 < b.x1 && r.x1 > b.x0 && r.y0 < b.y1 && r.y1 > b.y0);

/** Item labels, centered under each labeled item (or above it when that spot is taken). */
function drawItemLabels(ctx, view, items, ghosts, placed) {
  const size = 11;
  ctx.save();
  ctx.font = fontSpec(size, 600);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = THEME.halo;
  ctx.fillStyle = THEME.text;
  for (const item of items) {
    const text = typeof item.label === 'string' ? item.label.trim() : '';
    if (!text || ghosts.has(item.id)) continue;
    const corners = itemCorners(item, itemDims(item)).map((q) => toScreen(view, q));
    const b = boundsOf(corners);
    const c = toScreen(view, item);
    const w = ctx.measureText(text).width + 4, h = size + 3;
    if (!onScreen(view, c, (b.maxX - b.minX) / 2 + w)) continue;
    for (const y of [b.maxY + 3 + h / 2, b.minY - 3 - h / 2]) {
      const box = { x0: c.x - w / 2, x1: c.x + w / 2, y0: y - h / 2, y1: y + h / 2 };
      if (overlaps(box, placed)) continue;
      placed.push(box);
      haloText(ctx, text, c.x, y);
      break;
    }
  }
  ctx.restore();
}

function drawCamera(ctx, view, cam, { ghost, mini, labels, placed = [] }) {
  const c = toScreen(view, cam);
  if (!onScreen(view, c, 60)) return;
  const a = deg2rad((cam.yaw || 0) - 90);
  ctx.save();
  if (ghost) ctx.globalAlpha = 0.8;
  const R = mini ? 14 : 28;
  const half = deg2rad(32);
  const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, R);
  g.addColorStop(0, 'rgba(0, 63, 45, 0.34)');
  g.addColorStop(1, 'rgba(0, 63, 45, 0.04)');
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.arc(c.x, c.y, R, a - half, a + half);
  ctx.closePath();
  ctx.fillStyle = g;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(c.x, c.y, mini ? 3.5 : 6, 0, Math.PI * 2);
  ctx.fillStyle = THEME.camera;
  ctx.fill();
  ctx.lineWidth = mini ? 1.5 : 2;
  ctx.strokeStyle = '#FFFFFF';
  ctx.stroke();
  if (labels && !mini && cam.name) {
    ctx.font = fontSpec(11.5, 600);
    const w = ctx.measureText(cam.name).width, h = 14;
    // Prefer the side behind the view direction, then try the other sides; skip if all collide.
    const back = { x: -Math.cos(a), y: -Math.sin(a) };
    const dirs = [back, { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
    for (const d of dirs) {
      const align = d.x > 0.35 ? 'left' : d.x < -0.35 ? 'right' : 'center';
      const base = d.y > 0.35 ? 'top' : d.y < -0.35 ? 'bottom' : 'middle';
      const lx = c.x + d.x * 11, ly = c.y + d.y * 11;
      const x0 = align === 'left' ? lx : align === 'right' ? lx - w : lx - w / 2;
      const y0 = base === 'top' ? ly : base === 'bottom' ? ly - h : ly - h / 2;
      const box = { x0: x0 - 2, x1: x0 + w + 2, y0, y1: y0 + h };
      if (overlaps(box, placed)) continue;
      placed.push(box);
      ctx.textAlign = align;
      ctx.textBaseline = base;
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3;
      ctx.strokeStyle = THEME.halo;
      ctx.fillStyle = THEME.camera;
      haloText(ctx, cam.name, lx, ly);
      break;
    }
  }
  ctx.restore();
}

function drawWalker(ctx, view, walker, mini) {
  const c = toScreen(view, walker);
  const a = deg2rad((walker.yaw || 0) - 90);
  const R = mini ? clamp(5 * view.scale, 26, 46) : clamp(4 * view.scale, 40, 96);
  const half = deg2rad(36);
  ctx.save();
  const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, R);
  g.addColorStop(0, 'rgba(0, 63, 45, 0.38)');
  g.addColorStop(1, 'rgba(0, 63, 45, 0)');
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.arc(c.x, c.y, R, a - half, a + half);
  ctx.closePath();
  ctx.fillStyle = g;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(c.x, c.y, mini ? 8 : 12, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 63, 45, 0.16)';
  ctx.fill();
  ctx.shadowColor = 'rgba(1, 42, 45, 0.3)';
  ctx.shadowBlur = 4;
  ctx.beginPath();
  ctx.arc(c.x, c.y, mini ? 5 : 7, 0, Math.PI * 2);
  ctx.fillStyle = THEME.walker;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = mini ? 2 : 2.5;
  ctx.strokeStyle = '#FFFFFF';
  ctx.stroke();
  ctx.restore();
}

/** Side (1 or -1, relative to the screen normal of a->b) that points away from center. */
function sideAway(view, a, b, center) {
  if (!center) return 0;
  const A = toScreen(view, a), B = toScreen(view, b);
  const d = sub(B, A), L = len(d);
  if (L < 1e-6) return 0;
  const n = { x: d.y / L, y: -d.x / L };
  const m = mul(add(A, B), 0.5);
  return dot(n, sub(m, toScreen(view, center))) >= 0 ? 1 : -1;
}

function drawWallDimension(ctx, view, plan, gi, center, tone = 'plain', text) {
  const base = gi.h * view.scale;
  drawDimension(ctx, view, gi.wall.a, gi.wall.b, {
    units: plan.units, base, offset: base + 16, side: sideAway(view, gi.wall.a, gi.wall.b, center), tone, text,
  });
}

function drawOverallDimensions(ctx, view, plan) {
  const b = shellBounds(plan);
  if (emptyBounds(b)) return;
  const out = 30;
  drawDimension(ctx, view, { x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { units: plan.units, offset: out, side: 0 });
  drawDimension(ctx, view, { x: b.minX, y: b.minY }, { x: b.minX, y: b.maxY }, { units: plan.units, offset: out, side: 0 });
}

function squareHandle(ctx, p, size) {
  ctx.beginPath();
  ctx.rect(Math.round(p.x - size / 2) + 0.5, Math.round(p.y - size / 2) + 0.5, size, size);
  ctx.fillStyle = THEME.handleFill;
  ctx.fill();
  ctx.strokeStyle = THEME.selection;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function roundHandle(ctx, p, r) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = THEME.handleFill;
  ctx.fill();
  ctx.strokeStyle = THEME.selection;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawHighlight(ctx, view, plan, geo, sel, selected) {
  const color = selected ? THEME.selection : THEME.hover;
  const entity = (plan[{ wall: 'walls', opening: 'openings', room: 'rooms', item: 'items', camera: 'cameras' }[sel.kind]] || [])
    .find((e) => e.id === sel.id);
  if (!entity) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  switch (sel.kind) {
    case 'wall': {
      const gi = geo.info.get(entity.id);
      if (!gi) break;
      const path = new Path2D();
      polyPath(path, view, wallOutline(gi));
      ctx.fillStyle = selected ? 'rgba(0, 63, 45, 0.16)' : 'rgba(0, 63, 45, 0.08)';
      ctx.fill(path);
      ctx.lineWidth = 2;
      ctx.stroke(path);
      if (selected) for (const p of [entity.a, entity.b]) squareHandle(ctx, toScreen(view, p), HANDLE.wall);
      break;
    }
    case 'room': {
      const path = new Path2D();
      polyPath(path, view, entity.points);
      ctx.lineWidth = selected ? 2 : 1.75;
      if (!selected) ctx.setLineDash([6, 4]);
      ctx.stroke(path);
      ctx.setLineDash([]);
      if (selected) for (const p of entity.points) roundHandle(ctx, toScreen(view, p), HANDLE.vertex);
      break;
    }
    case 'item': {
      const dims = itemDims(entity);
      const pad = 2 / view.scale;
      const corners = itemCorners(entity, { w: dims.w + pad * 2, d: dims.d + pad * 2 });
      const path = new Path2D();
      polyPath(path, view, corners);
      ctx.lineWidth = selected ? 1.75 : 1.5;
      ctx.stroke(path);
      if (selected) {
        const h = itemHandlePoint(view, entity);
        const front = toScreen(view, rotate(add(entity, { x: 0, y: dims.d / 2 + pad }), entity.rotation || 0, entity));
        ctx.beginPath();
        ctx.moveTo(front.x, front.y);
        ctx.lineTo(h.x, h.y);
        ctx.lineWidth = 1.25;
        ctx.stroke();
        roundHandle(ctx, h, HANDLE.rotate);
      }
      break;
    }
    case 'opening': {
      const gi = geo.info.get(entity.wallId);
      if (!gi) break;
      const span = openingSpan(gi.wall, entity);
      const c = toScreen(view, pointOnWall(gi.wall, span.center));
      const W = (span.end - span.start) * view.scale;
      const T = gi.wall.thickness * view.scale;
      ctx.translate(c.x, c.y);
      ctx.rotate(Math.atan2(gi.u.y, gi.u.x));
      ctx.lineWidth = 2;
      ctx.fillStyle = selected ? 'rgba(0, 63, 45, 0.12)' : 'rgba(0, 63, 45, 0.06)';
      ctx.beginPath();
      ctx.rect(-W / 2 - 2, -T / 2 - 3, W + 4, T + 6);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'camera': {
      const c = toScreen(view, entity);
      ctx.beginPath();
      ctx.arc(c.x, c.y, 10.5, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.stroke();
      if (selected) {
        const h = cameraHandlePoint(view, entity);
        ctx.beginPath();
        ctx.moveTo(c.x + (h.x - c.x) * (10.5 / HANDLE.cameraAim), c.y + (h.y - c.y) * (10.5 / HANDLE.cameraAim));
        ctx.lineTo(h.x, h.y);
        ctx.lineWidth = 1.25;
        ctx.stroke();
        roundHandle(ctx, h, 4.5);
      }
      break;
    }
    default:
      break;
  }
  ctx.restore();
}

// ---- Entry point ------------------------------------------------------------------

/**
 * Render a plan. opts (all optional):
 *   selection, hover        {kind, id} highlights
 *   showGrid, showUnderlay, showDimensions, showLabels
 *   mini                    compact minimap rendering
 *   walker                  {x, y, yaw} walkthrough position marker
 *   ghosts                  Set of entity ids drawn as previews (editor tools)
 *   dimensions              extra dimension lines [{a, b, text?, tone?, base?, offset?}]
 *   background              fill color, or null to leave the canvas as is
 *   onLoad                  called when a pending underlay image finishes loading
 */
export function renderPlan(ctx, plan, view, opts = {}) {
  const mini = !!opts.mini;
  const showGrid = opts.showGrid ?? !mini;
  const showUnderlay = opts.showUnderlay ?? !mini;
  const showLabels = opts.showLabels ?? true;
  const ghosts = opts.ghosts instanceof Set ? opts.ghosts : new Set(opts.ghosts || []);
  const background = opts.background === undefined ? (mini ? THEME.miniBackground : THEME.background) : opts.background;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, view.width, view.height);
  ctx.clip();
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, view.width, view.height);
  }
  if (showGrid) drawGrid(ctx, view, plan.units);
  const underlay = plan.underlay;
  const underlayShown = showUnderlay && underlay && underlay.visible !== false && underlay.src;
  if (underlayShown) drawUnderlay(ctx, view, underlay, opts.onLoad);

  const geo = wallGeometry(plan.walls);
  drawRooms(ctx, view, plan.rooms, underlayShown ? 0.55 : 1);
  if (!mini) {
    if (opts.hover?.kind === 'room' && !sameSel(opts.hover, opts.selection)) drawRoomTint(ctx, view, plan, opts.hover, THEME.hoverFill);
    if (opts.selection?.kind === 'room') drawRoomTint(ctx, view, plan, opts.selection, THEME.selectionFill);
  }
  drawItems(ctx, view, plan.items, { ghosts, mini });
  drawWalls(ctx, view, plan, geo, { ghosts, mini });
  if (!mini) drawOpenings(ctx, view, plan, geo, ghosts);
  const placed = showLabels ? drawRoomLabels(ctx, view, plan, { mini, sizes: !!opts.showDimensions && !mini }) : [];
  if (showLabels && !mini) drawItemLabels(ctx, view, plan.items, ghosts, placed);
  for (const cam of plan.cameras) drawCamera(ctx, view, cam, { ghost: ghosts.has(cam.id), mini, labels: showLabels, placed });

  if (!mini) {
    if (opts.showDimensions) drawOverallDimensions(ctx, view, plan);
    const b = shellBounds(plan);
    const center = emptyBounds(b) ? null : { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    if (opts.selection?.kind === 'wall') {
      const gi = geo.info.get(opts.selection.id);
      if (gi) drawWallDimension(ctx, view, plan, gi, center);
    }
    for (const dim of opts.dimensions || []) {
      if (dim.wallId) {
        const gi = geo.info.get(dim.wallId);
        if (gi) drawWallDimension(ctx, view, plan, gi, center, dim.tone || 'active', dim.text);
      } else if (dim.a && dim.b) {
        drawDimension(ctx, view, dim.a, dim.b, { units: plan.units, ...dim });
      }
    }
    if (opts.hover && !sameSel(opts.hover, opts.selection)) drawHighlight(ctx, view, plan, geo, opts.hover, false);
    if (opts.selection) drawHighlight(ctx, view, plan, geo, opts.selection, true);
  }
  if (opts.walker) drawWalker(ctx, view, opts.walker, mini);
  ctx.restore();
}

const sameSel = (a, b) => !!a && !!b && a.kind === b.kind && a.id === b.id;
