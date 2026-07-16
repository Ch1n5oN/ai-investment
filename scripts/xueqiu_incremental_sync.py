#!/usr/bin/env python3
"""
Incremental Xueqiu sync for timeline posts, article lists, and self replies.

This script stays cookie-based and avoids browser automation. It reuses the
low-level request helpers from xueqiu_scraper.py, then adds:

1. Stable output filenames
2. Merge + de-duplication
3. Incremental comment scanning for recent posts
4. Optional sub-reply crawling
5. A small state file for later runs
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta
from typing import Any

from xueqiu_scraper import (
    ConfigArgumentParser,
    RECORD_CONTRACT,
    SCHEMA_VERSION,
    SHANGHAI_TZ,
    atomic_write_json,
    atomic_write_text,
    ascii_trim,
    assert_acquisition_contract,
    canonical_xueqiu_target,
    clean_html,
    extract_posts,
    filter_since,
    format_xueqiu_time,
    get_comment_replies,
    get_post_comments,
    get_user_articles,
    get_user_posts,
    load_cookie,
    non_negative_float,
    non_negative_record_int,
    numeric_record_id,
    pagination_complete,
    pageable_timeline_items,
    parse_xueqiu_time,
    payload_items,
    positive_int,
    response_field,
    shanghai_now_iso,
    strict_non_negative_record_int,
    valid_iso_date,
    valid_user_id,
)


class JsonFileError(RuntimeError):
    """An existing sync file could not be read safely."""


NORMALIZED_RECORD_FIELDS = frozenset(
    {
        "schema_version",
        "record_contract",
        "id",
        "created_at_raw",
        "created_at",
        "target",
        "post_id",
        "post_target",
        "post_link",
        "reply_to",
        "in_reply_to_comment_id",
        "status_id",
        "user_id",
        "text",
        "clean_text",
        "reply_count",
        "like_count",
        "retweet_count",
        "view_count",
        "post_reply_count",
        "title",
        "source",
        "origin",
        "mode",
        "post_title",
        "post_text",
        "post_excerpt",
        "created_ms",
        "fetched_from_page",
        "post_created_at_raw",
        "post_created_at",
        "legacy_migrated_fields",
    }
)


def copy_allowed_record(
    record: dict[str, Any],
    label: str,
    *,
    migrate_raw_retweet: bool = False,
) -> dict[str, Any]:
    item = dict(record)
    if migrate_raw_retweet:
        item.pop("retweeted_status", None)
    unknown_fields = sorted(set(item) - NORMALIZED_RECORD_FIELDS)
    if unknown_fields:
        raise ValueError(
            f"{label} contains unknown fields: {', '.join(unknown_fields)}"
        )
    return item


def load_json(path: str, default: Any) -> Any:
    if not os.path.exists(path):
        return default
    try:
        with open(path, encoding="utf-8") as handle:
            loaded = json.load(handle)
    except json.JSONDecodeError as exc:
        raise JsonFileError(
            f"Invalid JSON in {path} at line {exc.lineno}, column {exc.colno}; file was not overwritten."
        ) from exc
    except OSError as exc:
        raise JsonFileError(f"Cannot read existing JSON file {path}: {exc}") from exc
    if not isinstance(loaded, type(default)):
        raise JsonFileError(
            f"Unexpected JSON type in {path}: expected {type(default).__name__}, got {type(loaded).__name__}."
        )
    if isinstance(default, list):
        seen_ids: set[str] = set()
        for index, item in enumerate(loaded):
            if not isinstance(item, dict):
                raise JsonFileError(
                    f"Invalid corpus record in {path} at index {index}: expected object; file was not overwritten."
                )
            item_id = item.get("id")
            try:
                normalized_id = numeric_record_id(item_id, f"record at index {index}")
            except ValueError as exc:
                raise JsonFileError(
                    f"Invalid corpus record in {path} at index {index}: {exc}; file was not overwritten."
                ) from exc
            if normalized_id in seen_ids:
                raise JsonFileError(
                    f"Duplicate corpus id {normalized_id!r} in {path}; file was not overwritten."
                )
            seen_ids.add(normalized_id)
    return loaded


def validate_sync_state(state: dict[str, Any], user_id: str) -> dict[str, Any]:
    if state.get("schema_version") != SCHEMA_VERSION:
        raise JsonFileError("Sync state schema_version is missing or unsupported; file was not overwritten.")
    if state.get("user_id") != user_id:
        raise JsonFileError("Sync state user_id does not match the requested user; file was not overwritten.")
    if state.get("status") not in {"complete", "needs_verification", "failed"}:
        raise JsonFileError("Sync state status is invalid; file was not overwritten.")
    for field in ("attempted_at", "updated_at"):
        if not isinstance(state.get(field), str) or parse_xueqiu_time(state[field]) is None:
            raise JsonFileError(f"Sync state {field} must be a valid timestamp; file was not overwritten.")
    completed_at = state.get("completed_at")
    if completed_at is not None and (
        not isinstance(completed_at, str) or parse_xueqiu_time(completed_at) is None
    ):
        raise JsonFileError("Sync state completed_at must be null or a valid timestamp; file was not overwritten.")
    if state["status"] == "complete" and completed_at is None:
        raise JsonFileError("A complete sync state requires completed_at; file was not overwritten.")
    if not isinstance(state.get("failures"), list) or not all(
        isinstance(item, str) for item in state["failures"]
    ):
        raise JsonFileError("Sync state failures must be a list of strings; file was not overwritten.")
    for field in ("remote_attempts", "valid_responses"):
        value = state.get(field)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise JsonFileError(f"Sync state {field} must be a non-negative integer; file was not overwritten.")
    if type(state.get("corpus_updated")) is not bool:
        raise JsonFileError("Sync state corpus_updated must be boolean; file was not overwritten.")
    return state


def save_json(path: str, data: Any) -> None:
    atomic_write_json(path, data)


def ensure_target(url: str, user_id: str = "", post_id: str = "") -> str:
    return canonical_xueqiu_target(url, user_id, post_id)


def required_id(value: Any, label: str, *, strict_string: bool = False) -> str:
    return numeric_record_id(value, label, strict_string=strict_string)


def optional_id(value: Any, label: str) -> str | None:
    if value is None or value == "":
        return None
    return required_id(value, label)


def normalized_record_time(
    record: dict[str, Any],
    label: str,
    *,
    legacy_record: bool,
) -> tuple[Any, str]:
    if "created_at_raw" in record:
        raw_value = record.get("created_at_raw")
    else:
        if not legacy_record:
            raise ValueError(f"{label} created_at_raw is required")
        existing_value = record.get("created_at")
        raw_value = None if existing_value in (None, "", "unknown", "未知时间") else existing_value
    if isinstance(raw_value, bool) or not isinstance(
        raw_value, (str, int, float, type(None))
    ):
        raise ValueError(f"{label} created_at_raw must be a string, number, or null")
    normalized = format_xueqiu_time(raw_value)
    if "created_at" in record:
        if not isinstance(record.get("created_at"), str):
            raise ValueError(f"{label} created_at must be a string")
        existing_value = record["created_at"]
        existing = (
            format_xueqiu_time(existing_value)
            if legacy_record
            else existing_value
        )
        if existing != normalized:
            raise ValueError(
                f"{label} created_at does not represent its preserved created_at_raw"
            )
    elif not legacy_record:
        raise ValueError(f"{label} created_at is required")
    return raw_value, normalized


def normalize_optional_time_pair(
    record: dict[str, Any],
    raw_field: str,
    normalized_field: str,
    label: str,
) -> None:
    has_raw = raw_field in record
    has_normalized = normalized_field in record
    if not has_raw and not has_normalized:
        return
    if has_raw != has_normalized:
        raise ValueError(
            f"{label} {raw_field} and {normalized_field} must be present together"
        )
    raw_value = record[raw_field]
    if isinstance(raw_value, bool) or not isinstance(
        raw_value, (str, int, float, type(None))
    ):
        raise ValueError(f"{label} {raw_field} must be a string, number, or null")
    if not isinstance(record[normalized_field], str):
        raise ValueError(f"{label} {normalized_field} must be a string")
    normalized = format_xueqiu_time(raw_value)
    if record[normalized_field] != normalized:
        raise ValueError(
            f"{label} {normalized_field} does not represent its preserved {raw_field}"
        )
    record[normalized_field] = normalized


def required_string(record: dict[str, Any], field: str, label: str) -> str:
    if field not in record or not isinstance(record[field], str):
        raise ValueError(f"{label} {field} must be a string")
    return record[field]


def validate_optional_strings(record: dict[str, Any], label: str) -> None:
    for field in (
        "title",
        "post_title",
        "post_text",
        "origin",
        "source",
        "mode",
        "post_excerpt",
    ):
        if field in record and not isinstance(record[field], str):
            raise ValueError(f"{label} {field} must be a string")


def validate_optional_metadata(
    record: dict[str, Any],
    label: str,
    *,
    legacy_record: bool,
) -> None:
    if "status_id" in record and record["status_id"] is not None:
        record["status_id"] = required_id(
            record["status_id"],
            "status_id",
            strict_string=not legacy_record,
        )
    if "user_id" in record:
        record["user_id"] = required_id(
            record["user_id"],
            "user_id",
            strict_string=not legacy_record,
        )
    if "post_reply_count" in record:
        record["post_reply_count"] = (
            non_negative_record_int(
                record["post_reply_count"], "post_reply_count"
            )
            if legacy_record
            else strict_non_negative_record_int(
                record["post_reply_count"], "post_reply_count"
            )
        )
    if "created_ms" in record:
        record["created_ms"] = strict_non_negative_record_int(
            record["created_ms"], "created_ms"
        )
    if "fetched_from_page" in record:
        record["fetched_from_page"] = strict_non_negative_record_int(
            record["fetched_from_page"], "fetched_from_page"
        )
        if record["fetched_from_page"] < 1:
            raise ValueError(f"{label} fetched_from_page must be a positive integer")
    if "legacy_migrated_fields" in record:
        fields = record["legacy_migrated_fields"]
        if (
            not isinstance(fields, list)
            or any(type(field) is not str or not field for field in fields)
            or len(set(fields)) != len(fields)
        ):
            raise ValueError(
                f"{label} legacy_migrated_fields must contain unique non-empty strings"
            )


def preferred_field(record: dict[str, Any], primary: str, alias: str) -> Any:
    return record[primary] if primary in record else record.get(alias)


def normalize_post(post: dict[str, Any], user_id: str = "") -> dict[str, Any]:
    if not isinstance(post, dict):
        raise ValueError("post record must be an object")
    has_schema_version = "schema_version" in post
    has_record_contract = "record_contract" in post
    item = copy_allowed_record(
        post,
        "post",
        migrate_raw_retweet=not has_record_contract,
    )
    if has_record_contract and not has_schema_version:
        raise ValueError(
            "post record_contract cannot be present without schema_version"
        )
    legacy_record = not has_schema_version
    existing_migrated_fields = (
        list(item["legacy_migrated_fields"])
        if isinstance(item.get("legacy_migrated_fields"), list)
        else []
    )
    migrated_fields: list[str] = []
    if not legacy_record and (
        type(item["schema_version"]) is not int
        or item["schema_version"] != SCHEMA_VERSION
    ):
        raise ValueError(
            f"post schema_version must be {SCHEMA_VERSION}"
        )
    if "record_contract" in item and item["record_contract"] != RECORD_CONTRACT:
        raise ValueError(f"post record_contract must be {RECORD_CONTRACT}")
    validate_optional_metadata(item, "post", legacy_record=legacy_record)
    existing_migrated_fields = list(item.get("legacy_migrated_fields", []))
    if any(field in item for field in ("post_id", "post_target", "post_link")):
        raise ValueError(
            "post record cannot contain reply-only post_id/post_target/post_link fields"
        )
    item["schema_version"] = SCHEMA_VERSION
    item["record_contract"] = RECORD_CONTRACT
    item["id"] = required_id(
        item.get("id"), "post", strict_string=not legacy_record
    )
    item["created_at_raw"], item["created_at"] = normalized_record_time(
        item, "post", legacy_record=legacy_record
    )
    normalize_optional_time_pair(
        item,
        "post_created_at_raw",
        "post_created_at",
        "post secondary timestamp",
    )
    item["text"] = required_string(item, "text", "post")
    if legacy_record and "clean_text" not in item:
        item["clean_text"] = clean_html(item["text"])
        migrated_fields.append("clean_text")
    item["clean_text"] = required_string(item, "clean_text", "post")
    if item["clean_text"] != clean_html(item["text"]):
        if not legacy_record:
            raise ValueError("post clean_text must be the normalized representation of text")
        item["clean_text"] = clean_html(item["text"])
        migrated_fields.append("clean_text")
    if "target" not in item:
        raise ValueError("post target is required")
    supplied_target = item.get("target") or ""
    item["target"] = ensure_target(supplied_target, user_id, item["id"])
    if not legacy_record and item["target"] != supplied_target:
        raise ValueError("post target must already be an absolute canonical Xueqiu URL")
    for field in ("reply_count", "like_count", "retweet_count", "view_count"):
        if field not in item:
            raise ValueError(f"post {field} is required")
        item[field] = (
            non_negative_record_int(item.get(field), field)
            if legacy_record
            else strict_non_negative_record_int(item.get(field), field)
        )
    validate_optional_strings(item, "post")
    if migrated_fields:
        item["legacy_migrated_fields"] = sorted(
            set(existing_migrated_fields + migrated_fields)
        )
    return item


def normalize_reply(
    comment: dict[str, Any],
    post: dict[str, Any],
    origin: str,
    root_comment_id: str | None = None,
) -> dict[str, Any]:
    if not isinstance(comment, dict):
        raise ValueError("reply source must be an object")
    assert_acquisition_contract(comment, "reply")
    reply_id = required_id(comment.get("id"), "reply")
    post_id = required_id(comment.get("status_id") or post.get("id"), "reply post")
    reply_to = comment.get("reply_to_id")
    if reply_to is None:
        reply_to_record = comment.get("reply_to")
        if reply_to_record is not None and not isinstance(reply_to_record, dict):
            raise ValueError("reply_to must be an object")
        reply_to = (reply_to_record or {}).get("id")
    created_at_raw = response_field(
        comment, ("created_at",), "reply timestamp", allow_none=True
    )
    raw_text = response_field(comment, ("text", "description"), "reply text")
    if not isinstance(raw_text, str):
        raise ValueError(f"reply {reply_id} text must be a string")
    source = comment.get("source", "")
    if source is None:
        source = ""
    if not isinstance(source, str):
        raise ValueError(f"reply {reply_id} source must be a string")
    post_created_at_raw = (
        post.get("created_at_raw") if "created_at_raw" in post else None
    )
    post_created_at = format_xueqiu_time(post_created_at_raw)
    return {
        "schema_version": SCHEMA_VERSION,
        "record_contract": RECORD_CONTRACT,
        "id": reply_id,
        "created_at_raw": created_at_raw,
        "created_at": format_xueqiu_time(created_at_raw),
        "text": raw_text,
        "clean_text": clean_html(raw_text),
        "like_count": non_negative_record_int(
            preferred_field(comment, "like_count", "likeCount"),
            "like_count",
        ),
        "reply_count": non_negative_record_int(
            preferred_field(comment, "reply_count", "replyCount"),
            "reply_count",
        ),
        "post_id": post_id,
        "post_created_at_raw": post_created_at_raw,
        "post_created_at": post_created_at,
        "post_title": post.get("title") or "",
        "post_text": post.get("clean_text") or post.get("text") or "",
        "post_target": ensure_target(
            post.get("target") or "",
            str(post.get("user_id") or ""),
            post_id,
        ),
        "reply_to": optional_id(reply_to, "reply_to"),
        "in_reply_to_comment_id": optional_id(root_comment_id, "root comment"),
        "origin": origin,
        "source": source,
    }


def normalize_reply_record(reply: dict[str, Any], user_id: str = "") -> dict[str, Any]:
    if not isinstance(reply, dict):
        raise ValueError("reply record must be an object")
    has_schema_version = "schema_version" in reply
    has_record_contract = "record_contract" in reply
    item = copy_allowed_record(
        reply,
        "reply",
        migrate_raw_retweet=not has_record_contract,
    )
    if has_record_contract and not has_schema_version:
        raise ValueError(
            "reply record_contract cannot be present without schema_version"
        )
    legacy_record = not has_schema_version
    migrated_fields: list[str] = []
    if not legacy_record and (
        type(item["schema_version"]) is not int
        or item["schema_version"] != SCHEMA_VERSION
    ):
        raise ValueError(
            f"reply schema_version must be {SCHEMA_VERSION}"
        )
    if "record_contract" in item and item["record_contract"] != RECORD_CONTRACT:
        raise ValueError(f"reply record_contract must be {RECORD_CONTRACT}")
    validate_optional_metadata(item, "reply", legacy_record=legacy_record)
    existing_migrated_fields = list(item.get("legacy_migrated_fields", []))
    if "target" in item or "post_link" in item:
        raise ValueError("reply record cannot contain target/post_link fields")
    item["schema_version"] = SCHEMA_VERSION
    item["record_contract"] = RECORD_CONTRACT
    item["id"] = required_id(
        item.get("id"), "reply", strict_string=not legacy_record
    )
    item["post_id"] = required_id(
        item.get("post_id"), "reply post", strict_string=not legacy_record
    )
    if item.get("status_id") is not None and item["status_id"] != item["post_id"]:
        raise ValueError("reply status_id must identify post_id")
    item["created_at_raw"], item["created_at"] = normalized_record_time(
        item, "reply", legacy_record=legacy_record
    )
    normalize_optional_time_pair(
        item,
        "post_created_at_raw",
        "post_created_at",
        "reply post timestamp",
    )
    item["text"] = required_string(item, "text", "reply")
    if legacy_record and "clean_text" not in item:
        item["clean_text"] = clean_html(item["text"])
        migrated_fields.append("clean_text")
    item["clean_text"] = required_string(item, "clean_text", "reply")
    if item["clean_text"] != clean_html(item["text"]):
        if not legacy_record:
            raise ValueError("reply clean_text must be the normalized representation of text")
        item["clean_text"] = clean_html(item["text"])
        migrated_fields.append("clean_text")
    if "post_target" not in item:
        raise ValueError("reply post_target is required")
    supplied_target = item.get("post_target") or ""
    item["post_target"] = ensure_target(
        supplied_target,
        user_id,
        item["post_id"],
    )
    if not legacy_record and item["post_target"] != supplied_target:
        raise ValueError(
            "reply post_target must already be an absolute canonical Xueqiu URL"
        )
    for field in ("like_count", "reply_count"):
        if field not in item:
            raise ValueError(f"reply {field} is required")
        item[field] = (
            non_negative_record_int(item[field], field)
            if legacy_record
            else strict_non_negative_record_int(item[field], field)
        )
    for field in ("reply_to", "in_reply_to_comment_id"):
        if item.get(field) is not None:
            item[field] = required_id(
                item[field], field, strict_string=not legacy_record
            )
    validate_optional_strings(item, "reply")
    if migrated_fields:
        item["legacy_migrated_fields"] = sorted(
            set(existing_migrated_fields + migrated_fields)
        )
    return item


def unique_sorted(
    items: list[dict[str, Any]],
    key_name: str,
    record_kind: str,
    user_id: str = "",
) -> list[dict[str, Any]]:
    if record_kind not in {"post", "reply"}:
        raise ValueError("record_kind must be 'post' or 'reply'")
    merged: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise ValueError(f"record at index {index} must be an object")
        upgraded = (
            normalize_reply_record(item, user_id)
            if record_kind == "reply"
            else normalize_post(item, user_id)
        )
        key = required_id(upgraded.get(key_name), f"record at index {index}")
        if key != upgraded["id"]:
            raise ValueError(f"{key_name} must match the normalized record id")
        if key in merged:
            previous = merged[key]
            if record_kind == "post":
                if previous["target"] != upgraded["target"]:
                    raise ValueError(
                        f"duplicate post id {key} changed its canonical target"
                    )
            else:
                for field in ("post_id", "post_target"):
                    if previous[field] != upgraded[field]:
                        raise ValueError(
                            f"duplicate reply id {key} changed {field}"
                        )
                for field in ("reply_to", "in_reply_to_comment_id"):
                    previous_value = previous.get(field)
                    incoming_value = upgraded.get(field)
                    if (
                        previous_value is not None
                        and incoming_value is not None
                        and previous_value != incoming_value
                    ):
                        raise ValueError(
                            f"duplicate reply id {key} changed {field}"
                        )
            previous_time = previous["created_at"]
            incoming_time = upgraded["created_at"]
            if (
                previous_time != "unknown"
                and incoming_time != "unknown"
                and previous_time != incoming_time
            ):
                raise ValueError(
                    f"duplicate {record_kind} id {key} has conflicting created_at values"
                )

            combined = {**previous, **upgraded}
            for field, value in upgraded.items():
                if value is None and previous.get(field) is not None:
                    combined[field] = previous[field]
            if previous_time != "unknown" and incoming_time == "unknown":
                combined["created_at_raw"] = previous["created_at_raw"]
                combined["created_at"] = previous_time
            if (
                record_kind == "reply"
                and "post_created_at" in previous
                and "post_created_at" in upgraded
            ):
                previous_post_time = previous["post_created_at"]
                incoming_post_time = upgraded["post_created_at"]
                if (
                    previous_post_time != "unknown"
                    and incoming_post_time != "unknown"
                    and previous_post_time != incoming_post_time
                ):
                    raise ValueError(
                        f"duplicate reply id {key} changed its post creation timestamp"
                    )
                if (
                    previous_post_time != "unknown"
                    and incoming_post_time == "unknown"
                ):
                    combined["post_created_at_raw"] = previous[
                        "post_created_at_raw"
                    ]
                    combined["post_created_at"] = previous_post_time
            incoming_text_score = len(
                ascii_trim(upgraded["text"]).encode("utf-8")
            ) + len(
                ascii_trim(upgraded["clean_text"]).encode("utf-8")
            )
            previous_text_score = len(
                ascii_trim(previous["text"]).encode("utf-8")
            ) + len(
                ascii_trim(previous["clean_text"]).encode("utf-8")
            )
            if incoming_text_score < previous_text_score:
                combined["text"] = previous["text"]
                combined["clean_text"] = previous["clean_text"]
            for field in (
                "title",
                "post_title",
                "post_text",
                "origin",
                "source",
            ):
                if (
                    isinstance(previous.get(field), str)
                    and isinstance(upgraded.get(field), str)
                    and len(ascii_trim(upgraded[field]).encode("utf-8"))
                    < len(ascii_trim(previous[field]).encode("utf-8"))
                ):
                    combined[field] = previous[field]
            merged[key] = (
                normalize_reply_record(combined, user_id)
                if record_kind == "reply"
                else normalize_post(combined, user_id)
            )
        else:
            merged[key] = upgraded

    def sort_key(item: dict[str, Any]) -> tuple[int, int, str]:
        parsed = parse_xueqiu_time(item.get("created_at"))
        ts = int(parsed.timestamp()) if parsed else 0
        record_id = str(item.get(key_name) or "")
        return (ts, len(record_id), record_id)

    return sorted(merged.values(), key=sort_key, reverse=True)


def render_posts_markdown(items: list[dict[str, Any]], title: str) -> str:
    lines = [
        f"# {title}",
        "",
        f"Updated at: {shanghai_now_iso()}",
        f"Total: {len(items)}",
        "",
        "---",
        "",
    ]
    for index, item in enumerate(items, start=1):
        lines.extend(
            [
                f"## Post {index}",
                "",
                f"ID: {item.get('id', '')}",
                f"Time: {item.get('created_at', '')}",
                f"Replies: {item.get('reply_count', 0)} | Likes: {item.get('like_count', 0)} | Reposts: {item.get('retweet_count', 0)}",
                f"Link: {item.get('target', '')}",
                "",
            ]
        )
        if item.get("title"):
            lines.extend([f"Title: {item['title']}", ""])
        lines.extend([item.get("clean_text") or "", "", "---", ""])
    return "\n".join(lines)


def render_replies_markdown(items: list[dict[str, Any]], title: str) -> str:
    lines = [
        f"# {title}",
        "",
        f"Updated at: {shanghai_now_iso()}",
        f"Total: {len(items)}",
        "",
        "---",
        "",
    ]
    for index, item in enumerate(items, start=1):
        lines.extend(
            [
                f"## Reply {index}",
                "",
                f"ID: {item.get('id', '')}",
                f"Time: {item.get('created_at', '')}",
                f"Origin: {item.get('origin', '')}",
                f"Post ID: {item.get('post_id', '')}",
                f"Post Link: {item.get('post_target', '')}",
                f"Likes: {item.get('like_count', 0)}",
                "",
                item.get("clean_text") or "",
                "",
                "---",
                "",
            ]
        )
    return "\n".join(lines)


def save_markdown(path: str, content: str) -> None:
    atomic_write_text(path, content)


def collect_timeline(
    *,
    fetch_fn,
    user_id: str,
    cookie: str,
    pages: int,
    count: int,
    since_date: str | None,
    delay: float,
    label: str,
    failures: list[str] | None = None,
    activity: dict[str, int] | None = None,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    observed_ids: set[str] = set()
    since_cutoff = (
        datetime.strptime(since_date, "%Y-%m-%d").replace(tzinfo=SHANGHAI_TZ)
        if since_date
        else None
    )
    boundary_ordered = True
    boundary_last_time: datetime | None = None
    boundary_candidate = False
    for page in range(1, pages + 1):
        print(f"[{label}] page {page}/{pages}")
        if activity is not None:
            activity["attempts"] += 1
        data = fetch_fn(user_id, cookie, page=page, count=count)
        if data is None:
            print(f"[{label}] stop: request failed at page {page}")
            if failures is not None:
                failures.append(f"{label} page {page} request failed")
            break
        if activity is not None:
            activity["valid_responses"] += 1
        response_items = payload_items(
            data,
            ("statuses", "list", "items"),
            f"{label} timeline",
        )
        pageable_items = pageable_timeline_items(
            response_items,
            page,
            count,
            f"{label} timeline pagination",
        )
        pageable_ids = {
            numeric_record_id(item.get("id"), f"{label} timeline")
            for item in pageable_items
        }
        batch = [
            normalize_post(item, user_id)
            for item in extract_posts(data, user_id)
        ]
        pageable_batch = [item for item in batch if item["id"] in pageable_ids]
        observed_ids.update(
            item["id"] for item in pageable_batch
        )
        page_times: list[datetime | None] = []
        for item in pageable_batch:
            parsed = parse_xueqiu_time(item.get("created_at"))
            page_times.append(parsed)
            if parsed is None or (
                boundary_last_time is not None and parsed > boundary_last_time
            ):
                boundary_ordered = False
            if parsed is not None:
                boundary_last_time = parsed
        boundary_confirmed = bool(
            since_cutoff
            and boundary_candidate
            and boundary_ordered
            and page_times
            and all(parsed is not None and parsed < since_cutoff for parsed in page_times)
        )
        boundary_candidate = bool(
            since_cutoff
            and boundary_ordered
            and any(parsed is not None and parsed < since_cutoff for parsed in page_times)
        )
        if since_date:
            filtered = filter_since(batch, since_date)
        else:
            filtered = batch
        if not filtered:
            print(f"[{label}] no items after {since_date}; verify later pages before stopping")
        items.extend(filtered)
        if pagination_complete(
            data,
            page,
            count,
            len(pageable_items),
            observed_count=len(observed_ids),
        ) or boundary_confirmed:
            break
        if page == pages:
            if failures is not None:
                failures.append(
                    f"{label} truncated: final page {page} returned {len(batch)} items "
                    "without an observed pagination terminator"
                )
            print(f"[{label}] stop: configured page limit reached before pagination ended")
            break
        if page < pages:
            time.sleep(delay)
    return unique_sorted(items, "id", "post", user_id)


def comment_user_id(comment: dict[str, Any]) -> str:
    user = comment.get("user") or {}
    if not isinstance(user, dict):
        raise ValueError("comment user must be an object")
    return str(user.get("id") or comment.get("user_id") or comment.get("userId") or "")


def record_failure(failures: list[str] | None, message: str) -> None:
    if failures is not None and message not in failures:
        failures.append(message)


def scan_comment_replies(
    *,
    comment_id: str,
    cookie: str,
    user_id: str,
    post: dict[str, Any],
    count: int,
    page_limit: int,
    delay: float,
    failures: list[str] | None = None,
    expected_count: int = 0,
    activity: dict[str, int] | None = None,
) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    observed_ids: set[str] = set()
    if expected_count > page_limit * count:
        record_failure(
            failures,
            f"comment {comment_id} replies truncated: expected {expected_count}, page limit covers {page_limit * count}"
        )
    for page in range(1, page_limit + 1):
        if activity is not None:
            activity["attempts"] += 1
        data = get_comment_replies(comment_id, cookie, page=page, count=count)
        if data is None:
            record_failure(
                failures,
                f"comment {comment_id} replies page {page} request failed",
            )
            break
        if activity is not None:
            activity["valid_responses"] += 1
        comments = payload_items(data, ("comments", "list"), "comment replies")
        for comment in comments:
            observed_ids.add(required_id(comment.get("id"), "nested reply"))
            if comment_user_id(comment) == str(user_id):
                found.append(normalize_reply(comment, post, "comment_replies", root_comment_id=str(comment_id)))
        if pagination_complete(
            data,
            page,
            count,
            len(comments),
            observed_count=len(observed_ids),
        ):
            break
        if page == page_limit:
            record_failure(
                failures,
                f"comment {comment_id} replies truncated: final page {page} did not prove pagination completion",
            )
        else:
            time.sleep(delay)
    if len(observed_ids) < expected_count:
        record_failure(
            failures,
            f"comment {comment_id} replies incomplete: expected {expected_count}, observed {len(observed_ids)} unique replies",
        )
    return found


def scan_post_replies(
    *,
    post: dict[str, Any],
    cookie: str,
    user_id: str,
    count: int,
    page_limit: int,
    sub_reply_page_limit: int,
    delay: float,
    include_sub_replies: bool,
    failures: list[str] | None = None,
    activity: dict[str, int] | None = None,
) -> list[dict[str, Any]]:
    if not post.get("id"):
        return []
    if int(post.get("reply_count") or 0) <= 0:
        return []

    found: list[dict[str, Any]] = []
    observed_ids: set[str] = set()
    expected_comments = int(post.get("reply_count") or 0)
    if expected_comments > page_limit * count:
        record_failure(
            failures,
            f"post {post['id']} comments truncated: expected {expected_comments}, page limit covers {page_limit * count}"
        )
    for page in range(1, page_limit + 1):
        if activity is not None:
            activity["attempts"] += 1
        data = get_post_comments(post["id"], cookie, page=page, count=count)
        if data is None:
            record_failure(
                failures,
                f"post {post['id']} comments page {page} request failed",
            )
            break
        if activity is not None:
            activity["valid_responses"] += 1
        comments = payload_items(data, ("comments", "list"), "post comments")
        for comment in comments:
            observed_ids.add(required_id(comment.get("id"), "post comment"))
            if comment_user_id(comment) == str(user_id):
                found.append(normalize_reply(comment, post, "post_comments"))

            nested_reply_count = non_negative_record_int(
                preferred_field(comment, "reply_count", "replyCount"),
                "nested reply_count",
            )
            if include_sub_replies and nested_reply_count > 0:
                nested = scan_comment_replies(
                    comment_id=str(comment.get("id") or ""),
                    cookie=cookie,
                    user_id=user_id,
                    post=post,
                    count=count,
                    page_limit=sub_reply_page_limit,
                    delay=delay,
                    failures=failures,
                    expected_count=nested_reply_count,
                    activity=activity,
                )
                found.extend(nested)

        if pagination_complete(
            data,
            page,
            count,
            len(comments),
            observed_count=len(observed_ids),
        ):
            break
        if page == page_limit:
            record_failure(
                failures,
                f"post {post['id']} comments truncated: final page {page} did not prove pagination completion",
            )
        else:
            time.sleep(delay)

    if len(observed_ids) < expected_comments:
        record_failure(
            failures,
            f"post {post['id']} comments incomplete: expected {expected_comments}, observed {len(observed_ids)} unique comments",
        )

    return unique_sorted(found, "id", "reply", user_id)


def select_recent_posts(
    posts: list[dict[str, Any]],
    articles: list[dict[str, Any]],
    lookback_days: int,
    lookback_posts: int,
    user_id: str = "",
) -> list[dict[str, Any]]:
    merged = unique_sorted(posts + articles, "id", "post", user_id)
    if not merged:
        return []

    cutoff = datetime.now(SHANGHAI_TZ) - timedelta(days=lookback_days)
    recent: list[dict[str, Any]] = []
    for item in merged:
        parsed = parse_xueqiu_time(item.get("created_at"))
        if parsed and parsed >= cutoff:
            recent.append(item)
    if recent:
        return recent[:lookback_posts]
    return merged[:lookback_posts]


def sync_outputs(args: argparse.Namespace) -> int:
    if args.skip_posts and args.skip_articles and args.skip_comments:
        raise ValueError(
            "Refusing a no-op sync: posts, articles, and comments cannot all be skipped."
        )
    cookie = load_cookie(args)
    if not cookie:
        raise SystemExit("Missing cookie. Pass --cookie/--cookie-file or set XUEQIU_COOKIE.")

    user_id = str(args.user_id)
    output = args.output
    os.makedirs(output, exist_ok=True)

    posts_json = os.path.join(output, f"xueqiu_{user_id}_posts.json")
    posts_md = os.path.join(output, f"xueqiu_{user_id}_posts.md")
    articles_json = os.path.join(output, f"xueqiu_{user_id}_articles.json")
    articles_md = os.path.join(output, f"xueqiu_{user_id}_articles.md")
    replies_json = os.path.join(output, f"xueqiu_{user_id}_self_replies.json")
    replies_md = os.path.join(output, f"xueqiu_{user_id}_self_replies.md")
    state_json = os.path.join(output, f"xueqiu_{user_id}_sync_state.json")

    existing_posts = [normalize_post(item, user_id) for item in load_json(posts_json, [])]
    existing_articles = [normalize_post(item, user_id) for item in load_json(articles_json, [])]
    existing_replies = unique_sorted(
        load_json(replies_json, []),
        "id",
        "reply",
        user_id,
    )
    state = (
        validate_sync_state(load_json(state_json, {}), user_id)
        if os.path.exists(state_json)
        else {}
    )

    posts = existing_posts
    articles = existing_articles
    replies = existing_replies
    failures: list[str] = []
    activity = {"attempts": 0, "valid_responses": 0}

    if not args.skip_posts:
        incoming_posts = collect_timeline(
            fetch_fn=get_user_posts,
            user_id=user_id,
            cookie=cookie,
            pages=args.post_pages,
            count=args.count,
            since_date=args.since_date,
            delay=args.delay,
            label="posts",
            failures=failures,
            activity=activity,
        )
        posts = unique_sorted(existing_posts + incoming_posts, "id", "post", user_id)
        print(f"[posts] candidate_total={len(posts)} new={max(0, len(posts) - len(existing_posts))}")

    if not args.skip_articles:
        incoming_articles = collect_timeline(
            fetch_fn=get_user_articles,
            user_id=user_id,
            cookie=cookie,
            pages=args.article_pages,
            count=args.count,
            since_date=args.since_date,
            delay=args.delay,
            label="articles",
            failures=failures,
            activity=activity,
        )
        articles = unique_sorted(
            existing_articles + incoming_articles,
            "id",
            "post",
            user_id,
        )
        print(f"[articles] candidate_total={len(articles)} new={max(0, len(articles) - len(existing_articles))}")

    scanned_posts: list[dict[str, Any]] = []
    if not args.skip_comments:
        recent_posts = select_recent_posts(
            posts,
            articles,
            args.comment_lookback_days,
            args.comment_lookback_posts,
            user_id,
        )
        scanned_posts = recent_posts
        incoming_replies: list[dict[str, Any]] = []
        for index, post in enumerate(recent_posts, start=1):
            label = f"[comments] {index}/{len(recent_posts)} post={post.get('id')} replies={post.get('reply_count', 0)}"
            print(label)
            batch = scan_post_replies(
                post=post,
                cookie=cookie,
                user_id=user_id,
                count=args.comment_count,
                page_limit=args.comment_page_limit,
                sub_reply_page_limit=args.sub_reply_page_limit,
                delay=args.delay,
                include_sub_replies=not args.skip_sub_replies,
                failures=failures,
                activity=activity,
            )
            if batch:
                incoming_replies.extend(batch)
                print(f"{label} found={len(batch)}")
            if index < len(recent_posts):
                time.sleep(args.delay)
        replies = unique_sorted(
            existing_replies + incoming_replies,
            "id",
            "reply",
            user_id,
        )
        print(f"[comments] candidate_total={len(replies)} new={max(0, len(replies) - len(existing_replies))}")

    attempted_at = shanghai_now_iso()
    previous_complete_at = state.get("completed_at")
    had_existing_data = bool(existing_posts or existing_articles or existing_replies)
    all_remote_failed = bool(
        activity["attempts"]
        and activity["valid_responses"] == 0
        and failures
    )
    fatal_remote_failure = all_remote_failed and not had_existing_data
    if fatal_remote_failure:
        sync_status = "failed"
    elif failures:
        sync_status = "needs_verification"
    else:
        sync_status = "complete"
    corpus_updated = not failures
    if corpus_updated:
        if not args.skip_posts:
            save_json(posts_json, posts)
            save_markdown(
                posts_md,
                render_posts_markdown(posts, f"Xueqiu user {user_id} posts"),
            )
        if not args.skip_articles:
            save_json(articles_json, articles)
            save_markdown(
                articles_md,
                render_posts_markdown(articles, f"Xueqiu user {user_id} articles"),
            )
        if not args.skip_comments:
            save_json(replies_json, replies)
            save_markdown(
                replies_md,
                render_replies_markdown(replies, f"Xueqiu user {user_id} self replies"),
            )
    else:
        posts = existing_posts
        articles = existing_articles
        replies = existing_replies
        print("[sync] corpus promotion skipped because the run is incomplete")
    completed_at = previous_complete_at if failures else attempted_at
    summary = {
        "schema_version": SCHEMA_VERSION,
        "user_id": user_id,
        "status": sync_status,
        "attempted_at": attempted_at,
        "updated_at": attempted_at,
        "completed_at": completed_at,
        "failures": failures,
        "remote_attempts": activity["attempts"],
        "valid_responses": activity["valid_responses"],
        "corpus_updated": corpus_updated,
        "post_timeline_truncated": any(
            failure.startswith("posts truncated:") for failure in failures
        ),
        "article_timeline_truncated": any(
            failure.startswith("articles truncated:") for failure in failures
        ),
        "since_date": args.since_date,
        "posts_total": len(posts),
        "articles_total": len(articles),
        "self_replies_total": len(replies),
        "comment_scan_posts": len(scanned_posts),
        "comment_lookback_days": args.comment_lookback_days,
        "comment_lookback_posts": args.comment_lookback_posts,
        "latest_post_id": posts[0]["id"] if posts else None,
        "latest_post_time": posts[0]["created_at"] if posts else None,
        "latest_article_id": articles[0]["id"] if articles else None,
        "latest_article_time": articles[0]["created_at"] if articles else None,
        "latest_reply_id": replies[0]["id"] if replies else None,
        "latest_reply_time": replies[0]["created_at"] if replies else None,
        "skip_sub_replies": bool(args.skip_sub_replies),
        "previous_state": state.get("updated_at"),
    }
    save_json(state_json, summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if fatal_remote_failure:
        print("Sync failed: every remote request failed and no existing corpus is available.", file=sys.stderr)
        return 1
    if failures:
        print("Sync completed with partial request failures; inspect the state file and retry.", file=sys.stderr)
        return 2
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = ConfigArgumentParser(
        description="Incremental Xueqiu sync for posts, articles, and self replies.",
        epilog="Exit codes: 0=complete, 2=partial request failure/verification required, 1=local or configuration error.",
    )
    parser.add_argument("--cookie", help="Raw Xueqiu cookie header")
    parser.add_argument("--cookie-file", help="Read cookie from file")
    parser.add_argument("--user_id", type=valid_user_id, default="7143769715", help="Target user id")
    parser.add_argument("--output", default="output/bingbing_xiaomei_sync", help="Output directory")
    current_year = datetime.now(SHANGHAI_TZ).year
    parser.add_argument("--since-date", type=valid_iso_date, default=f"{current_year}-01-01", help="Keep only items from this date onward")
    parser.add_argument("--count", type=positive_int, default=20, help="Timeline page size")
    parser.add_argument("--post-pages", type=positive_int, default=6, help="Post timeline pages to fetch")
    parser.add_argument("--article-pages", type=positive_int, default=6, help="Article timeline pages to fetch")
    parser.add_argument("--comment-count", type=positive_int, default=50, help="Comments per page")
    parser.add_argument("--comment-page-limit", type=positive_int, default=4, help="Max pages per post comment scan")
    parser.add_argument("--sub-reply-page-limit", type=positive_int, default=3, help="Max pages per comment reply scan")
    parser.add_argument("--comment-lookback-days", type=positive_int, default=21, help="Only scan comments for recent posts within this many days")
    parser.add_argument("--comment-lookback-posts", type=positive_int, default=80, help="Hard cap on posts scanned for comments")
    parser.add_argument("--delay", type=non_negative_float, default=1.5, help="Delay between requests in seconds")
    parser.add_argument("--skip-posts", action="store_true", help="Skip timeline posts")
    parser.add_argument("--skip-articles", action="store_true", help="Skip article list")
    parser.add_argument("--skip-comments", action="store_true", help="Skip self replies")
    parser.add_argument("--skip-sub-replies", action="store_true", help="Do not crawl comments/replies.json")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return sync_outputs(args)
    except (JsonFileError, OSError, ValueError) as exc:
        print(f"Fatal sync error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
