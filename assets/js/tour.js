// Interactive 3D walkthrough. Mounts into every [data-tour] element on the page and only
// loads Three.js once the tour is about to scroll into view.
const EASE = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

function fail(root, message) {
  root.classList.add('is-failed');
  const status = root.querySelector('.tour__status p');
  if (status) status.textContent = message;
}

async function start(root) {
  const stage = root.querySelector('.tour__stage');
  if (!webglAvailable()) {
    fail(root, 'Your browser does not support WebGL, so the interactive tour is unavailable. The preview image shows the finished lab.');
    return;
  }

  let THREE, OrbitControls, createLab, VIEWS;
  try {
    [THREE, { OrbitControls }, { createLab, VIEWS }] = await Promise.all([
      import('three'),
      import('three/addons/controls/OrbitControls.js'),
      import('./lab-scene.js'),
    ]);
  } catch (err) {
    console.error(err);
    fail(root, 'The tour could not be loaded. Please refresh the page to try again.');
    return;
  }

  const params = new URLSearchParams(location.search);
  let mode = params.get('mode') || root.dataset.mode || 'lab';
  let view = params.get('view') || root.dataset.view || 'entry';

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', 'Interactive 3D model of a lab suite. Drag to look around.');
  canvas.setAttribute('role', 'img');
  stage.prepend(canvas);

  const lab = createLab({ canvas });
  const { camera } = lab;
  const controls = new OrbitControls(camera, canvas);
  // First-person feel: orbit around a point just in front of the camera and invert the drag.
  Object.assign(controls, {
    enableDamping: true,
    dampingFactor: 0.09,
    enablePan: false,
    enableZoom: false,
    rotateSpeed: -0.32,
    minPolarAngle: Math.PI * 0.28,
    maxPolarAngle: Math.PI * 0.68,
  });

  let needsRender = true;
  let flight = null;
  const tmpDir = new THREE.Vector3();

  function lookFrom(pos, lookAt) {
    camera.position.copy(pos);
    tmpDir.subVectors(lookAt, pos).normalize().multiplyScalar(0.1);
    controls.target.copy(pos).add(tmpDir);
    controls.update();
    needsRender = true;
  }

  function goTo(name, animate = true) {
    const v = VIEWS[name];
    if (!v) return;
    view = name;
    const toPos = new THREE.Vector3(...v.pos);
    const toLook = new THREE.Vector3(...v.target);
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      flight = null;
      lookFrom(toPos, toLook);
    } else {
      const fromPos = camera.position.clone();
      const fromLook = controls.target.clone().sub(fromPos).normalize().multiplyScalar(toPos.distanceTo(toLook)).add(fromPos);
      flight = { t0: performance.now(), ms: 1100, fromPos, toPos, fromLook, toLook };
    }
    root.querySelectorAll('[data-tour-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tourView === name)));
  }

  function setMode(next) {
    mode = next;
    lab.setMode(next);
    needsRender = true;
    root.querySelectorAll('[data-tour-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tourMode === next)));
  }

  root.querySelectorAll('[data-tour-view]').forEach((b) => b.addEventListener('click', () => goTo(b.dataset.tourView)));
  root.querySelectorAll('[data-tour-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.tourMode)));

  const fsBtn = root.querySelector('[data-tour-fullscreen]');
  if (fsBtn) {
    if (!stage.requestFullscreen) fsBtn.hidden = true;
    fsBtn.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else stage.requestFullscreen().catch(() => {});
    });
  }

  // Wheel and pinch adjust the field of view, which reads as zoom without leaving the viewpoint.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    camera.fov = THREE.MathUtils.clamp(camera.fov + e.deltaY * 0.03, 32, 75);
    camera.updateProjectionMatrix();
    needsRender = true;
  }, { passive: false });

  const markInteracted = () => root.classList.add('has-interacted');
  canvas.addEventListener('pointerdown', markInteracted, { once: true });
  controls.addEventListener('change', () => { needsRender = true; });

  const resize = () => {
    const { width, height } = stage.getBoundingClientRect();
    if (!width || !height) return;
    lab.resize(width, height);
    needsRender = true;
  };
  new ResizeObserver(resize).observe(stage);
  resize();

  let visible = true;
  new IntersectionObserver((entries) => { visible = entries[0].isIntersecting; }).observe(stage);

  setMode(mode);
  camera.fov = 62;
  goTo(view, false);

  function frame(now) {
    requestAnimationFrame(frame);
    if (!visible || document.hidden) return;
    if (flight) {
      const k = Math.min(1, (now - flight.t0) / flight.ms);
      const e = EASE(k);
      const p = flight.fromPos.clone().lerp(flight.toPos, e);
      const l = flight.fromLook.clone().lerp(flight.toLook, e);
      lookFrom(p, l);
      if (k === 1) flight = null;
    } else {
      controls.update();
    }
    if (needsRender) {
      needsRender = false;
      lab.render();
      if (!root.classList.contains('is-ready')) root.classList.add('is-ready');
    }
  }
  requestAnimationFrame(frame);
}

document.querySelectorAll('[data-tour]').forEach((root) => {
  if (!('IntersectionObserver' in window)) return start(root);
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    start(root);
  }, { rootMargin: '400px 0px' });
  io.observe(root);
});
