// Plan-space geometry and unit helpers. Plan space is in meters with x to the right and
// y DOWN (the same orientation as a canvas). Rotations are degrees, clockwise on the plan.
export const EPS = 1e-6;
export const FOOT = 0.3048;
export const INCH = 0.0254;

export const pt = (x, y) => ({ x, y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a, s) => ({ x: a.x * s, y: a.y * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const cross = (a, b) => a.x * b.y - a.y * b.x;
export const len = (a) => Math.hypot(a.x, a.y);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const samePoint = (a, b, tol = 1e-3) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const deg2rad = (d) => (d * Math.PI) / 180;
export const rad2deg = (r) => (r * 180) / Math.PI;

export function norm(a) {
  const l = len(a);
  return l < EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** Rotate p clockwise (on the y-down plan) by deg around origin. */
export function rotate(p, deg, origin = { x: 0, y: 0 }) {
  const r = deg2rad(deg);
  const c = Math.cos(r), s = Math.sin(r);
  const dx = p.x - origin.x, dy = p.y - origin.y;
  return { x: origin.x + dx * c - dy * s, y: origin.y + dx * s + dy * c };
}

/** Normalize an angle in degrees to [0, 360). */
export const normDeg = (d) => ((d % 360) + 360) % 360;

/** Closest point on segment ab to p. `t` is 0..1, `along` is meters from a. */
export function projectToSegment(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 < EPS ? 0 : clamp(dot(sub(p, a), ab) / l2, 0, 1);
  const point = lerp(a, b, t);
  return { t, point, dist: dist(p, point), along: t * Math.sqrt(l2) };
}

/** Intersection point of segments p1p2 and p3p4, or null. */
export function segmentIntersection(p1, p2, p3, p4) {
  const r = sub(p2, p1), s = sub(p4, p3);
  const denom = cross(r, s);
  if (Math.abs(denom) < EPS) return null;
  const t = cross(sub(p3, p1), s) / denom;
  const u = cross(sub(p3, p1), r) / denom;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { point: lerp(p1, p2, t), t, u };
}

// ---- Walls and openings ---------------------------------------------------

export const wallLength = (w) => dist(w.a, w.b);
export const wallDir = (w) => norm(sub(w.b, w.a));
/** Unit normal of a wall: the direction dir rotated 90° clockwise. Opening.side = 1 points this way. */
export function wallNormal(w) {
  const d = wallDir(w);
  return { x: -d.y, y: d.x };
}
export const wallAngle = (w) => rad2deg(Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x));
export const pointOnWall = (w, along) => add(w.a, scale(wallDir(w), along));

/** Start/end offsets (meters from wall.a) of an opening, clamped to the wall. */
export function openingSpan(wall, opening) {
  const L = wallLength(wall);
  const half = Math.min(opening.width, L) / 2;
  const center = clamp(opening.offset, half, L - half);
  return { start: center - half, end: center + half, center };
}

/** Plan-space endpoints of an opening along its wall's centerline. */
export function openingEndpoints(wall, opening) {
  const s = openingSpan(wall, opening);
  return { a: pointOnWall(wall, s.start), b: pointOnWall(wall, s.end), ...s };
}

// ---- Polygons -------------------------------------------------------------

export function polygonSignedArea(points) {
  let a = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const p = points[i], q = points[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}
export const polygonArea = (points) => Math.abs(polygonSignedArea(points));

export function polygonCentroid(points) {
  const A = polygonSignedArea(points);
  if (Math.abs(A) < EPS) {
    const s = points.reduce((acc, p) => add(acc, p), { x: 0, y: 0 });
    return scale(s, 1 / Math.max(1, points.length));
  }
  let cx = 0, cy = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const p = points[i], q = points[(i + 1) % n];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  return { x: cx / (6 * A), y: cy / (6 * A) };
}

export function pointInPolygon(p, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function boundsOf(points) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of points) {
    b.minX = Math.min(b.minX, p.x); b.minY = Math.min(b.minY, p.y);
    b.maxX = Math.max(b.maxX, p.x); b.maxY = Math.max(b.maxY, p.y);
  }
  return b;
}

export function unionBounds(a, b) {
  return {
    minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
  };
}

export const emptyBounds = (b) => !b || !Number.isFinite(b.minX) || b.maxX - b.minX < EPS && b.maxY - b.minY < EPS;

// ---- Items ----------------------------------------------------------------

/** Plan-space corners of an item's footprint (clockwise from back-left). dims = {w, d}. */
export function itemCorners(item, dims) {
  const hw = dims.w / 2, hd = dims.d / 2;
  const c = { x: item.x, y: item.y };
  return [
    { x: -hw, y: -hd }, { x: hw, y: -hd }, { x: hw, y: hd }, { x: -hw, y: hd },
  ].map((p) => rotate(add(p, c), item.rotation || 0, c));
}

/** True if plan point p lies inside an item's rotated footprint. */
export function pointInItem(p, item, dims) {
  const local = rotate(p, -(item.rotation || 0), item);
  return Math.abs(local.x - item.x) <= dims.w / 2 && Math.abs(local.y - item.y) <= dims.d / 2;
}

// ---- Snapping -------------------------------------------------------------

export const snapValue = (v, step) => (step > 0 ? Math.round(v / step) * step : v);
export const snapToGrid = (p, step) => ({ x: snapValue(p.x, step), y: snapValue(p.y, step) });

/** Snap the direction from `from` to `to` to the nearest multiple of stepDeg, keeping length. */
export function snapAngle(from, to, stepDeg = 45) {
  const d = sub(to, from);
  const l = len(d);
  if (l < EPS) return { ...to };
  const a = snapValue(rad2deg(Math.atan2(d.y, d.x)), stepDeg);
  return { x: from.x + Math.cos(deg2rad(a)) * l, y: from.y + Math.sin(deg2rad(a)) * l };
}

// ---- Units ----------------------------------------------------------------

/** Format a length in meters for display. units: 'imperial' (feet and inches) or 'metric'. */
export function formatLength(m, units = 'imperial') {
  if (!Number.isFinite(m)) return '';
  if (units === 'metric') return m < 1 ? `${Math.round(m * 100)} cm` : `${m.toFixed(2)} m`;
  const totalIn = Math.round(Math.abs(m) / INCH);
  const ft = Math.floor(totalIn / 12), inch = totalIn % 12;
  const sign = m < 0 ? '-' : '';
  if (ft === 0) return `${sign}${inch}"`;
  return inch === 0 ? `${sign}${ft}'` : `${sign}${ft}' ${inch}"`;
}

export function formatArea(m2, units = 'imperial') {
  if (!Number.isFinite(m2)) return '';
  if (units === 'metric') return `${m2.toFixed(1)} m²`;
  return `${Math.round(m2 / (FOOT * FOOT)).toLocaleString('en-US')} sq ft`;
}

/**
 * Parse a typed length into meters. Accepts 12' 6", 12'6, 12ft 6in, 12.5', 150", 3.8m, 380cm,
 * 3800mm. A bare number is feet in imperial mode and meters in metric mode. Returns NaN if invalid.
 */
export function parseLength(input, units = 'imperial') {
  const s = String(input).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return NaN;
  let m;
  if ((m = s.match(/^(-?\d+(?:\.\d+)?)\s*mm$/))) return +m[1] / 1000;
  if ((m = s.match(/^(-?\d+(?:\.\d+)?)\s*cm$/))) return +m[1] / 100;
  if ((m = s.match(/^(-?\d+(?:\.\d+)?)\s*m$/))) return +m[1];
  if ((m = s.match(/^(-?\d+(?:\.\d+)?)\s*(?:in|"|'')$/))) return +m[1] * INCH;
  if ((m = s.match(/^(-?\d+(?:\.\d+)?)\s*(?:ft|feet|')\s*(?:(\d+(?:\.\d+)?)\s*(?:in|"|'')?)?$/))) {
    return +m[1] * FOOT + (m[2] ? +m[2] * INCH : 0);
  }
  if ((m = s.match(/^-?\d+(?:\.\d+)?$/))) return units === 'metric' ? +s : +s * FOOT;
  return NaN;
}
