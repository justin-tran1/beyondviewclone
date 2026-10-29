// Office floor: 120' x 75' (9,000 sq ft). Glass-front private offices along the north windows,
// an open office of benching and workstation pods on a 30' column grid, phone booths and a print
// area, and reception, two conference rooms and a work cafe along the south.
import { createLayout } from './helpers.js';

export function buildOfficeFloor() {
  const L = createLayout({ name: 'Office floor', wallHeight: 9.5, ceiling: 'tile', exterior: 'city' });

  // Shell
  const shell = L.rect(0, 0, 120, 75, 'exterior');
  L.window(shell.n, 7, { width: 8, height: 6, sill: 2.5 });
  L.window(shell.n, 17, { width: 8, height: 6, sill: 2.5 });
  for (let i = 0; i < 8; i++) L.window(shell.n, 30 + 12 * i, { width: 8, height: 6, sill: 2.5 });
  L.window(shell.w, 7.5, { width: 8, height: 6, sill: 2.5 });
  L.window(shell.w, 39.4, { width: 4, height: 6, sill: 2.5 });
  L.window(shell.w, 66, { width: 8, height: 6, sill: 2.5 });
  L.window(shell.e, 7.5, { width: 8, height: 6, sill: 2.5 });
  L.windows(shell.e, 17, 56, { width: 7, height: 6, sill: 2.5, gap: 3 });
  L.windows(shell.e, 58, 74, { width: 7, height: 6, sill: 2.5, gap: 3 });
  L.door(shell.s, 15, { type: 'double-door', swing: 's' });
  L.window(shell.s, 6, { width: 7, height: 7.5, sill: 0.5 });
  L.window(shell.s, 24, { width: 7, height: 7.5, sill: 0.5 });
  L.windows(shell.s, 79, 119, { width: 7, height: 6, sill: 2.5, gap: 3 });

  // Private offices with glass fronts
  const fronts = L.wall([0, 15], [120, 15], 'glass');
  for (const x of [24, 36, 48, 60, 72, 84, 96, 108]) L.wall([x, 0], [x, 15]);
  L.room('Executive office', [0, 0, 24, 15], 'carpet');
  L.door(fronts, 21, { swing: 'n', hinge: 'e' });
  L.item('executive-desk', 7.5, 4.6);
  L.row('side-chair', [6.3, 9.3], [2.4, 0], 2, 'n');
  L.item('round-table-4', 17.6, 7.4);
  L.against(shell.w, 11.6, 'bookshelf', 'e');
  for (let i = 0; i < 8; i++) {
    const x0 = 24 + 12 * i;
    L.room('Office', [x0, 0, x0 + 12, 15], 'carpet');
    L.door(fronts, x0 + 2.2, { swing: 'n', hinge: 'w' });
    L.item('executive-desk', x0 + 6.6, 4.4);
    L.row('side-chair', [x0 + 5.4, 9.2], [2.4, 0], 2, 'n');
    L.item('bookshelf', x0 + 0.8, 5.2, 'e');
    L.item('plant', x0 + 10.4, 13.8);
  }

  // South band: reception, conference rooms and the work cafe
  const southFronts = L.wall([0, 57], [76, 57], 'glass');
  const receptionEast = L.wall([30, 57], [30, 75]);
  const conf10East = L.wall([56, 57], [56, 75]);
  const cafeWest = L.wall([76, 57], [76, 75]);
  L.door(southFronts, 26, { type: 'double-door', swing: 's' });
  L.door(southFronts, 52.5, { swing: 's', hinge: 'e' });
  L.door(southFronts, 72.5, { swing: 's', hinge: 'e' });

  L.room('Open office', [0, 15, 120, 57], 'carpet', { ceiling: 'open' });
  L.room('Reception', [0, 57, 30, 75], 'tile', { ceiling: 'drywall' });
  L.room('Conference', [30, 57, 56, 75], 'carpet', { ceiling: 'drywall' });
  L.room('Conference', [56, 57, 76, 75], 'carpet', { ceiling: 'drywall' });
  L.room('Work cafe', [76, 57, 120, 75], 'vinyl', { ceiling: 'open' });

  // Reception
  L.item('reception-desk', 15, 62.6);
  L.against(shell.w, 68.5, 'sofa', 'e');
  L.item('coffee-table', 5.5, 68.5, 90);
  L.item('lounge-chair', 8.9, 66.6, 'w');
  L.item('lounge-chair', 8.9, 70.4, 'w');
  L.item('plant', 1.8, 58.8);
  L.item('plant', 28.4, 73.2);

  // Conference rooms
  L.against(receptionEast, 65.8, 'tv-display', 'e');
  L.item('conference-table-10', 43.7, 65.8);
  L.against(conf10East, 65.8, 'tv-display', 'e');
  L.item('conference-table-6', 66.7, 65.8);
  L.item('plant', 74.6, 73.4);

  // Work cafe
  L.against(cafeWest, 66, 'pantry-counter', 'e', { w: 14 });
  L.against(shell.s, 81, 'trash-recycling', 'n');
  for (const x of [86, 95]) for (const y of [61.8, 70.6]) L.item('round-table-4', x, y);
  L.item('area-rug', 112.4, 66, 90, { w: 10, d: 8 });
  L.against(shell.e, 66, 'sofa', 'w');
  L.item('coffee-table', 114.4, 66, 90);
  L.item('sofa', 110.6, 66, 'e');
  L.row('planter', [84, 55.9], [12, 0], 3);
  L.item('plant', 118.4, 58.6);

  // Open office: benching to the north of the column line, workstation pods to the south
  for (const x of [30, 60, 90]) L.item('column', x, 36, 0, { h: 12.4 });
  for (const x of [45, 75, 105]) L.item('planter', x, 36);
  for (const x of [36, 46, 61, 71, 86, 96, 111]) L.item('benching-4', x, 25.25);
  for (const x0 of [33.5, 58.5, 83.5, 103]) {
    L.row('workstation', [x0 + 2.5, 44.25], [5, 0], 3, 'n');
    L.row('workstation', [x0 + 2.5, 48.75], [5, 0], 3, 's');
  }

  // Phone booths, print area and a collaboration corner along the west wall
  L.alongWall(shell.w, [22.6, 26.7, 30.8, 34.9], 'phone-booth', 'e');
  L.alongWall(shell.w, [43.2, 46], 'printer', 'e');
  L.against(shell.w, 48.7, 'trash-recycling', 'e');
  L.alongWall(shell.w, [51.6, 54.6], 'filing-cabinet', 'e');
  L.item('round-table-4', 15.5, 26.5);
  L.item('round-table-4', 15.5, 45.5);

  L.camera('Reception', 22.4, 72.4, 318, -2);
  L.camera('Open office', 3.2, 39, 88, -4);
  L.camera('Private office', 49.6, 13.4, 28, -8);
  L.camera('Conference', 53.6, 61.6, 252, -6);
  L.camera('Work cafe', 81.6, 58.6, 118, -4);
  L.camera('Phone booths', 10.8, 31.6, 248, -2);

  return L.build();
}
