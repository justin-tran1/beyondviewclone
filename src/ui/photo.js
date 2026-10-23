// Render photo: a ray-traced still of the current 3D view, for client decks. A button beside Save
// image opens a dialog with the size, the quality, a live preview and progress. The renderer
// (src/photo.js and the path tracer) loads the first time the dialog opens.
import { h, iconEl, downloadBlob, safeFileName } from './dom.js';
import { openDialog, toast } from './widgets.js';
import { setPref } from './storage.js';

export const PHOTO_SIZES = [
  { id: 'hd', label: '1280 x 720', note: 'HD', width: 1280, height: 720 },
  { id: 'fhd', label: '1920 x 1080', note: 'Full HD', width: 1920, height: 1080 },
  { id: '4k', label: '3840 x 2160', note: '4K', width: 3840, height: 2160 },
];

export const PHOTO_QUALITIES = [
  { id: 'draft', label: 'Draft', samples: 64, note: '64 samples. A quick look at the framing and light.' },
  { id: 'standard', label: 'Standard', samples: 256, note: '256 samples. Clean enough for most decks.' },
  { id: 'high', label: 'High', samples: 1024, note: '1,024 samples. The cleanest result, for large prints.' },
];

// Camera with a spark, drawn like the icons in icons.js (20 px grid, 1.5 px strokes).
const ICON = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" focusable="false">'
  + '<path d="M12.8 7.2h4.6V16H2.6V7.2h3.2l1.4-2h3.1"/><circle cx="10" cy="11.4" r="2.6"/>'
  + '<path d="M15.6 1.6c.3 1.5.8 2 2.3 2.3-1.5.3-2 .8-2.3 2.3-.3-1.5-.8-2-2.3-2.3 1.5-.3 2-.8 2.3-2.3z" fill="currentColor" stroke-width="1"/></svg>';

let engine = null;

/** The photo renderer, loaded on first use. */
function loadEngine() {
  if (!engine) {
    engine = import('../photo.js');
    engine.catch(() => { engine = null; });
  }
  return engine;
}

/**
 * Adds the Render photo button after `anchor` (the Save image button). getWalk() resolves with
 * the Walkthrough. CSS hides the button in Plan mode, where there is no 3D view.
 */
export function createPhotoUI({ anchor, store, prefs, getWalk }) {
  const icon = h('span', { class: 'icon', attrs: { 'aria-hidden': 'true' } });
  icon.innerHTML = ICON;
  const button = h('button', {
    type: 'button', class: 'bar-btn', id: 'render-photo',
    attrs: { 'aria-label': 'Render photo', 'aria-haspopup': 'dialog' },
    dataset: { tip: 'Render a photographic still of the 3D view' },
    on: { click: () => openPhotoDialog({ store, prefs, getWalk }) },
  }, icon);
  anchor.after(button);
  return { button };
}

const formatTime = (ms) => {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
};

const remaining = (ms) => {
  const s = ms / 1000;
  if (s < 10) return 'a few seconds left';
  if (s < 55) return `about ${Math.ceil(s / 5) * 5} seconds left`;
  const m = Math.round(s / 60);
  return m <= 1 ? 'about a minute left' : `about ${m} minutes left`;
};

/** The saved view the walker is standing at, by the same rule the views strip uses, or null. */
function currentViewName(plan, pose) {
  if (!pose) return null;
  const turn = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  const cam = plan.cameras.find((c) => Math.hypot(pose.x - c.x, pose.y - c.y) <= 0.6 && turn(pose.yaw, c.yaw) <= 25);
  return cam?.name || null;
}

export function photoFileName(plan, viewName) {
  return `${safeFileName(plan.name)} - ${safeFileName(viewName || 'Walkthrough', 'Walkthrough')}.png`;
}

/**
 * The Render photo dialog. sizes and qualities default to the lists above; tests pass smaller ones.
 */
export function openPhotoDialog({ store, prefs = {}, getWalk, sizes = PHOTO_SIZES, qualities = PHOTO_QUALITIES }) {
  let size = sizes.find((s) => s.id === prefs.photoSize) || sizes[0];
  let quality = qualities.find((q) => q.id === prefs.photoQuality) || qualities[Math.min(1, qualities.length - 1)];
  let state = 'loading'; // loading | ready | rendering | done | error | unsupported
  let controller = null;
  let blob = null;
  let fileName = '';
  let photo = null;
  let closed = false;
  let starting = false;

  // Preview: the live view until the first rendered pass arrives.
  const canvas = h('canvas', { class: 'photo-canvas', attrs: { 'aria-hidden': 'true' }, hidden: true });
  const still = h('img', { class: 'photo-still', alt: '' });
  const badge = h('span', { class: 'photo-badge', text: 'Current view' });
  const frame = h('div', { class: 'photo-frame', attrs: { role: 'img', 'aria-label': 'Preview of the photo' } }, still, canvas, badge);

  const option = (item, group, onPick) => h('button', {
    type: 'button', class: 'seg photo-option', dataset: { [group]: item.id },
    attrs: { 'aria-pressed': 'false' },
    on: { click: () => onPick(item) },
  }, h('span', { text: item.label }), item.note && group === 'size' ? h('span', { class: 'photo-option-note', text: item.note }) : null);
  const sizeButtons = sizes.map((s) => option(s, 'size', (v) => {
    size = v;
    setPref(prefs, 'photoSize', v.id);
    sync();
  }));
  const qualityButtons = qualities.map((q) => option(q, 'quality', (v) => {
    quality = v;
    setPref(prefs, 'photoQuality', v.id);
    sync();
  }));
  const qualityHelp = h('p', { class: 'field-help' });
  const row = (label, control, hint) => h('div', { class: 'setting-row' },
    h('span', { class: 'field-label', text: label }),
    h('div', { class: 'setting-control' }, control, hint));
  const settings = h('div', { class: 'photo-settings' },
    row('Size', h('div', { class: 'segmented segmented-light', attrs: { role: 'group', 'aria-label': 'Size' } }, sizeButtons)),
    row('Quality', h('div', { class: 'segmented segmented-light', attrs: { role: 'group', 'aria-label': 'Quality' } }, qualityButtons), qualityHelp));

  const fill = h('div', { class: 'photo-bar-fill' });
  const bar = h('div', { class: 'photo-bar', attrs: { role: 'progressbar', 'aria-label': 'Rendering progress', 'aria-valuemin': '0', 'aria-valuemax': '100' } }, fill);
  const statusText = h('p', { class: 'photo-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const progress = h('div', { class: 'photo-progress', hidden: true }, bar, statusText);
  const message = h('p', { class: 'photo-message', attrs: { role: 'alert' }, hidden: true });
  const note = h('p', {
    class: 'photo-note',
    text: 'Rendering traces real light paths on your graphics card, so it can take a minute or more, longer at larger sizes and higher quality. The live 3D view stays as it is while it works.',
  });

  const closeBtn = h('button', { type: 'button', class: 'btn btn-secondary', text: 'Close', on: { click: () => (state === 'rendering' ? cancel() : dlg.close('close')) } });
  const renderBtn = h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => start() } }, iconEl('photo'), h('span', { class: 'btn-label', text: 'Render photo' }));
  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', hidden: true, on: { click: save } }, iconEl('save'), h('span', { class: 'btn-label', text: 'Save image' }));

  const dlg = openDialog({
    title: 'Render photo',
    subtitle: 'A photographic still of the current view, ready for client presentations.',
    cls: 'dialog-photo',
    body: [frame, progress, message, settings, note],
    actions: [closeBtn, renderBtn, saveBtn],
    initialFocus: renderBtn,
    onClose: () => {
      closed = true;
      controller?.abort();
    },
  });

  function sync() {
    for (const b of sizeButtons) b.setAttribute('aria-pressed', String(b.dataset.size === size.id));
    for (const b of qualityButtons) b.setAttribute('aria-pressed', String(b.dataset.quality === quality.id));
    qualityHelp.textContent = quality.note || `${quality.samples} samples.`;
    frame.style.aspectRatio = `${size.width} / ${size.height}`;
    const busy = state === 'rendering';
    for (const b of [...sizeButtons, ...qualityButtons]) b.disabled = busy;
    const changed = state === 'done' && (blob?.photoSize !== size.id || blob?.photoQuality !== quality.id);
    renderBtn.hidden = busy || (state === 'done' && !changed);
    renderBtn.disabled = state === 'loading' || state === 'unsupported' || busy;
    renderBtn.lastChild.textContent = state === 'error' ? 'Try again' : 'Render photo';
    saveBtn.hidden = state !== 'done';
    closeBtn.textContent = busy ? 'Cancel' : 'Close';
    progress.hidden = !['rendering', 'done'].includes(state);
  }

  function setProgress(fraction, text) {
    const indeterminate = fraction === null;
    bar.classList.toggle('indeterminate', indeterminate);
    if (indeterminate) bar.removeAttribute('aria-valuenow');
    else bar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    fill.style.width = indeterminate ? '' : `${(fraction * 100).toFixed(1)}%`;
    statusText.textContent = text;
  }

  function showMessage(text) {
    message.textContent = text || '';
    message.hidden = !text;
  }

  function drawPreview(source) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.min(source.width, Math.round(frame.clientWidth * dpr)));
    const hgt = Math.max(1, Math.round((w * source.height) / source.width));
    if (canvas.width !== w || canvas.height !== hgt) {
      canvas.width = w;
      canvas.height = hgt;
    }
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, hgt);
    canvas.hidden = false;
    still.hidden = true;
  }

  async function prepare() {
    sync();
    let walk;
    try {
      const [mod, w] = await Promise.all([loadEngine(), getWalk()]);
      photo = mod;
      walk = w;
    } catch (err) {
      console.error(err);
      if (closed) return;
      state = 'unsupported';
      showMessage('The photo renderer could not load. Check your connection and reload the page to try again.');
      sync();
      return;
    }
    if (closed) return;
    const support = photo.photoSupport();
    if (!support.ok) {
      state = 'unsupported';
      showMessage(support.reason);
      sync();
      return;
    }
    state = 'ready';
    sync();
    renderBtn.focus({ preventScroll: true });
    // The live view as a framing guide; the photo keeps its position and direction.
    walk.screenshot().then((b) => {
      if (closed || !canvas.hidden) return;
      const url = URL.createObjectURL(b);
      still.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
      still.src = url;
    }).catch(() => {});
  }

  async function start() {
    if (!photo || state === 'rendering' || starting) return;
    let walk;
    starting = true;
    try {
      walk = await getWalk();
    } catch {
      return;
    } finally {
      starting = false;
    }
    if (closed) return;
    const ctx = walk.renderContext;
    if (!ctx?.built) {
      state = 'error';
      showMessage('This plan could not be shown in 3D, so there is nothing to render.');
      sync();
      return;
    }
    const plan = store.plan;
    fileName = photoFileName(plan, walk.mode === 'walk' ? currentViewName(plan, walk.pose) : null);
    const camera = ctx.camera.clone();
    const job = { size, quality };
    controller = new AbortController();
    const signal = controller.signal;
    state = 'rendering';
    blob = null;
    showMessage('');
    badge.textContent = 'Rendering';
    sync();
    closeBtn.focus({ preventScroll: true });
    setProgress(null, 'Preparing the scene');
    const t0 = performance.now();
    // The time left comes from the last 20 seconds of samples, so a pause (a laptop asleep, say)
    // does not throw it off for the rest of the render.
    const recent = [];
    try {
      const result = await photo.renderPhoto({
        scene: ctx.scene, camera, width: job.size.width, height: job.size.height, samples: job.quality.samples,
        exposure: ctx.renderer?.toneMappingExposure, meter: walk.meterView?.(), signal,
        onProgress: (done, total, { phase, preview }) => {
          if (signal.aborted) return;
          if (preview) drawPreview(preview);
          if (phase === 'prepare') setProgress(null, 'Preparing the scene');
          else if (phase === 'compile') setProgress(null, 'Starting the ray tracer on your graphics card');
          else if (phase === 'render') {
            const now = performance.now();
            recent.push([now, done]);
            while (recent.length > 2 && now - recent[1][0] > 20000) recent.shift();
            const [since, from] = recent[0];
            const rate = done > from ? (now - since) / (done - from) : 0;
            const left = rate ? `, ${remaining(rate * (total - done))}` : '';
            setProgress(done / total, `Rendering: ${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} samples${left}`);
          }
        },
      });
      result.photoSize = job.size.id;
      result.photoQuality = job.quality.id;
      blob = result;
      state = 'done';
      badge.textContent = `${job.size.label}, ${job.quality.label}`;
      setProgress(1, `Done in ${formatTime(performance.now() - t0)}. Save the image to add it to a deck.`);
      sync();
      saveBtn.focus({ preventScroll: true });
    } catch (err) {
      if (closed) return;
      if (err?.name === 'AbortError') {
        state = 'ready';
        badge.textContent = 'Cancelled';
        setProgress(0, '');
      } else {
        console.error(err);
        state = 'error';
        badge.textContent = 'Not rendered';
        showMessage(err?.name === 'PhotoError' ? err.message : 'The photo could not be rendered. Try a smaller size, or reload the page and try again.');
      }
      sync();
      renderBtn.focus({ preventScroll: true });
    } finally {
      controller = null;
    }
  }

  function cancel() {
    controller?.abort();
  }

  function save() {
    if (!blob) return;
    downloadBlob(blob, fileName);
    toast(`Photo saved as ${fileName}`);
  }

  prepare();
  return dlg;
}
