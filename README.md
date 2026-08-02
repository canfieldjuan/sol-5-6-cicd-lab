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
- Account-authenticated Codex jobs never receive repository or PR write credentials.

These choices follow current OpenAI guidance for [GPT-5.6 prompting](https://developers.openai.com/api/docs/guides/latest-model),
[Codex GitHub review](https://learn.chatgpt.com/docs/third-party/github),
[ChatGPT-managed CI auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth),
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

Run one scenario immediately with the local ChatGPT-authenticated Codex CLI:

```bash
npm run eval:review -- unknown-data-as-zero high
npm run eval:implementation -- stable-idempotency-retry high
```

Evaluation outputs are written beneath `artifacts/evals/` and are not committed.

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

1. Connect the repository to Codex cloud for native `@codex review` requests.
2. For structured workflows, register a dedicated private runner with the
   `codex-pro` label and sign its Codex CLI in with ChatGPT.
3. Require the deterministic `CI / contract` job in branch protection when the
   repository visibility and GitHub plan support protected private branches.
4. Leave routine Codex review manual until the scenario suite meets its targets.
5. Run `Bounded Codex review` only on a stable PR head.
6. Use `Codex review scenario` and `Codex implementation scenario` to compare model or
   reasoning configurations.

The workflows default to `gpt-5.6-sol` with `high` reasoning. Higher effort is an
evaluation variable, not a global quality switch.

## Status

The executable scaffold has passed hosted deterministic CI and live local
ChatGPT Pro evaluations for blocking-defect recall, safe-change restraint, and a
scoped implementation fix. The next data milestone is importing reviewed
historical PR heads as versioned fixtures.
