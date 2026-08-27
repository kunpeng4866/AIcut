// 真实 App 端到端验证：口播分析 → 试听 → 断言预览片段落独立新轨且源素材零改动
const { chromium } = require('E:/AIcut/gui/node_modules/playwright-core');
const { spawn } = require('child_process');
const path = require('path');

const GUI = 'E:/AIcut/gui';
const ELECTRON = path.join(GUI, 'node_modules/electron/dist/electron.exe');
const PORT = Number(process.env.CDP_PORT) || 9228;

const env = { ...process.env };
delete env.NODE_OPTIONS;
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(ELECTRON, ['.', '--disable-gpu', '--no-sandbox', '--user-data-dir=E:/AIcut/verify_tmp/elec_profile', `--remote-debugging-port=${PORT}`], { cwd: GUI, env, detached: true });
const logs = [];
child.stderr?.on('data', (d) => logs.push('ELEC: ' + d.toString().slice(0, 200)));
child.stdout?.on('data', (d) => logs.push('ELEC-OUT: ' + d.toString().slice(0, 120)));

(async () => {
  const browser = await (async () => {
    for (let i = 0; i < 40; i++) {
      try { return await chromium.connectOverCDP(`http://localhost:${PORT}`); }
      catch { await new Promise(r => setTimeout(r, 1000)); }
    }
    throw new Error('CDP 连接失败: ' + logs.slice(0, 8).join(' | '));
  })();
  const page = browser.contexts()[0].pages().find(p => !/devtools/.test(p.url())) || browser.contexts()[0].pages()[0];
  page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') logs.push('CONSOLE: ' + m.text().slice(0, 300)); });

  // 等 store 钩子
  for (let i = 0; i < 30; i++) {
    if (await page.evaluate(() => !!(window.__projectStore && window.__uiStore))) break;
    await page.waitForTimeout(500);
  }

  const jsClick = async (text) => {
    const ok = await page.evaluate((t) => {
      const btn = [...document.querySelectorAll('button')]
        .find(b => b.textContent.trim() === t || b.textContent.includes(t));
      if (!btn) return false;
      btn.click();
      return true;
    }, text);
    if (!ok) {
      const dump = await page.evaluate(() => ({
        buttons: [...document.querySelectorAll('button')].map(b => b.textContent.trim().slice(0, 24)).filter(Boolean),
        bodyHas: ['片段审核','试听清洗结果','生成试听中'].map(k => k + '=' + document.body.innerText.includes(k)),
      }));
      await page.screenshot({ path: 'E:/AIcut/verify_tmp/fail_dump.png' });
      const body = await page.evaluate(() => document.body.innerText.replace(/\n/g, ' | ').slice(0, 400));
      throw new Error('按钮未找到: ' + text + ' | buttons=' + JSON.stringify(dump.buttons) + ' | body=' + body);
    }
  };

  // 1) 构造源素材：04 口播 wav 落音频轨，并选中
  await page.evaluate(() => {
    const st = window.__projectStore.getState();
    st.addAsset({ id: 'a_src', type: 'audio', path: 'E:/AIcut/test-assets/04_stutter.wav', duration: 25.57 });
    const tid = st.addTrack('audio');
    st.addClip(tid, {
      id: 'c_src', assetId: 'a_src', src_range: { start: 0, end: 25.57 },
      timelineIn: 0.5, timelineOut: 26.07,
      transform: { x: 0.5, y: 0.5, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
      volume: 1, speed: 1, effects: [], masks: [], filters: [], keyframes: {},
    });
    window.__uiStore.getState().selectClip(tid, 'c_src');
  });

  // 2) 切到口播面板 → 点分析
  await page.evaluate(() => window.__uiStore.setState({ activeLeftPanel: 'speech' }));
  await page.waitForTimeout(500);
  await jsClick('分析');
  console.log('clicked 分析, waiting for result...');

  // 等分析完成：试听按钮可用（result 就绪）
  console.log('waiting for analysis result...');
  for (let i = 0; i < 240; i++) {
    const ready = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('试听清洗结果'));
      const busy = [...document.querySelectorAll('button')].some(b => b.textContent.includes('生成试听中'));
      return btn && !btn.disabled && !busy && !!document.body.innerText.includes('片段审核');
    });
    if (ready) break;
    await page.waitForTimeout(1000);
  }
  console.log('analysis done');

  // 2b) 走完分析向导：等「下一步」可用并点击，直到出现「试听清洗结果」
  console.log('waiting for analysis + wizard...');
  for (let i = 0; i < 240; i++) {
    const st = await page.evaluate(() => ({
      listen: [...document.querySelectorAll('button')].some(b => b.textContent.includes('试听清洗结果')),
      nextEnabled: [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '下一步' && !b.disabled),
    }));
    if (st.listen) break;
    if (st.nextEnabled) { await jsClick('下一步'); await page.waitForTimeout(400); }
    await page.waitForTimeout(900);
  }
  console.log('wizard done, listen button ready');

  // 3) 点试听（保持源片段选中——与用户真实操作路径一致）
  await jsClick('试听清洗结果');
  console.log('clicked 试听 (deselected), waiting...');

  // 等预览资产出现
  let verdict = {};
  for (let i = 0; i < 45; i++) {
    verdict = await page.evaluate(() => {
      const s = window.__projectStore.getState();
      const pvAsset = s.project.assets.find(a => (a.path || '').includes('_preview.mp4'));
      if (!pvAsset) return { done: false };
      const pvClipTrack = s.project.tracks.find(t => t.clips.some(c => c.assetId === pvAsset.id));
      const srcClipTrack = s.project.tracks.find(t => t.clips.some(c => c.assetId === 'a_src'));
      const srcClip = srcClipTrack ? srcClipTrack.clips.find(c => c.assetId === 'a_src') : null;
      return {
        done: true,
        tracks: s.project.tracks.map(t => ({ id: t.id, type: t.type, clips: t.clips.length })),
        previewTrackId: pvClipTrack ? pvClipTrack.id : null,
        previewTrackType: pvClipTrack ? pvClipTrack.type : null,
        srcTrackId: srcClipTrack ? srcClipTrack.id : null,
        srcClip,
        separate: pvClipTrack && srcClipTrack ? pvClipTrack.id !== srcClipTrack.id : false,
        aligned: srcClip && pvClipTrack ? Math.abs(pvClipTrack.clips.find(c => c.assetId === pvAsset.id).timelineIn - srcClip.timelineIn) < 1e-6 : false,
      };
    });
    if (verdict.done) break;
    await page.waitForTimeout(1000);
  }

  // 4) 生成 → 应覆盖试听片段
  await jsClick('生成清洗片段');
  let finalInfo = {};
  for (let i = 0; i < 45; i++) {
    finalInfo = await page.evaluate(() => {
      const s = window.__projectStore.getState();
      const finAsset = s.project.assets.find(a => (a.path || '').includes('_speechcut.mp4'));
      if (!finAsset) return { done: false };
      const finTrack = s.project.tracks.find(t => t.clips.some(c => c.assetId === finAsset.id));
      const pvAssets = s.project.assets.filter(a => (a.path || '').includes('_preview.mp4'));
      const pvStillReferenced = s.project.tracks.some(t => t.clips.some(c => pvAssets.some(a => a.id === c.assetId)));
      return { done: true, finTrackId: finTrack ? finTrack.id : null, pvStillReferenced };
    });
    if (finalInfo.done) break;
    await page.waitForTimeout(1000);
  }

  await page.screenshot({ path: 'E:/AIcut/verify_tmp/timeline_after.png', fullPage: false });

  const results = {
    preview: verdict,
    final: finalInfo,
    checks: {
      C1_preview_on_new_track: verdict.previewTrackId && verdict.srcTrackId && verdict.previewTrackId !== verdict.srcTrackId,
      C2_source_clip_untouched: verdict.srcClip && verdict.srcClip.id === 'c_src'
        && verdict.srcClip.timelineIn === 0.5 && verdict.srcClip.timelineOut === 26.07
        && verdict.srcClip.assetId === 'a_src',
      C3_aligned: verdict.aligned === true,
      C4_final_replaces_preview: finalInfo.done && finalInfo.finTrackId === verdict.previewTrackId && finalInfo.pvStillReferenced === false,
    },
    consoleErrors: logs.slice(0, 10),
  };
  console.log('VERDICT ' + JSON.stringify(results, null, 1));
  await browser.close();
  process.exit(Object.values(results.checks).every(v => v) ? 0 : 2);
})().catch(e => { console.error('FATAL', e.message, logs.slice(0, 6)); try { process.kill(-child.pid); } catch {} process.exit(1); });