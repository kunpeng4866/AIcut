/**
 * EffectsPanel.tsx
 * 用途：左侧面板「特效」标签页的 React 组件（无 props）。
 * 组件挂载时通过 window.aicut.listPlugins() 拉取已安装的特效/滤镜插件清单，
 * 逐条展示插件名称与描述；点击某个插件即把该特效以默认参数追加到
 * 「当前选中的时间轴片段」上（通过 useProjectStore.updateClip 更新 filters）。
 * 若尚未在时间轴上选中片段，则显示橙色提示而不执行任何更新。
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';

// ---- 类型定义（与任务规格一致）----
interface ParamDef {
  key: string;
  label: string;
  param_type: 'Slider' | 'Toggle' | 'Color' | 'Select';
  min?: number;
  max?: number;
  default?: any;
  options?: string[];
}

interface PluginManifest {
  id: string;
  name?: string;
  description?: string;
  parameters?: ParamDef[];
  filter_spec?: string;
  shader?: string;
  css_filter?: string;
}

// 单个应用到片段上的滤镜项结构
interface AppliedFilter {
  kind: string;
  name: string;
  params: Record<string, any>;
  enabled: boolean;
}

// 根据插件 manifest 的 parameters 生成默认参数对象
function buildDefaultParams(manifest: PluginManifest): Record<string, any> {
  const params: Record<string, any> = {};
  const list = manifest.parameters;
  if (!list) return params;
  for (const p of list) {
    switch (p.param_type) {
      case 'Slider':
        params[p.key] = Number(p.default ?? 0);
        break;
      case 'Toggle':
        params[p.key] = Boolean(p.default ?? false);
        break;
      case 'Color':
        params[p.key] = Number(p.default ?? 0xffffff); // 0xRRGGBB 数字约定
        break;
      case 'Select':
        params[p.key] = Number(p.default ?? 0); // 选项索引
        break;
      default:
        params[p.key] = p.default ?? 0;
    }
  }
  return params;
}

export default function EffectsPanel() {
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // 主题样式（深色）
  const theme = {
    root: {
      display: 'flex' as const,
      flexDirection: 'column' as const,
      height: '100%',
      fontFamily: 'system-ui',
      color: '#eee',
      padding: 8,
    },
    card: {
      padding: 10,
      margin: '6px 0',
      background: '#16213e',
      borderRadius: 6,
      cursor: 'pointer',
      border: '1px solid transparent',
    },
    cardHover: {
      borderColor: '#e94560',
    },
    name: {
      fontSize: 13,
      fontWeight: 600,
      color: '#eee',
    },
    desc: {
      fontSize: 11,
      color: '#aaa',
      marginTop: 4,
    },
    hint: {
      color: '#ff9800', // 橙色提示
      fontSize: 12,
      padding: 10,
    },
    errText: {
      color: '#e94560', // 红色错误
      fontSize: 12,
      padding: 10,
    },
    centerText: {
      color: '#aaa',
      fontSize: 12,
      textAlign: 'center' as const,
      marginTop: 20,
    },
  };

  // 加载插件清单
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await window.aicut.listPlugins(); // 返回 Promise<string>（JSON 字符串）
        let list: PluginManifest[] = [];
        try {
          list = JSON.parse(raw) as PluginManifest[];
        } catch (parseErr: any) {
          if (!cancelled) {
            setError('特效清单解析失败：' + (parseErr?.message || parseErr));
            setLoading(false);
          }
          return;
        }
        if (!cancelled) {
          setPlugins(list);
          setLoading(false);
        }
      } catch (e: any) {
        if (!cancelled) {
          setError('加载特效失败：' + (e?.message || e));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 点击插件 → 应用到选中片段
  const handleAdd = useCallback((manifest: PluginManifest) => {
    const { selectedTrackId, selectedClipId } = useUIStore.getState();

    // 未选中片段：显示橙色提示，不调用 updateClip
    if (!selectedTrackId || !selectedClipId) {
      setError('请先在时间轴上选中一个片段，再添加特效');
      return;
    }
    setError(null);

    const project = useProjectStore.getState().project;
    const clip = project.tracks
      .find((t) => t.id === selectedTrackId)
      ?.clips.find((c) => c.id === selectedClipId);

    const newFilter: AppliedFilter = {
      kind: manifest.id,
      name: manifest.name || manifest.id,
      params: buildDefaultParams(manifest),
      enabled: true,
    };
    const filters = [...(clip?.filters || []), newFilter];
    useProjectStore.getState().updateClip(selectedTrackId, selectedClipId, { filters });
  }, []);

  return (
    <div style={theme.root}>
      {loading && <div style={theme.centerText}>加载特效中…</div>}

      {!loading && error && (
        <div style={error.startsWith('请先在时间轴上选中') ? theme.hint : theme.errText}>
          {error}
        </div>
      )}

      {!loading && !error && plugins.length === 0 && (
        <div style={theme.centerText}>未找到可用特效插件</div>
      )}

      {!loading &&
        !error &&
        plugins.map((manifest) => (
          <div
            key={manifest.id}
            style={theme.card}
            onClick={() => handleAdd(manifest)}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLDivElement).style.borderColor = theme.cardHover.borderColor;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.borderColor = 'transparent';
            }}
          >
            <div style={theme.name}>{manifest.name || manifest.id}</div>
            {manifest.description && <div style={theme.desc}>{manifest.description}</div>}
          </div>
        ))}
    </div>
  );
}
