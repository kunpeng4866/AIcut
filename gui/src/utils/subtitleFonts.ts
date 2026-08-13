// 视频字幕 / 文字常用字体目录 + 字幕样式预设
// 原则：只保留“本机/随包确实有完整字形文件”的字体，避免下拉菜单出现无法正确导出的字体。
//
// 系统字体（楷体/黑体/仿宋/Impact）：不随安装包分发，由导出引擎在终端用户的
// 系统字体库（C:/Windows/Fonts 等）中按字体名查找渲染，预览时浏览器也直接调用系统字体。
//
// 思源黑体：从系统 NotoSansSC-VF.ttf 抽取 Regular/Bold 静态实例，生成 NotoSansSC-*.ttf，
// 解决仓库原有 .woff2 子集缺失中文、ffmpeg drawtext 渲染为白色方框（tofu）的问题，并随包分发。
//
// 站酷快乐体 / 站酷酷黑 / Bebas Neue：已有完整 TTF，随包分发。
//
// 导出时 Rust 引擎（src/subtitle.rs 的 resolve_font）三级解析：
//   1) 随包字体目录（非系统字体）；2) 终端用户系统字体库；3) 仅当以上都缺失才兜底到 NotoSansSC。
// 系统字体一定走第 2 级，不会被直接兜底成单一字体。

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
  // ── 系统字体（不打包，导出引擎读取终端用户系统字体库；预览由浏览器调用系统字体） ──
  { id: 'kaiti', label: '楷体', group: '系统字体', css: "KaiTi, STKaiti, 'Kaiti SC', serif", note: '系统字体·不打包' },
  { id: 'simhei', label: '黑体', group: '系统字体', css: "SimHei, Heiti SC, 'Microsoft YaHei', sans-serif", note: '系统字体·不打包' },
  { id: 'fangsong', label: '仿宋', group: '系统字体', css: "FangSong, STFangsong, serif", note: '系统字体·不打包' },

  // ── 开源 / 免费商用（随安装包内置） ──
  { id: 'source-han-sans', label: '思源黑体', group: '开源·免费商用', bundled: 'NotoSansSC-Regular.ttf', css: "'Source Han Sans SC', 'Noto Sans SC', 'NotoSansSC', 'Source Han Sans', sans-serif" },
  { id: 'zcool-kuaile', label: '站酷快乐体', group: '开源·免费商用', bundled: 'ZCOOLKuaiLe-Regular.ttf', css: "'ZCOOL KuaiLe', sans-serif" },
  { id: 'zcool-hei', label: '站酷酷黑', group: '开源·免费商用', bundled: 'ZCOOLQingKeHuangYou-Regular.ttf', css: "'ZCOOL QingKe HuangYou', sans-serif" },

  // ── 英文标题（Impact 系统字体不打包；Bebas Neue 已随包内置） ──
  { id: 'impact', label: 'Impact', group: '英文标题', css: "Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif", note: '系统字体·不打包' },
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

// 字体 id / 字体文件名 → 实际随包字体文件名（仅供前端 injectBundledFontFaces 注入 @font-face 使用）。
// 仅包含“随包字体”；系统字体（楷体/黑体/仿宋/Impact）不在此表，由浏览器与导出引擎直接读取
// 终端用户系统字体库，不随包、不在此映射。
// 注：旧工程/导入工程里可能出现已被移除的 id（如 alipuhui、source-han-serif、douyin、harmonyos），
// Rust 端会按关键字尽量解析到最接近的可用字体，避免 tofu。
export const BUNDLED_FONT_FILES: Record<string, string> = {
  // 思源黑体（静态实例，已替换缺失中文的 woff2 子集）
  'source-han-sans': 'NotoSansSC-Regular.ttf',
  'NotoSansSC-Regular.ttf': 'NotoSansSC-Regular.ttf',
  'NotoSansSC-Bold.ttf': 'NotoSansSC-Bold.ttf',
  // 站酷
  'zcool-kuaile': 'ZCOOLKuaiLe-Regular.ttf',
  'ZCOOLKuaiLe-Regular.ttf': 'ZCOOLKuaiLe-Regular.ttf',
  'zcool-hei': 'ZCOOLQingKeHuangYou-Regular.ttf',
  'ZCOOLQingKeHuangYou-Regular.ttf': 'ZCOOLQingKeHuangYou-Regular.ttf',
  // 英文标题（Bebas Neue 随包；Impact 为系统字体不在此）
  'bebas': 'BebasNeue-Regular.ttf',
  'BebasNeue-Regular.ttf': 'BebasNeue-Regular.ttf',
};

// (字体 id → 字重 → 随包 ttf 文件名) 映射。与 Rust 端 FONT_ID_TO_FILE 一一对应。
// 思源黑体有独立 Bold 变体；站酷 / Bebas 无 Bold 文件，bold 回退 Regular（与 Rust 回退策略一致）。
// 这是“预览 CSS @font-face 契约”的唯一定义源，新增随包字体必须同步更新此处与 Rust 端。
export const FONT_WEIGHT_FILES: Record<string, { normal: string; bold: string }> = {
  'source-han-sans': { normal: 'NotoSansSC-Regular.ttf', bold: 'NotoSansSC-Bold.ttf' },
  'zcool-kuaile': { normal: 'ZCOOLKuaiLe-Regular.ttf', bold: 'ZCOOLKuaiLe-Regular.ttf' },
  'zcool-hei': { normal: 'ZCOOLQingKeHuangYou-Regular.ttf', bold: 'ZCOOLQingKeHuangYou-Regular.ttf' },
  'bebas': { normal: 'BebasNeue-Regular.ttf', bold: 'BebasNeue-Regular.ttf' },
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
    // 同一 font-family 注入 normal / bold 两条 @font-face：
    // - 思源黑体 bold 指向真实 NotoSansSC-Bold.ttf（消除浏览器伪粗体，与导出 Bold ttf 一致）；
    // - 无 Bold 文件的字体，bold 也指向其 Regular 文件，避免浏览器合成伪粗体造成预览/导出差异。
    const wf = FONT_WEIGHT_FILES[f.id] ?? { normal: f.bundled, bold: f.bundled };
    for (const [weight, file] of [['normal', wf.normal], ['bold', wf.bold]] as const) {
      const isWoff2 = file.endsWith('.woff2');
      const fmt = isWoff2 ? 'woff2' : 'truetype';
      faces.push(
        `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url('${base}${file}') format('${fmt}');}`,
      );
    }
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
