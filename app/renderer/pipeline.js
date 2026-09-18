import * as THREE from 'three';

// Renders the scene, then draws stacked outlines around the model silhouette
// (jump-flood distance field) and applies brightness / contrast / saturation.

export const MAX_OUTLINES = 6;

const SEED = `
uniform sampler2D tColor;
float A(ivec2 p) { return clamp(texelFetch(tColor, p, 0).a, 0.0, 1.0); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float a = A(p);
  if (a < 0.02) { gl_FragColor = vec4(-1.0, -1.0, 0.0, 0.0); return; }
  // Estimate where the 0.5-coverage edge actually is, from the alpha gradient (Sobel)
  float tl = A(p + ivec2(-1, 1)), t = A(p + ivec2(0, 1)), tr = A(p + ivec2(1, 1));
  float l = A(p + ivec2(-1, 0)), r = A(p + ivec2(1, 0));
  float bl = A(p + ivec2(-1, -1)), b = A(p + ivec2(0, -1)), br = A(p + ivec2(1, -1));
  vec2 g = vec2((tr + 2.0 * r + br) - (tl + 2.0 * l + bl), (tl + 2.0 * t + tr) - (bl + 2.0 * b + br));
  vec2 pos = gl_FragCoord.xy;
  float gl = length(g);
  if (gl > 0.05 && a < 0.98) pos += (g / gl) * (a - 0.5) * -1.0;
  else if (a < 0.5) { gl_FragColor = vec4(-1.0, -1.0, 0.0, 0.0); return; }
  gl_FragColor = vec4(pos, 0.0, 1.0);
}`;

const JFA = `
uniform sampler2D tSeed;
uniform float stepSize;
uniform vec2 res;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 best = vec4(-1.0, -1.0, 0.0, 0.0);
  float bd = 1e20;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 q = p + vec2(x, y) * stepSize;
    if (q.x < 0.0 || q.y < 0.0 || q.x >= res.x || q.y >= res.y) continue;
    vec4 s = texelFetch(tSeed, ivec2(q), 0);
    if (s.x < 0.0) continue;
    float d = distance(s.xy, p);
    if (d < bd) { bd = d; best = s; }
  }
  gl_FragColor = best;
}`;

const FINAL = `
uniform sampler2D tColor;
uniform sampler2D tSeed;
uniform bool useSeed;
uniform float brightness, contrast, saturation;
uniform int count;
uniform vec4 oColor[${MAX_OUTLINES}];
uniform float oEnd[${MAX_OUTLINES}];
uniform float aa;
uniform vec4 bg;
uniform sampler2D tVfx;
uniform bool useVfx;
vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }

vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(tColor, p, 0);
  float a = clamp(c.a, 0.0, 1.0);
  vec3 rgb = a > 0.0001 ? c.rgb / a : vec3(0.0);
  rgb = toSRGB(clamp(rgb, 0.0, 1.0));
  rgb += brightness;
  rgb = (rgb - 0.5) * contrast + 0.5;
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = clamp(mix(vec3(l), rgb, saturation), 0.0, 1.0);

  vec4 o = vec4(0.0); // premultiplied outline colour
  if (useSeed && count > 0) {
    vec4 s = texelFetch(tSeed, p, 0);
    if (s.x >= 0.0) {
      float d = distance(s.xy, gl_FragCoord.xy);
      for (int i = ${MAX_OUTLINES - 1}; i >= 0; i--) {
        if (i >= count) continue;
        float cov = (1.0 - smoothstep(oEnd[i] - aa, oEnd[i] + aa, d)) * oColor[i].a;
        o = vec4(oColor[i].rgb, 1.0) * cov + o * (1.0 - cov);
      }
    }
  }
  vec4 outc = vec4(rgb * a, a) + o * (1.0 - a);
  if (useVfx) {
    // composite particles/beams (linear, premultiplied; additive light has rgb > alpha)
    vec4 v = texelFetch(tVfx, p, 0);
    vec4 L = vec4(toLinear(outc.rgb / max(outc.a, 1e-4)) * outc.a, outc.a);
    L = max(v, 0.0) + L * (1.0 - clamp(v.a, 0.0, 1.0));
    float A = clamp(max(L.a, max(L.r, max(L.g, L.b))), 0.0, 1.0);
    outc = vec4(toSRGB(clamp(L.rgb / max(A, 1e-4), 0.0, 1.0)) * A, A);
  }
  outc += vec4(bg.rgb * bg.a, bg.a) * (1.0 - outc.a);
  gl_FragColor = outc;
}`;

const VERT = `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export class Pipeline {
  constructor(renderer) {
    this.r = renderer;
    this.w = 0; this.h = 0;
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.fsScene = new THREE.Scene();
    this.fsScene.add(this.quad);
    this.fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mk = (frag, uniforms) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
    this.seedMat = mk(SEED, { tColor: { value: null } });
    this.jfaMat = mk(JFA, { tSeed: { value: null }, stepSize: { value: 1 }, res: { value: new THREE.Vector2() } });
    this.finalMat = mk(FINAL, {
      tColor: { value: null }, tSeed: { value: null }, useSeed: { value: false },
      brightness: { value: 0 }, contrast: { value: 1 }, saturation: { value: 1 },
      count: { value: 0 },
      oColor: { value: Array.from({ length: MAX_OUTLINES }, () => new THREE.Vector4()) },
      oEnd: { value: new Array(MAX_OUTLINES).fill(0) },
      aa: { value: 0.5 },
      bg: { value: new THREE.Vector4(0, 0, 0, 0) },
      tVfx: { value: null }, useVfx: { value: false },
    });
    this.finalMat.blending = THREE.NoBlending;
    this.depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });
  }

  ensure(w, h) {
    if (w === this.w && h === this.h) return;
    this.dispose();
    this.w = w; this.h = h;
    const samples = Math.min(8, this.r.capabilities.maxSamples || 4);
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples });
    this.vfxRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples });
    const opts = { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false };
    this.jfaA = new THREE.WebGLRenderTarget(w, h, opts);
    this.jfaB = new THREE.WebGLRenderTarget(w, h, opts);
  }

  pass(mat, target) {
    this.quad.material = mat;
    this.r.setRenderTarget(target);
    this.r.render(this.fsScene, this.fsCam);
  }

  /**
   * opts: { brightness, contrast, saturation, outlines:[{color:'#rrggbb', opacity, thickness}], pxScale, bg:[r,g,b,a] }
   * target: null for the canvas, or a WebGLRenderTarget.
   */
  render(scene, camera, w, h, opts, target = null) {
    this.ensure(w, h);
    const r = this.r;
    r.setRenderTarget(this.sceneRT);
    r.setClearColor(0x000000, 0);
    r.clear();
    camera.layers.set(0);
    r.render(scene, camera);

    if (opts.vfx) {
      // VFX live on layer 1; the model is drawn depth-only first so it hides particles behind it
      r.setRenderTarget(this.vfxRT);
      r.clear();
      scene.overrideMaterial = this.depthOnly;
      r.render(scene, camera);
      scene.overrideMaterial = null;
      camera.layers.set(1);
      r.render(scene, camera);
      camera.layers.set(0);
    }

    const outlines = opts.outlines.slice(0, MAX_OUTLINES).filter((o) => o.thickness > 0);
    const u = this.finalMat.uniforms;
    let total = 0;
    outlines.forEach((o, i) => {
      total += o.thickness * opts.pxScale;
      const c = new THREE.Color(o.color);
      u.oColor.value[i].set(c.r, c.g, c.b, o.opacity ?? 1);
      u.oEnd.value[i] = total;
    });
    u.count.value = outlines.length;
    u.aa.value = opts.aa ?? 0.5;

    let seedTex = null;
    if (outlines.length) {
      this.seedMat.uniforms.tColor.value = this.sceneRT.texture;
      this.pass(this.seedMat, this.jfaA);
      let src = this.jfaA, dst = this.jfaB;
      this.jfaMat.uniforms.res.value.set(w, h);
      let step = 1;
      while (step < total + 2) step *= 2;
      for (; step >= 1; step /= 2) {
        this.jfaMat.uniforms.tSeed.value = src.texture;
        this.jfaMat.uniforms.stepSize.value = step;
        this.pass(this.jfaMat, dst);
        [src, dst] = [dst, src];
      }
      for (const s of [2, 1]) { // extra passes fix JFA's occasional wrong seeds
        this.jfaMat.uniforms.tSeed.value = src.texture;
        this.jfaMat.uniforms.stepSize.value = s;
        this.pass(this.jfaMat, dst);
        [src, dst] = [dst, src];
      }
      seedTex = src.texture;
    }

    u.tColor.value = this.sceneRT.texture;
    u.tSeed.value = seedTex;
    u.useSeed.value = !!seedTex;
    u.brightness.value = opts.brightness;
    u.contrast.value = opts.contrast;
    u.saturation.value = opts.saturation;
    u.tVfx.value = this.vfxRT.texture;
    u.useVfx.value = !!opts.vfx;
    u.bg.value.set(...(opts.bg || [0, 0, 0, 0]));
    this.pass(this.finalMat, target);
  }

  dispose() {
    this.sceneRT?.dispose(); this.vfxRT?.dispose(); this.jfaA?.dispose(); this.jfaB?.dispose();
  }
}
