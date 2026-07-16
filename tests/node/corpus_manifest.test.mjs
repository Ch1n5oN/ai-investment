import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  archivedRecordArrays,
  atomicWrite,
  declaredSegments,
  manifestFile,
  metadataFor,
  normalizeCorpusRecord,
  validatePodcastEvidence,
  validateCorpusManifest,
  validateRecordArrayInventory,
} from "../../.claude/skills/bingbing-xiaomei-perspective/scripts/build_corpus_manifest.mjs";
import {
  buildManifest as buildDonggeManifest,
  skillDir as donggeSkillDir,
  validateRecordArrayInventory as validateDonggeInventory,
} from "../../.claude/skills/dongge-perspective/scripts/build_corpus_manifest.mjs";

function loadManifest() {
  return JSON.parse(fs.readFileSync(manifestFile, "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

test("manifest validation rejects deleted, added, and changed segment descriptors", () => {
  const manifest = loadManifest();

  const extraRoot = clone(manifest);
  extraRoot.untracked_claim = true;
  assert.throws(() => validateCorpusManifest(extraRoot), /fields must be exactly/);

  const naiveGeneratedAt = clone(manifest);
  naiveGeneratedAt.generated_at = "2026-07-15 14:36:54";
  assert.throws(() => validateCorpusManifest(naiveGeneratedAt), /timezone-aware ISO timestamp/);

  const deleted = clone(manifest);
  deleted.segments.pop();
  assert.throws(() => validateCorpusManifest(deleted), /segment descriptor set/);

  const added = clone(manifest);
  added.segments.push(clone(added.segments[0]));
  assert.throws(() => validateCorpusManifest(added), /segment descriptor set/);

  const changed = clone(manifest);
  changed.segments[0].origin = "output/unexpected.json";
  assert.throws(() => validateCorpusManifest(changed), /descriptor origin/);

  const weakened = clone(manifest);
  delete weakened.segments[0].contract;
  assert.throws(() => validateCorpusManifest(weakened), /descriptor contract/);

  const changedArchive = clone(manifest);
  changedArchive.archived_record_arrays[0].counted_in_claims = true;
  assert.throws(() => validateCorpusManifest(changedArchive), /archive descriptor counted_in_claims/);
});

test("every record array is either canonical or an explicitly excluded archive", () => {
  const inventory = validateRecordArrayInventory();
  assert.equal(inventory.length, declaredSegments.length + archivedRecordArrays.length);

  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaomei-array-inventory-"));
  try {
    fs.cpSync(path.join(path.dirname(manifestFile), ".."), path.join(baseDir, "references"), {
      recursive: true,
    });
    assert.deepEqual(validateRecordArrayInventory({ baseDir }), inventory);
    atomicWrite(path.join(baseDir, "references", "research", "orphan.json"), "[]\n");
    assert.throws(
      () => validateRecordArrayInventory({ baseDir }),
      /undeclared=\[references\/research\/orphan\.json\]/,
    );
    fs.rmSync(path.join(baseDir, "references", "research", "orphan.json"));
    fs.rmSync(path.join(baseDir, declaredSegments[0].path));
    assert.throws(
      () => validateRecordArrayInventory({ baseDir }),
      /missing=\[/,
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("Dongge record arrays cannot bypass its canonical/raw archive inventory", () => {
  assert.equal(validateDonggeInventory().length, 2);
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "dongge-array-inventory-"));
  try {
    fs.cpSync(path.join(donggeSkillDir, "references"), path.join(baseDir, "references"), {
      recursive: true,
    });
    atomicWrite(path.join(baseDir, "references", "research", "orphan.json"), "[]\n");
    assert.throws(
      () => validateDonggeInventory({ baseDir }),
      /undeclared=\[references\/research\/orphan\.json\]/,
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("Dongge raw archive cannot retain credential-like fields", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "dongge-raw-safety-"));
  try {
    fs.cpSync(path.join(donggeSkillDir, "references"), path.join(baseDir, "references"), {
      recursive: true,
    });
    const rawPath = path.join(
      baseDir,
      "references/research/07-latest-posts-2026-04-28.json",
    );
    const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
    raw[0].cookie = "must not be tracked";
    atomicWrite(rawPath, `${JSON.stringify(raw, null, 2)}\n`);
    assert.throws(() => buildDonggeManifest({ baseDir }), /forbidden in a tracked raw snapshot/);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("manifest validation rejects weakened declared evidence and limitations", () => {
  const manifest = loadManifest();
  const mutations = [
    ["podcast count", (value) => { value.declared_sources[0].count = 1; }],
    ["podcast episodes", (value) => { value.declared_sources[0].episodes = []; }],
    ["escaping evidence", (value) => { value.declared_sources[0].evidence = "../../outside.md"; }],
    ["removed limitation", (value) => { value.limitations.pop(); }],
  ];
  for (const [name, mutate] of mutations) {
    const changed = clone(manifest);
    mutate(changed);
    assert.throws(
      () => validateCorpusManifest(changed),
      /must exactly match the corpus builder declaration/,
      `${name} tampering should fail closed`,
    );
  }
});

test("record normalization is idempotent and enforces canonical corpus types", () => {
  const raw = {
    id: 123,
    created_at: "2026-07-14 09:08:07",
    target: "/7143769715/123",
    reply_count: "4",
    post_id: 456,
    post_created_at: "2026-07-14 08:00:00",
    in_reply_to_comment_id: null,
  };
  const normalized = normalizeCorpusRecord(raw);

  assert.deepEqual(normalized, {
    schema_version: 1,
    record_contract: "normalized_v1",
    id: "123",
    created_at_raw: "2026-07-14 09:08:07",
    created_at: "2026-07-14T09:08:07+08:00",
    target: "https://xueqiu.com/7143769715/123",
    reply_count: 4,
    post_id: "456",
    post_created_at_raw: "2026-07-14 08:00:00",
    post_created_at: "2026-07-14T08:00:00+08:00",
    in_reply_to_comment_id: null,
  });
  assert.deepEqual(normalizeCorpusRecord(normalized), normalized);

  const unknown = normalizeCorpusRecord({ id: "124", created_at: "unknown", target: "/7143769715/124" });
  assert.equal(unknown.created_at_raw, "unknown");
  assert.equal(unknown.created_at, "unknown");
  assert.equal("created_at_is_unknown" in unknown, false);
  assert.throws(
    () => normalizeCorpusRecord({ ...raw, record_contract: "legacy_normalized_v1" }),
    /record_contract/,
  );
  assert.throws(() => normalizeCorpusRecord({ ...raw, reply_count: true }), /non-negative integer/);
  assert.throws(() => normalizeCorpusRecord({ ...raw, reply_count: "" }), /non-negative integer/);
  assert.throws(
    () => normalizeCorpusRecord({ ...raw, created_at: "2026-07-14" }),
    /explicit time of day/,
  );
});

test("metadataFor fails closed on every normalized record-contract violation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xiaomei-corpus-contract-"));
  const file = path.join(directory, "segment.json");
  const descriptor = { path: "segment.json", kind: "timeline", stage: "test" };
  const valid = normalizeCorpusRecord({
    id: "123",
    created_at: "2026-07-14 09:08:07",
    target: "/7143769715/123",
    text: "observed text",
    clean_text: "observed text",
    reply_count: 4,
    like_count: 3,
    retweet_count: 2,
    view_count: 1,
    status_id: "456",
  });

  try {
    atomicWrite(file, `${JSON.stringify([valid], null, 2)}\n`);
    assert.equal(metadataFor(descriptor, { baseDir: directory }).records, 1);
    assert.deepEqual(fs.readdirSync(directory), ["segment.json"]);

    atomicWrite(file, "[]\n");
    assert.throws(() => metadataFor(descriptor, { baseDir: directory }), /must not be empty/);

    const unknown = normalizeCorpusRecord({
      id: "124",
      created_at: "unknown",
      target: "/7143769715/124",
      text: "observed text",
      clean_text: "observed text",
      reply_count: 0,
      like_count: 0,
      retweet_count: 0,
      view_count: 0,
    });
    atomicWrite(file, `${JSON.stringify([unknown], null, 2)}\n`);
    assert.equal(metadataFor(descriptor, { baseDir: directory }).records, 1);
    const unknownWithInventedTime = clone(unknown);
    unknownWithInventedTime.created_at = "2026-07-14T09:08:07+08:00";
    atomicWrite(file, `${JSON.stringify([unknownWithInventedTime], null, 2)}\n`);
    assert.throws(() => metadataFor(descriptor, { baseDir: directory }), /must remain "unknown"/);
    const observedWithUnknownTime = clone(valid);
    observedWithUnknownTime.created_at = "unknown";
    atomicWrite(file, `${JSON.stringify([observedWithUnknownTime], null, 2)}\n`);
    assert.throws(() => metadataFor(descriptor, { baseDir: directory }), /may only be "unknown"/);

    const violations = [
      ["schema", (record) => { record.schema_version = 2; }, /schema_version/],
      ["record ID", (record) => { record.id = 123; }, /digit-only string ID/],
      ["raw time", (record) => { delete record.created_at_raw; }, /created_at_raw/],
      ["normalized time", (record) => { delete record.created_at; }, /created_at is required/],
      ["aware time", (record) => { record.created_at = "2026-07-14 09:08:07"; }, /Asia\/Shanghai/],
      ["raw time mismatch", (record) => { record.created_at_raw = "2026-07-14 09:08:08"; }, /preserved created_at_raw/],
      ["known ID", (record) => { record.status_id = 456; }, /string ID/],
      ["unknown normalized field", (record) => { record.cookie = "secret"; }, /not allowed/],
      ["optional string type", (record) => { record.mode = 1; }, /mode must be a string/],
      ["unsafe created_ms", (record) => { record.created_ms = 9007199254740992; }, /created_ms must be a safe integer/],
      ["invalid fetched page", (record) => { record.fetched_from_page = 0; }, /fetched_from_page must be a safe integer/],
      ["invalid user id", (record) => { record.user_id = null; }, /user_id must be a digit-only string/],
      ["invalid legacy metadata", (record) => { record.legacy_migrated_fields = ["x", "x"]; }, /unique non-empty strings/],
      ["one-sided post time", (record) => { record.post_created_at_raw = null; }, /must be preserved together/],
      ["derived text mismatch", (record) => { record.clean_text = "tampered"; }, /deterministic text normalizer/],
      ["post relationship", (record) => { record.post_id = "456"; }, /not valid for a post/],
      ["canonical URL", (record) => { record.target = "/7143769715/123"; }, /canonical URL/],
      ["external URL", (record) => { record.target = "https://example.com/123"; }, /Xueqiu HTTPS URL/],
      ["missing URL", (record) => { delete record.target; }, /include a canonical Xueqiu URL/],
      ["URL ID mismatch", (record) => { record.target = "https://xueqiu.com/7143769715/999"; }, /subject 7143769715.*related ID 123/],
      ["URL subject mismatch", (record) => { record.target = "https://xueqiu.com/999999/123"; }, /subject 7143769715/],
      ["integer count", (record) => { record.reply_count = "4"; }, /integer/],
      ["missing strict count", (record) => { delete record.like_count; }, /like_count.*required/],
      ["missing view count", (record) => { delete record.view_count; }, /view_count.*required/],
      ["missing strict content", (record) => {
        record.text = "";
        record.clean_text = "";
      }, /must contain title, text, or clean_text/],
    ];

    for (const [name, mutate, expected] of violations) {
      const invalid = clone(valid);
      mutate(invalid);
      atomicWrite(file, `${JSON.stringify([invalid], null, 2)}\n`);
      assert.throws(
        () => metadataFor(descriptor, { baseDir: directory }),
        expected,
        `${name} violation should fail closed`,
      );
    }

    const replyShaped = normalizeCorpusRecord({
      id: "789",
      created_at: "2026-07-14 09:08:07",
      post_id: "123",
      post_target: "/7143769715/123",
      text: "reply",
      clean_text: "reply",
      reply_count: 0,
      like_count: 0,
    });
    replyShaped.target = "https://xueqiu.com/7143769715/789";
    atomicWrite(file, `${JSON.stringify([replyShaped], null, 2)}\n`);
    assert.throws(
      () => metadataFor({ path: "segment.json", kind: "replies", stage: "test" }, { baseDir: directory }),
      /not valid for a reply/,
    );
    delete replyShaped.target;
    replyShaped.status_id = "999";
    atomicWrite(file, `${JSON.stringify([replyShaped], null, 2)}\n`);
    assert.throws(
      () => metadataFor({ path: "segment.json", kind: "replies", stage: "test" }, { baseDir: directory }),
      /status_id must identify post_id/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy contracts are explicit and narrowly preserve known historical gaps", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xiaomei-corpus-legacy-"));
  const file = path.join(directory, "segment.json");
  const legacy = normalizeCorpusRecord({
    id: "123",
    created_at: "2026-06-20 09:08:07",
    target: "/7143769715/123",
    clean_text: "",
    reply_count: 0,
    like_count: 0,
    retweet_count: 0,
  }, "legacy fixture", { contract: "legacy_normalized_v1" });
  try {
    atomicWrite(file, `${JSON.stringify([legacy], null, 2)}\n`);
    assert.throws(
      () => metadataFor({ path: "segment.json", kind: "timeline", stage: "test" }, { baseDir: directory }),
      /record_contract/,
    );
    assert.throws(() => metadataFor({
      path: "segment.json",
      kind: "timeline",
      stage: "baseline",
      contract: "legacy_normalized_v1",
    }, { baseDir: directory }), /strict segment contract/);
    assert.equal(metadataFor(declaredSegments[0]).records, 1285);
    const conflictingReply = normalizeCorpusRecord({
      id: "456",
      created_at: "2026-06-20 09:08:07",
      post_id: "123",
      post_target: "/7143769715/123",
      post_link: "/7143769715/999",
      text: "reply",
      clean_text: "reply",
      like_count: 0,
    }, "legacy reply fixture", { contract: "legacy_normalized_v1" });
    atomicWrite(file, `${JSON.stringify([conflictingReply], null, 2)}\n`);
    assert.throws(() => metadataFor({
      path: "segment.json",
      kind: "replies",
      stage: "baseline",
      contract: "legacy_normalized_v1",
    }, { baseDir: directory }), /conflicting post_target and post_link/);
    assert.throws(() => metadataFor({
      path: "segment.json",
      kind: "timeline",
      stage: "baseline",
      contract: "anything_goes",
    }, { baseDir: directory }), /unsupported record contract/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("view-count and framework-owner exceptions stay explicit and narrow", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xiaomei-corpus-exceptions-"));
  const file = path.join(directory, "segment.json");
  const counts = { reply_count: 0, like_count: 0, retweet_count: 0 };
  try {
    const withoutView = normalizeCorpusRecord({
      id: "123",
      created_at: "2026-06-29 09:08:07",
      target: "/7143769715/123",
      text: "observed text",
      clean_text: "observed text",
      ...counts,
    }, "no-view fixture", { contract: "normalized_without_view_count_v1" });
    atomicWrite(file, `${JSON.stringify([withoutView], null, 2)}\n`);
    assert.throws(
      () => metadataFor({ path: "segment.json", kind: "timeline", stage: "test" }, { baseDir: directory }),
      /record_contract/,
    );
    assert.equal(metadataFor({
      path: "segment.json",
      kind: "timeline",
      stage: "test",
      contract: "normalized_without_view_count_v1",
    }, { baseDir: directory }).records, 1);

    const external = normalizeCorpusRecord({
      id: "308254026",
      created_at: "unknown",
      target: "/5003404268/308254026",
      text: "deleted post marker",
      clean_text: "deleted post marker",
      ...counts,
      view_count: 0,
    }, "framework fixture", { contract: "framework_index_link_v1" });
    atomicWrite(file, `${JSON.stringify([external], null, 2)}\n`);
    const frameworkDescriptor = {
      path: "segment.json",
      kind: "framework_links",
      stage: "test",
      contract: "framework_index_link_v1",
    };
    assert.equal(metadataFor(frameworkDescriptor, { baseDir: directory }).records, 1);

    const undeclaredExternal = { ...external, id: "123", target: "https://xueqiu.com/5003404268/123" };
    atomicWrite(file, `${JSON.stringify([undeclaredExternal], null, 2)}\n`);
    assert.throws(
      () => metadataFor(frameworkDescriptor, { baseDir: directory }),
      /declared framework owner 7143769715/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("podcast evidence requires exact numeric tokens, not substrings", () => {
  assert.equal(validatePodcastEvidence("episodes 2840 and 2841", ["2840", "2841"]), true);
  assert.throws(
    () => validatePodcastEvidence("episodes 12840 and 12841", ["2840", "2841"]),
    /Missing exact podcast evidence token/,
  );
});
