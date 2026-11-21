/* Escape Road practice simulator.
 * Random cities like the game builds (blocks of buildings, roads, rocks, water at the edge),
 * cops that drive the way the game's own police code does (found in the game files:
 * CarExternalInput.drivePolice -> steer straight at the player's car, three front sensors that
 * swerve around obstacles, turnCarAround when stuck, more cops over time), plus traffic and cash.
 * A planner that knows exactly how the cops behave drives each chase; every 0.1 s its choice is
 * saved as a lesson in the SAME 31-number format the bot uses in the real game, and the moments
 * before a crash or an arrest are saved as "don't do this" lessons. */
(function (root) {
  'use strict';
  const RAY_ANG = [-2.4, -1.6, -1.0, -0.6, -0.3, -0.12, 0, 0.12, 0.3, 0.6, 1.0, 1.6, 2.4];
  const TAU = Math.PI * 2;
  const angWrap = a => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  function rng(a) { return () => { a |= 0; a = a + 0x6d2b79f5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  // game-like numbers (the bot measures the real ones per car; these are typical)
  const CAR = { vmax: 16, accel: 6, turn: 2.4, steerResp: 9, slipResp: 10, decel: 14, radius: 1.3 };
  const COP = { radius: 2.4, turn: 2.0, sensor: 8, sensorAng: 0.5 };

  /* ---------------- a random city (1 m cells) ---------------- */
  function makeCity(R, size = 260) {
    const N = size, wall = new Uint8Array(N * N);
    const set = (x, z, v = 1) => { if (x >= 0 && z >= 0 && x < N && z < N) wall[z * N + x] = v; };
    // water around the edge
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) if (x < 8 || z < 8 || x >= N - 8 || z >= N - 8) wall[z * N + x] = 2;
    // blocks with buildings, roads between them
    const style = R() < 0.5 ? 'city' : 'desert';
    let z0 = 14;
    while (z0 < N - 30) {
      const bh = 22 + Math.floor(R() * 20); let x0 = 14;
      while (x0 < N - 30) {
        const bw = 22 + Math.floor(R() * 20), road = 9 + Math.floor(R() * 5);
        if (R() < 0.85) {   // a block (sometimes an open plaza)
          const inset = 1 + Math.floor(R() * 2), parts = 1 + Math.floor(R() * 3);
          for (let p = 0; p < parts; p++) {
            const px = x0 + inset + Math.floor(R() * bw * 0.4), pz = z0 + inset + Math.floor(R() * bh * 0.4);
            const w = Math.floor(bw * (0.4 + R() * 0.55)), h = Math.floor(bh * (0.4 + R() * 0.55));
            for (let z = pz; z < Math.min(z0 + bh - inset, pz + h); z++) for (let x = px; x < Math.min(x0 + bw - inset, px + w); x++) set(x, z);
          }
        }
        x0 += bw + road;
      }
      z0 += bh + 9 + Math.floor(R() * 5);
    }
    // rocks / trees / lamp posts on the roads
    const props = style === 'desert' ? 70 : 40;
    for (let i = 0; i < props; i++) { const x = 10 + Math.floor(R() * (N - 20)), z = 10 + Math.floor(R() * (N - 20)), r = style === 'desert' ? 1 + Math.floor(R() * 2) : 0; for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) set(x + dx, z + dz); }
    const isWall = (x, z) => { const ix = Math.floor(x), iz = Math.floor(z); if (ix < 0 || iz < 0 || ix >= N || iz >= N) return 2; return wall[iz * N + ix]; };
    // open road cells to spawn things on
    const free = [];
    for (let z = 10; z < N - 10; z += 2) for (let x = 10; x < N - 10; x += 2) { let ok = true; for (let dz = -3; dz <= 3 && ok; dz++) for (let dx = -3; dx <= 3; dx++) if (isWall(x + dx, z + dz)) { ok = false; break; } if (ok) free.push([x + 0.5, z + 0.5]); }
    return { N, wall, isWall, free, style };
  }
  const blocked = (city, x, z) => city.isWall(x, z) > 0;

  /* ---------------- one chase ---------------- */
  function newChase(seed, opts = {}) {
    const R = rng(seed), city = makeCity(R);
    if (city.free.length < 50) return null;
    const pick = () => city.free[(R() * city.free.length) | 0];
    const [sx, sz] = pick();
    let th = 0, best = -1;
    for (let i = 0; i < 16; i++) { const a = i / 16 * TAU; let d = 0; while (d < 40 && !blocked(city, sx + Math.cos(a) * d, sz + Math.sin(a) * d)) d += 1; if (d > best) { best = d; th = a; } }
    const car = { x: sx, z: sz, th, va: th, v: 6, s: 0, vx: 0, vz: 0, hits: 0 };
    const bags = []; for (let i = 0; i < 18; i++) { const [x, z] = pick(); bags.push({ x, z }); }
    const traffic = []; for (let i = 0; i < 5; i++) { const [x, z] = pick(); traffic.push({ x, z, th: [0, Math.PI / 2, Math.PI, -Math.PI / 2][(R() * 4) | 0], v: 6 + R() * 3, vx: 0, vz: 0, traffic: true }); }
    return { R, city, pick, car, bags, cops: [], traffic, t: 0, got: 0, done: null, lessons: [], recent: [], copSpeed: opts.copSpeed || 0.9, imitate: opts.imitate || null, mix: opts.mix || 0 };
  }

  // the police, as the game drives them: aim at the player, swerve around what the front sensors see
  function copSteer(city, c, target) {
    const want = Math.atan2(target.z - c.z, target.x - c.x);
    let steer = clamp(angWrap(want - c.th) * 2, -1, 1);
    const ray = (a, L) => { for (let d = 1; d <= L; d += 1) if (blocked(city, c.x + Math.cos(c.th + a) * d, c.z + Math.sin(c.th + a) * d)) return d; return L + 1; };
    const L = COP.sensor, mid = ray(0, L), left = ray(COP.sensorAng, L), right = ray(-COP.sensorAng, L);
    if (left <= L || right <= L || mid <= L) steer = clamp(steer + (left < right ? -1 : 1) * (mid <= L ? 1.2 : 0.7), -1, 1);
    return steer;
  }
  function stepCops(ep, dt) {
    const { city, car } = ep;
    // more cops over time (the game adds police as the wanted level goes up)
    const want = Math.min(6, 1 + Math.floor(ep.t / 8));
    if (ep.cops.length < want) {
      for (let k = 0; k < 20; k++) { const [x, z] = ep.pick(); const d = Math.hypot(x - car.x, z - car.z); if (d > 40 && d < 80) { ep.cops.push({ x, z, th: Math.atan2(car.z - z, car.x - x), v: 0, vx: 0, vz: 0, stuck: 0, rev: 0 }); break; } }
    }
    const vmax = CAR.vmax * (ep.copSpeed + Math.min(0.15, ep.t / 600));
    for (const c of ep.cops) {
      let steer, throttle = 1;
      if (c.rev > 0) { c.rev -= dt; steer = c.revSteer; throttle = -1; }   // turnCarAround
      else steer = copSteer(city, c, car);
      c.v = throttle > 0 ? Math.min(vmax, c.v + 9 * dt) : Math.max(-5, c.v - 12 * dt);
      c.th += steer * COP.turn * dt * Math.sign(c.v || 1) * Math.min(1, Math.abs(c.v) / 5 + 0.2);
      const nx = c.x + Math.cos(c.th) * c.v * dt, nz = c.z + Math.sin(c.th) * c.v * dt;
      if (blocked(city, nx, nz)) { c.v *= -0.2; c.stuck += dt; } else { c.vx = (nx - c.x) / dt; c.vz = (nz - c.z) / dt; c.x = nx; c.z = nz; if (Math.abs(c.v) > 2) c.stuck = 0; else c.stuck += dt; }
      if (c.stuck > 1 && c.rev <= 0) { c.rev = 1; c.revSteer = -Math.sign(steer || 1); c.stuck = 0; }
    }
    for (const o of ep.traffic) {
      const nx = o.x + Math.cos(o.th) * o.v * dt, nz = o.z + Math.sin(o.th) * o.v * dt;
      if (blocked(ep.city, nx + Math.cos(o.th) * 2, nz + Math.sin(o.th) * 2)) { o.th += (ep.R() < 0.5 ? 1 : -1) * Math.PI / 2; o.vx = o.vz = 0; }
      else { o.vx = (nx - o.x) / dt; o.vz = (nz - o.z) / dt; o.x = nx; o.z = nz; }
    }
  }

  /* ---------------- the same 31 numbers the bot uses in the game ---------------- */
  function features(ep) {
    const { car, city } = ep, f = [], th = car.th;
    for (const a of RAY_ANG) { let d = 1.5; const ca = Math.cos(th + a), sa = Math.sin(th + a); for (; d <= 16; d += 0.5) if (blocked(city, car.x + ca * d, car.z + sa * d)) break; f.push(Math.min(d, 16) / 16); }
    const sp = Math.hypot(car.vx, car.vz), vang = sp > 2 ? Math.atan2(car.vz, car.vx) : th;
    f.push(angWrap(vang - th), Math.min(sp, 25) / 25, car.s);
    const ca = Math.cos(th), sa = Math.sin(th);
    const rel = (x, z) => { const dx = x - car.x, dz = z - car.z; return [dx * ca + dz * sa, -dx * sa + dz * ca]; };
    const os = ep.cops.concat(ep.traffic).map(o => ({ o, d: Math.hypot(o.x - car.x, o.z - car.z) })).filter(q => q.d < 40).sort((a, b) => a.d - b.d).slice(0, 3);
    for (let i = 0; i < 3; i++) {
      if (os[i]) { const o = os[i].o, r = rel(o.x, o.z); f.push(clamp(r[0] / 20, -1, 1), clamp(r[1] / 20, -1, 1), (o.vx * ca + o.vz * sa) / 20, (-o.vx * sa + o.vz * ca) / 20); }
      else f.push(1, 0, 0, 0);
    }
    let bb = null, bd = 30; for (const b of ep.bags) { const d = Math.hypot(b.x - car.x, b.z - car.z); if (d < bd) { bd = d; bb = b; } }
    if (bb) { const r = rel(bb.x, bb.z); f.push(clamp(r[0] / 30, -1, 1), clamp(r[1] / 30, -1, 1), 1); } else f.push(0, 0, 0);
    return f;
  }

  /* ---------------- the teacher: plans 2 s ahead knowing how the cops drive ---------------- */
  const T1S = [0.1, 0.25, 0.45, 0.7, 1.0, 1.5, 2.0];
  function teacher(ep) {
    const { car, city } = ep, dt = 0.1, steps = 20;
    // predict cops by running their own steering rule toward where we'd be (approximated by our position now)
    const copsNow = ep.cops.map(c => ({ x: c.x, z: c.z, th: c.th, v: Math.max(4, Math.abs(c.v)) }));
    const others = ep.traffic;
    let best = null;
    for (const brake of [0, 1]) for (const u1 of [-1, 0, 1]) for (const t1 of T1S) for (const u2 of [-1, 0, 1]) {
      if (u1 === u2 && t1 < 2) continue; if (brake && t1 > 1) continue;
      let x = car.x, z = car.z, th = car.th, va = car.va, s = car.s, v = Math.max(3, Math.hypot(car.vx, car.vz)), cost = 0, alive = true, gain = 0;
      const cops = copsNow.map(c => ({ ...c }));
      for (let k = 1; k <= steps; k++) {
        const t = k * dt, u = t <= t1 ? u1 : u2;
        s += (u - s) * Math.min(1, CAR.steerResp * dt);
        if (brake && t <= t1) v = Math.max(2.5, v - CAR.decel * dt); else v = Math.min(CAR.vmax * (1 - 0.18 * Math.abs(s)), v + CAR.accel * dt);
        th += -s * CAR.turn * dt * Math.min(1, v / 6 + 0.3);
        va += angWrap(th - va) * Math.min(1, CAR.slipResp * dt);
        x += Math.cos(va) * v * dt; z += Math.sin(va) * v * dt;
        let clear = 9;
        for (const [fx, sx] of [[0, 0], [1.4, 0], [1.2, 0.7], [1.2, -0.7]]) { const qx = x + Math.cos(th) * fx - Math.sin(th) * sx, qz = z + Math.sin(th) * fx + Math.cos(th) * sx; if (blocked(city, qx, qz)) clear = 0; else { for (const r of [1, 2]) for (const [ox, oz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) if (blocked(city, qx + ox, qz + oz)) clear = Math.min(clear, r); } }
        if (clear < 1) { alive = false; cost += 30 + 20 * (2 - t); break; }
        cost += Math.max(0, 2.5 - clear) * 0.8 * dt;
        for (const c of cops) {  // the cops' own rule: head straight for us
          const want = Math.atan2(z - c.z, x - c.x); c.th += clamp(angWrap(want - c.th) * 2, -1, 1) * COP.turn * dt; c.x += Math.cos(c.th) * c.v * dt; c.z += Math.sin(c.th) * c.v * dt;
          const d = Math.hypot(c.x - x, c.z - z); if (d < COP.radius + 0.5) { alive = false; cost += 25 + 20 * (2 - t); break; } if (d < 8) cost += (8 - d) * 0.3 * dt;
        }
        if (!alive) break;
        for (const o of others) { const d = Math.hypot(o.x + o.vx * t - x, o.z + o.vz * t - z); if (d < 2.6) { cost += 8; } else if (d < 6) cost += (6 - d) * 0.2 * dt; }
        for (const b of ep.bags) if (Math.hypot(b.x - x, b.z - z) < 2) gain += 6;
      }
      let score = -cost + gain - (u1 ? 0.03 : 0) - (brake ? 0.4 : 0);
      if (alive) { let bd = 60; for (const b of ep.bags) bd = Math.min(bd, Math.hypot(b.x - x, b.z - z)); score -= 0.08 * bd; let cd = 60; for (const c of cops) cd = Math.min(cd, Math.hypot(c.x - x, c.z - z)); score += 0.05 * Math.min(cd, 40); }
      if (!best || score > best.score) best = { u1, brake, score };
    }
    return best;
  }

  /* ---------------- run one step of a chase ---------------- */
  function step(ep, dt) {
    const { car, city } = ep;
    ep.t += dt;
    ep.acc = (ep.acc || 0) + dt;
    if (!ep.external && ep.acc >= 0.1) {        // decide 10 times a second
      ep.acc = 0;
      const f = features(ep), plan = teacher(ep);
      // sometimes drive the way the bot's current brain would, so it also learns to fix its own mistakes
      let u = plan.u1;
      if (ep.imitate && ep.R() < ep.mix) { const p = ep.imitate(f); if (p) u = p.indexOf(Math.max(p[0], p[1], p[2])) - 1; }
      car.u = u; car.brake = plan.brake;
      ep.recent.push({ t: ep.t, f, u: plan.u1, ux: u, b: plan.brake ? 1 : 0 });
    }
    car.s += ((car.u || 0) - car.s) * Math.min(1, CAR.steerResp * dt);
    let v = Math.hypot(car.vx, car.vz) || car.v;
    if (car.brake) v = Math.max(2.5, v - CAR.decel * dt); else v = Math.min(CAR.vmax * (1 - 0.18 * Math.abs(car.s)), v + CAR.accel * dt);
    car.th += -car.s * CAR.turn * dt * Math.min(1, v / 6 + 0.3);
    car.va += angWrap(car.th - car.va) * Math.min(1, CAR.slipResp * dt);
    const nx = car.x + Math.cos(car.va) * v * dt, nz = car.z + Math.sin(car.va) * v * dt;
    if (blocked(city, nx, nz) || blocked(city, nx + Math.cos(car.th) * 1.4, nz + Math.sin(car.th) * 1.4)) {
      const hard = v > 8; car.vx = car.vz = 0; car.v = 1;
      if (city.isWall(nx, nz) === 2) return end(ep, 'drove into water');
      if (hard) { car.hits++; if (car.hits >= 3) return end(ep, 'wrecked'); }
    } else { car.vx = (nx - car.x) / dt; car.vz = (nz - car.z) / dt; car.x = nx; car.z = nz; }
    stepCops(ep, dt);
    for (const c of ep.cops) {
      const d = Math.hypot(c.x - car.x, c.z - car.z);
      if (d < COP.radius) { c.touch = (c.touch || 0) + dt; if (Math.hypot(car.vx, car.vz) < 4 && c.touch > 0.8) return end(ep, 'arrested'); if (c.touch > 0.15 && !c.hit) { c.hit = 1; car.hits++; if (car.hits >= 3) return end(ep, 'wrecked'); } }
      else { c.touch = 0; c.hit = 0; }
    }
    for (let i = ep.bags.length - 1; i >= 0; i--) if (Math.hypot(ep.bags[i].x - car.x, ep.bags[i].z - car.z) < 2.2) { ep.got++; const [x, z] = ep.pick(); ep.bags[i] = { x, z }; }
    if (ep.t >= (ep.maxT || 90)) end(ep, 'got away');
  }
  function end(ep, why) {
    ep.done = why;
    const bad = why !== 'got away';
    for (const r of ep.recent) {
      if (bad && ep.t - r.t < 1.2) ep.lessons.push({ f: r.f.map(v => +v.toFixed(3)), u: r.ux, b: r.b, w: -0.4, sim: 1 });
      else ep.lessons.push({ f: r.f.map(v => +v.toFixed(3)), u: r.u, b: r.b, w: 0.5, sim: 1 });
    }
  }

  // play a whole chase quickly; returns { t, got, done, lessons }
  function runChase(seed, opts) {
    const ep = newChase(seed, opts); if (!ep) return null;
    ep.maxT = (opts && opts.maxT) || 90;
    while (!ep.done) step(ep, 0.05);
    return ep;
  }

  /* ---------------- as an environment for reinforcement learning ----------------
   * 6 actions: steer left / straight / right, each with or without the brake. One step = 0.1 s.
   * Reward: staying alive and moving (+0.1 a step at full speed), cash +5, a hard hit -3,
   * getting caught / wrecked / driving into water -10. */
  const ACTIONS = [[-1, 0], [-1, 1], [0, 0], [0, 1], [1, 0], [1, 1]];
  function envReset(seed, opts = {}) {
    const ep = newChase(seed, opts); if (!ep) return null;
    ep.external = true; ep.maxT = opts.maxT || 90; ep.prevF = null;
    ep.obs = features(ep);
    return ep;
  }
  function envStep(ep, a) {
    const [u, b] = ACTIONS[a], got0 = ep.got, hits0 = ep.car.hits;
    ep.car.u = u; ep.car.brake = b;
    for (let k = 0; k < 2 && !ep.done; k++) step(ep, 0.05);
    const sp = Math.hypot(ep.car.vx, ep.car.vz);
    let r = 0.1 * (0.3 + 0.7 * Math.min(sp, CAR.vmax) / CAR.vmax) + 5 * (ep.got - got0) - 3 * (ep.car.hits - hits0);
    let nearest = 99; for (const c of ep.cops) nearest = Math.min(nearest, Math.hypot(c.x - ep.car.x, c.z - ep.car.z));
    if (nearest < 6) r -= 0.03 * (6 - nearest);
    if (ep.done && ep.done !== 'got away') r -= 10;
    ep.prevF = ep.obs; ep.obs = features(ep);
    return { r, done: !!ep.done, timeUp: ep.done === 'got away' };
  }

  root.ERSim = { newChase, step, runChase, features, makeCity, CAR, COP, ACTIONS, envReset, envStep };
})(typeof window !== 'undefined' ? window : globalThis);
