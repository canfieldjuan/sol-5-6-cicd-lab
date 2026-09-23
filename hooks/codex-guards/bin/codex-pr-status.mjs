#!/usr/bin/env node
// codex-pr-status (contract 5.2): one call for what agents keep guessing with
// gh --json fields and hand-written GraphQL. Queries are the verified ones from
// Atlas scripts/check_ai_reconciliation_live.py (threads/reviews, paginated,
// head-consistent) and the pr view / pr checks field sets from atlas-pr-watch.
//
// Usage: codex-pr-status --repo OWNER/NAME --pr N
// Prints one JSON object on stdout; on error prints {"error": ...} and exits 2.
import { spawnSync } from "node:child_process";

const MAX_PAGES = 20;
const PR_FIELDS = "number,title,url,baseRefName,headRefName,headRefOid,mergeStateStatus,mergeable,reviewDecision,isDraft,state";
const CHECK_FIELDS = "name,state,bucket,link,workflow";

const THREADS_QUERY = `query($owner:String!,$name:String!,$pr:Int!,$cursor:String){
  repository(owner:$owner,name:$name){ pullRequest(number:$pr){ headRefOid
    reviewThreads(first:100, after:$cursor){ pageInfo{ hasNextPage endCursor }
      nodes{ isResolved isOutdated path line comments(first:1){ nodes{ author{ login } bodyText } } } } } } }`;
const REVIEWS_QUERY = `query($owner:String!,$name:String!,$pr:Int!,$cursor:String){
  repository(owner:$owner,name:$name){ pullRequest(number:$pr){ headRefOid
    reviews(first:100, after:$cursor){ pageInfo{ hasNextPage endCursor }
      nodes{ author{ login } commit{ oid } state } } } } }`;

export function gh(args, env = process.env) {
  const bin = env.CODEX_PR_STATUS_GH || "gh";
  const result = spawnSync(bin, args, { encoding: "utf8", timeout: 60000, env });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function parseJson(text, label) {
  try { return JSON.parse(text); } catch { throw new Error(`${label}: gh did not return JSON`); }
}

// Paginates one connection; the PR head must not change mid-pagination.
export function paginate(query, key, { owner, name, pr }, run) {
  const nodes = [];
  let head = null;
  let cursor = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const args = ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `pr=${pr}`];
    if (cursor) args.push("-F", `cursor=${cursor}`);
    const result = run(args);
    if (result.code !== 0) throw new Error(`${key}: gh api graphql failed: ${result.stderr.trim().slice(0, 300)}`);
    const data = parseJson(result.stdout, key);
    if (data.errors) throw new Error(`${key}: GraphQL errors: ${JSON.stringify(data.errors).slice(0, 300)}`);
    const pull = data?.data?.repository?.pullRequest;
    if (!pull || typeof pull.headRefOid !== "string") throw new Error(`${key}: response has no pullRequest.headRefOid`);
    if (head && pull.headRefOid !== head) throw new Error(`${key}: PR head changed during pagination`);
    head = pull.headRefOid;
    const connection = pull[key];
    if (!connection || !Array.isArray(connection.nodes)) throw new Error(`${key}: response has no nodes`);
    nodes.push(...connection.nodes);
    if (!connection.pageInfo?.hasNextPage) return { head, nodes };
    cursor = connection.pageInfo.endCursor;
    if (!cursor) throw new Error(`${key}: hasNextPage without endCursor`);
  }
  throw new Error(`${key}: more than ${MAX_PAGES} pages`);
}

// gh pr checks exits 8 while pending and 1 on failures; the JSON is still valid.
function checks(repo, pr, required, run) {
  const result = run(["pr", "checks", String(pr), "--repo", repo, "--json", CHECK_FIELDS, ...(required ? ["--required"] : [])]);
  try {
    const list = JSON.parse(result.stdout);
    if (Array.isArray(list)) return list.map((c) => ({ name: c.name, bucket: c.bucket, state: c.state, workflow: c.workflow || null, link: c.link || null }));
  } catch {}
  if (/no (required )?checks reported/i.test(result.stderr + result.stdout)) return [];
  throw new Error(`pr checks${required ? " --required" : ""}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
}

export function prStatus({ repo, pr }, run = (args) => gh(args)) {
  const [owner, name] = repo.split("/");
  if (!owner || !name || !/^\d+$/.test(String(pr))) throw new Error("usage: codex-pr-status --repo OWNER/NAME --pr N");
  const view = run(["pr", "view", String(pr), "--repo", repo, "--json", PR_FIELDS]);
  if (view.code !== 0) throw new Error(`pr view: ${view.stderr.trim().slice(0, 300)}`);
  const meta = parseJson(view.stdout, "pr view");
  const all = checks(repo, pr, false, run);
  const required = checks(repo, pr, true, run);
  const threads = paginate(THREADS_QUERY, "reviewThreads", { owner, name, pr }, run);
  const reviews = paginate(REVIEWS_QUERY, "reviews", { owner, name, pr }, run);
  if (threads.head !== meta.headRefOid || reviews.head !== meta.headRefOid) throw new Error("PR head changed between queries; retry");
  const count = (list, bucket) => list.filter((c) => c.bucket === bucket).length;
  const unresolved = threads.nodes.filter((t) => !t.isResolved);
  return {
    repo, pr: Number(pr), title: meta.title, url: meta.url, state: meta.state, isDraft: meta.isDraft,
    head: { ref: meta.headRefName, sha: meta.headRefOid }, base: meta.baseRefName,
    mergeable: meta.mergeable ?? null, mergeStateStatus: meta.mergeStateStatus, reviewDecision: meta.reviewDecision || null,
    checks: {
      required: { total: required.length, pass: count(required, "pass"), fail: count(required, "fail"), pending: count(required, "pending"), list: required },
      all: { total: all.length, pass: count(all, "pass"), fail: count(all, "fail"), pending: count(all, "pending"), skipping: count(all, "skipping"), list: all }
    },
    reviews: reviews.nodes.map((r) => ({ author: r.author?.login ?? null, state: r.state, onHead: r.commit?.oid === meta.headRefOid })),
    threads: {
      unresolved: unresolved.length,
      unresolvedOutdated: unresolved.filter((t) => t.isOutdated).length,
      list: unresolved.map((t) => ({ path: t.path, line: t.line, outdated: t.isOutdated, author: t.comments?.nodes?.[0]?.author?.login ?? null, body: (t.comments?.nodes?.[0]?.bodyText ?? "").slice(0, 300) }))
    }
  };
}

function arg(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function main(argv = process.argv.slice(2), run = (args) => gh(args), out = (t) => process.stdout.write(t), err = (t) => process.stderr.write(t)) {
  try {
    out(JSON.stringify(prStatus({ repo: arg(argv, "--repo") ?? "", pr: arg(argv, "--pr") ?? "" }, run), null, 2) + "\n");
    return 0;
  } catch (error) {
    err(JSON.stringify({ error: error.message }) + "\n");
    return 2;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) process.exit(main());
