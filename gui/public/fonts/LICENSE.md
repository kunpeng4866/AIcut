# 内置开源字体许可与来源

本目录随 AIcut 安装包分发，用于字幕 / 文字叠加层的预览与导出，确保脱离系统字体也能正确显示。

全部字体均为**开源或厂商永久免费商用**授权，可随闭源商业软件分发。

| 文件名 | 字体 | 字重 | 许可证 | 来源 |
| --- | --- | --- | --- | --- |
| `NotoSansSC-Regular.woff2` | 思源黑体 (Source Han Sans / Noto Sans SC) | 400 | SIL Open Font License 1.1 | https://github.com/notofonts/noto-cjk (npm: @fontsource/noto-sans-sc) |
| `NotoSansSC-Bold.woff2` | 思源黑体 | 700 | SIL OFL 1.1 | 同上 |
| `NotoSerifSC-Regular.woff2` | 思源宋体 (Source Han Serif / Noto Serif SC) | 400 | SIL OFL 1.1 | https://github.com/notofonts/noto-cjk (npm: @fontsource/noto-serif-sc) |
| `NotoSerifSC-Bold.woff2` | 思源宋体 | 700 | SIL OFL 1.1 | 同上 |
| `AlibabaPuHuiTi-Regular.woff2` | 阿里巴巴普惠体 3.0 | 55 Regular | 阿里巴巴普惠体免费授权（可商用） | https://github.com/c1-cn/alibaba-puhui-ti (npm: c1-alibaba-puhui-ti) |
| `AlibabaPuHuiTi-Bold.woff2` | 阿里巴巴普惠体 3.0 | 85 Bold | 同上 | 同上 |
| `AlibabaPuHuiTi-Thin.woff2` | 阿里巴巴普惠体 3.0 | 35 Thin | 同上 | 同上 |
| `HarmonyOS-SansSC-Regular.ttf` | 鸿蒙字体 (HarmonyOS Sans SC) | 400 | 华为字体免费授权（可商用） | https://github.com/fontpkg/harmony-os-sans-sc (npm: @fontpkg/harmony-os-sans-sc) |
| `HarmonyOS-SansSC-Bold.ttf` | 鸿蒙字体 | 700 | 同上 | 同上 |
| `ZCOOLKuaiLe-Regular.ttf` | 站酷快乐体 | 400 | SIL OFL 1.1 | https://github.com/google/fonts (ofl/zcoolkuaile) |
| `ZCOOLQingKeHuangYou-Regular.ttf` | 站酷酷黑 | 400 | SIL OFL 1.1 | https://github.com/google/fonts (ofl/zcoolqingkehuangyou) |

## 许可证要点

- **SIL Open Font License 1.1 (OFL)**：允许自由使用、修改、再分发（含商业用途）；若修改字体须改名；原始版权声明须保留。本软件未修改字体文件，原样分发。
- **阿里巴巴普惠体 / 鸿蒙字体**：厂商声明免费授权，可用于商业用途，随软件分发无需额外付费；保留字体名称与版权声明。

下载日期：2026-07-25。字体文件以 woff2 / ttf 形式存放，预览（Web）与导出（FFmpeg drawtext）共用同一批文件，保证所见即所得。
