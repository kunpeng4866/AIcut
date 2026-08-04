# -*- coding: utf-8 -*-
"""RRDBNet → ONNX 导出脚本（视频超清增强 / Phase 0）。

产出与推理服务（core.py / inference.py，ONNX Runtime CUDA EP）对齐的模型：
    输入  input  : (batch, 9, height, width) float32 [0,1]，3 帧 LR RGB 通道拼接
    输出  output : (batch, 3, height*scale, width*scale) float32
    batch/height/width 三个轴为动态，以支持分块（tiling）推理。

用法：
    python export_onnx.py --model_path model_g_100000.pth --output_path sr_x2.onnx
    python export_onnx.py --model_path <pth> --output_path <onnx> --scale 2 --fp16

实现说明：
    - torch 2.13 起 torch.onnx.export 的 dynamo 默认为 True，而 dynamo 路径依赖
      onnxscript（本环境未安装）。因此显式传 dynamo=False 走 TorchScript 导出器，
      该路径对 dynamic_axes 的支持也更稳定。
    - FP16 依赖 onnxconverter-common；缺失时给出明确报错而非静默产出 FP32。

合规硬约束：
    禁止导出任何第三方预训练权重 / 商业 SDK 派生模型。
    model_path 必须是本项目 train.py 自行训练产出的权重。
"""
import os
import sys
import argparse

import torch

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

DEFAULT_DUMMY_HW = 256


def _log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def _import_rrdbnet():
    """延迟导入，使 `import export_onnx` 不强依赖 model.py 落地。"""
    try:
        from model import RRDBNet
    except ImportError as e:
        raise ImportError("无法从 model.py 导入 RRDBNet（%s）。请确保 %s 下存在 model.py。"
                          % (e, _HERE))
    return RRDBNet


def _extract_state_dict(ckpt):
    """兼容裸 state_dict 与 {'model'/'params'/'state_dict': ...} 包装，并剥离 DDP 前缀。"""
    if isinstance(ckpt, dict):
        for key in ("model", "params_ema", "params", "state_dict"):
            if key in ckpt and isinstance(ckpt[key], dict):
                ckpt = ckpt[key]
                break
    if not isinstance(ckpt, dict):
        raise ValueError("权重文件内容不是 state_dict，实际类型 %s" % type(ckpt).__name__)
    return {k[7:] if k.startswith("module.") else k: v for k, v in ckpt.items()}


def _to_fp16(output_path):
    try:
        from onnxconverter_common import float16
    except ImportError:
        raise ImportError(
            "--fp16 需要 onnxconverter-common，当前环境未安装。"
            "请先安装（pip install onnxconverter-common）或去掉 --fp16 导出 FP32。")
    import onnx
    model = onnx.load(output_path)
    model = float16.convert_float_to_float16(model, keep_io_types=True)
    onnx.save(model, output_path)
    _log("[export] 已转换为 FP16（保留 FP32 输入/输出类型）")


def export(model_path, output_path, scale=2, num_block=12, opset=17, fp16=False):
    """导出 RRDBNet 为 ONNX。

    Args:
        model_path: PyTorch .pth 权重路径。
        output_path: ONNX 输出路径。
        scale: 放大倍数（2）。
        num_block: RRDB 块数（12）。
        opset: ONNX opset 版本（17）。
        fp16: 是否做 FP16 量化（需 onnxconverter-common）。
    Returns:
        output_path
    """
    if not os.path.isfile(model_path):
        raise FileNotFoundError("权重文件不存在: %s" % model_path)

    RRDBNet = _import_rrdbnet()
    # 导出固定用 out_mode='clamp'：推理端必须保证输出落在 [0,1]。
    # 训练时用 'none' 以免梯度被截断，二者权重完全兼容（clamp 无参数）。
    model = RRDBNet(num_in_ch=9, num_out_ch=3, scale=scale, num_block=num_block,
                    out_mode="clamp")

    ckpt = torch.load(model_path, map_location="cpu", weights_only=False)
    state = _extract_state_dict(ckpt)
    missing, unexpected = model.load_state_dict(state, strict=False)
    if missing or unexpected:
        _log("[export] 警告：权重不完全匹配 missing=%d unexpected=%d" % (len(missing), len(unexpected)))
    model.eval()

    out_dir = os.path.dirname(os.path.abspath(output_path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    dummy = torch.randn(1, 9, DEFAULT_DUMMY_HW, DEFAULT_DUMMY_HW)
    dynamic_axes = {
        "input": {0: "batch", 2: "height", 3: "width"},
        "output": {0: "batch", 2: "height", 3: "width"},
    }
    with torch.no_grad():
        torch.onnx.export(
            model,
            dummy,
            output_path,
            input_names=["input"],
            output_names=["output"],
            dynamic_axes=dynamic_axes,
            opset_version=opset,
            do_constant_folding=True,
            dynamo=False,  # torch>=2.9 默认 True，但 dynamo 路径需要 onnxscript
        )

    # 将可能产生的外部权重(.data)内联回单文件，便于推理服务单文件加载
    import onnx
    m = onnx.load(output_path)
    onnx.save(m, output_path)
    data_file = output_path + ".data"
    if os.path.exists(data_file):
        os.remove(data_file)

    if fp16:
        _to_fp16(output_path)

    onnx.checker.check_model(onnx.load(output_path))
    _report(output_path, scale)
    return output_path


def _report(output_path, scale):
    import onnx
    m = onnx.load(output_path)
    size_mb = os.path.getsize(output_path) / (1024.0 * 1024.0)

    def shape_of(vi):
        dims = []
        for d in vi.type.tensor_type.shape.dim:
            dims.append(d.dim_param if d.dim_param else d.dim_value)
        return tuple(dims)

    _log("[export] ONNX 已写出: %s (%.2f MB)" % (output_path, size_mb))
    for vi in m.graph.input:
        _log("[export]   输入  %s %s" % (vi.name, shape_of(vi)))
    for vi in m.graph.output:
        _log("[export]   输出  %s %s" % (vi.name, shape_of(vi)))
    _log("[export]   scale=%d，checker 校验通过" % scale)


def main(argv=None):
    ap = argparse.ArgumentParser(description="RRDBNet → ONNX 导出")
    ap.add_argument("--model_path", required=True, help="PyTorch .pth 权重路径")
    ap.add_argument("--output_path", required=True, help="ONNX 输出路径")
    ap.add_argument("--scale", type=int, default=2)
    ap.add_argument("--num_block", type=int, default=12)
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--fp16", action="store_true")
    args = ap.parse_args(argv)
    export(args.model_path, args.output_path, scale=args.scale,
           num_block=args.num_block, opset=args.opset, fp16=args.fp16)


if __name__ == "__main__":
    main()
