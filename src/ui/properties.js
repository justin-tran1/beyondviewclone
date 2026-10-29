// Right panel: properties of the selection, or the plan overview when nothing is selected.
// Every committed field change is one undoable store.update; sliders coalesce into one step.
import {
  WALL_KINDS, OPENING_TYPES, CEILINGS, findEntity, moveWallEndpoint, clampOpenings, addItem,
} from '../model.js';
import {
  FINISH_PARTS, GUARDS, PACKAGES, WALL_COLORS, CASEWORK_COLORS, WORKSURFACES, setFinish, applyPackage, packageOf, finishColor, copyFinishes, roomUse,
} from '../finishes.js';
import { getItem, itemDims, hasItem } from '../catalog/registry.js';
import {
  formatLength, parseLength, formatArea, polygonArea, wallLength, wallDir, wallNormal, normDeg, clamp,
  add, sub, scale, dot, rotate, projectToSegment, openingSpan,
} from '../geometry.js';
import { h, iconEl, MOD } from './dom.js';
import { categoryLabel } from './library.js';
import { toast } from './widgets.js';

/** Finish colors offered for upholstered and soft items. */
export const SWATCHES = [
  ['#003F2D', 'CBRE green'], ['#012A2D', 'Dark green'], ['#538184', 'Sage'], ['#80BBAD', 'Celadon'],
  ['#DBD99A', 'Wheat'], ['#032842', 'Midnight'], ['#435254', 'Dark grey'], ['#7F8480', 'Cement'], ['#CAD1D3', 'Light grey'],
];
export const isFabric = (def) => def.colorable === true;

const DOORS = new Set(['door', 'double-door', 'sliding-door']);
const HINGED = new Set(['door', 'sliding-door']);
const KIND_TITLE = { wall: 'Wall', opening: 'Opening', room: 'Room', item: 'Item', camera: 'Viewpoint' };
const LENGTH_HINT = 'Enter a length such as 12\' 6", 12.5 or 3.8 m.';
const OPENING_GAP = 0.05;

let fieldSerial = 0;

/**
 * The stretch of its wall (meters from wall.a) an opening can use: clear of the walls joined at the
 * ends or along it and of its neighbors, with the same gaps the editor keeps. Always includes the
 * opening's current span.
 */
function openingRoom(plan, wall, o) {
  const L = wallLength(wall);
  const u = wallDir(wall);
  const span = openingSpan(wall, o);
  let lo = 0, hi = L;
  for (const w of plan.walls) {
    if (w.id === wall.id) continue;
    const t = w.thickness / 2 + OPENING_GAP;
    if (projectToSegment(wall.a, w.a, w.b).dist < 2e-3) lo = Math.max(lo, t);
    if (projectToSegment(wall.b, w.a, w.b).dist < 2e-3) hi = Math.min(hi, L - t);
    for (const p of [w.a, w.b]) {
      const pr = projectToSegment(p, wall.a, wall.b);
      if (pr.dist > 2e-3 || pr.t <= 1e-6 || pr.t >= 1 - 1e-6) continue;
      const along = dot(sub(p, wall.a), u);
      if (along <= span.center) lo = Math.max(lo, along + t);
      else hi = Math.min(hi, along - t);
    }
  }
  for (const other of plan.openings) {
    if (other.wallId !== wall.id || other.id === o.id) continue;
    const s = openingSpan(wall, other);
    if (s.center <= span.center) lo = Math.max(lo, s.end + OPENING_GAP);
    else hi = Math.min(hi, s.start - OPENING_GAP);
  }
  return { lo: Math.min(lo, span.start), hi: Math.max(hi, span.end) };
}

/** Give a draft opening a width that fits beside its neighbors, moving it along the wall only as needed. */
function fitOpening(draft, o, width) {
  const wall = findEntity(draft, 'wall', o.wallId);
  if (!wall) return;
  const room = openingRoom(draft, wall, o);
  const center = openingSpan(wall, o).center;
  o.width = Math.max(0.2, Math.min(width, room.hi - room.lo));
  o.offset = clamp(center, room.lo + o.width / 2, Math.max(room.lo + o.width / 2, room.hi - o.width / 2));
  clampOpenings(draft);
}

/** The front direction of an item on the plan (its local +y). */
const itemFront = (it) => rotate({ x: 0, y: 1 }, it.rotation || 0);

/** True when an item's back edge sits on a wall face, as it does when placed against a wall. */
function backOnWall(plan, it, dims) {
  const front = itemFront(it);
  const back = sub(it, scale(front, dims.d / 2));
  return plan.walls.some((w) => {
    const n = wallNormal(w);
    const facing = dot(front, n);
    if (Math.abs(facing) < 0.99) return false;
    const rel = sub(back, w.a);
    const along = dot(rel, wallDir(w)), off = dot(rel, n);
    return along > -0.05 && along < wallLength(w) + 0.05 && facing * off > 0 && Math.abs(Math.abs(off) - w.thickness / 2) < 0.03;
  });
}

export function createProperties(root, { store, editor, actions }) {
  const header = h('div', { class: 'props-header' });
  const body = h('div', { class: 'props-body' });
  root.append(header, body);
  let current = { key: null, sig: null, syncers: [] };
  let raf = 0;
  let sliderSerial = 0;

  const units = () => store.plan.units;
  const fmt = (m) => formatLength(m, units());

  function edit(kind, id, label, fn, opts = {}) {
    store.update((d) => {
      const e = findEntity(d, kind, id);
      if (e) fn(e, d);
    }, { label, ...opts });
  }

  // ---- Field builders (each registers a sync function) -------------------------------------

  function makeBuilder(syncers) {
    const row = (label, control, id, extra) => h('div', { class: 'prop-row' },
      h('label', { class: 'prop-label', for: id, text: label }),
      h('div', { class: 'prop-control' }, control, extra || null));

    const sync = (fn) => { syncers.push(fn); fn(); };
    const focused = (el) => document.activeElement === el;
    // Enter and Esc hand the keyboard back to the plan, so its shortcuts work right away.
    const toPlan = () => editor.canvas.focus({ preventScroll: true });
    const commitKeys = (input, revert) => input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); toPlan(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); revert(); toPlan(); }
    });

    /** A message under a field: an error (the value was not used) or a note (it was adjusted). */
    function showError(input, msg, { note = false } = {}) {
      const wrap = input.closest('.prop-row');
      if (note) input.removeAttribute('aria-invalid');
      else input.setAttribute('aria-invalid', 'true');
      let el = wrap.querySelector('.prop-error');
      if (!el) {
        el = h('div', { class: 'prop-error', id: `${input.id}-err`, attrs: { role: 'alert' } });
        wrap.append(el);
        input.setAttribute('aria-describedby', el.id);
      }
      el.classList.toggle('prop-error-note', note);
      el.textContent = msg;
    }
    function clearError(input) {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
      input.closest('.prop-row')?.querySelector('.prop-error')?.remove();
    }

    return {
      watch: sync,

      text({ label, get, set, placeholder, name }) {
        const id = `f${++fieldSerial}`;
        const input = h('input', { type: 'text', class: 'input', id, placeholder, attrs: { autocomplete: 'off', spellcheck: 'false' }, dataset: { field: name || label } });
        const revert = () => { input.value = get(); };
        input.addEventListener('change', () => {
          const v = input.value.trim();
          if (v !== get()) set(v);
          else revert();
        });
        commitKeys(input, revert);
        sync(() => { if (!focused(input)) revert(); });
        return row(label, input, id);
      },

      /** `limit()` optionally caps the value further: larger entries are reduced to it, with a note. */
      length({ label, get, set, min = 0.01, max = 500, limit, name }) {
        const id = `f${++fieldSerial}`;
        const input = h('input', { type: 'text', class: 'input input-length', id, attrs: { autocomplete: 'off', spellcheck: 'false' }, dataset: { field: name || label } });
        const revert = () => { input.value = fmt(get()); };
        input.addEventListener('input', () => clearError(input));
        input.addEventListener('change', () => {
          let m = parseLength(input.value, units());
          if (!Number.isFinite(m)) {
            showError(input, LENGTH_HINT);
            revert();
            return;
          }
          if (m < min - 1e-9 || m > max + 1e-9) {
            showError(input, `Use a length between ${fmt(min)} and ${fmt(max)}.`);
            revert();
            return;
          }
          clearError(input);
          const cap = limit?.();
          if (cap !== undefined && m > cap + 1e-6) {
            m = cap;
            showError(input, `Limited to ${fmt(cap)}, the free space on this wall.`, { note: true });
          }
          if (Math.abs(m - get()) > 1e-6) set(m);
          revert();
        });
        commitKeys(input, () => { clearError(input); revert(); });
        sync(() => { if (!focused(input)) revert(); });
        return row(label, input, id);
      },

      number({ label, get, set, min = -Infinity, max = Infinity, suffix = '', step = 1, name, wrap }) {
        const id = `f${++fieldSerial}`;
        const input = h('input', { type: 'number', class: 'input input-number', id, step, attrs: { min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null }, dataset: { field: name || label } });
        const show = () => { input.value = String(Math.round(get() * 10) / 10); };
        input.addEventListener('change', () => {
          let v = parseFloat(input.value);
          if (!Number.isFinite(v)) { show(); return; }
          v = wrap ? wrap(v) : clamp(v, min, max);
          if (Math.abs(v - get()) > 1e-6) set(v);
          show();
        });
        commitKeys(input, show);
        sync(() => { if (!focused(input)) show(); });
        const box = h('div', { class: 'input-suffix' }, input, suffix ? h('span', { class: 'suffix', text: suffix, attrs: { 'aria-hidden': 'true' } }) : null);
        return { row: (extra) => row(label, box, id, extra), input };
      },

      /** options: [[value, text, disabled]]; groups: [[label, options]], listed after them. */
      select({ label, options = [], groups = [], get, set, name }) {
        const id = `f${++fieldSerial}`;
        const option = ([value, text, disabled]) => h('option', { value, text, disabled: !!disabled });
        const sel = h('select', { class: 'input select', id, dataset: { field: name || label } },
          options.map(option), groups.map(([group, list]) => h('optgroup', { label: group }, list.map(option))));
        sel.addEventListener('change', () => { if (sel.value !== get()) set(sel.value); });
        sync(() => { sel.value = get(); });
        return row(label, h('div', { class: 'select-wrap' }, sel, iconEl('chevron-down', 'icon select-chevron')), id);
      },

      range({ label, min, max, step, get, set, format, name }) {
        const id = `f${++fieldSerial}`;
        const input = h('input', { type: 'range', class: 'range', id, min, max, step, dataset: { field: name || label } });
        const out = h('output', { class: 'range-value', attrs: { for: id } });
        let key = null;
        input.addEventListener('input', () => {
          if (!key) key = `range-${++sliderSerial}`;
          set(parseFloat(input.value), key);
          out.textContent = format(parseFloat(input.value));
        });
        input.addEventListener('change', () => { key = null; store.endCoalesce(); });
        sync(() => {
          if (!focused(input) || !key) input.value = String(get());
          out.textContent = format(get());
        });
        return row(label, h('div', { class: 'range-wrap' }, input, out), id);
      },

      readout({ label, get }) {
        const value = h('div', { class: 'readout' });
        sync(() => { value.textContent = get(); });
        return h('div', { class: 'prop-row' }, h('span', { class: 'prop-label', text: label }), h('div', { class: 'prop-control' }, value));
      },

      toggle({ text, icon: on, iconOff, get, set, tip }) {
        const btn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm toggle-btn', dataset: { tip } });
        const draw = () => {
          const v = get();
          btn.setAttribute('aria-pressed', String(v));
          btn.replaceChildren(iconEl(v ? on : iconOff || on), h('span', { class: 'btn-label', text: text(v) }));
        };
        btn.addEventListener('click', () => set(!get()));
        sync(draw);
        return btn;
      },
    };
  }

  const section = (title, ...children) => h('section', { class: 'prop-section' },
    title ? h('h3', { class: 'prop-section-title', text: title }) : null, ...children);
  const actionsRow = (...btns) => h('div', { class: 'prop-actions' }, btns);
  const btn = (text, icon, onClick, cls = 'btn btn-secondary btn-sm', tip) => h('button', { type: 'button', class: cls, dataset: tip ? { tip } : {}, on: { click: onClick } }, iconEl(icon), h('span', { class: 'btn-label', text }));
  const deleteBtn = (what) => btn(`Delete ${what}`, 'trash', () => store.deleteSelection(), 'btn btn-secondary btn-sm btn-danger', 'Delete');

  // ---- Sections per selection kind ------------------------------------------------------------

  function wallPanel(b, w) {
    const id = w.id;
    const get = (fn) => () => { const e = findEntity(store.plan, 'wall', id); return e ? fn(e) : 0; };
    return [
      section(null,
        b.select({
          label: 'Type', name: 'kind', options: Object.entries(WALL_KINDS).map(([k, v]) => [k, v.label]), get: get((e) => e.kind),
          set: (kind) => edit('wall', id, 'Change wall type', (e, d) => {
            const k = WALL_KINDS[kind];
            const wasPartial = e.kind === 'partial';
            e.kind = kind;
            e.thickness = k.thickness;
            if (kind === 'partial') e.height = k.height;
            else if (wasPartial) e.height = d.settings.wallHeight;
          }),
        }),
        b.length({
          label: 'Length', name: 'length', min: 0.05, max: 500, get: get((e) => wallLength(e)),
          set: (L) => store.update((d) => {
            const e = findEntity(d, 'wall', id);
            if (!e) return;
            const dir = wallDir(e);
            moveWallEndpoint(d, id, 'b', { x: e.a.x + dir.x * L, y: e.a.y + dir.y * L });
          }, { label: 'Change wall length' }),
        }),
        b.length({
          label: 'Thickness', name: 'thickness', min: 0.02, max: 1.5, get: get((e) => e.thickness),
          set: (v) => edit('wall', id, 'Change wall thickness', (e) => { e.thickness = v; }),
        }),
        b.length({
          label: 'Height', name: 'height', min: 0.3, max: 12, get: get((e) => e.height),
          set: (v) => edit('wall', id, 'Change wall height', (e) => { e.height = v; }),
        }),
        b.readout({ label: 'Openings', get: () => {
          const n = store.plan.openings.filter((o) => o.wallId === id).length;
          return n ? `${n} ${n === 1 ? 'door or window' : 'doors and windows'}` : 'None';
        } })),
      h('p', { class: 'prop-note', text: 'Changing the length moves the end point. Joined walls follow.' }),
      actionsRow(deleteBtn('wall')),
    ];
  }

  function openingPanel(b, o) {
    const id = o.id;
    const get = (fn) => () => { const e = findEntity(store.plan, 'opening', id); return e ? fn(e) : 0; };
    const freeWidth = () => {
      const e = findEntity(store.plan, 'opening', id);
      const w = e && findEntity(store.plan, 'wall', e.wallId);
      if (!w) return undefined;
      const room = openingRoom(store.plan, w, e);
      return room.hi - room.lo;
    };
    const rows = [
      b.select({
        label: 'Type', name: 'type', options: Object.entries(OPENING_TYPES).map(([k, v]) => [k, v.label]), get: get((e) => e.type),
        set: (type) => store.update((d) => {
          const e = findEntity(d, 'opening', id);
          if (!e) return;
          const t = OPENING_TYPES[type];
          Object.assign(e, { type, height: t.height, sill: t.sill });
          fitOpening(d, e, t.width);
        }, { label: 'Change opening type' }),
      }),
      b.length({
        label: 'Width', name: 'width', min: 0.2, max: 20, limit: freeWidth, get: get((e) => e.width),
        set: (v) => store.update((d) => {
          const e = findEntity(d, 'opening', id);
          if (e) fitOpening(d, e, v);
        }, { label: 'Change opening width' }),
      }),
      b.length({
        label: 'Height', name: 'height', min: 0.2, max: 12, get: get((e) => e.height),
        set: (v) => edit('opening', id, 'Change opening height', (e) => { e.height = v; }),
      }),
    ];
    if (o.type === 'window') {
      rows.push(b.length({
        label: 'Sill height', name: 'sill', min: 0, max: 6, get: get((e) => e.sill),
        set: (v) => edit('opening', id, 'Change sill height', (e) => { e.sill = v; }),
      }));
    }
    const flips = [];
    if (DOORS.has(o.type)) {
      flips.push(btn('Flip swing', 'flip', () => edit('opening', id, 'Flip door swing', (e) => { e.side = e.side < 0 ? 1 : -1; }), undefined, 'Swing to the other side (F)'));
    }
    if (HINGED.has(o.type)) {
      flips.push(btn('Flip hinge', 'hinge', () => edit('opening', id, 'Flip door hinge', (e) => { e.hinge = e.hinge === 'end' ? 'start' : 'end'; }), undefined, 'Hinge on the other jamb (Shift+F)'));
    }
    return [
      section(null, ...rows),
      flips.length ? section('Swing', actionsRow(...flips)) : null,
      actionsRow(deleteBtn(o.type === 'window' ? 'window' : o.type === 'opening' ? 'opening' : 'door')),
    ];
  }

  function roomPanel(b, r) {
    const id = r.id;
    const room = () => findEntity(store.plan, 'room', id);
    const get = (fn) => () => { const e = room(); return e ? fn(e) : ''; };
    const byGroup = (table) => [...new Set(Object.values(table).map((v) => v.group))]
      .map((group) => [group, Object.entries(table).filter(([, v]) => v.group === group).map(([k, v]) => [k, v.label])]);
    // The use its furniture tells, for applying these finishes to every room of that use.
    const use = roomUse(store.plan, r);
    const copyTo = (label, pick) => {
      const src = room();
      if (!src) return;
      const targets = store.plan.rooms.filter((e) => e.id !== id && pick(e)).map((e) => e.id);
      if (!targets.length) {
        toast('There are no other rooms to apply these finishes to.', { type: 'info' });
        return;
      }
      store.update((d) => { for (const e of d.rooms) if (targets.includes(e.id)) copyFinishes(src, e); }, { label });
      toast(`Finishes applied to ${targets.length} more ${targets.length === 1 ? 'room' : 'rooms'}`, { action: { label: 'Undo', onClick: () => store.undo() } });
    };
    return [
      section(null,
        b.text({ label: 'Name', name: 'name', get: get((e) => e.name), set: (v) => edit('room', id, 'Rename room', (e) => { e.name = v || 'Room'; }) }),
        b.readout({ label: 'Area', get: get((e) => formatArea(polygonArea(e.points), units())) })),
      section('Finishes',
        b.select({
          label: 'Package', name: 'package', options: [['custom', 'Custom', true]], groups: byGroup(PACKAGES),
          get: get((e) => packageOf(e) || 'custom'),
          set: (v) => edit('room', id, `Use ${PACKAGES[v].label.toLowerCase()} finishes`, (e) => applyPackage(e, v)),
        }),
        finishField(b, id, 'floor', 'Floor', byGroup),
        finishField(b, id, 'wall', 'Walls'),
        finishField(b, id, 'wainscot', 'Wainscot'),
        finishField(b, id, 'base', 'Base'),
        b.select({
          label: 'Protection', name: 'guard', options: Object.entries(GUARDS).map(([k, v]) => [k, v.label]), get: get((e) => e.guard ?? 'none'),
          set: (v) => edit('room', id, 'Change wall protection', (e) => setFinish(e, 'guard', v)),
        }),
        b.select({
          label: 'Ceiling', name: 'ceiling', options: Object.entries(CEILINGS).map(([k, v]) => [k, v.label]), get: get((e) => e.ceiling),
          set: (v) => edit('room', id, 'Change ceiling type', (e) => { e.ceiling = v; }),
        }),
        b.length({
          label: 'Ceiling height', name: 'ceilingHeight', min: 2, max: 20,
          get: () => { const e = room(); return e ? e.height ?? store.plan.settings.wallHeight : 0; },
          set: (v) => edit('room', id, 'Change ceiling height', (e) => { e.height = v; }),
        }),
        actionsRow(
          use ? btn(`Apply to all ${PACKAGES[use].rooms}`, 'duplicate', () => copyTo(`Apply finishes to all ${PACKAGES[use].rooms}`, (e) => roomUse(store.plan, e) === use),
            undefined, `Give the other ${PACKAGES[use].rooms} (known by their furniture) these finishes`) : null,
          btn('Apply to all rooms', 'duplicate', () => copyTo('Apply finishes to all rooms', () => true), undefined, 'Give every room these finishes'))),
      actionsRow(deleteBtn('room')),
    ];
  }

  /**
   * A room's finish of one part (FINISH_PARTS): its options, in groups when byGroup is given, and
   * under them the colors that finish comes in. Paint and coatings take any color too.
   */
  function finishField(b, id, part, label, byGroup) {
    const spec = FINISH_PARTS[part];
    const room = () => findEntity(store.plan, 'room', id);
    const key = () => room()?.[part] ?? spec.fallback;
    const all = Object.entries(spec.options).map(([k, v]) => [k, v.label]);
    const row = b.select({
      label, name: part, options: byGroup ? [] : all, groups: byGroup ? byGroup(spec.options) : [], get: key,
      set: (v) => edit('room', id, `Change ${label.toLowerCase()} finish`, (e) => setFinish(e, part, v)),
    });
    const colors = spec.options[key()]?.colors || [];
    const anyColor = colors === WALL_COLORS;
    if (colors.length > 1 || anyColor) {
      const setColor = (hex, opts) => edit('room', id, `Change ${label.toLowerCase()} color`, (e) => setFinish(e, part, e[part], hex), opts);
      const current = () => { const e = room(); return e ? finishColor(e, part) || '' : ''; };
      const group = swatchRow(b, { label: `${label} color`, choices: colors, get: current, set: setColor });
      if (anyColor) group.append(customColor(b, label, colors, current, setColor));
      row.append(h('div', { class: 'prop-swatches' }, group));
    }
    return row;
  }

  /** A swatch that opens the color picker; it shows the color chosen when no swatch has it. */
  function customColor(b, label, colors, current, set) {
    const input = h('input', { type: 'color', class: 'swatch-input', attrs: { 'aria-label': `Other ${label.toLowerCase()} color` } });
    const el = h('span', { class: 'swatch swatch-custom', dataset: { tip: 'Other color' } }, input);
    let key = null;
    // Dragging in the picker is one undo step.
    input.addEventListener('input', () => {
      if (!key) key = `color-${++sliderSerial}`;
      set(input.value, { coalesce: key });
    });
    input.addEventListener('change', () => { key = null; store.endCoalesce(); });
    b.watch(() => {
      const c = current();
      const other = !colors.some(([hex]) => hex.toLowerCase() === c.toLowerCase());
      el.classList.toggle('is-custom', other);
      el.style.setProperty('--swatch', c);
      if (!key && c) input.value = c;
    });
    return el;
  }

  function itemPanel(b, it) {
    const id = it.id;
    const def = getItem(it.type);
    const get = (fn) => () => { const e = findEntity(store.plan, 'item', id); return e ? fn(e) : 0; };
    const rotate = (delta) => edit('item', id, 'Rotate item', (e) => { e.rotation = normDeg((e.rotation || 0) + delta); });
    const rot = b.number({
      label: 'Rotation', name: 'rotation', suffix: '°', step: 15, get: get((e) => normDeg(e.rotation || 0)), wrap: (v) => normDeg(v),
      set: (v) => edit('item', id, 'Rotate item', (e) => { e.rotation = v; }),
    });
    const rotButtons = h('div', { class: 'icon-pair' },
      h('button', { type: 'button', class: 'icon-btn icon-btn-sm', dataset: { tip: 'Rotate 90° left', key: 'Shift Q' }, attrs: { 'aria-label': 'Rotate 90 degrees left' }, on: { click: () => rotate(-90) } }, iconEl('rotate-left')),
      h('button', { type: 'button', class: 'icon-btn icon-btn-sm', dataset: { tip: 'Rotate 90° right', key: 'Shift E' }, attrs: { 'aria-label': 'Rotate 90 degrees right' }, on: { click: () => rotate(90) } }, iconEl('rotate-right')));
    const main = [
      b.text({ label: 'Label', name: 'label', placeholder: 'Optional', get: get((e) => e.label || ''), set: (v) => edit('item', id, 'Change item label', (e) => { if (v) e.label = v; else delete e.label; }) }),
      rot.row(rotButtons),
    ];
    let sizeSection = null;
    if (def.resizable) {
      const dim = (key, label, max) => b.length({
        label, name: key, min: 0.05, max, get: get((e) => itemDims(e)[key]),
        set: (v) => edit('item', id, `Resize ${def.name.toLowerCase()}`, (e, d) => {
          // Against a wall the back stays on the wall face and the item grows into the room.
          const dims = itemDims(e);
          if (key === 'd' && backOnWall(d, e, dims)) Object.assign(e, add(e, scale(itemFront(e), (v - dims.d) / 2)));
          e[key] = v;
        }),
      });
      sizeSection = section('Size', dim('w', 'Width', 50), dim('d', 'Depth', 50),
        def.resizableHeight ? dim('h', 'Height', 20) : b.readout({ label: 'Height', get: get((e) => fmt(itemDims(e).h)) }));
    } else {
      main.push(b.readout({ label: 'Size', get: get((e) => { const s = itemDims(e); return `${fmt(s.w)} × ${fmt(s.d)} × ${fmt(s.h)}`; }) }));
    }
    const out = [section(null, ...main), sizeSection];
    if (isFabric(def)) out.push(section('Finish', swatches(b, id)));
    if (def.colorable === 'casework' || def.worksurface) out.push(section('Finish', ...caseworkFields(b, id, def)));
    out.push(actionsRow(
      btn('Duplicate', 'duplicate', () => duplicateItem(id), undefined, `Duplicate (${MOD}+D)`),
      deleteBtn('item')));
    if (!hasItem(it.type)) out.unshift(h('p', { class: 'prop-note', text: `This item type ("${it.type}") is not in the library, so it shows as a placeholder.` }));
    return out;
  }

  /** Casework color (CASEWORK_COLORS, or as made) and the counter or bench top. */
  function caseworkFields(b, id, def) {
    const rows = [];
    if (def.colorable === 'casework') {
      const group = swatchRow(b, {
        label: 'Casework color', choices: [['', 'As made'], ...CASEWORK_COLORS.map(([hex, name]) => [hex, name])],
        get: () => findEntity(store.plan, 'item', id)?.color || '',
        set: (value) => edit('item', id, 'Change casework color', (e) => { if (value) e.color = value; else delete e.color; }),
      });
      rows.push(h('div', { class: 'prop-row' }, h('span', { class: 'prop-label', text: 'Casework' }), h('div', { class: 'prop-control' }, group)));
    }
    if (def.worksurface) {
      rows.push(b.select({
        label: 'Worksurface', name: 'top', options: Object.entries(WORKSURFACES).map(([k, v]) => [k, v.label]),
        get: () => findEntity(store.plan, 'item', id)?.top || def.worksurface,
        set: (v) => edit('item', id, 'Change worksurface', (e) => { if (v === def.worksurface) delete e.top; else e.top = v; }),
      }));
    }
    return rows;
  }

  function swatches(b, id) {
    return swatchRow(b, {
      label: 'Finish color', choices: [['', 'Default finish'], ...SWATCHES],
      get: () => findEntity(store.plan, 'item', id)?.color || '',
      set: (value) => edit('item', id, 'Change finish', (e) => { if (value) e.color = value; else delete e.color; }),
    });
  }

  /** Color swatches as a radio group: choices [[hex, name]] ('' for a default finish), get() the color shown. */
  function swatchRow(b, { label, choices, get, set }) {
    const els = choices.map(([value, name]) => h('button', {
      type: 'button', class: `swatch${value ? '' : ' swatch-default'}`, dataset: { tip: name, value },
      style: value ? { '--swatch': value } : {},
      attrs: { role: 'radio', 'aria-label': name },
      on: { click: () => set(value) },
    }));
    const group = h('div', { class: 'swatches', attrs: { role: 'radiogroup', 'aria-label': label } }, els);
    group.addEventListener('keydown', (e) => {
      const i = els.indexOf(document.activeElement);
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step || i < 0) return;
      e.preventDefault();
      const next = els[(i + step + els.length) % els.length];
      next.focus();
      next.click();
    });
    b.watch(() => {
      const c = get().toUpperCase();
      const on = els.map((el) => el.dataset.value.toUpperCase() === c);
      els.forEach((el, k) => {
        el.setAttribute('aria-checked', String(on[k]));
        // The group stays reachable by Tab when another color is in use.
        el.tabIndex = on[k] || (k === 0 && !on.includes(true)) ? 0 : -1;
      });
    });
    return group;
  }

  function duplicateItem(id) {
    const src = findEntity(store.plan, 'item', id);
    if (!src) return;
    let newId = null;
    store.update((d) => {
      const props = { rotation: src.rotation };
      for (const k of ['w', 'd', 'h', 'color', 'top', 'label']) if (src[k] !== undefined) props[k] = src[k];
      const copy = addItem(d, src.type, src.x + 0.3, src.y + 0.3, props);
      if (src.elevation !== undefined) copy.elevation = src.elevation;
      newId = copy.id;
    }, { label: 'Duplicate item' });
    if (newId) store.select({ kind: 'item', id: newId });
  }

  function cameraPanel(b, c) {
    const id = c.id;
    const get = (fn) => () => { const e = findEntity(store.plan, 'camera', id); return e ? fn(e) : 0; };
    const aim = (delta) => edit('camera', id, 'Aim view', (e) => { e.yaw = normDeg((e.yaw || 0) + delta); });
    const yaw = b.number({
      label: 'Direction', name: 'yaw', suffix: '°', step: 15, get: get((e) => normDeg(e.yaw || 0)), wrap: (v) => normDeg(v),
      set: (v) => edit('camera', id, 'Aim view', (e) => { e.yaw = v; }),
    });
    const aimButtons = h('div', { class: 'icon-pair' },
      h('button', { type: 'button', class: 'icon-btn icon-btn-sm', dataset: { tip: 'Turn 45° left' }, attrs: { 'aria-label': 'Turn 45 degrees left' }, on: { click: () => aim(-45) } }, iconEl('rotate-left')),
      h('button', { type: 'button', class: 'icon-btn icon-btn-sm', dataset: { tip: 'Turn 45° right' }, attrs: { 'aria-label': 'Turn 45 degrees right' }, on: { click: () => aim(45) } }, iconEl('rotate-right')));
    const index = store.plan.cameras.findIndex((e) => e.id === id);
    return [
      section(null,
        b.text({ label: 'Name', name: 'name', get: get((e) => e.name), set: (v) => edit('camera', id, 'Rename view', (e) => { e.name = v || 'View'; }) }),
        yaw.row(aimButtons),
        index >= 0 && index < 9 ? h('div', { class: 'prop-row' }, h('span', { class: 'prop-label', text: 'Shortcut' }),
          h('div', { class: 'prop-control readout' }, h('kbd', { text: String(index + 1) }), h('span', { text: 'while walking' }))) : null),
      actionsRow(
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', on: { click: () => actions.walkToCamera(id) } }, iconEl('person'), h('span', { class: 'btn-label', text: 'Walk to this view' })),
        deleteBtn('view')),
    ];
  }

  // ---- Plan overview ------------------------------------------------------------------------------

  function overviewPanel(b) {
    const plan = store.plan;
    const stat = (label, get, cls = '') => {
      const v = h('span', { class: `stat-value ${cls}` });
      b.watch(() => { v.textContent = get(); });
      return h('div', { class: `stat${cls ? ' stat-wide' : ''}` }, v, h('span', { class: 'stat-label', text: label }));
    };
    const count = (fn) => () => fn(store.plan).toLocaleString('en-US');
    const area = () => formatArea(store.plan.rooms.reduce((s, r) => s + polygonArea(r.points), 0), units());
    const stats = h('div', { class: 'stats' },
      stat('Total room area', area, 'stat-big'),
      stat('Rooms', count((p) => p.rooms.length)),
      stat('Walls', count((p) => p.walls.length)),
      stat('Doors', count((p) => p.openings.filter((o) => o.type !== 'window').length)),
      stat('Windows', count((p) => p.openings.filter((o) => o.type === 'window').length)),
      stat('Items', count((p) => p.items.length)),
      stat('Views', count((p) => p.cameras.length)));

    return [
      section(null, b.text({ label: 'Name', name: 'planName', get: () => store.plan.name, set: (v) => store.update((d) => { d.name = v || 'Untitled plan'; }, { label: 'Rename plan' }) })),
      section('Summary', stats),
      finishesSection(plan),
      imageSection(b, plan),
      viewsSection(plan),
    ];
  }

  function finishesSection(plan) {
    if (!plan.rooms.length) return null;
    const match = () => {
      // Only rooms whose furniture tells their use, and that do not have its finishes yet.
      const ids = store.plan.rooms.filter((r) => { const use = roomUse(store.plan, r); return use && packageOf(r) !== use; }).map((r) => r.id);
      if (!ids.length) {
        toast(store.plan.rooms.some((r) => roomUse(store.plan, r))
          ? 'Every room whose furniture shows its use has the finishes for it.'
          : 'No room has furniture that shows its use. Place exam tables, lab benches, toilets or desks, or select a room to choose its finishes.', { type: 'info', duration: 7000 });
        return;
      }
      store.update((d) => { for (const r of d.rooms) if (ids.includes(r.id)) applyPackage(r, roomUse(d, r)); }, { label: 'Match finishes to room use' });
      toast(`Finishes set for ${ids.length} ${ids.length === 1 ? 'room' : 'rooms'} from the furniture in them`, { action: { label: 'Undo', onClick: () => store.undo() } });
    };
    return section('Finishes',
      h('p', { class: 'prop-note', text: 'Select a room to choose its floor, walls, base, wall protection and ceiling, or a package of finishes for its use.' }),
      actionsRow(btn('Match finishes to room use', 'wand', match, undefined, 'Give exam rooms, restrooms, labs and other rooms the finishes their furniture calls for')));
  }

  function imageSection(b, plan) {
    const u = plan.underlay;
    if (!u) {
      return section('Floor plan image',
        h('p', { class: 'prop-note', text: 'Import a floor plan drawing to find its walls, doors, rooms and furniture. PDF, PNG, JPG, WebP and SVG work.' }),
        actionsRow(h('button', { type: 'button', class: 'btn btn-primary btn-sm', on: { click: actions.importImage } }, iconEl('upload'), h('span', { class: 'btn-label', text: 'Import floor plan image' }))));
    }
    const setU = (label, fn, opts) => store.update((d) => { if (d.underlay) fn(d.underlay); }, { label, ...opts });
    const getU = (key, fallback) => () => store.plan.underlay?.[key] ?? fallback;
    const span = () => {
      const x = store.plan.underlay;
      return x ? `${fmt(x.width * x.scale)} × ${fmt(x.height * x.scale)}` : '';
    };
    return section('Floor plan image',
      h('div', { class: 'prop-toggles' },
        b.toggle({ text: (v) => (v ? 'Shown' : 'Hidden'), icon: 'eye', iconOff: 'eye-off', get: getU('visible', true), set: (v) => setU(v ? 'Show image' : 'Hide image', (x) => { x.visible = v; }), tip: 'Show or hide the image' }),
        b.toggle({ text: (v) => (v ? 'Locked' : 'Unlocked'), icon: 'lock', iconOff: 'unlock', get: getU('locked', true), set: (v) => setU(v ? 'Lock image' : 'Unlock image', (x) => { x.locked = v; }), tip: 'Unlock to drag the image into place' })),
      b.range({
        label: 'Opacity', name: 'opacity', min: 0.05, max: 1, step: 0.05, get: getU('opacity', 0.6), format: (v) => `${Math.round(v * 100)}%`,
        set: (v, key) => setU('Change image opacity', (x) => { x.opacity = v; }, { coalesce: key }),
      }),
      b.number({
        label: 'Rotation', name: 'imageRotation', suffix: '°', step: 0.5, min: -180, max: 180, get: getU('rotation', 0),
        set: (v) => setU('Rotate image', (x) => { x.rotation = v; }),
      }).row(),
      b.readout({ label: 'Image spans', get: span }),
      u.scaleNote ? b.readout({
        label: 'Scale note',
        get: () => { const x = store.plan.underlay; return x?.scaleNote ? `${x.scaleNote.text}${x.scaleNote.ocr ? ' (read by OCR)' : ''}${x.calibrated ? ', overridden by calibration' : ''}` : ''; },
      }) : null,
      actionsRow(
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', dataset: { tip: 'Click both ends of a known length on the image' }, on: { click: actions.calibrate } }, iconEl('calibrate'), h('span', { class: 'btn-label', text: 'Calibrate scale' })),
        h('button', { type: 'button', class: 'btn btn-secondary btn-sm', dataset: { tip: 'Find the walls, doors, rooms and furniture in the image' }, on: { click: actions.detectWalls } }, iconEl('wand'), h('span', { class: 'btn-label', text: 'Detect walls' })),
        h('button', { type: 'button', class: 'btn btn-secondary btn-sm icon-only', dataset: { tip: 'Replace the image' }, attrs: { 'aria-label': 'Replace the image' }, on: { click: actions.replaceImage } }, iconEl('upload')),
        h('button', { type: 'button', class: 'btn btn-secondary btn-sm btn-danger icon-only', dataset: { tip: 'Remove the image' }, attrs: { 'aria-label': 'Remove the image' }, on: { click: actions.removeImage } }, iconEl('trash'))));
  }

  function viewsSection(plan) {
    if (!plan.cameras.length) {
      return section('Saved viewpoints', h('p', { class: 'prop-note', text: 'No saved views yet. Use the Viewpoint tool, or Save this view while walking.' }));
    }
    const list = h('ol', { class: 'view-list' }, plan.cameras.map((c, i) => h('li', { class: 'view-row' },
      h('button', { type: 'button', class: 'view-select', dataset: { tip: 'Select on the plan' }, on: { click: () => store.select({ kind: 'camera', id: c.id }) } },
        h('span', { class: 'view-index', text: String(i + 1) }), h('span', { class: 'view-name', text: c.name })),
      h('button', { type: 'button', class: 'icon-btn icon-btn-sm', dataset: { tip: 'Walk to this view' }, attrs: { 'aria-label': `Walk to ${c.name}` }, on: { click: () => actions.walkToCamera(c.id) } }, iconEl('person')))));
    return section('Saved viewpoints', list);
  }

  // ---- Header and refresh --------------------------------------------------------------------------

  function headerFor(sel, ent) {
    let kind = 'Plan', title = 'Plan overview';
    if (sel && ent) {
      kind = KIND_TITLE[sel.kind];
      if (sel.kind === 'wall') title = WALL_KINDS[ent.kind].label;
      else if (sel.kind === 'opening') { title = OPENING_TYPES[ent.type].label; kind = ent.type === 'window' ? 'Window' : 'Door or opening'; }
      else if (sel.kind === 'room') title = ent.name;
      else if (sel.kind === 'item') { const def = getItem(ent.type); title = def.name; kind = categoryLabel(def.category); }
      else if (sel.kind === 'camera') title = ent.name;
    }
    const children = [h('div', { class: 'props-heading' }, h('div', { class: 'props-kind', text: kind }), h('h2', { class: 'props-title', text: title }))];
    if (sel) {
      children.push(h('button', {
        type: 'button', class: 'icon-btn', dataset: { tip: 'Clear selection', key: 'Esc' }, attrs: { 'aria-label': 'Clear selection' },
        on: { click: () => { store.select(null); editor.canvas.focus({ preventScroll: true }); } },
      }, iconEl('close')));
    }
    header.replaceChildren(...children);
  }

  function signature(sel, ent) {
    const plan = store.plan;
    if (!sel || !ent) {
      const u = plan.underlay;
      return ['plan', !!u, !!u?.scaleNote, plan.rooms.length > 0, plan.cameras.map((c) => `${c.id}:${c.name}`).join(',')].join('|');
    }
    if (sel.kind === 'opening') return `${ent.type}`;
    if (sel.kind === 'item') return `${ent.type}`;
    if (sel.kind === 'wall') return `${ent.kind}`;
    // A room's color swatches are those of its finishes.
    if (sel.kind === 'room') return [ent.name, ent.floor, ent.wall, ent.wainscot, ent.base].join('|');
    if (sel.kind === 'camera') return ent.name;
    return '';
  }

  function rebuild(key, sig, sel, ent) {
    const sameKey = key === current.key;
    const scroll = sameKey ? body.scrollTop : 0;
    const focusField = sameKey && root.contains(document.activeElement) ? document.activeElement.dataset?.field : null;
    current = { key, sig, syncers: [] };
    const b = makeBuilder(current.syncers);
    let content;
    if (!sel || !ent) content = overviewPanel(b);
    else if (sel.kind === 'wall') content = wallPanel(b, ent);
    else if (sel.kind === 'opening') content = openingPanel(b, ent);
    else if (sel.kind === 'room') content = roomPanel(b, ent);
    else if (sel.kind === 'item') content = itemPanel(b, ent);
    else content = cameraPanel(b, ent);
    headerFor(sel, ent);
    body.replaceChildren(...content.filter(Boolean));
    body.scrollTop = scroll;
    if (focusField) body.querySelector(`[data-field="${focusField}"]`)?.focus({ preventScroll: true });
  }

  function refresh() {
    raf = 0;
    const sel = store.selection;
    const ent = store.selected;
    const key = sel && ent ? `${sel.kind}:${sel.id}` : 'plan';
    const sig = signature(sel, ent);
    if (key === current.key && sig === current.sig) {
      for (const fn of current.syncers) fn();
      return;
    }
    rebuild(key, sig, sel, ent);
  }

  const schedule = () => { if (!raf) raf = requestAnimationFrame(refresh); };
  store.addEventListener('change', schedule);
  store.addEventListener('selection', schedule);
  refresh();
  return { refresh, duplicateItem };
}
