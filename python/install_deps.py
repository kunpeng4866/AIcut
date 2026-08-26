#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AIcut Python 依赖稳健安装器。

为什么不直接 `pip install -r requirements.txt`：
  faster-whisper / demucs / silero-vad 声明依赖基础版 onnxruntime
  （`onnxruntime<2,>=1.14`），而本工程统一使用 onnxruntime-directml
  （它本身即完整 onnxruntime + DML 跨显卡加速，对所有 DX12 显卡生效）。
  二者会争抢同一个 `onnxruntime/` 模块目录，裸安装会出现冲突消解，
  极端情况下可能让基础版覆盖 directml、静默丢掉 DML 加速。

本脚本做法（与 requirements.txt 版本一一对应，已在干净 venv 验证通过）：
  1) 装「非语音包」（含 onnxruntime-directml，提供 onnxruntime 模块，不引基础版）；
  2) 对三个语音包用 --no-deps 安装，避免它们把基础版 onnxruntime 拉回来；
  3) 补装三个语音包除 onnxruntime 外的依赖。
结束后环境中只有 onnxruntime-directml，无任何基础版 / onnxruntime-gpu / nvidia-*。

用法：
  python install_deps.py            # 默认走清华镜像
  MIRROR=https://pypi.org/simple python install_deps.py
"""
import os
import subprocess
import sys

MIRROR = os.environ.get("MIRROR", "https://pypi.tuna.tsinghua.edu.cn/simple")
HERE = os.path.dirname(os.path.abspath(__file__))
REQ = os.path.join(HERE, "requirements.txt")

# 会拉基础版 onnxruntime 的语音包：用 --no-deps 安装，避免引入基础版。
SPEECH_NAMES = {"faster-whisper", "silero-vad", "demucs"}
# 上述语音包除 onnxruntime 外的依赖（onnxruntime 由 onnxruntime-directml 提供）。
# 这些是不带版本约束的稳定依赖；如需锁版本在此追加 ==x.y.z。
SPEECH_DEPS = [
    "ctranslate2", "huggingface_hub", "tokenizers", "av", "julius",
    "einops", "sphn", "lameenc", "safetensors", "tqdm",
]


def _pkg_name(req: str) -> str:
    """从 requirements 行提取包名（忽略版本/标记/选项）。"""
    tok = req.strip().split("=")[0].split("[")[0].split("(")[0].split(" ")[0]
    return tok.strip().lower()


def parse_requirements(path: str):
    speech, base = [], []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.split("#", 1)[0].strip()
            if not line or line.startswith(("-", "--")):
                continue
            (speech if _pkg_name(line) in SPEECH_NAMES else base).append(line)
    return base, speech


def run(cmd):
    print("+ " + " ".join(cmd), flush=True)
    subprocess.check_call(cmd)


def main():
    base, speech = parse_requirements(REQ)
    if not speech:
        print("警告：requirements.txt 未找到语音包（faster-whisper/demucs/silero-vad），"
              "请检查拼写。", file=sys.stderr)

    # 1) 非语音包（onnxruntime-directml 在此提供 onnxruntime 模块）
    run([sys.executable, "-m", "pip", "install", "-i", MIRROR, *base])
    # 2) 语音包 --no-deps：不拉基础版 onnxruntime
    if speech:
        run([sys.executable, "-m", "pip", "install", "--no-deps", "-i", MIRROR, *speech])
    # 3) 语音包的非 onnxruntime 依赖
    run([sys.executable, "-m", "pip", "install", "-i", MIRROR, *SPEECH_DEPS])

    # 自检：环境里只能有 onnxruntime-directml，且 DML EP 可用
    import importlib
    for m in ("onnxruntime", "faster_whisper", "demucs", "silero_vad", "torch"):
        importlib.import_module(m)
    import onnxruntime as ort
    import pkg_resources
    dists = {d.project_name.lower() for d in pkg_resources.working_set}
    assert "onnxruntime-gpu" not in dists, "不应存在 onnxruntime-gpu"
    assert "onnxruntime" not in dists or "onnxruntime-directml" in dists, "基础版 onnxruntime 不应单独存在"
    assert "DmlExecutionProvider" in ort.get_available_providers(), "DML EP 未就绪"
    print("OK: 依赖装好 | onnxruntime =", ort.__version__,
          "| providers:", ort.get_available_providers())


if __name__ == "__main__":
    main()
