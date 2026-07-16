import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  auditSkills,
  hashSkillDirectory,
  hashSkillDirectoryFramed,
  main,
  runInstaller,
  validateProjectLocks,
  validateSkillsLock,
} from "../../scripts/bootstrap_skills.mjs";

const installerIntegrity = `sha512-${Buffer.alloc(64, 0x61).toString("base64")}`;
const yamlIntegrity = `sha512-${Buffer.alloc(64, 0x62).toString("base64")}`;
const mutableBaseline = "local secret-free config\n";

function contentHash(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function snapshotHash(files) {
  const digest = crypto.createHash("sha256");
  for (const [relative, contents] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right, "en"))) {
    digest.update(relative);
    digest.update(contents);
  }
  return digest.digest("hex");
}

function snapshotFramedHash(files) {
  const digest = crypto.createHash("sha256");
  digest.update("codex-skill-snapshot-framed-v1\0");
  for (const [relative, contents] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right, "en"))) {
    const name = Buffer.from(relative);
    const body = Buffer.from(contents);
    const lengths = Buffer.alloc(16);
    lengths.writeBigUInt64BE(BigInt(name.length), 0);
    lengths.writeBigUInt64BE(BigInt(body.length), 8);
    digest.update(lengths);
    digest.update(name);
    digest.update(body);
  }
  return digest.digest("hex");
}

function makeProject() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-bootstrap-"));
  const directory = path.join(rootDir, ".agents", "skills", "example");
  fs.mkdirSync(path.join(directory, "references"), { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), "# example\n");
  fs.writeFileSync(path.join(directory, "references", "source.md"), "tracked\n");
  fs.writeFileSync(path.join(directory, "references", "local.md"), mutableBaseline);
  fs.writeFileSync(path.join(directory, ".DS_Store"), "ignored\n");
  const computedHash = snapshotHash({
    "SKILL.md": "# example\n",
    "references/source.md": "tracked\n",
  });
  const framedHash = snapshotFramedHash({
    "SKILL.md": "# example\n",
    "references/source.md": "tracked\n",
  });
  const lock = {
    version: 2,
    installer: {
      package: "skills",
      version: "1.5.17",
      integrity: installerIntegrity,
      installedHash: "0".repeat(64),
      installedFramedHash: "0".repeat(64),
      runtimeDependencies: {
        yaml: {
          version: "2.9.0",
          integrity: yamlIntegrity,
          installedHash: "0".repeat(64),
          installedFramedHash: "0".repeat(64),
        },
      },
    },
    hash_algorithm: "skills-cli-v1-sha256-path-content-locale-en",
    audit_hash_algorithm: "sha256-length-prefixed-path-content-v1",
    skills: {
      example: {
        source: "owner/repository",
        sourceType: "github",
        ref: "a".repeat(40),
        computedHash,
        framedHash,
        mutablePaths: [{
          path: "references/local.md",
          baselineSha256: contentHash(mutableBaseline),
        }],
      },
    },
  };
  const installerDirectory = path.join(rootDir, "node_modules", "skills");
  fs.mkdirSync(path.join(installerDirectory, "bin"), { recursive: true });
  fs.writeFileSync(path.join(installerDirectory, "package.json"), JSON.stringify({
    name: "skills",
    version: "1.5.17",
    bin: { skills: "bin/cli.mjs" },
    dependencies: { yaml: "^2.8.3" },
  }));
  fs.writeFileSync(path.join(installerDirectory, "bin", "cli.mjs"), "// fixture\n");
  lock.installer.installedHash = hashSkillDirectory(installerDirectory);
  lock.installer.installedFramedHash = hashSkillDirectoryFramed(installerDirectory);
  const yamlDirectory = path.join(rootDir, "node_modules", "yaml");
  fs.mkdirSync(yamlDirectory, { recursive: true });
  fs.writeFileSync(path.join(yamlDirectory, "package.json"), JSON.stringify({
    name: "yaml",
    version: "2.9.0",
  }));
  fs.writeFileSync(path.join(yamlDirectory, "index.js"), "// yaml fixture\n");
  lock.installer.runtimeDependencies.yaml.installedHash = hashSkillDirectory(yamlDirectory);
  lock.installer.runtimeDependencies.yaml.installedFramedHash = hashSkillDirectoryFramed(yamlDirectory);
  fs.writeFileSync(path.join(rootDir, "skills-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  fs.writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({
    name: "fixture",
    version: "1.0.0",
    private: true,
    packageManager: "npm@10.9.4",
    devDependencies: { skills: "1.5.17" },
  }));
  fs.writeFileSync(path.join(rootDir, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": {
        name: "fixture",
        version: "1.0.0",
        devDependencies: { skills: "1.5.17" },
      },
      "node_modules/skills": {
        version: "1.5.17",
        integrity: installerIntegrity,
        dependencies: { yaml: "^2.8.3" },
      },
      "node_modules/yaml": {
        version: "2.9.0",
        integrity: yamlIntegrity,
      },
    },
  }));
  return { rootDir, directory, lock, computedHash, framedHash };
}

test("skill snapshots reproduce the official path-plus-content hash and ignore only declared mutable files", () => {
  const fixture = makeProject();
  try {
    assert.equal(
      hashSkillDirectory(fixture.directory, { mutablePaths: ["references/local.md"] }),
      fixture.computedHash,
    );
    assert.equal(
      hashSkillDirectoryFramed(fixture.directory, { mutablePaths: ["references/local.md"] }),
      fixture.framedHash,
    );
    assert.equal(auditSkills({ rootDir: fixture.rootDir }).valid, true);

    fs.writeFileSync(path.join(fixture.directory, "references", "local.md"), "changed locally\n");
    assert.equal(auditSkills({ rootDir: fixture.rootDir }).valid, true);

    fs.writeFileSync(path.join(fixture.directory, "SKILL.md"), "tampered\n");
    const audit = auditSkills({ rootDir: fixture.rootDir });
    assert.equal(audit.valid, false);
    assert.equal(audit.results[0].status, "mismatch");
    assert.equal(main([], { rootDir: fixture.rootDir }), 2);
  } finally {
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("skill lock rejects moving refs, malformed hashes, and escaping mutable paths", () => {
  const fixture = makeProject();
  try {
    for (const [field, value, expected] of [
      ["ref", "main", /full Git commit SHA/],
      ["computedHash", "a".repeat(40), /SHA-256/],
    ]) {
      const invalid = structuredClone(fixture.lock);
      invalid.skills.example[field] = value;
      assert.throws(() => validateSkillsLock(invalid), expected);
    }
    const escaping = structuredClone(fixture.lock);
    escaping.skills.example.mutablePaths = [{
      path: "../outside",
      baselineSha256: contentHash(mutableBaseline),
    }];
    assert.throws(() => validateSkillsLock(escaping), /stay inside/);
    const unpinnedInstaller = structuredClone(fixture.lock);
    unpinnedInstaller.installer.version = "latest";
    assert.throws(() => validateSkillsLock(unpinnedInstaller), /official skills installer and both installed snapshot hashes/);
    const mutableInstructions = structuredClone(fixture.lock);
    mutableInstructions.skills.example.mutablePaths = [{
      path: "SKILL.md",
      baselineSha256: contentHash(mutableBaseline),
    }];
    assert.throws(() => validateSkillsLock(mutableInstructions), /under references/);
    const missingBaseline = structuredClone(fixture.lock);
    delete missingBaseline.skills.example.mutablePaths[0].baselineSha256;
    assert.throws(() => validateSkillsLock(missingBaseline), /fields must be exactly/);
    const malformedBaseline = structuredClone(fixture.lock);
    malformedBaseline.skills.example.mutablePaths[0].baselineSha256 = "0".repeat(63);
    assert.throws(() => validateSkillsLock(malformedBaseline), /initial file contents with SHA-256/);
    const nestedName = structuredClone(fixture.lock);
    nestedName.skills["nested/example"] = nestedName.skills.example;
    delete nestedName.skills.example;
    assert.throws(() => validateSkillsLock(nestedName), /safe directory-name segment/);
    const parentSource = structuredClone(fixture.lock);
    parentSource.skills.example.source = "../repository";
    assert.throws(() => validateSkillsLock(parentSource), /GitHub owner\/repository/);
    const shortIntegrity = structuredClone(fixture.lock);
    shortIntegrity.installer.integrity = "sha512-YWJjZA==";
    assert.throws(() => validateSkillsLock(shortIntegrity), /both installed snapshot hashes/);
    for (const field of ["sourceUrl", "skillPath"]) {
      const hiddenSource = structuredClone(fixture.lock);
      hiddenSource.skills.example[field] = "https://example.invalid/untrusted";
      assert.throws(() => validateSkillsLock(hiddenSource), /fields must be exactly/);
    }
  } finally {
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("pinned installer cannot rewrite the lock or erase declared mutable configuration", () => {
  const fixture = makeProject();
  try {
    const originalLock = fs.readFileSync(path.join(fixture.rootDir, "skills-lock.json"));
    const mutableFile = path.join(fixture.directory, "references", "local.md");
    fs.writeFileSync(mutableFile, "user-customized config\n");
    const calls = [];
    runInstaller({
      rootDir: fixture.rootDir,
      lock: fixture.lock,
      spawn(command, args, options) {
        calls.push({ command, args, options });
        fs.writeFileSync(path.join(fixture.rootDir, "skills-lock.json"), "rewritten by installer\n");
        fs.rmSync(mutableFile);
        return { status: 0 };
      },
    });

    assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [{
      command: process.execPath,
      args: [path.join(fixture.rootDir, "node_modules", "skills", "bin", "cli.mjs"), "experimental_install"],
    }]);
    assert.deepEqual(fs.readFileSync(path.join(fixture.rootDir, "skills-lock.json")), originalLock);
    assert.equal(fs.readFileSync(mutableFile, "utf8"), "user-customized config\n");
  } finally {
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("first install rejects mutable content that does not match the pinned baseline", () => {
  const fixture = makeProject();
  try {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
    assert.throws(
      () => runInstaller({
        rootDir: fixture.rootDir,
        lock: fixture.lock,
        spawn() {
          fs.mkdirSync(path.join(fixture.directory, "references"), { recursive: true });
          fs.writeFileSync(path.join(fixture.directory, "SKILL.md"), "# example\n");
          fs.writeFileSync(path.join(fixture.directory, "references", "source.md"), "tracked\n");
          fs.writeFileSync(path.join(fixture.directory, "references", "local.md"), "unexpected installer output\n");
          return { status: 0 };
        },
      }),
      /does not match its pinned baseline/,
    );
    assert.equal(fs.existsSync(fixture.directory), false);
  } finally {
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("first install rejects a missing mutable baseline file", () => {
  const fixture = makeProject();
  try {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
    assert.throws(
      () => runInstaller({
        rootDir: fixture.rootDir,
        lock: fixture.lock,
        spawn() {
          fs.mkdirSync(path.join(fixture.directory, "references"), { recursive: true });
          fs.writeFileSync(path.join(fixture.directory, "SKILL.md"), "# example\n");
          fs.writeFileSync(path.join(fixture.directory, "references", "source.md"), "tracked\n");
          return { status: 0 };
        },
      }),
      /Initial mutable skill file is missing/,
    );
    assert.equal(fs.existsSync(fixture.directory), false);
  } finally {
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("first install accepts the exact pinned mutable baseline", () => {
  const fixture = makeProject();
  try {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
    runInstaller({
      rootDir: fixture.rootDir,
      lock: fixture.lock,
      spawn() {
        fs.mkdirSync(path.join(fixture.directory, "references"), { recursive: true });
        fs.writeFileSync(path.join(fixture.directory, "SKILL.md"), "# example\n");
        fs.writeFileSync(path.join(fixture.directory, "references", "source.md"), "tracked\n");
        fs.writeFileSync(path.join(fixture.directory, "references", "local.md"), mutableBaseline);
        return { status: 0 };
      },
    });
    assert.equal(fs.readFileSync(path.join(fixture.directory, "references", "local.md"), "utf8"), mutableBaseline);
  } finally {
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("pinned installer refuses a locally modified package before executing it", () => {
  const fixture = makeProject();
  try {
    fs.appendFileSync(path.join(fixture.rootDir, "node_modules", "skills", "bin", "cli.mjs"), "// tampered\n");
    let spawned = false;
    assert.throws(
      () => runInstaller({
        rootDir: fixture.rootDir,
        lock: fixture.lock,
        spawn() {
          spawned = true;
          return { status: 0 };
        },
      }),
      /does not match the pinned snapshot hashes/,
    );
    assert.equal(spawned, false);
  } finally {
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("project, npm, installer, and transitive dependency locks cannot drift independently", () => {
  const fixture = makeProject();
  try {
    assert.equal(validateProjectLocks(fixture.rootDir, fixture.lock).lock, fixture.lock);
    const packageJsonFile = path.join(fixture.rootDir, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonFile, "utf8"));
    packageJson.devDependencies.skills = "1.5.18";
    fs.writeFileSync(packageJsonFile, JSON.stringify(packageJson));
    assert.throws(
      () => validateProjectLocks(fixture.rootDir, fixture.lock),
      /must pin the same skills installer version/,
    );
  } finally {
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("pinned installer refuses a modified transitive runtime dependency", () => {
  const fixture = makeProject();
  try {
    fs.appendFileSync(path.join(fixture.rootDir, "node_modules", "yaml", "index.js"), "// tampered\n");
    let spawned = false;
    assert.throws(
      () => runInstaller({
        rootDir: fixture.rootDir,
        lock: fixture.lock,
        spawn() {
          spawned = true;
          return { status: 0 };
        },
      }),
      /Installed yaml package does not match the pinned snapshot hashes/,
    );
    assert.equal(spawned, false);
  } finally {
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("installer and runtime snapshots are rebound after execution", () => {
  for (const relative of [
    ["node_modules", "skills", "bin", "cli.mjs"],
    ["node_modules", "yaml", "index.js"],
  ]) {
    const fixture = makeProject();
    try {
      assert.throws(
        () => runInstaller({
          rootDir: fixture.rootDir,
          lock: fixture.lock,
          spawn() {
            fs.writeFileSync(path.join(fixture.directory, "SKILL.md"), "installer-mutated skill\n");
            fs.appendFileSync(path.join(fixture.rootDir, ...relative), "// self-modified\n");
            return { status: 0 };
          },
        }),
        /does not match the pinned snapshot hashes/,
      );
      assert.equal(
        fs.readFileSync(path.join(fixture.directory, "SKILL.md"), "utf8"),
        "# example\n",
        `${relative.join("/")} tampering must roll back the Skill tree`,
      );
    } finally {
      fs.rmSync(fixture.rootDir, { recursive: true, force: true });
    }
  }
});

test("official compatibility hash collisions are separated by the framed audit hash", () => {
  const left = fs.mkdtempSync(path.join(os.tmpdir(), "skill-hash-left-"));
  const right = fs.mkdtempSync(path.join(os.tmpdir(), "skill-hash-right-"));
  try {
    fs.writeFileSync(path.join(left, "a"), "bc");
    fs.writeFileSync(path.join(right, "ab"), "c");
    assert.equal(hashSkillDirectory(left), hashSkillDirectory(right));
    assert.notEqual(hashSkillDirectoryFramed(left), hashSkillDirectoryFramed(right));
  } finally {
    fs.rmSync(left, { recursive: true, force: true });
    fs.rmSync(right, { recursive: true, force: true });
  }
});

test("skill snapshots reject hidden VCS and dependency trees", () => {
  const fixture = makeProject();
  try {
    fs.mkdirSync(path.join(fixture.directory, "node_modules", "payload"), { recursive: true });
    fs.writeFileSync(path.join(fixture.directory, "node_modules", "payload", "index.js"), "payload\n");
    assert.throws(() => auditSkills({ rootDir: fixture.rootDir }), /hidden dependency or VCS trees/);
    fs.rmSync(path.join(fixture.directory, "node_modules"), { recursive: true, force: true });
    fs.mkdirSync(path.join(fixture.directory, ".git", "hooks"), { recursive: true });
    assert.throws(() => auditSkills({ rootDir: fixture.rootDir }), /hidden dependency or VCS trees/);
  } finally {
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("failed or unverifiable installs roll back the complete local skills tree", () => {
  const fixture = makeProject();
  try {
    const unmanaged = path.join(fixture.rootDir, ".agents", "skills", "unmanaged", "note.md");
    fs.mkdirSync(path.dirname(unmanaged), { recursive: true });
    fs.writeFileSync(unmanaged, "preserve me\n");
    assert.throws(
      () => runInstaller({
        rootDir: fixture.rootDir,
        lock: fixture.lock,
        spawn() {
          fs.rmSync(path.join(fixture.rootDir, ".agents", "skills"), { recursive: true, force: true });
          fs.mkdirSync(fixture.directory, { recursive: true });
          fs.writeFileSync(path.join(fixture.directory, "SKILL.md"), "unverified\n");
          return { status: 9 };
        },
      }),
      /exited with status 9/,
    );
    assert.equal(fs.readFileSync(path.join(fixture.directory, "SKILL.md"), "utf8"), "# example\n");
    assert.equal(fs.readFileSync(unmanaged, "utf8"), "preserve me\n");

    assert.throws(
      () => runInstaller({
        rootDir: fixture.rootDir,
        lock: fixture.lock,
        spawn() {
          fs.writeFileSync(unmanaged, "installer changed me\n");
          return { status: 0 };
        },
      }),
      /modified an unmanaged skill entry/,
    );
    assert.equal(fs.readFileSync(unmanaged, "utf8"), "preserve me\n");
  } finally {
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("skill snapshot audit fails closed on symlinks", (t) => {
  const fixture = makeProject();
  try {
    const link = path.join(fixture.directory, "linked.md");
    try {
      fs.symlinkSync(path.join(fixture.directory, "SKILL.md"), link);
    } catch (error) {
      if (error.code === "EPERM") return t.skip("symlinks unavailable on this platform");
      throw error;
    }
    assert.throws(() => auditSkills({ rootDir: fixture.rootDir }), /must not contain symlinks/);
  } finally {
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("skill snapshot audit rejects a symlinked skill root", (t) => {
  const fixture = makeProject();
  const realDirectory = `${fixture.directory}-real`;
  try {
    fs.renameSync(fixture.directory, realDirectory);
    try {
      fs.symlinkSync(realDirectory, fixture.directory, "dir");
    } catch (error) {
      if (error.code === "EPERM") return t.skip("symlinks unavailable on this platform");
      throw error;
    }
    assert.throws(() => auditSkills({ rootDir: fixture.rootDir }), /must not traverse symlinks/);
  } finally {
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("skill snapshot audit rejects a broken symlink entrypoint", (t) => {
  const fixture = makeProject();
  try {
    fs.rmSync(path.join(fixture.directory, "SKILL.md"));
    try {
      fs.symlinkSync(path.join(fixture.directory, "missing.md"), path.join(fixture.directory, "SKILL.md"));
    } catch (error) {
      if (error.code === "EPERM") return t.skip("symlinks unavailable on this platform");
      throw error;
    }
    assert.throws(() => auditSkills({ rootDir: fixture.rootDir }), /entrypoint must be a regular file/);
  } finally {
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("bootstrap options reject duplicates and ambiguous combinations", () => {
  const fixture = makeProject();
  try {
    assert.throws(() => main(["--install", "--install"], { rootDir: fixture.rootDir }), /Duplicate/);
    assert.throws(() => main(["--help", "--install"], { rootDir: fixture.rootDir }), /cannot be combined/);
  } finally {
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("declared mutable paths cannot hide directories or arbitrary subtrees", () => {
  const fixture = makeProject();
  try {
    const mutable = path.join(fixture.directory, "references", "local.md");
    fs.rmSync(mutable);
    fs.mkdirSync(mutable);
    fs.writeFileSync(path.join(mutable, "payload.mjs"), "malicious payload\n");
    assert.throws(
      () => auditSkills({ rootDir: fixture.rootDir }),
      /must be a regular file/,
    );
  } finally {
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});
