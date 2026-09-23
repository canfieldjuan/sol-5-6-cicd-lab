import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runStopGates } from "../hooks/codex-guards/guard.mjs";
import { R } from "./codex-rollout-rows.mjs";

// Parity with the Claude originals (contract 5.3). Each case states the verdict
// both implementations must give. Since revision 17 the Claude originals carry
// the revision 15-16 fixes too, so a `claude` override remains only where the
// transcript formats themselves differ. When the Claude scripts are absent
// (CI), the Codex side is still held to the stated verdicts.
const CLAUDE_HOOKS = path.join(os.homedir(), ".claude", "hooks");
const EVIDENCE_SH = path.join(CLAUDE_HOOKS, "evidence-gate.sh");
const ROUND_SH = path.join(CLAUDE_HOOKS, "round-guard.sh");

const EVIDENCE_CASES = [
  { prose: "Committed as deadbeefc0ffee1 and the suite reports 41 passed.", evidence: "ok", tokens: ["test count: 41 passed", "git object id: deadbeefc0ffee1"] },
  { prose: "The suite reports 41 passed.", evidence: "===== 41 passed in 2.1s =====", tokens: [] },
  { prose: "I claimed earlier the suite gave 41 passed.", evidence: "", tokens: [] },
  { prose: "I ran it earlier. Separately, the suite gives 12 passed.", evidence: "", tokens: ["test count: 12 passed"] },
  { prose: "12 passed inspection.", evidence: "", tokens: [] },
  { prose: "CSS color #abcdef0 on the page.", evidence: "", tokens: [] },
  { prose: "Merged at 1234567 on main.", evidence: "", tokens: [], note: "digit-only ids are not hashes" },
  { prose: "The run ended exit=1 after ::test_login_flow failed.", evidence: "", tokens: ["test node: ::test_login_flow", "exit code: exit=1"] },
  { prose: "```\ncommit deadbeefc0ffee1 and 41 passed tests\n```\nSee above.", evidence: "", tokens: [] },
  { prose: "Pushed abcdef1234 to the branch.", evidence: "HEAD is now at ABCDEF1234", tokens: [], note: "backing is case-insensitive" },
  { prose: "DocSum PR #90 passed its review gate.", evidence: "", tokens: [], note: "#N is an identifier (revision 15; Claude since 17)" },
  { prose: "PR #90: 90 passed in the gate.", evidence: "", tokens: ["test count: 90 passed"], note: "a real count beside a #N still counts" }
];

function runClaudeEvidence(dir, { prose, evidence }) {
  const transcript = path.join(dir, "claude.jsonl");
  const rows = [
    { message: { role: "user", content: "go" } },
    { message: { role: "assistant", content: [{ type: "tool_use", id: "u", name: "Bash", input: { command: "x" } }] } },
    { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "u", content: evidence }] } },
    { message: { role: "assistant", content: [{ type: "text", text: prose }] } }
  ];
  return writeFile(transcript, rows.map((r) => JSON.stringify(r)).join("\n") + "\n").then(() => {
    const result = spawnSync("bash", [EVIDENCE_SH], { input: JSON.stringify({ transcript_path: transcript, stop_hook_active: false }), encoding: "utf8" });
    if (!result.stdout.trim()) return [];
    const reason = JSON.parse(result.stdout).reason;
    return reason.split("\n\n")[1].split("\n").filter(Boolean);
  });
}

async function runCodexEvidence(dir, { prose, evidence }) {
  const file = path.join(dir, "codex.jsonl");
  await writeFile(file, [R.turn("t"), R.exec(["x"]), R.out(evidence), R.say(prose)].join("\n") + "\n");
  const finding = runStopGates({ transcript_path: file, stop_hook_active: false }, {}, "/h").findings.find((f) => f.code === "evidence-gate");
  return finding ? finding.tokens : [];
}

test("parity: evidence gate verdicts match the Claude original on every case", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "parity-"));
  const haveClaude = existsSync(EVIDENCE_SH);
  if (!haveClaude) t.diagnostic(`${EVIDENCE_SH} absent: checking the Codex port against the stated verdicts only`);
  try {
    for (const c of EVIDENCE_CASES) {
      assert.deepEqual(await runCodexEvidence(dir, c), c.tokens, `codex: ${c.prose}`);
      if (haveClaude) assert.deepEqual(await runClaudeEvidence(dir, c), c.claude ?? c.tokens, `claude: ${c.prose}`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const ROUND_CASES = [
  { pushes: Array(4).fill(["git push origin feat", "/r"]), fires: null },
  { pushes: Array(5).fill(["git push origin feat", "/r"]), fires: { branch: "feat", count: 5 } },
  { pushes: [...Array(6).fill(["git push origin a", "/r"]), ["git push origin b", "/r"]], fires: null, note: "subject is the latest branch" },
  { pushes: Array(10).fill(["git push -u origin feat", "/r"]), fires: { branch: "feat", count: 10 } },
  { pushes: [["git push", "/r/a"], ["git push", "/r/b"], ["git push", "/r/c"], ["git push", "/r/d"], ["git push", "/r/a"]], fires: null, note: "bare pushes keyed by directory (revision 15; Claude since 17)" },
  { pushes: Array(5).fill(["git push", "/r/a"]), fires: { branch: "<current-branch>@/r/a", count: 5 }, note: "bare pushes in one directory" },
  { pushes: [...Array(4).fill(["git push origin feat", "/r"]), ...Array(4).fill(["printf '%s' 'fixed; git push origin feat' >> L", "/r"])], fires: null, note: "text is not a push (revision 16; Claude since 17)" }
];

function runClaudeRound(dir, pushes, n) {
  const transcript = path.join(dir, `claude-round-${n}.jsonl`);
  // Real Claude transcript rows carry the cwd each command ran in.
  const rows = pushes.map(([cmd, cwd]) => ({ cwd, message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: cmd } }] } }));
  return writeFile(transcript, rows.map((r) => JSON.stringify(r)).join("\n") + "\n").then(() => {
    const result = spawnSync("bash", [ROUND_SH], { input: JSON.stringify({ transcript_path: transcript, stop_hook_active: false, session_id: `parity-${n}` }), encoding: "utf8", env: { ...process.env, HOME: dir } });
    if (!result.stdout.trim()) return null;
    const match = /ROUND GUARD: (\d+) pushes to `([^`]+)`/.exec(JSON.parse(result.stdout).reason);
    return { branch: match[2], count: Number(match[1]) };
  });
}

async function runCodexRound(dir, pushes, n) {
  const file = path.join(dir, `codex-round-${n}.jsonl`);
  await writeFile(file, [R.turn("t"), ...pushes.map(([cmd, workdir], i) => R.exec([{ cmd, workdir }], `p${i}`))].join("\n") + "\n");
  const finding = runStopGates({ transcript_path: file, stop_hook_active: false }, {}, "/h").findings.find((f) => f.code === "round-guard");
  if (!finding) return null;
  // Compare the subject key (the stamp minus its tier); the Codex reason words
  // a directory-keyed subject for the reader instead of printing the key.
  return { branch: finding.stamp.replace(/:\d+$/, ""), count: Number(/(\d+) pushes to/.exec(finding.reason)[1]) };
}

test("parity: round guard verdicts match the Claude original on every case", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "parity-round-"));
  const haveClaude = existsSync(ROUND_SH);
  if (!haveClaude) t.diagnostic(`${ROUND_SH} absent: checking the Codex port against the stated verdicts only`);
  try {
    for (const [n, c] of ROUND_CASES.entries()) {
      assert.deepEqual(await runCodexRound(dir, c.pushes, n), c.fires, `codex case ${n}: ${c.note ?? ""}`);
      if (haveClaude) assert.deepEqual(await runClaudeRound(dir, c.pushes, n), c.claude ?? c.fires, `claude case ${n}: ${c.note ?? ""}`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
