// AI 组件管理弹窗 — 查看补全资产状态、设置 CDN 地址、一键补全
import React, { useEffect, useState } from 'react';
import { useAssetStore } from '../store/assetStore';
import { DEFAULT_CDN_PLACEHOLDER } from '../config/ai_config';

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9998,
};
const modal: React.CSSProperties = {
  width: 560, maxHeight: '88vh', overflowY: 'auto', background: '#1a1a2e',
  borderRadius: 8, border: '1px solid #0f3460', color: '#eee', fontFamily: 'system-ui',
};
const header: React.CSSProperties = { padding: '16px 20px', borderBottom: '1px solid #16213e', fontSize: 16, fontWeight: 600 };
const body: React.CSSProperties = { padding: 20 };
const label: React.CSSProperties = { fontSize: 12, color: '#aaa', marginBottom: 4, display: 'block' };
const input: React.CSSProperties = {
  width: '100%', padding: '8px 10px', background: '#16213e', border: '1px solid #0f3460',
  borderRadius: 4, color: '#eee', fontSize: 13, marginBottom: 8, boxSizing: 'border-box' as const,
};
const btn: React.CSSProperties = { padding: '8px 16px', background: '#e94560', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13 };
const btnGhost: React.CSSProperties = { padding: '8px 16px', background: 'transparent', color: '#aaa', border: '1px solid #0f3460', borderRadius: 4, cursor: 'pointer', fontSize: 13 };

function fmtSize(n: number): string {
  if (!n) return '-';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  return (n / 1e3).toFixed(0) + ' KB';
}

export default function AssetManagerModal() {
  const { status, entries, baseUrl, isPlaceholder, downloading, progress, lastError, checkStatus, download, setBaseUrl, setShowManager } = useAssetStore();
  const [urlInput, setUrlInput] = useState('');

  useEffect(() => {
    checkStatus();
  }, []);

  // baseUrl 由 checkStatus 异步取回，首渲染时还是空的；取回后回填输入框，
  // 否则用户每次打开面板都看到空输入框，误以为地址没保存成功。
  useEffect(() => {
    setUrlInput(baseUrl === DEFAULT_CDN_PLACEHOLDER ? '' : baseUrl);
  }, [baseUrl]);

  const missing = entries.filter((e) => !status?.[e.id]);
  const allReady = missing.length === 0;

  const onSaveUrl = async () => {
    await setBaseUrl(urlInput.trim());
    await checkStatus();
  };

  return (
    <div style={overlay} onClick={() => !downloading && setShowManager(false)}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={header}>AI 组件管理（一键补全）</div>
        <div style={body}>
          <div style={{ fontSize: 12, color: '#aaa', lineHeight: 1.6, marginBottom: 12 }}>
            精简版不含 AI 模型与 Python 运行时。下方显示各组件状态；缺失时点「立即补全」即可从 CDN 下载（断点续传 + 校验）。
          </div>

          <label style={label}>CDN 基础地址（末尾带 /，如 https://your-cdn.com/aicut/）</label>
          <input style={input} placeholder="https://your-cdn.com/aicut/" value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)} disabled={downloading} />
          <button style={{ ...btnGhost, marginBottom: 16 }} onClick={onSaveUrl} disabled={downloading}>保存地址</button>
          {isPlaceholder && missing.some((e) => !e.hasDirect) && (
            <div style={{ color: '#ffb454', fontSize: 12, marginBottom: 12 }}>
              ⚠️ 以下组件需要从 CDN 下载，但尚未配置 CDN 地址。请先填写并保存。
            </div>
          )}

          <div style={{ marginBottom: 12 }}>
            {entries.map((e) => {
              const ok = !!status?.[e.id];
              return (
                <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #16213e' }}>
                  <div>
                    <div style={{ fontSize: 13 }}>{e.name}</div>
                    <div style={{ fontSize: 11, color: '#888' }}>{fmtSize(e.size)} · 依赖：{e.requiredBy.join('/')}</div>
                  </div>
                  <span style={{ fontSize: 12, color: ok ? '#4ade80' : '#ff6b6b' }}>{ok ? '已就绪' : '缺失'}</span>
                </div>
              );
            })}
          </div>

          {progress && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: '#ccc', marginBottom: 4 }}>
                {progress.phase === 'extracting' ? '解压中…' : progress.phase === 'downloading' ? `下载中：${progress.name}` : progress.phase === 'done' ? `完成：${progress.name}` : ''}
                {progress.percent != null && ` ${(progress.percent * 100).toFixed(1)}%`}
                {progress.doneCount != null && progress.totalCount != null && ` (${progress.doneCount}/${progress.totalCount})`}
              </div>
              <div style={{ height: 6, background: '#16213e', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${((progress.percent ?? 0) * 100).toFixed(1)}%`, background: '#e94560' }} />
              </div>
            </div>
          )}

          {lastError && <div style={{ color: '#ff6b6b', fontSize: 12, marginBottom: 12 }}>{lastError}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button style={btnGhost} onClick={() => setShowManager(false)} disabled={downloading}>关闭</button>
            {/* 只下缺失项：download() 无参会重下全部（约 4G），已就绪的白下一遍 */}
            <button style={btn} onClick={() => download(missing.map((e) => e.id))} disabled={downloading || allReady || (isPlaceholder && missing.some((e) => !e.hasDirect))}>
              {downloading ? '补全中…' : allReady ? '已全部就绪' : '立即补全'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
