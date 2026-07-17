#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCorpusManifest } from "./build_corpus_manifest.mjs";

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const researchDir = path.join(skillDir, "references", "research");
const manifest = validateCorpusManifest();

function loadKind(kind) {
  return manifest.segments
    .filter((segment) => segment.kind === kind)
    .flatMap((segment) => JSON.parse(fs.readFileSync(path.join(skillDir, segment.path), "utf8")));
}

const timeline = loadKind("timeline").filter((item) => String(item.created_at || "").startsWith("2026-"));
const replies = loadKind("replies");

const themes = {
  "三要素与市场结构": /三要素|竞争格局|比较优势|流动性|情绪位置|赚钱效应|亏钱效应|抱团|扩散/,
  "仓位与交易纪律": /仓位|分仓|减仓|加仓|清仓|建仓|做T|成本|利润垫|睡得着|空仓|买入初心|卖出计划|止损/,
  "周期与价值投机": /周期|价值投机|库存|供需|涨价|降价|价格因子|化工|有色|铜|白银|黄金|锂|猪周期/,
  "AI与产业命门": /AI|Ai|人工智能|算力|芯片|半导体|光模块|CPO|PCB|英伟达|英特尔|大模型|命门|正宗|伪科技/,
  "宏观国运与全球流动性": /国运|中美|美国|美元|美债|人民币|央妈|央行|财政|货币|加杠杆|罗斯福|G2|石油|战争/,
  "ETF与普通人路径": /ETF|Etf|etf|基金|指数|权重|组合|定投/,
  "信息训练与反抄作业": /作业|抄作业|信息与金融|信息收集|学习|查询|关键词|文章|帖子|看书|蒸馏|知识/,
  "风险、纠错与不确定性": /风险|纠错|错了|看错|不确定|走一步看一步|没把握|可能|概率|预判|预测|尊重市场/,
};

const phrases = [
  "竞争格局", "流动性", "情绪位置", "三要素", "价值投机", "冰点", "买入初心",
  "睡得着", "做T", "仓位", "加仓", "减仓", "ETF", "抄作业", "信息与金融",
  "走一步看一步", "尊重市场", "可能", "不确定", "正宗", "伪科技", "国运", "周期",
];

function textOf(item) {
  return String(item.clean_text || item.text || "").replace(/\s+/g, " ").trim();
}

function monthOf(item) {
  return String(item.created_at || "unknown").slice(0, 7);
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function countMatches(items, pattern) {
  return items.reduce((count, item) => count + (pattern.test(textOf(item)) ? 1 : 0), 0);
}

function phraseCount(items, phrase) {
  return items.reduce((count, item) => count + textOf(item).split(phrase).length - 1, 0);
}

function topExamples(items, pattern, limit = 6) {
  return items
    .filter((item) => pattern.test(textOf(item)))
    .sort((a, b) => (b.like_count || 0) - (a.like_count || 0) || textOf(b).length - textOf(a).length)
    .slice(0, limit);
}

function sentenceStats(items) {
  const texts = items.map(textOf).filter(Boolean);
  const chars = texts.reduce((sum, text) => sum + text.length, 0);
  const sentences = texts.reduce((sum, text) => sum + Math.max(1, text.split(/[。！？!?；;\n]+/).filter(Boolean).length), 0);
  const questionTexts = texts.filter((text) => /[？?]/.test(text)).length;
  const firstPersonTexts = texts.filter((text) => /我|咱/.test(text)).length;
  return {
    averageChars: chars / texts.length,
    averageSentenceChars: chars / sentences,
    questionTextRate: questionTexts / texts.length,
    firstPersonTextRate: firstPersonTexts / texts.length,
  };
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

const postStats = sentenceStats(timeline);
const replyStats = sentenceStats(replies);
const replyToCount = replies.filter((item) => item.reply_to != null || textOf(item).startsWith("回复@")).length;
const shortReplyCount = replies.filter((item) => textOf(item).length <= 30).length;
const questionReplyCount = replies.filter((item) => /[？?]/.test(textOf(item))).length;
const cutoffEpoch = Date.parse(`${manifest.claims.cutoff_date}T00:00:00+08:00`);
const recentStart = new Date(cutoffEpoch - 10 * 24 * 60 * 60 * 1000 + 8 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
const latestPosts = timeline
  .filter((item) => String(item.created_at) >= recentStart)
  .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
const generatedDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

const lines = [
  "# 冰冰小美 2026 全年语料统计与证据索引",
  "",
  `> 自动生成日期：${generatedDate}`,
  `> 数据截止：${manifest.claims.cutoff_date}`,
  "> 范围：本人2026年雪球时间线，以及这些帖子评论区中由本人发布的回复。",
  "",
  "## 1. 语料规模",
  "",
  `- 时间线：${timeline.length}篇；日期 ${timeline.map((x) => x.created_at).sort()[0]} 至 ${timeline.map((x) => x.created_at).sort().at(-1)}。`,
  `- 本人回复：${replies.length}条；日期 ${replies.map((x) => x.created_at).sort()[0]} 至 ${replies.map((x) => x.created_at).sort().at(-1)}。`,
  `- 明确回复他人：${replyToCount}条（${pct(replyToCount / replies.length)}）。`,
  `- 30字以内短回复：${shortReplyCount}条（${pct(shortReplyCount / replies.length)}）。`,
  `- 含问号回复：${questionReplyCount}条（${pct(questionReplyCount / replies.length)}）。`,
  "",
  "### 月度分布",
  "",
  "| 月份 | 时间线 | 本人回复 |",
  "|---|---:|---:|",
  ...[...new Set([...countBy(timeline, monthOf).map(([m]) => m), ...countBy(replies, monthOf).map(([m]) => m)])]
    .sort()
    .map((month) => `| ${month} | ${timeline.filter((x) => monthOf(x) === month).length} | ${replies.filter((x) => monthOf(x) === month).length} |`),
  "",
  "## 2. 主题覆盖",
  "",
  "| 主题 | 时间线命中 | 回复命中 |",
  "|---|---:|---:|",
  ...Object.entries(themes).map(([name, pattern]) => `| ${name} | ${countMatches(timeline, pattern)} | ${countMatches(replies, pattern)} |`),
  "",
  "## 3. 标志性词汇频次",
  "",
  "| 词语 | 时间线次数 | 回复次数 |",
  "|---|---:|---:|",
  ...phrases.map((phrase) => `| ${phrase} | ${phraseCount(timeline, phrase)} | ${phraseCount(replies, phrase)} |`),
  "",
  "## 4. 表达统计",
  "",
  "| 指标 | 时间线 | 回复 |",
  "|---|---:|---:|",
  `| 平均文本长度 | ${postStats.averageChars.toFixed(1)}字 | ${replyStats.averageChars.toFixed(1)}字 |`,
  `| 平均分句长度 | ${postStats.averageSentenceChars.toFixed(1)}字 | ${replyStats.averageSentenceChars.toFixed(1)}字 |`,
  `| 含问号文本比例 | ${pct(postStats.questionTextRate)} | ${pct(replyStats.questionTextRate)} |`,
  `| 第一人称文本比例 | ${pct(postStats.firstPersonTextRate)} | ${pct(replyStats.firstPersonTextRate)} |`,
  "",
  "## 5. 各主题代表性回复",
  "",
];

for (const [name, pattern] of Object.entries(themes)) {
  lines.push(`### ${name}`, "");
  for (const item of topExamples(replies, pattern)) {
    lines.push(`- ${item.created_at}｜评论 ${item.id}｜帖子 ${item.post_id}｜赞 ${item.like_count || 0}：${textOf(item).slice(0, 260)}`);
  }
  lines.push("");
}

lines.push("## 6. 截止日前新增时间线", "");
for (const item of latestPosts) {
  lines.push(`- ${item.created_at}｜${item.id}｜回复数 ${item.reply_count || 0}：${textOf(item).slice(0, 300)}`);
}

lines.push(
  "",
  "## 7. 使用限制",
  "",
  "- 主题命中是关键词统计，只用于定位证据，不能替代人工语义判断。",
  "- 回复语料仅覆盖她自己2026年帖子评论区中的本人回复，不覆盖她在其他用户帖子下的评论。",
  "- 二级子回复链受 API 10020 限制，不能宣称全量覆盖。",
  "- 点赞数只反映平台互动，不等于论点的重要性或正确性。",
  "",
);

fs.mkdirSync(researchDir, { recursive: true });
const output = path.join(researchDir, `33-corpus-analysis-through-${manifest.claims.cutoff_date}.md`);
const temporary = `${output}.tmp-${process.pid}`;
fs.writeFileSync(
  temporary,
  `${lines.map((line) => line.trimEnd()).join("\n").trimEnd()}\n`,
  "utf8",
);
fs.renameSync(temporary, output);
console.log(`wrote ${output}`);
