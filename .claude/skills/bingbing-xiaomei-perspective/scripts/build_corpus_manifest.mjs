#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
export const skillDir = path.resolve(path.dirname(scriptFile), "..");
const projectDir = path.resolve(skillDir, "../../..");
export const manifestFile = path.join(skillDir, "references", "sources", "corpus-manifest.json");

export const CORPUS_SCHEMA_VERSION = 1;
export const SEGMENT_DESCRIPTOR_FIELDS = Object.freeze([
  "path",
  "origin",
  "kind",
  "stage",
  "contract",
  "from",
  "through",
]);
export const ARCHIVE_DESCRIPTOR_FIELDS = Object.freeze([
  "path",
  "kind",
  "contract",
  "disposition",
  "reason",
  "counted_in_claims",
]);

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const MIN_RECORD_EPOCH_MS = Date.UTC(2000, 0, 1);
const SHANGHAI_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;
const AWARE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const ID_FIELD = /^(?:id|reply_to|.*_id)$/;
const COUNT_FIELD = /_count$/;
const CREATED_AT_FIELD = /^(?:created_at|.*_created_at)$/;
const LEGACY_UNKNOWN_FLAG_FIELD = /^(?:created_at|.*_created_at)_is_unknown$/;
const URL_FIELD = /^(?:target|.*_(?:target|link|url))$/;
const STRICT_CONTRACT = "normalized_v1";
const LEGACY_CONTRACT = "legacy_normalized_v1";
const LEGACY_NO_VIEW_CONTRACT = "normalized_without_view_count_v1";
const FRAMEWORK_LINK_CONTRACT = "framework_index_link_v1";
const FRAMEWORK_SOURCE_CONTRACT = "framework_index_source_v1";
const SUPPORTED_RECORD_CONTRACTS = new Set([
  STRICT_CONTRACT,
  LEGACY_CONTRACT,
  LEGACY_NO_VIEW_CONTRACT,
  FRAMEWORK_LINK_CONTRACT,
  FRAMEWORK_SOURCE_CONTRACT,
]);
const ALLOWED_RECORD_FIELDS = new Set([
  "schema_version", "record_contract", "id", "created_at_raw", "created_at",
  "target", "post_id", "post_target", "post_link", "reply_to",
  "in_reply_to_comment_id", "status_id", "user_id", "text", "clean_text",
  "reply_count", "like_count", "retweet_count", "view_count",
  "post_reply_count", "title", "source", "origin", "mode", "post_title",
  "post_text", "post_excerpt", "created_ms", "fetched_from_page",
  "post_created_at_raw", "post_created_at", "legacy_migrated_fields",
]);
const STRING_RECORD_FIELDS = new Set([
  "text", "clean_text", "title", "source", "origin", "mode",
  "post_title", "post_text", "post_excerpt",
]);
const SUBJECT_USER_ID = "7143769715";
const DECLARED_EXTERNAL_FRAMEWORK_OWNERS = new Map([
  ["308254026", "5003404268"],
]);
const FRAMEWORK_INDEX_SOURCE = Object.freeze({
  id: "311912942",
  owner: "6895445760",
  path: "references/research/08-framework-index-2026-05-12.json",
});
const LEGACY_EMPTY_TIMELINE_IDS = new Set([
  "395168273", "390292430", "389501654", "387719751", "386459981", "385427621",
  "385335475", "383535714", "383519932", "383319078", "383316643", "370243982",
]);

const generatedSegments = Object.freeze([
  {
    path: "references/sources/xueqiu/2026-timeline-2026-06-30.json",
    origin: "output/bingbing_xiaomei_2026_06_30_incremental/xueqiu_7143769715_posts.json",
    kind: "timeline",
    stage: "incremental",
    contract: LEGACY_NO_VIEW_CONTRACT,
    from: "2026-06-30",
    through: "2026-06-30",
  },
  {
    path: "references/sources/xueqiu/2026-timeline-2026-07-01-to-2026-07-11.json",
    origin: "output/bingbing_xiaomei_sync_browser/xueqiu_7143769715_posts.json",
    kind: "timeline",
    stage: "incremental",
    from: "2026-07-01",
    through: "2026-07-11",
  },
  {
    path: "references/sources/xueqiu/2026-timeline-2026-07-12-to-2026-07-14.json",
    origin: "output/bingbing_xiaomei_sync_browser/xueqiu_7143769715_posts.json",
    kind: "timeline",
    stage: "incremental",
    from: "2026-07-12",
    through: "2026-07-14",
  },
  {
    path: "references/sources/xueqiu/2026-self-replies-2026-06-21-to-2026-06-30.json",
    origin: "output/bingbing_xiaomei_2026_06_21_to_2026_07_01_self_replies/xueqiu_7143769715_self_replies.json",
    kind: "replies",
    stage: "incremental",
    from: "2026-06-21",
    through: "2026-06-30",
  },
  {
    path: "references/sources/xueqiu/2026-self-replies-2026-07-01-to-2026-07-11.json",
    origin: "output/bingbing_xiaomei_sync_browser_comments/xueqiu_7143769715_replies_2026.json",
    kind: "replies",
    stage: "incremental",
    from: "2026-07-01",
    through: "2026-07-11",
  },
  {
    path: "references/sources/xueqiu/2026-self-replies-2026-07-12-to-2026-07-14.json",
    origin: "output/bingbing_xiaomei_sync_browser_comments/xueqiu_7143769715_replies_2026.json",
    kind: "replies",
    stage: "incremental",
    from: "2026-07-12",
    through: "2026-07-14",
  },
].map((segment) => Object.freeze(segment)));

export const declaredSegments = Object.freeze([
  {
    path: "references/sources/xueqiu/2026-timeline-through-2026-06-20.json",
    origin: "output/bingbing_xiaomei_comments_2026_full/xueqiu_7143769715_timeline_2026_checkpoint.json",
    kind: "timeline",
    stage: "baseline",
    contract: LEGACY_CONTRACT,
    from: "2026-01-01",
    through: "2026-06-20",
  },
  {
    path: "references/sources/xueqiu/2026-timeline-incremental-2026-06-21-to-2026-06-29.json",
    origin: "output/bingbing_xiaomei_2026_06_29_posts_full/xueqiu_7143769715_posts.json",
    kind: "timeline",
    stage: "incremental",
    contract: LEGACY_NO_VIEW_CONTRACT,
    from: "2026-06-21",
    through: "2026-06-29",
  },
  ...generatedSegments,
  {
    path: "references/sources/xueqiu/2026-self-replies-through-2026-06-20.json",
    origin: "output/bingbing_xiaomei_comments_2026_full/xueqiu_7143769715_replies_2026.json",
    kind: "replies",
    stage: "baseline",
    contract: LEGACY_CONTRACT,
    from: "2026-01-01",
    through: "2026-06-20",
  },
  {
    path: "references/research/07-full-columns-2026-05-12.json",
    origin: "output/bingbing_xiaomei_full/xueqiu_7143769715_articles.json",
    kind: "articles",
    stage: "baseline",
  },
  {
    path: "references/research/11-incremental-full-articles-2026-06-10.json",
    origin: "output/bingbing_xiaomei_2026_06_10_full_articles/xueqiu_7143769715_ids.json",
    kind: "articles",
    stage: "incremental",
  },
  {
    path: "references/research/14-incremental-full-articles-2026-06-16.json",
    origin: "output/bingbing_xiaomei_2026_06_16_full_articles/xueqiu_7143769715_ids.json",
    kind: "articles",
    stage: "incremental",
  },
  {
    path: FRAMEWORK_INDEX_SOURCE.path,
    origin: "https://xueqiu.com/6895445760/311912942",
    kind: "framework_index",
    stage: "baseline",
    contract: FRAMEWORK_SOURCE_CONTRACT,
  },
  {
    path: "references/research/10-framework-linked-posts-2026-05-13.json",
    origin: "output/bingbing_xiaomei_framework_links/xueqiu_7143769715_ids.json",
    kind: "framework_links",
    stage: "baseline",
    contract: FRAMEWORK_LINK_CONTRACT,
  },
].map((segment) => Object.freeze({ ...segment })));

const ARCHIVE_REASON = "Historical acquisition snapshot retained for cited research notes; every ID is represented by a declared canonical segment, so this snapshot is excluded from aggregate claims.";
export const archivedRecordArrays = Object.freeze([
  {
    path: "references/research/12-incremental-timeline-posts-2026-06-10.json",
    kind: "timeline",
    contract: STRICT_CONTRACT,
    disposition: "superseded_snapshot",
    reason: ARCHIVE_REASON,
    counted_in_claims: false,
  },
  {
    path: "references/research/15-incremental-timeline-posts-2026-06-16.json",
    kind: "timeline",
    contract: STRICT_CONTRACT,
    disposition: "superseded_snapshot",
    reason: ARCHIVE_REASON,
    counted_in_claims: false,
  },
  {
    path: "references/research/17-incremental-articles-2026-06-17.json",
    kind: "articles",
    contract: STRICT_CONTRACT,
    disposition: "superseded_snapshot",
    reason: ARCHIVE_REASON,
    counted_in_claims: false,
  },
  {
    path: "references/research/18-incremental-timeline-posts-2026-06-17.json",
    kind: "timeline",
    contract: STRICT_CONTRACT,
    disposition: "superseded_snapshot",
    reason: ARCHIVE_REASON,
    counted_in_claims: false,
  },
].map((descriptor) => Object.freeze({ ...descriptor })));

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function asciiTrim(value) {
  return String(value).replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse corpus source ${file}: ${error.message}`, { cause: error });
  }
}

function readArray(file) {
  const value = readJson(file);
  if (!Array.isArray(value)) throw new Error(`Corpus source must be an array: ${file}`);
  return value;
}

export function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, value, "utf8");
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

function toEpochMs(value, label) {
  if (typeof value === "number") {
    const epoch = value >= 1e12 ? value : value * 1000;
    if (Number.isFinite(epoch) && epoch >= MIN_RECORD_EPOCH_MS) return epoch;
    throw new Error(`${label} must be a valid timestamp`);
  }

  const text = asciiTrim(value ?? "");
  if (/^\d+(?:\.\d+)?$/.test(text)) return toEpochMs(Number(text), label);

  const naive = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(text);
  if (naive) {
    const [, year, month, day, hour, minute, second] = naive;
    const epoch = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ) - SHANGHAI_OFFSET_MS;
    const expected = `${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`;
    if (formatShanghaiEpoch(epoch) !== expected) throw new Error(`${label} is not a valid calendar time`);
    if (epoch < MIN_RECORD_EPOCH_MS) throw new Error(`${label} predates the supported record epoch`);
    return epoch;
  }

  if (!AWARE_TIMESTAMP.test(text)) {
    throw new Error(`${label} must include an explicit time of day`);
  }
  const epoch = Date.parse(text);
  if (Number.isNaN(epoch) || epoch < MIN_RECORD_EPOCH_MS) {
    throw new Error(`${label} must be a valid timestamp from 2000 onward`);
  }
  return epoch;
}

function formatShanghaiEpoch(epoch) {
  return `${new Date(epoch + SHANGHAI_OFFSET_MS).toISOString().slice(0, 19)}+08:00`;
}

export function formatShanghaiTime(value, label = "created_at") {
  return formatShanghaiEpoch(toEpochMs(value, label));
}

function normalizeId(value, label, { required = false } = {}) {
  if (value === null && !required) return null;
  const normalized = typeof value === "string" ? asciiTrim(value) : String(value ?? "");
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a digit-only string ID`);
  return normalized;
}

function normalizeCount(value, label) {
  const text = typeof value === "string" ? asciiTrim(value) : null;
  const normalized = typeof value === "number"
    ? value
    : text !== null && /^\d+$/.test(text)
      ? Number(text)
      : Number.NaN;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return normalized;
}

function normalizeUrl(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty URL`);
  const trimmed = value.trim();
  try {
    if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) && !/^https?:/i.test(trimmed)) {
      throw new Error("unsupported protocol");
    }
    const candidate = trimmed.startsWith("//")
      ? new URL(`https:${trimmed}`)
      : /^https?:\/\//i.test(trimmed)
        ? new URL(trimmed)
        : new URL(trimmed.startsWith("/") ? trimmed : `/${trimmed}`, "https://xueqiu.com");
    const hostname = candidate.hostname.toLowerCase();
    if (hostname !== "xueqiu.com" && !hostname.endsWith(".xueqiu.com")) {
      throw new Error("external host");
    }
    if (candidate.username || candidate.password || (candidate.port && candidate.port !== "443")) {
      throw new Error("credentials or non-canonical port");
    }
    candidate.protocol = "https:";
    candidate.port = "";
    return candidate.href;
  } catch (error) {
    throw new Error(`${label} must be a canonical Xueqiu HTTPS URL`, { cause: error });
  }
}

function isExplicitUnknownTime(value) {
  return value === null
    || value === 0
    || (typeof value === "string" && ["", "unknown", "未知时间"].includes(value.trim().toLowerCase() === "unknown" ? "unknown" : value.trim()));
}

function cleanHtml(value) {
  return asciiTrim(String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n"));
}

function normalizeObject(value, label, { topLevel = false } = {}) {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain object`);
  const normalized = {};
  if (topLevel) normalized.schema_version = CORPUS_SCHEMA_VERSION;

  for (const [key, item] of Object.entries(value)) {
    if (topLevel && key === "schema_version") continue;
    if (topLevel && key === "retweeted_status") continue;
    if (CREATED_AT_FIELD.test(key) && key !== "created_at_raw") {
      const rawKey = `${key}_raw`;
      const rawValue = hasOwn(value, rawKey) ? value[rawKey] : item;
      normalized[rawKey] = rawValue;
      if (isExplicitUnknownTime(rawValue)) {
        normalized[key] = "unknown";
      } else {
        normalized[key] = formatShanghaiTime(rawValue, `${label}.${rawKey}`);
      }
      continue;
    }
    if (LEGACY_UNKNOWN_FLAG_FIELD.test(key)) continue;
    if (key.endsWith("_created_at_raw") || key === "created_at_raw") {
      if (hasOwn(value, key.slice(0, -4))) continue;
      normalized[key] = item;
      continue;
    }
    if (ID_FIELD.test(key)) {
      normalized[key] = normalizeId(item, `${label}.${key}`, { required: topLevel && key === "id" });
      continue;
    }
    if (COUNT_FIELD.test(key)) {
      normalized[key] = normalizeCount(item, `${label}.${key}`);
      continue;
    }
    if (URL_FIELD.test(key)) {
      normalized[key] = normalizeUrl(item, `${label}.${key}`);
      continue;
    }
    if (Array.isArray(item)) {
      normalized[key] = item.map((entry, index) => (
        isPlainObject(entry) ? normalizeObject(entry, `${label}.${key}[${index}]`) : entry
      ));
      continue;
    }
    normalized[key] = isPlainObject(item) ? normalizeObject(item, `${label}.${key}`) : item;
  }
  return normalized;
}

export function normalizeCorpusRecord(record, label = "record", { contract = STRICT_CONTRACT } = {}) {
  if (!SUPPORTED_RECORD_CONTRACTS.has(contract)) {
    throw new Error(`${label}.record_contract is unsupported: ${contract}`);
  }
  if (isPlainObject(record)
      && hasOwn(record, "record_contract")
      && record.record_contract !== contract) {
    throw new Error(
      `${label}.record_contract=${JSON.stringify(record.record_contract)}; expected ${contract}`,
    );
  }
  const normalized = normalizeObject(record, label, { topLevel: true });
  normalized.record_contract = contract;
  if (contract !== LEGACY_CONTRACT && typeof normalized.text === "string") {
    normalized.clean_text = cleanHtml(normalized.text);
  }
  validateCorpusRecord(normalized, label);
  return normalized;
}

function validateObjectFields(value, label) {
  for (const [key, item] of Object.entries(value)) {
    if (ID_FIELD.test(key)) {
      if (item !== null && (typeof item !== "string" || !/^\d+$/.test(item))) {
        throw new Error(`${label}.${key} must be null or a digit-only string ID`);
      }
    }
    if (COUNT_FIELD.test(key) && (!Number.isSafeInteger(item) || item < 0)) {
      throw new Error(`${label}.${key} must be a non-negative integer`);
    }
    if (CREATED_AT_FIELD.test(key) && key !== "created_at_raw") {
      const rawKey = `${key}_raw`;
      if (!hasOwn(value, rawKey)) throw new Error(`${label}.${rawKey} must preserve the acquisition value`);
      if (isExplicitUnknownTime(value[rawKey])) {
        if (item !== "unknown") {
          throw new Error(`${label}.${key} must remain "unknown" when ${rawKey} is explicitly unknown`);
        }
        continue;
      }
      if (item === "unknown") {
        throw new Error(`${label}.${key} may only be "unknown" when ${rawKey} is "unknown"`);
      }
      if (typeof item !== "string" || !SHANGHAI_TIMESTAMP.test(item)) {
        throw new Error(`${label}.${key} must be an Asia/Shanghai timestamp with +08:00`);
      }
      let canonical;
      try {
        canonical = formatShanghaiTime(item, `${label}.${key}`);
      } catch (error) {
        throw new Error(`${label}.${key} must be a valid Asia/Shanghai timestamp`, { cause: error });
      }
      if (canonical !== item) throw new Error(`${label}.${key} must use canonical Asia/Shanghai format`);
      let normalizedRaw;
      try {
        normalizedRaw = formatShanghaiTime(value[rawKey], `${label}.${rawKey}`);
      } catch (error) {
        throw new Error(`${label}.${rawKey} must remain a valid acquisition timestamp`, { cause: error });
      }
      if (normalizedRaw !== item) {
        throw new Error(`${label}.${key} must represent the preserved ${rawKey} value`);
      }
    }
    if (URL_FIELD.test(key)) {
      if (typeof item !== "string" || normalizeUrl(item, `${label}.${key}`) !== item) {
        throw new Error(`${label}.${key} must be an absolute canonical URL`);
      }
    }
    if (Array.isArray(item)) {
      for (const [index, entry] of item.entries()) {
        if (isPlainObject(entry)) validateObjectFields(entry, `${label}.${key}[${index}]`);
      }
    } else if (isPlainObject(item)) {
      validateObjectFields(item, `${label}.${key}`);
    }
  }
}

export function validateCorpusRecord(record, label = "record") {
  if (!isPlainObject(record)) throw new Error(`${label} must be a plain object`);
  for (const field of Object.keys(record)) {
    if (!ALLOWED_RECORD_FIELDS.has(field)) {
      throw new Error(`${label}.${field} is not allowed in the normalized corpus layer`);
    }
  }
  if (record.schema_version !== CORPUS_SCHEMA_VERSION) {
    throw new Error(`${label}.schema_version must equal ${CORPUS_SCHEMA_VERSION}`);
  }
  if (!SUPPORTED_RECORD_CONTRACTS.has(record.record_contract)) {
    throw new Error(`${label}.record_contract must declare a supported record contract`);
  }
  if (typeof record.id !== "string" || !/^\d+$/.test(record.id)) {
    throw new Error(`${label}.id must be a digit-only string ID`);
  }
  if (!hasOwn(record, "created_at_raw")) {
    throw new Error(`${label}.created_at_raw must preserve the acquisition value`);
  }
  if (!hasOwn(record, "created_at")) throw new Error(`${label}.created_at is required`);
  for (const field of STRING_RECORD_FIELDS) {
    if (hasOwn(record, field) && typeof record[field] !== "string") {
      throw new Error(`${label}.${field} must be a string`);
    }
  }
  if (hasOwn(record, "text")
      && hasOwn(record, "clean_text")
      && record.clean_text !== cleanHtml(record.text)) {
    throw new Error(`${label}.clean_text must match the deterministic text normalizer`);
  }
  if (hasOwn(record, "user_id")
      && (typeof record.user_id !== "string" || !/^\d+$/.test(record.user_id))) {
    throw new Error(`${label}.user_id must be a digit-only string ID`);
  }
  for (const [field, minimum] of [["created_ms", 0], ["fetched_from_page", 1]]) {
    if (hasOwn(record, field)
        && (!Number.isSafeInteger(record[field]) || record[field] < minimum)) {
      throw new Error(`${label}.${field} must be a safe integer >= ${minimum}`);
    }
  }
  if (hasOwn(record, "legacy_migrated_fields")) {
    const fields = record.legacy_migrated_fields;
    if (!Array.isArray(fields)
        || fields.some((field) => typeof field !== "string" || !field)
        || new Set(fields).size !== fields.length) {
      throw new Error(`${label}.legacy_migrated_fields must contain unique non-empty strings`);
    }
  }
  const hasPostRaw = hasOwn(record, "post_created_at_raw");
  const hasPostNormalized = hasOwn(record, "post_created_at");
  if (hasPostRaw !== hasPostNormalized) {
    throw new Error(`${label}.post_created_at_raw and post_created_at must be preserved together`);
  }
  if (!Object.keys(record).some((key) => URL_FIELD.test(key))) {
    throw new Error(`${label} must include a canonical Xueqiu URL`);
  }
  validateObjectFields(record, label);
  return record;
}

function isNonEmptyText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function requireCount(record, field, label) {
  if (!Number.isSafeInteger(record[field]) || record[field] < 0) {
    throw new Error(`${label}.${field} must be a non-negative integer required by its segment contract`);
  }
}

function requireId(record, field, label) {
  if (typeof record[field] !== "string" || !/^\d+$/.test(record[field])) {
    throw new Error(`${label}.${field} must be a digit-only string required by its segment contract`);
  }
}

function assertSubjectUrl(value, id, label) {
  const url = new URL(normalizeUrl(value, label));
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || segments[0] !== SUBJECT_USER_ID || segments[1] !== id) {
    throw new Error(`${label} must identify subject ${SUBJECT_USER_ID} and related ID ${id}`);
  }
}

function assertFrameworkLinkUrl(value, id, label) {
  const url = new URL(normalizeUrl(value, label));
  const segments = url.pathname.split("/").filter(Boolean);
  const expectedOwner = DECLARED_EXTERNAL_FRAMEWORK_OWNERS.get(id) || SUBJECT_USER_ID;
  if (segments.length !== 2 || segments[0] !== expectedOwner || segments[1] !== id) {
    throw new Error(`${label} must identify declared framework owner ${expectedOwner} and related ID ${id}`);
  }
}

function assertFrameworkSourceUrl(value, id, label) {
  const url = new URL(normalizeUrl(value, label));
  const segments = url.pathname.split("/").filter(Boolean);
  if (id !== FRAMEWORK_INDEX_SOURCE.id
      || segments.length !== 2
      || segments[0] !== FRAMEWORK_INDEX_SOURCE.owner
      || segments[1] !== id) {
    throw new Error(
      `${label} must identify declared framework index source ${FRAMEWORK_INDEX_SOURCE.owner}/${FRAMEWORK_INDEX_SOURCE.id}`,
    );
  }
}

function validateKindContract(record, descriptor, label) {
  const contract = descriptor.contract || STRICT_CONTRACT;
  if (!SUPPORTED_RECORD_CONTRACTS.has(contract)) {
    throw new Error(`${descriptor.path}: unsupported record contract ${contract}`);
  }
  if (record.record_contract !== contract) {
    throw new Error(`${label}.record_contract=${JSON.stringify(record.record_contract)}; expected ${contract}`);
  }
  const legacy = contract === LEGACY_CONTRACT;
  const contentPresent = [record.title, record.text, record.clean_text].some(isNonEmptyText);

  if (["timeline", "articles", "framework_links", "framework_index"].includes(descriptor.kind)) {
    for (const field of ["post_id", "post_target", "post_link"]) {
      if (hasOwn(record, field)) throw new Error(`${label}.${field} is not valid for a post record`);
    }
    if (!contentPresent
        && (!legacy
          || descriptor.path !== "references/sources/xueqiu/2026-timeline-through-2026-06-20.json"
          || !LEGACY_EMPTY_TIMELINE_IDS.has(record.id))) {
      throw new Error(`${label} must contain title, text, or clean_text under the strict segment contract`);
    }
    for (const field of ["reply_count", "like_count", "retweet_count"]) requireCount(record, field, label);
    if (contract !== LEGACY_NO_VIEW_CONTRACT) requireCount(record, "view_count", label);
    if (!legacy) {
      if (typeof record.text !== "string" || typeof record.clean_text !== "string") {
        throw new Error(`${label} must contain text and clean_text under ${contract}`);
      }
      if (record.clean_text !== cleanHtml(record.text)) {
        throw new Error(`${label}.clean_text must match the ${contract} normalizer`);
      }
    }
    if (!isNonEmptyText(record.target)) throw new Error(`${label}.target is required by its segment contract`);
    if (descriptor.kind === "framework_links") {
      if (contract !== FRAMEWORK_LINK_CONTRACT) {
        throw new Error(`${descriptor.path}: framework links require ${FRAMEWORK_LINK_CONTRACT}`);
      }
      assertFrameworkLinkUrl(record.target, record.id, `${label}.target`);
    } else if (descriptor.kind === "framework_index") {
      if (contract !== FRAMEWORK_SOURCE_CONTRACT) {
        throw new Error(`${descriptor.path}: framework index requires ${FRAMEWORK_SOURCE_CONTRACT}`);
      }
      assertFrameworkSourceUrl(record.target, record.id, `${label}.target`);
    } else {
      assertSubjectUrl(record.target, record.id, `${label}.target`);
    }
    return;
  }

  if (descriptor.kind === "replies") {
    if (hasOwn(record, "target")) throw new Error(`${label}.target is not valid for a reply record`);
    if (![record.text, record.clean_text].some(isNonEmptyText)) {
      throw new Error(`${label} must contain text or clean_text under its segment contract`);
    }
    requireCount(record, "like_count", label);
    if (!legacy) requireCount(record, "reply_count", label);
    if (!legacy) {
      if (typeof record.text !== "string" || typeof record.clean_text !== "string") {
        throw new Error(`${label} must contain text and clean_text under ${contract}`);
      }
      if (record.clean_text !== cleanHtml(record.text)) {
        throw new Error(`${label}.clean_text must match the ${contract} normalizer`);
      }
    }
    requireId(record, "post_id", label);
    if (record.status_id !== undefined
        && record.status_id !== null
        && record.status_id !== record.post_id) {
      throw new Error(`${label}.status_id must identify post_id`);
    }
    const postUrl = record.post_target || (legacy ? record.post_link : null);
    if (!isNonEmptyText(postUrl)) {
      throw new Error(`${label}.post_target is required by its segment contract`);
    }
    assertSubjectUrl(postUrl, record.post_id, `${label}.${record.post_target ? "post_target" : "post_link"}`);
    if (record.post_target && record.post_link
        && normalizeUrl(record.post_target, `${label}.post_target`)
          !== normalizeUrl(record.post_link, `${label}.post_link`)) {
      throw new Error(`${label} has conflicting post_target and post_link values`);
    }
    return;
  }

  throw new Error(`${descriptor.path}: unsupported corpus kind ${descriptor.kind}`);
}

function datePart(item) {
  if (item?.created_at === "unknown") return "";
  return String(item?.created_at || "").slice(0, 10);
}

function within(item, from, through) {
  const value = datePart(item);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= from && value <= through;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function descriptorFor(segment) {
  const descriptor = {};
  for (const field of SEGMENT_DESCRIPTOR_FIELDS) {
    if (hasOwn(segment, field)) descriptor[field] = segment[field];
  }
  return descriptor;
}

function archiveDescriptorFor(archive) {
  const descriptor = {};
  for (const field of ARCHIVE_DESCRIPTOR_FIELDS) {
    if (hasOwn(archive, field)) descriptor[field] = archive[field];
  }
  return descriptor;
}

function segmentFile(baseDir, segmentPath) {
  const base = path.resolve(baseDir);
  const absolute = path.resolve(base, segmentPath);
  if (absolute !== base && !absolute.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Corpus segment escapes its base directory: ${segmentPath}`);
  }
  if (fs.existsSync(absolute)) {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Corpus segment must be a regular file: ${segmentPath}`);
    }
    const realBase = fs.realpathSync(base);
    const realAbsolute = fs.realpathSync(absolute);
    if (!realAbsolute.startsWith(`${realBase}${path.sep}`)) {
      throw new Error(`Corpus segment resolves outside its base directory: ${segmentPath}`);
    }
  }
  return absolute;
}

function referenceJsonFiles(baseDir) {
  const resolvedBase = path.resolve(baseDir);
  const referencesRoot = path.resolve(resolvedBase, "references");
  const referenceStat = fs.lstatSync(referencesRoot);
  if (!referenceStat.isDirectory() || referenceStat.isSymbolicLink()) {
    throw new Error("Corpus references root must be a directory");
  }
  const realBase = fs.realpathSync(resolvedBase);
  const realReferences = fs.realpathSync(referencesRoot);
  if (!realReferences.startsWith(`${realBase}${path.sep}`)) {
    throw new Error("Corpus references root resolves outside its base directory");
  }
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Corpus reference inventory cannot contain symlinks: ${absolute}`);
      }
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(absolute);
      }
    }
  };
  visit(referencesRoot);
  return files.sort();
}

export function validateRecordArrayInventory({ baseDir = skillDir } = {}) {
  const expected = new Set([
    ...declaredSegments.map((segment) => segment.path),
    ...archivedRecordArrays.map((archive) => archive.path),
  ]);
  const discovered = new Set();
  for (const file of referenceJsonFiles(baseDir)) {
    const value = readJson(file);
    if (!Array.isArray(value)) continue;
    const relative = path.relative(path.resolve(baseDir), file).split(path.sep).join("/");
    discovered.add(relative);
  }
  const missing = [...expected].filter((item) => !discovered.has(item)).sort();
  const undeclared = [...discovered].filter((item) => !expected.has(item)).sort();
  if (missing.length || undeclared.length) {
    throw new Error(
      `Record-array inventory mismatch; missing=[${missing.join(", ")}], undeclared=[${undeclared.join(", ")}]`,
    );
  }
  return [...discovered].sort();
}

export function metadataFor(segment, { baseDir = skillDir } = {}) {
  const descriptor = descriptorFor(segment);
  const absolute = segmentFile(baseDir, descriptor.path);
  const records = readArray(absolute);
  if (records.length === 0) throw new Error(`Corpus source must not be empty: ${descriptor.path}`);
  const ids = [];
  const dates = [];
  for (const [index, item] of records.entries()) {
    validateCorpusRecord(item, `${descriptor.path}[${index}]`);
    validateKindContract(item, descriptor, `${descriptor.path}[${index}]`);
    ids.push(item.id);
    const date = datePart(item);
    if (date) dates.push(date);
    if (descriptor.from && !within(item, descriptor.from, descriptor.through)) {
      throw new Error(`${descriptor.path}[${index}].created_at falls outside declared range`);
    }
  }
  if (descriptor.path === "references/sources/xueqiu/2026-timeline-through-2026-06-20.json") {
    const actualMissing = records
      .filter((item) => ![item.title, item.text, item.clean_text].some(isNonEmptyText))
      .map((item) => item.id)
      .sort();
    const expectedMissing = [...LEGACY_EMPTY_TIMELINE_IDS].sort();
    if (JSON.stringify(actualMissing) !== JSON.stringify(expectedMissing)) {
      throw new Error(`${descriptor.path} must retain exactly the 12 declared missing-content legacy records`);
    }
  }
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate IDs inside ${descriptor.path}`);
  dates.sort();
  return {
    ...descriptor,
    records: records.length,
    unique_ids: new Set(ids).size,
    min_date: dates[0] || null,
    max_date: dates.at(-1) || null,
    sha256: sha256(absolute),
  };
}

export function metadataForArchive(archive, canonicalIds, { baseDir = skillDir } = {}) {
  const descriptor = archiveDescriptorFor(archive);
  const absolute = segmentFile(baseDir, descriptor.path);
  const records = readArray(absolute);
  if (records.length === 0) throw new Error(`Archived record array must not be empty: ${descriptor.path}`);
  const ids = [];
  for (const [index, item] of records.entries()) {
    validateCorpusRecord(item, `${descriptor.path}[${index}]`);
    validateKindContract(item, descriptor, `${descriptor.path}[${index}]`);
    ids.push(item.id);
  }
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate IDs inside ${descriptor.path}`);
  const missingCanonical = ids.filter((id) => !canonicalIds.has(id));
  if (missingCanonical.length) {
    throw new Error(
      `${descriptor.path} contains IDs absent from declared canonical segments: ${missingCanonical.join(", ")}`,
    );
  }
  if (descriptor.counted_in_claims !== false || descriptor.disposition !== "superseded_snapshot") {
    throw new Error(`${descriptor.path} must remain an explicitly excluded superseded snapshot`);
  }
  return {
    ...descriptor,
    records: records.length,
    unique_ids: new Set(ids).size,
    overlap_with_declared_corpus: missingCanonical.length === 0 ? ids.length : 0,
    sha256: sha256(absolute),
  };
}

function groupRecords(segments, kind, baseDir) {
  return segments
    .filter((segment) => segment.kind === kind)
    .flatMap((segment) => readArray(segmentFile(baseDir, segment.path)));
}

function assertUniqueAcross(records, label) {
  const ids = records.map((item) => item?.id).filter(Boolean);
  if (ids.length !== records.length) throw new Error(`${label} contains records without IDs`);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} contains ${ids.length - new Set(ids).size} duplicate IDs across segments`);
  }
}

function assertExactSegmentDescriptors(loadedSegments) {
  if (!Array.isArray(loadedSegments)) throw new Error("Manifest segments must be an array");
  if (loadedSegments.length !== declaredSegments.length) {
    throw new Error(
      `Manifest segment descriptor set has ${loadedSegments.length} entries; expected ${declaredSegments.length}`,
    );
  }

  const loadedByPath = new Map();
  for (const segment of loadedSegments) {
    if (!isPlainObject(segment) || typeof segment.path !== "string") {
      throw new Error("Every manifest segment must have a string path descriptor");
    }
    if (loadedByPath.has(segment.path)) throw new Error(`Duplicate manifest segment path: ${segment.path}`);
    loadedByPath.set(segment.path, segment);
  }

  for (const expected of declaredSegments) {
    const actual = loadedByPath.get(expected.path);
    if (!actual) throw new Error(`Manifest is missing declared segment descriptor: ${expected.path}`);
    for (const field of SEGMENT_DESCRIPTOR_FIELDS) {
      const expectedHas = hasOwn(expected, field);
      const actualHas = hasOwn(actual, field);
      if (expectedHas !== actualHas || (expectedHas && actual[field] !== expected[field])) {
        throw new Error(
          `${expected.path}: descriptor ${field}=${JSON.stringify(actual[field])}; expected ${JSON.stringify(expected[field])}`,
        );
      }
    }
  }

  for (const actual of loadedSegments) {
    if (!declaredSegments.some((expected) => expected.path === actual.path)) {
      throw new Error(`Manifest has undeclared segment descriptor: ${actual.path}`);
    }
  }
}

function assertExactArchiveDescriptors(loadedArchives) {
  if (!Array.isArray(loadedArchives) || loadedArchives.length !== archivedRecordArrays.length) {
    throw new Error(
      `Manifest archive descriptor set has ${loadedArchives?.length ?? "invalid"} entries; expected ${archivedRecordArrays.length}`,
    );
  }
  const loadedByPath = new Map();
  const expectedFields = [...ARCHIVE_DESCRIPTOR_FIELDS,
    "records", "unique_ids", "overlap_with_declared_corpus", "sha256"].sort();
  for (const archive of loadedArchives) {
    if (!isPlainObject(archive) || typeof archive.path !== "string" || loadedByPath.has(archive.path)) {
      throw new Error("Every manifest archive must have one unique string path descriptor");
    }
    if (JSON.stringify(Object.keys(archive).sort()) !== JSON.stringify(expectedFields)) {
      throw new Error(`${archive.path} archive fields must be exactly: ${expectedFields.join(", ")}`);
    }
    loadedByPath.set(archive.path, archive);
  }
  for (const expected of archivedRecordArrays) {
    const actual = loadedByPath.get(expected.path);
    if (!actual) throw new Error(`Manifest is missing archived record array: ${expected.path}`);
    for (const field of ARCHIVE_DESCRIPTOR_FIELDS) {
      if (!hasOwn(actual, field) || actual[field] !== expected[field]) {
        throw new Error(
          `${expected.path}: archive descriptor ${field}=${JSON.stringify(actual[field])}; expected ${JSON.stringify(expected[field])}`,
        );
      }
    }
  }
}

export function refreshGeneratedSources() {
  const prepared = [];
  for (const segment of generatedSegments) {
    const origin = path.join(projectDir, segment.origin);
    if (!fs.existsSync(origin)) throw new Error(`Missing local acquisition source: ${segment.origin}`);
    const selected = readArray(origin)
      .filter((item) => within(item, segment.from, segment.through))
      .map((item, index) => normalizeCorpusRecord(item, `${segment.origin}[${index}]`, {
        contract: segment.contract || STRICT_CONTRACT,
      }));
    if (selected.length === 0) throw new Error(`Refresh selected no records for ${segment.path}`);
    assertUniqueAcross(selected, segment.path);
    prepared.push({ segment, selected });
  }
  for (const { segment, selected } of prepared) {
    const target = path.join(skillDir, segment.path);
    atomicWrite(target, `${JSON.stringify(selected, null, 2)}\n`);
    console.log(`refreshed\t${segment.path}\t${selected.length}`);
  }
}

function frameworkIndexMigrationRecord(record, label) {
  if (record?.record_contract === FRAMEWORK_SOURCE_CONTRACT) return record;
  if (!isPlainObject(record) || typeof record.text !== "string") {
    throw new Error(`${label} cannot be migrated without the retained page capture`);
  }
  const marker = "window.SNOWMAN_STATUS = ";
  const start = record.text.indexOf(marker);
  const bodyStart = start < 0 ? -1 : start + marker.length;
  const bodyEnd = bodyStart < 0 ? -1 : record.text.indexOf(";\nwindow.SNOWMAN_TARGET", bodyStart);
  if (bodyStart < marker.length || bodyEnd <= bodyStart) {
    throw new Error(`${label} does not contain the expected embedded Xueqiu status payload`);
  }
  let status;
  try {
    status = JSON.parse(record.text.slice(bodyStart, bodyEnd));
  } catch (error) {
    throw new Error(`${label} contains an unreadable embedded Xueqiu status payload`, { cause: error });
  }
  if (!isPlainObject(status)
      || String(status.id) !== FRAMEWORK_INDEX_SOURCE.id
      || String(status.user_id) !== FRAMEWORK_INDEX_SOURCE.owner
      || typeof status.text !== "string") {
    throw new Error(`${label} embedded status identity or text is invalid`);
  }
  return {
    id: status.id,
    created_at: status.created_at,
    title: status.title || "",
    text: status.text,
    target: status.target,
    reply_count: status.reply_count,
    like_count: status.like_count,
    retweet_count: status.retweet_count,
    view_count: status.view_count,
    source: status.source || "",
  };
}

export function migrateDeclaredSources() {
  const migrationSources = [...declaredSegments, ...archivedRecordArrays];
  const prepared = migrationSources.map((segment) => {
    const absolute = segmentFile(skillDir, segment.path);
    const records = readArray(absolute).map((item, index) => {
      const label = `${segment.path}[${index}]`;
      const source = segment.path === FRAMEWORK_INDEX_SOURCE.path
        ? frameworkIndexMigrationRecord(item, label)
        : item;
      return normalizeCorpusRecord(source, label, {
        contract: segment.contract || STRICT_CONTRACT,
      });
    });
    if (records.length === 0) throw new Error(`Corpus source must not be empty: ${segment.path}`);
    assertUniqueAcross(records, segment.path);
    for (const [index, item] of records.entries()) {
      if (segment.from && !within(item, segment.from, segment.through)) {
        throw new Error(`${segment.path}[${index}].created_at falls outside declared range`);
      }
    }
    return { absolute, records, segment };
  });

  for (const { absolute, records, segment } of prepared) {
    atomicWrite(absolute, `${JSON.stringify(records, null, 2)}\n`);
    console.log(`migrated\t${segment.path}\t${records.length}`);
  }
}

export function buildManifest({ baseDir = skillDir } = {}) {
  validateRecordArrayInventory({ baseDir });
  const segments = declaredSegments.map((segment) => metadataFor(segment, { baseDir }));
  const timeline = groupRecords(segments, "timeline", baseDir);
  const replies = groupRecords(segments, "replies", baseDir);
  const articles = groupRecords(segments, "articles", baseDir);
  const frameworkLinks = groupRecords(segments, "framework_links", baseDir);
  const frameworkIndex = groupRecords(segments, "framework_index", baseDir);
  assertUniqueAcross(timeline, "timeline corpus");
  assertUniqueAcross(replies, "reply corpus");
  assertUniqueAcross(articles, "article corpus");
  assertUniqueAcross(frameworkLinks, "framework-link corpus");
  assertUniqueAcross(frameworkIndex, "framework-index source corpus");
  const canonicalIds = new Set(
    [...timeline, ...articles, ...frameworkLinks, ...frameworkIndex].map((item) => item.id),
  );
  const archivedRecordMetadata = archivedRecordArrays.map((archive) => (
    metadataForArchive(archive, canonicalIds, { baseDir })
  ));

  const timeline2026 = timeline.filter((item) => datePart(item).startsWith("2026-")).length;
  const replyBaseline = segments
    .filter((segment) => segment.kind === "replies" && segment.stage === "baseline")
    .reduce((sum, segment) => sum + segment.records, 0);
  const replyIncremental = segments
    .filter((segment) => segment.kind === "replies" && segment.stage === "incremental")
    .reduce((sum, segment) => sum + segment.records, 0);
  const cutoffDate = [...timeline, ...replies].map(datePart).sort().at(-1);

  return {
    schema_version: CORPUS_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    subject: {
      name: "冰冰小美",
      xueqiu_user_id: "7143769715",
      profile_url: "https://xueqiu.com/u/7143769715",
    },
    acquisition: {
      platform: "Xueqiu",
      timeline_endpoint: "https://xueqiu.com/v4/statuses/user_timeline.json",
      article_endpoint: "https://xueqiu.com/statuses/original/timeline.json",
      comment_endpoint: "https://xueqiu.com/statuses/comments.json",
      manifest_builder: "scripts/build_corpus_manifest.mjs",
    },
    claims: {
      articles: articles.length,
      framework_links: frameworkLinks.length,
      reported_official_podcasts: 2,
      timeline_2026: timeline2026,
      replies_baseline: replyBaseline,
      replies_incremental: replyIncremental,
      replies_total: replies.length,
      cutoff_date: cutoffDate,
    },
    segments,
    archived_record_arrays: archivedRecordMetadata,
    declared_sources: [
      {
        kind: "reported_official_podcasts",
        count: 2,
        episodes: [{ id: "2840" }, { id: "2841" }],
        evidence: "references/research/04-external-views.md",
        evidence_grade: "project_secondary_record",
        verification_status: "not_independently_verified",
      },
    ],
    limitations: [
      "The July timeline acquisition contained one 2024 post; timeline_2026 excludes it.",
      "The baseline timeline uses legacy_normalized_v1 because 12 image-only or incomplete captures have no retained title/body text; no text was inferred.",
      "The baseline replies use legacy_normalized_v1 because comment-level reply_count was not captured and 286 parent URLs retain the post_link alias.",
      "The 155 timeline records acquired from 2026-06-21 through 2026-06-30 did not retain view_count; they use normalized_without_view_count_v1 and no values were invented.",
      "The framework index contains one explicitly declared external deleted-post link (status 308254026, owner 5003404268); every other framework link is owned by the subject account.",
      "The external framework-index source (status 311912942, owner 6895445760) was normalized from its embedded structured status payload; captured page scripts and client context are not retained in the corpus layer.",
      "Four historical research snapshots are explicitly archived and excluded from aggregate claims because all of their IDs already exist in declared canonical segments.",
      "Podcast episodes 2840 and 2841 are only reported by a project secondary record; original program pages, metadata, audio, and transcripts are not retained or independently verified.",
      "Main comment streams are represented, but recursive child-reply coverage is not guaranteed because the endpoint frequently returned API 10020.",
      "Public activity does not prove complete positions, returns, or off-platform actions.",
    ],
  };
}

function assertExactClaims(loaded, rebuilt) {
  if (!isPlainObject(loaded)) throw new Error("Manifest claims must be an object");
  const loadedKeys = Object.keys(loaded).sort();
  const rebuiltKeys = Object.keys(rebuilt).sort();
  if (JSON.stringify(loadedKeys) !== JSON.stringify(rebuiltKeys)) {
    throw new Error(`Manifest claim set is ${loadedKeys.join(",")}; expected ${rebuiltKeys.join(",")}`);
  }
  for (const claim of rebuiltKeys) {
    if (loaded[claim] !== rebuilt[claim]) {
      throw new Error(`Manifest claim ${claim}=${loaded[claim]} but corpus proves ${rebuilt[claim]}`);
    }
  }
}

function assertExactSection(name, loaded, rebuilt) {
  if (JSON.stringify(loaded) !== JSON.stringify(rebuilt)) {
    throw new Error(`Manifest ${name} must exactly match the corpus builder declaration`);
  }
}

export function validatePodcastEvidence(text, episodeIds) {
  for (const episode of episodeIds) {
    if (!/^\d+$/.test(episode) || !new RegExp(`(?<!\\d)${episode}(?!\\d)`).test(text)) {
      throw new Error(`Missing exact podcast evidence token for episode ${episode}`);
    }
  }
  return true;
}

export function validateCorpusManifest(manifest = null, { baseDir = skillDir } = {}) {
  const loaded = manifest ?? readJson(path.join(baseDir, "references", "sources", "corpus-manifest.json"));
  if (!isPlainObject(loaded)) throw new Error("Corpus manifest must be an object");
  const rootFields = [
    "schema_version",
    "generated_at",
    "subject",
    "acquisition",
    "claims",
    "segments",
    "archived_record_arrays",
    "declared_sources",
    "limitations",
  ].sort();
  if (JSON.stringify(Object.keys(loaded).sort()) !== JSON.stringify(rootFields)) {
    throw new Error(`Corpus manifest fields must be exactly: ${rootFields.join(", ")}`);
  }
  if (loaded.schema_version !== CORPUS_SCHEMA_VERSION) throw new Error("Unsupported corpus manifest schema");
  if (!AWARE_TIMESTAMP.test(loaded.generated_at || "") || Number.isNaN(Date.parse(loaded.generated_at))) {
    throw new Error("Corpus manifest generated_at must be a timezone-aware ISO timestamp");
  }
  assertExactSegmentDescriptors(loaded.segments);
  assertExactArchiveDescriptors(loaded.archived_record_arrays);

  const manifestSegments = new Map(loaded.segments.map((segment) => [segment.path, segment]));
  for (const expectedDescriptor of declaredSegments) {
    const expected = manifestSegments.get(expectedDescriptor.path);
    const actual = metadataFor(expectedDescriptor, { baseDir });
    for (const field of ["records", "unique_ids", "min_date", "max_date", "sha256"]) {
      if (actual[field] !== expected[field]) {
        throw new Error(`${expected.path}: manifest ${field}=${expected[field]} but actual=${actual[field]}`);
      }
    }
  }

  const rebuiltForArchiveValidation = buildManifest({ baseDir });
  const rebuiltArchives = new Map(
    rebuiltForArchiveValidation.archived_record_arrays.map((archive) => [archive.path, archive]),
  );
  for (const expected of loaded.archived_record_arrays) {
    const actual = rebuiltArchives.get(expected.path);
    for (const field of ["records", "unique_ids", "overlap_with_declared_corpus", "sha256"]) {
      if (actual?.[field] !== expected[field]) {
        throw new Error(`${expected.path}: manifest archive ${field}=${expected[field]} but actual=${actual?.[field]}`);
      }
    }
  }

  const rebuilt = rebuiltForArchiveValidation;
  assertExactClaims(loaded.claims, rebuilt.claims);
  for (const section of ["subject", "acquisition", "declared_sources", "limitations"]) {
    assertExactSection(section, loaded[section], rebuilt[section]);
  }
  const podcastSource = loaded.declared_sources[0];
  const episodeIds = podcastSource.episodes.map((episode) => episode.id);
  if (podcastSource.count !== podcastSource.episodes.length
      || new Set(episodeIds).size !== podcastSource.episodes.length) {
    throw new Error("Official podcast count must equal a unique episode set");
  }
  const podcastEvidenceFile = segmentFile(baseDir, podcastSource.evidence);
  const podcastEvidence = fs.readFileSync(podcastEvidenceFile, "utf8");
  validatePodcastEvidence(podcastEvidence, episodeIds);
  return loaded;
}

function printHelp() {
  console.log(`Usage: node scripts/build_corpus_manifest.mjs [options]

Options:
  --migrate  Normalize every declared tracked record, write each file atomically,
             and rebuild corpus-manifest.json.
  --refresh  Rebuild generated segments from local output/, normalizing records,
             and rebuild corpus-manifest.json.
  --write    Rebuild corpus-manifest.json from already-normalized tracked sources.
  --help     Show this help.`);
}

async function main(argv = process.argv.slice(2)) {
  const options = new Set(argv);
  const allowed = new Set(["--help", "--migrate", "--refresh", "--write"]);
  const unknown = argv.filter((value) => !allowed.has(value));
  if (unknown.length) throw new Error(`Unknown option(s): ${unknown.join(", ")}`);
  if (options.has("--help")) {
    printHelp();
    return;
  }
  if (options.has("--refresh")) refreshGeneratedSources();
  if (options.has("--migrate")) migrateDeclaredSources();
  if (options.has("--refresh") || options.has("--migrate") || options.has("--write")) {
    const manifest = buildManifest();
    atomicWrite(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`wrote\t${path.relative(skillDir, manifestFile)}`);
  }
  const manifest = validateCorpusManifest();
  console.log(
    `valid\ttimeline=${manifest.claims.timeline_2026}\treplies=${manifest.claims.replies_total}\tcutoff=${manifest.claims.cutoff_date}`,
  );
}

if (path.resolve(process.argv[1] || "") === scriptFile) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
