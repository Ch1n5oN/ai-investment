import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSmokeInvocation,
  smokeExitCode,
  validateSmokeReport,
  validateSmokeArgs,
} from "../../scripts/xueqiu_smoke.mjs";

function terminalReport(overrides = {}) {
  return {
    schema_version: 1,
    user_id: "7143769715",
    started_at: "2026-07-16T10:00:00.000Z",
    finished_at: "2026-07-16T10:00:01.000Z",
    status: "complete",
    metrics: { requests: 1, errors: 0, waf: 0 },
    interface_drift: { detected: false, signals: [] },
    ...overrides,
  };
}

test("live smoke requires both explicit safety confirmations", () => {
  assert.throws(() => validateSmokeArgs({}), { code: "LIVE_CONFIRMATION_REQUIRED" });
  assert.throws(() => validateSmokeArgs({ "confirm-live-xueqiu": true }), {
    code: "DEDICATED_PROFILE_CONFIRMATION_REQUIRED",
  });
});

test("live smoke accepts only loopback CDP and builds temporary-output arguments", () => {
  assert.throws(() => validateSmokeArgs({
    "confirm-live-xueqiu": true,
    "confirm-dedicated-profile": true,
    cdp: "http://192.168.1.10:9222",
  }), { code: "NON_LOOPBACK_CDP_ENDPOINT" });

  const args = validateSmokeArgs({
    "confirm-live-xueqiu": true,
    "confirm-dedicated-profile": true,
    cdp: "http://localhost:9222",
  });
  const artifactRoot = path.join(os.tmpdir(), "bounded-smoke-test");
  const invocation = buildSmokeInvocation(args, artifactRoot);
  assert.equal(invocation.artifactRoot, artifactRoot);
  assert.ok(invocation.args.includes("--skip-comments"));
  assert.ok(invocation.args.includes(path.join(artifactRoot, "posts")));
  assert.ok(invocation.args.includes(path.join(artifactRoot, "comments")));
  assert.equal(invocation.args.includes("output/bingbing_xiaomei_sync_browser"), false);
});

test("comment smoke remains bounded to one recent post and one page", () => {
  const args = validateSmokeArgs({
    "confirm-live-xueqiu": true,
    "confirm-dedicated-profile": true,
    "include-comments": true,
  });
  const invocation = buildSmokeInvocation(args, path.join(os.tmpdir(), "comment-smoke-test"));
  const valueAfter = (flag) => invocation.args[invocation.args.indexOf(flag) + 1];
  assert.equal(valueAfter("--comment-posts"), "1");
  assert.equal(valueAfter("--comment-pages"), "1");
  assert.ok(invocation.args.includes("--force-comments"));
});

test("smoke exit status fails drift and preserves partial coverage semantics", () => {
  const clean = terminalReport();
  assert.equal(smokeExitCode(clean, 0), 0);
  assert.equal(smokeExitCode({ ...clean, status: "needs_verification" }, 2), 2);
  assert.equal(smokeExitCode({
    ...clean,
    interface_drift: { detected: true, signals: [{ code: "INVALID_JSON" }] },
  }, 2), 1);
  assert.equal(smokeExitCode(clean, null), 1);
  assert.equal(smokeExitCode(clean, 2), 1);
  assert.equal(smokeExitCode({ ...clean, status: "needs_verification" }, 0), 1);
  assert.equal(smokeExitCode({ ...clean, interface_drift: undefined }, 0), 1);
  assert.equal(smokeExitCode({
    ...clean,
    interface_drift: { detected: "false", signals: "none" },
  }, 0), 1);
});

test("smoke validates the complete terminal report schema before trusting its status", () => {
  const valid = terminalReport();
  assert.equal(validateSmokeReport(valid, valid.user_id), valid);

  const missingDrift = structuredClone(valid);
  delete missingDrift.interface_drift;
  assert.throws(() => validateSmokeReport(missingDrift, valid.user_id), {
    code: "INVALID_SMOKE_REPORT",
  });
  assert.throws(() => validateSmokeReport({
    ...valid,
    metrics: { requests: 1, errors: 0 },
  }, valid.user_id), { code: "INVALID_SMOKE_REPORT" });
  assert.throws(() => validateSmokeReport({
    ...valid,
    interface_drift: { detected: "false", signals: "none" },
  }, valid.user_id), { code: "INVALID_SMOKE_REPORT" });
  assert.throws(() => validateSmokeReport({ ...valid, schema_version: 2 }, valid.user_id), {
    code: "INVALID_SMOKE_REPORT",
  });
  assert.throws(() => validateSmokeReport({ ...valid, status: "running" }, valid.user_id), {
    code: "INVALID_SMOKE_REPORT",
  });
  assert.throws(() => validateSmokeReport(valid, "999"), {
    code: "INVALID_SMOKE_REPORT",
  });
});
