// Checks for naming traced rooms from the labels drawn in them (src/room-names.js), for the room
// use their names tell (src/finishes.js namedUse) and for the finish packages those uses set, each
// of which must read back as itself (packageOf matches finishes, so two alike would be taken for
// one another). Usage: node dev/tests/room-names.mjs. Exits 1 on any failure.
import { roomNames, labelKind, titleCase, cleanLabel, splitNumber, ocrLabel } from '../../src/room-names.js';
import { namedUse, PACKAGES, applyPackage, packageOf } from '../../src/finishes.js';

let failed = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: ${JSON.stringify(got)}${ok ? '' : ` (expected ${JSON.stringify(want)})`}`);
};
// A room from x0 to x1 and y0 to y1 (m), and a label at its middle, 0.2 m tall.
const room = (x0, y0, x1, y1) => ({ points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] });
const label = (text, x, y, h = 0.2) => ({ text, x, y, h });
const name = (labels, r = room(0, 0, 6, 4)) => roomNames([r], labels)[0];

for (const [text, want] of [
  ['101', 'number'], ['1203', 'number'], ['B-112', 'number'], ['RM 101', 'number'], ['101A', 'number'],
  ['OFFICE', 'name'], ['BREAK ROOM', 'name'], ['Conf. Rm.', 'name'],
  ['12\'-6"', null], ['150 SF', null], ['9\'-0" AFF', null], ['TYP.', null], ['UP', null], ['FE-1', null], ['3', null], ['W', null],
  ['36"', null], ['200"', null], ['200°', null], ['ll', null], ['Lab', 'name'], ['IT', 'name'],
  ['#4', 'number'], ['#12', 'number'], ['RM #10', 'number'], ['4', null], ['EXAM ROOM #4', 'name'],
  ['VERIFY ALL DIMENSIONS IN THE FIELD BEFORE STARTING', null],
]) check(`kind "${text}"`, labelKind(text), want);

for (const [text, want] of [
  ['RESTROOM 0', 'RESTROOM'], ['OFFICE lL', 'OFFICE'], [': OFFICE', 'OFFICE'], ['© RECEPTION', 'RECEPTION'], ['104.', '104'], ['"106', '106'],
  ['OFFICE |', 'OFFICE'], ['JAN.', 'JAN.'], ['IT', 'IT'], ['Break room', 'Break room'], ['( 5', ''],
]) check(`clean "${text}"`, cleanLabel(text), want);

for (const [text, want] of [
  ['CONFERENCE', 'Conference'], ['BREAK ROOM', 'Break Room'], ['CONF. RM.', 'Conf. Rm.'], ['IT CLOSET', 'IT Closet'],
  ['MRI', 'MRI'], ['X-RAY', 'X-Ray'], ['PRE-OP', 'Pre-Op'], ['STORAGE AND FILES', 'Storage and Files'], ["Women's toilet", "Women's toilet"],
]) check(`title case "${text}"`, titleCase(text), want);

check('a number written with #', splitNumber('EXAM ROOM #4'), { name: 'EXAM ROOM', number: '#4' });
check('name and # number on one line', name([label('EXAM ROOM #4', 3, 2)]), 'Exam Room #4');
check('name over its number', name([label('CONFERENCE', 3, 1.8), label('101', 3, 2.05)]), 'Conference 101');
check('name and number on one line', name([label('OFFICE 102', 3, 2)]), 'Office 102');
check('number after the name', name([label('OFFICE', 2.6, 2), label('102', 3.5, 2)]), 'Office 102');
check('name on two lines over its number', name([label('BREAK', 3, 1.6), label('ROOM', 3, 1.85), label('107', 3, 2.1)]), 'Break Room 107');
check('name alone', name([label('CORRIDOR', 3, 2)]), 'Corridor');
check('OCR scraps around a tag', name([label('RESTROOM 0', 3, 1.8), label('108.', 3, 2.05), label('|', 1, 1)]), 'Restroom 108');
check('number alone', name([label('105', 3, 2)]), 'Room 105');
check('a dimension under a name is not its number', name([label('OFFICE', 3, 1.8), label('36"', 3, 2.05)]), 'Office');
check("OCR's misread dimension is not a room number", name([label('200°', 3, 2)]), null);
check('dimensions and annotations left out', name([label('12\'-0"', 3, 0.4), label('STORAGE', 3, 2), label('TYP.', 1, 3), label('150 SF', 3, 2.3)]), 'Storage');
check('the largest name, not an annotation', name([label('EXAM', 3, 2, 0.25), label('SCALE ROOM', 1, 3.5, 0.12)]), 'Exam');
check('rooms traced as one: every tag, nearest the middle first', name([label('OPEN OFFICE', 4.5, 2.6), label('106', 4.5, 2.85), label('RECEPTION', 1.5, 1), label('105', 1.5, 1.25)]), 'Open Office 106 / Reception 105');
check('labels outside the room left out', name([label('LOBBY', 9, 2)]), null);
check('no labels', name([]), null);
check('a label is the innermost room\'s', roomNames([room(0, 0, 10, 10), room(3, 3, 7, 7)], [label('EXAM', 5, 4.8), label('101', 5, 5.05), label('CORRIDOR', 1, 1)]), ['Corridor', 'Exam 101']);
check('each room its own', roomNames([room(0, 0, 4, 4), room(4, 0, 8, 4)], [label('OFFICE', 2, 1.8), label('102', 2, 2.05), label('OFFICE', 6, 1.8), label('103', 6, 2.05)]), ['Office 102', 'Office 103']);

// OCR's misreadings of room words put right; scraps at the ends left out; known room words told.
for (const [text, want] of [
  ['BRESTROOM {8', { text: 'RESTROOM', known: 'long' }], ['JL RESTROPME', { text: 'RESTROOM', known: 'long' }],
  ['z===3 BREAKRM', { text: 'BREAK RM', known: 'long' }], ['EXAM ROOM#12', { text: 'EXAM ROOM #12', known: 'long' }],
  ['EXAM ROOM =4', { text: 'EXAM ROOM #4', known: 'long' }], ['EXAM ROOM # 5', { text: 'EXAM ROOM #5', known: 'long' }],
  ['PROCEDURERM', { text: 'PROCEDURE RM', known: 'long' }], ['STOR~GE', { text: 'STORAGE', known: 'long' }],
  ['RESTROOMZ', { text: 'RESTROOM', known: 'long' }], ['OFFICESS', { text: 'OFFICES', known: 'long' }],
  ['CONSULT/OFFICE', { text: 'CONSULT/OFFICE', known: 'long' }], ['IT', { text: 'IT', known: 'short' }],
  ['VEST', { text: 'VEST', known: null }], ['HET RECEPTION', { text: 'RECEPTION', known: 'long' }], ['MRI SUITE', { text: 'MRI SUITE', known: 'long' }], ['Na', { text: '', known: null }], ['resTROPME', { text: 'RESTROOM', known: 'long' }],
]) check(`ocr "${text}"`, ocrLabel(text, { caps: true }), want);
check('ocr in mixed case kept as read', ocrLabel('Break room'), { text: 'Break room', known: 'long' });

for (const [n, want] of [
  ['Exam 3', 'exam'], ['Patient Toilet 112', 'restroom'], ['Soiled Utility', 'utility'], ['Cath Lab', 'procedure'], ['Lab Manager', 'office'],
  ['Wet Lab 201', 'wet-lab'], ['Tissue Culture', 'tissue-culture'], ['OR 2', 'surgery'], ['X-Ray', 'imaging'], ['Nurse Station', 'nurse'],
  ['Reception 105', 'waiting'], ['Corridor', 'corridor'], ['Conf. Rm. 104', 'conference'], ['Break Room 107', 'breakroom'], ['Lobby', 'lobby'],
  ['Jan.', 'storage'], ['IT Closet', 'storage'], ['Office Storage', 'storage'], ['Open Office 106', 'office'], ['Restroom 108', 'restroom'],
  ['Room 3', null], ['Room 105', null], ['Workroom 109', null], ['Corridor 1 / Reception 105', 'corridor'],
  ['Break Rm', 'breakroom'], ['Breakrm', 'breakroom'], ['MA Station', 'nurse'], ['Exam Room #4', 'exam'], ['Consult/Office', 'exam'],
]) check(`use of "${n}"`, namedUse(n), want);

for (const key of Object.keys(PACKAGES)) {
  const r = { points: [] };
  applyPackage(r, key);
  check(`package "${key}" reads as itself`, packageOf(r), key);
}

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
