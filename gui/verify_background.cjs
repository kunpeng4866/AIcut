/**
 * 背景合成 真实 App 预览验证（CDP 驱动，复用 app-cdp-verify 技能模式）
 * 启动真实 AIcut → 加载带 chroma 抠像 + 红色背景的绿幕工程 → 选 clip、切抠像面板 →
 * 截图全图与预览画布，并断言：背景配置已生效、抠像面板渲染了背景类型按钮。
 */
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECT_DIR = __dirname;
const ELECTRON_BIN = path.join(PROJECT_DIR, 'node_modules/electron/dist/electron.exe');
const DEBUG_PORT = 9223;
const OUT_DIR = path.join(PROJECT_DIR, '.workbuddy/tmp_keying_test');
const PROJECT = 'E:/AIcut/.workbuddy/tmp_keying_test/bg_color_project.json';
fs.mkdirSync(OUT_DIR, { recursive: true });

const cleanEnv = { ...process.env };
delete cleanEnv.NODE_OPTIONS;
delete cleanEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(ELECTRON_BIN, ['.', `--remote-debugging-port=${DEBUG_PORT}`], {
  cwd: PROJECT_DIR, env: cleanEnv, detached: true, stdio: 'ignore',
});
function killApp() { try { process.kill(-child.pid, 'SIGKILL'); } catch {} try { child.kill('SIGKILL'); } catch {} }
process.on('exit', killApp);
process.on('SIGINT', () => { killApp(); process.exit(1); });

(async () => {
  await new Promise(r => setTimeout(r, 9000));
  const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => !/chrome-devtools|background/.test(p.url())) || ctx.pages()[0];
  if (!page) throw new Error('找不到 renderer 页');
  console.log('PAGE URL:', page.url());

  // 加载工程 + 选 clip + 切抠像面板（绕过 canvas 时间轴点击）
  const storeState = await page.evaluate(async () => {
    const ps0 = window.__projectStore.getState();
    await ps0.loadProject('E:/AIcut/.workbuddy/tmp_keying_test/bg_color_project.json');
    const ps = window.__projectStore.getState(); // loadProject 后必须重新取最新 state
    const clip = (ps.project.tracks || []).flatMap(t => t.clips || []).find(c => c.id === 'clip_1');
    window.__uiStore.getState().selectClip('track_video1', 'clip_1');
    window.__uiStore.getState().setActiveRightPanel('keying');
    return {
      clipId: clip && clip.id,
      rawKeying: clip ? clip.keying : 'NO_CLIP',
      keyingEnabled: !!(clip && clip.keying && clip.keying.enabled),
      bgType: clip && clip.keying && clip.keying.background && clip.keying.background.type,
      bgColor: clip && clip.keying && clip.keying.background && clip.keying.background.color,
      activePanel: window.__uiStore.getState().activeRightPanel,
      trackCount: (ps.project.tracks || []).length,
    };
  });
  console.log('STORE:', JSON.stringify(storeState));
  await page.waitForTimeout(2500); // 等预览渲染抠像+背景

  // 断言面板渲染了背景类型按钮（纯色/图片/视频/无）
  const panel = await page.evaluate(() => {
    const txt = document.body.innerText || '';
    return {
      hasNone: txt.includes('无'),
      hasColor: txt.includes('纯色'),
      hasImage: txt.includes('图片'),
      hasVideo: txt.includes('视频'),
      hasBgTitle: txt.includes('背景合成'),
    };
  });
  console.log('PANEL:', JSON.stringify(panel));

  // 截图：全图 + 预览画布（WebGPU 画布由合成器输出，截图可捕获）
  const appShot = path.join(OUT_DIR, 'bg_verify_app.png');
  const prevShot = path.join(OUT_DIR, 'bg_verify_preview.png');
  await page.screenshot({ path: appShot });
  const canvas = await page.$('canvas');
  if (canvas) await canvas.screenshot({ path: prevShot }).catch(() => {});

  const pass = storeState.bgType === 'color' && storeState.keyingEnabled
    && panel.hasBgTitle && panel.hasColor && panel.hasImage && panel.hasVideo;
  console.log('RESULT:', pass ? 'PASS' : 'FAIL',
    '| bgType=' + storeState.bgType, '| enabled=' + storeState.keyingEnabled);
  await browser.close();
  killApp();
  process.exit(pass ? 0 : 2);
})().catch(e => { console.log('ERROR:', e.message); killApp(); process.exit(1); });
