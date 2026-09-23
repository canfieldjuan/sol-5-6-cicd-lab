import assert from "node:assert/strict";
import test from "node:test";
import { main, paginate, prStatus } from "../hooks/codex-guards/bin/codex-pr-status.mjs";

const HEAD = "a".repeat(40);
function fakeGh({ head = HEAD, threadPages = [[{ isResolved: false, isOutdated: false, path: "a.js", line: 3, comments: { nodes: [{ author: { login: "codex" }, bodyText: "guard 0" } ] } }]], checksExit = 8, required = [{ name: "ci", bucket: "pending", state: "PENDING" }], graphqlErrors = false, headDrift = false } = {}) {
  let threadCall = 0;
  return (args) => {
    if (args[0] === "pr" && args[1] === "view") return { code: 0, stdout: JSON.stringify({ number: 4, title: "t", url: "u", state: "OPEN", isDraft: false, baseRefName: "main", headRefName: "b", headRefOid: head, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", reviewDecision: "" }), stderr: "" };
    if (args[0] === "pr" && args[1] === "checks") {
      const list = args.includes("--required") ? required : [...required, { name: "lint", bucket: "pass", state: "SUCCESS" }];
      return { code: checksExit, stdout: JSON.stringify(list), stderr: "" };
    }
    if (args[0] === "api" && args[1] === "graphql") {
      if (graphqlErrors) return { code: 0, stdout: JSON.stringify({ errors: [{ message: "Field 'diffHunk' doesn't exist" }] }), stderr: "" };
      const query = args.find((a) => a.startsWith("query="));
      if (query.includes("reviewThreads")) {
        const page = threadPages[threadCall];
        threadCall += 1;
        const hasNext = threadCall < threadPages.length;
        const oid = headDrift && threadCall > 1 ? "b".repeat(40) : head;
        return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: oid, reviewThreads: { pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? `c${threadCall}` : null }, nodes: page } } } } }), stderr: "" };
      }
      return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: head, reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ author: { login: "chatgpt-codex-connector" }, commit: { oid: head }, state: "COMMENTED" }] } } } } }), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
}

test("assembles state, checks (pending exit 8 still parsed), reviews on head, and unresolved threads", () => {
  const status = prStatus({ repo: "o/r", pr: "4" }, fakeGh());
  assert.equal(status.head.sha, HEAD);
  assert.deepEqual({ total: status.checks.required.total, pending: status.checks.required.pending }, { total: 1, pending: 1 });
  assert.equal(status.checks.all.pass, 1);
  assert.equal(status.reviews[0].onHead, true);
  assert.equal(status.threads.unresolved, 1);
  assert.equal(status.threads.list[0].author, "codex");
  assert.equal(status.reviewDecision, null, "an empty reviewDecision is reported as null");
});

test("threads are paginated to the end; resolved threads are not counted", () => {
  const unresolved = { isResolved: false, isOutdated: true, path: "x", line: 1, comments: { nodes: [] } };
  const resolved = { isResolved: true, isOutdated: false, path: "y", line: 2, comments: { nodes: [] } };
  const status = prStatus({ repo: "o/r", pr: 4 }, fakeGh({ threadPages: [[unresolved, resolved], [unresolved]] }));
  assert.equal(status.threads.unresolved, 2);
  assert.equal(status.threads.unresolvedOutdated, 2);
});

test("fails loudly: head changes mid-pagination, GraphQL errors, and bad arguments", () => {
  assert.throws(() => prStatus({ repo: "o/r", pr: 4 }, fakeGh({ threadPages: [[], []], headDrift: true })), /PR head changed during pagination/);
  assert.throws(() => prStatus({ repo: "o/r", pr: 4 }, fakeGh({ graphqlErrors: true })), /GraphQL errors/);
  assert.throws(() => prStatus({ repo: "nope", pr: 4 }, fakeGh()), /usage/);
  assert.throws(() => prStatus({ repo: "o/r", pr: "x" }, fakeGh()), /usage/);
});

test("no required checks configured is an empty list, not an error; other checks failures are errors", () => {
  const noRequired = (args) => (args[0] === "pr" && args[1] === "checks" && args.includes("--required") ? { code: 1, stdout: "", stderr: "no required checks reported on the 'b' branch" } : fakeGh()(args));
  assert.equal(prStatus({ repo: "o/r", pr: 4 }, noRequired).checks.required.total, 0);
  const broken = (args) => (args[0] === "pr" && args[1] === "checks" ? { code: 1, stdout: "", stderr: "HTTP 502" } : fakeGh()(args));
  assert.throws(() => prStatus({ repo: "o/r", pr: 4 }, broken), /HTTP 502/);
});

test("main prints JSON and exits 0, or prints a JSON error and exits 2", () => {
  let out = ""; let err = "";
  assert.equal(main(["--repo", "o/r", "--pr", "4"], fakeGh(), (t) => { out += t; }, (t) => { err += t; }), 0);
  assert.equal(JSON.parse(out).pr, 4);
  assert.equal(main(["--pr", "4"], fakeGh(), () => {}, (t) => { err += t; }), 2);
  assert.match(JSON.parse(err).error, /usage/);
});

test("paginate caps runaway pagination", () => {
  const forever = () => ({ code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: HEAD, reviews: { pageInfo: { hasNextPage: true, endCursor: "c" }, nodes: [] } } } } }), stderr: "" });
  assert.throws(() => paginate("q", "reviews", { owner: "o", name: "r", pr: 4 }, forever), /more than 20 pages/);
});
