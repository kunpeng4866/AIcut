// 美颜·皮肤管理面板（BeautyTab）：启用开关、磨皮/美白/清晰三滑块、肤色预设、皮肤遮罩生成。
// 写入方式：结构变更（启用/生成）走 updateClip（拖前 pushHistorySnapshot），
//           参数拖动（磨皮/美白/清晰/肤色）走 updateClipLive。
// 完全镜像 KeyingTab 的 IPC→addAsset→updateClip 契约与视觉风格。
import { useState, useRef } from 'react';
import { useProjectStore } from '../../store/projectStore';
import { uid } from '../../utils/clipFactories';
import type { ClipConfig, BeautyConfig, SkinTone } from '../../types';
import { type MultiMaskBeauty } from '../../utils/beautyRender';

// 复用面板配色（深色 #16213e / #0f3460 边框 / #e94560 强调）
const S = {
  row: { display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' } as const,
  input: { flex: 1, background: '#0f3460', border: '1px solid #1a1a2e', borderRadius: 4, color: '#eee', padding: '4px 6px', fontSize: 11, minWidth: 0 } as const,
  btn: { background: '#0f3460', color: '#eee', border: '1px solid #1a1a2e', borderRadius: 4, padding: '4px 8px', fontSize: 11, cursor: 'pointer' } as const,
  btnActive: { background: '#e94560', color: '#fff', border: '1px solid #e94560' } as const,
  label: { color: '#aaa', fontSize: 11, width: 54, flexShrink: 0 } as const,
  divider: { height: 1, background: '#0f3460', margin: '8px 0' } as const,
};

// 区块标题
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ color: '#8895b3', fontSize: 11, fontWeight: 600, letterSpacing: 0.3, marginBottom: 8 }}>
      {children}
    </div>
  );
}

// 小灰字提示
function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ color: '#6b7794', fontSize: 10, lineHeight: 1.4, marginTop: -4, marginBottom: 6 }}>
      {children}
    </div>
  );
}

// 可复用参数滑块（拖动时走 live，拖前压一次历史快照）；disabled 时整体置灰并禁交互
function ParamSlider({ label, value, min, max, step, unit, editable, disabled, onChange, onEditStart, onEditEnd }: {
  label: string; value: number; min: number; max: number; step: number;
  unit?: string; editable?: boolean; disabled?: boolean; onChange: (v: number) => void; onEditStart?: () => void; onEditEnd?: () => void;
}) {
  const fmt = (v: number) => unit === '%' ? `${Math.round(v * 100)}%` : unit === '°' ? `${Math.round(v)}°` : v.toFixed(2);
  let editing = false;
  const begin = () => { if (!editing && !disabled) { editing = true; onEditStart?.(); } };
  const end = () => { if (editing) { editing = false; onEditEnd?.(); } };
  const textColor = disabled ? '#666' : '#eee';
  return (
    <div style={{ marginBottom: 8, opacity: disabled ? 0.5 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2, alignItems: 'center' }}>
        <span style={{ color: disabled ? '#666' : '#aaa', fontSize: 11 }}>{label}</span>
        {editable ? (
          <input type="number" value={value} min={min} max={max} step={step} disabled={disabled}
            onFocus={begin} onBlur={end}
            onChange={(e) => { begin(); onChange(parseFloat(e.target.value) || 0); }}
            style={{ width: 64, background: '#0f3460', border: '1px solid #1a1a2e', borderRadius: 4, color: textColor, padding: '2px 4px', fontSize: 11 }} />
        ) : (
          <span style={{ color: textColor, fontSize: 11 }}>{fmt(value)}</span>
        )}
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        disabled={disabled}
        onPointerDown={begin} onPointerUp={end} onBlur={end}
        onChange={(e) => { begin(); onChange(parseFloat(e.target.value)); }}
        style={{ width: '100%', accentColor: '#e94560', cursor: disabled ? 'not-allowed' : 'pointer' }} />
    </div>
  );
}

function ToggleBtn({ active, disabled, onClick, children }: { active: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button style={{ ...S.btn, ...(active ? S.btnActive : {}), opacity: disabled ? 0.5 : 1 }} disabled={disabled} onClick={onClick}>{children}</button>;
}

// 生成按钮
function GenerateButton({ processing, disabled, onClick, children }: {
  processing: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button style={{ ...S.btn, width: '100%', background: '#e94560', color: '#fff', border: '1px solid #e94560', opacity: (disabled || processing) ? 0.6 : 1 }}
      disabled={disabled || processing}
      onClick={onClick}>
      {children}
    </button>
  );
}

// 由源素材真实路径推导美颜输出路径：<目录>/<stem>_skin_mask.mp4（绝对路径，Windows 用正斜杠）
// 完全复制 KeyingTab.matteOutputPath 的目录/文件名解析逻辑，仅把后缀换成 _skin_mask.mp4。
function beautyMaskOutputPath(assetPath: string): string {
  const idx = Math.max(assetPath.lastIndexOf('/'), assetPath.lastIndexOf('\\'));
  const dir = idx >= 0 ? assetPath.slice(0, idx + 1) : '';
  const file = idx >= 0 ? assetPath.slice(idx + 1) : assetPath;
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  return `${dir}${stem}_skin_mask.mp4`;
}

// 由源素材真实路径推导 warp 形变图输出 base：<目录>/<stem>_warp（后端写出 <base>_warp_x.gray / <base>_warp_y.gray）
function warpOutputBase(assetPath: string): string {
  const idx = Math.max(assetPath.lastIndexOf('/'), assetPath.lastIndexOf('\\'));
  const dir = idx >= 0 ? assetPath.slice(0, idx + 1) : '';
  const file = idx >= 0 ? assetPath.slice(idx + 1) : assetPath;
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  return `${dir}${stem}_warp`;
}

// 肤色预设（单选，不参与 0~100 映射）
const SKIN_TONES: { value: SkinTone; label: string }[] = [
  { value: 'none', label: '无' },
  { value: 'cool', label: '冷白' },
  { value: 'natural', label: '自然' },
  { value: 'warm', label: '暖调' },
  { value: 'wheat', label: '小麦' },
  { value: 'bronze', label: '古铜' },
];

export default function BeautyTab({ clip, trackId }: { clip: ClipConfig; trackId: string }) {
  const updateClip = useProjectStore((s) => s.updateClip);
  const updateClipLive = useProjectStore((s) => s.updateClipLive);
  const pushHistorySnapshot = useProjectStore((s) => s.pushHistorySnapshot);
  const project = useProjectStore((s) => s.project);

  const beauty = clip.beauty || null;

  const commit = (next: BeautyConfig | undefined) => updateClip(trackId, clip.id, { beauty: next });
  const commitLive = (next: BeautyConfig) => updateClipLive(trackId, clip.id, { beauty: next });

  // 生成皮肤遮罩：处理中 + 错误提示 + 皮肤覆盖反馈
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<number | null>(null);
  // 生成形变网格（warp）：处理中 + 错误提示（与皮肤遮罩独立，互不阻塞）
  const [processingWarp, setProcessingWarp] = useState(false);
  const [errorWarp, setErrorWarp] = useState<string | null>(null);
  // warp 重新生成防抖计时器（滑块释放后带新值重新调 generateWarp）
  const warpDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disabled = !beauty?.enabled; // 整体禁用态：关闭美颜时所有参数置灰

  const setField = (patch: Partial<BeautyConfig>, live = false) => {
    if (!beauty) return;
    const next = { ...beauty, ...patch };
    if (live) commitLive(next);
    else { pushHistorySnapshot(); commit(next); }
  };

  const toggleEnabled = () => setField({ enabled: !beauty!.enabled });

  // 未启用：提供一键开启（默认配置带非零基线，避免「生成遮罩后无效果」）
  if (!beauty) {
    const DEFAULT_BEAUTY: BeautyConfig = {
      enabled: false,
      smoothing: 50,
      whitening: 25,
      clarity: 15,
      skinTone: 'none',
    };
    return (
      <div>
        <div style={{ color: '#aaa', fontSize: 11, textAlign: 'center', padding: 12 }}>本片段未启用美颜</div>
        <button style={{ ...S.btn, width: '100%' }} onClick={() => { pushHistorySnapshot(); commit(DEFAULT_BEAUTY); }}>
          + 开启美颜
        </button>
      </div>
    );
  }

  // 生成皮肤遮罩：取源素材真实路径 → 调 IPC 生成 mask → 注册素材 + 回写 beauty.maskAssetId
  const runGenerate = async () => {
    if (processing) return;
    const store = useProjectStore.getState();
    const asset = store.project.assets.find((a) => a.id === clip.assetId);
    if (!asset || !asset.path) {
      alert('找不到源素材路径，无法生成皮肤遮罩');
      return;
    }
    const assetPath = asset.path;            // 真实文件系统路径（非 aicut-asset://）
    const fps = asset.fps ?? 30;
    const output = beautyMaskOutputPath(assetPath); // 绝对路径 <stem>_skin_mask.mp4
    setError(null);
    setProcessing(true);
    try {
      // 结构变更：先压一次历史快照
      pushHistorySnapshot();
      // 与 keying:* 一致的 IPC 契约：handler 返回 { success, data, error } 对象，不可再做 JSON.parse。
      const res = await (window as unknown as { aicut: { beauty: { generate(p: string, cfg: string): Promise<{ success?: boolean; error?: string; data?: unknown }> } } }).aicut.beauty.generate(
        assetPath,
        JSON.stringify({ smoothing: beauty.smoothing, whitening: beauty.whitening, clarity: beauty.clarity, skinTone: beauty.skinTone, fps, output })
      );
      if (!res?.success) throw new Error(res?.error || '生成皮肤遮罩失败');
      // 后端返回多区域（脸/脖/臂）mask 路径及总皮肤覆盖率
      const result = (res.data ?? {}) as {
        faceMaskPath?: string; neckMaskPath?: string; armMaskPath?: string;
        skinCoverage?: number; width?: number; height?: number; fps?: number; frames?: number;
      };
      // 注册三个区域 mask 资产（脸/脖/臂），各自独立资产 id
      const mkAsset = (p?: string): string | undefined => {
        if (!p) return undefined;
        const id = uid('asset');
        store.addAsset({
          id, type: 'video', path: p,
          duration: (result.frames ?? 0) / (result.fps ?? fps),
          width: result.width, height: result.height, fps: result.fps,
        });
        return id;
      };
      const faceId = mkAsset(result.faceMaskPath);
      const neckId = mkAsset(result.neckMaskPath);
      const armId = mkAsset(result.armMaskPath);
      // 若三项参数均为 0（旧工程或仅开启未调），套用非零基线，确保生成遮罩后有可见效果
      const baseline = (beauty.smoothing === 0 && beauty.whitening === 0 && beauty.clarity === 0)
        ? { smoothing: 50, whitening: 25, clarity: 15 }
        : {};
      // 写入三区域资产 id（合并 union 由预览侧 applyBeautyMulti 处理）；兼容保留旧单 maskAssetId（指向脸区域）
      const next: MultiMaskBeauty = {
        ...(beauty as MultiMaskBeauty),
        ...baseline,
        enabled: true,
        faceMaskAssetId: faceId,
        neckMaskAssetId: neckId,
        armMaskAssetId: armId,
        maskAssetId: faceId ?? beauty.maskAssetId,
      };
      store.updateClip(trackId, clip.id, { beauty: next });
      setCoverage(typeof result.skinCoverage === 'number' ? result.skinCoverage : null);
    } catch (e: unknown) {
      console.error('生成皮肤遮罩失败', e);
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      alert('生成皮肤遮罩失败：' + msg);
    } finally {
      setProcessing(false);
    }
  };

  // 实时读取本 clip 最新的 beauty 配置（滑块 debounce 重新生成时，闭包里的 beauty 可能滞后，故从 store 取最新）。
  const currentBeauty = (): BeautyConfig | undefined => {
    const st = useProjectStore.getState();
    for (const tr of st.project.tracks ?? []) {
      const c = (tr.clips ?? []).find((x) => x.id === clip.id);
      if (c && c.beauty) return c.beauty;
    }
    return undefined;
  };

  // 生成形变网格（warp）：调 generateWarp → 注册两张 gray16le 形变图资产 → 回写 warpXAssetId/warpYAssetId。
  // 完全镜像 runGenerate 的 IPC→addAsset→updateClip 契约与风格。
  const runGenerateWarp = async () => {
    if (processingWarp) return;
    const store = useProjectStore.getState();
    const asset = store.project.assets.find((a) => a.id === clip.assetId);
    if (!asset || !asset.path) {
      alert('找不到源素材路径，无法生成形变网格');
      return;
    }
    const assetPath = asset.path;            // 真实文件系统路径（非 aicut-asset://）
    const fps = asset.fps ?? 30;
    const outputBase = warpOutputBase(assetPath); // <dir><stem>_warp
    const cur = currentBeauty() ?? beauty;
    const thinFace = cur.thinFace ?? 0;
    const bigEye = cur.bigEye ?? 0;
    setErrorWarp(null);
    setProcessingWarp(true);
    try {
      // 结构变更：先压一次历史快照
      pushHistorySnapshot();
      // 与 beauty:generateMask 一致的 IPC 契约：handler 返回 { success, data, error }。
      const res = await (window as unknown as { aicut: { beauty: { generateWarp(p: string, cfg: string): Promise<{ success?: boolean; error?: string; data?: unknown }> } } }).aicut.beauty.generateWarp(
        assetPath,
        JSON.stringify({ mode: 'warp', thinFace, bigEye, fps, outputBase })
      );
      if (!res?.success) throw new Error(res?.error || '生成形变网格失败');
      const result = (res.data ?? {}) as {
        warpXPath?: string; warpYPath?: string; width?: number; height?: number; fps?: number; frames?: number;
      };
      if (!result.warpXPath || !result.warpYPath) throw new Error('后端未返回 warpXPath/warpYPath');
      // 注册两张形变图资产（X/Y 通道），各自独立资产 id（type 用 video 仅作容器，内容非播放视频）
      const mkAsset = (p?: string): string | undefined => {
        if (!p) return undefined;
        const id = uid('asset');
        store.addAsset({
          id, type: 'video', path: p,
          duration: (result.frames ?? 0) / (result.fps ?? fps),
          width: result.width, height: result.height, fps: result.fps,
        });
        return id;
      };
      const warpXAssetId = mkAsset(result.warpXPath);
      const warpYAssetId = mkAsset(result.warpYPath);
      // 回写 warp 资产 id（合并 union，保留其他 beauty 字段）；先压历史快照（已在前面压过）。
      const next: MultiMaskBeauty = {
        ...(cur as MultiMaskBeauty),
        warpXAssetId,
        warpYAssetId,
      };
      store.updateClip(trackId, clip.id, { beauty: next });
    } catch (e: unknown) {
      console.error('生成形变网格失败', e);
      const msg = e instanceof Error ? e.message : String(e);
      setErrorWarp(msg);
      alert('生成形变网格失败：' + msg);
    } finally {
      setProcessingWarp(false);
    }
  };

  // 滑块释放（pointerup）且已生成过 warp 资产时，带新值 debounce(~300ms) 重新生成形变网格，即时更新预览。
  const scheduleWarpRegen = () => {
    const cur = currentBeauty() ?? beauty;
    if (!(cur.warpXAssetId || cur.warpYAssetId)) return; // 尚未生成过网格则不自动重算
    if ((cur.thinFace ?? 0) <= 0 && (cur.bigEye ?? 0) <= 0) return; // 形变强度全为 0 无意义
    if (warpDebounceRef.current) clearTimeout(warpDebounceRef.current);
    warpDebounceRef.current = setTimeout(() => { void runGenerateWarp(); }, 300);
  };

  const mb = beauty as MultiMaskBeauty;
  const hasMask = !!(mb.faceMaskAssetId || mb.neckMaskAssetId || mb.armMaskAssetId || beauty.maskAssetId);
  const hasWarp = !!(mb.warpXAssetId || mb.warpYAssetId);

  // 已生成区域统计（脸/脖/臂）
  const regionLabels: string[] = [];
  if (mb.faceMaskAssetId) regionLabels.push('脸');
  if (mb.neckMaskAssetId) regionLabels.push('脖');
  if (mb.armMaskAssetId) regionLabels.push('臂');

  return (
    <div>
      <div style={S.row}>
        <span style={S.label}>启用</span>
        <ToggleBtn active={beauty.enabled} onClick={toggleEnabled}>{beauty.enabled ? '已开启' : '已关闭'}</ToggleBtn>
        {disabled && <span style={{ color: '#8895b3', fontSize: 10, marginLeft: 4 }}>（参数已锁定）</span>}
        <button style={{ ...S.btn, marginLeft: 'auto', color: '#e94560' }} onClick={() => { pushHistorySnapshot(); commit(undefined); }}>移除</button>
      </div>

      <div style={S.divider} />

      <SectionTitle>皮肤参数</SectionTitle>
      <ParamSlider label="磨皮" value={beauty.smoothing} min={0} max={100} step={1} editable disabled={disabled}
        onChange={(v) => setField({ smoothing: v }, true)} onEditStart={pushHistorySnapshot} />
      <ParamSlider label="美白" value={beauty.whitening} min={0} max={100} step={1} editable disabled={disabled}
        onChange={(v) => setField({ whitening: v }, true)} onEditStart={pushHistorySnapshot} />
      <ParamSlider label="清晰" value={beauty.clarity} min={0} max={100} step={1} editable disabled={disabled}
        onChange={(v) => setField({ clarity: v }, true)} onEditStart={pushHistorySnapshot} />

      <div style={S.divider} />

      <SectionTitle>五官形变（瘦脸/大眼）</SectionTitle>
      <ParamSlider label="瘦脸" value={beauty.thinFace ?? 0} min={0} max={1} step={0.01} editable disabled={disabled}
        onChange={(v) => setField({ thinFace: v }, true)} onEditStart={pushHistorySnapshot} onEditEnd={scheduleWarpRegen} />
      <ParamSlider label="大眼" value={beauty.bigEye ?? 0} min={0} max={1} step={0.01} editable disabled={disabled}
        onChange={(v) => setField({ bigEye: v }, true)} onEditStart={pushHistorySnapshot} onEditEnd={scheduleWarpRegen} />
      <Hint>滑块预览即时生效需先「生成形变网格」；释放滑块会在已生成网格时自动按新值重算</Hint>

      <div style={S.divider} />

      <SectionTitle>肤色预设</SectionTitle>
      <div style={S.row}>
        <span style={S.label}>肤色</span>
        <select value={beauty.skinTone} disabled={disabled}
          onChange={(e) => setField({ skinTone: e.target.value as SkinTone })}
          style={{ flex: 1, background: '#0f3460', border: '1px solid #1a1a2e', borderRadius: 4, color: '#eee', padding: '4px 6px', fontSize: 11, opacity: disabled ? 0.5 : 1 }}>
          {SKIN_TONES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
      </div>
      <Hint>肤色预设为单选，不参与磨皮/美白/清晰的 0~100 映射</Hint>

      <div style={S.divider} />

      <SectionTitle>皮肤遮罩</SectionTitle>
      {hasMask ? (
        <div style={{ color: '#7CFC9A', fontSize: 11, marginBottom: 8 }}>
          已生成{regionLabels.length > 0 ? `多区域遮罩（${regionLabels.join('/')}）` : '遮罩'}，可重新生成
          {coverage !== null && (
            <div style={{ color: coverage > 0.01 ? '#8895b3' : '#e9a23b', fontSize: 10, marginTop: 4 }}>
              总皮肤覆盖约 {(coverage * 100).toFixed(1)}%
              {coverage <= 0.01 ? '（偏低，可能未识别到皮肤，可重新生成或检查画面）' : ''}
            </div>
          )}
        </div>
      ) : (
        <div style={{ color: '#aaa', fontSize: 11, marginBottom: 8 }}>尚未生成皮肤遮罩，点击下方按钮开始多区域推理（脸/脖/臂）</div>
      )}

      <GenerateButton processing={processing} disabled={disabled} onClick={runGenerate}>
        {processing ? '多区域遮罩生成中…' : (hasMask ? '重新生成多区域遮罩' : '生成多区域遮罩')}
      </GenerateButton>

      {error && (
        <div style={{ color: '#e9a23b', fontSize: 11, marginTop: 8, wordBreak: 'break-all' }}>错误：{error}</div>
      )}

      <div style={S.divider} />

      <SectionTitle>形变网格（warp）</SectionTitle>
      {hasWarp ? (
        <div style={{ color: '#7CFC9A', fontSize: 11, marginBottom: 8 }}>
          已生成形变网格（瘦脸/大眼），可重新生成或使用滑块实时微调
        </div>
      ) : (
        <div style={{ color: '#aaa', fontSize: 11, marginBottom: 8 }}>尚未生成形变网格，调好瘦脸/大眼强度后点击下方按钮生成（warp 形变图）</div>
      )}

      <GenerateButton processing={processingWarp} disabled={disabled} onClick={runGenerateWarp}>
        {processingWarp ? '形变网格生成中…' : (hasWarp ? '重新生成形变网格' : '生成形变网格')}
      </GenerateButton>

      {errorWarp && (
        <div style={{ color: '#e9a23b', fontSize: 11, marginTop: 8, wordBreak: 'break-all' }}>错误：{errorWarp}</div>
      )}
    </div>
  );
}
