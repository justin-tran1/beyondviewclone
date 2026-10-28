// Test PDFs for the PDF import, printed by Chromium from HTML drawing sheets: the trace demo's floor
// plan (assets/samples/trace-demo.svg, 24 px per foot) on a 36 x 24 in sheet at 1/4" = 1'-0", with a
// frame, title block, general notes, a legend, a north arrow and the drawing's title and scale note,
// between a cover sheet and a door schedule sheet. Variants: the floor plan sheet printed to fit an
// 11 x 17 in page (so its scale note no longer holds), and scanned (a raster page with no text).
// Usage: node dev/tests/pdf-sheets.mjs <baseUrl> <outDir>, or import makeTestPdfs().
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHEET = { w: 36, h: 24 };

const STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #111; }
  .sheet { position: relative; width: ${SHEET.w}in; height: ${SHEET.h}in; overflow: hidden; break-after: page; background: #fff; }
  .frame { position: absolute; left: 0.5in; top: 0.5in; right: 0.5in; bottom: 0.5in; border: 0.035in solid #111; }
  .tb { position: absolute; top: 0.5in; bottom: 0.5in; right: 0.5in; width: 3.6in; border-left: 0.035in solid #111; display: flex; flex-direction: column; }
  .tb > div { border-bottom: 0.012in solid #111; padding: 0.12in 0.16in; font-size: 0.12in; line-height: 1.35; }
  .tb .firm { font-size: 0.34in; font-weight: 700; letter-spacing: 0.02in; color: #003f2d; padding: 0.3in 0.16in; }
  .tb .big { font-size: 0.24in; font-weight: 700; }
  .tb .sheetno { font-size: 0.5in; font-weight: 700; margin-top: auto; border-bottom: 0; }
  .label { font-size: 0.09in; color: #555; display: block; }
  .rev { display: grid; grid-template-columns: 0.4in 1fr 0.8in; }
  .rev span { border-bottom: 0.008in solid #111; padding: 0.04in 0.03in; font-size: 0.1in; min-height: 0.22in; }
  .notes { position: absolute; left: 1in; top: 1in; width: 6.6in; font-size: 0.12in; line-height: 1.5; }
  .notes h2, .legend h2 { font-size: 0.17in; margin: 0 0 0.1in; text-decoration: underline; }
  .notes ol { margin: 0; padding-left: 0.25in; }
  .legend { position: absolute; left: 1in; top: 13in; width: 6.6in; font-size: 0.12in; }
  .legend .row { display: flex; align-items: center; gap: 0.2in; margin: 0.12in 0; }
  .legend .sw { width: 0.9in; height: 0.16in; }
  .title { position: absolute; display: flex; align-items: center; gap: 0.2in; }
  .title .num { width: 0.55in; height: 0.55in; border: 0.02in solid #111; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 0.2in; }
  .title .name { font-size: 0.24in; font-weight: 700; border-bottom: 0.02in solid #111; padding-bottom: 0.04in; min-width: 5in; }
  .title .scale { font-size: 0.13in; margin-top: 0.04in; }
  table { border-collapse: collapse; }
  td, th { border: 0.01in solid #111; padding: 0.05in 0.08in; font-size: 0.12in; text-align: left; }
`;

function titleBlock(title, number) {
  const revs = ['1', '2', '3', '4'].map((n) => `<span>${n}</span><span>${n === '1' ? 'Issued for permit' : ''}</span><span>${n === '1' ? '10/28/2026' : ''}</span>`).join('');
  return `<div class="tb">
    <div class="firm">CBRE</div>
    <div><span class="label">PROJECT</span>Medical Office Suite 210<br>1200 Harbor Boulevard, Suite 210</div>
    <div><span class="label">CLIENT</span>Harbor Health Partners</div>
    <div><span class="label">KEY PLAN</span><svg width="2.2in" height="1.1in" viewBox="0 0 220 110"><rect x="10" y="10" width="200" height="90" fill="none" stroke="#111" stroke-width="2"/><rect x="120" y="10" width="90" height="45" fill="#bbb" stroke="#111" stroke-width="2"/><line x1="10" y1="55" x2="210" y2="55" stroke="#111" stroke-width="1"/></svg></div>
    <div><span class="label">REVISIONS</span><div class="rev">${revs}</div></div>
    <div><span class="label">SCALE</span>As noted<br><span class="label">DATE</span>10/28/2026<br><span class="label">DRAWN BY</span>JT &nbsp; <span class="label" style="display:inline">CHECKED BY</span> MR</div>
    <div><span class="label">SHEET TITLE</span><span class="big">${title}</span></div>
    <div class="sheetno">${number}</div>
  </div>`;
}

const NOTES = [
  'All dimensions are to face of finish unless noted otherwise.',
  'Do not scale the drawings. Verify all dimensions in the field before starting work.',
  'Provide blocking in walls for all wall mounted casework, equipment and accessories.',
  'Partitions extend to the underside of the ceiling unless noted to the structure above.',
  'Seal all penetrations of rated partitions with a listed firestopping system.',
  'Exam room casework, sinks and accessories per the equipment plan and schedules.',
  'Provide corner guards at all outside corners in corridors and clinical spaces.',
  'Finish floors to be sheet vinyl with integral cove base in clinical areas.',
  'Coordinate all ceiling heights with the reflected ceiling plan.',
  'Door hardware per the hardware schedule. All doors to have lever handles.',
  'Provide acoustic insulation in exam room, office and conference partitions.',
  'The contractor shall protect existing finishes to remain throughout construction.',
];

function legend() {
  return `<div class="legend"><h2>WALL LEGEND</h2>
    <div class="row"><div class="sw" style="background:#111"></div>Exterior wall, 12 in</div>
    <div class="row"><div class="sw" style="background:#111;height:0.07in"></div>Interior partition, 5 in, to ceiling</div>
    <div class="row"><div class="sw" style="border:0.015in solid #111;height:0.1in"></div>Glazed partition</div>
  </div>`;
}

function northArrow(left, top) {
  return `<svg style="position:absolute;left:${left}in;top:${top}in" width="1.2in" height="1.6in" viewBox="0 0 120 160">
    <circle cx="60" cy="90" r="45" fill="none" stroke="#111" stroke-width="3"/>
    <path d="M60 30 L80 110 L60 95 L40 110 Z" fill="#111"/>
    <text x="60" y="22" text-anchor="middle" font-size="22" font-family="Arial" font-weight="700">N</text></svg>`;
}

function planSheet(svgUrl) {
  // 1680 px at 24 px per foot is 70 ft: 17.5 in at 1/4" = 1'-0".
  return `<div class="sheet">
    <div class="frame"></div>
    ${titleBlock('FLOOR PLAN', 'A-101')}
    <div class="notes"><h2>GENERAL NOTES</h2><ol>${NOTES.map((n) => `<li>${n}</li>`).join('')}</ol></div>
    ${legend()}
    <img src="${svgUrl}" style="position:absolute;left:8.6in;top:2.4in;width:17.5in">
    <div class="title" style="left:8.9in;top:17.2in"><div class="num">1</div><div><div class="name">FLOOR PLAN</div><div class="scale">SCALE: 1/4" = 1'-0"</div></div></div>
    ${northArrow(27.4, 2.6)}
  </div>`;
}

function coverSheet() {
  const rows = [['G-001', 'COVER SHEET'], ['A-101', 'FLOOR PLAN'], ['A-201', 'REFLECTED CEILING PLAN'], ['A-501', 'DOOR SCHEDULE AND DETAILS'], ['A-601', 'FINISH SCHEDULE']];
  return `<div class="sheet">
    <div class="frame"></div>
    ${titleBlock('COVER SHEET', 'G-001')}
    <div style="position:absolute;left:1.5in;top:1.5in;font-size:0.9in;font-weight:700;color:#003f2d">MEDICAL OFFICE SUITE 210</div>
    <div style="position:absolute;left:1.5in;top:2.8in;font-size:0.4in">CONSTRUCTION DOCUMENTS · 10/28/2026</div>
    <div style="position:absolute;left:1.5in;top:4in;width:18in;height:12in;background:linear-gradient(160deg,#b9c9d6,#6f8796 60%,#3e4c55);"></div>
    <table style="position:absolute;left:21in;top:4in;width:9in"><tr><th>SHEET</th><th>TITLE</th></tr>${rows.map(([n, t]) => `<tr><td>${n}</td><td>${t}</td></tr>`).join('')}</table>
  </div>`;
}

function scheduleSheet() {
  const cols = ['DOOR', 'ROOM', 'WIDTH', 'HEIGHT', 'TYPE', 'MATERIAL', 'FRAME', 'HARDWARE', 'RATING', 'REMARKS'];
  const rows = Array.from({ length: 24 }, (_, i) => [`${101 + i}`, ['EXAM', 'OFFICE', 'CORRIDOR', 'RESTROOM'][i % 4], `3'-0"`, `7'-0"`, 'A', 'WD', 'HM', `HW-${1 + (i % 5)}`, i % 6 ? '' : '20 MIN', '']);
  const detail = (x, y, i) => `<svg style="position:absolute;left:${x}in;top:${y}in" width="4in" height="3.4in" viewBox="0 0 400 340">
    <rect x="40" y="30" width="320" height="220" fill="none" stroke="#111" stroke-width="3"/>
    <rect x="70" y="60" width="120" height="160" fill="none" stroke="#111" stroke-width="2"/>
    <circle cx="270" cy="140" r="60" fill="none" stroke="#111" stroke-width="2"/>
    <text x="40" y="300" font-size="26" font-family="Arial" font-weight="700">${i} DETAIL</text>
    <text x="40" y="330" font-size="18" font-family="Arial">SCALE: 1 1/2" = 1'-0"</text></svg>`;
  return `<div class="sheet">
    <div class="frame"></div>
    ${titleBlock('DOOR SCHEDULE AND DETAILS', 'A-501')}
    <div style="position:absolute;left:1in;top:1in;font-size:0.22in;font-weight:700">DOOR SCHEDULE</div>
    <table style="position:absolute;left:1in;top:1.5in;width:20in"><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>
    ${[0, 1, 2, 3].map((i) => detail(1 + i * 5, 15.5, i + 1)).join('')}
  </div>`;
}

const page = (body, size = `${SHEET.w}in ${SHEET.h}in`) => `<!doctype html><html><head><meta charset="utf-8"><style>@page { size: ${size}; margin: 0; } ${STYLE}</style></head><body>${body}</body></html>`;

/**
 * Write set.pdf (cover, floor plan, schedule), tabloid.pdf (the floor plan sheet printed to fit
 * 17 x 11 in) and scan.pdf (the floor plan sheet as a 100 dpi raster, as a scanner makes it) to
 * outDir. Returns their paths.
 */
export async function makeTestPdfs(browser, base, outDir) {
  mkdirSync(outDir, { recursive: true });
  const svgUrl = new URL('assets/samples/trace-demo.svg', base).href;
  const tab = await browser.newPage();
  const print = async (html, file, opts) => {
    await tab.setContent(html, { waitUntil: 'load' });
    await tab.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
    const path = join(outDir, file);
    await tab.pdf({ path, printBackground: true, preferCSSPageSize: true, ...opts });
    return path;
  };
  const set = await print(page(coverSheet() + planSheet(svgUrl) + scheduleSheet()), 'set.pdf');
  // Fit to an 11 x 17 in page: 11 / 24 of full size.
  const k = 11 / SHEET.h;
  const tabloid = await print(page(`<div style="width:17in;height:11in;overflow:hidden"><div style="transform:scale(${k});transform-origin:0 0">${planSheet(svgUrl)}</div></div>`, '17in 11in'), 'tabloid.pdf');
  // A scan: the sheet at 100 dpi on slightly gray paper with speckles, placed as an image.
  await tab.setViewportSize({ width: SHEET.w * 96, height: SHEET.h * 96 });
  await tab.setContent(page(planSheet(svgUrl)), { waitUntil: 'load' });
  await tab.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
  const shot = await tab.screenshot({ clip: { x: 0, y: 0, width: SHEET.w * 96, height: SHEET.h * 96 }, scale: 'css' });
  const noisy = await tab.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * 100 / 96);
    c.height = Math.round(img.height * 100 / 96);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < d.data.length; i += 4) {
      const v = d.data[i] * 0.88 + 20 + (rnd() - 0.5) * 18 - (rnd() < 0.0015 ? 120 : 0);
      d.data[i] = d.data[i + 1] = d.data[i + 2] = Math.max(0, Math.min(255, v));
    }
    ctx.putImageData(d, 0, 0);
    return c.toDataURL('image/jpeg', 0.85);
  }, shot.toString('base64'));
  const scan = await print(page(`<div class="sheet"><img src="${noisy}" style="position:absolute;inset:0;width:100%;height:100%"></div>`), 'scan.pdf');
  await tab.close();
  return { set, tabloid, scan };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base = 'http://localhost:8080/', out = 'pdf-out'] = process.argv.slice(2);
  const browser = await chromium.launch();
  const paths = await makeTestPdfs(browser, base, out);
  await browser.close();
  writeFileSync(join(out, 'paths.json'), JSON.stringify(paths, null, 1));
  console.log(JSON.stringify(paths));
}
