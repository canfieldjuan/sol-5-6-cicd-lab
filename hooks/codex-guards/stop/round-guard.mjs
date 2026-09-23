import { existsSync } from "node:fs";
import path from "node:path";

// Round guard, Codex port (contract 5.3). The rules are a verbatim port of
// ~/.claude/hooks/round-guard.sh: pushes per branch over the session, the most
// recently pushed branch as subject, tiers 5/10/15/20, once per
// (session, branch, tier), except the revision-15 keying of HEAD and bare
// pushes by working directory. Stamps live in the dispatcher's session state.

const TIERS = [5, 10, 15, 20];
const REFSPEC = /git push[^\n|;&]*?\borigin\s+(?:HEAD:)?([\w./-]+)/;
const FLAGS = new Set(["--force", "--force-with-lease", "-q", "--quiet"]);

function branchOf(command) {
  const match = REFSPEC.exec(command);
  const branch = match ? match[1] : "<current-branch>";
  return FLAGS.has(branch) ? "<current-branch>" : branch;
}

// A leading `cd <dir> &&` overrides the call's workdir (relative to it).
function directoryOf({ cmd, workdir }) {
  const cd = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*&&/.exec(cmd);
  const target = cd ? cd[1] ?? cd[2] ?? cd[3] : null;
  if (target && target.startsWith("/")) return path.normalize(target);
  if (target && workdir) return path.join(workdir, target);
  return workdir ?? null;
}

// Revision 15: HEAD and bare pushes are keyed by working directory, so pushes
// from different repositories are never counted as one change's rounds.
function subjectOf(entry) {
  const item = typeof entry === "string" ? { cmd: entry, workdir: null } : entry;
  const branch = branchOf(item.cmd);
  if (branch !== "HEAD" && branch !== "<current-branch>") return { key: branch, label: `\`${branch}\`` };
  const dir = directoryOf(item);
  return dir ? { key: `${branch}@${dir}`, label: `the current branch in ${dir}` } : { key: branch, label: `\`${branch}\`` };
}

export function roundVerdict(commands, fired = []) {
  const pushCommands = commands.filter((entry) => (typeof entry === "string" ? entry : entry.cmd).includes("git push"));
  if (!pushCommands.length) return null;
  const pushes = new Map();
  for (const entry of pushCommands) { const { key } = subjectOf(entry); pushes.set(key, (pushes.get(key) ?? 0) + 1); }
  const subject = subjectOf(pushCommands[pushCommands.length - 1]);
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
