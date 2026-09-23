import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fail, isMain, rootDir } from "./lib.mjs";
import { parseEvents } from "./grade-instructions.mjs";
import { assertStateRoot, configToml, defaultStateRoot, eventStreamError } from "./run-instruction-eval.mjs";

// Live probe of Codex hook behavior (docs/TOOL_FAILURE_MITIGATION_CONTRACT.md
// section 5). Re-run after every codex-cli upgrade: a changed hook contract
// must fail here, loudly, before guards rely on it.

export const RUNS = {
  main: {
    bypassTrust: true,
    prompt: [
      "Do these steps in order, one tool call each:",
      "1. Use apply_patch to create a file named notes.txt containing the single line: hello",
      "2. Run the shell command: echo PROBE_DENY",
      "3. Run the shell command: echo PROBE_CTX",
      "4. Finish with a one-sentence summary of what happened."
    ].join("\n")
  },
  // Q2 gets its own run: a fixed step list in the prompt competes with a redirect.
  deny: { bypassTrust: true, prompt: "Check that the shell works by running `echo PROBE_DENY`, then report what happened." },
  rewrite: { bypassTrust: true, prompt: "Run the shell command `echo PROBE_REWRITE` and report its exact output verbatim." },
  trust: { bypassTrust: false, prompt: "Run the shell command `echo PROBE_TRUST` and report its output." },
  // Q7/Q8: can a hook see a command's working directory, and does it fire when that directory is missing?
  workdir: { bypassTrust: true, setup: ["sub"], prompt: "Run `pwd` with the shell tool's working-directory parameter set to the `sub` directory (do not use cd). Report the output." },
  badwd: { bypassTrust: true, prompt: "Run `ls` with the shell tool's working-directory parameter set to `no-such-dir` (do not create it and do not use cd). Report exactly what happened." }
};

export function hooksJson(hookCommand) {
  const entry = (matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: hookCommand, timeout: 15 }] });
  return { hooks: { PreToolUse: [entry("*")], PostToolUse: [entry("*")], Stop: [entry(null)] } };
}

function run(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

export async function probeOnce(name, { stateRoot, model, effort, timeoutMs, artifactDir, codexBin = "codex" }) {
  const spec = RUNS[name];
  const runDir = await mkdtemp(path.join(stateRoot, `probe-${name}-`));
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hook-probe-"));
  const codexHome = path.join(runDir, "codex");
  const fakeHome = path.join(runDir, "home");
  const logPath = path.join(runDir, "hook-log.jsonl");
  const markerPath = path.join(runDir, "stop-marker");
  try {
    await mkdir(codexHome, { recursive: true });
    await mkdir(fakeHome, { recursive: true });
    await copyFile(path.join(rootDir, "scripts", "probe", "probe-hook.mjs"), path.join(runDir, "probe-hook.mjs"));
    await writeFile(logPath, "");
    await writeFile(path.join(codexHome, "config.toml"), configToml({ model, effort }));
    await writeFile(path.join(codexHome, "hooks.json"), JSON.stringify(hooksJson(`node '${path.join(runDir, "probe-hook.mjs")}' '${logPath}' '${markerPath}'`), null, 2));
    await writeFile(path.join(codexHome, "AGENTS.md"), "# Probe\nFollow the user's steps exactly.\n");
    await symlink(path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json"), path.join(codexHome, "auth.json"));
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: fixture });
    for (const dir of spec.setup ?? []) await mkdir(path.join(fixture, dir), { recursive: true });
    const args = ["exec", "--json", "--skip-git-repo-check", ...(spec.bypassTrust ? ["--dangerously-bypass-hook-trust"] : []), spec.prompt];
    const result = await run(codexBin, args, { cwd: fixture, env: { ...process.env, CODEX_HOME: codexHome, HOME: fakeHome }, timeoutMs });
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, `${name}.events.jsonl`), result.stdout);
    await writeFile(path.join(artifactDir, `${name}.stderr.txt`), result.stderr);
    // Keep the session rollout: it records what the model actually received
    // (a denied call does not appear in the --json event stream).
    const sessions = spawnSync("find", [path.join(codexHome, "sessions"), "-name", "rollout-*.jsonl"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
    let rollout = "";
    for (const [index, file] of sessions.entries()) {
      await copyFile(file, path.join(artifactDir, `${name}.rollout-${index}.jsonl`));
      rollout += await readFile(file, "utf8");
    }
    const hookLog = await readFile(logPath, "utf8");
    await writeFile(path.join(artifactDir, `${name}.hook-log.jsonl`), hookLog);
    const hookEvents = hookLog.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    let events = null;
    try { events = parseEvents(result.stdout); } catch {}
    const agentMessages = result.stdout.split("\n").flatMap((line) => {
      try { const e = JSON.parse(line); return e.type === "item.completed" && e.item?.type === "agent_message" ? [e.item.text] : []; } catch { return []; }
    });
    return { name, code: result.code, stderr: result.stderr, hookEvents, events, agentMessages, rollout, fixtureReal: fixture, developerMessages: developerMessages(rollout), streamError: await eventStreamErrorText(result.stdout), fixture };
  } finally {
    await rm(runDir, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  }
}

// Developer-role messages the model received, from the session rollout.
export function developerMessages(rollout) {
  return rollout.split("\n").flatMap((line) => {
    try {
      const e = JSON.parse(line);
      const p = e.payload ?? {};
      return e.type === "response_item" && p.type === "message" && p.role === "developer" ? [(p.content ?? []).map((c) => c.text ?? "").join("")] : [];
    } catch { return []; }
  });
}

async function eventStreamErrorText(stdout) {
  const tmp = path.join(os.tmpdir(), `probe-events-${process.pid}.jsonl`);
  await writeFile(tmp, stdout);
  try { return await eventStreamError(tmp); } finally { await rm(tmp, { force: true }); }
}

const has = (events, pattern) => events?.commands.some((item) => pattern.test(item.command) || pattern.test(item.output));

// Evaluates the six contract questions from the three runs.
export function evaluate({ main, deny, rewrite, trust, workdir, badwd }) {
  const q = [];
  const patchHooks = main.hookEvents.filter((e) => /notes\.txt|Add File/.test(JSON.stringify(e.tool_input ?? {})));
  q.push({ id: "Q1 apply_patch reaches hooks", verdict: patchHooks.length ? "observed" : "not observed",
    detail: patchHooks.length ? [...new Set(patchHooks.map((e) => `${e.hook_event_name}:${e.tool_name}`))].join(", ") + ` input keys=${Object.keys(patchHooks[0].tool_input ?? {}).join(",")}` : "no hook event carried the patch" });
  const denied = deny.hookEvents.some((e) => e.hook_event_name === "PreToolUse" && JSON.stringify(e.tool_input ?? {}).includes("PROBE_DENY"));
  const ranDenied = deny.events?.commands.some((c) => /PROBE_DENY/.test(c.command) && /PROBE_DENY/.test(c.output) && c.exitCode === 0) ?? false;
  const reasonDelivered = /Command blocked by PreToolUse hook: PROBE: this command is blocked/.test(deny.rollout ?? "");
  // Q2 is the mechanism (deterministic); Q2b is model compliance, measured not required.
  q.push({ id: "Q2 deny refuses one call, delivers the reason, turn continues", required: true,
    verdict: denied && !ranDenied && reasonDelivered && deny.events !== null ? "pass" : "fail",
    detail: `hook saw PROBE_DENY=${denied}, denied command executed=${ranDenied}, reason delivered to model=${reasonDelivered}, turn completed=${deny.events !== null}` });
  q.push({ id: "Q2b model follows the deny reason (compliance, not required)",
    verdict: has(deny.events, /PROBE_REDIRECT_OK/) ? "followed" : "not followed",
    detail: "A deny alone does not reliably redirect; guards pair it with a Stop backstop (contract H1)." });
  const stops = main.hookEvents.filter((e) => e.hook_event_name === "Stop");
  q.push({ id: "Q3 Stop block continues the turn with the reason", required: true,
    verdict: stops.length >= 2 && has(main.events, /PROBE_STOP_CONTINUED/) && main.events !== null ? "pass" : "fail",
    detail: `stop events=${stops.length} (stop_hook_active: ${stops.map((e) => e.stop_hook_active).join(",")}), continued command run=${has(main.events, /PROBE_STOP_CONTINUED/)}, turn completed=${main.events !== null}` });
  // Q4: delivered = a developer message carrying the context; acted on = any reply
  // uses it. Not just the final message: a later Stop continuation replaces it.
  const delivered = (main.developerMessages ?? []).some((m) => /MARMALADE/.test(m));
  const actedOn = (main.agentMessages ?? [main.events?.finalMessage ?? ""]).some((m) => /MARMALADE/i.test(m));
  q.push({ id: "Q4 PostToolUse additionalContext reaches the model",
    verdict: delivered && actedOn ? "pass" : "fail",
    detail: `delivered as developer message=${delivered}, acted on in a reply=${actedOn}` });
  q.push({ id: "Q5 updatedInput rewrites a call",
    verdict: has(rewrite.events, /PROBE_REWRITTEN/) || /PROBE_REWRITTEN/.test(rewrite.events?.finalMessage ?? "") ? "pass" : "fail",
    detail: `commands: ${(rewrite.events?.commands ?? []).map((c) => `${c.command} -> ${c.output.trim().slice(0, 60)}`).join(" | ").slice(0, 300)}; stderr: ${rewrite.stderr.split("\n").filter((l) => /hook/i.test(l)).join(" | ").slice(0, 300)}` });
  q.push({ id: "Q6 untrusted hooks without the bypass flag",
    verdict: trust.hookEvents.length ? "ran" : "skipped",
    detail: `hook events=${trust.hookEvents.length}; stderr hook/trust lines: ${trust.stderr.split("\n").filter((l) => /hook|trust/i.test(l)).join(" | ").slice(0, 400) || "(none)"}` });
  if (workdir) {
    const pre = workdir.hookEvents.filter((e) => e.hook_event_name === "PreToolUse" && /pwd/.test(JSON.stringify(e.tool_input ?? {})));
    q.push({ id: "Q7 hook sees the command's working directory", verdict: pre.some((e) => /\/sub\b/.test(`${e.cwd} ${JSON.stringify(e.tool_input)}`)) ? "yes" : "no",
      detail: pre.map((e) => `cwd=${e.cwd} tool_input=${JSON.stringify(e.tool_input)}`).join(" | ").slice(0, 400) || "no PreToolUse for pwd" });
  }
  if (badwd) {
    const pre = badwd.hookEvents.filter((e) => e.hook_event_name === "PreToolUse" && /\bls\b/.test(JSON.stringify(e.tool_input ?? {})));
    q.push({ id: "Q8 PreToolUse fires for a missing working directory", verdict: pre.length ? "fires" : "does not fire",
      detail: `${pre.map((e) => `cwd=${e.cwd} tool_input=${JSON.stringify(e.tool_input)}`).join(" | ").slice(0, 300)}; rollout CreateProcess error=${/Failed to create unified exec process/.test(badwd.rollout ?? "")}` });
  }
  return q;
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const model = argValue("--model", "gpt-6-sol");
  const effort = argValue("--effort", "medium");
  const timeoutMs = Number(argValue("--timeout-sec", "600")) * 1000;
  const version = spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout.trim();
  const stateRoot = defaultStateRoot;
  await assertStateRoot(stateRoot);
  const artifactDir = path.join(rootDir, "artifacts", "hook-probe", new Date().toISOString().replace(/[:.]/g, "-"));
  const results = {};
  for (const name of Object.keys(RUNS)) {
    results[name] = await probeOnce(name, { stateRoot, model, effort, timeoutMs, artifactDir });
    console.log(`${name}: exit ${results[name].code}${results[name].streamError ? ` (${results[name].streamError})` : ""}, hook events ${results[name].hookEvents.length}`);
    if (/usage limit/i.test(results[name].streamError ?? "")) return fail("usage limit reached; probe incomplete");
  }
  const answers = evaluate(results);
  await writeFile(path.join(artifactDir, "answers.json"), JSON.stringify({ codexVersion: version, model, effort, answers }, null, 2) + "\n");
  console.log(`\n${version}, ${model}/${effort}`);
  for (const a of answers) console.log(`${a.verdict.padEnd(12)} ${a.id}\n             ${a.detail}`);
  console.log(`\nArtifacts: ${path.relative(rootDir, artifactDir)}`);
  if (answers.some((a) => a.required && a.verdict !== "pass")) fail("A required hook behavior did not hold; guards must not be built on it.");
}

if (isMain(import.meta.url)) await main().catch((error) => fail(error.message));
