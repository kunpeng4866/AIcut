# 内置字体许可与来源

本目录随 AIcut 安装包分发，用于字幕 / 文字叠加层的预览与导出，确保脱离系统字体也能正确显示。

**随包字体（本目录内）：**

| 文件名 | 字体 | 字重 | 许可证 / 来源说明 |
| --- | --- | --- | --- |
| `NotoSansSC-Regular.ttf` | 思源黑体 (Source Han Sans / Noto Sans SC) | 400 | SIL Open Font License 1.1；由系统 `NotoSansSC-VF.ttf` 抽取静态实例 |
| `NotoSansSC-Bold.ttf` | 思源黑体 | 700 | 同上 |
| `ZCOOLKuaiLe-Regular.ttf` | 站酷快乐体 | 400 | SIL OFL 1.1，https://github.com/google/fonts (ofl/zcoolkuaile) |
| `ZCOOLQingKeHuangYou-Regular.ttf` | 站酷酷黑 | 400 | SIL OFL 1.1，https://github.com/google/fonts (ofl/zcoolqingkehuangyou) |
| `BebasNeue-Regular.ttf` | Bebas Neue | 400 | SIL OFL 1.1，https://github.com/google/fonts (ofl/bebasneue) |

**系统字体（不随包，由导出引擎在终端用户的系统字体库读取）：**

| 字体 | 用于 id | 系统字体文件路径（示例） |
| --- | --- | --- |
| 楷体 | `kaiti` | `C:/Windows/Fonts/simkai.ttf` |
| 黑体 | `simhei` | `C:/Windows/Fonts/simhei.ttf` |
| 仿宋 | `fangsong` | `C:/Windows/Fonts/simfang.ttf` |
| Impact | `impact` | `C:/Windows/Fonts/impact.ttf` |

## 许可证要点

- **SIL Open Font License 1.1 (OFL)**：允许自由使用、修改、再分发（含商业用途）；若修改字体须改名；原始版权声明须保留。本软件未修改字体文件，原样分发。
- **Windows 系统字体（楷体/黑体/仿宋/Impact）**：随 Windows 系统提供，本产品**不**将其打包分发，导出引擎直接读取终端用户的系统字体库（`C:/Windows/Fonts` 等）。这既避免了字体授权分发风险，也保证用户所选系统字体能正确导出。

更新日期：2026-08-13。随包字体用于预览（Web @font-face）与导出（FFmpeg drawtext）；系统字体由浏览器与导出引擎直接调用用户系统字体库。
