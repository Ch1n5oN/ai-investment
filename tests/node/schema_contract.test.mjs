import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  archivedRecordArrays,
  declaredSegments,
  skillDir,
} from "../../.claude/skills/bingbing-xiaomei-perspective/scripts/build_corpus_manifest.mjs";
import {
  declaredSegments as donggeSegments,
  skillDir as donggeSkillDir,
} from "../../.claude/skills/dongge-perspective/scripts/build_corpus_manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const recordSchema = JSON.parse(fs.readFileSync(path.join(ROOT, "schemas/xueqiu-record.schema.json"), "utf8"));
const reportSchema = JSON.parse(fs.readFileSync(path.join(ROOT, "schemas/sync-report.schema.json"), "utf8"));
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
});
addFormats(ajv);
const validateRecord = ajv.compile(recordSchema);
const validateReport = ajv.compile(reportSchema);

function schemaErrors(validate) {
  return ajv.errorsText(validate.errors, { separator: "\n" });
}

test("every canonical and archived normalized record satisfies its declared JSON schema contract", () => {
  for (const segment of [...declaredSegments, ...archivedRecordArrays]) {
    const records = JSON.parse(fs.readFileSync(path.join(skillDir, segment.path), "utf8"));
    for (const [index, record] of records.entries()) {
      assert.equal(
        validateRecord(record),
        true,
        `${segment.path}[${index}]\n${schemaErrors(validateRecord)}`,
      );
    }
  }
  for (const segment of donggeSegments) {
    const records = JSON.parse(fs.readFileSync(path.join(donggeSkillDir, segment.path), "utf8"));
    for (const [index, record] of records.entries()) {
      assert.equal(
        validateRecord(record),
        true,
        `${segment.path}[${index}]\n${schemaErrors(validateRecord)}`,
      );
    }
  }
});

test("record contract discriminates strict, no-view, and legacy shapes", () => {
  const base = {
    schema_version: 1,
    record_contract: "normalized_v1",
    id: "1",
    created_at_raw: "2026-07-15 10:00:00",
    created_at: "2026-07-15T10:00:00+08:00",
    target: "https://xueqiu.com/7143769715/1",
    text: "body",
    clean_text: "body",
    reply_count: 0,
    like_count: 0,
    retweet_count: 0,
    view_count: 0,
  };
  assert.equal(validateRecord(base), true, schemaErrors(validateRecord));

  const missingView = structuredClone(base);
  delete missingView.view_count;
  assert.equal(validateRecord(missingView), false);
  missingView.record_contract = "normalized_without_view_count_v1";
  assert.equal(validateRecord(missingView), true, schemaErrors(validateRecord));

  const ambiguous = structuredClone(base);
  delete ambiguous.record_contract;
  assert.equal(validateRecord(ambiguous), false);

  assert.equal(validateRecord({ ...base, cookie: "must-not-enter-normalized-data" }), false);
  assert.equal(validateRecord({ ...base, retweeted_status: { id: "2" } }), false);
  assert.equal(validateRecord({ ...base, reply_count: 9007199254740992 }), false);
  assert.equal(validateRecord({ ...base, created_ms: 9007199254740992 }), false);
  assert.equal(validateRecord({ ...base, fetched_from_page: 9007199254740992 }), false);
  assert.equal(validateRecord({
    ...base,
    created_at_raw: "1999-12-31 23:59:59",
    created_at: "1999-12-31T23:59:59+08:00",
  }), false);

  const unicodeWhitespaceUnknown = structuredClone(base);
  unicodeWhitespaceUnknown.created_at_raw = "\u0085";
  unicodeWhitespaceUnknown.created_at = "unknown";
  assert.equal(validateRecord(unicodeWhitespaceUnknown), false);

  const reply = {
    ...base,
    post_id: "9",
    post_target: "https://xueqiu.com/7143769715/9",
  };
  delete reply.target;
  delete reply.retweet_count;
  delete reply.view_count;
  assert.equal(validateRecord(reply), true, schemaErrors(validateRecord));
  assert.equal(validateRecord({ ...reply, post_created_at: "unknown" }), false);
  assert.equal(validateRecord({ ...reply, post_created_at_raw: null }), false);
  assert.equal(validateRecord({
    ...reply,
    post_created_at_raw: null,
    post_created_at: "2026-07-15T10:00:00+08:00",
  }), false);
  assert.equal(validateRecord({
    ...reply,
    post_created_at_raw: null,
    post_created_at: "unknown",
  }), true, schemaErrors(validateRecord));
});

test("sync report schema is executable in CI", () => {
  const report = {
    schema_version: 1,
    user_id: "7143769715",
    started_at: "2026-07-15T10:00:00.000Z",
    finished_at: "2026-07-15T10:01:00.000Z",
    status: "complete",
    metrics: { requests: 3, errors: 0, waf: 0 },
    interface_drift: { detected: false, signals: [] },
  };
  assert.equal(validateReport(report), true, schemaErrors(validateReport));
  const visibilityGap = {
    post_id: "400171105",
    declared_count: 57,
    visible_count: 56,
    unavailable_count: 1,
    count_source: "comment_endpoint_final_page",
  };
  assert.equal(validateReport({
    ...report,
    comment_visibility_gaps: [visibilityGap],
  }), true, schemaErrors(validateReport));
  assert.equal(validateReport({
    ...report,
    comment_visibility_gaps: [{ ...visibilityGap, unavailable_count: 0 }],
  }), false);
  assert.equal(validateReport({
    ...report,
    comment_visibility_gaps: [{ ...visibilityGap, extra: true }],
  }), false);
  assert.equal(validateReport({ ...report, user_id: "" }), false);
  const unfinished = structuredClone(report);
  delete unfinished.finished_at;
  assert.equal(validateReport(unfinished), false);
  assert.equal(validateReport({ ...report, status: "failed" }), false);
  assert.equal(validateReport({
    ...report,
    status: "failed",
    error: { code: "HTTP_ERROR", message: "request failed" },
  }), true, schemaErrors(validateReport));
  assert.equal(validateReport({ ...report, error: { code: "X", message: "unexpected" } }), false);
  assert.equal(validateReport({
    ...report,
    interface_drift: {
      detected: true,
      signals: [{
        source: "sync",
        category: "response_contract",
        code: "INVALID_RESPONSE_SHAPE",
        message: "statuses must be an array",
      }],
    },
  }), true, schemaErrors(validateReport));
  assert.equal(validateReport({
    ...report,
    interface_drift: { detected: false, signals: [{ code: "INVALID_JSON" }] },
  }), false);
  assert.equal(validateReport({
    schema_version: 1,
    user_id: "7143769715",
    started_at: "2026-07-15T10:00:00.000Z",
    status: "running",
    metrics: { requests: 0, errors: 0, waf: 0 },
  }), true, schemaErrors(validateReport));
});
