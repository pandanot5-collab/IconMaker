import * as THREE from 'three';

// Deterministic re-creation of Roblox ParticleEmitters, Beams and lights.
// Everything lives on layer 1 so the pipeline can composite it separately from the model.

export const VFX_LAYER = 1;
const STEP = 1 / 60;

export const cfMatrix = (c) => new THREE.Matrix4().set(
  c[3], c[4], c[5], c[0], c[6], c[7], c[8], c[1], c[9], c[10], c[11], c[2], 0, 0, 0, 1);

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleNum(seq, t) {
  if (!seq || !seq.length) return 0;
  for (let i = 0; i < seq.length - 1; i++) {
    const [t0, v0] = seq[i], [t1, v1] = seq[i + 1];
    if (t <= t1) return v0 + (v1 - v0) * ((t - t0) / Math.max(1e-6, t1 - t0));
  }
  return seq[seq.length - 1][1];
}

function sampleColor(seq, t, out) {
  if (!seq || !seq.length) return out.set(1, 1, 1);
  for (let i = 0; i < seq.length - 1; i++) {
    const a = seq[i], b = seq[i + 1];
    if (t <= b[0]) {
      const k = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
      return out.set(a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k);
    }
  }
  const l = seq[seq.length - 1];
  return out.set(l[1], l[2], l[3]);
}

const range = (rng, r) => (r ? r[0] + (r[1] - r[0]) * rng() : 0);

const NORMALS = {
  Top: [0, 1, 0], Bottom: [0, -1, 0], Front: [0, 0, -1], Back: [0, 0, 1], Right: [1, 0, 0], Left: [-1, 0, 0],
};

// Premultiplied output: rgb*a, alpha*(1-LightEmission) -> LightEmission=1 is fully additive.
function vfxMaterial(vertexShader, fragmentShader, map) {
  return new THREE.ShaderMaterial({
    vertexShader, fragmentShader,
    uniforms: { map: { value: map }, hasMap: { value: !!map }, worldScale: { value: 1 }, zOffset: { value: 0 } },
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
}

const FRAG = `
uniform sampler2D map;
uniform bool hasMap;
varying vec2 vUv;
varying vec4 vColor;
varying float vLE;
void main() {
  vec4 t = hasMap ? texture2D(map, vUv) : vec4(1.0);
  // textures and Roblox colours are sRGB; the render target is linear
  vec3 rgb = pow(max(t.rgb * vColor.rgb, 0.0), vec3(2.2));
  float a = clamp(t.a * vColor.a, 0.0, 1.0);
  gl_FragColor = vec4(rgb * a, a * (1.0 - vLE));
}`;

const PARTICLE_VERT = `
attribute vec3 iPos;
attribute float iSize;
attribute float iRot;
attribute vec4 iColor;
attribute vec4 iUV;
uniform float worldScale;
uniform float zOffset;
uniform float lightEmission;
varying vec2 vUv;
varying vec4 vColor;
varying float vLE;
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float c = cos(iRot), s = sin(iRot);
  vec2 q = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
  mv.xy += q * iSize * worldScale;
  mv.xyz += normalize(-mv.xyz) * zOffset * worldScale;
  gl_Position = projectionMatrix * mv;
  vUv = iUV.xy + vec2(uv.x, 1.0 - uv.y) * iUV.zw;
  vColor = iColor;
  vLE = lightEmission;
}`;

class Emitter {
  constructor(d, map, seed) {
    this.d = d;
    this.seed = seed;
    this.frame = cfMatrix(d.cf);
    this.rot = new THREE.Matrix3().setFromMatrix4(this.frame);
    const life = d.lifetime ? d.lifetime[1] : 1;
    this.burst = d.enabled ? 0 : Math.max(1, Math.round(d.emitCount ?? (d.rate > 0 ? Math.min(d.rate, 60) : 20)));
    this.max = Math.max(16, Math.min(4000, Math.ceil((d.rate || 0) * life * (d.timeScale || 1)) + this.burst + 16));

    const base = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.attributes.position);
    g.setAttribute('uv', base.attributes.uv);
    this.attr = {
      iPos: new THREE.InstancedBufferAttribute(new Float32Array(this.max * 3), 3),
      iSize: new THREE.InstancedBufferAttribute(new Float32Array(this.max), 1),
      iRot: new THREE.InstancedBufferAttribute(new Float32Array(this.max), 1),
      iColor: new THREE.InstancedBufferAttribute(new Float32Array(this.max * 4), 4),
      iUV: new THREE.InstancedBufferAttribute(new Float32Array(this.max * 4), 4),
    };
    for (const [k, a] of Object.entries(this.attr)) { a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(k, a); }
    g.instanceCount = 0;

    const mat = vfxMaterial(PARTICLE_VERT, FRAG, map);
    mat.uniforms.lightEmission = { value: d.lightEmission || 0 };
    mat.uniforms.zOffset.value = d.zOffset || 0;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(VFX_LAYER);
    this.grid = { Grid2x2: 2, Grid4x4: 4, Grid8x8: 8 }[d.flipLayout] || 1;
    this.reset();
  }

  reset() {
    this.rng = mulberry32(this.seed);
    this.parts = [];
    this.acc = 0;
    for (let i = 0; i < this.burst; i++) this.spawn();
  }

  spawn() {
    if (this.parts.length >= this.max) return;
    const d = this.d, rng = this.rng;
    const [sx, sy, sz] = d.size || [0, 0, 0];
    const n = new THREE.Vector3(...(NORMALS[d.direction] || NORMALS.Top));
    const p = new THREE.Vector3();
    if (sx || sy || sz) {
      if (d.shape === 'Sphere') {
        const z = rng() * 2 - 1, ph = rng() * Math.PI * 2, rr = Math.sqrt(1 - z * z);
        const u = new THREE.Vector3(rr * Math.cos(ph), rr * Math.sin(ph), z).multiplyScalar(d.shapeStyle === 'Surface' ? 0.5 : Math.cbrt(rng()) * 0.5);
        p.set(u.x * sx, u.y * sy, u.z * sz);
      } else {
        p.set((rng() - 0.5) * sx, (rng() - 0.5) * sy, (rng() - 0.5) * sz);
        if (d.shapeStyle === 'Surface') { // snap onto the emission face
          const half = new THREE.Vector3(sx, sy, sz).multiplyScalar(0.5);
          for (let i = 0; i < 3; i++) if (n.getComponent(i)) p.setComponent(i, n.getComponent(i) * half.getComponent(i));
        }
      }
      if (d.shape === 'Sphere') n.copy(p).normalize(); // spheres emit outward
    }
    // spread
    const dir = n.clone();
    const ax = THREE.MathUtils.degToRad((rng() * 2 - 1) * (d.spread ? d.spread[0] : 0));
    const ay = THREE.MathUtils.degToRad((rng() * 2 - 1) * (d.spread ? d.spread[1] : 0));
    const perp1 = Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const perp2 = new THREE.Vector3().crossVectors(n, perp1).normalize();
    perp1.crossVectors(perp2, n).normalize();
    dir.applyAxisAngle(perp1, ax).applyAxisAngle(perp2, ay);
    if (d.shapeInOut === 'Inward') dir.negate();

    const speed = range(rng, d.speed);
    this.parts.push({
      pos: p.applyMatrix4(this.frame),
      vel: dir.applyMatrix3(this.rot).normalize().multiplyScalar(speed),
      age: 0,
      life: Math.max(0.01, range(rng, d.lifetime)),
      rot: THREE.MathUtils.degToRad(range(rng, d.rotation)),
      rotSpeed: THREE.MathUtils.degToRad(range(rng, d.rotSpeed)),
      frame0: d.flipStartRandom ? Math.floor(rng() * this.grid * this.grid) : 0,
    });
  }

  step(dt) {
    dt *= this.d.timeScale ?? 1;
    const d = this.d;
    if (d.enabled && d.rate > 0) {
      this.acc += d.rate * dt;
      while (this.acc >= 1) { this.spawn(); this.acc -= 1; }
    }
    const acc = d.accel || [0, 0, 0];
    const drag = Math.exp(-(d.drag || 0) * dt);
    const parts = this.parts;
    for (let i = parts.length - 1; i >= 0; i--) {
      const q = parts[i];
      q.age += dt;
      if (q.age >= q.life) { parts[i] = parts[parts.length - 1]; parts.pop(); continue; }
      q.vel.x = (q.vel.x + acc[0] * dt) * drag;
      q.vel.y = (q.vel.y + acc[1] * dt) * drag;
      q.vel.z = (q.vel.z + acc[2] * dt) * drag;
      q.pos.addScaledVector(q.vel, dt);
      q.rot += q.rotSpeed * dt;
    }
  }

  write() {
    const d = this.d, a = this.attr, c = new THREE.Color();
    const n = this.grid, frames = n * n, bright = d.brightness ?? 1;
    this.parts.forEach((q, i) => {
      const t = q.age / q.life;
      a.iPos.setXYZ(i, q.pos.x, q.pos.y, q.pos.z);
      a.iSize.setX(i, sampleNum(d.pSize, t));
      a.iRot.setX(i, q.rot);
      sampleColor(d.color, t, c);
      a.iColor.setXYZW(i, c.r * bright, c.g * bright, c.b * bright, 1 - sampleNum(d.transparency, t));
      let f = 0;
      if (frames > 1) {
        const fps = d.flipFps ? d.flipFps[0] : 1;
        if (d.flipMode === 'OneShot') f = Math.min(frames - 1, Math.floor(t * frames));
        else if (d.flipMode === 'PingPong') {
          const k = Math.floor(q.age * fps + q.frame0) % (frames * 2 - 2 || 1);
          f = k < frames ? k : frames * 2 - 2 - k;
        } else if (d.flipMode === 'Random') f = q.frame0;
        else f = Math.floor(q.age * fps + q.frame0) % frames;
      }
      a.iUV.setXYZW(i, (f % n) / n, Math.floor(f / n) / n, 1 / n, 1 / n);
    });
    for (const v of Object.values(a)) v.needsUpdate = true;
    this.mesh.geometry.instanceCount = this.parts.length;
  }
}

const BEAM_VERT = `
attribute vec4 color;
varying vec2 vUv;
varying vec4 vColor;
varying float vLE;
uniform float lightEmission;
void main() {
  vUv = uv; vColor = color; vLE = lightEmission;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

class Beam {
  constructor(d, map) {
    this.d = d;
    const m0 = cfMatrix(d.a0), m1 = cfMatrix(d.a1);
    const p0 = new THREE.Vector3().setFromMatrixPosition(m0), p3 = new THREE.Vector3().setFromMatrixPosition(m1);
    const x0 = new THREE.Vector3().setFromMatrixColumn(m0, 0), x1 = new THREE.Vector3().setFromMatrixColumn(m1, 0);
    this.up0 = new THREE.Vector3().setFromMatrixColumn(m0, 1);
    this.up1 = new THREE.Vector3().setFromMatrixColumn(m1, 1);
    this.curve = new THREE.CubicBezierCurve3(p0, p0.clone().addScaledVector(x0, d.curve0 || 0),
      p3.clone().addScaledVector(x1, -(d.curve1 || 0)), p3);
    this.segs = Math.max(1, Math.min(200, d.segments || 10));
    const g = new THREE.BufferGeometry();
    const nv = (this.segs + 1) * 2;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(nv * 2), 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nv * 4), 4));
    const idx = [];
    for (let i = 0; i < this.segs; i++) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    g.setIndex(idx);
    const mat = vfxMaterial(BEAM_VERT, FRAG, map);
    mat.uniforms.lightEmission = { value: d.lightEmission || 0 };
    if (map) map.wrapS = map.wrapT = THREE.RepeatWrapping;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(VFX_LAYER);
    this.length = this.curve.getLength();
  }

  write(time, camLocal) {
    const d = this.d, g = this.mesh.geometry;
    const pos = g.attributes.position, uv = g.attributes.uv, col = g.attributes.color;
    const c = new THREE.Color(), bright = d.brightness ?? 1;
    const texLen = d.textureLength || 1;
    const scroll = time * (d.textureSpeed || 0);
    for (let i = 0; i <= this.segs; i++) {
      const s = i / this.segs;
      const p = this.curve.getPoint(s), tan = this.curve.getTangent(s);
      let side;
      if (d.faceCamera) side = new THREE.Vector3().crossVectors(tan, camLocal.clone().sub(p)).normalize();
      else side = this.up0.clone().lerp(this.up1, s).normalize();
      const w = ((d.width0 ?? 1) + ((d.width1 ?? 1) - (d.width0 ?? 1)) * s) / 2;
      pos.setXYZ(i * 2, p.x + side.x * w, p.y + side.y * w, p.z + side.z * w);
      pos.setXYZ(i * 2 + 1, p.x - side.x * w, p.y - side.y * w, p.z - side.z * w);
      const u = (d.textureMode === 'Stretch' ? s * texLen : (s * this.length) / texLen) - scroll;
      uv.setXY(i * 2, u, 0); uv.setXY(i * 2 + 1, u, 1);
      sampleColor(d.color, s, c);
      const a = 1 - sampleNum(d.transparency, s);
      col.setXYZW(i * 2, c.r * bright, c.g * bright, c.b * bright, a);
      col.setXYZW(i * 2 + 1, c.r * bright, c.g * bright, c.b * bright, a);
    }
    pos.needsUpdate = uv.needsUpdate = col.needsUpdate = true;
  }
}

export class VfxSystem {
  constructor() {
    this.group = new THREE.Group();
    this.emitters = [];
    this.beams = [];
    this.lights = [];
    this.time = 0;
  }

  get empty() { return !this.emitters.length && !this.beams.length && !this.lights.length; }

  async build(vfx, assetTex) {
    if (!vfx) return;
    const tex = (ref) => (ref ? assetTex(ref, false) : null);
    let seed = 1;
    for (const d of vfx.emitters || []) {
      const e = new Emitter(d, await tex(d.texture), seed++ * 7919);
      this.emitters.push(e);
      this.group.add(e.mesh);
    }
    for (const d of vfx.beams || []) {
      const b = new Beam(d, await tex(d.texture));
      this.beams.push(b);
      this.group.add(b.mesh);
    }
    for (const d of vfx.lights || []) {
      const l = new THREE.PointLight(new THREE.Color(...d.color), (d.brightness ?? 1) * 0.8, 0, 1);
      l.position.setFromMatrixPosition(cfMatrix(d.cf));
      l.userData.range = d.range || 8;
      this.lights.push(l);
      this.group.add(l);
    }
  }

  seek(t) {
    if (t < this.time) { this.time = 0; this.emitters.forEach((e) => e.reset()); }
    while (this.time < t - 1e-6) {
      const dt = Math.min(STEP, t - this.time);
      this.emitters.forEach((e) => e.step(dt));
      this.time += dt;
    }
  }

  // worldScale: stud -> world scale of the model; camera: used by camera-facing beams
  update(camera, worldScale, show) {
    this.group.updateMatrixWorld(true);
    const camLocal = camera.position.clone().applyMatrix4(this.group.matrixWorld.clone().invert());
    for (const e of this.emitters) { e.write(); e.mesh.material.uniforms.worldScale.value = worldScale; }
    for (const b of this.beams) b.write(this.time, camLocal);
    for (const l of this.lights) { l.distance = l.userData.range * worldScale; l.visible = show; }
  }

  dispose() {
    for (const o of [...this.emitters, ...this.beams]) { o.mesh.geometry.dispose(); o.mesh.material.dispose(); }
  }
}
