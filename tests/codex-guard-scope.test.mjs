import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decide, main } from "../hooks/codex-guards/guard.mjs";
import { answeredScope, checkScope, dirtyFiles, globToRegExp, loadScope, scopeBaseline, scopeDrift } from "../hooks/codex-guards/guards/scope.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });

// Real repos: `work` is the declared root, `other` is a second git repo, and
// `loose` is a directory in no repo (scratch space).
async function fixture({ scope } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "scope-guard-"));
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const loose = path.join(root, "loose");
  for (const repo of [work, other]) {
    await mkdir(path.join(repo, "src", "api"), { recursive: true });
    git(repo, "init", "-q");
    await writeFile(path.join(repo, "README.md"), "readme\n");
    await writeFile(path.join(repo, "src", "api", "handler.js"), "export {}\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  }
  await mkdir(loose, { recursive: true });
  await mkdir(path.join(work, ".codex"), { recursive: true });
  const declared = scope ?? { roots: [work], allow: ["src/api/**"], pr: 42, goal: "fix the handler" };
  await writeFile(path.join(work, ".codex", "scope.json"), typeof declared === "string" ? declared : JSON.stringify(declared));
  return { root, work, other, loose };
}

const patch = (...targets) => `*** Begin Patch\n${targets.map((t) => `*** Update File: ${t}\n@@\n-a\n+b`).join("\n")}\n*** End Patch`;

test("globs: ** spans directories, * and ? stay within one segment", () => {
  assert.equal(globToRegExp("src/api/**").test("src/api/handler.js"), true);
  assert.equal(globToRegExp("src/api/**").test("src/api/v1/deep/x.js"), true);
  assert.equal(globToRegExp("src/api/**").test("src/apix/handler.js"), false);
  assert.equal(globToRegExp("**/*.md").test("README.md"), true);
  assert.equal(globToRegExp("**/*.md").test("docs/a/b.md"), true);
  assert.equal(globToRegExp("src/*.js").test("src/a/b.js"), false);
  assert.equal(globToRegExp("file?.txt").test("file1.txt"), true);
  assert.equal(globToRegExp("file?.txt").test("file12.txt"), false);
  assert.equal(globToRegExp("a.b").test("axb"), false, "dots are literal");
});

test("apply_patch outside the allow globs is denied, naming the PR, goal, and allowed globs", async () => {
  const f = await fixture();
  try {
    const finding = checkScope({ toolName: "apply_patch", command: patch("README.md"), cwd: f.work, home: "/h" });
    assert.equal(finding.action, "deny");
    assert.match(finding.reason, /PR #42: fix the handler/);
    assert.match(finding.reason, /Allowed: src\/api\/\*\*/);
    assert.deepEqual(finding.pending.files, ["README.md"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("apply_patch: every target is checked, including Add, Delete, Move to, and absolute paths", async () => {
  const f = await fixture();
  try {
    const mixed = `*** Begin Patch\n*** Update File: src/api/handler.js\n@@\n-a\n+b\n*** Add File: docs/new.md\n+x\n*** End Patch`;
    assert.equal(checkScope({ toolName: "apply_patch", command: mixed, cwd: f.work }).action, "deny", "an allowed first target must not hide a later one");
    assert.equal(checkScope({ toolName: "apply_patch", command: `*** Begin Patch\n*** Delete File: README.md\n*** End Patch`, cwd: f.work }).action, "deny");
    const move = `*** Begin Patch\n*** Update File: src/api/handler.js\n*** Move to: lib/handler.js\n@@\n-a\n+b\n*** End Patch`;
    assert.equal(checkScope({ toolName: "apply_patch", command: move, cwd: f.work }).action, "deny", "moving out of scope");
    assert.equal(checkScope({ toolName: "apply_patch", command: patch(path.join(f.work, "README.md")), cwd: f.work }).action, "deny", "absolute path inside the root");
    assert.equal(checkScope({ toolName: "apply_patch", command: patch(path.join(f.other, "src/api/handler.js")), cwd: f.work }).action, "deny", "another git repo is out of scope even where the glob would match");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("apply_patch near misses: allowed files, scratch outside any repo, and no scope file", async () => {
  const f = await fixture();
  try {
    assert.equal(checkScope({ toolName: "apply_patch", command: patch("src/api/handler.js", "src/api/v2/new.js"), cwd: f.work }), null);
    assert.equal(checkScope({ toolName: "apply_patch", command: patch(path.join(f.loose, "pr-body.md")), cwd: f.work }), null, "a file in no git repo is scratch");
    assert.equal(checkScope({ toolName: "apply_patch", command: patch("README.md"), cwd: f.other }), null, "no scope.json = inactive");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("cd: into another git repo is denied; into the root, a subdir, or scratch is not", async () => {
  const f = await fixture();
  try {
    const out = checkScope({ toolName: "Bash", command: `cd ${f.other} && bash scripts/open_pr.sh`, cwd: f.work, home: "/h" });
    assert.equal(out.action, "deny");
    assert.match(out.reason, new RegExp(f.other));
    assert.equal(checkScope({ toolName: "Bash", command: `cd ${path.join(f.other, "src")} && ls`, cwd: f.work }).action, "deny", "a subdirectory of another repo");
    for (const command of [`cd ${f.work} && ls`, `cd ${path.join(f.work, "src")} && ls`, `cd ${f.loose} && ls`, "ls -la", `cd ${f.work} && cd src && ls`]) {
      assert.equal(checkScope({ toolName: "Bash", command, cwd: f.work, home: "/h" }), null, command);
    }
    assert.equal(checkScope({ toolName: "Bash", command: `cd ${f.work} && cd ../other && ls`, cwd: f.work, home: "/h" }).action, "deny", "a relative cd resolved from the previous cd");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("malformed or incomplete scope.json makes the guard inactive and reports why", async () => {
  for (const scope of ["{not json", JSON.stringify({ roots: ["relative/path"], allow: ["**"] }), JSON.stringify({ roots: [], allow: ["**"] }), JSON.stringify({ roots: ["/x"] }), JSON.stringify({ roots: ["/x"], allow: [""] })]) {
    const f = await fixture({ scope });
    try {
      assert.ok(loadScope(f.work).error, scope);
      assert.equal(checkScope({ toolName: "apply_patch", command: patch("README.md"), cwd: f.work }), null, scope);
      assert.equal(scopeBaseline(f.work), null, scope);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("drift: only files newly dirty since the baseline and outside the globs are reported", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.work, "README.md"), "dirty before the session\n");
    const baseline = scopeBaseline(f.work);
    assert.deepEqual(baseline[f.work].sort(), [".codex/scope.json", "README.md"]);
    assert.equal(scopeDrift({ cwd: f.work, baseline }), null, "pre-existing dirt is not drift");
    await writeFile(path.join(f.work, "src", "api", "handler.js"), "changed\n");
    assert.equal(scopeDrift({ cwd: f.work, baseline }), null, "in-scope change");
    await mkdir(path.join(f.work, "docs"), { recursive: true });
    await writeFile(path.join(f.work, "docs", "notes with space.md"), "new\n");
    const drift = scopeDrift({ cwd: f.work, baseline });
    assert.deepEqual(drift.files, ["docs/notes with space.md"], "untracked, unquoted path with a space");
    assert.match(drift.reason, /PR #42/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("drift: a rename reports its destination, not its source", async () => {
  const f = await fixture();
  try {
    const baseline = scopeBaseline(f.work);
    git(f.work, "mv", "src/api/handler.js", "lib.js");
    assert.deepEqual(dirtyFiles(f.work).sort(), [".codex/scope.json", "lib.js"]);
    assert.deepEqual(scopeDrift({ cwd: f.work, baseline }).files, ["lib.js"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("answered: the final message must name every out-of-scope file", () => {
  const pending = { code: "scope", files: ["README.md", "docs/notes.md"] };
  assert.equal(answeredScope(pending, "I left README.md and docs/notes.md out of this PR."), true);
  assert.equal(answeredScope(pending, "I left README.md alone."), false);
  assert.equal(answeredScope(pending, "Done."), false);
  assert.equal(answeredScope(pending, undefined), false);
});

test("dispatcher: deny + Stop backstop; Stop drift blocks once and is not re-reported next turn", async () => {
  const f = await fixture();
  try {
    const denied = decide({ hook_event_name: "PreToolUse", tool_name: "apply_patch", cwd: f.work, tool_input: { command: patch("README.md") } }, { pending: [], scopeBaseline: scopeBaseline(f.work) });
    assert.equal(denied.output.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(denied.state.scopeBaseline, "baseline survives a PreToolUse");
    const stop = decide({ hook_event_name: "Stop", cwd: f.work, stop_hook_active: false, last_assistant_message: "Done." }, denied.state);
    assert.equal(stop.output.decision, "block");
    assert.equal(decide({ hook_event_name: "Stop", cwd: f.work, stop_hook_active: false, last_assistant_message: "README.md is outside PR #42, so I left it." }, denied.state).output, null, "answered");

    // Drift written some other way (a shell redirect the guard cannot see).
    await writeFile(path.join(f.work, "CHANGELOG.md"), "x\n");
    const first = decide({ hook_event_name: "Stop", cwd: f.work, stop_hook_active: false, last_assistant_message: "Done." }, stop.state);
    assert.equal(first.output.decision, "block");
    assert.match(first.output.reason, /CHANGELOG\.md/);
    assert.equal(first.redirectKind, "stop-drift");
    const again = decide({ hook_event_name: "Stop", cwd: f.work, stop_hook_active: false, last_assistant_message: "Done." }, first.state);
    assert.equal(again.output, null, "the same drift never blocks a later turn");
    const active = decide({ hook_event_name: "Stop", cwd: f.work, stop_hook_active: true, last_assistant_message: "Done." }, stop.state);
    assert.equal(active.output, null, "never blocks twice in one stop");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("main: baseline taken at the first event where scope is active; malformed scope logged once", async () => {
  const f = await fixture();
  const state = await mkdtemp(path.join(os.tmpdir(), "guard-state-"));
  const env = { ...process.env, SOL_LAB_GUARD_STATE: state };
  try {
    await writeFile(path.join(f.work, "README.md"), "dirty before\n");
    main(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", cwd: f.work, tool_input: { command: "ls" } }), env, () => {});
    let out = "";
    main(JSON.stringify({ hook_event_name: "Stop", session_id: "s", cwd: f.work, stop_hook_active: false, last_assistant_message: "Done." }), env, (t) => { out += t; });
    assert.equal(out, "", "pre-session dirt does not block");
    await writeFile(path.join(f.work, "Makefile"), "x\n");
    main(JSON.stringify({ hook_event_name: "Stop", session_id: "s", cwd: f.work, stop_hook_active: false, last_assistant_message: "Done." }), env, (t) => { out += t; });
    assert.match(JSON.parse(out).reason, /Makefile/);
    assert.match(await readFile(path.join(state, "denials.jsonl"), "utf8"), /"code":"scope","kind":"stop-drift"/);

    await mkdir(path.join(f.other, ".codex"), { recursive: true });
    await writeFile(path.join(f.other, ".codex", "scope.json"), "{bad");
    for (let i = 0; i < 3; i += 1) main(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "t", tool_name: "Bash", cwd: f.other, tool_input: { command: "ls" } }), env, () => {});
    const log = await readFile(path.join(state, "errors.log"), "utf8");
    assert.equal(log.match(/scope: scope\.json is not valid JSON/g).length, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); }
});

test("dispatcher: drift the final message already names is acknowledged and never blocks a later turn", async () => {
  const f = await fixture();
  try {
    const start = { pending: [], scopeBaseline: scopeBaseline(f.work) };
    await writeFile(path.join(f.work, "CHANGELOG.md"), "x\n");
    const answered = decide({ hook_event_name: "Stop", cwd: f.work, stop_hook_active: false, last_assistant_message: "I also touched CHANGELOG.md; it is needed for the release note." }, start);
    assert.equal(answered.output, null);
    const later = decide({ hook_event_name: "Stop", cwd: f.work, stop_hook_active: false, last_assistant_message: "Done." }, answered.state);
    assert.equal(later.output, null, "already-acknowledged drift");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("main: a scope.json written mid-session is baselined at its first active event, then drift blocks", async () => {
  const f = await fixture();
  const state = await mkdtemp(path.join(os.tmpdir(), "guard-state-"));
  const env = { ...process.env, SOL_LAB_GUARD_STATE: state };
  try {
    await rm(path.join(f.work, ".codex"), { recursive: true, force: true });
    main(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "m", tool_name: "Bash", cwd: f.work, tool_input: { command: "ls" } }), env, () => {});
    await mkdir(path.join(f.work, ".codex"), { recursive: true });
    await writeFile(path.join(f.work, ".codex", "scope.json"), JSON.stringify({ roots: [f.work], allow: ["src/api/**"] }));
    main(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "m", tool_name: "Bash", cwd: f.work, tool_input: { command: "ls" } }), env, () => {});
    await writeFile(path.join(f.work, "Makefile"), "x\n");
    let out = "";
    main(JSON.stringify({ hook_event_name: "Stop", session_id: "m", cwd: f.work, stop_hook_active: false, last_assistant_message: "Done." }), env, (t) => { out += t; });
    assert.match(JSON.parse(out).reason, /Makefile/);
    assert.doesNotMatch(JSON.parse(out).reason, /scope\.json/, "scope.json itself was dirty at activation, so it is baseline");
  } finally { await rm(f.root, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); }
});
