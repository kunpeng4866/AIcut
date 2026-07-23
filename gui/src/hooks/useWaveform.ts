import { useState, useEffect } from 'react';

// 全局缓存：assetId -> Float32Array（归一化峰值数据，长度固定为 PEAK_COUNT）
const waveformCache = new Map<string, Float32Array>();

const PEAK_COUNT = 200; // 每个波形固定 200 个峰值点

/**
 * 解码音频文件并生成波形数据。
 * 使用 AudioContext.decodeAudioData 解码，按 PEAK_COUNT 分段取最大绝对值，再归一化到 0-1。
 * 结果按 assetId 全局缓存，避免重复解码。
 *
 * @param audioUrl 音频文件 URL（aicut-asset:// 格式或其他可 fetch 的 URL）
 * @param assetId 素材 ID（用于缓存）
 * @returns { peaks: Float32Array | null, loading: boolean }
 */
export function useWaveform(audioUrl: string | null, assetId: string | null) {
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!audioUrl || !assetId) { setPeaks(null); return; }

    // 检查缓存
    const cached = waveformCache.get(assetId);
    if (cached) { setPeaks(cached); return; }

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        // 1. fetch 音频文件
        const response = await fetch(audioUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();

        // 2. 用 AudioContext 解码
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        const audioCtx = new AudioCtx();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        audioCtx.close();

        if (cancelled) return;

        // 3. 提取峰值数据：取第一个通道，按 PEAK_COUNT 分段，每段取最大绝对值
        const channelData = audioBuffer.getChannelData(0);
        const samplesPerPeak = Math.max(1, Math.floor(channelData.length / PEAK_COUNT));
        const peaksData = new Float32Array(PEAK_COUNT);

        for (let i = 0; i < PEAK_COUNT; i++) {
          let max = 0;
          const start = i * samplesPerPeak;
          const end = Math.min(start + samplesPerPeak, channelData.length);
          for (let j = start; j < end; j++) {
            const abs = Math.abs(channelData[j]);
            if (abs > max) max = abs;
          }
          peaksData[i] = max;
        }

        // 4. 归一化（找到最大值，缩放到 0-1）
        let maxPeak = 0.001;
        for (let i = 0; i < peaksData.length; i++) {
          if (peaksData[i] > maxPeak) maxPeak = peaksData[i];
        }
        const normalized = new Float32Array(PEAK_COUNT);
        for (let i = 0; i < PEAK_COUNT; i++) {
          normalized[i] = peaksData[i] / maxPeak;
        }

        // 5. 缓存
        waveformCache.set(assetId, normalized);

        if (!cancelled) setPeaks(normalized);
      } catch (err) {
        console.warn('[waveform] 解码失败:', err);
        if (!cancelled) setPeaks(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [audioUrl, assetId]);

  return { peaks, loading };
}
