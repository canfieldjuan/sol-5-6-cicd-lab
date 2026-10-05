# Tool-Failure Mitigation Contract

Status: ACCEPTED (PR #10), revision 20; section 5.2 accepted (PR #13), amended in revisions 7-13; section 5.3 (step 4) accepted (PR #21), amended in revisions 15-18 (revision 18: the round guard leaves Stop); section 5.4 (step 6, seam redirect) accepted (PR #30) in revision 18, amended in revision 19 (push epochs per directory scope; ownership only from creating forms) and revision 20 (the same redirects in Claude Code; the round-guard Stop hooks removed). Implementation follows this contract. Steps 3-4 are specified at the invariant level only;
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
6. A seam redirect (revision 18): context-only redirects at the start of each
   fix round, which replace the round guard's Stop checkpoint.

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
  the behavior of hooks Claude Code runs. (Revision 20: the Codex install
  still never does; the operator-directed `--claude` target installs the seam
  redirect for Claude Code and adds only its own entries, section 5.4.)
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

| Q10 context-only PreToolUse output (no permission decision) | The call runs, and the context is delivered as a developer message and used | precontext run: event stream and rollout |

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
| 5 | rediscovery | `find` rooted at `~`, `$HOME`, `/`, `/media`, `/tmp`, or `~/Desktop` without `-maxdepth` of 2 or less | PreToolUse context-only output (revision 11; Q10) with the known-repo map from the guard config, so the hint lands before the sweep, not after. The sweep still runs: never a deny, because a sweep does not fail (H3). Revision 11 exists because the live eval showed the after-sweep hint arriving too late (one run launched a whole-disk walk after it) and missing `find "$HOME"` | n/a |
| 6 | scope | Active only if `<session cwd>/.codex/scope.json` exists (repo roots, allowed globs, PR, goal). Trips on an `apply_patch` target outside the allowed globs, or a `cd` into a directory outside the declared roots | Deny + Stop backstop. The reason names the declared PR/goal and allowed globs. At Stop, `git diff --name-only` in each declared root that shows files outside the globs also blocks (drift) | reverting or confirming out-of-scope changes; or the Stop has fired once |

**Scope guard details (revision 12).**
- `scope.json` shape: `{"roots": [absolute repo paths], "allow": [globs relative to a root, e.g. "src/api/**"], "pr": N, "goal": "..."}`. A missing or malformed file makes the guard inactive; a malformed one is logged to `errors.log`, never enforced by guessing.
- A write target inside a declared root must match an `allow` glob. A target inside some other git repository (any ancestor with `.git`) is out of scope. A target in no git repository (scratch files such as `/tmp/pr-body.md`) is allowed.
- **Drift is measured from session start.** At the first guard event of a session, the guard records each root's already-dirty files (`git status --porcelain`). The Stop check flags only files that became dirty after that and match no `allow` glob, so pre-existing work is never blamed on the session.
- A scope redirect is answered (revision 9) when the final message names each out-of-scope file, so the operator sees any deliberate out-of-scope change.

**Scope guard details (revision 13).**
- "Session start" is the first guard event at which `scope.json` is present and valid. A session that writes `scope.json` partway through (for example when a PR starts) gets its baseline then, instead of never having one; the files dirty at that moment, including `scope.json` itself, are baseline. A malformed file is logged once per session, not once per event.
- Drift reported at a Stop, whether it blocked or was already answered in the final message, joins the baseline. The same files never block a later turn of the session, which keeps "blocks at most once" true across turns and not only within one stop.
- Drift paths come from `git status --porcelain -z`, so paths with spaces are exact, and a rename is reported by its destination.

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

## 5.3 Step-4 specification: Codex ports of the Stop gates (revision 14; accepted in PR #21)

### Reproduction (2026-09-23)

`~/.codex/hooks/evidence-gate.sh` and `~/.codex/hooks/round-guard.sh` are
byte-identical to the Claude copies and are registered as Codex Stop hooks in
`~/.codex/hooks.json`. Codex passes `transcript_path` (the codex binary
contains the field in its hook input schemas), so both hooks run. They never
block, because they parse only the Claude transcript row shape.
- Specimen: a real Codex rollout, plus one appended assistant row in the
  rollout's own shape claiming "Committed as deadbeefc0ffee1 ... 41 passed".
  `evidence-gate.sh`: exit 0, no output.
- The only variable changed is the row shape. The same sentence as a Claude row
  blocks, listing `test count: 41 passed` and `git object id: deadbeefc0ffee1`.
  The same holds for `round-guard.sh`: five pushes in Claude shape block, and
  five pushes in Codex shape do not.
- Root cause: the row parser. The token rules and thresholds are not at fault.

Codex rollout facts, from 40 recent rollouts:
- Every `git push` (211 of 211) runs inside a code-mode
  `response_item/custom_tool_call` named `exec`, whose `input` is a JS script
  calling `tools.exec_command({"cmd": "...", ...})`, sometimes several times in
  one script. None ran as a plain `function_call`.
- Tool output is in `custom_tool_call_output` and `function_call_output`. The
  `output` is either a string or a list of `{text}` parts, and an `exec` chunk
  may be a JSON object with `output` and `exit_code`.
- Assistant prose is `response_item/message` with role `assistant` and
  `output_text` parts. `event_msg/agent_message` duplicates it and is ignored.
- Each turn starts with `event_msg/task_started` carrying `turn_id`.

### Design

- **Where.** The two Stop gates become Stop checks inside the guard dispatcher
  (`hooks/codex-guards/guard.mjs`), in `hooks/codex-guards/stop/`, and not
  separate hook entries:
  - one Stop invocation;
  - one combined block reason with the pending guard redirects;
  - one `stop_hook_active` rule, so the whole Stop still blocks at most once.

  They are installed and trusted with the existing guards (no new hooks.json
  entry, so no new trust step). The dormant shell entries stay registered,
  because trust is keyed by position and removing entries would shift it. They
  remain no-ops, which the reproduction shows, and they cost a few
  milliseconds. The Claude hooks are untouched (H6).
- **Rollout reader** (`hooks/codex-guards/lib/rollout.mjs`). A streaming parse
  of `transcript_path`:
  - It tolerates bad lines, missing files, and control characters (JSON with
    `strict=False` semantics). A reader error means that gate is skipped and
    logged (H4).
  - Current turn: the rows after the last `task_started`. If there is none, the
    whole file.
  - Prose: the assistant `output_text` in the current turn, plus the Stop
    input's `last_assistant_message` when it is not already present, since the
    final message may not be flushed to the rollout when Stop fires.
  - Evidence: every tool output text in the current turn. For a JSON `exec`
    chunk, its `output` plus `exit_code=N`.
  - Commands: every `cmd` string literal of `tools.exec_command({...})` in
    `exec` inputs, JSON-decoded, plus `function_call` arguments `cmd` or
    `command`. For the whole session, not only the turn.
- **evidence gate (port).** The same rules as `evidence-gate.sh`, ported
  verbatim:
  - token patterns: test node, test count, exit code, git object id;
  - required context (TEST_CTX, GIT_CTX);
  - hedging judged in the token's own sentence;
  - fenced blocks ignored;
  - backed = appears case-insensitively in the current turn's evidence;
  - at most 12 tokens listed.

  The block reason keeps the three options (run it and quote the output, mark
  it unverified, attribute it), which is H2 for a claim.
- **round guard (port).** The same rules as `round-guard.sh`:
  - it counts `git push` commands per branch over the session;
  - the refspec regex and the `<current-branch>` fallback are unchanged;
  - the subject is the most recently pushed branch;
  - tiers are 5/10/15/20;
  - it fires once per (session, branch, tier).

  The stamps live in the dispatcher's session state (`roundGuardFired`), not in
  `~/.claude/hooks/state`. The reason keeps the four questions (root cause, own
  churn, the cut, the decision), and names `/home/.../.codex/hooks/CONTRACT.md`
  by absolute path only if that file exists, so no dangling pointer (H2).
- **Answered (revision 9 analogue).**
  - The evidence gate has none of its own: re-running the same check on the
    next Stop is the answer, and `stop_hook_active` stops a loop.
  - The round guard is answered only by a final message that addresses it. It
    fires once per tier regardless.
- **Parity.** A shared claim corpus runs through both
  `~/.claude/hooks/evidence-gate.sh` (Claude-shape transcript) and the Node gate
  (the equivalent Codex rollout), and the verdicts must be identical. The same
  applies to round-guard counts. This locks the port against drift from the
  Claude original. The test reads the Claude script from
  `$HOME/.claude/hooks/`, and skips with a visible message when that file is
  absent (CI), with a vendored copy of the corpus verdicts as the fallback
  assertion.

### Settling evidence for step 4

- Must block on a real rollout: a copy of a real Codex rollout with one
  appended final message, in the rollout's own shape, making an unbacked claim;
  and a real rollout (or a copy of one) with at least 5 pushes to one branch in
  real `exec` shape.
- Must pass on real rollouts: the same claim when the token is in that turn's
  tool output; a hedged claim; a claim without test or git context; a session
  with 4 pushes; and the most recent 20 real rollouts replayed at each
  `task_complete`. The replay's block rate is reported. It is not asserted,
  because some historical turns really did make unbacked claims. Every replay
  block is listed for review before merge, to find false blocks (H3).
- Unit tests on both sides for:
  - the rollout reader: turn boundary, several `exec_command` calls in one
    script, escaped quotes in `cmd`, list and string outputs, JSON `exec`
    chunks, bad lines;
  - once-per-Stop blocking together with pending guard redirects.
- A live eval scenario per gate:
  - `stop-evidence`: a task whose natural reply cites a SHA that the model has
    to fetch;
  - `stop-round`: a fixture repo and task that push 5 times.

  Each is graded on the block firing and the model acting on it before the turn
  ends. The fixture remote is a local bare repo, so nothing leaves the machine.

### Replay findings (revision 15)

The first replay of 20 native rollouts (173 turns, 19 blocks) was reviewed
block by block. Three deliberate changes came out of it. Each one is a named
divergence from the Claude original, and the parity test asserts it
separately:
- **Sub-agent reports are evidence.** In the owner's rollout,
  `response_item/agent_message` rows are reports from spawned agents (author
  `/root/<child>`, recipient `/root`; outbound instructions are `spawn_agent` /
  `send_message` calls). The Claude original counts a sub-agent's result, a
  `tool_result`, as evidence. Without this change, a commit SHA that a
  sub-agent reported and the parent relayed was flagged (5 tokens in one
  turn).
- **`#N passed` is not a count.** "DocSum PR #90 passed its review gate" was
  flagged as the test count "90 passed", with "gate" supplying the test
  context. A number directly preceded by `#` is an identifier. The Claude
  original has the same false positive. It stays untouched (H6), and the fix
  is offered there as a follow-up.
- **`HEAD` and bare pushes are keyed by working directory.** The original
  counts every `git push origin HEAD` in one `HEAD` bucket, and every push
  without a refspec in one `<current-branch>` bucket. Codex drives many repos
  from one session, so those buckets mixed unrelated work: one session fired
  tier 5 on five pushes across four repositories, and another's bucket held 34
  pushes from five working directories. Codex records a `workdir` on every
  `exec_command`, so such a push is keyed by that directory, or by a leading
  `cd <dir> &&` in the command, and the reason names the directory. A push with
  neither falls back to the original's bucket. A push with a named branch is
  keyed by name, as before.

Unchanged and inherited, noted but not fixed: evidence matching is a substring
match, so "26 failed" is backed by an unrelated "Exact 26 failed nodes" line in
the same turn. This is the same looseness as the original, on the side of
not blocking.

### Live findings (revision 16)

In the live `stop-round` eval, the round guard fired in 1 of the first 3 runs,
and in 0 of 3 once the runner kept each run's rollout. Every run pushed 5
times. Reproduced offline on the kept rollouts, where the reader found 0-1
pushes:
- **Pushes run from loops.** The model wrote
  `for (const cmd of ["git add ...", "git commit ...", "git push origin feature"]) await tools.exec_command({cmd, workdir})`.
  `cmd` is shorthand for a variable, so the script source has no command
  literal to read. Reading commands from source cannot follow loops, arrays,
  or template strings.
- **Codex records what actually ran.** Newer rollouts carry one
  `event_msg/item_completed` row per execution with `item.type:
  "CommandExecution"`, the argv (`["/bin/bash", "-lc", "<command>"]`), and the
  real `cwd` (a `file://` URL). All 5 pushes are there. Round counting
  therefore uses these rows whenever a session has any, and falls back to the
  source literals only for sessions without them (12 of the 40 surveyed
  rollouts have them). The script of a `-c`/`-lc` shell argv is the command;
  any other argv is joined with spaces.
- **Text is not a push.** The same run appended a session-ledger line after
  each push, `printf '... git push origin feature ...' >> .codex/SESSION_LEDGER.md`
  (global rule 12 makes such writes routine). The original counts any command
  that *contains* "git push", which would double the count. A push now counts
  only when `git` is at a command position (the start, or after `&&`, `||`,
  `;`, `|`, or a newline, after any `VAR=value` prefixes), optionally with
  `-C <dir>`, followed by `push`. The refspec is read from that push, and
  `-C <dir>` sets the directory the same way a leading `cd` does. This is a
  fourth named divergence from the Claude original.
- **Evidence is unchanged.** The evidence gate keeps using the tool outputs
  the model received (`custom_tool_call_output`), not `CommandExecution`
  output, which the model sees only if the script printed it.

The eval runner now keeps each guarded run's rollout and the guard's
`errors.log` as artifacts. A failed run whose required guard never fired now
says so first ("required guard denial absent"), where before the other
failures hid it.

### Claude originals brought to parity (revision 17)

On 2026-09-23 the Claude `round-guard.sh` fired "14 pushes to
`<current-branch>`" on a Claude session that had pushed 17 different branches
once each. The cause was the revision 15-16 defects. At the operator's
direction, both Claude originals (`~/.claude/hooks/`, and their byte-identical
dormant copies in `~/.codex/hooks/`) received the same fixes:
- the evidence gate treats `#N passed` as an identifier;
- the round guard counts only a command-position `git [-C dir] push` outside
  quoted text and heredoc bodies, and keys `HEAD` and bare pushes by `-C`,
  then a leading `cd`, then the transcript row's `cwd`.

Heredoc bodies were a case the Codex port did not need yet: Claude writes
setup scripts with `cat > f <<'EOF'`. H6 still holds for the lab guards, which
never modify Claude hooks. This change was an operator-directed edit made
outside the lab. The parity test now expects the two sides to agree on every
case.

### Behavior change for the operator

Once installed, Codex turns that cite unbacked counts, SHAs, or test nodes get
one continuation asking for evidence or a hedge. Fix loops get a
checkpoint question at 5, 10, 15, and 20 pushes per branch. Neither ends a
turn. (Revision 18 retires the fix-loop checkpoint in favor of the seam
redirects in section 5.4.)

## 5.4 Step-6 specification: seam redirect (revision 18; accepted in PR #30)

### Reproduction (2026-10-04)

The source is one Codex Desktop session (codex-cli 0.159.2, 2026-10-01 to
2026-10-04) in a private repository. Branch names, PR numbers, and product
details are withheld here. "PR A" is the PR whose loop is described below.
The guard log (`denials.jsonl`) records three `round-guard` firings for the
session: 2026-10-03T06:15:13Z, 2026-10-04T06:43:52Z, and
2026-10-04T18:32:23Z. Its `CommandExecution` rows (revision 16) and messages
show the following:
- **01:03Z.** PR A is created with `--base` set to a branch the same session
  had pushed, so it is stacked on the session's own earlier work. This is
  push 1 of PR A's branch.
- **01:26Z.** The first read of PR A's review threads
  (`gh api graphql ... pullRequest(number:N) { ... reviewThreads ...`).
- **01:29Z, 04:46Z, 05:47Z, 06:13Z.** Pushes 2-5. The round guard fires at
  tier 5 at 06:15:13Z, about five hours and four pushes after the first
  review read.
- **06:16Z.** The model's tier-5 answer contains the seam diagnosis:
  "Completeness and association must use the same source unit." It also says
  "Three corrective rounds repaired my code overall".
- **06:27Z.** The operator types the redirect by hand: "Go back find where you
  introduced the churn and fix that. Don't start symptom patching. Share seams
  when possible and cononicsl docs when possible." On 2026-10-04 at 04:10Z the
  operator repeats it: "fix issues you introduced at the sourc,no symptom
  patching".
- **2026-10-04, tier 10.** The model's root cause: "shared rules were
  implemented incompletely in field-specific checks and duplicated ordering
  logic. The fixes now use common admission and production-owned ordering."
  Its decision, as question 4 offered: "merge on green and reviewed; defer the
  rest." The operator answers "Merge and defer." (14:39Z), and the session
  runs PR A's merge command at 14:41Z. One deferred item, which the same
  answer said "belongs in" a follow-up issue, becomes a new branch. That
  branch reaches 5 pushes: the third firing (18:32:23Z).

Diagnosis:
- **Timing.** The guard waits for a count. Every early signal was observable
  to a hook before push 2: the stacked PR create and the first review read.
- **It is a stop, not a redirect.** The checkpoint arrives at Stop and asks
  for a report: four questions, then a decision. Questions 3 ("THE CUT") and
  4 ("THE DECISION: merge now on green, defer the rest to a follow-up issue,
  or continue") turn the loop into a choice for the operator, with
  merge-and-defer on the menu. The model picked it, and the deferral became
  another loop.
- **The model knows the seam once it looks.** Both checkpoint answers named
  the shared owner. What was missing was the next action, at the start of a
  round: trace the finding to its origin and fix it there. The operator's
  assessment is that prevention would not work well, but an early nudge would
  let Codex change course instead of stopping.

Operator review of the first draft of this revision (PR #30): "It still
looks like a stop hook, id rather he redirect." That draft asked for numbered
one-line answers and kept a reworded Stop checkpoint. This revision drops
both.

Also observed: the Codex hooks UI lists the inert `~/.codex/hooks/round-guard.sh`
entry (section 5.3) as a Stop hook. The operator took it for the live guard;
the live guard is the dispatcher's port.

### Principle: redirect, not stop

- A seam redirect names the next action, and the model takes it in the same
  turn. It asks for no written answer, no checkpoint report, and no decision
  from the model or the operator.
- It lands where the model chooses its next action in a fix round: right
  after review findings arrive, at a re-push, and at a follow-up PR.
- No part of the seam redirect runs at Stop. The round guard's Stop
  checkpoint (section 5.3) is retired, and its push counting moves to the
  push itself (R2).

### Observable behavior

Definitions:
- **Directory scope**: the directory a command runs in: `-C <dir>`, then a
  leading `cd <dir>`, then the hook `cwd`. It is the one owner of "where" in
  the seam redirect (revision 19). Branch keys, PR keys without a stated
  repository, and push epochs all use it.
- **Push epoch**: per directory scope, the number of `git push` commands the
  dispatcher has seen at PreToolUse from that scope in this session
  (revision 19; revision 18 counted every push in the session, so a push in
  repository B started a new round for a PR of repository A). Every
  per-epoch rule reads the epoch of the triggering command's scope: R1 the
  read's, R2 the push's, and R3 the created branch's or the
  `gh pr create`'s. That covers the SR3 stamps, R1's round count, and R2's
  quiet rule. A stamp records its scope with the epoch, so a PR key read from
  two scopes does not share an epoch. A PR key prefixed with a stated
  repository is still measured against the epoch of the scope the read runs
  in, because mapping a repository to a directory needs I/O (SR4). Pushes
  are counted with `pushesIn` from `stop/round-guard.mjs` (the
  command-position rules of revision 16), so one parser defines a push. An
  attempted push counts, even if the remote rejects it. Hooks see each
  executed command, so the source-literal loop problem of revision 16 does
  not apply here.
- **Own branch**: a branch this session created or opened a PR from,
  learned without running git (SR4). Either is enough:
  - the `--head`/`-H` of a `gh pr create` the session ran;
  - a branch the session created with `git checkout -b`,
    `git switch -c`/`--create`, or `git worktree add -b`. Git refuses these
    when the branch exists. The reset forms (`checkout -B`, `switch -C`/
    `--force-create`, `worktree add -B`) also reset an existing branch, so
    they prove nothing: `git checkout -B develop origin/develop` resets a
    shared branch (revision 19).

  A push alone is not proof of ownership. Sessions push shared branches too:
  a default branch such as `develop` or `trunk` in maintenance, and `main` in
  fixture setup. The noise replay found 4 false "stacked on main" R3
  redirects when named pushes counted. `main` and `master` are also never
  own branches, even when created, since a PR against them is the normal
  case. Neither an unnamed base nor a whole working directory counts as
  owned. The reproduction is still covered: its stacked base was the
  `--head` of a PR the same session had opened.
- **PR key**: the PR number named in the command, or `current` when none is
  named (`gh pr view --comments` on the checked-out branch).
- **Repository namespacing.** One session often drives several repositories.
  The reproduction session read another repository's PR in the same GraphQL
  query. So every key carries where it belongs:
  - **Branch keys** (push subjects, own branches, and `gh pr create`
    `--base`/`--head`) are prefixed with the command's directory scope:
    `-C <dir>`, then a leading `cd <dir>`, then the hook `cwd`. `pushesIn` reports that
    directory for every push. Its `key` for named branches is unchanged, so
    the parity with the Claude original holds.
  - **PR keys** are prefixed with the repository the command states:
    `--repo`/`-R`, a `repos/<o>/<r>/` path, a PR URL, or the
    `repository(owner:, name:)` that encloses each `pullRequest(number:)` in a
    GraphQL query. Without one, the PR key falls back to the command's
    directory.

  The hook cannot see a command's `workdir` (probe Q7). A session that
  switches repositories only through `workdir`, never stating `cd`, `-C`, or
  `--repo`, therefore still shares one directory key. That is the remaining
  collision, and it can only add or drop a redirect, never block. The replay
  passes the real `cwd`, so it measures the best case.

The three triggers below are all context-only. None denies, blocks, rewrites,
or records a pending redirect.

| # | Trigger | Event | Fires when (all conditions) | Once per |
|---|---|---|---|---|
| R1 | review read | PostToolUse (the redirect arrives right after the findings) | The output shows review text: a JSON response with a non-empty `body` anywhere, or non-empty output that is not JSON (for example `gh pr view --comments`). A JSON response with no `body` (a status check that happens to include `reviews`) and an empty output do not fire and consume no stamp. In the noise replay, 31 of 246 matching reads were JSON with no review text. The command segment is one of: `gh pr view [N]` with `--comments`; `gh pr view [N] --json` naming `comments`, `reviews`, or `latestReviews`; `gh api repos/<o>/<r>/pulls/<N>/(comments\|reviews)[/...]`; `gh api repos/<o>/<r>/issues/<N>/comments`; `gh api graphql` whose query names `pullRequest(number:<N>)` and `reviewThreads`, `reviews`, or `comments`; `codex-pr-status ... --pr <N>` | (PR key, push epoch) |
| R2 | re-push | PreToolUse context (Q10: the push runs) | A push to a subject this session has already pushed at least once (round R >= 2), and no seam redirect has fired in the current epoch of the push's directory scope | (subject, push epoch) |
| R3 | follow-up work on own work | PreToolUse context | Earliest, before any work: a branch created with an own branch as its start point (`git checkout -b <new> <own>`, `git switch -c <new> <own>`, or `git worktree add -b <new> <path> <own>`). Then at the PR: `gh pr create` with `--base`/`-B` naming an own branch (stacked on own work). A PR title and an earlier `gh pr merge` are not a trigger: chronology and a common title word do not tie a new PR to merged work, so an unstacked "Fix ..." PR gets no R3. A context-only hook cannot stop the create (Q10), so the PR-time text is written for after the PR exists | (start point or base; push epoch) |

All three parse with `segments` from `lib/shell.mjs`. Quoted text, `echo` and
`printf` arguments, heredoc bodies, and session-ledger appends are not
commands.

Parsing details (found while checking the triggers against the reproduction
rollout):
- **Heredocs.** Codex often runs one script that writes a ledger line through
  `python - <<'PY' ... PY` and then runs `gh` or `git` (the 01:03Z
  `gh pr create` is one). `segments` refuses any command containing `<<`. R1
  and R3 therefore read `segments(withoutHeredocs(command))`. The new
  `withoutHeredocs` in `lib/shell.mjs` removes each `<<[-]WORD` operator
  (quoted or not), and the body from the next line through the line that is
  exactly `WORD` (leading tabs allowed for `<<-`). This is the same rule as
  the Claude round guard's mask (revision 17). `segments` itself is
  unchanged, so read-path still refuses heredocs. A command that is still
  unreadable (`$(`, backticks, variables) gets no R1 or R3.
- **Pushes in heredocs.** `pushesIn` applies `withoutHeredocs` before
  looking for pushes. A script that writes `git push origin x` into a
  heredoc body (a setup script, a ledger) is not a push, so a branch's first
  real push is never labeled push 2. This closes the gap revision 17 noted
  ("Heredoc bodies were a case the Codex port did not need yet"). The Codex
  and Claude counters now agree on heredocs, and the parity corpus gains a
  heredoc case.
- **Reads, not writes.** In the reproduction, Codex replies to review
  threads with `gh api repos/<o>/<r>/pulls/<N>/comments/<id>/replies
  --input <file>`. That is a write made after the fix, not a read. A
  `gh api` call is not a review read when any of these holds:
  - it has `--input`;
  - it has `-X`/`--method` other than `GET`;
  - it targets a REST path with a field flag (`-f`, `-F`, `--field`,
    `--raw-field`), which makes gh send a POST;
  - its path ends in `/replies`;
  - it is a GraphQL query whose text starts with `mutation`.
- **Several commands in one call.** When one event carries more than one
  redirect (for example a push and a `gh pr create` in one script), the
  texts are joined into one context output.

**Redirect text.** Each redirect is a short list of actions. None contains a
question addressed to the model, or a request to reply.

R1 (review read):

```
[seam-redirect] Review feedback on PR #<N>. Before patching the line a finding points at:
- Trace where it came from: <trace commands>. If the line came from an earlier change in this session, fix that change; do not add a check after it.
- Find the other copies: search code, tests, and docs for the rule, constant, or field the finding names (rg -n '<name>'). If it lives in more than one place, give it one owner and make the others use it.
- If a doc restates the contract, edit the canonical doc and link to it.
Then make that fix.
```

`<trace commands>` is filled best-effort from the review output the hook just
received (`tool_response`). If R1 finds `path` and `line` pairs in the shapes
the reproduction used (the `gh api .../pulls/<N>/comments` JSON fields, and
`path` and `line` on GraphQL `reviewThreads` comments), it lists up to 3
concrete commands, such as `git log -L 120,120:src/x.py`. Otherwise it reads
`git blame -L <line>,<line> <path>` for each finding. An output it cannot
parse produces the generic form; it is not an error.

Review-derived paths are untrusted (a PR can add any filename), and the model
may run the command it is shown. So:
- A path is always emitted single-quoted, unless it contains only
  `[A-Za-z0-9_./@+-]`. A `'` inside it is written as `'\''`.
- A path containing a control character or a backslash, longer than 200
  characters, or starting with `-` is dropped. The line falls back to the
  generic form.
- The line number must be a positive integer.

A malicious-path fixture (`;`, `$(...)`, a backtick, a newline, and a
leading `-`) proves every case either quoted or dropped.

R1 escalates by **review round**: the k-th R1 for one PR key in a session
(at most one per epoch, so k counts the rounds in which that PR's review was
read). From k = 2, R1 adds one line after the header: `Review round <k> on
PR #<N>: findings that keep arriving in one class mean the rule lives in more
than one place. Consolidate it at one owner in the next commit, instead of
fixing the next finding by itself.` In the reproduction, every round starts
with a review read, so R1 is what reaches the model each round; R2's
one-per-epoch rule keeps it quiet in those rounds. A command that reads
several PRs (a GraphQL query with several `pullRequest(number:N)`) is keyed
by each number; the redirect names the PRs not yet stamped in the epoch.

R2 (re-push of push R to `<label>`):
- R = 2: `[seam-redirect] Push 2 to <label> is a fix round on your own change. If this fix added a case beside an existing one, move the rule to one owner in the next commit; trace it with git blame -L or git log -L first.`
- R >= 3: `[seam-redirect] Push <R> to <label>: <R-1> fix rounds on one change. Findings that keep arriving in one class mean the rule lives in more than one place. Next commit: trace the class to the change that introduced it and consolidate it at one owner, instead of fixing the next finding by itself.`

R3, at a branch started from own work (before any work exists):

```
[seam-redirect] <new> starts from this session's own unmerged work (<own>). If it fixes a defect <own> introduced, commit the fix on <own> instead of a new branch, so the fix lands where the defect came from.
```

R3, at the PR (the call runs, so the PR exists when this arrives):

```
[seam-redirect] This PR is stacked on this session's own work (<base>). If it fixes a defect <base> introduced, put the fix where the defect came from:
- If <base> is not merged yet, move the fix onto <base> and close this PR as superseded.
- If it merged, fix the rule at its owner and name the introducing commit in the PR body.
```

### What leaves Stop (amends section 5.3)

- `round-guard` is removed from `STOP_GATES`. Its counting functions
  (`pushesIn`, `roundVerdict`) stay: they define a push and a round, and R2
  uses them.
- The parity test keeps comparing subjects and counts with the Claude
  original. It calls the counting function on the rollout's commands
  directly, instead of through the Stop gate.
- The `stop-round` live scenario is retired and replaced by `seam-push`
  (below).
- Stop keeps the evidence gate and the step-3 pending-redirect backstop,
  unchanged.
- `~/.codex/hooks.json` is unchanged. No entry is added, so there is no new
  trust step. The dormant shell entries stay, because trust is keyed by
  position (section 5.3).
- The Claude hooks are unchanged (H6).
- Stated tradeoff: the Stop checkpoint was the channel measured as acted on
  11/11 (section 5.1, Q3). Context is measured as delivered and used (Q4,
  Q10), but how often this content is acted on is not measured yet. The live
  eval measures it and reports the rate. If the rate falls short, delivery is
  changed in a later revision. The questionnaire and the decision menu do not
  come back.

### Invariants

- **SR1 Redirect only.** A seam redirect never denies, blocks, rewrites,
  records a pending redirect, asks for a written answer, or asks for a
  decision. It always names the next action (H1, H2, H3).
- **SR2 One parser per concept.** A push is whatever `pushesIn` says (with
  heredoc bodies removed); command segments are whatever `segments` says. The seam redirect adds no
  second push or shell parser.
- **SR3 Rate limit.** At most one redirect per key per push epoch, as in the
  table. The stamps live in the session state under `seam`. In practice this
  means one redirect at the start of each fix round.
- **SR4 No I/O on tool events.** R1-R3 read only the hook input (including
  R1's `tool_response`) and the session state: no git, no gh, no network,
  and no rollout read. (The reproduction's rollout is 44,983,979 bytes;
  reading it on every tool event is not acceptable.)
- **SR5 Fail open (H4).** A seam error produces no redirect, lets the call
  proceed, and appends to `errors.log`.
- **SR6 Measurable.** Every redirect is logged to `denials.jsonl` as
  `{code: "seam-redirect", kind: "review" | "push" | "followup"}`, so step 5
  can measure whether loops still reach 5 pushes on one subject.
- **SR7 No shortcut menu.** No redirect offers merge, defer, or stop as an
  option, and none asks for a reply. Mechanically: no redirect text matches
  `\?` or the whole words `\b(answer|reply|recommend|merge|defer|stop)\b`
  (case-insensitive). Describing a branch's state ("merged", "not merged
  yet") is not offering a merge, and does not match.

### Concurrency model

- Each hook event runs one dispatcher process. Session state is one JSON
  file, written whole by atomic rename.
- Claude Code runs the hooks of parallel tool calls concurrently (hooks
  reference, PostToolBatch). Whether Codex does within one session (parallel
  `exec_command` calls in one code-mode script) has not been probed; section
  5.1 has no such question. Without a lock, two processes read the same state
  and the second write erases the first's update: a lost stamp repeats a
  redirect, and a lost epoch increment or push count misses one. The
  `pending` state has the same race.
- **Session lock (revision 20).** Both entry points (`guard.mjs` and
  `claude-seam.mjs`) serialize each session's read, decide, and write with
  one shared helper: an exclusive lock file beside the state file,
  `session-<id>.json.lock`. Revision 18 added no lock, because a lock left by
  a killed hook would stall every later event (H4). The lock is bounded
  instead:
  - A waiter retries for up to 2 s. When the wait runs out, the event is
    skipped: no output, no state change, and a line in `errors.log` (SR5).
  - A lock older than 10 s, the hook timeout, was left by a killed hook. The
    next waiter removes it and takes the lock.
  - Two waiters that find the same stale lock at the same moment can both
    proceed once. That needs a killed hook and a race together.
- Each session has its own state file and lock. Two sessions on one PR count
  their own epochs.

### Settling evidence for step 6

- **Unit tests on both sides**, per trigger:
  - R1 must trip on each listed command form. It must not trip on
    `gh pr view N --json state,headRefOid`, `gh pr checks N`, `gh pr list`,
    `echo "gh pr view 12 --comments"`, a heredoc body containing the command,
    or a second read of the same PR in the same epoch.
  - R1 must not trip on any write form listed under "Reads, not writes".
  - R1 and R3 must trip on their command when it follows a heredoc in the
    same script (the 01:03Z shape). `withoutHeredocs` has its own tests on
    both sides: quoted and bare words, `<<-`, an unterminated body, and text
    after the terminator.
  - R1 must not trip on a JSON response with no `body`, or on an empty
    output, and must trip on a later read in the same epoch that does carry
    review text.
  - Keys are namespaced: the same branch name pushed in two directories, the
    same PR number in two stated repositories, and `--base feature` in
    another directory must not affect each other. `--base main` and
    `--base master` never count as stacked.
  - Epochs are per directory scope (revision 19): read PR 12 in `/a`, push
    in `/b`, and reread PR 12 in `/a` gives no second R1. A push in `/a`
    and then a reread gives R1 with the review-round-2 line. An R1 in `/a`
    does not quiet R2 for a re-push in `/b`.
  - R1 must trip again after a push, with the review-round-2 line on its
    second firing for the same PR, and must name each unstamped PR of a
    multi-PR query.
  - R1 must fill concrete trace commands from both observed review-output
    shapes, and fall back to the generic form on output it cannot parse.
  - R2 must trip on the second push to a subject, with the R >= 3 text from
    the third push on. It must not trip on the first push, on a first push to
    a different subject, on `printf '... git push origin x ...' >> ledger`,
    on a `git push` line inside a heredoc body, or when R1 already fired in
    the epoch.
  - R3 must trip on `--base <own branch>` for each own-branch source (the
    `--head` of an earlier `gh pr create`; `git checkout -b`,
    `git switch -c`, and `git worktree add -b`). It must trip at branch
    creation from an own start point, before any PR. It must not trip on
    `--base develop` after `git push origin develop`, on `--base main` after
    only `git push origin HEAD` pushes, on `--base main` with a feature
    title, or on an unstacked fix-titled create, with or without an earlier
    `gh pr merge` in the session. The reset forms record no own branch:
    after `git checkout -B develop origin/develop`, `git switch -C develop`,
    `git switch --force-create develop`, or
    `git worktree add -B develop ../wt`, a later
    `git checkout -b fix develop` gives no R3.
  - The output validates against the probe-verified context shapes (Q4 for
    PostToolUse, Q10 for PreToolUse).
- **Redirect only.** Across the unit fixtures:
  - no redirect text matches the SR7 patterns, for every template and
    every escalation (R1 at k = 1 and 2, R2 at R = 2 and 3, R3 at the
    branch and at the PR);
  - `runStopGates` returns no round-guard finding for rollouts with 5, 10,
    and 20 pushes to one branch;
  - the evidence-gate tests and the parity test (now calling the counter
    directly) pass.
- **Incident replay.** `scripts/replay-seam-redirect.mjs <rollout>` replays
  the rollout through `decide()` from a fresh state:
  - each `CommandExecution` row is fed in order as a PreToolUse event, then a
    PostToolUse event (with the row's output as `tool_response` when the row
    carries it);
  - each redirect is printed with its row's timestamp.

  On the reproduction rollout:
  - R3 must fire at the stacked PR create (01:03Z);
  - R1 must fire at the first review read of PR A (01:26Z), before push 2
    (01:29Z);
  - R2 must not fire at push 2, because R1 already fired in that epoch;
  - R1 with the review-round-2 line must fire at the next review read
    (03:42Z), before push 3 (04:46Z). The old checkpoint fired after push 5
    (06:15:13Z).

  The replay also reports which redirect, if any, fired in each of PR A's
  epochs. The rollout is private and stays
  local: the test skips with a visible message when it is absent, as the
  parity test does for `~/.claude/hooks`.
- **Noise replay.** Replay the 20 most recent rollouts and report:
  - redirects per session and per push epoch;
  - for every historical round-guard firing, the first seam redirect on the
    same subject and how many pushes earlier it came.

  Every redirect is listed for review before merge. No rate is asserted (the
  revision 14 practice).
- **Grader additions** (the instruction-eval grader can check neither of
  these today):
  - `expected.forbiddenDenials`: codes or `code:kind` entries that must not
    appear in the run's denial log. It fails the run, for example on
    `round-guard` (the retired checkpoint).
  - An optional `check.sh` per scenario, which the runner executes in the
    fixture workspace after the run and before cleanup. Its exit status and
    last output lines are saved beside the run's artifacts, and a nonzero
    exit fails the run. A scenario without one is graded as before. Both
    additions have unit tests on both sides.
- **Live eval.** Both scenarios use a fixture repo with a local bare remote, a
  `gh` shim, and a validation rule duplicated in two functions.
  - `seam-review`: the shim's one review comment reports a symptom of one
    copy. It is graded on three things: the `seam-redirect` entry being
    logged; `check.sh` passing, which confirms the rule's literal appears in
    exactly one source file; and no `round-guard` entry
    (`forbiddenDenials`). The evidence gate is a separate Stop gate, so it
    may still block a run that makes unbacked claims; that does not fail
    this scenario.
  - `seam-push`: the task fixes the first comment and pushes. Then a test
    run, not a review read, reports a second failure in the same class. If
    the second finding came from a review read, R1 would fire for it and
    R2's one-per-epoch rule would keep R2 quiet. It is graded on three
    things: the `seam-redirect:push` entry, `check.sh` confirming that the
    second fix consolidated the rule, and no `round-guard` entry. It replaces
    `stop-round` (renamed, not deleted).
  - Each scenario's acted-on rate across runs is reported, which settles the
    tradeoff stated above. Both scenarios map to global rule G8 (take the
    hardened path; fix the root cause, not the symptom).
- **Install.** `npm run guards:install`, then `npm run guards:status` passes.
  The installer test asserts that `~/.codex/hooks.json` entries are unchanged.

### Behavior change for the operator

The end-of-turn questionnaire for fix loops is gone: no "root cause / churn /
cut / decision", and no merge-or-defer menu. Instead, while it works, Codex
gets a one-step redirect when it:
- reads review comments;
- re-pushes a branch it has already pushed; or
- opens a PR that repairs its own work.

The redirect says where to look (trace the finding to the change that
introduced it), what to consolidate (one owner, one canonical doc), and then
to make that fix. Nothing asks Codex or the operator for a decision, and
nothing ends or holds the turn. The evidence gate at Stop is unchanged. If
the redirects work, the global AGENTS.md prose on root-cause fixes becomes a
step-5 trim candidate.

### Claude Code (revision 20)

Operator decision (2026-10-04): convert the Claude round guard to the same
redirects, and remove the round-guard Stop hooks on both sides.

- **Removed.** The `round-guard.sh` Stop entry and script, in `~/.claude/`
  and in `~/.codex/`. The Codex copy was inert: it reads Claude `tool_use`
  blocks, and printed nothing on the reproduction rollout. Removing the Codex
  entry moves the lab guards' Stop entry from `stop:2:0` to `stop:1:0`, so
  the operator re-trusts it (H7). These are one-time, operator-directed edits
  made outside the installer (the revision 17 precedent).
- **One module.** `hooks/codex-guards/claude-seam.mjs` is the Claude Code
  entry point. It calls the dispatcher's `decide()` with no other guards, as
  the replay does, so R1-R3, the keys, the epochs, the texts, and SR1-SR7 are
  the seam module's, unchanged. There is no second implementation.
- **Registration.** `~/.claude/settings.json` gains a `PreToolUse` and a
  `PostToolUse` entry with matcher `Bash`, running
  `node '<install dir>/claude-seam.mjs'`, with the fields the existing Claude
  entries use (`type`, `command`, `timeout`). Claude Code delivers
  `hookSpecificOutput.additionalContext` on both events and keeps every
  hook's context (hooks guide, "Combine results from multiple hooks"). Exit 0
  with no output leaves the call to the normal flow.
- **Input mapping.** Claude's Bash `tool_response` is an object. In session
  transcripts it carries `stdout` and `stderr`; the hooks reference example
  shows `{type, text}`. The adapter joins `stdout`, `stderr`, and `text`
  where present, and passes a string as is, which matches the Codex
  aggregated output that R1 reads. `tool_input.command`, `cwd`, and
  `session_id` are read as for Codex. Any other tool and any other event give
  no output.
- **State and logs.** `~/.local/state/sol-lab/claude-seam/`: one session file
  per Claude session, `heartbeat.json`, `redirects.jsonl`
  (`{code: "seam-redirect", kind}`, SR6), and `errors.log`. Nothing is shared
  with the Codex state.
- **Fail open (SR5).** Any error exits 0 with no output and appends to
  `errors.log`.
- **Concurrency.** Claude runs the hooks of parallel tool calls
  concurrently, so the adapter takes the session lock described under
  "Concurrency model" above, the same helper the Codex dispatcher uses.
- **Installer.** `npm run guards:install -- --claude [--apply]` copies the
  same guard tree to `~/.claude/hooks/lab-guards/` under its own manifest
  (`claude-seam-install.json`). It appends only its two entries to
  `settings.json`, after backing the file up, and never edits, reorders, or
  removes another entry. `npm run guards:status -- --claude` reports active
  once a Claude session has run the hook after the install.
  Every file the installer replaces keeps its permission bits, for both
  targets. Before this rule, the temp file took the process umask, so the
  revision 20 install turned a `0600` `settings.json` into `0664`, and the
  2026-09-23 Codex install turned `hooks.json` from `0644` into `0664`. Both
  modes were restored by hand.
- **H6 amended.** The Codex install still never touches Claude Code. The
  `--claude` target is a separate, operator-directed install that adds only
  its own entries.
- **Parity.** With the Claude round guard removed, the revision 17 round-guard
  parity case holds the Codex counter to its stated verdicts only, as the
  test already does when the script is absent. The evidence-gate parity is
  unchanged.

Failure cases:
- Claude runs matching hooks in parallel. When `git-guard.sh` denies a push,
  the adapter has already counted it, as an attempted push counts, and its
  redirect text can arrive beside the deny.
- Review text read through an MCP tool or `WebFetch` is not a Bash call, so it
  gets no R1. R2 still fires at the re-push.
- The hook applies to Claude sessions that load it. A session already running
  at install time may keep its earlier hook set; the live check uses a new
  session.

Settling evidence for revision 20:
- **Unit.**
  - The input mapping, for a `stdout`/`stderr` object, `{type, text}`, a
    string, and a missing response.
  - R2 on the second push; R1 on a `gh pr view --comments` read whose
    `stdout` carries review text, and no R1 when `stdout` and `stderr` are
    empty.
  - A non-Bash tool and a Stop event give no output.
  - `main` persists the session state and logs each redirect, and it fails
    open on malformed input.
  - Concurrent hook processes on one session lose no update: parallel pushes
    to distinct branches all count. A lock held past the wait skips the event
    and logs it; a lock older than the hook timeout is removed.
- **Installer.** The Claude target appends exactly two `Bash` entries, keeps
  every other key and entry in order, is idempotent, and backs up
  `settings.json`.
- **Live.** One headless Claude Code session in a scratch repository with a
  local bare remote and a stub `gh` that prints review text. The second push
  logs `seam-redirect:push`, the review read logs `seam-redirect:review`, and
  the session transcript shows the redirect text delivered to the model.

## 6. Failure cases

- Malformed rollout lines (control characters) are parsed leniently and
  counted as `unparsed`, never silently skipped.
- A missing or changed Codex hook schema (a new codex-cli version) makes the
  probe fail loudly. Guards pin the probed codex-cli version and warn on a
  mismatch.
- A guard timeout counts as a guard error (H4).
- Seam redirect (5.4):
  - A review read that is not a recognized command gets no R1 redirect. This
    covers a GitHub MCP tool, `curl`, review text the operator pastes, and a
    read inside a sub-agent. R2 still fires at the re-push. MCP tool shapes
    have not been probed, so they are excluded until they are.
  - `gh pr view --comments` with no number is keyed `current`. Two different
    current-branch PRs in one epoch share that key, so the second gets no
    redirect.
  - A new session on an existing PR starts at epoch 0. R1 fires on its first
    review read; R2 needs two pushes in that session.
  - A push the remote rejects still advances the epoch, which costs at most
    one extra redirect.
  - A review read run from a directory other than the repository's checkout
    (for example `gh pr view 12 --repo o/b --comments` from repository A's
    directory) is measured against that directory's pushes. Its R1 rounds
    then follow A's pushes, which can add or drop an escalation line, never
    block.
  - Ownership is recorded at PreToolUse, before git runs. A `checkout -b`
    that git refuses because the branch exists still records the branch as
    own, which can add one R3.
  - Missing or malformed session state is treated as empty, which costs at
    most one repeated redirect.
  - A review read that finds nothing new still counts as a review round, so
    R1's escalation line can come one round early.
  - R1's best-effort parse of review output can fill a wrong path or line if
    a review shape changes. The redirect still names the action, and the
    model runs the trace command itself, so a wrong guess costs one failed
    command (which the read-path guard already handles).

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
- **Step 6**: each seam redirect is proven on both sides. On the
  reproduction rollout, the first redirect fires before push 2 and the
  escalated one before push 3. Nothing in the seam path
  runs at Stop. The noise replay is listed for review, and the live eval
  reports the acted-on rate.

## 8. Delivery order

1. This contract. Stop for review.
2. Analyzer (step 1). Its ranking orders step 3.
3. Hook probe (step 2), then a contract revision.
4. Guards, helper, and scope guard (step 3), one PR per mechanism, in ranked
   order.
5. Stop-hook ports (step 4).
6. Measurement and AGENTS.md trim candidates (step 5).
7. Seam redirect (step 6): this revision first, stop for review. Then one
   implementation PR: the guard, dispatcher wiring, the round guard's removal
   from Stop, tests, the replay script, and the scenarios. Then install and
   `guards:status`.
8. Claude Code seam adapter (revision 20): this revision first, then the
   adapter, the installer target, and tests in one PR. Then the install, the
   live check, and `guards:status -- --claude`.
