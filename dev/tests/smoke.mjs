// End-to-end smoke test: opens each sample through the welcome dialog and captures Plan, Split and
// Walk. Usage: node dev/tests/smoke.mjs <baseUrl> <outDir> [sampleId ...]
// Software rendering takes seconds to a minute per Realistic frame, so each 3D capture waits for the
// walkthrough to stop drawing and for the GPU to finish, not for a fixed time. Exits 1 on any error.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const [base = 'http://localhost:8080/', out = 'smoke-out', ...only] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
// How long the 3D view may take to finish drawing after a mode switch (software rendering under load).
const DRAW_TIMEOUT = 300000;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const samples = only.length ? only : ['lab-suite', 'medical-office', 'office-floor', 'retail-warehouse', 'trace-demo'];

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

async function capture(page, id) {
  await page.addInitScript(() => localStorage.clear());
  await page.goto(base, { waitUntil: 'load' });
  const { SAMPLES } = await page.evaluate(async () => ({ SAMPLES: (await import(new URL('src/samples/index.js', document.baseURI).href)).SAMPLES.map((s) => ({ id: s.id, name: s.name })) }));
  const name = SAMPLES.find((s) => s.id === id).name;
  await page.getByRole('button', { name: new RegExp(`^${name}(?! image)`) }).first().click();
  await page.waitForFunction((n) => window.cbre.store.plan.walls.length > 0 && !document.querySelector('dialog[open]'), name, { timeout: 15000 });
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
