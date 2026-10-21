// Furniture and equipment library: category tabs, search and item tiles with plan symbols.
// Click a tile to place it with the editor's item tool, or drag it onto the plan.
import { CATEGORIES, searchItems } from '../catalog/registry.js';
import { THEME } from '../plan-render.js';
import { formatLength } from '../geometry.js';
import { h, iconEl } from './dom.js';
import { setPref } from './storage.js';

export const ITEM_MIME = 'application/x-cbre-item';
const THUMB = { w: 112, h: 64, pad: 9, maxScale: 110 };
const SHORT = { lab: 'Lab', medical: 'Medical', office: 'Office', retail: 'Retail', general: 'General' };

/** Category label in plain words ("Lab and life sciences"). */
export const categoryLabel = (id) => (CATEGORIES.find((c) => c.id === id)?.label || 'General').replace(/\s*&\s*/g, ' and ');

/** Draw an item's plan symbol centered in a canvas of cssW x cssH. */
export function drawItemThumb(canvas, def, cssW = THUMB.w, cssH = THUMB.h) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const s = Math.min((cssW - THUMB.pad * 2) / def.w, (cssH - THUMB.pad * 2) / def.d, THUMB.maxScale);
  ctx.translate(cssW / 2, cssH / 2);
  ctx.scale(s, s);
  try {
    ctx.fillStyle = THEME.item.fill;
    ctx.fillRect(-def.w / 2, -def.d / 2, def.w, def.d);
    def.draw2d(ctx, { w: def.w, d: def.d, h: def.h, px: 1 / s, theme: THEME.item });
  } catch {
    ctx.strokeStyle = THEME.item.muted;
    ctx.lineWidth = 1 / s;
    ctx.strokeRect(-def.w / 2, -def.d / 2, def.w, def.d);
  }
}

export function createLibrary(root, { store, editor, prefs, onPick, onDragStart, onDragEnd }) {
  let category = CATEGORIES.some((c) => c.id === prefs.category) ? prefs.category : CATEGORIES[0].id;
  let query = '';
  const thumbs = new Map();

  const search = h('input', {
    type: 'search', class: 'search-input', placeholder: 'Search furniture and equipment',
    attrs: { 'aria-label': 'Search furniture and equipment', autocomplete: 'off', spellcheck: 'false' },
  });
  const clear = h('button', { type: 'button', class: 'search-clear', attrs: { 'aria-label': 'Clear search' }, hidden: true }, iconEl('close'));
  const searchBox = h('div', { class: 'search' }, iconEl('search', 'icon search-icon'), search, clear);

  const tabs = CATEGORIES.map((c) => h('button', {
    type: 'button', class: 'tab', id: `tab-${c.id}`, dataset: { category: c.id, tip: categoryLabel(c.id) },
    attrs: { role: 'tab', 'aria-controls': 'library-grid' },
    text: SHORT[c.id] || c.label,
    on: { click: () => setCategory(c.id) },
  }));
  const tabList = h('div', { class: 'tabs', attrs: { role: 'tablist', 'aria-label': 'Item categories' } }, tabs);
  const caption = h('div', { class: 'library-caption' });
  const grid = h('div', { class: 'item-grid', id: 'library-grid', attrs: { role: 'tabpanel' } });
  const empty = h('div', { class: 'library-empty', hidden: true });

  const scroller = h('div', { class: 'library-scroll' }, grid, empty);
  root.append(
    h('div', { class: 'panel-heading' }, h('h2', { class: 'panel-title', text: 'Furniture and equipment' })),
    h('div', { class: 'library-controls' }, searchBox, tabList, caption),
    scroller,
  );

  tabList.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement);
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step || i < 0) return;
    e.preventDefault();
    const next = tabs[(i + step + tabs.length) % tabs.length];
    next.focus();
    next.click();
  });
  search.addEventListener('input', () => {
    scroller.scrollTop = 0;
    query = search.value;
    clear.hidden = !query;
    render();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      e.stopPropagation();
      search.value = '';
      query = '';
      clear.hidden = true;
      render();
    }
  });
  clear.addEventListener('click', () => {
    search.value = '';
    query = '';
    clear.hidden = true;
    render();
    search.focus();
  });

  function setCategory(id) {
    if (id !== category) scroller.scrollTop = 0;
    category = id;
    setPref(prefs, 'category', id);
    if (query) {
      search.value = '';
      query = '';
      clear.hidden = true;
    }
    render();
  }

  function thumbFor(def) {
    let c = thumbs.get(def.type);
    if (!c) {
      c = h('canvas', { class: 'tile-thumb', attrs: { 'aria-hidden': 'true' } });
      drawItemThumb(c, def);
      thumbs.set(def.type, c);
    }
    return c;
  }

  function tile(def) {
    const units = store.plan.units;
    const size = `${formatLength(def.w, units)} × ${formatLength(def.d, units)}`;
    const el = h('button', {
      type: 'button', class: 'tile', draggable: true, dataset: { type: def.type },
      attrs: { 'aria-pressed': 'false', 'aria-label': `${def.name}, ${size}` },
    }, h('span', { class: 'tile-art' }, thumbFor(def)),
    h('span', { class: 'tile-name', text: def.name }),
    h('span', { class: 'tile-size', text: size }));
    el.addEventListener('click', () => {
      editor.setPendingItem(def.type);
      editor.canvas.focus({ preventScroll: true });
      onPick?.(def);
      syncActive();
    });
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(ITEM_MIME, def.type);
      e.dataTransfer.setData('text/plain', def.name);
      e.dataTransfer.effectAllowed = 'copy';
      const art = thumbFor(def);
      e.dataTransfer.setDragImage(art, art.clientWidth / 2, art.clientHeight / 2);
      el.classList.add('dragging');
      onDragStart?.(def);
    });
    el.addEventListener('dragend', (e) => {
      el.classList.remove('dragging');
      onDragEnd?.(def, e.dataTransfer.dropEffect !== 'none');
    });
    return el;
  }

  function render() {
    const q = query.trim();
    const list = q ? searchItems(q) : searchItems('', category);
    for (const t of tabs) {
      const on = !q && t.dataset.category === category;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on || (q && t.dataset.category === category) ? 0 : -1;
    }
    tabList.classList.toggle('searching', !!q);
    grid.setAttribute('aria-labelledby', `tab-${category}`);
    caption.textContent = q
      ? `${list.length} ${list.length === 1 ? 'result' : 'results'} in all categories`
      : `${categoryLabel(category)}, ${list.length} items`;
    grid.replaceChildren(...list.map(tile));
    empty.hidden = list.length > 0;
    empty.textContent = q ? `Nothing matches "${q}". Try a broader word such as desk, bench or chair.` : 'No items in this category yet.';
    syncActive();
  }

  function syncActive() {
    const active = editor.tool === 'item' ? editor.pendingItem : null;
    for (const t of grid.children) t.setAttribute('aria-pressed', String(t.dataset.type === active));
  }

  editor.addEventListener('toolchange', syncActive);
  let units = store.plan.units;
  store.addEventListener('change', () => {
    if (store.plan.units === units) return;
    units = store.plan.units;
    render();
  });
  render();
  return { render, syncActive, focusSearch: () => search.focus() };
}
