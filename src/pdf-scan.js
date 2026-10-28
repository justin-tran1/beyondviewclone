// Finding the floor plan on a drawing sheet, for importing a page of a PDF: where on a rendered page
// the plan is (not the sheet's frame, title block, notes or schedules), how much the page looks like
// a floor plan, and the drawing scale the page's notes give. Plain functions with no DOM, in page
// pixels with y down.
//
// findPlanArea({ width, height, data }) -> { box: { x0, y0, x1, y1 }, score, share } | null
//   The drawing is read from its straight lines: unbroken horizontal and vertical runs of ink (walls,
//   partitions, casework, dimension lines), not text, symbols or filled areas. The sheet's borders
//   part it, so nothing is joined across them: its frame (the rectangle of long lines around the
//   sheet, or long lines along the page's edges) and the lines that run from one side of the frame
//   to the other (the edges of a title block or notes column). A plan's own long lines stop short
//   of the frame. Lines within a short reach of each other form one drawing, and the drawing with
//   the most linework is the plan. score is that linework in lengths of the page's long side;
//   share is its part of all the page's linework.
// textLines(items) -> [{ text, x0, x1, y, h }]: positioned text runs joined into lines.
// scaleNotes(lines) -> [{ text, ratio, x, y }]: the drawing scales written on the page (ratio: real
//   length per length on paper; 0 for "not to scale").
// chooseScaleNote(notes, box, long) -> { text, ratio } | null: the one that holds for the plan.
// planWords(text) -> a weight for how a page's titles name it: above 1 for floor plans.

const LINE_MIN = 0.012; // a line is a run at least this long, of the page's long side
const THICK_MAX = 0.012; // and no thicker than this: deeper ink is a filled area (a photo, a logo)
const LONG = 0.5; // runs this long, of the page's width or height, may be sheet borders
const FRAME = 0.6; // the frame's sides are at least this long
const EDGE = 0.025; // runs within this of the page's edges at least EDGE_LINE long are its frame too
const EDGE_LINE = 0.3;
const TOUCH = 0.006; // a line ends on another this close, of the long side
const CELL = 1 / 320; // the grid lines are clustered on, of the long side
const REACH = 0.008; // lines this close belong to one drawing
const NEAR = 0.025; // separate drawings this close to the plan join it (its dimensions, a wing)
const NEAR_MASS = 0.03; // when they hold at least this part of its linework
const PAD = 0.012; // margin kept around the plan

/** Ink: pixels clearly darker than the paper, which a scan can leave a little gray. */
function inkMask(data, W, H) {
  const lum = new Uint8Array(W * H);
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const v = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    lum[i] = v;
    hist[v]++;
  }
  // The paper is the level most of the page is at or above (its 70th percentile).
  let paper = 255;
  for (let v = 0, n = 0; v < 256; v++) {
    n += hist[v];
    if (n >= 0.7 * W * H) {
      paper = v;
      break;
    }
  }
  const t = Math.max(110, Math.min(215, paper - 45));
  const ink = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) ink[i] = lum[i] < t ? 1 : 0;
  return ink;
}

/** Length of the run of ink each pixel is in, along rows (dx = 1) or columns. */
function runLengths(ink, W, H, horizontal) {
  const out = new Uint16Array(W * H);
  const [n, m] = horizontal ? [H, W] : [W, H];
  const at = horizontal ? (i, j) => i * W + j : (i, j) => j * W + i;
  for (let i = 0; i < n; i++) {
    let j = 0;
    while (j < m) {
      if (!ink[at(i, j)]) {
        j++;
        continue;
      }
      let e = j;
      while (e < m && ink[at(i, e)]) e++;
      const len = Math.min(65535, e - j);
      for (let k = j; k < e; k++) out[at(i, k)] = len;
      j = e;
    }
  }
  return out;
}

/**
 * The floor plan on a rendered page: its box in px, score and share (see the top of this file), or
 * null when the page has no linework.
 */
export function findPlanArea({ width: W, height: H, data }) {
  if (!(W > 16 && H > 16) || !data || data.length < W * H * 4) return null;
  const side = Math.max(W, H);
  const ink = inkMask(data, W, H);
  const hLen = runLengths(ink, W, H, true), vLen = runLengths(ink, W, H, false);
  const minRun = Math.max(8, Math.round(LINE_MIN * side)), thick = Math.max(4, Math.round(THICK_MAX * side));
  const line = new Uint8Array(W * H);
  const runs = [];
  const mark = ({ horizontal, c, a, b }) => { for (let k = a; k < b; k++) line[horizontal ? c * W + k : k * W + c] = 1; };
  // A run is a line when most of it is thin across; long ones wait to be told from sheet borders.
  const take = (horizontal, c, a, b) => {
    const span = horizontal ? W : H, across = horizontal ? H : W;
    const len = b - a;
    const edge = c < EDGE * across || c > (1 - EDGE) * across;
    let thin = 0;
    for (let k = a; k < b; k++) if ((horizontal ? vLen[c * W + k] : hLen[k * W + c]) <= thick) thin++;
    if (thin < 0.5 * len && !edge) return;
    if (len >= LONG * span || (edge && len >= EDGE_LINE * span)) runs.push({ horizontal, c, a, b, edge });
    else mark({ horizontal, c, a, b });
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W;) {
      const n = hLen[y * W + x];
      if (n >= minRun) take(true, y, x, x + n);
      x += Math.max(1, n);
    }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H;) {
      const n = vLen[y * W + x];
      if (n >= minRun) take(false, x, y, y + n);
      y += Math.max(1, n);
    }
  }
  const sheet = sheetLines(runs, W, H, Math.max(3, TOUCH * side));
  for (const r of runs) if (!sheet.includes(r)) mark(r);

  // Linework per cell of a coarse grid; cells the sheet borders run through part the page.
  const c = Math.max(3, Math.round(CELL * side));
  const gw = Math.ceil(W / c), gh = Math.ceil(H / c);
  const mass = new Float32Array(gw * gh);
  for (let y = 0; y < H; y++) {
    const row = ((y / c) | 0) * gw;
    for (let x = 0; x < W; x++) if (line[y * W + x]) mass[row + ((x / c) | 0)]++;
  }
  const wall = new Uint8Array(gw * gh);
  for (const s of sheet) {
    const g = (s.c / c) | 0;
    for (let k = (s.a / c) | 0; k <= Math.min((s.horizontal ? gw : gh) - 1, ((s.b - 1) / c) | 0); k++) {
      wall[s.horizontal ? g * gw + k : k * gw + g] = 1;
    }
  }
  // Grow the linework by REACH, never through a sheet border, and find what it joins into.
  let on = new Uint8Array(gw * gh);
  for (let k = 0; k < gw * gh; k++) on[k] = mass[k] > 0 && !wall[k] ? 1 : 0;
  const reach = Math.max(1, Math.round((REACH * side) / c));
  for (let s = 0; s < reach; s++) {
    const next = on.slice();
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const k = j * gw + i;
        if (on[k] || wall[k]) continue;
        if ((i > 0 && on[k - 1]) || (i < gw - 1 && on[k + 1]) || (j > 0 && on[k - gw]) || (j < gh - 1 && on[k + gw])) next[k] = 1;
      }
    }
    on = next;
  }
  const label = new Int32Array(gw * gh).fill(-1);
  const comps = [];
  for (let k0 = 0; k0 < gw * gh; k0++) {
    if (!on[k0] || label[k0] >= 0) continue;
    const comp = { mass: 0, x0: Infinity, y0: Infinity, x1: -1, y1: -1 };
    const stack = [k0];
    label[k0] = comps.length;
    while (stack.length) {
      const k = stack.pop();
      const i = k % gw, j = (k - i) / gw;
      if (mass[k] > 0) {
        comp.mass += mass[k];
        comp.x0 = Math.min(comp.x0, i); comp.x1 = Math.max(comp.x1, i);
        comp.y0 = Math.min(comp.y0, j); comp.y1 = Math.max(comp.y1, j);
      }
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= gw || jj >= gh) continue;
          const kk = jj * gw + ii;
          if (on[kk] && label[kk] < 0) {
            label[kk] = comps.length;
            stack.push(kk);
          }
        }
      }
    }
    if (comp.mass > 0) comps.push(comp);
    else comps.push(null);
  }
  const drawings = comps.filter(Boolean);
  if (!drawings.length) return null;
  const total = drawings.reduce((s, d) => s + d.mass, 0);
  const best = drawings.reduce((a, b) => (b.mass > a.mass ? b : a));

  // A border between two boxes (in cells) when a sheet line runs between them across their overlap.
  const lines = sheet.map((s) => ({ ...s, g: s.c / c, ga: s.a / c, gb: s.b / c }));
  const parted = (p, q) => lines.some((s) => {
    if (s.horizontal) {
      const between = (s.g > p.y1 && s.g < q.y0) || (s.g > q.y1 && s.g < p.y0);
      return between && s.ga <= Math.max(p.x1, q.x1) && s.gb >= Math.min(p.x0, q.x0);
    }
    const between = (s.g > p.x1 && s.g < q.x0) || (s.g > q.x1 && s.g < p.x0);
    return between && s.ga <= Math.max(p.y1, q.y1) && s.gb >= Math.min(p.y0, q.y0);
  });
  // The plan's other parts: drawings close to it with linework of their own, on its side of every border.
  const box = { x0: best.x0, y0: best.y0, x1: best.x1, y1: best.y1 };
  let mass0 = best.mass;
  const near = (NEAR * side) / c;
  const used = new Set([best]);
  for (let grown = true; grown;) {
    grown = false;
    for (const d of drawings) {
      if (used.has(d) || d.mass < NEAR_MASS * best.mass) continue;
      const gap = Math.max(d.x0 - box.x1, box.x0 - d.x1, d.y0 - box.y1, box.y0 - d.y1, 0);
      if (gap > near || parted(box, d)) continue;
      used.add(d);
      mass0 += d.mass;
      box.x0 = Math.min(box.x0, d.x0); box.x1 = Math.max(box.x1, d.x1);
      box.y0 = Math.min(box.y0, d.y0); box.y1 = Math.max(box.y1, d.y1);
      grown = true;
    }
  }
  // In px with a margin, kept inside the page and the sheet borders around it.
  const pad = PAD * side;
  const out = { x0: box.x0 * c - pad, y0: box.y0 * c - pad, x1: (box.x1 + 1) * c + pad, y1: (box.y1 + 1) * c + pad };
  for (const s of sheet) {
    const g = s.c;
    if (s.horizontal) {
      if (s.a > (box.x1 + 1) * c || s.b < box.x0 * c) continue;
      if (g < box.y0 * c) out.y0 = Math.max(out.y0, g + 2);
      else if (g > (box.y1 + 1) * c) out.y1 = Math.min(out.y1, g - 2);
    } else {
      if (s.a > (box.y1 + 1) * c || s.b < box.y0 * c) continue;
      if (g < box.x0 * c) out.x0 = Math.max(out.x0, g + 2);
      else if (g > (box.x1 + 1) * c) out.x1 = Math.min(out.x1, g - 2);
    }
  }
  const area = {
    x0: Math.max(0, Math.round(out.x0)), y0: Math.max(0, Math.round(out.y0)),
    x1: Math.min(W, Math.round(out.x1)), y1: Math.min(H, Math.round(out.y1)),
  };
  return { box: area, score: mass0 / side, share: mass0 / total };
}

/**
 * The runs ({ horizontal, c, a, b, edge }) that are sheet borders: those along the page's edges, the
 * frame (outermost long lines that meet at its corners) and lines whose two ends meet a border or
 * the page's edge. Rows of one thick line count as one line. tol: how close (px) lines meet.
 */
function sheetLines(runs, W, H, tol) {
  const lines = [];
  for (const r of [...runs].sort((p, q) => p.c - q.c)) {
    const l = lines.find((o) => o.horizontal === r.horizontal && r.c - o.cMax <= 2 && r.a < o.b && r.b > o.a);
    if (l) {
      l.cMax = r.c;
      l.a = Math.min(l.a, r.a);
      l.b = Math.max(l.b, r.b);
      l.edge ||= r.edge;
      l.runs.push(r);
    } else {
      lines.push({ horizontal: r.horizontal, c0: r.c, cMax: r.c, a: r.a, b: r.b, edge: r.edge, runs: [r] });
    }
  }
  for (const l of lines) l.c = (l.c0 + l.cMax) / 2;
  const border = new Set(lines.filter((l) => l.edge));
  const hs = lines.filter((l) => l.horizontal && l.b - l.a >= FRAME * W), vs = lines.filter((l) => !l.horizontal && l.b - l.a >= FRAME * H);
  if (hs.length >= 2 && vs.length >= 2) {
    const pick = (list, far) => list.reduce((p, q) => ((far ? q.c > p.c : q.c < p.c) ? q : p));
    const top = pick(hs, false), bottom = pick(hs, true), left = pick(vs, false), right = pick(vs, true);
    const spans = (l, from, to) => l.a <= from + tol && l.b >= to - tol;
    if (bottom.c - top.c >= 0.5 * H && right.c - left.c >= 0.5 * W
      && spans(top, left.c, right.c) && spans(bottom, left.c, right.c) && spans(left, top.c, bottom.c) && spans(right, top.c, bottom.c)) {
      for (const l of [top, bottom, left, right]) border.add(l);
    }
  }
  // An end meets the page's edge, or a border across it.
  const meets = (l, at) => at <= tol || at >= (l.horizontal ? W : H) - tol
    || [...border].some((o) => o.horizontal !== l.horizontal && Math.abs(o.c - at) <= tol + (o.cMax - o.c0) / 2 && o.a - tol <= l.c && l.c <= o.b + tol);
  for (let pass = 0; pass < 2; pass++) {
    for (const l of lines) if (!border.has(l) && meets(l, l.a) && meets(l, l.b - 1)) border.add(l);
  }
  return [...border].flatMap((l) => l.runs);
}

// ---- Text ---------------------------------------------------------------------------------------

/**
 * Text runs ({ str, x, y, w, h }: left, baseline, width and height in page px) joined into lines:
 * runs on one baseline that follow each other closely.
 */
export function textLines(items) {
  const runs = items.filter((t) => t.str && t.str.trim() && t.h > 0).sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const t of runs) {
    const line = lines.find((l) => Math.abs(l.y - t.y) < 0.4 * Math.max(l.h, t.h) && t.x >= l.x0 - 0.5 * t.h && t.x - l.x1 < 2.5 * Math.max(l.h, t.h));
    if (line) {
      line.text += (t.x - line.x1 > 0.15 * t.h ? ' ' : '') + t.str;
      line.x1 = Math.max(line.x1, t.x + t.w);
      line.h = Math.max(line.h, t.h);
    } else {
      lines.push({ text: t.str, x0: t.x, x1: t.x + t.w, y: t.y, h: t.h });
    }
  }
  return lines;
}

const QUOTES = (s) => s.replace(/[″“”]/g, '"').replace(/[′’‘`´]/g, "'").replace(/''/g, '"');
const number = (s) => {
  const t = s.trim().split(/\s+/);
  return t.reduce((sum, part) => {
    const [n, d] = part.split('/').map(Number);
    return sum + (d ? n / d : n);
  }, 0);
};
// 1/4" = 1'-0"; 3/16"=1'-0"; 1 1/2" = 1'-0"; 1" = 1'
const ARCH = /(\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d+(?:\.\d+)?)\s*(?:"|in\b\.?|inch(?:es)?\b)\s*=\s*1\s*(?:'|ft\b\.?|foot\b)(?:\s*-?\s*0\s*(?:"|in\b)?)?/i;
// 1" = 20'-0"; 1" = 40'
const ENGINEERING = /\b1\s*(?:"|in\b\.?|inch\b)\s*=\s*(\d+(?:\.\d+)?)\s*(?:'|ft\b\.?|feet\b|foot\b)(?:\s*-?\s*0\s*")?/i;
// 1:100, 1 : 50
const METRIC = /(?:^|[^\d:.])1\s*:\s*(\d{1,4}(?:[.,]\d+)?)(?![\d:])/;
const NTS = /\bN\.?\s?T\.?\s?S\b\.?|\bNOT\s+TO\s+SCALE\b/i;

/** The drawing scales written in lines of text (see the top of this file). */
export function scaleNotes(lines) {
  const out = [];
  for (const l of lines) {
    const text = QUOTES(l.text);
    const at = { x: (l.x0 + l.x1) / 2, y: l.y - l.h / 2 };
    let m = ARCH.exec(text);
    if (m) {
      const inches = number(m[1].replace(/\s*\/\s*/g, '/'));
      if (inches > 0 && inches <= 12) {
        out.push({ text: m[0].trim(), ratio: 12 / inches, ...at });
        continue;
      }
    }
    m = ENGINEERING.exec(text);
    if (m && +m[1] >= 1) {
      out.push({ text: m[0].trim(), ratio: +m[1] * 12, ...at });
      continue;
    }
    m = METRIC.exec(text);
    if (m && (/scale/i.test(text) || text.trim() === m[0].trim())) {
      const n = parseFloat(m[1].replace(',', '.'));
      if (n >= 5 && n <= 5000) {
        out.push({ text: `1:${m[1]}`, ratio: n, ...at });
        continue;
      }
    }
    if (NTS.test(text)) out.push({ text: 'Not to scale', ratio: 0, ...at });
  }
  return out;
}

/**
 * The scale note that holds for a plan in `box` (page px; long: the page's long side): the only
 * scale written on the page, else the one nearest the plan. A "not to scale" note by the plan means
 * none does.
 */
export function chooseScaleNote(notes, box, long) {
  if (!notes.length) return null;
  const dist = (n) => Math.hypot(Math.max(box.x0 - n.x, 0, n.x - box.x1), Math.max(box.y0 - n.y, 0, n.y - box.y1));
  const sorted = notes.map((n) => ({ ...n, d: dist(n) })).sort((a, b) => a.d - b.d);
  if (sorted[0].ratio === 0 && sorted[0].d < 0.1 * long) return null;
  const scaled = sorted.filter((n) => n.ratio > 0);
  if (!scaled.length) return null;
  const same = scaled.every((n) => Math.abs(n.ratio / scaled[0].ratio - 1) < 1e-3);
  if (same || scaled[0].d < 0.25 * long) return { text: scaled[0].text, ratio: scaled[0].ratio };
  return null;
}

const PLAN_TITLE = /\b(FLOOR|FURNITURE|FINISH|DIMENSION|PARTITION|EQUIPMENT|LIFE SAFETY|ENLARGED|OVERALL)\s+PLANS?\b|\b(LEVEL|FLOOR)\s+\w+\s+PLAN\b|\b(FIRST|SECOND|THIRD|FOURTH|GROUND|MAIN)\s+FLOOR\b/i;
const OTHER_TITLE = /\b(REFLECTED\s+CEILING|CEILING|ROOF|SITE|DEMOLITION|FOUNDATION|FRAMING)\s+PLANS?\b|\bRCP\b|\bELEVATIONS?\b|\bSECTIONS?\b|\bDETAILS?\b|\bSCHEDULES?\b|\bCOVER\s+SHEET\b|\bSHEET\s+INDEX\b|\bGENERAL\s+NOTES\b/i;

/** How a page's text names it: 1.6 for a floor plan, 0.6 for other sheets, 1 when it does not say. */
export function planWords(text) {
  if (PLAN_TITLE.test(text)) return 1.6;
  return OTHER_TITLE.test(text) ? 0.6 : 1;
}
