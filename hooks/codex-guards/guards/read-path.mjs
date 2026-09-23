import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { resolvePath, segments } from "../lib/shell.mjs";

// Guard 1 (contract 5.2): a read of a path that does not exist, when the path's
// base is known. Only the leading run of read-only segments is checked; the
// first segment that could create or change files ends checking (H3).

const NEUTRAL = new Set(["echo", "printf", "pwd", "true"]);
// Options that consume the next word, per command.
const VALUE_OPTIONS = {
  head: ["-n", "-c"], tail: ["-n", "-c"], nl: ["-b", "-s", "-w", "-v", "-i"], wc: [],
  cat: [], ls: ["-I", "--ignore", "-w"], sed: ["-e", "-f"],
  rg: ["-e", "-f", "-g", "--glob", "-t", "--type", "-T", "--type-not", "-m", "--max-count", "-A", "-B", "-C", "-M", "--max-columns", "-d", "--max-depth", "-j", "--threads", "--sort", "--sortr", "-r", "--replace"],
  grep: ["-e", "-f", "-m", "-A", "-B", "-C", "--include", "--exclude", "--exclude-dir"]
};

// Returns the literal path arguments of a read-only command, or null when the
// segment is not a read-only command this guard understands.
function readPaths(words) {
  const [name, ...args] = words;
  if (!(name in VALUE_OPTIONS)) return null;
  if (args.some((word) => /[<>]/.test(word))) return null; // redirection: not read-only
  if (name === "sed" && args.some((word) => /^-[a-zA-Z]*i/.test(word) || word === "--in-place")) return null;
  const takesValue = new Set(VALUE_OPTIONS[name]);
  const positional = [];
  let patternGiven = false;
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i];
    if (word === "--") { positional.push(...args.slice(i + 1)); break; }
    if (word.startsWith("-") && word !== "-") {
      if (takesValue.has(word)) { if (["-e", "-f"].includes(word)) patternGiven = true; i += 1; }
      else if (/^--[\w-]+=/.test(word)) { /* inline value */ }
      else if (name !== "sed" && /^-[A-Za-z]*[0-9]+$/.test(word)) { /* e.g. -n5 */ }
      continue;
    }
    positional.push(word);
  }
  if (name === "sed") return positional.length >= 2 && !patternGiven ? positional.slice(1) : null;
  // `rg --files` takes no pattern: every positional word is a path.
  if (name === "rg" && args.includes("--files")) return positional;
  if (name === "rg" || name === "grep") return patternGiven ? positional : positional.slice(1);
  return positional;
}

function nearestExisting(target) {
  let dir = path.dirname(target);
  while (dir !== "/" && !existsSync(dir)) dir = path.dirname(dir);
  return dir;
}

// Up to 5 existing paths with the same basename under `dir`, then a listing.
export function candidates(target, { limit = 5 } = {}) {
  const dir = nearestExisting(target);
  const base = path.basename(target).toLowerCase();
  const found = [];
  const git = spawnSync("git", ["-C", dir, "ls-files", "--full-name", "-z"], { encoding: "utf8", timeout: 3000 });
  if (git.status === 0) {
    const top = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 3000 }).stdout.trim();
    for (const file of git.stdout.split("\0")) {
      if (file && path.basename(file).toLowerCase() === base) found.push(path.join(top, file));
      if (found.length >= limit) break;
    }
  } else {
    const queue = [[dir, 0]];
    let seen = 0;
    while (queue.length && found.length < limit && seen < 2000) {
      const [current, depth] = queue.shift();
      let entries = [];
      try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        seen += 1;
        const full = path.join(current, entry.name);
        if (entry.name.toLowerCase() === base) found.push(full);
        if (entry.isDirectory() && depth < 3 && !entry.name.startsWith(".")) queue.push([full, depth + 1]);
      }
    }
  }
  let listing = [];
  if (!found.length) {
    try { listing = readdirSync(dir).slice(0, 10); } catch {}
  }
  return { dir, found, listing };
}

function denial(target) {
  const { dir, found, listing } = candidates(target);
  const hint = found.length
    ? `Existing files with that name: ${found.join(", ")}.`
    : `It is not under ${dir}; that directory contains: ${listing.join(", ") || "(nothing readable)"}.`;
  return {
    action: "deny",
    code: "read-path",
    reason: `[read-path] ${target} does not exist. ${hint} Use one of these paths, or list ${dir} first, instead of guessing.`,
    pending: { code: "read-path", dir, candidates: found }
  };
}

// Evaluates one PreToolUse call. Returns null (allow) or a deny finding.
export function checkReadPath({ toolName, command, home, exists = existsSync }) {
  if (toolName === "apply_patch") {
    for (const match of String(command).matchAll(/^\*\*\* (Update|Delete) File: (.+)$/gm)) {
      const target = match[2].trim();
      if (target.startsWith("/") && !exists(target)) return denial(target);
    }
    return null;
  }
  const parsed = segments(String(command));
  if (!parsed) return null;
  let base = null; // the hook cannot see the workdir (probe Q7): unknown until a cd states it
  for (const words of parsed) {
    const [name] = words;
    if (name === "cd") {
      const next = resolvePath(words[1], base, home);
      if (!next || !exists(next)) return null; // unknown or failing cd: stop checking
      base = next;
      continue;
    }
    if (NEUTRAL.has(name)) continue;
    const paths = readPaths(words);
    if (!paths) return null; // not a read-only command: stop checking (it may create files)
    for (const arg of paths) {
      const target = resolvePath(arg, base, home);
      if (target && !exists(target)) return denial(target);
    }
  }
  return null;
}

// Guard 1b (contract revision 7): after a read command failed, its own error
// line proves the path is missing, so a relative path can be handled with
// certainty. Relative paths are searched from the session cwd (the only base a
// hook sees) and labeled that way. Context + pending redirect, never a deny.
const READ_ERROR = /^(?:cat|sed|head|tail|nl|ls|wc|rg|grep): (?:can't read |cannot access )?['\u2018]?([^:'\u2019\n]+?)['\u2019]?: No such file or directory/m;

export function checkReadFailure({ response, cwd, home }) {
  const match = READ_ERROR.exec(typeof response === "string" ? response : JSON.stringify(response ?? ""));
  if (!match) return null;
  const raw = match[1].trim();
  const relative = !raw.startsWith("/") && !raw.startsWith("~");
  const target = resolvePath(raw, relative ? cwd : null, home);
  if (!target) return null;
  const { dir, found, listing } = candidates(target);
  const where = relative ? ` (searched from the session directory ${cwd}; if the command ran elsewhere, list that directory instead)` : "";
  const hint = found.length ? `Existing files with that name: ${found.join(", ")}.` : `${dir} contains: ${listing.join(", ") || "(nothing readable)"}.`;
  const reason = `[read-path] ${raw} does not exist${where}. ${hint} Read one of these instead of giving up or guessing again.`;
  // A relative redirect is usually resolved with a relative read, so remember
  // the directory in the same form (relative to the session cwd).
  const relDir = relative ? path.relative(cwd, dir) : null;
  const pending = { code: "read-path", dir, candidates: found };
  if (relDir && !relDir.startsWith("..")) pending.relDir = relDir;
  // Missing file directly in the session cwd: match the suggested names instead.
  if (relDir === "") pending.names = [...found.map((file) => path.basename(file)), ...listing];
  return { action: "context", code: "read-path", reason, pending };
}

// A pending read-path redirect is satisfied by a later call that reads or
// lists inside the suggested directory, or names a suggested file.
export function satisfiesReadPath(pending, command) {
  const text = String(command);
  if (pending.candidates.some((file) => text.includes(file)) || text.includes(pending.dir)) return true;
  if (pending.names?.some((name) => new RegExp(`(^|[\\s'"=/])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(text))) return true;
  return Boolean(pending.relDir) && new RegExp(`(^|[\\s'"=])(\\./)?${pending.relDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`).test(text);
}
