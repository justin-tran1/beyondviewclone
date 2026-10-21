// Retail and warehouse: 100' x 70' (7,000 sq ft). A corner store with glass on the two street
// sides, gondola runs, wall shelving, an apparel area and checkout; a stockroom door leads into a
// 24' clear warehouse with pallet racking, a staging area, a loading dock and a shipping office.
import { createLayout } from './helpers.js';

const STORE_H = 14;
const WAREHOUSE_H = 24;

export function buildRetailWarehouse() {
  const L = createLayout({ name: 'Retail and warehouse', wallHeight: STORE_H, ceiling: 'tile', exterior: 'city' });

  // Shell: the store walls stop at 14', the warehouse walls run up to 24'
  const storeNorth = L.wall([0, 0], [60, 0], 'exterior', { height: STORE_H });
  const whNorth = L.wall([60, 0], [100, 0], 'exterior', { height: WAREHOUSE_H });
  const whEast = L.wall([100, 0], [100, 70], 'exterior', { height: WAREHOUSE_H });
  const whSouth = L.wall([100, 70], [60, 70], 'exterior', { height: WAREHOUSE_H });
  const storeSouth = L.wall([60, 70], [0, 70], 'exterior', { height: STORE_H });
  const storeWest = L.wall([0, 70], [0, 0], 'exterior', { height: STORE_H });
  const demising = L.wall([60, 0], [60, 70], 'interior', { height: WAREHOUSE_H, thickness: 8 / 12 });
  const officeNorth = L.wall([60, 60], [72, 60], 'interior', { height: 10 });
  L.wall([72, 60], [72, 70], 'interior', { height: 10 });

  // Storefront glass, entry and doors
  L.door(storeSouth, 30, { type: 'sliding-door', width: 6, height: 8.5, swing: 'n' });
  L.windows(storeSouth, 2, 26.5, { width: 7, height: 9.5, sill: 0.5, gap: 1 });
  L.windows(storeSouth, 33.5, 58, { width: 7, height: 9.5, sill: 0.5, gap: 1 });
  L.windows(storeWest, 40, 68.5, { width: 8, height: 9.5, sill: 0.5, gap: 1 });
  L.door(demising, 5, { type: 'double-door', swing: 'e', height: 8 });
  L.opening(whSouth, 88, { width: 10, height: 12 });
  L.door(whEast, 64, { swing: 'e', hinge: 's' });
  L.windows(whNorth, 64, 98, { width: 6, height: 3, sill: 16, gap: 3 });
  L.windows(whEast, 4, 45, { width: 6, height: 3, sill: 16, gap: 3 });
  L.door(officeNorth, 69.4, { swing: 's', hinge: 'e' });
  L.window(officeNorth, 64.5, { width: 5, height: 4, sill: 3 });

  L.room('Sales floor', [0, 0, 60, 70], 'tile', { ceiling: 'tile', height: STORE_H });
  L.polygonRoom('Warehouse', [[60, 0], [100, 0], [100, 70], [72, 70], [72, 60], [60, 60]], 'concrete', { ceiling: 'open', height: WAREHOUSE_H });
  L.room('Shipping office', [60, 60, 72, 70], 'vinyl', { ceiling: 'drywall', height: 9 });

  // Perimeter wall shelving and gondola runs
  L.alongWall(storeNorth, [5, 13, 21, 29, 37, 45, 53], 'wall-shelving', 's');
  L.alongWall(storeWest, [8, 16, 24, 32], 'wall-shelving', 'e');
  L.alongWall(demising, [16, 24, 32], 'wall-shelving', 'w');
  for (const x of [11, 20.5, 30, 39.5, 49]) {
    for (const y of [14, 22, 30]) L.item('gondola-shelving', x, y, 90);
  }

  // Apparel by the west windows, window displays, entry tables and checkout
  for (const x of [8, 16]) for (const y of [45, 51, 57]) L.item('clothing-rack', x, y);
  for (const y of [45, 50, 55, 60]) L.item('mannequin', 1.8, y, 'w');
  for (const x of [8, 14, 46, 52]) L.item('mannequin', x, 68.2, 's');
  for (const x of [24.5, 35.5]) for (const y of [46, 55]) L.item('display-table', x, y);
  L.row('gondola-shelving', [45, 46.5], [8, 0], 2);
  L.item('checkout-counter', 45, 58.5, 'n');
  L.item('checkout-counter', 52, 58.5, 'n');
  L.against(demising, 61, 'wall-shelving', 'w', { w: 6 });
  L.item('plant', 24.4, 67.2);
  L.item('plant', 35.6, 67.2);

  // Warehouse racking: rows of three bays with 11' 6" forklift aisles
  const rack = { h: 18 };
  for (const [y, facing] of [[2.25, 's'], [17.25, 'n'], [20.75, 's'], [35.75, 'n'], [39.25, 's']]) {
    for (const x of [76, 85, 94]) L.item('pallet-racking', x, y, facing, rack);
    L.item('bollard', 70.9, facing === 's' ? y + 1.4 : y - 1.4);
  }

  // Staging, dock and shipping office
  L.item('floor-zone', 88, 63, 0, { w: 12, d: 9 });
  L.item('floor-zone', 76.5, 55.5, 0, { w: 10, d: 7 });
  L.row('pallet', [85.2, 63], [5.6, 0], 2);
  L.row('pallet', [74.2, 55.5], [4.6, 0], 2);
  L.item('forklift', 96.4, 47);
  L.against(demising, 54.4, 'workbench', 'e');
  L.row('bollard', [82.4, 68.6], [11.2, 0], 2);
  L.item('bollard', 72.6, 59.3);
  L.item('bollard', 72.6, 62.6);
  L.against(officeNorth, 63.5, 'desk', 's', { w: 5 });
  L.item('task-chair', 63.5, 65.2, 'n');
  L.against(whSouth, 69, 'filing-cabinet', 'n');

  L.camera('Storefront', 30, 66.2, 352, -2);
  L.camera('Gondola aisle', 25.2, 38.6, 4, -2);
  L.camera('Checkout', 39.6, 64.6, 52, -6);
  L.camera('Warehouse aisle', 63.4, 10.2, 96, 6);
  L.camera('Loading dock', 79, 45, 158, -2);

  return L.build();
}
