// 真机验证：「批量处理时间轴」产物必须落独立新轨（不覆盖源素材）
const { chromium } = require('E:/AIcut/gui/node_modules/playwright-core');
const { spawn } = require('child_process');

const GUI = 'E:/AIcut/gui';
const ELECTRON = GUI + '/node_modules/electron/dist/electron.exe';
const PORT = Number(process.env.CDP_PORT) || 9420;
const env = { ...process.env };
delete env.NODE_OPTIONS;
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(ELECTRON, ['.', '--disable-gpu', '--no-sandbox',
  '--user-data-dir=E:/AIcut/verify_tmp/elec_profile_batch', `--remote-debugging-port=${PORT}`],
  { cwd: GUI, env, detached: true });
const logs = [];

(async () => {
  const browser = await (async () => {
    for (let i = 0; i < 40; i++) {
      try { return await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); }
      catch { await new Promise(r => setTimeout(r, 1000)); }
    }
    throw new Error('CDP 连接失败');
  })();
  const page = browser.contexts()[0].pages().find(p => !/devtools/.test(p.url()))
    || browser.contexts()[0].pages()[0];
  page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message.slice(0, 200)));

  for (let i = 0; i < 30; i++) {
    if (await page.evaluate(() => !!(window.__projectStore && window.__uiStore))) break;
    await page.waitForTimeout(500);
  }

  // 注入源素材并选中（与用户操作等价：时间轴上有片段且被选中）
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

  // 切口播面板 → 点批量处理时间轴
  await page.evaluate(() => window.__uiStore.setState({ activeLeftPanel: 'speech' }));
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('批量处理时间轴'));
    if (!btn) throw new Error('批量按钮未找到');
    btn.click();
  });
  console.log('clicked 批量处理时间轴, waiting...');

  // 等批量完成（出现 _speechcut 资产）
  let verdict = {};
  for (let i = 0; i < 90; i++) {
    verdict = await page.evaluate(() => {
      const s = window.__projectStore.getState();
      const fin = s.project.assets.find(a => (a.path || '').includes('_speechcut.mp4'));
      if (!fin) return { done: false };
      const finTrack = s.project.tracks.find(t => t.clips.some(c => c.assetId === fin.id));
      const srcTrack = s.project.tracks.find(t => t.clips.some(c => c.assetId === 'a_src'));
      const srcClip = srcTrack ? srcTrack.clips.find(c => c.assetId === 'a_src') : null;
      return {
        done: true,
        finTrackId: finTrack ? finTrack.id : null,
        finTrackType: finTrack ? finTrack.type : null,
        srcTrackId: srcTrack ? srcTrack.id : null,
        srcMuted: srcTrack ? srcTrack.muted === true : null,
        srcClipIntact: !!(srcClip && srcClip.id === 'c_src' && srcClip.timelineIn === 0.5
          && srcClip.timelineOut === 26.07 && srcClip.assetId === 'a_src'),
        clipOnSrcTrack: !!(srcTrack && srcTrack.clips.some(c => c.assetId === fin.id)),
      };
    });
    if (verdict.done) break;
    await page.waitForTimeout(1000);
  }
  const checks = {
    C1_final_on_dedicated_track: verdict.finTrackId && verdict.srcTrackId && verdict.finTrackId !== verdict.srcTrackId,
    C2_source_clip_untouched: verdict.srcClipIntact === true,
    C3_no_final_clip_on_source_track: verdict.clipOnSrcTrack === false,
    C4_source_track_auto_muted: verdict.srcMuted === true,
  };
  await page.screenshot({ path: 'E:/AIcut/verify_tmp/batch_after.png' });
  console.log('VERDICT ' + JSON.stringify({ verdict, checks, errors: logs.slice(0, 5) }, null, 1));
  await browser.close();
  const ok = Object.values(checks).every(v => v);
  try { process.kill(-child.pid); } catch {}
  process.exit(ok ? 0 : 2);
})().catch(e => {
  console.error('FATAL', e.message, logs.slice(0, 5));
  try { require('child_process').exec('taskkill /F /IM electron.exe'); } catch {}
  process.exit(1);
});
