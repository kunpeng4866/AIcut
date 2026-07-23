// AI 相关类型定义（独立新增文件，不修改 types.ts）
//
// 与后端 crate::subtitle::SubtitleOverlay 字段对齐：
//   items: [{ start, end, text }]
//   fontFamily / fontSize / color / position 为可选样式。

export interface SubtitleItem {
  start: number; // 相对 clip.timelineIn 的偏移（秒）
  end: number;   // 结束偏移（秒）
  text: string;
}

export interface SubtitleGenResult {
  items: SubtitleItem[];
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  position?: 'bottom' | 'top' | 'center';
}

export interface AiState {
  isGenerating: boolean;
  result: SubtitleGenResult | null;
  error: string | null;
  transcript: string;
  lang: string;
}
