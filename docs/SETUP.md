# Repository setup

## Required secret

Create a project-scoped OpenAI API key and add it as the Actions secret
`OPENAI_API_KEY`. The Codex action receives the key through its protected proxy;
repository setup and test steps do not receive it.

```bash
gh secret set OPENAI_API_KEY --repo OWNER/REPOSITORY
```

## Branch protection

Protect `main` and require the `CI / contract` check. Do not make the manually
dispatched Codex workflows required checks: they intentionally run only when a
stable head is ready for review or when an evaluation is requested.

Keep dismissal of stale approvals enabled. Require a fresh bounded review only
where project risk warrants it; the workflow refuses to publish results when the
PR head moved during review.

## First evaluation

1. Run `CI` and confirm the deterministic contract passes.
2. Dispatch `Codex review scenario` for every fixture at `high` effort.
3. Repeat at `xhigh` only when the measured pass rate justifies the extra cost.
4. Dispatch both implementation scenarios and inspect their patch artifacts.
5. Record model, effort, scenario, outcome, token use, and date before changing
   prompts or policy.

Routine reviews replace one marked PR comment. Deep audits only upload an
artifact and never post inline findings.
