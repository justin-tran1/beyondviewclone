// Renders the site's imagery from the procedural lab scene (assets/js/lab-scene.js).
// Usage: npm run render            (all images)
//        npm run render -- hero    (only shots whose name contains "hero")
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const OUT = fileURLToPath(new URL('../assets/img/renders/', import.meta.url));
const PORT = 8765;

export const SHOTS = [
  { name: 'hero-lab', mode: 'lab', view: 'entry', width: 2400, height: 1200, fov: 66 },
  { name: 'home-hero-raw', mode: 'raw', view: 'entry', width: 1600, height: 1000, fov: 64 },
  { name: 'compare-raw', mode: 'raw', view: 'aisle', width: 1600, height: 1060 },
  { name: 'compare-whitebox', mode: 'whitebox', view: 'aisle', width: 1600, height: 1060 },
  { name: 'compare-lab', mode: 'lab', view: 'aisle', width: 1600, height: 1060 },
  { name: 'reposition-whitebox', mode: 'whitebox', view: 'corner', width: 1600, height: 1060 },
  { name: 'reposition-lab', mode: 'lab', view: 'corner', width: 1600, height: 1060 },
  { name: 'gallery-hoods', mode: 'lab', view: 'hoods', width: 1600, height: 900 },
  { name: 'gallery-writeup', mode: 'lab', view: 'writeup', width: 1600, height: 900 },
  { name: 'gallery-corner', mode: 'lab', view: 'corner', width: 1600, height: 900 },
  { name: 'gallery-entry', mode: 'lab', view: 'entry', width: 1600, height: 900 },
  { name: 'gallery-aisle', mode: 'lab', view: 'aisle', width: 1600, height: 900 },
  { name: 'tour-poster', mode: 'lab', view: 'entry', width: 1440, height: 810 },
  { name: 'og-image', mode: 'lab', view: 'corner', width: 1200, height: 630, fov: 58 },
];

const filter = process.argv[2];
const server = spawn(process.execPath, [fileURLToPath(new URL('./serve.mjs', import.meta.url)), String(PORT)], { stdio: 'ignore' });

try {
  await new Promise((r) => setTimeout(r, 600));
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`http://localhost:${PORT}/scripts/render.html`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 60000 });

  for (const shot of SHOTS.filter((s) => !filter || s.name.includes(filter))) {
    const t = Date.now();
    const dataUrl = await page.evaluate((s) => window.renderShot(s), shot);
    const file = `${OUT}${shot.name}.jpg`;
    await writeFile(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`rendered ${shot.name}.jpg (${shot.width}x${shot.height}) in ${Date.now() - t}ms`);
  }
  await browser.close();
} finally {
  server.kill();
}
