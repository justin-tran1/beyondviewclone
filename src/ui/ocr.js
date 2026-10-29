// Reading text off an image with OCR, for PDF pages that have none in them (a scan, or a CAD export
// that draws its text as lines): Tesseract in a worker (assets/vendor/tesseract, the "tesseract.js"
// import, with its English LSTM model), loaded with the first page that needs it. It reads sparse
// text, as a drawing's labels and notes are, in no particular order.
import { tsvWords } from '../pdf-scan.js';

const BASE = new URL('../../assets/vendor/tesseract/', import.meta.url).href;
// The smallest module with a SIMD instruction: the reader's build needs WebAssembly SIMD.
const SIMD_TEST = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
const STRIP = 256; // rows of the image turned gray at a time
const START_WAIT = 90000; // ms for the reader to start: its core and model are about 6 MB

/** Whether this browser can run the reader. */
export function canReadText() {
  try {
    return typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_TEST);
  } catch {
    return false;
  }
}

/** An image (a canvas drawn on white) as a gray PGM file, which the reader opens as it is. */
function grayImage(canvas) {
  const { width: W, height: H } = canvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const head = new TextEncoder().encode(`P5\n${W} ${H}\n255\n`);
  const out = new Uint8Array(head.length + W * H);
  out.set(head);
  for (let y = 0; y < H; y += STRIP) {
    const rows = Math.min(STRIP, H - y);
    const d = ctx.getImageData(0, y, W, rows).data;
    for (let i = 0, p = 0, o = head.length + y * W; i < W * rows; i++, p += 4) out[o + i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
  }
  return out;
}

/**
 * Start a reader. read(canvas, dpi, onProgress) resolves with the words on a canvas ([{ str, x0,
 * y0, x1, y1, conf }] in its px; dpi: the image's resolution; onProgress(fraction) while it reads),
 * one image at a time. close() stops the reader. Throws when it cannot start.
 */
export async function createReader() {
  if (!canReadText()) throw new Error('This browser cannot run the text reader: it needs WebAssembly SIMD.');
  const { default: Tesseract } = await import('tesseract.js');
  let progress = null, fail = null, timer = 0;
  // A job that fails rejects its own promise. One that fails while the reader starts (its model not
  // found) only calls errorHandler, and the start would never end: it fails with it instead.
  const failed = new Promise((_, reject) => { fail = reject; });
  failed.catch(() => {});
  const starting = Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
    workerPath: `${BASE}worker.min.js`,
    // The core finds its .wasm beside the worker script, so the worker loads from its own URL.
    corePath: `${BASE}tesseract-core-simd-lstm.js`,
    langPath: BASE,
    workerBlobURL: false,
    cacheMethod: 'none',
    logger: (m) => { if (m.status === 'recognizing text') progress?.(m.progress); },
    errorHandler: (err) => fail(new Error(`The text reader stopped: ${err}`)),
  });
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The text reader did not start in time.')), START_WAIT); });
  let worker;
  try {
    worker = await Promise.race([starting, failed, late]);
  } catch (err) {
    starting.then((w) => w.terminate(), () => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
  await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
  let queue = Promise.resolve();
  return {
    read(canvas, dpi, onProgress) {
      const job = queue.then(async () => {
        progress = onProgress;
        try {
          await worker.setParameters({ user_defined_dpi: String(Math.round(dpi)) });
          const { data } = await worker.recognize(grayImage(canvas), {}, { text: false, tsv: true });
          return tsvWords(data.tsv);
        } finally {
          progress = null;
        }
      });
      queue = job.catch(() => {});
      return job;
    },
    close: () => worker.terminate().catch(() => {}),
  };
}
