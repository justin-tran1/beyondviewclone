// Trace a floor plan: a 60' x 40' office suite drawing (assets/samples/trace-demo.svg, drawn at
// 1/4" = 1'-0", 24 px per foot) placed as the underlay, with only the exterior walls and their
// windows and entry door traced so people can practice tracing the rest.
import { createLayout } from './helpers.js';

const DRAWING = new URL('../../assets/samples/trace-demo.svg', import.meta.url);
const PX_PER_FOOT = 24;
/** Pixel position of the drawing's plan origin (the exterior wall centerline corner). */
const ORIGIN_PX = { x: 120, y: 200 };

export async function buildTraceDemo() {
  const res = await fetch(DRAWING);
  if (!res.ok) throw new Error(`Could not load the sample drawing (${res.status})`);
  const svg = await res.text();
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;

  const L = createLayout({ name: 'Trace a floor plan', wallHeight: 9.5, ceiling: 'tile', exterior: 'city' });
  L.setUnderlay({
    src: `data:image/svg+xml;base64,${base64(svg)}`,
    width: Number(root.getAttribute('width')),
    height: Number(root.getAttribute('height')),
    scale: 1 / PX_PER_FOOT,
    x: -ORIGIN_PX.x / PX_PER_FOOT,
    y: -ORIGIN_PX.y / PX_PER_FOOT,
    opacity: 0.6,
  });

  const shell = L.rect(0, 0, 60, 40, 'exterior');
  for (const x of [6, 14, 26, 38, 50]) L.window(shell.n, x, { width: 6 });
  L.window(shell.e, 7, { width: 6 });
  L.window(shell.e, 24.5, { width: 5 });
  L.window(shell.e, 35, { width: 4 });
  L.door(shell.s, 9, { width: 3.5, swing: 'n', hinge: 'w' });
  for (const x of [25, 37]) L.window(shell.s, x, { width: 6 });
  for (const y of [7, 29]) L.window(shell.w, y, { width: 6 });
  L.camera('Entry', 9, 36.5, 20, -2);
  return L.build();
}

/** Base64 of a string's UTF-8 bytes. */
function base64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
