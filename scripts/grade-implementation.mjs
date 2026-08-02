import { spawnSync } from "node:child_process";
import path from "node:path";
import { displayCommand, fail, isMain, readJson } from "./lib.mjs";

function matches(relative, patterns) {
  return patterns.some((pattern) => relative === pattern || relative.startsWith(`${pattern}/`));
}

export function gradeChangedPaths(paths, expected) {
  const errors = [];
  if (paths.length > expected.maxChangedFiles) errors.push(`Changed ${paths.length} files; maximum is ${expected.maxChangedFiles}`);
  for (const file of paths) {
    if (!matches(file, expected.allowedPaths)) errors.push(`Changed path is outside the allowed scope: ${file}`);
    if (matches(file, expected.forbiddenPaths)) errors.push(`Changed forbidden path: ${file}`);
  }
  return errors;
}

export function gradeRepositoryPaths(paths, workspacePrefix, expected) {
  const errors = [];
  for (const file of paths.filter((candidate) => !candidate.startsWith(workspacePrefix))) {
    errors.push(`Changed path is outside the selected workspace: ${file}`);
  }
  const workspacePaths = paths
    .filter((file) => file.startsWith(workspacePrefix))
    .map((file) => file.slice(workspacePrefix.length));
  errors.push(...gradeChangedPaths(workspacePaths, expected));
  return { errors, workspacePaths };
}

async function main() {
  const scenarioDirectory = process.argv[2];
  if (!scenarioDirectory) return fail("Usage: node scripts/grade-implementation.mjs <scenario-directory>");
  const directory = path.resolve(scenarioDirectory);
  const workspace = path.join(directory, "workspace");
  const manifestIndex = process.argv.indexOf("--manifest");
  const manifest = manifestIndex >= 0 ? path.resolve(process.argv[manifestIndex + 1]) : path.join(directory, "scenario.json");
  const scenario = await readJson(manifest);
  const errors = [];
  for (const command of scenario.expected.commands) {
    console.log(`$ ${displayCommand(command)}`);
    const result = spawnSync(command[0], command.slice(1), { cwd: workspace, stdio: "inherit" });
    if (result.status !== 0) errors.push(`Command failed: ${displayCommand(command)}`);
  }
  const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: process.cwd(), encoding: "utf8"
  });
  if (status.status !== 0) errors.push("Unable to inspect changed paths with git status");
  const prefix = `${path.relative(process.cwd(), workspace).split(path.sep).join("/")}/`;
  const allChanged = status.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const name = line.slice(3);
    return name.includes(" -> ") ? name.split(" -> ").at(-1) : name;
  });
  const scope = gradeRepositoryPaths(allChanged, prefix, scenario.expected);
  const changed = scope.workspacePaths;
  errors.push(...scope.errors);
  if (errors.length) return fail(`Implementation scenario failed:\n- ${errors.join("\n- ")}`);
  console.log(`Implementation scenario '${scenario.id}' passed with ${changed.length} changed file(s).`);
}

if (isMain(import.meta.url)) await main();
