// CBRE Virtual Walkthrough app shell: wires the plan store, the 2D editor, the 3D walkthrough
// and the panels, dialogs, files and shortcuts into one page.
import { PlanStore, createPlan, addCamera } from './model.js';
import './catalog/index.js';
import { PlanEditor } from './editor2d.js';
import { formatLength, clamp } from './geometry.js';
import { $, $$, h, isMac, isTextField, MOD, downloadBlob, pickFiles } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { setupTooltips, toast, attachMenu, openDialog } from './ui/widgets.js';
import { loadSavedPlan, autosave, loadPrefs, setPref } from './ui/storage.js';
import { createTools } from './ui/tools.js';
import { createLibrary, ITEM_MIME } from './ui/library.js';
import { createProperties } from './ui/properties.js';
import { createStatusBar } from './ui/statusbar.js';
import { createWalkUI, WALK_STATUS } from './ui/walkui.js';
import { openStartDialog, askCalibration, openSettings, openHelp, loadSample } from './ui/dialogs.js';
import {
  readPlanFile, readImageFile, underlayFor, savePlanFile, renderPlanImage, imageFileName,
  fileKind, FileError, IMAGE_ACCEPT, PLAN_ACCEPT,
} from './ui/files.js';

const MODES = ['plan', 'split', 'walk'];
const DISPLAY_DEFAULTS = { showGrid: true, showLabels: true, showDimensions: false };
const STACK_BELOW = 760;

// ---- Boot -------------------------------------------------------------------------------------

for (const el of $$('[data-icon]')) el.innerHTML = icon(el.dataset.icon);
if (isMac) for (const el of $$('[data-key]')) el.dataset.key = el.dataset.key.replace(/\bCtrl\b/g, MOD);
setupTooltips();

const prefs = loadPrefs();
const saved = loadSavedPlan();
const store = new PlanStore(saved ? saved.plan : createPlan());
const canvas = $('#plan-canvas');
const editor = new PlanEditor(canvas, store);
const display = { ...DISPLAY_DEFAULTS, ...(prefs.display || {}) };
editor.setOptions(display);

const status = createStatusBar($('#statusbar'), { store, editor });
const tools = createTools($('#tools'), { store, editor, prefs });
createLibrary($('#library'), {
  store, editor, prefs,
  onPick: () => tools.sync(),
  onDragStart: (def) => beginItemDrag(def.type),
  onDragEnd: (def, dropped) => endItemDrag(dropped),
});
const walkUI = createWalkUI($('#walk-pane'), {
  store, prefs,
  onSaveView: saveCurrentView,
  onModeChange: (m) => status.setWalkHint(WALK_STATUS[m]),
});
status.setWalkHint(WALK_STATUS.walk);

const actions = {
  importImage: () => importImage(),
  calibrate: startCalibration,
  walkToCamera,
  removeImage,
};
const properties = createProperties($('#right-panel'), { store, editor, actions });

autosave(store, {
  onFull: () => toast('This floor plan image is too large to keep in the browser. Save the plan to a file to keep the image with it.', { type: 'info', duration: 9000 }),
});

// ---- Modes and the 3D view ------------------------------------------------------------------------

let mode = 'plan';
let walk = null;
let walkLoading = null;

function ensureWalk() {
  if (walk) return Promise.resolve(walk);
  if (!walkLoading) {
    walkUI.setLoading(true);
    walkLoading = import('./walkthrough.js').then(({ Walkthrough }) => {
      walk = new Walkthrough($('#walk-view'), store, { minimap: true });
      walk.addEventListener('pose', (e) => { if (mode === 'split') editor.setWalker(e.detail); });
      walkUI.attach(walk);
      walkUI.setLoading(false);
      return walk;
    }).catch((err) => {
      walkLoading = null;
      walkUI.setLoading(false);
      console.error(err);
      toast('The 3D view could not start. Check that hardware acceleration is turned on in your browser.', { type: 'error' });
      throw err;
    });
  }
  return walkLoading;
}

async function setMode(next, { focus = true } = {}) {
  if (!MODES.includes(next)) return;
  const prev = mode;
  mode = next;
  document.body.dataset.mode = next;
  for (const b of $$('.modes .seg')) b.setAttribute('aria-pressed', String(b.dataset.mode === next));
  $('#save-image').dataset.tip = next === 'plan' ? 'Save an image of the plan' : 'Save an image of the 3D view';
  setPref(prefs, 'mode', next);
  status.setMode(next);
  updateOverlays();
  layoutStage();
  if (next !== 'walk' && next !== prev) {
    requestAnimationFrame(() => {
      editor.resize();
      editor.zoomToFit();
      status.scheduleZoom();
    });
  }
  if (next === 'plan') {
    walk?.stop();
    editor.setWalker(null);
    if (focus) canvas.focus({ preventScroll: true });
    return;
  }
  let w;
  try {
    w = await ensureWalk();
  } catch {
    return;
  }
  if (mode !== next) return;
  requestAnimationFrame(() => w.resize());
  w.setMinimap(next === 'walk');
  w.start();
  editor.setWalker(next === 'split' ? w.pose : null);
  if (focus) (next === 'walk' ? $('#walk-view') : canvas).focus({ preventScroll: true });
}

for (const b of $$('.modes .seg')) b.addEventListener('click', () => setMode(b.dataset.mode));

editor.addEventListener('teleport', (e) => {
  if (!walk) return;
  const p = walk.pose;
  walk.goTo({ x: e.detail.x, y: e.detail.y, yaw: p.yaw, pitch: p.pitch });
});

async function walkToCamera(id) {
  if (mode === 'plan') await setMode('walk', { focus: false });
  const w = await ensureWalk().catch(() => null);
  if (!w) return;
  w.goToCamera(id);
  walkUI.markActive(id);
  if (mode === 'walk') $('#walk-view').focus({ preventScroll: true });
}

function saveCurrentView() {
  if (!walk) return;
  const p = walk.pose;
  let cam = null;
  store.update((d) => { cam = addCamera(d, p.x, p.y, p.yaw, { pitch: Math.round(p.pitch) }); }, { label: 'Save view' });
  if (cam) {
    walkUI.markActive(cam.id);
    const n = store.plan.cameras.length;
    toast(n <= 9 ? `Saved "${cam.name}". Press ${n} to come back to it.` : `Saved "${cam.name}".`);
  }
}

// ---- Split layout ---------------------------------------------------------------------------------

const stage = $('#stage');
const divider = $('#split-divider');
let split = clamp(Number(prefs.split) || 0.5, 0.2, 0.8);

function layoutStage() {
  const stacked = mode === 'split' && stage.clientWidth < STACK_BELOW;
  stage.classList.toggle('stacked', stacked);
  stage.style.setProperty('--split', String(split));
  divider.setAttribute('aria-orientation', stacked ? 'horizontal' : 'vertical');
  divider.setAttribute('aria-valuenow', String(Math.round(split * 100)));
}

function setSplit(v) {
  split = clamp(v, 0.2, 0.8);
  layoutStage();
  setPref(prefs, 'split', split);
}

divider.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  divider.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
  const r = stage.getBoundingClientRect();
  const stacked = stage.classList.contains('stacked');
  const move = (ev) => setSplit(stacked ? (ev.clientY - r.top) / r.height : (ev.clientX - r.left) / r.width);
  const up = () => {
    document.body.classList.remove('resizing');
    divider.removeEventListener('pointermove', move);
    divider.removeEventListener('pointerup', up);
    divider.removeEventListener('pointercancel', up);
    editor.resize();
    walk?.resize();
  };
  divider.addEventListener('pointermove', move);
  divider.addEventListener('pointerup', up);
  divider.addEventListener('pointercancel', up);
});
divider.addEventListener('dblclick', () => setSplit(0.5));
divider.addEventListener('keydown', (e) => {
  const step = { ArrowLeft: -0.05, ArrowUp: -0.05, ArrowRight: 0.05, ArrowDown: 0.05 }[e.key];
  if (e.key === 'Home') setSplit(0.2);
  else if (e.key === 'End') setSplit(0.8);
  else if (step) setSplit(split + step);
  else return;
  e.preventDefault();
});
new ResizeObserver(layoutStage).observe(stage);

// ---- Top bar ----------------------------------------------------------------------------------------

const nameInput = $('#plan-name');
const syncName = () => { if (document.activeElement !== nameInput) nameInput.value = store.plan.name; };
nameInput.addEventListener('change', () => {
  const v = nameInput.value.trim() || 'Untitled plan';
  if (v !== store.plan.name) store.update((d) => { d.name = v; }, { label: 'Rename plan' });
  nameInput.value = store.plan.name;
});
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
  if (e.key === 'Escape') { nameInput.value = store.plan.name; nameInput.blur(); }
});
store.addEventListener('change', syncName);
syncName();

const undoBtn = $('#undo'), redoBtn = $('#redo');
const syncHistory = () => {
  undoBtn.disabled = !store.canUndo;
  redoBtn.disabled = !store.canRedo;
};
store.addEventListener('history', syncHistory);
syncHistory();
undoBtn.addEventListener('click', () => store.undo());
redoBtn.addEventListener('click', () => store.redo());
store.addEventListener('change', (e) => {
  const d = e.detail || {};
  if (d.undo || d.redo) {
    const what = d.label.replace(/^(Undo|Redo) /, '');
    status.flash(`${d.undo ? 'Undo' : 'Redo'}: ${what.charAt(0).toLowerCase()}${what.slice(1)}`);
  }
});

attachMenu($('#open-menu'), () => [
  { label: 'Open plan file', icon: 'folder', hint: `${MOD}+O`, onSelect: () => openPlanFile() },
  { label: 'Import floor plan image', icon: 'image', description: 'PNG, JPG, WebP or SVG', onSelect: () => importImage() },
  { label: 'Open a sample', icon: 'grid', onSelect: openSamples },
  'separator',
  { label: 'New blank plan', icon: 'file-new', onSelect: newPlan },
], { align: 'end' });
$('#save').addEventListener('click', savePlan);
$('#save-image').addEventListener('click', saveImage);
$('#settings').addEventListener('click', () => openSettings({
  store,
  getDisplay: () => ({ ...display }),
  setDisplay: (patch) => {
    Object.assign(display, patch);
    editor.setOptions(display);
    setPref(prefs, 'display', { ...display });
  },
}));
$('#help').addEventListener('click', openHelp);

// ---- Plan files -------------------------------------------------------------------------------------

/** Replace the document. Keeps an undo step back to the current plan unless it is still blank. */
function replacePlan(plan, label) {
  const keepHistory = planHasContent(store.plan) || !!store.plan.underlay || store.plan.cameras.length > 0;
  store.replace(plan, { label, keepHistory });
  return keepHistory ? { action: { label: 'Undo', onClick: () => store.undo() } } : {};
}

function savePlan() {
  if (isTextField(document.activeElement)) document.activeElement.blur();
  try {
    const name = savePlanFile(store.plan);
    toast(`Plan saved as ${name}`);
  } catch (err) {
    console.error(err);
    toast('The plan could not be saved.', { type: 'error' });
  }
}

async function openPlanFile(file) {
  if (!file) {
    [file] = await pickFiles(PLAN_ACCEPT);
    if (!file) return;
  }
  try {
    const plan = await readPlanFile(file);
    toast(`Opened ${plan.name}`, replacePlan(plan, 'Open plan'));
  } catch (err) {
    toast(err instanceof FileError ? err.message : 'This file could not be opened.', { type: 'error' });
  }
}

function openSamples({ welcome = false } = {}) {
  openStartDialog({
    welcome,
    onSample: openSample,
    onTrace: () => {
      replacePlan(createPlan(), 'New plan');
      importImage();
    },
    onBlank: newPlan,
  });
}

async function openSample(sample) {
  try {
    const plan = await loadSample(sample);
    toast(`Opened the ${sample.name.toLowerCase()} sample`, replacePlan(plan, `Open ${sample.name}`));
  } catch (err) {
    console.error(err);
    toast(`The ${sample.name.toLowerCase()} sample could not be loaded.`, { type: 'error' });
  }
}

function newPlan() {
  const undo = replacePlan(createPlan(), 'New plan');
  if (mode === 'walk') setMode('plan');
  editor.setTool('select');
  toast('New plan. Import a floor plan image or start drawing walls.', { type: 'info', ...undo });
}

async function saveImage() {
  try {
    let blob, name;
    if (mode === 'plan') {
      blob = await renderPlanImage(store.plan, display);
      name = imageFileName(store.plan, 'plan');
    } else {
      const w = await ensureWalk();
      blob = await w.screenshot();
      name = imageFileName(store.plan, '3D view');
    }
    downloadBlob(blob, name);
    toast(`Image saved as ${name}`);
  } catch (err) {
    console.error(err);
    toast(err?.message || 'The image could not be saved.', { type: 'error' });
  }
}

// ---- Floor plan images and calibration -----------------------------------------------------------

let dismissImportHint = null;
const planHasContent = (p) => p.walls.length > 0 || p.rooms.length > 0 || p.items.length > 0;

/** Ask whether a new image starts a new plan or goes under the current one. */
function chooseImageTarget() {
  return new Promise((resolve) => {
    let choice = null;
    const pick = (v) => () => { choice = v; dlg.close(v); };
    const dlg = openDialog({
      title: 'Trace this image in a new plan?',
      subtitle: 'Your current plan already has walls or furniture. You can start fresh, or place the image under the current plan.',
      cls: 'dialog-narrow',
      actions: [
        h('button', { type: 'button', class: 'btn btn-secondary', text: 'Add to this plan', on: { click: pick('current') } }),
        h('button', { type: 'button', class: 'btn btn-primary', text: 'Start a new plan', on: { click: pick('new') } }),
      ],
      onClose: () => resolve(choice),
    });
  });
}

async function importImage(file) {
  if (!file) {
    [file] = await pickFiles(IMAGE_ACCEPT);
    if (!file) return;
  }
  let image;
  try {
    image = await readImageFile(file);
  } catch (err) {
    toast(err instanceof FileError ? err.message : 'This image could not be imported.', { type: 'error' });
    return;
  }
  if (planHasContent(store.plan)) {
    const target = await chooseImageTarget();
    if (!target) return;
    if (target === 'new') replacePlan(createPlan({ name: file.name.replace(/\.[^.]+$/, '') || 'Untitled plan' }), 'New plan');
  } else if (store.plan.name === 'Untitled plan') {
    store.update((d) => { d.name = file.name.replace(/\.[^.]+$/, '') || d.name; }, { label: 'Name plan' });
  }
  store.update((d) => { d.underlay = underlayFor(image); }, { label: 'Import floor plan image' });
  store.select(null);
  if (mode === 'walk') await setMode('plan', { focus: false });
  editor.zoomToFit();
  editor.setTool('calibrate');
  canvas.focus({ preventScroll: true });
  dismissImportHint?.();
  dismissImportHint = toast('Image imported. Click two points of a known distance to set the scale.', { type: 'info', duration: 9000 });
  if (image.resized) toast(`The image was reduced to ${image.width} x ${image.height} px to keep the plan fast.`, { type: 'info' });
}

function startCalibration() {
  if (!store.plan.underlay) {
    toast('Import a floor plan image first, then calibrate its scale.', { type: 'info' });
    return;
  }
  const go = () => {
    store.select(null);
    editor.setTool('calibrate');
    canvas.focus({ preventScroll: true });
  };
  if (mode === 'walk') setMode('plan', { focus: false }).then(go);
  else go();
}

function removeImage() {
  if (!store.plan.underlay) return;
  store.update((d) => { d.underlay = null; }, { label: 'Remove floor plan image' });
  if (editor.tool === 'calibrate') editor.setTool('select');
  toast('Floor plan image removed', { action: { label: 'Undo', onClick: () => store.undo() } });
}

editor.addEventListener('calibrate', async (e) => {
  const { a, b, meters } = e.detail;
  const real = await askCalibration({ meters, units: store.plan.units });
  if (real === null) {
    canvas.focus({ preventScroll: true });
    return;
  }
  if (editor.applyCalibration(a, b, real)) {
    editor.setTool('select');
    canvas.focus({ preventScroll: true });
    const u = store.plan.underlay;
    const units = store.plan.units;
    dismissImportHint?.();
    dismissImportHint = null;
    const next = store.plan.walls.length ? '' : ' Trace the walls next with the Wall tool (W).';
    toast(`Scale set. The image spans ${formatLength(u.width * u.scale, units)} by ${formatLength(u.height * u.scale, units)}.${next}`, { duration: 6000 });
  }
});
$('#coach-cancel').addEventListener('click', () => {
  editor.setTool('select');
  canvas.focus({ preventScroll: true });
});

// ---- Canvas overlays ---------------------------------------------------------------------------------

const coach = $('#coach'), coachStep = $('#coach-step'), emptyState = $('#empty-state');
let editorStatus = '';

function updateOverlays() {
  const plan = store.plan;
  const calibrating = editor.tool === 'calibrate' && !!plan.underlay && mode !== 'walk';
  coach.hidden = !calibrating;
  if (calibrating) coachStep.textContent = editorStatus;
  const blank = !planHasContent(plan) && !plan.underlay && plan.cameras.length === 0;
  emptyState.hidden = !(blank && ['select', 'pan'].includes(editor.tool) && mode !== 'walk');
}

editor.addEventListener('status', (e) => { editorStatus = e.detail.text; updateOverlays(); });
editor.addEventListener('toolchange', updateOverlays);
store.addEventListener('change', updateOverlays);
$('#empty-import').addEventListener('click', () => importImage());
$('#empty-walls').addEventListener('click', () => tools.activate('wall'));
$('#empty-samples').addEventListener('click', () => openSamples());

// ---- Dragging library items onto the plan ------------------------------------------------------------

let drag = null;

function beginItemDrag(type) {
  drag = { type, prevTool: editor.tool === 'item' ? 'select' : editor.tool, dropped: false };
}

function endItemDrag() {
  if (drag && !drag.dropped) {
    editor.setTool(drag.prevTool);
  }
  drag = null;
}

function synth(type, e) {
  canvas.dispatchEvent(new PointerEvent(type, {
    clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, pointerId: 9001, pointerType: 'mouse',
    isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true,
  }));
}

const isItemDrag = (e) => [...(e.dataTransfer?.types || [])].includes(ITEM_MIME);

canvas.addEventListener('dragover', (e) => {
  if (!isItemDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  const type = drag?.type;
  if (type && (editor.tool !== 'item' || editor.pendingItem !== type)) {
    editor.setPendingItem(type);
    tools.sync();
  }
  synth('pointermove', e);
});
canvas.addEventListener('dragleave', (e) => {
  if (isItemDrag(e)) canvas.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 9001, pointerType: 'mouse' }));
});
canvas.addEventListener('drop', (e) => {
  if (!isItemDrag(e)) return;
  e.preventDefault();
  e.stopPropagation();
  const type = e.dataTransfer.getData(ITEM_MIME) || drag?.type;
  if (!type) return;
  if (editor.tool !== 'item' || editor.pendingItem !== type) editor.setPendingItem(type);
  const before = new Set(store.plan.items.map((i) => i.id));
  synth('pointermove', e);
  synth('pointerdown', e);
  synth('pointerup', e);
  const added = store.plan.items.find((i) => !before.has(i.id));
  if (drag) drag.dropped = true;
  editor.setTool('select');
  if (added) store.select({ kind: 'item', id: added.id });
  canvas.focus({ preventScroll: true });
});

// ---- Dropping files on the window ---------------------------------------------------------------------

const dropOverlay = $('#drop-overlay');
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
let dragDepth = 0;

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropOverlay.hidden = true;
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const file = e.dataTransfer.files[0];
  if (file) openFile(file);
});

function openFile(file) {
  const kind = fileKind(file);
  if (kind === 'plan') openPlanFile(file);
  else if (kind === 'image' || kind === 'pdf') importImage(file);
  else toast(`"${file.name}" is not a floor plan image or a plan file.`, { type: 'error' });
}

// ---- Keyboard shortcuts ----------------------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.isComposing) return;
  const mod = e.ctrlKey || e.metaKey;
  if (document.querySelector('dialog[open]')) {
    if (mod && /^[so]$/i.test(e.key)) e.preventDefault();
    return;
  }
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const typing = isTextField(e.target);
  if (mod && !e.altKey) {
    if (key === 's') { e.preventDefault(); savePlan(); return; }
    if (key === 'o') { e.preventDefault(); openPlanFile(); return; }
    if (typing) return;
    if (key === 'z') { e.preventDefault(); if (e.shiftKey) store.redo(); else store.undo(); return; }
    if (key === 'y' && e.ctrlKey) { e.preventDefault(); store.redo(); return; }
    const m = { 1: 'plan', 2: 'split', 3: 'walk' }[e.key];
    if (m) { e.preventDefault(); setMode(m); return; }
    if (key === 'd' && store.selection?.kind === 'item') { e.preventDefault(); properties.duplicateItem(store.selection.id); }
    return;
  }
  if (typing || e.altKey) return;
  if (e.key === '?') { e.preventDefault(); openHelp(); return; }
  if (e.target === document.body) {
    if ((e.key === 'Delete' || e.key === 'Backspace') && store.selection) { e.preventDefault(); store.deleteSelection(); }
    else if (e.key === 'Escape' && store.selection) store.select(null);
  }
});

// ---- Start ---------------------------------------------------------------------------------------------

function start() {
  layoutStage();
  updateOverlays();
  const initial = MODES.includes(prefs.mode) ? prefs.mode : 'plan';
  setMode(initial, { focus: false });
  if (saved?.imageDropped) {
    toast('Your plan was restored without its floor plan image, which was too large to keep in the browser.', { type: 'info', duration: 9000 });
  }
  if (!saved) openSamples({ welcome: true });
  if (initial === 'plan') {
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
    idle(() => import('./walkthrough.js').catch(() => {}));
  }
}

start();
Object.assign(window, { cbre: { store, editor, get walk() { return walk; }, setMode, get mode() { return mode; } } });
