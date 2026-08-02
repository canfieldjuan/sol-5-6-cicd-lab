# Agent guidance

## Goal

Keep this repository a portable, measurable CI/CD lab for coding-agent
implementation and review.

## Working agreements

- Read `ci-contract.json` before changing scripts, workflows, prompts, or scenarios.
- Keep local tooling dependency-free when Node.js provides the required primitive.
- Make focused changes and preserve existing scenario semantics.
- For multi-step work, maintain the living plan in `PLANS.md`.
- Run `npm run check` before finishing. Report any check you could not run.
- Do not create, update, or post GitHub reviews unless the user explicitly asks.
- Never commit credentials, generated agent transcripts, or raw production data.

## Done means

- required checks pass;
- changed behavior has a focused test or scenario;
- schemas, examples, and documentation agree;
- the final diff contains no unrelated changes.

## Code Review Rules

### Review containment

- Routine review reports only distinct P0/P1 root causes and returns at most five
  blockers. Safe path: group manifestations under one root cause and move P2 detail
  to the advisory count or an explicit deep-audit artifact.

### Credential separation

- A job that uses ChatGPT-managed Codex auth must not also hold repository or PR
  write permissions. Safe path: run it on the dedicated private `codex-pro` runner,
  generate an artifact, then use a separate hosted job without account auth to post
  or apply it.

### Deterministic ownership

- Do not ask an agent to enforce a condition that a deterministic script can decide.
  Safe path: add or extend a required check and keep model review for semantic risk.

For exhaustive review procedure, read `docs/DEEP_AUDIT_PROTOCOL.md` only when a
deep audit is explicitly requested.
