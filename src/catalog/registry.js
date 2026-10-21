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
 *   contactShadow optional: false skips the soft floor shadow under the item (open fixtures). Default true.
 *   colorable optional: true when opts.color recolors the main fabric or finish (shows color swatches).
 *   build(kit, opts) -> THREE.Object3D
 *             opts = { w, d, h, color }. Model is centered on its footprint, base at y = 0,
 *             front facing +z, fitting inside [-w/2, w/2] x [0, h] x [-d/2, d/2].
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

/** Case-insensitive search over name, type and tags. */
export function searchItems(query, category) {
  const q = query.trim().toLowerCase();
  return listItems(category).filter((d) => !q || [d.name, d.type, ...(d.tags || [])].some((s) => s.toLowerCase().includes(q)));
}
