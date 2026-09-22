import { spawn, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fail, isMain, readJson, rootDir, walkFiles } from "./lib.mjs";
import { parseSections, ruleIdFor, sha256 } from "./check-instructions.mjs";
import { gradeFiles } from "./grade-instructions.mjs";

// Runs instruction-retention scenarios against real Codex (contract section 6).
// Runs are serialized; each gets a fresh CODEX_HOME and HOME, and auth.json is
// symlinked so a token refresh can never leave the real login revoked.

const home = os.homedir();
export const defaultStateRoot = path.join(process.env.XDG_STATE_HOME || path.join(home, ".local", "state"), "sol-lab", "eval");

export async function assertStateRoot(stateRoot) {
  await mkdir(stateRoot, { recursive: true });
  const real = await realpath(stateRoot);
  const temp = await realpath(os.tmpdir());
  if (real === temp || real.startsWith(temp + path.sep)) {
    throw new Error(`state root ${real} is under ${temp}; Codex skips its PATH helpers there, so the eval profile would not match the real one`);
  }
}

// Arm text: the baseline, the candidate, or the baseline with one rule's section removed.
export function buildArmAgents(arm, { baseline, candidate }) {
  if (arm === "baseline") return baseline;
  if (arm === "candidate") {
    if (candidate === null) throw new Error("arm candidate needs instructions/candidate/codex-global/AGENTS.md");
    return candidate;
  }
  const match = /^ablate:(G[\w-]+)$/.exec(arm);
  if (!match) throw new Error(`unknown arm ${arm}; use baseline, candidate, or ablate:<G rule id>`);
  const section = parseSections(baseline).find((item) => ruleIdFor("G", item.title) === match[1]);
  if (!section) throw new Error(`arm ${arm}: rule ${match[1]} is not a section of the baseline`);
  return Buffer.concat([baseline.subarray(0, section.start), baseline.subarray(section.end)]);
}

export function configToml({ model, effort }) {
  return [
    `model = ${JSON.stringify(model)}`,
    `model_reasoning_effort = ${JSON.stringify(effort)}`,
    `approval_policy = "never"`,
    `sandbox_mode = "danger-full-access"`,
    "",
    "[features]",
    "memories = false",
    "plugins = false",
    "recommended_plugins = false",
    ""
  ].join("\n");
}

function runProcess(command, args, { cwd, env, timeoutMs, stdoutFile }) {
  return new Promise((resolve) => {
    // stdin is /dev/null: an open stdin makes `codex exec` wait for end-of-input.
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const out = [];
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, timedOut, stderr: error.message }); });
    child.on("close", async (code) => {
      clearTimeout(timer);
      await writeFile(stdoutFile, Buffer.concat(out));
      resolve({ code, timedOut, stderr });
    });
  });
}

export async function runOne({ scenarioDir, armText, stateRoot, codexBin = "codex", model, effort, timeoutMs, artifactBase, authPath }) {
  const runDir = await mkdtemp(path.join(stateRoot, "run-"));
  const fixture = await mkdtemp(path.join(os.tmpdir(), "instr-fixture-"));
  const codexHome = path.join(runDir, "codex");
  const fakeHome = path.join(runDir, "home");
  const bin = path.join(runDir, "bin");
  const eventsFile = `${artifactBase}.jsonl`;
  const shimLog = `${artifactBase}.gh.log`;
  try {
    await mkdir(codexHome, { recursive: true });
    await mkdir(fakeHome, { recursive: true });
    await mkdir(bin, { recursive: true });
    await mkdir(path.dirname(artifactBase), { recursive: true });
    await writeFile(path.join(codexHome, "AGENTS.md"), armText);
    await writeFile(path.join(codexHome, "config.toml"), configToml({ model, effort }));
    await symlink(authPath, path.join(codexHome, "auth.json"));
    try { await symlink(path.join(home, ".gitconfig"), path.join(fakeHome, ".gitconfig")); } catch {}
    await copyFile(path.join(rootDir, "scripts", "shims", "gh.mjs"), path.join(bin, "gh"));
    await chmod(path.join(bin, "gh"), 0o755);
    await writeFile(shimLog, "");

    const env = {
      ...process.env,
      CODEX_HOME: codexHome, HOME: fakeHome,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SHIM_GH_LOG: shimLog,
      GIT_AUTHOR_NAME: "Eval", GIT_AUTHOR_EMAIL: "eval@example.invalid",
      GIT_COMMITTER_NAME: "Eval", GIT_COMMITTER_EMAIL: "eval@example.invalid"
    };
    try { await readFile(path.join(scenarioDir, "gh-state.json")); env.SHIM_GH_STATE = path.join(scenarioDir, "gh-state.json"); } catch {}

    const setup = spawnSync("bash", [path.join(scenarioDir, "setup.sh")], { cwd: fixture, env, encoding: "utf8" });
    if (setup.status !== 0) return { status: "error", reason: `setup.sh exited ${setup.status}: ${setup.stderr.slice(-300)}` };
    await writeFile(shimLog, ""); // setup must not count as agent calls

    const prompt = await readFile(path.join(scenarioDir, "task.md"), "utf8");
    const result = await runProcess(codexBin, ["exec", "--json", "--skip-git-repo-check", prompt],
      { cwd: fixture, env, timeoutMs, stdoutFile: eventsFile });
    if (result.timedOut) return { status: "error", reason: `timed out after ${timeoutMs} ms` };
    if (result.code !== 0) return { status: "error", reason: `codex exited ${result.code}: ${result.stderr.slice(-300)}` };
    try {
      const graded = await gradeFiles(scenarioDir, eventsFile, shimLog);
      return { status: graded.pass ? "pass" : "fail", failures: graded.failures, usage: graded.usage };
    } catch (error) {
      return { status: "error", reason: error.message };
    }
  } finally {
    await rm(runDir, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  }
}

export function summarize(results) {
  const cells = new Map();
  for (const result of results) {
    const key = `${result.scenario}\t${result.arm}`;
    const cell = cells.get(key) ?? { scenario: result.scenario, arm: result.arm, pass: 0, fail: 0, error: 0, inputTokens: [] };
    cell[result.status] += 1;
    if (result.usage?.input_tokens) cell.inputTokens.push(result.usage.input_tokens);
    cells.set(key, cell);
  }
  // Contract section 7: more than one error invalidates the cell.
  return [...cells.values()].map((cell) => ({ ...cell, valid: cell.error <= 1 }));
}

async function scenarioIds() {
  const files = (await walkFiles(path.join(rootDir, "scenarios", "instructions"))).filter((file) => path.basename(file) === "scenario.json");
  return files.map((file) => path.basename(path.dirname(file)));
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const arms = argValue("--arms", "baseline").split(",");
  const scenarioArg = argValue("--scenario", "all");
  const runs = Number(argValue("--runs", "3"));
  const model = argValue("--model", "gpt-6-sol");
  const effort = argValue("--effort", "high");
  const timeoutMs = Number(argValue("--timeout-sec", "900")) * 1000;
  if (!Number.isInteger(runs) || runs < 1) return fail("--runs must be a positive integer");

  const status = spawnSync("codex", ["login", "status"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (!`${status.stdout}${status.stderr}`.includes("Logged in using ChatGPT")) return fail("Codex must be logged in using ChatGPT");

  const inventory = await readJson(path.join(rootDir, "instructions", "rule-inventory.json"));
  const baseline = await readFile(path.join(rootDir, inventory.baseline.G.path));
  if (sha256(baseline) !== inventory.baseline.G.sha256) return fail("baseline G does not match its recorded sha256; re-baseline first");
  let candidate = null;
  try { candidate = await readFile(path.join(rootDir, inventory.candidate.G)); } catch {}
  const armTexts = Object.fromEntries(arms.map((arm) => [arm, buildArmAgents(arm, { baseline, candidate })]));

  const stateRoot = defaultStateRoot;
  await assertStateRoot(stateRoot);
  const lockPath = path.join(stateRoot, "eval.lock");
  let lock;
  try { lock = await open(lockPath, "wx"); } catch (error) {
    if (error.code === "EEXIST") return fail(`another eval holds ${lockPath}; runs are serialized`);
    throw error;
  }
  const ids = scenarioArg === "all" ? await scenarioIds() : scenarioArg.split(",");
  const batch = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactRoot = path.join(rootDir, "artifacts", "instructions", batch);
  const authPath = path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "auth.json");
  const results = [];
  try {
    for (const id of ids) {
      const scenarioDir = path.join(rootDir, "scenarios", "instructions", id);
      for (const arm of arms) {
        for (let run = 1; run <= runs; run += 1) {
          const artifactBase = path.join(artifactRoot, id, `${arm.replace(":", "-")}-${run}`);
          const result = await runOne({ scenarioDir, armText: armTexts[arm], stateRoot, model, effort, timeoutMs, artifactBase, authPath });
          results.push({ scenario: id, arm, run, ...result });
          console.log(`${id} ${arm} #${run}: ${result.status}${result.failures?.length ? ` (${result.failures.join("; ")})` : ""}${result.reason ? ` (${result.reason})` : ""}`);
        }
      }
    }
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
  const summary = {
    batch, model, effort, runs,
    arms: Object.fromEntries(arms.map((arm) => [arm, sha256(armTexts[arm])])),
    cells: summarize(results)
  };
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(artifactRoot, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  for (const cell of summary.cells) {
    console.log(`${cell.scenario.padEnd(26)} ${cell.arm.padEnd(14)} pass ${cell.pass}/${cell.pass + cell.fail + cell.error}${cell.error ? ` (errors ${cell.error})` : ""}${cell.valid ? "" : " INVALID"}`);
  }
  console.log(`Summary: ${path.relative(rootDir, path.join(artifactRoot, "summary.json"))}`);
}

if (isMain(import.meta.url)) await main().catch((error) => fail(error.message));
