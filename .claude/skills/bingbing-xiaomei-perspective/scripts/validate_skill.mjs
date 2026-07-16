#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWrite, validateCorpusManifest } from "./build_corpus_manifest.mjs";

const scriptFile = fileURLToPath(import.meta.url);
export const skillDir = path.resolve(path.dirname(scriptFile), "..");
export const provenanceFile = path.join(skillDir, "references", "sources", "redistillation-provenance.json");

export const requiredEvidence = Object.freeze([
  ["references/sources/corpus-manifest.json", "corpus_manifest"],
  ["references/research/01-writings.md", "research_writings"],
  ["references/research/02-conversations.md", "research_conversations"],
  ["references/research/03-expression-dna.md", "research_expression"],
  ["references/research/04-external-views.md", "research_external_views"],
  ["references/research/05-decisions.md", "research_decisions"],
  ["references/research/06-timeline.md", "research_timeline"],
  ["references/research/33-corpus-analysis-through-2026-07-14.md", "corpus_analysis"],
  ["references/research/34-complete-redistill-2026-07-15.md", "complete_redistillation"],
  ["references/research/35-complete-redistill-validation-2026-07-15.md", "redistillation_validation"],
  ["evaluations/cases.json", "behavioral_evaluations"],
].map((entry) => Object.freeze(entry)));

const MANIFEST_EVIDENCE_PATH = "references/sources/corpus-manifest.json";
const REQUIRED_EVALUATION_CASE_IDS = Object.freeze([
  "three-factor-analysis",
  "anti-copy-boundary",
  "stale-holdings",
  "uncertainty-and-action",
  "position-risk",
  "multi-perspective-separation",
  "role-exit",
  "macro-position-priority",
  "pricing-function-failure",
  "fact-opinion-inference-separation",
  "style-consistency",
  "ambiguous-exit-word",
]);

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

export function evidenceSha256(file, relativePath) {
  if (relativePath !== MANIFEST_EVIDENCE_PATH) return sha256(file);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  delete manifest.generated_at;
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(manifest))).digest("hex");
}

function formatShanghaiTimestamp(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error("Invalid provenance timestamp");
  return `${new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19)}+08:00`;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} fields must be exactly: ${expected.join(", ")}`);
  }
}

function inside(baseDir, relative, label) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a relative path`);
  }
  const base = path.resolve(baseDir);
  const absolute = path.resolve(base, relative);
  if (absolute === base || !absolute.startsWith(`${base}${path.sep}`)) {
    throw new Error(`${label} escapes the skill directory`);
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a symlink`);
  }
  const realBase = fs.realpathSync(base);
  const realAbsolute = fs.realpathSync(absolute);
  if (!realAbsolute.startsWith(`${realBase}${path.sep}`)) {
    throw new Error(`${label} resolves outside the skill directory`);
  }
  return absolute;
}

export function parseFrontmatter(markdown) {
  const block = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(markdown)?.[1];
  if (!block) throw new Error("SKILL.md must begin with YAML frontmatter");
  const name = /^name:\s*([^\n]+)$/m.exec(block)?.[1]?.trim();
  const lines = block.split("\n");
  const descriptionStart = lines.findIndex((line) => /^description:\s*\|\s*$/.test(line));
  if (descriptionStart < 0) throw new Error("Frontmatter description must use a literal block");
  const descriptionLines = [];
  for (const line of lines.slice(descriptionStart + 1)) {
    if (/^[^\s]/.test(line)) break;
    if (!/^ {2}/.test(line)) throw new Error("Frontmatter description lines must use two-space indentation");
    descriptionLines.push(line.slice(2));
  }
  if (!descriptionLines.length) throw new Error("Frontmatter description must not be empty");
  return { name, description: descriptionLines.join("\n") };
}

export function extractSection(markdown, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^## ${escaped}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m").exec(markdown)?.[1] || "";
}

export function descriptionClaims(description) {
  const match = /基于(\d+)条专栏记录（基线多数为摘要）、(\d+)篇体系链接帖、项目二手记录所称的(\d+)期雪球官方播客（本地无节目页元数据，未独立复核）、2026年(\d+)条本人时间线与(\d+)条可识别本人回复（(\d+)条基线 \+ (\d+)条平铺增量，截止(\d{4}-\d{2}-\d{2})/.exec(description);
  if (!match) throw new Error("Frontmatter description must carry the structured corpus claim sentence");
  const [, articles, frameworkLinks, podcasts, timeline, repliesTotal, repliesBaseline, repliesIncremental, cutoff] = match;
  return {
    articles: Number(articles),
    framework_links: Number(frameworkLinks),
    reported_official_podcasts: Number(podcasts),
    timeline_2026: Number(timeline),
    replies_baseline: Number(repliesBaseline),
    replies_incremental: Number(repliesIncremental),
    replies_total: Number(repliesTotal),
    cutoff_date: cutoff,
  };
}

export function validateDescriptionClaims(description, claims) {
  const parsed = descriptionClaims(description);
  if (JSON.stringify(parsed) !== JSON.stringify(claims)) {
    throw new Error(`Frontmatter corpus claims do not match the manifest: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

function nonEmptyStringArray(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === "string" && item.trim().length > 0)
    && new Set(value).size === value.length;
}

export function validateEvaluationCases(evaluations) {
  exactKeys(evaluations, ["schema_version", "cases"], "Behavioral evaluation specification");
  if (evaluations.schema_version !== 1) throw new Error("Unsupported behavioral evaluation schema");
  if (!Array.isArray(evaluations.cases)) throw new Error("Behavioral evaluation cases must be an array");
  const ids = new Set();
  const prompts = new Set();
  for (const [index, item] of evaluations.cases.entries()) {
    exactKeys(
      item,
      ["id", "prompt", "required_behaviors", "forbidden_behaviors"],
      `Behavioral evaluation case[${index}]`,
    );
    if (typeof item.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id)) {
      throw new Error(`Behavioral evaluation case[${index}].id must be a kebab-case string`);
    }
    if (ids.has(item.id)) throw new Error(`Duplicate behavioral evaluation ID: ${item.id}`);
    ids.add(item.id);
    if (typeof item.prompt !== "string" || !item.prompt.trim()) {
      throw new Error(`Behavioral evaluation case[${index}].prompt must be a non-empty string`);
    }
    if (prompts.has(item.prompt)) throw new Error(`Duplicate behavioral evaluation prompt: ${item.prompt}`);
    prompts.add(item.prompt);
    if (!nonEmptyStringArray(item.required_behaviors)) {
      throw new Error(`Behavioral evaluation case[${index}].required_behaviors must be unique non-empty strings`);
    }
    if (!nonEmptyStringArray(item.forbidden_behaviors)) {
      throw new Error(`Behavioral evaluation case[${index}].forbidden_behaviors must be unique non-empty strings`);
    }
  }
  const missing = REQUIRED_EVALUATION_CASE_IDS.filter((id) => !ids.has(id));
  if (missing.length) throw new Error(`Behavioral evaluation specification is missing cases: ${missing.join(", ")}`);
  return evaluations;
}

export function buildProvenance({
  baseDir = skillDir,
  claims = null,
  generatedAt = formatShanghaiTimestamp(),
} = {}) {
  const skillPath = inside(baseDir, "SKILL.md", "Skill path");
  const resolvedClaims = claims ?? validateCorpusManifest(null, { baseDir }).claims;
  return {
    schema_version: 1,
    generated_at: generatedAt,
    skill: "SKILL.md",
    skill_sha256: sha256(skillPath),
    claims: resolvedClaims,
    evidence: requiredEvidence.map(([relativePath, role]) => {
      const absolute = inside(baseDir, relativePath, `Evidence path ${relativePath}`);
      return {
        path: relativePath,
        role,
        sha256: evidenceSha256(absolute, relativePath),
      };
    }),
  };
}

export function validateProvenance({ baseDir = skillDir, provenance, skillText, claims }) {
  exactKeys(
    provenance,
    ["schema_version", "generated_at", "skill", "skill_sha256", "claims", "evidence"],
    "Redistillation provenance",
  );
  if (provenance.schema_version !== 1) throw new Error("Unsupported redistillation provenance schema");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(provenance.generated_at)) {
    throw new Error("Redistillation provenance generated_at must be an Asia/Shanghai timestamp");
  }
  if (provenance.skill !== "SKILL.md") throw new Error("Redistillation provenance must bind SKILL.md");
  if (provenance.skill_sha256 !== crypto.createHash("sha256").update(skillText).digest("hex")) {
    throw new Error("SKILL.md hash does not match redistillation provenance");
  }
  if (JSON.stringify(provenance.claims) !== JSON.stringify(claims)) {
    throw new Error("Redistillation provenance claims do not match the corpus manifest");
  }
  if (!Array.isArray(provenance.evidence) || provenance.evidence.length !== requiredEvidence.length) {
    throw new Error("Redistillation provenance must contain the exact required evidence set");
  }
  const expected = new Map(requiredEvidence);
  const seen = new Set();
  for (const [index, item] of provenance.evidence.entries()) {
    exactKeys(item, ["path", "role", "sha256"], `Redistillation evidence[${index}]`);
    if (seen.has(item.path)) throw new Error(`Duplicate redistillation evidence: ${item.path}`);
    seen.add(item.path);
    if (expected.get(item.path) !== item.role) {
      throw new Error(`Unexpected redistillation evidence path or role: ${item.path}`);
    }
    if (!/^[a-f\d]{64}$/.test(item.sha256 || "")) throw new Error(`Invalid evidence SHA-256: ${item.path}`);
    const absolute = inside(baseDir, item.path, `Evidence path ${item.path}`);
    if (evidenceSha256(absolute, item.path) !== item.sha256) {
      throw new Error(`Evidence hash mismatch: ${item.path}`);
    }
  }
  if (seen.size !== expected.size || [...expected.keys()].some((entry) => !seen.has(entry))) {
    throw new Error("Redistillation provenance is missing required evidence");
  }
  return provenance;
}

function passes(callback) {
  try {
    callback();
    return true;
  } catch {
    return false;
  }
}

export function runValidation({ baseDir = skillDir } = {}) {
  const skillPath = inside(baseDir, "SKILL.md", "Skill path");
  const provenancePath = inside(
    baseDir,
    "references/sources/redistillation-provenance.json",
    "Redistillation provenance path",
  );
  const evaluationsPath = inside(baseDir, "evaluations/cases.json", "Behavioral evaluation path");
  const skill = fs.readFileSync(skillPath, "utf8");
  const frontmatter = parseFrontmatter(skill);
  const manifest = validateCorpusManifest(null, { baseDir });
  const claims = manifest.claims;
  const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
  const evaluations = JSON.parse(fs.readFileSync(evaluationsPath, "utf8"));
  const workflow = extractSection(skill, "回答工作流（Agentic Protocol）");
  const models = extractSection(skill, "核心心智模型");
  const heuristics = extractSection(skill, "决策启发式");
  const roleRules = extractSection(skill, "角色扮演规则（最重要）");
  const honesty = extractSection(skill, "诚实边界");
  const modelCount = (models.match(/^### 模型\d+[:：]/gm) || []).length;
  const heuristicCount = (heuristics.match(/^\d+\. \*\*/gm) || []).length;
  const evaluationCasesValid = passes(() => validateEvaluationCases(evaluations));

  const checks = [
    ["frontmatter name", frontmatter.name === "bingbing-xiaomei-perspective"],
    ["frontmatter corpus claims", passes(() => validateDescriptionClaims(frontmatter.description, claims))],
    ["redistillation provenance", passes(() => validateProvenance({ baseDir, provenance, skillText: skill, claims }))],
    ["7 mental models", modelCount === 7],
    ["10 heuristics", heuristicCount === 10],
    ["fact-first workflow", workflow.includes("事实账本")],
    ["agentic protocol", workflow.length > 0],
    ["three-factor workflow", workflow.includes("竞争格局、流动性、情绪位置")],
    ["macro-position priority", workflow.includes("宏观与问题相关且前提经核验")],
    ["pricing-function model", models.includes("市场生态与定价功能")],
    ["explicit fact separation", workflow.includes("已证事实 / 作者公开判断 / Skill 推断")],
    ["exclusive-chain self-check", workflow.includes("排他性自检")],
    ["uncertainty handling", /不知道|不确定/.test(roleRules)],
    ["anti-copy boundary", frontmatter.description.includes("不提供可直接照抄的买卖指令")],
    [
      "manipulation-attribution boundary",
      honesty.includes("不能由 Skill 转述为事实") && honesty.includes("待验证假说"),
    ],
    ["nested-reply limitation", honesty.includes("不能宣称全量")],
    ["tracked source references", !skill.includes("`output/")],
    ["behavioral evaluation specification", evaluationCasesValid],
  ];
  return checks;
}

function printHelp() {
  console.log(`Usage: node scripts/validate_skill.mjs [options]

Options:
  --write-provenance  Atomically regenerate the tracked provenance hashes, then validate.
  --help              Show this help.`);
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length > 1) throw new Error("Expected at most one option");
  if (argv[0] === "--help") {
    printHelp();
    return 0;
  }
  if (argv.length && argv[0] !== "--write-provenance") {
    throw new Error(`Unknown option: ${argv[0]}`);
  }
  if (argv[0] === "--write-provenance") {
    const claims = validateCorpusManifest().claims;
    const provenance = buildProvenance({ claims });
    atomicWrite(provenanceFile, `${JSON.stringify(provenance, null, 2)}\n`);
    console.log(`wrote\t${path.relative(skillDir, provenanceFile)}`);
  }
  const checks = runValidation();
  const failures = checks.filter(([, pass]) => !pass);
  for (const [name, pass] of checks) console.log(`${pass ? "PASS" : "FAIL"}\t${name}`);
  console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);
  return failures.length ? 1 : 0;
}

if (path.resolve(process.argv[1] || "") === scriptFile) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
