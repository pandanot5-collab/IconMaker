// Parser for Roblox .mesh files (versions 1.00 – 7.00).
// Returns { pos, nrm, uv, index } typed arrays, or { draco: Uint8Array } for Draco-compressed meshes.

const ascii = (u8, start, len) => String.fromCharCode(...u8.subarray(start, start + len));

export function parseRobloxMesh(u8) {
  const nl = u8.indexOf(10);
  const head = ascii(u8, 0, Math.min(nl > 0 ? nl : 16, 32)).trim();
  if (!head.startsWith('version ')) throw new Error('Not a Roblox mesh file');
  const ver = parseFloat(head.slice(8));
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  if (ver < 2) return parseV1(new TextDecoder().decode(u8.subarray(nl + 1)), ver);
  if (ver < 6) return parseV2to5(u8, dv, nl + 1, ver);
  return parseChunked(u8, dv, nl + 1);
}

function parseV1(text, ver) {
  const nums = [...text.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].split(',').map(Number));
  const n = Math.floor(nums.length / 3);
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  const s = ver === 1 ? 0.5 : 1;
  for (let i = 0; i < n; i++) {
    const [p, q, t] = [nums[i * 3], nums[i * 3 + 1], nums[i * 3 + 2]];
    pos.set([p[0] * s, p[1] * s, p[2] * s], i * 3);
    nrm.set([q[0], q[1], q[2]], i * 3);
    uv.set([t[0], t[1]], i * 2);
  }
  return { pos, nrm, uv, index: null };
}

function readVerts(dv, off, count, stride) {
  const pos = new Float32Array(count * 3), nrm = new Float32Array(count * 3), uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const o = off + i * stride;
    for (let k = 0; k < 3; k++) {
      pos[i * 3 + k] = dv.getFloat32(o + k * 4, true);
      nrm[i * 3 + k] = dv.getFloat32(o + 12 + k * 4, true);
    }
    uv[i * 2] = dv.getFloat32(o + 24, true);
    uv[i * 2 + 1] = dv.getFloat32(o + 28, true);
  }
  return { pos, nrm, uv };
}

function readFaces(dv, off, first, last) {
  const index = new Uint32Array((last - first) * 3);
  for (let i = 0; i < index.length; i++) index[i] = dv.getUint32(off + first * 12 + i * 4, true);
  return index;
}

function parseV2to5(u8, dv, o, ver) {
  const hsize = dv.getUint16(o, true);
  let vsize = 40, nV, nF, nLOD = 0, nBones = 0;
  if (ver < 3) {
    vsize = u8[o + 2]; nV = dv.getUint32(o + 4, true); nF = dv.getUint32(o + 8, true);
  } else if (ver < 4) {
    vsize = u8[o + 2]; nLOD = dv.getUint16(o + 6, true);
    nV = dv.getUint32(o + 8, true); nF = dv.getUint32(o + 12, true);
  } else {
    nV = dv.getUint32(o + 4, true); nF = dv.getUint32(o + 8, true);
    nLOD = dv.getUint16(o + 12, true); nBones = dv.getUint16(o + 14, true);
  }
  o += hsize;
  const verts = readVerts(dv, o, nV, vsize);
  o += nV * vsize;
  if (ver >= 4 && nBones > 0) o += nV * 8;
  const facesOff = o;
  o += nF * 12;
  let first = 0, last = nF;
  if (nLOD >= 2) {
    first = dv.getUint32(o, true);
    last = dv.getUint32(o + 4, true) || nF;
  }
  return { ...verts, index: readFaces(dv, facesOff, first, Math.min(last, nF)) };
}

function parseChunked(u8, dv, o) {
  let core = null, lods = null;
  while (o + 16 <= u8.length) {
    const type = ascii(u8, o, 8).replace(/\0/g, '');
    const cver = dv.getUint32(o + 8, true);
    const size = dv.getUint32(o + 12, true);
    const data = o + 16;
    if (type === 'COREMESH') core = { cver, data, size };
    if (type === 'LODS' && cver === 1) {
      const n = dv.getUint32(data + 3, true);
      lods = [];
      for (let i = 0; i < n; i++) lods.push(dv.getUint32(data + 7 + i * 4, true));
    }
    o = data + size;
  }
  if (!core) throw new Error('Mesh has no COREMESH chunk');

  if (core.cver !== 1) {
    // Draco-compressed geometry: locate the Draco bitstream inside the chunk
    const chunk = u8.subarray(core.data, core.data + core.size);
    for (let i = 0; i < chunk.length - 5; i++) {
      if (chunk[i] === 68 && ascii(chunk, i, 5) === 'DRACO') return { draco: chunk.slice(i) };
    }
    throw new Error('Unsupported compressed mesh');
  }

  let p = core.data;
  const nV = dv.getUint32(p, true); p += 4;
  const verts = readVerts(dv, p, nV, 40); p += nV * 40;
  const nF = dv.getUint32(p, true); p += 4;
  let first = 0, last = nF;
  if (lods && lods.length >= 2) { first = lods[0]; last = lods[1] || nF; }
  return { ...verts, index: readFaces(dv, p, first, Math.min(last, nF)) };
}
