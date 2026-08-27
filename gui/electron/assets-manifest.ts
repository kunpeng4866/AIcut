// AIcut 补全资产清单 — 一键补全下载器的数据来源
// 精简版安装包不含 python 运行时与 AI 模型权重；用户首次用到 AI 功能时，
// 由主进程按本清单从免费公开镜像（国内优先，外网回退）下载并校验，
// 落到 userData/aicut-assets/（可写，避开 Program Files 只读）。
//
// 分发策略（开源软件不贴钱原则）：权重一律走免费公共镜像直链 ——
// 国内默认 = ModelScope（api/v1 直链实测可 fetch），外网备选 = huggingface.co / github.com。
// 已实测不可用作直链源：hf-mirror.com（resolve 对直接 fetch 返回 404）、
// 清华 tuna HF 镜像（同样 404）、GitHub Releases（国内 000 不可达）——
// 这三者仅适合 huggingface_hub 库内使用或海外用户，不能作为 app fetch 的 DEFAULT_CDN_BASE。

export interface AssetEntry {
  id: string;          // 唯一标识：python | modnet | rmbg2 | sr
  name: string;        // 展示名
  kind: 'zip' | 'file';
  remoteRel: string;   // 相对 baseUrl 的下载路径
  targetSub: string;   // 落盘子目录：python | models
  targetName: string;  // 落盘文件名
  size: number;        // 字节，用于进度总量
  sha256: string;      // 期望哈希，空串表示跳过校验
  requiredBy: string[];// 哪些功能依赖：keying | sr | speech
  // 开源免费分发策略（不使用收费对象存储）：每个权重尽量配两条直链，
  // 下载器按「国内优先 → 外网回退」顺序尝试，用户可走国内或外网。
  domesticUrl?: string;// 国内免费用镜像直链（ModelScope api/v1，实测可 fetch）
  externalUrl?: string;// 外网直链（huggingface.co / github.com，海外或代理用户用）
  absoluteUrl?: string; // 兼容保留：单一绝对直链（旧字段，仍参与回退链）
}

export interface AssetsManifest {
  baseUrl: string;
  entries: AssetEntry[];
}

// ⚠️ 占位哨兵值：绝大多数权重已配 domesticUrl/externalUrl 免费直链，不再依赖此字段。
// 仅当某条目没有任何直链时，才需要用户在「设置 → AI 组件管理」填写自建 CDN 基础地址（末尾带 /）。
export const DEFAULT_CDN_BASE = 'https://REPLACE_WITH_YOUR_CDN_BASE/';

// Qwen3-ForcedAligner 双源基址（国内 ModelScope 官方仓库 + 外网 HuggingFace）。
// 两源为同一发布物；FilePath= 后拼文件名，或 resolve/main/ 后拼文件名。
const QWEN3FA_MS_BASE = 'https://modelscope.cn/api/v1/models/Qwen/Qwen3-ForcedAligner-0.6B/repo?Revision=master&FilePath=';
const QWEN3FA_HF_BASE = 'https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B/resolve/main/';

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
        // ⚠️ 免费分发缺口：python.zip 为自有打包产物（1.68G），无公共镜像可挂。
        // 现状：离线全量包已内置 python；精简版用户暂需自建 CDN 基址。
        // 待办：发布到自有 ModelScope 仓库（免费）后回填 domesticUrl。
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
        // ⚠️ 本地 26MB fp16 为自有导出（ModelScope 上的 Xenova/modnet 为 fp32 全量版，
        // 字节与哈希不同，不可混用）。国内默认源待发布自有 ModelScope 仓库后回填 domesticUrl；
        // 届时 externalUrl 指向 GitHub Releases 作外网备选（用户可走国内或外网）。
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
        // 完整版不内置 rmbg2。国内默认走 ModelScope 直链（实测 302 可 fetch，与
        // python/keying/core.py 的 MODELSCOPE_RMBG2_URL 一致）；外网备选 HF resolve，
        // 同一 LFS 对象、sha256 一致（双源校验防传输损坏）。
        domesticUrl: 'https://modelscope.cn/api/v1/models/briaai/RMBG-2.0/repo?Revision=master&FilePath=onnx/model.onnx',
        externalUrl: 'https://huggingface.co/briaai/RMBG-2.0/resolve/main/onnx/model.onnx',
      },
      // ---- 口播降噪（P0-B：DeepFilterNet3 ONNX，多文件，落到 models/denoise/）----
      // 权重已预置于本地 E:/AIcut/python/models/denoise/，以下为打包分发用条目。
      // sha256/size 由本地文件实算。缺失时 P0-B 降级为 no-op（不报错）。
      // ⚠️ 免费分发缺口：DFN3 三分件 + config.ini 为自有导出（HF thoratsr7/deepfilternet3-onnx
      // 有同构三分件但哈希不保证一致，不可混用）；国内默认源待发布自有 ModelScope 仓库后回填。
      // frcrn 已接 ModelScope 社区镜像 manyeyes/frcrn-se-16k-onnx（见下）。
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
      {
        id: 'denoise-frcrn',
        name: 'FRCRN_SE_16K 高质量降噪 ONNX',
        kind: 'file',
        remoteRel: 'models/denoise/frcrn_se16k.onnx',
        targetSub: 'models/denoise',
        targetName: 'frcrn_se16k.onnx',
        size: 57480770,
        sha256: '9a3582e61901724706301ed489a9fb73ac4cecb511ff40396bd48187fbb5c7f6',
        requiredBy: ['speech'],
        // 国内：社区 ONNX 导出镜像 manyeyes/frcrn-se-16k-onnx（仓库已核实，文件名高置信）。
        // ⚠️ 该路径尚未逐字节核对 sha256，若哈希不符下载器会自动走下一候选；届时以
        // 本地实算权重为准（sha256sum python/models/denoise/frcrn_se16k.onnx → 发布自有镜像后回填直链）。
        domesticUrl: 'https://modelscope.cn/api/v1/models/manyeyes/frcrn-se-16k-onnx/repo?Revision=master&FilePath=frcrn_se16k.onnx',
      },
      // ---- 副语言/非语音事件检测（PANNs Cnn14_DecisionLevelMax 帧级 SED）----
      // 权重 MIT 许可；本地已预置于 python/models/panns/，以下为打包分发用条目。
      // sha256/size 由本地文件实算（sha256sum python/models/panns/*）。
      // 权重缺失时 PANNs SED 自动 no-op 降级（不报错）。
      // ⚠️ 免费分发缺口：PANNs 官方原源为 Zenodo（国内不可达且哈希带 %3D 转义），
      // 无 ModelScope/HF 镜像 → 待发布自有 ModelScope 仓库后回填 domesticUrl。
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
      // ---- #1 强制对齐核心：Qwen3-ForcedAligner 本地权重（safetensors，非 ONNX）----
      // 以下 9 文件共同组成 qwen3_fa 模型目录；权重缺失时 #1 强制对齐走 whisper.cpp /
      // Paraformer 云端词级兜底（见 core.py 对齐护栏），不报错。
      // sha256/size 由本地 python/models/asr/qwen3_fa/* 实算。
      // 双源免费直链：国内 ModelScope Qwen 官方仓库 + 外网 HuggingFace（海外/代理用户），
      // 两源为同一发布物、sha256 一致，任何一源哈希不符即自动切换下一候选。
      // 基址常量见模块顶部 QWEN3FA_MS_BASE / QWEN3FA_HF_BASE。
      {
        id: 'qwen3fa-model',
        name: 'Qwen3-ForcedAligner 模型权重 (safetensors)',
        kind: 'file',
        remoteRel: 'models/asr/qwen3_fa/model.safetensors',
        targetSub: 'models/asr/qwen3_fa',
        targetName: 'model.safetensors',
        size: 1835544544,
        sha256: '47831d0e82f96b20e9034dba01a075ee06436654719f6a68289e49f1b65ce0e7',
        requiredBy: ['speech'],
        domesticUrl: QWEN3FA_MS_BASE + 'model.safetensors',
        externalUrl: QWEN3FA_HF_BASE + 'model.safetensors',
      },
      {
        id: 'qwen3fa-config',
        name: 'Qwen3-ForcedAligner config.json',
        kind: 'file',
        remoteRel: 'models/asr/qwen3_fa/config.json',
        targetSub: 'models/asr/qwen3_fa',
        targetName: 'config.json',
        size: 5982,
        sha256: 'd616c65d46c4b90bdc651b0a0963ea932732241140f337f9bb6b0335a9c8ef09',
        requiredBy: ['speech'],
        domesticUrl: QWEN3FA_MS_BASE + 'config.json',
        externalUrl: QWEN3FA_HF_BASE + 'config.json',
      },
      {
        id: 'qwen3fa-genconfig',
        name: 'Qwen3-ForcedAligner generation_config.json',
        kind: 'file',
        remoteRel: 'models/asr/qwen3_fa/generation_config.json',
        targetSub: 'models/asr/qwen3_fa',
        targetName: 'generation_config.json',
        size: 115,
        sha256: '948d089b23bca1d214e768d59c4438365665f52ec6d33678f4062206b3fbbb8c',
        requiredBy: ['speech'],
        domesticUrl: QWEN3FA_MS_BASE + 'generation_config.json',
        externalUrl: QWEN3FA_HF_BASE + 'generation_config.json',
      },
      {
        id: 'qwen3fa-tokenizer',
        name: 'Qwen3-ForcedAligner tokenizer_config.json',
        kind: 'file',
        remoteRel: 'models/asr/qwen3_fa/tokenizer_config.json',
        targetSub: 'models/asr/qwen3_fa',
        targetName: 'tokenizer_config.json',
        size: 12666,
        sha256: '3ab80063f8511deb9566e6ad438d17b7a6277fcffd52d92854112f19d36bd81c',
        requiredBy: ['speech'],
        domesticUrl: QWEN3FA_MS_BASE + 'tokenizer_config.json',
        externalUrl: QWEN3FA_HF_BASE + 'tokenizer_config.json',
      },
      {
        id: 'qwen3fa-vocab',
        name: 'Qwen3-ForcedAligner vocab.json',
        kind: 'file',
        remoteRel: 'models/asr/qwen3_fa/vocab.json',
        targetSub: 'models/asr/qwen3_fa',
        targetName: 'vocab.json',
        size: 2776833,
        sha256: 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910',
        requiredBy: ['speech'],
        domesticUrl: QWEN3FA_MS_BASE + 'vocab.json',
        externalUrl: QWEN3FA_HF_BASE + 'vocab.json',
      },
      {
        id: 'qwen3fa-merges',
        name: 'Qwen3-ForcedAligner merges.txt',
        kind: 'file',
        remoteRel: 'models/asr/qwen3_fa/merges.txt',
        targetSub: 'models/asr/qwen3_fa',
        targetName: 'merges.txt',
        size: 1671853,
        sha256: '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5',
        requiredBy: ['speech'],
        domesticUrl: QWEN3FA_MS_BASE + 'merges.txt',
        externalUrl: QWEN3FA_HF_BASE + 'merges.txt',
      },
      {
        id: 'qwen3fa-chattmpl',
        name: 'Qwen3-ForcedAligner chat_template.json',
        kind: 'file',
        remoteRel: 'models/asr/qwen3_fa/chat_template.json',
        targetSub: 'models/asr/qwen3_fa',
        targetName: 'chat_template.json',
        size: 1161,
        sha256: '75a8cfca24f00de72d796fbfed6858fc9614ef3dabd8696684cc3bc03a9c58ff',
        requiredBy: ['speech'],
        domesticUrl: QWEN3FA_MS_BASE + 'chat_template.json',
        externalUrl: QWEN3FA_HF_BASE + 'chat_template.json',
      },
      {
        id: 'qwen3fa-preproc',
        name: 'Qwen3-ForcedAligner preprocessor_config.json',
        kind: 'file',
        remoteRel: 'models/asr/qwen3_fa/preprocessor_config.json',
        targetSub: 'models/asr/qwen3_fa',
        targetName: 'preprocessor_config.json',
        size: 330,
        sha256: '45e120a4eda2c20c5d7f2ea9354e63536bf35e27aa573fb7cdf78017b378770d',
        requiredBy: ['speech'],
        domesticUrl: QWEN3FA_MS_BASE + 'preprocessor_config.json',
        externalUrl: QWEN3FA_HF_BASE + 'preprocessor_config.json',
      },
      {
        id: 'qwen3fa-readme',
        name: 'Qwen3-ForcedAligner README.md',
        kind: 'file',
        remoteRel: 'models/asr/qwen3_fa/README.md',
        targetSub: 'models/asr/qwen3_fa',
        targetName: 'README.md',
        size: 57456,
        sha256: '5058416891bc47a2051557765997e8c42f8eb78a0e33c3e775bd17d4b0ba4d50',
        requiredBy: ['speech'],
        domesticUrl: QWEN3FA_MS_BASE + 'README.md',
        externalUrl: QWEN3FA_HF_BASE + 'README.md',
      },
    ],
  };
}

// 计算某功能依赖的缺失资产 id 列表（用于惰性拦截判断）
export function missingForFeature(status: Record<string, boolean>, feature: 'keying' | 'sr'): string[] {
  const need = feature === 'keying' ? ['python', 'modnet', 'rmbg2'] : ['python', 'sr'];
  return need.filter((id) => !status[id]);
}
