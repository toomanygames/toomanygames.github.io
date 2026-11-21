window.ERBOT_VERSION = '1.7.1';
/*
 * Escape Road 3 autopilot
 * ------------------------------------------------------------
 * Runs inside the game page (https://gamea.azgame.io/escape-road-3/, loaded top-level).
 * It does not use screenshots: it hooks the game's WebGL calls to read
 *   - the camera matrix and the camera depth buffer  -> a 3D height map of the world,
 *   - every moving object's transform               -> your car, cops and traffic,
 * then plans a steering path many times per second and presses A / D.
 *
 * Paste into the console of the game page (or inject it) once the game has loaded.
 * Controls: window.ERBot.start() / ERBot.stop() / ERBot.toggleHud()
 */
(function(){
'use strict';
// Re-installing replaces a previous copy cleanly.
const prev = window.ERBot;
if (prev && prev.shutdown) { try { prev.shutdown(); } catch (e) {} }
else if (prev && prev.stop) { try { prev.stop(); } catch (e) {} }
for (const el of document.querySelectorAll('div')) if (/^ERBot /.test(el.textContent || '') && el.style.position === 'fixed') el.remove();
const B = window.ERBot = {};
B.installed = true; B.alive = true; B.version = 2;
const uc = B.uc = document.getElementById('unity-canvas') || document.querySelector('canvas');
const gl = B.gl = uc.getContext('webgl2');
const P = WebGL2RenderingContext.prototype;
const isNative = f => /\[native code\]/.test(Function.prototype.toString.call(f));
// a native setTimeout / requestAnimationFrame, even if some other script wrapped them
let nativeWin = window;
if (!isNative(window.setTimeout) || !isNative(window.requestAnimationFrame)) {
  const ifr = document.createElement('iframe'); ifr.style.display = 'none'; document.body.appendChild(ifr); nativeWin = ifr.contentWindow;
}
const origST = B.origST = window.__erbST || (window.__erbST = isNative(window.setTimeout) ? window.setTimeout.bind(window) : nativeWin.setTimeout.bind(nativeWin));
const realRaf = window.__erbRaf || (window.__erbRaf = isNative(window.requestAnimationFrame) ? window.requestAnimationFrame.bind(window) : nativeWin.requestAnimationFrame.bind(nativeWin));
const sleep = B.sleep = ms => new Promise(r => origST(r, ms));

/* ---------- 1. Frame pacing: keep the game at full speed even when the window is not in front ---------- */
B.frames = 0; B.rafQ = []; B.rafId = 1e6;
if (prev && prev.rafQ) { B.rafQ = prev.rafQ; prev.rafQ = []; }   // take over the game's pending frame callback
let lastTick = 0;
function runQ(){
  if (!B.rafQ.length) return;
  const now = performance.now(); if (now - lastTick < 12 || now - (B._lastRun || 0) < 12) return; lastTick = now; B._lastRun = now;
  const q = B.rafQ; B.rafQ = [];
  for (const [, cb] of q) { try { cb(now); } catch (e) { B.err = String(e); } }
  B.frames++;
}
window.requestAnimationFrame = function(cb){ const id = B.rafId++; B.rafQ.push([id, cb]); return id; };
window.cancelAnimationFrame = function(id){ B.rafQ = B.rafQ.filter(x => x[0] !== id); };
(function timerLoop(){ if (!B.alive) return; origST(timerLoop, 16); runQ(); })();
(function rafLoop(){ if (!B.alive) return; realRaf(rafLoop); runQ(); })();

/* ---------- 1b. Keep the game running when the page loses focus (it pauses itself on blur) ---------- */
B.keepFocus = true;
const blockEv = e => { if (B.alive && B.keepFocus) e.stopImmediatePropagation(); };
window.addEventListener('blur', blockEv, true);
document.addEventListener('visibilitychange', blockEv, true);
(function focusLoop(){ if (!B.alive) return; if (B.keepFocus && !document.hasFocus()) window.dispatchEvent(new FocusEvent('focus')); origST(focusLoop, 1000); })();

/* ---------- 2. Mute ---------- */
B.audioCtxs = new Set(); B.muted = true;
for (const m of ['createBufferSource','createGain','createPanner','createOscillator']) {
  const o = BaseAudioContext.prototype[m]; if (!o || o.__erb) continue;
  const w = function(...a){ const E = window.ERBot; if (E && E.audioCtxs) { E.audioCtxs.add(this); if (E.muted && this.state === 'running') this.suspend(); } return o.apply(this, a); };
  w.__erb = true; BaseAudioContext.prototype[m] = w;
}
{ const r = AudioContext.prototype.resume; if (!r.__erb) { const w = function(){ const E = window.ERBot; return E && E.muted ? Promise.resolve() : r.apply(this); }; w.__erb = true; AudioContext.prototype.resume = w; } }
if (prev && prev.audioCtxs) for (const c of prev.audioCtxs) B.audioCtxs.add(c);
(function muteLoop(){ if (!B.alive) return; if (B.muted) for (const c of B.audioCtxs) if (c.state === 'running') c.suspend(); origST(muteLoop, 500); })();

/* ---------- 3. Input ---------- */
const KC = { a:65, d:68, ArrowLeft:37, ArrowRight:39, ' ':32, Escape:27 };
B.keyEv = (type, key) => {
  const code = key.startsWith('Arrow') ? key : key === ' ' ? 'Space' : key === 'Escape' ? 'Escape' : 'Key' + key.toUpperCase();
  window.dispatchEvent(new KeyboardEvent(type, { key, code, keyCode: KC[key], which: KC[key], bubbles: true, cancelable: true }));
};
B.keysDown = {};
B.press = k => { if (!B.keysDown[k]) { B.keysDown[k] = 1; B.keyEv('keydown', k); } };
B.release = k => { if (B.keysDown[k]) { delete B.keysDown[k]; B.keyEv('keyup', k); } };
B.releaseAll = () => { for (const k of Object.keys(B.keysDown)) B.release(k); };
B.tap = async (k, ms = 80) => { B.press(k); await sleep(ms); B.release(k); };
B.steer = u => { // u: -1 = A, 0 = none, +1 = D
  if (u < 0) { B.release('d'); B.press('a'); }
  else if (u > 0) { B.release('a'); B.press('d'); }
  else { B.release('a'); B.release('d'); }
  B.u = u;
};
B.click = async (x, y) => {
  const o = { clientX:x, clientY:y, screenX:x, screenY:y, bubbles:true, cancelable:true, button:0, buttons:1, pointerId:1, pointerType:'mouse', isPrimary:true, view:window };
  uc.dispatchEvent(new PointerEvent('pointermove', o)); uc.dispatchEvent(new MouseEvent('mousemove', o));
  await sleep(60);
  uc.dispatchEvent(new PointerEvent('pointerdown', o)); uc.dispatchEvent(new MouseEvent('mousedown', o));
  await sleep(120);
  const o2 = { ...o, buttons:0 };
  uc.dispatchEvent(new PointerEvent('pointerup', o2)); uc.dispatchEvent(new MouseEvent('mouseup', o2)); uc.dispatchEvent(new MouseEvent('click', o2));
};

/* ---------- 4. WebGL capture ---------- */
const ids = new WeakMap(); let nid = 1;
const idOf = o => { if (!o) return 0; let v = ids.get(o); if (!v) { v = nid++; ids.set(o, v); } return v; };
const st = B.st = { fb:0, ebo:0 };
const fbObj = {};
B.passVP = {};
B.cur = { objs: [], pendM: null };
B.draws = 0; B.mframes = 0;
let pending = false;
function afterDraw(){ if (!pending) { pending = true; queueMicrotask(() => { pending = false; B.mframes++; try { onFrame(); } catch (e) { B.err = 'frame:' + e.stack; } }); } }

const isOrthoVP = m => Math.abs(m[3])<1e-5 && Math.abs(m[7])<1e-5 && Math.abs(m[11])<1e-5 && Math.abs(m[15]-1)<1e-4 &&
  Math.max(Math.abs(m[2]),Math.abs(m[6]),Math.abs(m[10])) < 0.01 &&
  Math.max(Math.abs(m[0]),Math.abs(m[1]),Math.abs(m[4]),Math.abs(m[5]),Math.abs(m[8]),Math.abs(m[9])) < 0.3 && Math.abs(m[5]) > 1e-4;
const isAffine = m => Math.abs(m[3])<1e-5 && Math.abs(m[7])<1e-5 && Math.abs(m[11])<1e-5 && Math.abs(m[15]-1)<1e-4;

// framebuffer classification: the camera depth pre-pass renders into a canvas-sized FBO with a depth texture
const camFbCache = {}, depthTexCache = {};
function isCamDepthFb(id){
  if (id in camFbCache) return camFbCache[id];
  const f = fbObj[id]; let ok = false, tex = null;
  if (f) {
    const pd = P.getParameter.call(gl, gl.DRAW_FRAMEBUFFER_BINDING);
    P.bindFramebuffer.call(gl, gl.DRAW_FRAMEBUFFER, f);
    const dty = P.getFramebufferAttachmentParameter.call(gl, gl.DRAW_FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE);
    const cty = P.getFramebufferAttachmentParameter.call(gl, gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE);
    if (dty === gl.TEXTURE && cty === gl.RENDERBUFFER) {
      tex = P.getFramebufferAttachmentParameter.call(gl, gl.DRAW_FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME);
      const rb = P.getFramebufferAttachmentParameter.call(gl, gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME);
      const prb = P.getParameter.call(gl, gl.RENDERBUFFER_BINDING);
      P.bindRenderbuffer.call(gl, gl.RENDERBUFFER, rb);
      const w = P.getRenderbufferParameter.call(gl, gl.RENDERBUFFER, gl.RENDERBUFFER_WIDTH), h = P.getRenderbufferParameter.call(gl, gl.RENDERBUFFER, gl.RENDERBUFFER_HEIGHT);
      P.bindRenderbuffer.call(gl, gl.RENDERBUFFER, prb);
      ok = (w === uc.width && h === uc.height);
    }
    P.bindFramebuffer.call(gl, gl.DRAW_FRAMEBUFFER, pd);
  }
  camFbCache[id] = ok; depthTexCache[id] = tex; return ok;
}
// canvas resize invalidates the cache
let lastCW = uc.width, lastCH = uc.height;

// depth readback
const DW = B.DW = 240, DH = B.DH = 150;
function mkShader(type, src){ const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
const dprog = gl.createProgram();
gl.attachShader(dprog, mkShader(gl.VERTEX_SHADER, `#version 300 es
out vec2 uv; void main(){ vec2 p=vec2((gl_VertexID<<1)&2, gl_VertexID&2); uv=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0);}`));
gl.attachShader(dprog, mkShader(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float; precision highp sampler2D; in vec2 uv; uniform sampler2D dtex; out vec4 o;
void main(){ float d=texture(dtex,uv).r; float v=floor(d*65535.0+0.5); o=vec4(floor(v/256.0)/255.0, mod(v,256.0)/255.0, 0.0, 1.0);}`));
P.linkProgram.call(gl, dprog);
if (!gl.getProgramParameter(dprog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(dprog));
const dloc = P.getUniformLocation.call(gl, dprog, 'dtex');
const dvao = P.createVertexArray.call(gl);
const dtexOut = P.createTexture.call(gl);
const dfb = P.createFramebuffer.call(gl);
const dsamp = P.createSampler.call(gl);
P.samplerParameteri.call(gl, dsamp, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
P.samplerParameteri.call(gl, dsamp, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
P.samplerParameteri.call(gl, dsamp, gl.TEXTURE_COMPARE_MODE, gl.NONE);
const dpix = new Uint8Array(DW*DH*4);
B.depth = new Float32Array(DW*DH);
{
  const at = P.getParameter.call(gl, gl.ACTIVE_TEXTURE);
  P.activeTexture.call(gl, gl.TEXTURE0 + 15);
  const pt = P.getParameter.call(gl, gl.TEXTURE_BINDING_2D);
  P.bindTexture.call(gl, gl.TEXTURE_2D, dtexOut);
  P.texImage2D.call(gl, gl.TEXTURE_2D, 0, gl.RGBA8, DW, DH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  P.texParameteri.call(gl, gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  P.texParameteri.call(gl, gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  P.bindTexture.call(gl, gl.TEXTURE_2D, pt);
  P.activeTexture.call(gl, at);
  const pf = P.getParameter.call(gl, gl.DRAW_FRAMEBUFFER_BINDING), rf = P.getParameter.call(gl, gl.READ_FRAMEBUFFER_BINDING);
  P.bindFramebuffer.call(gl, gl.FRAMEBUFFER, dfb);
  P.framebufferTexture2D.call(gl, gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dtexOut, 0);
  P.bindFramebuffer.call(gl, gl.DRAW_FRAMEBUFFER, pf); P.bindFramebuffer.call(gl, gl.READ_FRAMEBUFFER, rf);
}
const CAPS = [gl.BLEND, gl.CULL_FACE, gl.DEPTH_TEST, gl.SCISSOR_TEST, gl.STENCIL_TEST, gl.POLYGON_OFFSET_FILL, gl.SAMPLE_ALPHA_TO_COVERAGE, gl.RASTERIZER_DISCARD];
function readDepth(tex){
  const capv = CAPS.map(c => P.isEnabled.call(gl, c));
  const s = {
    prog: P.getParameter.call(gl, gl.CURRENT_PROGRAM), vao: P.getParameter.call(gl, gl.VERTEX_ARRAY_BINDING),
    df: P.getParameter.call(gl, gl.DRAW_FRAMEBUFFER_BINDING), rf: P.getParameter.call(gl, gl.READ_FRAMEBUFFER_BINDING),
    at: P.getParameter.call(gl, gl.ACTIVE_TEXTURE), vp: P.getParameter.call(gl, gl.VIEWPORT),
    cm: P.getParameter.call(gl, gl.COLOR_WRITEMASK), dm: P.getParameter.call(gl, gl.DEPTH_WRITEMASK),
    ppb: P.getParameter.call(gl, gl.PIXEL_PACK_BUFFER_BINDING), pa: P.getParameter.call(gl, gl.PACK_ALIGNMENT),
  };
  P.activeTexture.call(gl, gl.TEXTURE0 + 15);
  const t15 = P.getParameter.call(gl, gl.TEXTURE_BINDING_2D), s15 = P.getParameter.call(gl, gl.SAMPLER_BINDING);
  for (const c of CAPS) P.disable.call(gl, c);
  P.colorMask.call(gl, true, true, true, true); P.depthMask.call(gl, false);
  P.bindFramebuffer.call(gl, gl.FRAMEBUFFER, dfb);
  P.viewport.call(gl, 0, 0, DW, DH);
  P.useProgram.call(gl, dprog); P.bindVertexArray.call(gl, dvao);
  P.bindTexture.call(gl, gl.TEXTURE_2D, tex); P.bindSampler.call(gl, 15, dsamp);
  P.uniform1i.call(gl, dloc, 15);
  P.drawArrays.call(gl, gl.TRIANGLES, 0, 3);
  P.bindBuffer.call(gl, gl.PIXEL_PACK_BUFFER, null); P.pixelStorei.call(gl, gl.PACK_ALIGNMENT, 4);
  P.readPixels.call(gl, 0, 0, DW, DH, gl.RGBA, gl.UNSIGNED_BYTE, dpix);
  P.bindSampler.call(gl, 15, s15); P.bindTexture.call(gl, gl.TEXTURE_2D, t15); P.activeTexture.call(gl, s.at);
  P.bindBuffer.call(gl, gl.PIXEL_PACK_BUFFER, s.ppb); P.pixelStorei.call(gl, gl.PACK_ALIGNMENT, s.pa);
  P.useProgram.call(gl, s.prog); P.bindVertexArray.call(gl, s.vao);
  P.bindFramebuffer.call(gl, gl.DRAW_FRAMEBUFFER, s.df); P.bindFramebuffer.call(gl, gl.READ_FRAMEBUFFER, s.rf);
  P.viewport.call(gl, s.vp[0], s.vp[1], s.vp[2], s.vp[3]);
  P.colorMask.call(gl, s.cm[0], s.cm[1], s.cm[2], s.cm[3]); P.depthMask.call(gl, s.dm);
  CAPS.forEach((c, i) => { if (capv[i]) P.enable.call(gl, c); });
  const d = B.depth;
  for (let i = 0, j = 0; i < DW*DH; i++, j += 4) d[i] = (dpix[j]*256 + dpix[j+1]) / 65535;
}
B.depthVP = null; B.depthOk = false;

gl.bindFramebuffer = function(t, f){
  const id = idOf(f); fbObj[id] = f;
  const prev = st.fb;
  if (id !== prev && prev && B.passVP[prev] && !B.depthOk && isCamDepthFb(prev)) {
    try { readDepth(depthTexCache[prev]); B.depthVP = B.passVP[prev].slice(); B.depthOk = true; } catch (e) { B.err = 'depth:' + e; }
  }
  st.fb = id;
  return P.bindFramebuffer.call(gl, t, f);
};
gl.bindBuffer = function(t, b){ if (t === gl.ELEMENT_ARRAY_BUFFER) st.ebo = idOf(b); return P.bindBuffer.call(gl, t, b); };
gl.uniform4fv = function(loc, data, off, len){
  if (data) {
    const o = off || 0; const n = len || (data.length - o);
    if (n === 16) {
      const m = Array.prototype.slice.call(data, o, o + 16);
      if (isOrthoVP(m)) B.passVP[st.fb] = m;
      else if (B.cur.pendM === null && isAffine(m)) B.cur.pendM = m;
    }
  }
  return off === undefined ? P.uniform4fv.call(gl, loc, data) : P.uniform4fv.call(gl, loc, data, off, len);
};
B.allPass = true; B.cur.all = [];
for (const name of ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced']) {
  gl[name] = function(...a){
    B.draws++; afterDraw();
    const m = B.cur.pendM; B.cur.pendM = null;
    if (m && st.fb) {
      const cam = isCamDepthFb(st.fb);
      if (cam || B.allPass) {
        const tx = m[12], ty = m[13], tz = m[14];
        if (!(tx === 0 && ty === 0 && tz === 0)) {
          const fx = m[8], fz = m[10]; const fl = Math.hypot(fx, fz) || 1;
          const o = { mesh: st.ebo + ':' + a[1], n: a[1], x: tx, y: ty, z: tz, fx: fx/fl, fz: fz/fl, fb: st.fb, sc: Math.hypot(m[0], m[1], m[2]) };
          if (cam) B.cur.objs.push(o); else B.cur.all.push(o);
        }
      }
    }
    return P[name].apply(gl, a);
  };
}

/* ---------- 5. Geometry helpers ---------- */
function inv4(a){
  const inv = new Array(16);
  inv[0]=a[5]*a[10]*a[15]-a[5]*a[11]*a[14]-a[9]*a[6]*a[15]+a[9]*a[7]*a[14]+a[13]*a[6]*a[11]-a[13]*a[7]*a[10];
  inv[4]=-a[4]*a[10]*a[15]+a[4]*a[11]*a[14]+a[8]*a[6]*a[15]-a[8]*a[7]*a[14]-a[12]*a[6]*a[11]+a[12]*a[7]*a[10];
  inv[8]=a[4]*a[9]*a[15]-a[4]*a[11]*a[13]-a[8]*a[5]*a[15]+a[8]*a[7]*a[13]+a[12]*a[5]*a[11]-a[12]*a[7]*a[9];
  inv[12]=-a[4]*a[9]*a[14]+a[4]*a[10]*a[13]+a[8]*a[5]*a[14]-a[8]*a[6]*a[13]-a[12]*a[5]*a[10]+a[12]*a[6]*a[9];
  inv[1]=-a[1]*a[10]*a[15]+a[1]*a[11]*a[14]+a[9]*a[2]*a[15]-a[9]*a[3]*a[14]-a[13]*a[2]*a[11]+a[13]*a[3]*a[10];
  inv[5]=a[0]*a[10]*a[15]-a[0]*a[11]*a[14]-a[8]*a[2]*a[15]+a[8]*a[3]*a[14]+a[12]*a[2]*a[11]-a[12]*a[3]*a[10];
  inv[9]=-a[0]*a[9]*a[15]+a[0]*a[11]*a[13]+a[8]*a[1]*a[15]-a[8]*a[3]*a[13]-a[12]*a[1]*a[11]+a[12]*a[3]*a[9];
  inv[13]=a[0]*a[9]*a[14]-a[0]*a[10]*a[13]-a[8]*a[1]*a[14]+a[8]*a[2]*a[13]+a[12]*a[1]*a[10]-a[12]*a[2]*a[9];
  inv[2]=a[1]*a[6]*a[15]-a[1]*a[7]*a[14]-a[5]*a[2]*a[15]+a[5]*a[3]*a[14]+a[13]*a[2]*a[7]-a[13]*a[3]*a[6];
  inv[6]=-a[0]*a[6]*a[15]+a[0]*a[7]*a[14]+a[4]*a[2]*a[15]-a[4]*a[3]*a[14]-a[12]*a[2]*a[7]+a[12]*a[3]*a[6];
  inv[10]=a[0]*a[5]*a[15]-a[0]*a[7]*a[13]-a[4]*a[1]*a[15]+a[4]*a[3]*a[13]+a[12]*a[1]*a[7]-a[12]*a[3]*a[5];
  inv[14]=-a[0]*a[5]*a[14]+a[0]*a[6]*a[13]+a[4]*a[1]*a[14]-a[4]*a[2]*a[13]-a[12]*a[1]*a[6]+a[12]*a[2]*a[5];
  inv[3]=-a[1]*a[6]*a[11]+a[1]*a[7]*a[10]+a[5]*a[2]*a[11]-a[5]*a[3]*a[10]-a[9]*a[2]*a[7]+a[9]*a[3]*a[6];
  inv[7]=a[0]*a[6]*a[11]-a[0]*a[7]*a[10]-a[4]*a[2]*a[11]+a[4]*a[3]*a[10]+a[8]*a[2]*a[7]-a[8]*a[3]*a[6];
  inv[11]=-a[0]*a[5]*a[11]+a[0]*a[7]*a[9]+a[4]*a[1]*a[11]-a[4]*a[3]*a[9]-a[8]*a[1]*a[7]+a[8]*a[3]*a[5];
  inv[15]=a[0]*a[5]*a[10]-a[0]*a[6]*a[9]-a[4]*a[1]*a[10]+a[4]*a[2]*a[9]+a[8]*a[1]*a[6]-a[8]*a[2]*a[5];
  const det = 1/(a[0]*inv[0]+a[1]*inv[4]+a[2]*inv[8]+a[3]*inv[12]);
  return inv.map(v => v*det);
}
function screenToGround(M, sx, sy, h){ // ndc -> world xz on plane y=h
  const a=M[0], b=M[8], c=M[1], d=M[9];
  const r0 = sx - M[12] - M[4]*h, r1 = sy - M[13] - M[5]*h; const det = a*d - b*c;
  return [(r0*d - b*r1)/det, (a*r1 - c*r0)/det];
}
B.screenToGround = screenToGround;
const worldToNdc = (M, x, y, z) => [M[0]*x+M[4]*y+M[8]*z+M[12], M[1]*x+M[5]*y+M[9]*z+M[13]];
const angWrap = B.angWrap = a => { while (a > Math.PI) a -= 2*Math.PI; while (a < -Math.PI) a += 2*Math.PI; return a; };

/* ---------- 6. Perception ---------- */
// occupancy grid around the player
const G = B.G = { cell: 0.5, R: 44 };
G.N = G.R*2 + 1;
G.h = new Float32Array(G.N*G.N); G.seen = new Uint8Array(G.N*G.N);
G.dist = new Float32Array(G.N*G.N);   // distance (m) to nearest obstacle
G.memObs = new Uint8Array(G.N*G.N);
function buildGrid(px, pz, M){
  const iv = inv4(M), d = B.depth, N = G.N, R = G.R, cs = G.cell;
  G.h.fill(-99); G.seen.fill(0); G.cx = px; G.cz = pz;
  for (let j = 0; j < DH; j++) for (let i = 0; i < DW; i++) {
    const k = j*DW + i; const dz = d[k]; if (dz >= 0.9999) continue;
    const x = (i+0.5)/DW*2-1, y = (j+0.5)/DH*2-1, z = dz*2-1;
    const wx = iv[0]*x+iv[4]*y+iv[8]*z+iv[12], wy = iv[1]*x+iv[5]*y+iv[9]*z+iv[13], wz = iv[2]*x+iv[6]*y+iv[10]*z+iv[14];
    const gi = Math.round((wx-px)/cs) + R, gj = Math.round((wz-pz)/cs) + R;
    if (gi < 0 || gj < 0 || gi >= N || gj >= N) continue;
    const c = gj*N + gi; G.seen[c] = 1; if (wy > G.h[c]) G.h[c] = wy;
  }
}
function gridAt(wx, wz){ const i = Math.round((wx-G.cx)/G.cell) + G.R, j = Math.round((wz-G.cz)/G.cell) + G.R; if (i < 0 || j < 0 || i >= G.N || j >= G.N) return -1; return j*G.N + i; }

// player + object tracking
B.player = null;      // {x,z,y,th,vx,vz,speed,mesh}
B.ptrack = { mesh: null, x: 0, z: 0, t: 0, hist: [] };
B.others = [];        // tracked moving objects {x,z,vx,vz,mesh,age}
let otracks = [];
function findPlayer(f){
  const M = f.vp; const g = screenToGround(M, 0, 0, 0);
  const cx = g[0] - B.cfg.camOffX, cz = g[1] - B.cfg.camOffZ; const T = B.ptrack;
  let best = null, bs = 1e9;
  for (const o of f.objs) {
    if (o.y < -1.5 || o.y > 3 || o.n < 150) continue;
    let s;
    if (T.mesh && o.mesh === T.mesh && f.t - T.t < 500) s = Math.hypot(o.x - T.x, o.z - T.z) * 0.5;
    else s = Math.hypot(o.x - cx, o.z - cz) + (T.mesh && f.t - T.t < 500 ? 3 : 0);
    if (s < bs) { bs = s; best = o; }
  }
  if (!best || bs > 7) return null;
  const newMesh = best.mesh !== T.mesh;
  T.mesh = best.mesh; T.x = best.x; T.z = best.z; T.t = f.t;
  if (newMesh) T.hist = [];
  T.hist.push([f.t, best.x, best.z]); while (T.hist.length > 8) T.hist.shift();
  let vx = 0, vz = 0;
  if (T.hist.length >= 3) { const a = T.hist[0], b = T.hist[T.hist.length-1]; const dt = (b[0]-a[0])/1000; if (dt > 0.02) { vx = (b[1]-a[1])/dt; vz = (b[2]-a[2])/dt; } }
  return { x: best.x, y: best.y, z: best.z, th: Math.atan2(best.fz, best.fx), vx, vz, speed: Math.hypot(vx, vz), mesh: best.mesh, n: best.n };
}
// Vehicles are recognised by motion: once any instance of a mesh has been seen moving, that mesh is a vehicle.
B.vehicleMeshes = new Set();
function trackOthers(f, p){
  const now = f.t; const nt = [];
  const cands = f.objs.filter(o => o.n >= 150 && o.y > -1.5 && o.y < 3.2 && Math.hypot(o.x - p.x, o.z - p.z) > 1.2 && Math.hypot(o.x - p.x, o.z - p.z) < 35);
  const uniq = [];
  for (const o of cands) if (!uniq.some(u => Math.hypot(u.x-o.x, u.z-o.z) < 0.9)) uniq.push(o);
  for (const o of uniq) {
    let best = null, bd = 3.5;
    for (const t of otracks) { if (t.used) continue; const px = t.x + t.vx*(now-t.t)/1000, pz = t.z + t.vz*(now-t.t)/1000; const d = Math.hypot(o.x-px, o.z-pz) + (t.mesh === o.mesh ? 0 : 1.5); if (d < bd) { bd = d; best = t; } }
    if (best) {
      best.used = true; const dt = (now - best.t)/1000;
      if (dt > 0.005) { const ivx = (o.x-best.x)/dt, ivz = (o.z-best.z)/dt; const k = Math.min(1, dt*6); best.vx += (ivx-best.vx)*k; best.vz += (ivz-best.vz)*k; }
      best.x = o.x; best.z = o.z; best.t = now; best.age++; best.mesh = o.mesh; best.fx = o.fx; best.fz = o.fz; nt.push(best);
      if (best.age > 3 && Math.hypot(best.vx, best.vz) > 2.5 && Math.hypot(best.vx, best.vz) < 60) B.vehicleMeshes.add(o.mesh);
    } else nt.push({ x:o.x, z:o.z, vx:0, vz:0, t:now, age:0, mesh:o.mesh, fx:o.fx, fz:o.fz });
  }
  for (const t of nt) t.used = false;
  otracks = nt;
  B.others = nt.filter(t => t.age >= 2 && (B.vehicleMeshes.has(t.mesh) || Math.hypot(t.vx, t.vz) > 2.5));
}
B.trackOthers = trackOthers; B.findPlayer = findPlayer;
B.resetTracks = () => { otracks = []; B.others = []; B.ptrack.mesh = null; };

// Obstacle memory (world-fixed). Buildings between the camera and your car turn see-through and vanish from
// the depth buffer exactly when they matter, so obstacles seen earlier are remembered.
const MEM = B.mem = new Map();
const mkey = B.mkey = (ix, iz) => (ix + 1048576) * 2097152 + (iz + 1048576);
B.camDir = [0, 1];
function cameraGroundDir(M){
  // view direction = null space of the screen rows; pick the sign that moves toward the camera (smaller depth)
  const r0 = [M[0], M[4], M[8]], r1 = [M[1], M[5], M[9]], r2 = [M[2], M[6], M[10]];
  let v = [r0[1]*r1[2]-r0[2]*r1[1], r0[2]*r1[0]-r0[0]*r1[2], r0[0]*r1[1]-r0[1]*r1[0]];
  if (r2[0]*v[0] + r2[1]*v[1] + r2[2]*v[2] > 0) v = v.map(x => -x);
  const l = Math.hypot(v[0], v[2]) || 1; return [v[0]/l, v[2]/l];
}
B.cameraGroundDir = cameraGroundDir;
function inFadeZone(dx, dz){ const c = B.camDir; const along = dx*c[0] + dz*c[1]; const lat = Math.abs(dx*c[1] - dz*c[0]); return along > -4 && along < 26 && lat < 9; }
function updateMemory(p, gy, now){
  const N = G.N, R = G.R, cs = G.cell, thr = B.cfg.obstacleHeight;
  const gx0 = Math.round(G.cx/cs), gz0 = Math.round(G.cz/cs);
  const movers = B.others;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const c = j*N + i; if (!G.seen[c]) continue;
    const dx = (i-R)*cs, dz = (j-R)*cs;
    const k = mkey(gx0 + i - R, gz0 + j - R);
    const rel = G.h[c] - gy;
    if (rel > thr) {
      if (dx*dx + dz*dz < 6.25) continue;                                   // own car
      let nearMover = false; for (const o of movers) { const ex = o.x - (G.cx+dx), ez = o.z - (G.cz+dz); if (ex*ex + ez*ez < 7.3) { nearMover = true; break; } }
      if (nearMover) continue;
      MEM.set(k, { h: rel, t: now });
    } else if (rel > -B.cfg.waterDepth) {
      const m = MEM.get(k);
      if (m && !(m.h > 1.2 && inFadeZone(dx, dz))) MEM.delete(k);
    }
  }
  if (!B._memPrune || now - B._memPrune > 4000) {
    B._memPrune = now;
    for (const [k, m] of MEM) { const ix = Math.floor(k / 2097152) - 1048576, iz = (k % 2097152) - 1048576; if (Math.hypot(ix*cs - p.x, iz*cs - p.z) > 90 || now - m.t > 180000) MEM.delete(k); }
  }
}
B.updateMemory = updateMemory;
function distanceField(groundY){
  const N = G.N, R = G.R, cs = G.cell, D = G.dist, H = G.h, S = G.seen; const BIG = 1e3;
  const gx0 = Math.round(G.cx/cs), gz0 = Math.round(G.cz/cs);
  const useMem = B.cfg.useMemory;
  G.memObs = G.memObs || new Uint8Array(N*N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const c = j*N + i; let obs = false; G.memObs[c] = 0;
    const di = i - R, dj = j - R; const r2 = (di*di + dj*dj)*cs*cs;
    if (S[c]) { const rel = H[c] - groundY; obs = rel > B.cfg.obstacleHeight || rel < -B.cfg.waterDepth; }
    if (!obs && useMem) { const m = MEM.get(mkey(gx0 + di, gz0 + dj)); if (m) { obs = true; G.memObs[c] = 1; } }
    if (obs && r2 < B.cfg.selfMask*B.cfg.selfMask) obs = false;              // our own car body
    D[c] = obs ? 0 : BIG;
  }
  const a = cs, b = cs*Math.SQRT2;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const c = j*N+i; let v = D[c];
    if (i > 0) v = Math.min(v, D[c-1] + a); if (j > 0) { v = Math.min(v, D[c-N] + a); if (i > 0) v = Math.min(v, D[c-N-1] + b); if (i < N-1) v = Math.min(v, D[c-N+1] + b); } D[c] = v; }
  for (let j = N-1; j >= 0; j--) for (let i = N-1; i >= 0; i--) { const c = j*N+i; let v = D[c];
    if (i < N-1) v = Math.min(v, D[c+1] + a); if (j < N-1) { v = Math.min(v, D[c+N] + a); if (i < N-1) v = Math.min(v, D[c+N+1] + b); if (i > 0) v = Math.min(v, D[c+N-1] + b); } D[c] = v; }
}
B.distanceField = distanceField; B.buildGrid = buildGrid; B.gridAt = gridAt; B.inv4 = inv4;

/* ---------- 7. Planner ---------- */
B.cfg = {
  camOffX: 1.0, camOffZ: -1.1,     // camera look point minus player position
  obstacleHeight: 0.45,           // metres above ground that count as solid
  waterDepth: 0.6,                // metres below ground that count as water/hole
  carRadius: 1.15,
  selfMask: 2.0,
  useMemory: true,
  turnRate: 2.4,                  // rad/s at full lock
  steerResp: 9,                   // 1/s, how fast steering ramps
  slipResp: 10,                   // 1/s, how fast velocity follows heading
  horizon: 1.4, dt: 0.05,
  minSpeed: 9,
  copRadius: 2.4,
  unseenCost: 0.6,
  clearW: 0.8, nearCarW: 0.25, crowdW: 0.15, steerW: 0.03, switchW: 0.02,
};
const T1S = [0.05, 0.15, 0.3, 0.5, 0.75, 1.05, 1.4];
B.plan = null;
function planSteer(p, groundY, steerState){
  const C = B.cfg, dt = C.dt, steps = Math.round(C.horizon/dt);
  const v0 = Math.max(C.minSpeed, p.speed || 0);
  const vang0 = p.speed > 3 ? Math.atan2(p.vz, p.vx) : p.th;
  const others = B.others;
  let best = null; const all = [];
  for (const u1 of [-1, 0, 1]) for (const t1 of T1S) for (const u2 of [-1, 0, 1]) {
    if (t1 >= C.horizon && u2 !== 0) continue;
    if (u1 === u2 && t1 < C.horizon) continue;
    let x = p.x, z = p.z, th = p.th, va = vang0, s = steerState, cost = 0, alive = true, tDie = C.horizon, minClear = 9, pts = [];
    for (let k = 1; k <= steps; k++) {
      const t = k*dt; const u = t <= t1 ? u1 : u2;
      s += (u - s) * Math.min(1, C.steerResp*dt);
      th += -s * C.turnRate * dt;              // A (u=-1) turns left = increases angle
      va += angWrap(th - va) * Math.min(1, C.slipResp*dt);
      const v = v0 * (1 - 0.18*Math.abs(s));
      x += Math.cos(va)*v*dt; z += Math.sin(va)*v*dt;
      if ((k & 1) === 0) pts.push([x, z]);
      const c = gridAt(x, z);
      let clear;
      if (c < 0) { clear = 3; cost += C.unseenCost*dt; }
      else if (!G.seen[c] && !G.memObs[c]) { clear = Math.min(2, G.dist[c]); cost += C.unseenCost*dt*1.5; }
      else clear = G.dist[c];
      if (clear < C.carRadius) { alive = false; tDie = t; break; }
      minClear = Math.min(minClear, clear);
      cost += Math.max(0, 2.5 - clear) * C.clearW * dt;
      for (const o of others) {
        const ox = o.x + o.vx*t, oz = o.z + o.vz*t; const d = Math.hypot(ox - x, oz - z);
        if (d < C.copRadius) { alive = false; tDie = t; break; }
        if (d < 6) cost += (6 - d) * C.nearCarW * dt;
      }
      if (!alive) break;
    }
    let score = -cost;
    if (!alive) score -= 20 + 30*(C.horizon - tDie);
    score -= (u1 !== 0 ? C.steerW : 0) + (u1 !== B.u ? C.switchW : 0);
    if (others.length) {
      let rep = 0; for (const o of others) { const d = Math.hypot(o.x - x, o.z - z); rep += 1/(1 + d*d*0.02); }
      score -= rep * C.crowdW;
    }
    const cand = { u1, t1, u2, score, alive, tDie, pts, minClear };
    if (!best || score > best.score) best = cand;
  }
  return best;
}
B.planSteer = planSteer;

/* ---------- 8. Main per-frame loop ---------- */
B.enabled = false; B.hooks = {};
B.stats = { runs: 0, best: 0, history: [], runStart: 0 };
B.steerState = 0;
B.mode = 'idle';
function groundLevel(p){
  const vals = []; const N = G.N, R = G.R, cs = G.cell; const r2 = Math.round(7/cs), r1 = Math.round(2/cs);
  for (let j = -r2; j <= r2; j += 2) for (let i = -r2; i <= r2; i += 2) { const rr = Math.hypot(i, j); if (rr < r1 || rr > r2) continue; const c = (j+R)*N + (i+R); if (G.seen[c]) vals.push(G.h[c]); }
  if (vals.length < 10) return B.groundY || 0;
  vals.sort((a, b) => a - b); return vals[Math.floor(vals.length*0.3)];
}
B.groundLevel = groundLevel;
B.perfMs = 0;
B.think = function(f){
  const t0 = performance.now();
  const p = B.findPlayer(f);
  B.player = p;
  if (!p) { B.steer(0); return; }
  B.trackOthers(f, p);
  B.camDir = cameraGroundDir(B.depthVP);
  B.buildGrid(p.x, p.z, B.depthVP);
  const gy = B.groundLevel(p); B.groundY = gy;
  B.updateMemory(p, gy, f.t);
  B.distanceField(gy);
  B.steerState += ((B.u || 0) - B.steerState) * Math.min(1, B.cfg.steerResp * 0.03);
  const plan = B.planSteer(p, gy, B.steerState);
  B.plan = plan;
  if (plan) B.steer(plan.u1);
  B.lastPlanT = f.t;
  B.perfMs = B.perfMs*0.95 + (performance.now() - t0)*0.05;
  if (B.recorder) B.recorder(f, p, plan);
};
function onFrame(){
  if (uc.width !== lastCW || uc.height !== lastCH) { lastCW = uc.width; lastCH = uc.height; for (const k in camFbCache) delete camFbCache[k]; }
  const camFb = Object.keys(B.passVP).find(id => camFbCache[id]);
  const f = { t: performance.now(), objs: B.cur.objs, all: B.cur.all, vp: camFb ? B.passVP[camFb].slice() : null };
  B.cur.objs = []; B.cur.all = []; B.passVP = {};
  const haveDepth = B.depthOk; B.depthOk = false;
  B.frame = f;
  for (const k in B.hooks) { try { B.hooks[k](f); } catch (e) { B.err = k + ':' + e.stack; } }
  if (!B.alive || !B.enabled || B.mode !== 'play' || !f.vp || !haveDepth) return;
  try { B.think(f); } catch (e) { B.err = 'think:' + e.stack; }
}

/* ---------- 9. Screen states (menu / game over / popup / play) ---------- */
const cap = document.createElement('canvas'); cap.width = 240; cap.height = 150;
const cx2 = cap.getContext('2d', { willReadFrequently: true });
B.grabOnce = () => new Promise(res => { B.hooks.grab = () => { delete B.hooks.grab; cx2.drawImage(uc, 0, 0, 240, 150); res(cx2.getImageData(0, 0, 240, 150)); }; });
function getState(im){
  const W = im.width, H = im.height, d = im.data;
  const px = (u, v) => { const i = 4*(Math.floor(v*H)*W + Math.floor(u*W)); return [d[i], d[i+1], d[i+2]]; };
  const near = (a, b, t) => Math.abs(a[0]-b[0]) < t && Math.abs(a[1]-b[1]) < t && Math.abs(a[2]-b[2]) < t;
  const y1 = px(0.36, 0.92), y3 = px(0.63, 0.93);
  if (near(y1, [255,204,0], 30) && near(y3, [255,204,0], 30)) return 'menu';
  const p1 = px(0.08, 0.3), p3 = px(0.08, 0.7);
  if (near(p1, [245,225,165], 25) && near(p3, [245,225,165], 25)) return 'over';
  if (y1[0] > 30 && y1[0] < 140 && y1[2] < 20 && near(y1, y3, 12) && y1[1] > y1[0]*0.6 && y1[1] < y1[0]*0.95) return 'popup';
  return 'play';
}
B.getState = getState;
function findCloseButton(im){
  const W = im.width, H = im.height, d = im.data; const pts = [];
  for (let y = 0; y < H*0.6; y++) for (let x = 0; x < W; x++) { const i = 4*(y*W+x); if (Math.abs(d[i]-192) < 30 && Math.abs(d[i+1]-81) < 30 && Math.abs(d[i+2]-30) < 30) pts.push([x, y]); }
  if (pts.length < 20) return null;
  let best = null, bc = 0; for (const p of pts) { let c = 0; for (const q of pts) if (Math.abs(p[0]-q[0]) < 7 && Math.abs(p[1]-q[1]) < 7) c++; if (c > bc) { bc = c; best = p; } }
  if (bc < 20) return null;
  const cl = pts.filter(q => Math.abs(best[0]-q[0]) < 9 && Math.abs(best[1]-q[1]) < 9);
  return { x: cl.reduce((s, q) => s + q[0], 0)/cl.length/W, y: cl.reduce((s, q) => s + q[1], 0)/cl.length/H };
}

/* ---------- 10. HUD: status bar along the bottom, H shows what each stat means ---------- */
const hudCss = document.createElement('style');
hudCss.textContent = `
#erb-hud{position:fixed;left:50%;transform:translateX(-50%);bottom:6px;z-index:99999;max-width:98vw;display:flex;flex-wrap:wrap;justify-content:center;gap:4px;pointer-events:none;font:600 clamp(12px,1.55vw,17px)/1.25 system-ui,Segoe UI,Arial,sans-serif}
#erb-hud span{background:rgba(0,0,0,.72);color:#fff;padding:2px 8px;border-radius:7px;white-space:nowrap;text-shadow:0 1px 2px #000}
#erb-hud span.on{background:rgba(20,140,60,.9)}
#erb-hud span.off{background:rgba(160,30,30,.9)}
#erb-hud span.hint{background:rgba(0,0,0,.45);color:#ffd84d}
#erb-hud span.ver{background:rgba(0,0,0,.45);color:#9fb3c8;font-weight:500}
#erb-help{position:fixed;left:50%;top:46%;transform:translate(-50%,-50%);z-index:99999;width:min(96vw,1100px);max-height:80vh;overflow:auto;background:rgba(10,14,24,.93);color:#fff;border:2px solid #ffd84d;border-radius:12px;padding:10px 14px;pointer-events:none;font:clamp(12px,1.45vw,16px)/1.35 system-ui,Segoe UI,Arial,sans-serif;display:none}
#erb-help h3{margin:0 0 6px;font-size:1.15em;color:#ffd84d}
#erb-help div.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,330px),1fr));gap:5px 18px}
#erb-help div.g>div{display:flex;gap:8px}
#erb-help b{color:#7fe3ff;white-space:nowrap;flex:0 0 auto}
#erb-help p{margin:8px 0 0;color:#bbb;font-size:.92em}`;
document.head.appendChild(hudCss);
const hud = document.createElement('div'); hud.id = 'erb-hud'; document.body.appendChild(hud);
const help = document.createElement('div'); help.id = 'erb-help';
const HELP = [
  ['ERBot ON/off', 'Is the bot driving? (F8)'],
  ['play / menu / over', 'Game screen: driving, start menu, game over.'],
  ['runs', 'Attempts finished this session.'],
  ['now', 'Time in the current run.'],
  ['best', 'Longest run this session.'],
  ['points', 'Score this run: speed and staying alive add points, cash +25, crash −8, stuck −2/s, caught −30.'],
  ['(best …)', 'Its highest score ever.'],
  ['Rookie…Legend', 'Rank from all points ever: 500 Getaway Driver, 2k Wheelman, 5k Road Runner, 12k Ghost, 30k Legend.'],
  ['+25 cash / −8 crash', 'Pops up when the score changes.'],
  ['LEARNING FROM YOU', 'You’re steering (A/D, arrows, S brake); it copies you.'],
  ['lessons', 'Moments learned from your driving.'],
  ['attempts', 'Past runs it learned from.'],
  ['city pieces learned', 'Map pieces it knows, to plan around unseen walls.'],
  ['heading for cash / open road / new streets', 'Where its route goes: a cash stack, open road away from where the cops are heading, or (explore goal) streets it hasn\u2019t driven yet.'],
  ['brain % trained', 'How far its driving brain (a small neural net) has trained on your driving and its attempts.'],
  ['getting unstuck / out of water', 'Backing up to the last dry road it drove on, or driving to open road.'],
  ['on foot', 'Out of the car, getting back in.'],
  ['backing up', 'Stuck, reversing out.'],
  ['car damaged / swaps', 'Car smoking or burning: switching cars.'],
  ['new cars won', 'Won on the slot machine; it drives your rarest car.'],
  ['rewards claimed', 'Free rewards collected.'],
  ['gave up stuck runs', 'Runs it ended because it got stuck.'],
  ['err', 'Internal error (it keeps going).'],
];
help.innerHTML = '<h3>What the stats mean</h3><div class="g">' + HELP.map(([k, v]) => `<div><b>${k}</b><span>${v}</span></div>`).join('') + '</div><p>H: show / hide this help · F9 or J: show / hide the status bar · F8: bot on / off</p>';
document.body.appendChild(help);
B.toggleHud = () => { const hide = hud.style.display !== 'none'; hud.style.display = hide ? 'none' : 'flex'; if (hide) help.style.display = 'none'; };
B.toggleHelp = () => { const show = help.style.display !== 'block'; help.style.display = show ? 'block' : 'none'; if (show) hud.style.display = 'flex'; };
window.addEventListener('keydown', e => {
  if (!e.isTrusted || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
  const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  if (e.key === 'h' || e.key === 'H') B.toggleHelp();
  else if (e.key === 'j' || e.key === 'J' || e.key === 'F9') { if (e.key === 'F9' && window.__erbApp) return; B.toggleHud(); }
}, true);
const fmt = s => { s = Math.floor(s); return Math.floor(s/60) + ':' + String(s%60).padStart(2, '0'); };
const esc = t => t.replace(/[&<>]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' })[c]);
let lastHud = '';
function updateHud(){
  const S = B.stats; const cur = B.mode === 'play' && S.runStart ? (performance.now() - S.runStart)/1000 : 0;
  const text = `ERBot ${B.enabled ? 'ON' : 'off'} | ${B.mode} | runs ${S.runs} | now ${fmt(cur)} | best ${fmt(S.best)}` + (B.hudExtra ? B.hudExtra() : '') + (B.err ? ' | err' : '');
  if (text === lastHud) return; lastHud = text;
  const parts = text.split(' | ');
  hud.innerHTML = parts.map((t, i) => `<span${i === 0 ? ` class="${B.enabled ? 'on' : 'off'}"` : ''}>${esc(t)}</span>`).join('') + '<span class="hint">H = help</span><span class="ver">' + esc((window.__erbAppVersion ? 'app ' + window.__erbAppVersion + ' · ' : '') + 'bot ' + (window.ERBOT_VERSION || '?')) + '</span>';
}
B.updateHud = updateHud;

/* ---------- 11. Supervisor: drives menus, restarts, records runs ---------- */
let supervising = false;
async function supervise(){
  if (supervising) return; supervising = true;
  let lastState = null, stateSince = performance.now(), playSince = 0;
  while (B.enabled && B.alive) {
    let im; try { im = await Promise.race([B.grabOnce(), sleep(1500).then(() => null)]); } catch (e) { im = null; }
    const s = im ? getState(im) : lastState;
    const now = performance.now();
    if (s !== lastState) { stateSince = now; }
    if (s === 'play' && B.mode !== 'play') { B.mode = 'play'; playSince = now; B.stats.runStart = now; B.resetTracks(); B.mem.clear(); if (B.onRunStart) try { B.onRunStart(); } catch (e) {} }
    if (s !== 'play' && B.mode === 'play') {
      const dur = (now - B.stats.runStart)/1000; B.releaseAll();
      if (dur > 3) {
        B.stats.runs++;
        B.stats.history.push({ dur: +dur.toFixed(1), at: new Date().toISOString() });
        B.stats.best = Math.max(B.stats.best, dur);
        if (B.onRunEnd) try { B.onRunEnd(dur); } catch (e) {}
      }
    }
    if (s !== 'play') B.mode = s;
    lastState = s;
    if (s === 'menu' && now - stateSince > 600) {
      if (B.beforeRun) { try { await B.beforeRun(); } catch (e) {} }
      const im2 = await Promise.race([B.grabOnce(), sleep(1500).then(() => null)]);
      if (!im2 || getState(im2) === 'menu') { await B.tap('d'); await sleep(1200); }
    }
    else if (s === 'over' && now - stateSince > 1500) { await B.click(0.745*innerWidth, 0.826*innerHeight); await sleep(2000); }
    else if (s === 'popup' && now - stateSince > 700) { if (B.claimRewards) { try { await B.claimRewards(); } catch (e) {} } const im3 = await Promise.race([B.grabOnce(), sleep(1500).then(() => null)]) || im; const b = findCloseButton(im3); if (b) await B.click(b.x*innerWidth, b.y*innerHeight); await sleep(900); }
    updateHud();
    await sleep(250);
  }
  B.releaseAll(); if (B.mode === 'play') B.mode = 'idle'; updateHud(); supervising = false;
}
B.start = () => { B.enabled = true; supervise(); };
B.stop = () => { B.enabled = false; B.releaseAll(); };
B.shutdown = () => { B.stop(); B.alive = false; hud.remove(); help.remove(); hudCss.remove(); };
updateHud();
})();

/* ERBot extras: reliable player lock, money-bag detection, on-foot handling. Needs the core. */
(function(){
const E = window.ERBot;

/* --- player: the object the camera follows (drop locks on things that don't move with the camera) --- */
E.ptrack = { mesh:null, x:0, z:0, t:0, hist:[], bl:new Set(), lockCam:null, lockPos:null };
E.preferN = new Set([4059]);   // the default getaway car body
E.resetTracks = (old => () => { old(); E.ptrack.bl = new Set(); E.ptrack.mesh = null; E.ptrack.lockCam = null; })(E.resetTracks);
E.findPlayer = function(f){
  const M = f.vp; const g = E.screenToGround(M, 0, 0, 0); const cx = g[0] - E.cfg.camOffX, cz = g[1] - E.cfg.camOffZ; const T = E.ptrack;
  if (T.mesh && T.lockCam) {
    const camMv = Math.hypot(g[0]-T.lockCam[0], g[1]-T.lockCam[1]), objMv = Math.hypot(T.x-T.lockPos[0], T.z-T.lockPos[1]);
    if (camMv > 4 && objMv < 1) { T.bl.add(T.mesh); T.mesh = null; }
    if (camMv > 8) { T.lockCam = [g[0], g[1]]; T.lockPos = [T.x, T.z]; }
  }
  let best = null, bs = 1e9;
  for (const o of f.objs) {
    if (o.y < -1.5 || o.y > 3 || o.n < 150 || T.bl.has(o.mesh)) continue;
    let s;
    if (T.mesh && o.mesh === T.mesh && f.t - T.t < 500) s = Math.hypot(o.x-T.x, o.z-T.z)*0.5;
    else { s = Math.hypot(o.x-cx, o.z-cz) + (T.mesh && f.t - T.t < 500 ? 3 : 0); if (!E.preferN.has(o.n)) s += 2.5; }
    if (s < bs) { bs = s; best = o; }
  }
  if (!best || bs > 7) return null;
  if (best.mesh !== T.mesh) { T.hist = []; T.lockCam = [g[0], g[1]]; T.lockPos = [best.x, best.z]; }
  T.mesh = best.mesh; T.x = best.x; T.z = best.z; T.t = f.t;
  T.hist.push([f.t, best.x, best.z]); while (T.hist.length > 8) T.hist.shift();
  let vx = 0, vz = 0;
  if (T.hist.length >= 3) { const a = T.hist[0], b = T.hist[T.hist.length-1]; const dt = (b[0]-a[0])/1000; if (dt > 0.02) { vx = (b[1]-a[1])/dt; vz = (b[2]-a[2])/dt; } }
  return { x:best.x, y:best.y, z:best.z, th:Math.atan2(best.fz, best.fx), vx, vz, speed:Math.hypot(vx, vz), mesh:best.mesh, n:best.n };
};

/* --- money bags: the green cash stacks are a 180-index mesh at 0.7 scale --- */
E.bagMem = new Map(); E.bagsTaken = 0;
E.isBag = o => o.n === 180 && Math.abs(o.sc - 0.7) < 0.12 && o.y > 0.05 && o.y < 1.4;
E.updateTargets = function(f, p){
  const now = f.t, vis = new Set();
  for (const o of f.objs.concat(f.all || [])) { if (!E.isBag(o)) continue; const k = Math.round(o.x*2) + ',' + Math.round(o.z*2); if (vis.has(k)) continue; vis.add(k); E.bagMem.set(k, { x:o.x, z:o.z, seen:now }); }
  const M = f.vp;
  for (const [k, b] of E.bagMem) {
    if (vis.has(k)) continue;
    const sx = M[0]*b.x + M[8]*b.z + M[12] + M[4]*0.6, sy = M[1]*b.x + M[9]*b.z + M[13] + M[5]*0.6;
    const onScreen = Math.abs(sx) < 0.9 && Math.abs(sy) < 0.9; const d = Math.hypot(b.x-p.x, b.z-p.z);
    if ((onScreen && now - b.seen > 400) || now - b.seen > 90000 || d > 150) { if (onScreen && d < 3.5) E.bagsTaken++; E.bagMem.delete(k); }
  }
  E.targets = [...E.bagMem.values()];
};

/* --- on foot (car wrecked): the action button turns green; keep pressing Space to jump into a car --- */
{
  const c = document.createElement('canvas'); c.width = 24; c.height = 16; const x = c.getContext('2d', { willReadFrequently: true });
  E.btnColor = () => { x.drawImage(E.uc, E.uc.width*0.915, E.uc.height*0.9, E.uc.width*0.07, E.uc.height*0.08, 0, 0, 24, 16); const d = x.getImageData(0, 0, 24, 16).data; let r=0, g=0, b=0, n=0; for (let i = 0; i < d.length; i += 4) { if (d[i]+d[i+1]+d[i+2] > 600) continue; r+=d[i]; g+=d[i+1]; b+=d[i+2]; n++; } return n ? [r/n|0, g/n|0, b/n|0] : [0,0,0]; };
  E.onFoot = () => { const [r, g, b] = E.btnColor(); return g > r + 40 && g > b + 20; };
}
E.footState = { on:false, lastSpace:0, checkF:0 };
E.hooks.foot = function(f){
  if (!E.enabled || E.mode !== 'play' || (E.humanActive && E.humanActive())) { if (E.mode !== 'play') E.footState.on = false; return; }
  if ((++E.footState.checkF) % 10) return;
  const on = E.onFoot(); E.footState.on = on;
  if (on && f.t - E.footState.lastSpace > 1300) { E.footState.lastSpace = f.t; E.tap(' ', 90); }
};
})();

/* ERBot brain v4: planner (steer + brake), rewards, learning from you, learning every attempt.
 * Requires the ERBot core to be installed first. Safe to re-run. */
(function(){
const E = window.ERBot; if (!E || !E.G) { console.warn('ERBot core missing'); return; }
const G = E.G, angWrap = E.angWrap;
const LS_KEY = 'erbot_brain_v3';

/* ---------------- persistent memory ---------------- */
const DEFAULT_CFG = { carRadius: 1.3, copRadius: 2.7, clearW: 1.2, nearCarW: 0.35, crowdW: 0.15, horizon: 2.0, bagPull: 0.3, bagValue: 15, imitW: 2.5, brakeCost: 0.6 };
const TUNE = { carRadius:[1.0,1.9,0.08], copRadius:[1.8,4,0.15], clearW:[0.3,3,0.15], nearCarW:[0.05,1.2,0.06], crowdW:[0,0.8,0.05], horizon:[1.4,2.8,0.1], bagPull:[0.05,0.8,0.05], imitW:[0,8,0.5], brakeCost:[0.1,2,0.1] };
let S = { version: 3, samples: [], best: { ...DEFAULT_CFG }, bestScore: null, trial: null, runs: [], humanSamples: 0, careerPoints: 0, bestPoints: 0, calib: {} };
try { const raw = localStorage.getItem(LS_KEY); if (raw) { const o = JSON.parse(raw); if (o && o.version === 3) S = Object.assign(S, o); } } catch (e) {}
for (const k in DEFAULT_CFG) if (S.best[k] === undefined) S.best[k] = DEFAULT_CFG[k];
S.calib = S.calib || {};
E.brain = S;
let saveT = 0;
function save(force){ const now = performance.now(); if (!force && now - saveT < 5000) return; saveT = now; try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {
  S.samples = S.samples.filter((s, i) => s.w > 0.9 || i > S.samples.length/2); try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e2) {} } }
E.saveBrain = save;
E.resetBrain = () => { localStorage.removeItem(LS_KEY); location.reload(); };

/* ---------------- settings: best-so-far + a small random tweak each attempt ---------------- */
function gauss(){ return Math.sqrt(-2*Math.log(Math.random()+1e-9))*Math.cos(2*Math.PI*Math.random()); }
function newTrial(){
  const t = { ...S.best };
  const keys = Object.keys(TUNE); const nTweak = 1 + Math.floor(Math.random()*3);
  for (let i = 0; i < nTweak; i++) { const k = keys[Math.floor(Math.random()*keys.length)]; const [lo, hi, sd] = TUNE[k]; t[k] = Math.min(hi, Math.max(lo, t[k] + gauss()*sd*2)); }
  return t;
}
function applyCfg(c){ Object.assign(E.cfg, c); E.cfg.grabRadius = 1.8; }
S.trial = S.trial || newTrial();
for (const k in DEFAULT_CFG) if (S.trial[k] === undefined) S.trial[k] = S.best[k];
applyCfg(S.trial);

/* ---------------- brake key (S) ---------------- */
{ const kc = { s: 83, w: 87, a: 65, d: 68, ' ': 32, Escape: 27, ArrowLeft: 37, ArrowRight: 39 };
  E.keyEv = (type, key) => { const code = key.startsWith('Arrow') ? key : key === ' ' ? 'Space' : key === 'Escape' ? 'Escape' : 'Key' + key.toUpperCase();
    window.dispatchEvent(new KeyboardEvent(type, { key, code, keyCode: kc[key], which: kc[key], bubbles: true, cancelable: true })); }; }
E.brake = on => { if (on) E.press('s'); else E.release('s'); E.b = on ? 1 : 0; };

/* ---------------- features (what a situation looks like, for learning) ---------------- */
const RAY_ANG = [-2.4,-1.6,-1.0,-0.6,-0.3,-0.12,0,0.12,0.3,0.6,1.0,1.6,2.4];
function rayDist(p, th, maxD){
  const cs = 0.5; const ca = Math.cos(th), sa = Math.sin(th);
  for (let d = 1.5; d <= maxD; d += cs) { const c = E.gridAt(p.x + ca*d, p.z + sa*d); if (c < 0) return d; if (G.dist[c] < 0.6) return d; }
  return maxD;
}
E.rayDist = rayDist;
function features(p){
  const f = [];
  const th = p.th;
  for (const a of RAY_ANG) f.push(rayDist(p, th + a, 16) / 16);
  const vang = p.speed > 2 ? Math.atan2(p.vz, p.vx) : th;
  f.push(angWrap(vang - th), Math.min(p.speed, 25)/25, E.steerState || 0);
  const ca = Math.cos(th), sa = Math.sin(th);
  const rel = (x, z) => { const dx = x - p.x, dz = z - p.z; return [ (dx*ca + dz*sa), (-dx*sa + dz*ca) ]; };
  const os = (E.others || []).map(o => ({ o, d: Math.hypot(o.x - p.x, o.z - p.z) })).sort((a, b) => a.d - b.d).slice(0, 3);
  for (let i = 0; i < 3; i++) {
    if (os[i]) { const r = rel(os[i].o.x, os[i].o.z); const rv = [ (os[i].o.vx*ca + os[i].o.vz*sa)/20, (-os[i].o.vx*sa + os[i].o.vz*ca)/20 ]; f.push(Math.max(-1, Math.min(1, r[0]/20)), Math.max(-1, Math.min(1, r[1]/20)), rv[0], rv[1]); }
    else f.push(1, 0, 0, 0);
  }
  let bb = null, bd = 1e9; for (const b of (E.targets || [])) { const d = Math.hypot(b.x - p.x, b.z - p.z); if (d < bd) { bd = d; bb = b; } }
  if (bb) { const r = rel(bb.x, bb.z); f.push(Math.max(-1, Math.min(1, r[0]/30)), Math.max(-1, Math.min(1, r[1]/30)), 1); } else f.push(0, 0, 0);
  return f;
}
E.features = features;
const FW = [...RAY_ANG.map(() => 1.6), 0.8, 0.8, 1.0, 1,1,0.6,0.6, 0.7,0.7,0.4,0.4, 0.5,0.5,0.3,0.3, 0.8,0.8,0.5];

/* ---------------- learned habits: reward-weighted nearest neighbours ---------------- */
function policy(fv){
  const sm = S.samples; if (sm.length < 20) return null;
  const K = 11; const best = [];
  for (let i = 0; i < sm.length; i++) {
    const s = sm[i].f; let d = 0;
    for (let j = 0; j < fv.length; j++) { const e = (fv[j] - s[j]) * FW[j]; d += e*e; if (best.length === K && d > best[K-1][0]) break; }
    if (best.length < K) { best.push([d, i]); best.sort((a, b) => a[0] - b[0]); }
    else if (d < best[K-1][0]) { best[K-1] = [d, i]; best.sort((a, b) => a[0] - b[0]); }
  }
  const v = { '-1': 0.2, '0': 0.2, '1': 0.2 };
  for (const [d, i] of best) { const s = sm[i]; const w = s.w / (0.05 + Math.sqrt(d)); v[s.u] += w; }
  for (const k in v) v[k] = Math.max(0.02, v[k]);
  const tot = v['-1'] + v['0'] + v['1'];
  return { '-1': v['-1']/tot, '0': v['0']/tot, '1': v['1']/tot, near: Math.sqrt(best[0][0]) };
}
E.policy = policy;
const outbox = [];   // new lessons to share with the other games when several play at once
function addSample(fv, u, w, shared){
  const smp = { f: fv.map(x => +x.toFixed(3)), u, w: +w.toFixed(3) };
  S.samples.push(smp); if (!shared && window.__erbHub) outbox.push(smp);
  if (S.samples.length > 12000) { const idx = S.samples.findIndex(s => s.w < 0.9); S.samples.splice(idx >= 0 ? idx : 0, 1); }
}

/* ---------------- you driving: detect real key presses ---------------- */
E.human = E.human || { u: 0, keys: {}, lastT: -1e9 };
const keyU = k => (k === 'a' || k === 'A' || k === 'ArrowLeft') ? -1 : (k === 'd' || k === 'D' || k === 'ArrowRight') ? 1 : 0;
const keyB = k => k === 's' || k === 'S' || k === 'ArrowDown';
if (!window.__erbHumanHook) {
  window.__erbHumanHook = true;
  window.addEventListener('keydown', e => { if (!e.isTrusted) return; const B = window.ERBot; const H = B && B.human; if (!H) return; const u = keyU(e.key), b = keyB(e.key); if (u || b) { if (!B.humanActive || !B.humanActive()) { try { B.releaseAll(); } catch (x) {} } if (u) H.keys[u] = 1; if (b) H.keys.b = 1; H.lastT = performance.now(); } }, true);
  window.addEventListener('keyup', e => { if (!e.isTrusted) return; const H = window.ERBot && window.ERBot.human; if (!H) return; const u = keyU(e.key), b = keyB(e.key); if (u) delete H.keys[u]; if (b) delete H.keys.b; if (u || b) H.lastT = performance.now(); }, true);
}
const humanActive = () => performance.now() - E.human.lastT < 1500 || Object.keys(E.human.keys).length > 0;
const humanU = () => { const k = E.human.keys; return k[-1] && !k[1] ? -1 : k[1] && !k[-1] ? 1 : 0; };
E.humanActive = humanActive;

/* ---------------- car handling, measured as it drives (each car is different) ---------------- */
const calib = { prevTh: null, prevT: 0, prevSp: 0 };
function calibrate(p, t){
  const C = S.calib[p.n] || (S.calib[p.n] = { turn: E.cfg.turnRate, vmax: 16, decel: 14 });
  if (calib.prevTh !== null && t - calib.prevT < 80) {
    const dt = (t - calib.prevT)/1000;
    const w = angWrap(p.th - calib.prevTh)/dt;
    const s = E.steerState || 0;
    if (Math.abs(s) > 0.75 && p.speed > 6 && !E.b) { const est = Math.abs(w/s); if (est > 0.5 && est < 6) C.turn = C.turn*0.98 + est*0.02; }
    if (!E.b && Math.abs(s) < 0.2 && p.speed > C.vmax) C.vmax = C.vmax*0.95 + p.speed*0.05;
    if (!E.b && Math.abs(s) < 0.2 && p.speed > 4) C.vmax = Math.max(8, C.vmax*0.999 + p.speed*0.001);
    if (E.b && p.speed > 4 && calib.prevSp > p.speed) { const dec = (calib.prevSp - p.speed)/dt; if (dec > 2 && dec < 40) C.decel = C.decel*0.95 + dec*0.05; }
  }
  calib.prevTh = p.th; calib.prevT = t; calib.prevSp = p.speed;
  return C;
}

/* ---------------- planner: steering + braking ---------------- */
const T1S = [0.05, 0.12, 0.2, 0.3, 0.45, 0.6, 0.8, 1.05, 1.35, 1.8, 2.6];
E.planSteer = function(p, groundY, steerState, pol, car){
  const C = E.cfg, dt = 0.05, steps = Math.round(C.horizon/dt);
  const onFoot = E.footState && E.footState.on;
  const vmax = onFoot ? 5 : Math.max(9, car ? car.vmax : 16);
  const v0 = Math.max(onFoot ? 3 : 4, p.speed || 0);
  const turnRate = onFoot ? 4 : (car ? car.turn : C.turnRate);
  const decel = car ? car.decel : 14;
  const carR = onFoot ? 0.6 : C.carRadius, copR = onFoot ? 1.4 : C.copRadius;
  const vang0 = p.speed > 3 ? Math.atan2(p.vz, p.vx) : p.th;
  const others = E.others || [];
  let tg = E.targets || [];
  if (onFoot) tg = tg.concat(others.filter(o => Math.hypot(o.vx, o.vz) < 3).map(o => ({ x:o.x, z:o.z })));
  let best = null;
  for (const brake of (onFoot ? [0] : [0, 1])) for (const u1 of [-1, 0, 1]) for (const t1 of T1S) for (const u2 of [-1, 0, 1]) {
    if (t1 >= C.horizon && u2 !== 0) continue;
    if (u1 === u2 && t1 < C.horizon) continue;
    if (brake && t1 > 1.05) continue;
    let x = p.x, z = p.z, th = p.th, va = vang0, s = steerState, v = v0, cost = 0, alive = true, tDie = C.horizon, pts = [], gain = 0;
    const got = new Set();
    for (let k = 1; k <= steps; k++) {
      const t = k*dt; const first = t <= t1; const u = first ? u1 : u2;
      s += (u - s) * Math.min(1, C.steerResp*dt);
      if (brake && first) { v = Math.max(2.5, v - decel*dt); cost += C.brakeCost*dt; }
      else v = Math.min(vmax*(1 - 0.18*Math.abs(s)), v + 6*dt);
      th += -s * turnRate * dt * Math.min(1, v/6 + 0.3);
      va += angWrap(th - va) * Math.min(1, C.slipResp*dt);
      x += Math.cos(va)*v*dt; z += Math.sin(va)*v*dt;
      if ((k & 1) === 0) pts.push([x, z]);
      // the car is a box: check its centre, its nose and both front corners
      const ca = Math.cos(th), sa = Math.sin(th);
      let clear = 9;
      for (const [fx, sx] of [[0, 0], [1.4, 0], [1.2, 0.7], [1.2, -0.7]]) {
        const qx = x + ca*fx - sa*sx, qz = z + sa*fx + ca*sx;
        const c = E.gridAt(qx, qz); let cl;
        if (c < 0) { cl = 3; if (fx === 0) cost += C.unseenCost*dt*0.5; }
        else if (!G.seen[c] && !G.memObs[c]) { cl = Math.min(2.2, G.dist[c]); if (fx === 0) cost += C.unseenCost*dt*0.75; }
        else cl = G.dist[c];
        clear = Math.min(clear, fx === 0 ? cl : cl + 0.5);
      }
      if (clear < carR) { alive = false; tDie = t; break; }
      cost += Math.max(0, 3.0 - clear) * C.clearW * dt;
      for (const o of others) {
        const ox = o.x + o.vx*t, oz = o.z + o.vz*t; const d = Math.hypot(ox - x, oz - z);
        if (d < copR) { alive = false; tDie = t; break; }
        if (d < 7) cost += (7 - d) * C.nearCarW * dt;
      }
      if (!alive) break;
      for (let i = 0; i < tg.length; i++) { if (got.has(i)) continue; if (Math.hypot(tg[i].x - x, tg[i].z - z) < C.grabRadius) { got.add(i); gain += (tg[i].guess ? 0.2 : 1) * C.bagValue*(1 - 0.3*t/C.horizon); } }
    }
    let score = -cost + gain;
    if (!alive) score -= 25 + 40*(C.horizon - tDie);
    score -= (u1 !== 0 ? C.steerW : 0) + (u1 !== E.u ? C.switchW : 0) + (brake !== (E.b || 0) ? 0.05 : 0);
    if (others.length) { let rep = 0; for (const o of others) { const d = Math.hypot(o.x - x, o.z - z); rep += 1/(1 + d*d*0.02); } score -= rep * C.crowdW; }
    if (tg.length && alive) { let bd = 1e9; for (let i = 0; i < tg.length; i++) if (!got.has(i)) bd = Math.min(bd, Math.hypot(tg[i].x - x, tg[i].z - z)); if (bd < 1e9) score -= C.bagPull * Math.min(bd, 60); }
    if (E.goal && alive) score -= (C.goalPull || 0) * Math.min(Math.hypot(E.goal.x - x, E.goal.z - z), 30);   // follow the route
    if (pol) score += C.imitW * Math.log(pol[u1] * 3);
    if (!best || score > best.score) best = { u1, t1, u2, brake, score, alive, tDie, pts, gain };
  }
  return best;
};

/* ---------------- rewards ---------------- */
// points: +driving fast and staying alive, +25 per cash bag, -8 per hard hit, -2/s stuck, -30 when caught/wrecked
const RW = { bag: 25, hit: -8, end: -30 };
E.reward = { run: 0, last: '', lastT: 0, buckets: [], bucketT: 0, acc: 0, prevBags: 0, prevHits: 0 };
function rewardTick(p, t, dt){
  const R = E.reward;
  let r = 0;
  if (p.speed < 2) r -= 2*dt; else r += dt*(0.5 + 0.5*Math.min(p.speed, 20)/20);
  const bags = E.bagsTaken || 0; if (bags > R.prevBags) { r += RW.bag*(bags - R.prevBags); R.last = `+${RW.bag} cash bag!`; R.lastT = t; } R.prevBags = bags;
  const hits = (E.dmg && E.dmg.hits) || 0; if (hits > R.prevHits) { r += RW.hit; R.last = `${RW.hit} crash`; R.lastT = t; } R.prevHits = hits;
  R.run += r; R.acc += r;
  if (t - R.bucketT >= 100) { R.buckets.push({ t, r: R.acc }); R.acc = 0; R.bucketT = t; if (R.buckets.length > 3000) R.buckets.shift(); }
}

/* ---------------- per-frame ---------------- */
E.recent = [];
E.runBags = 0;
let stuckSince = 0, reverseUntil = 0, lastT = 0;
function maskOwnCar(p){
  // the depth map sees our own car; blank out its exact footprint (a box), so things right next to it still count
  const N = G.N, R = G.R, cs = G.cell, ca = Math.cos(p.th), sa = Math.sin(p.th); const r = Math.ceil(2.6/cs);
  for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
    const dx = i*cs, dz = j*cs; const along = dx*ca + dz*sa, across = -dx*sa + dz*ca;
    if (Math.abs(along) < 2.3 && Math.abs(across) < 1.15) { const c = (j+R)*N + (i+R); G.seen[c] = 1; G.h[c] = -50; }
  }
}
E.think = function(f){
  const t0 = performance.now();
  const p = E.findPlayer(f); E.player = p;
  if (!p) { if (!humanActive()) { E.steer(0); E.brake(false); } return; }
  E.trackOthers(f, p);
  E.camDir = E.cameraGroundDir(E.depthVP);
  E.buildGrid(p.x, p.z, E.depthVP);
  const gy = E.groundLevel(p); E.groundY = gy;
  maskOwnCar(p); for (let c = 0; c < G.N*G.N; c++) if (G.h[c] === -50) G.h[c] = gy;
  E.cfg.selfMask = 0.01;
  E.updateMemory(p, gy, f.t);
  E.distanceField(gy);
  if (E.updateTargets) E.updateTargets(f, p);
  const car = calibrate(p, f.t);
  const dt = lastT ? Math.min(0.1, (f.t - lastT)/1000) : 0; lastT = f.t;
  if (f.t - E.stats.runStart > 2500) rewardTick(p, f.t, dt);
  const fv = features(p);
  if (!humanActive() && f.t - E.stats.runStart < 2500) { E.steer(0); E.brake(false); return; }   // backing out of the parking spot
  if (humanActive()) {
    const u = humanU(); E.b = E.human.keys.b ? 1 : 0;
    E.u = u; E.steerState += (u - E.steerState) * Math.min(1, E.cfg.steerResp*0.03);
    if (!E._lastHumanSample || f.t - E._lastHumanSample > 60) { E._lastHumanSample = f.t; addSample(fv, u, 1.0); S.humanSamples++; E.recent.push({ t: f.t, f: fv, u, human: true }); }
    E.mode2 = 'teach'; E.plan = null; save(); return;
  }
  E.mode2 = 'auto';
  E.steerState += ((E.u || 0) - E.steerState) * Math.min(1, E.cfg.steerResp*0.03);
  const pol = policy(fv);
  let plan = E.planSteer(p, gy, E.steerState, pol, car);
  // stuck against something: back up (S) while turning toward open space, then go again
  if (p.speed < 2 && !(E.footState && E.footState.on) && !E.v4owned) { if (!stuckSince) stuckSince = f.t; } else stuckSince = 0;
  if (stuckSince && f.t - stuckSince > 900 && f.t > reverseUntil + 1500) { reverseUntil = f.t + 900; E._revDir = rayDist(p, p.th + 1.2, 16) > rayDist(p, p.th - 1.2, 16) ? 1 : -1; }
  if (f.t < reverseUntil) { E.steer(E._revDir); E.brake(true); E.plan = { reversing: true }; return; }
  E.plan = plan;
  if (plan) { E.steer(plan.u1); E.brake(!!plan.brake); }
  if (!E._lastBotSample || f.t - E._lastBotSample > 100) { E._lastBotSample = f.t; E.recent.push({ t: f.t, f: fv, u: plan ? plan.u1 : 0 }); if (E.recent.length > 3000) E.recent.shift(); }
  E.perfMs = E.perfMs*0.95 + (performance.now() - t0)*0.05;
};

/* ---------------- after every attempt: learn from the rewards ---------------- */
E.onRunStart = () => { if (E.bagMem) E.bagMem.clear(); E.ptrack.bl = new Set(); E.ptrack.mesh = null; E.ptrack.lockCam = null; E.recent = []; E.runBags = E.bagsTaken || 0; stuckSince = 0; reverseUntil = 0; lastT = 0;
  const R = E.reward; R.run = 0; R.buckets = []; R.acc = 0; R.prevBags = E.bagsTaken || 0; R.prevHits = (E.dmg && E.dmg.hits) || 0; R.last = ''; };
E.onRunEnd = (dur) => {
  const R = E.reward;
  const endT = R.buckets.length ? R.buckets[R.buckets.length-1].t : performance.now();
  R.buckets.push({ t: endT, r: RW.end }); R.run += RW.end;
  const points = R.run;
  // reward-to-go for every decision (rewards in the next ~1-2 s count most)
  const B = R.buckets; const G2 = new Float64Array(B.length); let acc = 0;
  for (let i = B.length - 1; i >= 0; i--) { const gap = i < B.length - 1 ? (B[i+1].t - B[i].t)/100 : 1; acc = B[i].r + Math.pow(0.93, gap)*acc; G2[i] = acc; }
  const goAt = t => { let lo = 0, hi = B.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (B[m].t < t) lo = m + 1; else hi = m; } return B.length ? G2[lo] : 0; };
  const rets = E.recent.filter(r => !r.human).map(r => goAt(r.t));
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0)/rets.length : 0;
  let k = 0;
  for (const r of E.recent) {
    if (r.human) continue;
    const adv = rets[k++] - mean; const w = Math.max(-1, Math.min(1, adv/4));
    if (Math.abs(w) > 0.25 && (w < 0 || Math.random() < 0.3)) addSample(r.f, r.u, w*0.7);   // good moves count for, bad moves against
  }
  E.recent = [];
  const humanHelped = S.humanSamples > (E._humanAtStart || 0);
  if (!humanHelped) {
    if (S.bestScore === null) { S.bestScore = points; S.best = { ...S.trial }; }
    else if (points > S.bestScore + Math.max(5, Math.abs(S.bestScore)*0.05)) { S.best = { ...S.trial }; S.bestScore = 0.5*S.bestScore + 0.5*points; }
    else S.bestScore = 0.95*S.bestScore + 0.05*points;
  }
  const bags = (E.bagsTaken || 0) - (E.runBags || 0);
  S.careerPoints = (S.careerPoints || 0) + Math.max(0, points);
  S.bestPoints = Math.max(S.bestPoints || 0, points);
  S.runs.push({ at: Date.now(), dur: +dur.toFixed(1), bags, points: Math.round(points), human: humanHelped }); if (S.runs.length > 300) S.runs.shift();
  S.trial = newTrial(); applyCfg(S.trial);
  E._humanAtStart = S.humanSamples;
  save(true);
  hubSend({ run: S.runs[S.runs.length - 1], points, best: S.best, bestScore: S.bestScore });
};
E._humanAtStart = S.humanSamples;

/* ---------------- several games at once: share what each one learns ---------------- */
function hubSend(extra){
  if (!window.__erbHub) return;
  const msg = Object.assign({ from: window.__erbWorker || 0, samples: outbox.splice(0) }, extra || {});
  if (!msg.samples.length && !msg.run) return;
  try { window.__erbHub.push(JSON.stringify(msg)); } catch (e) {}
}
setInterval(() => hubSend(), 10000);   // lessons from you driving go out even mid-run
E.mergeDelta = d => {
  for (const s of d.samples || []) if (s && s.f && s.f.length === 31) addSample(s.f, s.u, s.w, true);
  if (d.samples && d.samples.some(s => s.w >= 0.99)) S.humanSamples += d.samples.filter(s => s.w >= 0.99).length;
  if (d.run) { S.runs.push(d.run); if (S.runs.length > 300) S.runs.shift(); S.careerPoints = (S.careerPoints || 0) + Math.max(0, d.points || 0); S.bestPoints = Math.max(S.bestPoints || 0, d.points || 0); }
  // another game found better settings: use them as the new starting point
  if (d.best && d.bestScore != null && (S.bestScore === null || d.bestScore > S.bestScore + 5)) { S.best = { ...d.best }; S.bestScore = d.bestScore; }
  if (E.v4 && E.v4.learner) E.v4.learner.dirty = true;
  save();
};

/* ---------------- levels (just for fun) ---------------- */
const LEVELS = [[0,'Rookie'],[500,'Getaway Driver'],[2000,'Wheelman'],[5000,'Road Runner'],[12000,'Ghost'],[30000,'Legend']];
E.level = () => { const c = S.careerPoints || 0; let l = LEVELS[0]; for (const L of LEVELS) if (c >= L[0]) l = L; const nx = LEVELS[LEVELS.indexOf(l) + 1]; return { name: l[1], next: nx ? nx[0] : null, career: Math.round(c) }; };

E.hudExtra = () => {
  const R = E.reward, lv = E.level(); const now = performance.now();
  return ` | points ${Math.round(R.run)} (best ${Math.round(S.bestPoints || 0)}) | ${lv.name}` + (R.last && now - R.lastT < 2000 ? ` | ${R.last}` : '') +
    (E.mode2 === 'teach' ? ' | LEARNING FROM YOU' : '') + ` | ${S.humanSamples} lessons, ${S.runs.length} attempts` + (E.footState && E.footState.on ? ' | on foot' : '') + (E.plan && E.plan.reversing ? ' | backing up' : '');
};
console.log('[ERBot] brain v4 loaded:', S.samples.length, 'samples,', S.runs.length, 'past attempts');
})();

/* ERBot map v2: the city is rebuilt every run (random spawn and layout), so instead of memorising
 * positions the bot learns the SHAPE of every building/block piece the city is made of. When a piece
 * shows up anywhere - even off the edge of the screen (its shadow is drawn) or see-through in front of
 * the car - its walls go straight into the planning map.
 * Also keeps the game running at full speed in the background. Needs core + brain. */
(function(){
const E = window.ERBot; if (!E || !E.G) return;
const LS_KEY = 'erbot_prefabs_v1';

/* ---------- background-proof ticker ---------- */
if (!E.workerTick) {
  try {
    const src = 'setInterval(()=>postMessage(0),16)';
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = () => { const B = window.ERBot; if (!B || !B.alive || !B.rafQ || !B.rafQ.length) return; const now = performance.now(); if (now - (B._lastRun || 0) < 15) return; B._lastRun = now; const q = B.rafQ; B.rafQ = []; for (const [, cb] of q) { try { cb(now); } catch (e) { B.err = String(e); } } B.frames++; };
    E.workerTick = w;
  } catch (e) { E.err = 'worker:' + e; }
}

/* ---------- the piece library ---------- */
const HS = 12, SZ = HS*2 + 1;           // 1 m cells, +-12 m around the piece's pivot
let lib = {};                            // key -> { w: Uint8Array, o: Uint8Array, seen: n }
const b64e = u8 => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
const b64d = s => { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
try { const raw = localStorage.getItem(LS_KEY); if (raw) { const o = JSON.parse(raw); for (const k in o) lib[k] = { w: b64d(o[k].w), o: b64d(o[k].o), seen: o[k].seen || 0 }; } } catch (e) { lib = {}; }
let dirty = false, saveT = 0;
function saveLib(force){
  const now = performance.now(); if (!dirty || (!force && now - saveT < 20000)) return; saveT = now; dirty = false;
  const o = {}; for (const k in lib) if (lib[k].seen > 3) o[k] = { w: b64e(lib[k].w), o: b64e(lib[k].o), seen: lib[k].seen };
  try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (e) {}
}
E.saveMap = saveLib;
E.resetMap = () => { localStorage.removeItem(LS_KEY); lib = {}; };
const pieceKey = o => o.n + '|' + o.sc.toFixed(2) + '|' + Math.round(o.y*2);
function wallAt(P, i){ const w = P.w[i], op = P.o[i]; return w >= 6 && w >= (w + op)*0.85; }

/* ---------- which drawn objects are pieces of the city (not cars, not us) ---------- */
function staticPieces(f, p, range){
  const out = [], seen = new Set(); const vm = E.vehicleMeshes || new Set();
  for (const o of f.objs.concat(f.all || [])) {
    if (o.n < 36 || o.y < -3 || o.y > 12 || vm.has(o.mesh)) continue;
    const d = Math.hypot(o.x - p.x, o.z - p.z); if (d < 3 || d > range) continue;
    const k = o.n + ':' + o.x.toFixed(1) + ':' + o.z.toFixed(1); if (seen.has(k)) continue; seen.add(k);
    let mover = false; for (const t of (E.others || [])) if (Math.hypot(t.x - o.x, t.z - o.z) < 1.5) { mover = true; break; }
    if (mover) continue;
    out.push(o);
  }
  return out;
}

/* ---------- learn piece shapes from what the depth camera sees ---------- */
function inFade(dx, dz){ const c = E.camDir; const along = dx*c[0] + dz*c[1], lat = Math.abs(dx*c[1] - dz*c[0]); return along > -4 && along < 26 && lat < 9; }
function learn(f, p, gy){
  const G = E.G, thr = E.cfg.obstacleHeight;
  for (const o of staticPieces(f, p, 24)) {
    const key = pieceKey(o); let P = lib[key];
    if (!P) P = lib[key] = { w: new Uint8Array(SZ*SZ), o: new Uint8Array(SZ*SZ), seen: 0 };
    P.seen++; dirty = true;
    const fx = o.fx, fz = o.fz;
    for (let j = 0; j < SZ; j++) for (let i = 0; i < SZ; i++) {
      const lx = i - HS, lz = j - HS;                       // piece-local metres (along its forward/right axes)
      const wx = o.x + lx*fz + lz*fx, wz = o.z - lx*fx + lz*fz;
      const c = E.gridAt(wx, wz); if (c < 0 || !G.seen[c]) continue;
      const dx = wx - p.x, dz = wz - p.z; if (dx*dx + dz*dz < 7) continue;
      let near = false; for (const t of (E.others || [])) { const ex = t.x - wx, ez = t.z - wz; if (ex*ex + ez*ez < 6.5) { near = true; break; } }
      if (near) continue;
      const idx = j*SZ + i; const rel = G.h[c] - gy;
      if (rel > thr) { if (P.w[idx] < 250) P.w[idx]++; else { P.w[idx] >>= 1; P.o[idx] >>= 1; } }
      else if (!inFade(dx, dz)) { if (P.o[idx] < 250) P.o[idx]++; else { P.w[idx] >>= 1; P.o[idx] >>= 1; } }
    }
  }
}

/* ---------- stamp known walls into the planning grid ---------- */
let stamp = null;
function stampPieces(f, p){
  const G = E.G, N = G.N, R = G.R, cs = G.cell;
  if (!stamp || stamp.length !== N*N) stamp = new Uint8Array(N*N); else stamp.fill(0);
  let n = 0;
  for (const o of staticPieces(f, p, 40)) {
    const P = lib[pieceKey(o)]; if (!P || P.seen < 20) continue;
    const fx = o.fx, fz = o.fz;
    for (let j = 0; j < SZ; j++) for (let i = 0; i < SZ; i++) {
      const idx = j*SZ + i; if (!wallAt(P, idx)) continue;
      const lx = i - HS, lz = j - HS;
      const wx = o.x + lx*fz + lz*fx, wz = o.z - lx*fx + lz*fz;
      for (const [ox, oz] of [[-0.25,-0.25],[0.25,-0.25],[-0.25,0.25],[0.25,0.25]]) {
        const gi = Math.round((wx + ox - G.cx)/cs) + R, gj = Math.round((wz + oz - G.cz)/cs) + R;
        if (gi >= 0 && gj >= 0 && gi < N && gj < N) { stamp[gj*N + gi] = 1; n++; }
      }
    }
  }
  E.stampCount = n;
}

/* ---------- bigger planning grid + distance field that uses the stamps ---------- */
if (E.G.R < 64) {
  const G = E.G; G.R = 64; G.N = G.R*2 + 1;
  G.h = new Float32Array(G.N*G.N); G.seen = new Uint8Array(G.N*G.N); G.dist = new Float32Array(G.N*G.N); G.memObs = new Uint8Array(G.N*G.N);
}
E.cfg.useMemory = false;
E.distanceField = function(groundY){
  const G = E.G, N = G.N, R = G.R, cs = G.cell, D = G.dist, H = G.h, S = G.seen; const BIG = 1e3;
  const p = E.player;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const c = j*N + i; const di = i - R, dj = j - R;
    let obs = false; G.memObs[c] = 0;
    if (S[c]) { const rel = H[c] - groundY; obs = rel > E.cfg.obstacleHeight || rel < -E.cfg.waterDepth; }
    if (!obs && stamp && stamp[c]) {
      // a learned wall: trust it where we can't see, and in front of the car where buildings go see-through
      if (!S[c] || (p && inFade(di*cs, dj*cs))) { obs = true; G.memObs[c] = 1; }
    }
    D[c] = obs ? 0 : BIG;
  }
  const a = cs, b = cs*Math.SQRT2;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const c = j*N+i; let v = D[c];
    if (i > 0) v = Math.min(v, D[c-1] + a); if (j > 0) { v = Math.min(v, D[c-N] + a); if (i > 0) v = Math.min(v, D[c-N-1] + b); if (i < N-1) v = Math.min(v, D[c-N+1] + b); } D[c] = v; }
  for (let j = N-1; j >= 0; j--) for (let i = N-1; i >= 0; i--) { const c = j*N+i; let v = D[c];
    if (i < N-1) v = Math.min(v, D[c+1] + a); if (j < N-1) { v = Math.min(v, D[c+N] + a); if (i < N-1) v = Math.min(v, D[c+N+1] + b); if (i > 0) v = Math.min(v, D[c+N-1] + b); } D[c] = v; }
};
// stamp before the distance field is built (brain calls updateMemory just before distanceField)
const baseUpdateMemory = E.updateMemory;
E.updateMemory = function(p, gy, now){
  if (baseUpdateMemory && E.cfg.useMemory) baseUpdateMemory(p, gy, now);
  const f = E.frame; if (!f) return;
  stampPieces(f, p);
  E._mapF = (E._mapF || 0) + 1; if (E._mapF % 3 === 0) learn(f, p, gy);
  saveLib(false);
};
const prevEnd = E.onRunEnd;
E.onRunEnd = (dur) => { if (prevEnd) prevEnd(dur); saveLib(true); };
E.mapStats = () => { const ks = Object.keys(lib); return { pieces: ks.length, known: ks.filter(k => lib[k].seen >= 20).length, stamped: E.stampCount || 0 }; };
const prevHud = E.hudExtra;
E.hudExtra = () => { const m = E.mapStats(); return (prevHud ? prevHud() : '') + ` | city pieces learned ${m.known}`; };
})();

/* ERBot car swap: when the car is badly damaged (smoking / burning), hop out next to another
 * vehicle and steal it. Needs core + extras + brain.
 * Damage is tracked two ways:
 *   - hits: every hard impact (sudden loss of speed) adds damage; a new car resets it
 *   - looks: fire-coloured and smoke-coloured pixels right around the car on screen */
(function(){
const E = window.ERBot; if (!E || !E.G) return;
E.dmg = { hits: 0, score: 0, mesh: null, lastSp: 0, lastT: 0, smoke: 0, fire: 0, swapAt: 0, exitedAt: 0 };
E.cfg.swapDamage = E.cfg.swapDamage || 5;      // damage points before we want a new car
const cc = document.createElement('canvas'); cc.width = 64; cc.height = 64;
const cx = cc.getContext('2d', { willReadFrequently: true });
function looks(f, p){
  // sample a box above and around the car; smoke rises, fire is orange
  const M = f.vp; const ppm = Math.abs(M[0])*E.uc.width/2*1.414;
  const sx = M[0]*p.x + M[4]*(p.y+1.2) + M[8]*p.z + M[12], sy = M[1]*p.x + M[5]*(p.y+1.2) + M[9]*p.z + M[13];
  const px = (sx+1)/2*E.uc.width, py = (1-sy)/2*E.uc.height; const R = ppm*2.2;
  cx.drawImage(E.uc, px-R, py-R*1.4, 2*R, 1.6*R, 0, 0, 64, 64);
  const d = cx.getImageData(0, 0, 64, 64).data; let fire = 0, smoke = 0;
  for (let i = 0; i < d.length; i += 4) { const r = d[i], g = d[i+1], b = d[i+2]; const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (r > 210 && g > 70 && g < 200 && b < 70 && r - g > 45) fire++;
    else if (mx - mn < 14 && mx > 40 && mx < 110) smoke++; }
  return [fire/4096, smoke/4096];
}
let fc = 0;
E.hooks.swap = function(f){
  const D = E.dmg, p = E.player;
  if (!E.enabled || E.mode !== 'play' || !p || !f.vp || (E.humanActive && E.humanActive())) return;
  if (E.footState && E.footState.on) { D.hits = 0; D.score = 0; D.mesh = null; return; }
  if (p.mesh !== D.mesh) { D.mesh = p.mesh; D.hits = 0; D.score = 0; D.smoke = 0; D.fire = 0; D.lastSp = p.speed; D.lastT = f.t; return; }
  // hard impacts
  const dt = (f.t - D.lastT)/1000;
  if (dt > 0 && dt < 0.3 && D.lastSp - p.speed > 6 && D.lastSp > 9) { D.hits++; D.score += 1 + Math.min(2, (D.lastSp - p.speed)/10); }
  D.lastSp = p.speed; D.lastT = f.t;
  // what the car looks like (smoothed)
  if ((++fc) % 6 === 0) { const [fi, sm] = looks(f, p); D.fire = D.fire*0.8 + fi*0.2; D.smoke = D.smoke*0.8 + sm*0.2; }
  const burning = D.fire > 0.025;
  const wantSwap = D.score >= E.cfg.swapDamage || (burning && D.score >= 2);
  D.want = wantSwap;
  if (!wantSwap || f.t - D.exitedAt < 4000) return;
  // only jump out when there is a slow vehicle right next to us and nothing fast closing in
  const others = E.others || [];
  const ride = others.filter(o => Math.hypot(o.vx, o.vz) < 4 && Math.hypot(o.x - p.x, o.z - p.z) < 7).sort((a, b) => Math.hypot(a.x-p.x, a.z-p.z) - Math.hypot(b.x-p.x, b.z-p.z))[0];
  const threat = others.some(o => Math.hypot(o.vx, o.vz) > 6 && Math.hypot(o.x - p.x, o.z - p.z) < 6);
  if (ride && !threat) { D.exitedAt = f.t; E.swaps = (E.swaps || 0) + 1; E.releaseAll(); E.tap(' ', 90); }   // out; the on-foot logic then runs to the nearest car and presses Space
};
const prevHud = E.hudExtra;
E.hudExtra = () => (prevHud ? prevHud() : '') + (E.dmg.want ? ' | car damaged, looking for a new one' : '') + (E.swaps ? ` | swaps ${E.swaps}` : '');
})();

/* ERBot garage: between runs, collect free rewards, spin for new cars with spare cash,
 * and drive the best (rarest) car you own. Needs core. Runs from the menu screen only. */
(function(){
const E = window.ERBot; if (!E || !E.G) return;
const sleep = E.sleep;
const cv = document.createElement('canvas'); const cx = cv.getContext('2d', { willReadFrequently: true });
// grab the current frame (full resolution) right after it is drawn
E.frameImage = () => new Promise(res => { E.hooks.fullGrab = () => { delete E.hooks.fullGrab; cv.width = E.uc.width; cv.height = E.uc.height; cx.drawImage(E.uc, 0, 0); res(cx.getImageData(0, 0, cv.width, cv.height)); }; });
const at = (u, v) => E.click(u*innerWidth, v*innerHeight);
const key = async (k, code, kc) => { window.dispatchEvent(new KeyboardEvent('keydown', { key:k, code, keyCode:kc, which:kc, bubbles:true })); await sleep(90); window.dispatchEvent(new KeyboardEvent('keyup', { key:k, code, keyCode:kc, which:kc, bubbles:true })); };
function region(im, u0, v0, u1, v1, fn){ const W = im.width, H = im.height, d = im.data; for (let y = Math.floor(v0*H); y < v1*H; y++) for (let x = Math.floor(u0*W); x < u1*W; x++) { const i = 4*(y*W + x); fn(d[i], d[i+1], d[i+2], x, y); } }

/* ---- claim buttons (gold, with "$" amounts) in reward lists ---- */
function findClaim(im){
  let sx = 0, sy = 0, n = 0;
  region(im, 0.55, 0.2, 0.8, 0.85, (r, g, b, x, y) => { if (Math.abs(r-171) < 30 && Math.abs(g-110) < 30 && b < 50) { if (!n || (Math.abs(x - sx/n) < 60 && Math.abs(y - sy/n) < 30)) { sx += x; sy += y; n++; } } });
  return n > 40 ? { u: sx/n/im.width, v: sy/n/im.height } : null;
}
E.claimRewards = async () => {
  let got = 0;
  for (let i = 0; i < 12; i++) { const im = await E.frameImage(); const b = findClaim(im); if (!b) break; await at(b.u, b.v); got++; await sleep(1100); }
  if (got) { E.claimed = (E.claimed || 0) + got; }
  return got;
};

/* ---- the garage ----
 * Cars sit in one row; ArrowLeft / ArrowRight move along it and stop at the ends.
 * The background colour gives the rarity (measured live):
 *   common green (51,135,51), rare blue (51,51,153), epic purple (89,38,140),
 *   legendary gold (166,153,51), mythic red (255,26,26).
 * Under the car: orange "SELECTED" for the car in use, red "LOCKED" for cars you don't own.
 * Anything else there (the select button of an owned car) counts as owned. */
const RARITY = [[51,135,51],[51,51,153],[89,38,140],[166,153,51],[255,26,26]];
function carInfo(im){
  const W = im.width, H = im.height, d = im.data;
  const px = (u, v) => { const i = 4*(Math.floor(v*H)*W + Math.floor(u*W)); return [d[i], d[i+1], d[i+2]]; };
  // sample the background at the left edge, middle height (no car there)
  let rank = 0, bestD = 1e9; const c = px(0.006, 0.5);
  RARITY.forEach((q, i) => { const dd = (c[0]-q[0])**2 + (c[1]-q[1])**2 + (c[2]-q[2])**2; if (dd < bestD) { bestD = dd; rank = i; } });
  let red = 0, orange = 0, area = 0;
  region(im, 0.38, 0.86, 0.62, 0.95, (r, g, b) => { area++; if (r > 190 && g < 60 && b < 60) red++; else if (r > 190 && g > 130 && g < 200 && b < 60) orange++; });
  const redRatio = red/area;
  const selected = orange >= area*0.03;
  // the LOCKED word (on the red mythic background it can't be told apart: count mythic cars as owned only when in use)
  const locked = !selected && (rank === 4 || (redRatio > 0.15 && redRatio < 0.2));
  return { rank, owned: !locked, selected, sure: bestD < 1500, redRatio: +redRatio.toFixed(3) };
}
E.carInfo = carInfo;
function nameHash(im){ let h = 0; region(im, 0.02, 0.03, 0.45, 0.11, (r, g, b, x, y) => { if (r > 230 && g > 230 && b > 230) h = (h*31 + x*7 + y) >>> 0; }); return h; }
E.nameHash = nameHash;
const LEFT = ['ArrowLeft', 'ArrowLeft', 37], RIGHT = ['ArrowRight', 'ArrowRight', 39];
// step once; returns the new frame's name hash (waits for the slide to finish)
async function step(dir){ await key(...dir); await sleep(650); const im = await E.frameImage(); return { im, h: nameHash(im) }; }

E.pickBestCar = async () => {
  await at(35/599, 350/374); await sleep(2200);           // garage opens on the car in use
  // 1) walk to the left end
  let cur = await E.frameImage(), h = nameHash(cur);
  for (let i = 0, same = 0; i < 120 && same < 2; i++) { const s2 = await step(LEFT); if (s2.h === h) same++; else same = 0; h = s2.h; cur = s2.im; }
  // 2) walk right to the end, noting every car
  const list = [carInfo(cur)];
  for (let i = 0, same = 0; i < 120 && same < 2; i++) { const s2 = await step(RIGHT); if (s2.h === h) { same++; continue; } same = 0; h = s2.h; list.push(carInfo(s2.im)); }
  // 3) best owned car (rarest; ties: the later one, which tends to be stronger)
  let best = -1; list.forEach((c, i) => { if (c.owned && (best < 0 || c.rank >= list[best].rank)) best = i; });
  E.ownedCars = list.filter(c => c.owned).length; E.carCount = list.length;
  if (best >= 0) {
    const cur2 = list.findIndex(c => c.selected);
    if (!list[best].selected && (cur2 < 0 || list[best].rank > list[cur2].rank)) {
      for (let i = list.length - 1; i > best; i--) { await key(...LEFT); await sleep(650); }
      await at(0.5, 0.905); await sleep(600);              // the select button
      const chk = carInfo(await E.frameImage());
      if (!chk.selected) { await key(' ', 'Space', 32); await sleep(600); }
    }
    E.bestCarRank = list[best].rank;
  }
  await at(45/599, 338/374); await sleep(1800);           // back to the menu
};

E.spinForCars = async (maxSpins = 3) => {
  await at(87/599, 350/374); await sleep(2200);           // slot machine ($500 a spin)
  let spins = 0;
  for (let i = 0; i < maxSpins; i++) {
    await key(' ', 'Space', 32);
    let won = false;
    for (let k = 0; k < 16; k++) {
      await sleep(1000);
      const im = await E.frameImage(); let bright = 0, tot = 0;
      region(im, 0.02, 0.3, 0.12, 0.6, (r, g, b) => { tot++; if (g > 170 && r < 120) bright++; });
      if (bright > tot*0.6) { won = true; break; }
      if (k === 3) { // still showing the machine after 4 s and the reels never moved: not enough cash
        let teal = 0, t2 = 0; region(im, 0.02, 0.3, 0.12, 0.6, (r, g, b) => { t2++; if (g > 80 && g < 150 && r < 60) teal++; });
        if (teal > t2*0.8 && i > 0) { }
      }
    }
    if (!won) break;
    spins++;
    await key(' ', 'Space', 32); await sleep(400);         // dismiss the prize / next spin
    await sleep(1500);
  }
  E.spins = (E.spins || 0) + spins;
  await at(45/599, 338/374); await sleep(1800);
  return spins;
};

/* ---- run all of this from the menu, at most every few runs ---- */
E.garageBusy = false;
E.cfg.garageEvery = E.cfg.garageEvery || 3;
E.beforeRun = async () => {
  const runs = E.stats.runs;
  if (E.garageBusy || (E._garageAtRun !== undefined && runs - E._garageAtRun < E.cfg.garageEvery)) return;
  E.garageBusy = true; E._garageAtRun = runs;
  try {
    const got = await E.spinForCars(3);
    if (got || E.bestCarRank === undefined) await E.pickBestCar();  // only after winning something new (or once)
  } catch (e) { E.err = 'garage:' + e; }
  E.garageBusy = false;
};
const prevHud = E.hudExtra;
E.hudExtra = () => (prevHud ? prevHud() : '') + (E.spins ? ` | new cars won ${E.spins}` : '') + (E.claimed ? ` | rewards claimed ${E.claimed}` : '');
})();

/* ERBot v4 core: the parts of the other chat's erbot-v4.js (project doc claude/erbot-v4.js)
 * that the app uses, unchanged in behaviour:
 *   PolicyNet + Learner  small neural net (no copycat input, learns to avoid crash moves)
 *   Planner              time-sliced A* route planner
 *   BagMemory            remembers where cash was seen
 *   GoalChooser          picks a bag or an escape point away from where the cops are heading
 *   Recovery             gets out of water / unstuck by heading for the last dry road
 * The map it plans on is supplied by combine.js (built from the live 3D view). */
(function (root) {
  'use strict';
  const DEFAULTS = {
    plannerShareMs: 1.0, replanEveryMs: 400, maxExpansionsPerSlice: 1200,
    copAvoidRadius: 14, bagMergeRadius: 4, bagViewRadius: 45,
    hidden: 32, learnRate: 0.003, l2: 0.03, epochs: 30, motion: true, balance: 3,
    priority: 'money', bagDetourMax: 55, bagAngleMax: 0.9, bagSafeCopDist: 28,
    copPredictS: 1.0, escMomentum: 2.5, escCopW: 0.083, escRadii: [18, 28],
    wallMargin: 3, steerGain: 1.8,
    stuckSpeed: 1.5, stuckMs: 1200, reverseMs: 900, escapeMs: 3500, landSearchCells: 12,
  };
  const now = () => performance.now();
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // features: drop f[15] (current steering = copycat cause), angle -> sin/cos
  function prep(f) {
    const x = new Float32Array(31); let k = 0;
    for (let i = 0; i <= 12; i++) x[k++] = f[i];
    x[k++] = Math.sin(f[13]); x[k++] = Math.cos(f[13]); x[k++] = f[14];
    for (let i = 16; i <= 30; i++) x[k++] = f[i];
    return x;
  }
  const N_IN = 31;
  // motion: also how every input changed since ~0.1 s ago (same as the Trainer)
  function prepMotion(f, pf) {
    const a = prep(f), b = pf ? prep(pf) : a, x = new Float32Array(N_IN + 29); x.set(a);
    let k = N_IN; for (let i = 0; i < N_IN; i++) { if (i === 13 || i === 14) continue; x[k++] = a[i] - b[i]; }
    return x;
  }
  function jumped(f, pf) { let s = 0; for (let i = 0; i < 13; i++) s += Math.abs(f[i] - pf[i]); return s > 4; }

  class PolicyNet {
    constructor(nIn, nH, seed = 1) {
      this.nIn = nIn; this.nH = nH;
      const r = mulberry32(seed), s1 = 1 / Math.sqrt(nIn), s2 = 1 / Math.sqrt(nH);
      this.W1 = Float32Array.from({ length: nIn * nH }, () => (r() * 2 - 1) * s1); this.b1 = new Float32Array(nH);
      this.W2 = Float32Array.from({ length: nH * 3 }, () => (r() * 2 - 1) * s2); this.b2 = new Float32Array(3);
      this.mean = new Float32Array(nIn); this.std = new Float32Array(nIn).fill(1);
      this._adam = null; this.t = 0; this.h = new Float32Array(nH); this.p = new Float32Array(3);
    }
    setNorm(X) {
      const n = X.length, d = this.nIn, m = new Float64Array(d), v = new Float64Array(d);
      for (const x of X) for (let j = 0; j < d; j++) m[j] += x[j];
      for (let j = 0; j < d; j++) m[j] /= n;
      for (const x of X) for (let j = 0; j < d; j++) v[j] += (x[j] - m[j]) ** 2;
      for (let j = 0; j < d; j++) { this.mean[j] = m[j]; this.std[j] = Math.max(0.05, Math.sqrt(v[j] / n)); }
    }
    forward(x) {
      const { nIn, nH, W1, b1, W2, b2, h, p, mean, std } = this;
      for (let j = 0; j < nH; j++) { let s = b1[j]; for (let i = 0; i < nIn; i++) s += ((x[i] - mean[i]) / std[i]) * W1[i * nH + j]; h[j] = Math.tanh(s); }
      let mx = -1e9;
      for (let k = 0; k < 3; k++) { let s = b2[k]; for (let j = 0; j < nH; j++) s += h[j] * W2[j * 3 + k]; p[k] = s; if (s > mx) mx = s; }
      let z = 0; for (let k = 0; k < 3; k++) { p[k] = Math.exp(p[k] - mx); z += p[k]; }
      for (let k = 0; k < 3; k++) p[k] /= z;
      return p;
    }
    trainBatch(batch, lr, l2) {
      const { nIn, nH, W1, W2, mean, std } = this;
      const gW1 = new Float32Array(W1.length), gb1 = new Float32Array(nH), gW2 = new Float32Array(W2.length), gb2 = new Float32Array(3);
      const xn = new Float32Array(nIn), dh = new Float32Array(nH); let loss = 0;
      for (const s of batch) {
        for (let i = 0; i < nIn; i++) xn[i] = (s.x[i] - mean[i]) / std[i];
        const p = this.forward(s.x), h = this.h, k = s.k, dz = [0, 0, 0];
        if (s.w >= 0) { loss -= s.w * Math.log(p[k] + 1e-7); for (let c = 0; c < 3; c++) dz[c] = s.w * (p[c] - (c === k ? 1 : 0)); }
        else { const a = -s.w, q = Math.max(1e-6, 1 - p[k]); loss -= a * Math.log(q); for (let c = 0; c < 3; c++) dz[c] = a * (p[k] / q) * ((c === k ? 1 : 0) - p[c]); }
        for (let c = 0; c < 3; c++) gb2[c] += dz[c];
        for (let j = 0; j < nH; j++) { let g = 0; for (let c = 0; c < 3; c++) { gW2[j * 3 + c] += h[j] * dz[c]; g += W2[j * 3 + c] * dz[c]; } dh[j] = g * (1 - h[j] * h[j]); gb1[j] += dh[j]; }
        for (let i = 0; i < nIn; i++) { const xi = xn[i]; if (xi === 0) continue; const row = i * nH; for (let j = 0; j < nH; j++) gW1[row + j] += xi * dh[j]; }
      }
      this._step([this.W1, this.b1, this.W2, this.b2], [gW1, gb1, gW2, gb2], batch.length, lr, l2);
      return loss / batch.length;
    }
    _step(P, G, n, lr, l2) {
      if (!this._adam) this._adam = P.map(p => [new Float32Array(p.length), new Float32Array(p.length)]);
      this.t++; const b1 = 0.9, b2 = 0.999, c1 = 1 - b1 ** this.t, c2 = 1 - b2 ** this.t;
      P.forEach((p, idx) => { const [m, v] = this._adam[idx], g = G[idx];
        for (let i = 0; i < p.length; i++) { const gi = g[i] / n + l2 * p[i]; m[i] = b1 * m[i] + (1 - b1) * gi; v[i] = b2 * v[i] + (1 - b2) * gi * gi; p[i] -= (lr * (m[i] / c1)) / (Math.sqrt(v[i] / c2) + 1e-8); } });
    }
    toJSON() { const a = x => Array.from(x, v => Math.round(v * 1e5) / 1e5); return { nIn: this.nIn, nH: this.nH, W1: a(this.W1), b1: a(this.b1), W2: a(this.W2), b2: a(this.b2), mean: a(this.mean), std: a(this.std), t: this.t }; }
    static fromJSON(o) { const n = new PolicyNet(o.nIn, o.nH); for (const k of ['W1', 'b1', 'W2', 'b2', 'mean', 'std']) n[k] = Float32Array.from(o[k]); n.t = 0; return n; }
  }

  // trains the net on the brain's samples (w > 0: do this, w < 0: avoid this), a few ms per frame
  class Learner {
    constructor(cfg, brain) {
      this.cfg = cfg; this.brain = brain; this.rand = mulberry32(7);
      const ok = brain.v4net && (brain.v4net.nIn === N_IN || brain.v4net.nIn === N_IN + 29);
      this.net = ok ? PolicyNet.fromJSON(brain.v4net) : new PolicyNet(cfg.motion ? N_IN + 29 : N_IN, cfg.hidden);
      this.motion = this.net.nIn === N_IN + 29;
      if (!ok) { brain.v4net = undefined; brain.v4epochs = 0; }
      this.trained = !!(ok); this.epochs = ok ? (brain.v4epochs || 0) : 0; this.dirty = true; this._order = null; this._pos = 0;
    }
    rebuild() {
      const data = [], cls = [0, 0, 0]; let prev = null;
      for (const s of this.brain.samples || []) {
        if (!s.f || s.f.length !== 31) { prev = null; continue; }
        const pf = prev && !jumped(s.f, prev) ? prev : null;
        data.push({ x: this.featurize(s.f, pf), k: s.u + 1, w: s.w }); if (s.w > 0) cls[s.u + 1] += s.w;
        prev = s.f;
      }
      if (this.cfg.balance) { const tot = cls[0] + cls[1] + cls[2] || 1; const cw = cls.map(c => c > 0 ? Math.min(this.cfg.balance, tot / (3 * c)) : 1); for (const d of data) if (d.w > 0) d.w *= cw[d.k]; }
      this.data = data;
      if (this.targetEpochs === undefined) this.targetEpochs = this.trained ? this.epochs + 4 : this.cfg.epochs;
      else this.targetEpochs = Math.max(this.targetEpochs, this.epochs + 8);
      if (!this.trained && data.length) this.net.setNorm(data.map(d => d.x));
      this._order = null; this.dirty = false;
    }
    trainTick(budgetMs) {
      if (this.dirty) this.rebuild();
      const t0 = now();
      if (!this.data || this.data.length < 50 || this.epochs >= this.targetEpochs) return 0;
      while (now() - t0 < budgetMs) {
        if (!this._order || this._pos >= this._order.length) {
          const o = this._order = Uint32Array.from(this.data.keys());
          for (let i = o.length - 1; i > 0; i--) { const j = (this.rand() * (i + 1)) | 0; [o[i], o[j]] = [o[j], o[i]]; }
          this._pos = 0; this.epochs++;
          if (this.epochs >= this.targetEpochs) break;
        }
        const batch = []; for (let i = 0; i < 32 && this._pos < this._order.length; i++) batch.push(this.data[this._order[this._pos++]]);
        if (!batch.length) continue;
        this.lastLoss = this.net.trainBatch(batch, this.cfg.learnRate * (this.epochs > 20 ? 0.4 : 1), this.cfg.l2);
        this.trained = true;
      }
      return now() - t0;
    }
    featurize(f, pf) { return this.motion ? prepMotion(f, pf) : prep(f); }
    policy(f, pf) { return this.net.forward(this.featurize(f, pf)); }
    save() { this.brain.v4net = this.net.toJSON(); this.brain.v4epochs = this.epochs; }
  }

  // ---- A* (time-sliced) on any grid with toCell/toWorld/cost
  class Heap {
    constructor() { this.k = []; this.v = []; }
    get size() { return this.k.length; }
    push(key, val) { const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val); while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; } k[i] = key; v[i] = val; }
    pop() { const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
      if (n) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; } k[i] = lk; v[i] = lv; }
      return top; }
  }
  const KEY = (x, z) => (x + 32768) * 65536 + (z + 32768);
  const KX = k => Math.floor(k / 65536) - 32768, KZ = k => (k % 65536) - 32768;
  const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
  class Planner {
    constructor(cfg, grid) { this.cfg = cfg; this.grid = grid; this.job = null; this.path = null; this.stats = { plans: 0, fails: 0 }; }
    start(from, to, cops, maxNodes = 6000) {
      const g = this.grid, [sx, sz] = g.toCell(from.x, from.z), [tx, tz] = g.toCell(to.x, to.z);
      this.job = { tx, tz, open: new Heap(), gs: new Map(), par: new Map(), closed: new Set(), copCells: (cops || []).map(c => g.toCell(c.x, c.z)), copR: this.cfg.copAvoidRadius / g.size, exp: 0, maxNodes, best: null, bestH: 1e9 };
      const k = KEY(sx, sz); this.job.gs.set(k, 0); this.job.open.push(this.h(sx, sz), k);
    }
    h(x, z) { const j = this.job, dx = Math.abs(x - j.tx), dz = Math.abs(z - j.tz); return dx + dz + (1.414 - 2) * Math.min(dx, dz); }
    step(budgetMs) {
      const j = this.job; if (!j) return true;
      const g = this.grid, t0 = now(); let n = 0;
      while (j.open.size) {
        if ((++n & 15) === 0 && now() - t0 > budgetMs) return false;
        if (n > this.cfg.maxExpansionsPerSlice) return false;
        const k = j.open.pop(); if (j.closed.has(k)) continue; j.closed.add(k); j.exp++;
        const x = KX(k), z = KZ(k), hh = this.h(x, z);
        if (hh < j.bestH) { j.bestH = hh; j.best = k; }
        if ((x === j.tx && z === j.tz) || j.exp > j.maxNodes) { this._finish(k); return true; }
        const g0 = j.gs.get(k);
        for (const [dx, dz, dl] of DIRS) {
          const nx = x + dx, nz = z + dz, cst = g.cost(nx, nz); if (!cst) continue;
          if (dx && dz && (!g.cost(x + dx, z) || !g.cost(x, z + dz))) continue;
          let pen = 0; for (const [cx, cz] of j.copCells) { const d = Math.hypot(nx - cx, nz - cz); if (d < j.copR) pen += 6 * (1 - d / j.copR); }
          const ng = g0 + dl * (cst + pen), nk = KEY(nx, nz), old = j.gs.get(nk);
          if (old === undefined || ng < old) { j.gs.set(nk, ng); j.par.set(nk, k); j.open.push(ng + this.h(nx, nz), nk); }
        }
      }
      this._finish(j.best); return true;
    }
    _finish(k) {
      const j = this.job; this.job = null; this.stats.plans++;
      if (k === null || k === undefined) { this.stats.fails++; this.path = null; return; }
      const pts = []; while (k !== undefined) { pts.push(this.grid.toWorld(KX(k), KZ(k))); k = j.par.get(k); }
      pts.reverse(); this.path = pts.map(([x, z]) => ({ x, z }));
    }
    lookahead(pos, ahead) {
      const p = this.path; if (!p || p.length < 2) return null;
      let bi = 0, bd = 1e9; for (let i = 0; i < p.length; i++) { const d = Math.hypot(p[i].x - pos.x, p[i].z - pos.z); if (d < bd) { bd = d; bi = i; } }
      if (bd > 12) return null;
      let left = ahead;
      for (let i = bi; i < p.length - 1; i++) { const seg = Math.hypot(p[i + 1].x - p[i].x, p[i + 1].z - p[i].z); if (seg >= left) { const t = left / seg; return { x: p[i].x + (p[i + 1].x - p[i].x) * t, z: p[i].z + (p[i + 1].z - p[i].z) * t }; } left -= seg; }
      return p[p.length - 1];
    }
  }

  // ---- where cash was seen (per run: the layout changes every run)
  class BagMemory {
    constructor(cfg) { this.cfg = cfg; this.bags = []; }
    clear() { this.bags.length = 0; }
    observe(visible, t, car) {
      const R = this.cfg.bagMergeRadius;
      for (const v of visible) {
        let m = null, md = R; for (const b of this.bags) { const d = Math.hypot(b.x - v.x, b.z - v.z); if (d < md) { md = d; m = b; } }
        if (!m) { m = { x: v.x, z: v.z }; this.bags.push(m); } else { m.x += (v.x - m.x) * 0.3; m.z += (v.z - m.z) * 0.3; }
        m.conf = 1; m.seenAt = t;
      }
      for (const b of this.bags) {
        if (b.conf <= 0) continue;
        if (Math.hypot(b.x - car.x, b.z - car.z) < this.cfg.bagViewRadius * 0.4 && !visible.some(v => Math.hypot(v.x - b.x, v.z - b.z) < R)) { b.conf *= 0.9; if (b.conf < 0.15) b.conf = 0; }
      }
    }
    candidates() { return this.bags.filter(b => b.conf > 0.1); }
  }

  // ---- cop tracking + goal choice (bag, or an escape point the cops aren't heading for)
  class Strategist {
    constructor(cfg, grid) { this.cfg = cfg; this.grid = grid; this._cops = []; this.target = null; }
    trackCops(t, cops) {
      const prev = this._cops, out = [];
      for (const c of cops) {
        let m = null, md = 12; for (const p of prev) { const d = Math.hypot(p.x - c.x, p.z - c.z); if (d < md) { md = d; m = p; } }
        let vx = c.vx || 0, vz = c.vz || 0;
        if (c.vx === undefined && m && t > m.t) { const dt = (t - m.t) / 1000; vx = m.vx * 0.6 + ((c.x - m.x) / dt) * 0.4; vz = m.vz * 0.6 + ((c.z - m.z) / dt) * 0.4; }
        out.push({ x: c.x, z: c.z, vx, vz, t });
      }
      this._cops = out; const k = this.cfg.copPredictS;
      return out.map(c => ({ x: c.x + c.vx * k, z: c.z + c.vz * k, nowX: c.x, nowZ: c.z }));
    }
    chooseGoal(car, hx, hz, cops, bags, t) {
      const cfg = this.cfg, g = this.grid;
      const copDist = (x, z) => { let m = 1e9; for (const c of cops) m = Math.min(m, Math.hypot(x - c.x, z - c.z), Math.hypot(x - c.nowX, z - c.nowZ)); return m; };
      if (cfg.priority === 'money') {
        let best = null, bs = -1e9;
        for (const b of bags) { const d = Math.hypot(b.x - car.x, b.z - car.z), dc = copDist(b.x, b.z); const s = (b.conf * 100) / (d + 25) - (dc < 30 ? (30 - dc) / 20 : 0); if (s > bs) { bs = s; best = b; } }
        if (best && bs > 0.25) return { x: best.x, z: best.z, kind: 'bag', bag: best };
      } else {
        const nearestCop = copDist(car.x, car.z), keep = this.target && this.target.kind === 'bag' && this.target.bag;
        let best = null, bs = -1e9;
        for (const b of bags) {
          if (b._skipUntil && t < b._skipUntil) continue;
          const dx = b.x - car.x, dz = b.z - car.z, d = Math.hypot(dx, dz), ang = Math.acos(clamp((dx * hx + dz * hz) / (d + 1e-6), -1, 1)), dc = copDist(b.x, b.z), committed = keep === b;
          const ok = d < cfg.bagDetourMax * (committed ? 1.3 : 1) && (ang < cfg.bagAngleMax * (committed ? 1.8 : 1) || d < 10) && dc > cfg.bagSafeCopDist && nearestCop > 14;
          if (!ok) { if (committed) b._skipUntil = t + 8000; continue; }
          const s = b.conf * (1 - d / 80) - ang * 0.3; if (s > bs) { bs = s; best = b; }
        }
        if (best) return { x: best.x, z: best.z, kind: 'bag', bag: best };
      }
      let eb = null, es = -1e9; const here = copDist(car.x, car.z);
      for (const R of cfg.escRadii) for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a), x = car.x + dx * R, z = car.z + dz * R;
        const [gx, gz] = g.toCell(x, z), c = g.cost(gx, gz); if (!c || c >= 12) continue;
        let s = 4 * g.openness(gx, gz) - c * 0.4;
        s += (Math.min(90, copDist(x, z)) - Math.min(90, here)) * cfg.escCopW;
        for (const cp of cops) { const cx = cp.x - car.x, cz = cp.z - car.z, cd = Math.hypot(cx, cz) + 1e-6, toward = (cx * dx + cz * dz) / cd; if (toward > 0.5 && cd < R + 10) s -= 4 * toward * (1 - cd / (R + 30)); }
        const align = dx * hx + dz * hz; s += cfg.escMomentum * align + (align < -0.3 ? -cfg.escMomentum * 1.2 : 0);
        if (this.target && this.target.kind === 'escape' && Math.hypot(x - this.target.x, z - this.target.z) < 12) s += 1.2;
        if (s > es) { es = s; eb = { x, z, kind: 'escape' }; }
      }
      return eb;
    }
  }

  // ---- stuck / water recovery: back up toward the last dry spot, else drive to the nearest open road
  // returns {turn: +1 = turn toward +angle, throttle: 1 gas / -1 reverse} or null
  class Recovery {
    constructor(cfg, grid) { this.cfg = cfg; this.grid = grid; this.reset(); }
    reset() { this.R = { phase: null, tries: 0 }; this.trail = []; this.lastMoveT = null; this.started = false; }
    tick(t, car, fwd, speed, inWater) {
      const cfg = this.cfg, R = this.R;
      if (speed > cfg.stuckSpeed * 2) this.lastMoveT = t;
      if (!inWater && !R.phase && speed > cfg.stuckSpeed * 2) {
        this.started = true; const h = this.trail;
        if (!h.length || Math.hypot(h[h.length - 1].x - car.x, h[h.length - 1].z - car.z) > 3) { h.push({ x: car.x, z: car.z }); if (h.length > 12) h.shift(); }
      }
      const slow = this.started && (!this.lastMoveT || t - this.lastMoveT > cfg.stuckMs);
      const angTo = (P, m) => { const dx = P.x - car.x, dz = P.z - car.z, d = Math.hypot(dx, dz) + 1e-6; return Math.atan2(m.x * dz / d - m.z * dx / d, m.x * dx / d + m.z * dz / d); };
      const pick = () => { for (let i = this.trail.length - 1; i >= 0; i--) { const d = Math.hypot(this.trail[i].x - car.x, this.trail[i].z - car.z); if (d > 6 && d < 40) return this.trail[i]; } return this.grid.nearestLand(car.x, car.z, cfg.landSearchCells); };
      if (!R.phase) {
        if (!(inWater || slow)) { if (speed > cfg.stuckSpeed * 2) R.tries = 0; return null; }
        R.target = pick(); R.tries++; R.since = t; R.startD = R.target ? Math.hypot(R.target.x - car.x, R.target.z - car.z) : 0;
        const behind = R.target && Math.abs(angTo(R.target, fwd)) > Math.PI / 2;
        R.phase = (behind || slow) ^ (R.tries % 3 === 0) ? 'reverse' : 'forward';
      }
      const T = R.target;
      if ((!inWater && speed > cfg.stuckSpeed * 2 && t - R.since > 500) || (T && Math.hypot(T.x - car.x, T.z - car.z) < 4)) { R.phase = null; this.lastMoveT = t; return null; }
      const limit = R.phase === 'reverse' ? (inWater ? cfg.escapeMs : cfg.reverseMs) : cfg.escapeMs;
      const progress = T ? R.startD - Math.hypot(T.x - car.x, T.z - car.z) : 0;
      if (t - R.since > limit || (t - R.since > 1500 && progress < 0.5)) { R.phase = R.phase === 'reverse' ? 'forward' : 'reverse'; R.since = t; R.tries++; R.target = pick(); R.startD = R.target ? Math.hypot(R.target.x - car.x, R.target.z - car.z) : 0; }
      const mode = inWater ? 'water' : 'unstuck';
      if (!R.target) return { turn: R.tries % 2 ? 1 : -1, throttle: R.phase === 'reverse' ? -1 : 1, mode };
      if (R.phase === 'reverse') return { turn: -clamp(angTo(R.target, { x: -fwd.x, z: -fwd.z }) * cfg.steerGain, -1, 1), throttle: -1, mode };
      return { turn: clamp(angTo(R.target, fwd) * cfg.steerGain, -1, 1), throttle: 1, mode };
    }
  }

  root.ERBot4 = { DEFAULTS, prep, prepMotion, PolicyNet, Learner, Planner, BagMemory, Strategist, Recovery };
})(window);

/* ERBot combine: plugs the other chat's v4 parts (v4core.js) into this bot.
 *   - steering habits: the v4 neural net (trained on your driving + every attempt) replaces the
 *     old copy-the-nearest-example habit once it has trained; until then the old one is used
 *   - where to go: v4's goal chooser + A* route on the live map (bag, or an escape point away from
 *     where the cops are heading); this bot's own look-ahead planner still does the actual driving,
 *     dodging and braking, now pulled along that route
 *   - stuck / water: v4's recovery (back up toward the last dry road, or drive to open road)
 * Needs core + brain + map + v4core. */
(function(){
const E = window.ERBot, V4 = window.ERBot4;
if (!E || !E.G || !E.brain || !V4) { console.warn('ERBot combine: missing parts'); return; }
const G = E.G, S = E.brain;
const cfg = Object.assign({}, V4.DEFAULTS);
E.v4cfg = cfg;
E.cfg.goalPull = E.cfg.goalPull || 0.12;
// play style chosen in the Trainer (Learning > Open the trainer)
try {
  const st = JSON.parse(localStorage.getItem('erbot_v4_config') || 'null');
  if (st) {
    for (const k of ['priority', 'bagDetourMax', 'bagAngleMax', 'bagSafeCopDist', 'copPredictS', 'escMomentum', 'escCopW', 'wallMargin', 'copAvoidRadius']) if (st[k] !== undefined) cfg[k] = st[k];
    if (typeof st.goalPull === 'number') E.cfg.goalPull = st.goalPull;
  }
} catch (e) {}

/* ---- the map the route planner works on: 2 m blocks read from the live 3D view (+ learned city pieces) */
const CS = 2;
const KEY = (x, z) => (x + 32768) * 65536 + (z + 32768);
const grid = {
  size: CS, cfg, water: {}, cache: new Map(),
  toCell: (x, z) => [Math.floor(x/CS), Math.floor(z/CS)],
  toWorld: (gx, gz) => [(gx + 0.5)*CS, (gz + 0.5)*CS],
  newFrame(){ this.cache.clear(); },
  raw(gx, gz){
    const k = KEY(gx, gz); let c = this.cache.get(k); if (c !== undefined) return c;
    let blocked = 0, unseen = 0, out = 0;
    for (const ox of [0.5, 1.5]) for (const oz of [0.5, 1.5]) {
      const i = E.gridAt(gx*CS + ox, gz*CS + oz);
      if (i < 0) { out++; continue; }
      if (G.dist[i] < 0.75) blocked++; else if (!G.seen[i] && !G.memObs[i]) unseen++;
    }
    if (out === 4) c = 6;                              // beyond what it can see: allowed, but not preferred
    else if (blocked >= 2) c = 0;                      // wall / building
    else c = 1 + Math.round(blocked*1.5 + unseen*0.75);
    this.cache.set(k, c); return c;
  },
  isWater(gx, gz){ return (this.water[gx + ',' + gz] || 0) >= 1; },
  cost(gx, gz){
    const c = this.raw(gx, gz); if (!c) return 0;
    if (this.water[gx + ',' + gz]) return 25;
    if (!this.raw(gx + 1, gz) || !this.raw(gx - 1, gz) || !this.raw(gx, gz + 1) || !this.raw(gx, gz - 1)) return c + cfg.wallMargin;
    return c;
  },
  openness(gx, gz, r = 2){ let ok = 0, n = 0; for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) { n++; const c = this.raw(gx + dx, gz + dz); if (c && c <= 4) ok++; } return ok/n; },
  nearestLand(x, z, maxR){
    const [cx, cz] = this.toCell(x, z);
    for (let r = 1; r <= maxR; r++) { let best = null, bd = 1e9;
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) { if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; const c = this.cost(cx + dx, cz + dz); if (!c || c > 4 || this.isWater(cx + dx, cz + dz)) continue; const d = dx*dx + dz*dz; if (d < bd) { bd = d; best = [cx + dx, cz + dz]; } }
      if (best) { const [wx, wz] = this.toWorld(best[0], best[1]); return { x: wx, z: wz }; } }
    return null;
  },
};

const learner = new V4.Learner(cfg, S);
const planner = new V4.Planner(cfg, grid);
const bagMem = new V4.BagMemory(cfg);
const strat = new V4.Strategist(cfg, grid);
const recov = new V4.Recovery(cfg, grid);
E.v4 = { learner, planner, bagMem, strat, recov, grid };
let lastPlan = -1e9;
const fh = [];   // recent features, for the brain's 'how things are changing' inputs

/* ---- explore mode: head for parts of the map it hasn't driven through yet this run */
const visited = new Set(); const VC = 8;
const vkey = (x, z) => Math.floor(x/VC) + ',' + Math.floor(z/VC);
E.explore = { visited };
function exploreGoal(car, hx, hz, cops, t){
  // cash that is close and ahead is still worth a quick detour
  for (const b of bagMem.candidates()) { const dx = b.x - car.x, dz = b.z - car.z, d = Math.hypot(dx, dz); if (d < 22 && (dx*hx + dz*hz)/(d + 1e-6) > 0.6) return { x: b.x, z: b.z, kind: 'bag', bag: b }; }
  const copDist = (x, z) => { let m = 1e9; for (const c of cops) m = Math.min(m, Math.hypot(x - c.x, z - c.z)); return m; };
  const here = copDist(car.x, car.z); let best = null, bs = -1e9;
  for (const R of [20, 30]) for (let i = 0; i < 24; i++) {
    const a = i/24*Math.PI*2, dx = Math.cos(a), dz = Math.sin(a), x = car.x + dx*R, z = car.z + dz*R;
    const [gx, gz] = grid.toCell(x, z), c = grid.cost(gx, gz); if (!c || c >= 12) continue;
    let fresh = 0; for (const ox of [-VC, 0, VC]) for (const oz of [-VC, 0, VC]) if (!visited.has(vkey(x + ox, z + oz))) fresh++;
    let sc = 3*fresh/9 + 2*grid.openness(gx, gz) - c*0.3;
    const align = dx*hx + dz*hz; sc += 1.5*align + (align < -0.3 ? -2 : 0);
    sc += (Math.min(60, copDist(x, z)) - Math.min(60, here))*0.06;
    for (const cp of cops) { const cx = cp.x - car.x, cz = cp.z - car.z, cd = Math.hypot(cx, cz) + 1e-6, tw = (cx*dx + cz*dz)/cd; if (tw > 0.5 && cd < R + 10) sc -= 3*tw*(1 - cd/(R + 30)); }
    if (strat.target && strat.target.kind === 'explore' && Math.hypot(x - strat.target.x, z - strat.target.z) < 10) sc += 1;
    if (sc > bs) { bs = sc; best = { x, z, kind: 'explore' }; }
  }
  return best;
}
E.setPriority = p => { cfg.priority = p; strat.target = null; lastPlan = -1e9; };

/* ---- wrap the driving planner */
const basePlan = E.planSteer;
E.planSteer = function(p, gy, steerState, pol, car){
  const t = performance.now();
  grid.newFrame();
  // 1) habits: the neural net once it has trained enough, blended with the old habit
  if (learner.trained && learner.epochs >= 5) {
    const fv = E.features(p);
    fh.push([t, fv]); while (fh.length > 2 && t - fh[1][0] >= 100) fh.shift();   // keep the features from ~0.1 s ago
    const q = learner.policy(fv, fh.length > 1 && t - fh[0][0] < 400 ? fh[0][1] : null);
    pol = pol ? { '-1': 0.65*q[0] + 0.35*pol['-1'], '0': 0.65*q[1] + 0.35*pol['0'], '1': 0.65*q[2] + 0.35*pol['1'] } : { '-1': q[0], '0': q[1], '1': q[2] };
  }
  // 2) where to go
  const car2 = { x: p.x, z: p.z };
  visited.add(vkey(p.x, p.z));
  const sp = p.speed || 0, hx = sp > 1 ? p.vx/sp : Math.cos(p.th), hz = sp > 1 ? p.vz/sp : Math.sin(p.th);
  const cops = strat.trackCops(t, (E.others || []).filter(o => Math.hypot(o.vx, o.vz) > 3));
  bagMem.observe((E.targets || []).filter(b => !b.guess), t, car2);
  if (!planner.job && t - lastPlan > cfg.replanEveryMs) {
    strat.target = cfg.priority === 'explore' ? exploreGoal(car2, hx, hz, cops, t) : strat.chooseGoal(car2, hx, hz, cops, bagMem.candidates(), t);
    if (strat.target) planner.start(car2, strat.target, cops);
    lastPlan = t;
  }
  planner.step(cfg.plannerShareMs);
  const la = planner.lookahead(car2, 6 + Math.min(8, sp*0.4));
  E.goal = la || (strat.target && strat.target.kind !== 'bag' ? strat.target : null);
  E.goalKind = strat.target ? strat.target.kind : null;
  // 3) stuck or in water: v4 recovery takes the wheel
  const fwd = { x: Math.cos(p.th), z: Math.sin(p.th) };
  const onFoot = E.footState && E.footState.on;
  const rec = onFoot || t - E.stats.runStart < 4000 ? null : recov.tick(t, car2, fwd, sp, !!E.inWater);
  if (rec) {
    // +turn = toward a bigger angle; in this game steering right (u=+1) makes the angle smaller
    const u = rec.turn > 0.3 ? -1 : rec.turn < -0.3 ? 1 : 0;
    E.recMode = rec.mode;
    learner.trainTick(1);
    return { u1: u, t1: 0.3, u2: 0, brake: rec.throttle < 0 ? 1 : 0, score: 0, alive: true, tDie: 0, pts: [], gain: 0, reversing: rec.throttle < 0, recovering: rec.mode };
  }
  E.recMode = null;
  const plan = basePlan.call(this, p, gy, steerState, pol, car);
  // 4) learning in the time left over (about 1.5 ms a frame)
  learner.trainTick(1.5);
  return plan;
};
E.v4owned = true;   // tells the brain to leave stuck handling to the recovery above

/* ---- runs */
const prevStart = E.onRunStart;
E.onRunStart = () => { if (prevStart) prevStart(); bagMem.clear(); visited.clear(); fh.length = 0; recov.reset(); strat.target = null; strat._cops = []; planner.job = null; planner.path = null; E.goal = null; lastPlan = -1e9; };
const prevEnd = E.onRunEnd;
E.onRunEnd = (dur) => { if (prevEnd) prevEnd(dur); learner.dirty = true; learner.save(); E.saveBrain(true); };
// save the trained net now and then too
setInterval(() => { if (learner.trained) learner.save(); }, 30000);

const prevHud = E.hudExtra;
E.hudExtra = () => (prevHud ? prevHud() : '') +
  (E.recMode ? ` | ${E.recMode === 'water' ? 'getting out of water' : 'getting unstuck'}` : E.goalKind ? ` | heading for ${E.goalKind === 'bag' ? 'cash' : E.goalKind === 'explore' ? 'new streets' : 'open road'}` : '') +
  ` | brain ${learner.trained ? Math.min(100, Math.round(100*learner.epochs/30)) + '% trained' : 'warming up'}`;
})();

/* ERBot watchdog: ends a run that has gone nowhere (stuck in water, wedged in a corner,
 * stuck on foot) so the bot doesn't sit in one run for hours. Needs core + extras + brain. */
(function(){
const E = window.ERBot; if (!E || !E.G) return;
const W = { trail: [], footSince: 0, lastBagAt: 0, bags: 0, quits: 0 };
E.watchdog = W;
const prevStart = E.onRunStart;
E.onRunStart = () => { if (prevStart) prevStart(); W.trail = []; W.footSince = 0; W.lastBagAt = performance.now(); W.bags = E.bagsTaken || 0; W.quitting = false; };
async function quitRun(why){
  if (W.quitting) return; W.quitting = true; W.quits++; W.lastWhy = why;
  E.releaseAll();
  // pause (top-left) opens the controls screen; its left button leaves the run and starts a fresh one
  await E.click(0.02*innerWidth, 0.033*innerHeight); await E.sleep(1500);
  await E.click(0.375*innerWidth, 0.864*innerHeight); await E.sleep(1000);
  // the screen never passes through "game over", so close the run here: it counts as a crash
  const dur = (performance.now() - E.stats.runStart)/1000;
  E.stats.runs++; E.stats.history.push({ dur: +dur.toFixed(1), at: new Date().toISOString(), quit: why });
  E.stats.best = Math.max(E.stats.best, dur);
  if (E.onRunEnd) try { E.onRunEnd(dur); } catch (e) {}
  E.mode = 'quit';                                     // the supervisor starts the next run when play resumes
  await E.sleep(4000);
  W.quitting = false;
}
E._quitRun = quitRun;
setInterval(() => {
  if (!E.enabled || E.mode !== 'play' || W.quitting) return;
  if (E.humanActive && E.humanActive()) { W.trail = []; return; }  // the user is driving
  const now = performance.now(), p = E.player;
  if (p) { W.trail.push([now, p.x, p.z]); while (W.trail.length && now - W.trail[0][0] > 45000) W.trail.shift(); }
  const runFor = now - (E.stats.runStart || now);
  // 1) hardly moved in 40 s
  if (W.trail.length > 30 && now - W.trail[0][0] > 40000) {
    let far = 0; const [, x0, z0] = W.trail[0]; for (const [, x, z] of W.trail) far = Math.max(far, Math.hypot(x - x0, z - z0));
    if (far < 12) return quitRun('stuck');
  }
  // 2) out of the car (in water, or the car is gone) for 30 s
  if (E.footState && E.footState.on) { if (!W.footSince) W.footSince = now; else if (now - W.footSince > 30000) return quitRun('on foot'); } else W.footSince = 0;
  // 3) a very long run with no cash for a long time (usually swimming in circles)
  if ((E.bagsTaken || 0) !== W.bags) { W.bags = E.bagsTaken || 0; W.lastBagAt = now; }
  if (runFor > 300000 && now - W.lastBagAt > 180000) return quitRun('no progress');
  // 4) hard cap: 20 minutes
  if (runFor > 1200000) return quitRun('time limit');
}, 1000);
const prevHud = E.hudExtra;
E.hudExtra = () => (prevHud ? prevHud() : '') + (W.quits ? ` | gave up ${W.quits} stuck runs` : '');
})();


window.ERBot.start();
