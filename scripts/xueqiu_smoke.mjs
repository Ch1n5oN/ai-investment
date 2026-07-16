#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { validateLoopbackEndpoint } from "./lib/cdp_session.mjs";
import {
  parseArgs,
  parseIntegerOption,
  readJsonStrict,
  validateUserId,
} from "./lib/xueqiu_core.mjs";

const DEFAULT_USER_ID = "7143769715";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const EDGE_SCRIPT = path.join(SCRIPT_DIR, "xueqiu_edge_sync.mjs");
const REPORT_SCHEMA = JSON.parse(
  fs.readFileSync(path.join(ROOT, "schemas/sync-report.schema.json"), "utf8"),
);
const reportAjv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
});
addFormats(reportAjv);
const validateReportSchema = reportAjv.compile(REPORT_SCHEMA);

function smokeError(message, code) {
  return Object.assign(new Error(message), { code });
}

export function validateSmokeArgs(raw) {
  if (raw["confirm-live-xueqiu"] !== true) {
    throw smokeError(
      "Refusing live Xueqiu access without --confirm-live-xueqiu.",
      "LIVE_CONFIRMATION_REQUIRED",
    );
  }
  if (raw["confirm-dedicated-profile"] !== true) {
    throw smokeError(
      "Refusing CDP access without --confirm-dedicated-profile.",
      "DEDICATED_PROFILE_CONFIRMATION_REQUIRED",
    );
  }
  return {
    userId: validateUserId(raw.user_id, DEFAULT_USER_ID),
    cdp: validateLoopbackEndpoint(raw.cdp || "http://127.0.0.1:9222").origin,
    timeoutMs: parseIntegerOption(raw["timeout-ms"], {
      name: "--timeout-ms",
      defaultValue: 8000,
      min: 100,
      max: 60000,
    }),
    includeComments: raw["include-comments"] === true,
  };
}

export function buildSmokeInvocation(args, artifactRoot) {
  const root = path.resolve(artifactRoot);
  const postsDir = path.join(root, "posts");
  const commentsDir = path.join(root, "comments");
  const childArgs = [
    EDGE_SCRIPT,
    "--user_id", args.userId,
    "--cdp", args.cdp,
    "--posts-dir", postsDir,
    "--comments-dir", commentsDir,
    "--timeline-pages", "1",
    "--count", "5",
    "--timeout-ms", String(args.timeoutMs),
    "--command-timeout-ms", String(args.timeoutMs + 3000),
    "--delay-ms", "0",
    "--retry-delay-ms", "0",
    "--retries", "0",
  ];
  if (args.includeComments) {
    childArgs.push(
      "--force-comments",
      "--comment-posts", "1",
      "--comment-pages", "1",
      "--comment-count", "20",
    );
  } else {
    childArgs.push("--skip-comments");
  }
  return {
    command: process.execPath,
    args: childArgs,
    cwd: ROOT,
    artifactRoot: root,
    reportFile: path.join(commentsDir, `xueqiu_${args.userId}_edge_sync_report.json`),
    timeoutMs: Math.max(60000, args.timeoutMs * 8),
  };
}

export function smokeExitCode(report, childStatus) {
  const expectedChildStatus = {
    complete: 0,
    needs_verification: 2,
    failed: 1,
  }[report?.status];
  const drift = report?.interface_drift;
  if (expectedChildStatus === undefined || childStatus !== expectedChildStatus) return 1;
  if (!drift || drift.detected !== false || !Array.isArray(drift.signals) || drift.signals.length !== 0) {
    return 1;
  }
  return expectedChildStatus;
}

export function validateSmokeReport(report, expectedUserId) {
  if (!validateReportSchema(report)
      || report.user_id !== expectedUserId
      || report.status === "running") {
    throw smokeError("Smoke report does not satisfy the terminal report contract.", "INVALID_SMOKE_REPORT");
  }
  return report;
}

export function runSmoke(args, artifactRoot, spawnImpl = spawnSync) {
  const invocation = buildSmokeInvocation(args, artifactRoot);
  const child = spawnImpl(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    stdio: "inherit",
    timeout: invocation.timeoutMs,
  });
  if (child.error) throw smokeError(`Smoke child process failed: ${child.error.message}`, "SMOKE_PROCESS_FAILED");
  const report = readJsonStrict(invocation.reportFile, {
    defaultValue: null,
    validate: (value) => value && typeof value === "object" && !Array.isArray(value),
  });
  validateSmokeReport(report, args.userId);
  const exitCode = smokeExitCode(report, child.status);
  console.log(JSON.stringify({
    smoke_status: exitCode === 0 ? "passed" : exitCode === 2 ? "needs_verification" : "failed",
    report_status: report.status,
    interface_drift: report.interface_drift,
    metrics: report.metrics,
    artifact_root: invocation.artifactRoot,
  }, null, 2));
  return exitCode;
}

function help() {
  console.log(`Usage: node scripts/xueqiu_smoke.mjs [options]

Runs a bounded, manual Xueqiu contract smoke check through an existing dedicated
CDP browser. All generated data is confined to a new OS temporary directory.

Required confirmations:
  --confirm-live-xueqiu       Confirm intentional live Xueqiu access
  --confirm-dedicated-profile Confirm CDP uses a dedicated browser profile

Options:
  --user_id ID                Xueqiu user id (default: ${DEFAULT_USER_ID})
  --cdp URL                   Loopback-only CDP endpoint (default: http://127.0.0.1:9222)
  --timeout-ms N              Per-request timeout (default: 8000)
  --include-comments          Also probe one recent post's main comment stream
  --help                      Show this help

Exit codes: 0 passed, 2 usable but needs verification, 1 failed or drift detected.`);
}

function main() {
  const raw = parseArgs(process.argv.slice(2), {
    allowed: [
      "help", "confirm-live-xueqiu", "confirm-dedicated-profile",
      "include-comments", "user_id", "cdp", "timeout-ms",
    ],
    booleans: ["help", "confirm-live-xueqiu", "confirm-dedicated-profile", "include-comments"],
  });
  if (raw.help) {
    help();
    return;
  }
  try {
    const args = validateSmokeArgs(raw);
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-investment-xueqiu-smoke-"));
    fs.chmodSync(artifactRoot, 0o700);
    process.exitCode = runSmoke(args, artifactRoot);
  } catch (error) {
    console.error(`${error.code || "ERROR"}: ${error.message}`);
    process.exitCode = 1;
  }
}

const scriptFile = fileURLToPath(import.meta.url);
if (path.resolve(process.argv[1] || "") === scriptFile) main();
