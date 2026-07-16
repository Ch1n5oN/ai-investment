import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RECORD_CONTRACT,
  atomicWrite,
  asciiTrim,
  canonicalTarget,
  checkpointStateForUser,
  classifyHtmlResponse,
  classifyJsonResponse,
  cleanHtml,
  commentCoverageFor,
  confirmedPostIdsFor,
  exitCodeForStatus,
  extractArrayField,
  formatTime,
  initialCheckpointState,
  isValidCheckpointState,
  mergeById,
  normalizeNonNegativeInteger,
  paginationComplete,
  parseArgs,
  parseIntegerOption,
  parseNumberOption,
  readJsonStrict,
  renderMarkdown,
  selectChangedPosts,
  syncStatusFor,
  toEpochMs,
  updatePostReplyCounts,
  upgradeRecord,
  validateDateOption,
  validateUserId,
} from "../../scripts/lib/xueqiu_core.mjs";

function normalizedPost(overrides = {}) {
  const id = String(overrides.id ?? "1");
  const createdAtRaw = overrides.created_at_raw ?? "2026-07-13 02:00:00";
  const text = overrides.text ?? "post body";
  return {
    schema_version: 1,
    record_contract: RECORD_CONTRACT,
    id,
    created_at_raw: createdAtRaw,
    created_at: formatTime(createdAtRaw),
    text,
    clean_text: cleanHtml(text),
    target: `https://xueqiu.com/7/${id}`,
    reply_count: 2,
    like_count: 3,
    retweet_count: 4,
    view_count: 5,
    ...overrides,
  };
}

function normalizedReply(overrides = {}) {
  const id = String(overrides.id ?? "10");
  const postId = String(overrides.post_id ?? "1");
  const createdAtRaw = overrides.created_at_raw ?? "2026-07-13 02:01:00";
  const text = overrides.text ?? "reply body";
  return {
    schema_version: 1,
    record_contract: RECORD_CONTRACT,
    id,
    created_at_raw: createdAtRaw,
    created_at: formatTime(createdAtRaw),
    text,
    clean_text: cleanHtml(text),
    post_id: postId,
    post_target: `https://xueqiu.com/7/${postId}`,
    reply_count: 0,
    like_count: 1,
    ...overrides,
  };
}

test("formats numeric and naive timestamps in Asia/Shanghai", () => {
  assert.equal(formatTime(Date.parse("2026-07-13T04:34:56Z")), "2026-07-13T12:34:56+08:00");
  assert.equal(formatTime("2026-07-13 12:34:56"), "2026-07-13T12:34:56+08:00");
  assert.equal(formatTime("2026-07-13T12:34:56"), "2026-07-13T12:34:56+08:00");
  assert.equal(toEpochMs("2026-07-13T12:34:56+08:00"), Date.parse("2026-07-13T04:34:56Z"));
  assert.equal(formatTime("2024-02-29T12:34:56.12Z"), "2024-02-29T20:34:56+08:00");
  const earliestShanghaiEpoch = Date.parse("1999-12-31T16:00:00Z");
  assert.equal(toEpochMs(earliestShanghaiEpoch), earliestShanghaiEpoch);
  assert.equal(toEpochMs(earliestShanghaiEpoch / 1000), earliestShanghaiEpoch);
  for (const invalid of [
    "2026-07-13",
    "2026-02-29 12:00:00",
    "2026-02-30 12:00:00",
    "2026-07-13 24:00:00",
    "2026-07-13 12:60:00",
    "2026-07-13T12:00:00.1234Z",
    "1999-12-31T23:59:59+08:00",
  ]) {
    assert.equal(toEpochMs(invalid), null, invalid);
    assert.equal(formatTime(invalid), "unknown", invalid);
  }
  assert.equal(toEpochMs(Date.parse("1999-12-31T15:59:59Z")), null);
});

test("canonicalizes relative targets without corrupting absolute URLs", () => {
  assert.equal(canonicalTarget("/714/123"), "https://xueqiu.com/714/123");
  assert.equal(canonicalTarget("https://xueqiu.com/714/123"), "https://xueqiu.com/714/123");
  assert.equal(canonicalTarget("//xueqiu.com/714/123"), "https://xueqiu.com/714/123");
  assert.equal(canonicalTarget("http://xueqiu.com/714/123"), "https://xueqiu.com/714/123");
  assert.equal(canonicalTarget("", "714", "123"), "https://xueqiu.com/714/123");
  assert.throws(
    () => canonicalTarget("https://example.com/not-xueqiu", "714", "123"),
    { code: "INVALID_TARGET" },
  );
  assert.throws(() => canonicalTarget("https://example.com/not-xueqiu"), { code: "INVALID_TARGET" });
  assert.throws(() => canonicalTarget(""), { code: "INVALID_TARGET" });
  assert.throws(() => canonicalTarget("https://xueqiu.com:8443/714/123"), { code: "INVALID_TARGET" });
  assert.throws(() => canonicalTarget("http://xueqiu.com:80/714/123"), { code: "INVALID_TARGET" });
  assert.throws(
    () => canonicalTarget("https://xueqiu.com/999/123", "714", "123"),
    { code: "INVALID_TARGET" },
  );
  assert.throws(
    () => canonicalTarget("https://xueqiu.com/714/999", "714", "123"),
    { code: "INVALID_TARGET" },
  );
});

test("cleans HTML entities and renders stable post/reply markdown", () => {
  assert.equal(cleanHtml("<p>A&amp;B<br>C&nbsp;D</p>"), "A&B\nC D");
  assert.equal(asciiTrim("\t body \r\n"), "body");
  assert.equal(asciiTrim("\u0085body\u0085"), "\u0085body\u0085");
  assert.equal(cleanHtml("\u0085body\u0085"), "\u0085body\u0085");
  const posts = renderMarkdown(
    [{ id: "1", created_at: "2026-07-13T12:00:00+08:00", target: "https://xueqiu.com/1/1", text: "<b>body</b>" }],
    "posts",
  );
  assert.match(posts, /Post 1/);
  assert.match(posts, /body/);
  const replies = renderMarkdown(
    [{ id: "2", created_at: "2026-07-13T12:01:00+08:00", post_id: "1", clean_text: "reply" }],
    "self replies",
  );
  assert.match(replies, /Reply 1/);
  assert.match(replies, /Post ID: 1/);
});

test("strict JSON loading fails closed on corruption and shape mismatch", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xueqiu-core-"));
  try {
    const file = path.join(directory, "state.json");
    fs.writeFileSync(file, "{broken", "utf8");
    assert.throws(() => readJsonStrict(file, { defaultValue: {} }), { code: "INVALID_JSON_FILE" });
    fs.writeFileSync(file, "[]", "utf8");
    assert.throws(
      () => readJsonStrict(file, { defaultValue: {}, validate: (value) => !Array.isArray(value) }),
      { code: "INVALID_JSON_SHAPE" },
    );
    assert.deepEqual(readJsonStrict(path.join(directory, "missing.json"), { defaultValue: { first: true } }), {
      first: true,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("atomic writes replace content and leave no temporary files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xueqiu-atomic-"));
  try {
    const file = path.join(directory, "data.json");
    atomicWrite(file, "first");
    atomicWrite(file, "second");
    assert.equal(fs.readFileSync(file, "utf8"), "second");
    assert.deepEqual(fs.readdirSync(directory), ["data.json"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("merge preserves rich fields, accepts count decreases, and sorts by actual time", () => {
  const merged = mergeById(
    [normalizedPost({
      id: "1",
      created_at_raw: "2026-07-12T12:00:00+08:00",
      created_at: "2026-07-12T12:00:00+08:00",
      text: "complete historical body",
      clean_text: "complete historical body",
      reply_count: 10,
    })],
    [
      normalizedPost({
        id: "1",
        created_at_raw: "2026-07-12T12:00:00+08:00",
        created_at: "2026-07-12T12:00:00+08:00",
        text: "",
        clean_text: "",
        reply_count: 8,
      }),
      normalizedPost({
        id: "2",
        created_at_raw: "2026-07-13T01:00:00+08:00",
        created_at: "2026-07-13T01:00:00+08:00",
      }),
    ],
  );
  assert.deepEqual(merged.map((item) => item.id), ["2", "1"]);
  assert.equal(merged[1].text, "complete historical body");
  assert.equal(merged[1].reply_count, 8);
  assert.equal(merged[0].schema_version, 1);
  assert.equal(merged[0].record_contract, RECORD_CONTRACT);
  assert.equal(merged[0].created_at_raw, "2026-07-13T01:00:00+08:00");

  const legacy = upgradeRecord({
    id: 3,
    created_at: "2026-07-13 02:00:00",
    target: "/7/3",
    text: "legacy",
    reply_count: "0",
    like_count: 0,
    retweet_count: 0,
    view_count: 0,
  });
  assert.equal(legacy.id, "3");
  assert.equal(legacy.clean_text, "legacy");
  assert.equal(legacy.view_count, 0);
  assert.ok(legacy.legacy_migrated_fields.includes("created_at_raw"));
  assert.equal(legacy.record_contract, RECORD_CONTRACT);
  assert.throws(
    () => upgradeRecord({ id: 4, created_at: "2026-07-13 02:00:00", target: "/7/4", text: "legacy" }),
    { code: "INVALID_RECORD" },
  );
  assert.throws(
    () => upgradeRecord({
      id: 4,
      created_at: "2026-07-13 02:00:00",
      target: "/7/4",
      clean_text: "clean-only legacy",
      reply_count: 0,
      like_count: 0,
      retweet_count: 0,
      view_count: 0,
    }),
    { code: "INVALID_RECORD" },
  );

  const mergedReply = mergeById(
    [normalizedReply({ reply_to: "99", text: "complete reply", clean_text: "complete reply" })],
    [normalizedReply({ reply_to: null, text: "", clean_text: "", reply_count: 0 })],
  )[0];
  assert.equal(mergedReply.reply_to, "99");
  assert.equal(mergedReply.text, "complete reply");
  assert.throws(
    () => upgradeRecord({
      id: 5,
      created_at_raw: "2026-07-13 03:00:00",
      created_at: "2026-07-13T04:00:00+08:00",
      target: "/7/5",
      text: "body",
    }),
    { code: "INVALID_RECORD" },
  );
  assert.throws(() => mergeById([{ created_at: "2026-07-13 02:00:00" }], []), {
    code: "INVALID_RECORD",
  });
  assert.throws(() => upgradeRecord({ id: "6", created_at: "2026-07-13 02:00:00" }), {
    code: "INVALID_RECORD",
  });
  assert.throws(
    () => upgradeRecord({ id: "7", post_id: "1", created_at: "2026-07-13 02:00:00" }),
    { code: "INVALID_RECORD" },
  );
  assert.equal(normalizeNonNegativeInteger("4", "reply_count"), 4);
  assert.equal(normalizeNonNegativeInteger(" \t4\r\n", "reply_count"), 4);
  assert.equal(normalizeNonNegativeInteger(4.0, "reply_count"), 4);
  assert.throws(() => normalizeNonNegativeInteger("bad", "reply_count"), { code: "INVALID_RECORD" });
  for (const invalidCount of [true, false, "", " \t", "4.0", "+4", "\u00854", null, undefined]) {
    assert.throws(
      () => normalizeNonNegativeInteger(invalidCount, "reply_count"),
      { code: "INVALID_RECORD" },
    );
  }
});

test("merge richness uses ASCII-trimmed UTF-8 bytes and deterministic numeric ID ties", () => {
  const merged = mergeById(
    [normalizedPost({ id: "2", text: "éé", clean_text: "éé" })],
    [normalizedPost({ id: "2", text: "aaa", clean_text: "aaa" })],
  );
  assert.equal(merged[0].text, "éé");
  assert.deepEqual(
    mergeById([], [
      normalizedPost({ id: "9" }),
      normalizedPost({ id: "10" }),
      normalizedPost({ id: "2" }),
    ]).map((item) => item.id),
    ["10", "9", "2"],
  );
});

test("normalized records fail closed on incomplete fields, bad ids, duplicates, and URL mismatches", () => {
  assert.deepEqual(upgradeRecord(normalizedPost()), normalizedPost());
  assert.deepEqual(upgradeRecord(normalizedReply()), normalizedReply());
  const withoutContract = normalizedPost();
  delete withoutContract.record_contract;
  assert.equal(upgradeRecord(withoutContract).record_contract, RECORD_CONTRACT);
  const incompletePredecessor = { ...withoutContract };
  delete incompletePredecessor.reply_count;
  assert.throws(() => upgradeRecord(incompletePredecessor), { code: "INVALID_RECORD" });
  for (const field of ["created_at_raw", "text", "clean_text"]) {
    const invalidPredecessor = { ...withoutContract };
    delete invalidPredecessor[field];
    assert.throws(() => upgradeRecord(invalidPredecessor), { code: "INVALID_RECORD" });
  }
  const withoutSchema = normalizedPost();
  delete withoutSchema.schema_version;
  assert.throws(() => upgradeRecord(withoutSchema), { code: "INVALID_RECORD" });
  assert.throws(
    () => upgradeRecord(normalizedPost({ record_contract: "normalized_v2" })),
    { code: "INVALID_RECORD" },
  );

  for (const field of ["text", "clean_text", "reply_count", "like_count", "retweet_count", "view_count"]) {
    const invalid = normalizedPost();
    delete invalid[field];
    assert.throws(() => upgradeRecord(invalid), { code: "INVALID_RECORD" }, `missing ${field}`);
  }
  const objectId = normalizedPost();
  objectId.id = { nested: true };
  assert.throws(() => upgradeRecord(objectId), { code: "INVALID_RECORD" });
  assert.throws(() => upgradeRecord({ ...normalizedPost(), id: 1 }), { code: "INVALID_RECORD" });
  assert.throws(() => upgradeRecord(normalizedReply({ post_id: 1 })), { code: "INVALID_RECORD" });
  assert.throws(() => upgradeRecord(normalizedReply({ reply_to: 99 })), { code: "INVALID_RECORD" });
  assert.throws(
    () => upgradeRecord(normalizedReply({ post_created_at: "2026-07-13T02:00:00+08:00" })),
    { code: "INVALID_RECORD" },
  );
  assert.throws(
    () => upgradeRecord(normalizedReply({
      post_created_at_raw: null,
      post_created_at: "2026-07-13",
    })),
    { code: "INVALID_RECORD" },
  );
  const replyWithPostTime = upgradeRecord(normalizedReply({
    post_created_at_raw: "2026-07-13 02:00:00",
    post_created_at: "2026-07-13T02:00:00+08:00",
  }));
  assert.equal(replyWithPostTime.post_created_at_raw, "2026-07-13 02:00:00");
  for (const field of ["title", "post_title", "post_text", "origin", "source", "mode", "post_excerpt"]) {
    assert.throws(
      () => upgradeRecord(normalizedReply({ [field]: 123 })),
      { code: "INVALID_RECORD" },
    );
  }
  assert.throws(
    () => upgradeRecord(normalizedReply({ status_id: 1 })),
    { code: "INVALID_RECORD" },
  );
  assert.throws(
    () => upgradeRecord(normalizedReply({ status_id: "999" })),
    { code: "INVALID_RECORD" },
  );
  assert.throws(
    () => upgradeRecord(normalizedReply({ created_ms: -1 })),
    { code: "INVALID_RECORD" },
  );
  assert.throws(
    () => upgradeRecord(normalizedPost({ retweeted_status: { id: "999" } })),
    { code: "INVALID_RECORD" },
  );
  const rawNestedPredecessor = normalizedPost({ retweeted_status: { id: "999" } });
  delete rawNestedPredecessor.record_contract;
  assert.equal(Object.hasOwn(upgradeRecord(rawNestedPredecessor), "retweeted_status"), false);
  assert.throws(() => upgradeRecord(normalizedPost({ cookie: "secret" })), { code: "INVALID_RECORD" });
  assert.throws(
    () => upgradeRecord(normalizedReply({ target: "https://xueqiu.com/7/10" })),
    { code: "INVALID_RECORD" },
  );
  assert.throws(() => upgradeRecord(normalizedPost({ id: "abc", target: "https://xueqiu.com/7/abc" })), {
    code: "INVALID_RECORD",
  });
  assert.throws(() => upgradeRecord(normalizedPost({ target: "https://xueqiu.com/7/999" })), {
    code: "INVALID_RECORD",
  });
  assert.throws(() => upgradeRecord(normalizedReply({ post_target: "https://xueqiu.com/7/999" })), {
    code: "INVALID_RECORD",
  });
  assert.throws(() => mergeById([normalizedPost(), normalizedPost()], []), { code: "INVALID_RECORD" });
  assert.throws(() => mergeById([], [normalizedPost(), normalizedPost()]), { code: "INVALID_RECORD" });
});

test("CLI parsing and validation reject unsafe values", () => {
  assert.deepEqual(parseArgs(["--count=20", "--resume", "--output", "tmp"]), {
    count: "20",
    resume: true,
    output: "tmp",
  });
  assert.deepEqual(
    parseArgs(["--resume=false", "--count", "20"], {
      allowed: ["resume", "count"],
      booleans: ["resume"],
    }),
    { resume: false, count: "20" },
  );
  assert.throws(
    () => parseArgs(["--count", "--resume"], { allowed: ["count", "resume"], booleans: ["resume"] }),
    { code: "INVALID_ARGUMENT" },
  );
  assert.throws(() => parseArgs(["--typo"], { allowed: ["help"], booleans: ["help"] }), {
    code: "INVALID_ARGUMENT",
  });
  assert.throws(() => parseArgs(["positional"], { allowed: [] }), { code: "INVALID_ARGUMENT" });
  assert.equal(parseIntegerOption("20", { name: "count", min: 1 }), 20);
  assert.throws(() => parseIntegerOption("NaN", { name: "count", min: 1 }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => parseIntegerOption(true, { name: "count", min: 1 }), { code: "INVALID_ARGUMENT" });
  assert.equal(parseNumberOption("1.5", { name: "delay", min: 0 }), 1.5);
  assert.throws(() => parseNumberOption(false, { name: "delay", min: 0 }), { code: "INVALID_ARGUMENT" });
  assert.equal(validateDateOption("2026-07-13"), "2026-07-13");
  assert.throws(() => validateDateOption("2026-13-40"), { code: "INVALID_ARGUMENT" });
  assert.throws(() => validateDateOption("2026-02-30"), { code: "INVALID_ARGUMENT" });
  assert.equal(validateUserId(undefined, "7143769715"), "7143769715");
  assert.throws(() => validateUserId("714&count=100"), { code: "INVALID_ARGUMENT" });
});

test("report statuses map to deterministic exit codes", () => {
  assert.equal(exitCodeForStatus("complete"), 0);
  assert.equal(exitCodeForStatus("needs_verification"), 2);
  assert.equal(exitCodeForStatus("failed"), 1);
});

test("classifies API, WAF, and invalid JSON responses", () => {
  assert.deepEqual(
    classifyJsonResponse({ status: 200, contentType: "application/json", text: '{"items":[]}' }, "url"),
    { items: [] },
  );
  assert.deepEqual(
    classifyJsonResponse({
      status: 200,
      contentType: "application/json",
      text: '{"text":"a user wrote captcha and renderData"}',
    }, "url"),
    { text: "a user wrote captcha and renderData" },
  );
  assert.throws(
    () => classifyJsonResponse({
      status: 200,
      contentType: "application/json",
      text: '{"_waf_":true}',
    }, "url"),
    { code: "WAF" },
  );
  assert.throws(
    () => classifyJsonResponse({ status: 400, text: '{"error_code":10020}' }, "url"),
    { code: "API_10020" },
  );
  assert.throws(
    () => classifyJsonResponse({ status: 200, contentType: "text/html", text: "captcha" }, "url"),
    { code: "WAF" },
  );
  assert.throws(
    () => classifyJsonResponse({ status: 403, contentType: "text/html", text: "captcha" }, "url"),
    { code: "WAF" },
  );
  assert.throws(
    () => classifyJsonResponse({ status: 200, contentType: "application/json", text: "not-json" }, "url"),
    { code: "INVALID_JSON" },
  );
});

test("classifies HTML status, content type, WAF, and empty responses", () => {
  assert.equal(
    classifyHtmlResponse(
      { status: 200, contentType: "text/html; charset=utf-8", text: "<article>body</article>" },
      "url",
    ),
    "<article>body</article>",
  );
  assert.throws(
    () => classifyHtmlResponse({ status: 200, contentType: "text/html", text: "_waf_ captcha" }, "url"),
    { code: "WAF" },
  );
  assert.throws(
    () => classifyHtmlResponse({ status: 403, contentType: "text/html", text: "forbidden" }, "url"),
    { code: "HTTP_403" },
  );
  assert.throws(
    () => classifyHtmlResponse({ status: 200, contentType: "application/json", text: "{}" }, "url"),
    { code: "INVALID_CONTENT_TYPE" },
  );
  assert.throws(
    () => classifyHtmlResponse({ status: 200, contentType: "text/html", text: "" }, "url"),
    { code: "INVALID_HTML" },
  );
});

test("endpoint payloads require an explicit array field", () => {
  assert.deepEqual(extractArrayField({ statuses: [] }, ["statuses", "items"], "timeline"), []);
  assert.throws(() => extractArrayField({}, ["statuses", "items"], "timeline"), {
    code: "INVALID_RESPONSE_SHAPE",
  });
  assert.throws(() => extractArrayField({ statuses: {} }, ["statuses"], "timeline"), {
    code: "INVALID_RESPONSE_SHAPE",
  });
});

test("pagination prioritizes consistent metadata and fails closed on conflicts", () => {
  const options = { page: 1, count: 2, itemCount: 1, observedCount: 1, label: "timeline" };
  assert.equal(paginationComplete({}, options), true);
  assert.equal(paginationComplete({}, { ...options, itemCount: 2, observedCount: 2 }), false);
  assert.equal(paginationComplete({ has_more: true }, options), false);
  assert.equal(paginationComplete({ page_info: { next_cursor: "cursor-2" } }, options), false);
  assert.equal(paginationComplete({ page_info: { next_cursor: "0" } }, options), true);
  assert.equal(paginationComplete({
    has_more: false,
    meta: { max_page: "2", total_count: "2" },
  }, { page: 2, count: 2, itemCount: 1, observedCount: 2, label: "timeline" }), true);
  assert.equal(
    paginationComplete({ has_more: false, total: 2 }, options),
    false,
    "exhausted and more signals remain incomplete",
  );
  assert.throws(
    () => paginationComplete({ has_more: true, meta: { hasMore: false } }, options),
    { code: "INVALID_RESPONSE_SHAPE" },
  );
  assert.equal(
    paginationComplete({ total: 0 }, options),
    true,
  );
  assert.throws(
    () => paginationComplete({ page: 1, meta: { page_no: 2 } }, options),
    { code: "INVALID_RESPONSE_SHAPE" },
  );
  assert.throws(
    () => paginationComplete({ meta: [] }, options),
    { code: "INVALID_RESPONSE_SHAPE" },
  );
});

test("validates reply-count checkpoint state before it can suppress scans", () => {
  const userId = "7143769715";
  const initial = initialCheckpointState(userId);
  assert.equal(isValidCheckpointState({}, userId), false);
  assert.equal(isValidCheckpointState(initial, userId), true);
  assert.equal(isValidCheckpointState(initial, "999"), false);
  assert.equal(isValidCheckpointState({ ...initial, user_id: "999" }, userId), false);
  const predecessorState = { ...initial };
  delete predecessorState.user_id;
  predecessorState.latest_post_id = "999";
  predecessorState.latest_post_time = "2026-07-13T02:00:00+08:00";
  predecessorState.post_reply_counts = { 999: 10 };
  assert.deepEqual(checkpointStateForUser(predecessorState, userId), initial);
  assert.throws(
    () => checkpointStateForUser({ ...initial, user_id: "999" }, userId),
    { code: "CHECKPOINT_USER_MISMATCH" },
  );
  assert.equal(isValidCheckpointState({ ...initial, post_reply_counts: [] }, userId), false);
  assert.equal(isValidCheckpointState({
    ...initial,
    post_reply_counts: { 123: "4" },
  }, userId), false);
  assert.equal(isValidCheckpointState({
    ...initial,
    post_reply_counts: { invalid: 4 },
  }, userId), false);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xueqiu-state-"));
  const file = path.join(directory, "state.json");
  try {
    assert.deepEqual(readJsonStrict(file, {
      defaultValue: initial,
      validate: (value) => isValidCheckpointState(value, userId),
    }), initial);
    fs.writeFileSync(file, "{}", "utf8");
    assert.throws(() => readJsonStrict(file, {
      defaultValue: initial,
      validate: (value) => isValidCheckpointState(value, userId),
    }), { code: "INVALID_JSON_SHAPE" });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("selects changed posts and calculates partial coverage deterministically", () => {
  const posts = [
    { id: "1", reply_count: 2 },
    { id: "2", reply_count: 1 },
    { id: "3", reply_count: 9 },
  ];
  assert.deepEqual(
    selectChangedPosts(posts, { 1: 1, 2: 1 }, { limit: 2 }).map((item) => item.id),
    ["1"],
  );
  assert.deepEqual(
    selectChangedPosts(posts, { 1: 10, 2: 1 }, { limit: 2 }).map((item) => item.id),
    ["1"],
  );
  assert.deepEqual(updatePostReplyCounts(posts, { 1: 10 }, ["1"], 2), { 1: 2 });
  assert.equal(
    commentCoverageFor({ scanned: ["1"], candidates: ["1", "2"], truncated: [] }),
    "partial_waf",
  );
  assert.equal(
    commentCoverageFor({ scanned: ["1"], candidates: ["1"], truncated: ["1"] }),
    "partial_page_limit",
  );
  assert.equal(
    commentCoverageFor({ scanned: ["1"], candidates: ["1"], truncated: [], unverified: ["1"] }),
    "partial_incomplete_response",
  );
  assert.deepEqual(confirmedPostIdsFor(["1", "2", "3"], ["2"], ["3"]), ["1"]);
  assert.equal(syncStatusFor({ commentCoverage: "partial_page_limit" }), "needs_verification");
  assert.equal(
    syncStatusFor({ commentCoverage: "changed_posts_main_stream_complete" }),
    "complete",
  );
  assert.equal(
    syncStatusFor({ commentCoverage: "changed_posts_main_stream_complete", articleError: true }),
    "needs_verification",
  );
});
