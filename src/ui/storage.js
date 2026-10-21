// Autosave of the current plan and per-viewer preferences in localStorage. Every access is
// guarded: storage can be missing, full or blocked, and the app must keep working without it.
import { serializePlan, normalizePlan } from '../model.js';
import { debounce } from './dom.js';

const PLAN_KEY = 'cbre-walkthrough.plan';
const PREFS_KEY = 'cbre-walkthrough.prefs';

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

const isQuota = (err) => err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014);

/** The autosaved plan, or null. `imageDropped` is true when the image could not be kept. */
export function loadSavedPlan() {
  const raw = read(PLAN_KEY);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return { plan: normalizePlan(data.plan), imageDropped: !!data.imageDropped, savedAt: data.savedAt || 0 };
  } catch {
    return null;
  }
}

/**
 * Keep the store's plan saved. onFull() is called once when the image does not fit: the plan is
 * then saved without its image so the layout itself is never lost.
 */
export function autosave(store, { onFull, delay = 700 } = {}) {
  let warned = false;
  const save = () => {
    const plan = store.plan;
    const body = (p, imageDropped = false) => `{"savedAt":${Date.now()},"imageDropped":${imageDropped},"plan":${serializePlan(p)}}`;
    const result = write(PLAN_KEY, body(plan));
    if (result === true) return;
    if (isQuota(result) && plan.underlay) {
      write(PLAN_KEY, body({ ...plan, underlay: null }, true));
      if (!warned) {
        warned = true;
        onFull?.();
      }
    }
  };
  const run = debounce(save, delay);
  store.addEventListener('change', () => run());
  window.addEventListener('pagehide', () => run.flush());
  return run;
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
