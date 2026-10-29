// Checks for the text read on PDF pages (src/pdf-scan.js): scale notes in a page's text and the
// misreads OCR makes of them (the ones below were seen reading scans and SHX text), OCR's words and
// lines, and the titles that name a sheet.
// Usage: node dev/tests/pdf-text.mjs. Exits 1 on any failure.
import { scaleNotes, ocrScale, ocrLines, chooseScaleNote, tsvWords, pageTitles } from '../../src/pdf-scan.js';

let failed = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: ${JSON.stringify(got)}${ok ? '' : ` (expected ${JSON.stringify(want)})`}`);
};
const line = (text, ocr = false) => ({ text, x0: 0, x1: 100, y: 10, h: 10, ...(ocr ? { ocr } : {}) });
const ratio = (text, ocr) => scaleNotes([line(text, ocr)]).map((n) => n.ratio)[0] ?? null;

// In a page's text.
for (const [text, want] of [
  ['SCALE: 1/4" = 1\'-0"', 48],
  ['3/16"=1\'-0"', 64],
  ['1 1/2" = 1\'-0"', 8],
  ['SCALE: 1/4” = 1’-0”', 48],
  ['1" = 20\'-0"', 240],
  ['SCALE 1:100', 100],
  ['Meeting at 1:30', null],
  ['AS NOTED', null],
  ['N.T.S.', 0],
]) check(`text "${text}"`, ratio(text), want);

// Read by OCR.
for (const [text, want] of [
  ['SCALE i/4" = 1-0"', 48],
  ['SCALE: 1/4" = 10"', 48],
  ['SCALE 14"=1-0"', 48],
  ['SCALE: 1/4"= 1-0"', 48],
  ["SCALE 1/4'= 1-0\"", 48],
  ['SCALE: 14"\'=1-0"', 48],
  ['SCALE 1/4"\'=1-0"', 48],
  ['SCALE: 114" = 1\'-0"', 48],
  ['SCALE 1/4 = 1\'-0"', 48],
  ['1/4" = 1\'', 48],
  ['A-101 1/4" = 1\'-0"', 48],
  ['316" = 1-0"', 64],
  ['SCALE: 11/2" = 1\'-0"', 8],
  ['SCALE: 1/4 in. = 1 ft.', 48],
  ['SCALE 1/8 in = 1 foot', 96],
  ['SCALE: 1/8" = 1\'-O"', 96],
  ['SCALE: 3/32" = l\'-0"', 128],
  ['1"=20-0"', 240],
  ['1" = 10\'-0"', 120],
  ['1" = 10-0"', 120],
  ['SCALE 1:1OO', 100],
  ['SCALE: 1/4" = 1\'-6"', null],
  ['5/7" = 1\'-0"', null],
  ['12\'-0"', null],
  ['Verify all dimensions in the field', null],
  ['N.T.S.', 0],
]) check(`OCR "${text}"`, ratio(text, true), want);
check('OCR note written out', ocrScale('SCALE: 14"\'=1-0"'), { text: '1/4" = 1\'-0"', ratio: 48 });

// The note chosen for the plan keeps where it came from.
const box = { x0: 0, y0: 0, x1: 200, y1: 200 };
check('chosen OCR note', chooseScaleNote(scaleNotes([line('SCALE 1/4"\'=1-0"', true)]), box, 1000), { text: '1/4" = 1\'-0"', ratio: 48, ocr: true });
check('chosen text note', chooseScaleNote(scaleNotes([line('SCALE: 1/4" = 1\'-0"')]), box, 1000), { text: '1/4" = 1\'-0"', ratio: 48 });

// Words OCR read join into lines by their boxes: a slash below the line and an = sign inside it.
const word = (str, x0, y0, x1, y1) => ({ str, x0, y0, x1, y1 });
const lines = ocrLines([
  word('1-0"', 118, 1, 150, 22), word('SCALE:', 0, 1, 60, 22), word('=', 100, 10, 112, 16), word('1/4"', 66, -3, 96, 29),
  word('PLAN', 70, 40, 110, 61), word('FLOOR', 0, 40, 60, 61), word('A-101', 400, 1, 460, 22),
]);
check('OCR lines', lines.map((l) => l.text), ['SCALE: 1/4" = 1-0"', 'FLOOR PLAN', 'A-101']);
check('OCR line note', scaleNotes(lines).map((n) => [n.text, n.ratio]), [['1/4" = 1\'-0"', 48]]);

// Tesseract's TSV: words are level 5.
const tsv = [
  '1\t1\t0\t0\t0\t0\t0\t0\t3600\t2400\t-1\t',
  '4\t1\t5\t1\t1\t0\t100\t200\t300\t40\t-1\t',
  '5\t1\t5\t1\t1\t1\t100\t200\t120\t40\t96.5\tSCALE:',
  '5\t1\t5\t1\t1\t2\t230\t200\t60\t40\t62\t1/4"',
  '5\t1\t5\t1\t1\t3\t300\t200\t10\t40\t40\t ',
].join('\n');
check('TSV words', tsvWords(tsv), [
  { str: 'SCALE:', x0: 100, y0: 200, x1: 220, y1: 240, conf: 96.5 },
  { str: '1/4"', x0: 230, y0: 200, x1: 290, y1: 240, conf: 62 },
]);

// A sheet is named by its titles, not by a note that mentions a plan or a list of sheets.
const at = (text, h) => ({ text, x0: 0, x1: 100, y: 10, h });
const notes = ['Exam room casework per the equipment plan.', 'Coordinate heights with the reflected ceiling plan.', 'Verify all dimensions.'].map((t) => at(t, 10));
check('floor plan sheet', pageTitles([...notes, at('FLOOR PLAN', 24), at('SCALE: 1/4" = 1\'-0"', 13)]), 1.6);
check('ceiling plan sheet', pageTitles([...notes, at('REFLECTED CEILING PLAN', 24), at('SCALE: 1/4" = 1\'-0"', 13)]), 0.6);
check('cover sheet', pageTitles([at('COVER SHEET', 24), at('A-101 FLOOR PLAN', 12), at('A-201 REFLECTED CEILING PLAN', 12), at('G-001 COVER SHEET', 12)]), 0.6);
check('titles all one size', pageTitles([at('FLOOR PLAN', 12), at('Verify all dimensions.', 12)]), 1.6);
check('no title', pageTitles([at('Verify all dimensions.', 12)]), 1);

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
