// Interior finishes: what a room's floor, walls, wainscot, base, wall protection and ceiling can be,
// the colors offered for each, and finish packages for healthcare, lab and workplace spaces that set
// them all at once. Rooms store their choices (see model.js); kit3d.js and builder3d.js make them in
// 3D and plan-render.js tints the plan by floor.
//
// Colors are [hex, name] with hex the finish's average color. The first color of a finish is the
// finish as made: a room stores no color for it, and any other color as its hex.
import { pointInPolygon } from './geometry.js';

const FT = 0.3048;
const IN = FT / 12;

/**
 * Paint and coating colors: a warm greige (paint as made), soft warm neutrals and calm tints for
 * care spaces, then CBRE accents.
 */
export const WALL_COLORS = [
  ['#d4ccc3', 'Greige'], ['#efece6', 'Warm white'], ['#f2f1ec', 'Bright white'], ['#e5dfd3', 'Linen'],
  ['#cfd6cf', 'Pale sage'], ['#bccdc6', 'Celadon'], ['#c9d4da', 'Mist blue'], ['#a8bcc7', 'Harbor blue'],
  ['#e3d1b6', 'Wheat'], ['#d4b8a2', 'Clay'], ['#80bbad', 'CBRE celadon'], ['#538184', 'CBRE sage'], ['#003f2d', 'CBRE green'],
];
const TILE_COLORS = [['#eceae4', 'White'], ['#d9d4c8', 'Bone'], ['#b9c7c2', 'Sea glass'], ['#9fb3c1', 'Sky'], ['#6e7678', 'Slate']];
const FRP_COLORS = [['#eceae4', 'White'], ['#e2dccb', 'Almond'], ['#c9cbc8', 'Light gray']];
const PANEL_COLORS = [['#e3dfd5', 'Linen'], ['#c9d0cb', 'Sage'], ['#b7c4ce', 'Blue'], ['#a89a86', 'Driftwood'], ['#6a7072', 'Graphite']];
const WOOD_COLORS = [['#b48c60', 'Oak'], ['#c9ab86', 'Maple'], ['#644531', 'Walnut']];
const BASE_COLORS = [['#463d36', 'Espresso'], ['#4b4f4f', 'Charcoal'], ['#2e3133', 'Black'], ['#8c8e8a', 'Pewter'], ['#6b5d4f', 'Brown'], ['#cfc8b8', 'Almond']];

/** Floor finishes, healthcare and lab floors first. color2d tints the plan for the floor as made. */
export const FLOORS = {
  'sheet-vinyl': {
    label: 'Sheet vinyl', group: 'Healthcare and lab', color2d: '#e6e4df',
    colors: [['#cbc6bb', 'Warm gray'], ['#d3c7b1', 'Sand'], ['#c4cbc8', 'Mist'], ['#a9b7a9', 'Sage'], ['#93a5b1', 'Harbor blue'], ['#767a79', 'Graphite']],
  },
  rubber: {
    label: 'Rubber', group: 'Healthcare and lab', color2d: '#dfe7e4',
    colors: [['#b4c0bb', 'Sage gray'], ['#a6a9a8', 'Pewter'], ['#8fa1b0', 'Blue'], ['#c6bca6', 'Sand'], ['#5d6264', 'Charcoal']],
  },
  epoxy: {
    label: 'Epoxy flake', group: 'Healthcare and lab', color2d: '#e6ecee',
    colors: [['#c0c3c3', 'Gray'], ['#c6b9a1', 'Tan'], ['#9eadb9', 'Blue'], ['#a3b5a7', 'Green']],
  },
  resinous: {
    label: 'Seamless resinous', group: 'Healthcare and lab', color2d: '#e7e9e8',
    colors: [['#c5c9c8', 'Light gray'], ['#dddcd6', 'White'], ['#9ea3a3', 'Medium gray'], ['#c7bda9', 'Tan']],
  },
  esd: {
    label: 'Static-control tile', group: 'Healthcare and lab', color2d: '#e3e5e5',
    colors: [['#b9bdbe', 'Gray'], ['#a3adb5', 'Blue gray'], ['#c7bfae', 'Beige']],
  },
  linoleum: {
    label: 'Linoleum', group: 'Healthcare and lab', color2d: '#ece4d4',
    colors: [['#c4b08c', 'Sand'], ['#b3b4ad', 'Pebble'], ['#9ca891', 'Sage'], ['#8fa0a8', 'Blue'], ['#b88b70', 'Terracotta']],
  },
  vinyl: {
    label: 'Luxury vinyl plank', group: 'General', color2d: '#ece4d8',
    colors: [['#8c796b', 'Weathered oak'], ['#a49380', 'Natural oak'], ['#9e9b94', 'Gray oak'], ['#c8bfb1', 'Whitewash'], ['#7b604b', 'Walnut']],
  },
  carpet: {
    label: 'Carpet tile', group: 'General', color2d: '#e3e6e2',
    colors: [['#60676a', 'Charcoal'], ['#4f5b69', 'Navy'], ['#52604f', 'Forest'], ['#7a7262', 'Taupe'], ['#8c908e', 'Gray']],
  },
  tile: {
    label: 'Porcelain tile', group: 'General', color2d: '#ececea',
    colors: [['#c6c2ba', 'Warm gray'], ['#dcdad4', 'White'], ['#77797a', 'Charcoal'], ['#c9bea9', 'Sand']],
  },
  terrazzo: {
    label: 'Terrazzo', group: 'General', color2d: '#eeece8',
    colors: [['#d8d5ce', 'White'], ['#b4b2ad', 'Gray'], ['#d0c3ae', 'Warm']],
  },
  wood: { label: 'Wood', group: 'General', color2d: '#eadcc6', colors: [['#a6845e', 'Oak'], ['#c2a685', 'Maple'], ['#7a5a40', 'Walnut']] },
  'polished-concrete': {
    label: 'Polished concrete', group: 'General', color2d: '#e8e6e1',
    colors: [['#a5a19a', 'Natural'], ['#bdb9b1', 'Light'], ['#74726d', 'Charcoal']],
  },
  concrete: { label: 'Sealed concrete', group: 'General', color2d: '#dcdad5', colors: [['#8f8c86', 'Natural']] },
};

/** Wall finishes. Paint is eggshell; the epoxy coating is a washable semi-gloss for labs and clean spaces. */
export const WALL_FINISHES = {
  paint: { label: 'Paint', colors: WALL_COLORS },
  coating: { label: 'Epoxy coating', colors: WALL_COLORS },
  frp: { label: 'FRP panels', colors: FRP_COLORS },
  tile: { label: 'Ceramic tile', colors: TILE_COLORS },
  wood: { label: 'Wood veneer', colors: WOOD_COLORS },
};

/** A wainscot covers the wall up to `height` (m), with a cap along its top. */
export const WAINSCOTS = {
  none: { label: 'None', height: 0, colors: [] },
  tile: { label: 'Ceramic tile, 4 ft', height: 4 * FT, colors: TILE_COLORS },
  frp: { label: 'FRP, 4 ft', height: 4 * FT, colors: FRP_COLORS },
  panel: { label: 'Impact panel, 4 ft', height: 4 * FT, colors: PANEL_COLORS },
  wood: { label: 'Wood, 3 ft 6 in', height: 3.5 * FT, colors: WOOD_COLORS },
};

/** Wall base. An integral cove is the floor itself turned up the wall, as sheet floors are in care and lab spaces. */
export const BASES = {
  rubber: { label: 'Rubber base, 4 in', height: 4 * IN, colors: BASE_COLORS },
  cove: { label: 'Integral cove, 6 in', height: 6 * IN, colors: [] },
  tile: { label: 'Tile base, 4 in', height: 4 * IN, colors: [] },
  none: { label: 'None', height: 0, colors: [] },
};

/** Wall protection against carts and beds. Rails come with corner guards. */
export const GUARDS = {
  none: { label: 'None' },
  corners: { label: 'Corner guards' },
  rail: { label: 'Crash rail and guards' },
  handrail: { label: 'Handrail and guards' },
};

export const CEILINGS = {
  tile: { label: 'Acoustic tile' },
  clean: { label: 'Washable tile' },
  drywall: { label: 'Drywall' },
  open: { label: 'Open to structure' },
};

/**
 * Casework (cabinet doors and panels) colors for counters, benches and desks: laminates, then wood
 * veneers (`wood` names the kit's veneer). An item stores the hex as its color.
 */
export const CASEWORK_COLORS = [
  ['#ebeae5', 'White'], ['#dcd7cc', 'Almond'], ['#bcbfbd', 'Light gray'], ['#a9b9b0', 'Sage'], ['#9db1bf', 'Blue'],
  ['#5f6668', 'Graphite'], ['#003f2d', 'CBRE green'], ['#c9ab86', 'Maple', 'oak'], ['#b48c60', 'Oak', 'oak'], ['#644531', 'Walnut', 'walnut'],
];

/** Worksurfaces for counters, benches and transaction tops. An item stores the key as its top. */
export const WORKSURFACES = {
  quartz: { label: 'Quartz' },
  'solid-surface': { label: 'Solid surface' },
  epoxy: { label: 'Epoxy resin' },
  phenolic: { label: 'Phenolic resin' },
  stainless: { label: 'Stainless steel' },
  laminate: { label: 'Plastic laminate' },
};

/** A room's finish fields, each with the table of its options and its color field. */
export const FINISH_PARTS = {
  floor: { options: FLOORS, color: 'floorColor', fallback: 'carpet' },
  wall: { options: WALL_FINISHES, color: 'wallColor', fallback: 'paint' },
  wainscot: { options: WAINSCOTS, color: 'wainscotColor', fallback: 'none' },
  base: { options: BASES, color: 'baseColor', fallback: 'rubber' },
  guard: { options: GUARDS, color: null, fallback: 'none' },
  ceiling: { options: CEILINGS, color: null, fallback: 'tile' },
};

/**
 * Finish packages: the finishes a space type usually gets, applied to a room in one step. Fields
 * left out take their default (no color, no wainscot, rubber base, no wall protection). `rooms`
 * names rooms of that use.
 */
export const PACKAGES = {
  exam: { label: 'Exam room', rooms: 'exam rooms', group: 'Healthcare', floor: 'sheet-vinyl', floorColor: '#d3c7b1', wall: 'paint', base: 'cove', ceiling: 'tile' },
  patient: { label: 'Patient room', rooms: 'patient rooms', group: 'Healthcare', floor: 'vinyl', wall: 'paint', wallColor: '#e3d1b6', base: 'rubber', guard: 'rail', ceiling: 'tile' },
  procedure: { label: 'Procedure room', rooms: 'procedure rooms', group: 'Healthcare', floor: 'sheet-vinyl', wall: 'coating', wallColor: '#f2f1ec', base: 'cove', guard: 'corners', ceiling: 'clean' },
  surgery: {
    label: 'Operating room', rooms: 'operating rooms', group: 'Healthcare', floor: 'sheet-vinyl', floorColor: '#93a5b1', wall: 'coating', wallColor: '#cfd6cf',
    base: 'cove', guard: 'rail', ceiling: 'clean',
  },
  imaging: { label: 'Imaging', rooms: 'imaging rooms', group: 'Healthcare', floor: 'sheet-vinyl', floorColor: '#d3c7b1', wall: 'paint', base: 'cove', guard: 'corners', ceiling: 'tile' },
  corridor: { label: 'Corridor', rooms: 'corridors', group: 'Healthcare', floor: 'vinyl', wall: 'paint', base: 'rubber', guard: 'corners', ceiling: 'tile' },
  waiting: { label: 'Waiting and reception', rooms: 'waiting areas', group: 'Healthcare', floor: 'vinyl', wall: 'paint', base: 'rubber', ceiling: 'tile' },
  nurse: { label: 'Nurse station', rooms: 'nurse stations', group: 'Healthcare', floor: 'sheet-vinyl', wall: 'paint', base: 'cove', guard: 'corners', ceiling: 'tile' },
  restroom: { label: 'Restroom', rooms: 'restrooms', group: 'Healthcare', floor: 'tile', wall: 'paint', wainscot: 'tile', base: 'tile', ceiling: 'tile' },
  utility: { label: 'Clean and soiled utility', rooms: 'utility rooms', group: 'Healthcare', floor: 'sheet-vinyl', wall: 'paint', wainscot: 'frp', base: 'cove', guard: 'rail', ceiling: 'clean' },
  'wet-lab': { label: 'Wet lab', rooms: 'wet labs', group: 'Lab', floor: 'epoxy', wall: 'coating', wallColor: '#f2f1ec', base: 'cove', guard: 'corners', ceiling: 'clean' },
  'dry-lab': { label: 'Dry lab', rooms: 'dry labs', group: 'Lab', floor: 'esd', wall: 'paint', base: 'rubber', ceiling: 'tile' },
  'tissue-culture': {
    label: 'Tissue culture (BSL-2)', rooms: 'tissue culture rooms', group: 'Lab', floor: 'sheet-vinyl', floorColor: '#c4cbc8', wall: 'coating', wallColor: '#f2f1ec',
    base: 'cove', guard: 'corners', ceiling: 'clean',
  },
  cleanroom: {
    label: 'Cleanroom', rooms: 'cleanrooms', group: 'Lab', floor: 'resinous', floorColor: '#dddcd6', wall: 'coating', wallColor: '#f2f1ec', base: 'cove', guard: 'corners', ceiling: 'clean',
  },
  vivarium: { label: 'Vivarium', rooms: 'vivarium rooms', group: 'Lab', floor: 'resinous', floorColor: '#c7bda9', wall: 'coating', wallColor: '#e5dfd3', base: 'cove', guard: 'rail', ceiling: 'drywall' },
  'lab-support': { label: 'Glass wash and lab support', rooms: 'lab support rooms', group: 'Lab', floor: 'epoxy', wall: 'frp', base: 'cove', guard: 'rail', ceiling: 'clean' },
  office: { label: 'Office', rooms: 'offices', group: 'Workplace and support', floor: 'carpet', wall: 'paint', base: 'rubber', ceiling: 'tile' },
  conference: { label: 'Conference', rooms: 'conference rooms', group: 'Workplace and support', floor: 'carpet', floorColor: '#7a7262', wall: 'paint', base: 'rubber', ceiling: 'tile' },
  breakroom: { label: 'Break room', rooms: 'break rooms', group: 'Workplace and support', floor: 'tile', floorColor: '#c9bea9', wall: 'paint', base: 'rubber', ceiling: 'tile' },
  lobby: { label: 'Lobby', rooms: 'lobbies', group: 'Workplace and support', floor: 'terrazzo', wall: 'paint', wainscot: 'wood', base: 'tile', ceiling: 'drywall' },
  storage: { label: 'Storage', rooms: 'storage rooms', group: 'Workplace and support', floor: 'concrete', wall: 'paint', base: 'rubber', guard: 'corners', ceiling: 'tile' },
};

const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const sameHex = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase();

/** The default color of a finish (the finish as made), or null when it has none. */
export const defaultColor = (part, key) => FINISH_PARTS[part].options[key]?.colors?.[0]?.[0] ?? null;

/** The color a room's finish shows: its stored color, else the finish as made. */
export function finishColor(room, part) {
  const spec = FINISH_PARTS[part];
  const stored = spec.color ? room[spec.color] : null;
  return isHex(stored) ? stored : defaultColor(part, room[part] ?? spec.fallback);
}

/**
 * Set one finish of a room (in a draft). A color that the new finish does not offer goes, so a
 * celadon paint does not carry over to ceramic tile; `color` (hex, or null for the finish as made)
 * sets it.
 */
export function setFinish(room, part, key, color) {
  const spec = FINISH_PARTS[part];
  if (!Object.prototype.hasOwnProperty.call(spec.options, key)) return;
  room[part] = key;
  if (!spec.color) return;
  const offered = spec.options[key].colors || [];
  const next = color === undefined ? room[spec.color] : color;
  // Paint and coatings take any color; other finishes only their own.
  const keep = isHex(next) && !sameHex(next, offered[0]?.[0])
    && (offered === WALL_COLORS || offered.some(([hex]) => sameHex(hex, next)));
  if (keep && offered.length) room[spec.color] = next;
  else delete room[spec.color];
}

/** Apply a package (key of PACKAGES) to a room in a draft. */
export function applyPackage(room, key) {
  const p = PACKAGES[key];
  if (!p) return;
  for (const [part, spec] of Object.entries(FINISH_PARTS)) setFinish(room, part, p[part] ?? spec.fallback, spec.color ? p[spec.color] ?? null : undefined);
}

/** The package whose finishes the room has, or null. */
export function packageOf(room) {
  for (const [key, p] of Object.entries(PACKAGES)) {
    const same = Object.entries(FINISH_PARTS).every(([part, spec]) => (room[part] ?? spec.fallback) === (p[part] ?? spec.fallback)
      && (!spec.color || sameHex(finishColor(room, part), p[spec.color] ?? defaultColor(part, p[part] ?? spec.fallback))));
    if (same) return key;
  }
  return null;
}

/** Copy every finish (not the ceiling height) from one room to another. */
export function copyFinishes(from, to) {
  for (const [part, spec] of Object.entries(FINISH_PARTS)) setFinish(to, part, from[part] ?? spec.fallback, spec.color ? from[spec.color] ?? null : undefined);
}

/** The plan's fill for a room: its floor's plan color, or a pale tint of the colorway it is in. */
export function planColor(room) {
  const floor = FLOORS[room.floor] || FLOORS.carpet;
  if (!isHex(room.floorColor)) return floor.color2d;
  const v = parseInt(room.floorColor.slice(1), 16);
  const pale = (c) => Math.round(c * 0.3 + 255 * 0.7).toString(16).padStart(2, '0');
  return `#${pale(v >> 16)}${pale((v >> 8) & 255)}${pale(v & 255)}`;
}

// ---- Room use ---------------------------------------------------------------------------------------

/** Item types that tell what a room is used for, strongest first. */
const USE_SIGNS = [
  ['restroom', ['toilet', 'vanity']],
  ['exam', ['exam-table', 'exam-casework', 'physician-stool']],
  ['patient', ['hospital-bed', 'patient-recliner']],
  ['imaging', ['ct-scanner']],
  ['wet-lab', ['lab-bench-island', 'lab-bench-wall', 'fume-hood', 'biosafety-cabinet', 'lab-sink', 'safety-shower']],
  ['lab-support', ['autoclave', 'ult-freezer', 'equipment-cart']],
  ['nurse', ['nurse-station']],
  ['waiting', ['waiting-chairs', 'reception-desk', 'lounge-chair', 'sofa']],
  ['breakroom', ['pantry-counter', 'round-table', 'round-table-4', 'table', 'coffee-table']],
  ['conference', ['conference-table-6', 'conference-table-10']],
  ['office', ['desk', 'executive-desk', 'workstation', 'benching-4', 'task-chair']],
  ['storage', ['filing-cabinet', 'bookshelf', 'tall-storage-cabinet', 'wall-shelving', 'supply-cart']],
];

/**
 * The package a room's use suggests from the items standing in it (by type), or null when nothing
 * in it says: a restroom has a toilet, an exam room its casework or exam table, a lab its benches
 * and hoods. A long, narrow room with nothing in it is a corridor. points: the room outline;
 * types: the item types in it.
 */
export function suggestPackage(points, types) {
  const have = new Set(types);
  const dining = ['table', 'round-table', 'round-table-4', 'pantry-counter'].some((t) => have.has(t));
  // A refrigerator with tables and chairs is a break room's; on its own it is lab equipment.
  if (have.has('lab-refrigerator') && !dining) have.add('ult-freezer');
  // A counter and sink beside tables, with no exam table or stool, is a pantry (traced drawings
  // name every counter with a sink exam casework).
  if (have.has('exam-casework') && dining && !have.has('exam-table') && !have.has('physician-stool')) {
    have.delete('exam-casework');
    have.add('pantry-counter');
  }
  // A table ringed by chairs, with nothing for food, is a conference table.
  const chairs = types.filter((t) => t === 'side-chair' || t === 'task-chair').length;
  if (have.has('table') && chairs >= 5 && !['round-table', 'round-table-4', 'pantry-counter', 'lab-refrigerator'].some((t) => have.has(t))) {
    have.delete('table');
    have.add('conference-table-6');
  }
  for (const [use, signs] of USE_SIGNS) if (signs.some((t) => have.has(t))) return use;
  if (!types.length && corridorLike(points)) return 'corridor';
  return null;
}

// Words in a room's name that tell its use, the most particular first: a patient toilet is a
// restroom, the lab manager's room an office, a cath lab a procedure room, office storage storage.
const USE_NAMES = [
  ['office', /\b(MANAGER|DIRECTOR|SUPERVISOR|COORDINATOR|ADMINISTRATOR|WRITE ?-?UP)\b/],
  ['restroom', /\b(TOILETS?|RESTROOMS?|REST ROOMS?|LAVATORY|LAV|WC|BATH|BATHROOM|SHOWERS?|LOCKERS?|LOCKER ROOM|MENS?|WOMENS?|UNISEX|ALL GENDER|RR)\b/],
  ['utility', /\b(SOILED|SOIL|DIRTY|CLEAN (?:UTIL|UTILITY|SUPPLY|LINEN)|UTILITY|UTIL)\b/],
  ['cleanroom', /\b(CLEAN ?ROOMS?)\b/],
  ['lab-support', /\b(GLASS ?WASH|CAGE ?WASH|AUTOCLAVE|STERILE PROCESSING|COLD ROOM|LAB SUPPORT|DECON|EQUIPMENT (?:CORRIDOR|ROOM))\b/],
  ['tissue-culture', /\b(TISSUE CULTURE|CELL CULTURE|TC LAB|BSL ?-?[1-3]|BIOSAFETY)\b/],
  ['vivarium', /\b(VIVARIUM|ANIMAL)\b/],
  ['surgery', /\b(OPERATING|SURGERY|SURGICAL)\b|^O ?R\b/],
  ['procedure', /\b(PROCEDURES?|PROC|TREATMENT|ENDOSCOPY|ENDO|INFUSION|DIALYSIS|CATH ?LAB|INJECTION)\b/],
  ['dry-lab', /\b(DRY LAB|COMPUTATIONAL|INSTRUMENTATION|ELECTRONICS LAB|MICROSCOPY)\b/],
  ['imaging', /\b(IMAGING|RADIOLOGY|X ?-?RAY|XRAY|CT|MRI|ULTRASOUND|MAMMO|MAMMOGRAPHY|DEXA|FLUORO|FLUOROSCOPY|NUCLEAR MEDICINE)\b/],
  ['exam', /\b(EXAM|EXAMS|EXAMINATION|TRIAGE|CONSULT|CONSULTATION)\b/],
  ['patient', /\b(PATIENT|INPATIENT|RECOVERY|PACU|PRE ?-?OP|POST ?-?OP|ICU|NICU|OBSERVATION|HOLDING|ISOLATION|LDR|POSTPARTUM)\b/],
  ['nurse', /\b(NURSES?|NURSING|NURSE STATION|CHARTING|MEDICATION|MED ROOM|MA STATION|MA STA)\b/],
  ['waiting', /\b(WAITING|WAIT|RECEPTION|CHECK ?-?IN|CHECK ?-?OUT|REGISTRATION|INTAKE)\b/],
  ['corridor', /\b(CORRIDOR|CORR|HALL|HALLWAY|PASSAGE|CIRCULATION)\b/],
  ['wet-lab', /\b(WET LAB|LAB|LABS|LABORATORY|CHEMISTRY|CHEM|BIOLOGY|MICROBIOLOGY|PATHOLOGY|HISTOLOGY)\b/],
  ['conference', /\b(CONFERENCE|CONF|MEETING|BOARD ?ROOM|HUDDLE|TRAINING|CLASSROOM|SEMINAR|TEAM ROOM)\b/],
  ['breakroom', /\b(BREAK|BREAKROOM|BREAKRM|BRK|LOUNGE|KITCHEN|KITCHENETTE|PANTRY|CAFE|CAFETERIA|DINING|LUNCH|COFFEE|VENDING)\b/],
  ['lobby', /\b(LOBBY|VESTIBULE|VEST|ENTRY|ENTRANCE|FOYER|ATRIUM)\b/],
  ['storage', /\b(STORAGE|STOR|STORE|STOREROOM|CLOSET|CLO|JAN|JANITOR|JANITORS|CUSTODIAL|HOUSEKEEPING|EVS|MECH|MECHANICAL|ELEC|ELECTRICAL|IT|IDF|MDF|TELECOM|DATA|SERVER|FILES?|RECORDS|SUPPLY|SUPPLIES|LINEN|ARCHIVE|WAREHOUSE)\b/],
  ['office', /\b(OFFICES?|OFF|OFC|WORKSTATIONS?|STUDY|ADMIN|ADMINISTRATION|MANAGER|DIRECTOR|PHYSICIAN|PROVIDER|DOCTOR|STAFF|BILLING|FOCUS|PHONE ROOM)\b/],
];

/**
 * The package a room's name tells its use by (an exam room, a soiled utility room, a wet lab), or
 * null: "Room 3" or a number says nothing. A name for several rooms traced as one ("Reception 105 /
 * Open Office 106") goes by its first.
 */
export function namedUse(name) {
  const text = (name || '').split(' / ')[0].toUpperCase().replace(/[.'’]/g, '').replace(/[^A-Z0-9 /-]+/g, ' ');
  for (const [use, words] of USE_NAMES) if (words.test(text)) return use;
  return null;
}

/**
 * The package for a room's use (see PACKAGES), or null: the one its name tells (namedUse), else the
 * one the items standing in it in `plan` suggest (suggestPackage).
 */
export function roomUse(plan, room) {
  if (!room.points || room.points.length < 3) return null;
  return namedUse(room.name) ?? suggestPackage(room.points, plan.items.filter((it) => pointInPolygon(it, room.points)).map((it) => it.type));
}

/**
 * In a draft plan, give each of `rooms` the package for its use (roomUse). Rooms whose name and
 * items do not tell their use keep their finishes. Returns how many rooms changed.
 */
export function matchFinishes(draft, rooms = draft.rooms) {
  let changed = 0;
  for (const room of rooms) {
    const key = roomUse(draft, room);
    if (!key || packageOf(room) === key) continue;
    applyPackage(room, key);
    changed++;
  }
  return changed;
}

/** Long and narrow: much longer than it is wide for its area. */
function corridorLike(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, area2 = 0;
  points.forEach((p, i) => {
    const q = points[(i + 1) % points.length];
    area2 += p.x * q.y - q.x * p.y;
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  });
  const long = Math.max(maxX - minX, maxY - minY), area = Math.abs(area2) / 2;
  const width = area / Math.max(long, 1e-6);
  return width < 2.6 && long > 3 * width;
}
