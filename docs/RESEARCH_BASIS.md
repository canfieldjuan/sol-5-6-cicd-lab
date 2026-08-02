# Research basis

Snapshot date: 2026-08-02.

## Official OpenAI guidance used

- [GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model)
  recommends lean, direct prompts and reports internal prompt simplification tests
  with 10-15% quality gains, 41-66% fewer tokens, and 33-67% lower cost. Repeating
  rules through a long session can amplify rather than strengthen them.
- [Codex GitHub Action guidance](https://learn.chatgpt.com/docs/github-action)
  recommends narrow permissions, `drop-sudo`, structured output, and separating
  API-key jobs from jobs that can write to a repository or PR.
- The live [Codex action contract](https://github.com/openai/codex-action/blob/main/action.yml)
  now prefers permission profiles such as `:read-only` and `:workspace`, and
  accepts an `output-schema-file` directly.
- [Custom code-review rules](https://developers.openai.com/blog/custom-code-review-rules-for-codex)
  recommends a small number of consequential, scoped rules with a safe path, while
  deterministic policy remains in normal CI.
- [Long-running work](https://learn.chatgpt.com/docs/long-running-work) and
  [ExecPlans](https://developers.openai.com/cookbook/articles/codex_exec_plans)
  emphasize an outcome, constraints, observable completion criteria, and a living
  plan that survives long execution.

## Observed review behavior

The motivating Effingham repository sample contained 89 Codex findings across 24
review runs on PRs 76-91: 20 P1 and 69 P2. PR 78 accumulated 22 findings over three
runs; PR 83 accumulated 18 over five; PR 84 accumulated 10 over four. The local
review rules required every supported mismatch to be disclosed, regardless of
severity, so comment growth was an expected consequence of the contract rather
than evidence that more review passes would converge.

The detailed evidence remains in
`~/Desktop/GPT-5.6-Codex-Instruction-Reliability-Findings.md`. This lab converts
that observation into testable controls: severity threshold, blocker budget,
root-cause grouping, one replaceable comment, exact-head validation, and a separate
artifact-only deep-audit path.

## Hypothesis under test

Sol's capacity is most useful when difficult semantic work is bounded by a small
contract and deterministic graders. More instructions and more review passes are
not treated as quality by default. A configuration earns broader automation only
when it catches labeled P0/P1 scenarios, passes adjacent safe scenarios, stays
inside the comment budget, and implements fixes without scope expansion.
