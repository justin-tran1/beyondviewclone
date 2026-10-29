// Reading the room labels drawn on a floor plan image (PNG, JPG, WebP or SVG: a PDF's come with its
// page, see ui/pdf.js) with OCR (ui/ocr.js), to name the rooms traced from it. The image is read
// enlarged so that its labels are large enough to read at the drawing's scale, twice (with the
// reader's own threshold for ink, and with one taken around each pixel, which finds small and gray
// text), to find its lines of text. What OCR reads in the linework (furniture, hatching, a door
// swing) is left out by its height against the words it read with confidence, and each line left
// is read again on its own, larger, three times: the reading nearest the others is taken, with the
// room words in it put right (src/room-names.js ocrLabel), when it holds a room word or a number or
// its readings agree. Under a name with no number, the strip where one would be is read for one.
// The app loads this module when it first reads an image.
import { createReader, cleanStrip } from './ocr.js';

export { canReadText } from './ocr.js';
import { ocrLines } from '../pdf-scan.js';
import { labelKind, splitNumber, ocrLabel, isDimension } from '../room-names.js';
import { loadUnderlayImage } from '../plan-render.js';

const LABEL_M = 0.15; // m: room labels' capitals are about this tall at the drawing's scale
const FIRST_CAP = 24; // px: the first reading enlarges them to this
const MAGNIFY_MIN = 0.25, MAGNIFY_MAX = 6; // the first reading's enlargement
const FIRST_PIXELS = 30e6; // and the most pixels it reads
const READS = [{ cap: 44, tone: true }, { cap: 56 }, { cap: 68 }]; // each line read again thus (px)
const NUMBER_CAP = 56; // px: the strip under a name is read for its number this large
const PASSES = [{}, { thresholding_method: '2' }]; // the first reading's: Otsu's threshold, Sauvola's
const NUMBER_CHARS = '#0123456789ABCDEFGHJKLMNPQRSTUVWXYZ-'; // a room number's (no I or O: they are 1 and 0)
const LINE_MAX = 10; // a line is enlarged at most this much
const MAX_LINES = 160;
const SURE = 85; // confidence of the words whose height and case the labels' are taken from
const DPI = 300; // the resolution the reader is told (the text is enlarged to a size it reads well)

/** The edit distance between two lines read. */
function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/**
 * The reading of a line to take, and how many of the readings bear it out (itself among them). Of
 * numbers, the one most of the others are part of (102 is borne out by 02: a thin 1 is what a
 * reading drops), the longer of two; else the one nearest the others, the more confident of two as
 * near, borne out by those the same as it.
 */
function pick(readings) {
  if (readings.every((r) => labelKind(r.text) === 'number')) {
    const support = (r) => readings.filter((o) => r.text.includes(o.text)).length;
    const best = readings.reduce((a, r) => (support(r) > support(a) || (support(r) === support(a) && r.text.length > a.text.length) ? r : a));
    return { best, support: support(best) };
  }
  const cost = (r) => readings.reduce((sum, o) => sum + distance(r.text, o.text), 0);
  const best = readings.reduce((a, r) => (cost(r) < cost(a) || (cost(r) === cost(a) && r.conf > a.conf) ? r : a));
  return { best, support: readings.filter((r) => r.text === best.text).length };
}

/**
 * Labels without the room numbers a reading cut short: a drawing writes its room numbers alike (101
 * to 109), so a number of fewer digits than most of them (05 for 105) is left out, a name keeping
 * its name. Numbers written with # (#4, #12) count their rooms and are left as they are.
 */
function shortNumbersOut(labels) {
  const digits = (t) => /(?:^|\s)(\d{2,4})[A-Z]?$/.exec(t)?.[1].length || 0;
  const counts = new Map();
  for (const l of labels) if (digits(l.text)) counts.set(digits(l.text), (counts.get(digits(l.text)) || 0) + 1);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const [most, n] = [...counts].reduce((a, b) => (b[1] > a[1] ? b : a), [0, 0]);
  if (total < 3 || n < 0.6 * total) return labels;
  return labels.flatMap((l) => {
    const d = digits(l.text);
    if (!d || d >= most) return [l];
    const name = l.text.replace(/\s*\S+$/, '');
    return name ? [{ ...l, text: name }] : [];
  });
}

/**
 * A canvas's gray made black or white at a level `q` of the way from its ink (its darkest pixels)
 * to its paper: small text enlarged reads better so than blurred.
 */
function binarize(canvas, q) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data, n = d.length / 4, hist = new Uint32Array(256);
  for (let p = 0; p < d.length; p += 4) hist[(d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8]++;
  const level = (f) => {
    for (let v = 0, c = 0; v < 256; v++) if ((c += hist[v]) >= f * n) return v;
    return 255;
  };
  const ink = level(0.005), paper = level(0.5), t = ink + q * (paper - ink);
  for (let p = 0; p < d.length; p += 4) d[p] = d[p + 1] = d[p + 2] = ((d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8) < t ? 0 : 255;
  ctx.putImageData(img, 0, 0);
}

/** Part of the image (its px) drawn k times as large on white. */
function drawPart(img, x, y, w, h, k) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, x, y, w, h, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * The bands of rows with text in a box of the image (its px), [{ y0, y1 }]: OCR's first reading draws
 * one box around a name and the number close under it, or around a line and a symbol drawn through
 * it (a turning circle). usual: the height of the labels' capitals.
 */
function textBands(img, bx0, by0, bx1, by1, usual) {
  const s = Math.max(1, Math.min(4, 12 / usual));
  const canvas = drawPart(img, bx0, by0, bx1 - bx0, by1 - by0, s);
  const { width: cw, height: ch } = canvas;
  const { data } = canvas.getContext('2d').getImageData(0, 0, cw, ch);
  canvas.width = canvas.height = 0;
  const rows = new Float64Array(ch);
  for (let y = 0, p = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++, p += 4) rows[y] += 255 - ((data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8);
  }
  const most = Math.max(...rows);
  const bands = [];
  for (let y = 0; y < ch; y++) {
    if (rows[y] < 0.25 * most) continue;
    const last = bands[bands.length - 1];
    // Rows of ink a hair apart are one line's.
    if (last && y - last.y1 <= Math.max(1, 0.12 * usual * s)) last.y1 = y + 1;
    else bands.push({ y0: y, y1: y + 1 });
  }
  return bands.filter((b) => b.y1 - b.y0 >= 0.45 * usual * s).map((b) => ({ y0: by0 + b.y0 / s, y1: by0 + b.y1 / s }));
}

/**
 * Read the room labels on a plan's underlay image. Resolves with them in the image's px ([{ text,
 * x, y, h, w }] at their middle, h the height of their capitals), [] when it reads none.
 * metersPerPixel: the drawing's scale, to enlarge its text enough to read; area: the part of the
 * image to read ({ x0, y0, x1, y1 } in its px: its rooms), else all of it; onProgress(fraction).
 * Throws when the reader cannot start.
 */
export async function readImageLabels(underlay, { metersPerPixel, area = null, onProgress } = {}) {
  const img = await loadUnderlayImage(underlay.src);
  const W = underlay.width, H = underlay.height;
  if (!img || !(W > 0 && H > 0)) throw new Error('The floor plan image could not be read.');
  const x0 = Math.max(0, Math.floor(area?.x0 ?? 0)), y0 = Math.max(0, Math.floor(area?.y0 ?? 0));
  const aw = Math.min(W, Math.ceil(area?.x1 ?? W)) - x0, ah = Math.min(H, Math.ceil(area?.y1 ?? H)) - y0;
  if (aw < 8 || ah < 8) return [];
  const want = metersPerPixel > 0 ? (FIRST_CAP * metersPerPixel) / LABEL_M : 1;
  const k = Math.max(MAGNIFY_MIN, Math.min(MAGNIFY_MAX, want, Math.sqrt(FIRST_PIXELS / (aw * ah))));
  const reader = await createReader();
  try {
    // ---- The first reading: where the lines of text are ----
    const page = drawPart(img, x0, y0, aw, ah, k);
    const words = [];
    try {
      for (let i = 0; i < PASSES.length; i++) {
        const read = await reader.read(page, DPI, (f) => onProgress?.((0.6 * (i + f)) / PASSES.length), PASSES[i]);
        for (const r of read) {
          const w = { str: r.str, conf: r.conf, x0: x0 + r.x0 / k, x1: x0 + r.x1 / k, y0: y0 + r.y0 / k, y1: y0 + r.y1 / k };
          // A word both readings found is kept as the more confident one read it.
          const overlap = (o) => Math.max(0, Math.min(o.x1, w.x1) - Math.max(o.x0, w.x0)) * Math.max(0, Math.min(o.y1, w.y1) - Math.max(o.y0, w.y0));
          const area = (o) => (o.x1 - o.x0) * (o.y1 - o.y0);
          const j = words.findIndex((o) => overlap(o) > 0.5 * Math.min(area(o), area(w)));
          if (j < 0) words.push(w);
          else if (w.conf > words[j].conf) words[j] = w;
        }
      }
    } finally {
      page.width = page.height = 0;
    }
    // The labels' height and case are those of the words read with confidence, on one line of text
    // (a box around two lines is about twice as tall as one).
    const sure = words.filter((w) => w.conf >= SURE && /[A-Za-z]{3}/.test(w.str) && !isDimension(w.str));
    const all = sure.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
    const heights = all.filter((h) => h <= 1.7 * all[all.length >> 2]);
    const usual = heights.length ? heights[heights.length >> 1] : null;
    const caps = sure.length > 0 && sure.filter((w) => !/[a-z]/.test(w.str)).length >= 0.8 * sure.length;
    // Words about as tall as those (a room number is often smaller than its name) or as tall as a
    // few lines; OCR's readings of linework are mostly of other heights.
    const fits = (w) => !usual || ((w.y1 - w.y0) > 0.55 * usual && ((w.y1 - w.y0) < 1.45 * usual || ((w.y1 - w.y0) < 4 * usual && /[A-Za-z0-9#]{3}/.test(w.str))));
    const kept = words.filter((w) => /[A-Za-z0-9#]/.test(w.str) && !isDimension(w.str) && fits(w));
    const found = ocrLines(kept).filter((l) => labelKind(l.text));
    // A line as tall as two (a name and the number under it) is read as the two; one with a symbol
    // drawn through it as its text alone.
    const lines = [];
    for (const l of found) {
      if (!usual || l.h < 1.45 * usual) lines.push(l);
      else for (const b of textBands(img, l.x0, l.y - l.h, l.x1, l.y, usual)) lines.push({ ...l, y: b.y1, h: b.y1 - b.y0 });
      if (lines.length >= MAX_LINES) break;
    }

    // ---- Each line read again ----
    // A box of the image (its px) read as one line, its capitals h px tall enlarged to `cap`: its
    // words in the image's px and the label they make.
    const readBox = async (bx0, by0, bx1, by1, h, { cap, tone, bw, chars }) => {
      const sx = Math.max(0, Math.floor(bx0)), sy = Math.max(0, Math.floor(by0));
      const sw = Math.min(W, Math.ceil(bx1)) - sx, sh = Math.min(H, Math.ceil(by1)) - sy;
      if (sw < 2 || sh < 2) return null;
      const m = Math.max(1, Math.min(LINE_MAX, cap / h));
      const crop = drawPart(img, sx, sy, sw, sh, m);
      if (tone) cleanStrip(crop, 0, true);
      if (bw) binarize(crop, bw);
      const params = { tessedit_pageseg_mode: '7', ...(chars ? { tessedit_char_whitelist: chars } : {}) };
      const ws = (await reader.read(crop, DPI, null, params)).map((w) => ({ ...w, x0: sx + w.x0 / m, x1: sx + w.x1 / m, y0: sy + w.y0 / m, y1: sy + w.y1 / m }));
      crop.width = crop.height = 0;
      if (!ws.length) return null;
      return { ...ocrLabel(ws.map((w) => w.str).join(' '), { caps }), conf: Math.min(...ws.map((w) => w.conf)), words: ws };
    };
    const labels = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i], lh = l.h;
      const h = usual ? Math.min(lh, 1.45 * usual) : lh;
      const box = [l.x0 - 2.5 * h, l.y - lh - 0.45 * h, l.x1 + 2.5 * h, l.y + 0.45 * h];
      const readings = [];
      for (const how of READS) {
        const r = await readBox(...box, h, how);
        if (r?.text && labelKind(r.text)) readings.push(r);
      }
      onProgress?.(0.6 + (0.4 * (i + 1)) / lines.length);
      if (!readings.length) continue;
      const { best, support } = pick(readings);
      const agree = support > 1;
      const number = labelKind(best.text) === 'number' || !!splitNumber(best.text).number;
      const named = best.known === 'long' || (best.known === 'short' && best.conf >= 50);
      if (!named && !(number && (agree || best.conf >= 60)) && !(agree && best.conf >= 70)) continue;
      const x = (l.x0 + l.x1) / 2, y = l.y - lh / 2;
      // A line read twice (two of OCR's lines over one label) is one label.
      if (labels.some((o) => o.text === best.text && Math.hypot(o.x - x, o.y - y) < 1.5 * h)) continue;
      labels.push({ text: best.text, x, y, h, w: l.x1 - l.x0 });
    }

    // ---- Room numbers under names, which the first reading missed (small, or gray) ----
    const isNumber = (t) => labelKind(t) === 'number';
    for (const n of labels.slice()) {
      if (labelKind(n.text) !== 'name' || splitNumber(n.text).number) continue;
      const h = n.h, half = Math.max(n.w / 2, 3 * h);
      const strip = { x0: n.x - half, x1: n.x + half, y0: n.y + 0.65 * h, y1: n.y + 2.9 * h };
      const inStrip = (x, y) => x > strip.x0 && x < strip.x1 && y > strip.y0 && y < strip.y1;
      // A number found under it already, or other text read there (a dimension, a name): none to find.
      if (labels.some((m) => m !== n && inStrip(m.x, m.y))) continue;
      if (words.some((w) => w.y0 > strip.y0 - 0.2 * h && inStrip((w.x0 + w.x1) / 2, (w.y0 + w.y1) / 2) && (isDimension(w.str) || /[A-Za-z]{3}/.test(w.str)))) continue;
      const reads = [];
      for (const how of [{ tone: true }, { bw: 0.4 }, { bw: 0.5 }]) {
        const r = await readBox(strip.x0, strip.y0, strip.x1, strip.y1, 0.8 * h, { cap: NUMBER_CAP, chars: NUMBER_CHARS, ...how });
        // One short word: a dimension line reads as a long one, or several.
        if (r?.words.length === 1 && isNumber(r.text) && r.words[0].x1 - r.words[0].x0 < Math.max(0.7 * n.w, 4.5 * h)) reads.push(r);
      }
      if (!reads.length) continue;
      // Taken when another reading bears it out, or it is sure.
      const { best, support } = pick(reads);
      if (support < 2 && best.conf < 85) continue;
      const w = best.words[0];
      labels.push({ text: best.text, x: (w.x0 + w.x1) / 2, y: (w.y0 + w.y1) / 2, h: w.y1 - w.y0, w: w.x1 - w.x0 });
    }
    // Two readings of one label (OCR's first reading drew two boxes over it): the one that holds the
    // other is kept.
    const over = (a, b) => Math.abs(a.y - b.y) < 0.6 * Math.max(a.h, b.h) && Math.abs(a.x - b.x) < (a.w + b.w) / 2;
    const whole = labels.filter((a) => !labels.some((b) => b !== a && over(a, b) && b.text.length > a.text.length && b.text.includes(a.text)));
    const round = (v) => Math.round(v * 10) / 10;
    return shortNumbersOut(whole).map((l) => ({ text: l.text, x: round(l.x), y: round(l.y), h: round(l.h), w: round(l.w) }));
  } finally {
    reader.close();
  }
}
