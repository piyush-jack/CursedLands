'use strict';
// Wave survival: armed raiders walk out of the four doors of the wave fortress and hunt the players inside.
// Raiders walk on the arena blocks (they climb 1-block steps, stop at walls), so the keep and its parapet matter.
//
//   grunt   - sword, runs straight at you
//   gunner  - pistol, keeps its distance and strafes
//   brute   - big axe, slow and tanky
//   warlord - rifle burst, one per fifth wave
// Between waves everyone inside is healed and re-armed.

const KINDS = ['grunt', 'gunner', 'brute', 'warlord'];   // index order is shared with the client
const DEF = {
  grunt:   { label: 'Raider',  hp: 30,  speed: 3.5, scale: 1,    melee: { dmg: 3, cd: 1000, reach: 1.8 } },
  gunner:  { label: 'Gunner',  hp: 22,  speed: 2.8, scale: 1,    gun: { dmg: 2.5, cd: 1500, range: 24, spread: 0.06, weapon: 'pistol' }, keep: [9, 15] },
  brute:   { label: 'Brute',   hp: 100, speed: 2.6, scale: 1.35, melee: { dmg: 6, cd: 1500, reach: 2.3 } },
  warlord: { label: 'Warlord', hp: 320, speed: 2.3, scale: 1.5,  gun: { dmg: 2.5, cd: 280, range: 30, spread: 0.08, weapon: 'rifle' }, keep: [10, 18] },
};
const MAX_ALIVE = 16;
const BREAK_FIRST = 6000, BREAK_BETWEEN = 9000;

module.exports = function createWaves(T, hooks) {
  const mobs = new Map();
  let nextId = 1, spawnT = 0;
  const W = { wave: 0, phase: 'idle', nextAt: 0, queue: [], total: 0 };
  const rand = (a, b) => a + Math.random() * (b - a);

  const solid = (x, y, z) => { const b = T.arenaBlockAt(Math.floor(x), Math.floor(y), Math.floor(z)); return b > 0 && b !== T.B.WATER; };
  // top of the ground under (x, z), searching down from a little above y
  function groundAt(x, z, fromY) {
    const lo = T.arena('wave').floor - 2;
    for (let y = Math.floor(fromY) + 2; y >= lo; y--) if (solid(x, y, z)) return y + 1;
    return -1;
  }
  // can a raider stand at (x, z)? returns the ground height, or null
  function stand(m, x, z) {
    const g = groundAt(x, z, m.y);
    if (g < 0 || g - m.y > 1.1 || m.y - g > 3) return null;
    if (solid(x, g + 0.5, z) || solid(x, g + 1.5, z)) return null;
    return g;
  }
  function step(m, vx, vz, dt) {
    const a = T.arena('wave'), lim = a.half - 0.7;
    const sp = Math.hypot(vx, vz);
    if (sp < 1e-4) return false;
    const ux = vx / sp, uz = vz / sp;
    const tries = [[vx, vz], [vx, 0], [0, vz], [uz * sp, -ux * sp], [-uz * sp, ux * sp]];   // straight, slide along walls, then sidestep
    for (const [tx, tz] of tries) {
      const nx = Math.max(a.cx + 0.5 - lim, Math.min(a.cx + 0.5 + lim, m.x + tx * dt));
      const nz = Math.max(a.cz + 0.5 - lim, Math.min(a.cz + 0.5 + lim, m.z + tz * dt));
      if (nx === m.x && nz === m.z) continue;
      const g = stand(m, nx, nz);
      if (g === null) continue;
      const l = Math.hypot(tx, tz) || 1;                                                   // feelers so the body does not clip corners
      if (stand(m, nx + tx / l * 0.35, nz + tz / l * 0.35) === null) continue;
      m.x = nx; m.z = nz; m.ty = g;
      return true;
    }
    return false;
  }
  function los(x0, y0, z0, x1, y1, z1) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, d = Math.hypot(dx, dy, dz);
    for (let s = 0.6; s < d; s += 0.6) if (solid(x0 + dx * s / d, y0 + dy * s / d, z0 + dz * s / d)) return false;
    return true;
  }
  function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
    const fx = cx - ox, fy = cy - oy, fz = cz - oz, t = fx * dx + fy * dy + fz * dz;
    if (t < 0) return null;
    const p2 = fx * fx + fy * fy + fz * fz - t * t;
    if (p2 > r * r) return null;
    return Math.max(0, t - Math.sqrt(r * r - p2));
  }

  /* ---------- the wave director ---------- */
  function composition(n) {
    const total = Math.min(36, 3 + 2 * n);
    const out = [];
    if (n % 5 === 0) out.push('warlord');
    const brutes = n >= 3 ? Math.min(8, Math.floor((n - 1) / 2)) : 0;
    const gunners = n >= 2 ? Math.floor(total * 0.3) : 0;
    for (let i = 0; i < brutes; i++) out.push('brute');
    for (let i = 0; i < gunners; i++) out.push('gunner');
    while (out.length < total) out.push('grunt');
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    return out;
  }
  function reset() { mobs.clear(); W.wave = 0; W.phase = 'idle'; W.queue = []; W.total = 0; hooks.onReset && hooks.onReset(); }
  function doorSpot() {
    const doors = T.waveDoors(), d = doors[Math.floor(Math.random() * doors.length)];
    const horiz = Math.abs(d.x - (T.arena('wave').cx + 0.5)) > 1;                       // doors on the east/west walls spread along z
    return { x: d.x + (horiz ? 0 : rand(-1.5, 1.5)), z: d.z + (horiz ? rand(-1.5, 1.5) : 0), y: d.y };
  }
  function respawnAtDoor(m) { const d = doorSpot(); m.x = d.x; m.z = d.z; m.y = m.ty = d.y; m.cx = m.x; m.cz = m.z; }
  function spawn(kind) {
    const def = DEF[kind], d = doorSpot();
    const m = {
      id: nextId++, kind, hp: def.hp, maxHp: def.hp, yaw: 0, atkAt: Date.now() + 800, swingAt: 0, shootAt: 0,
      x: d.x, z: d.z, y: d.y, ty: d.y, cx: d.x, cz: d.z, chkT: 0.7, stuck: 0, detour: 0, detourAng: 0,
      strafe: Math.random() < 0.5 ? -1 : 1, strafeT: rand(1, 3), moving: false,
    };
    mobs.set(m.id, m);
  }

  let emptySince = 0;
  // present = everyone inside the fortress (even mid-respawn); ps = those who can be targeted right now
  function update(dt, now, ps, present) {
    if (!present.length) {                                  // everyone left or ran out of lives: start over after a short grace period
      if (!emptySince) emptySince = now;
      if (W.phase !== 'idle' && now - emptySince > 3000) reset();
      return;
    }
    emptySince = 0;
    if (W.phase === 'idle') { W.wave = 1; W.phase = 'break'; W.nextAt = now + BREAK_FIRST; hooks.onBreak && hooks.onBreak(W.wave); }
    if (W.phase === 'break' && now >= W.nextAt) {
      W.queue = composition(W.wave); W.total = W.queue.length; W.phase = 'fight'; spawnT = 0;
      hooks.onWaveStart && hooks.onWaveStart(W.wave);
    }
    if (W.phase === 'fight') {
      spawnT -= dt;
      if (spawnT <= 0 && W.queue.length && mobs.size < MAX_ALIVE) { spawn(W.queue.pop()); spawnT = 0.8; }
      if (!W.queue.length && mobs.size === 0) {
        hooks.onWaveClear && hooks.onWaveClear(W.wave);
        W.wave++; W.phase = 'break'; W.nextAt = now + BREAK_BETWEEN;
        hooks.onBreak && hooks.onBreak(W.wave);
      }
    }
    const list = [...mobs.values()];
    for (const m of list) {
      const def = DEF[m.kind];
      m.moving = false;
      let t = null, td = 1e9;
      for (const p of ps) { const d = Math.hypot(p.x - m.x, p.z - m.z); if (d < td && Math.abs(p.y - m.y) < 40) { td = d; t = p; } }
      m.y += (m.ty - m.y) * Math.min(1, 14 * dt);
      if (!t) continue;
      const dx = t.x - m.x, dz = t.z - m.z, d = Math.max(td, 1e-3);
      const want = Math.atan2(-dx, -dz);
      let da = want - m.yaw; da = Math.atan2(Math.sin(da), Math.cos(da));
      m.yaw += da * Math.min(1, 10 * dt);
      let vx = 0, vz = 0;
      if (def.melee) {
        if (d > def.melee.reach - 0.3) { vx = dx / d * def.speed; vz = dz / d * def.speed; }
        else if (now >= m.atkAt && Math.abs(t.y - m.y) < 2.6) {
          m.atkAt = now + def.melee.cd; m.swingAt = now;
          hooks.onHurtPlayer(t, def.melee.dmg, { label: 'a ' + def.label });
        }
      } else {
        const [lo, hi] = def.keep;
        const mv = d > hi ? 1 : d < lo ? -1 : 0;
        m.strafeT -= dt;
        if (m.strafeT <= 0) { m.strafe = Math.random() < 0.5 ? -1 : 1; m.strafeT = rand(1.2, 3); }
        vx = (dx / d * mv - dz / d * m.strafe * 0.55) * def.speed;
        vz = (dz / d * mv + dx / d * m.strafe * 0.55) * def.speed;
        const oy = m.y + 1.45 * def.scale;
        if (now >= m.atkAt && d <= def.gun.range && los(m.x, oy, m.z, t.x, t.y + 1.2, t.z)) {
          m.atkAt = now + def.gun.cd * rand(0.9, 1.3); m.shootAt = now;
          fire(m, def, t, oy);
        }
      }
      // stuck on a pillar or cover wall? swing around it for a moment, and as a last resort come back in through a door
      if (m.detour > now) { const c = Math.cos(m.detourAng), sn = Math.sin(m.detourAng), nx = vx * c - vz * sn; vz = vx * sn + vz * c; vx = nx; }
      m.chkT -= dt;
      if (m.chkT <= 0) {
        m.chkT = 0.7;
        const moved = Math.hypot(m.x - m.cx, m.z - m.cz); m.cx = m.x; m.cz = m.z;
        if ((vx || vz) && moved < 0.5) {
          m.stuck++; m.detour = now + 1500; m.detourAng = (Math.random() < 0.5 ? -1 : 1) * rand(1.0, 2.3);
          if (m.stuck > 8) { respawnAtDoor(m); m.stuck = 0; }
        } else if (moved > 1.2) m.stuck = 0;
      }
      for (const o of list) {                                                              // do not stack on each other
        if (o === m) continue;
        const ox = m.x - o.x, oz = m.z - o.z, od = Math.hypot(ox, oz);
        if (od < 1.0 && od > 1e-3) { vx += ox / od * 2.2; vz += oz / od * 2.2; }
      }
      if (vx || vz) m.moving = step(m, vx, vz, dt);
    }
  }
  function fire(m, def, t, oy) {
    let dx = t.x - m.x, dy = (t.y + 1.1) - oy, dz = t.z - m.z;
    const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
    const sp = def.gun.spread;
    dx += (Math.random() - 0.5) * 2 * sp; dy += (Math.random() - 0.5) * 2 * sp; dz += (Math.random() - 0.5) * 2 * sp;
    const n = Math.hypot(dx, dy, dz); dx /= n; dy /= n; dz /= n;
    let L = def.gun.range;
    for (let s = 0.6; s <= L; s += 0.6) if (solid(m.x + dx * s, oy + dy * s, m.z + dz * s)) { L = s; break; }
    let best = null;
    for (const p of hooks.playersInZone()) {
      for (const [cy, r] of hooks.playerSpheres(p)) {
        const h = raySphere(m.x, oy, m.z, dx, dy, dz, p.x, cy, p.z, r);
        if (h !== null && h < L && (!best || h < best.t)) best = { t: h, p };
      }
    }
    const te = best ? best.t : L;
    hooks.onShot([m.x, oy, m.z], [m.x + dx * te, oy + dy * te, m.z + dz * te], def.gun.weapon);
    if (best) hooks.onHurtPlayer(best.p, def.gun.dmg, { label: 'a ' + def.label });
  }

  /* ---------- hits from players ---------- */
  const spheresOf = m => { const s = DEF[m.kind].scale, g = 1.3; return [[m.y + 0.5 * s, 0.5 * s * g, false], [m.y + 1.1 * s, 0.5 * s * g, false], [m.y + 1.62 * s, 0.3 * s * g, true]]; };   // a little generous, since raiders move and the view lags
  // first raider along a ray: { t, m, head } or null
  function rayTest(ox, oy, oz, dx, dy, dz, maxT) {
    let best = null;
    for (const m of mobs.values()) {
      if (Math.abs(m.x - ox) > 80 || Math.abs(m.z - oz) > 80) continue;
      for (const [cy, r, head] of spheresOf(m)) {
        const t = raySphere(ox, oy, oz, dx, dy, dz, m.x, cy, m.z, r);
        if (t !== null && t < maxT && (!best || t < best.t)) best = { t, m, head };
      }
    }
    return best;
  }
  function damage(m, dmg, attacker) {
    if (!mobs.has(m.id)) return false;
    m.hp -= dmg;
    if (m.hp > 0) return false;
    mobs.delete(m.id);
    hooks.onKill && hooks.onKill(m, attacker);
    return true;
  }
  function snapshot(now) {
    const out = [];
    for (const m of mobs.values())
      out.push([m.id, KINDS.indexOf(m.kind), +m.x.toFixed(2), +m.y.toFixed(2), +m.z.toFixed(2), +m.yaw.toFixed(2),
        Math.max(1, Math.round(m.hp / m.maxHp * 100)), (m.moving ? 1 : 0) | (now - m.swingAt < 350 ? 2 : 0) | (now - m.shootAt < 250 ? 4 : 0)]);
    return out;
  }
  const alive = () => mobs.size + W.queue.length;
  return { mobs, W, KINDS, DEF, update, damage, rayTest, spheresOf, snapshot, alive, reset };
};
