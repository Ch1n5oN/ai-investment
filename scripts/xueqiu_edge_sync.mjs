#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CdpSession, sleep } from "./lib/cdp_session.mjs";
import {
  RECORD_CONTRACT,
  SCHEMA_VERSION,
  advanceSinceBoundary,
  atomicWrite,
  asciiTrim,
  canonicalTarget,
  checkpointStateForUser,
  classifyJsonResponse,
  cleanHtml,
  commentCoverageFor,
  confirmedPostIdsFor,
  exitCodeForStatus,
  extractArrayField,
  formatTime,
  initialCheckpointState,
  mergeById,
  normalizeNonNegativeInteger,
  pageableTimelineItems,
  paginationComplete,
  paginationResult,
  parseArgs,
  parseIntegerOption,
  readJsonStrict,
  reconcileCommentCountSurpluses,
  reconcileCommentVisibilityGaps,
  renderMarkdown,
  selectChangedPosts,
  syncStatusFor,
  toEpochMs,
  updatePostReplyCounts,
  upgradeRecord,
  validateDateOption,
  validateUserId,
} from "./lib/xueqiu_core.mjs";

const DEFAULT_USER_ID = "7143769715";

function assertAcquisitionContract(record, label) {
  const hasSchema = Object.hasOwn(record, "schema_version");
  const hasContract = Object.hasOwn(record, "record_contract");
  if (!hasSchema && !hasContract) return;
  if (!hasSchema
    || !hasContract
    || record.schema_version !== SCHEMA_VERSION
    || record.record_contract !== RECORD_CONTRACT) {
    throw Object.assign(new Error(`${label} has a conflicting normalized record contract.`), {
      code: "INVALID_RESPONSE_SHAPE",
    });
  }
}

function acquisitionId(value, label) {
  const id = typeof value === "string"
    ? asciiTrim(value)
    : Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : "";
  if (!/^\d+$/.test(id)) {
    throw Object.assign(new Error(`${label} must be a digit-only id.`), {
      code: "INVALID_RESPONSE_SHAPE",
    });
  }
  return id;
}

function optionalAcquisitionId(value, label) {
  return value === null || value === undefined ? null : acquisitionId(value, label);
}

export function upgradeEdgeReplyRecord(record, label = "stored reply") {
  const isPredecessor = record
    && typeof record === "object"
    && !Array.isArray(record)
    && record.schema_version === SCHEMA_VERSION
    && !Object.hasOwn(record, "record_contract")
    && (Object.hasOwn(record, "post_id") || Object.hasOwn(record, "post_target"))
    && Object.hasOwn(record, "post_created_at")
    && !Object.hasOwn(record, "post_created_at_raw");
  if (!isPredecessor) return upgradeRecord(record);

  const upgraded = {
    ...record,
    record_contract: RECORD_CONTRACT,
    post_created_at_raw: record.post_created_at,
    post_created_at: formatTime(record.post_created_at),
  };
  const migratedFields = ["record_contract", "post_created_at_raw"];
  if (Object.hasOwn(record, "legacy_migrated_fields")
      && (!Array.isArray(record.legacy_migrated_fields)
        || record.legacy_migrated_fields.some((field) => typeof field !== "string" || !field)
        || new Set(record.legacy_migrated_fields).size !== record.legacy_migrated_fields.length)) {
    throw Object.assign(new Error(`${label}.legacy_migrated_fields is invalid.`), {
      code: "INVALID_RECORD",
    });
  }
  for (const field of ["id", "post_id", "reply_to", "in_reply_to_comment_id"]) {
    if (!Object.hasOwn(upgraded, field) || upgraded[field] === null) continue;
    const normalized = field === "id" || field === "post_id"
      ? acquisitionId(upgraded[field], `${label}.${field}`)
      : optionalAcquisitionId(upgraded[field], `${label}.${field}`);
    if (normalized !== upgraded[field]) migratedFields.push(field);
    upgraded[field] = normalized;
  }
  upgraded.legacy_migrated_fields = [...new Set([
    ...(Array.isArray(record.legacy_migrated_fields) ? record.legacy_migrated_fields : []),
    ...migratedFields,
  ])].sort();
  return upgradeRecord(upgraded);
}

function responseField(record, aliases, label, { allowNull = false } = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw Object.assign(new Error(`${label} must be an object.`), { code: "INVALID_RESPONSE_SHAPE" });
  }
  for (const alias of aliases) {
    if (Object.hasOwn(record, alias)
        && record[alias] !== undefined
        && (allowNull || record[alias] !== null)) {
      return record[alias];
    }
  }
  throw Object.assign(new Error(`${label} is missing ${aliases.join("/")}.`), {
    code: "INVALID_RESPONSE_SHAPE",
  });
}

function optionalResponseString(record, field, label) {
  if (!Object.hasOwn(record, field) || record[field] === null) return "";
  if (typeof record[field] !== "string") {
    throw Object.assign(new Error(`${label} must be a string when supplied.`), {
      code: "INVALID_RESPONSE_SHAPE",
    });
  }
  return record[field];
}

function responseTarget(status, userId, postId) {
  const supplied = Object.hasOwn(status, "target") ? status.target : null;
  if (supplied !== null && supplied !== undefined && asciiTrim(supplied)) {
    return canonicalTarget(supplied, userId, postId);
  }
  return canonicalTarget("", userId, postId);
}

function normalizePost(status, userId = DEFAULT_USER_ID) {
  if (!status || status.id === undefined || status.id === null || status.id === "") {
    throw Object.assign(new Error("Timeline record is missing an id."), { code: "INVALID_RESPONSE_SHAPE" });
  }
  assertAcquisitionContract(status, "Timeline record");
  const id = acquisitionId(status.id, "Timeline record id");
  const rawText = responseField(status, ["text", "description"], "Timeline record text");
  if (!Object.hasOwn(status, "created_at")) {
    throw Object.assign(new Error("Timeline record is missing created_at."), {
      code: "INVALID_RESPONSE_SHAPE",
    });
  }
  const createdAt = status.created_at;
  return upgradeRecord({
    schema_version: SCHEMA_VERSION,
    record_contract: RECORD_CONTRACT,
    id,
    created_at_raw: createdAt,
    created_at: formatTime(createdAt),
    title: cleanHtml(status.title || status.rawTitle || ""),
    text: rawText,
    clean_text: cleanHtml(rawText),
    target: responseTarget(status, userId, id),
    reply_count: normalizeNonNegativeInteger(
      responseField(status, ["reply_count", "replyCount"], "Timeline record reply count"),
      "reply_count",
    ),
    like_count: normalizeNonNegativeInteger(
      responseField(status, ["like_count", "likeCount"], "Timeline record like count"),
      "like_count",
    ),
    retweet_count: normalizeNonNegativeInteger(
      responseField(status, ["retweet_count", "retweetCount"], "Timeline record retweet count"),
      "retweet_count",
    ),
    view_count: normalizeNonNegativeInteger(
      responseField(status, ["view_count", "viewCount"], "Timeline record view count"),
      "view_count",
    ),
  });
}

function commentUserId(comment) {
  return comment?.user?.id ?? comment?.user_id ?? comment?.userId;
}

function commentPost(comment, postIndex, userId) {
  const embedded = comment.status || comment.target_status || comment.original_status || {};
  const postId = acquisitionId(
    comment.status_id ?? embedded.id ?? comment.target_id,
    "Comment post id",
  );
  return postIndex.get(postId) || normalizePost(embedded, userId);
}

function normalizeReply(comment, post, origin = "user_comments", userId = DEFAULT_USER_ID) {
  if (!comment || comment.id === undefined || comment.id === null || comment.id === "") {
    throw Object.assign(new Error("Comment record is missing an id."), { code: "INVALID_RESPONSE_SHAPE" });
  }
  assertAcquisitionContract(comment, "Comment record");
  const id = acquisitionId(comment.id, "Comment record id");
  const postId = acquisitionId(comment.status_id ?? post?.id ?? comment.target_id, "Comment post id");
  const rawText = responseField(comment, ["text", "description"], "Comment text");
  const createdAt = responseField(comment, ["created_at"], "Comment timestamp", { allowNull: true });
  const postCreatedAtRaw = post?.created_at_raw ?? null;
  return upgradeRecord({
    schema_version: SCHEMA_VERSION,
    record_contract: RECORD_CONTRACT,
    id,
    created_at_raw: createdAt,
    created_at: formatTime(createdAt),
    text: rawText,
    clean_text: cleanHtml(rawText),
    reply_to: optionalAcquisitionId(
      comment.reply_to_id ?? comment.reply_to?.id,
      "Comment reply_to id",
    ),
    in_reply_to_comment_id: optionalAcquisitionId(
      comment.root_comment_id ?? comment.in_reply_to_comment_id,
      "Comment root id",
    ),
    post_id: postId,
    post_created_at_raw: postCreatedAtRaw,
    post_created_at: formatTime(postCreatedAtRaw),
    post_title: post?.title || "",
    post_text: post?.clean_text || post?.text || "",
    post_target: canonicalTarget(post?.target, userId, postId),
    like_count: normalizeNonNegativeInteger(
      responseField(comment, ["like_count", "likeCount"], "Comment like count"),
      "like_count",
    ),
    reply_count: normalizeNonNegativeInteger(
      responseField(comment, ["reply_count", "replyCount"], "Comment reply count"),
      "reply_count",
    ),
    origin,
    source: optionalResponseString(comment, "source", "Comment source"),
  });
}


async function browserJson(session, url, options) {
  let lastError;
  for (let attempt = 1; attempt <= options.retries + 1; attempt += 1) {
    const expression = `(() => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ${options.fetchTimeoutMs});
      return fetch(${JSON.stringify(url)}, {
        credentials: "include",
        signal: controller.signal,
        headers: {"Accept":"application/json,text/plain,*/*","X-Requested-With":"XMLHttpRequest"}
      }).then(async response => ({status: response.status, contentType: response.headers.get("content-type") || "", text: await response.text()}))
        .finally(() => clearTimeout(timer));
    })()`;
    try {
      const result = await session.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, options.fetchTimeoutMs + 3000);
      if (result.exceptionDetails) throw Object.assign(new Error(result.exceptionDetails.text || "browser fetch failed"), { code: "FETCH_FAILED" });
      options.metrics.requests += 1;
      return classifyJsonResponse(result.result.value, url);
    } catch (error) {
      lastError = error;
      options.metrics.errors += 1;
      if (error.code === "WAF") options.metrics.waf += 1;
      if (attempt > options.retries) break;
      await session.navigate(options.referer);
      const backoff = options.retryDelayMs * (2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * Math.min(250, options.retryDelayMs + 1));
      await sleep(backoff + jitter);
    }
  }
  throw lastError;
}

function hasTimelineInteractionCounts(status) {
  return [
    ["reply_count", "replyCount"],
    ["like_count", "likeCount"],
    ["retweet_count", "retweetCount"],
    ["view_count", "viewCount"],
  ].every((aliases) => aliases.some((field) => Object.hasOwn(status || {}, field) && status[field] !== null && status[field] !== undefined));
}

async function articleStatusForNormalization(session, status, userId, args, metrics) {
  if (hasTimelineInteractionCounts(status)) return status;
  const expectedId = acquisitionId(status?.id, "Article timeline record id");
  const url = `https://xueqiu.com/statuses/show.json?id=${expectedId}`;
  const detail = await browserJson(session, url, {
    ...args,
    metrics,
    referer: `https://xueqiu.com/${userId}/${expectedId}`,
  });
  const actualId = acquisitionId(detail?.id, "Article detail id");
  if (actualId !== expectedId) {
    throw Object.assign(new Error(`Article detail returned status ${actualId} while ${expectedId} was requested.`), {
      code: "INVALID_RESPONSE_SHAPE",
    });
  }
  const merged = { ...status, ...detail };
  if (status.view_count !== null && status.view_count !== undefined) {
    merged.view_count = status.view_count;
  } else if (status.viewCount !== null && status.viewCount !== undefined) {
    merged.view_count = status.viewCount;
  }
  return merged;
}

export async function fetchTimeline(session, userId, mode, args, metrics) {
  const endpoint = mode === "articles" ? "statuses/original/timeline.json" : "v4/statuses/user_timeline.json";
  let incoming = [];
  const observedPageableIds = new Set();
  let truncated = false;
  const sinceEpoch = args.sinceDate ? Date.parse(`${args.sinceDate}T00:00:00+08:00`) : null;
  let sinceBoundary = null;
  for (let page = 1; page <= args.timelinePages; page += 1) {
    const url = `https://xueqiu.com/${endpoint}?user_id=${userId}&page=${page}&count=${args.count}${mode === "posts" ? "&type=0" : ""}`;
    const data = await browserJson(session, url, { ...args, metrics, referer: `https://xueqiu.com/u/${userId}` });
    const raw = extractArrayField(data, ["statuses", "list", "items"], `${mode} timeline`);
    const pageable = new Set(pageableTimelineItems(raw, {
      page,
      count: args.count,
      label: `${mode} timeline pagination`,
    }));
    const pageableRecords = [];
    for (const status of raw) {
      const needsArticleDetail = mode === "articles" && !hasTimelineInteractionCounts(status);
      const source = needsArticleDetail
        ? await articleStatusForNormalization(session, status, userId, args, metrics)
        : status;
      const normalized = normalizePost(source, userId);
      incoming = mergeById(incoming, [normalized]);
      if (pageable.has(status)) {
        observedPageableIds.add(normalized.id);
        pageableRecords.push(normalized);
      }
      if (needsArticleDetail && args.requestDelayMs > 0) await sleep(args.requestDelayMs);
    }
    sinceBoundary = advanceSinceBoundary(sinceBoundary, pageableRecords, sinceEpoch);
    const complete = paginationComplete(data, {
      page,
      count: args.count,
      itemCount: pageable.size,
      observedCount: observedPageableIds.size,
      label: `${mode} timeline pagination`,
    });
    if (complete || sinceBoundary.confirmed) break;
    if (page === args.timelinePages) {
      truncated = true;
      break;
    }
    await sleep(args.requestDelayMs);
  }
  return {
    items: incoming.filter((item) => {
      if (!sinceEpoch) return true;
      const epoch = toEpochMs(item.created_at);
      return epoch === null || epoch >= sinceEpoch;
    }),
    truncated,
  };
}

function extractComments(data) {
  return extractArrayField(data, ["comments", "list", "items", "statuses"], "comment stream");
}

function commentEndpointCount(data, postId) {
  if (!Object.hasOwn(data, "count")) return null;
  try {
    return normalizeNonNegativeInteger(data.count, `post ${postId} comment count`);
  } catch (error) {
    throw Object.assign(
      new Error(`Post ${postId} comment count is invalid: ${error.message}`),
      { code: "INVALID_RESPONSE_SHAPE", cause: error },
    );
  }
}

function observedCommentId(comment) {
  return acquisitionId(comment?.id, "Comment record id");
}

function explicitCommentPostId(value, label) {
  return acquisitionId(value, label);
}

function assertCommentBelongsToPost(comment, postId) {
  const expected = String(postId);
  const references = [];
  for (const field of ["status_id", "target_id"]) {
    if (Object.hasOwn(comment, field)) references.push([field, comment[field]]);
  }
  for (const field of ["status", "target_status", "original_status"]) {
    if (!Object.hasOwn(comment, field) || comment[field] === null || comment[field] === undefined) continue;
    const embedded = comment[field];
    if (typeof embedded !== "object" || Array.isArray(embedded)) {
      throw Object.assign(new Error(`comment.${field} must be an object.`), {
        code: "INVALID_RESPONSE_SHAPE",
      });
    }
    if (Object.hasOwn(embedded, "id")) references.push([`${field}.id`, embedded.id]);
  }
  for (const [field, value] of references) {
    const actual = explicitCommentPostId(value, `comment.${field}`);
    if (actual !== expected) {
      throw Object.assign(
        new Error(`comment.${field} identifies post ${actual}, expected ${expected}.`),
        { code: "INVALID_RESPONSE_SHAPE" },
      );
    }
  }
}

export async function fetchUserCommentStream(session, userId, posts, args, metrics) {
  const postIndex = new Map(posts.map((post) => [String(post.id), post]));
  const endpoints = ["statuses/user_comments.json", "v4/statuses/user_comments.json"];
  let endpointError;
  for (const endpoint of endpoints) {
    try {
      let found = [];
      const observedIds = new Set();
      let truncated = false;
      for (let page = 1; page <= args.commentPages; page += 1) {
        const url = `https://xueqiu.com/${endpoint}?user_id=${userId}&page=${page}&count=${args.commentCount}`;
        const data = await browserJson(session, url, { ...args, metrics, referer: `https://xueqiu.com/u/${userId}` });
        const comments = extractComments(data);
        for (const comment of comments) {
          observedIds.add(observedCommentId(comment));
          if (String(commentUserId(comment)) === String(userId)) {
            found = mergeById(
              found,
              [normalizeReply(comment, commentPost(comment, postIndex, userId), "user_comments", userId)],
            );
          }
        }
        if (paginationComplete(data, {
          page,
          count: args.commentCount,
          itemCount: comments.length,
          observedCount: observedIds.size,
          label: "user comment pagination",
        })) {
          return { replies: found, endpoint, truncated: false };
        }
        if (page === args.commentPages) truncated = true;
        await sleep(args.requestDelayMs);
      }
      return { replies: found, endpoint, truncated };
    } catch (error) {
      endpointError = error;
      if (!["HTTP_404", "API_10020"].includes(error.code)) break;
    }
  }
  throw endpointError;
}

export function userCommentStreamCanAdvance() {
  // A global diagnostic stream cannot prove per-post main-stream coverage.
  return false;
}

function sameIdSet(left, right) {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

async function scanPostComments(session, userId, post, args, metrics) {
  let replies = [];
  const observedIds = new Set();
  let complete = false;
  let explicitTermination = false;
  let finalEndpointCount = null;
  for (let page = 1; page <= args.commentPages; page += 1) {
    const url = `https://xueqiu.com/statuses/comments.json?id=${post.id}&page=${page}&count=${args.commentCount}&type=status`;
    const data = await browserJson(session, url, {
      ...args,
      metrics,
      referer: post.target || `https://xueqiu.com/${userId}/${post.id}`,
    });
    const comments = extractComments(data);
    const endpointCount = commentEndpointCount(data, post.id);
    for (const comment of comments) {
      assertCommentBelongsToPost(comment, post.id);
      observedIds.add(observedCommentId(comment));
      if (String(commentUserId(comment)) === String(userId)) {
        replies = mergeById(replies, [normalizeReply(comment, post, "post_comments", userId)]);
      }
    }
    const pagination = paginationResult(data, {
      page,
      count: args.commentCount,
      itemCount: comments.length,
      observedCount: observedIds.size,
      label: `post ${post.id} comment pagination`,
    });
    if (pagination.complete) {
      complete = true;
      explicitTermination = pagination.explicitTermination;
      finalEndpointCount = endpointCount;
      break;
    }
  }
  return { replies, observedIds, complete, explicitTermination, finalEndpointCount };
}

export async function fetchChangedPostComments(session, userId, posts, previousCounts, args, metrics) {
  const changed = selectChangedPosts(posts, previousCounts, {
    limit: args.initialCommentPosts,
    force: args.forceComments,
  });
  let found = [];
  const scanned = [];
  const truncated = [];
  const unverified = [];
  const visibilityGaps = [];
  const countSurpluses = [];
  for (const post of changed) {
    try {
      let scan = await scanPostComments(session, userId, post, args, metrics);
      found = mergeById(found, scan.replies);
      let declaredCount = scan.finalEndpointCount ?? Number(post.reply_count);
      let stableSurplus = null;
      let contradictoryRescan = false;
      if (scan.complete && scan.explicitTermination && scan.observedIds.size > declaredCount) {
        await sleep(args.requestDelayMs);
        const verification = await scanPostComments(session, userId, post, args, metrics);
        found = mergeById(found, verification.replies);
        const verificationDeclared = verification.finalEndpointCount ?? Number(post.reply_count);
        const stableIds = sameIdSet(scan.observedIds, verification.observedIds);
        if (verification.complete
          && verification.explicitTermination
          && stableIds
          && verification.observedIds.size === verificationDeclared) {
          scan = verification;
          declaredCount = verificationDeclared;
        } else if (verification.complete
          && verification.explicitTermination
          && stableIds
          && verificationDeclared === declaredCount
          && verification.observedIds.size > verificationDeclared) {
          scan = verification;
          stableSurplus = {
            post_id: String(post.id),
            declared_count: verificationDeclared,
            visible_count: verification.observedIds.size,
            surplus_count: verification.observedIds.size - verificationDeclared,
            count_source: verification.finalEndpointCount === null
              ? "timeline"
              : "comment_endpoint_final_page",
            verification: "stable_double_scan",
          };
        } else {
          scan = verification;
          declaredCount = verificationDeclared;
          contradictoryRescan = true;
        }
      }
      const postId = String(post.id);
      if (!scan.complete) truncated.push(postId);
      if (contradictoryRescan
        || (scan.observedIds.size > declaredCount && !stableSurplus)
        || (scan.observedIds.size < declaredCount && !scan.explicitTermination)) {
        unverified.push(postId);
      } else if (stableSurplus) {
        countSurpluses.push(stableSurplus);
      } else if (scan.observedIds.size < declaredCount) {
        visibilityGaps.push({
          post_id: postId,
          declared_count: declaredCount,
          visible_count: scan.observedIds.size,
          unavailable_count: declaredCount - scan.observedIds.size,
          count_source: scan.finalEndpointCount === null
            ? "timeline"
            : "comment_endpoint_final_page",
        });
      }
      scanned.push(postId);
    } catch (error) {
      if (["WAF", "CDP_TIMEOUT", "FETCH_FAILED"].includes(error.code)) break;
      throw error;
    }
    await sleep(args.requestDelayMs);
  }
  return {
    replies: found,
    scanned,
    confirmed: confirmedPostIdsFor(scanned, truncated, unverified),
    truncated,
    unverified,
    visibilityGaps,
    countSurpluses,
    candidates: changed.map((post) => String(post.id)),
  };
}

function buildArgs(raw) {
  return {
    userId: validateUserId(raw.user_id, DEFAULT_USER_ID),
    cdp: raw.cdp || "http://127.0.0.1:9222",
    postsDir: raw["posts-dir"] || "output/bingbing_xiaomei_sync_browser",
    commentsDir: raw["comments-dir"] || "output/bingbing_xiaomei_sync_browser_comments",
    sinceDate: validateDateOption(raw["since-date"], "--since-date"),
    timelinePages: parseIntegerOption(raw["timeline-pages"], { name: "--timeline-pages", defaultValue: 3, min: 1 }),
    count: parseIntegerOption(raw.count, { name: "--count", defaultValue: 20, min: 1, max: 100 }),
    commentPages: parseIntegerOption(raw["comment-pages"], { name: "--comment-pages", defaultValue: 10, min: 1 }),
    commentCount: parseIntegerOption(raw["comment-count"], { name: "--comment-count", defaultValue: 20, min: 1, max: 100 }),
    initialCommentPosts: parseIntegerOption(raw["comment-posts"], { name: "--comment-posts", defaultValue: 20, min: 0 }),
    fetchTimeoutMs: parseIntegerOption(raw["timeout-ms"], { name: "--timeout-ms", defaultValue: 12000, min: 100 }),
    commandTimeoutMs: parseIntegerOption(raw["command-timeout-ms"], { name: "--command-timeout-ms", defaultValue: 15000, min: 100 }),
    requestDelayMs: parseIntegerOption(raw["delay-ms"], { name: "--delay-ms", defaultValue: 350, min: 0 }),
    retryDelayMs: parseIntegerOption(raw["retry-delay-ms"], { name: "--retry-delay-ms", defaultValue: 800, min: 0 }),
    retries: parseIntegerOption(raw.retries, { name: "--retries", defaultValue: 1, min: 0, max: 10 }),
    forceComments: Boolean(raw["force-comments"]),
    probeUserComments: Boolean(raw["probe-user-comments"]),
    skipComments: Boolean(raw["skip-comments"]),
    skipArticles: Boolean(raw["skip-articles"]),
  };
}

export function reportStatusFor(report, commentCoverage) {
  return syncStatusFor({
    commentCoverage,
    articleError: report.article_error
      || report.post_timeline_truncated
      || report.article_timeline_truncated
      || report.user_comment_stream_error
      || report.user_comment_stream_truncated,
  });
}

const INTERFACE_DRIFT_CODES = new Map([
  ["HTTP_404", "endpoint_missing"],
  ["INVALID_CONTENT_TYPE", "content_type"],
  ["INVALID_HTML", "response_encoding"],
  ["INVALID_JSON", "response_encoding"],
  ["INVALID_RESPONSE_SHAPE", "response_contract"],
]);

export function interfaceDriftFor(report) {
  const candidates = [
    ["sync", report.error],
    ["articles", report.article_error],
    ["user_comments", report.user_comment_stream_error],
  ];
  const signals = [];
  const seen = new Set();
  for (const [source, error] of candidates) {
    if (!error || typeof error !== "object" || Array.isArray(error)) continue;
    const code = typeof error.code === "string" ? error.code : "";
    const category = INTERFACE_DRIFT_CODES.get(code);
    if (!category) continue;
    const message = typeof error.message === "string" && error.message
      ? error.message
      : code;
    const fingerprint = `${source}\u0000${code}\u0000${message}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    signals.push({ source, category, code, message });
  }
  return { detected: signals.length > 0, signals };
}

async function main() {
  const started = Date.now();
  const rawArgs = parseArgs(process.argv.slice(2), {
    allowed: [
      "help", "user_id", "cdp", "posts-dir", "comments-dir", "since-date",
      "timeline-pages", "count", "comment-pages", "comment-count", "comment-posts",
      "timeout-ms", "command-timeout-ms", "delay-ms", "retry-delay-ms", "retries",
      "force-comments", "probe-user-comments", "skip-comments", "skip-articles",
    ],
    booleans: ["help", "force-comments", "probe-user-comments", "skip-comments", "skip-articles"],
  });
  if (rawArgs.help) {
    console.log(`Usage: node scripts/xueqiu_edge_sync.mjs [options]

Uses an existing logged-in Edge Xueqiu tab through CDP. No cookie file is needed.

Options:
  --user_id ID             Xueqiu user id (default: ${DEFAULT_USER_ID})
  --since-date YYYY-MM-DD  Stop timeline pagination at this date
  --timeline-pages N       Max timeline pages (default: 3)
  --comment-posts N        Recent posts tracked for comment changes (default: 20)
  --comment-pages N        Max comment pages per changed post (default: 10)
  --force-comments         Rescan recent posts even when reply counts are unchanged
  --skip-comments          Refresh posts/articles only
  --skip-articles          Skip article-list refresh
  --retries N              Retry count after timeout/WAF (default: 1)
  --timeout-ms N           Per-request browser timeout (default: 12000)
  --posts-dir PATH         Stable post/article output directory
  --comments-dir PATH      Stable reply/state/report output directory
  --probe-user-comments    Diagnose the optional user-comments endpoint
  --help                   Show this help`);
    return;
  }
  const args = buildArgs(rawArgs);
  const postsFile = path.join(args.postsDir, `xueqiu_${args.userId}_posts.json`);
  const postsMd = path.join(args.postsDir, `xueqiu_${args.userId}_posts.md`);
  const articlesFile = path.join(args.postsDir, `xueqiu_${args.userId}_articles.json`);
  const articlesMd = path.join(args.postsDir, `xueqiu_${args.userId}_articles.md`);
  const repliesFile = path.join(args.commentsDir, `xueqiu_${args.userId}_replies_2026.json`);
  const repliesMd = path.join(args.commentsDir, `xueqiu_${args.userId}_replies_2026.md`);
  const stateFile = path.join(args.commentsDir, `xueqiu_${args.userId}_edge_sync_state.json`);
  const reportFile = path.join(args.commentsDir, `xueqiu_${args.userId}_edge_sync_report.json`);
  const metrics = { requests: 0, errors: 0, waf: 0 };
  const report = {
    schema_version: SCHEMA_VERSION,
    user_id: args.userId,
    started_at: new Date(started).toISOString(),
    status: "running",
    metrics,
  };
  const session = new CdpSession(args.cdp, { commandTimeoutMs: args.commandTimeoutMs });

  try {
    const previousState = checkpointStateForUser(
      readJsonStrict(stateFile, { defaultValue: initialCheckpointState(args.userId) }),
      args.userId,
    );
    const oldPosts = readJsonStrict(
      postsFile,
      { defaultValue: [], validate: Array.isArray },
    ).map(upgradeRecord);
    let articles = readJsonStrict(
      articlesFile,
      { defaultValue: [], validate: Array.isArray },
    ).map(upgradeRecord);
    const oldReplies = readJsonStrict(
      repliesFile,
      { defaultValue: [], validate: Array.isArray },
    ).map((record, index) => upgradeEdgeReplyRecord(record, `stored reply[${index}]`));

    await session.connect();
    await session.enablePage();
    await session.navigate(`https://xueqiu.com/u/${args.userId}`);

    const postTimeline = await fetchTimeline(session, args.userId, "posts", args, metrics);
    const posts = mergeById(oldPosts, postTimeline.items);
    report.post_timeline_truncated = postTimeline.truncated;
    atomicWrite(postsFile, JSON.stringify(posts, null, 2));
    atomicWrite(postsMd, renderMarkdown(posts, "posts"));

    if (!args.skipArticles) {
      try {
        const articleTimeline = await fetchTimeline(session, args.userId, "articles", args, metrics);
        articles = mergeById(articles, articleTimeline.items);
        report.article_timeline_truncated = articleTimeline.truncated;
        atomicWrite(articlesFile, JSON.stringify(articles, null, 2));
        atomicWrite(articlesMd, renderMarkdown(articles, "articles"));
      } catch (error) {
        report.article_error = { code: error.code || "ERROR", message: error.message };
      }
    }

    let incomingReplies = [];
    let commentMethod = "skipped";
    let commentCoverage = "not_requested";
    let scannedPostIds = [];
    let commentVisibilityGaps = previousState.comment_visibility_gaps || [];
    let commentCountSurpluses = previousState.comment_count_surpluses || [];
    if (!args.skipComments) {
      if (args.probeUserComments) {
        try {
          const stream = await fetchUserCommentStream(session, args.userId, posts, args, metrics);
          incomingReplies = stream.replies;
          commentMethod = stream.endpoint;
          if (stream.truncated) {
            report.user_comment_stream_truncated = true;
          } else if (stream.replies.length > 0) {
            report.user_comment_stream_observed = stream.replies.length;
          } else {
            report.user_comment_stream_empty = true;
          }
        } catch (streamError) {
          report.user_comment_stream_error = { code: streamError.code || "ERROR", message: streamError.message };
        }
      }
      const fallback = await fetchChangedPostComments(session, args.userId, posts, previousState.post_reply_counts || {}, args, metrics);
      const hadDiagnosticReplies = incomingReplies.length > 0;
      incomingReplies = mergeById(incomingReplies, fallback.replies);
      scannedPostIds = fallback.confirmed;
      commentVisibilityGaps = reconcileCommentVisibilityGaps(
        commentVisibilityGaps,
        fallback.visibilityGaps,
        fallback.confirmed,
        posts.slice(0, args.initialCommentPosts).map((post) => String(post.id)),
      );
      commentCountSurpluses = reconcileCommentCountSurpluses(
        commentCountSurpluses,
        fallback.countSurpluses,
        fallback.confirmed,
        posts.slice(0, args.initialCommentPosts).map((post) => String(post.id)),
      );
      commentMethod = hadDiagnosticReplies
        ? "user_comments+changed_post_comments"
        : "changed_post_comments";
      commentCoverage = commentCoverageFor({
        ...fallback,
        visibilityGaps: commentVisibilityGaps,
        countSurpluses: commentCountSurpluses,
      });
      report.comment_candidates = fallback.candidates;
      report.comment_scanned = fallback.scanned;
      report.comment_confirmed = fallback.confirmed;
      report.comment_truncated = fallback.truncated;
      report.comment_unverified = fallback.unverified;
      report.comment_visibility_gaps = commentVisibilityGaps;
      report.comment_count_surpluses = commentCountSurpluses;
      const replies = mergeById(oldReplies, incomingReplies);
      atomicWrite(repliesFile, JSON.stringify(replies, null, 2));
      atomicWrite(repliesMd, renderMarkdown(replies, "self replies"));
      report.self_replies_total = replies.length;
      report.self_replies_added = replies.length - oldReplies.length;
    }

    const confirmedPostIds = scannedPostIds;
    const postReplyCounts = updatePostReplyCounts(
      posts,
      previousState.post_reply_counts,
      confirmedPostIds,
      args.initialCommentPosts,
    );
    const state = {
      schema_version: SCHEMA_VERSION,
      user_id: args.userId,
      updated_at: new Date().toISOString(),
      latest_post_id: posts[0]?.id || null,
      latest_post_time: posts[0]?.created_at || null,
      post_reply_counts: postReplyCounts,
      comment_method: commentMethod,
      comment_coverage: commentCoverage,
      scanned_post_ids: report.comment_scanned || scannedPostIds,
      confirmed_post_ids: confirmedPostIds,
      comment_visibility_gaps: commentVisibilityGaps,
      comment_count_surpluses: commentCountSurpluses,
      nested_reply_coverage: "not_guaranteed_api_10020",
    };
    atomicWrite(stateFile, JSON.stringify(state, null, 2));
    Object.assign(report, {
      status: reportStatusFor(report, commentCoverage),
      finished_at: new Date().toISOString(),
      elapsed_ms: Date.now() - started,
      posts_total: posts.length,
      posts_added: posts.length - oldPosts.length,
      articles_total: articles.length,
      comment_method: commentMethod,
      comment_coverage: commentCoverage,
      comment_visibility_gaps: commentVisibilityGaps,
      comment_count_surpluses: commentCountSurpluses,
      nested_reply_coverage: "not_guaranteed_api_10020",
    });
    process.exitCode = exitCodeForStatus(report.status);
  } catch (error) {
    Object.assign(report, {
      status: "failed",
      finished_at: new Date().toISOString(),
      elapsed_ms: Date.now() - started,
      error: { code: error.code || "ERROR", message: error.message },
    });
    process.exitCode = 1;
  } finally {
    session.close();
    report.interface_drift = interfaceDriftFor(report);
    atomicWrite(reportFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}

const scriptFile = fileURLToPath(import.meta.url);
if (path.resolve(process.argv[1] || "") === scriptFile) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
