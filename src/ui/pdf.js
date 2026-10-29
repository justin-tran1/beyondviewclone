// Importing a floor plan from a PDF: a dialog shows the document's pages, suggests the one most like
// a floor plan and outlines the plan found on it (src/pdf-scan.js), which can be moved or resized.
// The chosen area becomes the plan's image, with the drawing scale its scale note gives: a drawing
// in vector form is rendered as large as the tracer reads, and one that is a picture on the page
// (a scan, a plan exported as an image) keeps that picture's own pixels, as re-rendering would
// only blur them. pdf.js (assets/vendor/pdfjs, the "pdfjs-dist" import) loads with the first PDF.
// A page with a drawing but no text in it (a scan, or a CAD export that draws its text as lines) is
// read with OCR (ui/ocr.js) for its scale note, titles and room labels, as is the page shown when
// its text has no scale note or no labels in the plan. The labels in the area imported go with its
// image (image.labels), to name the rooms traced from it (src/room-names.js).
import { h, iconEl } from './dom.js';
import { openDialog } from './widgets.js';
import { FileError, canvasDataURL } from './files.js';
import { findPlanArea, textLines, scaleNotes, chooseScaleNote, pageTitles, ocrLines, PLAN_TITLE_WEIGHT } from '../pdf-scan.js';
import { labelKind, splitNumber, cleanLabel } from '../room-names.js';
import { canReadText, createReader } from './ocr.js';

const SCAN_SIDE = 1600; // px: pages are scanned and previewed this large on their long side
const OUT_SIDE = 3200; // px: the imported area on its long side, as large as the tracer reads
const RASTER_SIDE = 4096; // px: a picture's own pixels, at most this many on the long side
const RASTER_COVER = 0.85; // a picture holds the drawing when it covers this much of the area
const MAX_PX_PER_PT = 8; // a small area renders at most this sharp (576 dpi)
const THUMB_W = 136; // px
const KEEP = 4; // scanned pages whose full render is kept for the preview
const MIN_SIZE = 0.04; // the smallest area, of the page's width or height
const PICTURE_WAIT = 20000; // ms to wait for pdf.js to decode a picture
const TEXT_MIN = 20; // characters: a page with fewer has no text of its own to read
const OCR_DPI = 200; // pages are read at about this resolution (text 3/32" high is 19 px tall)
const OCR_PIXELS = 40e6; // and at most this many pixels
const MAX_LABELS = 400; // labels kept with an image
const CAP = 0.7; // capitals' height, of the font size a page's text gives (OCR gives the capitals')
const TAG_DPI = 400; // room tags OCR found are read again this sharp, for their small numbers
const TAG_PIXELS = 40e6; // the area they are cut from, at most
const NUMBER_CHARS = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ-'; // a room number's (no I or O: they are 1 and 0)
const METERS_PER_PT = 0.0254 / 72;
// The imported image stays small enough for the browser to keep the plan with it (see storage.js).
const OUT_BYTES = 2.5 * 1024 * 1024;
const WHOLE = { x0: 0, y0: 0, x1: 1, y1: 1 };

let lib = null;

async function pdfjs() {
  if (!lib) {
    const mod = await import('pdfjs-dist');
    mod.GlobalWorkerOptions.workerSrc = new URL('../../assets/vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
    lib = mod;
  }
  return lib;
}

/** A PDF file as a pdf.js document. Throws a FileError that says why it cannot be read. */
export async function openPdf(file) {
  let pdf;
  try {
    pdf = await pdfjs();
  } catch (err) {
    console.error(err);
    throw new FileError('PDF import could not start in this browser. Export the page to PNG, then import the PNG.');
  }
  const data = new Uint8Array(await file.arrayBuffer());
  try {
    return await pdf.getDocument({ data, verbosity: pdf.VerbosityLevel.ERRORS, isEvalSupported: false }).promise;
  } catch (err) {
    if (err?.name === 'PasswordException') throw new FileError(`"${file.name}" is protected with a password. Save a copy without it, then import that.`);
    throw new FileError(`"${file.name}" could not be read as a PDF. It may be damaged; try exporting it again.`);
  }
}

/** Render `area` (fractions of the page) of a page at `scale` px per point onto white. */
async function renderPage(page, scale, area = WHOLE) {
  const full = page.getViewport({ scale });
  const x0 = Math.floor(area.x0 * full.width), y0 = Math.floor(area.y0 * full.height);
  const width = Math.max(1, Math.ceil(area.x1 * full.width) - x0), height = Math.max(1, Math.ceil(area.y1 * full.height) - y0);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale, offsetX: -x0, offsetY: -y0 }) }).promise;
  return canvas;
}

/**
 * Scan a page: its render at SCAN_SIDE, the plan found on it (area, fractions of the page, and
 * found: whether a drawing was), a rank for how much it looks like a floor plan, and the scale
 * note that holds for the plan ({ text, ratio, ocr? } or null). textless: the page has no text of
 * its own, so readPage can read it with OCR. The rest is what readPage needs.
 */
export async function scanPage(page) {
  const unit = page.getViewport({ scale: 1 });
  const scale = SCAN_SIDE / Math.max(unit.width, unit.height);
  const canvas = await renderPage(page, scale);
  const { width: W, height: H } = canvas;
  const plan = findPlanArea({ width: W, height: H, data: canvas.getContext('2d').getImageData(0, 0, W, H).data });
  const box = plan?.box ?? { x0: 0, y0: 0, x1: W, y1: H };
  const viewport = page.getViewport({ scale });
  const content = await page.getTextContent().catch(() => ({ items: [] }));
  const items = [], turned = [];
  let chars = 0;
  for (const t of content.items) {
    if (!t.str) continue;
    chars += t.str.replace(/\s+/g, '').length;
    const m = lib.Util.transform(viewport.transform, t.transform);
    const h = Math.hypot(m[2], m[3]);
    // Text across the page joins into lines; text turned on it (a rotated sheet's) stands alone.
    if (Math.abs(m[1]) > 0.2 * Math.abs(m[0]) || Math.abs(m[2]) > 0.2 * Math.abs(m[3])) turned.push({ text: t.str, x0: m[4], x1: m[4], y: m[5], h });
    else items.push({ str: t.str, x: m[4], y: m[5], w: (t.width || 0) * scale, h });
  }
  const lines = [...textLines(items), ...turned];
  const score = plan?.score ?? 0;
  const labeled = lines.some((l) => {
    const [x, y] = middle(l);
    return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 && labelKind(l.text);
  });
  return {
    canvas,
    area: { x0: box.x0 / W, y0: box.y0 / H, x1: box.x1 / W, y1: box.y1 / H },
    found: !!plan,
    rank: score * pageTitles(lines),
    note: chooseScaleNote(scaleNotes(lines), box, Math.max(W, H)),
    textless: chars < TEXT_MIN,
    // No room labels in the plan's own text: they may be drawn as lines.
    unlabeled: !labeled,
    scan: { scale, box, long: Math.max(W, H), score, lines },
  };
}

/** A line of text's middle (lines in a page's text stand on their baseline; OCR's on their box's foot). */
const middle = (l) => [(l.x0 + l.x1) / 2, l.y - (l.ocr ? 0.5 : 0.35) * l.h];

/**
 * Read a scanned page's text with OCR (reader: ui/ocr.js's createReader()) and take the scale note
 * and titles from it as well as from the page's own text: `s` (scanPage's result for the page) gets
 * its note and rank again, and ocr: true. onProgress(fraction) while it reads.
 */
export async function readPage(page, s, reader, onProgress) {
  const img = await ocrImage(page, s.scan.scale);
  let words;
  try {
    words = await reader.read(img.canvas, img.dpi, onProgress);
  } finally {
    img.canvas.width = img.canvas.height = 0;
  }
  const placed = words.map((w) => {
    const [ax, ay] = img.toScan(w.x0, w.y0), [bx, by] = img.toScan(w.x1, w.y1);
    return { str: w.str, x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
  });
  const { lines, box, long, score } = s.scan;
  s.scan.read = ocrLines(placed);
  const all = [...lines, ...s.scan.read];
  s.note = chooseScaleNote(scaleNotes(all), box, long);
  s.rank = score * pageTitles(all);
  s.ocr = true;
  return s;
}

/**
 * A page as OCR reads it, at about OCR_DPI: a scan's own pixels (enlarged when there are fewer), or
 * the page rendered. { canvas, dpi, toScan(x, y) -> [x, y] in the page's scan px }.
 */
async function ocrImage(page, scanScale) {
  const unit = page.getViewport({ scale: 1 });
  const want = Math.min(OCR_DPI / 72, Math.sqrt(OCR_PIXELS / (unit.width * unit.height)));
  let picture = null;
  try {
    picture = await pictureArea(page, WHOLE, { maxSide: Infinity, pxPerPt: want, maxPixels: OCR_PIXELS });
  } catch (err) {
    console.warn('The picture on this page could not be read, so the page is rendered to read its text.', err);
  }
  if (picture) {
    const scan = page.getViewport({ scale: scanScale });
    return { canvas: picture.canvas, dpi: picture.pxPerPt * 72, toScan: (x, y) => scan.convertToViewportPoint(...picture.toPdf(x, y)) };
  }
  const canvas = await renderPage(page, want);
  const k = scanScale / want;
  return { canvas, dpi: want * 72, toScan: (x, y) => [x * k, y * k] };
}

/**
 * A scanned page's paper made white: its grain and speckles go, so the image is smaller and reads
 * like a drawing. A page drawn on white is left as it is.
 */
function whitenPaper(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data, n = d.length / 4;
  const hist = new Uint32Array(256);
  for (let p = 0; p < d.length; p += 4) hist[(d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8]++;
  let paper = 255;
  for (let v = 0, c = 0; v < 256; v++) {
    c += hist[v];
    if (c >= 0.7 * n) {
      paper = v;
      break;
    }
  }
  if (paper >= 252) return;
  const t = paper - 22;
  for (let p = 0; p < d.length; p += 4) {
    if ((d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8 >= t) d[p] = d[p + 1] = d[p + 2] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * A small image of a few characters made easier to read (the reader cannot tell them from a
 * scan's gray, speckled paper on its own, as it does on a whole page): dark specks smaller than
 * `speck` px on their longer side erased, and when `tone`, the paper and its grain made white with
 * the ink kept in its grays.
 */
function cleanStrip(canvas, speck, tone) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const W = canvas.width, H = canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data, n = W * H;
  const lum = new Uint8Array(n), hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < n; i++, p += 4) hist[(lum[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8)]++;
  const level = (q) => {
    for (let v = 0, c = 0; v < 256; v++) if ((c += hist[v]) >= q * n) return v;
    return 255;
  };
  // The ink is the darkest 1%, the paper what most of the image is: its grain reaches down three
  // quarters of the way to the ink.
  const ink = level(0.01), paper = level(0.5);
  if (paper - ink < 24) return;
  const white = Math.max(120, ink + 0.75 * (paper - ink));
  const seen = new Uint8Array(n), stack = [], blob = [];
  for (let i0 = 0; i0 < n; i0++) {
    if (seen[i0] || lum[i0] >= white) continue;
    let x0 = W, x1 = -1, y0 = H, y1 = -1;
    blob.length = 0;
    stack.push(i0);
    seen[i0] = 1;
    while (stack.length) {
      const i = stack.pop(), x = i % W, y = (i - x) / W;
      blob.push(i);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && !seen[i - 1] && lum[i - 1] < white) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < W - 1 && !seen[i + 1] && lum[i + 1] < white) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && !seen[i - W] && lum[i - W] < white) { seen[i - W] = 1; stack.push(i - W); }
      if (y < H - 1 && !seen[i + W] && lum[i + W] < white) { seen[i + W] = 1; stack.push(i + W); }
    }
    if (Math.max(x1 - x0, y1 - y0) + 1 < speck) for (const i of blob) lum[i] = 255;
  }
  // Black stays black, the ink's grays are kept, the paper is white.
  const k = 255 / (white - 40);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = lum[i] >= 255 ? 255 : tone ? (lum[i] >= white ? 255 : Math.max(0, (lum[i] - 40) * k)) : lum[i];
    d[p] = d[p + 1] = d[p + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}

/** The pictures a page draws and where: [{ id | data, width, height, ctm }], ctm mapping their unit square to the page. */
async function pageImages(page) {
  const { OPS, Util } = lib;
  const ops = await page.getOperatorList();
  const out = [];
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = Util.transform(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (args[0]) ctm = Util.transform(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.paintImageXObject) out.push({ id: args[0], width: args[1], height: args[2], ctm });
    else if (fn === OPS.paintInlineImageXObject) out.push({ data: args[0], width: args[0].width, height: args[0].height, ctm });
  }
  return out;
}

/** A picture's pixels on a white canvas, or null when pdf.js does not hand them over. */
async function imageCanvas(page, im) {
  let img = im.data;
  if (!img) {
    const store = String(im.id).startsWith('g_') ? page.commonObjs : page.objs;
    img = await new Promise((resolve) => {
      // A picture that never arrives is rendered with the page instead.
      setTimeout(() => resolve(null), PICTURE_WAIT);
      try {
        store.get(im.id, resolve);
      } catch {
        resolve(null);
      }
    });
  }
  if (!img || !(img.width > 0 && img.height > 0)) return null;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, img.width, img.height);
  if (img.bitmap) {
    ctx.drawImage(img.bitmap, 0, 0);
    return canvas;
  }
  // Decoded pixels: 1 bit gray (set bits white), 8 bit RGB or RGBA (pdf.js's ImageKind 1, 2, 3).
  if (!img.data) return null;
  const out = ctx.createImageData(img.width, img.height);
  const d = out.data, src = img.data, n = img.width * img.height;
  if (img.kind === 3) d.set(src.subarray(0, n * 4));
  else if (img.kind === 2) for (let i = 0; i < n; i++) { d[i * 4] = src[i * 3]; d[i * 4 + 1] = src[i * 3 + 1]; d[i * 4 + 2] = src[i * 3 + 2]; d[i * 4 + 3] = 255; }
  else if (img.kind === 1) {
    const row = (img.width + 7) >> 3;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const v = (src[y * row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
        const k = (y * img.width + x) * 4;
        d[k] = d[k + 1] = d[k + 2] = v;
        d[k + 3] = 255;
      }
    }
  } else return null;
  ctx.putImageData(out, 0, 0);
  return canvas;
}

/**
 * The area as the picture that holds it, when one does (a scan, a plan exported as an image): its
 * own pixels, at most maxSide on the long side and maxPixels in all, enlarged to at least pxPerPt;
 * their size in px per point; and toPdf(x, y) and fromPdf(x, y), between them and the page's PDF
 * points. Only upright pictures on unrotated pages; null else.
 */
async function pictureArea(page, area, { maxSide = RASTER_SIDE, pxPerPt: least = 0, maxPixels = Infinity } = {}) {
  if (page.rotate % 360 !== 0) return null;
  const vp = page.getViewport({ scale: 1 });
  const [ax0, ay0] = vp.convertToPdfPoint(area.x0 * vp.width, area.y1 * vp.height);
  const [ax1, ay1] = vp.convertToPdfPoint(area.x1 * vp.width, area.y0 * vp.height);
  const A = { x0: Math.min(ax0, ax1), x1: Math.max(ax0, ax1), y0: Math.min(ay0, ay1), y1: Math.max(ay0, ay1) };
  const size = (A.x1 - A.x0) * (A.y1 - A.y0);
  let best = null;
  for (const im of await pageImages(page)) {
    const [a, b, c, d, e, f] = im.ctm;
    if (!(a > 0 && d > 0) || Math.abs(b) > 1e-6 * a || Math.abs(c) > 1e-6 * d) continue;
    const cover = Math.max(0, Math.min(e + a, A.x1) - Math.max(e, A.x0)) * Math.max(0, Math.min(f + d, A.y1) - Math.max(f, A.y0));
    if (cover >= RASTER_COVER * size && (!best || a * d > best.a * best.d)) best = { im, a, d, e, f };
  }
  if (!best) return null;
  const pic = await imageCanvas(page, best.im);
  if (!pic) return null;
  // The area in the picture's pixels: its first row is at the top of its unit square.
  const { a, d, e, f } = best, iw = pic.width, ih = pic.height;
  const i0 = Math.max(0, Math.floor(((A.x0 - e) / a) * iw)), i1 = Math.min(iw, Math.ceil(((A.x1 - e) / a) * iw));
  const j0 = Math.max(0, Math.floor((1 - (A.y1 - f) / d) * ih)), j1 = Math.min(ih, Math.ceil((1 - (A.y0 - f) / d) * ih));
  if (i1 - i0 < 16 || j1 - j0 < 16) return null;
  const own = iw / a; // the picture's px per point
  let k = Math.min(1, maxSide / Math.max(i1 - i0, j1 - j0));
  if (own * k < least) k = least / own;
  k = Math.min(k, Math.sqrt(maxPixels / ((i1 - i0) * (j1 - j0))));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round((i1 - i0) * k);
  canvas.height = Math.round((j1 - j0) * k);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(pic, i0, j0, i1 - i0, j1 - j0, 0, 0, canvas.width, canvas.height);
  return {
    canvas, pxPerPt: own * k,
    toPdf: (x, y) => [e + ((i0 + x / k) / iw) * a, f + (1 - (j0 + y / k) / ih) * d],
    fromPdf: (x, y) => [(((x - e) / a) * iw - i0) * k, ((1 - (y - f) / d) * ih - j0) * k],
  };
}

/**
 * The image of `area` of a page for the plan's underlay, with the meters per pixel its scale note
 * gives, and the labels among `lines` (the page's lines of text, in its scan px at `scale`) that
 * fall in it, in the image's px: { text, x, y, h, w? } at their middle, h their capitals' height.
 */
export async function renderArea(page, area, note, { lines = [], scale = 1 } = {}) {
  let picture = null;
  try {
    picture = await pictureArea(page, area);
  } catch (err) {
    console.warn('The picture on this page could not be read, so the page is rendered instead.', err);
  }
  let canvas, pxPerPt, toImage;
  if (picture) {
    ({ canvas, pxPerPt } = picture);
    const scan = page.getViewport({ scale });
    toImage = (x, y) => picture.fromPdf(...scan.convertToPdfPoint(x, y));
  } else {
    const unit = page.getViewport({ scale: 1 });
    const long = Math.max((area.x1 - area.x0) * unit.width, (area.y1 - area.y0) * unit.height);
    pxPerPt = Math.min(MAX_PX_PER_PT, OUT_SIDE / long);
    canvas = await renderPage(page, pxPerPt, area);
    // As renderPage places the area: its corner at the whole page's render's pixel.
    const full = page.getViewport({ scale: pxPerPt }), k = pxPerPt / scale;
    const ox = Math.floor(area.x0 * full.width), oy = Math.floor(area.y0 * full.height);
    toImage = (x, y) => [x * k - ox, y * k - oy];
  }
  whitenPaper(canvas);
  const src = await canvasDataURL(canvas, OUT_BYTES);
  const image = { src, width: canvas.width, height: canvas.height, resized: false };
  if (note?.ratio > 0) {
    image.scaleNote = { text: note.text, metersPerPixel: (note.ratio * METERS_PER_PT) / pxPerPt, ...(note.ocr ? { ocr: true } : {}) };
  }
  const k = pxPerPt / scale, round = (v) => Math.round(v * 10) / 10;
  const labels = [];
  for (const l of lines) {
    const text = l.text.trim();
    if (!labelKind(text)) continue;
    const [x, y] = toImage(...middle(l));
    if (!(x >= 0 && y >= 0 && x <= canvas.width && y <= canvas.height)) continue;
    const w = (l.x1 - l.x0) * k;
    labels.push({ text, x: round(x), y: round(y), h: round(l.h * k * (l.ocr ? 1 : CAP)), ...(w > 0 ? { w: round(w) } : {}) });
    if (labels.length >= MAX_LABELS) break;
  }
  if (labels.length) image.labels = labels;
  return image;
}

/**
 * Import a floor plan from a PDF: the dialog to choose the page and the area of it, then the image
 * of that area ({ src, width, height, resized, scaleNote?, labels? }), or null when cancelled.
 * onOpen is called once the dialog shows, and onChosen once it closes with an area, as it is
 * rendered.
 */
export async function importPdf(file, { onOpen, onChosen } = {}) {
  const doc = await openPdf(file);
  let reader = null;
  try {
    const choice = await chooseArea(doc, onOpen);
    if (!choice) return null;
    onChosen?.();
    const page = await doc.getPage(choice.page);
    const { lines, read = [], scale } = choice.scan;
    let tags = read;
    if (choice.reader) {
      try {
        reader = await choice.reader;
        tags = await rereadTags(page, choice.scan, choice.area, reader);
      } catch (err) {
        console.warn('The room tags could not be read again.', err);
      }
    }
    return await renderArea(page, choice.area, choice.note, { lines: [...lines, ...tags], scale });
  } finally {
    reader?.close();
    doc.destroy();
  }
}

/**
 * The lines OCR read on a page (scan.read), with the numbers of the room tags among them in `area`
 * read again: the page's reading at about OCR_DPI often gets a tag's small number wrong (a stroke
 * font's thin 1 dropped, a 3 read as 5), and reading the strip under the tag's name (or after it,
 * on its line) alone, at TAG_DPI, cleaned of specks and for the characters numbers have, mostly
 * does not. The strip is read twice (its paper made white, and as it is), and the two readings and
 * the first vote. Names read well the first time and are kept. The strips are cut from the area's
 * image: a scan's own pixels, enlarged for each, or the area rendered once (at most TAG_PIXELS).
 */
async function rereadTags(page, scan, area, reader) {
  const { scale, read = [] } = scan;
  const unit = page.getViewport({ scale: 1 });
  const W = unit.width * scale, H = unit.height * scale; // the scan's px
  const within = (l, b) => {
    const [x, y] = middle(l);
    return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
  };
  const whole = { x0: area.x0 * W, y0: area.y0 * H, x1: area.x1 * W, y1: area.y1 * H };
  // Names, not OCR's scraps of linework (ll, BFT): three letters or more.
  const names = read.filter((l) => within(l, whole) && labelKind(l.text) === 'name' && /[A-Z]{3}/i.test(l.text));
  if (!names.length) return read;
  // A name's height, not a line's that took in a symbol beside it.
  const heights = names.map((l) => l.h).sort((a, b) => a - b);
  const usual = heights[heights.length >> 1];
  // The area's image, and the map from the scan's px to its px and back.
  let source, toSource, fromSource, perPt;
  const picture = await pictureArea(page, area, { maxSide: Infinity, maxPixels: TAG_PIXELS }).catch(() => null);
  if (picture) {
    const view = page.getViewport({ scale });
    source = picture.canvas;
    perPt = picture.pxPerPt;
    toSource = (x, y) => picture.fromPdf(...view.convertToPdfPoint(x, y));
    fromSource = (x, y) => view.convertToViewportPoint(...picture.toPdf(x, y));
  } else {
    perPt = Math.min(TAG_DPI / 72, Math.sqrt(TAG_PIXELS / ((area.x1 - area.x0) * unit.width * (area.y1 - area.y0) * unit.height)));
    source = await renderPage(page, perPt, area);
    const full = page.getViewport({ scale: perPt }), k = perPt / scale;
    const ox = Math.floor(area.x0 * full.width), oy = Math.floor(area.y0 * full.height);
    toSource = (x, y) => [x * k - ox, y * k - oy];
    fromSource = (x, y) => [(x + ox) / k, (y + oy) / k];
  }
  const up = Math.max(1, TAG_DPI / 72 / perPt); // a scan's pixels enlarged to TAG_DPI
  // The readings of the numbers in a strip (scan px; h: its tag's capitals there), each a list of
  // lines at their place on the page: with the paper made white, and as it is (each reading
  // misses or cuts short some strips).
  const readingsOf = async (b, h) => {
    const [ax, ay] = toSource(b.x0, b.y0), [bx, by] = toSource(b.x1, b.y1);
    const sx = Math.max(0, Math.floor(Math.min(ax, bx))), sy = Math.max(0, Math.floor(Math.min(ay, by)));
    const sw = Math.min(source.width, Math.ceil(Math.max(ax, bx))) - sx, sh = Math.min(source.height, Math.ceil(Math.max(ay, by))) - sy;
    if (sw < 8 || sh < 8) return [];
    const readings = [];
    // A speck is less than a third of the capitals' height, in the strip's px.
    const speck = 0.35 * h * up * (perPt / scale);
    for (const tone of [true, false]) {
      const crop = document.createElement('canvas');
      crop.width = Math.round(sw * up);
      crop.height = Math.round(sh * up);
      const ctx = crop.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
      cleanStrip(crop, speck, tone);
      const words = await reader.read(crop, perPt * up * 72, null, { tessedit_char_whitelist: NUMBER_CHARS });
      const placed = words.map((w) => {
        const [x0, y0] = fromSource(sx + w.x0 / up, sy + w.y0 / up), [x1, y1] = fromSource(sx + w.x1 / up, sy + w.y1 / up);
        return { str: w.str, x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
      });
      const numbers = ocrLines(placed).filter((l) => labelKind(l.text) === 'number');
      if (numbers.length) readings.push(numbers);
    }
    return readings;
  };
  // A line's name without a number at its end (OFFICE 02), which is read again.
  const nameOf = (l) => {
    const { name, number } = splitNumber(l.text);
    return number ? { ...l, text: name, x1: l.x0 + ((l.x1 - l.x0) * name.length) / Math.max(1, l.text.trim().length) } : l;
  };
  let lines = read;
  try {
    for (const t of names) {
      const n = nameOf(t), h = Math.min(t.h, 1.5 * usual), cx = (n.x0 + n.x1) / 2;
      // Under the name, centered on it; else after it, on its line.
      const strips = [
        { x0: cx - 6 * h, x1: cx + 6 * h, y0: t.y + 0.2 * h, y1: t.y + 3.3 * h },
        { x0: n.x1 + 0.2 * h, x1: n.x1 + 6 * h, y0: t.y - 1.4 * h, y1: t.y + 0.4 * h },
      ];
      for (const b of strips) {
        const readings = await readingsOf(b, h);
        if (!readings.length) continue;
        // The readings again and the first one there vote: the most of them, else the longest.
        const old = (l) => within(l, b) && labelKind(l.text) === 'number';
        const first = lines.filter(old);
        const text = (r) => r.map((l) => cleanLabel(l.text)).join(' ');
        const votes = [...readings, ...(first.length ? [first] : [])];
        const count = (r) => votes.filter((v) => text(v) === text(r)).length;
        const best = votes.reduce((a, r) => (count(r) > count(a) || (count(r) === count(a) && text(r).length > text(a).length) ? r : a));
        if (best !== first) lines = [...lines.filter((l) => !old(l)).map((l) => (l === t ? n : l)), ...best];
        break;
      }
    }
  } finally {
    source.width = source.height = 0;
  }
  return lines;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** The dialog: resolves with { page, area, note, scan, read, reader? } (scan: scanPage's; read: by OCR) or null. */
function chooseArea(doc, onOpen) {
  const pages = doc.numPages;
  const scans = new Map(); // page number -> Promise of scanPage()
  const results = new Map(); // page number -> scanPage() result, once scanned
  const kept = []; // page numbers whose renders are kept, oldest first
  let current = 0;
  let area = WHOLE;
  let touched = false; // the user chose a page or changed the area: no more suggestions
  let best = { page: 1, rank: -1 };
  let scanned = false; // every page is scanned
  let closed = false;
  let dlg = null;

  // Keep a page's render, and let go of the oldest kept beyond KEEP but the page shown.
  const keep = (n) => {
    if (!kept.includes(n)) kept.push(n);
    while (kept.length > KEEP) {
      const i = kept.findIndex((k) => k !== current);
      if (i < 0) break;
      const [old] = kept.splice(i, 1);
      scans.get(old).then((o) => { o.canvas = null; });
    }
  };
  const scan = (n) => {
    if (!scans.has(n)) {
      scans.set(n, doc.getPage(n).then(async (page) => {
        const s = await scanPage(page);
        // Let pdf.js free what it decoded for the page; it decodes it again when needed.
        page.cleanup();
        return s;
      }).then((s) => {
        results.set(n, s);
        thumb(n, s);
        keep(n);
        rankPages();
        if (s.textless && s.found) startReader();
        readNext();
        return s;
      }));
    }
    return scans.get(n);
  };
  // A page's render, made again when it was let go.
  const pageCanvas = async (n) => {
    const s = await scan(n);
    if (!s.canvas) {
      const page = await doc.getPage(n);
      const unit = page.getViewport({ scale: 1 });
      s.canvas = await renderPage(page, SCAN_SIDE / Math.max(unit.width, unit.height));
      keep(n);
    }
    return s.canvas;
  };

  // ---- Page list ----
  const buttons = [];
  const list = pages > 1 ? h('div', { class: 'pdf-pages', attrs: { role: 'group', 'aria-label': 'Pages' } }) : null;
  for (let n = 1; n <= pages; n++) {
    const c = h('canvas', { class: 'pdf-thumb', width: THUMB_W, height: Math.round(THUMB_W * 0.66), attrs: { 'aria-hidden': 'true' } });
    const badge = h('span', { class: 'pdf-badge', text: 'Floor plan', hidden: true });
    const b = h('button', {
      type: 'button', class: 'pdf-page', attrs: { 'aria-pressed': 'false' },
      on: { click: () => { touched = true; waiting = 0; show(n); } },
    }, c, h('span', { class: 'pdf-page-label' }, h('span', { text: `Page ${n}` }), badge));
    b.canvas = c;
    b.badge = badge;
    buttons.push(b);
    list?.append(b);
  }
  function thumb(n, s) {
    const b = buttons[n - 1];
    if (!b || !s.canvas) return;
    const c = b.canvas;
    c.height = Math.round((THUMB_W * s.canvas.height) / s.canvas.width);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(s.canvas, 0, 0, c.width, c.height);
    if (s.found) {
      const a = s.area;
      ctx.strokeStyle = '#17a673';
      ctx.lineWidth = 2;
      ctx.strokeRect(a.x0 * c.width, a.y0 * c.height, (a.x1 - a.x0) * c.width, (a.y1 - a.y0) * c.height);
    }
  }
  // The page most like a floor plan so far gets the badge, and is shown until the user chooses.
  function rankPages() {
    best = { page: 1, rank: -1 };
    for (const [n, s] of results) if (s.rank > best.rank) best = { page: n, rank: s.rank };
    for (const [k, o] of buttons.entries()) o.badge.hidden = k !== best.page - 1 || best.rank <= 0;
    if (!touched && best.rank >= 0 && best.page !== current) show(best.page);
  }

  // ---- Reading pages' text with OCR, one at a time: the page shown first ----
  let reader = null; // Promise of the text reader, started with the first page to read
  let noReader = !canReadText(); // the reader cannot run here, or did not start
  let reading = 0; // the page being read
  let waiting = 0; // the page whose import waits for it to be read
  // Pages with a drawing but no text, and the page shown, once it is chosen or every page is
  // scanned, when its text gives no scale note or no room labels in the plan.
  const toRead = (n) => {
    const s = results.get(n);
    if (!s || s.ocr || s.unread || !s.found || noReader) return false;
    if (s.textless) return true;
    return (!s.note || s.unlabeled) && n === current && (scanned || touched);
  };
  // Once every page is scanned (or a page chosen), the page shown first, then the others in their
  // order as floor plans while one could still be the best with a floor plan's title.
  const nextToRead = () => {
    if (toRead(current) && (scanned || touched || waiting === current)) return current;
    if (!scanned) return 0;
    const could = [...results.keys()].filter((n) => toRead(n) && results.get(n).scan.score * PLAN_TITLE_WEIGHT > best.rank);
    return could.sort((a, b) => results.get(b).rank - results.get(a).rank)[0] || 0;
  };
  // The reader starts as soon as a page needs it, while the others are scanned.
  const startReader = () => {
    if (!reader && !noReader && !closed) {
      reader = createReader();
      reader.catch(() => {});
    }
    return reader;
  };
  // Resolves when the page being read is done (read or not), or the dialog closes.
  const ended = [];
  const readEnd = () => new Promise((r) => { ended.push(r); });
  async function readNext() {
    if (reading || closed) return;
    const n = nextToRead();
    // Nothing more to read for now (for tests: dataset.read).
    if (!n) {
      if (scanned) dlg.el.dataset.read = 'true';
      return;
    }
    delete dlg.el.dataset.read;
    const s = results.get(n);
    reading = n;
    s.progress = null;
    if (n === current) describe(s);
    try {
      let r;
      try {
        r = await startReader();
      } catch (err) {
        noReader = true;
        throw err;
      }
      s.progress = 0;
      const page = await doc.getPage(n);
      await readPage(page, s, r, (f) => {
        s.progress = f;
        if (n === current && !closed) describe(s);
      });
      page.cleanup();
    } catch (err) {
      if (!closed) console.warn(`The text on page ${n} could not be read.`, err);
      s.unread = true;
    }
    reading = 0;
    for (const r of ended.splice(0)) r();
    if (closed) return;
    rankPages();
    if (n === current) describe(s);
    readNext();
  }

  // ---- Preview with the area ----
  const canvasSlot = h('div', { class: 'pdf-canvas' });
  const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((edge) => h('span', { class: 'pdf-handle', dataset: { edge } }));
  const box = h('div', {
    class: 'pdf-area', tabIndex: 0,
    attrs: { role: 'group', 'aria-label': 'Area to import. Drag it, or its corners and edges. Arrow keys move it; with Shift they resize it.' },
  }, handles);
  const preview = h('div', { class: 'pdf-preview', hidden: true }, canvasSlot, box);
  const busy = h('div', { class: 'pdf-busy' }, h('span', { class: 'pdf-spinner', attrs: { 'aria-hidden': 'true' } }), h('span', { text: 'Finding the floor plan...' }));
  const status = h('p', { class: 'pdf-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const scaleText = h('p', { class: 'pdf-status' });
  const tool = (text, icon, fn) => h('button', { type: 'button', class: 'btn btn-secondary btn-sm', on: { click: fn } }, iconEl(icon), h('span', { class: 'btn-label', text }));
  const tools = h('div', { class: 'pdf-tools' },
    tool('Find the plan', 'wand', async () => {
      const s = await scan(current).catch(() => null);
      if (!s) return;
      touched = true;
      setArea(s.area);
    }),
    tool('Whole page', 'fit', () => { touched = true; setArea(WHOLE); }));
  const main = h('div', { class: 'pdf-main' }, preview, busy, status, scaleText, tools);
  const body = h('div', { class: `pdf-import${list ? '' : ' pdf-single'}` }, list, main);

  const draw = () => {
    Object.assign(box.style, {
      left: `${area.x0 * 100}%`, top: `${area.y0 * 100}%`, width: `${(area.x1 - area.x0) * 100}%`, height: `${(area.y1 - area.y0) * 100}%`,
    });
  };
  const setArea = (a) => {
    area = { x0: clamp01(a.x0), y0: clamp01(a.y0), x1: clamp01(a.x1), y1: clamp01(a.y1) };
    draw();
  };

  let showing = 0;
  let ready = false; // a page has shown, ready to import
  let pending = Promise.resolve(false); // the page showing: true once it shows, false if it cannot
  // Import stays enabled while another page loads, so it keeps focus: a click waits for the page.
  const show = (n) => (pending = showPage(n));
  // Whether the page last chosen showed, once it and any chosen while it loaded are done.
  const settled = async () => {
    for (;;) {
      const p = pending, ok = await p;
      if (p === pending) return ok;
    }
  };
  async function showPage(n) {
    const token = ++showing;
    current = n;
    for (const [k, b] of buttons.entries()) b.setAttribute('aria-pressed', String(k === n - 1));
    buttons[n - 1]?.scrollIntoView({ block: 'nearest' });
    preview.hidden = true;
    busy.hidden = false;
    status.textContent = '';
    scaleText.textContent = '';
    let s, canvas;
    try {
      s = await scan(n);
      canvas = await pageCanvas(n);
    } catch (err) {
      console.error(err);
      if (token !== showing || closed) return false;
      busy.hidden = true;
      importBtn.disabled = true;
      status.textContent = `Page ${n} could not be read.`;
      return false;
    }
    if (token !== showing || closed) return false;
    canvasSlot.replaceChildren(canvas);
    // Fit the page in about 60% of the window's height.
    preview.style.width = `min(100%, ${((60 * canvas.width) / canvas.height).toFixed(2)}vh)`;
    preview.hidden = false;
    busy.hidden = true;
    importBtn.disabled = false;
    // The first page to show takes focus to Import, unless the pages or the area have it.
    if (!ready && !body.contains(document.activeElement)) importBtn.focus({ preventScroll: true });
    ready = true;
    setArea(s.found ? s.area : WHOLE);
    describe(s);
    readNext();
    return true;
  }

  // What the page shown is and where its scale comes from, as its text is read.
  function describe(s) {
    if (s !== results.get(current) || preview.hidden) return;
    // Beside the page most like a floor plan, a page with far less drawing on it is likely another sheet.
    const other = pages > 1 && best.rank > 0 && s.rank < 0.3 * best.rank;
    status.textContent = !s.found
      ? 'No drawing was found on this page, so all of it is selected. Drag the outline to choose an area.'
      : other
        ? `This page does not look like a floor plan; page ${best.page} does. Its largest drawing is outlined, and you can drag the outline to choose an area.`
        : 'The floor plan found on this page is outlined. Drag the outline, or its corners and edges, to change what is imported.';
    const then = waiting === current ? ', then importing' : '';
    scaleText.textContent = reading === current
      ? s.progress === null
        ? `Starting the text reader to read this page's scale note and room names${then}...`
        : `Reading the text on this page for its scale note and room names (${Math.round(s.progress * 100)}%)${then}...`
      : toRead(current)
        ? `Waiting to read the text on this page for its scale note and room names${then}...`
        : s.note
          ? `Scale: ${s.note.text}, from the drawing's scale note${s.note.ocr ? ' (read by OCR)' : ''}. The door widths check it.`
          : s.unread
            ? 'The text on this page could not be read, so its scale is taken from the door widths.'
            : s.textless && s.found && !canReadText()
              ? 'This browser cannot read the text on a scanned page, so its scale is taken from the door widths.'
              : 'No scale note was found for this drawing, so its scale is taken from the door widths.';
  }

  // ---- Dragging the area ----
  let drag = null;
  preview.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const r = preview.getBoundingClientRect();
    const p = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    const edge = e.target.dataset?.edge || (box.contains(e.target) ? 'move' : 'new');
    drag = { edge, p, start: { ...area }, prev: { ...area }, r };
    if (edge === 'new') drag.start = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    preview.setPointerCapture(e.pointerId);
    touched = true;
    e.preventDefault();
  });
  preview.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const { r, start, p, edge } = drag;
    const q = { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
    const dx = q.x - p.x, dy = q.y - p.y;
    const a = { ...start };
    if (edge === 'move') {
      const w = start.x1 - start.x0, hgt = start.y1 - start.y0;
      a.x0 = Math.min(Math.max(0, start.x0 + dx), 1 - w);
      a.y0 = Math.min(Math.max(0, start.y0 + dy), 1 - hgt);
      a.x1 = a.x0 + w;
      a.y1 = a.y0 + hgt;
    } else if (edge === 'new') {
      Object.assign(a, { x0: Math.min(p.x, q.x), x1: Math.max(p.x, q.x), y0: Math.min(p.y, q.y), y1: Math.max(p.y, q.y) });
    } else {
      if (edge.includes('w')) a.x0 = Math.min(start.x0 + dx, start.x1 - MIN_SIZE);
      if (edge.includes('e')) a.x1 = Math.max(start.x1 + dx, start.x0 + MIN_SIZE);
      if (edge.includes('n')) a.y0 = Math.min(start.y0 + dy, start.y1 - MIN_SIZE);
      if (edge.includes('s')) a.y1 = Math.max(start.y1 + dy, start.y0 + MIN_SIZE);
    }
    setArea(a);
  });
  const end = () => {
    if (!drag) return;
    // A click without a drag outside the outline leaves the area as it was.
    if (drag.edge === 'new' && (area.x1 - area.x0 < MIN_SIZE || area.y1 - area.y0 < MIN_SIZE)) setArea(drag.prev);
    drag = null;
  };
  preview.addEventListener('pointerup', end);
  preview.addEventListener('pointercancel', end);
  box.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!step) return;
    e.preventDefault();
    touched = true;
    const [dx, dy] = step.map((v) => v * 0.01);
    if (e.shiftKey) {
      setArea({ ...area, x1: Math.max(area.x0 + MIN_SIZE, area.x1 + dx), y1: Math.max(area.y0 + MIN_SIZE, area.y1 + dy) });
    } else {
      const w = area.x1 - area.x0, hgt = area.y1 - area.y0;
      const x0 = Math.min(Math.max(0, area.x0 + dx), 1 - w), y0 = Math.min(Math.max(0, area.y0 + dy), 1 - hgt);
      setArea({ x0, y0, x1: x0 + w, y1: y0 + hgt });
    }
  });

  // ---- The dialog ----
  let result = null;
  const importBtn = h('button', {
    type: 'button', class: 'btn btn-primary', text: 'Import floor plan', disabled: true,
    on: {
      click: async () => {
        if (!(await settled()) || closed) return;
        const n = current, s = await scan(n);
        // The page's scale note may be in text still being read: wait for it, unless another page is
        // chosen. Choosing to import it ends the suggestions, so reading does not move to another page.
        if (reading === n || toRead(n)) {
          if (waiting === n) return;
          waiting = n;
          touched = true;
          describe(s);
          while (!closed && waiting === n && (reading === n || toRead(n))) {
            readNext();
            await readEnd();
          }
          if (closed || waiting !== n || current !== n) return;
          waiting = 0;
        }
        result = { page: n, area: { ...area }, note: s.note, scan: s.scan, read: !!s.ocr };
        dlg.close('import');
      },
    },
  });
  const cancel = h('button', { type: 'button', class: 'btn btn-secondary', text: 'Cancel', on: { click: () => dlg.close('cancel') } });
  return new Promise((resolve) => {
    dlg = openDialog({
      title: 'Import a floor plan from a PDF',
      subtitle: pages > 1
        ? `This PDF has ${pages} pages. Choose the one with the floor plan; the page most like one is chosen for you.`
        : 'The floor plan on the page is outlined, ready to import.',
      cls: 'dialog-wide dialog-pdf',
      body,
      actions: [cancel, importBtn],
      initialFocus: importBtn,
      onClose: () => {
        closed = true;
        // A page read by OCR is read again where its room tags are, with this reader.
        if (result?.read && reader) result.reader = reader;
        else reader?.then((r) => r.close(), () => {});
        for (const r of ended.splice(0)) r();
        resolve(result);
      },
    });
    onOpen?.();
    show(1);
    // Scan every page in turn, so the thumbnails fill in and the best one is suggested.
    (async () => {
      for (let n = 1; n <= pages && !closed; n++) await scan(n).catch(() => {});
      if (closed) return;
      scanned = true;
      dlg.el.dataset.scanned = 'true';
      const s = results.get(current);
      if (s) describe(s);
      readNext();
    })();
  });
}
