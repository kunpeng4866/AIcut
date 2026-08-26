// AIcut 补全资产清单 — 一键补全下载器的数据来源
// 精简版安装包不含 python 运行时与 AI 模型权重；用户首次用到 AI 功能时，
// 由主进程按本清单从 CDN 下载并校验，落到 userData/aicut-assets/（可写，避开 Program Files 只读）。
//
// baseUrl 可在「设置 → AI 组件管理」中填写（持久化到 config.assets.cdnBaseUrl），
// 此处 DEFAULT_CDN_BASE 仅为占位，未配置时下载会明确报错提示用户去设置。

export interface AssetEntry {
  id: string;          // 唯一标识：python | modnet | rmbg2 | sr
  name: string;        // 展示名
  kind: 'zip' | 'file';
  remoteRel: string;   // 相对 baseUrl 的下载路径
  targetSub: string;   // 落盘子目录：python | models
  targetName: string;  // 落盘文件名
  size: number;        // 字节，用于进度总量
  sha256: string;      // 期望哈希，空串表示跳过校验
  requiredBy: string[];// 哪些功能依赖：keying | sr
  absoluteUrl?: string; // 可选：绝对下载直链（如 rmbg2 走 ModelScope），有值时下载不依赖 baseUrl
}

export interface AssetsManifest {
  baseUrl: string;
  entries: AssetEntry[];
}

// ⚠️ 占位符：请替换为你的 CDN 基础地址（末尾带 /）。也可在 App 设置里填。
export const DEFAULT_CDN_BASE = 'https://REPLACE_WITH_YOUR_CDN_BASE/';

// python.zip 的 sha256 / 体积。源：Compress-Archive 打包 pack-staging/python（3.1G → 1.68G）。
// ⚠️ zip 内部自带顶层 `python/` 目录，主进程解压时必须解到 aicut-assets 根（不可再套一层 python/）。
// 换过 python 环境后必须重算：sha256sum pack-staging/download-assets/python.zip
export const PYTHON_ZIP_SHA256 = '525cdc24124888bee21c9face76cee7db90a14976368aff7d5412c3ad7195f5d';
export const PYTHON_ZIP_SIZE = 1808996778;

export function getManifest(cdnBaseUrl?: string): AssetsManifest {
  const baseUrl = (cdnBaseUrl && cdnBaseUrl.trim()) || DEFAULT_CDN_BASE;
  return {
    baseUrl,
    entries: [
      {
        id: 'python',
        name: 'Python 运行时（含 ONNX/Torch 推理依赖）',
        kind: 'zip',
        remoteRel: 'python.zip',
        targetSub: 'python',
        targetName: 'python.zip',
        size: PYTHON_ZIP_SIZE,
        sha256: PYTHON_ZIP_SHA256,
        requiredBy: ['keying', 'sr'],
      },
      {
        id: 'modnet',
        name: 'MODNet 抠像模型',
        kind: 'file',
        remoteRel: 'models/modnet.onnx',
        targetSub: 'models',
        targetName: 'modnet.onnx',
        size: 25888640,
        sha256: '07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9',
        requiredBy: ['keying'],
      },
      {
        id: 'rmbg2',
        name: 'RMBG-2.0 抠像模型',
        kind: 'file',
        remoteRel: 'models/rmbg2.onnx',
        targetSub: 'models',
        targetName: 'rmbg2.onnx',
        size: 1024331469,
        sha256: '5b486f08200f513f460da46dd701db5fbb47d79b4be4b708a19444bcd4e79958',
        requiredBy: ['keying'],
        // 完整版不内置 rmbg2，走 ModelScope 国内直链按需下载（与 python/keying/core.py 的
        // MODELSCOPE_RMBG2_URL 一致）。自建 OSS 时替换此 absoluteUrl 即可。
        absoluteUrl: 'https://modelscope.cn/api/v1/models/briaai/RMBG-2.0/repo?Revision=master&FilePath=onnx/model.onnx',
      },
      // ---- 口播降噪（P0-B：DeepFilterNet3 ONNX，多文件，落到 models/denoise/）----
      // 权重已预置于本地 E:/AIcut/python/models/denoise/，以下为打包分发用条目。
      // sha256/size 由本地文件实算。缺失时 P0-B 降级为 no-op（不报错）。
      {
        id: 'denoise-config',
        name: 'DeepFilterNet3 降噪配置',
        kind: 'file',
        remoteRel: 'models/denoise/config.ini',
        targetSub: 'models/denoise',
        targetName: 'config.ini',
        size: 2067,
        sha256: '415eb925d44990d938fb739f514aa3662c1ec0ea836cff044fa1291b82cb4290',
        requiredBy: ['speech'],
      },
      {
        id: 'denoise-enc',
        name: 'DeepFilterNet3 编码器 ONNX',
        kind: 'file',
        remoteRel: 'models/denoise/enc.onnx',
        targetSub: 'models/denoise',
        targetName: 'enc.onnx',
        size: 1954042,
        sha256: '7c5399d3da8a50ebef1c1a0ae421b33376aa5e45d0e92df16da7e83c9c131916',
        requiredBy: ['speech'],
      },
      {
        id: 'denoise-df-dec',
        name: 'DeepFilterNet3 DF 解码器 ONNX',
        kind: 'file',
        remoteRel: 'models/denoise/df_dec.onnx',
        targetSub: 'models/denoise',
        targetName: 'df_dec.onnx',
        size: 3340803,
        sha256: '23114ce3b0f6464b763ee62f7bb8aab6b2a129a21eabd5bcfe59413db05f278a',
        requiredBy: ['speech'],
      },
      {
        id: 'denoise-erb-dec',
        name: 'DeepFilterNet3 ERB 解码器 ONNX',
        kind: 'file',
        remoteRel: 'models/denoise/erb_dec.onnx',
        targetSub: 'models/denoise',
        targetName: 'erb_dec.onnx',
        size: 3292397,
        sha256: 'ab669a1d10afe20911728b33053a452071042317a90581092b325da7b2f9d895',
        requiredBy: ['speech'],
      },
      // ---- 副语言/非语音事件检测（PANNs Cnn14_DecisionLevelMax 帧级 SED）----
      // 权重 MIT 许可；本地已预置于 python/models/panns/，以下为打包分发用条目。
      // sha256/size 由本地文件实算（sha256sum python/models/panns/*）。
      // 权重缺失时 PANNs SED 自动 no-op 降级（不报错）。
      {
        id: 'panns-sed',
        name: 'PANNs Cnn14 帧级声音事件检测权重',
        kind: 'file',
        remoteRel: 'models/panns/Cnn14_DecisionLevelMax_mAP=0.385.pth',
        targetSub: 'models/panns',
        targetName: 'Cnn14_DecisionLevelMax_mAP=0.385.pth',
        size: 327428481,
        sha256: 'dd3b4043a87d4ec13df8082c0fcfee3fb5084151808e47e060987a95eabdd142',
        requiredBy: ['speech'],
      },
      {
        id: 'panns-labels',
        name: 'PANNs AudioSet527 标签表',
        kind: 'file',
        remoteRel: 'models/panns/class_labels_indices.csv',
        targetSub: 'models/panns',
        targetName: 'class_labels_indices.csv',
        size: 14675,
        sha256: 'cdd1049833c4b86127c2773ac0d14a2754b6a6d0d1798002ed5c66e699708429',
        requiredBy: ['speech'],
      },
      // TODO(P1): Qwen3-ForcedAligner 本地权重（强制对齐核心，~1.71GB，safetensors 非 ONNX，
      //   需另行导出）。当前未下载（带宽不足以 2 分钟内完成），P0 先走 whisper word_timestamps +
      //   可选 Paraformer 云端词级。接入时在此补 1 条 entry（id 'qwen3fa'），并扩展 missingForFeature。
    ],
  };
}

// 计算某功能依赖的缺失资产 id 列表（用于惰性拦截判断）
export function missingForFeature(status: Record<string, boolean>, feature: 'keying' | 'sr'): string[] {
  const need = feature === 'keying' ? ['python', 'modnet', 'rmbg2'] : ['python', 'sr'];
  return need.filter((id) => !status[id]);
}
