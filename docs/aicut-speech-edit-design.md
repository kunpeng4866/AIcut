# AIcut 口播剪辑模块 · 详细设计方案

> 范围声明：本文档**仅针对口播剪辑（语音剪辑）模块**，不涉及视频渲染管线、字幕烧录等其他子系统。所有技术结论均来自对 AIcut 现有代码的实测（Explore 子代理）与对 GitHub/arXiv/模型卡的一手调研（4 路子代理并行），关键数字已标注来源，未查实之处明确标「待核实」。

---

## 0. 文档目的

回应用户的 9 点要求：
1. 兼顾成本、保证精度；2. 结果自然流畅；3. 尽量减少人工干预；
4. 借鉴 `videocut-skills` 架构/功能（有选择地吸收）；5. 从用户视角区分「必须去掉」与「勉强可接受」；
6. 详细给出架构/流水线/开源项目/模型选型，并说明**选用理由与剔除理由**及可实现效果精度；
7. 口播剪辑与视频的两种关联模式（Ⅰ仅音频、Ⅱ音视频强关联）；8. 补充用户未想到但必要的问题；9. 仅限口播模块。

---

## 1. 现状诊断（基于代码实测，非进度文档）

### 1.1 现有流水线（调用链）

`SpeechPanel.handleAnalyze` → `window.aicut.speech.analyze` → IPC → `speech_analyze(Rust speech.rs:150)` → spawn `python/speech_edit/bridge.py` → `core.analyze`（决策核心 `python/speech_edit/core.py:977-1293`）：

1. ffmpeg 抽 16k 单声道；
2. 可选 Demucs（默认关）；
3. **faster-whisper `transcribe`（core.py:158）** 做词级转写；
4. Silero VAD（`vad_speech_regions`, :193）；
5. 多层声学检测：4a 文本填充词 / 4b 孤立段 / 4c 间隙气声 / 4d 瞬态 / 4e 咳嗽 / 4f 纯音 / 段内精修；
6. `keepNonspeech` 决定保留策略；
7. 首尾静音裁剪 → 输出 `keepSegments`。

前端用 `keepSegments` 补集显示「待删段」，用户微调/预览，再 `speech_assemble` 用 ffmpeg 切段 concat 出片。`assemble` 期还有 declick/deess/normalize/crossfade。

### 1.2 精度不达标的根因（已定位文件:行号）

| # | 根因 | 位置 | 后果 |
|---|---|---|---|
| 1 | 口播只用本地 **Whisper base（CPU int8）**，时间戳是启发式、非强制对齐 | core.py:158-185；SpeechPanel.tsx:131 `modelSize='base'` | 词边界偏差 **100–300ms**，是「切不准」首要原因 |
| 2 | 填充词靠 **Whisper 文本精确匹配**（FILLERS 固定词表 + word_pad 0.04s） | core.py:292-304 | 「嗯」误识别为「恩/呃」即漏抓；词边界偏移→误删真实语音 |
| 3 | 咳嗽/纯音安全阀**过度保守**——与词区间重叠即整段不删 | core.py:531-540 / 591-597 | 句中咳嗽/提示音**永不删除** → 用户感知「完全没反应」 |
| 4 | 长间隙音乐门直接 `continue` 跳过 | core.py:377-381 | 带 BGM 的静默段里气声/咳嗽整段漏检 |
| 5 | ASR 失败 `words=[]` 后**静默降级**，下游全 `if not words: return []` 早退 | core.py:183-185 等 | 局部「完全没反应」，且无任何错误提示 |
| 6 | `keepNonspeech` 默认 `true` | core.py:1174-1190 | 只删语音内填充，**句间死静不删** → 用户需手动补删 |
| 7 | 默认参数粗糙（VAD 0.25、minGap 0.18、head_tail 0.008；轻声漏检） | core.py:198/1018/941 | 轻声「嗯/啊」低于噪声门限被漏检 |

### 1.3 能力矩阵

- **已具备**：词级转写（Whisper 粗）、Silero VAD、文本填充词、孤立段/间隙气声/瞬态/咳嗽/纯音检测、首尾裁剪、Demucs 分离（可选）、assemble 期 declick/deess/normalize/xfade、人工微调/撤销 UI。
- **完全缺失**：① 真正降噪（`denoise` 在 core.py:1044 是**空实现**）；② 词级强制对齐（whisperX/Paraformer 时间未接入）；③ 副语言**语义级**检测（笑声/叹气/重复句）；④ 复用百炼 Paraformer 高精度时间戳；⑤ GPU 推理（口播 Whisper 跑 CPU int8，无 ONNX CUDA EP）。

> **诊断结论**：现有模块的骨架（VAD + 多层检测 + 人工审核账本 + ffmpeg 执行）是对的，问题集中在**时间戳精度低、降噪空转、检测器保守、失败静默、默认值偏离用户预期**。下面方案在保留骨架基础上，替换/补强这 5 处。

---

## 2. 设计目标与原则

- **成本**：桌面端本地优先，主链路全跑 ONNX Runtime **CUDA EP**（复用 AIcut 已有推理栈），运行成本≈0；仅把百炼 Paraformer API 作为「可选高质量识别」开关，不默认开启。
- **精度**：以「**时间戳准到能切**」为第一指标 → 词/字级强制对齐（±0.02s）；VAD ROC-AUC ≥0.96；降噪 DNSMOS BAK≥4.4；副语言事件帧级 SED 给出时间戳。
- **自然流畅**：删除「**压缩停顿而非硬删**」优先；剪切点做 crossfade/declick；**不做重合成**（避免 AI 味、保真人声）；必要时才用生成式补音节。
- **少人工**：默认预设 + 可审核标记（human-in-the-loop）+ 一键应用 + 阈值滑杆 + **记忆用户偏好**（借鉴 videocut-skills 自更新）。
- **可解释 / 可撤销**：所有删除都是「时间轴上的可视化标记」，用户可拖边界、可撤销、可逐条确认。

---

## 3. 整体架构（借鉴 videocut-skills，本地化改造）

`videocut-skills` 架构三层：**Skill 编排层 + Runtime/FFmpeg 执行层 + 人工审核账本**。其流水线：提取音频 → 转录（云 API）→ LLM 语义审核标记静音/口误/重复/语气词 → 生成可点击跳转审核网页 → 用户确认 → FFmpeg 物理剪切 → 二次校验循环。

**采纳**：三层分工、审核账本、human-in-the-loop、偏好记忆。
**改造**：把「云转录」替换为「本地高精度 ASR + 强制对齐流水线」；把「单一 LLM 审核」扩展为「规则引擎 + 可选 LLM 语义层」；把「网页审核」替换为 AIcut 原生时间轴标记 UI。

```
┌───────────────────────────────────────────────────────────┐
│  Layer 1  编排层 (SpeechPanel + bridge)                      │
│  - 参数预设 / 阈值滑杆 / 偏好记忆(自更新)                     │
│  - 触发 analyze / assemble / separate                       │
└───────────────────────────┬───────────────────────────────┘
                            ▼
┌───────────────────────────────────────────────────────────┐
│  Layer 2  决策/推理流水线 (python/speech_edit, 全本地 ONNX)   │
│  ① 音频预处理(ffmpeg 16k/48k)                              │
│  ② ASR + 强制对齐  → 词/字级时间戳 (Paraformer / Qwen3-FA)  │
│  ③ 多层检测器:                                               │
│     VAD静音 | 填充词/口误 | 重复/自我纠正 | 咳嗽/喷麦/呼吸/叹气 │
│     语速异常/节奏失调 | 残句(可选LLM)                        │
│  ④ 决策引擎: 规则 + 可选LLM语义 → 事件标记 (带置信度/类型)    │
│  ⑤ 降噪/修复 (DeepFilterNet3 / FRCRN 离线档)  ← 此前为空实现 │
└───────────────────────────┬───────────────────────────────┘
                            ▼
┌───────────────────────────────────────────────────────────┐
│  Layer 3  执行层 + 审核账本                                  │
│  - 时间轴可视化标记 (可拖边界/撤销/逐条确认)                 │
│  - 模式Ⅰ: 仅音频剪切/频谱抹除 → 新音频                       │
│  - 模式Ⅱ: 音视频强关联 → 同步剪对应视频片段                  │
│  - ffmpeg: 切段 concat + crossfade/declick + 降噪后处理      │
│  - 二次校验循环 (预览对比)                                   │
└───────────────────────────────────────────────────────────┘
```

### 3.1 部署形态：内置公共模块 vs 外部插件

问题：口播剪辑应以「插件」引入 AIcut，还是作为「内置公共模块」？

| 维度 | 外部插件（独立进程 / 动态加载） | 内置公共模块（**本方案采用**） |
|---|---|---|
| 与时间轴 / 导出管线耦合 | 需跨进程传递 clip / `src_range` / 切割点，边界摩擦大 | 直接消费 timeline 数据结构与 `ExportPipeline`，零摩擦 |
| 与视频关联（模式Ⅱ） | 插件难安全触达视频轨剪切分支（`speech.rs`） | 同进程直接调用 Rust 侧 video-cut 分支 |
| 复用 ASR / 降噪 / ONNX 栈 | 需重复打包或跨进程 RPC | 直接复用 `python/asr`、`CUDA EP`、`assets-manifest` |
| 产品形态匹配 | AIcut 是桌面剪辑软件，**无插件运行时基础设施**（不像 WorkBuddy 有 skill/connector 体系） | 天然契合「功能即内置」的桌面软件范式 |
| 体积 / 按需 | 插件可独立分发 | 用「**模型权重按需下载**」（已有 `assets-manifest` + `ensureAssets`）控制体积 |

**结论：作为 AIcut 的内置公共模块更合理。** 但为取得插件化想要的「隔离 / 可选 / 省体积」好处，本方案采用 **内部分层 + 功能开关 + 权重按需下载** 的组合：
- 内部分层（detector / aligner / rule-engine / executor）保证模块可独立测试与演进；
- 高级档（FRCRN 离线精修、SIDON 抢救、Step-Audio 补音节）以「功能开关 + 权重惰性下载」呈现，不开不下载；
- 降噪 / ASR 等能力本就是公共层，口播模块与字幕、音频清洁等功能共享，避免重复实现。

体积控制点应放在**模型权重**上，而非**功能代码**上——这既避免插件化的边界成本，又通过「按需下载权重」控制分发体积。

---

## 4. 处理流水线（详细步骤）

| 步 | 动作 | 模型/工具 | 输出 |
|---|---|---|---|
| 1 | 抽音轨（16k 给检测 / 48k 给降噪导出） | ffmpeg | 双采样率副本 |
| 2 | 语音识别（主 / 增强） | **本地 FunASR Paraformer**（字级时间戳，省月租默认）；**百炼 Paraformer API**（项目已在用、~¥0.04/分钟、按量可控）作为高质量 / 离线不可用时的增强与兜底 | 文本 + 字级时间戳 |
| 3 | 强制对齐（切准核心） | **Qwen3-ForcedAligner**（±0.02s，离线） | 字级精确起止 |
| 4 | 停顿检测地基 | **Silero VAD v6**（ONNX） | 语音/静音段 |
| 5 | 填充词/口误 | FunASR CT-Transformer 去口误 + 扩展词表（含恩/呃/那个/就是…） | 待删标记 |
| 6 | 重复/自我纠正/残句 | 改进 CTC 对齐 + gap 分类（arXiv:2409.10177）；残句 / 思路断裂由**可选 LLM 语义层**（复用项目既有 DeepSeek API）做「是否完整句」判定 | 重复段 / 残句标记 |
| 7 | 副语言事件 | **PANNs 帧级 SED**（咳嗽/叹气/清喉）+ **Respiro-en**（呼吸）+ DSP 瞬态（喷麦/口水音） | 事件时间戳 |
| 8 | 语速/节奏 | 词级时间戳滑窗 + MAD 阈值 | 异常段标记 |
| 9 | 降噪/修复 | **DeepFilterNet3**（实时默认）/ **FRCRN**（离线高质量档） | 干净音轨 |
| 10 | 决策引擎 | 规则（见 §7）+ 可选 LLM 语义层（复用 DeepSeek API 做残句判定） | 最终事件清单（类型/起止/置信/建议动作） |
| 11 | 呈现 | 时间轴可视化标记（带类型色标、可拖边、可撤销） | 用户审核 |
| 12 | 执行 | ffmpeg 切段 concat + crossfade/declick；模式Ⅱ同步剪视频 | 成品 |

---

## 5. 模型与开源项目选型（核心）

### 5.1 ASR 与强制对齐

| 候选 | 结论 | 理由（选用/剔除） | 效果精度 |
|---|---|---|---|
| **FunASR Paraformer（本地）** | ✅ 主用识别 | 字级时间戳（转置卷积+LSTM 原生输出，无需外部对齐）；220M、CPU 可跑（SenseVoice 17× 实时）；**中文最优之一**：AISHELL-1 CER **1.95%**、184 条长音频 **10.18%**（远优 Whisper 20.02%）；内置 CT-Transformer 去口误/语气词。与 AIcut 已用 Paraformer 同族，平滑迁移 | 字级时间戳 |
| **Qwen3-ForcedAligner（本地）** | ✅ 切割对齐层 | 0.6B、±**0.02s** 精度、CTC 强制对齐、离线数据不出域；「先识别再对齐」分离架构无误差累积；FP16 显存~1.7GB，5s 推理~1.8s，并发~2000×。是「删除语气词/停顿能精准下刀」的关键 | ±0.02s |
| **Paraformer 百炼 API** | ✅ 合法增强 / 兜底（项目已在用） | AIcut 已集成、零本地算力、成本极低（~¥0.04/分钟、按量可控）、即开即用；数据出域但属用户既有合规通道；时间戳非字级强制对齐，故**不单独承担切割**，而是与本地 FunASR / Qwen3-FA 互补（百炼出文本、本地对齐出切割点）。**可默认开启**作为识别增强与离线兜底，不额外增加用户成本 | 句+词级 |
| WhisperX | ❌ 中文主线剔除 | 词级（音素对齐）英文极佳，但**中文依赖语言特定音素模型、对齐弱于英文**（论文明确）；非中文口播首选 | 词级(英文强) |
| whisper.cpp | ✅ 保留兜底 | 本地 C++、断网可用；但中文 CER~20%、无词级原生。仅作无网/弱网兜底，**不做精确切割** | 段级 |
| Whisper large-v3 | ❌ 剔除（口播主线） | 中文 CER~20%，时间戳句/段级、偏差数秒，不能切 | — |

**结论**：主识别 **FunASR 本地字级**（省月租默认）+ 精确对齐 **Qwen3-FA**；**百炼 Paraformer API 作为项目既有的便宜增强 / 兜底（可默认开，按量 ~¥0.04/分钟）**，与本地对齐互补；whisper.cpp 断网兜底。彻底替换现有 core.py:158 的 `faster_whisper(base)` 启发式时间戳。

### 5.2 降噪 / 修复

| 候选 | 结论 | 理由 | 效果精度 |
|---|---|---|---|
| **DeepFilterNet3** | ✅ 默认降噪 | **MIT/Apache-2.0 双许可**；仓库**自带 ONNX 权重**直挂 CUDA EP（与 AIcut 栈零摩擦）；CPU 实时 RTF 0.04（DFN2）/0.19（DFN3）；DNSMOS **SIG 4.19 / BAK 4.47 / OVL 3.90**，背景抹得干净且人声不糊；有 `_ll` 低延迟版可做实时预览 | PESQ 3.03 / STOI 0.941 |
| **FRCRN / MossFormer2_SE_48K** | ✅ 高质量离线档 | Apache-2.0；PESQ 3.23（FRCRN）/3.16（MossFormer2 48k）、SI-SDR 19.38，指标更高；但 MACS 12.3G、需 GPU、非因果（不适合实时预览）。作「导出前离线精修」开关 | PESQ 3.23–3.57 |
| RNNoise | ❌ 主力剔除（仅兜底） | BSD、纯 C、RTF 0.027 极轻；但 PESQ 2.33、DNSMOS OVL 3.378，保真不足、高频损伤可闻、对非稳态噪声无效。在有 CUDA EP 的桌面端不构成理由，仅作极速预览兜底 | PESQ 2.33 |
| SIDON | ⚠️ 抢救级可选 | 代码 MIT、对标 Miipher、质量强；但**重合成会改音色**（口播对「还是我的声音」极敏感，易判 AI 味），且权重链（w2v-BERT 2.0）许可需法务核实。仅作「录音底子极差」的可选开关，**非默认** | 对标 Miipher |
| Audio-Omni | ❌ 商用否决 | **CC-BY-NC-4.0**，权重仅研究、商用须书面授权；ckpt ~21GB，扩散重生成不对齐时间轴 | — |
| Ming-UniAudio | ❌ 暂不建议 | 16B、理解与修复最强，但权重限商用、推理代价高，适合批次高精度编辑而非实时桌面 | 12项8项SOTA |

**结论**：默认 **DeepFilterNet3（ONNX EP）** 替换 core.py:1044 空实现；「高质量」档用 **FRCRN/MossFormer2** 离线精修；SIDON 谨慎作抢救开关。

### 5.3 副语言事件（咳嗽 / 喷麦 / 口水音 / 呼吸 / 叹气）—— 删除靠「检测+时间轴剪切/频谱抹除」

| 候选 | 结论 | 理由 | 效果 |
|---|---|---|---|
| **PANNs（Cnn14 / DecisionLevelMax）** | ✅ 主检测 | **MIT**；AudioSet 527 类原生含 Cough/Sneeze/Breathing/Throat-clearing/Sigh；**DecisionLevelMax 是帧级 SED（mAP 0.385）直接给时间戳**；`panns_inference` 一行调用；CPU 可跑、有社区 ONNX | mAP 0.431/0.439，帧级 SED 0.385 |
| **Respiro-en + breath-removal** | ✅ 呼吸专项 | MIT；帧级呼吸检测 + 开箱 CLI（按百分比衰减/全静音 + 可视化） | 帧级呼吸 |
| **DSP 瞬态检测（喷麦/口水音）** | ✅ 自实现 | 无高星专用开源；工业界（iZotope RX）走「检测+频谱插值修补」。喷麦= <150Hz 瞬时能量暴涨；口水音= 3–8kHz 无辅音能量 + 80–400Hz 无基频。纯 DSP、成本最低、完全可控（参考 Audacity DeBreather 思路，**仅借算法不链接 GPL**） | — |
| Step-Audio-EditX | ⚠️ 仅补音节兜底 | 代码 Apache-2.0、3B、12GB 显存；但其副语言标签是「**插入**呼吸/叹气/语气词」方向（加不是减），且重合成、推荐音频≤30s。**不用于删咳嗽**，仅当咳嗽压在字上需补回音节时兜底 | — |
| Audio-Omni | ❌ 否决 | 同上 CC-BY-NC + 21GB | — |

**结论**：删除类一律走「**检测器给时间戳 → 时间轴标记 → 剪切/频谱抹除**」。三条硬理由：① 与时间轴严格对齐，可撤销可微调；② 不重合成，音色 100% 保真、无 AI 味；③ 成本差两个数量级（PANNs ~80M vs Audio-Omni 21GB）。生成式模型只作「补音节」兜底，且优先 Step-Audio-EditX（Apache）而非 Audio-Omni（NC）。

### 5.4 VAD 与停顿处理

| 候选 | 结论 | 理由 | 效果 |
|---|---|---|---|
| **Silero VAD v5/v6** | ✅ 首选 | **MIT、无遥测**；~2MB、30ms chunk <1ms/CPU 线程、ONNX 再快 4–5×；**ROC-AUC 0.96/0.97**（多域）；原生 `get_speech_timestamps` + 四参数（threshold / min_speech_duration_ms / min_silence_duration_ms / speech_pad_ms）正好对应剪辑语义 | ESC-50 噪声抗误报 0.61/0.87 |
| WebRTC VAD | ❌ 主方案剔除 | ROC-AUC 仅 0.73；**ESC-50 纯噪声准确率 0.00**（几乎全判成语音），口播场景直接废 | 0.73 |

**关键认知**：VAD **无法区分「思考停顿」与「无意义空白」**，只能输出语音概率。必须在上层分级（规则引擎）：
- 落在句末标点后 & 300–800ms → **保留**（呼吸节奏）；
- 句内、前后无标点、>400ms → 候选删除；
- 静音段前紧邻填充词（呃/那个）或段内检出重复词 → 强候选删除；
- 优先「**压缩停顿时长**」（1.2s→0.35s）而非硬删，避免剪出机关枪节奏。

### 5.5 口吃 / 重复 / 语速

- **口吃/重复/自我纠正（硬性结论：必须语音级 CTC 强制对齐兜底，不能靠文本匹配）**：arXiv:2409.10177 实证——**Whisper 只转写出 56% 的词级不流畅**，近一半口吃/重复/自纠不进文本；**纯文本删不流畅必然系统性漏检**。因此无论底层选 **FunASR Paraformer**（其 `asr/bridge.py:224,270` 已消费词级时间、属 CTC 家族）还是 WhisperX，**都必须叠加 modified CTC 强制对齐 + 独立 gap 分类器**；现有本地 **base Whisper（口播默认）应弃用**。Qwen3-ForcedAligner 的细粒度边界列为**待验证项**（验证其 ±0.02s 是否覆盖不流畅 gap）。方案：ASR 文本 + Wav2Vec2 帧级概率 → 改进 CTC 强制对齐（space token 加负 log 常数）→ gap 分类器。指标：改进 CTC 覆盖 **81.69%** 未转写词（标准 CTC 46.10%、Whisper cross-attn 仅 12.02%），gap 分类 acc **81.62%** / F1 **80.07%**。inference-only，可挂任意 ASR。
- **模块接口契约（新建，非改造）**：核对 `core.analyze` 返回（`python/speech_edit/core.py:1277-1293`）当前仅含 `words:[{word,start,end}]` + `keep_segments`，**无 `flag_disfluency`、无 `gap_type`**（把 4a–4e 事件直接并入 keepSegments 补集、**丢失逐项类型**），新 JSONL 正是补这层 typing。以下为**与代码核对后的定稿绑定规格**，字段名已双向对齐、后续增删需同步：
  - **最终 Schema（七字段，一字不改）**：`{"start":f,"end":f,"word":"","flag_disfluency":bool,"gap_type":"...","conf":f,"src":"asr|acoustic|rule"}`。`word` 仅词对齐事件非空，纯声学事件（cough/tonal/mouth_click…）`word=""`；`conf` 置信度便于阈值调试；`src` 来源标记（asr=对齐文本 / acoustic=4a–4e 声学 / rule=上层规则引擎）。
  - **坐标基准（硬约束）**：`start/end` 一律为**源媒体绝对秒（src_range 基准、1×、无 speed/reverse/freeze/time_remap）**。`src/pipeline/strategy.rs` 中 `timeline_to_source_time`(:209) → `clip_source_time`(:244/252) 映射已覆盖 speed/reverse/freeze/曲线 remap（:224-297）；Rust 落时间线必须经此**反解**，**不能把源秒当 timeline 秒**（captureSourceTime 偏移坑）。`analyze` 入参优先收 `src_range` 窗口导出的 wav（`src_in=0` 零偏移）；若收整段原始媒体则所有时间统一 +`src_in` 偏移，否则整体漂移。
  - **gap_type 枚举（与 core.py 实函数对齐，新增 modified CTC 产 filler_repeat/stutter/pause_think/pause_meaningless）**：删除型 = filler_verbal(`detect_fillers:292`)、filler_isolated(`detect_isolated_fillers:317`)、filler_repeat/stutter(新增 CTC gap)、cough(`detect_cough:519`)、mouth_click/transient_mic(`detect_transients:419`)、tonal_sfx(`detect_tonal_sfx:581`)；保留/压缩型 = breath(`detect_gap_breath:349`，默认保留/轻压)、pause_think、pause_meaningless、silence_normal、music_bridge(separated 时对应 musicSegments)。**约定 4c 只出 breath、咳嗽统一由 4e 捕获**避免重复计数。枚举与 §7 用户视角一一对应（删除型=必须去掉，保留/压缩型=勉强可接受）。
  - **#8 硬结论（重申）**：必须引入 modified CTC 强制对齐 + 独立 gap 分类器（arXiv:2409.10177）；**弃用本地 base Whisper**，改接 Paraformer 词级时间——**优先复用 `asr/bridge.py:224,270` 既有通道**（本地 FunASR 或百炼 API 皆可，时间戳须补 `src_in` 偏移）；删除执行仍走现有 `keepSegments → speech_assemble`，与 JSONL typing 互不冲突。
- **语速异常/节奏失调**（工程推导，零模型成本）：拿到词级时间戳后滑窗（3s/1s 步长）算中文「字/秒」，与全片中位数比，用 MAD 定阈值标异常；正常口播约 4–5 字/秒。节奏=词间隔分布方差骤升即判乱。
- **残句/思路断裂**：纯声学不可靠，需 LLM 读转写文本做语义判定（「是否为完整句」），属可选 LLM 语义层。

---

## 6. 口播剪辑与视频的两种关联模式

### 模式 Ⅰ：仅剪辑音频，不与视频关联
- 适用：用户只想清洁音轨（如先粗剪音频、后用清洁版重新配音/对齐），或素材是纯录音。
- 实现：流水线只产出「新音频文件」；时间轴标记仅在音频轨道上呈现；不触碰视频轨。
- 注意：音频时长可能变短（删停顿），若后续要回贴视频需做**速度/对齐处理**（见模式Ⅱ的同步机制可复用）。

### 模式 Ⅱ：音频与视频强关联，同时剪对应视频片段
- 适用：口播即录屏/对口型视频，删掉「嗯、咳嗽、死静」时画面也要同步剪去，否则嘴型/画面错位。
- 实现：
  1. 音频分析得到事件清单（起止时间、类型）；
  2. 将音频事件**镜像到视频轨**相同的绝对时间轴；
  3. 执行时按事件边界对**视频轨做对应剪切/速度保持的片段移除**；
  4. 由于删音频会缩短总时长，视频轨用**相同切割点 + 片段删移**保持音画同步（不靠变速，避免画面加速观感）；
  5. 剪切点两侧视频做 crossfade（短，如 80ms）避免跳变；
  6. 边界处若画面有突变（如切掉一整句），在时间轴明确标「此处画面已随音频移除」供用户复核。
- 复用：模式Ⅱ的「音频切割点→视频切割点映射」逻辑与 AIcut 现有 `is_simple_project()` / `ExportPipeline` 的 clip 切割能力一致，应在 Rust 侧 `speech.rs` 增加「视频同步剪切」分支，而非在 Python 端另起炉灶。

> **默认值建议**：AIcut 是视频剪辑软件，默认走**模式Ⅱ**（口播通常是带画面的）；提供「仅音频」开关给纯录音场景。

---

## 7. 用户视角：必须去掉的 vs 勉强可接受的

### 必须去掉（默认开启，用户几乎零容忍）
- 长段死静 / 句间无意义空白（>800ms 且非呼吸节奏位）；
- 明显咳嗽、清喉、喷麦爆音、口水音；
- 重复词/自我纠正（「那个…那个…」「就是说就是…」）；
- 空调/电流/键盘等稳态环境底噪（降噪）；
- 明显的口误/填半句（结合 ASR+规则）。

### 勉强可接受（默认保留，提供「压缩/可选删」）
- 短促思考停顿（300–800ms，保留呼吸节奏，可压缩不删）；
- 轻微语气词「嗯/啊」作为自然过渡（videocut-skills 经验：保留少量嗯作过渡更自然）；
- 话尾拖长音、轻微气息声（不刺耳即留）；
- 转场处的环境音（如翻页声，非刺耳保留）。

### 用户控制面（少人工的关键）
- 全局预设：轻量 / 标准 / 激进；
- 阈值滑杆：停顿删除阈值、语气词敏感度、降噪强度；
- 逐条审核：每条标记可「保留/删除/改边界」；
- **偏好记忆**：记住用户上次选择（借鉴 videocut-skills 自更新）。

---

## 8. 补充：用户未提到但必要的问题

1. **降噪空实现修复**：core.py:1044 必须落地为 DeepFilterNet3 ONNX，否则「降噪」选项是欺骗。
2. **失败不静默**：ASR 失败 `words=[]` 时显式回退 VAD-only 并提示前端，避免「完全没反应」。
3. **GPU 推理**：口播 Whisper 跑 CPU int8 无 ONNX EP，应统一迁到 CUDA EP（兼顾速度精度）。
4. **预览无损/低延迟**：审核阶段用低延迟 `_ll` 模型或代理预览，确认后再走高质量离线档。
5. **边界安全**：剪切点两侧做 declick/crossfade，避免爆音/咔哒（assemble 期已有，需保留并参数化）。
6. **音画同步校验**：模式Ⅱ下执行后做「音频时长 vs 视频时长」一致性断言，异常则告警。
7. **可追溯/撤销**：所有操作入审核账本，支持整体撤销与逐项回滚。
8. **批处理**：多段口播批量分析（复用同一预设），减少重复操作。
9. **能量曲线可视化**：时间轴叠加能量/RMS 曲线，用户肉眼即可定位异常段。
10. **许可合规**：所有默认集成模型须商用友好（MIT/Apache）；权重商用受限的（FunASR/Qwen3-FA/SIDON/Step-Audio 权重、Ming-UniAudio）**代码可引、权重商用需法务核实**，应在文档标注并在 UI 提示。
11. **数据隐私**：本地优先确保录音不出域（尤其口播内容敏感），云端 API 仅作可选开关且明示。
12. **性能预算**：单段 10 分钟口播，本地全链路（ASR+对齐+检测+降噪）目标 < 2 分钟（GPU），不卡 UI（后台 worker）。

---

## 9. 与现有代码的对齐（改造点清单）

| 现有问题 | 改造点 | 位置 |
|---|---|---|
| Whisper base 粗时间戳 | 替换为 FunASR 本地字级 + Qwen3-FA 强制对齐 | core.py:158 `transcribe` |
| 填充词文本精确匹配漏抓 | 扩展词表 + FunASR CT-Transformer 去口误 + 词边界用对齐时间 | core.py:292-304 `detect_fillers` |
| 咳嗽/纯音安全阀过度保守 | 改为「仅保护紧邻静音边且嵌连续元音」的事件，而非整段丢弃词重叠 | core.py:531-540 / 591-597 |
| 长间隙音乐门跳过 | 去掉 `continue`，改为带 BGM 静默段仍检测 | core.py:377-381 |
| ASR 失败静默降级 | `words=[]` 时 VAD-only 回退 + 前端提示 | core.py:183-185 |
| keepNonspeech 默认 true | 调整默认值或增加「去死静」预设 | core.py:1174-1190 |
| 降噪空实现 | 接入 DeepFilterNet3 ONNX（CUDA EP） | core.py:1044-1045 |
| 无 GPU 推理 | 推理统一迁 ONNX Runtime CUDA EP | speech_edit 全模块 |
| 无副语言检测 | 加 PANNs/Respiro-en/DSP 瞬态检测层 | 新增 detector 模块 |
| 无语音级不流畅检测 | 新建 modified CTC 强制对齐 + 独立 gap 分类器，产出新 JSONL 契约 `{start,end,word,flag_disfluency,gap_type}`（core.py:1277-1293 当前缺失该字段） | 新增 detector 模块 |
| 无重复/语速检测 | 加改进 CTC + gap 分类 + 词级统计 | 新增 detector 模块 |
| 视频强关联缺 | Rust 侧 `speech.rs` 加视频同步剪切分支（模式Ⅱ） | speech.rs |

---

## 10. 实施分期建议

- **P0（精度止血）**：接入 FunASR 字级 + Qwen3-FA 对齐替换 Whisper 时间戳；放宽咳嗽/纯音安全阀；修复 ASR 失败静默；落地 DeepFilterNet3 降噪（替换空实现）。→ 直接解决用户「切不准/没反应/没降噪」。
- **P1（能力补全）**：PANNs/Respiro-en/DSP 副语言检测；改进 CTC 口吃/重复定位；语速统计；暂停压缩优先策略；偏好记忆。
- **P2（关联与体验）**：模式Ⅱ视频同步剪切；能量曲线可视化；批处理；UI 阈值滑杆 + 预设；审核账本增强。
- **P3（高质量档）**：FRCRN/MossFormer2 离线精修开关；可选 LLM 残句语义判定；SIDON 抢救开关（法务核实后）。

---

## 11. 风险与验证

- **许可风险**：默认链路（DeepFilterNet3 / Silero / PANNs / Respiro-en / FRCRN）均 MIT/Apache，商用安全；**权重商用受限模型**（FunASR/Qwen3-FA/SIDON/Step-Audio 权重/Ming-UniAudio）须法务核实后再默认启用。
- **精度验证**：用带标注的口播样本（含咳嗽/嗯/重复/死静）跑全链路，核对删除边界误差 ≤ 0.05s；人工抽检自然度（无 AI 味、无机关枪节奏）。
- **验收指标新增（与 WER 并列，不得只看 WER）**：不流畅片段覆盖率/召回 **≥81%**、gap 分类 **F1 ≥80%**（依据 arXiv:2409.10177 改进 CTC+gap 分类实测）。
- **副语言删除验收**：精确率 **≥95%** / 召回 **≥90%** / 误删率 **<1%**；并以 `745230d`「无噪音」基线为**回归红线**（任何改动不得劣化该基线）。
- **上层规则引擎（删/留/压缩判定）**：用「VAD 静音 × ASR 词边界/标点 × gap_type × 邻近填充词」综合判定；明确回答「思考停顿(保留) vs 无意义空白(压缩优先)」，并定「**优先压缩而非删除**」原则（避免剪出机关枪节奏）。
- **回归验证**：现有 `speech_assemble` 的 declick/deess/normalize/crossfade 在改造后仍需保留并参数化，避免引入爆音。
- **性能验证**：10 分钟口播本地全链路 < 2 分钟（GPU），UI 不卡。

---

### 附：默认技术栈一览（商用友好、本地优先）

| 环节 | 选用 | 许可 | 精度指标 |
|---|---|---|---|
| 识别 | FunASR Paraformer（本地） | 待核实(达摩院) | CER 1.95%(AISHELL)/10.18% |
| 对齐 | Qwen3-ForcedAligner | 待核实(阿里) | ±0.02s |
| 降噪(默认) | DeepFilterNet3 (ONNX) | MIT/Apache | DNSMOS 4.19/4.47/3.90 |
| 降噪(高质量) | FRCRN / MossFormer2 | Apache-2.0 | PESQ 3.23–3.57 |
| VAD | Silero v6 (ONNX) | MIT | ROC-AUC 0.97 |
| 副语言检测 | PANNs + Respiro-en + DSP | MIT | 帧级 SED mAP 0.385 |
| 口吃/重复 | 改进 CTC + gap 分类 | 论文(待核) | 覆盖 81.69% 未转写词 |
| 兜底识别 | whisper.cpp | MIT | 段级 |
| 增强/兜底识别 | 百炼 Paraformer API（项目已在用） | 商用 SAAS 按量 | 句+词级，~¥0.04/分钟，可默认开 |
| 残句语义判定 | DeepSeek API（项目已在用） | 商用 SAAS 按量 | 可选 LLM 层 |
