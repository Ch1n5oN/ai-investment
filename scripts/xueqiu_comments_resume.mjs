#!/usr/bin/env node
// Legacy bounded recovery utility. Use xueqiu_edge_sync.mjs for recurring syncs.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CdpSession, sleep } from "./lib/cdp_session.mjs";
import {
  RECORD_CONTRACT,
  SCHEMA_VERSION,
  asciiTrim,
  atomicWrite,
  canonicalTarget,
  classifyJsonResponse,
  cleanHtml,
  extractArrayField,
  formatTime,
  normalizeNonNegativeInteger,
  parseArgs,
  parseIntegerOption,
  readJsonStrict,
  upgradeRecord,
  validateUserId,
} from "./lib/xueqiu_core.mjs";

const LEGACY_RECORD_CONTRACT = "legacy_normalized_v1";
const LEGACY_POST_FIELDS = new Set([
  "schema_version", "record_contract", "id", "created_at", "created_at_raw",
  "created_ms", "mode", "target", "title", "text", "clean_text",
  "reply_count", "like_count", "retweet_count", "view_count",
  "legacy_migrated_fields",
]);
const LEGACY_REPLY_FIELDS = new Set([
  "schema_version", "record_contract", "id", "created_at", "created_at_raw",
  "created_ms", "post_id", "post_created_at", "post_created_at_raw",
  "post_link", "post_target", "post_title", "post_text", "post_excerpt",
  "text", "clean_text", "reply_to", "in_reply_to_comment_id", "like_count",
  "reply_count", "status_id", "source", "origin", "fetched_from_page",
  "post_reply_count", "legacy_migrated_fields",
]);

export async function browserFetch(send, url, timeoutMs) {
  const expression = `(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ${timeoutMs});
    try {
      const response = await fetch(${JSON.stringify(url)}, {
        credentials: "include",
        signal: controller.signal,
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "application/json,text/plain,*/*"
        }
      });
      return {status: response.status, contentType: response.headers.get("content-type") || "", text: await response.text()};
    } finally {
      clearTimeout(timer);
    }
  })()`;
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "fetch failed");
  const payload = result.result.value;
  try {
    return classifyJsonResponse(payload, url);
  } catch (error) {
    const status = /^HTTP_(\d+)$/.exec(error.code || "")?.[1];
    if (status) error.status = Number(status);
    throw error;
  }
}

function getCommentUserId(comment) {
  return comment?.user?.id ?? comment?.user_id ?? comment?.userId;
}

function normalizeId(value, name) {
  const id = asciiTrim(value ?? "");
  if (!/^\d+$/.test(id)) {
    throw Object.assign(new Error(`${name} must contain digits only.`), { code: "INVALID_RECORD" });
  }
  return id;
}

function normalizeOptionalId(value, name) {
  return value === undefined || value === null || value === "" ? null : normalizeId(value, name);
}

function validateComment(comment) {
  if (!comment || typeof comment !== "object" || Array.isArray(comment)) {
    throw Object.assign(new Error("Comment records must be objects."), { code: "INVALID_RESPONSE_SHAPE" });
  }
  if (comment.text !== undefined && typeof comment.text !== "string") {
    throw Object.assign(new Error("comment.text must be a string."), { code: "INVALID_RECORD" });
  }
  return comment;
}

function invalidResponse(message) {
  return Object.assign(new Error(message), { code: "INVALID_RESPONSE_SHAPE" });
}

function explicitCommentPostIds(comment) {
  validateComment(comment);
  const associations = [];
  for (const field of ["status_id", "target_id", "statusId", "targetId"]) {
    if (!Object.hasOwn(comment, field)) continue;
    associations.push([field, normalizeId(comment[field], `comment.${field}`)]);
  }
  for (const field of ["status", "target_status", "original_status"]) {
    if (!Object.hasOwn(comment, field) || comment[field] === null || comment[field] === undefined) continue;
    const embedded = comment[field];
    if (!embedded || typeof embedded !== "object" || Array.isArray(embedded)) {
      throw invalidResponse(`comment.${field} must be an object when supplied.`);
    }
    if (Object.hasOwn(embedded, "id")) {
      associations.push([`${field}.id`, normalizeId(embedded.id, `comment.${field}.id`)]);
    }
  }
  return associations;
}

export function assertCommentBelongsToPost(comment, post) {
  const expected = normalizeId(post?.id, "post.id");
  for (const [field, actual] of explicitCommentPostIds(comment)) {
    if (actual !== expected) {
      throw invalidResponse(`comment.${field} ${actual} does not belong to post ${expected}.`);
    }
  }
  return comment;
}

function paginationContainers(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw invalidResponse("Comment pagination response must be an object.");
  }
  const containers = [data];
  for (const key of ["meta", "pagination", "page_info"]) {
    if (!Object.hasOwn(data, key)) continue;
    if (!data[key] || typeof data[key] !== "object" || Array.isArray(data[key])) {
      throw invalidResponse(`Comment pagination ${key} must be an object.`);
    }
    containers.push(data[key]);
  }
  if (data.page && typeof data.page === "object" && !Array.isArray(data.page)) {
    containers.push(data.page);
  }
  return containers;
}

function paginationMetadata(containers, aliases, label, validate) {
  const values = [];
  for (const container of containers) {
    for (const alias of aliases) {
      if (!Object.hasOwn(container, alias)) continue;
      const value = container[alias];
      if (!validate(value)) {
        throw invalidResponse(`Comment pagination ${alias} has an invalid ${label} value.`);
      }
      values.push([alias, value]);
    }
  }
  if (new Set(values.map(([, value]) => value)).size > 1) {
    throw invalidResponse(`Comment pagination has conflicting ${label} metadata.`);
  }
  return values;
}

export function commentPageComplete(
  data,
  page,
  count,
  itemCount,
  observedCount = (page - 1) * count + itemCount,
) {
  for (const [value, label, minimum] of [
    [page, "page", 1],
    [count, "count", 1],
    [itemCount, "item count", 0],
    [observedCount, "observed count", 0],
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw invalidResponse(`Comment pagination ${label} must be an integer >= ${minimum}.`);
    }
  }
  if (itemCount > count) {
    throw invalidResponse("Comment pagination item count exceeds the requested count.");
  }
  if (observedCount < itemCount) {
    throw invalidResponse("Comment pagination observed count is below the current item count.");
  }

  const containers = paginationContainers(data);
  const hasMore = paginationMetadata(
    containers,
    ["has_more", "hasMore"],
    "has_more",
    (value) => typeof value === "boolean",
  );
  const maxPage = paginationMetadata(
    containers,
    ["max_page", "maxPage", "page_count", "pageCount", "total_pages", "totalPages"],
    "max_page",
    (value) => Number.isSafeInteger(value) && value >= 1,
  );
  const total = paginationMetadata(
    containers,
    ["total", "total_count", "totalCount"],
    "total",
    (value) => Number.isSafeInteger(value) && value >= 0,
  );

  const evidence = [];
  if (hasMore.length) evidence.push([hasMore[0][1] ? "more" : "complete", hasMore[0][0]]);
  if (maxPage.length) {
    const declaredMaxPage = maxPage[0][1];
    if (page > declaredMaxPage) {
      throw invalidResponse(`Comment pagination page ${page} exceeds max_page ${declaredMaxPage}.`);
    }
    evidence.push([page === declaredMaxPage ? "complete" : "more", maxPage[0][0]]);
  }
  if (total.length) {
    const declaredTotal = total[0][1];
    if (declaredTotal < observedCount) {
      throw invalidResponse(`Comment pagination total ${declaredTotal} is below ${observedCount} observed items.`);
    }
    evidence.push([declaredTotal === observedCount ? "complete" : "more", total[0][0]]);
  }
  if (maxPage.length && total.length) {
    const expectedMaxPage = Math.max(1, Math.ceil(total[0][1] / count));
    if (maxPage[0][1] !== expectedMaxPage) {
      throw invalidResponse("Comment pagination max_page conflicts with total and count.");
    }
  }

  const states = new Set(evidence.map(([state]) => state));
  if (states.size > 1) {
    throw invalidResponse("Comment pagination metadata is internally inconsistent.");
  }
  if (states.has("more")) return false;
  if (states.has("complete")) return true;
  return itemCount < count;
}

function requiredCommentField(comment, aliases, label, { allowNull = false } = {}) {
  validateComment(comment);
  for (const alias of aliases) {
    if (Object.hasOwn(comment, alias)
      && comment[alias] !== undefined
      && (allowNull || comment[alias] !== null)) {
      return comment[alias];
    }
  }
  throw Object.assign(new Error(`${label} is missing ${aliases.join("/")}.`), {
    code: "INVALID_RESPONSE_SHAPE",
  });
}

function optionalCommentString(comment, field, label) {
  if (!Object.hasOwn(comment, field) || comment[field] === null) return "";
  if (typeof comment[field] !== "string") {
    throw Object.assign(new Error(`${label} must be a string when supplied.`), {
      code: "INVALID_RESPONSE_SHAPE",
    });
  }
  return comment[field];
}

function legacyString(record, field, label, { optional = true } = {}) {
  if (!Object.hasOwn(record, field)) {
    if (optional) return undefined;
    throw Object.assign(new Error(`${label}.${field} is required.`), { code: "INVALID_RECORD" });
  }
  if (typeof record[field] !== "string") {
    throw Object.assign(new Error(`${label}.${field} must be a string.`), { code: "INVALID_RECORD" });
  }
  return record[field];
}

function isExplicitUnknownLegacyTime(value) {
  if (value === null || value === 0) return true;
  if (typeof value !== "string") return false;
  const normalized = asciiTrim(value);
  return normalized === ""
    || normalized.toLowerCase() === "unknown"
    || normalized === "未知时间";
}

function legacyTimePair(record, field, label, { required = true, strict = false } = {}) {
  const rawField = `${field}_raw`;
  const hasRaw = Object.hasOwn(record, rawField);
  const hasNormalized = Object.hasOwn(record, field);
  if (strict && hasRaw !== hasNormalized) {
    throw Object.assign(new Error(`${label}.${rawField} and ${field} must be preserved together.`), {
      code: "INVALID_RECORD",
    });
  }
  if (!hasRaw && !hasNormalized) {
    if (!required) return null;
    throw Object.assign(new Error(`${label}.${field} is required.`), { code: "INVALID_RECORD" });
  }
  const raw = hasRaw ? record[rawField] : record[field];
  const normalized = formatTime(raw);
  if (normalized === "unknown" && !isExplicitUnknownLegacyTime(raw)) {
    throw Object.assign(new Error(`${label}.${rawField} must preserve a valid timestamp or an explicit unknown value.`), {
      code: "INVALID_RECORD",
    });
  }
  if (hasRaw
      && hasNormalized
      && (strict ? record[field] !== normalized : formatTime(record[field]) !== normalized)) {
    throw Object.assign(new Error(`${label}.${field} does not represent ${rawField}.`), {
      code: "INVALID_RECORD",
    });
  }
  return { raw, normalized };
}

function strictLegacyId(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw Object.assign(new Error(`${name} must be a digit-only string.`), { code: "INVALID_RECORD" });
  }
  return value;
}

function legacyCount(value, name, { strict = false, positive = false } = {}) {
  const count = strict
    ? value
    : normalizeNonNegativeInteger(value, name);
  const minimum = positive ? 1 : 0;
  if (!Number.isSafeInteger(count) || count < minimum) {
    throw Object.assign(new Error(`${name} must be a safe integer >= ${minimum}.`), {
      code: "INVALID_RECORD",
    });
  }
  return count;
}

function legacyCanonicalTarget(value, userId, postId, label) {
  try {
    return canonicalTarget(value, userId, postId);
  } catch (error) {
    throw Object.assign(new Error(`${label} must identify Xueqiu post ${userId}/${postId}.`), {
      code: "INVALID_RECORD",
      cause: error,
    });
  }
}

function normalizeLegacyRecoveryRecord(record, label, userId, { strict = false } = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw Object.assign(new Error(`${label} must be an object.`), { code: "INVALID_RECORD" });
  }
  const isReply = Object.hasOwn(record, "post_id")
    || Object.hasOwn(record, "post_target")
    || Object.hasOwn(record, "post_link");
  const allowed = isReply ? LEGACY_REPLY_FIELDS : LEGACY_POST_FIELDS;
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) {
      throw Object.assign(new Error(`${label}.${field} is not allowed in recovery data.`), {
        code: "INVALID_RECORD",
      });
    }
  }
  if (strict
      && (record.schema_version !== SCHEMA_VERSION
        || record.record_contract !== LEGACY_RECORD_CONTRACT)) {
    throw Object.assign(new Error(`${label} has an invalid declared legacy contract.`), {
      code: "INVALID_RECORD",
    });
  }
  const time = legacyTimePair(record, "created_at", label, { strict });
  const text = legacyString(record, "text", label);
  let cleaned = legacyString(record, "clean_text", label);
  if (text === undefined && cleaned === undefined) {
    throw Object.assign(new Error(`${label} must preserve text or clean_text.`), { code: "INVALID_RECORD" });
  }
  if (cleaned === undefined) cleaned = cleanHtml(text);
  if (text !== undefined && cleaned !== cleanHtml(text)) {
    throw Object.assign(new Error(`${label}.clean_text must match the deterministic text normalizer.`), {
      code: "INVALID_RECORD",
    });
  }
  const normalized = {
    schema_version: SCHEMA_VERSION,
    record_contract: LEGACY_RECORD_CONTRACT,
    id: strict ? strictLegacyId(record.id, `${label}.id`) : normalizeId(record.id, `${label}.id`),
    created_at_raw: time.raw,
    created_at: time.normalized,
    ...(text === undefined ? {} : { text }),
    clean_text: cleaned,
  };

  if (isReply) {
    normalized.post_id = strict
      ? strictLegacyId(record.post_id, `${label}.post_id`)
      : normalizeId(record.post_id, `${label}.post_id`);
    const preservedPostTarget = record.post_target ?? record.post_link;
    if (preservedPostTarget === undefined || preservedPostTarget === null || preservedPostTarget === "") {
      throw Object.assign(new Error(`${label} must preserve post_target or post_link.`), {
        code: "INVALID_RECORD",
      });
    }
    normalized.post_target = legacyCanonicalTarget(
      preservedPostTarget,
      userId,
      normalized.post_id,
      `${label}.post_target`,
    );
    if (strict && normalized.post_target !== preservedPostTarget) {
      throw Object.assign(new Error(`${label} post URL must already be canonical.`), {
        code: "INVALID_RECORD",
      });
    }
    if (Object.hasOwn(record, "post_target") && Object.hasOwn(record, "post_link")) {
      const canonicalPostLink = legacyCanonicalTarget(
        record.post_link,
        userId,
        normalized.post_id,
        `${label}.post_link`,
      );
      if (canonicalPostLink !== normalized.post_target) {
        throw Object.assign(new Error(`${label} has conflicting post_target and post_link values.`), {
          code: "INVALID_RECORD",
        });
      }
    }
    normalized.like_count = legacyCount(record.like_count, `${label}.like_count`, { strict });
    if (Object.hasOwn(record, "reply_count")) {
      normalized.reply_count = legacyCount(record.reply_count, `${label}.reply_count`, { strict });
    }
    for (const field of ["reply_to", "in_reply_to_comment_id"]) {
      if (Object.hasOwn(record, field)) {
        normalized[field] = strict
          ? strictLegacyId(record[field], `${label}.${field}`, { nullable: true })
          : normalizeOptionalId(record[field], `${label}.${field}`);
      }
    }
    const postTime = legacyTimePair(record, "post_created_at", label, { required: false, strict });
    if (postTime) {
      normalized.post_created_at_raw = postTime.raw;
      normalized.post_created_at = postTime.normalized;
    }
    for (const field of ["post_title", "post_text", "post_excerpt", "source", "origin"]) {
      const value = legacyString(record, field, label);
      if (value !== undefined) normalized[field] = value;
    }
    if (Object.hasOwn(record, "status_id")) {
      normalized.status_id = strict
        ? strictLegacyId(record.status_id, `${label}.status_id`, { nullable: true })
        : normalizeOptionalId(record.status_id, `${label}.status_id`);
      if (normalized.status_id !== null && normalized.status_id !== normalized.post_id) {
        throw Object.assign(new Error(`${label}.status_id must identify post_id.`), {
          code: "INVALID_RECORD",
        });
      }
    }
    if (Object.hasOwn(record, "fetched_from_page")) {
      normalized.fetched_from_page = legacyCount(
        record.fetched_from_page,
        `${label}.fetched_from_page`,
        { strict, positive: true },
      );
    }
    if (Object.hasOwn(record, "post_reply_count")) {
      normalized.post_reply_count = legacyCount(
        record.post_reply_count,
        `${label}.post_reply_count`,
        { strict },
      );
    }
  } else {
    if (record.target === undefined || record.target === null || record.target === "") {
      throw Object.assign(new Error(`${label} must preserve target.`), { code: "INVALID_RECORD" });
    }
    normalized.target = legacyCanonicalTarget(
      record.target,
      userId,
      normalized.id,
      `${label}.target`,
    );
    if (strict && normalized.target !== record.target) {
      throw Object.assign(new Error(`${label}.target must already be canonical.`), {
        code: "INVALID_RECORD",
      });
    }
    for (const field of ["reply_count", "like_count", "retweet_count", "view_count"]) {
      if (!Object.hasOwn(record, field)) {
        throw Object.assign(new Error(`${label}.${field} is required.`), { code: "INVALID_RECORD" });
      }
      normalized[field] = legacyCount(record[field], `${label}.${field}`, { strict });
    }
    for (const field of ["title", "mode"]) {
      const value = legacyString(record, field, label);
      if (value !== undefined) normalized[field] = value;
    }
  }
  if (Object.hasOwn(record, "created_ms")) {
    normalized.created_ms = legacyCount(record.created_ms, `${label}.created_ms`, { strict });
  }
  if (Object.hasOwn(record, "legacy_migrated_fields")) {
    if (!Array.isArray(record.legacy_migrated_fields)
        || !record.legacy_migrated_fields.every((item) => typeof item === "string" && item)) {
      throw Object.assign(new Error(`${label}.legacy_migrated_fields is invalid.`), {
        code: "INVALID_RECORD",
      });
    }
    normalized.legacy_migrated_fields = [...new Set(record.legacy_migrated_fields)].sort();
  }
  // Unversioned data is explicitly migrated to the recovery contract. A record that
  // already declares that contract is validated without correcting or rewriting it.
  return strict ? { ...record } : normalized;
}

export function upgradeRecoveryRecords(records, label, userId) {
  const seen = new Set();
  return records.map((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw Object.assign(new Error(`${label}[${index}] must be an object.`), {
        code: "INVALID_RECORD",
      });
    }
    const hasSchema = Object.hasOwn(record, "schema_version");
    const hasContract = Object.hasOwn(record, "record_contract");
    const unversionedLegacy = !hasSchema && !hasContract;
    const declaredLegacy = hasSchema
      && hasContract
      && record.schema_version === SCHEMA_VERSION
      && record.record_contract === LEGACY_RECORD_CONTRACT;
    const upgraded = unversionedLegacy
      ? normalizeLegacyRecoveryRecord(record, `${label}[${index}]`, userId)
      : declaredLegacy
        ? normalizeLegacyRecoveryRecord(record, `${label}[${index}]`, userId, { strict: true })
        : upgradeRecord(record);
    if (seen.has(upgraded.id)) {
      throw Object.assign(new Error(`${label} contains duplicate id ${upgraded.id} at index ${index}.`), {
        code: "INVALID_RECORD",
      });
    }
    seen.add(upgraded.id);
    return upgraded;
  });
}

export function normalizeReply(comment, post, userId) {
  assertCommentBelongsToPost(comment, post);
  const id = normalizeId(comment?.id, "comment.id");
  const postId = normalizeId(comment?.status_id ?? post?.id, "comment.status_id");
  const createdAt = requiredCommentField(comment, ["created_at"], "comment timestamp", { allowNull: true });
  const text = requiredCommentField(comment, ["text", "description"], "comment text");
  return upgradeRecord({
    schema_version: SCHEMA_VERSION,
    record_contract: RECORD_CONTRACT,
    id,
    created_at_raw: createdAt,
    created_at: formatTime(createdAt),
    text,
    clean_text: cleanHtml(text),
    reply_to: normalizeOptionalId(comment.reply_to_id ?? comment.reply_to?.id, "comment.reply_to_id"),
    in_reply_to_comment_id: null,
    post_id: postId,
    post_created_at_raw: post.created_at_raw ?? null,
    post_created_at: formatTime(post.created_at_raw ?? null),
    post_title: post.title || "",
    post_text: post.clean_text || post.text || "",
    post_target: canonicalTarget(post.target, userId, post.id),
    like_count: normalizeNonNegativeInteger(
      requiredCommentField(comment, ["like_count", "likeCount"], "comment like count"),
      "like_count",
    ),
    reply_count: normalizeNonNegativeInteger(
      requiredCommentField(comment, ["reply_count", "replyCount"], "comment reply count"),
      "reply_count",
    ),
    origin: "post_comments",
    source: optionalCommentString(comment, "source", "comment source"),
  });
}

export function normalizeNestedReply(comment, post, rootCommentId, userId) {
  assertCommentBelongsToPost(comment, post);
  const id = normalizeId(comment?.id, "comment.id");
  const postId = normalizeId(comment?.status_id ?? post?.id, "comment.status_id");
  const createdAt = requiredCommentField(comment, ["created_at"], "comment timestamp", { allowNull: true });
  const text = requiredCommentField(comment, ["text", "description"], "comment text");
  return upgradeRecord({
    schema_version: SCHEMA_VERSION,
    record_contract: RECORD_CONTRACT,
    id,
    created_at_raw: createdAt,
    created_at: formatTime(createdAt),
    text,
    clean_text: cleanHtml(text),
    reply_to: normalizeOptionalId(comment.reply_to_id ?? comment.reply_to?.id, "comment.reply_to_id"),
    in_reply_to_comment_id: normalizeId(rootCommentId, "root comment id"),
    post_id: postId,
    post_created_at_raw: post.created_at_raw ?? null,
    post_created_at: formatTime(post.created_at_raw ?? null),
    post_title: post.title || "",
    post_text: post.clean_text || post.text || "",
    post_target: canonicalTarget(post.target, userId, post.id),
    like_count: normalizeNonNegativeInteger(
      requiredCommentField(comment, ["like_count", "likeCount"], "comment like count"),
      "like_count",
    ),
    reply_count: normalizeNonNegativeInteger(
      requiredCommentField(comment, ["reply_count", "replyCount"], "comment reply count"),
      "reply_count",
    ),
    origin: "comment_replies",
    source: optionalCommentString(comment, "source", "comment source"),
  });
}

function writeOutputs({ outDir, userId, replies, meta }) {
  fs.mkdirSync(outDir, { recursive: true });
  const jsonFile = path.join(outDir, `xueqiu_${userId}_replies_2026.json`);
  const mdFile = path.join(outDir, `xueqiu_${userId}_replies_2026.md`);
  const metaFile = path.join(outDir, `xueqiu_${userId}_replies_2026_meta.json`);

  meta.totalReplies = replies.length;
  meta.repliesFingerprint = repliesFingerprint(replies);
  atomicWrite(jsonFile, JSON.stringify(replies, null, 2));
  atomicWrite(metaFile, JSON.stringify(meta, null, 2));

  const md = [
    `# Xueqiu user ${userId} replies 2026`,
    "",
    `Updated at: ${new Date().toISOString()}`,
    `Total replies: ${replies.length}`,
    `Scanned posts: ${meta.scannedPosts || 0}/${meta.totalPosts || ""}`,
    "",
    "---",
    "",
    ...replies.flatMap((reply, index) => [
      `## Reply ${index + 1}`,
      "",
      `ID: ${reply.id || ""}`,
      `Time: ${reply.created_at || ""}`,
      `Origin: ${reply.origin || "post_comments"}`,
      `Post ID: ${reply.post_id || ""}`,
      `Post Time: ${reply.post_created_at || ""}`,
      `Post Link: ${reply.post_target || ""}`,
      `Likes: ${reply.like_count || 0}`,
      "",
      reply.clean_text || cleanHtml(reply.text || ""),
      "",
      "---",
      "",
    ]),
  ].join("\n");
  atomicWrite(mdFile, md);
}

export async function fetchNestedRepliesForComment({ send, post, commentId, userId, count, pageDelayMs, timeoutMs, subReplyPageLimit }) {
  const found = [];
  const observedIds = new Set();
  let complete = false;
  for (let page = 1; page <= subReplyPageLimit; page += 1) {
    const url = `https://xueqiu.com/comments/replies.json?comment_id=${encodeURIComponent(commentId)}&page=${page}&count=${count}`;
    const data = await browserFetch(send, url, timeoutMs);
    const comments = extractArrayField(data, ["comments", "list"], "nested comment stream");
    for (const comment of comments) {
      assertCommentBelongsToPost(comment, post);
      observedIds.add(normalizeId(comment.id, "comment.id"));
      if (String(getCommentUserId(comment)) === String(userId)) {
        found.push(normalizeNestedReply(comment, post, commentId, userId));
      }
    }
    if (commentPageComplete(data, page, count, comments.length, observedIds.size)) {
      complete = true;
      break;
    }
    if (page < subReplyPageLimit) await sleep(pageDelayMs);
  }
  return { items: found, truncated: !complete, observedCount: observedIds.size };
}

export async function fetchCommentsForPost({ send, post, userId, count, pageDelayMs, timeoutMs, includeSubReplies, subReplyPageLimit }) {
  const found = [];
  const truncatedStreams = [];
  const replyCount = normalizeNonNegativeInteger(post.reply_count ?? 0, "post.reply_count");
  const maxPages = Math.max(1, Math.ceil(replyCount / count) + 2);
  let mainComplete = false;
  const observedIds = new Set();

  for (let page = 1; page <= maxPages; page += 1) {
    const url = `https://xueqiu.com/statuses/comments.json?id=${encodeURIComponent(post.id)}&page=${page}&count=${count}&type=status`;
    const data = await browserFetch(send, url, timeoutMs);
    const comments = extractArrayField(data, ["comments", "list"], "post comment stream");
    for (const comment of comments) {
      assertCommentBelongsToPost(comment, post);
      observedIds.add(normalizeId(comment.id, "comment.id"));
      if (String(getCommentUserId(comment)) === String(userId)) {
        found.push(normalizeReply(comment, post, userId));
      }
      const nestedReplyCount = includeSubReplies
        ? normalizeNonNegativeInteger(
          requiredCommentField(comment, ["reply_count", "replyCount"], "comment reply count"),
          "comment.reply_count",
        )
        : 0;
      if (includeSubReplies && nestedReplyCount > 0) {
        const commentId = normalizeId(comment.id, "comment.id");
        try {
          const nested = await fetchNestedRepliesForComment({
            send,
            post,
            commentId,
            userId,
            count,
            pageDelayMs,
            timeoutMs,
            subReplyPageLimit,
          });
          found.push(...nested.items);
          if (nested.truncated || nested.observedCount < nestedReplyCount) {
            truncatedStreams.push(`nested:${commentId}`);
          }
        } catch (error) {
          error.optionalNested = true;
          error.message = `nested replies for comment ${commentId}: ${error.message}`;
          throw error;
        }
      }
    }
    if (commentPageComplete(data, page, count, comments.length, observedIds.size)) {
      mainComplete = true;
      break;
    }
    if (page < maxPages) await sleep(pageDelayMs);
  }

  if (!mainComplete || observedIds.size < replyCount) truncatedStreams.push(`post:${post.id}`);
  return {
    items: found,
    partial: truncatedStreams.length > 0,
    truncatedStreams,
  };
}

export function timelineFingerprint(posts) {
  if (!Array.isArray(posts)) {
    throw Object.assign(new Error("Timeline must be an array before fingerprinting."), {
      code: "INVALID_JSON_SHAPE",
    });
  }
  const orderedCheckpointFields = posts.map((post, index) => ({
    id: normalizeId(post?.id, `timeline[${index}].id`),
    reply_count: normalizeNonNegativeInteger(post?.reply_count, `timeline[${index}].reply_count`),
  }));
  return createHash("sha256").update(JSON.stringify(orderedCheckpointFields)).digest("hex");
}

export function repliesFingerprint(replies) {
  if (!Array.isArray(replies)) {
    throw Object.assign(new Error("Reply corpus must be an array before fingerprinting."), {
      code: "INVALID_JSON_SHAPE",
    });
  }
  return createHash("sha256").update(JSON.stringify(replies)).digest("hex");
}

export function isValidResumeMetadata(value, expectedUserId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.hasOwn(value, "schema_version") && value.schema_version !== SCHEMA_VERSION) return false;
  if (Object.hasOwn(value, "userId") && value.userId !== expectedUserId) return false;
  for (const field of ["scannedPosts", "totalPosts", "totalReplies"]) {
    if (Object.hasOwn(value, field)
        && (!Number.isSafeInteger(value[field]) || value[field] < 0)) return false;
  }
  for (const field of ["completed", "partial"]) {
    if (Object.hasOwn(value, field) && typeof value[field] !== "boolean") return false;
  }
  for (const field of ["timelineFingerprint", "repliesFingerprint"]) {
    if (Object.hasOwn(value, field) && !/^[a-f\d]{64}$/.test(value[field])) return false;
  }
  for (const field of ["lastPostId", "lastFailedPostId"]) {
    if (Object.hasOwn(value, field)
        && value[field] !== null
        && (typeof value[field] !== "string" || !/^\d+$/.test(value[field]))) return false;
  }
  if (Object.hasOwn(value, "errors") && !Array.isArray(value.errors)) return false;
  if (Object.hasOwn(value, "truncatedStreams")
      && (!Array.isArray(value.truncatedStreams)
        || !value.truncatedStreams.every((item) => typeof item === "string"))) return false;
  return true;
}

export function resumeStartIndex(
  meta,
  timelineOrTotalPosts,
  { expectedUserId = "", replies = null } = {},
) {
  const posts = Array.isArray(timelineOrTotalPosts) ? timelineOrTotalPosts : null;
  const totalPosts = posts ? posts.length : timelineOrTotalPosts;
  if (!Number.isSafeInteger(totalPosts) || totalPosts < 0) {
    throw Object.assign(new Error("Resume requires a valid timeline or total post count."), {
      code: "INVALID_JSON_SHAPE",
    });
  }
  const scanned = meta && Object.hasOwn(meta, "scannedPosts") ? meta.scannedPosts : 0;
  if (!Number.isSafeInteger(scanned) || scanned < 0) {
    throw Object.assign(new Error("Resume metadata has an invalid scannedPosts value."), {
      code: "INVALID_JSON_SHAPE",
    });
  }
  if (expectedUserId && !isValidResumeMetadata(meta || {}, expectedUserId)) {
    throw Object.assign(new Error("Resume metadata does not match the requested user or schema."), {
      code: "INVALID_JSON_SHAPE",
    });
  }
  // The numeric overload preserves the legacy public helper contract. The utility itself
  // always supplies the timeline and therefore requires a matching ordered fingerprint.
  if (replies !== null) {
    if (!Array.isArray(replies)) {
      throw Object.assign(new Error("Resume reply corpus must be an array."), {
        code: "INVALID_JSON_SHAPE",
      });
    }
    if (scanned > 0) {
      if (!meta?.repliesFingerprint) return 0;
      if (meta.totalReplies !== replies.length
          || meta.repliesFingerprint !== repliesFingerprint(replies)) {
        throw Object.assign(
          new Error("Durable reply corpus does not match resume metadata; refusing to bless changed data."),
          { code: "RESUME_CORPUS_MISMATCH" },
        );
      }
    }
  }
  if (posts && meta?.timelineFingerprint !== timelineFingerprint(posts)) return 0;
  if (scanned > totalPosts) {
    throw Object.assign(new Error("Resume metadata has an invalid scannedPosts value."), {
      code: "INVALID_JSON_SHAPE",
    });
  }
  return scanned;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    allowed: [
      "help", "user_id", "timeline-file", "output", "max_posts", "count", "delay_ms",
      "page_delay_ms", "timeout_ms", "cdp", "include-sub-replies", "sub_reply_page_limit",
    ],
    booleans: ["help", "include-sub-replies"],
  });
  if (args.help) {
    console.log(`Usage: node scripts/xueqiu_comments_resume.mjs [options]

Legacy bounded recovery utility. Prefer xueqiu_edge_sync.mjs for recurring work.

Options:
  --timeline-file PATH      Timeline checkpoint JSON
  --output PATH             Output directory
  --max_posts N             Bound posts processed in this run
  --include-sub-replies     Attempt nested reply streams
  --timeout_ms N            Browser request timeout
  --cdp URL                 CDP endpoint
  --help                    Show this help`);
    return;
  }
  const userId = validateUserId(args.user_id, "7143769715");
  const outDir = args.output || "output/bingbing_xiaomei_comments_2026_full";
  const cdpBase = args.cdp || "http://127.0.0.1:9222";
  const count = parseIntegerOption(args.count, { name: "--count", defaultValue: 50, min: 1, max: 100 });
  const delayMs = parseIntegerOption(args.delay_ms, { name: "--delay_ms", defaultValue: 8000, min: 0 });
  const pageDelayMs = parseIntegerOption(args.page_delay_ms, { name: "--page_delay_ms", defaultValue: delayMs, min: 0 });
  const timeoutMs = parseIntegerOption(args.timeout_ms, { name: "--timeout_ms", defaultValue: 20000, min: 100 });
  const maxPosts = args.max_posts
    ? parseIntegerOption(args.max_posts, { name: "--max_posts", min: 1 })
    : Infinity;
  const includeSubReplies = Boolean(args["include-sub-replies"]);
  const subReplyPageLimit = parseIntegerOption(args.sub_reply_page_limit, { name: "--sub_reply_page_limit", defaultValue: 3, min: 1 });

  const timelineFile = args["timeline-file"] || path.join(outDir, `xueqiu_${userId}_timeline_2026_checkpoint.json`);
  const repliesFile = path.join(outDir, `xueqiu_${userId}_replies_2026.json`);
  const metaFile = path.join(outDir, `xueqiu_${userId}_replies_2026_meta.json`);
  const posts = upgradeRecoveryRecords(
    readJsonStrict(timelineFile, { defaultValue: [], validate: Array.isArray }),
    "timeline",
    userId,
  );
  const replies = upgradeRecoveryRecords(
    readJsonStrict(repliesFile, { defaultValue: [], validate: Array.isArray }),
    "reply corpus",
    userId,
  );
  const existingMeta = readJsonStrict(metaFile, {
    defaultValue: {},
    validate: (value) => isValidResumeMetadata(value, userId),
  });
  const meta = {
    ...existingMeta,
    schema_version: SCHEMA_VERSION,
    started_at: existingMeta.started_at || new Date().toISOString(),
    sinceDate: existingMeta.sinceDate || "2026-01-01",
    userId,
    errors: Array.isArray(existingMeta.errors) ? existingMeta.errors : [],
    completed: false,
    completed_at: null,
    partial: false,
    truncatedStreams: [],
    totalPosts: posts.length,
    resumed_at: new Date().toISOString(),
  };

  if (!posts.length) throw new Error(`No timeline posts found at ${timelineFile}`);

  const seenReplyIds = new Set(replies.map((reply) => String(reply.id)));
  const currentTimelineFingerprint = timelineFingerprint(posts);
  const storedTimelineFingerprint = meta.timelineFingerprint;
  const startIndex = resumeStartIndex(meta, posts, { expectedUserId: userId, replies });
  if (startIndex === 0 && Number.isSafeInteger(meta.scannedPosts) && meta.scannedPosts > 0) {
    const hadProgress = Number.isSafeInteger(meta.scannedPosts) && meta.scannedPosts > 0;
    meta.scannedPosts = 0;
    delete meta.lastPostId;
    delete meta.lastFailedPostId;
    if (hadProgress) {
      meta.resume_reset_at = new Date().toISOString();
      meta.resume_reset_reason = storedTimelineFingerprint !== currentTimelineFingerprint
        ? "timeline_changed"
        : "reply_corpus_mismatch";
    }
  }
  meta.timelineFingerprint = currentTimelineFingerprint;
  meta.repliesFingerprint = repliesFingerprint(replies);
  const session = new CdpSession(cdpBase, { commandTimeoutMs: timeoutMs + 3000 });

  try {
    await session.connect();
    const send = session.send.bind(session);
    let processedThisRun = 0;
    for (let index = startIndex; index < posts.length && processedThisRun < maxPosts; index += 1) {
      const post = posts[index];
      processedThisRun += 1;
      const label = `[${index + 1}/${posts.length}] ${post.id} replies=${post.reply_count || 0}`;
      console.log(label);

      try {
        const requestedComments = Boolean(post.reply_count);
        if (requestedComments) {
          const result = await fetchCommentsForPost({
            send,
            post,
            userId,
            count,
            pageDelayMs,
            timeoutMs,
            includeSubReplies,
            subReplyPageLimit,
          });
          let added = 0;
          for (const reply of result.items) {
            const key = String(reply.id);
            if (seenReplyIds.has(key)) continue;
            seenReplyIds.add(key);
            replies.push(reply);
            added += 1;
          }
          console.log(`  found=${result.items.length} added=${added} total=${replies.length}`);
          if (result.partial) {
            meta.partial = true;
            meta.truncatedStreams = result.truncatedStreams;
            throw Object.assign(
              new Error(`page limit reached before stream completion: ${result.truncatedStreams.join(", ")}`),
              { code: "PARTIAL_PAGE_LIMIT", partial: true },
            );
          }
        } else {
          console.log("  skip: no replies");
        }

        meta.scannedPosts = index + 1;
        meta.lastPostId = post.id;
        meta.totalReplies = replies.length;
        meta.updated_at = new Date().toISOString();
        writeOutputs({ outDir, userId, replies, meta });
        if (requestedComments) await sleep(delayMs);
      } catch (error) {
        meta.errors = meta.errors || [];
        meta.errors.push({
          post_id: post.id,
          index: index + 1,
          error: error.message,
          status: error.status || null,
          at: new Date().toISOString(),
        });
        meta.scannedPosts = index;
        meta.lastFailedPostId = post.id;
        meta.totalReplies = replies.length;
        meta.updated_at = new Date().toISOString();
        writeOutputs({ outDir, userId, replies, meta });
        console.error(`STOP at ${label}: ${error.message}`);
        process.exitCode = error.status === 405 || error.optionalNested || error.partial ? 2 : 1;
        return;
      }
    }

    if (meta.scannedPosts >= posts.length) {
      meta.completed = true;
      meta.completed_at = new Date().toISOString();
    } else {
      process.exitCode = 2;
    }
    meta.totalReplies = replies.length;
    meta.updated_at = new Date().toISOString();
    writeOutputs({ outDir, userId, replies, meta });
    console.log(`done scanned=${meta.scannedPosts}/${posts.length} replies=${replies.length} completed=${meta.completed}`);
  } finally {
    session.close();
  }
}

const scriptFile = fileURLToPath(import.meta.url);
if (path.resolve(process.argv[1] || "") === scriptFile) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
