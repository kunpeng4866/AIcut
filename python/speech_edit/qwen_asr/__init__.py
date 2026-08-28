# -*- coding: utf-8 -*-
"""Qwen3-ForcedAligner 强制对齐本地模块（自包含，零新增依赖）。

来源：官方 qwen-asr 0.0.6（Apache-2.0，Alibaba Qwen team）裁剪而来，仅保留
transformers_backend + forced aligner，去掉 vllm/gradio/flask/nagisa/soynlp 等
重依赖，并在 transformers 5.16.1 下做兼容适配（见下）。

适配补丁（相对官方 wheel，均为 transformers 4.57 -> 5.16.1 的 API 漂移）：
  1. modeling: `@check_model_inputs()` -> `@check_model_inputs`
  2. modeling: `create_causal_mask(..., input_embeds=, cache_position=)` ->
     `inputs_embeds=`（5.x 签名）
  3. modeling: ROPE_INIT_FUNCTIONS 无 'default' 键，加 `_default_rope_init` 兜底
  4. modeling: 补 `compute_default_rope_parameters` 别名（5.x _init_weights 访问）
  5. configuration: thinker_config/support_languages 提前到 super().__init__ 前
     （5.x 初始化期即校验 get_text_config）
  6. configuration: Qwen3ASRThinkerConfig 提前补 pad/bos/eos_token_id 默认
  7. aligner.from_pretrained: 不再 Auto* 注册（'qwen3_asr' 名已被 5.x 原生占用），
     直连类加载；device_map 单设备转 model.to()，dtype 转 torch_dtype（免 accelerate）
  8. aligner: nagisa（日语）惰性导入，缺失回退空格分词；soynlp（韩语）保持惰性

权重：1.8G（>=500M 铁律）不随包，首次使用经 AICUT_QWEN3FA_DIR（Electron 注入）
一键补全；缺失时调用方（local_asr.py）自动回退 FunASR 原生字级时间戳，不报错。
"""

from .inference.qwen3_forced_aligner import (
    Qwen3ForcedAligner,
    ForcedAlignItem,
    ForcedAlignResult,
)

__all__ = ["Qwen3ForcedAligner", "ForcedAlignItem", "ForcedAlignResult"]
