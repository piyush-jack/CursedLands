'use strict';
// Cursed Lands server - zero dependencies (Node 18+). HTTP + auth + WebSocket multiplayer.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const createMobs = require('./mobs.js');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SEED = parseInt(process.env.WORLD_SEED || '1337', 10);
const MAX_BLOCK = 17;   // highest block id (see BLOCK_DEFS in public/textures.js)
const DAY_LEN = 600;    // seconds for a full day/night cycle
const START_PHASE = parseFloat(process.env.START_PHASE || '0.08');   // 0 = sunrise, 0.25 = noon, 0.5 = sunset, 0.75 = midnight
const WORLD_T0 = Date.now() - DAY_LEN * START_PHASE * 1000;
const WORLD_H = 64;

fs.mkdirSync(DATA_DIR, { recursive: true });
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const EDITS_FILE = path.join(DATA_DIR, 'edits.json');

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
const users = loadJson(USERS_FILE, {});   // lowercase name -> {name, salt, hash}
const edits = loadJson(EDITS_FILE, {});   // "x,y,z" -> block id
const sessions = new Map();               // token -> user name

function starterInv() {
  return { wood: 0, feather: 0, string: 0, bone: 0, iron: 0, coal: 0, diamond: 0, meat: 0, a_wood: 10, a_scrap: 0, a_spark: 0, a_core: 0, sword: 0, bow: 0 };
}

function flush() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users));
    fs.writeFileSync(EDITS_FILE, JSON.stringify(edits));
  } catch (e) { console.error('save failed', e.message); }
}
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 2000);
}

/* ---------------- auth helpers ---------------- */
const hashPassword = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
function issueToken(name) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, name);
  return token;
}
const authHits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (authHits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now);
  authHits.set(ip, arr);
  return arr.length > 20;
}
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : req.socket.remoteAddress) || '?';
}

/* ---------------- HTTP ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
};
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req, cb) {
  let size = 0; const chunks = [];
  req.on('data', c => {
    size += c.length;
    if (size > 10 * 1024) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    try { cb(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { cb(null); }
  });
}

function handleRegister(req, res) {
  if (rateLimited(clientIp(req))) return json(res, 429, { error: 'Too many attempts, wait a minute.' });
  readBody(req, body => {
    const { username, password } = body || {};
    if (typeof username !== 'string' || !NAME_RE.test(username))
      return json(res, 400, { error: 'Username: 3-16 letters, numbers or _' });
    if (typeof password !== 'string' || password.length < 6 || password.length > 100)
      return json(res, 400, { error: 'Password must be at least 6 characters' });
    const key = username.toLowerCase();
    if (users[key]) return json(res, 409, { error: 'That username is taken' });
    const salt = crypto.randomBytes(16).toString('hex');
    users[key] = { name: username, salt, hash: hashPassword(password, salt), inv: starterInv() };
    scheduleSave();
    json(res, 200, { token: issueToken(username), name: username });
  });
}
function handleLogin(req, res) {
  if (rateLimited(clientIp(req))) return json(res, 429, { error: 'Too many attempts, wait a minute.' });
  readBody(req, body => {
    const { username, password } = body || {};
    if (typeof username !== 'string' || typeof password !== 'string')
      return json(res, 400, { error: 'Missing username or password' });
    const u = users[username.toLowerCase()];
    if (!u) return json(res, 401, { error: 'Wrong username or password' });
    const attempt = Buffer.from(hashPassword(password, u.salt), 'hex');
    const real = Buffer.from(u.hash, 'hex');
    if (attempt.length !== real.length || !crypto.timingSafeEqual(attempt, real))
      return json(res, 401, { error: 'Wrong username or password' });
    json(res, 200, { token: issueToken(u.name), name: u.name });
  });
}

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/api/register') return handleRegister(req, res);
  if (req.method === 'POST' && url.pathname === '/api/login') return handleLogin(req, res);
  if (req.method === 'GET' && url.pathname === '/api/session') {
    const name = sessions.get(url.searchParams.get('token') || '');
    return name ? json(res, 200, { name }) : json(res, 401, { error: 'expired' });
  }
  if (req.method === 'GET' && url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
  res.writeHead(405); res.end();
});

/* ---------------- minimal WebSocket (RFC 6455) ---------------- */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(op, payload) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
  return Buffer.concat([header, payload]);
}

class Conn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.readyState = 1;
    this.frags = [];
    this.fragOp = 0;
    this.handlers = {};
    socket.setNoDelay(true);
    socket.on('data', d => this._data(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => {});
  }
  on(ev, fn) { this.handlers[ev] = fn; }
  _emit(ev, arg) { const h = this.handlers[ev]; if (h) h(arg); }
  send(str) { if (this.readyState === 1) this.socket.write(encodeFrame(0x1, Buffer.from(str, 'utf8'))); }
  ping() { if (this.readyState === 1) this.socket.write(encodeFrame(0x9, Buffer.alloc(0))); }
  close(code = 1000, reason = '') {
    if (this.readyState !== 1) return;
    this.readyState = 2;
    const r = Buffer.from(reason, 'utf8').subarray(0, 100);
    const p = Buffer.alloc(2 + r.length); p.writeUInt16BE(code, 0); r.copy(p, 2);
    this.socket.write(encodeFrame(0x8, p));
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }
  _closed() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this._emit('close');
  }
  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.readyState === 1 && this._frame()) { /* keep parsing */ }
  }
  _frame() {
    const b = this.buf;
    if (b.length < 2) return false;
    const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return false; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) {
      if (b.length < 10) return false;
      if (b.readUInt32BE(2) !== 0) { this.close(1009); return false; }
      len = b.readUInt32BE(6); off = 10;
    }
    if (len > 65536) { this.close(1009); return false; }
    if (!masked) { this.close(1002); return false; }
    if (b.length < off + 4 + len) return false;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buf = b.subarray(off + 4 + len);

    if (op === 0x8) { this.close(1000); return false; }
    if (op === 0x9) { this.socket.write(encodeFrame(0xA, payload)); return true; }
    if (op === 0xA) return true;
    if (op === 0x1 || op === 0x2) { this.frags = [payload]; this.fragOp = op; }
    else if (op === 0x0) { this.frags.push(payload); }
    else { this.close(1002); return false; }
    if (fin) {
      const full = Buffer.concat(this.frags); this.frags = [];
      if (this.fragOp === 0x1) this._emit('message', full.toString('utf8'));
    }
    return true;
  }
}

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  const name = sessions.get(url.searchParams.get('token') || '');
  const key = req.headers['sec-websocket-key'];
  if (!name || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  const ws = new Conn(socket);
  ws.userName = name;
  onConnection(ws);
});

/* ---------------- game state ---------------- */
let T = null;        // shared terrain module (loaded before listen)
let SPAWN = { x: 0.5, z: 0.5 };
let mobsys = null;
const players = new Map(); // id -> {id,name,x,y,z,yaw,pitch,ws,inv,hp,...}
let nextId = 1;

const SWORD_DMG = [4, 8, 14];
const BOW_MULT = [1, 1.35];
const ARROW_DEF = {
  a_wood:  { dmg: 5,  stun: 0 },
  a_scrap: { dmg: 9,  stun: 0 },
  a_spark: { dmg: 8,  stun: 3000 },
  a_core:  { dmg: 18, stun: 0 },
};
const WEAK_MULT = 2.5;
const ARROW_GRAVITY = 20;
const SWORD_NAMES = ['Wooden Sword', 'Iron Sword', 'Diamond Sword'];
const PVP_MELEE = 0.6, PVP_ARROW = 0.55;   // player health is 20, so mob-tuned damage is scaled down against players

// arena guns (hitscan, server-side). Only work inside the arena; ammo is handed out on entry and on every respawn.
const GUNS = {
  pistol:  { name: 'Pistol',  dmg: 7,   cd: 300,  pellets: 1, spread: 0.004, range: 90,  ammo: 90,  head: 2 },
  rifle:   { name: 'Rifle',   dmg: 3,   cd: 110,  pellets: 1, spread: 0.02,  range: 90,  ammo: 240, head: 2 },
  shotgun: { name: 'Shotgun', dmg: 3.5, cd: 850,  pellets: 8, spread: 0.07,  range: 28,  ammo: 32,  head: 1.5 },
  sniper:  { name: 'Sniper',  dmg: 15,  cd: 1500, pellets: 1, spread: 0,     range: 220, ammo: 16,  head: 2 },
};
const freshGuns = () => Object.fromEntries(Object.entries(GUNS).map(([k, g]) => [k, g.ammo]));
const arenaStats = new Map();   // lowercase name -> { k, d } (kept until the server restarts)
const statOf = p => { const k = p.name.toLowerCase(); let s = arenaStats.get(k); if (!s) { s = { k: 0, d: 0 }; arenaStats.set(k, s); } return s; };

const RECIPES = [
  { id: 'a_wood',  name: 'Arrows x5',       desc: 'Plain arrows.', cost: { wood: 1, feather: 1 }, give: { a_wood: 5 } },
  { id: 'a_scrap', name: 'Iron Arrows x4',  desc: 'Iron tips. Hit harder.', cost: { wood: 1, iron: 1, feather: 1 }, give: { a_scrap: 4 } },
  { id: 'a_spark', name: 'Frost Arrows x3', desc: 'Freezes a mob in place for 3s.', cost: { wood: 1, bone: 1, feather: 1 }, give: { a_spark: 3 } },
  { id: 'a_core',  name: 'Flame Arrows x2', desc: 'Burning tips. Huge damage.', cost: { wood: 1, coal: 2, iron: 1 }, give: { a_core: 2 } },
  { id: 'sword1',  name: 'Iron Sword',      desc: 'Sword damage 4 -> 8.', cost: { iron: 3, wood: 1 }, need: { sword: 0 }, set: { sword: 1 } },
  { id: 'sword2',  name: 'Diamond Sword',   desc: 'Sword damage 14.', cost: { diamond: 2, iron: 1, wood: 1 }, need: { sword: 1 }, set: { sword: 2 } },
  { id: 'bow1',    name: 'Power Bow',       desc: '+35% arrow damage, faster draw.', cost: { string: 3, wood: 2, iron: 1 }, need: { bow: 0 }, set: { bow: 1 } },
];
// item, min, max, chance
const LOOT = {
  pig:     [['meat', 1, 2, 1]],
  cow:     [['meat', 1, 3, 1]],
  sheep:   [['meat', 1, 2, 1]],
  chicken: [['feather', 1, 2, 1], ['meat', 1, 1, 0.6]],
  wolf:    [['bone', 1, 2, 0.7]],
  zombie:  [['iron', 1, 1, 0.12], ['bone', 1, 1, 0.3]],
  spider:  [['string', 1, 2, 0.9], ['bone', 1, 1, 0.2]],
};
const ORE_DROP = { 13: 'coal', 14: 'iron', 15: 'diamond' };
const EAT_HEAL = 6;

function worldPhase() { return (((Date.now() - WORLD_T0) / 1000) % DAY_LEN) / DAY_LEN; }   // 0 = sunrise, 0.25 = noon, 0.5 = sunset
const isNight = () => { const f = worldPhase(); return f > 0.53 && f < 0.97; };

function send(ws, obj) { ws.send(JSON.stringify(obj)); }
function broadcast(obj, exceptId) {
  const msg = JSON.stringify(obj);
  for (const p of players.values()) if (p.id !== exceptId) p.ws.send(msg);
}
const sendInv = p => send(p.ws, { t: 'inv', inv: p.inv });
function sendHp(p) { p.sentHp = Math.floor(p.hp * 2); send(p.ws, { t: 'hp', hp: Math.round(p.hp * 10) / 10, max: p.maxHp }); }

function rollLoot(type) {
  const items = {};
  for (const [item, min, max, chance] of LOOT[type] || []) {
    if (Math.random() < chance) items[item] = min + Math.floor(Math.random() * (max - min + 1));
  }
  return items;
}
function killMob(m, killer) {
  const items = rollLoot(m.type);
  if (killer && players.has(killer.id)) {
    for (const [k, n] of Object.entries(items)) killer.inv[k] = (killer.inv[k] | 0) + n;
    sendInv(killer);
    send(killer.ws, { t: 'loot', type: m.type, items });
    scheduleSave();
  }
  mobsys.mobs.delete(m.id);
  broadcast({ t: 'mobdie', id: m.id });
}

// src is { label } for mobs or { player, weapon } for players. Returns true if this hit killed the player.
function hurtPlayer(p, dmg, src) {
  const now = Date.now();
  if (now < p.invuln) return false;
  p.hp -= dmg;
  p.lastHurt = now;
  send(p.ws, { t: 'hurt', dmg });
  if (p.hp <= 0) { killPlayer(p, src); return true; }
  sendHp(p);
  return false;
}
function pickArenaSpawn(except) {
  const others = [...players.values()].filter(q => q !== except && q.inArena);
  let best = null, bestD = -1;
  for (const sp of T.arenaSpawns()) {
    let d = 1e9;
    for (const q of others) d = Math.min(d, Math.hypot(q.x - sp.x, q.z - sp.z));
    d += Math.random() * 4;
    if (d > bestD) { bestD = d; best = sp; }
  }
  return best;
}
function setArena(p, on) {
  p.inArena = on;
  p.guns = on ? freshGuns() : null;
  send(p.ws, { t: 'arena', on, guns: p.guns });
  if (on) broadcast({ t: 'chat', name: '*', text: `${p.name} entered the arena` });
}
function killPlayer(p, src) {
  const now = Date.now();
  const k = src.player && src.player !== p ? src.player : null;
  const wasArena = p.inArena;
  p.hp = p.maxHp;
  p.hasPos = false;
  p.invuln = now + (wasArena ? 3000 : 4000);
  const how = k ? `${k.name} killed ${p.name}${src.weapon ? ' with ' + src.weapon : ''}` : `${p.name} was slain by ${src.label || 'something'}`;
  broadcast({ t: 'chat', name: '*', text: how });
  if (wasArena) {
    statOf(p).d++;
    if (k) {
      statOf(k).k++;
      if (k.inArena) {                                     // reward: heal and top up ammo
        k.hp = Math.min(k.maxHp, k.hp + 6); sendHp(k);
        for (const [g, def] of Object.entries(GUNS)) k.guns[g] = Math.min(def.ammo, (k.guns[g] | 0) + Math.ceil(def.ammo * 0.25));
        send(k.ws, { t: 'ammo', guns: k.guns });
      }
    }
    const sp = pickArenaSpawn(p);
    p.x = sp.x; p.y = sp.y; p.z = sp.z;
    p.guns = freshGuns();
    send(p.ws, { t: 'respawn', x: sp.x, z: sp.z, msg: 'Eliminated. Back into the pit...' });
    send(p.ws, { t: 'arena', on: true, guns: p.guns });
  } else {
    p.x = SPAWN.x; p.y = 60; p.z = SPAWN.z;
    send(p.ws, { t: 'respawn', x: SPAWN.x, z: SPAWN.z, msg: 'You were slain. Respawning...' });
  }
  sendHp(p);
}

// ray against a sphere: distance along the (normalised) ray to the first contact, or null
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const fx = cx - ox, fy = cy - oy, fz = cz - oz;
  const t = fx * dx + fy * dy + fz * dz;
  if (t < 0) return null;
  const perp2 = fx * fx + fy * fy + fz * fz - t * t;
  if (perp2 > r * r) return null;
  return Math.max(0, t - Math.sqrt(r * r - perp2));
}
function solidSrv(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const ab = T.arenaBlockAt(ix, iy, iz);
  if (ab >= 0) return ab > 0 && ab !== T.B.WATER;
  return iy <= T.heightAt(ix, iz);
}
// player hit spheres: legs/torso x2 and the head (weak point). Sliding players are low to the ground.
function playerSpheres(q) {
  return q.sl
    ? [[q.y + 0.35, 0.5, false], [q.y + 0.85, 0.32, true]]
    : [[q.y + 0.5, 0.5, false], [q.y + 1.05, 0.5, false], [q.y + 1.62, 0.3, true]];
}
function fireGun(me, gd, key, dx, dy, dz) {
  const ox = me.x, oy = me.y + (me.sl ? 0.85 : 1.6), oz = me.z;
  const targets = [...players.values()].filter(q => q !== me && q.inArena && q.hasPos);
  const dmgBy = new Map(), ends = [];
  for (let i = 0; i < gd.pellets; i++) {
    let px = dx + (Math.random() - 0.5) * 2 * gd.spread, py = dy + (Math.random() - 0.5) * 2 * gd.spread, pz = dz + (Math.random() - 0.5) * 2 * gd.spread;
    const pl = Math.hypot(px, py, pz); px /= pl; py /= pl; pz /= pl;
    let L = gd.range;
    for (let s = 0.5; s <= gd.range; s += 0.5) if (solidSrv(ox + px * s, oy + py * s, oz + pz * s)) { L = s; break; }
    let best = null;
    for (const q of targets) {
      for (const [cy, r, head] of playerSpheres(q)) {
        const t = raySphere(ox, oy, oz, px, py, pz, q.x, cy, q.z, r);
        if (t !== null && t < L && (!best || t < best.t)) best = { t, q, head };
      }
    }
    const te = best ? best.t : L;
    ends.push([+(ox + px * te).toFixed(2), +(oy + py * te).toFixed(2), +(oz + pz * te).toFixed(2)]);
    if (best) {
      const acc = dmgBy.get(best.q) || { dmg: 0, head: false };
      acc.dmg += gd.dmg * (best.head ? gd.head : 1); acc.head = acc.head || best.head;
      dmgBy.set(best.q, acc);
    }
  }
  broadcast({ t: 'shot', g: key, o: [+ox.toFixed(2), +oy.toFixed(2), +oz.toFixed(2)], e: ends });
  for (const [q, r] of dmgBy) {
    const killed = hurtPlayer(q, r.dmg, { player: me, weapon: gd.name });
    send(me.ws, { t: 'hitmark', weak: r.head, dmg: Math.round(r.dmg), killed });
  }
}

/* arrows */
const arrows = new Map();
let nextArrow = 1;
function segSphere(p0, p1, s) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
  const fx = p0.x - s.x, fy = p0.y - s.y, fz = p0.z - s.z;
  const dd = dx * dx + dy * dy + dz * dz;
  if (dd < 1e-9) return null;
  const t = Math.max(0, Math.min(1, -(fx * dx + fy * dy + fz * dz) / dd));
  const qx = fx + dx * t, qy = fy + dy * t, qz = fz + dz * t;
  return qx * qx + qy * qy + qz * qz <= s.r * s.r ? t : null;
}
function updateArrows(dt, now) {
  for (const a of [...arrows.values()]) {
    const p0 = { x: a.x, y: a.y, z: a.z };
    a.vy -= ARROW_GRAVITY * dt;
    a.x += a.vx * dt; a.y += a.vy * dt; a.z += a.vz * dt;
    a.t += dt;
    const p1 = { x: a.x, y: a.y, z: a.z };

    let best = null;
    for (const m of mobsys.mobs.values()) {
      if (Math.abs(m.x - p0.x) > 60 || Math.abs(m.z - p0.z) > 60) continue;
      const sp = mobsys.spheres(m);
      for (const part of ['head', 'body']) {
        const t = segSphere(p0, p1, sp[part]);
        if (t !== null && (!best || t < best.t - 1e-6)) best = { t, m, weak: part === 'head' };
      }
    }
    // players can be shot too
    const owner0 = players.get(a.owner);
    let pbest = null;
    for (const q of players.values()) {
      if (q.id === a.owner || !q.hasPos) continue;
      if (Math.abs(q.x - p0.x) > 60 || Math.abs(q.z - p0.z) > 60) continue;
      for (const [cy, r, head] of playerSpheres(q)) {
        const t = segSphere(p0, p1, { x: q.x, y: cy, z: q.z, r });
        if (t !== null && (!pbest || t < pbest.t)) pbest = { t, q, weak: head };
      }
    }
    if (pbest && (!best || pbest.t < best.t)) {
      const def = ARROW_DEF[a.type];
      const bow = owner0 ? (owner0.inv.bow | 0) : 0;
      let dmg = def.dmg * (BOW_MULT[bow] || 1) * (0.35 + 0.65 * a.draw) * PVP_ARROW;
      if (pbest.weak) dmg *= WEAK_MULT;
      const killed = hurtPlayer(pbest.q, dmg, owner0 ? { player: owner0, weapon: 'Bow' } : { label: 'a stray arrow' });
      if (owner0) send(owner0.ws, { t: 'hitmark', weak: pbest.weak, dmg: Math.round(dmg), killed });
      const hx = p0.x + (p1.x - p0.x) * pbest.t, hy = p0.y + (p1.y - p0.y) * pbest.t, hz = p0.z + (p1.z - p0.z) * pbest.t;
      broadcast({ t: 'arrowend', id: a.id, hit: true, x: hx, y: hy, z: hz });
      arrows.delete(a.id);
      continue;
    }
    if (best) {
      const owner = players.get(a.owner);
      const def = ARROW_DEF[a.type];
      const bow = owner ? (owner.inv.bow | 0) : 0;
      let dmg = def.dmg * (BOW_MULT[bow] || 1) * (0.35 + 0.65 * a.draw);
      if (best.weak) dmg *= WEAK_MULT;
      const killed = mobsys.damage(best.m, dmg, owner, now, def.stun);
      if (owner) send(owner.ws, { t: 'hitmark', weak: best.weak, dmg: Math.round(dmg), killed });
      const hx = p0.x + (p1.x - p0.x) * best.t, hy = p0.y + (p1.y - p0.y) * best.t, hz = p0.z + (p1.z - p0.z) * best.t;
      broadcast({ t: 'arrowend', id: a.id, hit: true, x: hx, y: hy, z: hz });
      arrows.delete(a.id);
      if (killed) killMob(best.m, owner);
      continue;
    }
    const gy = T.heightAt(Math.floor(a.x), Math.floor(a.z)) + 1;
    if (T.arenaBlockAt(Math.floor(a.x), Math.floor(a.y), Math.floor(a.z)) > 0 || a.y < gy || a.t > 6) {
      broadcast({ t: 'arrowend', id: a.id, hit: false, x: a.x, y: Math.max(a.y, gy), z: a.z });
      arrows.delete(a.id);
    }
  }
}

function onConnection(ws) {
  for (const p of players.values()) if (p.name === ws.userName) p.ws.close(4000, 'Logged in elsewhere');

  const acct = users[ws.userName.toLowerCase()];
  if (!acct.inv) acct.inv = starterInv();
  for (const [k, v] of Object.entries(starterInv())) if (acct.inv[k] === undefined) acct.inv[k] = k.startsWith('a_') ? 0 : v;

  const id = nextId++;
  const me = {
    id, name: ws.userName, x: 0, y: 60, z: 0, yaw: 0, pitch: 0, ws, inv: acct.inv,
    lastChat: 0, hasPos: false, hp: 20, maxHp: 20, lastHurt: 0, invuln: Date.now() + 3000,
    lastShot: 0, lastMelee: 0, lastEat: 0, sentHp: 40, sl: 0, inArena: false, guns: null, gunT: {},
  };
  players.set(id, me);

  const editList = Object.entries(edits).map(([k, b]) => { const [x, y, z] = k.split(',').map(Number); return [x, y, z, b]; });
  send(ws, {
    t: 'init', id, name: me.name, seed: SEED, spawn: SPAWN, dayLen: DAY_LEN, phase: worldPhase(),
    players: [...players.values()].filter(p => p.id !== id)
      .map(p => ({ id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch })),
    edits: editList, inv: me.inv, hp: me.hp, maxHp: me.maxHp, recipes: RECIPES,
  });
  broadcast({ t: 'join', id, name: me.name }, id);
  broadcast({ t: 'chat', name: '*', text: `${me.name} joined` });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const now = Date.now();

    if (m.t === 'pos') {
      if (![m.x, m.y, m.z, m.yaw, m.pitch].every(Number.isFinite)) return;
      me.x = m.x; me.y = m.y; me.z = m.z; me.yaw = m.yaw; me.pitch = m.pitch; me.sl = m.sl ? 1 : 0; me.hasPos = true;
    } else if (m.t === 'edit') {
      const { x, y, z, b } = m;
      if (![x, y, z, b].every(Number.isInteger)) return;
      if (y < 0 || y >= WORLD_H || b < 0 || b > MAX_BLOCK) return;
      if (me.hasPos) {
        const dx = x + 0.5 - me.x, dy = y + 0.5 - (me.y + 1.5), dz = z + 0.5 - me.z;
        if (dx * dx + dy * dy + dz * dz > 12 * 12) return; // out of reach
      }
      if (T.inArena(x, z)) return;      // the arena is not buildable
      if (b === 0 && y === 0) return;   // the bottom layer is bedrock
      const k = `${x},${y},${z}`;
      // breaking a natural tree trunk or ore gives its drop (once per block)
      if (b === 0 && edits[k] === undefined) {
        const drop = T.isNaturalWood(x, y, z) ? 'wood' : ORE_DROP[T.naturalOre(x, y, z)];
        if (drop) { me.inv[drop] = (me.inv[drop] | 0) + 1; sendInv(me); }
      }
      edits[k] = b;
      scheduleSave();
      broadcast({ t: 'edit', x, y, z, b }, id);
    } else if (m.t === 'chat') {
      if (now - me.lastChat < 500) return;
      me.lastChat = now;
      const text = String(m.text || '').slice(0, 200).trim();
      if (text === '/arena') {
        const sp = pickArenaSpawn(me);
        me.x = sp.x; me.y = sp.y; me.z = sp.z; me.hasPos = false; me.invuln = now + 2000;
        send(ws, { t: 'respawn', x: sp.x, z: sp.z, msg: 'Teleported to the arena' });
      } else if (text === '/spawn') {
        me.x = SPAWN.x; me.y = 60; me.z = SPAWN.z; me.hasPos = false; me.invuln = now + 2000;
        send(ws, { t: 'respawn', x: SPAWN.x, z: SPAWN.z, msg: 'Teleported to spawn' });
      } else if (text) broadcast({ t: 'chat', name: me.name, text });
    } else if (m.t === 'melee') {
      if (now - me.lastMelee < 350) return;
      const mob = mobsys.mobs.get(m.id);
      if (!mob) return;
      const d = Math.hypot(mob.x - me.x, (mob.y + 0.8) - (me.y + 1.6), mob.z - me.z);
      if (d > 4.6) return;
      me.lastMelee = now;
      const tier = Math.min(2, me.inv.sword | 0);
      const dmg = SWORD_DMG[tier];
      const killed = mobsys.damage(mob, dmg, me, now, 0);
      send(ws, { t: 'hitmark', weak: false, dmg, killed });
      if (killed) killMob(mob, me);
    } else if (m.t === 'shoot') {
      if (now - me.lastShot < 250) return;
      const type = m.a;
      if (!ARROW_DEF[type] || (me.inv[type] | 0) <= 0) return;
      let { dx, dy, dz } = m;
      if (![dx, dy, dz, m.draw].every(Number.isFinite)) return;
      const len = Math.hypot(dx, dy, dz);
      if (len < 0.01) return;
      dx /= len; dy /= len; dz /= len;
      const draw = Math.max(0.25, Math.min(1, m.draw));
      me.lastShot = now;
      me.inv[type]--;
      sendInv(me);
      scheduleSave();
      const speed = 18 + 32 * draw;
      const a = {
        id: nextArrow++, owner: id, type, draw, t: 0,
        x: me.x + dx * 0.8, y: me.y + 1.6 + dy * 0.8, z: me.z + dz * 0.8,
        vx: dx * speed, vy: dy * speed, vz: dz * speed,
      };
      arrows.set(a.id, a);
      broadcast({ t: 'arrow', id: a.id, a: type, x: a.x, y: a.y, z: a.z, vx: a.vx, vy: a.vy, vz: a.vz });
    } else if (m.t === 'pmelee') {
      if (now - me.lastMelee < 350) return;
      const q = players.get(m.id);
      if (!q || q === me || !q.hasPos) return;
      if (Math.hypot(q.x - me.x, (q.y + 0.9) - (me.y + 1.6), q.z - me.z) > 4.8) return;
      me.lastMelee = now;
      const tier = Math.min(2, me.inv.sword | 0);
      const dmg = SWORD_DMG[tier] * PVP_MELEE;
      const killed = hurtPlayer(q, dmg, { player: me, weapon: SWORD_NAMES[tier] });
      send(ws, { t: 'hitmark', weak: false, dmg: Math.round(dmg), killed });
      const kx = q.x - me.x, kz = q.z - me.z, kl = Math.hypot(kx, kz) || 1;
      send(q.ws, { t: 'kb', vx: kx / kl * 7, vy: 4, vz: kz / kl * 7 });
    } else if (m.t === 'gun') {
      const gd = GUNS[m.g];
      if (!gd || !me.inArena || !me.guns || (me.guns[m.g] | 0) <= 0) return;
      if (now - (me.gunT[m.g] || 0) < gd.cd - 25) return;
      let { dx, dy, dz } = m;
      if (![dx, dy, dz].every(Number.isFinite)) return;
      const len = Math.hypot(dx, dy, dz);
      if (len < 0.01) return;
      me.gunT[m.g] = now;
      me.guns[m.g]--;
      send(ws, { t: 'ammo', guns: me.guns });
      fireGun(me, gd, m.g, dx / len, dy / len, dz / len);
    } else if (m.t === 'grap') {
      if (m.on && ![m.x, m.y, m.z].every(Number.isFinite)) return;
      broadcast({ t: 'grap', id, on: !!m.on, x: m.x, y: m.y, z: m.z }, id);
    } else if (m.t === 'eat') {
      if ((me.inv.meat | 0) <= 0 || me.hp >= me.maxHp || now - me.lastEat < 1200) return;
      me.lastEat = now;
      me.inv.meat--;
      me.hp = Math.min(me.maxHp, me.hp + EAT_HEAL);
      sendInv(me); sendHp(me);
      scheduleSave();
    } else if (m.t === 'craft') {
      const r = RECIPES.find(q => q.id === m.id);
      if (!r) return;
      const inv = me.inv;
      if (r.need) for (const [k, v] of Object.entries(r.need)) if ((inv[k] | 0) !== v) return;
      for (const [k, v] of Object.entries(r.cost)) if ((inv[k] | 0) < v) return;
      for (const [k, v] of Object.entries(r.cost)) inv[k] -= v;
      if (r.give) for (const [k, v] of Object.entries(r.give)) inv[k] = (inv[k] | 0) + v;
      if (r.set) Object.assign(inv, r.set);
      sendInv(me);
      send(ws, { t: 'crafted', name: r.name });
      scheduleSave();
    }
  });

  ws.on('close', () => {
    if (players.get(id) === me) {
      players.delete(id);
      broadcast({ t: 'leave', id });
      broadcast({ t: 'chat', name: '*', text: `${me.name} left` });
    }
  });
}

/* ---------------- loops ---------------- */
let tickN = 0, lastTick = Date.now();
function startLoops() {
  // world tick, 20 Hz: machines, arrows, health regen
  setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.2, (now - lastTick) / 1000);
    lastTick = now;
    tickN++;
    const list = [...players.values()];
    if (!list.length) return;
    mobsys.update(dt, now, list);
    updateArrows(dt, now);
    for (const p of list) {
      if (p.hasPos) { const ia = T.inArena(p.x, p.z); if (ia !== p.inArena) setArena(p, ia); }
    }
    if (tickN % 20 === 0) {
      const inA = list.filter(p => p.inArena);
      if (inA.length) {
        const rows = inA.map(p => { const st = statOf(p); return [p.name, st.k, st.d]; }).sort((a, b) => b[1] - a[1] || a[2] - b[2]).slice(0, 8);
        const msg = JSON.stringify({ t: 'score', list: rows });
        for (const p of inA) p.ws.send(msg);
      }
    }
    for (const p of list) {
      if (now - p.lastHurt > 6000 && p.hp < p.maxHp) {
        p.hp = Math.min(p.maxHp, p.hp + 0.4 * dt);
        if (Math.floor(p.hp * 2) !== p.sentHp && tickN % 20 === 0) sendHp(p);
      }
    }
    if (tickN % 2 === 0) broadcast({ t: 'mobs', m: mobsys.snapshot(now) });
  }, 50);

  // everyone's positions to everyone, ~12 Hz
  setInterval(() => {
    if (players.size < 2) return;
    const list = [...players.values()].map(p => [p.id, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +p.yaw.toFixed(2), +p.pitch.toFixed(2), p.sl]);
    const msg = JSON.stringify({ t: 'state', p: list });
    for (const p of players.values()) p.ws.send(msg);
  }, 80);

  // keep connections alive through hosting proxies
  setInterval(() => { for (const p of players.values()) p.ws.ping(); }, 25000).unref();
}

process.on('SIGTERM', () => { flush(); process.exit(0); });
process.on('SIGINT', () => { flush(); process.exit(0); });

import('./public/terrain.mjs').then(mod => {
  T = mod;
  T.setSeed(SEED);
  SPAWN = T.spawnPoint();
  mobsys = createMobs(T, {
    onHurtPlayer: (p, dmg, mob) => hurtPlayer(p, dmg, { label: 'a ' + mobsys.TYPES[mob.type].label }),
    onGone: id => broadcast({ t: 'mobdie', id, gone: true }),
    isNight,
  });
  startLoops();
  server.listen(PORT, () => console.log(`Cursed Lands server on :${PORT}`));
});
