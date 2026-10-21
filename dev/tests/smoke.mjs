// End-to-end smoke test: opens each sample through the welcome dialog and captures Plan, Split and
// Walk. Usage: node dev/tests/smoke.mjs <baseUrl> <outDir> [sampleId ...]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const [base = 'http://localhost:8080/', out = 'smoke-out', ...only] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const samples = only.length ? only : ['lab-suite', 'medical-office', 'office-floor', 'retail-warehouse', 'trace-demo'];

for (const id of samples) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(`${id} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${id} console: ${m.text()}`); });
  page.on('requestfailed', (r) => errors.push(`${id} requestfailed: ${r.url()}`));
  await page.addInitScript(() => localStorage.clear());
  await page.goto(base, { waitUntil: 'load' });
  const { SAMPLES } = await page.evaluate(async () => ({ SAMPLES: (await import('/src/samples/index.js')).SAMPLES.map((s) => ({ id: s.id, name: s.name })) }));
  const name = SAMPLES.find((s) => s.id === id).name;
  await page.getByRole('button', { name: new RegExp(`^${name}(?! image)`) }).first().click();
  await page.waitForFunction((n) => window.cbre.store.plan.walls.length > 0 && !document.querySelector('dialog[open]'), name, { timeout: 15000 });
  await page.waitForTimeout(800);
  const stats = await page.evaluate(() => { const p = window.cbre.store.plan; return { name: p.name, walls: p.walls.length, openings: p.openings.length, rooms: p.rooms.length, items: p.items.length, cameras: p.cameras.length }; });
  console.log(id, JSON.stringify(stats));
  await page.screenshot({ path: `${out}/${id}-plan.png` });
  for (const mode of ['split', 'walk']) {
    const t = Date.now();
    await page.evaluate((m) => window.cbre.setMode(m), mode);
    await page.waitForFunction(() => window.cbre.walk && window.cbre.walk._built, null, { timeout: 120000 });
    await page.waitForTimeout(mode === 'walk' ? 6000 : 5000);
    console.log(`  ${mode} ready in ${Date.now() - t} ms`);
    await page.screenshot({ path: `${out}/${id}-${mode}.png` });
  }
  await page.close();
}
console.log('ERRORS', JSON.stringify(errors, null, 1));
await browser.close();
