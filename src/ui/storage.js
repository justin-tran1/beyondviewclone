// Autosave of plans and per-viewer preferences in localStorage. Every access is guarded: storage
// can be missing, full or blocked, and the app must keep working without it.
//
// Each plan is kept under its own key (by plan id) with a small header beside it, so tabs editing
// different plans never touch each other's work. Every save is stamped with the tab that wrote it.
// A tab only overwrites a plan whose stored stamp is the one it last wrote or loaded: when another
// tab saved the same plan since then, this tab takes the newer version if it has no changes of its
// own, and otherwise keeps its own version as a copy under a new id, so both survive.
import { normalizePlan, uid } from '../model.js';
import { debounce } from './dom.js';

const PREFIX = 'cbre-walkthrough.';
const LEGACY_KEY = `${PREFIX}plan`; // the single autosave slot of earlier builds
const PREFS_KEY = `${PREFIX}prefs`;
const PLAN_PREFIX = `${PREFIX}plan.`;
const HEAD_PREFIX = `${PREFIX}head.`;
const MAX_PLANS = 12;
const QUOTA_CHARS = 5 * 1024 * 1024; // the usual localStorage limit per site
const SESSION = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    return err;
  }
}

function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to do: the entry simply stays.
  }
}

function keys() {
  try {
    return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(Boolean);
  } catch {
    return [];
  }
}

const parse = (raw) => {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const isQuota = (err) => err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014);
const isBlank = (p) => !p.walls.length && !p.rooms.length && !p.items.length && !p.cameras.length && !p.underlay;

/** Header of a saved plan: { id, name, savedAt, stamp, imageDropped }, or null. */
function readHead(id) {
  const h = parse(read(HEAD_PREFIX + id));
  return h && typeof h === 'object' && h.id === id && typeof h.stamp === 'string' ? h : null;
}

/** Headers of every saved plan, most recently saved first. */
function heads() {
  return keys().filter((k) => k.startsWith(HEAD_PREFIX))
    .map((k) => readHead(k.slice(HEAD_PREFIX.length)))
    .filter(Boolean)
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

/** A saved plan: { plan, stamp, imageDropped, edited }, or null when missing or damaged. */
function readRecord(id) {
  const data = parse(read(PLAN_PREFIX + id));
  if (!data || typeof data !== 'object' || !data.plan) return null;
  try {
    return { plan: normalizePlan(data.plan), stamp: String(data.stamp || ''), imageDropped: !!data.imageDropped, edited: !!data.edited };
  } catch {
    return null;
  }
}

/** Write a plan and then its header. Returns true, or the storage error. */
function writePlan(plan, { stamp, imageDropped = false, edited = false }) {
  const savedAt = Date.now();
  const result = write(PLAN_PREFIX + plan.id, JSON.stringify({ stamp, savedAt, imageDropped, edited, plan }));
  if (result !== true) return result;
  write(HEAD_PREFIX + plan.id, JSON.stringify({ id: plan.id, name: plan.name, savedAt, stamp, imageDropped }));
  return true;
}

function removePlan(id) {
  remove(PLAN_PREFIX + id);
  remove(HEAD_PREFIX + id);
}

/**
 * Make room by dropping the image of the oldest other saved plan. Its stamp is kept, so a tab that
 * has it open still owns it. Returns false when there is nothing left to drop.
 */
function dropOldestImage(exceptId) {
  for (const head of heads().reverse()) {
    if (head.id === exceptId) continue;
    const data = parse(read(PLAN_PREFIX + head.id));
    if (!data?.plan?.underlay) continue;
    data.plan.underlay = null;
    data.imageDropped = true;
    if (write(PLAN_PREFIX + head.id, JSON.stringify(data)) !== true) continue;
    write(HEAD_PREFIX + head.id, JSON.stringify({ ...head, imageDropped: true }));
    return true;
  }
  return false;
}

/** Move the autosave of earlier builds (one slot for every plan) to its own key. */
function migrateLegacy() {
  const raw = read(LEGACY_KEY);
  if (!raw) return;
  const data = parse(raw);
  let plan = null;
  try {
    plan = data?.plan ? normalizePlan(data.plan) : null;
  } catch {
    plan = null;
  }
  if (!plan) return; // unreadable: left as it is
  if (readHead(plan.id)) {
    remove(LEGACY_KEY);
    return;
  }
  const opts = { stamp: 'legacy', imageDropped: !!data.imageDropped, edited: true };
  if (writePlan(plan, opts) !== true) {
    // Not enough room for two copies: the old slot goes first, then the plan is written again.
    remove(LEGACY_KEY);
    if (writePlan(plan, opts) !== true && plan.underlay) writePlan({ ...plan, underlay: null }, { ...opts, imageDropped: true });
    return;
  }
  remove(LEGACY_KEY);
}

/**
 * The most recently saved plan, or null: { plan, stamp, imageDropped, edited }. `imageDropped` is
 * true when its image could not be kept; `edited` when it has changes not saved to a file.
 */
export function loadSavedPlan() {
  migrateLegacy();
  for (const head of heads()) {
    const rec = readRecord(head.id);
    if (rec) return rec;
  }
  return null;
}

/**
 * Keep the store's plan saved under its id.
 * opts:
 *   restored         the result of loadSavedPlan() the store started with
 *   isEdited()       true when the plan has changes not saved to a file (kept with the save)
 *   onFull(what)     called once when storage is full: 'image' when the plan was saved without its
 *                    image, 'plan' when it could not be saved at all
 *   onConflict(info) another tab saved this plan while this tab had unsaved changes. Its save is
 *                    left alone and this tab's version is kept as a copy under a new id:
 *                    { id (the other tab's plan), name (of the copy), open (the copy is the open plan) }
 *   onUpdate(rec)    this tab had no unsaved changes and took the newer version another tab saved
 * Returns { flush(), saveSoon(), recent(), load(id), openable(plan), isKept() }.
 */
export function autosave(store, { restored = null, isEdited = () => false, onFull, onConflict, onUpdate, delay = 700 } = {}) {
  const known = new Map(); // plan id -> stamp this tab last wrote or loaded
  if (restored) known.set(restored.plan.id, restored.stamp);
  let serial = 0;
  let pending = null; // the plan waiting to be saved
  let adopting = false;
  let warned = false;

  const save = () => {
    const plan = pending;
    if (!plan) return;
    const head = readHead(plan.id);
    if (head && head.stamp !== known.get(plan.id)) {
      // Another tab saved this plan since this tab last did. Its save stays; this version becomes a copy.
      const copy = { ...plan, id: uid('plan'), name: `${plan.name} (copy)` };
      const open = plan === store.plan;
      pending = null;
      if (open) {
        store.update((d) => { d.id = copy.id; d.name = copy.name; }, { label: 'Keep as a copy' });
        run.flush(); // write the copy now: this may be the last chance, when the page is closing
      } else {
        const stamp = `${SESSION}.${++serial}`;
        if (writePlan(copy, { stamp, edited: true }) === true) known.set(copy.id, stamp);
      }
      onConflict?.({ id: plan.id, name: copy.name, open });
      return;
    }
    if (!head && isBlank(plan)) {
      pending = null;
      return;
    }
    const stamp = `${SESSION}.${++serial}`;
    const opts = { stamp, edited: !!isEdited() };
    let result = writePlan(plan, opts);
    // Make room by dropping older plans' images, unless this plan could never fit anyway.
    const fits = isQuota(result) && JSON.stringify(plan).length < QUOTA_CHARS * 0.9;
    while (fits && isQuota(result) && dropOldestImage(plan.id)) result = writePlan(plan, opts);
    if (isQuota(result) && plan.underlay) {
      result = writePlan({ ...plan, underlay: null }, { ...opts, imageDropped: true });
      if (result === true && !warned) {
        warned = true;
        onFull?.('image');
      }
    }
    if (result !== true) {
      if (isQuota(result) && !warned) {
        warned = true;
        onFull?.('plan');
      }
      return;
    }
    known.set(plan.id, stamp);
    if (pending === plan) pending = null;
    if (!head) prune(plan.id);
  };

  /** Keep the newest MAX_PLANS saved plans. */
  const prune = (keepId) => {
    for (const head of heads().slice(MAX_PLANS)) if (head.id !== keepId) removePlan(head.id);
  };

  /** Another tab may have saved the open plan: take its version, or let save() report a conflict. */
  const sync = () => {
    const id = store.plan.id;
    const head = readHead(id);
    if (!head || head.stamp === known.get(id)) return;
    if (pending) {
      run.flush();
      return;
    }
    if (document.hidden) return; // taken when the tab is shown again
    const rec = readRecord(id);
    if (!rec) return;
    adopting = true;
    try {
      store.replace(rec.plan, { label: 'Update from another tab' });
    } finally {
      adopting = false;
    }
    known.set(id, rec.stamp);
    onUpdate?.(rec);
  };

  const run = debounce(save, delay);
  store.addEventListener('change', (e) => {
    if (adopting) return;
    const plan = store.plan;
    if (pending && pending.id !== plan.id) {
      // Switching plans: finish saving the one being left first.
      run.cancel();
      save();
    }
    const head = e.detail?.replaced && !pending ? readHead(plan.id) : null;
    if (head && head.stamp === known.get(plan.id)) {
      // Opened exactly as saved: only move it to the top of the recent plans.
      write(HEAD_PREFIX + plan.id, JSON.stringify({ ...head, savedAt: Date.now() }));
      return;
    }
    pending = plan;
    run();
  });
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === HEAD_PREFIX + store.plan.id) sync();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) run.flush();
    else sync();
  });
  window.addEventListener('pagehide', () => run.flush());

  return {
    flush: () => run.flush(),
    /** Save the open plan again soon, for example after it was saved to a file. */
    saveSoon() {
      pending = store.plan;
      run();
    },
    /** Saved plans other than the open one, most recent first: [{ id, name, savedAt, imageDropped }]. */
    recent: () => heads().filter((h) => h.id !== store.plan.id),
    /** A saved plan to open in this tab, or null. This tab then owns its saves. */
    load(id) {
      const rec = readRecord(id);
      if (rec) known.set(id, rec.stamp);
      return rec;
    },
    /**
     * The plan to open from a file. When a different version of it is already saved here, it gets
     * a new id so that version is kept beside it instead of being overwritten.
     */
    openable(plan) {
      if (!readHead(plan.id)) return plan;
      const rec = readRecord(plan.id);
      if (rec && JSON.stringify(rec.plan) === JSON.stringify(normalizePlan(plan))) {
        known.set(plan.id, rec.stamp);
        return plan;
      }
      return { ...plan, id: uid('plan') };
    },
    /** True when the open plan, image included, is saved in this browser. */
    isKept() {
      run.flush();
      if (pending) return false;
      const head = readHead(store.plan.id);
      return !!head && head.stamp === known.get(store.plan.id) && !head.imageDropped;
    },
  };
}

export function loadPrefs() {
  try {
    const v = JSON.parse(read(PREFS_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

const savePrefsSoon = debounce((prefs) => write(PREFS_KEY, JSON.stringify(prefs)), 300);

/** Merge a change into the saved preferences. */
export function setPref(prefs, key, value) {
  prefs[key] = value;
  savePrefsSoon(prefs);
}
