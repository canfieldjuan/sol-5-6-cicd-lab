# Tool-failure baseline (Jul-Sep 2026)

Produced by `scripts/analyze-tool-failures.mjs` (contract:
`docs/TOOL_FAILURE_MITIGATION_CONTRACT.md`, step 1):

```text
node scripts/analyze-tool-failures.mjs --since 2026-07-01 --until 2026-09-30 \
  --repos "<Atlas>,<doc_sum>,<invoice-processor>,<eom-email-watcher>,<local-inference-gateway>,<connect-automate-contract-watch>" \
  --json artifacts/tool-failures/jul-sep.json
```

803 rollouts, 297,489 tool calls, 31 unparsed lines, 0 orphan outputs. Two runs
produced byte-identical JSON (A4). Cost is the uncached input tokens of the one
extra model step each failure causes. Cached tokens are excluded because about
96-98% of every step's input is cached.

## Mechanical failures by class (all models)

Mechanical total: 2,958 failures, 11,868,184 uncached tokens. "Suspected" means
no exit status was recorded but a tool error line was printed (contract A1b).
Suspected failures are never counted in failures or cost.

| Class | Failures | Uncached tokens | Recovered | Repeated | No retry | Suspected |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| patch-stale | 1,415 | 4,851,879 | 1,198 | 58 | 159 | 0 |
| path-missing | 311 | 1,359,974 | 41 | 7 | 263 | 1,253 |
| sandbox | 121 | 954,918 | 18 | 29 | 74 | 1 |
| js-wrapper | 240 | 772,047 | 171 | 26 | 43 | 0 |
| gh-usage | 146 | 739,068 | 17 | 8 | 121 | 0 |
| patch-malformed | 119 | 587,156 | 95 | 6 | 18 | 0 |
| vcs-auth | 124 | 469,080 | 6 | 2 | 116 | 0 |
| stdin-dead | 36 | 452,390 | 26 | 3 | 7 | 0 |
| bad-workdir | 67 | 417,981 | 46 | 0 | 21 | 0 |
| command-missing | 113 | 333,911 | 27 | 4 | 82 | 51 |
| hook-denied | 61 | 249,136 | 8 | 9 | 44 | 0 |
| shell-quoting | 42 | 237,764 | 10 | 1 | 31 | 0 |
| permission | 31 | 179,332 | 1 | 1 | 29 | 205 |
| jq-usage | 33 | 118,195 | 5 | 1 | 27 | 0 |
| resource-busy | 28 | 53,917 | 12 | 0 | 16 | 0 |
| db-auth | 14 | 20,658 | 3 | 1 | 10 | 0 |
| wrong-repo-script | 10 | 20,214 | 1 | 1 | 8 | 32 |
| timeout | 23 | 17,104 | 7 | 2 | 14 | 0 |
| interactive-only | 10 | 16,213 | 3 | 0 | 7 | 0 |
| db-sql | 10 | 12,585 | 5 | 0 | 5 | 0 |
| network | 4 | 4,662 | 1 | 0 | 3 | 0 |

Not mechanical: `expected-check` (1,585 failures, 4,457,018 uncached tokens;
tests, lint, type, and build failures) and `other` (4,286, 16,576,897; nonzero
exits of the operator's own programs and checkers that match no signature).

## Per model

| Model | Calls | Mechanical | Per 100 calls | Suspected |
| --- | ---: | ---: | ---: | ---: |
| gpt-5.6-sol | 126,067 | 1,295 | 1.03 | 598 |
| gpt-daybreak-blue-latest | 72,598 | 740 | 1.02 | 416 |
| gpt-5.6-terra | 66,239 | 591 | 0.89 | 459 |
| gpt-5.5 | 29,711 | 321 | 1.08 | 72 |

## Findings

- **Mechanical failure rates are nearly the same across models (about 1 per 100
  calls).** An earlier scratch analysis said Daybreak Blue failed about twice as
  often as 5.6-Sol. That was an artifact: the scratch analyzer did not parse
  `exec_command`'s `Process exited with code N` shape.
- **Path guessing is the largest hidden class.** It shows 311 recorded failures
  plus 1,253 suspected: code-mode `sed`/`rg`/`cat` of paths that do not exist
  (guessed skill paths, cargo registry paths, docs that were never written).
- **Suspected `permission` is mostly repository rediscovery**: broad `find`
  sweeps over `~`, `/media`, and `/tmp` for repos whose paths are already known.
  This is the behavior global rule G16 forbids in prose.
- **Stale patches are frequent but cheap.** 85% recover on the next matching call.
- **Failures that are rarely retried** (so the model changes course, which costs
  more steps): `gh-usage` (121 of 146 not retried), `vcs-auth` (116 of 124),
  `path-missing`, and `command-missing`.
- **Scale check.** All mechanical failures together cost about 11.9M uncached
  tokens over three months. The large token spend in these sessions is cached
  context re-sent every step, so reducing steps and context size (polling,
  subagent waits) is a bigger lever than removing failures. Failures still
  matter for correctness and flow.

## Candidate order for step 3 (to be confirmed after the step-2 hook probe)

1. Path guessing and repository rediscovery: path-missing (recorded plus
   suspected), the permission sweeps, wrong-repo-script, bad-workdir.
2. `gh-usage` and `jq-usage`: a PR-status helper that returns the fields models
   keep guessing.
3. `sandbox`: a configuration fix, since retries cannot succeed.
4. `vcs-auth`: a credential check before git or gh network calls.
5. The scope guard (operator priority), which also covers wrong-repo work.
