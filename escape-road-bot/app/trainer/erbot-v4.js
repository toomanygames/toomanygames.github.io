/*
 * Escape Road bot — brain v4
 * --------------------------------------------------------------
 * Drop-in module that adds, on top of the existing bot:
 *   1. A better learner: small neural net trained on your demos.
 *      - ignores "what I was already steering" (stops copycat driving)
 *      - learns to AVOID actions that led to crashes
 *      - only learns from its own runs when they were good ones
 *   2. Bag memory: remembers every money bag it has ever seen (exact spot),
 *      forgets ones that are gone, even if it never picks them up.
 *   3. Route planning: A* over the map the bot has already explored,
 *      picks the best bag (or an escape spot away from cops) and steers along it.
 *   4. Gets unstuck / out of water: backs up toward the last dry road it drove on,
 *      or drives to the nearest known road; remembers water so routes avoid it.
 *   5. Your crashes are forgotten: the last 2.5 s before you crash are not learned.
 *   6. Lag guard: all heavy work runs inside a per-frame time budget
 *      (default 3 ms) and is spread over several frames.
 *
 * Works with the existing save format ("escape-road-bot" v1 with
 * erbot_brain_v3 + erbot_map_v1) and writes it back in the same shape,
 * adding a few new fields (old code ignores them).
 *
 * Usage (see README section at the bottom of this file):
 *   const bot = ERBot4.create({ save });          // parsed save file or null
 *   // every frame:
 *   const out = bot.tick({ now, features, car, cops, visibleBags, humanSteer });
 *   // out.steer in [-1, 1], out.action in {-1, 0, 1}, out.throttle 1 (gas), 0 (brake), -1 (reverse)
 *   bot.onRunEnd({ dur, bags, human, crashed });
 *   const json = bot.exportSave();                // same file format as before
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- config
  const DEFAULTS = {
    frameBudgetMs: 3,          // max ms of extra work per frame (planner + training)
    plannerShareMs: 1.0,       // part of the budget reserved for the planner
    replanEveryMs: 400,        // how often the route is refreshed
    chunkSize: 51.2,           // world units per map chunk (from your save)
    chunkCells: 32,            // cells per chunk side
    coarse: 4,                 // planner works on 4x4-cell blocks (6.4 units)
    maxExpansionsPerSlice: 1200,
    copAvoidRadius: 18,        // planner adds cost near cops (world units)
    bagViewRadius: 45,         // a bag this close should be visible if it still exists
    bagMergeRadius: 4,
    lookahead: 14,             // world units ahead on the path to steer at
    sampleEveryMs: 100,        // recording rate for training samples
    maxSamples: 9000,
    hidden: 32,
    learnRate: 0.003,
    l2: 0.03,                  // strong regularisation: best on held-out drives
    epochs: 30,                // full passes after loading; +8 after each new run
    imitW: 1.0,                // weight of learned policy when choosing steering
    routeW: 1.6,               // weight of the route
    steerGain: 1.8,            // radians -> steering
    smooth: 0.35,              // output smoothing (0 = none)
    mirror: null,              // optional left/right mirror spec (off: unverified)
    priority: 'pro',           // 'pro' = survive first, grab money only when it's on the way; 'money' = old bag-hunting
    bagDetourMax: 55,          // pro: only go for bags this close...
    bagAngleMax: 0.9,          // ...and roughly ahead (radians, ~50 degrees)
    bagSafeCopDist: 28,        // ...and with no cop this close to the bag
    copPredictS: 1.0,          // plan around where cops WILL be, this many seconds ahead
    escMomentum: 2.5,          // how much it prefers to keep going the way it's going
    escCopW: 0.083,            // how much it values getting further from cops
    wallMargin: 3,             // extra cost for driving right next to walls (keeps it on open road)
    safety: true,              // short look-ahead that refuses moves into walls/cops
    safetyHorizon: 1.4,        // seconds
    brakeDecel: 18,            // world units/s^2 when braking (used by the look-ahead)
    balance: 3,                // max up-weighting of rare steering classes (0 = off)
    motion: true,              // also learn from how things changed since ~0.1 s ago (tested: better)
    forgetHumanCrashMs: 2500,  // when YOU crash, the last 2.5 s of your driving are thrown away
    stuckSpeed: 1.5,           // world units/s; slower than this while driving = stuck
    stuckMs: 1200,             // how long before it counts as stuck
    reverseMs: 900,            // back-up time when stuck
    escapeMs: 3500,            // max time driving toward land before trying again
    landSearchCells: 30,       // how far (in 6.4-unit blocks) to look for land
  };

  // ---------------------------------------------------------------- utils
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  function b64ToBytes(s) {
    if (typeof atob === 'function') {
      const bin = atob(s), out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(s, 'base64'));
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------- features
  // Raw v3 features (31): 0-12 rays, 13 angle, 14 speed, 15 current steering,
  // 16-30 nearby cars/cops/etc. We drop 15 (copycat) and split the angle into sin/cos.
  const N_RAW = 31;
  function prep(f) {
    const x = new Float32Array(31);
    let k = 0;
    for (let i = 0; i <= 12; i++) x[k++] = f[i];
    x[k++] = Math.sin(f[13]); x[k++] = Math.cos(f[13]);
    x[k++] = f[14];
    for (let i = 16; i <= 30; i++) x[k++] = f[i];
    return x;
  }
  const N_BASE = 31;
  // motion inputs: change of every input except the angle since the previous sample
  function prepMotion(f, pf) {
    const a = prep(f), b = pf ? prep(pf) : a, x = new Float32Array(N_BASE + 29);
    x.set(a);
    let k = N_BASE;
    for (let i = 0; i < N_BASE; i++) { if (i === 13 || i === 14) continue; x[k++] = a[i] - b[i]; }
    return x;
  }
  function jumped(f, pf) { let s = 0; for (let i = 0; i < 13; i++) s += Math.abs(f[i] - pf[i]); return s > 4; }

  function mirrorSample(f, u, spec) {
    // spec: { rays: true, negate: [indices of left/right values] }
    const g = f.slice();
    if (spec.rays) for (let i = 0; i <= 12; i++) g[i] = f[12 - i];
    for (const i of spec.negate || []) g[i] = -f[i];
    return { f: g, u: -u };
  }

  // ---------------------------------------------------------------- policy net
  class PolicyNet {
    constructor(nIn, nH, seed = 1) {
      this.nIn = nIn; this.nH = nH;
      const r = mulberry32(seed), s1 = 1 / Math.sqrt(nIn), s2 = 1 / Math.sqrt(nH);
      this.W1 = Float32Array.from({ length: nIn * nH }, () => (r() * 2 - 1) * s1);
      this.b1 = new Float32Array(nH);
      this.W2 = Float32Array.from({ length: nH * 3 }, () => (r() * 2 - 1) * s2);
      this.b2 = new Float32Array(3);
      this.mean = new Float32Array(nIn); this.std = new Float32Array(nIn).fill(1);
      this._adam = null; this.t = 0;
      this.h = new Float32Array(nH); this.p = new Float32Array(3);
    }
    setNorm(X) {
      const n = X.length, d = this.nIn;
      const m = new Float64Array(d), v = new Float64Array(d);
      for (const x of X) for (let j = 0; j < d; j++) m[j] += x[j];
      for (let j = 0; j < d; j++) m[j] /= n;
      for (const x of X) for (let j = 0; j < d; j++) v[j] += (x[j] - m[j]) ** 2;
      for (let j = 0; j < d; j++) { this.mean[j] = m[j]; this.std[j] = Math.max(0.05, Math.sqrt(v[j] / n)); }
    }
    forward(x) {
      const { nIn, nH, W1, b1, W2, b2, h, p, mean, std } = this;
      for (let j = 0; j < nH; j++) {
        let s = b1[j];
        for (let i = 0; i < nIn; i++) s += ((x[i] - mean[i]) / std[i]) * W1[i * nH + j];
        h[j] = Math.tanh(s);
      }
      let mx = -1e9;
      for (let k = 0; k < 3; k++) {
        let s = b2[k];
        for (let j = 0; j < nH; j++) s += h[j] * W2[j * 3 + k];
        p[k] = s; if (s > mx) mx = s;
      }
      let z = 0;
      for (let k = 0; k < 3; k++) { p[k] = Math.exp(p[k] - mx); z += p[k]; }
      for (let k = 0; k < 3; k++) p[k] /= z;
      return p;
    }
    // batch: array of {x, k (0..2), w}; w<0 means "avoid this action"
    trainBatch(batch, lr, l2 = 1e-4) {
      const { nIn, nH, W1, W2, mean, std } = this;
      const gW1 = new Float32Array(W1.length), gb1 = new Float32Array(nH);
      const gW2 = new Float32Array(W2.length), gb2 = new Float32Array(3);
      const xn = new Float32Array(nIn), dh = new Float32Array(nH);
      let loss = 0;
      for (const s of batch) {
        for (let i = 0; i < nIn; i++) xn[i] = (s.x[i] - mean[i]) / std[i];
        const p = this.forward(s.x), h = this.h, k = s.k;
        const dz = [0, 0, 0];
        if (s.w >= 0) {
          loss -= s.w * Math.log(p[k] + 1e-7);
          for (let c = 0; c < 3; c++) dz[c] = s.w * (p[c] - (c === k ? 1 : 0));
        } else {
          // minimise -log(1 - p_k): push probability away from the crash action
          const a = -s.w, q = Math.max(1e-6, 1 - p[k]);
          loss -= a * Math.log(q);
          // d(-log(1-pk))/dz_c = (pk/(1-pk)) * (delta_ck - p_c)
          for (let c = 0; c < 3; c++) dz[c] = a * (p[k] / q) * ((c === k ? 1 : 0) - p[c]);
        }
        for (let c = 0; c < 3; c++) gb2[c] += dz[c];
        for (let j = 0; j < nH; j++) {
          let g = 0;
          for (let c = 0; c < 3; c++) { gW2[j * 3 + c] += h[j] * dz[c]; g += W2[j * 3 + c] * dz[c]; }
          dh[j] = g * (1 - h[j] * h[j]);
          gb1[j] += dh[j];
        }
        for (let i = 0; i < nIn; i++) {
          const xi = xn[i]; if (xi === 0) continue;
          const row = i * nH;
          for (let j = 0; j < nH; j++) gW1[row + j] += xi * dh[j];
        }
      }
      const n = batch.length;
      this._step([this.W1, this.b1, this.W2, this.b2], [gW1, gb1, gW2, gb2], n, lr, l2);
      return loss / n;
    }
    _step(P, G, n, lr, l2) {
      if (!this._adam) this._adam = P.map(p => [new Float32Array(p.length), new Float32Array(p.length)]);
      this.t++;
      const b1 = 0.9, b2 = 0.999, c1 = 1 - b1 ** this.t, c2 = 1 - b2 ** this.t;
      P.forEach((p, idx) => {
        const [m, v] = this._adam[idx], g = G[idx];
        for (let i = 0; i < p.length; i++) {
          const gi = g[i] / n + l2 * p[i];
          m[i] = b1 * m[i] + (1 - b1) * gi;
          v[i] = b2 * v[i] + (1 - b2) * gi * gi;
          p[i] -= (lr * (m[i] / c1)) / (Math.sqrt(v[i] / c2) + 1e-8);
        }
      });
    }
    toJSON() {
      const a = x => Array.from(x, v => Math.round(v * 1e5) / 1e5);
      return { nIn: this.nIn, nH: this.nH, W1: a(this.W1), b1: a(this.b1), W2: a(this.W2), b2: a(this.b2), mean: a(this.mean), std: a(this.std), t: this.t };
    }
    static fromJSON(o) {
      const n = new PolicyNet(o.nIn, o.nH);
      for (const k of ['W1', 'b1', 'W2', 'b2', 'mean', 'std']) n[k] = Float32Array.from(o[k]);
      n.t = 0; return n;
    }
  }

  // ---------------------------------------------------------------- learner
  class Learner {
    constructor(cfg, brain) {
      this.cfg = cfg;
      this.brain = brain || { version: 3, samples: [], runs: [], humanSamples: 0 };
      this.samples = this.brain.samples || (this.brain.samples = []);
      this.rand = mulberry32(7);
      this.nIn = cfg.motion ? N_BASE + 29 : N_BASE;
      this.net = brain && brain.v4net && brain.v4net.nIn === this.nIn ? PolicyNet.fromJSON(brain.v4net) : new PolicyNet(this.nIn, cfg.hidden);
      this.trained = !!(brain && brain.v4net && brain.v4net.nIn === this.nIn);
      this.dirty = true;
      this.runBuf = []; this.lastRec = -1e9;
      this.epochs = brain && brain.v4epochs || 0;
      this._order = null; this._pos = 0; this.lastLoss = NaN;
    }
    rebuild() {
      const cfg = this.cfg, data = [];
      let cls = [0, 0, 0];
      const push = (x, u, w) => {
        const k = u + 1;
        data.push({ x, k, w });
        if (w > 0) cls[k] += w;
      };
      let prev = null;
      for (const s of this.samples) {
        // samples are stored in time order; the one before is "~0.1 s ago" unless the scene jumped
        const pf = s.p || (prev && !jumped(s.f, prev) ? prev : null);
        push(this.featurize(s.f, pf), s.u, s.w);
        if (cfg.mirror && s.w > 0) { const m = mirrorSample(s.f, s.u, cfg.mirror); push(this.featurize(m.f, null), m.u, s.w); }
        prev = s.f;
      }
      if (cfg.balance) {   // left/right are rarer than straight: weight them up so it doesn't just go straight
        const tot = cls[0] + cls[1] + cls[2] || 1;
        const cw = cls.map(c => (c > 0 ? Math.min(cfg.balance, tot / (3 * c)) : 1));
        for (const d of data) if (d.w > 0) d.w *= cw[d.k];
      }
      this.data = data;
      if (this.targetEpochs === undefined) this.targetEpochs = this.trained ? this.epochs : this.cfg.epochs;
      else this.targetEpochs = Math.max(this.targetEpochs, this.epochs + 8);
      if (!this.trained && data.length) this.net.setNorm(data.map(d => d.x));
      this._order = null; this.dirty = false;
    }
    // Train for up to `budgetMs`. Returns ms used.
    trainTick(budgetMs) {
      if (this.dirty) this.rebuild();
      const t0 = now();
      if (!this.data || this.data.length < 50 || this.epochs >= this.targetEpochs) return now() - t0;
      const B = 32;
      while (now() - t0 < budgetMs) {
        if (!this._order || this._pos >= this._order.length) {
          const o = this._order = Uint32Array.from(this.data.keys());
          for (let i = o.length - 1; i > 0; i--) { const j = (this.rand() * (i + 1)) | 0; [o[i], o[j]] = [o[j], o[i]]; }
          this._pos = 0; this.epochs++;
        }
        const batch = [];
        for (let i = 0; i < B && this._pos < this._order.length; i++) batch.push(this.data[this._order[this._pos++]]);
        if (!batch.length) continue;
        const lr = this.cfg.learnRate * (this.epochs > 20 ? 0.4 : 1);
        this.lastLoss = this.net.trainBatch(batch, lr, this.cfg.l2);
        this.trained = true;
      }
      return now() - t0;
    }
    trainEpochs(n) { if (this.dirty) this.rebuild(); this.targetEpochs = this.epochs + n; while (this.epochs < this.targetEpochs) this.trainTick(5); }
    featurize(f, pf) { return this.cfg.motion ? prepMotion(f, pf) : prep(f); }
    policy(f, pf) { return this.net.forward(this.featurize(f, pf)); }

    // recording ----------------------------------------------------
    record(t, f, u, human, recovering) {
      if (t - this.lastRec < this.cfg.sampleEveryMs) return;
      this.lastRec = t;
      this.runBuf.push({ t, f: Array.from(f, v => Math.round(v * 1000) / 1000), u: Math.round(clamp(u, -1, 1)), human, recovering: !!recovering });
    }
    onRunEnd(run) {
      const buf = this.runBuf; this.runBuf = []; this.lastRec = -1e9;
      if (!buf.length) return;
      const tEnd = buf[buf.length - 1].t;
      const crashed = run.crashed !== false;
      const crashCut = crashed ? 1200 : 0;          // bot: last 1.2 s led to the crash -> learn to avoid it
      const humanForget = crashed ? this.cfg.forgetHumanCrashMs : 0; // you: last seconds are simply forgotten
      const runs = (this.brain.runs || []).filter(r => !r.human).slice(-10).map(r => r.dur).sort((a, b) => a - b);
      const median = runs.length ? runs[runs.length >> 1] : 20;
      const goodBotRun = run.bags > 0 || run.dur > Math.max(30, 1.5 * median);
      for (const s of buf) {
        if (s.recovering) continue;                 // never learn from stuck / water recovery moves
        if (s.human) {
          if (tEnd - s.t < humanForget) continue;   // your crash isn't remembered at all
          this.samples.push({ f: s.f, u: s.u, w: 1 });
        } else if (tEnd - s.t < crashCut) this.samples.push({ f: s.f, u: s.u, w: -0.6 });
        else if (goodBotRun) this.samples.push({ f: s.f, u: s.u, w: 0.25 });
      }
      this.trim();
      this.brain.humanSamples = this.samples.filter(s => s.w === 1).length;
      this.dirty = true;
    }
    trim() {
      const max = this.cfg.maxSamples;
      if (this.samples.length <= max) return;
      // drop oldest bot samples first, then oldest crash samples, then oldest human
      for (const w of [0.25, -0.6, 1]) {
        let extra = this.samples.length - max;
        if (extra <= 0) break;
        this.samples = this.samples.filter(s => !(s.w === w && extra-- > 0));
      }
      this.brain.samples = this.samples;
    }
    save() {
      this.brain.samples = this.samples;
      this.brain.v4net = this.net.toJSON();
      this.brain.v4epochs = this.epochs;
      return this.brain;
    }
  }

  // ---------------------------------------------------------------- map grid
  // cell byte: high nibble = times seen open (0-7), low nibble = times hit as obstacle (0-15)
  class MapGrid {
    constructor(cfg, world) {
      this.cfg = cfg; this.world = world || { chunks: {}, bags: [], runs: 0 };
      this.cache = new Map(); // "cx,cz" -> Uint8Array coarse cost (0 = blocked, else cost)
      this.cell = cfg.chunkSize / cfg.chunkCells;
      this.B = cfg.coarse; this.n = cfg.chunkCells / cfg.coarse; // coarse cells per chunk side
      this.size = this.cell * this.B;                              // coarse cell size (world)
      this.water = this.world.water || (this.world.water = {});    // "gx,gz" -> times found water there
    }
    markWater(x, z) {
      const [gx, gz] = this.toCell(x, z), k = gx + ',' + gz;
      this.water[k] = Math.min(9, (this.water[k] || 0) + 1);
    }
    isWater(gx, gz) { return (this.water[gx + ',' + gz] || 0) >= 1; }
    invalidate(key) { if (key) { this.cache.delete(key); this._bytes && this._bytes.delete(key); } else { this.cache.clear(); this._bytes = null; } }
    _chunkCost(cx, cz) {
      const key = cx + ',' + cz;
      let c = this.cache.get(key);
      if (c) return c;
      const s = this.world.chunks[key];
      const n = this.n, B = this.B, C = this.cfg.chunkCells;
      c = new Uint8Array(n * n);
      if (!s) { c.fill(12); this.cache.set(key, c); return c; } // unexplored: allowed, but costly
      const bytes = b64ToBytes(s);
      for (let gz = 0; gz < n; gz++) for (let gx = 0; gx < n; gx++) {
        let free = 0, blocked = 0, unknown = 0;
        for (let dz = 0; dz < B; dz++) for (let dx = 0; dx < B; dx++) {
          const v = bytes[(gz * B + dz) * C + gx * B + dx], hi = v >> 4, lo = v & 15;
          if (lo >= 3 && lo >= hi) blocked++;
          else if (hi >= 1) free++;
          else unknown++;
        }
        const N = B * B;
        let cost;
        if (blocked >= N * 0.35) cost = 0;                 // wall / building
        else if (unknown >= N * 0.6) cost = 0;             // never seen inside explored area = almost always a building/tree
        else cost = 1 + Math.round(6 * blocked / N + 4 * unknown / N);
        c[gz * n + gx] = cost;
      }
      this.cache.set(key, c);
      return c;
    }
    // coarse cell coordinates
    toCell(x, z) { return [Math.floor(x / this.size), Math.floor(z / this.size)]; }
    toWorld(gx, gz) { return [(gx + 0.5) * this.size, (gz + 0.5) * this.size]; }
    raw(gx, gz) {
      const n = this.n, cx = Math.floor(gx / n), cz = Math.floor(gz / n);
      return this._chunkCost(cx, cz)[(gz - cz * n) * n + (gx - cx * n)];
    }
    cost(gx, gz) {
      const c = this.raw(gx, gz);
      if (!c) return 0;
      if (this.water[gx + ',' + gz]) return 25;                    // water: route around it if at all possible
      const m = this.cfg.wallMargin;                               // hugging walls is how cars crash
      if (m && (!this.raw(gx + 1, gz) || !this.raw(gx - 1, gz) || !this.raw(gx, gz + 1) || !this.raw(gx, gz - 1))) return c + m;
      return c;
    }
    // fine (1.6-unit) cell check: 1 = wall, 0.6 = never seen, 0 = road
    fine(x, z) {
      const cs = this.cfg.chunkSize, cx = Math.floor(x / cs), cz = Math.floor(z / cs), key = cx + ',' + cz;
      let b = this._bytes && this._bytes.get(key);
      if (b === undefined) { const s = this.world.chunks[key]; b = s ? b64ToBytes(s) : null; (this._bytes || (this._bytes = new Map())).set(key, b); }
      if (!b) return 0.3;
      const C = this.cfg.chunkCells, ix = Math.floor((x - cx * cs) / this.cell), iz = Math.floor((z - cz * cs) / this.cell);
      const v = b[iz * C + ix], hi = v >> 4, lo = v & 15;
      if (lo >= 3 && lo >= hi) return 1;
      return hi ? 0 : 0.6;
    }
    // how open the area around a block is (0..1): pros prefer wide roads with room to dodge
    openness(gx, gz, r = 2) {
      let ok = 0, n = 0;
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) { n++; const c = this.raw(gx + dx, gz + dz); if (c && c <= 4 && !this.water[(gx + dx) + ',' + (gz + dz)]) ok++; }
      return ok / n;
    }
    // nearest block that is known road and not water
    nearestLand(x, z, maxR) {
      const [cx, cz] = this.toCell(x, z);
      for (let r = 1; r <= maxR; r++) {
        let best = null, bd = 1e9;
        for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const gx = cx + dx, gz = cz + dz, c = this.cost(gx, gz);
          if (!c || c > 4 || this.isWater(gx, gz)) continue;
          const d = dx * dx + dz * dz; if (d < bd) { bd = d; best = [gx, gz]; }
        }
        if (best) { const [wx, wz] = this.toWorld(best[0], best[1]); return { x: wx, z: wz }; }
      }
      return null;
    }
  }

  // ---------------------------------------------------------------- A* (time-sliced)
  class Heap {
    constructor() { this.k = []; this.v = []; }
    get size() { return this.k.length; }
    push(key, val) {
      const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
      while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
      k[i] = key; v[i] = val;
    }
    pop() {
      const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
      if (n) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1; if (c >= n) break;
          if (c + 1 < n && k[c + 1] < k[c]) c++;
          if (k[c] >= lk) break;
          k[i] = k[c]; v[i] = v[c]; i = c;
        }
        k[i] = lk; v[i] = lv;
      }
      return top;
    }
  }
  const KEY = (x, z) => (x + 32768) * 65536 + (z + 32768);
  const KX = k => Math.floor(k / 65536) - 32768, KZ = k => (k % 65536) - 32768;
  const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
  class Planner {
    constructor(cfg, grid) { this.cfg = cfg; this.grid = grid; this.job = null; this.path = null; this.goal = null; this.stats = { plans: 0, lastExp: 0, fails: 0 }; }
    start(from, to, cops, maxNodes = 40000) {
      const g = this.grid, [sx, sz] = g.toCell(from.x, from.z), [tx, tz] = g.toCell(to.x, to.z);
      const copCells = (cops || []).map(c => g.toCell(c.x, c.z));
      const copR = this.cfg.copAvoidRadius / g.size;
      this.job = { sx, sz, tx, tz, open: new Heap(), gs: new Map(), par: new Map(), closed: new Set(), copCells, copR, exp: 0, maxNodes, best: null, bestH: 1e9, goal: to };
      const k = KEY(sx, sz); this.job.gs.set(k, 0); this.job.open.push(this.h(sx, sz), k);
    }
    h(x, z) { const j = this.job, dx = Math.abs(x - j.tx), dz = Math.abs(z - j.tz); return (dx + dz + (1.414 - 2) * Math.min(dx, dz)) * 1.0; }
    // run for up to budgetMs; returns true when the job is finished
    step(budgetMs) {
      const j = this.job; if (!j) return true;
      const g = this.grid, t0 = now(); let n = 0;
      while (j.open.size) {
        if ((++n & 15) === 0 && now() - t0 > budgetMs) return false;
        if (n > this.cfg.maxExpansionsPerSlice) return false;
        const k = j.open.pop();
        if (j.closed.has(k)) continue;
        j.closed.add(k); j.exp++;
        const x = KX(k), z = KZ(k);
        const hh = this.h(x, z);
        if (hh < j.bestH) { j.bestH = hh; j.best = k; }
        if ((x === j.tx && z === j.tz) || j.exp > j.maxNodes) { this._finish(k); return true; }
        const g0 = j.gs.get(k);
        for (const [dx, dz, dl] of DIRS) {
          const nx = x + dx, nz = z + dz, cst = g.cost(nx, nz);
          if (!cst) continue;
          if (dx && dz && (!g.cost(x + dx, z) || !g.cost(x, z + dz))) continue; // no corner cutting
          let pen = 0;
          for (const [cx, cz] of j.copCells) { const d = Math.hypot(nx - cx, nz - cz); if (d < j.copR) pen += 6 * (1 - d / j.copR); }
          const ng = g0 + dl * (cst + pen), nk = KEY(nx, nz);
          const old = j.gs.get(nk);
          if (old === undefined || ng < old) { j.gs.set(nk, ng); j.par.set(nk, k); j.open.push(ng + this.h(nx, nz), nk); }
        }
      }
      this._finish(j.best); return true;
    }
    _finish(k) {
      const j = this.job; this.job = null; this.stats.plans++; this.stats.lastExp = j.exp;
      if (k === null || k === undefined) { this.stats.fails++; this.path = null; return; }
      const pts = [];
      while (k !== undefined) { pts.push(this.grid.toWorld(KX(k), KZ(k))); k = j.par.get(k); }
      pts.reverse();
      this.path = pts.map(([x, z]) => ({ x, z })); this.goal = j.goal;
    }
    // point on the path `ahead` units in front of `pos`
    lookahead(pos, ahead) {
      const p = this.path; if (!p || p.length < 2) return null;
      let bi = 0, bd = 1e9;
      for (let i = 0; i < p.length; i++) { const d = Math.hypot(p[i].x - pos.x, p[i].z - pos.z); if (d < bd) { bd = d; bi = i; } }
      if (bd > 25) return null; // drifted off the path: wait for replan
      let left = ahead;
      for (let i = bi; i < p.length - 1; i++) {
        const seg = Math.hypot(p[i + 1].x - p[i].x, p[i + 1].z - p[i].z);
        if (seg >= left) { const t = left / seg; return { x: p[i].x + (p[i + 1].x - p[i].x) * t, z: p[i].z + (p[i + 1].z - p[i].z) * t }; }
        left -= seg;
      }
      return p[p.length - 1];
    }
  }

  // ---------------------------------------------------------------- bag memory
  class BagMemory {
    constructor(cfg, world) {
      this.cfg = cfg; this.world = world;
      this.bags = world.bags || (world.bags = []);
      // older entries were stored at chunk centres; keep them as lower-confidence hints
      for (const b of this.bags) if (b.conf === undefined) b.conf = b.exact ? 1 : 0.5;
    }
    observe(visible, t, car) {
      const R = this.cfg.bagMergeRadius;
      if (visible) for (const v of visible) {
        let m = null, md = R;
        for (const b of this.bags) { const d = Math.hypot(b.x - v.x, b.z - v.z); if (d < md) { md = d; m = b; } }
        if (!m) {
          // replace a chunk-level hint in the same chunk with the exact spot
          const cs = this.cfg.chunkSize;
          m = this.bags.find(b => !b.exact && Math.floor(b.x / cs) === Math.floor(v.x / cs) && Math.floor(b.z / cs) === Math.floor(v.z / cs));
          if (m) { m.x = v.x; m.z = v.z; } else { m = { x: v.x, z: v.z, n: 0, last: 0 }; this.bags.push(m); }
        } else { m.x += (v.x - m.x) * 0.3; m.z += (v.z - m.z) * 0.3; }
        m.exact = 1; m.n = (m.n || 0) + 1; m.conf = 1; m.seenAt = t; m.gone = 0;
        m.x = Math.round(m.x * 10) / 10; m.z = Math.round(m.z * 10) / 10;
      }
      // a remembered bag that should be in view but isn't -> probably collected / gone
      if (visible && car) for (const b of this.bags) {
        if (!b.exact || b.conf <= 0) continue;
        const d = Math.hypot(b.x - car.x, b.z - car.z);
        if (d < this.cfg.bagViewRadius * 0.6 && !visible.some(v => Math.hypot(v.x - b.x, v.z - b.z) < R)) {
          b.conf *= 0.9; if (b.conf < 0.15) { b.conf = 0; b.gone = t; }
        }
      }
      // bags respawn: slowly restore confidence after 90 s
      for (const b of this.bags) if (b.conf === 0 && b.gone && t - b.gone > 90000) { b.conf = 0.4; b.gone = 0; }
    }
    collected(car, t) {
      for (const b of this.bags) if (Math.hypot(b.x - car.x, b.z - car.z) < 5) { b.conf = 0; b.gone = t; b.last = t; b._visited = t; }
    }
    candidates() { return this.bags.filter(b => b.conf > 0.1); }
  }

  // ---------------------------------------------------------------- the bot
  class Bot {
    constructor(opts = {}) {
      const save = opts.save || null;
      let saved = {};
      try { const c = save && save.data && save.data.erbot_v4_config; saved = c ? (typeof c === 'string' ? JSON.parse(c) : c) : {}; } catch (e) { saved = {}; }
      this.cfg = Object.assign({}, DEFAULTS, saved, opts.config || {});
      this.save = save || { app: 'escape-road-bot', version: 1, data: {} };
      const data = this.save.data || (this.save.data = {});
      const brain = data.erbot_brain_v3 ? (typeof data.erbot_brain_v3 === 'string' ? JSON.parse(data.erbot_brain_v3) : data.erbot_brain_v3) : null;
      this.map = data.erbot_map_v1 ? (typeof data.erbot_map_v1 === 'string' ? JSON.parse(data.erbot_map_v1) : data.erbot_map_v1) : { version: 1, worlds: {} };
      this.learner = new Learner(this.cfg, brain);
      this.setWorld(opts.world || Object.keys(this.map.worlds)[0] || '0,0');
      this.steerSign = 1; this._cal = 0; this._calN = 0;
      this.prev = null; this.out = 0; this.lastPlan = -1e9;
      this.perf = { frameMs: 0, maxMs: 0, planMs: 0, trainMs: 0 };
      this.target = null; this.mode = 'policy';
    }
    setWorld(key) {
      this.worldKey = key;
      const w = this.map.worlds[key] || (this.map.worlds[key] = { chunks: {}, bags: [], runs: 0 });
      this.grid = new MapGrid(this.cfg, w);
      this.planner = new Planner(this.cfg, this.grid);
      this.bagMem = new BagMemory(this.cfg, w);
    }
    // tell the planner a chunk changed (call after the bot's mapper writes a chunk)
    chunkUpdated(key) { this.grid.invalidate(key); }

    // track cop velocities so we can plan around where they are going, not where they were
    trackCops(t, cops) {
      const prev = this._cops || [], out = [];
      for (const c of cops || []) {
        let m = null, md = 12;
        for (const p of prev) { const d = Math.hypot(p.x - c.x, p.z - c.z); if (d < md) { md = d; m = p; } }
        let vx = 0, vz = 0;
        if (m && t > m.t) { const dt = (t - m.t) / 1000; vx = m.vx * 0.6 + ((c.x - m.x) / dt) * 0.4; vz = m.vz * 0.6 + ((c.z - m.z) / dt) * 0.4; }
        out.push({ x: c.x, z: c.z, vx, vz, t });
      }
      this._cops = out;
      const k = this.cfg.copPredictS;
      return out.map(c => ({ x: c.x + c.vx * k, z: c.z + c.vz * k, nowX: c.x, nowZ: c.z }));
    }

    chooseGoal(car, cops) {
      const cfg = this.cfg, g = this.grid, t = this._t || 0;
      const v = this.vel, sp = v ? Math.hypot(v.x, v.z) : 0;
      const hx = sp > 1 ? v.x / sp : this.prevFwd ? this.prevFwd.x : 0, hz = sp > 1 ? v.z / sp : this.prevFwd ? this.prevFwd.z : 1;
      const copDist = (x, z) => { let m = 1e9; for (const c of cops || []) m = Math.min(m, Math.hypot(x - c.x, z - c.z), Math.hypot(x - c.nowX, z - c.nowZ)); return m; };

      // ---- money: old behaviour, always hunt the best bag
      if (cfg.priority === 'money') {
        let best = null, bs = -1e9;
        for (const b of this.bagMem.candidates()) {
          const d = Math.hypot(b.x - car.x, b.z - car.z), dc = copDist(b.x, b.z);
          const s = (b.conf * 100) / (d + 25) - (dc < 30 ? (30 - dc) / 20 : 0);
          if (s > bs) { bs = s; best = b; }
        }
        if (best && bs > 0.25) return { x: best.x, z: best.z, kind: 'bag', bag: best };
      }

      // ---- pro: grab a bag only if it is close, ahead, safe and we're not in danger
      if (cfg.priority !== 'money') {
        const nearestCop = copDist(car.x, car.z);
        const keep = this.target && this.target.kind === 'bag' && this.target.bag;
        let best = null, bs = -1e9;
        for (const b of this.bagMem.candidates()) {
          if (b._skipUntil && t < b._skipUntil) continue;
          const dx = b.x - car.x, dz = b.z - car.z, d = Math.hypot(dx, dz);
          const ang = Math.acos(clamp((dx * hx + dz * hz) / (d + 1e-6), -1, 1));
          const dc = copDist(b.x, b.z);
          const committed = keep === b;
          const ok = d < cfg.bagDetourMax * (committed ? 1.3 : 1) && (ang < cfg.bagAngleMax * (committed ? 1.8 : 1) || d < 10) && dc > cfg.bagSafeCopDist && nearestCop > 14;
          if (!ok) { if (committed) b._skipUntil = t + 8000; continue; }   // pass it and keep going
          const s = b.conf * (1 - d / 80) - ang * 0.3;
          if (s > bs) { bs = s; best = b; }
        }
        if (best) return { x: best.x, z: best.z, kind: 'bag', bag: best };
      }

      // ---- survive: keep moving toward open road, away from where cops will be, without big turns
      let eb = null, es = -1e9;
      const here = copDist(car.x, car.z);
      for (const R of [45, 75]) for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a), x = car.x + dx * R, z = car.z + dz * R;
        const [gx, gz] = g.toCell(x, z), c = g.cost(gx, gz);
        if (!c || c >= 12) continue;                                  // unknown/blocked/water: not a plan
        let s = 0;
        s += 4 * g.openness(gx, gz);                                  // room to dodge
        s -= c * 0.4;
        const dc = copDist(x, z); s += (Math.min(90, dc) - Math.min(90, here)) * cfg.escCopW;  // gain distance from cops
        for (const cp of cops || []) {                                // don't drive into a cop's path
          const cx = cp.x - car.x, cz = cp.z - car.z, cd = Math.hypot(cx, cz) + 1e-6;
          const toward = (cx * dx + cz * dz) / cd; if (toward > 0.5 && cd < R + 10) s -= 4 * toward * (1 - cd / (R + 30));
        }
        const align = dx * hx + dz * hz;                              // keep momentum: pros don't U-turn
        s += cfg.escMomentum * align + (align < -0.3 ? -cfg.escMomentum * 1.2 : 0);
        if (this.target && this.target.kind === 'escape') {           // stick with the current plan unless much better
          if (Math.hypot(x - this.target.x, z - this.target.z) < 20) s += 1.2;
        }
        if (s > es) { es = s; eb = { x, z, kind: 'escape' }; }
      }
      return eb;
    }

    /*
     * input:
     *   now          ms timestamp (performance.now())
     *   features     the 31-number array the existing bot builds (v3 format)
     *   car          { x, z, heading? }  world position (heading only used until the car moves)
     *   cops         [{x,z}]  (optional)
     *   visibleBags  [{x,z}] bags currently visible, or null if unknown
     *   humanSteer   -1/0/1 when the player is driving (records demos), else null
     *   collected    true on the frame a bag was picked up (optional)
     */
    tick(inp) {
      const t0 = now(), cfg = this.cfg, t = inp.now ?? t0, car = inp.car;
      // motion & steering calibration (works with any heading convention)
      let fwd = null;
      const rev = (this.lastThrottle || 1) < 0;
      if (this.prev && car) {
        const dt = Math.max(1, t - this.prev.t), vx = (car.x - this.prev.x) / dt * 1000, vz = (car.z - this.prev.z) / dt * 1000;
        const sp = Math.hypot(vx, vz);
        this.speed = this.speed == null ? sp : this.speed * 0.7 + sp * 0.3;
        if (sp > 0.4) {
          const dir = rev ? -1 : 1, fx = dir * vx / sp, fz = dir * vz / sp; // car's nose direction
          if (sp > 2 && !rev) {
            this.vel = { x: vx, z: vz };
            if (this.prevFwd) {
              const turn = this.prevFwd.x * fz - this.prevFwd.z * fx; // + = turning one way
              const st = inp.humanSteer ?? this.lastAction ?? 0;
              if (st) {
                this._cal += st * turn; this._calN++; if (this._calN > 30) this.steerSign = this._cal >= 0 ? 1 : -1;
                if (Math.abs(st) > 0.3) { const yr = Math.abs(Math.asin(clamp(turn, -1, 1))) / (dt / 1000) / Math.abs(st); this.yawRate = (this.yawRate || 2) * 0.97 + Math.min(6, yr) * 0.03; }
              }
            }
            // learn which way the game's heading angle points, so it can be trusted when slow
            if (car.heading != null) this._calHeading(car.heading, fx, fz);
          }
          fwd = this.prevFwd = { x: fx, z: fz };
        }
      }
      if (car && car.heading != null && this._hdg && this._hdg.n > 20 && (!fwd || (this.speed || 0) < 3)) fwd = this._headingFwd(car.heading);
      if (!fwd && this.prevFwd) fwd = this.prevFwd;
      if (!fwd && car && car.heading != null) fwd = { x: Math.sin(car.heading), z: Math.cos(car.heading) };
      if (car) this.prev = { t, x: car.x, z: car.z };

      // bags
      if (car) {
        this.bagMem.observe(inp.visibleBags || null, t, car);
        if (inp.collected) this.bagMem.collected(car, t);
      }

      // learned policy
      const f = inp.features;
      if (f && (!this._fHist || t - this._fHist.t >= cfg.sampleEveryMs)) { this._pf = this._fHist ? this._fHist.f : null; this._fHist = { t, f: Array.from(f) }; }
      const p = f ? this.learner.policy(f, this._pf) : [0, 1, 0];
      let polSteer = p[2] - p[0];

      // route
      let routeSteer = null;
      if (car) this._predCops = this.trackCops(t, inp.cops);
      if (car) {
        const budget = cfg.plannerShareMs;
        if (!this.planner.job && t - this.lastPlan > cfg.replanEveryMs) {
          this._t = t;
          this.target = this.chooseGoal(car, this._predCops || []);
          if (this.target) this.planner.start(car, this.target, this._predCops || []);
          this.lastPlan = t;
        }
        const tp = now(); this.planner.step(budget); this.perf.planMs = now() - tp;
        const la = this.planner.lookahead(car, cfg.lookahead + Math.min(14, (this.speed || 0) * 0.5)); // look further ahead when fast
        if (la && fwd) {
          const dx = la.x - car.x, dz = la.z - car.z, d = Math.hypot(dx, dz) + 1e-6;
          const cross = fwd.x * (dz / d) - fwd.z * (dx / d), dot = fwd.x * dx / d + fwd.z * dz / d;
          const ang = Math.atan2(cross, dot);
          routeSteer = clamp(ang * cfg.steerGain, -1, 1) * this.steerSign;
        }
      }

      // combine: policy knows about cars/cops/walls right now, route knows where to go
      let steer;
      if (routeSteer === null) { steer = polSteer; this.mode = 'policy'; }
      else {
        const conf = Math.max(p[0], p[1], p[2]);              // confident policy (e.g. dodging) wins
        const front = f ? Math.min(f[5], f[6], f[7]) : 1;     // close wall ahead -> trust the policy more
        const rw = cfg.routeW * clamp(front * 1.4, 0.15, 1) * (1.2 - conf);
        const iw = cfg.imitW * conf;
        steer = (iw * polSteer + rw * routeSteer) / (iw + rw);
        this.mode = this.target ? this.target.kind : 'route';
      }
      this.out = this.out * cfg.smooth + steer * (1 - cfg.smooth);

      // ---- getting unstuck / out of water (only when the bot is driving)
      let throttle = 1;
      const rec = inp.humanSteer == null && car ? this.recover(t, car, fwd, inp) : null;
      if (rec) { this.out = rec.steer; throttle = rec.throttle; this.mode = rec.mode; }
      this.lastThrottle = inp.humanSteer == null ? throttle : (inp.humanThrottle ?? 1);

      this.braking = false;
      if (!rec && inp.humanSteer == null && car && fwd && cfg.safety) { this.out = this.safetyFilter(car, fwd, this.out); if (this.braking) throttle = 0; }
      const action = this.out > 0.33 ? 1 : this.out < -0.33 ? -1 : 0;
      this.lastAction = inp.humanSteer ?? this.out;

      // record training data (recovery moves are tagged and never learned)
      if (f) {
        if (inp.humanSteer != null) this.learner.record(t, f, inp.humanSteer, true);
        else this.learner.record(t, f, action, false, !!rec);
      }

      // spend what is left of the frame budget on learning
      const used = now() - t0;
      this.perf.trainMs = this.learner.trainTick(Math.max(0, cfg.frameBudgetMs - used));
      const ms = now() - t0;
      this.perf.frameMs = this.perf.frameMs * 0.9 + ms * 0.1; this.perf.maxMs = Math.max(this.perf.maxMs * 0.995, ms);
      return { steer: clamp(this.out, -1, 1), action, throttle, mode: this.mode, target: this.target, path: this.planner.path, probs: [p[0], p[1], p[2]] };
    }

    /*
     * Look before you leap: roll each steering option ~1 s forward on the map and
     * refuse ones that hit a wall or drive into a cop, keeping as close as possible
     * to what the route/policy wanted.
     */
    safetyFilter(car, fwd, want) {
      const cfg = this.cfg, g = this.grid, sp = Math.max(6, this.speed || 0), yr = this.yawRate || 2;
      const cops = this._cops || [], T = cfg.safetyHorizon, N = 12, dt = T / N;
      const h0 = Math.atan2(fwd.x, fwd.z);
      const roll = (st, brake) => {
        let x = car.x, z = car.z, h = h0, risk = 0, v = sp;
        // steerSign maps "+steer" to "+turn" (cross>0); +cross means heading angle atan2(x,z) decreases
        const dh = -this.steerSign * st * yr * dt;
        for (let i = 1; i <= N; i++) {
          if (brake) v = Math.max(sp * 0.25, v - cfg.brakeDecel * dt);
          h += dh * (brake ? Math.max(0.6, v / sp) : 1); x += Math.sin(h) * v * dt; z += Math.cos(h) * v * dt;
          const w = Math.max(g.fine(x, z), g.fine(x + Math.cos(h) * 1.2, z - Math.sin(h) * 1.2), g.fine(x - Math.cos(h) * 1.2, z + Math.sin(h) * 1.2));
          const [gx, gz] = g.toCell(x, z), rc = g.raw(gx, gz);
          const wall = !rc ? 1 : rc >= 12 ? Math.max(w, 0.7) : w;   // off the explored map = risky
          const early = (N - i + 1) / N;                       // hitting something sooner is worse
          if (wall >= 1) { risk += 10 * early; break; }
          risk += wall * 0.8 * early;
          for (const c of cops) { const cx = c.x + c.vx * i * dt, cz = c.z + c.vz * i * dt, d = Math.hypot(cx - x, cz - z); if (d < 5) risk += (5 - d) * early; }
        }
        return risk;
      };
      const opts = [want, -1, -0.5, 0, 0.5, 1];
      let best = want, bs = 1e9, brake = false;
      for (const o of opts) { const sc = roll(o, false) * 3 + Math.abs(o - want); if (sc < bs) { bs = sc; best = o; } }
      if (bs > 2) {   // every full-speed line is risky: brake into the turn (slower, but alive)
        let bb = best, bbs = 1e9;
        for (const o of opts) { const sc = roll(o, true) * 3 + Math.abs(o - want); if (sc < bbs) { bbs = sc; bb = o; } }
        if (bbs + 1.5 < bs || bs > 12) { best = bb; bs = bbs; brake = true; }  // boxed in: always brake
      }
      this.lastRisk = bs; this.braking = brake;
      return best;
    }

    _headingFwd(h) {
      const k = this._hdg.best, c = Math.cos(h), sn = Math.sin(h);
      return [{ x: sn, z: c }, { x: c, z: sn }, { x: -sn, z: c }, { x: c, z: -sn }, { x: -sn, z: -c }, { x: -c, z: -sn }, { x: sn, z: -c }, { x: -c, z: sn }][k];
    }
    _calHeading(h, fx, fz) {
      const H = this._hdg || (this._hdg = { score: new Float64Array(8), n: 0, best: 0 });
      for (let k = 0; k < 8; k++) { H.best = k; const v = this._headingFwd(h); H.score[k] += v.x * fx + v.z * fz; }
      H.n++; let bk = 0; for (let k = 1; k < 8; k++) if (H.score[k] > H.score[bk]) bk = k; H.best = bk;
    }

    /*
     * Stuck / water recovery.
     *  - inp.inWater = true if the bot script can tell the car is in water (best),
     *    otherwise "stuck" is detected from the car barely moving while driving.
     *  - Phase 1 "reverse": back up with the wheel turned so the nose swings toward land.
     *  - Phase 2 "to land": drive at the nearest known road that isn't water.
     *  - Water spots are remembered on the map so routes avoid them next time.
     */
    recover(t, car, fwd, inp) {
      const cfg = this.cfg, R = this.rec || (this.rec = { phase: null, tries: 0 });
      const speed = this.speed || 0, inWater = !!inp.inWater;
      if (speed > cfg.stuckSpeed * 2) this._lastMoveT = t;
      if (inWater) this.grid.markWater(car.x, car.z);
      // remember the last place we were driving normally on dry road
      if (!inWater && !R.phase && speed > cfg.stuckSpeed * 2) {
        this._started = true;
        const h = this._trail || (this._trail = []);
        if (!h.length || Math.hypot(h[h.length - 1].x - car.x, h[h.length - 1].z - car.z) > 3) { h.push({ x: car.x, z: car.z }); if (h.length > 12) h.shift(); }
      }
      const slow = this._started && (!this._lastMoveT || t - this._lastMoveT > cfg.stuckMs);

      const angTo = (P, m) => { // angle from direction m to point P
        const dx = P.x - car.x, dz = P.z - car.z, d = Math.hypot(dx, dz) + 1e-6;
        return Math.atan2(m.x * dz / d - m.z * dx / d, m.x * dx / d + m.z * dz / d);
      };
      const pickTarget = () => {
        // a dry spot we drove over 6-20 units ago is the safest way out; else nearest known road
        const h = this._trail || [];
        for (let i = h.length - 1; i >= 0; i--) { const d = Math.hypot(h[i].x - car.x, h[i].z - car.z); if (d > 6 && d < 40) return h[i]; }
        return this.grid.nearestLand(car.x, car.z, cfg.landSearchCells);
      };

      if (!R.phase) {
        if (!(inWater || slow)) { if (speed > cfg.stuckSpeed * 2) R.tries = 0; return null; }
        R.target = pickTarget(); R.tries++; R.since = t; R.startD = R.target ? Math.hypot(R.target.x - car.x, R.target.z - car.z) : 0;
        // target behind us -> reverse out; otherwise drive forward to it (alternate if retrying)
        const behind = R.target && fwd && Math.abs(angTo(R.target, fwd)) > Math.PI / 2;
        R.phase = (behind || slow) ^ (R.tries % 3 === 0) ? 'reverse' : 'forward';
      }
      const T = R.target;
      const done = !inWater && speed > cfg.stuckSpeed * 2 && t - R.since > 500;
      const arrived = T && Math.hypot(T.x - car.x, T.z - car.z) < 4;
      if (done || arrived) { R.phase = null; this.lastPlan = -1e9; this._lastMoveT = t; return null; }
      const limit = R.phase === 'reverse' ? (inWater ? cfg.escapeMs : cfg.reverseMs) : cfg.escapeMs;
      const progress = T ? R.startD - Math.hypot(T.x - car.x, T.z - car.z) : 0;
      if (t - R.since > limit || (t - R.since > 1500 && progress < 0.5)) {   // not working: switch
        R.phase = R.phase === 'reverse' ? 'forward' : 'reverse'; R.since = t; R.tries++;
        R.target = pickTarget(); R.startD = R.target ? Math.hypot(R.target.x - car.x, R.target.z - car.z) : 0;
      }
      const mode = inWater ? 'water' : 'unstuck';
      if (!T || !fwd) return { steer: R.tries % 2 ? 1 : -1, throttle: R.phase === 'reverse' ? -1 : 1, mode };
      if (R.phase === 'reverse') {
        // point the back of the car at the target; steering works backwards in reverse
        const back = { x: -fwd.x, z: -fwd.z };
        return { steer: -clamp(angTo(T, back) * cfg.steerGain, -1, 1) * this.steerSign, throttle: -1, mode };
      }
      return { steer: clamp(angTo(T, fwd) * cfg.steerGain, -1, 1) * this.steerSign, throttle: 1, mode };
    }

    onRunEnd(run) {
      this._cops = null; this.target = null; this._fHist = null; this._pf = null;
      this.rec = null; this._lastMoveT = null; this._started = false; this.speed = null; this._trail = null; this.lastThrottle = 1;
      const r = { at: Date.now(), dur: run.dur, bags: run.bags || 0, human: !!run.human };
      (this.learner.brain.runs || (this.learner.brain.runs = [])).push(r);
      this.learner.onRunEnd(run);
      const w = this.map.worlds[this.worldKey]; w.runs = (w.runs || 0) + 1;
      this.planner.path = null; this.planner.job = null; this.prev = null; this.prevFwd = null; this.out = 0;
    }

    exportSave() {
      const s = this.save;
      s.saved = new Date().toISOString();
      s.data.erbot_brain_v3 = JSON.stringify(this.learner.save());
      s.data.erbot_map_v1 = JSON.stringify(this.map);
      return JSON.stringify(s);
    }

    // optional minimap: shows explored map, remembered bags and the planned route
    drawOverlay(ctx, car, size = 220, range = 120) {
      if (!ctx || !car) return;
      const sc = size / (2 * range), g = this.grid, step = g.size;
      ctx.save(); ctx.globalAlpha = 0.85; ctx.fillStyle = '#111'; ctx.fillRect(0, 0, size, size);
      for (let z = car.z - range; z < car.z + range; z += step) for (let x = car.x - range; x < car.x + range; x += step) {
        const [gx, gz] = g.toCell(x, z), c = g.cost(gx, gz);
        ctx.fillStyle = c === 0 ? '#a33' : c >= 9 ? '#222' : c >= 12 ? '#181818' : '#2b6';
        ctx.fillRect((x - car.x + range) * sc, (z - car.z + range) * sc, step * sc + 1, step * sc + 1);
      }
      const P = (x, z) => [(x - car.x + range) * sc, (z - car.z + range) * sc];
      const path = this.planner.path;
      if (path) { ctx.strokeStyle = '#ff0'; ctx.lineWidth = 2; ctx.beginPath(); path.forEach((p, i) => { const [a, b] = P(p.x, p.z); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }); ctx.stroke(); }
      for (const b of this.bagMem.bags) {
        if (b.conf <= 0) continue;
        const [a, c] = P(b.x, b.z); if (a < 0 || c < 0 || a > size || c > size) continue;
        ctx.fillStyle = b.exact ? '#fd0' : '#a80'; ctx.beginPath(); ctx.arc(a, c, b.exact ? 4 : 3, 0, 7); ctx.fill();
      }
      ctx.fillStyle = '#4af'; ctx.beginPath(); ctx.arc(size / 2, size / 2, 4, 0, 7); ctx.fill();
      ctx.restore();
    }
  }

  const ERBot4 = { create: o => new Bot(o), Bot, Learner, PolicyNet, MapGrid, Planner, BagMemory, prep, prepMotion, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = ERBot4;
  else root.ERBot4 = ERBot4;
})(typeof window !== 'undefined' ? window : globalThis);

/* ------------------------------------------------------------------ README
How to connect this to the existing bot script:

1. Load this file before the bot script (paste it above the bot's code in the
   userscript, or add another <script>).
2. Where the bot loads its save, create the v4 bot from the same object:
       const bot4 = ERBot4.create({ save: parsedSaveObject });
3. In the bot's per-frame loop, after it builds its 31 features:
       const out = bot4.tick({
         now: performance.now(),
         features,                         // same array it already builds
         car: { x: car.position.x, z: car.position.z },
         cops: cops.map(c => ({ x: c.position.x, z: c.position.z })),
         visibleBags: bagsInView.map(b => ({ x: b.position.x, z: b.position.z })),
         humanSteer: playerIsDriving ? playerSteer : null,
         collected: justPickedUpBag,
         inWater: carIsInWater,            // best if the game tells you; if not, leave it out
                                           // (it still detects being stuck from speed)
       });
       // steering: out.action (-1/0/1) or out.steer (-1..1)
       // gas:      out.throttle  (1 = gas, 0 = brake/let go for a tight turn, -1 = reverse to get unstuck)
4. When a run ends:   bot4.onRunEnd({ dur: seconds, bags, human, crashed: true });
5. When saving:       localStorage / export uses bot4.exportSave() (same format).
6. When the bot's mapper changes a chunk: bot4.chunkUpdated("cx,cz").
7. Optional minimap:  bot4.drawOverlay(canvasCtx, { x, z });
--------------------------------------------------------------------------- */
