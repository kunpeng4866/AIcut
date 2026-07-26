# -*- coding: utf-8 -*-
"""
bridge.py — AIcut 口播剪辑决策层入口（供 Rust 引擎调用）。

用法:
  python bridge.py <input_path> <opts_json_string>

  sys.argv[1] = 输入媒体文件路径
  sys.argv[2] = 选项 JSON 字符串（json.loads 解析；失败时回退为 {}）

行为契约:
  - 仅向 stdout 打印一行 JSON（json.dumps(result, ensure_ascii=False)），随后 flush。
  - 所有日志 / 进度 / 错误信息一律写入 stderr。
  - 异常时向 stderr 打印错误并 exit(1)。
  - 不读取 / 不生成任何媒体文件（分析仅产出编辑计划 JSON）。
"""
import os
import sys
import json

# 让 core 与本文件同目录可导入
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from core import analyze


def main(argv) -> int:
    if len(argv) < 2:
        sys.stderr.write("usage: bridge.py <input_path> <opts_json_string>\n")
        return 2

    input_path = argv[1]

    opts = {}
    if len(argv) >= 3 and argv[2].strip():
        try:
            opts = json.loads(argv[2])
            if not isinstance(opts, dict):
                opts = {}
        except Exception as e:
            sys.stderr.write(f"[bridge] opts JSON 解析失败({e})，使用默认选项\n")
            opts = {}

    # 把 core / whisper / vad / demucs 的进度输出重定向到 stderr，
    # 保证 stdout 仅有最终 JSON 一行。
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        result = analyze(input_path, opts)
    except Exception as e:  # 分析失败
        sys.stdout = real_stdout
        sys.stderr.write(f"[bridge] analyze failed: {e}\n")
        import traceback
        traceback.print_exc(file=sys.stderr)
        return 1
    finally:
        # 确保无论成功与否都恢复 stdout
        sys.stdout = real_stdout

    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
