// Electron main process — AIcut Desktop
import { app, BrowserWindow, ipcMain, dialog, protocol, session, shell, clipboard } from 'electron';
import { spawn } from 'child_process';
import { readFile, writeFile, mkdir, readdir, unlink, stat, rename } from 'fs/promises';
import { mkdirSync, existsSync } from 'fs';
import { createReadStream, createWriteStream } from 'fs';
import { Readable } from 'stream';
import { join, dirname, basename, delimiter } from 'path';
import { pathToFileURL } from 'url';
import { createHash } from 'crypto';
import { applyExportOptions, applyAudioExport, buildSubtitleExport, parseShellArgs, type ExportOptionsParam } from './exportOptions';
import { getManifest, DEFAULT_CDN_BASE } from './assets-manifest';

let mainWindow: BrowserWindow | null = null;
const ENGINE_BIN = app.isPackaged
  ? join(process.resourcesPath, 'engine', 'aicut-engine.exe')
  : join(__dirname, '../../target/debug/aicut-engine.exe');

// 让引擎 CLI（plugin:list / render 子进程）能定位插件目录（仓库根/plugins）。
// render 子进程继承此环境变量，因而应用插件也会在导出时生效。
try { process.env.AICUT_PLUGIN_DIR = join(__dirname, '../../plugins'); } catch { /* dev 兜底 */ }

// 内置字体目录：传给 Rust 引擎，导出时 drawtext 用 fontfile= 指向随包字体，保证预览/导出一致。
try { process.env.AICUT_FONTS_DIR = getFontsDir(); } catch { /* dev 兜底 */ }

// 口播剪辑：托管 Python 解释器（已装齐 faster-whisper/silero-vad/demucs）+ bridge.py 路径
try {
  process.env.AICUT_PYTHON_BIN = process.env.AICUT_PYTHON_BIN
    || 'C:\\Users\\Administrator\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe';
  process.env.AICUT_SPEECH_BRIDGE = join(__dirname, '../../python/speech_edit/bridge.py');
  process.env.AICUT_KEYING_BRIDGE = join(__dirname, '../../python/keying/bridge.py');
  process.env.AICUT_SR_BRIDGE = join(__dirname, '../../python/sr/bridge.py');
} catch { /* dev 兜底 */ }

// 打包模式：覆盖为随包自包含路径（resources/），使分发包在任意机器离线运行。
// 这些环境变量会被 spawn 的引擎子进程继承；Rust 端已支持 AICUT_PYTHON_BIN / AICUT_*_BRIDGE 覆盖。
if (app.isPackaged) {
  const res = process.resourcesPath;
  process.env.AICUT_PLUGIN_DIR = join(res, 'plugins');
  process.env.AICUT_FONTS_DIR = join(res, 'fonts');
  const ff = join(res, 'ffmpeg');
  process.env.PATH = `${ff}${delimiter}${process.env.PATH || ''}`;
  process.env.AICUT_FFMPEG = join(ff, 'ffmpeg.exe');
  process.env.AICUT_FFPROBE = join(ff, 'ffprobe.exe');
  // ⚠️ python / models 不再在打包块硬编码：精简版不含它们，改由 setupAssetEnv()
  // 在 app ready 后按「resources 优先、否则回退 userData/aicut-assets」解析（见下方定义）。
}

// ── 路径常量 ──
function getConfigPath() { return join(app.getPath('userData'), 'config.json'); }
function getDraftsDir() { return join(app.getPath('userData'), 'drafts'); }

// ── 补全资产（一键补全）路径解析 ──
// 精简版安装包不含 python / models；下载后落到 userData/aicut-assets/（可写目录）。
// Windows 下 resources/ 对标准用户只读，故回退到此目录，让 AICUT_* 变量自动指过去。
function assetsDir(): string {
  return join(app.getPath('userData'), 'aicut-assets');
}
function resolveAsset(sub: string, name: string): string {
  const res = join(process.resourcesPath, sub, name);
  try { if (existsSync(res)) return res; } catch { /* 忽略 */ }
  return join(assetsDir(), sub, name);
}
// 在 app ready 后调用：按「resources 优先、否则回退 userData」解析 python / models 环境变量（仅打包模式）。
function setupAssetEnv() {
  if (!app.isPackaged) return; // 开发模式沿用上方 dev 块
  const pyResolved = existsSync(join(process.resourcesPath, 'python', 'python.exe'))
    ? join(process.resourcesPath, 'python')
    : join(assetsDir(), 'python');
  process.env.AICUT_PYTHON_BIN = join(pyResolved, 'python.exe');
  process.env.AICUT_SPEECH_BRIDGE = join(pyResolved, 'speech_edit', 'bridge.py');
  process.env.AICUT_KEYING_BRIDGE = join(pyResolved, 'keying', 'bridge.py');
  process.env.AICUT_SR_BRIDGE = join(pyResolved, 'sr', 'bridge.py');
  // 每个模型独立解析（resources 内置优先，否则回退 userData/aicut-assets 下载目录）。
  // rmbg2 为可选下载，可能与内置 modnet 落在不同目录，故不能用同一个 mResolved。
  process.env.AICUT_RMBG2_MODEL = resolveAsset('models', 'rmbg2.onnx');
  process.env.AICUT_MODNET_MODEL = resolveAsset('models', 'modnet.onnx');
  process.env.AICUT_SR_MODEL = resolveAsset('models', 'sr_v0_test.onnx');
}

// 内置字体目录：
// 开发模式 → 仓库 gui/public/fonts（vite 以 /fonts/* 提供，且预览渲染层直接读取）
// 打包模式 → 安装包 resources/fonts（electron-builder extraResources 拷贝）
// 该目录同时传递给 Rust 引擎子进程（AICUT_FONTS_DIR），用于导出时 drawtext 的 fontfile=
function getFontsDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'fonts');
  }
  // 开发：从 main.js(dist-electron) 向上两级到 gui，再进 public/fonts
  return join(__dirname, '..', 'public', 'fonts');
}

// ── 自定义协议 aicut-asset:// ──
// 绕过系统代理直接读取本地文件，修复 file:// 走代理导致 SSL handshake failed
function registerAssetProtocol() {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'aicut-asset',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false,
      corsEnabled: true,
    },
  }]);
}

// ── 引擎调用 ──
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

// ── 引擎二进制 ↔ 源码一致性校验 ──
// 问题：改 Rust 源码后忘跑 cargo build，ENGINE_BIN 是旧二进制，静默“改了没生效”。
// 方案：比对 src/*.rs（及 build.rs/Cargo.toml）最新 mtime 与二进制 mtime，
//      源码较新则开发模式下自动 `cargo build --offline` 重建，失败弹窗提示。

const SRC_ROOT = join(__dirname, '../../src');
const REPO_ROOT = join(__dirname, '../..');

async function newestSourceMtime(dir: string): Promise<number> {
  let newest = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        newest = Math.max(newest, await newestSourceMtime(p));
      } else if (e.name.endsWith('.rs')) {
        newest = Math.max(newest, (await stat(p)).mtimeMs);
      }
    }
  } catch { /* 目录不存在等，忽略 */ }
  return newest;
}

async function rebuildEngine(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('cargo', ['build', '--offline'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[cargo] ${d}`));
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `cargo build 退出码 ${code}`))));
    child.on('error', reject);
  });
}

async function ensureEngineFresh(): Promise<void> {
  if (app.isPackaged) return; // 打包模式引擎随包，无源码树，跳过
  try {
    const binMtime = (await stat(ENGINE_BIN)).mtimeMs;
    const srcMtime = Math.max(
      await newestSourceMtime(SRC_ROOT),
      ...(await Promise.all(['build.rs', 'Cargo.toml'].map(async (f) => {
        try { return (await stat(join(REPO_ROOT, f))).mtimeMs; } catch { return 0; }
      }))),
    );
    if (srcMtime <= binMtime) return; // 源码未变，二进制最新
    console.log('[engine] 检测到源码较新，自动重建引擎 (cargo build --offline) ...');
  } catch {
    console.log('[engine] 引擎二进制缺失，自动重建 (cargo build --offline) ...');
  }
  await rebuildEngine();
}

function getWindowIconPath(): string {
  if (app.isPackaged) {
    return join(__dirname, '..', 'dist', 'icon.ico');
  }
  return join(__dirname, '..', 'public', 'icon.ico');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900,
    minWidth: 1200, minHeight: 700,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'AIcut - Video Editor',
    backgroundColor: '#1a1a2e',
    icon: getWindowIconPath(),
  });
  // 生产模式：加载构建产物；开发模式：连 Vite dev server
  const isDev = !!process.env.VITE_DEV_SERVER_URL;
  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'));
  }

  // 监听 renderer 控制台消息，便于排查 SSL/视频播放问题
  mainWindow.webContents.on('console-message', (_event, level, message, _line, _sourceId) => {
    const prefix = ['VERBOSE', 'INFO', 'WARNING', 'ERROR'][level] || 'LOG';
    console.log(`[renderer:${prefix}] ${message}`);
  });

  // 自动截图（启动后 3 秒）
  mainWindow.webContents.on('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const image = await mainWindow!.webContents.capturePage();
        const screenshotPath = join(app.getPath('userData'), 'aicut_screenshot.png');
        await writeFile(screenshotPath, image.toPNG());
        console.log(`Screenshot saved: ${screenshotPath}`);
      } catch (e) {
        console.error('Screenshot failed:', e);
      }
    }, 3000);
  });
}

// ═══════════════════════════════════════════
// IPC Handlers
// ═══════════════════════════════════════════

// ── 引擎 ──
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
    await callEngine('validate', tmp);
    return { valid: true };
  } catch (e: any) {
    return { valid: false, errors: [e.message] };
  }
});

// ── 文件对话框 ──
ipcMain.handle('dialog:openFiles', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg', 'wma', 'ac3', 'aiff', 'opus', 'jpg', 'png', 'webp', 'bmp', 'gif', 'srt', 'ass', 'vtt'] }],
  });
  return result.filePaths;
});

// 打开工程文件：过滤器限定 AIcut Project (json)，避免与素材导入的 Media 过滤器冲突
ipcMain.handle('dialog:openProject', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
    filters: [
      { name: 'AIcut Project', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result.filePaths;
});

ipcMain.handle('dialog:saveFile', async (_e, defaultName?: string) => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: defaultName || 'project.json',
    filters: [{ name: 'AIcut Project', extensions: ['json'] }],
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('dialog:exportFile', async (_e, params?: { kind?: string; defaultName?: string }) => {
  const kind = params?.kind || 'video';
  const defaultName = params?.defaultName || 'output.mp4';

  // 「保存类型」下拉按导出类型动态生成，避免字幕/音频找不到对应扩展名
  const filtersByKind: Record<string, { name: string; extensions: string[] }[]> = {
    video: [
      { name: 'MP4 Video', extensions: ['mp4'] },
      { name: 'MOV Video', extensions: ['mov'] },
      { name: 'MKV Video', extensions: ['mkv'] },
      { name: 'WebM Video', extensions: ['webm'] },
    ],
    audio: [
      { name: 'MP3 Audio', extensions: ['mp3'] },
      { name: 'WAV Audio', extensions: ['wav'] },
      { name: 'M4A Audio', extensions: ['m4a'] },
    ],
    subtitle: [
      { name: 'SRT 字幕', extensions: ['srt'] },
      { name: 'ASS 字幕', extensions: ['ass'] },
      { name: 'VTT 字幕', extensions: ['vtt'] },
    ],
  };
  const result = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: defaultName,
    filters: [...(filtersByKind[kind] || filtersByKind.video), { name: 'All Files', extensions: ['*'] }],
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('file:saveProject', async (_e, path: string, content: string) => {
  await writeFile(path, content, 'utf8');
  return true;
});

ipcMain.handle('file:loadProject', async (_e, path: string) => {
  return await readFile(path, 'utf8');
});

// 读取任意文本文件内容（字幕 .srt/.ass/.vtt 导入时在渲染层解析用）
ipcMain.handle('file:readText', async (_e, path: string) => {
  return await readFile(path, 'utf8');
});

// ── AI 配置 ──
ipcMain.handle('config:get', async () => {
  try {
    const content = await readFile(getConfigPath(), 'utf8');
    return content;
  } catch {
    // 配置文件不存在，返回默认配置
    return JSON.stringify(getDefaultConfig());
  }
});

ipcMain.handle('config:set', async (_e, json: string) => {
  try {
    await writeFile(getConfigPath(), json, 'utf8');
    return true;
  } catch (e: any) {
    return false;
  }
});

// ── 补全资产（一键补全）──
// 精简版不含 python / 模型；本段提供「探测缺失 + 从 CDN 下载 + sha256 校验 + 解压」能力。
// 主进程 Node fetch 走系统代理可能因 Misty 等失败，故下载时临时清空代理环境变量强制直连。

async function readCdnBaseUrl(): Promise<string | undefined> {
  try {
    const c = JSON.parse(await readFile(getConfigPath(), 'utf8'));
    return c?.assets?.cdnBaseUrl;
  } catch {
    return undefined;
  }
}

// 临时清空代理环境变量，强制 Node fetch 直连（避免系统代理 Misty 干扰 HTTPS）
async function withDirectNetwork<T>(fn: () => Promise<T>): Promise<T> {
  const keys = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy', 'npm_proxy', 'NPM_PROXY'];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) { saved[k] = process.env[k]; process.env[k] = ''; }
  try {
    return await fn();
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

// 流式下载 + 断点续传 + sha256 校验。dest 为最终路径，过程写 dest.part。
async function streamDownload(
  url: string,
  dest: string,
  expectedSha256: string,
  onProgress?: (received: number, total: number) => void,
): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const partPath = dest + '.part';
  let start = 0;
  try { start = (await stat(partPath)).size; } catch { start = 0; }
  const headers: Record<string, string> = start > 0 ? { Range: `bytes=${start}-` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok && res.status !== 206) throw new Error(`下载失败 HTTP ${res.status}: ${url}`);
  // 服务器不支持 Range 时会返回 200 全量：此时必须丢弃已有片段从头重写，
  // 否则以 'a' 追加会把整段内容拼在旧数据后面，产出损坏文件且哈希必然不符。
  const resumed = start > 0 && res.status === 206;
  if (!resumed) start = 0;
  const remoteLen = parseInt(res.headers.get('content-length') || '0', 10) || 0;
  const total = remoteLen > 0 ? remoteLen + start : (start || 1);
  const fileStream = createWriteStream(partPath, { flags: resumed ? 'a' : 'w' });
  const hash = createHash('sha256');
  if (resumed && expectedSha256) {
    // 已下载部分计入哈希（避免续传后整体哈希错位）
    const prev = createReadStream(partPath, { start: 0, end: start - 1 });
    for await (const chunk of prev) hash.update(chunk as Buffer);
  }
  const reader = res.body!.getReader();
  let received = start;
  let lastTick = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength) {
      const buf = Buffer.from(value);
      // 背压：内核缓冲写满时等 drain，避免 GB 级下载把数据全堆进内存
      if (!fileStream.write(buf)) {
        await new Promise<void>((r) => fileStream.once('drain', r));
      }
      hash.update(buf);
      received += buf.byteLength;
      // 进度节流 200ms：1.8G / 16K chunk 逾十万次 IPC 会拖死渲染进程
      const now = Date.now();
      if (now - lastTick >= 200) { lastTick = now; onProgress?.(received, total); }
    }
  }
  onProgress?.(received, total);
  await new Promise<void>((resolve, reject) => fileStream.end((err?: Error | null) => (err ? reject(err) : resolve())));
  const actual = hash.digest('hex');
  if (expectedSha256 && actual.toLowerCase() !== expectedSha256.toLowerCase()) {
    await unlink(partPath).catch(() => {});
    throw new Error(`校验失败：sha256 不匹配（期望 ${expectedSha256}，实得 ${actual}）`);
  }
  await rename(partPath, dest);
}

// 多源下载兜底：依次尝试候选 URL，前一个失败则换下一个。各源字节一致（同一 sha256），
// .part 断点续传可跨源安全衔接。
async function downloadWithFallback(
  urls: string[],
  dest: string,
  expectedSha256: string,
  onProgress?: (received: number, total: number) => void,
): Promise<void> {
  let lastErr: any = new Error('无可用下载源');
  for (const url of urls) {
    try {
      await withDirectNetwork(() => streamDownload(url, dest, expectedSha256, onProgress));
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// 解压 zip（Windows 内置 Expand-Archive）
async function extractZip(zipPath: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const p = spawn('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -Path "${zipPath}" -DestinationPath "${targetDir}"`]);
    let err = '';
    p.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `解压失败 退出码 ${code}`))));
    p.on('error', reject);
  });
}

ipcMain.handle('assets:status', async () => {
  const manifest = getManifest(await readCdnBaseUrl());
  const status: Record<string, boolean> = {};
  for (const e of manifest.entries) {
    if (e.kind === 'file') {
      status[e.id] = existsSync(resolveAsset(e.targetSub, e.targetName));
    } else {
      // zip：resources 或 userData 中的 python 目录含 python.exe 即视为就绪
      status[e.id] = existsSync(join(resolveAsset(e.targetSub, ''), 'python.exe'));
    }
  }
  return {
    baseUrl: manifest.baseUrl,
    isPlaceholder: manifest.baseUrl === DEFAULT_CDN_BASE,
    status,
    entries: manifest.entries.map((e) => ({ id: e.id, name: e.name, size: e.size, requiredBy: e.requiredBy, hasDirect: !!(e.domesticUrl || e.externalUrl || e.absoluteUrl) })),
  };
});

ipcMain.handle('assets:download', async (event, opts?: { ids?: string[] }) => {
  const manifest = getManifest(await readCdnBaseUrl());
  const ids = opts?.ids && opts.ids.length ? opts.ids : manifest.entries.map((e) => e.id);
  const entries = manifest.entries.filter((e) => ids.includes(e.id));
  // 仅当待下载条目中「存在无任何直链（domestic/external/absolute）的条目」时才要求
  // CDN 基础地址已配置；有免费镜像直链的条目（rmbg2/qwen3_fa/frcrn 等）不依赖 cdnBaseUrl。
  const hasAnyDirect = (e: typeof entries[number]) => !!(e.domesticUrl || e.externalUrl || e.absoluteUrl);
  if (manifest.baseUrl === DEFAULT_CDN_BASE && entries.some((e) => !hasAnyDirect(e))) {
    const msg = '当前条目缺少免费镜像直链且未配置自建 CDN：请先在「设置 → AI 组件管理」中填写 CDN 基础地址，再执行补全。';
    event.sender.send('assets:progress', { phase: 'error', error: msg });
    return { success: false, error: msg };
  }
  let doneCount = 0;
  for (const e of entries) {
    const cdnUrl = manifest.baseUrl.replace(/\/$/, '') + '/' + e.remoteRel;
    // 开源免费分发策略：国内免费镜像优先（ModelScope，实测可 fetch），失败自动回退
    // 外网直链（huggingface.co/github，海外或代理用户），再回退旧 absoluteUrl，
    // 最后回退用户自建 CDN（若已配置）。任一候选哈希校验不过即尝试下一候选。
    const urlCandidates: string[] = [];
    for (const u of [e.domesticUrl, e.externalUrl, e.absoluteUrl]) {
      if (u && !urlCandidates.includes(u)) urlCandidates.push(u);
    }
    if (manifest.baseUrl !== DEFAULT_CDN_BASE && !urlCandidates.includes(cdnUrl)) {
      urlCandidates.push(cdnUrl);
    }
    const urls = urlCandidates;
    event.sender.send('assets:progress', { id: e.id, name: e.name, phase: 'start', received: 0, total: e.size, percent: 0 });
    try {
      if (e.kind === 'file') {
        const dest = resolveAsset(e.targetSub, e.targetName);
        // rmbg2 走 ModelScope 直链（absoluteUrl）时 sha256 同样校验：实测 ModelScope LFS 对象
        // 路径即编码了该哈希，与清单一致，保留校验可防 1GB 大文件传输损坏。
        const expectedSha = e.sha256;
        await downloadWithFallback(urls, dest, expectedSha, (recv, total) => {
          event.sender.send('assets:progress', { id: e.id, name: e.name, phase: 'downloading', received: recv, total, percent: total ? recv / total : 0 });
        });
      } else {
        const tmp = join(assetsDir(), e.targetName + '.partdl');
        await downloadWithFallback(urls, tmp, e.sha256, (recv, total) => {
          event.sender.send('assets:progress', { id: e.id, name: e.name, phase: 'downloading', received: recv, total, percent: total ? recv / total : 0 });
        });
        event.sender.send('assets:progress', { id: e.id, name: e.name, phase: 'extracting', received: e.size, total: e.size, percent: 1 });
        // python.zip 内部已自带顶层 `python/` 目录（Compress-Archive 压缩目录的默认行为），
        // 故解压到 assetsDir() 根；若解到 assetsDir()/python 会套成 python/python/python.exe，
        // 令 assets:status 的 python.exe 探测永远失败。
        await extractZip(tmp, assetsDir());
        await unlink(tmp).catch(() => {});
      }
      doneCount++;
      event.sender.send('assets:progress', { id: e.id, name: e.name, phase: 'done', received: e.size, total: e.size, percent: 1, doneCount, totalCount: entries.length });
    } catch (err: any) {
      const msg = `下载「${e.name}」失败：${err?.message ?? String(err)}`;
      event.sender.send('assets:progress', { id: e.id, name: e.name, phase: 'error', error: msg });
      return { success: false, error: msg };
    }
  }
  // 刷新 AICUT_* 环境变量，使后续引擎子进程指向补全目录
  setupAssetEnv();
  return { success: true, doneCount };
});

// ── TTS 语音合成 ──
// 前端只传 (text, voice)；输出临时 wav 路径由本 handler 在服务端生成，
// 按 config.tts.provider 分流到火山引擎 / CosyVoice（百炼）引擎命令。
ipcMain.handle('tts:synthesize', async (_e, text: string, voice: string) => {
  try {
    const configContent = await readFile(getConfigPath(), 'utf8');
    const config = JSON.parse(configContent);
    const tts = config.tts || {};
    const provider = tts.provider;

    if (provider !== 'volcano' && provider !== 'cosyvoice') {
      return { success: false, error: 'TTS 未配置：请先在设置中选择「火山引擎」或「CosyVoice」服务商' };
    }

    // 服务端生成唯一临时 wav 输出路径（避免前端传路径带来的安全/路径约定问题）
    const dir = join(app.getPath('temp'), 'aicut-tts');
    mkdirSync(dir, { recursive: true });
    const outPath = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);

    const usedVoice = voice || tts.defaultVoice ||
      (provider === 'cosyvoice' ? 'longxiaochun' : 'BV002_streaming');

    if (provider === 'volcano') {
      if (!tts.appId || !tts.accessToken) {
        return { success: false, error: '火山引擎 TTS 未配置：请先在设置填写 AppID 与 Access Token' };
      }
      await callEngine(
        'tts',
        '--provider', 'volcano',
        '--appid', tts.appId,
        '--token', tts.accessToken,
        '--text', text,
        '--voice', usedVoice,
        '--output', outPath,
      );
    } else {
      // cosyvoice：appId 即 DashScope API Key（token 引擎忽略）
      if (!tts.appId) {
        return { success: false, error: 'CosyVoice 未配置：请先在设置填写 DashScope API Key' };
      }
      await callEngine(
        'tts',
        '--provider', 'cosyvoice',
        '--appid', tts.appId,
        '--token', '',
        '--text', text,
        '--voice', usedVoice,
        '--output', outPath,
        '--model', tts.model || 'cosyvoice-v3.5-plus',
      );
    }
    return { success: true, audioPath: outPath };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
});

ipcMain.handle('tts:voices', async () => {
  return JSON.stringify([
    { id: 'BV002_streaming', name: '通用女声' },
    { id: 'BV700_streaming', name: '灿灿' },
    { id: 'BV701_streaming', name: '擎苍' },
  ]);
});

// ── AI 自动字幕 / 翻译 ──
// 读取 config.json 里的 DeepSeek key，注入引擎进程环境变量（engine 的 ai.rs 读 DEEPSEEK_API_KEY）。
async function injectDeepSeekKey(): Promise<void> {
  try {
    const config = JSON.parse(await readFile(getConfigPath(), 'utf8'));
    process.env.DEEPSEEK_API_KEY = config.ai?.apiKey || '';
  } catch {
    process.env.DEEPSEEK_API_KEY = '';
  }
}

// 前端把 ASR 转写文本交给后端，由 aicut-engine 调 DeepSeek 切分为时间轴字幕。
ipcMain.handle('ai:generateSubtitles', async (_e, transcript: string, lang: string) => {
  if (!transcript || !transcript.trim()) {
    return { success: false, error: '转写文本为空' };
  }
  const tmp = join(app.getPath('temp'), `aicut-ai-${Date.now()}.txt`);
  try {
    await injectDeepSeekKey();
    await writeFile(tmp, transcript, 'utf8');
    const stdout = await callEngine('ai', 'subtitles', tmp, lang || 'zh');
    const data = JSON.parse(stdout);
    if (!data || !Array.isArray(data.items)) {
      return { success: false, error: 'AI 返回数据缺少合法的 items 数组' };
    }
    return { success: true, data };
  } catch (e: any) {
    return { success: false, error: e?.message ?? String(e) };
  } finally {
    unlink(tmp).catch(() => {});
  }
});

// 前端把源句（换行拼接）交给后端翻译，返回换行拼接的译文（逐行保序）。
ipcMain.handle('ai:translate', async (_e, text: string, targetLang: string) => {
  if (!text || !text.trim()) {
    return { success: false, error: '翻译文本为空' };
  }
  const tmp = join(app.getPath('temp'), `aicut-translate-${Date.now()}.txt`);
  try {
    await injectDeepSeekKey();
    await writeFile(tmp, text, 'utf8');
    const translated = await callEngine('ai', 'translate', tmp, targetLang || 'en');
    if (!translated || !translated.trim()) {
      return { success: false, error: 'AI 返回空译文' };
    }
    return { success: true, data: { text: translated } };
  } catch (e: any) {
    return { success: false, error: e?.message ?? String(e) };
  } finally {
    unlink(tmp).catch(() => {});
  }
});

// ── ASR 语音转写 ──
// provider = 'bailian' → aicut-engine 走百炼（DashScope）云端转写；
// 其余（空 / whisper-local / whisper-api / custom）→ whisper.cpp 本地兜底（ffmpeg 抽轨 → whisper-cli -oj）。
// 参数顺序必须与 Rust CLI 约定严格一致：
//   asr transcribe <audio> <lang> <provider> <enginePath> <modelPath> <apiKey> <endpoint> <model>
ipcMain.handle('asr:transcribe', async (_e, audioPath: string, lang: string) => {
  const engineArgs: string[] = [];
  try {
    const configContent = await readFile(getConfigPath(), 'utf8');
    const config = JSON.parse(configContent);
    const asr = config.asr || {};
    const provider = asr.provider || '';
    const enginePath = asr.enginePath || 'E:\\codex\\codex-tools\\whisper\\whisper-cli.exe';
    const modelPath = asr.modelPath || 'E:\\codex\\codex-tools\\whisper\\ggml-base.bin';
    const apiKey = asr.apiKey || '';
    const endpoint = asr.endpoint || '';
    const model = asr.model || '';
    engineArgs.push('asr', 'transcribe', audioPath, lang || 'zh', provider, enginePath, modelPath, apiKey, endpoint, model);
    const stdout = await callEngine(...engineArgs);
    const data = JSON.parse(stdout);
    return { success: true, data };
  } catch (e: any) {
    return { success: false, error: e?.message ?? String(e) };
  }
});

// ── 口播剪辑（speech auto-editing）──
ipcMain.handle('speech:analyze', async (_e, input: string, optsJson: string) => {
  try {
    const stdout = await callEngine('speech', '--mode', 'analyze', '--input', input ?? '', '--opts', optsJson ?? '');
    const data = JSON.parse(stdout);
    return { success: true, data };
  } catch (e: any) {
    return { success: false, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('speech:assemble', async (_e, input: string, optsJson: string) => {
  try {
    const stdout = await callEngine('speech', '--mode', 'assemble', '--input', input ?? '', '--opts', optsJson ?? '');
    const data = JSON.parse(stdout);
    return { success: true, data };
  } catch (e: any) {
    return { success: false, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('speech:separate', async (_e, input: string, optsJson: string) => {
  try {
    const stdout = await callEngine('speech', '--mode', 'separate', '--input', input ?? '', '--opts', optsJson ?? '');
    const data = JSON.parse(stdout);
    return { success: true, data };
  } catch (e: any) {
    return { success: false, error: e?.message ?? String(e) };
  }
});

// ── 智能抠像 ──
// 与超清(sr:generate)同构：spawn 引擎子进程，解析其 stderr 上的 KEYPROG: 进度行，
// 通过 event.sender.send('keying:progress', ...) 实时推给渲染层；最终 JSON 结果仍走 stdout。
ipcMain.handle('keying:generate', (event, input: string, optsJson: string) => {
  return new Promise((resolve) => {
    // GUI 路径：前端已在 optsJson 内塞入真实 mode（matte/manual），
    // 绝不可像旧版那样硬编码 'matte' 覆盖，否则 manual 会被当成智能抠像、guide 被忽略。
    let mode = 'matte';
    try { mode = JSON.parse(optsJson ?? '{}')?.mode ?? 'matte'; } catch { /* 用默认 */ }
    const child = spawn(ENGINE_BIN, ['keying', '--mode', mode, '--input', input ?? '', '--opts', optsJson ?? ''], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString();
      stderr += text;
      // 解析 KEYPROG: 前缀的进度行，向渲染层推送 keying:progress 事件（含 stage/frame/total/fps/eta_sec）
      for (const raw of text.split('\n')) {
        const m = raw.match(/^KEYPROG:(.*)$/);
        if (m) {
          try { event.sender.send('keying:progress', JSON.parse(m[1])); } catch { /* 忽略坏行 */ }
        }
      }
    });
    child.on('close', (code) => {
      if (code === 0) {
        try {
          const data = JSON.parse(stdout.trim());
          // 收尾：推送 100% 完成事件，前端据此收起进度条
          event.sender.send('keying:progress', {
            stage: 'done', frame: data.frames ?? 0, total: data.frames ?? 0, done: true,
          });
          resolve({ success: true, data });
        } catch (e: any) {
          const msg = '抠像结果解析失败: ' + (e?.message ?? String(e));
          event.sender.send('keying:error', msg);
          resolve({ success: false, error: msg });
        }
      } else {
        const errMsg = stderr || `引擎退出码 ${code}`;
        event.sender.send('keying:error', errMsg);
        resolve({ success: false, error: errMsg });
      }
    });
    child.on('error', (e: any) => {
      const msg = e?.message ?? String(e);
      event.sender.send('keying:error', msg);
      resolve({ success: false, error: msg });
    });
  });
});

// ── 视频超清增强：逐帧 ONNX 超分，产出放大后的视频 ──
// 与导出（render:export）同构：直接 spawn 引擎子进程，解析其 stderr 上的 SRPROG: 进度行，
// 通过 event.sender.send('sr:progress', ...) 实时推给渲染层；最终 JSON 结果仍走 stdout。
ipcMain.handle('sr:generate', (event, input: string, optsJson: string) => {
  return new Promise((resolve) => {
    const child = spawn(ENGINE_BIN, ['sr', '--input', input ?? '', '--opts', optsJson ?? ''], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString();
      stderr += text;
      // 解析 SRPROG: 前缀的进度行，向渲染层推送 sr:progress 事件（含 stage/frame/total/fps/eta_sec）
      for (const raw of text.split('\n')) {
        const m = raw.match(/^SRPROG:(.*)$/);
        if (m) {
          try { event.sender.send('sr:progress', JSON.parse(m[1])); } catch { /* 忽略坏行 */ }
        }
      }
    });
    child.on('close', (code) => {
      if (code === 0) {
        try {
          const data = JSON.parse(stdout.trim());
          // 收尾：推送 100% 完成事件，前端据此收起进度条
          event.sender.send('sr:progress', {
            stage: 'done', frame: data.frames ?? 0, total: data.frames ?? 0, done: true,
          });
          resolve({ success: true, data });
        } catch (e: any) {
          const msg = '超清结果解析失败: ' + (e?.message ?? String(e));
          event.sender.send('sr:error', msg);
          resolve({ success: false, error: msg });
        }
      } else {
        const errMsg = stderr || `引擎退出码 ${code}`;
        event.sender.send('sr:error', errMsg);
        resolve({ success: false, error: errMsg });
      }
    });
    child.on('error', (e: any) => {
      const msg = e?.message ?? String(e);
      event.sender.send('sr:error', msg);
      resolve({ success: false, error: msg });
    });
  });
});

// ── 插件 ──
ipcMain.handle('plugin:list', async () => {
  try {
    return await callEngine('plugin', 'list');
  } catch {
    // 引擎子进程不可用时的兜底：直接读取插件目录下的 manifest.json，
    // 保证 GUI 仍可列出插件（仅导出/构建滤镜需要引擎）。
    try {
      const dir = process.env.AICUT_PLUGIN_DIR || join(__dirname, '../../plugins');
      const entries = await readdir(dir);
      const out: any[] = [];
      for (const name of entries) {
        try {
          const m = JSON.parse(await readFile(join(dir, name, 'manifest.json'), 'utf8'));
          out.push(m);
        } catch { /* 单个 manifest 解析失败则跳过 */ }
      }
      return JSON.stringify(out);
    } catch {
      return '[]';
    }
  }
});

ipcMain.handle('plugin:scan', async () => {
  try {
    const n = await callEngine('plugin', 'scan');
    return parseInt(n) || 0;
  } catch {
    return 0;
  }
});

ipcMain.handle('plugin:buildFilter', async (_e, pluginId: string, params: string) => {
  try {
    return await callEngine('plugin', 'build', pluginId, params);
  } catch (e: any) {
    return '';
  }
});

// ── 视频导出 ──
ipcMain.handle('render:export', async (_e, command: string, outputPath: string) => {
  return new Promise((resolve) => {
    // 解析FFmpeg命令，替换输出路径为用户选择的路径
    let ffmpegCmd = command.startsWith('ffmpeg') ? command.slice(6).trim() : command.trim();
    const args = parseShellArgs(ffmpegCmd);
    // 最后一个参数是输出文件名，替换为用户选择的路径
    if (args.length > 0) {
      args[args.length - 1] = outputPath;
    } else {
      args.push(outputPath);
    }
    const child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => stderr += d.toString());
    child.on('close', (code) => {
      if (code === 0) resolve({ success: true });
      else resolve({ success: false, error: stderr || `FFmpeg退出码: ${code}` });
    });
    child.on('error', (e) => resolve({ success: false, error: e.message }));
  });
});

// ── 抽取音频轨（口播试听对照轨专用）──
// 视频源产出的清洗 mp4 → 纯音频 m4a。原因：addClip 有「素材类型↔轨道类型」
// 纠偏守卫，视频资产放音频轨会被重定向回主视频轨（=原素材所在轨道），造成
// 试听片段覆盖原素材。抽成纯音频后天然落独立音频轨，源视频轨零改动。
ipcMain.handle('media:extract-audio', async (_e, srcPath: string, dstPath: string) => {
  return new Promise((resolve) => {
    const ff = process.env.AICUT_FFMPEG || 'ffmpeg';
    const child = spawn(ff, ['-y', '-i', srcPath, '-vn', '-map', '0:a:0', '-c:a', 'copy', dstPath],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve({ success: true, path: dstPath });
      else {
        const errLine = stderr.split('\n').filter((l) => l.includes('Error') || l.includes('error')).pop();
        resolve({ success: false, error: errLine || stderr.slice(-300) || `FFmpeg退出码: ${code}` });
      }
    });
    child.on('error', (e) => resolve({ success: false, error: e.message }));
  });
});

// ── 视频导出（带进度） ──
let currentExportProcess: ReturnType<typeof spawn> | null = null;

ipcMain.handle('export:start', async (event, params: { project: any; outputPath: string; options: ExportOptionsParam }) => {
  const { project, outputPath, options } = params;

  // ── 字幕导出：纯 JS 从工程 JSON 生成，不走 ffmpeg ──
  if (options.kind === 'subtitle') {
    try {
      const content = buildSubtitleExport(project, options.subtitleFormat || 'srt');
      if (!content || content.trim() === '') {
        const msg = '工程中没有可导出的字幕。请先在时间轴添加字幕片段（如用 ASR 生成字幕轨）。';
        event.sender.send('export:error', msg);
        return { success: false, error: msg };
      }
      await writeFile(outputPath, content, 'utf8');
      event.sender.send('export:done');
      return { success: true };
    } catch (e: any) {
      const msg = `字幕导出失败: ${e?.message || e}`;
      event.sender.send('export:error', msg);
      return { success: false, error: msg };
    }
  }

  const tmpProject = join(app.getPath('temp'), `aicut-export-${Date.now()}.json`);
  await writeFile(tmpProject, JSON.stringify(project), 'utf8');

  try {
    // 1. 获取 FFmpeg 命令字符串
    const cmd = await callEngine('render', tmpProject);
    let ffmpegCmd = cmd.startsWith('ffmpeg') ? cmd.slice(6).trim() : cmd.trim();
    let args = parseShellArgs(ffmpegCmd);

    // 2. 应用导出选项
    if (options.kind === 'audio') {
      // 音频：复用已有音频滤镜图，改造为仅导出音轨
      try {
        args = applyAudioExport(args, options);
      } catch (e: any) {
        const msg = e?.message === 'NO_AUDIO'
          ? '工程中没有音频可导出。请先添加带声音的素材或音频轨。'
          : `音频导出失败: ${e?.message || e}`;
        event.sender.send('export:error', msg);
        return { success: false, error: msg };
      }
      args.push(outputPath);
    } else {
      // 视频：分辨率/格式/质量
      args = applyExportOptions(args, options);
      if (args.length > 0) {
        args[args.length - 1] = outputPath;
      } else {
        args.push(outputPath);
      }
    }

    // 3. 计算工程总时长（用于进度计算）
    const totalDuration = computeProjectDuration(project);

    // 4. 启动 FFmpeg 进程
    return new Promise((resolve) => {
      currentExportProcess = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      currentExportProcess.stderr?.on('data', (d: Buffer) => {
        const text = d.toString();
        stderr += text;
        // 解析 time=00:00:xx.xx 行获取已导出时间
        const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (timeMatch && totalDuration > 0) {
          const elapsed = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
          const progress = Math.min(1, elapsed / totalDuration);
          event.sender.send('export:progress', progress);
        }
      });
      currentExportProcess.on('close', (code) => {
        currentExportProcess = null;
        if (code === 0) {
          event.sender.send('export:done');
          resolve({ success: true });
        } else {
          const errMsg = stderr || `FFmpeg退出码: ${code}`;
          // 完整 stderr 落盘，避免前端错误框截断导致无法定位真正错误
          const logPath = join(app.getPath('temp'), `aicut-export-error-${Date.now()}.log`);
          writeFile(logPath, `FFmpeg命令:\nffmpeg ${args.join(' ')}\n\n完整错误输出:\n${errMsg}`, 'utf8').catch(() => {});
          event.sender.send('export:error', errMsg);
          resolve({ success: false, error: `${errMsg}\n\n完整日志已写入:\n${logPath}` });
        }
      });
      currentExportProcess.on('error', (e) => {
        currentExportProcess = null;
        event.sender.send('export:error', e.message);
        resolve({ success: false, error: e.message });
      });
    });
  } catch (e: any) {
    const logPath = join(app.getPath('temp'), `aicut-export-error-${Date.now()}.log`);
    const detail = `导出异常:\n${(e && (e.stack || e.message)) || e}`;
    await writeFile(logPath, detail, 'utf8').catch(() => {});
    return { success: false, error: `${e?.message || e}\n\n完整日志已写入:\n${logPath}` };
  } finally {
    // 清理临时文件
    unlink(tmpProject).catch(() => {});
  }
});

ipcMain.handle('export:cancel', async () => {
  if (currentExportProcess) {
    currentExportProcess.kill('SIGTERM');
    currentExportProcess = null;
  }
  return true;
});

ipcMain.handle('export:openFolder', async (_e, filePath: string) => {
  if (filePath) {
    shell.showItemInFolder(filePath);
  }
  return true;
});

// 复制文本到系统剪贴板（替代前端 navigator.clipboard，避免 Electron 渲染进程无焦点/无权限时失效）
ipcMain.handle('clipboard:writeText', async (_e, text: string) => {
  try {
    clipboard.writeText(text || '');
    return true;
  } catch {
    return false;
  }
});

// ── 4K 源素材代理生成（预览用 720p 代理，保证 4K 源流畅） ──
// 仅当宽或高 > 1080 才生成；返回代理路径，无需代理或生成失败返回 ''。
ipcMain.handle('asset:ensureProxy', async (_e, params: { path: string; width: number; height: number }) => {
  const { path, width, height } = params;
  try {
    if (!path || width <= 1920 && height <= 1080) return '';
    const proxyDir = join(app.getPath('userData'), 'proxies');
    await mkdir(proxyDir, { recursive: true });
    const stem = basename(path).replace(/\.[^.]+$/, '');
    // 文件名带 _a 标记：历史代理用 -an 剥离了音轨（预览静音），改名使旧静音代理失效、重新生成含音轨版本
    const proxyPath = join(proxyDir, `${stem}_proxy_a.mp4`);
    // 代理已存在且不旧于源，直接复用
    try {
      const ps = await stat(proxyPath);
      const ss = await stat(path);
      if (ps.mtime.getTime() >= ss.mtime.getTime()) return proxyPath;
    } catch { /* 需重新生成 */ }
    await new Promise<void>((resolve) => {
      // 保留音轨（预览需出声）：原 -an 会剥离音频导致预览静音，改为转码为 AAC 拷贝进代理
      const p = spawn('ffmpeg', ['-y', '-i', path, '-vf', 'scale=-2:720', '-c:a', 'aac', '-b:a', '160k', '-c:v', 'libx264', '-preset', 'veryfast', proxyPath]);
      p.on('close', () => resolve());
      p.on('error', () => resolve());
    });
    return proxyPath;
  } catch {
    return '';
  }
});

// ── 草稿管理 ──
ipcMain.handle('draft:save', async (_e, name: string, content: string) => {
  try {
    await mkdir(getDraftsDir(), { recursive: true });
    const safeName = name.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');
    await writeFile(join(getDraftsDir(), `${safeName}.json`), content, 'utf8');
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('draft:load', async (_e, name: string) => {
  const safeName = name.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');
  return await readFile(join(getDraftsDir(), `${safeName}.json`), 'utf8');
});

ipcMain.handle('draft:list', async () => {
  try {
    const files = await readdir(getDraftsDir());
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
});

ipcMain.handle('draft:delete', async (_e, name: string) => {
  const safeName = name.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');
  try {
    await unlink(join(getDraftsDir(), `${safeName}.json`));
    return true;
  } catch {
    return false;
  }
});

// ── 内置字体目录（供渲染器/导出侧定位随包字体） ──
ipcMain.handle('fonts:getDir', async () => getFontsDir());

// ═══════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════

function getDefaultConfig() {
  return {
    version: '1.0',
    ai: { provider: 'none', apiKey: '', endpoint: '', model: '' },
    asr: { provider: 'bailian', enginePath: '', modelPath: '', ffmpegPath: '', apiKey: '', endpoint: '', model: 'qwen-audio-3.0-asr-flash-streaming' },
    tts: { provider: 'none', appId: '', accessToken: '', endpoint: '', defaultVoice: '' },
    render: { ffmpegPath: '', defaultResolution: '1080p', defaultFps: 30, defaultBitrate: 8 },
    plugins: { vfxDirectory: '', enabledPlugins: [] },
  };
}

/** 从工程数据计算总时长（秒） */
function computeProjectDuration(project: any): number {
  if (!project || !project.tracks) return 0;
  let max = 0;
  for (const track of project.tracks) {
    for (const clip of (track.clips || [])) {
      if (typeof clip.timelineOut === 'number' && clip.timelineOut > max) {
        max = clip.timelineOut;
      }
    }
  }
  return max;
}

// ═══════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════

// 注册自定义协议（必须在 app.ready 之前）
registerAssetProtocol();

// 进程级禁用代理 + 后台网络，彻底消除 SSL handshake failed
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('disable-features', 'NetworkServiceProxy');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-crash-reporter');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('disable-variations');
app.commandLine.appendSwitch('disable-client-side-phishing-detection');
// 启用 renderer 的 WebGPU（navigator.gpu），让插件 WGSL 滤镜预览可用；
// 若显卡/驱动不支持导致初始化失败，会自动回退 HTML5（CSS filter 兜底）。
app.commandLine.appendSwitch('enable-unsafe-webgpu');

app.whenReady().then(async () => {
  // 解析 python / models 环境变量（resources 优先，否则回退 userData/aicut-assets）
  setupAssetEnv();

  // 注册 aicut-asset:// 协议处理器：直接读取本地文件，绕过代理
  // 支持 Range 请求（Chromium <video> 需要才能播放和 seek）
  protocol.handle('aicut-asset', async (request) => {
    try {
      // 用 URL 对象解析，兼容多种 URL 格式
      // Chromium 会把 aicut-asset:///C:/path 规范化为 host='c', pathname='/path'
      // 需要从 hostname 恢复盘符
      const url = new URL(request.url);
      let filePath = url.pathname;
      if (process.platform === 'win32') {
        // 情况1: pathname 以 '/X:/' 开头（aicut-asset:///C:/path 未经 Chromium 规范化）
        if (/^\/[A-Za-z]:/.test(filePath)) {
          filePath = filePath.slice(1);
        }
        // 情况2: Chromium 把盘符解析为 hostname（aicut-asset://c/path → host='c'）
        else if (url.hostname && /^[a-zA-Z]$/.test(url.hostname)) {
          filePath = url.hostname.toUpperCase() + ':' + filePath;
        }
        // 情况3: hostname 是 localhost，pathname 含盘符（aicut-asset://localhost/C:/path）
        else if (/^\/[A-Za-z]:/.test(filePath)) {
          filePath = filePath.slice(1);
        }
      }
      filePath = decodeURIComponent(filePath);

      // 获取文件信息
      const fileStat = await stat(filePath);
      const fileSize = fileStat.size;

      // MIME 类型
      const ext = filePath.match(/\.[a-z0-9]+$/i)?.[0].toLowerCase() || '';
      const mimeMap: Record<string, string> = {
        '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
        '.avi': 'video/x-msvideo', '.webm': 'video/webm',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac', '.flac': 'audio/flac',
        '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wma': 'audio/x-ms-wma', '.ac3': 'audio/ac3',
        '.aiff': 'audio/aiff', '.opus': 'audio/opus', '.m4b': 'audio/mp4', '.m4r': 'audio/mp4',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.webp': 'image/webp', '.bmp': 'image/bmp', '.gif': 'image/gif',
      };
      const mime = mimeMap[ext] || 'application/octet-stream';

      // 处理 Range 请求（Chromium <video> 会发送 Range: bytes=0- 来分段加载）
      const rangeHeader = request.headers.get('range') || request.headers.get('Range');
      if (rangeHeader) {
        const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
        if (m) {
          const start = parseInt(m[1]);
          const end = m[2] ? parseInt(m[2]) : fileSize - 1;
          const chunkSize = end - start + 1;
          const nodeStream = createReadStream(filePath, { start, end });
          const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
          return new Response(webStream, {
            status: 206,
            headers: {
              'Content-Type': mime,
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': chunkSize.toString(),
              'Access-Control-Allow-Origin': '*',
            },
          });
        }
      }

      // 全量返回（非 Range 请求）
      const nodeStream = createReadStream(filePath);
      const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
      return new Response(webStream, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Accept-Ranges': 'bytes',
          'Content-Length': fileSize.toString(),
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (e: any) {
      console.error('[aicut-asset] Error:', e.message, 'url:', request.url);
      return new Response(`File not found: ${e.message}`, { status: 404 });
    }
  });

  // 禁用代理用于本地请求（防止系统代理 Misty 干扰 file:// 和 aicut-asset://）
  await session.defaultSession.setProxy({
    proxyRules: 'direct://',
  });

  // 确保草稿目录存在
  mkdir(getDraftsDir(), { recursive: true }).catch(() => {});

  // 校验引擎二进制与源码是否脱节（开发模式自动重建），失败时弹窗提示而非静默用旧二进制
  try {
    await ensureEngineFresh();
  } catch (e: any) {
    console.error('[engine] 引擎构建失败:', e?.message ?? e);
    dialog.showErrorBox(
      '引擎构建失败',
      `Rust 引擎构建失败，请在仓库根目录手动运行 cargo build --offline：\n\n${e?.message ?? e}`,
    );
  }

  createWindow();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
