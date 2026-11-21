/* Escape Road RL brain: a real reinforcement-learning agent.
 *
 *   Policy network  pi(a | s): 60 inputs -> 64 -> 64 -> 6 actions (steer L/straight/R x brake off/on)
 *   Value network   V(s):      60 inputs -> 64 -> 64 -> 1  (expected future reward)
 *
 *   1. Behaviour cloning: starts from your driving and the simulator teacher's lessons.
 *   2. PPO (Proximal Policy Optimization, the algorithm behind many game-playing AIs) in the
 *      simulator: thousands of chases, clipped policy updates, GAE advantages, entropy bonus.
 *   3. AWR (Advantage-Weighted Regression) in the real game: after every run, moves that led to
 *      more reward than the value network expected are made more likely, worse ones less likely.
 *
 * Inputs are the bot's 31 game features plus how they changed in the last ~0.1 s (motion). */
(function (root) {
  'use strict';
  const N_IN = 60, N_ACT = 6;
  // actions: index = steerIndex * 2 + brake, steer u = steerIndex - 1
  const ACT_U = [-1, -1, 0, 0, 1, 1], ACT_B = [0, 1, 0, 1, 0, 1];
  const actionOf = (u, b) => (Math.round(u) + 1) * 2 + (b ? 1 : 0);

  function rng(a) { return () => { a |= 0; a = a + 0x6d2b79f5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  // same layout as the brain's motion inputs: 31 base + 29 changes
  function prep31(f) {
    const x = new Float32Array(31); let k = 0;
    for (let i = 0; i <= 12; i++) x[k++] = f[i];
    x[k++] = Math.sin(f[13]); x[k++] = Math.cos(f[13]); x[k++] = f[14];
    for (let i = 16; i <= 30; i++) x[k++] = f[i];
    return x;
  }
  function inputs(f, pf) {
    const a = prep31(f), b = pf ? prep31(pf) : a, x = new Float32Array(N_IN); x.set(a);
    let k = 31; for (let i = 0; i < 31; i++) { if (i === 13 || i === 14) continue; x[k++] = a[i] - b[i]; }
    return x;
  }
  const jumped = (f, pf) => { let s = 0; for (let i = 0; i < 13; i++) s += Math.abs(f[i] - pf[i]); return s > 4; };

  /* ---------------- a small neural network with Adam ---------------- */
  class MLP {
    constructor(sizes, seed = 1, outScale = 1) {
      this.sizes = sizes; this.L = [];
      const R = rng(seed);
      for (let l = 0; l < sizes.length - 1; l++) {
        const nI = sizes[l], nO = sizes[l + 1], sc = (l === sizes.length - 2 ? outScale : 1) * Math.sqrt(2 / (nI + nO)) * 1.7;
        this.L.push({ nI, nO, W: Float32Array.from({ length: nI * nO }, () => (R() * 2 - 1) * sc), b: new Float32Array(nO) });
      }
      this.t = 0;
    }
    // returns output; fills cache.h[l] (activations) when cache is given
    forward(x, cache) {
      let h = x; if (cache) cache.h = [x];
      for (let l = 0; l < this.L.length; l++) {
        const { nI, nO, W, b } = this.L[l], o = new Float32Array(nO), last = l === this.L.length - 1;
        for (let j = 0; j < nO; j++) { let s = b[j]; for (let i = 0; i < nI; i++) s += h[i] * W[i * nO + j]; o[j] = last ? s : Math.tanh(s); }
        h = o; if (cache) cache.h.push(o);
      }
      return h;
    }
    zeroGrads() { return this.L.map(l => ({ W: new Float32Array(l.W.length), b: new Float32Array(l.b.length) })); }
    backward(cache, dOut, G) {
      let d = dOut;
      for (let l = this.L.length - 1; l >= 0; l--) {
        const { nI, nO, W } = this.L[l], hIn = cache.h[l], g = G[l];
        for (let j = 0; j < nO; j++) g.b[j] += d[j];
        const dIn = l > 0 ? new Float32Array(nI) : null;
        for (let i = 0; i < nI; i++) {
          const hi = hIn[i], row = i * nO; let s = 0;
          for (let j = 0; j < nO; j++) { g.W[row + j] += hi * d[j]; if (dIn) s += W[row + j] * d[j]; }
          if (dIn) dIn[i] = s * (1 - hIn[i] * hIn[i]);   // hIn is a tanh output
        }
        d = dIn;
      }
    }
    adam(G, n, lr, clip = 1.0) {
      if (!this.m) { this.m = this.L.map(l => ({ W: new Float32Array(l.W.length), b: new Float32Array(l.b.length) })); this.v = this.L.map(l => ({ W: new Float32Array(l.W.length), b: new Float32Array(l.b.length) })); }
      // global gradient-norm clipping keeps updates stable
      let sq = 0; for (const g of G) { for (const v of g.W) sq += (v / n) ** 2; for (const v of g.b) sq += (v / n) ** 2; }
      const scale = Math.min(1, clip / (Math.sqrt(sq) + 1e-8)) / n;
      this.t++; const b1 = 0.9, b2 = 0.999, c1 = 1 - b1 ** this.t, c2 = 1 - b2 ** this.t;
      this.L.forEach((layer, l) => {
        for (const k of ['W', 'b']) {
          const p = layer[k], g = G[l][k], m = this.m[l][k], v = this.v[l][k];
          for (let i = 0; i < p.length; i++) { const gi = g[i] * scale; m[i] = b1 * m[i] + (1 - b1) * gi; v[i] = b2 * v[i] + (1 - b2) * gi * gi; p[i] -= lr * (m[i] / c1) / (Math.sqrt(v[i] / c2) + 1e-8); }
        }
      });
    }
    toJSON() { const a = x => Array.from(x, v => Math.round(v * 1e5) / 1e5); return { sizes: this.sizes, L: this.L.map(l => ({ W: a(l.W), b: a(l.b) })) }; }
    static fromJSON(o) { const n = new MLP(o.sizes); o.L.forEach((l, i) => { n.L[i].W = Float32Array.from(l.W); n.L[i].b = Float32Array.from(l.b); }); return n; }
  }
  function softmax(z) { let mx = -1e9; for (const v of z) if (v > mx) mx = v; const p = new Float32Array(z.length); let s = 0; for (let i = 0; i < z.length; i++) { p[i] = Math.exp(z[i] - mx); s += p[i]; } for (let i = 0; i < z.length; i++) p[i] /= s; return p; }

  /* ---------------- the agent ---------------- */
  class Agent {
    constructor(seed = 1) {
      this.pi = new MLP([N_IN, 64, 64, N_ACT], seed, 0.05);
      this.v = new MLP([N_IN, 64, 64, 1], seed + 7, 1);
      this.mean = new Float32Array(N_IN); this.std = new Float32Array(N_IN).fill(1);
      this.hist = [];            // learning curve: { kind, upd, ret, surv, cash }
      this.steps = 0; this.updates = 0; this.games = 0; this.normSet = false;
    }
    setNorm(X) {
      const n = X.length; if (!n) return;
      const m = new Float64Array(N_IN), v = new Float64Array(N_IN);
      for (const x of X) for (let j = 0; j < N_IN; j++) m[j] += x[j];
      for (let j = 0; j < N_IN; j++) m[j] /= n;
      for (const x of X) for (let j = 0; j < N_IN; j++) v[j] += (x[j] - m[j]) ** 2;
      for (let j = 0; j < N_IN; j++) { this.mean[j] = m[j]; this.std[j] = Math.max(0.05, Math.sqrt(v[j] / n)); }
      this.normSet = true;
    }
    norm(x) { const y = new Float32Array(N_IN); for (let j = 0; j < N_IN; j++) y[j] = (x[j] - this.mean[j]) / this.std[j]; return y; }
    obs(f, pf) { return this.norm(inputs(f, pf && !jumped(f, pf) ? pf : null)); }
    probs(o) { return softmax(this.pi.forward(o)); }
    value(o) { return this.v.forward(o)[0]; }
    // steering probabilities for the driving planner: [left, straight, right]
    steerProbs(f, pf) { const p = this.probs(this.obs(f, pf)); return [p[0] + p[1], p[2] + p[3], p[4] + p[5]]; }
    best(f, pf) { const p = this.probs(this.obs(f, pf)); let a = 0; for (let i = 1; i < N_ACT; i++) if (p[i] > p[a]) a = i; return { a, u: ACT_U[a], b: ACT_B[a], p }; }

    /* 1) behaviour cloning from lessons ({f, u, b?, w}); w < 0 = "avoid this action" */
    cloneFrom(samples, passes = 6, onProgress) {
      const data = []; let prev = null;
      for (const s of samples) { if (!s.f || s.f.length !== 31) { prev = null; continue; } data.push({ x: inputs(s.f, prev && !jumped(s.f, prev) ? prev : null), a: actionOf(s.u, s.b), w: s.w }); prev = s.f; }
      if (data.length < 50) return 0;
      if (!this.normSet) this.setNorm(data.map(d => d.x));
      for (const d of data) d.x = this.norm(d.x);
      const R = rng(11); let loss = 0;
      for (let ep = 0; ep < passes; ep++) {
        const idx = Uint32Array.from(data.keys()); for (let i = idx.length - 1; i > 0; i--) { const j = (R() * (i + 1)) | 0; [idx[i], idx[j]] = [idx[j], idx[i]]; }
        for (let s0 = 0; s0 < idx.length; s0 += 128) {
          const G = this.pi.zeroGrads(); let n = 0; loss = 0;
          for (let k = s0; k < Math.min(idx.length, s0 + 128); k++) {
            const d = data[idx[k]], c = {}; const p = softmax(this.pi.forward(d.x, c)), dz = new Float32Array(N_ACT);
            if (d.w >= 0) { for (let i = 0; i < N_ACT; i++) dz[i] = d.w * (p[i] - (i === d.a ? 1 : 0)); loss -= d.w * Math.log(p[d.a] + 1e-7); }
            else { const a = -d.w, q = Math.max(1e-6, 1 - p[d.a]); for (let i = 0; i < N_ACT; i++) dz[i] = a * (p[d.a] / q) * ((i === d.a ? 1 : 0) - p[i]); loss -= a * Math.log(q); }
            this.pi.backward(c, dz, G); n++;
          }
          this.pi.adam(G, n, 1e-3);
        }
        if (onProgress) onProgress(ep + 1, passes, loss);
      }
      this.hist.push({ kind: 'clone', upd: this.updates, n: data.length });
      return data.length;
    }

    /* 2) PPO on a batch of simulator steps */
    ppoUpdate(B, o = {}) {
      const clip = o.clip || 0.2, ent = o.ent ?? 0.01, epochs = o.epochs || 4, mb = o.mb || 256, lr = o.lr || 3e-4, R = rng(this.updates + 3);
      const n = B.obs.length;
      // normalise advantages
      let m = 0; for (const a of B.adv) m += a; m /= n; let v = 0; for (const a of B.adv) v += (a - m) ** 2; const sd = Math.sqrt(v / n) + 1e-8;
      const adv = B.adv.map(a => (a - m) / sd);
      let piLoss = 0, vLoss = 0, clipFrac = 0, cnt = 0;
      for (let e = 0; e < epochs; e++) {
        const idx = Uint32Array.from({ length: n }, (_, i) => i); for (let i = n - 1; i > 0; i--) { const j = (R() * (i + 1)) | 0; [idx[i], idx[j]] = [idx[j], idx[i]]; }
        for (let s0 = 0; s0 < n; s0 += mb) {
          const Gp = this.pi.zeroGrads(), Gv = this.v.zeroGrads(); let k = 0;
          for (let t = s0; t < Math.min(n, s0 + mb); t++) {
            const i = idx[t], x = B.obs[i], a = B.act[i], A = adv[i];
            const cp = {}, p = softmax(this.pi.forward(x, cp));
            const ratio = p[a] / Math.exp(B.logp[i]);
            const clipped = (A > 0 && ratio > 1 + clip) || (A < 0 && ratio < 1 - clip);
            const dz = new Float32Array(N_ACT);
            if (!clipped) for (let j = 0; j < N_ACT; j++) dz[j] = -A * ratio * ((j === a ? 1 : 0) - p[j]); else clipFrac++;
            let H = 0; for (let j = 0; j < N_ACT; j++) H -= p[j] * Math.log(p[j] + 1e-8);
            for (let j = 0; j < N_ACT; j++) dz[j] += ent * p[j] * (Math.log(p[j] + 1e-8) + H);   // entropy bonus keeps it exploring
            this.pi.backward(cp, dz, Gp);
            piLoss -= Math.min(ratio * A, Math.max(1 - clip, Math.min(1 + clip, ratio)) * A);
            const cv = {}, val = this.v.forward(x, cv)[0], dv = val - B.ret[i];
            vLoss += 0.5 * dv * dv; this.v.backward(cv, new Float32Array([dv]), Gv);
            k++; cnt++;
          }
          this.pi.adam(Gp, k, lr, 0.5); this.v.adam(Gv, k, lr * 3, 5);
        }
      }
      this.updates++;
      return { piLoss: piLoss / cnt, vLoss: vLoss / cnt, clipFrac: clipFrac / cnt };
    }

    /* 3) AWR on real-game runs: [{ f, pf, u, b, ret }] (ret = discounted reward that followed) */
    awrUpdate(D, o = {}) {
      if (D.length < 20) return null;
      const beta = o.beta || 2, passes = o.passes || 3, lr = o.lr || 1e-4;
      const X = D.map(d => this.obs(d.f, d.pf));
      for (let e = 0; e < passes; e++) {
        // value first, then policy weighted by how much better than expected each move was
        const Gv = this.v.zeroGrads(), Gp = this.pi.zeroGrads(); let wsum = 0;
        for (let i = 0; i < D.length; i++) {
          const cv = {}, val = this.v.forward(X[i], cv)[0]; this.v.backward(cv, new Float32Array([val - D[i].ret]), Gv);
          const w = Math.min(20, Math.exp((D[i].ret - val) / beta)); wsum += w;
          const a = actionOf(D[i].u, D[i].b), cp = {}, p = softmax(this.pi.forward(X[i], cp)), dz = new Float32Array(N_ACT);
          for (let j = 0; j < N_ACT; j++) dz[j] = w * (p[j] - (j === a ? 1 : 0));
          this.pi.backward(cp, dz, Gp);
        }
        this.v.adam(Gv, D.length, lr * 3, 5); this.pi.adam(Gp, wsum || 1, lr, 0.5);
      }
      this.games++;
      return { n: D.length };
    }

    toJSON() { const a = x => Array.from(x, v => Math.round(v * 1e5) / 1e5); return { v: 1, pi: this.pi.toJSON(), vf: this.v.toJSON(), mean: a(this.mean), std: a(this.std), hist: this.hist.slice(-300), steps: this.steps, updates: this.updates, games: this.games }; }
    static fromJSON(o) {
      const ag = new Agent(); ag.pi = MLP.fromJSON(o.pi); ag.v = MLP.fromJSON(o.vf);
      ag.mean = Float32Array.from(o.mean); ag.std = Float32Array.from(o.std); ag.normSet = true;
      ag.hist = o.hist || []; ag.steps = o.steps || 0; ag.updates = o.updates || 0; ag.games = o.games || 0; return ag;
    }
  }

  /* ---------------- PPO training loop on the simulator ----------------
   * env: { reset(seed) -> ep with ep.obs/ep.prevF, step(ep, a) -> { r, done, timeUp } } */
  function collect(agent, env, nEnvs, T, seedBase, gamma = 0.99, lam = 0.95) {
    const R = rng(seedBase * 31 + 1);
    const B = { obs: [], act: [], logp: [], adv: [], ret: [] }, finished = [];
    for (let e = 0; e < nEnvs; e++) {
      let ep = env.reset(seedBase + e * 101);
      const traj = { o: [], a: [], lp: [], r: [], v: [], d: [] };
      let epRet = 0;
      for (let t = 0; t < T; t++) {
        const o = agent.obs(ep.obs, ep.prevF), p = agent.probs(o), v = agent.value(o);
        let u = R(), a = 0; for (; a < N_ACT - 1; a++) { u -= p[a]; if (u <= 0) break; }
        const s = env.step(ep, a); epRet += s.r;
        traj.o.push(o); traj.a.push(a); traj.lp.push(Math.log(p[a] + 1e-8)); traj.r.push(s.r); traj.v.push(v);
        // time running out is not a failure: keep its value (bootstrap)
        traj.d.push(s.done && !s.timeUp ? 1 : 0);
        if (s.done) {
          if (s.timeUp) traj.v.push(agent.value(agent.obs(ep.obs, ep.prevF))); else traj.v.push(0);
          finished.push({ ret: epRet, surv: ep.t, cash: ep.got, why: ep.done });
          pushTraj(B, traj, gamma, lam); traj.o = []; traj.a = []; traj.lp = []; traj.r = []; traj.v = []; traj.d = []; epRet = 0;
          ep = env.reset(seedBase + e * 101 + t + 7);
        }
      }
      if (traj.o.length) { traj.v.push(agent.value(agent.obs(ep.obs, ep.prevF))); pushTraj(B, traj, gamma, lam); }
    }
    agent.steps += nEnvs * T;
    return { B, finished };
  }
  function pushTraj(B, tr, gamma, lam) {
    const n = tr.r.length; let gae = 0; const adv = new Array(n);
    for (let t = n - 1; t >= 0; t--) {
      const next = tr.d[t] ? 0 : tr.v[t + 1];
      const delta = tr.r[t] + gamma * next - tr.v[t];
      gae = delta + gamma * lam * (tr.d[t] ? 0 : gae); adv[t] = gae;
    }
    for (let t = 0; t < n; t++) { B.obs.push(tr.o[t]); B.act.push(tr.a[t]); B.logp.push(tr.lp[t]); B.adv.push(adv[t]); B.ret.push(adv[t] + tr.v[t]); }
  }

  root.ERRL = { Agent, MLP, collect, inputs, actionOf, ACT_U, ACT_B, N_IN, N_ACT };
})(typeof window !== 'undefined' ? window : globalThis);
