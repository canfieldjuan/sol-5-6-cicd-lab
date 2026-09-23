# Tool-Failure Mitigation Contract

Status: ACCEPTED (PR #10), revision 10; section 5.2 accepted (PR #13), amended in revisions 7-10. Implementation follows this contract. Steps 3-4 are specified at the invariant level only;
their detailed specs are added as contract revisions after the step-2 probe
has verified the hook behavior they depend on.

Ground-truth rule: code, binaries, and raw session logs are evidence. Docs,
comments, prior findings, and this contract's own "measured" numbers are claims
until a check in this repo reproduces them.

## 1. Problem

Codex sessions on the operator's machine (Jul-Sep 2026, 803 rollouts, about
300k tool calls, codex-cli 0.155.1) repeat the same mechanical failures. Each
failure costs at least one extra model step. The operator has been adding
AGENTS.md prose to prevent them, which costs tokens on every turn and only works
when the model remembers it. Deterministic mechanisms (hooks, helper commands,
config) should replace prose where they can.

Measured so far (to be reproduced by the step-1 analyzer before any number is
relied on):

| Class | Evidence | Note |
|---|---|---|
| Stale `apply_patch` ("Failed to find expected lines") | Sol 579, Daybreak 373, Terra 315 output records | 96% (1,085/1,134) recover on the first retry: frequent, cheap |
| Nonexistent `workdir` ("Failed to create unified exec process") | 70 records | Typos, directories the same command creates, malformed paths |
| Atlas-only `scripts/open_pr.sh` run in another repo | 34 records, 6 repos | Always from an Atlas-cwd session |
| Sandbox failure reported as a missing file (`bwrap: loopback: Failed RTM_NEWADDR`) | about 89 records | The host's AppArmor policy breaks bwrap |
| Bare `psql` (Unix socket, OS user) | Peer-auth / missing-role errors | Atlas DB is TCP `localhost:5433`, user `atlas` (`Atlas/atlas_brain/storage/config.py:16-87`) |
| `gh` guessing (unknown `--json` fields, malformed GraphQL) | Sampled | Known-good queries exist in `Atlas/scripts/check_ai_reconciliation_live.py:59-113` |

Corrected earlier claims: output truncation does not waste tokens (the model
receives about 10k tokens of each truncated output; it saves tokens), and about
96-98% of each step's input is cached, so a failure costs about one step's
uncached tokens, not the full context.

## 2. Scope

In scope, all in this lab (tracked sources plus installers, the pattern of
`scripts/install-codex-global.mjs`):
1. A tested failure analyzer.
2. A live hook probe.
3. Codex-only PreToolUse guards, a PR-status helper, and a scope guard.
4. Codex ports of the dormant Stop hooks `evidence-gate.sh` and `round-guard.sh`.
5. Before/after measurement and the list of AGENTS.md rules the mechanisms make
   removable (feeds `instructions/rule-inventory.json`).

Out of scope: changes to Codex itself; the shared `~/.claude/hooks/git_guard.py`
(it also guards Claude Code and must not change behavior for Claude); Atlas
product code.

## 3. Definitions

- **Tool output record**: a `response_item` of type `function_call_output` or
  `custom_tool_call_output`, joined to its call by `call_id`. This includes the
  direct `apply_patch` tool, whose output is plain text.
- **Failure**: a tool output record with a nonzero exit status in any of the
  observed shapes (a JSON `exit_code` chunk, `Process exited with code N`,
  `Exit code: N`), a
  `Script failed` / `Script error:` wrapper result, or an
  `apply_patch verification failed` message. `rg`/`grep`/`diff`/`test` exit 1
  with no error text is "no match", not a failure.
- **Failing text**: only the failing command's own output chunk, or the text
  after `Script error:`. It never includes file contents printed by a
  successful command in the same call.
- **Class**: exactly one of the classes in section 4 (A2), first match wins.
  Classes are either *mechanical* (tool misuse; the targets of this contract) or
  *expected* (a test or build that legitimately fails during development).
- **Step cost**: the uncached input tokens of the model step that follows the
  failure (`last_token_usage.input_tokens - cached_input_tokens` of the next
  distinct `token_count` event). Cached tokens are reported separately and
  never summed into cost. A `token_count` event that repeats the previous totals
  is not a new step.
- **Recovered**: the next call against the same target (file for patches,
  command for exec) succeeds within 5 calls. **Repeated**: it fails again.

## 4. Invariants

### Analyzer (step 1)

- **A1 Coverage.** Every tool output record in the window is read. Direct
  `apply_patch` outputs are included. A record whose call is missing is counted
  as `orphan`, not dropped.
- **A1b Unrecorded exit status.** A code-mode script that prints only a
  command's output (`text(r.output)`) records "Script completed" with no exit
  status, even when the command failed. Such a record is a **suspected**
  failure when a line starts with a tool's own error prefix (for example
  `sed: can't read X: No such file or directory`, `cat: X: Permission denied`),
  so a document that merely mentions an error does not count. Suspected failures
  are classified and reported in their own column and never added to failure
  counts, rates, or cost.
- **A2 Classification.** Classes, first match on failing text wins:
  `hook-denied` (a PreToolUse hook refused the call; kept separate so guards
  can be measured) | `sandbox` (bwrap / RTM_NEWADDR / "fs sandbox helper") |
  `bad-workdir` ("Failed to create unified exec process") | `patch-stale`
  ("Failed to find expected lines" / "Failed to find context") |
  `patch-malformed` (invalid hunk, multiple operations, empty hunk) |
  `wrong-repo-script` (`scripts/X: No such file` where X exists in another
  known repo) | `path-missing` | `permission` | `vcs-auth` (git/gh credential
  rejected) | `db-auth` (peer/password auth, missing role) | `db-sql` |
  `gh-usage` (unknown JSON field, GraphQL error, including a bare
  `{"errors":[...]}` response) | `jq-usage` (jq path or type error) |
  `js-wrapper` (raised by the code-mode wrapper itself: a stack frame in
  `exec_main.mjs`, or a JavaScript error name reported after `Script error:`
  with no Python traceback marker; a JS parse error has no stack frame) |
  `shell-quoting` | `command-missing` | `resource-busy` (port or container name
  already in use) | `network` | `timeout` | `stdin-dead` ("Unknown process id") |
  `interactive-only` | `expected-check` (a test, lint, type, build, or checker
  failure: legitimate development signal, not tool misuse) | `other`. A Python
  `SyntaxError` is never `js-wrapper`. Every class except `expected-check` and
  `other` is mechanical.

- **A3 Cost.** Cost is the step cost (section 3). The report shows count, share
  of calls, uncached cost, and recovered/repeated per class, per model.
- **A4 Determinism.** Same input files produce byte-identical JSON output.
- **A5 Window.** An explicit `--since/--until` (or file glob) is required and is
  echoed in the output. There is no silent default window.

### Guards and hooks (steps 2-4)

- **H1 Block and redirect, never end the turn.** No guard uses
  `continue:false` or anything else that stops the session. Measured in section
  5.1, a PreToolUse deny always refuses the call and delivers the reason, but
  the model acts on the reason only some of the time. So a redirect is built
  one of two ways:
  (a) **Rewrite**, when the correct command is certain: PreToolUse
  `permissionDecision:"allow"` plus `updatedInput`.
  (b) **Deny + Stop backstop**, otherwise: the PreToolUse deny records a
  pending redirect in the guard's state. If the model tries to finish while it
  is unaddressed, the Stop hook returns `decision:"block"` with the same reason,
  which continues the turn and was acted on every time it was measured.
  A pending redirect clears when a later call satisfies it (the corrected
  command runs, or the out-of-scope work is abandoned), when the model's final
  message already acts on it (revision 9: the Stop input carries
  `last_assistant_message`; each guard defines what "acts on" means, and giving
  up does not count), or when the Stop hook has already fired for it once
  (`stop_hook_active`), so a turn cannot loop. Revision 9 exists because the
  live wrong-repo-script eval showed the backstop forcing a redundant final
  message in 3 of 3 runs: the model had already given the correct answer.
- **H2 Actionable reason.** Every reason names the correct next action: the
  existing path, the right command, the helper to use, or the declared scope. A
  reason that only names the violation fails review.
- **H3 No false blocks by construction.** A deny is allowed only when the call
  would certainly fail anyway (a nonexistent workdir or script), or when it
  violates an explicitly declared scope. Everything else gets context
  injection at most.
- **H4 Fail open on guard error.** If a guard itself errors (bad input, a parse
  failure, a missing dependency), it allows the call and logs to its state dir.
  A broken guard must never stall work.
- **H5 Scope is opt-in.** The scope guard is inactive unless a scope file exists
  (draft shape: `.codex/scope.json` with repo roots, allowed path globs, PR
  number, goal line). When it is active, writes outside the globs and commands
  in another repo are denied with a redirect naming the scope.
- **H6 Claude isolation.** Codex guards are separate modules. Nothing changes
  the behavior of hooks Claude Code runs.
- **H7 Trust.** Installers never hand-write `[hooks.state]` trust hashes. An
  untrusted hook is silently skipped (section 5.1), so an installed guard that
  is not trusted does nothing and says nothing. Every installer therefore ends
  with an activation check that proves the installed hook fires, and fails
  loudly if it does not. The way trust is granted (Codex's own review flow) is
  specified in the step-3 contract revision.

## 5. Step 2 probe: what must be proven

The probe runs in an isolated CODEX_HOME (the `runOne` isolation in
`scripts/run-instruction-eval.mjs`) with throwaway hooks, and records a
transcript for each of these:

1. Whether `apply_patch` reaches PreToolUse/PostToolUse, and under which
   `tool_name` and `tool_input` shape.
2. A PreToolUse deny: the turn keeps running and the model's next action
   follows the reason.
3. A Stop block: the turn continues with the reason as the prompt, and ends
   normally after the model acts.
4. Whether PostToolUse `additionalContext` reaches the model.
5. Whether `updatedInput` with `permissionDecision:"allow"` rewrites a call.
6. The trust flow for a new hook file.

Every result becomes a revision of this contract, with a claim and its evidence,
before step 3 designs on it.

## 5.1 Probe results (codex-cli 0.156.0, gpt-6-sol / medium, 2026-09-22)

Produced by `scripts/probe-codex-hooks.mjs`. Counts are across every probe run
made that day (artifacts under the ignored `artifacts/hook-probe/`).

| Question | Result | Evidence |
| --- | --- | --- |
| Q1 apply_patch reaches hooks | Yes. PreToolUse and PostToolUse fire with `tool_name: "apply_patch"`; the patch text is `tool_input.command`; PostToolUse `tool_response` is the "Exit code / Output" text | hook logs |
| Q2 PreToolUse deny | Refuses the call 7/7. The model receives `Script error: Command blocked by PreToolUse hook: <reason>`, and the turn continues. The denied call is absent from the `exec --json` event stream (visible only in the session rollout) | rollouts, hook logs |
| Q2b model follows the deny reason | 3/7 | per-run agent messages |
| Q3 Stop `decision:"block"` | Continues the turn, and the model acts on the reason 11/11; the second Stop carries `stop_hook_active: true` | event streams, hook logs |
| Q4 PostToolUse `additionalContext` | Delivered as a developer-role message and used in a reply. A later Stop continuation can replace the final message | rollouts |
| Q5 `updatedInput` rewrite | Rewrites the call 4/4 | event streams |
| Q6 untrusted hook (no `--dangerously-bypass-hook-trust`) | Silently skipped 4/4: no hook events and no warning | hook logs, stderr |

| Q7 hook sees the command's working directory | **No.** `tool_input` is only `{command}`, and hook `cwd` is the session directory, not the `workdir` the model passed | workdir run: the model ran `pwd` in `.../sub`, the output was `.../sub`, and the hook saw only the session cwd |
| Q8 PreToolUse for a missing working directory | Fires, but carries no workdir. No PostToolUse follows the CreateProcess failure | badwd run: hook log and rollout |

| Q9 PostToolUse for a command that exits nonzero | Fires, and `tool_response` carries the command's output including its error line (for example `cat: no-such-file.txt: No such file or directory`); there is no exit code field | postfail run: hook log |

codex-cli upgraded from 0.155.1 to 0.156.0 during this work. The probe is
re-run on every upgrade before guards are trusted.

## 5.2 Step-3 guard specification (revision 6; accepted in PR #13)

### Constraints from the probe

- A hook cannot see where a command runs (Q7). The **base directory** of a
  command is known only when the command states it: a leading `cd <dir> &&` or
  `cd <dir>;`, or an absolute path argument. A check on a relative path with an
  unknown base is **skipped**, never guessed (H3).
- Nothing is observable after a failed process start (Q8). Nonexistent
  `workdir` (`bad-workdir`) is therefore **not guardable** and is left to the
  model. It costs 67 failures and 0.42M uncached tokens per quarter.
- `sandbox` and `vcs-auth` are configuration faults, not tool misuse. They are
  investigated separately (their own issue), not guarded.
- `git_guard.py` reads `tool_input.workdir`, a field Codex never sends. Its
  workdir branch is dead under Codex; the shared file is not changed (H6).

### Architecture

- One Codex-only guard program, `hooks/codex-guards/guard.mjs` (Node, no
  dependencies), tracked in this lab and installed to
  `~/.codex/hooks/lab-guards/` by an installer with the same guarantees as
  `install-codex-global.mjs`: dry run by default, hash-guarded, backups and
  state under `~/.local/state/sol-lab/`.
- It is registered by adding entries to `~/.codex/hooks.json` for PreToolUse
  (matcher `*`), PostToolUse (matcher `*`), and Stop. (Revision 7: the live
  read-path eval showed the model rewriting an absolute path as a relative one
  plus `workdir`, which the PreToolUse branch must skip, and then giving up. Q9
  proves the failure is observable after the fact, so guard 1b closes that gap.) Existing entries
  (git-guard, evidence-gate, round-guard, compaction-digest) are untouched.
- **Guard config** (revision 8): `<guard state dir>/config.json`, written by
  the installer from `--repos a,b` (known repo roots) and `--db
  host:port:user:db` (the psql rewrite target). A guard whose config is absent
  does nothing. The config lives beside the state, not in the hash-manifested
  install dir, because it is per-machine.
- **Per-session state**: `~/.local/state/sol-lab/guards/<session_id>.json`
  holds pending redirects and a heartbeat.
- **Stop backstop (H1b)**: if any redirect is pending and `stop_hook_active` is
  false, Stop returns `decision:"block"` with the pending reasons. Otherwise it
  clears them and allows the stop. A turn is never blocked twice.
- **Fail open (H4)**: any exception allows the call and appends to
  `guards/errors.log`. A hook timeout is treated the same way.
- **Activation (H7)**: after install, the operator trusts the hooks once in the
  Codex TUI (`/hooks`). `npm run guards:status` then passes only if the
  heartbeat was written after the install time by a real session. Until then
  the installer reports the guards as **installed, not active**.

### Guards, in ranked order

| # | Guard | Trigger (all conditions) | Action | Pending redirect cleared by |
|---|---|---|---|---|
| 1 | read-path | A read-only command (`cat`, `sed -n`, `head`, `tail`, `nl`, `ls`, `rg`/`grep` path arguments) names a path that does not exist, whose base is known, with no file-creating segment earlier in the same command; or an `apply_patch` `*** Update File:` / `*** Delete File:` whose absolute path does not exist | Deny + Stop backstop. The reason lists up to 5 existing candidates: same basename under the nearest existing ancestor, via `git ls-files` or a bounded directory listing | a later call that reads an existing path in that directory tree |
| 1b | read-path, after failure (revision 7) | PostToolUse where a read command's own error line (`cat\|sed\|head\|tail\|nl\|ls\|wc\|rg\|grep: <path>: No such file or directory`, `can't read`, `cannot access`) proves a path is missing. This covers relative paths, whose base the PreToolUse branch cannot know | PostToolUse `additionalContext` with candidates (a relative path is searched from the session cwd and labeled that way), plus a pending redirect enforced by the Stop backstop. Never a deny: the failure has already happened | same as 1 |
| 2 | wrong-repo-script | `bash\|sh scripts/X` or `./scripts/X` with a known base where `<base>/scripts/X` does not exist | Deny + Stop backstop. The reason lists `<base>/scripts/` and the known repos where X exists | a later call that runs an existing script, or none |
| 2b | wrong-repo-script, after failure (revision 8) | PostToolUse where the shell's own error line (`bash\|sh: [line N: ]scripts/X: No such file or directory`, also `./scripts/X`) proves the script is missing. In all 34 recorded wrong-repo runs the model set `workdir` to another repo, which the PreToolUse branch cannot see (Q7), so this is the branch that covers them | `additionalContext`: the known repos (from the guard config) that do have `scripts/X`, plus a pending redirect for the Stop backstop | a later call that names one of those repos, or a later command that no longer runs `scripts/X` |
| 3 | psql | `psql` with no `-h`/`--host`, no `PGHOST=` prefix, and no connection URI, when `db.json` (installer-written) defines the target | **Rewrite** (H1a) to add `-h <host> -p <port> -U <user>`, and `-d <db>` if absent. With no `db.json`: no action | n/a |
| 4 | gh-fields | `gh pr view` / `gh issue view` with `--json` naming a field outside gh's own list (captured at install from gh's error output) | Deny + Stop backstop. The reason leads with a concrete retry (the same command with the invalid fields removed), then lists the valid fields. It names `codex-pr-status` only when that command is on PATH (revision 10: the live eval went 0/3 when the reason pointed at the not-yet-built helper, and 3/3 with the concrete retry) | a later `gh` call that passes the check |
| 5 | rediscovery | `find` rooted at `~`, `/`, `/media`, `/tmp`, or `~/Desktop` without `-maxdepth` of 2 or less | PostToolUse `additionalContext` with the known-repo map (`repos.json`). Never a deny: a sweep does not fail (H3) | n/a |
| 6 | scope | Active only if `<session cwd>/.codex/scope.json` exists (repo roots, allowed globs, PR, goal). Trips on an `apply_patch` target outside the allowed globs, or a `cd` into a directory outside the declared roots | Deny + Stop backstop. The reason names the declared PR/goal and allowed globs. At Stop, `git diff --name-only` in each declared root that shows files outside the globs also blocks (drift) | reverting or confirming out-of-scope changes; or the Stop has fired once |

`codex-pr-status --repo R --pr N` (installed to `~/.local/bin`) prints JSON
with state, head SHA, mergeable, required and all checks, reviews, and
unresolved threads. It is built from the verified queries in
`Atlas/scripts/check_ai_reconciliation_live.py:59-113` and
`~/.local/bin/atlas-pr-watch:229-295`.

### Settling evidence for step 3

- Each guard has unit tests on both sides: an input that must trip and a near
  miss that must not, including an unknown base (skipped), a creating segment,
  and an existing path.
- Each guard's deny/rewrite output validates against the probe-verified hook
  output shape.
- A live eval scenario per guard (runner in `scripts/run-instruction-eval.mjs`)
  shows the redirect acted on before the turn ends.
- `analyze-tool-failures.mjs` on post-install sessions reports the class delta
  (step 5).

## 6. Failure cases

- Malformed rollout lines (control characters) are parsed leniently and
  counted as `unparsed`, never silently skipped.
- A missing or changed Codex hook schema (a new codex-cli version) makes the
  probe fail loudly. Guards pin the probed codex-cli version and warn on a
  mismatch.
- A guard timeout counts as a guard error (H4).

## 7. Settling evidence

- **Step 1**: `npm run check` passes. Every class in A2 has a fixture
  that must classify correctly. Each audited misclassification (sandbox as
  path, Python as JS, a missed direct apply_patch) has a regression fixture
  shown to fail on the scratch analyzer. A report is produced for the Jul-Sep
  window.
- **Step 2**: six probe transcripts, and the contract revised.
- **Step 3**: each guard is proven on a failing input and on a passing near-miss,
  and each regression test fails on the pre-fix code. An eval scenario per
  mitigated class passes before and after install.
- **Step 4**: each ported Stop hook blocks a real Codex transcript that should
  block and passes one that should not.
- **Step 5**: an analyzer delta per class on sessions after install, and
  AGENTS.md rules listed as relocation/removal candidates.

## 8. Delivery order

1. This contract. Stop for review.
2. Analyzer (step 1). Its ranking orders step 3.
3. Hook probe (step 2), then a contract revision.
4. Guards, helper, and scope guard (step 3), one PR per mechanism, in ranked
   order.
5. Stop-hook ports (step 4).
6. Measurement and AGENTS.md trim candidates (step 5).
