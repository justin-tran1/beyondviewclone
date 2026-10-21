// Screenshot a page served by `npm start` and report console errors.
// Usage: node scripts/shot.mjs <url> <out.png> [--size=1440x900] [--wait=<js expression>] [--full]
//        [--eval=<js run before the shot>] [--delay=ms]
// Example: node scripts/shot.mjs "http://localhost:8080/dev/catalog.html?category=lab" /tmp/lab.png --wait=window.previewReady
import { chromium } from 'playwright';

const [url, out, ...flags] = process.argv.slice(2);
if (!url || !out) {
  console.error('Usage: node scripts/shot.mjs <url> <out.png> [--size=WxH] [--wait=expr] [--eval=js] [--delay=ms] [--full]');
  process.exit(2);
}
const opt = Object.fromEntries(flags.map((f) => {
  const [k, ...v] = f.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));
const [w, h] = String(opt.size || '1440x900').split('x').map(Number);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()}`));
await page.goto(url, { waitUntil: 'load' });
if (opt.wait) await page.waitForFunction(opt.wait, null, { timeout: 30000 }).catch(() => errors.push(`timeout waiting for ${opt.wait}`));
if (opt.eval) await page.evaluate(opt.eval).catch((e) => errors.push(`eval: ${e.message}`));
await page.waitForTimeout(Number(opt.delay || 400));
await page.screenshot({ path: out, fullPage: !!opt.full });
console.log(JSON.stringify({ out, errors }, null, 1));
await browser.close();
process.exit(errors.length ? 1 : 0);
