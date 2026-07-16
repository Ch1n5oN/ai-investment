# Architecture

The repository has three layers:

1. **Acquisition**: authenticated Xueqiu requests through an existing browser CDP session, with cookie-based Python as a fallback.
2. **Corpus**: raw responses, normalized records, state, coverage reports, and immutable manifests.
3. **Research products**: Markdown notes and perspective skills derived from a declared corpus.

## Primary sync path

The Edge/CDP sync is the production entrypoint because it reuses a logged-in same-origin browser session without copying cookies to disk. Its responsibilities are limited to orchestration:

- fetch timeline and article pages;
- select comment streams that require scanning;
- merge normalized records;
- advance checkpoints only after confirmed coverage;
- write machine-readable reports and deterministic exit codes.

Terminal Edge reports include structured `interface_drift` signals. Response
shape, encoding, content-type, and endpoint-removal failures are classified as
contract drift; WAF challenges and known API limitations remain separate so
operators do not infer a schema change from an access-control event.

`scripts/xueqiu_smoke.mjs` is a manual safety wrapper around this primary path.
It requires explicit live/profile confirmation and redirects all child outputs
to an OS temporary directory. Before returning success, it validates the complete
terminal-report schema and requires the report status to match the child exit code;
it is not an automated test entrypoint.

Reusable code belongs in shared modules rather than individual scraper scripts. The shared layer owns argument validation, time normalization, HTML cleaning, strict JSON loading, atomic writes, merge semantics, CDP request timeouts, and report status calculation.

## Data contract

Normalized records must include:

- stable string `id`;
- original timestamp when available;
- timezone-aware `created_at` normalized to `Asia/Shanghai`;
- canonical Xueqiu HTTPS URL (`target` for posts, `post_target` for replies);
- cleaned text and original text;
- integer interaction counts;
- `schema_version: 1` and an explicit `record_contract`;
- acquisition metadata where applicable.

`normalized_v1` is the only contract emitted by maintained acquisition paths.
It requires original and cleaned text plus all interaction fields (`view_count`
is required for posts). Historical corpus segments that did not retain all of
those facts are explicitly discriminated as `legacy_normalized_v1`,
`normalized_without_view_count_v1`, `framework_index_link_v1`, or
`framework_index_source_v1`. These labels
document known evidence gaps; migration never synthesizes unknown interaction
counts or missing content.

The JSON Schemas under `schemas/` are executable CI contracts. Runtime
normalizers additionally enforce relations JSON Schema cannot express directly,
such as `clean_text` matching the deterministic normalization of `text` and
`created_at` representing the preserved raw timestamp.

State files are not caches. An unreadable state file is a hard error and must not be treated as an empty first run.
The preserved raw timestamp is authoritative: if an existing normalized timestamp no longer represents it, the record is rejected instead of silently rewritten. Missing post URLs are reconstructed only when both user and post IDs are known; non-Xueqiu hosts, credentials, and non-standard ports are rejected.

## Compatibility

Legacy scripts can remain temporarily for recovery, but new reliability behavior must be implemented in shared modules and exercised by tests. Once equivalent fixture coverage exists, redundant scripts can be retired without changing stored data formats.
