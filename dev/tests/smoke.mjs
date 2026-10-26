// End-to-end smoke test: opens each sample through the welcome dialog and captures Plan, Split and
// Walk, then does the same for a floor plan image imported and traced into a new plan ('import').
// Usage: node dev/tests/smoke.mjs <baseUrl> <outDir> [sampleId | import ...]
// Software rendering takes seconds to a minute per Realistic frame, so each 3D capture waits for the
// walkthrough to stop drawing and for the GPU to finish, not for a fixed time. Exits 1 on any error.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [base = 'http://localhost:8080/', out = 'smoke-out', ...only] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
// How long the 3D view may take to finish drawing after a mode switch (software rendering under load).
const DRAW_TIMEOUT = 300000;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const samples = only.length ? only : ['lab-suite', 'medical-office', 'office-floor', 'retail-warehouse', 'trace-demo', 'import'];
// The trace demo's drawing (24 px per foot) and what tracing it finds: 15 walls, 8 doors, 12 windows
// and 8 rooms. The test allows for a few misses.
const DRAWING = fileURLToPath(new URL('../../assets/samples/trace-demo.svg', import.meta.url));
const TRACED = { walls: 12, doors: 6, windows: 10, rooms: 6, scale: 0.3048 / 24 };

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
    return { walls: p.walls.length, doors: p.openings.length - windows, windows, rooms: p.rooms.length, scale: p.underlay.scale };
  });
  for (const key of ['walls', 'doors', 'windows', 'rooms']) {
    if (found[key] < TRACED[key]) errors.push(`import: traced ${found[key]} ${key}, expected at least ${TRACED[key]}`);
  }
  if (Math.abs(found.scale / TRACED.scale - 1) > 0.03) errors.push(`import: traced scale ${found.scale} m/px, expected ${TRACED.scale}`);
}

async function capture(page, id) {
  await page.addInitScript(() => localStorage.clear());
  await page.goto(base, { waitUntil: 'load' });
  if (id === 'import') {
    await importDrawing(page);
  } else {
    const { SAMPLES } = await page.evaluate(async () => ({ SAMPLES: (await import(new URL('src/samples/index.js', document.baseURI).href)).SAMPLES.map((s) => ({ id: s.id, name: s.name })) }));
    const name = SAMPLES.find((s) => s.id === id).name;
    await page.getByRole('button', { name: new RegExp(`^${name}(?! image)`) }).first().click();
    await page.waitForFunction((n) => window.cbre.store.plan.walls.length > 0 && !document.querySelector('dialog[open]'), name, { timeout: 15000 });
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
