import assert from "node:assert/strict";
import test from "node:test";

import {
  commentPageComplete,
  fetchCommentsForPost,
  fetchNestedRepliesForComment,
  isValidResumeMetadata,
  repliesFingerprint,
  resumeStartIndex,
  timelineFingerprint,
  upgradeRecoveryRecords,
} from "../../scripts/xueqiu_comments_resume.mjs";

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

function post(id, replyCount = 0) {
  return {
    id: String(id),
    created_at_raw: "2026-07-14 09:00:00",
    created_at: "2026-07-14T09:00:00+08:00",
    text: `post ${id}`,
    clean_text: `post ${id}`,
    target: `https://xueqiu.com/${USER_ID}/${id}`,
    reply_count: replyCount,
    like_count: 0,
    retweet_count: 0,
    view_count: 0,
  };
}

function comment(id, overrides = {}) {
  return {
    id: String(id),
    user_id: USER_ID,
    status_id: "9",
    created_at: "2026-07-14 09:30:00",
    text: `reply ${id}`,
    like_count: 0,
    reply_count: 0,
    ...overrides,
  };
}

test("main comment pagination follows has_more=true even after a short page", async () => {
  let calls = 0;
  const send = async () => {
    calls += 1;
    return calls === 1
      ? runtimeJson({ comments: [comment("1")], has_more: true })
      : runtimeJson({ comments: [], has_more: false });
  };

  const result = await fetchCommentsForPost({
    send,
    post: post("9", 1),
    userId: USER_ID,
    count: 20,
    pageDelayMs: 0,
    timeoutMs: 100,
    includeSubReplies: false,
    subReplyPageLimit: 1,
  });

  assert.equal(calls, 2);
  assert.equal(result.partial, false);
  assert.equal(result.items.length, 1);
});

test("nested comment pagination follows has_more=true even after a short page", async () => {
  let calls = 0;
  const send = async () => {
    calls += 1;
    return calls === 1
      ? runtimeJson({ comments: [comment("11")], has_more: true })
      : runtimeJson({ comments: [], has_more: false });
  };

  const result = await fetchNestedRepliesForComment({
    send,
    post: post("9"),
    commentId: "10",
    userId: USER_ID,
    count: 20,
    pageDelayMs: 0,
    timeoutMs: 100,
    subReplyPageLimit: 2,
  });

  assert.equal(calls, 2);
  assert.equal(result.truncated, false);
  assert.equal(result.items.length, 1);
});

test("total metadata tracks cumulative unique comments across short pages", async () => {
  let calls = 0;
  const send = async () => {
    calls += 1;
    return calls === 1
      ? runtimeJson({ comments: [comment("1")], total: 2 })
      : runtimeJson({ comments: [comment("2")], total: 2 });
  };

  const result = await fetchCommentsForPost({
    send,
    post: post("9", 2),
    userId: USER_ID,
    count: 20,
    pageDelayMs: 0,
    timeoutMs: 100,
    includeSubReplies: false,
    subReplyPageLimit: 1,
  });

  assert.equal(calls, 2);
  assert.equal(result.partial, false);
  assert.deepEqual(result.items.map((item) => item.id), ["1", "2"]);
});

test("invalid or contradictory comment pagination metadata fails closed", () => {
  for (const payload of [
    { has_more: "false" },
    { max_page: 0 },
    { total: -1 },
    { has_more: false, max_page: 2 },
    { max_page: 2, total: 100 },
    { pagination: { total: 1 }, meta: { totalCount: 2 } },
  ]) {
    assert.throws(
      () => commentPageComplete(payload, 1, 1, 1),
      { code: "INVALID_RESPONSE_SHAPE" },
    );
  }
});

test("foreign-post comments are rejected before they can prove stream completion", async () => {
  const foreignAssociations = [
    { status_id: "999" },
    { status_id: "9", target_id: "999" },
    { status_id: "9", status: { id: "999" } },
  ];

  for (const association of foreignAssociations) {
    let calls = 0;
    const send = async () => {
      calls += 1;
      return runtimeJson({
        comments: [comment("1", { user_id: "other", ...association })],
        has_more: false,
      });
    };
    await assert.rejects(
      fetchCommentsForPost({
        send,
        post: post("9", 1),
        userId: USER_ID,
        count: 20,
        pageDelayMs: 0,
        timeoutMs: 100,
        includeSubReplies: false,
        subReplyPageLimit: 1,
      }),
      { code: "INVALID_RESPONSE_SHAPE" },
    );
    assert.equal(calls, 1);
  }
});

test("resume resets safely when fingerprint is absent or timeline order changes", () => {
  const original = [post("3", 2), post("2", 1), post("1", 0)];
  const meta = {
    scannedPosts: 2,
    timelineFingerprint: timelineFingerprint(original),
  };

  assert.equal(resumeStartIndex(meta, original), 2);
  assert.equal(resumeStartIndex({ scannedPosts: 2 }, original), 0);
  assert.equal(resumeStartIndex(meta, [post("4", 0), ...original]), 0);
  assert.equal(resumeStartIndex(meta, [original[1], original[0], original[2]]), 0);
  assert.notEqual(timelineFingerprint(original), timelineFingerprint([post("3", 3), ...original.slice(1)]));
});

test("resume binds progress to user and the durable reply corpus", () => {
  const timeline = [post("3", 2), post("2", 1), post("1", 0)];
  const replies = [{ id: "11", text: "durable reply" }];
  const meta = {
    schema_version: 1,
    userId: USER_ID,
    scannedPosts: 2,
    totalReplies: replies.length,
    timelineFingerprint: timelineFingerprint(timeline),
    repliesFingerprint: repliesFingerprint(replies),
  };

  assert.equal(isValidResumeMetadata(meta, USER_ID), true);
  assert.equal(isValidResumeMetadata({ ...meta, userId: "999" }, USER_ID), false);
  assert.equal(resumeStartIndex(meta, timeline, { expectedUserId: USER_ID, replies }), 2);
  assert.throws(
    () => resumeStartIndex(meta, timeline, { expectedUserId: USER_ID, replies: [] }),
    { code: "RESUME_CORPUS_MISMATCH" },
  );
  assert.throws(
    () => resumeStartIndex(meta, timeline, {
      expectedUserId: USER_ID,
      replies: [{ id: "12", text: "different same-size corpus" }],
    }),
    { code: "RESUME_CORPUS_MISMATCH" },
  );
  const { repliesFingerprint: _oldFingerprint, ...legacyMeta } = meta;
  assert.equal(
    resumeStartIndex(legacyMeta, timeline, {
      expectedUserId: USER_ID,
      replies,
    }),
    0,
  );
  assert.throws(
    () => resumeStartIndex({ ...meta, userId: "999" }, timeline, {
      expectedUserId: USER_ID,
      replies,
    }),
    { code: "INVALID_JSON_SHAPE" },
  );
});

test("legacy recovery migration preserves unknown content and interaction gaps", () => {
  const [legacyPost] = upgradeRecoveryRecords([{
    id: 9,
    created_at: "2026-07-14 09:00:00",
    clean_text: "derived-only post text",
    target: `https://xueqiu.com/${USER_ID}/9`,
    reply_count: 2,
    like_count: 3,
    retweet_count: 4,
    view_count: 5,
  }], "timeline", USER_ID);
  assert.equal(legacyPost.record_contract, "legacy_normalized_v1");
  assert.equal(legacyPost.created_at_raw, "2026-07-14 09:00:00");
  assert.equal(Object.hasOwn(legacyPost, "text"), false);

  const [legacyReply] = upgradeRecoveryRecords([{
    id: 11,
    created_at: "2026-07-14 09:30:00",
    post_id: 9,
    post_created_at: "2026-07-14 09:00:00",
    post_link: `https://xueqiu.com/${USER_ID}/9`,
    text: "reply",
    clean_text: "reply",
    like_count: 0,
  }], "reply corpus", USER_ID);
  assert.equal(legacyReply.record_contract, "legacy_normalized_v1");
  assert.equal(legacyReply.post_created_at_raw, "2026-07-14 09:00:00");
  assert.equal(Object.hasOwn(legacyReply, "reply_count"), false);
  assert.throws(
    () => upgradeRecoveryRecords([{ ...legacyReply, cookie: "secret" }], "reply corpus", USER_ID),
    { code: "INVALID_RECORD" },
  );
  assert.throws(
    () => upgradeRecoveryRecords([{ ...legacyPost, created_at_raw: "garbage", created_at: "unknown" }], "timeline", USER_ID),
    { code: "INVALID_RECORD" },
  );
  assert.throws(
    () => upgradeRecoveryRecords([{ ...legacyReply, post_created_at_raw: "garbage", post_created_at: "unknown" }], "reply corpus", USER_ID),
    { code: "INVALID_RECORD" },
  );
  assert.throws(
    () => upgradeRecoveryRecords([{ ...legacyPost, id: 9 }], "timeline", USER_ID),
    { code: "INVALID_RECORD" },
  );
  assert.throws(
    () => upgradeRecoveryRecords([{ ...legacyPost, reply_count: "2" }], "timeline", USER_ID),
    { code: "INVALID_RECORD" },
  );
  assert.throws(
    () => upgradeRecoveryRecords([{ ...legacyPost, target: "/7143769715/9" }], "timeline", USER_ID),
    { code: "INVALID_RECORD" },
  );
  assert.throws(
    () => upgradeRecoveryRecords([{ ...legacyPost, target: undefined }], "timeline", USER_ID),
    { code: "INVALID_RECORD" },
  );
  assert.throws(
    () => upgradeRecoveryRecords([{
      ...legacyPost,
      text: "<b>observed</b>",
      clean_text: "tampered derived text",
    }], "timeline", USER_ID),
    { code: "INVALID_RECORD" },
  );
  for (const missing of ["created_at", "created_at_raw"]) {
    const invalid = { ...legacyPost };
    delete invalid[missing];
    assert.throws(
      () => upgradeRecoveryRecords([invalid], "timeline", USER_ID),
      { code: "INVALID_RECORD" },
    );
  }
  for (const missing of ["post_created_at", "post_created_at_raw"]) {
    const invalid = { ...legacyReply };
    delete invalid[missing];
    assert.throws(
      () => upgradeRecoveryRecords([invalid], "reply corpus", USER_ID),
      { code: "INVALID_RECORD" },
    );
  }
  assert.throws(
    () => upgradeRecoveryRecords([{
      ...legacyReply,
      post_link: `https://xueqiu.com/${USER_ID}/10`,
    }], "reply corpus", USER_ID),
    { code: "INVALID_RECORD" },
  );
  assert.throws(
    () => upgradeRecoveryRecords([{ ...legacyReply, status_id: "10" }], "reply corpus", USER_ID),
    { code: "INVALID_RECORD" },
  );
});
