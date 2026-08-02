# Execution Plan: Initial CI/CD lab

## Outcome

Create a reusable repository that measures GPT-5.6 Sol implementation quality and
review restraint while keeping deterministic CI and credential boundaries outside
model control.

## Constraints

- Routine review must not become an unlimited PR comment queue.
- The OpenAI API key and repository/PR write permissions must never share a job.
- PR-controlled files must not replace trusted review prompts, schemas, graders,
  or renderers.
- Local tools must run with Node.js 20 and no runtime dependencies.
- The originating Effingham production repository remains untouched.

## Acceptance Criteria

- Required contract checks and unit tests pass from a clean checkout.
- Review output is schema-bound to at most five distinct P0/P1 blockers.
- One marked PR comment is updated rather than appended on every review.
- Deep audit is manual, read-only, and artifact-only.
- Review scenarios measure recall, false positives, duplicate roots, and privacy.
- Implementation scenarios measure behavior and changed-file scope.
- GitHub workflow syntax and action semantics validate before publication.

## Context

The detailed model/instruction research is stored at
`~/Desktop/GPT-5.6-Codex-Instruction-Reliability-Findings.md`. The design basis is
summarized in `docs/RESEARCH_BASIS.md`; repository adaptation is documented in
`docs/ADAPTING.md`.

## Milestones

- [x] Define the portable contract, review policy, schemas, and scenarios.
- [x] Implement dependency-free validators, graders, and tests.
- [x] Add pinned CI, bounded-review, deep-audit, and evaluation workflows.
- [ ] Publish the private GitHub repository and observe the initial CI run.

## Progress

- 2026-08-02: Installed the OpenAI Developers plugin and Docs MCP globally.
- 2026-08-02: Added five review scenarios and two implementation scenarios.
- 2026-08-02: `npm run check` passed with 15 tests; advisory checks passed.
- 2026-08-02: PyYAML parsed all workflows and actionlint 1.7.12 reported no errors.
- 2026-08-02: Confirmed both broken implementation fixtures fail on their labeled
  retry/session defects before an agent modifies them.
- 2026-08-02: Initial hosted `CI / contract` run passed. Updated `setup-node` to
  pinned v6 after GitHub flagged v4's retired Actions runtime.
- 2026-08-02: Dependabot opened five independent action-upgrade PRs on first push.
  Updated the pins and grouped future action updates into one PR with a one-PR cap.

## Discoveries

- The current Codex action supports `permission-profile` and
  `output-schema-file`; exact action SHAs avoid stale action metadata and mutable
  tag risk.
- A single PR checkout would let a candidate replace its validator. Routine review
  therefore keeps trusted default-branch controls under `control/` and the exact PR
  head under `target/`.
- Counting comments is insufficient. The output contract also caps field lengths,
  validates the reviewed SHA, and groups findings by stable root-cause IDs.

## Decisions

- Default to `gpt-5.6-sol` at `high`; treat `xhigh` and `max` as measured variables.
- Keep routine review manually dispatched until scenario results justify automation.
- Make P0/P1 blockers visible in one replaceable comment; keep P2 detail out of the
  blocking surface.
- Preserve exhaustive reconstruction as a separate deep-audit artifact.

## Recovery

Run `git status`, `npm run check`, `npm run ci:advisory`, and actionlint. Compare the
latest workflow run to the current head before changing the model, effort, prompts,
or scenario expectations.
