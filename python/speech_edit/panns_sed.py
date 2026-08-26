"""PANNs (Cnn14_DecisionLevelMax) 帧级声音事件检测 (SED)。

用于口播剪辑副语言/非语音事件检测：笑声、叹气、咳嗽、喷嚏、吸气、喘息、
清嗓、打嗝、呼吸等（AudioSet 527 类）。模型权重 MIT 许可。
删除类统一走 analyze 时间轴标记 → 剪切/频谱抹除（不重合成）。

权重：Cnn14_DecisionLevelMax_mAP=0.385.pth（AudioSet 527）
标签：class_labels_indices.csv（AudioSet 527）
放置：python/models/panns/（经 assets-manifest 分发，不入库）

注意：panns_inference 包在 import 时需 ~/panns_data/class_labels_indices.csv；
本模块假定权重就绪时该 CSV 已就位（见安装/分发脚本）。

接口：
    panns_sed(audio, sr, classes=None, min_dur=0.08, max_dur=2.0)
        -> list[(start, end, class_name, score)]  # 源秒，score∈[0,1]
    panns_available() -> bool
权重缺失/异常一律返回 []（no-op 降级，对齐 dfn3/local_asr 范式）。
"""
import os
import csv
import numpy as np

try:
    import torch
    from panns_inference.inference import SoundEventDetection
    _PANNS_OK = True
except Exception:  # pragma: no cover - 依赖未装时优雅降级
    _PANNS_OK = False
    torch = None

_HERE = os.path.dirname(os.path.abspath(__file__))
_PROJECT = os.path.dirname(_HERE)
PANNS_MODEL_DIR = os.path.join(_PROJECT, "models", "panns")
CHECKPOINT_PATH = os.path.join(PANNS_MODEL_DIR, "Cnn14_DecisionLevelMax_mAP=0.385.pth")
LABEL_CSV = os.path.join(PANNS_MODEL_DIR, "class_labels_indices.csv")

_SAMPLE_RATE = 32000
_HOP = 320  # PANNs spectrogram hop @32k => 10ms/frame
_FRAME_SEC = _HOP / _SAMPLE_RATE

# 副语言/非语音事件类（display_name 严格匹配 AudioSet 527）。
# 阈值给初值，后续可用真实样本标定。
TARGET_CLASSES = {
    "Cough": 0.30,
    "Laughter": 0.40,
    "Sigh": 0.40,
    "Sniffing": 0.40,
    "Wheeze": 0.40,
    "Throat clearing": 0.40,
    "Burping, eructation": 0.40,
    "Sneeze": 0.40,
    "Breathing": 0.25,
    "Respiration": 0.30,
    "Shuffling": 0.40,
    "Clapping": 0.40,
}

# 分块推理：长音频（10 分钟口播）不能一次性进网络，按 10s 块 + 1s 重叠。
_CHUNK_SEC = 10
_STRIDE_SEC = 9

_model = None
_labels = None


def _has_weights() -> bool:
    return (_PANNS_OK and os.path.isfile(CHECKPOINT_PATH)
            and os.path.getsize(CHECKPOINT_PATH) > 3e8)


def _load_labels():
    global _labels
    if _labels is not None:
        return _labels
    _labels = []
    if os.path.isfile(LABEL_CSV):
        with open(LABEL_CSV, "r", encoding="utf-8") as f:
            for row in csv.reader(f):
                if len(row) >= 3:
                    _labels.append(row[2])
    return _labels


def _resolve_targets(classes: dict) -> list:
    labels = _load_labels()
    if not labels:
        return []
    out = []
    for name, thr in classes.items():
        if name in labels:
            out.append((labels.index(name), name, thr))
        else:
            for i, lb in enumerate(labels):  # 模糊匹配（含/被含）
                if name.lower() in lb.lower():
                    out.append((i, lb, thr))
                    break
    return out


def _get_model():
    global _model
    if _model is None and _has_weights():
        device = "cuda" if (torch is not None and torch.cuda.is_available()) else "cpu"
        # SoundEventDetection 内部 DataParallel 包裹；inference 返回 (1, T, 527) 已 sigmoid
        _model = SoundEventDetection(checkpoint_path=CHECKPOINT_PATH, device=device)
    return _model


def panns_available() -> bool:
    return _has_weights()


def panns_sed(audio: np.ndarray, sr: int,
              classes: dict = None,
              min_dur: float = 0.08, max_dur: float = 2.0) -> list:
    """对波形做帧级 SED。

    Args:
        audio: 单声道 float32 波形（任意采样率，内部重采样到 32k）
        sr:    采样率
        classes: {类名: 阈值}，默认 TARGET_CLASSES
        min_dur/max_dur: 事件最小/最大时长（秒），过滤碎段
    Returns:
        list[(start, end, class_name, score)]，时间单位秒（源媒体绝对位置）
        无权重/异常 → []
    """
    model = _get_model()
    if model is None:
        return []
    targets = _resolve_targets(classes or TARGET_CLASSES)
    if not targets:
        return []

    # 重采样到 32k（PANNs 要求）
    if sr != _SAMPLE_RATE:
        try:
            import librosa
            audio = librosa.resample(audio.astype(np.float32), orig_sr=sr, target_sr=_SAMPLE_RATE)
            sr = _SAMPLE_RATE
        except Exception:
            return []
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    n = len(audio)
    if n < 2 * _SAMPLE_RATE:  # <2s 太短，PANNs 需要一定上下文
        return []

    chunk = int(_CHUNK_SEC * _SAMPLE_RATE)
    stride = int(_STRIDE_SEC * _SAMPLE_RATE)
    events = []
    with torch.no_grad():
        pos = 0
        while pos < n:
            seg = audio[pos:pos + chunk]
            if len(seg) < int(2 * _SAMPLE_RATE):
                break
            out = model.inference(seg[None, :])[0]  # (T, 527)
            T = out.shape[0]
            base = pos / _SAMPLE_RATE
            # 重叠区只取前半（primary_end 之前），避免与上一块重复
            primary_end = (pos + stride) / _SAMPLE_RATE
            for idx, name, thr in targets:
                prob = out[:, idx]
                mask = prob >= thr
                i = 0
                while i < T:
                    if mask[i]:
                        j = i
                        while j < T and mask[j]:
                            j += 1
                        s = base + i * _FRAME_SEC
                        e = base + (j - 1) * _FRAME_SEC + _FRAME_SEC
                        center = (s + e) / 2.0
                        if (min_dur <= (e - s) <= max_dur
                                and center >= base and center <= primary_end):
                            score = float(prob[i:j].max())
                            events.append((round(s, 4), round(e, 4), name, score))
                        i = j
                    else:
                        i += 1
            pos += stride
    return events
