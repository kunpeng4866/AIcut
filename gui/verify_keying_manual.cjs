// Dev verification harness for AIcut manual keying paint canvas.
// 用 CDP 方式驱动真实 AIcut app：自己 spawn electron（开 remote-debugging 端口），
// 再用 playwright-core 的 chromium.connectOverCDP 连上渲染页，
// 绕过"时间轴点 clip"这个 Cua Driver 卡住的步骤，直接验证「抠像-手动」画布能否接收指针事件并涂鸦。
//
// 前置：
//   1. gui/node_modules 有 electron + playwright-core（本项目已自带 electron；playwright-core 已安装）
//   2. dist/、dist-electron/、target/debug/aicut-engine.exe 已构建
//   3. store/uiStore.ts 与 store/projectStore.ts 通过 [TEST HOOK] 把实例暴露到 window（__uiStore/__projectStore）
//
// 运行：在 gui/ 目录下
//   node verify_keying_manual.cjs
//
// 判定标准：
//   - document.elementFromPoint(canvas 中心) 返回 canvas（证明 video 不再拦截指针）
//   - 真实鼠标拖拽后，canvas 上产生非透明像素（证明涂鸦成功）
//   - 输出截图到 .workbuddy/tmp_keying_test/

const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');

const OUT = 'E:/AIcut/.workbuddy/tmp_keying_test';
const PROJ = 'E:/AIcut/test_render_project.json';
const ELECTRON = path.join(__dirname, 'node_modules/electron/dist/electron.exe');
const PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnElectron() {
  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_OPTIONS;       // 沙箱注入 --use-system-ca，electron 拒绝会启动即崩
  delete cleanEnv.ELECTRON_RUN_AS_NODE; // 否则 electron 跑成纯 node 模式，require('electron') 为 undefined
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: __dirname, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { const s = d.toString(); if (/error|Error|fail/i.test(s)) console.log('[electron]', s.trim()); });
  child.stderr.on('data', (d) => { const s = d.toString(); if (/error|Error|fail/i.test(s)) console.log('[electron:err]', s.trim()); });
  return child;
}

async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return true; } catch {}
    await sleep(500);
  }
  throw new Error('remote debugging port 未就绪');
}

async function main() {
  const child = spawnElectron();
  let browser;
  try {
    await waitPort();
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const ctx = browser.contexts()[0];
    let page = ctx.pages()[0];
    if (!page || page.url() === 'about:blank') {
      const pages = ctx.pages();
      page = pages.find((p) => p.url() && p.url() !== 'about:blank') || (await ctx.waitForPage());
    }
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[renderer:' + m.type() + ']', m.text()); });
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));

    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => window.__projectStore && window.__uiStore, null, { timeout: 20000 });
    await sleep(1500);

    const tracks = await page.evaluate(async (p) => {
      await window.__projectStore.getState().loadProject(p);
      return window.__projectStore.getState().project.tracks.length;
    }, PROJ);
    console.log('LOADED tracks =', tracks);

    await page.evaluate(() => {
      window.__uiStore.getState().selectClip('track_video1', 'clip_1');
      window.__uiStore.getState().setActiveRightPanel('keying');
    });
    await sleep(400);

    const enable = page.locator('button:has-text("开启抠像")');
    await enable.click({ timeout: 8000 });
    await sleep(300);

    const manual = page.locator('button:has-text("手动")');
    await manual.click({ timeout: 8000 });
    await sleep(500);

    const info = await page.evaluate(() => {
      const canvases = Array.from(document.querySelectorAll('canvas'));
      let target = null;
      // 只选 2d canvas（ManualPaintCanvas）且父容器含 <video> 的那个；预览画布是 webgpu，getContext('2d') 为 null
      for (const c of canvases) {
        let ctx2d = null; try { ctx2d = c.getContext('2d'); } catch {}
        if (!ctx2d) continue;
        const p = c.parentElement;
        if (p && p.querySelector('video')) { target = c; break; }
      }
      if (!target) return { found: false };
      const r = target.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const top = document.elementFromPoint(cx, cy);
      const cs = getComputedStyle(target);
      const v = target.previousElementSibling;
      const vcs = v ? getComputedStyle(v) : null;
      return {
        found: true, cx, cy,
        topIsCanvas: top === target, topTag: top ? top.tagName : null,
        canvasPointerEvents: cs.pointerEvents, canvasZIndex: cs.zIndex, canvasCursor: cs.cursor,
        videoPointerEvents: vcs ? vcs.pointerEvents : null, videoZIndex: vcs ? vcs.zIndex : null,
      };
    });
    console.log('CANVAS INFO =', JSON.stringify(info, null, 2));
    await page.screenshot({ path: path.join(OUT, '01_before_paint.png') });

    let painted = { painted: false, reason: 'skip' };
    if (info.found && info.topIsCanvas) {
      const x0 = info.cx - 50, y0 = info.cy, x1 = info.cx + 50, y1 = info.cy + 10;
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      await page.mouse.move((x0 + x1) / 2, y0 - 12, { steps: 6 });
      await page.mouse.move(x1, y1, { steps: 6 });
      await page.mouse.up();
      await sleep(200);
      painted = await page.evaluate(() => {
        const canvases = Array.from(document.querySelectorAll('canvas'));
        let t = null;
        for (const c of canvases) {
          let ctx2d = null; try { ctx2d = c.getContext('2d'); } catch {}
          if (!ctx2d) continue;
          const p = c.parentElement; if (p && p.querySelector('video')) { t = c; break; }
        }
        if (!t) return { painted: false, reason: 'no canvas' };
        const d = t.getContext('2d').getImageData(0, 0, t.width, t.height).data;
        let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return { painted: n > 0, nonTransparentPx: n, w: t.width, h: t.height };
      });
    }
    console.log('PAINTED =', JSON.stringify(painted));
    await page.screenshot({ path: path.join(OUT, '02_after_paint.png') });

    const pass = info.found && info.topIsCanvas && info.canvasPointerEvents === 'auto' && painted.painted;
    console.log('RESULT =', pass ? 'PASS' : 'FAIL');
    console.log('SCREENSHOTS =', OUT + '/01_before_paint.png, ' + OUT + '/02_after_paint.png');
    return pass ? 0 : 1;
  } finally {
    try { if (browser) await browser.close(); } catch {}
    try { child.kill('SIGKILL'); } catch {}
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('SCRIPT ERROR', e);
  process.exit(2);
});
