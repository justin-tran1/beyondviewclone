// Reading plan files and floor plan images, and writing plans and images out.
import { normalizePlan, serializePlan } from '../model.js';
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

export async function readPlanFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new FileError(`"${file.name}" is not a plan file. Choose a .cbreplan.json file saved from this tool.`);
  }
  const looksLikePlan = data && typeof data === 'object' && !Array.isArray(data)
    && ['walls', 'rooms', 'items', 'underlay', 'version'].some((k) => k in data);
  if (!looksLikePlan) throw new FileError(`"${file.name}" does not contain a floor plan.`);
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
 * Read an image file for use as an underlay. Raster images larger than 4096 px on their long
 * side are downscaled. Returns { src, width, height, resized }.
 */
export async function readImageFile(file) {
  const kind = fileKind(file);
  if (kind === 'pdf') throw new FileError('PDFs cannot be traced directly. Export the page to PNG first, then import the PNG.');
  if (kind !== 'image') throw new FileError(`"${file.name}" is not a supported image. Use PNG, JPG, WebP or SVG.`);
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
  if (isSvg) {
    const text = await file.text();
    const src = `data:image/svg+xml;base64,${base64Utf8(text)}`;
    const img = await loadImage(src);
    const size = img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : svgSize(text);
    if (!size) throw new FileError('This SVG has no size. Add width and height or a viewBox, or export it as PNG.');
    return { src, ...size, resized: false };
  }
  const original = await readAsDataURL(file);
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

/** A new underlay at the origin, guessing that the image spans about 30 m until it is calibrated. */
export function underlayFor(image) {
  return {
    src: image.src,
    width: image.width,
    height: image.height,
    x: 0,
    y: 0,
    scale: ASSUMED_SPAN / Math.max(image.width, image.height),
    rotation: 0,
    opacity: 0.6,
    visible: true,
    locked: true,
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
  const blob = await canvasBlob(canvas, 'image/png');
  if (!blob) throw new FileError('Could not create the plan image.');
  return blob;
}

export function imageFileName(plan, suffix) {
  return `${safeFileName(plan.name)} ${suffix}.png`;
}
