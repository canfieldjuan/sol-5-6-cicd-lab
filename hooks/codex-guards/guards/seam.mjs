import { segments, withoutHeredocs } from "../lib/shell.mjs";
import { pushesIn } from "../stop/round-guard.mjs";

// Seam redirect (contract 5.4, revision 18). At the start of each fix round
// the model gets a short list of next actions: trace the finding to the change
// that introduced it, give a duplicated rule one owner, edit the canonical doc,
// then make that fix. Context only (SR1): it never denies, blocks, records a
// pending redirect, asks for a reply, or offers a decision. It reads only the
// hook input and the session state (SR4).
//
// R1 review read (PostToolUse), R2 re-push of an own branch (PreToolUse), R3
// follow-up PR on own work (PreToolUse). At most one redirect per key per push
// epoch (SR3); R2 also stays quiet when any redirect already fired in the epoch.

export const CODE = "seam-redirect";

const REVIEW_FIELDS = new Set(["comments", "reviews", "latestReviews"]);
const FIELD_FLAGS = new Set(["-f", "-F", "--field", "--raw-field"]);
// gh flags that take a value, so the value is not mistaken for a positional.
const VALUE_FLAGS = new Set([
  "-R", "--repo", "--json", "-q", "--jq", "-t", "--template", "-X", "--method", "-H", "--header",
  "-f", "-F", "--field", "--raw-field", "--input", "-p", "--preview", "--hostname", "--cache",
  "-B", "--base", "--head", "--title", "-b", "--body", "--body-file", "-a", "--assignee",
  "-l", "--label", "-m", "--milestone", "-r", "--reviewer", "--project", "--recover", "--pr"
]);
const FIX_TITLE = /\b(fix(es|ed)?|follow[- ]?up|regression|revert|repair|restore|correct)\b/i;

export function emptySeam() {
  return { epoch: 0, pushes: {}, own: [], merged: false, rounds: {}, stamps: {}, lastEpoch: -1 };
}

function commandWords(command) {
  const parsed = segments(withoutHeredocs(String(command)));
  if (!parsed) return [];
  // Drop VAR=value prefixes; `cd` and the like are their own segments.
  return parsed.map((words) => { let i = 0; while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1; return words.slice(i); }).filter((words) => words.length);
}

// Flags (with `--flag=value` split) and positionals of one gh invocation.
function readArgs(words) {
  const flags = new Map();
  const positionals = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word.startsWith("-") && word !== "-") {
      const eq = word.indexOf("=");
      const name = eq > 1 && word.startsWith("--") ? word.slice(0, eq) : word;
      const value = eq > 1 && word.startsWith("--") ? word.slice(eq + 1) : VALUE_FLAGS.has(word) ? words[++i] : true;
      flags.set(name, [...(flags.get(name) ?? []), value]);
    } else positionals.push(word);
  }
  const first = (...names) => names.map((name) => flags.get(name)?.[0]).find((value) => value !== undefined);
  const all = (...names) => names.flatMap((name) => flags.get(name) ?? []);
  return { flags, positionals, first, all };
}

function prKey(positional) {
  if (positional === undefined) return "current";
  const url = /\/pull\/(\d+)/.exec(positional);
  if (url) return url[1];
  return positional.replace(/^#/, "");
}

const REST_REVIEW = /^\/?repos\/[^/]+\/[^/]+\/(?:pulls\/(\d+)\/(?:comments|reviews)(?:\/.*)?|issues\/(\d+)\/comments(?:\/.*)?)$/;

// PR keys a command reads review feedback for (R1). Writes are excluded.
export function reviewReads(command) {
  const keys = [];
  for (const words of commandWords(command)) {
    const tool = words[0].split("/").pop();
    if (tool === "codex-pr-status") {
      const pr = readArgs(words.slice(1)).first("--pr");
      if (typeof pr === "string") keys.push(pr);
      continue;
    }
    if (tool !== "gh") continue;
    if (words[1] === "pr" && words[2] === "view") {
      const args = readArgs(words.slice(3));
      const fields = String(args.first("--json") ?? "").split(",");
      if (args.flags.has("--comments") || args.flags.has("-c") || fields.some((field) => REVIEW_FIELDS.has(field))) keys.push(prKey(args.positionals[0]));
      continue;
    }
    if (words[1] !== "api") continue;
    const args = readArgs(words.slice(2));
    const endpoint = String(args.positionals[0] ?? "");
    const explicit = args.first("-X", "--method");
    const method = String(explicit ?? "GET").toUpperCase();
    if (args.flags.has("--input") || method !== "GET") continue;
    if (endpoint === "graphql") {
      const query = args.all("-f", "-F", "--field", "--raw-field").filter((value) => typeof value === "string" && value.startsWith("query=")).map((value) => value.slice(6)).join("\n");
      if (!query || /^\s*mutation\b/.test(query) || !/\b(reviewThreads|reviews|comments)\b/.test(query)) continue;
      for (const match of query.matchAll(/pullRequest\s*\(\s*number\s*:\s*(\d+)/g)) keys.push(match[1]);
      continue;
    }
    const path = endpoint.split("?")[0];
    // Field flags make gh send a POST unless the method is stated as GET.
    if (path.endsWith("/replies") || (explicit === undefined && [...FIELD_FLAGS].some((flag) => args.flags.has(flag)))) continue;
    const rest = REST_REVIEW.exec(path);
    if (rest) keys.push(rest[1] ?? rest[2]);
  }
  return [...new Set(keys)];
}

// `gh pr create` details (R3), or null.
export function prCreate(command) {
  for (const words of commandWords(command)) {
    if (words[0].split("/").pop() !== "gh" || words[1] !== "pr" || words[2] !== "create") continue;
    const args = readArgs(words.slice(3));
    const text = (value) => (typeof value === "string" ? value : null);
    return { base: text(args.first("--base", "-B")), title: text(args.first("--title", "-t")), head: text(args.first("--head", "-H")) };
  }
  return null;
}

// Branch names a command shows the session created (own-branch sources).
export function createdBranches(command) {
  const names = [];
  for (const words of commandWords(command)) {
    if (words[0].split("/").pop() !== "git") continue;
    let i = 1;
    while (i < words.length && words[i] === "-C") i += 2;
    const [verb, ...rest] = words.slice(i);
    const after = (flags) => { const index = rest.findIndex((word) => flags.includes(word)); return index >= 0 ? rest[index + 1] : undefined; };
    const name = verb === "checkout" ? after(["-b", "-B"]) : verb === "switch" ? after(["-c", "-C", "--create", "--force-create"]) : verb === "worktree" && rest[0] === "add" ? after(["-b", "-B"]) : undefined;
    if (name && !name.startsWith("-")) names.push(name);
  }
  return names;
}

export function isPrMerge(command) {
  return commandWords(command).some((words) => words[0].split("/").pop() === "gh" && words[1] === "pr" && words[2] === "merge");
}

// Up to 3 {path, line} pairs from review output that parses as JSON (one
// document, or one per line as `--jq` prints). Anything else: none.
export function findingLocations(response, limit = 3) {
  const text = typeof response === "string" ? response : JSON.stringify(response ?? "");
  const documents = [];
  try { documents.push(JSON.parse(text)); } catch {
    for (const line of text.split("\n")) { try { documents.push(JSON.parse(line)); } catch {} }
  }
  const found = [];
  const seen = new Set();
  const walk = (value) => {
    if (found.length >= limit || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    const line = Number.isInteger(value.line) ? value.line : Number.isInteger(value.original_line) ? value.original_line : null;
    if (safePath(value.path) && line !== null && line > 0) {
      const key = `${value.path}:${line}`;
      if (!seen.has(key)) { seen.add(key); found.push({ path: value.path, line }); }
    }
    for (const child of Object.values(value)) walk(child);
  };
  documents.forEach(walk);
  return found.slice(0, limit);
}

// Review-derived paths are untrusted and the model may run the command it is
// shown (contract 5.4): a path with a control character or a backslash, over
// 200 characters, or starting with "-" is dropped; any other path that is not
// plain is single-quoted.
export function safePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !value.startsWith("-") && !/[\u0000-\u001f\u007f\\]/.test(value);
}

export const quoteArg = (value) => (/^[A-Za-z0-9_./@+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`);

function traceText(locations) {
  if (!locations.length) return "git blame -L <line>,<line> <path> for each finding";
  return locations.map(({ path, line }) => `git log -L ${line},${line}:${quoteArg(path)}`).join("; ");
}

const prName = (key) => (key === "current" ? "the current branch's PR" : /^\d+$/.test(key) ? `PR #${key}` : `PR ${key}`);

export function reviewText(keys, round, roundKey, locations) {
  const names = keys.map(prName);
  const lines = [`[seam-redirect] Review feedback on ${names.join(", ")}. Before patching the line a finding points at:`];
  if (round >= 2) lines.push(`Review round ${round} on ${prName(roundKey)}: findings that keep arriving in one class mean the rule lives in more than one place. Consolidate it at one owner in the next commit, instead of fixing the next finding by itself.`);
  lines.push(
    `- Trace where it came from: ${traceText(locations)}. If the line came from an earlier change in this session, fix that change; do not add a check after it.`,
    "- Find the other copies: search code, tests, and docs for the rule, constant, or field the finding names (rg -n '<name>'). If it lives in more than one place, give it one owner and make the others use it.",
    "- If a doc restates the contract, edit the canonical doc and link to it.",
    "Then make that fix."
  );
  return lines.join("\n");
}

export function pushText(round, label) {
  if (round === 2) return `[seam-redirect] Push 2 to ${label} is a fix round on your own change. If this fix added a case beside an existing one, move the rule to one owner in the next commit; trace it with git blame -L or git log -L first.`;
  return `[seam-redirect] Push ${round} to ${label}: ${round - 1} fix rounds on one change. Findings that keep arriving in one class mean the rule lives in more than one place. Next commit: trace the class to the change that introduced it and consolidate it at one owner, instead of fixing the next finding by itself.`;
}

export function followupText(source, target) {
  return [
    `[seam-redirect] This PR repairs this session's own work (${source}). Put the fix where the defect came from:`,
    `- If ${target} is not merged yet, commit the fix on ${target} instead of stacking a new PR on it.`,
    "- If it merged, fix the rule at its owner and name the introducing commit in the PR body."
  ].join("\n");
}

const clone = (seam) => ({ ...emptySeam(), ...(seam ?? {}), pushes: { ...(seam?.pushes ?? {}) }, own: [...(seam?.own ?? [])], rounds: { ...(seam?.rounds ?? {}) }, stamps: { ...(seam?.stamps ?? {}) } });

// PreToolUse: R2 and R3, and the push epoch. With emit false (the call was
// rewritten by another guard), counters move but nothing fires or is stamped.
export function seamBefore({ command, cwd = null, seam, emit = true }) {
  const next = clone(seam);
  const fired = [];
  const pushes = pushesIn({ cmd: String(command), workdir: cwd });
  for (const push of pushes) {
    const round = (next.pushes[push.key] ?? 0) + 1;
    const stamp = `push:${push.key}`;
    if (emit && round >= 2 && next.lastEpoch !== next.epoch && next.stamps[stamp] !== next.epoch) {
      fired.push({ kind: "push", reason: pushText(round, push.label) });
      next.stamps[stamp] = next.epoch;
      next.lastEpoch = next.epoch;
    }
    next.pushes[push.key] = round;
    if (!push.key.includes("@") && !next.own.includes(push.key)) next.own.push(push.key);
    next.epoch += 1;
  }
  for (const name of createdBranches(command)) if (!next.own.includes(name)) next.own.push(name);
  const create = prCreate(command);
  if (create) {
    const stacked = create.base && next.own.includes(create.base);
    const fixTitled = next.merged && create.title && FIX_TITLE.test(create.title);
    const key = `followup:${stacked ? create.base : create.title}`;
    if (emit && (stacked || fixTitled) && next.stamps[key] !== next.epoch) {
      const source = stacked ? `stacked on ${create.base}` : "a fix after this session merged a PR";
      fired.push({ kind: "followup", reason: followupText(source, stacked ? create.base : "the PR it repairs") });
      next.stamps[key] = next.epoch;
      next.lastEpoch = next.epoch;
    }
    // The head of a PR this session opened is its own work from now on.
    if (create.head && !next.own.includes(create.head)) next.own.push(create.head);
  }
  return { fired, seam: next };
}

// PostToolUse: R1, and `gh pr merge` for R3's fix-titled branch.
export function seamAfter({ command, response, seam }) {
  const next = clone(seam);
  const fired = [];
  if (isPrMerge(command)) next.merged = true;
  const fresh = reviewReads(command).filter((key) => next.stamps[`review:${key}`] !== next.epoch);
  if (fresh.length) {
    let round = 0;
    let roundKey = fresh[0];
    for (const key of fresh) {
      next.rounds[key] = (next.rounds[key] ?? 0) + 1;
      next.stamps[`review:${key}`] = next.epoch;
      if (next.rounds[key] > round) { round = next.rounds[key]; roundKey = key; }
    }
    next.lastEpoch = next.epoch;
    fired.push({ kind: "review", reason: reviewText(fresh, round, roundKey, findingLocations(response)) });
  }
  return { fired, seam: next };
}
