// Tracing the floor plan image: reads the underlay's pixels, runs src/autotrace.js in a worker
// (on the page when the browser cannot start one) and adds what it finds to the plan. The app
// loads this module when it first traces.
import { traceFloorPlan, toPlanGeometry } from '../autotrace.js';
import { addWall, addOpening, addRoom, clampOpenings } from '../model.js';
import { rotate } from '../geometry.js';
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
 * Inside store.update: add a trace's walls, openings and rooms where the image lies on the plan
 * (draft.underlay's position, rotation and scale). Returns how many of each were added.
 */
export function addTrace(draft, { trace, factor }) {
  const U = draft.underlay;
  const origin = { x: U.x, y: U.y };
  const geo = toPlanGeometry(trace, { metersPerPixel: U.scale / factor, origin });
  const turn = (p) => (U.rotation ? rotate(p, U.rotation, origin) : p);
  const walls = geo.walls.map((w) => addWall(draft, turn(w.a), turn(w.b), { kind: w.kind, thickness: w.thickness }));
  const count = { walls: walls.length, doors: 0, windows: 0, rooms: geo.rooms.length };
  for (const o of geo.openings) {
    const wall = walls[o.wall];
    if (!wall) continue;
    addOpening(draft, wall.id, o.type, o.offset, { width: o.width, hinge: o.hinge, side: o.side });
    count[o.type === 'window' ? 'windows' : 'doors']++;
  }
  for (const r of geo.rooms) addRoom(draft, r.points.map(turn));
  clampOpenings(draft);
  return count;
}
