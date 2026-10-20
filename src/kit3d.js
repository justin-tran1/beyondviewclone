// Shared 3D materials, procedural textures and primitive builders. Everything 3D (catalog items,
// the plan builder) goes through one kit so the scene reads as a single, consistent model.
// Item-local axes: x = width, y = up, z = depth with the item's FRONT facing +z.
import * as THREE from 'three';

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function canvasTexture(size, draw, { repeat = 1, srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  return t;
}

/** Soft blotches plus fine speckle; tiles seamlessly. */
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
      for (const dx of [-s, 0, s]) for (const dy of [-s, 0, s]) ctx.fillRect(x - rad + dx, y - rad + dy, rad * 2, rad * 2);
    }
    for (let i = 0; i < speckle.count; i++) {
      ctx.fillStyle = speckle.colors[i % speckle.colors.length];
      ctx.fillRect(r() * s, r() * s, speckle.size, speckle.size);
    }
  };
}

/**
 * Floor textures are authored to a known real-world size (`meters` per tile) so the builder can
 * set UVs in meters: uv = planXY / meters.
 */
const FLOOR_SPECS = {
  carpet: {
    meters: 0.6096,
    roughness: 0.98,
    draw: (ctx, s) => {
      mottled('#6f7a7b', { count: 30, size: 0.2, colors: ['rgba(40,52,55,0.18)', 'rgba(150,160,160,0.14)'] },
        { count: 9000, size: 1.4, colors: ['rgba(30,40,42,0.35)', 'rgba(180,190,188,0.3)', 'rgba(0,63,45,0.18)'] }, 4)(ctx, s);
      ctx.strokeStyle = 'rgba(30,38,40,0.35)';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, s - 2, s - 2);
    },
  },
  'polished-concrete': {
    meters: 3,
    roughness: 0.35,
    draw: mottled('#cdcac3', { count: 60, size: 0.14, colors: ['rgba(150,145,138,0.08)', 'rgba(235,232,226,0.12)'] },
      { count: 1400, size: 1.5, colors: ['rgba(120,118,112,0.2)'] }, 11),
  },
  concrete: {
    meters: 3,
    roughness: 0.95,
    draw: mottled('#8f8c86', { count: 90, size: 0.12, colors: ['rgba(60,58,54,0.12)', 'rgba(170,166,158,0.14)'] },
      { count: 2600, size: 2, colors: ['rgba(40,40,40,0.25)', 'rgba(210,205,200,0.25)'] }, 7),
  },
  epoxy: {
    meters: 2,
    roughness: 0.3,
    draw: mottled('#d6dbde', { count: 20, size: 0.3, colors: ['rgba(255,255,255,0.15)', 'rgba(170,180,186,0.12)'] },
      { count: 2200, size: 1.2, colors: ['rgba(90,100,108,0.35)', 'rgba(255,255,255,0.6)', 'rgba(60,120,150,0.2)'] }, 3),
  },
  vinyl: {
    meters: 1.8288,
    roughness: 0.55,
    draw: (ctx, s) => plankDraw(ctx, s, ['#b89f82', '#c2aa8c', '#ad9476', '#bba385'], 6, 21),
  },
  wood: {
    meters: 1.8288,
    roughness: 0.5,
    draw: (ctx, s) => plankDraw(ctx, s, ['#a7784c', '#b48555', '#9c6f45', '#b07f50'], 6, 9),
  },
  tile: {
    meters: 0.6096,
    roughness: 0.25,
    draw: (ctx, s) => {
      mottled('#e4e2dd', { count: 12, size: 0.3, colors: ['rgba(200,196,188,0.25)'] }, { count: 600, size: 1, colors: ['rgba(150,145,140,0.25)'] }, 15)(ctx, s);
      ctx.fillStyle = '#b9b6b0';
      ctx.fillRect(0, 0, s, 3);
      ctx.fillRect(0, 0, 3, s);
    },
  },
  rubber: {
    meters: 1,
    roughness: 0.8,
    draw: mottled('#c9d6d1', { count: 18, size: 0.25, colors: ['rgba(128,187,173,0.2)'] },
      { count: 3000, size: 1.6, colors: ['rgba(83,129,132,0.35)', 'rgba(255,255,255,0.5)'] }, 5),
  },
};

function plankDraw(ctx, s, tones, rows, seed) {
  const r = rng(seed);
  const h = s / rows;
  for (let i = 0; i < rows; i++) {
    const offset = r() * s;
    for (let k = -1; k < 2; k++) {
      ctx.fillStyle = tones[(i + k + 4) % tones.length];
      ctx.fillRect(offset + k * s * 0.66, i * h, s * 0.66, h);
      for (let g = 0; g < 14; g++) {
        ctx.fillStyle = `rgba(60,35,15,${0.05 + r() * 0.07})`;
        ctx.fillRect(offset + k * s * 0.66, i * h + r() * h, s * 0.66, 1);
      }
      ctx.fillStyle = 'rgba(50,30,15,0.45)';
      ctx.fillRect(offset + k * s * 0.66, i * h, 2, h);
    }
    ctx.fillStyle = 'rgba(50,30,15,0.5)';
    ctx.fillRect(0, i * h, s, 2);
  }
}

/** Material presets used by catalog items. Keys are stable; add new ones rather than renaming. */
const PRESETS = {
  white: ['#fbfbfa', { roughness: 0.5 }],
  casework: ['#f3f4f2', { roughness: 0.45 }],
  laminate: ['#e9e7e1', { roughness: 0.5 }],
  epoxyTop: ['#1f2428', { roughness: 0.32 }],
  quartz: ['#e9e8e4', { roughness: 0.25 }],
  steel: ['#c7ccd0', { roughness: 0.28, metalness: 0.85 }],
  darkSteel: ['#5b6268', { roughness: 0.4, metalness: 0.6 }],
  chrome: ['#e6e9eb', { roughness: 0.12, metalness: 1 }],
  black: ['#22272b', { roughness: 0.5 }],
  plastic: ['#d9dcdc', { roughness: 0.6 }],
  rubber: ['#2b2f31', { roughness: 0.9 }],
  screen: ['#0e1418', { roughness: 0.25, emissive: '#1d4e6e', emissiveIntensity: 0.35 }],
  led: ['#ffffff', { emissive: '#fffaf0', emissiveIntensity: 1.6 }],
  oak: ['#c49a6c', { roughness: 0.55 }],
  walnut: ['#6b4a33', { roughness: 0.5 }],
  fabricCharcoal: ['#3a4144', { roughness: 0.95 }],
  fabricGrey: ['#8a9294', { roughness: 0.95 }],
  fabricGreen: ['#2f5d50', { roughness: 0.95 }],
  fabricSage: ['#538184', { roughness: 0.95 }],
  fabricCeladon: ['#80bbad', { roughness: 0.95 }],
  fabricWheat: ['#cfcb8c', { roughness: 0.95 }],
  vinylBlue: ['#2c4b63', { roughness: 0.6 }],
  leaf: ['#4f7a4a', { roughness: 0.85 }],
  soil: ['#4a3b2c', { roughness: 1 }],
  potWhite: ['#eceae4', { roughness: 0.6 }],
  cardboard: ['#b9895a', { roughness: 0.95 }],
  safetyOrange: ['#e8742c', { roughness: 0.6 }],
  safetyYellow: ['#e9c23a', { roughness: 0.6 }],
  rackBlue: ['#2f5f8f', { roughness: 0.5, metalness: 0.3 }],
  pallet: ['#c8a777', { roughness: 0.9 }],
  concrete: ['#a9a6a0', { roughness: 0.9 }],
  cbreGreen: ['#003f2d', { roughness: 0.6 }],
  accentGreen: ['#17e88f', { roughness: 0.5 }],
};

export function createKit() {
  const cache = new Map();
  const textures = new Map();

  /** A cached MeshStandardMaterial. Same arguments return the same material instance. */
  function material(color, opts = {}) {
    const key = `${color}|${JSON.stringify(opts)}`;
    let m = cache.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, envMapIntensity: 0.5, ...opts });
      cache.set(key, m);
    }
    return m;
  }

  const mat = new Proxy({}, {
    get(_, name) {
      const p = PRESETS[name];
      if (!p) throw new Error(`Unknown kit material "${String(name)}"`);
      return material(p[0], p[1]);
    },
  });

  const glass = new THREE.MeshPhysicalMaterial({
    color: '#cfe6ee', transparent: true, opacity: 0.18, roughness: 0.05, metalness: 0, depthWrite: false, envMapIntensity: 0.8,
  });
  const frostedGlass = new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, roughness: 0.9, depthWrite: false });

  function texture(key, spec) {
    let t = textures.get(key);
    if (!t) {
      t = canvasTexture(512, spec.draw);
      textures.set(key, t);
    }
    return t;
  }

  /** Floor material for a FLOORS key. Its map assumes UVs in plan meters / spec.meters. */
  function floorMaterial(key) {
    const spec = FLOOR_SPECS[key] || FLOOR_SPECS.carpet;
    const cacheKey = `floor:${key}`;
    let m = cache.get(cacheKey);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: '#ffffff', map: texture(key, spec), roughness: spec.roughness, envMapIntensity: 0.5 });
      m.userData.meters = spec.meters;
      cache.set(cacheKey, m);
    }
    return m;
  }

  const floorMeters = (key) => (FLOOR_SPECS[key] || FLOOR_SPECS.carpet).meters;

  /** Box from extents (meters, item-local). Shadows on by default. */
  function block(parent, material, x0, x1, y0, y1, z0, z1, shadows = true) {
    const m = new THREE.Mesh(UNIT_BOX, material);
    m.scale.set(Math.max(1e-4, x1 - x0), Math.max(1e-4, y1 - y0), Math.max(1e-4, z1 - z0));
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    m.castShadow = m.receiveShadow = shadows;
    parent.add(m);
    return m;
  }

  /** Cylinder standing on y0 (axis 'y'), or lying centered at (x, y0, z) along 'x' or 'z'. */
  function cyl(parent, material, r, h, x, y0, z, { axis = 'y', segments = 20, rTop = r } = {}) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, r, h, segments), material);
    if (axis === 'y') m.position.set(x, y0 + h / 2, z);
    if (axis === 'x') { m.rotation.z = Math.PI / 2; m.position.set(x, y0, z); }
    if (axis === 'z') { m.rotation.x = Math.PI / 2; m.position.set(x, y0, z); }
    m.castShadow = m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  function sphere(parent, material, r, x, y, z, { segments = 16, scaleY = 1 } = {}) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, segments, Math.max(8, segments / 2)), material);
    m.position.set(x, y, z);
    m.scale.y = scaleY;
    m.castShadow = m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  function torus(parent, material, r, tube, x, y, z, { axis = 'y' } = {}) {
    const m = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 8, 28), material);
    if (axis === 'y') m.rotation.x = Math.PI / 2;
    if (axis === 'x') m.rotation.y = Math.PI / 2;
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }

  return {
    THREE,
    material,
    mat,
    glass,
    frostedGlass,
    floorMaterial,
    floorMeters,
    canvasTexture,
    block,
    cyl,
    sphere,
    torus,
    group: () => new THREE.Group(),
  };
}

/** Dispose geometries (except the shared unit box) and per-object textures under obj. */
export function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry && o.geometry !== UNIT_BOX) o.geometry.dispose();
  });
}
