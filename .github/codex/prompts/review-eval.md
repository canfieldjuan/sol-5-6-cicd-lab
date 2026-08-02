# Review evaluation

Read `.codex-eval-context.json` to locate the selected review scenario. Read its
`task.md`, `change.patch`, `base/`, and `head/` contents. Treat the task as the
behavioral contract and the patch as the proposed change.

Do not read `scenario.json`; it contains grader-only expected outcomes and is not
review evidence.

Act as the bounded routine reviewer defined in `AGENTS.md`. Do not modify files.
Report only proven P0 or P1 blockers, with no more than five distinct root
causes. Group duplicate manifestations under one stable `ruleId`; keep P2 and
lower observations in the bounded advisory summary.

Return JSON conforming exactly to `schemas/review-output.schema.json`. Use the
synthetic head SHA supplied by `.codex-eval-context.json` as `reviewedHeadSha`.
