// Shared by the browser client and the Node server so both agree on the ground.
export const CS = 16;   // chunk width/depth
export const CH = 64;   // world height
export const SEA = 28;  // water fills columns lower than this
export let SEED = 1337;
export function setSeed(s) { SEED = s; }

// block ids (shared with the client block table)
export const B = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, LOG: 5, LEAVES: 6, SNOW: 7, PLANKS: 8, WATER: 9,
  COBBLE: 10, GRAVEL: 11, BEDROCK: 12, COAL_ORE: 13, IRON_ORE: 14, DIAMOND_ORE: 15, CACTUS: 16, SPRUCE_LEAVES: 17,
};

export function hash2(x, z, s) {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(s, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function hash3(x, y, z, s) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 1103515245) ^ Math.imul(z, 668265263) ^ Math.imul(s, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const smooth = t => t * t * (3 - 2 * t);
function vnoise(x, z, s) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = smooth(x - xi), zf = smooth(z - zi);
  const a = hash2(xi, zi, s), b = hash2(xi + 1, zi, s), c = hash2(xi, zi + 1, s), d = hash2(xi + 1, zi + 1, s);
  return a + (b - a) * xf + (c - a) * zf + (a - b - c + d) * xf * zf;
}
function fbm(x, z) {
  let v = 0, amp = 0.5, f = 1;
  for (let i = 0; i < 4; i++) { v += vnoise(x * f, z * f, SEED + i * 101) * amp; f *= 2; amp *= 0.5; }
  return v;
}
export function rawHeight(x, z) {
  const n = Math.max(0, Math.min(1, (fbm(x * 0.008, z * 0.008) - 0.47) * 2.2 + 0.5)); // stretch contrast: real hills, valleys, peaks
  const m = fbm(x * 0.03 + 100, z * 0.03 + 100);
  return Math.min(52, Math.floor(14 + n * 38 + m * 6));
}

/* ---------- arenas: two walled pits ('ffa' free-for-all, 'wave' survival), placed deterministically from the seed ---------- */
export const ARENA_KINDS = ['ffa', 'wave'];
const ARENA_DEF = { ffa: { half: 24, start: [120, 40] }, wave: { half: 28, start: [-130, 70] } };
const SKIRT = 14;       // the land eases into the arena floor over this many blocks, so there are no cliffs around it
let _arenas = null, _arenaSeed = null;
export function arenas() {
  if (_arenas && _arenaSeed === SEED) return _arenas;
  const out = {};
  for (const kind of ARENA_KINDS) {
    const { half, start } = ARENA_DEF[kind];
    const ok = (cx, cz) => {
      for (const o of Object.values(out)) if (Math.max(Math.abs(cx - o.cx), Math.abs(cz - o.cz)) < half + o.half + 2 * SKIRT + 8) return 0;
      let lo = 99, hi = 0, sum = 0;
      for (const dx of [-half, 0, half]) for (const dz of [-half, 0, half]) {
        const h = rawHeight(cx + dx, cz + dz);
        lo = Math.min(lo, h); hi = Math.max(hi, h); sum += h;
      }
      return lo >= SEA + 2 && hi <= 44 && hi - lo <= 12 ? Math.round(sum / 9) : 0;
    };
    let pick = null;
    search:
    for (let r = 0; r <= 300; r += 8) {
      const steps = r === 0 ? 1 : Math.ceil(r / 4);
      for (let k = 0; k < steps; k++) {
        const ang = (k / steps) * Math.PI * 2;
        const cx = Math.round(start[0] + Math.cos(ang) * r), cz = Math.round(start[1] + Math.sin(ang) * r);
        const f = ok(cx, cz);
        if (f) { pick = { cx, cz, floor: Math.max(SEA + 3, Math.min(40, f)) }; break search; }
      }
    }
    if (!pick) pick = { cx: start[0], cz: start[1], floor: SEA + 3 };
    out[kind] = { kind, half, ...pick };
  }
  _arenas = out; _arenaSeed = SEED;
  return out;
}
export const arena = kind => arenas()[kind || 'ffa'];
// which arena footprint (if any) contains the column; m widens the zone (keeps mobs and trees away)
export function zoneAt(x, z, m = 0) {
  const A = arenas(), fx = Math.floor(x), fz = Math.floor(z);
  for (const k of ARENA_KINDS) {
    const a = A[k];
    if (Math.abs(fx - a.cx) <= a.half + m && Math.abs(fz - a.cz) <= a.half + m) return k;
  }
  return null;
}
export const inArena = (x, z, m = 0) => zoneAt(x, z, m) !== null;
// arena blocks can never be broken or built on, by a player or by an explosion: anything that edits the world must ask this first
export const isProtected = (x, y, z) => inArena(x, z);
export function heightAt(x, z) {
  const A = arenas(), fx = Math.floor(x), fz = Math.floor(z);
  for (const k of ARENA_KINDS) {
    const a = A[k];
    const d = Math.max(Math.abs(fx - a.cx), Math.abs(fz - a.cz)) - a.half;
    if (d <= 0) return a.floor;
    if (d < SKIRT) return Math.round(a.floor + (rawHeight(x, z) - a.floor) * smooth(d / SKIRT));
  }
  return rawHeight(x, z);
}
function ffaBlock(x, y, z, ax, az, F) {
  const h = y - F;
  if (ax >= 23 || az >= 23) {                                   // outer wall, 2 thick, with a gate in the middle of each side
    if ((az >= 23 && ax <= 2) || (ax >= 23 && az <= 2)) return h <= 5 ? 0 : h <= 9 ? B.PLANKS : 0;
    if (h <= 9) return h === 9 ? B.STONE : B.COBBLE;
    if (h === 10 && ((x + z) & 1) === 0) return B.COBBLE;       // battlements
    return 0;
  }
  const m = Math.max(ax, az);
  if ((m <= 5 && h <= 1) || (m <= 3 && h <= 2) || (m <= 1 && h <= 3)) return B.PLANKS;   // central ziggurat
  if (ax >= 11 && ax <= 12 && az >= 11 && az <= 12 && h <= 6) return B.LOG;              // four pillars
  if (((az === 6 && ax >= 14 && ax <= 18) || (ax === 6 && az >= 14 && az <= 18)) && h <= 2) return B.COBBLE;   // low cover walls
  if (ax >= 12 && ax <= 17 && az >= 18 && az <= 22 && h <= ax - 11) return B.COBBLE;     // stairs up to each corner tower
  if (ax >= 18 && ax <= 22 && az >= 18 && az <= 22) {                                    // corner towers
    if (h === 6) return B.PLANKS;
    if (h < 6 && (ax === 18 || ax === 22) && (az === 18 || az === 22)) return B.LOG;
    if (h === 7 && az === 18) return B.STONE;
    if (ax === 22 && az === 22 && h >= 7 && h <= 16) return B.LOG;                        // flag poles, visible from afar
  }
  return 0;
}
// the wave fortress: four doors the raiders pour out of, a stepped keep with a parapet to hold
function waveBlock(x, y, z, ax, az, F) {
  const h = y - F;
  if (ax >= 27 || az >= 27) {
    const doorZ = az >= 27 && ax <= 2, doorX = ax >= 27 && az <= 2;
    if (doorZ || doorX) return h <= 4 ? 0 : h <= 10 ? B.PLANKS : 0;                      // 5 wide, 4 tall, lintel above
    if (((az >= 27 && ax === 3) || (ax >= 27 && az === 3)) && h <= 4) return B.LOG;       // door frames
    if (h <= 10) return h === 10 ? B.STONE : B.COBBLE;
    if (h === 11 && ((x + z) & 1) === 0) return B.COBBLE;
    return 0;
  }
  const m = Math.max(ax, az);
  if ((m <= 9 && h <= 1) || (m <= 7 && h <= 2) || (m <= 5 && h <= 3)) return B.PLANKS;   // stepped keep
  if (m === 5 && h === 4 && ax > 1 && az > 1) return B.COBBLE;                            // parapet with a gap on each axis
  if (ax >= 14 && ax <= 15 && az >= 14 && az <= 15 && h <= 7) return B.LOG;              // pillars
  if (((az === 11 && ax >= 16 && ax <= 20) || (ax === 11 && az >= 16 && az <= 20)) && h <= 2) return B.COBBLE;   // cover
  if (ax === 25 && az === 25 && h <= 18) return B.LOG;                                    // flag poles
  return 0;
}
// block at a world position inside an arena footprint, or -1 outside. The floor is y = floor.
export function arenaBlockAt(x, y, z) {
  const k = zoneAt(x, z);
  if (!k) return -1;
  const a = arenas()[k], F = a.floor;
  if (y < F) return B.STONE;
  if (y === F) {
    const ax = Math.abs(x - a.cx), az = Math.abs(z - a.cz);
    return k === 'ffa' ? (((x >> 2) + (z >> 2)) & 1 ? B.STONE : B.COBBLE) : ((Math.max(ax, az) >> 2) & 1 ? B.STONE : B.GRAVEL);
  }
  if (y > F + 40) return -1;
  const ax = Math.abs(x - a.cx), az = Math.abs(z - a.cz);
  return k === 'ffa' ? ffaBlock(x, y, z, ax, az, F) : waveBlock(x, y, z, ax, az, F);
}
export function arenaSpawns(kind = 'ffa') {
  const a = arena(kind), out = [];
  if (kind === 'wave') {
    for (const [dx, dz] of [[2, 2], [-2, 2], [2, -2], [-2, -2]]) out.push({ x: a.cx + dx + 0.5, y: a.floor + 4, z: a.cz + dz + 0.5 });
    return out;
  }
  for (const [dx, dz] of [[0, 18], [0, -18], [18, 0], [-18, 0], [15, 15], [-15, 15], [15, -15], [-15, -15]])
    out.push({ x: a.cx + dx + 0.5, y: a.floor + 1, z: a.cz + dz + 0.5 });
  return out;
}
// where raiders walk out: just inside each door of the wave fortress, with the direction they face
export function waveDoors() {
  const a = arena('wave'), y = a.floor + 1, o = 28.5;
  return [
    { x: a.cx + 0.5, z: a.cz + 0.5 + o, y }, { x: a.cx + 0.5, z: a.cz + 0.5 - o, y },
    { x: a.cx + 0.5 + o, z: a.cz + 0.5, y }, { x: a.cx + 0.5 - o, z: a.cz + 0.5, y },
  ];
}

/* ---------- biomes ---------- */
export const BIOME = { PLAINS: 0, FOREST: 1, DESERT: 2, SNOW: 3 };
export function biomeAt(x, z) {
  const t = vnoise(x * 0.0045 + 500, z * 0.0045 + 500, SEED + 31);   // temperature
  const m = vnoise(x * 0.006 - 700, z * 0.006 - 700, SEED + 47);     // moisture
  if (t < 0.3) return BIOME.SNOW;
  if (t > 0.68 && m < 0.55) return BIOME.DESERT;
  return m > 0.52 ? BIOME.FOREST : BIOME.PLAINS;
}
// block ids for the top layer and the few layers under it
export function surfaceAt(x, z, h) {
  if (h >= 46) return { top: B.SNOW, sub: B.DIRT };
  const bio = biomeAt(x, z);
  if (h <= SEA + 1) {                                   // shore and lake bed
    const g = vnoise(x * 0.09, z * 0.09, SEED + 71);
    if (h < SEA - 2 && g > 0.62) return { top: B.GRAVEL, sub: B.GRAVEL };
    return { top: B.SAND, sub: B.SAND };
  }
  if (bio === BIOME.DESERT) return { top: B.SAND, sub: B.SAND };
  if (bio === BIOME.SNOW) return { top: B.SNOW, sub: B.DIRT };
  return { top: B.GRASS, sub: B.DIRT };
}

/* ---------- surface features: 1 oak, 2 cactus, 3 spruce ---------- */
export function featureAt(x, z, h) {
  if (inArena(x, z, 5)) return 0;
  if (h <= SEA + 2 || h >= 44) return 0;
  const bio = biomeAt(x, z);
  const r = hash2(x, z, SEED + 7);
  if (bio === BIOME.FOREST) return r < 0.026 ? 1 : 0;
  if (bio === BIOME.PLAINS) return r < 0.0035 ? 1 : 0;
  if (bio === BIOME.DESERT) return r < 0.004 ? 2 : 0;
  return r < 0.012 ? 3 : 0;
}
export function treeAt(x, z, h) { return featureAt(x, z, h) > 0; }   // anything solid standing on the column
export function trunkHeight(x, z) {
  const k = featureAt(x, z, heightAt(x, z));
  const r = hash2(x, z, SEED + 9);
  if (k === 2) return 1 + Math.floor(r * 3);          // cactus
  if (k === 3) return 5 + Math.floor(r * 3);          // spruce
  return 4 + Math.floor(r * 2);                       // oak
}
// true if (x,y,z) is part of a natural, untouched tree trunk
export function isNaturalWood(x, y, z) {
  const h = heightAt(x, z);
  const k = featureAt(x, z, h);
  return (k === 1 || k === 3) && y > h && y <= h + trunkHeight(x, z);
}

/* ---------- ores (inside stone, below the dirt layer) ---------- */
export function oreAt(x, y, z, h) {
  if (y > h - 4 || y < 2) return 0;
  const r = hash3(x, y, z, SEED + 13);
  if (r > 0.04) return 0;
  const cell = hash3(x >> 1, y >> 1, z >> 1, SEED + 17);          // clumps ore into small veins
  if (cell > 0.5) return 0;
  const k = hash3(x, y, z, SEED + 19);
  if (y < 14 && r < 0.004) return B.DIAMOND_ORE;
  if (y < 38 && k < 0.32) return B.IRON_ORE;
  if (k < 0.75) return B.COAL_ORE;
  return 0;
}
// natural ore block at a position, or 0 (used by the server to give drops once)
export function naturalOre(x, y, z) {
  const h = heightAt(x, z);
  if (y >= h - 3) return 0;
  return oreAt(x, y, z, h);
}

// no tree or cactus within a few blocks, so the player never spawns under a canopy
function openGround(x, z) {
  for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) if (treeAt(x + dx, z + dz, heightAt(x + dx, z + dz))) return false;
  return true;
}
// nearest dry, tree-free column to the origin (spiral search)
export function spawnPoint() {
  for (let r = 0; r < 120; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const h = heightAt(dx, dz);
        if (h >= SEA + 2 && h < 40 && !inArena(dx, dz, SKIRT + 6) && !treeAt(dx, dz, h) && openGround(dx, dz)) return { x: dx + 0.5, z: dz + 0.5 };
      }
    }
  }
  return { x: 0.5, z: 0.5 };
}
