#!/usr/bin/env node
// Legacy one-off article recovery utility for pages that the API cannot expose.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  RECORD_CONTRACT,
  SCHEMA_VERSION,
  atomicWrite,
  asciiTrim,
  canonicalTarget,
  cleanHtml,
  formatTime,
  normalizeNonNegativeInteger,
  parseArgs,
  upgradeRecord,
  validateUserId,
} from "./lib/xueqiu_core.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "..");
const CHALLENGE_PATTERN = /_waf_|renderData|acw_tc|aliyun[_-]?waf|captcha|安全验证|访问验证|请完成验证|登录雪球|访问过于频繁/i;

function isInsidePath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function physicalPath(candidate) {
  let existing = path.resolve(candidate);
  const missingSegments = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missingSegments.unshift(path.basename(existing));
    existing = parent;
  }
  const resolvedExisting = fs.realpathSync(existing);
  return path.join(resolvedExisting, ...missingSegments);
}

export function assertOutsideRepository(
  candidate,
  repositoryRoot = REPOSITORY_ROOT,
  optionName = "--debug-dir",
) {
  if (!candidate) return "";
  const resolved = path.resolve(candidate);
  const physicalCandidate = physicalPath(resolved);
  const physicalRepository = physicalPath(repositoryRoot);
  if (isInsidePath(physicalCandidate, physicalRepository)) {
    throw Object.assign(new Error(`${optionName} must be outside the repository.`), {
      code: optionName === "--debug-dir" ? "UNSAFE_DEBUG_DIR" : "UNSAFE_USER_DATA_DIR",
    });
  }
  return resolved;
}

export function createUserDataDir(explicitDirectory = "") {
  if (explicitDirectory) {
    return {
      directory: assertOutsideRepository(explicitDirectory, REPOSITORY_ROOT, "--user-data-dir"),
      owned: false,
    };
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xueqiu-playwright-"));
  try {
    assertOutsideRepository(directory, REPOSITORY_ROOT, "temporary browser profile");
    return { directory, owned: true };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function cleanupUserDataDir(profile) {
  if (profile?.owned && profile.directory) {
    fs.rmSync(profile.directory, { recursive: true, force: true });
  }
}

export function isChallengePage({ title = "", bodyText = "", html = "" } = {}) {
  return CHALLENGE_PATTERN.test(`${title}\n${bodyText}\n${html}`);
}

function normalizeId(value, name) {
  const id = asciiTrim(value ?? "");
  if (!/^\d+$/.test(id)) {
    throw Object.assign(new Error(`${name} must contain digits only.`), { code: "INVALID_RECORD" });
  }
  return id;
}

export function parsePostReference(ref, defaultUserId) {
  const value = asciiTrim(ref || "");
  if (/^\d+$/.test(value)) return { userId: normalizeId(defaultUserId, "user id"), postId: value };
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

function cookieHeaderToCookies(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      if (index < 0) return null;
      return {
        name: part.slice(0, index),
        value: part.slice(index + 1),
        domain: ".xueqiu.com",
        path: "/",
        httpOnly: false,
        secure: true,
        sameSite: "Lax",
      };
    })
    .filter(Boolean);
}

function requiredStatusField(status, aliases, label, { allowNull = false } = {}) {
  for (const alias of aliases) {
    if (Object.hasOwn(status, alias)
      && status[alias] !== undefined
      && (allowNull || status[alias] !== null)) {
      return status[alias];
    }
  }
  throw Object.assign(new Error(`${label} is missing ${aliases.join("/")}.`), {
    code: "INVALID_RECORD",
  });
}

export function normalizeStatus(status, fallbackUrl, expectedPostId, { allowSparseDom = false } = {}) {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw Object.assign(new Error("Extracted status must be an object."), { code: "INVALID_RECORD" });
  }
  const id = normalizeId(status.id, "status.id");
  if (id !== normalizeId(expectedPostId, "expected post id")) {
    throw Object.assign(new Error(`Extracted status ${id} does not match requested post ${expectedPostId}.`), {
      code: "INVALID_RECORD",
    });
  }
  const text = status.text ?? status.description;
  if (typeof text !== "string" || !cleanHtml(text)) {
    throw Object.assign(new Error("Extracted status is missing a non-empty text body."), {
      code: "INVALID_RECORD",
    });
  }
  const target = status.target
    ? (String(status.target).startsWith("http") ? status.target : `https://xueqiu.com${status.target}`)
    : fallbackUrl;
  const createdAt = allowSparseDom
    ? status.created_at ?? null
    : requiredStatusField(status, ["created_at"], "status timestamp", { allowNull: true });
  const count = (aliases, label) => requiredStatusField(status, aliases, label);
  return upgradeRecord({
    schema_version: SCHEMA_VERSION,
    record_contract: RECORD_CONTRACT,
    id,
    created_at_raw: createdAt,
    created_at: formatTime(createdAt),
    title: cleanHtml(status.rawTitle || status.title || ""),
    text,
    clean_text: cleanHtml(text),
    target: canonicalTarget(target),
    reply_count: normalizeNonNegativeInteger(count(["reply_count", "replyCount"], "status reply count"), "reply_count"),
    like_count: normalizeNonNegativeInteger(count(["like_count", "likeCount"], "status like count"), "like_count"),
    retweet_count: normalizeNonNegativeInteger(count(["retweet_count", "retweetCount"], "status retweet count"), "retweet_count"),
    view_count: normalizeNonNegativeInteger(count(["view_count", "viewCount"], "status view count"), "view_count"),
    source: "playwright",
  });
}

async function writeDebugArtifacts(page, debugDir, postId) {
  if (!debugDir) return;
  fs.mkdirSync(debugDir, { recursive: true });
  await page.screenshot({ path: path.join(debugDir, `${postId}.png`), fullPage: true }).catch(() => {});
  atomicWrite(path.join(debugDir, `${postId}.html`), await page.content());
}

export async function fetchFromBrowser(page, userId, postId, debugDir = "") {
  const url = `https://xueqiu.com/${userId}/${postId}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);

  let challenge = null;
  for (let i = 0; i < 3; i += 1) {
    const title = await page.title().catch(() => "");
    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    challenge = { title, bodyText };
    if (!isChallengePage(challenge)) break;
    await solveAliyunSlider(page).catch(() => {});
    await page.waitForTimeout(3000);
  }
  challenge = {
    title: await page.title().catch(() => ""),
    bodyText: await page.locator("body").innerText({ timeout: 5000 }).catch(() => ""),
  };
  if (isChallengePage(challenge)) {
    await writeDebugArtifacts(page, debugDir, postId);
    throw Object.assign(new Error(`WAF or login challenge remained for ${postId}.`), { code: "WAF" });
  }

  const result = await page.evaluate(async ({ postId, url }) => {
    async function getJson(fetchUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(fetchUrl, {
          credentials: "include",
          signal: controller.signal,
          headers: {
            "Accept": "application/json,text/plain,*/*",
            "X-Requested-With": "XMLHttpRequest",
          },
        });
        return { status: response.status, text: await response.text() };
      } finally {
        clearTimeout(timer);
      }
    }

    const apiCandidates = [
      `https://xueqiu.com/statuses/show.json?id=${postId}`,
      `https://xueqiu.com/statuses/show.json?source=user&id=${postId}`,
      `https://xueqiu.com/statuses/show.json?source=timeline&id=${postId}`,
    ];
    for (const apiUrl of apiCandidates) {
      try {
        const payload = await getJson(apiUrl);
        if (payload.status === 200 && payload.text.trim().startsWith("{")) {
          const parsed = JSON.parse(payload.text);
          if (parsed && !parsed.error_code && (parsed.text || parsed.description || parsed.title)) {
            return { kind: "status", status: parsed, apiUrl };
          }
        }
      } catch {}
    }

    const scriptText = document.documentElement.innerHTML.match(/window\.SNOWMAN_STATUS\s*=\s*(\{[\s\S]*?\});\s*\n/)?.[1];
    if (scriptText) {
      try {
        return { kind: "status", status: JSON.parse(scriptText), apiUrl: "window.SNOWMAN_STATUS" };
      } catch {}
    }

    const challengePattern = /_waf_|renderData|acw_tc|aliyun[_-]?waf|captcha|安全验证|访问验证|请完成验证|登录雪球|访问过于频繁/i;
    if (challengePattern.test(`${document.title}\n${document.body?.innerText || ""}`)) {
      return { kind: "failed", reason: "challenge", html: document.documentElement.innerHTML.slice(0, 2000) };
    }

    const selectors = [
      ".article__bd__detail",
      ".article__bd",
      ".status-detail",
      ".status-content",
      "article",
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const text = element?.innerText?.trim();
      if (text && text.length > 200 && !challengePattern.test(text)) {
        return {
          kind: "dom",
          status: {
            id: postId,
            created_at: document.querySelector("time[datetime]")?.getAttribute("datetime") || null,
            rawTitle: document.querySelector("h1")?.innerText || document.title || "",
            text,
            target: url,
          },
          apiUrl: selector,
        };
      }
    }
    return { kind: "failed", html: document.documentElement.innerHTML.slice(0, 2000) };
  }, { postId, url });

  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw Object.assign(new Error(`Invalid extraction result for ${postId}.`), { code: "INVALID_RECORD" });
  }
  if (result.kind === "failed") {
    await writeDebugArtifacts(page, debugDir, postId);
    throw Object.assign(
      new Error(`unable to extract ${postId}: ${String(result.html || "").slice(0, 200)}`),
      { code: result.reason === "challenge" ? "WAF" : "INVALID_RESPONSE_SHAPE" },
    );
  }
  if (!["status", "dom"].includes(result.kind)) {
    throw Object.assign(new Error(`Unexpected extraction result for ${postId}.`), { code: "INVALID_RECORD" });
  }
  const item = normalizeStatus(result.status, url, postId, { allowSparseDom: result.kind === "dom" });
  item.fetch_method = result.apiUrl;
  return item;
}

async function solveAliyunSlider(page) {
  const slider = page.locator("#aliyunCaptcha-sliding-slider");
  const body = page.locator("#aliyunCaptcha-sliding-body");
  const sliderBox = await slider.boundingBox({ timeout: 3000 }).catch(() => null);
  const bodyBox = await body.boundingBox({ timeout: 3000 }).catch(() => null);
  if (!sliderBox || !bodyBox) return false;
  console.log(`captcha slider box ${JSON.stringify(sliderBox)} body ${JSON.stringify(bodyBox)}`);

  const startX = sliderBox.x + sliderBox.width / 2;
  const startY = sliderBox.y + sliderBox.height / 2;
  const endX = bodyBox.x + bodyBox.width - sliderBox.width / 2 - 2;

  await page.mouse.move(startX, startY, { steps: 8 });
  await page.mouse.down();
  const distance = endX - startX;
  for (let i = 1; i <= 36; i += 1) {
    const t = i / 36;
    const ease = 1 - Math.pow(1 - t, 3);
    const jitterY = Math.sin(i / 2) * 1.5;
    await page.mouse.move(startX + distance * ease, startY + jitterY, { steps: 1 });
    await page.waitForTimeout(12 + (i % 5) * 4);
  }
  await page.waitForTimeout(180);
  await page.mouse.up();
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  const left = await slider.evaluate((node) => getComputedStyle(node).left).catch(() => "");
  const text = await page.locator("#aliyunCaptcha-sliding-text").innerText({ timeout: 1000 }).catch(() => "");
  console.log(`captcha after drag left=${left} text=${text}`);
  return true;
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
      `Fetch method: ${item.fetch_method || item.source || ""}`,
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

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    allowed: [
      "help", "cookie-file", "post-ids", "user_id", "output", "suffix", "headless",
      "user-data-dir", "debug-dir", "channel",
    ],
    booleans: ["help"],
  });
  if (args.help) {
    console.log(`Usage: node scripts/xueqiu_playwright_article_fetch.mjs [options]

Legacy one-off article recovery utility.

Required:
  --cookie-file PATH        Owner-only cookie file (chmod 600)
  --post-ids IDS            Comma-separated post IDs or URLs

Optional:
  --user_id ID              Default Xueqiu user id
  --output PATH             Output directory
  --headless false          Show the recovery browser
  --user-data-dir PATH     Reuse a dedicated browser profile outside Git
  --debug-dir PATH          Store failure HTML/screenshots outside Git
  --help                    Show this help`);
    return;
  }
  const cookieFile = args["cookie-file"];
  if (!cookieFile) throw new Error("--cookie-file is required");
  const userId = validateUserId(args.user_id, "7143769715");
  const refs = String(args["post-ids"] || "").split(",").map(asciiTrim).filter(Boolean);
  if (!refs.length) throw new Error("--post-ids is required");
  const outDir = args.output || "./output/xueqiu_playwright_articles";
  const suffix = args.suffix || "playwright_articles";
  const headless = args.headless !== "false";
  const cookieMode = fs.statSync(cookieFile).mode & 0o777;
  if (process.platform !== "win32" && (cookieMode & 0o077) !== 0) {
    throw new Error(`Cookie file must be readable only by its owner (run: chmod 600 ${cookieFile})`);
  }
  const cookieHeader = fs.readFileSync(cookieFile, "utf8").trim();
  const cookies = cookieHeaderToCookies(cookieHeader);
  if (!cookies.length) throw new Error("Cookie file did not contain any valid cookies.");
  const debugDir = assertOutsideRepository(args["debug-dir"] || "");
  const profile = createUserDataDir(args["user-data-dir"] || "");

  let context;
  try {
    context = await chromium.launchPersistentContext(profile.directory, {
      headless,
      channel: args.channel || "chrome",
      viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    });
    await context.addCookies(cookies);
    const page = context.pages()[0] || await context.newPage();
    const items = [];
    const uniqueRefs = new Map();
    for (const ref of refs) {
      const normalized = parsePostReference(ref, userId);
      if (!uniqueRefs.has(normalized.postId)) uniqueRefs.set(normalized.postId, normalized);
    }
    for (const { userId: refUserId, postId } of uniqueRefs.values()) {
      console.log(`fetch ${refUserId}/${postId}`);
      const item = await fetchFromBrowser(page, refUserId, postId, debugDir);
      items.push(item);
      writeOutputs(items, outDir, userId, suffix);
      await page.waitForTimeout(1500);
    }
  } finally {
    await context?.close().catch(() => {});
    cleanupUserDataDir(profile);
  }
}

const scriptFile = fileURLToPath(import.meta.url);
if (path.resolve(process.argv[1] || "") === scriptFile) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
