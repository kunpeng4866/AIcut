#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把 AIcut 自有资产按 ModelScope 仓库目录结构，复制到你的 aicut-assets clone 中。

用法（在你的机器上）:
    E:/Python310/python.exe scripts/stage_aicut_assets.py <aicut-assets 克隆目录>

克隆目录示例: E:\aicut-assets  (即 git clone 出来的仓库根)

执行后，仓库内结构为:
    python/python.zip
    models/keying/modnet.onnx
    models/denoise/enc.onnx
    models/denoise/erb_dec.onnx
    models/denoise/df_dec.onnx
    models/denoise/config.ini
    models/panns/Cnn14_DecisionLevelMax_mAP=0.385.pth
    models/panns/class_labels_indices.csv

之后在仓库内执行 git lfs track + add + commit + push 即可（脚本会打印命令）。
"""

import os
import sys
import shutil

AICUT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (源文件相对 AIcut 根, 目标相对仓库根)
ASSETS = [
    ("pack-staging/download-assets/python.zip",
     "python/python.zip"),
    ("cdn-upload/models/modnet.onnx",
     "models/keying/modnet.onnx"),
    ("python/models/denoise/enc.onnx",
     "models/denoise/enc.onnx"),
    ("python/models/denoise/erb_dec.onnx",
     "models/denoise/erb_dec.onnx"),
    ("python/models/denoise/df_dec.onnx",
     "models/denoise/df_dec.onnx"),
    ("python/models/denoise/config.ini",
     "models/denoise/config.ini"),
    ("python/models/panns/Cnn14_DecisionLevelMax_mAP=0.385.pth",
     "models/panns/Cnn14_DecisionLevelMax_mAP=0.385.pth"),
    ("python/models/panns/class_labels_indices.csv",
     "models/panns/class_labels_indices.csv"),
]


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def main():
    if len(sys.argv) < 2:
        print("用法: python scripts/stage_aicut_assets.py <aicut-assets 克隆目录>")
        sys.exit(1)
    repo = os.path.abspath(sys.argv[1])
    if not os.path.isdir(repo):
        print(f"[FAIL] 仓库目录不存在: {repo}")
        sys.exit(1)

    print(f"源根: {AICUT_ROOT}")
    print(f"目标仓库: {repo}\n")

    total = 0
    for src_rel, dst_rel in ASSETS:
        src = os.path.join(AICUT_ROOT, src_rel)
        dst = os.path.join(repo, dst_rel)
        if not os.path.isfile(src):
            print(f"[MISS] 源缺失: {src}")
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy(src, dst)
        size = os.path.getsize(dst)
        total += size
        print(f"[OK] {dst_rel}  ({human(size)})")

    print(f"\n合计复制: {human(total)}")
    print("\n=== 接下来在仓库目录内执行 ===")
    print(f"cd /d {repo}")
    print('git lfs install')
    print('git lfs track "*.zip" "*.onnx" "*.pth"')
    print("git add .")
    print('git commit -m "aicut assets: runtime + keying + denoise(DF3) + panns"')
    print("git push origin master")


if __name__ == "__main__":
    main()
