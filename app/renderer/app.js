import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildModel, disposeModel, useOverlay } from './builder.js';
import { Pipeline, MAX_OUTLINES } from './pipeline.js';
import { VfxSystem } from './vfx.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Persistent state
// ---------------------------------------------------------------------------
const DEFAULTS = {
  fov: 30, zoom: 1, rot: [0, 0, 0, 1], pan: [0, 0], normalize: true, refScale: 1,
  brightness: 0, contrast: 1, saturation: 1, light: 1,
  outlines: [{ color: '#000000', thickness: 6, opacity: 1 }],
  exportSize: 512, bgMode: 'transparent', bgColor: '#ffffff',
  showVfx: true, vfxTime: 0.8, vfxLoop: 3, vfxPlaying: true,
  shading: 'realistic', toonBands: 3, toonShadow: 0.55, flatFaces: true, highlight: true,
};
let state;
try { state = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('iconMakerState') || '{}') }; }
catch { state = { ...DEFAULTS }; }
let saveTimer;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => localStorage.setItem('iconMakerState', JSON.stringify(state)), 200);
};

// ---------------------------------------------------------------------------
// Three.js setup
// ---------------------------------------------------------------------------
const canvas = $('canvas');
const viewport = $('viewport');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, premultipliedAlpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.autoClear = false;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 1.2);
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(0.6, 1.1, 1.2);
const fill = new THREE.DirectionalLight(0xffffff, 0.6);
fill.position.set(-1, 0.2, 0.6);
scene.add(hemi, key, fill);

const modelRoot = new THREE.Group();   // user rotation + pan (persists between models)
const normGroup = new THREE.Group();   // scale-to-fit
normGroup.rotation.y = Math.PI;       // Roblox models face -Z; show their front by default
modelRoot.add(normGroup);
scene.add(modelRoot);

const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1000);
const pipeline = new Pipeline(renderer);

let model = null;
let vfx = null;
const vfxOn = () => !!(vfx && !vfx.empty && state.showVfx);
let modelRadius = 1;

function applyLights() {
  const l = state.light;
  hemi.intensity = 1.2 * l;
  key.intensity = 2.2 * l;
  fill.intensity = 0.6 * l;
  scene.environmentIntensity = 0.6 * l;
}

// Distance so the model's bounding sphere (radius 1 after fit) fills the frame.
function cameraDistance() {
  const half = THREE.MathUtils.degToRad(state.fov) / 2;
  return 1.12 / Math.sin(half) / state.zoom; // small margin so outlines fit
}

function frameRect() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  const side = Math.floor(Math.min(w, h) * 0.8);
  return { x: (w - side) / 2, y: (h - side) / 2, side, w, h };
}

function updateCamera(cam, aspect, fovScale) {
  const d = cameraDistance();
  const t = Math.tan(THREE.MathUtils.degToRad(state.fov) / 2) * fovScale;
  cam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(t));
  cam.aspect = aspect;
  cam.position.set(0, 0, d);
  cam.lookAt(0, 0, 0);
  cam.near = Math.max(0.001, d - 4);
  cam.far = d + 4;
  cam.updateProjectionMatrix();
}

function applyTransform() {
  modelRoot.quaternion.fromArray(state.rot);
  modelRoot.position.set(state.pan[0], state.pan[1], 0);
  const s = state.normalize ? 1 / modelRadius : state.refScale;
  normGroup.scale.setScalar(s);
}

function renderOpts(pxScale) {
  let bg = [0, 0, 0, 0];
  if (state.bgMode === 'color') {
    const c = new THREE.Color(state.bgColor);
    bg = [c.r, c.g, c.b, 1];
  }
  return {
    brightness: state.brightness, contrast: state.contrast, saturation: state.saturation,
    outlines: state.outlines, pxScale, bg, aa: 0.35, vfx: vfxOn(),
  };
}

let dirty = true;
const invalidate = () => { dirty = true; };

function resize() {
  const { w, h } = frameRect();
  renderer.setSize(w, h, false);
  invalidate();
}
new ResizeObserver(resize).observe(viewport);

let lastFrame = performance.now();
function renderLoop(now) {
  requestAnimationFrame(renderLoop);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (vfxOn() && state.vfxPlaying) {
    let t = state.vfxTime + dt;
    if (t > state.vfxLoop) t = 0;
    state.vfxTime = t;
    vfx.seek(t);
    $('vfxTime').value = t;
    $('vfxTimeOut').textContent = t.toFixed(2) + 's';
    dirty = true;
  }
  if (!dirty) return;
  dirty = false;
  const f = frameRect();
  const frame = $('frame');
  Object.assign(frame.style, { left: f.x + 'px', top: f.y + 'px', width: f.side + 'px', height: f.side + 'px' });
  $('frameLabel').textContent = `${state.exportSize} × ${state.exportSize}`;

  const buf = renderer.getDrawingBufferSize(new THREE.Vector2());
  applyLights();
  applyTransform();
  updateCamera(camera, f.w / f.h, f.h / f.side);
  const sidePx = f.side * renderer.getPixelRatio();
  vfx?.update(camera, normGroup.scale.x, state.showVfx);
  pipeline.render(scene, camera, buf.x, buf.y, renderOpts(sidePx / 512), null);
}
requestAnimationFrame(renderLoop);

// ---------------------------------------------------------------------------
// Mouse interaction: rotate the model, pan, zoom
// ---------------------------------------------------------------------------
let drag = null;
viewport.addEventListener('contextmenu', (e) => e.preventDefault());
viewport.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey };
  viewport.setPointerCapture(e.pointerId);
  viewport.classList.add('dragging');
});
viewport.addEventListener('pointerup', (e) => {
  drag = null;
  viewport.releasePointerCapture(e.pointerId);
  viewport.classList.remove('dragging');
  save();
});
viewport.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  const q = new THREE.Quaternion().fromArray(state.rot);
  if (drag.button === 0) {
    const speed = 0.01;
    let r;
    if (drag.shift || e.shiftKey) {
      r = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -dx * speed);
    } else {
      const ry = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dx * speed);
      const rx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), dy * speed);
      r = ry.multiply(rx);
    }
    q.premultiply(r).normalize();
    state.rot = q.toArray();
    syncRotationInputs();
  } else {
    // pan in world units at the model's depth
    const f = frameRect();
    const worldPerPx = (2 * Math.tan(THREE.MathUtils.degToRad(state.fov) / 2) * cameraDistance()) / f.side;
    state.pan = [state.pan[0] + dx * worldPerPx, state.pan[1] - dy * worldPerPx];
  }
  invalidate();
});
viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  state.zoom = THREE.MathUtils.clamp(state.zoom * Math.pow(1.1, -Math.sign(e.deltaY)), 0.2, 4);
  syncSlider('zoom');
  save();
  invalidate();
}, { passive: false });

// ---------------------------------------------------------------------------
// Panel bindings
// ---------------------------------------------------------------------------
const fmt = { fov: (v) => v + '°', zoom: (v) => (+v).toFixed(2) + '×', light: (v) => (+v).toFixed(2) };
function syncSlider(id) {
  const el = $(id);
  el.value = state[id];
  const out = el.parentElement.querySelector('output');
  if (out) out.textContent = (fmt[id] || ((v) => (+v).toFixed(2)))(state[id]);
}
for (const id of ['fov', 'zoom', 'brightness', 'contrast', 'saturation', 'light', 'toonBands', 'toonShadow']) {
  syncSlider(id);
  $(id).addEventListener('input', (e) => {
    state[id] = parseFloat(e.target.value);
    syncSlider(id);
    save();
    invalidate();
  });
}

function syncRotationInputs() {
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(state.rot), 'YXZ');
  $('rotX').value = Math.round(THREE.MathUtils.radToDeg(e.x));
  $('rotY').value = Math.round(THREE.MathUtils.radToDeg(e.y));
  $('rotZ').value = Math.round(THREE.MathUtils.radToDeg(e.z));
}
syncRotationInputs();
for (const id of ['rotX', 'rotY', 'rotZ']) {
  $(id).addEventListener('change', () => {
    const d = (k) => THREE.MathUtils.degToRad(parseFloat($(k).value) || 0);
    state.rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(d('rotX'), d('rotY'), d('rotZ'), 'YXZ')).toArray();
    save();
    invalidate();
  });
}

$('normalize').checked = state.normalize;
$('normalize').addEventListener('change', (e) => {
  // When turning auto-fit off, freeze the current scale so later models keep their relative size.
  if (!e.target.checked) state.refScale = 1 / modelRadius;
  state.normalize = e.target.checked;
  save();
  invalidate();
});

$('resetView').addEventListener('click', () => {
  Object.assign(state, { rot: [0, 0, 0, 1], pan: [0, 0], zoom: 1, fov: DEFAULTS.fov });
  syncSlider('zoom'); syncSlider('fov'); syncRotationInputs();
  save(); invalidate();
});
$('resetPan').addEventListener('click', () => { state.pan = [0, 0]; save(); invalidate(); });
$('resetAdjust').addEventListener('click', () => {
  Object.assign(state, { brightness: 0, contrast: 1, saturation: 1, light: 1 });
  ['brightness', 'contrast', 'saturation', 'light'].forEach(syncSlider);
  save(); invalidate();
});

// Outlines ------------------------------------------------------------------
function renderOutlineList() {
  const list = $('outlines');
  list.innerHTML = '';
  state.outlines.forEach((o, i) => {
    const row = document.createElement('div');
    row.className = 'outline';
    row.innerHTML = `
      <input type="color" value="${o.color}">
      <input type="range" min="0" max="40" step="0.5" value="${o.thickness}">
      <output>${o.thickness}px</output>
      <button class="remove small" title="Remove">✕</button>
      <span class="lbl">Opacity</span>
      <input class="opacity" type="range" min="0" max="1" step="0.01" value="${o.opacity ?? 1}">`;
    const [color, thick, out, remove, , opacity] = row.children;
    color.addEventListener('input', () => { o.color = color.value; save(); invalidate(); });
    thick.addEventListener('input', () => { o.thickness = parseFloat(thick.value); out.textContent = o.thickness + 'px'; save(); invalidate(); });
    opacity.addEventListener('input', () => { o.opacity = parseFloat(opacity.value); save(); invalidate(); });
    remove.addEventListener('click', () => { state.outlines.splice(i, 1); renderOutlineList(); save(); invalidate(); });
    list.appendChild(row);
  });
  $('addOutline').disabled = state.outlines.length >= MAX_OUTLINES;
}
renderOutlineList();
$('addOutline').addEventListener('click', () => {
  state.outlines.push({ color: '#ffffff', thickness: 4, opacity: 1 });
  renderOutlineList(); save(); invalidate();
});

// Export --------------------------------------------------------------------
$('exportSize').value = String(state.exportSize);
$('exportSize').addEventListener('change', (e) => { state.exportSize = parseInt(e.target.value, 10); save(); invalidate(); });
$('bgMode').value = state.bgMode;
$('bgColor').value = state.bgColor;
$('bgMode').addEventListener('change', (e) => { state.bgMode = e.target.value; save(); invalidate(); });
$('bgColor').addEventListener('input', (e) => { state.bgColor = e.target.value; state.bgMode = 'color'; $('bgMode').value = 'color'; save(); invalidate(); });

function exportDataUrl() {
  const S = state.exportSize * 2; // render at 2x, downsample for crisp edges
  const cam = new THREE.PerspectiveCamera();
  applyLights();
  applyTransform();
  updateCamera(cam, 1, 1);
  const rt = new THREE.WebGLRenderTarget(S, S);
  const p = new Pipeline(renderer);
  vfx?.update(cam, normGroup.scale.x, state.showVfx);
  p.render(scene, cam, S, S, renderOpts(S / 512), rt);
  const px = new Uint8Array(S * S * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, S, S, px);
  renderer.setRenderTarget(null);
  p.dispose(); rt.dispose();

  // flip rows (GL is bottom-up) and un-premultiply alpha
  const img = new ImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const s = ((S - 1 - y) * S + x) * 4, d = (y * S + x) * 4;
      const a = px[s + 3];
      const k = a ? 255 / a : 0;
      img.data[d] = Math.min(255, px[s] * k);
      img.data[d + 1] = Math.min(255, px[s + 1] * k);
      img.data[d + 2] = Math.min(255, px[s + 2] * k);
      img.data[d + 3] = a;
    }
  }
  const c = document.createElement('canvas');
  c.width = c.height = S;
  c.getContext('2d').putImageData(img, 0, 0);
  const out = document.createElement('canvas');
  out.width = out.height = S / 2;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c, 0, 0, S / 2, S / 2);
  invalidate();
  return out.toDataURL('image/png');
}

let modelName = 'icon';
$('savePng').addEventListener('click', async () => {
  if (!model) return setStatus('Nothing to export yet');
  const file = await window.api.savePng(exportDataUrl(), `${modelName.replace(/[^\w\- ]+/g, '_')}.png`);
  if (file) setStatus('Saved ' + file);
});
$('copyPng').addEventListener('click', async () => {
  if (!model) return setStatus('Nothing to export yet');
  await window.api.copyPng(exportDataUrl());
  setStatus('Copied to clipboard');
});

// Settings ------------------------------------------------------------------
window.api.getSettings().then((s) => {
  $('apiKey').value = s.apiKey || '';
  $('cookie').value = s.cookie || '';
});
$('saveSettings').addEventListener('click', async () => {
  await window.api.setSettings({ apiKey: $('apiKey').value.trim(), cookie: $('cookie').value.trim() });
  setStatus('Settings saved');
});
$('clearCache').addEventListener('click', async () => { await window.api.clearCache(); setStatus('Asset cache cleared'); });

// ---------------------------------------------------------------------------
// Receiving models from Studio
// ---------------------------------------------------------------------------
let statusTimer;
function setStatus(text, sticky = false) {
  $('status').textContent = text;
  clearTimeout(statusTimer);
  if (!sticky) statusTimer = setTimeout(() => { $('status').textContent = ''; }, 4000);
}

function boundingSphere(obj) {
  const box = new THREE.Box3().setFromObject(obj, true);
  if (box.isEmpty()) return { center: new THREE.Vector3(), radius: 1 };
  const center = box.getCenter(new THREE.Vector3());
  let r2 = 0;
  const v = new THREE.Vector3();
  obj.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    const stride = Math.max(1, Math.floor(pos.count / 20000));
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      r2 = Math.max(r2, v.distanceToSquared(center));
    }
  });
  return { center, radius: Math.sqrt(r2) || 1 };
}

let buildToken = 0;
async function loadPayload(json) {
  let payload;
  try { payload = JSON.parse(json); } catch { return setStatus('Received invalid data from Studio'); }
  const token = ++buildToken;
  const warnings = [];
  if ((payload.version || 1) < 2) {
    warnings.push('Your Studio plugin is out of date (no VFX support). Restart Roblox Studio so it loads the new version.');
  }
  setStatus(`Loading "${payload.name}" (${payload.parts.length} parts)…`, true);
  let built;
  try {
    built = await buildModel(payload, (w) => warnings.push(w));
  } catch (e) {
    console.error(e);
    return setStatus('Failed to build model: ' + (e.message || e), true);
  }
  if (token !== buildToken) { disposeModel(built); return; }

  // measure before parenting, so the sphere is in the model's own space
  built.updateMatrixWorld(true);
  const { center, radius } = boundingSphere(built);
  built.position.copy(center).negate();

  const newVfx = new VfxSystem();
  try { await newVfx.build(payload.vfx, built.userData.assetTex); }
  catch (e) { warnings.push('VFX: ' + (e.message || e)); }
  if (token !== buildToken) { disposeModel(built); newVfx.dispose(); return; }
  built.add(newVfx.group);
  vfx?.dispose();
  vfx = newVfx;
  vfx.seek(state.vfxTime);
  $('vfxSection').hidden = vfx.empty;
  $('vfxCount').textContent = vfx.empty ? '' : `${vfx.emitters.length} emitters · ${vfx.beams.length} beams · ${vfx.lights.length} lights`;

  if (model) { normGroup.remove(model); disposeModel(model); }
  model = built;
  normGroup.add(model);
  modelRadius = radius;
  applyShading();

  modelName = payload.name || 'icon';
  $('modelName').textContent = modelName;
  $('empty').hidden = true;
  $('warnings').innerHTML = [...new Set(warnings)].slice(0, 8).map((w) => `<div>⚠ ${w.replace(/</g, '&lt;')}</div>`).join('');
  setStatus(`Loaded "${modelName}"`);
  invalidate();
}

window.api.onModel(loadPayload);
window.api.getLastModel().then((m) => m && loadPayload(m));

// ---------------------------------------------------------------------------
// Style: realistic PBR or flat cartoon (toon) shading
// ---------------------------------------------------------------------------
function gradientMap() {
  const n = Math.max(2, Math.round(state.toonBands));
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) data[i] = Math.round(255 * (state.toonShadow + (1 - state.toonShadow) * (i / (n - 1))));
  const t = new THREE.DataTexture(data, n, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

let toonGradient = null;
function applyShading() {
  if (!model) return;
  toonGradient?.dispose();
  toonGradient = state.shading === 'toon' ? gradientMap() : null;
  model.traverse((o) => {
    if (!o.isMesh || o.material.isShaderMaterial) return; // leave VFX materials alone
    const orig = o.userData.orig || (o.userData.orig = o.material);
    if (o.material !== orig) o.material.dispose();
    if (!toonGradient) { o.material = orig; return; }
    const m = new THREE.MeshToonMaterial({
      color: orig.color, map: orig.map, gradientMap: toonGradient,
      transparent: orig.transparent, opacity: orig.opacity, alphaTest: orig.alphaTest,
      depthWrite: orig.depthWrite, emissive: orig.emissive, emissiveIntensity: orig.emissiveIntensity,
      polygonOffset: orig.polygonOffset, polygonOffsetFactor: orig.polygonOffsetFactor,
    });
    m.flatShading = state.flatFaces; // not accepted by the MeshToonMaterial constructor
    if (orig.userData.overlayBase) useOverlay(m, orig.userData.overlayBase);
    o.material = m;
  });
  // Toon look: softer, even ambient so the bands carry the shape
  invalidate();
}

function syncStyleUI() {
  $('shading').value = state.shading;
  $('flatFaces').checked = state.flatFaces;
  syncSlider('toonBands'); syncSlider('toonShadow');
  $('toonOptions').hidden = state.shading !== 'toon';
}
fmt.toonBands = (v) => String(Math.round(v));
syncStyleUI();
$('shading').addEventListener('change', (e) => { state.shading = e.target.value; syncStyleUI(); applyShading(); save(); });
$('flatFaces').addEventListener('change', (e) => { state.flatFaces = e.target.checked; applyShading(); save(); });
for (const id of ['toonBands', 'toonShadow']) {
  $(id).addEventListener('input', () => { applyShading(); });
}
$('cartoonPreset').addEventListener('click', () => {
  Object.assign(state, {
    shading: 'toon', toonBands: 3, toonShadow: 0.6, flatFaces: true,
    saturation: 1.2, contrast: 1.05, brightness: 0, light: 0.75,
    outlines: [{ color: '#0b0d2e', thickness: 12, opacity: 1 }],
  });
  ['saturation', 'contrast', 'brightness', 'light'].forEach(syncSlider);
  syncStyleUI(); renderOutlineList(); applyShading(); save();
});

// ---------------------------------------------------------------------------
// VFX playback
// ---------------------------------------------------------------------------
function syncVfxUI() {
  $('showVfx').checked = state.showVfx;
  $('vfxPlay').textContent = state.vfxPlaying ? '❚❚ Pause' : '▶ Play';
  $('vfxTime').max = state.vfxLoop;
  $('vfxTime').value = state.vfxTime;
  $('vfxTimeOut').textContent = state.vfxTime.toFixed(2) + 's';
  $('vfxLoop').value = state.vfxLoop;
}
syncVfxUI();
$('showVfx').addEventListener('change', (e) => { state.showVfx = e.target.checked; save(); invalidate(); });
$('vfxPlay').addEventListener('click', () => { state.vfxPlaying = !state.vfxPlaying; syncVfxUI(); save(); });
$('vfxTime').addEventListener('input', (e) => {
  state.vfxPlaying = false;
  state.vfxTime = parseFloat(e.target.value);
  vfx?.seek(state.vfxTime);
  syncVfxUI(); save(); invalidate();
});
$('vfxLoop').addEventListener('change', (e) => {
  state.vfxLoop = Math.max(0.2, parseFloat(e.target.value) || 3);
  state.vfxTime = Math.min(state.vfxTime, state.vfxLoop);
  syncVfxUI(); save();
});
$('vfxRestart').addEventListener('click', () => { state.vfxTime = 0; vfx?.seek(0); syncVfxUI(); invalidate(); });
