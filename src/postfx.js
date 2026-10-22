// Post-processing for the walkthrough, tuned for architectural interiors: ground-truth ambient
// occlusion (GTAO), a subtle bloom on very bright windows and fixtures, a scene-linear color grade,
// AgX tone mapping and sRGB in OutputPass, then SMAA on the display image. Contract: docs/architecture.md.
//
// Color pipeline: RenderPass writes scene-linear HDR (three applies no tone mapping when rendering
// into a render target), AO, bloom and the grade work in that linear space, OutputPass applies
// renderer.toneMapping and toneMappingExposure exactly once plus the sRGB transfer, and SMAA runs
// last on display values, where its edge thresholds are meant to work.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

export const QUALITIES = ['high', 'balanced', 'fast'];

/** Per-level settings. AO radius, thickness and the denoise plane tolerance are meters. */
const LEVELS = {
  high: {
    aoScale: 1,
    ao: { radius: 0.65, distanceExponent: 1.6, thickness: 1, scale: 1.7, samples: 16, distanceFallOff: 1 },
    denoise: { depthPhi: 0.15, normalPhi: 8 },
    bloom: true,
  },
  balanced: {
    aoScale: 0.5,
    ao: { radius: 0.65, distanceExponent: 1.6, thickness: 1, scale: 1.7, samples: 8, distanceFallOff: 1 },
    denoise: { depthPhi: 0.15, normalPhi: 8 },
    bloom: false,
  },
};

const AO_INTENSITY = 1;
// AO is low frequency: past this many AO pixels per CSS pixel it is rendered at reduced resolution.
const AO_DENSITY = 1.25;
// Bloom picks up only what is far brighter than paper white once exposed (AgX maps 3 to about 96 percent).
const BLOOM = { strength: 0.16, radius: 0.45, threshold: 3, knee: 2 };

// Values are in exposed scene-linear units (after toneMappingExposure). AgX spans about 16 stops,
// far more than a daylit interior, so on its own it reads flat and grey; the log-space contrast and
// toe below were fitted so lit walls and floors keep their brightness while shadows regain depth
// without crushing (deep shadow about 14 percent, a white wall about 88 percent).
const GRADE = {
  balance: [1.04, 1, 0.94], // slight warmth, normalized below so it never changes brightness
  contrast: 1.5, // log-space contrast around the pivot
  pivot: 0.75, // a lit wall: contrast turns around it, so whites hold
  toe: 0.012, // flare-like floor that keeps the deepest shadows open
  saturation: 1.08,
  vignette: 0.05, // barely there: about 3 percent at the far corners
};

const LUMA = new THREE.Vector3(0.2126, 0.7152, 0.0722);

const glsl = (v) => (Number.isInteger(v) ? `${v}.0` : String(v));
const balance = () => {
  const b = new THREE.Vector3(...GRADE.balance);
  return b.multiplyScalar(1 / b.dot(LUMA));
};

/**
 * The same grade folded into three's CustomToneMapping slot, followed by AgX, for frames drawn
 * without post-processing ('fast'), so every level shares one tone curve. No vignette here.
 */
function installGradedToneMapping() {
  const stub = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
  const chunk = THREE.ShaderChunk.tonemapping_pars_fragment;
  if (chunk.includes('InteriorGradeToneMapping') || !chunk.includes(stub)) return;
  const b = balance();
  THREE.ShaderChunk.tonemapping_pars_fragment = chunk.replace(stub, /* glsl */`
// InteriorGradeToneMapping: the walkthrough grade (src/postfx.js), then AgX.
vec3 CustomToneMapping( vec3 color ) {
	vec3 c = max( color, vec3( 0.0 ) ) * toneMappingExposure * vec3( ${glsl(b.x)}, ${glsl(b.y)}, ${glsl(b.z)} );
	float y = max( dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-7 );
	float yc = ${glsl(GRADE.pivot)} * pow( y / ${glsl(GRADE.pivot)}, ${glsl(GRADE.contrast)} ) + ${glsl(GRADE.toe)};
	c *= yc / y;
	c = max( mix( vec3( yc ), c, ${glsl(GRADE.saturation)} ), vec3( 0.0 ) );
	return AgXToneMapping( c / toneMappingExposure );
}`);
}

/**
 * Give another renderer (the photo renderer, for example) the walkthrough's look when it draws
 * straight to the screen: the graded AgX curve as THREE.CustomToneMapping. Keep its exposure equal
 * to the walkthrough renderer's toneMappingExposure.
 */
export function useGradedToneMapping(renderer) {
  installGradedToneMapping();
  renderer.toneMapping = THREE.CustomToneMapping;
}

const GradeShader = {
  name: 'InteriorGradeShader',
  uniforms: {
    tDiffuse: { value: null },
    balance: { value: new THREE.Vector3() },
    pivot: { value: GRADE.pivot },
    toe: { value: GRADE.toe },
    contrast: { value: GRADE.contrast },
    saturation: { value: GRADE.saturation },
    vignette: { value: GRADE.vignette },
    aspect: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec3 balance;
    uniform float pivot;
    uniform float toe;
    uniform float contrast;
    uniform float saturation;
    uniform float vignette;
    uniform vec2 aspect;
    varying vec2 vUv;
    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 c = max(texel.rgb, vec3(0.0)) * balance;
      // Contrast on luminance in log space, so hue and saturation hold and nothing clips here.
      float y = max(dot(c, LUMA), 1e-7);
      float yc = pivot * pow(y / pivot, contrast) + toe;
      c *= yc / y;
      c = max(mix(vec3(yc), c, saturation), vec3(0.0));
      // Gentle lens falloff, like a real wide lens, never a dark frame.
      vec2 d = (vUv - 0.5) * aspect;
      c *= 1.0 - vignette * smoothstep(0.15, 0.55, dot(d, d));
      gl_FragColor = vec4(c, texel.a);
    }`,
};

/** Rebuilds view-space normals from the scene depth, so AO needs no second geometry pass. */
const NormalFromDepthShader = {
  uniforms: {
    tDepth: { value: null },
    cameraProjectionMatrixInverse: { value: new THREE.Matrix4() },
  },
  vertexShader: GradeShader.vertexShader,
  fragmentShader: /* glsl */`
    uniform highp sampler2D tDepth;
    uniform mat4 cameraProjectionMatrixInverse;
    varying vec2 vUv;
    #include <packing>
    vec3 viewAt(const in vec2 uv, const in float depth) {
      vec4 p = cameraProjectionMatrixInverse * vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);
      return p.xyz / p.w;
    }
    float depthAt(const in ivec2 p) {
      return texelFetch(tDepth, p, 0).x;
    }
    void main() {
      ivec2 size = textureSize(tDepth, 0);
      ivec2 p = clamp(ivec2(vUv * vec2(size)), ivec2(2), size - 3);
      vec2 texel = 1.0 / vec2(size);
      vec2 uv = (vec2(p) + 0.5) * texel;
      float c0 = depthAt(p);
      float l1 = depthAt(p - ivec2(1, 0)), l2 = depthAt(p - ivec2(2, 0));
      float r1 = depthAt(p + ivec2(1, 0)), r2 = depthAt(p + ivec2(2, 0));
      float b1 = depthAt(p - ivec2(0, 1)), b2 = depthAt(p - ivec2(0, 2));
      float t1 = depthAt(p + ivec2(0, 1)), t2 = depthAt(p + ivec2(0, 2));
      // Take each derivative from the side that continues the surface, so edges stay clean.
      float dl = abs((2.0 * l1 - l2) - c0), dr = abs((2.0 * r1 - r2) - c0);
      float db = abs((2.0 * b1 - b2) - c0), dt = abs((2.0 * t1 - t2) - c0);
      vec3 ce = viewAt(uv, c0);
      vec3 dpdx = dl < dr ? ce - viewAt(uv - vec2(texel.x, 0.0), l1) : viewAt(uv + vec2(texel.x, 0.0), r1) - ce;
      vec3 dpdy = db < dt ? ce - viewAt(uv - vec2(0.0, texel.y), b1) : viewAt(uv + vec2(0.0, texel.y), t1) - ce;
      gl_FragColor = vec4(packNormalToRGB(normalize(cross(dpdx, dpdy))), 1.0);
    }`,
};

/**
 * Cross-bilateral 5 x 5 box filter for the raw GTAO. GTAO rotates its sample directions with a 5 x 5
 * magic square, so a box of exactly that size averages every rotation and cancels the pattern on
 * flat surfaces, where a randomly rotated kernel leaves grain. Neighbors off the pixel's plane
 * (depthPhi, meters) or facing elsewhere (normalPhi) are left out, so AO never bleeds across edges.
 */
const BoxDenoiseShader = {
  uniforms: {
    tDiffuse: { value: null },
    tNormal: { value: null },
    tDepth: { value: null },
    resolution: { value: new THREE.Vector2() },
    cameraProjectionMatrixInverse: { value: new THREE.Matrix4() },
    depthPhi: { value: 0.15 },
    normalPhi: { value: 8 },
  },
  vertexShader: GradeShader.vertexShader,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform highp sampler2D tNormal;
    uniform highp sampler2D tDepth;
    uniform vec2 resolution;
    uniform mat4 cameraProjectionMatrixInverse;
    uniform float depthPhi;
    uniform float normalPhi;
    varying vec2 vUv;
    #include <packing>
    vec3 viewAt(const in vec2 uv, const in float depth) {
      vec4 p = cameraProjectionMatrixInverse * vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);
      return p.xyz / p.w;
    }
    void main() {
      ivec2 size = ivec2(resolution);
      ivec2 c = ivec2(vUv * resolution);
      vec2 uv0 = (vec2(c) + 0.5) / resolution;
      float depth = textureLod(tDepth, uv0, 0.0).x;
      if (depth >= 1.0) {
        gl_FragColor = vec4(1.0);
        return;
      }
      vec3 n = unpackRGBToNormal(texelFetch(tNormal, c, 0).rgb);
      vec3 p = viewAt(uv0, depth);
      // Plane tolerance grows with distance, where depth steps between pixels are larger.
      float tolerance = depthPhi * (1.0 + 0.05 * abs(p.z));
      float sum = 0.0, weight = 0.0;
      for (int y = -2; y <= 2; y++) {
        for (int x = -2; x <= 2; x++) {
          ivec2 q = clamp(c + ivec2(x, y), ivec2(0), size - 1);
          vec2 uv = (vec2(q) + 0.5) / resolution;
          float d = textureLod(tDepth, uv, 0.0).x;
          vec3 nq = unpackRGBToNormal(texelFetch(tNormal, q, 0).rgb);
          float plane = abs(dot(viewAt(uv, d) - p, n));
          float w = max(0.0, 1.0 - plane / tolerance) * pow(max(dot(n, nq), 0.0), normalPhi);
          sum += texelFetch(tDiffuse, q, 0).r * w;
          weight += w;
        }
      }
      gl_FragColor = vec4(vec3(weight > 1e-4 ? sum / weight : texelFetch(tDiffuse, c, 0).r), 1.0);
    }`,
};

/**
 * Multiplies the AO into the image. When AO runs below full resolution, each pixel takes the four
 * nearest AO texels weighted by how well they share its plane and facing (joint bilateral
 * upsampling), so creases and silhouettes stay crisp instead of stair-stepped.
 */
const AOUpsampleShader = {
  uniforms: {
    tDiffuse: { value: null },
    tNormal: { value: null },
    tDepth: { value: null },
    aoResolution: { value: new THREE.Vector2(1, 1) },
    cameraProjectionMatrixInverse: { value: new THREE.Matrix4() },
    intensity: { value: 1 },
  },
  vertexShader: GradeShader.vertexShader,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform highp sampler2D tNormal;
    uniform highp sampler2D tDepth;
    uniform vec2 aoResolution;
    uniform mat4 cameraProjectionMatrixInverse;
    uniform float intensity;
    varying vec2 vUv;
    #include <packing>
    vec3 viewAt(const in vec2 uv, const in float depth) {
      vec4 p = cameraProjectionMatrixInverse * vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);
      return p.xyz / p.w;
    }
    void main() {
      float depth = textureLod(tDepth, vUv, 0.0).x;
      if (depth >= 1.0) {
        gl_FragColor = vec4(1.0);
        return;
      }
      vec3 p = viewAt(vUv, depth);
      vec3 n = normalize(cross(dFdx(p), dFdy(p)));
      float tolerance = 0.04 * (1.0 + 0.05 * abs(p.z));
      ivec2 last = ivec2(aoResolution) - 1;
      vec2 st = vUv * aoResolution - 0.5;
      vec2 f = fract(st);
      ivec2 i0 = ivec2(floor(st));
      float sum = 0.0, weight = 0.0, plain = 0.0;
      for (int k = 0; k < 4; k++) {
        ivec2 o = ivec2(k & 1, k >> 1);
        ivec2 q = clamp(i0 + o, ivec2(0), last);
        vec2 quv = (vec2(q) + 0.5) / aoResolution;
        float bilinear = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
        float ao = texelFetch(tDiffuse, q, 0).r;
        vec3 nq = unpackRGBToNormal(texelFetch(tNormal, q, 0).rgb);
        float plane = abs(dot(viewAt(quv, textureLod(tDepth, quv, 0.0).x) - p, n));
        float w = bilinear * max(0.0, 1.0 - plane / tolerance) * pow(max(dot(n, nq), 0.0), 8.0);
        sum += ao * w;
        weight += w;
        plain += ao * bilinear;
      }
      float ao = weight > 1e-4 ? sum / weight : plain;
      gl_FragColor = vec4(vec3(mix(1.0, ao, intensity)), 1.0);
    }`,
};

/**
 * GTAO that reads the depth the scene pass already wrote instead of rendering the scene again with
 * a normal material. That also keeps glass, overlays and alpha-tested cutouts out of the AO, so
 * windows get no dark fringes. Runs at resolutionScale times the composer resolution.
 */
class InteriorAOPass extends GTAOPass {
  constructor(scene, camera) {
    super(scene, camera, 1, 1);
    this.resolutionScale = 1;
    this._renderGBuffer = false;
    this.normalTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
    });
    this.normalMaterialFromDepth = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(NormalFromDepthShader.uniforms),
      vertexShader: NormalFromDepthShader.vertexShader,
      fragmentShader: NormalFromDepthShader.fragmentShader,
      blending: THREE.NoBlending, depthTest: false, depthWrite: false,
    });
    this.gtaoMaterial.defines.NORMAL_VECTOR_TYPE = 1;
    this.gtaoMaterial.defines.DEPTH_SWIZZLING = 'x';
    this.gtaoMaterial.uniforms.tNormal.value = this.normalTarget.texture;
    this.gtaoMaterial.needsUpdate = true;
    // The stock Poisson denoiser is replaced; GTAOPass.render drives whatever pdMaterial is.
    this.pdMaterial.dispose();
    this.pdMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(BoxDenoiseShader.uniforms),
      vertexShader: BoxDenoiseShader.vertexShader,
      fragmentShader: BoxDenoiseShader.fragmentShader,
      blending: THREE.NoBlending, depthTest: false, depthWrite: false,
    });
    this.pdMaterial.uniforms.tDiffuse.value = this.gtaoRenderTarget.texture;
    this.pdMaterial.uniforms.tNormal.value = this.normalTarget.texture;
    // Same multiply blending as the stock composite, with depth-aware upsampling.
    const blend = this.blendMaterial;
    this.blendMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(AOUpsampleShader.uniforms),
      vertexShader: AOUpsampleShader.vertexShader,
      fragmentShader: AOUpsampleShader.fragmentShader,
      transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.DstAlphaFactor, blendDstAlpha: THREE.ZeroFactor,
    });
    blend.dispose();
    this.blendMaterial.uniforms.tNormal.value = this.normalTarget.texture;
    this.blendIntensity = AO_INTENSITY;
  }

  updatePdMaterial({ depthPhi, normalPhi } = {}) {
    const u = this.pdMaterial.uniforms;
    if (depthPhi !== undefined) u.depthPhi.value = depthPhi;
    if (normalPhi !== undefined) u.normalPhi.value = normalPhi;
  }

  setDepth(texture) {
    if (this.depthTexture === texture) return;
    this.depthTexture = texture;
    this.gtaoMaterial.uniforms.tDepth.value = texture;
    this.pdMaterial.uniforms.tDepth.value = texture;
    this.blendMaterial.uniforms.tDepth.value = texture;
    this.normalMaterialFromDepth.uniforms.tDepth.value = texture;
  }

  setSize(width, height) {
    const k = this.resolutionScale;
    const w = Math.max(1, Math.round(width * k)), h = Math.max(1, Math.round(height * k));
    super.setSize(w, h);
    this.normalTarget.setSize(w, h);
  }

  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    const inverse = this.camera.projectionMatrixInverse;
    this.normalMaterialFromDepth.uniforms.cameraProjectionMatrixInverse.value.copy(inverse);
    this.blendMaterial.uniforms.cameraProjectionMatrixInverse.value.copy(inverse);
    this.blendMaterial.uniforms.aoResolution.value.set(this.width, this.height);
    this.renderPass(renderer, this.normalMaterialFromDepth, this.normalTarget);
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }

  dispose() {
    super.dispose();
    this.gtaoMaterial.dispose();
    this.blendMaterial.dispose();
    this.normalTarget.dispose();
    this.normalMaterialFromDepth.dispose();
  }
}

/** OutputPass plus half-step dithering after the sRGB transfer, so soft wall gradients never band. */
function ditheredOutputPass() {
  const pass = new OutputPass();
  pass.material.fragmentShader = pass.material.fragmentShader.replace(/}\s*$/, `
      gl_FragColor.rgb += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
    }`);
  return pass;
}

function loaded(texture) {
  const img = texture.image;
  if (!img || (img.complete && img.naturalWidth)) return Promise.resolve();
  return new Promise((resolve) => {
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', resolve, { once: true });
  });
}

/**
 * createPostFX(renderer, scene, camera, { quality, onReady }) ->
 *   { render(camera?), setSize(width, height, pixelRatio), setQuality(q), quality, camera,
 *     setSceneBounds(box3 | null), ready, dispose() }
 * 'fast' renders straight to the canvas. The passes are created the first time another level
 * renders, and their buffers are released while 'fast' is in use. render(camera) draws with that
 * camera (default: api.camera). ready resolves, and onReady() runs, once the SMAA lookup textures
 * are decoded: frames drawn before then are not anti-aliased, so draw one more.
 */
export function createPostFX(renderer, scene, camera, { quality = 'high', onReady = null } = {}) {
  const size = { width: 1, height: 1, ratio: renderer.getPixelRatio() };
  let level = checkQuality(quality);
  let chain = null;
  let applied = null; // { width, height, ratio, level } the chain is set up for
  let clipBox = null;
  let composerRatio = 0; // pixel ratio last given to the composer
  let disposed = false;
  let ready = Promise.resolve();
  installGradedToneMapping();
  applyToneMapping();

  function checkQuality(q) {
    if (!QUALITIES.includes(q)) throw new Error(`Unknown post-processing quality "${q}"`);
    return q;
  }

  function createChain() {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    target.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    target.texture.name = 'PostFX.scene';
    const composer = new EffectComposer(renderer, target);
    // RenderTarget.clone() in r160 shares the depth texture's source, which would put both buffers
    // on one GL depth texture; AO reads one buffer's depth while drawing into the other.
    composer.renderTarget2.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    const renderPass = new RenderPass(scene, camera);
    const ao = new InteriorAOPass(scene, camera);
    ao.setSceneClipBox(clipBox);
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
    const grade = new ShaderPass(GradeShader);
    grade.uniforms.balance.value.copy(balance());
    const output = ditheredOutputPass();
    const smaa = new SMAAPass(1, 1);
    const passes = [renderPass, ao, bloom, grade, output, smaa];
    for (const pass of passes) composer.addPass(pass);
    ready = Promise.all([loaded(smaa.areaTexture), loaded(smaa.searchTexture)]).then(() => {
      if (!disposed) onReady?.();
    });
    return { composer, passes, renderPass, ao, bloom, grade, output, smaa };
  }

  /** Bring the chain in line with the size and level. Resizing only drops GPU buffers; they are reallocated on use. */
  function sync() {
    if (!chain) chain = createChain();
    const a = applied;
    const { composer, ao, bloom, grade } = chain;
    const levelChanged = !a || a.level !== level;
    if (levelChanged) {
      const s = LEVELS[level];
      ao.updateGtaoMaterial(s.ao);
      ao.updatePdMaterial(s.denoise);
      bloom.enabled = s.bloom;
    }
    if (levelChanged || a.width !== size.width || a.height !== size.height || a.ratio !== size.ratio) {
      ao.resolutionScale = LEVELS[level].aoScale * Math.min(1, AO_DENSITY / size.ratio);
      if (composerRatio !== size.ratio) composer.setPixelRatio((composerRatio = size.ratio));
      composer.setSize(size.width, size.height);
      const long = Math.max(size.width, size.height);
      grade.uniforms.aspect.value.set(size.width / long, size.height / long);
      applied = { width: size.width, height: size.height, ratio: size.ratio, level };
    }
  }

  /**
   * AgX in OutputPass after the grade pass, or the same grade and AgX inside the materials when
   * drawing straight to the canvas. Either way the curve runs exactly once per pixel.
   */
  function applyToneMapping() {
    renderer.toneMapping = level === 'fast' ? THREE.CustomToneMapping : THREE.AgXToneMapping;
  }

  /** Free the full-size buffers while 'fast' is in use; shaders stay compiled for a quick switch back. */
  function release() {
    if (!chain || !applied) return;
    chain.composer.setPixelRatio((composerRatio = 1));
    chain.composer.setSize(1, 1);
    applied = null;
  }

  const api = {
    camera,
    /** Starts loading what the first post-processed frame needs, so a capture can wait for it. */
    get ready() {
      if (level !== 'fast' && !chain && !disposed) chain = createChain();
      return ready;
    },
    get quality() { return level; },

    /** The passes in use ({ composer, renderPass, ao, bloom, grade, ... }), or null in 'fast'. For dev tools and tests. */
    get passes() { return level === 'fast' ? null : chain; },

    /** Draw one frame. Never renders on its own: the caller decides when a frame is needed. */
    render(cam = api.camera) {
      if (disposed) return;
      if (level === 'fast') {
        renderer.setRenderTarget(null);
        renderer.render(scene, cam);
        return;
      }
      sync();
      const { composer, renderPass, ao, bloom, grade } = chain;
      renderPass.camera = ao.camera = cam;
      // The scene pass draws into the composer's read buffer, and AO samples that buffer's depth.
      ao.setDepth(composer.readBuffer.depthTexture);
      // Thresholds are set in exposed units so they hold if the exposure is recalibrated.
      const exposure = renderer.toneMappingExposure || 1;
      bloom.threshold = BLOOM.threshold / exposure;
      bloom.highPassUniforms.smoothWidth.value = BLOOM.knee / exposure;
      grade.uniforms.pivot.value = GRADE.pivot / exposure;
      grade.uniforms.toe.value = GRADE.toe / exposure;
      // Count the whole post-processed frame in renderer.info, not just its last pass.
      const info = renderer.info, autoReset = info.autoReset;
      info.autoReset = false;
      info.reset();
      try {
        composer.render(0);
      } finally {
        info.autoReset = autoReset;
      }
    },

    /** width and height in CSS pixels, as given to renderer.setSize. */
    setSize(width, height, pixelRatio = renderer.getPixelRatio()) {
      size.width = Math.max(1, Math.round(width));
      size.height = Math.max(1, Math.round(height));
      size.ratio = pixelRatio;
    },

    setQuality(q) {
      level = checkQuality(q);
      applyToneMapping();
      if (level === 'fast') release();
    },

    /** Limit AO to the building (a Box3 in world space), so the sky and far exterior skip it. */
    setSceneBounds(box) {
      clipBox = box ? box.clone() : null;
      chain?.ao.setSceneClipBox(clipBox);
    },

    dispose() {
      disposed = true;
      if (!chain) return;
      for (const pass of chain.passes) pass.dispose();
      chain.composer.dispose();
      chain = null;
      applied = null;
    },
  };
  return api;
}
