import { copyFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fail, isMain, readJson, rootDir } from "./lib.mjs";
import { sha256 } from "./check-instructions.mjs";

// Installs the tracked global AGENTS.md into the Codex home (contract S6).
// AGENTS.md is the only file written under the Codex home; state, backups,
// the lock, and the temp file live in the state directory.

export function defaultPaths(env = process.env) {
  const home = os.homedir();
  const codexHome = env.CODEX_HOME || path.join(home, ".codex");
  const stateHome = env.XDG_STATE_HOME || path.join(home, ".local", "state");
  return {
    source: path.join(rootDir, "instructions", "codex-global", "AGENTS.md"),
    target: path.join(codexHome, "AGENTS.md"),
    stateDir: path.join(stateHome, "sol-lab")
  };
}

async function readOptional(file) {
  try { return await readFile(file); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function decide({ sourceHash, targetHash, baselineHash, lastInstalledHash }) {
  if (targetHash === null) return { action: "install", reason: "target is missing" };
  if (targetHash === sourceHash) return { action: "noop", reason: "target already matches the source" };
  if (targetHash === baselineHash) return { action: "install", reason: "target matches the recorded baseline" };
  if (lastInstalledHash && targetHash === lastInstalledHash) return { action: "install", reason: "target matches the last installed version" };
  return {
    action: "refuse",
    reason: "target was edited by hand (its hash matches neither the baseline nor the last install); fold the edit into the tracked source first"
  };
}

export async function install({ source, target, stateDir, baselineHash, apply = false, now = new Date() }) {
  await mkdir(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, "install.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`another install holds ${lockPath}; remove it only if no install is running`);
    throw error;
  }
  try {
    const statePath = path.join(stateDir, "state.json");
    const state = JSON.parse((await readOptional(statePath))?.toString("utf8") ?? "{}");
    const sourceBuffer = await readFile(source);
    const targetBuffer = await readOptional(target);
    const sourceHash = sha256(sourceBuffer);
    const targetHash = targetBuffer === null ? null : sha256(targetBuffer);
    const decision = decide({ sourceHash, targetHash, baselineHash, lastInstalledHash: state.lastInstalledSha256 });
    if (!apply || decision.action !== "install") return { ...decision, applied: false, sourceHash, targetHash };

    const stamp = now.toISOString().replace(/[:.]/g, "-");
    let backup = null;
    if (targetBuffer !== null) {
      backup = path.join(stateDir, "backups", `AGENTS.md.${stamp}.bak`);
      await mkdir(path.dirname(backup), { recursive: true });
      await copyFile(target, backup);
    }
    const temporary = path.join(stateDir, `AGENTS.md.tmp-${process.pid}`);
    await writeFile(temporary, sourceBuffer, { mode: 0o644 });
    try {
      const recheck = await readOptional(target);
      if ((recheck === null ? null : sha256(recheck)) !== targetHash) {
        throw new Error("target changed while installing; nothing was replaced");
      }
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      if (error.code === "EXDEV") throw new Error(`state directory and target are on different filesystems; cannot rename atomically into ${target}`);
      throw error;
    }
    const nextState = path.join(stateDir, `state.json.tmp-${process.pid}`);
    await writeFile(nextState, JSON.stringify({ lastInstalledSha256: sourceHash, installedAt: now.toISOString() }, null, 2) + "\n");
    await rename(nextState, statePath);
    return { ...decision, applied: true, backup, sourceHash, targetHash };
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const inventory = await readJson(path.join(rootDir, "instructions", "rule-inventory.json"));
  const paths = defaultPaths();
  const result = await install({ ...paths, baselineHash: inventory.baseline.G.sha256, apply });
  console.log(`${result.action}: ${result.reason}`);
  console.log(`source ${result.sourceHash}\ntarget ${result.targetHash ?? "(missing)"} at ${paths.target}`);
  if (result.backup) console.log(`backup ${result.backup}`);
  if (result.action === "install" && !apply) console.log("dry run: pass --apply to install");
  if (result.action === "refuse") fail("refused to overwrite a hand-edited AGENTS.md");
}

if (isMain(import.meta.url)) await main().catch((error) => fail(error.message));
