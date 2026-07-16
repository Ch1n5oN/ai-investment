# Project Working Agreement

## Safety

- Never commit cookies, browser profiles, tokens, `.claude/settings.local.json`, or files from `output/`.
- Do not run live Xueqiu scraping from automated tests. Tests must use sanitized fixtures or mocks.
- Use a dedicated browser profile for CDP. Bind remote debugging to loopback only.
- Preserve existing research files and uncommitted work unless the task explicitly asks to replace them.

## Data pipeline

- Treat raw, normalized, and derived data as separate layers.
- Keep timestamps timezone-aware and normalize Xueqiu time to `Asia/Shanghai`.
- Never silently replace an unreadable state or corpus file with an empty dataset.
- Write state and corpus files atomically.
- Update the relevant corpus manifest whenever tracked source data changes.

## Verification

- Node changes: run `npm test` and `npm run check:node`.
- Python changes: run `python3 -m unittest discover -s tests/python -v`.
- Skill changes: run the validator in the skill's `scripts/` directory.
- Repository-wide changes: run `npm run check` before handoff.

## Scope

- The Edge/CDP sync is the primary recurring path.
- Cookie-based Python is a fallback path and should share the same data semantics.
- One-off recovery utilities belong under `tools/` or must be clearly marked as legacy.
