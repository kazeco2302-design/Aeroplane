/* Полёт над Алматы — 3D flight over a real-data model of Almaty.
   World: x = metres east, z = metres south of Republic Square, y = metres above sea level.
   Map data (data/almaty-data.js) is built by tools/build_data.py from Overture Maps and AWS Terrain Tiles. */
(() => {
'use strict';
const $ = (id) => document.getElementById(id);
const fail = (msg) => { $('loading-text').textContent = msg; };
if (!window.THREE) return fail('Не удалось загрузить 3D-движок. Проверьте интернет и обновите страницу.');
if (!window.ALMATY_DATA) return fail('Не найден файл карты data/almaty-data.js.');
if (typeof DecompressionStream === 'undefined') return fail('Браузер устарел: обновите его, чтобы загрузить карту города.');

const V3 = THREE.Vector3;
const isTouch = matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && matchMedia('(hover: none)').matches);
const LOW = isTouch || /low/.test(location.hash);
document.body.classList.toggle('touch', isTouch);
const DATA = window.ALMATY_DATA;

/* =========================================================
   Utilities
   ========================================================= */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
let seed = 7734;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const rr = (a, b) => a + (b - a) * rnd();
const pick = (arr) => arr[(rnd() * arr.length) | 0];
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
};
function hash(ix, iz) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}
const TYPED = { u1: Uint8Array, i1: Int8Array, u2: Uint16Array, i2: Int16Array, u4: Uint32Array, i4: Int32Array, f4: Float32Array };
async function unpack(sec) {
  const s = atob(sec.gz);
  const bin = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bin[i] = s.charCodeAt(i);
  const buf = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const out = {};
  for (const [name, [off, type, n]] of Object.entries(sec.index)) out[name] = new TYPED[type](buf, off, n);
  return out;
}
const O = DATA.origin;
const ll = (lat, lon) => ({ x: (lon - O.lon) * O.kx, z: -(lat - O.lat) * O.kz });
function pointInRing(x, z, xs, zs, n) {
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if ((zs[i] > z) !== (zs[j] > z) && x < ((xs[j] - xs[i]) * (z - zs[i])) / (zs[j] - zs[i]) + xs[i]) inside = !inside;
  }
  return inside;
}

/* =========================================================
   Landmarks (real coordinates)
   ========================================================= */
const LM = {
  monument: ll(43.2381, 76.9454),
  hotel: ll(43.24470, 76.95780),
  cathedral: ll(43.25865, 76.95325),
  esentai: ll(43.21795, 76.92745),
  koktobe: ll(43.22985, 76.97720),
  stadium: ll(43.23456, 76.91790),
  medeu: ll(43.15735, 77.05830),
  shymbulak: ll(43.12840, 77.08060),
  bao: ll(43.05050, 76.98490),
  sairan: ll(43.2420, 76.8730),
  arena: ll(43.2148, 76.7905),
};

/* =========================================================
   Renderer, scene, sky
   ========================================================= */
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !LOW, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, LOW ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight, false);
renderer.shadowMap.enabled = !LOW;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
const HORIZON = new THREE.Color('#c6d9e2');
scene.fog = new THREE.Fog(HORIZON, 5000, 34000);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 2, 80000);

const SUN_DIR = new V3(-0.62, 0.6, 0.5).normalize();
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(60000, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { sunDir: { value: SUN_DIR }, top: { value: new THREE.Color('#2b80c0') }, hor: { value: HORIZON.clone() } },
    vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }',
    fragmentShader: `uniform vec3 sunDir; uniform vec3 top; uniform vec3 hor; varying vec3 vD;
      void main(){ float h = max(vD.y, 0.0); vec3 c = mix(hor, top, pow(h, 0.5));
      float s = max(dot(normalize(vD), sunDir), 0.0);
      c += vec3(1.0,0.93,0.78) * (pow(s, 900.0) * 1.6 + pow(s, 12.0) * 0.18);
      gl_FragColor = vec4(c, 1.0); }`,
  })
);
sky.frustumCulled = false;
sky.renderOrder = -10;
scene.add(sky);
scene.add(new THREE.HemisphereLight('#dcedf8', '#5f6a4c', 1.25));
const sun = new THREE.DirectionalLight('#fff2dc', 2.4);
sun.castShadow = !LOW;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -450, right: 450, top: 450, bottom: -450, near: 10, far: 5000 });
sun.shadow.bias = -0.0006;
scene.add(sun, sun.target);

/* =========================================================
   Terrain from the real elevation model
   ========================================================= */
const D = DATA.dem;
const STRIDE = LOW ? 2 : 1;
const NX = Math.floor((D.nx - 1) / STRIDE) + 1, NZ = Math.floor((D.nz - 1) / STRIDE) + 1;
const CELL = D.step * STRIDE, X0 = D.x0, Z0 = D.z0;
const X1 = X0 + (NX - 1) * CELL, Z1 = Z0 + (NZ - 1) * CELL;
const HMAP = new Float32Array(NX * NZ);

function gridH(x, z) {
  let fx = (x - X0) / CELL, fz = (z - Z0) / CELL;
  fx = clamp(fx, 0, NX - 1.001); fz = clamp(fz, 0, NZ - 1.001);
  const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j;
  const h00 = HMAP[j * NX + i], h10 = HMAP[j * NX + i + 1], h01 = HMAP[(j + 1) * NX + i], h11 = HMAP[(j + 1) * NX + i + 1];
  return u + v <= 1 ? h00 + (h10 - h00) * u + (h01 - h00) * v : h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
}
function slopeAt(x, z) {
  const dx = gridH(x + 15, z) - gridH(x - 15, z), dz = gridH(x, z + 15) - gridH(x, z - 15);
  return Math.hypot(dx, dz) / 30;
}

async function buildTerrain() {
  const dem = await unpack(D);
  const raw = dem.h;
  const full = new Float32Array(D.nx * D.nz);
  for (let j = 0; j < D.nz; j++) {
    let acc = 0;
    for (let i = 0; i < D.nx; i++) {
      const k = j * D.nx + i;
      acc = i === 0 ? raw[k] : (acc + raw[k]) & 0xffff;
      full[k] = acc / 10;
    }
  }
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) HMAP[j * NX + i] = full[j * STRIDE * D.nx + i * STRIDE];

  // normals and colours on the full grid
  const NRM = new Float32Array(NX * NZ * 3), COL = new Float32Array(NX * NZ * 3);
  const c = new THREE.Color();
  const P = {
    steppe: new THREE.Color('#9a9c63'), field: new THREE.Color('#7e9a4f'), field2: new THREE.Color('#b0a066'),
    foot: new THREE.Color('#7f8a4c'), orchard: new THREE.Color('#5f7f3e'), forest: new THREE.Color('#2c4f31'),
    meadow: new THREE.Color('#7e8656'), rock: new THREE.Color('#8a837a'), rockD: new THREE.Color('#68625b'), snow: new THREE.Color('#f2f6f9'),
  };
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const k = j * NX + i;
    const hl = HMAP[j * NX + Math.max(i - 1, 0)], hr = HMAP[j * NX + Math.min(i + 1, NX - 1)];
    const hu = HMAP[Math.max(j - 1, 0) * NX + i], hd = HMAP[Math.min(j + 1, NZ - 1) * NX + i];
    let nx = (hl - hr) / (2 * CELL), nz = (hu - hd) / (2 * CELL), ny = 1;
    const len = Math.hypot(nx, ny, nz);
    nx /= len; ny /= len; nz /= len;
    NRM[k * 3] = nx; NRM[k * 3 + 1] = ny; NRM[k * 3 + 2] = nz;
    const x = X0 + i * CELL, z = Z0 + j * CELL, h = HMAP[k];
    const n = vnoise(x * 0.0012, z * 0.0012), n2 = vnoise(x * 0.006 + 9, z * 0.006);
    if (h < 1000) c.copy(n < 0.35 ? P.field : n < 0.65 ? P.steppe : P.field2).lerp(P.field, n2 * 0.4);
    else if (h < 1600) c.copy(P.foot).lerp(P.orchard, smooth(0.3, 0.7, n2));
    else if (h < 2700) {
      const northFacing = smooth(0.0, -0.35, nz);
      c.copy(P.meadow).lerp(P.forest, clamp(northFacing * 1.2 + (n - 0.5) * 0.6, 0, 1) * (1 - smooth(2450, 2700, h)));
    } else c.copy(P.meadow).lerp(P.rock, smooth(2700, 3100, h));
    c.lerp(n2 > 0.5 ? P.rock : P.rockD, smooth(0.8, 0.55, ny) * (h > 1300 ? 0.85 : 0.25));
    const snowLine = 3350 + (n - 0.5) * 500;
    c.lerp(P.snow, smooth(snowLine, snowLine + 200, h) * smooth(0.42, 0.68, ny));
    COL[k * 3] = c.r; COL[k * 3 + 1] = c.g; COL[k * 3 + 2] = c.b;
  }
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const CH = 48;
  for (let cj = 0; cj < NZ - 1; cj += CH) for (let ci = 0; ci < NX - 1; ci += CH) {
    const w = Math.min(CH, NX - 1 - ci) + 1, d = Math.min(CH, NZ - 1 - cj) + 1;
    const pos = new Float32Array(w * d * 3), nrm = new Float32Array(w * d * 3), col = new Float32Array(w * d * 3);
    for (let b = 0; b < d; b++) for (let a = 0; a < w; a++) {
      const k = (cj + b) * NX + ci + a, o = (b * w + a) * 3;
      pos[o] = X0 + (ci + a) * CELL; pos[o + 1] = HMAP[k]; pos[o + 2] = Z0 + (cj + b) * CELL;
      for (let q = 0; q < 3; q++) { nrm[o + q] = NRM[k * 3 + q]; col[o + q] = COL[k * 3 + q]; }
    }
    const idx = [];
    for (let b = 0; b < d - 1; b++) for (let a = 0; a < w - 1; a++) {
      const p0 = b * w + a, p1 = (b + 1) * w + a;
      idx.push(p0, p1, p0 + 1, p0 + 1, p1, p1 + 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    scene.add(m);
  }
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(240000, 240000).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#99995f' }));
  outer.position.y = 560;
  scene.add(outer);
  return NRM;
}

/* =========================================================
   City ground: land use, water and the urban fabric painted on a draped texture
   ========================================================= */
const OVB = (() => {
  const i0 = Math.ceil((-16600 - X0) / CELL), i1 = Math.floor((15800 - X0) / CELL);
  const j0 = Math.ceil((-19300 - Z0) / CELL), j1 = Math.floor((13900 - Z0) / CELL);
  return { i0, i1, j0, j1, x0: X0 + i0 * CELL, x1: X0 + i1 * CELL, z0: Z0 + j0 * CELL, z1: Z0 + j1 * CELL };
})();
const OW = LOW ? 2048 : 4096;
const OH = Math.round(OW * (OVB.z1 - OVB.z0) / (OVB.x1 - OVB.x0));
const OSX = OW / (OVB.x1 - OVB.x0), OSZ = OH / (OVB.z1 - OVB.z0);

const AREA_STYLE = {
  8: 'rgba(138,148,92,0.4)', 6: 'rgba(178,172,158,0.8)', 5: 'rgba(152,152,146,0.85)', 7: 'rgba(192,184,166,0.85)',
  2: 'rgba(112,150,76,0.92)', 1: 'rgba(78,124,58,0.96)', 4: 'rgba(98,118,78,0.92)', 3: 'rgba(88,146,72,0.95)',
  10: 'rgba(206,198,184,0.96)', 40: 'rgba(92,95,98,1)', 30: 'rgba(66,124,152,1)', 32: 'rgba(66,124,152,1)', 31: 'rgba(80,182,212,1)',
};
const AREA_ORDER = [8, 6, 5, 7, 'bld', 2, 1, 4, 3, 10, 40, 32, 30, 31, 'wl'];
let AREAS = null, LINES = null, BLD = null;
const LAKES = [];

function paintGround() {
  const cv = document.createElement('canvas');
  cv.width = OW; cv.height = OH;
  const g = cv.getContext('2d');
  const tx = (x) => (x - OVB.x0) * OSX, tz = (z) => (z - OVB.z0) * OSZ;
  for (const layer of AREA_ORDER) {
    if (layer === 'bld') {
      // urban fabric: yards and courtyards around every building
      g.fillStyle = 'rgba(148,146,136,0.5)';
      g.beginPath();
      for (const b of BLD.list) {
        const r = Math.max(b.rx, b.rz) + 7;
        g.rect(tx(b.cx - r), tz(b.cz - r), 2 * r * OSX, 2 * r * OSZ);
      }
      g.fill();
      continue;
    }
    if (layer === 'wl') {
      g.strokeStyle = AREA_STYLE[30]; g.lineCap = 'round'; g.lineJoin = 'round';
      for (const L of LINES.list) {
        if (L.code < 20 || L.code > 22) continue;
        g.lineWidth = Math.max(1, (L.code === 20 ? 14 : 5) * OSX);
        g.beginPath();
        for (let i = 0; i < L.n; i++) i ? g.lineTo(tx(L.x[i]), tz(L.z[i])) : g.moveTo(tx(L.x[i]), tz(L.z[i]));
        g.stroke();
      }
      continue;
    }
    g.fillStyle = AREA_STYLE[layer];
    g.beginPath();
    for (const A of AREAS.list) {
      if (A.code !== layer) continue;
      for (const r of A.rings) {
        for (let i = 0; i < r.n; i++) i ? g.lineTo(tx(r.x[i]), tz(r.z[i])) : g.moveTo(tx(r.x[i]), tz(r.z[i]));
        g.closePath();
      }
    }
    g.fill('evenodd');
  }
  return cv;
}

function buildGround(cv, NRM) {
  const w = OVB.i1 - OVB.i0 + 1, d = OVB.j1 - OVB.j0 + 1;
  const pos = new Float32Array(w * d * 3), nrm = new Float32Array(w * d * 3), uv = new Float32Array(w * d * 2);
  for (let b = 0; b < d; b++) for (let a = 0; a < w; a++) {
    const k = (OVB.j0 + b) * NX + OVB.i0 + a, o = b * w + a;
    const x = X0 + (OVB.i0 + a) * CELL, z = Z0 + (OVB.j0 + b) * CELL;
    pos[o * 3] = x; pos[o * 3 + 1] = HMAP[k]; pos[o * 3 + 2] = z;
    nrm[o * 3] = NRM[k * 3]; nrm[o * 3 + 1] = NRM[k * 3 + 1]; nrm[o * 3 + 2] = NRM[k * 3 + 2];
    uv[o * 2] = (x - OVB.x0) / (OVB.x1 - OVB.x0); uv[o * 2 + 1] = 1 - (z - OVB.z0) / (OVB.z1 - OVB.z0);
  }
  const idx = new Uint32Array((w - 1) * (d - 1) * 6);
  let p = 0;
  for (let b = 0; b < d - 1; b++) for (let a = 0; a < w - 1; a++) {
    const p0 = b * w + a, p1 = (b + 1) * w + a;
    idx[p++] = p0; idx[p++] = p1; idx[p++] = p0 + 1; idx[p++] = p0 + 1; idx[p++] = p1; idx[p++] = p1 + 1;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = MAX_ANISO;
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }));
  mesh.receiveShadow = true;
  mesh.renderOrder = -2;
  scene.add(mesh);
}

/* =========================================================
   Decoding map layers
   ========================================================= */
async function decodeAreas() {
  const a = await unpack(DATA.areas);
  const list = [];
  let ri = 0, pi = 0;
  for (let k = 0; k < DATA.areas.count; k++) {
    const ax = a.anchor[k * 2], az = a.anchor[k * 2 + 1];
    const rings = [];
    for (let r = 0; r < a.nring[k]; r++) {
      const n = a.rlen[ri++];
      const x = new Float32Array(n), z = new Float32Array(n);
      for (let i = 0; i < n; i++, pi++) { x[i] = (ax + a.pts[pi * 2]) * 0.5; z[i] = (az + a.pts[pi * 2 + 1]) * 0.5; }
      rings.push({ n, x, z });
    }
    list.push({ code: a.code[k], rings });
  }
  AREAS = { list };
}
async function decodeLines() {
  const a = await unpack(DATA.lines);
  const list = [];
  let pi = 0;
  for (let k = 0; k < DATA.lines.count; k++) {
    const n = a.npts[k];
    const x = new Float32Array(n), z = new Float32Array(n);
    let qx = a.ax[k], qz = a.az[k];
    x[0] = qx * 0.5; z[0] = qz * 0.5;
    for (let i = 1; i < n; i++, pi++) { qx += a.dx[pi]; qz += a.dz[pi]; x[i] = qx * 0.5; z[i] = qz * 0.5; }
    list.push({ code: a.code[k], n, x, z });
  }
  LINES = { list };
}

/* =========================================================
   Buildings
   ========================================================= */
const BCOL = {
  0: { wall: ['#e6e0d4', '#d9d4ca', '#cfc9bd', '#e9dcc4'], roof: ['#8a8a86', '#9a968e', '#6f7375'] },
  1: { wall: ['#efe6d6', '#e8d8bf', '#ded6c8', '#f1e9da', '#d9c5a8'], roof: ['#9b4a3a', '#7d4a3a', '#5f7766', '#8c8f93', '#a3613f', '#6b6f75', '#4f6f8f', '#7a3f35'] },
  2: { wall: ['#ece8e1', '#e3ddd2', '#efe5cf', '#d8dcdf', '#e8d7c1', '#d9c9b6', '#f0e6d8'], roof: ['#5f6163', '#707274', '#56595b', '#7b7d7c'] },
  3: { wall: ['#d8d4cc', '#c9cdd0', '#e0d6c4', '#cfc6b8'], roof: ['#7a7c7e', '#8d8f90'] },
  4: { wall: ['#bdbab2', '#c8c4ba', '#a9aaa6', '#c2b8a8'], roof: ['#8e9092', '#7f8487', '#a3a5a3', '#6e8aa0'] },
  5: { wall: ['#efe2bd', '#e9d7b0', '#f2ece0', '#dcd2c0'], roof: ['#7a7d80', '#6c8a6c', '#8a8d90'] },
  6: { wall: ['#a9a59c', '#8f8b84', '#b3ada2'], roof: ['#7d7a74', '#8c5b45', '#6d7377'] },
};
const GLASS = ['#4d7896', '#3f6a7f', '#5a8ea0', '#47657a', '#6c8fa3', '#56707e'];

// collision grid of building footprints
const COLL = new Map();
const CC = 100;
const ckey = (i, j) => (i + 2000) * 5000 + (j + 2000);
function addCollider(o, x0, z0, x1, z1) {
  for (let i = Math.floor(x0 / CC); i <= Math.floor(x1 / CC); i++)
    for (let j = Math.floor(z0 / CC); j <= Math.floor(z1 / CC); j++) {
      const k = ckey(i, j);
      let l = COLL.get(k);
      if (!l) COLL.set(k, (l = []));
      l.push(o);
    }
}

async function decodeBuildings() {
  const a = await unpack(DATA.buildings);
  const t = DATA.buildings.tiers;
  const N = LOW ? t[0] : DATA.buildings.count;
  const list = [];
  let ax = 0, az = 0, ri = 0, rli = 0, pi = 0;
  for (let k = 0; k < N; k++) {
    ax += a.ax[k]; az += a.az[k];
    const cx = ax * 0.5, cz = az * 0.5;
    const h = a.height[k] * 0.5, kind = a.kind[k], nr = a.nring[k];
    const b = { cx, cz, h, kind };
    if (nr === 0) {
      b.w = a.rw[ri] / 4; b.l = a.rl[ri] / 4; b.ang = (a.ra[ri] / 4096) * Math.PI;
      ri++;
      const c = Math.abs(Math.cos(b.ang)), s = Math.abs(Math.sin(b.ang));
      b.rx = (b.w * c + b.l * s) / 2; b.rz = (b.w * s + b.l * c) / 2;
    } else {
      b.rings = [];
      let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
      for (let r = 0; r < nr; r++) {
        const n = a.rlen[rli++];
        const x = new Float32Array(n), z = new Float32Array(n);
        let qx = ax * 2, qz = az * 2;   // quarter metres; the first point is relative to the anchor
        for (let i = 0; i < n; i++, pi++) {
          qx += a.px[pi]; qz += a.pz[pi];
          x[i] = qx / 4; z[i] = qz / 4;
          if (r === 0) { minx = Math.min(minx, x[i]); maxx = Math.max(maxx, x[i]); minz = Math.min(minz, z[i]); maxz = Math.max(maxz, z[i]); }
        }
        b.rings.push({ n, x, z });
      }
      b.rx = (maxx - minx) / 2; b.rz = (maxz - minz) / 2;
      b.bx0 = minx; b.bx1 = maxx; b.bz0 = minz; b.bz1 = maxz;
    }
    list.push(b);
  }
  BLD = { list };
}

function windowMaterial(glass) {
  const mat = new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true });
  const floorH = glass ? 3.8 : 3.0, bay = glass ? 1.9 : 3.2;
  mat.customProgramCacheKey = () => (glass ? 'windows-glass' : 'windows');
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aRoof; varying vec3 vWP; varying vec3 vRoof;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 wpW = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wpW = instanceMatrix * wpW;
        #endif
        vWP = (modelMatrix * wpW).xyz; vRoof = aRoof;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP; varying vec3 vRoof;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 fn = normalize(cross(dFdx(vWP), dFdy(vWP)));
          float roof = step(0.6, abs(fn.y));
          vec2 tg = normalize(vec2(-fn.z, fn.x) + vec2(1e-5));
          float along = dot(vWP.xz, tg);
          float fy = fract(vWP.y / ${floorH.toFixed(2)});
          float fx = fract(along / ${bay.toFixed(2)});
          vec2 cell = floor(vec2(along / ${bay.toFixed(2)}, vWP.y / ${floorH.toFixed(2)}));
          float rn = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
          ${glass
            ? `float mull = step(0.08, fx) * step(0.12, fy);
               vec3 gc = mix(diffuseColor.rgb * 0.8, vec3(0.72, 0.84, 0.92), 0.22 + 0.3 * rn);
               diffuseColor.rgb = mix(diffuseColor.rgb * 0.55, gc, mull);`
            : `float win = step(0.36, fy) * step(fy, 0.84) * step(0.22, fx) * step(fx, 0.78);
               vec3 wc = mix(vec3(0.17, 0.22, 0.28), vec3(0.42, 0.52, 0.6), rn * 0.6);
               diffuseColor.rgb = mix(diffuseColor.rgb * 0.92, wc, win * 0.85);`}
          diffuseColor.rgb = mix(diffuseColor.rgb, vRoof, roof);
        }`);
  };
  return mat;
}

function buildBuildings() {
  const CHUNK = 4000;
  const chunks = new Map();
  const getChunk = (x, z) => {
    const k = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    let c = chunks.get(k);
    if (!c) chunks.set(k, (c = { rect: [[], []], poly: [[], []] }));
    return c;
  };
  const col = new THREE.Color();
  for (const b of BLD.list) {
    // footprint ground: lowest and highest terrain under the corners
    let gmin = 1e9, gmax = -1e9;
    const sample = (x, z) => { const h = gridH(x, z); if (h < gmin) gmin = h; if (h > gmax) gmax = h; };
    sample(b.cx - b.rx, b.cz - b.rz); sample(b.cx + b.rx, b.cz - b.rz); sample(b.cx - b.rx, b.cz + b.rz); sample(b.cx + b.rx, b.cz + b.rz); sample(b.cx, b.cz);
    b.base = gmin - 1.5;
    b.top = gmax + b.h;
    const glass = (b.kind === 3 && b.h > 30) || b.h > 55;
    const pal = BCOL[b.kind] || BCOL[0];
    const r1 = hash(Math.round(b.cx), Math.round(b.cz)), r2 = hash(Math.round(b.cz), Math.round(b.cx) + 7);
    b.wall = glass ? GLASS[(r1 * GLASS.length) | 0] : pal.wall[(r1 * pal.wall.length) | 0];
    b.roof = pal.roof[(r2 * pal.roof.length) | 0];
    const c = getChunk(b.cx, b.cz);
    (b.rings ? c.poly : c.rect)[glass ? 1 : 0].push(b);
    if (b.rings) {
      addCollider({ t: 1, b }, b.bx0, b.bz0, b.bx1, b.bz1);
    } else {
      addCollider({ t: 0, x: b.cx, z: b.cz, c: Math.cos(b.ang), s: Math.sin(b.ang), hw: b.w / 2, hl: b.l / 2, top: b.top }, b.cx - b.rx, b.cz - b.rz, b.cx + b.rx, b.cz + b.rz);
    }
  }
  const mats = [windowMaterial(false), windowMaterial(true)];
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  box.deleteAttribute('uv');
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new V3(), p = new V3();
  for (const c of chunks.values()) {
    for (let gi = 0; gi < 2; gi++) {
      const rects = c.rect[gi];
      if (rects.length) {
        const geo = box.clone();
        const roofAttr = new THREE.InstancedBufferAttribute(new Float32Array(rects.length * 3), 3);
        geo.setAttribute('aRoof', roofAttr);
        const mesh = new THREE.InstancedMesh(geo, mats[gi], rects.length);
        rects.forEach((b, i) => {
          q.setFromAxisAngle(AY, -b.ang);
          p.set(b.cx, b.base, b.cz); s.set(b.w, b.top - b.base, b.l);
          mesh.setMatrixAt(i, m4.compose(p, q, s));
          mesh.setColorAt(i, col.set(b.wall));
          col.set(b.roof); roofAttr.setXYZ(i, col.r, col.g, col.b);
        });
        mesh.computeBoundingSphere();
        mesh.castShadow = mesh.receiveShadow = true;
        scene.add(mesh);
      }
      const polys = c.poly[gi];
      if (polys.length) scene.add(polyMesh(polys, mats[gi]));
    }
  }
}

function polyMesh(list, mat) {
  const pos = [], colr = [], roof = [], idx = [];
  const cw = new THREE.Color(), cr = new THREE.Color();
  for (const b of list) {
    cw.set(b.wall); cr.set(b.roof);
    const rings = b.rings.map((r, ri) => {
      let area = 0;
      for (let i = 0, j = r.n - 1; i < r.n; j = i++) area += r.x[j] * r.z[i] - r.x[i] * r.z[j];
      // walls face outward when the exterior has negative area and holes positive
      const flip = ri === 0 ? area > 0 : area < 0;
      const pts = [];
      for (let i = 0; i < r.n; i++) { const k = flip ? r.n - 1 - i : i; pts.push([r.x[k], r.z[k]]); }
      return pts;
    });
    const top = b.top, base = b.base;
    for (const pts of rings) {
      const start = pos.length / 3;
      for (const [x, z] of pts) {
        pos.push(x, base, z, x, top, z);
        for (let t = 0; t < 2; t++) { colr.push(cw.r, cw.g, cw.b); roof.push(cr.r, cr.g, cr.b); }
      }
      const n = pts.length;
      for (let i = 0; i < n; i++) {
        const a0 = start + i * 2, b0 = start + ((i + 1) % n) * 2;
        idx.push(a0, b0, b0 + 1, a0, b0 + 1, a0 + 1);
      }
    }
    // roof
    const contour = rings[0].map(([x, z]) => new THREE.Vector2(x, z));
    const holes = rings.slice(1).map((r) => r.map(([x, z]) => new THREE.Vector2(x, z)));
    let faces;
    try { faces = THREE.ShapeUtils.triangulateShape(contour, holes); } catch (e) { faces = []; }
    const flat = rings.flat();
    const start = pos.length / 3;
    for (const [x, z] of flat) { pos.push(x, top, z); colr.push(cw.r, cw.g, cw.b); roof.push(cr.r, cr.g, cr.b); }
    for (const [i0, i1, i2] of faces) {
      const A = flat[i0], B = flat[i1], C = flat[i2];
      const ny = (B[1] - A[1]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[1] - A[1]);
      if (ny >= 0) idx.push(start + i0, start + i1, start + i2); else idx.push(start + i0, start + i2, start + i1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  geo.setAttribute('aRoof', new THREE.Float32BufferAttribute(roof, 3));
  geo.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  const m = mat.clone();
  m.vertexColors = true;
  m.onBeforeCompile = mat.onBeforeCompile;
  m.customProgramCacheKey = mat.customProgramCacheKey;
  const mesh = new THREE.Mesh(geo, m);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

/* =========================================================
   Roads, rail, airport, cable cars
   ========================================================= */
const ROAD_STYLE = {
  1: [24, '#45494c', 1.0], 2: [22, '#46494c', 0.95], 3: [19, '#4a4e51', 0.9], 4: [15, '#4f5356', 0.85], 5: [12, '#55585b', 0.8],
  6: [8, '#5d6062', 0.7], 7: [5, '#6a6b69', 0.6], 8: [4, '#8c7c63', 0.55], 9: [7, '#b9b1a3', 0.65],
  10: [5, '#5c524a', 0.75], 11: [3, '#6c625a', 0.75], 31: [20, '#545759', 0.6],
};
let RUNWAYS = [];
function buildRoads() {
  const CH = 6000;
  const buckets = new Map();
  const col = new THREE.Color();
  const maxSeg = LOW ? 90 : 45;
  for (const L of LINES.list) {
    const st = ROAD_STYLE[L.code];
    if (L.code === 30) {
      const len = Math.hypot(L.x[L.n - 1] - L.x[0], L.z[L.n - 1] - L.z[0]);
      const e = L.x[L.n - 1] > L.x[0];   // a = south-west end, b = north-east end
      RUNWAYS.push({ ax: e ? L.x[0] : L.x[L.n - 1], az: e ? L.z[0] : L.z[L.n - 1], bx: e ? L.x[L.n - 1] : L.x[0], bz: e ? L.z[L.n - 1] : L.z[0], len });
      continue;
    }
    if (!st) continue;
    if (LOW && (L.code === 7 || L.code === 8)) continue;
    const [w, hex, lift] = st;
    // densify so the ribbon follows the terrain
    const xs = [L.x[0]], zs = [L.z[0]];
    for (let i = 1; i < L.n; i++) {
      const dx = L.x[i] - L.x[i - 1], dz = L.z[i] - L.z[i - 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / maxSeg));
      for (let s = 1; s <= steps; s++) { xs.push(L.x[i - 1] + dx * s / steps); zs.push(L.z[i - 1] + dz * s / steps); }
    }
    const k = `${Math.floor(xs[0] / CH)},${Math.floor(zs[0] / CH)}`;
    let B = buckets.get(k);
    if (!B) buckets.set(k, (B = { pos: [], col: [], idx: [] }));
    col.set(hex).offsetHSL(0, 0, (hash(L.n, Math.round(xs[0])) - 0.5) * 0.03);
    const n = xs.length, start = B.pos.length / 3;
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(i - 1, 0), i1 = Math.min(i + 1, n - 1);
      let tx = xs[i1] - xs[i0], tz = zs[i1] - zs[i0];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const nx = -tz * w / 2, nz = tx * w / 2;
      const lx = xs[i] + nx, lz = zs[i] + nz, rx = xs[i] - nx, rz = zs[i] - nz;
      B.pos.push(lx, gridH(lx, lz) + lift, lz, rx, gridH(rx, rz) + lift, rz);
      B.col.push(col.r, col.g, col.b, col.r, col.g, col.b);
    }
    for (let i = 0; i < n - 1; i++) {
      const a = start + i * 2, b = a + 2;
      B.idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
  for (const B of buckets.values()) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(B.pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(B.col, 3));
    geo.setIndex(B.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(B.idx, 1) : new THREE.Uint16BufferAttribute(B.idx, 1));
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    scene.add(m);
  }
  RUNWAYS.sort((a, b) => b.len - a.len);
  RUNWAYS = RUNWAYS.filter((r) => r.len > 2000);
  RUNWAYS.forEach(buildRunway);
}

function buildRunway(R) {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 2048;
  const g = cv.getContext('2d');
  g.fillStyle = '#3d4144'; g.fillRect(0, 0, 64, 2048);
  g.fillStyle = '#eceae2';
  for (let y = 70; y < 1980; y += 34) g.fillRect(31, y, 2, 18);
  for (const y of [6, 2042 - 26]) for (let i = 0; i < 8; i++) g.fillRect(5 + i * 7.3, y, 4, 22);
  g.fillRect(2, 0, 1.5, 2048); g.fillRect(60.5, 0, 1.5, 2048);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = MAX_ANISO;
  const dx = (R.bx - R.ax) / R.len, dz = (R.bz - R.az) / R.len;
  R.dx = dx; R.dz = dz;
  const W = 45, nx = -dz * W / 2, nz = dx * W / 2;
  const n = Math.ceil(R.len / 40) + 1;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = R.ax + (R.bx - R.ax) * t, z = R.az + (R.bz - R.az) * t;
    for (const s of [1, -1]) { const px = x + nx * s, pz = z + nz * s; pos.push(px, gridH(px, pz) + 1.0, pz); uv.push(s > 0 ? 0 : 1, t); }
    if (i < n - 1) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -10 }));
  m.receiveShadow = true;
  scene.add(m);
}
function runwayAt(x, z) {
  for (const R of RUNWAYS) {
    const px = x - R.ax, pz = z - R.az;
    const along = px * R.dx + pz * R.dz, across = -px * R.dz + pz * R.dx;
    if (along > 0 && along < R.len && Math.abs(across) < 24) return R;
  }
  return null;
}

const CABINS = [];
function buildCableways() {
  for (const L of LINES.list) {
    if (L.code !== 40 && L.code !== 41) continue;
    const pts = [];
    for (let i = 0; i < L.n; i++) pts.push(new V3(L.x[i], 0, L.z[i]));
    // supports: every data vertex plus extra towers on long spans
    const sup = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const span = pts[i].distanceTo(pts[i - 1]);
      const extra = L.code === 41 ? Math.floor(span / 120) : 0;
      for (let e = 1; e <= extra; e++) sup.push(pts[i - 1].clone().lerp(pts[i], e / (extra + 1)));
      sup.push(pts[i]);
    }
    const tops = sup.map((p, i) => {
      const end = i === 0 || i === sup.length - 1;
      const hgt = end ? 8 : L.code === 41 ? 11 : 26;
      const y = gridH(p.x, p.z);
      if (!end) {
        const t = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.4, hgt, 6).translate(0, hgt / 2, 0), MAT.steel);
        t.position.set(p.x, y, p.z); t.castShadow = true; scene.add(t);
      } else {
        const st = new THREE.Mesh(new THREE.BoxGeometry(14, 10, 14).translate(0, 5, 0), MAT.concrete);
        st.position.set(p.x, y, p.z); st.castShadow = true; scene.add(st);
      }
      return new V3(p.x, y + hgt, p.z);
    });
    const cable = [];
    for (let i = 0; i < tops.length - 1; i++) {
      const a = tops[i], b = tops[i + 1], span = a.distanceTo(b);
      const seg = Math.max(2, Math.ceil(span / 30));
      for (let s = 0; s < seg; s++) {
        const t = s / seg;
        const p = a.clone().lerp(b, t);
        p.y -= Math.sin(t * Math.PI) * span * 0.035;
        cable.push(p);
      }
    }
    cable.push(tops[tops.length - 1]);
    const curve = new THREE.CatmullRomCurve3(cable);
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(Math.min(600, cable.length * 3))), new THREE.LineBasicMaterial({ color: '#2a2f33' })));
    if (L.code === 40) {
      const len = curve.getLength();
      const count = clamp(Math.round(len / 160), 2, 14);
      for (let i = 0; i < count; i++) {
        const cab = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), i % 2 ? MAT.red : MAT.yellow);
        cab.castShadow = true;
        scene.add(cab);
        CABINS.push({ mesh: cab, curve, t: i / count, speed: 5 / len });
      }
    }
  }
}

/* =========================================================
   Lakes as flat water surfaces
   ========================================================= */
function buildLakes() {
  const mat = new THREE.MeshPhongMaterial({ color: '#2e9fb5', shininess: 110, specular: '#ffffff', polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 });
  for (const A of AREAS.list) {
    if (A.code !== 30) continue;
    const r = A.rings[0];
    let area = 0, level = 1e9, minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    for (let i = 0, j = r.n - 1; i < r.n; j = i++) {
      area += r.x[j] * r.z[i] - r.x[i] * r.z[j];
      level = Math.min(level, gridH(r.x[i], r.z[i]));
      minx = Math.min(minx, r.x[i]); maxx = Math.max(maxx, r.x[i]); minz = Math.min(minz, r.z[i]); maxz = Math.max(maxz, r.z[i]);
    }
    if (Math.abs(area) / 2 < 4000) continue;
    const contour = Array.from({ length: r.n }, (_, i) => new THREE.Vector2(r.x[i], r.z[i]));
    const holes = A.rings.slice(1).map((h) => Array.from({ length: h.n }, (_, i) => new THREE.Vector2(h.x[i], h.z[i])));
    let faces;
    try { faces = THREE.ShapeUtils.triangulateShape(contour, holes); } catch (e) { continue; }
    const flat = contour.concat(...holes);
    const y = level + 1.2;
    const pos = new Float32Array(flat.length * 3);
    flat.forEach((v, i) => { pos[i * 3] = v.x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = v.y; });
    const idx = [];
    for (const [a, b, c] of faces) {
      const ny = (flat[b].y - flat[a].y) * (flat[c].x - flat[a].x) - (flat[b].x - flat[a].x) * (flat[c].y - flat[a].y);
      if (ny >= 0) idx.push(a, b, c); else idx.push(a, c, b);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    scene.add(m);
    if (Math.abs(area) / 2 > 15000) LAKES.push({ r, level: y, minx, maxx, minz, maxz });
  }
}
function lakeAt(x, z) {
  for (const L of LAKES) {
    if (x < L.minx || x > L.maxx || z < L.minz || z > L.maxz) continue;
    if (pointInRing(x, z, L.r.x, L.r.z, L.r.n)) return L;
  }
  return null;
}

/* =========================================================
   Trees: street trees, parks and the spruce forests of the Ile Alatau
   ========================================================= */
function insideBuilding(x, z) {
  const l = COLL.get(ckey(Math.floor(x / CC), Math.floor(z / CC)));
  if (!l) return false;
  for (const o of l) if (hitCollider(o, x, z, -1e9, 2)) return true;
  return false;
}
function buildTrees(NRM) {
  const pts = [];
  const budget = LOW ? 14000 : 70000;
  // street trees
  let total = 0;
  const street = LINES.list.filter((L) => L.code >= 3 && L.code <= 6);
  for (const L of street) for (let i = 1; i < L.n; i++) total += Math.hypot(L.x[i] - L.x[i - 1], L.z[i] - L.z[i - 1]);
  const spacing = 16, prob = Math.min(1, (budget * 0.6) / ((total / spacing) * 2));
  for (const L of street) {
    const w = ROAD_STYLE[L.code][0];
    for (let i = 1; i < L.n; i++) {
      const dx = L.x[i] - L.x[i - 1], dz = L.z[i] - L.z[i - 1], len = Math.hypot(dx, dz);
      if (len < 1) continue;
      const nx = -dz / len, nz = dx / len;
      for (let s = rnd() * spacing; s < len; s += spacing) for (const side of [-1, 1]) {
        if (rnd() > prob) continue;
        const off = w / 2 + 3.5;
        const x = L.x[i - 1] + dx * s / len + nx * off * side, z = L.z[i - 1] + dz * s / len + nz * off * side;
        if (gridH(x, z) > 1350 || insideBuilding(x, z)) continue;
        pts.push([x, z, rr(0.85, 1.25), 0]);
      }
    }
  }
  // parks, cemeteries, gardens
  for (const A of AREAS.list) {
    if (A.code !== 1 && A.code !== 4 && A.code !== 2) continue;
    const r = A.rings[0];
    let area = 0, minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    for (let i = 0, j = r.n - 1; i < r.n; j = i++) {
      area += r.x[j] * r.z[i] - r.x[i] * r.z[j];
      minx = Math.min(minx, r.x[i]); maxx = Math.max(maxx, r.x[i]); minz = Math.min(minz, r.z[i]); maxz = Math.max(maxz, r.z[i]);
    }
    if (A.code === 2 && Math.abs(area) / 2 > 60000) continue;
    if (RUNWAYS.some((R) => Math.hypot(r.x[0] - (R.ax + R.bx) / 2, r.z[0] - (R.az + R.bz) / 2) < 3500)) continue;
    const n = Math.round((Math.abs(area) / 2) / (A.code === 2 ? 900 : 260) * (LOW ? 0.3 : 1));
    for (let k = 0, tries = 0; k < n && tries < n * 4; tries++) {
      const x = rr(minx, maxx), z = rr(minz, maxz);
      if (!pointInRing(x, z, r.x, r.z, r.n) || insideBuilding(x, z)) continue;
      pts.push([x, z, rr(0.9, 1.5), 0]);
      k++;
    }
  }
  // river banks
  for (const L of LINES.list) {
    if (L.code !== 20 && L.code !== 22) continue;
    for (let i = 1; i < L.n; i++) {
      const dx = L.x[i] - L.x[i - 1], dz = L.z[i] - L.z[i - 1], len = Math.hypot(dx, dz);
      if (len < 1) continue;
      for (let s = 0; s < len; s += LOW ? 40 : 18) {
        const x = L.x[i - 1] + dx * s / len + rr(-22, 22), z = L.z[i - 1] + dz * s / len + rr(-22, 22);
        const h = gridH(x, z);
        if (h < 1500 && x > OVB.x0 && x < OVB.x1 && z > OVB.z0 && z < OVB.z1 && !insideBuilding(x, z)) pts.push([x, z, rr(1, 1.5), 0]);
      }
    }
  }
  // spruce forests on north-facing slopes between 1500 and 2700 m
  const firs = LOW ? 12000 : 45000;
  for (let k = 0, tries = 0; k < firs && tries < firs * 25; tries++) {
    const x = rr(X0 + 500, X1 - 500), z = rr(-2000, Z1 - 500);
    const h = gridH(x, z);
    if (h < 1450 || h > 2750) continue;
    const i = Math.round((x - X0) / CELL), j = Math.round((z - Z0) / CELL);
    const nzv = NRM[(j * NX + i) * 3 + 2], ny = NRM[(j * NX + i) * 3 + 1];
    if (ny < 0.55) continue;
    const pref = smooth(0.05, -0.3, nzv) * 0.8 + vnoise(x * 0.002, z * 0.002) * 0.6 - 0.35;
    if (rnd() > pref) continue;
    pts.push([x, z, rr(0.8, 1.4), 1]);
    k++;
  }
  // instanced meshes per chunk
  const CHUNK = 5000;
  const groups = new Map();
  for (const p of pts) {
    const k = `${p[3]}:${Math.floor(p[0] / CHUNK)},${Math.floor(p[1] / CHUNK)}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(p);
  }
  const crown = new THREE.IcosahedronGeometry(1, 0);
  const trunk = new THREE.CylinderGeometry(0.25, 0.35, 1, 5).translate(0, 0.5, 0);
  const cone = new THREE.ConeGeometry(1, 1, 6).translate(0, 0.5, 0);
  const leafMat = new THREE.MeshLambertMaterial({ flatShading: true });
  const trunkMat = new THREE.MeshLambertMaterial({ color: '#5b4636' });
  const greens = ['#3f6e35', '#4d7a3a', '#567f3d', '#3b6434', '#6a8a3e', '#7f8f3a', '#8a8a3c'];
  const spruce = ['#1f4a2f', '#24533a', '#2c5a35', '#1b4030'];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new V3(), pp = new V3(), col = new THREE.Color();
  for (const [key, list] of groups) {
    const fir = key[0] === '1';
    if (fir) {
      const im = new THREE.InstancedMesh(cone, leafMat, list.length);
      list.forEach(([x, z, k], i) => {
        m4.makeScale(6 * k, 22 * k, 6 * k).setPosition(x, gridH(x, z) - 1, z);
        im.setMatrixAt(i, m4); im.setColorAt(i, col.set(pick(spruce)));
      });
      im.computeBoundingSphere(); im.castShadow = true; scene.add(im);
    } else {
      const cm = new THREE.InstancedMesh(crown, leafMat, list.length);
      const tm = new THREE.InstancedMesh(trunk, trunkMat, list.length);
      list.forEach(([x, z, k], i) => {
        const y = gridH(x, z), h = 9 * k;
        q.setFromAxisAngle(AY, rnd() * 6);
        pp.set(x, y + h * 0.95, z); s.set(4.4 * k, 6.2 * k, 4.4 * k);
        cm.setMatrixAt(i, m4.compose(pp, q, s)); cm.setColorAt(i, col.set(pick(greens)));
        pp.set(x, y, z); s.set(1.6 * k, h * 0.7, 1.6 * k);
        tm.setMatrixAt(i, m4.compose(pp, q, s));
      });
      cm.computeBoundingSphere(); tm.computeBoundingSphere();
      cm.castShadow = true;
      scene.add(cm, tm);
    }
  }
  return pts.length;
}

function buildClouds() {
  const cc = document.createElement('canvas');
  cc.width = cc.height = 128;
  const g = cc.getContext('2d');
  for (let i = 0; i < 18; i++) {
    const x = 64 + rr(-30, 30), y = 70 + rr(-14, 12), r = rr(18, 34);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  const ct = new THREE.CanvasTexture(cc);
  ct.colorSpace = THREE.SRGBColorSpace;
  const cm = new THREE.SpriteMaterial({ map: ct, depthWrite: false, transparent: true, fog: true });
  for (let i = 0; i < (LOW ? 30 : 60); i++) {
    const sp = new THREE.Sprite(cm);
    const s = rr(900, 2200);
    sp.scale.set(s, s * 0.5, 1);
    sp.position.set(rr(-26000, 26000), rr(3600, 5200), rr(-24000, 26000));
    scene.add(sp);
  }
}

/* =========================================================
   Hand-built landmarks
   ========================================================= */
const OBB = [];
function addObb(x, z, hx, hz, y0, y1, ang = 0) { OBB.push({ x, z, c: Math.cos(ang), s: Math.sin(ang), hx, hz, y0, y1 }); }
const M = (color, opts = {}) => new THREE.MeshLambertMaterial({ color, ...opts });
const MP = (color, shin = 60) => new THREE.MeshPhongMaterial({ color, shininess: shin, specular: '#ffe9a8' });
const MAT = {
  white: M('#efebe2'), stone: M('#d8d0bf'), concrete: M('#cbc6bb'), steel: M('#6f7479'),
  gold: MP('#d9a21b', 80), turq: M('#3aa5a0'), red: M('#c8372d'), yellow: M('#f2b705'), dark: M('#2a3238'),
  field: M('#4f9a42'), track: M('#b1533c'), ice: new THREE.MeshPhongMaterial({ color: '#dff3ff', shininess: 90 }), glass: M('#2e5873'),
};
const LABELS = [];
function mesh(geo, mat, x, y, z, rotY = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.y = rotY;
  m.castShadow = true; m.receiveShadow = true;
  scene.add(m);
  return m;
}
const BOX = (w, h, d) => new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0);
const CYL = (rt, rb, h, seg = 16) => new THREE.CylinderGeometry(rt, rb, h, seg).translate(0, h / 2, 0);
function makeLabel(text, x, y, z) {
  const cv = document.createElement('canvas');
  const g = cv.getContext('2d');
  const font = '600 34px Manrope, "Segoe UI", sans-serif';
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 44;
  cv.width = w; cv.height = 64;
  g.font = font;
  g.fillStyle = 'rgba(8,24,32,0.78)';
  g.beginPath(); if (g.roundRect) g.roundRect(0, 6, w, 52, 26); else g.rect(0, 6, w, 52); g.fill();
  g.fillStyle = '#f2b705'; g.textBaseline = 'middle'; g.fillText(text, 22, 33);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, fog: false, transparent: true }));
  sp.scale.set(0.045 * w / 64, 0.045, 1);
  sp.position.set(x, y, z);
  sp.renderOrder = 5;
  scene.add(sp);
  LABELS.push(sp);
}
const BLINKERS = [], SPINNERS = [];

function buildLandmarks() {
  const G = (p) => gridH(p.x, p.z);
  // Independence Monument
  {
    const { x, z } = LM.monument, y = G(LM.monument) - 0.5;
    mesh(CYL(20, 22, 2, 32), MAT.stone, x, y, z);
    mesh(CYL(13, 14, 3, 32), MAT.white, x, y + 2, z);
    mesh(BOX(4, 24, 4), MAT.white, x, y + 5, z);
    mesh(BOX(5.5, 1.6, 5.5), MAT.gold, x, y + 29, z);
    mesh(new THREE.SphereGeometry(1.8, 12, 8).scale(1.6, 0.8, 0.9), MAT.gold, x, y + 31.5, z);
    mesh(CYL(0.7, 1, 3.6, 8), MAT.gold, x, y + 32, z);
    mesh(new THREE.SphereGeometry(0.8, 10, 8), MAT.gold, x, y + 36.3, z);
    for (const s of [-1, 1]) mesh(BOX(3.4, 0.35, 1), MAT.gold, x + s * 2.2, y + 32.8, z).rotation.z = s * 0.5;
    addObb(x, z, 5, 5, y, y + 38);
    makeLabel('Монумент Независимости', x, y + 70, z);
  }
  // Hotel Kazakhstan: slab with a golden crown; the long side faces Dostyk avenue
  {
    const { x, z } = LM.hotel, y = G(LM.hotel) - 1;
    const body = mesh(BOX(22, 102, 44), windowMaterial(false), x, y, z);
    const roof = new Float32Array(body.geometry.attributes.position.count * 3).fill(0.85);
    body.geometry.setAttribute('aRoof', new THREE.BufferAttribute(roof, 3));
    body.material.color.set('#ece8de');
    for (let i = -5; i <= 5; i++) mesh(BOX(0.9, 102, 0.9), MAT.white, x - 11.3, y, z + i * 4);
    mesh(BOX(18, 6, 36), MAT.white, x, y + 102, z);
    mesh(CYL(15, 15, 3, 24).scale(0.55, 1, 1), MAT.gold, x, y + 108, z);
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2, h = i % 2 ? 11 : 18;
      mesh(BOX(1.6, h, 1.6), MAT.gold, x + Math.sin(a) * 8, y + 111, z + Math.cos(a) * 15, a);
    }
    mesh(new THREE.SphereGeometry(2.4, 12, 8), MAT.gold, x, y + 130, z);
    addObb(x, z, 12, 23, y, y + 132);
    makeLabel('Гостиница «Казахстан»', x, y + 165, z);
  }
  // Ascension Cathedral: east-west axis, bell tower at the west end
  {
    const { x, z } = LM.cathedral, y = G(LM.cathedral) - 0.5;
    const walls = M('#f0d58c'), roofM = M('#4f9c86');
    mesh(BOX(40, 18, 26), walls, x, y, z);
    mesh(BOX(14, 14, 38), walls, x + 2, y, z);
    mesh(BOX(42, 2, 28), roofM, x, y + 18, z);
    mesh(BOX(16, 2, 40), roofM, x + 2, y + 14, z);
    mesh(CYL(7.5, 7.5, 14, 16), walls, x + 2, y + 20, z);
    mesh(new THREE.SphereGeometry(8.5, 18, 12).scale(1, 1.35, 1), MAT.gold, x + 2, y + 39, z);
    mesh(CYL(0.6, 0.6, 9, 6), MAT.gold, x + 2, y + 49, z);
    mesh(BOX(0.6, 0.6, 4.5), MAT.gold, x + 2, y + 55.5, z);
    for (const [dx, dz] of [[-12, -9], [-12, 9], [16, -9], [16, 9]]) {
      mesh(CYL(3, 3, 6, 12), walls, x + dx, y + 20, z + dz);
      mesh(new THREE.SphereGeometry(3.6, 12, 10).scale(1, 1.4, 1), MAT.turq, x + dx, y + 29, z + dz);
      mesh(CYL(0.3, 0.3, 4, 5), MAT.gold, x + dx, y + 33, z + dz);
    }
    mesh(BOX(13, 30, 13), walls, x - 26, y, z);
    mesh(CYL(0.5, 8.5, 12, 4).rotateY(Math.PI / 4), roofM, x - 26, y + 30, z);
    mesh(new THREE.SphereGeometry(2.8, 12, 10).scale(1, 1.4, 1), MAT.gold, x - 26, y + 44, z);
    mesh(CYL(0.3, 0.3, 6, 5), MAT.gold, x - 26, y + 47, z);
    addObb(x, z, 24, 20, y, y + 56);
    addObb(x - 26, z, 7, 7, y, y + 53);
    makeLabel('Вознесенский собор', x, y + 85, z);
  }
  // Central Stadium
  {
    const { x, z } = LM.stadium, y = G(LM.stadium) - 0.5;
    const ring = new THREE.Shape();
    ring.absellipse(0, 0, 105, 140, 0, Math.PI * 2, false, 0);
    const hole = new THREE.Path();
    hole.absellipse(0, 0, 72, 108, 0, Math.PI * 2, true, 0);
    ring.holes.push(hole);
    mesh(new THREE.ExtrudeGeometry(ring, { depth: 20, bevelEnabled: false, curveSegments: 40 }).rotateX(-Math.PI / 2), MAT.concrete, x, y, z);
    mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2).scale(72, 1, 108), MAT.track, x, y + 0.8, z);
    mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2).scale(48, 1, 82), MAT.field, x, y + 1.0, z);
    for (const [dx, dz] of [[-95, -125], [95, -125], [-95, 125], [95, 125]]) {
      mesh(CYL(1.2, 1.6, 52, 6), MAT.concrete, x + dx, y, z + dz);
      mesh(BOX(12, 6, 2), MAT.dark, x + dx, y + 50, z + dz);
      addObb(x + dx, z + dz, 7, 4, y, y + 57);
    }
    addObb(x, z - 124, 105, 17, y, y + 21); addObb(x, z + 124, 105, 17, y, y + 21);
    addObb(x - 88, z, 17, 140, y, y + 21); addObb(x + 88, z, 17, 140, y, y + 21);
    makeLabel('Центральный стадион', x, y + 90, z);
  }
  // Esentai Tower
  {
    const { x, z } = LM.esentai, y = G(LM.esentai) - 1;
    const t = mesh(BOX(30, 150, 30), windowMaterial(true), x, y, z);
    t.geometry.setAttribute('aRoof', new THREE.BufferAttribute(new Float32Array(t.geometry.attributes.position.count * 3).fill(0.3), 3));
    t.material.color.set('#3b6c8c');
    mesh(new THREE.CylinderGeometry(0.1, 21.2, 26, 4).rotateY(Math.PI / 4).translate(0, 13, 0), MAT.glass, x, y + 150, z);
    mesh(CYL(0.5, 0.5, 14, 6), MAT.white, x, y + 170, z);
    addObb(x, z, 16, 16, y, y + 186);
    makeLabel('Esentai Tower', x, y + 215, z);
  }
  // Kok-Tobe: TV tower, Ferris wheel
  {
    const { x, z } = LM.koktobe, y = G(LM.koktobe) - 1;
    const lc = document.createElement('canvas');
    lc.width = 64; lc.height = 256;
    const g = lc.getContext('2d');
    for (let b = 0; b < 4; b++) {
      g.strokeStyle = b % 2 ? '#f4f1ec' : '#d23a2c';
      g.lineWidth = 6;
      const y0 = b * 64;
      g.strokeRect(3, y0 + 3, 58, 58);
      g.beginPath(); g.moveTo(3, y0 + 3); g.lineTo(61, y0 + 61); g.moveTo(61, y0 + 3); g.lineTo(3, y0 + 61); g.stroke();
    }
    const ltex = new THREE.CanvasTexture(lc);
    ltex.wrapS = ltex.wrapT = THREE.RepeatWrapping;
    ltex.repeat.set(3, 9);
    ltex.colorSpace = THREE.SRGBColorSpace;
    const lattice = new THREE.MeshLambertMaterial({ map: ltex, alphaTest: 0.5, side: THREE.DoubleSide });
    mesh(new THREE.CylinderGeometry(3, 26, 300, 3, 1, true).translate(0, 150, 0), lattice, x, y, z);
    mesh(CYL(1.6, 4, 300, 8), MAT.red, x, y, z);
    for (const [hh, r] of [[120, 13], [205, 8.5]]) mesh(CYL(r, r, 6, 16), MAT.white, x, y + hh, z);
    mesh(CYL(0.6, 1.4, 70, 6), MAT.red, x, y + 300, z);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(1.8, 8, 6), new THREE.MeshBasicMaterial({ color: '#ff3b2f' }));
    beacon.position.set(x, y + 371, z);
    scene.add(beacon);
    BLINKERS.push(beacon);
    addObb(x, z, 15, 15, y, y + 120);
    addObb(x, z, 8, 8, y + 120, y + 372);
    const wx = x - 120, wz = z + 60, wy = gridH(wx, wz);
    const fw = new THREE.Group();
    fw.position.set(wx, wy + 30, wz);
    fw.add(new THREE.Mesh(new THREE.TorusGeometry(26, 0.8, 6, 40), MAT.white));
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const sp = new THREE.Mesh(new THREE.BoxGeometry(0.5, 26, 0.5).translate(0, 13, 0), MAT.white);
      sp.rotation.z = a; fw.add(sp);
      const cab = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), i % 2 ? MAT.red : MAT.yellow);
      cab.position.set(Math.cos(a) * 26, Math.sin(a) * 26, 0); fw.add(cab);
    }
    const holder = new THREE.Group();
    holder.rotation.y = 0.6;
    holder.add(fw);
    fw.position.set(0, 0, 0);
    holder.position.set(wx, wy + 30, wz);
    scene.add(holder);
    SPINNERS.push(fw);
    mesh(BOX(4, 30, 4), MAT.concrete, wx, wy, wz);
    addObb(wx, wz, 26, 26, wy, wy + 58, 0.6);
    makeLabel('Кок-Тобе', x, y + 400, z);
  }
  // Medeu: ice rink and stands in the gorge
  {
    const { x, z } = LM.medeu, y = G(LM.medeu) + 0.5;
    const ring = new THREE.Shape();
    ring.absellipse(0, 0, 112, 74, 0, Math.PI * 2, false, 0);
    const hole = new THREE.Path();
    hole.absellipse(0, 0, 80, 46, 0, Math.PI * 2, true, 0);
    ring.holes.push(hole);
    mesh(new THREE.ExtrudeGeometry(ring, { depth: 16, bevelEnabled: false, curveSegments: 40 }).rotateX(-Math.PI / 2).translate(0, -4, 0), MAT.concrete, x, y, z, 0.5);
    mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2).scale(80, 1, 46), MAT.ice, x, y + 1, z, 0.5);
    mesh(BOX(170, 12, 12), MAT.concrete, x, y - 6, z + 25, 0.5);
    addObb(x, z, 112, 74, y - 4, y + 12, 0.5);
    makeLabel('Медеу · 1691 м', x, y + 130, z);
  }
  {
    const p = LM.shymbulak;
    makeLabel('Шымбулак · 2260 м', p.x, gridH(p.x, p.z) + 140, p.z);
    const b = LM.bao;
    makeLabel('Большое Алматинское озеро · 2511 м', b.x, gridH(b.x, b.z) + 140, b.z);
    makeLabel('Озеро Сайран', LM.sairan.x, gridH(LM.sairan.x, LM.sairan.z) + 80, LM.sairan.z);
  }
  // airport: label and parked airliners on the main apron
  if (RUNWAYS.length) {
    const aprons = AREAS.list.filter((A) => A.code === 40).map((A) => {
      const r = A.rings[0];
      let cx = 0, cz = 0;
      for (let i = 0; i < r.n; i++) { cx += r.x[i]; cz += r.z[i]; }
      return { cx: cx / r.n, cz: cz / r.n, r };
    });
    const R = RUNWAYS[0];
    aprons.sort((a, b) => Math.hypot(a.cx - R.ax, a.cz - R.az) - Math.hypot(b.cx - R.ax, b.cz - R.az));
    const ap = aprons[0];
    if (ap) {
      for (let i = 0; i < 3; i++) {
        const px = ap.cx + R.dx * (i - 1) * 75, pz = ap.cz + R.dz * (i - 1) * 75;
        const pl = makePlaneModel(true);
        pl.scale.setScalar(3.2);
        pl.position.set(px, gridH(px, pz) + 8.5, pz);
        pl.rotation.y = Math.atan2(-R.dz, R.dx);
        scene.add(pl);
        addObb(px, pz, 22, 22, gridH(px, pz), gridH(px, pz) + 18);
      }
      makeLabel('Аэропорт Алматы', ap.cx, gridH(ap.cx, ap.cz) + 120, ap.cz);
    }
  }
}

/* =========================================================
   Aircraft model (forward = +Z, left wing = +X)
   ========================================================= */
const AY = new V3(0, 1, 0);
function makePlaneModel(airliner = false) {
  const g = new THREE.Group();
  const body = M('#f5f7f8'), blue = M('#1aa6c4'), gold = MP('#f2b705', 50), dark = M('#23303a');
  const fus = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 0.55, 9.5, 14).rotateX(Math.PI / 2), body);
  g.add(fus);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(1.05, 14, 10).scale(1, 1, 1.3), airliner ? body : blue);
  nose.position.z = 4.75; g.add(nose);
  const stripe = new THREE.Mesh(new THREE.CylinderGeometry(1.07, 0.9, 3, 14, 1, true).rotateX(Math.PI / 2), blue);
  stripe.position.z = -1.6; g.add(stripe);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.8, 12, 8).scale(0.9, 0.75, 1.8), new THREE.MeshPhongMaterial({ color: '#1e3e55', shininess: 120 }));
  canopy.position.set(0, 0.8, 1.6); g.add(canopy);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(13.5, 0.26, 2.3), airliner ? body : blue);
  wing.position.set(0, -0.25, 0.7); g.add(wing);
  for (const s of [1, -1]) {
    const tip = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.3, 2.35), airliner ? blue : gold);
    tip.position.set(s * 6.4, -0.25, 0.7); g.add(tip);
    const nav = new THREE.Mesh(new THREE.SphereGeometry(0.22, 6, 4), new THREE.MeshBasicMaterial({ color: s > 0 ? '#ff3b30' : '#35e06a' }));
    nav.position.set(s * 6.95, -0.2, 0.9); g.add(nav);
  }
  const stab = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.2, 1.3), airliner ? body : blue);
  stab.position.set(0, 0.1, -4.3); g.add(stab);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.22, 2.4, 1.7), airliner ? blue : gold);
  fin.position.set(0, 1.3, -4.3); fin.rotation.x = -0.25; g.add(fin);
  for (const [x, z] of [[1.4, 1.2], [-1.4, 1.2], [0, -4]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.3, 0.15), dark);
    leg.position.set(x, -1.3, z); g.add(leg);
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.3, 10).rotateZ(Math.PI / 2), dark);
    wheel.position.set(x, -1.95, z); g.add(wheel);
  }
  if (!airliner) {
    const prop = new THREE.Group();
    prop.position.z = 5.95;
    prop.add(new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.8, 10).rotateX(Math.PI / 2), gold));
    for (let i = 0; i < 2; i++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.28, 3.6, 0.08), dark);
      blade.rotation.z = i * Math.PI / 2; prop.add(blade);
    }
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1.8, 24), new THREE.MeshBasicMaterial({ color: '#cfd8dc', transparent: true, opacity: 0, depthWrite: false }));
    prop.add(disc);
    g.add(prop);
    g.userData.prop = prop;
    g.userData.disc = disc;
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

/* =========================================================
   Tour
   ========================================================= */
const TOUR = [
  { name: 'Взлёт', title: 'Международный аэропорт Алматы', agl: 160,
    text: 'Главные воздушные ворота Казахстана. Впереди город, за ним стена Заилийского Алатау с вершинами выше 4000 м.' },
  { name: 'Вознесенский собор', at: [43.2602, 76.9555], agl: 95, title: 'Вознесенский кафедральный собор',
    text: 'Деревянный собор высотой 56 м построен в 1907 году по проекту Андрея Зенкова и пережил разрушительное землетрясение 1911 года. Вокруг парк 28 гвардейцев-панфиловцев.' },
  { name: 'Гостиница «Казахстан»', at: [43.2470, 76.9578], agl: 150, title: 'Гостиница «Казахстан»',
    text: '26 этажей и золотая «корона» на крыше. Открыта в 1977 году и долго была самым высоким зданием города.' },
  { name: 'Площадь Республики', at: [43.2396, 76.9454], agl: 75, title: 'Монумент Независимости',
    text: 'Стела на главной площади города. Наверху Золотой воин на крылатом снежном барсе.' },
  { name: 'Центральный стадион', at: [43.23456, 76.9179], agl: 75, title: 'Центральный стадион',
    text: 'Открыт в 1958 году, домашняя арена футбольного клуба «Кайрат». Около 23 тысяч мест.' },
  { name: 'Esentai Tower', at: [43.21795, 76.9291], agl: 110, title: 'Esentai Tower',
    text: 'Небоскрёб высотой 162 м на проспекте аль-Фараби, у самого подножия гор.' },
  { name: 'Телебашня Кок-Тобе', at: [43.22985, 76.9786], ground: 'koktobe', agl: 230, title: 'Телебашня Кок-Тобе',
    text: 'Башня высотой 372 м на горе Кок-Тобе (1983 год) видна из любой точки города. С проспекта Достык сюда поднимается канатная дорога.' },
  { name: 'Каток Медеу', at: [43.15735, 77.0583], agl: 80, title: 'Высокогорный каток «Медеу»',
    text: 'Каток на высоте 1691 м в ущелье Малой Алматинки. На его льду установлено более 200 мировых рекордов. Выше по ущелью плотина, защищающая город от селей.' },
  { name: 'Шымбулак', at: [43.1284, 77.0806], agl: 100, title: 'Горнолыжный курорт Шымбулак',
    text: 'Нижняя станция на высоте 2260 м. От Медеу сюда ведёт гондольная канатная дорога.' },
  { name: 'Большое Алматинское озеро', at: [43.0505, 76.9849], agl: 80, title: 'Большое Алматинское озеро',
    text: 'Бирюзовое озеро на высоте 2511 м в ущелье Большой Алматинки, главный источник питьевой воды города.' },
];
const ringObjs = [];
let START = null;
function buildRings() {
  const R = RUNWAYS[0];
  // take off on runway 23 (towards the city): start at the north-east end
  const dirx = -R.dx, dirz = -R.dz;
  START = { x: R.bx + dirx * 300, z: R.bz + dirz * 300, yaw: Math.atan2(dirx, dirz) };
  TOUR[0].x = R.ax + dirx * 2200; TOUR[0].z = R.az + dirz * 2200;
  TOUR.forEach((t) => {
    if (t.at) { const p = ll(t.at[0], t.at[1]); t.x = p.x; t.z = p.z; }
    const gp = t.ground ? LM[t.ground] : t;
    t.y = gridH(gp.x, gp.z) + t.agl;
    const L = lakeAt(t.x, t.z);
    if (L) t.y = L.level + t.agl;
  });
  const geo = new THREE.TorusGeometry(42, 2.8, 10, 56);
  TOUR.forEach((t, i) => {
    const mat = new THREE.MeshBasicMaterial({ color: '#f2b705', transparent: true, opacity: 0.95, fog: false });
    const ring = new THREE.Mesh(geo, mat);
    ring.position.set(t.x, t.y, t.z);
    const next = TOUR[i + 1] || { x: R.bx, z: R.bz, y: t.y };
    ring.lookAt(next.x, (next.y + t.y) / 2, next.z);
    ring.add(new THREE.Mesh(new THREE.TorusGeometry(42, 6.5, 8, 48), new THREE.MeshBasicMaterial({ color: '#ffd75a', transparent: true, opacity: 0.18, depthWrite: false, fog: false })));
    scene.add(ring);
    ringObjs.push(ring);
  });
}

/* =========================================================
   Minimap
   ========================================================= */
const MAPRES = 1024;
let mapCanvas = null;
function buildMinimap(ground) {
  mapCanvas = document.createElement('canvas');
  mapCanvas.width = mapCanvas.height = MAPRES;
  const g = mapCanvas.getContext('2d');
  const img = g.createImageData(MAPRES, MAPRES);
  const c = new THREE.Color();
  const W = X1 - X0, H = Z1 - Z0, S = Math.max(W, H);
  for (let py = 0; py < MAPRES; py++) for (let px = 0; px < MAPRES; px++) {
    const x = X0 + (px + 0.5) / MAPRES * S, z = Z0 + (py + 0.5) / MAPRES * S;
    const h = gridH(x, z);
    const shade = clamp(1 + (gridH(x - 60, z - 60) - h) * 0.008, 0.55, 1.35);
    if (h < 1000) c.set('#6a8048'); else if (h < 1600) c.set('#5f7444'); else if (h < 2700) c.set('#3a5a3c'); else if (h < 3350) c.set('#7a766e'); else c.set('#e8eef2');
    const i = (py * MAPRES + px) * 4;
    img.data[i] = clamp(c.r ** (1 / 2.2) * 255 * shade, 0, 255); img.data[i + 1] = clamp(c.g ** (1 / 2.2) * 255 * shade, 0, 255);
    img.data[i + 2] = clamp(c.b ** (1 / 2.2) * 255 * shade, 0, 255); img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const k = MAPRES / S;
  g.drawImage(ground, (OVB.x0 - X0) * k, (OVB.z0 - Z0) * k, (OVB.x1 - OVB.x0) * k, (OVB.z1 - OVB.z0) * k);
  g.lineCap = 'round';
  for (const [codes, color, w] of [[[5, 4], 'rgba(240,236,224,0.55)', 0.8], [[3, 2, 1], 'rgba(255,214,120,0.85)', 1.4]]) {
    g.strokeStyle = color; g.lineWidth = w;
    g.beginPath();
    for (const L of LINES.list) {
      if (!codes.includes(L.code)) continue;
      for (let i = 0; i < L.n; i++) { const X = (L.x[i] - X0) * k, Z = (L.z[i] - Z0) * k; i ? g.lineTo(X, Z) : g.moveTo(X, Z); }
    }
    g.stroke();
  }
  g.fillStyle = '#3fb0c8';
  for (const L of LAKES) {
    g.beginPath();
    for (let i = 0; i < L.r.n; i++) { const X = (L.r.x[i] - X0) * k, Z = (L.r.z[i] - Z0) * k; i ? g.lineTo(X, Z) : g.moveTo(X, Z); }
    g.fill();
  }
  g.strokeStyle = '#1f2326'; g.lineWidth = 3;
  for (const R of RUNWAYS) { g.beginPath(); g.moveTo((R.ax - X0) * k, (R.az - Z0) * k); g.lineTo((R.bx - X0) * k, (R.bz - Z0) * k); g.stroke(); }
  mapCanvas.userData = { k, S };
}
const mm = $('minimap'), mctx = mm.getContext('2d');
function drawMinimap() {
  const W = mm.width, R = W / 2;
  const range = 5000;
  const { k } = mapCanvas.userData;
  const p = P.pos;
  mctx.save();
  mctx.clearRect(0, 0, W, W);
  mctx.beginPath(); mctx.arc(R, R, R, 0, Math.PI * 2); mctx.clip();
  mctx.fillStyle = '#6a8048'; mctx.fillRect(0, 0, W, W);
  mctx.drawImage(mapCanvas, (p.x - range - X0) * k, (p.z - range - Z0) * k, 2 * range * k, 2 * range * k, 0, 0, W, W);
  const toM = (x, z) => [R + (x - p.x) / range * R, R + (z - p.z) / range * R];
  const dot = (x, z, color, r) => {
    let [mx, my] = toM(x, z);
    const dx = mx - R, dy = my - R, d = Math.hypot(dx, dy);
    if (d > R - 10) { mx = R + dx / d * (R - 10); my = R + dy / d * (R - 10); }
    mctx.fillStyle = color; mctx.beginPath(); mctx.arc(mx, my, r, 0, Math.PI * 2); mctx.fill();
  };
  if (mode === 'tour') {
    for (let i = TOUR.length - 1; i >= tourIdx; i--) dot(TOUR[i].x, TOUR[i].z, i === tourIdx ? '#f2b705' : 'rgba(242,183,5,0.45)', i === tourIdx ? 9 : 5);
    if (tourIdx >= TOUR.length) { const R0 = RUNWAYS[0]; dot((R0.ax + R0.bx) / 2, (R0.az + R0.bz) / 2, '#63d692', 9); }
  }
  axes();
  const ang = Math.atan2(_f.z, _f.x);
  mctx.translate(R, R); mctx.rotate(ang + Math.PI / 2);
  mctx.fillStyle = '#ffffff'; mctx.strokeStyle = '#08161e'; mctx.lineWidth = 3;
  mctx.beginPath(); mctx.moveTo(0, -16); mctx.lineTo(11, 12); mctx.lineTo(0, 6); mctx.lineTo(-11, 12); mctx.closePath(); mctx.stroke(); mctx.fill();
  mctx.restore();
  mctx.fillStyle = '#eef6f5'; mctx.font = '700 22px "JetBrains Mono", monospace'; mctx.textAlign = 'center';
  mctx.fillText('С', R, 26);
}

/* =========================================================
   Flight model
   ========================================================= */
const STALL = 45, GEAR = 2.7;
const P = { pos: new V3(), q: new THREE.Quaternion(), vel: new V3(), speed: 0, throttle: 0, onGround: true, crashed: false };
const _f = new V3(), _u = new V3(), _r = new V3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const AX = new V3(1, 0, 0), AZ = new V3(0, 0, 1);
function axes() { _f.set(0, 0, 1).applyQuaternion(P.q); _u.set(0, 1, 0).applyQuaternion(P.q); _r.set(-1, 0, 0).applyQuaternion(P.q); }
const rotLocal = (axis, a) => { P.q.multiply(_q.setFromAxisAngle(axis, a)); };
const rotWorldY = (a) => { P.q.premultiply(_q.setFromAxisAngle(AY, a)); };
const opts = { assist: true, invert: false, sound: true };
const input = { pitch: 0, roll: 0, yaw: 0, boost: false };
const keys = new Set();
const touchStick = { x: 0, y: 0 };
let touchRud = 0, touchThr = null, touchBoost = false;

function groundAt(x, z) {
  let h = gridH(x, z), water = false;
  if (runwayAt(x, z)) h += 1.0;
  const L = lakeAt(x, z);
  if (L && L.level > h) { h = L.level; water = true; }
  return { h, water };
}
function hitCollider(o, x, z, y, r) {
  if (o.t === 0) {
    if (y > o.top + 2) return false;
    const dx = x - o.x, dz = z - o.z;
    const lx = dx * o.c + dz * o.s, lz = -dx * o.s + dz * o.c;
    return Math.abs(lx) < o.hw + r && Math.abs(lz) < o.hl + r;
  }
  const b = o.b;
  if (y > b.top + 2 || x < b.bx0 - r || x > b.bx1 + r || z < b.bz0 - r || z > b.bz1 + r) return false;
  const ring = b.rings[0];
  return pointInRing(x, z, ring.x, ring.z, ring.n) || r > 0 && (pointInRing(x + r, z, ring.x, ring.z, ring.n) || pointInRing(x - r, z, ring.x, ring.z, ring.n) || pointInRing(x, z + r, ring.x, ring.z, ring.n) || pointInRing(x, z - r, ring.x, ring.z, ring.n));
}
function hitsObstacle(p) {
  const r = 4.5;
  const l = COLL.get(ckey(Math.floor(p.x / CC), Math.floor(p.z / CC)));
  if (l) for (const o of l) if (hitCollider(o, p.x, p.z, p.y, r)) return true;
  for (const o of OBB) {
    if (p.y < o.y0 - 2 || p.y > o.y1 + 2) continue;
    const dx = p.x - o.x, dz = p.z - o.z;
    const lx = dx * o.c - dz * o.s, lz = dx * o.s + dz * o.c;
    if (Math.abs(lx) < o.hx + r && Math.abs(lz) < o.hz + r) return true;
  }
  return false;
}

function readInput(dt) {
  const k = (...c) => c.some((x) => keys.has(x));
  let pitch = (k('ArrowUp', 'KeyW') ? 1 : 0) - (k('ArrowDown', 'KeyS') ? 1 : 0);
  let roll = (k('ArrowRight', 'KeyD') ? 1 : 0) - (k('ArrowLeft', 'KeyA') ? 1 : 0);
  let yaw = (k('KeyE') ? 1 : 0) - (k('KeyQ') ? 1 : 0);
  const thr = (k('ShiftLeft', 'ShiftRight', 'Equal', 'NumpadAdd', 'KeyR') ? 1 : 0) - (k('ControlLeft', 'ControlRight', 'Minus', 'NumpadSubtract', 'KeyF') ? 1 : 0);
  if (isTouch) { pitch += -touchStick.y; roll += touchStick.x; yaw += touchRud; }
  if (opts.invert) pitch = -pitch;
  const ease = (cur, tgt, rate) => cur + clamp(tgt - cur, -rate * dt, rate * dt);
  input.pitch = ease(input.pitch, clamp(pitch, -1, 1), 5);
  input.roll = ease(input.roll, clamp(roll, -1, 1), 6);
  input.yaw = ease(input.yaw, clamp(yaw, -1, 1), 5);
  input.boost = k('Space') || touchBoost;
  if (touchThr !== null) P.throttle = touchThr;
  else P.throttle = clamp(P.throttle + thr * dt * 0.55, 0, 1);
}

function physics(dt) {
  axes();
  const eff = clamp((P.speed - 12) / 70, 0.12, 1);
  if (!P.onGround) {
    rotLocal(AX, -input.pitch * 0.95 * eff * dt);
    rotLocal(AZ, input.roll * 2.2 * eff * dt);
    rotLocal(AY, -input.yaw * 0.55 * eff * dt);
    axes();
    const bank = Math.atan2(-_r.y, _u.y);
    const turn = Math.sin(bank) * 0.95 * eff * clamp(_u.y * 1.5, 0, 1);
    rotWorldY(-turn * dt);
    if (opts.assist && Math.abs(input.roll) < 0.05 && Math.abs(bank) < 1.4) rotLocal(AZ, -bank * 1.3 * dt);
    if (P.speed < STALL) rotLocal(AX, (STALL - P.speed) / STALL * 1.0 * dt);
    P.q.normalize();
  } else {
    _e.setFromQuaternion(P.q, 'YXZ');
    let yaw = _e.y, nose = -_e.x;
    yaw -= (input.yaw + input.roll) * 0.7 * dt * clamp(P.speed / 25, 0.25, 1);
    if (input.pitch > 0 && P.speed > 38) nose += input.pitch * 0.5 * dt;
    else nose -= 0.6 * dt;
    nose = clamp(nose, 0, 0.3);
    P.q.setFromEuler(_e.set(-nose, yaw, 0, 'YXZ'));
  }
  axes();
  const boosting = input.boost && P.throttle > 0.05 && !P.onGround;
  const thrust = P.throttle * 62 * (boosting ? 1.9 : 1);
  let drag = 0.00155 * P.speed * P.speed;
  if (P.onGround) drag += P.throttle < 0.05 ? 14 : 2;
  P.speed += (thrust - drag - 9.8 * _f.y * 2.2) * dt;
  P.speed = Math.max(0, P.speed);
  P.vel.copy(_f).multiplyScalar(P.speed);
  if (P.onGround) {
    P.vel.y = Math.max(0, P.vel.y);
    _e.setFromQuaternion(P.q, 'YXZ');
    if (-_e.x > 0.05 && P.speed > STALL + 4) { P.onGround = false; P.vel.y = Math.max(P.vel.y, 2); }
  } else {
    P.vel.y -= clamp((STALL - P.speed) / STALL, 0, 1) * 32;
  }
  P.pos.addScaledVector(P.vel, dt);

  const gr = groundAt(P.pos.x, P.pos.z);
  if (P.onGround) {
    if (gr.water) return crash('Самолёт ушёл под воду. Над озером держите высоту.');
    P.pos.y = gr.h + GEAR;
    if (slopeAt(P.pos.x, P.pos.z) > 0.2) return crash('Слишком крутой склон для посадки.');
  } else if (P.pos.y - GEAR < gr.h) {
    const bank = Math.atan2(-_r.y, _u.y), pa = Math.asin(clamp(_f.y, -1, 1));
    const vs = P.vel.y;
    if (gr.water) return crash('Самолёт упал в озеро. Над водой держите высоту.');
    if (vs > -11 && Math.abs(bank) < 0.35 && pa > -0.14 && pa < 0.45 && slopeAt(P.pos.x, P.pos.z) < 0.14 && _u.y > 0.8) {
      P.onGround = true;
      P.pos.y = gr.h + GEAR;
      _e.setFromQuaternion(P.q, 'YXZ');
      P.q.setFromEuler(_e.set(Math.min(_e.x, 0), _e.y, 0, 'YXZ'));
      showToast('Касание', runwayAt(P.pos.x, P.pos.z) ? 'Посадка на полосу' : 'Посадка в поле', 'Сбросьте газ, чтобы остановиться, или разгонитесь и взлетайте.', 3500);
    } else {
      return crash(vs < -11 ? `Слишком резкое снижение: ${Math.round(-vs)} м/с. Касайтесь земли плавно, не быстрее 10 м/с.` : 'Самолёт задел землю. Следите за высотой и креном.');
    }
  }
  if (hitsObstacle(P.pos)) return crash('Столкновение со зданием. Облетайте дома или поднимайтесь выше.');
}

/* =========================================================
   Game state
   ========================================================= */
let mode = 'menu', tourIdx = 0, lastRing = -1, timer = 0, timerOn = false, crashes = 0, paused = false;
let camMode = 0;
let plane = null, explosion = null;

function placeOnRunway() {
  P.pos.set(START.x, groundAt(START.x, START.z).h + GEAR, START.z);
  P.q.setFromEuler(_e.set(0, START.yaw, 0, 'YXZ'));
  P.speed = 0; P.throttle = 0; P.onGround = true; P.crashed = false;
}
function startGame(m) {
  mode = m;
  tourIdx = 0; lastRing = -1; timer = 0; timerOn = false; crashes = 0;
  placeOnRunway();
  ringObjs.forEach((r) => { r.visible = m === 'tour'; });
  $('menu').hidden = $('finish').hidden = $('crash').hidden = $('pause').hidden = true;
  $('hud').hidden = false;
  $('touch').hidden = !isTouch;
  $('pointer').hidden = m !== 'tour';
  paused = false;
  explosion.visible = false;
  camSnap = true;
  audio.start();
  updateMission();
  showToast('Аэропорт Алматы', m === 'tour' ? 'Экскурсия начинается' : 'Свободный полёт',
    isTouch ? 'Проведите по полосе «ГАЗ» вверх. После 180 км/ч потяните джойстик вверх, чтобы поднять нос. Кнопка ≫ — форсаж.'
      : 'Зажмите Shift, чтобы прибавить газ. После 180 км/ч нажмите ↑, чтобы поднять нос и взлететь. Пробел — форсаж.', 8000);
}
function toMenu() {
  mode = 'menu';
  $('hud').hidden = true; $('touch').hidden = true;
  $('pause').hidden = $('crash').hidden = $('finish').hidden = true;
  $('menu').hidden = false;
  ringObjs.forEach((r) => { r.visible = true; });
  paused = false;
  audio.stop();
  refreshBest();
}
const BEST_KEY = 'almaty-flight-best-v2';
function refreshBest() {
  const b = parseFloat(store.get(BEST_KEY));
  $('best-line').textContent = b ? `Ваш рекорд экскурсии: ${fmtTime(b)}` : 'Рекорда пока нет. Пройдите экскурсию первым.';
}
const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

function crash(msg) {
  if (P.crashed) return;
  P.crashed = true;
  crashes++;
  explosion.position.copy(P.pos);
  explosion.visible = true;
  explosion.userData.t = 0;
  explosion.userData.parts.forEach((p) => { p.v.set(rr(-1, 1), rr(0.2, 1.4), rr(-1, 1)).multiplyScalar(rr(20, 55)); p.m.position.set(0, 0, 0); p.m.scale.setScalar(rr(2, 5)); });
  P.speed = 0;
  audio.boom();
  $('crash-text').textContent = msg;
  $('crash-title').textContent = pick(['Самолёт разбился', 'Неудачный манёвр', 'Авария']);
  setTimeout(() => { if (P.crashed && mode !== 'menu') $('crash').hidden = false; }, 1100);
}
function respawn() {
  $('crash').hidden = true;
  P.crashed = false;
  explosion.visible = false;
  if (mode === 'tour' && lastRing >= 0) {
    const r = TOUR[lastRing];
    const R = RUNWAYS[0];
    const n = TOUR[lastRing + 1] || { x: R.bx, z: R.bz };
    P.pos.set(r.x, r.y, r.z);
    P.q.setFromEuler(_e.set(0, Math.atan2(n.x - r.x, n.z - r.z), 0, 'YXZ'));
    P.speed = 120; P.throttle = 0.75; P.onGround = false;
  } else if (mode === 'free' && Math.hypot(P.pos.x - START.x, P.pos.z - START.z) > 5000) {
    _e.setFromQuaternion(P.q, 'YXZ');
    const yaw = _e.y;
    P.pos.y = groundAt(P.pos.x, P.pos.z).h + 400;
    P.q.setFromEuler(_e.set(0, yaw, 0, 'YXZ'));
    P.speed = 120; P.throttle = 0.75; P.onGround = false;
  } else {
    placeOnRunway();
  }
  camSnap = true;
}

function target() {
  if (mode !== 'tour') return null;
  if (tourIdx < TOUR.length) return TOUR[tourIdx];
  const R = RUNWAYS[0];
  return { name: 'Посадка в аэропорту', x: R.ax - R.dx * 1500, z: R.az - R.dz * 1500, landing: true };
}
function updateMission() {
  if (mode === 'tour') {
    const t = target();
    $('m-step').textContent = t.landing ? 'Финал' : `Кольцо ${tourIdx + 1} из ${TOUR.length}`;
    $('m-name').textContent = t.name;
  } else {
    $('m-step').textContent = 'Свободный полёт';
    $('m-name').textContent = 'Алматы и Заилийский Алатау';
  }
  $('m-crash').innerHTML = crashes ? `аварий <b>${crashes}</b>` : '';
}
function checkRings() {
  if (mode !== 'tour' || P.crashed) return;
  if (tourIdx < TOUR.length) {
    const t = TOUR[tourIdx];
    if (P.pos.distanceTo(ringObjs[tourIdx].position) < 46) {
      ringObjs[tourIdx].visible = false;
      lastRing = tourIdx;
      tourIdx++;
      audio.chime();
      showToast(`Кольцо ${tourIdx} из ${TOUR.length}`, t.title, t.text + (tourIdx === TOUR.length ? ' Теперь летите в аэропорт и садитесь на полосу.' : ''), 9000);
      updateMission();
    }
  } else if (P.onGround && runwayAt(P.pos.x, P.pos.z) && P.speed < 22) {
    finish();
  }
}
function finish() {
  mode = 'done';
  const prev = parseFloat(store.get(BEST_KEY));
  const best = prev ? Math.min(prev, timer) : timer;
  store.set(BEST_KEY, String(best));
  $('f-time').textContent = fmtTime(timer);
  $('f-crash').textContent = String(crashes);
  $('f-best').textContent = fmtTime(best);
  $('f-text').textContent = !prev || timer < prev ? 'Это новый рекорд! Попробуйте пролететь маршрут ещё быстрее.' : `До рекорда не хватило ${(timer - prev).toFixed(1)} с.`;
  $('finish').hidden = false;
  $('touch').hidden = true;
  audio.chime();
}

/* =========================================================
   Camera
   ========================================================= */
let camSnap = true;
const camPos = new V3(), camLook = new V3(), _tmp = new V3(), _tmp2 = new V3();
function updateCamera(dt, t) {
  if (mode === 'menu') {
    const a = t * 0.03 + 2.2;
    camera.position.set(1500 + Math.cos(a) * 5200, 2300 + Math.sin(a * 0.7) * 200, -2500 + Math.sin(a) * 5200);
    camera.up.set(0, 1, 0);
    camera.lookAt(1200, 1000, 1500);
    return;
  }
  axes();
  if (camMode === 2) {
    camera.position.copy(P.pos).addScaledVector(_f, 1.2).addScaledVector(_u, 1.25);
    camera.up.copy(_u);
    camera.lookAt(_tmp.copy(P.pos).addScaledVector(_f, 100).addScaledVector(_u, 1.25));
    return;
  }
  const back = camMode === 0 ? 34 : 95, up = camMode === 0 ? 9 : 30;
  const focus = P.crashed ? explosion.position : P.pos;
  _tmp.copy(focus).addScaledVector(_f, -back).addScaledVector(_u, up * 0.6);
  _tmp.y += up * 0.4;
  const minY = groundAt(_tmp.x, _tmp.z).h + 3;
  if (_tmp.y < minY) _tmp.y = minY;
  _tmp2.copy(focus).addScaledVector(_f, 25);
  if (camSnap) { camPos.copy(_tmp); camLook.copy(_tmp2); camSnap = false; }
  camPos.lerp(_tmp, 1 - Math.exp(-dt * (P.crashed ? 1.5 : 6)));
  camLook.lerp(_tmp2, 1 - Math.exp(-dt * 10));
  camera.position.copy(camPos);
  camera.up.lerp(_tmp.set(0, 1, 0).lerp(_u, 0.35).normalize(), 1 - Math.exp(-dt * 4));
  camera.lookAt(camLook);
}

/* =========================================================
   HUD
   ========================================================= */
let toastTimer = 0;
function showToast(eyebrow, title, text, ms) {
  $('t-eyebrow').textContent = eyebrow;
  $('t-title').textContent = title;
  $('t-text').textContent = text;
  $('toast').classList.remove('hide');
  toastTimer = ms / 1000;
}
let hudAcc = 0;
function updateHud(dt) {
  if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) $('toast').classList.add('hide'); }
  hudAcc += dt;
  if (hudAcc < 0.08) return;
  hudAcc = 0;
  axes();
  $('g-spd').textContent = String(Math.round(P.speed * 3.6));
  $('g-alt').textContent = String(Math.round(P.pos.y));
  const hdg = (Math.atan2(_f.x, -_f.z) * 180 / Math.PI + 360) % 360;
  $('g-hdg').textContent = `${String(Math.round(hdg) % 360).padStart(3, '0')}°`;
  $('g-vs').textContent = `${P.vel.y >= 0 ? '+' : '−'}${Math.abs(P.vel.y).toFixed(0)} м/с`;
  $('g-thr').style.width = `${Math.round(P.throttle * 100)}%`;
  $('g-thr-t').textContent = input.boost && !P.onGround ? 'ФОРСАЖ' : `${Math.round(P.throttle * 100)}%`;
  $('thr-fill').style.height = `${Math.round(P.throttle * 100)}%`;
  $('m-time').textContent = mode === 'tour' ? fmtTime(timer) : '';
  const t = target();
  if (t) {
    const dx = t.x - P.pos.x, dz = t.z - P.pos.z;
    const dist = Math.hypot(dx, dz);
    $('m-dist').innerHTML = `<b>${dist > 1000 ? (dist / 1000).toFixed(1) + ' км' : Math.round(dist) + ' м'}</b>`;
    const rel = Math.atan2(_f.x * dz - _f.z * dx, _f.x * dx + _f.z * dz);
    $('p-arrow').style.transform = `rotate(${(-rel * 180 / Math.PI).toFixed(1)}deg)`;
    if (t.landing) $('p-alt').textContent = 'полоса 05 · садитесь';
    else {
      const dy = t.y - P.pos.y;
      $('p-alt').textContent = Math.abs(dy) < 25 ? 'высота в норме' : dy > 0 ? `выше на ${Math.round(dy)} м` : `ниже на ${Math.round(-dy)} м`;
    }
  } else $('m-dist').textContent = '';
  let w = '';
  if (!P.crashed && !P.onGround) {
    const ahead = _tmp.copy(P.pos).addScaledVector(P.vel, 2.5);
    if (ahead.y < groundAt(ahead.x, ahead.z).h + 8 && P.vel.length() > 30) w = 'НАБЕРИТЕ ВЫСОТУ';
    else if (P.speed < STALL + 3) w = 'СВАЛИВАНИЕ · ДОБАВЬТЕ ГАЗ';
    else if (P.pos.x < X0 + 3000 || P.pos.x > X1 - 3000 || P.pos.z < Z0 + 3000 || P.pos.z > Z1 - 3000) w = 'КРАЙ КАРТЫ · РАЗВОРАЧИВАЙТЕСЬ';
  }
  const we = $('warn');
  if (w) { we.textContent = w; we.hidden = false; we.classList.add('blink'); } else we.hidden = true;
  drawMinimap();
}

/* =========================================================
   Audio
   ========================================================= */
const audio = (() => {
  let ctx = null, eng = null, eng2 = null, engGain = null, wind = null, windGain = null, filt = null, master = null;
  function init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination);
    filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 600;
    engGain = ctx.createGain(); engGain.gain.value = 0;
    eng = ctx.createOscillator(); eng.type = 'sawtooth'; eng.frequency.value = 50;
    eng2 = ctx.createOscillator(); eng2.type = 'square'; eng2.frequency.value = 25;
    const g2 = ctx.createGain(); g2.gain.value = 0.35;
    eng.connect(filt); eng2.connect(g2); g2.connect(filt); filt.connect(engGain); engGain.connect(master);
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    wind = ctx.createBufferSource(); wind.buffer = buf; wind.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.6;
    windGain = ctx.createGain(); windGain.gain.value = 0;
    wind.connect(bp); bp.connect(windGain); windGain.connect(master);
    eng.start(); eng2.start(); wind.start();
  }
  return {
    start() { if (!opts.sound) return; if (!ctx) init(); if (ctx && ctx.state === 'suspended') ctx.resume(); },
    stop() { if (ctx) { engGain.gain.setTargetAtTime(0, ctx.currentTime, 0.1); windGain.gain.setTargetAtTime(0, ctx.currentTime, 0.1); } },
    update() {
      if (!ctx) return;
      const on = opts.sound && !paused && !P.crashed && (mode === 'tour' || mode === 'free');
      const f = 38 + P.throttle * 55 + P.speed * 0.15 + (input.boost ? 20 : 0);
      eng.frequency.setTargetAtTime(f, ctx.currentTime, 0.1);
      eng2.frequency.setTargetAtTime(f / 2 + 1.5, ctx.currentTime, 0.1);
      filt.frequency.setTargetAtTime(350 + P.throttle * 900, ctx.currentTime, 0.1);
      engGain.gain.setTargetAtTime(on ? 0.08 + P.throttle * 0.14 : 0, ctx.currentTime, 0.08);
      windGain.gain.setTargetAtTime(on ? clamp(P.speed / 250, 0, 1) * 0.12 : 0, ctx.currentTime, 0.1);
    },
    chime() {
      if (!ctx || !opts.sound) return;
      [880, 1318.5].forEach((fr, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = fr;
        g.gain.setValueAtTime(0, ctx.currentTime + i * 0.12);
        g.gain.linearRampToValueAtTime(0.25, ctx.currentTime + i * 0.12 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + 0.6);
        o.connect(g); g.connect(master); o.start(ctx.currentTime + i * 0.12); o.stop(ctx.currentTime + i * 0.12 + 0.7);
      });
    },
    boom() {
      if (!ctx || !opts.sound) return;
      const src = ctx.createBufferSource(); src.buffer = wind.buffer;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 300;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.9, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.4);
      src.connect(lp); lp.connect(g); g.connect(master); src.start(); src.stop(ctx.currentTime + 1.5);
    },
  };
})();

/* =========================================================
   Input wiring
   ========================================================= */
const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'Space', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract', 'KeyR', 'KeyF']);
const playing = () => mode === 'tour' || mode === 'free';
addEventListener('keydown', (e) => {
  if (playing() && GAME_KEYS.has(e.code)) e.preventDefault();
  keys.add(e.code);
  if (!playing()) return;
  if (e.code === 'KeyC') cycleCam();
  if (e.code === 'KeyM') toggleSound();
  if (e.code === 'Escape' || e.code === 'KeyP') togglePause();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); if (playing() && !P.crashed) setPause(true); });
function cycleCam() { camMode = (camMode + 1) % 3; camSnap = true; }
function toggleSound() { opts.sound = !opts.sound; $('o-sound').checked = opts.sound; $('b-snd').style.opacity = opts.sound ? 1 : 0.45; if (opts.sound) audio.start(); }
function setPause(v) { if (!playing() || P.crashed) return; paused = v; $('pause').hidden = !v; }
function togglePause() { setPause(!paused); }

$('b-tour').onclick = () => startGame('tour');
$('b-free').onclick = () => startGame('free');
$('b-resume').onclick = () => setPause(false);
$('b-restart').onclick = () => startGame(mode === 'done' ? 'tour' : mode);
$('b-menu').onclick = toMenu;
$('b-respawn').onclick = respawn;
$('b-crash-menu').onclick = toMenu;
$('b-again').onclick = () => startGame('tour');
$('b-fin-free').onclick = () => startGame('free');
$('b-cam').onclick = cycleCam;
$('b-snd').onclick = toggleSound;
$('b-pause').onclick = togglePause;
$('o-assist').onchange = (e) => { opts.assist = e.target.checked; };
$('o-invert').onchange = (e) => { opts.invert = e.target.checked; };
$('o-sound').onchange = (e) => { opts.sound = e.target.checked; $('b-snd').style.opacity = opts.sound ? 1 : 0.45; };

(() => {
  const stick = $('stick'), knob = $('knob');
  let id = null;
  const set = (e) => {
    const r = stick.getBoundingClientRect();
    let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2), dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const d = Math.hypot(dx, dy);
    if (d > 1) { dx /= d; dy /= d; }
    touchStick.x = dx; touchStick.y = dy;
    knob.style.transform = `translate(${dx * 44}px, ${dy * 44}px)`;
  };
  stick.addEventListener('pointerdown', (e) => { id = e.pointerId; stick.setPointerCapture(id); set(e); });
  stick.addEventListener('pointermove', (e) => { if (e.pointerId === id) set(e); });
  const end = (e) => { if (e.pointerId !== id) return; id = null; touchStick.x = touchStick.y = 0; knob.style.transform = ''; };
  stick.addEventListener('pointerup', end); stick.addEventListener('pointercancel', end);
  const pad = $('thr-pad');
  let tid = null;
  const setT = (e) => { const r = pad.getBoundingClientRect(); touchThr = clamp(1 - (e.clientY - r.top) / r.height, 0, 1); };
  pad.addEventListener('pointerdown', (e) => { tid = e.pointerId; pad.setPointerCapture(tid); setT(e); });
  pad.addEventListener('pointermove', (e) => { if (e.pointerId === tid) setT(e); });
  const endT = (e) => { if (e.pointerId === tid) tid = null; };
  pad.addEventListener('pointerup', endT); pad.addEventListener('pointercancel', endT);
  const hold = (el, on, off) => {
    el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); on(); });
    el.addEventListener('pointerup', off); el.addEventListener('pointercancel', off);
  };
  hold($('rud-l'), () => { touchRud = -1; }, () => { touchRud = 0; });
  hold($('rud-r'), () => { touchRud = 1; }, () => { touchRud = 0; });
  hold($('boost'), () => { touchBoost = true; }, () => { touchBoost = false; });
})();
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
});
document.addEventListener('visibilitychange', () => { if (document.hidden && playing() && !P.crashed) setPause(true); });

/* =========================================================
   Main loop
   ========================================================= */
let last = performance.now(), clockT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  clockT += dt;
  if (playing() && !paused) {
    if (!P.crashed) {
      readInput(dt);
      for (let i = 0; i < 3 && !P.crashed; i++) physics(dt / 3);
      if (mode === 'tour' && (P.speed > 1 || !P.onGround)) timerOn = true;
      if (mode === 'tour' && timerOn) timer += dt;
      checkRings();
    }
  } else if (mode === 'done') {
    readInput(dt);
    physics(dt);
  }
  if (explosion.visible) {
    const u = explosion.userData;
    u.t += dt;
    u.parts.forEach((p) => {
      p.v.y -= 25 * dt;
      p.m.position.addScaledVector(p.v, dt);
      p.m.scale.multiplyScalar(1 + dt * 0.8);
      p.m.material.opacity = Math.max(0, 1 - u.t / 2.5);
    });
  }
  plane.position.copy(P.pos);
  plane.quaternion.copy(P.q);
  plane.userData.prop.rotation.z += dt * (8 + P.throttle * 60);
  plane.userData.disc.material.opacity = clamp(P.throttle * 0.35, 0, 0.3);
  plane.visible = !P.crashed && mode !== 'menu' && camMode !== 2;
  BLINKERS.forEach((b) => { b.visible = Math.sin(clockT * 4) > 0; });
  SPINNERS.forEach((s) => s.rotateZ(dt * 0.08));
  CABINS.forEach((c) => {
    c.t = (c.t + c.speed * dt) % 1;
    c.curve.getPointAt(c.t, c.mesh.position);
    c.mesh.position.y -= 3.5;
  });
  if (mode !== 'menu') {
    ringObjs.forEach((r, i) => {
      const cur = i === tourIdx && mode === 'tour';
      r.material.opacity = cur ? 0.95 : 0.35;
      r.children[0].material.opacity = cur ? 0.18 + 0.12 * Math.sin(clockT * 4) : 0.05;
      r.scale.setScalar(cur ? 1 + 0.03 * Math.sin(clockT * 3) : 1);
    });
  }
  const labelRange = mode === 'menu' ? 14000 : 6000;
  LABELS.forEach((l) => { l.visible = camera.position.distanceTo(l.position) < labelRange; });
  const focus = mode === 'menu' ? _tmp2.set(1200, 900, 0) : P.pos;
  sun.target.position.copy(focus);
  sun.position.copy(focus).addScaledVector(SUN_DIR, 2500);
  updateCamera(dt, clockT);
  sky.position.copy(camera.position);
  if (mode !== 'menu') updateHud(dt);
  audio.update();
  renderer.render(scene, camera);
}

function buildExplosion() {
  const g = new THREE.Group();
  const parts = [];
  for (let i = 0; i < 40; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 6, 4), new THREE.MeshBasicMaterial({ color: i % 3 ? '#ff8a2a' : '#474240', transparent: true, depthWrite: false }));
    g.add(m);
    parts.push({ m, v: new V3() });
  }
  g.userData = { parts, t: 0 };
  g.visible = false;
  scene.add(g);
  return g;
}

/* =========================================================
   Boot
   ========================================================= */
async function boot() {
  let NRM = null, ground = null;
  const steps = [
    ['Поднимаем рельеф Заилийского Алатау…', async () => { NRM = await buildTerrain(); }],
    ['Читаем карту улиц, парков и рек…', async () => { await decodeAreas(); await decodeLines(); }],
    ['Загружаем дома Алматы…', decodeBuildings],
    ['Строим дома…', buildBuildings],
    ['Рисуем кварталы и парки…', () => { ground = paintGround(); buildGround(ground, NRM); }],
    ['Прокладываем улицы и полосы аэропорта…', buildRoads],
    ['Наполняем озёра и запускаем канатные дороги…', () => { buildLakes(); buildCableways(); }],
    ['Сажаем деревья и ели…', () => buildTrees(NRM)],
    ['Собираем достопримечательности…', () => { buildLandmarks(); buildClouds(); }],
    ['Развешиваем кольца…', () => { buildRings(); buildMinimap(ground); }],
  ];
  for (let i = 0; i < steps.length; i++) {
    $('loading-text').textContent = steps[i][0];
    $('loading-bar').style.width = `${(i / steps.length) * 100}%`;
    await new Promise((r) => setTimeout(r, 30));
    const t0 = performance.now();
    await steps[i][1]();
    if (/debug/.test(location.hash)) console.log(`step ${i} ${Math.round(performance.now() - t0)} ms`);
  }
  window.ALMATY_DATA = null;
  plane = makePlaneModel();
  plane.scale.setScalar(1.4);
  scene.add(plane);
  explosion = buildExplosion();
  placeOnRunway();
  $('loading-bar').style.width = '100%';
  $('loading').hidden = true;
  $('menu').hidden = false;
  refreshBest();
  requestAnimationFrame((t) => { last = t; frame(t); });
  if (/debug/.test(location.hash)) window.__flight = { P, input, physics, readInput, keys, checkRings, state: () => ({ mode, tourIdx, timer, crashes }), TOUR, gridH, RUNWAYS, START, counts: { buildings: BLD.list.length } };
}
boot().catch((err) => {
  console.error(err);
  fail('Не удалось построить сцену. Обновите страницу.');
});
})();
