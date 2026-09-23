import { existsSync } from "node:fs";
import path from "node:path";

// Round guard, Codex port (contract 5.3). The rules are a verbatim port of
// ~/.claude/hooks/round-guard.sh: pushes per branch over the session, the most
// recently pushed branch as subject, tiers 5/10/15/20, once per
// (session, branch, tier), except the named divergences: HEAD and bare pushes
// keyed by directory (revision 15), and only command-position pushes counted
// (revision 16). Stamps live in the dispatcher's session state.

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
function directoryOf(cmd, workdir) {
  const cd = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/.exec(cmd);
  return cd ? resolve(unquote(cd[1]), workdir) : workdir ?? null;
}

function originalMatch(cmd, masked) {
  const original = cmd.slice(masked.index, masked.index + masked[0].length);
  const again = new RegExp(PUSH.source).exec(original);
  return again ?? masked;
}

// Every push in one command, as the subject it counts against.
export function pushesIn({ cmd, workdir = null }) {
  const found = [];
  for (const masked of maskQuotes(cmd).matchAll(PUSH)) {
    // Match on the masked text; read -C and the arguments from the original.
    const match = originalMatch(cmd, masked);
    const refspec = REFSPEC.exec(match[2]);
    let branch = refspec ? refspec[1] : "<current-branch>";
    if (FLAGS.has(branch)) branch = "<current-branch>";
    if (branch !== "HEAD" && branch !== "<current-branch>") { found.push({ key: branch, label: `\`${branch}\`` }); continue; }
    // Revision 15: HEAD and bare pushes are keyed by directory, so pushes from
    // different repositories are never counted as one change's rounds.
    const base = directoryOf(cmd, workdir);
    const dir = match[1] ? resolve(unquote(match[1]), base) : base;
    found.push(dir ? { key: `${branch}@${dir}`, label: `the current branch in ${dir}` } : { key: branch, label: `\`${branch}\`` });
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

export function roundReason({ label, count }, home) {
  const contract = path.join(home, ".codex", "hooks", "CONTRACT.md");
  const pointer = existsSync(contract) ? ` See ${contract}, which is exactly this diagnosis for the git guard.` : "";
  return `[round-guard] ${count} pushes to ${label} in this session. That is ${count} review rounds on one change.\n\nThis is the ATLAS #2361 pattern: nine rounds and ~18 hours on a read-only PR, where three of the last five rounds fixed defects introduced while fixing the previous round. The operator had to notice.\n\nBefore pushing again, answer these IN YOUR REPLY, briefly, not as a document:\n\n  1. ROOT CAUSE. Do the recent findings share a class? Name it. If each round finds "another construct" of the same kind, the enforcement point is in the wrong place and more rounds will not converge.${pointer}\n\n  2. YOUR OWN CHURN. How many of the last rounds fixed something YOU introduced in the previous round? Say the number. That share is not review thoroughness; it is rework.\n\n  3. THE CUT. What would stopping look like? Name the smallest thing that is genuinely blocking (runtime behaviour, money, auth, data loss) versus what is bookkeeping (plan docs, contract tables, comment wording). Bookkeeping is not a reason to continue a loop.\n\n  4. THE DECISION. Recommend one: merge now on green, defer the rest to a follow-up issue, or continue, and say why. Give the operator the call rather than starting the next round by default.\n\nIf you have already done this in this turn, say so and continue.`;
}

export function checkRounds({ commands, fired, home }) {
  const verdict = roundVerdict(commands, fired);
  return verdict ? { code: "round-guard", kind: "stop-round", reason: roundReason(verdict, home), stamp: verdict.stamp } : null;
}
