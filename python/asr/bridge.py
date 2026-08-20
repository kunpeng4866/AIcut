# -*- coding: utf-8 -*-
"""
bridge.py — AIcut「AI 自动字幕」百炼（DashScope / Paraformer）ASR Python 桥。

供 Rust 引擎 `BailianAsrProvider` 以子进程方式调用。

用法（argv 顺序固定）：
    python bridge.py <audio_path> <lang> <model> <api_key> <endpoint>

    argv[1] audio_path : 本地音视频文件路径（任意 ffmpeg 可解码格式）
    argv[2] lang       : 语言，如 zh / en / auto（auto 表示让模型自动判别）
    argv[3] model      : 模型名，缺省 qwen-audio-3.0-asr-flash-streaming（Qwen-Audio3.0 实时流式，中英自动判别，带回真实句级时间戳）
    argv[4] api_key    : 百炼 API Key；为空则回退环境变量 AICUT_ASR_API_KEY
    argv[5] endpoint   : 可选，自定义接入点 / base url；为空则忽略

输出契约（极重要）：
    - stdout **只输出一行 JSON**，其余日志 / 进度 / 异常栈一律写 stderr；
    - 成功：{"success":true,"data":{"text":"整段文本",
             "segments":[{"start":1.23,"end":4.56,"text":"一句"}]}}
    - 失败：{"success":false,"error":"错误描述"}
    - 任何异常都以上述失败 JSON 输出，绝不让 traceback 污染 stdout。

实现说明：
    输入是本地文件而非公网 URL，故走 DashScope **实时语音识别** Recognition 接口：
    先用 ffmpeg 转成 16k 单声道 16bit wav，再按 100ms 帧 send_audio_frame 推流，
    在回调里收集 is_sentence_end 为真的最终句（begin_time/end_time 单位为**毫秒**，
    此处换算为秒）。若推流未拿到任何句子，回退一次非流式 recognition.call(wav)。
"""
import os
import sys
import json
import wave
import shutil
import tempfile
import subprocess
import difflib

# 每帧 100ms：16000Hz * 0.1s = 1600 采样点，16bit 单声道 = 3200 字节
_FRAME_SAMPLES = 1600
_FRAME_BYTES = _FRAME_SAMPLES * 2
_TARGET_RATE = 16000

_DEFAULT_MODEL = "qwen-audio-3.0-asr-flash-streaming"

# 文件转写模型 → 实时识别模型映射。Recognition 接口只接受 *-realtime-* 系列，
# 上层（Rust DEFAULT_BAILIAN_MODEL）默认传 paraformer-v1，需在此转换。
_MODEL_ALIAS = {
    "paraformer": "paraformer-realtime-v2",
    "paraformer-v1": "paraformer-realtime-v2",
    "paraformer-v2": "paraformer-realtime-v2",
    "paraformer-8k-v1": "paraformer-realtime-8k-v2",
    "paraformer-8k-v2": "paraformer-realtime-8k-v2",
}

# 百炼支持的语言码（language_hints）
_LANG_CODES = {"zh", "en", "ja", "yue", "ko", "de", "fr", "ru"}


def _load_dotenv() -> None:
    """极简 .env 加载（不依赖 python-dotenv）：仅当进程尚未设置该键时才注入 os.environ。
    搜索顺序：环境变量 AICUT_ENV_FILE 指定路径 → <仓库根>/.env（脚本位于 <repo>/python/asr/，仓库根为上两级）。"""
    env_path = os.environ.get("AICUT_ENV_FILE")
    if not env_path:
        here = os.path.dirname(os.path.abspath(__file__))
        repo_root = os.path.dirname(os.path.dirname(here))  # .../python/asr → .../python → <repo>
        env_path = os.path.join(repo_root, ".env")
    if not os.path.exists(env_path):
        return
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[len("export "):]
                if "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except Exception:  # noqa: BLE001
        pass


def _log(msg: str) -> None:
    """日志一律走 stderr，避免污染 stdout 的那一行 JSON。"""
    try:
        sys.stderr.write("[asr] {}\n".format(msg))
        sys.stderr.flush()
    except Exception:  # noqa: BLE001
        pass


def _emit(obj: dict, real_stdout) -> None:
    """向真实 stdout 输出唯一一行 JSON。"""
    real_stdout.write(json.dumps(obj, ensure_ascii=False))
    real_stdout.flush()


# ───────────────────────── 音频预处理 ─────────────────────────

def _ffmpeg_exe() -> str:
    """与 python/sr/inference.py 保持一致的 ffmpeg 定位顺序。"""
    return (os.environ.get("AICUT_FFMPEG")
            or shutil.which("ffmpeg")
            or "E:/codex/codex-tools/bin/ffmpeg.exe")


def _is_ready_wav(path: str) -> bool:
    """判断是否已是 16k / 单声道 / 16bit 的 wav，是则免去 ffmpeg 转码。"""
    if not path.lower().endswith(".wav"):
        return False
    try:
        with wave.open(path, "rb") as wf:
            return (wf.getnchannels() == 1
                    and wf.getsampwidth() == 2
                    and wf.getframerate() == _TARGET_RATE)
    except Exception:  # noqa: BLE001
        return False


def _to_wav16k(src: str) -> tuple:
    """把任意音视频转成 16k 单声道 16bit wav。

    返回 (wav_path, is_temp)。is_temp 为 True 时调用方需负责删除。
    """
    if _is_ready_wav(src):
        _log("输入已是 16k 单声道 wav，跳过转码")
        return src, False

    fd, wav_path = tempfile.mkstemp(prefix="aicut_asr_", suffix=".wav")
    os.close(fd)

    ff = _ffmpeg_exe()
    cmd = [ff, "-hide_banner", "-v", "error", "-y",
           "-i", src, "-vn", "-ac", "1", "-ar", str(_TARGET_RATE),
           "-acodec", "pcm_s16le", wav_path]
    _log("ffmpeg 转码: {}".format(" ".join(cmd)))
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        try:
            os.remove(wav_path)
        except OSError:
            pass
        raise RuntimeError("找不到 ffmpeg（可用环境变量 AICUT_FFMPEG 指定）: " + ff)

    if p.returncode != 0 or not os.path.isfile(wav_path) or os.path.getsize(wav_path) == 0:
        msg = (p.stderr or b"").decode("utf-8", "replace").strip()
        try:
            os.remove(wav_path)
        except OSError:
            pass
        raise RuntimeError("ffmpeg 音频转码失败({}): {}".format(p.returncode, msg))

    return wav_path, True


# ───────────────────────── SDK 兼容层 ─────────────────────────

def _get_sentence(result):
    """取回调 / 调用结果中的句子信息，兼容不同 SDK 版本的方法名。"""
    for name in ("get_sentence", "get_sentence_info"):
        fn = getattr(result, name, None)
        if callable(fn):
            try:
                return fn()
            except Exception:  # noqa: BLE001
                continue
    return None


def _is_sentence_end(result_cls, result, sentence) -> bool:
    """官方文档中 is_sentence_end 为静态方法（传 sentence dict）；
    同时兼容部分版本的实例方法写法。"""
    fn = getattr(result_cls, "is_sentence_end", None)
    if callable(fn):
        try:
            return bool(fn(sentence))
        except TypeError:
            pass
        except Exception:  # noqa: BLE001
            pass
    fn = getattr(result, "is_sentence_end", None)
    if callable(fn):
        try:
            return bool(fn())
        except Exception:  # noqa: BLE001
            pass
    # 兜底：句子字典里带 end_time 通常意味着该句已定稿
    return isinstance(sentence, dict) and sentence.get("end_time") is not None


def _ms_to_sec(v) -> float:
    """毫秒 → 秒（float，保留 3 位）。"""
    try:
        return round(float(v) / 1000.0, 3)
    except (TypeError, ValueError):
        return 0.0


def _to_segment(sentence) -> dict:
    """把 DashScope 的 Sentence 字典转成契约里的 segment。"""
    if not isinstance(sentence, dict):
        return None
    text = (sentence.get("text") or "").strip()
    if not text:
        return None
    start = _ms_to_sec(sentence.get("begin_time"))
    end = _ms_to_sec(sentence.get("end_time"))
    if end < start:
        end = start
    return {"start": start, "end": end, "text": text}


def _segments_from_sentence(sentence):
    """把一个 Sentence 字典转成 segment 列表。
    若模型返回词级时间戳（words[]，Paraformer 实时接口默认带），则逐词返回，
    每词起止=该词真实时间——这是与剪映一致的「词级对齐」来源，能彻底消除
    「按字数重分配时长」带来的字幕漂移；否则回退为整句一段（句级时间戳）。
    返回 (segments, is_word_level)。
    """
    if not isinstance(sentence, dict):
        return [], False
    words = sentence.get("words") or []
    if words:
        segs = []
        for w in words:
            if not isinstance(w, dict):
                continue
            text = (w.get("text") or "").strip()
            if not text:
                continue
            ws = _ms_to_sec(w.get("begin_time"))
            we = _ms_to_sec(w.get("end_time"))
            if we < ws:
                we = ws
            segs.append({"start": ws, "end": we, "text": text})
        if segs:
            return segs, True
    seg = _to_segment(sentence)
    return ([seg] if seg is not None else []), False


def _join_text(segments: list) -> str:
    """中文按空串拼接，其它语言用空格分隔。"""
    parts = [s["text"] for s in segments]
    joined = "".join(parts)
    has_cjk = any("\u4e00" <= ch <= "\u9fff" for ch in joined)
    return joined if has_cjk else " ".join(parts)


# ───────────────────────── 双路融合（标点 + 词级精确时间） ─────────────────────────
# 核心矛盾：千问3(qwen3) 返回带标点的整句、但时间戳是字节粗推；Paraformer 返回词级精确时间、
# 但无标点。单模型无法同时拥有「好断句 + 好时间」。解法：两路并行，用 LCS 字符对齐把
# qwen3 的标点断句映射到 Paraformer 的词级精确时间，产出「剪映式短语 + 精确对齐」的短句。
_PUNCT_SET = set("，。．、；：？！,.!?;:…—·~～\u3000\t\n\r ")


def _is_punct_char(ch: str) -> bool:
    return ch in _PUNCT_SET


def _merge_clauses(punct_segs, time_segs):
    """punct_segs=带标点的句级结果(qwen3)；time_segs=词级精确时间结果(Paraformer)。
    返回 [{start,end,text}]（剪映式短句，时间为词级精确），或 None（任一源为空/对齐彻底失败）。
    """
    if not punct_segs or not time_segs:
        return None
    q_text = "".join((s.get("text") or "") for s in punct_segs)
    if not q_text.strip():
        return None

    p_words = [w for w in time_segs if (w.get("text") or "").strip()]
    if not p_words:
        return None
    p_plain = "".join(w["text"] for w in p_words)
    if not p_plain:
        return None

    # p 字符 → 词索引
    p_char_word = []
    for i, w in enumerate(p_words):
        for _ in w["text"]:
            p_char_word.append(i)

    # q_text 去标点 → q_plain；并记录每个 q 字符在 q_text 中的原始位置
    q_plain_chars = []
    for qi, ch in enumerate(q_text):
        if _is_punct_char(ch):
            continue
        q_plain_chars.append(ch)
    q_plain = "".join(q_plain_chars)
    if not q_plain:
        return None

    n, m = len(q_plain), len(p_plain)
    if abs(n - m) > max(n, m) * 0.4 + 16:
        # 两路转写字数差异过大，融合无意义，回退单路
        return None

    # difflib 匹配块 → q 字符定位到 p 字符（仅 LCS 直接匹配，用于 词→短句 归属）
    sm = difflib.SequenceMatcher(None, q_plain, p_plain, autojunk=False)
    q_to_p = [-1] * n
    for ai, aj, size in sm.get_matching_blocks():
        for k in range(size):
            if ai + k < n and aj + k < m:
                q_to_p[ai + k] = aj + k

    # 文本提取用的 q→p：在直接匹配基础上，把匹配块之间的「洞」按相对位置对齐补足。
    # 解决两路转录差异（如 qwen3「实则」vs Paraformer「侄子」被 LCS 判为不匹配，
    # 导致差异词拿不到文本）。此映射仅用于取文本，绝不参与 词→短句 归属（归属只用
    # 上面的直接匹配，避免把孤儿词错配进错误短句）。
    q_to_p_fill = list(q_to_p)
    matched_q = [p >= 0 for p in q_to_p]
    qi = 0
    while qi < n:
        if matched_q[qi]:
            qi += 1
            continue
        qstart = qi
        while qi < n and not matched_q[qi]:
            qi += 1
        qend = qi  # 未匹配 q 区间 [qstart, qend)
        p_before = q_to_p[qstart - 1] if (qstart - 1 >= 0 and q_to_p[qstart - 1] >= 0) else -1
        p_after = q_to_p[qend] if (qend < n and q_to_p[qend] >= 0) else -1
        # 只填「两侧都有锚点」的内部空洞（如 qwen3「实则」vs Paraformer「侄子」），
        # 让差异词也能取到正确文本。前缀/后缀空洞（仅一侧有锚点）不填充：q 侧冗余
        # 字符（如 qwen3 误加的首句「我。」）直接丢弃，避免错配进相邻词造成文本重复。
        if p_before >= 0 and p_after >= 0:
            ps, pe = p_before + 1, p_after
            Lq, Lp = qend - qstart, pe - ps
            for k in range(Lq):
                pp = ps + (k * Lp // Lq) if Lp > 0 else ps
                if 0 <= pp < m:
                    q_to_p_fill[qstart + k] = pp

    # q 字符 → 词索引（未匹配的先置 -1）
    q_word_idx = [-1] * n
    for qi in range(n):
        ppos = q_to_p[qi]
        if ppos >= 0:
            q_word_idx[qi] = p_char_word[ppos]

    # 最近邻居填充（前向 + 后向），处理两路转写的细微字符差异
    last = -1
    for qi in range(n):
        if q_word_idx[qi] >= 0:
            last = q_word_idx[qi]
        else:
            q_word_idx[qi] = last
    last = -1
    for qi in range(n - 1, -1, -1):
        if q_word_idx[qi] >= 0:
            last = q_word_idx[qi]
        else:
            q_word_idx[qi] = last
    if all(w < 0 for w in q_word_idx):
        return None

    def word_of(qi):
        wi = q_word_idx[qi]
        if wi is None or wi < 0 or wi >= len(p_words):
            return None
        return p_words[wi]

    # 按 q_text 标点切分短句；非标点字符按出现顺序对应 q_plain 的连续索引
    clauses = []
    cur = []
    plain_ptr = 0
    for ch in q_text:
        if _is_punct_char(ch):
            if cur:
                clauses.append(cur)
                cur = []
            continue
        if plain_ptr < n:
            cur.append(plain_ptr)
        plain_ptr += 1
    if cur:
        clauses.append(cur)
    if not clauses:
        return None

    # q_plain 字符 → 所属短句索引（O(1) 查找）
    char_to_clause = [-1] * n
    for ci, cl in enumerate(clauses):
        for qi in cl:
            if 0 <= qi < n:
                char_to_clause[qi] = ci

    # ── 把每个 Paraformer 词分配到某个短句，保证时间连续、无空洞、不丢词 ──
    # 关键：两路转录偶有差异（如 Paraformer「侄子」vs qwen3「实则」），差异词在 LCS 中
    # 不会被任何 q 字符映射到 → 成为「孤儿词」。若不处理，对应短句的时间区间会跳过该
    # 区域，造成字幕时间错位/提前结束（如「实则…」句首被砍掉 1.6s）。这里把孤儿词顺延给
    # 相邻短句（优先归入下一句，让其进入正确的后续短语；无下一句则归入上一句），
    # 使整条时间轴连续且精确，彻底消除空洞。
    word_to_clause = [-1] * len(p_words)
    # 用「洞填充后的 q→p 反向映射」把每个 Paraformer 词归属到它文本所属短句：
    #   - 正常词：直接匹配 → 正确短句
    #   - 替换型孤儿（Paraformer「侄子」↔ qwen3「实则」）：洞填充后 侄子→实（实则是
    #     「实则要多幸运才能遇到」首字）→ 归入该句，而非并入上一句
    #   - 本句内孤儿（如「大家看一下」的「下」暂未匹配）：其 q 字符仍在原句 → 留在原句
    # 这样「词级时间」与「标点短句」严格对应，长停顿再切分时「实则」能被正确孤立。
    p_to_q = [-1] * m
    for qi in range(n):
        pp = q_to_p_fill[qi]
        if 0 <= pp < m:
            p_to_q[pp] = qi
    word_pchars = [[] for _ in range(len(p_words))]
    for pp in range(m):
        word_pchars[p_char_word[pp]].append(pp)
    for wi in range(len(p_words)):
        ci = -1
        for pp in word_pchars[wi]:
            qi = p_to_q[pp]
            if qi >= 0 and char_to_clause[qi] >= 0:
                ci = char_to_clause[qi]
                break
        word_to_clause[wi] = ci
    # 仍无归属的词：仅对「非尾部」孤儿做就近兜底（避免单向向前把句尾词错并入下一句）；
    # 尾部孤儿（Paraformer 多出的冗余尾词，q 侧无对应字符）保持 -1，交由「尾部恢复」单独成句，
    # 以免与尾部恢复重复计数。
    for wi in range(len(p_words)):
        if word_to_clause[wi] >= 0:
            continue
        has_following = any(word_to_clause[wj] >= 0 for wj in range(wi + 1, len(p_words)))
        if not has_following:
            continue
        best_ci = -1
        best_d = 10 ** 9
        for wj in range(len(p_words)):
            if word_to_clause[wj] >= 0:
                d = abs(wj - wi)
                if d < best_d:
                    best_d = d
                    best_ci = word_to_clause[wj]
        if best_ci >= 0:
            word_to_clause[wi] = best_ci

    # ── 长停顿再切分 ──
    # 标点切出的短句内部，若相邻词级时间戳间隔超过阈值，视为自然停顿边界，
    # 把该短句再切成独立片段（如「实则」与「要多幸运才能遇到」间 0.9s 停顿 →
    # 「实则」单独成句，既不并入上一句也不并入下一句）。阈值可用环境变量
    # AICUT_ASR_PAUSE_SPLIT 覆盖（设 ≤0 关闭）。
    try:
        pause_split = float(os.environ.get("AICUT_ASR_PAUSE_SPLIT", "0.7"))
    except ValueError:
        pause_split = 0.7

    # 词 → 其对应的 q_plain 字符（用于从 qwen3 正确文本截取子段文本；用洞填充后的映射）
    p_word_qchars = [[] for _ in range(len(p_words))]
    for qi in range(n):
        ppos = q_to_p_fill[qi]
        if ppos >= 0:
            wi = p_char_word[ppos]
            if 0 <= wi < len(p_words):
                p_word_qchars[wi].append(qi)

    out = []
    for ci, cl in enumerate(clauses):
        text0 = "".join(q_plain[c] for c in cl)
        if not text0.strip():
            continue
        wis = [wi for wi in range(len(p_words)) if word_to_clause[wi] == ci]
        if not wis:
            continue
        wis.sort()
        # 按长停顿把 wis 切分为若干子组
        groups = []
        cur = [wis[0]]
        for wi in wis[1:]:
            gap = p_words[wi]["start"] - p_words[cur[-1]]["end"]
            if gap > pause_split:
                groups.append(cur)
                cur = [wi]
            else:
                cur.append(wi)
        groups.append(cur)
        for g in groups:
            qchars = []
            for wi in g:
                qchars.extend(p_word_qchars[wi])
            qchars.sort()
            text = "".join(q_plain[qc] for qc in qchars)
            if not text.strip():
                continue
            lo, hi = min(g), max(g)
            seg_start = p_words[lo]["start"]
            seg_end = p_words[hi]["end"]
            out.append({"start": round(seg_start, 3), "end": round(seg_end, 3), "text": text})

    # 尾部恢复：把「最后一个被 q 覆盖的词之后、且连续未被 q 覆盖」的 Paraformer 尾部词
    # 追加为一句，用其词级精确时间 + Paraformer 自身文本，保证整段音频都被字幕覆盖、
    # 不丢末句（qwen3 实时流偶发丢尾词，如「轻飘/仍飘」）。
    covered_words = set()
    for qi in range(n):
        if q_to_p[qi] >= 0:
            covered_words.add(p_char_word[q_to_p[qi]])
    last_covered = -1
    for wi in range(len(p_words) - 1, -1, -1):
        if wi in covered_words:
            last_covered = wi
            break
    if last_covered >= 0 and last_covered + 1 < len(p_words):
        tail_clean = all(wi not in covered_words for wi in range(last_covered + 1, len(p_words)))
        if tail_clean:
            tail = p_words[last_covered + 1:]
            tail_text = "".join(w["text"] for w in tail)
            if tail_text.strip():
                prev_end = out[-1]["end"] if out else 0.0
                tail_start = max(min(w["start"] for w in tail), prev_end)
                tail_end = max(max(w["end"] for w in tail), tail_start + 0.2)
                out.append({"start": round(tail_start, 3), "end": round(tail_end, 3), "text": tail_text})

    if not out:
        return None
    return out


# ───────────────────────── 识别主流程 ─────────────────────────

def _normalize_model(model: str) -> str:
    m = (model or "").strip() or _DEFAULT_MODEL
    mapped = _MODEL_ALIAS.get(m.lower())
    if mapped:
        _log("模型 {} 非实时识别模型，映射为 {}".format(m, mapped))
        return mapped
    return m


def _language_hints(lang: str, model: str):
    """language_hints 仅 Paraformer / Fun-ASR 等显式支持的模型生效；
    Qwen 系列（qwen3-* / qwen-audio-*）具备多语种自动判别能力，传该参数反而可能限制其表现，
    故不传，交由模型自动判语（对中文/英文/中英混说均友好）；auto 时同样不传。"""
    low = (model or "").lower()
    if "qwen" in low:
        _log("模型 {} 支持多语种自动判别，不传 language_hints".format(model))
        return None
    code = (lang or "").strip().lower()
    if not code or code in ("auto", "automatic"):
        return None
    code = code.split("-")[0].split("_")[0]
    if code not in _LANG_CODES:
        _log("未识别的语言码 {}，忽略 language_hints".format(lang))
        return None
    if "-v2" not in low and "fun-asr" not in low:
        _log("模型 {} 不支持 language_hints，忽略".format(model))
        return None
    # 中文场景带上 en 以兼容中英混说
    return ["zh", "en"] if code == "zh" else [code]


def _recognize(wav_path: str, lang: str, model: str) -> list:
    """实时流式识别，返回 segments 列表。"""
    import dashscope  # noqa: F401  (确保包可用，api_key 已在 main 中注入)
    from dashscope.audio.asr import Recognition, RecognitionCallback, RecognitionResult

    segments = []
    errors = []
    seen = set()
    word_level_flag = [False]

    class _Callback(RecognitionCallback):
        def on_open(self) -> None:
            _log("识别连接已建立")

        def on_close(self) -> None:
            _log("识别连接已关闭")

        def on_complete(self) -> None:
            _log("识别完成")

        def on_error(self, result) -> None:
            msg = getattr(result, "message", None) or str(result)
            msg = str(msg).strip()
            # "stopped" / "idle timeout" 是会话正常结束的服务端通知，非致命错误
            low = msg.lower()
            if any(kw in low for kw in ("stopped", "idle timeout", "no audio", "silence")):
                _log("识别状态(非错误): {}".format(msg))
                return
            errors.append(msg)
            _log("识别错误: {}".format(msg))

        def on_event(self, result) -> None:
            try:
                sentence = _get_sentence(result)
                if not isinstance(sentence, dict):
                    return
                if not _is_sentence_end(RecognitionResult, result, sentence):
                    return
                segs, wl = _segments_from_sentence(sentence)
                if wl:
                    word_level_flag[0] = True
                for seg in segs:
                    key = (seg["start"], seg["end"], seg["text"])
                    if key in seen:
                        continue
                    seen.add(key)
                    segments.append(seg)
                if segs:
                    _log("句子 [{:.2f}s-{:.2f}s] {} (词级={})".format(segs[0]["start"], segs[-1]["end"], segs[-1]["text"], wl))
            except Exception as e:  # noqa: BLE001  回调里绝不能抛出
                _log("on_event 处理异常: {}".format(e))

    kwargs = {
        "model": model,
        "format": "pcm",
        "sample_rate": _TARGET_RATE,
        "callback": _Callback(),
    }
    hints = _language_hints(lang, model)
    if hints:
        kwargs["language_hints"] = hints

    _log("启动识别: model={} lang={} hints={}".format(model, lang, hints))
    recognition = Recognition(**kwargs)
    recognition.start()

    # 推流节流：默认每帧间隔 10ms（约 10 倍速），可用环境变量覆盖为 0 全速推送
    try:
        frame_sleep = float(os.environ.get("AICUT_ASR_FRAME_SLEEP", "0.01"))
    except ValueError:
        frame_sleep = 0.01

    try:
        import time
        with wave.open(wav_path, "rb") as wf:
            n = 0
            while True:
                data = wf.readframes(_FRAME_SAMPLES)
                if not data:
                    break
                try:
                    recognition.send_audio_frame(data)
                except Exception as e:  # noqa: BLE001
                    _log("send_audio_frame 失败(会话可能已关闭): {}".format(e))
                    break  # 异常时退出循环，让 finally → stop() 触达 on_error/on_complete
                n += 1
                if frame_sleep > 0:
                    time.sleep(frame_sleep)
        _log("音频推送完毕，共 {} 帧".format(n))
        # 等 1 秒让服务端有时间处理最后一帧并触发 on_event → on_complete，
        # 避免 stop() 立刻打出 "Speech recognition has stopped."
        time.sleep(1.0)
    finally:
        try:
            recognition.stop()   # 阻塞直到 on_complete / on_error
        except Exception as e:  # noqa: BLE001
            _log("stop() 异常: {}".format(e))

    if not segments and errors:
        _log("流式识别无结果: {}".format("; ".join(errors)))
        return [], False  # 不抛异常，让 _recognize_file_fallback() 兜底
    return segments, word_level_flag[0]


def _recognize_file_fallback(wav_path: str, lang: str, model: str) -> list:
    """流式没拿到结果时的兜底：非流式 call(本地文件)。"""
    from http import HTTPStatus
    from dashscope.audio.asr import Recognition

    kwargs = {
        "model": model,
        "format": "wav",
        "sample_rate": _TARGET_RATE,
        "callback": None,
    }
    hints = _language_hints(lang, model)
    if hints:
        kwargs["language_hints"] = hints

    _log("流式无结果，回退非流式 call()")
    try:
        result = Recognition(**kwargs).call(wav_path)
    except Exception as e:
        _log("非流式 call 异常: {}".format(e))
        return []
    status = getattr(result, "status_code", None)
    if status is not None and status != HTTPStatus.OK:
        msg = getattr(result, "message", "") or getattr(result, "code", "") or ""
        _log("非流式识别失败({}): {}".format(status, str(msg)[:200]))
        return []

    sentences = _get_sentence(result) or []
    if isinstance(sentences, dict):
        sentences = [sentences]
    segments = []
    word_level = False
    for s in sentences:
        segs, wl = _segments_from_sentence(s)
        if wl:
            word_level = True
        segments.extend(segs)
    return segments, word_level


def _is_omni_model(model: str) -> bool:
    """千问3 实时 ASR（qwen3-asr-flash-realtime 及其日期快照）走 OmniRealtimeConversation
    WebSocket 对话式接口，而非 Paraformer 所用的 Recognition 流式接口——两者 SDK 完全不同。
    注意：qwen-audio-3.0-asr-flash-streaming 仍用 Recognition（与 Paraformer 同路径）。"""
    m = (model or "").lower()
    return m.startswith("qwen3-asr")


def _recognize_qwen_omni(wav_path: str, lang: str, model: str, api_key: str, endpoint: str) -> list:
    """千问3 实时语音识别（OmniRealtimeConversation）。

    说明：
    - 该接口按服务端 VAD 自动断句，每句以
      `conversation.item.input_audio_transcription.completed` 事件回传最终文本；
    - **没有原生时间戳**，这里用「已推送音频字节数」推算每句起止
      （16k/16bit = 32000 字节/秒），在 1x 推流下与真实断句边界一致，足够字幕使用；
      后续 resegmentForCaptions 还会按标点重切。
    - 标准实时接入点 wss://dashscope.aliyuncs.com/api-ws/v1/realtime 配合普通百炼 key 即可，
      不需要 MAAS 工作空间。
    """
    import base64
    import time as _time
    from dashscope.audio.qwen_omni import (
        OmniRealtimeConversation,
        OmniRealtimeCallback,
        MultiModality,
    )
    from dashscope.audio.qwen_omni.omni_realtime import TranscriptionParams

    # 语言：明确给 zh/en 等时才传，否则交模型自动判别（对混说更友好）
    lang_code = None
    lc = (lang or "").strip().lower().split("-")[0].split("_")[0]
    if lc in ("zh", "en", "ja", "ko", "yue", "de", "fr", "ru", "es", "pt", "it"):
        lang_code = lc

    # 读原始 PCM（去掉 wav 头，wave.readframes 直接给裸数据）
    with wave.open(wav_path, "rb") as wf:
        pcm = wf.readframes(wf.getnframes())
    # 末尾补 0.5s 静音：给 qwen3 实时流足够时间 flush 句尾短词（如「轻飘」），
    # 避免 VAD 提前定稿把末词截断（间歇性丢尾词的根因）。仅影响 qwen3 内部 VAD/flush，
    # 不会污染融合结果的时间（融合时间取自 Paraformer 词级）。
    pcm += b'\x00' * int(0.5 * 32000)
    total_bytes = len(pcm)
    duration = total_bytes / 32000.0  # 32000 字节/秒
    _log("Omni 输入 PCM: {} 字节, 时长≈{:.1f}s".format(total_bytes, duration))

    segments = []
    errors = []
    state = {"bytes_sent": 0, "last_end": 0.0}
    _event_types = {}

    # 调试日志：把收到的事件类型与转录内容写入临时文件，便于真机排查
    import datetime as _dt
    _dbg_path = os.path.join(tempfile.gettempdir(), "aicut_asr_debug.log")

    def _dbg(msg: str) -> None:
        _log(msg)
        try:
            with open(_dbg_path, "a", encoding="utf-8") as _df:
                _df.write(msg + "\n")
        except Exception:  # noqa: BLE001
            pass

    _dbg("===== {} qwen_omni model={} lang={} bytes={} dur={:.1f}s =====".format(
        _dt.datetime.now().isoformat(timespec="seconds"), model, lang_code, total_bytes, duration))

    class _Cb(OmniRealtimeCallback):
        def on_open(self):
            _dbg("Omni 连接已建立")

        def on_close(self, code, msg):
            _dbg("Omni 连接关闭 code={} msg={}".format(code, msg))

        def on_event(self, message):
            try:
                if not isinstance(message, dict):
                    return
                t = message.get("type")
                _event_types[t] = _event_types.get(t, 0) + 1
                _dbg("EVENT type={}".format(t))
                if t == "error":
                    err = message.get("error") or message
                    errors.append(str(err))
                    _dbg("Omni 错误: {}".format(err))
                    return
                # 输入音频转写完成事件（OpenAI realtime 规范命名，兼容日期快照变体）
                if t and "input_audio_transcription" in t and t.endswith("completed"):
                    text = (message.get("transcript") or "").strip()
                    if text:
                        self._emit_segment(text)
                    return
                # 兜底：任何带 transcript 字段、且非模型回复(response.*)的事件
                if isinstance(message.get("transcript"), str) and message["transcript"].strip():
                    if t and "response" not in t:
                        _dbg("FALLBACK transcript from type={}: {}".format(t, message["transcript"][:60]))
                        self._emit_segment(message["transcript"].strip())
            except Exception as e:  # noqa: BLE001  回调里绝不能抛出
                _dbg("Omni on_event 异常: {}".format(e))

        def _emit_segment(self, text):
            end = min(state["bytes_sent"] / 32000.0, duration)
            start = state["last_end"]
            if end <= start:
                end = min(start + 0.5, duration)
            segments.append({"start": round(start, 3), "end": round(end, 3), "text": text})
            state["last_end"] = end
            _dbg("Omni 句子 [{:.2f}s-{:.2f}s] {}".format(start, end, text))

    kwargs = {"model": model, "callback": _Cb(), "api_key": api_key}
    if endpoint:
        # 仅当显式给了实时 ws(s) 接入点才覆盖；普通百炼 key 用默认接入点即可
        if endpoint.startswith("ws://") or endpoint.startswith("wss://"):
            kwargs["url"] = endpoint
        else:
            _dbg("endpoint 非 ws(s) 形式，Omni 使用默认实时接入点")

    conv = OmniRealtimeConversation(**kwargs)
    try:
        conv.connect()
        conv.update_session(
            output_modalities=[MultiModality.TEXT],
            enable_input_audio_transcription=True,
            transcription_params=TranscriptionParams(
                language=lang_code, sample_rate=_TARGET_RATE, input_audio_format="pcm"
            ),
            enable_turn_detection=True,
        )

        # 1x 推流：每 0.1s 音频 sleep 0.1s，保证字节计数与时间对齐（可用
        # 环境变量 AICUT_ASR_FRAME_SLEEP 调快，但会牺牲时间戳精度）
        try:
            frame_sleep = float(os.environ.get("AICUT_ASR_FRAME_SLEEP", "0.1"))
        except ValueError:
            frame_sleep = 0.1
        chunk = _FRAME_BYTES  # 3200 字节 = 0.1s
        for i in range(0, total_bytes, chunk):
            data = pcm[i:i + chunk]
            if not data:
                break
            conv.append_audio(base64.b64encode(data).decode("ascii"))
            state["bytes_sent"] += len(data)
            if frame_sleep > 0:
                _time.sleep(frame_sleep)
        _dbg("Omni 音频推送完毕，共 {} 字节".format(state["bytes_sent"]))
        _time.sleep(2.0)  # 给服务端更充足时间 flush 最后一句（含可能的句尾短词）
        conv.end_session()  # 阻塞等待 session.finished
    finally:
        try:
            conv.close()
        except Exception:  # noqa: BLE001
            pass

    _dbg("Omni 结束：事件类型统计 = {}".format(dict(_event_types)))
    _dbg("Omni 结束：捕获句子数 = {}".format(len(segments)))

    if not segments and errors:
        raise RuntimeError("千问实时识别失败: " + "; ".join(errors))
    return segments


def _count_punct(text: str) -> int:
    return sum(1 for ch in text if _is_punct_char(ch))


def _recognize_qwen_omni_multi_pass(wav_path, lang, model, api_key, endpoint):
    """qwen3 实时流标点非确定（VAD 抖动）→ 多次调用取标点最完整者，稳定断句数。

    背景：字幕断句完全由 qwen3 返回文本的标点驱动（`_merge_clauses` 按 `q_text` 里的
    标点逐一切句）。qwen3 走 OmniRealtimeConversation 实时流式接口，服务端 VAD 自动断句
    + 标点后处理是**非确定**的——同一段音频有时标点齐全（→6 段短句）、有时标点丢失
    （→仅 2 段），造成「有时 2 段、有时 6 段」的抖动。多次调用取「标点数最多」的那次，
    把断句数稳定在接近「标点齐全」的上限。次数可用 `AICUT_ASR_QWEN_PASSES` 覆盖（默认 3，
    范围 1..5）。qwen3 只提供文本/标点，最终时间由 Paraformer 词级提供，故多次调用不影响
    时间精度，仅增加转写时延/调用量（早停可缓解）。
    """
    try:
        passes = int(os.environ.get("AICUT_ASR_QWEN_PASSES", "3"))
    except ValueError:
        passes = 3
    passes = max(1, min(passes, 5))
    best = []
    best_punct = -1
    used = 0
    for i in range(passes):
        used = i + 1
        try:
            segs = _recognize_qwen_omni(wav_path, lang, model, api_key, endpoint)
        except Exception as e:  # noqa: BLE001
            _log("qwen3 第 {} 次调用异常，跳过: {}".format(i + 1, e))
            continue
        if not segs:
            continue
        text = "".join((s.get("text") or "") for s in segs)
        punct = _count_punct(text)
        _log("qwen3 第 {} 次：{} 字 / {} 标点".format(i + 1, len(text), punct))
        if punct > best_punct:
            best_punct = punct
            best = segs
        # 早停：标点已足够细（≥5 个断句点，足以切出多段短句），不再多跑
        if punct >= 5:
            break
    if best:
        _log("qwen3 多次调用完成：取标点最多 {} 个（共跑 {} 次）".format(best_punct, used))
    return best


def main(argv) -> int:
    # 先把 stdout 指向 stderr，保证 SDK / 中间过程的任何打印都不会污染最终 JSON。
    real_stdout = sys.stdout
    sys.stdout = sys.stderr

    wav_path = None
    is_temp = False
    try:
        if len(argv) < 2 or not argv[1].strip():
            raise ValueError("usage: bridge.py <audio_path> <lang> <model> <api_key> <endpoint>")

        audio_path = argv[1].strip()
        lang = (argv[2].strip() if len(argv) > 2 else "") or "auto"
        model = _normalize_model(argv[3] if len(argv) > 3 else "")
        api_key = (argv[4].strip() if len(argv) > 4 else "")
        endpoint = (argv[5].strip() if len(argv) > 5 else "")

        if not os.path.isfile(audio_path):
            raise FileNotFoundError("音频文件不存在: " + audio_path)

        if not api_key:
            api_key = (os.environ.get("AICUT_ASR_API_KEY") or "").strip()
        if not api_key:
            raise ValueError("缺少百炼 API Key（命令行第 4 个参数或环境变量 AICUT_ASR_API_KEY）")

        # 必须在 import dashscope 之前注入环境变量
        os.environ["DASHSCOPE_API_KEY"] = api_key
        if endpoint:
            os.environ["DASHSCOPE_API_ENDPOINT"] = endpoint

        import dashscope
        dashscope.api_key = api_key
        if endpoint:
            if endpoint.startswith("ws://") or endpoint.startswith("wss://"):
                dashscope.base_websocket_api_url = endpoint
            elif endpoint.startswith("http://") or endpoint.startswith("https://"):
                dashscope.base_http_api_url = endpoint
            else:
                _log("无法识别的 endpoint 形式，仅写入环境变量: " + endpoint)

        wav_path, is_temp = _to_wav16k(audio_path)

        # ── 单路结果（按用户所选模型）──
        if _is_omni_model(model):
            # 千问3 实时 ASR：OmniRealtimeConversation WebSocket 对话式接口
            # 多次调用取标点最完整者（qwen3 流式标点非确定，单次可能只切出 2 段）
            single_segs = _recognize_qwen_omni_multi_pass(wav_path, lang, model, api_key, endpoint)
            single_wl = False
        else:
            # Paraformer / Qwen-Audio-3.0 等：Recognition 流式接口 + 非流式兜底
            single_segs, single_wl = _recognize(wav_path, lang, model)
            if not single_segs:
                single_segs, single_wl = _recognize_file_fallback(wav_path, lang, model)

        segments = single_segs
        word_level = single_wl
        pre_grouped = False

        # ── 双路融合：标点源(qwen3) + 词级时间源(Paraformer) → 剪映式短语 + 精确对齐 ──
        # 设环境变量 AICUT_ASR_NO_MERGE=1 可跳过（省一次 ASR 调用，但退化为单路粗时间/无标点）。
        do_merge = not os.environ.get("AICUT_ASR_NO_MERGE")
        if do_merge and single_segs:
            try:
                if _is_omni_model(model):
                    # 用户选 qwen3：qwen3 即标点源，Paraformer 补词级精确时间
                    time_segs, _ = _recognize(wav_path, lang, "paraformer-realtime-v2")
                    if not time_segs:
                        time_segs, _ = _recognize_file_fallback(wav_path, lang, "paraformer-realtime-v2")
                    merged = _merge_clauses(single_segs, time_segs)
                else:
                    # 用户选 Recognition 模型：它作时间源，qwen3 补标点（同样多次调用取标点最完整者）
                    punct_segs = _recognize_qwen_omni_multi_pass(wav_path, lang, "qwen3-asr-flash-realtime", api_key, endpoint)
                    merged = _merge_clauses(punct_segs, single_segs)
                if merged:
                    segments = merged
                    word_level = False
                    pre_grouped = True
                    _log("双路融合成功：{} 条剪映式短句（精确对齐）".format(len(merged)))
                else:
                    _log("双路融合未产出有效结果，回退单路")
            except Exception as e:  # noqa: BLE001
                _log("双路融合异常，回退单路: {}".format(e))

        segments.sort(key=lambda s: s["start"])
        payload = {
            "success": True,
            "data": {
                "text": _join_text(segments),
                "segments": segments,
                "word_level": word_level,
                "pre_grouped": pre_grouped,
            },
        }
    except Exception as e:  # noqa: BLE001  任何异常都转成失败 JSON
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.stdout = real_stdout
        _emit({"success": False, "error": str(e) or e.__class__.__name__}, real_stdout)
        return 1
    finally:
        sys.stdout = real_stdout
        if is_temp and wav_path:
            try:
                os.remove(wav_path)
            except OSError:
                pass

    _emit(payload, real_stdout)
    return 0


if __name__ == "__main__":
    _load_dotenv()  # 让 .env 里的 AICUT_ASR_API_KEY 自动生效（直跑桥也能读）
    sys.exit(main(sys.argv))
