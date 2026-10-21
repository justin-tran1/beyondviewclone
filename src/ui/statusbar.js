// Bottom status bar: the editor's contextual hint, cursor position, zoom and the units toggle.
import { formatLength } from '../geometry.js';
import { h, iconEl } from './dom.js';

const PX_PER_M_AT_100 = 37.795;

export function createStatusBar(root, { store, editor }) {
  const hint = h('span', { class: 'status-hint' });
  const cursor = h('span', { class: 'status-cursor', attrs: { 'aria-label': 'Cursor position' } });
  const zoomText = h('button', {
    type: 'button', class: 'status-btn zoom-value', dataset: { tip: 'Zoom to fit', key: '0' },
    attrs: { 'aria-label': 'Zoom to fit' }, on: { click: () => editor.zoomToFit() },
  });
  const zoomBtn = (name, label, key, factor) => h('button', {
    type: 'button', class: 'status-btn status-icon', dataset: { tip: label, key }, attrs: { 'aria-label': label },
    on: { click: () => { editor.zoomBy(factor); scheduleZoom(); } },
  }, iconEl(name));
  const zoom = h('div', { class: 'status-group status-zoom', attrs: { role: 'group', 'aria-label': 'Zoom' } },
    zoomBtn('zoom-out', 'Zoom out', '-', 0.8), zoomText, zoomBtn('zoom-in', 'Zoom in', '+', 1.25));
  const unitButtons = [['imperial', 'Imperial'], ['metric', 'Metric']].map(([value, text]) => h('button', {
    type: 'button', class: 'status-seg', text, dataset: { units: value, tip: value === 'imperial' ? 'Show feet and inches' : 'Show meters' },
    attrs: { 'aria-pressed': 'false' },
    on: { click: () => { if (store.plan.units !== value) store.update((d) => { d.units = value; }, { label: 'Change units' }); } },
  }));
  const units = h('div', { class: 'status-units', attrs: { role: 'group', 'aria-label': 'Units' } }, unitButtons);
  root.append(hint, h('div', { class: 'status-right' }, cursor, zoom, units));

  let mode = 'plan';
  let editorHint = '';
  let walkHint = '';
  let flashUntil = 0;
  let flashTimer = 0;
  let zoomRaf = 0;
  let lastCursor = null;

  const showHint = () => {
    if (performance.now() < flashUntil) return;
    hint.textContent = mode === 'walk' ? walkHint : editorHint;
  };

  function scheduleZoom() {
    if (zoomRaf) return;
    zoomRaf = requestAnimationFrame(() => {
      zoomRaf = 0;
      zoomText.textContent = `${Math.round((editor.view.scale / PX_PER_M_AT_100) * 100)}%`;
    });
  }

  function drawCursor() {
    const u = store.plan.units;
    cursor.textContent = lastCursor ? `${formatLength(lastCursor.x, u)}, ${formatLength(lastCursor.y, u)}` : '';
  }

  function syncUnits() {
    for (const b of unitButtons) b.setAttribute('aria-pressed', String(b.dataset.units === store.plan.units));
    drawCursor();
  }

  editor.addEventListener('status', (e) => { editorHint = e.detail.text; showHint(); });
  editor.addEventListener('cursor', (e) => { lastCursor = e.detail; drawCursor(); });
  editor.addEventListener('view', scheduleZoom);
  editor.canvas.addEventListener('pointerleave', () => { lastCursor = null; drawCursor(); });
  store.addEventListener('change', syncUnits);
  syncUnits();
  scheduleZoom();

  return {
    setMode(next) {
      mode = next;
      root.dataset.mode = next;
      showHint();
      scheduleZoom();
    },
    setWalkHint(text) {
      walkHint = text;
      showHint();
    },
    /** Show a message briefly in place of the hint. */
    flash(text) {
      hint.textContent = text;
      flashUntil = performance.now() + 2200;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { flashUntil = 0; showHint(); }, 2250);
    },
    scheduleZoom,
  };
}
