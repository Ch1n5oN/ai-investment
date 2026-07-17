# Optimization Implementation Audit

Audit date: 2026-07-17

## Reproducibility

- Node is pinned to 22.22.0 through `.nvmrc` and CI; npm is pinned to 10.9.4 and checked at runtime.
- Node dependencies are exact and captured in `package-lock.json`.
- Python supports 3.11+; `pyproject.toml` is the sole runtime dependency manifest,
  `requirements-lock.txt` is the sole runtime installation input, and tests prove
  that its hashed installed closure satisfies the declared ranges. The redundant
  unpinned `requirements.txt` entrypoint was removed to prevent manifest drift.
- Python lock generation uses a separately hash-locked `pip-tools 7.5.3`
  environment. CI recompiles the runtime, audit, and maintenance locks and rejects
  any diff before auditing all three dependency closures.
- `skills-lock.json` pins full commits, the local installer and its runtime dependencies. Upstream-compatible and length-prefixed hashes are both checked; installation failures roll back the complete local Skill tree.
- A clean directory install from both lock files completed successfully before handoff.

## Reliability and correctness

- All maintained writers use atomic replacement.
- Existing invalid JSON is a hard error and is not replaced with an empty dataset.
- Node CDP commands have host-side timeouts; browser-side requests have bounded timeouts and exponential backoff with jitter.
- CDP discovery and websocket endpoints reject non-loopback hosts, and browser discovery accepts only actual Xueqiu hostnames.
- Python retries transient HTTP failures and treats HTTP 200 API error payloads as failures.
- All maintained timeline/comment endpoints reject missing or incorrectly typed array fields, even when HTTP returns 200.
- Browser IDs mode validates HTML status, content type, WAF markers, and post-body shape; an all-failed batch exits `1` without creating or replacing corpus output, while usable partial output exits `2`.
- `--reply-pages` is wired into actual pagination.
- Full final timeline pages and comment page-limit truncation return `needs_verification`; truncated posts do not advance Edge reply-count checkpoints.
- Explicitly terminated comment streams distinguish visible coverage from the
  final page's platform-declared count. Quantified visibility gaps remain
  in state/report while their accessible stream advances its checkpoint; inferred
  short reads and contradictory counts still remain unverified.
- Incremental timeline scans confirm a `since-date` boundary only after a second
  pageable batch remains entirely older and the non-pinned sequence stays in
  descending timestamp order. A single old item, an old pin, an unknown time,
  or out-of-order pages cannot hide later records or suppress truncation.
- A marked pinned timeline record returned outside the requested page size is
  retained in the corpus but excluded from pagination accounting; unmarked or
  otherwise unexplained overflow still fails closed.
- Article-list records that omit interaction counts are hydrated from the
  matching status-detail endpoint. Missing detail counts or a mismatched detail
  ID fails the complete article stream instead of inventing values.
- Existing corpus records are validated individually before merge; missing IDs, invalid counts, duplicate IDs, or malformed records fail closed instead of being dropped.
- Edge sync preflights all stored post, article, and reply records before opening
  a CDP session or mutating corpus/state output. Its one supported reply
  predecessor (schema 1 without `record_contract` or
  `post_created_at_raw`) is upgraded with string IDs, a preserved raw post
  timestamp, and an explicit `legacy_migrated_fields` audit trail; malformed
  current-contract records still fail closed.
- Timestamps are normalized to timezone-aware `Asia/Shanghai` values while preserving the raw timestamp; the raw value is authoritative and a conflicting normalized value fails closed.
- Every post/reply record carries a canonical Xueqiu HTTPS URL. Known user/post IDs can repair a missing target, while external hosts, credentials, and non-standard ports are rejected.
- Normalized records and sync reports declare schema version 1; maintained
  acquisition records also declare `record_contract: normalized_v1`.
- Exit codes are `0` complete, `2` needs verification, and `1` failed.

## Architecture

- `scripts/lib/xueqiu_core.mjs` owns argument validation, time normalization, response classification, strict storage, merge semantics, and coverage status.
- `scripts/lib/cdp_session.mjs` owns CDP discovery, lifecycle, activation, navigation, and command timeouts.
- Edge sync is the primary recurring path. Comment-resume and Playwright article tools are explicitly marked as legacy recovery utilities.
- Data and report contracts are declared under `schemas/`.

## Corpus and Skill

- `corpus-manifest.json` derives and verifies 1645 timeline records through 2026-07-17 and 1925 reply records through 2026-07-14.
- Every canonical segment records count, unique IDs, date range, SHA-256 hash, origin, and coverage role.
- The manifest requires the exact complete segment descriptor set and validates
  all 3,772 canonical records against executable schema-1 contract discriminators:
  string IDs, preserved raw timestamps, Asia/Shanghai timestamps, canonical
  URLs, integer counts, and explicit historical gaps.
- Four superseded research snapshots (258 records) are hash-bound, prove 100%
  ID overlap with canonical segments, and are explicitly excluded from claims.
- The external framework-index page was reduced to its embedded structured
  status payload; captured scripts and client IP context are no longer retained.
- The Dongge Skill declares 125 canonical normalized posts through 2026-05-12;
  its older 50-record raw snapshot proves 50/50 ID overlap and is explicitly
  excluded from claims instead of being ambiguously double-counted.
- Skill claims now use 1512 baseline replies plus 413 incremental replies; they no longer reference ignored `output/` paths.
- The latest generated evidence index covers all manifest segments.
- Twelve behavioral evaluation cases additionally cover verified macro inputs, pricing-function failure, fact/opinion/inference separation, style consistency, and ambiguous role-exit wording.

## Verification evidence

- `npm run check`: syntax, CLI imports, lint, Node tests, Python tests, manifest validation, and Skill validation.
- Node critical-core line coverage is above the enforced threshold; orchestration
  safety tests separately exercise Edge, browser, bootstrap, and legacy recovery
  boundaries.
- Fixture tests cover Edge/browser full-page truncation, malformed HTTP 200 responses, WAF checkpoint advancement, Python all-failed/partial status semantics, and manifest descriptor/record tampering.
- A bounded manual smoke check on 2026-07-17 reproduced and fixed current
  first-page pin and article-list response shapes. The final probe reported no
  interface drift; its `needs_verification` result was caused only by the
  intentionally one-page timeline and comment limits.
- CI is configured to repeat the repository check on Python 3.11, 3.12, and 3.13 with Node 22.22.0.
- JSON manifests/schemas and GitHub workflow YAML were parsed independently.
- `npm audit` reported zero known vulnerabilities. Python dependencies are
  hash-locked and range-validated; a separate CI job installs the independently
  hash-locked maintenance closure, verifies lock reproducibility, installs the
  independently hash-locked `pip-audit` tool closure, and audits
  `requirements-lock.txt`, `requirements-audit-lock.txt`, and
  `requirements-maintenance-lock.txt` without resolving or installing the runtime
  dependencies.
- The first Python advisory run identified 2026 advisories in `idna 3.11` and
  `urllib3 2.6.3`. The runtime lock now uses `idna 3.18`, `urllib3 2.7.0`, and
  `requests 2.34.2`; a clean hash-checked install reports no known vulnerabilities.
- A common credential-pattern scan returned no matches outside ignored local data.

## External boundary

Automated verification deliberately does not contact Xueqiu. The opt-in smoke
command requires two explicit confirmations, accepts only a loopback CDP endpoint,
and forces output into an OS temporary directory. Private endpoint behavior remains
an operational dependency and is represented by explicit drift signals and failure
reports rather than assumed stable.
