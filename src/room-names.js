// Naming the rooms traced from a floor plan by the labels drawn in them: the drawing's room tags (a
// name, a name over its number, or a number) become the rooms' names. Plain functions with no DOM.
//
// roomNames(rooms, labels) -> [name | null]: for each room ({ points } in plan units), the name its
//   tags give. labels: [{ text, x, y, h, w? }], lines of text at their middle, h the height of their
//   capitals and w their width, in the same units. A tag is a name line with the room number below it or after it; one room that holds
//   the tags of several (two rooms traced as one) is named for all of them, up to MAX_TAGS.
// labelKind(text) -> 'number' | 'name' | null: a room number (101, B-112), a name, or neither (a
//   dimension, an area, a note, an equipment tag such as FE-1, an annotation such as TYP. or UP).
// splitNumber(text) -> { name, number }: a tag written on one line (OFFICE 102), apart.
// titleCase(text): a name in capitals as words (CONF. ROOM -> Conf. Room; short words such as IT,
//   WC or MRI stay in capitals).
import { pointInPolygon, polygonCentroid } from './geometry.js';

const MAX_TAGS = 3;
const MAX_WORDS = 5;
const MAX_CHARS = 32;
// 101, 1203, B-112, RM 101, 101A (not an equipment tag such as FE-1, nor a single digit)
const NUMBER = /^(?:(?:RM|ROOM|NO)\.?\s*)?#?\s*((?:[A-Z]{1,2}[-.]?\d{3,4}|\d{2,4})[A-Z]?)$/i;
const CODE = /^[A-Z]{1,4}-\d{1,3}[A-Z]?$/i;
const DIMENSION = /\d\s*['′’]|\d\s*["″”]|\b\d+(?:\.\d+)?\s*(?:SF|S\.F\.|SQ\.?\s*FT\.?|SQFT|NSF|GSF|USF|RSF|M2|M²|SM)\b|\bAFF\b|\bA\.F\.F\./i;
// Annotations drawn in rooms that name no room.
const NOT_NAMES = new Set([
  'TYP', 'TYPICAL', 'SIM', 'SIMILAR', 'UP', 'DN', 'DOWN', 'EQ', 'NIC', 'ALIGN', 'ABOVE', 'BELOW', 'CLR', 'CLEAR', 'MIN', 'MAX',
  'VIF', 'EXIST', 'EXISTING', 'NEW', 'DEMO', 'REMOVE', 'OPEN', 'OPEN TO BELOW', 'NORTH', 'SCALE', 'PLAN', 'FLOOR PLAN', 'KEY PLAN',
  'NOTES', 'SEE', 'REF', 'DW', 'W/D', 'WD', 'WH', 'EWC', 'FEC', 'FE', 'FA', 'TV', 'AV', 'GWB', 'CMU', 'CONC', 'COL', 'GRID',
  'ACCESS', 'PANEL', 'SHELF', 'SHELVES', 'COUNTER', 'CASEWORK', 'MILLWORK', 'DESK', 'TABLE', 'CHAIR', 'SINK', 'LINE OF',
]);
// Short words that are names' own small words, not acronyms.
const SMALL = { AND: 'and', OF: 'of', THE: 'the', FOR: 'for', TO: 'to', RM: 'Rm', 'RM.': 'Rm.' };

const words = (text) => text.trim().split(/\s+/).filter(Boolean);
const key = (text) => text.toUpperCase().replace(/[.:,]/g, '').replace(/\s+/g, ' ').trim();

/**
 * A line of text without what OCR adds around a tag: marks it reads in the linework beside it (|,
 * a dash, ©), a symbol read as one character (a toilet as 0), a lowercase scrap beside capitals
 * (OFFICE lL), and punctuation at its ends (104., "106).
 */
export function cleanLabel(text) {
  const upper = /[A-Z]{2}/.test(text) && !/[a-z]{3}/.test(text);
  const junk = (w) => /^[^A-Za-z0-9#]+$/.test(w) || w.length === 1 || (upper && w.length <= 2 && /[a-z]/.test(w));
  const ws = words(text || '');
  while (ws.length && junk(ws[0])) ws.shift();
  while (ws.length && junk(ws[ws.length - 1])) ws.pop();
  return ws.join(' ').replace(/^[^A-Za-z0-9#]+/, '').replace(/[^A-Za-z0-9.)]+$/, '').replace(/^(\d+)\.$/, '$1');
}

/** A tag on one line, its name and its number after it (OFFICE 102), apart: { name, number }. */
export function splitNumber(text) {
  const t = cleanLabel(text);
  const m = /^(.*\S)\s+(\S+)$/.exec(t);
  if (m && NUMBER.test(m[2]) && labelKind(m[1]) === 'name') return { name: m[1], number: NUMBER.exec(m[2])[1] };
  return { name: t, number: null };
}

/** What a line of text is to a room: its number, its name, or neither (see the top of this file). */
export function labelKind(text) {
  const t = cleanLabel(text);
  if (!t || t.length > MAX_CHARS || words(t).length > MAX_WORDS) return null;
  if (NUMBER.test(t)) return 'number';
  if (DIMENSION.test(t) || CODE.test(t) || NOT_NAMES.has(key(t))) return null;
  // A name has a word of letters; a code like FE-1 or a single letter is not one.
  return (t.match(/[A-Za-z]/g) || []).length >= 2 && /[A-Za-z]{2,}/.test(t) ? 'name' : null;
}

/** A name written in capitals as words; one already in mixed case is left as it is. */
export function titleCase(text) {
  const t = text.trim().replace(/\s+/g, ' ');
  if (/[a-z]/.test(t)) return t;
  return t.split(' ').map((w) => {
    if (SMALL[w]) return SMALL[w];
    const letters = w.replace(/[^A-Z]/g, '');
    return letters.length <= 3 && !/^[A-Z]\.?$/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase().replace(/([-/])([a-z])/g, (m, s, c) => s + c.toUpperCase());
  }).join(' ');
}

/** Name lines written one over another, at one size and centered together, joined into one. */
function stack(names) {
  const sorted = [...names].sort((a, b) => a.y - b.y);
  const out = [];
  for (const n of sorted) {
    const above = out.find((o) => {
      const ratio = n.h / o.h;
      const width = Math.max(o.w, n.w);
      return ratio > 0.75 && ratio < 1.33 && n.y - o.bottom < 2.4 * o.h && n.y > o.y && Math.abs(n.x - o.x) < 0.6 * width;
    });
    if (above) {
      above.text += ` ${n.text}`;
      above.bottom = n.y;
      above.w = Math.max(above.w, n.w);
      above.number ||= n.number;
    } else {
      out.push({ ...n, bottom: n.y });
    }
  }
  return out;
}

/**
 * The tags in a room: each name line (stacked names joined) with the number below it or after it,
 * and the numbers left over on their own. [{ name, number, h, x, y }]
 */
function tagsIn(labels) {
  const names = [], numbers = [];
  for (const l of labels) {
    const text = cleanLabel(l.text);
    const kind = labelKind(text);
    // A width for lines that have none: capitals are about as wide as they are tall.
    const w = l.w ?? 0.95 * l.h * text.length;
    if (kind === 'name') {
      const tag = splitNumber(text);
      names.push({ ...l, text: tag.name, w, number: tag.number });
    }
    else if (kind === 'number') numbers.push({ ...l, text, w, number: NUMBER.exec(text)[1] });
  }
  const used = new Set();
  const tags = stack(names).map((n) => {
    if (n.number) return { name: n.text, number: n.number, h: n.h, x: n.x, y: n.y };
    // Below it and centered on it (lines are about 1.4 times their capitals' height apart, at
    // most twice), or after it on its line.
    const below = (m) => m.y > n.bottom && m.y - n.bottom < 2.8 * n.h && Math.abs(m.x - n.x) < 0.6 * Math.max(n.w, m.w);
    const after = (m) => Math.abs(m.y - n.y) < 0.5 * n.h && m.x > n.x && m.x - m.w / 2 - (n.x + n.w / 2) < 4 * n.h;
    const m = numbers.filter((c) => !used.has(c) && (below(c) || after(c))).sort((a, b) => Math.hypot(a.x - n.x, a.y - n.y) - Math.hypot(b.x - n.x, b.y - n.y))[0];
    if (m) used.add(m);
    return { name: n.text, number: m?.number ?? null, h: n.h, x: n.x, y: n.y };
  });
  for (const m of numbers) if (!used.has(m)) tags.push({ name: null, number: m.number, h: m.h, x: m.x, y: m.y });
  return tags;
}

const tagName = (t) => (t.name ? `${titleCase(t.name)}${t.number ? ` ${t.number}` : ''}` : `Room ${t.number}`);

/** The names the tags drawn in each room give it (see the top of this file), or null. */
export function roomNames(rooms, labels) {
  return rooms.map((room) => {
    const pts = room.points;
    if (!pts || pts.length < 3) return null;
    const inside = labels.filter((l) => l.text && pointInPolygon(l, pts));
    const tags = tagsIn(inside);
    if (!tags.length) return null;
    const c = polygonCentroid(pts);
    const near = (t) => Math.hypot(t.x - c.x, t.y - c.y);
    // Numbered tags are the rooms; among names alone, the largest is the room's, others annotate it.
    const numbered = tags.filter((t) => t.name && t.number).sort((a, b) => near(a) - near(b));
    if (numbered.length) return numbered.slice(0, MAX_TAGS).map(tagName).join(' / ');
    const named = tags.filter((t) => t.name);
    if (named.length) {
      const tallest = Math.max(...named.map((t) => t.h));
      return tagName(named.filter((t) => t.h >= 0.85 * tallest).sort((a, b) => near(a) - near(b))[0]);
    }
    return tagName(tags.sort((a, b) => near(a) - near(b))[0]);
  });
}
