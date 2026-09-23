import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolvePath, segments } from "../lib/shell.mjs";

// Guard 6 (contract 5.2, revision 12): keep work inside a declared PR/goal
// scope. Opt-in: active only when <session cwd>/.codex/scope.json exists.

export function loadScope(cwd) {
  if (!cwd) return null;
  const file = path.join(cwd, ".codex", "scope.json");
  if (!existsSync(file)) return null;
  let raw;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (error) { return { error: `scope.json is not valid JSON: ${error.message}` }; }
  const rootsOk = Array.isArray(raw?.roots) && raw.roots.length > 0 && raw.roots.every((root) => typeof root === "string" && root.startsWith("/"));
  const allowOk = Array.isArray(raw?.allow) && raw.allow.every((glob) => typeof glob === "string" && glob.length > 0);
  if (!rootsOk || !allowOk) return { error: "scope.json needs roots (absolute paths) and allow (glob strings)" };
  return { roots: raw.roots.map((root) => root.replace(/\/+$/, "")), allow: raw.allow, pr: raw.pr ?? null, goal: typeof raw.goal === "string" ? raw.goal : null };
}

export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") { out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += glob[i + 2] === "/" ? 2 : 1; }
    else if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function gitRootOf(target) {
  let dir = target;
  while (dir && dir !== "/") {
    if (existsSync(path.join(dir, ".git"))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

// "allowed" | { out: relative-or-absolute path, repo }
export function classify(scope, target) {
  const root = scope.roots.find((candidate) => target === candidate || target.startsWith(`${candidate}/`));
  if (root) {
    const rel = path.relative(root, target);
    return scope.allow.some((glob) => globToRegExp(glob).test(rel)) ? "allowed" : { out: rel, repo: root };
  }
  const repo = gitRootOf(path.dirname(target));
  return repo ? { out: target, repo } : "allowed"; // scratch files outside any repo are fine
}

function describe(scope) {
  const what = [scope.pr ? `PR #${scope.pr}` : null, scope.goal].filter(Boolean).join(": ") || "the declared scope";
  return `${what}. Allowed: ${scope.allow.join(", ")} in ${scope.roots.join(", ")}`;
}

export function checkScope({ toolName, command, cwd, home }) {
  const scope = loadScope(cwd);
  if (!scope || scope.error) return null;
  const deny = (target, verdict) => ({
    action: "deny", code: "scope",
    reason: `[scope] ${target} is outside ${describe(scope)}. Leave it out of this change; if it is truly needed, say so explicitly in your final message and name the file.`,
    pending: { code: "scope", files: [verdict.out] }
  });
  if (toolName === "apply_patch") {
    for (const match of String(command).matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)) {
      const raw = match[1].trim();
      const target = raw.startsWith("/") ? path.normalize(raw) : path.join(cwd, raw);
      const verdict = classify(scope, target);
      if (verdict !== "allowed") return deny(target, verdict);
    }
    return null;
  }
  const parsed = segments(String(command));
  if (!parsed) return null;
  let base = null;
  for (const words of parsed) {
    if (words[0] !== "cd") continue;
    const target = resolvePath(words[1], base, home);
    if (!target) return null;
    base = target;
    const inRoot = scope.roots.some((root) => target === root || target.startsWith(`${root}/`));
    const repo = inRoot ? null : gitRootOf(target);
    if (repo) return deny(target, { out: target, repo });
  }
  return null;
}

// -z: paths are unquoted; a rename/copy entry is followed by its source path.
export function dirtyFiles(root) {
  const result = spawnSync("git", ["-C", root, "status", "--porcelain", "-z", "--untracked-files=all"], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) return null;
  const entries = result.stdout.split("\0");
  const files = [];
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i].length < 4) continue;
    files.push(entries[i].slice(3));
    if (/^[RC]/.test(entries[i])) i += 1;
  }
  return files;
}

// Session-start snapshot of each root's already-dirty files (revision 12).
export function scopeBaseline(cwd) {
  const scope = loadScope(cwd);
  if (!scope || scope.error) return null;
  return Object.fromEntries(scope.roots.map((root) => [root, dirtyFiles(root) ?? []]));
}

// Stop drift: files dirtied since the baseline that match no allow glob.
export function scopeDrift({ cwd, baseline }) {
  const scope = loadScope(cwd);
  if (!scope || scope.error || !baseline) return null;
  const drift = [];
  const byRoot = {};
  for (const root of scope.roots) {
    const before = new Set(baseline[root] ?? []);
    for (const file of dirtyFiles(root) ?? []) {
      if (before.has(file)) continue;
      if (scope.allow.some((glob) => globToRegExp(glob).test(file))) continue;
      drift.push(file);
      (byRoot[root] ??= []).push(file);
    }
  }
  if (!drift.length) return null;
  return {
    code: "scope", files: drift, byRoot,
    reason: `[scope] Changed outside ${describe(scope)}: ${drift.join(", ")}. Revert those files, or if they are truly needed, name each one in your final message and say why.`
  };
}

// Answered when the final message names every out-of-scope file.
export function answeredScope(pending, message) {
  const text = String(message ?? "");
  return (pending.files ?? []).every((file) => text.includes(path.basename(file)));
}
