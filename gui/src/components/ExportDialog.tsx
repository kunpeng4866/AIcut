// 导出对话框 — 分辨率/格式/质量选择 + 进度显示
import React, { useState, useEffect, useRef } from 'react';
import type { ProjectConfig, ExportOptions } from '../types';

interface Props {
  project: ProjectConfig;
  onClose: () => void;
}

const C = {
  overlay: {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center',
    justifyContent: 'center', zIndex: 1000,
  } as React.CSSProperties,
  dialog: {
    width: 500, background: '#16213e', borderRadius: 8, border: '1px solid #0f3460',
    color: '#eee', fontFamily: 'system-ui', boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
  } as React.CSSProperties,
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 20px', borderBottom: '1px solid #0f3460',
  } as React.CSSProperties,
  title: { fontSize: 16, fontWeight: 600 } as React.CSSProperties,
  closeBtn: {
    background: 'none', border: 'none', color: '#aaa', fontSize: 20,
    cursor: 'pointer', padding: '0 4px', lineHeight: 1,
  } as React.CSSProperties,
  body: { padding: '20px' } as React.CSSProperties,
  row: { display: 'flex', alignItems: 'center', marginBottom: 16 } as React.CSSProperties,
  label: { width: 72, fontSize: 13, color: '#aaa', flexShrink: 0 } as React.CSSProperties,
  select: {
    flex: 1, padding: '7px 10px', background: '#0f3460', color: '#eee',
    border: '1px solid #1a1a2e', borderRadius: 4, fontSize: 13, outline: 'none',
  } as React.CSSProperties,
  pathRow: { display: 'flex', alignItems: 'center', marginBottom: 20, gap: 8 } as React.CSSProperties,
  pathDisplay: {
    flex: 1, padding: '7px 10px', background: '#0f3460', color: '#eee',
    border: '1px solid #1a1a2e', borderRadius: 4, fontSize: 12,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  } as React.CSSProperties,
  browseBtn: {
    padding: '7px 14px', background: '#0f3460', color: '#eee', border: 'none',
    borderRadius: 4, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap',
  } as React.CSSProperties,
  progressSection: {
    background: '#1a1a2e', borderRadius: 6, padding: 16, marginBottom: 16,
  } as React.CSSProperties,
  progressHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 8, fontSize: 13,
  } as React.CSSProperties,
  progressTrack: {
    width: '100%', height: 8, background: '#0f3460', borderRadius: 4, overflow: 'hidden',
  } as React.CSSProperties,
  progressFill: {
    height: '100%', background: '#e94560', borderRadius: 4, transition: 'width 0.3s',
  } as React.CSSProperties,
  footer: {
    display: 'flex', justifyContent: 'flex-end', gap: 8,
    padding: '16px 20px', borderTop: '1px solid #0f3460',
  } as React.CSSProperties,
  btn: {
    padding: '8px 20px', background: '#0f3460', color: '#eee', border: 'none',
    borderRadius: 4, cursor: 'pointer', fontSize: 13,
  } as React.CSSProperties,
  btnAccent: {
    padding: '8px 20px', background: '#e94560', color: '#fff', border: 'none',
    borderRadius: 4, cursor: 'pointer', fontSize: 13,
  } as React.CSSProperties,
  btnDisabled: {
    padding: '8px 20px', background: '#333', color: '#666', border: 'none',
    borderRadius: 4, cursor: 'not-allowed', fontSize: 13,
  } as React.CSSProperties,
  statusIcon: { fontSize: 16, marginRight: 6 } as React.CSSProperties,
  statusSuccess: { color: '#4ecca3' } as React.CSSProperties,
  statusError: { color: '#e94560' } as React.CSSProperties,
  errorBox: {
    background: 'rgba(233,69,96,0.1)', border: '1px solid #e94560', borderRadius: 4,
    padding: 12, marginBottom: 16, fontSize: 12, color: '#e94560', wordBreak: 'break-word',
  } as React.CSSProperties,
  warnText: { fontSize: 12, color: '#aaa', marginBottom: 16 } as React.CSSProperties,
};

type Status = 'idle' | 'exporting' | 'done' | 'error';

export default function ExportDialog({ project, onClose }: Props) {
  const [options, setOptions] = useState<ExportOptions>({
    resolution: '1080p', format: 'mp4-h264', quality: 'medium',
  });
  const [outputPath, setOutputPath] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const statusRef = useRef<Status>('idle');

  const hasClips = project.tracks.some((t) => t.clips.length > 0);

  // 导出中计时器
  useEffect(() => {
    if (status !== 'exporting') return;
    const timer = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [status]);

  // IPC 事件监听
  useEffect(() => {
    window.aicut.export.onProgress((p) => setProgress(p));
    window.aicut.export.onDone(() => {
      statusRef.current = 'done';
      setStatus('done');
    });
    window.aicut.export.onError((err) => {
      statusRef.current = 'error';
      setErrorMsg(err);
      setStatus('error');
    });
  }, []);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  const handleChoosePath = async () => {
    const ext = options.format === 'mov' ? 'mov' : 'mp4';
    const path = await window.aicut.openExportDialog(`output.${ext}`);
    if (path) setOutputPath(path);
  };

  const handleStart = async () => {
    setProgress(0);
    setElapsedSeconds(0);
    setErrorMsg('');
    setStatus('exporting');
    statusRef.current = 'exporting';
    const result = await window.aicut.export.start(project, outputPath, options);
    // 事件监听器通常已更新状态，此处仅作兜底
    if (!result.success && statusRef.current === 'exporting') {
      setErrorMsg(result.error || '导出失败');
      setStatus('error');
      statusRef.current = 'error';
    }
  };

  const handleCancel = async () => {
    await window.aicut.export.cancel();
    setStatus('idle');
    setProgress(0);
    statusRef.current = 'idle';
  };

  const handleOpenFolder = () => {
    window.aicut.export.openFolder(outputPath);
  };

  const updateOption = (key: keyof ExportOptions, value: string) => {
    setOptions((prev) => ({ ...prev, [key]: value }));
  };

  const canExport = outputPath && hasClips && status !== 'exporting';

  return (
    <div style={C.overlay} onClick={(e) => { if (e.target === e.currentTarget && status !== 'exporting') onClose(); }}>
      <div style={C.dialog}>
        {/* 标题栏 */}
        <div style={C.header}>
          <span style={C.title}>导出视频</span>
          <button style={C.closeBtn} onClick={() => status !== 'exporting' && onClose()} disabled={status === 'exporting'}>
            ✕
          </button>
        </div>

        <div style={C.body}>
          {!hasClips && (
            <div style={C.warnText}>当前工程没有内容，请先添加素材到时间轴。</div>
          )}

          {/* 分辨率 */}
          <div style={C.row}>
            <span style={C.label}>分辨率</span>
            <select
              style={C.select}
              value={options.resolution}
              onChange={(e) => updateOption('resolution', e.target.value)}
              disabled={status === 'exporting'}
            >
              <option value="2160p">4K 超清 (3840×2160)</option>
              <option value="1080p">1080p (1920×1080)</option>
              <option value="720p">720p (1280×720)</option>
              <option value="480p">480p (854×480)</option>
              <option value="original">原尺寸（跟随画布）</option>
            </select>
          </div>

          {/* 格式 */}
          <div style={C.row}>
            <span style={C.label}>格式</span>
            <select
              style={C.select}
              value={options.format}
              onChange={(e) => updateOption('format', e.target.value)}
              disabled={status === 'exporting'}
            >
              <option value="mp4-h264">MP4 (H.264)</option>
              <option value="mp4-h265">MP4 (H.265)</option>
              <option value="mov">MOV</option>
            </select>
          </div>

          {/* 质量 */}
          <div style={C.row}>
            <span style={C.label}>质量</span>
            <select
              style={C.select}
              value={options.quality}
              onChange={(e) => updateOption('quality', e.target.value)}
              disabled={status === 'exporting'}
            >
              <option value="high">高 (CRF 18)</option>
              <option value="medium">中 (CRF 23)</option>
              <option value="low">低 (CRF 28)</option>
            </select>
          </div>

          {/* 输出路径 */}
          <div style={C.pathRow}>
            <span style={C.label}>输出路径</span>
            <div style={C.pathDisplay} title={outputPath || '未选择'}>
              {outputPath || '未选择'}
            </div>
            <button style={C.browseBtn} onClick={handleChoosePath} disabled={status === 'exporting'}>
              浏览...
            </button>
          </div>

          {/* 进度 / 状态 */}
          {status === 'exporting' && (
            <div style={C.progressSection}>
              <div style={C.progressHeader}>
                <span>导出中... {Math.round(progress * 100)}%</span>
                <span style={{ color: '#aaa' }}>已用 {formatTime(elapsedSeconds)}</span>
              </div>
              <div style={C.progressTrack}>
                <div style={{ ...C.progressFill, width: `${progress * 100}%` }} />
              </div>
            </div>
          )}

          {status === 'done' && (
            <div style={{ ...C.progressSection, textAlign: 'center' }}>
              <div style={{ ...C.statusSuccess, fontSize: 14, marginBottom: 8 }}>
                <span style={C.statusIcon}>✓</span>导出完成！
              </div>
              <div style={{ fontSize: 12, color: '#aaa', wordBreak: 'break-all' }}>{outputPath}</div>
            </div>
          )}

          {status === 'error' && (
            <div style={C.errorBox}>
              <strong>导出失败：</strong>
              <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{errorMsg}</div>
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div style={C.footer}>
          {status === 'exporting' ? (
            <button style={C.btn} onClick={handleCancel}>取消导出</button>
          ) : status === 'done' ? (
            <>
              <button style={C.btn} onClick={onClose}>关闭</button>
              <button style={C.btnAccent} onClick={handleOpenFolder}>打开文件夹</button>
            </>
          ) : status === 'error' ? (
            <>
              <button style={C.btn} onClick={onClose}>关闭</button>
              <button style={C.btnAccent} onClick={handleStart} disabled={!canExport}>重试</button>
            </>
          ) : (
            <>
              <button style={C.btn} onClick={onClose}>取消</button>
              <button
                style={canExport ? C.btnAccent : C.btnDisabled}
                onClick={handleStart}
                disabled={!canExport}
              >
                开始导出
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
