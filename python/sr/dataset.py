# -*- coding: utf-8 -*-
"""场景分类训练数据加载器（视频超清增强 / Phase 0）。

从「按场景分目录」的视频库中随机采样训练样本：
    随机视频 → 随机时间点抽 3 连续帧(prev/curr/next) → 随机裁剪 HR patch
    → 3 帧同步几何增强 → 3 帧施加**同参数**退化 → LR 序列

返回契约（与 model.RRDBNet(num_in_ch=9) 对齐）：
    lr_sequence : (9, patch_size//2, patch_size//2) float32 [0,1]，3 帧 RGB 通道拼接
    hr_frame    : (3, patch_size,    patch_size)    float32 [0,1]，**当前帧** curr 的 HR

技术约束（Phase 0 硬性）：
    - 仅用 numpy + PIL + subprocess(ffmpeg)，**不用 cv2 / torchvision**。
    - torch.utils.data.Dataset，支持 DataLoader 多进程（worker 内各自持有 probe 缓存）。
    - 退化参数在 3 帧间必须完全一致，否则时序一致性训练失效。

合规硬约束：
    禁止使用任何第三方预训练权重 / 商业 SDK / research-only 数据集作为训练分布。
    本加载器只消费**自有或已获授权**的视频素材；video_dir 内容由调用方负责合规。
"""
import os
import sys
import json
import random
import subprocess

import numpy as np
import torch
from torch.utils.data import Dataset

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

VIDEO_EXTS = (".mp4", ".avi", ".mov", ".mkv")
SCENE_CATEGORIES = ("portrait", "landscape", "urban", "text_ui")

# 单个样本最多重试次数（换视频/换时间点）。视频损坏、太短、分辨率不足时触发。
_MAX_SAMPLE_RETRY = 8


class _SampleError(RuntimeError):
    """可重试的采样失败（坏视频 / 太短 / 分辨率不足）。不表示代码 bug。"""


# ───────────────────────── ffmpeg 工具 ─────────────────────────

def _ffmpeg_exe() -> str:
    """ffmpeg 路径：环境变量 AICUT_FFMPEG 优先，否则用 codex-tools 内置二进制。"""
    return os.environ.get("AICUT_FFMPEG") or "E:/codex/codex-tools/bin/ffmpeg.exe"


def _ffprobe_exe() -> str:
    return os.environ.get("AICUT_FFPROBE") or "E:/codex/codex-tools/bin/ffprobe.exe"


def _probe_video(path: str) -> dict:
    """返回 {width,height,fps,duration}；失败抛 _SampleError（交给上层换一个视频）。"""
    cmd = [
        _ffprobe_exe(), "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,duration:format=duration",
        "-of", "json", path,
    ]
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as e:
        raise _SampleError("ffprobe 无法启动(%s): %s" % (_ffprobe_exe(), e))
    if p.returncode != 0:
        raise _SampleError("ffprobe 失败 %s: %s"
                           % (path, p.stderr.decode("utf-8", "ignore")[:200]))
    try:
        info = json.loads(p.stdout.decode("utf-8", "ignore"))
    except ValueError as e:
        raise _SampleError("ffprobe 输出非法 JSON %s: %s" % (path, e))

    streams = info.get("streams") or []
    if not streams:
        raise _SampleError("ffprobe 未找到视频流: %s" % path)
    s = streams[0]

    fps = 0.0
    rfr = s.get("r_frame_rate") or "0/0"
    if "/" in rfr:
        try:
            a, b = rfr.split("/")
            if float(b) > 0:
                fps = float(a) / float(b)
        except ValueError:
            fps = 0.0
    if not (fps > 0):
        fps = 25.0  # 少数容器不报 r_frame_rate，用常见默认值兜底

    dur = 0.0
    for cand in (s.get("duration"), (info.get("format") or {}).get("duration")):
        try:
            dur = float(cand)
        except (TypeError, ValueError):
            continue
        if dur > 0:
            break

    return {
        "width": int(s.get("width") or 0),
        "height": int(s.get("height") or 0),
        "fps": fps,
        "duration": dur,
    }


def _read_frames_rgb(path, start_sec, num_frames, crop):
    """从 start_sec 起解码 num_frames 帧连续帧，并在 ffmpeg 侧裁剪。

    crop: (w, h, x, y) —— 在 ffmpeg 内裁剪可大幅减少 rawvideo 管道带宽（4K 素材尤其明显）。
    返回 (num_frames, h, w, 3) uint8；不足时用最后一帧补齐。
    `-ss` 置于 `-i` 之前为快速且精确的 seek（ffmpeg >= 2.1）。
    """
    cw, ch, cx, cy = crop
    cmd = [
        _ffmpeg_exe(), "-v", "error", "-nostdin",
        "-ss", "%.4f" % max(0.0, float(start_sec)),
        "-i", path,
        "-frames:v", str(int(num_frames)),
        "-vf", "crop=%d:%d:%d:%d" % (cw, ch, cx, cy),
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as e:
        raise _SampleError("ffmpeg 无法启动(%s): %s" % (_ffmpeg_exe(), e))
    if p.returncode != 0:
        raise _SampleError("ffmpeg 解码失败 %s: %s"
                           % (path, p.stderr.decode("utf-8", "ignore")[:200]))

    frame_bytes = cw * ch * 3
    got = len(p.stdout) // frame_bytes
    if got <= 0:
        raise _SampleError("ffmpeg 未输出完整帧: %s @%.3fs" % (path, start_sec))

    arr = np.frombuffer(p.stdout[:got * frame_bytes], dtype=np.uint8)
    arr = arr.reshape(got, ch, cw, 3).copy()  # frombuffer 只读，必须 copy
    if got < num_frames:  # 逼近片尾：重复末帧补齐，保持 3 帧契约
        pad = np.repeat(arr[-1:], num_frames - got, axis=0)
        arr = np.concatenate([arr, pad], axis=0)
    return arr


# ───────────────────────── 视频扫描 ─────────────────────────

def _scan_videos(video_dir, scene_categories):
    """扫描 video_dir，返回 [(path, scene), ...]。

    优先按场景子目录组织；若一个场景子目录都不存在，则退化为「扁平模式」，
    递归收集 video_dir 下所有视频并标记 scene='unknown'。
    """
    if not os.path.isdir(video_dir):
        raise FileNotFoundError("video_dir 不存在: %s" % video_dir)

    items = []
    for scene in scene_categories:
        sub = os.path.join(video_dir, scene)
        if not os.path.isdir(sub):
            continue
        for root, _dirs, files in os.walk(sub):
            for fn in sorted(files):
                if fn.lower().endswith(VIDEO_EXTS):
                    items.append((os.path.join(root, fn), scene))

    if not items:
        for root, _dirs, files in os.walk(video_dir):
            for fn in sorted(files):
                if fn.lower().endswith(VIDEO_EXTS):
                    items.append((os.path.join(root, fn), "unknown"))
    return items


# ───────────────────────── 退化器接入 ─────────────────────────

def _build_default_degradation():
    """延迟导入 DegradationPipeline。

    延迟到实例化时才导入，使得 `import dataset` 不强依赖 degradation.py 落地，
    便于与 degradation.py 并行开发 / 单独做接口自检。
    """
    try:
        from degradation import DegradationPipeline
    except ImportError as e:
        raise ImportError(
            "无法导入 degradation.DegradationPipeline（%s）。"
            "请确保 %s 下存在 degradation.py，或显式传入 degradation= 实例。"
            % (e, _HERE)
        )
    return DegradationPipeline(config=None)


class SRVideoDataset(Dataset):
    """场景分类超分训练集。

    Args:
        video_dir: 根目录，下设场景子目录（portrait/landscape/urban/text_ui）。
        scene_categories: 参与训练的场景，默认全部。
        patch_size: HR patch 边长；LR 为 patch_size // lr_scale。
        temporal_frames: 时序帧数，固定为 3（prev/curr/next）。
        degradation: DegradationPipeline 实例；None 则构造默认实例。
        num_samples: 虚拟样本数，即一个 epoch 的采样次数（数据集本身是随机采样的）。
        lr_scale: 退化倍率，默认 2。
    """

    def __init__(self, video_dir, scene_categories=None, patch_size=256,
                 temporal_frames=3, degradation=None, num_samples=1000,
                 lr_scale=2):
        if temporal_frames != 3:
            raise ValueError("temporal_frames 固定为 3（prev/curr/next），收到 %r"
                             % temporal_frames)
        if patch_size % (2 * lr_scale) != 0:
            raise ValueError("patch_size 需能被 2*lr_scale=%d 整除（ffmpeg 裁剪需偶数偏移），"
                             "收到 %r" % (2 * lr_scale, patch_size))

        self.video_dir = video_dir
        self.scene_categories = tuple(scene_categories or SCENE_CATEGORIES)
        self.patch_size = int(patch_size)
        self.temporal_frames = 3
        self.lr_scale = int(lr_scale)
        self.lr_size = self.patch_size // self.lr_scale
        self._num_samples = int(num_samples)

        self.videos = _scan_videos(video_dir, self.scene_categories)
        if not self.videos:
            raise FileNotFoundError(
                "在 %s 下未找到任何视频（支持 %s）" % (video_dir, ", ".join(VIDEO_EXTS)))

        self._degradation = degradation if degradation is not None \
            else _build_default_degradation()
        self._probe_cache = {}

        scenes = sorted({s for _p, s in self.videos})
        sys.stderr.write("[dataset] 视频=%d 场景=%s patch=%d lr=%d samples/epoch=%d\n"
                         % (len(self.videos), ",".join(scenes),
                            self.patch_size, self.lr_size, self._num_samples))

    def __len__(self):
        return self._num_samples

    # ── 采样 ──
    def _rng_for(self, idx):
        """每个样本一个独立 RNG：worker 间、epoch 间都不重复。

        torch.initial_seed() 在 DataLoader worker 中已按 (base_seed + worker_id) 区分，
        且每个 epoch 的 base_seed 不同。
        """
        seed = (int(torch.initial_seed()) + int(idx) * 9973) % (2 ** 31 - 1)
        return np.random.Generator(np.random.PCG64(seed))

    def _probe(self, path):
        info = self._probe_cache.get(path)
        if info is None:
            info = _probe_video(path)
            self._probe_cache[path] = info
        return info

    def _degrade_sequence(self, hr_frames, seed):
        """对 3 帧施加**完全相同**参数的退化（时序一致性的前提）。

        DegradationPipeline 的随机参数取自其实例属性 `rng`（np.random.Generator），
        因此每帧调用前把 `rng` 重置为同一 seed，使 3 帧抽到完全相同的退化参数。
        seed 来自本样本的 RNG（worker / epoch / 样本间均不同），
        因此多进程加载时各 worker 的退化仍互不重复。

        另外把全局 random / np.random 也重播为同一 seed，兼容内部使用全局 RNG 的实现；
        调用前后保存并恢复全局 RNG 状态，避免污染 worker 内其他随机流。
        """
        dp = self._degradation
        has_rng = isinstance(getattr(dp, "rng", None), np.random.Generator)
        py_state = random.getstate()
        np_state = np.random.get_state()
        lrs = []
        try:
            for frame in hr_frames:
                if has_rng:
                    dp.rng = np.random.default_rng(seed)
                random.seed(seed)
                np.random.seed(seed)
                lr, _hr = dp.degrade_to_lr(frame, lr_scale=self.lr_scale)
                lrs.append(lr)
        finally:
            random.setstate(py_state)
            np.random.set_state(np_state)
        return lrs

    @staticmethod
    def _augment(frames, rng):
        """3 帧同步几何增强：随机水平/垂直翻转 + 随机 90° 旋转。"""
        if rng.random() < 0.5:
            frames = frames[:, :, ::-1, :]          # 水平翻转
        if rng.random() < 0.5:
            frames = frames[:, ::-1, :, :]          # 垂直翻转
        k = int(rng.integers(0, 4))
        if k:
            frames = np.rot90(frames, k=k, axes=(1, 2))  # 90° * k
        return np.ascontiguousarray(frames)

    def _sample_once(self, rng):
        path, _scene = self.videos[int(rng.integers(0, len(self.videos)))]
        info = self._probe(path)
        w, h, fps, dur = info["width"], info["height"], info["fps"], info["duration"]

        ps = self.patch_size
        if w < ps or h < ps:
            raise _SampleError("视频分辨率 %dx%d 小于 patch %d: %s" % (w, h, ps, path))

        # 需要 3 连续帧，且 seek 点要留出尾部余量
        tail = 3.0 / fps
        max_start = (dur - tail) if dur > 0 else 0.0
        start = float(rng.random()) * max_start if max_start > 0 else 0.0

        # 裁剪偏移取偶数：yuv420 色度二次采样要求偶数偏移，否则 ffmpeg 会隐式对齐
        cx = int(rng.integers(0, (w - ps) // 2 + 1)) * 2
        cy = int(rng.integers(0, (h - ps) // 2 + 1)) * 2

        hr_frames = _read_frames_rgb(path, start, 3, (ps, ps, cx, cy))
        hr_frames = self._augment(hr_frames, rng)

        seed = int(rng.integers(0, 2 ** 31 - 1))
        lr_frames = self._degrade_sequence(hr_frames, seed)

        expect = (self.lr_size, self.lr_size, 3)
        for i, lr in enumerate(lr_frames):
            if tuple(np.shape(lr)) != expect:
                # 契约违例（degradation.py 的问题），不重试，直接暴露
                raise RuntimeError(
                    "degrade_to_lr 返回形状 %s，期望 %s（patch_size=%d, lr_scale=%d，第 %d 帧）"
                    % (tuple(np.shape(lr)), expect, self.patch_size, self.lr_scale, i))

        lr_seq = np.concatenate(lr_frames, axis=2)              # (h, w, 9)
        lr_seq = np.ascontiguousarray(lr_seq.transpose(2, 0, 1))  # (9, h, w)
        hr_cur = np.ascontiguousarray(hr_frames[1].transpose(2, 0, 1))  # (3, H, W)

        lr_t = torch.from_numpy(lr_seq).float().div_(255.0)
        hr_t = torch.from_numpy(hr_cur).float().div_(255.0)
        return lr_t, hr_t

    def __getitem__(self, idx):
        rng = self._rng_for(idx)
        last = None
        for _ in range(_MAX_SAMPLE_RETRY):
            try:
                return self._sample_once(rng)
            except _SampleError as e:
                last = e  # 换一个视频/时间点再试
        raise RuntimeError(
            "连续 %d 次采样失败，疑似素材库或 ffmpeg 配置问题。最后一次错误: %s"
            % (_MAX_SAMPLE_RETRY, last))
