// Procedural lab suite used by the interactive tour and by scripts/render.mjs.
// Units are meters. The room runs x: -7..7, z: -5..5, with a window wall at x = +7.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export const MODES = {
  raw: 'As-is shell',
  whitebox: 'Whitebox',
  lab: 'Lab fit-out',
};

export const VIEWS = {
  entry: { label: 'Entry', pos: [-5.7, 1.62, 4.4], target: [1.8, 1.05, -2.6] },
  aisle: { label: 'Bench aisle', pos: [-1.75, 1.62, 4.55], target: [-1.75, 1.0, -4.2] },
  hoods: { label: 'Fume hoods', pos: [1.75, 1.66, -2.95], target: [-4.8, 1.1, -3.9] },
  writeup: { label: 'Write-up zone', pos: [3.3, 1.62, 4.55], target: [6.4, 1.0, -3.8] },
  corner: { label: 'Overview', pos: [6.2, 2.45, 4.5], target: [-2.2, 0.55, -1.8] },
};

const W = 14;
const D = 10;
const CEIL = 2.9;
const DECK = 3.8;
const UNIT = new THREE.BoxGeometry(1, 1, 1);

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function std(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, envMapIntensity: 0.5, ...opts });
}

function canvasTexture(size, draw, repeat = [1, 1]) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 8;
  return t;
}

function mottled(base, blotches, speckle, seed) {
  return (ctx, s) => {
    const r = rng(seed);
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < blotches.count; i++) {
      const x = r() * s, y = r() * s, rad = s * (0.05 + r() * blotches.size);
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, blotches.colors[i % blotches.colors.length]);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      // Draw wrapped copies so the texture tiles without seams.
      for (const dx of [-s, 0, s]) for (const dy of [-s, 0, s]) {
        ctx.save();
        ctx.translate(dx, dy);
        ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
        ctx.restore();
      }
    }
    for (let i = 0; i < speckle.count; i++) {
      ctx.fillStyle = speckle.colors[i % speckle.colors.length];
      ctx.fillRect(r() * s, r() * s, speckle.size, speckle.size);
    }
  };
}

function block(parent, material, x0, x1, y0, y1, z0, z1, shadows = true) {
  const m = new THREE.Mesh(UNIT, material);
  m.scale.set(x1 - x0, y1 - y0, z1 - z0);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  m.castShadow = m.receiveShadow = shadows;
  parent.add(m);
  return m;
}

function cyl(parent, material, r, h, x, y0, z, { axis = 'y', segments = 24, rTop = r } = {}) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, r, h, segments), material);
  if (axis === 'y') m.position.set(x, y0 + h / 2, z);
  if (axis === 'x') { m.rotation.z = Math.PI / 2; m.position.set(x, y0, z); }
  if (axis === 'z') { m.rotation.x = Math.PI / 2; m.position.set(x, y0, z); }
  m.castShadow = m.receiveShadow = true;
  parent.add(m);
  return m;
}

function makeMaterials() {
  const T = {
    concrete: canvasTexture(512, mottled('#8f8c86',
      { count: 90, size: 0.12, colors: ['rgba(60,58,54,0.12)', 'rgba(170,166,158,0.14)', 'rgba(110,100,90,0.1)'] },
      { count: 2600, size: 2, colors: ['rgba(40,40,40,0.25)', 'rgba(210,205,200,0.25)'] }, 7), [4, 3]),
    polished: canvasTexture(512, mottled('#cdcac3',
      { count: 60, size: 0.14, colors: ['rgba(150,145,138,0.07)', 'rgba(235,232,226,0.12)'] },
      { count: 1400, size: 1.5, colors: ['rgba(120,118,112,0.2)'] }, 11), [3, 2]),
    epoxy: canvasTexture(256, mottled('#d6dbde',
      { count: 20, size: 0.3, colors: ['rgba(255,255,255,0.15)', 'rgba(170,180,186,0.12)'] },
      { count: 2200, size: 1.2, colors: ['rgba(90,100,108,0.35)', 'rgba(255,255,255,0.6)', 'rgba(60,120,150,0.2)'] }, 3), [6, 4]),
    drywall: canvasTexture(512, (ctx, s) => {
      const r = rng(21);
      ctx.fillStyle = '#c9c4ba';
      ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 14; i++) {
        ctx.fillStyle = `rgba(${225 + r() * 15},${222 + r() * 15},${216 + r() * 15},${0.2 + r() * 0.25})`;
        const w = s * (0.04 + r() * 0.18), h = s * (0.02 + r() * 0.3);
        ctx.fillRect(r() * s, r() * s, w, h);
      }
      ctx.strokeStyle = 'rgba(120,112,100,0.35)';
      ctx.lineWidth = 2;
      for (let x = 0; x <= s; x += s / 2) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, s); ctx.stroke(); }
    }, [5, 1.2]),
    ceiling: canvasTexture(256, (ctx, s) => {
      ctx.fillStyle = '#f1f1ee';
      ctx.fillRect(0, 0, s, s);
      const r = rng(5);
      for (let i = 0; i < 900; i++) {
        ctx.fillStyle = 'rgba(160,160,155,0.25)';
        ctx.fillRect(r() * s, r() * s, 1.5, 1.5);
      }
      ctx.fillStyle = '#d9dad8';
      ctx.fillRect(0, 0, s, 5);
      ctx.fillRect(0, 0, 5, s);
    }, [W / 0.6, D / 0.6]),
    skyline: canvasTexture(1024, (ctx, s) => {
      const sky = ctx.createLinearGradient(0, 0, 0, s * 0.62);
      sky.addColorStop(0, '#9fc6e6');
      sky.addColorStop(1, '#eef6fb');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, s, s);
      const r = rng(42);
      for (let layer = 0; layer < 2; layer++) {
        ctx.fillStyle = layer ? '#a9bccb' : '#c4d3de';
        let x = -20;
        while (x < s) {
          const w = 40 + r() * 90, h = s * (0.06 + r() * (layer ? 0.16 : 0.24));
          ctx.fillRect(x, s * 0.62 - h, w, h);
          if (layer) {
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            for (let wy = s * 0.62 - h + 8; wy < s * 0.6; wy += 14) ctx.fillRect(x + 6, wy, w - 12, 4);
            ctx.fillStyle = '#a9bccb';
          }
          x += w + 6 + r() * 30;
        }
      }
      for (let i = 0; i < 60; i++) {
        const x = r() * s, y = s * (0.6 + r() * 0.04), rad = 18 + r() * 34;
        ctx.fillStyle = ['#7f9d78', '#6d8d6a', '#90ab86'][i % 3];
        ctx.beginPath();
        ctx.ellipse(x, y, rad, rad * 0.8, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      const ground = ctx.createLinearGradient(0, s * 0.62, 0, s);
      ground.addColorStop(0, '#b9c2b3');
      ground.addColorStop(1, '#8d9a88');
      ctx.fillStyle = ground;
      ctx.fillRect(0, s * 0.635, s, s);
    }),
  };

  return {
    T,
    floor: std('#ffffff', { map: T.concrete, roughness: 0.92 }),
    wall: std('#f4f4f1', { roughness: 0.9 }),
    column: std('#f4f4f1', { roughness: 0.9 }),
    trim: std('#e2e4e4', { roughness: 0.6 }),
    deck: std('#5f6264', { roughness: 0.95 }),
    rawConcrete: std('#ffffff', { map: T.concrete, roughness: 0.95 }),
    ceiling: std('#ffffff', { map: T.ceiling, roughness: 0.95 }),
    led: std('#ffffff', { emissive: '#fffaf0', emissiveIntensity: 1.6 }),
    ledWarm: std('#ffffff', { emissive: '#fff1d6', emissiveIntensity: 1.3 }),
    mullion: std('#8d9499', { roughness: 0.35, metalness: 0.7 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: '#cfe6ee', transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0, depthWrite: false,
    }),
    frost: new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, roughness: 0.9, depthWrite: false }),
    sky: new THREE.MeshBasicMaterial({ map: T.skyline, toneMapped: false }),
    casework: std('#f5f6f4', { roughness: 0.45 }),
    caseworkBlue: std('#2f6f9a', { roughness: 0.5 }),
    epoxyTop: std('#1f2428', { roughness: 0.32 }),
    steel: std('#c7ccd0', { roughness: 0.28, metalness: 0.85 }),
    darkSteel: std('#5b6268', { roughness: 0.4, metalness: 0.6 }),
    gap: std('#9aa1a5', { roughness: 0.8 }),
    plinth: std('#3e4449', { roughness: 0.8 }),
    screen: std('#0e1418', { roughness: 0.25, emissive: '#1d4e6e', emissiveIntensity: 0.35 }),
    fabric: std('#2c3e4f', { roughness: 0.95 }),
    fabricTeal: std('#2f8f9d', { roughness: 0.95 }),
    wood: std('#b88b5c', { roughness: 0.8 }),
    cardboard: std('#b9895a', { roughness: 0.95 }),
    gypsum: std('#e9e6df', { roughness: 0.95 }),
    stud: std('#a7adb1', { roughness: 0.4, metalness: 0.75 }),
    insulation: std('#e3c27a', { roughness: 1 }),
    orange: std('#e8742c', { roughness: 0.6 }),
    red: std('#b5332b', { roughness: 0.5 }),
    yellow: std('#e9c23a', { roughness: 0.6 }),
    duct: std('#b9bec2', { roughness: 0.32, metalness: 0.9 }),
    accent: std('#4180d8', { roughness: 0.6 }),
    liquidBlue: std('#5aa9d6', { roughness: 0.15, transparent: true, opacity: 0.75 }),
    liquidAmber: std('#c98a2b', { roughness: 0.15, transparent: true, opacity: 0.8 }),
    white: std('#fbfbfa', { roughness: 0.5 }),
  };
}

function buildShell(root, M) {
  const shell = new THREE.Group();
  root.add(shell);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), M.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  shell.add(floor);

  block(shell, M.wall, -7.1, 7.1, 0, DECK, -5.2, -5.0);
  block(shell, M.wall, -7.1, 7.1, 0, DECK, 5.0, 5.2);
  block(shell, M.wall, -7.2, -7.0, 0, DECK, -5, 5);

  // Window wall: sill, header, mullions and glazing.
  block(shell, M.wall, 7.0, 7.25, 0, 0.75, -5, 5);
  block(shell, M.wall, 7.0, 7.25, 2.95, DECK, -5, 5);
  block(shell, M.mullion, 6.96, 7.06, 0.72, 0.78, -5, 5);
  block(shell, M.mullion, 6.96, 7.06, 2.92, 2.98, -5, 5);
  for (let i = 0; i <= 6; i++) {
    const z = -5 + (i * D) / 6;
    block(shell, M.mullion, 6.96, 7.08, 0.75, 2.95, z - 0.035, z + 0.035);
  }
  const glass = block(shell, M.glass, 7.04, 7.05, 0.75, 2.95, -5, 5, false);
  glass.renderOrder = 2;

  const sky = new THREE.Mesh(new THREE.PlaneGeometry(46, 23), M.sky);
  sky.rotation.y = -Math.PI / 2;
  sky.position.set(17, 4.4, 0);
  shell.add(sky);

  return shell;
}

function buildFinishes(root, M) {
  const g = new THREE.Group();
  root.add(g);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, D), M.ceiling);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = CEIL;
  ceiling.receiveShadow = true;
  g.add(ceiling);
  for (const x of [-5.6, -3.5, -1.75, 0, 2.4, 5.6]) {
    for (const z of [-3.3, -0.6, 2.1]) {
      block(g, M.led, x - 0.3, x + 0.3, CEIL - 0.02, CEIL, z - 0.6, z + 0.6, false);
    }
  }
  // Rubber base along the walls gives the whitebox some edge definition.
  block(g, M.plinth, -6.99, 6.99, 0, 0.1, -4.99, -4.98, false);
  block(g, M.plinth, -6.99, 6.99, 0, 0.1, 4.98, 4.99, false);
  block(g, M.plinth, -6.99, -6.98, 0, 0.1, -5, 5, false);
  // Diffusers and a sprinkler head grid read as a real ceiling at a distance.
  for (const x of [-4.6, -1.2, 1.2, 4.0]) {
    for (const z of [-4.2, -1.95, 0.75, 3.6]) {
      block(g, M.trim, x - 0.3, x + 0.3, CEIL - 0.015, CEIL, z - 0.3, z + 0.3, false);
      block(g, M.gap, x - 0.18, x + 0.18, CEIL - 0.02, CEIL - 0.015, z - 0.18, z + 0.18, false);
    }
  }
  return g;
}

function buildRawCeiling(root, M) {
  const g = new THREE.Group();
  root.add(g);
  const deck = new THREE.Mesh(new THREE.PlaneGeometry(W, D), M.deck);
  deck.rotation.x = Math.PI / 2;
  deck.position.y = DECK;
  g.add(deck);
  for (const z of [-3.4, 0, 3.4]) block(g, M.rawConcrete, -7, 7, 3.42, DECK, z - 0.16, z + 0.16);
  cyl(g, M.duct, 0.32, D, -2.2, 3.05, 0, { axis: 'z', segments: 32 });
  cyl(g, M.duct, 0.2, 8, 1.8, 3.15, -1.6, { axis: 'x', segments: 24 });
  cyl(g, M.duct, 0.18, D, 4.6, 3.2, 0, { axis: 'z' });
  cyl(g, M.red, 0.035, W, 0, 3.33, -1.2, { axis: 'x', segments: 10 });
  cyl(g, M.red, 0.035, W, 0, 3.33, 2.4, { axis: 'x', segments: 10 });
  for (const [x, z] of [[-4.8, -2.6], [-0.6, -2.4], [3.2, -2.8], [-4.4, 1.8], [0.4, 2.2], [4.4, 1.6]]) {
    block(g, M.ledWarm, x - 0.7, x + 0.7, 2.95, 3.0, z - 0.06, z + 0.06, false);
    cyl(g, M.darkSteel, 0.008, DECK - 3.0, x - 0.6, 3.0, z, { segments: 6 });
    cyl(g, M.darkSteel, 0.008, DECK - 3.0, x + 0.6, 3.0, z, { segments: 6 });
  }
  return g;
}

function buildRawProps(root, M) {
  const g = new THREE.Group();
  root.add(g);
  // Exposed stud bay on the left wall.
  block(g, M.insulation, -6.99, -6.95, 0, DECK, -2.2, 2.6);
  for (let z = -2.2; z <= 2.61; z += 0.41) block(g, M.stud, -6.95, -6.85, 0, DECK, z - 0.02, z + 0.02);
  block(g, M.stud, -6.95, -6.85, 0, 0.05, -2.2, 2.6);
  // Drywall stack on a pallet.
  block(g, M.wood, -4.6, -3.4, 0, 0.12, -1.8, 0.6);
  block(g, M.gypsum, -4.55, -3.45, 0.12, 0.42, -1.75, 0.55);
  // Cardboard boxes and buckets.
  block(g, M.cardboard, 1.2, 1.8, 0, 0.45, -3.6, -3.0);
  block(g, M.cardboard, 1.3, 1.75, 0.45, 0.8, -3.5, -3.1);
  block(g, M.cardboard, 1.9, 2.5, 0, 0.4, -3.7, -3.15);
  cyl(g, M.white, 0.15, 0.36, -0.8, 0, 1.4, { rTop: 0.17 });
  cyl(g, M.orange, 0.15, 0.36, -0.45, 0, 1.55, { rTop: 0.17 });
  // Traffic cones.
  for (const [x, z] of [[3.6, 0.2], [4.2, 2.8], [-2.4, 3.2]]) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.6, 20), M.orange);
    cone.position.set(x, 0.32, z);
    cone.castShadow = true;
    g.add(cone);
    block(g, M.orange, x - 0.2, x + 0.2, 0, 0.03, z - 0.2, z + 0.2);
  }
  // A-frame ladder.
  const ladder = new THREE.Group();
  ladder.position.set(0.6, 0, -1.2);
  for (const side of [-1, 1]) {
    const leg = new THREE.Group();
    leg.rotation.x = side * 0.18;
    block(leg, M.yellow, -0.3, -0.26, 0, 2.1, -0.02, 0.02);
    block(leg, M.yellow, 0.26, 0.3, 0, 2.1, -0.02, 0.02);
    for (let y = 0.35; y < 2; y += 0.35) block(leg, M.darkSteel, -0.28, 0.28, y, y + 0.03, -0.02, 0.02);
    leg.position.z = -side * 0.2;
    ladder.add(leg);
  }
  g.add(ladder);
  // Patched floor and old fixture outlines.
  block(g, M.deck, 2.8, 4.1, 0, 0.004, -0.6, 0.5, false);
  block(g, M.plinth, -6.2, -5.1, 0, 0.006, -4.4, -3.8, false);
  return g;
}

function stool(g, M, x, z) {
  cyl(g, M.fabric, 0.19, 0.06, x, 0.62, z, { segments: 20 });
  cyl(g, M.steel, 0.025, 0.6, x, 0.02, z, { segments: 10 });
  cyl(g, M.steel, 0.2, 0.02, x, 0.0, z, { segments: 20 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.012, 6, 24), M.steel);
  ring.rotation.x = Math.PI / 2;
  ring.position.set(x, 0.28, z);
  g.add(ring);
}

function chair(g, M, x, z, faceX = 1) {
  cyl(g, M.plinth, 0.26, 0.03, x, 0.02, z, { segments: 5 });
  cyl(g, M.darkSteel, 0.025, 0.42, x, 0.04, z, { segments: 10 });
  block(g, M.fabric, x - 0.25, x + 0.25, 0.46, 0.54, z - 0.25, z + 0.25);
  const bx = x - faceX * 0.24;
  block(g, M.fabric, bx - 0.04, bx + 0.04, 0.6, 1.08, z - 0.23, z + 0.23);
}

function equipment(g, M, kind, x, z, rot = 0) {
  const top = 0.9;
  const e = new THREE.Group();
  e.position.set(x, top, z);
  e.rotation.y = rot;
  g.add(e);
  if (kind === 'microscope') {
    block(e, M.white, -0.12, 0.12, 0, 0.04, -0.16, 0.16);
    block(e, M.white, -0.04, 0.04, 0.04, 0.38, -0.13, -0.05);
    block(e, M.white, -0.06, 0.06, 0.3, 0.4, -0.12, 0.06);
    cyl(e, M.plinth, 0.025, 0.12, 0, 0.36, 0.02, { segments: 12 }).rotation.x = -0.6;
    block(e, M.plinth, -0.08, 0.08, 0.14, 0.16, -0.06, 0.1);
  } else if (kind === 'centrifuge') {
    block(e, M.white, -0.22, 0.22, 0, 0.26, -0.24, 0.24);
    cyl(e, M.darkSteel, 0.17, 0.02, 0, 0.26, 0, { segments: 28 });
    block(e, M.screen, -0.1, 0.1, 0.06, 0.16, 0.24, 0.245);
  } else if (kind === 'incubator') {
    block(e, M.white, -0.3, 0.3, 0, 0.6, -0.28, 0.28);
    block(e, M.glass, -0.25, 0.25, 0.06, 0.54, 0.28, 0.29, false);
    block(e, M.steel, -0.22, 0.22, 0.3, 0.31, -0.24, 0.24);
  } else if (kind === 'monitor') {
    block(e, M.darkSteel, -0.08, 0.08, 0, 0.01, -0.06, 0.06);
    block(e, M.darkSteel, -0.015, 0.015, 0, 0.3, -0.02, 0.0);
    block(e, M.screen, -0.27, 0.27, 0.22, 0.54, 0.0, 0.025);
  } else if (kind === 'bottles') {
    const liquids = [M.liquidBlue, M.liquidAmber, M.liquidBlue, M.glass];
    for (let i = 0; i < 5; i++) {
      const bx = -0.2 + i * 0.1;
      const h = 0.14 + (i % 3) * 0.05;
      cyl(e, liquids[i % liquids.length], 0.035, h * 0.6, bx, 0, 0, { segments: 14 });
      cyl(e, M.glass, 0.036, h, bx, 0, 0, { segments: 14 });
    }
  } else if (kind === 'rack') {
    block(e, M.accent, -0.15, 0.15, 0, 0.05, -0.08, 0.08);
    for (let i = 0; i < 6; i++) cyl(e, M.white, 0.012, 0.1, -0.12 + i * 0.048, 0.05, 0, { segments: 8 });
  }
  return e;
}

function islandBench(g, M, cx, z0, z1) {
  block(g, M.plinth, cx - 0.7, cx + 0.7, 0, 0.1, z0 + 0.04, z1 - 0.04);
  for (const side of [-1, 1]) {
    const xo = cx + side * 0.75;
    const xi = cx + side * 0.04;
    block(g, M.casework, Math.min(xo, xi), Math.max(xo, xi), 0.1, 0.86, z0, z1);
    for (let z = z0 + 0.6; z < z1 - 0.1; z += 0.6) {
      block(g, M.gap, xo - 0.004, xo + 0.004, 0.12, 0.84, z - 0.004, z + 0.004, false);
    }
    for (let z = z0 + 0.3; z < z1; z += 0.6) {
      block(g, M.darkSteel, xo + side * 0.004, xo + side * 0.016, 0.7, 0.72, z - 0.1, z + 0.1, false);
    }
    block(g, M.gap, xo - 0.004, xo + 0.004, 0.62, 0.626, z0 + 0.02, z1 - 0.02, false);
  }
  block(g, M.epoxyTop, cx - 0.79, cx + 0.79, 0.86, 0.9, z0 - 0.03, z1 + 0.03);
  // Service spine with reagent shelving.
  block(g, M.trim, cx - 0.07, cx + 0.07, 0.9, 1.12, z0 + 0.1, z1 - 0.1);
  for (let z = z0 + 0.4; z < z1 - 0.3; z += 0.9) {
    block(g, M.white, cx - 0.072, cx - 0.069, 0.96, 1.04, z - 0.04, z + 0.04, false);
    block(g, M.white, cx + 0.069, cx + 0.072, 0.96, 1.04, z - 0.04, z + 0.04, false);
  }
  const posts = [z0 + 0.15, (z0 + z1) / 2, z1 - 0.15];
  for (const z of posts) block(g, M.steel, cx - 0.025, cx + 0.025, 1.12, 2.05, z - 0.025, z + 0.025);
  for (const y of [1.42, 1.82]) {
    block(g, M.steel, cx - 0.3, cx + 0.3, y, y + 0.02, z0 + 0.12, z1 - 0.12);
  }
  // Sink at the aisle end.
  block(g, M.steel, cx - 0.32, cx + 0.32, 0.895, 0.905, z1 - 0.62, z1 - 0.12, false);
  cyl(g, M.steel, 0.018, 0.32, cx, 0.9, z1 - 0.18, { segments: 12 });
  block(g, M.steel, cx - 0.015, cx + 0.015, 1.2, 1.23, z1 - 0.38, z1 - 0.18, false);
}

function fumeHood(g, M, x0, x1) {
  const zb = -5.0, zf = -4.1;
  block(g, M.plinth, x0 + 0.03, x1 - 0.03, 0, 0.1, zb, zf - 0.03);
  block(g, M.casework, x0, x1, 0.1, 0.86, zb, zf);
  block(g, M.gap, (x0 + x1) / 2 - 0.004, (x0 + x1) / 2 + 0.004, 0.12, 0.84, zf - 0.004, zf + 0.004, false);
  block(g, M.epoxyTop, x0, x1, 0.86, 0.9, zb, zf + 0.02);
  block(g, M.white, x0, x0 + 0.12, 0.9, 2.45, zb, zf);
  block(g, M.white, x1 - 0.12, x1, 0.9, 2.45, zb, zf);
  block(g, M.white, x0, x1, 1.95, 2.45, zb, zf);
  block(g, M.trim, x0 + 0.12, x1 - 0.12, 0.9, 1.95, zb, zb + 0.08);
  block(g, M.glass, x0 + 0.12, x1 - 0.12, 1.18, 1.92, zf - 0.03, zf - 0.02, false);
  block(g, M.steel, x0 + 0.12, x1 - 0.12, 1.15, 1.19, zf - 0.04, zf - 0.01);
  block(g, M.screen, x1 - 0.42, x1 - 0.18, 2.12, 2.24, zf, zf + 0.005, false);
  block(g, M.led, x0 + 0.2, x1 - 0.2, 1.9, 1.92, zb + 0.15, zf - 0.15, false);
  cyl(g, M.duct, 0.14, CEIL - 2.45, (x0 + x1) / 2, 2.45, (zb + zf) / 2, { segments: 20 });
}

function tallCabinets(g, M, x0, x1) {
  const zb = -5.0, zf = -4.42;
  block(g, M.plinth, x0, x1, 0, 0.1, zb, zf - 0.02);
  block(g, M.casework, x0, x1, 0.1, 2.25, zb, zf);
  const doors = Math.round((x1 - x0) / 0.6);
  const dw = (x1 - x0) / doors;
  for (let i = 1; i < doors; i++) {
    const x = x0 + i * dw;
    block(g, M.gap, x - 0.004, x + 0.004, 0.12, 2.23, zf - 0.004, zf + 0.004, false);
  }
  for (let i = 0; i < doors; i++) {
    const x = x0 + (i + 0.5) * dw;
    block(g, M.glass, x - dw / 2 + 0.05, x + dw / 2 - 0.05, 1.3, 2.15, zf, zf + 0.01, false);
    block(g, M.darkSteel, x + (i % 2 ? -1 : 1) * (dw / 2 - 0.08) - 0.01, x + (i % 2 ? -1 : 1) * (dw / 2 - 0.08) + 0.01, 0.95, 1.2, zf, zf + 0.02, false);
  }
  block(g, M.gap, x0, x1, 1.26, 1.27, zf - 0.004, zf + 0.004, false);
}

function buildLab(root, M) {
  const g = new THREE.Group();
  root.add(g);

  for (const [x0, x1] of [[-6.85, -5.25], [-5.15, -3.55], [-3.45, -1.85]]) fumeHood(g, M, x0, x1);
  block(g, M.yellow, -6.85, -1.85, 0, 0.003, -3.98, -3.92, false);
  tallCabinets(g, M, -1.7, 0.7);

  // Biosafety cabinet.
  block(g, M.darkSteel, 1.0, 1.05, 0, 0.75, -4.9, -4.85);
  block(g, M.darkSteel, 2.45, 2.5, 0, 0.75, -4.9, -4.85);
  block(g, M.darkSteel, 1.0, 1.05, 0, 0.75, -4.3, -4.25);
  block(g, M.darkSteel, 2.45, 2.5, 0, 0.75, -4.3, -4.25);
  block(g, M.white, 0.95, 2.55, 0.75, 2.3, -5.0, -4.2);
  block(g, M.trim, 1.05, 2.45, 0.95, 1.65, -4.21, -4.19);
  block(g, M.glass, 1.05, 2.45, 1.05, 1.65, -4.19, -4.18, false);
  block(g, M.accent, 0.95, 2.55, 2.05, 2.12, -4.2, -4.19, false);
  block(g, M.screen, 2.0, 2.35, 1.82, 1.94, -4.2, -4.19, false);
  // Ultra-low freezers.
  for (const [x0, x1] of [[2.75, 3.6], [3.7, 4.5]]) {
    block(g, M.white, x0, x1, 0.06, 1.98, -5.0, -4.12);
    block(g, M.plinth, x0 + 0.02, x1 - 0.02, 0, 0.06, -4.98, -4.14);
    block(g, M.trim, x0, x1, 1.7, 1.98, -4.12, -4.11, false);
    block(g, M.screen, x0 + 0.1, x0 + 0.32, 1.78, 1.9, -4.11, -4.105, false);
    block(g, M.darkSteel, x1 - 0.1, x1 - 0.07, 0.8, 1.45, -4.11, -4.08, false);
  }

  // Two island benches with stools along the central aisle.
  islandBench(g, M, -3.5, -2.7, 2.5);
  islandBench(g, M, 0.0, -2.7, 2.5);
  for (const z of [-1.8, -0.6, 0.6, 1.8]) {
    stool(g, M, -2.48, z);
    stool(g, M, -1.02, z);
    stool(g, M, 1.02, z + 0.3);
    stool(g, M, -4.52, z + 0.3);
  }
  const items = [
    ['microscope', -3.1, -2.1, 0], ['bottles', -3.15, -0.6, 0], ['centrifuge', -3.1, 0.7, Math.PI / 2],
    ['rack', -3.2, 1.6, 0], ['incubator', -3.9, -1.5, -Math.PI / 2], ['monitor', -3.95, 0.4, -Math.PI / 2],
    ['bottles', -3.95, 1.6, Math.PI / 2], ['monitor', -0.4, -1.9, Math.PI / 2], ['microscope', -0.35, -0.2, Math.PI],
    ['rack', -0.35, 0.9, 0], ['centrifuge', 0.4, -1.4, -Math.PI / 2], ['bottles', 0.45, 0.2, Math.PI / 2],
    ['incubator', 0.45, 1.5, Math.PI / 2],
  ];
  for (const [kind, x, z, r] of items) equipment(g, M, kind, x, z, r);
  // Bottles on the reagent shelves.
  for (const cx of [-3.5, 0]) {
    for (const [y, z] of [[1.44, -2.0], [1.44, 0.4], [1.84, -1.0], [1.84, 1.5]]) {
      const e = equipment(g, M, 'bottles', cx, z, Math.PI / 2);
      e.position.y = y;
    }
  }

  // Perimeter bench on the left wall.
  block(g, M.plinth, -6.97, -6.3, 0, 0.1, -3.4, 3.6);
  block(g, M.casework, -7.0, -6.25, 0.1, 0.86, -3.4, 3.6);
  for (let z = -2.8; z < 3.6; z += 0.6) block(g, M.gap, -6.254, -6.246, 0.12, 0.84, z - 0.004, z + 0.004, false);
  block(g, M.epoxyTop, -7.0, -6.2, 0.86, 0.9, -3.42, 3.62);
  block(g, M.casework, -7.0, -6.65, 1.45, 2.15, -3.4, 3.6);
  for (let z = -2.8; z < 3.6; z += 0.6) block(g, M.gap, -6.654, -6.646, 1.47, 2.13, z - 0.004, z + 0.004, false);
  block(g, M.led, -6.7, -6.66, 1.42, 1.44, -3.3, 3.5, false);
  for (const [kind, z] of [['incubator', -2.6], ['centrifuge', -1.2], ['bottles', 0.2], ['monitor', 1.4], ['microscope', 2.7]]) {
    const e = equipment(g, M, kind, -6.55, z, Math.PI / 2);
    e.position.x = -6.55;
  }

  // Glass partition and write-up desks along the windows.
  const px = 4.75;
  const panes = [[-5, -3.4], [-3.4, -1.8], [-1.8, -0.2], [-0.2, 1.4], [1.4, 2.8], [4.0, 5.0]];
  for (const [z0, z1] of panes) {
    const pane = block(g, M.glass, px - 0.006, px + 0.006, 0.05, CEIL - 0.05, z0, z1, false);
    pane.renderOrder = 3;
    const band = block(g, M.frost, px - 0.008, px + 0.008, 1.05, 1.2, z0, z1, false);
    band.renderOrder = 4;
    block(g, M.mullion, px - 0.03, px + 0.03, 0.05, CEIL - 0.05, z0 - 0.02, z0 + 0.02);
  }
  block(g, M.mullion, px - 0.03, px + 0.03, 0.05, CEIL - 0.05, 2.78, 2.82);
  block(g, M.mullion, px - 0.03, px + 0.03, 0.05, CEIL - 0.05, 3.98, 4.02);
  block(g, M.mullion, px - 0.04, px + 0.04, 0, 0.05, -5, 5);
  block(g, M.mullion, px - 0.04, px + 0.04, CEIL - 0.05, CEIL, -5, 5);

  for (const z of [-4.2, -2.6, -1.0, 0.6, 2.2]) {
    block(g, M.white, 5.75, 6.8, 0.72, 0.75, z - 0.7, z + 0.7);
    block(g, M.darkSteel, 5.8, 5.84, 0, 0.72, z - 0.66, z - 0.62);
    block(g, M.darkSteel, 5.8, 5.84, 0, 0.72, z + 0.62, z + 0.66);
    block(g, M.darkSteel, 6.71, 6.75, 0, 0.72, z - 0.66, z - 0.62);
    block(g, M.darkSteel, 6.71, 6.75, 0, 0.72, z + 0.62, z + 0.66);
    block(g, M.fabricTeal, 6.78, 6.8, 0.75, 1.25, z - 0.7, z + 0.7);
    const mon = equipment(g, M, 'monitor', 6.45, z, -Math.PI / 2);
    mon.position.y = 0.75;
    chair(g, M, 5.3, z, -1);
  }

  // Column wrap, lab cart and wall graphics.
  block(g, M.accent, 2.28, 2.92, 0, 0.12, 0.48, 1.12);
  block(g, M.steel, 3.2, 3.95, 0.25, 0.27, 2.0, 2.55);
  block(g, M.steel, 3.2, 3.95, 0.8, 0.82, 2.0, 2.55);
  for (const [x, z] of [[3.22, 2.02], [3.93, 2.02], [3.22, 2.53], [3.93, 2.53]]) block(g, M.steel, x - 0.015, x + 0.015, 0.05, 0.85, z - 0.015, z + 0.015);
  equipment(g, M, 'bottles', 3.6, 2.28, 0).position.y = 0.82;
  block(g, M.accent, -7.0, -6.99, 2.25, 2.4, -3.4, 3.6, false);
  return g;
}

export function createLab({ canvas, preserveDrawingBuffer = false, shadowSize = 2048 } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#e9eef1');
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.05, 80);

  const sun = new THREE.DirectionalLight('#fff1dc', 3.6);
  sun.position.set(19, 11.5, -6.5);
  sun.target.position.set(1, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 9, bottom: -9, near: 1, far: 50 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight('#eef6ff', '#b9b2a6', 0.4));

  const M = makeMaterials();
  const root = new THREE.Group();
  scene.add(root);
  buildShell(root, M);
  const finishes = buildFinishes(root, M);
  const rawCeiling = buildRawCeiling(root, M);
  const rawProps = buildRawProps(root, M);
  const lab = buildLab(root, M);
  const column = block(root, M.column, 2.3, 2.9, 0, DECK, 0.5, 1.1);

  let mode = 'lab';
  function setMode(next) {
    mode = MODES[next] ? next : 'lab';
    const raw = mode === 'raw';
    finishes.visible = !raw;
    rawCeiling.visible = raw;
    rawProps.visible = raw;
    lab.visible = mode === 'lab';
    M.floor.map = raw ? M.T.concrete : mode === 'whitebox' ? M.T.polished : M.T.epoxy;
    M.floor.roughness = raw ? 0.95 : mode === 'whitebox' ? 0.38 : 0.3;
    M.wall.map = raw ? M.T.drywall : null;
    M.wall.color.set(raw ? '#ffffff' : '#f4f4f1');
    M.column.map = raw ? M.T.concrete : null;
    M.column.color.set(raw ? '#ffffff' : '#f4f4f1');
    for (const m of [M.floor, M.wall, M.column]) m.needsUpdate = true;
    renderer.toneMappingExposure = raw ? 0.92 : 1.0;
  }
  setMode(mode);

  function setView(name, fov) {
    const v = VIEWS[name] || VIEWS.entry;
    camera.position.set(...v.pos);
    camera.lookAt(...v.target);
    if (fov) camera.fov = fov;
    camera.updateProjectionMatrix();
    return v;
  }

  function resize(width, height, pixelRatio = Math.min(window.devicePixelRatio || 1, 2)) {
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  return {
    renderer, scene, camera, setMode, setView, resize,
    get mode() { return mode; },
    render: () => renderer.render(scene, camera),
  };
}
