# AIcut 开发模型速查（DEV-MODEL）

> 一句话：**源代码是唯一真相源；开发版是它"在跑"；打包版是它"被冻成 exe"；Git 是它"的日记"。你永远只改源代码，其余都是它的衍生物。**

---

## 1. 四件套概念

| 概念 | 是什么 | 能不能在里面改东西 |
|---|---|---|
| **源代码** | `E:\AIcut` 下真实的 `.py / .ts / .rs` 文件 | ✅ **唯一该编辑的地方** |
| **开发版 Dev** | 把源代码用开发工具跑起来（`electron.exe .` + `vite` + `cargo`）看到的效果 | ❌ 不是"位置"，是源码在运行 |
| **打包版 Packaged** | `electron-builder` 生成的 `gui/dist-full/win-unpacked/AIcut.exe`，里面是源码某一刻的**拷贝** | ❌ 永远别直接改，重打包会被覆盖 |
| **Git** | 给源代码拍的"历史快照库"，不存打包版 | ❌ 不是运行态，是存档 |

关系：

```
           ┌──────────── Git 版本历史（只跟踪源代码）────────────┐
           │                                                      │
           ▼ 运行（即时生效）                 ▼ 构建（需重打包）
   [源代码 Source Code]  ───────────────►  [开发版 Dev]      [打包版 Packaged]
   E:\AIcut 真实文件           electron.exe . / vite / cargo   dist-full/win-unpacked/AIcut.exe
```

---

## 2. 改动该在哪

**永远只在源代码（`E:\AIcut`）里改。** 开发版和打包版都不是"编辑位置"：

- 开发版 = 你改的源码被运行起来 → "在开发版上改"和"在源码上改"是同一件事。
- 打包版 = 源码的只读快照 → 改了也会被下次重打包覆盖，徒劳。

---

## 3. 改动如何生效（分层的构建前提）

不同层改完要让它"生效"，前置动作不同：

| 层 | 改的文件 | 让改动生效的前置动作 | 验证方式 |
|---|---|---|---|
| **Rust 引擎** | `src/*.rs`（在 `E:\AIcut` 根 Cargo 工程） | 必须 `cargo build`（开发）/ `cargo build --release`（打包） | 跑 `target/debug/aicut-engine.exe` |
| **Python 推理** | `python/speech_edit/*.py` 等 | **无需构建**（解释执行），下次分析即生效；但**打包前必须 `cp` 同步到 `pack-staging/python`** | 开发版直接重跑分析；打包版需重打包 |
| **React 渲染层** | `gui/src/*` | 必须 `vite build`（或 `npm run build`）；且**必须彻底退出 Electron 重开**（有缓存） | 重启 `electron.exe .` 后看界面 |

构建命令速记（在 `E:\AIcut\gui` 下）：

```bash
npm run dev          # vite dev server（前端热更新，仅调试用）
npm run build        # tsc + vite build → gui/dist（renderer 产物）
npm run build:electron  # tsc -p tsconfig.electron.json（electron 主进程）
npm run electron:build  # vite build + tsc + electron-builder（完整打包）
```

---

## 4. 打包版是怎么造出来的（含陷阱）

打包版由源代码经三层中间形态合成：

```
E:\AIcut\python\speech_edit\core.py      ← 你改这里
        │ (手动 cp 同步)
        ▼
E:\AIcut\pack-staging\python\...core.py  ← 中间站（Python 的唯一来源）
        │ (electron-builder extraResources 拷贝)
        ▼
win-unpacked\resources\python\...core.py ← 打包版里跑的

gui/src/*  ──vite build──► app.asar            （Renderer 来源）
src/*.rs   ──cargo build --release──► resources/engine/aicut-engine.exe（Rust 来源）

三者合并 → gui/dist-full/win-unpacked/AIcut.exe
```

> ⚠️ **陷阱（最高频踩坑）**：打包版里的 Python 来自 `pack-staging/python`，**不是** `E:\AIcut\python`！
> 改了左边源码、忘了 `cp` 同步到中间站 → 打包版里还是旧代码 → "改了源码跑 exe 无效"。
> Renderer / Rust 各有中间形态（`app.asar` / `resources/engine`），但 Python 这个最隐蔽。

> 📌 **关键修正（实测 main.ts 确认）**：**开发版(dev)的 Python 实际读取的是源码 `E:\AIcut\python/.../bridge.py`**（`main.ts` 里 `AICUT_*_BRIDGE` 指向源码 bridge，解释器虽是 `pack-staging/python/python.exe`，但 `import core` 解析回源码目录）。
> 所以：**"改源码 → 开发版即时生效"对 Python 也成立**；`pack-staging` **只影响打包版**，不影响开发版。
> 推论：你之前"改源码跑 exe 看不到效果"，根因是 exe=打包版（读 pack-staging），不是开发版。开发版本来就该看到。

---

## 5. Git 是什么、属于哪一层、有什么用

- **Git 属于"源代码"层**，不属开发版也不属打包版；它只给 `E:\AIcut` 的源文件拍快照。
- **作用**：① 时光机/保险箱（回退到任意历史快照）；② 定稿标记（每完成一功能 `commit` 一次）；③ 协作基础。
- **与打包解耦**：`git commit` **不等于**打包。commit 只是存档源码状态；要给别人 exe，还得走第 4 节的打包流程。
- **常见误区**：
  - ❌ "我 commit 了，别人就能用新功能了？" → 不是，别人拿到的是源码历史，不是 exe。
  - ❌ "打包版崩了，从 git 回退打包版？" → git 里没有打包版，回退的是源码，之后还得重新打包。
  - ✅ 正确心智：**git 管"源码版本"，打包管"exe 版本"，两者用"重新打包"连接。**
- `.gitignore` 忽略 `dist/`、`win-unpacked/`、`target/` 等构建产物——Git 只存源码。

---

## 6. 推荐工作流

```
① 改源代码 → ② 开发版验证 → ③ 反复迭代(改→看→改) → ④ 定稿 → ⑤ 重打包交付
                                      │
                                      └─ git commit 存档（可回滚/协作，与打包互不等价）
```

- **定稿前全部在开发版完成**（即时反馈、零成本试错）。
- **只有定稿才重打包**（打包版是昂贵的"交付物"）。
- commit 可在定稿时做；它和打包都从"源代码"出发，但**存档 ≠ 交付**。

---

## 7. 你大概率会踩的坑

1. "在开发版上改" = "在源码上改"，开发版没有独立代码副本。
2. 打包版里改东西徒劳，重打包即被覆盖——它是只读消费物。
3. Python 改完：**开发版立刻生效**（dev 读源码）；但**打包版要两步**（`cp`→`pack-staging` → 重打包）。
4. 渲染层（React）改完必须**彻底退出 Electron 重开**，不能只刷新。
5. 开发版运行崩溃 ≠ 源码坏了（如 "GPU process isn't usable" 是环境/驱动问题，重启排查环境即可，源码照改）。
6. Git 不存打包版、也不存 `dist/`、`win-unpacked/`（被 `.gitignore` 忽略）；"从 git 恢复"= 恢复源码，恢复后要用 exe 还得重新打包。
7. **凡涉及文件删除/清理的引擎功能，dev 验证必须跑在沙箱外**。WorkBuddy 沙箱对批量文件删除有"安全删除"门禁，会拦截 Python 的 `os.remove`/`unlink`（OS 层中止进程），伪装成"功能崩溃 / 退出码 `Some(1)`"，但真实代码逻辑完全正常。典型表现：日志里出现 `[SAFE DELETE BULK CONFIRM REQUIRED]`、退出码 `1`，而 `except OSError: pass` 兜不住（OS 层拦截早于 Python 异常）。实测踩坑：口播"标准降噪"（DFN3 后端，会 `os.remove` 一个 48k 临时文件）报错、但"激进降噪"（FRCRN 后端，走 `shutil.copyfile` 不删文件）正常——根因就是标准降噪的临时文件清理被沙箱门禁拦掉，非代码 bug。正确验证方式：开发版直接双击 `gui/start.bat` 启动（或打包版），或在 WorkBuddy 里以 `dangerouslyDisableSandbox:true` 启动/运行引擎；用沙箱跑这类功能会把"沙箱副作用"误判成"功能 bug"。

---

## 8. 速查表

| 你要做的事 | 动哪里 | 前提条件 |
|---|---|---|
| 改功能 / 修 bug | **源代码** `E:\AIcut` | — |
| 看改动效果 | 开发版（跑源码） | Rust→`cargo build`；React→`vite build`+重启；Python→直接重跑 |
| 存档 / 留历史 | `git commit` | 只管源码，不管 exe |
| 给别人用 | 打包版 `win-unpacked/AIcut.exe` | Python 先 `cp`→`pack-staging`；再 `electron-builder` |

---

## 9. 重打包前自查（防丢源码改动）

> **核心原则**：打包版 = `pack-staging` 的快照。打包前必须确认 `pack-staging` 已与源码对齐，否则源码里的新改动会被旧 pack-staging 覆盖掉、随打包丢失。

### 9.1 三方比对（源码 ↔ pack-staging ↔ 打包版）

```bash
SRC=E:\AIcut\python
STG=E:\AIcut\pack-staging\python
PKG=E:\AIcut\gui\dist-full\win-unpacked\resources\python

for m in speech_edit asr keying sr; do
  # ① 源码 vs pack-staging：有差异=未同步
  diff -rq --exclude=__pycache__ --exclude=*.pyc --exclude=models "$SRC/$m" "$STG/$m"
  # ② pack-staging vs 打包版：不一致=打包版被直接改过（高危！）
  diff -q "$STG/$m" "$PKG/$m"
  # ③ 若①②有差异，看具体内容方向
  diff -u "$SRC/$m" "$PKG/$m"   # ">" 行=仅打包版有(风险)  "<" 行=仅源码有(安全)
done
```

### 9.2 渲染层 / 主进程（app.asar）

```bash
PKG=E:\AIcut\gui\dist-full\win-unpacked
ls "$PKG/resources/app" 2>/dev/null && echo "⚠ app 被手动解包编辑过" || echo "✓ app 未被解包"
# 彻底核查：asar 解包后与 gui/dist + gui/electron 编译产物逐文件比对
npx asar extract "$PKG/resources/app.asar" /tmp/asar_check
```

### 9.3 Rust 引擎

```bash
# 大小+mtime 一致=打包版引擎未被直接改
cmp E:\AIcut\target\release\aicut-engine.exe \
    E:\AIcut\gui\dist-full\win-unpacked\resources\engine\aicut-engine.exe
# 若源码改过 Rust：重打包前必 cargo build --release
```

### 9.4 定稿动作（确认源码是真相后）

```bash
# ① 源码同步到 pack-staging（仅运行时代码，不含开发脚本/models）
cp -r $SRC/speech_edit/* $STG/speech_edit/
cp -r $SRC/asr/*        $STG/asr/
cp -r $SRC/keying/*     $STG/keying/
cp -r $SRC/sr/*         $STG/sr/
# ② 再跑 electron-builder 产出新打包版
```

### 9.5 历史实测结论（2026-08-29）

三方比对结果（供下次参考）：

| 文件 | 状态 | 风险 |
|---|---|---|
| `speech_edit/core.py` | 源码领先（紧凑模式修复未打包） | ✅ 重打包会从源码带上修复 |
| `asr/bridge.py` | 打包版是旧的、不安全的 `.env` 自动搜索版；源码已删该行为 | ✅ 重打包覆盖后更安全 |
| `keying/core.py` | 两端实际 EP 代码逐字一致，仅注释文字不同 | ✅ 功能无差异 |
| `sr/*` | 仅源码多了开发脚本 | ✅ 预期（打包版不含） |
| `app.asar` | 未被解包 | ✅ 无手动编辑 |
| `aicut-engine.exe` | 与源码 release 字节级一致 | ✅ 无直接改动 |

**结论**：无"仅存于打包版、重打包会丢失且有价值"的改动。定稿重打包不会丢任何东西。
