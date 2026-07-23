"""验证火山引擎 TTS Access Token 是否有效"""
import json
import uuid
import base64
import urllib.request
import urllib.error
import sys
import os

# 火山引擎 TTS 配置
URL = "https://openspeech.bytedance.com/api/v1/tts"
APPID = "REDACTED"
TOKEN = "REDACTED"

# 尝试多种 voice_type，确认哪个可用
VOICES = [
    "BV001_streaming",   # 通用男声
    "BV002_streaming",   # 通用女声
    "BV700_streaming",   # 女声
    "BV701_streaming",   # 男声
]


def test_tts(voice_type: str, text: str = "你好，这是AIcut的语音合成测试。"):
    headers = {
        "Authorization": f"Bearer;{TOKEN}",
        "Content-Type": "application/json",
    }
    body = {
        "app": {
            "appid": APPID,
            "token": TOKEN,
            "cluster": "volcano_tts",
        },
        "user": {"uid": "aicut_test"},
        "audio": {
            "voice_type": voice_type,
            "encoding": "mp3",
            "speed_ratio": 1.0,
            "volume_ratio": 1.0,
            "pitch_ratio": 1.0,
        },
        "request": {
            "reqid": str(uuid.uuid4()),
            "text": text,
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
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8")
            data = json.loads(raw)
            code = data.get("code")
            msg = data.get("message", "")
            # 火山引擎成功时 code=3000
            if code == 3000 and data.get("data"):
                audio = base64.b64decode(data["data"])
                out_path = f"test_tts_{voice_type}.mp3"
                with open(out_path, "wb") as f:
                    f.write(audio)
                return True, f"成功 code={code} voice={voice_type} 音频={len(audio)}字节 已保存{out_path}"
            else:
                return False, f"失败 code={code} msg={msg} voice={voice_type} 原始={raw[:200]}"
    except urllib.error.HTTPError as e:
        body_text = ""
        try:
            body_text = e.read().decode("utf-8", errors="replace")[:200]
        except Exception:
            pass
        return False, f"HTTPError {e.code} voice={voice_type} body={body_text}"
    except urllib.error.URLError as e:
        return False, f"URLError voice={voice_type} reason={e.reason}"
    except Exception as e:
        return False, f"Exception voice={voice_type} {type(e).__name__}: {e}"


def main():
    print(f"AppID: {APPID}")
    print(f"Token: {TOKEN[:6]}...{TOKEN[-4:]}")
    print(f"URL: {URL}")
    print("-" * 60)

    # 先测连通性
    print("测试网络连通性...")
    try:
        req = urllib.request.Request(URL, method="HEAD")
        urllib.request.urlopen(req, timeout=10)
        print("网络连通: OK")
    except urllib.error.HTTPError as e:
        print(f"网络连通: HTTP {e.code} (正常，TTS需POST)")
    except Exception as e:
        print(f"网络连通异常: {e}")
        print("尝试设置代理 127.0.0.1:10809 ...")
        proxy = urllib.request.ProxyHandler({
            "http": "http://127.0.0.1:10809",
            "https": "http://127.0.0.1:10809",
        })
        opener = urllib.request.build_opener(proxy)
        urllib.request.install_opener(opener)
        print("代理已设置")

    print("-" * 60)
    print("开始测试 TTS 调用...")
    print()

    success_count = 0
    working_voices = []
    for voice in VOICES:
        ok, info = test_tts(voice)
        status = "✓" if ok else "✗"
        print(f"{status} {info}")
        if ok:
            success_count += 1
            working_voices.append(voice)

    print("-" * 60)
    print(f"结果: {success_count}/{len(VOICES)} 个音色可用")
    if working_voices:
        print(f"可用音色: {', '.join(working_voices)}")
        print("\n结论: Token 有效，可正常调用火山引擎 TTS")
    else:
        print("\n结论: 全部失败，Token 可能无效或服务未开通")
        sys.exit(1)


if __name__ == "__main__":
    main()
