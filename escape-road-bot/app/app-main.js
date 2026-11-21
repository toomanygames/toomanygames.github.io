// Escape Road Bot - its own browser window that plays Escape Road 3 (one game, or several at
// once that all learn together) and learns as it goes.
const { app, BrowserWindow, WebContentsView, Menu, dialog, shell, net, ipcMain } = require('electron');
const os = require('os');
const fs = require('fs');
const path = require('path');

const GAME_URL = process.env.ERB_TEST_URL || 'https://gamea.azgame.io/escape-road-3/';
const GAME_ORIGIN = new URL(GAME_URL).origin;
const QUIET_URL = GAME_ORIGIN + '/robots-xyz.txt';      // a plain page on the game's server (no game, no bot)
const REFERRER = 'https://azgames.io/escape-road-3';   // the game only plays when it thinks it was opened from its home site
const UPDATE_BASE = process.env.ERB_UPDATE_BASE || 'https://raw.githubusercontent.com/toomanygames/toomanygames.github.io/main/escape-road-bot/';
const APP_PKG = require('./package.json');
const APP_VERSION = APP_PKG.version;                // this copy of the app code (may be a downloaded update)
const BUNDLED_BOT_VERSION = APP_PKG.botVersion || '0.0.0';
let BOT_CODE = fs.readFileSync(path.join(__dirname, 'bot.js'), 'utf8');
let BOT_VERSION = BUNDLED_BOT_VERSION;
let updateNote = '';
const STORE_KEYS = ['erbot_brain_v3', 'erbot_map_v1', 'erbot_prefabs_v1', 'erbot_v4_config'];
const ASPECT = 1.6;

let win = null;
let trainerWin = null;
let autoStart = true;
let muted = true;
const games = [];            // games[0] is yours (its learning is the one that is kept); the rest are helpers

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
// a problem in the app should never pile up error boxes on the screen
process.on('uncaughtException', e => console.error('error:', e));
process.on('unhandledRejection', e => console.error('error:', e));

const jsIn = (g, code) => (!g || g.wc.isDestroyed()) ? Promise.resolve(null) : g.wc.executeJavaScript(code, true).catch(() => null);
const js = code => jsIn(games[0], code);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- one game ---------------- */
function makeGame(i) {
  const view = new WebContentsView({ webPreferences: {
    backgroundThrottling: false, contextIsolation: false, nodeIntegration: false, sandbox: true,
    preload: path.join(__dirname, 'preload-game.js'),
    // helpers keep their own storage, so they can't overwrite your bot's learning; they share lessons through the app
    ...(i ? { partition: 'persist:erb-helper-' + i } : {}),
  } });
  view.setBackgroundColor('#16181e');
  const wc = view.webContents;
  const g = { i, view, wc, injected: false, token: 0, loadedAt: 0 };
  wc.setAudioMuted(muted);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  // the page may try to send the window to the game's home site: stay on the game's server
  const offSite = url => !String(url).startsWith(GAME_ORIGIN + '/');
  wc.on('will-navigate', (e, url) => { if (offSite(url)) e.preventDefault(); });
  wc.on('will-redirect', (e, url) => { if (offSite(url)) e.preventDefault(); });
  wc.on('did-finish-load', () => { if (wc.getURL().startsWith(GAME_URL)) waitAndInject(g); });
  wc.on('render-process-gone', () => setTimeout(() => loadGame(g), 1500));
  win.contentView.addChildView(view);
  return g;
}
function loadGame(g) {
  if (!g || g.wc.isDestroyed()) return;
  g.injected = false; g.token++; g.loadedAt = Date.now();
  g.wc.loadURL(GAME_URL, { httpReferrer: REFERRER }).catch(() => {});
}
const loadAll = () => games.forEach(loadGame);

async function injectBot(g) {
  await jsIn(g, `window.__erbApp = 1; window.__erbAppVersion = ${JSON.stringify(APP_VERSION)}; window.__erbWorker = ${g.i};`);
  await jsIn(g, BOT_CODE.replace(/window\.ERBot\.start\(\);\s*$/, ''));
  if (autoStart) await jsIn(g, 'window.ERBot && window.ERBot.start()');
}
// wait for the game engine, then add the bot (a helper first copies your bot's learning)
async function waitAndInject(g) {
  const token = ++g.token;
  for (let n = 0; n < 900 && token === g.token && !g.wc.isDestroyed(); n++) {
    if (await jsIn(g, '!!(window.unityInstance && document.getElementById("unity-canvas"))')) {
      await sleep(2500); if (token !== g.token) return;
      if (g.i && games[0]) {
        const snap = await js(`JSON.stringify(Object.fromEntries(${JSON.stringify(STORE_KEYS)}.map(k => [k, localStorage.getItem(k)])))`);
        if (snap) await jsIn(g, `(() => { const d = ${snap}; for (const k in d) if (d[k] != null) localStorage.setItem(k, d[k]); })()`);
      }
      await injectBot(g); g.injected = true;
      if (g.i === 0) { driveGoal = await js('window.ERBot && window.ERBot.v4cfg && window.ERBot.v4cfg.priority') || 'money'; driver = await js('window.ERBot && window.ERBot.v4cfg && window.ERBot.v4cfg.driver') || 'mix'; buildMenu(); }
      return;
    }
    await sleep(1000);
  }
}
// a game that hasn't started after 2 minutes gets reloaded (quietly: no pop-ups)
setInterval(() => { for (const g of games) if (!g.injected && g.loadedAt && Date.now() - g.loadedAt > 120000) loadGame(g); }, 15000);

/* ---------------- several games at once ---------------- */
function layout() {
  if (!win) return;
  const [W, H] = win.getContentSize(), n = games.length;
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols), w = Math.min(W / cols, (H / rows) * ASPECT);
    if (!best || w > best.w) best = { cols, rows, w };
  }
  const w = Math.floor(best.w), h = Math.floor(best.w / ASPECT);
  const x0 = Math.floor((W - w * best.cols) / 2), y0 = Math.floor((H - h * best.rows) / 2);
  games.forEach((g, k) => g.view.setBounds({ x: x0 + (k % best.cols) * w, y: y0 + Math.floor(k / best.cols) * h, width: w, height: h }));
}
function setGameCount(n) {
  while (games.length < n) { const g = makeGame(games.length); games.push(g); loadGame(g); }
  while (games.length > n) { const g = games.pop(); g.token++; win.contentView.removeChildView(g.view); try { g.wc.close(); } catch (e) {} }
  win.setAspectRatio(n === 1 ? ASPECT : 0);
  layout(); buildMenu();
}
// a lesson learned in one game is passed to all the others
ipcMain.on('erb-hub', (e, json) => {
  const from = games.find(g => g.wc === e.sender); if (!from) return;
  let msg; try { msg = JSON.parse(json); } catch (err) { return; }
  const text = JSON.stringify(msg);
  for (const g of games) if (g !== from && g.injected) jsIn(g, `window.ERBot && window.ERBot.mergeDelta && window.ERBot.mergeDelta(${text})`);
});

/* ---------------- learning: export / import / forget / trainer ---------------- */
const snapshotCode = `JSON.stringify({ app: 'escape-road-bot', version: 1, saved: new Date().toISOString(), data: Object.fromEntries(${JSON.stringify(STORE_KEYS)}.map(k => [k, localStorage.getItem(k)])) })`;
// change your bot's saved learning safely: stop every game, write it on a plain page, start again
async function rewriteLearning(code) {
  for (const g of games) { g.token++; g.injected = false; await g.wc.loadURL(QUIET_URL).catch(() => {}); }
  await js(code);
  await sleep(300);
  loadAll();
}
async function exportLearning() {
  const data = await js(snapshotCode);
  if (!data) { dialog.showMessageBox(win, { type: 'warning', message: 'The game page is not ready yet.' }); return; }
  const r = await dialog.showSaveDialog(win, { title: 'Save what the bot has learned', defaultPath: path.join(app.getPath('documents'), 'escape-road-bot-learning.json'), filters: [{ name: 'Bot learning', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return;
  fs.writeFileSync(r.filePath, data);
  dialog.showMessageBox(win, { type: 'info', message: 'Saved.', detail: r.filePath });
}
function checkSave(obj) { if (!obj || obj.app !== 'escape-road-bot' || !obj.data || !obj.data.erbot_brain_v3) throw new Error('That is not an Escape Road Bot learning file.'); return obj; }
const writeDataCode = data => `(() => { const d = ${JSON.stringify(data)}; for (const k in d) { if (d[k] == null) continue; localStorage.setItem(k, typeof d[k] === 'string' ? d[k] : JSON.stringify(d[k])); } })()`;
async function importLearning() {
  const r = await dialog.showOpenDialog(win, { title: 'Load bot learning', filters: [{ name: 'Bot learning', extensions: ['json'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths.length) return;
  let obj; try { obj = checkSave(JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'))); } catch (e) { dialog.showMessageBox(win, { type: 'error', message: 'That file could not be loaded.', detail: String(e.message || e) }); return; }
  await rewriteLearning(writeDataCode(obj.data));
}
async function resetKey(keys, what) {
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Cancel', 'Forget it'], defaultId: 0, cancelId: 0, message: `Forget ${what}?`, detail: 'This cannot be undone (save your learning to a file first if you might want it back).' });
  if (r.response !== 1) return;
  await rewriteLearning(keys.map(k => `localStorage.removeItem(${JSON.stringify(k)});`).join(''));
}
ipcMain.handle('erb-get-save', async () => {
  const s = await js(snapshotCode); if (!s) throw new Error('The game is still loading. Try again in a moment.');
  const o = JSON.parse(s);   // a bot that hasn't learned anything yet still gets an (empty) brain to train
  if (!o.data.erbot_brain_v3) o.data.erbot_brain_v3 = JSON.stringify({ version: 3, samples: [], runs: [], humanSamples: 0 });
  return JSON.stringify(o);
});
ipcMain.handle('erb-apply-save', async (_e, text) => { const obj = checkSave(JSON.parse(text)); await rewriteLearning(writeDataCode(obj.data)); return true; });
const statsCode = `(() => { const E = window.ERBot; if (!E || !E.brain) return null; const B = E.brain, runs = B.runs || [];
  let human = 0, bot = 0, crash = 0, sim = 0; for (const x of B.samples) { if (x.sim) sim++; else if (x.w === 1) human++; else if (x.w < 0) crash++; else bot++; }
  const L = E.v4 && E.v4.learner, lv = E.level ? E.level() : {};
  return { on: !!E.enabled, mode: E.mode, goal: E.v4cfg && E.v4cfg.priority, now: E.mode === 'play' && E.stats.runStart ? (performance.now() - E.stats.runStart) / 1000 : 0,
    points: E.reward ? E.reward.run : 0, bestPoints: B.bestPoints || 0, level: lv.name || '', next: lv.next || null, totalRuns: runs.length,
    best: runs.reduce((a, r) => Math.max(a, r.dur || 0), 0), runs: runs.slice(-120).map(r => [r.dur || 0, r.points || 0, r.bags || 0, r.human ? 1 : 0]),
    samples: B.samples.length, human, bot, crash, sim, net: L ? { epochs: L.epochs, trained: !!L.trained, motion: !!L.motion } : null,
    pieces: E.mapStats ? E.mapStats().known : 0, rl: B.rl ? { updates: B.rl.updates || 0, games: B.rl.games || 0, steps: B.rl.steps || 0 } : null, driver: E.v4cfg && E.v4cfg.driver, bagsTaken: E.bagsTaken || 0, gaveUp: E.watchdog ? E.watchdog.quits : 0 }; })()`;
ipcMain.handle('erb-get-stats', async () => {
  const bot = games[0] && games[0].injected ? await js(statsCode) : null;
  const list = [];
  for (const g of games) list.push({ i: g.i, running: g.injected, mode: g.injected ? await jsIn(g, 'window.ERBot && window.ERBot.mode') : 'loading' });
  return JSON.stringify({ bot, games: list });
});
// what the bots aim for: cash first, survive first, or explore the map
let driveGoal = null, driver = 'mix';
async function setDriver(d) {
  driver = d;
  const code = `(() => { let c = {}; try { c = JSON.parse(localStorage.getItem('erbot_v4_config') || '{}') || {}; } catch (e) {} c.driver = ${JSON.stringify(d)}; localStorage.setItem('erbot_v4_config', JSON.stringify(c)); window.ERBot && window.ERBot.setDriver && window.ERBot.setDriver(${JSON.stringify(d)}); })()`;
  for (const g of games) await jsIn(g, code);
  buildMenu();
}
async function setDriveGoal(goal) {
  driveGoal = goal;
  const code = `(() => { let c = {}; try { c = JSON.parse(localStorage.getItem('erbot_v4_config') || '{}') || {}; } catch (e) {} c.priority = ${JSON.stringify(goal)}; localStorage.setItem('erbot_v4_config', JSON.stringify(c)); window.ERBot && window.ERBot.setPriority && window.ERBot.setPriority(${JSON.stringify(goal)}); })()`;
  for (const g of games) await jsIn(g, code);
  buildMenu();
}
function openTrainer() {
  if (trainerWin && !trainerWin.isDestroyed()) { trainerWin.focus(); return; }
  trainerWin = new BrowserWindow({ width: 1240, height: 860, backgroundColor: '#0e1117', title: 'Escape Road Bot Trainer', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload-trainer.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  trainerWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  trainerWin.loadFile(path.join(__dirname, 'trainer', 'index.html'));
}

/* ---------------- title bar ---------------- */
async function updateTitle() {
  if (!win || win.isDestroyed()) return;
  const extra = games.length > 1 ? `  |  ${games.length} games learning together (${games.filter(g => g.injected).length} running)` : '';
  if (!games[0] || !games[0].injected) { win.setTitle('Escape Road Bot - loading the game (the first time can take a while)...' + extra); return; }
  const s = await js(`(() => { const E = window.ERBot; if (!E) return null; const B = E.brain || {}; const runs = (B.runs || []);
    const fmt = s => Math.floor(s/60) + ':' + String(Math.floor(s%60)).padStart(2, '0');
    const best = runs.reduce((a, r) => Math.max(a, r.dur), E.stats ? E.stats.best : 0);
    return (E.enabled ? 'BOT ON' : 'bot off') + (E.mode2 === 'teach' && E.humanActive && E.humanActive() ? ' (you are driving - learning)' : '') +
      '  |  points ' + Math.round(E.reward ? E.reward.run : 0) + ' (best ' + Math.round(B.bestPoints || 0) + ')  |  ' + (E.level ? E.level().name : '') + '  |  attempts ' + runs.length + '  |  best time ' + fmt(best) + '  |  lessons from you ' + (B.humanSamples || 0); })()`);
  if (s) win.setTitle('Escape Road Bot - ' + s + extra + (updateNote ? '  |  ' + updateNote : ''));
}

/* ---------------- updates ---------------- */
const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i]||0) > (y[i]||0)) return true; if ((x[i]||0) < (y[i]||0)) return false; } return false; };
const cacheDir = () => path.join(app.getPath('userData'), 'bot-update');
function loadCachedBot() {
  try {
    const v = fs.readFileSync(path.join(cacheDir(), 'version.txt'), 'utf8').trim();
    if (newer(v, BOT_VERSION)) { BOT_CODE = fs.readFileSync(path.join(cacheDir(), 'bot.js'), 'utf8'); BOT_VERSION = v; }
  } catch (e) {}
}
async function getText(url) { const r = await net.fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }
let appUpdateOffered = false;
async function checkUpdates(manual) {
  let info;
  try { info = JSON.parse(await getText(UPDATE_BASE + 'version.json')); } catch (e) { if (manual) dialog.showMessageBox(win, { type: 'warning', message: 'Could not check for updates.', detail: String(e.message || e) }); return; }
  // 1) the bot itself: download and swap in while the game keeps running (learning is kept)
  if (info.bot && newer(info.bot, BOT_VERSION)) {
    try {
      const code = await getText(UPDATE_BASE + (info.botFile || 'bot.js'));
      if (code.length > 20000 && code.includes('window.ERBot')) {
        fs.mkdirSync(cacheDir(), { recursive: true });
        fs.writeFileSync(path.join(cacheDir(), 'bot.js'), code); fs.writeFileSync(path.join(cacheDir(), 'version.txt'), info.bot);
        BOT_CODE = code; BOT_VERSION = info.bot; updateNote = 'updated to bot ' + info.bot; setTimeout(() => { updateNote = ''; }, 30000);
        for (const g of games) if (g.injected) await injectBot(g);
      }
    } catch (e) {}
  }
  // 2) the app around it (menus, trainer, launcher): its files are downloaded into the app's own
  //    data folder and used from the next start; nothing in the program folder is replaced
  let appMsg = null;
  if (info.app && Array.isArray(info.appFiles) && newer(info.app, APP_VERSION)) {
    try { await downloadAppUpdate(info); appMsg = 'ready'; } catch (e) { appMsg = 'failed: ' + (e.message || e); }
  }
  if (appMsg === 'ready' && !appUpdateOffered) {
    appUpdateOffered = true; updateNote = 'app ' + info.app + ' ready: restart to use it';
    if (process.env.ERB_SELFTEST_UPDATE) return;
    const r = await dialog.showMessageBox(win, { type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1, message: 'Escape Road Bot ' + info.app + ' is downloaded.', detail: (info.notes || '') + '\n\nRestart now to use it (or it starts by itself next time you open the app). Everything the bot learned is kept.' });
    if (process.env.ERB_SELFTEST_UPDATE) return;
    if (r.response === 0) { app.relaunch(); app.exit(0); }
  } else if (manual) {
    dialog.showMessageBox(win, { type: appMsg && appMsg.startsWith('failed') ? 'warning' : 'info',
      message: appMsg && appMsg.startsWith('failed') ? 'The app update could not be downloaded.' : 'Everything is up to date.',
      detail: `App ${APP_VERSION}, bot ${BOT_VERSION}.` + (appMsg && appMsg.startsWith('failed') ? '\n' + appMsg : '') });
  }
}
const updateDir = () => path.join(app.getPath('userData'), 'app-update');
async function downloadAppUpdate(info) {
  // already downloaded?
  try { if (JSON.parse(fs.readFileSync(path.join(updateDir(), 'package.json'), 'utf8')).version === info.app) return; } catch (e) {}
  const tmp = updateDir() + '.download';
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of info.appFiles) {
    if (!/^[\w\-./]+$/.test(f) || f.includes('..')) throw new Error('bad file name ' + f);
    const r = await net.fetch(UPDATE_BASE + 'app/' + f + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(f + ': HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
    fs.writeFileSync(path.join(tmp, f), buf);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
  if (pkg.version !== info.app || !fs.readFileSync(path.join(tmp, 'app-main.js'), 'utf8').includes('APP_VERSION')) throw new Error('the download was incomplete');
  fs.rmSync(updateDir(), { recursive: true, force: true });
  fs.renameSync(tmp, updateDir());
}

function buildMenu() {
  const n = games.length;
  const all = code => games.forEach(g => jsIn(g, code));
  const t = [
    { label: 'Bot', submenu: [
      { label: 'Start / stop the bot', accelerator: 'F8', click: () => all('window.ERBot && (window.ERBot.enabled ? window.ERBot.stop() : window.ERBot.start())') },
      { label: 'Start automatically', type: 'checkbox', checked: autoStart, click: m => { autoStart = m.checked; } },
      { label: 'Show / hide status bar', accelerator: 'F9', click: () => all('window.ERBot && window.ERBot.toggleHud()') },
      { label: 'What the stats mean', accelerator: 'H', registerAccelerator: false, click: () => js('window.ERBot && window.ERBot.toggleHelp && window.ERBot.toggleHelp()') },
      { label: 'Sound on / off', accelerator: 'F7', click: () => { muted = !muted; games.forEach((g, k) => g.wc.setAudioMuted(muted || k > 0)); js(`window.ERBot && (window.ERBot.muted = ${muted}, window.ERBot.muted || [...window.ERBot.audioCtxs].forEach(c => c.resume && AudioContext.prototype.resume.call(c)))`); } },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' },
    ] },
    { label: 'Training', submenu: [
      ...[1, 2, 3, 4, 6].map(k => ({ label: k === 1 ? 'Play 1 game (normal)' : `Play ${k} games at once (learns ${k}x faster, needs a strong computer)`, type: 'radio', checked: n === k, click: () => setGameCount(k) })),
      { type: 'separator' },
      { label: 'Goal: cash first', type: 'radio', checked: driveGoal === 'money' || !driveGoal, click: () => setDriveGoal('money') },
      { label: 'Goal: survive first (grab cash on the way)', type: 'radio', checked: driveGoal === 'pro', click: () => setDriveGoal('pro') },
      { label: 'Goal: explore the map (drive to streets it hasn\'t seen)', type: 'radio', checked: driveGoal === 'explore', click: () => setDriveGoal('explore') },
      { type: 'separator' },
      { label: 'Driver: planner + learned brains (safest)', type: 'radio', checked: driver !== 'rl', click: () => setDriver('mix') },
      { label: 'Driver: RL brain only (train it in the trainer first)', type: 'radio', checked: driver === 'rl', click: () => setDriver('rl') },
      { type: 'separator' },
      { label: 'Open the trainer (RL training, practice, live stats)...', accelerator: 'CmdOrCtrl+T', click: openTrainer },
    ] },
    { label: 'Learning', submenu: [
      { label: 'Open the trainer...', click: openTrainer },
      { label: 'Save learning to a file...', click: exportLearning },
      { label: 'Load learning from a file...', click: importLearning },
      { type: 'separator' },
      { label: 'Forget driving lessons and attempts...', click: () => resetKey(['erbot_brain_v3'], 'everything it learned about driving') },
      { label: 'Forget the map...', click: () => resetKey(['erbot_map_v1', 'erbot_prefabs_v1'], 'the map it has learned') },
    ] },
    { label: 'View', submenu: [
      { label: 'Reload the game', accelerator: 'F5', click: loadAll },
      { label: 'Full screen', accelerator: 'F11', click: () => win.setFullScreen(!win.isFullScreen()) },
      { label: 'Developer tools', accelerator: 'F12', click: () => games[0] && games[0].wc.toggleDevTools() },
    ] },
    { label: 'Help', submenu: [
      { label: 'How it works', click: () => dialog.showMessageBox(win, { type: 'info', title: 'Escape Road Bot', message: 'How it works', detail:
        'The bot drives by itself, dodges cops and traffic, and goes for the green cash stacks.\n\n' +
        'Teach it: press A / D (or the arrow keys) at any time in the first game. It hands you the wheel and records what you do, then takes over again about 1.5 seconds after you let go.\n\n' +
        'Training > Play several games at once: extra games run side by side and every lesson any of them learns is shared with all of them. Only the first game is yours; the others are helpers.\n\n' +
        'Training > Open the trainer: clean its driving data, train its brain, choose how it plays, test it, then send it back to the bot.\n\n' +
        'H what the stats mean  -  F8 start/stop  -  F9 status bar  -  F7 sound  -  F5 reload  -  F11 full screen  -  Ctrl+T trainer.' }) },
      { label: 'Check for updates', click: () => checkUpdates(true) },
      { label: 'About', click: () => dialog.showMessageBox(win, { type: 'info', message: 'Escape Road Bot ' + APP_VERSION, detail: 'Bot version ' + BOT_VERSION + '\nUpdates come from github.com/toomanygames/toomanygames.github.io (escape-road-bot folder)' }) },
      { label: 'Open the game site', click: () => shell.openExternal('https://azgames.io/escape-road-3') },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

app.whenReady().then(() => {
  app.on('web-contents-created', (_e, wc) => { wc.setWindowOpenHandler(() => ({ action: 'deny' })); wc.on('will-prevent-unload', e => e.preventDefault()); });
  win = new BrowserWindow({ width: 1280, height: 800, minWidth: 800, minHeight: 500, backgroundColor: '#16181e', title: 'Escape Road Bot', icon: path.join(__dirname, 'icon.png') });
  win.on('resize', layout);
  loadCachedBot();
  setGameCount(Math.max(1, Math.min(6, Number(process.env.ERB_GAMES) || 1)));
  setInterval(updateTitle, 1000);
  setTimeout(() => checkUpdates(false), 5000);
  setInterval(() => checkUpdates(false), 20*60*1000);
  if (process.env.ERB_SELFTEST) setTimeout(async () => {
    if (process.env.ERB_SELFTEST_UPDATE) { await checkUpdates(false); console.log('UPDATEDIR', JSON.stringify(fs.existsSync(updateDir()) ? fs.readdirSync(updateDir()) : null)); }
    console.log('APPVERSION', APP_VERSION, __dirname);
    if (process.env.ERB_SELFTEST_GARAGE) { console.log('PREFS', await js('ERBot.readPrefs().then(p => JSON.stringify(p), e => "err " + e)')); console.log('BEFORE', await js('ERBot.beforeRun().then(() => JSON.stringify({ money: ERBot.money, gs: ERBot.garageState, err: ERBot.err || null, hooks: Object.keys(ERBot.hooks), roadExtra: typeof ERBot.roadExtra, swap: ERBot.dmg.phase }))')); }
    const out = [];
    for (const g of games) out.push(await jsIn(g, 'JSON.stringify({ url: location.href, ref: document.referrer, bot: !!window.ERBot, v: window.ERBOT_VERSION, worker: window.__erbWorker, hub: !!window.__erbHub, enabled: window.ERBot && window.ERBot.enabled, samples: window.ERBot && window.ERBot.brain && window.ERBot.brain.samples.length, ls: (localStorage.getItem("erbot_brain_v3") || "").length })'));
    console.log('SELFTEST', JSON.stringify(out), 'title=', win.getTitle());
    if (process.env.ERB_SELFTEST_HUB && games[1]) {
      await jsIn(games[1], 'window.__erbHub.push(JSON.stringify({ from: 1, samples: [{ f: Array(31).fill(0.5), u: 1, w: 1 }], run: { dur: 12, bags: 1, points: 30 }, points: 30 }))');
      await sleep(1500);
      console.log('HUB', await js('JSON.stringify({ samples: ERBot.brain.samples.length, runs: ERBot.brain.runs.length, career: ERBot.brain.careerPoints })'));
    }
    if (process.env.ERB_SELFTEST_RL) {
      openTrainer(); await sleep(5000);
      const tw = trainerWin.webContents;
      await tw.executeJavaScript('document.getElementById("rlMin").value = 1; document.getElementById("rlBtn").click(); 1');
      for (let k = 0; k < 150; k++) { await sleep(1000); const m = await tw.executeJavaScript('document.getElementById("rlMsg").textContent'); if (/^Done|stopped/.test(m)) { console.log('RLMSG', m); break; } }
      console.log('RLRES', await tw.executeJavaScript('document.getElementById("rlResults").innerText.replace(/\\n/g, " | ")'));
      console.log('SEND', await tw.executeJavaScript('document.getElementById("dlBtn").click(); new Promise(r => setTimeout(() => r(document.getElementById("toast").textContent), 4000))'));
      await sleep(10000);
      await setDriver('rl');
      console.log('BOTRL', await js('JSON.stringify({ rl: !!(ERBot.rl && ERBot.rl()), upd: ERBot.rl() && ERBot.rl().updates, driver: ERBot.v4cfg.driver, hud: document.getElementById("erb-hud").innerText.replace(/\\n/g, " | ") })'));
      console.log('AWR', await js('(() => { const ag = ERBot.rl(); const D = Array.from({ length: 60 }, (_, i) => ({ f: Array(31).fill(0.4), pf: null, u: i % 3 - 1, b: 0, ret: i % 2 ? 5 : -5 })); const r = ag.awrUpdate(D); return JSON.stringify({ r, games: ag.games }); })()'));
      console.log('LIVE', await tw.executeJavaScript('new Promise(r => setTimeout(() => r(document.getElementById("liveTiles").innerText.replace(/\\n/g, " | ")), 2500))'));
    }
    if (process.env.ERB_SELFTEST_PRACTICE) {
      await setDriveGoal('explore');
      console.log('GOAL', await js('window.ERBot.v4cfg.priority + " " + localStorage.getItem("erbot_v4_config")'));
      openTrainer(); await sleep(5000);
      const tw = trainerWin.webContents;
      await tw.executeJavaScript('document.getElementById("pCount").value = 10; document.getElementById("practiceBtn").click(); 1');
      for (let k = 0; k < 60; k++) { await sleep(1000); const m = await tw.executeJavaScript('document.getElementById("practiceMsg").textContent'); if (/^Done/.test(m)) break; }
      console.log('PRACTICE', await tw.executeJavaScript('document.getElementById("practiceResults").innerText.replace(/\\n/g, " | ")'));
      console.log('TILES', await tw.executeJavaScript('document.getElementById("tiles").innerText.replace(/\\n/g, " | ")'));
      console.log('LIVE', await tw.executeJavaScript('document.getElementById("livePanel").hidden + " " + document.getElementById("liveState").textContent + " || " + document.getElementById("liveTiles").innerText.replace(/\\n/g, " | ")'));
      console.log('SEND', await tw.executeJavaScript('document.getElementById("dlBtn").click(); new Promise(r => setTimeout(() => r(document.getElementById("toast").textContent), 4000))'));
      await sleep(9000);
      console.log('AFTER', await js('JSON.stringify({ samples: ERBot.brain.samples.length, sim: ERBot.brain.samples.filter(x => x.sim).length, prio: ERBot.v4cfg.priority })'));
    }
    if (process.env.ERB_SELFTEST_TRAINER) { openTrainer(); await sleep(6000); console.log('TRAINER', await trainerWin.webContents.executeJavaScript('document.querySelector("#tiles") && document.querySelector("#tiles").innerText.slice(0,300) + " | btn=" + document.getElementById("dlBtn").textContent'));
      if (process.env.ERB_SELFTEST_APPLY) { console.log('APPLY', await trainerWin.webContents.executeJavaScript('window.erbHost.applySave(JSON.stringify({ app: "escape-road-bot", version: 1, data: { erbot_brain_v3: JSON.stringify({ version: 3, samples: Array.from({ length: 7 }, () => ({ f: Array(31).fill(0.3), u: 0, w: 1 })), runs: [] }), erbot_v4_config: JSON.stringify({ priority: "pro" }) } })).then(r => "ok " + r, e => "fail " + e.message)'));
        await sleep(9000); for (const g of games) console.log('AFTER', await jsIn(g, 'JSON.stringify({ worker: window.__erbWorker, samples: window.ERBot && ERBot.brain.samples.length, prio: window.ERBot && ERBot.v4cfg && ERBot.v4cfg.priority })')); }
    }
    app.quit();
  }, Number(process.env.ERB_SELFTEST) || 15000);
});
app.on('window-all-closed', () => app.quit());
