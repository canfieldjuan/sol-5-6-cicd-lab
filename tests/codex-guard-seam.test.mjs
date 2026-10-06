import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { directoryOf } from "../hooks/codex-guards/stop/round-guard.mjs";
import { decide, main, runStopGates } from "../hooks/codex-guards/guard.mjs";
import { branchText, createdBranches, emptySeam, findingLocations, followupText, learnedOwnership, prCreate, PUSH_ESCALATION, pushText, quoteArg, reviewReads, reviewText, safePath, seamAfter, seamBefore } from "../hooks/codex-guards/guards/seam.mjs";
import { segments, withoutHeredocs } from "../hooks/codex-guards/lib/shell.mjs";
import { R } from "./codex-rollout-rows.mjs";

// Contract 5.4 (revisions 18-19): seam redirects R1-R3.

const pre = (command, state = {}, extra = {}) => decide({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: "/r", tool_input: { command }, ...extra }, { pending: [], ...state }, { guards: [] });
const post = (command, state = {}, response = "") => decide({ hook_event_name: "PostToolUse", tool_name: "Bash", cwd: "/r", tool_input: { command }, tool_response: response }, { pending: [], ...state }, { guards: [] });
const context = (result) => result.output?.hookSpecificOutput?.additionalContext ?? null;
const kinds = (result) => (result.log ?? []).filter((entry) => entry.code === "seam-redirect").map((entry) => entry.kind);
// A session that pushed to the test repositories, for tests about something
// other than own work (contract 5.4 revision 22).
const OWN = { seam: { ...emptySeam(), ownRepos: ["o/r", "o/a", "o/b"] } };
// Runs events in order, threading state; returns every result.
function run(events, state = {}) {
  const results = [];
  let current = { pending: [], ...state };
  for (const [event, command, response] of events) {
    const result = event === "pre" ? pre(command, current) : post(command, current, response ?? "reviewer: this still breaks");
    current = result.state;
    results.push(result);
  }
  return results;
}

test("withoutHeredocs: removes bare, quoted, and <<- bodies; keeps text after the terminator", () => {
  assert.equal(withoutHeredocs("python - <<'PY'\nprint('git push origin x')\nPY\ngh pr view 1 --comments"), "python - \ngh pr view 1 --comments");
  assert.equal(withoutHeredocs('cat > f <<"EOF"\nbody\nEOF\necho done'), "cat > f \necho done");
  assert.equal(withoutHeredocs("cat <<-END\n\tbody\n\tEND\nls"), "cat \nls", "<<- allows leading tabs on the terminator");
  assert.equal(withoutHeredocs("cat <<END\n  END\nstill body"), "cat ", "without -, an indented word is not the terminator; unterminated runs to the end");
  assert.equal(withoutHeredocs("cat <<A <<B\na\nA\nb\nB\nls"), "cat  \nls", "two heredocs on one line, bodies in order");
  assert.ok(segments(withoutHeredocs("set -e\npython - <<'PY'\nx = '$HOME'\nPY\ngh pr create --base b")), "the body's variables no longer make the command unreadable");
});

test("withoutHeredocs near misses: << in quotes, here-strings, and arithmetic are left alone", () => {
  for (const command of ['echo "a <<EOF"\nnext', "grep x <<<\"$v\"\nnext", "echo $((1<<2))\nnext", "ls\nnext"]) {
    assert.equal(withoutHeredocs(command), command, command);
  }
});

test("R1 trips on every review-read form, keyed by the stated repository, else the directory", () => {
  const cases = [
    ["gh pr view 12 --comments", ["dir:/r#12"]],
    ["gh pr view 12 -c", ["dir:/r#12"]],
    ["gh pr view --comments", ["dir:/r#current"]],
    ["gh pr view https://github.com/O/R/pull/34 --json reviews,state", ["o/r#34"]],
    ["gh pr view 12 --repo o/r --json=latestReviews", ["o/r#12"]],
    ["gh pr view 12 -R o/r --json title,comments --jq '.comments[]'", ["o/r#12"]],
    ["gh api repos/o/r/pulls/12/comments --paginate", ["o/r#12"]],
    ["gh api repos/o/r/pulls/12/reviews/99", ["o/r#12"]],
    ["gh api /repos/o/r/issues/12/comments?per_page=100", ["o/r#12"]],
    ["gh api -X GET repos/o/r/pulls/12/comments -f per_page=100", ["o/r#12"]],
    ["gh api graphql -f query='query { repository(owner:\"o\",name:\"r\") { a:pullRequest(number:116) { reviewThreads(first:9) { nodes { id } } } b:pullRequest(number: 118) { reviews(last:3) { nodes { state } } } } }'", ["o/r#116", "o/r#118"]],
    ["gh api graphql -f query='query { a:repository(owner:\"o\",name:\"a\") { pullRequest(number:5) { comments(last:1) { nodes { body } } } } b:repository(owner:\"o\",name:\"b\") { pullRequest(number:5) { reviewThreads(first:1) { nodes { id } } } } }'", ["o/a#5", "o/b#5"]],
    ["codex-pr-status --repo o/r --pr 12", ["o/r#12"]],
    ["cd /x && GH_PAGER=cat gh pr view 12 --comments", ["dir:/x#12"]],
    ["set -e\npython - <<'PY'\nopen('ledger','a').write('x')\nPY\ngh pr view 12 --comments", ["dir:/r#12"]]
  ];
  for (const [command, keys] of cases) assert.deepEqual(reviewReads(command, "/r").map((ref) => ref.key), keys, command);
  assert.deepEqual(reviewReads("gh pr view 12 --comments", "/r").map((ref) => ref.label), ["PR #12"]);
});

test("R1 near misses: non-review reads, quoted mentions, heredoc bodies, and every write form", () => {
  for (const command of [
    "gh pr view 12 --json state,headRefOid",
    "gh pr checks 12",
    "gh pr list",
    'echo "gh pr view 12 --comments"',
    "cat > s.sh <<'EOF'\ngh pr view 12 --comments\nEOF",
    "gh api repos/o/r/pulls/12/comments/55/replies -f body=done",
    "gh api repos/o/r/pulls/12/comments/55/replies --input reply.json",
    "gh api repos/o/r/issues/12/comments -f body=hello",
    "gh api -X POST repos/o/r/pulls/12/reviews",
    "gh api --method PATCH repos/o/r/pulls/comments/55",
    "gh api graphql -f query='mutation { resolveReviewThread(input:{threadId:\"T\"}) { thread { isResolved } } }'",
    "gh api graphql -f query='query { repository(owner:\"o\",name:\"r\") { pullRequest(number:12) { state headRefOid } } }'",
    "gh api repos/o/r/pulls/12"
  ]) assert.deepEqual(reviewReads(command, "/r"), [], command);
});

test("R1 needs review text: a status check with no body and an empty output do not fire or use up the epoch", () => {
  const status = JSON.stringify({ reviewDecision: "APPROVED", reviews: [{ state: "APPROVED", body: "" }], statusCheckRollup: [] });
  const withBody = JSON.stringify({ reviews: [{ state: "CHANGES_REQUESTED", body: "Zero must be rejected." }] });
  const [quiet, empty, real] = run([
    ["post", "gh pr view 12 --json reviewDecision,reviews,statusCheckRollup", status],
    ["post", "gh pr view 12 --comments", ""],
    ["post", "gh pr view 12 --json reviews", withBody]
  ]);
  assert.equal(context(quiet), null);
  assert.equal(context(empty), null);
  assert.match(context(real), /Review feedback on PR #12\./, "the same epoch still fires once review text arrives");
  assert.doesNotMatch(context(real), /Review round/);
});

test("repository namespacing: branches by directory, PRs by stated repository", () => {
  const pushes = run([["pre", "cd /a && git push origin feature"], ["pre", "cd /b && git push origin feature"]]);
  assert.equal(context(pushes[1]), null, "the first push of feature in /b is not push 2");
  const prs = run([["post", "gh pr view 12 --repo o/a --comments"], ["post", "gh pr view 12 --repo o/b --comments"], ["pre", "git push origin x"], ["post", "gh pr view 12 --repo o/b --comments"]], OWN);
  assert.match(context(prs[1]), /Review feedback on PR #12\./, "PR 12 in another repository is its own key");
  assert.match(context(prs[3]), /Review round 2 on PR #12/);
  assert.equal(prs[3].state.seam.rounds["o/a#12"], 1, "o/a#12 was not escalated by o/b's rounds");
  const stack = run([["pre", "cd /a && git push origin feature"], ["pre", "cd /b && gh pr create --base feature --title 'Step 2'"]]);
  assert.equal(context(stack[1]), null, "--base feature in /b is not /a's own work");
  for (const base of ["main", "master"]) {
    const trunk = run([["pre", `git push origin ${base}`], ["pre", `gh pr create --base ${base} --title 'Feature'`]]);
    assert.equal(context(trunk[1]), null, `--base ${base} is never stacked`);
    assert.deepEqual(trunk[1].state.seam.own, []);
  }
});

test("R1 fires once per PR per push epoch, again after a push with the review-round-2 line, and names each fresh PR", () => {
  const [first, again, , second, multi] = run([
    ["post", "gh pr view 12 --repo o/r --comments"],
    ["post", "gh api repos/o/r/pulls/12/comments"],
    ["pre", "git push origin fix"],
    ["post", "gh pr view 12 -R o/r --comments"],
    ["post", "gh api graphql -f query='query { repository(owner:\"o\",name:\"r\") { a:pullRequest(number:12) { comments(last:1) { nodes { body } } } b:pullRequest(number:13) { reviewThreads(first:1) { nodes { id } } } } }'"]
  ], OWN);
  assert.match(context(first), /^\[seam-redirect\] Review feedback on PR #12\./);
  assert.doesNotMatch(context(first), /Review round/);
  assert.deepEqual(kinds(first), ["review"]);
  assert.equal(context(again), null, "same PR, same epoch: no second redirect");
  assert.match(context(second), /Review round 2 on PR #12: findings that keep arriving in one class/);
  assert.match(context(multi), /Review feedback on PR #13\./, "PR 12 is already stamped in this epoch; 13 is fresh");
  assert.equal(second.state.seam.rounds["o/r#12"], 2);
  const mixed = run([["post", "gh pr view 12 --comments"], ["post", "gh api repos/o/r/pulls/12/comments"]], OWN);
  assert.ok(context(mixed[1]), "a directory-scoped and a repository-scoped read are different keys (contract 5.4: no stated repository, no match)");
});

test("epochs are per directory scope: a push in another repository starts no round here (revision 19)", () => {
  // The session directory is /r: its reads are own work before any push there (revision 22).
  const [first, , reread, , again] = run([
    ["post", "gh pr view 12 --comments"],
    ["pre", "cd /b && git push origin feature"],
    ["post", "gh pr view 12 --comments"],
    ["pre", "git push origin fix"],
    ["post", "gh pr view 12 --comments"]
  ]);
  assert.ok(context(first));
  assert.equal(context(reread), null, "a push in /b is not a new round for /r's PR");
  assert.match(context(again), /Review round 2 on PR #12/, "a push in /r is");
  assert.deepEqual(again.state.seam.epochs, { "/b": 1, "/r": 1 });
  // /a's R1 sends its review-round line in /a's epoch 2; /b's third push is in
  // /b's epoch 2, so an unscoped marker would drop /b's escalation line.
  const scoped = run([
    ["pre", "cd /a && git push origin fix"], ["post", "cd /a && gh pr view 12 --comments"],
    ["pre", "cd /a && git push origin fix"], ["post", "cd /a && gh pr view 12 --comments"],
    ["pre", "cd /b && git push origin feature"], ["pre", "cd /b && git push origin feature"], ["pre", "cd /b && git push origin feature"]
  ]);
  assert.match(context(scoped[3]), /Review round 2 on PR #12/);
  assert.deepEqual(scoped[3].state.seam.escalated, { "/a": 2 });
  assert.equal(context(scoped.at(-1)), pushText(3, "`feature`", true), "an R1 review-round line in /a does not drop R2's escalation line in /b");
  const repoScoped = run([["post", "gh pr view 12 --repo o/r --comments"], ["post", "cd /x && gh pr view 12 --repo o/r --comments"]], OWN);
  assert.ok(context(repoScoped[1]), "a stamp records its scope: one key read from two scopes does not share an epoch");
});

test("ownership comes only from creating forms: a reset of a shared branch makes no later branch stacked (revision 19)", () => {
  for (const reset of ["git checkout -B develop origin/develop", "git switch -C develop", "git switch --force-create develop", "git worktree add -B develop ../wt"]) {
    const [, fix, stack] = run([["pre", reset], ["pre", "git checkout -b fix develop"], ["pre", "gh pr create --base develop --title 'Step'"]]);
    assert.equal(context(fix), null, reset);
    assert.equal(context(stack), null, reset);
    assert.deepEqual(stack.state.seam.own, ["/r|fix"], reset);
  }
});

test("R1 fills concrete trace commands from REST and GraphQL review output, else the generic form", () => {
  const rest = JSON.stringify([{ id: 1, path: "src/a.py", user: { login: "bot" }, body: "x {y}", line: 12 }, { id: 2, path: "src/b.py", line: null, original_line: 40 }]);
  assert.deepEqual(findingLocations(rest), [{ path: "src/a.py", line: 12 }, { path: "src/b.py", line: 40 }]);
  const graphql = JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ comments: { nodes: [{ path: "lib/x y.ts", line: 7, body: "}" }] } }] } } } } });
  assert.deepEqual(findingLocations(graphql), [{ path: "lib/x y.ts", line: 7 }]);
  const jqLines = ['{"path":"a.js","line":1}', '{"path":"b.js","line":2}', '{"path":"c.js","line":3}', '{"path":"d.js","line":4}'].join("\n");
  assert.equal(findingLocations(jqLines).length, 3, "at most 3");
  assert.deepEqual(findingLocations("reviewer: src/a.py:12 still breaks"), [], "plain text gives no locations");
  const [filled] = run([["post", "gh api repos/o/r/pulls/9/comments", rest]], OWN);
  assert.match(context(filled), /git log -L 12,12:src\/a\.py; git log -L 40,40:src\/b\.py/);
  const [generic] = run([["post", "gh pr view 9 --comments", "reviewer: it breaks"]]);
  assert.match(context(generic), /git blame -L <line>,<line> <path> for each finding/);
  assert.match(reviewText(["PR #9"], 1, "PR #9", [{ path: "lib/x y.ts", line: 7 }]), /git log -L 7,7:'lib\/x y\.ts'/, "paths with spaces are quoted");
});

test("review-derived paths are quoted or dropped: the malicious-path fixture", () => {
  const evil = [
    { path: "a;rm -rf ~.py", line: 3 },
    { path: "$(curl x).py", line: 4 },
    { path: "`id`.py", line: 5 },
    { path: "it's.py", line: 6 },
    { path: "two\nlines.py", line: 7 },
    { path: "-rf", line: 8 },
    { path: "back\\slash.py", line: 9 },
    { path: "x".repeat(201), line: 10 },
    { path: "ok.py", line: 0 }
  ];
  const locations = findingLocations(JSON.stringify(evil), 20);
  assert.deepEqual(locations.map((l) => l.path), ["a;rm -rf ~.py", "$(curl x).py", "`id`.py", "it's.py"], "newline, leading -, backslash, overlong, and line 0 are dropped");
  const text = reviewText(["PR #1"], 1, "PR #1", locations.slice(0, 3));
  assert.match(text, /git log -L 3,3:'a;rm -rf ~\.py'; git log -L 4,4:'\$\(curl x\)\.py'; git log -L 5,5:'`id`\.py'/);
  assert.equal(quoteArg("it's.py"), "'it'\\''s.py'");
  assert.equal(quoteArg("src/a-b_c.py"), "src/a-b_c.py", "plain paths stay bare");
  for (const bad of ["", "-x", "a\tb", "a\u007fb", "a\\b"]) assert.equal(safePath(bad), false, JSON.stringify(bad));
  const [onlyBad] = run([["post", "gh api repos/o/r/pulls/2/comments", JSON.stringify([{ path: "-oops", line: 1, body: "x" }])]], OWN);
  assert.match(context(onlyBad), /git blame -L <line>,<line> <path> for each finding/, "every path dropped: the generic form");
});

test("own branches come from named pushes, PR heads, and branch-creating commands; HEAD pushes and main never count", () => {
  assert.deepEqual(createdBranches("git checkout -b feat-a && git switch -c feat-b dev; git -C /r worktree add -b feat-c ../wt main"), [{ name: "feat-a", dir: null, start: null }, { name: "feat-b", dir: null, start: "dev" }, { name: "feat-c", dir: "/r", start: "main" }]);
  assert.deepEqual(createdBranches("git checkout main && git switch dev && git worktree add ../wt existing"), []);
  assert.deepEqual(createdBranches("git switch --create feat-d dev"), [{ name: "feat-d", dir: null, start: "dev" }]);
  // Reset forms can reset an existing branch, so they prove nothing (revision 19).
  assert.deepEqual(createdBranches("git checkout -B develop origin/develop; git switch -C develop; git switch --force-create develop; git worktree add -B develop ../wt"), []);
  const stackedOn = (setup) => context(run([...setup.map((command) => ["pre", command]), ["pre", "gh pr create --base feat-a --title 'Step 2'"]]).at(-1));
  assert.equal(stackedOn(["git push origin feat-a"]), null, "a named push alone is not ownership");
  assert.equal(stackedOn(["git push origin develop", "git push origin feat-a"]), null);
  assert.equal(context(run([["pre", "git push origin develop"], ["pre", "gh pr create --base develop --title 'Feature'"]]).at(-1)), null, "a shared default such as develop");
  assert.ok(stackedOn(["gh pr create --head feat-a --base main --title 'Step 1'"]), "the head of an earlier PR");
  assert.ok(stackedOn(["git checkout -b feat-a", "git push -u origin HEAD"]), "a created branch pushed as HEAD");
  assert.ok(stackedOn(["git switch -c feat-a"]), "switch -c");
  assert.ok(stackedOn(["git worktree add -b feat-a ../wt"]), "worktree add -b");
  const headOnly = run([["pre", "git push origin HEAD"], ["pre", "git push"], ["pre", "gh pr create --base main --title 'Step 2'"]]);
  assert.equal(context(headOnly.at(-1)), null, "--base main after only HEAD and bare pushes");
  assert.deepEqual(headOnly.at(-1).state.seam.own, []);
});

test("R2 fires on every re-push, with the escalation line from the third push", () => {
  const [p1, p2, p3, other] = run([["pre", "git push -u origin fix"], ["pre", "git push origin fix"], ["pre", "git push origin fix"], ["pre", "git push origin other"]]);
  assert.equal(context(p1), null, "first push: no redirect");
  assert.equal(context(p2), pushText(2, "`fix`"));
  assert.match(context(p2), /^\[seam-redirect\] Push 2 to `fix` sends fix round 1 on your own change\. Read the diff it sends before the next review does:\n- If the fix restates a rule in a second place/);
  assert.equal(context(p3), pushText(3, "`fix`", true));
  assert.ok(context(p3).endsWith(`\n${PUSH_ESCALATION}`));
  assert.deepEqual(kinds(p3), ["push"]);
  assert.equal(context(other), null, "a first push to a different subject");
  assert.deepEqual(p3.state.seam.epochs, { "/r": 3 }, "epochs are per directory scope");
});

test("R2 near misses: text that mentions a push", () => {
  const ledger = run([["pre", "git push origin fix"], ["pre", "printf '%s' 'fixed; git push origin fix' >> .codex/SESSION_LEDGER.md"], ["pre", 'echo "git push origin fix"'], ["pre", "cat > ship.sh <<'EOF'\ngit push origin fix\nEOF"]]);
  assert.deepEqual(ledger.map(context), [null, null, null, null]);
  assert.equal(ledger.at(-1).state.seam.pushes["/r|fix"], 1);
});

test("R2 fires after an R1 or R3 in the same epoch; R1's review-round line owns the escalation for its round (revision 21)", () => {
  const [, r1, push2, r1Round2, push3, push4] = run([
    ["pre", "git push origin fix"], ["post", "gh pr view 3 --comments"], ["pre", "git push origin fix"],
    ["post", "gh pr view 3 --comments"], ["pre", "git push origin fix"], ["pre", "git push origin fix"]
  ]);
  assert.ok(context(r1));
  assert.equal(context(push2), pushText(2, "`fix`"), "an R1 in this epoch does not quiet R2");
  assert.deepEqual(kinds(push2), ["push"]);
  assert.match(context(r1Round2), /Review round 2 on PR #3/);
  assert.equal(context(push3), pushText(3, "`fix`", false), "R1's review-round line carried the escalation in this epoch");
  assert.equal(context(push4), pushText(4, "`fix`", true), "no R1 in this epoch: R2 carries it");
  // R1's first round has no review-round line, so R2 keeps its own.
  const firstRound = run([["pre", "git push origin fix"], ["pre", "git push origin fix"], ["post", "gh pr view 3 --comments"], ["pre", "git push origin fix"]]);
  assert.doesNotMatch(context(firstRound[2]), /Review round/);
  assert.equal(context(firstRound[3]), pushText(3, "`fix`", true));
  const afterR3 = run([["pre", "git checkout -b feat-a && git push -u origin feat-a"], ["pre", "gh pr create --base feat-a --head feat-b --title 'B'"], ["pre", "git push origin feat-a"]]);
  assert.deepEqual(kinds(afterR3[1]), ["followup"]);
  assert.equal(context(afterR3[2]), pushText(2, "`feat-a`"), "an R3 in this epoch does not quiet R2");
});

test("emit false (another guard rewrote the call): nothing fires or is stamped, but the push still counts", () => {
  const seam = { ...emptySeam(), epochs: { "/r": 1 }, pushes: { "/r|fix": 1 }, own: ["/r|feat-a"] };
  const out = seamBefore({ command: "git push origin fix && git checkout -b fix-a feat-a && gh pr create --base feat-a --head fix-b --title x", cwd: "/r", seam, emit: false });
  assert.deepEqual(out.fired, [], "no R2 at push 2, and no R3 at the branch or the stacked PR");
  assert.deepEqual(out.seam.stamps, {});
  assert.equal(out.seam.pushes["/r|fix"], 2);
  assert.equal(out.seam.epochs["/r"], 2);
  assert.ok(out.seam.own.includes("/r|fix-a"), "ownership is still recorded");
  const live = seamBefore({ command: "git push origin fix", cwd: "/r", seam: out.seam });
  assert.deepEqual(live.fired.map((entry) => entry.kind), ["push"], "the next emitted push fires R2");
});

test("R1 only on own work (revision 22): a review-only session's reads of other repositories", () => {
  const reads = [
    ["post", "gh api repos/o/other/pulls/131/reviews -q '.[] | .body'", "the limit is duplicated"],
    ["post", "gh api graphql -f query='query { repository(owner:\"o\",name:\"other\") { pullRequest(number:116) { reviewThreads(first:9) { nodes { comments(first:1) { nodes { body } } } } } } }'", JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ comments: { nodes: [{ body: "finding" }] } }] } } } } })],
    ["post", "gh pr view 3 -R o/other --json comments", JSON.stringify({ comments: [{ body: "finding" }] })],
    ["post", "cd /elsewhere && gh pr view 131 --json comments -q '.comments[] | .body'", "finding"]
  ];
  // The session pushed only to its own repository, from its own directory.
  const results = run([["pre", "git push origin notes"], ["post", "git push origin notes", "To https://github.com/o/own\n   1a2b3c4..5d6e7f8  notes -> notes\n"], ...reads]);
  assert.deepEqual(results[1].state.seam.ownRepos, ["o/own"]);
  assert.deepEqual(results.slice(2).map(context), [null, null, null, null]);
  assert.deepEqual(results.at(-1).state.seam.rounds, {}, "someone else's PR consumes no review round");
  assert.deepEqual(results.at(-1).state.seam.stamps, {}, "and no stamp");
  // The same stated read after a push to that repository is own work.
  const pushedThere = run([["pre", "git push origin fix"], ["post", "git push origin fix", "To github.com:o/other.git\n"], reads[0]]);
  assert.match(context(pushedThere[2]), /Review feedback on PR #131\./);
  // And a directory read after a push from that directory.
  const fromThere = run([["pre", "cd /elsewhere && git push origin fix"], reads[3]]);
  assert.match(context(fromThere[1]), /Review feedback on PR #131\./);
});

test("R1 on an issue-API thread only for a PR the session opened (revision 22)", () => {
  const thread = ["post", "gh api repos/o/r/issues/94/comments", JSON.stringify([{ body: "a comment" }])];
  assert.equal(context(run([thread], OWN)[0]), null, "an own repository's issue thread may be an issue: no R1");
  const opened = run([["pre", "gh pr create --base main --head fix --title x"], ["post", "gh pr create --base main --head fix --title x", "https://github.com/o/r/pull/94\n"], thread]);
  assert.deepEqual(opened[1].state.seam.ownPrs, ["o/r#94"]);
  assert.deepEqual(opened[1].state.seam.ownRepos, ["o/r"], "opening a PR also makes its repository own");
  assert.match(context(opened[2]), /Review feedback on PR #94\./);
});

test("filtered output is review text only when the filter names body (revision 22)", () => {
  const states = ["post", "gh api graphql -f query='query { repository(owner:\"o\",name:\"r\") { pullRequest(number:89) { reviewThreads(first:9) { nodes { isResolved } } } } }' -q '[.data.repository.pullRequest.reviewThreads.nodes[] | .isResolved] | group_by(.) | map(length)'", "true: 3"];
  assert.equal(context(run([states], OWN)[0]), null, "thread states printed as text");
  const counted = run([states, ["post", "gh api repos/o/r/pulls/89/comments --jq '.[] | .path + \": \" + .body'", "src/a.js: still breaks"]], OWN);
  assert.deepEqual(counted[0].state.seam.stamps, {}, "the state check consumed no stamp");
  assert.match(context(counted[1]), /Review feedback on PR #89\./, "a filter that names body");
  assert.ok(context(run([["post", "gh api repos/o/r/pulls/89/comments -q '.[0]'", JSON.stringify({ path: "a", body: "finding" })]], OWN)[0]), "a filter that keeps JSON is judged by the JSON");
  assert.ok(context(run([["post", "gh pr view 89 --comments", "reviewer: still breaks"]])[0]), "no filter: plain text is review text, as before");
});

test("directory scope: a leading cd ends at &&, ;, or a newline (revision 22)", () => {
  for (const command of ["cd /a && x", "cd /a; x", "cd /a;x", "cd /a\nx", "cd '/a' ; x"]) assert.equal(directoryOf(command, "/r"), "/a", JSON.stringify(command));
  assert.equal(directoryOf('cd "/a b" ; x', "/r"), "/a b");
  for (const command of ["cd /a || exit; x", "cd /a", "x; cd /a; y", "echo cd /a; x"]) assert.equal(directoryOf(command, "/r"), "/r", JSON.stringify(command));
  // The observed read: `cd <repo>; ...; gh pr view N --json comments` is scoped to <repo>, not the session directory.
  assert.equal(context(run([["post", "cd /elsewhere; git log -1; gh pr view 131 --json comments -q '.comments[] | .body'", "finding"]])[0]), null);
});

test("a read that does not count cannot hide one that does under the same key (revision 22)", () => {
  const review = JSON.stringify([{ body: "finding" }]);
  const issueFirst = run([["post", "gh api repos/o/r/issues/5/comments; gh api repos/o/r/pulls/5/comments", review]], OWN);
  assert.match(context(issueFirst[0]), /Review feedback on PR #5\./, "the issue-API read does not count; the pulls read does");
  const stateFirst = run([["post", "gh api graphql -f query='query { repository(owner:\"o\",name:\"r\") { pullRequest(number:5) { reviewThreads(first:9) { nodes { isResolved } } } } }' -q '.data | length'; gh pr view 5 --repo o/r --comments", "reviewer: still breaks"]], OWN);
  assert.match(context(stateFirst[0]), /Review feedback on PR #5\./, "the filtered state check does not count; the comments read does");
  assert.deepEqual(reviewReads("gh api repos/o/r/issues/5/comments; gh api repos/o/r/pulls/5/comments", "/r").map((ref) => ref.key), ["o/r#5"], "reviewReads still lists each key once");
});

test("own work is learned from push To lines and gh pr create URL lines only (revision 22)", () => {
  const learn = (command, output) => learnedOwnership(command, output, "/r");
  for (const [line, repo] of [["To https://github.com/O/Own.git", "o/own"], ["To https://x-access-token@github.com/o/own", "o/own"], ["To github.com:o/own.git", "o/own"], ["To git@github.com:o/own.git", "o/own"], ["To ssh://git@github.com/o/my.repo.git", "o/my.repo"], ["To ssh://github.com/o/own", "o/own"]]) {
    assert.deepEqual(learn("git push origin x", `${line}\n * [new branch]      x -> x\n`).repos, [repo], line);
  }
  assert.deepEqual(learn("git push -q origin x", ""), { repos: [], prs: [] }, "a quiet push teaches nothing");
  assert.deepEqual(learn("git push origin x", "To /tmp/remote.git\n"), { repos: [], prs: [] }, "a remote that is not github.com");
  assert.deepEqual(learn("git push origin x", "To regenerate the lockfile, run npm install\n"), { repos: [], prs: [] }, "prose that starts with To");
  assert.deepEqual(learn("cat push.log", "To https://github.com/o/own\n"), { repos: [], prs: [] }, "only a push's output counts");
  assert.deepEqual(learn("gh pr view 5 --json url -q .url", "https://github.com/o/x/pull/5\n"), { repos: [], prs: [] }, "only gh pr create's output counts");
  assert.deepEqual(learn("gh pr create --title t", "see https://github.com/o/x/pull/4 for context\nrelated: https://github.com/o/x/pull/3\nhttps://github.com/o/x/pull/5\n").prs, ["o/x#5"], "only a line that is the URL");
  // A PR opened in one directory, read with its repository stated from another.
  const opened = run([["post", "cd /w && gh pr create --base main --head f --title t", "https://github.com/o/x/pull/7\n"], ["post", "cd /elsewhere && gh api repos/o/x/pulls/7/comments", JSON.stringify([{ body: "finding" }])]]);
  assert.match(context(opened[1]), /Review feedback on PR #7\./);
  // A read stating no repository, from the session directory, before any push (the seam-review shape).
  assert.match(context(run([["post", "gh pr view 1 --comments", "reviewer: finding"]])[0]), /Review feedback on PR #1\./);
  // A script that pushes and then reads counts its own push.
  const oneScript = run([["post", "git push origin fix && gh api repos/o/y/pulls/2/comments", `To https://github.com/o/y\n${JSON.stringify([{ body: "finding" }])}`]]);
  assert.match(context(oneScript[0]), /Review feedback on PR #2\./);
});

test("a revision 20 state loads: its lastFired is dropped and does not quiet R2", () => {
  const seam = { epochs: { "/r": 1 }, pushes: { "/r|fix": 1 }, own: [], rounds: { "dir:/r#3": 1 }, stamps: { "review:dir:/r#3": "/r@1" }, lastFired: { "/r": 1 } };
  const out = seamBefore({ command: "git push origin fix", cwd: "/r", seam });
  assert.deepEqual(out.fired.map((entry) => entry.kind), ["push"]);
  assert.equal(out.seam.lastFired, undefined);
  assert.deepEqual(out.seam.escalated, {});
  assert.deepEqual([out.seam.ownRepos, out.seam.ownPrs], [[], []], "a state without own work loads as empty lists (revision 22)");
});

test("R3 fires on a PR stacked on an own branch; not on a fix title, with or without an earlier merge", () => {
  const stacked = run([["pre", "git checkout -b feat-a && git push -u origin feat-a"], ["pre", "set -e\npython - <<'PY'\nprint('ledger')\nPY\ngh pr create --base feat-a --head feat-b --title 'Next step' --body-file b.md"]]);
  assert.match(context(stacked[1]), /^\[seam-redirect\] This PR is stacked on this session's own work \(feat-a\)\. If it fixes a defect feat-a introduced/);
  assert.match(context(stacked[1]), /If feat-a is not merged yet, move the fix onto feat-a and close this PR as superseded\./);
  assert.deepEqual(kinds(stacked[1]), ["followup"]);
  const fix = run([["post", "gh pr merge 7 --squash"], ["pre", 'gh pr create --base main --title "Fix the date parser regression"']]);
  assert.equal(context(fix[1]), null, "a merge and a fix title do not tie the PR to merged work");
  assert.equal(fix[1].state.seam.merged, undefined, "merges are not tracked");
  assert.equal(context(run([["pre", 'gh pr create --base main --title "Add the export button"']])[0]), null, "base main, feature title");
  assert.equal(context(run([["pre", 'gh pr create --base main --title "Fix typo"']])[0]), null, "fix title, nothing merged");
  assert.deepEqual(prCreate("gh pr create -B dev -t 'Fix x' -H y"), { base: "dev", head: "y" });
});

test("R3 fires earliest at a branch started from own work, before any PR; not from main or a branch the session never created", () => {
  const early = run([["pre", "git checkout -b feat-a"], ["pre", "git checkout -b fix-a feat-a"]]);
  assert.equal(context(early[1]), branchText("fix-a", "feat-a"));
  assert.deepEqual(kinds(early[1]), ["followup"]);
  assert.ok(context(run([["pre", "gh pr create --head feat-a --base main --title 'A'"], ["pre", "git switch -c fix-a feat-a"]]).at(-1)), "switch -c from a PR head");
  assert.ok(context(run([["pre", "git checkout -b feat-a"], ["pre", "git worktree add -b fix-a ../wt feat-a"]]).at(-1)), "worktree add -b with a start point");
  assert.equal(context(run([["pre", "git checkout -b fix-a main"]]).at(-1)), null, "from main");
  assert.equal(context(run([["pre", "git push origin shared"], ["pre", "git checkout -b fix-a shared"]]).at(-1)), null, "a pushed-only branch is not own");
  assert.equal(context(run([["pre", "git checkout -b feat-a"], ["pre", "git checkout -b other"]]).at(-1)), null, "no start point stated");
});

test("SR7: no redirect text asks a question, asks for a reply, or offers merge, defer, or stop", () => {
  const banned = /\?|\b(answer|reply|recommend|merge|defer|stop)\b/i;
  const texts = [
    reviewText(["PR #1"], 1, "PR #1", []), reviewText(["PR #1", "PR #2"], 2, "PR #2", [{ path: "a", line: 1 }]), reviewText(["the current branch's PR"], 3, "the current branch's PR", []),
    pushText(2, "`x`"), pushText(3, "`x`", false), pushText(3, "`x`", true), pushText(9, "the current branch in /r", true),
    followupText("a"), branchText("fix-a", "feat-a")
  ];
  for (const text of texts) assert.doesNotMatch(text, banned, text);
});

test("output shapes: PostToolUse and PreToolUse additionalContext (probe Q4, Q10); nothing denies or records pending", () => {
  const [p] = run([["post", "gh pr view 1 --comments"]]);
  assert.deepEqual(Object.keys(p.output.hookSpecificOutput).sort(), ["additionalContext", "hookEventName"]);
  assert.equal(p.output.hookSpecificOutput.hookEventName, "PostToolUse");
  const [, push] = run([["pre", "git push origin a"], ["pre", "git push origin a"]]);
  assert.equal(push.output.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(push.output.hookSpecificOutput.permissionDecision, undefined);
  assert.deepEqual(push.state.pending, []);
});

test("dispatcher: a denied call counts no push; another guard's context and a seam redirect are joined and both logged", () => {
  const deny = { code: "x", check: () => ({ action: "deny", reason: "[x] no", pending: { code: "x" } }) };
  const seeded = { ...emptySeam(), pushes: { "?|a": 1 }, own: ["?|a"], epochs: { "?": 1 } };
  const denied = decide({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin a" } }, { pending: [], seam: seeded }, { guards: [deny] });
  assert.equal(denied.output.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(denied.state.seam.pushes["?|a"], 1, "the refused push is not counted");
  const hint = { code: "y", check: () => ({ action: "context", kind: "context", reason: "[y] hint" }) };
  const joined = decide({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin a" } }, { pending: [], seam: seeded }, { guards: [hint] });
  assert.match(context(joined), /^\[y\] hint\n\n\[seam-redirect\] Push 2/);
  assert.deepEqual(joined.log, [{ code: "y", kind: "context" }, { code: "seam-redirect", kind: "push" }]);
  const patch = decide({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n+git push origin a\n" } }, { pending: [] }, { guards: [] });
  assert.equal(patch.output, null, "apply_patch text is never read as commands");
});

test("SR5: a seam error gives no redirect, lets the call through, and is reported", () => {
  const broken = { pending: [], seam: { get stamps() { throw new Error("boom"); } } };
  const result = decide({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "gh pr view 1 --comments" } }, broken, { guards: [] });
  assert.equal(result.output, null);
  assert.match(result.errors[0], /^seam: Error: boom/);
});

test("main: seam redirects are logged to denials.jsonl by kind, and the state persists across events", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "seam-state-"));
  try {
    const env = { ...process.env, SOL_LAB_GUARD_STATE: dir };
    let out = "";
    for (const command of ["git push origin a", "git push origin a"]) {
      out = "";
      main(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: { command } }), env, (text) => { out += text; });
    }
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /Push 2 to `a`/);
    assert.match(await readFile(path.join(dir, "denials.jsonl"), "utf8"), /"code":"seam-redirect","kind":"push"/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("nothing for fix loops runs at Stop: 5, 10, and 20 pushes give no round-guard finding", async () => {
  for (const n of [5, 10, 20]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "seam-stop-"));
    try {
      const file = path.join(dir, "rollout.jsonl");
      await writeFile(file, [R.turn("t"), ...Array.from({ length: n }, () => R.ran("git push origin fix", "/r")), R.say("Pushed.")].join("\n") + "\n");
      const { findings } = runStopGates({ transcript_path: file, stop_hook_active: false }, {}, "/h");
      assert.equal(findings.filter((finding) => finding.code === "round-guard").length, 0, `${n} pushes`);
      assert.equal(decide({ hook_event_name: "Stop", transcript_path: file, stop_hook_active: false }, { pending: [] }).output, null, `${n} pushes: Stop does not block`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("seamBefore and seamAfter are pure: the input state is not mutated", () => {
  const seam = { ...emptySeam(), pushes: { "?|a": 1 }, own: ["?|a"], epochs: { "?": 1 } };
  const frozen = JSON.stringify(seam);
  seamBefore({ command: "git push origin a", seam });
  seamAfter({ command: "gh pr view 1 --comments", response: "", seam });
  assert.equal(JSON.stringify(seam), frozen);
});
