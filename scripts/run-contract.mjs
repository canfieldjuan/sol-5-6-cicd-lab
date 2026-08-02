import { spawnSync } from "node:child_process";
import path from "node:path";
import { displayCommand, fail, isMain, readJson, rootDir } from "./lib.mjs";

export async function runContract(mode = "required") {
  if (!["required", "advisory", "all"].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
  const contract = await readJson(path.join(rootDir, "ci-contract.json"));
  const checks = contract.checks.filter((check) => mode === "all" || (mode === "required" ? check.required : !check.required));
  let failed = false;
  for (const check of checks) {
    console.log(`\n[${check.id}] ${check.title}`);
    console.log(`$ ${displayCommand(check.command)}`);
    const result = spawnSync(check.command[0], check.command.slice(1), {
      cwd: rootDir,
      env: { ...process.env, CI_CONTRACT_CHILD: "1" },
      stdio: "inherit"
    });
    if (result.status !== 0) {
      failed = true;
      console.error(`[${check.id}] failed with exit ${result.status ?? "unknown"}`);
    }
  }
  return failed ? 1 : 0;
}

async function main() {
  const index = process.argv.indexOf("--mode");
  const mode = index >= 0 ? process.argv[index + 1] : "required";
  if (await runContract(mode)) fail(`Contract mode '${mode}' failed.`);
  else console.log(`\nContract mode '${mode}' passed.`);
}

if (isMain(import.meta.url)) await main();
