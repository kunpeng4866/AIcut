#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
获取 PANNs 副语言 SED 所需权重文件，无需 torch（仅下载文件）。

产物（必须严格匹配 python/speech_edit/panns_sed.py:35-36 的加载逻辑）：
    python/models/panns/Cnn14_DecisionLevelMax_mAP=0.385.pth
    python/models/panns/class_labels_indices.csv

注意：文件名含 '=' 是 AudioSet 权重的标准命名，Windows NTFS 允许，勿改名。
pth 文件大小需 > 3e8 字节（python/speech_edit/panns_sed.py:69 的校验）。
"""

import os
import sys
import shutil

# ── 输出目录：AIcut 项目内 ──────────────────────────────
PANNS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "python", "models", "panns",
)
os.makedirs(PANNS_DIR, exist_ok=True)

CHECKPOINT = "Cnn14_DecisionLevelMax_mAP=0.385.pth"
LABEL_CSV = "class_labels_indices.csv"

# 官方直链（zenodo + github raw）。国内若超时，可替换为镜像后重跑。
URLS = {
    CHECKPOINT: "https://zenodo.org/record/3987831/files/Cnn14_DecisionLevelMax_mAP%3D0.385.pth",
    LABEL_CSV: "https://github.com/qiuqiangkong/audioset_classification/raw/master/metadata/class_labels_indices.csv",
}


def download(url, dest, min_bytes=0):
    """流式下载并带进度，返回是否成功。"""
    try:
        import requests
    except ImportError:
        sys.executable and __import__("subprocess").check_call(
            [sys.executable, "-m", "pip", "install", "-i",
             "https://pypi.tuna.tsinghua.edu.cn/simple", "requests"])
        import requests

    print(f">>> GET {url}")
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        done = 0
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                if not chunk:
                    continue
                f.write(chunk)
                done += len(chunk)
                if total:
                    pct = done * 100 // total
                    print(f"    {pct:3d}%  {done // 1024 // 1024}M/{total // 1024 // 1024}M", end="\r")
    print()
    if min_bytes and os.path.getsize(dest) < min_bytes:
        print(f"[WARN] {dest} 大小 {os.path.getsize(dest)} < {min_bytes}，可能下载不完整")
        return False
    return True


def try_panns_inference_download():
    """尝试用 panns_inference 包自动下载（会落到 ~/panns_data/）。"""
    try:
        import panns_inference  # noqa: F401
        home = os.path.expanduser("~/panns_data")
        for name in (CHECKPOINT, LABEL_CSV):
            src = os.path.join(home, name)
            if os.path.isfile(src):
                shutil.copy(src, os.path.join(PANNS_DIR, name))
                print(f"[copy] {name} <- {src}")
        return True
    except Exception as e:
        print(f"[skip] panns_inference 自动下载不可用: {e}")
        return False


def main():
    # 1) 先试包内自动下载
    try_panns_inference_download()

    # 2) 缺失的走直链下载
    for name, url in URLS.items():
        dest = os.path.join(PANNS_DIR, name)
        if os.path.isfile(dest) and (name != CHECKPOINT or os.path.getsize(dest) > 3e8):
            print(f"[exists] {name}")
            continue
        # pth 文件要求 > 3e8 字节
        min_bytes = 3e8 if name == CHECKPOINT else 0
        ok = download(url, dest, min_bytes=int(min_bytes))
        if not ok:
            print(f"[FAIL] {name} 下载失败，请检查网络或替换 URLS 中的镜像地址后重跑。")
            sys.exit(1)

    # 3) 校验
    missing = [n for n in (CHECKPOINT, LABEL_CSV) if not os.path.isfile(os.path.join(PANNS_DIR, n))]
    if missing:
        print("[FAIL] 仍缺少:", missing)
        sys.exit(1)
    ckpt = os.path.join(PANNS_DIR, CHECKPOINT)
    if os.path.getsize(ckpt) <= 3e8:
        print(f"[FAIL] {CHECKPOINT} 大小异常 ({os.path.getsize(ckpt)} 字节)，应 > 3e8")
        sys.exit(1)
    print("[OK] PANNs 权重就绪:")
    print(f"    {os.path.join(PANNS_DIR, CHECKPOINT)}  ({os.path.getsize(ckpt)//1024//1024} MB)")
    print(f"    {os.path.join(PANNS_DIR, LABEL_CSV)}  ({os.path.getsize(os.path.join(PANNS_DIR, LABEL_CSV))//1024} KB)")
    print("\n完成。下一步：把 python/models/panns/ 下 2 个文件推送到 ModelScope 仓库的 models/panns/ 目录。")


if __name__ == "__main__":
    main()
