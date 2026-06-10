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
  xueqiu_browser_scraper.mjs  # Chrome DevTools/browser-session scraper

output/                       # Local scraped data, ignored by git
.claude/skills/               # Distilled local Claude skills
.agents/                      # Local skill/tool cache, ignored by git
```

Tracked skills currently include:

- `dongge-perspective`: A-share short-term trading perspective based on "真的不懂真的不会".
- `bingbing-xiaomei-perspective`: A-share trading framework based on "冰冰小美".

## Setup

Python scraper:

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Node browser scraper:

```bash
npm install
```

The Node script expects Node.js 20+ because it uses built-in `fetch` and `WebSocket`.

## Python Scraper

The Python scraper sends requests with a Xueqiu login cookie.

You can pass the cookie in three ways:

```bash
python3 scripts/xueqiu_scraper.py --cookie "YOUR_COOKIE" --user_id 8469219487
python3 scripts/xueqiu_scraper.py --cookie-file /path/to/cookie.txt --user_id 8469219487
XUEQIU_COOKIE="YOUR_COOKIE" python3 scripts/xueqiu_scraper.py --user_id 8469219487
```

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

## Browser Scraper

The browser scraper reuses a logged-in Chrome session through the Chrome DevTools Protocol. This is usually more reliable when Xueqiu rejects copied cookies.

Start Chrome with remote debugging:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
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

## Output Format

Every run writes two files:

```text
xueqiu_<user_id>_<suffix>.json
xueqiu_<user_id>_<suffix>.md
```

JSON is for later processing. Markdown is for reading and distillation.

## Validation

Run the lightweight checks before committing changes:

```bash
python3 -m py_compile scripts/xueqiu_scraper.py
node --check scripts/xueqiu_browser_scraper.mjs
```

## Safety Notes

- Never commit cookies, tokens, browser profiles, or raw credentials.
- `output/` is ignored because scraped data can be large and may include personal research material.
- Xueqiu endpoints are private and can change without notice. Treat scraper failures as expected maintenance, not as stable API regressions.
- Trading-perspective skills are research tools, not investment advice. Always verify latest market data before using them for live decisions.
