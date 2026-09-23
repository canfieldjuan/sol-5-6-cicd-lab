import { createHash } from "node:crypto";
import { copyFile, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fail, isMain, rootDir } from "./lib.mjs";

// Installs the Codex guards (contract 5.2) and registers them in hooks.json.
// Dry run unless --apply. Existing hooks.json entries are never modified or
// reordered: Codex keys hook trust by position (<file>:<event>:<i>:<j>), so the
// guard entries are only appended.

export const HOOK_EVENTS = [
  { event: "PreToolUse", matcher: "*", statusMessage: "Checking lab guards" },
  { event: "PostToolUse", matcher: "*", statusMessage: "Checking for failed reads" },
  { event: "Stop", matcher: null, statusMessage: "Checking pending guard redirects" }
];
const MARK = "/lab-guards/guard.mjs";

export function defaultPaths(env = process.env) {
  const home = os.homedir();
  const codexHome = env.CODEX_HOME || path.join(home, ".codex");
  const stateHome = env.XDG_STATE_HOME || path.join(home, ".local", "state");
  return {
    source: path.join(rootDir, "hooks", "codex-guards"),
    installDir: path.join(codexHome, "hooks", "lab-guards"),
    hooksJson: path.join(codexHome, "hooks.json"),
    stateDir: path.join(stateHome, "sol-lab")
  };
}

const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function listFiles(dir, prefix = "") {
  const out = [];
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(dir, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

async function readOptional(file) {
  try { return await readFile(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// Returns the merged hooks.json object: every existing entry untouched and in
// place, guard entries appended where missing.
export function mergeHooks(existing, guardCommand) {
  const config = structuredClone(existing ?? {});
  config.hooks ??= {};
  for (const { event, matcher, statusMessage } of HOOK_EVENTS) {
    const list = (config.hooks[event] ??= []);
    const present = list.some((group) => (group.hooks ?? []).some((hook) => String(hook.command).includes(MARK)));
    if (!present) list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: guardCommand, timeout: 10, statusMessage }] });
  }
  return config;
}

async function writeAtomic(file, content, stateDir) {
  const temporary = path.join(stateDir, `${path.basename(file)}.tmp-${process.pid}`);
  await writeFile(temporary, content);
  await rename(temporary, file);
}

// Per-machine guard config (contract revision 8): repos for wrong-repo-script,
// db for the psql rewrite. Written beside the guard state, not manifested.
export function guardConfig({ repos = [], db = null }) {
  const config = {};
  if (repos.length) config.repos = repos.map((repo) => path.resolve(repo));
  if (db) {
    const [host, port, user, database] = db.split(":");
    if (!host || !/^\d+$/.test(port ?? "") || !user || !database) throw new Error("--db must be host:port:user:db");
    config.db = { host, port: Number(port), user, database };
  }
  return config;
}

export async function install({ source, installDir, hooksJson, stateDir, apply = false, now = new Date(), config = null }) {
  await mkdir(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, "guards-install.lock");
  let lock;
  try { lock = await open(lockPath, "wx"); } catch (error) {
    if (error.code === "EEXIST") throw new Error(`another install holds ${lockPath}`);
    throw error;
  }
  try {
    const statePath = path.join(stateDir, "guards-install.json");
    const state = JSON.parse((await readOptional(statePath))?.toString("utf8") ?? "{}");
    const files = await listFiles(source);
    // Refuse to overwrite installed files that were edited by hand since the last install.
    for (const rel of files) {
      const installed = await readOptional(path.join(installDir, rel));
      if (installed === null) continue;
      const expected = state.files?.[rel];
      if (!expected) throw new Error(`${path.join(installDir, rel)} exists but was not installed by this script; move it aside first`);
      if (sha(installed) !== expected && sha(installed) !== sha(await readFile(path.join(source, rel)))) {
        throw new Error(`${path.join(installDir, rel)} was edited by hand since the last install; fold the edit into ${path.join(source, rel)} first`);
      }
    }
    const rawHooks = await readOptional(hooksJson);
    let existing = {};
    if (rawHooks !== null) {
      try { existing = JSON.parse(rawHooks.toString("utf8")); } catch { throw new Error(`${hooksJson} is not valid JSON; not touching it`); }
    }
    const guardCommand = `node '${path.join(installDir, "guard.mjs")}'`;
    const merged = mergeHooks(existing, guardCommand);
    const hooksChanged = JSON.stringify(merged) !== JSON.stringify(existing);
    const plan = { files, hooksChanged, guardCommand };
    if (!apply) return { ...plan, applied: false };

    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const manifest = {};
    for (const rel of files) {
      const content = await readFile(path.join(source, rel));
      await mkdir(path.dirname(path.join(installDir, rel)), { recursive: true });
      await writeAtomic(path.join(installDir, rel), content, stateDir);
      manifest[rel] = sha(content);
    }
    let backup = null;
    if (hooksChanged) {
      if (rawHooks !== null) {
        backup = path.join(stateDir, "backups", `hooks.json.${stamp}.bak`);
        await mkdir(path.dirname(backup), { recursive: true });
        await copyFile(hooksJson, backup);
      }
      await writeAtomic(hooksJson, JSON.stringify(merged, null, 2) + "\n", stateDir);
    }
    if (config && Object.keys(config).length) {
      await mkdir(path.join(stateDir, "guards"), { recursive: true });
      await writeAtomic(path.join(stateDir, "guards", "config.json"), JSON.stringify(config, null, 2) + "\n", stateDir);
    }
    const nextState = { files: manifest, installedAt: now.toISOString(), guardCommand };
    await writeAtomic(statePath, JSON.stringify(nextState, null, 2) + "\n", stateDir);
    return { ...plan, applied: true, backup };
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  const config = guardConfig({ repos: (arg("--repos") ?? "").split(",").filter(Boolean), db: arg("--db") ?? null });
  const paths = defaultPaths();
  const result = await install({ ...paths, apply, config });
  if (Object.keys(config).length) console.log(`guard config: ${JSON.stringify(config)}`);
  console.log(`${apply ? "installed" : "dry run"}: ${result.files.length} guard files -> ${paths.installDir}`);
  console.log(`hooks.json ${result.hooksChanged ? (apply ? "updated (guard entries appended)" : "would gain guard entries") : "already has the guard entries"}: ${paths.hooksJson}`);
  if (result.backup) console.log(`backup: ${result.backup}`);
  if (!apply) return console.log("pass --apply to install");
  console.log("\nThe guards are installed but NOT active until trusted (Codex silently skips untrusted hooks):");
  console.log("  1. Open `codex` (the TUI), run /hooks, and trust the lab-guards entries.");
  console.log("  2. Run any command in that session.");
  console.log("  3. `npm run guards:status` must then report: active.");
}

if (isMain(import.meta.url)) await main().catch((error) => fail(error.message));
