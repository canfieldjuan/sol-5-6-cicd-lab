# Repository setup

## ChatGPT Pro authentication

This repository does not require or expect an OpenAI API key.

For ordinary PR review, connect the repository to Codex cloud in
[Codex code-review settings](https://chatgpt.com/codex/settings/code-review),
leave automatic reviews disabled, and request one `@codex review` only after the
head is stable. This uses ChatGPT-managed Codex access but does not provide the
lab's structured output and scenario grading.

The structured review, deep-audit, and evaluation workflows use a dedicated
self-hosted runner labeled `codex-pro`. Follow `PRO_AUTH.md` to install the runner,
sign the Codex CLI in with ChatGPT, and keep its auth cache persistent. All
account-authenticated workflows share one concurrency group so the same auth cache
is never used by concurrent jobs.

Do not place `auth.json` in a GitHub secret and restore the original copy on every
run. Codex refreshes that file in place; overwriting it discards refreshed tokens.
GitHub-hosted runners need an external secure read/write store for the refreshed
file, so this lab deliberately uses a persistent private runner instead.

## Branch protection

Protect `main` and require the `CI / contract` check. Do not make the manually
dispatched Codex workflows required checks: they intentionally run only when a
stable head is ready for review or when an evaluation is requested.

GitHub may require a paid GitHub plan to protect a private repository. ChatGPT Pro
does not change GitHub repository features. If the protection API returns HTTP 403,
the workflow still reports CI but GitHub is not enforcing it as a merge gate.

Keep dismissal of stale approvals enabled. Require a fresh bounded review only
where project risk warrants it; the workflow refuses to publish results when the
PR head moved during review.

## First evaluation

1. Run `CI` and confirm the deterministic contract passes.
2. Confirm the `codex-pro` runner is online and `codex login status` reports
   `Logged in using ChatGPT` under the runner account.
3. Dispatch `Codex review scenario` for every fixture at `high` effort.
4. Repeat at `xhigh` only when the measured pass rate justifies the additional use.
5. Dispatch both implementation scenarios and inspect their patch artifacts.
6. Record model, effort, scenario, outcome, token use, and date before changing
   prompts or policy.

Routine reviews replace one marked PR comment. Deep audits only upload an artifact
and never post inline findings.
