# Operations Runbook

## Browser isolation

Use a dedicated Chrome or Edge profile for Xueqiu automation. Start remote debugging on loopback and never expose the port to a LAN or public interface. Close the debugging browser after the sync completes.

## Credentials

Prefer the dedicated CDP browser flow. If the Python fallback is required, use a cookie file with user-only permissions and avoid `--cookie`, which leaks into shell history and process listings.

## Exit codes

- `0`: all requested streams completed with declared coverage.
- `2`: output is usable but requires verification, for example page-limit truncation or an optional stream failure.
- `1`: failed; checkpoints for incomplete work must not advance.

Automation should alert on both `1` and `2`. A `needs_verification` report is not equivalent to success.

## Manual contract smoke check

Run `npm run smoke:xueqiu -- --confirm-live-xueqiu --confirm-dedicated-profile`
only from a dedicated, logged-in browser profile. The command rejects non-loopback
CDP endpoints and writes exclusively beneath a newly created OS temporary
directory. Add `--include-comments` only when a bounded one-post comment probe is
needed. The wrapper fails closed when the terminal report violates its schema or
when its status disagrees with the child exit code. This command must not be added
to automated tests or unattended CI.

Treat `interface_drift.detected: true` as a schema/endpoint incident. Its signals
distinguish missing endpoints, response-contract changes, encoding failures, and
content-type changes. WAF counts and `API_10020` remain access/coverage incidents,
not proof of an interface change.

## Schedule

- Daily or ad hoc: fast incremental sync based on new posts and changed reply counts.
- Weekly: bounded forced comment audit over recent posts.
- Monthly: wider historical audit and corpus-manifest validation.
- On dependency changes: run the isolated Python advisory-audit CI job in addition
  to `npm audit`.

Dependabot intentionally ignores the `skills` installer. Updating it requires one
manual change that keeps `package.json`, `package-lock.json`, and `skills-lock.json`
aligned, including the installer integrity and installed snapshot hashes.

For Python runtime dependencies, edit only `pyproject.toml` and regenerate
`requirements-lock.txt` from it. Install from the hash lock; do not recreate an
unpinned `requirements.txt`. The separate `requirements-audit.in` and
`requirements-audit-lock.txt` pair belongs only to isolated advisory tooling.
Use only the `pip-tools` version and dependency closure recorded in
`requirements-maintenance.in` and `requirements-maintenance-lock.txt` to
regenerate either lock. CI performs the same isolated recompilation and rejects
any tracked lock diff.

## Recovery

1. Read the JSON report before rerunning.
2. Preserve the failed state and temporary files for diagnosis.
3. Fix authentication, WAF, or endpoint issues without deleting confirmed checkpoints.
4. Rerun the smallest affected stream.
5. Run the manifest and Skill validators before updating research claims.

An unreadable JSON state is treated as corruption. Restore it from a known-good copy or rebuild it from verified corpus files; do not replace it with an empty object.
