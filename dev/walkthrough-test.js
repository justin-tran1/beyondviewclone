// Developer page and Playwright checks for src/walkthrough.js.
// In a browser (dev/walkthrough-test.html): mounts a full-window Walkthrough on a furnished test suite,
// or on a sample with ?sample=<id>, at ?quality=high|balanced|fast (default high), and exposes
// window.walk, window.store and window.testReady.
// In Node: `node dev/walkthrough-test.js [--url=http://localhost:8080] [--shots=<dir>]` runs the checks
// in Chromium (starting its own static server when --url is not given) and saves screenshots.

// ---- Test plan (meters, plan y down) ------------------------------------------------------

/** Fixed spots the checks rely on; the plan keeps them clear of furniture. */
const SPOTS = {
  aisle: { x: 1.0, y: 7.0, yaw: 90, pitch: 0 },
  breakWall: { x: 5.0, y: 11.5, yaw: 0, pitch: 0 },
  breakWallY: 10 + 0.0635 + 0.25,
  door: { x: 3.5, y: 12.0, yaw: 0, pitch: 0 },
  glass: { x: 10.0, y: 4.0, yaw: 90, pitch: 0 },
  glassX: 14 - 0.03175 - 0.25,
  desk: { x: 19.5, y: 12.5, yaw: 0, pitch: 0 },
  deskY: 10.2 + 0.91 / 2 + 0.25,
  lobby: { x: 19.5, y: 13.4 },
  passages: [
    // The open half of the sliding door; the fixed and closed panels cover y 12.4 to 13.05.
    { name: 'sliding door', from: { x: 12.6, y: 13.33, yaw: 90 }, past: (p) => p.x > 15.2 },
    { name: 'glass door', from: { x: 12.6, y: 5, yaw: 90 }, past: (p) => p.x > 15.2 },
    { name: 'double door', from: { x: 17, y: 8, yaw: 0 }, past: (p) => p.y < 6 },
    { name: 'entry doors', from: { x: 19.5, y: 14.8, yaw: 180 }, past: (p) => p.y > 16.6 },
    { name: 'cased opening', from: { x: 7.5, y: 11.5, yaw: 0 }, past: (p) => p.y < 9 },
  ],
  window: { x: 2, y: 1.2, yaw: 0, pitch: 0 },
  windowY: 0.1524 + 0.25,
};

function testPlan(model) {
  const { createPlan, normalizePlan, addWall, addOpening, addRoom, addItem, addCamera, DEFAULTS } = model;
  const plan = createPlan({ name: 'Walkthrough test suite', settings: { wallHeight: DEFAULTS.wallHeight, ceiling: 'tile', exterior: 'city' } });
  const P = (x, y) => ({ x, y });
  const wall = (a, b, kind = 'interior') => addWall(plan, P(...a), P(...b), { kind });
  const open = (w, type, offset, props = {}) => addOpening(plan, w.id, type, offset, props);

  const north = wall([0, 0], [24, 0], 'exterior');
  const east = wall([24, 0], [24, 16], 'exterior');
  const south = wall([24, 16], [0, 16], 'exterior');
  const west = wall([0, 16], [0, 0], 'exterior');
  for (const x of [2, 5.5, 9, 12.5]) open(north, 'window', x, { width: 1.8 });
  for (const x of [17, 21]) open(north, 'window', x, { width: 2.4 });
  open(east, 'window', 3.5, { width: 2.4 });
  open(east, 'window', 11, { width: 1.8 });
  open(south, 'double-door', 4.5, { side: 1 });
  open(south, 'window', 16, { width: 1.8 });
  open(south, 'window', 11.5, { width: 1.8 });
  open(west, 'window', 11, { width: 1.8 });

  const glass = wall([14, 0], [14, 7], 'glass');
  open(glass, 'door', 5, { side: 1, hinge: 'end' });
  const conf = wall([14, 7], [24, 7]);
  open(conf, 'double-door', 3, { side: 1 });
  const breakNorth = wall([0, 10], [14, 10]);
  open(breakNorth, 'door', 3.5, { side: -1, hinge: 'start' });
  open(breakNorth, 'opening', 7.5, { width: 1.5 });
  const breakEast = wall([14, 10], [14, 16]);
  open(breakEast, 'sliding-door', 3, { side: 1 });
  wall([8.9, 7.7], [8.9, 9.7], 'partial');

  addRoom(plan, [P(0, 0), P(14, 0), P(14, 10), P(0, 10)], { name: 'Open office', floor: 'carpet', ceiling: 'tile' });
  addRoom(plan, [P(14, 0), P(24, 0), P(24, 7), P(14, 7)], { name: 'Conference', floor: 'wood', ceiling: 'drywall' });
  addRoom(plan, [P(14, 7), P(24, 7), P(24, 16), P(14, 16)], { name: 'Reception', floor: 'polished-concrete', ceiling: 'drywall' });
  addRoom(plan, [P(0, 10), P(14, 10), P(14, 16), P(0, 16)], { name: 'Break room', floor: 'vinyl', ceiling: 'open' });

  const item = (type, x, y, rotation = 0, props = {}) => addItem(plan, type, x, y, { rotation, ...props });
  item('benching-4', 3.2, 3.6);
  item('benching-4', 7.4, 3.6);
  item('phone-booth', 12.9, 1.0);
  item('planter', 11.2, 5.8);
  item('area-rug', 11.3, 8.7, 0, { w: 3.4, d: 2.2 });
  item('sofa', 11.3, 9.48, 180);
  item('coffee-table', 11.3, 8.5);
  item('lounge-chair', 9.6, 8.3, 270);
  item('plant', 0.55, 9.45);
  item('plant', 0.55, 0.55);
  item('conference-table-10', 19, 3.4);
  item('tv-display', 23.62, 3.4, 90);
  item('plant', 14.6, 6.4);
  item('reception-desk', 19.5, 10.2);
  item('waiting-chairs', 23.49, 13.5, 90);
  item('area-rug', 19.5, 13.4, 0, { w: 3, d: 2 });
  item('plant', 23.4, 15.4);
  item('plant', 14.6, 15.4);
  item('pantry-counter', 0.482, 13, 270);
  item('round-table-4', 6.5, 13.4);
  item('round-table-4', 10.5, 13.4);
  item('plant', 13.4, 15.4);

  addCamera(plan, 0.9, 7.6, 62, { name: 'Open office', pitch: -2 });
  addCamera(plan, 23.2, 6.3, 300, { name: 'Conference room', pitch: -4 });
  addCamera(plan, 22.6, 15.0, 318, { name: 'Reception', pitch: -3 });
  addCamera(plan, 13.3, 11, 235, { name: 'Break room', pitch: -3 });
  return normalizePlan(plan);
}

// ---- Browser page -------------------------------------------------------------------------

async function mountPage() {
  const err = document.getElementById('err');
  window.addEventListener('error', (e) => { err.textContent += `${e.message}\n`; });
  const params = new URLSearchParams(location.search);
  const [model, { Walkthrough }] = await Promise.all([import('../src/model.js'), import('../src/walkthrough.js'), import('../src/catalog/index.js')]);

  let plan = testPlan(model);
  const sampleId = params.get('sample');
  if (sampleId) {
    const { SAMPLES } = await import('../src/samples/index.js');
    const sample = SAMPLES.find((s) => s.id === sampleId);
    if (sample) plan = await sample.build();
    else err.textContent = `Unknown sample "${sampleId}"`;
  }

  const store = new model.PlanStore(plan);
  const container = document.getElementById('walk');
  const quality = ['high', 'balanced', 'fast'].includes(params.get('quality')) ? params.get('quality') : 'high';
  const walk = new Walkthrough(container, store, { minimap: params.get('minimap') !== '0', quality });
  // The environment's PMREM passes already count as renderer frames; wait for one more.
  const setupFrames = walk.renderer.info.render.frame;
  walk.start();
  container.focus({ preventScroll: true });
  Object.assign(window, { walk, store, testModel: model, testPlanFor: testPlan });

  // Like the app's overlays: a pointer click on a control gives focus back to the view, so walk keys keep working.
  const focusView = (e) => { if (e.detail > 0) container.focus({ preventScroll: true }); };
  const modes = document.getElementById('modes');
  modes.addEventListener('click', (e) => {
    const mode = e.target.closest('button')?.dataset.mode;
    if (mode) walk.setMode(mode);
    focusView(e);
  });
  walk.addEventListener('mode', (e) => {
    for (const b of modes.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === e.detail.mode));
  });

  // Quality: pressed is the level in use; an outline marks a level lowered automatically.
  const qualityGroup = document.getElementById('quality');
  const syncQuality = () => {
    for (const b of qualityGroup.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.quality === walk.quality));
      b.dataset.auto = String(b.dataset.quality === walk.quality && walk.quality !== walk.chosenQuality);
    }
  };
  qualityGroup.addEventListener('click', (e) => {
    const q = e.target.closest('button')?.dataset.quality;
    if (q) walk.setQuality(q);
    focusView(e);
  });
  walk.addEventListener('quality', syncQuality);
  syncQuality();

  const views = document.getElementById('views');
  const renderViews = () => {
    views.replaceChildren(...store.plan.cameras.slice(0, 9).map((cam, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      const key = document.createElement('kbd');
      const name = document.createElement('span');
      key.textContent = String(i + 1);
      name.textContent = cam.name;
      b.append(key, name);
      b.title = cam.name;
      b.addEventListener('click', (e) => {
        walk.goToCamera(cam.id);
        focusView(e);
      });
      return b;
    }));
    views.hidden = !store.plan.cameras.length;
  };
  renderViews();
  store.addEventListener('change', renderViews);

  document.getElementById('shot').addEventListener('click', async () => {
    const blob = await walk.screenshot();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${store.plan.name.replace(/[^\w-]+/g, '-').toLowerCase()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  const hint = document.getElementById('hint');
  const dismiss = () => hint.classList.add('gone');
  container.addEventListener('pointerdown', dismiss, { once: true });
  container.addEventListener('keydown', dismiss, { once: true });

  // Ready once the first frame is drawn and the post-processing lookup textures have loaded (their
  // arrival asks for one more frame).
  const firstFrame = new Promise((resolve) => {
    const poll = () => (walk.renderer.info.render.frame > setupFrames ? resolve() : requestAnimationFrame(poll));
    poll();
  });
  await firstFrame;
  await walk._postfx.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  window.testReady = true;
}

// ---- Node checks ----------------------------------------------------------------------------

async function runChecks() {
  const { chromium } = await import('playwright');
  const { spawn } = await import('node:child_process');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { fileURLToPath } = await import('node:url');

  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=') || true];
  }));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const shots = args.shots || join(tmpdir(), 'walkthrough-shots');
  await mkdir(shots, { recursive: true });

  let server = null;
  let base = args.url;
  if (!base) {
    const port = 8300 + Math.floor(Math.random() * 400);
    server = spawn(process.execPath, ['scripts/serve.mjs', String(port)], { cwd: root, stdio: 'ignore' });
    process.on('exit', () => server.kill());
    base = `http://localhost:${port}`;
    for (let i = 0; i < 50; i++) {
      if (await fetch(base).then(() => true, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const pageUrl = `${base.replace(/\/$/, '')}/dev/walkthrough-test.html`;
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const results = [];
  const errors = [];

  async function openPage(options = {}) {
    const context = await browser.newContext({ viewport: { width: 560, height: 340 }, ...options });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()}`));
    await page.goto(pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => window.testReady === true, null, { timeout: 60000 });
    return page;
  }

  const page = await openPage();
  const wait = (ms) => page.waitForTimeout(ms);
  const pose = () => page.evaluate(() => window.walk.pose);
  const place = (p) => page.evaluate((q) => window.walk.goTo(q, { animate: false }), p);
  const focus = () => page.evaluate(() => window.walk.container.focus());
  const frames = () => page.evaluate(() => window.walk.renderer.info.render.frame);
  const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });
  async function hold(key, ms) {
    await page.keyboard.down(key);
    await wait(ms);
    await page.keyboard.up(key);
  }
  /** Hold a key until the walker stops moving or `done(pose)` is true. Returns the sampled poses. */
  async function walk(key, { done = () => false, maxMs = 40000, shift = false } = {}) {
    if (shift) await page.keyboard.down('Shift');
    await page.keyboard.down(key);
    const t0 = Date.now();
    const sample = () => page.evaluate(() => ({ p: window.walk.pose, f: window.walk.renderer.info.render.frame }));
    let last = await sample(), still = 0;
    const seen = [last.p];
    while (Date.now() - t0 < maxMs) {
      await wait(250);
      const s = await sample();
      seen.push(s.p);
      // Only a rendered frame that did not move counts as stopped; slow software frames are not.
      if (s.f > last.f) still = Math.hypot(s.p.x - last.p.x, s.p.y - last.p.y) < 0.0005 && Date.now() - t0 > 800 ? still + 1 : 0;
      last = s;
      if (still >= 3 || done(s.p)) break;
    }
    await page.keyboard.up(key);
    if (shift) await page.keyboard.up('Shift');
    return seen;
  }
  async function idle() {
    await page.waitForFunction(() => {
      const w = window.walk;
      return !w._raf && !w._anim && !w._glide && !w._tween && !w._stale;
    }, null, { timeout: 40000 }).catch(() => {});
  }
  async function check(name, fn) {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail });
    } catch (e) {
      results.push({ name, ok: false, detail: e.message });
    }
  }
  /** Whether the walker (radius 0.25 m) at its pose overlaps no wall or blocking item, in page context. */
  const freeNow = () => page.evaluate(() => {
    const w = window.walk, p = w._pose, R = 0.25 - 1e-3;
    const seg = (q, a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1e-12;
      const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2));
      return Math.hypot(q.x - (a.x + dx * t), q.y - (a.y + dy * t));
    };
    return w._world.query(p.x - 2, p.y - 2, p.x + 2, p.y + 2, []).every((e) => {
      if (e.seg) return seg(p, e.a, e.b) >= e.r + R;
      let inside = false;
      for (let i = 0, j = e.pts.length - 1; i < e.pts.length; j = i++) {
        const a = e.pts[i], b = e.pts[j];
        if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      return !inside && e.pts.every((a, i) => seg(p, a, e.pts[(i + 1) % e.pts.length]) >= R);
    });
  });
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const fmt = (p) => `(${p.x.toFixed(3)}, ${p.y.toFixed(3)}) yaw ${p.yaw.toFixed(1)} pitch ${p.pitch.toFixed(1)}`;
  const spots = SPOTS;

  await check('start pose is the first saved camera', async () => {
    const p = await pose();
    const cam = await page.evaluate(() => window.store.plan.cameras[0]);
    assert(near(p.x, cam.x, 0.01) && near(p.y, cam.y, 0.01) && near(p.yaw, cam.yaw, 0.01), `pose ${fmt(p)}`);
    await shot('01-start');
    return fmt(p);
  });

  await check('idle walkthrough renders no frames', async () => {
    await idle();
    const f0 = await frames();
    await wait(1200);
    const f1 = await frames();
    assert(f1 === f0, `${f1 - f0} frames rendered while idle`);
    return 'no frames in 1.2 s';
  });

  await check('W moves forward', async () => {
    await place(spots.aisle);
    await focus();
    await idle();
    const a = await pose();
    await page.evaluate(() => {
      window.poseTimes = [];
      window.walk.addEventListener('pose', () => window.poseTimes.push(performance.now()));
    });
    await hold('w', 1000);
    await idle();
    const b = await pose();
    const times = await page.evaluate(() => window.poseTimes);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    assert(b.x - a.x > 0.1 && b.x - a.x < 2, `moved ${(b.x - a.x).toFixed(3)} m along x`);
    assert(Math.abs(b.y - a.y) < 0.005, `drifted ${(b.y - a.y).toFixed(3)} m sideways`);
    assert(times.length >= 2 && Math.min(...gaps) >= 95, `pose events ${gaps.map(Math.round).join(', ')} ms apart`);
    return `moved ${(b.x - a.x).toFixed(2)} m, ${times.length} pose events, at least ${Math.round(Math.min(...gaps))} ms apart`;
  });

  await check('walking into a wall stops short of it', async () => {
    await place(spots.breakWall);
    const seen = await walk('w');
    await idle();
    const end = await pose();
    const minY = Math.min(...seen.map((p) => p.y), end.y);
    assert(minY >= spots.breakWallY - 0.002, `got within ${(minY - 10).toFixed(3)} m of the wall centerline`);
    assert(end.y < spots.breakWallY + 0.03, `stopped at y ${end.y.toFixed(3)}, too far from the wall`);
    await shot('02-wall');
    return `stopped at y ${end.y.toFixed(3)} (limit ${spots.breakWallY.toFixed(3)})`;
  });

  await check('running at a glass partition never tunnels through', async () => {
    await place(spots.glass);
    const seen = await walk('w', { shift: true });
    await idle();
    const maxX = Math.max(...seen.map((p) => p.x), (await pose()).x);
    assert(maxX <= spots.glassX + 0.002, `reached x ${maxX.toFixed(3)}`);
    assert(maxX > spots.glassX - 0.03, `stopped early at x ${maxX.toFixed(3)}`);
    return `max x ${maxX.toFixed(3)} (limit ${spots.glassX.toFixed(3)})`;
  });

  await check('walking into furniture stops short', async () => {
    await place(spots.desk);
    await walk('w');
    await idle();
    const p = await pose();
    assert(p.y >= spots.deskY - 0.002 && p.y < spots.deskY + 0.05, `stopped at y ${p.y.toFixed(3)} (desk limit ${spots.deskY.toFixed(3)})`);
    return `stopped at y ${p.y.toFixed(3)}`;
  });

  await check('sliding along a wall keeps moving', async () => {
    await place({ ...spots.breakWall, yaw: 30 });
    const a = await pose();
    await walk('w', { done: (p) => p.x - a.x > 0.8 });
    await idle();
    const b = await pose();
    assert(b.y >= spots.breakWallY - 0.002, `penetrated to y ${b.y.toFixed(3)}`);
    assert(b.x - a.x > 0.6, `slid only ${(b.x - a.x).toFixed(3)} m`);
    return `slid ${(b.x - a.x).toFixed(2)} m along the wall`;
  });

  await check('walks through a doorway', async () => {
    await place(spots.door);
    await walk('w', { done: (p) => p.y < 8.8 });
    await idle();
    const p = await pose();
    assert(p.y < 9.4, `ended at ${fmt(p)}, still south of the door`);
    await shot('03-through-door');
    return `ended at ${fmt(p)}`;
  });

  await check('doors and openings are passable, windows are not', async () => {
    const passed = [];
    for (const door of spots.passages) {
      await place({ ...door.from, pitch: 0 });
      await walk('w', { done: door.past });
      await idle();
      const p = await pose();
      assert(door.past(p), `${door.name}: stopped at ${fmt(p)}`);
      passed.push(door.name);
    }
    await place(spots.window);
    await walk('w');
    await idle();
    const p = await pose();
    assert(p.y >= spots.windowY - 0.002 && p.y < spots.windowY + 0.03, `window: ended at ${fmt(p)}`);
    return `${passed.join(', ')}; stopped at the window`;
  });

  await check('outdoors the walker stays within 15 m of the plan', async () => {
    const r = await page.evaluate(() => {
      const w = window.walk, b = w._built.bounds, out = {};
      const run = (from, seconds) => {
        w.goTo(from, { animate: false });
        w._keys.add('forward');
        w._run = true;
        for (let i = 0; i < seconds * 30; i++) w._stepWalk(1 / 30);
        w._keys.clear();
        w._run = false;
        w._cancelMotion();
        return { ...w._pose };
      };
      out.south = run({ x: 19.5, y: 17.2, yaw: 180, pitch: 0 }, 60);
      out.corner = run({ x: 19.5, y: 17.2, yaw: 135, pitch: 0 }, 60);
      w.goTo({ x: 500, y: -300, yaw: 0, pitch: 0 }, { animate: false });
      out.far = { ...w._pose };
      out.limit = { minX: b.minX - 15, minY: b.minY - 15, maxX: b.maxX + 15, maxY: b.maxY + 15 };
      return out;
    });
    const L = r.limit, inside = (p) => p.x >= L.minX - 1e-6 && p.x <= L.maxX + 1e-6 && p.y >= L.minY - 1e-6 && p.y <= L.maxY + 1e-6;
    assert(inside(r.south) && r.south.y > L.maxY - 0.01, `walking south ended at ${fmt(r.south)}, limit y ${L.maxY.toFixed(2)}`);
    assert(inside(r.corner) && r.corner.x > L.maxX - 0.01 && r.corner.y > L.maxY - 0.01, `walking diagonally ended at ${fmt(r.corner)}`);
    assert(inside(r.far), `goTo far away ended at ${fmt(r.far)}`);
    await place(spots.aisle);
    return `stopped at y ${r.south.y.toFixed(2)} (limit ${L.maxY.toFixed(2)}), slid into the corner, goTo clamped`;
  });

  await check('click on the floor walks there', async () => {
    await place(spots.aisle);
    const vp = page.viewportSize();
    const fov = await page.evaluate(() => window.walk._camera.fov);
    const t = Math.tan((fov * Math.PI) / 360) * 0.4;
    const expected = spots.aisle.x + 1.6 / t;
    await page.mouse.move(vp.width / 2, vp.height * 0.7);
    await wait(400);
    const ring = await page.evaluate(() => window.walk._ring.visible);
    await shot('04-hover-ring');
    await page.mouse.click(vp.width / 2, vp.height * 0.7);
    await page.mouse.move(vp.width - 5, 80);
    await wait(500);
    await idle();
    const p = await pose();
    assert(ring, 'no ground ring while hovering the floor');
    assert(near(p.x, expected, 0.12) && near(p.y, spots.aisle.y, 0.05), `ended at ${fmt(p)}, expected x ${expected.toFixed(2)}`);
    return `arrived at x ${p.x.toFixed(2)} (expected ${expected.toFixed(2)})`;
  });

  await check('drag looks around like grabbing the view', async () => {
    await place(spots.aisle);
    const vp = page.viewportSize();
    const fov = await page.evaluate(() => window.walk._camera.fov);
    await page.mouse.move(vp.width / 2, vp.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(vp.width / 2 + i * 20, vp.height / 2 + i * 6);
    await wait(60);
    const mid = await pose();
    await page.mouse.up();
    await page.mouse.move(vp.width - 5, 80);
    await idle();
    const expectYaw = 90 - (200 * fov) / vp.height;
    assert(near(mid.yaw, expectYaw, 2.5), `yaw ${mid.yaw.toFixed(1)}, expected about ${expectYaw.toFixed(1)}`);
    assert(mid.pitch > 3, `pitch ${mid.pitch.toFixed(1)} should rise when dragging down`);
    const p = await pose();
    assert(near(p.x, spots.aisle.x, 0.001), 'a drag must not walk');
    return `yaw ${mid.yaw.toFixed(1)}, pitch ${mid.pitch.toFixed(1)}`;
  });

  await check('goToCamera and number keys', async () => {
    const cams = await page.evaluate(() => window.store.plan.cameras);
    await page.evaluate((id) => window.walk.goToCamera(id), cams[1].id);
    await wait(300);
    const mid = await pose();
    await idle();
    const a = await pose();
    assert(Math.hypot(mid.x - cams[1].x, mid.y - cams[1].y) > 0.2, 'goToCamera should animate');
    assert(near(a.x, cams[1].x, 0.02) && near(a.y, cams[1].y, 0.02) && near(a.yaw, cams[1].yaw, 0.5), `pose ${fmt(a)}`);
    await shot('05-camera-2');
    await focus();
    await page.keyboard.press('3');
    await idle();
    const b = await pose();
    assert(near(b.x, cams[2].x, 0.02) && near(b.y, cams[2].y, 0.02) && near(b.yaw, cams[2].yaw, 0.5), `key 3 gave ${fmt(b)}`);
    await shot('06-camera-3');
    await page.keyboard.press('4');
    await idle();
    await shot('07-camera-4');
    await page.keyboard.press('1');
    await idle();
    await shot('08-camera-1');
    return 'camera 2 by id, cameras 3, 4 and 1 by key';
  });

  await check('saved view jumps report their camera, from keys too', async () => {
    const cams = await page.evaluate(() => window.store.plan.cameras);
    await page.evaluate(() => {
      window.cameraEvents = [];
      window.walk.addEventListener('camera', (e) => window.cameraEvents.push(e.detail));
    });
    await focus();
    await page.keyboard.press('2');
    await idle();
    const events = await page.evaluate(() => window.cameraEvents.splice(0));
    const want = `${cams[1].id}:true,${cams[1].id}:false`;
    const got = events.map((e) => `${e.id}:${e.arriving}`).join();
    assert(got === want, `camera events ${got}, expected ${want}`);
    return 'key 2 reported the view on the way and on arrival';
  });

  await check('interrupting a camera move leaves the walker on a free spot', async () => {
    const vp = page.viewportSize();
    // Start a jump, then step it until the straight path is inside a wall and slow it so it stays there.
    const startInWall = (from, to) => page.evaluate(([i, j]) => {
      const w = window.walk, cams = window.store.plan.cameras;
      w.goTo(cams[i], { animate: false });
      w.goToCamera(cams[j].id);
      const R = 0.25;
      const blocked = () => w._world.query(w._pose.x - 1, w._pose.y - 1, w._pose.x + 1, w._pose.y + 1, []).some((e) => {
        if (!e.seg) return false;
        const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, l2 = dx * dx + dy * dy || 1e-12;
        const t = Math.max(0, Math.min(1, ((w._pose.x - e.a.x) * dx + (w._pose.y - e.a.y) * dy) / l2));
        return Math.hypot(w._pose.x - (e.a.x + dx * t), w._pose.y - (e.a.y + dy * t)) < e.r + R * 0.5;
      });
      while (w._anim && !blocked()) w._stepAnim(1 / 600);
      if (!w._anim) return false;
      w._anim.dur = 1e4;
      if (!window.cameraEvents) w.addEventListener('camera', (e) => window.cameraEvents.push(e.detail));
      window.cameraEvents = [];
      return true;
    }, [from, to]);
    assert(await startInWall(0, 2), 'the jump from view 1 to view 3 never crossed a wall');
    assert(!(await freeNow()), 'set up failed: the walker is not inside a wall');
    await page.mouse.move(vp.width / 2, vp.height / 2);
    await page.mouse.down();
    const byPointer = { free: await freeNow(), anim: await page.evaluate(() => !!window.walk._anim), events: await page.evaluate(() => window.cameraEvents.splice(0)) };
    await page.mouse.move(vp.width / 2 + 60, vp.height / 2, { steps: 4 });
    await page.mouse.up();
    await page.mouse.move(vp.width - 5, 80);
    await idle();
    const afterLook = await freeNow();
    assert(await startInWall(2, 0), 'the jump from view 3 to view 1 never crossed a wall');
    const byKey = await page.evaluate(() => {
      const c = window.walk.container;
      c.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true }));
      const anim = !!window.walk._anim;
      c.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true }));
      return { anim };
    });
    byKey.free = await freeNow();
    await idle();
    await shot('19-interrupted-jump');
    assert(!byPointer.anim && byPointer.free && afterLook, `pointer interrupt left the walker in a wall (${JSON.stringify(byPointer)})`);
    assert(byPointer.events.length === 1 && byPointer.events[0].id === null, `camera events on interrupt ${JSON.stringify(byPointer.events)}`);
    assert(!byKey.anim && byKey.free, 'key interrupt left the walker in a wall');
    return 'a pointer press and a key press both settle the walker clear of the wall';
  });

  await check('overview and back', async () => {
    await place(spots.lobby);
    const before = await pose();
    await page.evaluate(() => {
      window.modeEvents = [];
      window.walk.addEventListener('mode', (e) => window.modeEvents.push(e.detail.mode));
      window.walk.setMode('overview');
    });
    await wait(350);
    await shot('09-overview-transition');
    await idle();
    const ceilings = await page.evaluate(() => window.walk._built.ceilings.every((c) => !c.visible));
    await shot('10-overview');
    const vp = page.viewportSize();
    await page.mouse.move(vp.width / 2, vp.height / 2);
    await page.mouse.down();
    await page.mouse.move(vp.width / 2 + 160, vp.height / 2 + 30, { steps: 8 });
    await page.mouse.up();
    await wait(200);
    await idle();
    await shot('11-overview-orbit');
    await page.evaluate(() => window.walk.setMode('walk'));
    await idle();
    const after = await pose();
    const events = await page.evaluate(() => window.modeEvents);
    const mode = await page.evaluate(() => window.walk.mode);
    assert(ceilings, 'ceilings stay visible in overview');
    assert(events.join() === 'overview,walk' && mode === 'walk', `mode events ${events.join()}`);
    assert(near(after.x, before.x, 1e-6) && near(after.y, before.y, 1e-6) && near(after.yaw, before.yaw, 1e-6), `pose changed to ${fmt(after)}`);
    const ceilingsBack = await page.evaluate(() => window.walk._built.ceilings.every((c) => c.visible));
    assert(ceilingsBack, 'ceilings hidden after returning to walk');
    return 'mode events and pose restored';
  });

  await check('overview orbit keeps one frame pending at a time', async () => {
    await page.evaluate(() => window.walk.setMode('overview'));
    await idle();
    await page.evaluate(() => {
      const stats = window.frameStats = { maxPending: 0, maxPerFrame: 0, frames: 0, updates: 0 };
      const raf = window.requestAnimationFrame.bind(window), caf = window.cancelAnimationFrame.bind(window);
      const pending = new Set(), perTime = new Map();
      window.requestAnimationFrame = (fn) => {
        const id = raf((t) => {
          pending.delete(id);
          perTime.set(t, (perTime.get(t) || 0) + 1);
          stats.maxPerFrame = Math.max(stats.maxPerFrame, perTime.get(t));
          stats.frames++;
          fn(t);
        });
        pending.add(id);
        stats.maxPending = Math.max(stats.maxPending, pending.size);
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        pending.delete(id);
        caf(id);
      };
      const controls = window.walk._controls, update = controls.update;
      controls.update = (...args) => {
        stats.updates++;
        return update.apply(controls, args);
      };
      window.restoreFrames = () => {
        window.requestAnimationFrame = raf;
        window.cancelAnimationFrame = caf;
        controls.update = update;
      };
    });
    const vp = page.viewportSize();
    await page.mouse.move(vp.width / 2, vp.height / 2);
    await page.mouse.down();
    await page.mouse.move(vp.width / 2 + 40, vp.height / 2, { steps: 4 });
    await page.mouse.up();
    await page.mouse.move(vp.width / 2, vp.height / 2, { steps: 2 });
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(vp.width / 2 - 30, vp.height / 2 + 20, { steps: 4 });
    await page.mouse.up({ button: 'right' });
    await wait(300);
    await idle();
    const stats = await page.evaluate(() => {
      window.restoreFrames();
      return window.frameStats;
    });
    await page.evaluate(() => window.walk.setMode('walk'));
    await idle();
    assert(stats.maxPending === 1 && stats.maxPerFrame === 1, `up to ${stats.maxPending} frames pending, ${stats.maxPerFrame} callbacks in one frame`);
    assert(stats.frames >= 20, `damping ended after ${stats.frames} frames`);
    return `damping eased out over ${stats.frames} frames (${stats.updates} orbit updates), never more than one frame pending`;
  });

  await check('rebuilds after store.update and keeps the pose', async () => {
    await place(spots.aisle);
    await page.evaluate(() => {
      window.builtBefore = window.walk._built;
      const { addWall } = window.testModel;
      window.store.update((d) => addWall(d, { x: 4, y: 6.3 }, { x: 4, y: 7.8 }, { kind: 'interior' }), { label: 'Add wall' });
    });
    await wait(150);
    const early = await page.evaluate(() => window.walk._built === window.builtBefore);
    await wait(500);
    await idle();
    const rebuilt = await page.evaluate(() => window.walk._built !== window.builtBefore);
    const kept = await pose();
    await walk('w');
    await idle();
    const p = await pose();
    const limit = 4 - 0.0635 - 0.25;
    assert(early, 'rebuilt before the debounce delay');
    assert(rebuilt, 'scene was not rebuilt');
    assert(near(kept.x, spots.aisle.x, 1e-6), 'pose changed on rebuild');
    assert(p.x <= limit + 0.002 && p.x > limit - 0.05, `stopped at x ${p.x.toFixed(3)} (new wall limit ${limit.toFixed(3)})`);
    await shot('12-new-wall');
    await page.evaluate(() => window.store.undo());
    await wait(700);
    await idle();
    await walk('w', { done: (p) => p.x > limit + 0.5 });
    await idle();
    const q = await pose();
    assert(q.x > limit + 0.3, `still blocked at x ${q.x.toFixed(3)} after undo`);
    return `blocked at x ${p.x.toFixed(3)}, free again after undo`;
  });

  await check('rebuilds do not leak GPU resources', async () => {
    const mem = () => page.evaluate(() => ({ ...window.walk.renderer.info.memory }));
    await page.evaluate(() => window.walk.rebuild());
    await wait(300);
    await idle();
    const a = await mem();
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.walk.rebuild());
      await wait(300);
      await idle();
    }
    const b = await mem();
    assert(b.geometries <= a.geometries && b.textures <= a.textures, `geometries ${a.geometries} -> ${b.geometries}, textures ${a.textures} -> ${b.textures}`);
    return `geometries ${b.geometries}, textures ${b.textures}`;
  });

  await check('screenshot() returns a PNG', async () => {
    await page.keyboard.press('1');
    await idle();
    const info = await page.evaluate(async () => {
      const blob = await window.walk.screenshot();
      const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { type: blob.type, size: blob.size, magic: [...head.slice(1, 4)].map((c) => String.fromCharCode(c)).join(''), data: btoa(s) };
    });
    assert(info.type === 'image/png' && info.magic === 'PNG', `type ${info.type}`);
    assert(info.size > 30000, `only ${info.size} bytes`);
    await writeFile(join(shots, '13-screenshot-api.png'), Buffer.from(info.data, 'base64'));
    return `${Math.round(info.size / 1024)} KB PNG`;
  });

  await check('minimap click goes there', async () => {
    const target = spots.lobby;
    const pt = await page.evaluate(({ x, y }) => {
      const m = window.walk._mini;
      const r = m.el.getBoundingClientRect();
      return { x: r.left + m.view.ox + x * m.view.scale, y: r.top + m.view.oy + y * m.view.scale, shown: m.shown };
    }, target);
    assert(pt.shown, 'minimap is not shown');
    await page.mouse.click(pt.x, pt.y);
    await wait(200);
    await idle();
    const p = await pose();
    const active = await page.evaluate(() => document.activeElement === window.walk.container);
    assert(Math.hypot(p.x - target.x, p.y - target.y) < 0.12, `ended at ${fmt(p)}`);
    assert(active, 'minimap click moved keyboard focus away from the walkthrough');
    await shot('14-minimap-teleport');
    return `arrived at ${fmt(p)}`;
  });

  await check('keys typed elsewhere do not move the walker', async () => {
    await place(spots.aisle);
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'probe';
      Object.assign(input.style, { position: 'fixed', right: '16px', bottom: '16px', zIndex: 10 });
      document.body.append(input);
      input.focus();
    });
    await hold('w', 600);
    await page.keyboard.type('wasd');
    await focus();
    await page.keyboard.down('Alt');
    await hold('w', 400);
    await page.keyboard.up('Alt');
    await idle();
    const p = await pose();
    const typed = await page.evaluate(() => document.getElementById('probe').value);
    await page.evaluate(() => document.getElementById('probe').remove());
    assert(near(p.x, spots.aisle.x, 1e-6) && near(p.y, spots.aisle.y, 1e-6), `moved to ${fmt(p)}`);
    assert(typed.startsWith('w'), `input received "${typed}"`);
    return 'input kept its keys, Alt+W ignored';
  });

  await check('wheel adjusts the field of view within limits', async () => {
    const vp = page.viewportSize();
    const fovOf = () => page.evaluate(() => window.walk._fovTarget);
    await page.mouse.move(vp.width / 2, vp.height / 2);
    for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 400);
    const wide = await fovOf();
    for (let i = 0; i < 16; i++) await page.mouse.wheel(0, -400);
    const narrow = await fovOf();
    await idle();
    await shot('15-zoomed');
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 80);
    while (await fovOf() < 69.5) await page.mouse.wheel(0, 40);
    await page.evaluate(() => { window.walk._fovTarget = 70; });
    await idle();
    assert(wide === 80 && narrow === 35, `fov range ${narrow} to ${wide}`);
    return `fov ${narrow} to ${wide}`;
  });

  await check('slow frames lower the motion pixel ratio only', async () => {
    const r = await page.evaluate(() => ({ base: window.walk._baseRatio, motion: window.walk._motionRatio, now: window.walk.renderer.getPixelRatio() }));
    assert(r.now === r.base, `idle pixel ratio ${r.now}, base ${r.base}`);
    return `base ${r.base}, motion ${r.motion}`;
  });

  await check('each quality level renders without errors', async () => {
    await place(spots.aisle);
    await idle();
    const levels = {};
    for (const q of ['high', 'balanced', 'fast']) {
      const r = await page.evaluate(async (level) => {
        const T = await import('three');
        const w = window.walk, r = w.renderer, gl = r.getContext();
        const events = [];
        const on = (e) => events.push(e.detail);
        w.addEventListener('quality', on);
        w.setQuality(level);
        w.removeEventListener('quality', on);
        while (gl.getError() !== gl.NO_ERROR);
        const f0 = r.info.render.frame;
        w._render();
        const frames = r.info.render.frame - f0;
        const glError = gl.getError();
        const calls = r.info.render.calls;
        // A frame of one flat color means a pass broke; sample a grid of pixels.
        const w0 = gl.drawingBufferWidth, h0 = gl.drawingBufferHeight, px = new Uint8Array(4);
        const lum = [];
        for (let i = 1; i < 8; i++) for (let j = 1; j < 6; j++) {
          gl.readPixels(Math.floor((w0 * i) / 8), Math.floor((h0 * j) / 6), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          lum.push(0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]);
        }
        // Cost of a frame, waiting for the GPU (relative between levels; software rendering is slow).
        const t0 = performance.now();
        for (let k = 0; k < 2; k++) {
          w._render();
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        }
        const ms = (performance.now() - t0) / 2;
        // The saved image is the post-processed one.
        const blob = await w.screenshot();
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(64, 40);
        const ctx = c.getContext('2d');
        ctx.drawImage(bmp, 0, 0, 64, 40);
        const shot = Array.from(ctx.getImageData(0, 0, 64, 40).data.filter((_, i) => i % 4 === 1));
        const p = w._postfx.passes;
        return {
          quality: w.quality, chosen: w.chosenQuality, events, frames, glError, calls, ms: Math.round(ms), shot,
          mean: lum.reduce((a, b) => a + b, 0) / lum.length, spread: Math.max(...lum) - Math.min(...lum),
          // AgX in OutputPass; 'fast' calls the graded curve (InteriorGradeToneMapping) in its own output pass.
          agx: r.toneMapping === T.AgXToneMapping && T.ShaderChunk.tonemapping_pars_fragment.includes('InteriorGradeToneMapping'),
          passes: p ? p.composer.passes.filter((x) => x.enabled).map((x) => x.constructor.name) : null,
          aoScale: p ? p.ao.resolutionScale : null, aoSamples: p ? p.ao.gtaoMaterial.defines.SAMPLES : null,
        };
      }, q);
      await idle();
      await shot(`21-quality-${q}`);
      levels[q] = r;
      assert(r.quality === q && r.chosen === q, `${q}: quality ${r.quality}, chosen ${r.chosen}`);
      assert(r.events.every((e) => e.quality === q && e.chosen === q && e.auto === false), `${q}: events ${JSON.stringify(r.events)}`);
      assert(r.glError === 0, `${q}: GL error ${r.glError}`);
      assert(r.agx, `${q}: renderer is not using the graded AgX tone mapping`);
      assert(r.spread > 40 && r.mean > 60 && r.mean < 235, `${q}: frame looks blank (mean ${r.mean.toFixed(0)}, spread ${r.spread.toFixed(0)})`);
    }
    const { high, balanced, fast } = levels;
    const passes = (l) => (l.passes || []).join(' ');
    assert(passes(high) === 'MultisampleRenderPass InteriorAOPass UnrealBloomPass ShaderPass OutputPass SMAAPass', `high passes: ${passes(high)}`);
    assert(passes(balanced) === 'MultisampleRenderPass InteriorAOPass ShaderPass OutputPass SMAAPass', `balanced passes: ${passes(balanced)}`);
    assert(balanced.aoScale <= high.aoScale / 2 && balanced.aoSamples < high.aoSamples, `balanced AO scale ${balanced.aoScale}, samples ${balanced.aoSamples}`);
    // 'fast' still draws the scene into the linear target (so glass blends as at the other levels), then one output pass.
    assert(passes(fast) === 'MultisampleRenderPass GradedOutputPass' && fast.frames <= 3, `fast drew ${fast.frames} renders through ${passes(fast)}`);
    // Every level shares one tone curve, so they differ only by AO, bloom and edge quality.
    const diff = high.shot.reduce((sum, v, i) => sum + Math.abs(v - fast.shot[i]), 0) / high.shot.length;
    const tone = Math.abs(high.mean - fast.mean);
    assert(diff > 1, `screenshot() at high matches fast (mean difference ${diff.toFixed(1)}), so it is not post-processed`);
    assert(tone < 12, `high and fast differ in brightness by ${tone.toFixed(1)} levels`);
    await page.evaluate(() => window.walk.setQuality('high'));
    await idle();
    return `high ${high.ms} ms (${high.calls} draws), balanced ${balanced.ms} ms (${balanced.calls}), fast ${fast.ms} ms (${fast.calls}); screenshots differ by ${diff.toFixed(1)}, brightness by ${tone.toFixed(1)}`;
  });

  await check('slow frames step the quality down, never above the chosen level', async () => {
    const r = await page.evaluate(() => {
      const w = window.walk, seen = [];
      w.setQuality('high');
      const on = (e) => seen.push(`${e.detail.quality}:${e.detail.auto}`);
      w.addEventListener('quality', on);
      for (let i = 0; i < 60; i++) w._governor(120);
      const fromHigh = { quality: w.quality, chosen: w.chosenQuality, motion: w._motionRatio };
      w.setQuality('balanced');
      for (let i = 0; i < 60; i++) w._governor(120);
      const fromBalanced = { quality: w.quality, chosen: w.chosenQuality };
      for (let i = 0; i < 60; i++) w._governor(8);
      const afterFast = w.quality;
      w.removeEventListener('quality', on);
      w.setQuality('high');
      return { seen, fromHigh, fromBalanced, afterFast, base: w._baseRatio, motion: w._motionRatio };
    });
    assert(r.seen.join() === 'balanced:true,fast:true,balanced:false,fast:true', `quality events ${r.seen.join()}`);
    assert(r.fromHigh.quality === 'fast' && r.fromHigh.chosen === 'high', `from high: ${JSON.stringify(r.fromHigh)}`);
    assert(r.fromHigh.motion < r.base, `motion pixel ratio stayed at ${r.fromHigh.motion} once at fast`);
    assert(r.fromBalanced.quality === 'fast' && r.fromBalanced.chosen === 'balanced', `from balanced: ${JSON.stringify(r.fromBalanced)}`);
    assert(r.afterFast === 'fast', `fast frames raised the quality to ${r.afterFast}`);
    assert(r.motion === r.base, `choosing a level left the motion pixel ratio at ${r.motion}`);
    await idle();
    return `high to balanced to fast, then motion ratio ${r.fromHigh.motion}; a fresh choice resets it`;
  });

  await check('renderContext and the environment capture', async () => {
    const r = await page.evaluate(async () => {
      const builder = await import('../src/builder3d.js');
      const w = window.walk, c = w.renderContext, p = w.pose;
      const out = {
        renderer: c.renderer === w.renderer, scene: c.scene === w._scene, built: c.built === w._built,
        camera: c.camera.isPerspectiveCamera && Math.abs(c.camera.position.x - p.x) < 1e-6 && Math.abs(c.camera.position.z - p.y) < 1e-6,
        // The walk target and walker are UI in the walkthrough's overlay scene, never in the rendered scene.
        overlays: w._overlay.children.filter((o) => o.userData.overlay).length,
        inScene: [w._ring, w._figure].filter((o) => o.parent === c.scene).length,
        capture: typeof builder.captureEnvironment === 'function',
      };
      const before = w._envCapture;
      w.rebuild();
      out.env = !!w._scene.environment;
      out.usesCapture = out.capture ? w._envCapture !== before && w._scene.environment === w._envCapture?.texture : w._envCapture === null;
      return out;
    });
    await idle();
    assert(r.renderer && r.scene && r.built && r.camera, `renderContext ${JSON.stringify(r)}`);
    assert(r.overlays === 2 && r.inScene === 0, `${r.overlays} overlay objects marked, ${r.inScene} in the scene`);
    assert(r.env && r.usesCapture, `environment ${JSON.stringify(r)}`);
    return r.capture ? 'captureEnvironment result assigned and replaced on rebuild' : 'builder has no captureEnvironment yet; the room environment stays';
  });

  await check('resizing keeps the post-processing buffers in step with the canvas', async () => {
    const size = page.viewportSize();
    const measure = () => page.evaluate(() => {
      const w = window.walk, p = w._postfx.passes, c = w.renderer.domElement;
      return { canvas: [c.width, c.height], scene: [p.composer.renderTarget1.width, p.composer.renderTarget1.height], ao: [p.ao.width, p.ao.height], scale: p.ao.resolutionScale };
    });
    // Software rendering can hold back the resize observer for seconds, so wait for the new size.
    const resizeTo = async (vp) => {
      await page.setViewportSize(vp);
      await page.waitForFunction(({ width, height }) => {
        const w = window.walk;
        return w._size.w === width && w._size.h === height && !w._raf;
      }, vp, { timeout: 60000 });
      await idle();
      return measure();
    };
    const a = await resizeTo({ width: 640, height: 400 });
    const b = await resizeTo(size);
    for (const m of [a, b]) {
      assert(m.scene[0] === m.canvas[0] && m.scene[1] === m.canvas[1], `scene buffer ${m.scene} for canvas ${m.canvas}`);
      assert(Math.abs(m.ao[0] - Math.round(m.canvas[0] * m.scale)) <= 1, `AO buffer ${m.ao} at scale ${m.scale} for canvas ${m.canvas}`);
    }
    return `${a.canvas.join('x')} and back to ${b.canvas.join('x')}`;
  });

  await check('touch: tap walks, drag looks', async () => {
    const touch = await openPage({ hasTouch: true });
    const vp = touch.viewportSize();
    await touch.evaluate((p) => window.walk.goTo(p, { animate: false }), spots.aisle);
    await touch.touchscreen.tap(vp.width / 2, vp.height * 0.7);
    await touch.waitForTimeout(500);
    await touch.waitForFunction(() => !window.walk._glide, null, { timeout: 40000 });
    const p = await touch.evaluate(() => window.walk.pose);
    const cdp = await touch.context().newCDPSession(touch);
    const tp = (x, y) => [{ x, y, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(vp.width / 2, vp.height / 2) });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(vp.width / 2 - i * 25, vp.height / 2) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await touch.waitForTimeout(300);
    await touch.waitForFunction(() => !window.walk._raf && !window.walk._inertia, null, { timeout: 40000 });
    const q = await touch.evaluate(() => window.walk.pose);
    const cx = vp.width / 2, cy = vp.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 40, y: cy, id: 1 }, { x: cx + 40, y: cy, id: 2 }] });
    for (let i = 1; i <= 6; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 40 - i * 10, y: cy, id: 1 }, { x: cx + 40 + i * 10, y: cy, id: 2 }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await touch.waitForTimeout(300);
    const pinch = await touch.evaluate(() => ({ fov: window.walk._fovTarget, pose: window.walk.pose, glide: !!window.walk._glide }));
    await touch.context().close();
    assert(p.x - spots.aisle.x > 3, `tap moved only ${(p.x - spots.aisle.x).toFixed(2)} m`);
    assert(q.yaw > p.yaw + 5, `touch drag left should turn right: yaw ${p.yaw.toFixed(1)} -> ${q.yaw.toFixed(1)}`);
    assert(pinch.fov < 45, `pinch out left the field of view at ${pinch.fov.toFixed(1)}`);
    assert(!pinch.glide && near(pinch.pose.yaw, q.yaw, 0.01) && near(pinch.pose.x, q.x, 1e-6), 'pinch also walked or turned');
    return `tap walked ${(p.x - spots.aisle.x).toFixed(2)} m, drag turned ${(q.yaw - p.yaw).toFixed(1)} degrees, pinch set fov ${pinch.fov.toFixed(0)}`;
  });

  await check('start pose without saved cameras', async () => {
    const cameras = await page.evaluate(async () => {
      const plan = JSON.parse(JSON.stringify(window.store.plan));
      plan.cameras = [];
      window.store.replace(plan);
      await new Promise((res) => setTimeout(res, 350));
      return window.store.plan.cameras.length;
    });
    await idle();
    const p = await pose();
    const inside = await page.evaluate(async (q) => {
      const { pointInPolygon } = await import('../src/geometry.js');
      const rooms = window.store.plan.rooms;
      const biggest = rooms.find((rm) => rm.name === 'Open office');
      return pointInPolygon(q, biggest.points);
    }, p);
    const free = await page.evaluate((q) => window.walk._world && !window.walk._world.query(q.x - 1, q.y - 1, q.x + 1, q.y + 1, []).some((e) => {
      if (!e.seg) return false;
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, l2 = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, ((q.x - e.a.x) * dx + (q.y - e.a.y) * dy) / l2));
      return Math.hypot(q.x - (e.a.x + dx * t), q.y - (e.a.y + dy * t)) < e.r + 0.25;
    }), p);
    assert(cameras === 0, 'plan still has cameras');
    assert(inside, `start ${fmt(p)} is not in the largest room`);
    assert(free, `start ${fmt(p)} touches a wall`);
    assert(p.yaw === 90 || p.yaw === 270, `faces ${p.yaw}, not along the long axis`);
    await shot('18-no-cameras-start');
    return `started at ${fmt(p)}`;
  });

  await check('empty plan and plan replacement', async () => {
    await page.evaluate(async () => {
      window.store.replace(window.testModel.createPlan());
      await new Promise((res) => setTimeout(res, 350));
    });
    await idle();
    const empty = await page.evaluate(() => ({ pose: window.walk.pose, mini: window.walk._mini.shown }));
    await page.evaluate(() => window.walk.setMode('overview'));
    await idle();
    await page.evaluate(() => window.walk.setMode('walk'));
    await idle();
    await page.evaluate(async () => {
      window.store.replace(window.testPlanFor(window.testModel));
      await new Promise((res) => setTimeout(res, 350));
    });
    await idle();
    const back = await pose();
    const cam = await page.evaluate(() => window.store.plan.cameras[0]);
    assert(!empty.mini, 'minimap shown for an empty plan');
    assert(near(back.x, cam.x, 0.01) && near(back.y, cam.y, 0.01), `replaced plan started at ${fmt(back)}`);
    return `empty plan at ${fmt(empty.pose)}, replacement reset to the first camera`;
  });

  await check('a plan that cannot be built shows a message, then recovers', async () => {
    const logged = errors.length;
    const failed = await page.evaluate(async () => {
      const w = window.walk, kit = w._kit.kit, floorMaterial = kit.floorMaterial;
      kit.floorMaterial = () => { throw new Error('Test failure in the floors.'); };
      try {
        w.rebuild();
      } finally {
        kit.floorMaterial = floorMaterial;
      }
      const box = w._failure?.getBoundingClientRect();
      return {
        built: !!w._built, text: w._failure?.textContent || '', role: w._failure?.getAttribute('role'),
        covers: !!box && box.width === w.container.clientWidth && box.height === w.container.clientHeight,
        minimap: w._mini.shown, colliders: w._world.query(-100, -100, 100, 100, []).length,
        screenshot: await w.screenshot().then(() => 'saved', (e) => e.message),
      };
    });
    await wait(300);
    await shot('20-build-failed');
    const expected = errors.splice(logged).filter((e) => !/Could not build the 3D view/.test(e));
    errors.push(...expected);
    const recovered = await page.evaluate(() => {
      const w = window.walk;
      w.rebuild();
      return { built: !!w._built, message: !!w._failure, minimap: w._mini.shown };
    });
    await idle();
    assert(!failed.built && failed.colliders === 0, 'the previous scene stayed in place');
    assert(failed.text.startsWith('This plan could not be shown in 3D') && failed.text.includes('Test failure in the floors.'), `message "${failed.text}"`);
    assert(failed.covers && failed.role === 'alert' && !failed.minimap, `message covers the view ${failed.covers}, role ${failed.role}, minimap ${failed.minimap}`);
    assert(/could not be shown in 3D/.test(failed.screenshot), `screenshot() gave "${failed.screenshot}"`);
    assert(recovered.built && !recovered.message && recovered.minimap, `after a good rebuild ${JSON.stringify(recovered)}`);
    return 'old scene cleared, message shown, recovered on the next build';
  });

  await check('reduced motion makes camera moves instant', async () => {
    const rm = await openPage({ reducedMotion: 'reduce' });
    const r = await rm.evaluate(() => {
      const w = window.walk, cams = window.store.plan.cameras;
      w.goToCamera(cams[1].id);
      const a = w.pose;
      w.setMode('overview');
      const tween = !!w._tween;
      w.setMode('walk');
      return { a, cam: cams[1], tween, anim: !!w._anim };
    });
    await rm.context().close();
    assert(near(r.a.x, r.cam.x, 0.02) && near(r.a.y, r.cam.y, 0.02) && !r.anim, `pose ${fmt(r.a)} right after goToCamera`);
    assert(!r.tween, 'mode change animated');
    return 'goToCamera and mode switches are instant';
  });

  await check('dispose releases the walkthrough', async () => {
    const r = await page.evaluate(() => {
      const w = window.walk;
      const c = w.container;
      w.dispose();
      return { children: c.children.length, lost: w.renderer.getContext().isContextLost() };
    });
    assert(r.children === 0 && r.lost, `children ${r.children}, context lost ${r.lost}`);
    return 'canvas, overlays and GL context released';
  });

  await check('samples load', async () => {
    const sample = await browser.newPage({ viewport: { width: 800, height: 500 } });
    sample.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    sample.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    await sample.goto(`${pageUrl}?sample=lab-suite`, { waitUntil: 'load' });
    await sample.waitForFunction(() => window.testReady === true, null, { timeout: 60000 });
    const settled = () => sample.waitForFunction(() => !window.walk._raf && !window.walk._tween, null, { timeout: 90000 });
    await settled();
    await sample.screenshot({ path: join(shots, '16-sample-start.png'), timeout: 90000 });
    const p = await sample.evaluate(() => window.walk.pose);
    await sample.evaluate(() => window.walk.setMode('overview'));
    await sample.waitForTimeout(500);
    await settled();
    await sample.screenshot({ path: join(shots, '17-sample-overview.png'), timeout: 90000 });
    await sample.close();
    return `lab suite start ${fmt(p)}`;
  });

  await check('no console errors', async () => {
    assert(!errors.length, errors.join('\n'));
    return 'clean';
  });

  await browser.close();
  server?.kill();
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
  }
  console.log(`\n${results.length - failed} of ${results.length} checks passed. Screenshots in ${shots}`);
  process.exit(failed ? 1 : 0);
}

if (typeof window === 'undefined') await runChecks();
else await mountPage();
