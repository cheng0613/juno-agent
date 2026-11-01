import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

process.env.ELECTRON_OVERRIDE_DIST_PATH = 'C:/Users/chiaki/Desktop/agent/upstream/cindy/node_modules/electron/dist';

await app.whenReady();
const win = new BrowserWindow({
  width: 1440, height: 900, show: false,
  webPreferences: { offscreen: true },
});
await win.loadFile(path.resolve('design/juno-cindy-style.html'));
await new Promise(r => setTimeout(r, 1200));
const img = await win.webContents.capturePage();
fs.writeFileSync('.tmp/mockup-preview.png', img.toPNG());
console.log('截图完成');
app.quit();
