import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { PUSH_ESCALATION } from "../hooks/codex-guards/guards/seam.mjs";
import { claudeCommands, replaySeam } from "../scripts/replay-seam-redirect.mjs";

// Contract 5.4 settling evidence: the incident replay, on a synthetic rollout
// with the incident's shape, and on the real rollout when it is present.

const ran = (at, command, output = "", cwd = "/r") => JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", command: ["/bin/bash", "-lc", command], cwd: `file://${cwd}`, status: "completed", exit_code: 0, aggregated_output: output } } });
const redirects = (replayed) => replayed.timeline.filter((event) => event.type === "redirect");
const at = (replayed, prefix) => redirects(replayed).filter((event) => event.at.startsWith(prefix));

test("replay: the incident's shape gets a redirect before push 2, an escalated one before push 3, and R2 at every re-push", () => {
  const review = JSON.stringify([{ path: "src/rule.py", line: 12, body: "same class again" }]);
  const rows = [
    // The push and the create print what real ones do: own work (revision 22).
    ran("T01", "git checkout -b step-1 && git push -u origin step-1", "To github.com:o/r.git\n * [new branch]      step-1 -> step-1\n"),
    ran("T02", "set -e\npython - <<'PY'\nopen('.codex/SESSION_LEDGER.md','a').write('x')\nPY\ngh pr create --base step-1 --head step-2 --title 'Step 2'", "https://github.com/o/r/pull/2\n"),
    ran("T03", "git push -u origin step-2"),
    ran("T04", "gh api repos/o/r/pulls/2/comments", review),
    ran("T05", "gh api repos/o/r/pulls/2/comments/9/replies --input reply.json"),
    ran("T06", "git push origin step-2"),
    ran("T07", "gh api repos/o/r/pulls/2/comments", review),
    ran("T08", "git push origin step-2"),
    ran("T09", "git push origin step-2"),
    ran("T10", "git push origin step-2")
  ].join("\n");
  const replayed = replaySeam(rows);
  assert.deepEqual(at(replayed, "T02").map((event) => event.kinds), [["followup"]], "R3 at the stacked PR create, after a heredoc");
  const [first] = at(replayed, "T04");
  assert.deepEqual(first.kinds, ["review"]);
  assert.ok(!first.headlines.some((line) => line.startsWith("Review round")));
  assert.deepEqual(at(replayed, "T05"), [], "a reply with --input is a write, not a read");
  assert.deepEqual(at(replayed, "T06").map((event) => event.kinds), [["push"]], "push 2: R2 after the round's R1 (revision 21)");
  assert.ok(at(replayed, "T07")[0].headlines.some((line) => line.startsWith("Review round 2 on PR #2")));
  const escalated = (prefix) => at(replayed, prefix)[0].headlines.includes(PUSH_ESCALATION);
  assert.deepEqual(at(replayed, "T08").map((event) => event.kinds), [["push"]]);
  assert.equal(escalated("T08"), false, "push 3: the T07 review-round line carried the escalation");
  assert.deepEqual(at(replayed, "T09").map((event) => event.kinds), [["push"]], "push 4 in an epoch without a review read: R2");
  assert.equal(escalated("T09"), true, "push 4: no review read in its epoch, so R2 carries the escalation");
  assert.deepEqual(replayed.checkpoints, [{ subject: "step-2", checkpointAt: "T10", firstRedirect: { at: "T04", kinds: ["review"], pushesEarlier: 4 } }]);
});

test("replay: a checkpoint counts only redirects from its own directory scope", () => {
  const rows = [
    ran("T00", "cd /b && git push origin side"),
    ran("T01", "cd /a && git push origin fix"),
    ran("T02", "cd /b && gh pr view 7 --comments", "reviewer: other repository"),
    ran("T03", "cd /a && git push origin fix"),
    ran("T04", "cd /a && git push origin fix"),
    ran("T05", "cd /a && git push origin fix"),
    ran("T06", "cd /a && git push origin fix")
  ].join("\n");
  const replayed = replaySeam(rows);
  assert.deepEqual(at(replayed, "T02").map((event) => event.scopes), [["/b"]], "the decoy review redirect is /b's");
  const [checkpoint] = replayed.checkpoints;
  assert.equal(checkpoint.checkpointAt, "T06");
  assert.equal(checkpoint.firstRedirect.at, "T03", "/b's review redirect does not cover /a's checkpoint");
  assert.deepEqual(checkpoint.firstRedirect.kinds, ["push"]);
});

// The real rollout behind section 5.4 is private and stays local. Point
// SEAM_INCIDENT_ROLLOUT at it to run this check.
test("replay: the reproduction rollout meets the 5.4 timeline", (t) => {
  const file = process.env.SEAM_INCIDENT_ROLLOUT;
  if (!file || !existsSync(file)) {
    t.skip("SEAM_INCIDENT_ROLLOUT is not set to a readable rollout; the private reproduction is checked locally only");
    return;
  }
  const replayed = replaySeam(readFileSync(file, "utf8"));
  assert.ok(at(replayed, "2026-10-03T01:03").some((event) => event.kinds.includes("followup")), "R3 at the stacked PR create (01:03Z)");
  assert.ok(at(replayed, "2026-10-03T01:26").some((event) => event.kinds.includes("review")), "R1 at the first review read (01:26Z)");
  assert.ok(at(replayed, "2026-10-03T01:29").some((event) => event.kinds.includes("push")), "R2 at push 2 (01:29Z), after the 01:26Z R1 (revision 21)");
  assert.ok(at(replayed, "2026-10-03T03:42").some((event) => event.headlines.some((line) => /^Review round 2 on PR #\d+/.test(line))), "the escalated R1 at 03:42Z");
  const pushes = replayed.timeline.filter((event) => event.type === "push");
  const push3 = pushes.find((event) => event.at.startsWith("2026-10-03T04:46"));
  assert.ok(push3, "push 3 is at 04:46Z");
  const r2 = at(replayed, "2026-10-03T04:46").filter((event) => event.kinds.includes("push"));
  assert.ok(r2.length, "R2 at push 3 (04:46Z)");
  assert.ok(r2.every((event) => !event.headlines.includes(PUSH_ESCALATION)), "without the escalation line, which the 03:42Z R1 carried");
});

// Revision 22: a Claude Code transcript, replayed through the Claude adapter.
const call = (at, id, command, cwd = "/r") => JSON.stringify({ type: "assistant", timestamp: at, cwd, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const answer = (id, stdout, stderr = "") => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: stdout }] }, toolUseResult: { stdout, stderr, interrupted: false } });

test("replay --claude: Bash calls with their results, in order; R1 only on own work", () => {
  const review = JSON.stringify([{ path: "src/a.js", line: 3, body: "finding" }]);
  const rows = [
    call("T01", "a", "git push origin notes"), answer("a", "", "To https://github.com/o/own\n   1a2b3c4..5d6e7f8  notes -> notes\n"),
    call("T02", "b", "gh api repos/o/other/pulls/9/comments"), answer("b", review),
    call("T03", "c", "cd /elsewhere; gh pr view 9 --json comments -q '.comments[] | .body'"), answer("c", "finding"),
    call("T04", "d", "gh api repos/o/own/pulls/4/comments"), answer("d", review),
    call("T05", "a", "git push origin notes")
  ].join("\n");
  assert.deepEqual([...claudeCommands(rows)].map((c) => c.at), ["T01", "T02", "T03", "T04"], "a repeated tool_use id is one call");
  const replayed = replaySeam(rows, { claude: true });
  assert.deepEqual(redirects(replayed).map((event) => [event.at, event.kinds]), [["T04", ["review"]]]);
});

// The review-only Claude Code session behind revision 22 is private and stays
// local. Point SEAM_REVIEWER_TRANSCRIPT at it to run this check.
test("replay --claude: the review-only session gets no R1", (t) => {
  const file = process.env.SEAM_REVIEWER_TRANSCRIPT;
  if (!file || !existsSync(file)) {
    t.skip("SEAM_REVIEWER_TRANSCRIPT is not set to a readable transcript; the private session is checked locally only");
    return;
  }
  const replayed = replaySeam(readFileSync(file, "utf8"), { claude: true });
  assert.deepEqual(redirects(replayed).filter((event) => event.kinds.includes("review")), []);
});
