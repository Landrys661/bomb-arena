/* =============================================================================
 * Bomb Arena - Electron main process
 * -----------------------------------------------------------------------------
 * Wraps the SAME web client (public/) as a desktop app. By default it also
 * hosts the bundled game server in-process ("Host Locally") so a user can run a
 * LAN / same-network match straight from the app; others join at the host's
 * IP:PORT. To JOIN a hosted server instead, open in-app Settings and set the
 * server URL (the client then connects there regardless of where it loaded).
 *
 * Env:
 *   BOMB_ARENA_PORT   local host port (default 3000)
 *   BOMB_ARENA_NOHOST set to "1" to skip hosting (pure client; uses Settings URL)
 * ===========================================================================*/
'use strict';
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

const PORT = Number(process.env.BOMB_ARENA_PORT || 3000);
const HOST = process.env.BOMB_ARENA_NOHOST !== '1';

function startLocalServer() {
  if (!HOST) return;
  try {
    process.env.PORT = String(PORT);
    require(path.join(__dirname, '..', 'server.js')).startServer(PORT);
  } catch (e) { console.error('Local server failed to start:', e); }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1024, height: 768, minWidth: 640, minHeight: 480,
    backgroundColor: '#0b0b16',
    autoHideMenuBar: true,
    title: 'Bomb Arena',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  // open external links in the system browser, not inside the app
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  if (HOST) {
    win.loadURL(`http://localhost:${PORT}`);            // served by our local server (same-origin)
  } else {
    win.loadFile(path.join(__dirname, '..', 'public', 'index.html')); // pure client; Settings URL used
  }
}

app.whenReady().then(() => {
  startLocalServer();
  // small delay so the local server is listening before the window connects
  setTimeout(createWindow, HOST ? 500 : 0);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
