#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  atomicWrite,
  normalizeCorpusRecord,
  validateCorpusRecord,
} from "../../bingbing-xiaomei-perspective/scripts/build_corpus_manifest.mjs";

const scriptFile = fileURLToPath(import.meta.url);
export const skillDir = path.resolve(path.dirname(scriptFile), "..");
export const manifestFile = path.join(skillDir, "references", "sources", "corpus-manifest.json");
const USER_ID = "8469219487";
const CONTRACT = "normalized_v1";

export const declaredSegments = Object.freeze([Object.freeze({
  path: "references/research/11-latest-posts-2026-05-12.json",
  origin: "Xueqiu incremental acquisition through 2026-05-12",
  kind: "timeline",
  stage: "canonical",
  contract: CONTRACT,
})]);

export const archivedRawArrays = Object.freeze([Object.freeze({
  path: "references/research/07-latest-posts-2026-04-28.json",
  kind: "raw_timeline_snapshot",
  disposition: "superseded_raw_snapshot",
  counted_in_claims: false,
  reason: "The later 125-post canonical segment contains all 50 IDs; this raw acquisition snapshot is retained only for historical research references.",
})]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse Dongge corpus source ${file}: ${error.message}`, { cause: error });
  }
}

function readArray(file) {
  const value = readJson(file);
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Dongge corpus source must be a non-empty array: ${file}`);
  }
  return value;
}

function sourceFile(baseDir, relativePath) {
  const base = path.resolve(baseDir);
  const absolute = path.resolve(base, relativePath);
  if (!absolute.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Dongge corpus source escapes its base directory: ${relativePath}`);
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Dongge corpus source must be a regular file: ${relativePath}`);
  }
  const realBase = fs.realpathSync(base);
  const realAbsolute = fs.realpathSync(absolute);
  if (!realAbsolute.startsWith(`${realBase}${path.sep}`)) {
    throw new Error(`Dongge corpus source resolves outside its base directory: ${relativePath}`);
  }
  return absolute;
}

export function validateRecordArrayInventory({ baseDir = skillDir } = {}) {
  const references = path.join(path.resolve(baseDir), "references");
  const stat = fs.lstatSync(references);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Dongge references root must be a real directory");
  }
  const discovered = new Set();
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Dongge references cannot contain symlinks: ${absolute}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        const value = readJson(absolute);
        if (Array.isArray(value)) {
          discovered.add(path.relative(path.resolve(baseDir), absolute).split(path.sep).join("/"));
        }
      }
    }
  };
  visit(references);
  const expected = new Set([
    ...declaredSegments.map((segment) => segment.path),
    ...archivedRawArrays.map((archive) => archive.path),
  ]);
  const missing = [...expected].filter((item) => !discovered.has(item)).sort();
  const undeclared = [...discovered].filter((item) => !expected.has(item)).sort();
  if (missing.length || undeclared.length) {
    throw new Error(
      `Dongge record-array inventory mismatch; missing=[${missing.join(", ")}], undeclared=[${undeclared.join(", ")}]`,
    );
  }
  return [...discovered].sort();
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function recordId(value, label) {
  const id = typeof value === "string"
    ? value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "")
    : Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : "";
  if (!/^\d+$/.test(id)) throw new Error(`${label} must contain a digit-only ID`);
  return id;
}

function assertNoSensitiveRawFields(value, label) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveRawFields(item, `${label}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:cookie|cookies|token|access_token|authorization|password|secret|browser_profile)$/i.test(key)) {
      throw new Error(`${label}.${key} is forbidden in a tracked raw snapshot`);
    }
    assertNoSensitiveRawFields(item, `${label}.${key}`);
  }
}

function assertSubjectTarget(record, label) {
  const url = new URL(record.target);
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== "https:"
      || url.hostname !== "xueqiu.com"
      || parts.length !== 2
      || parts[0] !== USER_ID
      || parts[1] !== record.id) {
    throw new Error(`${label}.target must identify ${USER_ID}/${record.id}`);
  }
}

function canonicalMetadata(segment, { baseDir = skillDir } = {}) {
  const absolute = sourceFile(baseDir, segment.path);
  const records = readArray(absolute);
  const ids = new Set();
  const dates = [];
  for (const [index, record] of records.entries()) {
    const label = `${segment.path}[${index}]`;
    validateCorpusRecord(record, label);
    const normalized = normalizeCorpusRecord(record, label, { contract: CONTRACT });
    if (JSON.stringify(normalized) !== JSON.stringify(record)) {
      throw new Error(`${label} is not idempotently normalized`);
    }
    if (record.record_contract !== segment.contract) {
      throw new Error(`${label}.record_contract must equal ${segment.contract}`);
    }
    assertSubjectTarget(record, label);
    if (ids.has(record.id)) throw new Error(`${segment.path} contains duplicate ID ${record.id}`);
    ids.add(record.id);
    dates.push(record.created_at.slice(0, 10));
  }
  dates.sort();
  return {
    ...segment,
    records: records.length,
    unique_ids: ids.size,
    min_date: dates[0],
    max_date: dates.at(-1),
    sha256: sha256(absolute),
  };
}

function rawArchiveMetadata(archive, canonicalIds, { baseDir = skillDir } = {}) {
  const absolute = sourceFile(baseDir, archive.path);
  const records = readArray(absolute);
  const ids = new Set();
  for (const [index, record] of records.entries()) {
    if (!isPlainObject(record)) throw new Error(`${archive.path}[${index}] must be an object`);
    assertNoSensitiveRawFields(record, `${archive.path}[${index}]`);
    const id = recordId(record.id, `${archive.path}[${index}].id`);
    if (ids.has(id)) throw new Error(`${archive.path} contains duplicate ID ${id}`);
    ids.add(id);
    for (const countField of ["reply_count", "like_count", "retweet_count"]) {
      if (!Number.isSafeInteger(record[countField]) || record[countField] < 0) {
        throw new Error(`${archive.path}[${index}].${countField} must be a non-negative integer`);
      }
    }
    if (typeof record.text !== "string" || typeof record.created_at !== "string") {
      throw new Error(`${archive.path}[${index}] must preserve raw text and created_at`);
    }
  }
  const missing = [...ids].filter((id) => !canonicalIds.has(id));
  if (missing.length) {
    throw new Error(`${archive.path} contains IDs absent from the canonical segment: ${missing.join(", ")}`);
  }
  return {
    ...archive,
    records: records.length,
    unique_ids: ids.size,
    overlap_with_canonical: ids.size,
    sha256: sha256(absolute),
  };
}

export function buildManifest({ baseDir = skillDir } = {}) {
  validateRecordArrayInventory({ baseDir });
  const segments = declaredSegments.map((segment) => canonicalMetadata(segment, { baseDir }));
  const canonicalRecords = segments.flatMap((segment) => (
    readArray(sourceFile(baseDir, segment.path))
  ));
  const canonicalIds = new Set(canonicalRecords.map((record) => record.id));
  const archivedRaw = archivedRawArrays.map((archive) => (
    rawArchiveMetadata(archive, canonicalIds, { baseDir })
  ));
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    subject: {
      name: "真的不懂真的不会",
      xueqiu_user_id: USER_ID,
      profile_url: `https://xueqiu.com/u/${USER_ID}`,
    },
    claims: {
      timeline_posts: canonicalRecords.length,
      cutoff_date: segments.map((segment) => segment.max_date).sort().at(-1),
    },
    segments,
    archived_raw_arrays: archivedRaw,
    limitations: [
      "The 50-post April capture is a raw historical snapshot fully contained by the later 125-post canonical segment and is excluded from claims.",
      "The raw snapshot retains acquisition-only nested fields; only the canonical segment is valid normalized_v1 corpus data.",
      "Public posts do not prove complete positions, returns, or off-platform actions.",
    ],
  };
}

export function validateManifest(manifest = null, { baseDir = skillDir } = {}) {
  const loaded = manifest ?? readJson(sourceFile(baseDir, "references/sources/corpus-manifest.json"));
  const rebuilt = buildManifest({ baseDir });
  if (!isPlainObject(loaded)
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(loaded.generated_at || "")) {
    throw new Error("Dongge corpus manifest must have a timezone-aware generated_at");
  }
  const withoutTimestamp = (value) => {
    const copy = structuredClone(value);
    delete copy.generated_at;
    return copy;
  };
  if (JSON.stringify(withoutTimestamp(loaded)) !== JSON.stringify(withoutTimestamp(rebuilt))) {
    throw new Error("Dongge corpus manifest does not exactly match its declared sources");
  }
  return loaded;
}

export function migrateCanonicalSources() {
  for (const segment of declaredSegments) {
    const absolute = sourceFile(skillDir, segment.path);
    const normalized = readArray(absolute).map((record, index) => (
      normalizeCorpusRecord(record, `${segment.path}[${index}]`, { contract: segment.contract })
    ));
    atomicWrite(absolute, `${JSON.stringify(normalized, null, 2)}\n`);
    console.log(`migrated\t${segment.path}\t${normalized.length}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = new Set(argv);
  if (argv.some((value) => !["--migrate", "--write", "--help"].includes(value))) {
    throw new Error("Unknown Dongge corpus manifest option");
  }
  if (options.has("--help")) {
    console.log("Usage: node scripts/build_corpus_manifest.mjs [--migrate] [--write]");
    return;
  }
  if (options.has("--migrate")) migrateCanonicalSources();
  if (options.has("--migrate") || options.has("--write")) {
    atomicWrite(manifestFile, `${JSON.stringify(buildManifest(), null, 2)}\n`);
    console.log("wrote\treferences/sources/corpus-manifest.json");
  }
  const manifest = validateManifest();
  console.log(`valid\tposts=${manifest.claims.timeline_posts}\tcutoff=${manifest.claims.cutoff_date}`);
}

if (path.resolve(process.argv[1] || "") === scriptFile) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
