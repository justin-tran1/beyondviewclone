// Automatic tracing of a floor plan drawing: the walls, doors, windows, rooms and furniture found
// in its pixels, so an imported plan can be walked through straight away. Plain functions on RGBA
// data with no DOM, so it runs in a worker (src/autotrace-worker.js), on the page or in Node.
//
// traceFloorPlan({ width, height, data }) -> {
//   width, height,                     // image size in px
//   thickness,                         // typical wall thickness, px (0 when nothing was found)
//   walls: [{ a: {x, y}, b: {x, y}, thickness, exterior }],   // centerlines in image px
//   openings: [{ wall, type, offset, width, hinge, side }],    // wall: index into walls;
//                                      // offset: px from wall.a to the center; side: +1 swings
//                                      // toward +x (vertical walls) or +y (horizontal walls)
//   rooms: [{ points: [{x, y}], area }],                       // outlines in px, area in px²
//   scale: { metersPerPixel, source: 'note' | 'doors' | 'walls' | null, doors, noteMismatch? },
//   items: [{ kind, x, y, w, d, rotation, ... }],              // furniture and fixtures, in px:
//                                      // see src/autotrace-items.js
// }
// toPlanGeometry(trace, { metersPerPixel, origin }) converts the result to plan meters in the
// shape the model's addWall, addOpening and addRoom take.
//
// A known scale (opts.metersPerPixel, from the drawing's scale note) is the drawing's own: its
// doors only check it. Where they make it more than NOTE_RATIO larger or smaller, the page was
// most likely printed to fit, and the doors give the scale instead (noteMismatch).
//
// What it reads: architectural drawings of straight walls at right angles, drawn either as solid
// strokes or as pairs of thin parallel lines (the usual CAD export). A wall shows up in every
// row (or column) it crosses as the same short dark section, so the detector looks for sections
// of one width that repeat at the same place over many rows: text, furniture, dimension lines,
// door swings and hatching do not. Doors are gaps between wall ends with a quarter circle drawn
// from one jamb; their widths, taken as 3'-0" doors, give the drawing's scale. Windows are gaps
// with lines across, or stretches of an outside wall drawn as its faces and glass lines. The
// furniture is what the lines left inside the rooms close off (src/autotrace-items.js).

import { findItems } from './autotrace-items.js';

const DOOR_WIDTH = 0.9144; // m: the 3'-0" door most commercial plans use, for the scale
const PARTITION = 0.125; // m: a stud partition with board both sides, the scale without doors
const MAX_SPAN = 500; // m: a drawing scaled to more than this is taken as a misread
const MIN_SPAN = 4;
const MIN_ROOM = 0.9; // m²: smaller enclosed areas are wall cavities or symbols, not rooms
const NOTE_RATIO = 1.45; // a scale note holds while the doors make it no more than this far off

/**
 * Trace walls, doors, windows, rooms and furniture in a floor plan image. See the top of this file.
 * onProgress(fraction, phase) is called between the steps.
 */
export function traceFloorPlan(image, { onProgress = null, debug = false, metersPerPixel: known = null } = {}) {
  const { width: W, height: H } = image;
  const empty = { width: W, height: H, thickness: 0, walls: [], openings: [], rooms: [], scale: { metersPerPixel: null, source: null, doors: 0 } };
  if (!(W > 8 && H > 8) || !image.data || image.data.length < W * H * 4) return empty;
  const step = (f, phase) => onProgress?.(f, phase);

  step(0, 'ink');
  const { ink, black, faint } = inkMasks(image);
  // Walls are black in nearly every drawing; colored text and markup are left out of them. A
  // drawing in color only (blue walls, say) falls back to every dark pixel.
  let wallInk = black;
  let segs = findSegments(wallInk, W, H);
  if (segs.length < 4) {
    wallInk = ink;
    segs = findSegments(wallInk, W, H);
  }
  step(0.35, 'walls');
  const T = typicalThickness(segs);
  if (!T) return empty;
  const stubs = jambStubs(segs, T);
  segs = cleanSegments(segs, T, wallInk, W, H);
  if (!segs.length) return empty;
  extendEnds(segs, wallInk, W, H, T);
  segs = mergeCollinear(segs, T, 1);
  // Jamb stubs too short to be walls take part only to frame doors (see jambStubs); one in line
  // with a wall's end is that wall carrying on to its jamb.
  segs.push(...stubs.filter((st) => !segs.some((w) => covers(w, st))));
  segs = mergeCollinear(segs, T, Math.max(2, 0.5 * T));

  const stages = debug ? {} : null;
  const snap = (name) => { if (stages) stages[name] = segs.filter((x) => !x.dead).map((x) => ({ axis: x.axis, c: x.c, s0: x.s0, s1: x.s1, t: x.t, stub: !!x.stub })); };
  snap('clean');
  snapJunctions(segs, T);
  snap('snapped');
  step(0.5, 'doors');
  const checked = debug ? [] : null;
  const gaps = resolveGaps(segs, ink, faint, W, H, T, checked);
  snap('gaps');
  segs = mergeCollinear(segs.filter((s) => !s.dead && (!s.stub || s.used)), T, 1);
  snap('merged');
  segs = dropStrays(segs, T, gaps);
  snap('strays');
  segs = dropShort(segs, gaps, T);
  snap('short');
  segs = dropStrays(segs, T, gaps);
  segs = dropOutliers(segs, T);
  step(0.7, 'rooms');
  // Rooms and furniture; the outline of a cabinet or appliance can pass for short walls, which go
  // once the furniture shows them to be its edges, and the rooms are found again without them.
  let laid = arrange(segs, gaps, ink, faint, W, H, T, known);
  const edges = furnitureWalls(segs, laid, T, wallInk, W, H);
  if (edges.size) {
    segs = segs.filter((s, i) => !edges.has(i));
    laid = arrange(segs, gaps, ink, faint, W, H, T, known);
  }
  const { openings, scale, mpp, rooms, exterior, beyond, keep, furnished } = laid;
  const index = [];
  const walls = [];
  segs.forEach((s, i) => {
    if (!keep[i]) return;
    index[i] = walls.length;
    const [a, b] = segEnds(s);
    walls.push({ a, b, thickness: s.t, exterior: exterior[i] });
  });
  // Windows the wall tracks ran on through, drawn as lines along the wall (see findWindows).
  segs.forEach((s, i) => {
    if (!keep[i] || !exterior[i]) return;
    for (const g of findWindows(s, ink, W, H, T, mpp)) {
      const mid = (g.g0 + g.g1) / 2, width = g.g1 - g.g0;
      if (openings.some((o) => o.wall === i && Math.abs(o.mid - mid) < (o.width + width) / 2)) continue;
      openings.push({ wall: i, type: 'window', offset: mid - s.s0, width, hinge: 'start', side: 1, mid });
    }
  });
  // Lines across a gap in an interior wall are the wall carrying on past something drawn against
  // it (casework, a column); only outside walls get windows.
  const kept = openings.filter((o) => keep[o.wall] && (o.type !== 'window' || exterior[o.wall]));
  step(1, 'done');
  const extra = debug ? { debug: { segments: segs.map((s, i) => ({ ends: segEnds(s), t: s.t, exterior: exterior[i], beyond: beyond[i] })), gaps, checked, stages, shapes: furnished.shapes.map(({ pixels, ...rest }) => rest), itemMasks: furnished.debug } } : {};
  return {
    ...extra,
    width: W, height: H, thickness: T, walls,
    openings: kept.map((o) => ({ wall: index[o.wall], type: o.type, offset: o.offset, width: o.width, hinge: o.hinge, side: o.side })),
    rooms, scale, items: furnished.items,
  };
}

/**
 * The openings on the final walls, the scale, the rooms and outside, and the furniture: what the
 * tracer works out once it has its walls.
 */
function arrange(segs, gaps, ink, faint, W, H, T, known) {
  const openings = placeOpenings(gaps, segs, T);
  const scale = drawingScale(openings, segs, T, W, H, known);
  const mpp = scale.metersPerPixel;
  const { rooms, exterior, beyond, roomAt } = findRooms(segs, ink, W, H, T, mpp);
  // Walls wholly outside the building (a neighbor's, the site's) are context, not the space, when
  // nothing joins them to it; a wing the outside seems to reach is still joined to the rest.
  const group = groups(segs, T);
  const joined = new Set(segs.map((s, i) => (beyond[i] ? null : group[i])));
  const keep = segs.map((s, i) => !beyond[i] || joined.has(group[i]));
  const m = mpp || PARTITION / T;
  const furnished = findItems({
    lines: faint, W, H, T, mpp: m, roomAt, roomAreas: rooms.map((r) => r.area * m * m),
    walls: segs.filter((s, i) => keep[i]), doors: openings.filter((o) => o.type !== 'window').map((o) => o.gap),
  });
  return { openings, scale, mpp, rooms, exterior, beyond, keep, furnished };
}

/**
 * Interior walls that are furniture drawn with double lines. Short, thin ones that run along the
 * edge of a piece of furniture: a refrigerator's or cabinet's outline, a table's edge with the
 * chairs drawn along it; a partition is as thick as the others and runs on past the furniture
 * against it. And short, thick ones with nothing between their lines and no door: a row of
 * chairs, a run of low cabinets.
 */
function furnitureWalls(segs, laid, T, mask, W, H) {
  const out = new Set();
  const m = laid.mpp || PARTITION / T;
  segs.forEach((s, i) => {
    if (laid.exterior[i]) return;
    // Lines across a gap in an interior wall are no window (see traceFloorPlan), and the seat
    // fronts of two chairs side by side can pass for a narrow door's swing.
    const door = laid.openings.some((o) => o.wall === i && o.type !== 'window' && o.width * m >= 0.75);
    if (s.t >= 2 * T && len(s) * m <= 1.6 && !door && hollow(s, mask, W, H)) {
      out.add(i);
      return;
    }
    if (s.t >= 0.8 * T || len(s) * m > 1.6) return;
    const [a, b] = segEnds(s);
    for (const f of laid.furnished.shapes) {
      // The wall lies on one of the shape's sides and does not run much past it.
      const tol = Math.max(3, s.t);
      const onSide = s.axis === 'v'
        ? (Math.abs(s.c - f.x0) <= tol || Math.abs(s.c - f.x1) <= tol) && a.y >= f.y0 - 2 * tol && b.y <= f.y1 + 2 * tol
        : (Math.abs(s.c - f.y0) <= tol || Math.abs(s.c - f.y1) <= tol) && a.x >= f.x0 - 2 * tol && b.x <= f.x1 + 2 * tol;
      if (onSide && f.L * m <= 2.6) {
        out.add(i);
        break;
      }
    }
  });
  return out;
}

/** Whether a wall track is two lines with paper between them. */
function hollow(s, mask, W, H) {
  const v0 = Math.round(s.c - s.t / 2) + 2, v1 = Math.round(s.c + s.t / 2) - 3;
  if (v1 - v0 < 2) return false;
  let n = 0, dark = 0;
  for (let u = Math.ceil(s.s0); u < s.s1; u++) {
    for (let v = v0; v <= v1; v++) {
      const x = s.axis === 'v' ? v : u, y = s.axis === 'v' ? u : v;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      n++;
      dark += mask[y * W + x];
    }
  }
  return n > 0 && dark < 0.15 * n;
}

/**
 * The trace in plan meters: walls ({a, b, kind, thickness}), openings ({wall, type, offset,
 * width, hinge, side} with side in the model's sense, toward wallNormal), rooms ({points}) and
 * furniture (items as findItems gives them, at and sized in meters). origin is where the image's
 * top-left corner sits on the plan.
 */
export function toPlanGeometry(trace, { metersPerPixel, origin = { x: 0, y: 0 } }) {
  const k = metersPerPixel;
  const P = (p) => ({ x: origin.x + p.x * k, y: origin.y + p.y * k });
  const walls = trace.walls.map((w) => ({
    a: P(w.a), b: P(w.b),
    kind: w.exterior ? 'exterior' : 'interior',
    // Drawings often exaggerate thin walls; keep them within what partitions and shells measure.
    thickness: Math.min(w.exterior ? 0.6 : 0.3, Math.max(0.06, w.thickness * k)),
  }));
  const openings = trace.openings.map((o) => {
    const w = trace.walls[o.wall];
    // The trace's side is +x or +y; the model's is toward the wall normal, its direction turned
    // clockwise, which for a wall running +y (a to b) is -x and for one running +x is +y.
    const vertical = Math.abs(w.b.x - w.a.x) < Math.abs(w.b.y - w.a.y);
    return { wall: o.wall, type: o.type, offset: o.offset * k, width: o.width * k, hinge: o.hinge, side: vertical ? -o.side : o.side };
  });
  const rooms = trace.rooms.map((r) => ({ points: r.points.map(P), area: r.area * k * k }));
  const items = (trace.items || []).map((f) => ({ ...f, ...P(f), w: f.w * k, d: f.d * k }));
  return { walls, openings, rooms, items };
}

// ---- Ink ----------------------------------------------------------------------------------------

/**
 * ink: pixels darker than the paper, black: the ones among them without much color, faint: ink
 * plus the light grey door swings and leaves are often drawn in. A drawing with light lines on a
 * dark ground (a blueprint) is read inverted.
 */
function inkMasks({ width: W, height: H, data }) {
  const n = W * H;
  const lum = new Uint8Array(n), sat = new Uint8Array(n);
  let sum = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2], a = data[p + 3];
    // Transparent pixels are paper.
    const l = a < 128 ? 255 : 0.299 * r + 0.587 * g + 0.114 * b;
    lum[i] = l;
    sat[i] = a < 128 ? 0 : Math.max(r, g, b) - Math.min(r, g, b);
    sum += l;
  }
  const inverted = sum / n < 110;
  const ink = new Uint8Array(n), black = new Uint8Array(n), faint = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const l = inverted ? 255 - lum[i] : lum[i];
    if (l < 215) faint[i] = 1;
    if (l < 150) {
      ink[i] = 1;
      if (sat[i] < 70) black[i] = 1;
    }
  }
  return { ink, black, faint };
}

const transpose = (mask, W, H) => {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[x * H + y] = mask[y * W + x];
  return out;
};

// ---- Wall sections and tracks ------------------------------------------------------------------

/**
 * Wall candidates in both directions: { axis: 'v' | 'h', c (center line, x or y), s0, s1 (extent
 * along it), t (thickness), n (rows that matched) }, all in px.
 */
function findSegments(mask, W, H) {
  const tMax = Math.max(40, Math.round(Math.max(W, H) / 60));
  const vertical = tracks(mask, W, H, tMax).map((t) => ({ axis: 'v', ...t }));
  const horizontal = tracks(transpose(mask, W, H), H, W, tMax).map((t) => ({ axis: 'h', ...t }));
  return [...vertical, ...horizontal];
}

/**
 * Sections that repeat at the same place in consecutive rows. Each row of `mask` (W wide, H rows)
 * is split into dark runs; a section is either one run 3 px to tMax wide (a solid wall) or two
 * thin runs at most tMax apart overall (a wall drawn as two lines). A track follows a section
 * down the rows while it stays within a pixel of where it started, bridging up to two rows where
 * something crosses it (a dimension line, a door leaf touching the face).
 */
function tracks(mask, W, H, tMax) {
  const GAP = 2;
  const MIN_LEN = 3;
  const done = [];
  let active = [];
  const runs = new Int32Array(W + 2);
  for (let y = 0; y <= H; y++) {
    const sections = [];
    if (y < H) {
      let nr = 0;
      const base = y * W;
      for (let x = 0; x < W;) {
        if (!mask[base + x]) { x++; continue; }
        const s = x;
        while (x < W && mask[base + x]) x++;
        runs[nr++] = s;
        runs[nr++] = x - 1;
      }
      for (let i = 0; i < nr; i += 2) {
        const s = runs[i], e = runs[i + 1], w = e - s + 1;
        if (w >= 3 && w <= tMax) sections.push(s, e);
        // Lines: the outer two thin next to the space between them. Up to four lines, for walls
        // built back to back or drawn with a center line.
        for (let j = i + 2; j < nr && j <= i + 6; j += 2) {
          const s2 = runs[j], e2 = runs[j + 1], span = e2 - s + 1;
          if (span > tMax) break;
          const edge = Math.max(2, Math.floor(span * 0.6));
          if (span >= 4 && w <= edge && e2 - s2 + 1 <= edge) sections.push(s, e2);
        }
      }
    }
    // Match each section to the track that started at the same place; a track takes one a row.
    const next = [];
    const byStart = new Map();
    for (const t of active) {
      if (y - t.last > GAP + 1) {
        if (t.last - t.y0 + 1 >= MIN_LEN) done.push(t);
        continue;
      }
      next.push(t);
      for (let d = -1; d <= 1; d++) {
        const key = t.x0 + d;
        const list = byStart.get(key);
        if (list) list.push(t); else byStart.set(key, [t]);
      }
    }
    for (let i = 0; i < sections.length; i += 2) {
      const x0 = sections[i], x1 = sections[i + 1];
      let best = null, bestD = 3;
      for (const t of byStart.get(x0) || []) {
        if (t.last === y) continue;
        const d = Math.abs(t.x0 - x0) + Math.abs(t.x1 - x1);
        if (Math.abs(t.x1 - x1) <= 1 && d < bestD) { best = t; bestD = d; }
      }
      if (best) {
        best.last = y;
        best.n++;
        best.sx0 += x0;
        best.sx1 += x1;
      } else {
        const t = { x0, x1, y0: y, last: y, n: 1, sx0: x0, sx1: x1 };
        next.push(t);
        for (let d = -1; d <= 1; d++) {
          const list = byStart.get(x0 + d);
          if (list) list.push(t); else byStart.set(x0 + d, [t]);
        }
      }
    }
    active = next;
  }
  for (const t of active) if (t.last - t.y0 + 1 >= MIN_LEN) done.push(t);
  return done
    .filter((t) => t.n >= 0.6 * (t.last - t.y0 + 1))
    .map((t) => {
      const x0 = t.sx0 / t.n, x1 = t.sx1 / t.n;
      return { c: (x0 + x1 + 1) / 2, s0: t.y0, s1: t.last + 1, t: x1 - x0 + 1, n: t.n };
    });
}

const len = (s) => s.s1 - s.s0;

/** The wall thickness most of the drawing's wall length has: the weighted median of the long tracks. */
function typicalThickness(segs) {
  const long = segs.filter((s) => len(s) >= Math.max(24, 4 * s.t)).sort((p, q) => p.t - q.t);
  const total = long.reduce((sum, s) => sum + len(s), 0);
  if (!total) return 0;
  let acc = 0;
  for (const s of long) {
    acc += len(s);
    if (acc >= total / 2) return s.t;
  }
  return long[long.length - 1].t;
}

/**
 * Keep the tracks that can be walls (about the typical thickness up to a thick shell wall, long
 * enough not to be a symbol), then merge the pieces of one wall and the duplicates a wall drawn
 * with both lines and fill produces.
 */
function cleanSegments(segs, T, mask, W, H) {
  const tMin = Math.max(2, 0.45 * T), tMax = Math.max(tMin + 2, 3.2 * T);
  const minLen = Math.max(10, 2.5 * T);
  const kept = segs.filter((s) => s.t >= tMin && s.t <= tMax && len(s) >= minLen && !(len(s) < 8 * T && crossed(s, mask, W, H)));
  return mergeCollinear(suppressOverlaps(pruneSharedFaces(kept)), T, Math.max(3, 0.6 * T));
}

/**
 * Whether ink crosses a hollow wall's inside in most of its rows. A wall drawn as two lines is
 * clear between them (or filled solid); two unrelated parallel lines with a door swing or text
 * between them are not. Only short pieces are tested: long walls cross junctions all along.
 */
function crossed(s, mask, W, H) {
  const v0 = Math.round(s.c - s.t / 2) + 2, v1 = Math.round(s.c + s.t / 2) - 3;
  if (v1 - v0 < 1) return false;
  let rows = 0, hit = 0, full = 0;
  for (let u = Math.ceil(s.s0); u < s.s1; u++) {
    let n = 0;
    for (let v = v0; v <= v1; v++) {
      const x = s.axis === 'v' ? v : u, y = s.axis === 'v' ? u : v;
      if (x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x]) n++;
    }
    rows++;
    if (n === v1 - v0 + 1) full++;
    else if (n > 0) hit++;
  }
  return full < 0.5 * rows && hit > 0.5 * rows;
}

/**
 * A line is the face of one wall only. Two parallel lines can pair up as a section without being
 * a wall: a wall's face and the edge of furniture standing in front of it, the facing sides of two
 * walls with a chase between. Tracks are taken longest first and, of tracks about as long, widest
 * first (two walls built back to back read as one); one that shares a face with a track already
 * taken goes when it is clearly shorter or wider than that track. Narrower tracks nested inside a
 * kept one go in suppressOverlaps.
 */
function pruneSharedFaces(segs) {
  const faces = (s) => [s.c - s.t / 2, s.c + s.t / 2];
  const order = segs.slice().sort((p, q) => {
    const lp = len(p), lq = len(q);
    if (Math.abs(lp - lq) > 0.1 * Math.max(lp, lq)) return lq - lp;
    return q.t - p.t;
  });
  const kept = [];
  for (const s of order) {
    const [f0, f1] = faces(s);
    const borrowed = kept.some((k) => {
      if (k.axis !== s.axis || Math.abs(k.c - s.c) > (k.t + s.t) / 2 + 2) return false;
      const along = Math.min(s.s1, k.s1) - Math.max(s.s0, k.s0);
      if (along < 0.5 * Math.min(len(s), len(k))) return false;
      const [g0, g1] = faces(k);
      const shared = [f0, f1].some((f) => Math.abs(f - g0) <= 1 || Math.abs(f - g1) <= 1);
      return shared && (len(s) < 0.7 * len(k) || s.t > k.t + 1);
    });
    if (!borrowed) kept.push(s);
  }
  return kept;
}

/**
 * One wall can yield several tracks: its two lines, and each line paired with a parallel line
 * close by (a counter edge, the other wall of two built back to back). Keep the track that
 * explains the most: the longest, and of tracks about as long, the widest. A track mostly
 * alongside a kept one, overlapping it across, goes.
 */
function suppressOverlaps(segs) {
  const order = segs.slice().sort((p, q) => {
    const lp = len(p), lq = len(q);
    if (Math.abs(lp - lq) > 0.1 * Math.max(lp, lq)) return lq - lp;
    return q.t - p.t || lq - lp;
  });
  const kept = [];
  for (const s of order) {
    const lo = s.c - s.t / 2, hi = s.c + s.t / 2;
    const hidden = kept.some((k) => {
      if (k.axis !== s.axis) return false;
      const across = Math.min(hi, k.c + k.t / 2) - Math.max(lo, k.c - k.t / 2);
      if (across < 0.5 * Math.min(s.t, k.t)) return false;
      const along = Math.min(s.s1, k.s1) - Math.max(s.s0, k.s0);
      return along >= 0.7 * len(s);
    });
    if (!hidden) kept.push(s);
  }
  return kept;
}

/**
 * The short pieces of wall a drawing puts at door jambs (returns at a corner, the wall between a
 * door and the wall across) are too short to track as walls, and a door framed only by them (a
 * closet or IT room whose whole front is its door) has no wall end to be found from. They are
 * kept apart as stubs, about a wall thick, and become walls only where a door closes on them.
 */
function jambStubs(segs, T) {
  const minLen = Math.max(10, 2.5 * T);
  return segs
    .filter((s) => len(s) >= 3 && len(s) < minLen && s.t >= 0.6 * T && s.t <= 1.6 * T)
    .map((s) => ({ ...s, stub: true }));
}

/** Whether wall w's footprint (its band, past its ends by half its thickness) holds the middle of s. */
const covers = (w, s) => {
  const m = (s.s0 + s.s1) / 2;
  const [x, y] = s.axis === 'v' ? [s.c, m] : [m, s.c];
  const [u, v] = w.axis === 'v' ? [y, x] : [x, y];
  return Math.abs(v - w.c) <= w.t / 2 + 1 && u >= w.s0 - w.t / 2 - 1 && u <= w.s1 + w.t / 2 + 1;
};

/**
 * Merge segments of one axis that lie on the same line (centers within a quarter of their
 * thickness) and overlap or nearly touch (within `gap`). The merged segment keeps the center and
 * thickness of its longer part. Joins recorded on the ends carry over.
 */
function mergeCollinear(segs, T, gap) {
  const out = [];
  for (const axis of ['v', 'h']) {
    const list = segs.filter((s) => s.axis === axis).sort((p, q) => p.c - q.c || p.s0 - q.s0);
    const used = new Uint8Array(list.length);
    for (let i = 0; i < list.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      // Gather the segments on this line, then join the runs along it.
      const line = [list[i]];
      for (let j = i + 1; j < list.length && list[j].c - list[i].c <= Math.max(1.5, 0.3 * T); j++) {
        if (used[j]) continue;
        const a = list[i], b = list[j];
        if (Math.abs(a.c - b.c) <= Math.max(1.5, 0.25 * Math.max(a.t, b.t)) && Math.abs(a.t - b.t) <= Math.max(2, 0.45 * Math.max(a.t, b.t))) {
          used[j] = 1;
          line.push(b);
        }
      }
      line.sort((p, q) => p.s0 - q.s0);
      let cur = null;
      for (const s of line) {
        if (cur && s.s0 <= cur.s1 + gap) {
          const lc = len(cur), ls = len(s);
          if (ls > lc) {
            cur.c = s.c;
            cur.t = s.t;
          }
          // A stub that joins a wall is part of that wall.
          cur.stub = cur.stub && s.stub;
          cur.used = cur.used || s.used;
          if (s.s1 > cur.s1) {
            cur.s1 = s.s1;
            cur.join1 = s.join1;
          }
          cur.n += s.n;
        } else {
          if (cur) out.push(cur);
          cur = { ...s };
        }
      }
      if (cur) out.push(cur);
    }
  }
  return out;
}

/**
 * Run each wall on past where its tracks stopped while its band keeps the look it has along its
 * length: filled for a solid wall, both faces drawn and the middle clear for a hollow one. Tracks
 * stop early where a wall's drawing changes (fill layers, the lines of a junction), which would
 * otherwise leave a gap beside a door jamb or a corner. Window lines in a gap change the look, so
 * windows stay gaps.
 */
function extendEnds(segs, mask, W, H, T) {
  const at = (axis, u, v) => {
    const x = axis === 'v' ? v : u, y = axis === 'v' ? u : v;
    return x >= 0 && y >= 0 && x < W && y < H ? mask[y * W + x] : 0;
  };
  for (const s of segs) {
    const v0 = Math.round(s.c - s.t / 2), v1 = Math.round(s.c + s.t / 2) - 1, vc = Math.round(s.c - 0.5);
    if (v1 - v0 < 2) continue;
    let mid = 0, n = 0;
    for (let u = Math.ceil(s.s0); u < s.s1; u += 2) {
      n++;
      mid += at(s.axis, u, vc);
    }
    const solid = n > 0 && mid >= 0.7 * n;
    const face = (u, v) => at(s.axis, u, v - 1) || at(s.axis, u, v) || at(s.axis, u, v + 1);
    const ok = (u) => {
      if (!solid) return face(u, v0) && face(u, v1) && !at(s.axis, u, vc);
      let ink = 0;
      for (let v = v0; v <= v1; v++) ink += at(s.axis, u, v);
      return ink >= 0.75 * (v1 - v0 + 1);
    };
    const limit = Math.round(6 * T);
    for (const dir of [-1, 1]) {
      let u = dir < 0 ? Math.floor(s.s0) - 1 : Math.ceil(s.s1);
      let good = dir < 0 ? s.s0 : s.s1, misses = 0;
      for (let k = 0; k < limit; k++, u += dir) {
        if (ok(u)) {
          good = dir < 0 ? u : u + 1;
          misses = 0;
        } else if (++misses > 2) break;
      }
      if (dir < 0) s.s0 = Math.min(s.s0, good); else s.s1 = Math.max(s.s1, good);
    }
  }
}

// ---- Junctions ---------------------------------------------------------------------------------

const segEnds = (s) => (s.axis === 'v'
  ? [{ x: s.c, y: s.s0 }, { x: s.c, y: s.s1 }]
  : [{ x: s.s0, y: s.c }, { x: s.s1, y: s.c }]);

/**
 * Join wall ends to the walls they meet. Drawings stop a wall at the face of the one it meets, so
 * an end within the other wall's half thickness plus a tolerance moves onto its center line; when
 * the meeting point is past (or near) the other wall's own end, that end comes along, which makes
 * an L corner. join0 and join1 record what each end met.
 */
function snapJunctions(segs, T) {
  const tol = Math.max(3, 0.8 * T);
  for (let pass = 0; pass < 2; pass++) {
    for (const A of segs) {
      for (const end of [0, 1]) {
        if (A[`join${end}`]) continue;
        const e = end ? A.s1 : A.s0;
        let best = null, bestD = Infinity;
        for (const B of segs) {
          if (B.axis === A.axis || B === A || B.stub) continue;
          const d = Math.abs(e - B.c);
          if (d > B.t / 2 + tol || d >= bestD) continue;
          if (A.c < B.s0 - A.t / 2 - tol || A.c > B.s1 + A.t / 2 + tol) continue;
          best = B;
          bestD = d;
        }
        if (!best) continue;
        if (end) A.s1 = best.c; else A.s0 = best.c;
        A[`join${end}`] = 'wall';
        if (A.stub) continue;
        const reach = A.t / 2 + tol;
        if (A.c <= best.s0 + reach) {
          best.s0 = Math.min(best.s0, A.c);
          if (Math.abs(best.s0 - A.c) <= reach) {
            best.s0 = A.c;
            best.join0 = 'wall';
          }
        }
        if (A.c >= best.s1 - reach) {
          best.s1 = Math.max(best.s1, A.c);
          if (Math.abs(best.s1 - A.c) <= reach) {
            best.s1 = A.c;
            best.join1 = 'wall';
          }
        }
      }
    }
  }
  for (const s of segs) if (s.s1 - s.s0 < 1) s.dead = true;
}

// ---- Doors, windows and gaps ---------------------------------------------------------------------

/**
 * Look past every free wall end along its line for the next wall: another piece of the same wall
 * (collinear) or a wall across the line. A small gap closes; a door-sized one is checked for a
 * door swing or window lines and, when one is there, closes with an opening in it; anything else
 * stays open (a passage). Returns the openings as { axis, c, g0, g1, t, type, hinge, side }.
 */
function resolveGaps(segs, ink, faint, W, H, T, log = null) {
  const found = [];
  const seen = new Set();
  const close = Math.max(2, 1.0 * T);
  const far = 16 * T;
  // A stub frames a door only standing off a wall, and only across a door's width.
  const anchored = (s) => !s.stub || s.join0 || s.join1;
  const doorMin = 2.5 * T, doorMax = 9 * T;
  // An opening found already from another track along the same wall (a column or a dimension
  // drawn against its face) is not a second one.
  const taken = (A, t, a0, a1) => found.some((f) => f.axis === A.axis && Math.abs(f.c - A.c) <= 0.75 * (f.t + t)
    && Math.min(f.g1, a1) - Math.max(f.g0, a0) > 0.5 * Math.min(f.g1 - f.g0, a1 - a0));
  for (const A of segs) {
    if (A.dead || !anchored(A)) continue;
    for (const end of [0, 1]) {
      if (A[`join${end}`]) continue;
      const e = end ? A.s1 : A.s0;
      const dir = end ? 1 : -1;
      const stops = [];
      for (const B of segs) {
        if (B === A || B.dead || !anchored(B)) continue;
        let d, at;
        if (B.axis !== A.axis && B.stub) continue;
        if (B.axis === A.axis) {
          if (Math.abs(B.c - A.c) > Math.max(2, 0.35 * Math.max(A.t, B.t))) continue;
          if (B.t < 0.5 * A.t || B.t > 2 * A.t) continue;
          const face = end ? B.s0 : B.s1;
          d = (face - e) * dir;
          at = face;
        } else {
          // The wall across may stop just short of this one's line, at its face.
          const reach = A.t / 2 + Math.max(3, 0.8 * T);
          if (A.c < B.s0 - reach || A.c > B.s1 + reach) continue;
          const face = B.c - dir * B.t / 2;
          d = (face - e) * dir;
          at = B.c;
        }
        if (d < -1 || d > far) continue;
        stops.push({ B, d, at });
      }
      if (!stops.length) continue;
      stops.sort((p, q) => p.d - q.d);
      // The nearest wall along the line usually bounds the gap; when something drawn across it
      // reads as a short wall (a door leaf paired with a parallel line), the door lies past it, so
      // the next two count as well.
      for (const best of stops.slice(0, 3)) {
        const key = best.B.axis === A.axis ? [A, best.B].map((x) => segs.indexOf(x)).sort().join('-') : null;
        if (key && seen.has(key)) break;
        const g0 = end ? e : e - best.d, g1 = end ? e + best.d : e;
        if (best.d <= close) {
          if (key) seen.add(key);
          joinGap(A, end, best);
          break;
        }
        if ((A.stub || best.B.stub) && (best.d < doorMin || best.d > doorMax)) continue;
        const t = best.B.axis === A.axis ? Math.max(A.t, best.B.t) : A.t;
        // The opening itself starts where the wall's band empties: a stub too short to track (the
        // return at a corner, a jamb) still stands between the wall it ends at and the door.
        const [o0, o1] = openingSpan(ink, W, H, A.axis, A.c, t, g0, g1, end === 1, T);
        if (taken(A, t, o0, o1)) continue;
        const door = o1 - o0 >= doorMin ? doorAt(faint, W, H, A.axis, A.c, o0, o1, t) : null;
        const window = door ? null : windowAt(ink, W, H, A.axis, A.c, g0, g1, t, T);
        log?.push({ axis: A.axis, c: A.c, g0, g1, t, to: best.B.axis === A.axis ? 'collinear' : 'across', door: door?.type || null, window: !!window, B: [best.B.axis, best.B.c, best.B.s0, best.B.s1, best.B.t, !!best.B.stub], A: [A.s0, A.s1, !!A.stub] });
        if (!door && !window) continue;
        if (key) seen.add(key);
        joinGap(A, end, best);
        found.push(door ? { axis: A.axis, c: A.c, g0: o0, g1: o1, t, ...door } : { axis: A.axis, c: A.c, g0, g1, t, ...window });
        break;
      }
    }
  }
  return found;
}

/** Close the gap past end `end` of A: run on into the collinear piece, or end on the wall across. */
function joinGap(A, end, { B, at }) {
  A.used = B.used = true;
  if (B.axis === A.axis) {
    // The two pieces become one wall in the merge that follows: let them touch.
    if (end) {
      A.s1 = at;
      A.join1 = 'wall';
      B.join0 = 'wall';
    } else {
      A.s0 = at;
      A.join0 = 'wall';
      B.join1 = 'wall';
    }
  } else {
    if (end) {
      A.s1 = at;
      A.join1 = 'wall';
    } else {
      A.s0 = at;
      A.join0 = 'wall';
    }
    // The wall across comes to meet this one when it stopped short of its line (a tee).
    if (A.c > B.s1) {
      B.s1 = A.c;
      B.join1 = 'wall';
    } else if (A.c < B.s0) {
      B.s0 = A.c;
      B.join0 = 'wall';
    }
  }
}

/**
 * The opening in the gap from g0 to g1, seen from this wall's end (`fromStart`: the wall ends at
 * g0): it starts past any solid stub at that end and runs to the first line across the wall's band,
 * which is the far jamb. Measuring to that line rather than to the wall found across keeps the
 * opening right however that wall's lines were paired (two walls built back to back, say).
 */
function openingSpan(ink, W, H, axis, c, t, g0, g1, fromStart, T) {
  const v0 = Math.round(c - t / 2), v1 = Math.round(c + t / 2) - 1;
  const at = (u, v) => {
    const x = axis === 'v' ? v : u, y = axis === 'v' ? u : v;
    return x >= 0 && y >= 0 && x < W && y < H && ink[y * W + x];
  };
  // A line across the band, face to face: a jamb, or the wall across. A symbol against one face
  // (a column marker, a tag) does not reach the other.
  const full = (u) => {
    let n = 0, hit = 0;
    for (let v = v0; v <= v1; v++) {
      n++;
      if (at(u, v)) hit++;
    }
    return hit >= 0.6 * n && face(u, v0) && face(u, v1);
  };
  const face = (u, v) => at(u, v - 1) || at(u, v) || at(u, v + 1);
  // Open band: neither face drawn and nothing across, as in the opening itself.
  const open = (u) => !face(u, v0) && !face(u, v1) && !full(u);
  const most = 0.35 * (g1 - g0);
  let a = Math.ceil(g0), b = Math.floor(g1) - 1;
  // The first line across from u on in direction dir. A mark no wider than a wall with open band
  // past it (a tag's letter set on the wall's line) lies inside the opening and is passed over.
  const jamb = (u, dir) => {
    for (;;) {
      while (u >= a && u <= b && !full(u)) u += dir;
      let w = u;
      while (w >= a && w <= b && full(w)) w += dir;
      const past = [w, w + dir, w + 2 * dir];
      if (Math.abs(w - u) > T || !past.every((x) => x >= a && x <= b && open(x))) return u;
      u = w;
    }
  };
  if (fromStart) {
    while (a - g0 < most && full(a)) a++;
    b = jamb(a, 1) - 1;
  } else {
    while (g1 - b < most && full(b)) b--;
    a = jamb(b, -1) + 1;
  }
  return [a, b + 1];
}

const inkNear = (ink, W, H, x, y) => {
  const cx = Math.round(x), cy = Math.round(y);
  for (let dy = -1; dy <= 1; dy++) {
    const yy = cy + dy;
    if (yy < 0 || yy >= H) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const xx = cx + dx;
      if (xx >= 0 && xx < W && ink[yy * W + xx]) return true;
    }
  }
  return false;
};

/**
 * How well a door swing is drawn about a hinge at `along` on the wall line (`across` is the face it
 * swings from), radius R, sweeping from the closed position along the wall (θ = 0) to the side.
 * A door drawn wide open shows the whole quarter circle and its leaf standing square to the wall;
 * one drawn ajar shows the arc from the closed position as far as its leaf (30° at least). Either
 * way the arc has to run unbroken (dense parallel lines, such as racking or hatching, hit a circle
 * often but in short bursts) and end at a leaf drawn from the hinge. Returns { score, control }:
 * the ink along the drawn part, and along the same part of a circle a third smaller, which is
 * empty in front of a real door. A score of 0 means no swing.
 */
function swing(ink, W, H, axis, along, across, dirAlong, side, R) {
  const hit = (th, r) => {
    const u = along + dirAlong * r * Math.cos(th), v = across + side * r * Math.sin(th);
    return (axis === 'v' ? inkNear(ink, W, H, v, u) : inkNear(ink, W, H, u, v)) ? 1 : 0;
  };
  const steps = Math.max(12, Math.ceil((R * Math.PI) / 2 / 1.5));
  const angle = (k) => (k / steps) * (Math.PI / 2);
  const hits = new Uint8Array(steps + 1);
  for (let k = 0; k <= steps; k++) hits[k] = hit(angle(k), R);
  const leafAt = (k) => {
    let n = 0, h = 0;
    for (let f = 0.25; f <= 0.9; f += 0.13) {
      n++;
      h += hit(angle(k), R * f);
    }
    return h / n;
  };
  // The ends are left out: there the arc meets the wall and the leaf, which are drawn anyway.
  const lo = Math.max(1, Math.round(0.1 * steps)), hi = Math.round(0.9 * steps);
  // The unbroken run from the closed end, allowing single misses.
  let end = lo - 1, miss = 0;
  for (let k = lo; k <= hi; k++) {
    if (hits[k]) {
      end = k;
      miss = 0;
    } else if (++miss > 1) break;
  }
  let a = 0, b = -1;
  if (end >= hi - 1 && leafAt(steps) >= 0.6) {
    a = lo;
    b = hi;
  } else if (end >= Math.round(steps / 3) && end < hi && leafAt(end) >= 0.6) {
    a = lo;
    b = end;
  }
  if (b < a) return { score: 0, control: 1 };
  let score = 0, control = 0;
  for (let k = a; k <= b; k++) {
    score += hits[k];
    control += hit(angle(k), R * 0.62);
  }
  return { score: score / (b - a + 1), control: control / (b - a + 1) };
}

/**
 * A door in the gap from g0 to g1 along a wall on line c: a swing about one jamb with the gap's
 * width (a single door) or two about both jambs with half of it (a pair). The swing has to stand
 * out from the drawing around it (see swing), which keeps hatching and dense symbols from passing
 * as doors.
 */
function doorAt(ink, W, H, axis, c, g0, g1, t) {
  const w = g1 - g0;
  let best = null;
  const consider = (score, door) => {
    if (score > (best?.score ?? 0)) best = { score, ...door };
  };
  const passes = (s, min) => s.score >= min && s.score - s.control >= 0.3;
  // The arc has to match within about a pixel, so radii are tried in small steps: the leaf is
  // the opening's width give or take the frame.
  const radii = (span) => {
    const out = [];
    const stepR = Math.max(1, span * 0.02);
    for (let R = 0.8 * span; R <= 1.1 * span; R += stepR) out.push(R);
    return out;
  };
  for (const side of [1, -1]) {
    for (const face of [c + (side * t) / 2, c + side * (t / 2 - 1), c]) {
      for (const [hinge, along, dirAlong] of [['start', g0, 1], ['end', g1, -1]]) {
        for (const R of radii(w)) {
          const s = swing(ink, W, H, axis, along, face, dirAlong, side, R);
          if (passes(s, 0.6)) consider(s.score - s.control * 0.5, { type: 'door', hinge, side, leaf: R });
        }
      }
      for (const R of radii(w / 2)) {
        const s1 = swing(ink, W, H, axis, g0, face, 1, side, R);
        const s2 = swing(ink, W, H, axis, g1, face, -1, side, R);
        if (passes(s1, 0.55) && passes(s2, 0.55)) {
          consider((s1.score + s2.score) / 2 - (s1.control + s2.control) / 4 + 0.02, { type: 'double-door', hinge: 'start', side, leaf: R });
        }
      }
    }
  }
  return best ? { type: best.type, hinge: best.hinge, side: best.side, leaf: best.leaf } : null;
}

/** A window in the gap: two or more thin lines running its whole length inside the wall's thickness. */
function windowAt(ink, W, H, axis, c, g0, g1, t, T) {
  if (g1 - g0 < 2 * T) return null;
  let lines = 0, inLine = false;
  for (let v = Math.round(c - t / 2 - 1); v <= Math.round(c + t / 2 + 1); v++) {
    let hit = 0, n = 0;
    for (let u = Math.ceil(g0 + 1); u <= Math.floor(g1 - 1); u++) {
      n++;
      const x = axis === 'v' ? v : u, y = axis === 'v' ? u : v;
      if (x >= 0 && x < W && y >= 0 && y < H && ink[y * W + x]) hit++;
    }
    const full = n > 0 && hit >= 0.85 * n;
    if (full && !inLine) lines++;
    inLine = full;
  }
  return lines >= 2 ? { type: 'window', hinge: 'start', side: 1 } : null;
}

/**
 * Windows along an outside wall that its track ran on through: stretches at least 0.45 m long
 * where the wall is drawn as three or more thin lines along it (its faces and the glass between)
 * rather than as its band or pair of lines, or, in a solid wall, as two. The glass lines keep
 * their place across the band all along a window, which hatching drawn in a wall does not, and a
 * window ends at jambs, lines or solid wall across the band; the edge of a cabinet or shelf set
 * against the wall makes a line along it too, but its ends only touch the inside face.
 */
function findWindows(s, ink, W, H, T, mpp) {
  const v0 = Math.round(s.c - s.t / 2) - 1, v1 = Math.round(s.c + s.t / 2);
  const n = v1 - v0 + 1;
  const thin = Math.max(3, Math.round(0.3 * s.t));
  const at = (u, v) => {
    const x = s.axis === 'v' ? v : u, y = s.axis === 'v' ? u : v;
    return x >= 0 && y >= 0 && x < W && y < H && ink[y * W + x];
  };
  const u0 = Math.ceil(s.s0), u1 = Math.floor(s.s1);
  const face = (u, v) => at(u, v - 1) || at(u, v) || at(u, v + 1);
  const across = (u) => {
    let hit = 0;
    for (let v = v0 + 1; v < v1; v++) if (at(u, v)) hit++;
    return hit >= 0.6 * (n - 2) && face(u, v0 + 1) && face(u, v1 - 1);
  };
  const jamb = (u, dir) => across(u) || across(u + dir) || across(u + 2 * dir) || across(u + 3 * dir);
  const lines = [], inner = [];
  let solid = 0;
  for (let u = u0; u < u1; u++) {
    let hit = 0, start = -1, wide = false;
    const centers = [];
    for (let v = v0; v <= v1 + 1; v++) {
      const on = v <= v1 && at(u, v);
      if (on) hit++;
      if (on && start < 0) start = v;
      if (!on && start >= 0) {
        if (v - start > thin) wide = true;
        centers.push((start + v - 1) / 2);
        start = -1;
      }
    }
    if (hit >= 0.75 * n) solid++;
    lines.push(!wide && hit <= 0.6 * n ? centers.length : 0);
    inner.push(centers.length >= 3 ? centers[1] : centers.length === 2 ? centers[0] : NaN);
  }
  const need = solid >= 0.5 * lines.length ? 2 : 3;
  const minLen = mpp ? 0.45 / mpp : 4 * T;
  const out = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i] < need) {
      i++;
      continue;
    }
    // A stretch of glass, over gaps of a pixel or two (a blurred or broken line).
    let last = i, miss = 0;
    for (let j = i + 1; j < lines.length && miss < 3; j++) {
      if (lines[j] >= need) {
        last = j;
        miss = 0;
      } else miss++;
    }
    const glass = [];
    for (let k = i; k <= last; k++) if (lines[k] >= need && Number.isFinite(inner[k])) glass.push(inner[k]);
    const g0 = u0 + i, g1 = u0 + last + 1;
    if (g1 - g0 >= minLen && Math.max(...glass) - Math.min(...glass) <= 2 && jamb(g0 - 1, -1) && jamb(g1, 1)) out.push({ g0, g1 });
    i = last + 1;
  }
  return out;
}

/**
 * Keep the walls that form the building: groups of walls joined end to wall that hold a door or
 * window and are worth a room, larger groups without one, and long walls on their own. Furniture,
 * casework and symbols drawn with double lines (chairs, sofas, tables, counters) make groups of
 * their own with no doors; a block of rooms standing free in an open area has its doors.
 */
function dropStrays(segs, T, gaps) {
  const group = groups(segs, T);
  const total = new Map(), opened = new Set();
  segs.forEach((s, i) => {
    total.set(group[i], (total.get(group[i]) || 0) + len(s));
    if (holdsGap(s, gaps)) opened.add(group[i]);
  });
  const largest = Math.max(0, ...total.values());
  return segs.filter((s, i) => {
    const g = group[i];
    const enough = opened.has(g) ? 25 * T : Math.max(25 * T, 0.1 * largest);
    return total.get(g) >= enough || len(s) >= 30 * T;
  });
}

/**
 * Drop lines drawn around the plan rather than in it that pass for walls: a scale bar, a title's
 * rule. They are groups of parallel walls apart from the building (the group with the most wall)
 * and wholly outside its extent. A group with walls both ways may enclose space of its own, as a
 * detached building does, and stays.
 */
function dropOutliers(segs, T) {
  const group = groups(segs, T);
  const total = new Map();
  segs.forEach((s, i) => total.set(group[i], (total.get(group[i]) || 0) + len(s)));
  let main = null;
  for (const [g, L] of total) if (main === null || L > total.get(main)) main = g;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  segs.forEach((s, i) => {
    if (group[i] !== main) return;
    for (const p of segEnds(s)) {
      x0 = Math.min(x0, p.x - s.t);
      y0 = Math.min(y0, p.y - s.t);
      x1 = Math.max(x1, p.x + s.t);
      y1 = Math.max(y1, p.y + s.t);
    }
  });
  const apart = (s) => {
    const [a, b] = segEnds(s);
    return Math.max(a.x, b.x) < x0 || Math.min(a.x, b.x) > x1 || Math.max(a.y, b.y) < y0 || Math.min(a.y, b.y) > y1;
  };
  const others = new Map();
  segs.forEach((s, i) => {
    if (group[i] === main) return;
    const o = others.get(group[i]) || { apart: true, axes: new Set() };
    o.apart &&= apart(s);
    o.axes.add(s.axis);
    others.set(group[i], o);
  });
  return segs.filter((s, i) => {
    const o = others.get(group[i]);
    return !o || !o.apart || o.axes.size > 1;
  });
}

/** Whether a gap with a door or window found in it lies along s. */
const holdsGap = (s, gaps) => gaps.some((g) => g.axis === s.axis && Math.abs(s.c - g.c) <= Math.max(2, 0.5 * s.t) && s.s0 <= g.g0 + 1 && s.s1 >= g.g1 - 1);

/**
 * Drop short pieces that neither hold a door nor run between two real walls: the backs and arms of
 * chairs and sofas pushed against a wall, the returns of a counter. A short wall in a building
 * either frames a door or joins two longer walls (a jog, a pier between openings).
 */
function dropShort(segs, gaps, T) {
  const tol = Math.max(3, 0.8 * T);
  const short = (s) => len(s) < 5 * T;
  const holds = (s) => holdsGap(s, gaps);
  let out = segs;
  for (let pass = 0; pass < 2; pass++) {
    const anchored = (s, e) => out.some((o) => o !== s && o.axis !== s.axis && !short(o)
      && Math.abs(e - o.c) <= o.t / 2 + tol && s.c >= o.s0 - tol && s.c <= o.s1 + tol);
    out = out.filter((s) => !short(s) || holds(s) || (anchored(s, s.s0) && anchored(s, s.s1)));
  }
  return out;
}

/** Which walls are joined to which: a group id per wall, walls meeting end to wall sharing one. */
function groups(segs, T) {
  const n = segs.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = segs[i], b = segs[j];
      const linked = a.axis === b.axis
        ? Math.abs(a.c - b.c) <= Math.max(2, 0.35 * Math.max(a.t, b.t)) && Math.min(a.s1, b.s1) >= Math.max(a.s0, b.s0) - 1
        : touches(a, b, T) || touches(b, a, T);
      if (linked) parent[find(i)] = find(j);
    }
  }
  return segs.map((s, i) => find(i));
}

const touches = (o, s, T) => {
  const tol = Math.max(3, 0.8 * T);
  for (const e of [o.s0, o.s1]) {
    if (Math.abs(e - s.c) <= s.t / 2 + tol && o.c >= s.s0 - tol && o.c <= s.s1 + tol) return true;
  }
  return false;
};

/** Each opening on the final wall that holds its gap, with its offset from the wall's start. */
function placeOpenings(gaps, segs, T) {
  const out = [];
  for (const g of gaps) {
    let wall = -1, bestD = Infinity;
    segs.forEach((s, i) => {
      if (s.axis !== g.axis || s.s0 > g.g0 + 1 || s.s1 < g.g1 - 1) return;
      const d = Math.abs(s.c - g.c);
      if (d <= Math.max(2, 0.5 * s.t) && d < bestD) {
        wall = i;
        bestD = d;
      }
    });
    if (wall < 0) continue;
    const s = segs[wall];
    const width = g.g1 - g.g0;
    if (width < 1.5 * T) continue;
    if (out.some((o) => o.wall === wall && Math.abs(o.mid - (g.g0 + g.g1) / 2) < width / 2)) continue;
    out.push({ wall, type: g.type, offset: (g.g0 + g.g1) / 2 - s.s0, width, hinge: g.hinge, side: g.side, leaf: g.leaf, mid: (g.g0 + g.g1) / 2, gap: g });
  }
  return out;
}

// ---- Scale ---------------------------------------------------------------------------------------

/**
 * Meters per pixel: a known scale the doors do not contradict (see the top of this file), else from
 * the single doors, else from the partitions' thickness. A door's swing radius is its leaf, which
 * is 3'-0" far more often than not; the gap around it varies with how the frame is drawn.
 */
function drawingScale(openings, segs, T, W, H, known = null) {
  const doors = openings.filter((o) => o.type === 'door').map((o) => o.leaf).sort((a, b) => a - b);
  const span = Math.max(W, H);
  const ok = (mpp) => mpp > 0 && span * mpp >= MIN_SPAN && span * mpp <= MAX_SPAN;
  const byDoors = doors.length >= 2 ? DOOR_WIDTH / doors[doors.length >> 1] : null;
  if (ok(known)) {
    const off = ok(byDoors) ? Math.max(byDoors / known, known / byDoors) : 1;
    if (off <= NOTE_RATIO) return { metersPerPixel: known, source: 'note', doors: doors.length };
    return { metersPerPixel: byDoors, source: 'doors', doors: doors.length, noteMismatch: true };
  }
  if (ok(byDoors)) return { metersPerPixel: byDoors, source: 'doors', doors: doors.length };
  const mpp = PARTITION / T;
  if (segs.length >= 4 && ok(mpp)) return { metersPerPixel: mpp, source: 'walls', doors: doors.length };
  return { metersPerPixel: null, source: null, doors: doors.length };
}

// ---- Rooms and the building's outside ------------------------------------------------------------

/**
 * Rooms are the areas the walls (with their doors and windows shut) enclose, found on a grid of
 * cells half a wall thick. The building's outside is what the grid border reaches once the walls
 * are thickened enough to seal gaps of up to about 7 feet (an entrance with no swing found, a
 * storefront the drawing shows as a break); walls with the outside along one face are exterior.
 */
function findRooms(segs, ink, W, H, T, mpp) {
  const cs = Math.max(1, Math.round(T / 2));
  // The grid has a margin all round, so the outside can flow past walls drawn near the image's
  // edge once they are thickened.
  const r = Math.max(2, Math.ceil((7 * T) / cs));
  const P = r + 1;
  const nx = Math.ceil(W / cs) + 2 * P, ny = Math.ceil(H / cs) + 2 * P;
  const N = nx * ny;
  const cellOf = (x, y) => (Math.floor(y / cs) + P) * nx + Math.floor(x / cs) + P;
  const wall = new Uint8Array(N);
  const fill = (x0, y0, x1, y1) => {
    const cx0 = Math.max(0, Math.floor(x0 / cs) + P), cy0 = Math.max(0, Math.floor(y0 / cs) + P);
    const cx1 = Math.min(nx - 1, Math.floor(x1 / cs) + P), cy1 = Math.min(ny - 1, Math.floor(y1 / cs) + P);
    for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) wall[y * nx + x] = 1;
  };
  for (const s of segs) {
    const h = s.t / 2;
    if (s.axis === 'v') fill(s.c - h, s.s0 - h, s.c + h - 0.01, s.s1 + h - 0.01);
    else fill(s.s0 - h, s.c - h, s.s1 + h - 0.01, s.c + h - 0.01);
  }

  // The outside: flood from the border past walls thickened by r cells (sealing gaps up to about
  // 14 wall thicknesses, some 7 feet), then grown back by r.
  const thick = dilate(wall, nx, ny, r);
  const reach = new Uint8Array(N);
  const queue = new Int32Array(N);
  let qh = 0, qt = 0;
  const seed = (k) => {
    if (!thick[k] && !reach[k]) {
      reach[k] = 1;
      queue[qt++] = k;
    }
  };
  for (let x = 0; x < nx; x++) { seed(x); seed((ny - 1) * nx + x); }
  for (let y = 0; y < ny; y++) { seed(y * nx); seed(y * nx + nx - 1); }
  while (qh < qt) {
    const k = queue[qh++], x = k % nx;
    if (x > 0) seed(k - 1);
    if (x < nx - 1) seed(k + 1);
    if (k >= nx) seed(k - nx);
    if (k < N - nx) seed(k + nx);
  }
  const outside = dilate(reach, nx, ny, r);
  for (let k = 0; k < N; k++) if (wall[k]) outside[k] = 0;

  // Rooms: connected free cells inside. A partition that stops just short of the wall it meets
  // (a gap of up to about two wall thicknesses) does not join two rooms: they are told apart with
  // the walls thickened by two cells, then each grows back over the free cells along its walls.
  const free = (j) => !wall[j] && !outside[j];
  const sealed = dilate(wall, nx, ny, 2);
  const label = new Int32Array(N).fill(-1);
  let id = 0;
  for (let k0 = 0; k0 < N; k0++) {
    if (sealed[k0] || !free(k0) || label[k0] >= 0) continue;
    qh = qt = 0;
    label[k0] = id;
    queue[qt++] = k0;
    while (qh < qt) {
      const k = queue[qh++], x = k % nx;
      const visit = (j) => {
        if (!sealed[j] && free(j) && label[j] < 0) {
          label[j] = id;
          queue[qt++] = j;
        }
      };
      if (x > 0) visit(k - 1);
      if (x < nx - 1) visit(k + 1);
      if (k >= nx) visit(k - nx);
      if (k < N - nx) visit(k + nx);
    }
    id++;
  }
  qh = qt = 0;
  for (let k = 0; k < N; k++) if (label[k] >= 0) queue[qt++] = k;
  while (qh < qt) {
    const k = queue[qh++], x = k % nx;
    const grow = (j) => {
      if (free(j) && label[j] < 0) {
        label[j] = label[k];
        queue[qt++] = j;
      }
    };
    if (x > 0) grow(k - 1);
    if (x < nx - 1) grow(k + 1);
    if (k >= nx) grow(k - nx);
    if (k < N - nx) grow(k + nx);
  }
  const members = Array.from({ length: id }, () => []);
  for (let k = 0; k < N; k++) if (label[k] >= 0) members[label[k]].push(k);

  const minCells = mpp ? MIN_ROOM / (mpp * mpp) / (cs * cs) : (6 * T * 6 * T) / (cs * cs);
  const rooms = [];
  // Which room each cell is part of (an index into rooms), -1 for none.
  const cellRoom = new Int32Array(N).fill(-1);
  for (const cells of members) {
    if (cells.length < minCells || hatched(cells, ink, W, H, cs, nx, P)) {
      // Too small for a room, or hatched: poché, a shaft, a neighbor's space. It is not floor.
      if (cells.length >= minCells) for (const k of cells) outside[k] = 1;
      continue;
    }
    const outline = roomOutline(cells, wall, nx, ny);
    if (outline.length >= 4) {
      for (const k of cells) cellRoom[k] = rooms.length;
      rooms.push({ points: outline.map((p) => ({ x: (p.x - P) * cs, y: (p.y - P) * cs })), area: cells.length * cs * cs });
    }
  }

  // Exterior walls have the outside along one face for most of their length; walls with it along
  // both are beyond the building.
  const exterior = [], beyond = [];
  for (const s of segs) {
    const off = s.t / 2 + 1.5 * cs;
    let out0 = 0, out1 = 0, n = 0;
    for (let f = 0.1; f <= 0.9; f += 0.1) {
      const u = s.s0 + (s.s1 - s.s0) * f;
      n++;
      for (const sign of [-1, 1]) {
        const v = s.c + sign * off;
        const k = s.axis === 'v' ? cellOf(v, u) : cellOf(u, v);
        const o = k < 0 || k >= N ? 1 : outside[k];
        if (sign < 0) out0 += o; else out1 += o;
      }
    }
    const lo = Math.min(out0, out1), hi = Math.max(out0, out1);
    exterior.push(hi >= 0.6 * n && lo < 0.6 * n);
    beyond.push(lo >= 0.8 * n);
  }
  /** The room a pixel lies in (an index into rooms), or -1. */
  const roomAt = (x, y) => {
    const cx = Math.floor(x / cs) + P, cy = Math.floor(y / cs) + P;
    return cx < 0 || cy < 0 || cx >= nx || cy >= ny ? -1 : cellRoom[cy * nx + cx];
  };
  return { rooms, exterior, beyond, roomAt };
}

/**
 * Whether an area is hatched: ink on 45° streaks over a good share of it. Drawings hatch poché,
 * shafts and neighbors' space with 45° lines (the usual CAD pattern); a room's ink is mostly
 * straight across or along (furniture, text) or curved (door swings, fixtures).
 */
function hatched(cells, ink, W, H, cs, nx, P) {
  const L = 6;
  const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? ink[y * W + x] : 0);
  const streak = (x, y, dy) => {
    for (let k = 1; k < L; k++) if (!at(x + k, y + dy * k) && !at(x + k + 1, y + dy * k)) return false;
    return true;
  };
  let diag = 0, px = 0;
  for (const k of cells) {
    const x0 = ((k % nx) - P) * cs, y0 = (Math.floor(k / nx) - P) * cs;
    for (let y = Math.max(0, y0); y < Math.min(H, y0 + cs); y++) {
      for (let x = Math.max(0, x0); x < Math.min(W, x0 + cs); x++) {
        px++;
        if (ink[y * W + x] && (streak(x, y, -1) || streak(x, y, 1))) diag++;
      }
    }
  }
  return px > 0 && diag > 0.03 * px;
}

/** Max filter with a (2r + 1)² square, separably. */
function dilate(mask, nx, ny, r) {
  const tmp = new Uint8Array(nx * ny), out = new Uint8Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    // Two sweeps per row: the nearest set cell to the left and to the right.
    let last = -Infinity;
    for (let x = 0; x < nx; x++) {
      if (mask[y * nx + x]) last = x;
      if (x - last <= r) tmp[y * nx + x] = 1;
    }
    last = Infinity;
    for (let x = nx - 1; x >= 0; x--) {
      if (mask[y * nx + x]) last = x;
      if (last - x <= r) tmp[y * nx + x] = 1;
    }
  }
  for (let x = 0; x < nx; x++) {
    let last = -Infinity;
    for (let y = 0; y < ny; y++) {
      if (tmp[y * nx + x]) last = y;
      if (y - last <= r) out[y * nx + x] = 1;
    }
    last = Infinity;
    for (let y = ny - 1; y >= 0; y--) {
      if (tmp[y * nx + x]) last = y;
      if (last - y <= r) out[y * nx + x] = 1;
    }
  }
  return out;
}

/**
 * The outline of a room, in cell corners: its cells plus the wall cells next to them (so the
 * outline runs about along the walls' center lines), traced clockwise around the outside and
 * reduced to its corners.
 */
function roomOutline(cells, wall, nx, ny) {
  const inRoom = new Set();
  for (const k of cells) inRoom.add(k);
  for (const k of cells) {
    const x = k % nx;
    for (const j of [x > 0 ? k - 1 : -1, x < nx - 1 ? k + 1 : -1, k - nx, k + nx]) {
      if (j >= 0 && j < nx * ny && wall[j]) inRoom.add(j);
    }
  }
  const has = (x, y) => x >= 0 && y >= 0 && x < nx && y < ny && inRoom.has(y * nx + x);
  // Boundary edges, directed with the room on their right (clockwise in image coordinates).
  const V = nx + 1;
  const edges = new Map();
  const addEdge = (ax, ay, bx, by) => {
    const key = ay * V + ax;
    const list = edges.get(key);
    const e = { ax, ay, bx, by, used: false };
    if (list) list.push(e); else edges.set(key, [e]);
  };
  for (const k of inRoom) {
    const x = k % nx, y = Math.floor(k / nx);
    if (!has(x, y - 1)) addEdge(x, y, x + 1, y);
    if (!has(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
    if (!has(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
    if (!has(x - 1, y)) addEdge(x, y + 1, x, y);
  }
  let bestLoop = [], bestArea = 0;
  for (const list of edges.values()) {
    for (const start of list) {
      if (start.used) continue;
      const loop = [];
      let e = start;
      let guard = 0;
      while (e && !e.used && guard++ < 1e6) {
        e.used = true;
        loop.push({ x: e.ax, y: e.ay });
        const next = edges.get(e.by * V + e.bx);
        if (!next) break;
        // At a pinch (two outgoing edges) turn right, which keeps to one loop.
        const dx = e.bx - e.ax, dy = e.by - e.ay;
        let pick = null;
        for (const cand of next) {
          if (cand.used) continue;
          const cx = cand.bx - cand.ax, cy = cand.by - cand.ay;
          const turn = dx * cy - dy * cx; // > 0 turns right (y down)
          if (!pick || turn > pick.turn) pick = { cand, turn };
        }
        e = pick?.cand;
      }
      let area = 0;
      for (let i = 0; i < loop.length; i++) {
        const p = loop[i], q = loop[(i + 1) % loop.length];
        area += p.x * q.y - q.x * p.y;
      }
      if (Math.abs(area) > bestArea) {
        bestArea = Math.abs(area);
        bestLoop = loop;
      }
    }
  }
  // Keep the corners only.
  const out = [];
  const n = bestLoop.length;
  for (let i = 0; i < n; i++) {
    const p = bestLoop[(i + n - 1) % n], q = bestLoop[i], r2 = bestLoop[(i + 1) % n];
    if ((q.x - p.x) * (r2.y - q.y) - (q.y - p.y) * (r2.x - q.x) !== 0) out.push(q);
  }
  return out;
}
