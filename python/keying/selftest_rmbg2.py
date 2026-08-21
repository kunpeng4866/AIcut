# -*- coding: utf-8 -*-
"""rmbg2 (BRIA RMBG-2.0) 抠像自检：检测「用户选 rmbg2 抠像」时整条链路是否正常。

用法（用 AIcut 托管 Python 运行，与引擎一致）：
    python selftest_rmbg2.py                 # 快速自检：权重 + CUDA EP + 模型加载 + 单帧推理
    python selftest_rmbg2.py --full <video>  # 额外端到端：对指定视频跑完整 matte（含进度行）

检测项：
    1. rmbg2.onnx 权重是否存在（~977MB）；
    2. 走 core.py 真实路径（import core 触发 CUDA DLL PATH 注入）后，CUDA EP 是否真正生效
       —— 关键：onnxruntime 对 CUDA 不支持/缺 DLL 时会「静默回退 CPU」，肉眼无法区分，
       必须检查 session.get_providers() 第一个是否为 CUDAExecutionProvider；
    3. 模型是否加载出真实会话（use_real=True，而非 numpy 占位 matte）；
    4. 单帧推理是否产出有效 matte（min/max/mean 在 [0,1] 且非恒定）；
    5. 单帧耗时参考：CUDA ~0.5s/帧，CPU ~7s/帧（据此判断是否误走 CPU）。

退出码：0=全部通过；1=存在失败项。
"""
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import onnxruntime as ort
ort.set_default_logger_severity(3)  # 抑制 onnxruntime 内部 shape-mismatch 告警
import numpy as np

from core import _Predictor, CACHE_DIR, RMBG2_MODEL_FILENAME

FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"  -> {detail}" if detail else ""))
    if not ok:
        FAILS.append(name)


def main(argv):
    print("=== rmbg2 (BRIA RMBG-2.0) 抠像自检 ===")

    # 1. 权重存在性
    model_path = os.environ.get("AICUT_RMBG2_MODEL") or os.path.join(CACHE_DIR, RMBG2_MODEL_FILENAME)
    if os.path.isfile(model_path) and os.path.getsize(model_path) > 1024:
        check("rmbg2.onnx 权重存在", True, f"{model_path} ({os.path.getsize(model_path) // 1024 // 1024}MB)")
    else:
        check("rmbg2.onnx 权重存在", False, f"缺失：{model_path}（首次需从 ModelScope 下载，见 core._ensure_rmbg2_model）")
        print("\n自检中止：权重缺失，无法继续推理检测。")
        return 1

    # 2. 加载模型 + EP 判定（走 core 真实路径）
    logs = []

    def log(m):
        logs.append(m)

    t0 = time.time()
    p = _Predictor(model_path, log, "rmbg2")
    load_t = time.time() - t0

    ep = None
    if getattr(p, "session", None) is not None:
        eps = p.session.get_providers()
        ep = eps[0] if eps else None
    check("CUDA EP 真正生效（非静默回退 CPU）", ep == "CUDAExecutionProvider",
          f"实际 EP={ep}" if ep else "无可用 EP（全部初始化失败）")
    check("真实模型已加载（非 numpy 占位 matte）", p.use_real, f"use_real={p.use_real}")
    check("模型加载耗时 < 60s", load_t < 60, f"{load_t:.1f}s")

    if not p.use_real:
        print("\n自检中止：模型未加载出真实会话（可能 CUDA/DLL/算子问题），日志：")
        for l in logs[-8:]:
            print("  " + l)
        return 1

    # 3. 单帧推理有效性 + 耗时
    h, w = 720, 1280
    yy, xx = np.mgrid[0:h, 0:w]
    rgb = np.zeros((h, w, 3), dtype=np.uint8)
    rgb[:, :, 0] = (xx / w * 255).astype(np.uint8)
    rgb[:, :, 1] = (yy / h * 255).astype(np.uint8)
    rgb[:, :, 2] = 128
    mask = ((xx - w // 2) ** 2 + (yy - h // 2) ** 2) < (min(w, h) // 3) ** 2
    rgb[mask] = (230, 230, 230)

    p.predict_frame(rgb)  # 预热（含首次 CUDA kernel 编译）
    ts = []
    m = None
    for _ in range(3):
        t = time.time()
        m = p.predict_frame(rgb)
        ts.append(time.time() - t)
    avg = sum(ts) / len(ts)

    valid = (m is not None and float(m.min()) >= 0.0 and float(m.max()) <= 1.0
             and (float(m.max()) - float(m.min())) > 0.05)
    check("单帧推理产出有效 matte", valid,
          f"shape={m.shape} min={m.min():.3f} max={m.max():.3f} mean={m.mean():.3f}" if m is not None else "无输出")
    check("单帧耗时接近 CUDA 水平（< 5s）", avg < 5.0,
          f"平均 {avg:.2f}s/帧（CUDA ~0.5s，CPU ~7s，若 >5s 说明误走 CPU）")

    # 4. 可选端到端
    if "--full" in argv:
        idx = argv.index("--full")
        if idx + 1 >= len(argv):
            check("端到端输入视频存在", False, "未提供视频路径")
        else:
            from core import generate_matte
            video = argv[idx + 1]
            if not os.path.isfile(video):
                check("端到端输入视频存在", False, video)
            else:
                out = video.rsplit(".", 1)[0] + "_selftest_matte.mp4"
                t0 = time.time()
                try:
                    res = generate_matte(video, {"mode": "matte", "model": "rmbg2", "output": out,
                                                 "refine": False, "temporal": False})
                    check("端到端 matte 生成成功", True,
                          f"{res.get('frames')} 帧，{time.time() - t0:.1f}s，model={res.get('model')}，输出={res.get('mattePath')}")
                    check("端到端使用真实 rmbg2（非占位）", res.get("model") == "rmbg2", f"model={res.get('model')}")
                except Exception as e:  # noqa: BLE001
                    check("端到端 matte 生成成功", False, f"{type(e).__name__}: {e}")

    print("\n" + "=" * 56)
    if FAILS:
        print(f"自检未通过：{len(FAILS)} 项失败 → {FAILS}")
        print("建议：检查 nvidia/cu13、cudnn 依赖、GPU 驱动、以及 core._prepend_cuda_dll_path 是否生效。")
        return 1
    print("全部通过：rmbg2 抠像链路正常，可放心在「智能抠像」中选择 rmbg2。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
