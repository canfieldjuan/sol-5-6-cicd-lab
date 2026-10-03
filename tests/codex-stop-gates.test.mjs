import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decide, main, runStopGates, STOP_GATES } from "../hooks/codex-guards/guard.mjs";
import { execCommands, readRollout } from "../hooks/codex-guards/lib/rollout.mjs";
import { unbackedClaims } from "../hooks/codex-guards/stop/evidence-gate.mjs";
import { pushesIn, roundVerdict } from "../hooks/codex-guards/stop/round-guard.mjs";
import { R } from "./codex-rollout-rows.mjs";

async function rollout(rows) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stop-gates-"));
  const file = path.join(dir, "rollout.jsonl");
  await writeFile(file, rows.join("\n") + "\n");
  return { dir, file };
}

test("reader: the current turn starts at the last task_started, or at the Stop input's turn_id", async () => {
  const r = await rollout([R.meta(), R.turn("t1"), R.say("old claim"), R.out("old output"), R.turn("t2"), R.say("new claim"), R.out("new output")]);
  try {
    const last = readRollout(r.file);
    assert.deepEqual(last.prose, ["new claim"]);
    assert.ok(last.evidence.includes("new output") && !last.evidence.includes("old output"));
    const pinned = readRollout(r.file, { turnId: "t1" });
    assert.deepEqual(pinned.prose, ["old claim", "new claim"], "pinned to t1: everything from t1 on");
  } finally { await rm(r.dir, { recursive: true, force: true }); }
});

test("reader: evidence from exec chunks (output + exit code), plain outputs, function outputs, and sub-agent reports", async () => {
  const r = await rollout([R.turn("t"), R.chunk("12 passed in 0.3s\n", 0), R.out("Process exited with code 2\nboom"), R.fnOut("wait result: done"), R.report("Committed as 7a9edf72e0602a3801a99a96bd99f8e3a769d8be")]);
  try {
    const { evidence } = readRollout(r.file);
    const all = evidence.join("\n");
    for (const expected of ["12 passed in 0.3s", "exit_code=0", "exit code 0", "exit=2", "wait result: done", "7a9edf72e0602a3801a99a96bd99f8e3a769d8be"]) assert.ok(all.includes(expected), expected);
  } finally { await rm(r.dir, { recursive: true, force: true }); }
});

test("reader: tolerates bad lines, raw control characters, and adds an unflushed final message once", async () => {
  const raw = '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"tab\there"}]}}';
  const r = await rollout([R.turn("t"), "{not json", raw, R.say("Final.")]);
  try {
    const read = readRollout(r.file, { lastAssistantMessage: "Final." });
    assert.deepEqual(read.prose, ["tab\there", "Final."], "the already-present final message is not added twice");
    assert.deepEqual(readRollout(r.file, { lastAssistantMessage: "Unflushed." }).prose.at(-1), "Unflushed.");
  } finally { await rm(r.dir, { recursive: true, force: true }); }
});

test("reader: commands from every exec_command in a script, any quote style, with workdir; the whole session", async () => {
  assert.deepEqual(execCommands(`const a = await tools.exec_command({"cmd":"git push origin HEAD","workdir":"/r/a"});\nconst b = await tools.exec_command({workdir: '/r/b', cmd: \`git push\`});\nconst c = await tools.exec_command({"cmd":"echo \\"x\\""});`), [
    { cmd: "git push origin HEAD", workdir: "/r/a" }, { cmd: "git push", workdir: "/r/b" }, { cmd: 'echo "x"', workdir: null }
  ]);
  assert.deepEqual(execCommands('text("cmd: git push is not a call")'), [], "no exec_command call, no commands");
  assert.deepEqual(execCommands('const r = await tools.exec_command({"cmd":"git status"});\ntext(JSON.stringify({"command":"git push origin x"}));'), [{ cmd: "git status", workdir: null }], "a later cmd-like literal is not a second call");
  const r = await rollout([R.turn("t1"), R.exec(["git push origin a"]), R.turn("t2"), R.exec([{ cmd: "git push origin b", workdir: "/r" }])]);
  try { assert.deepEqual(readRollout(r.file).commands.map((c) => c.cmd), ["git push origin a", "git push origin b"]); }
  finally { await rm(r.dir, { recursive: true, force: true }); }
});

test("evidence: unbacked results block; backed, hedged, context-free, fenced, and #N claims do not", () => {
  const flagged = unbackedClaims(["Committed as deadbeefc0ffee1 and the suite reports 41 passed, exit=0, ::test_new_thing."], ["ok"]);
  assert.deepEqual(flagged, ["test node: ::test_new_thing", "test count: 41 passed", "exit code: exit=0", "git object id: deadbeefc0ffee1"]);
  assert.deepEqual(unbackedClaims(["The suite reports 41 passed."], ["===== 41 passed in 2s ====="]), [], "backed");
  assert.deepEqual(unbackedClaims(["I claimed earlier that the suite gave 41 passed."], []), [], "hedged in its own sentence");
  assert.deepEqual(unbackedClaims(["I ran it earlier. Separately, the suite gives 12 passed."], []), ["test count: 12 passed"], "a hedge in the neighbouring sentence does not launder");
  assert.deepEqual(unbackedClaims(["12 passed inspection."], []), [], "no test context");
  assert.deepEqual(unbackedClaims(["CSS color abcdef0 is used."], []), [], "hex without git context");
  assert.deepEqual(unbackedClaims(["```\ncommit deadbeefc0ffee1, 41 passed test\n```"], []), [], "fenced block is quoted evidence");
  assert.deepEqual(unbackedClaims(["DocSum PR #90 passed its review gate."], []), [], "revision 15: #90 is an identifier");
  assert.deepEqual(unbackedClaims(["PR #90: 90 passed in the gate."], []), ["test count: 90 passed"], "a real count beside a #N still counts");
});

// Revision 18: node:test summary lines back a count; nothing else changes.
test("evidence (revision 18): a runner summary line backs a count only with the same digits and outcome", () => {
  const claim = "Node: 94 tests, 94 passed, 0 failed.";
  const spec = "\u2139 tests 94\n\u2139 suites 0\n\u2139 pass 94\n\u2139 fail 0\n\u2139 cancelled 0";
  assert.deepEqual(unbackedClaims([claim], [spec]), [], "node:test spec reporter");
  assert.deepEqual(unbackedClaims([claim], ["1..94\n# tests 94\n# suites 0\n# pass 94\n# fail 0"]), [], "node:test TAP reporter (piped on Node 20-22)");
  assert.deepEqual(unbackedClaims([claim], [JSON.stringify({ chunk_id: "x", exit_code: 0, output: "1..94\n# tests 94\n# pass 94\n# fail 0\n" })]), [], "TAP inside a JSON-encoded exec chunk");
  assert.deepEqual(unbackedClaims([claim], ["\u2139 tests 940\n\u2139 pass 940\n\u2139 fail 10"]), ["test count: 94 passed", "test count: 0 failed"], "940 and 10 are not 94 and 0");
  assert.deepEqual(unbackedClaims([claim], ["\u2139 pass 194\n\u2139 fail 0"]), ["test count: 94 passed"], "194 is not 94");
  assert.deepEqual(unbackedClaims(["The suite gives 94 failed and 0 passed."], [spec]), ["test count: 94 failed", "test count: 0 passed"], "the outcome must match");
  assert.deepEqual(unbackedClaims(["The suite gives 94 passed."], ["\u2139 tests 94\n\u2139 fail 0"]), ["test count: 94 passed"], "a total is not a pass count");
  assert.deepEqual(unbackedClaims(["The suite gives 94 passed."], ["notes: # pass 94"]), ["test count: 94 passed"], "TAP form only at a line start");
  // As printed by pytest 9.0.2 and cargo 1.98.0: the verbatim rule backs these.
  assert.deepEqual(unbackedClaims(["pytest: 2 passed, 1 failed."], ["FAILED test_x.py::test_c - assert False\n1 failed, 2 passed in 0.02s"]), [], "pytest");
  assert.deepEqual(unbackedClaims(["cargo test: 2 passed, 0 failed."], ["test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s"]), [], "cargo");
});

// Excerpted from the rows of Codex session 01a1006d (2026-10-03), a resumed
// session: the prior turn's run printed pass 93 / fail 1, the third turn's run
// pass 94 / fail 0. Contract revision 18 lists the redactions.
test("evidence (revision 18): the real rollout's node:test claim is backed; the prior turn's numbers are not", () => {
  const cases = [["node-test-counts.jsonl", []], ["node-test-counts-near-miss.jsonl", ["test count: 93 passed", "test count: 1 failed"]]];
  for (const [name, tokens] of cases) {
    const file = fileURLToPath(new URL(`./fixtures/stop-evidence/${name}`, import.meta.url));
    const last = readRollout(file).prose.at(-1);
    for (const turnId of ["01a1008c-e027-73e1-9192-789e205fc39e", null]) {
      const { findings, errors } = runStopGates({ transcript_path: file, stop_hook_active: false, turn_id: turnId, last_assistant_message: last }, {}, "/h");
      assert.deepEqual(errors, []);
      assert.deepEqual(findings.find((f) => f.code === "evidence-gate")?.tokens ?? [], tokens, `${name}, turn_id ${turnId}`);
    }
  }
});

test("round guard: tiers at 5/10/15/20 on the most recently pushed branch, once per tier", () => {
  const push = (branch, n) => Array.from({ length: n }, () => ({ cmd: `git push origin ${branch}`, workdir: "/r" }));
  assert.equal(roundVerdict(push("x", 4)), null, "4 pushes: no checkpoint");
  assert.deepEqual(roundVerdict(push("x", 5)), { branch: "x", label: "`x`", count: 5, tier: 5, stamp: "x:5" });
  assert.equal(roundVerdict(push("x", 7), ["x:5"]), null, "tier 5 already fired");
  assert.equal(roundVerdict(push("x", 10), ["x:5"]).tier, 10);
  assert.equal(roundVerdict([...push("x", 6), ...push("y", 1)]), null, "subject is the most recent branch (y, 1 push)");
  const forced = Array.from({ length: 5 }, () => ({ cmd: "git push -u origin --force feature", workdir: null }));
  assert.equal(roundVerdict(forced).branch, "<current-branch>", "a flag captured as the refspec falls back to the bucket, as in the original");
});

test("round guard (revision 15): HEAD and bare pushes are keyed by workdir or a leading cd, never mixed across repos", () => {
  const at = (cmd, workdir) => ({ cmd, workdir });
  const mixed = [at("git push", "/r/a"), at("git push", "/r/b"), at("git push", "/r/c"), at("git push", "/r/d"), at("git push", "/r/a")];
  assert.equal(roundVerdict(mixed), null, "5 bare pushes across 4 repos are not 5 rounds");
  const same = Array.from({ length: 5 }, () => at("git push origin HEAD", "/r/a"));
  assert.deepEqual(roundVerdict(same), { branch: "HEAD@/r/a", label: "the current branch in /r/a", count: 5, tier: 5, stamp: "HEAD@/r/a:5" });
  const viaCd = Array.from({ length: 5 }, () => at("cd /r/z && git push", "/elsewhere"));
  assert.equal(roundVerdict(viaCd).branch, "<current-branch>@/r/z", "a leading cd overrides the workdir");
  assert.equal(roundVerdict(Array.from({ length: 5 }, () => at("git push", null))).branch, "<current-branch>", "no directory known: the original bucket");
});

test("dispatcher: gates join pending redirects in one block, once per Stop; the round stamp persists", async () => {
  const pushes = Array.from({ length: 5 }, (_, i) => R.exec([{ cmd: "git push origin fix", workdir: "/r" }], `p${i}`));
  const r = await rollout([R.turn("t"), ...pushes, R.say("Pushed fix; CI shows 41 passed.")]);
  try {
    const pending = [{ code: "read-path", reason: "[read-path] pending", answerNames: ["x.md"] }];
    const input = { hook_event_name: "Stop", transcript_path: r.file, stop_hook_active: false, last_assistant_message: "Pushed fix; CI shows 41 passed." };
    const first = decide(input, { pending });
    assert.equal(first.output.decision, "block");
    for (const part of ["[read-path] pending", "[evidence-gate]", "41 passed", "[round-guard] 5 pushes to `fix`"]) assert.ok(first.output.reason.includes(part), part);
    assert.deepEqual(first.log.map((e) => e.kind), ["stop-evidence", "stop-round"]);
    assert.deepEqual(first.state.roundGuardFired, ["fix:5"]);
    assert.equal(decide({ ...input, stop_hook_active: true }, first.state).output, null, "never blocks twice");
    const next = decide(input, first.state);
    assert.ok(!next.output.reason.includes("[round-guard]"), "the tier does not fire again");
  } finally { await rm(r.dir, { recursive: true, force: true }); }
});

test("dispatcher: a clean turn and a missing transcript both pass; a missing file is reported, not thrown (H4)", async () => {
  const r = await rollout([R.turn("t"), R.chunk("===== 41 passed in 2s =====\n", 0), R.say("The suite reports 41 passed.")]);
  try {
    assert.equal(decide({ hook_event_name: "Stop", transcript_path: r.file, stop_hook_active: false }, { pending: [] }).output, null);
    const gone = runStopGates({ transcript_path: path.join(r.dir, "missing.jsonl"), stop_hook_active: false }, {}, "/h");
    assert.deepEqual(gone.findings, []);
    assert.match(gone.errors[0], /cannot read/);
    assert.equal(decide({ hook_event_name: "Stop", stop_hook_active: false }, { pending: [] }).output, null, "no transcript_path: gates skipped");
  } finally { await rm(r.dir, { recursive: true, force: true }); }
});

test("main: Stop gate blocks are logged by kind; gate errors go to errors.log and the Stop still answers", async () => {
  const r = await rollout([R.turn("t"), R.say("Committed deadbeefc0ffee1 on the branch.")]);
  const state = await mkdtemp(path.join(os.tmpdir(), "guard-state-"));
  try {
    let out = "";
    main(JSON.stringify({ hook_event_name: "Stop", session_id: "s", transcript_path: r.file, stop_hook_active: false }), { ...process.env, SOL_LAB_GUARD_STATE: state }, (t) => { out += t; });
    assert.equal(JSON.parse(out).decision, "block");
    assert.match(await readFile(path.join(state, "denials.jsonl"), "utf8"), /"code":"evidence-gate","kind":"stop-evidence"/);
    out = "";
    main(JSON.stringify({ hook_event_name: "Stop", session_id: "s2", transcript_path: path.join(r.dir, "gone.jsonl"), stop_hook_active: false }), { ...process.env, SOL_LAB_GUARD_STATE: state }, (t) => { out += t; });
    assert.equal(out, "");
    assert.match(await readFile(path.join(state, "errors.log"), "utf8"), /stop gates: cannot read/);
  } finally { await rm(r.dir, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); }
});

test("gates: skipped entirely once the Stop hook is active, without reading the transcript", () => {
  const result = runStopGates({ transcript_path: "/nonexistent/rollout.jsonl", stop_hook_active: true }, {}, "/h");
  assert.deepEqual(result, { findings: [], errors: [] });
});

test("gates: one gate throwing is reported and does not lose the other gate's finding (H4)", async () => {
  const r = await rollout([R.turn("t"), R.say("Committed deadbeefc0ffee1 on the branch.")]);
  try {
    const boom = ["boom", () => { throw new Error("gate exploded"); }];
    const result = runStopGates({ transcript_path: r.file, stop_hook_active: false }, {}, "/h", [boom, ...STOP_GATES]);
    assert.deepEqual(result.findings.map((f) => f.code), ["evidence-gate"]);
    assert.match(result.errors[0], /^boom: Error: gate exploded/);
  } finally { await rm(r.dir, { recursive: true, force: true }); }
});

test("reader: a non-string text part is read as text, not a crash", async () => {
  const odd = JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c", output: [{ type: "input_text", text: 41 }, { type: "input_text", text: "passed fine" }] } });
  const r = await rollout([R.turn("t"), odd]);
  try { assert.deepEqual(readRollout(r.file).evidence, ["41", "passed fine"]); }
  finally { await rm(r.dir, { recursive: true, force: true }); }
});

// Revision 16: reproduced from the live stop-round eval's kept rollouts.
test("rounds (revision 16): pushes run from a loop are counted from the executed rows", async () => {
  const perFile = ["a", "b", "c", "d", "e"].map((f) => R.loop([`git add ${f}.txt`, `git commit -m "Fix ${f}"`, "git push origin feature"]));
  const executed = ["a", "b", "c", "d", "e"].flatMap((f) => [R.ran(`git add ${f}.txt`), R.ran(`git commit -m "Fix ${f}"`), R.ran("git push origin feature")]);
  const r = await rollout([R.turn("t"), ...perFile, ...executed, R.say("Done.")]);
  try {
    const finding = runStopGates({ transcript_path: r.file, stop_hook_active: false }, {}, "/h").findings.find((f) => f.code === "round-guard");
    assert.ok(finding, "5 executed pushes to one branch must reach the tier");
    assert.match(finding.reason, /5 pushes to `feature`/);
  } finally { await rm(r.dir, { recursive: true, force: true }); }
});

test("rounds (revision 16): text that mentions git push is not a push; only a command-position git push counts", async () => {
  const ledger = (f) => R.ran(`printf %s '${f}.txt fixed; git push origin feature: ok' >> .codex/SESSION_LEDGER.md`);
  const rows = ["a", "b", "c", "d"].flatMap((f) => [R.ran("git push origin feature"), ledger(f)]);
  const r = await rollout([R.turn("t"), ...rows, R.ran('echo "next: git push origin feature"'), R.ran("git log --grep='git push'")]);
  try {
    assert.equal(runStopGates({ transcript_path: r.file, stop_hook_active: false }, {}, "/h").findings.length, 0, "4 real pushes; the ledger, echo, and grep text are not pushes");
  } finally { await rm(r.dir, { recursive: true, force: true }); }
  assert.equal(roundVerdict(Array.from({ length: 5 }, () => ({ cmd: "cd /r/x && GIT_TRACE=0 git push origin feature", workdir: null }))).branch, "feature", "after && and a VAR= prefix");
  assert.equal(roundVerdict(Array.from({ length: 5 }, () => ({ cmd: "git -C /r/y push", workdir: "/elsewhere" }))).branch, "<current-branch>@/r/y", "-C sets the directory");
  assert.equal(roundVerdict(Array.from({ length: 5 }, () => ({ cmd: "git -C /r/y push origin HEAD", workdir: null }))).branch, "HEAD@/r/y");
  assert.deepEqual(pushesIn({ cmd: 'echo "say \\"hi; git push origin f\\" now" && git push origin real' }).map((p) => p.key), ["real"], "an escaped quote does not end the quoted text");
});

test("rounds (revision 16): executed rows replace source literals, never add to them; no rows means literals", async () => {
  // The script shows 3 push literals (the other 2 ran from a loop); 5 ran.
  const both = await rollout([R.turn("t"), ...Array.from({ length: 3 }, (_, i) => R.exec([{ cmd: "git push origin feature", workdir: "/lit" }], `p${i}`)), ...Array.from({ length: 5 }, () => R.ran("git push origin feature", "/r"))]);
  const literalsOnly = await rollout([R.turn("t"), ...Array.from({ length: 5 }, (_, i) => R.exec([{ cmd: "git push origin feature", workdir: "/r" }], `p${i}`))]);
  try {
    assert.match(runStopGates({ transcript_path: both.file, stop_hook_active: false }, {}, "/h").findings[0].reason, /5 pushes/, "the 5 executed, not the 3 literals and not 8");
    assert.match(runStopGates({ transcript_path: literalsOnly.file, stop_hook_active: false }, {}, "/h").findings[0].reason, /5 pushes/, "older rollouts still counted");
    const read = readRollout(both.file);
    assert.deepEqual(read.commands[0], { cmd: "git push origin feature", workdir: "/r" }, "argv script and file:// cwd decoded");
  } finally { await rm(both.dir, { recursive: true, force: true }); await rm(literalsOnly.dir, { recursive: true, force: true }); }
});
