// Furniture and fixtures in a floor plan drawing, for src/autotrace.js: the desks, counters,
// tables, chairs, sofas, beds, toilets, sinks and cabinets drawn inside the rooms. Each is found as
// the patch of floor its outline closes off from the room around it, so a chair drawn against a
// desk stays a chair of its own. It is measured, turned to face away from the wall it backs onto,
// and named by its size and shape. Plain functions on masks, no DOM.
//
// findItems({ lines, W, H, T, mpp, walls, doors, roomAt, roomAreas }) -> { items: [{
//   kind,           // 'desk' | 'counter' | 'table' | 'chair' | 'lounge' | 'seating' | 'bed'
//                   // | 'toilet' | 'sink' | 'storage' | 'appliance'
//   x, y, w, d,     // footprint center and size in image px: w across the item's front, d deep
//   rotation,       // degrees clockwise; 0 faces +y with its back toward -y, as plan items do
//   sink,           // true for a counter with a sink drawn in it
//   round,          // true for a round outline (a round table)
//   backed,         // true when something turned it: the wall behind it, or a chair's back or desk
//   at,             // for a chair: the kind of item it is pulled up to ('desk', 'table', ...) or null
// }], shapes, debug }
// lines: the drawing's ink (light lines included, for dashed furniture); walls: tracks
// { axis, c, s0, s1, t } in image px; doors: { axis, c, g0, g1, t, type, hinge, side, leaf };
// roomAt(x, y): the room a pixel is in, or -1; roomAreas: each room's area in m².
// An L- or U-shaped desk comes out as its straight runs, one desk each.

const MIN_AREA = 0.04; // m²: closed shapes smaller than this are lettering, hatching or marks
const MAX_SIDE = 4.5; // m: larger enclosures are spaces (a counter run, a vestibule), not items

export function findItems({ lines: ink, W, H, T, mpp, walls, doors, roomAt, roomAreas = [] }) {
  const m = mpp;
  const N = W * H;
  const px = (meters) => meters / m;

  // ---- The lines that can belong to furniture ----
  const wallBand = new Uint8Array(N);
  for (const s of walls) paintBand(wallBand, W, H, s, 1);
  const inRoom = new Uint8Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) inRoom[y * W + x] = roomAt(x, y) >= 0 ? 1 : 0;
  const lines = new Uint8Array(N);
  for (let i = 0; i < N; i++) lines[i] = ink[i] && !wallBand[i] && inRoom[i] ? 1 : 0;
  for (const d of doors) if (d.type === 'door' || d.type === 'double-door') clearSwing(lines, W, H, d);

  // Pieces of line: long ones draw outlines; short ones are the dashes and corners of a dashed
  // outline, or lettering, which once its gaps are filled still closes off nothing of a size.
  const { id, list } = components8(lines, W, H);
  const dashMax = px(0.3);
  const solid = new Uint8Array(N), dash = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!lines[i]) continue;
    const c = list[id[i]];
    if (Math.max(c.x1 - c.x0, c.y1 - c.y0) + 1 > dashMax) solid[i] = 1;
    else dash[i] = 1;
  }

  // ---- Closed shapes ----
  // Floor that solid outlines close off from the room around it, then what dashed outlines close
  // off once their gaps are filled.
  const block = new Uint8Array(N);
  for (let i = 0; i < N; i++) block[i] = solid[i] || wallBand[i] || !inRoom[i] ? 1 : 0;
  const minPx = MIN_AREA / (m * m);
  const sized = (list) => list.flatMap((p) => straightRuns(p, W, m) || [p])
    .map((p) => ({ ...describe(p, W, H, wallBand, m), part: !!p.part, basin: basinIn(p, solid, W, m) }))
    .filter((s) => s.L * m <= MAX_SIDE);
  const first = sized(enclosures(block, W, H, roomAt, minPx));
  // Dashed outlines: every line thickened to fill the gaps between dashes (long runs of dashes
  // that touch read as solid pieces); the shapes they close grow back by as much.
  const r = Math.max(1, Math.round(px(0.035)));
  const filled = dilate8(lines, W, H, r);
  for (let i = 0; i < N; i++) if (filled[i]) block[i] = 1;
  const inFirst = new Uint8Array(N);
  for (const s of first) for (const k of s.pixels) inFirst[k] = 1;
  const second = enclosures(block, W, H, roomAt, minPx * 0.6)
    .filter((s) => s.pixels.filter((k) => inFirst[k]).length < 0.3 * s.n)
    .map((s) => ({ ...s, dashed: true, grow: r }));
  const grown = sized(second);
  const shapes = [...first, ...grown];
  return { items: classify(shapes, m, W, H, wallBand, (r) => roomAreas[r] ?? Infinity), shapes, debug: { solid, dash, mark: block } };
}

// ---- What the shapes are -----------------------------------------------------------------------

/** A shape's box contains another's, give or take a line's width. */
const inside = (a, b, e = 2) => b.x0 >= a.x0 - e && b.y0 >= a.y0 - e && b.x1 <= a.x1 + e && b.y1 <= a.y1 + e;

/** The side of a that b lies against (within gap px, overlapping along it by half of the shorter), or null. */
function against(a, b, gap) {
  const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  const w = (s) => s.x1 - s.x0, h = (s) => s.y1 - s.y0;
  if (ox >= 0.5 * Math.min(w(a), w(b))) {
    if (Math.abs(b.y1 - a.y0) <= gap) return 'top';
    if (Math.abs(b.y0 - a.y1) <= gap) return 'bottom';
  }
  if (oy >= 0.5 * Math.min(h(a), h(b))) {
    if (Math.abs(b.x1 - a.x0) <= gap) return 'left';
    if (Math.abs(b.x0 - a.x1) <= gap) return 'right';
  }
  return null;
}

/** Rotation that turns an item's back (-y) to the given side. */
const BACK = { top: 0, right: 90, bottom: 180, left: 270 };
const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/**
 * Join shapes drawn as parts of one item end to end: the pad and headrest of an exam table, the
 * cushions of a sofa, the runs of a counter on either side of its sink. They lie side by side
 * along one axis with the same extent across it.
 */
function joinRuns(shapes, W, H, wallBand, m) {
  const gap = Math.max(3, Math.round(0.05 / m));
  const thin = (s) => s.S * m < 0.18;
  let list = shapes.slice();
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < list.length && !changed; i++) {
      for (let j = i + 1; j < list.length && !changed; j++) {
        const a = list[i], b = list[j];
        if (thin(a) || thin(b) || a.dashed !== b.dashed) continue;
        // The runs of a desk are cut short where a chair pulled up to it crosses its edge.
        const tol = Math.max(2, (a.part || b.part ? 0.5 : 0.08) * Math.max(a.S, b.S));
        const rowY = Math.abs(a.y0 - b.y0) <= tol && Math.abs(a.y1 - b.y1) <= tol && (Math.abs(b.x0 - a.x1) <= gap || Math.abs(a.x0 - b.x1) <= gap);
        const rowX = Math.abs(a.x0 - b.x0) <= tol && Math.abs(a.x1 - b.x1) <= tol && (Math.abs(b.y0 - a.y1) <= gap || Math.abs(a.y0 - b.y1) <= gap);
        if (!rowY && !rowX) continue;
        const box = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
        // End to end: the parts make the item longer, not deeper.
        if ((box.x1 - box.x0 >= box.y1 - box.y0) !== rowY) continue;
        const seat = (s) => s.seats ?? (s.L * m >= 0.35 && s.L * m <= 0.75 && s.L / Math.max(1, s.S) < 1.4);
        // A run of an L- or U-shaped desk stays one, with the end panel or return it meets.
        const part = !!(a.part || b.part);
        const merged = {
          ...box, n: a.n + b.n, room: a.room, dashed: a.dashed, part, basin: a.basin || b.basin,
          parts: part ? 1 : (a.parts || 1) + (b.parts || 1), seats: !part && seat(a) && seat(b),
          pixels: null, ...measure(box, W, H, wallBand, m),
        };
        if (merged.L * m > 2.6) continue;
        merged.fill = merged.n / ((box.x1 - box.x0 - 2) * (box.y1 - box.y0 - 2));
        list.splice(j, 1);
        list[i] = merged;
        changed = true;
      }
    }
  }
  return list;
}

/**
 * Name each shape that is an item, and set it against the wall it backs onto. Shapes inside
 * another (a basin in a counter, a cushion in a sofa) and thin strips (a chair's back and arms, a
 * grab bar) are details of the item around or beside them.
 */
function classify(found, m, W, H, wallBand, roomArea) {
  const M = (v) => v * m;
  const thin = (s) => M(s.S) < 0.18;
  // A space rather than a thing: a strip between walls on both its long sides, a gap spanning from
  // wall to wall with no wall along it (between two dimension lines, say), or a large patch that
  // fills little of its box. A counter run from wall to wall has a wall behind it.
  const space = (s) => {
    const wide = s.x1 - s.x0 >= s.y1 - s.y0;
    const [l0, l1, e0, e1] = wide ? ['top', 'bottom', 'left', 'right'] : ['left', 'right', 'top', 'bottom'];
    const w = (k) => s.wall[k] >= 0.5;
    return (w(l0) && w(l1)) || (w(e0) && w(e1) && !w(l0) && !w(l1)) || (s.fill < 0.55 && M(s.L) > 1.2);
  };
  const shapes = joinRuns(found, W, H, wallBand, m);
  // (A fixture drawn inside the dashed outline of the floor space it needs is no detail of that.)
  const top = shapes.filter((s) => !thin(s) && !space(s) && !shapes.some((o) => o !== s && o.n > s.n && !space(o) && (!o.dashed || s.dashed) && inside(o, s)));
  const gap = Math.max(3, Math.round(0.05 / m));
  const items = [];
  for (const s of top) {
    const L = M(s.L), S = M(s.S), A = s.L / Math.max(1, s.S);
    const wide = s.x1 - s.x0 >= s.y1 - s.y0;
    const longSides = wide ? ['top', 'bottom'] : ['left', 'right'];
    const shortSides = wide ? ['left', 'right'] : ['top', 'bottom'];
    const best = (sides, need) => sides.filter((k) => s.wall[k] >= need).sort((p, q) => s.wall[q] - s.wall[p])[0] || null;
    const nearWall = (sides, within) => sides.filter((k) => M(s.gap[k]) <= within).sort((p, q) => s.gap[p] - s.gap[q])[0] || null;
    // In a corner, the long side is the back.
    const alongWall = best(longSides, 0.5);
    const backed = alongWall || best(shortSides, 0.5);
    // A fixture stands off the wall by its tank or bowl: the end of its long axis nearest a wall.
    const endWall = nearWall(shortSides, 0.35);
    // A basin is drawn a little off the wall it hangs on.
    const close = backed || nearWall(longSides, 0.15) || nearWall(shortSides, 0.15);
    const kids = shapes.filter((o) => o !== s && o.n < s.n && inside(s, o));
    // A chair's back or a sofa's: a strip a few centimeters deep along most of one side.
    const hasBack = shapes.some((o) => thin(o) && M(o.S) >= 0.05 && o.L >= 0.6 * Math.min(s.L, s.S) && against(s, o, gap));
    const basin = s.basin || kids.some((o) => M(o.L) >= 0.18 && M(o.L) <= 0.65);
    const round = s.round && A < 1.35;
    const area = roomArea(s.room);
    const small = area <= 15;
    // Built-in things are drawn with solid lines; dashed ones are loose furniture, or in a
    // restroom-sized room the clear floor space a fixture needs.
    const fixed = !s.dashed;
    if (s.dashed && area <= 8) continue;
    let kind = null, back = backed;
    if (s.part) kind = S >= 0.4 && S <= 1.0 && L >= 0.6 ? 'desk' : null;
    else if (fixed && small && endWall && s.round && S >= 0.28 && S <= 0.55 && L >= 0.36 && L <= 0.8 && A >= 1.15) {
      kind = 'toilet';
      back = endWall;
    } else if (round) kind = S >= 0.6 ? 'table' : S >= 0.28 ? 'chair' : null;
    else if (s.seats && S >= 0.35 && S <= 1.0) kind = 'seating';
    else if (hasBack && S >= 0.3 && S <= 0.95 && L <= 1.1) kind = L >= 0.62 ? 'lounge' : 'chair';
    else if (fixed && ((S >= 0.55 && S <= 0.85 && A >= 1.4) || (basin && S >= 0.45)) && L >= 0.85 && alongWall) kind = 'counter';
    else if (fixed && S >= 0.28 && S <= 0.62 && L <= 0.8 && (basin || small) && (close || endWall)) {
      kind = 'sink';
      back = close || endWall;
    // A bed or exam table has its pad, headrest or rails drawn across it; a desk is one top.
    } else if (fixed && S >= 0.55 && S <= 1.1 && L >= 1.6 && L <= 2.4 && !alongWall && ((s.parts || 1) >= 2 || kids.length)) kind = 'bed';
    else if (fixed && S >= 0.3 && S < 0.55 && L >= 0.6 && alongWall) kind = 'storage';
    else if (fixed && S >= 0.55 && L <= 1.0 && A < 1.4 && backed && s.fill > 0.9) kind = 'appliance';
    // Loose seating drawn dashed: an armchair, or one wide enough for one and a half.
    else if (s.dashed && ((S >= 0.45 && S <= 0.8 && L >= 0.62 && L <= 1.1 && A < 2.2) || (S >= 0.55 && L <= 1.05 && A < 1.3))) kind = 'lounge';
    else if (S >= 0.45 && S <= 1.0 && L >= 0.9 && L <= 2.6) kind = (s.parts || 1) >= 2 && S <= 0.95 && !alongWall ? 'seating' : 'desk';
    else if (S >= 0.6 && L <= 4.5) kind = 'table';
    else if (S >= 0.28 && L <= 0.75) kind = L >= 0.62 ? 'lounge' : 'chair';
    if (!kind) continue;
    items.push({ kind, s, back, round, sink: kind === 'counter' && basin, close });
  }
  // Chairs face the desk or table they are pulled up to; else their back is the thin strip along
  // one side, else the wall behind them, else they face the desk or table nearest them.
  const work = items.filter((o) => ['desk', 'table', 'counter'].includes(o.kind));
  const nearest = (s, within, d) => {
    let near = null, nd = within / m;
    for (const o of work) {
      const v = d(o.s);
      if (v < nd) {
        nd = v;
        near = o;
      }
    }
    return near;
  };
  const facing = (s, o) => {
    const dx = (o.s.x0 + o.s.x1) / 2 - (s.x0 + s.x1) / 2, dy = (o.s.y0 + o.s.y1) / 2 - (s.y0 + s.y1) / 2;
    // The desk edge the chair is at: across its depth when the chair is in front of it.
    const inX = (s.x0 + s.x1) / 2 >= o.s.x0 && (s.x0 + s.x1) / 2 <= o.s.x1, inY = (s.y0 + s.y1) / 2 >= o.s.y0 && (s.y0 + s.y1) / 2 <= o.s.y1;
    const vertical = inX && !inY ? true : inY && !inX ? false : Math.abs(dy) > Math.abs(dx);
    return vertical ? (dy > 0 ? 'top' : 'bottom') : (dx > 0 ? 'left' : 'right');
  };
  for (const it of items) {
    if (it.kind !== 'chair' && it.kind !== 'lounge') continue;
    const seat = it.s;
    // The chair is its seat with the back and arms drawn around it.
    const strips = shapes.filter((o) => thin(o) && against(seat, o, gap));
    const s = it.s = strips.reduce((b, o) => ({ ...b, x0: Math.min(b.x0, o.x0), y0: Math.min(b.y0, o.y0), x1: Math.max(b.x1, o.x1), y1: Math.max(b.y1, o.y1) }), { ...seat });
    if (M(Math.max(s.x1 - s.x0, s.y1 - s.y0)) >= 0.7) it.kind = 'lounge';
    const at = nearest(s, 0.3, (b) => Math.hypot(Math.max(b.x0 - s.x1, 0, s.x0 - b.x1), Math.max(b.y0 - s.y1, 0, s.y0 - b.y1)));
    if (at) {
      it.back = facing(s, at);
      it.at = at;
      continue;
    }
    // The back is the longest strip; arms run along the sides.
    const strip = strips.sort((p, q) => q.L - p.L)[0];
    if (strip) {
      it.back = against(seat, strip, gap);
      continue;
    }
    if (it.back) continue;
    const cx = (s.x0 + s.x1) / 2, cy = (s.y0 + s.y1) / 2;
    const near = nearest(s, 0.9, (b) => Math.hypot(Math.max(b.x0 - cx, 0, cx - b.x1), Math.max(b.y0 - cy, 0, cy - b.y1)));
    it.back = near ? facing(s, near) : it.close;
  }
  // A counter with a chair pulled up to it is a desk, and a desk with two chairs or more along
  // each of two sides, or chairs on three, is a table.
  for (const it of items) if (it.kind === 'counter' && !it.sink && items.some((c) => c.at === it)) it.kind = 'desk';
  for (const it of items) {
    if (it.kind !== 'desk' || it.s.part) continue;
    const t = it.s, per = { top: 0, bottom: 0, left: 0, right: 0 };
    for (const c of items) {
      // Its own chairs: pulled up to it, or standing near it and pulled up to nothing else.
      if ((c.kind !== 'chair' && c.kind !== 'lounge') || (c.at && c.at !== it)) continue;
      const cx = (c.s.x0 + c.s.x1) / 2, cy = (c.s.y0 + c.s.y1) / 2;
      const dx = Math.max(t.x0 - cx, 0, cx - t.x1), dy = Math.max(t.y0 - cy, 0, cy - t.y1);
      if (Math.hypot(dx, dy) > 0.6 / m) continue;
      per[dx > dy ? (cx < t.x0 ? 'left' : 'right') : (cy < t.y0 ? 'top' : 'bottom')]++;
    }
    const sides = Object.values(per).filter((n) => n > 0);
    if (sides.filter((n) => n >= 2).length >= 2 || sides.length >= 3) it.kind = 'table';
    else if (!it.back && sides.length) {
      // A desk standing free faces the chair at it.
      const side = Object.keys(per).sort((p, q) => per[q] - per[p])[0];
      it.back = OPPOSITE[side];
    }
  }
  return items.map(({ kind, s, back, round, sink, at }) => {
    const bw = s.x1 - s.x0, bh = s.y1 - s.y0;
    const side = back || (bw >= bh ? 'top' : 'left');
    const across = side === 'top' || side === 'bottom';
    return {
      kind, x: (s.x0 + s.x1) / 2, y: (s.y0 + s.y1) / 2,
      w: across ? bw : bh, d: across ? bh : bw, rotation: BACK[side],
      sink, round, backed: !!back, at: at?.kind ?? null,
    };
  });
}

// ---- Shapes ----------------------------------------------------------------------------------

/**
 * The patches of free floor (4-connected, not blocked) that are not a room's floor: for each room,
 * its largest patch is its floor and every other patch of it at least minPx pixels is a shape.
 */
function enclosures(block, W, H, roomAt, minPx) {
  const N = W * H;
  const label = new Int32Array(N).fill(-1);
  const queue = new Int32Array(N);
  const comps = [];
  for (let k0 = 0; k0 < N; k0++) {
    if (block[k0] || label[k0] >= 0) continue;
    const idx = comps.length;
    let qh = 0, qt = 0;
    label[k0] = idx;
    queue[qt++] = k0;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    while (qh < qt) {
      const k = queue[qh++], x = k % W, y = (k - x) / W;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && !block[k - 1] && label[k - 1] < 0) { label[k - 1] = idx; queue[qt++] = k - 1; }
      if (x < W - 1 && !block[k + 1] && label[k + 1] < 0) { label[k + 1] = idx; queue[qt++] = k + 1; }
      if (y > 0 && !block[k - W] && label[k - W] < 0) { label[k - W] = idx; queue[qt++] = k - W; }
      if (y < H - 1 && !block[k + W] && label[k + W] < 0) { label[k + W] = idx; queue[qt++] = k + W; }
    }
    const room = roomAt(queue[0] % W, Math.floor(queue[0] / W));
    comps.push({ n: qt, x0, y0, x1, y1, room, pixels: qt >= minPx ? queue.slice(0, qt) : null });
  }
  const floor = new Map();
  comps.forEach((c, i) => {
    if (c.room >= 0 && (!floor.has(c.room) || c.n > comps[floor.get(c.room)].n)) floor.set(c.room, i);
  });
  const floors = new Set(floor.values());
  return comps.filter((c, i) => !floors.has(i) && c.room >= 0 && c.n >= minPx);
}

/**
 * An L-, U- or C-shaped patch (a reception desk, a workstation wrapped round its chairs) as the
 * straight runs it is made of: the largest rectangles in it, taken in turn. Null for a patch that
 * is about rectangular already, or that is no band a desk's depth wide (floor that furniture
 * closes off), or that rectangles do not cover.
 */
function straightRuns(p, W, m) {
  const bw = p.x1 - p.x0 + 1, bh = p.y1 - p.y0 + 1;
  if (p.n >= 0.8 * bw * bh || Math.max(bw, bh) * m > 8) return null;
  // The patch with the lines drawn inside it filled in.
  const mask = new Uint8Array(bw * bh);
  for (const k of p.pixels) mask[(Math.floor(k / W) - p.y0) * bw + (k % W) - p.x0] = 1;
  fillHoles(mask, bw, bh);
  if (maxInset(mask, bw, bh) * m > 0.55) return null;
  let left = 0;
  for (let i = 0; i < mask.length; i++) left += mask[i];
  const total = left, runs = [];
  while (runs.length < 6) {
    const r = largestRect(mask, bw, bh);
    if (!r || Math.min(r.w, r.h) * m < 0.3 || r.w * r.h * m * m < 0.15) break;
    if (Math.min(r.w, r.h) * m > 1.0) return null;
    runs.push(r);
    for (let y = r.y; y < r.y + r.h; y++) mask.fill(0, y * bw + r.x, y * bw + r.x + r.w);
    left -= r.w * r.h;
  }
  if (runs.length < 2 || left > 0.25 * total) return null;
  return runs.map((r) => {
    const x0 = p.x0 + r.x, y0 = p.y0 + r.y;
    const pixels = new Int32Array(r.w * r.h);
    for (let y = 0, i = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) pixels[i++] = (y0 + y) * W + x0 + x;
    return { x0, y0, x1: x0 + r.w - 1, y1: y0 + r.h - 1, n: r.w * r.h, room: p.room, dashed: p.dashed, grow: p.grow, part: true, pixels };
  });
}

/**
 * Whether a basin is drawn in a patch: lines inside it closing a fixture 22 to 75 cm across, or
 * dense enough in some 30 cm square for a bowl, its rim and faucet (the counter's own lines, a
 * dashed edge for the wall cabinets above, can run into it).
 */
function basinIn(p, solid, W, m) {
  const bw = p.x1 - p.x0 + 1, bh = p.y1 - p.y0 + 1;
  const sub = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) sub[y * bw + x] = solid[(p.y0 + y) * W + p.x0 + x];
  const closed = components8(sub, bw, bh).list.some((c) => {
    const w = (c.x1 - c.x0 + 1) * m, h = (c.y1 - c.y0 + 1) * m;
    return w >= 0.22 && h >= 0.22 && w <= 0.75 && h <= 0.75;
  });
  if (closed) return true;
  const k = Math.max(5, Math.round(0.3 / m));
  if (bw < k || bh < k) return false;
  const I = new Int32Array((bw + 1) * (bh + 1));
  for (let y = 0; y < bh; y++) {
    for (let x = 0, row = 0; x < bw; x++) {
      row += sub[y * bw + x];
      I[(y + 1) * (bw + 1) + x + 1] = I[y * (bw + 1) + x + 1] + row;
    }
  }
  for (let y = 0; y + k <= bh; y++) {
    for (let x = 0; x + k <= bw; x++) {
      const n = I[(y + k) * (bw + 1) + x + k] - I[y * (bw + 1) + x + k] - I[(y + k) * (bw + 1) + x] + I[y * (bw + 1) + x];
      if (n >= 0.3 * k * k) return true;
    }
  }
  return false;
}

/** Size, shape and the walls a shape backs onto. */
function describe(s, W, H, wallBand, m) {
  const bw = s.x1 - s.x0 + 1, bh = s.y1 - s.y0 + 1;
  // The outline around the patch is about a line thick (and the patch was shrunk by `grow` when
  // its lines were thickened).
  const e = 1 + (s.grow || 0);
  const box = { x0: s.x0 - e, y0: s.y0 - e, x1: s.x1 + 1 + e, y1: s.y1 + 1 + e };
  // A round outline leaves the corners of its box empty; a rectangle, even with rounded corners
  // or details inside, fills them.
  const cw = Math.max(1, Math.round(0.12 * bw)), ch = Math.max(1, Math.round(0.12 * bh));
  let corner = 0;
  for (const k of s.pixels) {
    const x = (k % W) - s.x0, y = Math.floor(k / W) - s.y0;
    if ((x < cw || x >= bw - cw) && (y < ch || y >= bh - ch)) corner++;
  }
  const round = corner < 0.25 * 4 * cw * ch;
  return { ...box, n: s.n, fill: s.n / (bw * bh), round, room: s.room, dashed: !!s.dashed, pixels: s.pixels, ...measure(box, W, H, wallBand, m) };
}

/**
 * A box's size and its walls: for each side, the share of it with a wall face within 6 cm
 * (contact) and the typical distance to the wall beyond it, up to 60 cm (gap, in px).
 */
function measure(b, W, H, wallBand, m) {
  const reach = Math.max(3, Math.round(0.06 / m)), far = Math.round(0.6 / m);
  const side = (k) => {
    const horiz = k === 'top' || k === 'bottom';
    const a0 = horiz ? b.x0 : b.y0, a1 = horiz ? b.x1 : b.y1;
    let hit = 0, n = 0;
    const dist = [];
    for (let a = a0; a <= a1; a++) {
      n++;
      let r = 0;
      for (; r <= far; r++) {
        const x = horiz ? a : k === 'left' ? b.x0 - r : b.x1 + r;
        const y = horiz ? (k === 'top' ? b.y0 - r : b.y1 + r) : a;
        if (x >= 0 && y >= 0 && x < W && y < H && wallBand[y * W + x]) break;
      }
      if (r <= reach) hit++;
      dist.push(r);
    }
    dist.sort((p, q) => p - q);
    return { contact: hit / n, gap: dist[dist.length >> 1] };
  };
  const sides = { top: side('top'), bottom: side('bottom'), left: side('left'), right: side('right') };
  const wall = {}, gap = {};
  for (const k in sides) {
    wall[k] = sides[k].contact;
    gap[k] = sides[k].gap;
  }
  return { L: Math.max(b.x1 - b.x0, b.y1 - b.y0), S: Math.min(b.x1 - b.x0, b.y1 - b.y0), wall, gap };
}

// ---- Masks -----------------------------------------------------------------------------------

/** Set a wall track's band, with `margin` px more all round. */
function paintBand(mask, W, H, s, margin) {
  const h = s.t / 2 + margin;
  const a0 = Math.max(0, Math.floor(s.c - h)), a1 = Math.min((s.axis === 'v' ? W : H) - 1, Math.ceil(s.c + h));
  const b0 = Math.max(0, Math.floor(s.s0 - h)), b1 = Math.min((s.axis === 'v' ? H : W) - 1, Math.ceil(s.s1 + h));
  for (let b = b0; b <= b1; b++) {
    for (let a = a0; a <= a1; a++) {
      if (s.axis === 'v') mask[b * W + a] = 1;
      else mask[a * W + b] = 1;
    }
  }
}

/** Clear a door's swing: the quarter disc its leaf sweeps (both leaves of a pair), and its arc. */
function clearSwing(mask, W, H, d) {
  const R = (d.leaf || (d.type === 'double-door' ? (d.g1 - d.g0) / 2 : d.g1 - d.g0)) + 3;
  const face = d.c + (d.side * d.t) / 2;
  const hinges = d.type === 'double-door' ? [[d.g0, 1], [d.g1, -1]] : [[d.hinge === 'end' ? d.g1 : d.g0, d.hinge === 'end' ? -1 : 1]];
  for (const [along, dir] of hinges) {
    for (let a = Math.floor(along - 3 * dir); dir > 0 ? a <= along + R : a >= along - R; a += dir) {
      for (let v = Math.floor(face - d.side * 2); d.side > 0 ? v <= face + R : v >= face - R; v += d.side) {
        if (Math.hypot(a - along, v - face) > R) continue;
        const x = d.axis === 'h' ? a : v, y = d.axis === 'h' ? v : a;
        if (x >= 0 && y >= 0 && x < W && y < H) mask[y * W + x] = 0;
      }
    }
  }
}

/** 8-connected components of a mask: a component id per pixel and each one's box and size. */
function components8(mask, W, H) {
  const N = W * H;
  const id = new Int32Array(N).fill(-1);
  const queue = new Int32Array(N);
  const list = [];
  for (let k0 = 0; k0 < N; k0++) {
    if (!mask[k0] || id[k0] >= 0) continue;
    const c = { x0: W, y0: H, x1: -1, y1: -1, n: 0 };
    const idx = list.length;
    list.push(c);
    let qh = 0, qt = 0;
    id[k0] = idx;
    queue[qt++] = k0;
    while (qh < qt) {
      const k = queue[qh++], x = k % W, y = (k - x) / W;
      c.n++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const j = yy * W + xx;
          if (mask[j] && id[j] < 0) {
            id[j] = idx;
            queue[qt++] = j;
          }
        }
      }
    }
  }
  return { id, list };
}

/** Set the holes of a mask: the clear pixels not joined to its border. */
function fillHoles(mask, w, h) {
  const out = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let qt = 0;
  const seed = (k) => {
    if (!mask[k] && !out[k]) {
      out[k] = 1;
      queue[qt++] = k;
    }
  };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  for (let qh = 0; qh < qt; qh++) {
    const k = queue[qh], x = k % w;
    if (x > 0) seed(k - 1);
    if (x < w - 1) seed(k + 1);
    if (k >= w) seed(k - w);
    if (k < (h - 1) * w) seed(k + w);
  }
  for (let i = 0; i < w * h; i++) if (!out[i]) mask[i] = 1;
}

/** How far into a mask its deepest pixel lies, in px (chessboard distance to the clear outside). */
function maxInset(mask, w, h) {
  const d = new Int32Array(w * h);
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) d[y * w + x] = 1 + Math.min(at(x - 1, y), at(x, y - 1), at(x - 1, y - 1), at(x + 1, y - 1));
    }
  }
  let best = 0;
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!mask[i]) continue;
      d[i] = Math.min(d[i], 1 + Math.min(at(x + 1, y), at(x, y + 1), at(x + 1, y + 1), at(x - 1, y + 1)));
      if (d[i] > best) best = d[i];
    }
  }
  return best;
}

/** The largest rectangle wholly inside a mask, {x, y, w, h}, or null. */
function largestRect(mask, w, h) {
  const run = new Int32Array(w);
  const stack = new Int32Array(w + 1);
  let best = null, area = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) run[x] = mask[y * w + x] ? run[x] + 1 : 0;
    // The largest rectangle under the histogram of runs ending on this row.
    let top = 0;
    for (let x = 0; x <= w; x++) {
      const v = x < w ? run[x] : 0;
      while (top > 0 && run[stack[top - 1]] >= v) {
        const height = run[stack[--top]];
        const x0 = top > 0 ? stack[top - 1] + 1 : 0;
        if (height * (x - x0) > area) {
          area = height * (x - x0);
          best = { x: x0, y: y - height + 1, w: x - x0, h: height };
        }
      }
      stack[top++] = x;
    }
  }
  return best;
}

/** Max filter with a (2r + 1)² square. */
function dilate8(mask, W, H, r) {
  const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let last = -Infinity;
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) last = x;
      if (x - last <= r) tmp[y * W + x] = 1;
    }
    last = Infinity;
    for (let x = W - 1; x >= 0; x--) {
      if (mask[y * W + x]) last = x;
      if (last - x <= r) tmp[y * W + x] = 1;
    }
  }
  for (let x = 0; x < W; x++) {
    let last = -Infinity;
    for (let y = 0; y < H; y++) {
      if (tmp[y * W + x]) last = y;
      if (y - last <= r) out[y * W + x] = 1;
    }
    last = Infinity;
    for (let y = H - 1; y >= 0; y--) {
      if (tmp[y * W + x]) last = y;
      if (last - y <= r) out[y * W + x] = 1;
    }
  }
  return out;
}
