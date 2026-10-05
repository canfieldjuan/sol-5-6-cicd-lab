import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main as claudeMain } from "../hooks/codex-guards/claude-seam.mjs";
import { withSessionLock } from "../hooks/codex-guards/lib/session-lock.mjs";
import { rootDir } from "../scripts/lib.mjs";

// Contract 5.4, revision 20: one session's read, decide, and write is
// serialized across concurrent hook processes, with a bounded wait.

const tmp = (prefix) => mkdtemp(path.join(os.tmpdir(), prefix));

test("withSessionLock runs the step and removes the lock, also when the step throws", async () => {
  const dir = await tmp("lock-");
  try {
    const file = path.join(dir, "session-s.json");
    assert.equal(withSessionLock(file, () => { assert.ok(existsSync(`${file}.lock`)); return 7; }), 7);
    assert.ok(!existsSync(`${file}.lock`));
    assert.throws(() => withSessionLock(file, () => { throw new Error("boom"); }), /boom/);
    assert.ok(!existsSync(`${file}.lock`));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a fresh lock held past the wait skips the step; a lock older than the stale bound is removed", async () => {
  const dir = await tmp("lock-");
  try {
    const file = path.join(dir, "session-s.json");
    writeFileSync(`${file}.lock`, "");
    let ran = false;
    assert.throws(() => withSessionLock(file, () => { ran = true; }, { wait: 50 }), /held past 50 ms; event skipped/);
    assert.equal(ran, false);
    assert.ok(existsSync(`${file}.lock`), "a live holder's lock is left alone");
    const old = (Date.now() - 20000) / 1000;
    utimesSync(`${file}.lock`, old, old);
    assert.equal(withSessionLock(file, () => "ran", { wait: 50 }), "ran");
    assert.ok(!existsSync(`${file}.lock`));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function hook(script, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout }));
    child.stdin.end(JSON.stringify(input));
  });
}

const N = 16;
for (const [name, script, stateVar, eventFor] of [
  ["claude-seam.mjs", "claude-seam.mjs", "SOL_LAB_CLAUDE_SEAM_STATE", (i) => ({ hook_event_name: "PreToolUse", session_id: "s", cwd: "/r", tool_name: "Bash", tool_input: { command: `git push origin b${i}` } })],
  ["guard.mjs", "guard.mjs", "SOL_LAB_GUARD_STATE", (i) => ({ hook_event_name: "PreToolUse", session_id: "s", cwd: "/r", tool_name: "Bash", tool_input: { command: `git push origin b${i}` } })]
]) {
  test(`${name}: ${N} concurrent hook processes on one session lose no update`, async () => {
    const dir = await tmp("lock-race-");
    try {
      const env = { ...process.env, [stateVar]: dir, XDG_STATE_HOME: dir };
      const results = await Promise.all(Array.from({ length: N }, (_, i) => hook(path.join(rootDir, "hooks", "codex-guards", script), eventFor(i), env)));
      assert.ok(results.every((result) => result.status === 0));
      const state = JSON.parse(await readFile(path.join(dir, "session-s.json"), "utf8"));
      assert.equal(Object.keys(state.seam.pushes).length, N, "every push counted");
      assert.deepEqual(state.seam.epochs, { "/r": N });
      assert.ok(!existsSync(path.join(dir, "session-s.json.lock")));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test("the Claude entry point fails open when the lock stays held: no output, no state change, a logged skip", async () => {
  const dir = await tmp("lock-skip-");
  try {
    const env = { ...process.env, SOL_LAB_CLAUDE_SEAM_STATE: dir };
    const file = path.join(dir, "session-s.json");
    writeFileSync(file, JSON.stringify({ pending: [], seam: { epochs: { "/r": 1 }, pushes: { "/r|fix": 1 }, own: [], rounds: {}, stamps: {}, escalated: {} } }));
    writeFileSync(`${file}.lock`, "");
    const out = [];
    claudeMain(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: "/r", tool_name: "Bash", tool_input: { command: "git push origin fix" } }), env, (text) => out.push(text));
    assert.deepEqual(out, [], "the redirect this push would get is skipped, not half-applied");
    assert.equal(JSON.parse(await readFile(file, "utf8")).seam.epochs["/r"], 1);
    assert.match(await readFile(path.join(dir, "errors.log"), "utf8"), /held past 2000 ms; event skipped/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
