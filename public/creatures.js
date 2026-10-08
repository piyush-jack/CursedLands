import * as THREE from 'three';

/* ============================================================
   Minecraft-style mobs + player avatar (shared by the game and viewer.html)
   Every model is built from textured boxes (1 block = 16 px) with a hand-painted skin
   sheet. Creatures stand at y=0 and face -z.
   createMob(type) -> { root, animate(dt, state), hit(), headPos(out) }
   state = { speed, graze, alert, stun, run, leader }
   ============================================================ */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
function mulberry(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ---------- skin sheet: shelf-packed box layouts, painted per face ---------- */
class Sheet {
  constructor(w, h, seed) {
    this.w = w; this.h = h; this.r = mulberry(seed);
    this.canvas = document.createElement('canvas'); this.canvas.width = w; this.canvas.height = h;
    this.g = this.canvas.getContext('2d');
    this.cx = 0; this.cy = 0; this.rowH = 0;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.magFilter = THREE.NearestFilter; this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false; this.texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.MeshLambertMaterial({ map: this.texture });
  }
  // reserve the cross-shaped unwrap of a w x h x d box
  box(w, h, d, paint) {
    const bw = 2 * d + 2 * w, bh = d + h;
    if (this.cx + bw > this.w) { this.cx = 0; this.cy += this.rowH; this.rowH = 0; }
    const spec = { w, h, d, u: this.cx, v: this.cy };
    this.cx += bw; this.rowH = Math.max(this.rowH, bh);
    spec.F = {
      top: [spec.u + d, spec.v, w, d], bottom: [spec.u + d + w, spec.v, w, d],
      right: [spec.u, spec.v + d, d, h], front: [spec.u + d, spec.v + d, w, h],
      left: [spec.u + d + w, spec.v + d, d, h], back: [spec.u + 2 * d + w, spec.v + d, w, h],
    };
    if (paint) paint(spec.F, this, spec);
    this.texture.needsUpdate = true;
    return spec;
  }
  col(c, k = 1) { return `rgb(${Math.min(255, c[0] * k) | 0},${Math.min(255, c[1] * k) | 0},${Math.min(255, c[2] * k) | 0})`; }
  px(rect, x, y, c, k = 1) { this.g.fillStyle = this.col(c, k); this.g.fillRect(rect[0] + x, rect[1] + y, 1, 1); }
  rect(rect, x, y, w, h, c, k = 1) { this.g.fillStyle = this.col(c, k); this.g.fillRect(rect[0] + x, rect[1] + y, w, h); }
  noise(rect, base, amt = 0.08) {
    for (let y = 0; y < rect[3]; y++) for (let x = 0; x < rect[2]; x++) this.px(rect, x, y, base, 1 + (this.r() - 0.5) * 2 * amt);
  }
  fillAll(F, base, amt = 0.08) { for (const k in F) this.noise(F[k], base, amt); }
  patches(rect, c, n, maxw, maxh) {
    for (let i = 0; i < n; i++) {
      const w = 1 + Math.floor(this.r() * maxw), h = 1 + Math.floor(this.r() * maxh);
      const x = Math.floor(this.r() * rect[2]) - 1, y = Math.floor(this.r() * rect[3]) - 1;
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        if (x + xx >= 0 && y + yy >= 0 && x + xx < rect[2] && y + yy < rect[3]) this.px(rect, x + xx, y + yy, c, 0.95 + this.r() * 0.1);
      }
    }
  }
  geo(spec, inflate = 0) {
    const { w, h, d, F } = spec;
    const g = new THREE.BoxGeometry((w + inflate * 2) / 16, (h + inflate * 2) / 16, (d + inflate * 2) / 16);
    const order = [F.right, F.left, F.top, F.bottom, F.back, F.front];     // BoxGeometry face order: +x -x +y -y +z -z
    const uv = g.attributes.uv, e = 0.02;
    for (let f = 0; f < 6; f++) {
      const [x, y, rw, rh] = order[f];
      for (let k = 0; k < 4; k++) {
        const i = f * 4 + k, a = uv.getX(i), b = uv.getY(i);
        uv.setXY(i, (a ? x + rw - e : x + e) / this.w, 1 - (b ? y + e : y + rh - e) / this.h);
      }
    }
    return g;
  }
  mesh(spec, inflate = 0) { return new THREE.Mesh(this.geo(spec, inflate), this.material); }
}

function grp(parent, x = 0, y = 0, z = 0, name = '') {
  const g = new THREE.Group(); g.position.set(x / 16, y / 16, z / 16); if (name) g.name = name; parent.add(g); return g;
}
function put(parent, mesh, x = 0, y = 0, z = 0) { mesh.position.set(x / 16, y / 16, z / 16); parent.add(mesh); return mesh; }

/* ---------- species ---------- */
const PINK = [240, 163, 163];
function buildPig() {
  const S = new Sheet(128, 64, 11);
  const root = new THREE.Group(), body = grp(root, 0, 0, 0, 'body');
  const bodyS = S.box(10, 8, 16, F => { S.fillAll(F, PINK, 0.06); S.rect(F.bottom, 0, 0, 10, 16, PINK, 0.85); });
  const legS = S.box(4, 6, 4, F => { S.fillAll(F, PINK, 0.07); S.rect(F.front, 0, 4, 4, 2, [214, 140, 140]); S.rect(F.back, 0, 4, 4, 2, [214, 140, 140]); S.rect(F.left, 0, 4, 4, 2, [214, 140, 140]); S.rect(F.right, 0, 4, 4, 2, [214, 140, 140]); });
  const headS = S.box(8, 8, 8, F => {
    S.fillAll(F, PINK, 0.06);
    for (const [ex, c] of [[1, [255, 255, 255]], [2, [52, 40, 70]], [5, [52, 40, 70]], [6, [255, 255, 255]]]) { S.px(F.front, ex, 3, c); S.px(F.front, ex, 4, c); }
  });
  const snoutS = S.box(4, 3, 1, F => {
    S.fillAll(F, [222, 134, 134], 0.05);
    S.px(F.front, 1, 1, [92, 52, 60]); S.px(F.front, 2, 1, [92, 52, 60]);
  });
  put(body, S.mesh(bodyS), 0, 10, 0);
  const legs = [['legFL', -3, -5], ['legFR', 3, -5], ['legBL', -3, 5], ['legBR', 3, 5]];
  for (const [n, x, z] of legs) { const j = grp(body, x, 6, z, n); put(j, S.mesh(legS), 0, -3, 0); }
  const head = grp(body, 0, 11, -8, 'head');
  put(head, S.mesh(headS), 0, 0, -4);
  put(head, S.mesh(snoutS), 0, -1.5, -8.5);
  return { root, S, headCenter: [0, 0, -4], baseY: 0 };
}

function buildCow() {
  const S = new Sheet(128, 96, 12);
  const root = new THREE.Group(), body = grp(root, 0, 0, 0, 'body');
  const BR = [74, 52, 38], WH = [232, 230, 222];
  const bodyS = S.box(12, 10, 18, F => {
    S.fillAll(F, BR, 0.08);
    for (const k of ['top', 'left', 'right', 'bottom', 'front', 'back']) S.patches(F[k], WH, k === 'top' || k === 'left' || k === 'right' ? 5 : 2, 6, 5);
    S.patches(F.top, [30, 24, 20], 2, 4, 3);
  });
  const legS = S.box(4, 12, 4, F => { S.fillAll(F, BR, 0.08); S.rect(F.front, 0, 8, 4, 4, WH); S.rect(F.back, 0, 8, 4, 4, WH); S.rect(F.left, 0, 8, 4, 4, WH); S.rect(F.right, 0, 8, 4, 4, WH); });
  const headS = S.box(8, 8, 6, F => {
    S.fillAll(F, BR, 0.08);
    S.rect(F.front, 1, 4, 6, 4, [190, 160, 140]);
    S.px(F.front, 2, 6, [90, 60, 56]); S.px(F.front, 5, 6, [90, 60, 56]);
    for (const [ex, c] of [[0, [255, 255, 255]], [1, [30, 24, 24]], [6, [30, 24, 24]], [7, [255, 255, 255]]]) S.px(F.front, ex, 2, c);
  });
  const hornS = S.box(1, 3, 1, F => S.fillAll(F, [236, 232, 214], 0.04));
  const udderS = S.box(4, 2, 4, F => S.fillAll(F, [236, 170, 170], 0.05));
  put(body, S.mesh(bodyS), 0, 17, 0);
  put(body, S.mesh(udderS), 0, 11, 6);
  for (const [n, x, z] of [['legFL', -4, -7], ['legFR', 4, -7], ['legBL', -4, 8], ['legBR', 4, 8]]) { const j = grp(body, x, 12, z, n); put(j, S.mesh(legS), 0, -6, 0); }
  const head = grp(body, 0, 20, -9, 'head');
  put(head, S.mesh(headS), 0, 0, -3);
  put(head, S.mesh(hornS), -4.5, 5.5, -2); put(head, S.mesh(hornS), 4.5, 5.5, -2);
  return { root, S, headCenter: [0, 0, -3], baseY: 0 };
}

function buildSheep() {
  const S = new Sheet(160, 96, 13);
  const root = new THREE.Group(), body = grp(root, 0, 0, 0, 'body');
  const WOOL = [232, 230, 226], SKIN = [196, 168, 148];
  const wool = F => { S.fillAll(F, WOOL, 0.05); for (const k in F) S.patches(F[k], [210, 208, 204], 7, 2, 2); };
  const bodyS = S.box(8, 7, 16, F => S.fillAll(F, SKIN, 0.05));
  const woolBodyS = S.box(12, 10, 18, wool);
  const legS = S.box(4, 12, 4, F => { S.fillAll(F, SKIN, 0.06); S.rect(F.front, 0, 10, 4, 2, [90, 76, 68]); S.rect(F.back, 0, 10, 4, 2, [90, 76, 68]); S.rect(F.left, 0, 10, 4, 2, [90, 76, 68]); S.rect(F.right, 0, 10, 4, 2, [90, 76, 68]); });
  const woolLegS = S.box(5, 6, 5, wool);
  const headS = S.box(6, 6, 8, F => {
    S.fillAll(F, SKIN, 0.05);
    S.rect(F.front, 0, 0, 6, 1, WOOL);
    for (const [ex, c] of [[1, [255, 255, 255]], [2, [40, 32, 30]], [3, [40, 32, 30]], [4, [255, 255, 255]]]) S.px(F.front, ex, 2, c);
    S.rect(F.front, 2, 4, 2, 1, [110, 84, 76]);
  });
  const woolHeadS = S.box(6, 6, 6, wool);
  put(body, S.mesh(bodyS), 0, 17, 0);
  put(body, S.mesh(woolBodyS, 0.5), 0, 17, 0);
  for (const [n, x, z] of [['legFL', -3, -7], ['legFR', 3, -7], ['legBL', -3, 8], ['legBR', 3, 8]]) {
    const j = grp(body, x, 12, z, n); put(j, S.mesh(legS), 0, -6, 0); put(j, S.mesh(woolLegS, 0.3), 0, -2, 0);
  }
  const head = grp(body, 0, 20, -8, 'head');
  put(head, S.mesh(headS), 0, 0, -4);
  put(head, S.mesh(woolHeadS, 0.5), 0, 1.5, -1.5);
  return { root, S, headCenter: [0, 0, -4], baseY: 0 };
}

function buildChicken() {
  const S = new Sheet(96, 64, 14);
  const root = new THREE.Group(), body = grp(root, 0, 0, 0, 'body');
  const W = [242, 242, 238];
  const bodyS = S.box(6, 6, 8, F => S.fillAll(F, W, 0.05));
  const headS = S.box(4, 6, 3, F => {
    S.fillAll(F, W, 0.04);
    S.rect(F.top, 0, 0, 4, 3, [200, 40, 40]);
    S.px(F.front, 0, 2, [20, 20, 20]); S.px(F.front, 3, 2, [20, 20, 20]);
    S.rect(F.front, 1, 0, 2, 1, [200, 40, 40]);
  });
  const beakS = S.box(4, 2, 2, F => S.fillAll(F, [236, 170, 40], 0.05));
  const wattleS = S.box(2, 2, 2, F => S.fillAll(F, [200, 40, 40], 0.05));
  const legS = S.box(2, 5, 2, F => S.fillAll(F, [236, 170, 40], 0.05));
  const wingS = S.box(1, 4, 6, F => S.fillAll(F, [226, 226, 222], 0.05));
  const tailS = S.box(4, 4, 1, F => S.fillAll(F, W, 0.05));
  put(body, S.mesh(bodyS), 0, 8, 1);
  put(body, S.mesh(tailS), 0, 11, 5.5);
  for (const [n, x] of [['legL', -2], ['legR', 2]]) { const j = grp(body, x, 5, 1, n); put(j, S.mesh(legS), 0, -2.5, 0); }
  for (const [n, x] of [['wingL', -3.5], ['wingR', 3.5]]) { const j = grp(body, x, 10.5, 1, n); put(j, S.mesh(wingS), x > 0 ? 0.5 : -0.5, -2, 0); }
  const head = grp(body, 0, 10, -3, 'head');
  put(head, S.mesh(headS), 0, 3, -1.5);
  put(head, S.mesh(beakS), 0, 2.5, -4);
  put(head, S.mesh(wattleS), 0, 0.5, -3);
  return { root, S, headCenter: [0, 3, -1.5], baseY: 0 };
}

function buildWolf() {
  const S = new Sheet(128, 64, 15);
  const root = new THREE.Group(), body = grp(root, 0, 0, 0, 'body');
  const G = [214, 210, 204], D = [150, 146, 142];
  const bodyS = S.box(6, 6, 10, F => { S.fillAll(F, G, 0.05); S.noise(F.top, D, 0.06); S.noise(F.bottom, [236, 232, 226], 0.04); });
  const legS = S.box(2, 8, 2, F => { S.fillAll(F, G, 0.05); S.rect(F.front, 0, 6, 2, 2, [236, 232, 226]); });
  const headS = S.box(6, 6, 4, F => {
    S.fillAll(F, G, 0.05);
    S.px(F.front, 1, 2, [255, 255, 255]); S.px(F.front, 2, 2, [60, 44, 30]); S.px(F.front, 3, 2, [60, 44, 30]); S.px(F.front, 4, 2, [255, 255, 255]);
    S.px(F.front, 2, 2, [200, 150, 40]); S.px(F.front, 3, 2, [200, 150, 40]);
  });
  const snoutS = S.box(3, 3, 3, F => { S.fillAll(F, [236, 232, 226], 0.04); S.rect(F.front, 0, 0, 3, 1, [30, 26, 26]); });
  const earS = S.box(2, 2, 1, F => S.fillAll(F, D, 0.05));
  const tailS = S.box(2, 8, 2, F => { S.fillAll(F, G, 0.05); S.rect(F.front, 0, 6, 2, 2, [236, 232, 226]); S.rect(F.back, 0, 6, 2, 2, [236, 232, 226]); });
  put(body, S.mesh(bodyS), 0, 11, 0);
  for (const [n, x, z] of [['legFL', -2, -3.5], ['legFR', 2, -3.5], ['legBL', -2, 4], ['legBR', 2, 4]]) { const j = grp(body, x, 8, z, n); put(j, S.mesh(legS), 0, -4, 0); }
  const head = grp(body, 0, 12.5, -5, 'head');
  put(head, S.mesh(headS), 0, 0.5, -2);
  put(head, S.mesh(snoutS), 0, -1, -5.5);
  put(head, S.mesh(earS), -2, 4.5, -1.5); put(head, S.mesh(earS), 2, 4.5, -1.5);
  const tail = grp(body, 0, 13, 5, 'tail');
  put(tail, S.mesh(tailS), 0, -3, 0);
  tail.rotation.x = -0.7;
  return { root, S, headCenter: [0, 0.5, -3], baseY: 0 };
}

function buildSpider() {
  const S = new Sheet(128, 64, 16);
  const root = new THREE.Group(), body = grp(root, 0, 0, 0, 'body');
  const BR = [54, 46, 40];
  const headS = S.box(8, 8, 8, F => {
    S.fillAll(F, BR, 0.09);
    const eye = [214, 40, 40];
    for (const [x, y] of [[1, 3], [2, 3], [5, 3], [6, 3], [3, 2], [4, 2], [0, 4], [7, 4]]) S.px(F.front, x, y, eye);
    S.rect(F.front, 2, 5, 4, 1, [30, 24, 22]);
  });
  const thoraxS = S.box(6, 6, 6, F => S.fillAll(F, BR, 0.1));
  const abS = S.box(10, 8, 12, F => { S.fillAll(F, BR, 0.1); S.patches(F.top, [96, 30, 30], 4, 3, 5); });
  const legS = S.box(16, 2, 2, F => S.fillAll(F, [38, 32, 28], 0.1));
  put(body, S.mesh(thoraxS), 0, 9, 0);
  put(body, S.mesh(abS), 0, 9, 9);
  const head = grp(body, 0, 9, -3, 'head');
  put(head, S.mesh(headS), 0, 0, -4);
  for (let i = 0; i < 4; i++) for (const s of [-1, 1]) {
    const j = grp(body, s * 3, 9, -2 + i * 1.6, `leg${s < 0 ? 'L' : 'R'}${i}`);
    put(j, S.mesh(legS), s * 8, 0, 0);
  }
  return { root, S, headCenter: [0, 0, -4], baseY: 0 };
}

/* ---------- humanoids: Steve-style players and zombies ---------- */
export function paintHumanoid(S, o) {
  const head = S.box(8, 8, 8, F => {
    S.fillAll(F, o.skin, 0.04);
    if (o.hair) {
      S.fillAll({ top: F.top, back: F.back }, o.hair, 0.07);
      S.rect(F.front, 0, 0, 8, 2, o.hair); S.rect(F.left, 0, 0, 8, 3, o.hair); S.rect(F.right, 0, 0, 8, 3, o.hair);
      S.noise([F.front[0], F.front[1], 8, 2], o.hair, 0.07);
    }
    if (o.zombie) {
      S.noise(F.front, o.skin, 0.1);
      for (const x of [1, 2, 5, 6]) S.px(F.front, x, 4, [24, 30, 24]);
      S.rect(F.front, 2, 6, 4, 1, [50, 70, 40]);
    } else {
      for (const [x, c] of [[1, [255, 255, 255]], [2, o.eye || [76, 70, 150]], [5, o.eye || [76, 70, 150]], [6, [255, 255, 255]]]) S.px(F.front, x, 4, c);
      S.rect(F.front, 3, 6, 2, 1, mulc(o.skin, 0.75));
    }
  });
  const body = S.box(8, 12, 4, F => {
    S.fillAll(F, o.shirt, 0.05);
    S.rect(F.bottom, 0, 0, 8, 4, o.pants);
    if (o.zombie) S.patches(F.front, mulc(o.skin, 1), 3, 2, 2);
  });
  const arm = S.box(4, 12, 4, F => {
    S.fillAll(F, o.zombie ? o.skin : o.skin, 0.04);
    for (const k of ['front', 'back', 'left', 'right']) S.rect(F[k], 0, 0, 4, o.zombie ? 3 : 4, o.shirt);
    S.rect(F.top, 0, 0, 4, 4, o.shirt);
  });
  const leg = S.box(4, 12, 4, F => {
    S.fillAll(F, o.pants, 0.05);
    for (const k of ['front', 'back', 'left', 'right']) S.rect(F[k], 0, 10, 4, 2, o.shoes || [70, 70, 74]);
  });
  return { head, body, arm, leg };
}
const mulc = (c, k) => [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)];

function humanoid(S, specs) {
  const root = new THREE.Group(), body = grp(root, 0, 0, 0, 'body');
  put(body, S.mesh(specs.body), 0, 18, 0);
  for (const [n, x] of [['legL', -2], ['legR', 2]]) { const j = grp(body, x, 12, 0, n); put(j, S.mesh(specs.leg), 0, -6, 0); }
  for (const [n, x] of [['armL', -6], ['armR', 6]]) { const j = grp(body, x, 22, 0, n); put(j, S.mesh(specs.arm), 0, -4, 0); }
  const head = grp(body, 0, 24, 0, 'head');
  put(head, S.mesh(specs.head), 0, 4, 0);
  root.scale.setScalar(0.9375);                       // 32 px model -> 1.8 blocks tall
  return root;
}
function buildZombie() {
  const S = new Sheet(64, 64, 17);
  const specs = paintHumanoid(S, { skin: [88, 146, 70], shirt: [36, 118, 136], pants: [52, 54, 150], zombie: true, shoes: [60, 60, 66] });
  return { root: humanoid(S, specs), S, headCenter: [0, 4, 0], baseY: 0 };
}

// a player avatar. `look` = { shirt:[r,g,b], hair:[r,g,b] }
const _playerSheets = new Map();
export function createPlayerModel(look) {
  const key = look.shirt.join(',') + '|' + look.hair.join(',');
  let c = _playerSheets.get(key);
  if (!c) {
    const S = new Sheet(64, 64, 100 + _playerSheets.size);
    const specs = paintHumanoid(S, { skin: [199, 152, 114], hair: look.hair, shirt: look.shirt, pants: [48, 46, 134], shoes: [74, 74, 78] });
    c = { S, root: humanoid(S, specs) };
    _playerSheets.set(key, c);
  }
  const root = c.root.clone(true);
  const joints = {};
  root.traverse(o => { if (o.name) joints[o.name] = o; });
  const model = { root, joints, phase: 0, swing: 0 };
  model.animate = (dt, speed, pitch = 0) => {
    const moving = speed > 0.3;
    if (moving) model.phase += dt * (5 + speed * 1.3);
    const amp = moving ? clamp(0.5 + speed * 0.08, 0.5, 1.1) : 0;
    const e = Math.min(1, 14 * dt);
    const s = Math.sin(model.phase) * amp;
    joints.legL.rotation.x = lerp(joints.legL.rotation.x, s, e); joints.legR.rotation.x = lerp(joints.legR.rotation.x, -s, e);
    joints.armL.rotation.x = lerp(joints.armL.rotation.x, -s * 0.9, e); joints.armR.rotation.x = lerp(joints.armR.rotation.x, s * 0.9, e);
    joints.head.rotation.x = lerp(joints.head.rotation.x, pitch, Math.min(1, 12 * dt));
  };
  return model;
}
// first-person arm (shirt sleeve + skin), hangs from y=0 downwards, 4x12x4 px
export function createArmMesh(shirt) {
  const S = new Sheet(64, 32, 77);
  const arm = S.box(4, 12, 4, F => {
    S.fillAll(F, [199, 152, 114], 0.04);
    for (const k of ['front', 'back', 'left', 'right']) S.rect(F[k], 0, 0, 4, 5, shirt);
    S.rect(F.top, 0, 0, 4, 4, shirt);
  });
  const geo = S.geo(arm);
  geo.translate(0, -6 / 16, 0);                       // pivot at the shoulder
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: S.texture }));
  return m;
}

/* ---------- animation ---------- */
const BUILDERS = { pig: buildPig, cow: buildCow, sheep: buildSheep, chicken: buildChicken, wolf: buildWolf, zombie: buildZombie, spider: buildSpider };
export const MOB_TYPES = Object.keys(BUILDERS);
const GRAZE = { pig: -0.95, cow: -1.0, sheep: -0.95, chicken: -0.9, wolf: -0.5, zombie: 0, spider: -0.15 };
const ALERT = { pig: 0.22, cow: 0.22, sheep: 0.22, chicken: 0.35, wolf: 0.25, zombie: 0, spider: 0.1 };
const QUAD = { pig: 1, cow: 1, sheep: 1, wolf: 1 };
const _templates = new Map();

export function createMob(type) {
  let tpl = _templates.get(type);
  if (!tpl) { tpl = BUILDERS[type](); _templates.set(type, tpl); }
  const root = tpl.root.clone(true);
  const mat = tpl.S.material.clone();
  const joints = {};
  root.traverse(o => { if (o.name) joints[o.name] = o; if (o.isMesh) o.material = mat; });
  const m = { type, root, group: root, joints, mat, phase: Math.random() * 6, t: Math.random() * 10, headPitch: 0, hurtT: 0, frozen: 0, tilt: 0 };
  const headJ = joints.head, body = joints.body;
  const legs = ['legFL', 'legFR', 'legBL', 'legBR', 'legL', 'legR'].filter(n => joints[n]);
  const legPh = { legFL: 0, legBR: 0, legFR: Math.PI, legBL: Math.PI, legL: 0, legR: Math.PI };
  const spiderLegs = Object.keys(joints).filter(n => /^leg[LR]\d$/.test(n));
  const base = {};
  for (const n of Object.keys(joints)) base[n] = joints[n].rotation.clone();

  m.hit = () => { m.hurtT = 0.28; };
  m.animate = function (dt, s) {
    this.t += dt;
    const speed = s.stun ? 0 : (s.speed || 0);
    const moving = speed > 0.25;
    const ease = Math.min(1, 10 * dt);
    if (moving) this.phase += dt * (type === 'chicken' ? 4 + speed * 2.4 : type === 'spider' ? 5 + speed * 1.4 : 3.6 + speed * 1.5);
    const k = clamp(speed / 6, 0, 1);
    const amp = moving ? (type === 'zombie' ? 0.6 + 0.4 * k : 0.55 + 0.5 * k) : 0;

    // legs
    if (type === 'spider') {
      for (const n of spiderLegs) {
        const s = n[3] === 'L' ? -1 : 1, idx = +n[4];
        const fan = (1.5 - idx) * 0.42;                                   // front legs reach forward, back legs trail
        const ph = this.phase + (idx % 2) * Math.PI + (s > 0 ? Math.PI : 0);
        joints[n].rotation.y = s * (fan + (moving ? Math.sin(ph) * 0.3 : 0));
        joints[n].rotation.z = -s * (0.55 - (moving ? Math.max(0, Math.cos(ph)) * 0.4 : 0));
      }
    } else {
      for (const n of legs) {
        const b = base[n].x;
        joints[n].rotation.x = lerp(joints[n].rotation.x, b + Math.sin(this.phase + legPh[n]) * amp, ease);
      }
    }
    // arms (humanoid)
    if (joints.armL) {
      const zomb = type === 'zombie';
      const sw = Math.sin(this.phase) * amp * 0.25;
      const raise = zomb ? 1.45 + Math.sin(this.t * 1.6) * 0.05 : 0;
      joints.armL.rotation.x = lerp(joints.armL.rotation.x, raise + sw, ease);
      joints.armR.rotation.x = lerp(joints.armR.rotation.x, raise - sw, ease);
    }
    // wings
    if (joints.wingL) {
      const flap = (s.run || speed > 3.5) ? Math.abs(Math.sin(this.t * 22)) * 1.1 : (moving ? 0.05 : 0);
      joints.wingL.rotation.z = lerp(joints.wingL.rotation.z, -flap, 0.5); joints.wingR.rotation.z = lerp(joints.wingR.rotation.z, flap, 0.5);
    }
    // head
    if (headJ) {
      let hp = 0;
      if (s.stun) hp = 0.1;
      else if (s.graze) hp = (GRAZE[type] || 0) + (type === 'chicken' ? Math.max(0, Math.sin(this.t * 7)) * 0.7 : Math.sin(this.t * 6) * 0.06);
      else if (s.alert) hp = ALERT[type] || 0;
      else hp = Math.sin(this.t * 0.6 + this.phase) * 0.04 + (moving && type === 'chicken' ? Math.sin(this.phase * 2) * 0.15 : 0);
      this.headPitch = lerp(this.headPitch, hp, Math.min(1, 7 * dt));
      headJ.rotation.x = this.headPitch;
      if (type === 'sheep' || type === 'cow' || type === 'pig') headJ.rotation.y = Math.sin(this.t * 0.5 + this.phase) * 0.12 * (s.graze ? 0 : 1);
    }
    if (joints.tail) joints.tail.rotation.z = Math.sin(this.t * (moving ? 8 : 2.5)) * (moving ? 0.35 : 0.12);
    if (body) body.position.y = moving && type !== 'spider' ? Math.abs(Math.sin(this.phase)) * 0.012 * (0.5 + amp) : 0;

    // hurt flash + freeze tint
    this.hurtT = Math.max(0, this.hurtT - dt);
    this.frozen = lerp(this.frozen, s.stun ? 1 : 0, Math.min(1, 12 * dt));
    const hurt = this.hurtT > 0 ? Math.min(1, this.hurtT / 0.28) : 0;
    this.mat.emissive.setRGB(hurt * 0.75 + this.frozen * 0.05, hurt * 0.06 + this.frozen * 0.2, hurt * 0.06 + this.frozen * 0.55);
    // chickens flutter when they flee: tiny hover
    root.position.y = type === 'chicken' && (s.run || speed > 3.5) ? 0.05 + Math.abs(Math.sin(this.t * 22)) * 0.04 : 0;
  };

  // world-space centre of the head, in creature-local frame (x right, z back), for matching the server's weak points
  m.headPos = function (out) {
    root.updateMatrixWorld(true);
    const c = tpl.headCenter;
    headJ.localToWorld(out.set(c[0] / 16, c[1] / 16, c[2] / 16));
    return out;
  };
  m.animate(0.016, { speed: 0 });
  return m;
}

// lighting shared by the game and the viewer so creatures look the same everywhere
export function addCreatureLights(scene) {
  const amb = new THREE.AmbientLight(0xffffff, 1.5);
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-3, 6, 4);
  scene.add(amb, sun);
  return { amb, sun, base: { amb: 1.5, sun: 1.6 } };
}
export function setCreatureDaylight(lights, k) {
  lights.amb.intensity = lights.base.amb * (0.35 + 0.65 * k);
  lights.sun.intensity = lights.base.sun * (0.15 + 0.85 * k);
}
