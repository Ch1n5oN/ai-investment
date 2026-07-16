# Evaluation Cases

`cases.json` is the stable behavioral regression set for this Skill. Run the
cases through the target agent after material changes and record whether every
required behavior is present and every forbidden behavior is absent.

The repository validator checks the fixture schema and ensures the suite covers
fidelity, anti-copy boundaries, stale information, uncertainty, position risk,
multi-perspective separation, and role exit. Model-response scoring remains a
manual or harness-level check because this repository does not call an LLM in CI.
