// App dialogs: welcome and samples, calibration, settings and help.
import { CEILINGS } from '../model.js';
import { formatLength, parseLength } from '../geometry.js';
import { renderPlan, fitView, planBounds } from '../plan-render.js';
import { SAMPLES } from '../samples/index.js';
import { h, iconEl, MOD } from './dom.js';
import { openDialog } from './widgets.js';

// ---- Samples ------------------------------------------------------------------------------------

const sampleCache = new Map();

/** Build a sample once and keep the result (a normalized plan) for the session. */
export function loadSample(sample) {
  if (!sampleCache.has(sample.id)) {
    const p = Promise.resolve().then(() => sample.build());
    p.catch(() => sampleCache.delete(sample.id));
    sampleCache.set(sample.id, p);
  }
  return sampleCache.get(sample.id);
}

function drawPreview(canvas, source) {
  const plan = { ...source, cameras: [] };
  const cssW = canvas.clientWidth || 240, cssH = canvas.clientHeight || 120;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  const draw = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const view = fitView(planBounds(plan), cssW, cssH, 10);
    renderPlan(ctx, plan, view, { showGrid: false, showUnderlay: true, showLabels: false, background: '#FFFFFF', onLoad: draw });
  };
  draw();
}

function sampleCard(sample, onPick) {
  const canvas = h('canvas', { class: 'sample-preview', attrs: { 'aria-hidden': 'true' } });
  const card = h('button', {
    type: 'button', class: 'sample-card', dataset: { sample: sample.id },
    on: { click: () => onPick(sample) },
  }, h('span', { class: 'sample-art' }, canvas),
  h('span', { class: 'sample-text' },
    h('span', { class: 'sample-name', text: sample.name }),
    h('span', { class: 'sample-desc', text: sample.description })));
  requestAnimationFrame(() => {
    loadSample(sample).then((plan) => drawPreview(canvas, plan)).catch(() => card.classList.add('sample-failed'));
  });
  return card;
}

/**
 * Welcome dialog (first run) or the samples dialog (from the Open menu).
 * handlers: { onSample(sample), onTrace(), onBlank() }
 */
export function openStartDialog({ welcome = false, onSample, onTrace, onBlank }) {
  let dlg = null;
  const pick = (fn) => (...args) => { dlg.close('picked'); fn(...args); };
  const grid = h('div', { class: 'sample-grid' }, SAMPLES.map((s) => sampleCard(s, pick(onSample))));
  const body = [];
  if (welcome) {
    body.push(h('div', { class: 'start-actions' },
      h('button', { type: 'button', class: 'start-action start-action-primary', on: { click: pick(onTrace) } },
        iconEl('upload', 'icon start-icon'),
        h('span', { class: 'start-text' }, h('span', { class: 'start-title', text: 'Trace a floor plan image' }),
          h('span', { class: 'start-desc', text: 'Import a PNG, JPG, WebP or SVG drawing, set its scale and trace the walls.' }))),
      h('button', { type: 'button', class: 'start-action', on: { click: pick(onBlank) } },
        iconEl('file-new', 'icon start-icon'),
        h('span', { class: 'start-text' }, h('span', { class: 'start-title', text: 'Start a blank plan' }),
          h('span', { class: 'start-desc', text: 'Draw walls, rooms and openings from scratch.' })))),
    h('h3', { class: 'dialog-section-title', text: 'Or start from a sample' }));
  }
  body.push(grid);
  dlg = openDialog({
    title: welcome ? 'Welcome to Virtual Walkthrough' : 'Open a sample',
    subtitle: welcome
      ? 'Trace a floor plan, lay out furniture and equipment, then walk through the space in 3D.'
      : 'Samples open as a new plan. You can undo to return to your current plan.',
    body,
    cls: 'dialog-wide dialog-start',
    initialFocus: welcome ? null : grid.querySelector('button'),
  });
  return dlg;
}

// ---- Calibration ----------------------------------------------------------------------------------

/** "How long is this line?" Resolves with meters, or null when cancelled. */
export function askCalibration({ meters, units }) {
  return new Promise((resolve) => {
    const id = 'calibrate-length';
    const input = h('input', {
      type: 'text', class: 'input input-lg', id, placeholder: units === 'metric' ? '3.8 m' : '12\' 6"',
      attrs: { autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'calibrate-help' },
    });
    const error = h('p', { class: 'field-error', id: 'calibrate-error', attrs: { role: 'alert' }, hidden: true });
    const help = h('p', { class: 'field-help', id: 'calibrate-help', text: units === 'metric'
      ? 'Examples: 3.8m, 380cm or 12\' 6". A plain number is in meters.'
      : 'Examples: 12\' 6", 12.5 or 3.8m. A plain number is in feet.' });
    let result = null;
    const submit = (e) => {
      e?.preventDefault();
      const m = parseLength(input.value, units);
      if (!(m > 0.01) || !Number.isFinite(m)) {
        error.textContent = input.value.trim() ? `"${input.value.trim()}" is not a length we recognize.` : 'Type the real length of the line.';
        error.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      result = m;
      dlg.close('apply');
    };
    input.addEventListener('input', () => {
      error.hidden = true;
      input.removeAttribute('aria-invalid');
    });
    const form = h('form', { class: 'calibrate-form', on: { submit } },
      h('div', { class: 'measure' },
        iconEl('ruler', 'icon measure-icon'),
        h('div', {},
          h('div', { class: 'measure-label', text: 'Measured on the image' }),
          h('div', { class: 'measure-value', text: formatLength(meters, units) }))),
      h('label', { class: 'field-label', for: id, text: 'Real length' }),
      input, error, help);
    const dlg = openDialog({
      title: 'How long is this line?',
      subtitle: 'Type the real length of the line you drew. The image is scaled to match.',
      body: form,
      cls: 'dialog-narrow',
      initialFocus: input,
      actions: [
        h('button', { type: 'button', class: 'btn btn-secondary', text: 'Cancel', on: { click: () => dlg.close('cancel') } }),
        h('button', { type: 'button', class: 'btn btn-primary', text: 'Set scale', on: { click: submit } }),
      ],
      onClose: () => resolve(result),
    });
  });
}

// ---- Settings -------------------------------------------------------------------------------------

export function openSettings({ store, getDisplay, setDisplay }) {
  const plan = store.plan;
  const units = () => store.plan.units;
  const unitButtons = ['imperial', 'metric'].map((u) => h('button', {
    type: 'button', class: 'seg', dataset: { units: u }, text: u === 'imperial' ? 'Feet and inches' : 'Metric',
    attrs: { 'aria-pressed': String(plan.units === u) },
    on: { click: () => {
      if (store.plan.units !== u) store.update((d) => { d.units = u; }, { label: 'Change units' });
      for (const b of unitButtons) b.setAttribute('aria-pressed', String(b.dataset.units === u));
      heightInput.value = formatLength(store.plan.settings.wallHeight, u);
    } },
  }));

  const heightInput = h('input', { type: 'text', class: 'input', id: 'set-height', value: formatLength(plan.settings.wallHeight, plan.units), attrs: { autocomplete: 'off' } });
  const heightError = h('p', { class: 'field-error', hidden: true, attrs: { role: 'alert' } });
  heightInput.addEventListener('change', () => {
    const m = parseLength(heightInput.value, units());
    if (!(m >= 2 && m <= 12)) {
      heightError.textContent = `Use a height between ${formatLength(2, units())} and ${formatLength(12, units())}.`;
      heightError.hidden = false;
      heightInput.value = formatLength(store.plan.settings.wallHeight, units());
      return;
    }
    heightError.hidden = true;
    const old = store.plan.settings.wallHeight;
    if (Math.abs(m - old) < 1e-6) return;
    store.update((d) => {
      d.settings.wallHeight = m;
      for (const w of d.walls) if (Math.abs(w.height - old) < 1e-3) w.height = m;
    }, { label: 'Change wall height' });
    heightInput.value = formatLength(m, units());
  });
  heightInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); heightInput.blur(); } });

  const select = (id, options, value, onChange) => {
    const sel = h('select', { class: 'input select', id }, options.map(([v, t]) => h('option', { value: v, text: t })));
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    return h('div', { class: 'select-wrap' }, sel, iconEl('chevron-down', 'icon select-chevron'));
  };
  const ceiling = select('set-ceiling', Object.entries(CEILINGS).map(([k, v]) => [k, v.label]), plan.settings.ceiling,
    (v) => store.update((d) => { d.settings.ceiling = v; }, { label: 'Change default ceiling' }));
  const exterior = select('set-exterior', [['city', 'City skyline'], ['campus', 'Suburban campus'], ['none', 'Plain ground']], plan.settings.exterior,
    (v) => store.update((d) => { d.settings.exterior = v; }, { label: 'Change surroundings' }));

  const display = getDisplay();
  const check = (key, label, desc) => {
    const input = h('input', { type: 'checkbox', class: 'checkbox', id: `set-${key}`, checked: !!display[key] });
    input.addEventListener('change', () => setDisplay({ [key]: input.checked }));
    return h('label', { class: 'check-row', for: `set-${key}` }, input,
      h('span', {}, h('span', { class: 'check-label', text: label }), desc ? h('span', { class: 'check-desc', text: desc }) : null));
  };

  const row = (label, control, forId, hint) => h('div', { class: 'setting-row' },
    h('label', { class: 'field-label', for: forId, text: label }),
    h('div', { class: 'setting-control' }, control, hint ? h('p', { class: 'field-help', text: hint }) : null));

  const dlg = openDialog({
    title: 'Settings',
    cls: 'dialog-medium',
    body: [
      h('h3', { class: 'dialog-section-title', text: 'This plan' }),
      row('Units', h('div', { class: 'segmented segmented-light', attrs: { role: 'group', 'aria-label': 'Units' } }, unitButtons), null),
      row('Wall height', h('div', {}, heightInput, heightError), 'set-height', 'Applies to new walls and rooms, and to existing full-height walls.'),
      row('Default ceiling', ceiling, 'set-ceiling', 'Used for new rooms.'),
      row('Surroundings', exterior, 'set-exterior', 'What you see through the windows in the walkthrough.'),
      h('h3', { class: 'dialog-section-title', text: 'Plan view' }),
      h('div', { class: 'check-list' },
        check('showGrid', 'Grid', 'Lines every 6 in, or every 10 cm in metric.'),
        check('showLabels', 'Room names and areas'),
        check('showDimensions', 'Overall dimensions')),
    ],
    actions: [h('button', { type: 'button', class: 'btn btn-primary', text: 'Done', on: { click: () => dlg.close('done') } })],
  });
  return dlg;
}

// ---- Help -------------------------------------------------------------------------------------------

const keys = (...k) => h('span', { class: 'keys' }, k.map((x) => (x === 'to' ? h('span', { class: 'keys-to', text: 'to' }) : h('kbd', { text: x }))));

function helpList(rows) {
  return h('dl', { class: 'help-list' }, rows.flatMap(([what, ...k]) => [
    h('dt', {}, k.filter(Boolean).length ? keys(...k.filter(Boolean)) : null),
    h('dd', { text: what }),
  ]));
}

export function openHelp() {
  const col = (title, intro, rows) => h('section', { class: 'help-col' },
    h('h3', { class: 'dialog-section-title', text: title }),
    intro ? h('p', { class: 'help-intro', text: intro }) : null,
    helpList(rows));
  return openDialog({
    title: 'Help and shortcuts',
    cls: 'dialog-wide dialog-help',
    body: h('div', { class: 'help-grid' },
      col('Tracing', 'Import a floor plan image from Open, or drop it on the window. Calibrate it, then trace over it.', [
        ['Calibrate: click both ends of a known length, then type the real length', ''],
        ['Wall tool. Click each corner, double-click or Esc to finish', 'W'],
        ['Type a length while drawing, then Enter, for an exact wall', '12\' 6"', 'Enter'],
        ['Room tool. Click inside closed walls to fill a room', 'R'],
        ['Door tool. Click a wall to place it', 'D'],
        ['Window tool', 'N'],
        ['Flip the door swing, or the hinge', 'F', 'Shift F'],
        ['Turn off snapping while you hold it', 'Shift'],
      ]),
      col('Layout', 'Pick an item in the library and click the plan, or drag the item onto the plan.', [
        ['Select tool', 'V'],
        ['Pan tool, or hold Space and drag', 'H', 'Space'],
        ['Rotate the selected or new item 15°, with Shift 90°', 'Q', 'E'],
        ['Duplicate the selected item', MOD, 'D'],
        ['Nudge the selection, with Shift in larger steps', '←', '→', '↑', '↓'],
        ['Delete the selection', 'Delete'],
        ['Viewpoint tool. Press, drag to aim, release', 'C'],
        ['Zoom to fit, zoom in, zoom out', '0', '+', '-'],
      ]),
      col('Walkthrough', 'Split shows the plan and the 3D view together. Double-click the plan to walk there.', [
        ['Look around', 'Drag'],
        ['Move', 'W', 'A', 'S', 'D'],
        ['Walk faster', 'Shift'],
        ['Walk to a spot on the floor', 'Click'],
        ['Zoom the view', 'Scroll'],
        ['Jump to a saved view', '1', 'to', '9'],
        ['Overview: drag to orbit, double-click to walk there', ''],
      ]),
      col('Everywhere', null, [
        ['Undo', MOD, 'Z'],
        ['Redo', MOD, 'Shift', 'Z'],
        ['Save the plan file', MOD, 'S'],
        ['Open a plan file', MOD, 'O'],
        ['Plan, Split or Walk', MOD, '1', '2', '3'],
        ['This help', '?'],
        ['Close a dialog or cancel', 'Esc'],
      ])),
  });
}
