import * as THREE from 'three';
import { CS, CH, SEA, B, heightAt, featureAt, trunkHeight, hash2, setSeed, surfaceAt, oreAt, biomeAt } from './terrain.mjs';
import { createMob, addCreatureLights, setCreatureDaylight, createPlayerModel, createArmMesh } from './creatures.js';
import { getAtlas, tileUV, BLOCK_DEFS, PALETTE_BLOCKS, blockIcon, blockCubeGeometry, itemMesh, spriteURL, cloudTexture } from './textures.js';

/* ============================================================
   Cursed Lands - browser voxel multiplayer prototype v0.4
   Minecraft-style world: textured blocks, biomes, ores, animals, day and night
   ============================================================ */

const LOAD_R = 6;       // chunks loaded around the player (meshes show up to LOAD_R-1)
const GEN_PER_FRAME = 2;
const MESH_PER_FRAME = 2;
const WATER = B.WATER;

/* ---------- blocks ---------- */
const CUT = new Set([B.LEAVES, B.SPRUCE_LEAVES]);   // alpha-tested, see-through blocks
const TILES = {};                                   // id -> { top, side, bot } uv rects
for (const id of Object.keys(BLOCK_DEFS)) {
  const d = BLOCK_DEFS[id];
  TILES[id] = { top: tileUV(d.top), side: tileUV(d.side), bot: tileUV(d.bot) };
}
const BLOCK_NAME = id => BLOCK_DEFS[id].name;

const DEFAULT_BLOCKS = [3, 2, 8, 5, 4, 1, 10];
const HOTBAR = [{ k: 'sword' }, { k: 'bow' }, ...DEFAULT_BLOCKS.map(id => ({ k: 'block', id }))];
try {
  const saved = JSON.parse(localStorage.getItem('cl_hotbar') || 'null');
  if (Array.isArray(saved) && saved.length === 7) saved.forEach((id, i) => { if (BLOCK_DEFS[id] && id !== WATER) HOTBAR[i + 2].id = id; });
} catch {}
const saveHotbar = () => { try { localStorage.setItem('cl_hotbar', JSON.stringify(HOTBAR.slice(2).map(h => h.id))); } catch {} };

const SWORDS = ['Wooden Sword', 'Iron Sword', 'Diamond Sword'];
const BOWS = ['Bow', 'Power Bow'];
const ARROWS = [
  { k: 'a_wood',  name: 'Arrow',       color: 0xaab0b4 },
  { k: 'a_scrap', name: 'Iron Arrow',  color: 0xdde2e6 },
  { k: 'a_spark', name: 'Frost Arrow', color: 0x66d8ff },
  { k: 'a_core',  name: 'Flame Arrow', color: 0xff6a2a },
];
const ITEM_NAMES = {
  wood: 'Oak Log', feather: 'Feather', string: 'String', bone: 'Bone', iron: 'Iron Ingot', coal: 'Coal', diamond: 'Diamond', meat: 'Raw Meat',
  a_wood: 'Arrows', a_scrap: 'Iron Arrows', a_spark: 'Frost Arrows', a_core: 'Flame Arrows',
};
const MATS = ['wood', 'feather', 'string', 'bone', 'iron', 'coal', 'diamond', 'meat'];
const MOB_TYPES = ['pig', 'cow', 'sheep', 'chicken', 'wolf', 'zombie', 'spider'];   // same order as the server
const MOB_LABEL = { pig: 'Pig', cow: 'Cow', sheep: 'Sheep', chicken: 'Chicken', wolf: 'Wolf', zombie: 'Zombie', spider: 'Spider' };
const MOB_BAR_Y = { pig: 1.15, cow: 1.95, sheep: 1.9, chicken: 1.1, wolf: 1.35, zombie: 2.25, spider: 1.1 };
const MOB_PICK = { pig: [0.5, 0.75], cow: [0.9, 0.95], sheep: [0.9, 0.9], chicken: [0.4, 0.5], wolf: [0.6, 0.7], zombie: [0.9, 0.8], spider: [0.5, 0.8] };
const BIOME_NAME = ['Plains', 'Forest', 'Desert', 'Snowy Tundra'];
const ARROW_GRAVITY = 20;

/* ---------- world storage ---------- */
const world = {
  chunks: new Map(),   // "cx,cz" -> Uint8Array
  meshes: new Map(),   // "cx,cz" -> [THREE.Mesh...]
  dirty: new Set(),
  edits: new Map(),    // "cx,cz" -> Map(localIndex -> block)
};
const cIdx = (lx, y, lz) => (y * CS + lz) * CS + lx;

function genChunk(cx, cz) {
  const data = new Uint8Array(CS * CH * CS);
  const ox = cx * CS, oz = cz * CS;
  for (let lz = 0; lz < CS; lz++) {
    for (let lx = 0; lx < CS; lx++) {
      const wx = ox + lx, wz = oz + lz;
      const h = heightAt(wx, wz);
      const surf = surfaceAt(wx, wz, h);
      for (let y = 0; y <= h; y++) {
        let b;
        if (y === 0) b = B.BEDROCK;
        else if (y === 1 && hash2(wx, wz, 77) < 0.5) b = B.BEDROCK;
        else if (y === h) b = surf.top;
        else if (y > h - 4) b = surf.sub;
        else b = oreAt(wx, y, wz, h) || B.STONE;
        data[cIdx(lx, y, lz)] = b;
      }
      for (let y = h + 1; y <= SEA; y++) data[cIdx(lx, y, lz)] = WATER; // lakes and seas
    }
  }
  // trees and cacti (looked up from a margin so leaves cross chunk borders consistently)
  for (let tz = oz - 3; tz < oz + CS + 3; tz++) {
    for (let tx = ox - 3; tx < ox + CS + 3; tx++) {
      const h = heightAt(tx, tz);
      const kind = featureAt(tx, tz, h);
      if (!kind) continue;
      const put = (x, y, z, b, onlyAir) => {
        const lx = x - ox, lz = z - oz;
        if (lx < 0 || lx >= CS || lz < 0 || lz >= CS || y < 0 || y >= CH) return;
        const i = cIdx(lx, y, lz);
        if (onlyAir && data[i] !== 0) return;
        data[i] = b;
      };
      const trunk = trunkHeight(tx, tz);
      const layer = (dy, r, leaf, roundCorners) => {
        for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
          if (roundCorners && Math.abs(dx) === r && Math.abs(dz) === r && (r > 1 || hash2(tx + dx * 7, tz + dz * 13 + dy, 5) < 0.6)) continue;
          put(tx + dx, h + dy, tz + dz, leaf, true);
        }
      };
      if (kind === 2) { for (let dy = 1; dy <= trunk; dy++) put(tx, h + dy, tz, B.CACTUS, false); continue; }
      for (let dy = 1; dy <= trunk; dy++) put(tx, h + dy, tz, B.LOG, false);
      if (kind === 1) {                                     // oak
        layer(trunk - 2, 2, B.LEAVES, true); layer(trunk - 1, 2, B.LEAVES, true);
        layer(trunk, 1, B.LEAVES, false); layer(trunk + 1, 1, B.LEAVES, true);
      } else {                                              // spruce
        layer(trunk + 1, 0, B.SPRUCE_LEAVES, false); layer(trunk, 1, B.SPRUCE_LEAVES, true);
        layer(trunk - 1, 1, B.SPRUCE_LEAVES, true); layer(trunk - 2, 2, B.SPRUCE_LEAVES, true);
        layer(trunk - 3, 2, B.SPRUCE_LEAVES, true); if (trunk >= 6) layer(trunk - 4, 3, B.SPRUCE_LEAVES, true);
      }
    }
  }
  const em = world.edits.get(cx + ',' + cz);
  if (em) for (const [i, b] of em) data[i] = b;
  return data;
}

function getBlock(x, y, z) {
  if (y < 0) return 1;
  if (y >= CH) return 0;
  const c = world.chunks.get((x >> 4) + ',' + (z >> 4));
  if (!c) return -1; // not loaded
  return c[cIdx(x & 15, y, z & 15)];
}
function markDirty(cx, cz) {
  const k = cx + ',' + cz;
  if (world.chunks.has(k)) world.dirty.add(k);
}
function setBlock(x, y, z, b) {
  if (y < 0 || y >= CH) return;
  const cx = x >> 4, cz = z >> 4, ck = cx + ',' + cz;
  const lx = x & 15, lz = z & 15, i = cIdx(lx, y, lz);
  let em = world.edits.get(ck);
  if (!em) { em = new Map(); world.edits.set(ck, em); }
  em.set(i, b);
  const c = world.chunks.get(ck);
  if (c) {
    c[i] = b;
    world.dirty.add(ck);
    if (lx === 0) markDirty(cx - 1, cz);
    if (lx === CS - 1) markDirty(cx + 1, cz);
    if (lz === 0) markDirty(cx, cz - 1);
    if (lz === CS - 1) markDirty(cx, cz + 1);
  }
}

/* ---------- meshing: atlas uvs + per-vertex ambient occlusion ---------- */
// corners are listed so the quad (0,1,2)(0,2,3) faces outwards; uv(c) keeps textures upright
const FACES = [
  { d: [1, 0, 0],  c: [[1,0,0],[1,1,0],[1,1,1],[1,0,1]], s: 0.62, k: 'side', ax: [1, 2], uv: c => [1 - c[2], c[1]] },
  { d: [-1, 0, 0], c: [[0,0,1],[0,1,1],[0,1,0],[0,0,0]], s: 0.62, k: 'side', ax: [1, 2], uv: c => [c[2], c[1]] },
  { d: [0, 1, 0],  c: [[0,1,1],[1,1,1],[1,1,0],[0,1,0]], s: 1.00, k: 'top',  ax: [0, 2], uv: c => [c[0], 1 - c[2]] },
  { d: [0, -1, 0], c: [[0,0,0],[1,0,0],[1,0,1],[0,0,1]], s: 0.40, k: 'bot',  ax: [0, 2], uv: c => [c[0], c[2]] },
  { d: [0, 0, 1],  c: [[0,0,1],[1,0,1],[1,1,1],[0,1,1]], s: 0.78, k: 'side', ax: [0, 1], uv: c => [c[0], c[1]] },
  { d: [0, 0, -1], c: [[1,0,0],[0,0,0],[0,1,0],[1,1,0]], s: 0.78, k: 'side', ax: [0, 1], uv: c => [1 - c[0], c[1]] },
];
const AO_LEVEL = [0.45, 0.66, 0.83, 1.0];
const atlas = getAtlas();
const chunkMaterial = new THREE.MeshBasicMaterial({ map: atlas.texture, vertexColors: true, alphaTest: 0.5 });
const waterMaterial = new THREE.MeshBasicMaterial({
  map: atlas.texture, vertexColors: true, transparent: true, opacity: 0.68, depthWrite: false, side: THREE.DoubleSide,
});

function removeMeshes(key) {
  const arr = world.meshes.get(key);
  if (!arr) return;
  for (const m of arr) { scene.remove(m); m.geometry.dispose(); }
  world.meshes.delete(key);
}

const PW = CS + 2;
const pad = new Uint8Array(PW * CH * PW);   // chunk plus a one-block border, so face and AO lookups never leave the array
function fillPad(cx, cz, data) {
  const ox = cx * CS, oz = cz * CS;
  for (let y = 0; y < CH; y++) {
    for (let z = -1; z <= CS; z++) {
      for (let x = -1; x <= CS; x++) {
        let b;
        if (x >= 0 && x < CS && z >= 0 && z < CS) b = data[(y * CS + z) * CS + x];
        else { b = getBlock(ox + x, y, oz + z); if (b < 0) b = 0; }
        pad[(y * PW + z + 1) * PW + x + 1] = b;
      }
    }
  }
}
const pb = (x, y, z) => (y < 0 ? 1 : y >= CH ? 0 : pad[(y * PW + z + 1) * PW + x + 1]);
const occludes = b => b !== 0 && b !== WATER;

function buildChunkMesh(cx, cz) {
  const key = cx + ',' + cz;
  const data = world.chunks.get(key);
  if (!data) return;
  fillPad(cx, cz, data);
  const O = { pos: [], uv: [], col: [], idx: [], vi: 0 };
  const W = { pos: [], uv: [], col: [], idx: [], vi: 0 };
  const ao = [0, 0, 0, 0];
  for (let y = 0; y < CH; y++) {
    for (let lz = 0; lz < CS; lz++) {
      for (let lx = 0; lx < CS; lx++) {
        const b = data[cIdx(lx, y, lz)];
        if (!b) continue;
        const isWater = b === WATER;
        const buf = isWater ? W : O;
        const tiles = TILES[b];
        const lower = isWater && pb(lx, y + 1, lz) !== WATER; // water surface sits a little below the block top
        for (let f = 0; f < 6; f++) {
          const F = FACES[f];
          const bx = lx + F.d[0], by = y + F.d[1], bz = lz + F.d[2];
          const nb = pb(bx, by, bz);
          if (isWater) { if (nb !== 0) continue; }                    // water only shows against air
          else if (!(nb === 0 || nb === WATER || CUT.has(nb))) continue; // solids show against air, water and leaves
          const t = tiles[F.k];
          const [a1, a2] = F.ax;
          for (let k = 0; k < 4; k++) {
            const c = F.c[k];
            let l = 1;
            if (!isWater) {
              const sa = c[a1] * 2 - 1, sb = c[a2] * 2 - 1;
              const p1 = [bx, by, bz], p2 = [bx, by, bz], p3 = [bx, by, bz];
              p1[a1] += sa; p2[a2] += sb; p3[a1] += sa; p3[a2] += sb;
              const o1 = occludes(pb(p1[0], p1[1], p1[2])), o2 = occludes(pb(p2[0], p2[1], p2[2])), o3 = occludes(pb(p3[0], p3[1], p3[2]));
              l = AO_LEVEL[o1 && o2 ? 0 : 3 - (o1 + o2 + o3)];
            }
            ao[k] = l;
            const [u, v] = F.uv(c);
            buf.pos.push(lx + c[0], y + (lower && c[1] === 1 ? 0.88 : c[1]), lz + c[2]);
            buf.uv.push(t.u0 + u * (t.u1 - t.u0), t.v0 + v * (t.v1 - t.v0));
            const m = F.s * l;
            buf.col.push(m, m, m);
          }
          const i = buf.vi;
          if (Math.abs(ao[0] - ao[2]) > Math.abs(ao[1] - ao[3])) buf.idx.push(i + 1, i + 2, i + 3, i + 1, i + 3, i);   // flip the quad so the AO gradient stays smooth
          else buf.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
          buf.vi += 4;
        }
      }
    }
  }
  removeMeshes(key);
  const made = [];
  for (const [buf, mat, order] of [[O, chunkMaterial, 0], [W, waterMaterial, 1]]) {
    if (buf.vi === 0) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
    geo.setIndex(new THREE.Uint32BufferAttribute(buf.idx, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx * CS, 0, cz * CS);
    mesh.renderOrder = order;
    scene.add(mesh);
    made.push(mesh);
  }
  if (made.length) world.meshes.set(key, made);
}

/* ---------- three.js setup ---------- */
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.autoClear = false;                                  // the hand is drawn in a second pass on a cleared depth buffer
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
const lights = addCreatureLights(scene);
const FOG_FAR = (LOAD_R - 1) * CS - 4;
scene.background = new THREE.Color(0x8ec9f0);
scene.fog = new THREE.Fog(0x8ec9f0, 40, FOG_FAR);
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 420);
camera.rotation.order = 'YXZ';
const vmScene = new THREE.Scene();
const vmCamera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.02, 10);
window.addEventListener('resize', () => {
  camera.aspect = vmCamera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix(); vmCamera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const highlight = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
  new THREE.LineBasicMaterial({ color: 0x000000 })
);
highlight.visible = false;
scene.add(highlight);

/* ---------- sky: sun, moon, stars, clouds ---------- */
const skyBits = new THREE.Group(); scene.add(skyBits);
const flat = (size, color) => {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color, fog: false, depthWrite: false }));
  m.renderOrder = -10; skyBits.add(m); return m;
};
const sunMesh = flat(46, 0xfff6c0), moonMesh = flat(30, 0xdfe6f2);
const starGeo = new THREE.BufferGeometry();
{
  const p = [];
  for (let i = 0; i < 320; i++) {
    const a = Math.random() * Math.PI * 2, e = Math.random() * 1.2 - 0.1, r = 380;
    p.push(Math.cos(a) * Math.cos(e) * r, Math.sin(e) * r, Math.sin(a) * Math.cos(e) * r);
  }
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
}
const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, fog: false, transparent: true, opacity: 0, depthWrite: false });
const stars = new THREE.Points(starGeo, starMat); stars.renderOrder = -11; skyBits.add(stars);
const CLOUD_SIZE = 1100, CLOUD_REPEAT = 2.1;
const cloudTex = cloudTexture(); cloudTex.repeat.set(CLOUD_REPEAT, CLOUD_REPEAT);
const cloudMat = new THREE.MeshBasicMaterial({ map: cloudTex, transparent: true, fog: false, depthWrite: false, side: THREE.DoubleSide });
const clouds = new THREE.Mesh(new THREE.PlaneGeometry(CLOUD_SIZE, CLOUD_SIZE), cloudMat);
clouds.rotation.x = -Math.PI / 2; clouds.position.y = 92; clouds.renderOrder = -5; scene.add(clouds);

let dayLen = 600, phase0 = 0.08, tInit = performance.now();
const worldPhase = () => (phase0 + (performance.now() - tInit) / 1000 / dayLen) % 1;
const SKY_DAY = new THREE.Color(0x8ec9f0), SKY_NIGHT = new THREE.Color(0x05060f), SKY_DUSK = new THREE.Color(0xf0864a), UNDERWATER = new THREE.Color(0x1c4a8a);
const _sky = new THREE.Color();
let daylight = 1;
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function updateSky(under) {
  const phase = worldPhase(), ang = phase * Math.PI * 2, s = Math.sin(ang);
  daylight = smoothstep(-0.14, 0.28, s);
  _sky.copy(SKY_NIGHT).lerp(SKY_DAY, daylight);
  const dusk = Math.exp(-Math.pow(s / 0.13, 2)) * 0.32;
  _sky.lerp(SKY_DUSK, dusk);
  if (under) _sky.copy(UNDERWATER).multiplyScalar(0.25 + 0.75 * daylight);
  scene.background.copy(_sky); scene.fog.color.copy(_sky);
  scene.fog.near = under ? 1 : 40; scene.fog.far = under ? 26 : FOG_FAR;
  // world brightness: dim and bluish at night
  const k = 0.2 + 0.8 * daylight;
  chunkMaterial.color.setRGB(k * (0.9 + 0.1 * daylight), k * (0.95 + 0.05 * daylight), Math.min(1, k * 1.1 + (1 - daylight) * 0.12));
  waterMaterial.color.copy(chunkMaterial.color);
  cloudMat.color.setRGB(0.25 + 0.75 * daylight, 0.27 + 0.73 * daylight, 0.36 + 0.64 * daylight);
  setCreatureDaylight(lights, daylight);
  const cp = camera.position;
  skyBits.position.copy(cp);
  sunMesh.position.set(Math.cos(ang) * 330, Math.sin(ang) * 330, 40); sunMesh.lookAt(cp);
  moonMesh.position.set(-Math.cos(ang) * 330, -Math.sin(ang) * 330, -40); moonMesh.lookAt(cp);
  sunMesh.visible = s > -0.2; moonMesh.visible = s < 0.2;
  starMat.opacity = Math.max(0, 1 - daylight * 1.6) * (under ? 0 : 1);
  stars.rotation.z = ang;
  clouds.position.x = cp.x; clouds.position.z = cp.z;
  cloudTex.offset.set(cp.x / CLOUD_SIZE * CLOUD_REPEAT + performance.now() * 2e-7, -cp.z / CLOUD_SIZE * CLOUD_REPEAT);
  vmBright(Math.max(0.45, daylight));
}

/* ---------- state shared across systems ---------- */
const $ = id => document.getElementById(id);
let inv = {};              // from server
let recipes = [];
let hp = 20, maxHp = 20;
let selected = 0, selArrow = 0;
let spawn = { x: 0.5, z: 0.5 };

/* ---------- player ---------- */
const player = {
  pos: new THREE.Vector3(0.5, 60, 0.5),
  vel: new THREE.Vector3(),
  yaw: 0, pitch: 0, onGround: false, fly: false, ready: false,
};
const keys = new Set();

function solidAt(x, y, z) {
  const b = getBlock(x, y, z);
  return b !== 0 && b !== WATER; // -1 (unloaded) counts as solid so you never fall through; water is not solid
}
function collides(px, py, pz) {
  const e = 1e-4;
  const x0 = Math.floor(px - 0.3), x1 = Math.floor(px + 0.3 - e);
  const y0 = Math.floor(py), y1 = Math.floor(py + 1.8 - e);
  const z0 = Math.floor(pz - 0.3), z1 = Math.floor(pz + 0.3 - e);
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++)
        if (solidAt(x, y, z)) return true;
  return false;
}
const isWaterAt = (x, y, z) => getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) === WATER;

let walkDist = 0;
function stepPlayer(dt) {
  const p = player.pos, v = player.vel;
  const inBody = isWaterAt(p.x, p.y + 0.9, p.z);
  const inFeet = isWaterAt(p.x, p.y + 0.2, p.z);
  const swimming = inBody && !player.fly;
  // horizontal
  const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const r = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
  let speed = player.fly ? (sprint ? 22 : 12) : (sprint ? 6.8 : 4.3);
  if (swimming) speed = sprint ? 3.8 : 2.8;
  let wx = -Math.sin(player.yaw) * f + Math.cos(player.yaw) * r;
  let wz = -Math.cos(player.yaw) * f - Math.sin(player.yaw) * r;
  const len = Math.hypot(wx, wz);
  if (len > 0) { wx = wx / len * speed; wz = wz / len * speed; }
  const k = player.onGround || player.fly ? 18 : (swimming ? 6 : 5);
  const a = 1 - Math.exp(-k * dt);
  v.x += (wx - v.x) * a;
  v.z += (wz - v.z) * a;
  // vertical
  if (player.fly) {
    const up = (keys.has('Space') ? 1 : 0) - (keys.has('KeyC') ? 1 : 0);
    v.y += (up * speed - v.y) * (1 - Math.exp(-12 * dt));
  } else if (swimming) {
    const target = keys.has('Space') ? 3.6 : (keys.has('KeyC') ? -3 : -1.4); // sink slowly, hold Space to swim up
    v.y += (target - v.y) * (1 - Math.exp(-6 * dt));
  } else {
    v.y = Math.max(-30, v.y - 28 * dt);
    if (keys.has('Space')) {
      if (player.onGround) { v.y = 8.6; player.onGround = false; }
      else if (inFeet) v.y = Math.max(v.y, 6.8); // hop out of the water at the shore
    }
  }
  // X
  p.x += v.x * dt;
  if (collides(p.x, p.y, p.z)) { p.x -= v.x * dt; v.x = 0; }
  // Z
  p.z += v.z * dt;
  if (collides(p.x, p.y, p.z)) { p.z -= v.z * dt; v.z = 0; }
  // Y
  const dy = v.y * dt;
  p.y += dy;
  player.onGround = false;
  if (collides(p.x, p.y, p.z)) {
    if (dy < 0) { p.y = Math.floor(p.y) + 1; player.onGround = true; }
    else { p.y = Math.floor(p.y + 1.8) - 1.8 - 1e-3; }
    v.y = 0;
  }
  if (p.y < -20) { p.y = 70; v.set(0, 0, 0); } // fell out of the world
  if (player.onGround) walkDist += Math.hypot(v.x, v.z) * dt;
}
function physics(dt) {
  const n = Math.max(1, Math.ceil(dt / 0.02));
  for (let i = 0; i < n; i++) stepPlayer(dt / n);
}

/* ---------- raycast (voxel DDA) ---------- */
function raycast(o, d, maxD) {
  let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z);
  const sx = d.x > 0 ? 1 : -1, sy = d.y > 0 ? 1 : -1, sz = d.z > 0 ? 1 : -1;
  const tdx = d.x === 0 ? Infinity : Math.abs(1 / d.x);
  const tdy = d.y === 0 ? Infinity : Math.abs(1 / d.y);
  const tdz = d.z === 0 ? Infinity : Math.abs(1 / d.z);
  let tx = d.x === 0 ? Infinity : (d.x > 0 ? x + 1 - o.x : o.x - x) * tdx;
  let ty = d.y === 0 ? Infinity : (d.y > 0 ? y + 1 - o.y : o.y - y) * tdy;
  let tz = d.z === 0 ? Infinity : (d.z > 0 ? z + 1 - o.z : o.z - z) * tdz;
  let nx = 0, ny = 0, nz = 0, t = 0;
  while (t <= maxD) {
    const b = getBlock(x, y, z);
    if (b > 0 && b !== WATER) return { x, y, z, nx, ny, nz }; // look through water
    if (tx < ty && tx < tz) { x += sx; t = tx; tx += tdx; nx = -sx; ny = 0; nz = 0; }
    else if (ty < tz) { y += sy; t = ty; ty += tdy; nx = 0; ny = -sy; nz = 0; }
    else { z += sz; t = tz; tz += tdz; nx = 0; ny = 0; nz = -sz; }
  }
  return null;
}
let target = null;
const _dir = new THREE.Vector3(), _eye = new THREE.Vector3();
function updateTarget() {
  _eye.set(player.pos.x, player.pos.y + 1.62, player.pos.z);
  camera.getWorldDirection(_dir);
  const held = HOTBAR[selected].k;
  target = held === 'bow' ? null : raycast(_eye, _dir, 6);
  if (target) { highlight.visible = true; highlight.position.set(target.x + 0.5, target.y + 0.5, target.z + 0.5); }
  else highlight.visible = false;
}

/* ---------- block break particles ---------- */
const tileColors = new Map();
function tileColor(id) {
  let c = tileColors.get(id);
  if (c !== undefined) return c;
  const t = BLOCK_DEFS[id].side, g = atlas.canvas.getContext('2d');
  const d = g.getImageData((t % 8) * 16, Math.floor(t / 8) * 16, 16, 16).data;
  let r = 0, gg = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
  c = n ? ((Math.round(r / n) << 16) | (Math.round(gg / n) << 8) | Math.round(b / n)) : 0x808080;
  tileColors.set(id, c);
  return c;
}
const particles = [];
const partGeo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
function spawnBreakParticles(x, y, z, id) {
  const col = tileColor(id);
  for (let i = 0; i < 12; i++) {
    const m = new THREE.Mesh(partGeo, boxMat(col));
    m.position.set(x + 0.2 + Math.random() * 0.6, y + 0.2 + Math.random() * 0.6, z + 0.2 + Math.random() * 0.6);
    const sh = 0.75 + Math.random() * 0.25; m.scale.setScalar(sh);
    scene.add(m);
    particles.push({ m, vx: (Math.random() - 0.5) * 3, vy: Math.random() * 3 + 1, vz: (Math.random() - 0.5) * 3, life: 0.5 + Math.random() * 0.4 });
  }
}
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { scene.remove(p.m); particles.splice(i, 1); continue; }
    p.vy -= 18 * dt;
    p.m.position.x += p.vx * dt; p.m.position.y += p.vy * dt; p.m.position.z += p.vz * dt;
  }
}

function breakBlock() {
  if (!target || target.y === 0) return;
  const id = getBlock(target.x, target.y, target.z);
  if (id === B.BEDROCK) return;
  spawnBreakParticles(target.x, target.y, target.z, id);
  setBlock(target.x, target.y, target.z, 0);
  net.send({ t: 'edit', x: target.x, y: target.y, z: target.z, b: 0 });
}
function placeBlock() {
  const it = HOTBAR[selected];
  if (it.k !== 'block' || !target) return;
  const x = target.x + target.nx, y = target.y + target.ny, z = target.z + target.nz;
  const cur = getBlock(x, y, z);
  if (y < 0 || y >= CH || (cur !== 0 && cur !== WATER)) return;
  const p = player.pos;
  if (x + 1 > p.x - 0.3 && x < p.x + 0.3 && y + 1 > p.y && y < p.y + 1.8 && z + 1 > p.z - 0.3 && z < p.z + 0.3) return;
  setBlock(x, y, z, it.id);
  net.send({ t: 'edit', x, y, z, b: it.id });
}

/* ---------- chunk streaming ---------- */
let lastPcx = null, lastPcz = null, loadList = [];
function updateStreaming() {
  const pcx = Math.floor(player.pos.x / CS), pcz = Math.floor(player.pos.z / CS);
  if (pcx !== lastPcx || pcz !== lastPcz) {
    lastPcx = pcx; lastPcz = pcz;
    loadList = [];
    for (let dz = -LOAD_R; dz <= LOAD_R; dz++)
      for (let dx = -LOAD_R; dx <= LOAD_R; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 <= LOAD_R * LOAD_R) loadList.push({ cx: pcx + dx, cz: pcz + dz, d2 });
      }
    loadList.sort((a, b) => a.d2 - b.d2);
    for (const k of [...world.meshes.keys()]) {
      const [cx, cz] = k.split(',').map(Number);
      if ((cx - pcx) ** 2 + (cz - pcz) ** 2 > (LOAD_R + 1) ** 2) removeMeshes(k);
    }
    for (const k of [...world.chunks.keys()]) {
      const [cx, cz] = k.split(',').map(Number);
      if ((cx - pcx) ** 2 + (cz - pcz) ** 2 > (LOAD_R + 1) ** 2) { world.chunks.delete(k); world.dirty.delete(k); }
    }
  }
  let gen = 0;
  while (loadList.length && gen < GEN_PER_FRAME) {
    const e = loadList.shift();
    const k = e.cx + ',' + e.cz;
    if (world.chunks.has(k)) continue;
    world.chunks.set(k, genChunk(e.cx, e.cz));
    world.dirty.add(k);
    markDirty(e.cx - 1, e.cz); markDirty(e.cx + 1, e.cz); markDirty(e.cx, e.cz - 1); markDirty(e.cx, e.cz + 1);
    gen++;
  }
  // mesh the closest dirty chunks whose 4 neighbours exist
  if (world.dirty.size) {
    const arr = [];
    for (const k of world.dirty) {
      const [cx, cz] = k.split(',').map(Number);
      arr.push({ k, cx, cz, d: (cx - pcx) ** 2 + (cz - pcz) ** 2 });
    }
    arr.sort((a, b) => a.d - b.d);
    let n = 0;
    for (const e of arr) {
      if (n >= MESH_PER_FRAME) break;
      if (!(world.chunks.has((e.cx - 1) + ',' + e.cz) && world.chunks.has((e.cx + 1) + ',' + e.cz) &&
            world.chunks.has(e.cx + ',' + (e.cz - 1)) && world.chunks.has(e.cx + ',' + (e.cz + 1)))) continue;
      world.dirty.delete(e.k);
      buildChunkMesh(e.cx, e.cz);
      n++;
    }
  }
}

function tryPlaceOnGround() {
  // wait until the spawn chunk exists, then stand on top of the highest block (water counts)
  const sx = Math.floor(player.pos.x), sz = Math.floor(player.pos.z);
  if (getBlock(sx, 10, sz) === -1) return;
  let y = CH - 1;
  while (y > 0 && (getBlock(sx, y, sz) === 0 || CUT.has(getBlock(sx, y, sz)))) y--;   // stand on the ground, not on a tree canopy
  player.pos.y = y + 1.01;
  player.vel.set(0, 0, 0);
  player.ready = true;
}

/* ---------- shared mesh helpers ---------- */
const geoCache = new Map(), matCache = new Map();
function boxGeo(w, h, d) {
  const k = w + ',' + h + ',' + d;
  let g = geoCache.get(k);
  if (!g) { g = new THREE.BoxGeometry(w, h, d); geoCache.set(k, g); }
  return g;
}
function boxMat(color) {
  let m = matCache.get(color);
  if (!m) { m = new THREE.MeshBasicMaterial({ color }); matCache.set(color, m); }
  return m;
}
function box(w, h, d, color, x, y, z, mat) {
  const m = new THREE.Mesh(boxGeo(w, h, d), mat || boxMat(color));
  m.position.set(x, y, z);
  return m;
}

/* ---------- remote players (Steve-style avatars) ---------- */
const remotes = new Map();
function nameHash(name) { let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }
function makeLabel(text) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 30px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, 8, 256, 48);
  g.fillStyle = '#fff'; g.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  spr.scale.set(1.6, 0.4, 1); spr.renderOrder = 25;
  return spr;
}
const HAIR = [[58, 38, 20], [24, 20, 18], [196, 156, 70], [120, 62, 30], [150, 150, 150]];
function addRemote(id, name, x = 0, y = 60, z = 0, yaw = 0, pitch = 0) {
  if (remotes.has(id)) return;
  const h = nameHash(name);
  const c = new THREE.Color().setHSL((h % 360) / 360, 0.55, 0.45);
  const model = createPlayerModel({
    shirt: [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)].map(v => Math.round(v * 0.8 + 20)),
    hair: HAIR[(h >>> 4) % HAIR.length],
  });
  const g = new THREE.Group();
  g.add(model.root);
  const label = makeLabel(name); label.position.y = 2.2; g.add(label);
  g.position.set(x, y, z); g.rotation.y = yaw;
  scene.add(g);
  remotes.set(id, { g, model, name, tx: x, ty: y, tz: z, tyaw: yaw, tpitch: pitch, speed: 0 });
}
function removeRemote(id) {
  const r = remotes.get(id); if (!r) return;
  scene.remove(r.g); remotes.delete(id);
}
function updateRemotes(dt) {
  const a = 1 - Math.exp(-12 * dt);
  for (const r of remotes.values()) {
    const px = r.g.position.x, pz = r.g.position.z;
    r.g.position.x += (r.tx - px) * a;
    r.g.position.y += (r.ty - r.g.position.y) * a;
    r.g.position.z += (r.tz - pz) * a;
    let dyaw = r.tyaw - r.g.rotation.y;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    r.g.rotation.y += dyaw * a;
    const sp = Math.hypot(r.g.position.x - px, r.g.position.z - pz) / Math.max(dt, 1e-3);
    r.speed += (sp - r.speed) * Math.min(1, 8 * dt);
    r.model.animate(dt, r.speed, r.tpitch);
  }
}

/* ---------- mobs ---------- */
function makeBar(y) {
  const bg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x000000, depthTest: false, transparent: true, opacity: 0.6 }));
  const fg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x66ff66, depthTest: false }));
  fg.center.set(0, 0.5);
  bg.scale.set(1, 0.1, 1); fg.scale.set(0.96, 0.06, 1);
  bg.position.set(0, y, 0); fg.position.set(-0.48, y, 0);
  bg.renderOrder = 20; fg.renderOrder = 21;
  bg.visible = fg.visible = false;
  return { bg, fg };
}
const mobsC = new Map();
const dying = [];
function ensureMob(id, typeIdx, x, y, z) {
  let m = mobsC.get(id);
  if (m) return m;
  const type = MOB_TYPES[typeIdx] || 'pig';
  const cr = createMob(type);
  const root = new THREE.Group();
  root.position.set(x, y, z);
  root.add(cr.root);
  const bar = makeBar(MOB_BAR_Y[type] || 1.5);
  root.add(bar.bg, bar.fg);
  scene.add(root);
  m = { id, type, root, cr, body: cr.root, bar, tx: x, ty: y, tz: z, tyaw: 0, hp: 100, flags: 0, speed: 0 };
  mobsC.set(id, m);
  return m;
}
function removeMob(id, withDeath) {
  const m = mobsC.get(id); if (!m) return;
  mobsC.delete(id);
  if (withDeath) { m.bar.bg.visible = m.bar.fg.visible = false; dying.push({ m, t: 0 }); }
  else scene.remove(m.root);
}
function applyMobSnapshot(list) {
  const seen = new Set();
  for (const [id, typeIdx, x, y, z, yaw, hpPct, flags] of list) {
    seen.add(id);
    const m = ensureMob(id, typeIdx, x, y, z);
    if (hpPct < m.hp) m.cr.hit();
    m.tx = x; m.ty = y; m.tz = z; m.tyaw = yaw; m.hp = hpPct; m.flags = flags;
  }
  for (const id of [...mobsC.keys()]) if (!seen.has(id)) removeMob(id);
}
function updateMobs(dt) {
  const a = 1 - Math.exp(-14 * dt);
  for (const m of mobsC.values()) {
    const px = m.root.position.x, pz = m.root.position.z;
    m.root.position.x += (m.tx - px) * a;
    m.root.position.y += (m.ty - m.root.position.y) * a;
    m.root.position.z += (m.tz - pz) * a;
    let d = m.tyaw - m.body.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    m.body.rotation.y += d * a;
    const sp = Math.hypot(m.root.position.x - px, m.root.position.z - pz) / Math.max(dt, 1e-3);
    m.speed += (sp - m.speed) * Math.min(1, 8 * dt);
    const f = m.flags;
    m.cr.animate(dt, { speed: m.speed, stun: !!(f & 1), graze: !!(f & 4), alert: !!(f & 8), run: !!(f & 16), leader: !!(f & 32) });
    const showBar = m.hp < 100;
    m.bar.bg.visible = m.bar.fg.visible = showBar;
    if (showBar) {
      m.bar.fg.scale.x = Math.max(0.01, 0.96 * m.hp / 100);
      m.bar.fg.material.color.setHex(m.hp < 35 ? 0xff5050 : 0x66ff66);
    }
  }
  for (let i = dying.length - 1; i >= 0; i--) {         // tip over, stay red, then vanish
    const e = dying[i]; e.t += dt;
    const p = Math.min(1, e.t / 0.3);
    e.m.body.rotation.z = (Math.PI / 2) * (1 - (1 - p) * (1 - p));
    e.m.cr.hurtT = 0.28;
    e.m.cr.animate(dt, { speed: 0 });
    if (e.t > 0.9) { scene.remove(e.m.root); dying.splice(i, 1); }
  }
}
// closest mob along the camera ray (generous sphere) for melee
function pickMob(maxDist) {
  _eye.set(player.pos.x, player.pos.y + 1.62, player.pos.z);
  camera.getWorldDirection(_dir);
  let best = null, bestT = Infinity;
  for (const m of mobsC.values()) {
    const [cy, rad] = MOB_PICK[m.type] || [0.85, 0.9];
    const cx = m.root.position.x - _eye.x, cyy = m.root.position.y + cy - _eye.y, cz = m.root.position.z - _eye.z;
    const t = cx * _dir.x + cyy * _dir.y + cz * _dir.z;
    if (t < 0 || t > maxDist) continue;
    const perp2 = cx * cx + cyy * cyy + cz * cz - t * t;
    if (perp2 <= rad * rad && t < bestT) { bestT = t; best = m; }
  }
  return best;
}

/* ---------- arrows ---------- */
const arrowsC = new Map();
function spawnArrow(m) {
  const def = ARROWS.find(a => a.k === m.a) || ARROWS[0];
  const g = new THREE.Group();
  g.add(box(0.03, 0.03, 0.7, 0x9a7a4a, 0, 0, 0));
  g.add(box(0.07, 0.07, 0.1, def.color, 0, 0, -0.36));
  g.add(box(0.1, 0.01, 0.12, 0xeeeeee, 0, 0, 0.32));
  g.add(box(0.01, 0.1, 0.12, 0xeeeeee, 0, 0, 0.32));
  g.position.set(m.x, m.y, m.z);
  scene.add(g);
  const vel = new THREE.Vector3(m.vx, m.vy, m.vz);
  g.lookAt(g.position.clone().sub(vel));    // the shaft's +z end is the feathers, so the head leads
  arrowsC.set(m.id, { g, vel, age: 0, stuck: false });
}
function removeArrow(id) {
  const a = arrowsC.get(id); if (!a) return;
  scene.remove(a.g); arrowsC.delete(id);
}
function updateArrows(dt) {
  for (const [id, a] of [...arrowsC]) {
    a.age += dt;
    if (!a.stuck) {
      a.vel.y -= ARROW_GRAVITY * dt;
      a.g.position.addScaledVector(a.vel, dt);
      a.g.lookAt(a.g.position.clone().sub(a.vel));
      if (solidAt(Math.floor(a.g.position.x), Math.floor(a.g.position.y), Math.floor(a.g.position.z))) a.stuck = true;
    }
    if (a.age > (a.stuck ? 6 : 8)) removeArrow(id);
  }
}

/* ---------- first-person hand + held item (drawn in its own pass) ---------- */
const vm = new THREE.Group();
vmScene.add(vm);
const vmMats = [];
function vmBright(k) { for (const m of vmMats) m.color.setScalar(k); }
const arm = createArmMesh([58, 175, 180]);
vmMats.push(arm.material);
const armPivot = new THREE.Group();
arm.scale.setScalar(0.62);
armPivot.add(arm);
vm.add(armPivot);
const atlasHeldMat = new THREE.MeshBasicMaterial({ map: atlas.texture, vertexColors: true, alphaTest: 0.5 });
vmMats.push(atlasHeldMat);
let heldBlockMesh = null;
const itemMeshes = new Map();
function heldItem(kind, opt) {
  const k = kind + ':' + opt;
  let m = itemMeshes.get(k);
  if (!m) {
    m = itemMesh(kind, opt, kind === 'bow' ? 0.46 : 0.4);
    m.visible = false; vm.add(m); vmMats.push(m.material); itemMeshes.set(k, m);
  }
  return m;
}
let swing = 0, swingCd = 0, drawing = false, drawStart = 0, recoil = 0, bobT = 0;
function drawProgress() {
  if (!drawing) return 0;
  return Math.min(1, (performance.now() - drawStart) / ((inv.bow | 0) ? 600 : 900));
}
function refreshHeld() {
  const it = HOTBAR[selected];
  for (const m of itemMeshes.values()) m.visible = false;
  if (heldBlockMesh) { vm.remove(heldBlockMesh); heldBlockMesh.geometry.dispose(); heldBlockMesh = null; }
  if (it.k === 'block') {
    heldBlockMesh = new THREE.Mesh(blockCubeGeometry(it.id, 0.24), atlasHeldMat);
    vm.add(heldBlockMesh);
  }
}
const SWORD_POSE = { pos: [0.4, -0.24, -0.62], rot: [0.1, -0.5, 0.85] };
const BOW_POSE = { pos: [0.36, -0.22, -0.62], rot: [0.05, -1.45, 0.785] };
const BLOCK_POSE = { pos: [0.34, -0.28, -0.55], rot: [0.25, -0.7, 0.05] };
function updateViewmodel(dt, moving) {
  if (swingCd > 0) swingCd -= dt;
  if (swing > 0) swing = Math.max(0, swing - dt / 0.3);
  if (recoil > 0) recoil = Math.max(0, recoil - dt * 6);
  bobT += dt * (moving ? 9 : 0);
  const it = HOTBAR[selected];
  const s = Math.sin(swing * Math.PI), s2 = Math.sin(Math.sqrt(swing) * Math.PI);
  vm.position.set(Math.sin(bobT) * 0.012, Math.abs(Math.cos(bobT)) * -0.012, 0);
  vm.rotation.set(0, 0, 0);

  // arm: hangs from the shoulder at the lower right, reaching forward
  let ap = [0.52, -0.5, -0.2], ar = [1.7, 0.35, 0.0];
  let item = null, pose = null;
  if (it.k === 'sword') { item = heldItem('sword', Math.min(2, inv.sword | 0)); pose = SWORD_POSE; }
  else if (it.k === 'bow') {
    const stage = drawing ? Math.min(3, 1 + Math.floor(drawProgress() * 2.99)) : 0;
    item = heldItem('bow', stage); pose = BOW_POSE;
  } else if (heldBlockMesh) { item = heldBlockMesh; pose = BLOCK_POSE; }
  if (it.k === 'bow') { ap = [0.5, -0.5, -0.2], ar = [1.7, 0.45, 0.0]; }
  for (const m of itemMeshes.values()) m.visible = m === item;
  if (item) {
    item.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
    item.rotation.set(pose.rot[0], pose.rot[1], pose.rot[2]);
  }
  // swing: sword/arm chops down across the screen; a bow kicks back
  if (it.k === 'sword') {
    vm.rotation.x = -s * 0.9; vm.rotation.z = s * 0.35; vm.position.y -= s * 0.08; vm.position.x -= s * 0.22; vm.position.z -= s * 0.12;
  } else if (it.k === 'bow') {
    vm.position.z += recoil * 0.05;
    if (drawing && drawProgress() >= 1) vm.position.y += (Math.random() - 0.5) * 0.004;
    $('draw').firstElementChild.style.width = (drawProgress() * 100) + '%';
  } else {
    vm.rotation.x = -s2 * 0.7; vm.position.y -= s2 * 0.06; vm.position.x -= s2 * 0.1;
  }
  armPivot.position.set(ap[0], ap[1], ap[2]);
  armPivot.rotation.set(ar[0], ar[1], ar[2]);
}

/* ---------- networking ---------- */
const net = {
  ws: null, id: null, onInit: null,
  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); },
  connect(token) {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const ws = new WebSocket(proto + location.host + '/?token=' + encodeURIComponent(token));
    this.ws = ws;
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      switch (m.t) {
        case 'init':
          this.id = m.id; setSeed(m.seed);
          spawn = m.spawn || spawn;
          dayLen = m.dayLen || dayLen; phase0 = m.phase ?? phase0; tInit = performance.now();
          inv = m.inv || {}; recipes = m.recipes || []; hp = m.hp; maxHp = m.maxHp;
          for (const [x, y, z, b] of m.edits) {
            const cx = x >> 4, cz = z >> 4, ck = cx + ',' + cz;
            let em = world.edits.get(ck); if (!em) { em = new Map(); world.edits.set(ck, em); }
            em.set(cIdx(x & 15, y, z & 15), b);
          }
          for (const p of m.players) addRemote(p.id, p.name, p.x, p.y, p.z, p.yaw, p.pitch);
          this.onInit && this.onInit(m);
          break;
        case 'join': addRemote(m.id, m.name); break;
        case 'leave': removeRemote(m.id); break;
        case 'state':
          for (const [id, x, y, z, yaw, pitch] of m.p) {
            if (id === this.id) continue;
            const r = remotes.get(id); if (!r) continue;
            r.tx = x; r.ty = y; r.tz = z; r.tyaw = yaw; r.tpitch = pitch;
          }
          break;
        case 'edit': setBlock(m.x, m.y, m.z, m.b); break;
        case 'chat': addChat(m.name, m.text); break;
        case 'inv': inv = m.inv; onInvChanged(); break;
        case 'hp': hp = m.hp; maxHp = m.max; updateHp(); break;
        case 'hurt': flashHurt(); break;
        case 'respawn':
          spawn = { x: m.x, z: m.z };
          player.pos.set(m.x, 60, m.z); player.vel.set(0, 0, 0); player.ready = false; lastPcx = null;
          toast('You were slain. Respawning...', '#ff8a8a');
          break;
        case 'mobs': applyMobSnapshot(m.m); break;
        case 'mobdie': removeMob(m.id, !m.gone); break;
        case 'arrow': spawnArrow(m); break;
        case 'arrowend': removeArrow(m.id); break;
        case 'hitmark': hitMarker(m); break;
        case 'loot': showLoot(m); break;
        case 'crafted': toast('Crafted ' + m.name, '#c9a7ff'); break;
      }
    };
    ws.onclose = ev => {
      const msg = $('msg');
      msg.style.display = 'block';
      msg.textContent = ev.code === 4000 ? 'You logged in somewhere else. Refresh to rejoin.' : 'Disconnected. Refresh to rejoin.';
      document.exitPointerLock && document.exitPointerLock();
    };
  },
};

/* ---------- UI ---------- */
const chatBox = $('chat'), chatIn = $('chatin');
let chatOpen = false, craftOpen = false, paletteOpen = false, locked = false, started = false;

function addChat(name, text) {
  const d = document.createElement('div');
  if (name === '*') { d.style.color = '#ffd27a'; d.textContent = text; }
  else { const b = document.createElement('b'); b.textContent = name + ': '; d.appendChild(b); d.appendChild(document.createTextNode(text)); }
  chatBox.appendChild(d);
  while (chatBox.children.length > 8) chatBox.removeChild(chatBox.firstChild);
  setTimeout(() => d.remove(), 20000);
}
function toast(text, color) {
  const d = document.createElement('div');
  d.textContent = text; if (color) d.style.color = color;
  $('toast').appendChild(d);
  while ($('toast').children.length > 4) $('toast').removeChild($('toast').firstChild);
  setTimeout(() => d.remove(), 2700);
}
function flashHurt() {
  const h = $('hurt'); h.style.opacity = 1;
  setTimeout(() => { h.style.opacity = 0; }, 160);
}
function hitMarker(m) {
  const c = $('cross');
  c.className = m.weak ? 'weak' : 'hit';
  setTimeout(() => { c.className = ''; }, 160);
  if (m.weak) toast(`Headshot! ${m.dmg}`, '#ffd23a');
}
function showLoot(m) {
  const parts = Object.entries(m.items).map(([k, n]) => `+${n} ${ITEM_NAMES[k] || k}`);
  if (parts.length) toast(`${MOB_LABEL[m.type] || 'Mob'} drops: ${parts.join('  ')}`, '#8fe388');
}
function updateHp() {
  $('hpbar').firstElementChild.style.width = Math.max(0, hp / maxHp * 100) + '%';
}
function updateMats() {
  $('mats').innerHTML = MATS.filter(k => (inv[k] | 0) > 0 || k === 'wood')
    .map(k => `${ITEM_NAMES[k]} <b>${inv[k] | 0}</b>`).join('<br>') + ((inv.meat | 0) > 0 ? '<br><small>G to eat</small>' : '');
}
function updateEquip() {
  const it = HOTBAR[selected];
  let t = '';
  if (it.k === 'sword') t = SWORDS[Math.min(2, inv.sword | 0)];
  else if (it.k === 'bow') t = `${BOWS[Math.min(1, inv.bow | 0)]}  |  ${ARROWS[selArrow].name} x${inv[ARROWS[selArrow].k] | 0}  [R]`;
  else t = BLOCK_NAME(it.id);
  $('equip').textContent = t;
}
function ensureArrowSelected() {
  if ((inv[ARROWS[selArrow].k] | 0) > 0) return;
  const i = ARROWS.findIndex(a => (inv[a.k] | 0) > 0);
  if (i >= 0) selArrow = i;
}
function cycleArrow() {
  for (let i = 1; i <= ARROWS.length; i++) {
    const idx = (selArrow + i) % ARROWS.length;
    if ((inv[ARROWS[idx].k] | 0) > 0) { selArrow = idx; break; }
  }
  updateEquip(); refreshHeld();
}
let lastSwordTier = -1;
function onInvChanged() {
  ensureArrowSelected(); updateMats(); updateEquip(); refreshHeld();
  if ((inv.sword | 0) !== lastSwordTier) { lastSwordTier = inv.sword | 0; buildHotbar(); }
  if (craftOpen) buildCraft();
}

function buildHotbar() {
  const hb = $('hotbar'); hb.innerHTML = '';
  HOTBAR.forEach((it, i) => {
    const s = document.createElement('div'); s.className = 'slot' + (i === selected ? ' sel' : '');
    let src, title;
    if (it.k === 'block') { src = blockIcon(it.id); title = BLOCK_NAME(it.id); }
    else if (it.k === 'sword') { src = spriteURL('sword', Math.min(2, inv.sword | 0)); title = SWORDS[Math.min(2, inv.sword | 0)]; }
    else { src = spriteURL('bow', 0); title = BOWS[Math.min(1, inv.bow | 0)]; }
    s.innerHTML = `<img src="${src}" alt=""><b>${i + 1}</b>`;
    s.title = title;
    hb.appendChild(s);
  });
}
function selectSlot(i) {
  if (drawing) cancelDraw();
  selected = (i + HOTBAR.length) % HOTBAR.length;
  buildHotbar(); updateEquip(); refreshHeld();
  $('draw').style.display = 'none';
}

function costText(cost) {
  return Object.entries(cost).map(([k, n]) => {
    const have = inv[k] | 0;
    return `<span class="${have >= n ? 'ok' : 'no'}">${n} ${ITEM_NAMES[k] || k} (${have})</span>`;
  }).join(', ');
}
function buildCraft() {
  const box_ = $('craftbox');
  const have = MATS.map(k => `${ITEM_NAMES[k]} ${inv[k] | 0}`).join(' &nbsp;|&nbsp; ');
  let html = `<h2>Crafting</h2><div class="have">${have}</div>`;
  for (const r of recipes) {
    let owned = false, locked_ = false;
    if (r.set) for (const [k, v] of Object.entries(r.set)) if ((inv[k] | 0) >= v) owned = true;
    if (r.need) for (const [k, v] of Object.entries(r.need)) if ((inv[k] | 0) !== v) locked_ = true;
    const can = !owned && !locked_ && Object.entries(r.cost).every(([k, n]) => (inv[k] | 0) >= n);
    const label = owned ? 'Owned' : (locked_ ? 'Locked' : 'Craft');
    html += `<div class="rec"><div><b>${r.name}</b><br><small>${r.desc}</small><br><small>${costText(r.cost)}</small></div>` +
            `<button data-id="${r.id}" ${can ? '' : 'disabled'}>${label}</button></div>`;
  }
  html += `<div class="have" style="margin-top:12px">Logs: break tree trunks. Coal, iron and diamond: mine ores underground.<br>Feathers, string, bone, meat: from animals and monsters.<br>Press E to close.</div>`;
  box_.innerHTML = html;
  for (const btn of box_.querySelectorAll('button[data-id]')) {
    btn.onclick = () => net.send({ t: 'craft', id: btn.dataset.id });
  }
}
function openCraft() {
  craftOpen = true; buildCraft();
  $('craft').style.display = 'flex'; showHelp(false);
  keys.clear(); if (drawing) cancelDraw();
  document.exitPointerLock();
}
function closeCraft(relock) {
  craftOpen = false; $('craft').style.display = 'none';
  if (relock) renderer.domElement.requestPointerLock(); else showHelp(true);
}

// block palette: pick which block sits in the selected hotbar slot
function paletteSlot() { return HOTBAR[selected].k === 'block' ? selected : 2; }
function buildPalette() {
  const slot = paletteSlot();
  let html = `<h2>Blocks</h2><div class="have">Click a block to put it in hotbar slot ${slot + 1}. Press Q to close.</div><div class="grid">`;
  for (const id of PALETTE_BLOCKS) html += `<div class="pal${HOTBAR[slot].id === id ? ' cur' : ''}" data-id="${id}" title="${BLOCK_NAME(id)}"><img src="${blockIcon(id)}" alt=""><small>${BLOCK_NAME(id)}</small></div>`;
  html += '</div>';
  $('palbox').innerHTML = html;
  for (const el of $('palbox').querySelectorAll('.pal')) {
    el.onclick = () => {
      HOTBAR[slot].id = +el.dataset.id; saveHotbar();
      if (selected !== slot) selectSlot(slot); else { buildHotbar(); updateEquip(); refreshHeld(); }
      buildPalette();
    };
  }
}
function openPalette() {
  paletteOpen = true; buildPalette();
  $('palette').style.display = 'flex'; showHelp(false);
  keys.clear(); if (drawing) cancelDraw();
  document.exitPointerLock();
}
function closePalette(relock) {
  paletteOpen = false; $('palette').style.display = 'none';
  if (relock) renderer.domElement.requestPointerLock(); else showHelp(true);
}

function showHelp(show) { $('help').style.display = show ? 'flex' : 'none'; }
$('help').addEventListener('click', () => renderer.domElement.requestPointerLock());
renderer.domElement.addEventListener('click', () => { if (!locked && player.ready && !craftOpen && !paletteOpen) renderer.domElement.requestPointerLock(); });
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === renderer.domElement;
  if (!locked && drawing) cancelDraw();
  if (started) showHelp(!locked && !chatOpen && !craftOpen && !paletteOpen);
});

/* ---------- input ---------- */
document.addEventListener('mousemove', e => {
  if (!locked) return;
  player.yaw -= e.movementX * 0.0022;
  player.pitch = Math.max(-1.55, Math.min(1.55, player.pitch - e.movementY * 0.0022));
});

function attack() {
  if (swingCd > 0) return;
  swingCd = 0.35; swing = 1;
  const m = pickMob(3.8);
  if (m) net.send({ t: 'melee', id: m.id });
  else breakBlock();
}
function startDraw() {
  const key = ARROWS[selArrow].k;
  if ((inv[key] | 0) <= 0) { toast('Out of arrows. Press R to switch, or E to craft.', '#ff8a8a'); return; }
  drawing = true; drawStart = performance.now();
  $('draw').style.display = 'block';
}
function cancelDraw() { drawing = false; $('draw').style.display = 'none'; }
function releaseBow() {
  if (!drawing) return;
  const d = drawProgress();
  cancelDraw();
  if (d < 0.25) return;
  const key = ARROWS[selArrow].k;
  if ((inv[key] | 0) <= 0) return;
  camera.getWorldDirection(_dir);
  net.send({ t: 'shoot', dx: _dir.x, dy: _dir.y, dz: _dir.z, draw: d, a: key });
  recoil = 1;
}
function useBlockTool() {                       // left click with a block in hand: swing and mine
  if (swingCd > 0) return;
  swingCd = 0.25; swing = 1;
  breakBlock();
}

document.addEventListener('mousedown', e => {
  if (!locked) return;
  const it = HOTBAR[selected];
  if (e.button === 0) {
    if (it.k === 'sword') attack();
    else if (it.k === 'bow') startDraw();
    else useBlockTool();
  } else if (e.button === 2) { placeBlock(); if (HOTBAR[selected].k === 'block') { swing = Math.max(swing, 0.6); } }
});
document.addEventListener('mouseup', e => { if (e.button === 0 && drawing) releaseBow(); });
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('wheel', e => { if (locked) selectSlot(selected + (e.deltaY > 0 ? 1 : -1)); });

function openChat() {
  chatOpen = true; chatIn.style.display = 'block'; chatIn.value = ''; chatIn.focus(); keys.clear();
}
function closeChat() {
  chatOpen = false; chatIn.style.display = 'none'; chatIn.blur();
}
chatIn.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    const text = chatIn.value.trim();
    if (text) net.send({ t: 'chat', text });
    closeChat(); renderer.domElement.requestPointerLock();
  } else if (e.key === 'Escape') { closeChat(); showHelp(true); }
});
document.addEventListener('keydown', e => {
  if (chatOpen || !started) return;
  if (craftOpen) {
    if (e.code === 'KeyE') { e.preventDefault(); closeCraft(true); }
    else if (e.code === 'Escape') closeCraft(false);
    return;
  }
  if (paletteOpen) {
    if (e.code === 'KeyQ') { e.preventDefault(); closePalette(true); }
    else if (e.code === 'Escape') closePalette(false);
    return;
  }
  if (e.code === 'KeyE' && player.ready && !e.repeat) { e.preventDefault(); openCraft(); return; }
  if (e.code === 'KeyQ' && player.ready && !e.repeat) { e.preventDefault(); openPalette(); return; }
  if (e.code === 'Enter' && player.ready) { e.preventDefault(); openChat(); return; }
  if (e.code === 'KeyF' && !e.repeat) { player.fly = !player.fly; return; }
  if (e.code === 'KeyR' && !e.repeat) { cycleArrow(); return; }
  if (e.code === 'KeyG' && !e.repeat) { net.send({ t: 'eat' }); return; }
  if (e.code.startsWith('Digit')) { const n = parseInt(e.code.slice(5), 10); if (n >= 1 && n <= HOTBAR.length) selectSlot(n - 1); }
  if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
});
document.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

/* ---------- auth ---------- */
const errEl = $('err');
async function authCall(kind) {
  errEl.textContent = '';
  const username = $('user').value.trim(), password = $('pass').value;
  try {
    const r = await fetch('/api/' + kind, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const j = await r.json();
    if (!r.ok) { errEl.textContent = j.error || 'Something went wrong'; return; }
    localStorage.setItem('cl_token', j.token);
    startGame(j.token);
  } catch { errEl.textContent = 'Cannot reach the server'; }
}
$('login').onclick = () => authCall('login');
$('register').onclick = () => authCall('register');
$('pass').addEventListener('keydown', e => { if (e.key === 'Enter') authCall('login'); });

function startGame(token) {
  if (started) return;
  started = true;
  $('auth').style.display = 'none';
  $('hud').style.display = 'block';
  buildHotbar();
  net.onInit = () => {
    player.pos.set(spawn.x, 60, spawn.z);
    lastPcx = null;
    onInvChanged(); updateHp(); refreshHeld();
    showHelp(true);
    requestAnimationFrame(loop);
  };
  net.connect(token);
}
(async () => {
  const token = localStorage.getItem('cl_token');
  if (!token) return;
  try {
    const r = await fetch('/api/session?token=' + encodeURIComponent(token));
    if (r.ok) startGame(token); else localStorage.removeItem('cl_token');
  } catch {}
})();

// handles for automated tests / screenshots
window.__cl = { player, camera, mobsC, remotes, world, get daylight() { return daylight; }, set phase(v) { phase0 = v; tInit = performance.now(); }, HOTBAR, selectSlot, setBlock, getBlock };

/* ---------- main loop ---------- */
let last = performance.now(), fpsAcc = 0, fpsN = 0, fps = 0, posTimer = 0, wasUnder = null;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fpsAcc += dt; fpsN++;
  if (fpsAcc >= 0.5) { fps = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }

  updateStreaming();
  if (!player.ready) tryPlaceOnGround();
  else if (locked) physics(dt);

  camera.position.set(player.pos.x, player.pos.y + 1.62, player.pos.z);
  camera.rotation.set(player.pitch, player.yaw, 0);
  camera.updateMatrixWorld();
  updateTarget();
  updateRemotes(dt);
  updateMobs(dt);
  updateArrows(dt);
  updateParticles(dt);
  updateViewmodel(dt, locked && player.onGround && (keys.has('KeyW') || keys.has('KeyA') || keys.has('KeyS') || keys.has('KeyD')));

  // underwater look + sky
  const under = isWaterAt(camera.position.x, camera.position.y, camera.position.z);
  if (under !== wasUnder) { wasUnder = under; $('waterov').style.display = under ? 'block' : 'none'; }
  updateSky(under);

  posTimer += dt;
  if (posTimer > 0.066 && player.ready) {
    posTimer = 0;
    net.send({ t: 'pos', x: player.pos.x, y: player.pos.y, z: player.pos.z, yaw: player.yaw, pitch: player.pitch });
  }
  const ph = worldPhase();
  const clock = ph < 0.53 ? 'Day' : ph < 0.97 ? 'Night' : 'Dawn';
  $('info').innerHTML =
    `FPS ${fps}<br>XYZ ${player.pos.x.toFixed(1)} ${player.pos.y.toFixed(1)} ${player.pos.z.toFixed(1)}<br>` +
    `${BIOME_NAME[biomeAt(Math.floor(player.pos.x), Math.floor(player.pos.z))]} &middot; ${clock}<br>` +
    `Players online: ${remotes.size + 1}${player.fly ? '<br>FLY MODE' : ''}${player.ready ? '' : '<br>Generating world...'}`;
  renderer.clear();
  renderer.render(scene, camera);
  renderer.clearDepth();
  vmCamera.position.set(0, 0, 0);
  renderer.render(vmScene, vmCamera);
}
