// Lab suite: 92' x 54' (about 5,000 sq ft). Write-up along the north windows behind a glass
// partition, an open wet lab with three islands and a fume hood wall, tissue culture and glass
// wash rooms, an equipment corridor along the south wall, and offices off a central corridor.
import { createLayout } from './helpers.js';

export function buildLabSuite() {
  const L = createLayout({ name: 'Lab suite', wallHeight: 10, ceiling: 'tile', exterior: 'campus' });

  // Shell and windows
  const shell = L.rect(0, 0, 92, 54, 'exterior');
  L.window(shell.n, 7, { width: 6 });
  L.windows(shell.n, 15.5, 62.5, { width: 6, height: 5.5, sill: 3, gap: 2 });
  L.window(shell.n, 67, { width: 4 });
  L.windows(shell.n, 72, 90, { width: 6, count: 2 });
  L.window(shell.w, 6, { width: 6 });
  L.window(shell.e, 8, { width: 6 });
  L.windows(shell.e, 18, 36, { width: 5, count: 3 });
  L.window(shell.e, 46, { width: 6 });
  L.door(shell.s, 81, { type: 'double-door', swing: 's' });
  L.window(shell.s, 74.25, { width: 5, height: 7, sill: 1 });
  L.window(shell.s, 87.75, { width: 5, height: 7, sill: 1 });
  L.door(shell.s, 67, { swing: 's', hinge: 'w' });

  // Office, write-up and lab partitions
  const officeSouth = L.wall([0, 12], [14, 12]);
  const officeFront = L.wall([14, 0], [14, 12], 'glass');
  const labGlass = L.wall([14, 12], [46, 12], 'glass');
  const tcNorth = L.wall([46, 12], [64, 12]);
  const labEast = L.wall([46, 12], [46, 44]);
  const tcSouth = L.wall([46, 28], [64, 28]);
  const labSouth = L.wall([0, 44], [64, 44]);
  const corrWest = L.wall([64, 0], [64, 54]);
  const corrEast = L.wall([70, 0], [70, 54]);
  const confSouth = L.wall([70, 16], [92, 16]);
  const breakSouth = L.wall([70, 38], [92, 38]);

  L.door(officeFront, 9.5, { swing: 'w', hinge: 's' });
  L.door(labGlass, 40.2, { swing: 's', hinge: 'e' });
  L.door(labEast, 20, { swing: 'e', hinge: 's' });
  L.door(labEast, 37, { swing: 'e', hinge: 's' });
  L.door(labSouth, 18, { type: 'double-door', swing: 'n' });
  L.door(labSouth, 40, { width: 4, swing: 'n', hinge: 'w' });
  L.door(corrWest, 8.5, { swing: 'w', hinge: 'n' });
  L.door(corrWest, 31, { swing: 'w', hinge: 'n' });
  L.door(corrWest, 49, { type: 'double-door', swing: 'w' });
  L.door(corrEast, 12.5, { swing: 'e', hinge: 's' });
  L.opening(corrEast, 27, { width: 6 });
  L.opening(corrEast, 43, { width: 6 });

  // Rooms
  L.room('Lab manager', [0, 0, 14, 12], 'carpet');
  L.room('Write-up', [14, 0, 64, 12], 'carpet');
  L.room('Wet lab', [0, 12, 46, 44], 'epoxy');
  L.room('Tissue culture', [46, 12, 64, 28], 'epoxy');
  L.room('Glass wash', [46, 28, 64, 44], 'epoxy');
  L.room('Equipment corridor', [0, 44, 64, 54], 'epoxy');
  L.room('Corridor', [64, 0, 70, 54], 'vinyl');
  L.room('Conference', [70, 0, 92, 16], 'carpet');
  L.room('Break area', [70, 16, 92, 38], 'vinyl', { ceiling: 'drywall' });
  L.room('Lobby', [70, 38, 92, 54], 'tile', { ceiling: 'drywall' });

  // Lab manager office
  L.against(shell.w, 4.5, 'executive-desk', 'e');
  L.row('side-chair', [8.4, 3.4], [0, 2.2], 2, 'w');
  L.against(officeSouth, 4, 'filing-cabinet', 'n');
  L.against(officeSouth, 7.6, 'bookshelf', 'n');
  L.item('plant', 12.6, 1.9);

  // Write-up: workstations facing the windows
  L.alongWall(shell.n, [18, 23, 28, 33, 38, 43, 48, 53, 58], 'workstation', 's');
  L.against(corrWest, 2.2, 'printer', 'w');
  L.against(corrWest, 4.6, 'trash-recycling', 'w');

  // Wet lab
  L.alongWall(shell.w, [17, 23, 29], 'fume-hood', 'e');
  L.against(shell.w, 35.5, 'tall-storage-cabinet', 'e');
  L.against(shell.w, 40.5, 'lab-sink', 'e');
  for (const x of [12.5, 23.5, 34.5]) {
    L.item('lab-bench-island', x, 25.5, 90, { w: 16 });
    L.row('lab-stool', [x - 3.4, 20.5], [0, 8], 2);
    L.row('lab-stool', [x + 3.4, 24.5], [0, 8], 2);
  }
  L.against(labSouth, 9, 'lab-bench-wall', 'n');
  L.against(labSouth, 27, 'lab-bench-wall', 'n');
  L.against(labSouth, 34.8, 'tall-storage-cabinet', 'n');
  L.item('safety-shower', L.face(labEast, 'w') - 1.5, L.face(labSouth, 'n') - 1.5);
  L.against(labEast, 14.6, 'lab-refrigerator', 'w');
  L.against(labEast, 28, 'lab-bench-wall', 'w');

  // Tissue culture
  L.alongWall(tcNorth, [51, 58.5], 'biosafety-cabinet', 's');
  L.row('lab-stool', [51, 16.6], [7.5, 0], 2);
  L.against(corrWest, 21.5, 'lab-bench-wall', 'w');
  L.against(tcSouth, 50.5, 'lab-sink', 'n');
  L.against(tcSouth, 55.5, 'tall-storage-cabinet', 'n');
  L.against(tcSouth, 59.3, 'lab-refrigerator', 'n');

  // Glass wash
  L.against(tcSouth, 54.5, 'lab-bench-wall', 's');
  L.against(labSouth, 50.5, 'lab-sink', 'n');
  L.alongWall(labSouth, [55.2, 58.7], 'autoclave', 'n');
  L.against(corrWest, 37, 'equipment-cart', 'w');
  L.against(corrWest, 40.4, 'equipment-cart', 'w');

  // Equipment corridor
  L.alongWall(shell.s, [3, 6.5, 10, 13.5, 17, 20.5, 24, 27.5], 'ult-freezer', 'n');
  L.alongWall(shell.s, [31.2, 34.2], 'lab-refrigerator', 'n');
  L.alongWall(shell.s, [38.5, 43], 'tall-storage-cabinet', 'n');
  L.against(shell.s, 48, 'equipment-cart', 'n');
  L.against(shell.s, 51.5, 'equipment-cart', 'n');

  // Conference
  L.against(corrEast, 7, 'tv-display', 'e');
  L.item('conference-table-6', 81.5, 8);
  L.item('plant', 90.2, 14.3);

  // Break area
  L.against(confSouth, 79, 'pantry-counter', 's', { w: 14 });
  L.against(confSouth, 87.6, 'trash-recycling', 's');
  L.item('round-table-4', 76.5, 25.2);
  L.item('round-table-4', 85.5, 25.2);
  L.item('area-rug', 81, 33.6, 0, { w: 9, d: 7 });
  L.against(breakSouth, 81, 'sofa', 'n');
  L.item('coffee-table', 81, 32.3);
  L.item('lounge-chair', 75.6, 32.3, 'e');
  L.item('lounge-chair', 86.4, 32.3, 'w');
  L.item('plant', 90.4, 36.8);

  // Lobby
  L.against(breakSouth, 84, 'tv-display', 's');
  L.item('reception-desk', 84, 43.4);
  L.against(corrEast, 49.8, 'sofa', 'e');
  L.item('coffee-table', 75.6, 49.8, 90);
  L.item('lounge-chair', 89.6, 47.2, 'w');
  L.item('lounge-chair', 89.6, 51, 'w');
  L.item('plant', 90.4, 39.4);

  L.camera('Lobby', 87.4, 52.4, 308, -4);
  L.camera('Write-up', 16.8, 10.4, 72, -5);
  L.camera('Wet lab', 40.2, 15, 225, -8);
  L.camera('Tissue culture', 59.6, 23.2, 312, -6);
  L.camera('Equipment corridor', 59, 48.4, 268, -4);

  return L.build();
}
