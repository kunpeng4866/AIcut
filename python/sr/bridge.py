# -*- coding: utf-8 -*-
"""视频超清增强（Super Resolution）Python 桥。

用法：
    python bridge.py <input_video_path> <opts_json_string>

约定（与 keying/bridge.py 一致）：
    - 仅向 stdout 输出**一行** JSON（调用方解析），其余所有日志一律走 stderr；
    - 进度以 JSON 行（{"frame","total","fps","eta_sec"}）写入 stderr。

opts 约定：
    output_path  : 输出路径（缺省 = 输入同目录 <stem>_sr_output.mp4）
    model_path   : ONNX 模型路径（缺省 = 环境变量 AICUT_SR_MODEL → 内置默认路径）
    scale        : 放大倍数，默认 2
    tile_size    : LR 空间分块大小，默认 256
    tile_overlap : 分块重叠，默认 32
    provider     : "cuda"（默认）/ "cpu"
    encoder      : "nvenc"（默认）/ "x264"
    crf          : x264 质量，默认 20
    bitrate      : nvenc 目标码率，默认 "25M"
    preset       : nvenc preset，默认 "p6"
    strength     : 效果强度 0~1，默认 1.0
"""
import os
import sys
import json

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from inference import SuperResolver, default_model_path


def _default_output_path(input_path: str) -> str:
    stem, _ext = os.path.splitext(input_path)
    return stem + "_sr_output.mp4"


def main(argv) -> int:
    if len(argv) < 2:
        sys.stderr.write("usage: bridge.py <input_path> <opts_json_string>\n")
        return 2

    input_path = argv[1]
    opts: dict = {}
    if len(argv) >= 3 and argv[2].strip():
        try:
            opts = json.loads(argv[2])
        except Exception as e:  # noqa: BLE001
            sys.stderr.write("[bridge] opts JSON 解析失败({})，使用默认选项\n".format(e))
            opts = {}

    # 先把 stdout 指向 stderr，保证中间打印的任何日志都不会污染最终的那一行 JSON。
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        if not os.path.isfile(input_path):
            raise FileNotFoundError("输入视频不存在: " + input_path)

        output_path = opts.get("output_path") or _default_output_path(input_path)
        model_path = opts.get("model_path") or default_model_path()

        sr = SuperResolver(
            model_path=model_path,
            scale=int(opts.get("scale", 2)),
            tile_size=int(opts.get("tile_size", 256)),
            tile_overlap=int(opts.get("tile_overlap", 32)),
            provider=opts.get("provider", "cuda"),
        )
        result = sr.process_video(input_path, output_path, opts)
        result["ok"] = True
        result["model_path"] = os.path.abspath(model_path)
    except Exception as e:  # noqa: BLE001
        sys.stdout = real_stdout
        sys.stderr.write("[bridge] super resolution failed: {}\n".format(e))
        import traceback
        traceback.print_exc(file=sys.stderr)
        return 1
    finally:
        sys.stdout = real_stdout

    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
