import assert from "node:assert/strict";
import test from "node:test";
import { decide } from "../hooks/codex-guards/guard.mjs";
import { checkRediscovery, isBroadFind } from "../hooks/codex-guards/guards/rediscovery.mjs";

const home = "/home/u";
const config = { repos: ["/home/u/Desktop/Atlas", "/home/u/Desktop/doc_sum"] };

test("broad sweeps: ~, /, /media, /tmp, ~/Desktop, with no or a deep -maxdepth", () => {
  for (const command of ['find "$HOME" -type d -name billing', "find ${HOME} -name x", "find ~ -name .git -type d", "find / -name atlas", "find /media -maxdepth 4 -type d", "find /tmp -name x", `find ${home}/Desktop -maxdepth 5 -name .git`, "find ~/ -name y", "cd /x && find ~ -name z"]) {
    assert.equal(isBroadFind(command, home), true, command);
  }
});

test("not sweeps: a known repo path, shallow -maxdepth, other commands, unreadable shell", () => {
  for (const command of ["find /home/u/Desktop/Atlas -name '*.py'", "find ~ -maxdepth 2 -name .git", "find . -name x", "ls ~", "find $HOMEDIR -name x", "rg --files ~"]) {
    assert.equal(isBroadFind(command, home), false, command);
  }
});

test("context names the known repos; nothing without config", () => {
  const finding = checkRediscovery({ command: "find ~ -name .git", config, home });
  assert.equal(finding.action, "context");
  assert.match(finding.reason, /\/home\/u\/Desktop\/Atlas, \/home\/u\/Desktop\/doc_sum/);
  assert.equal(finding.pending, null);
  assert.equal(checkRediscovery({ command: "find ~ -name .git", config: {}, home }), null);
});

test("dispatcher: the hint comes before the sweep (PreToolUse context-only), the call is not denied, and Stop never blocks for it", () => {
  const pre = decide({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "find ~ -name .git" } }, { pending: [] }, { home, config });
  assert.deepEqual(Object.keys(pre.output.hookSpecificOutput).sort(), ["additionalContext", "hookEventName"], "no permissionDecision: the call runs");
  assert.match(pre.output.hookSpecificOutput.additionalContext, /rediscovery/);
  assert.equal(pre.redirectKind, "context");
  assert.deepEqual(pre.state.pending, []);
  assert.equal(decide({ hook_event_name: "Stop", stop_hook_active: false }, pre.state).output, null);
  const post = decide({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "find ~ -name .git" }, tool_response: "" }, { pending: [] }, { home, config });
  assert.equal(post.output, null, "no second hint after the sweep");
});

test("main logs a rediscovery hint as kind context, not after-failure", async () => {
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { main } = await import("../hooks/codex-guards/guard.mjs");
  const state = await mkdtemp(path.join(os.tmpdir(), "guard-state-"));
  try {
    await writeFile(path.join(state, "config.json"), JSON.stringify(config));
    main(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: { command: "find / -name .git" } }), { ...process.env, SOL_LAB_GUARD_STATE: state, HOME: home }, () => {});
    assert.match(await readFile(path.join(state, "denials.jsonl"), "utf8"), /"code":"rediscovery","kind":"context"/);
  } finally { await rm(state, { recursive: true, force: true }); }
});
