// Overlays on the 3D view: Walk and Overview toggle, rendering quality menu, controls hint and the
// saved viewpoints strip.
import { normDeg } from '../geometry.js';
import { h, iconEl } from './dom.js';
import { setPref } from './storage.js';
import { attachMenu } from './widgets.js';

const HINTS = {
  walk: [[['Drag'], 'look around'], [['W', 'A', 'S', 'D'], 'move'], [['Click'], 'walk to a spot']],
  overview: [[['Drag'], 'orbit'], [['Right drag'], 'pan'], [['Scroll'], 'zoom'], [['Double-click'], 'walk there']],
};
/** Walkthrough quality levels as people see them, best first. */
const QUALITY = [
  { id: 'high', label: 'Realistic', description: 'Soft shadows, window glow and smooth edges' },
  { id: 'balanced', label: 'Balanced', description: 'Lighter shading for smoother movement' },
  { id: 'fast', label: 'Fast', description: 'Plain shading for older computers' },
];
const QUALITY_TIP = 'Rendering quality';
const QUALITY_AUTO_TIP = 'Lowered automatically to keep movement smooth';

export const WALK_STATUS = {
  walk: 'Drag to look around. W, A, S, D or the arrow keys move, Q and E turn, Shift walks faster. Click the floor to walk there. 1 to 9 jump to saved views.',
  overview: 'Drag to orbit, right drag to pan and scroll to zoom. Double-click the floor to walk there.',
};

export function createWalkUI(pane, { store, prefs, onSaveView, onModeChange }) {
  let walk = null;
  let activeId = null;
  let arriving = false; // the walker is still on its way to the active view
  let listKey = null; // never matches, so the first render always runs (and marks an empty strip)

  // After a pointer click on an overlay control, hand focus back to the 3D view so walk keys keep
  // working. Keyboard activation (click detail 0) leaves focus on the control.
  const focusView = (e) => {
    if (!e || e.detail > 0) walk?.container.focus({ preventScroll: true });
  };

  const modeButtons = ['walk', 'overview'].map((m) => h('button', {
    type: 'button', class: 'seg', dataset: { walkMode: m, tip: m === 'walk' ? 'Walk at eye level' : 'See the whole plan from above' },
    attrs: { 'aria-pressed': String(m === 'walk') },
    on: { click: (e) => { walk?.setMode(m); focusView(e); } },
  }, iconEl(m === 'walk' ? 'person' : 'overview'), h('span', { class: 'btn-label', text: m === 'walk' ? 'Walk' : 'Overview' })));
  const modeToggle = h('div', { class: 'segmented segmented-float walk-modes', attrs: { role: 'group', 'aria-label': '3D view mode' } }, modeButtons);

  // Rendering quality: the label shows the level in use, which the walkthrough may lower on its own
  // while frames are slow. Only a level picked here is remembered.
  const qualityLabel = h('span', { class: 'btn-label', text: (QUALITY.find((q) => q.id === prefs.walkQuality) || QUALITY[0]).label });
  const qualityBtn = h('button', { type: 'button', class: 'seg', dataset: { tip: QUALITY_TIP } },
    iconEl('settings'), qualityLabel, iconEl('chevron-down', 'icon icon-chevron'));
  qualityBtn.lastChild.style.cssText = 'width: 14px; height: 14px; margin-left: -3px; opacity: 0.7;';
  const qualityControl = h('div', { class: 'segmented segmented-float walk-quality' }, qualityBtn);
  let qualityByPointer = false;
  const qualityMenu = attachMenu(qualityBtn, () => {
    qualityByPointer = false;
    queueMicrotask(markQualityMenu);
    const lowered = walk && walk.quality !== walk.chosenQuality;
    return [{
      group: lowered ? QUALITY_AUTO_TIP : QUALITY_TIP,
      items: QUALITY.map((q) => ({
        label: q.label, description: q.description, icon: 'check',
        onSelect: () => {
          setPref(prefs, 'walkQuality', q.id);
          walk?.setQuality(q.id);
          if (qualityByPointer) focusView();
        },
      })),
    }];
  }, { align: 'start' });

  /** The menu widget has no radio items: mark the level in use and show its check only. */
  function markQualityMenu() {
    const menu = qualityMenu.isOpen && document.getElementById(qualityBtn.getAttribute('aria-controls'));
    if (!menu) return;
    menu.addEventListener('pointerdown', () => { qualityByPointer = true; });
    const items = [...menu.querySelectorAll('.menu-item')];
    items.forEach((el, i) => {
      const on = QUALITY[i]?.id === walk?.quality;
      el.setAttribute('role', 'menuitemradio');
      el.setAttribute('aria-checked', String(on));
      const check = el.querySelector('.icon');
      if (check) check.style.visibility = on ? 'visible' : 'hidden';
      if (on) el.focus();
    });
  }

  function syncQuality() {
    if (!walk) return;
    const level = QUALITY.find((q) => q.id === walk.quality) || QUALITY[0];
    const lowered = walk.quality !== walk.chosenQuality;
    qualityLabel.textContent = level.label;
    qualityBtn.dataset.tip = lowered ? QUALITY_AUTO_TIP : QUALITY_TIP;
    qualityBtn.setAttribute('aria-label', `${QUALITY_TIP}: ${level.label}${lowered ? ', lowered automatically' : ''}`);
  }

  const hintBody = h('div', { class: 'walk-hint-body' });
  const hint = h('div', { class: 'walk-hint', hidden: !!prefs.hideWalkHint },
    hintBody,
    h('button', {
      type: 'button', class: 'walk-hint-close', attrs: { 'aria-label': 'Hide controls hint' },
      // The button disappears, so focus always moves on to the 3D view.
      on: { click: () => { hint.hidden = true; setPref(prefs, 'hideWalkHint', true); focusView(); } },
    }, iconEl('close')));

  const viewList = h('div', { class: 'views-list', attrs: { role: 'group', 'aria-label': 'Saved views' } });
  const saveBtn = h('button', {
    type: 'button', class: 'view-chip view-save', dataset: { tip: 'Add the current position as a saved view' },
    on: { click: (e) => { onSaveView?.(); focusView(e); } },
  }, iconEl('view-add'), h('span', { class: 'btn-label', text: 'Save this view' }));
  const strip = h('div', { class: 'views-strip' }, h('span', { class: 'views-label', text: 'Views' }), viewList, saveBtn);

  const loading = h('div', { class: 'walk-loading', hidden: true }, h('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }), h('span', { text: 'Loading the 3D view' }));
  const controls = h('div', { style: { display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap', gap: '8px', minWidth: '0' } }, modeToggle, qualityControl);
  const top = h('div', { class: 'walk-top' }, controls, hint);
  pane.append(top, strip, loading);

  function renderHint(mode) {
    hintBody.replaceChildren(...HINTS[mode].map(([keys, what]) => h('span', { class: 'hint-item' },
      h('span', { class: 'keys' }, keys.map((k) => h('kbd', { text: k }))),
      h('span', { text: what }))));
  }

  function renderViews() {
    const cams = store.plan.cameras;
    const key = cams.map((c) => `${c.id}:${c.name}`).join('|');
    if (key === listKey) return;
    listKey = key;
    viewList.replaceChildren(...cams.map((c, i) => h('button', {
      type: 'button', class: 'view-chip', dataset: { camera: c.id, tip: `Go to ${c.name}`, ...(i < 9 ? { key: String(i + 1) } : {}) },
      attrs: { 'aria-pressed': 'false' },
      on: { click: (e) => { walk?.goToCamera(c.id); focusView(e); } },
    }, i < 9 ? h('kbd', { class: 'view-key', text: String(i + 1) }) : null, h('span', { class: 'view-chip-name', text: c.name }))));
    strip.classList.toggle('empty', !cams.length);
    syncActive();
    requestAnimationFrame(syncOverflow);
  }

  function syncActive(pose) {
    if (pose && activeId) {
      const c = store.plan.cameras.find((x) => x.id === activeId);
      const turned = c ? Math.abs(((normDeg(pose.yaw) - normDeg(c.yaw) + 540) % 360) - 180) : 999;
      if (!c || Math.hypot(pose.x - c.x, pose.y - c.y) > 0.6 || turned > 25) activeId = null;
    }
    for (const b of viewList.children) {
      const on = b.dataset.camera === activeId;
      b.setAttribute('aria-pressed', String(on));
      if (on && !pose) revealChip(b);
    }
  }

  function syncMode(mode) {
    for (const b of modeButtons) b.setAttribute('aria-pressed', String(b.dataset.walkMode === mode));
    pane.dataset.walkMode = mode;
    renderHint(mode);
    onModeChange?.(mode);
  }

  function revealChip(b) {
    const left = b.offsetLeft, right = left + b.offsetWidth;
    if (left < viewList.scrollLeft) viewList.scrollLeft = left - 8;
    else if (right > viewList.scrollLeft + viewList.clientWidth) viewList.scrollLeft = right - viewList.clientWidth + 8;
  }

  function syncOverflow() {
    const max = viewList.scrollWidth - viewList.clientWidth;
    viewList.classList.toggle('overflow-start', max > 1 && viewList.scrollLeft > 1);
    viewList.classList.toggle('overflow-end', max > 1 && viewList.scrollLeft < max - 1);
  }
  viewList.addEventListener('scroll', syncOverflow, { passive: true });
  viewList.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      viewList.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });
  new ResizeObserver(syncOverflow).observe(viewList);

  store.addEventListener('change', renderViews);
  renderHint('walk');
  renderViews();

  return {
    attach(w) {
      walk = w;
      w.addEventListener('mode', (e) => syncMode(e.detail.mode));
      // Chip clicks, number keys and the properties panel all jump through goToCamera, which reports here.
      w.addEventListener('camera', (e) => {
        activeId = e.detail.id;
        arriving = e.detail.arriving;
        syncActive();
      });
      // Poses on the way to a view are not a reason to drop its highlight.
      w.addEventListener('pose', (e) => { if (activeId && !arriving) syncActive(e.detail); });
      if (typeof w.setQuality === 'function') {
        const saved = QUALITY.find((q) => q.id === prefs.walkQuality);
        if (saved && saved.id !== w.chosenQuality) w.setQuality(saved.id);
        w.addEventListener('quality', syncQuality);
        syncQuality();
      } else {
        qualityControl.hidden = true;
      }
      syncMode(w.mode);
    },
    setLoading(on) { loading.hidden = !on; },
    markActive(id) {
      if (id !== activeId) {
        activeId = id;
        arriving = false;
      }
      syncActive();
    },
  };
}
