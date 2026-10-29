// Naming the rooms traced from a floor plan by the labels drawn in them: the drawing's room tags (a
// name, a name over its number, or a number) become the rooms' names. Plain functions with no DOM.
//
// roomNames(rooms, labels) -> [name | null]: for each room ({ points } in plan units), the name its
//   tags give. labels: [{ text, x, y, h, w? }], lines of text at their middle, h the height of their
//   capitals and w their width, in the same units. A tag is a name line with the room number below
//   it or after it; one room that holds the tags of several (two rooms traced as one) is named for
//   all of them, up to MAX_TAGS. A label is the innermost room's that holds it.
// labelKind(text) -> 'number' | 'name' | null: a room number (101, B-112, #4), a name, or neither (a
//   dimension, an area, a note, an equipment tag such as FE-1, an annotation such as TYP. or UP).
// splitNumber(text) -> { name, number }: a tag written on one line (OFFICE 102), apart.
// titleCase(text): a name in capitals as words (CONF. ROOM -> Conf. Room; short words such as IT,
//   WC or MRI stay in capitals).
// ocrLabel(text, { caps }) -> { text, known }: a line OCR read, with its misreadings of room words
//   put right (RESTROPM -> RESTROOM); known: 'long' when it holds a room word of five letters or
//   more, 'short' for a shorter one (IT, LAB), else null.
// isDimension(text): a dimension, an area or a height above the floor (12'-6", 36", 150 SF, AFF).
import { pointInPolygon, polygonCentroid, polygonSignedArea } from './geometry.js';

const MAX_TAGS = 3;
const MAX_WORDS = 5;
const MAX_CHARS = 32;
// 101, 1203, B-112, RM 101, 101A, #4 (not an equipment tag such as FE-1, nor a digit without #)
const NUMBER = /^(?:(?:RM|ROOM|NO)\.?\s*)?(?:#\s*(\d{1,4}[A-Z]?)|#?\s*((?:[A-Z]{1,2}[-.]?\d{3,4}|\d{2,4})[A-Z]?))$/i;
const CODE = /^[A-Z]{1,4}-\d{1,3}[A-Z]?$/i;
// Feet, inches (OCR reads an inch mark as ° too: 20'-0" as 200°), areas and heights above the floor.
const DIMENSION = /\d\s*['′’]|\d\s*["″”°]|\b\d+(?:\.\d+)?\s*(?:SF|S\.F\.|SQ\.?\s*FT\.?|SQFT|NSF|GSF|USF|RSF|M2|M²|SM)\b|\bAFF\b|\bA\.F\.F\./i;
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

/** The room number a label is, as the drawing writes it (#4 keeps its #; RM 101 is 101), or null. */
function numberOf(text) {
  const m = NUMBER.exec(text);
  return m ? (m[1] ? `#${m[1]}` : m[2]).toUpperCase() : null;
}

/** A dimension, an area or a height above the floor (see DIMENSION). */
export const isDimension = (text) => DIMENSION.test(text || '');

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
  if (m && NUMBER.test(m[2]) && labelKind(m[1]) === 'name') return { name: m[1], number: numberOf(m[2]) };
  return { name: t, number: null };
}

/** What a line of text is to a room: its number, its name, or neither (see the top of this file). */
export function labelKind(text) {
  // A dimension before it is cleaned, which takes the inch mark off its end (36" is not room 36).
  if (DIMENSION.test(text || '')) return null;
  const t = cleanLabel(text);
  if (!t || t.length > MAX_CHARS || words(t).length > MAX_WORDS) return null;
  if (NUMBER.test(t)) return 'number';
  if (DIMENSION.test(t) || CODE.test(t) || NOT_NAMES.has(key(t))) return null;
  // A name has a word of letters; a code like FE-1, a single letter or a short scrap in small
  // letters (OCR's ll for two lines) is not one.
  return (t.match(/[A-Za-z]/g) || []).length >= 2 && /[A-Za-z]{2,}/.test(t) && (t.length > 3 || /^[A-Z]/.test(t)) ? 'name' : null;
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

// The words room names are made of, for reading OCR's text: a word it read a letter or two off one
// of these (RESTROPM, BRESTROOM) is taken for it, and two run together (BREAKRM) are parted.
const ROOM_WORDS = new Set(`
  ROOM ROOMS RM OFFICE OFFICES OFF OFC EXAM EXAMS EXAMINATION RESTROOM RESTROOMS TOILET TOILETS WC LAV LAVATORY BATH
  BATHROOM SHOWER SHOWERS LOCKER LOCKERS MEN MENS WOMEN WOMENS UNISEX STORAGE STOR STORE STOREROOM CLOSET CLO JAN
  JANITOR CUSTODIAL HOUSEKEEPING MECH MECHANICAL ELEC ELECTRICAL IT IDF MDF TEL TELECOM DATA SERVER CONFERENCE CONF
  MEETING BOARDROOM BOARD HUDDLE TRAINING CLASSROOM SEMINAR TEAM BREAK BREAKROOM LOUNGE KITCHEN KITCHENETTE PANTRY CAFE
  CAFETERIA DINING LUNCH COFFEE VENDING RECEPTION WAITING LOBBY VESTIBULE ENTRY ENTRANCE FOYER ATRIUM CORRIDOR CORR
  HALL HALLWAY PASSAGE CIRCULATION OPEN WORKROOM WORK COPY PRINT MAIL FILE FILES RECORDS SUPPLY SUPPLIES LINEN ARCHIVE
  WAREHOUSE DOCK SHIPPING RECEIVING LOADING STAFF NURSE NURSES NURSING STATION CHARTING MEDICATION MED LAB LABS
  LABORATORY WET DRY CHEMISTRY BIOLOGY MICROBIOLOGY PATHOLOGY HISTOLOGY TISSUE CULTURE CELL CLEAN SOILED DIRTY UTILITY
  GLASS WASH CAGE AUTOCLAVE STERILE PROCESSING COLD DECON EQUIPMENT VIVARIUM ANIMAL PROCEDURE PROCEDURES TREATMENT
  ENDOSCOPY INFUSION DIALYSIS CATH INJECTION OPERATING SURGERY SURGICAL IMAGING RADIOLOGY XRAY CT MRI ULTRASOUND
  MAMMOGRAPHY TRIAGE CONSULT CONSULTATION PATIENT RECOVERY ICU OBSERVATION HOLDING ISOLATION CHECK REGISTRATION INTAKE
  MANAGER DIRECTOR SUPERVISOR ADMIN ADMINISTRATION PHYSICIAN PROVIDER DOCTOR BILLING FOCUS PHONE STUDY WORKSTATION
  WORKSTATIONS SUITE STAIR STAIRS ELEVATOR ELEV MOTHERS LACTATION WELLNESS SECURITY PHARMACY LIBRARY FITNESS THERAPY
  SALES SHOP RETAIL FITTING STOCK MA OR RR ER AND OF
`.trim().split(/\s+/));

/**
 * The edit distance from a word read to a word (letters added, dropped or changed); a ? in the word
 * read, a mark OCR read in it, stands for one letter or none.
 */
function distance(a, b) {
  let prev = [0];
  for (let j = 1; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const any = a[i - 1] === '?';
    const row = [prev[0] + (any ? 0 : 1)];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + (any ? 0 : 1), row[j - 1] + 1, prev[j - 1] + (any || a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/**
 * A word OCR read, as two room words run together, or as the room word it is one letter off (two,
 * for a word of seven letters or more), marks read inside it (STOR~GE) left out; { text, known }
 * (known: the room words in it, or null). A word with a slash or a dash in it (CONSULT/OFFICE) is
 * known by its parts.
 */
function roomWord(word) {
  const t = word.toUpperCase();
  if (ROOM_WORDS.has(t)) return { text: word, known: t };
  if (/^[A-Z]+(?:[/-][A-Z]+)+$/.test(t)) {
    const parts = t.split(/[/-]/).filter((w) => ROOM_WORDS.has(w));
    return { text: word, known: parts.length ? parts.join(' ') : null };
  }
  // Letters, with marks read between them (STOR~GE) as ?.
  const read = /^[A-Z][^A-Z0-9\s]?(?:[A-Z][^A-Z0-9\s]?)*[A-Z]$/.test(t) ? t.replace(/[^A-Z]/g, '?') : null;
  const letters = read?.replace(/\?/g, '');
  if (!letters || letters.length < 4) return { text: word, known: null };
  for (let i = 2; i <= letters.length - 2; i++) {
    const a = letters.slice(0, i), b = letters.slice(i);
    if (ROOM_WORDS.has(a) && ROOM_WORDS.has(b)) return { text: `${a} ${b}`, known: letters };
  }
  if (ROOM_WORDS.has(letters)) return { text: letters, known: letters };
  if (letters.length < 5) return { text: word, known: null };
  const most = read.length >= 7 ? 2 : 1;
  let best = [], least = most + 1;
  for (const w of ROOM_WORDS) {
    if (w.length < letters.length - most || w.length > read.length + most) continue;
    const d = distance(read, w);
    if (d < least) [best, least] = [[w], d];
    else if (d === least) best.push(w);
  }
  // A word and its plural are one choice: the plural when the word read ends in S.
  const stem = (w) => (w.endsWith('S') && ROOM_WORDS.has(w.slice(0, -1)) ? w.slice(0, -1) : w);
  const stems = new Set(best.map(stem));
  if (stems.size !== 1) return { text: word, known: null };
  const [one] = stems;
  const pick = letters.endsWith('S') && best.includes(`${one}S`) ? `${one}S` : best.includes(one) ? one : best[0];
  return { text: pick, known: pick };
}

/** A line of text OCR read as a room label, with the room words in it put right (see the top of this file). */
export function ocrLabel(text, { caps = false } = {}) {
  let t = cleanLabel((text || '').replace(/(^|\s)=(?=\d)/g, '$1#').replace(/#\s+(?=\d)/g, '#'));
  if (caps) t = t.toUpperCase();
  // A number run onto the word before it (ROOM#12) parted from it.
  const read = words(t).flatMap((w) => {
    const m = /^(.*[A-Za-z])(#\d{1,4}[A-Z]?)$/.exec(w);
    return m ? [m[1], m[2]] : [w];
  }).map(roomWord);
  // Scraps at its ends: a word of two letters or less that is no room word (three, beside a long
  // room word: HET RECEPTION), or one with marks in it.
  const long = read.some((r) => r.known?.replace(/\s+/g, '').length >= 5);
  const scrap = (r) => !r.known && !NUMBER.test(r.text) && (r.text.replace(/[^A-Za-z]/g, '').length <= (long ? 3 : 2) || /[^A-Za-z0-9#/.&'()-]/.test(r.text));
  while (read.length && scrap(read[0])) read.shift();
  while (read.length && scrap(read[read.length - 1])) read.pop();
  const known = read.map((r) => r.known).filter(Boolean).join('').replace(/\s+/g, '');
  return { text: cleanLabel(read.map((r) => r.text).join(' ')), known: known.length >= 5 ? 'long' : known ? 'short' : null };
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
    const kind = labelKind(l.text);
    // A width for lines that have none: capitals are about as wide as they are tall.
    const w = l.w ?? 0.95 * l.h * text.length;
    if (kind === 'name') {
      const tag = splitNumber(text);
      names.push({ ...l, text: tag.name, w, number: tag.number });
    }
    else if (kind === 'number') numbers.push({ ...l, text, w, number: numberOf(text) });
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
  // A corridor traced around a block of rooms holds their labels as well as its own.
  const area = rooms.map((r) => (r.points?.length >= 3 ? Math.abs(polygonSignedArea(r.points)) : Infinity));
  const owner = labels.map((l) => rooms.reduce((best, r, i) => (area[i] < Infinity && l.text && pointInPolygon(l, r.points) && (best < 0 || area[i] < area[best]) ? i : best), -1));
  return rooms.map((room, i) => {
    const pts = room.points;
    if (!pts || pts.length < 3) return null;
    const inside = labels.filter((l, j) => owner[j] === i);
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
