# -*- coding: utf-8 -*-
"""口播剪辑验收矩阵（item-2 回归工具）

对指定素材 × 预设组合批量跑 analyze（本进程内，不落产物），输出结构化指标表，
并按「EDL 听感红线」判定 PASS/FAIL：

  R1 最短保留段 >= min_keep_fragment 默认 0.35s（唯一保留段除外）
  R2 无微洞（洞宽 <= micro_hole_sec 0.06s 的剪切应已被撤销）
  R3 洞密度 <= maxHolesPerMin 默认 10/分钟
  R4 无 edl_failed / edl_guard_failed 告警

用法：
    python acceptance_matrix.py                 # 全部默认素材 × compact 预设
    python acceptance_matrix.py 04_stutter      # 只跑部分素材
基线结果写入 test-assets/_acceptance_baseline.json 供后续 diff。
"""
import argparse
import json
import os
import statistics
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
ASSETS = os.path.join(ROOT, "test-assets")

sys.path.insert(0, os.path.dirname(HERE))  # python/
from speech_edit import core  # noqa: E402

DEFAULT_CLIPS = [
    "01_speech_pauses.wav",
    "02_noisy_speech.wav",
    "04_stutter.wav",
    "05_paralinguistic.wav",
    "06_fillers.wav",
]

PRESETS = {
    # 紧凑（keepNonspeech=false）——碎片化风险最高的路径
    "compact": {"modelSize": "small", "vadThreshold": 0.25, "minGap": 0.18,
                "wordPad": 0.04, "fillers": True, "stutterDetect": True,
                "sedEvents": True, "sedThreshold": 0.5, "respiroBreath": True,
                "keepNonspeech": False, "trimSilence": True, "denoise": False},
}


def run_one(path: str, opts: dict) -> dict:
    t0 = time.time()
    d = core.analyze(path, dict(opts))
    dur = float(d["duration"])
    ks = [(float(a), float(b)) for a, b in d["keepSegments"]]
    # 语流内洞（两侧均发声）：与引擎 EDL 预算同口径；句间停顿不计
    au, sr = core._read_wav(path)   # 与引擎同源音频（分析用 16k 单声道）
    env, fsec = core._env_rms_grid(au, sr)
    holes_all = [(ks[i - 1][1], ks[i][0]) for i in range(1, len(ks))
                 if ks[i][0] - ks[i - 1][1] > 1e-3]
    holes = core._edl_interior_holes(ks, env, fsec)
    micro = [h for h in holes if h[1] - h[0] <= 0.06]
    warns = d.get("warnings") or []
    mpm = float(opts.get("maxHolesPerMin", 10))
    rules = {
        "R1_min_keep>=0.35": (len(ks) == 1
                              or min(b - a for a, b in ks) >= 0.349),
        "R2_no_micro_holes": not micro,
        "R3_holes_per_min<=10": dur <= 0 or len(holes) <= max(5, round(mpm * dur / 60.0)),
        "R4_no_edl_warning": not any(w.startswith("edl_failed")
                                     or w.startswith("edl_guard_failed")
                                     for w in warns),
    }
    return {
        "clip": os.path.basename(path),
        "duration": round(dur, 2),
        "keeps": len(ks),
        "holes": len(holes),
        "holes_per_min": round(len(holes) / dur * 60.0, 1) if dur else 0.0,
        "min_keep": round(min(b - a for a, b in ks), 3),
        "median_hole": round(statistics.median([h[1] - h[0] for h in holes]), 2)
                       if holes else 0.0,
        "removed_pct": round(float(d.get("ratio", 0.0)) * 100, 1),
        "suggest_events": sum(1 for x in d.get("detail", [])
                              if x.get("type") == "stutter_suggest"),
        "warnings": warns,
        "rules_pass": all(rules.values()),
        "rules_detail": {k: bool(v) for k, v in rules.items()},
        "sec": round(time.time() - t0, 1),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clips", nargs="*", help="素材名或前缀（默认全部）")
    ap.add_argument("--baseline", action="store_true", help="保存为基线 JSON")
    args = ap.parse_args()

    names = DEFAULT_CLIPS if not args.clips else [
        n for n in DEFAULT_CLIPS if any(n.startswith(c) for c in args.clips)]
    rows = []
    for n in names:
        p = os.path.join(ASSETS, n)
        if not os.path.exists(p):
            print(f"[skip] 不存在: {p}")
            continue
        r = run_one(p, PRESETS["compact"])
        rows.append(r)
        flag = "PASS" if r["rules_pass"] else "FAIL"
        print(f"[{flag}] {r['clip']:<28} 时长{r['duration']:>6}s 洞{r['holes']:>3}"
              f"({r['holes_per_min']}/min) 最短保留{r['min_keep']:.2f}s"
              f" 删{r['removed_pct']}% 建议{r['suggest_events']} {r['sec']}s"
              + ("" if r["rules_pass"] else f"  <- {[k for k,v in r['rules_detail'].items() if not v]}"))
    npass = sum(1 for r in rows if r["rules_pass"])
    print(f"\n合计 {npass}/{len(rows)} PASS")
    if args.baseline:
        out = os.path.join(ASSETS, "_acceptance_baseline.json")
        json.dump({"generated": time.strftime("%Y-%m-%d %H:%M:%S"),
                   "rows": rows}, open(out, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
        print(f"基线已写入 {out}")


if __name__ == "__main__":
    main()
