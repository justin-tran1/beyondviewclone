// Medical office: 92' x 50' (about 4,600 sq ft). Waiting and business office at the west end; exam
// rooms and physician offices along the windows; a corridor loop around a core with the nurse
// station, staff break room, restrooms and CT control; treatment bays and imaging to the south.
import { createLayout } from './helpers.js';

/**
 * Furnish an 11' x 13' exam room. The door sits near the west corner of the corridor wall
 * (`door` is 'n' or 's'); the table runs along the window wall and the privacy curtain hangs
 * open along the wall beside the door.
 */
function examRoom(L, x0, y0, x1, y1, corridorWall, door) {
  const dir = door === 's' ? 1 : -1;
  const back = door === 's' ? y0 + 0.5 : y1 - 0.5;
  const at = (dy) => back + dir * dy;
  L.door(corridorWall, x0 + 2.4, { swing: door === 's' ? 'n' : 's', hinge: 'w' });
  L.item('exam-table', x0 + 5.6, at(2.6), door === 's' ? 0 : 180);
  L.item('exam-casework', x1 - 1.21, at(5.55), 'w');
  L.item('physician-stool', x0 + 7.4, at(6.4));
  L.item('side-chair', x0 + 6.4, at(10.9), door === 's' ? 'n' : 's');
  L.item('privacy-curtain', x0 + 0.6, at(7.2), 90);
}

export function buildMedicalOffice() {
  const L = createLayout({ name: 'Medical office', wallHeight: 9.5, ceiling: 'tile', exterior: 'city' });

  // Shell
  const shell = L.rect(0, 0, 92, 50, 'exterior');
  L.window(shell.n, 12, { width: 8 });
  for (const x of [29.5, 40.5, 51.5, 62.5]) L.window(shell.n, x, { width: 4 });
  L.window(shell.n, 74, { width: 6 });
  L.window(shell.n, 86, { width: 6 });
  L.window(shell.w, 9.5, { width: 6 });
  L.window(shell.w, 29, { width: 6 });
  L.window(shell.w, 40, { width: 6 });
  L.window(shell.e, 6.5, { width: 5 });
  L.window(shell.e, 16, { width: 4 });
  L.window(shell.e, 25, { width: 4 });
  L.door(shell.s, 12, { type: 'double-door', swing: 's' });
  L.window(shell.s, 4.75, { width: 6, height: 7, sill: 1 });
  L.window(shell.s, 19.25, { width: 6, height: 7, sill: 1 });
  for (const x of [29.5, 40.5]) L.window(shell.s, x, { width: 4 });
  for (const x of [51, 57, 63, 69]) L.window(shell.s, x, { width: 4 });

  // Front of house
  const front = L.wall([24, 0], [24, 50]);
  const officeSouth = L.wall([0, 19], [24, 19]);
  L.door(officeSouth, 3, { swing: 'n', hinge: 'w' });
  L.door(front, 16, { swing: 'w', hinge: 'n' });
  L.door(front, 25, { width: 3.5, swing: 'e', hinge: 's' });

  // Clinic walls
  const north = L.wall([24, 13], [92, 13]);
  for (const x of [35, 46, 57, 68, 80]) L.wall([x, 0], [x, 13]);
  const coreNorth = L.wall([30, 19], [86, 19]);
  const coreSouth = L.wall([30, 31], [92, 31]);
  L.wall([30, 19], [30, 31]);
  const controlEast = L.wall([86, 19], [86, 31]);
  const [breakWest] = [42, 58, 65].map((x) => L.wall([x, 19], [x, 31]));
  const ctWest = L.wall([72, 19], [72, 50]);
  const south = L.wall([24, 37], [72, 37]);
  for (const x of [35, 46]) L.wall([x, 37], [x, 50]);

  // Rooms
  L.room('Business office', [0, 0, 24, 19], 'carpet');
  L.room('Waiting', [0, 19, 24, 50], 'vinyl', { ceiling: 'drywall' });
  ['Exam 1', 'Exam 2', 'Exam 3', 'Exam 4'].forEach((name, i) => L.room(name, [24 + 11 * i, 0, 35 + 11 * i, 13], 'rubber'));
  L.room('Physician office', [68, 0, 80, 13], 'carpet');
  L.room('Physician office', [80, 0, 92, 13], 'carpet');
  L.polygonRoom('Corridor', [[24, 13], [92, 13], [92, 31], [86, 31], [86, 19], [24, 19]], 'vinyl');
  L.polygonRoom('Corridor', [[24, 19], [30, 19], [30, 31], [72, 31], [72, 37], [24, 37]], 'vinyl');
  L.room('Nurse station', [30, 19, 42, 31], 'vinyl');
  L.room('Staff break', [42, 19, 58, 31], 'vinyl');
  L.room('Restroom', [58, 19, 65, 31], 'tile', { ceiling: 'drywall' });
  L.room('Restroom', [65, 19, 72, 31], 'tile', { ceiling: 'drywall' });
  L.room('CT control', [72, 19, 86, 31], 'vinyl');
  L.room('Exam 5', [24, 37, 35, 50], 'rubber');
  L.room('Exam 6', [35, 37, 46, 50], 'rubber');
  L.room('Treatment', [46, 37, 72, 50], 'rubber');
  L.room('Imaging', [72, 31, 92, 50], 'rubber');

  // Waiting
  L.item('reception-desk', 12, 23.7, 0, { w: 12 });
  L.against(shell.w, 33, 'waiting-chairs', 'e', { w: 12 });
  L.against(front, 37, 'waiting-chairs', 'w', { w: 12 });
  L.against(shell.s, 4.6, 'waiting-chairs', 'n', { w: 6 });
  L.item('area-rug', 12, 36.5, 90, { w: 9, d: 7 });
  L.item('coffee-table', 12, 36.5, 90);
  L.item('lounge-chair', 8.6, 36.5, 'e');
  L.item('lounge-chair', 15.4, 36.5, 'w');
  L.item('plant', 2, 25);
  L.item('plant', 22.3, 47.9);

  // Business office
  L.alongWall(shell.n, [5, 10.5, 16], 'workstation', 's');
  L.row('workstation', [5, 11.5], [5.5, 0], 3, 's');
  L.alongWall(front, [3, 6.5], 'filing-cabinet', 'w');
  L.against(front, 10.2, 'printer', 'w');
  L.against(officeSouth, 10, 'bookshelf', 'n');
  L.against(officeSouth, 13.5, 'bookshelf', 'n');

  // Exam rooms and physician offices
  for (let i = 0; i < 4; i++) examRoom(L, 24 + 11 * i, 0, 35 + 11 * i, 13, north, 's');
  examRoom(L, 24, 37, 35, 50, south, 'n');
  examRoom(L, 35, 37, 46, 50, south, 'n');
  for (const x0 of [68, 80]) {
    L.door(north, x0 + 2.4, { swing: 'n', hinge: 'w' });
    L.item('executive-desk', x0 + 6.6, 4.4);
    L.row('side-chair', [x0 + 5.4, 8.9], [2.4, 0], 2, 'n');
    L.item('bookshelf', x0 + 0.81, 6.6, 'e');
  }

  // Nurse station
  L.opening(coreNorth, 36, { width: 8 });
  L.item('nurse-station', 36, 23.7, 'n');
  L.against(coreSouth, 32.8, 'tall-storage-cabinet', 'n');
  L.against(coreSouth, 36.4, 'filing-cabinet', 'n');
  L.against(coreSouth, 39.8, 'printer', 'n');
  L.item('supply-cart', 40.4, 26.5, 'w');

  // Staff break
  L.door(coreNorth, 55.5, { swing: 's', hinge: 'e' });
  L.against(breakWest, 25, 'pantry-counter', 'e');
  L.item('round-table-4', 51.5, 25.2);
  L.against(coreSouth, 56.2, 'trash-recycling', 'n');

  // Restrooms
  for (const x0 of [58, 65]) {
    L.door(coreNorth, x0 + 3.5, { swing: 's', hinge: 'e' });
    L.against(coreSouth, x0 + 3.5, 'toilet', 'n');
    L.item('vanity', x0 + 1.13, 24.5, 'e');
  }

  // CT control and imaging
  L.door(controlEast, 22.6, { swing: 'w', hinge: 'n' });
  L.window(coreSouth, 79, { width: 6, height: 3, sill: 3.5 });
  L.against(coreSouth, 79, 'desk', 'n', { w: 8 });
  L.row('task-chair', [77, 27.1], [4, 0], 2, 's');
  L.against(controlEast, 27.6, 'filing-cabinet', 'w');
  L.door(coreSouth, 89, { width: 4, swing: 's', hinge: 'e' });
  L.item('ct-scanner', 82, 40.4);
  L.against(ctWest, 36, 'tall-storage-cabinet', 'e');
  L.against(ctWest, 44, 'supply-cart', 'e');
  L.against(shell.e, 44, 'supply-cart', 'w');

  // Treatment bays
  L.opening(south, 59, { width: 6 });
  for (const x of [50, 56, 62, 68]) L.against(shell.s, x, 'patient-recliner', 'n');
  for (const x of [53, 59, 65]) L.item('privacy-curtain', x, 45.4, 90);
  L.against(south, 49.5, 'desk', 's', { w: 5 });
  L.item('task-chair', 49.5, 40.9, 'n');
  L.against(ctWest, 43, 'supply-cart', 'w');

  L.camera('Waiting', 16.6, 47.4, 320, -3);
  L.camera('Corridor', 25.6, 16, 90, -2);
  L.camera('Exam room', 38.6, 11.2, 28, -12);
  L.camera('Treatment', 70.6, 39.4, 208, -8);
  L.camera('Imaging', 88.2, 47.6, 312, -10);
  L.camera('Nurse station', 41.5, 14.6, 215, -8);

  return L.build();
}
