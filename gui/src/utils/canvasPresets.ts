// 常见视频画幅比例预设，供工程画布尺寸选择使用。
// 切换预设即设置 project.canvas 的 width/height，预览以 letterbox 等比缩放，WYSIWYG 不变。

export interface CanvasPreset {
  group: string;
  label: string;
  width: number;
  height: number;
}

export const CANVAS_PRESETS: CanvasPreset[] = [
  // 横屏
  { group: '横屏', label: '16:9 · 1920×1080 (FHD)', width: 1920, height: 1080 },
  { group: '横屏', label: '16:9 · 1280×720 (HD)', width: 1280, height: 720 },
  { group: '横屏', label: '16:9 · 3840×2160 (4K)', width: 3840, height: 2160 },
  { group: '横屏', label: '4:3 · 1440×1080', width: 1440, height: 1080 },
  // 竖屏
  { group: '竖屏', label: '9:16 · 1080×1920', width: 1080, height: 1920 },
  // 方形 / 照片
  { group: '方形/照片', label: '1:1 · 1080×1080', width: 1080, height: 1080 },
  { group: '方形/照片', label: '4:5 · 1080×1350', width: 1080, height: 1350 },
  { group: '方形/照片', label: '3:4 · 1080×1440', width: 1080, height: 1440 },
  { group: '方形/照片', label: '3:2 · 1080×720', width: 1080, height: 720 },
  { group: '方形/照片', label: '5:4 · 1280×1024', width: 1280, height: 1024 },
  // 电影宽幅
  { group: '电影宽幅', label: '21:9 · 2560×1080', width: 2560, height: 1080 },
  { group: '电影宽幅', label: '2.39:1 · 2048×858', width: 2048, height: 858 },
];

// 返回与给定宽高完全匹配预设的索引，无匹配返回 -1（自定义画布）
export const findPresetIndex = (w: number, h: number): number =>
  CANVAS_PRESETS.findIndex((p) => p.width === w && p.height === h);
