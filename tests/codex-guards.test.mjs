import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rootDir } from "../scripts/lib.mjs";
import { decide, main } from "../hooks/codex-guards/guard.mjs";
import { checkReadFailure, checkReadPath, satisfiesReadPath } from "../hooks/codex-guards/guards/read-path.mjs";
import { resolvePath, segments } from "../hooks/codex-guards/lib/shell.mjs";

async function fixtureTree() {
  const root = await mkdtemp(path.join(os.tmpdir(), "guard-"));
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "docs", "setup-guide.md"), "setup\n");
  await mkdir(path.join(root, "src", "deep"), { recursive: true });
  await writeFile(path.join(root, "src", "deep", "config.py"), "x = 1\n");
  return root;
}
const deny = (finding) => finding?.action === "deny";

test("shell reader: splits segments, strips quotes, refuses what it cannot read", () => {
  assert.deepEqual(segments(`cd "/a b" && sed -n '1,5p' x.md; cat y | wc -l`), [["cd", "/a b"], ["sed", "-n", "1,5p", "x.md"], ["cat", "y"], ["wc", "-l"]]);
  for (const unreadable of ["cat $(ls)", "cat `ls`", "cat <<EOF\nx\nEOF", "cat $HOME/x", "cat ${X}", "cat 'unterminated"]) {
    assert.equal(segments(unreadable), null, unreadable);
  }
  assert.equal(resolvePath("docs/x", null, "/home/u"), null, "relative path with an unknown base is not resolved");
  assert.equal(resolvePath("~/x", null, "/home/u"), "/home/u/x");
  assert.equal(resolvePath("../b/c", "/r/a", "/h"), "/r/b/c");
  assert.equal(resolvePath("/r/*.md", null, "/h"), null, "globs are not literal paths");
});

test("read-path trips on a missing absolute path and names the real file", async () => {
  const root = await fixtureTree();
  try {
    const finding = checkReadPath({ toolName: "Bash", command: `sed -n '1,40p' ${root}/docs/SETUP-GUIDE.md`, home: "/h" });
    assert.ok(deny(finding));
    assert.match(finding.reason, /does not exist/);
    assert.match(finding.reason, new RegExp(`${root}/docs/setup-guide\\.md`));
    assert.match(finding.reason, /instead of guessing/);
    assert.equal(finding.pending.dir, `${root}/docs`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("read-path allows existing paths (the near miss)", async () => {
  const root = await fixtureTree();
  try {
    for (const command of [`cat ${root}/docs/setup-guide.md`, `nl -ba ${root}/src/deep/config.py | sed -n '1,9p'`, `rg -n "x" ${root}/src`, `ls -la ${root}/docs`, `head -n 3 ${root}/docs/setup-guide.md`]) {
      assert.equal(checkReadPath({ toolName: "Bash", command, home: "/h" }), null, command);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("read-path skips what it cannot know: unknown base, globs, creating segments, sed -i, redirects, unreadable shell", async () => {
  const root = await fixtureTree();
  try {
    for (const command of [
      "cat docs/missing.md",                                  // relative, base unknown (probe Q7)
      `cat ${root}/docs/*.md`,                                 // glob
      `mkdir -p ${root}/new && cat ${root}/new/x.md`,          // created earlier in the same command
      `touch ${root}/n.md; cat ${root}/n.md`,
      `sed -i 's/a/b/' ${root}/missing.md`,                    // write, not read
      `cat ${root}/a.md > ${root}/b.md`,                       // redirect
      `cat $(echo ${root}/missing.md)`,                        // unreadable
      `cd ${root}/nope && cat x.md`                            // failing cd: stop checking
    ]) {
      assert.equal(checkReadPath({ toolName: "Bash", command, home: "/h" }), null, command);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("read-path uses a base the command states with cd", async () => {
  const root = await fixtureTree();
  try {
    assert.ok(deny(checkReadPath({ toolName: "Bash", command: `cd ${root} && cat docs/missing.md`, home: "/h" })));
    assert.equal(checkReadPath({ toolName: "Bash", command: `cd ${root} && cat docs/setup-guide.md`, home: "/h" }), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("read-path: rg and grep patterns are not paths; rg --files arguments are", async () => {
  const root = await fixtureTree();
  try {
    assert.equal(checkReadPath({ toolName: "Bash", command: `rg -n "no/such/thing" ${root}/src`, home: "/h" }), null);
    assert.equal(checkReadPath({ toolName: "Bash", command: `grep -rn needle ${root}/src`, home: "/h" }), null);
    assert.ok(deny(checkReadPath({ toolName: "Bash", command: `rg --files ${root}/nodir`, home: "/h" })));
    assert.ok(deny(checkReadPath({ toolName: "Bash", command: `rg -e pat ${root}/nodir`, home: "/h" })));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("read-path: apply_patch Update/Delete of a missing absolute path trips; Add and relative paths do not", async () => {
  const root = await fixtureTree();
  try {
    assert.ok(deny(checkReadPath({ toolName: "apply_patch", command: `*** Begin Patch\n*** Update File: ${root}/docs/SETUP.md\n@@\n-a\n+b\n*** End Patch`, home: "/h" })));
    assert.equal(checkReadPath({ toolName: "apply_patch", command: `*** Begin Patch\n*** Add File: ${root}/docs/new.md\n+x\n*** End Patch`, home: "/h" }), null);
    assert.equal(checkReadPath({ toolName: "apply_patch", command: "*** Begin Patch\n*** Update File: docs/no-such-guard-fixture.md\n*** End Patch", home: "/h" }), null);
    assert.equal(checkReadPath({ toolName: "apply_patch", command: `*** Begin Patch\n*** Update File: ${root}/docs/setup-guide.md\n@@\n-setup\n+s\n*** End Patch`, home: "/h" }), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("after-failure: a read command's own error line yields context + a pending redirect for relative and absolute paths", async () => {
  const root = await fixtureTree();
  try {
    const rel = checkReadFailure({ response: "cat: docs/SETUP.md: No such file or directory\n", cwd: root, home: "/h" });
    assert.equal(rel.action, "context");
    assert.match(rel.reason, /searched from the session directory/);
    assert.match(rel.reason, /setup-guide\.md/, "the directory listing names the real file");
    assert.equal(rel.pending.dir, `${root}/docs`);
    const sed = checkReadFailure({ response: `sed: can't read ${root}/docs/x.md: No such file or directory`, cwd: "/elsewhere", home: "/h" });
    assert.ok(sed);
    assert.doesNotMatch(sed.reason, /searched from the session directory/, "an absolute path needs no base caveat");
    assert.ok(checkReadFailure({ response: `ls: cannot access '${root}/nope': No such file or directory`, cwd: root, home: "/h" }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("after-failure near misses: no error, a non-read command's error, a quoted mention, and a relative path with no cwd", () => {
  assert.equal(checkReadFailure({ response: "all good", cwd: "/r", home: "/h" }), null);
  assert.equal(checkReadFailure({ response: "python3: can't open file 'x.py': [Errno 2] No such file or directory", cwd: "/r", home: "/h" }), null);
  assert.equal(checkReadFailure({ response: "The log said cat: x: No such file or directory", cwd: "/r", home: "/h" }), null);
  assert.equal(checkReadFailure({ response: "mv: x.md: No such file or directory", cwd: "/r", home: "/h" }), null, "same shape, not a read command");
  assert.equal(checkReadFailure({ response: "cat: x.md: No such file or directory", cwd: undefined, home: "/h" }), null);
});

test("dispatcher: PostToolUse after a failed read returns additionalContext, records one pending redirect, and Stop enforces it", async () => {
  const root = await fixtureTree();
  try {
    const input = { hook_event_name: "PostToolUse", tool_name: "Bash", cwd: root, tool_input: { command: "cat docs/SETUP.md" }, tool_response: "cat: docs/SETUP.md: No such file or directory\n" };
    const first = decide(input, { pending: [] });
    assert.equal(first.output.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(first.output.hookSpecificOutput.additionalContext, /\[read-path\]/);
    assert.equal(first.redirected, "read-path");
    assert.equal(decide(input, first.state).state.pending.length, 1, "the same directory is not recorded twice");
    const stop = decide({ hook_event_name: "Stop", stop_hook_active: false }, first.state);
    assert.equal(stop.output.decision, "block");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a relative-path redirect is satisfied by the model's relative follow-up read, so Stop does not fire again", async () => {
  const root = await fixtureTree();
  try {
    const post = decide({ hook_event_name: "PostToolUse", tool_name: "Bash", cwd: root, tool_input: { command: "cat docs/SETUP.md" }, tool_response: "cat: docs/SETUP.md: No such file or directory\n" }, { pending: [] });
    const followUp = decide({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: root, tool_input: { command: "cat docs/setup-guide.md" } }, post.state);
    assert.deepEqual(followUp.state.pending, [], "the relative read inside the suggested directory resolves the redirect");
    assert.equal(decide({ hook_event_name: "Stop", stop_hook_active: false }, followUp.state).output, null);
    const unrelated = decide({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: root, tool_input: { command: "cat src/deep/config.py" } }, post.state);
    assert.equal(unrelated.state.pending.length, 1, "a read elsewhere does not resolve it");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a missing file directly in the session cwd is resolved by reading a suggested name", async () => {
  const root = await fixtureTree();
  try {
    await writeFile(path.join(root, "README.md"), "hi\n");
    const post = decide({ hook_event_name: "PostToolUse", tool_name: "Bash", cwd: root, tool_input: { command: "cat READ-ME.md" }, tool_response: "cat: READ-ME.md: No such file or directory\n" }, { pending: [] });
    assert.deepEqual(decide({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: root, tool_input: { command: "cat README.md" } }, post.state).state.pending, []);
    assert.equal(decide({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: root, tool_input: { command: "echo hello" } }, post.state).state.pending.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a pending redirect is satisfied by a later call inside the suggested directory or naming a candidate", () => {
  const pending = { code: "read-path", dir: "/r/docs", candidates: ["/r/docs/setup-guide.md"] };
  assert.equal(satisfiesReadPath(pending, "cat /r/docs/setup-guide.md"), true);
  assert.equal(satisfiesReadPath(pending, "ls /r/docs"), true);
  assert.equal(satisfiesReadPath(pending, "echo done"), false);
});

// Dispatcher: H1 (deny + Stop backstop), shape, satisfaction, loop safety.

const guardDeny = { code: "t", check: ({ command }) => (command.includes("BAD") ? { action: "deny", code: "t", reason: "[t] use GOOD", pending: { code: "t" } } : null), satisfied: (_p, command) => command.includes("GOOD") };
const guardRewrite = { code: "r", check: ({ command }) => (command === "psql" ? { action: "rewrite", command: "psql -h localhost" } : null) };

test("deny output has the probe-verified PreToolUse shape and records a pending redirect", () => {
  const { output, state } = decide({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "BAD" } }, { pending: [] }, { guards: [guardDeny] });
  assert.deepEqual(output, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "[t] use GOOD" } });
  assert.equal(state.pending.length, 1);
});

test("rewrite output is allow + updatedInput with the new command, keeping other input fields", () => {
  const { output } = decide({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "psql", other: 1 } }, { pending: [] }, { guards: [guardRewrite] });
  assert.deepEqual(output.hookSpecificOutput, { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "psql -h localhost", other: 1 } });
});

test("Stop blocks once while a redirect is pending, never twice, and a satisfying call clears it first", () => {
  const pending = [{ code: "t", reason: "[t] use GOOD" }];
  const blocked = decide({ hook_event_name: "Stop", stop_hook_active: false }, { pending }, { guards: [guardDeny] });
  assert.equal(blocked.output.decision, "block");
  assert.match(blocked.output.reason, /\[t\] use GOOD/);
  assert.deepEqual(blocked.state.pending, []);
  const again = decide({ hook_event_name: "Stop", stop_hook_active: true }, { pending }, { guards: [guardDeny] });
  assert.equal(again.output, null, "stop_hook_active: never block twice");
  const cleared = decide({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "GOOD" } }, { pending }, { guards: [guardDeny] });
  assert.deepEqual(cleared.state.pending, []);
  assert.equal(decide({ hook_event_name: "Stop", stop_hook_active: false }, cleared.state, { guards: [guardDeny] }).output, null);
});

test("an allowed call and an unrelated event produce no output", () => {
  assert.equal(decide({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }, { pending: [] }, { guards: [guardDeny] }).output, null);
  assert.equal(decide({ hook_event_name: "PostToolUse", tool_name: "Bash" }, { pending: [] }, { guards: [guardDeny] }).output, null);
});

test("main fails open: bad input writes nothing to stdout and logs the error; a good call writes a heartbeat", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-state-"));
  try {
    const env = { ...process.env, SOL_LAB_GUARD_STATE: dir };
    let written = "";
    main("{not json", env, (text) => { written += text; });
    assert.equal(written, "");
    assert.match(await readFile(path.join(dir, "errors.log"), "utf8"), /SyntaxError|JSON/);
    main(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } }), env, (text) => { written += text; });
    assert.equal(written, "");
    const heartbeat = JSON.parse(await readFile(path.join(dir, "heartbeat.json"), "utf8"));
    assert.equal(heartbeat.session, "s1");
    assert.ok((await readdir(dir)).includes("session-s1.json"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("every denial is appended to denials.jsonl with its guard code", async () => {
  const root = await fixtureTree();
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-state-"));
  try {
    const env = { ...process.env, SOL_LAB_GUARD_STATE: dir };
    main(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: { command: `cat ${root}/docs/nope.md` } }), env, () => {});
    main(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: { command: "ls" } }), env, () => {});
    const lines = (await readFile(path.join(dir, "denials.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.code), ["read-path"]);
  } finally { await rm(root, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true }); }
});

test("the installed entry point runs as a hook: stdin in, deny JSON out, exit 0", async () => {
  const root = await fixtureTree();
  const state = await mkdtemp(path.join(os.tmpdir(), "guard-state-"));
  try {
    const input = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: { command: `cat ${root}/docs/nope.md` } });
    const result = spawnSync(process.execPath, [path.join(rootDir, "hooks", "codex-guards", "guard.mjs")], { input, encoding: "utf8", env: { ...process.env, SOL_LAB_GUARD_STATE: state } });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
    const broken = spawnSync(process.execPath, [path.join(rootDir, "hooks", "codex-guards", "guard.mjs")], { input: "garbage", encoding: "utf8", env: { ...process.env, SOL_LAB_GUARD_STATE: state } });
    assert.equal(broken.status, 0);
    assert.equal(broken.stdout, "");
  } finally { await rm(root, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); }
});
