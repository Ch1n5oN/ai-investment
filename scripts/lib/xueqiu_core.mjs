import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
export const SCHEMA_VERSION = 1;
export const RECORD_CONTRACT = "normalized_v1";
const NORMALIZED_RECORD_FIELDS = new Set([
  "schema_version", "record_contract", "id", "created_at_raw", "created_at",
  "target", "post_id", "post_target", "post_link", "reply_to",
  "in_reply_to_comment_id", "status_id", "user_id", "text", "clean_text",
  "reply_count", "like_count", "retweet_count", "view_count", "post_reply_count",
  "title", "source", "origin", "mode", "post_title", "post_text", "post_excerpt",
  "created_ms", "fetched_from_page", "post_created_at_raw", "post_created_at",
  "legacy_migrated_fields",
]);

export function asciiTrim(value) {
  return String(value).replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidRecord(message) {
  return Object.assign(new Error(message), { code: "INVALID_RECORD" });
}

export function parseArgs(argv, { allowed = null, booleans = [] } = {}) {
  const args = {};
  const allowedSet = allowed ? new Set(allowed) : null;
  const booleanSet = new Set(booleans);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--") || value === "--") {
      throw Object.assign(new Error(`Unexpected positional argument: ${value}`), {
        code: "INVALID_ARGUMENT",
      });
    }
    const separator = value.indexOf("=");
    const key = value.slice(2, separator > 2 ? separator : undefined);
    if (!key || (allowedSet && !allowedSet.has(key))) {
      throw Object.assign(new Error(`Unknown option: --${key}`), { code: "INVALID_ARGUMENT" });
    }
    if (hasOwn(args, key)) {
      throw Object.assign(new Error(`Duplicate option: --${key}`), { code: "INVALID_ARGUMENT" });
    }
    if (separator > 2) {
      const optionValue = value.slice(separator + 1);
      if (booleanSet.has(key)) {
        if (!["true", "false"].includes(optionValue)) {
          throw Object.assign(new Error(`--${key} must be true or false`), { code: "INVALID_ARGUMENT" });
        }
        args[key] = optionValue === "true";
      } else {
        if (!optionValue) {
          throw Object.assign(new Error(`--${key} requires a value`), { code: "INVALID_ARGUMENT" });
        }
        args[key] = optionValue;
      }
      continue;
    }
    if (booleanSet.has(key)) {
      args[key] = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      if (allowedSet) {
        throw Object.assign(new Error(`--${key} requires a value`), { code: "INVALID_ARGUMENT" });
      }
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

export function cleanHtml(value) {
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

function validCalendarDate(year, month, day) {
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return calendar.getUTCFullYear() === year
    && calendar.getUTCMonth() === month - 1
    && calendar.getUTCDate() === day;
}

function recordEpochInRange(milliseconds) {
  const shifted = new Date(milliseconds + SHANGHAI_OFFSET_MS);
  if (Number.isNaN(shifted.getTime())) return false;
  const year = shifted.getUTCFullYear();
  return year >= 2000 && year <= 9999;
}

function numericEpochMs(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const milliseconds = value >= 1e11 ? value : value * 1000;
  if (!Number.isFinite(milliseconds) || !recordEpochInRange(milliseconds)) return null;
  return milliseconds;
}

export function toEpochMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return numericEpochMs(value);

  const text = asciiTrim(value);
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return numericEpochMs(Number(text));

  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:(Z)|([+-])(\d{2}):(\d{2}))?$/.exec(text);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zulu, sign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!validCalendarDate(year, month, day)) return null;

  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const millisecond = fraction ? Number(fraction.padEnd(3, "0")) : 0;

  let offsetMinutes = 8 * 60;
  if (zulu) {
    offsetMinutes = 0;
  } else if (sign) {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (sign === "+" ? 1 : -1);
  }
  const milliseconds = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
    - offsetMinutes * 60 * 1000;
  return recordEpochInRange(milliseconds) ? milliseconds : null;
}

export function formatTime(value) {
  const epochMs = toEpochMs(value);
  if (epochMs === null) return "unknown";
  const shifted = new Date(epochMs + SHANGHAI_OFFSET_MS);
  if (Number.isNaN(shifted.getTime())) return "unknown";
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

function isExplicitUnknownRawTime(value) {
  if (value === null || value === 0) return true;
  if (typeof value !== "string") return false;
  const normalized = asciiTrim(value);
  return normalized === "" || normalized.toLowerCase() === "unknown" || normalized === "未知时间";
}

export function canonicalTarget(value, userId = "", postId = "") {
  const target = asciiTrim(value || "");
  const fallback = userId && postId
    ? `https://xueqiu.com/${encodeURIComponent(userId)}/${encodeURIComponent(postId)}`
    : "";
  if (!target) {
    if (fallback) return fallback;
    throw Object.assign(new Error("Target is missing and no Xueqiu post fallback is available."), {
      code: "INVALID_TARGET",
    });
  }

  let candidate;
  try {
    if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^https?:/i.test(target)) throw new Error("unsupported protocol");
    const authority = /^(?:https?:)?\/\/([^/?#]+)/i.exec(target)?.[1] || "";
    const explicitPort = /:(\d+)$/.exec(authority)?.[1] || "";
    if (explicitPort && explicitPort !== "443") throw new Error("unsupported port");
    candidate = target.startsWith("//")
      ? new URL(`https:${target}`)
      : /^https?:\/\//i.test(target)
        ? new URL(target)
        : new URL(target.startsWith("/") ? target : `/${target}`, "https://xueqiu.com");
  } catch (error) {
    throw Object.assign(new Error(`Target must be a canonical Xueqiu URL: ${target}`), {
      code: "INVALID_TARGET",
      cause: error,
    });
  }
  const hostname = candidate.hostname.toLowerCase();
  if ((hostname !== "xueqiu.com" && !hostname.endsWith(".xueqiu.com"))
    || candidate.username
    || candidate.password
    || (candidate.port && candidate.port !== "443")) {
    throw Object.assign(new Error(`Target must be a canonical Xueqiu URL: ${target}`), {
      code: "INVALID_TARGET",
    });
  }
  if (fallback) {
    const segments = candidate.pathname.split("/").filter(Boolean);
    if (segments.length !== 2 || segments[0] !== String(userId) || segments[1] !== String(postId)) {
      throw Object.assign(new Error(`Target does not identify Xueqiu post ${userId}/${postId}: ${target}`), {
        code: "INVALID_TARGET",
      });
    }
  }
  candidate.protocol = "https:";
  candidate.port = "";
  return candidate.href;
}

export function parseIntegerOption(value, { name, defaultValue, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const resolved = value === undefined || value === null || value === "" ? defaultValue : value;
  const number = typeof resolved === "boolean" ? Number.NaN : typeof resolved === "number" ? resolved : Number(resolved);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw Object.assign(new Error(`${name || "option"} must be an integer between ${min} and ${max}`), {
      code: "INVALID_ARGUMENT",
    });
  }
  return number;
}

export function parseNumberOption(value, { name, defaultValue, min = 0, max = Number.MAX_VALUE } = {}) {
  const resolved = value === undefined || value === null || value === "" ? defaultValue : value;
  const number = typeof resolved === "boolean" ? Number.NaN : typeof resolved === "number" ? resolved : Number(resolved);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw Object.assign(new Error(`${name || "option"} must be a number between ${min} and ${max}`), {
      code: "INVALID_ARGUMENT",
    });
  }
  return number;
}

export function validateDateOption(value, name = "date") {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const calendar = match && year >= 1000 ? new Date(Date.UTC(year, month - 1, day)) : null;
  if (!calendar
    || calendar.getUTCFullYear() !== year
    || calendar.getUTCMonth() !== month - 1
    || calendar.getUTCDate() !== day) {
    throw Object.assign(new Error(`${name} must use YYYY-MM-DD`), { code: "INVALID_ARGUMENT" });
  }
  return text;
}

export function validateUserId(value, defaultValue = "") {
  const resolved = String(value || defaultValue);
  if (!/^\d+$/.test(resolved)) {
    throw Object.assign(new Error("--user_id must contain digits only"), { code: "INVALID_ARGUMENT" });
  }
  return resolved;
}

export function normalizeNonNegativeInteger(value, name = "count") {
  const normalizedString = typeof value === "string" ? asciiTrim(value) : null;
  const number = typeof value === "number"
    ? value
    : normalizedString !== null && /^\d+$/.test(normalizedString)
      ? Number(normalizedString)
      : Number.NaN;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw Object.assign(new Error(`${name} must be a non-negative integer.`), { code: "INVALID_RECORD" });
  }
  return number;
}

export function readJsonStrict(file, { defaultValue, validate } = {}) {
  if (!fs.existsSync(file)) return defaultValue;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw Object.assign(new Error(`Invalid JSON file ${file}: ${error.message}`), {
      code: "INVALID_JSON_FILE",
      cause: error,
    });
  }
  if (validate && !validate(parsed)) {
    throw Object.assign(new Error(`Unexpected JSON shape in ${file}`), { code: "INVALID_JSON_SHAPE" });
  }
  return parsed;
}

export function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.writeFileSync(temporary, value, "utf8");
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function normalizedId(value, label, { legacy = false, nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (legacy && (typeof value === "string" || Number.isSafeInteger(value))) {
    const id = asciiTrim(value);
    if (/^\d+$/.test(id)) return id;
  }
  if (!legacy && typeof value === "string" && /^\d+$/.test(value)) return value;
  throw invalidRecord(`${label} must be a digit-only string id.`);
}

function targetRecordId(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalidRecord(`${label} must be an absolute canonical Xueqiu URL.`);
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const id = segments.at(-1) || "";
  if (!/^\d+$/.test(id)) throw invalidRecord(`${label} must end with a digit-only record id.`);
  return id;
}

function validateTextPair(record) {
  for (const field of ["text", "clean_text"]) {
    if (!hasOwn(record, field) || typeof record[field] !== "string") {
      throw invalidRecord(`Corpus record ${field} must be a string.`);
    }
  }
  if (record.clean_text !== cleanHtml(record.text)) {
    throw invalidRecord("clean_text must be the normalized representation of text.");
  }
}

function normalizeRecordCounts(record, fields, { legacy }) {
  for (const field of fields) {
    if (!hasOwn(record, field)) {
      throw invalidRecord(`Corpus record is missing required ${field}.`);
    }
    if (legacy) {
      record[field] = normalizeNonNegativeInteger(record[field], field);
    } else if (!Number.isSafeInteger(record[field]) || record[field] < 0) {
      throw invalidRecord(`${field} must be a non-negative integer.`);
    }
  }
}

function validateOptionalIds(record, { legacy }) {
  for (const field of ["reply_to", "in_reply_to_comment_id"]) {
    if (!hasOwn(record, field)) continue;
    record[field] = normalizedId(record[field], field, {
      legacy,
      nullable: true,
    });
  }
}

function validateOptionalPostTime(record) {
  const hasRaw = hasOwn(record, "post_created_at_raw");
  const hasNormalized = hasOwn(record, "post_created_at");
  if (hasRaw !== hasNormalized) {
    throw invalidRecord("post_created_at_raw and post_created_at must either both be present or both be absent.");
  }
  if (!hasRaw) return;
  if (!["string", "number"].includes(typeof record.post_created_at_raw)
    && record.post_created_at_raw !== null) {
    throw invalidRecord("post_created_at_raw must be a string, number, or null.");
  }
  const normalizedTime = formatTime(record.post_created_at_raw);
  if (normalizedTime === "unknown" && !isExplicitUnknownRawTime(record.post_created_at_raw)) {
    throw invalidRecord("post_created_at_raw must be a valid timestamp or an explicit unknown value.");
  }
  if (typeof record.post_created_at !== "string" || record.post_created_at !== normalizedTime) {
    throw invalidRecord("post_created_at does not represent post_created_at_raw.");
  }
  record.post_created_at = normalizedTime;
}

function validateOptionalStrings(record) {
  for (const field of ["title", "post_title", "post_text", "origin", "source", "mode", "post_excerpt"]) {
    if (hasOwn(record, field) && typeof record[field] !== "string") {
      throw invalidRecord(`${field} must be a string when present.`);
    }
  }
}

function validateOptionalMetadata(record, { legacy }) {
  if (hasOwn(record, "status_id")) {
    record.status_id = normalizedId(record.status_id, "status_id", { legacy, nullable: true });
  }
  if (hasOwn(record, "user_id")) {
    record.user_id = normalizedId(record.user_id, "user_id", { legacy });
  }
  if (hasOwn(record, "post_reply_count")) {
    if (legacy) {
      record.post_reply_count = normalizeNonNegativeInteger(record.post_reply_count, "post_reply_count");
    } else if (!Number.isSafeInteger(record.post_reply_count) || record.post_reply_count < 0) {
      throw invalidRecord("post_reply_count must be a non-negative integer.");
    }
  }
  if (hasOwn(record, "created_ms")
    && (!Number.isSafeInteger(record.created_ms) || record.created_ms < 0)) {
    throw invalidRecord("created_ms must be a non-negative integer.");
  }
  if (hasOwn(record, "fetched_from_page")
    && (!Number.isSafeInteger(record.fetched_from_page) || record.fetched_from_page < 1)) {
    throw invalidRecord("fetched_from_page must be a positive integer.");
  }
  if (hasOwn(record, "legacy_migrated_fields")
    && (!Array.isArray(record.legacy_migrated_fields)
      || record.legacy_migrated_fields.some((field) => typeof field !== "string" || !field)
      || new Set(record.legacy_migrated_fields).size !== record.legacy_migrated_fields.length)) {
    throw invalidRecord("legacy_migrated_fields must contain unique non-empty strings.");
  }
}

export function upgradeRecord(item) {
  if (!isPlainObject(item)) throw invalidRecord("Corpus records must be plain JSON objects.");
  const hasSchemaVersion = hasOwn(item, "schema_version");
  const hasRecordContract = hasOwn(item, "record_contract");
  if (hasRecordContract && !hasSchemaVersion) {
    throw invalidRecord("record_contract cannot be present without schema_version.");
  }
  const legacy = !hasSchemaVersion;
  if (!legacy && item.schema_version !== SCHEMA_VERSION) {
    throw invalidRecord(`schema_version must equal ${SCHEMA_VERSION}.`);
  }
  if (hasOwn(item, "record_contract") && item.record_contract !== RECORD_CONTRACT) {
    throw invalidRecord(`record_contract must equal ${RECORD_CONTRACT}.`);
  }

  const upgraded = {
    ...item,
    schema_version: SCHEMA_VERSION,
    record_contract: RECORD_CONTRACT,
  };
  if (hasOwn(upgraded, "retweeted_status")) {
    if (hasRecordContract) throw invalidRecord("normalized records cannot contain retweeted_status.");
    delete upgraded.retweeted_status;
  }
  for (const field of Object.keys(upgraded)) {
    if (!NORMALIZED_RECORD_FIELDS.has(field)) {
      throw invalidRecord(`Corpus record contains unsupported field ${field}.`);
    }
  }
  const migratedFields = [];
  upgraded.id = normalizedId(item.id, "id", { legacy });

  if (!hasOwn(item, "created_at_raw")) {
    if (!legacy) throw invalidRecord("Corpus record must preserve created_at_raw.");
    upgraded.created_at_raw = item.created_at ?? null;
    migratedFields.push("created_at_raw");
  }
  if (!["string", "number"].includes(typeof upgraded.created_at_raw) && upgraded.created_at_raw !== null) {
    throw invalidRecord("created_at_raw must be a string, number, or null.");
  }
  const normalizedTime = formatTime(upgraded.created_at_raw);
  if (normalizedTime === "unknown"
    && !isExplicitUnknownRawTime(upgraded.created_at_raw)) {
    throw invalidRecord("created_at_raw must be a valid timestamp or an explicit unknown value.");
  }
  if (!hasOwn(item, "created_at")) {
    if (!legacy) throw invalidRecord("Corpus record is missing created_at.");
    upgraded.created_at = normalizedTime;
    migratedFields.push("created_at");
  } else if (typeof item.created_at !== "string"
    || (legacy ? formatTime(item.created_at) !== normalizedTime : item.created_at !== normalizedTime)) {
    throw invalidRecord("created_at does not represent its preserved created_at_raw.");
  } else {
    upgraded.created_at = normalizedTime;
  }

  if (!hasOwn(upgraded, "text")) {
    throw invalidRecord("Corpus record is missing original text.");
  }
  if (!hasOwn(upgraded, "clean_text")) {
    if (!legacy || typeof upgraded.text !== "string") {
      throw invalidRecord("Corpus record is missing clean_text.");
    }
    upgraded.clean_text = cleanHtml(upgraded.text);
    migratedFields.push("clean_text");
  }
  if (legacy && upgraded.clean_text !== cleanHtml(upgraded.text)) {
    upgraded.clean_text = cleanHtml(upgraded.text);
    migratedFields.push("clean_text");
  }
  validateTextPair(upgraded);

  const isReply = hasOwn(upgraded, "post_id") || hasOwn(upgraded, "post_target");
  if (isReply) {
    if (hasOwn(upgraded, "target") || hasOwn(upgraded, "post_link")) {
      throw invalidRecord("Reply records cannot include target or post_link.");
    }
    if (!hasOwn(upgraded, "post_id")) throw invalidRecord("Reply records must include post_id.");
    upgraded.post_id = normalizedId(upgraded.post_id, "post_id", {
      legacy,
    });
    if (!hasOwn(upgraded, "post_target")) {
      throw invalidRecord("Reply records must include a canonical post_target.");
    }
    const canonical = canonicalTarget(upgraded.post_target);
    if (!legacy && canonical !== upgraded.post_target) {
      throw invalidRecord("post_target must already be an absolute canonical Xueqiu URL.");
    }
    upgraded.post_target = canonical;
    if (targetRecordId(canonical, "post_target") !== upgraded.post_id) {
      throw invalidRecord("post_target must identify the record post_id.");
    }
    normalizeRecordCounts(upgraded, ["reply_count", "like_count"], { legacy });
  } else {
    if (hasOwn(upgraded, "post_link")) {
      throw invalidRecord("Post records cannot include post_link.");
    }
    if (!hasOwn(upgraded, "target")) throw invalidRecord("Post records must include a canonical target.");
    const canonical = canonicalTarget(upgraded.target);
    if (!legacy && canonical !== upgraded.target) {
      throw invalidRecord("target must already be an absolute canonical Xueqiu URL.");
    }
    upgraded.target = canonical;
    if (targetRecordId(canonical, "target") !== upgraded.id) {
      throw invalidRecord("target must identify the record id.");
    }
    normalizeRecordCounts(
      upgraded,
      ["reply_count", "like_count", "retweet_count", "view_count"],
      { legacy },
    );
  }
  validateOptionalIds(upgraded, { legacy });
  validateOptionalPostTime(upgraded);
  validateOptionalStrings(upgraded);
  validateOptionalMetadata(upgraded, { legacy });
  if (isReply && upgraded.status_id !== undefined && upgraded.status_id !== null
      && upgraded.status_id !== upgraded.post_id) {
    throw invalidRecord("status_id must identify the reply post_id.");
  }
  if (migratedFields.length) {
    upgraded.legacy_migrated_fields = [...new Set([
      ...(Array.isArray(item.legacy_migrated_fields) ? item.legacy_migrated_fields : []),
      ...migratedFields,
    ])].sort();
  }
  return upgraded;
}

function normalizedUniqueRecords(records, label) {
  const byId = new Map();
  for (const [index, item] of records.entries()) {
    const upgraded = upgradeRecord(item);
    if (byId.has(upgraded.id)) {
      throw invalidRecord(`${label} contains duplicate id ${upgraded.id} at index ${index}.`);
    }
    byId.set(upgraded.id, upgraded);
  }
  return byId;
}

function utf8TrimmedLength(value) {
  return Buffer.byteLength(asciiTrim(value), "utf8");
}

function mergeRecord(existing, incoming) {
  const existingReply = hasOwn(existing, "post_id");
  const incomingReply = hasOwn(incoming, "post_id");
  if (existingReply !== incomingReply) throw invalidRecord(`Record ${incoming.id} changed record kind.`);
  const urlField = existingReply ? "post_target" : "target";
  if (existing[urlField] !== incoming[urlField]) {
    throw invalidRecord(`Record ${incoming.id} changed its canonical ${urlField}.`);
  }
  if (existingReply && existing.post_id !== incoming.post_id) {
    throw invalidRecord(`Reply ${incoming.id} changed post_id.`);
  }
  for (const field of ["reply_to", "in_reply_to_comment_id"]) {
    if (existing[field] !== null
      && existing[field] !== undefined
      && incoming[field] !== null
      && incoming[field] !== undefined
      && existing[field] !== incoming[field]) {
      throw invalidRecord(`Reply ${incoming.id} changed ${field}.`);
    }
  }

  const merged = { ...existing, ...incoming };
  for (const [field, value] of Object.entries(incoming)) {
    if ((value === null || value === undefined) && existing[field] !== null && existing[field] !== undefined) {
      merged[field] = existing[field];
    }
  }
  const existingKnownTime = existing.created_at !== "unknown";
  const incomingKnownTime = incoming.created_at !== "unknown";
  if (existingKnownTime && incomingKnownTime && existing.created_at !== incoming.created_at) {
    throw invalidRecord(`Record ${incoming.id} changed its creation timestamp.`);
  }
  if (existingKnownTime && !incomingKnownTime) {
    merged.created_at_raw = existing.created_at_raw;
    merged.created_at = existing.created_at;
  }

  if (hasOwn(existing, "post_created_at") && hasOwn(incoming, "post_created_at")) {
    const existingKnownPostTime = existing.post_created_at !== "unknown";
    const incomingKnownPostTime = incoming.post_created_at !== "unknown";
    if (existingKnownPostTime
      && incomingKnownPostTime
      && existing.post_created_at !== incoming.post_created_at) {
      throw invalidRecord(`Reply ${incoming.id} changed its post creation timestamp.`);
    }
    if (existingKnownPostTime && !incomingKnownPostTime) {
      merged.post_created_at_raw = existing.post_created_at_raw;
      merged.post_created_at = existing.post_created_at;
    }
  }

  const incomingTextScore = utf8TrimmedLength(incoming.text) + utf8TrimmedLength(incoming.clean_text);
  const existingTextScore = utf8TrimmedLength(existing.text) + utf8TrimmedLength(existing.clean_text);
  if (incomingTextScore < existingTextScore) {
    merged.text = existing.text;
    merged.clean_text = existing.clean_text;
  }
  for (const field of ["title", "post_title", "post_text", "origin", "source"]) {
    if (typeof existing[field] === "string"
      && typeof incoming[field] === "string"
      && utf8TrimmedLength(incoming[field]) < utf8TrimmedLength(existing[field])) {
      merged[field] = existing[field];
    }
  }
  return upgradeRecord(merged);
}

function compareRecordOrder(left, right) {
  const leftTime = toEpochMs(left.created_at) ?? 0;
  const rightTime = toEpochMs(right.created_at) ?? 0;
  if (leftTime !== rightTime) return leftTime > rightTime ? -1 : 1;
  if (left.id.length !== right.id.length) return left.id.length > right.id.length ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id > right.id ? -1 : 1;
}

export function mergeById(existing, incoming) {
  if (!Array.isArray(existing) || !Array.isArray(incoming)) {
    throw Object.assign(new Error("mergeById expects arrays"), { code: "INVALID_JSON_SHAPE" });
  }
  const items = normalizedUniqueRecords(existing, "existing records");
  const additions = normalizedUniqueRecords(incoming, "incoming records");
  for (const [id, item] of additions) {
    items.set(id, items.has(id) ? mergeRecord(items.get(id), item) : item);
  }
  return [...items.values()].sort(compareRecordOrder);
}

export function exitCodeForStatus(status) {
  if (status === "complete") return 0;
  if (status === "needs_verification") return 2;
  return 1;
}

export function classifyJsonResponse(payload, url) {
  const text = String(payload?.text || "");
  const contentType = String(payload?.contentType || "");
  const htmlResponse = /(?:text\/html|application\/xhtml\+xml)/i.test(contentType);
  const jsonResponse = /(?:application|text)\/(?:[^;]+\+)?json/i.test(contentType);
  let parsed;
  let parseError;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    parseError = error;
  }
  const structuredChallenge = isPlainObject(parsed)
    && ["renderData", "_waf_", "aliyun_waf", "captcha"].some((key) => hasOwn(parsed, key));
  if (htmlResponse || structuredChallenge) {
    throw Object.assign(new Error(`WAF challenge for ${url}`), { code: "WAF" });
  }
  if (payload?.status !== 200) {
    if (parseError && !jsonResponse && /renderData|_waf_|aliyun_waf|captcha/i.test(text)) {
      throw Object.assign(new Error(`WAF challenge for ${url}`), { code: "WAF" });
    }
    const errorCode = isPlainObject(parsed) && parsed.error_code
      ? `API_${parsed.error_code}`
      : payload?.status === 400 && /10020/.test(text)
        ? "API_10020"
        : `HTTP_${payload?.status}`;
    const code = errorCode;
    throw Object.assign(new Error(`${code} ${url}: ${text.slice(0, 180)}`), { code });
  }
  if (parseError) {
    if (!jsonResponse && /renderData|_waf_|aliyun_waf|captcha/i.test(text)) {
      throw Object.assign(new Error(`WAF challenge for ${url}`), { code: "WAF" });
    }
    throw Object.assign(new Error(`Invalid JSON for ${url}: ${text.slice(0, 180)}`), {
      code: "INVALID_JSON",
      cause: parseError,
    });
  }
  if (isPlainObject(parsed) && parsed.error_code) {
    throw Object.assign(new Error(`${parsed.error_code}: ${parsed.error_description || "API error"}`), {
      code: `API_${parsed.error_code}`,
    });
  }
  return parsed;
}

export function classifyHtmlResponse(payload, url) {
  const text = String(payload?.text || "");
  if (/renderData|_waf_|aliyun_waf|captcha/i.test(text)) {
    throw Object.assign(new Error(`WAF challenge for ${url}`), { code: "WAF" });
  }
  if (payload?.status !== 200) {
    const code = `HTTP_${payload?.status}`;
    throw Object.assign(new Error(`${code} ${url}: ${text.slice(0, 180)}`), { code });
  }
  const contentType = String(payload?.contentType || "");
  if (contentType && !/(?:text\/html|application\/xhtml\+xml)/i.test(contentType)) {
    throw Object.assign(new Error(`Unexpected HTML content type for ${url}: ${contentType}`), {
      code: "INVALID_CONTENT_TYPE",
    });
  }
  if (!text.trim()) {
    throw Object.assign(new Error(`Empty HTML response for ${url}`), { code: "INVALID_HTML" });
  }
  return text;
}

export function extractArrayField(payload, keys, label = "response") {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw Object.assign(new Error(`${label} must be a JSON object.`), { code: "INVALID_RESPONSE_SHAPE" });
  }
  for (const key of keys) {
    if (!Object.hasOwn(payload, key)) continue;
    if (!Array.isArray(payload[key])) {
      throw Object.assign(new Error(`${label}.${key} must be an array.`), { code: "INVALID_RESPONSE_SHAPE" });
    }
    return payload[key];
  }
  throw Object.assign(new Error(`${label} is missing one of: ${keys.join(", ")}.`), {
    code: "INVALID_RESPONSE_SHAPE",
  });
}

function invalidPagination(label, message) {
  return Object.assign(new Error(`${label} ${message}`), { code: "INVALID_RESPONSE_SHAPE" });
}

export function pageableTimelineItems(items, {
  page,
  count,
  label = "Timeline pagination",
}) {
  if (!Array.isArray(items)) throw invalidPagination(label, "items must be an array.");
  if (!Number.isSafeInteger(page) || page < 1) throw invalidPagination(label, "received an invalid page.");
  if (!Number.isSafeInteger(count) || count < 1) throw invalidPagination(label, "received an invalid count.");
  if (items.length <= count) return items;

  const overflow = items.length - count;
  const pinned = page === 1
    ? items.filter((item) => item && typeof item === "object" && !Array.isArray(item) && item.mark === 1)
    : [];
  if (pinned.length !== overflow) {
    throw invalidPagination(label, "returned unexplained items beyond the requested page size.");
  }
  return items.filter((item) => !(item && typeof item === "object" && !Array.isArray(item) && item.mark === 1));
}

export function advanceSinceBoundary(previous, records, sinceEpoch) {
  const state = previous || {
    ordered: true,
    lastEpoch: null,
    candidate: false,
    confirmed: false,
  };
  if (sinceEpoch === null) return { ...state, confirmed: false };

  let ordered = state.ordered;
  let lastEpoch = state.lastEpoch;
  const epochs = [];
  for (const record of records) {
    const epoch = toEpochMs(record?.created_at);
    epochs.push(epoch);
    if (epoch === null || (lastEpoch !== null && epoch > lastEpoch)) ordered = false;
    if (epoch !== null) lastEpoch = epoch;
  }
  const allBefore = epochs.length > 0
    && epochs.every((epoch) => epoch !== null && epoch < sinceEpoch);
  return {
    ordered,
    lastEpoch,
    candidate: ordered && epochs.some((epoch) => epoch !== null && epoch < sinceEpoch),
    confirmed: state.candidate && ordered && allBefore,
  };
}

function paginationContainers(payload, label) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw invalidPagination(label, "must be a JSON object.");
  }
  const containers = [payload];
  for (const field of ["page", "pagination", "meta", "page_info"]) {
    if (!hasOwn(payload, field)) continue;
    const value = payload[field];
    if (field === "page" && !isPlainObject(value)) continue;
    if (!isPlainObject(value)) {
      throw invalidPagination(label, `has an invalid ${field} metadata container.`);
    }
    containers.push(value);
  }
  return containers;
}

function normalizedPaginationInteger(value, label, field) {
  const normalized = typeof value === "string" ? asciiTrim(value) : value;
  const number = typeof normalized === "number"
    ? normalized
    : typeof normalized === "string" && /^\d+$/.test(normalized)
      ? Number(normalized)
      : Number.NaN;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw invalidPagination(label, `has an invalid ${field} value.`);
  }
  return number;
}

function normalizedHasMore(value, label) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value === "string") {
    const normalized = asciiTrim(value).toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  throw invalidPagination(label, "has an invalid has_more value.");
}

function normalizedNextCursor(value, label) {
  if (value === null || value === "" || value === 0) return null;
  if (typeof value === "string") {
    const normalized = asciiTrim(value);
    return !normalized || normalized === "0" ? null : normalized;
  }
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  throw invalidPagination(label, "has an invalid next cursor value.");
}

function collectPaginationValue(containers, aliases, normalize, label, field) {
  const values = [];
  for (const container of containers) {
    for (const alias of aliases) {
      if (hasOwn(container, alias)) values.push(normalize(container[alias], label, field));
    }
  }
  if (!values.length) return { present: false, value: null };
  if (values.some((value) => value !== values[0])) {
    throw invalidPagination(label, `has conflicting ${field} values.`);
  }
  return { present: true, value: values[0] };
}

function collectCurrentPage(containers, label) {
  const values = [];
  const aliases = ["page", "page_no", "pageNo", "current_page", "currentPage"];
  for (const [containerIndex, container] of containers.entries()) {
    for (const alias of aliases) {
      if (!hasOwn(container, alias)) continue;
      if (containerIndex === 0 && alias === "page" && isPlainObject(container[alias])) continue;
      values.push(normalizedPaginationInteger(container[alias], label, "current page"));
    }
  }
  if (!values.length) return { present: false, value: null };
  if (values.some((value) => value !== values[0])) {
    throw invalidPagination(label, "has conflicting current page values.");
  }
  return { present: true, value: values[0] };
}

export function paginationComplete(payload, {
  page,
  count,
  itemCount,
  observedCount,
  label = "Pagination",
}) {
  for (const [field, value, minimum] of [
    ["page", page, 1],
    ["count", count, 1],
    ["itemCount", itemCount, 0],
    ["observedCount", observedCount, 0],
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw invalidPagination(label, `received an invalid ${field}.`);
    }
  }
  if (itemCount > count) throw invalidPagination(label, "returned more items than requested.");

  const containers = paginationContainers(payload, label);
  const currentPage = collectCurrentPage(containers, label);
  const hasMore = collectPaginationValue(
    containers,
    ["has_more", "hasMore"],
    normalizedHasMore,
    label,
    "has_more",
  );
  const pageCount = collectPaginationValue(
    containers,
    ["max_page", "maxPage", "page_count", "pageCount", "total_pages", "totalPages"],
    normalizedPaginationInteger,
    label,
    "page count",
  );
  const total = collectPaginationValue(
    containers,
    ["total", "total_count", "totalCount"],
    normalizedPaginationInteger,
    label,
    "total",
  );
  const nextCursor = collectPaginationValue(
    containers,
    ["next", "next_id", "nextId", "next_cursor", "nextCursor"],
    normalizedNextCursor,
    label,
    "next cursor",
  );

  if (currentPage.present && currentPage.value !== page) {
    throw invalidPagination(label, "current-page metadata does not match the requested page.");
  }

  if (pageCount.present
    && ((pageCount.value === 0 && (itemCount > 0 || observedCount > 0))
      || (page > pageCount.value && itemCount > 0))) {
    throw invalidPagination(label, "page-count metadata contradicts the observed page.");
  }
  const moreEvidence = [];
  const completeEvidence = [];
  if (hasMore.present) (hasMore.value ? moreEvidence : completeEvidence).push("has_more");
  if (nextCursor.present) (nextCursor.value !== null ? moreEvidence : completeEvidence).push("next cursor");
  if (pageCount.present) {
    (page < pageCount.value ? moreEvidence : completeEvidence).push("page count");
  }
  if (total.present) {
    (observedCount < total.value ? moreEvidence : completeEvidence).push("total");
  }
  if (moreEvidence.length && completeEvidence.length) {
    return false;
  }
  if (moreEvidence.length) return false;
  if (completeEvidence.length) return true;
  return itemCount < count;
}

function hasValidCheckpointFields(value) {
  if (!isPlainObject(value) || value.schema_version !== SCHEMA_VERSION) return false;
  if (!("post_reply_counts" in value)) return false;
  const counts = value.post_reply_counts;
  if (!isPlainObject(counts)) return false;
  if (!Object.entries(counts).every(([postId, count]) => (
    /^\d+$/.test(postId) && Number.isInteger(count) && count >= 0
  ))) return false;
  for (const field of ["scanned_post_ids", "confirmed_post_ids"]) {
    if (!Array.isArray(value[field])
      || value[field].some((id) => typeof id !== "string" || !/^\d+$/.test(id))
      || new Set(value[field]).size !== value[field].length) return false;
  }
  if (value.latest_post_id !== null
    && (typeof value.latest_post_id !== "string" || !/^\d+$/.test(value.latest_post_id))) return false;
  if (value.latest_post_time !== null
    && (typeof value.latest_post_time !== "string" || formatTime(value.latest_post_time) !== value.latest_post_time)) return false;
  if (value.updated_at !== null
    && (typeof value.updated_at !== "string" || Number.isNaN(Date.parse(value.updated_at)))) return false;
  return ["comment_method", "comment_coverage", "nested_reply_coverage"]
    .every((field) => typeof value[field] === "string" && value[field].length > 0);
}

export function isValidCheckpointState(value, expectedUserId) {
  if (typeof expectedUserId !== "string" || !/^\d+$/.test(expectedUserId)) return false;
  return hasValidCheckpointFields(value) && value.user_id === expectedUserId;
}

export function checkpointStateForUser(value, expectedUserId) {
  const userId = validateUserId(expectedUserId);
  if (!hasValidCheckpointFields(value)) {
    throw Object.assign(new Error("Checkpoint state has an invalid shape."), {
      code: "INVALID_JSON_SHAPE",
    });
  }
  if (!hasOwn(value, "user_id")) return initialCheckpointState(userId);
  if (value.user_id !== userId) {
    throw Object.assign(
      new Error(`Checkpoint belongs to user ${value.user_id}, expected ${userId}.`),
      { code: "CHECKPOINT_USER_MISMATCH" },
    );
  }
  return value;
}

export function initialCheckpointState(userId) {
  const normalizedUserId = validateUserId(userId);
  return {
    schema_version: SCHEMA_VERSION,
    user_id: normalizedUserId,
    updated_at: null,
    latest_post_id: null,
    latest_post_time: null,
    post_reply_counts: {},
    comment_method: "not_run",
    comment_coverage: "not_requested",
    scanned_post_ids: [],
    confirmed_post_ids: [],
    nested_reply_coverage: "not_requested",
  };
}

export function selectChangedPosts(posts, previousCounts, { limit, force = false }) {
  return posts.filter((post, index) => {
    if (index >= limit) return false;
    const previous = previousCounts[String(post.id)];
    return force || previous === undefined || Number(post.reply_count) !== Number(previous);
  });
}

export function updatePostReplyCounts(posts, previousCounts, confirmedPostIds, limit) {
  const counts = { ...previousCounts };
  const confirmed = new Set(confirmedPostIds.map(String));
  for (const post of posts.slice(0, limit)) {
    const postId = String(post.id);
    if (confirmed.has(postId)) counts[postId] = normalizeNonNegativeInteger(post.reply_count, "reply_count");
  }
  return counts;
}

export function commentCoverageFor({ scanned, candidates, truncated, unverified = [] }) {
  if (scanned.length !== candidates.length) return "partial_waf";
  if (truncated.length) return "partial_page_limit";
  if (unverified.length) return "partial_incomplete_response";
  return "changed_posts_main_stream_complete";
}

export function confirmedPostIdsFor(scanned, truncated, unverified = []) {
  const incomplete = new Set([...truncated, ...unverified].map(String));
  return scanned.map(String).filter((postId) => !incomplete.has(postId));
}

export function syncStatusFor({ commentCoverage, articleError = null }) {
  return commentCoverage.startsWith("partial_") || articleError
    ? "needs_verification"
    : "complete";
}

export function renderMarkdown(items, kind) {
  const lines = [`# Xueqiu ${kind}`, "", `Updated at: ${new Date().toISOString()}`, `Total: ${items.length}`, "", "---", ""];
  for (const [index, item] of items.entries()) {
    lines.push(`## ${kind === "self replies" ? "Reply" : "Post"} ${index + 1}`, "");
    lines.push(`ID: ${item.id || ""}`, `Time: ${item.created_at || ""}`);
    if (kind === "self replies") {
      lines.push(`Origin: ${item.origin || ""}`, `Post ID: ${item.post_id || ""}`, `Post Link: ${item.post_target || ""}`);
    } else {
      lines.push(`Link: ${item.target || ""}`, `Replies: ${item.reply_count || 0} | Likes: ${item.like_count || 0} | Reposts: ${item.retweet_count || 0}`);
      if (item.title) lines.push(`Title: ${item.title}`);
    }
    lines.push("", item.clean_text || cleanHtml(item.text || ""), "", "---", "");
  }
  return lines.join("\n");
}
