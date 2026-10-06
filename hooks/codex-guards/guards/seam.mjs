import path from "node:path";
import { segments, withoutHeredocs } from "../lib/shell.mjs";
import { directoryOf, pushesIn } from "../stop/round-guard.mjs";

// Seam redirect (contract 5.4, revision 18). At the start of each fix round
// the model gets a short list of next actions: trace the finding to the change
// that introduced it, give a duplicated rule one owner, edit the canonical doc,
// then make that fix. Context only (SR1): it never denies, blocks, records a
// pending redirect, asks for a reply, or offers a decision. It reads only the
// hook input and the session state (SR4).
//
// R1 review read (PostToolUse), R2 re-push of an own branch (PreToolUse), R3
// a branch or PR stacked on own work (PreToolUse). At most one redirect per key
// per push epoch (SR3). R2 fires at every re-push, after an R1 too (revision
// 21): R1 comes before the fix exists, R2 checks what the push sends. Epochs
// are per directory scope (revision 19), so a push in one repository does not
// start a new round for another. R1 fires only on the session's own work
// (revision 22), learned from push and `gh pr create` output.

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
// Integration targets, never own work: a PR against them is the normal case,
// and sessions push them in fixture setup (4 false R3s in the noise replay).
const DEFAULT_BRANCHES = new Set(["main", "master"]);

// Repository namespacing (contract 5.4): branch keys carry the command's
// directory, PR keys the stated repository, else the directory. The hook
// cannot see `workdir` (probe Q7), so a repo switch made only through it
// still shares a directory key.
const scopeOf = (dir) => dir ?? "?";
const branchKey = (dir, name) => `${scopeOf(dir)}|${name}`;
const repoScope = (owner, name) => `${owner}/${name}`.toLowerCase();

export function emptySeam() {
  return { epochs: {}, pushes: {}, own: [], rounds: {}, stamps: {}, escalated: {}, ownRepos: [], ownPrs: [] };
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

function prRef(scope, number) {
  const label = number === "current" ? "the current branch's PR" : /^\d+$/.test(number) ? `PR #${number}` : `PR ${number}`;
  return { key: `${scope}#${number}`, label };
}

// The PR a `gh pr view` positional names, and the repository a URL states.
function viewTarget(positional) {
  if (positional === undefined) return { number: "current", repo: null };
  const url = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(positional);
  if (url) return { number: url[3], repo: repoScope(url[1], url[2]) };
  return { number: positional.replace(/^#/, ""), repo: null };
}

// Each pullRequest(number:) in a GraphQL query, with the repository(...) that
// encloses it (the nearest one before it), when the query states one.
function graphqlPulls(query) {
  const repos = [...query.matchAll(/repository\s*\(([^)]*)\)/g)].map((match) => {
    const owner = /owner\s*:\s*"([^"]+)"/.exec(match[1]);
    const name = /name\s*:\s*"([^"]+)"/.exec(match[1]);
    return { index: match.index, repo: owner && name ? repoScope(owner[1], name[1]) : null };
  });
  return [...query.matchAll(/pullRequest\s*\(\s*number\s*:\s*(\d+)/g)].map((match) => {
    const enclosing = repos.filter((repo) => repo.index < match.index).pop();
    return { number: match[1], repo: enclosing?.repo ?? null };
  });
}

const REST_REVIEW = /^\/?repos\/([^/]+)\/([^/]+)\/(?:pulls\/(\d+)\/(?:comments|reviews)(?:\/.*)?|issues\/(\d+)\/comments(?:\/.*)?)$/;

// PRs a command reads review feedback for (R1), as {key, label}. Writes are
// excluded. Keys are scoped by the stated repository, else the directory.
//
// Each read also carries what the own-work check needs (revision 22): the
// number, the stated repository (null when none), the directory, whether it
// came through the issues API, and its -q/--jq/--template filter.
export function reviewReads(command, cwd = null) {
  const found = [];
  const dir = directoryOf(withoutHeredocs(String(command)), cwd);
  const dirScope = `dir:${dir ?? "?"}`;
  const add = (number, repo, extra = {}) => found.push({ ...prRef(repo ?? dirScope, number), number, repo, dir, issue: false, filter: null, ...extra });
  const stated = (args) => { const value = args.first("--repo", "-R"); return typeof value === "string" && value.includes("/") ? repoScope(...value.split("/").slice(-2)) : null; };
  const filterOf = (args) => { const value = args.first("-q", "--jq", "-t", "--template"); return typeof value === "string" ? value : null; };
  for (const words of commandWords(command)) {
    const tool = words[0].split("/").pop();
    if (tool === "codex-pr-status") {
      const args = readArgs(words.slice(1));
      const pr = args.first("--pr");
      if (typeof pr === "string") add(pr, stated(args));
      continue;
    }
    if (tool !== "gh") continue;
    if (words[1] === "pr" && words[2] === "view") {
      const args = readArgs(words.slice(3));
      const fields = String(args.first("--json") ?? "").split(",");
      if (args.flags.has("--comments") || args.flags.has("-c") || fields.some((field) => REVIEW_FIELDS.has(field))) {
        const target = viewTarget(args.positionals[0]);
        add(target.number, target.repo ?? stated(args), { filter: filterOf(args) });
      }
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
      for (const pull of graphqlPulls(query)) add(pull.number, pull.repo, { filter: filterOf(args) });
      continue;
    }
    const path = endpoint.split("?")[0];
    // Field flags make gh send a POST unless the method is stated as GET.
    if (path.endsWith("/replies") || (explicit === undefined && [...FIELD_FLAGS].some((flag) => args.flags.has(flag)))) continue;
    const rest = REST_REVIEW.exec(path);
    if (rest) add(rest[3] ?? rest[4], repoScope(rest[1], rest[2]), { issue: rest[4] !== undefined, filter: filterOf(args) });
  }
  const seen = new Set();
  return found.filter((ref) => !seen.has(ref.key) && seen.add(ref.key));
}

// `gh pr create` details (R3), or null.
export function prCreate(command) {
  for (const words of commandWords(command)) {
    if (words[0].split("/").pop() !== "gh" || words[1] !== "pr" || words[2] !== "create") continue;
    const args = readArgs(words.slice(3));
    const text = (value) => (typeof value === "string" ? value : null);
    return { base: text(args.first("--base", "-B")), head: text(args.first("--head", "-H")) };
  }
  return null;
}

// Branches a command shows the session created (own-branch sources), each
// with its start point when stated and the `git -C` directory when stated.
export function createdBranches(command) {
  const created = [];
  for (const words of commandWords(command)) {
    if (words[0].split("/").pop() !== "git") continue;
    let i = 1;
    let dir = null;
    while (i < words.length && words[i] === "-C") { dir = words[i + 1] ?? null; i += 2; }
    const [verb, ...rest] = words.slice(i);
    // Only the forms git refuses on an existing branch prove creation; -B, -C,
    // and --force-create also reset one (`git checkout -B develop origin/develop`).
    const flags = verb === "checkout" ? ["-b"] : verb === "switch" ? ["-c", "--create"] : verb === "worktree" && rest[0] === "add" ? ["-b"] : null;
    if (!flags) continue;
    const at = rest.findIndex((word) => flags.includes(word));
    const name = at >= 0 ? rest[at + 1] : undefined;
    if (!name || name.startsWith("-")) continue;
    // Positionals after the new name: [start] for checkout/switch, <path> [start] for worktree add.
    const positionals = rest.slice(at + 2).filter((word) => !word.startsWith("-"));
    const start = (verb === "worktree" ? positionals[1] : positionals[0]) ?? null;
    created.push({ name, dir, start });
  }
  return created;
}

// The JSON documents in a tool output: one document, or one per line as
// `--jq` prints. Text that is not JSON gives none.
function jsonDocuments(response) {
  const text = typeof response === "string" ? response : JSON.stringify(response ?? "");
  try { return [JSON.parse(text)]; } catch {}
  const documents = [];
  for (const line of text.split("\n")) { try { documents.push(JSON.parse(line)); } catch {} }
  return documents;
}

// R1 fires only when review text arrived (contract 5.4): a JSON output with a
// non-empty `body` anywhere, or non-empty output that is not JSON. A status
// check that includes `reviews` but carries no review text, and an empty
// output, do not fire.
// filter: the read's -q/--jq/--template. Output that is not JSON is review
// text only when no filter printed it, or the filter names `body`: a filter
// that prints thread states or counts leaves none (revision 22).
export function hasReviewText(response, filter = null) {
  const text = typeof response === "string" ? response : JSON.stringify(response ?? "");
  if (!text.trim()) return false;
  const documents = jsonDocuments(text);
  if (!documents.length) return filter === null || /body/.test(filter);
  const walk = (value) => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(walk);
    if (typeof value.body === "string" && value.body.trim()) return true;
    return Object.values(value).some(walk);
  };
  return documents.some(walk);
}

// Up to 3 {path, line} pairs from review output that parses as JSON.
export function findingLocations(response, limit = 3) {
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
  jsonDocuments(response).forEach(walk);
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

// labels: the PRs read ("PR #12"); roundLabel: the one with the most review
// rounds, named in the escalation line from round 2.
export function reviewText(labels, round, roundLabel, locations) {
  const lines = [`[seam-redirect] Review feedback on ${[...new Set(labels)].join(", ")}. Before patching the line a finding points at:`];
  if (round >= 2) lines.push(`Review round ${round} on ${roundLabel}: findings that keep arriving in one class mean the rule lives in more than one place. Consolidate it at one owner in the next commit, instead of fixing the next finding by itself.`);
  lines.push(
    `- Trace where it came from: ${traceText(locations)}. If the line came from an earlier change in this session, fix that change; do not add a check after it.`,
    "- Find the other copies: search code, tests, and docs for the rule, constant, or field the finding names (rg -n '<name>'). If it lives in more than one place, give it one owner and make the others use it.",
    "- If a doc restates the contract, edit the canonical doc and link to it.",
    "Then make that fix."
  );
  return lines.join("\n");
}

export const PUSH_ESCALATION = "- Findings that keep arriving in one class mean the rule lives in more than one place: trace the class to the change that introduced it (git log -L) and consolidate it at one owner, instead of fixing the next finding by itself.";

// R2 checks what the push sends (revision 21). escalate: add the escalation
// line, which the caller leaves out when R1's review-round line carried it in
// this epoch, so one redirect per round owns it.
export function pushText(round, label, escalate = false) {
  const lines = [
    `[seam-redirect] Push ${round} to ${label} sends fix round ${round - 1} on your own change. Read the diff it sends before the next review does:`,
    "- If the fix restates a rule in a second place, or adds a case beside an existing one, move the rule to one owner in the next commit (rg -n '<name>' finds the copies)."
  ];
  if (escalate) lines.push(PUSH_ESCALATION);
  return lines.join("\n");
}

// R3 at a branch started from own work: before any work exists.
export function branchText(name, start) {
  return `[seam-redirect] ${name} starts from this session's own unmerged work (${start}). If it fixes a defect ${start} introduced, commit the fix on ${start} instead of a new branch, so the fix lands where the defect came from.`;
}

// R3 at a PR stacked on own work: the create has run (Q10), so the text is
// for after it exists. A title or an earlier merge does not tie a PR to the
// session's work, so only the base triggers it.
export function followupText(base) {
  return [
    `[seam-redirect] This PR is stacked on this session's own work (${base}). If it fixes a defect ${base} introduced, put the fix where the defect came from:`,
    `- If ${base} is not merged yet, move the fix onto ${base} and close this PR as superseded.`,
    "- If it merged, fix the rule at its owner and name the introducing commit in the PR body."
  ].join("\n");
}

// A revision 20 state's `lastFired` is dropped: nothing reads it since R2 no
// longer waits on other redirects (revision 21).
const clone = (seam) => {
  const { lastFired, ...rest } = seam ?? {};
  return { ...emptySeam(), ...rest, epochs: { ...(seam?.epochs ?? {}) }, pushes: { ...(seam?.pushes ?? {}) }, own: [...(seam?.own ?? [])], rounds: { ...(seam?.rounds ?? {}) }, stamps: { ...(seam?.stamps ?? {}) }, escalated: { ...(seam?.escalated ?? {}) }, ownRepos: [...(seam?.ownRepos ?? [])], ownPrs: [...(seam?.ownPrs ?? [])] };
};

// Own work (contract 5.4, revision 22), learned from tool output only (SR4):
// the `To` line of a push names a repository the session pushed to (git
// prints it without the user), and the URL line `gh pr create` prints names a
// PR it opened.
const TO_LINE = /^To (?:https:\/\/(?:[^@\s/]+@)?github\.com\/|(?:git@)?github\.com:|ssh:\/\/(?:git@)?github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?\s*$/gm;
const PR_URL_LINE = /^\s*https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\s*$/gm;

export function learnedOwnership(command, response, cwd = null) {
  const text = typeof response === "string" ? response : JSON.stringify(response ?? "");
  const repos = [];
  const prs = [];
  if (pushesIn({ cmd: String(command), workdir: cwd }).length) for (const match of text.matchAll(TO_LINE)) repos.push(repoScope(match[1], match[2]));
  if (prCreate(command)) {
    for (const match of text.matchAll(PR_URL_LINE)) {
      const repo = repoScope(match[1], match[2]);
      repos.push(repo);
      prs.push(`${repo}#${match[3]}`);
    }
  }
  return { repos, prs };
}

// A read that states a repository is someone else's work until the session
// pushes there or opens that PR; one that states none is own work from the
// hook cwd or a directory the session pushed from. An issue thread counts only
// for a PR the session opened.
function ownWork(seam, ref, cwd) {
  const pr = `${ref.repo}#${ref.number}`;
  if (ref.issue) return seam.ownPrs.includes(pr);
  if (ref.repo) return seam.ownRepos.includes(ref.repo) || seam.ownPrs.includes(pr);
  return ref.dir === (cwd ?? null) || epochOf(seam, ref.dir) >= 1;
}

// The current epoch of a directory scope, and the stamp value for it: a stamp
// records its scope, so one key read from two scopes never shares an epoch.
const epochOf = (seam, dir) => seam.epochs[scopeOf(dir)] ?? 0;
const markOf = (seam, dir) => `${scopeOf(dir)}@${epochOf(seam, dir)}`;
const stampFired = (seam, dir, stamp) => { seam.stamps[stamp] = markOf(seam, dir); };
// `escalated[scope]` is the epoch in which R1 last sent its review-round line.
const escalatedIn = (seam, dir) => seam.escalated[scopeOf(dir)] === epochOf(seam, dir);

// PreToolUse: R2 and R3, and the push epoch. With emit false (the call was
// rewritten by another guard), counters move but nothing fires or is stamped.
export function seamBefore({ command, cwd = null, seam, emit = true }) {
  const next = clone(seam);
  const fired = [];
  const own = (dir, name) => { if (name && !DEFAULT_BRANCHES.has(name) && !next.own.includes(branchKey(dir, name))) next.own.push(branchKey(dir, name)); };
  const dir = directoryOf(withoutHeredocs(String(command)), cwd);
  for (const push of pushesIn({ cmd: String(command), workdir: cwd })) {
    // Named branches are scoped by the push's directory; HEAD and bare keys
    // already carry it.
    const subject = push.named ? branchKey(push.dir, push.key) : push.key;
    const round = (next.pushes[subject] ?? 0) + 1;
    const stamp = `push:${subject}`;
    if (emit && round >= 2 && next.stamps[stamp] !== markOf(next, push.dir)) {
      fired.push({ kind: "push", reason: pushText(round, push.label, round >= 3 && !escalatedIn(next, push.dir)) });
      stampFired(next, push.dir, stamp);
    }
    next.pushes[subject] = round;
    // A push alone is not ownership (contract 5.4): shared branches get pushed too.
    next.epochs[scopeOf(push.dir)] = epochOf(next, push.dir) + 1;
  }
  for (const created of createdBranches(command)) {
    const where = created.dir ? (path.isAbsolute(created.dir) || !dir ? created.dir : path.join(dir, created.dir)) : dir;
    // R3, earliest: a new branch started from own unmerged work.
    const stamp = `followup:${branchKey(where, created.name)}`;
    if (emit && created.start && !DEFAULT_BRANCHES.has(created.start) && next.own.includes(branchKey(where, created.start)) && next.stamps[stamp] !== markOf(next, where)) {
      fired.push({ kind: "followup", reason: branchText(created.name, created.start) });
      stampFired(next, where, stamp);
    }
    own(where, created.name);
  }
  const create = prCreate(command);
  if (create) {
    const stacked = Boolean(create.base) && !DEFAULT_BRANCHES.has(create.base) && next.own.includes(branchKey(dir, create.base));
    const key = `followup:${branchKey(dir, create.base)}`;
    if (emit && stacked && next.stamps[key] !== markOf(next, dir)) {
      fired.push({ kind: "followup", reason: followupText(create.base) });
      stampFired(next, dir, key);
    }
    // The head of a PR this session opened is its own work from now on.
    own(dir, create.head);
  }
  return { fired, seam: next };
}

// PostToolUse: R1.
export function seamAfter({ command, response, cwd = null, seam }) {
  const next = clone(seam);
  const fired = [];
  // Learned first, so a script that pushes and then reads counts its own push.
  const learned = learnedOwnership(command, response, cwd);
  for (const repo of learned.repos) if (!next.ownRepos.includes(repo)) next.ownRepos.push(repo);
  for (const pr of learned.prs) if (!next.ownPrs.includes(pr)) next.ownPrs.push(pr);
  // Someone else's PR, or no review text: no redirect, and no stamp consumed.
  const reads = reviewReads(command, cwd).filter((ref) => ownWork(next, ref, cwd) && hasReviewText(response, ref.filter));
  // A read is measured against the pushes of the scope it runs in.
  const dir = directoryOf(withoutHeredocs(String(command)), cwd);
  const fresh = reads.filter((ref) => next.stamps[`review:${ref.key}`] !== markOf(next, dir));
  if (fresh.length) {
    let round = 0;
    let roundLabel = fresh[0].label;
    for (const ref of fresh) {
      next.rounds[ref.key] = (next.rounds[ref.key] ?? 0) + 1;
      stampFired(next, dir, `review:${ref.key}`);
      if (next.rounds[ref.key] > round) { round = next.rounds[ref.key]; roundLabel = ref.label; }
    }
    fired.push({ kind: "review", reason: reviewText(fresh.map((ref) => ref.label), round, roundLabel, findingLocations(response)) });
    // reviewText adds its review-round line from round 2; R2 then leaves its own out.
    if (round >= 2) next.escalated[scopeOf(dir)] = epochOf(next, dir);
  }
  return { fired, seam: next };
}
