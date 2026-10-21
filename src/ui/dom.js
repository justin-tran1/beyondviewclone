// Tiny DOM helpers shared by the UI modules.
import { icon } from './icons.js';

/**
 * Create an element. props: class, text, html (trusted markup only), for (a label's control id),
 * attrs, dataset, style, on ({event: handler}); any other key is assigned as a property. Children
 * may be nodes or strings.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'for') el.setAttribute('for', value);
    else if (key === 'attrs') for (const [k, v] of Object.entries(value)) { if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v); }
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') for (const [k, v] of Object.entries(value)) { if (k.startsWith('--')) el.style.setProperty(k, v); else el.style[k] = v; }
    else if (key === 'on') for (const [type, fn] of Object.entries(value)) el.addEventListener(type, fn);
    else el[key] = value;
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function iconEl(name, cls = 'icon') {
  const span = h('span', { class: cls, attrs: { 'aria-hidden': 'true' } });
  span.innerHTML = icon(name);
  return span;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const isMac = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform || '');
export const MOD = isMac ? '⌘' : 'Ctrl';

/** True when typing in this element should keep keys to itself. */
export function isTextField(el) {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color'].includes(el.type);
}

export function debounce(fn, ms) {
  let t = 0;
  let pending = false;
  const run = (...args) => {
    clearTimeout(t);
    pending = true;
    t = setTimeout(() => { pending = false; fn(...args); }, ms);
  };
  run.flush = (...args) => {
    if (!pending) return;
    clearTimeout(t);
    pending = false;
    fn(...args);
  };
  run.cancel = () => { clearTimeout(t); pending = false; };
  return run;
}

/** Download a Blob under a file name. */
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** File name safe on every platform, without the extension. */
export function safeFileName(name, fallback = 'plan') {
  const s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return s || fallback;
}

/** Ask for files with a temporary input. Resolves with a FileList (possibly empty). */
export function pickFiles(accept, { multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    input.addEventListener('change', () => {
      resolve([...input.files]);
      input.remove();
    }, { once: true });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    }, { once: true });
    document.body.append(input);
    input.click();
  });
}
