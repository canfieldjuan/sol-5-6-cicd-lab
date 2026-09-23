import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decide, main } from "../hooks/codex-guards/guard.mjs";
import { checkWrongRepoFailure, checkWrongRepoScript, satisfiesWrongRepoScript } from "../hooks/codex-guards/guards/wrong-repo-script.mjs";
import { guardConfig } from "../scripts/install-codex-guards.mjs";

async function repos() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wrong-repo-"));
  const atlas = path.join(root, "atlas");
  const app = path.join(root, "app");
  await mkdir(path.join(atlas, "scripts"), { recursive: true });
  await writeFile(path.join(atlas, "scripts", "open_pr.sh"), "#!/bin/sh\n");
  await mkdir(path.join(app, "scripts"), { recursive: true });
  await writeFile(path.join(app, "scripts", "release.sh"), "#!/bin/sh\n");
  return { root, atlas, app, config: { repos: [atlas, app] } };
}

test("2a: a script missing in the stated base is denied, naming the repo that has it and this repo's scripts", async () => {
  const r = await repos();
  try {
    const finding = checkWrongRepoScript({ command: `cd ${r.app} && bash scripts/open_pr.sh /tmp/body.md`, home: "/h", config: r.config });
    assert.equal(finding.action, "deny");
    assert.match(finding.reason, new RegExp(`It exists in: ${r.atlas}`));
    assert.match(finding.reason, /release\.sh/);
    assert.match(finding.reason, /do not run it against/);
  } finally { await rm(r.root, { recursive: true, force: true }); }
});

test("2a near misses: script present, base unknown, a creating segment first, unreadable shell", async () => {
  const r = await repos();
  try {
    for (const command of [
      `cd ${r.atlas} && bash scripts/open_pr.sh x`,           // exists here
      "bash scripts/open_pr.sh x",                            // base unknown (workdir invisible)
      `cd ${r.app} && git checkout other && bash scripts/open_pr.sh`, // an earlier segment may create it
      `cd ${r.app} && bash scripts/$NAME`                     // unreadable
    ]) {
      assert.equal(checkWrongRepoScript({ command, home: "/h", config: r.config }), null, command);
    }
    assert.equal(checkWrongRepoScript({ command: `cd ${r.app} && ./scripts/open_pr.sh`, home: "/h", config: r.config }).action, "deny", "./scripts form");
  } finally { await rm(r.root, { recursive: true, force: true }); }
});

test("2b: the shell's own error line after the run yields context naming the repo that has the script", async () => {
  const r = await repos();
  try {
    for (const response of ["bash: scripts/open_pr.sh: No such file or directory\n", "/bin/bash: line 1: ./scripts/open_pr.sh: No such file or directory"]) {
      const finding = checkWrongRepoFailure({ response, config: r.config });
      assert.equal(finding.action, "context", response);
      assert.match(finding.reason, new RegExp(r.atlas));
      assert.deepEqual(finding.pending.repos, [r.atlas]);
    }
    const unknown = checkWrongRepoFailure({ response: "bash: scripts/nowhere.sh: No such file or directory", config: r.config });
    assert.match(unknown.reason, /No known repo has it/);
  } finally { await rm(r.root, { recursive: true, force: true }); }
});

test("2b near misses: no error, a non-shell error, a mid-line mention, and no config", () => {
  assert.equal(checkWrongRepoFailure({ response: "ok", config: {} }), null);
  assert.equal(checkWrongRepoFailure({ response: "cat: scripts/x.sh: No such file or directory", config: {} }), null);
  assert.equal(checkWrongRepoFailure({ response: "the docs say bash: scripts/x.sh: No such file or directory", config: {} }), null);
  const bare = checkWrongRepoFailure({ response: "bash: scripts/x.sh: No such file or directory", config: {} });
  assert.deepEqual(bare.pending.repos, [], "no config still redirects, without repo suggestions");
});

test("the redirect is satisfied by naming the repo that has the script, or by no longer running it", () => {
  const pending = { code: "wrong-repo-script", script: "scripts/open_pr.sh", repos: ["/r/atlas"] };
  assert.equal(satisfiesWrongRepoScript(pending, "cd /r/atlas && bash scripts/open_pr.sh"), true);
  assert.equal(satisfiesWrongRepoScript(pending, "cat README.md"), true);
  assert.equal(satisfiesWrongRepoScript(pending, "bash scripts/open_pr.sh --retry"), false);
});

test("dispatcher: config reaches the guard; PostToolUse redirect, then Stop backstop, recorded once", async () => {
  const r = await repos();
  try {
    const input = { hook_event_name: "PostToolUse", tool_name: "Bash", cwd: r.app, tool_input: { command: "bash scripts/open_pr.sh" }, tool_response: "bash: scripts/open_pr.sh: No such file or directory" };
    const first = decide(input, { pending: [] }, { config: r.config });
    assert.match(first.output.hookSpecificOutput.additionalContext, /wrong-repo-script/);
    assert.equal(decide(input, first.state, { config: r.config }).state.pending.length, 1, "same script not recorded twice");
    assert.equal(decide({ hook_event_name: "Stop", stop_hook_active: false }, first.state).output.decision, "block");
  } finally { await rm(r.root, { recursive: true, force: true }); }
});

test("main loads config.json from the state dir", async () => {
  const r = await repos();
  const state = await mkdtemp(path.join(os.tmpdir(), "guard-state-"));
  try {
    await writeFile(path.join(state, "config.json"), JSON.stringify(r.config));
    let out = "";
    main(JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s", tool_name: "Bash", cwd: r.app, tool_input: { command: "bash scripts/open_pr.sh" }, tool_response: "bash: scripts/open_pr.sh: No such file or directory" }), { ...process.env, SOL_LAB_GUARD_STATE: state }, (text) => { out += text; });
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, new RegExp(r.atlas));
    assert.match(await readFile(path.join(state, "denials.jsonl"), "utf8"), /"code":"wrong-repo-script","kind":"after-failure"/);
  } finally { await rm(r.root, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); }
});

test("installer config: repos resolved to absolute paths; db parsed and validated", () => {
  assert.deepEqual(guardConfig({ repos: ["/a", "/b"] }), { repos: ["/a", "/b"] });
  assert.deepEqual(guardConfig({ db: "localhost:5433:atlas:atlas" }).db, { host: "localhost", port: 5433, user: "atlas", database: "atlas" });
  assert.throws(() => guardConfig({ db: "localhost:abc:atlas:atlas" }), /host:port:user:db/);
  assert.throws(() => guardConfig({ db: "localhost:5433" }), /host:port:user:db/);
  assert.deepEqual(guardConfig({}), {});
});

test("revision 9: Stop does not block when the final message already acts on the redirect; giving up still blocks", async () => {
  const wrongRepo = { code: "wrong-repo-script", script: "scripts/open_pr.sh", repos: ["/r/atlas"], reason: "[wrong-repo-script] ..." };
  const answered = decide({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "The app repo has no `scripts/open_pr.sh`, so no PR was opened." }, { pending: [wrongRepo] });
  assert.equal(answered.output, null, "the live runs' correct answer must not trigger a redundant step");
  const vague = decide({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Done." }, { pending: [wrongRepo] });
  assert.equal(vague.output.decision, "block");
  const claimed = decide({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Ran scripts/open_pr.sh and opened the PR." }, { pending: [wrongRepo] });
  assert.equal(claimed.output.decision, "block", "naming the script without saying it is missing is not an answer");

  const readPath = { code: "read-path", dir: "/r/docs", candidates: ["/r/docs/setup-guide.md"], answerNames: ["setup-guide.md"], reason: "[read-path] ..." };
  const gaveUp = decide({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "I couldn't read docs/SETUP.md, so I can't tell you the token." }, { pending: [readPath] });
  assert.equal(gaveUp.output.decision, "block", "giving up is not acting on the redirect");
  const used = decide({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "The token is in docs/setup-guide.md: amber." }, { pending: [readPath] });
  assert.equal(used.output, null);
});
