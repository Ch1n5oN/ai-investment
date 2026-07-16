# AI Investment Research

This repository collects public Xueqiu content and turns the research notes into local trading-perspective skills.

The current workflow is:

1. Fetch Xueqiu posts, articles, or selected post IDs.
2. Save the raw material as JSON and Markdown.
3. Distill the material into `.claude/skills/*` perspective skills.
4. Use those skills as research assistants for A-share trading analysis.

## Repository Layout

```text
scripts/
  xueqiu_scraper.py           # Cookie-based Python scraper
  xueqiu_incremental_sync.py  # Incremental posts/articles/self-replies sync
  xueqiu_browser_scraper.mjs  # Chrome DevTools/browser-session scraper
  xueqiu_edge_sync.mjs        # Primary recurring Edge/CDP sync
  lib/                        # Shared time, storage, merge, and CDP primitives

output/                       # Local scraped data, ignored by git
.claude/skills/               # Distilled local Claude skills
.agents/                      # Local skill/tool cache, ignored by git
tests/                        # Offline Node and Python regression tests
schemas/                      # Normalized record and sync report contracts
docs/                         # Architecture, operations, and data governance
```

Tracked skills currently include:

- `dongge-perspective`: A-share short-term trading perspective based on "真的不懂真的不会".
- `bingbing-xiaomei-perspective`: A-share trading framework based on "冰冰小美".

## Setup

Python scraper:

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install --require-hashes -r requirements-lock.txt
```

`pyproject.toml` declares the supported dependency range. `requirements-lock.txt`
pins the tested artifacts and hashes for reproducible installation. The Python
test suite verifies that every direct range is satisfied and that the installed
runtime dependency closure exactly matches the hashed lock.

`pyproject.toml` is the sole runtime dependency manifest, while
`requirements-lock.txt` is the sole runtime installation input. An unpinned
`requirements.txt` is intentionally absent so dependency constraints cannot drift
between equivalent manifests. Regenerate the hash lock from `pyproject.toml` when
the runtime dependency range or resolved closure changes.

Run the advisory scanner in an isolated environment so its dependencies do not
replace the application runtime packages:

```bash
python3 -m venv /tmp/ai-investment-pip-audit
/tmp/ai-investment-pip-audit/bin/python -m pip install \
  --require-hashes -r requirements-audit-lock.txt
/tmp/ai-investment-pip-audit/bin/python -m pip_audit \
  --disable-pip --require-hashes -r requirements-lock.txt
/tmp/ai-investment-pip-audit/bin/python -m pip_audit \
  --disable-pip --require-hashes -r requirements-audit-lock.txt
```

Regenerate Python locks only with the separately hash-locked maintenance
environment:

```bash
python3 -m venv /tmp/ai-investment-lock-tools
/tmp/ai-investment-lock-tools/bin/python -m pip install \
  --require-hashes -r requirements-maintenance-lock.txt
/tmp/ai-investment-lock-tools/bin/pip-compile \
  --generate-hashes --output-file=requirements-lock.txt \
  --strip-extras pyproject.toml
/tmp/ai-investment-lock-tools/bin/pip-compile \
  --allow-unsafe --generate-hashes \
  --output-file=requirements-audit-lock.txt \
  --strip-extras requirements-audit.in
/tmp/ai-investment-lock-tools/bin/pip-compile \
  --allow-unsafe --generate-hashes \
  --output-file=requirements-maintenance-lock.txt \
  --strip-extras requirements-maintenance.in
```

`requirements-maintenance.in` pins `pip-tools`; its generated lock also pins and
hashes the complete lock-generation closure. CI installs this closure in an
isolated environment, recompiles all three Python locks, rejects any resulting
diff, and audits the maintenance closure for known vulnerabilities. After changing
the `pip-tools` pin itself, recreate the isolated environment from the new
maintenance lock and run all three commands again before committing.

Node browser scraper:

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts
```

The Node tools use the exact Node.js patch in `.nvmrc` (and require Node 22+)
because they use the built-in `fetch`,
`WebSocket`, and `AbortSignal.timeout` implementations. Playwright is declared
and locked for the one-off article recovery utility. With `nvm`, run `nvm use`
to select the version declared in `.nvmrc`.

Optional local skills are restored from `skills-lock.json`:

```bash
npm run bootstrap:skills
node scripts/bootstrap_skills.mjs --install  # only when the check reports missing skills
```

The install path delegates to the exact CLI version recorded in `skills-lock.json`.
The CLI package and its complete runtime dependency set are bound to npm SRI,
an upstream-compatible snapshot hash, and a length-prefixed audit hash. Every
Skill source is pinned to a full Git commit and the same dual hashes. Declared
local configuration files are preserved but excluded explicitly; `.git`,
`node_modules`, symlinks, undeclared lock fields, and undeclared source paths
fail closed. A failed or unverifiable install restores the complete prior local
Skill tree, including unmanaged Skills. `.DS_Store` is the sole fixed OS-metadata
exclusion from Skill snapshot hashes.

## Python Scraper

The Python scraper sends requests with a Xueqiu login cookie.

Use a user-only cookie file for the fallback scraper:

```bash
chmod 600 /path/to/cookie.txt
python3 scripts/xueqiu_scraper.py --cookie-file /path/to/cookie.txt --user_id 8469219487
```

`XUEQIU_COOKIE` and `--cookie` remain compatible with older automation, but
`--cookie` is deprecated because command arguments can appear in shell history
and process listings.

Common examples:

```bash
# Latest timeline posts
python3 scripts/xueqiu_scraper.py --user_id 8469219487 --mode posts --pages 3 --count 10 --output output/dongge

# Long-form articles
python3 scripts/xueqiu_scraper.py --user_id 7143769715 --mode articles --pages 5 --count 10 --output output/bingbing_xiaomei

# Selected post IDs or full post URLs
python3 scripts/xueqiu_scraper.py --user_id 7143769715 --mode ids --post-ids 244824585,https://xueqiu.com/7143769715/261946270 --output output/selected

# Keep only content from a date onward
python3 scripts/xueqiu_scraper.py --user_id 8469219487 --since-date 2026-04-01 --output output/dongge_incremental
```

## Incremental Sync Script

`scripts/xueqiu_incremental_sync.py` is the script-first entrypoint for recurring updates.
It merges new timeline posts, article-list items, and self replies into stable files in one output directory.

Common examples:

```bash
# Xiaomei: posts + article list + self replies
python3 scripts/xueqiu_incremental_sync.py \
  --user_id 7143769715 \
  --cookie-file /path/to/xueqiu.cookie \
  --output output/bingbing_xiaomei_sync

# Restrict to recent data and skip nested reply chains
python3 scripts/xueqiu_incremental_sync.py \
  --user_id 7143769715 \
  --cookie-file /path/to/xueqiu.cookie \
  --since-date 2026-06-01 \
  --skip-sub-replies \
  --output output/bingbing_xiaomei_sync

# Comments-only refresh for recent posts
python3 scripts/xueqiu_incremental_sync.py \
  --user_id 7143769715 \
  --cookie-file /path/to/xueqiu.cookie \
  --skip-posts \
  --skip-articles \
  --output output/bingbing_xiaomei_sync
```

The script writes:

```text
xueqiu_<user_id>_posts.json/.md
xueqiu_<user_id>_articles.json/.md
xueqiu_<user_id>_self_replies.json/.md
xueqiu_<user_id>_sync_state.json
```

Comment crawling defaults to recent posts only. Tune these flags when needed:

- `--comment-lookback-days`
- `--comment-lookback-posts`
- `--comment-page-limit`
- `--sub-reply-page-limit`
- `--skip-sub-replies`

## Browser Scraper

### Recommended: unified Edge incremental sync

For Xiaomei's recurring updates, use the unified command. It reuses a logged-in
Xueqiu tab in a dedicated local Edge profile through CDP and does not copy
cookies to disk.

Start the isolated profile on loopback only:

```bash
/Applications/Microsoft\ Edge.app/Contents/MacOS/Microsoft\ Edge \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/edge-xueqiu-cdp
```

Log in to Xueqiu in that window, then run:

```bash
npm run sync:xiaomei
```

The normal run refreshes posts and articles, then scans only recent posts whose
`reply_count` increased since the previous successful scan. This avoids the old
full `posts x comment pages x nested replies` crawl.

Use a bounded forced audit when comments may have been missed:

```bash
npm run sync:xiaomei -- --force-comments --comment-posts 5
```

The bounded weekly audit has a named command:

```bash
npm run sync:xiaomei:audit
```

Reliability behavior:

- CDP commands and browser requests have host-side hard timeouts, so a throttled
  background tab cannot hang the process indefinitely.
- Timeline, reply, state, and report files are written atomically.
- WAF responses and API `10020` errors are classified explicitly and retried
  after returning the existing Edge tab to a same-origin Xueqiu page.
- Comment checkpoints advance only for posts whose scan completed. A partial run
  remains eligible on the next run instead of being silently skipped.
- A full final timeline/article page at the configured page limit is recorded as
  truncation and returns `2`; increase the limit or supply a verified date boundary.
- `xueqiu_<user_id>_edge_sync_report.json` records request counts, elapsed time,
  selected posts, pagination truncation, added items, and one of:
  `complete`, `needs_verification`, or `failed`.
- `complete` means the selected posts' main comment streams were covered. Xueqiu's
  recursive child-reply endpoint frequently returns `10020`, so the report keeps
  `nested_reply_coverage: not_guaranteed_api_10020` instead of claiming a full
  recursive tree.

Useful options:

```bash
npm run sync:xiaomei -- --help
npm run sync:xiaomei -- --skip-comments
npm run sync:xiaomei -- --since-date 2026-07-01
```

Before relying on a changed private endpoint, run the bounded manual smoke check.
It refuses to start unless live access and a dedicated profile are both confirmed,
accepts only a loopback CDP endpoint, and confines every generated file to a new
OS temporary directory:

```bash
npm run smoke:xueqiu -- \
  --confirm-live-xueqiu \
  --confirm-dedicated-profile

# Optional: also inspect one recent post's main comment stream.
npm run smoke:xueqiu -- \
  --confirm-live-xueqiu \
  --confirm-dedicated-profile \
  --include-comments
```

The printed report includes `interface_drift.detected` and structured signals for
missing endpoints, unexpected response shapes, invalid JSON/HTML, and content-type
changes. WAF and the known `API_10020` limitation remain separate operational
conditions rather than being mislabeled as contract drift. The wrapper validates
the complete terminal-report schema and rejects any mismatch between report status
and child exit code.

Edge must already be running with remote debugging on loopback port `9222`, with
a logged-in Xueqiu tab open. Close the dedicated browser after the sync. Do not
expose a debugging port for a daily-use browser profile.

### Low-level browser scraper

The browser scraper reuses a logged-in Chrome session through the Chrome DevTools Protocol. This is usually more reliable when Xueqiu rejects copied cookies.

Start Chrome with remote debugging:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-xueqiu-cdp
```

Log in to `https://xueqiu.com` in that Chrome window, then run:

```bash
# Posts
npm run scrape:browser -- --user_id 8469219487 --mode posts --pages 3 --count 10 --output output/dongge_incremental

# Articles
npm run scrape:browser -- --user_id 7143769715 --mode articles --pages 5 --count 10 --output output/bingbing_xiaomei_full

# Selected IDs, with resume support
npm run scrape:browser -- --user_id 7143769715 --mode ids --post-ids-file post_ids.txt --resume --output output/framework_links
```

Supported modes:

- `posts`: user timeline posts.
- `articles`: original/column timeline.
- `both`: posts and articles.
- `ids`: selected post IDs or URLs.

### Legacy recovery utilities

`xueqiu_comments_resume.mjs` and `xueqiu_playwright_article_fetch.mjs` are kept
for bounded recovery of historical comment scans or individual article pages.
They are not recurring sync entrypoints. New reliability behavior belongs in
the shared modules and `xueqiu_edge_sync.mjs`.

## Output Format

Every run writes two files:

```text
xueqiu_<user_id>_<suffix>.json
xueqiu_<user_id>_<suffix>.md
```

JSON is for later processing. Markdown is for reading and distillation.

Normalized records use timezone-aware `Asia/Shanghai` timestamps,
`schema_version: 1`, and an explicit `record_contract`. New acquisition output
uses `normalized_v1`; tracked historical segments declare a narrower legacy,
no-view-count, framework-link, or external framework-index-source contract
instead of inventing missing values. Historical snapshots that duplicate the
canonical corpus are listed as excluded archives and never contribute to claims.
The executable schemas are checked against every tracked record in CI. State
and output files are replaced atomically. An existing invalid JSON file is a
hard failure and is never interpreted as an empty first run. See
[`docs/architecture.md`](docs/architecture.md) and
[`docs/data-governance.md`](docs/data-governance.md).

## Exit Codes

All maintained sync entrypoints use these automation semantics:

- `0`: requested streams completed with the declared coverage.
- `2`: usable partial output exists, but verification or a retry is required.
- `1`: failed; incomplete checkpoints are not advanced.

Always inspect the Edge JSON report when a run returns `2`. Operational recovery
steps are in [`docs/operations.md`](docs/operations.md).

Python advisory scanning runs in a separate CI job so audit tooling cannot alter
the application runtime closure. The scanner and all of its dependencies are
hash-locked in `requirements-audit-lock.txt`; the runtime input remains
`requirements-lock.txt`.

## Skill Corpus

The Xiaomei and Dongge skills have machine-verifiable corpus manifests. Their
counts, cutoffs, unique IDs, hashes, and excluded historical snapshots are
checked against tracked sources rather than duplicated as constants in validators.

```bash
# Normalize every declared tracked segment/archive and rebuild manifest hashes
node .claude/skills/bingbing-xiaomei-perspective/scripts/build_corpus_manifest.mjs --migrate

# Refresh tracked corpus segments from successful local acquisition output
node .claude/skills/bingbing-xiaomei-perspective/scripts/build_corpus_manifest.mjs --refresh

# Normalize/rebuild Dongge's canonical 125-post segment and raw archive declaration
node .claude/skills/dongge-perspective/scripts/build_corpus_manifest.mjs --migrate

# After an intentional Skill/evidence change, atomically refresh provenance hashes
node .claude/skills/bingbing-xiaomei-perspective/scripts/validate_skill.mjs --write-provenance

# Offline integrity and Skill-claim checks
npm run test:skill
```

The refresh command requires the referenced files under `output/`; validation
uses only tracked Skill sources and works in a clean clone. Manifest provenance
uses a canonical semantic digest that excludes only the rebuild timestamp, so a
no-op manifest rebuild does not create a false provenance failure.

## Validation

Run the full offline checks before committing changes:

```bash
npm run check
```

This runs Node syntax checks, static linting, Node tests, Python tests, corpus
hash validation, and Skill claim validation. CI runs the same command with Node 22 and Python
3.11/3.12/3.13. Tests use local fixtures and mocks; they never contact Xueqiu.

## Safety Notes

- Never commit cookies, tokens, browser profiles, or raw credentials.
- `output/` is ignored because scraped data can be large and may include personal research material.
- Keep `.claude/settings.local.json` and locally installed skill links untracked.
- Xueqiu endpoints are private and can change without notice. Treat scraper failures as expected maintenance, not as stable API regressions.
- Trading-perspective skills are research tools, not investment advice. Always verify latest market data before using them for live decisions.
