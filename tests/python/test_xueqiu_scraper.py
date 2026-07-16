import json
import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import xueqiu_incremental_sync as incremental
import xueqiu_scraper as scraper


def valid_post(post_id="123", **overrides):
    record = {
        "schema_version": 1,
        "record_contract": "normalized_v1",
        "id": str(post_id),
        "created_at_raw": "2026-07-14T09:00:00+08:00",
        "created_at": "2026-07-14T09:00:00+08:00",
        "text": "body",
        "clean_text": "body",
        "target": f"https://xueqiu.com/7143769715/{post_id}",
        "reply_count": 1,
        "like_count": 2,
        "retweet_count": 3,
        "view_count": 4,
    }
    record.update(overrides)
    return record


def valid_reply(reply_id="456", post_id="123", **overrides):
    record = {
        "schema_version": 1,
        "record_contract": "normalized_v1",
        "id": str(reply_id),
        "created_at_raw": "2026-07-14T09:01:00+08:00",
        "created_at": "2026-07-14T09:01:00+08:00",
        "text": "reply",
        "clean_text": "reply",
        "post_id": str(post_id),
        "post_target": f"https://xueqiu.com/7143769715/{post_id}",
        "reply_count": 0,
        "like_count": 1,
    }
    record.update(overrides)
    return record


def valid_status(post_id=123, **overrides):
    record = {
        "id": post_id,
        "created_at": "2026-07-14T09:00:00+08:00",
        "text": "body",
        "reply_count": 1,
        "like_count": 2,
        "retweet_count": 3,
        "view_count": 4,
    }
    record.update(overrides)
    return record


def valid_comment(comment_id=8, post_id=123, user_id=7143769715, **overrides):
    record = {
        "id": comment_id,
        "status_id": post_id,
        "created_at": "2026-07-14T09:01:00+08:00",
        "text": "reply",
        "user": {"id": user_id},
        "like_count": 1,
        "reply_count": 0,
    }
    record.update(overrides)
    return record


class TimeNormalizationTests(unittest.TestCase):
    def test_numeric_time_is_formatted_in_shanghai(self):
        epoch_ms = int(datetime.fromisoformat("2026-07-13T04:34:56+00:00").timestamp() * 1000)
        self.assertEqual(scraper.format_xueqiu_time(epoch_ms), "2026-07-13T12:34:56+08:00")

    def test_early_2000_millisecond_epoch_is_not_misread_as_seconds(self):
        self.assertEqual(
            scraper.format_xueqiu_time(946_684_800_000),
            "2000-01-01T08:00:00+08:00",
        )

    def test_naive_time_is_interpreted_as_shanghai(self):
        parsed = scraper.parse_xueqiu_time("2026-07-13 12:34:56")
        self.assertEqual(parsed.isoformat(timespec="seconds"), "2026-07-13T12:34:56+08:00")

    def test_filter_since_uses_shanghai_boundary(self):
        items = [
            {"created_at": "2026-07-12T23:59:59+08:00"},
            {"created_at": "2026-07-13T00:00:00+08:00"},
        ]
        self.assertEqual(scraper.filter_since(items, "2026-07-13"), [items[1]])

    def test_only_explicitly_missing_time_is_normalized_to_unknown(self):
        for value in (None, 0, "", "unknown", "未知时间"):
            with self.subTest(value=value):
                self.assertEqual(scraper.format_xueqiu_time(value), "unknown")
        for value in ("not-a-timestamp", float("inf"), -1, False):
            with self.subTest(value=value), self.assertRaises(ValueError):
                scraper.format_xueqiu_time(value)

    def test_record_times_require_seconds_and_use_ascii_trim_only(self):
        invalid = (
            "1999-12-31T23:59:59+08:00",
            "2026-07-13",
            "2026-07-13T12:34",
            "2026-07-13T12:34:56.1234Z",
            "\u00852026-07-13T12:34:56+08:00",
        )
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                scraper.format_xueqiu_time(value)
        self.assertEqual(
            scraper.format_xueqiu_time(" \t2026-07-13T12:34:56+08:00\r\n"),
            "2026-07-13T12:34:56+08:00",
        )
        self.assertEqual(scraper.clean_html("\u0085body\u0085"), "\u0085body\u0085")
        with self.assertRaises(ValueError):
            scraper.format_xueqiu_time(946_655_999)

    def test_post_ids_and_relative_targets_are_canonical(self):
        [post] = scraper.extract_posts(
            {
                "statuses": [
                    valid_status(
                        created_at=None,
                        target="7143769715/123",
                    )
                ]
            }
        )
        self.assertEqual(post["id"], "123")
        self.assertEqual(post["record_contract"], "normalized_v1")
        self.assertEqual(post["created_at"], "unknown")
        self.assertEqual(post["target"], "https://xueqiu.com/7143769715/123")
        self.assertEqual(
            scraper.parse_post_ref(" \t123\r\n", "7143769715"),
            ("7143769715", "123"),
        )
        with self.assertRaises(ValueError):
            scraper.parse_post_ref("\u0085123", "7143769715")

    def test_missing_and_external_targets_follow_the_xueqiu_url_contract(self):
        [post] = scraper.extract_posts(
            {"statuses": [valid_status(created_at=None)]},
            "7143769715",
        )
        self.assertEqual(post["target"], "https://xueqiu.com/7143769715/123")
        self.assertEqual(
            scraper.canonical_xueqiu_target("http://xueqiu.com/7143769715/123"),
            "https://xueqiu.com/7143769715/123",
        )
        with self.assertRaises(ValueError):
            scraper.canonical_xueqiu_target(
                "https://example.com/123",
                "7143769715",
                "123",
            )
        with self.assertRaises(ValueError):
            scraper.canonical_xueqiu_target(
                "https://xueqiu.com/7143769715/999",
                "7143769715",
                "123",
            )
        with self.assertRaises(ValueError):
            scraper.canonical_xueqiu_target(
                "https://xueqiu.com/123",
                "7143769715",
                "123",
            )
        with self.assertRaises(ValueError):
            scraper.canonical_xueqiu_target("")

    def test_fallback_replies_include_the_parent_post_target(self):
        [reply] = scraper.extract_user_replies_from_comments(
            {
                "comments": [
                    valid_comment(created_at=None)
                ]
            },
            "7143769715",
        )
        self.assertEqual(reply["post_id"], "123")
        self.assertEqual(reply["record_contract"], "normalized_v1")
        self.assertEqual(reply["post_target"], "https://xueqiu.com/7143769715/123")

    def test_raw_timestamp_is_authoritative_when_normalizing_existing_records(self):
        post = incremental.normalize_post(
            valid_post(
                "2",
                created_at_raw="2026-07-14 09:00:00",
                created_at="2026-07-14T09:00:00+08:00",
                target="https://xueqiu.com/7143769715/2",
            ),
            "7143769715",
        )
        self.assertEqual(post["created_at"], "2026-07-14T09:00:00+08:00")


class DataContractTests(unittest.TestCase):
    def test_two_invalid_timestamps_cannot_compare_as_unknown(self):
        record = valid_post(
            created_at_raw="garbage-one",
            created_at="garbage-two",
        )
        with self.assertRaisesRegex(ValueError, "invalid Xueqiu timestamp"):
            incremental.normalize_post(record, "7143769715")

    def test_v1_normalized_time_must_already_be_canonical(self):
        with self.assertRaisesRegex(ValueError, "does not represent"):
            incremental.normalize_post(
                valid_post(created_at="2026-07-14 09:00:00"),
                "7143769715",
            )

    def test_post_contract_requires_numeric_id_text_counts_and_matching_url(self):
        invalid_records = (
            valid_post("post-1"),
            valid_post("１２３"),
            valid_post(schema_version=2),
            valid_post(target="https://xueqiu.com/7143769715/999"),
            valid_post(title=123),
            {key: value for key, value in valid_post().items() if key != "clean_text"},
            {key: value for key, value in valid_post().items() if key != "created_at_raw"},
            {key: value for key, value in valid_post().items() if key != "reply_count"},
            {key: value for key, value in valid_post().items() if key != "view_count"},
        )
        for record in invalid_records:
            with self.subTest(record=record), self.assertRaises(ValueError):
                incremental.normalize_post(record, "7143769715")

    def test_legacy_post_can_be_explicitly_upgraded_with_derived_clean_text(self):
        legacy = valid_post()
        del legacy["schema_version"]
        del legacy["record_contract"]
        del legacy["clean_text"]
        normalized = incremental.normalize_post(legacy, "7143769715")
        self.assertEqual(normalized["schema_version"], 1)
        self.assertEqual(normalized["record_contract"], "normalized_v1")
        self.assertEqual(normalized["clean_text"], "body")
        legacy_without_text = valid_post()
        del legacy_without_text["schema_version"]
        del legacy_without_text["record_contract"]
        del legacy_without_text["text"]
        with self.assertRaisesRegex(ValueError, "text must be a string"):
            incremental.normalize_post(legacy_without_text, "7143769715")

    def test_contract_without_schema_is_rejected_but_complete_v1_predecessor_upgrades(self):
        for record, normalizer in (
            (valid_post(), incremental.normalize_post),
            (valid_reply(), incremental.normalize_reply_record),
        ):
            malformed = dict(record)
            del malformed["schema_version"]
            with self.subTest(record=record), self.assertRaisesRegex(
                ValueError, "cannot be present without schema_version"
            ):
                normalizer(malformed, "7143769715")

            predecessor = dict(record)
            del predecessor["record_contract"]
            upgraded = normalizer(predecessor, "7143769715")
            self.assertEqual(upgraded["record_contract"], "normalized_v1")

    def test_v1_predecessor_does_not_backfill_strict_fields(self):
        for record, field, normalizer in (
            (valid_post(), "created_at_raw", incremental.normalize_post),
            (valid_post(), "clean_text", incremental.normalize_post),
            (valid_post(), "view_count", incremental.normalize_post),
            (valid_reply(), "reply_count", incremental.normalize_reply_record),
        ):
            predecessor = dict(record)
            del predecessor["record_contract"]
            del predecessor[field]
            with self.subTest(field=field), self.assertRaises(ValueError):
                normalizer(predecessor, "7143769715")

    def test_legacy_records_cannot_invent_missing_interaction_counts(self):
        for record, field, normalizer in (
            (valid_post(), "view_count", incremental.normalize_post),
            (valid_reply(), "reply_count", incremental.normalize_reply_record),
        ):
            legacy = dict(record)
            del legacy["schema_version"]
            del legacy["record_contract"]
            del legacy[field]
            with self.subTest(field=field), self.assertRaisesRegex(
                ValueError, f"{field} is required"
            ):
                normalizer(legacy, "7143769715")

    def test_explicit_noncanonical_record_contract_is_rejected(self):
        for record, normalizer in (
            (valid_post(record_contract="legacy_normalized_v1"), incremental.normalize_post),
            (valid_reply(record_contract="legacy_normalized_v1"), incremental.normalize_reply_record),
        ):
            with self.subTest(record=record), self.assertRaisesRegex(
                ValueError, "record_contract"
            ):
                normalizer(record, "7143769715")

    def test_normalized_counts_are_strict_but_raw_api_numeric_strings_are_explicitly_supported(self):
        for value in (True, "1", 1.0, "", scraper.MAX_SAFE_INTEGER + 1):
            with self.subTest(value=value), self.assertRaises(ValueError):
                incremental.normalize_post(
                    valid_post(reply_count=value),
                    "7143769715",
                )
        self.assertEqual(scraper.non_negative_record_int("12", "count"), 12)
        self.assertEqual(scraper.non_negative_record_int(" \t12\r\n", "count"), 12)
        self.assertEqual(scraper.non_negative_record_int(12.0, "count"), 12)
        for value in (
            True,
            "",
            " \t",
            "\u008512",
            "12\u0085",
            "-1",
            "1.0",
            1.5,
            scraper.MAX_SAFE_INTEGER + 1,
        ):
            with self.subTest(raw=value), self.assertRaises(ValueError):
                scraper.non_negative_record_int(value, "count")

    def test_normalized_ids_are_strict_strings_but_legacy_and_raw_ids_migrate(self):
        invalid = (
            (valid_post(id=123), incremental.normalize_post),
            (valid_post(id=" 123"), incremental.normalize_post),
            (valid_post(id="\u0085123"), incremental.normalize_post),
            (valid_reply(id=456), incremental.normalize_reply_record),
            (dict(valid_reply(), post_id=123), incremental.normalize_reply_record),
            (valid_reply(reply_to=9), incremental.normalize_reply_record),
        )
        for record, normalizer in invalid:
            with self.subTest(record=record), self.assertRaises(ValueError):
                normalizer(record, "7143769715")

        legacy = valid_post(id=123)
        del legacy["schema_version"]
        del legacy["record_contract"]
        self.assertEqual(
            incremental.normalize_post(legacy, "7143769715")["id"],
            "123",
        )
        [raw] = scraper.extract_posts(
            {"statuses": [valid_status(post_id=123)]},
            "7143769715",
        )
        self.assertEqual(raw["id"], "123")
        self.assertEqual(scraper.numeric_record_id(123.0), "123")
        self.assertEqual(scraper.numeric_record_id(" \t123\r\n"), "123")
        with self.assertRaises(ValueError):
            scraper.numeric_record_id("\u0085123")

    def test_missing_title_is_not_synthesized(self):
        self.assertNotIn(
            "title", incremental.normalize_post(valid_post(), "7143769715")
        )
        [without_title] = scraper.extract_posts(
            {"statuses": [valid_status()]}, "7143769715"
        )
        self.assertNotIn("title", without_title)
        [with_title] = scraper.extract_posts(
            {"statuses": [valid_status(title="<b>Title</b>")]},
            "7143769715",
        )
        self.assertEqual(with_title["title"], "Title")

    def test_reply_secondary_timestamp_requires_and_validates_raw_pair(self):
        generated = incremental.normalize_reply(
            valid_comment(), valid_post(), "post_comments"
        )
        self.assertEqual(
            generated["post_created_at_raw"], "2026-07-14T09:00:00+08:00"
        )
        self.assertEqual(
            generated["post_created_at"], "2026-07-14T09:00:00+08:00"
        )
        for missing in ("created_at", "text"):
            raw = valid_comment()
            del raw[missing]
            with self.subTest(missing=missing), self.assertRaisesRegex(
                ValueError, f"reply {'timestamp' if missing == 'created_at' else 'text'} is missing"
            ):
                incremental.normalize_reply(raw, valid_post(), "post_comments")
        with self.assertRaisesRegex(ValueError, "source must be a string"):
            incremental.normalize_reply(
                valid_comment(source=0), valid_post(), "post_comments"
            )
        with self.assertRaisesRegex(ValueError, "must be present together"):
            incremental.normalize_reply_record(
                valid_reply(post_created_at="2026-07-14T09:00:00+08:00"),
                "7143769715",
            )
        legacy_one_sided = valid_reply(
            post_created_at="2026-07-14T09:00:00+08:00"
        )
        del legacy_one_sided["schema_version"]
        del legacy_one_sided["record_contract"]
        with self.assertRaisesRegex(ValueError, "must be present together"):
            incremental.normalize_reply_record(
                legacy_one_sided,
                "7143769715",
            )
        paired = incremental.normalize_reply_record(
            valid_reply(
                post_created_at_raw="2026-07-14 09:00:00",
                post_created_at="2026-07-14T09:00:00+08:00",
            ),
            "7143769715",
        )
        self.assertEqual(paired["post_created_at_raw"], "2026-07-14 09:00:00")
        with self.assertRaisesRegex(ValueError, "does not represent"):
            incremental.normalize_reply_record(
                valid_reply(
                    post_created_at_raw="2026-07-14 09:00:00",
                    post_created_at="2026-07-14T10:00:00+08:00",
                ),
                "7143769715",
            )
        with self.assertRaisesRegex(ValueError, "post creation timestamp"):
            incremental.unique_sorted(
                [
                    valid_reply(
                        post_created_at_raw="2026-07-14 09:00:00",
                        post_created_at="2026-07-14T09:00:00+08:00",
                    ),
                    valid_reply(
                        post_created_at_raw="2026-07-14 10:00:00",
                        post_created_at="2026-07-14T10:00:00+08:00",
                    ),
                ],
                "id",
                "reply",
                "7143769715",
            )

    def test_raw_posts_drop_retweeted_status_but_declared_normalized_records_reject_it(self):
        payload = {
            "statuses": [
                valid_status(
                    retweeted_status={
                        "id": 99,
                        "user": {"id": 8, "screen_name": "unrelated"},
                    }
                )
            ]
        }
        [extracted] = scraper.extract_posts(payload, "7143769715")
        self.assertNotIn("retweeted_status", extracted)
        with self.assertRaisesRegex(ValueError, "unknown fields: retweeted_status"):
            incremental.normalize_post(
                valid_post(retweeted_status=payload["statuses"][0]["retweeted_status"]),
                "7143769715",
            )
        predecessor = valid_post(
            retweeted_status=payload["statuses"][0]["retweeted_status"]
        )
        del predecessor["record_contract"]
        normalized = incremental.normalize_post(predecessor, "7143769715")
        self.assertNotIn("retweeted_status", normalized)

    def test_normalized_records_reject_unknown_fields_and_kind_mixing(self):
        invalid = (
            (valid_post(cookie="secret"), incremental.normalize_post),
            (valid_post(user={"id": "7"}), incremental.normalize_post),
            (valid_post(post_link="https://xueqiu.com/7143769715/123"), incremental.normalize_post),
            (valid_reply(target="https://xueqiu.com/7143769715/456"), incremental.normalize_reply_record),
            (valid_reply(raw_user={"id": "7"}), incremental.normalize_reply_record),
        )
        for record, normalizer in invalid:
            with self.subTest(record=record), self.assertRaises(ValueError):
                normalizer(record, "7143769715")

        invalid_reply_metadata = (
            valid_reply(mode=1),
            valid_reply(status_id=1),
            valid_reply(status_id="999"),
            valid_reply(user_id=None),
            valid_reply(created_ms="1"),
            valid_reply(fetched_from_page=0),
            valid_reply(legacy_migrated_fields=["x", "x"]),
        )
        for record in invalid_reply_metadata:
            with self.subTest(record=record), self.assertRaises(ValueError):
                incremental.normalize_reply_record(record, "7143769715")

    def test_raw_acquisition_rejects_conflicting_contract_markers(self):
        for status in (
            valid_status(schema_version=1),
            valid_status(record_contract="normalized_v1"),
            valid_status(schema_version=2, record_contract="normalized_v1"),
            valid_status(schema_version=1, record_contract="normalized_v2"),
        ):
            with self.subTest(status=status), self.assertRaisesRegex(
                ValueError, "conflicting normalized record contract"
            ):
                scraper.extract_posts({"statuses": [status]}, "7143769715")

    def test_duplicate_reply_cannot_change_parent_or_reply_chain(self):
        conflicts = (
            valid_reply(post_id="999", post_target="https://xueqiu.com/7143769715/999"),
            valid_reply(post_target="https://xueqiu.com/7143769715/123?source=changed"),
            valid_reply(reply_to="8"),
            valid_reply(in_reply_to_comment_id="8"),
        )
        existing = valid_reply(reply_to="7", in_reply_to_comment_id="7")
        for incoming in conflicts:
            with self.subTest(incoming=incoming), self.assertRaisesRegex(
                ValueError, "changed"
            ):
                incremental.unique_sorted(
                    [existing, incoming],
                    "id",
                    "reply",
                    "7143769715",
                )

    def test_duplicate_post_cannot_change_canonical_target(self):
        with self.assertRaisesRegex(ValueError, "changed its canonical target"):
            incremental.unique_sorted(
                [
                    valid_post(target="https://xueqiu.com/7143769715/123?source=one"),
                    valid_post(target="https://xueqiu.com/7143769715/123?source=two"),
                ],
                "id",
                "post",
                "7143769715",
            )

    def test_utf8_text_score_and_numeric_id_tie_break_are_deterministic(self):
        [merged] = incremental.unique_sorted(
            [
                valid_post("1", text="😀😀", clean_text="😀😀"),
                valid_post("1", text="abc", clean_text="abc"),
            ],
            "id",
            "post",
            "7143769715",
        )
        self.assertEqual(merged["text"], "😀😀")
        [unicode_whitespace] = incremental.unique_sorted(
            [
                valid_post("1", text="\u0085", clean_text="\u0085", title="\u0085"),
                valid_post("1", text="a", clean_text="a", title="a"),
            ],
            "id",
            "post",
            "7143769715",
        )
        self.assertEqual(unicode_whitespace["text"], "\u0085")
        self.assertEqual(unicode_whitespace["title"], "\u0085")
        ordered = incremental.unique_sorted(
            [valid_post("2"), valid_post("10"), valid_post("1")],
            "id",
            "post",
            "7143769715",
        )
        self.assertEqual([record["id"] for record in ordered], ["10", "2", "1"])

    def test_sparse_post_update_preserves_rich_text_and_accepts_current_counters(self):
        existing = valid_post(
            text="rich <b>body</b>",
            clean_text="rich body",
            reply_count=10,
            like_count=20,
            retweet_count=5,
            view_count=8,
        )
        sparse = valid_post(
            text="",
            clean_text="",
            reply_count=0,
            like_count=0,
            retweet_count=0,
            view_count=0,
        )
        [merged] = incremental.unique_sorted(
            [existing, sparse],
            "id",
            "post",
            "7143769715",
        )
        self.assertEqual(merged["text"], "rich <b>body</b>")
        self.assertEqual(merged["clean_text"], "rich body")
        self.assertEqual(merged["reply_count"], 0)
        self.assertEqual(merged["like_count"], 0)
        self.assertEqual(merged["retweet_count"], 0)
        self.assertEqual(merged["view_count"], 0)

    def test_sparse_reply_update_preserves_rich_text_and_accepts_current_counts(self):
        existing = valid_reply(text="rich", clean_text="rich", like_count=9, reply_count=4)
        sparse = valid_reply(text="", clean_text="", like_count=0, reply_count=0)
        [merged] = incremental.unique_sorted(
            [existing, sparse],
            "id",
            "reply",
            "7143769715",
        )
        self.assertEqual(merged["text"], "rich")
        self.assertEqual(merged["clean_text"], "rich")
        self.assertEqual(merged["like_count"], 0)
        self.assertEqual(merged["reply_count"], 0)

    def test_duplicate_id_with_conflicting_real_times_is_rejected(self):
        later = valid_post(
            created_at_raw="2026-07-14T10:00:00+08:00",
            created_at="2026-07-14T10:00:00+08:00",
        )
        with self.assertRaisesRegex(ValueError, "conflicting created_at"):
            incremental.unique_sorted(
                [valid_post(), later],
                "id",
                "post",
                "7143769715",
            )


class AtomicStorageTests(unittest.TestCase):
    def test_atomic_json_write_replaces_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "data.json")
            scraper.atomic_write_json(path, {"version": 1})
            scraper.atomic_write_json(path, {"version": 2})
            with open(path, encoding="utf-8") as handle:
                self.assertEqual(json.load(handle), {"version": 2})
            self.assertEqual(os.listdir(directory), ["data.json"])

    def test_incremental_loader_fails_closed_on_corrupt_json(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "state.json")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("{broken")
            with self.assertRaises(incremental.JsonFileError):
                incremental.load_json(path, {})
            with open(path, encoding="utf-8") as handle:
                self.assertEqual(handle.read(), "{broken")

    def test_incremental_loader_validates_shape(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "state.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump([], handle)
            with self.assertRaises(incremental.JsonFileError):
                incremental.load_json(path, {})

    def test_incremental_loader_rejects_every_invalid_corpus_record(self):
        invalid_corpora = (
            [None],
            [{}],
            [{"id": ""}],
            [{"id": False}],
            [{"id": {"nested": "invalid"}}],
            [{"id": "7"}, {"id": 7}],
        )
        for corpus in invalid_corpora:
            with self.subTest(corpus=corpus), tempfile.TemporaryDirectory() as directory:
                path = os.path.join(directory, "corpus.json")
                original = json.dumps(corpus)
                with open(path, "w", encoding="utf-8") as handle:
                    handle.write(original)
                with self.assertRaises(incremental.JsonFileError):
                    incremental.load_json(path, [])
                with open(path, encoding="utf-8") as handle:
                    self.assertEqual(handle.read(), original)

    def test_incremental_main_does_not_overwrite_invalid_existing_corpus(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "xueqiu_7143769715_posts.json")
            original = '[{"id": ""}]'
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(original)
            with patch.object(incremental, "get_user_posts") as fetch, redirect_stdout(
                io.StringIO()
            ), redirect_stderr(io.StringIO()):
                code = incremental.main(
                    [
                        "--cookie",
                        "sanitized-test-cookie",
                        "--output",
                        directory,
                        "--skip-comments",
                    ]
                )
            self.assertEqual(code, 1)
            fetch.assert_not_called()
            with open(path, encoding="utf-8") as handle:
                self.assertEqual(handle.read(), original)

    def test_invalid_existing_counts_fail_before_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "xueqiu_7143769715_posts.json")
            original = '[{"id":"7","reply_count":-1}]'
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(original)
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                code = incremental.main(
                    [
                        "--cookie",
                        "sanitized-test-cookie",
                        "--output",
                        directory,
                        "--skip-comments",
                    ]
                )
            self.assertEqual(code, 1)
            with open(path, encoding="utf-8") as handle:
                self.assertEqual(handle.read(), original)

    def test_mismatched_raw_and_normalized_time_fails_before_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "xueqiu_7143769715_posts.json")
            original = (
                '[{"id":"7","created_at_raw":"2026-07-14 09:00:00",'
                '"created_at":"2026-07-14T10:00:00+08:00"}]'
            )
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(original)
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                code = incremental.main(
                    [
                        "--cookie",
                        "sanitized-test-cookie",
                        "--output",
                        directory,
                        "--skip-comments",
                    ]
                )
            self.assertEqual(code, 1)
            with open(path, encoding="utf-8") as handle:
                self.assertEqual(handle.read(), original)

    def test_reply_missing_parent_reference_fails_before_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(
                directory,
                "xueqiu_7143769715_self_replies.json",
            )
            original = '[{"id":"8","created_at":"invalid","origin":"post_comments"}]'
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(original)
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                code = incremental.main(
                    [
                        "--cookie",
                        "sanitized-test-cookie",
                        "--output",
                        directory,
                        "--skip-posts",
                        "--skip-articles",
                        "--skip-comments",
                    ]
                )
            self.assertEqual(code, 1)
            with open(path, encoding="utf-8") as handle:
                self.assertEqual(handle.read(), original)


class ApiResponseTests(unittest.TestCase):
    def test_html_only_page_cannot_fabricate_normalized_counts(self):
        class Response:
            status_code = 200
            text = "<html><h1>Title</h1><article>Body</article></html>"

        with patch.object(scraper, "request_get", return_value=Response()), redirect_stdout(
            io.StringIO()
        ):
            self.assertIsNone(scraper.fetch_post_page("7", "123", "cookie"))

    def test_http_200_api_error_is_not_treated_as_data(self):
        class Response:
            text = '{"error_code":10020}'

            @staticmethod
            def json():
                return {"error_code": 10020, "error_description": "blocked"}

        with redirect_stdout(io.StringIO()):
            self.assertIsNone(scraper.parse_json_response(Response(), "test"))

    def test_valid_payload_is_returned(self):
        class Response:
            text = '{"statuses":[]}'

            @staticmethod
            def json():
                return {"statuses": []}

        self.assertEqual(
            scraper.parse_json_response(Response(), "test", list_keys=("statuses",)),
            {"statuses": []},
        )

    def test_empty_captcha_and_wrong_endpoint_shapes_are_rejected(self):
        class Response:
            text = "sanitized"

            def __init__(self, payload):
                self.payload = payload

            def json(self):
                return self.payload

        invalid_payloads = (
            {},
            {"captcha": "required"},
            {"comments": []},
            {"statuses": {}},
            {"statuses": [None]},
            {"statuses": [{"text": "missing id"}]},
        )
        for payload in invalid_payloads:
            with self.subTest(payload=payload), redirect_stdout(io.StringIO()):
                self.assertIsNone(
                    scraper.parse_json_response(
                        Response(payload),
                        "timeline",
                        list_keys=("statuses", "list", "items"),
                    )
                )

    def test_timeline_endpoint_rejects_comment_payload_on_http_200(self):
        class Response:
            status_code = 200
            text = '{"comments":[]}'

            @staticmethod
            def json():
                return {"comments": []}

        with patch.object(scraper, "request_get", return_value=Response()) as request, redirect_stdout(
            io.StringIO()
        ):
            result = scraper.get_user_posts("7", "cookie", page=1, count=10)
        self.assertIsNone(result)
        self.assertEqual(request.call_count, 3)

    def test_article_list_is_hydrated_from_matching_status_detail(self):
        class Response:
            status_code = 200
            headers = {}

            def __init__(self, payload):
                self.payload = payload
                self.text = json.dumps(payload)

            def json(self):
                return self.payload

        list_item = {
            "id": 7,
            "created_at": "2026-07-14T09:00:00+08:00",
            "description": "summary",
            "view_count": 40,
        }
        detail = valid_status(7, text="complete article", view_count=0)
        with patch.object(
            scraper,
            "request_get",
            side_effect=[Response({"list": [list_item]}), Response(detail)],
        ) as request, redirect_stdout(io.StringIO()):
            result = scraper.get_user_articles("7143769715", "cookie", count=1)
        self.assertEqual(request.call_count, 2)
        self.assertEqual(result["list"][0]["text"], "complete article")
        self.assertEqual(result["list"][0]["view_count"], 40)

        with patch.object(
            scraper,
            "request_get",
            side_effect=[Response({"list": [list_item]}), Response(valid_status(8))],
        ), redirect_stdout(io.StringIO()):
            self.assertIsNone(
                scraper.get_user_articles("7143769715", "cookie", count=1)
            )

    def test_transient_status_is_retried_with_bounded_backoff(self):
        class Response:
            def __init__(self, status_code):
                self.status_code = status_code
                self.headers = {}

        responses = [Response(503), Response(200)]
        with patch.object(scraper.requests, "get", side_effect=responses) as request, patch.object(
            scraper.time, "sleep"
        ) as sleep, patch.object(scraper.random, "uniform", return_value=0):
            result = scraper.request_get("https://example.invalid", attempts=3, timeout=1)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(request.call_count, 2)
        sleep.assert_called_once_with(0.5)


class PaginationTests(unittest.TestCase):
    def test_explicit_more_metadata_overrides_short_page_heuristic(self):
        self.assertFalse(
            scraper.pagination_complete(
                {"comments": [], "has_more": True},
                page=1,
                count=20,
                item_count=0,
            )
        )
        self.assertFalse(
            scraper.pagination_complete(
                {"comments": [{"id": 1}], "total": 2},
                page=1,
                count=20,
                item_count=1,
            )
        )
        self.assertFalse(
            scraper.pagination_complete(
                {"comments": [{"id": 1}], "pagination": {"max_page": 2}},
                page=1,
                count=20,
                item_count=1,
            )
        )

    def test_pagination_metadata_can_prove_completion(self):
        self.assertTrue(
            scraper.pagination_complete(
                {"comments": [{"id": 1}], "has_more": False},
                page=1,
                count=1,
                item_count=1,
            )
        )
        self.assertTrue(
            scraper.pagination_complete(
                {
                    "page": {"page_no": "2"},
                    "page_info": {"next_cursor": "0"},
                    "meta": {"totalPages": "2", "total_count": "2"},
                },
                page=2,
                count=2,
                item_count=1,
                observed_count=2,
            )
        )

    def test_valid_cross_dimension_conflicts_remain_incomplete(self):
        conflicting = (
            {"has_more": False, "max_page": 2},
            {"has_more": False, "total": 2},
            {"has_more": True, "total": 1},
            {"next_cursor": "cursor-2", "total": 1},
        )
        for payload in conflicting:
            with self.subTest(payload=payload):
                self.assertFalse(
                    scraper.pagination_complete(
                        payload,
                        page=1,
                        count=1,
                        item_count=1,
                        observed_count=1,
                    )
                )
        self.assertTrue(
            scraper.pagination_complete(
                {"comments": [{"id": 1}], "meta": {"maxPage": 1, "totalCount": 1}},
                page=1,
                count=1,
                item_count=1,
            )
        )

    def test_invalid_or_conflicting_pagination_metadata_fails_closed(self):
        invalid_payloads = (
            {"has_more": "maybe"},
            {"max_page": 0},
            {"total": -1},
            {"meta": "invalid"},
            {"has_more": True, "meta": {"hasMore": False}},
            {"total": 2, "meta": {"totalCount": 3}},
            {"max_page": 2, "meta": {"pageCount": 3}},
            {"page": 1, "meta": {"page_no": 2}},
            {"next_id": "cursor-a", "page_info": {"nextCursor": "cursor-b"}},
        )
        for payload in invalid_payloads:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                scraper.pagination_complete(
                    payload,
                    page=1,
                    count=1,
                    item_count=1,
                )

    def test_overlapping_pages_use_cumulative_unique_ids_for_total(self):
        calls = []

        def fetch(post_id, cookie, page=1, count=2, since_id=None):
            calls.append(page)
            ids = (1, 2) if page == 1 else (2, 3)
            return {
                "comments": [
                    valid_comment(comment_id, post_id=post_id, user_id=8)
                    for comment_id in ids
                ],
                "total": 3,
            }

        failures = []
        with patch.object(incremental, "get_post_comments", side_effect=fetch):
            incremental.scan_post_replies(
                post=valid_post("123", reply_count=3),
                cookie="cookie",
                user_id="7143769715",
                count=2,
                page_limit=2,
                sub_reply_page_limit=1,
                delay=0,
                include_sub_replies=False,
                failures=failures,
            )
        self.assertEqual(calls, [1, 2])
        self.assertEqual(failures, [])

    def test_reply_pages_are_requested_and_deduplicated(self):
        calls = []

        def fake_comments(post_id, cookie, page=1, count=20, since_id=None):
            calls.append((post_id, page, count))
            if page == 1:
                return {
                    "comments": [
                        valid_comment(
                            1,
                            post_id=1,
                            user_id=7,
                            created_at=1_700_000_000_000,
                            text="a",
                        ),
                        valid_comment(
                            9,
                            post_id=1,
                            user_id=8,
                            created_at=1_700_000_000_000,
                            text="other",
                        ),
                    ]
                }
            return {
                "comments": [
                    valid_comment(
                        2,
                        post_id=1,
                        user_id=7,
                        created_at=1_700_000_001_000,
                        text="b",
                    )
                ]
            }

        with tempfile.TemporaryDirectory() as directory, patch.object(
            scraper, "get_post_comments", side_effect=fake_comments
        ), patch.object(scraper.time, "sleep"), redirect_stdout(io.StringIO()):
            replies, failed = scraper.scrape_replies_from_posts(
                [{"id": "1"}],
                "7",
                "cookie",
                directory,
                delay=0,
                reply_pages=2,
                comment_count=2,
                return_status=True,
            )

        self.assertFalse(failed)
        self.assertEqual(calls, [("1", 1, 2), ("1", 2, 2)])
        self.assertEqual([reply["id"] for reply in replies], ["1", "2"])

    def test_request_failure_is_reported_as_partial(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            scraper, "get_post_comments", return_value=None
        ), redirect_stdout(io.StringIO()):
            replies, failed = scraper.scrape_replies_from_posts(
                [{"id": "1"}],
                "7",
                "cookie",
                directory,
                delay=0,
                reply_pages=2,
                return_status=True,
            )
        self.assertEqual(replies, [])
        self.assertTrue(failed)

    def test_page_limit_truncation_is_reported_as_partial(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            scraper,
            "get_post_comments",
            return_value={"comments": [valid_comment(1, post_id=1, user_id=7)]},
        ), redirect_stdout(io.StringIO()):
            _, failed = scraper.scrape_replies_from_posts(
                [{"id": "1", "reply_count": 101}],
                "7",
                "cookie",
                directory,
                delay=0,
                reply_pages=2,
                comment_count=50,
                return_status=True,
            )
        self.assertTrue(failed)

    def test_incremental_scan_records_page_limit_truncation(self):
        failures = []
        with patch.object(incremental, "get_post_comments", return_value={"comments": []}):
            incremental.scan_post_replies(
                post={"id": "1", "reply_count": 101},
                cookie="cookie",
                user_id="7",
                count=50,
                page_limit=2,
                sub_reply_page_limit=1,
                delay=0,
                include_sub_replies=False,
                failures=failures,
            )
        self.assertTrue(failures)
        self.assertTrue(all("truncated" in failure or "incomplete" in failure for failure in failures))

    def test_full_final_timeline_page_records_truncation(self):
        failures = []
        activity = {"attempts": 0, "valid_responses": 0}
        payload = {
            "statuses": [
                valid_status(2, created_at="2026-07-14T10:00:00+08:00"),
                valid_status(1, created_at="2026-07-14T09:00:00+08:00"),
            ]
        }
        with redirect_stdout(io.StringIO()):
            posts = incremental.collect_timeline(
                fetch_fn=lambda *args, **kwargs: payload,
                user_id="7",
                cookie="cookie",
                pages=1,
                count=2,
                since_date="2026-07-01",
                delay=0,
                label="posts",
                failures=failures,
                activity=activity,
            )
        self.assertEqual([post["id"] for post in posts], ["2", "1"])
        self.assertEqual(activity, {"attempts": 1, "valid_responses": 1})
        self.assertEqual(len(failures), 1)
        self.assertIn("truncated", failures[0])

    def test_marked_pinned_timeline_overflow_is_retained_but_not_pageable(self):
        failures = []
        payload = {
            "statuses": [
                valid_status(
                    9,
                    created_at="2025-01-01T09:00:00+08:00",
                    mark=1,
                ),
                valid_status(2, created_at="2026-07-14T10:00:00+08:00"),
                valid_status(1, created_at="2026-07-14T09:00:00+08:00"),
            ]
        }
        with redirect_stdout(io.StringIO()):
            posts = incremental.collect_timeline(
                fetch_fn=lambda *args, **kwargs: payload,
                user_id="7",
                cookie="cookie",
                pages=1,
                count=2,
                since_date=None,
                delay=0,
                label="posts",
                failures=failures,
            )
        self.assertEqual([post["id"] for post in posts], ["2", "1", "9"])
        self.assertEqual(len(failures), 1)
        self.assertIn("truncated", failures[0])

        invalid = {"statuses": [valid_status(9), valid_status(2), valid_status(1)]}
        with redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError, "unexplained items"):
                incremental.collect_timeline(
                    fetch_fn=lambda *args, **kwargs: invalid,
                    user_id="7",
                    cookie="cookie",
                    pages=1,
                    count=2,
                    since_date=None,
                    delay=0,
                    label="posts",
                )

    def test_since_boundary_without_terminator_is_not_assumed_complete(self):
        failures = []
        payload = {
            "statuses": [
                valid_status(2, created_at="2026-07-14T10:00:00+08:00"),
                valid_status(1, created_at="2026-06-30T23:59:59+08:00"),
            ]
        }
        with redirect_stdout(io.StringIO()):
            posts = incremental.collect_timeline(
                fetch_fn=lambda *args, **kwargs: payload,
                user_id="7",
                cookie="cookie",
                pages=1,
                count=2,
                since_date="2026-07-01",
                delay=0,
                label="posts",
                failures=failures,
            )
        self.assertEqual([post["id"] for post in posts], ["2"])
        self.assertEqual(len(failures), 1)
        self.assertIn("truncated", failures[0])

    def test_ordered_confirmation_page_proves_since_boundary(self):
        failures = []
        calls = []

        def fetch(*args, page, **kwargs):
            calls.append(page)
            if page == 1:
                statuses = [
                    valid_status(4, created_at="2026-07-14T10:00:00+08:00"),
                    valid_status(3, created_at="2026-06-30T23:59:59+08:00"),
                ]
            else:
                statuses = [
                    valid_status(2, created_at="2026-06-30T22:00:00+08:00"),
                    valid_status(1, created_at="2026-06-30T21:00:00+08:00"),
                ]
            return {"statuses": statuses, "total": 100}

        with redirect_stdout(io.StringIO()):
            posts = incremental.collect_timeline(
                fetch_fn=fetch,
                user_id="7",
                cookie="cookie",
                pages=2,
                count=2,
                since_date="2026-07-01",
                delay=0,
                label="posts",
                failures=failures,
            )
        self.assertEqual(calls, [1, 2])
        self.assertEqual([post["id"] for post in posts], ["4"])
        self.assertEqual(failures, [])

    def test_old_pinned_item_does_not_stop_later_timeline_pages(self):
        calls = []

        def fetch(*args, page, **kwargs):
            calls.append(page)
            if page == 1:
                return {
                    "statuses": [
                        valid_status(1, created_at="2026-06-01T00:00:00+08:00"),
                        valid_status(3, created_at="2026-07-14T10:00:00+08:00"),
                    ]
                }
            return {
                "statuses": [
                    valid_status(2, created_at="2026-07-14T09:00:00+08:00"),
                ]
            }

        failures = []
        with redirect_stdout(io.StringIO()):
            posts = incremental.collect_timeline(
                fetch_fn=fetch,
                user_id="7",
                cookie="cookie",
                pages=2,
                count=2,
                since_date="2026-07-01",
                delay=0,
                label="posts",
                failures=failures,
            )
        self.assertEqual(calls, [1, 2])
        self.assertEqual([post["id"] for post in posts], ["3", "2"])
        self.assertEqual(failures, [])

    def test_full_comment_page_without_terminator_is_truncated(self):
        failures = []
        with patch.object(
            incremental,
            "get_post_comments",
            return_value={"comments": [valid_comment(10, user_id=8)]},
        ):
            incremental.scan_post_replies(
                post=valid_post("123"),
                cookie="cookie",
                user_id="7143769715",
                count=1,
                page_limit=1,
                sub_reply_page_limit=1,
                delay=0,
                include_sub_replies=False,
                failures=failures,
            )
        self.assertTrue(any("final page" in failure for failure in failures))

    def test_full_nested_reply_page_without_terminator_is_truncated(self):
        failures = []
        with patch.object(
            incremental,
            "get_comment_replies",
            return_value={"comments": [{"id": 10, "user": {"id": 8}}]},
        ):
            incremental.scan_comment_replies(
                comment_id="9",
                cookie="cookie",
                user_id="7143769715",
                post=valid_post("123"),
                count=1,
                page_limit=1,
                delay=0,
                failures=failures,
                expected_count=1,
            )
        self.assertTrue(any("final page" in failure for failure in failures))

    def test_explicit_has_more_false_proves_full_page_complete(self):
        failures = []
        with patch.object(
            incremental,
            "get_post_comments",
            return_value={
                "comments": [valid_comment(10, user_id=8)],
                "has_more": False,
            },
        ):
            incremental.scan_post_replies(
                post=valid_post("123"),
                cookie="cookie",
                user_id="7143769715",
                count=1,
                page_limit=1,
                sub_reply_page_limit=1,
                delay=0,
                include_sub_replies=False,
                failures=failures,
            )
        self.assertEqual(failures, [])


class SyncStatusTests(unittest.TestCase):
    @staticmethod
    def argv(output, *extra):
        return [
            "--cookie",
            "sanitized-test-cookie",
            "--output",
            output,
            "--post-pages",
            "1",
            "--article-pages",
            "1",
            "--count",
            "2",
            "--delay",
            "0",
            "--skip-comments",
            *extra,
        ]

    @staticmethod
    def load_state(output):
        path = os.path.join(output, "xueqiu_7143769715_sync_state.json")
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)

    def test_new_directory_with_all_remote_failures_is_failed_exit_one(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            incremental, "get_user_posts", return_value=None
        ), patch.object(incremental, "get_user_articles", return_value=None), redirect_stdout(
            io.StringIO()
        ), redirect_stderr(io.StringIO()):
            code = incremental.main(self.argv(directory))
            state = self.load_state(directory)
            self.assertFalse(
                os.path.exists(
                    os.path.join(directory, "xueqiu_7143769715_posts.json")
                )
            )
            self.assertFalse(
                os.path.exists(
                    os.path.join(directory, "xueqiu_7143769715_articles.json")
                )
            )
        self.assertEqual(code, 1)
        self.assertEqual(state["status"], "failed")
        self.assertEqual(state["remote_attempts"], 2)
        self.assertEqual(state["valid_responses"], 0)

    def test_existing_data_with_all_remote_failures_needs_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            posts_path = os.path.join(directory, "xueqiu_7143769715_posts.json")
            scraper.atomic_write_json(
                posts_path,
                [valid_post()],
            )
            with open(posts_path, encoding="utf-8") as handle:
                original = handle.read()
            posts_md = os.path.join(directory, "xueqiu_7143769715_posts.md")
            with open(posts_md, "w", encoding="utf-8") as handle:
                handle.write("sentinel markdown")
            with patch.object(incremental, "get_user_posts", return_value=None), patch.object(
                incremental, "get_user_articles", return_value=None
            ), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                code = incremental.main(self.argv(directory))
                state = self.load_state(directory)
            self.assertEqual(code, 2)
            self.assertEqual(state["status"], "needs_verification")
            self.assertFalse(state["corpus_updated"])
            with open(posts_path, encoding="utf-8") as handle:
                self.assertEqual(handle.read(), original)
            with open(posts_md, encoding="utf-8") as handle:
                self.assertEqual(handle.read(), "sentinel markdown")

    def test_partial_failure_does_not_promote_any_successful_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            posts_path = os.path.join(directory, "xueqiu_7143769715_posts.json")
            articles_path = os.path.join(directory, "xueqiu_7143769715_articles.json")
            scraper.atomic_write_json(posts_path, [valid_post("123")])
            scraper.atomic_write_json(articles_path, [valid_post("200")])
            with open(posts_path, encoding="utf-8") as handle:
                original_posts = handle.read()
            with open(articles_path, encoding="utf-8") as handle:
                original_articles = handle.read()
            successful_posts = {
                "statuses": [
                    valid_status(
                        124,
                        created_at="2026-07-14T10:00:00+08:00",
                        text="new",
                    )
                ]
            }
            with patch.object(
                incremental, "get_user_posts", return_value=successful_posts
            ), patch.object(
                incremental, "get_user_articles", return_value=None
            ), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                code = incremental.main(self.argv(directory))
                state = self.load_state(directory)
            self.assertEqual(code, 2)
            self.assertFalse(state["corpus_updated"])
            with open(posts_path, encoding="utf-8") as handle:
                self.assertEqual(handle.read(), original_posts)
            with open(articles_path, encoding="utf-8") as handle:
                self.assertEqual(handle.read(), original_articles)

    def test_complete_run_promotes_candidate_and_marks_state(self):
        payload = {
            "statuses": [
                valid_status(
                    124,
                    created_at="2026-07-14T10:00:00+08:00",
                    text="new",
                )
            ]
        }
        with tempfile.TemporaryDirectory() as directory, patch.object(
            incremental, "get_user_posts", return_value=payload
        ), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            code = incremental.main(self.argv(directory, "--skip-articles"))
            state = self.load_state(directory)
            with open(
                os.path.join(directory, "xueqiu_7143769715_posts.json"),
                encoding="utf-8",
            ) as handle:
                posts = json.load(handle)
        self.assertEqual(code, 0)
        self.assertEqual(state["status"], "complete")
        self.assertTrue(state["corpus_updated"])
        self.assertEqual([post["id"] for post in posts], ["124"])

    def test_all_three_skips_are_rejected_instead_of_reported_complete(self):
        with tempfile.TemporaryDirectory() as directory, redirect_stdout(
            io.StringIO()
        ), redirect_stderr(io.StringIO()):
            code = incremental.main(
                self.argv(
                    directory,
                    "--skip-posts",
                    "--skip-articles",
                )
            )
            self.assertEqual(code, 1)
            self.assertEqual(os.listdir(directory), [])

    def test_garbage_remote_time_fails_without_writing_corpus(self):
        payload = {"statuses": [valid_status(124, created_at="garbage")]}
        with tempfile.TemporaryDirectory() as directory, patch.object(
            incremental, "get_user_posts", return_value=payload
        ), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            code = incremental.main(self.argv(directory, "--skip-articles"))
            self.assertEqual(code, 1)
            self.assertFalse(
                os.path.exists(
                    os.path.join(directory, "xueqiu_7143769715_posts.json")
                )
            )

    def test_fallback_scraper_garbage_time_returns_one_without_output(self):
        payload = {"statuses": [valid_status(124, created_at="garbage")]}
        with tempfile.TemporaryDirectory() as directory, patch.object(
            scraper, "get_user_posts", return_value=payload
        ), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            code = scraper.main(
                [
                    "--cookie",
                    "sanitized-test-cookie",
                    "--output",
                    directory,
                    "--pages",
                    "1",
                    "--count",
                    "2",
                    "--delay",
                    "0",
                ]
            )
            written_files = os.listdir(directory)
        self.assertEqual(code, 1)
        self.assertEqual(written_files, [])

    def test_full_final_page_produces_needs_verification_exit_two(self):
        payload = {
            "statuses": [
                valid_status(2, created_at="2026-07-14T10:00:00+08:00"),
                valid_status(1, created_at="2026-07-14T09:00:00+08:00"),
            ]
        }
        with tempfile.TemporaryDirectory() as directory, patch.object(
            incremental, "get_user_posts", return_value=payload
        ), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            code = incremental.main(self.argv(directory, "--skip-articles"))
            state = self.load_state(directory)
            corpus_exists = os.path.exists(
                os.path.join(directory, "xueqiu_7143769715_posts.json")
            )
        self.assertEqual(code, 2)
        self.assertEqual(state["status"], "needs_verification")
        self.assertTrue(state["post_timeline_truncated"])
        self.assertFalse(state["article_timeline_truncated"])
        self.assertTrue(any("truncated" in failure for failure in state["failures"]))
        self.assertFalse(state["corpus_updated"])
        self.assertFalse(corpus_exists)

    def test_fallback_scraper_full_final_page_exits_two(self):
        payload = {
            "statuses": [
                valid_status(2, created_at="2026-07-14T10:00:00+08:00"),
                valid_status(1, created_at="2026-07-14T09:00:00+08:00"),
            ]
        }
        with tempfile.TemporaryDirectory() as directory, patch.object(
            scraper, "get_user_posts", return_value=payload
        ), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            code = scraper.main(
                [
                    "--cookie",
                    "sanitized-test-cookie",
                    "--output",
                    directory,
                    "--pages",
                    "1",
                    "--count",
                    "2",
                    "--delay",
                    "0",
                    "--since-date",
                    "2026-07-01",
                ]
            )
            corpus_exists = os.path.exists(
                os.path.join(directory, "xueqiu_8469219487_posts.json")
            )
        self.assertEqual(code, 2)
        self.assertFalse(corpus_exists)

    def test_fallback_scraper_valid_empty_then_failure_is_partial(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            scraper, "get_user_posts", return_value={"statuses": []}
        ), patch.object(scraper, "get_user_articles", return_value=None), redirect_stdout(
            io.StringIO()
        ), redirect_stderr(io.StringIO()):
            code = scraper.main(
                [
                    "--cookie",
                    "sanitized-test-cookie",
                    "--output",
                    directory,
                    "--mode",
                    "both",
                    "--pages",
                    "1",
                    "--count",
                    "2",
                    "--delay",
                    "0",
                ]
            )
            written_files = os.listdir(directory)
        self.assertEqual(code, 2)
        self.assertEqual(written_files, [])

    def test_fallback_partial_failure_preserves_existing_output_bytes(self):
        payload = {
            "statuses": [
                valid_status(
                    124,
                    created_at="2026-07-14T10:00:00+08:00",
                    text="new",
                )
            ]
        }
        with tempfile.TemporaryDirectory() as directory:
            posts_path = os.path.join(directory, "xueqiu_8469219487_posts.json")
            with open(posts_path, "w", encoding="utf-8") as handle:
                handle.write('{"sentinel":true}')
            with patch.object(
                scraper, "get_user_posts", return_value=payload
            ), patch.object(
                scraper, "get_user_articles", return_value=None
            ), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                code = scraper.main(
                    [
                        "--cookie",
                        "sanitized-test-cookie",
                        "--output",
                        directory,
                        "--mode",
                        "both",
                        "--pages",
                        "1",
                        "--count",
                        "2",
                        "--delay",
                        "0",
                    ]
                )
            with open(posts_path, encoding="utf-8") as handle:
                preserved = handle.read()
        self.assertEqual(code, 2)
        self.assertEqual(preserved, '{"sentinel":true}')


class ArgumentValidationTests(unittest.TestCase):
    def test_rejects_non_positive_pages(self):
        parser = scraper.build_parser()
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            parser.parse_args(["--pages", "0"])

    def test_rejects_invalid_date(self):
        parser = incremental.build_parser()
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            parser.parse_args(["--since-date", "2026-13-40"])

    def test_rejects_non_ascii_user_id_digits(self):
        parser = incremental.build_parser()
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            parser.parse_args(["--user_id", "７１４３７６９７１５"])


if __name__ == "__main__":
    unittest.main()
