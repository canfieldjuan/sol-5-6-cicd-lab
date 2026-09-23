import os from "node:os";
import path from "node:path";
import { segments } from "../lib/shell.mjs";

// Guard 5 (contract 5.2): a broad `find` sweep (rooted at ~, /, /media, /tmp,
// or ~/Desktop without -maxdepth of 2 or less) usually rediscovers a repo whose
// path is already known. A sweep does not fail, so this never denies (H3):
// after it runs, the known-repo map from the guard config is added as context.

function broadRoots(home) {
  return new Set(["/", "/media", "/tmp", home, path.join(home, "Desktop")].map((p) => p.replace(/\/+$/, "") || "/"));
}

function expand(arg, home) {
  if (arg === "~") return home;
  if (arg.startsWith("~/")) return path.join(home, arg.slice(2));
  return arg;
}

export function isBroadFind(command, home = os.homedir()) {
  // $HOME is the one variable whose value the guard knows for certain.
  const parsed = segments(String(command).replace(/\$\{HOME\}|\$HOME\b/g, home));
  if (!parsed) return false;
  const roots = broadRoots(home);
  return parsed.some((words) => {
    if (words[0] !== "find") return false;
    const depth = words.indexOf("-maxdepth");
    if (depth >= 0 && Number(words[depth + 1]) <= 2) return false;
    // find's start paths are the words before its first expression option.
    const firstOption = words.findIndex((word, index) => index > 0 && word.startsWith("-"));
    const starts = words.slice(1, firstOption === -1 ? undefined : firstOption);
    return starts.some((arg) => roots.has((expand(arg, home).replace(/\/+$/, "")) || "/"));
  });
}

export function checkRediscovery({ command, config, home }) {
  const repos = config?.repos ?? [];
  if (!repos.length || !isBroadFind(command, home)) return null;
  const reason = `[rediscovery] Known repositories on this machine: ${repos.join(", ")}. If you are looking for one of these, use its path directly instead of searching the filesystem.`;
  return { action: "context", kind: "context", code: "rediscovery", reason, pending: null };
}

// Revision 11: the hint is given before the sweep (PreToolUse context-only).
export function checkRediscoveryBefore(args) {
  return checkRediscovery(args);
}
