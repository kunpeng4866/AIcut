// Electron main process — AIcut Desktop
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { spawn } from 'child_process';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

let mainWindow: BrowserWindow | null = null;
const ENGINE_BIN = join(__dirname, '../../target/debug/aicut-engine.exe');

function callEngine(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ENGINE_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout?.on('data', (d: Buffer) => stdout += d.toString());
    child.stderr?.on('data', (d: Buffer) => stderr += d.toString());
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `exit ${code}`));
    });
    child.on('error', reject);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'AIcut - Video Editor',
  });
  mainWindow.loadURL('http://localhost:5173');
}

// ── IPC Handlers ──

ipcMain.handle('engine:render', async (_e, projectJson: string) => {
  const tmp = join(app.getPath('temp'), `aicut-${Date.now()}.json`);
  await writeFile(tmp, projectJson, 'utf8');
  try {
    const cmd = await callEngine('render', tmp);
    return { success: true, command: cmd };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('engine:probe', async (_e, filePath: string) => {
  try {
    const json = await callEngine('probe', filePath);
    return { success: true, info: JSON.parse(json) };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('engine:presets', async () => {
  const json = await callEngine('presets');
  return JSON.parse(json);
});

ipcMain.handle('engine:version', async () => callEngine('version'));

ipcMain.handle('engine:validate', async (_e, projectJson: string) => {
  const tmp = join(app.getPath('temp'), `aicut-validate-${Date.now()}.json`);
  await writeFile(tmp, projectJson, 'utf8');
  try {
    const result = await callEngine('validate', tmp);
    return { valid: true };
  } catch (e: any) {
    return { valid: false, errors: [e.message] };
  }
});

ipcMain.handle('dialog:openFiles', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'mp3', 'wav', 'jpg', 'png', 'webp'] }],
  });
  return result.filePaths;
});

ipcMain.handle('file:saveProject', async (_e, path: string, content: string) => {
  await writeFile(path, content, 'utf8');
  return true;
});

ipcMain.handle('file:loadProject', async (_e, path: string) => {
  return await readFile(path, 'utf8');
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
