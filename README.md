# Sol 5.6 CI/CD Lab

A testbed for building portable CI/CD that treats coding-agent implementation and
code review as measurable parts of delivery.

The lab separates four concerns:

1. deterministic repository checks;
2. implementation-agent evaluation;
3. bounded routine review;
4. exhaustive deep audit.

This prevents routine pull requests from becoming an unlimited audit queue while
keeping a deliberate path for comprehensive investigation.

## Principles

- CI owns deterministic checks.
- Coding agents must prove the requested behavior before review.
- Routine review reports only distinct P0/P1 root causes, capped at five.
- P2 observations are advisory and grouped, not emitted as an inline comment stack.
- Deep audits are explicit, read-only, and artifact-first.
- Model and reasoning changes are evaluated against the same scenarios.
- AI output never receives write credentials in the same job that holds the OpenAI
  API key.

These choices follow current OpenAI guidance for [GPT-5.6 prompting](https://developers.openai.com/api/docs/guides/latest-model),
[Codex GitHub Actions](https://learn.chatgpt.com/docs/github-action),
[custom review rules](https://developers.openai.com/blog/custom-code-review-rules-for-codex),
and [long-running work](https://learn.chatgpt.com/docs/long-running-work).

## Quick start

Requirements: Node.js 20 or newer.

```bash
npm ci
npm run check
npm run scenario:list
```

Grade a saved review result:

```bash
node scripts/grade-review.mjs \
  scenarios/review/unknown-data-as-zero \
  path/to/review-output.json
```

Run the contract-selected checks:

```bash
npm run ci
npm run ci:advisory
```

## Repository layout

| Path | Purpose |
| --- | --- |
| `ci-contract.json` | Portable repository check and review policy |
| `schemas/` | Machine-readable contracts for configuration and AI output |
| `scripts/` | Dependency-free validators, graders, and renderers |
| `scenarios/review/` | Review recall, restraint, and deduplication fixtures |
| `scenarios/implementation/` | Coding-agent behavior and scope fixtures |
| `.github/codex/prompts/` | Lean task-specific Codex prompts |
| `.github/workflows/` | Deterministic CI and manual AI workflows |
| `docs/` | Architecture, review policy, and extension guidance |

## GitHub setup

1. Add `OPENAI_API_KEY` as a repository Actions secret.
2. Require the deterministic `CI / contract` job in branch protection.
3. Leave routine Codex review manual until the scenario suite meets its targets.
4. Run `Bounded Codex review` only on a stable PR head.
5. Use `Codex review scenario` and `Codex implementation scenario` to compare model or
   reasoning configurations.

The workflows default to the `sol` model alias with `high` reasoning. Higher effort is an
evaluation variable, not a global quality switch.

## Status

This is the first executable scaffold. The initial scenarios prove the harness
shape; the next data milestone is importing reviewed historical PR heads as
versioned fixtures.
