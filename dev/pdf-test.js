// Developer view of the PDF import's page scan (src/pdf-scan.js through src/ui/pdf.js): choose a
// PDF and every page is shown with the floor plan area found on it, its rank as a floor plan and
// the scale note that holds for the plan. With "Read text with OCR", pages the import would read
// (a drawing with no text, or text with no scale note) are read too, and their rank before reading
// is shown beside the rank after. The results are logged as `pdf-test {...}`.
import { openPdf, scanPage, readPage } from '../src/ui/pdf.js';
import { canReadText, createReader } from '../src/ui/ocr.js';

const input = document.getElementById('file');
const ocr = document.getElementById('ocr');
const state = document.getElementById('state');
const pages = document.getElementById('pages');

input.addEventListener('change', async () => {
  const file = input.files[0];
  if (!file) return;
  pages.replaceChildren();
  state.textContent = 'Reading...';
  const t0 = performance.now();
  const results = [];
  let reader = null;
  try {
    const doc = await openPdf(file);
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const t = performance.now();
      const s = await scanPage(page);
      const ms = Math.round(performance.now() - t);
      const scanRank = s.rank;
      let ocrMs = null;
      if (ocr.checked && canReadText() && s.found && !s.note) {
        state.textContent = `Reading the text on page ${n}...`;
        const t1 = performance.now();
        reader ||= await createReader();
        await readPage(page, s, reader, (f) => { state.textContent = `Reading the text on page ${n} (${Math.round(f * 100)}%)...`; });
        ocrMs = Math.round(performance.now() - t1);
      }
      const a = s.area;
      results.push({
        page: n, found: s.found, textless: s.textless, rank: +s.rank.toFixed(2), scanRank: +scanRank.toFixed(2), note: s.note,
        area: Object.fromEntries(Object.entries(a).map(([k, v]) => [k, +v.toFixed(3)])), ms, ocrMs, size: [s.canvas.width, s.canvas.height],
      });
      const box = document.createElement('div');
      box.className = 'area';
      Object.assign(box.style, { left: `${a.x0 * 100}%`, top: `${a.y0 * 100}%`, width: `${(a.x1 - a.x0) * 100}%`, height: `${(a.y1 - a.y0) * 100}%` });
      const frame = document.createElement('div');
      frame.className = 'frame';
      frame.append(s.canvas, box);
      const fig = document.createElement('figure');
      const cap = document.createElement('figcaption');
      const read = ocrMs === null ? '' : `, read by OCR in ${ocrMs} ms (rank ${scanRank.toFixed(2)} before)`;
      cap.textContent = `Page ${n}: rank ${s.rank.toFixed(2)}${s.found ? '' : ' (no drawing)'}${s.textless ? ', no text' : ''}, ${ms} ms${read}\nscale ${s.note ? `${s.note.text} (1:${Math.round(s.note.ratio)})${s.note.ocr ? ' by OCR' : ''}` : 'none'}`;
      fig.append(frame, cap);
      pages.append(fig);
    }
    doc.destroy();
    state.textContent = `${results.length} pages in ${Math.round(performance.now() - t0)} ms`;
  } catch (err) {
    state.textContent = err.message;
    results.push({ error: err.message });
  } finally {
    reader?.close();
  }
  console.log('pdf-test', JSON.stringify(results));
  window.pdfTest = results;
});
