# 视频超清增强 · 自研训练数据集

本目录存放「视频超清增强（Super Resolution）」功能的训练素材。

## 为什么必须自研数据

项目对超清增强有**防侵权硬约束**：

- 禁止使用任何第三方预训练权重（Real-ESRGAN / BasicSR / 各类开源 checkpoint 均不可）；
  模型架构可参考公开论文，**权重必须从零自训**。
- 禁止使用 research-only / 非商用授权的公开数据集作为训练分布。
- 素材必须是**自有拍摄**或**已获明确授权**，且画面中不得含第三方 logo、台标、
  字幕水印、平台压制水印，不得含未授权肖像、影视/动漫/游戏画面。

素材来源的合规性由放入者负责，请在归集前自行确认。

## 数据要求

当前按 11 个统计类别组织；`text_ui/screen_recording` 是 `text_ui` 的子目录，单独统计，但 `text_ui` 的当前数量包含该子目录。统计时间：2026-08-06。

| 目录 | 目标 | 当前 |
| --- | ---: | ---: |
| `portrait/` | 150 | 150 |
| `landscape/` | 150 | 150 |
| `urban/` | 35 | 35 |
| `text_ui/` | 150 | 200 |
| `text_ui/screen_recording/` | 50 | 50 |
| `old_film/` | 150 | 150 |
| `low_light/` | 150 | 150 |
| `high_motion/` | 150 | 150 |
| `food/` | 60 | 60 |
| `animal/` | 60 | 61 |
| `art/` | 60 | 60 |

其中 `text_ui/` 根目录（不含 `screen_recording`）当前 150 段，`screen_recording/` 当前 50 段，因此 `text_ui/` 总数 200 段。规划合计 **1165 段**，当前唯一视频总数 **1166 段**（`text_ui` 已含 `screen_recording`）。

单段素材要求：

- 分辨率 **≥ 1920×1080**，推荐 4K；
- 时长 **≥ 10 秒**；
- 格式 `.mp4` / `.mov` / `.mkv` / `.avi` / `.webm` / `.ogv`；
- 画面干净：无水印、无 logo、无重压缩痕迹（源素材越干净越好）。

## 怎么放文件

直接把视频拖进对应场景子目录即可，不需要改名、不需要注册：

```
data/sr_train/
├── portrait/
├── landscape/
├── urban/
├── text_ui/
│   └── screen_recording/
├── old_film/
├── low_light/
├── high_motion/
├── food/
├── animal/
└── art/
```

`python/sr/dataset.py` 的 `SRVideoDataset` 会递归扫描 `data/sr_train` 下所有支持
的扩展名。`text_ui/screen_recording` 作为子目录会被 `text_ui` 总数包含。训练时
指定 `--data_dir` 到 `data/sr_train` 即可：

```bash
python python/sr/train.py --data_dir data/sr_train --output_dir python/sr/checkpoints
```

> 视频本体已在本目录的 `.gitignore` 中排除，不会被提交到仓库。

## 批量归集：collect_sr_data.py

已有一堆素材散落在别处时，用 `scripts/collect_sr_data.py` 批量筛选并归集：

```bash
# 先干跑，看哪些会被收、哪些不达标
python scripts/collect_sr_data.py --src D:/footage/raw --category portrait --dry-run

# 确认无误后执行（默认复制，保留源文件）
python scripts/collect_sr_data.py --src D:/footage/raw --category portrait

# 多个源目录 + 移动模式 + 本次最多收 50 段
python scripts/collect_sr_data.py --src D:/a --src D:/b --category urban --move --limit 50
```

脚本会用 ffprobe 校验分辨率与时长，不达标的文件跳过并在 stderr 打印原因；
目标目录同名文件会自动加 `_1`/`_2` 后缀，不会静默覆盖。

ffprobe 路径取环境变量 `AICUT_FFPROBE`，未设置时回落到
`E:/codex/codex-tools/bin/ffprobe.exe`（与 `python/sr/dataset.py` 一致）。

## 退化增强是训练时自动做的

**不需要**自己准备低清版本。训练时 `python/sr/degradation.py` 会对每个 HR patch
施加 Real-ESRGAN 风格的二阶随机退化（模糊 / 缩放 / 噪声 / JPEG / sinc 振铃 /
宏块丢失，顺序随机打乱），等效每段素材可衍生约 20 种退化组合。

所以素材只需保证一件事：**高清、干净**。已经被压花、带噪点、有水印的素材反而会
把噪声学进模型里。

## 进度追踪

`MANIFEST.json` 记录目标与当前进度。每收一批就更新对应类别的 `collected`；
`text_ui` 的 `collected` 包含 `screen_recording`：

```json
"text_ui": {"target": 150, "collected": 200, "dir": "text_ui"},
"screen_recording": {"target": 50, "collected": 50, "dir": "text_ui/screen_recording"}
```

统计当前实际文件数（PowerShell）：

```powershell
Get-ChildItem data/sr_train -File -Recurse | Where-Object { $_.Extension -in '.mp4','.mov','.mkv','.avi','.webm','.ogv' } | Measure-Object
```
