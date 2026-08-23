"""测试不同 cluster，确认 AppID 开通了哪个 TTS 产品"""
import json
import os
import uuid
import urllib.request
import urllib.error

URL = "https://openspeech.bytedance.com/api/v1/tts"
APPID = os.environ.get("VOLCANO_TTS_APPID", "")
TOKEN = os.environ.get("VOLCANO_TTS_TOKEN", "")

# 火山引擎可能的 cluster 值
CLUSTERS = [
    "volcano_tts",       # 通用语音合成
    "volcano_mega",      # 大模型语音合成
    "volcano_icl",       # 语音克隆
    "volcano_tts_open",  # 开放版
    "volcano_open",      # 开放版2
]

# 不同 cluster 可能对应的 voice_type
VOICE_MAP = {
    "volcano_tts": "BV001_streaming",
    "volcano_mega": "BV001_streaming",
    "volcano_icl": "BV001_streaming",
    "volcano_tts_open": "BV001_streaming",
    "volcano_open": "BV001_streaming",
}


def test(cluster: str):
    headers = {
        "Authorization": f"Bearer;{TOKEN}",
        "Content-Type": "application/json",
    }
    body = {
        "app": {
            "appid": APPID,
            "token": TOKEN,
            "cluster": cluster,
        },
        "user": {"uid": "aicut_test"},
        "audio": {
            "voice_type": VOICE_MAP.get(cluster, "BV001_streaming"),
            "encoding": "mp3",
            "speed_ratio": 1.0,
            "volume_ratio": 1.0,
            "pitch_ratio": 1.0,
        },
        "request": {
            "reqid": str(uuid.uuid4()),
            "text": "测试",
            "text_type": "plain",
            "operation": "query",
        },
    }
    req = urllib.request.Request(
        URL,
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("code"), data.get("message", ""), data.get("data") is not None
    except urllib.error.HTTPError as e:
        try:
            body_text = e.read().decode("utf-8", errors="replace")
            data = json.loads(body_text)
            return data.get("code"), data.get("message", ""), False
        except Exception:
            return f"HTTP{e.code}", str(e), False
    except Exception as e:
        return "ERR", str(e), False


print(f"测试不同 cluster，AppID={APPID}")
print("-" * 70)
for c in CLUSTERS:
    code, msg, has_audio = test(c)
    status = "✓ 成功" if code == 3000 else "✗"
    print(f"{status} cluster={c:20s} code={code} msg={msg[:80]}")
    if has_audio:
        print(f"   >>> 有音频数据！这个 cluster 可用")
        break
