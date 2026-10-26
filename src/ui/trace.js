// Tracing the floor plan image: reads the underlay's pixels, runs src/autotrace.js in a worker
// (on the page when the browser cannot start one) and adds what it finds to the plan, the
// furniture as catalog items. The app loads this module when it first traces.
import { traceFloorPlan, toPlanGeometry } from '../autotrace.js';
import { addWall, addOpening, addRoom, addItem, clampOpenings } from '../model.js';
import { rotate, clamp, normDeg, deg2rad } from '../geometry.js';
import { getItem, hasItem } from '../catalog/registry.js';
import { loadUnderlayImage } from '../plan-render.js';

const TRACE_SIDE = 3200; // px: larger images are traced at this size on their long side
const SVG_SIDE = 2400; // px: drawings in SVG are drawn this large to be traced

/** The underlay image as RGBA pixels on white, with `factor` traced pixels per image pixel. */
async function underlayPixels(u) {
  const img = await loadUnderlayImage(u.src);
  if (!img || !(u.width > 0 && u.height > 0)) throw new Error('The floor plan image could not be read.');
  const long = Math.max(u.width, u.height);
  const k = u.src.startsWith('data:image/svg') ? SVG_SIDE / long : Math.min(1, TRACE_SIDE / long);
  const width = Math.max(1, Math.round(u.width * k)), height = Math.max(1, Math.round(u.height * k));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);
  return { width, height, data: ctx.getImageData(0, 0, width, height).data, factor: width / u.width };
}

/** Trace pixels on the page, after a moment for it to show that it is working. */
const traceHere = (pixels, onProgress) => new Promise((resolve) => setTimeout(resolve, 60))
  .then(() => traceFloorPlan(pixels, { onProgress }));

/** Trace pixels in a worker, or on the page if no worker starts. */
function runTrace(pixels, onProgress) {
  let worker;
  try {
    worker = new Worker(new URL('../autotrace-worker.js', import.meta.url), { type: 'module' });
  } catch {
    return traceHere(pixels, onProgress);
  }
  return new Promise((resolve, reject) => {
    let heard = false;
    worker.onmessage = (e) => {
      heard = true;
      const m = e.data;
      if (m.progress !== undefined) {
        onProgress?.(m.progress, m.phase);
        return;
      }
      worker.terminate();
      if (m.error) reject(new Error(m.error));
      else resolve(m.trace);
    };
    worker.onerror = (e) => {
      e.preventDefault();
      worker.terminate();
      if (heard) reject(new Error(e.message || 'The tracer stopped.'));
      else traceHere(pixels, onProgress).then(resolve, reject);
    };
    // Copied, not transferred, so the page still has the pixels if the worker cannot start.
    worker.postMessage({ width: pixels.width, height: pixels.height, data: pixels.data });
  });
}

/**
 * Trace the walls, doors, windows and rooms in a floor plan image (a plan underlay). Resolves with
 * { trace, factor, metersPerPixel }: factor is traced pixels per image pixel, and metersPerPixel
 * the scale the drawing gives its image pixels, from its doors or walls (null when it gives none).
 */
export async function traceUnderlay(underlay, { onProgress } = {}) {
  const pixels = await underlayPixels(underlay);
  const trace = await runTrace(pixels, onProgress);
  const mpp = trace.scale.metersPerPixel;
  return { trace, factor: pixels.factor, metersPerPixel: mpp ? mpp * pixels.factor : null };
}

/**
 * The catalog item a piece of traced furniture becomes. stretch: how far a model made at one size
 * may be scaled to the drawn footprint, as a share of its size (resizable items take the drawn
 * size as it is); min: the least size an item takes; anchor: the edge kept where it was drawn when
 * the size changes ('back' for an item with its back to a wall, 'front' for a toilet, whose bowl
 * is drawn and tank not); repeat: a long run of storage is several units side by side.
 */
function itemFor(f) {
  switch (f.kind) {
    case 'desk': return { type: 'desk' };
    case 'counter': return { type: f.sink ? 'exam-casework' : 'casework' };
    case 'sink': return { type: 'vanity', min: { w: 0.5, d: 0.45 } };
    case 'toilet': return { type: 'toilet', stretch: 0, anchor: 'front' };
    case 'table': return { type: f.round ? 'round-table' : 'table' };
    case 'chair': return { type: f.at === 'desk' || f.at === 'counter' ? 'task-chair' : 'side-chair', stretch: 0.25 };
    case 'lounge': return { type: 'lounge-chair', stretch: 0.35 };
    case 'seating': return { type: 'sofa', stretch: 0.45 };
    case 'bed': return { type: 'exam-table', stretch: 0.3 };
    case 'storage': return { type: f.d >= 0.45 ? 'filing-cabinet' : 'bookshelf', stretch: 0.3, repeat: true };
    case 'appliance': return { type: 'lab-refrigerator', stretch: 0.3 };
    default: return null;
  }
}

/**
 * Add one piece of traced furniture (in plan meters, before the image's rotation) as catalog
 * items. Returns how many were added.
 */
function addFurniture(draft, f, turn, turnBy) {
  const spec = itemFor(f);
  if (!spec || !hasItem(spec.type)) return 0;
  const def = getItem(spec.type);
  const fit = (drawn, size, min = 0.3) => (spec.stretch === undefined
    ? Math.max(drawn, min)
    : clamp(drawn, size * (1 - spec.stretch), size * (1 + spec.stretch)));
  const n = spec.repeat ? Math.max(1, Math.round(f.w / def.w)) : 1;
  const w = fit(f.w / n, def.w, spec.min?.w), d = fit(f.d, def.d, spec.min?.d);
  // The front faces +y turned by the rotation; the drawn edge it keeps moves the center.
  const r = deg2rad(f.rotation), front = { x: -Math.sin(r), y: Math.cos(r) }, across = { x: Math.cos(r), y: Math.sin(r) };
  const anchor = spec.anchor || (f.backed ? 'back' : null);
  const shift = anchor === 'back' ? (d - f.d) / 2 : anchor === 'front' ? (f.d - d) / 2 : 0;
  for (let i = 0; i < n; i++) {
    const along = (i - (n - 1) / 2) * (f.w / n);
    const at = turn({ x: f.x + front.x * shift + across.x * along, y: f.y + front.y * shift + across.y * along });
    // Items made at one size keep it unless the drawing differs from it.
    const size = spec.stretch === undefined || Math.abs(w - def.w) > 0.005 || Math.abs(d - def.d) > 0.005 ? { w, d } : {};
    addItem(draft, spec.type, at.x, at.y, { rotation: normDeg(f.rotation + turnBy), ...size, traced: true });
  }
  return n;
}

/**
 * Inside store.update: add a trace's walls, openings, rooms and furniture where the image lies on
 * the plan (draft.underlay's position, rotation and scale). Returns how many of each were added.
 */
export function addTrace(draft, { trace, factor }) {
  const U = draft.underlay;
  const origin = { x: U.x, y: U.y };
  const geo = toPlanGeometry(trace, { metersPerPixel: U.scale / factor, origin });
  const turn = (p) => (U.rotation ? rotate(p, U.rotation, origin) : p);
  const walls = geo.walls.map((w) => addWall(draft, turn(w.a), turn(w.b), { kind: w.kind, thickness: w.thickness }));
  const count = { walls: walls.length, doors: 0, windows: 0, rooms: geo.rooms.length, items: 0 };
  for (const o of geo.openings) {
    const wall = walls[o.wall];
    if (!wall) continue;
    addOpening(draft, wall.id, o.type, o.offset, { width: o.width, hinge: o.hinge, side: o.side });
    count[o.type === 'window' ? 'windows' : 'doors']++;
  }
  for (const r of geo.rooms) addRoom(draft, r.points.map(turn));
  for (const f of geo.items) count.items += addFurniture(draft, f, turn, U.rotation || 0);
  clampOpenings(draft);
  return count;
}
