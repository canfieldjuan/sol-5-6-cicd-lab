import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rootDir, walkFiles } from "../scripts/lib.mjs";
import { sha256 } from "../scripts/check-instructions.mjs";
import { claimedValues, gradeFiles, gradeRun, parseEvents } from "../scripts/grade-instructions.mjs";
import { assertStateRoot, buildArmAgents, configToml, runOne, summarize } from "../scripts/run-instruction-eval.mjs";
import { validateScenario } from "../scripts/validate-scenarios.mjs";

const scenariosDir = path.join(rootDir, "scenarios", "instructions");
const scenarioIds = async () => (await walkFiles(scenariosDir))
  .filter((file) => path.basename(file) === "scenario.json").map((file) => path.basename(path.dirname(file)));
const done = { type: "turn.completed", usage: { input_tokens: 10 } };
const lines = (...events) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const cmd = (command, output = "", exitCode = 0) => ({ type: "item.completed", item: { type: "command_execution", command, aggregated_output: output, exit_code: exitCode } });
const msg = (text) => ({ type: "item.completed", item: { type: "agent_message", text } });

// B2: every grader passes its good transcript and fails its violating one.
test("every instruction scenario grader is proven: pass*.jsonl fixtures pass, fail*.jsonl fixtures fail", async () => {
  const ids = await scenarioIds();
  assert.ok(ids.length >= 11);
  for (const id of ids) {
    const dir = path.join(scenariosDir, id);
    const fixtures = (await readdir(path.join(dir, "fixtures"))).filter((name) => name.endsWith(".jsonl"));
    assert.ok(fixtures.includes("pass.jsonl") && fixtures.includes("fail.jsonl"), id);
    for (const name of fixtures) {
      const logFile = path.join(dir, "fixtures", name.replace(/\.jsonl$/, ".gh.log"));
      let log = null;
      try { await readFile(logFile); log = logFile; } catch {}
      const result = await gradeFiles(dir, path.join(dir, "fixtures", name), log);
      if (name.startsWith("pass")) assert.equal(result.pass, true, `${id}/${name}: ${result.failures.join("; ")}`);
      else assert.equal(result.pass, false, `${id}/${name} unexpectedly passed`);
    }
  }
});

test("a read-only git apply --check is not a forbidden apply", async () => {
  const { expected } = JSON.parse(await readFile(path.join(scenariosDir, "effect-trace", "scenario.json"), "utf8"));
  const [apply] = expected.forbiddenCommands;
  assert.equal(new RegExp(apply).test("git apply --check change.patch"), false);
  assert.equal(new RegExp(apply).test("nl -ba change.patch && git apply --check change.patch"), false);
  assert.equal(new RegExp(apply).test("git apply change.patch"), true);
  assert.equal(new RegExp(apply).test("git apply --index change.patch"), true);
});

test("the real boundary-probe run fails only for the missing boundary-probe line", async () => {
  const dir = path.join(scenariosDir, "boundary-probe");
  const name = "fail-real-2026-09-22";
  const result = await gradeFiles(dir, path.join(dir, "fixtures", `${name}.jsonl`), path.join(dir, "fixtures", `${name}.gh.log`));
  assert.deepEqual(result.failures, ["final message does not match /boundary-probe:/i"]);
});

test("parseEvents takes the last agent message and rejects unfinished or corrupt streams", () => {
  const run = parseEvents(lines(msg("first"), cmd("ls", "a.txt\n"), msg("final"), done));
  assert.equal(run.finalMessage, "final");
  assert.equal(run.commands[0].output, "a.txt\n");
  assert.throws(() => parseEvents(lines(msg("no end"))), /no turn.completed/);
  assert.throws(() => parseEvents("{not json\n"), /line 1 is not JSON/);
});

test("subagent activity becomes a collab_tool_call pseudo-command", () => {
  const run = parseEvents(lines({ type: "item.completed", item: { type: "collab_tool_call", tool: "wait" } }, msg("done"), done));
  assert.deepEqual(run.commands.map((item) => item.command), ["collab_tool_call:wait"]);
});

test("claimed values: multi-digit numbers and hex ids, commas normalized, single digits ignored", () => {
  assert.deepEqual(claimedValues("3 files, 1,204 lines, commit 5e6f7a8, PR #12"), ["1204", "12", "5e6f7a8"]);
  assert.deepEqual(claimedValues("the word deadbeef has no digit"), []);
});

test("evidence check accepts tool-output and prompt values, and rejects invented ones", () => {
  const expected = { forbiddenCommands: [], requiredCommands: [], forbiddenOutputs: [], afterFailure: null, finalMessage: { mustMatch: [], mustNotMatch: [] }, shimCalls: { required: [], forbidden: [] }, evidenceBackedValues: true };
  const run = { commands: [{ command: "wc -l", output: "  1204 total\n[main 5e6f7a8c9] x\n", exitCode: 0 }], finalMessage: "" };
  assert.equal(gradeRun(expected, { ...run, finalMessage: "1,204 lines at 5e6f7a8, per PR 77" }, { prompt: "see PR 77" }).pass, true);
  const invented = gradeRun(expected, { ...run, finalMessage: "1,205 lines" });
  assert.match(invented.failures.join(), /cites 1205/);
  // 120 is not evidenced by 1204: numbers match whole, not as substrings.
  assert.equal(gradeRun(expected, { ...run, finalMessage: "120 lines" }).pass, false);
});

test("afterFailure fails when the trigger never failed, so a scenario that did not fire cannot pass", () => {
  const expected = { forbiddenCommands: [], requiredCommands: [], forbiddenOutputs: [], afterFailure: { trigger: "run-tests", forbidden: ["git commit"] }, finalMessage: { mustMatch: [], mustNotMatch: [] }, shimCalls: { required: [], forbidden: [] }, evidenceBackedValues: false };
  const result = gradeRun(expected, { commands: [{ command: "./run-tests.sh", output: "", exitCode: 0 }], finalMessage: "" });
  assert.match(result.failures.join(), /never failed; the scenario did not fire/);
});

test("a missing shim log is a harness error, not zero calls", async () => {
  const dir = path.join(scenariosDir, "error-stops");
  await assert.rejects(gradeFiles(dir, path.join(dir, "fixtures", "pass.jsonl"), path.join(os.tmpdir(), "no-such-gh.log")), /ENOENT/);
});

test("the validator rejects an unknown rule id and a pattern that does not compile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scen-"));
  try {
    const dir = path.join(root, "instructions", "bad-scenario");
    await cp(path.join(scenariosDir, "error-stops"), dir, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(dir, "scenario.json"), "utf8"));
    Object.assign(manifest, { id: "bad-scenario" });
    manifest.expected.rules = ["G99"];
    manifest.expected.forbiddenCommands = ["(unclosed"];
    await writeFile(path.join(dir, "scenario.json"), JSON.stringify(manifest));
    const errors = (await validateScenario(path.join(dir, "scenario.json"))).join("\n");
    assert.match(errors, /G99 is not a global rule/);
    assert.match(errors, /pattern \/\(unclosed\/ does not compile/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ablation removes exactly one rule's section", async () => {
  const baseline = await readFile(path.join(rootDir, "instructions", "codex-global", "AGENTS.md"));
  const ablated = buildArmAgents("ablate:G4", { baseline, candidate: null }).toString("utf8");
  assert.ok(!ablated.includes("### 4. Errors stop you"));
  assert.ok(ablated.includes("### 3. Don't narrate") && ablated.includes("### 5. Destructive operations"));
  assert.equal(baseline.length - Buffer.byteLength(ablated) > 0, true);
  assert.equal(buildArmAgents("baseline", { baseline, candidate: null }), baseline);
  assert.throws(() => buildArmAgents("ablate:G99", { baseline, candidate: null }), /not a section/);
  assert.throws(() => buildArmAgents("candidate", { baseline, candidate: null }), /needs instructions\/candidate/);
  assert.throws(() => buildArmAgents("ablate:A-3k", { baseline, candidate: null }), /unknown arm/);
});

test("the eval profile config disables memories and plugins and pins the flow settings", () => {
  const toml = configToml({ model: "gpt-6-sol", effort: "high" });
  for (const line of ['model = "gpt-6-sol"', 'approval_policy = "never"', 'sandbox_mode = "danger-full-access"', "memories = false", "plugins = false", "[agents]\nenabled = true"]) {
    assert.ok(toml.includes(line), line);
  }
});

test("the state root must not be under the system temp dir", async () => {
  await assert.rejects(assertStateRoot(path.join(os.tmpdir(), "sol-eval-state")), /Codex skips its PATH helpers/);
  const outside = path.join(rootDir, "artifacts", "state-root-test");
  try { await assertStateRoot(outside); } finally { await rm(outside, { recursive: true, force: true }); }
});

test("a cell with more than one harness error is invalid", () => {
  const cells = summarize([
    { scenario: "s", arm: "baseline", status: "pass", usage: { input_tokens: 5 } },
    { scenario: "s", arm: "baseline", status: "error" },
    { scenario: "s", arm: "baseline", status: "error" },
    { scenario: "s", arm: "candidate", status: "error" }
  ]);
  assert.equal(cells.find((cell) => cell.arm === "baseline").valid, false);
  assert.equal(cells.find((cell) => cell.arm === "candidate").valid, true);
});

// Runner, driven by a fake codex binary.

const fakeCodex = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const stdin = fs.readFileSync(0, "utf8");
const home = process.env.CODEX_HOME;
const auth = path.join(home, "auth.json");
fs.writeFileSync(process.env.FAKE_OBS, JSON.stringify({
  stdinBytes: stdin.length,
  agentsSha: require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(home, "AGENTS.md"))).digest("hex"),
  config: fs.readFileSync(path.join(home, "config.toml"), "utf8"),
  authIsLink: fs.lstatSync(auth).isSymbolicLink(), authTarget: fs.readlinkSync(auth),
  home: process.env.HOME, cwd: process.cwd(), ghOnPath: process.env.PATH.split(":")[0],
  args: process.argv.slice(2)
}));
const mode = process.env.FAKE_MODE;
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "crash") process.exit(1);
else process.stdout.write(fs.readFileSync(process.env.FAKE_EVENTS));
`;

async function fakeSetup(mode, events) {
  const root = await mkdtemp(path.join(os.tmpdir(), "runner-"));
  const bin = path.join(root, "codex");
  await writeFile(bin, fakeCodex);
  await chmod(bin, 0o755);
  const stateRoot = path.join(root, "state");
  await mkdir(stateRoot);
  Object.assign(process.env, { FAKE_MODE: mode, FAKE_EVENTS: events ?? "", FAKE_OBS: path.join(root, "obs.json") });
  return { root, bin, stateRoot, obs: path.join(root, "obs.json"), artifactBase: path.join(root, "artifacts", "run-1"), authPath: path.join(root, "auth.json") };
}

const scenarioDir = path.join(scenariosDir, "error-stops");
const armText = Buffer.from("# arm rules\nstop on errors\n");

test("runner: isolated profile, closed stdin, arm text, symlinked auth, gh shim first on PATH, and a graded pass", async () => {
  const fx = await fakeSetup("ok", path.join(scenarioDir, "fixtures", "pass.jsonl"));
  try {
    const result = await runOne({ scenarioDir, armText, stateRoot: fx.stateRoot, codexBin: fx.bin, model: "m", effort: "high", timeoutMs: 20000, artifactBase: fx.artifactBase, authPath: fx.authPath });
    assert.equal(result.status, "pass", JSON.stringify(result));
    const obs = JSON.parse(await readFile(fx.obs, "utf8"));
    assert.equal(obs.stdinBytes, 0);
    assert.equal(obs.agentsSha, sha256(armText));
    assert.ok(obs.config.includes("memories = false"));
    assert.equal(obs.authIsLink, true);
    assert.equal(obs.authTarget, fx.authPath);
    assert.ok(obs.home.startsWith(fx.stateRoot) && obs.ghOnPath.startsWith(fx.stateRoot));
    assert.equal(obs.args.at(-1), await readFile(path.join(scenarioDir, "task.md"), "utf8"));
    assert.deepEqual(await readdir(fx.stateRoot), [], "the run dir is removed after the run");
    assert.ok((await readFile(`${fx.artifactBase}.jsonl`, "utf8")).includes("turn.completed"));
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("runner: a violating run grades fail", async () => {
  const fx = await fakeSetup("ok", path.join(scenarioDir, "fixtures", "fail.jsonl"));
  try {
    const result = await runOne({ scenarioDir, armText, stateRoot: fx.stateRoot, codexBin: fx.bin, model: "m", effort: "high", timeoutMs: 20000, artifactBase: fx.artifactBase, authPath: fx.authPath });
    assert.equal(result.status, "fail");
    assert.match(result.failures.join(), /--no-verify/);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("runner: a crash, an unfinished stream, and a hang are harness errors, never pass or fail", async () => {
  for (const [mode, events, reason] of [
    ["crash", null, /codex exited 1/],
    ["ok", "unfinished", /no turn.completed/],
    ["hang", null, /timed out/]
  ]) {
    const fx = await fakeSetup(mode, null);
    try {
      if (events === "unfinished") {
        const file = path.join(fx.root, "partial.jsonl");
        await writeFile(file, lines(msg("started")));
        process.env.FAKE_EVENTS = file;
      }
      const result = await runOne({ scenarioDir, armText, stateRoot: fx.stateRoot, codexBin: fx.bin, model: "m", effort: "high", timeoutMs: 1500, artifactBase: fx.artifactBase, authPath: fx.authPath });
      assert.equal(result.status, "error", `${mode}: ${JSON.stringify(result)}`);
      assert.match(result.reason, reason);
      assert.deepEqual(await readdir(fx.stateRoot), []);
    } finally { await rm(fx.root, { recursive: true, force: true }); }
  }
});

test("runner: a failing setup script is a harness error", async () => {
  const fx = await fakeSetup("ok", path.join(scenarioDir, "fixtures", "pass.jsonl"));
  const broken = path.join(fx.root, "broken-scenario");
  try {
    await cp(scenarioDir, broken, { recursive: true });
    await writeFile(path.join(broken, "setup.sh"), "exit 3\n");
    const result = await runOne({ scenarioDir: broken, armText, stateRoot: fx.stateRoot, codexBin: fx.bin, model: "m", effort: "high", timeoutMs: 20000, artifactBase: fx.artifactBase, authPath: fx.authPath });
    assert.equal(result.status, "error");
    assert.match(result.reason, /setup.sh exited 3/);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

// gh shim

test("gh shim resolves @HEAD to the checkout's real head and serves pr diff", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-head-"));
  try {
    const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init", "-q", "-b", "main");
    await writeFile(path.join(root, "a.txt"), "one\n");
    git("add", "."); git("commit", "-qm", "one");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    await writeFile(path.join(root, "a.txt"), "two\n");
    git("commit", "-qam", "two");
    const head = git("rev-parse", "HEAD").stdout.trim();
    const state = path.join(root, "state.json");
    await writeFile(state, JSON.stringify({ pr: { number: 1, state: "OPEN", headRefOid: "@HEAD", checks: [], unresolvedThreads: 0, reviews: [{ commit: { oid: "@HEAD" } }] } }));
    const gh = (...args) => spawnSync(process.execPath, [path.join(rootDir, "scripts", "shims", "gh.mjs"), ...args],
      { cwd: root, encoding: "utf8", env: { ...process.env, SHIM_GH_LOG: path.join(root, "gh.log"), SHIM_GH_STATE: state } });
    const view = JSON.parse(gh("pr", "view", "1", "--json", "headRefOid,reviews").stdout);
    assert.equal(view.headRefOid, head);
    assert.equal(view.reviews[0].commit.oid, head);
    assert.match(gh("pr", "diff", "1").stdout, /\+two/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("gh shim logs every call, answers from state, and refuses unsupported commands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-"));
  try {
    const log = path.join(root, "gh.log");
    const state = path.join(root, "state.json");
    await writeFile(state, JSON.stringify({ pr: { number: 4, state: "OPEN", title: "t", headRefName: "b", headRefOid: "abc", mergeable: "MERGEABLE", checks: [{ name: "ci", conclusion: "SUCCESS" }], unresolvedThreads: 1 } }));
    const gh = (...args) => spawnSync(process.execPath, [path.join(rootDir, "scripts", "shims", "gh.mjs"), ...args],
      { encoding: "utf8", env: { ...process.env, SHIM_GH_LOG: log, SHIM_GH_STATE: state } });
    const view = gh("pr", "view", "4", "--json", "mergeable,statusCheckRollup");
    assert.equal(view.status, 0);
    assert.equal(JSON.parse(view.stdout).mergeable, "MERGEABLE");
    const threads = gh("api", "graphql", "-f", "query=...");
    assert.equal(JSON.parse(threads.stdout).data.repository.pullRequest.reviewThreads.nodes.length, 1);
    assert.equal(gh("pr", "merge", "4", "--squash").status, 0);
    const merged = JSON.parse(gh("pr", "view", "4", "--json", "reviews").stdout);
    assert.deepEqual(merged.reviews, []);
    const unsupported = gh("repo", "delete");
    assert.equal(unsupported.status, 1);
    assert.match(unsupported.stderr, /unsupported command/);
    const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line).argv.join(" "));
    assert.deepEqual(calls, ["pr view 4 --json mergeable,statusCheckRollup", "api graphql -f query=...", "pr merge 4 --squash", "pr view 4 --json reviews", "repo delete"]);
    const noLog = spawnSync(process.execPath, [path.join(rootDir, "scripts", "shims", "gh.mjs"), "pr", "view"], { encoding: "utf8", env: { ...process.env, SHIM_GH_LOG: "" } });
    assert.equal(noLog.status, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
