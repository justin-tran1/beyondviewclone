// Left panel tool palette: drawing tools with their wall kind and door type pickers.
import { WALL_KINDS, OPENING_TYPES } from '../model.js';
import { getItem } from '../catalog/registry.js';
import { formatLength } from '../geometry.js';
import { h, iconEl } from './dom.js';
import { setPref } from './storage.js';

export const DOOR_TYPES = ['door', 'double-door', 'sliding-door', 'opening'];

const TOOLS = [
  { id: 'select', label: 'Select', icon: 'select', key: 'V', tip: 'Select and move' },
  { id: 'pan', label: 'Pan', icon: 'pan', key: 'H', tip: 'Pan the plan. You can also hold Space and drag.' },
  { id: 'wall', label: 'Wall', icon: 'wall', key: 'W', tip: 'Draw walls' },
  { id: 'room', label: 'Room', icon: 'room', key: 'R', tip: 'Fill or trace a room' },
  { id: 'door', label: 'Door', icon: 'door', key: 'D', tip: 'Place doors and openings' },
  { id: 'window', label: 'Window', icon: 'window', key: 'N', tip: 'Place windows' },
  { id: 'camera', label: 'Viewpoint', icon: 'camera', key: 'C', tip: 'Save a viewpoint for the walkthrough' },
  { id: 'calibrate', label: 'Calibrate', icon: 'calibrate', key: null, tip: 'Set the scale of the floor plan image' },
];

const WALL_CHOICES = [
  ['exterior', 'Exterior'],
  ['interior', 'Interior'],
  ['glass', 'Glass partition'],
  ['partial', 'Half-height'],
];

const toolGroup = (tool) => (DOOR_TYPES.includes(tool) ? 'door' : tool);

export function createTools(root, { store, editor, prefs }) {
  let doorType = DOOR_TYPES.includes(prefs.doorType) ? prefs.doorType : 'door';
  if (WALL_KINDS[prefs.wallKind]) editor.setWallKind(prefs.wallKind);

  const buttons = TOOLS.map((t) => {
    const b = h('button', {
      type: 'button', class: 'tool', dataset: { tool: t.id, tip: t.tip, ...(t.key ? { key: t.key } : {}) },
      attrs: { 'aria-pressed': 'false', 'aria-keyshortcuts': t.key || null },
      on: { click: () => activate(t.id) },
    }, iconEl(t.icon), h('span', { class: 'tool-label', text: t.label }));
    return b;
  });
  const grid = h('div', { class: 'tool-grid', attrs: { role: 'group', 'aria-label': 'Drawing tools' } }, buttons);
  const options = h('div', { class: 'tool-options' });
  root.append(h('div', { class: 'panel-heading' }, h('h2', { class: 'panel-title', text: 'Tools' })), grid, options);

  function activate(id) {
    if (id === 'door') editor.setTool(doorType);
    else editor.setTool(id);
    editor.canvas.focus({ preventScroll: true });
  }

  function choiceGroup(label, choices, current, onPick) {
    const group = h('div', { class: 'choice-group', attrs: { role: 'radiogroup', 'aria-label': label } });
    for (const c of choices) {
      const on = c.value === current;
      group.append(h('button', {
        type: 'button', class: 'choice', attrs: { role: 'radio', 'aria-checked': String(on), tabindex: on ? '0' : '-1' },
        dataset: { value: c.value },
        on: { click: () => onPick(c.value) },
      }, h('span', { class: 'choice-visual' }, c.visual), h('span', { class: 'choice-label', text: c.label }), h('span', { class: 'choice-meta', text: c.meta })));
    }
    group.addEventListener('keydown', (e) => {
      const all = [...group.querySelectorAll('.choice')];
      const i = all.indexOf(document.activeElement);
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step || i < 0) return;
      e.preventDefault();
      const next = all[(i + step + all.length) % all.length];
      next.focus();
      next.click();
    });
    return h('div', { class: 'tool-option' }, h('div', { class: 'option-label', text: label }), group);
  }

  function renderOptions() {
    const tool = editor.tool;
    const units = store.plan.units;
    options.replaceChildren();
    if (tool === 'wall') {
      const choices = WALL_CHOICES.map(([value, label]) => ({
        value, label, meta: formatLength(WALL_KINDS[value].thickness, units),
        visual: h('span', { class: `wall-swatch wall-swatch-${value}`, attrs: { 'aria-hidden': 'true' } }),
      }));
      options.append(choiceGroup('Wall type', choices, editor.wallKind, (kind) => {
        editor.setWallKind(kind);
        setPref(prefs, 'wallKind', kind);
        renderOptions();
        options.querySelector(`[data-value="${kind}"]`)?.focus();
      }));
    } else if (DOOR_TYPES.includes(tool)) {
      const choices = DOOR_TYPES.map((value) => ({
        value, label: OPENING_TYPES[value].label, meta: formatLength(OPENING_TYPES[value].width, units),
        visual: iconEl(value, 'icon choice-icon'),
      }));
      options.append(choiceGroup('Door type', choices, tool, (type) => {
        doorType = type;
        setPref(prefs, 'doorType', type);
        editor.setTool(type);
        options.querySelector(`[data-value="${type}"]`)?.focus();
      }));
    } else if (tool === 'item' && editor.pendingItem) {
      const def = getItem(editor.pendingItem);
      options.append(h('div', { class: 'tool-option placing' },
        h('div', { class: 'option-label', text: 'Placing' }),
        h('div', { class: 'placing-row' },
          h('span', { class: 'placing-name', text: def.name }),
          h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Done', on: { click: () => activate('select') } })),
        h('p', { class: 'option-hint', text: 'Click the plan to place. Q and E rotate. Esc when done.' })));
    }
  }

  function sync() {
    const group = toolGroup(editor.tool);
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.tool === group));
    renderOptions();
  }

  editor.addEventListener('toolchange', sync);
  let units = store.plan.units;
  store.addEventListener('change', () => {
    if (store.plan.units === units) return;
    units = store.plan.units;
    renderOptions();
  });
  sync();
  return { sync, activate };
}
