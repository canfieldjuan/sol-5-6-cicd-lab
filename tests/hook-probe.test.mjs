import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rootDir } from "../scripts/lib.mjs";
import { evaluate, hooksJson } from "../scripts/probe-codex-hooks.mjs";

const cmd = (command, output, exitCode = 0) => ({ command, output, exitCode });
const run = ({ hookEvents = [], commands = [], finalMessage = "", stderr = "", agentMessages, developerMessages = [], rollout = "" } = {}) =>
  ({ hookEvents, events: { commands, finalMessage }, stderr, agentMessages: agentMessages ?? [finalMessage], developerMessages, rollout });

const goodMain = () => run({
  hookEvents: [
    { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { patch: "*** Add File: notes.txt" } },
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo PROBE_DENY" } },
    { hook_event_name: "Stop", stop_hook_active: false },
    { hook_event_name: "Stop", stop_hook_active: true }
  ],
  commands: [cmd("echo PROBE_REDIRECT_OK", "PROBE_REDIRECT_OK\n"), cmd("echo PROBE_CTX", "PROBE_CTX\n"), cmd("echo PROBE_STOP_CONTINUED", "PROBE_STOP_CONTINUED\n")],
  finalMessage: "Done. MARMALADE.",
  developerMessages: ["PROBE: include the word MARMALADE in your final answer."],
  rollout: "Script error:\nCommand blocked by PreToolUse hook: PROBE: this command is blocked. Run `echo PROBE_REDIRECT_OK` instead."
});
const byId = (answers, prefix) => answers.find((a) => a.id.startsWith(prefix));

test("all six questions pass or are observed on a run where every behavior holds", () => {
  const answers = evaluate({ main: goodMain(), deny: goodMain(), rewrite: run({ commands: [cmd("echo PROBE_REWRITTEN", "PROBE_REWRITTEN\n")] }), trust: run() });
  assert.equal(byId(answers, "Q1").verdict, "observed");
  assert.match(byId(answers, "Q1").detail, /PreToolUse:apply_patch/);
  for (const id of ["Q2 ", "Q3", "Q4", "Q5"]) assert.equal(byId(answers, id).verdict, "pass", id);
  assert.equal(byId(answers, "Q2b").verdict, "followed");
  assert.equal(byId(answers, "Q6").verdict, "skipped");
});

test("Q2 fails when the denied command ran or the reason never reached the model; not following it is Q2b, not a failure", () => {
  const ran = goodMain();
  ran.events.commands.push(cmd("echo PROBE_DENY", "PROBE_DENY\n"));
  assert.equal(byId(evaluate({ main: goodMain(), deny: ran, rewrite: run(), trust: run() }), "Q2 ").verdict, "fail");
  const silent = goodMain();
  silent.rollout = "";
  assert.equal(byId(evaluate({ main: goodMain(), deny: silent, rewrite: run(), trust: run() }), "Q2 ").verdict, "fail");
  const ignored = goodMain();
  ignored.events.commands = ignored.events.commands.filter((c) => !/REDIRECT/.test(c.command));
  const answers = evaluate({ main: goodMain(), deny: ignored, rewrite: run(), trust: run() });
  assert.equal(byId(answers, "Q2 ").verdict, "pass");
  assert.equal(byId(answers, "Q2b").verdict, "not followed");
  assert.equal(byId(answers, "Q2b").required, undefined);
});

test("Q2 and Q3 fail when the turn did not complete (no event stream)", () => {
  const main = goodMain();
  main.events = null;
  const answers = evaluate({ main, deny: main, rewrite: run(), trust: run() });
  assert.equal(byId(answers, "Q2 ").verdict, "fail");
  assert.equal(byId(answers, "Q3").verdict, "fail");
});

test("Q3 fails with a single Stop event (the block did not continue the turn)", () => {
  const main = goodMain();
  main.hookEvents = main.hookEvents.filter((e, i) => !(e.hook_event_name === "Stop" && i === 3));
  assert.equal(byId(evaluate({ main, deny: goodMain(), rewrite: run(), trust: run() }), "Q3").verdict, "fail");
});

test("Q1 reports not observed when no hook saw the patch; Q4/Q5 fail without their markers; Q6 reports ran", () => {
  const main = goodMain();
  main.hookEvents = main.hookEvents.slice(1);
  main.events.finalMessage = "Done.";
  main.agentMessages = ["Done."];
  const answers = evaluate({ main, deny: goodMain(), rewrite: run({ commands: [cmd("echo PROBE_REWRITE", "PROBE_REWRITE\n")] }), trust: run({ hookEvents: [{ hook_event_name: "PreToolUse" }] }) });
  assert.equal(byId(answers, "Q1").verdict, "not observed");
  assert.equal(byId(answers, "Q4").verdict, "fail");
  assert.equal(byId(answers, "Q5").verdict, "fail");
  assert.equal(byId(answers, "Q6").verdict, "ran");
});

test("Q4 passes when the context was delivered and used in an earlier reply, even if a Stop continuation replaced the final message", () => {
  const main = goodMain();
  main.events.finalMessage = "PROBE_STOP_CONTINUED succeeded.";
  main.agentMessages = ["Summary. MARMALADE.", "PROBE_STOP_CONTINUED succeeded."];
  assert.equal(byId(evaluate({ main, deny: goodMain(), rewrite: run(), trust: run() }), "Q4").verdict, "pass");
  const undelivered = goodMain();
  undelivered.developerMessages = [];
  assert.equal(byId(evaluate({ main: undelivered, deny: goodMain(), rewrite: run(), trust: run() }), "Q4").verdict, "fail");
});

test("developerMessages reads only developer-role messages from a rollout", async () => {
  const { developerMessages } = await import("../scripts/probe-codex-hooks.mjs");
  const rollout = [
    { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "CTX" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "USER" }] } }
  ].map((e) => JSON.stringify(e)).join("\n");
  assert.deepEqual(developerMessages(rollout), ["CTX"]);
});

test("Q7/Q8 report whether a hook can see the working directory and whether it fires for a missing one", () => {
  const blind = { hookEvents: [{ hook_event_name: "PreToolUse", cwd: "/tmp/fx", tool_input: { command: "pwd" } }], rollout: "" };
  const sees = { hookEvents: [{ hook_event_name: "PreToolUse", cwd: "/tmp/fx/sub", tool_input: { command: "pwd" } }], rollout: "" };
  const badwd = { hookEvents: [{ hook_event_name: "PreToolUse", cwd: "/tmp/fx", tool_input: { command: "ls" } }], rollout: "Failed to create unified exec process" };
  const base = { main: goodMain(), deny: goodMain(), rewrite: run(), trust: run() };
  assert.equal(byId(evaluate({ ...base, workdir: blind, badwd }), "Q7").verdict, "no");
  assert.equal(byId(evaluate({ ...base, workdir: sees, badwd }), "Q7").verdict, "yes");
  assert.equal(byId(evaluate({ ...base, workdir: blind, badwd }), "Q8").verdict, "fires");
  assert.equal(byId(evaluate({ ...base, workdir: blind, badwd: { hookEvents: [], rollout: "" } }), "Q8").verdict, "does not fire");
  assert.equal(byId(evaluate(base), "Q7"), undefined);
});

test("Q9 reports whether PostToolUse carries a failing command's error text", () => {
  const base = { main: goodMain(), deny: goodMain(), rewrite: run(), trust: run() };
  const withText = { hookEvents: [{ hook_event_name: "PostToolUse", tool_input: { command: "cat no-such-file.txt" }, tool_response: "cat: no-such-file.txt: No such file or directory" }] };
  assert.equal(byId(evaluate({ ...base, postfail: withText }), "Q9").verdict, "yes");
  assert.equal(byId(evaluate({ ...base, postfail: { hookEvents: [] } }), "Q9").verdict, "no");
});

test("the probe config registers PreToolUse and PostToolUse for every tool, and Stop", () => {
  const config = hooksJson("node hook.mjs");
  assert.equal(config.hooks.PreToolUse[0].matcher, "*");
  assert.equal(config.hooks.PostToolUse[0].matcher, "*");
  assert.equal(config.hooks.Stop[0].matcher, undefined);
  assert.equal(config.hooks.Stop[0].hooks[0].command, "node hook.mjs");
});

test("the probe hook denies, rewrites, injects context, and blocks Stop only once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "probe-hook-"));
  try {
    const log = path.join(dir, "log.jsonl");
    const marker = path.join(dir, "marker");
    const hook = (input) => JSON.parse(spawnSync(process.execPath, [path.join(rootDir, "scripts", "probe", "probe-hook.mjs"), log, marker],
      { input: JSON.stringify(input), encoding: "utf8" }).stdout || "{}");
    assert.equal(hook({ hook_event_name: "PreToolUse", tool_input: { command: "echo PROBE_DENY" } }).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(hook({ hook_event_name: "PreToolUse", tool_input: { command: "echo PROBE_REWRITE" } }).hookSpecificOutput.updatedInput.command, "echo PROBE_REWRITTEN");
    assert.match(hook({ hook_event_name: "PostToolUse", tool_response: "PROBE_CTX" }).hookSpecificOutput.additionalContext, /MARMALADE/);
    assert.deepEqual(hook({ hook_event_name: "PreToolUse", tool_input: { command: "ls" } }), {});
    assert.equal(hook({ hook_event_name: "Stop", stop_hook_active: false }).decision, "block");
    assert.deepEqual(hook({ hook_event_name: "Stop", stop_hook_active: false }), {});
    assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 6);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
