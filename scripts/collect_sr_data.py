# -*- coding: utf-8 -*-
"""视频超清增强训练素材归集工具（把源目录里的视频按场景归到 data/sr_train/<category>/）。

合规硬约束（重要，勿删）:
    - 本项目禁止使用任何第三方预训练权重 / research-only 数据集作为训练分布，
      训练素材必须是**自有拍摄**或**已获明确授权**的视频。
    - 归集前请自行确认：无第三方 logo / 台标 / 字幕水印 / 平台压制水印，
      无他人肖像未授权使用，无受版权保护的影视、动漫、游戏画面。
    - 本脚本只做「筛选 + 搬运」，不下载、不抓取任何网络内容；
      素材来源的合规性由使用者负责。

筛选规则（默认，可用 CLI 覆盖）:
    分辨率 >= 1920x1080，时长 >= 10 秒，扩展名属于 .mp4/.mov/.mkv/.avi。
    不达标的文件跳过并在 stderr 告警，不会被搬运。

用法:
    python scripts/collect_sr_data.py --src D:/footage/raw --category portrait --dry-run
    python scripts/collect_sr_data.py --src D:/a --src D:/b --category urban --move

依赖:
    仅标准库（subprocess / json / os / shutil / argparse），不使用 cv2。
    ffprobe 路径：环境变量 AICUT_FFPROBE 优先，否则 E:/codex/codex-tools/bin/ffprobe.exe
"""
import os
import sys
import json
import shutil
import argparse
import subprocess

VIDEO_EXTS = (".mp4", ".avi", ".mov", ".mkv")
CATEGORIES = ("portrait", "landscape", "urban", "text_ui",
              "old_film", "low_light", "high_motion",
              "food", "animal", "art", "screen_recording")

CATEGORY_DEST = {
    "screen_recording": os.path.join("text_ui", "screen_recording"),
}

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
DEST_ROOT = os.path.join(_REPO, "data", "sr_train")

MIN_WIDTH = 1920
MIN_HEIGHT = 1080
MIN_DURATION = 10.0


def warn(msg):
    sys.stderr.write("[warn] %s\n" % msg)


def ffprobe_exe():
    """ffprobe 路径：与 python/sr/dataset.py 保持一致的解析顺序。"""
    return os.environ.get("AICUT_FFPROBE") or "E:/codex/codex-tools/bin/ffprobe.exe"


def probe_video(path):
    """返回 {"width","height","duration"}；探测失败返回 None（调用方跳过该文件）。"""
    cmd = [
        ffprobe_exe(), "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,duration:format=duration",
        "-of", "json", path,
    ]
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as e:
        warn("ffprobe 无法启动(%s): %s" % (ffprobe_exe(), e))
        return None
    if p.returncode != 0:
        warn("ffprobe 失败 %s: %s" % (path, p.stderr.decode("utf-8", "ignore")[:200]))
        return None
    try:
        info = json.loads(p.stdout.decode("utf-8", "ignore"))
    except ValueError as e:
        warn("ffprobe 输出非法 JSON %s: %s" % (path, e))
        return None

    streams = info.get("streams") or []
    if not streams:
        warn("未找到视频流: %s" % path)
        return None
    s = streams[0]

    duration = 0.0
    for cand in (s.get("duration"), (info.get("format") or {}).get("duration")):
        try:
            duration = float(cand)
        except (TypeError, ValueError):
            continue
        if duration > 0:
            break

    return {
        "width": int(s.get("width") or 0),
        "height": int(s.get("height") or 0),
        "duration": duration,
    }


def iter_videos(src_dirs):
    """递归遍历源目录，产出视频文件绝对路径（按路径排序，结果可复现）。"""
    for src in src_dirs:
        if not os.path.isdir(src):
            warn("源目录不存在，跳过: %s" % src)
            continue
        for root, _dirs, files in os.walk(src):
            for fn in sorted(files):
                if fn.lower().endswith(VIDEO_EXTS):
                    yield os.path.join(root, fn)


def check_spec(info, min_w, min_h, min_dur):
    """返回不达标原因；达标返回 None。"""
    if info["width"] < min_w or info["height"] < min_h:
        return "分辨率 %dx%d 低于 %dx%d" % (info["width"], info["height"], min_w, min_h)
    if info["duration"] < min_dur:
        return "时长 %.2fs 短于 %.1fs" % (info["duration"], min_dur)
    return None


def unique_dest(dest_dir, filename):
    """目标同名时追加 _1/_2… 后缀，避免静默覆盖已有素材。"""
    base, ext = os.path.splitext(filename)
    cand = os.path.join(dest_dir, filename)
    i = 1
    while os.path.exists(cand):
        cand = os.path.join(dest_dir, "%s_%d%s" % (base, i, ext))
        i += 1
    return cand


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="按场景归集视频超清增强训练素材（自有/授权素材专用）")
    ap.add_argument("--src", action="append", required=True, metavar="DIR",
                    help="源目录，可重复指定多个")
    ap.add_argument("--category", required=True, choices=CATEGORIES,
                    help="目标场景类别")
    ap.add_argument("--dest-root", default=DEST_ROOT,
                    help="归集根目录（默认 <repo>/data/sr_train）")
    ap.add_argument("--move", action="store_true",
                    help="移动而非复制（默认复制，保留源文件）")
    ap.add_argument("--dry-run", action="store_true",
                    help="只打印将要执行的操作，不实际搬运")
    ap.add_argument("--min-width", type=int, default=MIN_WIDTH)
    ap.add_argument("--min-height", type=int, default=MIN_HEIGHT)
    ap.add_argument("--min-duration", type=float, default=MIN_DURATION)
    ap.add_argument("--limit", type=int, default=0,
                    help="本次最多归集多少段（0 表示不限）")
    args = ap.parse_args(argv)

    dest_rel = CATEGORY_DEST.get(args.category, args.category)
    dest_dir = os.path.join(args.dest_root, dest_rel)
    if not args.dry_run:
        os.makedirs(dest_dir, exist_ok=True)

    action = "移动" if args.move else "复制"
    print("[collect] 类别=%s 目标=%s 模式=%s%s"
          % (args.category, dest_dir, action, "（dry-run）" if args.dry_run else ""))
    print("[collect] 规格要求: >=%dx%d, >=%.1fs"
          % (args.min_width, args.min_height, args.min_duration))

    scanned = accepted = skipped = failed = 0
    for path in iter_videos(args.src):
        if args.limit and accepted >= args.limit:
            print("[collect] 已达 --limit=%d，停止" % args.limit)
            break
        scanned += 1

        info = probe_video(path)
        if info is None:
            failed += 1
            continue

        reason = check_spec(info, args.min_width, args.min_height, args.min_duration)
        if reason:
            warn("跳过 %s: %s" % (path, reason))
            skipped += 1
            continue

        dest = unique_dest(dest_dir, os.path.basename(path))
        print("  %s %s -> %s  (%dx%d, %.1fs)"
              % (action, path, dest, info["width"], info["height"], info["duration"]))
        if not args.dry_run:
            try:
                if args.move:
                    shutil.move(path, dest)
                else:
                    shutil.copy2(path, dest)
            except (OSError, shutil.Error) as e:
                warn("%s 失败 %s: %s" % (action, path, e))
                failed += 1
                continue
        accepted += 1

    print("[collect] 扫描=%d 归集=%d 跳过=%d 失败=%d" % (scanned, accepted, skipped, failed))
    if args.dry_run:
        print("[collect] dry-run 未改动任何文件。去掉 --dry-run 实际执行。")
    else:
        print("[collect] 记得同步更新 %s 中 %s 的 collected 数量。"
              % (os.path.join(args.dest_root, "MANIFEST.json"), args.category))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
