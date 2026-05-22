const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, nativeImage } = require('electron');
const path = require('path');

let win = null;
let tray = null;

function createTrayIcon() {
  // Create a simple tomato-red circle icon programmatically (16x16 RGBA)
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const radius = 6;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - center;
      const dy = y - center;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * size + x) * 4;

      if (dist <= radius) {
        buffer[idx] = 255;     // R
        buffer[idx + 1] = 69;  // G
        buffer[idx + 2] = 55;  // B
        buffer[idx + 3] = 255; // A
      } else if (dist <= radius + 1) {
        // Anti-aliased edge
        const alpha = Math.max(0, 1 - (dist - radius));
        buffer[idx] = 255;
        buffer[idx + 1] = 69;
        buffer[idx + 2] = 55;
        buffer[idx + 3] = Math.round(255 * alpha);
      }
    }
  }

  return nativeImage.createFromBuffer(buffer, { width: size, height: size });
}

function createWindow() {
  win = new BrowserWindow({
    width: 400,
    height: 600,
    minWidth: 350,
    minHeight: 500,
    backgroundColor: '#1a1a2e',
    title: '番茄时钟',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile('index.html');

  // Intercept close → hide to tray
  win.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('番茄时钟');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        win.show();
        win.focus();
      },
    },
    { type: 'separator' },
    {
      label: '开始 / 暂停',
      click: () => {
        win.webContents.send('tray-action', { action: 'toggle' });
      },
    },
    {
      label: '重置',
      click: () => {
        win.webContents.send('tray-action', { action: 'reset' });
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    win.show();
    win.focus();
  });
}

// IPC handlers
ipcMain.handle('notify', (event, { title, body }) => {
  if (Notification.isSupported()) {
    const notification = new Notification({ title, body });
    notification.on('click', () => {
      if (win) {
        win.show();
        win.focus();
      }
    });
    notification.show();
  }
});

ipcMain.handle('update-tray-title', (event, { text }) => {
  if (tray) {
    tray.setToolTip(text);
  }
});

// App lifecycle
app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  // Don't quit on window-all-closed since we hide to tray
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('activate', () => {
  if (win) {
    win.show();
  }
});
