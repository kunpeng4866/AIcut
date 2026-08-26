# AIcut 口播剪辑模块 · 开发设计与实现状态

> 范围声明：本文档**仅针对口播剪辑（语音剪辑）模块**，不涉及视频渲染管线、字幕烧录等其他子系统。
> 本文档为**「现状 + 设计」双轨文档**：§1–§4 记录**代码实测的当前实现**（以 commit 为准，非进度臆测），§5 起为选型研究与分期路线。所有代码位置均来自本机实测。

---

## 0. 文档目的

回应用户的 9 点要求：① 兼顾成本保证精度；② 结果自然流畅；③ 少人工干预；④ 借鉴 `videocut-skills` 架构；⑤ 区分「必须去掉」与「勉强可接受」；⑥ 给出架构/流水线/选型与**选用/剔除理由**；⑦ 口播与视频两种关联模式；⑧ 补充必要但用户未想到的问题；⑨ 仅限口播模块。

> ⚠️ 本文档是「已落地事实 + 设计路线」的混合体。**已落地**部分标 ✅ 并附 commit / 行号；**规划未落地**部分标 ⏳ 并明确列入 §12 剩余项。请勿把 ⏳ 项当作已实现。

---

## 1. 当前实现状态总览（实测，非进度文档）

| 阶段 | 状态 | Commit | 关键落地内容 |
|---|---|---|---|
| P0 精度止血 | ✅ 已落地 | `ea05d79` | CUDA 转写 + 百炼 Paraformer 词级融合；真实降噪接入；安全阀放宽；ASR 失败 VAD 兜底；§5.5 JSONL 契约 |
| P1 能力补全 | ✅ 已落地 | `733125a` | 暂停压缩优先（keepSegmentsOut / outputDuration，纯逻辑）；语速统计；单元测试 |
| P1→音频落地 | ✅ 已落地 | 本回合 | Rust `speech_assemble` 消费 `keepSegmentsOut`，把暂停压缩真正落到音频（段间插「冻结末帧+静音」短暂停） |
| P2 关联与体验 | ⏳ 规划 | — | 模式Ⅱ视频同步剪切；能量曲线；批处理；UI 阈值滑杆；偏好记忆 |
| P3 高质量档 | ⏳ 规划 | — | FRCRN/MossFormer2 离线精修；可选 LLM 残句判定；SIDON 抢救（法务核实后） |

### 1.1 与最初设计的偏差（诚实记录）

最初设计 §5.1 结论是「主识别用 **FunASR 本地字级** + **Qwen3-FA** 强制对齐」。**实际 P0 落地采用的是务实替代方案**：

- 本地识别用 **whisper `small`（CUDA EP）**，时间精度显著优于旧 base；
- 词级时间戳用 **百炼 Paraformer（DashScope，项目已在用、按量 ~¥0.04/分钟）** 融合（见 `paraformer_words` / `_fuse_cloud_word_times`）；
- **FunASR 本地字级 + Qwen3-FA 强制对齐尚未接入**（列为剩余项）。

原因：百炼 Paraformer 已是项目既有且便宜的通道，可在 P0 阶段立即拿到词级时间，不必等新模型权重落地。设计目标（时间戳准到能切）已部分达成，但「完全本地、零出域」仍待 FunASR+Qwen3-FA 落地后补齐。

---

## 2. 已落地能力清单（附代码位置）

### 2.1 P0 — 精度止血（`ea05d79`）

| 能力 | 位置 | 说明 |
|---|---|---|
| CUDA 转写 + Paraformer 词级融合 | `transcribe` `core.py:563`（CUDA EP whisper small）；`paraformer_words` `:460`；`_fuse_cloud_word_times` `:508` | 本地 whisper small 出文本，百炼 Paraformer 出词级时间并融合；`status` 字段回传识别通道状态 |
| 真实降噪 | `denoise_wav` `:418` → `_denoise_onnx` `:310` → `_denoise_dfn3` `:282` → `dfn3.enhance` | ✅ **DFN3 三段图已跑通并默认生效**（`dfn3.py` 纯 numpy+ORT，CUDA EP，69–92x 实时）；`_denoise_lightweight` 降为兜底 |
| 安全阀放宽 | `detect_cough` `:925`（`keep_ratio=0.5`） | 与词区间重叠时不再整段不删，按重叠比例保守保留 |
| ASR 失败兜底 | `_vad_only_silence` `:1399` | `words=[]` 时回退 VAD-only 而非静默早退 |
| §5.5 JSONL 契约 | `_mk_detail` `:1434` + `_DETAIL_META` `:1384` | 每条删除事件带 `type/start/end/conf/src/gap_type` 等字段，供前端可视化与可解释 |

### 2.2 P1 — 能力补全（`733125a`）

| 能力 | 位置 | 说明 |
|---|---|---|
| 暂停压缩优先（核心） | `compress_keep_timeline` `:1492` | 源时间轴保留段重映射到输出时间轴：硬删间隙不插停顿、软停顿（纯静音/思考暂停）压到 `targetPause`（默认 0.35s）后插入；输出 `keepSegmentsOut` / `outputDuration` / `compressed` |
| 语速统计 | `speaking_rate_stats` `:1451` | 词级时间戳滑窗（默认 3s/1s）算中文字/秒，给出 overall/median/windows/anomalies |
| 单元测试 | `test_pause_compress.py` | 6 个用例全通过（硬删间隙、纯软压、短暂停保持、空 keep、语速基本/空） |

### 2.3 P1→音频落地（本回合，待提交）

| 能力 | 位置 | 说明 |
|---|---|---|
| Rust 消费 keepSegmentsOut | `src/speech.rs` `speech_assemble` | 新增 `keep_segments_out` 选项 + 暂停压缩拼接路径：段按源 `keep_segments` 精确切割，段间插入「冻结末帧+静音」短暂停（默认 0.35s） |
| 回退保护 | 同上 | `keepSegmentsOut` 无效（长度不匹配/段长不一致/首段非 0）或用户手动精修过时间轴时，回退「间隙全删」旧行为（尊重 crossfade） |
| 前端下发 | `gui/src/types.ts` + `SpeechPanel.tsx` | `SpeechEditResult`/`SpeechAssembleOptions` 增加 `keepSegmentsOut` 等字段；预览/导出两处 assemble 调用下发 `keepSegmentsOut`，手动精修后不下发以防索引错位 |

---

## 3. 调用链（实测）

```
SpeechPanel.handleAnalyze (gui/src/components/panels/SpeechPanel.tsx)
  → window.aicut.speech.analyze → IPC
  → speech_analyze (Rust src/speech.rs) → spawn python/speech_edit/bridge.py → core.analyze (core.py:1571)
       ① ffmpeg 抽 16k 单声道
       ② 可选 Demucs（默认关）
       ③ transcribe (core.py:563)：CUDA whisper small + 百炼 Paraformer 词级融合
       ④ vad_speech_regions (core.py:632)
       ⑤ 多层声学检测：fillers / isolated / gap_breath / transients / cough(:925) / tonal(:984) / intra_keep / sentence_merge
       ⑥ keepNonspeech 保留策略
       ⑦ 首尾静音裁剪 → keepSegments（源时间轴）
       ⑧ [P1] compress_keep_timeline(:1492) → keepSegmentsOut / outputDuration（暂停压缩，增量输出）
       ⑨ [P1] speaking_rate_stats(:1451) → speakingRate
  ← 返回编辑计划 JSON（含 keepSegments / keepSegmentsOut / detail / speakingRate / outputDuration …）
前端用 keepSegments 补集显示「待删段」，用户微调/预览，再 speech_assemble 出片。

生成：SpeechPanel.handlePreview / handleAssemble → window.aicut.speech.assemble
  → speech_assemble (Rust src/speech.rs)
       ① 段按 keep_segments（源坐标）用 ffmpeg -ss/-to 切割
       ② [P1 暂停压缩] 若 keepSegmentsOut 有效：段间插入「冻结末帧+静音」短暂停（compress 值），concat -c copy
          否则：旧行为（间隙全删；crossfade 路径用 acrossfade 平滑接缝）
       ③ 可选 declick/deess/normalize
```

---

## 4. 设计目标与原则（不变）

- **成本**：桌面端本地优先，主链路 ONNX Runtime **CUDA EP**；百炼 Paraformer API 仅作可选增强/兜底，不默认强依赖。
- **精度**：以「时间戳准到能切」为第一指标 → 词/字级对齐（当前靠 whisper small + 百炼 Paraformer 融合；最终目标 FunASR 字级 + Qwen3-FA ±0.02s）。
- **自然流畅**：删除「**压缩停顿而非硬删**」优先（✅ 已落地）；剪切点 crossfade/declick；**不做重合成**（保真人声）。
- **少人工**：默认预设 + 可审核标记（human-in-the-loop）+ 一键应用 + 阈值滑杆 + **偏好记忆**（⏳ 未落地）。
- **可解释/可撤销**：所有删除为时间轴可视化标记，可拖边界、可撤销、可逐条确认（✅ UI 已部分支持）。

---

## 5. 整体架构（借鉴 videocut-skills，本地化改造）

`videocut-skills` 三层：**Skill 编排层 + Runtime/FFmpeg 执行层 + 人工审核账本**。

**采纳**：三层分工、审核账本、human-in-the-loop、偏好记忆。**改造**：云转录→本地高精度 ASR+对齐；单一 LLM 审核→规则引擎+可选 LLM 语义层；网页审核→AIcut 原生时间轴标记 UI。

```
┌───────────────────────────────────────────────────────────┐
│  Layer 1  编排层 (SpeechPanel + bridge)                      │
└───────────────────────────┬───────────────────────────────┘
                            ▼
┌───────────────────────────────────────────────────────────┐
│  Layer 2  决策/推理流水线 (python/speech_edit, 全本地 ONNX)   │
│  ① 音频预处理(ffmpeg 16k)                                  │
│  ② ASR + 强制对齐 → 词级时间戳 (当前: whisper small+百炼Paraformer; 目标: FunASR+Qwen3-FA) │
│  ③ 多层检测器: VAD静音 | 填充词/口误 | 咳嗽/喷麦/呼吸/叹气 | 语速异常 │
│  ④ 决策引擎: 规则 → 事件标记 (带置信度/类型, §5.5 契约)        │
│  ⑤ 降噪 (DeepFilterNet3 三段图 ONNX, ✅ 已落地)                │
│  ⑥ [P1] 暂停压缩重映射 → keepSegmentsOut                    │
└───────────────────────────┬───────────────────────────────┘
                            ▼
┌───────────────────────────────────────────────────────────┐
│  Layer 3  执行层 + 审核账本                                  │
│  - 时间轴可视化标记 (可拖边界/撤销/逐条确认)                 │
│  - Rust speech_assemble: 切段 concat + [P1] 暂停插入 + crossfade/declick │
│  - 模式Ⅰ: 仅音频；模式Ⅱ: 音视频强关联（⏳ 未落地）            │
└───────────────────────────────────────────────────────────┘
```

---

## 6. 处理流水线（步骤 + 状态）

| 步 | 动作 | 模型/工具 | 状态 |
|---|---|---|---|
| 1 | 抽音轨 16k | ffmpeg | ✅ |
| 2 | 语音识别（主/增强） | whisper small(CUDA) + 百炼 Paraformer 融合 | ✅（替代原 FunASR 方案，见 §1.1） |
| 3 | 强制对齐（切准核心） | Qwen3-FA（目标） | ⏳ 未接；当前靠 Paraformer 融合近似 |
| 4 | 停顿检测地基 | Silero VAD | ✅（`vad_speech_regions`） |
| 5 | 填充词/口误 | 词表 + 词边界时间 | ✅（部分：文本+时间，未接 FunASR CT-Transformer） |
| 6 | 重复/自我纠正/残句 | 改进 CTC + gap 分类（arXiv:2409.10177） | ⏳ 未接 |
| 7 | 副语言事件 | PANNs + Respiro-en + DSP 瞬态 | ⏳ 未接（当前仅有 cough/tonal 声学检测） |
| 8 | 语速/节奏 | 词级滑窗 + MAD | ✅（`speaking_rate_stats`） |
| 9 | 降噪/修复 | DeepFilterNet3 ONNX | ✅（`dfn3.py` 三段图跑通，CUDA EP；lightweight 仅兜底） |
| 10 | 决策引擎 | 规则 + 可选 LLM 语义层 | 🟡 规则已落地；LLM 残句判定 ⏳ |
| 11 | 呈现 | 时间轴可视化标记 | ✅（前端 UI） |
| 12 | 执行 | ffmpeg 切段 concat + [P1] 暂停插入 + crossfade/declick | ✅（含暂停压缩音频落地） |

---

## 7. 模型与开源项目选型（核心，研究结论仍有效）

> 选型研究（§7.1–§7.4）为设计阶段的调研结论，保留作依据；**落地状态**以 §2 / §6 为准。

### 7.1 ASR 与强制对齐

| 候选 | 结论 | 理由（选用/剔除） |
|---|---|---|
| **FunASR Paraformer（本地）** | ⏳ 目标主用 | 字级时间戳；AISHELL-1 CER 1.95%；中文最优之一；内置 CT-Transformer 去口误。**当前未接，P0 用百炼 Paraformer 融合替代** |
| **Qwen3-ForcedAligner（本地）** | ⏳ 目标对齐层 | ±0.02s、离线、FP16 ~1.7GB。切准关键。**当前未接** |
| **Paraformer 百炼 API** | ✅ 已增强/兜底 | 项目已在用、~¥0.04/分钟；与本地 whisper small 融合出词级时间。**P0 实际采用** |
| WhisperX | ❌ 中文主线剔除 | 中文音素对齐弱于英文 |
| whisper.cpp | ✅ 保留兜底 | 断网可用，段级，不精确切割 |
| Whisper large-v3 | ❌ 剔除 | 中文 CER~20%，不能切 |

### 7.2 降噪 / 修复

| 候选 | 结论 | 理由 |
|---|---|---|
| **DeepFilterNet3** | ✅ 已落地（默认） | MIT/Apache；三段图直挂 CUDA EP；DNSMOS SIG 4.19/BAK 4.47。实测真实口播叠噪：0dB 档 dSNR +11~+13dB、静音残噪降 50–70dB、样本级零平移（§13.1） |
| **FRCRN / MossFormer2_SE_48K** | ⏳ 高质量档 | Apache-2.0；PESQ 3.23–3.57。P3 规划 |
| RNNoise | ❌ 主力剔除 | PESQ 2.33，保真不足 |
| SIDON | ⚠️ 抢救级可选 | 重合成改音色，权重许可待法务核实 |
| Audio-Omni | ❌ 商用否决 | CC-BY-NC + 21GB |

### 7.3 副语言事件（咳嗽/喷麦/口水音/呼吸/叹气）

| 候选 | 结论 | 理由 |
|---|---|---|
| **PANNs（Cnn14）** | ⏳ 规划主检测 | MIT；AudioSet 527 含 Cough/Breathing/Sigh；帧级 SED mAP 0.385 |
| **Respiro-en** | ⏳ 规划呼吸专项 | MIT；帧级呼吸检测 |
| **DSP 瞬态检测** | ⏳ 规划自实现 | 喷麦/口水音纯 DSP，成本最低 |
| Step-Audio-EditX | ⚠️ 仅补音节兜底 | Apache，重合成，仅补音节 |

> 删除类一律走「检测器给时间戳 → 时间轴标记 → 剪切/频谱抹除」，不重合成（保真、可撤销、成本低两数量级）。

### 7.4 VAD 与停顿处理

| 候选 | 结论 | 理由 |
|---|---|---|
| **Silero VAD v6** | ✅ 首选 | MIT；ROC-AUC 0.97；四参数正好对应剪辑语义 |
| WebRTC VAD | ❌ 剔除 | ROC-AUC 0.73，噪声下几乎全判语音 |

**关键认知**：VAD 无法区分「思考停顿」与「无意义空白」，须上层分级：句末标点后 300–800ms→保留；句内>400ms→候选删；邻近填充词→强候选。**优先压缩停顿时长（1.2s→0.35s）而非硬删**（✅ 已落地 `compress_keep_timeline`）。

### 7.5 模块接口契约（§5.5 JSONL）

- **Schema（七字段）**：`{start, end, word, flag_disfluency, gap_type, conf, src}`。`start/end` 为**源媒体绝对秒**；`src` ∈ {asr, acoustic, rule}。
- **落地**：`analyze` 经 `_mk_detail` `:1434` + `_DETAIL_META` `:1384` 产出，前端 `detail` 字段消费（类型色标/可拖边）。
- **坐标基准**：源秒，Rust 落时间线经 `timeline_to_source_time` 反解，不能把源秒当 timeline 秒。

---

## 8. 口播剪辑与视频的两种关联模式

### 模式 Ⅰ：仅剪辑音频（✅ 当前默认行为）
流水线产出新音频；时间轴标记仅在音频轨；不触碰视频轨。

### 模式 Ⅱ：音视频强关联（⏳ 未落地）
删「嗯/咳嗽/死静」时画面同步剪。需在 Rust `speech.rs` 增「视频同步剪切」分支（`speech_assemble_separated` 当前仍忽略 `keepSegmentsOut`，仅处理声源分离重组）。**本回合暂停压缩仅在非分离路径生效**；分离路径的暂停压缩列为剩余项。

---

## 9. 用户视角：必须去掉的 vs 勉强可接受的

### 必须去掉（默认开启）
- 长段死静 / 句间无意义空白（>800ms 且非呼吸节奏位）；
- 明显咳嗽、清喉、喷麦爆音、口水音；
- 重复词/自我纠正；
- 稳态环境底噪（降噪）；
- 明显口误/填半句。

### 勉强可接受（默认保留，提供压缩/可选删）
- 短促思考停顿（300–800ms，保留呼吸节奏，**压缩不删** ✅）；
- 轻微语气词「嗯/啊」作过渡；
- 话尾拖长音、轻微气息声；
- 转场处非刺耳环境音。

### 用户控制面（少人工关键）
- 全局预设：轻量/标准/激进；
- 阈值滑杆：停顿删除阈值、语气词敏感度、降噪强度（⏳ UI 待补）；
- 逐条审核：保留/删除/改边界（✅ UI 支持）；
- **偏好记忆**（⏳ 未落地）。

---

## 10. 补充：用户未提到但必要的问题

1. **降噪已落地**：`_denoise_onnx` → `_denoise_dfn3` → `dfn3.py` 三段图跑通，默认生效，lightweight 降为兜底（§13.1 有实测数据）。
2. **失败不静默**：✅ `_vad_only_silence` 已实现 ASR 失败 VAD 兜底。
3. **GPU 推理**：✅ 转写已走 CUDA EP；其余检测器（PANNs 等）待接入时统一 CUDA EP。
4. **预览低延迟**：审核阶段用轻量模型，确认后走高质量（⏳ 规划）。
5. **边界安全**：✅ assemble 期 declick/crossfade 保留并参数化。
6. **音画同步校验**：模式Ⅱ落地时需做时长一致性断言（⏳）。
7. **可追溯/撤销**：✅ 时间轴标记可撤销。
8. **批处理**：⏳。
9. **能量曲线可视化**：⏳。
10. **许可合规**：默认链路 MIT/Apache；权重商用受限模型（FunASR/Qwen3-FA/SIDON/Step-Audio/Ming-UniAudio）代码可引、权重商用需法务核实。
11. **数据隐私**：本地优先；云端 API 仅可选开关且明示。
12. **性能预算**：10 分钟口播本地全链路目标 < 2 分钟（GPU）。

---

## 11. 与现有代码的对齐（改造点，标注现状）

| 现有问题 | 改造点 | 位置 | 现状 |
|---|---|---|---|
| Whisper base 粗时间戳 | CUDA whisper small + 百炼 Paraformer 融合 | `transcribe` `:563` / `paraformer_words` `:460` | ✅（非原 FunASR 方案，见 §1.1） |
| 降噪空实现 | DFN3 三段图 ONNX（lightweight 仅兜底） | `denoise_wav` `:418` / `_denoise_onnx` `:310` / `_denoise_dfn3` `:282` / `dfn3.py` | ✅ |
| 咳嗽/纯音安全阀过度保守 | `keep_ratio=0.5` 按重叠比例保留 | `detect_cough` `:925` | ✅ |
| ASR 失败静默降级 | VAD-only 回退 | `_vad_only_silence` `:1399` | ✅ |
| keepNonspeech 默认 true | 保留策略调整（沿用 current） | `analyze` `:1571` | 🟡 |
| 暂停硬删无压缩 | `compress_keep_timeline` → keepSegmentsOut | `:1492` | ✅（Python）+ ✅（Rust 消费，本回合） |
| 无语速统计 | `speaking_rate_stats` | `:1451` | ✅ |
| 无副语言检测 | PANNs/Respiro/DSP | 新增 detector | ⏳ |
| 无语音级不流畅检测 | 改进 CTC + gap 分类 | 新增 | ⏳ |
| 视频强关联缺 | Rust `speech.rs` 视频同步剪切分支 | `speech_assemble_separated` | ⏳ |

---

## 12. 实施分期与剩余项

- **P0（✅ 已落地 `ea05d79`）**：CUDA 转写 + Paraformer 融合；真实降噪接入（部分）；放宽安全阀；ASR 失败兜底；§5.5 契约。
- **P1（✅ 已落地 `733125a` + 本回合）**：暂停压缩优先（keepSegmentsOut，纯逻辑）→ **本回合 Rust 消费真正落到音频**；语速统计；单元测试。
- **P2（⏳ 规划）**：模式Ⅱ视频同步剪切（含分离路径暂停压缩）；能量曲线可视化；批处理；UI 阈值滑杆 + 预设；偏好记忆。
- **P3（⏳ 规划）**：FRCRN/MossFormer2 离线精修；可选 LLM 残句语义判定；SIDON 抢救（法务核实后）。

### 剩余项清单（按优先级）
1. **FunASR 本地字级 + Qwen3-FA 强制对齐**：达成「完全本地、零出域、±0.02s」切准目标。
2. **PANNs / Respiro-en / DSP 瞬态**：副语言事件检测落地。
3. **改进 CTC 口吃/重复 + gap 分类**：语音级不流畅检测（arXiv:2409.10177）。
4. **模式Ⅱ视频同步剪切**：Rust `speech_assemble_separated` 消费 keepSegmentsOut。
5. **偏好记忆 / UI 阈值滑杆 / 能量曲线 / 批处理**。
6. **P3 FRCRN 高质量档 + LLM 残句判定**。
7. *（可选调优）* 高输入 SNR（≥15dB）时 DFN3 处理为净损失（dSNR -1.2~-1.5dB）。若要消除，方向是 mask 软化（`mask^γ` 或与 1 混合），**不要用官方 lsnr 门控**——实测门控会让 LSD 从 8.8 爆到 28.8（§13.1）。

---

## 13. 风险与验证

- **许可风险**：默认链路（DeepFilterNet3 / Silero / PANNs / Respiro-en / FRCRN）MIT/Apache 商用安全；权重商用受限模型须法务核实。
- **暂停压缩音频落地验证**（本回合新增，待实测）：
  - 用含长停顿（>0.35s）的口播样本 analyze → 确认 `keepSegmentsOut` 相邻段间隙 ≈ 0.35s、`outputDuration` < `duration`；
  - assemble（Rust）生成后实测输出时长 ≈ `outputDuration`，且暂停处为「冻结末帧+静音」而非黑屏/跳变；
  - 手动精修时间轴后 assemble：确认不下发 keepSegmentsOut、回退间隙全删、无索引错位；
  - 无效 keepSegmentsOut（长度不匹配等）时回退旧行为、crossfade 仍生效。
- **回归红线**：现有 declick/deess/normalize/crossfade 改造后保留；`745230d`「无噪音」基线不得劣化。
- **性能**：10 分钟口播本地全链路 < 2 分钟（GPU）。

### 13.1 DFN3 降噪实测（`bench_denoise.py`，RTX5060Ti / CUDA EP）

评测脚手架 `python/speech_edit/bench_denoise.py`：`synth_*` 合成素材（4 噪声 × 3 SNR）
+ `real_*` 真实口播录音叠已知噪声（有干净参考）+ `real_raw` 原样。
**质量结论只看 `real_*`**，理由见下方「两个评测陷阱」。

真实口播叠噪，DFN3 vs lightweight 谱减兜底：

| 用例 | dSNR (lw → dfn3) | 静音残噪降低 silR | 语音失真 LSD | 增益 gain |
|---|---|---|---|---|
| real_white_0dB | +9.35 → **+11.06** | 12.41 → **55.63** | 24.32 → **20.54** | 0.877 |
| real_white_5dB | **+8.23** → +7.22 | 12.47 → **54.36** | 22.45 → **18.86** | 0.895 |
| real_white_15dB | **+5.03** → −1.50 | 12.53 → **50.26** | 18.44 → **16.97** | 0.914 |
| real_fan_0dB | +11.36 → **+13.05** | 12.19 → **69.82** | 22.11 → **19.56** | 0.923 |
| real_fan_5dB | **+10.72** → +8.42 | 12.26 → **68.98** | 20.18 → **18.34** | 0.926 |
| real_fan_15dB | **+7.24** → −1.17 | 12.34 → **67.36** | 17.92 → 17.92 | 0.926 |

- **选 DFN3 的理由**：静音残噪降低 **50–70dB vs 12dB**（碾压），LSD 全面更低。
  停顿段干净直接决定 VAD/停顿检测与词级切点精度，这正是本模块的核心诉求。
- **代价**：波形级 dSNR 在中高输入 SNR 档不如温和谱减（lightweight floor 只 −14dB，
  几乎不动语音所以波形保得住）。ASR 走梅尔谱不看波形相位，此项影响可忽略。
- **对齐**：全部用例 `lag = 0.000ms`、长度一致、削波 0、无边界尖峰。样本级零平移是硬要求。
- **实时率**：DFN3 69–92x，lightweight 700–950x。30s 音频约 0.4s，远超实时。

**两个评测陷阱（都已在代码里修掉，勿重犯）**：

1. **lag 假警报**。早期 `best_lag` 用未归一化点积、且拿 *clean* 当参考。准周期语音的
   互相关在 ±1 个基频周期（±107 样本 @16k）处有近乎等高的次峰（实测 r 差 <0.3%），
   argmax 随机跳过去 → 报出 `-6.688ms` 的"平移"。修法：参考改 **输入音频**
   （词级时间戳建立在输入轴上）+ 归一化 + 峰值需超过 `lag=0` 一个 margin。
   独立用「短时能量包络互相关」复核，全档 lag 恒为 0。
2. **合成素材 OOD**。早期合成 clean 只有 5 次谐波（750Hz 截止，1kHz 以上能量 0.0%）
   且高度稳态，落在 DNN 增强模型训练分布外：15dB 档被整体衰减 5.4dB
   （`gain=0.54`），产出 `dSNR≈−9dB` 的误导值；真实语音同档只 −1.5dB 且
   `gain=0.91`。已补共振峰 + 摩擦音，但**稳态性**无法靠加谱成分消除
   （改进后 15dB 档 `gain` 仍只 0.60–0.67）。故新增 `real_*` 叠噪用例作为质量判据，
   并把 **`gain` 列进表**——它是区分「正常处理失真」与「过抑制」的唯一判据。

**另：官方 lsnr 门控实测不可用**。`tract.rs` 的 `min_db_thresh=-10 /
max_db_erb_thresh=30 / max_db_df_thresh=20` 分级跳过，实测使 LSD 从 8.77 爆到
**28.77**（white_0dB）、hum_5dB dSNR 从 +9.13 掉到 −1.29——跳过阶段造成帧间不连续。
故 `dfn3.enhance(lsnr_gate=False)` 为默认，全帧两阶段。

---

### 附：默认技术栈一览（商用友好、本地优先）

| 环节 | 选用 | 许可 | 落地状态 |
|---|---|---|---|
| 识别（本地） | whisper small (CUDA EP) | MIT/Apache | ✅（P0） |
| 词级时间（增强） | 百炼 Paraformer API（项目已在用） | 商用 SAAS 按量 | ✅（P0） |
| 对齐（目标） | Qwen3-ForcedAligner | 待核实(阿里) | ⏳ |
| 降噪(默认) | DeepFilterNet3 (ONNX) | MIT/Apache | ✅ |
| VAD | Silero v6 (ONNX) | MIT | ✅ |
| 副语言检测 | PANNs + Respiro-en + DSP | MIT | ⏳ |
| 口吃/重复 | 改进 CTC + gap 分类 | 论文(待核) | ⏳ |
| 兜底识别 | whisper.cpp | MIT | ✅ |
| 暂停压缩 | 规则重映射（compress_keep_timeline） | — | ✅（P1 + 本回合音频落地） |
| 语速统计 | 词级滑窗 | — | ✅（P1） |
