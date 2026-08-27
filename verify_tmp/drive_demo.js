// 真实 App 演示：口播分析 → 试听片段落新轨 → 生成覆盖试听
// 每个关键节点截图到 verify_tmp/demo_*.png
const { chromium } = require('E:/AIcut/gui/node_modules/playwright-core');
const { spawn } = require('child_process');

const GUI = 'E:/AIcut/gui';
const ELECTRON = GUI + '/node_modules/electron/dist/electron.exe';
const PORT = Number(process.env.CDP_PORT) || 9400;
const SHOT = 'E:/AIcut/verify_tmp/';

const env = { ...process.env };
delete env.NODE_OPTIONS;
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(ELECTRON, ['.', '--disable-gpu', '--no-sandbox',
  '--user-data-dir=E:/AIcut/verify_tmp/elec_profile_demo', `--remote-debugging-port=${PORT}`],
  { cwd: GUI, env, detached: true });
const logs = [];
child.stderr?.on('data', d => { const s = d.toString(); if (s.includes('FATAL')) logs.push(s.slice(0, 150)); });

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
  page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message.slice(0, 150)));

  const jsClick = async (text) => {
    const ok = await page.evaluate((t) => {
      const btn = [...document.querySelectorAll('button')]
        .find(b => b.textContent.trim() === t || b.textContent.includes(t));
      if (!btn) return false;
      btn.click(); return true;
    }, text);
    if (!ok) throw new Error('按钮未找到: ' + text);
  };
  const dismissWizard = async () => {
    // 首次启动的「配置向导」modal：逐个点 取消/完成 直到消失
    for (let k = 0; k < 6; k++) {
      const gone = await page.evaluate(() => !document.body.innerText.includes('配置向导'));
      if (gone) return;
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')]
          .find(b => ['取消', '完成', '下一步'].includes(b.textContent.trim())
            && b.getBoundingClientRect().width > 0);
        if (btn) btn.click();
      });
      await page.waitForTimeout(400);
    }
  };
  const scrollTracksToBottom = async () => {
    await page.evaluate(() => {
      const el = document.querySelector('[data-track-id]');
      let c = el ? el.parentElement : null;
      while (c && c.scrollHeight <= c.clientHeight + 4) c = c.parentElement;
      if (c) c.scrollTop = c.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
    });
  };
  const shotTimeline = async (name) => {
    await dismissWizard();
    await scrollTracksToBottom();
    await page.waitForTimeout(400);
    await page.screenshot({ path: SHOT + name });
  };
  const trackSnapshot = () => page.evaluate(() => {
    const s = window.__projectStore.getState();
    return s.project.tracks.map(t => ({
      type: t.type, clips: t.clips.map(c => {
        const a = s.project.assets.find(x => x.id === c.assetId);
        return { asset: (a ? a.path : '?').split(/[\\/]/).pop(), tin: +c.timelineIn.toFixed(2), tout: +c.timelineOut.toFixed(2) };
      }),
    }));
  });

  // ── 0) 等启动 & 注入源素材 ──
  for (let i = 0; i < 30; i++) {
    if (await page.evaluate(() => !!(window.__projectStore && window.__uiStore))) break;
    await page.waitForTimeout(500);
  }
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
  await shotTimeline('demo_1_source.png');
  console.log('TRACKS@' + 'demo_1_source.png ' + JSON.stringify(await trackSnapshot()));
  console.log('S1 源素材就绪（单轨）');

  // ── 1) 分析 + 走向导 ──
  await page.evaluate(() => window.__uiStore.setState({ activeLeftPanel: 'speech' }));
  await page.waitForTimeout(400);
  await jsClick('分析');
  console.log('S2 分析中…');
  for (let i = 0; i < 240; i++) {
    const st = await page.evaluate(() => ({
      listen: [...document.querySelectorAll('button')].some(b => b.textContent.includes('试听清洗结果')),
      next: [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '下一步' && !b.disabled),
    }));
    if (st.listen) break;
    if (st.next) { await jsClick('下一步'); await page.waitForTimeout(400); }
    await page.waitForTimeout(900);
  }
  await shotTimeline('demo_2_analyzed.png');
  console.log('TRACKS@' + 'demo_2_analyzed.png ' + JSON.stringify(await trackSnapshot()));
  console.log('S2 分析完成（红=删除/绿=保留 建议标记）');

  // ── 2) 试听 → 预览片段落新轨 ──
  await jsClick('试听清洗结果');
  for (let i = 0; i < 45; i++) {
    const has = await page.evaluate(() =>
      window.__projectStore.getState().project.assets.some(a => (a.path || '').includes('_preview.mp4')));
    if (has) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(800);
  await shotTimeline('demo_3_preview_track.png');
  console.log('TRACKS@' + 'demo_3_preview_track.png ' + JSON.stringify(await trackSnapshot()));
  console.log('S3 试听完成（应出现新音频轨）');

  // ── 3) 生成 → 覆盖试听片段 ──
  await jsClick('生成清洗片段');
  for (let i = 0; i < 45; i++) {
    const has = await page.evaluate(() =>
      window.__projectStore.getState().project.assets.some(a => (a.path || '').includes('_speechcut.mp4')));
    if (has) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(800);
  await shotTimeline('demo_4_final.png');
  console.log('TRACKS@' + 'demo_4_final.png ' + JSON.stringify(await trackSnapshot()));
  console.log('S4 生成完成（最终片段覆盖试听片段）');

  // ── 4) 结构化快照 ──
  const snap = await trackSnapshot();
  const srcCheck = await page.evaluate(() => {
    const s = window.__projectStore.getState();
    const srcT = s.project.tracks.find(t => t.clips.some(c => c.assetId === 'a_src'));
    const c = srcT ? srcT.clips[0] : null;
    return c ? { id: c.id, assetId: c.assetId, tin: c.timelineIn, tout: c.timelineOut } : null;
  });
  console.log('TRACKS ' + JSON.stringify(snap));
  console.log('SOURCE_CLIP ' + JSON.stringify(srcCheck));
  console.log('FATALS ' + JSON.stringify(logs.slice(0, 4)));
  await browser.close();
  process.exit(0);
})().catch(e => {
  console.error('FATAL', e.message, logs.slice(0, 5));
  try { process.kill(-child.pid); } catch {}
  process.exit(1);
});
