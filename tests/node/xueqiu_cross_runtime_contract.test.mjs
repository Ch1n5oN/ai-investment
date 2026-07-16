import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  cleanHtml,
  mergeById,
  upgradeRecord,
} from "../../scripts/lib/xueqiu_core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GOLDEN = JSON.parse(fs.readFileSync(
  path.join(ROOT, "tests/fixtures/xueqiu-normalization-golden.json"),
  "utf8",
));

function assertSubset(actual, expected, label) {
  assert.deepEqual(
    Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key]])),
    expected,
    label,
  );
}

test("Node cleanHtml follows the shared cross-runtime golden contract", () => {
  for (const item of GOLDEN.clean_html_cases) {
    assert.equal(cleanHtml(item.input), item.expected, item.name);
  }
});

test("Node normalizes post and reply records using the shared golden contract", () => {
  for (const item of GOLDEN.normalization_cases) {
    assertSubset(upgradeRecord(item.input), item.expected, item.name);
  }
  for (const item of GOLDEN.invalid_normalization_cases) {
    assert.throws(() => upgradeRecord(item.input), { code: "INVALID_RECORD" }, item.name);
  }
});

test("Node merge semantics follow the shared golden contract", () => {
  for (const item of GOLDEN.merge_cases) {
    const actual = mergeById(item.existing, item.incoming);
    assert.equal(actual.length, item.expected.length, item.name);
    item.expected.forEach((expected, index) => assertSubset(actual[index], expected, item.name));
  }
});
