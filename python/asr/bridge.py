# -*- coding: utf-8 -*-
"""
bridge.py — AIcut「AI 自动字幕」百炼（DashScope / Paraformer）ASR Python 桥。

供 Rust 引擎 `BailianAsrProvider` 以子进程方式调用。

用法（argv 顺序固定）：
    python bridge.py <audio_path> <lang> <model> <api_key> <endpoint>

    argv[1] audio_path : 本地音视频文件路径（任意 ffmpeg 可解码格式）
    argv[2] lang       : 语言，如 zh / en / auto（auto 表示让模型自动判别）
    argv[3] model      : 模型名，缺省 paraformer-v1（会自动映射到实时模型）
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

# 每帧 100ms：16000Hz * 0.1s = 1600 采样点，16bit 单声道 = 3200 字节
_FRAME_SAMPLES = 1600
_FRAME_BYTES = _FRAME_SAMPLES * 2
_TARGET_RATE = 16000

_DEFAULT_MODEL = "paraformer-v1"

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


def _join_text(segments: list) -> str:
    """中文按空串拼接，其它语言用空格分隔。"""
    parts = [s["text"] for s in segments]
    joined = "".join(parts)
    has_cjk = any("\u4e00" <= ch <= "\u9fff" for ch in joined)
    return joined if has_cjk else " ".join(parts)


# ───────────────────────── 识别主流程 ─────────────────────────

def _normalize_model(model: str) -> str:
    m = (model or "").strip() or _DEFAULT_MODEL
    mapped = _MODEL_ALIAS.get(m.lower())
    if mapped:
        _log("模型 {} 非实时识别模型，映射为 {}".format(m, mapped))
        return mapped
    return m


def _language_hints(lang: str, model: str):
    """language_hints 仅 v2 及以上多语言模型生效；auto 时不传由模型自动判别。"""
    code = (lang or "").strip().lower()
    if not code or code in ("auto", "automatic"):
        return None
    code = code.split("-")[0].split("_")[0]
    if code not in _LANG_CODES:
        _log("未识别的语言码 {}，忽略 language_hints".format(lang))
        return None
    low = model.lower()
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

    class _Callback(RecognitionCallback):
        def on_open(self) -> None:
            _log("识别连接已建立")

        def on_close(self) -> None:
            _log("识别连接已关闭")

        def on_complete(self) -> None:
            _log("识别完成")

        def on_error(self, result) -> None:
            msg = getattr(result, "message", None) or str(result)
            errors.append(str(msg))
            _log("识别错误: {}".format(msg))

        def on_event(self, result) -> None:
            try:
                sentence = _get_sentence(result)
                if not isinstance(sentence, dict):
                    return
                if not _is_sentence_end(RecognitionResult, result, sentence):
                    return
                seg = _to_segment(sentence)
                if seg is None:
                    return
                key = (seg["start"], seg["end"], seg["text"])
                if key in seen:
                    return
                seen.add(key)
                segments.append(seg)
                _log("句子 [{:.2f}s-{:.2f}s] {}".format(seg["start"], seg["end"], seg["text"]))
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
                recognition.send_audio_frame(data)
                n += 1
                if frame_sleep > 0:
                    time.sleep(frame_sleep)
        _log("音频推送完毕，共 {} 帧".format(n))
    finally:
        try:
            recognition.stop()   # 阻塞直到 on_complete / on_error
        except Exception as e:  # noqa: BLE001
            _log("stop() 异常: {}".format(e))

    if not segments and errors:
        raise RuntimeError("百炼识别失败: " + "; ".join(errors))
    return segments


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
    result = Recognition(**kwargs).call(wav_path)
    status = getattr(result, "status_code", None)
    if status is not None and status != HTTPStatus.OK:
        raise RuntimeError("百炼识别失败({}): {}".format(status, getattr(result, "message", "")))

    sentences = _get_sentence(result) or []
    if isinstance(sentences, dict):
        sentences = [sentences]
    segments = []
    for s in sentences:
        seg = _to_segment(s)
        if seg is not None:
            segments.append(seg)
    return segments


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

        segments = _recognize(wav_path, lang, model)
        if not segments:
            segments = _recognize_file_fallback(wav_path, lang, model)

        segments.sort(key=lambda s: s["start"])
        payload = {
            "success": True,
            "data": {"text": _join_text(segments), "segments": segments},
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
