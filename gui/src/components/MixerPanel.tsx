// 混音器面板 — 轨道级音量 / 声相 / 静音 / 独奏控制
// 数据直接写入 TrackConfig.volume / pan（与后端导出混音管线对应）
import { useRef } from 'react';
import { useProjectStore } from '../store/projectStore';
import type { TrackConfig } from '../types';

const TYPE_LABEL: Record<string, string> = {
  video: '视频', audio: '音频', effect: '特效', text: '文字', sticker: '贴纸', subtitle: '字幕',
};

const S = {
  panel: { height: '100%', display: 'flex', flexDirection: 'column' as const, background: '#16213e', fontFamily: 'system-ui' },
  header: { padding: '10px 12px', fontSize: 13, fontWeight: 700 as const, color: '#eee', borderBottom: '1px solid #0f3460' },
  list: { flex: 1, overflow: 'auto', padding: 8 },
  row: { background: '#0f3460', borderRadius: 4, padding: 8, marginBottom: 8 },
  rowHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  name: { fontSize: 12, color: '#eee', fontWeight: 600 as const },
  tag: { fontSize: 10, color: '#aaa', background: '#1a1a2e', padding: '1px 6px', borderRadius: 3, marginLeft: 6 },
  btns: { display: 'flex', gap: 4 },
  btn: { background: '#1a1a2e', color: '#eee', border: '1px solid #0f3460', borderRadius: 4, padding: '3px 8px', fontSize: 11, cursor: 'pointer' },
  btnActive: { background: '#e94560', color: '#fff', border: '1px solid #e94560' },
  label: { color: '#aaa', fontSize: 11, width: 34, flexShrink: 0 },
  row2: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  panVal: { color: '#eee', fontSize: 11, width: 40, textAlign: 'right' as const },
};

// 声相显示：0=居中(C)，负=左(Lx)，正=右(Rx)
function panLabel(pan: number): string {
  if (Math.abs(pan) < 0.005) return 'C';
  const p = Math.round(Math.abs(pan) * 100);
  return pan < 0 ? `L${p}` : `R${p}`;
}

export default function MixerPanel() {
  const tracks = useProjectStore((s) => s.project.tracks);
  const updateTrackVolumeLive = useProjectStore((s) => s.updateTrackVolumeLive);
  const updateTrackPanLive = useProjectStore((s) => s.updateTrackPanLive);
  const pushHistorySnapshot = useProjectStore((s) => s.pushHistorySnapshot);
  const toggleTrackMute = useProjectStore((s) => s.toggleTrackMute);
  const toggleTrackSolo = useProjectStore((s) => s.toggleTrackSolo);
  // 连续拖动轨道音量/声相：拖前压一次快照，拖中走 live（不每帧深拷贝整工程，避免黑屏）
  const draggingRef = useRef(false);
  const beginDrag = () => { if (!draggingRef.current) { draggingRef.current = true; pushHistorySnapshot(); } };
  const endDrag = () => { draggingRef.current = false; };

  // 仅显示可能发声的轨道
  const audioTracks = tracks.filter((t) => t.type === 'audio' || t.type === 'video' || t.type === 'effect');

  return (
    <div style={S.panel}>
      <div style={S.header}>混音器</div>
      <div style={S.list}>
        {audioTracks.length === 0 && (
          <div style={{ color: '#aaa', fontSize: 12, textAlign: 'center', padding: 20 }}>
            暂无可混音轨道（添加视频 / 音频 / 特效轨道）
          </div>
        )}
        {audioTracks.map((t: TrackConfig) => {
          const vol = t.volume ?? 1;
          const pan = t.pan ?? 0;
          return (
            <div key={t.id} style={S.row}>
              <div style={S.rowHead}>
                <div>
                  <span style={S.name}>{t.isMain ? '主轨' : `轨道 ${t.id.slice(-4)}`}</span>
                  <span style={S.tag}>{TYPE_LABEL[t.type] ?? t.type}</span>
                </div>
                <div style={S.btns}>
                  <button style={{ ...S.btn, ...(t.muted ? S.btnActive : {}) }} onClick={() => toggleTrackMute(t.id)} title="静音">M</button>
                  <button style={{ ...S.btn, ...(t.solo ? S.btnActive : {}) }} onClick={() => toggleTrackSolo(t.id)} title="独奏">S</button>
                </div>
              </div>
              <div style={S.row2}>
                <span style={S.label}>音量</span>
                <input type="range" min={0} max={2} step={0.01} value={vol}
                  onPointerDown={beginDrag} onPointerUp={endDrag}
                  onChange={(e) => { beginDrag(); updateTrackVolumeLive(t.id, parseFloat(e.target.value)); }}
                  style={{ flex: 1, accentColor: '#e94560' }} />
                <span style={{ color: '#eee', fontSize: 11, width: 38, textAlign: 'right' }}>{Math.round(vol * 100)}%</span>
              </div>
              <div style={S.row2}>
                <span style={S.label}>声相</span>
                <input type="range" min={-1} max={1} step={0.01} value={pan}
                  onPointerDown={beginDrag} onPointerUp={endDrag}
                  onChange={(e) => { beginDrag(); updateTrackPanLive(t.id, parseFloat(e.target.value)); }}
                  style={{ flex: 1, accentColor: '#e94560' }} />
                <span style={S.panVal}>{panLabel(pan)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
