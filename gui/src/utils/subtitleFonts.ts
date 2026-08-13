// 视频字幕 / 文字常用字体目录 + 字幕样式预设
// 原则：只保留“本机/随包确实有完整字形文件”的字体，避免下拉菜单出现无法正确导出的字体。
//
// 系统字体（楷体/黑体/仿宋）与 Impact：从 Windows 系统字体目录复制到 gui/public/fonts，
// 随安装包分发。注意这些字体带有微软/方正授权，仅供本产品在授权环境下使用。
//
// 思源黑体：从系统 NotoSansSC-VF.ttf 抽取 Regular/Bold 静态实例，生成 NotoSansSC-*.ttf，
// 解决仓库原有 .woff2 子集缺失中文、ffmpeg drawtext 渲染为白色方框（tofu）的问题。
//
// 站酷快乐体 / 站酷酷黑 / Bebas Neue：已有完整 TTF，直接随包。
//
// 导出时 Rust 引擎按 BUNDLED_FONT_FILES 将字体 id 解析为 fontfile= 路径；若随包目录缺失，
// 还会回退到系统字体库（C:/Windows/Fonts 等），最后再使用全局兜底字体。保证预览与导出
// 尽量一致，不再强制把所有中文回退到单一字体。

export interface SubtitleFont {
  id: string;            // 稳定标识（存进工程）
  label: string;         // 下拉显示名
  group: string;         // 分组名（optgroup）
  css: string;           // 实际 font-family 回退链
  note?: string;         // 可选说明（如「系统自带」）
  bundled?: string;      // 内置字体文件名（位于 /fonts/ 与安装包 fonts 资源目录）
}

// 分组顺序即下拉顺序
export const SUBTITLE_FONT_GROUPS = ['系统字体', '开源·免费商用', '平台·品牌字体', '英文标题'] as const;

export const SUBTITLE_FONTS: SubtitleFont[] = [
  // ── 系统字体（已打包进安装包，同时导出也会回退到系统字体库） ──
  { id: 'kaiti', label: '楷体', group: '系统字体', bundled: 'KaiTi.ttf', css: "KaiTi, STKaiti, 'Kaiti SC', serif", note: '系统字体·已打包' },
  { id: 'simhei', label: '黑体', group: '系统字体', bundled: 'SimHei.ttf', css: "SimHei, Heiti SC, 'Microsoft YaHei', sans-serif", note: '系统字体·已打包' },
  { id: 'fangsong', label: '仿宋', group: '系统字体', bundled: 'FangSong.ttf', css: "FangSong, STFangsong, serif", note: '系统字体·已打包' },

  // ── 开源 / 免费商用（随安装包内置） ──
  { id: 'source-han-sans', label: '思源黑体', group: '开源·免费商用', bundled: 'NotoSansSC-Regular.ttf', css: "'Source Han Sans SC', 'Noto Sans SC', 'NotoSansSC', 'Source Han Sans', sans-serif" },
  { id: 'zcool-kuaile', label: '站酷快乐体', group: '开源·免费商用', bundled: 'ZCOOLKuaiLe-Regular.ttf', css: "'ZCOOL KuaiLe', sans-serif" },
  { id: 'zcool-hei', label: '站酷酷黑', group: '开源·免费商用', bundled: 'ZCOOLQingKeHuangYou-Regular.ttf', css: "'ZCOOL QingKe HuangYou', sans-serif" },

  // ── 英文标题（Impact 已打包，Bebas Neue 已内置） ──
  { id: 'impact', label: 'Impact', group: '英文标题', bundled: 'Impact.ttf', css: "Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif" },
  { id: 'bebas', label: 'Bebas Neue', group: '英文标题', bundled: 'BebasNeue-Regular.ttf', css: "'Bebas Neue', Impact, sans-serif" },
];

const FONT_MAP = new Map(SUBTITLE_FONTS.map((f) => [f.id, f]));

// 解析字体 id → CSS font-family；未知 id 回退到思源黑体链，保证永不显示异常
export function findFontCss(id?: string): string {
  if (id && FONT_MAP.has(id)) return FONT_MAP.get(id)!.css;
  return FONT_MAP.get('source-han-sans')!.css;
}

// 默认字体（新建文字/字幕片段时使用）
// 使用已验证完整包含中文的随包 TTF。
export const DEFAULT_FONT_ID = 'source-han-sans';

// 字体 id / 字体文件名 → 实际随包字体文件名（供 Rust 引擎将 family 名解析为 fontfile 路径时使用）。
// 注：旧工程/导入工程里可能出现已被移除的 id（如 alipuhui、source-han-serif、douyin、harmonyos），
// Rust 端会按关键字尽量解析到最接近的可用字体，避免 tofu。
export const BUNDLED_FONT_FILES: Record<string, string> = {
  // 系统字体（已打包）
  'kaiti': 'KaiTi.ttf',
  'KaiTi': 'KaiTi.ttf',
  'KaiTi.ttf': 'KaiTi.ttf',
  'simhei': 'SimHei.ttf',
  'SimHei': 'SimHei.ttf',
  'SimHei.ttf': 'SimHei.ttf',
  'fangsong': 'FangSong.ttf',
  'FangSong': 'FangSong.ttf',
  'FangSong.ttf': 'FangSong.ttf',
  // 思源黑体（静态实例，已替换缺失中文的 woff2 子集）
  'source-han-sans': 'NotoSansSC-Regular.ttf',
  'NotoSansSC-Regular.ttf': 'NotoSansSC-Regular.ttf',
  'NotoSansSC-Bold.ttf': 'NotoSansSC-Bold.ttf',
  // 站酷
  'zcool-kuaile': 'ZCOOLKuaiLe-Regular.ttf',
  'ZCOOLKuaiLe-Regular.ttf': 'ZCOOLKuaiLe-Regular.ttf',
  'zcool-hei': 'ZCOOLQingKeHuangYou-Regular.ttf',
  'ZCOOLQingKeHuangYou-Regular.ttf': 'ZCOOLQingKeHuangYou-Regular.ttf',
  // 英文标题
  'impact': 'Impact.ttf',
  'Impact': 'Impact.ttf',
  'Impact.ttf': 'Impact.ttf',
  'bebas': 'BebasNeue-Regular.ttf',
  'BebasNeue-Regular.ttf': 'BebasNeue-Regular.ttf',
};

// 注入 @font-face：让渲染器优先使用内置字体文件（离线与导出一致）。
// 仅在浏览器环境（renderer）调用一次。
// fontsDir：由主进程 getFontsDir() 返回（dev=仓库/gui/public/fonts，打包=resources/fonts）。
// 开发模式页面跑在 http(s)，直接用 '/fonts/...'（vite 由 public 提供）；
// 打包模式页面跑在 file://，必须用绝对 file:// 路径指向 resources/fonts。
// 关键：@font-face 的 font-family 必须与 findFontCss() 返回的 css 链里的真实字体名一致，
// 否则浏览器找不到对应 @font-face → 回退系统字体（即用户看到的「没反应」）。
let injected = false;
// 从 css 回退链里提取首个别名（去掉引号/空格），作为 font-family 注册名。
function firstFamilyName(css: string): string | null {
  // 形如 "'ZCOOL KuaiLe', sans-serif" → "ZCOOL KuaiLe"
  const m = css.match(/^\s*['"]?([^,'"]+?)['"]?\s*,/);
  return m ? m[1].trim() : null;
}
export function injectBundledFontFaces(fontsDir: string) {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const isHttp = typeof location !== 'undefined' && location.protocol.startsWith('http');
  let base: string;
  if (isHttp) {
    base = '/fonts/';
  } else {
    // 绝对路径 → file:///C:/.../resources/fonts/
    const norm = fontsDir.replace(/\\/g, '/').replace(/\/?$/, '/');
    base = `file:///${norm}`;
  }
  const style = document.createElement('style');
  style.id = 'aicut-bundled-fonts';
  const faces: string[] = [];
  for (const f of SUBTITLE_FONTS) {
    if (!f.bundled) continue;
    const family = firstFamilyName(f.css);
    if (!family) continue;
    const isWoff2 = f.bundled.endsWith('.woff2');
    const fmt = isWoff2 ? 'woff2' : 'truetype';
    faces.push(
      `@font-face{font-family:'${family}';font-style:normal;font-weight:normal;font-display:swap;src:url('${base}${f.bundled}') format('${fmt}');}`,
    );
  }
  style.textContent = faces.join('\n');
  document.head.appendChild(style);
}

export interface SubtitleStylePreset {
  key: string;
  label: string;
  fontId: string;
  color: string;            // 文字颜色
  strokeColor: string;      // 描边颜色
  strokeWidth: number;      // 描边宽度（px）
  strokeOpacity?: number;   // 描边不透明度
  fontWeight?: string;      // 字重
}

// 字幕样式预设：字体 + 描边 + 配色 打包，一键应用到当前片段
export const SUBTITLE_STYLE_PRESETS: SubtitleStylePreset[] = [
  { key: 'clear', label: '通用清晰', fontId: 'source-han-sans', color: '#ffffff', strokeColor: '#000000', strokeWidth: 2, strokeOpacity: 1, fontWeight: 'bold' },
  { key: 'ecom', label: '电商带货', fontId: 'simhei', color: '#FFE135', strokeColor: '#000000', strokeWidth: 2, strokeOpacity: 1, fontWeight: 'bold' },
  { key: 'guofeng', label: '古风情感', fontId: 'kaiti', color: '#F5F5F5', strokeColor: '#5C3A21', strokeWidth: 2.5, strokeOpacity: 1, fontWeight: 'normal' },
  { key: 'tech', label: '数码科技', fontId: 'source-han-sans', color: '#EAF2FF', strokeColor: '#1A3A6B', strokeWidth: 1.5, strokeOpacity: 1, fontWeight: 'bold' },
  { key: 'title', label: '标题冲击', fontId: 'zcool-hei', color: '#ffffff', strokeColor: '#000000', strokeWidth: 3, strokeOpacity: 1, fontWeight: 'bold' },
  { key: 'news', label: '严肃新闻', fontId: 'fangsong', color: '#1A1A1A', strokeColor: '#ffffff', strokeWidth: 1, strokeOpacity: 1, fontWeight: 'normal' },
];
