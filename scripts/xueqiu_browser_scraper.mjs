#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function cleanHtml(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatTime(value) {
  if (!value) return "unknown";
  if (typeof value === "number") {
    const ms = value > 1000000000000 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? "unknown" : d.toISOString().slice(0, 19).replace("T", " ");
  }
  return String(value);
}

function sinceOk(item, sinceDate) {
  if (!sinceDate) return true;
  const created = typeof item.created_at === "number" ? item.created_at : Date.parse(item.created_at);
  return !created || created >= Date.parse(`${sinceDate}T00:00:00+08:00`);
}

async function connect(cdpBase) {
  const tabs = await (await fetch(`${cdpBase}/json/list`)).json();
  const tab = tabs.find((t) => t.url.includes("xueqiu.com")) || tabs[0];
  if (!tab?.webSocketDebuggerUrl) throw new Error("No Chrome tab with DevTools websocket found.");

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  function send(method, params = {}) {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  await send("Runtime.enable");
  return { ws, send };
}

async function browserFetch(send, url, asJson = true) {
  const fetchExpression = `
    fetch(${JSON.stringify(url)}, {
      credentials: "include",
      headers: {"X-Requested-With": "XMLHttpRequest", "Accept": ${JSON.stringify(asJson ? "application/json" : "text/html,*/*")}}
    }).then(async r => ({status: r.status, text: await r.text()}))
  `;
  const expression = `Promise.race([(${fetchExpression}), new Promise((_, reject) => setTimeout(() => reject(new Error("fetch timeout")), 15000))])`;
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "fetch failed");
  }
  const payload = result.result.value;
  if (payload.status !== 200) throw new Error(`HTTP ${payload.status} for ${url}: ${payload.text.slice(0, 160)}`);
  if (!asJson) return payload.text;
  try {
    return JSON.parse(payload.text);
  } catch {
    throw new Error(`Non-JSON response for ${url}: ${payload.text.slice(0, 160)}`);
  }
}

function normalizeStatus(status) {
  return {
    id: status.id,
    created_at: formatTime(status.created_at),
    title: cleanHtml(status.title || ""),
    text: status.text || status.description || "",
    clean_text: cleanHtml(status.text || status.description || ""),
    target: status.target ? `https://xueqiu.com${status.target}` : "",
    reply_count: status.reply_count || 0,
    like_count: status.like_count || status.likeCount || 0,
    retweet_count: status.retweet_count || status.retweetCount || 0,
    view_count: status.view_count || 0,
  };
}

async function fetchTimeline(send, userId, mode, pages, count, sinceDate, delayMs) {
  const items = [];
  const endpoint = mode === "articles"
    ? "https://xueqiu.com/statuses/original/timeline.json"
    : "https://xueqiu.com/v4/statuses/user_timeline.json";

  for (let page = 1; page <= pages; page += 1) {
    const url = `${endpoint}?user_id=${encodeURIComponent(userId)}&page=${page}&count=${count}${mode === "posts" ? "&type=0" : ""}`;
    console.log(`fetch ${mode} page ${page}: ${url}`);
    const data = await browserFetch(send, url, true);
    const raw = data.statuses || data.list || data.items || [];
    const normalized = raw.map(normalizeStatus).filter((item) => sinceOk(item, sinceDate));
    if (!normalized.length) {
      console.log(`stop: no ${sinceDate ? "matching " : ""}items on page ${page}`);
      break;
    }
    items.push(...normalized);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return items;
}

async function fetchPageText(send, ref, defaultUserId) {
  const match = ref.match(/xueqiu\.com\/(\d+)\/(\d+)/);
  const userId = match ? match[1] : defaultUserId;
  const postId = match ? match[2] : ref.replace(/^.*\//, "");
  const url = `https://xueqiu.com/${userId}/${postId}`;
  console.log(`fetch page ${url}`);
  try {
    const status = await browserFetch(send, `https://xueqiu.com/statuses/show.json?id=${postId}`, true);
    return normalizeStatus(status);
  } catch (error) {
    console.error(`status API failed for ${postId}: ${error.message}; fallback to page HTML`);
  }
  const expression = `
    fetch(${JSON.stringify(url)}, {credentials: "include"})
      .then(r => r.text())
      .then(html => {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const scriptText = html.match(/window\\.SNOWMAN_STATUS\\s*=\\s*(\\{[\\s\\S]*?\\});\\s*\\n/)?.[1];
        if (scriptText) {
          try {
            const status = JSON.parse(scriptText);
            return {
              id: status.id,
              created_at: status.created_at,
              title: status.rawTitle || status.title || "",
              text: status.text || status.description || "",
              target: status.target || "",
              reply_count: status.reply_count || 0,
              like_count: status.like_count || 0,
              retweet_count: status.retweet_count || 0,
              view_count: status.view_count || 0
            };
          } catch {}
        }
        return {title: doc.querySelector("h1")?.innerText || "", text: doc.body?.innerText || ""};
      })
  `;
  const result = await send("Runtime.evaluate", { expression: `Promise.race([(${expression}), new Promise((_, reject) => setTimeout(() => reject(new Error("page fetch timeout")), 15000))])`, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "page fetch failed");
  }
  const value = result.result.value || {};
  return {
    id: value.id || postId,
    created_at: formatTime(value.created_at),
    title: cleanHtml(value.title || ""),
    text: value.text || "",
    clean_text: cleanHtml(value.text || ""),
    target: value.target ? `https://xueqiu.com${value.target}` : url,
    reply_count: value.reply_count || 0,
    like_count: value.like_count || 0,
    retweet_count: value.retweet_count || 0,
    view_count: value.view_count || 0,
  };
}

function writeOutputs(items, outDir, userId, suffix) {
  fs.mkdirSync(outDir, { recursive: true });
  const jsonFile = path.join(outDir, `xueqiu_${userId}_${suffix}.json`);
  const mdFile = path.join(outDir, `xueqiu_${userId}_${suffix}.md`);
  fs.writeFileSync(jsonFile, JSON.stringify(items, null, 2), "utf8");
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
  fs.writeFileSync(mdFile, md, "utf8");
  console.log(`saved ${items.length} items to ${jsonFile}`);
  console.log(`saved markdown to ${mdFile}`);
}

function readExisting(outDir, userId, suffix) {
  const jsonFile = path.join(outDir, `xueqiu_${userId}_${suffix}.json`);
  if (!fs.existsSync(jsonFile)) return [];
  try {
    const items = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function itemKey(item) {
  return String(item.id || item.target || "");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userId = args.user_id || "8469219487";
  const mode = args.mode || "posts";
  const pages = Number(args.pages || 3);
  const count = Number(args.count || 10);
  const outDir = args.output || "./output";
  const delayMs = Number(args.delay || 2) * 1000;
  const cdpBase = args.cdp || "http://127.0.0.1:9222";

  const { ws, send } = await connect(cdpBase);
  try {
    let items = [];
    if (mode === "both") {
      items = [
        ...(await fetchTimeline(send, userId, "posts", pages, count, args["since-date"], delayMs)),
        ...(await fetchTimeline(send, userId, "articles", pages, count, args["since-date"], delayMs)),
      ];
    } else if (mode === "ids") {
      const inlineRefs = String(args["post-ids"] || "").split(",").map((s) => s.trim()).filter(Boolean);
      const fileRefs = args["post-ids-file"]
        ? fs.readFileSync(args["post-ids-file"], "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        : [];
      const refs = [...inlineRefs, ...fileRefs];
      if (!refs.length) throw new Error("--mode ids requires --post-ids");
      items = args.resume ? readExisting(outDir, userId, mode) : [];
      const seen = new Set(items.map(itemKey));
      const errors = [];
      for (const ref of refs) {
        const id = ref.match(/\/(\d+)$/)?.[1] || ref;
        if (seen.has(id)) {
          console.log(`skip existing ${ref}`);
          continue;
        }
        try {
          const item = await fetchPageText(send, ref, userId);
          items.push(item);
          seen.add(itemKey(item));
          writeOutputs(items, outDir, userId, mode);
        } catch (error) {
          console.error(`skip ${ref}: ${error.message}`);
          errors.push({ ref, error: error.message, at: new Date().toISOString() });
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (errors.length) {
        fs.writeFileSync(path.join(outDir, `xueqiu_${userId}_${mode}_errors.json`), JSON.stringify(errors, null, 2), "utf8");
      }
    } else {
      items = await fetchTimeline(send, userId, mode, pages, count, args["since-date"], delayMs);
    }
    writeOutputs(items, outDir, userId, mode);
  } finally {
    ws.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
