import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rootDir } from "../scripts/lib.mjs";
import { CLAUDE_EVENTS, install, mergeHooks } from "../scripts/install-codex-guards.mjs";
import { status } from "../scripts/guards-status.mjs";

const EXISTING = {
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bash git-guard.sh" }] }],
    Stop: [{ hooks: [{ type: "command", command: "bash evidence-gate.sh" }] }, { hooks: [{ type: "command", command: "bash round-guard.sh" }] }],
    SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "python3 digest.py" }] }]
  }
};

async function fixture(hooks = EXISTING) {
  const root = await mkdtemp(path.join(os.tmpdir(), "guard-install-"));
  const paths = {
    source: path.join(rootDir, "hooks", "codex-guards"),
    installDir: path.join(root, "codex", "hooks", "lab-guards"),
    hooksJson: path.join(root, "codex", "hooks.json"),
    stateDir: path.join(root, "state", "sol-lab"),
    binDir: path.join(root, "bin")
  };
  await mkdir(path.join(root, "codex"), { recursive: true });
  if (hooks !== null) await writeFile(paths.hooksJson, JSON.stringify(hooks, null, 2));
  return { root, paths };
}

test("merge appends guard entries and keeps every existing entry at its index (trust is positional)", () => {
  const merged = mergeHooks(EXISTING, "node '/x/lab-guards/guard.mjs'");
  assert.deepEqual(merged.hooks.PreToolUse[0], EXISTING.hooks.PreToolUse[0]);
  assert.deepEqual(merged.hooks.Stop[0], EXISTING.hooks.Stop[0]);
  assert.deepEqual(merged.hooks.Stop[1], EXISTING.hooks.Stop[1]);
  assert.deepEqual(merged.hooks.SessionStart, EXISTING.hooks.SessionStart);
  assert.equal(merged.hooks.PreToolUse[1].hooks[0].command, "node '/x/lab-guards/guard.mjs'");
  assert.equal(merged.hooks.PreToolUse[1].matcher, "*");
  assert.equal(merged.hooks.Stop[2].matcher, undefined);
  assert.deepEqual(mergeHooks(merged, "node '/x/lab-guards/guard.mjs'"), merged, "idempotent");
});

test("dry run writes nothing", async () => {
  const { root, paths } = await fixture();
  try {
    const result = await install(paths);
    assert.equal(result.applied, false);
    assert.equal(result.hooksChanged, true);
    assert.deepEqual(JSON.parse(await readFile(paths.hooksJson, "utf8")), EXISTING);
    await assert.rejects(readdir(paths.installDir));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("apply installs the files, backs up hooks.json, appends entries, and is idempotent", async () => {
  const { root, paths } = await fixture();
  try {
    const first = await install({ ...paths, apply: true });
    assert.ok(first.backup);
    assert.deepEqual(JSON.parse(await readFile(first.backup, "utf8")), EXISTING);
    const hooks = JSON.parse(await readFile(paths.hooksJson, "utf8"));
    assert.equal(hooks.hooks.PreToolUse.length, 2);
    assert.equal(hooks.hooks.Stop.length, 3);
    assert.ok((await readdir(paths.installDir)).includes("guard.mjs"));
    const second = await install({ ...paths, apply: true });
    assert.equal(second.hooksChanged, false);
    assert.equal(second.backup, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("apply creates hooks.json when absent", async () => {
  const { root, paths } = await fixture(null);
  try {
    await install({ ...paths, apply: true });
    const hooks = JSON.parse(await readFile(paths.hooksJson, "utf8"));
    assert.equal(hooks.hooks.PreToolUse.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses an invalid hooks.json, a hand-edited installed file, and a foreign file in the install dir", async () => {
  const bad = await fixture();
  try {
    await writeFile(bad.paths.hooksJson, "{broken");
    await assert.rejects(install({ ...bad.paths, apply: true }), /not valid JSON/);
  } finally { await rm(bad.root, { recursive: true, force: true }); }

  const edited = await fixture();
  try {
    await install({ ...edited.paths, apply: true });
    await writeFile(path.join(edited.paths.installDir, "guard.mjs"), "// hand edit\n");
    await assert.rejects(install({ ...edited.paths, apply: true }), /edited by hand/);
    assert.equal(await readFile(path.join(edited.paths.installDir, "guard.mjs"), "utf8"), "// hand edit\n");
  } finally { await rm(edited.root, { recursive: true, force: true }); }

  const foreign = await fixture();
  try {
    await mkdir(foreign.paths.installDir, { recursive: true });
    await writeFile(path.join(foreign.paths.installDir, "guard.mjs"), "// someone else's\n");
    await assert.rejects(install({ ...foreign.paths, apply: true }), /not installed by this script/);
  } finally { await rm(foreign.root, { recursive: true, force: true }); }
});

test("status: not installed, then installed-not-active, then active only after a heartbeat newer than the install", async () => {
  const { root, paths } = await fixture();
  try {
    assert.equal((await status(paths)).status, "not installed");
    await install({ ...paths, apply: true, now: new Date("2026-09-22T10:00:00Z") });
    assert.equal((await status(paths)).status, "installed, not active");
    await mkdir(path.join(paths.stateDir, "guards"), { recursive: true });
    await writeFile(path.join(paths.stateDir, "guards", "heartbeat.json"), JSON.stringify({ at: "2026-09-22T09:00:00.000Z", event: "PreToolUse", session: "old" }));
    assert.equal((await status(paths)).status, "installed, not active", "a heartbeat from before the install does not count");
    await writeFile(path.join(paths.stateDir, "guards", "heartbeat.json"), JSON.stringify({ at: "2026-09-22T11:00:00.000Z", event: "PreToolUse", session: "s" }));
    assert.equal((await status(paths)).status, "active");
    await writeFile(path.join(paths.installDir, "guard.mjs"), "// drift\n");
    assert.equal((await status(paths)).status, "broken");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("codex-pr-status wrapper: installed executable on PATH dir, points at the installed helper, refuses a foreign file, status checks it", async () => {
  const { root, paths } = await fixture();
  try {
    await install({ ...paths, apply: true });
    const wrapper = await readFile(path.join(paths.binDir, "codex-pr-status"), "utf8");
    assert.match(wrapper, new RegExp(`exec node '${paths.installDir}/bin/codex-pr-status.mjs' "\\$@"`));
    const { statSync } = await import("node:fs");
    assert.ok(statSync(path.join(paths.binDir, "codex-pr-status")).mode & 0o111, "executable");
    await install({ ...paths, apply: true }); // idempotent: its own wrapper is fine
    await writeFile(path.join(paths.binDir, "codex-pr-status"), "#!/bin/sh\necho someone else\n");
    await assert.rejects(install({ ...paths, apply: true }), /was not written by this script/);
    assert.equal((await status(paths)).status, "broken");
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Contract 5.4, revision 20: the --claude target.
const CLAUDE_SETTINGS = {
  permissions: { allow: ["Bash(git status)"] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bash \"$HOME/.claude/hooks/git-guard.sh\"", timeout: 15 }] }],
    Stop: [{ hooks: [{ type: "command", command: "bash \"$HOME/.claude/hooks/evidence-gate.sh\"", timeout: 30 }] }]
  },
  model: "opus"
};

async function claudeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-install-"));
  const paths = {
    source: path.join(rootDir, "hooks", "codex-guards"),
    installDir: path.join(root, "claude", "hooks", "lab-guards"),
    hooksJson: path.join(root, "claude", "settings.json"),
    stateDir: path.join(root, "state", "sol-lab"),
    binDir: null,
    target: "claude"
  };
  await mkdir(path.join(root, "claude"), { recursive: true });
  await writeFile(paths.hooksJson, JSON.stringify(CLAUDE_SETTINGS, null, 2) + "\n");
  return { root, paths };
}

test("claude target: appends exactly the two Bash seam entries, keeps every other key and entry, backs up, and is idempotent", async () => {
  const { root, paths } = await claudeFixture();
  try {
    const dry = await install(paths);
    assert.equal(dry.applied, false);
    assert.equal(dry.hooksChanged, true);
    const first = await install({ ...paths, apply: true });
    assert.equal(path.basename(first.backup).split(".").slice(0, 2).join("."), "settings.json");
    assert.deepEqual(JSON.parse(await readFile(first.backup, "utf8")), CLAUDE_SETTINGS);
    const settings = JSON.parse(await readFile(paths.hooksJson, "utf8"));
    assert.deepEqual(Object.keys(settings), Object.keys(CLAUDE_SETTINGS), "key order kept");
    assert.deepEqual(settings.permissions, CLAUDE_SETTINGS.permissions);
    assert.equal(settings.model, "opus");
    assert.deepEqual(settings.hooks.PreToolUse[0], CLAUDE_SETTINGS.hooks.PreToolUse[0]);
    assert.deepEqual(settings.hooks.Stop, CLAUDE_SETTINGS.hooks.Stop, "no Stop entry for Claude");
    const command = `node '${path.join(paths.installDir, "claude-seam.mjs")}'`;
    for (const { event } of CLAUDE_EVENTS) {
      const added = settings.hooks[event].at(-1);
      assert.deepEqual(added, { matcher: "Bash", hooks: [{ type: "command", command, timeout: 10 }] }, event);
    }
    assert.equal(settings.hooks.PreToolUse.length, 2);
    assert.equal(settings.hooks.PostToolUse.length, 1);
    assert.ok((await readdir(paths.installDir)).includes("claude-seam.mjs"));
    assert.ok((await readdir(paths.stateDir)).includes("claude-seam-install.json"));
    assert.ok(!(await readdir(paths.stateDir)).includes("guards-install.json"), "the Codex manifest is separate");
    const second = await install({ ...paths, apply: true });
    assert.equal(second.hooksChanged, false);
    assert.equal(second.backup, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("claude status: installed-not-active until a Claude heartbeat newer than the install; a Codex heartbeat does not count", async () => {
  const { root, paths } = await claudeFixture();
  try {
    assert.equal((await status(paths)).status, "not installed");
    await install({ ...paths, apply: true, now: new Date("2026-10-05T10:00:00Z") });
    const pending = await status(paths);
    assert.equal(pending.status, "installed, not active");
    assert.match(pending.detail, /new Claude Code session/);
    await mkdir(path.join(paths.stateDir, "guards"), { recursive: true });
    await writeFile(path.join(paths.stateDir, "guards", "heartbeat.json"), JSON.stringify({ at: "2026-10-05T11:00:00.000Z" }));
    assert.equal((await status(paths)).status, "installed, not active", "the Codex heartbeat is not Claude's");
    await mkdir(path.join(paths.stateDir, "claude-seam"), { recursive: true });
    await writeFile(path.join(paths.stateDir, "claude-seam", "heartbeat.json"), JSON.stringify({ at: "2026-10-05T11:00:00.000Z", event: "PreToolUse", session: "s" }));
    assert.equal((await status(paths)).status, "active");
  } finally { await rm(root, { recursive: true, force: true }); }
});
