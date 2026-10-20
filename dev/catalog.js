// Developer preview: renders every item of one catalog category in 3D and as plan symbols.
// Open /dev/catalog.html?category=lab (or medical, office, retail, general; add &view=top).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createKit } from '../src/kit3d.js';
import { listItems } from '../src/catalog/registry.js';

const params = new URLSearchParams(location.search);
const category = params.get('category') || 'lab';
const view = params.get('view') || 'front';
const FILES = { lab: 'lab', medical: 'medical', office: 'office', general: 'office', retail: 'retail' };
document.getElementById('title').textContent = category;

const THEME = { line: '#435254', fill: '#ffffff', accent: '#003f2d', muted: '#7f8480', light: '#cad1d3', glass: '#80bbad' };

try {
  await import(`../src/catalog/${FILES[category] || category}.js`);
  const items = listItems(category);
  if (!items.length) throw new Error(`No items registered for category "${category}"`);

  // ---- 3D grid ----
  const canvas = document.getElementById('stage');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#e9eef1');
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture;
  const sun = new THREE.DirectionalLight('#fff4e5', 2.2);
  sun.position.set(6, 12, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20 });
  scene.add(sun, new THREE.HemisphereLight('#ffffff', '#b9b2a6', 0.4));

  const kit = createKit();
  const cols = Math.ceil(Math.sqrt(items.length * 1.6));
  const cell = Math.max(...items.map((d) => Math.max(d.w, d.d))) + 0.8;
  items.forEach((def, i) => {
    const obj = def.build(kit, { w: def.w, d: def.d, h: def.h });
    obj.position.set((i % cols) * cell, 0, Math.floor(i / cols) * cell);
    scene.add(obj);
    // Footprint outline to check the model stays inside w x d.
    const fp = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(def.w, 0.001, def.d)),
      new THREE.LineBasicMaterial({ color: '#17e88f' }),
    );
    fp.position.copy(obj.position);
    scene.add(fp);
  });
  const rows = Math.ceil(items.length / cols);
  const cx = ((cols - 1) * cell) / 2, cz = ((rows - 1) * cell) / 2;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(cols * cell + 4, rows * cell + 4), new THREE.MeshStandardMaterial({ color: '#d9dcd8' }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, -0.001, cz);
  floor.receiveShadow = true;
  scene.add(floor);
  sun.target.position.set(cx, 0, cz);
  scene.add(sun.target);

  const camera = new THREE.PerspectiveCamera(40, canvas.clientWidth / canvas.clientHeight, 0.05, 200);
  const span = Math.max(cols, rows) * cell;
  if (view === 'top') camera.position.set(cx, span * 1.25, cz + 0.01);
  else camera.position.set(cx, span * 0.55, cz + span * 0.95);
  camera.lookAt(cx, 0.4, cz);
  renderer.render(scene, camera);

  // ---- 2D plan symbols ----
  const plan = document.getElementById('plan');
  const dpr = window.devicePixelRatio || 1;
  const pxPerM = 90;
  const pcols = Math.min(items.length, 6);
  const pcell = 160;
  const prow = Math.max(...items.map((d) => d.d * pxPerM)) + 60;
  plan.style.height = `${Math.ceil(items.length / pcols) * prow + 20}px`;
  plan.width = plan.clientWidth * dpr;
  plan.height = plan.clientHeight * dpr;
  const ctx = plan.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.font = '12px system-ui';
  items.forEach((def, i) => {
    const x = 20 + (i % pcols) * Math.max(pcell, (plan.clientWidth - 40) / pcols) + 70;
    const y = 20 + Math.floor(i / pcols) * prow + prow / 2 - 10;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(pxPerM, pxPerM);
    ctx.fillStyle = THEME.fill;
    ctx.fillRect(-def.w / 2, -def.d / 2, def.w, def.d);
    def.draw2d(ctx, { w: def.w, d: def.d, h: def.h, px: 1 / pxPerM, theme: THEME });
    ctx.restore();
    ctx.fillStyle = '#435254';
    ctx.textAlign = 'center';
    ctx.fillText(def.name, x, y + (def.d * pxPerM) / 2 + 16);
  });
  window.previewReady = true;
  window.previewItems = items.map((d) => d.type);
} catch (err) {
  document.getElementById('err').textContent = err.stack || String(err);
  window.previewError = String(err);
  window.previewReady = true;
}
