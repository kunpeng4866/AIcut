#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
导出 DeepFilterNet3 为 AIcut 推理所需的 ONNX 三件套 + config.ini。

产物（必须严格匹配 python/speech_edit/dfn3.py:306 的加载逻辑）：
    python/models/denoise/enc.onnx
    python/models/denoise/erb_dec.onnx
    python/models/denoise/df_dec.onnx
    python/models/denoise/config.ini

运行环境：本机 Windows（非 sandbox python.zip，需要 torch 做 pytorch->onnx 转换）。
依赖：torch(cpu) + deepfilternet + onnx + onnxsim
"""

import os
import sys
import subprocess

# ── 输出目录：AIcut 项目内 ──────────────────────────────
OUT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "python", "models", "denoise",
)
os.makedirs(OUT_DIR, exist_ok=True)

REQUIRED = ["enc.onnx", "erb_dec.onnx", "df_dec.onnx", "config.ini"]


def pip_install(pkgs, index=None):
    """安装依赖。index 不传则用清华镜像；传了（如 pytorch cpu）则只用它。"""
    cmd = [sys.executable, "-m", "pip", "install"]
    if index:
        cmd += ["--index-url", index]
    else:
        cmd += ["-i", "https://pypi.tuna.tsinghua.edu.cn/simple"]
    cmd += pkgs
    subprocess.check_call(cmd)


def _can_import(mod):
    try:
        __import__(mod)
        return True
    except Exception:
        return False


def run_export():
    """优先用 df 控制台脚本（位于 python/Scripts/df.exe），回退到模块直跑。"""
    py_dir = os.path.dirname(sys.executable)
    # Windows 控制台脚本在 Scripts/ 下，不在 python.exe 同级
    if os.name == "nt":
        candidates = [os.path.join(py_dir, "Scripts", "df.exe"),
                      os.path.join(py_dir, "df.exe")]
    else:
        candidates = [os.path.join(py_dir, "df")]

    export_args = ["--model", "DeepFilterNet3", "--out-dir", OUT_DIR]
    for df_exe in candidates:
        if os.path.isfile(df_exe):
            # df 是分发器，需要 'export' 子命令
            cmd = [df_exe, "export", *export_args]
            print(">>>", " ".join(cmd))
            return subprocess.run(cmd).returncode

    # 回退：直接跑 export 模块（该模块自身就是 export 命令，不要再带 'export' 子命令）
    cmd = [sys.executable, "-m", "df.scripts.export", *export_args]
    print(">>>", " ".join(cmd))
    return subprocess.run(cmd).returncode


def verify():
    missing = [f for f in REQUIRED if not os.path.isfile(os.path.join(OUT_DIR, f))]
    if missing:
        print("[FAIL] 缺少产物:", missing)
        return False
    sizes = {f: os.path.getsize(os.path.join(OUT_DIR, f)) for f in REQUIRED}
    print("[OK] 导出成功:")
    for f in REQUIRED:
        print(f"    {os.path.join(OUT_DIR, f)}  ({sizes[f] // 1024} KB)")
    return True


def main():
    print("== 1/3 安装依赖（torch cpu + deepfilternet + onnx）==")
    # 已装则跳过，避免反复扰动共享 Python 环境
    if not _can_import("torch"):
        pip_install(["torch", "torchaudio"], index="https://download.pytorch.org/whl/cpu")
    if not _can_import("df"):
        pip_install(["deepfilternet", "onnx", "onnxsim"])

    print("== 2/3 导出 DeepFilterNet3 ONNX ==")
    # DeepFilterNet3 的预训练权重会在 export 时自动下载（来自 GitHub/HF）。
    # 国内若下载慢，可手动下载后放至 deepfilternet 缓存目录，再重跑本脚本。
    rc = run_export()
    if rc != 0:
        print("[FAIL] df export 返回非零，请查看上方报错。")
        sys.exit(rc)

    print("== 3/3 校验产物 ==")
    if not verify():
        sys.exit(1)
    print("\n完成。下一步：把 python/models/denoise/ 下 4 个文件推送到 ModelScope 仓库的 models/denoise/ 目录。")


if __name__ == "__main__":
    main()
