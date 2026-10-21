// Shared widgets: tooltips, toasts, modal dialogs and dropdown menus.
import { h, iconEl } from './dom.js';

// ---- Tooltips --------------------------------------------------------------------------------

/** One floating tooltip for every element with data-tip (and optional data-key, data-tip-pos). */
export function setupTooltips(root = document.body) {
  const tip = h('div', { class: 'tooltip', attrs: { role: 'tooltip', 'aria-hidden': 'true' } });
  root.append(tip);
  let target = null;
  let timer = 0;

  const place = (el) => {
    const r = el.getBoundingClientRect();
    const pos = el.dataset.tipPos || 'bottom';
    const t = tip.getBoundingClientRect();
    const gap = 8;
    let x, y;
    if (pos === 'right') {
      x = r.right + gap;
      y = r.top + r.height / 2 - t.height / 2;
    } else if (pos === 'top') {
      x = r.left + r.width / 2 - t.width / 2;
      y = r.top - t.height - gap;
    } else {
      x = r.left + r.width / 2 - t.width / 2;
      y = r.bottom + gap;
      if (y + t.height > innerHeight - 4) y = r.top - t.height - gap;
    }
    x = Math.max(6, Math.min(innerWidth - t.width - 6, x));
    y = Math.max(6, Math.min(innerHeight - t.height - 6, y));
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };

  const show = (el) => {
    target = el;
    tip.replaceChildren(h('span', { text: el.dataset.tip }));
    if (el.dataset.key) tip.append(...el.dataset.key.split(' ').map((k) => h('kbd', { text: k })));
    tip.classList.add('visible');
    place(el);
  };

  const hide = () => {
    clearTimeout(timer);
    target = null;
    tip.classList.remove('visible');
  };

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const el = e.target.closest?.('[data-tip]');
    if (el === target) return;
    hide();
    if (el && !el.disabled) timer = setTimeout(() => show(el), target ? 0 : 450);
  });
  document.addEventListener('pointerout', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el && !el.contains(e.relatedTarget)) hide();
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest?.('[data-tip]');
    hide();
    if (el && el.matches(':focus-visible')) show(el);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', hide, true);
  document.addEventListener('dragstart', hide, true);
  window.addEventListener('blur', hide);
  return { hide };
}

// ---- Toasts --------------------------------------------------------------------------------------

let toastRoot = null;

/** Show a short message. type: 'success' | 'info' | 'error'. */
export function toast(message, { type = 'success', duration, action } = {}) {
  if (!toastRoot) {
    toastRoot = h('div', { class: 'toasts', attrs: { role: 'status', 'aria-live': 'polite' } });
    document.body.append(toastRoot);
  }
  const iconName = type === 'error' ? 'alert' : type === 'info' ? 'info' : 'check';
  const el = h('div', { class: `toast toast-${type}` }, iconEl(iconName, 'icon toast-icon'), h('span', { class: 'toast-text', text: message }));
  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 180);
  };
  if (action) {
    el.append(h('button', { type: 'button', class: 'toast-action', text: action.label, on: { click: () => { action.onClick(); dismiss(); } } }));
  }
  el.append(h('button', { type: 'button', class: 'toast-close', attrs: { 'aria-label': 'Dismiss' }, on: { click: dismiss } }, iconEl('close')));
  toastRoot.append(el);
  while (toastRoot.childElementCount > 3) toastRoot.firstElementChild.remove();
  const ms = duration ?? (type === 'error' ? 7000 : 3600);
  const arm = () => { timer = setTimeout(dismiss, ms); };
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', arm);
  arm();
  return dismiss;
}

// ---- Dialogs --------------------------------------------------------------------------------------

/**
 * Open a modal dialog. opts: title, subtitle, body (node or array), actions (nodes), wide, cls,
 * dismissible (Esc and backdrop close it, default true), onClose(reason), initialFocus (element).
 * Returns { el, close(reason) }.
 */
export function openDialog({ title, subtitle, body, actions, cls = '', dismissible = true, onClose, initialFocus, label } = {}) {
  const opener = document.activeElement;
  const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  const dialog = h('dialog', { class: `dialog ${cls}`, attrs: { 'aria-labelledby': title ? titleId : null, 'aria-label': title ? null : label } });
  const header = h('header', { class: 'dialog-header' },
    h('div', { class: 'dialog-heading' },
      title ? h('h2', { class: 'dialog-title', id: titleId, text: title }) : null,
      subtitle ? h('p', { class: 'dialog-subtitle', text: subtitle }) : null));
  if (dismissible) {
    header.append(h('button', { type: 'button', class: 'icon-btn dialog-close', attrs: { 'aria-label': 'Close' }, on: { click: () => close('close') } }, iconEl('close')));
  }
  dialog.append(header, h('div', { class: 'dialog-body' }, body || []));
  if (actions?.length) dialog.append(h('footer', { class: 'dialog-actions' }, actions));
  let closed = false;
  const close = (reason = 'close') => {
    if (closed) return;
    closed = true;
    dialog.close();
    dialog.remove();
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    onClose?.(reason);
  };
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (dismissible) close('cancel');
  });
  dialog.addEventListener('pointerdown', (e) => {
    if (e.target === dialog && dismissible) {
      const r = dialog.getBoundingClientRect();
      const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      if (outside) close('backdrop');
    }
  });
  document.body.append(dialog);
  dialog.showModal();
  const focusEl = initialFocus || dialog.querySelector('[autofocus]') || dialog.querySelector('.dialog-body input, .dialog-body button, .dialog-actions .btn-primary');
  const focus = () => {
    focusEl?.focus({ preventScroll: true });
    if (focusEl?.select && focusEl.tagName === 'INPUT') focusEl.select();
  };
  focus();
  // A dialog opened during a pointer gesture can lose focus when the gesture ends: put it back.
  requestAnimationFrame(() => { if (!closed && !dialog.contains(document.activeElement)) focus(); });
  return { el: dialog, close };
}

// ---- Menus ----------------------------------------------------------------------------------------

/**
 * Dropdown menu for a trigger button. items: [{ label, icon, hint, description, onSelect, disabled }
 * | 'separator' | { group: 'Heading', items: [...] }]. Pass a function to build items fresh each
 * time the menu opens.
 */
export function attachMenu(trigger, items, { align = 'end' } = {}) {
  const menuId = `menu-${Math.random().toString(36).slice(2, 8)}`;
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', menuId);
  let menu = null;

  const close = (refocus = true) => {
    if (!menu) return;
    menu.remove();
    menu = null;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('resize', onResize);
    if (refocus) trigger.focus({ preventScroll: true });
  };
  const onOutside = (e) => {
    if (menu && !menu.contains(e.target) && !trigger.contains(e.target)) close(false);
  };
  const onResize = () => close(false);
  const entries = () => [...menu.querySelectorAll('[role="menuitem"]:not([disabled])')];

  const open = (focusLast = false) => {
    const list = typeof items === 'function' ? items() : items;
    menu = h('div', { class: 'menu', id: menuId, attrs: { role: 'menu', 'aria-label': trigger.getAttribute('aria-label') || trigger.textContent.trim() } });
    const entry = (item) => h('button', {
      type: 'button', class: 'menu-item', disabled: !!item.disabled, attrs: { role: 'menuitem', tabindex: '-1' },
      on: { click: () => { close(); item.onSelect(); } },
    }, item.icon ? iconEl(item.icon) : null, h('span', { class: 'menu-text' },
      h('span', { class: 'menu-label', text: item.label }),
      item.description ? h('span', { class: 'menu-desc', text: item.description }) : null),
    item.hint ? h('kbd', { class: 'menu-hint', text: item.hint }) : null);
    for (const item of list) {
      if (item === 'separator') {
        menu.append(h('div', { class: 'menu-sep', attrs: { role: 'separator' } }));
      } else if (item.group) {
        const headingId = `${menuId}-${menu.childElementCount}`;
        menu.append(h('div', { class: 'menu-group', attrs: { role: 'group', 'aria-labelledby': headingId } },
          h('div', { class: 'menu-heading', id: headingId, text: item.group }), item.items.map(entry)));
      } else {
        menu.append(entry(item));
      }
    }
    menu.addEventListener('keydown', onKey);
    document.body.append(menu);
    const r = trigger.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const left = align === 'end' ? r.right - m.width : r.left;
    menu.style.left = `${Math.max(8, Math.min(innerWidth - m.width - 8, left))}px`;
    menu.style.top = `${r.bottom + 6}px`;
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('resize', onResize);
    const all = entries();
    (focusLast ? all[all.length - 1] : all[0])?.focus();
  };

  const onKey = (e) => {
    const all = entries();
    const i = all.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') all[(i + 1) % all.length]?.focus();
    else if (e.key === 'ArrowUp') all[(i - 1 + all.length) % all.length]?.focus();
    else if (e.key === 'Home') all[0]?.focus();
    else if (e.key === 'End') all[all.length - 1]?.focus();
    else if (e.key === 'Escape') close();
    else if (e.key === 'Tab') { close(false); return; }
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  trigger.addEventListener('click', () => (menu ? close() : open()));
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!menu) open(e.key === 'ArrowUp');
    }
  });
  return { open, close, get isOpen() { return !!menu; } };
}
