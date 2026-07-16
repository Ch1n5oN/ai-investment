import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { manifestFile } from "../../.claude/skills/bingbing-xiaomei-perspective/scripts/build_corpus_manifest.mjs";
import {
  buildProvenance,
  evidenceSha256,
  parseFrontmatter,
  provenanceFile,
  requiredEvidence,
  runValidation,
  skillDir,
  validateDescriptionClaims,
  validateEvaluationCases,
  validateProvenance,
} from "../../.claude/skills/bingbing-xiaomei-perspective/scripts/validate_skill.mjs";

const skill = fs.readFileSync(`${skillDir}/SKILL.md`, "utf8");
const claims = JSON.parse(fs.readFileSync(manifestFile, "utf8")).claims;
const provenance = JSON.parse(fs.readFileSync(provenanceFile, "utf8"));

test("skill validator accepts the complete tracked redistillation", () => {
  const failures = runValidation().filter(([, pass]) => !pass);
  assert.deepEqual(failures, []);
});

function assertRootEntrypointSymlinkRejected(t, relative) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-root-link-"));
  const baseDir = path.join(root, "skill");
  try {
    fs.cpSync(skillDir, baseDir, { recursive: true });
    const entrypoint = path.join(baseDir, ...relative.split("/"));
    const outside = path.join(root, `outside-${path.basename(relative)}`);
    fs.copyFileSync(entrypoint, outside);
    fs.rmSync(entrypoint);
    try {
      fs.symlinkSync(outside, entrypoint);
    } catch (error) {
      if (error.code === "EPERM") return t.skip("symlinks unavailable on this platform");
      throw error;
    }
    assert.throws(() => runValidation({ baseDir }), /regular file, not a symlink/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("skill validator rejects a symlinked SKILL.md root entrypoint", (t) => {
  assertRootEntrypointSymlinkRejected(t, "SKILL.md");
});

test("skill validator rejects a symlinked provenance root entrypoint", (t) => {
  assertRootEntrypointSymlinkRejected(t, "references/sources/redistillation-provenance.json");
});

test("skill validator rejects a symlinked evaluation root entrypoint", (t) => {
  assertRootEntrypointSymlinkRejected(t, "evaluations/cases.json");
});

test("skill validator binds copied corpus files to the copied manifest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-corpus-copy-"));
  const baseDir = path.join(root, "skill");
  try {
    fs.cpSync(skillDir, baseDir, { recursive: true });
    assert.deepEqual(runValidation({ baseDir }).filter(([, pass]) => !pass), []);
    const copiedManifest = JSON.parse(fs.readFileSync(
      path.join(baseDir, "references/sources/corpus-manifest.json"),
      "utf8",
    ));
    const corpusFile = path.join(baseDir, copiedManifest.segments[0].path);
    fs.writeFileSync(corpusFile, "[]\n");
    assert.throws(() => runValidation({ baseDir }), /must not be empty/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("provenance evidence cannot escape through a symlink", (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-provenance-link-"));
  const outside = path.join(os.tmpdir(), `outside-evidence-${process.pid}-${Date.now()}.md`);
  const skillText = "fixture skill\n";
  try {
    fs.writeFileSync(outside, "outside\n");
    const evidence = [];
    for (const [relative, role] of requiredEvidence) {
      const absolute = path.join(baseDir, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      if (evidence.length === 0) {
        try {
          fs.symlinkSync(outside, absolute);
        } catch (error) {
          if (error.code === "EPERM") return t.skip("symlinks unavailable on this platform");
          throw error;
        }
      } else {
        fs.writeFileSync(absolute, `${relative}\n`);
      }
      evidence.push({
        path: relative,
        role,
        sha256: crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"),
      });
    }
    const fixture = {
      schema_version: 1,
      generated_at: "2026-07-15T22:39:15+08:00",
      skill: "SKILL.md",
      skill_sha256: crypto.createHash("sha256").update(skillText).digest("hex"),
      claims: {},
      evidence,
    };
    assert.throws(
      () => validateProvenance({ baseDir, provenance: fixture, skillText, claims: {} }),
      /regular file, not a symlink/,
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test("manifest provenance ignores rebuild timestamps but binds semantic content", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "skill-manifest-digest-"));
  const file = path.join(directory, "manifest.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ generated_at: "2026-07-15T00:00:00.000Z", claims: { total: 1 } }));
    const first = evidenceSha256(file, "references/sources/corpus-manifest.json");
    fs.writeFileSync(file, JSON.stringify({ claims: { total: 1 }, generated_at: "2026-07-16T00:00:00.000Z" }));
    assert.equal(evidenceSha256(file, "references/sources/corpus-manifest.json"), first);
    fs.writeFileSync(file, JSON.stringify({ generated_at: "2026-07-16T00:00:00.000Z", claims: { total: 2 } }));
    assert.notEqual(evidenceSha256(file, "references/sources/corpus-manifest.json"), first);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("provenance has a deterministic, complete regeneration path", () => {
  const regenerated = buildProvenance({ claims, generatedAt: provenance.generated_at });
  assert.deepEqual(regenerated, provenance);
});

test("behavioral evaluation specification rejects weak types and duplicate coverage", () => {
  const cases = JSON.parse(fs.readFileSync(`${skillDir}/evaluations/cases.json`, "utf8"));
  assert.equal(validateEvaluationCases(cases), cases);

  const stringBehaviors = structuredClone(cases);
  stringBehaviors.cases[0].required_behaviors = "竞争格局";
  assert.throws(() => validateEvaluationCases(stringBehaviors), /required_behaviors/);

  const duplicateId = structuredClone(cases);
  duplicateId.cases[1].id = duplicateId.cases[0].id;
  assert.throws(() => validateEvaluationCases(duplicateId), /Duplicate behavioral evaluation ID/);

  const blankBehavior = structuredClone(cases);
  blankBehavior.cases[0].forbidden_behaviors = [""];
  assert.throws(() => validateEvaluationCases(blankBehavior), /forbidden_behaviors/);
});

test("a correct claim hidden in the body cannot mask a false frontmatter claim", () => {
  const tampered = skill.replace("基于118条专栏记录", "基于117条专栏记录")
    + "\n<!-- 基于118条专栏记录 -->\n";
  const { description } = parseFrontmatter(tampered);
  assert.throws(() => validateDescriptionClaims(description, claims), /do not match the manifest/);
});

test("provenance fails closed on skill, evidence, or evidence-set tampering", () => {
  const changedSkill = structuredClone(provenance);
  changedSkill.skill_sha256 = "0".repeat(64);
  assert.throws(
    () => validateProvenance({ baseDir: skillDir, provenance: changedSkill, skillText: skill, claims }),
    /SKILL.md hash/,
  );

  const changedEvidence = structuredClone(provenance);
  changedEvidence.evidence[0].sha256 = "0".repeat(64);
  assert.throws(
    () => validateProvenance({ baseDir: skillDir, provenance: changedEvidence, skillText: skill, claims }),
    /Evidence hash mismatch/,
  );

  const missingEvidence = structuredClone(provenance);
  missingEvidence.evidence.pop();
  assert.throws(
    () => validateProvenance({ baseDir: skillDir, provenance: missingEvidence, skillText: skill, claims }),
    /exact required evidence set/,
  );
});
