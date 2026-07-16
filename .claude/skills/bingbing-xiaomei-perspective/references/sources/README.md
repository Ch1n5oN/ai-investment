# Corpus Sources

`corpus-manifest.json` is the authority for the corpus used by this Skill. It
lists the exact declared source-segment descriptors, counts, unique IDs, date
ranges, SHA-256 hashes, and known coverage limits. Validation compares the full
descriptor set (`path`, `origin`, `kind`, `stage`, `contract`, `from`, and `through`) with
the declarations in `scripts/build_corpus_manifest.mjs`; deleting, adding, or
changing a descriptor fails closed. The descriptor contract is included in that
exact comparison.

## Record contract

Every record satisfies the following canonical base contract:

- `schema_version` is the integer `1`.
- `id` and every known `*_id`/`reply_to` field are digit-only strings (or
  `null` when the field is optional).
- `created_at_raw` preserves the acquisition value and `created_at` uses the
  canonical `YYYY-MM-DDTHH:mm:ss+08:00` Asia/Shanghai representation. The same
  rule applies to `post_created_at` and its raw companion.
- Relative target/link/URL fields are expanded to absolute URLs.
- Every `*_count` is a non-negative integer.

The default `normalized_v1` contract additionally requires retained content,
the acquisition count fields, and a subject-owned target URL. Historical gaps
are never silently filled: `legacy_normalized_v1` is limited to the declared
baseline gaps, while `normalized_without_view_count_v1` is limited to the 155
timeline records acquired from 2026-06-21 through 2026-06-30. The framework
index uses `framework_index_link_v1`; it permits exactly one declared external
deleted-post link (`5003404268/308254026`) and requires subject ownership for
all other entries.

One deleted framework-link record was acquired with `created_at: "unknown"`.
Both `created_at_raw` and `created_at` remain `"unknown"`; the validator permits
that value only for this explicit raw/normalized pairing. Unknown timestamps
are excluded from segment date-range metadata rather than replaced with a
fabricated date.

`metadataFor` validates every record before calculating counts, dates, or a
hash. An unreadable file or any contract violation stops validation; it is
never treated as an empty corpus.

## Repeatable migration

From the repository root, normalize all declared tracked segments, atomically
replace each JSON file, and rebuild manifest hashes:

```bash
node .claude/skills/bingbing-xiaomei-perspective/scripts/build_corpus_manifest.mjs --migrate
```

The migration is idempotent: raw timestamps already preserved by an earlier
run remain unchanged, while normalized values serialize deterministically.
`corpus-manifest.json.generated_at` records the time of each rebuild.

After an intentional change to the Skill or a required evidence file, refresh
the tracked provenance atomically and immediately validate it:

```bash
node .claude/skills/bingbing-xiaomei-perspective/scripts/validate_skill.mjs --write-provenance
```

The manifest evidence digest canonicalizes JSON and excludes only
`generated_at`; corpus claims, descriptors, hashes, limitations, and all other
semantic fields remain bound by SHA-256.

Refresh generated segments only after a successful local acquisition run:

```bash
node .claude/skills/bingbing-xiaomei-perspective/scripts/build_corpus_manifest.mjs --refresh
```

`--refresh` reads local `output/` acquisition artifacts, normalizes selected
records before writing tracked segments, and rebuilds the manifest. It does not
perform network requests.

From the repository root, validate without network or `output/` access:

```bash
npm run test:skill
```

The source segments intentionally remain separate instead of storing another
full duplicate snapshot. The validator proves per-segment and cross-segment
uniqueness and derives totals dynamically.
