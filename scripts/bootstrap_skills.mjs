#!/usr/bin/env node

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
export const projectRoot = path.resolve(path.dirname(scriptFile), "..");
export const defaultLockFile = path.join(projectRoot, "skills-lock.json");

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} fields must be exactly: ${wanted.join(", ")}`);
  }
}

function isSha512Integrity(value) {
  const encoded = /^sha512-([A-Za-z\d+/]+={0,2})$/.exec(value || "")?.[1];
  if (!encoded) return false;
  const digest = Buffer.from(encoded, "base64");
  return digest.length === 64 && digest.toString("base64") === encoded;
}

function isGitHubSource(value) {
  if (typeof value !== "string") return false;
  const segments = value.split("/");
  return segments.length === 2 && segments.every(
    (segment) => ![".", ".."].includes(segment) && /^[A-Za-z\d][A-Za-z\d._-]*$/.test(segment),
  );
}

function compareSnapshotPaths(left, right) {
  const compared = left.localeCompare(right, "en");
  if (compared === 0 && left !== right) {
    throw new Error(`Snapshot contains locale-equivalent distinct paths: ${JSON.stringify(left)}, ${JSON.stringify(right)}`);
  }
  return compared;
}

function normalizeRelative(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a relative path`);
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (path.posix.isAbsolute(normalized) || normalized.split("/").some((part) => part === ".." || !part)) {
    throw new Error(`${label} must stay inside its skill directory`);
  }
  return normalized;
}

export function validateSkillsLock(lock) {
  if (!isPlainObject(lock) || lock.version !== 2 || !isPlainObject(lock.skills)) {
    throw new Error("skills-lock.json must use schema version 2 and contain a skills object");
  }
  exactKeys(lock, ["version", "installer", "hash_algorithm", "audit_hash_algorithm", "skills"], "skills-lock.json");
  if (lock.hash_algorithm !== "skills-cli-v1-sha256-path-content-locale-en") {
    throw new Error("skills-lock.json must declare the deterministic snapshot hash algorithm");
  }
  if (lock.audit_hash_algorithm !== "sha256-length-prefixed-path-content-v1") {
    throw new Error("skills-lock.json must declare the collision-resistant audit hash algorithm");
  }
  exactKeys(
    lock.installer,
    ["package", "version", "integrity", "installedHash", "installedFramedHash", "runtimeDependencies"],
    "skills-lock.json installer",
  );
  if (!isPlainObject(lock.installer)
      || lock.installer.package !== "skills"
      || !/^\d+\.\d+\.\d+$/.test(lock.installer.version || "")
      || !isSha512Integrity(lock.installer.integrity)
      || !/^[a-f\d]{64}$/.test(lock.installer.installedHash || "")
      || !/^[a-f\d]{64}$/.test(lock.installer.installedFramedHash || "")
      || !isPlainObject(lock.installer.runtimeDependencies)) {
    throw new Error("skills-lock.json must pin the official skills installer and both installed snapshot hashes");
  }
  if (Object.keys(lock.installer.runtimeDependencies).length === 0) {
    throw new Error("skills-lock.json must pin every installer runtime dependency");
  }
  for (const [name, metadata] of Object.entries(lock.installer.runtimeDependencies)) {
    if (!/^[A-Za-z\d][A-Za-z\d._-]*$/.test(name)) {
      throw new Error(`installer.runtimeDependencies.${name} must use one safe package-name segment`);
    }
    exactKeys(
      metadata,
      ["version", "integrity", "installedHash", "installedFramedHash"],
      `installer.runtimeDependencies.${name}`,
    );
    if (!/^\d+\.\d+\.\d+$/.test(metadata.version || "")
        || !isSha512Integrity(metadata.integrity)
        || !/^[a-f\d]{64}$/.test(metadata.installedHash || "")
        || !/^[a-f\d]{64}$/.test(metadata.installedFramedHash || "")) {
      throw new Error(`installer.runtimeDependencies.${name} must pin version, integrity, and both snapshot hashes`);
    }
  }

  for (const [name, metadata] of Object.entries(lock.skills)) {
    if (!/^[A-Za-z\d][A-Za-z\d._-]*$/.test(name)) {
      throw new Error(`skills.${name} must use one safe directory-name segment`);
    }
    exactKeys(
      metadata,
      !isPlainObject(metadata) || metadata.mutablePaths === undefined
        ? ["source", "sourceType", "ref", "computedHash", "framedHash"]
        : ["source", "sourceType", "ref", "computedHash", "framedHash", "mutablePaths"],
      `skills.${name}`,
    );
    if (!isPlainObject(metadata)
        || metadata.sourceType !== "github"
        || !isGitHubSource(metadata.source)) {
      throw new Error(`skills.${name} must declare a GitHub owner/repository source`);
    }
    if (!/^[a-f\d]{40}$/.test(metadata.ref || "")) {
      throw new Error(`skills.${name}.ref must pin a full Git commit SHA`);
    }
    if (!/^[a-f\d]{64}$/.test(metadata.computedHash || "")
        || !/^[a-f\d]{64}$/.test(metadata.framedHash || "")) {
      throw new Error(`skills.${name} must contain both SHA-256 snapshot digests`);
    }
    if (metadata.mutablePaths !== undefined && !Array.isArray(metadata.mutablePaths)) {
      throw new Error(`skills.${name}.mutablePaths must be an array`);
    }
    const paths = (metadata.mutablePaths || []).map((entry, index) => {
      const label = `skills.${name}.mutablePaths[${index}]`;
      exactKeys(entry, ["path", "baselineSha256"], label);
      const normalized = normalizeRelative(entry.path, `${label}.path`);
      if (entry.path !== normalized) throw new Error(`${label}.path must use its canonical relative form`);
      if (!/^[a-f\d]{64}$/.test(entry.baselineSha256 || "")) {
        throw new Error(`${label}.baselineSha256 must pin the initial file contents with SHA-256`);
      }
      return normalized;
    });
    if (paths.some((entry) => !entry.startsWith("references/"))) {
      throw new Error(`skills.${name}.mutablePaths must stay under references/`);
    }
    if (new Set(paths).size !== paths.length) {
      throw new Error(`skills.${name}.mutablePaths must not contain duplicates`);
    }
  }
  return lock;
}

function mutablePathNames(metadata) {
  return (metadata.mutablePaths || []).map((entry) => entry.path);
}

function shouldIgnore(relative, mutablePaths) {
  const parts = relative.split("/");
  return parts.at(-1) === ".DS_Store" || mutablePaths.includes(relative);
}

function listHashedFiles(directory, mutablePaths, current = "") {
  const absolute = path.join(directory, current);
  const entries = fs.readdirSync(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = current ? `${current}/${entry.name}` : entry.name;
    const parts = relative.split("/");
    if (parts.includes(".git") || parts.includes("node_modules")) {
      throw new Error(`Skill snapshots must not contain hidden dependency or VCS trees: ${relative}`);
    }
    if (shouldIgnore(relative, mutablePaths)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Skill snapshots must not contain symlinks: ${relative}`);
    if (entry.isDirectory()) files.push(...listHashedFiles(directory, mutablePaths, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Skill snapshots must contain only regular files: ${relative}`);
  }
  return files;
}

export function hashSkillDirectory(directory, { mutablePaths = [] } = {}) {
  const rootStat = fs.lstatSync(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Snapshot root must be a regular directory: ${directory}`);
  }
  const normalizedMutable = mutablePaths.map((entry, index) => normalizeRelative(entry, `mutablePaths[${index}]`));
  for (const relative of normalizedMutable) {
    const mutableFile = path.join(directory, ...relative.split("/"));
    let stat;
    try {
      stat = fs.lstatSync(mutableFile);
    } catch (error) {
      throw new Error(`Declared mutable skill file is missing: ${relative}`, { cause: error });
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Declared mutable skill path must be a regular file: ${relative}`);
    }
  }
  const digest = crypto.createHash("sha256");
  for (const relative of listHashedFiles(directory, normalizedMutable).sort(compareSnapshotPaths)) {
    digest.update(relative);
    digest.update(fs.readFileSync(path.join(directory, ...relative.split("/"))));
  }
  return digest.digest("hex");
}

export function hashSkillDirectoryFramed(directory, { mutablePaths = [] } = {}) {
  const rootStat = fs.lstatSync(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Snapshot root must be a regular directory: ${directory}`);
  }
  const normalizedMutable = mutablePaths.map((entry, index) => normalizeRelative(entry, `mutablePaths[${index}]`));
  for (const relative of normalizedMutable) {
    const mutableFile = path.join(directory, ...relative.split("/"));
    let stat;
    try {
      stat = fs.lstatSync(mutableFile);
    } catch (error) {
      throw new Error(`Declared mutable skill file is missing: ${relative}`, { cause: error });
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Declared mutable skill path must be a regular file: ${relative}`);
    }
  }
  const digest = crypto.createHash("sha256");
  digest.update("codex-skill-snapshot-framed-v1\0");
  for (const relative of listHashedFiles(directory, normalizedMutable).sort(compareSnapshotPaths)) {
    const name = Buffer.from(relative, "utf8");
    const contents = fs.readFileSync(path.join(directory, ...relative.split("/")));
    const lengths = Buffer.alloc(16);
    lengths.writeBigUInt64BE(BigInt(name.length), 0);
    lengths.writeBigUInt64BE(BigInt(contents.length), 8);
    digest.update(lengths);
    digest.update(name);
    digest.update(contents);
  }
  return digest.digest("hex");
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label}: ${error.message}`, { cause: error });
  }
}

export function validateProjectLocks(rootDir, lock) {
  const loaded = validateSkillsLock(lock);
  const packageJson = readJson(path.join(rootDir, "package.json"), "package.json");
  const packageLock = readJson(path.join(rootDir, "package-lock.json"), "package-lock.json");
  const packageManager = /^npm@(\d+\.\d+\.\d+)$/.exec(packageJson.packageManager || "")?.[1];
  if (!packageManager) throw new Error("package.json must pin an exact npm packageManager version");
  const runningNpm = /^npm\/([^ ]+)/.exec(process.env.npm_config_user_agent || "")?.[1];
  if (runningNpm && runningNpm !== packageManager) {
    throw new Error(`Running npm ${runningNpm} does not match packageManager npm@${packageManager}`);
  }
  if (packageLock.lockfileVersion !== 3) throw new Error("package-lock.json must use lockfileVersion 3");
  const requested = packageJson.devDependencies?.[loaded.installer.package];
  const lockedRequest = packageLock.packages?.[""]?.devDependencies?.[loaded.installer.package];
  if (requested !== loaded.installer.version || lockedRequest !== loaded.installer.version) {
    throw new Error("package.json, package-lock.json, and skills-lock.json must pin the same skills installer version");
  }
  const installerEntry = packageLock.packages?.[`node_modules/${loaded.installer.package}`];
  if (installerEntry?.version !== loaded.installer.version || installerEntry?.integrity !== loaded.installer.integrity) {
    throw new Error("package-lock.json does not match the pinned skills installer");
  }
  const runtimeNames = Object.keys(loaded.installer.runtimeDependencies).sort();
  if (JSON.stringify(Object.keys(installerEntry.dependencies || {}).sort()) !== JSON.stringify(runtimeNames)) {
    throw new Error("skills installer runtime dependencies must exactly match skills-lock.json");
  }
  for (const [name, metadata] of Object.entries(loaded.installer.runtimeDependencies)) {
    const entry = packageLock.packages?.[`node_modules/${name}`];
    if (entry?.version !== metadata.version || entry?.integrity !== metadata.integrity) {
      throw new Error(`package-lock.json does not match pinned installer dependency ${name}`);
    }
  }
  return { lock: loaded, packageJson, packageLock };
}

function rejectSymlinkTraversal(rootDir, segments, label) {
  let current = rootDir;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} must not traverse symlinks: ${current}`);
  }
}

function verifyInstalledPackage(rootDir, name, metadata) {
  rejectSymlinkTraversal(rootDir, ["node_modules", name], `Installed package ${name}`);
  const directory = path.join(rootDir, "node_modules", name);
  const packageJson = readJson(path.join(directory, "package.json"), `${name}/package.json`);
  if (packageJson.name !== name || packageJson.version !== metadata.version) {
    throw new Error(`Installed ${name} package does not match its pinned version`);
  }
  const actual = hashSkillDirectory(directory);
  const actualFramed = hashSkillDirectoryFramed(directory);
  if (actual !== metadata.installedHash || actualFramed !== metadata.installedFramedHash) {
    throw new Error(`Installed ${name} package does not match the pinned snapshot hashes; run \`npm ci --ignore-scripts\``);
  }
  return { directory, packageJson };
}

function pinnedInstaller(rootDir, lock) {
  validateProjectLocks(rootDir, lock);
  const { directory: packageDirectory, packageJson: installed } = verifyInstalledPackage(
    rootDir,
    lock.installer.package,
    lock.installer,
  );
  if (JSON.stringify(Object.keys(installed.dependencies || {}).sort())
      !== JSON.stringify(Object.keys(lock.installer.runtimeDependencies).sort())
      || !["bin/cli.mjs", "./bin/cli.mjs"].includes(installed.bin?.skills)) {
    throw new Error("Run `npm ci --ignore-scripts` before restoring skills");
  }
  for (const [name, metadata] of Object.entries(lock.installer.runtimeDependencies)) {
    verifyInstalledPackage(rootDir, name, metadata);
  }
  const cli = path.join(packageDirectory, "bin", "cli.mjs");
  const cliStat = fs.lstatSync(cli);
  if (!cliStat.isFile() || cliStat.isSymbolicLink()) {
    throw new Error("Pinned skills installer entrypoint must be a regular file");
  }
  return cli;
}

function rejectSymlinkedSkillPath(rootDir, name) {
  let current = rootDir;
  for (const segment of [".agents", "skills", name]) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Skill snapshot path must not traverse symlinks: ${current}`);
    }
  }
}

export function auditSkills({ rootDir = projectRoot, lock } = {}) {
  const loaded = validateProjectLocks(
    rootDir,
    lock ?? readJson(path.join(rootDir, "skills-lock.json"), "skills-lock.json"),
  ).lock;
  const results = [];
  for (const [name, metadata] of Object.entries(loaded.skills)) {
    rejectSymlinkedSkillPath(rootDir, name);
    const directory = path.join(rootDir, ".agents", "skills", name);
    const skillFile = path.join(directory, "SKILL.md");
    let skillStat;
    try {
      skillStat = fs.lstatSync(skillFile);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      results.push({ name, status: "missing", expected: metadata.computedHash, metadata });
      continue;
    }
    if (!skillStat.isFile() || skillStat.isSymbolicLink()) {
      throw new Error(`Skill entrypoint must be a regular file: ${skillFile}`);
    }
    const mutablePaths = mutablePathNames(metadata);
    const actual = hashSkillDirectory(directory, { mutablePaths });
    const actualFramed = hashSkillDirectoryFramed(directory, { mutablePaths });
    results.push({
      name,
      status: actual === metadata.computedHash && actualFramed === metadata.framedHash ? "present" : "mismatch",
      expected: metadata.computedHash,
      actual,
      expectedFramed: metadata.framedHash,
      actualFramed,
      metadata,
    });
  }
  return { lock: loaded, results, valid: results.every((item) => item.status === "present") };
}

function atomicWrite(file, data, mode = undefined) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, data, mode === undefined ? undefined : { mode });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function preserveMutableFiles(rootDir, lock) {
  const preserved = [];
  for (const [name, metadata] of Object.entries(lock.skills)) {
    for (const { path: mutablePath } of metadata.mutablePaths || []) {
      const file = path.join(rootDir, ".agents", "skills", name, ...mutablePath.split("/"));
      rejectSymlinkTraversal(
        rootDir,
        [".agents", "skills", name, ...mutablePath.split("/")],
        `Mutable skill path ${name}/${mutablePath}`,
      );
      if (!fs.existsSync(file)) continue;
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) throw new Error(`Mutable skill path must be a regular file: ${name}/${mutablePath}`);
      preserved.push({ name, mutablePath, file, data: fs.readFileSync(file), mode: stat.mode });
    }
  }
  return preserved;
}

function mutableKey(name, mutablePath) {
  return `${name}\0${mutablePath}`;
}

function verifyInitialMutableBaselines(rootDir, lock, preserved) {
  const existing = new Set(preserved.map(({ name, mutablePath }) => mutableKey(name, mutablePath)));
  for (const [name, metadata] of Object.entries(lock.skills)) {
    for (const { path: mutablePath, baselineSha256 } of metadata.mutablePaths || []) {
      if (existing.has(mutableKey(name, mutablePath))) continue;
      const segments = [".agents", "skills", name, ...mutablePath.split("/")];
      rejectSymlinkTraversal(rootDir, segments, `Initial mutable skill path ${name}/${mutablePath}`);
      const file = path.join(rootDir, ...segments);
      let stat;
      try {
        stat = fs.lstatSync(file);
      } catch (error) {
        throw new Error(`Initial mutable skill file is missing: ${name}/${mutablePath}`, { cause: error });
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Initial mutable skill path must be a regular file: ${name}/${mutablePath}`);
      }
      const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      if (actual !== baselineSha256) {
        throw new Error(`Initial mutable skill file does not match its pinned baseline: ${name}/${mutablePath}`);
      }
    }
  }
}

function fingerprintUnmanagedSkills(skillsRoot, managedNames) {
  const digest = crypto.createHash("sha256");
  digest.update("codex-unmanaged-skills-framed-v1\0");
  const frame = (relative, type, payload = Buffer.alloc(0), mode = 0) => {
    const name = Buffer.from(relative, "utf8");
    const kind = Buffer.from(type, "utf8");
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
    const lengths = Buffer.alloc(24);
    lengths.writeBigUInt64BE(BigInt(name.length), 0);
    lengths.writeUInt32BE(kind.length, 8);
    lengths.writeBigUInt64BE(BigInt(body.length), 12);
    lengths.writeUInt32BE(mode & 0o7777, 20);
    digest.update(lengths);
    digest.update(name);
    digest.update(kind);
    digest.update(body);
  };
  const visit = (directory, current = "") => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => current || !managedNames.has(entry.name))
      .sort((left, right) => compareSnapshotPaths(left.name, right.name));
    for (const entry of entries) {
      const relative = current ? `${current}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) frame(relative, "symlink", fs.readlinkSync(absolute), stat.mode);
      else if (stat.isDirectory()) {
        frame(relative, "directory", Buffer.alloc(0), stat.mode);
        visit(absolute, relative);
      } else if (stat.isFile()) frame(relative, "file", fs.readFileSync(absolute), stat.mode);
      else frame(relative, "other", Buffer.alloc(0), stat.mode);
    }
  };
  try {
    const stat = fs.lstatSync(skillsRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Skill installation root must be a regular directory");
    visit(skillsRoot);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return digest.digest("hex");
}

function snapshotSkillsRoot(rootDir, managedNames) {
  rejectSymlinkTraversal(rootDir, [".agents", "skills"], "Skill installation root");
  const skillsRoot = path.join(rootDir, ".agents", "skills");
  const unmanagedHash = fingerprintUnmanagedSkills(skillsRoot, managedNames);
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-skill-install-backup-"));
  const backup = path.join(backupRoot, "skills");
  let existed = false;
  try {
    const stat = fs.lstatSync(skillsRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Skill installation root must be a regular directory");
    }
    fs.cpSync(skillsRoot, backup, { recursive: true, verbatimSymlinks: true });
    existed = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      fs.rmSync(backupRoot, { recursive: true, force: true });
      throw error;
    }
  }
  return { skillsRoot, backupRoot, backup, existed, unmanagedHash, managedNames };
}

function restoreSkillsRoot(snapshot) {
  const agentsRoot = path.dirname(snapshot.skillsRoot);
  let agentsStat;
  try {
    agentsStat = fs.lstatSync(agentsRoot);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (agentsStat?.isSymbolicLink() || (agentsStat && !agentsStat.isDirectory())) {
    fs.rmSync(agentsRoot, { recursive: true, force: true });
    agentsStat = null;
  }
  if (!agentsStat) fs.mkdirSync(agentsRoot, { recursive: true });
  fs.rmSync(snapshot.skillsRoot, { recursive: true, force: true });
  if (!snapshot.existed) return;
  const temporary = `${snapshot.skillsRoot}.restore-${process.pid}-${Date.now()}`;
  fs.cpSync(snapshot.backup, temporary, { recursive: true, verbatimSymlinks: true });
  fs.renameSync(temporary, snapshot.skillsRoot);
}

function printAudit(audit) {
  for (const item of audit.results) {
    const detail = item.status === "mismatch" ? `expected=${item.expected} actual=${item.actual}` : item.metadata.source;
    console.log(`${item.status}\t${item.name}\t${detail}`);
  }
}

export function runInstaller({ rootDir, lock, spawn = spawnSync }) {
  const loaded = validateSkillsLock(lock);
  for (const [name] of Object.entries(loaded.skills)) rejectSymlinkedSkillPath(rootDir, name);
  const protectedFiles = ["skills-lock.json", "package.json", "package-lock.json"].map((relative) => {
    const file = path.join(rootDir, relative);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${relative} must be a regular file`);
    return { file, data: fs.readFileSync(file), mode: stat.mode };
  });
  const mutableFiles = preserveMutableFiles(rootDir, loaded);
  const snapshot = snapshotSkillsRoot(rootDir, new Set(Object.keys(loaded.skills)));
  const restoreProtectedFiles = () => {
    for (const entry of protectedFiles) atomicWrite(entry.file, entry.data, entry.mode);
  };
  let result;
  try {
    const cli = pinnedInstaller(rootDir, loaded);
    const installerEnvironment = { ...process.env };
    delete installerEnvironment.NODE_OPTIONS;
    delete installerEnvironment.NODE_PATH;
    result = spawn(
      process.execPath,
      [cli, "experimental_install"],
      { cwd: rootDir, stdio: "inherit", env: installerEnvironment },
    );
    restoreProtectedFiles();
    if (result?.error) throw result.error;
    if (result?.status !== 0) throw new Error(`Pinned skill installer exited with status ${result?.status ?? "unknown"}`);
    // The installer executes with the authority of the current Node process. Rebind the
    // executable and every runtime dependency after it returns so self-modification cannot
    // turn a successful exit code into a trusted installation result.
    pinnedInstaller(rootDir, loaded);
    if (fingerprintUnmanagedSkills(snapshot.skillsRoot, snapshot.managedNames) !== snapshot.unmanagedHash) {
      throw new Error("Pinned skill installer modified an unmanaged skill entry");
    }
    for (const [name] of Object.entries(loaded.skills)) rejectSymlinkedSkillPath(rootDir, name);
    for (const entry of mutableFiles) {
      rejectSymlinkTraversal(
        rootDir,
        [".agents", "skills", entry.name, ...entry.mutablePath.split("/")],
        `Mutable skill path ${entry.name}/${entry.mutablePath}`,
      );
      atomicWrite(entry.file, entry.data, entry.mode);
    }
    verifyInitialMutableBaselines(rootDir, loaded, mutableFiles);
    const after = auditSkills({ rootDir, lock: loaded });
    if (!after.valid) throw new Error("Skill installation completed but snapshot verification failed");
  } catch (error) {
    restoreProtectedFiles();
    restoreSkillsRoot(snapshot);
    throw error;
  } finally {
    fs.rmSync(snapshot.backupRoot, { recursive: true, force: true });
  }
}

export function main(argv = process.argv.slice(2), { rootDir = projectRoot, spawn = spawnSync } = {}) {
  const allowed = new Set(["--help", "--install", "--verify-locks"]);
  const unknown = argv.filter((value) => !allowed.has(value));
  if (unknown.length) throw new Error(`Unknown option(s): ${unknown.join(", ")}`);
  if (new Set(argv).size !== argv.length) throw new Error("Duplicate bootstrap option");
  if (argv.length > 1) throw new Error("Bootstrap options cannot be combined");
  if (argv.includes("--help")) {
    console.log("Usage: node scripts/bootstrap_skills.mjs [--install | --verify-locks]");
    return 0;
  }

  const lockFile = path.join(rootDir, "skills-lock.json");
  if (!fs.existsSync(lockFile)) throw new Error(`Missing ${lockFile}`);
  const lock = readJson(lockFile, "skills-lock.json");
  if (argv.includes("--verify-locks")) {
    if (argv.length !== 1) throw new Error("--verify-locks cannot be combined with other options");
    pinnedInstaller(rootDir, validateSkillsLock(lock));
    console.log("valid\tproject dependency locks and installed skill runtime");
    return 0;
  }
  const before = auditSkills({ rootDir });
  printAudit(before);
  if (before.valid) return 0;
  if (!argv.includes("--install")) {
    console.error("Run `node scripts/bootstrap_skills.mjs --install` to restore missing or modified skills.");
    return 2;
  }

  runInstaller({ rootDir, lock: before.lock, spawn });
  const after = auditSkills({ rootDir });
  printAudit(after);
  if (!after.valid) throw new Error("Skill installation completed but snapshot verification still failed");
  return 0;
}

if (path.resolve(process.argv[1] || "") === scriptFile) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
