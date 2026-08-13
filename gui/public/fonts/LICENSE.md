# 内置字体许可与来源

本目录随 AIcut 安装包分发，用于字幕 / 文字叠加层的预览与导出，确保脱离系统字体也能正确显示。

| 文件名 | 字体 | 字重 | 许可证 / 来源说明 |
| --- | --- | --- | --- |
| `NotoSansSC-Regular.ttf` | 思源黑体 (Source Han Sans / Noto Sans SC) | 400 | SIL Open Font License 1.1；由系统 `NotoSansSC-VF.ttf` 抽取静态实例 |
| `NotoSansSC-Bold.ttf` | 思源黑体 | 700 | 同上 |
| `ZCOOLKuaiLe-Regular.ttf` | 站酷快乐体 | 400 | SIL OFL 1.1，https://github.com/google/fonts (ofl/zcoolkuaile) |
| `ZCOOLQingKeHuangYou-Regular.ttf` | 站酷酷黑 | 400 | SIL OFL 1.1，https://github.com/google/fonts (ofl/zcoolqingkehuangyou) |
| `BebasNeue-Regular.ttf` | Bebas Neue | 400 | SIL OFL 1.1，https://github.com/google/fonts (ofl/bebasneue) |
| `KaiTi.ttf` | 楷体 | 400 | Windows 系统字体（Microsoft/Founder 授权），从 `C:/Windows/Fonts/simkai.ttf` 复制 |
| `SimHei.ttf` | 黑体 | 400 | Windows 系统字体，从 `C:/Windows/Fonts/simhei.ttf` 复制 |
| `FangSong.ttf` | 仿宋 | 400 | Windows 系统字体，从 `C:/Windows/Fonts/simfang.ttf` 复制 |
| `Impact.ttf` | Impact | 400 | Windows 系统字体，从 `C:/Windows/Fonts/impact.ttf` 复制 |

## 许可证要点

- **SIL Open Font License 1.1 (OFL)**：允许自由使用、修改、再分发（含商业用途）；若修改字体须改名；原始版权声明须保留。本软件未修改字体文件，原样分发。
- **Windows 系统字体（楷体/黑体/仿宋/Impact）**：随 Windows 系统提供。将其复制到安装包分发可能受微软/方正授权条款限制，请确保你的商业场景具备相应授权。导出引擎同时支持读取终端用户的系统字体库，因此即使不打包这些字体，也能在大多数 Windows 设备上正确导出。

更新日期：2026-08-13。预览（Web @font-face）与导出（FFmpeg drawtext）共用同一批文件，保证所见即所得。
