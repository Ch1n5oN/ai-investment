import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  browserFetch as browserTimelineFetch,
  fetchPageText,
  mergeTimelineItems,
  normalizePostReference,
  runIdsMode,
  runTimelineMode,
} from "../../scripts/xueqiu_browser_scraper.mjs";
import {
  browserFetch as commentBrowserFetch,
  fetchCommentsForPost,
  fetchNestedRepliesForComment,
  normalizeReply,
  resumeStartIndex,
} from "../../scripts/xueqiu_comments_resume.mjs";
import {
  assertOutsideRepository,
  cleanupUserDataDir,
  createUserDataDir,
  fetchFromBrowser,
  isChallengePage,
  normalizeStatus as normalizePlaywrightStatus,
  parsePostReference,
} from "../../scripts/xueqiu_playwright_article_fetch.mjs";

function runtimeJson(value, { status = 200, contentType = "application/json" } = {}) {
  return {
    result: {
      value: {
        status,
        contentType,
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    },
  };
}

function post(id, text = `post ${id}`) {
  return {
    id: String(id),
    created_at_raw: "2026-07-14 09:00:00",
    created_at: "2026-07-14T09:00:00+08:00",
    text,
    clean_text: text,
    target: `https://xueqiu.com/7143769715/${id}`,
    reply_count: 0,
    like_count: 0,
    retweet_count: 0,
    view_count: 0,
  };
}

function comment(id, overrides = {}) {
  return {
    id: String(id),
    user_id: "7143769715",
    status_id: "9",
    created_at: "2026-07-14 09:30:00",
    text: `reply ${id}`,
    like_count: 0,
    reply_count: 0,
    ...overrides,
  };
}

test("browser-side fetches abort the underlying request instead of only racing it", async () => {
  for (const browserFetch of [browserTimelineFetch, commentBrowserFetch]) {
    let expression = "";
    const send = async (_method, params) => {
      expression = params.expression;
      return runtimeJson({ statuses: [] });
    };
    await browserFetch(send, "https://xueqiu.com/example", 100);
    assert.match(expression, /new AbortController\(\)/);
    assert.match(expression, /signal: controller\.signal/);
    assert.doesNotMatch(expression, /Promise\.race/);
  }
});

test("browser HTML fallback aborts the underlying page request", async () => {
  let call = 0;
  let fallbackExpression = "";
  const send = async (_method, params) => {
    call += 1;
    if (call === 1) return runtimeJson({ error_code: 10020, error_description: "blocked" });
    fallbackExpression = params.expression;
    return {
      result: {
        value: {
          status: 200,
          contentType: "text/html",
          text: "<article>fallback</article>",
          value: {
            text: "fallback",
            reply_count: 0,
            like_count: 0,
            retweet_count: 0,
            view_count: 0,
          },
        },
      },
    };
  };
  await fetchPageText(send, "2", "7143769715");
  assert.match(fallbackExpression, /new AbortController\(\)/);
  assert.match(fallbackExpression, /signal: controller\.signal/);
  assert.doesNotMatch(fallbackExpression, /Promise\.race/);
});

test("both-mode merge deduplicates IDs across streams while preserving resume data", () => {
  const merged = mergeTimelineItems(
    [post("1", "existing")],
    [post("2", "timeline")],
    [post("2", "article"), post("3", "article only")],
  );
  assert.deepEqual(new Set(merged.map((item) => item.id)), new Set(["1", "2", "3"]));
  assert.match(merged.find((item) => item.id === "2").text, /timeline|article/);
});

test("both --resume reads the both corpus, deduplicates streams, and writes the merged result", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xueqiu-both-resume-"));
  const corpus = path.join(directory, "xueqiu_7143769715_both.json");
  fs.writeFileSync(corpus, JSON.stringify([post("1", "existing")]));
  let call = 0;
  const send = async () => {
    call += 1;
    return runtimeJson({
      statuses: [{
        id: "2",
        created_at: "2026-07-14 09:00:00",
        text: call === 1 ? "timeline body" : "article body",
        reply_count: 0,
        like_count: 0,
        retweet_count: 0,
        view_count: 0,
      }],
    });
  };
  try {
    const result = await runTimelineMode(send, {
      userId: "7143769715",
      mode: "both",
      pages: 1,
      count: 10,
      outDir: directory,
      resume: true,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.written, true);
    assert.deepEqual(
      new Set(JSON.parse(fs.readFileSync(corpus, "utf8")).map((item) => item.id)),
      new Set(["1", "2"]),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("empty timeline responses do not overwrite existing corpus or markdown", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xueqiu-timeline-empty-"));
  const corpus = path.join(directory, "xueqiu_7143769715_both.json");
  const markdown = path.join(directory, "xueqiu_7143769715_both.md");
  const originalCorpus = JSON.stringify([post("1", "preserve")]);
  const originalMarkdown = "preserve markdown\n";
  fs.writeFileSync(corpus, originalCorpus);
  fs.writeFileSync(markdown, originalMarkdown);
  const send = async () => runtimeJson({ statuses: [] });
  try {
    const result = await runTimelineMode(send, {
      userId: "7143769715",
      mode: "both",
      pages: 1,
      count: 10,
      outDir: directory,
      resume: true,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.written, false);
    assert.equal(fs.readFileSync(corpus, "utf8"), originalCorpus);
    assert.equal(fs.readFileSync(markdown, "utf8"), originalMarkdown);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("post references accept only canonical numeric Xueqiu references", () => {
  assert.deepEqual(normalizePostReference("123", "7143769715"), {
    userId: "7143769715",
    postId: "123",
  });
  assert.deepEqual(parsePostReference("https://xueqiu.com/7143769715/123", "1"), {
    userId: "7143769715",
    postId: "123",
  });
  assert.throws(() => normalizePostReference("https://evil.example/1/2", "1"), { code: "INVALID_ARGUMENT" });
  assert.throws(() => parsePostReference("../profile", "1"), { code: "INVALID_ARGUMENT" });
  assert.throws(() => normalizePostReference("\u0085123", "1"), { code: "INVALID_ARGUMENT" });
  assert.throws(() => parsePostReference("\u0085123", "1"), { code: "INVALID_ARGUMENT" });
});

test("resume leaves the existing IDs corpus byte-for-byte unchanged when this run entirely fails", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xueqiu-ids-resume-failed-"));
  const corpus = path.join(directory, "xueqiu_7143769715_ids.json");
  const original = `${JSON.stringify([post("1", "preserve me")], null, 2)}\n`;
  fs.writeFileSync(corpus, original);
  const send = async () => runtimeJson({ error_code: 10020, error_description: "blocked" });
  try {
    const result = await runIdsMode(send, {
      refs: ["2", "https://xueqiu.com/7143769715/2"],
      userId: "7143769715",
      outDir: directory,
      resume: true,
    });
    assert.equal(result.attemptedFetches, 1);
    assert.equal(result.successfulFetches, 0);
    assert.equal(result.exitCode, 1);
    assert.equal(fs.readFileSync(corpus, "utf8"), original);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy comment normalizer rejects missing IDs and invalid counts", () => {
  const parent = post("9");
  assert.throws(
    () => normalizeReply({ user_id: "7143769715", text: "missing" }, parent, "7143769715"),
    { code: "INVALID_RECORD" },
  );
  assert.throws(
    () => normalizeReply(comment("1", { text: "bad", like_count: -1 }), parent, "7143769715"),
    { code: "INVALID_RECORD" },
  );
  assert.throws(
    () => normalizeReply({ ...comment("1"), created_at: undefined }, parent, "7143769715"),
    { code: "INVALID_RESPONSE_SHAPE" },
  );
  assert.throws(
    () => normalizeReply({ ...comment("1"), reply_count: undefined }, parent, "7143769715"),
    { code: "INVALID_RESPONSE_SHAPE" },
  );
  assert.throws(
    () => normalizeReply(comment("1", { source: 0 }), parent, "7143769715"),
    { code: "INVALID_RESPONSE_SHAPE" },
  );
  assert.equal(
    normalizeReply(comment("1", { created_at: null }), parent, "7143769715").created_at,
    "unknown",
  );
});

test("legacy comment pagination reports a full final page as partial", async () => {
  let call = 0;
  const send = async () => {
    call += 1;
    return runtimeJson({
      comments: [comment(call)],
    });
  };
  const result = await fetchCommentsForPost({
    send,
    post: { ...post("9"), reply_count: 1 },
    userId: "7143769715",
    count: 1,
    pageDelayMs: 0,
    timeoutMs: 100,
    includeSubReplies: false,
    subReplyPageLimit: 1,
  });
  assert.equal(call, 3);
  assert.equal(result.partial, true);
  assert.deepEqual(result.truncatedStreams, ["post:9"]);
});

test("legacy comment pagination rejects a non-empty short read below the declared total", async () => {
  const result = await fetchCommentsForPost({
    send: async () => runtimeJson({
      comments: [{
        id: "1",
        user_id: "other",
        status_id: "9",
        text: "one observed comment",
        reply_count: 0,
      }],
    }),
    post: { ...post("9"), reply_count: 50 },
    userId: "7143769715",
    count: 20,
    pageDelayMs: 0,
    timeoutMs: 100,
    includeSubReplies: false,
    subReplyPageLimit: 1,
  });
  assert.equal(result.partial, true);
  assert.deepEqual(result.truncatedStreams, ["post:9"]);
});

test("legacy bounded resume starts after the last successful post", () => {
  assert.equal(resumeStartIndex({}, 3), 0);
  assert.equal(resumeStartIndex({ scannedPosts: 1 }, 3), 1);
  assert.equal(resumeStartIndex({ scannedPosts: 3 }, 3), 3);
  assert.throws(() => resumeStartIndex({ scannedPosts: -1 }, 3), { code: "INVALID_JSON_SHAPE" });
  assert.throws(() => resumeStartIndex({ scannedPosts: "1" }, 3), { code: "INVALID_JSON_SHAPE" });
  assert.throws(() => resumeStartIndex({ scannedPosts: null }, 3), { code: "INVALID_JSON_SHAPE" });
});

test("nested comment pagination reports its page-limit boundary", async () => {
  let call = 0;
  const send = async () => {
    call += 1;
    return runtimeJson({
      comments: [comment(100 + call, { text: "nested" })],
    });
  };
  const result = await fetchNestedRepliesForComment({
    send,
    post: post("9"),
    commentId: "10",
    userId: "7143769715",
    count: 1,
    pageDelayMs: 0,
    timeoutMs: 100,
    subReplyPageLimit: 2,
  });
  assert.equal(result.items.length, 2);
  assert.equal(result.truncated, true);
});

test("Playwright recovery confines debug artifacts and cleans only owned profiles", () => {
  assert.throws(
    () => assertOutsideRepository("tests/debug", process.cwd()),
    { code: "UNSAFE_DEBUG_DIR" },
  );
  const outside = assertOutsideRepository(path.join(os.tmpdir(), "xueqiu-debug"), process.cwd());
  assert.equal(outside.startsWith(os.tmpdir()), true);

  const symlinkDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "xueqiu-debug-link-"));
  const repositoryLink = path.join(symlinkDirectory, "repository");
  try {
    fs.symlinkSync(process.cwd(), repositoryLink);
    assert.throws(
      () => assertOutsideRepository(path.join(repositoryLink, "debug"), process.cwd()),
      { code: "UNSAFE_DEBUG_DIR" },
    );
  } finally {
    fs.rmSync(symlinkDirectory, { recursive: true, force: true });
  }

  const owned = createUserDataDir();
  assert.equal(fs.existsSync(owned.directory), true);
  cleanupUserDataDir(owned);
  assert.equal(fs.existsSync(owned.directory), false);

  const explicitDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "xueqiu-user-profile-"));
  try {
    cleanupUserDataDir(createUserDataDir(explicitDirectory));
    assert.equal(fs.existsSync(explicitDirectory), true);
  } finally {
    fs.rmSync(explicitDirectory, { recursive: true, force: true });
  }
});

test("Playwright recovery rejects challenge pages and malformed extracted records", async () => {
  assert.equal(isChallengePage({ bodyText: "请完成安全验证" }), true);
  assert.throws(
    () => normalizePlaywrightStatus(
      { id: "2", text: "wrong post" },
      "https://xueqiu.com/7143769715/1",
      "1",
    ),
    { code: "INVALID_RECORD" },
  );
  assert.throws(
    () => normalizePlaywrightStatus(
      { id: "1", text: "body", reply_count: -1 },
      "https://xueqiu.com/7143769715/1",
      "1",
    ),
    { code: "INVALID_RECORD" },
  );
  assert.throws(
    () => normalizePlaywrightStatus(
      { id: "1", created_at: null, text: "body", reply_count: 0, like_count: 0, retweet_count: 0 },
      "https://xueqiu.com/7143769715/1",
      "1",
    ),
    { code: "INVALID_RECORD" },
  );
  assert.throws(
    () => normalizePlaywrightStatus(
      { id: "1", text: "DOM fallback body" },
      "https://xueqiu.com/7143769715/1",
      "1",
      { allowSparseDom: true },
    ),
    { code: "INVALID_RECORD" },
  );
  assert.equal(
    normalizePlaywrightStatus(
      {
        id: "1",
        text: "DOM fallback with observed counts",
        reply_count: 0,
        like_count: 0,
        retweet_count: 0,
        view_count: 0,
      },
      "https://xueqiu.com/7143769715/1",
      "1",
      { allowSparseDom: true },
    ).created_at,
    "unknown",
  );

  let evaluated = false;
  const page = {
    async goto() {},
    async waitForTimeout() {},
    async title() { return "安全验证"; },
    locator() {
      return {
        async innerText() { return "captcha"; },
        async boundingBox() { return null; },
      };
    },
    async evaluate() {
      evaluated = true;
      return null;
    },
  };
  await assert.rejects(fetchFromBrowser(page, "7143769715", "1"), { code: "WAF" });
  assert.equal(evaluated, false);
});
