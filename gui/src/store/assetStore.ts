// 补全资产 Store — 管理「一键补全」的状态探测、下载与设置显隐
import { create } from 'zustand';
import { useConfigStore } from './configStore';

export interface AssetStatusEntry {
  id: string;
  name: string;
  size: number;
  requiredBy: string[];
  hasDirect?: boolean; // 是否有绝对下载直链（如 rmbg2 走 ModelScope），有则下载不依赖 CDN 地址
}

export interface AssetProgress {
  id?: string;
  name?: string;
  phase: 'start' | 'downloading' | 'extracting' | 'done' | 'error';
  received?: number;
  total?: number;
  percent?: number;
  doneCount?: number;
  totalCount?: number;
  error?: string;
}

interface AssetState {
  status: Record<string, boolean> | null;
  entries: AssetStatusEntry[];
  baseUrl: string;
  isPlaceholder: boolean;
  loading: boolean;
  downloading: boolean;
  progress: AssetProgress | null;
  lastError: string | null;
  showManager: boolean;

  setShowManager: (show: boolean) => void;
  checkStatus: () => Promise<void>;
  download: (ids?: string[]) => Promise<{ success: boolean; error?: string }>;
  setBaseUrl: (url: string) => Promise<void>;
  // 惰性拦截：调用 AI 功能前检查依赖组件，缺失则引导补全；返回 true 表示已就绪可继续
  ensureAssets: (ids: string[]) => Promise<boolean>;
}

export const useAssetStore = create<AssetState>((set, get) => ({
  status: null,
  entries: [],
  baseUrl: '',
  isPlaceholder: true,
  loading: false,
  downloading: false,
  progress: null,
  lastError: null,
  showManager: false,

  setShowManager: (show) => set({ showManager: show }),

  checkStatus: async () => {
    set({ loading: true });
    try {
      const res = await window.aicut.assets.status();
      set({
        status: res.status,
        entries: res.entries,
        baseUrl: res.baseUrl,
        isPlaceholder: res.isPlaceholder,
        loading: false,
      });
    } catch (e: any) {
      set({ loading: false, lastError: e?.message ?? String(e) });
    }
  },

  download: async (ids?: string[]) => {
    set({ downloading: true, progress: null, lastError: null });
    return new Promise((resolve) => {
      window.aicut.assets.onProgress((p: AssetProgress) => {
        set({ progress: p });
        if (p.phase === 'error') {
          set({ downloading: false, lastError: p.error || '下载失败' });
          resolve({ success: false, error: p.error });
        }
      });
      window.aicut.assets
        .download(ids ? { ids } : undefined)
        .then((r: any) => {
          if (r?.success) {
            set({ downloading: false });
            get().checkStatus();
            resolve({ success: true });
          } else {
            set({ downloading: false, lastError: r?.error || '下载失败' });
            resolve({ success: false, error: r?.error });
          }
        })
        .catch((e: any) => {
          set({ downloading: false, lastError: e?.message ?? String(e) });
          resolve({ success: false, error: e?.message ?? String(e) });
        });
    });
  },

  setBaseUrl: async (url: string) => {
    const current = useConfigStore.getState().config;
    await useConfigStore.getState().updateConfig({
      assets: { cdnBaseUrl: url },
    });
    // 立即刷新本地 baseUrl 展示
    set({ baseUrl: url, isPlaceholder: url.trim() === '' });
    void current;
  },

  ensureAssets: async (ids: string[]) => {
    await get().checkStatus();
    const st = get().status;
    const missing = ids.filter((id) => !st?.[id]);
    if (missing.length === 0) return true;
    // 仅当缺失条目中存在「无任何免费镜像直链（domesticUrl/externalUrl/absoluteUrl）」的条目时，
    // 才要求用户先配置自建 CDN；有直链的条目（python/modnet/rmbg2 等）可直接下载、不依赖 CDN。
    // 与主进程 assets:download 的「无直链才要求 CDN」判断保持一致。
    const hasNoDirectMissing = missing.some((id) => {
      const e = get().entries.find((x) => x.id === id);
      return !e || !e.hasDirect;
    });
    if (hasNoDirectMissing) {
      window.alert('该功能需要 AI 组件，但部分组件缺少免费镜像直链，需先配置 CDN 地址。请点击右上角「AI组件」填写地址后补全。');
      get().setShowManager(true);
      return false;
    }
    const ok = window.confirm(
      '该功能需要 AI 组件（Python 运行时 / 模型权重），当前未安装。是否立即下载补全？（约数 GB，支持断点续传）',
    );
    if (!ok) return false;
    const r = await get().download(missing);
    return r.success;
  },
}));
