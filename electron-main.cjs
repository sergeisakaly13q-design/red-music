const { app, BrowserWindow, shell, session } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#070707',
    title: 'Red Music',
    icon: path.join(__dirname, 'resources', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, 'public', 'index.html'));
}

app.whenReady().then(() => {
  // Desktop Electron builds load index.html from file://, so Chromium can
  // send an opaque Origin ("null") to the Render API. Inject the native
  // client marker and a valid application Origin for every Red Music API
  // request. This keeps CSRF protection enabled while making login/register
  // work reliably in the desktop builds.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://red-music.onrender.com/api/*'] },
    (details, callback) => {
      details.requestHeaders['X-Red-Music-Client'] = '1';
      details.requestHeaders['Origin'] = 'https://red-music.onrender.com';
      details.requestHeaders['Referer'] = 'https://red-music.onrender.com/';
      callback({ cancel: false, requestHeaders: details.requestHeaders });
    }
  );

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
