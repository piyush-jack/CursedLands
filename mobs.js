'use strict';
// Minecraft mobs, simulated on the server as HERDS:
//  - passive (pig, cow, sheep, chicken): graze and drift between pastures behind a leader; when one is hurt the whole herd panics
//  - defender (wolf): peaceful until one is hurt, then the whole pack attacks
//  - predator (zombie, spider): hunt players on sight, flanking; mostly spawn at night and burn off at dawn
// Movement follows the shared terrain heightmap (no water, no tree trunks, no steep cliffs).

const TYPE_LIST = ['pig', 'cow', 'sheep', 'chicken', 'wolf', 'zombie', 'spider'];
const TYPES = {
  pig:     { label: 'Pig',     hp: 20, walk: 1.3, run: 5.2, kind: 'passive',  herd: [2, 4] },
  cow:     { label: 'Cow',     hp: 20, walk: 1.2, run: 5.0, kind: 'passive',  herd: [3, 5] },
  sheep:   { label: 'Sheep',   hp: 16, walk: 1.2, run: 5.2, kind: 'passive',  herd: [3, 6] },
  chicken: { label: 'Chicken', hp: 8,  walk: 1.5, run: 5.6, kind: 'passive',  herd: [3, 5] },
  wolf:    { label: 'Wolf',    hp: 24, walk: 1.8, run: 7.0, kind: 'defender', dmg: 4, herd: [2, 4] },
  zombie:  { label: 'Zombie',  hp: 40, walk: 1.5, run: 4.4, kind: 'predator', dmg: 3, aggro: 40, herd: [2, 4], hostile: true },
  spider:  { label: 'Spider',  hp: 32, walk: 2.2, run: 6.0, kind: 'predator', dmg: 2, aggro: 32, herd: [1, 2], hostile: true },
};
// where each species may spawn (BIOME ids from terrain.mjs: 0 plains, 1 forest, 2 desert, 3 snow)
const SPAWN_BIOMES = {
  pig: [0, 1], cow: [0, 1], sheep: [0, 1, 3], chicken: [0, 1], wolf: [1, 3], zombie: [0, 1, 2, 3], spider: [0, 1, 2, 3],
};
// snapshot flag bits
const F_STUN = 1, F_MOVING = 2, F_GRAZE = 4, F_ALERT = 8, F_RUN = 16, F_LEADER = 32;   // F_ALERT is only used by the model viewer
const MAX_MOBS = 110;

module.exports = function createMobs(T, hooks) {
  const mobs = new Map();
  const herds = new Map();
  let nextId = 1, nextHerd = 1, spawnTimer = 0;
  const rand = (a, b) => a + Math.random() * (b - a);
  const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

  /* ---------- terrain checks ---------- */
  function landOk(x, z) {
    const fx = Math.floor(x), fz = Math.floor(z);
    if (T.inArena(fx, fz, 3)) return false;
    const h = T.heightAt(fx, fz);
    return h >= T.SEA && !T.treeAt(fx, fz, h);
  }
  function blocked(nx, nz, curY) {
    const fx = Math.floor(nx), fz = Math.floor(nz);
    if (T.inArena(fx, fz, 2)) return true;
    const h = T.heightAt(fx, fz);
    if (h < T.SEA) return true;                     // water
    if (T.treeAt(fx, fz, h)) return true;           // tree trunk
    if (Math.abs(h + 1 - curY) > 1.2) return true;  // too steep
    return false;
  }

  /* ---------- movement primitives ---------- */
  function face(m, dx, dz, dt, rate = 10) {
    if (Math.abs(dx) + Math.abs(dz) < 1e-6) return;
    const want = Math.atan2(-dx, -dz);
    let d = want - m.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    m.yaw += d * Math.min(1, rate * dt);
  }
  function move(m, dx, dz, speed, dt) {
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return false;
    dx /= len; dz /= len;
    face(m, dx, dz, dt);
    const sx = dx * speed * dt, sz = dz * speed * dt;
    let moved = false;
    if (!blocked(m.x + sx, m.z + sz, m.y)) { m.x += sx; m.z += sz; moved = true; }
    else if (!blocked(m.x + sx, m.z, m.y)) { m.x += sx; moved = true; }
    else if (!blocked(m.x, m.z + sz, m.y)) { m.z += sz; moved = true; }
    if (moved) { m.moving = true; if (speed >= TYPES[m.type].run * 0.75) m.fl |= F_RUN; }
    return moved;
  }
  // walk toward a point while keeping a little personal space from herd-mates.
  // returns false when already there (within `arrive`) or when blocked
  function steer(m, h, tx, tz, speed, dt, arrive) {
    let dx = tx - m.x, dz = tz - m.z;
    const d = Math.hypot(dx, dz);
    if (d < arrive) return false;
    dx /= d; dz /= d;
    for (const id of h.members) {
      if (id === m.id) continue;
      const o = mobs.get(id); if (!o) continue;
      const ox = m.x - o.x, oz = m.z - o.z, od = Math.hypot(ox, oz);
      if (od < 1.4 && od > 1e-3) { const w = (1.4 - od) / 1.4 * 1.6; dx += ox / od * w; dz += oz / od * w; }
    }
    return move(m, dx, dz, speed, dt);
  }
  // where a follower wants to be: behind and beside the leader
  function slotPos(m, leader) {
    const fx = -Math.sin(leader.yaw), fz = -Math.cos(leader.yaw);
    const rx = Math.cos(leader.yaw), rz = -Math.sin(leader.yaw);
    return { x: leader.x + rx * m.slotX - fx * m.slotZ, z: leader.z + rz * m.slotX - fz * m.slotZ };
  }

  /* ---------- spawning ---------- */
  function spawnMob(type, x, z, herdId) {
    const def = TYPES[type];
    const m = {
      id: nextId++, type, herdId, x, z, y: T.heightAt(Math.floor(x), Math.floor(z)) + 1,
      yaw: Math.random() * Math.PI * 2, hp: def.hp, maxHp: def.hp,
      slotX: rand(-2.6, 2.6), slotZ: rand(1.4, 4.6),
      idleUntil: 0, wanderEnd: 0, wtx: undefined, wtz: undefined,
      stunUntil: 0, atkAt: 0, moving: false, fl: 0,
    };
    mobs.set(m.id, m);
    return m;
  }
  function spawnHerd(type, cx, cz, now) {
    const def = TYPES[type];
    const n = def.herd[0] + Math.floor(Math.random() * (def.herd[1] - def.herd[0] + 1));
    const h = {
      id: nextHerd++, type, members: [], leaderId: 0, state: 'graze', until: now + rand(2000, 9000),
      anchorX: cx, anchorZ: cz, tx: cx, tz: cz, cx, cz,
      targetId: 0, preyId: 0, threatX: cx, threatZ: cz, detour: 0, detourUntil: 0, nextPreyCheck: now + 6000, huntCooldown: 0,
    };
    for (let i = 0; i < n * 3 && h.members.length < n; i++) {
      const x = cx + rand(-3.5, 3.5), z = cz + rand(-3.5, 3.5);
      if (!landOk(x, z)) continue;
      const m = spawnMob(type, x, z, h.id);
      h.members.push(m.id);
      if (!h.leaderId) h.leaderId = m.id;
    }
    if (h.members.length < 1) return null;
    herds.set(h.id, h);
    return h;
  }
  function pickType(biome, night, nearSpawn) {
    const hostileW = night ? 55 : 6;
    const weights = [];
    for (const t of TYPE_LIST) {
      if (!SPAWN_BIOMES[t].includes(biome)) continue;
      let w = TYPES[t].hostile ? hostileW / 2 : (t === 'wolf' ? 6 : 20);
      if (TYPES[t].hostile && nearSpawn) w = 0;
      if (!TYPES[t].hostile && night) w *= 0.7;
      if (w > 0) weights.push([t, w]);
    }
    let total = 0; for (const [, w] of weights) total += w;
    if (!total) return null;
    let roll = Math.random() * total;
    for (const [t, w] of weights) { roll -= w; if (roll <= 0) return t; }
    return weights[0][0];
  }
  function trySpawnHerdNear(p, now) {
    const night = hooks.isNight ? hooks.isNight() : false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const a = Math.random() * Math.PI * 2, r = 32 + Math.random() * 30;
      const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
      if (!landOk(x, z) || T.heightAt(Math.floor(x), Math.floor(z)) < T.SEA + 1) continue;
      // keep the start area safe for new players
      const type = pickType(T.biomeAt(Math.floor(x), Math.floor(z)), night, Math.hypot(x, z) < 60 || r < 42);
      if (type && spawnHerd(type, x, z, now)) return;
    }
  }

  /* ---------- herd behaviours ---------- */
  function pickPasture(h, minR, maxR) {
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2, r = rand(minR, maxR);
      const x = h.cx + Math.cos(a) * r, z = h.cz + Math.sin(a) * r;
      if (landOk(x, z) && T.heightAt(Math.floor(x), Math.floor(z)) >= T.SEA + 1) return { x, z };
    }
    return null;
  }
  function toGraze(h, now, ms) {
    h.state = 'graze';
    h.anchorX = h.cx; h.anchorZ = h.cz;
    h.until = now + rand(9000, 22000);
    h.detour = 0;
    for (const m of ms) { m.wtx = undefined; m.idleUntil = now + rand(0, 3000); }
  }
  // individual shuffling around the herd's anchor point; head down when still (prey)
  function grazeStep(m, h, now, dt, headDown) {
    if (now < m.idleUntil) { if (headDown) m.fl |= F_GRAZE; return; }
    if (m.wtx === undefined) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * 3.6;
      m.wtx = h.anchorX + Math.cos(a) * r; m.wtz = h.anchorZ + Math.sin(a) * r;
      m.wanderEnd = now + 6000;
      return;
    }
    const d = dist(m.x, m.z, m.wtx, m.wtz);
    if (d < 0.5 || now > m.wanderEnd) { m.wtx = undefined; m.idleUntil = now + rand(2500, 7500); return; }
    if (!steer(m, h, m.wtx, m.wtz, TYPES[m.type].walk * 0.6, dt, 0.4)) { m.wtx = undefined; m.idleUntil = now + 1200; }
  }
  // graze <-> travel cycle used by every species when nothing is going on
  function roam(h, ms, leader, now, dt, headDown, minR, maxR, speedMul) {
    const def = TYPES[h.type];
    if (h.state === 'graze') {
      for (const m of ms) if (now >= m.stunUntil) grazeStep(m, h, now, dt, headDown);
      if (now >= h.until) {
        const t = pickPasture(h, minR, maxR);
        if (t) { h.tx = t.x; h.tz = t.z; h.state = 'move'; h.until = now + 40000; }
        else h.until = now + 5000;
      }
      return;
    }
    // 'move': leader walks to the new pasture, the rest trail behind in their slots
    const arrived = dist(leader.x, leader.z, h.tx, h.tz) < 2.5;
    if (arrived || now > h.until) { toGraze(h, now, ms); return; }
    if (now >= leader.stunUntil) {
      const moved = steer(leader, h, h.tx, h.tz, def.walk * speedMul, dt, 2.0);
      if (!moved) { toGraze(h, now, ms); return; } // boxed in by water or trees: settle here
    }
    for (const m of ms) {
      if (m === leader || now < m.stunUntil) continue;
      const s = slotPos(m, leader);
      const d = dist(m.x, m.z, s.x, s.z);
      const sp = d > 2 ? def.walk * speedMul * (1 + Math.min(1.6, (d - 2) / 3)) : def.walk * speedMul * 0.8;
      steer(m, h, s.x, s.z, sp, dt, 0.7);
    }
  }

  function updatePrey(h, ms, leader, now, dt, alive, predators) {
    const def = TYPES[h.type];
    // --- passive herds bolt from nearby predators; one nervous member is enough to warn everyone
    let thr = null, thrD = Infinity;
    if (def.kind === 'passive') {
      for (const m of ms) {
        for (const q of predators) {
          const d = dist(m.x, m.z, q.x, q.z);
          if (d < 18 && d < thrD) { thrD = d; thr = q; }
        }
      }
      if (thr && h.state !== 'flee') {
        h.threatX = thr.x; h.threatZ = thr.z;
        h.state = 'flee'; h.until = now + 7000;
      }
    }

    if (h.state === 'flee') {
      if (thr) { h.threatX = thr.x; h.threatZ = thr.z; if (thrD < 14) h.until = Math.max(h.until, now + 2500); }
      let fx = h.cx - h.threatX, fz = h.cz - h.threatZ;
      const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
      if (h.detour) {
        const c = Math.cos(h.detour), s = Math.sin(h.detour);
        const rx = fx * c - fz * s, rz = fx * s + fz * c; fx = rx; fz = rz;
        if (now > h.detourUntil) h.detour = 0;
      }
      if (now >= leader.stunUntil) {
        const moved = move(leader, fx, fz, def.run, dt);
        if (!moved) { h.detour = h.detour > 0 ? -1.1 : 1.1; h.detourUntil = now + 1400; } // water or trees ahead: swing around
      }
      for (const m of ms) {
        if (m === leader || now < m.stunUntil) continue;
        const s = slotPos(m, leader);
        steer(m, h, s.x, s.z, def.run * 1.05, dt, 0.5);
      }
      if (now >= h.until) toGraze(h, now, ms);
      return;
    }
    if (h.state === 'defend') {
      const t = alive.find(p => p.id === h.targetId);
      if (!t || now > h.until || dist(h.cx, h.cz, t.x, t.z) > 40) { toGraze(h, now, ms); return; }
      for (const m of ms) {
        if (now < m.stunUntil) continue;
        const d = dist(m.x, m.z, t.x, t.z);
        if (d > 1.6) steer(m, h, t.x, t.z, def.run, dt, 0.2);
        else {
          face(m, t.x - m.x, t.z - m.z, dt);
          if (now >= m.atkAt && Math.abs(t.y - m.y) < 2.4) { m.atkAt = now + 1100; hooks.onHurtPlayer(t, def.dmg, m); }
        }
      }
      return;
    }
    roam(h, ms, leader, now, dt, true, 14, 30, 1.0);
  }

  function updatePredators(h, ms, leader, now, dt, alive) {
    const def = TYPES[h.type];
    if (h.state !== 'hunt' && h.state !== 'feed') {
      let best = null, bd = Infinity;
      for (const m of ms) for (const p of alive) {
        const d = dist(m.x, m.z, p.x, p.z);
        if (d < def.aggro && d < bd) { bd = d; best = p; }
      }
      if (best) { h.state = 'hunt'; h.targetId = best.id; h.preyId = 0; h.until = now + 25000; }
      else if (def.huntsMobs && now >= h.nextPreyCheck && now >= h.huntCooldown) {
        h.nextPreyCheck = now + 4000;
        if (Math.random() < 0.3) {
          let prey = null, pd = 32;
          for (const o of mobs.values()) {
            if (TYPES[o.type].kind !== 'passive') continue;
            const d = dist(h.cx, h.cz, o.x, o.z);
            if (d < pd) { pd = d; prey = o; }
          }
          if (prey) { h.state = 'hunt'; h.preyId = prey.id; h.targetId = 0; h.until = now + 18000; }
        }
      }
    }

    if (h.state === 'hunt') {
      const tp = h.targetId ? alive.find(p => p.id === h.targetId) : null;
      const tm = h.preyId ? mobs.get(h.preyId) : null;
      const tgt = tp || tm;
      if (!tgt || now > h.until || dist(h.cx, h.cz, tgt.x, tgt.z) > 60) { toGraze(h, now, ms); return; }
      ms.forEach((m, idx) => {
        if (now < m.stunUntil) return;
        const d = dist(m.x, m.z, tgt.x, tgt.z);
        if (d > 1.7) {
          let gx = tgt.x, gz = tgt.z;
          if (d > 8) { // flank: each pack member takes a different line of approach
            const side = ((idx % 3) - 1) * 4.5;
            gx += -(tgt.z - m.z) / d * side; gz += (tgt.x - m.x) / d * side;
          }
          steer(m, h, gx, gz, def.run, dt, 0.2);
        } else {
          face(m, tgt.x - m.x, tgt.z - m.z, dt);
          if (now >= m.atkAt) {
            if (tp) {
              if (Math.abs(tp.y - m.y) < 2.4) { m.atkAt = now + 1100; hooks.onHurtPlayer(tp, def.dmg, m); }
            } else {
              m.atkAt = now + 1200;
              tm.hp -= 10;
              if (tm.hp <= 0) { mobs.delete(tm.id); hooks.onGone(tm.id); h.state = 'feed'; h.until = now + 7000; h.huntCooldown = now + 70000; h.anchorX = m.x; h.anchorZ = m.z; }
            }
          }
        }
      });
      return;
    }
    if (h.state === 'feed') {
      for (const m of ms) if (now >= m.stunUntil) grazeStep(m, h, now, dt, true);
      if (now >= h.until) toGraze(h, now, ms);
      return;
    }
    roam(h, ms, leader, now, dt, false, 20, 45, 1.2);
  }

  function updateHerd(h, now, dt, alive, predators) {
    h.members = h.members.filter(id => mobs.has(id));
    if (!h.members.length) { herds.delete(h.id); return; }
    if (!mobs.has(h.leaderId)) h.leaderId = h.members[0];
    const ms = h.members.map(id => mobs.get(id));
    let cx = 0, cz = 0;
    for (const m of ms) { cx += m.x; cz += m.z; }
    h.cx = cx / ms.length; h.cz = cz / ms.length;
    const leader = mobs.get(h.leaderId);
    leader.fl |= F_LEADER;
    if (TYPES[h.type].kind === 'predator') updatePredators(h, ms, leader, now, dt, alive);
    else updatePrey(h, ms, leader, now, dt, alive, predators);
  }

  /* ---------- main update ---------- */
  function update(dt, now, players) {
    const alive = players.filter(p => p.hasPos && !p.dead);

    spawnTimer += dt;
    if (spawnTimer >= 3) {
      spawnTimer = 0;
      for (const p of alive) {
        let near = 0;
        for (const m of mobs.values()) if (dist(m.x, m.z, p.x, p.z) < 80) near++;
        if (near < 14 && mobs.size < MAX_MOBS) trySpawnHerdNear(p, now);
      }
    }
    for (const m of [...mobs.values()]) {
      let anyNear = false;
      for (const p of alive) if (dist(m.x, m.z, p.x, p.z) < 115) { anyNear = true; break; }
      if (!anyNear) { mobs.delete(m.id); hooks.onGone(m.id); }
    }

    if (hooks.isNight && !hooks.isNight()) {
      for (const h of [...herds.values()]) {
        if (!TYPES[h.type].hostile || h.state === 'hunt' || Math.random() > 0.15 * dt) continue;
        for (const id of h.members) { mobs.delete(id); hooks.onGone(id); }
        herds.delete(h.id);
      }
    }

    const predators = [];
    for (const m of mobs.values()) {
      m.moving = false; m.fl = 0;
      if (TYPES[m.type].kind === 'predator') predators.push(m);
      const gy = T.heightAt(Math.floor(m.x), Math.floor(m.z)) + 1;
      m.y += (gy - m.y) * Math.min(1, 12 * dt);
    }
    for (const h of [...herds.values()]) updateHerd(h, now, dt, alive, predators);
  }

  /* ---------- hit spheres: body + head (the weak point). The head drops when grazing. ---------- */
  // head positions measured from the models in public/creatures.js (forward offset, height) per pose
  const HEADS = {
    pig:     { norm: [0.75, 0.69], graze: [0.65, 0.49], r: 0.36 },
    cow:     { norm: [0.75, 1.25], graze: [0.66, 1.09], r: 0.38 },
    sheep:   { norm: [0.75, 1.25], graze: [0.64, 1.04], r: 0.36 },
    chicken: { norm: [0.28, 0.81], graze: [0.38, 0.7],  r: 0.24 },
    wolf:    { norm: [0.5, 0.81],  graze: [0.49, 0.71], r: 0.3 },
    zombie:  { norm: [0, 1.64],    graze: [0, 1.64],    r: 0.32 },
    spider:  { norm: [0.44, 0.56], graze: [0.44, 0.53], r: 0.4 },
  };
  const BODIES = { pig: [0.62, 0.55], cow: [1.0, 0.85], sheep: [0.98, 0.75], chicken: [0.5, 0.33], wolf: [0.7, 0.5], zombie: [0.8, 0.65], spider: [0.55, 0.7] };
  function spheres(m) {
    const fx = -Math.sin(m.yaw), fz = -Math.cos(m.yaw);
    const H = HEADS[m.type], B = BODIES[m.type];
    const pose = (m.fl & F_GRAZE) ? 'graze' : 'norm';
    const [fo, hy] = H[pose];
    return {
      body: { x: m.x, y: m.y + B[0], z: m.z, r: B[1] },
      head: { x: m.x + fx * fo, y: m.y + hy, z: m.z + fz * fo, r: H.r },
    };
  }

  // returns true if the mob is destroyed. A hit wakes up its whole herd.
  function damage(m, dmg, attacker, now, stunMs) {
    m.hp -= dmg;
    const h = herds.get(m.herdId);
    if (attacker && h) {
      const kind = TYPES[h.type].kind;
      if (kind === 'passive') { h.state = 'flee'; h.until = now + 9000; h.threatX = attacker.x; h.threatZ = attacker.z; }
      else if (kind === 'defender') { h.state = 'defend'; h.targetId = attacker.id; h.until = now + 14000; }
      else { h.state = 'hunt'; h.targetId = attacker.id; h.preyId = 0; h.until = now + 25000; }
    }
    if (stunMs) m.stunUntil = now + stunMs;
    return m.hp <= 0;
  }

  function snapshot(now) {
    const out = [];
    for (const m of mobs.values()) {
      let f = m.fl;
      if (now < m.stunUntil) f |= F_STUN;
      if (m.moving) f |= F_MOVING;
      out.push([
        m.id, TYPE_LIST.indexOf(m.type), +m.x.toFixed(2), +m.y.toFixed(2), +m.z.toFixed(2),
        +m.yaw.toFixed(2), Math.max(0, Math.round(m.hp / m.maxHp * 100)), f,
      ]);
    }
    return out;
  }

  return { mobs, herds, TYPES, TYPE_LIST, update, spheres, damage, snapshot, spawnHerd };
};
