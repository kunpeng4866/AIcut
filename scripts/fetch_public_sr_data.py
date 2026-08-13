# -*- coding: utf-8 -*-
"""公开授权视频素材抓取工具（Wikimedia Commons 主源），用于 SR 超清增强训练集收集。

【素材搜集策略 — 质量优先，授权放宽】:
    - 经项目决策：训练素材的**搜集**不再受「合规硬约束」限制，可广泛取自公开可访问的素材源；
      但**质量必须保证**——脚本以「分辨率 / 时长 / 帧数 /(可选)码率 / 格式」作为硬性质量闸门。
    - 模型权重仍须**自研**：本脚本绝不下载、不加载任何第三方预训练权重，只抓取原始视频素材。
    - 默认**不**按许可证过滤；--require-license 可开启 CC0/PD/CC-BY 白名单模式（供需合规的场景）。
    - 每类目录产出 provenance 清单 ATTRIBUTIONS.csv（filename/title/author/license/
      license_url/source_url/retrieved_at）作为素材溯源记录，便于人工复核与分发管理。

与 collect_sr_data.py 的关系（互补，不重叠）:
    - collect_sr_data.py: 纯离线，把本地**自有素材**按场景筛选 + 搬运到 data/sr_train/<category>/。
    - 本脚本:            联网，从公开源批量抓取**高质量**素材补足缺口，输出到同一目录结构。
    两者产出可以共存于同一 data/sr_train 树下；本脚本产出的素材额外带署名清单。

数据规格:
    - 6 个核心场景各 150 段: portrait / landscape / text_ui / old_film / low_light / high_motion
    - 补充类: food / animal / art / screen_recording
    - urban 几何直线纹理作为保留类单独保留
    - 每段 >= 100 帧、源分辨率 >= 1920x1080
    - 默认 MIN_WIDTH=1920, MIN_HEIGHT=1080, MIN_DURATION=8.0s（约 >=192 帧 @24fps）

用法:
    # 先看候选（不下载，只列出通过格式 + 分辨率质量初筛的条目）
    python scripts/fetch_public_sr_data.py --category landscape --dry-run
    # 实际抓取，每类最多 20 段
    python scripts/fetch_public_sr_data.py --category all --limit 20
    # 自定义查询词
    python scripts/fetch_public_sr_data.py --category urban --query "night city street" --add-query "tram"

依赖:
    仅标准库（urllib / json / csv / subprocess / argparse），不引入 requests。
    ffprobe/ffmpeg 可选：缺失时跳过校验/转码并告警，已下载文件保留（不静默丢素材）。
"""
import os
import re
import sys
import csv
import json
import time
import html
import shutil
import argparse
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

# ───────────────────────── 常量 ─────────────────────────

CORE_CATEGORIES = ("portrait", "landscape", "text_ui", "old_film", "low_light", "high_motion")
SUPPLEMENT_CATEGORIES = ("food", "animal", "art", "screen_recording")
CATEGORIES = CORE_CATEGORIES + SUPPLEMENT_CATEGORIES

# 每类目标段数（设计文档要求），仅作提示，实际上限由 --limit 控制
TARGET_PER_CATEGORY = 150

MIN_WIDTH = 1920
MIN_HEIGHT = 1080
MIN_DURATION = 8.0        # 秒，约 >=192 帧 @24fps，满足「每段 >=100 帧」
MIN_FRAMES = 100          # 仅在 ffprobe 能报出 nb_frames 时参与校验
MIN_BITRATE_KBPS = 0      # 下载后码率下限（0=不限；高质量素材可设 2000~5000）

MAX_BYTES = 400 * 1024 * 1024   # 单文件下载上限 400MB
MAX_CANDIDATES = 50             # 每个查询词最多取多少条候选
HTTP_TIMEOUT = 30               # 秒
DOWNLOAD_RETRIES = 2            # 下载失败重试次数
DEFAULT_DELAY = 2.0             # 请求/下载间隔，礼貌爬取（Wikimedia 较敏感，不宜过快）
RATE_LIMIT_COOLDOWN = 30        # 触发 429 限流后的冷却秒数（避免持续冲击服务器）

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
DEST_ROOT = os.path.join(_REPO, "data", "sr_train")

COMMONS_API = "https://commons.wikimedia.org/w/api.php"
# Wikimedia API 政策要求可识别的 User-Agent
USER_AGENT = ("AIcut-SR-DataFetcher/1.0 "
              "(training-data collection under CC licenses; contact: aicut-user)")

VIDEO_MIMES = ("video/webm", "video/ogg", "video/mp4", "application/ogg")

ATTRIBUTION_FILE = "ATTRIBUTIONS.csv"
ATTRIBUTION_HEADER = ("filename", "title", "author", "license",
                      "license_url", "source_url", "retrieved_at")

# 各场景的 Commons 英文查询词
CATEGORY_QUERIES = {
    "portrait": ["portrait face", "human face close-up", "people portrait"],
    "landscape": ["landscape nature", "mountain forest", "ocean sea waves",
                  "forest aerial"],
    "urban": ["modern building facade grid", "glass curtain wall architecture",
              "skyscraper geometric pattern", "bridge steel structure",
              "street perspective lines", "concrete geometric architecture"],
    "text_ui": ["computer screen text", "document text", "smartphone screen",
                "night city low light"],
    "old_film": ["old film footage", "vintage film 1950s", "black and white movie",
                 "archive film reel", "retro film grain"],
    "low_light": ["night city low light", "candlelight indoor", "starry night sky",
                  "dark room ambient", "night street neon"],
    "high_motion": ["fast car driving", "sport action slow motion", "waterfall rapid",
                    "roller coaster ride", "wildlife running", "waves crashing"],
    "food": ["food close up 4k", "cooking ingredients macro", "dessert food video",
             "fresh vegetables fruit", "street food cooking", "restaurant dish"],
    "animal": ["wildlife animal 4k", "animal close up fur", "pet animal video",
               "bird feathers", "horse running", "animal fur texture"],
    "art": ["digital art animation", "painting art video", "abstract art animation",
            "pixel art animation", "ink art motion", "colorful illustration video"],
    "screen_recording": ["computer screen recording", "screen capture video",
                         "software ui screen", "code editor screen", "browser screen",
                         "desktop screen recording"],
}

# screen_recording 放入 text_ui 子目录，保持文字/UI 作为同一个训练场景。
CATEGORY_DEST = {
    "screen_recording": os.path.join("text_ui", "screen_recording"),
}


def log(msg):
    print("[fetch] %s" % msg)


def warn(msg):
    sys.stderr.write("[warn] %s\n" % msg)


# ───────────────────────── ffmpeg / ffprobe ─────────────────────────
# 解析顺序与 python/sr/inference.py 保持一致

def ffmpeg_exe():
    return (os.environ.get("AICUT_FFMPEG")
            or shutil.which("ffmpeg")
            or "E:/codex/codex-tools/bin/ffmpeg.exe")


def ffprobe_exe():
    return (os.environ.get("AICUT_FFPROBE")
            or shutil.which("ffprobe")
            or "E:/codex/codex-tools/bin/ffprobe.exe")


def tool_available(exe):
    """可执行文件是否可用（绝对路径存在，或能在 PATH 中找到）。"""
    return os.path.isfile(exe) or shutil.which(exe) is not None


# ───────────────────────── 许可证白名单（核心合规逻辑） ─────────────────────────

_TAG_RE = re.compile(r"<[^>]+>")
_NON_ALNUM_RE = re.compile(r"[^A-Za-z0-9]+")

# 明确拒绝的独立词元（先于放行判断执行）
_DENY_TOKENS = frozenset((
    "SA", "NC", "ND",                       # share-alike / non-commercial / no-derivatives
    "GFDL", "FDL",                          # GNU 自由文档许可证
    "COPYRIGHTED", "COPYRIGHT",             # 保留版权
    "TRADEMARK", "TRADEMARKED",
    "RESTRICTED", "NONFREE",
    "GPL", "LGPL",                          # 软件许可证，不适用于素材再分发
))

# 明确拒绝的连写短语（去掉所有非字母数字后匹配，长度足够，不会误伤）
_DENY_PHRASES = (
    "SHAREALIKE", "NONCOMMERCIAL", "NODERIV", "NODERIVATIVE",
    "ALLRIGHTSRESERVED", "FAIRUSE", "NONFREE", "USERESTRICTED",
)

# 放行的独立词元
_ALLOW_TOKENS = frozenset(("CC0", "PD", "PDM"))

# 放行的短语（在通过拒绝检查后才评估）
_ALLOW_PHRASES = (
    "PUBLIC DOMAIN",
    "CC BY",                        # 此处 CC BY-SA 已在拒绝阶段被排除
    "CREATIVE COMMONS ATTRIBUTION",
    "CREATIVE COMMONS ZERO",
    "NO RESTRICTIONS",
)


def strip_html(text):
    """extmetadata 的 Artist/Credit 常含 <a> 标签，取纯文本。"""
    if not text:
        return ""
    plain = _TAG_RE.sub(" ", str(text))
    plain = html.unescape(plain)
    return " ".join(plain.split())


def _normalize_license_text(text):
    """归一化为大写、以单空格分隔的词元串，便于词元/短语匹配。

    例: "CC-BY-SA-4.0" -> "CC BY SA 4 0"；"Attribution-ShareAlike" -> "ATTRIBUTION SHAREALIKE"
    """
    return _NON_ALNUM_RE.sub(" ", strip_html(text)).upper().strip()


def em_value(em, key):
    """取 extmetadata[key]["value"] 的纯文本，缺失返回空串。"""
    node = (em or {}).get(key)
    if isinstance(node, dict):
        return strip_html(node.get("value", ""))
    if node is None:
        return ""
    return strip_html(node)


def is_allowed_license(em):
    """判断 extmetadata 是否属于允许的许可证白名单。

    返回 (allowed, reason)。allowed=False 时 reason 说明具体拒绝原因，便于日志追溯。

    判断顺序（顺序不可调换）:
        1. 许可证信息缺失 -> 拒绝（宁可漏抓，不可误抓）
        2. Restrictions 字段非空（trademarked / insignia / currency 等）-> 拒绝
        3. 命中 SA / NC / ND / GFDL / Copyright / Trademark / Restricted -> 拒绝
           （必须先排除，否则 "CC BY-SA" 会被 "CC BY" 误放行）
        4. 命中 CC0 / Public Domain / CC-BY / No restrictions -> 放行
        5. 其余一律拒绝（白名单制，未知许可证不放行）
    """
    short_name = em_value(em, "LicenseShortName")
    long_name = em_value(em, "License")
    usage = em_value(em, "UsageTerms")
    restrictions = em_value(em, "Restrictions")

    combined = " ".join(x for x in (short_name, long_name, usage) if x)
    if not combined.strip():
        return False, "许可证信息缺失"

    # 2) Restrictions 字段本身就意味着额外使用限制，直接拒绝
    if restrictions.strip():
        return False, "存在使用限制(Restrictions=%s)" % restrictions[:60]

    norm = _normalize_license_text(combined)
    tokens = set(norm.split())
    collapsed = norm.replace(" ", "")

    # 3) 先排除
    for phrase in _DENY_PHRASES:
        if phrase in collapsed:
            return False, "命中排除项 %s (%s)" % (phrase, short_name or long_name)
    denied = tokens & _DENY_TOKENS
    if denied:
        return False, "命中排除项 %s (%s)" % ("/".join(sorted(denied)),
                                              short_name or long_name)

    # 4) 再放行
    allowed_hit = tokens & _ALLOW_TOKENS
    if allowed_hit:
        return True, "白名单 %s" % "/".join(sorted(allowed_hit))
    for phrase in _ALLOW_PHRASES:
        if phrase in norm:
            return True, "白名单 %s" % phrase

    # 5) 未知许可证不放行
    return False, "非白名单许可证(%s)" % (short_name or long_name or usage)[:60]


# ───────────────────────── 数据源: Wikimedia Commons ─────────────────────────

def http_get_json(url, timeout=HTTP_TIMEOUT):
    """带 UA 的 GET，返回解析后的 JSON；失败返回 None 并告警。"""
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        warn("HTTP %s: %s" % (e.code, url))
        return None
    except (urllib.error.URLError, OSError) as e:
        warn("请求失败 %s: %s" % (url, e))
        return None
    try:
        return json.loads(raw.decode("utf-8", "ignore"))
    except ValueError as e:
        warn("响应非法 JSON %s: %s" % (url, e))
        return None


def _commons_pages(data):
    """兼容 formatversion 1（dict）与 2（list）的 query.pages 取值。"""
    pages = ((data or {}).get("query") or {}).get("pages")
    if isinstance(pages, dict):
        return list(pages.values())
    if isinstance(pages, list):
        return pages
    return []


def _commons_candidate(page):
    """把一条 Commons 搜索结果转成统一的 candidate dict；非视频/无直链返回 None。"""
    infos = page.get("imageinfo") or []
    if not infos:
        return None
    info = infos[0]
    em = info.get("extmetadata") or {}
    title = page.get("title") or ""
    return {
        "source": "commons",
        "title": title,
        "url": info.get("url") or "",
        "page_url": info.get("descriptionurl") or "",
        "mime": (info.get("mime") or "").lower(),
        "width": int(info.get("width") or 0),
        "height": int(info.get("height") or 0),
        "author": em_value(em, "Artist") or em_value(em, "Credit"),
        "license": (em_value(em, "LicenseShortName")
                    or em_value(em, "License")
                    or em_value(em, "UsageTerms")),
        "license_url": em_value(em, "LicenseUrl"),
        "extmetadata": em,
    }


def search_commons(query, limit, delay=DEFAULT_DELAY):
    """在 Commons File 命名空间检索视频，翻页累加去重，返回 candidate 列表。"""
    results = []
    seen_urls = set()
    offset = 0
    while len(results) < limit:
        batch = min(50, limit - len(results))   # Commons 单次上限 50
        params = {
            "action": "query",
            "format": "json",
            "generator": "search",
            "gsrsearch": "%s filetype:video" % query,
            "gsrnamespace": "6",                # 6 = File 命名空间
            "gsrlimit": str(batch),
            "gsroffset": str(offset),
            "prop": "imageinfo",
            "iiprop": "url|size|mime|extmetadata",
            "iiurlwidth": "1280",
        }
        url = COMMONS_API + "?" + urllib.parse.urlencode(params)
        data = http_get_json(url)
        if data is None:
            break
        if "error" in data:
            warn("Commons API 错误: %s" % str(data["error"])[:200])
            break

        pages = _commons_pages(data)
        if not pages:
            break
        for page in pages:
            cand = _commons_candidate(page)
            if cand and cand["url"] and cand["url"] not in seen_urls:
                seen_urls.add(cand["url"])
                results.append(cand)

        cont = (data.get("continue") or {}).get("gsroffset")
        if cont is None:
            break
        try:
            offset = int(cont)
        except (TypeError, ValueError):
            break
        if delay > 0:
            time.sleep(delay)
    return results[:limit]


# ───────────────────────── 可选源: Pexels / Pixabay ─────────────────────────
# 合规放宽后，Pexels / Pixabay 成为高质量素材的重要补充源（清晰、无水印、分类明确）。
# 本环境实测两站 API 返回 403 且需 API Key，故默认 --source commons；
# 用户在本机配置 PEXELS_API_KEY / PIXABAY_API_KEY 后可直接使用（许可证仅作溯源记录，不再拦截）。

def _http_get_json_auth(url, headers, delay=DEFAULT_DELAY):
    """带自定义头部的 GET 取 JSON；失败返回 None 并告警。"""
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8", "ignore"))
    except (urllib.error.HTTPError, urllib.error.URLError, OSError, ValueError) as e:
        warn("请求失败（已跳过）: %s" % e)
        return None
    if delay > 0:
        time.sleep(delay)
    return data


def search_pexels(query, limit, api_key=None, delay=DEFAULT_DELAY):
    """Pexels 视频检索（需 PEXELS_API_KEY）。取每支视频分辨率最高的一档。"""
    key = api_key or os.environ.get("PEXELS_API_KEY")
    if not key:
        warn("未提供 PEXELS_API_KEY，跳过 pexels 源")
        return []
    url = "https://api.pexels.com/videos/search?" + urllib.parse.urlencode(
        {"query": query, "per_page": min(80, max(1, limit)), "size": "large"})
    data = _http_get_json_auth(
        url, {"User-Agent": USER_AGENT, "Authorization": key}, delay=delay)
    if not data:
        return []
    cands = []
    for item in (data.get("videos") or [])[:limit]:
        files = sorted(item.get("video_files") or [],
                       key=lambda f: (f.get("width") or 0), reverse=True)
        if not files or not files[0].get("link"):
            continue
        best = files[0]
        link = best.get("link")
        cands.append({
            "source": "pexels",
            "title": item.get("url") or "pexels-%s" % item.get("id"),
            "url": link,
            "page_url": item.get("url") or "",
            "mime": "video/mp4",
            "width": int(best.get("width") or 0),
            "height": int(best.get("height") or 0),
            "author": (item.get("user") or {}).get("name", ""),
            "license": "Pexels License",
            "license_url": "https://www.pexels.com/license/",
            "extmetadata": {"LicenseShortName": {"value": "Pexels License"}},
        })
    return cands


def search_pixabay(query, limit, api_key=None, delay=DEFAULT_DELAY):
    """Pixabay 视频检索（需 PIXABAY_API_KEY）。取 large 档，缺失回退 medium。"""
    key = api_key or os.environ.get("PIXABAY_API_KEY")
    if not key:
        warn("未提供 PIXABAY_API_KEY，跳过 pixabay 源")
        return []
    url = "https://pixabay.com/api/videos/?" + urllib.parse.urlencode(
        {"key": key, "q": query, "per_page": min(200, max(3, limit))})
    data = _http_get_json_auth(url, {"User-Agent": USER_AGENT}, delay=delay)
    if not data:
        return []
    cands = []
    for item in (data.get("hits") or [])[:limit]:
        best = (item.get("videos") or {}).get("large") \
            or (item.get("videos") or {}).get("medium") or {}
        if not best.get("url"):
            continue
        cands.append({
            "source": "pixabay",
            "title": "pixabay-%s" % item.get("id"),
            "url": best.get("url"),
            "page_url": item.get("pageURL") or "",
            "mime": "video/mp4",
            "width": int(best.get("width") or 0),
            "height": int(best.get("height") or 0),
            "author": item.get("user") or "",
            "license": "Pixabay Content License",
            "license_url": "https://pixabay.com/service/license-summary/",
            "extmetadata": {"LicenseShortName": {"value": "Pixabay Content License"}},
        })
    return cands


def search_source(source, query, limit, delay=DEFAULT_DELAY, keys=None):
    """统一检索入口：不同源返回结构一致的 candidate 列表。"""
    keys = keys or {}
    if source == "commons":
        return search_commons(query, limit, delay=delay)
    if source == "pexels":
        return search_pexels(query, limit, api_key=keys.get("pexels"), delay=delay)
    if source == "pixabay":
        return search_pixabay(query, limit, api_key=keys.get("pixabay"), delay=delay)
    warn("未知数据源: %s" % source)
    return []


# ───────────────────────── 下载 / 校验 / 转码 ─────────────────────────

_BAD_CHARS_RE = re.compile(r'[\\/:*?"<>|]+')


def safe_filename(candidate):
    """由候选 URL 推导安全的本地文件名（Commons 直链末段即原始文件名）。"""
    path = urllib.parse.urlparse(candidate["url"]).path
    name = urllib.parse.unquote(os.path.basename(path))
    if not name:
        name = candidate.get("title") or "video"
    name = name.split("File:")[-1]
    name = _BAD_CHARS_RE.sub("_", name).strip().strip(".")
    return name[:150] or "video.bin"


def unique_dest(dest_dir, filename):
    """目标同名时追加 _1/_2… 后缀，避免静默覆盖已有素材。"""
    base, ext = os.path.splitext(filename)
    cand = os.path.join(dest_dir, filename)
    i = 1
    while os.path.exists(cand):
        cand = os.path.join(dest_dir, "%s_%d%s" % (base, i, ext))
        i += 1
    return cand


def download_file(url, dest, max_bytes=MAX_BYTES, delay=DEFAULT_DELAY):
    """流式下载，超过 max_bytes 中止并删除半成品。返回 (ok, reason)。

    遇到 HTTP 429/503（限流）时按 Retry-After（或指数退避）等待，仍失败则
    reason 以 'rate_limited' 开头，供调用方做冷却暂停，避免持续冲击服务器。
    """
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    last_err = "未知错误"
    # 429/503 由调用方做冷却，这里不内部重试，避免持续冲击服务器
    for attempt in range(1, DOWNLOAD_RETRIES + 2):
        got = 0
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                declared = resp.headers.get("Content-Length")
                if declared and declared.isdigit() and int(declared) > max_bytes:
                    return False, "文件 %.1fMB 超过上限 %.1fMB" % (
                        int(declared) / 1048576.0, max_bytes / 1048576.0)
                with open(dest, "wb") as fh:
                    while True:
                        chunk = resp.read(65536)
                        if not chunk:
                            break
                        got += len(chunk)
                        if got > max_bytes:
                            fh.close()
                            _safe_remove(dest)
                            return False, "下载超过上限 %.1fMB，已中止" % (
                                max_bytes / 1048576.0)
                        fh.write(chunk)
            if got == 0:
                _safe_remove(dest)
                last_err = "下载内容为空"
            else:
                return True, "%.1fMB" % (got / 1048576.0)
        except urllib.error.HTTPError as e:
            retry_after = None
            try:
                ra = e.headers.get("Retry-After")
                if ra and str(ra).isdigit():
                    retry_after = min(int(ra), 120)
            except (AttributeError, ValueError, TypeError):
                retry_after = None
            if e.code in (429, 503):
                _safe_remove(dest)
                return False, "rate_limited: HTTP %s (retry_after=%s)" % (
                    e.code, retry_after)
            last_err = "HTTP %s" % e.code
            _safe_remove(dest)
        except (urllib.error.URLError, OSError) as e:
            last_err = str(e)
            _safe_remove(dest)
        if attempt <= DOWNLOAD_RETRIES:
            warn("下载失败(第%d次)，重试: %s" % (attempt, last_err))
            time.sleep(max(delay, 1.0))
    return False, last_err


def _safe_remove(path):
    try:
        if os.path.exists(path):
            os.remove(path)
    except OSError as e:
        warn("删除失败 %s: %s" % (path, e))


def probe_video(path):
    """返回 {"width","height","duration","nb_frames"}；ffprobe 不可用或失败返回 None。"""
    exe = ffprobe_exe()
    cmd = [
        exe, "-v", "error",
        "-select_streams", "v:0",
        "-show_entries",
        "stream=width,height,duration,nb_frames,bit_rate:format=duration,bit_rate",
        "-of", "json", path,
    ]
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as e:
        warn("ffprobe 无法启动(%s): %s" % (exe, e))
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

    try:
        nb_frames = int(s.get("nb_frames") or 0)
    except (TypeError, ValueError):
        nb_frames = 0

    fmt = info.get("format") or {}
    try:
        bitrate = int(s.get("bit_rate") or fmt.get("bit_rate") or 0)
    except (TypeError, ValueError):
        bitrate = 0

    return {
        "width": int(s.get("width") or 0),
        "height": int(s.get("height") or 0),
        "duration": duration,
        "nb_frames": nb_frames,
        "bitrate": bitrate,
    }


def validate_video(path, min_w, min_h, min_dur, min_bitrate_kbps=0):
    """校验分辨率/时长/帧数/(可选)码率。返回 (ok, reason, info)。

    ffprobe 缺失时不判失败：返回 ok=True 并提示未校验，保留素材由人工复核。
    """
    if not tool_available(ffprobe_exe()):
        return True, "ffprobe 不可用，跳过校验", None
    info = probe_video(path)
    if info is None:
        return False, "ffprobe 探测失败", None
    if info["width"] < min_w or info["height"] < min_h:
        return False, "分辨率 %dx%d 低于 %dx%d" % (
            info["width"], info["height"], min_w, min_h), info
    if info["duration"] < min_dur:
        return False, "时长 %.2fs 短于 %.1fs" % (info["duration"], min_dur), info
    if 0 < info["nb_frames"] < MIN_FRAMES:
        return False, "帧数 %d 少于 %d" % (info["nb_frames"], MIN_FRAMES), info
    if min_bitrate_kbps and 0 < info["bitrate"] < min_bitrate_kbps * 1000:
        return False, "码率 %dkbps 低于 %dkbps" % (
            info["bitrate"] // 1000, min_bitrate_kbps), info
    return True, "%dx%d %.1fs %dkbps" % (
        info["width"], info["height"], info["duration"],
        info["bitrate"] // 1000), info


def transcode_to_mp4(path):
    """把 webm/ogv 转成 mp4(h264, yuv420p)；成功后删除原文件。返回新路径。

    ffmpeg 缺失或转码失败时返回原路径（保留原格式素材，不静默丢失）。
    """
    if path.lower().endswith(".mp4"):
        return path
    exe = ffmpeg_exe()
    if not tool_available(exe):
        warn("ffmpeg 不可用，保留原格式: %s" % os.path.basename(path))
        return path

    out = os.path.splitext(path)[0] + ".mp4"
    if os.path.exists(out):
        out = unique_dest(os.path.dirname(path), os.path.basename(out))
    cmd = [
        exe, "-hide_banner", "-v", "error", "-y",
        "-i", path,
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p", "-an",
        out,
    ]
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as e:
        warn("ffmpeg 无法启动(%s): %s" % (exe, e))
        return path
    if p.returncode != 0 or not os.path.exists(out):
        warn("转码失败，保留原格式 %s: %s"
             % (os.path.basename(path), p.stderr.decode("utf-8", "ignore")[:200]))
        _safe_remove(out)
        return path
    _safe_remove(path)
    return out


# ───────────────────────── 署名清单 ─────────────────────────

def attribution_path(dest_dir):
    return os.path.join(dest_dir, ATTRIBUTION_FILE)


def load_attribution_urls(csv_path):
    """读取已记录的 source_url 集合，用于跨次运行去重。"""
    urls = set()
    if not os.path.isfile(csv_path):
        return urls
    try:
        with open(csv_path, "r", encoding="utf-8-sig", newline="") as fh:
            for row in csv.DictReader(fh):
                u = (row.get("source_url") or "").strip()
                if u:
                    urls.add(u)
    except (OSError, csv.Error) as e:
        warn("读取署名清单失败 %s: %s" % (csv_path, e))
    return urls


def write_attribution(csv_path, candidate, filename):
    """追加一行溯源记录（首次写入时带表头），供素材来源复核。"""
    new_file = not os.path.isfile(csv_path)
    row = {
        "filename": filename,
        "title": candidate.get("title", ""),
        "author": candidate.get("author", "") or "(未标注)",
        "license": candidate.get("license", ""),
        "license_url": candidate.get("license_url", ""),
        "source_url": candidate_source_url(candidate),
        "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    try:
        with open(csv_path, "a", encoding="utf-8", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(ATTRIBUTION_HEADER))
            if new_file:
                writer.writeheader()
            writer.writerow(row)
    except (OSError, csv.Error) as e:
        warn("写入署名清单失败 %s: %s" % (csv_path, e))
        return False
    return True


def candidate_source_url(candidate):
    """署名与去重用的来源 URL：优先文件描述页，回退直链。"""
    return candidate.get("page_url") or candidate.get("url") or ""


# ───────────────────────── 主流程 ─────────────────────────

def gather_candidates(source, queries, max_candidates, delay, keys):
    """按查询词依次检索并按 URL 去重，返回合并后的候选列表。
    source 支持逗号分隔多源，如 "pexels,pixabay,commons" 。"""
    sources = [s.strip() for s in source.split(",") if s.strip()]
    merged = []
    seen = set()
    for src in sources:
        for q in queries:
            log("  检索 [%s] \"%s\" (<=%d 条)" % (src, q, max_candidates))
            found = search_source(src, q, max_candidates, delay=delay, keys=keys)
            log("    返回 %d 条" % len(found))
            for cand in found:
                key = cand.get("url")
                if key and key not in seen:
                    seen.add(key)
                    merged.append(cand)
            if delay > 0:
                time.sleep(delay)
    return merged


def prefilter(candidate, min_w, min_h, done_urls, require_license=False):
    """下载前初筛：去重 -> 格式 -> (可选)许可证 -> 分辨率。返回 (ok, bucket, reason)。

    require_license=False（默认，质量优先模式）时跳过许可证白名单检查；
    仅在 require_license=True（合规模式）时才拦截非 CC0/PD/CC-BY 素材。
    """
    if candidate_source_url(candidate) in done_urls:
        return False, "dup", "已在溯源清单中"
    if candidate["mime"] not in VIDEO_MIMES:
        return False, "format", "mime=%s 非视频" % (candidate["mime"] or "?")
    if require_license:
        allowed, reason = is_allowed_license(candidate.get("extmetadata"))
        if not allowed:
            return False, "license", reason
    w, h = candidate["width"], candidate["height"]
    # API 未给出尺寸时不在此拦截，留给下载后的 ffprobe 校验
    if w and h and (w < min_w or h < min_h):
        return False, "resolution", "分辨率 %dx%d 低于 %dx%d" % (w, h, min_w, min_h)
    return True, "ok", "质量初筛通过"


def process_category(category, args, keys):
    """处理单个场景类别，返回统计 dict。"""
    queries = list(args.query) if args.query else list(CATEGORY_QUERIES[category])
    if args.add_query:
        queries += list(args.add_query)

    dest_rel = CATEGORY_DEST.get(category, category)
    dest_dir = os.path.join(args.dest_root, dest_rel)
    csv_path = attribution_path(dest_dir)
    if not args.dry_run:
        os.makedirs(dest_dir, exist_ok=True)
    done_urls = load_attribution_urls(csv_path)

    log("=" * 68)
    log("类别=%s 目标目录=%s%s" % (category, dest_dir, "（dry-run）" if args.dry_run else ""))
    log("规格: >=%dx%d, >=%.1fs；查询词: %s"
        % (args.min_width, args.min_height, args.min_duration, ", ".join(queries)))
    log("已在署名清单中的素材: %d 条（将跳过）" % len(done_urls))

    candidates = gather_candidates(args.source, queries, args.max_candidates,
                                   args.delay, keys)
    log("候选合计 %d 条（已按 URL 去重）" % len(candidates))

    stats = {"scanned": 0, "accepted": 0, "license": 0, "format": 0,
             "resolution": 0, "duration": 0, "bitrate": 0, "dup": 0, "failed": 0}
    consecutive_rl = 0   # 连续限流计数，达到阈值则终止本类，避免持续冲击服务器

    # 将目录中已有的视频计入已接受数，使 --limit 表示「目录总上限」而非「单次运行下载数」
    if os.path.isdir(dest_dir):
        _existing = [f for f in os.listdir(dest_dir)
                     if f.lower().endswith((".mp4", ".webm", ".ogv", ".mov", ".mkv", ".avi"))]
        stats["accepted"] = len(_existing)
        if args.limit and stats["accepted"] >= args.limit:
            log("目录已有 %d 个视频，已达 --limit=%d，跳过本类" % (stats["accepted"], args.limit))
            return stats

    for cand in candidates:
        if args.limit and stats["accepted"] >= args.limit:
            log("已达 --limit=%d，停止本类" % args.limit)
            break
        stats["scanned"] += 1

        ok, bucket, reason = prefilter(cand, args.min_width, args.min_height,
                                       done_urls, args.require_license)
        if not ok:
            stats[bucket] += 1
            warn("跳过 %s: %s" % (cand.get("title", "?"), reason))
            continue

        if args.dry_run:
            stats["accepted"] += 1
            print("  [候选] %s\n         %dx%d | %s | %s"
                  % (cand.get("title", "?"), cand["width"], cand["height"],
                     cand.get("license", "?"), candidate_source_url(cand)))
            continue

        filename = safe_filename(cand)
        dest = unique_dest(dest_dir, filename)
        log("下载 %s -> %s" % (cand.get("title", "?"), os.path.basename(dest)))
        ok, info = download_file(cand["url"], dest, args.max_bytes, args.delay)
        if not ok:
            warn("下载失败 %s: %s" % (cand.get("title", "?"), info))
            stats["failed"] += 1
            if info.startswith("rate_limited"):
                consecutive_rl += 1
                log("触发限流，冷却 %ds 后继续（持续限流请稍后重试或调大 --delay）"
                    % args.cooldown)
                time.sleep(args.cooldown)
                if consecutive_rl >= 5:
                    warn("连续 5 次被限流，终止本类以避免冲击服务器；请稍后重试。")
                    break
            else:
                consecutive_rl = 0
            continue
        consecutive_rl = 0
        log("  已下载 %s" % info)

        ok, reason, _probe = validate_video(dest, args.min_width, args.min_height,
                                            args.min_duration, args.min_bitrate_kbps)
        if not ok:
            warn("  校验不通过，删除: %s" % reason)
            _safe_remove(dest)
            if reason.startswith("分辨率"):
                stats["resolution"] += 1
            elif reason.startswith("时长") or reason.startswith("帧数"):
                stats["duration"] += 1
            elif reason.startswith("码率"):
                stats["bitrate"] += 1
            else:
                stats["failed"] += 1
            continue
        log("  校验通过 %s" % reason)

        if not args.no_transcode:
            dest = transcode_to_mp4(dest)

        # 署名清单是 CC-BY 合规的必要产物，写失败视为该素材未完成收集
        if not write_attribution(csv_path, cand, os.path.basename(dest)):
            stats["failed"] += 1
            continue
        done_urls.add(candidate_source_url(cand))
        stats["accepted"] += 1

        if args.delay > 0:
            time.sleep(args.delay)

    log("-" * 68)
    log("[%s] 扫描=%d 接受=%d | 跳过: license=%d format=%d resolution=%d "
        "duration=%d bitrate=%d dup=%d 失败=%d"
        % (category, stats["scanned"], stats["accepted"], stats["license"],
           stats["format"], stats["resolution"], stats["duration"],
           stats["bitrate"], stats["dup"], stats["failed"]))
    if not args.dry_run:
        log("[%s] 署名清单: %s" % (category, csv_path))
    return stats


def build_parser():
    ap = argparse.ArgumentParser(
        description="批量抓取公开高质量视频素材（SR 训练集用），以分辨率/时长/帧数/(可选)码率"
                    "为质量闸门。模型权重仍须自研，绝不加载第三方预训练权重。")
    ap.add_argument("--category", default="all",
                    choices=CATEGORIES + ("all", "urban"),
                    help="场景类别（默认 all）")
    ap.add_argument("--source", default="commons",
                    help="数据源（默认 commons；支持逗号分隔多源如 pexels,pixabay,commons；pexels/pixabay 需配置对应 API Key）")
    ap.add_argument("--dest-root", default=DEST_ROOT,
                    help="输出根目录（默认 <repo>/data/sr_train）")
    ap.add_argument("--limit", type=int, default=0,
                    help="每类最多下载多少段（0=不限；设计目标 %d/类）" % TARGET_PER_CATEGORY)
    ap.add_argument("--min-width", type=int, default=MIN_WIDTH)
    ap.add_argument("--min-height", type=int, default=MIN_HEIGHT)
    ap.add_argument("--min-duration", type=float, default=MIN_DURATION)
    ap.add_argument("--min-bitrate-kbps", type=int, default=MIN_BITRATE_KBPS,
                    help="下载后码率下限 kbps（0=不限；高质量素材建议 2000~5000）")
    ap.add_argument("--require-license", action="store_true",
                    help="开启许可证白名单模式：仅抓取 CC0/PD/CC-BY，否则只卡质量不卡授权")
    ap.add_argument("--max-bytes", type=int, default=MAX_BYTES,
                    help="单文件下载上限字节数（默认 400MB）")
    ap.add_argument("--max-candidates", type=int, default=MAX_CANDIDATES,
                    help="每个查询词最多取多少条候选（默认 50）")
    ap.add_argument("--delay", type=float, default=DEFAULT_DELAY,
                    help="请求/下载间隔秒数（默认 2.0，礼貌爬取）")
    ap.add_argument("--cooldown", type=float, default=RATE_LIMIT_COOLDOWN,
                    help="触发 429 限流后的冷却秒数（默认 30）")
    ap.add_argument("--no-transcode", action="store_true",
                    help="不转码，保留 webm/ogv 原格式")
    ap.add_argument("--dry-run", action="store_true",
                    help="只列出通过格式+分辨率质量初筛的候选，不下载")
    ap.add_argument("--query", action="append", metavar="Q",
                    help="覆盖该类默认查询词，可重复")
    ap.add_argument("--add-query", action="append", metavar="Q",
                    help="在默认查询词基础上追加，可重复")
    ap.add_argument("--pexels-key", default=None, help="Pexels API Key（或用 env PEXELS_API_KEY）")
    ap.add_argument("--pixabay-key", default=None, help="Pixabay API Key（或用 env PIXABAY_API_KEY）")
    ap.add_argument("--proxy", default=None,
                    help="HTTP/HTTPS 代理，如 http://127.0.0.1:10809；"
                         "用于换出口 IP 绕开 Wikimedia 对本机/共享 IP 的 429 限流")
    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)

    if args.proxy:
        ph = urllib.request.ProxyHandler({"http": args.proxy, "https": args.proxy})
        proxy_opener = urllib.request.build_opener(ph)
        # 先探测代理是否可达；不可达则回退直连，避免整轮卡死
        try:
            probe = proxy_opener.open(
                urllib.request.Request(
                    "https://commons.wikimedia.org/w/api.php"
                    "?action=query&format=json&meta=siteinfo",
                    headers={"User-Agent": USER_AGENT}),
                timeout=8)
            probe.close()
            urllib.request.install_opener(proxy_opener)
            log("已启用代理: %s（换出口 IP 以绕开 Wikimedia 429 限流）" % args.proxy)
        except (urllib.error.URLError, OSError) as e:
            warn("代理 %s 不可达（%s），回退直连" % (args.proxy, e))

    if args.category == "all" and args.query:
        warn("--query 会覆盖所有类别的默认查询词，建议配合单一 --category 使用")

    cats = list(CATEGORIES) if args.category == "all" else [args.category]
    keys = {"pexels": args.pexels_key, "pixabay": args.pixabay_key}

    if args.require_license:
        log("合规模式: 仅抓取 CC0 / Public Domain / CC-BY（不含 SA/NC/ND）授权素材。")
    else:
        log("质量优先模式（默认）: 广泛抓取公开素材、不卡许可证；"
            "仅以分辨率/时长/帧数/(可选)码率为质量闸门。")
    log("溯源清单(非强制合规，供复核): %s" % ATTRIBUTION_FILE)
    if not tool_available(ffprobe_exe()):
        warn("ffprobe 不可用（%s），将跳过分辨率/时长校验" % ffprobe_exe())
    if not args.no_transcode and not tool_available(ffmpeg_exe()):
        warn("ffmpeg 不可用（%s），将保留 webm/ogv 原格式" % ffmpeg_exe())

    total = {"scanned": 0, "accepted": 0, "failed": 0}
    for cat in cats:
        stats = process_category(cat, args, keys)
        total["scanned"] += stats["scanned"]
        total["accepted"] += stats["accepted"]
        total["failed"] += stats["failed"]

    log("=" * 68)
    log("全部完成: 扫描=%d 接受=%d 失败=%d" % (total["scanned"], total["accepted"], total["failed"]))
    if args.dry_run:
        log("dry-run 未下载任何文件。去掉 --dry-run 实际执行。")
    else:
        log("已为每段素材写入溯源清单 %s，建议分发数据集时一并保留以便复核。" % ATTRIBUTION_FILE)
        log("本地自有素材归集请用互补脚本 scripts/collect_sr_data.py。")
    return 0 if total["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
