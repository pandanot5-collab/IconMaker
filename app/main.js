const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, net } = require('electron');
const fetch = (...a) => net.fetch(...a);
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = Number(process.env.ICONMAKER_PORT) || 37420;
let win = null;
let lastModel = null;
let settings = {};

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const cacheDir = () => path.join(app.getPath('userData'), 'asset-cache');

function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { settings = {}; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#17181c',
    title: 'Icon Maker',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile('index.html');
}

// ---------------------------------------------------------------------------
// Local HTTP server the Studio plugin posts to
// ---------------------------------------------------------------------------
function startServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/ping') {
      res.end(JSON.stringify({ ok: true, app: 'IconMaker' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/model') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        lastModel = Buffer.concat(chunks).toString('utf8');
        if (win && !win.isDestroyed()) win.webContents.send('model', lastModel);
        res.end('{"ok":true}');
      });
      return;
    }
    res.statusCode = 404;
    res.end('{"ok":false}');
  });
  server.on('error', (e) => {
    dialog.showErrorBox('Icon Maker', `Could not start local server on port ${PORT}:\n${e.message}\n\nIs another copy of Icon Maker running?`);
  });
  server.listen(PORT, '127.0.0.1');
}

// ---------------------------------------------------------------------------
// Asset downloading (fallback when the plugin could not read an asset)
// ---------------------------------------------------------------------------
function findStudioContent() {
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'Roblox', 'Versions'),
    'C:\\Program Files (x86)\\Roblox\\Versions',
    'C:\\Program Files\\Roblox\\Versions',
  ];
  let best = null;
  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { continue; }
    for (const d of dirs) {
      const exe = path.join(root, d, 'RobloxStudioBeta.exe');
      try {
        const t = fs.statSync(exe).mtimeMs;
        if (!best || t > best.t) best = { t, dir: path.join(root, d, 'content') };
      } catch { /* not a studio install */ }
    }
  }
  return best && best.dir;
}

function parseId(ref) {
  const m = /rbxassetid:\/\/(\d+)/i.exec(ref) || /[?&]id=(\d+)/i.exec(ref) || /^(\d+)$/.exec(ref);
  return m ? m[1] : null;
}

function maybeGunzip(buf) {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf);
  return buf;
}

async function download(id) {
  if (settings.apiKey) {
    const r = await fetch(`https://apis.roblox.com/asset-delivery-api/v1/assetId/${id}`, {
      headers: { 'x-api-key': settings.apiKey },
    });
    if (!r.ok) throw new Error(`Open Cloud returned HTTP ${r.status} for asset ${id}`);
    const j = await r.json();
    const loc = j.location || (j.locations && j.locations[0] && j.locations[0].location);
    if (!loc) throw new Error(`No download location for asset ${id}`);
    const r2 = await fetch(loc);
    if (!r2.ok) throw new Error(`CDN returned HTTP ${r2.status} for asset ${id}`);
    return Buffer.from(await r2.arrayBuffer());
  }
  const headers = { 'User-Agent': 'Roblox/WinInet' };
  if (settings.cookie) headers.Cookie = `.ROBLOSECURITY=${settings.cookie.trim()}`;
  const r = await fetch(`https://assetdelivery.roblox.com/v1/asset/?id=${id}`, { headers });
  if (!r.ok) {
    const hint = settings.cookie ? '' : ' — add a cookie or Open Cloud API key in Settings';
    throw new Error(`HTTP ${r.status} for asset ${id}${hint}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

// Public, no sign-in needed: Roblox's thumbnail service renders image assets as PNG (max 420px).
async function downloadThumbnail(id) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`https://thumbnails.roblox.com/v1/assets?assetIds=${id}&returnPolicy=PlaceHolder&size=420x420&format=Png&isCircular=false`);
    if (!r.ok) throw new Error(`Thumbnail service returned HTTP ${r.status} for asset ${id}`);
    const item = (await r.json()).data?.[0];
    if (item?.state === 'Completed' && item.imageUrl) {
      const img = await fetch(item.imageUrl);
      if (!img.ok) throw new Error(`Thumbnail CDN returned HTTP ${img.status} for asset ${id}`);
      return Buffer.from(await img.arrayBuffer());
    }
    if (item && item.state !== 'Pending') throw new Error(`No image available for asset ${id} (${item.state})`);
    await new Promise((res) => setTimeout(res, 700));
  }
  throw new Error(`Thumbnail for asset ${id} is still pending`);
}

async function fetchAsset(ref, kind) {
  if (ref.startsWith('rbxasset://')) {
    const content = findStudioContent();
    if (!content) throw new Error('Roblox Studio install not found for ' + ref);
    return fs.readFileSync(path.join(content, ref.slice('rbxasset://'.length)));
  }
  const id = parseId(ref);
  if (!id) throw new Error('Unsupported asset reference: ' + ref);
  const file = path.join(cacheDir(), id);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  let buf;
  try {
    buf = maybeGunzip(await download(id));
  } catch (e) {
    if (kind !== 'image') throw e;
    const thumbFile = file + '.thumb.png';
    if (fs.existsSync(thumbFile)) return fs.readFileSync(thumbFile);
    buf = await downloadThumbnail(id);
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(thumbFile, buf);
    return buf;
  }
  fs.mkdirSync(cacheDir(), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('fetch-asset', (_e, ref, kind) => fetchAsset(ref, kind));
ipcMain.handle('get-last-model', () => lastModel);
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('set-settings', (_e, s) => {
  settings = { ...settings, ...s };
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  return true;
});
ipcMain.handle('clear-cache', () => {
  fs.rmSync(cacheDir(), { recursive: true, force: true });
  return true;
});
ipcMain.handle('save-png', async (_e, dataUrl, name) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: name,
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return filePath;
});
ipcMain.handle('copy-png', (_e, dataUrl) => {
  clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
  return true;
});

app.whenReady().then(() => {
  loadSettings();
  startServer();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
