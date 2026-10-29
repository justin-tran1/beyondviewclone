// Photo renderer: a ray-traced still of a walkthrough view, for client decks. three-gpu-pathtracer
// runs on its own WebGL context, so the walkthrough keeps running. The view gets daylight from a sky
// that matches the real-time one plus a sun, and its light fixtures become area lights. The
// accumulated image is denoised (an edge-aware a-trous filter guided by depth, normals and albedo),
// given a subtle bloom and tone mapped with the walkthrough's grade and AgX curve at its exposure.
//
// renderPhoto({ scene, camera, width, height, samples, onProgress, signal, exposure, meter, bounces })
//   -> Promise<Blob> (PNG)
//   scene, camera   what to draw (walk.renderContext); neither is changed. Objects flagged
//                   userData.overlay are left out, with everything under them
//   exposure        the live view's toneMappingExposure (default PHOTO_EXPOSURE)
//   meter           the live view's median scene-linear luminance (walk.meterView()); from
//                   METER_SAMPLES on, and again for each preview and the final image, the photo
//                   is exposed so its median matches. Without it, photos are exposed PHOTO_GAIN
//                   above the live exposure
//   onProgress(done, total, { phase, preview, stats })   phase 'prepare' | 'compile' | 'render' |
//                   'finish'; preview is a canvas with the image so far, when one was just drawn;
//                   stats (scene and light counts) comes with 'finish'
//   signal          AbortSignal; aborting rejects with an AbortError
import * as THREE from 'three';
import { WebGLPathTracer, ProceduralEquirectTexture, ShapedAreaLight } from 'three-gpu-pathtracer';
import { MeshBVH } from 'three-mesh-bvh';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import * as postfx from './postfx.js';

// three-gpu-pathtracer 0.0.23 reads these r162+ Scene properties, including on its own internal scene.
for (const key of ['backgroundRotation', 'environmentRotation']) {
  if (!(key in THREE.Scene.prototype)) {
    Object.defineProperty(THREE.Scene.prototype, key, {
      configurable: true,
      get() { return (this[`_${key}`] ??= new THREE.Euler()); },
      set(v) { this[`_${key}`] = v; },
    });
  }
}

/** Same as the walkthrough (src/walkthrough.js), so photos and the live view agree in brightness. */
export const PHOTO_EXPOSURE = 0.75;
// Path traced light reaches walls and ceilings only by real bounces, while the live view adds a fill
// from its light map and environment. Over ten lab, medical and office views (dev/photo-test.html,
// same camera, median display luminance, fixtures at FIXTURE_RADIANCE) photos at the live exposure
// came out 1.2 stops darker in the median, 0.6 to 1.4 outside the open office floor, so they are
// exposed up by that much. The open office's views stay 0.7 to 1.5 stops darker than the live
// view (its dark open deck, and more fixtures than become lights).
const PHOTO_GAIN = 2 ** 1.2;
// So each photo is metered instead: from this many samples on, and again for each preview and the
// final image, the median luminance of its denoised image is set to the live view's (the same
// exposure semantics, so the display medians match), less METER_BIAS stops, within METER_RANGE
// stops of the live exposure. The bias was fitted against the Realistic live view, whose ambient
// occlusion comes after the scene pass the meter reads. Previews wait for the first meter.
const METER_SAMPLES = 4;
const METER_BIAS = 0.25;
const METER_RANGE = [-1, 3.5];

// Light levels are scene-linear radiance (or irradiance for the sun), before exposure. The sky is the
// real-time dome's colors times SKY.scale, so windows read brighter than the room, as in a photo
// exposed for the interior; the fallback colors are for scenes without the dome.
const SKY = { scale: 5.2, horizon: '#e8eff2', zenith: '#8ab7da' };
const SUN_IRRADIANCE = 7.8;
// Fitted with PHOTO_GAIN so rooms lit by their fixtures match the live view as well as daylit rooms
// do; at half this, fixture-lit rooms came out about half a stop darker than daylit ones.
const FIXTURE_RADIANCE = 20; // a lay-in LED panel; smaller fixtures are brighter for the same output
const FIXTURE_MIN = 0.6; // emission (radiance) from which a surface counts as a light fixture
const FIXTURE_AREA = 0.3; // m2, the panel size FIXTURE_RADIANCE is set for
const MAX_FIXTURE_LIGHTS = 24;
const FIXTURE_ENTRIES = 28; // light slots shared out among the fixtures by how much they matter
const MAX_SOURCE_LIGHTS = 12; // the scene's own point, spot and area lights nearest the camera
const LIGHT_REACH = 30; // m from the camera within which fixtures may become lights
const SUN_SHARE = 0.25; // share of light samples the sun gets when it reaches the view
const BLOOM = { strength: 0.16, radius: 0.45, threshold: 3, knee: 2 }; // as postfx.js
const VIGNETTE = 0.035; // matches the live view's 5 percent, which applies before its contrast
const TILE_PIXELS = 400000; // pixels per path tracing draw, so one draw never stalls the GPU for long
const EMISSIVE_CLASS = 0.5; // emission above this keeps the denoiser off a surface
// Sub-pixel offsets for the albedo guide (a stratified 4 x 4 grid), so textures in it are averaged
// over the pixel like the path traced samples; with fewer, fine texture comes back as speckle.
const JITTER = Array.from({ length: 16 }, (_, i) => [((i % 4) + 0.5) / 4 - 0.5, (Math.floor(i / 4) + 0.5) / 4 - 0.5]);
const PT_MAPS = new Set([
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap', 'transmissionMap',
  'clearcoatMap', 'clearcoatRoughnessMap', 'clearcoatNormalMap', 'sheenColorMap', 'sheenRoughnessMap',
  'iridescenceMap', 'iridescenceThicknessMap', 'specularColorMap', 'specularIntensityMap',
]);
// three-gpu-pathtracer's material record: 45 RGBA texels per material (MATERIAL_PIXELS).
const MATERIAL_TEXELS = 45;

export class PhotoError extends Error {
  constructor(message, code = 'failed') {
    super(message);
    this.name = 'PhotoError';
    this.code = code;
  }
}

let support = null;

/** { ok, reason }: whether this browser can render photos (WebGL 2 with float render targets). */
export function photoSupport() {
  if (support) return support;
  let gl = null;
  try {
    gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) {
      support = { ok: false, reason: 'Rendering photos needs WebGL 2, which this browser does not offer. Try a current version of Chrome, Edge, Firefox or Safari with hardware acceleration turned on.' };
    } else if (!gl.getExtension('EXT_color_buffer_float')) {
      support = { ok: false, reason: 'Rendering photos needs a graphics card that can draw floating point images, and this one cannot. The live 3D view and Save image still work.' };
    } else {
      support = { ok: true, reason: '' };
    }
  } catch {
    support = { ok: false, reason: 'Rendering photos is not available in this browser.' };
  } finally {
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }
  return support;
}

const abortError = () => new DOMException('The photo was cancelled.', 'AbortError');
const clampInt = (v, lo, hi, fallback) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : fallback);

/** Settles like promise, or rejects with an AbortError as soon as signal aborts. */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => reject(abortError());
    if (signal.aborted) {
      stop();
      return;
    }
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

// Answers each message a few milliseconds later. Timers in a worker keep running in a hidden page,
// where the page's own timers fire about once a second at most.
const TICKER = 'onmessage = () => setTimeout(() => postMessage(0), 4);';
let tickerUrl = null;

/**
 * The photo's pace. frame() waits for the next display frame while the page is visible; a hidden
 * page (another tab in front, a minimized or covered window) gets no frames at all, so a pending
 * frame also ends when the page is hidden and from then on frame() is a tick. tick() waits a few
 * milliseconds on a worker's timer, or without a worker for a message event, which browsers do not
 * throttle either; the setup yields with it, as it only has to let the page handle input.
 */
function createClock(trash) {
  const waiting = [];
  const wake = () => waiting.shift()?.();
  const channel = new MessageChannel();
  channel.port1.onmessage = wake;
  let worker = null;
  try {
    tickerUrl ??= URL.createObjectURL(new Blob([TICKER], { type: 'text/javascript' }));
    worker = new Worker(tickerUrl);
    worker.onmessage = wake;
    worker.onerror = (e) => {
      // Blocked by the page's security policy, say: answer what it was asked on the channel.
      e.preventDefault();
      worker = null;
      for (let i = 0; i < waiting.length; i++) channel.port2.postMessage(0);
    };
  } catch {
    worker = null;
  }
  trash.push(() => {
    worker?.terminate();
    channel.port1.close();
  });
  const tick = () => new Promise((resolve) => {
    waiting.push(resolve);
    (worker || channel.port2).postMessage(0);
  });
  const frame = () => (document.hidden ? tick() : new Promise((resolve) => {
    const done = () => {
      cancelAnimationFrame(id);
      document.removeEventListener('visibilitychange', done);
      resolve();
    };
    const id = requestAnimationFrame(done);
    document.addEventListener('visibilitychange', done);
  }));
  return { frame, tick };
}

/** Ray-traced PNG of camera's view of scene. See the top of this file. */
export async function renderPhoto({
  scene, camera, width = 1280, height = 720, samples = 256, onProgress = null, signal = null,
  exposure = PHOTO_EXPOSURE, meter = null, bounces = null,
} = {}) {
  if (!scene?.isObject3D || !camera?.isPerspectiveCamera) throw new TypeError('renderPhoto needs a scene and a perspective camera.');
  const check = photoSupport();
  if (!check.ok) throw new PhotoError(check.reason, 'unsupported');
  if (signal?.aborted) throw abortError();
  const liveExposure = Number.isFinite(exposure) && exposure > 0 ? exposure : PHOTO_EXPOSURE;
  const job = {
    source: scene,
    sourceCamera: camera,
    width: clampInt(width, 16, 8192, 1280),
    height: clampInt(height, 16, 8192, 720),
    samples: clampInt(samples, 1, 65536, 256),
    liveExposure,
    exposure: liveExposure * PHOTO_GAIN,
    meter: Number.isFinite(meter) && meter > 0 ? meter : null,
    bounces: clampInt(bounces ?? (samples > 256 ? 8 : 6), 2, 16, 6),
    onProgress,
    signal,
  };
  const trash = [];
  try {
    return await run(job, trash);
  } finally {
    const release = () => {
      for (let i = trash.length - 1; i >= 0; i--) {
        try {
          trash[i]();
        } catch (err) {
          console.warn('Photo cleanup step failed', err);
        }
      }
    };
    if (job.settle) job.settle(release);
    else release();
  }
}

async function run(job, trash) {
  const { width, height, samples, signal } = job;
  const report = (done, phase, preview = null, stats = null) => job.onProgress?.(done, samples, { phase, preview, stats });
  let lost = false;
  let gl = null;
  const aborted = () => {
    if (signal?.aborted) throw abortError();
    // The lost event can arrive after a finished frame, so ask the context too.
    if (lost || gl?.isContextLost()) {
      throw new PhotoError('The graphics card stopped the photo, which can happen when it runs short of memory. Try a smaller size.', 'context-lost');
    }
  };

  // The setup yields to the page between its steps, so the dialog stays live and Cancel takes
  // effect at once (the BVH, the longest step, builds in a worker).
  const clock = createClock(trash);
  report(0, 'prepare');
  await clock.tick();
  aborted();

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const onLost = (e) => {
    e.preventDefault();
    lost = true;
  };
  canvas.addEventListener('webglcontextlost', onLost);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  trash.push(() => {
    canvas.removeEventListener('webglcontextlost', onLost);
    renderer.dispose();
    renderer.forceContextLoss();
  });
  gl = renderer.getContext();
  // The photo's GL objects are released only once the GPU has caught up and three has finished
  // compiling. Releasing them earlier waits for whatever the GPU is still doing (a shader compile
  // can take many seconds), which would freeze the page just as a cancel should show, and three's
  // compileAsync, which polls each program it starts until it is ready, throws once it is disposed.
  const compiles = new Set();
  const compileAsync = renderer.compileAsync.bind(renderer);
  renderer.compileAsync = (...args) => {
    const p = compileAsync(...args);
    compiles.add(p);
    p.then(() => compiles.delete(p));
    return p;
  };
  job.settle = (release) => {
    let pending = true;
    const once = () => {
      if (!pending) return;
      pending = false;
      release();
    };
    // A lost context never finishes compiling.
    if (lost || gl.isContextLost()) {
      once();
      return;
    }
    canvas.addEventListener('webglcontextlost', once, { once: true });
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    (async () => {
      while (pending && fence && gl.clientWaitSync(fence, 0, 0) === gl.TIMEOUT_EXPIRED) await clock.tick();
      if (fence) gl.deleteSync(fence);
      await Promise.all(compiles);
      once();
    })();
  };
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMappingExposure = job.exposure;
  // The walkthrough's grade and AgX curve when postfx.js offers them, else plain AgX.
  if (typeof postfx.useGradedToneMapping === 'function') postfx.useGradedToneMapping(renderer);
  else renderer.toneMapping = THREE.AgXToneMapping;

  const camera = photoCamera(job.sourceCamera, width, height);
  const photo = photoScene(job.source, trash);
  if (!photo.meshes) throw new PhotoError('There is nothing in this view to render.', 'empty');
  await clock.tick();
  aborted();

  const pt = new WebGLPathTracer(renderer);
  trash.push(() => disposePathTracer(pt));
  const patched = patchEmission(pt);
  if (!patched) for (const m of photo.fixtureMaterials) unflagFixture(m);
  patchShadows(pt);
  // One recompile for both patches: each one compiles the whole path tracing shader.
  if (pt._pathTracer?.material) pt._pathTracer.material.needsUpdate = true;
  Object.assign(pt, { renderDelay: 0, fadeDuration: 0, minSamples: 0, dynamicLowRes: false, rasterizeScene: false, renderToCanvas: false });
  pt.bounces = job.bounces;
  pt.transmissiveBounces = 8;
  pt.filterGlossyFactor = 0.5;
  const tiles = tileGrid(width, height);
  pt.tiles.set(tiles.x, tiles.y);
  presize(pt, renderer, width, height);

  const setupStart = performance.now();
  const builder = await bvhBuilder(trash, signal);
  aborted();
  let result;
  if (builder) {
    pt.setBVHWorker(builder);
    result = await untilAborted(pt.setSceneAsync(photo.scene, camera), signal);
  } else {
    result = pt.setScene(photo.scene, camera);
  }
  aborted();
  await clock.tick();
  aborted();
  const lighting = addLights(pt, photo, result, camera, patched, trash);
  if (lighting.materialsChanged) pt.updateMaterials();
  pt.updateLights();
  await clock.tick();
  aborted();

  const post = createPost(renderer, pt, result.geometry, camera, width, height, job.exposure);
  trash.push(() => post.dispose());
  post.renderGuides();
  aborted();
  const stats = {
    triangles: Math.round((result.geometry.index ? result.geometry.index.count : result.geometry.attributes.position.count) / 3),
    materials: result.materials.length,
    lights: photo.scene.children.filter((o) => o.isLight).length,
    ...lighting,
    tiles: tiles.x * tiles.y,
    setupMs: Math.round(performance.now() - setupStart),
  };

  // Accumulate with one batch of draws in flight: a fence says when the GPU has finished it, which
  // paces batches to what the GPU can do (an offscreen canvas gets no backpressure from the screen)
  // and keeps cancelling quick. One full sample is ready whenever pt.samples reaches a whole number.
  let fence = null;
  trash.push(() => {
    if (fence) gl.deleteSync(fence);
  });
  const settled = () => {
    if (!fence) return true;
    if (gl.clientWaitSync(fence, 0, 0) === gl.TIMEOUT_EXPIRED) return false;
    gl.deleteSync(fence);
    fence = null;
    return true;
  };
  const maxCalls = tiles.x * tiles.y * 8;
  let queued = 0; // samples issued to the GPU
  let finished = 0; // samples the GPU has completed
  let calls = 1;
  let issuedAt = 0;
  let lastPreview = 0;
  let started = false;
  // With a meter, the exposure is set from METER_SAMPLES on and again for each preview and for the
  // final image: the denoised image keeps brightening a little as samples add up, and an early
  // few-sample estimate varies by about a third of a stop from run to run.
  let meteredAt = 0;
  const meter = (n) => {
    meteredAt = n;
    const median = post.meter(n);
    if (!median) return;
    const stops = THREE.MathUtils.clamp(Math.log2(job.meter / median) - METER_BIAS, METER_RANGE[0], METER_RANGE[1]);
    post.setExposure(job.liveExposure * 2 ** stops);
    stats.meteredStops = Math.round(stops * 100) / 100;
  };
  report(0, 'compile');
  while (finished < samples) {
    await clock.frame();
    aborted();
    if (!settled()) continue;
    if (issuedAt) {
      // Aim for batches of roughly 30 to 80 ms of GPU work.
      const ms = performance.now() - issuedAt;
      if (ms < 30 && calls < maxCalls) calls++;
      else if (ms > 80 && calls > 1) calls--;
      issuedAt = 0;
    }
    if (queued > finished) {
      finished = queued;
      started = true;
      if (job.meter && !meteredAt && finished >= Math.min(METER_SAMPLES, samples)) meter(finished);
      let preview = null;
      // Previews are skipped while the page is hidden, where nobody sees them. With a meter they
      // wait for it, so they do not start a stop or so dark and then jump.
      const exposed = !job.meter || meteredAt;
      if (job.onProgress && finished < samples && exposed && !document.hidden && performance.now() - lastPreview > 1000) {
        if (meteredAt && meteredAt !== finished) meter(finished);
        post.compose(finished);
        lastPreview = performance.now();
        preview = canvas;
      }
      report(finished, 'render', preview);
      if (finished >= samples) break;
    }
    if (pt.isCompiling) continue;
    for (let i = 0; i < calls && queued < samples; i++) {
      pt.renderSample();
      if (pt.isCompiling) break;
      const s = pt.samples;
      if (s === Math.floor(s) && s > queued) {
        queued = Math.min(s, samples);
        post.addSample(queued);
      }
    }
    fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    issuedAt = started ? performance.now() : 0;
  }
  const done = finished;
  aborted();
  if (meteredAt && meteredAt !== done) meter(done);
  post.compose(done);
  aborted();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  aborted();
  if (!blob) throw new PhotoError('The photo could not be saved as an image.', 'encode');
  report(done, 'finish', canvas, stats);
  return blob;
}

// ---- Camera ----------------------------------------------------------------------------------

/**
 * The view as a photographer would frame it: the same position and direction, at the photo's
 * aspect (horizontal field of view kept at or under 104 degrees), and, for gentle tilts, a level
 * camera with a shifted lens so vertical edges stay vertical.
 */
function photoCamera(source, width, height) {
  source.updateMatrixWorld();
  const aspect = width / height;
  const pos = new THREE.Vector3().setFromMatrixPosition(source.matrixWorld);
  const fwd = new THREE.Vector3(0, 0, -1).transformDirection(source.matrixWorld);
  let half = THREE.MathUtils.degToRad(source.fov / 2);
  const maxH = THREE.MathUtils.degToRad(52);
  if (Math.atan(Math.tan(half) * aspect) > maxH) half = Math.atan(Math.tan(maxH) / aspect);
  const cam = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(half * 2), aspect, Math.max(0.02, source.near), source.far);
  cam.position.copy(pos);
  const pitch = Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1));
  const flat = Math.hypot(fwd.x, fwd.z);
  if (Math.abs(pitch) < THREE.MathUtils.degToRad(20) && flat > 1e-4) {
    cam.lookAt(pos.x + fwd.x / flat, pos.y, pos.z + fwd.z / flat);
    const n = cam.near, t = Math.tan(half), s = Math.tan(pitch);
    cam.projectionMatrix.makePerspective(-n * t * aspect, n * t * aspect, n * (t + s), n * (s - t), n, cam.far);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  } else {
    cam.quaternion.setFromRotationMatrix(new THREE.Matrix4().extractRotation(source.matrixWorld));
    cam.updateProjectionMatrix();
  }
  cam.updateMatrixWorld();
  return cam;
}

/** Tiles of about TILE_PIXELS, laid out to the image's aspect. */
function tileGrid(width, height) {
  const n = Math.max(1, Math.ceil((width * height) / TILE_PIXELS));
  const x = Math.max(1, Math.min(n, Math.round(Math.sqrt((n * width) / height))));
  return { x, y: Math.ceil(n / x) };
}

// ---- Scene -----------------------------------------------------------------------------------

/**
 * A flat copy of what the view shows, made for the path tracer: meshes share the source geometry
 * but get photo materials (with their own texture objects, so the walkthrough's are never touched
 * by this renderer), overlays and real-time stand-ins (fake contact shadows, the sky dome) are left
 * out, and the sky becomes an image the path tracer lights the scene with.
 */
function photoScene(source, trash) {
  const scene = new THREE.Scene();
  const materials = new Map();
  const textures = new Map();
  const fixtures = [];
  const fixtureMaterials = new Set();
  const lights = [];
  let sun = null;
  let sky = null;
  let meshes = 0;
  const hidden = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0 });
  trash.push(() => hidden.dispose());
  const geometries = new Map();

  const texture = (t) => {
    if (!usableTexture(t)) return null;
    let c = textures.get(t);
    if (!c) {
      c = t.clone();
      c.needsUpdate = true;
      textures.set(t, c);
      trash.push(() => c.dispose());
    }
    return c;
  };
  const convert = (m) => {
    if (!materials.has(m)) {
      const p = photoMaterial(m, texture);
      materials.set(m, p);
      if (p) {
        trash.push(() => p.dispose());
        if (p.userData.photoFixture) fixtureMaterials.add(p);
      }
    }
    return materials.get(m);
  };

  const place = (o, matrix) => {
    const list = Array.isArray(o.material) ? o.material : [o.material];
    const converted = list.map((m) => (m ? convert(m) : null));
    if (!converted.some(Boolean)) return;
    const material = Array.isArray(o.material) ? converted.map((m) => m || hidden) : converted[0];
    const mesh = new THREE.Mesh(mergeable(o.geometry, geometries, trash), material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(matrix);
    scene.add(mesh);
    meshes++;
    if (converted.some((m) => m && fixtureMaterials.has(m))) fixtures.push(mesh);
  };

  const visit = (o) => {
    if (!o.visible || o.userData?.overlay) return;
    if (o.isLight) {
      if (o.isDirectionalLight) {
        if (!sun || (o.castShadow && !sun.castShadow) || (o.castShadow === sun.castShadow && o.intensity > sun.intensity)) sun = o;
      } else if (o.isRectAreaLight || o.isPointLight || o.isSpotLight) {
        lights.push(o);
      }
    } else if (o.isMesh && !o.isSkinnedMesh && o.geometry?.attributes?.position) {
      if (o.name === 'sky') sky = o;
      else if (o.isInstancedMesh) {
        const m = new THREE.Matrix4();
        for (let i = 0; i < o.count; i++) {
          o.getMatrixAt(i, m);
          place(o, m.premultiply(o.matrixWorld));
          m.identity();
        }
      } else {
        place(o, o.matrixWorld);
      }
    }
    for (const c of o.children) visit(c);
  };
  source.updateMatrixWorld();
  visit(source);

  const sunDir = sun
    ? new THREE.Vector3().setFromMatrixPosition(sun.matrixWorld).sub(new THREE.Vector3().setFromMatrixPosition(sun.target.matrixWorld)).normalize()
    : new THREE.Vector3(-0.48, 0.8, 0.36).normalize();
  const env = skyTexture(skyColors(sky), sunDir);
  trash.push(() => env.dispose());
  scene.environment = env;
  scene.background = env;
  return { scene, meshes, fixtures, fixtureMaterials, sun, sunDir, lights };
}

const LAYOUT = { position: 3, normal: 3, uv: 2, tangent: 4, color: 4 };

/**
 * The path tracer merges every mesh into one geometry laid out like the first one it meets, so all
 * attributes it reads must share one layout: float32, unnormalized, color with alpha. Geometry that
 * differs (the builder's 3 component tint colors, for one) gets a converted copy.
 */
function mergeable(g, cache, trash) {
  let out = cache.get(g);
  if (out) return out;
  const fits = Object.entries(LAYOUT).every(([name, size]) => {
    const a = g.attributes[name];
    return !a || (!a.isInterleavedBufferAttribute && a.array instanceof Float32Array && a.itemSize === size && !a.normalized);
  });
  if (fits && !g.attributes.uv2) {
    cache.set(g, g);
    return g;
  }
  out = new THREE.BufferGeometry();
  if (g.index) out.setIndex(g.index);
  for (const [name, size] of Object.entries(LAYOUT)) {
    const a = g.attributes[name];
    if (!a) continue;
    const array = new Float32Array(a.count * size);
    const pad = name === 'color' || name === 'tangent' ? 1 : 0;
    for (let i = 0; i < a.count; i++) {
      for (let k = 0; k < size; k++) array[i * size + k] = k < a.itemSize ? a.getComponent(i, k) : pad;
    }
    out.setAttribute(name, new THREE.BufferAttribute(array, size));
  }
  for (const gr of g.groups) out.addGroup(gr.start, gr.count, gr.materialIndex);
  cache.set(g, out);
  trash.push(() => out.dispose());
  return out;
}

function usableTexture(t) {
  return !!t?.isTexture && !t.isCubeTexture && !t.isRenderTargetTexture && !t.isDepthTexture
    && !t.isDataArrayTexture && !t.isData3DTexture && !!t.image;
}

const saturation = (c) => {
  const hi = Math.max(c.r, c.g, c.b);
  return hi > 0 ? (hi - Math.min(c.r, c.g, c.b)) / hi : 0;
};

/** The photo version of a material, or null when the surface is only a real-time stand-in. */
function photoMaterial(m, texture) {
  if (!m.visible || m.wireframe || m.colorWrite === false) return null;
  if (m.blending === THREE.AdditiveBlending || m.blending === THREE.MultiplyBlending || m.blending === THREE.SubtractiveBlending) return null;
  if (m.isMeshBasicMaterial) {
    // Painted contact shadows and glows: the path tracer finds the real ones.
    if (m.transparent && !m.depthWrite) return null;
    // Unlit backdrops (the skyline) stay as they look in the walkthrough, self-lit like the sky.
    const p = new THREE.MeshStandardMaterial({
      color: 0x000000, roughness: 1, metalness: 0, emissive: m.color, emissiveIntensity: SKY.scale,
      side: m.side, alphaTest: m.alphaTest, transparent: m.transparent, opacity: m.opacity,
    });
    p.map = texture(m.map);
    p.emissiveMap = p.map;
    p.alphaMap = texture(m.alphaMap);
    p.castShadow = false;
    return p;
  }
  if (m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isMeshToonMaterial) {
    const p = new THREE.MeshStandardMaterial({
      color: m.color, roughness: m.isMeshPhongMaterial ? THREE.MathUtils.clamp(1 - m.shininess / 120, 0.2, 1) : 0.9,
      emissive: m.emissive, emissiveIntensity: m.emissiveIntensity, side: m.side, vertexColors: m.vertexColors,
      alphaTest: m.alphaTest, transparent: m.transparent, opacity: m.opacity,
    });
    p.map = texture(m.map);
    p.emissiveMap = texture(m.emissiveMap);
    p.alphaMap = texture(m.alphaMap);
    p.normalMap = texture(m.normalMap);
    return classify(p);
  }
  if (!m.isMeshStandardMaterial) return null;
  if (isGlass(m)) return glass(m);
  if (m.transparent && m.opacity < 0.02) return null;
  // Material.clone() deep copies userData through JSON; leave it out so nothing in it can break that.
  const userData = m.userData;
  let p;
  m.userData = {};
  try {
    p = m.clone();
  } finally {
    m.userData = userData;
  }
  for (const key of Object.keys(p)) {
    const v = p[key];
    if (v?.isTexture) p[key] = PT_MAPS.has(key) ? texture(v) : null;
  }
  return classify(p);
}

/** Bright, near-white emitters are light fixtures: calibrated output, lit through area lights. */
function classify(p) {
  const e = p.emissive.clone().multiplyScalar(p.emissiveIntensity);
  const peak = Math.max(e.r, e.g, e.b);
  if (peak >= FIXTURE_MIN && saturation(e) < 0.3 && !p.emissiveMap) {
    p.emissiveIntensity = FIXTURE_RADIANCE / Math.max(p.emissive.r, p.emissive.g, p.emissive.b);
    p.userData.photoFixture = true;
    flagFixture(p);
  }
  return p;
}

function isGlass(m) {
  if (m.userData?.kitFamily === 'glass' || /glass/i.test(m.name) || m.transmission > 0) return true;
  return m.transparent && m.opacity < 0.6 && m.roughness < 0.5 && !m.map;
}

/** Thin architectural glass: clear or frosted, tinted like the real-time pane. */
function glass(m) {
  const frosted = /frost/i.test(m.name) || m.roughness > 0.25;
  let tint = new THREE.Color('#e8eeec');
  if (m.blending === THREE.CustomBlending && m.blendColor) tint = m.blendColor.clone();
  else if (m.transmission > 0) tint = m.color.clone();
  tint.multiplyScalar(1 / Math.max(tint.r, tint.g, tint.b, 1e-4));
  const p = new THREE.MeshPhysicalMaterial({
    // Acid-etched glass scatters light right through it: only what touches it reads behind it.
    color: tint.multiplyScalar(frosted ? 0.92 : 0.97), metalness: 0, roughness: frosted ? 0.9 : 0.02,
    transmission: frosted ? 0.8 : 1, ior: 1.5, thickness: 0, side: THREE.DoubleSide,
  });
  p.name = m.name;
  return p;
}

// The path tracer's iridescence thickness range is unused while iridescence is 0; a negative
// maximum marks a fixture whose emission only counts for rays from the camera (see patchEmission).
function flagFixture(m) { m.iridescenceThicknessRange = [100, -1]; }
function unflagFixture(m) { m.iridescenceThicknessRange = [100, 400]; }

/** Linear sky colors from the real-time dome's vertex colors, at the horizon and the zenith. */
function skyColors(sky) {
  const fallback = { horizon: new THREE.Color(SKY.horizon), zenith: new THREE.Color(SKY.zenith) };
  const pos = sky?.geometry?.attributes?.position, col = sky?.geometry?.attributes?.color;
  if (!pos || !col) return fallback;
  let top = -Infinity, flat = Infinity, ti = 0, hi = 0;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y > top) { top = y; ti = i; }
    if (y >= 0 && y < flat) { flat = y; hi = i; }
  }
  const get = (i) => new THREE.Color(col.getX(i), col.getY(i), col.getZ(i));
  return { horizon: get(hi), zenith: get(ti) };
}

/** Equirect sky: the dome's gradient at daylight strength, a soft glow around the sun, a dim ground. */
function skyTexture({ horizon, zenith }, sunDir) {
  const tex = new ProceduralEquirectTexture(512, 256);
  const dir = new THREE.Vector3();
  const ground = horizon.clone().multiply(new THREE.Color(0.62, 0.58, 0.52));
  tex.generationCallback = (polar, uv, coord, color) => {
    dir.setFromSpherical(polar);
    const y = dir.y;
    if (y >= 0) color.copy(horizon).lerp(zenith, Math.pow(y, 0.55));
    else color.copy(horizon).lerp(ground, Math.min(1, -y * 8));
    color.multiplyScalar(SKY.scale);
    const c = dir.dot(sunDir);
    const glow = Math.exp((c - 1) * 250) * 8 + Math.exp((c - 1) * 8) * 0.5 * Math.max(0, y + 0.1);
    color.r += glow;
    color.g += glow * 0.95;
    color.b += glow * 0.86;
  };
  tex.update();
  return tex;
}

// ---- Path tracer setup ---------------------------------------------------------------------------

/**
 * Light fixtures are drawn as emissive surfaces but lit through area lights at their faces, which
 * the path tracer samples directly (far less noise than waiting for rays to hit a small panel).
 * So that their light does not count twice, flagged fixture surfaces only emit toward rays from the
 * camera, straight or through glass; the area lights are invisible to exactly those rays.
 */
function patchEmission(pt) {
  const material = pt._pathTracer?.material;
  const fs = material?.fragmentShader;
  const first = 'state.firstRay = i == 0 && state.transmissiveTraversals == transmissiveBounces;';
  const emission = 'gl_FragColor.rgb += ( surf.emission * state.throughputColor );';
  if (typeof fs !== 'string' || fs.split(first).length !== 2 || fs.split(emission).length !== 2) {
    console.warn('three-gpu-pathtracer changed; photo light fixtures fall back to emissive surfaces only.');
    return false;
  }
  let patched = fs
    .replace(first, `${first}\n\t\t\t\t\t\tbool photoDirectRay = state.firstRay || state.transmissiveRay;`)
    .replace(emission, 'gl_FragColor.rgb += ( material.iridescenceThicknessMaximum < 0.0 && ! photoDirectRay ? vec3( 0.0 ) : surf.emission ) * state.throughputColor;');
  // A sample that came back NaN or infinite (an overflowing MIS weight on a near mirror) would stay
  // in its pixel's running mean for good; drop that one sample instead.
  const end = 'gl_FragColor.a *= opacity;';
  if (patched.split(end).length === 2) {
    patched = patched.replace(end, `if ( ! all( lessThan( abs( gl_FragColor.rgb ), vec3( 1e20 ) ) ) ) gl_FragColor.rgb = vec3( 0.0 );\n\t\t\t\t\t${end}`);
  }
  material.fragmentShader = patched; // compiled by the caller's needsUpdate
  return true;
}

/**
 * The path tracer lets a shadow ray through a single-sided surface it meets from the front (light
 * passes through the back side), so sun and sky reached every room through the down-facing ceilings
 * and roof deck. Here opaque surfaces block light from both sides, as the probes in addLights assume;
 * rays from the camera and bounces still pass through back faces, so nothing new comes into view.
 */
function patchShadows(pt) {
  const material = pt._pathTracer?.material;
  const fs = material?.fragmentShader;
  const sided = 'material.side != 0.0 && surfaceHit.side == material.side';
  if (typeof fs !== 'string' || fs.split(sided).length !== 2) {
    console.warn('three-gpu-pathtracer changed; photo daylight may come through single-sided ceilings.');
    return;
  }
  material.fragmentShader = fs.replace(sided, 'false'); // compiled by the caller's needsUpdate
}

/**
 * Size the accumulation target before the first sample. With float blending the two blend targets
 * are never read, so they stay 1 x 1 instead of costing two more full-size float images.
 */
function presize(pt, renderer, width, height) {
  const r = pt._pathTracer;
  if (!r?.setSize) return;
  r.setSize(width, height);
  pt._lowResPathTracer?.setSize(Math.max(1, Math.floor(width * pt.lowResScale)), Math.max(1, Math.floor(height * pt.lowResScale)));
  if (renderer.extensions.get('EXT_float_blend') && r._blendTargets) for (const t of r._blendTargets) t.setSize(1, 1);
}

// Builds a MeshBVH from the arrays it is sent and sends back the tree, as three-mesh-bvh's own
// GenerateMeshBVHWorker does (not vendored).
const BVH_WORKER = (lib, three) => `
  import { MeshBVH } from ${JSON.stringify(lib)};
  import { BufferGeometry, BufferAttribute } from ${JSON.stringify(three)};
  onmessage = ({ data }) => {
    try {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(data.position, 3));
      if (data.index) geometry.setIndex(new BufferAttribute(data.index, 1));
      for (const g of data.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
      geometry.setDrawRange(data.drawRange.start, data.drawRange.count);
      const { roots, indirectBuffer } = MeshBVH.serialize(new MeshBVH(geometry, data.options), { cloneBuffers: false });
      postMessage({ roots, indirectBuffer }, indirectBuffer ? [...roots, indirectBuffer.buffer] : roots);
    } catch (err) {
      postMessage({ error: String(err?.message || err) });
    }
  };`;
let bvhWorkerUrl = null;

/**
 * The path tracer's BVH in a worker: building it is the longest step of the setup (several seconds
 * for a large plan), and the page stays responsive meanwhile. Module workers do not see the page's
 * import map, so the worker loads the vendored three-mesh-bvh with its import of three pointed at
 * the page's copy. Resolves with null where that cannot work; a build the worker fails is done here.
 */
async function bvhBuilder(trash, signal) {
  let worker;
  try {
    bvhWorkerUrl ??= (async () => {
      const three = import.meta.resolve('three');
      const res = await fetch(import.meta.resolve('three-mesh-bvh'));
      if (!res.ok) throw new Error(`three-mesh-bvh: ${res.status}`);
      const lib = (await res.text()).replace(/from\s*(['"])three\1/g, `from ${JSON.stringify(three)}`);
      const libUrl = URL.createObjectURL(new Blob([lib], { type: 'text/javascript' }));
      return URL.createObjectURL(new Blob([BVH_WORKER(libUrl, three)], { type: 'text/javascript' }));
    })();
    worker = new Worker(await bvhWorkerUrl, { type: 'module' });
  } catch (err) {
    console.warn('Photo BVH worker unavailable; building on the page.', err);
    bvhWorkerUrl = null;
    return null;
  }
  let failed = false;
  let disposed = false;
  let fallback = null;
  worker.onerror = (e) => {
    e.preventDefault();
    if (!failed) console.warn('Photo BVH worker did not start; building on the page.');
    failed = true;
    fallback?.();
  };
  // Cancelling stops the build at once, even while the rest of the cleanup waits (see job.settle).
  const stop = () => {
    disposed = true;
    worker.terminate();
  };
  signal?.addEventListener('abort', stop, { once: true });
  trash.push(() => {
    signal?.removeEventListener('abort', stop);
    stop();
  });
  return {
    // The interface PathTracingSceneGenerator expects of a BVH worker.
    generate(geometry, options) {
      const { onProgress: _, ...rest } = options; // functions cannot go to a worker
      return new Promise((resolve) => {
        const here = () => {
          fallback = null;
          if (!disposed) resolve(new MeshBVH(geometry, options));
        };
        if (failed) {
          here();
          return;
        }
        fallback = here;
        worker.onmessage = ({ data }) => {
          fallback = null;
          if (disposed) return;
          if (data.error) {
            console.warn('Photo BVH worker failed; building on the page.', data.error);
            here();
            return;
          }
          const bvh = MeshBVH.deserialize({ roots: data.roots, index: null, indirectBuffer: data.indirectBuffer }, geometry, { setIndex: false });
          geometry.boundingBox ??= bvh.getBoundingBox(new THREE.Box3());
          resolve(bvh);
        };
        try {
          // Copies: the merged geometry keeps its arrays.
          worker.postMessage({
            position: geometry.attributes.position.array, index: geometry.index?.array ?? null,
            groups: geometry.groups, drawRange: geometry.drawRange, options: rest,
          });
        } catch (err) {
          console.warn('Photo BVH worker failed; building on the page.', err);
          here();
        }
      });
    },
  };
}

/** WebGLPathTracer.dispose() in 0.0.23 throws, so release its parts here; the context goes too. */
function disposePathTracer(pt) {
  const safe = (fn) => {
    try {
      fn();
    } catch {
      // already gone with the context
    }
  };
  safe(() => pt._quad.dispose());
  safe(() => pt._quad.material.dispose());
  for (const r of [pt._pathTracer, pt._lowResPathTracer]) {
    if (!r) continue;
    const u = r.material?.uniforms || {};
    safe(() => u.bvh.value.dispose());
    safe(() => u.attributesArray.value.dispose());
    safe(() => u.materialIndexAttribute.value.dispose());
    safe(() => u.materials.value.dispose());
    safe(() => u.textures.value.dispose());
    safe(() => u.lights.value.tex.dispose());
    safe(() => u.envMapInfo.value.dispose());
    safe(() => r.material.dispose());
    safe(() => r.dispose());
  }
  safe(() => pt._colorBackground?.dispose());
  safe(() => pt._internalBackground?.dispose());
  safe(() => pt._generator.geometry.dispose());
  safe(() => { pt._generator.bvh = null; });
}

// ---- Lights ---------------------------------------------------------------------------------------

/**
 * The sun, the source's own point, spot and area lights (minus any that stand in for a fixture),
 * and area lights for the fixtures that light what the camera sees. The sun is split into copies
 * so it gets about SUN_SHARE of the light samples when it reaches the view (the path tracer picks
 * lights uniformly).
 */
function addLights(pt, photo, result, camera, patched, trash) {
  const scene = photo.scene;
  const clusters = patched ? fixtureClusters(photo.fixtures) : [];
  const own = (light) => {
    scene.add(light);
    if (light.target) scene.add(light.target);
    trash.push(() => light.dispose?.());
  };
  const probe = probes(result, camera);
  let materialsChanged = false;

  // Fixtures with no face for an area light keep plain emission.
  const lit = new Set(clusters.map((c) => c.material));
  for (const m of photo.fixtureMaterials) {
    if (patched && !lit.has(m)) {
      unflagFixture(m);
      materialsChanged = true;
    }
  }

  const camPos = camera.position;
  const near = clusters.filter((c) => c.center.distanceTo(camPos) < LIGHT_REACH)
    .sort((a, b) => a.center.distanceTo(camPos) - b.center.distanceTo(camPos)).slice(0, MAX_FIXTURE_LIGHTS * 4);
  // Score each fixture by roughly how much light it gives the surfaces the camera sees.
  const _d = new THREE.Vector3();
  for (const c of near) {
    c.output = fixtureBoost(c) * c.area;
    c.score = 0;
    for (const p of probe.points) {
      const dy = c.center.y - p.y;
      if (dy <= 0.01) continue;
      _d.subVectors(c.center, p);
      const d2 = _d.lengthSq(), dist = Math.sqrt(d2);
      if (!probe.blocked(p, _d.multiplyScalar(1 / dist), dist - 0.02)) c.score += (c.output * dy) / (dist * (d2 + 0.5));
    }
  }
  const chosen = near.filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, MAX_FIXTURE_LIGHTS);
  // The path tracer picks lights uniformly; giving the fixtures that matter most several copies
  // (sharing their output) steers samples to them without bias.
  const total = chosen.reduce((sum, c) => sum + c.score, 0);
  for (const c of chosen) {
    const copies = Math.max(1, Math.round((FIXTURE_ENTRIES * c.score) / total));
    for (let i = 0; i < copies; i++) own(areaLight(c, copies));
  }

  const placed = photo.lights.map((l) => ({ l, p: new THREE.Vector3().setFromMatrixPosition(l.matrixWorld) }))
    .filter(({ p }) => !clusters.some((c) => Math.hypot(c.center.x - p.x, c.center.z - p.z) < 0.15 && Math.abs(c.center.y - p.y) < 0.3))
    .sort((a, b) => a.p.distanceTo(camPos) - b.p.distanceTo(camPos)).slice(0, MAX_SOURCE_LIGHTS);
  for (const { l } of placed) {
    const copy = l.clone(false);
    copy.matrixAutoUpdate = false;
    copy.matrix.copy(l.matrixWorld);
    if (copy.target) {
      copy.target = new THREE.Object3D();
      copy.target.position.setFromMatrixPosition(l.target.matrixWorld);
    }
    own(copy);
  }

  const sunSeen = probe.points.filter((p) => !probe.blocked(p, photo.sunDir, 1e5)).length;
  const n = scene.children.filter((o) => o.isLight).length + 1; // the lights so far and the sky
  const copies = sunSeen > 0 ? Math.max(1, Math.round((SUN_SHARE * n) / (1 - SUN_SHARE))) : Math.max(1, Math.round(n * 0.08));
  const color = photo.sun ? photo.sun.color : new THREE.Color('#fff1dc');
  const target = new THREE.Vector3().copy(camPos);
  for (let i = 0; i < copies; i++) {
    const sun = new THREE.DirectionalLight(color, SUN_IRRADIANCE / copies);
    sun.position.copy(target).addScaledVector(photo.sunDir, 1000);
    sun.target.position.copy(target);
    own(sun);
  }
  scene.updateMatrixWorld(true);
  return { materialsChanged, fixtures: chosen.length, sunCopies: copies, sunSeen, probes: probe.points.length };
}

/**
 * Smaller fixtures are brighter, so a downlight gives a useful share of a panel's light; a larger
 * panel (a 2 x 4 troffer) is dimmer by its area, giving about the light of a 2 x 2.
 */
const fixtureBoost = (c) => Math.pow(THREE.MathUtils.clamp(FIXTURE_AREA / c.area, 0.4, 8), 0.9);

/** An area light just below a fixture face, shining down with the face's color and calibrated output. */
function areaLight(c, copies = 1) {
  const e = c.material.emissive;
  const peak = Math.max(e.r, e.g, e.b, 1e-4);
  const light = new ShapedAreaLight(new THREE.Color(e.r / peak, e.g / peak, e.b / peak), (FIXTURE_RADIANCE * fixtureBoost(c)) / copies, c.width, c.height);
  light.isCircular = c.circular;
  light.position.copy(c.center).y -= 0.002;
  // Local x along the fixture, local z up, so the light faces down (-z).
  const x = new THREE.Vector3(c.ux, 0, c.uz), z = new THREE.Vector3(0, 1, 0);
  const y = new THREE.Vector3().crossVectors(z, x);
  light.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  return light;
}

/**
 * Downward-facing faces of fixture meshes, joined where they share corners: each group is one
 * fixture face, fitted with a rectangle (along its longest edge) or a disc.
 */
function fixtureClusters(meshes) {
  const out = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3(), vn = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  for (const mesh of meshes) {
    const g = mesh.geometry;
    const pos = g.attributes.position, nor = g.attributes.normal, index = g.index;
    const count = index ? index.count : pos.count;
    const mats = Array.isArray(mesh.material) ? mesh.material : null;
    const ranges = mats && g.groups.length
      ? g.groups.filter((gr) => mats[gr.materialIndex]?.userData.photoFixture).map((gr) => [gr.start, Math.min(count, gr.start + gr.count), mats[gr.materialIndex]])
      : [[0, count, mats ? mats[0] : mesh.material]];
    nm.getNormalMatrix(mesh.matrix);
    for (const [start, end, material] of ranges) {
      if (!material?.userData.photoFixture) continue;
      const parent = new Map();
      const find = (k) => {
        let r = k;
        while (parent.get(r) !== r) r = parent.get(r);
        parent.set(k, r);
        return r;
      };
      const key = (v) => {
        const k = `${Math.round(v.x * 1000)},${Math.round(v.y * 1000)},${Math.round(v.z * 1000)}`;
        if (!parent.has(k)) parent.set(k, k);
        return k;
      };
      const tris = [];
      for (let t = start; t + 2 < end; t += 3) {
        const ia = index ? index.getX(t) : t, ib = index ? index.getX(t + 1) : t + 1, ic = index ? index.getX(t + 2) : t + 2;
        a.fromBufferAttribute(pos, ia).applyMatrix4(mesh.matrix);
        b.fromBufferAttribute(pos, ib).applyMatrix4(mesh.matrix);
        c.fromBufferAttribute(pos, ic).applyMatrix4(mesh.matrix);
        n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
        const area = n.length() / 2;
        if (area < 1e-7) continue;
        n.normalize();
        if (nor) {
          vn.fromBufferAttribute(nor, ia).applyMatrix3(nm);
          if (vn.dot(n) < 0) n.negate();
        }
        if (n.y > -0.9) continue;
        const ka = key(a), kb = key(b), kc = key(c);
        const ra = find(ka);
        parent.set(find(kb), ra);
        parent.set(find(kc), ra);
        tris.push({ k: ka, area, pts: [a.clone(), b.clone(), c.clone()] });
      }
      const groups = new Map();
      for (const t of tris) {
        const r = find(t.k);
        let gr = groups.get(r);
        if (!gr) groups.set(r, (gr = { area: 0, pts: [] }));
        gr.area += t.area;
        gr.pts.push(...t.pts);
      }
      for (const gr of groups.values()) {
        const fit = fitFace(gr.pts, gr.area);
        if (fit) out.push({ ...fit, area: gr.area, material });
      }
    }
  }
  return out;
}

function fitFace(pts, area) {
  let ux = 1, uz = 0, best = 0, ylo = Infinity, yhi = -Infinity, ysum = 0;
  for (let i = 0; i < pts.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const p = pts[i + j], q = pts[i + ((j + 1) % 3)];
      const dx = q.x - p.x, dz = q.z - p.z, l2 = dx * dx + dz * dz;
      if (l2 > best) {
        best = l2;
        const l = Math.sqrt(l2);
        ux = dx / l;
        uz = dz / l;
      }
    }
  }
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of pts) {
    const u = p.x * ux + p.z * uz, v = -p.x * uz + p.z * ux;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u);
    v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    ylo = Math.min(ylo, p.y); yhi = Math.max(yhi, p.y);
    ysum += p.y;
  }
  let width = u1 - u0, height = v1 - v0;
  if (width < 0.005 || height < 0.005 || yhi - ylo > 0.02) return null;
  const fill = area / (width * height);
  const ratio = width / height;
  const circular = fill > 0.7 && fill < 0.86 && ratio > 0.8 && ratio < 1.25;
  if (!circular && fill < 0.9) {
    const k = Math.sqrt(fill);
    width *= k;
    height *= k;
  }
  const u = (u0 + u1) / 2, v = (v0 + v1) / 2;
  return { center: new THREE.Vector3(u * ux - v * uz, ysum / pts.length, u * uz + v * ux), width, height, ux, uz, circular };
}

/**
 * Points the camera sees (a grid of rays through the image, past glass and cutouts) and a test for
 * whether something solid blocks a ray, both on the path tracer's own BVH.
 */
function probes(result, camera) {
  const { bvh, geometry, materials } = result;
  const see = materials.map((m) => !m || m.opacity < 0.5 || m.alphaTest > 0 || (m.transmission || 0) > 0.5);
  const mi = geometry.attributes.materialIndex, index = geometry.index;
  const solid = (hit) => !see[mi.getX(index ? index.getX(hit.faceIndex * 3) : hit.faceIndex * 3)];
  const ray = new THREE.Ray();
  const blocked = (origin, dir, far) => {
    ray.origin.copy(origin);
    ray.direction.copy(dir);
    const hits = bvh.raycast(ray, THREE.DoubleSide, 0, far);
    for (const h of hits) if (h.distance < far && solid(h)) return true;
    return false;
  };
  const points = [camera.position.clone()];
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const NX = 12, NY = 7;
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      ndc.set(((i + 0.5) / NX) * 2 - 1, ((j + 0.5) / NY) * 2 - 1);
      raycaster.setFromCamera(ndc, camera);
      const hits = bvh.raycast(raycaster.ray, THREE.DoubleSide, 0, 200);
      let best = null;
      for (const h of hits) if (solid(h) && (!best || h.distance < best.distance)) best = h;
      if (best) points.push(raycaster.ray.at(Math.max(0, best.distance - 0.02), new THREE.Vector3()));
    }
  }
  return { points, blocked };
}

// ---- Guides, denoising and output -------------------------------------------------------------------

const FULLSCREEN_VS = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

const GUIDE_VS = /* glsl */`
  precision highp float;
  in vec3 position;
  in vec3 normal;
  in vec2 uv;
  in vec4 photoColor;
  in float photoMaterial;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  uniform mat4 viewMatrix;
  uniform vec2 jitter;
  out vec2 vUv;
  out vec4 vColor;
  out vec3 vNormal;
  out vec3 vView;
  flat out int vMaterial;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_Position.xy += jitter * gl_Position.w;
    vUv = uv;
    vColor = photoColor;
    vNormal = (viewMatrix * vec4(normal, 0.0)).xyz;
    vView = mv.xyz;
    vMaterial = int(photoMaterial + 0.5);
  }`;

// Reads three-gpu-pathtracer's own material records and texture array (mipmapped for this draw),
// so the guides see the surfaces the path tracer does, with textures filtered over the pixel the
// way many path traced samples average them. Glass and other see-through surfaces are skipped, so the
// guides describe what is behind them.
const GUIDE_FS = /* glsl */`
  precision highp float;
  precision highp int;
  precision highp sampler2D;
  precision highp sampler2DArray;
  uniform sampler2D materials;
  uniform sampler2DArray textures;
  in vec2 vUv;
  in vec4 vColor;
  in vec3 vNormal;
  in vec3 vView;
  flat in int vMaterial;
  out vec4 outColor;
  vec4 record(int i) {
    int w = textureSize(materials, 0).x;
    return texelFetch(materials, ivec2(i % w, i / w), 0);
  }
  void main() {
    int base = vMaterial * ${MATERIAL_TEXELS};
    vec4 s0 = record(base), s1 = record(base + 1), s2 = record(base + 2), s3 = record(base + 3);
    vec4 s13 = record(base + 13), s14 = record(base + 14);
    if ((s13.a > 0.5 && !gl_FrontFacing) || (s13.a < -0.5 && gl_FrontFacing)) discard;
    vec4 albedo = vec4(s0.rgb, s13.g);
    int map = int(round(s0.a));
    if (map >= 0) {
      vec4 r0 = record(base + 15), r1 = record(base + 16);
      mat3 t = mat3(vec3(r0.r, r1.r, 0.0), vec3(r0.g, r1.g, 0.0), vec3(r0.b, r1.b, 1.0));
      vec2 uv = (t * vec3(vUv, 1.0)).xy;
      albedo *= textureGrad(textures, vec3(uv, float(map)), dFdx(uv), dFdy(uv));
    }
    if ((int(s14.b) & 1) == 1) albedo *= vColor;
    int alphaMap = int(round(s13.r));
    if (alphaMap >= 0) albedo.a *= textureGrad(textures, vec3(vUv, float(alphaMap)), dFdx(vUv), dFdy(vUv)).r;
    float alphaTest = s13.b;
    if (alphaTest > 0.0 && albedo.a < alphaTest) discard;
    if ((1.0 - s1.r) * s2.g > 0.5 || (s14.a > 0.5 && alphaTest == 0.0 && albedo.a < 0.5)) discard;
  #ifdef ALBEDO
    outColor = vec4(albedo.rgb, 1.0);
  #else
    vec3 n = normalize(vNormal);
    if (dot(n, vView) > 0.0) n = -n;
    float emission = s2.a * max(s3.r, max(s3.g, s3.b));
    float depth = -vView.z;
    outColor = vec4(n, emission > ${EMISSIVE_CLASS.toFixed(2)} ? -depth : depth);
  #endif
  }`;

const COMMON = /* glsl */`
  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
  uniform mat4 invProjection;
  uniform vec2 size;
  vec3 viewAt(ivec2 p, float depth) {
    vec2 ndc = (vec2(p) + 0.5) / size * 2.0 - 1.0;
    vec4 v = invProjection * vec4(ndc, -1.0, 1.0);
    v.xyz /= v.w;
    return v.xyz * (depth / -v.z);
  }
  bool inside(ivec2 q) { return q.x >= 0 && q.y >= 0 && q.x < int(size.x) && q.y < int(size.y); }
  // A rare path can come back NaN or infinite, and its pixel's running mean stays that way, which
  // a blur (the bloom) would spread over the frame. Such pixels take their valid neighbors' mean.
  bool valid(vec3 c) { return all(lessThan(abs(c), vec3(60000.0))); }
  vec3 radianceAt(sampler2D t, ivec2 p) {
    vec3 c = texelFetch(t, p, 0).rgb;
    if (valid(c)) return max(c, vec3(0.0));
    vec3 sum = vec3(0.0);
    float n = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        ivec2 q = p + ivec2(x, y);
        if ((x == 0 && y == 0) || !inside(q)) continue;
        vec3 v = texelFetch(t, q, 0).rgb;
        if (valid(v)) {
          sum += max(v, vec3(0.0));
          n += 1.0;
        }
      }
    }
    return n > 0.0 ? sum / n : vec3(0.0);
  }
`;

/** Running mean of the per-sample luminance squared, for each pixel's noise level. */
const MOMENTS_FS = /* glsl */`
  uniform sampler2D tMean;
  uniform sampler2D tPrev;
  uniform float n;
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    float l = dot(texelFetch(tMean, p, 0).rgb, vec3(0.2126, 0.7152, 0.0722));
    vec2 prev = texelFetch(tPrev, p, 0).rg;
    float s = n * l - (n - 1.0) * prev.x; // the newest sample, recovered from the two means
    float m2 = prev.y + (s * s - prev.y) / n;
    // A pixel gone invalid (see radianceAt) keeps its last moments.
    gl_FragColor = abs(l) < 60000.0 && abs(m2) < 3.0e38 ? vec4(l, m2, 0.0, 1.0) : vec4(prev, 0.0, 1.0);
  }`;

/**
 * Illumination (color over albedo, so texture detail never blurs) and its standard deviation.
 * Lone fireflies are clamped to their neighborhood. Alpha below zero marks pixels left as they are.
 */
const PREPARE_FS = /* glsl */`
  ${COMMON}
  uniform sampler2D tColor;
  uniform sampler2D tAlbedo;
  uniform sampler2D tGuide;
  uniform sampler2D tMoments;
  uniform float n;
  vec3 albedoAt(ivec2 p) {
    vec4 a = texelFetch(tAlbedo, p, 0);
    return max(a.rgb / max(a.a, 1e-4), vec3(0.03));
  }
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec3 color = radianceAt(tColor, p);
    vec4 g = texelFetch(tGuide, p, 0);
    if (g.a <= 0.0) {
      gl_FragColor = vec4(color, -1.0);
      return;
    }
    vec3 alb = albedoAt(p);
    vec3 illum = color / alb;
    float l = dot(illum, LUMA);
    float peak = 0.0, s1 = l, s2 = l * l, count = 1.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        ivec2 q = p + ivec2(x, y);
        if ((x == 0 && y == 0) || !inside(q) || texelFetch(tGuide, q, 0).a <= 0.0) continue;
        float lq = dot(radianceAt(tColor, q) / albedoAt(q), LUMA);
        peak = max(peak, lq);
        s1 += lq;
        s2 += lq * lq;
        count += 1.0;
      }
    }
    if (peak > 0.0 && l > 2.0 * peak + 0.02) illum *= (2.0 * peak + 0.02) / l;
    illum = min(illum, vec3(60000.0)); // stays within half float
    // Per-pixel deviation from the sample moments; with only a few samples that estimate is
    // unreliable, so start from the spread across neighbors, as SVGF does.
    vec2 m = texelFetch(tMoments, p, 0).rg;
    float variance = max(m.y - m.x * m.x, 0.0) / max(n - 1.0, 1.0);
    float al = max(dot(alb, LUMA), 0.03);
    float spatial = max(s2 / count - (s1 / count) * (s1 / count), 0.0);
    float sigma = mix(sqrt(spatial), sqrt(variance) / al, clamp((n - 2.0) / 6.0, 0.0, 1.0));
    gl_FragColor = vec4(illum, valid(vec3(sigma)) ? sigma : 0.0);
  }`;

/** One a-trous step: a 5 x 5 B3 spline at stepSize spacing, stopped at edges in depth, normal and illumination. */
const ATROUS_FS = /* glsl */`
  ${COMMON}
  uniform sampler2D tIllum;
  uniform sampler2D tGuide;
  uniform int stepSize;
  uniform float sigmaL;
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 c = texelFetch(tIllum, p, 0);
    vec4 g = texelFetch(tGuide, p, 0);
    if (c.a < 0.0 || g.a <= 0.0) {
      gl_FragColor = c;
      return;
    }
    vec3 P = viewAt(p, g.a);
    vec3 nrm = g.xyz;
    // Noise level from a small blur of the deviation, as in SVGF.
    float v = 0.0, vw = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        ivec2 q = p + ivec2(x, y);
        if (!inside(q)) continue;
        float s = texelFetch(tIllum, q, 0).a;
        if (s < 0.0) continue;
        float k = (x == 0 ? 0.5 : 0.25) * (y == 0 ? 0.5 : 0.25);
        v += s * s * k;
        vw += k;
      }
    }
    float phiL = sigmaL * sqrt(v / max(vw, 1e-6)) + 1e-6;
    float lp = dot(c.rgb, LUMA);
    float tolerance = 0.02 + 0.0025 * g.a * float(stepSize);
    float kernel[3] = float[3](0.375, 0.25, 0.0625);
    vec3 sum = vec3(0.0);
    float var = 0.0, wsum = 0.0;
    for (int y = -2; y <= 2; y++) {
      for (int x = -2; x <= 2; x++) {
        ivec2 q = p + ivec2(x, y) * stepSize;
        if (!inside(q)) continue;
        vec4 cq = texelFetch(tIllum, q, 0);
        vec4 gq = texelFetch(tGuide, q, 0);
        if (cq.a < 0.0 || gq.a <= 0.0) continue;
        float plane = abs(dot(viewAt(q, gq.a) - P, nrm));
        float w = kernel[abs(x)] * kernel[abs(y)]
          * max(0.0, 1.0 - plane / tolerance)
          * pow(max(dot(nrm, gq.xyz), 0.0), 64.0)
          * exp(-abs(lp - dot(cq.rgb, LUMA)) / phiL);
        sum += cq.rgb * w;
        var += cq.a * cq.a * w * w;
        wsum += w;
      }
    }
    gl_FragColor = wsum > 1e-8 ? vec4(sum / wsum, sqrt(var) / wsum) : c;
  }`;

/**
 * Back to radiance. On silhouettes and creases the albedo is a mix of two surfaces, so the
 * filtered value is held within the range of the path traced colors around it (no halos), and
 * keeps some of the path traced value, which carries the anti-aliasing, once there are enough
 * samples for it to be clean (edgeKeep).
 */
const REMODULATE_FS = /* glsl */`
  ${COMMON}
  uniform sampler2D tIllum;
  uniform sampler2D tColor;
  uniform sampler2D tAlbedo;
  uniform sampler2D tGuide;
  uniform float edgeKeep;
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec3 color = radianceAt(tColor, p);
    vec4 g = texelFetch(tGuide, p, 0);
    if (g.a <= 0.0) {
      gl_FragColor = vec4(color, 1.0);
      return;
    }
    vec3 P = viewAt(p, g.a);
    float tolerance = 0.02 + 0.0025 * g.a;
    bool edge = false;
    for (int k = 0; k < 4; k++) {
      ivec2 q = p + (k == 0 ? ivec2(1, 0) : k == 1 ? ivec2(-1, 0) : k == 2 ? ivec2(0, 1) : ivec2(0, -1));
      if (!inside(q)) continue;
      vec4 gq = texelFetch(tGuide, q, 0);
      if (gq.a <= 0.0 || dot(g.xyz, gq.xyz) < 0.9 || abs(dot(viewAt(q, gq.a) - P, g.xyz)) > tolerance) edge = true;
    }
    vec4 a = texelFetch(tAlbedo, p, 0);
    vec3 alb = max(a.rgb / max(a.a, 1e-4), vec3(0.03));
    vec3 result = texelFetch(tIllum, p, 0).rgb * alb;
    if (edge) {
      vec3 lo = color, hi = color;
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          ivec2 q = p + ivec2(x, y);
          if (!inside(q)) continue;
          vec3 v = radianceAt(tColor, q);
          lo = min(lo, v);
          hi = max(hi, v);
        }
      }
      result = mix(clamp(result, lo, hi), color, edgeKeep);
    }
    gl_FragColor = vec4(valid(result) ? result : color, 1.0);
  }`;

/** Lens falloff, then the renderer's tone mapping (the walkthrough grade and AgX) and sRGB, dithered. */
const OUTPUT_FS = /* glsl */`
  uniform sampler2D tHDR;
  uniform vec2 aspect;
  uniform float vignette;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tHDR, vUv).rgb;
    vec2 d = (vUv - 0.5) * aspect;
    c *= 1.0 - vignette * smoothstep(0.15, 0.55, dot(d, d));
    gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    gl_FragColor.rgb += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  }`;

function target(width, height, { type = THREE.HalfFloatType, format = THREE.RGBAFormat, depth = false, linear = false } = {}) {
  const filter = linear ? THREE.LinearFilter : THREE.NearestFilter;
  return new THREE.WebGLRenderTarget(width, height, { type, format, depthBuffer: depth, minFilter: filter, magFilter: filter, generateMipmaps: false });
}

function pass(fragmentShader, uniforms, extra = {}) {
  return new FullScreenQuad(new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VS, fragmentShader, uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending, ...extra,
  }));
}

/**
 * Draw with mipmapped lookups into the path tracer's texture array, which has no mipmaps: its
 * fullscreen shader would pick blurry levels from meaningless derivatives. The levels are made in
 * place and only this draw filters with them; afterwards the array samples its base level again,
 * so the path tracer sees exactly what it did before.
 */
function withMipmaps(renderer, texture, draw) {
  const gl = renderer.getContext();
  const handle = renderer.properties.get(texture)?.__webglTexture;
  const aniso = renderer.extensions.get('EXT_texture_filter_anisotropic');
  const set = (min, anisotropy) => {
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, handle);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, min);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT, anisotropy);
    renderer.resetState();
  };
  if (!handle) {
    draw();
    return;
  }
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, handle);
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  set(gl.LINEAR_MIPMAP_LINEAR, 4);
  try {
    draw();
  } finally {
    set(gl.LINEAR, 1);
  }
}

/**
 * The passes after path tracing: guide buffers (albedo, normal and depth), per-pixel noise
 * tracking, the denoiser, bloom and output to the canvas.
 */
function createPost(renderer, pt, geometry, camera, width, height, exposure) {
  const ptMaterial = pt._pathTracer.material;
  const albedo = target(width, height, { depth: true });
  const guide = target(width, height, { type: THREE.FloatType, depth: true });
  const moments = [0, 1].map(() => target(width, height, { type: THREE.FloatType, format: THREE.RGFormat }));
  const illum = [0, 1].map(() => target(width, height));
  const hdr = target(width, height, { linear: true });
  const targets = [albedo, guide, ...moments, ...illum, hdr];

  // The merged scene geometry is in world space; give its color and material index attributes
  // names of their own so they cannot clash with three's built-in declarations.
  geometry.setAttribute('photoColor', geometry.attributes.color);
  geometry.setAttribute('photoMaterial', geometry.attributes.materialIndex);
  const guideMaterial = (defines) => new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: GUIDE_VS, fragmentShader: GUIDE_FS, defines, side: THREE.DoubleSide,
    uniforms: { materials: { value: ptMaterial.materials }, textures: { value: ptMaterial.textures }, jitter: { value: new THREE.Vector2() } },
  });
  // Each jittered albedo pass adds only the nearest surface: a depth prepass, then an equal test.
  const depthMaterial = guideMaterial({ ALBEDO: 1 });
  depthMaterial.colorWrite = false;
  const albedoMaterial = guideMaterial({ ALBEDO: 1 });
  Object.assign(albedoMaterial, {
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
    depthFunc: THREE.EqualDepth, depthWrite: false,
  });
  const guideMat = guideMaterial({});
  const mesh = new THREE.Mesh(geometry, guideMat);
  mesh.frustumCulled = false;
  const guideScene = new THREE.Scene();
  guideScene.add(mesh);

  const common = () => ({ invProjection: { value: camera.projectionMatrixInverse }, size: { value: new THREE.Vector2(width, height) } });
  const momentsPass = pass(MOMENTS_FS, { tMean: { value: null }, tPrev: { value: null }, n: { value: 1 } });
  const preparePass = pass(PREPARE_FS, { ...common(), tColor: { value: null }, tAlbedo: { value: albedo.texture }, tGuide: { value: guide.texture }, tMoments: { value: null }, n: { value: 1 } });
  const atrousPass = pass(ATROUS_FS, { ...common(), tIllum: { value: null }, tGuide: { value: guide.texture }, stepSize: { value: 1 }, sigmaL: { value: 4 } });
  const remodPass = pass(REMODULATE_FS, { ...common(), tIllum: { value: null }, tColor: { value: null }, tAlbedo: { value: albedo.texture }, tGuide: { value: guide.texture }, edgeKeep: { value: 0 } });
  const long = Math.max(width, height);
  const outputPass = pass(OUTPUT_FS, { tHDR: { value: hdr.texture }, aspect: { value: new THREE.Vector2(width / long, height / long) }, vignette: { value: VIGNETTE } }, { toneMapped: true });
  const passes = [momentsPass, preparePass, atrousPass, remodPass, outputPass];
  const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), BLOOM.strength, BLOOM.radius, BLOOM.threshold / exposure);
  bloom.highPassUniforms.smoothWidth.value = BLOOM.knee / exposure;
  let current = 0;
  let denoisedAt = 0; // the sample count hdr holds, 0 when stale

  const draw = (quad, rt) => {
    renderer.setRenderTarget(rt);
    quad.render(renderer);
  };

  return {
    /** Albedo averaged over sub-pixel offsets like the path traced pixels, then normals and depth. */
    renderGuides() {
      withMipmaps(renderer, ptMaterial.textures, () => this.drawGuides());
    },

    drawGuides() {
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(albedo);
      renderer.clear(true, true, false);
      for (const [x, y] of JITTER) {
        renderer.clear(false, true, false);
        for (const m of [depthMaterial, albedoMaterial]) {
          m.uniforms.jitter.value.set((2 * x) / width, (2 * y) / height);
          mesh.material = m;
          renderer.render(guideScene, camera);
        }
      }
      mesh.material = guideMat;
      renderer.setRenderTarget(guide);
      renderer.clear(true, true, false);
      renderer.render(guideScene, camera);
      for (const rt of moments) {
        renderer.setRenderTarget(rt);
        renderer.clear(true, false, false);
      }
      renderer.setRenderTarget(null);
      renderer.autoClear = autoClear;
    },

    addSample(n) {
      denoisedAt = 0;
      const u = momentsPass.material.uniforms;
      u.tMean.value = pt.target.texture;
      u.tPrev.value = moments[current].texture;
      u.n.value = n;
      draw(momentsPass, moments[1 - current]);
      current = 1 - current;
      renderer.setRenderTarget(null);
    },

    /** Expose the photo by e from now on (the output pass and the bloom thresholds). */
    setExposure(e) {
      renderer.toneMappingExposure = e;
      bloom.threshold = BLOOM.threshold / e;
      bloom.highPassUniforms.smoothWidth.value = BLOOM.knee / e;
    },

    /** Denoise what has accumulated after n samples and draw it to the canvas. */
    compose(n) {
      this.denoise(n);
      bloom.render(renderer, null, hdr, 0, false);
      draw(outputPass, null);
    },

    /**
     * Median luminance of the denoised image after n samples. The raw accumulation is no use for
     * this early on: with few samples most pixels are darker than they will settle and a few far
     * brighter, so its median reads about a stop low.
     */
    meter(n) {
      this.denoise(n);
      return postfx.medianLuminance?.(renderer, hdr.texture) ?? null;
    },

    /** The denoised HDR image after n samples, into hdr (once per sample count). */
    denoise(n) {
      if (denoisedAt === n) return;
      denoisedAt = n;
      const color = pt.target.texture;
      const pu = preparePass.material.uniforms;
      pu.tColor.value = color;
      pu.tMoments.value = moments[current].texture;
      pu.n.value = n;
      draw(preparePass, illum[0]);
      const steps = n < 48 ? 5 : n < 160 ? 4 : 3;
      let src = 0;
      for (let i = 0; i < steps; i++) {
        const au = atrousPass.material.uniforms;
        au.tIllum.value = illum[src].texture;
        au.stepSize.value = 1 << i;
        draw(atrousPass, illum[1 - src]);
        src = 1 - src;
      }
      const ru = remodPass.material.uniforms;
      ru.tIllum.value = illum[src].texture;
      ru.tColor.value = color;
      ru.edgeKeep.value = Math.min(0.6, n / 512);
      draw(remodPass, hdr);
    },

    dispose() {
      for (const rt of targets) rt.dispose();
      for (const q of passes) {
        q.material.dispose();
        q.dispose();
      }
      depthMaterial.dispose();
      albedoMaterial.dispose();
      guideMat.dispose();
      bloom.dispose();
      geometry.deleteAttribute('photoColor');
      geometry.deleteAttribute('photoMaterial');
    },
  };
}
