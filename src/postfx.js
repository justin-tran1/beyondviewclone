// Post-processing for the walkthrough, tuned for architectural interiors: ground-truth ambient
// occlusion (GTAO), a subtle bloom on very bright windows and fixtures, a scene-linear color grade,
// AgX tone mapping and sRGB in OutputPass, then SMAA on the display image. Contract: docs/architecture.md.
//
// Color pipeline: RenderPass writes scene-linear HDR (three applies no tone mapping when rendering
// into a render target), AO, bloom and the grade work in that linear space, OutputPass applies
// renderer.toneMapping and toneMappingExposure exactly once plus the sRGB transfer, and SMAA runs
// last on display values, where its edge thresholds are meant to work. The scene itself is drawn
// multisampled (LEVELS.msaa) and resolved into the chain, so edges thinner than a pixel, such as
// trim, bevel highlights and glass mullions, draw as lines rather than dotted runs SMAA cannot join.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';

export const QUALITIES = ['high', 'balanced', 'fast'];

/**
 * Per-level settings. msaa is the scene pass's sample count. AO radius and thickness are meters:
 * thickness is the view-space depth gap within which a sample still counts as an occluder, fading
 * out over its upper half, so a sofa a meter from the wall or a stool in front of a booth's back
 * panel leaves no dark outline on it while contact shading stays. denoise.depthPhi is the plane
 * tolerance per meter (see onPlane).
 */
const LEVELS = {
  high: {
    msaa: 4,
    aoScale: 1,
    ao: { radius: 0.65, distanceExponent: 1.6, thickness: 0.35, scale: 1.7, samples: 16, distanceFallOff: 1 },
    denoise: { depthPhi: 0.05, normalPhi: 8 },
    bloom: true,
  },
  balanced: {
    msaa: 2,
    aoScale: 0.5,
    ao: { radius: 0.65, distanceExponent: 1.6, thickness: 0.35, scale: 1.7, samples: 8, distanceFallOff: 1 },
    denoise: { depthPhi: 0.05, normalPhi: 8 },
    bloom: false,
  },
};

const AO_INTENSITY = 1;
// From this pixel ratio pixels are small enough that 2x MSAA joins thin edges; 4x would cost a
// lot of memory (about 60 bytes per pixel for the scene pass) for little visible gain.
const MSAA_DENSE = 1.75;
// AO is low frequency: past this many AO pixels per CSS pixel it is rendered at reduced resolution.
const AO_DENSITY = 1.25;
// Bloom picks up only what is far brighter than paper white once exposed (AgX maps 3 to about 96 percent).
// ceiling caps each pixel before the bright pass: fixture lenses and the view out of the windows
// read 8 to 14, while a specular pinpoint can reach the half-float maximum.
const BLOOM = { strength: 0.16, radius: 0.45, threshold: 3, knee: 2, ceiling: 16 };

// Values are in exposed scene-linear units (after toneMappingExposure). AgX spans about 16 stops,
// far more than a daylit interior, so on its own it reads flat and grey; the log-space contrast and
// toe below were fitted so lit walls and floors keep their brightness while shadows regain depth
// without crushing. Above the pivot the contrast rolls off (smoothly, its slope continuous) toward
// `shoulder` stops, so sun patches on pale floors and the view through windows keep their texture
// instead of clipping. 8-bit display values: deep shadow (0.02) 29, a lit white wall (0.6 to 1)
// 178 to 207, a sun patch on a pale floor (4 to 8) 245 to 249, the view out of a window (20) 252.
const GRADE = {
  balance: [1.04, 1, 0.94], // slight warmth, normalized below so it never changes brightness
  contrast: 1.5, // log-space contrast around the pivot
  pivot: 0.75, // a lit wall: contrast turns around it, so whites hold
  shoulder: 4.5, // stops above the pivot that highlights approach (AgX white is about 4.4 above)
  toe: 0.012, // flare-like floor that keeps the deepest shadows open
  saturation: 1.08,
  vignette: 0.05, // barely there: about 3 percent at the far corners
};

// The grade's curve on luminance, shared by the post pass and the 'fast' tone mapping:
// x = contrast * log2(y / pivot), above the pivot shoulder * tanh(x / shoulder).
const GRADE_CURVE = /* glsl */`
float interiorGradeLuma( float y, float pivot, float contrast, float shoulder, float toe ) {
	float x = contrast * log2( y / pivot );
	if ( x > 0.0 ) {
		// tanh through exp2, kept finite for the brightest sky and fixture texels.
		float t = exp2( 2.8853901 * min( x / shoulder, 8.0 ) );
		x = shoulder * ( t - 1.0 ) / ( t + 1.0 );
	}
	return pivot * exp2( x ) + toe;
}`;

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
${GRADE_CURVE}
vec3 CustomToneMapping( vec3 color ) {
	vec3 c = max( color, vec3( 0.0 ) ) * toneMappingExposure * vec3( ${glsl(b.x)}, ${glsl(b.y)}, ${glsl(b.z)} );
	float y = max( dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-7 );
	float yc = interiorGradeLuma( y, ${glsl(GRADE.pivot)}, ${glsl(GRADE.contrast)}, ${glsl(GRADE.shoulder)}, ${glsl(GRADE.toe)} );
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
    shoulder: { value: GRADE.shoulder },
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
    uniform float shoulder;
    uniform float saturation;
    uniform float vignette;
    uniform vec2 aspect;
    varying vec2 vUv;
    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
    ${GRADE_CURVE}
    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 c = max(texel.rgb, vec3(0.0)) * balance;
      // Contrast on luminance in log space, so hue and saturation hold and nothing clips here.
      float y = max(dot(c, LUMA), 1e-7);
      float yc = interiorGradeLuma(y, pivot, contrast, shoulder, toe);
      c *= yc / y;
      c = max(mix(vec3(yc), c, saturation), vec3(0.0));
      // Gentle lens falloff, like a real wide lens, never a dark frame.
      vec2 d = (vUv - 0.5) * aspect;
      c *= 1.0 - vignette * smoothstep(0.15, 0.55, dot(d, d));
      gl_FragColor = vec4(c, texel.a);
    }`,
};

// GLSL shared by the AO shaders (they declare tDepth and cameraProjectionMatrixInverse). The depth
// texture is unfiltered, so positions are rebuilt at the center of the texel whose depth they use:
// pairing another uv with that depth puts points on a grazing plane above or below it.
const DEPTH_GLSL = /* glsl */`
    vec3 viewAt(const in vec2 uv, const in float depth) {
      vec4 p = cameraProjectionMatrixInverse * vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);
      return p.xyz / p.w;
    }
    vec2 depthUv(const in vec2 uv) {
      vec2 size = vec2(textureSize(tDepth, 0));
      return (clamp(floor(uv * size), vec2(0.0), size - 1.0) + 0.5) / size;
    }
    float depthAt(const in ivec2 p) {
      return texelFetch(tDepth, p, 0).x;
    }
    // View normal at depth texel p, each derivative taken from the side that continues the surface,
    // so edges stay clean.
    vec3 normalAt(ivec2 p) {
      ivec2 size = textureSize(tDepth, 0);
      p = clamp(p, ivec2(2), size - 3);
      vec2 texel = 1.0 / vec2(size);
      vec2 uv = (vec2(p) + 0.5) * texel;
      float c0 = depthAt(p);
      float l1 = depthAt(p - ivec2(1, 0)), l2 = depthAt(p - ivec2(2, 0));
      float r1 = depthAt(p + ivec2(1, 0)), r2 = depthAt(p + ivec2(2, 0));
      float b1 = depthAt(p - ivec2(0, 1)), b2 = depthAt(p - ivec2(0, 2));
      float t1 = depthAt(p + ivec2(0, 1)), t2 = depthAt(p + ivec2(0, 2));
      float dl = abs((2.0 * l1 - l2) - c0), dr = abs((2.0 * r1 - r2) - c0);
      float db = abs((2.0 * b1 - b2) - c0), dt = abs((2.0 * t1 - t2) - c0);
      vec3 ce = viewAt(uv, c0);
      vec3 dpdx = dl < dr ? ce - viewAt(uv - vec2(texel.x, 0.0), l1) : viewAt(uv + vec2(texel.x, 0.0), r1) - ce;
      vec3 dpdy = db < dt ? ce - viewAt(uv - vec2(0.0, texel.y), b1) : viewAt(uv + vec2(0.0, texel.y), t1) - ce;
      return normalize(cross(dpdx, dpdy));
    }
    // 1 when q lies on the plane through p with normal n, falling to 0 at a tolerance that grows
    // with their distance (slope: normal error) and with depth (depth precision), so parallel faces
    // a centimeter apart, a drawer front under a worktop's edge, keep their own AO.
    float onPlane(const in vec3 p, const in vec3 n, const in vec3 q, const in float slope) {
      float tolerance = slope * length(q - p) + 0.002 * abs(p.z) + 1e-4;
      return max(0.0, 1.0 - abs(dot(q - p, n)) / tolerance);
    }`;

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
    ${DEPTH_GLSL}
    void main() {
      gl_FragColor = vec4(packNormalToRGB(normalAt(ivec2(vUv * vec2(textureSize(tDepth, 0))))), 1.0);
    }`,
};

/**
 * Cross-bilateral 5 x 5 box filter for the raw GTAO. GTAO rotates its sample directions with a 5 x 5
 * magic square, so a box of exactly that size averages every rotation and cancels the pattern on
 * flat surfaces, where a randomly rotated kernel leaves grain. Neighbors off the pixel's plane
 * (depthPhi: tolerance per meter between them, see onPlane) or facing elsewhere (normalPhi) are
 * left out, so AO never bleeds across silhouettes or outside edges. Inside corners (a wall meeting
 * the ceiling, a leg meeting the floor) are blended on purpose: occlusion is continuous there, and
 * the multisampled scene pass gives each crease pixel a color mixed from both faces, so AO taken
 * from one face alone stepped with the edge's pixel stairs into a dashed dark line.
 */
const BoxDenoiseShader = {
  uniforms: {
    tDiffuse: { value: null },
    tNormal: { value: null },
    tDepth: { value: null },
    resolution: { value: new THREE.Vector2() },
    cameraProjectionMatrixInverse: { value: new THREE.Matrix4() },
    depthPhi: { value: 0.05 },
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
    ${DEPTH_GLSL}
    void main() {
      ivec2 size = ivec2(resolution);
      ivec2 c = ivec2(vUv * resolution);
      vec2 uv0 = depthUv((vec2(c) + 0.5) / resolution);
      float depth = textureLod(tDepth, uv0, 0.0).x;
      if (depth >= 1.0) {
        gl_FragColor = vec4(1.0);
        return;
      }
      vec3 n = unpackRGBToNormal(texelFetch(tNormal, c, 0).rgb);
      vec3 p = viewAt(uv0, depth);
      // The size of one texel at this depth: the reach of an inside corner within the window.
      float foot = length(viewAt(uv0 + vec2(1.0 / resolution.x, 0.0), depth) - p);
      float sum = 0.0, weight = 0.0;
      for (int y = -2; y <= 2; y++) {
        for (int x = -2; x <= 2; x++) {
          ivec2 q = clamp(c + ivec2(x, y), ivec2(0), size - 1);
          vec2 uv = depthUv((vec2(q) + 0.5) / resolution);
          vec3 nq = unpackRGBToNormal(texelFetch(tNormal, q, 0).rgb);
          vec3 pq = viewAt(uv, textureLod(tDepth, uv, 0.0).x);
          float w = onPlane(p, n, pq, depthPhi) * pow(max(dot(n, nq), 0.0), normalPhi);
          // Inside corner: q is close, in front of p's plane, and p in front of q's.
          w = max(w, step(length(pq - p), 6.0 * foot) * step(0.0, dot(pq - p, n)) * step(0.0, dot(p - pq, nq)));
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
 * upsampling), so creases and silhouettes stay crisp instead of stair-stepped. A pixel none of them
 * matches (a part thinner than an AO texel) takes the one nearest its plane rather than a blend.
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
    ${DEPTH_GLSL}
    void main() {
      vec2 uv0 = depthUv(vUv);
      float depth = textureLod(tDepth, uv0, 0.0).x;
      if (depth >= 1.0) {
        gl_FragColor = vec4(1.0);
        return;
      }
      vec3 p = viewAt(uv0, depth);
      vec3 n = normalAt(ivec2(vUv * vec2(textureSize(tDepth, 0))));
      ivec2 last = ivec2(aoResolution) - 1;
      vec2 st = vUv * aoResolution - 0.5;
      vec2 f = fract(st);
      ivec2 i0 = ivec2(floor(st));
      float sum = 0.0, weight = 0.0, nearest = 1.0, gap = 1e9;
      for (int k = 0; k < 4; k++) {
        ivec2 o = ivec2(k & 1, k >> 1);
        ivec2 q = clamp(i0 + o, ivec2(0), last);
        vec2 quv = depthUv((vec2(q) + 0.5) / aoResolution);
        vec3 pq = viewAt(quv, textureLod(tDepth, quv, 0.0).x);
        float bilinear = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
        float ao = texelFetch(tDiffuse, q, 0).r;
        vec3 nq = unpackRGBToNormal(texelFetch(tNormal, q, 0).rgb);
        float w = bilinear * onPlane(p, n, pq, 0.03) * pow(max(dot(n, nq), 0.0), 8.0);
        sum += ao * w;
        weight += w;
        float d = abs(dot(pq - p, n));
        if (d < gap) {
          gap = d;
          nearest = ao;
        }
      }
      float ao = weight > 1e-4 ? sum / weight : nearest;
      gl_FragColor = vec4(vec3(mix(1.0, ao, intensity)), 1.0);
    }`,
};

/**
 * Point reconstruction for the stock GTAO shader (three r160), which pairs a sample's exact uv with
 * the depth of the texel around it. On a grazing plane that puts the point above or below the plane
 * by up to half a texel's depth step, and for the first, sub-texel steps the offset is a large angle:
 * false horizons that follow the sample rotation pattern, a regular grid of dark dots on large flat
 * tops and floors (worse below full resolution, where the pixel's own point is off too). Points are
 * rebuilt at the center of the texel whose depth they read, samples that land on the pixel's own
 * texel are skipped (they carry no horizon), and samples off screen count as open instead of
 * repeating the border.
 */
// Occlusion from a sample fades out over the upper half of the thickness, instead of stopping at a
// hard cutoff that draws a ring wherever an object stands exactly that far in front of a surface.
const GTAO_FADE = 'distanceFallOff) * (1. - smoothstep(0.5 * thickness, thickness, abs(viewDelta.z))));';

const GTAO_POINTS = /* glsl */`
		vec2 depthTexelUv(const in vec2 uv) {
			vec2 size = vec2(textureSize(tDepth, 0));
			return (clamp(floor(uv * size), vec2(0.0), size - 1.0) + 0.5) / size;
		}

		vec2 gtaoCenterUv;

		vec3 getSceneUvAndDepth(vec3 sampleViewPos) {
			vec4 sampleClipPos = cameraProjectionMatrix * vec4(sampleViewPos, 1.);
			vec2 sampleUv = sampleClipPos.xy / sampleClipPos.w * 0.5 + 0.5;
			if (any(lessThan(sampleUv, vec2(0.0))) || any(greaterThan(sampleUv, vec2(1.0)))) return vec3(sampleUv, 1.0);
			sampleUv = depthTexelUv(sampleUv);
			// A sample on the pixel's own texel says nothing about the horizon; depth 1 skips it.
			if (sampleUv == gtaoCenterUv) return vec3(sampleUv, 1.0);
			return vec3(sampleUv, getDepth(sampleUv));
		}`;

function patchGTAO(fs) {
  const out = fs
    .replace(/vec3 getSceneUvAndDepth\(vec3 sampleViewPos\) \{[\s\S]*?return vec3\(sampleUv, sampleSceneDepth\);\s*\}/, GTAO_POINTS)
    .replace('float depth = getDepth(vUv.xy);', 'vec2 centerUv = depthTexelUv(vUv);\n\t\t\tgtaoCenterUv = centerUv;\n\t\t\tfloat depth = getDepth(centerUv);')
    .replace('vec3 viewPos = getViewPosition(vUv, depth);', 'vec3 viewPos = getViewPosition(centerUv, depth);')
    .replaceAll('distanceFallOff));', GTAO_FADE);
  if (!out.includes('centerUv, depth') || !out.includes('depthTexelUv(sampleUv)') || out.split(GTAO_FADE).length !== 3) {
    console.warn('postfx: the GTAO shader changed, so its sample reconstruction and thickness fade were not patched');
    return fs;
  }
  return out;
}

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
    this.gtaoMaterial.fragmentShader = patchGTAO(this.gtaoMaterial.fragmentShader);
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

/**
 * RenderPass into a multisampled scene-linear target of its own, resolved and copied into the
 * chain's read buffer. AO reads the resolved depth (sceneTarget.depthTexture), so the composer's
 * ping-pong buffers need no depth. setSamples changes the count; the buffers are reallocated on use.
 */
class MultisampleRenderPass extends RenderPass {
  constructor(scene, camera) {
    super(scene, camera);
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.sceneTarget.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.sceneTarget.texture.name = 'PostFX.scene';
    this.copy = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      blending: THREE.NoBlending, depthTest: false, depthWrite: false,
    }));
  }

  setSamples(samples) {
    if (this.sceneTarget.samples === samples) return;
    this.sceneTarget.samples = samples;
    this.sceneTarget.dispose();
  }

  setSize(width, height) {
    this.sceneTarget.setSize(width, height);
  }

  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    super.render(renderer, writeBuffer, this.sceneTarget, deltaTime, maskActive);
    this.copy.material.uniforms.tDiffuse.value = this.sceneTarget.texture;
    renderer.setRenderTarget(readBuffer);
    this.copy.render(renderer);
  }

  dispose() {
    super.dispose();
    this.sceneTarget.dispose();
    this.copy.material.dispose();
    this.copy.dispose();
  }
}

/**
 * Bloom whose bright pass caps each scene pixel's luminance at `ceiling` before averaging the four
 * pixels under each half-resolution texel. Uncapped, a single texel thousands of times above the
 * threshold dominates every coarse mip, and their bilinear upsampling draws it as a stack of
 * squares; capped, a lone pinpoint adds no more than a quarter of a window's glow.
 */
function cappedBloomPass() {
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
  const m = bloom.materialHighPassFilter;
  bloom.highPassUniforms.ceiling = { value: BLOOM.ceiling };
  const fs = m.fragmentShader
    .replace('uniform float smoothWidth;', `uniform float smoothWidth;
		uniform float ceiling;
		vec3 capped( const in vec2 uv ) {
			vec3 c = max( texture2D( tDiffuse, uv ).rgb, vec3( 0.0 ) );
			return c * min( 1.0, ceiling / max( dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-6 ) );
		}`)
    .replace('vec4 texel = texture2D( tDiffuse, vUv );', `vec2 d = 0.5 / vec2( textureSize( tDiffuse, 0 ) );
			vec4 texel = vec4( 0.25 * ( capped( vUv - d ) + capped( vUv + d ) + capped( vUv + vec2( d.x, - d.y ) ) + capped( vUv - vec2( d.x, - d.y ) ) ), 1.0 );`);
  if (!fs.includes('capped( vUv - d )') || !fs.includes('uniform float ceiling;')) {
    console.warn('postfx: the bloom bright-pass shader changed, so its input is not capped');
  } else {
    m.fragmentShader = fs;
  }
  return bloom;
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
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    target.texture.name = 'PostFX.chain';
    const composer = new EffectComposer(renderer, target);
    const renderPass = new MultisampleRenderPass(scene, camera);
    const ao = new InteriorAOPass(scene, camera);
    ao.setSceneClipBox(clipBox);
    const bloom = cappedBloomPass();
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
    const { composer, renderPass, ao, bloom, grade } = chain;
    const levelChanged = !a || a.level !== level;
    if (levelChanged) {
      const s = LEVELS[level];
      ao.updateGtaoMaterial(s.ao);
      ao.updatePdMaterial(s.denoise);
      bloom.enabled = s.bloom;
    }
    if (levelChanged || a.width !== size.width || a.height !== size.height || a.ratio !== size.ratio) {
      ao.resolutionScale = LEVELS[level].aoScale * Math.min(1, AO_DENSITY / size.ratio);
      renderPass.setSamples(size.ratio >= MSAA_DENSE ? Math.min(2, LEVELS[level].msaa) : LEVELS[level].msaa);
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
      ao.setDepth(renderPass.sceneTarget.depthTexture);
      // Thresholds are set in exposed units so they hold if the exposure is recalibrated.
      const exposure = renderer.toneMappingExposure || 1;
      bloom.threshold = BLOOM.threshold / exposure;
      bloom.highPassUniforms.smoothWidth.value = BLOOM.knee / exposure;
      bloom.highPassUniforms.ceiling.value = BLOOM.ceiling / exposure;
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
