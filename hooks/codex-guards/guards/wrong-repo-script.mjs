import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { resolvePath, segments } from "../lib/shell.mjs";

// Guard 2 (contract 5.2, revision 8): running a repo script that is not in the
// repo the command runs in. 2a checks before the run when the command states
// its base; 2b uses the shell's own error line after the run, which covers the
// common case of `workdir` pointing at another repo (invisible to hooks, Q7).

const NEUTRAL = new Set(["echo", "printf", "pwd", "true"]);
const SCRIPT = /^(?:\.\/)?(scripts\/[\w.-]+(?:\/[\w.-]+)*)$/;

function scriptOf(words) {
  const [name, next] = words;
  if ((name === "bash" || name === "sh") && next && SCRIPT.test(next)) return next;
  if (SCRIPT.test(name) && name.startsWith("./")) return name;
  return null;
}

function reposWith(rel, config) {
  return (config?.repos ?? []).filter((repo) => existsSync(path.join(repo, rel)));
}

function listScripts(dir) {
  try { return readdirSync(path.join(dir, "scripts")).slice(0, 12); } catch { return []; }
}

// 2a: PreToolUse, base known from a cd; only when every earlier segment is cd or neutral.
export function checkWrongRepoScript({ command, home, config, exists = existsSync }) {
  const parsed = segments(String(command));
  if (!parsed) return null;
  let base = null;
  for (const words of parsed) {
    if (words[0] === "cd") {
      const next = resolvePath(words[1], base, home);
      if (!next || !exists(next)) return null;
      base = next;
      continue;
    }
    if (NEUTRAL.has(words[0])) continue;
    const script = scriptOf(words);
    if (!script || !base) return null;
    const rel = script.replace(/^\.\//, "");
    if (exists(path.join(base, rel))) return null;
    const elsewhere = reposWith(rel, config);
    const here = listScripts(base);
    const reason = `[wrong-repo-script] ${base} has no ${rel}. ${elsewhere.length ? `It exists in: ${elsewhere.join(", ")}; that script belongs to that repo, so do not run it against ${base}. ` : ""}Scripts in ${base}/scripts: ${here.join(", ") || "(none)"}. Use this repo's own tooling or docs instead.`;
    return { action: "deny", code: "wrong-repo-script", reason, pending: { code: "wrong-repo-script", script: rel, repos: elsewhere } };
  }
  return null;
}

// 2b: PostToolUse, the shell reported the script missing where it ran.
const SHELL_ERROR = /^(?:\/bin\/)?(?:bash|sh|zsh)(?:: line \d+)?: (\.\/)?(scripts\/[\w./-]+): No such file or directory/m;

export function checkWrongRepoFailure({ response, config }) {
  const text = typeof response === "string" ? response : JSON.stringify(response ?? "");
  const match = SHELL_ERROR.exec(text);
  if (!match) return null;
  const rel = match[2];
  const elsewhere = reposWith(rel, config);
  const reason = `[wrong-repo-script] ${rel} does not exist in the directory the command ran in. ${elsewhere.length
    ? `It exists in: ${elsewhere.join(", ")}. That script belongs to that repo; do not run it against a different repo. Use the current repo's own tooling or docs, or state that it has no ${rel}.`
    : `No known repo has it either; check the current repo's own scripts and docs instead of guessing.`}`;
  return { action: "context", code: "wrong-repo-script", reason, pending: { code: "wrong-repo-script", script: rel, repos: elsewhere } };
}

// Satisfied once a later command names one of the repos that has the script,
// or stops running that script.
export function satisfiesWrongRepoScript(pending, command) {
  const text = String(command);
  return pending.repos.some((repo) => text.includes(repo)) || !text.includes(pending.script);
}

// Revision 9: the final message acts on the redirect when it names the script
// and says it is missing here (the correct answer when the repo lacks it).
export function answeredWrongRepoScript(pending, message) {
  const text = String(message ?? "");
  const name = pending.script.split("/").pop();
  return text.includes(name) && /\b(no|not|doesn't|does not|isn't|missing|no such|absent)\b/i.test(text);
}
