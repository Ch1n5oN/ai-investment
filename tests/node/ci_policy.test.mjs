import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(
  new URL("../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);

test("CI runs once per pull request and again only after changes reach main", () => {
  assert.match(
    workflow,
    /^on:\n  push:\n    branches:\n      - main\n  pull_request:\s*$/m,
  );
});

test("CI cancels superseded runs and bounds every job", () => {
  assert.match(
    workflow,
    /^concurrency:\n  group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\n  cancel-in-progress: true$/m,
  );
  assert.equal(
    [...workflow.matchAll(/^    timeout-minutes: 15$/gm)].length,
    2,
  );
});
