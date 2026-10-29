// Reading plan files and floor plan images, and writing plans and images out.
import { normalizePlan, serializePlan, PLAN_FORMAT } from '../model.js';
import { renderPlan, fitView, planBounds, loadUnderlayImage } from '../plan-render.js';
import { downloadBlob, safeFileName } from './dom.js';

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml,.png,.jpg,.jpeg,.webp,.svg,.pdf,application/pdf';
export const PLAN_ACCEPT = '.json,application/json';
const MAX_SIDE = 4096;
const MAX_PNG_BYTES = 6 * 1024 * 1024;
const ASSUMED_SPAN = 30;

export class FileError extends Error {}

export function fileKind(file) {
  const name = (file.name || '').toLowerCase();
  const type = file.type || '';
  if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (type === 'application/json' || name.endsWith('.json')) return 'plan';
  if (/^image\/(png|jpeg|webp|svg\+xml)$/.test(type) || /\.(png|jpe?g|webp|svg)$/.test(name)) return 'image';
  return 'other';
}

// ---- Plans -------------------------------------------------------------------------------------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPoint = (p) => !!p && isNum(p.x) && isNum(p.y);
const ENTITY_TESTS = {
  walls: (w) => isPoint(w?.a) && isPoint(w?.b),
  rooms: (r) => Array.isArray(r?.points) && r.points.length >= 3 && r.points.every(isPoint),
  items: (i) => typeof i?.type === 'string' && isPoint(i),
};

/**
 * True for a plan saved by this tool: it carries the format marker, or (files saved before the
 * marker existed) has walls, rooms or items shaped like plan entities, or a traced image.
 */
function isPlanData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (data.format === PLAN_FORMAT) return true;
  const entities = Object.entries(ENTITY_TESTS).some(([key, test]) => Array.isArray(data[key]) && data[key].some(test));
  return entities || (typeof data.underlay?.src === 'string' && data.underlay.src.startsWith('data:image/'));
}

export async function readPlanFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new FileError(`"${file.name}" is not a plan file. Choose a .cbreplan.json file saved from this tool.`);
  }
  if (!isPlanData(data)) throw new FileError(`"${file.name}" does not contain a floor plan. Choose a .cbreplan.json file saved from this tool.`);
  try {
    return normalizePlan(data);
  } catch {
    throw new FileError(`"${file.name}" could not be opened. The file may be damaged.`);
  }
}

export function savePlanFile(plan) {
  const blob = new Blob([serializePlan(plan)], { type: 'application/json' });
  const name = `${safeFileName(plan.name)}.cbreplan.json`;
  downloadBlob(blob, name);
  return name;
}

// ---- Floor plan images -----------------------------------------------------------------------

const readAsDataURL = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new FileError('This image could not be read. Try saving it again as a PNG or JPG.'));
    img.src = src;
  });
}

/** Natural size of an SVG from its width and height or viewBox, when the browser reports none. */
function svgSize(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  const num = (v) => (v && !/%$/.test(v) ? parseFloat(v) : NaN);
  let w = num(root.getAttribute('width')), hgt = num(root.getAttribute('height'));
  const vb = (root.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  if (!(w > 0 && hgt > 0) && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    w = vb[2];
    hgt = vb[3];
  }
  return w > 0 && hgt > 0 ? { width: w, height: hgt } : null;
}

/** Rough line drawing test: mostly near white pixels with few distinct colors. */
function looksLikeDrawing(img) {
  const s = 96;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, s, s);
  ctx.drawImage(img, 0, 0, s, s);
  const data = ctx.getImageData(0, 0, s, s).data;
  const colors = new Set();
  let light = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r > 225 && g > 225 && b > 225) light++;
    colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
  }
  return light / (s * s) > 0.6 && colors.size < 600;
}

function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const canvasBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * A canvas (drawn on white) as an image data URL: PNG, which keeps line drawings crisp, or JPEG
 * when the PNG is larger than `budget` bytes, at a lower quality while that is still too large.
 */
export async function canvasDataURL(canvas, budget = MAX_PNG_BYTES) {
  let blob = await canvasBlob(canvas, 'image/png');
  for (const q of [0.9, 0.8, 0.7]) {
    if (blob && blob.size <= budget) break;
    blob = await canvasBlob(canvas, 'image/jpeg', q);
  }
  if (!blob) throw new FileError('This page is too large to import. Choose a smaller area of it.');
  return readAsDataURL(blob);
}

/** Some drag and drop sources report no type, which yields data:application/octet-stream; plans keep only image data URLs. */
function withImageType(src, name) {
  if (src.startsWith('data:image/')) return src;
  const ext = (/\.(png|jpe?g|webp)$/i.exec(name)?.[1] || 'png').toLowerCase();
  return src.replace(/^data:[^;,]*/, `data:image/${ext === 'jpg' ? 'jpeg' : ext}`);
}

/**
 * Read an image file for use as an underlay. Raster images larger than 4096 px on their long
 * side are downscaled. Returns { src, width, height, resized }. PDFs import through ui/pdf.js.
 */
export async function readImageFile(file) {
  const kind = fileKind(file);
  if (kind !== 'image') throw new FileError(`"${file.name}" is not a supported image. Use PNG, JPG, WebP, SVG or PDF.`);
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
  if (isSvg) {
    const text = await file.text();
    const src = `data:image/svg+xml;base64,${base64Utf8(text)}`;
    const img = await loadImage(src);
    const size = img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : svgSize(text);
    if (!size) throw new FileError('This SVG has no size. Add width and height or a viewBox, or export it as PNG.');
    return { src, ...size, resized: false };
  }
  const original = withImageType(await readAsDataURL(file), file.name);
  const img = await loadImage(original);
  const { naturalWidth: w, naturalHeight: hgt } = img;
  if (!(w > 0 && hgt > 0)) throw new FileError('This image is empty.');
  const long = Math.max(w, hgt);
  if (long <= MAX_SIDE) return { src: original, width: w, height: hgt, resized: false };

  const k = MAX_SIDE / long;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(hgt * k);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  const photo = file.type === 'image/jpeg' || !looksLikeDrawing(img);
  let blob = null;
  if (!photo) {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    blob = await canvasBlob(canvas, 'image/png');
    if (blob && blob.size > MAX_PNG_BYTES) blob = null;
  }
  if (!blob) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    blob = await canvasBlob(canvas, 'image/jpeg', 0.9);
  }
  if (!blob) throw new FileError('This image is too large to process. Try a smaller export.');
  return { src: await readAsDataURL(blob), width: canvas.width, height: canvas.height, resized: true };
}

/**
 * A new underlay at the origin, at the scale its scale note gives (a PDF page's), else guessing that
 * the image spans about 30 m until it is calibrated. A PDF page's labels go with it, to name the
 * rooms traced from it.
 */
export function underlayFor(image) {
  const note = image.scaleNote;
  return {
    src: image.src,
    width: image.width,
    height: image.height,
    x: 0,
    y: 0,
    scale: note ? note.metersPerPixel : ASSUMED_SPAN / Math.max(image.width, image.height),
    rotation: 0,
    opacity: 0.6,
    visible: true,
    locked: true,
    ...(note ? { scaleNote: { text: note.text, metersPerPixel: note.metersPerPixel, ...(note.ocr ? { ocr: true } : {}) } } : {}),
    ...(image.labels?.length ? { labels: image.labels } : {}),
  };
}

// ---- Plan image export ------------------------------------------------------------------------

/** Clean PNG of the whole plan (no selection or grid), about 2400 px on the long side. */
export async function renderPlanImage(plan, { showDimensions = false, showLabels = true } = {}) {
  const b = planBounds(plan);
  const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY);
  const long = 2400;
  const width = bw >= bh ? long : Math.max(900, Math.round(long * (bw / bh)));
  const height = bw >= bh ? Math.max(700, Math.round(long * (bh / bw))) : long;
  const cssW = width / 2, cssH = height / 2;
  if (plan.underlay?.visible && plan.underlay.src) await loadUnderlayImage(plan.underlay.src);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  const view = fitView(b, cssW, cssH, 48);
  renderPlan(ctx, { ...plan, cameras: [] }, view, { showGrid: false, showUnderlay: true, showDimensions, showLabels, background: '#FFFFFF' });
  const blob = await canvasBlob(canvas, 'image/png').catch(() => null);
  if (!blob) throw new FileError('The plan image could not be created. Try hiding the floor plan image, then save again.');
  return blob;
}

export function imageFileName(plan, suffix) {
  return `${safeFileName(plan.name)} ${suffix}.png`;
}
