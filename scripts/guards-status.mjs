import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fail, isMain } from "./lib.mjs";
import { defaultPaths } from "./install-codex-guards.mjs";

// Activation check for the Codex guards (contract H7). Codex silently skips
// untrusted hooks, so "installed" is not "active": the guards are active only
// when a real session has run them after the install (heartbeat).

const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
async function json(file) { try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; } }

export async function status({ installDir, hooksJson, stateDir }) {
  const state = await json(path.join(stateDir, "guards-install.json"));
  if (!state) return { status: "not installed", detail: "no install record" };
  for (const [rel, hash] of Object.entries(state.files ?? {})) {
    let content;
    try { content = await readFile(path.join(installDir, rel)); } catch { return { status: "broken", detail: `${rel} is missing from ${installDir}` }; }
    if (sha(content) !== hash) return { status: "broken", detail: `${rel} differs from the installed version` };
  }
  if (state.wrapper) {
    let content;
    try { content = await readFile(state.wrapper.path); } catch { return { status: "broken", detail: `${state.wrapper.path} is missing` }; }
    if (sha(content) !== state.wrapper.sha) return { status: "broken", detail: `${state.wrapper.path} differs from the installed version` };
  }
  const hooks = await json(hooksJson);
  const registered = ["PreToolUse", "PostToolUse", "Stop"].every((event) => (hooks?.hooks?.[event] ?? []).some((group) => (group.hooks ?? []).some((hook) => hook.command === state.guardCommand)));
  if (!registered) return { status: "broken", detail: `${hooksJson} lacks the guard entries` };
  const heartbeat = await json(path.join(stateDir, "guards", "heartbeat.json"));
  if (!heartbeat || !(heartbeat.at > state.installedAt)) {
    return { status: "installed, not active", detail: "no guard run since install: trust the lab-guards hooks in the Codex TUI (/hooks), then run any command" };
  }
  return { status: "active", detail: `last run ${heartbeat.at} (${heartbeat.event}, session ${heartbeat.session})` };
}

async function main() {
  const result = await status(defaultPaths());
  console.log(`${result.status}: ${result.detail}`);
  if (result.status !== "active") fail("guards are not active");
}

if (isMain(import.meta.url)) await main().catch((error) => fail(error.message));
