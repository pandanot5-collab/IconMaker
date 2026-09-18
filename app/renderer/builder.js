import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { parseRobloxMesh } from './robloxMesh.js';

const dds = new DDSLoader();

const draco = new DRACOLoader();
draco.setDecoderPath('./node_modules/three/examples/jsm/libs/draco/');

// ---------------------------------------------------------------------------
// Asset loading (embedded by the plugin, or downloaded by the app)
// ---------------------------------------------------------------------------
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64ToF32 = (b64) => new Float32Array(b64ToBytes(b64).buffer);

const meshCache = new Map();   // ref -> Promise<BufferGeometry>
const imageCache = new Map();  // ref -> Promise<{source, w, h}>

function geometryFromArrays({ pos, nrm, uv, index }) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (uv) g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (index) g.setIndex(new THREE.BufferAttribute(index, 1));
  let hasNormals = false;
  if (nrm) for (let i = 0; i < Math.min(nrm.length, 300); i++) if (nrm[i] !== 0) { hasNormals = true; break; }
  if (hasNormals) g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  else g.computeVertexNormals();
  return g;
}

function loadMesh(ref, embedded) {
  if (meshCache.has(ref) && !embedded) return meshCache.get(ref);
  const p = (async () => {
    if (embedded) {
      return geometryFromArrays({
        pos: b64ToF32(embedded.pos),
        nrm: embedded.nrm ? b64ToF32(embedded.nrm) : null,
        uv: embedded.uv ? b64ToF32(embedded.uv) : null,
      });
    }
    const bytes = await window.api.fetchAsset(ref);
    const parsed = parseRobloxMesh(bytes);
    if (parsed.draco) {
      return new Promise((resolve, reject) => draco.parse(parsed.draco.buffer, resolve, reject));
    }
    return geometryFromArrays(parsed);
  })();
  meshCache.set(ref, p);
  return p;
}

function loadImage(ref, embedded) {
  if (imageCache.has(ref) && !embedded) return imageCache.get(ref);
  const p = (async () => {
    if (embedded) {
      return { data: b64ToBytes(embedded.data), w: embedded.w, h: embedded.h };
    }
    const bytes = await window.api.fetchAsset(ref, 'image');
    if (bytes[0] === 0x44 && bytes[1] === 0x44 && bytes[2] === 0x53) { // 'DDS ' (Studio's built-in particle textures)
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const d = dds.parse(buf, true);
      return { dds: d, w: d.width, h: d.height };
    }
    const bmp = await createImageBitmap(new Blob([bytes]), {
      imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none',
    });
    return { bitmap: bmp, w: bmp.width, h: bmp.height };
  })();
  imageCache.set(ref, p);
  return p;
}

function makeTexture(img, srgb) {
  let tex;
  if (img.dds) {
    tex = new THREE.CompressedTexture(img.dds.mipmaps, img.w, img.h, img.dds.format);
    tex.flipY = false;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.minFilter = img.dds.mipmapCount > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }
  if (img.bitmap) tex = new THREE.Texture(img.bitmap);
  else tex = new THREE.DataTexture(img.data, img.w, img.h, THREE.RGBAFormat);
  // Roblox UVs have their origin at the top-left; keep image rows top-down.
  tex.flipY = false;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Primitive geometry
// ---------------------------------------------------------------------------
function convexGeometry(verts, faces) {
  // faces are polygons (index lists); each is oriented away from the centroid.
  const c = new THREE.Vector3();
  verts.forEach((v) => c.add(new THREE.Vector3(...v)));
  c.divideScalar(verts.length);
  const pos = [];
  for (const f of faces) {
    const [a, b, d] = f.slice(0, 3).map((i) => new THREE.Vector3(...verts[i]));
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a));
    const flip = n.dot(new THREE.Vector3().subVectors(a, c)) < 0;
    const poly = flip ? [...f].reverse() : f;
    for (let i = 1; i < poly.length - 1; i++) {
      for (const k of [poly[0], poly[i], poly[i + 1]]) pos.push(...verts[k]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

const h = 0.5;
const WEDGE = convexGeometry(
  [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h], [-h, h, h], [h, h, h]],
  [[0, 1, 2, 3], [3, 2, 5, 4], [0, 1, 5, 4], [0, 3, 4], [1, 2, 5]],
);
const CORNER_WEDGE = convexGeometry(
  [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h], [h, h, -h]],
  [[0, 1, 2, 3], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]],
);
const BOX = new THREE.BoxGeometry(1, 1, 1);
const SPHERE = new THREE.SphereGeometry(0.5, 64, 32);
const CYL_X = new THREE.CylinderGeometry(0.5, 0.5, 1, 64).rotateZ(Math.PI / 2);
const CYL_Y = new THREE.CylinderGeometry(0.5, 0.5, 1, 64);
const HEAD = new THREE.CapsuleGeometry(0.4, 0.2, 12, 48);

function primitiveFor(shape, size) {
  const [x, y, z] = size;
  switch (shape) {
    case 'Ball': { const d = Math.min(x, y, z); return { geo: SPHERE, scale: [d, d, d] }; }
    case 'Cylinder': { const d = Math.min(y, z); return { geo: CYL_X, scale: [x, d, d] }; }
    case 'Wedge': return { geo: WEDGE, scale: size };
    case 'CornerWedge': return { geo: CORNER_WEDGE, scale: size };
    default: return { geo: BOX, scale: size };
  }
}

function specialMeshPrimitive(type) {
  switch (type) {
    case 'Sphere': return SPHERE;
    case 'Cylinder': return CYL_Y;
    case 'Head': return HEAD;
    case 'Wedge': return WEDGE;
    default: return BOX;
  }
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------
const MATERIALS = {
  SmoothPlastic: [0.35, 0], Plastic: [0.55, 0], Neon: [1, 0], Glass: [0.05, 0], ForceField: [1, 0],
  Metal: [0.35, 0.85], DiamondPlate: [0.3, 0.85], CorrodedMetal: [0.8, 0.6], Foil: [0.2, 0.95],
  Ice: [0.1, 0], Glacier: [0.15, 0], Marble: [0.25, 0], Granite: [0.6, 0], Pebble: [0.85, 0],
  Wood: [0.8, 0], WoodPlanks: [0.8, 0], Fabric: [1, 0], Sand: [1, 0], Grass: [1, 0], Slate: [0.9, 0],
};

const srgbColor = (c) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);

// Texture alpha reveals the part colour underneath (SurfaceAppearance "Overlay" / MeshPart TextureID).
export function useOverlay(mat, baseColor) {
  mat.userData.overlayBase = baseColor;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.overlayBase = { value: baseColor };
    sh.fragmentShader = 'uniform vec3 overlayBase;\n' + sh.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
        vec4 sampledDiffuseColor = texture2D( map, vMapUv );
        diffuseColor.rgb = mix( overlayBase, sampledDiffuseColor.rgb * diffuse, sampledDiffuseColor.a );
      #endif`,
    );
  };
  mat.customProgramCacheKey = () => 'overlay';
}

async function makeMaterial(part, textureRef, assetTex) {
  const [rough, metal] = MATERIALS[part.material] || [0.6, 0];
  const opacity = 1 - part.transparency;
  const mat = new THREE.MeshStandardMaterial({
    color: srgbColor(part.color),
    roughness: Math.max(0.04, rough - part.reflectance * 0.5),
    metalness: Math.min(1, metal + part.reflectance * 0.5),
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1,
  });
  if (part.material === 'Neon') {
    mat.emissive = srgbColor(part.color);
    mat.emissiveIntensity = 1.4;
  }

  const sa = part.sa;
  if (sa) {
    const [color, normal, roughness, metalness] = await Promise.all([
      assetTex(sa.colorMap, true), assetTex(sa.normalMap, false),
      assetTex(sa.roughnessMap, false), assetTex(sa.metalnessMap, false),
    ]);
    mat.color = srgbColor(sa.color || [1, 1, 1]);
    if (color) {
      mat.map = color;
      if (part.invisible) {
        mat.color.setRGB(1, 1, 1);
        mat.opacity = 1;
        mat.transparent = true;
        mat.depthWrite = true;
      }
      if (sa.alphaMode === 'Overlay') useOverlay(mat, srgbColor(part.color));
      else if (sa.alphaMode === 'Transparency') { mat.transparent = true; mat.alphaTest = 0.02; mat.depthWrite = true; }
    }
    if (normal) { mat.normalMap = normal; mat.normalScale.set(1, -1); }
    mat.roughnessMap = roughness;
    mat.roughness = roughness ? 1 : 0.5;
    mat.metalnessMap = metalness;
    mat.metalness = metalness ? 1 : 0;
    mat.emissive = new THREE.Color(0);
  } else if (textureRef) {
    const tex = await assetTex(textureRef, true);
    if (tex) {
      mat.map = tex;
      if (part.invisible) {
        mat.opacity = 1;
        mat.transparent = true;
        mat.depthWrite = true;
      }
      if (part.mesh && part.mesh.vertexColor) mat.color = new THREE.Color(...part.mesh.vertexColor);
      else mat.color = new THREE.Color(1, 1, 1);
      useOverlay(mat, part.invisible ? new THREE.Color(1, 1, 1) : srgbColor(part.color));
    }
  }
  return mat;
}

// ---------------------------------------------------------------------------
// Decals
// ---------------------------------------------------------------------------
const FACE = {
  Front: { axis: 2, sign: -1, rot: [0, Math.PI, 0], dims: [0, 1] },
  Back: { axis: 2, sign: 1, rot: [0, 0, 0], dims: [0, 1] },
  Right: { axis: 0, sign: 1, rot: [0, Math.PI / 2, 0], dims: [2, 1] },
  Left: { axis: 0, sign: -1, rot: [0, -Math.PI / 2, 0], dims: [2, 1] },
  Top: { axis: 1, sign: 1, rot: [-Math.PI / 2, 0, 0], dims: [0, 2] },
  Bottom: { axis: 1, sign: -1, rot: [Math.PI / 2, 0, 0], dims: [0, 2] },
};

function makeDecal(decal, size, tex) {
  const f = FACE[decal.face] || FACE.Front;
  const g = new THREE.PlaneGeometry(size[f.dims[0]], size[f.dims[1]]);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
    map: tex, color: srgbColor(decal.color), transparent: true, opacity: 1 - decal.transparency,
    roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false,
  }));
  m.rotation.set(...f.rot);
  m.position.setComponent(f.axis, f.sign * (size[f.axis] / 2 + 0.002));
  return m;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
export async function buildModel(payload, onWarn) {
  const assets = payload.assets || {};
  const texCache = new Map();

  const assetMesh = async (ref) => {
    if (!ref) return null;
    try { return await loadMesh(ref, assets[ref]); }
    catch (e) { onWarn(`Mesh ${ref}: ${e.message || e}`); return null; }
  };
  const assetTex = async (ref, srgb) => {
    if (!ref) return null;
    const key = ref + (srgb ? '|s' : '|l');
    if (!texCache.has(key)) {
      texCache.set(key, loadImage(ref, assets[ref]).then(
        (img) => makeTexture(img, srgb),
        (e) => { onWarn(`Texture ${ref}: ${e.message || e}`); return null; },
      ));
    }
    return texCache.get(key);
  };

  const root = new THREE.Group();
  let unions = 0;

  await Promise.all(payload.parts.map(async (part) => {
    if (part.shape === 'Union') { unions++; return; }
    const holder = new THREE.Group();
    const c = part.cf;
    holder.matrixAutoUpdate = false;
    holder.matrix.set(c[3], c[4], c[5], c[0], c[6], c[7], c[8], c[1], c[9], c[10], c[11], c[2], 0, 0, 0, 1);
    root.add(holder);

    let geo = null, scale = [1, 1, 1], offset = [0, 0, 0], textureRef = null;
    if (part.shape === 'Mesh') {
      geo = await assetMesh(part.meshId);
      if (!geo) return;
      // MeshParts stretch the mesh's bounding box to the part size.
      geo.computeBoundingBox();
      const bb = geo.boundingBox, sz = bb.getSize(new THREE.Vector3()), ctr = bb.getCenter(new THREE.Vector3());
      scale = part.size.map((s, i) => s / (sz.getComponent(i) || 1));
      offset = [-ctr.x * scale[0], -ctr.y * scale[1], -ctr.z * scale[2]];
      textureRef = part.textureId;
    } else if (part.mesh) {
      const sm = part.mesh;
      textureRef = sm.textureId;
      if (sm.type === 'FileMesh') {
        geo = await assetMesh(sm.meshId);
        if (!geo) return;
        scale = sm.scale;
      } else {
        geo = specialMeshPrimitive(sm.type);
        scale = part.size.map((s, i) => s * sm.scale[i]);
      }
      offset = sm.offset;
    } else {
      ({ geo, scale } = primitiveFor(part.shape, part.size));
    }

    const material = await makeMaterial(part, textureRef, assetTex);
    if (!part.invisible || material.map) {
      const mesh = new THREE.Mesh(geo, material);
      mesh.scale.set(...scale);
      mesh.position.set(...offset);
      holder.add(mesh);
    }

    for (const d of part.decals || []) {
      const tex = await assetTex(d.texture, true);
      if (tex) holder.add(makeDecal(d, part.size, tex));
    }
  }));

  if (unions) onWarn(`${unions} union(s) skipped — Studio plugins can't read union geometry. Convert them to MeshParts (right-click > Export / "Convert to MeshPart").`);
  root.updateMatrixWorld(true);
  root.userData.assetTex = assetTex;
  return root;
}

export function disposeModel(obj) {
  obj.traverse((o) => {
    if (o.isMesh && o.userData.orig && o.userData.orig !== o.material) o.userData.orig.dispose();
    if (o.isMesh && o.material) {
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) o.material[k]?.dispose();
      o.material.dispose();
    }
  });
}
