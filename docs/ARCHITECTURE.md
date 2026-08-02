# Architecture

## Delivery model

The lab treats an agent-assisted pull request as a pipeline with independently
measurable stages:

```text
problem contract
  -> implementation agent
  -> deterministic author preflight
  -> stable pull-request head
  -> bounded routine review
  -> required merge gate
  -> optional deep audit
```

A failure at one stage should not be compensated for by making a later stage
unbounded. Weak implementation is fixed by better acceptance criteria, tests, and
implementation evals. Noisy review is fixed by severity policy, root-cause
deduplication, a comment budget, and review evals.

## Trust boundaries

### Deterministic CI

Required and reproducible. It owns syntax, types, lint, tests, schemas, generated
inventories, sensitive-file checks, and other machine-decidable policy.

### Implementation agent

Workspace-write access in an isolated checkout. It receives an outcome, constraints,
and observable completion criteria. Its result is graded by commands and scope checks.

### Routine reviewer

Read-only access. It returns structured JSON with at most five distinct P0/P1 root
causes. A deterministic renderer creates one updateable PR comment. P2 observations
cannot fail the merge gate.

### Deep auditor

Read-only and explicitly invoked. It may be exhaustive, but its output is stored as
an artifact rather than posted as a growing inline-comment queue.

### Publisher

A separate job may post a comment or apply an approved patch. It never receives the
ChatGPT-managed Codex auth cache. The account-authenticated job has read-only GitHub
permissions and hands an artifact to a separate hosted publisher job.

Structured agent jobs run on a dedicated persistent `codex-pro` runner and are
serialized across workflows. Deterministic CI and publisher jobs remain on hosted
runners without account credentials.

The routine-review and deep-audit jobs use two checkouts: trusted prompts, schemas,
validators, and renderers come from the default branch under `control/`; the PR head
is read under `target/`. A candidate change cannot replace the code that grades or
publishes its result.

## Portability

`ci-contract.json` is the stable interface. Repository adapters replace commands and
sensitive paths without editing the runner. Future adapters can add language-specific
checks while preserving the same review and security policy.

## Evaluation

Every scenario contains a task or candidate change plus machine-readable expectations.
Review scenarios score required finding IDs, forbidden findings, severity, comment
budget, and duplicate root causes. Implementation scenarios score commands, changed
file scope, and forbidden paths.

The first fixtures are small and inspectable. Historical real-world PR heads should be
added only after a human labels the required and acceptable outcomes.
