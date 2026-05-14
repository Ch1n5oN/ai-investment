#!/usr/bin/env python3
"""
雪球用户帖子抓取脚本
用法：
1. 登录雪球网站 https://xueqiu.com
2. 打开浏览器开发者工具（F12）-> Network -> 找任意请求 -> 复制Cookie
3. 运行：python3 xueqiu_scraper.py --cookie "你的cookie" --user_id 8469219487
"""

import requests
import json
import argparse
import time
from datetime import datetime, date
import os
import re
from html import unescape
from html.parser import HTMLParser


class TextExtractor(HTMLParser):
    """Small dependency-free HTML-to-text extractor for Xueqiu post bodies."""

    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in {"br", "p", "div", "li", "tr", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_data(self, data):
        text = data.strip()
        if text:
            self.parts.append(text)

    def text(self):
        return re.sub(r"\n{3,}", "\n\n", "\n".join(self.parts)).strip()


def clean_html(raw):
    if not raw:
        return ""
    parser = TextExtractor()
    parser.feed(unescape(raw))
    return parser.text()


def parse_xueqiu_time(value):
    if isinstance(value, str):
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%a %b %d %H:%M:%S %z %Y"):
            try:
                return datetime.strptime(value, fmt)
            except ValueError:
                pass
        return None
    if isinstance(value, (int, float)) and value:
        if value > 1000000000000:
            value = value / 1000
        return datetime.fromtimestamp(value)
    return None


def format_xueqiu_time(value):
    parsed = parse_xueqiu_time(value)
    if parsed:
        return parsed.strftime("%Y-%m-%d %H:%M:%S")
    return value if isinstance(value, str) else "未知时间"


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


def load_cookie(args):
    if args.cookie:
        return args.cookie
    if args.cookie_file:
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
            response = requests.get(url, params=params, headers=headers, timeout=30)
            print(f"  状态码: {response.status_code}")
            if response.status_code == 200:
                try:
                    return response.json()
                except ValueError:
                    print(f"  非JSON响应片段: {response.text[:160]}")
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
        response = requests.get(url, params=params, headers=headers, timeout=30)
        print(f"  状态码: {response.status_code}")
        if response.status_code == 200:
            try:
                return response.json()
            except ValueError:
                print(f"  非JSON响应片段: {response.text[:160]}")
                return None
        print(f"  响应片段: {response.text[:160]}")
    except requests.exceptions.RequestException as e:
        print(f"  请求失败: {e}")
    return None


def fetch_post_page(user_id, post_id, cookie):
    """拉取单篇页面正文，适合体系框架列表中指定的帖子ID。"""
    url = f"https://xueqiu.com/{user_id}/{post_id}"
    headers = make_headers(cookie, url)
    response = requests.get(url, headers=headers, timeout=30)
    print(f"  页面 {post_id} 状态码: {response.status_code}")
    if response.status_code != 200:
        print(f"  响应片段: {response.text[:160]}")
        return None

    html = response.text
    title = ""
    title_match = re.search(r"<h1[^>]*>(.*?)</h1>", html, flags=re.S)
    if title_match:
        title = clean_html(title_match.group(1))

    body = ""
    body_match = re.search(r'<div[^>]+class="[^"]*article__bd__detail[^"]*"[^>]*>(.*?)</div>\s*</div>', html, flags=re.S)
    if body_match:
        body = clean_html(body_match.group(1))
    if not body:
        body = clean_html(html)

    return {
        "id": str(post_id),
        "created_at": "未知时间",
        "text": body,
        "title": title,
        "target": url,
        "reply_count": 0,
        "like_count": 0,
        "retweet_count": 0,
        "source": "page",
    }


def parse_post_ref(raw_ref, default_user_id):
    ref = raw_ref.strip()
    match = re.search(r"xueqiu\.com/(\d+)/(\d+)", ref)
    if match:
        return match.group(1), match.group(2)
    return default_user_id, ref.rsplit("/", 1)[-1]

def extract_posts(data):
    """提取帖子关键信息"""
    posts = []
    # 检查不同的数据结构
    statuses = data.get("statuses", []) or data.get("list", []) or data.get("items", [])

    for status in statuses:
        created_at_raw = status.get("created_at", 0)
        post = {
            "id": status.get("id"),
            "created_at": format_xueqiu_time(created_at_raw),
            "text": status.get("text", status.get("description", "")),
            "clean_text": clean_html(status.get("text", status.get("description", ""))),
            "title": status.get("title", ""),
            "target": status.get("target", ""),
            "retweeted_status": status.get("retweeted_status"),
            "reply_count": status.get("reply_count", 0),
            "like_count": status.get("like_count", status.get("likeCount", 0)),
            "retweet_count": status.get("retweet_count", status.get("retweetCount", 0)),
            "source": status.get("source", ""),
        }
        posts.append(post)
    return posts


def filter_since(items, since_date):
    if not since_date:
        return items
    cutoff = datetime.combine(date.fromisoformat(since_date), datetime.min.time())
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
            response = requests.get(url, params=params, headers=headers, timeout=30)
            print(f"  状态码: {response.status_code}")
            if response.status_code == 200:
                data = response.json()
                return data
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
        response = requests.get(url, params=params, headers=headers, timeout=30)
        if response.status_code == 200:
            return response.json()
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
        response = requests.get(url, params=params, headers=headers, timeout=30)
        if response.status_code == 200:
            return response.json()
    except requests.exceptions.RequestException as e:
        print(f"  获取帖子评论失败: {e}")

    return None

def extract_user_replies_from_comments(data, target_user_id):
    """从评论数据中提取目标用户的回复"""
    replies = []
    comments = data.get("comments", []) or data.get("list", [])

    for comment in comments:
        # 检查评论是否来自目标用户（懂哥的回复）
        user_id = comment.get("user", {}).get("id", 0)
        if str(user_id) == str(target_user_id):
            created_at_raw = comment.get("created_at", 0)
            if created_at_raw > 1000000000000:
                created_at = datetime.fromtimestamp(created_at_raw / 1000).strftime("%Y-%m-%d %H:%M:%S")
            elif created_at_raw > 0:
                created_at = datetime.fromtimestamp(created_at_raw).strftime("%Y-%m-%d %H:%M:%S")
            else:
                created_at = "未知时间"

            reply = {
                "id": comment.get("id"),
                "created_at": created_at,
                "text": comment.get("text", ""),
                "reply_to": comment.get("reply_to_id"),
                "post_id": comment.get("status_id"),
                "like_count": comment.get("like_count", 0),
                "source": comment.get("source", ""),
            }
            replies.append(reply)

    return replies

def save_posts(posts, output_dir, user_id, suffix="posts"):
    """保存帖子到文件"""
    # 创建输出目录
    os.makedirs(output_dir, exist_ok=True)

    # 保存为JSON（方便后续处理）
    json_file = os.path.join(output_dir, f"xueqiu_{user_id}_{suffix}.json")
    with open(json_file, "w", encoding="utf-8") as f:
        json.dump(posts, f, ensure_ascii=False, indent=2)
    print(f"已保存 {len(posts)} 条帖子到 {json_file}")

    # 同时保存为Markdown（方便阅读）
    md_file = os.path.join(output_dir, f"xueqiu_{user_id}_{suffix}.md")
    with open(md_file, "w", encoding="utf-8") as f:
        f.write(f"# 雪球用户 {user_id} {suffix} 抓取\n\n")
        f.write(f"抓取时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")
        f.write("---\n\n")

        for i, post in enumerate(posts, 1):
            f.write(f"## 帖子 {i}\n\n")
            f.write(f"**ID**: {post.get('id', '')}\n\n")
            f.write(f"**时间**: {post['created_at']}\n\n")
            f.write(f"**互动**: 回复{post['reply_count']} | 点赞{post['like_count']} | 转发{post['retweet_count']}\n\n")
            if post.get("target"):
                target = post["target"]
                if target.startswith("/"):
                    target = "https://xueqiu.com" + target
                f.write(f"**链接**: {target}\n\n")
            if post['title']:
                f.write(f"**标题**: {post['title']}\n\n")
            content = post.get("clean_text") or post.get("text", "")
            f.write(f"**内容**:\n\n{content}\n\n")
            f.write("---\n\n")

    print(f"已保存Markdown到 {md_file}")
    return json_file, md_file

def save_replies(replies, output_dir, user_id):
    """保存回复到文件"""
    os.makedirs(output_dir, exist_ok=True)

    json_file = os.path.join(output_dir, f"xueqiu_{user_id}_replies.json")
    with open(json_file, "w", encoding="utf-8") as f:
        json.dump(replies, f, ensure_ascii=False, indent=2)
    print(f"已保存 {len(replies)} 条回复到 {json_file}")

    md_file = os.path.join(output_dir, f"xueqiu_{user_id}_replies.md")
    with open(md_file, "w", encoding="utf-8") as f:
        f.write(f"# 雪球用户 {user_id} 回复评论抓取\n\n")
        f.write(f"抓取时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")
        f.write("---\n\n")

        for i, reply in enumerate(replies, 1):
            f.write(f"## 回复 {i}\n\n")
            f.write(f"**时间**: {reply['created_at']}\n\n")
            f.write(f"**帖子ID**: {reply['post_id']}\n\n")
            f.write(f"**点赞**: {reply['like_count']}\n\n")
            f.write(f"**内容**:\n\n{reply['text']}\n\n")
            f.write("---\n\n")

    print(f"已保存Markdown到 {md_file}")
    return json_file, md_file

def scrape_replies_from_posts(posts, user_id, cookie, output_dir, delay=2.0):
    """从已抓取的帖子中提取懂哥的回复"""
    all_replies = []

    print(f"\n开始抓取 {len(posts)} 条帖子的评论回复...")

    for i, post in enumerate(posts, 1):
        post_id = post.get("id")
        if not post_id:
            continue

        print(f"  处理帖子 {i}/{len(posts)} (ID: {post_id})")

        # 获取该帖子的评论
        comments_data = get_post_comments(post_id, cookie, count=50)
        if comments_data:
            replies = extract_user_replies_from_comments(comments_data, user_id)
            if replies:
                all_replies.extend(replies)
                print(f"    找到 {len(replies)} 条回复")

        # 避免请求过快
        if i < len(posts):
            time.sleep(delay)

    if all_replies:
        save_replies(all_replies, output_dir, user_id)
        return all_replies
    else:
        print("\n未找到回复内容")
        return []

def main():
    parser = argparse.ArgumentParser(description="雪球用户帖子抓取工具")
    parser.add_argument("--cookie", help="雪球网站的Cookie（登录后从浏览器获取）")
    parser.add_argument("--cookie-file", help="从文件读取Cookie；也可用环境变量 XUEQIU_COOKIE")
    parser.add_argument("--user_id", default="8469219487", help="用户ID（默认懂哥）")
    parser.add_argument("--mode", choices=["posts", "articles", "both", "ids"], default="posts", help="抓取模式：主页帖子、专栏长文、两者、指定帖子ID")
    parser.add_argument("--pages", type=int, default=3, help="抓取页数（每页10条）")
    parser.add_argument("--count", type=int, default=10, help="每页数量")
    parser.add_argument("--output", default="./output", help="输出目录")
    parser.add_argument("--delay", type=float, default=3.0, help="请求间隔秒数（避免被封）")
    parser.add_argument("--since-date", help="只保留该日期及之后的内容，例如 2026-04-01")
    parser.add_argument("--post-ids", help="逗号分隔的帖子ID列表，配合 --mode ids 使用")
    parser.add_argument("--replies", action="store_true", help="同时抓取回复评论")
    parser.add_argument("--reply-pages", type=int, default=2, help="每条帖子的评论页数")

    args = parser.parse_args()
    cookie = load_cookie(args)
    if not cookie:
        raise SystemExit("缺少Cookie：请传 --cookie/--cookie-file，或设置 XUEQIU_COOKIE")

    all_posts = []

    print(f"开始抓取用户 {args.user_id}，模式 {args.mode}...")
    print(f"预计抓取 {args.pages * args.count} 条/类")

    if args.mode == "ids":
        if not args.post_ids:
            raise SystemExit("--mode ids 需要 --post-ids")
        for raw_id in args.post_ids.split(","):
            ref_user_id, post_id = parse_post_ref(raw_id, args.user_id)
            if not post_id:
                continue
            item = fetch_post_page(ref_user_id, post_id, cookie)
            if item:
                all_posts.append(item)
            time.sleep(args.delay)
        if all_posts:
            save_posts(all_posts, args.output, args.user_id, suffix="selected_posts")
        return

    modes = ["posts", "articles"] if args.mode == "both" else [args.mode]

    for mode in modes:
        mode_posts = []
        print(f"\n开始抓取 {mode}...")
        for page in range(1, args.pages + 1):
            print(f"\n正在抓取第 {page} 页...")

            if mode == "articles":
                data = get_user_articles(args.user_id, cookie, page=page, count=args.count)
            else:
                data = get_user_posts(args.user_id, cookie, page=page, count=args.count)

            if data:
                posts = extract_posts(data)
                posts = filter_since(posts, args.since_date)
                if posts:
                    mode_posts.extend(posts)
                    print(f"  获取 {len(posts)} 条")
                else:
                    print("  该页无符合条件内容，停止抓取")
                    break
            else:
                print("  请求失败，停止抓取")
                break

            if page < args.pages:
                time.sleep(args.delay)

        if mode_posts:
            save_posts(mode_posts, args.output, args.user_id, suffix=mode)
            all_posts.extend(mode_posts)

    if all_posts:
        print(f"\n总计抓取 {len(all_posts)} 条帖子")

        # 抓取回复评论
        if args.replies:
            scrape_replies_from_posts(all_posts, args.user_id, cookie, args.output, args.delay)
    else:
        print("\n未获取到任何帖子，请检查Cookie是否有效")

if __name__ == "__main__":
    main()
