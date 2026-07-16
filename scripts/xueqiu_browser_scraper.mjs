#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CdpSession } from "./lib/cdp_session.mjs";
import {
  RECORD_CONTRACT,
  SCHEMA_VERSION,
  atomicWrite,
  asciiTrim,
  canonicalTarget,
  classifyHtmlResponse,
  classifyJsonResponse,
  cleanHtml,
  extractArrayField,
  formatTime,
  mergeById,
  normalizeNonNegativeInteger,
  paginationComplete,
  parseArgs,
  parseIntegerOption,
  parseNumberOption,
  readJsonStrict,
  toEpochMs,
  upgradeRecord,
  validateDateOption,
  validateUserId,
} from "./lib/xueqiu_core.mjs";

function sinceOk(item, sinceDate) {
  if (!sinceDate) return true;
  const created = toEpochMs(item.created_at);
  return !created || created >= Date.parse(`${sinceDate}T00:00:00+08:00`);
}

export async function browserFetch(send, url, asJson = true) {
  const expression = `(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(${JSON.stringify(url)}, {
        credentials: "include",
        signal: controller.signal,
        headers: {"X-Requested-With": "XMLHttpRequest", "Accept": ${JSON.stringify(asJson ? "application/json" : "text/html,*/*")}}
      });
      return {status: response.status, contentType: response.headers.get("content-type") || "", text: await response.text()};
    } finally {
      clearTimeout(timer);
    }
  })()`;
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "fetch failed");
  }
  const payload = result.result.value;
  if (!asJson) {
    if (payload.status !== 200) throw new Error(`HTTP ${payload.status} for ${url}: ${payload.text.slice(0, 160)}`);
    return payload.text;
  }
  return classifyJsonResponse(payload, url);
}

function normalizeId(value, label = "id", code = "INVALID_RESPONSE_SHAPE") {
  const id = typeof value === "string"
    ? asciiTrim(value)
    : Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : "";
  if (!/^\d+$/.test(id)) {
    throw Object.assign(new Error(`${label} must contain digits only.`), { code });
  }
  return id;
}

function networkField(record, aliases, label, { allowNull = false } = {}) {
  for (const alias of aliases) {
    if (Object.hasOwn(record, alias) && (allowNull || record[alias] !== null) && record[alias] !== undefined) {
      return record[alias];
    }
  }
  throw Object.assign(new Error(`${label} is missing ${aliases.join("/")}.`), {
    code: "INVALID_RESPONSE_SHAPE",
  });
}

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

function normalizeStatus(status, userId = "", expectedId = "") {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw Object.assign(new Error("Xueqiu status must be an object."), { code: "INVALID_RESPONSE_SHAPE" });
  }
  assertAcquisitionContract(status, "Xueqiu status");
  const id = normalizeId(status.id, "status.id");
  if (expectedId && id !== expectedId) {
    throw Object.assign(new Error(`Xueqiu returned status ${id} while ${expectedId} was requested.`), {
      code: "INVALID_RESPONSE_SHAPE",
    });
  }
  const createdAt = networkField(status, ["created_at"], "status timestamp", { allowNull: true });
  const rawText = networkField(status, ["text", "description"], "status text");
  return upgradeRecord({
    schema_version: SCHEMA_VERSION,
    record_contract: RECORD_CONTRACT,
    id,
    created_at_raw: createdAt,
    created_at: formatTime(createdAt),
    title: cleanHtml(status.title || ""),
    text: rawText,
    clean_text: cleanHtml(rawText),
    target: canonicalTarget(status.target, userId, status.id),
    reply_count: normalizeNonNegativeInteger(networkField(status, ["reply_count", "replyCount"], "status reply count"), "reply_count"),
    like_count: normalizeNonNegativeInteger(networkField(status, ["like_count", "likeCount"], "status like count"), "like_count"),
    retweet_count: normalizeNonNegativeInteger(networkField(status, ["retweet_count", "retweetCount"], "status retweet count"), "retweet_count"),
    view_count: normalizeNonNegativeInteger(networkField(status, ["view_count", "viewCount"], "status view count"), "view_count"),
  });
}

export async function fetchTimeline(send, userId, mode, pages, count, sinceDate, delayMs) {
  let items = [];
  let truncated = false;
  const endpoint = mode === "articles"
    ? "https://xueqiu.com/statuses/original/timeline.json"
    : "https://xueqiu.com/v4/statuses/user_timeline.json";

  for (let page = 1; page <= pages; page += 1) {
    const url = `${endpoint}?user_id=${encodeURIComponent(userId)}&page=${page}&count=${count}${mode === "posts" ? "&type=0" : ""}`;
    console.log(`fetch ${mode} page ${page}: ${url}`);
    const data = await browserFetch(send, url, true);
    const raw = extractArrayField(data, ["statuses", "list", "items"], `${mode} timeline`);
    for (const status of raw) items = mergeById(items, [normalizeStatus(status, userId)]);
    const complete = paginationComplete(data, {
      page,
      count,
      itemCount: raw.length,
      observedCount: items.length,
      label: `${mode} timeline pagination`,
    });
    if (complete) {
      if (!raw.length) console.log(`stop: no items on page ${page}`);
      break;
    }
    if (page === pages) {
      truncated = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { items: items.filter((item) => sinceOk(item, sinceDate)), truncated };
}

export async function fetchPageText(send, ref, defaultUserId) {
  const { userId, postId } = normalizePostReference(ref, defaultUserId);
  const url = `https://xueqiu.com/${userId}/${postId}`;
  console.log(`fetch page ${url}`);
  try {
    const status = await browserFetch(send, `https://xueqiu.com/statuses/show.json?id=${postId}`, true);
    return normalizeStatus(status, userId, postId);
  } catch (error) {
    if (["INVALID_RESPONSE_SHAPE", "INVALID_RECORD", "INVALID_TARGET"].includes(error.code)) throw error;
    console.error(`status API failed for ${postId}: ${error.message}; fallback to page HTML`);
  }
  const expression = `(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const r = await fetch(${JSON.stringify(url)}, {credentials: "include", signal: controller.signal});
        const html = await r.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const scriptText = html.match(/window\\.SNOWMAN_STATUS\\s*=\\s*(\\{[\\s\\S]*?\\});\\s*\\n/)?.[1];
        let value = null;
        if (scriptText) {
          try {
            const status = JSON.parse(scriptText);
            value = {
              id: status.id,
              created_at: status.created_at,
              title: status.rawTitle || status.title || "",
              text: status.text || status.description || "",
              target: status.target || "",
              reply_count: status.reply_count ?? status.replyCount,
              like_count: status.like_count ?? status.likeCount,
              retweet_count: status.retweet_count ?? status.retweetCount,
              view_count: status.view_count ?? status.viewCount
            };
          } catch {}
        }
        if (!value) {
          const article = doc.querySelector(".article__bd__detail");
          if (article) {
            value = {
              title: doc.querySelector("h1")?.innerText || "",
              text: article.innerText || ""
            };
          }
        }
        return {
          status: r.status,
          contentType: r.headers.get("content-type") || "",
          text: html,
          value
        };
      } finally {
        clearTimeout(timer);
      }
    })()`;
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "page fetch failed");
  }
  const htmlPayload = result.result.value || {};
  classifyHtmlResponse(htmlPayload, url);
  const value = htmlPayload.value;
  if (!value || typeof value !== "object" || !String(value.text || "").trim()) {
    throw Object.assign(new Error(`HTML page did not contain a Xueqiu post body: ${url}`), {
      code: "INVALID_RESPONSE_SHAPE",
    });
  }
  const id = normalizeId(value.id ?? postId, "status.id");
  if (id !== postId) {
    throw Object.assign(new Error(`HTML fallback returned status ${id} while ${postId} was requested.`), {
      code: "INVALID_RESPONSE_SHAPE",
    });
  }
  return upgradeRecord({
    schema_version: SCHEMA_VERSION,
    record_contract: RECORD_CONTRACT,
    id,
    created_at_raw: value.created_at ?? null,
    created_at: formatTime(value.created_at),
    title: cleanHtml(value.title || ""),
    text: value.text || "",
    clean_text: cleanHtml(value.text || ""),
    target: canonicalTarget(value.target, userId, id),
    reply_count: normalizeNonNegativeInteger(
      networkField(value, ["reply_count", "replyCount"], "status reply count"),
      "reply_count",
    ),
    like_count: normalizeNonNegativeInteger(
      networkField(value, ["like_count", "likeCount"], "status like count"),
      "like_count",
    ),
    retweet_count: normalizeNonNegativeInteger(
      networkField(value, ["retweet_count", "retweetCount"], "status retweet count"),
      "retweet_count",
    ),
    view_count: normalizeNonNegativeInteger(
      networkField(value, ["view_count", "viewCount"], "status view count"),
      "view_count",
    ),
  });
}

function writeOutputs(items, outDir, userId, suffix) {
  fs.mkdirSync(outDir, { recursive: true });
  const jsonFile = path.join(outDir, `xueqiu_${userId}_${suffix}.json`);
  const mdFile = path.join(outDir, `xueqiu_${userId}_${suffix}.md`);
  atomicWrite(jsonFile, JSON.stringify(items, null, 2));
  const md = [
    `# Xueqiu user ${userId} ${suffix}`,
    "",
    `Fetched at: ${new Date().toISOString()}`,
    "",
    "---",
    "",
    ...items.flatMap((item, index) => [
      `## Post ${index + 1}`,
      "",
      `ID: ${item.id || ""}`,
      "",
      `Time: ${item.created_at || ""}`,
      "",
      `Link: ${item.target || ""}`,
      "",
      item.title ? `Title: ${item.title}` : "",
      "",
      `Stats: replies ${item.reply_count || 0} | likes ${item.like_count || 0} | reposts ${item.retweet_count || 0} | views ${item.view_count || 0}`,
      "",
      item.clean_text || cleanHtml(item.text || ""),
      "",
      "---",
      "",
    ]),
  ].join("\n");
  atomicWrite(mdFile, md);
  console.log(`saved ${items.length} items to ${jsonFile}`);
  console.log(`saved markdown to ${mdFile}`);
}

function readExisting(outDir, userId, suffix) {
  const jsonFile = path.join(outDir, `xueqiu_${userId}_${suffix}.json`);
  if (!fs.existsSync(jsonFile)) return [];
  const items = readJsonStrict(jsonFile, { defaultValue: [], validate: Array.isArray });
  return mergeById(items, []).map((item) => {
    item.id = normalizeId(item.id, "stored record id", "INVALID_RECORD");
    return item;
  });
}

function itemKey(item) {
  return normalizeId(item?.id, "record id", "INVALID_RECORD");
}

export function normalizePostReference(ref, defaultUserId) {
  const value = asciiTrim(ref || "");
  if (/^\d+$/.test(value)) {
    return { userId: normalizeId(defaultUserId, "user id", "INVALID_ARGUMENT"), postId: value };
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw Object.assign(new Error(`Invalid Xueqiu post reference: ${value}`), {
      code: "INVALID_ARGUMENT",
      cause: error,
    });
  }
  const hostname = parsed.hostname.toLowerCase();
  const match = /^\/(\d+)\/(\d+)\/?$/.exec(parsed.pathname);
  if (parsed.protocol !== "https:"
    || (hostname !== "xueqiu.com" && !hostname.endsWith(".xueqiu.com"))
    || parsed.username
    || parsed.password
    || parsed.port
    || !match) {
    throw Object.assign(new Error(`Invalid Xueqiu post reference: ${value}`), { code: "INVALID_ARGUMENT" });
  }
  return { userId: match[1], postId: match[2] };
}

export function mergeTimelineItems(existing, ...incomingGroups) {
  let merged = mergeById(existing, []);
  for (const item of incomingGroups.flat()) {
    merged = mergeById(merged, [item]);
  }
  return merged;
}

export async function runTimelineMode(send, {
  userId,
  mode,
  pages,
  count,
  sinceDate = null,
  delayMs = 0,
  outDir,
  resume = false,
}) {
  if (!["posts", "articles", "both"].includes(mode)) {
    throw Object.assign(new Error("Timeline mode must be posts, articles, or both."), {
      code: "INVALID_ARGUMENT",
    });
  }
  const modes = mode === "both" ? ["posts", "articles"] : [mode];
  const timelines = [];
  for (const streamMode of modes) {
    timelines.push(await fetchTimeline(
      send,
      userId,
      streamMode,
      pages,
      count,
      sinceDate,
      delayMs,
    ));
  }
  const freshItems = mergeTimelineItems([], ...timelines.map((timeline) => timeline.items));
  const items = resume
    ? mergeTimelineItems(readExisting(outDir, userId, mode), freshItems)
    : freshItems;
  const truncated = timelines.some((timeline) => timeline.truncated);
  const written = freshItems.length > 0;
  if (written) writeOutputs(items, outDir, userId, mode);
  return {
    items,
    freshItems,
    truncated,
    written,
    exitCode: !written ? 1 : truncated ? 2 : 0,
  };
}

export async function runIdsMode(send, {
  refs,
  userId,
  outDir,
  resume = false,
  delayMs = 0,
}) {
  let items = resume ? readExisting(outDir, userId, "ids") : [];
  const seen = new Set(items.map(itemKey));
  const errors = [];
  let successfulFetches = 0;
  let attemptedFetches = 0;
  const uniqueRefs = new Map();
  for (const ref of refs) {
    const normalized = normalizePostReference(ref, userId);
    if (!uniqueRefs.has(normalized.postId)) uniqueRefs.set(normalized.postId, { ref, ...normalized });
  }
  for (const { ref, postId } of uniqueRefs.values()) {
    if (seen.has(postId)) {
      console.log(`skip existing ${ref}`);
      continue;
    }
    attemptedFetches += 1;
    try {
      const item = upgradeRecord(await fetchPageText(send, ref, userId));
      const nextItems = mergeById(items, [item]);
      writeOutputs(nextItems, outDir, userId, "ids");
      items = nextItems;
      seen.add(itemKey(item));
      successfulFetches += 1;
    } catch (error) {
      console.error(`skip ${ref}: ${error.message}`);
      errors.push({ ref, error: error.message, at: new Date().toISOString() });
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const errorsFile = path.join(outDir, `xueqiu_${userId}_ids_errors.json`);
  if (errors.length) {
    fs.mkdirSync(outDir, { recursive: true });
    atomicWrite(errorsFile, JSON.stringify(errors, null, 2));
  } else if (fs.existsSync(errorsFile)) {
    fs.rmSync(errorsFile);
  }
  return {
    items,
    errors,
    successfulFetches,
    attemptedFetches,
    exitCode: errors.length ? (successfulFetches > 0 ? 2 : 1) : 0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    allowed: [
      "help", "user_id", "mode", "pages", "count", "since-date", "resume",
      "output", "cdp", "delay", "post-ids", "post-ids-file",
    ],
    booleans: ["help", "resume"],
  });
  if (args.help) {
    console.log(`Usage: node scripts/xueqiu_browser_scraper.mjs [options]

Options:
  --user_id ID             Xueqiu user id
  --mode MODE              posts, articles, both, or ids
  --pages N                Maximum timeline pages
  --count N                Items per page
  --since-date YYYY-MM-DD  Historical boundary
  --resume                 Merge with an existing output file
  --output PATH            Output directory
  --cdp URL                CDP endpoint (default: http://127.0.0.1:9222)
  --help                   Show this help`);
    return;
  }
  const userId = validateUserId(args.user_id, "8469219487");
  const mode = args.mode || "posts";
  if (!["posts", "articles", "both", "ids"].includes(mode)) throw new Error("--mode must be posts, articles, both, or ids");
  const pages = parseIntegerOption(args.pages, { name: "--pages", defaultValue: 3, min: 1 });
  const count = parseIntegerOption(args.count, { name: "--count", defaultValue: 10, min: 1, max: 100 });
  const outDir = args.output || "./output";
  const delayMs = parseNumberOption(args.delay, { name: "--delay", defaultValue: 2, min: 0 }) * 1000;
  const cdpBase = args.cdp || "http://127.0.0.1:9222";
  args["since-date"] = validateDateOption(args["since-date"], "--since-date");

  const session = new CdpSession(cdpBase, { commandTimeoutMs: 18000 });
  try {
    await session.connect();
    const send = session.send.bind(session);
    if (mode === "ids") {
      const inlineRefs = String(args["post-ids"] || "").split(",").map(asciiTrim).filter(Boolean);
      const fileRefs = args["post-ids-file"]
        ? fs.readFileSync(args["post-ids-file"], "utf8").split(/\r?\n/).map(asciiTrim).filter(Boolean)
        : [];
      const refs = [...inlineRefs, ...fileRefs];
      if (!refs.length) throw new Error("--mode ids requires --post-ids");
      const idsResult = await runIdsMode(send, {
        refs,
        userId,
        outDir,
        resume: Boolean(args.resume),
        delayMs,
      });
      process.exitCode = idsResult.exitCode;
    } else {
      const timelineResult = await runTimelineMode(send, {
        userId,
        mode,
        pages,
        count,
        sinceDate: args["since-date"],
        delayMs,
        outDir,
        resume: Boolean(args.resume),
      });
      process.exitCode = timelineResult.exitCode;
      if (!timelineResult.written) {
        console.error("No fresh timeline records were returned; existing output was left unchanged.");
      }
      if (timelineResult.truncated) {
        console.error(`Timeline reached --pages=${pages} with a full final page; output requires verification.`);
      }
    }
  } finally {
    session.close();
  }
}

const scriptFile = fileURLToPath(import.meta.url);
if (path.resolve(process.argv[1] || "") === scriptFile) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
