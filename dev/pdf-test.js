// Developer view of the PDF import's page scan (src/pdf-scan.js through src/ui/pdf.js): choose a
// PDF and every page is shown with the floor plan area found on it, its rank as a floor plan and
// the scale note that holds for the plan. The results are logged as `pdf-test {...}`.
import { openPdf, scanPage } from '../src/ui/pdf.js';

const input = document.getElementById('file');
const state = document.getElementById('state');
const pages = document.getElementById('pages');

input.addEventListener('change', async () => {
  const file = input.files[0];
  if (!file) return;
  pages.replaceChildren();
  state.textContent = 'Reading...';
  const t0 = performance.now();
  const results = [];
  try {
    const doc = await openPdf(file);
    for (let n = 1; n <= doc.numPages; n++) {
      const t = performance.now();
      const s = await scanPage(await doc.getPage(n));
      const ms = Math.round(performance.now() - t);
      const a = s.area;
      results.push({ page: n, found: s.found, rank: +s.rank.toFixed(2), area: Object.fromEntries(Object.entries(a).map(([k, v]) => [k, +v.toFixed(3)])), note: s.note, ms, size: [s.canvas.width, s.canvas.height] });
      const box = document.createElement('div');
      box.className = 'area';
      Object.assign(box.style, { left: `${a.x0 * 100}%`, top: `${a.y0 * 100}%`, width: `${(a.x1 - a.x0) * 100}%`, height: `${(a.y1 - a.y0) * 100}%` });
      const frame = document.createElement('div');
      frame.className = 'frame';
      frame.append(s.canvas, box);
      const fig = document.createElement('figure');
      const cap = document.createElement('figcaption');
      cap.textContent = `Page ${n}: rank ${s.rank.toFixed(2)}${s.found ? '' : ' (no drawing)'}, ${ms} ms\nscale ${s.note ? `${s.note.text} (1:${Math.round(s.note.ratio)})` : 'none'}`;
      fig.append(frame, cap);
      pages.append(fig);
    }
    doc.destroy();
    state.textContent = `${results.length} pages in ${Math.round(performance.now() - t0)} ms`;
  } catch (err) {
    state.textContent = err.message;
    results.push({ error: err.message });
  }
  console.log('pdf-test', JSON.stringify(results));
  window.pdfTest = results;
});
