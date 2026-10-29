// Item catalog registry. Category modules (lab.js, medical.js, ...) call registerItems() when
// imported; import catalog/index.js to load every category. Never import index.js from a category.

export const CATEGORIES = [
  { id: 'lab', label: 'Lab and life sciences' },
  { id: 'medical', label: 'Medical office' },
  { id: 'office', label: 'General office' },
  { id: 'retail', label: 'Retail and industrial' },
  { id: 'general', label: 'General' },
];

const REGISTRY = new Map();

/**
 * ItemDef:
 *   type      unique kebab-case id, e.g. 'fume-hood'
 *   name      display name, sentence case, e.g. 'Fume hood'
 *   category  one of CATEGORIES ids
 *   w, d, h   default width (x), depth (y on plan / z in 3D) and height in meters
 *   resizable optional: true lets users change w/d (and h when resizableHeight is true)
 *   tags      optional search keywords
 *   blocking  optional: false lets people walk through it (rugs, floor markings). Default true.
 *   planFill  optional: false skips the white footprint fill the plan draws under the symbol (round
 *             tables, stools, rugs). Non-blocking items are never filled. Default true.
 *   contactShadow optional: true (default) draws a soft floor shadow over the footprint, 'round' an
 *             elliptical one (round tables, stools, plants), false none (open fixtures, table sets
 *             whose footprint includes chairs).
 *   colorable optional: true when opts.color recolors the main fabric or finish (shows color swatches);
 *             'casework' when it recolors cabinet doors and panels in CASEWORK_COLORS (finishes.js).
 *   worksurface optional: the WORKSURFACES key (finishes.js) of its counter or bench top as made;
 *             opts.top picks another.
 *   variants  optional: names of the looks the item comes in (artworks). A placed item shows the
 *             one its `variant` index names, or when that is unset one picked from its id (so it
 *             keeps it); build() gets the index as opts.variant. variantLabel names the choice
 *             in the properties panel ('Look' by default).
 *   hang      optional: for wall-hung items, the height in meters their middle hangs at. The
 *             builder lifts the model (still built from y = 0) to center there, never below the floor.
 *   build(kit, opts) -> THREE.Object3D
 *             opts = { w, d, h, color, top, variant }. Model is centered on its footprint, base at
 *             y = 0, front facing +z, fitting inside [-w/2, w/2] x [0, h] x [-d/2, d/2].
 *   draw2d(ctx, opts) -> void
 *             Plan symbol. ctx is pre-transformed: origin at the item center, 1 unit = 1 meter,
 *             rotated, front toward +y. opts = { w, d, h, px, theme } where px is the size of one
 *             screen pixel in meters (lineWidth = 1.25 * px is a crisp hairline) and theme holds
 *             colors { line, fill, accent, muted, light, glass }. Draw the outline and interior
 *             detail; the editor draws selection highlights itself.
 */
export function registerItems(defs) {
  for (const def of defs) {
    for (const key of ['type', 'name', 'category']) {
      if (typeof def[key] !== 'string' || !def[key]) throw new Error(`Catalog item is missing "${key}"`);
    }
    for (const key of ['w', 'd', 'h']) {
      if (!(def[key] > 0)) throw new Error(`Catalog item "${def.type}" needs a positive ${key}`);
    }
    if (typeof def.build !== 'function' || typeof def.draw2d !== 'function') {
      throw new Error(`Catalog item "${def.type}" needs build() and draw2d()`);
    }
    if (REGISTRY.has(def.type)) throw new Error(`Duplicate catalog item "${def.type}"`);
    REGISTRY.set(def.type, { blocking: true, resizable: false, planFill: true, contactShadow: true, colorable: false, tags: [], ...def });
  }
}

/** Placeholder used for item types that are not registered (e.g. a plan saved by a newer build). */
const FALLBACK = {
  type: 'unknown',
  name: 'Unknown item',
  category: 'general',
  w: 0.6, d: 0.6, h: 0.9,
  blocking: true,
  resizable: true,
  tags: [],
  build(kit, { w, d, h }) {
    const g = kit.group();
    kit.block(g, kit.mat.plastic, -w / 2, w / 2, 0, h, -d / 2, d / 2);
    return g;
  },
  draw2d(ctx, { w, d, px, theme }) {
    ctx.strokeStyle = theme.muted;
    ctx.lineWidth = 1.25 * px;
    ctx.setLineDash([4 * px, 3 * px]);
    ctx.strokeRect(-w / 2, -d / 2, w, d);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(-w / 2, -d / 2); ctx.lineTo(w / 2, d / 2);
    ctx.moveTo(w / 2, -d / 2); ctx.lineTo(-w / 2, d / 2);
    ctx.stroke();
  },
};

export const getItem = (type) => REGISTRY.get(type) || FALLBACK;
export const hasItem = (type) => REGISTRY.has(type);
export const allItems = () => [...REGISTRY.values()];
export const listItems = (category) => allItems().filter((d) => !category || d.category === category);

/** Effective dimensions of a placed item: instance overrides fall back to the catalog defaults. */
export function itemDims(item) {
  const def = getItem(item.type);
  return { w: item.w ?? def.w, d: item.d ?? def.d, h: item.h ?? def.h };
}

const STOP_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

/** A word without its plural ending: desks, benches, shelves and libraries become desk, bench, shelf, library. */
function singular(w) {
  if (w.length <= 3 || /(ss|us|is)$/.test(w)) return w;
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.endsWith('ves')) return `${w.slice(0, -3)}f`;
  if (/(ch|sh|x|z)es$/.test(w)) return w.slice(0, -2);
  return w.endsWith('s') ? w.slice(0, -1) : w;
}

const words = (text) => String(text).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP_WORDS.has(w)).map(singular);

/**
 * Words each category is found by: its id and label, without the ids of other categories, so
 * "office" finds general office items and not every medical office item.
 */
const categoryWords = (id) => {
  const others = new Set(CATEGORIES.filter((c) => c.id !== id).map((c) => c.id));
  return [...new Set([id, ...words(CATEGORIES.find((c) => c.id === id)?.label || '')])].filter((w) => !others.has(w));
};

/** True when s ends compound word w after at least 3 letters: "shelf" ends "bookshelf", "rack" not "track". */
const endsCompound = (w, s) => w.length - s.length >= 3 && w.endsWith(s);

/**
 * How well query word q matches a list of item words: 4 a whole word, 3 the start of a word, 2 the
 * end of a compound word, 1 elsewhere inside a word, 0 no match. Matches inside a word need a query
 * of 4 or more letters, so "bin" does not find "cabinet".
 */
function wordMatch(q, list, raw) {
  let best = 0;
  for (const w of list) {
    if (w === q || w === raw) return 4;
    if (w.startsWith(q) || w.startsWith(raw)) best = 3;
    else if (best < 2 && raw.length >= 4) {
      if (endsCompound(w, q) || endsCompound(w, raw)) best = 2;
      else if (w.includes(q) || w.includes(raw)) best = 1;
    }
  }
  return best;
}

/**
 * Search by name, tags, type and category. Every word of the query must match; plurals match their
 * singular. Items are ranked by match quality, names before tags before categories. Words that
 * only match inside other words (not at the end of a compound) are used only when nothing matches better.
 */
export function searchItems(query, category) {
  const raws = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP_WORDS.has(w));
  const items = listItems(category);
  if (!raws.length) return items;
  const scored = items.map((d, order) => {
    const fields = [words(d.name), words(`${(d.tags || []).join(' ')} ${d.type}`), categoryWords(d.category)];
    let quality = 4, weight = 0;
    for (const raw of raws) {
      const q = singular(raw);
      const per = fields.map((f) => wordMatch(q, f, raw));
      const best = Math.max(...per);
      quality = Math.min(quality, best);
      weight += best * 10 + (per[0] === best ? 2 : per[1] === best ? 1 : 0);
    }
    return { d, quality, weight, order };
  }).filter((r) => r.quality > 0);
  const top = Math.max(0, ...scored.map((r) => r.quality));
  // A short word that names something exactly ("pos", "iv") does not also list everything starting with it.
  const floor = top >= 2 ? (top === 4 && raws.every((w) => w.length <= 3) ? 4 : 2) : 1;
  return scored.filter((r) => r.quality >= floor)
    .sort((a, b) => b.quality - a.quality || b.weight - a.weight || a.order - b.order)
    .map((r) => r.d);
}
