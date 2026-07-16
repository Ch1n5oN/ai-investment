#!/usr/bin/env python3
"""
雪球用户帖子抓取脚本
用法：
1. 登录雪球网站 https://xueqiu.com
2. 打开浏览器开发者工具（F12）-> Network -> 找任意请求 -> 复制Cookie
3. 将Cookie写入权限为600的文件后运行：python3 xueqiu_scraper.py --cookie-file /path/to/cookie.txt --user_id 8469219487
"""

import argparse
import json
import math
import os
import random
import re
import stat
import sys
import tempfile
import time
from datetime import date, datetime, time as datetime_time
from urllib.parse import urlsplit, urlunsplit
from zoneinfo import ZoneInfo

import requests


SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")
SCHEMA_VERSION = 1
RECORD_CONTRACT = "normalized_v1"
ASCII_WHITESPACE = " \t\r\n\f\v"
MAX_SAFE_INTEGER = 9_007_199_254_740_991
TRANSIENT_HTTP_STATUSES = {429, 500, 502, 503, 504}


class ConfigArgumentParser(argparse.ArgumentParser):
    """Reserve exit 1 for local/argument errors; exit 2 means partial data."""

    def error(self, message):
        self.print_usage(sys.stderr)
        self.exit(1, f"{self.prog}: error: {message}\n")


def ascii_trim(value):
    """Trim only the whitespace shared by the Python and Node contracts."""
    return value.strip(ASCII_WHITESPACE)


def clean_html(raw):
    """Match scripts/lib/xueqiu_core.mjs cleanHtml byte-for-byte."""
    text = str(raw or "")
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</p>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    for source, target in (
        ("&nbsp;", " "),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", '"'),
        ("&#39;", "'"),
        ("&amp;", "&"),
    ):
        text = text.replace(source, target)
    return ascii_trim(re.sub(r"\n{3,}", "\n\n", text))


def parse_xueqiu_time(value):
    if value is None or (not isinstance(value, bool) and value == 0):
        return None
    parsed = None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        text = ascii_trim(value)
        if not text or text.lower() == "unknown" or text == "未知时间":
            return None
        if re.fullmatch(r"\d+(?:\.\d+)?", text):
            return parse_xueqiu_time(float(text))
        if re.fullmatch(
            r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?",
            text,
        ):
            try:
                parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            except ValueError:
                pass
    elif (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and value > 0
        and math.isfinite(value)
    ):
        # Within the supported (year >= 2000) domain, seconds and milliseconds
        # are disjoint.  Use 1e11 so early-2000 millisecond epochs are not
        # mistaken for far-future seconds.
        if value >= 100_000_000_000:
            value = value / 1000
        try:
            parsed = datetime.fromtimestamp(value, tz=SHANGHAI_TZ)
        except (OSError, OverflowError, ValueError):
            parsed = None

    if parsed is None:
        return None
    if parsed.tzinfo is None:
        normalized = parsed.replace(tzinfo=SHANGHAI_TZ)
    else:
        normalized = parsed.astimezone(SHANGHAI_TZ)
    return normalized if normalized.year >= 2000 else None


def format_xueqiu_time(value):
    if (
        value is None
        or (not isinstance(value, bool) and value == 0)
        or (
            isinstance(value, str)
            and ascii_trim(value).lower() in {"", "unknown", "未知时间"}
        )
    ):
        return "unknown"
    parsed = parse_xueqiu_time(value)
    if parsed is None:
        raise ValueError(f"invalid Xueqiu timestamp: {value!r}")
    return parsed.isoformat(timespec="seconds")


def numeric_record_id(value, label="record", *, strict_string=False):
    if strict_string:
        if type(value) is not str or not re.fullmatch(r"[0-9]+", value):
            raise ValueError(f"{label} id must be a digit-only string")
        return value
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValueError(f"{label} id must contain digits only")
    if isinstance(value, (int, float)):
        if (
            not math.isfinite(value)
            or not float(value).is_integer()
            or not 0 <= value <= MAX_SAFE_INTEGER
        ):
            raise ValueError(f"{label} id must be a safe non-negative integer")
        normalized = str(int(value))
    else:
        normalized = ascii_trim(value)
    if not re.fullmatch(r"[0-9]+", normalized):
        raise ValueError(f"{label} id must contain digits only")
    return normalized


def canonical_xueqiu_target(value, user_id="", post_id=""):
    """Return an absolute Xueqiu URL for relative API targets."""
    target = ascii_trim(str(value or ""))
    fallback = ""
    if user_id and post_id:
        normalized_user_id = numeric_record_id(user_id, "target user")
        normalized_post_id = numeric_record_id(post_id, "target post")
        fallback = f"https://xueqiu.com/{normalized_user_id}/{normalized_post_id}"
    if not target:
        if fallback:
            return fallback
        raise ValueError("target is missing and no Xueqiu post fallback is available")

    if re.match(r"^[a-z][a-z0-9+.-]*:", target, flags=re.I) and not re.match(
        r"^https?:", target, flags=re.I
    ):
        raise ValueError("unsupported target protocol")
    if target.startswith("//"):
        candidate = f"https:{target}"
    elif re.match(r"^https?://", target, flags=re.I):
        candidate = target
    else:
        candidate = f"https://xueqiu.com/{target.lstrip('/')}"
    try:
        parsed = urlsplit(candidate)
        hostname = (parsed.hostname or "").lower()
        port = parsed.port
    except (TypeError, ValueError) as exc:
        raise ValueError(f"target must be a canonical Xueqiu URL: {target}") from exc
    if not (
        (hostname == "xueqiu.com" or hostname.endswith(".xueqiu.com"))
        and parsed.username is None
        and parsed.password is None
        and port in (None, 443)
    ):
        raise ValueError(f"target must be a canonical Xueqiu URL: {target}")

    path_parts = [part for part in parsed.path.split("/") if part]
    if user_id and post_id and len(path_parts) != 2:
        raise ValueError(
            f"target must identify exactly one Xueqiu post: {target}"
        )
    if post_id:
        normalized_post_id = numeric_record_id(post_id, "target post")
        if not path_parts or path_parts[-1] != normalized_post_id:
            raise ValueError(
                f"target path must end with post id {normalized_post_id}: {target}"
            )
    if user_id:
        normalized_user_id = numeric_record_id(user_id, "target user")
        if len(path_parts) < 2 or path_parts[-2] != normalized_user_id:
            raise ValueError(
                f"target path user id must match {normalized_user_id}: {target}"
            )
    return urlunsplit(("https", hostname, parsed.path or "/", parsed.query, parsed.fragment))


def shanghai_now_iso():
    return datetime.now(SHANGHAI_TZ).isoformat(timespec="seconds")


def positive_int(value):
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise argparse.ArgumentTypeError("必须是正整数") from exc
    if parsed <= 0:
        raise argparse.ArgumentTypeError("必须大于 0")
    return parsed


def non_negative_float(value):
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise argparse.ArgumentTypeError("必须是非负数") from exc
    if not math.isfinite(parsed) or parsed < 0:
        raise argparse.ArgumentTypeError("必须大于或等于 0")
    return parsed


def strict_non_negative_record_int(value, label="count"):
    """Validate an already-normalized JSON count without coercion."""
    if type(value) is not int or not 0 <= value <= MAX_SAFE_INTEGER:
        raise ValueError(f"{label} must be a non-negative integer")
    return value


def non_negative_record_int(value, label="count"):
    """Normalize a raw API count while rejecting ambiguous scalar types."""
    if isinstance(value, bool):
        raise ValueError(f"{label} must be a non-negative integer")
    if type(value) is int:
        parsed = value
    elif isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            raise ValueError(f"{label} must be a non-negative integer")
        parsed = int(value)
    elif isinstance(value, str):
        normalized = ascii_trim(value)
        if not re.fullmatch(r"[0-9]+", normalized):
            raise ValueError(f"{label} must be a non-negative integer")
        parsed = int(normalized)
    else:
        raise ValueError(f"{label} must be a non-negative integer")
    if not 0 <= parsed <= MAX_SAFE_INTEGER:
        raise ValueError(f"{label} must be a non-negative integer")
    return parsed


def valid_iso_date(value):
    try:
        date.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise argparse.ArgumentTypeError("日期必须使用 YYYY-MM-DD 格式") from exc
    return value


def valid_user_id(value):
    if not re.fullmatch(r"[0-9]+", str(value)):
        raise argparse.ArgumentTypeError("用户ID只能包含数字")
    return str(value)


def atomic_write_text(path, content):
    """Atomically replace a UTF-8 text file without exposing partial output."""
    path = os.fspath(path)
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    fd, temporary_path = tempfile.mkstemp(
        dir=directory,
        prefix=f".{os.path.basename(path)}.",
        suffix=".tmp",
        text=True,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    except BaseException:
        try:
            os.unlink(temporary_path)
        except FileNotFoundError:
            pass
        raise


def atomic_write_json(path, data):
    content = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    atomic_write_text(path, content)


def make_headers(cookie, referer="https://xueqiu.com"):
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": referer,
        "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
        "X-Requested-With": "XMLHttpRequest",
    }
    if cookie:
        headers["Cookie"] = cookie
    return headers


def _has_api_error(data):
    if data.get("error_code") not in (None, 0, "0", ""):
        return True
    if data.get("code") not in (None, 0, "0", 200, "200", ""):
        return True
    if data.get("success") is False or data.get("ok") is False:
        return True
    if any(data.get(key) for key in ("error", "errors", "error_msg", "error_description")):
        return True
    status = data.get("status")
    return isinstance(status, str) and status.lower() in {"error", "failed", "failure"}


def _has_challenge(data):
    challenge_tokens = ("captcha", "challenge", "aliyun_waf", "verification")
    for key, value in data.items():
        normalized_key = str(key).lower()
        if any(token in normalized_key for token in challenge_tokens):
            return True
        if normalized_key in {"error", "error_msg", "error_description", "message"}:
            normalized_value = str(value).lower()
            if any(token in normalized_value for token in challenge_tokens):
                return True
    return False


def payload_items(data, list_keys, label):
    if not isinstance(data, dict):
        raise ValueError(f"{label} response must be a JSON object")
    for key in list_keys:
        if key not in data:
            continue
        items = data[key]
        if not isinstance(items, list):
            raise ValueError(f"{label}.{key} must be an array")
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                raise ValueError(f"{label}.{key}[{index}] must be an object")
            try:
                numeric_record_id(item.get("id"), f"{label}.{key}[{index}]")
            except ValueError as exc:
                raise ValueError(str(exc)) from exc
        return items
    expected = ", ".join(list_keys)
    raise ValueError(f"{label} response is missing an array field ({expected})")


def assert_acquisition_contract(record, label):
    has_schema = "schema_version" in record
    has_contract = "record_contract" in record
    if not has_schema and not has_contract:
        return
    if (
        not has_schema
        or not has_contract
        or type(record["schema_version"]) is not int
        or record["schema_version"] != SCHEMA_VERSION
        or record["record_contract"] != RECORD_CONTRACT
    ):
        raise ValueError(f"{label} has a conflicting normalized record contract")


def normalized_pagination_integer(value, label, minimum=0):
    normalized = ascii_trim(value) if isinstance(value, str) else value
    if isinstance(normalized, bool):
        raise ValueError(f"pagination {label} must be an integer >= {minimum}")
    if type(normalized) is int:
        parsed = normalized
    elif isinstance(normalized, float) and math.isfinite(normalized) and normalized.is_integer():
        parsed = int(normalized)
    elif isinstance(normalized, str) and re.fullmatch(r"[0-9]+", normalized):
        parsed = int(normalized)
    else:
        raise ValueError(f"pagination {label} must be an integer >= {minimum}")
    if not minimum <= parsed <= MAX_SAFE_INTEGER:
        raise ValueError(f"pagination {label} must be an integer >= {minimum}")
    return parsed


def pagination_complete(
    data,
    page,
    count,
    item_count,
    *,
    observed_count=None,
):
    """Return true only when the response proves that no later page exists."""
    if not isinstance(data, dict):
        raise ValueError("pagination response must be an object")
    for value, label, minimum in (
        (page, "page", 1),
        (count, "count", 1),
        (item_count, "item_count", 0),
    ):
        if type(value) is not int or not minimum <= value <= MAX_SAFE_INTEGER:
            raise ValueError(f"pagination {label} must be an integer >= {minimum}")
    if item_count > count:
        raise ValueError("pagination item_count cannot exceed the requested count")
    if observed_count is None:
        observed_count = (page - 1) * count + item_count
    if (
        type(observed_count) is not int
        or not 0 <= observed_count <= MAX_SAFE_INTEGER
    ):
        raise ValueError("pagination observed_count must be a non-negative integer")

    containers = [("root", data)]
    for key in ("meta", "pagination", "page_info"):
        if key not in data:
            continue
        if not isinstance(data[key], dict):
            raise ValueError(f"pagination {key} must be an object")
        containers.append((key, data[key]))
    if isinstance(data.get("page"), dict):
        containers.append(("page", data["page"]))

    evidence = []
    metadata_values = {
        "has_more": [],
        "max_page": [],
        "total": [],
        "current_page": [],
        "next_cursor": [],
    }
    for container_name, container in containers:
        for key in ("has_more", "hasMore"):
            if key not in container:
                continue
            raw_value = container[key]
            if raw_value is True or (
                isinstance(raw_value, (int, float))
                and not isinstance(raw_value, bool)
                and math.isfinite(raw_value)
                and raw_value == 1
            ):
                value = True
            elif raw_value is False or (
                isinstance(raw_value, (int, float))
                and not isinstance(raw_value, bool)
                and math.isfinite(raw_value)
                and raw_value == 0
            ):
                value = False
            elif isinstance(raw_value, str):
                normalized = ascii_trim(raw_value).lower()
                if normalized in {"true", "1"}:
                    value = True
                elif normalized in {"false", "0"}:
                    value = False
                else:
                    raise ValueError(f"pagination {key} must be boolean")
            else:
                raise ValueError(f"pagination {key} must be boolean")
            label = f"{container_name}.{key}"
            metadata_values["has_more"].append((label, value))
            evidence.append(("more" if value else "complete", label))
        for key in (
            "max_page",
            "maxPage",
            "page_count",
            "pageCount",
            "total_pages",
            "totalPages",
        ):
            if key not in container:
                continue
            value = normalized_pagination_integer(container.get(key), key)
            label = f"{container_name}.{key}"
            metadata_values["max_page"].append((label, value))
            evidence.append(("more" if page < value else "complete", label))
        for key in ("total", "total_count", "totalCount"):
            if key not in container:
                continue
            value = normalized_pagination_integer(container.get(key), key)
            label = f"{container_name}.{key}"
            metadata_values["total"].append((label, value))
            evidence.append(("complete" if observed_count >= value else "more", label))
        for key in ("page", "page_no", "pageNo", "current_page", "currentPage"):
            if key not in container or isinstance(container[key], dict):
                continue
            value = normalized_pagination_integer(container[key], key, minimum=1)
            metadata_values["current_page"].append(
                (f"{container_name}.{key}", value)
            )
        for key in ("next", "next_id", "nextId", "next_cursor", "nextCursor"):
            if key not in container:
                continue
            raw_value = container[key]
            if isinstance(raw_value, bool) or not isinstance(
                raw_value, (str, int, float, type(None))
            ):
                raise ValueError(f"pagination {key} has an invalid cursor")
            if isinstance(raw_value, (int, float)) and not isinstance(raw_value, bool):
                if (
                    not math.isfinite(raw_value)
                    or not float(raw_value).is_integer()
                    or not 0 <= raw_value <= MAX_SAFE_INTEGER
                ):
                    raise ValueError(f"pagination {key} has an invalid cursor")
                numeric_cursor = int(raw_value)
                value = None if numeric_cursor == 0 else str(numeric_cursor)
            elif isinstance(raw_value, str):
                trimmed = ascii_trim(raw_value)
                value = None if trimmed in {"", "0"} else trimmed
            else:
                value = None
            label = f"{container_name}.{key}"
            metadata_values["next_cursor"].append((label, value))
            evidence.append(("complete" if value is None else "more", label))

    for category, values in metadata_values.items():
        if len({value for _, value in values}) > 1:
            details = ", ".join(f"{key}={value}" for key, value in values)
            raise ValueError(f"conflicting pagination {category} metadata: {details}")
    if metadata_values["current_page"]:
        declared_page = metadata_values["current_page"][0][1]
        if declared_page != page:
            raise ValueError(
                f"pagination declared page {declared_page} does not match requested page {page}"
            )
    if metadata_values["max_page"]:
        declared_max_page = metadata_values["max_page"][0][1]
        if (
            declared_max_page == 0
            and (item_count > 0 or observed_count > 0)
        ) or (page > declared_max_page and item_count > 0):
            raise ValueError("pagination max page contradicts the observed page")

    states = {state for state, _ in evidence}
    if len(states) > 1:
        return False
    if states == {"more"}:
        return False
    if states == {"complete"}:
        return True
    return item_count < count


def parse_json_response(response, label, list_keys=None):
    try:
        data = response.json()
    except ValueError:
        print(f"  {label} 非JSON响应片段: {response.text[:160]}")
        return None

    if not isinstance(data, dict) or not data:
        print(f"  {label} JSON结构无效：期望非空对象")
        return None
    if _has_challenge(data):
        print(f"  {label} 命中验证码/WAF挑战")
        return None
    if _has_api_error(data):
        code = data.get("error_code", "unknown")
        description = data.get("error_description") or data.get("error_msg") or data.get("error") or "API error"
        print(f"  {label} API错误 {code}: {description}")
        return None
    if list_keys:
        try:
            payload_items(data, list_keys, label)
        except ValueError as exc:
            print(f"  {label} JSON结构无效: {exc}")
            return None
    return data


def request_get(url, *, attempts=3, **kwargs):
    """Retry transient transport and server failures with bounded backoff."""
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            response = requests.get(url, **kwargs)
            if response.status_code not in TRANSIENT_HTTP_STATUSES or attempt == attempts:
                return response
            retry_after = response.headers.get("Retry-After")
            delay = float(retry_after) if retry_after and retry_after.isdigit() else 0.5 * (2 ** (attempt - 1))
        except requests.exceptions.RequestException as exc:
            last_error = exc
            if attempt == attempts:
                raise
            delay = 0.5 * (2 ** (attempt - 1))
        time.sleep(min(delay, 30.0) + random.uniform(0, 0.25))
    if last_error:
        raise last_error
    raise RuntimeError("request retry loop ended unexpectedly")


def load_cookie(args):
    if args.cookie:
        print(
            "警告：--cookie 会暴露在 shell 历史和进程列表中；请改用权限为 600 的 --cookie-file。",
            file=sys.stderr,
        )
        return args.cookie
    if args.cookie_file:
        if os.name == "posix":
            mode = stat.S_IMODE(os.stat(args.cookie_file).st_mode)
            if mode & 0o077:
                raise SystemExit(
                    f"Cookie 文件权限过宽：{args.cookie_file}；请先执行 chmod 600。"
                )
        with open(args.cookie_file, encoding="utf-8") as f:
            return f.read().strip()
    return os.environ.get("XUEQIU_COOKIE", "").strip()

def get_user_posts(user_id, cookie, page=1, count=10):
    """获取用户帖子列表"""
    # 尝试多个可能的API端点
    endpoints = [
        "https://xueqiu.com/statuses/user_timeline.json",
        "https://xueqiu.com/v4/statuses/user_timeline.json",
        "https://xueqiu.com/v5/statuses/user_timeline.json",
    ]

    headers = make_headers(cookie, f"https://xueqiu.com/u/{user_id}")

    params = {
        "user_id": user_id,
        "page": page,
        "count": count,
        "type": 0,  # 0=全部
    }

    for url in endpoints:
        try:
            print(f"  尝试端点: {url}")
            response = request_get(url, params=params, headers=headers, timeout=30)
            print(f"  状态码: {response.status_code}")
            if response.status_code == 200:
                data = parse_json_response(
                    response,
                    "时间线",
                    list_keys=("statuses", "list", "items"),
                )
                if data is not None:
                    return data
                continue
            elif response.status_code == 404:
                continue
        except requests.exceptions.RequestException as e:
            print(f"  请求失败: {e}")
            continue

    print("所有端点尝试失败")
    return None


def get_user_articles(user_id, cookie, page=1, count=10):
    """获取用户专栏/长文列表"""
    url = "https://xueqiu.com/statuses/original/timeline.json"
    headers = make_headers(cookie, f"https://xueqiu.com/{user_id}/column")
    params = {
        "user_id": user_id,
        "page": page,
        "count": count,
    }
    try:
        print(f"  尝试专栏端点: {url}")
        response = request_get(url, params=params, headers=headers, timeout=30)
        print(f"  状态码: {response.status_code}")
        if response.status_code == 200:
            return parse_json_response(
                response,
                "专栏",
                list_keys=("statuses", "list", "items"),
            )
        print(f"  响应片段: {response.text[:160]}")
    except requests.exceptions.RequestException as e:
        print(f"  请求失败: {e}")
    return None


def fetch_post_page(user_id, post_id, cookie):
    """拉取单篇页面正文，适合体系框架列表中指定的帖子ID。"""
    user_id = numeric_record_id(user_id, "page user")
    post_id = numeric_record_id(post_id, "page post")
    url = f"https://xueqiu.com/{user_id}/{post_id}"
    headers = make_headers(cookie, url)
    response = request_get(url, headers=headers, timeout=30)
    print(f"  页面 {post_id} 状态码: {response.status_code}")
    if response.status_code != 200:
        print(f"  响应片段: {response.text[:160]}")
        return None

    html = response.text
    if re.search(r"renderData|_waf_|aliyun_waf|captcha", html, flags=re.I):
        print(f"  页面 {post_id} 命中WAF/验证码，未保存为正文")
        return None
    print(
        f"  页面 {post_id} 仅提供HTML正文，缺少可信互动数，"
        "不能写入 normalized_v1"
    )
    return None


def parse_post_ref(raw_ref, default_user_id):
    ref = ascii_trim(raw_ref)
    match = re.search(r"xueqiu\.com/(\d+)/(\d+)", ref)
    if match:
        return match.group(1), match.group(2)
    return (
        numeric_record_id(default_user_id, "post reference user"),
        numeric_record_id(ref.rsplit("/", 1)[-1], "post reference"),
    )


def response_field(record, aliases, label, *, allow_none=False):
    if not isinstance(record, dict):
        raise ValueError(f"{label} must be an object")
    for alias in aliases:
        if alias in record and (allow_none or record[alias] is not None):
            return record[alias]
    raise ValueError(f"{label} is missing {'/'.join(aliases)}")

def extract_posts(data, user_id=""):
    """提取帖子关键信息"""
    posts = []
    statuses = payload_items(data, ("statuses", "list", "items"), "时间线")

    for status in statuses:
        assert_acquisition_contract(status, "post")
        created_at_raw = response_field(
            status, ("created_at",), "post timestamp", allow_none=True
        )
        post_id = numeric_record_id(response_field(status, ("id",), "post id"), "post")
        raw_text = response_field(status, ("text", "description"), "post text")
        if not isinstance(raw_text, str):
            raise ValueError(f"post {post_id} text must be a string")
        source = status.get("source", "")
        if not isinstance(source, str):
            raise ValueError(f"post {post_id} source must be a string")
        post = {
            "schema_version": SCHEMA_VERSION,
            "record_contract": RECORD_CONTRACT,
            "id": post_id,
            "created_at_raw": created_at_raw,
            "created_at": format_xueqiu_time(created_at_raw),
            "text": raw_text,
            "clean_text": clean_html(raw_text),
            "target": canonical_xueqiu_target(status.get("target", ""), user_id, post_id),
            "reply_count": non_negative_record_int(
                response_field(status, ("reply_count", "replyCount"), "post reply count"),
                "reply_count",
            ),
            "like_count": non_negative_record_int(
                response_field(status, ("like_count", "likeCount"), "post like count"),
                "like_count",
            ),
            "retweet_count": non_negative_record_int(
                response_field(status, ("retweet_count", "retweetCount"), "post retweet count"),
                "retweet_count",
            ),
            "view_count": non_negative_record_int(
                response_field(status, ("view_count", "viewCount"), "post view count"),
                "view_count",
            ),
            "source": source,
        }
        if "title" in status and status["title"] is not None:
            if not isinstance(status["title"], str):
                raise ValueError(f"post {post_id} title must be a string")
            post["title"] = clean_html(status["title"])
        posts.append(post)
    return posts


def filter_since(items, since_date):
    if not since_date:
        return items
    cutoff = datetime.combine(date.fromisoformat(since_date), datetime_time.min, tzinfo=SHANGHAI_TZ)
    filtered = []
    for item in items:
        parsed = parse_xueqiu_time(item.get("created_at"))
        if parsed is None or parsed >= cutoff:
            filtered.append(item)
    return filtered

def get_user_comments(user_id, cookie, page=1, count=10):
    """获取用户评论列表"""
    endpoints = [
        "https://xueqiu.com/statuses/user_comments.json",
        "https://xueqiu.com/v4/statuses/user_comments.json",
    ]

    headers = make_headers(cookie, f"https://xueqiu.com/u/{user_id}")

    params = {
        "user_id": user_id,
        "page": page,
        "count": count,
    }

    for url in endpoints:
        try:
            print(f"  尝试评论端点: {url}")
            response = request_get(url, params=params, headers=headers, timeout=30)
            print(f"  状态码: {response.status_code}")
            if response.status_code == 200:
                data = parse_json_response(
                    response,
                    "用户评论",
                    list_keys=("comments", "list"),
                )
                if data is not None:
                    return data
                continue
            elif response.status_code == 404:
                continue
        except requests.exceptions.RequestException as e:
            print(f"  请求失败: {e}")
            continue

    print("所有评论端点尝试失败")
    return None

def get_comment_replies(comment_id, cookie, page=1, count=20):
    """获取某条评论的回复（懂哥回复别人的内容）"""
    url = "https://xueqiu.com/comments/replies.json"

    headers = make_headers(cookie, "https://xueqiu.com")

    params = {
        "comment_id": comment_id,
        "page": page,
        "count": count,
    }

    try:
        response = request_get(url, params=params, headers=headers, timeout=30)
        if response.status_code == 200:
            return parse_json_response(
                response,
                "评论回复",
                list_keys=("comments", "list"),
            )
    except requests.exceptions.RequestException as e:
        print(f"  获取回复失败: {e}")

    return None

def get_post_comments(post_id, cookie, page=1, count=20, since_id=None):
    """获取某条帖子下的评论，筛选出懂哥的回复"""
    url = "https://xueqiu.com/statuses/comments.json"

    headers = make_headers(cookie, f"https://xueqiu.com/{post_id}")

    params = {
        "id": post_id,
        "page": page,
        "count": count,
        "type": "status",
    }
    if since_id:
        params["since_id"] = since_id

    try:
        response = request_get(url, params=params, headers=headers, timeout=30)
        if response.status_code == 200:
            return parse_json_response(
                response,
                "帖子评论",
                list_keys=("comments", "list"),
            )
    except requests.exceptions.RequestException as e:
        print(f"  获取帖子评论失败: {e}")

    return None

def extract_user_replies_from_comments(
    data,
    target_user_id,
    post_target="",
    default_post_id="",
):
    """从评论数据中提取目标用户的回复"""
    replies = []
    comments = payload_items(data, ("comments", "list"), "帖子评论")

    for comment in comments:
        # 检查评论是否来自目标用户（懂哥的回复）
        user = comment.get("user")
        user_id = user.get("id") if isinstance(user, dict) else None
        user_id = user_id or comment.get("user_id") or comment.get("userId") or 0
        if str(user_id) == str(target_user_id):
            assert_acquisition_contract(comment, "reply")
            status_id = (
                comment["status_id"]
                if "status_id" in comment and comment["status_id"] is not None
                else default_post_id
            )
            post_id = numeric_record_id(
                status_id,
                "reply post",
            )
            reply_id = numeric_record_id(comment.get("id"), "reply")
            raw_text = response_field(comment, ("text", "description"), "reply text")
            if not isinstance(raw_text, str):
                raise ValueError(f"reply {reply_id} text must be a string")
            source = comment.get("source", "")
            if not isinstance(source, str):
                raise ValueError(f"reply {reply_id} source must be a string")
            created_at_raw = response_field(
                comment, ("created_at",), "reply timestamp", allow_none=True
            )
            reply = {
                "schema_version": SCHEMA_VERSION,
                "record_contract": RECORD_CONTRACT,
                "id": reply_id,
                "created_at_raw": created_at_raw,
                "created_at": format_xueqiu_time(created_at_raw),
                "text": raw_text,
                "clean_text": clean_html(raw_text),
                "reply_to": numeric_record_id(comment["reply_to_id"], "reply_to") if comment.get("reply_to_id") is not None else None,
                "post_id": post_id,
                "post_target": canonical_xueqiu_target(
                    post_target,
                    target_user_id,
                    post_id,
                ),
                "like_count": non_negative_record_int(
                    response_field(comment, ("like_count", "likeCount"), "reply like count"),
                    "like_count",
                ),
                "reply_count": non_negative_record_int(
                    response_field(comment, ("reply_count", "replyCount"), "reply reply count"),
                    "reply_count",
                ),
                "source": source,
            }
            replies.append(reply)

    return replies

def save_posts(posts, output_dir, user_id, suffix="posts"):
    """保存帖子到文件"""
    # 创建输出目录
    os.makedirs(output_dir, exist_ok=True)

    # 保存为JSON（方便后续处理）
    json_file = os.path.join(output_dir, f"xueqiu_{user_id}_{suffix}.json")
    atomic_write_json(json_file, posts)
    print(f"已保存 {len(posts)} 条帖子到 {json_file}")

    # 同时保存为Markdown（方便阅读）
    md_file = os.path.join(output_dir, f"xueqiu_{user_id}_{suffix}.md")
    lines = [
        f"# 雪球用户 {user_id} {suffix} 抓取",
        "",
        f"抓取时间: {shanghai_now_iso()}",
        "",
        "---",
        "",
    ]
    for i, post in enumerate(posts, 1):
        lines.extend(
            [
                f"## 帖子 {i}",
                "",
                f"**ID**: {post.get('id', '')}",
                "",
                f"**时间**: {post['created_at']}",
                "",
                f"**互动**: 回复{post['reply_count']} | 点赞{post['like_count']} | 转发{post['retweet_count']}",
                "",
            ]
        )
        if post.get("target"):
            target = post["target"]
            if target.startswith("/"):
                target = "https://xueqiu.com" + target
            lines.extend([f"**链接**: {target}", ""])
        if post.get("title"):
            lines.extend([f"**标题**: {post['title']}", ""])
        content = post.get("clean_text") or post.get("text", "")
        lines.extend(["**内容**:", "", content, "", "---", ""])
    atomic_write_text(md_file, "\n".join(lines))

    print(f"已保存Markdown到 {md_file}")
    return json_file, md_file

def save_replies(replies, output_dir, user_id):
    """保存回复到文件"""
    os.makedirs(output_dir, exist_ok=True)

    json_file = os.path.join(output_dir, f"xueqiu_{user_id}_replies.json")
    atomic_write_json(json_file, replies)
    print(f"已保存 {len(replies)} 条回复到 {json_file}")

    md_file = os.path.join(output_dir, f"xueqiu_{user_id}_replies.md")
    lines = [
        f"# 雪球用户 {user_id} 回复评论抓取",
        "",
        f"抓取时间: {shanghai_now_iso()}",
        "",
        "---",
        "",
    ]
    for i, reply in enumerate(replies, 1):
        lines.extend(
            [
                f"## 回复 {i}",
                "",
                f"**时间**: {reply['created_at']}",
                "",
                f"**帖子ID**: {reply['post_id']}",
                "",
                f"**点赞**: {reply['like_count']}",
                "",
                "**内容**:",
                "",
                reply["text"],
                "",
                "---",
                "",
            ]
        )
    atomic_write_text(md_file, "\n".join(lines))

    print(f"已保存Markdown到 {md_file}")
    return json_file, md_file

def scrape_replies_from_posts(
    posts,
    user_id,
    cookie,
    output_dir,
    delay=2.0,
    reply_pages=2,
    comment_count=50,
    return_status=False,
    persist=True,
):
    """从已抓取的帖子中提取懂哥的回复"""
    all_replies = []

    print(f"\n开始抓取 {len(posts)} 条帖子的评论回复...")

    request_failed = False
    for i, post in enumerate(posts, 1):
        post_id = post.get("id")
        if not post_id:
            continue

        print(f"  处理帖子 {i}/{len(posts)} (ID: {post_id})")

        expected_comments = int(post.get("reply_count") or 0)
        observed_comment_ids = set()
        if expected_comments > reply_pages * comment_count:
            request_failed = True
            print(
                f"    评论数 {expected_comments} 超过 --reply-pages 覆盖上限，结果需复核"
            )

        for page in range(1, reply_pages + 1):
            comments_data = get_post_comments(post_id, cookie, page=page, count=comment_count)
            if comments_data is None:
                request_failed = True
                print(f"    第 {page} 页请求失败，停止该帖扫描")
                break
            comments = payload_items(
                comments_data,
                ("comments", "list"),
                "帖子评论",
            )
            for comment in comments:
                observed_comment_ids.add(
                    numeric_record_id(comment.get("id"), "post comment")
                )
            replies = extract_user_replies_from_comments(
                comments_data,
                user_id,
                post.get("target") or "",
                post_id,
            )
            if replies:
                all_replies.extend(replies)
                print(f"    第 {page} 页找到 {len(replies)} 条回复")
            if pagination_complete(
                comments_data,
                page,
                comment_count,
                len(comments),
                observed_count=len(observed_comment_ids),
            ):
                break
            if page == reply_pages:
                request_failed = True
                print(f"    第 {page} 页分页仍未结束，结果已截断")
            else:
                time.sleep(delay)

        if len(observed_comment_ids) < expected_comments:
            request_failed = True
            print(
                f"    帖子声明有 {expected_comments} 条评论，但仅观察到 "
                f"{len(observed_comment_ids)} 个唯一评论，结果需复核"
            )

        # 避免请求过快
        if i < len(posts):
            time.sleep(delay)

    deduplicated = {}
    for reply in all_replies:
        reply_id = numeric_record_id(reply.get("id"), "reply")
        deduplicated[reply_id] = reply
    all_replies = list(deduplicated.values())

    if all_replies:
        if persist and not request_failed:
            save_replies(all_replies, output_dir, user_id)
    else:
        print("\n未找到回复内容")
    if return_status:
        return all_replies, request_failed
    return all_replies


def build_parser():
    parser = ConfigArgumentParser(
        description="雪球用户帖子抓取工具",
        epilog="退出码：0=完整完成，2=部分请求失败需复核，1=配置或本地致命错误。",
    )
    parser.add_argument("--cookie", help="雪球网站的Cookie（登录后从浏览器获取）")
    parser.add_argument("--cookie-file", help="从文件读取Cookie；也可用环境变量 XUEQIU_COOKIE")
    parser.add_argument("--user_id", type=valid_user_id, default="8469219487", help="用户ID（默认懂哥）")
    parser.add_argument("--mode", choices=["posts", "articles", "both", "ids"], default="posts", help="抓取模式：主页帖子、专栏长文、两者、指定帖子ID")
    parser.add_argument("--pages", type=positive_int, default=3, help="抓取页数（每页10条）")
    parser.add_argument("--count", type=positive_int, default=10, help="每页数量")
    parser.add_argument("--output", default="./output", help="输出目录")
    parser.add_argument("--delay", type=non_negative_float, default=3.0, help="请求间隔秒数（避免被封）")
    parser.add_argument("--since-date", type=valid_iso_date, help="只保留该日期及之后的内容，例如 2026-04-01")
    parser.add_argument("--post-ids", help="逗号分隔的帖子ID列表，配合 --mode ids 使用")
    parser.add_argument("--replies", action="store_true", help="同时抓取回复评论")
    parser.add_argument("--reply-pages", type=positive_int, default=2, help="每条帖子的评论页数")
    return parser


def run_scrape(argv=None):
    parser = build_parser()

    args = parser.parse_args(argv)
    cookie = load_cookie(args)
    if not cookie:
        raise SystemExit("缺少Cookie：请传 --cookie/--cookie-file，或设置 XUEQIU_COOKIE")

    all_posts = []
    mode_results = {}
    collected_replies = []
    request_failed = False
    valid_responses = 0

    print(f"开始抓取用户 {args.user_id}，模式 {args.mode}...")
    print(f"预计抓取 {args.pages * args.count} 条/类")

    if args.mode == "ids":
        if not args.post_ids:
            raise SystemExit("--mode ids 需要 --post-ids")
        raw_ids = args.post_ids.split(",")
        for index, raw_id in enumerate(raw_ids):
            ref_user_id, post_id = parse_post_ref(raw_id, args.user_id)
            if not post_id:
                continue
            item = fetch_post_page(ref_user_id, post_id, cookie)
            if item:
                all_posts.append(item)
            else:
                request_failed = True
            if index < len(raw_ids) - 1:
                time.sleep(args.delay)
        if request_failed:
            return 2 if all_posts else 1
        if all_posts:
            save_posts(all_posts, args.output, args.user_id, suffix="selected_posts")
        return 0

    modes = ["posts", "articles"] if args.mode == "both" else [args.mode]

    for mode in modes:
        mode_posts = []
        observed_post_ids = set()
        print(f"\n开始抓取 {mode}...")
        for page in range(1, args.pages + 1):
            print(f"\n正在抓取第 {page} 页...")

            if mode == "articles":
                data = get_user_articles(args.user_id, cookie, page=page, count=args.count)
            else:
                data = get_user_posts(args.user_id, cookie, page=page, count=args.count)

            if data is not None:
                valid_responses += 1
                raw_posts = extract_posts(data, args.user_id)
                observed_post_ids.update(post["id"] for post in raw_posts)
                posts = filter_since(raw_posts, args.since_date)
                if posts:
                    mode_posts.extend(posts)
                    print(f"  获取 {len(posts)} 条")
                else:
                    print("  该页无符合条件内容，继续验证后续页")
                if pagination_complete(
                    data,
                    page,
                    args.count,
                    len(raw_posts),
                    observed_count=len(observed_post_ids),
                ):
                    break
                if page == args.pages:
                    request_failed = True
                    print(
                        f"  {mode} 最后一页仍满 {len(raw_posts)} 条，"
                        "且未观察到分页结束，结果已截断"
                    )
            else:
                print("  请求失败，停止抓取")
                request_failed = True
                break

            if page < args.pages:
                time.sleep(args.delay)

        mode_results[mode] = mode_posts
        all_posts.extend(mode_posts)

    if all_posts:
        print(f"\n总计抓取 {len(all_posts)} 条帖子")

        # 抓取回复评论
        if args.replies:
            collected_replies, replies_failed = scrape_replies_from_posts(
                all_posts,
                args.user_id,
                cookie,
                args.output,
                args.delay,
                reply_pages=args.reply_pages,
                return_status=True,
                persist=False,
            )
            request_failed = request_failed or replies_failed
    else:
        print("\n未获取到任何帖子，请检查Cookie是否有效")
    if request_failed:
        print("部分请求失败：未写入本轮 corpus，请复核后重试。", file=sys.stderr)
        return 2 if all_posts or valid_responses else 1
    for mode, mode_posts in mode_results.items():
        if mode_posts:
            save_posts(mode_posts, args.output, args.user_id, suffix=mode)
    if collected_replies:
        save_replies(collected_replies, args.output, args.user_id)
    return 0


def main(argv=None):
    try:
        return run_scrape(argv)
    except (OSError, ValueError) as exc:
        print(f"抓取失败：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
