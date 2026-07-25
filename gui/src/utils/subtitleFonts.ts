// 视频字幕 / 文字常用字体目录 + 字幕样式预设
// 说明：已按需求剔除商用需授权的字体（微软雅黑、苹方）。
// 所选字体要么随操作系统免费提供（楷体/黑体/仿宋），要么为开源/厂商永久免费商用
// （思源系列、阿里巴巴普惠体、鸿蒙、站酷系），要么为平台原生（抖音美好体），要么为英文开源（Impact/Bebas）。
//
// 内置字体：思源/阿里普惠/鸿蒙/站酷 已随安装包内置到 gui/public/fonts（打包后位于
// process.resourcesPath/fonts）。渲染器通过 @font-face 加载 /fonts/*.woff2(ttf)，
// 导出时由 Rust 引擎按 BUNDLED_FONT_FILES 拼 fontfile= 路径，保证预览/导出字体一致。

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
  // ── 系统字体（随 OS 免费提供，个人/商用都无授权风险） ──
  { id: 'kaiti', label: '楷体', group: '系统字体', css: "KaiTi, STKaiti, 'Kaiti SC', serif", note: '系统自带' },
  { id: 'simhei', label: '黑体', group: '系统字体', css: "SimHei, Heiti SC, 'Microsoft YaHei', sans-serif", note: '系统自带' },
  { id: 'fangsong', label: '仿宋', group: '系统字体', css: "FangSong, STFangsong, serif", note: '系统自带' },

  // ── 开源 / 厂商永久免费商用（随安装包内置） ──
  { id: 'source-han-sans', label: '思源黑体', group: '开源·免费商用', bundled: 'NotoSansSC-Regular.woff2', css: "'Source Han Sans SC', 'Noto Sans SC', 'NotoSansSC', 'Source Han Sans', sans-serif" },
  { id: 'alipuhui', label: '阿里巴巴普惠体', group: '开源·免费商用', bundled: 'AlibabaPuHuiTi-Regular.woff2', css: "'Alibaba PuHuiTi', 'AlibabaPuHuiTi', 'Alibaba Sans', sans-serif" },
  { id: 'source-han-serif', label: '思源宋体', group: '开源·免费商用', bundled: 'NotoSerifSC-Regular.woff2', css: "'Source Han Serif SC', 'Noto Serif SC', 'NotoSerifSC', 'Source Han Serif', serif" },
  { id: 'harmonyos', label: '鸿蒙字体', group: '开源·免费商用', bundled: 'HarmonyOS-SansSC-Regular.ttf', css: "'HarmonyOS Sans SC', 'HarmonyOS Sans', sans-serif" },
  { id: 'zcool-kuaile', label: '站酷快乐体', group: '开源·免费商用', bundled: 'ZCOOLKuaiLe-Regular.ttf', css: "'ZCOOL KuaiLe', sans-serif" },
  { id: 'zcool-hei', label: '站酷酷黑', group: '开源·免费商用', bundled: 'ZCOOLQingKeHuangYou-Regular.ttf', css: "'ZCOOL QingKe HuangYOu', sans-serif" },

  // ── 平台 / 品牌原生字体（依赖用户系统/平台，未内置） ──
  { id: 'douyin', label: '抖音美好体', group: '平台·品牌字体', css: "'Douyin Sans', '字节跳动字体', sans-serif" },

  // ── 英文标题（开源，系统通常自带） ──
  { id: 'impact', label: 'Impact', group: '英文标题', css: "Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif" },
  { id: 'bebas', label: 'Bebas Neue', group: '英文标题', css: "'Bebas Neue', Impact, sans-serif" },
];

const FONT_MAP = new Map(SUBTITLE_FONTS.map((f) => [f.id, f]));

// 解析字体 id → CSS font-family；未知 id 回退到思源黑体链，保证永不显示异常
export function findFontCss(id?: string): string {
  if (id && FONT_MAP.has(id)) return FONT_MAP.get(id)!.css;
  return FONT_MAP.get('source-han-sans')!.css;
}

// 默认字体（新建文字/字幕片段时使用）
export const DEFAULT_FONT_ID = 'source-han-sans';

// 内置字体文件名 → 字体 id（供 Rust 引擎将 family 名解析为 fontfile 路径时使用）。
// 注意：key 用文件名，因为导出侧只拿到 font_family 字符串，会优先匹配内置文件名。
export const BUNDLED_FONT_FILES: Record<string, string> = {
  // 思源黑体（导入工程时 family 名可能是下面任一写法）
  'NotoSansSC-Regular.woff2': 'NotoSansSC-Regular.woff2',
  'NotoSansSC-Bold.woff2': 'NotoSansSC-Bold.woff2',
  // 思源宋体
  'NotoSerifSC-Regular.woff2': 'NotoSerifSC-Regular.woff2',
  'NotoSerifSC-Bold.woff2': 'NotoSerifSC-Bold.woff2',
  // 阿里巴巴普惠体
  'AlibabaPuHuiTi-Regular.woff2': 'AlibabaPuHuiTi-Regular.woff2',
  'AlibabaPuHuiTi-Bold.woff2': 'AlibabaPuHuiTi-Bold.woff2',
  'AlibabaPuHuiTi-Thin.woff2': 'AlibabaPuHuiTi-Thin.woff2',
  // 鸿蒙
  'HarmonyOS-SansSC-Regular.ttf': 'HarmonyOS-SansSC-Regular.ttf',
  'HarmonyOS-SansSC-Bold.ttf': 'HarmonyOS-SansSC-Bold.ttf',
  // 站酷
  'ZCOOLKuaiLe-Regular.ttf': 'ZCOOLKuaiLe-Regular.ttf',
  'ZCOOLQingKeHuangYou-Regular.ttf': 'ZCOOLQingKeHuangYou-Regular.ttf',
};

// 注入 @font-face：让渲染器优先使用内置字体文件（离线与导出一致）。
// 仅在浏览器环境（renderer）调用一次。
// fontsDir：由主进程 getFontsDir() 返回（dev=仓库/gui/public/fonts，打包=resources/fonts）。
// 开发模式页面跑在 http(s)，直接用 '/fonts/...'（vite 由 public 提供）；
// 打包模式页面跑在 file://，必须用绝对 file:// 路径指向 resources/fonts。
let injected = false;
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
    // 用字体 id 作为 family 名，保证与 findFontCss 中的 'NotoSansSC' 等别名匹配
    const family = f.id.replace(/-/g, ' ');
    // 同时注册带连字符的别名，覆盖 css 链里写死的 'NotoSansSC' / 'NotoSerifSC'
    const alias = f.id.replace(/-/g, '');
    const isWoff2 = f.bundled.endsWith('.woff2');
    const fmt = isWoff2 ? 'woff2' : 'truetype';
    faces.push(
      `@font-face{font-family:'${alias}';font-style:normal;font-weight:normal;font-display:swap;src:url('${base}${f.bundled}') format('${fmt}');}`,
    );
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
  fontWeight?: string;      // 字重
}

// 字幕样式预设：字体 + 描边 + 配色 打包，一键应用到当前片段
export const SUBTITLE_STYLE_PRESETS: SubtitleStylePreset[] = [
  { key: 'clear', label: '通用清晰', fontId: 'source-han-sans', color: '#ffffff', strokeColor: '#000000', strokeWidth: 2, fontWeight: 'bold' },
  { key: 'ecom', label: '电商带货', fontId: 'alipuhui', color: '#FFE135', strokeColor: '#000000', strokeWidth: 2, fontWeight: 'bold' },
  { key: 'guofeng', label: '古风情感', fontId: 'kaiti', color: '#F5F5F5', strokeColor: '#5C3A21', strokeWidth: 2.5, fontWeight: 'normal' },
  { key: 'tech', label: '数码科技', fontId: 'harmonyos', color: '#EAF2FF', strokeColor: '#1A3A6B', strokeWidth: 1.5, fontWeight: 'bold' },
  { key: 'title', label: '标题冲击', fontId: 'zcool-hei', color: '#ffffff', strokeColor: '#000000', strokeWidth: 3, fontWeight: 'bold' },
  { key: 'news', label: '严肃新闻', fontId: 'fangsong', color: '#1A1A1A', strokeColor: '#ffffff', strokeWidth: 1, fontWeight: 'normal' },
];
