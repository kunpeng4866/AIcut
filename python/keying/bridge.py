# -*- coding: utf-8 -*-
"""智能抠像（Keying）Python 桥。

用法：
    python bridge.py <input_video_path> <opts_json_string>

约定（与 speech_edit/bridge.py 一致）：
    - 仅向 stdout 输出**一行** JSON（调用方解析），其余所有日志一律走 stderr；
    - 出参契约见 core.generate_matte 的返回 dict。
"""
import os
import sys
import json

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from core import generate_matte, generate_manual_matte


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
        if opts.get("mode") == "matte":
            result = generate_matte(input_path, opts)
        elif opts.get("mode") == "manual":
            result = generate_manual_matte(input_path, opts)
        else:
            sys.stderr.write("[bridge] 未知/缺失 mode({})，仅支持 'matte'/'manual'\n".format(opts.get("mode")))
            return 2
    except Exception as e:  # noqa: BLE001
        sys.stdout = real_stdout
        sys.stderr.write("[bridge] generate_matte failed: {}\n".format(e))
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
