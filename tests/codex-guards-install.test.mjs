import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rootDir } from "../scripts/lib.mjs";
import { install, mergeHooks } from "../scripts/install-codex-guards.mjs";
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
    stateDir: path.join(root, "state", "sol-lab")
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
