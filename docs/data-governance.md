# Data Governance

## Layers

- `output/`: local acquisition output and debug artifacts. It is ignored by Git.
- `references/sources/`: evidence required to reproduce a tracked research claim.
- `references/research/`: derived analysis, summaries, and validation reports.
- `SKILL.md`: the compact research product. It must not claim broader coverage than the source manifest proves.

Raw and normalized JSON should not be duplicated across multiple dated directories unless the manifest declares why both copies are needed.
Every JSON record array below a tracked Skill's `references/` tree must be
either a canonical segment or an explicitly excluded archive. Excluded archives
must prove full ID overlap with canonical segments, carry their own hash, and
must not contribute to aggregate claims.

## Manifest requirements

Each tracked corpus manifest must record:

- schema version;
- source path and corpus type;
- number of records and unique IDs;
- minimum and maximum timestamps;
- SHA-256 digest;
- known coverage limits, truncation, and unavailable reply levels;
- generation time and the script used to validate it.

Every declared segment also names its record contract. A contract change is a
data migration and must atomically rewrite the segment, rebuild manifest hashes,
and refresh Skill provenance. Missing historical fields remain explicit through
a narrow legacy contract; they must not be backfilled with guessed zeroes,
fabricated text, or inferred relationships.

Counts and cutoff dates in a skill must be derived from this manifest rather than hard-coded independently in validators.

## Privacy and retention

- Store only public content needed for research.
- Do not store authentication headers, cookies, browser storage, or unrelated commenter profile data.
- Keep debug HTML and screenshots in `output/` and remove them when an incident is resolved.
- Before publishing a corpus, review platform terms, quotation scope, and whether personal identifiers are necessary.

## Evidence levels

Research notes should distinguish raw source facts, normalized observations, interpretation, and investment hypotheses. A high interaction count is not evidence that a claim is correct. Missing or blocked nested reply coverage must remain explicit in manifests and user-facing limitations.
