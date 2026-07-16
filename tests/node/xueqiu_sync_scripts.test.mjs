import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  browserFetch,
  fetchPageText,
  fetchTimeline as fetchBrowserTimeline,
  runIdsMode,
} from "../../scripts/xueqiu_browser_scraper.mjs";
import {
  fetchChangedPostComments,
  fetchTimeline as fetchEdgeTimeline,
  interfaceDriftFor,
  reportStatusFor,
} from "../../scripts/xueqiu_edge_sync.mjs";

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

function edgeArgs(overrides = {}) {
  return {
    timelinePages: 1,
    count: 2,
    sinceDate: null,
    requestDelayMs: 0,
    retryDelayMs: 0,
    retries: 0,
    fetchTimeoutMs: 100,
    ...overrides,
  };
}

function timelineStatus(id, createdAt) {
  return {
    id,
    created_at: createdAt,
    text: `post ${id}`,
    reply_count: 0,
    like_count: 0,
    retweet_count: 0,
    view_count: 0,
  };
}

test("Edge reports interface drift separately from expected WAF and API limitations", () => {
  assert.deepEqual(interfaceDriftFor({
    error: { code: "INVALID_RESPONSE_SHAPE", message: "statuses must be an array" },
    article_error: { code: "INVALID_JSON", message: "invalid JSON" },
    user_comment_stream_error: { code: "API_10020", message: "known limitation" },
    metrics: { waf: 3 },
  }), {
    detected: true,
    signals: [
      {
        source: "sync",
        category: "response_contract",
        code: "INVALID_RESPONSE_SHAPE",
        message: "statuses must be an array",
      },
      {
        source: "articles",
        category: "response_encoding",
        code: "INVALID_JSON",
        message: "invalid JSON",
      },
    ],
  });
  assert.deepEqual(interfaceDriftFor({
    error: { code: "WAF", message: "captcha" },
    user_comment_stream_error: { code: "API_10020", message: "blocked" },
  }), { detected: false, signals: [] });
});

test("Edge timeline marks a full final page as truncated", async () => {
  const session = {
    async send() {
      return runtimeJson({
        statuses: [
          timelineStatus(2, "2026-07-14 09:00:00"),
          timelineStatus(1, "2026-07-14 08:00:00"),
        ],
      });
    },
    async navigate() {},
  };
  const result = await fetchEdgeTimeline(session, "7143769715", "posts", edgeArgs(), {
    requests: 0,
    errors: 0,
    waf: 0,
  });
  assert.equal(result.items.length, 2);
  assert.equal(result.truncated, true);
  assert.equal(
    reportStatusFor({ post_timeline_truncated: result.truncated }, "changed_posts_main_stream_complete"),
    "needs_verification",
  );
});

test("Edge timeline reaching the historical boundary is not truncated", async () => {
  const session = {
    async send() {
      return runtimeJson({
        statuses: [
          timelineStatus(2, "2026-07-14 09:00:00"),
          timelineStatus(1, "2026-07-12 08:00:00"),
        ],
      });
    },
    async navigate() {},
  };
  const result = await fetchEdgeTimeline(
    session,
    "7143769715",
    "posts",
    edgeArgs({ sinceDate: "2026-07-13", count: 3 }),
    { requests: 0, errors: 0, waf: 0 },
  );
  assert.deepEqual(result.items.map((item) => item.id), ["2"]);
  assert.equal(result.truncated, false);
});

test("old pinned timeline items do not hide newer records on later pages", async () => {
  const pages = [
    {
      statuses: [
        timelineStatus(9, "2025-01-01 09:00:00"),
        timelineStatus(3, "2026-07-14 09:00:00"),
      ],
    },
    { statuses: [timelineStatus(2, "2026-07-13 09:00:00")] },
  ];
  let edgeCalls = 0;
  const edgeSession = {
    async send() { return runtimeJson(pages[edgeCalls++]); },
    async navigate() {},
  };
  const edge = await fetchEdgeTimeline(
    edgeSession,
    "7143769715",
    "posts",
    edgeArgs({ sinceDate: "2026-07-13", timelinePages: 2 }),
    { requests: 0, errors: 0, waf: 0 },
  );
  assert.equal(edgeCalls, 2);
  assert.deepEqual(edge.items.map((item) => item.id), ["3", "2"]);
  assert.equal(edge.truncated, false);

  let browserCalls = 0;
  const browser = await fetchBrowserTimeline(
    async () => runtimeJson(pages[browserCalls++]),
    "7143769715",
    "posts",
    2,
    2,
    "2026-07-13",
    0,
  );
  assert.equal(browserCalls, 2);
  assert.deepEqual(browser.items.map((item) => item.id), ["3", "2"]);
  assert.equal(browser.truncated, false);
});

test("timeline metadata overrides short pages and overlapping IDs are merged once", async () => {
  const pages = [
    {
      statuses: [timelineStatus(2, "2026-07-14 09:00:00")],
      has_more: true,
      max_page: 2,
      total: 2,
    },
    {
      statuses: [
        timelineStatus(2, "2026-07-14 09:00:00"),
        timelineStatus(1, "2026-07-14 08:00:00"),
      ],
      has_more: false,
      max_page: 2,
      total: 2,
    },
  ];
  let edgeCalls = 0;
  const edge = await fetchEdgeTimeline(
    {
      async send() { return runtimeJson(pages[edgeCalls++]); },
      async navigate() {},
    },
    "7143769715",
    "posts",
    edgeArgs({ timelinePages: 2 }),
    { requests: 0, errors: 0, waf: 0 },
  );
  assert.equal(edgeCalls, 2);
  assert.deepEqual(edge.items.map((item) => item.id), ["2", "1"]);
  assert.equal(edge.truncated, false);

  let browserCalls = 0;
  const browser = await fetchBrowserTimeline(
    async () => runtimeJson(pages[browserCalls++]),
    "7143769715",
    "posts",
    2,
    2,
    null,
    0,
  );
  assert.equal(browserCalls, 2);
  assert.deepEqual(browser.items.map((item) => item.id), ["2", "1"]);
  assert.equal(browser.truncated, false);
});

test("contradictory timeline metadata remains incomplete instead of trusting a short page", async () => {
  const payload = {
    statuses: [timelineStatus(1, "2026-07-14 08:00:00")],
    has_more: false,
    total: 2,
  };
  const edge = await fetchEdgeTimeline(
    { async send() { return runtimeJson(payload); }, async navigate() {} },
    "7143769715",
    "posts",
    edgeArgs(),
    { requests: 0, errors: 0, waf: 0 },
  );
  assert.equal(edge.truncated, true);
  const browser = await fetchBrowserTimeline(
    async () => runtimeJson(payload),
    "7143769715",
    "posts",
    1,
    2,
    null,
    0,
  );
  assert.equal(browser.truncated, true);
});

test("WAF interruption advances checkpoints only for confirmed posts", async () => {
  let call = 0;
  const session = {
    async send() {
      call += 1;
      if (call === 1) {
        return runtimeJson({
          comments: [{
            id: "10",
            status_id: "1",
            created_at: "2026-07-14 09:30:00",
            text: "observed reply",
            like_count: 0,
            reply_count: 0,
            user: { id: "7143769715" },
          }],
        });
      }
      return runtimeJson("captcha", { status: 403, contentType: "text/html" });
    },
    async navigate() {},
  };
  const result = await fetchChangedPostComments(
    session,
    "7143769715",
    [
      { id: "1", reply_count: 1, target: "https://xueqiu.com/7143769715/1" },
      { id: "2", reply_count: 1, target: "https://xueqiu.com/7143769715/2" },
    ],
    {},
    {
      ...edgeArgs(),
      initialCommentPosts: 2,
      forceComments: false,
      commentCount: 20,
      commentPages: 2,
    },
    { requests: 0, errors: 0, waf: 0 },
  );
  assert.deepEqual(result.candidates, ["1", "2"]);
  assert.deepEqual(result.scanned, ["1"]);
  assert.deepEqual(result.confirmed, ["1"]);
});

test("browser scraper rejects HTTP 200 API errors", async () => {
  const send = async () => runtimeJson({ error_code: 10020, error_description: "blocked" });
  await assert.rejects(browserFetch(send, "https://xueqiu.com/example", true), { code: "API_10020" });
});

test("browser status acquisition does not hide a conflicting contract behind HTML fallback", async () => {
  let calls = 0;
  const send = async () => {
    calls += 1;
    return runtimeJson({
      ...timelineStatus(1, "2026-07-14 09:00:00"),
      record_contract: "normalized_v2",
    });
  };
  await assert.rejects(fetchPageText(send, "1", "7143769715"), {
    code: "INVALID_RESPONSE_SHAPE",
  });
  assert.equal(calls, 1);
});

test("browser HTML fallback constructs a canonical target when page metadata omits it", async () => {
  let call = 0;
  const send = async () => {
    call += 1;
    if (call === 1) return runtimeJson({ error_code: 10020, error_description: "blocked" });
    return {
      result: {
        value: {
          status: 200,
          contentType: "text/html; charset=utf-8",
          text: "<html><article>Fallback body</article></html>",
          value: {
            title: "Fallback title",
            text: "Fallback body",
            reply_count: 0,
            like_count: 0,
            retweet_count: 0,
            view_count: 0,
          },
        },
      },
    };
  };
  const record = await fetchPageText(send, "123", "7143769715");
  assert.equal(record.id, "123");
  assert.equal(record.target, "https://xueqiu.com/7143769715/123");
  assert.equal(record.record_contract, "normalized_v1");
});

test("browser HTML fallback refuses to invent missing interaction counts", async () => {
  let call = 0;
  const send = async () => {
    call += 1;
    if (call === 1) return runtimeJson({ error_code: 10020, error_description: "blocked" });
    return {
      result: {
        value: {
          status: 200,
          contentType: "text/html; charset=utf-8",
          text: "<html><article>Fallback body</article></html>",
          value: { title: "Fallback title", text: "Fallback body" },
        },
      },
    };
  };
  await assert.rejects(fetchPageText(send, "123", "7143769715"), {
    code: "INVALID_RESPONSE_SHAPE",
  });
});

test("browser HTML fallback rejects an HTTP 200 WAF challenge", async () => {
  let call = 0;
  const send = async () => {
    call += 1;
    if (call === 1) return runtimeJson({ error_code: 10020, error_description: "blocked" });
    return {
      result: {
        value: {
          status: 200,
          contentType: "text/html; charset=utf-8",
          text: "<html><script>window.renderData = {_waf_: true}</script>captcha</html>",
          value: { title: "Captcha", text: "captcha challenge" },
        },
      },
    };
  };
  await assert.rejects(fetchPageText(send, "123", "7143769715"), { code: "WAF" });
});

test("IDs mode does not overwrite corpus output when every fetch fails", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xueqiu-ids-failed-"));
  let call = 0;
  const send = async () => {
    call += 1;
    if (call === 1) return runtimeJson({ error_code: 10020, error_description: "blocked" });
    return {
      result: {
        value: {
          status: 200,
          contentType: "text/html",
          text: "<html>_waf_ captcha</html>",
          value: { title: "Captcha", text: "captcha challenge" },
        },
      },
    };
  };
  try {
    const result = await runIdsMode(send, {
      refs: ["123"],
      userId: "7143769715",
      outDir: directory,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.items.length, 0);
    assert.equal(fs.existsSync(path.join(directory, "xueqiu_7143769715_ids.json")), false);
    assert.equal(fs.existsSync(path.join(directory, "xueqiu_7143769715_ids.md")), false);
    assert.equal(fs.existsSync(path.join(directory, "xueqiu_7143769715_ids_errors.json")), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("IDs mode returns partial status only when it has usable output", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xueqiu-ids-partial-"));
  let call = 0;
  const send = async () => {
    call += 1;
    if (call === 1) {
      return runtimeJson(timelineStatus(1, "2026-07-14 09:00:00"));
    }
    if (call === 2) return runtimeJson({ error_code: 10020, error_description: "blocked" });
    return {
      result: {
        value: {
          status: 200,
          contentType: "text/html",
          text: "<html>captcha</html>",
          value: { title: "Captcha", text: "captcha challenge" },
        },
      },
    };
  };
  try {
    const result = await runIdsMode(send, {
      refs: ["1", "2"],
      userId: "7143769715",
      outDir: directory,
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.items.length, 1);
    const stored = JSON.parse(
      fs.readFileSync(path.join(directory, "xueqiu_7143769715_ids.json"), "utf8"),
    );
    assert.deepEqual(stored.map((item) => item.id), ["1"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("IDs mode counts success only after both outputs are written", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xueqiu-ids-write-failed-"));
  const jsonPath = path.join(directory, "xueqiu_7143769715_ids.json");
  fs.mkdirSync(jsonPath);
  try {
    const result = await runIdsMode(
      async () => runtimeJson(timelineStatus(1, "2026-07-14 09:00:00")),
      {
        refs: ["1"],
        userId: "7143769715",
        outDir: directory,
      },
    );
    assert.equal(result.attemptedFetches, 1);
    assert.equal(result.successfulFetches, 0);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.items, []);
    assert.equal(fs.existsSync(path.join(directory, "xueqiu_7143769715_ids.md")), false);
    assert.equal(fs.existsSync(path.join(directory, "xueqiu_7143769715_ids_errors.json")), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("timeline scrapers reject HTTP 200 payloads without a timeline array", async () => {
  const send = async () => runtimeJson({});
  await assert.rejects(
    fetchBrowserTimeline(send, "7143769715", "posts", 1, 2, null, 0),
    { code: "INVALID_RESPONSE_SHAPE" },
  );
  const session = { send, async navigate() {} };
  await assert.rejects(
    fetchEdgeTimeline(session, "7143769715", "posts", edgeArgs(), {
      requests: 0,
      errors: 0,
      waf: 0,
    }),
    { code: "INVALID_RESPONSE_SHAPE" },
  );
});

test("browser scraper reports page-limit truncation instead of silent success", async () => {
  const send = async () => runtimeJson({
    statuses: [
      timelineStatus(2, "2026-07-14 09:00:00"),
      timelineStatus(1, "2026-07-14 08:00:00"),
    ],
  });
  const result = await fetchBrowserTimeline(send, "7143769715", "posts", 1, 2, null, 0);
  assert.equal(result.items.length, 2);
  assert.equal(result.truncated, true);
});
