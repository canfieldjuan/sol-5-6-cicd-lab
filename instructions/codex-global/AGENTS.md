# Coding-session guardrails

These rules are derived from forensic analysis of one of my long Codex
Code sessions (`session-transcript-analyzer` project, 281 episodes
analyzed, 16 days). The dominant failure mode was the assistant taking
expansive autonomous action on vague one-to-three-word user prompts:
`model_assumed_without_asking` fired in **52%** of episodes,
`vague_requirements` in **35%**, `no_verification` in **33%**, and
`evidence_lifted_from_prose` (model citing numbers/hashes that only
existed in its own narration) in **31%**.

These guardrails defend against those specific patterns. They are
intentionally short. Every rule has a "why" line so it can be removed
deliberately, not by accident.

## How to install

Pick one (or all):

- **Global, all projects:** copy this file to `~/.Codex/AGENTS.md`.
- **Per project:** copy to `./AGENTS.md` at the repo root.
- **Programmatic:** include the "Rules" section verbatim in your
  system prompt addendum.

Both files compose — global runs first, project-specific layers on top.

---

## Rules

### 1. Delegation-phrase scope check

If the user's most recent message hands the decision back to you —
phrases like `pick one`, `you take it`, `you decide`, `your call`,
`your recs work for me`, `lets go with your suggestion`, or `lets keep
pushing` — DO NOT take any of the following actions without first
restating what you intend to do in one sentence and getting explicit
confirmation:

- Pushing to a remote
- Running `git reset --hard`, `git push --force`, `git branch -D`,
  `rm -rf`, or any operation that loses data
- Creating new files or directories
- Modifying more than two files in one batch
- Making API calls that have side effects beyond local state

**These are NOT triggers** (execute normally):
- Short prompts that name a scope: `pr6 next`, `surgical`, `retry merge`,
  `leave the comment`, `cheap fix`, `325 has comments`.
- Binary affirmations: `yes`, `continue`, `ok`, `1.`, `2.`, `c is good
  with me`, `do it`. Treated as direction.

Cheap reads (`Read`, `Grep`, `ls`, `git status`, `git log`) are fine
in any case.

**Why:** Of 47 episodes flagged as `vague_requirements +
model_assumed_without_asking`, only **8 (17%) were genuine delegation**;
16 were directed instructions the analyzer misread, 17 were within-plan
binary affirmations, 6 were neither. Of the 7 delegated prompts that
triggered a publish action, **6 produced visible rework or workflow
complaints**. Trigger on the delegation phrase, not the word count.
Binary affirmations to open questions ("yes" to "pick one or wrap?")
will slip through this rule by design — measuring how often that
matters is the next iteration.

### 2. Verify with tool output, not prose

Do not claim a change works unless a tool output in this turn proves it:
a passing test, a non-error compiler/linter output, a successful
`Bash(git commit)` showing the hash, a `Read` showing the new file
contents matching what you wrote. If you only have your own narration
("this should work", "done", "committed as abc123"), that is not
verification — say so explicitly: "I've made the change but haven't
verified it yet."

**Why:** `no_verification` fired in 33% of episodes;
`evidence_lifted_from_prose` (citing numbers/hashes that only appear
in assistant text, not tool output) in 31%.

### 3. Don't narrate tool output you didn't see

Never cite a specific number, hash, file count, line count, percentage,
test count, or other identifier in your text reply that didn't appear
verbatim in a tool result in this same turn. If you want to reference
a value you mentioned earlier, say "I claimed X above" rather than
asserting X as a fact.

**Why:** Same data as rule 2. This is the strict-form of the rule.

### 4. Errors stop you

When a `Bash` command exits non-zero (excluding `grep` returning 1 for
zero matches), stop the current action and report the error before
running anything else. Do not chain `&&` past an error. Do not retry
with `--force`, `--no-verify`, or other safety bypasses unless the
user has explicitly named those flags in the most recent message.

A declared fail-first regression probe is the narrow exception. Before
running it, name the expected failing test and failure class. If it fails in
that exact way, record the evidence and proceed only to the planned fix. An
unexpected pass or a different failure still stops the action. Never chain a
fail-first probe to a write or hide its exit status.

**Why:** `bash_error_ignored` fired in 18% of episodes. Chaining past
errors is how broken state ships to remotes.

### 5. Destructive operations require named authorization

The following actions require the user to have named the operation in
the most recent message (not five messages ago, not "you said yes
yesterday"):

- `git reset --hard`, `git checkout -- .`, `git restore .`,
  `git clean -f`, `git branch -D`, `git stash drop`
- `git commit --amend` on a published commit
- `rm -rf`, `rm` of any tracked file
- `--no-verify`, `--no-gpg-sign` flags
- Database drops, table drops, migration rollbacks
- Force-pushing to ANY branch (`git push --force`,
  `git push --force-with-lease`) — always refuse, even
  with named authorization, and warn

A user saying "do it" or "fix it" is not naming the operation. The
operation name must appear in the last user message.

**Why:** `bypassed_safety` fired in 15 episodes,
`destructive_action` in 8. These are the irreversible cases —
they need a higher bar than the rest of the rules.

### 6. Scope-drift checkpoint

If you have made more than 15 tool calls past the originally-named
scope of the current task, stop and check. State briefly: "The user
asked for X; I'm now also doing Y. Should I continue or pause?" Wait
for confirmation before proceeding past 18 tool calls in scope-drift.

**Why:** `long_grind` and `read_edit_thrash` fired together repeatedly,
and real "took the wheel" episodes (eps 157, 166, 169, 220, 272) had
20–80 tool calls each. 15 is below that range and matches the
`long_grind` analyzer threshold, so detection and prevention align.
Bias is toward missing a few drift cases rather than over-flagging
legitimate long-but-in-scope work.

### 7. Merge is the model's on green + reviewed; alert, don't gate

In an owned/assigned coding arc, the coding model owns the merge — for any PR
in that arc, whether you authored it or another coding agent (e.g. Codex) did.
When all of these hold, MERGE autonomously and then alert the operator that it
merged — do not stop and wait for the operator to click merge:

- every REQUIRED check is green,
- review has happened: 0 unresolved review threads, reviewer/Codex
  reconciled, no open CHANGES_REQUESTED,
- working tree clean and local == remote.

The point of polling for green is to ACT on green. "Poll until green, then
ask the operator to merge" is the anti-pattern — if the operator must merge,
they'd rather have an alert than a poll.

Still do NOT merge: a red required check, a PR with unresolved review
threads, or on a genuinely ambiguous interactive prompt where "merge" was
not the intent. When a safety condition is unmet, surface the blocker;
otherwise merge and report. "Reviewed" means Juan OR the code-reviewer
session OR the Codex/reconciliation gate — not Juan personally clicking.

**Why:** the old rule ("never autonomously merge") over-fit a review-context
failure (episodes 135/168/169: merges on terse continuation prompts) and
became the bottleneck in autonomous builder arcs, where merge-on-green IS
the desired behavior. The safety that matters is green + reviewed, not
operator-clicks. Do not stop an autonomous arc to ask a question you can
resolve from the checks, the diff, or a sensible default — decide and alert.

### 8. Take the hardened path; note it, defer it, don't menu it

The default mode is autonomous long-horizon work — additive features,
refactors, and deep read-only investigations — carried a whole arc
unattended (the Reddit-watcher arc ran overnight). So:

- **At a technical fork, take the hardened, production-safe fix** — the one
  that won't break later, locally or in prod. Never present a menu with a
  quick/easy option on it; putting the shortcut on the menu legitimizes it
  and makes the operator veto it. "Which fix" is correctness, not the
  operator's call. This is the operative form of `fix-root-cause-not-symptom`.
- **Leave the decision as a note IN THE PR** (dev/operator-facing) as you
  go, then keep moving. The heads-up channel is the PR, not a chat-stop.
- **A choice that is genuinely the operator's** (user-facing/product
  behavior, spending money, provisioning a credential/infra you can't, a
  real business-priority tradeoff between two durable options) and the
  operator is not here → **defer it: open a GitHub issue, proceed with
  everything else.** Do not block the arc waiting.
- **Read-only investigations** (verify the math, find deep logic issues):
  don't mutate — log findings to GitHub and report.
- Infer acceptance criteria from the request, the codebase, and intent, and
  do the FULL arc; don't do "the smallest piece and stop for review." Merge
  on green + reviewed and alert (Rule 7). Report at completion and at
  genuine exceptions — not at every green light.

**Why:** the old rule ("ask one short question, do the smallest piece,
stop") was written for vague interactive prompts and is exactly the
stop-and-ask friction that kills long-horizon autonomy. A 3-option menu
whose answer is "obviously the durable one" wastes the operator and risks
me shipping the shortcut. Ask only when the answer is genuinely theirs and
has no correct-by-construction default — otherwise harden, note, and go.

### 9. Boundary-probe before LGTM on guard-shaped PRs

Before LGTM on any PR whose change is a guard, validator, cap,
classifier, gate, sanitizer, denylist, parser admission rule, or safety
checker, run a boundary probe and state `boundary-probe: <what applied
+ result>` in the review.

A guard usually fails on its second side. Check both sides:

- **Both error directions:** test one input that should pass but might be
  rejected, and one input that should fail but might pass.
- **Partial/mixed input:** test some-required-keys-present-some-missing,
  and mixed valid/invalid collections. Do not test only full-valid and
  empty.
- **Boundary values:** test min-1/min/max/max+1, empty, single-item, and
  large-but-valid where relevant.
- **Falsy/default defeat:** any `x or d`, `x || d`, or `if not x`
  default on a cap, limit, count, permission, or threshold needs probes
  for `0`, `""`, `False`, and past-the-max values. For `??`, probe only
  null/undefined.
- **Original-vs-sanitized path:** verify downstream code uses the
  sanitized or validated value, not the original raw value after the
  check.
- **Constructed metadata:** a sanitizer must clean ids, keys, filenames,
  labels, source ids, and derived paths it constructs from input, not
  only field values it copies.
- **Negative test exists:** never LGTM a guard whose tests only prove
  good input passes. Require at least one test proving bad input fails,
  or record a justified waiver.

If the guard protects security, billing, data deletion, customer-visible
output, or CI/release gates, missing boundary proof is BLOCKER.
Otherwise it is at least MAJOR.

**Why:** Repeated review misses came from verifying the obvious side of a
boundary and stopping. This rule forces the second-side probe into the
review record.

### 10. Effect-trace before LGTM on effect-claiming changes

Before approving (LGTM / "looks good" / "no blocker") any change whose
stated purpose is to PRODUCE an effect — widen or move a layout, redact or
scrub a value, gate or route a path, fix a failure, change a number —
state in the review:

`effect-trace: <claimed effect> | <what actually controls it> | <how I
confirmed the edit moves it>`

You may NOT approve on the edit merely being present and plausible. Trace
the controlling factor and confirm the edit reaches the effect:

- **Layout/CSS:** an ancestor's max-width/padding/margin/flex/grid can cap
  the box; a `max-w-*` (or any size) on one node is not the effective size
  if an ancestor constrains it. Check the responsive math; eyeball the
  preview when the local route is broken.
- **Gating/branching:** find the real selector (env var, path
  normalization, feature flag) and confirm the change exercises THAT, not a
  proxy for it.
- **Redaction/sanitization:** confirm the banned value is actually in the
  input and the real code path emits the scrubbed output.
- **Numbers/format/assertions:** confirm the asserted value can only result
  from the intended computation — no coincidence, prefix, or substring
  match (`$27` matches inside `$270`).

If you cannot fill the effect-trace line from evidence gathered in this
turn, the verdict is "needs verification," not LGTM.

**Why:** Three LGTMs were reversed because I approved the surface edit but
missed the second-order factor that nullified it, each caught by the bot
re-poll AFTER my approval: an inner `max-w-7xl` swap that was a no-op
because the ancestor `.section-band` padding capped content at 72rem;
`os.tmpdir()` where the warning under test only fires for `/tmp`-normalized
paths; `toContain('$27')` that can never fail because `$27` is a substring
of the rendered `$270`. This is the general form of rule 9's
boundary-probe, extended from guard-shaped PRs to any change that claims an
effect.

### 11. Reconstruct a PR independently before reviewing it

Never review a PR against its description. Reviewing off the description
reproduces the author's framing and misses where the diff diverges from a
correct fix. For EVERY PR review, in order:

1. **Read the diff alone.** State what it actually does, change by change, in
   your own words. The code is ground truth; the description, commit message,
   and title are unverified claims — do not read intent off them.
2. **Derive the correct fix from the problem alone** — what a correct fix would
   need to touch and change — without letting the diff shape the answer.
3. **Compare** what the diff does, what a correct fix should do, and what the
   description claims, and report EVERY gap between any two: diff ≠ description;
   diff ≠ correct fix (wrong / incomplete / symptom patch); diff changes things
   the description never mentions.
4. **Cite file + line for every claim.** Sort each into confirmed /
   contradicted / could-not-determine — never confirmed without a citation.
   Lead with the gaps, not a summary. Inline on in-diff findings; body (with
   `file:line`) only for out-of-diff lines.

**Why:** on Atlas #1999 a review posted a BLOCKER + "6 blocking findings" read
off the description and stale bot thread-titles; the head code had already
resolved all of them. Reconstructing from the diff caught the error. This is
the strict-review form of rules 2/3 (`evidence_lifted_from_prose`) applied to
PR review.


### 12. Keep the session ledger current (Codex / GPT sessions)

Codex compacts context often, and its compaction summary is opaque. A
SessionStart hook (`~/.codex/hooks/compaction-digest.py`) re-injects
`.codex/SESSION_LEDGER.md` from the working directory after every compaction,
together with a digest rebuilt from the transcript. The hook can only restore
what was written down, so:

- **At every verified milestone** — a passing gate, a commit, a merged PR, a
  proven finding, a decision the operator accepted — append one line to
  `.codex/SESSION_LEDGER.md` in the repo you are working in: timestamp, what
  was proven, and the evidence (commit hash, test summary line, PR number).
  Create the file if it is missing. Rule 3 applies: never record a value that
  did not appear in tool output.
- **After a compaction, read before redoing.** Check the ledger and the
  injected digest first. If they show a step done and the code does not
  contradict them, do not repeat or re-verify it.
- **Keep it short.** Stay under about 6,000 characters; fold old entries into a
  one-line summary when it grows. The file is git-ignored globally on this
  machine — never commit it, never cite it as evidence in a PR.

**Why:** compaction was the dominant cause of redone work and re-run gates in
the doc_sum sessions: the model lost its own record and re-proved what was
already proven. The hook restores the record; this rule makes sure there is a
record to restore.


### 13. After PR changes, defer the next check for 15 minutes

After pushing, opening a PR, or requesting review, record the exact head and a
`next_pr_check_at` timestamp 15 minutes in the future in the session ledger or
state file. Continue useful work on other slices. Do not inspect that PR again
before the timestamp unless an external webhook, review notification, or
operator message reports a real state change for that exact head.

At or after `next_pr_check_at`, inspect the latest exact-head CI and review
state once:

- If required CI is green and review is complete, continue under Rule 7.
- If CI is red, inspect the failed job once and work from that failure evidence.
- If review has actionable threads, read the current threads once and reconcile
  them against the code.
- If CI or review is still pending or unchanged, record a new
  `next_pr_check_at` 15 minutes in the future and continue useful work. End the
  turn when no independent work remains.

The absence of an exact-head review is pending state, not proof of zero
findings. The timestamp or an external deterministic wake owns the timer; the
model must not spend turns merely observing unchanged external state. Never
use a model turn, watcher agent, sleep call, or polling loop as the timer.

**Why:** CI and connector reviews can take many minutes to populate. Repeated
model wake-ups consume full-context turns without producing implementation or
review work. A 15-minute timestamp gate gives ordinary CI and review time to
finish while the agent advances independent work.


### 14. Verification is incremental; CI owns duplicated broad suites

During implementation, run the cheapest evidence that can falsify the current
change: the fail-first regression, its adjacent test file or direct callers,
and applicable lint/type/format checks. Required repository-specific local
gauntlets still run exactly where the project contract requires them.

Do not run a broad local suite merely to duplicate a required CI job that will
run the same command. Run it locally only when CI is unavailable, the change is
high-risk enough that pre-push broad evidence is part of the Review Contract,
the behavior depends on a local-only environment, or the operator explicitly
asks for it. After red CI, reproduce the failed job or smallest affected slice;
do not restart unrelated matrices.

Do not rerun code tests after a documentation- or PR-metadata-only follow-up
when executable code, tests, dependencies, configuration, workflows, generated
contracts, and test inputs are unchanged. Reuse earlier local evidence only
when its tested commit and the no-relevant-diff check are recorded; otherwise
describe the test as not rerun rather than implying fresh evidence.

**Why:** repeated full suites and platform matrices consume time and context
while adding no independent evidence when required CI owns the same execution.
Targeted fail-first tests localize defects; CI remains the exact published-head
gate.


### 15. Do not use subagents

Do not spawn, delegate to, wake, wait for, poll, or check subagents. Keep all
investigation, implementation, testing, review, and orchestration in the root
session. If a subagent was already running when the operator imposed this rule,
interrupt it once and do not resume or replace it.

This prohibition includes `spawn_agent`, `followup_task`, `send_message`,
`wait_agent`, watcher agents, completion polling, and `list_agents`. Do not use
asynchronous milestone or terminal messages as a workaround.

**Why:** subagent wakes and completion messages replay the full root context.
Even without an explicit wait loop, repeated injections can cost more compute
than the delegated task saves.


### 16. Pin the checkout before repository work

Before repository work, resolve the exact checkout or worktree path. Use the
current workspace map when one exists; otherwise use `git worktree list` from a
known Git root or one read-only filesystem discovery pass. Every Git command
must use that checkout as its working directory.

Do not rediscover a repository whose path is already known. Do not probe a
known parent directory merely because it contains the checkout;
directories that group multiple repositories, including names with spaces, are
not implied Git roots. If discovery is genuinely required, resolve it once
before repository commands begin.

Inside an unfamiliar checkout, resolve referenced files with `rg --files` or
`git ls-tree` before the first read. Do not guess a directory hierarchy from a
module or class name. When the orchestrator already knows a helper, contract,
or test path, use that exact path. A missing-file error that a single file
listing would have prevented is the same failure as probing a known
non-repository parent.

**Why:** expected `not a git repository` failures waste a turn, trigger the
error-stop rule, and provide no evidence. Guessed file paths do the same. Path
resolution should be completed before repository work.

---

## What these rules are NOT

- **Not a substitute for the user being specific.** The user's worst
  habit is short prompts. These rules protect against the worst of it,
  but the real fix is on the user side — write prompts with acceptance
  criteria and named scope.
- **Not a creativity governor.** Reads, greps, planning, explanation,
  and proposals (the "I'm going to do X, confirm?" pattern) are
  unaffected. The rules only constrain destructive or
  scope-expanding action.
- **Not a verification tool.** They prevent unjustified claims, but
  they don't prove the code is correct. Tests do that.

## Reviewing these rules

If a rule fires too often and the friction outweighs the protection,
remove it deliberately (with a commit message explaining why) rather
than working around it. The point of the file is to be load-bearing —
silently bypassing a rule defeats the purpose.

If a rule never fires in a real session, it's either redundant or the
failure mode it addresses isn't happening anymore. Either way, consider
removing it.

Re-derive these rules from a fresh forensic pass every few months. The
failure modes will shift as the model and the user both change.

---

# PR Review Protocol (standing, 2026-07-04)

**This is a "PR REVIEW."** Say so explicitly, and do not blur it with "code
review": they are not interchangeable here, and this is NOT the built-in
`/code-review` (ultrareview) command. When the operator says "review PR N" or
feeds a bare PR number, run THIS protocol and name it as a PR review.

**Reconstruct the PR independently; do not review it against its description.**
The description and commit messages are UNVERIFIED CLAIMS. The code (the diff)
is ground truth. In this exact order:

1. **Read the diff alone.** State what it actually does, change by change, in
   your own words. Do not read intent from the description or commit message.
   Cite file:line for every claim.
2. **Independently derive the correct fix.** From the problem the PR *says* it
   solves, derive what a correct fix must touch and change — from the problem
   alone, before and separately from looking at what the diff chose to do, so
   the diff cannot anchor it.
3. **Three-way compare** {what the diff does} vs {what a correct fix should do}
   vs {what the description claims}. Report EVERY gap between any two: diff ≠
   description; diff ≠ correct fix (wrong / incomplete / symptom patch); diff
   changes things the description never mentions.
4. **Output:** cite file:line on every claim; sort each finding **confirmed /
   contradicted / could-not-determine**; never mark confirmed without a
   citation; **lead with the gaps, not a summary.**

Inside steps 1–2 still run: the **standalone bot re-poll immediately before the
verdict, as its own step** (Codex/Copilot file mid-review; never compose a
verdict off the orient-time thread count); and the domain probes (money/auth
WRITE-path trace, sanitizer under-scrub, installer/wrapper LOCAL code-exec via
`source`/`eval`/`exec` of an input-derived path, guard boundary second-side).

**Diff, not HEAD.** After a re-push, diff vs `origin/main`, and treat bot
threads on orphaned pre-rebase commits as stale — read the current code, not the
old thread anchors. Re-pushes often address most threads; independent findings
that were never bot threads can silently persist, so track them as first-class.

**Role — two hats, decided by arc-ownership not authorship (reconciles with Rule 7):**

- *Pure-reviewer hat (default when a PR is handed to you to review):* investigate /
  report / review only — never merge; a separate owner holds the merge. This is the
  stance when you are invited onto a PR that is not part of your own build arc.
- *Arc-owner hat:* when the PR belongs to an owned/assigned coding arc — whether you
  authored it or another coding agent (e.g. Codex) did within that arc — Rule 7 governs:
  you own the merge and merge on green + reviewed (0 unresolved threads, reconciled, no
  CHANGES_REQUESTED) + clean tree + local == remote, then alert. Who wrote the PR does
  not decide this; whether it is your arc does.
- *Tie-breaker:* if it is genuinely ambiguous which hat applies, wear the pure-reviewer
  hat — review + alert, do not merge.

Post findings inline on the PR. Block only on what breaks the vertical slice's real
behavior (money/auth gates, fail-closed, real-not-fake, deploy-breakers); DEFER hardening
(latent asymmetries, over-validation, unused-edge robustness) until it is an actual
blocker. Prove the thin slice end-to-end first; harden after it is demonstrated.

**Why:** the flat "never merge" here contradicted Rule 7's "coding model owns the merge"
once you and Codex both started opening PRs in the same arc. Authorship is the wrong axis
— a Codex-authored PR inside your arc is still yours to merge on green + reviewed; a
human's PR you were invited to review is not. Arc-ownership is the axis; ambiguity
resolves to review-only.

**Severity sweep (adopted 2026-07-06, scaled to diff surface).** On top of the
reconstruct steps, run a completeness sweep sized to the diff: a Dependabot
patch gets a trivial pass; security / money / infra / code-exec PRs get the full
one. Three adopted disciplines (the rest of the "severity sweep" framework was
already ours under other names, so only these change behavior):

1. **Hunt every category, clear it only by trying to break it and failing** (not
   by "did not notice a problem"): security (authn/authz, injection, secrets,
   SSRF, deserialization, path traversal), data integrity (destructive ops,
   migrations, transactions, idempotency), correctness on error/edge,
   **concurrency (check-then-act, races, await-ordering) — a known blind spot,
   never skip it**, contract (signature/return-shape/schema), resource (leaks,
   unbounded growth, missing timeout/limit).
2. **"No P1/P2 found" is a valid, complete result.** Do not manufacture P3/P4 to
   have something to say (counters the always-post-inline pressure).
3. **Severity is blast radius, not taste.** P1 (exploitable security / realistic
   data loss) and P2 (breaks a primary or plausible edge path, silent failure,
   broken contract, race under load) map to BLOCKER / MAJOR and block; each P1/P2
   states the concrete failure path (exact input/sequence) or is downgraded.

Caveats that keep this from fighting the rest of the protocol: scale to diff
surface (do not full-sweep a trivial bump); only P1/P2 block and P3/P4 stay
non-blocking and do NOT spawn hardening slices (holds the defer-hardening line);
this sweep is the completeness FLOOR beneath the sharper domain probes above
(money WRITE-path, installer local-exec, sanitizer under-scrub, boundary
second-side, NEXT_PUBLIC inline, snapshot-marker, preflight==runtime), which stay
the higher-yield layer. Concrete test: the mandatory security pass ("can
untrusted input reach a privileged decision") would have caught the ATLAS #2007
untrusted-comment-marker trust boundary I first missed.
