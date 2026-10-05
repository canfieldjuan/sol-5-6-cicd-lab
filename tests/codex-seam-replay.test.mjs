import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { replaySeam } from "../scripts/replay-seam-redirect.mjs";

// Contract 5.4 settling evidence: the incident replay, on a synthetic rollout
// with the incident's shape, and on the real rollout when it is present.

const ran = (at, command, output = "", cwd = "/r") => JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", command: ["/bin/bash", "-lc", command], cwd: `file://${cwd}`, status: "completed", exit_code: 0, aggregated_output: output } } });
const redirects = (replayed) => replayed.timeline.filter((event) => event.type === "redirect");
const at = (replayed, prefix) => redirects(replayed).filter((event) => event.at.startsWith(prefix));

test("replay: the incident's shape gets a redirect before push 2 and an escalated one before push 3", () => {
  const review = JSON.stringify([{ path: "src/rule.py", line: 12, body: "same class again" }]);
  const rows = [
    ran("T01", "git checkout -b step-1 && git push -u origin step-1"),
    ran("T02", "set -e\npython - <<'PY'\nopen('.codex/SESSION_LEDGER.md','a').write('x')\nPY\ngh pr create --base step-1 --head step-2 --title 'Step 2'"),
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
  assert.deepEqual(at(replayed, "T06"), [], "push 2: R1 already fired in that epoch");
  assert.ok(at(replayed, "T07")[0].headlines.some((line) => line.startsWith("Review round 2 on PR #2")));
  assert.deepEqual(at(replayed, "T09").map((event) => event.kinds), [["push"]], "push 4 in an epoch without a review read: R2");
  assert.deepEqual(replayed.checkpoints, [{ subject: "step-2", checkpointAt: "T10", firstRedirect: { at: "T04", kinds: ["review"], pushesEarlier: 4 } }]);
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
  assert.deepEqual(at(replayed, "2026-10-03T01:29"), [], "no R2 at push 2 (01:29Z)");
  assert.ok(at(replayed, "2026-10-03T03:42").some((event) => event.headlines.some((line) => /^Review round 2 on PR #\d+/.test(line))), "the escalated R1 at 03:42Z");
  const pushes = replayed.timeline.filter((event) => event.type === "push");
  const push3 = pushes.find((event) => event.at.startsWith("2026-10-03T04:46"));
  assert.ok(push3, "push 3 is at 04:46Z");
});
