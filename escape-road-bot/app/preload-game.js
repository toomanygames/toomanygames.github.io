// Runs in each game page before the game's own scripts (same world: contextIsolation is off).
const { ipcRenderer } = require('electron');
// The game sends visitors with no referrer to its home page. Say we came from the game's site.
try { Object.defineProperty(Document.prototype, 'referrer', { get() { return 'https://azgames.io/escape-road-3'; }, configurable: true }); } catch (e) {}
// When several games play at once, each one shares what it learns through the app.
window.__erbHub = { push: json => ipcRenderer.send('erb-hub', String(json).slice(0, 4e6)) };
