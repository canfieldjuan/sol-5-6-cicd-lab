# ChatGPT Pro runner

OpenAI's supported account-authenticated CI pattern is advanced and intended for
trusted private automation. A GitHub-hosted runner does not inherit the ChatGPT
session from your workstation. This lab therefore uses a dedicated persistent
self-hosted runner for structured Codex jobs.

## Runner requirements

- A private, dedicated Linux runner with no unrelated credentials or production
  data.
- Repository access limited to repositories you control and trust.
- Labels `self-hosted`, `linux`, and `codex-pro`.
- A persistent home directory for the runner service account.
- One serialized workflow stream per ChatGPT auth cache.

Do not attach this runner to public repositories or use it for untrusted fork PRs.
`auth.json` contains refresh and access tokens and must be treated like a password.

## Install and authenticate

1. In GitHub, open **Settings > Actions > Runners > New self-hosted runner** and
   follow the generated Linux commands under a dedicated OS account.
2. Add the custom `codex-pro` label to that runner.
3. Install the current Codex CLI for the runner account:

```bash
npm install --global @openai/codex@latest
codex --version
```

4. Configure file-backed credential storage in `~/.codex/config.toml`:

```toml
cli_auth_credentials_store = "file"
```

5. Sign in interactively and verify the mode:

```bash
codex login
codex login status
```

The status must report `Logged in using ChatGPT`. Verify that
`~/.codex/auth.json` is owned by the runner account and mode `600`. Never print,
commit, upload, or copy its contents into workflow logs.

## Persistence and refresh

Codex refreshes stale account tokens during normal runs and writes the updated
bundle back to `auth.json`. The runner service must reuse the same home directory.
Do not reseed the original auth file on every job. Rerun `codex login` locally on
the runner if refresh eventually fails with `401`.

The four account-authenticated workflows use the shared
`codex-pro-account` concurrency group with cancellation disabled. This prevents
two jobs from rotating or writing the same auth cache at once.

## Native GitHub review alternative

The self-hosted runner is not required for OpenAI's native GitHub review. Connect
the repository to Codex cloud, disable automatic reviews, and comment
`@codex review` once on a stable head. Native review uses the ChatGPT plan but does
not enforce this lab's JSON schema, one-comment renderer, or scenario grader.

Source: [Maintain Codex account auth in CI/CD](https://learn.chatgpt.com/docs/auth/ci-cd-auth)
and [Codex code review in GitHub](https://learn.chatgpt.com/docs/third-party/github).
