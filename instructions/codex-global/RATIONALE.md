# Coding-session guardrails: rationale

Human-facing companion to `instructions/candidate/codex-global/AGENTS.md`.
It is not installed and not injected into Codex. It holds, verbatim from the
baseline (sha256 `b428ff1cda416596...`), the provenance intro, the maintenance
notes, and every rule's **Why:** paragraph, so a rule can still be removed
deliberately with its reason in view.

## Coding-session guardrails

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

## G1: 1. Delegation-phrase scope check

**Why:** Of 47 episodes flagged as `vague_requirements +
model_assumed_without_asking`, only **8 (17%) were genuine delegation**;
16 were directed instructions the analyzer misread, 17 were within-plan
binary affirmations, 6 were neither. Of the 7 delegated prompts that
triggered a publish action, **6 produced visible rework or workflow
complaints**. Trigger on the delegation phrase, not the word count.
Binary affirmations to open questions ("yes" to "pick one or wrap?")
will slip through this rule by design — measuring how often that
matters is the next iteration.

## G2: 2. Verify with tool output, not prose

**Why:** `no_verification` fired in 33% of episodes;
`evidence_lifted_from_prose` (citing numbers/hashes that only appear
in assistant text, not tool output) in 31%.

## G3: 3. Don't narrate tool output you didn't see

**Why:** Same data as rule 2. This is the strict-form of the rule.

## G4: 4. Errors stop you

**Why:** `bash_error_ignored` fired in 18% of episodes. Chaining past
errors is how broken state ships to remotes.

## G5: 5. Destructive operations require named authorization

**Why:** `bypassed_safety` fired in 15 episodes,
`destructive_action` in 8. These are the irreversible cases —
they need a higher bar than the rest of the rules.

## G6: 6. Scope-drift checkpoint

**Why:** `long_grind` and `read_edit_thrash` fired together repeatedly,
and real "took the wheel" episodes (eps 157, 166, 169, 220, 272) had
20–80 tool calls each. 15 is below that range and matches the
`long_grind` analyzer threshold, so detection and prevention align.
Bias is toward missing a few drift cases rather than over-flagging
legitimate long-but-in-scope work.

## G7: 7. Merge is the model's on green + reviewed; alert, don't gate

**Why:** the old rule ("never autonomously merge") over-fit a review-context
failure (episodes 135/168/169: merges on terse continuation prompts) and
became the bottleneck in autonomous builder arcs, where merge-on-green IS
the desired behavior. The safety that matters is green + reviewed, not
operator-clicks. Do not stop an autonomous arc to ask a question you can
resolve from the checks, the diff, or a sensible default — decide and alert.

## G8: 8. Take the hardened path; note it, defer it, don't menu it

**Why:** the old rule ("ask one short question, do the smallest piece,
stop") was written for vague interactive prompts and is exactly the
stop-and-ask friction that kills long-horizon autonomy. A 3-option menu
whose answer is "obviously the durable one" wastes the operator and risks
me shipping the shortcut. Ask only when the answer is genuinely theirs and
has no correct-by-construction default — otherwise harden, note, and go.

## G9: 9. Boundary-probe before LGTM on guard-shaped PRs

**Why:** Repeated review misses came from verifying the obvious side of a
boundary and stopping. This rule forces the second-side probe into the
review record.

## G10: 10. Effect-trace before LGTM on effect-claiming changes

**Why:** Three LGTMs were reversed because I approved the surface edit but
missed the second-order factor that nullified it, each caught by the bot
re-poll AFTER my approval: an inner `max-w-7xl` swap that was a no-op
because the ancestor `.section-band` padding capped content at 72rem;
`os.tmpdir()` where the warning under test only fires for `/tmp`-normalized
paths; `toContain('$27')` that can never fail because `$27` is a substring
of the rendered `$270`. This is the general form of rule 9's
boundary-probe, extended from guard-shaped PRs to any change that claims an
effect.

## G11: 11. Reconstruct a PR independently before reviewing it

**Why:** on Atlas #1999 a review posted a BLOCKER + "6 blocking findings" read
off the description and stale bot thread-titles; the head code had already
resolved all of them. Reconstructing from the diff caught the error. This is
the strict-review form of rules 2/3 (`evidence_lifted_from_prose`) applied to
PR review.

## G12: 12. Keep the session ledger current (Codex / GPT sessions)

**Why:** compaction was the dominant cause of redone work and re-run gates in
the doc_sum sessions: the model lost its own record and re-proved what was
already proven. The hook restores the record; this rule makes sure there is a
record to restore.

## G13: 13. After PR changes, defer the next check for 15 minutes

**Why:** CI and connector reviews can take many minutes to populate. Repeated
model wake-ups consume full-context turns without producing implementation or
review work. A 15-minute timestamp gate gives ordinary CI and review time to
finish while the agent advances independent work.

## G14: 14. Verification is incremental; CI owns duplicated broad suites

**Why:** repeated full suites and platform matrices consume time and context
while adding no independent evidence when required CI owns the same execution.
Targeted fail-first tests localize defects; CI remains the exact published-head
gate.

## G15: 15. Do not use subagents

**Why:** subagent wakes and completion messages replay the full root context.
Even without an explicit wait loop, repeated injections can cost more compute
than the delegated task saves.

## G16: 16. Pin the checkout before repository work

**Why:** expected `not a git repository` failures waste a turn, trigger the
error-stop rule, and provide no evidence. Guessed file paths do the same. Path
resolution should be completed before repository work.

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

## G-PRP: PR Review Protocol (standing, 2026-07-04)

**Why:** the flat "never merge" here contradicted Rule 7's "coding model owns the merge"
once you and Codex both started opening PRs in the same arc. Authorship is the wrong axis
— a Codex-authored PR inside your arc is still yours to merge on green + reviewed; a
human's PR you were invited to review is not. Arc-ownership is the axis; ambiguity
resolves to review-only.
