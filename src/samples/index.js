// Sample plans offered on the start screen. build() returns a normalized plan (or a Promise of one).
import { buildLabSuite } from './lab-suite.js';
import { buildMedicalOffice } from './medical-office.js';
import { buildOfficeFloor } from './office-floor.js';
import { buildRetailWarehouse } from './retail-warehouse.js';
import { buildTraceDemo } from './trace-demo.js';

export const SAMPLES = [
  {
    id: 'lab-suite',
    name: 'Lab suite',
    description: 'A 5,000 sq ft wet lab suite with island benches, a fume hood wall, tissue culture, an equipment corridor and a write-up area along the windows.',
    build: buildLabSuite,
  },
  {
    id: 'medical-office',
    name: 'Medical office',
    description: 'A 4,600 sq ft clinic with a waiting room, six exam rooms, a nurse station, CT imaging, treatment bays and staff support space.',
    build: buildMedicalOffice,
  },
  {
    id: 'office-floor',
    name: 'Office floor',
    description: 'A 9,000 sq ft office floor with glass-front private offices, benching and workstation pods, conference rooms, phone booths and a work cafe.',
    build: buildOfficeFloor,
  },
  {
    id: 'retail-warehouse',
    name: 'Retail and warehouse',
    description: 'A 7,000 sq ft corner store with gondola runs, apparel and checkout, backed by a 24 ft clear warehouse with pallet racking and a loading dock.',
    build: buildRetailWarehouse,
  },
  {
    id: 'trace-demo',
    name: 'Trace a floor plan',
    description: 'A 60 by 40 ft office suite drawing at 1/4 in = 1 ft with only the exterior walls traced, so you can practice tracing the partitions, doors and rooms yourself.',
    build: buildTraceDemo,
  },
];
