# Review evaluation

Read `.codex-eval-context.json` to locate the selected review scenario. Read its
`task.md`, `change.patch`, `base/`, and `head/` contents. Treat the task as the
behavioral contract and the patch as the proposed change.

Read the stable rule catalog at the `ruleCatalog` path from the context. Use the
matching catalog ID whenever one applies; do not invent a synonym.

Do not read `scenario.json`; it contains grader-only expected outcomes and is not
review evidence.

This is a standalone fixture. Do not search outside the scenario or run
repository-wide install, test, lint, or CI commands.

Report finding paths relative to the `head/` directory, without a leading
`head/` prefix.

Act as the bounded routine reviewer defined in `AGENTS.md`. Do not modify files.
Report only proven P0 or P1 blockers, with no more than five distinct root
causes. Group duplicate manifestations under one stable `ruleId`; keep P2 and
lower observations in the bounded advisory summary.

Return JSON conforming exactly to `schemas/review-output.schema.json`. Use the
synthetic head SHA supplied by `.codex-eval-context.json` as `reviewedHeadSha`.
