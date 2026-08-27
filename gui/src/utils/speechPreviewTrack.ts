// 口播试听片段落轨（可测模块）：从 SpeechPanel 抽出，便于用真实 projectStore 做断言测试。
// 硬约束（用户验收确立）：
//   ① 试听/最终清洗片段只允许落在「独立新轨」上，绝不落在原始素材所在轨道；
//   ② 原始素材所在轨道全程零改动（源片段保留供对比）；
//   ③ 已有试听片段时，新片段原位覆盖（同 clipId 更新，不堆积）。
// 对照轨恒为音频轨：视频源产物先经 extractAudio 抽纯音轨（m4a）再上轨，
// 否则 addClip 的「素材类型↔轨道类型」纠偏守卫会把视频资产重定向回主视频轨
// （=原素材所在轨道），造成覆盖。
import type { ClipConfig } from '../types';

const uid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export interface PreviewTrackDeps {
  // 真实 projectStore（getState/actions 均来自同一 zustand 实例）
  getStore: () => {
    project: {
      tracks: {
        id: string;
        type: string;
        isMain?: boolean;
        clips: { id: string; assetId: string; timelineIn: number; timelineOut: number }[];
      }[];
      assets: { id: string; path: string; type: string }[];
    };
    addAsset(a: { id: string; type: 'video' | 'audio'; path: string; duration: number; fps?: number }): void;
    addTrack(t: 'video' | 'audio'): string;
    addClip(trackId: string, clip: ClipConfig): void;
    updateClip(trackId: string, clipId: string, updates: Partial<ClipConfig>): void;
  };
  selectedAsset: { id: string; type: string; fps?: number } | null;
  // 视频源时把 mp4 抽成纯音频；测试里可注入 mock
  extractAudio: (src: string, dst: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  previewRef: { current: { clipId: string; trackId: string } | null };
  onMessage?: (msg: string) => void;
}

export interface UpsertResult {
  ok: boolean;
  error?: string;
  clipId?: string;
  trackId?: string;
  assetPath?: string;
}

export const upsertPreviewOnTrack = async (
  deps: PreviewTrackDeps,
  assetPath: string,
  dur: number,
  isFinal = false,
): Promise<UpsertResult> => {
  const selectedAsset = deps.selectedAsset;
  let assetPathOut = assetPath;
  if (!selectedAsset) return { ok: false, error: '未选中素材' };
  // 视频源产物含视频轨：抽成纯音频后再上轨（否则被 addClip 纠偏回主视频轨→覆盖原素材）
  if (selectedAsset.type === 'video') {
    const m4a = assetPath.replace(/\.mp4$/i, '_preview.m4a');
    const r = await deps.extractAudio(assetPath, m4a);
    if (!r.success || !r.path) {
      deps.onMessage?.(`试听音频轨抽取失败：${r.error || '未知错误'}`);
      return { ok: false, error: r.error || 'extract failed' };
    }
    assetPathOut = r.path;
  }
  const st = deps.getStore();
  const previewAsset = {
    id: uid('asset'),
    type: 'audio' as const, // 对照轨恒为音频资产：与源视频/音频轨互不干扰
    path: assetPathOut,
    duration: dur,
    fps: selectedAsset.fps,
  };
  st.addAsset(previewAsset);
  const tracksNow = () => deps.getStore().project.tracks;
  // 定位/创建试听轨：优先复用已有试听片段所在的轨
  let trackId = deps.previewRef.current?.trackId;
  let track = trackId ? tracksNow().find((t) => t.id === trackId) : undefined;
  if (!track) {
    const tid = st.addTrack('audio');
    track = tracksNow().find((t) => t.id === tid);
  }
  if (!track) return { ok: false, error: '试听轨创建失败' };
  // 硬约束①：解析出的轨道若与原始素材所在轨道相同 → 强制再新建一条
  const srcTrackId = tracksNow()
    .find((t) => t.clips.some((c) => c.assetId === selectedAsset.id))?.id;
  if (srcTrackId && track.id === srcTrackId) {
    const tid = st.addTrack('audio');
    track = tracksNow().find((t) => t.id === tid);
    if (!track) return { ok: false, error: '试听轨创建失败' };
  }
  // 硬约束②：与源素材片段的 timelineIn 对齐（播放头同步对照）
  const srcClip = tracksNow()
    .flatMap((t) => t.clips)
    .find((c) => c.assetId === selectedAsset.id);
  const tin = srcClip ? srcClip.timelineIn : 0;
  const existingId = deps.previewRef.current?.clipId;
  const existing = existingId ? track.clips.find((c) => c.id === existingId) : undefined;
  if (existingId && existing) {
    // 硬约束③：原位覆盖（同 clipId 更新资产/时长）
    st.updateClip(track.id, existingId, {
      assetId: previewAsset.id,
      src_range: { start: 0, end: dur },
      timelineIn: tin,
      timelineOut: tin + dur,
    });
  } else {
    const clip: ClipConfig = {
      id: uid('clip'),
      assetId: previewAsset.id,
      src_range: { start: 0, end: dur },
      timelineIn: tin,
      timelineOut: tin + dur,
      transform: { x: 0.5, y: 0.5, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
      volume: 1,
      speed: 1,
      effects: [],
      masks: [],
      filters: [],
      keyframes: {},
    };
    st.addClip(track.id, clip);
    deps.previewRef.current = { clipId: clip.id, trackId: track.id };
  }
  // 返回最新落位信息（updateClip/addClip 后重读实时状态）
  const ref = deps.previewRef.current!;
  return { ok: true, clipId: ref.clipId, trackId: ref.trackId, assetPath: assetPathOut };
};
