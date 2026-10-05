import path from "node:path";
import { withoutHeredocs } from "../lib/shell.mjs";

// Round counting, from the Codex port of ~/.claude/hooks/round-guard.sh
// (contract 5.3). `pushesIn` defines a push: a command-position `git [-C dir]
// push` (revision 16), keyed by branch, or by directory for HEAD and bare
// pushes (revision 15). `roundVerdict` counts pushes per subject with tiers
// 5/10/15/20, as the original does; the parity test holds both to it.
//
// Revision 18 (contract 5.4) retired the Stop checkpoint this file used to
// produce. The seam redirect (guards/seam.mjs) uses `pushesIn` at the push
// itself, so nothing for fix loops runs at Stop.

const TIERS = [5, 10, 15, 20];
const REFSPEC = /\borigin\s+(?:HEAD:)?([\w./-]+)/;
const FLAGS = new Set(["--force", "--force-with-lease", "-q", "--quiet"]);
// Revision 16: a push is `git [-C dir] push` at a command position (start, or
// after && || ; | or a newline, after VAR=value prefixes). Text that merely
// mentions "git push" (a ledger line, an echo, a grep) is not a push.
const PUSH = /(?:^|&&|\|\||;|\||\n)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*git\s+(?:-C\s+("[^"]*"|'[^']*'|\S+)\s+)?push\b([^\n|;&]*)/g;

const unquote = (word) => word.replace(/^(["'])(.*)\1$/, "$2");

// Quoted text is data, not commands: blank it out (same length, so positions
// still index the original) before looking for command separators.
function maskQuotes(cmd) {
  let out = "";
  let quote = null;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (quote) {
      if (quote === '"' && ch === "\\" && i + 1 < cmd.length) { out += "__"; i += 1; continue; }
      if (ch === quote) { quote = null; out += ch; } else out += ch === "\n" ? "\n" : "_";
    } else {
      if (ch === "'" || ch === '"') quote = ch;
      out += ch;
    }
  }
  return out;
}

function resolve(target, base) {
  if (target.startsWith("/")) return path.normalize(target);
  return base ? path.join(base, target) : null;
}

// A leading `cd <dir> &&` overrides the call's workdir (relative to it).
export function directoryOf(cmd, workdir) {
  const cd = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/.exec(cmd);
  return cd ? resolve(unquote(cd[1]), workdir) : workdir ?? null;
}

function originalMatch(cmd, masked) {
  const original = cmd.slice(masked.index, masked.index + masked[0].length);
  const again = new RegExp(PUSH.source).exec(original);
  return again ?? masked;
}

// Every push in one command, as the subject it counts against. Heredoc
// bodies are removed first (revision 18): a script that writes `git push` into
// a heredoc is not a push, as in the Claude original's mask.
export function pushesIn({ cmd: raw, workdir = null }) {
  const cmd = withoutHeredocs(String(raw));
  const found = [];
  for (const masked of maskQuotes(cmd).matchAll(PUSH)) {
    // Match on the masked text; read -C and the arguments from the original.
    const match = originalMatch(cmd, masked);
    const refspec = REFSPEC.exec(match[2]);
    let branch = refspec ? refspec[1] : "<current-branch>";
    if (FLAGS.has(branch)) branch = "<current-branch>";
    // The push's directory: -C, else a leading cd, else the workdir. Every push
    // reports it (revision 18, for repository namespacing); only HEAD and bare
    // pushes are keyed by it, so named keys stay as the Claude original has them.
    const base = directoryOf(cmd, workdir);
    const dir = match[1] ? resolve(unquote(match[1]), base) : base;
    if (branch !== "HEAD" && branch !== "<current-branch>") { found.push({ key: branch, label: `\`${branch}\``, named: true, dir }); continue; }
    // Revision 15: HEAD and bare pushes are keyed by directory, so pushes from
    // different repositories are never counted as one change's rounds.
    found.push(dir ? { key: `${branch}@${dir}`, label: `the current branch in ${dir}`, named: false, dir } : { key: branch, label: `\`${branch}\``, named: false, dir });
  }
  return found;
}

export function roundVerdict(commands, fired = []) {
  const subjects = commands.flatMap((entry) => pushesIn(typeof entry === "string" ? { cmd: entry } : entry));
  if (!subjects.length) return null;
  const pushes = new Map();
  for (const { key } of subjects) pushes.set(key, (pushes.get(key) ?? 0) + 1);
  const subject = subjects[subjects.length - 1];
  const count = pushes.get(subject.key);
  const tier = TIERS.filter((t) => count >= t).pop() ?? 0;
  if (!tier) return null;
  const stamp = `${subject.key}:${tier}`;
  if (fired.includes(stamp)) return null;
  return { branch: subject.key, label: subject.label, count, tier, stamp };
}
