import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchChangedPostComments,
  fetchTimeline,
  fetchUserCommentStream,
  userCommentStreamCanAdvance,
} from "../../scripts/xueqiu_edge_sync.mjs";
import { updatePostReplyCounts } from "../../scripts/lib/xueqiu_core.mjs";

const USER_ID = "7143769715";

function runtimeJson(value) {
  return {
    result: {
      value: {
        status: 200,
        contentType: "application/json",
        text: JSON.stringify(value),
      },
    },
  };
}

function sessionReturning(value) {
  return {
    async send() { return runtimeJson(value); },
    async navigate() {},
  };
}

function args(overrides = {}) {
  return {
    timelinePages: 1,
    count: 20,
    sinceDate: null,
    requestDelayMs: 0,
    retryDelayMs: 0,
    retries: 0,
    fetchTimeoutMs: 100,
    commentPages: 2,
    commentCount: 20,
    initialCommentPosts: 20,
    forceComments: false,
    ...overrides,
  };
}

function post(overrides = {}) {
  const id = String(overrides.id ?? "100");
  return {
    schema_version: 1,
    id,
    created_at_raw: "2026-07-14 09:00:00",
    created_at: "2026-07-14T09:00:00+08:00",
    text: "post",
    clean_text: "post",
    target: `https://xueqiu.com/${USER_ID}/${id}`,
    reply_count: 1,
    like_count: 0,
    retweet_count: 0,
    view_count: 0,
    ...overrides,
  };
}

function rawStatus(overrides = {}) {
  return {
    id: 100,
    created_at: "2026-07-14 09:00:00",
    text: "post",
    reply_count: 1,
    like_count: 2,
    retweet_count: 3,
    view_count: 4,
    ...overrides,
  };
}

test("HTTP 200 empty comments do not confirm a post whose reply count is positive", async () => {
  const result = await fetchChangedPostComments(
    sessionReturning({ comments: [] }),
    USER_ID,
    [post()],
    { 100: 0 },
    args(),
    { requests: 0, errors: 0, waf: 0 },
  );

  assert.deepEqual(result.scanned, ["100"]);
  assert.deepEqual(result.unverified, ["100"]);
  assert.deepEqual(result.confirmed, []);
  assert.deepEqual(updatePostReplyCounts([post()], { 100: 0 }, result.confirmed, 20), { 100: 0 });
});

test("a successful empty scan can reset a decreased reply-count baseline to zero", async () => {
  const zeroReplyPost = post({ reply_count: 0 });
  const result = await fetchChangedPostComments(
    sessionReturning({ comments: [] }),
    USER_ID,
    [zeroReplyPost],
    { 100: 10 },
    args(),
    { requests: 0, errors: 0, waf: 0 },
  );

  assert.deepEqual(result.unverified, []);
  assert.deepEqual(result.confirmed, ["100"]);
  assert.deepEqual(updatePostReplyCounts([zeroReplyPost], { 100: 10 }, result.confirmed, 20), { 100: 0 });
});

test("an empty user-comment probe cannot batch-advance post checkpoints", async () => {
  const stream = await fetchUserCommentStream(
    sessionReturning({ comments: [] }),
    USER_ID,
    [post()],
    args(),
    { requests: 0, errors: 0, waf: 0 },
  );

  assert.deepEqual(stream.replies, []);
  assert.equal(stream.truncated, false);
  assert.equal(userCommentStreamCanAdvance(stream), false);
});

test("an empty diagnostic page with has_more=true remains truncated", async () => {
  const stream = await fetchUserCommentStream(
    sessionReturning({ comments: [], has_more: true }),
    USER_ID,
    [post()],
    args({ commentPages: 1 }),
    { requests: 0, errors: 0, waf: 0 },
  );

  assert.deepEqual(stream.replies, []);
  assert.equal(stream.truncated, true);
});

test("a non-empty diagnostic user-comment stream cannot batch-advance unrelated posts", async () => {
  const stream = await fetchUserCommentStream(
    sessionReturning({
      comments: [{
        id: "900",
        status_id: "100",
        created_at: "2026-07-14 09:30:00",
        text: "reply",
        like_count: 0,
        reply_count: 0,
        user: { id: USER_ID },
      }],
    }),
    USER_ID,
    [post(), post({ id: "200" })],
    args(),
    { requests: 0, errors: 0, waf: 0 },
  );
  assert.equal(stream.replies.length, 1);
  assert.equal(userCommentStreamCanAdvance(stream), false);
});

test("short comment reads below declared reply_count remain unverified", async () => {
  const result = await fetchChangedPostComments(
    sessionReturning({
      comments: [{ id: "900", user: { id: "other" } }],
    }),
    USER_ID,
    [post({ reply_count: 50 })],
    {},
    args(),
    { requests: 0, errors: 0, waf: 0 },
  );
  assert.deepEqual(result.scanned, ["100"]);
  assert.deepEqual(result.unverified, ["100"]);
  assert.deepEqual(result.confirmed, []);
});

test("a full configured final comment page needs explicit termination evidence", async () => {
  const fullPage = {
    comments: [{
      id: "900",
      status_id: "100",
      created_at: "2026-07-14 09:30:00",
      text: "reply",
      like_count: 0,
      reply_count: 0,
      user: { id: USER_ID },
    }],
  };
  const incomplete = await fetchChangedPostComments(
    sessionReturning(fullPage),
    USER_ID,
    [post()],
    {},
    args({ commentPages: 1, commentCount: 1 }),
    { requests: 0, errors: 0, waf: 0 },
  );
  assert.deepEqual(incomplete.truncated, ["100"]);
  assert.deepEqual(incomplete.confirmed, []);

  const explicitMore = await fetchChangedPostComments(
    sessionReturning({ ...fullPage, has_more: true }),
    USER_ID,
    [post()],
    {},
    args({ commentPages: 1, commentCount: 20 }),
    { requests: 0, errors: 0, waf: 0 },
  );
  assert.deepEqual(explicitMore.truncated, ["100"]);
  assert.deepEqual(explicitMore.confirmed, []);

  const complete = await fetchChangedPostComments(
    sessionReturning({ ...fullPage, has_more: false }),
    USER_ID,
    [post()],
    {},
    args({ commentPages: 1, commentCount: 1 }),
    { requests: 0, errors: 0, waf: 0 },
  );
  assert.deepEqual(complete.truncated, []);
  assert.deepEqual(complete.confirmed, ["100"]);
});

test("comment post references must all match the post being checkpointed", async () => {
  const mismatches = [
    { status_id: "999" },
    { target_id: 999 },
    { status: { id: "999" } },
    { target_status: { id: 999 } },
    { original_status: { id: "999" } },
  ];
  for (const mismatch of mismatches) {
    await assert.rejects(
      fetchChangedPostComments(
        sessionReturning({ comments: [{ id: "900", user: { id: "other" }, ...mismatch }] }),
        USER_ID,
        [post()],
        {},
        args(),
        { requests: 0, errors: 0, waf: 0 },
      ),
      { code: "INVALID_RESPONSE_SHAPE" },
      JSON.stringify(mismatch),
    );
  }
});

test("overlapping comment pages deduplicate compatible IDs before confirmation", async () => {
  const pages = [
    {
      comments: [{
        id: "900",
        status_id: "100",
        created_at: "2026-07-14 09:30:00",
        text: "reply",
        like_count: 0,
        reply_count: 0,
        user: { id: USER_ID },
      }],
      has_more: true,
      max_page: 2,
      total: 2,
    },
    {
      comments: [
        {
          id: "900",
          status_id: "100",
          created_at: "2026-07-14 09:30:00",
          text: "reply",
          like_count: 0,
          reply_count: 0,
          user: { id: USER_ID },
        },
        { id: "901", status_id: "100", user: { id: "other" } },
      ],
      has_more: false,
      max_page: 2,
      total: 2,
    },
  ];
  let call = 0;
  const session = {
    async send() { return runtimeJson(pages[call++]); },
    async navigate() {},
  };
  const result = await fetchChangedPostComments(
    session,
    USER_ID,
    [post({ reply_count: 2 })],
    {},
    args({ commentPages: 2, commentCount: 2 }),
    { requests: 0, errors: 0, waf: 0 },
  );
  assert.equal(call, 2);
  assert.deepEqual(result.replies.map((reply) => reply.id), ["900"]);
  assert.equal(result.replies[0].post_created_at_raw, "2026-07-14 09:00:00");
  assert.equal(result.replies[0].post_created_at, "2026-07-14T09:00:00+08:00");
  assert.deepEqual(result.confirmed, ["100"]);
});

test("Edge timeline rejects network records that omit normalized contract fields", async () => {
  const incomplete = rawStatus();
  delete incomplete.text;
  await assert.rejects(
    fetchTimeline(
      sessionReturning({ statuses: [incomplete] }),
      USER_ID,
      "posts",
      args(),
      { requests: 0, errors: 0, waf: 0 },
    ),
    { code: "INVALID_RESPONSE_SHAPE" },
  );
});

test("Edge timeline rejects a conflicting acquisition record contract", async () => {
  await assert.rejects(
    fetchTimeline(
      sessionReturning({ statuses: [rawStatus({ record_contract: "normalized_v2" })] }),
      USER_ID,
      "posts",
      args(),
      { requests: 0, errors: 0, waf: 0 },
    ),
    { code: "INVALID_RESPONSE_SHAPE" },
  );
});

test("Edge acquisition IDs trim ASCII only", async () => {
  const accepted = await fetchTimeline(
    sessionReturning({ statuses: [rawStatus({ id: " \t100\r\n" })] }),
    USER_ID,
    "posts",
    args(),
    { requests: 0, errors: 0, waf: 0 },
  );
  assert.deepEqual(accepted.items.map((item) => item.id), ["100"]);
  await assert.rejects(
    fetchTimeline(
      sessionReturning({ statuses: [rawStatus({ id: "\u0085100" })] }),
      USER_ID,
      "posts",
      args(),
      { requests: 0, errors: 0, waf: 0 },
    ),
    { code: "INVALID_RESPONSE_SHAPE" },
  );
});

test("Edge timeline rejects a supplied URL that identifies a different post", async () => {
  await assert.rejects(
    fetchTimeline(
      sessionReturning({ statuses: [rawStatus({ target: `https://xueqiu.com/${USER_ID}/999` })] }),
      USER_ID,
      "posts",
      args(),
      { requests: 0, errors: 0, waf: 0 },
    ),
    { code: "INVALID_TARGET" },
  );
});

test("Edge timeline rejects a supplied URL for the wrong user", async () => {
  await assert.rejects(
    fetchTimeline(
      sessionReturning({ statuses: [rawStatus({ target: "https://xueqiu.com/999/100" })] }),
      USER_ID,
      "posts",
      args(),
      { requests: 0, errors: 0, waf: 0 },
    ),
    { code: "INVALID_TARGET" },
  );
});
