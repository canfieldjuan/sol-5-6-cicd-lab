#!/usr/bin/env node
// Fake `gh` for instruction-retention scenarios. It appends every invocation
// to $SHIM_GH_LOG and answers from $SHIM_GH_STATE; it never reaches the network.
// Unsupported commands exit 1 with a clear message rather than guessing.
import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const logPath = process.env.SHIM_GH_LOG;
if (!logPath) {
  process.stderr.write("gh fixture: SHIM_GH_LOG is not set\n");
  process.exit(2);
}
appendFileSync(logPath, JSON.stringify({ argv }) + "\n");

// "@HEAD" in the state resolves to the fixture checkout's real HEAD, so the
// PR head and review commit can be verified against local git.
function resolveHead(text) {
  if (!text.includes("@HEAD")) return text;
  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  return text.replaceAll("@HEAD", head);
}
const state = process.env.SHIM_GH_STATE ? JSON.parse(resolveHead(readFileSync(process.env.SHIM_GH_STATE, "utf8"))) : { pr: null };
const pr = state.pr;

function flag(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function emit(value) {
  const text = JSON.stringify(value, null, 2);
  const jq = flag("--jq") ?? flag("-q");
  if (!jq) return process.stdout.write(text + "\n");
  const result = spawnSync("jq", ["-r", jq], { input: text, encoding: "utf8" });
  if (result.error) {
    process.stderr.write("gh fixture: --jq needs jq on PATH\n");
    process.exit(1);
  }
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

function prView() {
  const checks = pr.checks.map((check) => ({ __typename: "CheckRun", name: check.name, status: "COMPLETED", conclusion: check.conclusion }));
  const all = {
    number: pr.number, state: pr.state, title: pr.title, headRefName: pr.headRefName,
    headRefOid: pr.headRefOid, mergeable: pr.mergeable, reviewDecision: pr.reviewDecision ?? "",
    statusCheckRollup: checks, url: `https://github.com/example/repo/pull/${pr.number}`,
    reviews: pr.reviews ?? [], latestReviews: pr.reviews ?? [],
    comments: threads().map((thread) => ({ author: { login: "reviewer" }, body: `${thread.comments.nodes[0].path}: ${thread.comments.nodes[0].body}` }))
  };
  const fields = flag("--json");
  if (!fields) {
    process.stdout.write(`${pr.title} #${pr.number}\n${pr.state} - ${pr.headRefName}\n`);
    if (argv.includes("--comments")) for (const comment of all.comments) process.stdout.write(`\n${comment.author.login}: ${comment.body}\n`);
    return;
  }
  emit(Object.fromEntries(fields.split(",").map((field) => [field, all[field] ?? null])));
}

function threads() {
  return Array.from({ length: pr.unresolvedThreads }, (_, index) => ({
    id: `T_${index}`, isResolved: false,
    comments: { nodes: [{ author: { login: "reviewer" }, path: pr.threadPath ?? "src/app.js", body: pr.threadBody ?? "This still breaks the empty-input case." }] }
  }));
}

const [group, command] = argv;
if (!pr) {
  process.stderr.write("gh fixture: no pull request in this scenario\n");
  process.exit(1);
} else if (group === "pr" && command === "view") prView();
else if (group === "pr" && command === "checks") {
  for (const check of pr.checks) process.stdout.write(`${check.name}\t${check.conclusion === "SUCCESS" ? "pass" : "fail"}\t1m\thttps://example.invalid\n`);
  process.exit(pr.checks.every((check) => check.conclusion === "SUCCESS") ? 0 : 1);
} else if (group === "pr" && command === "diff") {
  const diff = spawnSync("git", ["diff", `origin/main...HEAD`], { encoding: "utf8" });
  process.stdout.write(diff.stdout);
  process.exit(diff.status ?? 1);
} else if (group === "pr" && command === "merge") {
  process.stdout.write(`Merged pull request #${pr.number}\n`);
} else if (group === "api" && argv.includes("graphql")) {
  emit({ data: { repository: { pullRequest: { reviewThreads: { nodes: threads() } } } } });
} else if (group === "api" && /pulls\/\d+\/comments/.test(command ?? "")) {
  emit(threads().map((thread) => ({ path: thread.comments.nodes[0].path, body: thread.comments.nodes[0].body, user: { login: "reviewer" } })));
} else {
  process.stderr.write(`gh fixture: unsupported command: gh ${argv.join(" ")}\n`);
  process.exit(1);
}
