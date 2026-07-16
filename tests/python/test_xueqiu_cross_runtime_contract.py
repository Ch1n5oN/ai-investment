import copy
import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import xueqiu_incremental_sync as incremental
import xueqiu_scraper as scraper


with (ROOT / "tests/fixtures/xueqiu-normalization-golden.json").open(encoding="utf-8") as handle:
    GOLDEN = json.load(handle)


def normalize(item):
    record = copy.deepcopy(item["input"])
    if item["kind"] == "reply":
        return incremental.normalize_reply_record(record, item["user_id"])
    return incremental.normalize_post(record, item["user_id"])


class CrossRuntimeGoldenContractTests(unittest.TestCase):
    def assert_subset(self, actual, expected, label):
        self.assertEqual(
            {key: actual.get(key) for key in expected},
            expected,
            label,
        )

    def test_clean_html_contract(self):
        for item in GOLDEN["clean_html_cases"]:
            with self.subTest(item["name"]):
                self.assertEqual(scraper.clean_html(item["input"]), item["expected"])

    def test_normalization_contract(self):
        for item in GOLDEN["normalization_cases"]:
            with self.subTest(item["name"]):
                self.assert_subset(normalize(item), item["expected"], item["name"])
        for item in GOLDEN["invalid_normalization_cases"]:
            with self.subTest(item["name"]), self.assertRaises(ValueError):
                normalize(item)

    def test_merge_contract(self):
        for item in GOLDEN["merge_cases"]:
            with self.subTest(item["name"]):
                actual = incremental.unique_sorted(
                    copy.deepcopy(item["existing"] + item["incoming"]),
                    "id",
                    item["kind"],
                    item["user_id"],
                )
                self.assertEqual(len(actual), len(item["expected"]))
                for result, expected in zip(actual, item["expected"], strict=True):
                    self.assert_subset(result, expected, item["name"])


if __name__ == "__main__":
    unittest.main()
