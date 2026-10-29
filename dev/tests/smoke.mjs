// End-to-end smoke test: opens each sample through the welcome dialog and captures Plan, Split and
// Walk, then does the same for a floor plan image imported and traced into a new plan ('import'),
// and for the floor plan sheet of a PDF drawing set ('pdf', see pdf-sheets.mjs), after importing
// the sheet printed to fit, the set scanned and the sheet with its text drawn as lines (the last
// two read with OCR). Each PDF's rooms must be named and finished from its labels.
// Usage: node dev/tests/smoke.mjs <baseUrl> <outDir> [sampleId | import | pdf ...]
// Software rendering takes seconds to a minute per Realistic frame, so each 3D capture waits for the
// walkthrough to stop drawing and for the GPU to finish, not for a fixed time. Exits 1 on any error.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeTestPdfs } from './pdf-sheets.mjs';

const [base = 'http://localhost:8080/', out = 'smoke-out', ...only] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
// How long the 3D view may take to finish drawing after a mode switch (software rendering under load).
const DRAW_TIMEOUT = 300000;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const samples = only.length ? only : ['lab-suite', 'medical-office', 'office-floor', 'retail-warehouse', 'trace-demo', 'import', 'pdf'];
// The trace demo's drawing (24 px per foot) and what tracing it finds: 15 walls, 8 doors, 12 windows,
// 8 rooms and 28 pieces of furniture, among them these. The test allows for a few misses.
const DRAWING = fileURLToPath(new URL('../../assets/samples/trace-demo.svg', import.meta.url));
const TRACED = { walls: 12, doors: 6, windows: 10, rooms: 6, items: 22, scale: 0.3048 / 24 };
const FURNISHED = ['desk', 'table', 'round-table', 'task-chair', 'side-chair', 'exam-casework', 'toilet', 'vanity'];
// Finish packages the traced rooms take from their furniture, and ones the samples' rooms are in.
const MATCHED = ['office', 'restroom'];
const SAMPLE_FINISHES = { 'medical-office': ['exam', 'corridor', 'restroom', 'procedure', 'imaging'], 'lab-suite': ['wet-lab', 'tissue-culture', 'lab-support', 'lobby'] };
// The PDF set's floor plan sheet is the trace demo at 1/4" = 1'-0": its building is 60 by 40 ft on
// wall centerlines, which the scale note gives exactly and the doors to a few percent.
const PDF_SPAN = [60 * 0.3048, 40 * 0.3048];
// The rooms its labels name (CONFERENCE over 101 and so on), with the finishes their names give.
const PDF_ROOMS = { 'Conference 101': 'conference', 'Office 102': 'office', 'Office 103': 'office', 'Office 104': 'office', 'Reception 105': 'waiting', 'Restroom 108': 'restroom' };
// Rooms named, not matching PDF_ROOMS: a page's text names them all, OCR may miss a number.
const roomErrors = (name, got, misses) => {
  const wrong = Object.entries(PDF_ROOMS).filter(([room, use]) => got.names[room] !== use);
  return wrong.length > misses ? [`pdf: the ${name}'s rooms were not named and finished from its labels: missing ${wrong.map(([r, u]) => `${r} (${u})`).join(', ')} in ${JSON.stringify(got.names)}`] : [];
};
let pdfs = null;
const packages = (page) => page.evaluate(async () => {
  const { packageOf } = await import(new URL('src/finishes.js', document.baseURI).href);
  return window.cbre.store.plan.rooms.map((r) => packageOf(r)).filter(Boolean);
});

/**
 * Wait until the walkthrough has nothing left to draw (no frame pending or running and nothing
 * marked dirty) for three animation frames in a row, then until the GPU has finished those frames.
 * A view that never stops drawing fails here, with its state, instead of passing on a timer.
 */
async function settle(page, frame0) {
  await page.evaluate(() => { window.__smokeIdle = 0; });
  try {
    await page.waitForFunction(() => {
      const w = window.cbre.walk;
      const idle = w._built && !w._raf && !w._inFrame && !w._dirty;
      window.__smokeIdle = idle ? window.__smokeIdle + 1 : 0;
      return window.__smokeIdle >= 3;
    }, null, { polling: 'raf', timeout: DRAW_TIMEOUT });
  } catch (err) {
    const state = await page.evaluate(() => {
      const w = window.cbre.walk;
      return { built: !!w._built, raf: !!w._raf, inFrame: w._inFrame, dirty: w._dirty, canRender: w._canRender(), mode: w.mode, quality: w.quality };
    });
    throw new Error(`the 3D view did not finish drawing: ${JSON.stringify(state)} (${err.message.split('\n')[0]})`);
  }
  return page.evaluate((f0) => {
    const w = window.cbre.walk, gl = w.renderer.getContext();
    const t0 = performance.now();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    return { renders: w.renderer.info.render.frame - f0, gpuMs: Math.round(performance.now() - t0) };
  }, frame0);
}

/** Import the trace demo's drawing from the empty plan, and check what tracing it found. */
async function importDrawing(page) {
  await page.waitForSelector('dialog[open]');
  await page.keyboard.press('Escape');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#empty-import')]);
  await chooser.setFiles(DRAWING);
  await page.waitForFunction(() => window.cbre.store.plan.underlay?.traced, null, { timeout: 60000 });
  const found = await page.evaluate(() => {
    const p = window.cbre.store.plan;
    const windows = p.openings.filter((o) => o.type === 'window').length;
    return {
      walls: p.walls.length, doors: p.openings.length - windows, windows, rooms: p.rooms.length, items: p.items.length,
      types: [...new Set(p.items.map((i) => i.type))], scale: p.underlay.scale,
    };
  });
  for (const key of ['walls', 'doors', 'windows', 'rooms', 'items']) {
    if (found[key] < TRACED[key]) errors.push(`import: traced ${found[key]} ${key}, expected at least ${TRACED[key]}`);
  }
  const missing = FURNISHED.filter((t) => !found.types.includes(t));
  if (missing.length) errors.push(`import: no ${missing.join(', ')} among the furniture found (${found.types.join(', ')})`);
  if (Math.abs(found.scale / TRACED.scale - 1) > 0.03) errors.push(`import: traced scale ${found.scale} m/px, expected ${TRACED.scale}`);
  const matched = await packages(page);
  const unmatched = MATCHED.filter((k) => !matched.includes(k));
  if (unmatched.length) errors.push(`import: no room took the ${unmatched.join(', ')} finishes from its furniture (${matched.join(', ') || 'none'})`);
  console.log(`import finishes: ${matched.join(', ')}`);
}

/**
 * Import one of the test PDFs from the empty plan through the PDF dialog, once its pages are all
 * scanned. Returns the page the dialog chose, the traced plan's counts and span (m) and the toasts.
 */
async function importPdfFile(page, file) {
  await page.waitForSelector('dialog[open]');
  await page.keyboard.press('Escape');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#empty-import')]);
  await chooser.setFiles(file);
  // Every page scanned, and read with OCR where it has no text: the page chosen is settled.
  await page.waitForSelector('.dialog-pdf[data-scanned][data-read]', { timeout: 240000 });
  await page.waitForFunction(() => !document.querySelector('.dialog-pdf .dialog-actions .btn-primary').disabled, null, { timeout: 60000 });
  const chosen = await page.evaluate(() => [...document.querySelectorAll('.pdf-page')].findIndex((b) => b.getAttribute('aria-pressed') === 'true') + 1);
  await page.click('.dialog-pdf .dialog-actions .btn-primary');
  await page.waitForFunction(() => window.cbre.store.plan.underlay?.traced, null, { timeout: 120000 });
  const found = await page.evaluate(async () => {
    const { packageOf } = await import(new URL('src/finishes.js', document.baseURI).href);
    const p = window.cbre.store.plan;
    const xs = p.walls.flatMap((w) => [w.a.x, w.b.x]), ys = p.walls.flatMap((w) => [w.a.y, w.b.y]);
    const windows = p.openings.filter((o) => o.type === 'window').length;
    return {
      walls: p.walls.length, doors: p.openings.length - windows, windows, rooms: p.rooms.length, items: p.items.length,
      span: xs.length ? [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)] : [0, 0],
      names: Object.fromEntries(p.rooms.map((r) => [r.name, packageOf(r)])),
      toasts: [...document.querySelectorAll('.toast-text')].map((t) => t.textContent),
    };
  });
  return { chosen, ...found };
}

/**
 * The PDF drawing set, after checking that a sheet printed to fit gets its scale from its doors and
 * that OCR reads the scale notes and titles of the set scanned and of the sheet with outlined text.
 */
async function importPdf(page) {
  pdfs ||= await makeTestPdfs(browser, base, `${out}/pdf`);
  const spanOff = (span) => Math.max(...span.map((v, i) => Math.abs(v / PDF_SPAN[i] - 1)));
  const fit = await importPdfFile(page, pdfs.tabloid);
  if (!fit.toasts.some((t) => /does not match its doors/.test(t))) errors.push(`pdf: the sheet printed to fit did not fall back to its doors (${fit.toasts.join(' | ')})`);
  if (spanOff(fit.span) > 0.05) errors.push(`pdf: the sheet printed to fit traced ${fit.span.map((v) => v.toFixed(2)).join(' x ')} m, expected ${PDF_SPAN.map((v) => v.toFixed(2)).join(' x ')}`);
  // Read with OCR: the scanned set's floor plan is page 3, after a ceiling plan with more linework.
  for (const [name, file, want] of [['scanned set', pdfs.scanset, 3], ['outlined sheet', pdfs.outlined, 0]]) {
    await page.goto(base, { waitUntil: 'load' });
    const got = await importPdfFile(page, file);
    if (got.chosen !== want) errors.push(`pdf: the ${name} chose page ${got.chosen}, not ${want}`);
    if (!got.toasts.some((t) => /scale note, 1\/4" = 1'-0", read from the page by OCR/.test(t))) errors.push(`pdf: the ${name}'s scale was not read from its note by OCR (${got.toasts.join(' | ')})`);
    if (spanOff(got.span) > 0.02) errors.push(`pdf: the ${name} traced ${got.span.map((v) => v.toFixed(2)).join(' x ')} m, expected ${PDF_SPAN.map((v) => v.toFixed(2)).join(' x ')}`);
    errors.push(...roomErrors(name, got, 1));
    console.log(`pdf: ${name}, page ${got.chosen}, ${got.walls} walls, ${got.doors} doors, ${got.rooms} rooms, ${got.span.map((v) => v.toFixed(2)).join(' x ')} m; ${Object.keys(got.names).join(', ')}`);
  }
  await page.goto(base, { waitUntil: 'load' });
  const set = await importPdfFile(page, pdfs.set);
  if (set.chosen !== 2) errors.push(`pdf: the dialog chose page ${set.chosen}, not the floor plan on page 2`);
  if (!set.toasts.some((t) => /scale note, 1\/4" = 1'-0"/.test(t))) errors.push(`pdf: the scale was not set from the sheet's scale note (${set.toasts.join(' | ')})`);
  if (spanOff(set.span) > 0.02) errors.push(`pdf: traced ${set.span.map((v) => v.toFixed(2)).join(' x ')} m, expected ${PDF_SPAN.map((v) => v.toFixed(2)).join(' x ')}`);
  for (const key of ['walls', 'doors', 'windows', 'rooms', 'items']) {
    if (set[key] < TRACED[key]) errors.push(`pdf: traced ${set[key]} ${key}, expected at least ${TRACED[key]}`);
  }
  errors.push(...roomErrors('drawing set', set, 0));
  console.log(`pdf: page ${set.chosen}, ${set.walls} walls, ${set.doors} doors, ${set.windows} windows, ${set.rooms} rooms, ${set.items} items, ${set.span.map((v) => v.toFixed(2)).join(' x ')} m; printed to fit ${fit.span.map((v) => v.toFixed(2)).join(' x ')} m; ${Object.keys(set.names).join(', ')}`);
}

async function capture(page, id) {
  await page.addInitScript(() => localStorage.clear());
  await page.goto(base, { waitUntil: 'load' });
  if (id === 'import') {
    await importDrawing(page);
  } else if (id === 'pdf') {
    await importPdf(page);
  } else {
    const { SAMPLES } = await page.evaluate(async () => ({ SAMPLES: (await import(new URL('src/samples/index.js', document.baseURI).href)).SAMPLES.map((s) => ({ id: s.id, name: s.name })) }));
    const name = SAMPLES.find((s) => s.id === id).name;
    await page.getByRole('button', { name: new RegExp(`^${name}(?! image)`) }).first().click();
    await page.waitForFunction((n) => window.cbre.store.plan.walls.length > 0 && !document.querySelector('dialog[open]'), name, { timeout: 15000 });
    const used = await packages(page);
    const missing = (SAMPLE_FINISHES[id] || []).filter((k) => !used.includes(k));
    if (missing.length) errors.push(`${id}: no room in the ${missing.join(', ')} finishes`);
  }
  await page.waitForTimeout(800);
  const stats = await page.evaluate(() => { const p = window.cbre.store.plan; return { name: p.name, walls: p.walls.length, openings: p.openings.length, rooms: p.rooms.length, items: p.items.length, cameras: p.cameras.length }; });
  console.log(id, JSON.stringify(stats));
  await page.screenshot({ path: `${out}/${id}-plan.png` });
  for (const mode of ['split', 'walk']) {
    const t = Date.now();
    const frame0 = await page.evaluate(() => window.cbre.walk?.renderer.info.render.frame ?? 0);
    await page.evaluate((m) => window.cbre.setMode(m), mode);
    await page.waitForFunction(() => window.cbre.walk && window.cbre.walk._built, null, { timeout: 120000 });
    const drawn = await settle(page, frame0);
    console.log(`  ${mode} ready in ${Date.now() - t} ms (${drawn.renders} render passes; the GPU was still busy ${drawn.gpuMs} ms once the view went idle)`);
    await page.screenshot({ path: `${out}/${id}-${mode}.png`, timeout: 60000 });
  }
}

for (const id of samples) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(`${id} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${id} console: ${m.text()}`); });
  page.on('requestfailed', (r) => errors.push(`${id} requestfailed: ${r.url()}`));
  try {
    await capture(page, id);
  } catch (err) {
    errors.push(`${id} failed: ${err.message.split('\n')[0]}`);
  }
  await page.close();
}
console.log('ERRORS', JSON.stringify(errors, null, 1));
await browser.close();
if (errors.length) process.exitCode = 1;
