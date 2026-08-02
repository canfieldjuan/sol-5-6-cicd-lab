# Adapting the lab to a repository

Keep the review policy and trust boundaries stable. Adapt the deterministic
contract and scenario fixtures to the target repository.

## Repository adapter checklist

1. Copy `ci-contract.json`, `schemas/`, `scripts/`, the lean `AGENTS.md` sections,
   and the workflows into a branch of the target repository.
2. Set `repository.defaultBranch`, `productionBranch`, and the minimum runtime.
3. Replace the sample check commands with the repository's real clean-checkout
   commands. Keep each command noninteractive and independently runnable.
4. List every deployable static root and tune sensitive-file patterns. Prefer an
   explicit allow path over weakening a deny pattern.
5. Add implementation scenarios for the repository's dangerous state changes,
   retry behavior, authorization transitions, and compatibility contracts.
6. Add paired review scenarios: one real defect and one nearby safe change. A
   reviewer that catches the former but flags the latter has not passed.
7. Run the scenario matrix at `high`; compare `xhigh` or `max` only against saved
   outcomes, runtime, token use, and cost.
8. Require deterministic CI in branch protection. Keep model evaluation and deep
   audit manually dispatched until their measured behavior supports a broader role.

## Typical deterministic commands

| Stack | Candidate commands |
| --- | --- |
| Node | lockfile install, format check, lint, typecheck, unit/integration tests, build |
| Python | locked install, formatter check, linter, typecheck, tests, package build |
| Go | format diff, `go vet`, tests with race coverage where appropriate, build |
| Static site | syntax, link and asset inventory, accessibility smoke test, production build |

Use the commands already trusted by the repository. The contract is an adapter,
not a reason to replace a working toolchain.

## Scenario quality

A scenario should name a concrete trigger and observable consequence. Keep the
fixture small enough for a human to label, but preserve the control-flow property
being tested. Store expected rule IDs rather than prose matching so wording changes
do not rewrite the score.

Do not train the prompt on scenario answers. The task contract may explain required
behavior; only `scenario.json` should reveal the expected finding IDs and budgets,
and review prompts should not be told to read that manifest.
