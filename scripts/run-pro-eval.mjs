import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fail, isMain, readJson, rootDir } from "./lib.mjs";

const efforts = new Set(["medium", "high", "xhigh", "max"]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} exited with ${result.status ?? "unknown"}`);
  }
  return result;
}

function codexArgs({ directory, output, schema, effort, sandbox }) {
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--cd", directory,
    "--output-last-message", output,
    "--model", "gpt-5.6-sol",
    "--config", `model_reasoning_effort="${effort}"`,
    "--sandbox", sandbox,
    "--ignore-user-config",
    "--ephemeral"
  ];
  if (schema) args.push("--output-schema", schema);
  args.push("-");
  return args;
}

async function verifyChatGptAuth() {
  const status = run("codex", ["login", "status"]);
  if (!`${status.stdout ?? ""}\n${status.stderr ?? ""}`.includes("Logged in using ChatGPT")) {
    throw new Error("Codex must be logged in using ChatGPT");
  }
}

async function prepareReview(id, temporary, headSha) {
  const source = path.join(rootDir, "scenarios", "review", id);
  const fixture = path.join(temporary, id);
  const scenario = await readJson(path.join(source, "scenario.json"));
  if (scenario.id !== id || scenario.lane !== "review") throw new Error(`Unknown review scenario: ${id}`);
  await mkdir(fixture, { recursive: true });
  for (const entry of ["task.md", "change.patch", "base", "head"]) {
    await cp(path.join(source, entry), path.join(fixture, entry), { recursive: true });
  }
  await cp(path.join(rootDir, "scenarios", "review", "AGENTS.md"), path.join(fixture, "AGENTS.md"));
  await cp(path.join(rootDir, "docs", "REVIEW_RULE_IDS.md"), path.join(fixture, "REVIEW_RULE_IDS.md"));
  await mkdir(path.join(fixture, "schemas"));
  await cp(path.join(rootDir, "schemas", "review-output.schema.json"), path.join(fixture, "schemas", "review-output.schema.json"));
  await writeFile(path.join(fixture, ".codex-eval-context.json"), JSON.stringify({ scenarioDirectory: ".", headSha, ruleCatalog: "REVIEW_RULE_IDS.md" }, null, 2));
  return { source, fixture };
}

async function runReview(id, effort, temporary, artifactDirectory) {
  const headSha = run("git", ["rev-parse", "HEAD"], { cwd: rootDir }).stdout.trim();
  const { source, fixture } = await prepareReview(id, temporary, headSha);
  const output = path.join(artifactDirectory, `${id}-${effort}.json`);
  const prompt = await readFile(path.join(rootDir, ".github", "codex", "prompts", "review-eval.md"), "utf8");
  run("codex", codexArgs({
    directory: fixture,
    output,
    schema: path.join(rootDir, "schemas", "review-output.schema.json"),
    effort,
    sandbox: "read-only"
  }), { input: prompt, stdio: ["pipe", "inherit", "inherit"] });
  run(process.execPath, [path.join(rootDir, "scripts", "grade-review.mjs"), source, output, "--expected-sha", headSha], { stdio: "inherit" });
  return output;
}

async function runImplementation(id, effort, temporary, artifactDirectory) {
  const source = path.join(rootDir, "scenarios", "implementation", id);
  const scenario = await readJson(path.join(source, "scenario.json"));
  if (scenario.id !== id || scenario.lane !== "implementation") throw new Error(`Unknown implementation scenario: ${id}`);
  const target = path.join(temporary, "scenarios", "implementation", id);
  await mkdir(target, { recursive: true });
  await cp(path.join(source, "task.md"), path.join(target, "task.md"));
  await cp(path.join(source, "workspace"), path.join(target, "workspace"), { recursive: true });
  await cp(path.join(rootDir, "scenarios", "implementation", "AGENTS.md"), path.join(target, "AGENTS.md"));
  await writeFile(path.join(target, "workspace", ".codex-eval-context.json"), JSON.stringify({ taskFile: path.join(target, "task.md") }, null, 2));
  run("git", ["init", "-b", "main"], { cwd: temporary });
  run("git", ["config", "user.name", "Codex Eval"], { cwd: temporary });
  run("git", ["config", "user.email", "codex-eval@example.invalid"], { cwd: temporary });
  run("git", ["add", "."], { cwd: temporary });
  run("git", ["commit", "-m", "scenario baseline"], { cwd: temporary });

  const output = path.join(artifactDirectory, `${id}-${effort}.md`);
  const prompt = await readFile(path.join(rootDir, ".github", "codex", "prompts", "implementation-eval.md"), "utf8");
  run("codex", codexArgs({
    directory: path.join(target, "workspace"),
    output,
    schema: null,
    effort,
    sandbox: "workspace-write"
  }), { input: prompt, stdio: ["pipe", "inherit", "inherit"] });
  run(process.execPath, [
    path.join(rootDir, "scripts", "grade-implementation.mjs"),
    target,
    "--manifest", path.join(source, "scenario.json")
  ], { cwd: temporary, stdio: "inherit" });
  const patch = run("git", ["diff", "--binary", "HEAD"], { cwd: temporary }).stdout;
  await writeFile(path.join(artifactDirectory, `${id}-${effort}.patch`), patch);
  return output;
}

async function main() {
  const [lane, id, effort = "high"] = process.argv.slice(2);
  if (!id || !["review", "implementation"].includes(lane) || !efforts.has(effort)) {
    return fail("Usage: node scripts/run-pro-eval.mjs <review|implementation> <scenario-id> [medium|high|xhigh|max]");
  }
  await verifyChatGptAuth();
  const artifactDirectory = path.join(rootDir, "artifacts", "evals");
  await mkdir(artifactDirectory, { recursive: true });
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sol-eval-"));
  try {
    const output = lane === "review"
      ? await runReview(id, effort, temporary, artifactDirectory)
      : await runImplementation(id, effort, temporary, artifactDirectory);
    console.log(`Evaluation passed. Output: ${output}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) await main().catch((error) => fail(error.message));
