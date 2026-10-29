// CBRE Virtual Walkthrough app shell: wires the plan store, the 2D editor, the 3D walkthrough
// and the panels, dialogs, files and shortcuts into one page.
import { PlanStore, createPlan, addCamera, uid } from './model.js';
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
import { createPhotoUI } from './ui/photo.js';
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
// The plan as last opened, created or saved to a file. Any other state has unsaved changes.
let filed = saved?.edited ? null : store.plan;
let sampled = null; // the plan as opened from a sample
let lastUpdateNotice = 0;
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
  replaceImage: () => importImage(null, { replace: true }),
  calibrate: startCalibration,
  detectWalls: () => traceImage(),
  walkToCamera,
  removeImage,
};
createProperties($('#right-panel'), { store, editor, actions });

const saver = autosave(store, {
  restored: saved,
  isEdited: (plan) => plan !== filed,
  isSample: (plan) => plan === sampled,
  onFull: (what) => toast(what === 'image'
    ? 'This floor plan image is too large to keep in the browser. Save the plan to a file to keep the image with it.'
    : 'The browser storage is full, so this plan is not kept in the browser. Save the plan to a file to keep it.', { type: 'info', duration: 9000 }),
  onConflict: ({ id, name, open }) => toast(open
    ? `This plan was also changed in another tab. Your version here is kept as "${name}".`
    : `A plan you left was also changed in another tab. Your version is kept as "${name}" in Recent plans.`, {
    type: 'info', duration: 12000, action: open ? { label: 'Open the other version', onClick: () => openRecent(id) } : undefined,
  }),
  onUpdate: (rec) => {
    filed = rec.edited ? null : store.plan;
    // One notice while the other tab keeps saving, not one per save.
    if (Date.now() - lastUpdateNotice > 15000) toast('This plan was updated with changes made in another tab.', { type: 'info' });
    lastUpdateNotice = Date.now();
  },
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

/** Give keyboard focus back to the plan or the 3D view, so shortcuts work after a field or dialog. */
function focusView() {
  const el = mode === 'walk' ? $('#walk-view') : canvas;
  el.focus({ preventScroll: true });
}

const nameInput = $('#plan-name');
const syncName = () => { if (document.activeElement !== nameInput) nameInput.value = store.plan.name; };
nameInput.addEventListener('change', () => {
  const v = nameInput.value.trim() || 'Untitled plan';
  if (v !== store.plan.name) store.update((d) => { d.name = v; }, { label: 'Rename plan' });
  nameInput.value = store.plan.name;
});
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); focusView(); }
  if (e.key === 'Escape') { nameInput.value = store.plan.name; focusView(); }
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

/** "Saved 5 minutes ago", "Saved yesterday at 4:05 PM", "Saved Oct 12". */
function savedWhen(t) {
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return 'Saved just now';
  if (min < 60) return `Saved ${min} ${min === 1 ? 'minute' : 'minutes'} ago`;
  const d = new Date(t), today = new Date();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return `Saved today at ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Saved yesterday at ${time}`;
  return `Saved ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) })}`;
}

attachMenu($('#open-menu'), () => {
  // The latest plans, and every plan with unsaved changes, as the save prompt promises.
  const recent = saver.recent().filter((r, i) => i < 5 || r.edited !== false).map((r) => ({
    label: r.name, icon: 'plan', description: `${savedWhen(r.savedAt)}${r.imageDropped ? ', without its image' : ''}`,
    onSelect: () => openRecent(r.id),
  }));
  return [
    { label: 'Open plan file', icon: 'folder', hint: `${MOD}+O`, onSelect: () => openPlanFile() },
    { label: 'Import floor plan image', icon: 'image', description: 'PNG, JPG, WebP, SVG or PDF', onSelect: () => importImage() },
    { label: 'Open a sample', icon: 'grid', onSelect: openSamples },
    'separator',
    { label: 'New blank plan', icon: 'file-new', onSelect: newPlan },
    ...(recent.length ? ['separator', { group: 'Recent plans in this browser', items: recent }] : []),
  ];
}, { align: 'end' });
$('#save').addEventListener('click', savePlan);
$('#save-image').addEventListener('click', saveImage);
createPhotoUI({ anchor: $('#save-image'), store, prefs, getWalk: ensureWalk });
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

const planHasContent = (p) => p.walls.length > 0 || p.rooms.length > 0 || p.items.length > 0;
const isBlankPlan = (p) => !planHasContent(p) && !p.underlay && p.cameras.length === 0;

/**
 * Replace the document. Keeps an undo step back to the current plan unless it is still blank.
 * Returns toast options with that Undo. `edited`: the new plan has changes not saved to a file.
 * `sample`: the new plan is a sample.
 */
function replacePlan(plan, label, { edited = false, sample = false } = {}) {
  const keepHistory = !isBlankPlan(store.plan);
  store.replace(plan, { label, keepHistory });
  filed = edited ? null : store.plan;
  sampled = sample ? store.plan : null;
  return keepHistory ? { duration: 8000, action: { label: 'Undo', onClick: () => store.undo() } } : {};
}

/** Before a plan with changes that are not in a file is replaced, offer to save it. Resolves true to go on. */
function confirmReplace() {
  if (store.plan === filed || isBlankPlan(store.plan)) return Promise.resolve(true);
  const kept = saver.isKept();
  return new Promise((resolve) => {
    let go = false;
    const done = (save) => () => {
      if (save && !savePlan()) return;
      go = true;
      dlg.close('continue');
    };
    const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', text: 'Save plan file', on: { click: done(true) } });
    const dlg = openDialog({
      title: 'Save your changes first?',
      subtitle: `"${store.plan.name}" has changes that are not saved to a plan file. ${kept
        ? 'If you continue without saving, you can still open it from Recent plans in the Open menu.'
        : 'If you continue without saving, these changes may be lost.'}`,
      actions: [
        h('button', { type: 'button', class: 'btn btn-secondary', text: 'Cancel', on: { click: () => dlg.close('cancel') } }),
        h('button', { type: 'button', class: 'btn btn-secondary', text: 'Continue without saving', on: { click: done(false) } }),
        saveBtn,
      ],
      initialFocus: saveBtn,
      onClose: () => resolve(go),
    });
  });
}

/** Download the plan file. Returns true when it was saved. */
function savePlan() {
  if (isTextField(document.activeElement)) document.activeElement.blur();
  try {
    const name = savePlanFile(store.plan);
    filed = store.plan;
    saver.saveSoon();
    toast(`Plan saved as ${name}`);
    return true;
  } catch (err) {
    console.error(err);
    toast('The plan could not be saved.', { type: 'error' });
    return false;
  }
}

async function openPlanFile(file) {
  if (!file) {
    [file] = await pickFiles(PLAN_ACCEPT);
    if (!file) return;
  }
  let plan;
  try {
    plan = await readPlanFile(file);
  } catch (err) {
    toast(err instanceof FileError ? err.message : 'This file could not be opened.', { type: 'error' });
    return;
  }
  if (!(await confirmReplace())) return;
  toast(`Opened ${plan.name}`, replacePlan(saver.openable(plan), 'Open plan'));
}

async function openRecent(id) {
  if (!(await confirmReplace())) return;
  const rec = saver.load(id);
  if (!rec) {
    toast('This plan is no longer kept in the browser.', { type: 'error' });
    return;
  }
  toast(`Opened ${rec.plan.name}`, replacePlan(rec.plan, 'Open plan', { edited: rec.edited }));
  if (rec.imageDropped) toast('This plan was kept without its floor plan image, which was too large for the browser.', { type: 'info', duration: 9000 });
}

function openSamples({ welcome = false } = {}) {
  openStartDialog({
    welcome,
    onSample: openSample,
    onTrace: () => importImage(),
    onBlank: newPlan,
  });
}

async function openSample(sample) {
  let plan;
  try {
    plan = await loadSample(sample);
  } catch (err) {
    console.error(err);
    toast(`The ${sample.name.toLowerCase()} sample could not be loaded.`, { type: 'error' });
    return;
  }
  if (!(await confirmReplace())) return;
  // Every opening is a new plan, so it never takes over the saved copy of an earlier one.
  toast(`Opened the ${sample.name.toLowerCase()} sample`, replacePlan({ ...plan, id: uid('plan') }, `Open ${sample.name}`, { sample: true }));
}

async function newPlan() {
  if (!(await confirmReplace())) return;
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
    toast(err instanceof FileError ? err.message : 'The image could not be saved.', { type: 'error' });
  }
}

// ---- Floor plan images and calibration -----------------------------------------------------------

let dismissImportHint = null;

/** Ask whether a new image goes under the current plan (the default) or starts a new one. */
function chooseImageTarget() {
  return new Promise((resolve) => {
    let choice = null;
    const pick = (v) => () => { choice = v; dlg.close(v); };
    const here = h('button', {
      type: 'button', class: 'btn btn-primary', text: store.plan.underlay ? 'Replace the image in this plan' : 'Add to this plan',
      on: { click: pick('current') },
    });
    const dlg = openDialog({
      title: 'Where should this image go?',
      subtitle: store.plan.underlay
        ? 'Your plan already has walls or furniture. You can swap its floor plan image for this one, or start a new plan with it.'
        : 'Your plan already has walls or furniture. You can place the image under this plan, or start a new plan with it.',
      cls: 'dialog-narrow',
      actions: [
        h('button', { type: 'button', class: 'btn btn-secondary', text: 'Start a new plan', on: { click: pick('new') } }),
        here,
      ],
      initialFocus: here,
      onClose: () => resolve(choice),
    });
  });
}

/**
 * The image as the plan's underlay. A replaced image keeps its place and spans the same width, so
 * it keeps any calibration and the plan traced from the old one.
 */
function underlayIn(plan, image) {
  const next = underlayFor(image);
  const old = plan.underlay;
  if (!old) return next;
  return {
    ...next, x: old.x, y: old.y, rotation: old.rotation, opacity: old.opacity, locked: old.locked,
    scale: old.width > 0 ? old.scale * (old.width / next.width) : next.scale,
    ...(old.calibrated ? { calibrated: true } : {}),
    ...(old.traced ? { traced: true } : {}),
  };
}

let pdfModule = null;

/** A PDF's floor plan as an image: the page and area chosen in the PDF dialog (see ui/pdf.js), or null. */
async function readPdf(file) {
  let working = toast('Reading the PDF...', { type: 'info', duration: 120000 });
  try {
    pdfModule ||= await import('./ui/pdf.js');
    return await pdfModule.importPdf(file, {
      onOpen: () => working(),
      onChosen: () => { working = toast('Preparing the floor plan...', { type: 'info', duration: 120000 }); },
    });
  } finally {
    working();
  }
}

/**
 * Import a floor plan image, or the floor plan on a page of a PDF. With `replace`, swap the image of
 * the current plan and keep everything else. Otherwise a plan that already has content asks whether
 * to add it there or start a new plan.
 */
async function importImage(file, { replace = false } = {}) {
  if (!file) {
    [file] = await pickFiles(IMAGE_ACCEPT);
    if (!file) return;
  }
  let image;
  try {
    image = fileKind(file) === 'pdf' ? await readPdf(file) : await readImageFile(file);
    if (!image) return;
  } catch (err) {
    if (!(err instanceof FileError)) console.error(err);
    toast(err instanceof FileError ? err.message : 'This image could not be imported.', { type: 'error' });
    return;
  }
  const title = file.name.replace(/\.[^.]+$/, '') || 'Untitled plan';
  const old = store.plan.underlay;
  let undo = {};
  if (!replace && planHasContent(store.plan)) {
    const target = await chooseImageTarget();
    if (!target) return;
    if (target === 'new') {
      if (!(await confirmReplace())) return;
      undo = replacePlan(createPlan({ name: title, underlay: underlayFor(image) }), 'New plan from image');
    }
  }
  if (!store.plan.underlay || store.plan.underlay === old) {
    const label = old ? 'Replace floor plan image' : 'Import floor plan image';
    const rename = !old && !planHasContent(store.plan) && store.plan.name === 'Untitled plan';
    store.update((d) => {
      d.underlay = underlayIn(d, image);
      if (rename) d.name = title;
    }, { label });
  }
  store.select(null);
  if (mode === 'walk') await setMode('plan', { focus: false });
  dismissImportHint?.();
  dismissImportHint = null;
  if (image.resized) toast(`The image was reduced to ${image.width} x ${image.height} px to keep the plan fast.`, { type: 'info' });
  // A plan with no walls yet is made from the image: its walls, doors and rooms are found for it.
  if (!store.plan.walls.length && !store.plan.rooms.length) {
    editor.zoomToFit();
    editor.setTool('select');
    canvas.focus({ preventScroll: true });
    traceImage({ auto: true });
    return;
  }
  const same = old && old.width === image.width && old.height === image.height && store.plan.underlay !== old;
  if (same && !undo.action) {
    dismissImportHint = toast('Image replaced. Its scale and position are unchanged.', { action: { label: 'Undo', onClick: () => store.undo() } });
  } else {
    editor.zoomToFit();
    editor.setTool('calibrate');
    const text = old && !undo.action
      ? 'Image replaced. Click two points of a known distance to check its scale.'
      : 'Image imported. Click two points of a known distance to set the scale.';
    dismissImportHint = toast(text, { ...undo, type: 'info', duration: 9000 });
  }
  canvas.focus({ preventScroll: true });
}

let tracing = null; // { src, run }: the image being traced; a later run supersedes it
let traceRuns = 0;
let traceModule = null;
let reading = null; // the src of the image being read for its room names
let labelsModule = null;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "12 walls, 5 doors, 4 rooms and 9 pieces of furniture" (the kinds found, in that order). */
function foundText(c) {
  const parts = [plural(c.walls, 'wall')];
  if (c.doors) parts.push(plural(c.doors, 'door'));
  if (c.windows) parts.push(plural(c.windows, 'window'));
  if (c.rooms) parts.push(plural(c.rooms, 'room'));
  if (c.items) parts.push(plural(c.items, 'piece of furniture', 'pieces of furniture'));
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
}

/** Ask before detected walls replace the ones in the plan. Resolves true to go on. */
function confirmRetrace() {
  return new Promise((resolve) => {
    let go = false;
    const replace = h('button', { type: 'button', class: 'btn btn-primary', text: 'Replace walls and rooms', on: { click: () => { go = true; dlg.close('replace'); } } });
    const n = store.plan.walls.length;
    const found = store.plan.items.some((i) => i.traced);
    const dlg = openDialog({
      title: 'Detect the walls again?',
      subtitle: found
        ? `This plan's ${plural(n, 'wall')}, its doors, windows and rooms, and the furniture found in the image before are replaced with what is found now. Furniture you added and saved views stay.`
        : `This plan's ${plural(n, 'wall')} and its doors, windows and rooms are replaced with the ones found in the image, and the furniture found in it is added. Furniture already in the plan and saved views stay.`,
      cls: 'dialog-narrow',
      actions: [
        h('button', { type: 'button', class: 'btn btn-secondary', text: 'Cancel', on: { click: () => dlg.close('cancel') } }),
        replace,
      ],
      initialFocus: replace,
      onClose: () => resolve(go),
    });
  });
}

/**
 * Find the walls, doors, windows, rooms and furniture in the floor plan image and add them to the
 * plan, so it can be walked through straight away. The image takes the scale its doors give,
 * unless it was calibrated. auto: right after an import into a plan with no walls; nothing is
 * asked, and when the image has no walls to find, the user is shown how to trace it by hand.
 */
async function traceImage({ auto = false } = {}) {
  const u = store.plan.underlay;
  if (!u) {
    toast('Import a floor plan image first, then detect its walls.', { type: 'info' });
    return;
  }
  if (tracing?.src === u.src) return;
  const hadWalls = store.plan.walls.length > 0 || store.plan.rooms.length > 0;
  if (hadWalls && !auto && !(await confirmRetrace())) return;
  const planId = store.plan.id;
  const run = ++traceRuns;
  tracing = { src: u.src, run };
  dismissImportHint?.();
  const working = toast('Finding the walls, doors, rooms and furniture in the image...', { type: 'info', duration: 600000 });
  let result = null;
  try {
    traceModule ||= await import('./ui/trace.js');
    result = await traceModule.traceUnderlay(u);
  } catch (err) {
    console.error(err);
  } finally {
    if (tracing?.run === run) tracing = null;
    working();
  }
  // The plan or its image changed while the tracer worked: its result no longer applies.
  const now = store.plan.underlay;
  if (run !== traceRuns || store.plan.id !== planId || now?.src !== u.src) return;
  if (auto && (store.plan.walls.length || store.plan.rooms.length)) return;
  if (!result || result.trace.walls.length < 3) {
    if (mode === 'walk') await setMode('plan', { focus: false });
    editor.zoomToFit();
    editor.setTool('calibrate');
    canvas.focus({ preventScroll: true });
    const why = result ? 'No walls were found in this image.' : 'The walls in this image could not be detected.';
    // A PDF page's scale note already gave the image its scale.
    const next = now.scaleNote && !now.calibrated
      ? `Its scale is set from its scale note, ${now.scaleNote.text}: trace the walls with the Wall tool (W).`
      : 'Click two points of a known distance to set its scale, then trace the walls with the Wall tool (W).';
    if (now.scaleNote && !now.calibrated) editor.setTool('wall');
    dismissImportHint = toast(`${why} ${next}`, { type: 'info', duration: 12000 });
    return;
  }
  const adopt = !now.calibrated && result.metersPerPixel > 0;
  let count = null;
  store.update((d) => {
    if (hadWalls) {
      d.walls = [];
      d.openings = [];
      d.rooms = [];
      d.items = d.items.filter((i) => !i.traced);
    }
    if (adopt) d.underlay.scale = result.metersPerPixel;
    d.underlay.traced = true;
    count = traceModule.addTrace(d, result);
  }, { label: 'Detect walls' });
  store.select(null);
  editor.setTool('select');
  editor.zoomToFit();
  const { source, noteMismatch } = result.trace.scale;
  const note = now.scaleNote?.text;
  // A note read by OCR may be misread, as well as printed to fit.
  const ocr = !!now.scaleNote?.ocr;
  const scale = now.calibrated ? ''
    : adopt && source === 'note' ? ` The scale is set from the drawing's scale note, ${note}${ocr ? ', read from the page by OCR' : ''}.`
      : adopt && source === 'doors' && noteMismatch
        ? ocr
          ? ` The scale note read from the page (${note}) does not match its doors, so the scale is set from the door widths. Use Calibrate scale if it is off.`
          : ` The drawing's scale note (${note}) does not match its doors, so the page was likely printed to fit: the scale is set from the door widths. Use Calibrate scale if it is off.`
        : adopt && source === 'doors' ? ' The scale is set from the door widths. Use Calibrate scale if it is off.'
          : ' Use Calibrate scale to set its true size.';
  const named = count.named ? ` ${plural(count.named, 'room')} ${count.named === 1 ? 'is' : 'are'} named from the drawing's labels.` : '';
  const finished = count.finished
    ? ` Finishes are set for ${plural(count.finished, 'room')} from ${count.named ? (count.finished === 1 ? 'its name or furniture' : 'their names and furniture') : (count.finished === 1 ? 'the furniture in it' : 'the furniture in them')}.`
    : '';
  const found = toast(`Found ${foundText(count)}.${named}${finished}${scale}`, { duration: 12000, action: { label: 'Undo', onClick: () => store.undo() } });
  // An image without labels of its own (not a PDF page's) is read for them, to name its rooms.
  const traced = store.plan.underlay;
  if (!traced.labels?.length && !traced.labelsRead) nameRoomsFromImage(traced, result, found);
  // Show the building in 3D beside the plan it came from, from above to take it all in.
  if (mode === 'plan') await setMode('split', { focus: false });
  if (mode === 'split') ensureWalk().then((w) => w.setMode('overview'), () => {});
}

/**
 * Read the room labels on a traced image with OCR (ui/image-labels.js), as it is enlarged for the
 * scale the trace gave it, then name the rooms still called Room 1, Room 2... from them and give
 * them the finishes their names tell: a step of its own, after the trace's (whose toast, `found`,
 * goes, as its Undo would now take back the names).
 */
async function nameRoomsFromImage(u, result, found) {
  if (reading === u.src) return;
  reading = u.src;
  const planId = store.plan.id;
  let labels = null, working = null;
  try {
    labelsModule ||= await import('./ui/image-labels.js');
    if (!labelsModule.canReadText()) return;
    working = toast('Reading the room names in the image...', { type: 'info', duration: 600000 });
    labels = await labelsModule.readImageLabels(u, { metersPerPixel: u.scale, area: traceModule.tracedArea(result) });
  } catch (err) {
    console.warn('The room names in the image could not be read.', err);
  } finally {
    if (reading === u.src) reading = null;
    working?.();
  }
  // The plan or its image changed while it read, or the trace was taken back: the labels no longer apply.
  const now = store.plan.underlay;
  if (!labels || store.plan.id !== planId || now?.src !== u.src || !now.traced) return;
  if (!traceModule.namedBy(store.plan, labels)) {
    toast('No room names could be read in the image.', { type: 'info', duration: 6000 });
    return;
  }
  let count = null;
  store.update((d) => { count = traceModule.addLabels(d, labels); }, { label: 'Name rooms from the drawing' });
  found();
  const sets = count.finished ? ` Finishes are set for ${plural(count.finished, 'room')} from ${count.finished === 1 ? 'its name' : 'their names'}.` : '';
  toast(`${plural(count.named, 'room')} ${count.named === 1 ? 'is' : 'are'} named from the drawing's labels.${sets}`, { duration: 12000, action: { label: 'Undo', onClick: () => store.undo() } });
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
    // Cancelled: drop the measured line so the tool asks for a new first point.
    if (editor.tool === 'calibrate') {
      editor.setTool('select');
      editor.setTool('calibrate');
    }
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

/** Keys besides printable ones that the plan editor or the 3D view handle. */
const VIEW_KEYS = new Set(['Delete', 'Backspace', 'Escape', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
let forwarding = false;

/** Hand a key press to the plan editor (the 3D view in Walk) and give it focus for the keys that follow. */
function forwardKey(e) {
  const target = mode === 'walk' ? $('#walk-view') : canvas;
  target.focus({ preventScroll: true });
  if (document.activeElement !== target) return;
  const copy = new KeyboardEvent('keydown', {
    key: e.key, code: e.code, repeat: e.repeat, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey,
    bubbles: true, cancelable: true,
  });
  forwarding = true;
  try {
    if (!target.dispatchEvent(copy)) e.preventDefault();
  } finally {
    forwarding = false;
  }
}

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.isComposing || forwarding) return;
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
    // The editor duplicates the selected item or viewpoint.
    if (key === 'd' && mode !== 'walk') { e.preventDefault(); forwardKey(e); }
    return;
  }
  if (typing || e.altKey) return;
  if (e.key === '?') { e.preventDefault(); openHelp(); return; }
  // Shortcuts still reach the view when nothing has focus (after a dialog closed or a panel was
  // clicked), and letter and number keys pass through from buttons, which do not use them.
  const fromBody = e.target === document.body && (e.key.length === 1 || VIEW_KEYS.has(e.key));
  const fromButton = e.target.tagName === 'BUTTON' && !e.target.closest('[role="menu"]') && /^[\w+=-]$/.test(e.key);
  if (fromBody || fromButton) forwardKey(e);
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
