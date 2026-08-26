# -*- coding: utf-8 -*-
"""P1 暂停压缩优先 + 语速统计 纯逻辑单元测试（无需模型权重）。

运行：
  cd E:/AIcut/python/speech_edit && python test_pause_compress.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from core import compress_keep_timeline, speaking_rate_stats  # noqa: E402


def test_compress_hard_gap():
    # 源 keep: [0,1] [2,3] [5,6]
    #   间隙 (1,2)=1s 纯软停顿 → 压到 0.35
    #   间隙 (3,5)=2s 含硬删除区间 (3.5,4.5) → 硬删，不插停顿
    keep = [(0.0, 1.0), (2.0, 3.0), (5.0, 6.0)]
    hard = [(3.5, 4.5)]
    out, od, comp = compress_keep_timeline(keep, hard, 6.0, target_pause=0.35)

    assert out[0] == (0.0, 1.0), out
    # 段1 紧接软停顿 0.35 → 起点 1.35
    assert abs(out[1][0] - 1.35) < 1e-6, out
    assert abs(out[1][1] - 2.35) < 1e-6, out
    # 段2 紧接硬删间隙(无停顿) → 起点 2.35
    assert abs(out[2][0] - 2.35) < 1e-6, out
    assert abs(od - 3.35) < 1e-6, od
    # 被压缩的软停顿应记录 [1.0, 1.35]
    assert any(abs(s - 1.0) < 1e-6 and abs(e - 1.35) < 1e-6 for s, e in comp), comp
    # 硬删间隙不得产生 compressed
    assert not any(abs(s - 2.35) < 1e-6 for s, e in comp), comp
    print("test_compress_hard_gap OK -> out=%s od=%s comp=%s" % (out, od, comp))


def test_compress_soft_only():
    # 间隙 (1,2)=1s 纯软停顿，无硬删 → 压到 0.35
    keep = [(0.0, 1.0), (2.0, 3.0)]
    out, od, comp = compress_keep_timeline(keep, [], 3.0, target_pause=0.35)
    assert abs(od - 2.35) < 1e-6, od
    assert len(comp) == 1, comp
    assert abs(comp[0][0] - 1.0) < 1e-6 and abs(comp[0][1] - 1.35) < 1e-6, comp
    print("test_compress_soft_only OK -> out=%s od=%s comp=%s" % (out, od, comp))


def test_compress_short_pause_kept():
    # 间隙 (1, 1.2)=0.2s 已 <= targetPause → 保持原长，不拉长
    keep = [(0.0, 1.0), (1.2, 2.2)]
    out, od, comp = compress_keep_timeline(keep, [], 2.2, target_pause=0.35)
    assert abs(od - 2.2) < 1e-6, od  # 1.0 + 0.2 + 1.0
    assert comp == [], comp
    print("test_compress_short_pause_kept OK -> out=%s od=%s" % (out, od))


def test_compress_empty_keep():
    out, od, comp = compress_keep_timeline([], [(1, 2)], 3.0, 0.35)
    assert out == [] and od == 0.0 and comp == [], (out, od, comp)
    print("test_compress_empty_keep OK")


def test_rate_basic():
    words = [{"word": "你好", "start": 0.0, "end": 0.5},
             {"word": "世界", "start": 0.5, "end": 1.0}]
    r = speaking_rate_stats(words, 1.0, window=1.0, step=1.0)
    assert r["char_count"] == 4, r
    assert abs(r["overall_cps"] - 4.0) < 1e-6, r
    assert r["median_cps"] > 0, r
    print("test_rate_basic OK -> %s" % r)


def test_rate_empty():
    r = speaking_rate_stats([], 1.0)
    assert r["overall_cps"] == 0.0 and r["char_count"] == 0, r
    print("test_rate_empty OK")


if __name__ == "__main__":
    test_compress_hard_gap()
    test_compress_soft_only()
    test_compress_short_pause_kept()
    test_compress_empty_keep()
    test_rate_basic()
    test_rate_empty()
    print("ALL PASS")
