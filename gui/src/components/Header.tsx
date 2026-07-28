// 顶部导航栏 — Logo、文件操作、AI配置入口
import React, { useEffect, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useHistoryStore } from '../store/historyStore';
import { useConfigStore } from '../store/configStore';
import ExportDialog from './ExportDialog';

// 内联样式：深色主题
const theme = {
  bar: {
    height: 48,
    background: '#1a1a2e',
    borderBottom: '1px solid #0f3460',
    display: 'flex',
    alignItems: 'center',
    padding: '0 12px',
    fontFamily: 'system-ui',
    color: '#eee',
    flexShrink: 0,
  } as React.CSSProperties,
  logo: { fontSize: 18, fontWeight: 700, color: '#e94560', marginRight: 6 } as React.CSSProperties,
  version: { fontSize: 11, color: '#666', marginRight: 16 } as React.CSSProperties,
  btn: {
    padding: '6px 12px',
    background: '#0f3460',
    color: '#eee',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 13,
    marginLeft: 6,
  } as React.CSSProperties,
  btnAccent: {
    padding: '6px 12px',
    background: '#e94560',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 13,
    marginLeft: 6,
  } as React.CSSProperties,
  spacer: { flex: 1 } as React.CSSProperties,
  gear: { cursor: 'pointer', padding: 6, display: 'flex', alignItems: 'center' } as React.CSSProperties,
};

export default function Header() {
  const { project, newProject, loadProject, saveProject } = useProjectStore();
  const configStore = useConfigStore();
  const canUndo = useHistoryStore(s => s.past.length > 0);
  const canRedo = useHistoryStore(s => s.future.length > 0);
  const [version, setVersion] = useState('1.0.0');
  const [busy, setBusy] = useState(false);
  const [showExport, setShowExport] = useState(false);

  useEffect(() => {
    window.aicut.getVersion().then(setVersion).catch(() => {});
  }, []);

  // 新建工程
  const handleNew = () => {
    if (project.tracks.some((t) => t.clips.length > 0)) {
      if (!confirm('当前工程有内容，确定要新建吗？未保存的内容将丢失。')) return;
    }
    newProject();
  };

  // 打开工程文件
  const handleOpen = async () => {
    try {
      const paths = await window.aicut.openProject();
      if (paths && paths.length > 0) {
        setBusy(true);
        await loadProject(paths[0]);
      }
    } catch (e) {
      alert('打开失败: ' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 保存工程
  const handleSave = async () => {
    try {
      const path = await window.aicut.openSaveDialog('project.json');
      if (path) {
        setBusy(true);
        await saveProject(path);
      }
    } catch (e) {
      alert('保存失败: ' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 打开导出对话框（含蒙版轻提示，仅提示不阻塞）
  const handleExport = () => {
    const hasMask = project.tracks.some((t) => t.clips.some((c) => (c.masks?.length ?? 0) > 0));
    if (hasMask && !window.confirm('当前工程包含蒙版，仅简单工程（矩形/圆形/线性/镜面、无旋转无描边阴影）可正确导出，复杂蒙版可能丢失。是否继续？')) {
      return;
    }
    setShowExport(true);
  };

  // 打开AI配置向导
  const handleConfig = () => configStore.setShowConfigWizard(true);

  return (
    <div style={theme.bar}>
      {/* 左侧：Logo + 版本 */}
      <span style={theme.logo}>AIcut</span>
      <span style={theme.version}>v{version}</span>

      {/* 中间：文件操作 */}
      <button style={theme.btn} onClick={handleNew} disabled={busy}>新建</button>
      <button style={theme.btn} onClick={handleOpen} disabled={busy}>打开</button>
      <button style={theme.btn} onClick={handleSave} disabled={busy}>保存</button>
      <button style={theme.btnAccent} onClick={handleExport} disabled={busy}>导出</button>
      <div style={{ width: 1, height: 24, background: '#0f3460', margin: '0 8px' }} />
      <button style={{ ...theme.btn, opacity: canUndo ? 1 : 0.4 }} onClick={() => useProjectStore.getState().undo()} disabled={!canUndo} title="撤销 Ctrl+Z">↩ 撤销</button>
      <button style={{ ...theme.btn, opacity: canRedo ? 1 : 0.4 }} onClick={() => useProjectStore.getState().redo()} disabled={!canRedo} title="重做 Ctrl+Shift+Z">↪ 重做</button>

      <div style={theme.spacer} />

      {/* 右侧：AI配置按钮 */}
      <div style={theme.gear} onClick={handleConfig} title="AI配置">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#eee" strokeWidth="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span style={{ fontSize: 12, marginLeft: 4 }}>AI配置</span>
      </div>

      {/* 导出对话框 */}
      {showExport && (
        <ExportDialog project={project} onClose={() => setShowExport(false)} />
      )}
    </div>
  );
}
