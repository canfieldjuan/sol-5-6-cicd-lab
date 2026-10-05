import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decideClaude, main, responseText } from "../hooks/codex-guards/claude-seam.mjs";
import { pushText } from "../hooks/codex-guards/guards/seam.mjs";
import { rootDir } from "../scripts/lib.mjs";

// Contract 5.4, revision 20: the seam redirect in Claude Code, through the
// dispatcher's decide() with no other guards.

const event = (hook_event_name, command, extra = {}) => ({ hook_event_name, session_id: "s1", cwd: "/r", tool_name: "Bash", tool_input: { command }, ...extra });
const context = (result) => result.output?.hookSpecificOutput?.additionalContext ?? null;
function run(events) {
  let state = { pending: [] };
  return events.map((input) => { const result = decideClaude(input, state); state = result.state; return result; });
}

test("responseText: Claude's stdout/stderr object, {type, text}, a string, an array, and nothing", () => {
  assert.equal(responseText({ stdout: "out", stderr: "err", interrupted: false, isImage: false }), "out\nerr");
  assert.equal(responseText({ stdout: "", stderr: "", interrupted: false }), "");
  assert.equal(responseText({ type: "text", text: "body" }), "body");
  assert.equal(responseText("plain"), "plain");
  assert.equal(responseText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(responseText(undefined), "");
  assert.equal(responseText(null), "");
});

test("R2 fires on the second push to a branch, as PreToolUse context", () => {
  const [first, second] = run([event("PreToolUse", "git push -u origin fix"), event("PreToolUse", "git push origin fix")]);
  assert.equal(first.output, null);
  assert.equal(second.output.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(context(second), pushText(2, "`fix`"));
  assert.equal(second.output.hookSpecificOutput.permissionDecision, undefined, "context only: the push still runs");
  assert.deepEqual(second.log, [{ code: "seam-redirect", kind: "push" }]);
});

test("R1 reads review text from stdout; no R1 when stdout and stderr are empty", () => {
  const review = { stdout: "reviewer (COMMENTED): the limit is duplicated in src/returns.js", stderr: "", interrupted: false, isImage: false };
  const [read] = run([event("PostToolUse", "gh pr view 12 --comments", { tool_response: review })]);
  assert.match(context(read), /^\[seam-redirect\] Review feedback on PR #12\./);
  assert.equal(read.output.hookSpecificOutput.hookEventName, "PostToolUse");
  const [empty, later] = run([
    event("PostToolUse", "gh pr view 12 --comments", { tool_response: { stdout: "", stderr: "", interrupted: false } }),
    event("PostToolUse", "gh pr view 12 --comments", { tool_response: review })
  ]);
  assert.equal(empty.output, null, "no review text: no redirect and no stamp used");
  assert.ok(context(later), "the same epoch still fires once review text arrives");
});

test("other tools and other events give no output and leave the state alone", () => {
  const state = { pending: [], seam: { epochs: { "/r": 1 } } };
  for (const input of [
    { ...event("PreToolUse", "git push origin fix"), tool_name: "Edit" },
    { ...event("PostToolUse", "gh pr view 1 --comments"), tool_name: "WebFetch", tool_response: "reviewer: x" },
    { hook_event_name: "Stop", session_id: "s1", stop_hook_active: false },
    { hook_event_name: "UserPromptSubmit", prompt: "git push origin fix" }
  ]) {
    const result = decideClaude(input, state);
    assert.equal(result.output, null, JSON.stringify(input));
    assert.equal(result.state, state);
  }
});

test("main persists the session state, logs each redirect, and fails open on malformed input", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "claude-seam-"));
  const env = { ...process.env, SOL_LAB_CLAUDE_SEAM_STATE: dir };
  try {
    const out = [];
    main(JSON.stringify(event("PreToolUse", "git push origin fix")), env, (text) => out.push(text));
    main(JSON.stringify(event("PreToolUse", "git push origin fix")), env, (text) => out.push(text));
    assert.equal(out.length, 1);
    assert.equal(JSON.parse(out[0]).hookSpecificOutput.additionalContext, pushText(2, "`fix`"));
    const session = JSON.parse(await readFile(path.join(dir, "session-s1.json"), "utf8"));
    assert.deepEqual(session.seam.epochs, { "/r": 2 });
    const log = (await readFile(path.join(dir, "redirects.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(log.map(({ session, code, kind }) => ({ session, code, kind })), [{ session: "s1", code: "seam-redirect", kind: "push" }]);
    assert.equal(JSON.parse(await readFile(path.join(dir, "heartbeat.json"), "utf8")).session, "s1");
    const none = [];
    main("{broken", env, (text) => none.push(text));
    assert.deepEqual(none, []);
    assert.match(await readFile(path.join(dir, "errors.log"), "utf8"), /SyntaxError/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the script exits 0 and prints the hook JSON when run as Claude Code runs it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "claude-seam-cli-"));
  try {
    const script = path.join(rootDir, "hooks", "codex-guards", "claude-seam.mjs");
    const env = { ...process.env, SOL_LAB_CLAUDE_SEAM_STATE: dir };
    const once = (input) => spawnSync(process.execPath, [script], { input, env, encoding: "utf8" });
    assert.equal(once(JSON.stringify(event("PreToolUse", "git push origin fix"))).stdout, "");
    const second = once(JSON.stringify(event("PreToolUse", "git push origin fix")));
    assert.equal(second.status, 0);
    assert.equal(JSON.parse(second.stdout).hookSpecificOutput.hookEventName, "PreToolUse");
    const broken = once("not json");
    assert.equal(broken.status, 0);
    assert.equal(broken.stdout, "");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
