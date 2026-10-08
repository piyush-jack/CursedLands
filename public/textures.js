import * as THREE from 'three';

/* ============================================================
   Minecraft-style pixel art, painted in code (16x16 tiles).
   - block texture atlas + block table
   - item sprites (sword / bow / arrow) and the extruded 3D item meshes used in hand
   - isometric block icons for the hotbar
   ============================================================ */

function mulberry(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const mul = (c, k) => [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)];
function hnoise(x, y, s) { const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453; return v - Math.floor(v); }
function vnoise2(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hnoise(xi, yi, s), b = hnoise(xi + 1, yi, s), c = hnoise(xi, yi + 1, s), d = hnoise(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// A 16x16 painter: put(x,y,[r,g,b],alpha)
function tile(seed, fn) {
  const r = mulberry(seed), d = new Uint8ClampedArray(16 * 16 * 4);
  const put = (x, y, c, a = 255) => {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x > 15 || y > 15) return;
    const i = (y * 16 + x) * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = a;
  };
  const get = (x, y) => { const i = (y * 16 + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
  fn(put, r, get);
  return d;
}
const fill = (put, r, pal, a = 255) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) put(x, y, pick(r, pal), a); };
function blobs(put, r, n, col, hi) {
  for (let i = 0; i < n; i++) {
    const cx = 1 + Math.floor(r() * 13), cy = 1 + Math.floor(r() * 13);
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) if (r() < 0.85) put(cx + dx, cy + dy, col);
    if (hi) put(cx, cy, hi);
  }
}
const STONE = [[127, 127, 127], [118, 118, 118], [137, 137, 137], [108, 108, 108], [124, 124, 128]];
const stoneBase = (put, r) => {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const n = vnoise2(x / 2.2, y / 2.2, 5);
    put(x, y, STONE[Math.min(4, Math.floor((n * 0.7 + r() * 0.3) * 5))]);
  }
};
function clumpy(put, r, pal, scale, seed) {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const n = vnoise2(x / scale, y / scale, seed);
    put(x, y, pal[Math.min(pal.length - 1, Math.floor((n * 0.75 + r() * 0.25) * pal.length))]);
  }
}
function outlined(put, r, pal, scale, seed, edge) {
  const idx = [];
  for (let y = 0; y < 16; y++) {
    idx.push([]);
    for (let x = 0; x < 16; x++) idx[y].push(Math.min(pal.length - 1, Math.floor(vnoise2(x / scale, y / scale, seed) * pal.length)));
  }
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const i = idx[y][x];
    const e = (x < 15 && idx[y][x + 1] !== i) || (y < 15 && idx[y + 1][x] !== i);
    put(x, y, e ? edge : pal[i]);
  }
}

const GRASS = [[100, 168, 54], [92, 156, 49], [108, 178, 60], [84, 144, 45]];
const DIRT = [[134, 96, 67], [121, 85, 58], [110, 77, 52], [147, 108, 76], [126, 90, 62]];
const LEAF = [[58, 124, 30], [48, 108, 25], [68, 138, 36], [42, 96, 22]];
const SPRUCE = [[38, 82, 44], [30, 68, 36], [46, 94, 52], [24, 58, 30]];

const TILE_DEFS = {
  grass_top: tile(1, (p, r) => fill(p, r, GRASS)),
  dirt: tile(2, (p, r) => fill(p, r, DIRT)),
  grass_side: tile(3, (p, r) => {
    fill(p, r, DIRT);
    for (let x = 0; x < 16; x++) {
      const depth = 3 + (r() < 0.45 ? 1 : 0) + (r() < 0.2 ? 1 : 0);
      for (let y = 0; y < depth; y++) p(x, y, pick(r, GRASS));
    }
  }),
  stone: tile(4, (p, r) => stoneBase(p, r)),
  sand: tile(5, (p, r) => fill(p, r, [[219, 207, 163], [212, 199, 155], [226, 214, 171], [205, 191, 146]])),
  log_side: tile(6, (p, r) => {
    const cols = []; for (let x = 0; x < 16; x++) cols.push(0.82 + hnoise(x, 3, 9) * 0.3);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const k = cols[x] * (0.92 + r() * 0.16) * (x % 4 === 0 ? 0.88 : 1);
      p(x, y, mul([104, 82, 50], k));
    }
  }),
  log_top: tile(7, (p, r) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      let c;
      if (d >= 6.5) c = mul([104, 82, 50], 0.85 + r() * 0.2);
      else if (Math.floor(d) % 2 === 0) c = mul([178, 144, 90], 0.93 + r() * 0.1);
      else c = mul([150, 118, 70], 0.93 + r() * 0.1);
      p(x, y, c);
    }
  }),
  leaves: tile(8, (p, r) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      if (r() < 0.16) p(x, y, [0, 0, 0], 0); else p(x, y, pick(r, LEAF));
    }
  }),
  spruce_leaves: tile(9, (p, r) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      if (r() < 0.16) p(x, y, [0, 0, 0], 0); else p(x, y, pick(r, SPRUCE));
    }
  }),
  snow: tile(10, (p, r) => fill(p, r, [[250, 252, 255], [243, 247, 252], [236, 241, 249], [247, 250, 254]])),
  planks: tile(11, (p, r) => {
    const base = [[166, 133, 80], [158, 126, 74], [172, 139, 85]];
    for (let by = 0; by < 4; by++) {
      const off = Math.floor(r() * 16);
      for (let y = by * 4; y < by * 4 + 4; y++) for (let x = 0; x < 16; x++) {
        let c = pick(r, base);
        if (y === by * 4 + 3) c = [112, 86, 49];
        else if (y === by * 4) c = mul(c, 1.06);
        if (x === off) c = [118, 92, 53];
        p(x, y, c);
      }
    }
  }),
  water: tile(12, (p, r) => clumpy(p, r, [[34, 78, 186], [40, 88, 198], [46, 98, 208], [52, 108, 216]], 3, 21)),
  cobble: tile(13, (p, r) => outlined(p, r, [[130, 130, 130], [112, 112, 112], [146, 146, 146], [122, 122, 126]], 3.2, 33, [78, 78, 78])),
  gravel: tile(14, (p, r) => {
    outlined(p, r, [[135, 131, 128], [118, 114, 112], [150, 146, 142], [126, 122, 120], [108, 104, 100]], 2.4, 41, [92, 88, 86]);
    for (let i = 0; i < 10; i++) p(Math.floor(r() * 16), Math.floor(r() * 16), [150, 128, 104]);
  }),
  bedrock: tile(15, (p, r) => clumpy(p, r, [[28, 28, 28], [58, 58, 58], [84, 84, 84], [44, 44, 44], [104, 104, 104]], 1.8, 51)),
  coal_ore: tile(16, (p, r) => { stoneBase(p, r); blobs(p, r, 6, [28, 28, 30], [56, 56, 58]); }),
  iron_ore: tile(17, (p, r) => { stoneBase(p, r); blobs(p, r, 6, [214, 172, 142], [236, 205, 178]); }),
  diamond_ore: tile(18, (p, r) => { stoneBase(p, r); blobs(p, r, 5, [78, 220, 212], [186, 252, 248]); }),
  cactus_side: tile(19, (p, r) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      let c = mul([20, 112, 34], 0.92 + r() * 0.18);
      if (x === 0 || x === 15) c = mul(c, 0.72);
      if (x === 7 || x === 8) c = mul(c, 0.86);
      p(x, y, c);
    }
    for (let i = 0; i < 12; i++) p(1 + Math.floor(r() * 14), Math.floor(r() * 16), [150, 214, 118]);
  }),
  cactus_top: tile(20, (p, r) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const edge = x === 0 || y === 0 || x === 15 || y === 15;
      const inner = x > 3 && x < 12 && y > 3 && y < 12;
      p(x, y, edge ? [14, 82, 26] : inner ? mul([60, 160, 70], 0.95 + r() * 0.1) : mul([24, 120, 38], 0.9 + r() * 0.15));
    }
  }),
};
export const TILE_NAMES = Object.keys(TILE_DEFS);
export const TILE = Object.fromEntries(TILE_NAMES.map((n, i) => [n, i]));
const ATLAS_COLS = 8, ATLAS_PX = 16 * ATLAS_COLS;

let _atlas = null;
export function getAtlas() {
  if (_atlas) return _atlas;
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_PX; canvas.height = ATLAS_PX;
  const g = canvas.getContext('2d');
  TILE_NAMES.forEach((n, i) => {
    const img = new ImageData(TILE_DEFS[n], 16, 16);
    g.putImageData(img, (i % ATLAS_COLS) * 16, Math.floor(i / ATLAS_COLS) * 16);
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  _atlas = { canvas, texture };
  return _atlas;
}
// uv rectangle of a tile, inset a hair so neighbours never bleed in
export function tileUV(i) {
  const e = 0.0015, s = 1 / ATLAS_COLS;
  const col = i % ATLAS_COLS, row = Math.floor(i / ATLAS_COLS);
  return { u0: col * s + e, u1: (col + 1) * s - e, v0: 1 - (row + 1) * s + e, v1: 1 - row * s - e };
}

/* ---------- block table ---------- */
const def = (name, top, side, bot, extra) => ({ name, top: TILE[top], side: TILE[side], bot: TILE[bot], ...extra });
const all = (name, t, extra) => def(name, t, t, t, extra);
export const BLOCK_DEFS = {
  1: def('Grass Block', 'grass_top', 'grass_side', 'dirt'),
  2: all('Dirt', 'dirt'),
  3: all('Stone', 'stone'),
  4: all('Sand', 'sand'),
  5: def('Oak Log', 'log_top', 'log_side', 'log_top'),
  6: all('Oak Leaves', 'leaves', { cut: true }),
  7: all('Snow', 'snow'),
  8: all('Oak Planks', 'planks'),
  9: all('Water', 'water', { liquid: true }),
  10: all('Cobblestone', 'cobble'),
  11: all('Gravel', 'gravel'),
  12: all('Bedrock', 'bedrock'),
  13: all('Coal Ore', 'coal_ore'),
  14: all('Iron Ore', 'iron_ore'),
  15: all('Diamond Ore', 'diamond_ore'),
  16: def('Cactus', 'cactus_top', 'cactus_side', 'cactus_top'),
  17: all('Spruce Leaves', 'spruce_leaves', { cut: true }),
};
// blocks a player can pick from the palette
export const PALETTE_BLOCKS = [1, 2, 3, 10, 4, 11, 5, 8, 6, 17, 7, 13, 14, 15, 16, 12];

// 6-face cube geometry with atlas uvs (used for the block in hand)
export function blockCubeGeometry(id, size = 1) {
  const d = BLOCK_DEFS[id];
  const tiles = [d.side, d.side, d.top, d.bot, d.side, d.side]; // +x -x +y -y +z -z
  const shade = [0.8, 0.8, 1, 0.55, 0.9, 0.9];
  const geo = new THREE.BoxGeometry(size, size, size);
  const uv = geo.attributes.uv, col = [];
  for (let f = 0; f < 6; f++) {
    const t = tileUV(tiles[f]);
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, uv.getX(i) ? t.u1 : t.u0, uv.getY(i) ? t.v1 : t.v0);
      col.push(shade[f], shade[f], shade[f]);
    }
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return geo;
}

// isometric icon for the hotbar / palette
const _icons = new Map();
export function blockIcon(id) {
  if (_icons.has(id)) return _icons.get(id);
  const d = BLOCK_DEFS[id], atlas = getAtlas().canvas;
  const c = document.createElement('canvas'); c.width = 32; c.height = 32;
  const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
  const face = (tileI, m, dark) => {
    g.save(); g.setTransform(...m);
    g.drawImage(atlas, (tileI % ATLAS_COLS) * 16, Math.floor(tileI / ATLAS_COLS) * 16, 16, 16, 0, 0, 16, 16);
    if (dark) { g.fillStyle = `rgba(0,0,0,${dark})`; g.fillRect(0, 0, 16, 16); }
    g.restore();
  };
  face(d.top, [1, 0.5, -1, 0.5, 16, 0], 0);
  face(d.side, [1, 0.5, 0, 1, 0, 8], 0.22);
  face(d.side, [1, -0.5, 0, 1, 16, 16], 0.42);
  const url = c.toDataURL();
  _icons.set(id, url);
  return url;
}

/* ---------- item sprites ---------- */
const SWORD_PAL = [
  { hi: [204, 168, 104], main: [162, 126, 72], dark: [100, 74, 38], guard: [120, 90, 48] },   // wooden
  { hi: [246, 248, 250], main: [204, 208, 214], dark: [118, 122, 130], guard: [96, 96, 104] }, // iron
  { hi: [190, 252, 248], main: [84, 224, 214], dark: [28, 132, 146], guard: [96, 96, 104] },   // diamond
];
const HANDLE = [108, 72, 36], HANDLE_D = [66, 43, 20];

function spriteCanvas(fn) {
  const c = document.createElement('canvas'); c.width = 16; c.height = 16;
  const g = c.getContext('2d');
  const put = (x, y, col) => { if (x < 0 || y < 0 || x > 15 || y > 15) return; g.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`; g.fillRect(x | 0, y | 0, 1, 1); };
  fn(put);
  return c;
}
function swordSprite(tier) {
  const P = SWORD_PAL[Math.min(2, tier)];
  return spriteCanvas(put => {
    for (let x = 6; x <= 14; x++) { put(x, 13 - x, P.dark); }          // upper edge outline
    for (let x = 6; x <= 14; x++) { put(x, 14 - x, P.hi); put(x, 15 - x, P.main); put(x, 16 - x, P.dark); }
    put(15, 1, P.dark); put(14, 0, P.hi); put(15, 0, P.hi);
    for (const [x, y] of [[3, 8], [4, 9], [5, 10], [6, 11], [7, 12]]) { put(x, y, P.guard); put(x - 1, y, mul(P.guard, 0.7)); }
    for (const [x, y] of [[4, 8], [5, 9]]) put(x, y, P.guard);
    for (let x = 1; x <= 4; x++) { put(x, 15 - x - 0, HANDLE); put(x, 16 - x, HANDLE_D); }
    put(0, 15, HANDLE_D); put(1, 14, HANDLE_D);
  });
}
function bowSprite(pull) {
  // arc bulges to the upper left; string runs between the tips and is drawn back by `pull`
  return spriteCanvas(put => {
    const wood = [124, 88, 44], woodD = [78, 52, 24], woodL = [158, 118, 66], string = [236, 236, 230];
    const A = [14, 2], C = [2, 14];
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const th = t * Math.PI / 2;
      const x = 14 - 12 * Math.sin(th), y = 14 - 12 * Math.cos(th);
      put(Math.round(x), Math.round(y), wood);
      put(Math.round(x) + 1, Math.round(y) + 1, woodD);
      put(Math.round(x) - 1, Math.round(y), woodL);
    }
    for (const [x, y] of [[5, 5], [6, 5], [5, 6], [4, 6], [6, 4]]) put(x, y, [92, 60, 28]);     // grip wrap
    const px = 8 + pull * 3.4, py = 8 + pull * 3.4;
    const line = (x0, y0, x1, y1, col) => {
      const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)));
      for (let i = 0; i <= n; i++) put(Math.round(x0 + (x1 - x0) * i / n), Math.round(y0 + (y1 - y0) * i / n), col);
    };
    line(A[0], A[1], px, py, string);
    line(px, py, C[0], C[1], string);
    if (pull > 0) {
      line(px, py, px - 8, py - 8, [150, 118, 74]);                     // arrow shaft
      put(Math.round(px - 9), Math.round(py - 9), [200, 200, 205]);
      put(Math.round(px - 8), Math.round(py - 9), [160, 160, 168]); put(Math.round(px - 9), Math.round(py - 8), [160, 160, 168]);
      put(Math.round(px), Math.round(py - 1), [240, 240, 240]); put(Math.round(px - 1), Math.round(py), [240, 240, 240]);
    }
  });
}
function arrowSprite(tip) {
  return spriteCanvas(put => {
    const c = `#${tip.toString(16).padStart(6, '0')}`;
    const rgb = [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
    for (let i = 3; i <= 12; i++) put(i, 15 - i, [150, 118, 74]);
    put(13, 1, rgb); put(14, 0, mul(rgb, 1.2)); put(12, 2, mul(rgb, 0.85)); put(13, 2, mul(rgb, 0.85)); put(12, 1, mul(rgb, 0.85));
    put(2, 13, [236, 236, 236]); put(3, 14, [236, 236, 236]); put(2, 12, [200, 200, 200]); put(4, 14, [200, 200, 200]);
    put(1, 13, [236, 236, 236]); put(3, 15, [236, 236, 236]);
  });
}
const _sprites = new Map();
export function itemSprite(kind, opt = 0) {
  const k = kind + ':' + opt;
  if (_sprites.has(k)) return _sprites.get(k);
  const c = kind === 'sword' ? swordSprite(opt) : kind === 'bow' ? bowSprite(opt) : arrowSprite(opt);
  _sprites.set(k, c);
  return c;
}
export const spriteURL = (kind, opt = 0) => itemSprite(kind, opt).toDataURL();

// Minecraft-style held item: the 16x16 sprite extruded one pixel thick
export function itemMesh(kind, opt = 0, size = 1, extra = {}) {
  const cv = itemSprite(kind, opt);
  const data = cv.getContext('2d').getImageData(0, 0, 16, 16).data;
  const solid = (x, y) => x >= 0 && y >= 0 && x < 16 && y < 16 && data[(y * 16 + x) * 4 + 3] > 128;
  const pos = [], uv = [], col = [], idx = [];
  const T = 1 / 16;   // thickness: one pixel
  const quad = (p0, p1, p2, p3, uvs, shade) => {
    const b = pos.length / 3;
    for (const p of [p0, p1, p2, p3]) pos.push(p[0], p[1], p[2]);
    for (const u of uvs) uv.push(u[0], u[1]);
    for (let i = 0; i < 4; i++) col.push(shade, shade, shade);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  const h = T / 2;
  // front (+z) and back (-z), full sprite
  quad([0, 0, h], [1, 0, h], [1, 1, h], [0, 1, h], [[0, 0], [1, 0], [1, 1], [0, 1]], 1);
  quad([1, 0, -h], [0, 0, -h], [0, 1, -h], [1, 1, -h], [[1, 0], [0, 0], [0, 1], [1, 1]], 0.85);
  // sides where a solid pixel borders empty space; uv sits on the pixel centre so they take its colour
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if (!solid(x, y)) continue;
    const u = (x + 0.5) / 16, v = 1 - (y + 0.5) / 16, x0 = x / 16, x1 = (x + 1) / 16, y0 = 1 - (y + 1) / 16, y1 = 1 - y / 16;
    const c4 = [[u, v], [u, v], [u, v], [u, v]];
    if (!solid(x - 1, y)) quad([x0, y0, -h], [x0, y0, h], [x0, y1, h], [x0, y1, -h], c4, 0.7);
    if (!solid(x + 1, y)) quad([x1, y0, h], [x1, y0, -h], [x1, y1, -h], [x1, y1, h], c4, 0.7);
    if (!solid(x, y - 1)) quad([x0, y1, h], [x1, y1, h], [x1, y1, -h], [x0, y1, -h], c4, 0.95);
    if (!solid(x, y + 1)) quad([x0, y0, -h], [x1, y0, -h], [x1, y0, h], [x0, y0, h], c4, 0.55);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.translate(-0.5, -0.5, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide, ...extra });
  const m = new THREE.Mesh(geo, mat);
  m.scale.setScalar(size);
  return m;
}

// small clouds layer texture (white blobs on transparent)
export function cloudTexture() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const n = vnoise2(x / 7, y / 7, 3) * 0.7 + vnoise2(x / 3, y / 3, 8) * 0.3;
    if (n > 0.6) { g.fillStyle = 'rgba(255,255,255,0.92)'; g.fillRect(x, y, 1, 1); }
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
