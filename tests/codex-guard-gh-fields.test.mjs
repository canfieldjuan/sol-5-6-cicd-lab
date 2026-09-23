import assert from "node:assert/strict";
import test from "node:test";
import { decide } from "../hooks/codex-guards/guard.mjs";
import { checkGhFields, satisfiesGhFields } from "../hooks/codex-guards/guards/gh-fields.mjs";
import { captureGhFields, parseGhFieldList } from "../scripts/install-codex-guards.mjs";

const config = { ghFields: { "pr view": ["number", "state", "reviewDecision", "statusCheckRollup", "headRefOid"], "issue view": ["state", "title"] } };
const check = (command) => checkGhFields({ command, config, helperInstalled: () => true });

test("unknown --json fields are denied with the valid list; PR commands also name codex-pr-status", () => {
  const finding = check("gh pr view 42 --json state,timelineItems --jq .state");
  assert.equal(finding.action, "deny");
  assert.match(finding.reason, /has no field\(s\): timelineItems/);
  assert.match(finding.reason, /Valid fields: number, state, reviewDecision/);
  assert.match(finding.reason, /codex-pr-status/);
  assert.equal(check("gh issue view 7 --json=state,labelsX").reason.includes("codex-pr-status"), false);
  assert.ok(check("cd /r && gh pr view --json nope"), "after a cd segment");
});

test("valid fields, other gh commands, unknown commands, no --json, and unreadable shell are allowed", () => {
  for (const command of [
    "gh pr view 42 --json state,reviewDecision", "gh pr view --json=statusCheckRollup", "gh pr checks 42",
    "gh api graphql -f query=x", "gh run view 1 --json nope", "gh pr view 42", "gh pr view --json \"$F\"", "echo gh pr view --json nope"
  ]) assert.equal(check(command), null, command);
  assert.equal(checkGhFields({ command: "gh pr view --json nope", config: {} }), null, "no captured list, no action");
});

test("satisfied by a later valid call to the same command or by codex-pr-status; not by the same mistake", () => {
  const pending = { code: "gh-fields", key: "pr view", valid: config.ghFields["pr view"] };
  assert.equal(satisfiesGhFields(pending, "gh pr view 42 --json reviewDecision"), true);
  assert.equal(satisfiesGhFields(pending, "codex-pr-status --repo o/r --pr 42"), true);
  assert.equal(satisfiesGhFields(pending, "gh pr view 42 --json timelineItems"), false);
  assert.equal(satisfiesGhFields(pending, "ls"), false);
});

test("dispatcher: deny, pending, then a valid retry clears it before Stop", () => {
  const denied = decide({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "gh pr view 42 --json timelineItems" } }, { pending: [] }, { config });
  assert.equal(denied.output.hookSpecificOutput.permissionDecision, "deny");
  const retried = decide({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "gh pr view 42 --json reviewDecision" } }, denied.state, { config });
  assert.equal(retried.output, null);
  assert.deepEqual(retried.state.pending, []);
});

test("install capture parses gh's own field listing and skips commands that do not list fields", () => {
  const listing = "Specify one or more comma-separated fields for `--json`:\n  additions\n  reviewDecision\n  state\n";
  assert.deepEqual(parseGhFieldList(listing), ["additions", "reviewDecision", "state"]);
  assert.equal(parseGhFieldList("unknown command"), null);
  const fake = (args) => (args[0] === "pr" && args[1] === "view" ? { stdout: "", stderr: listing } : { stdout: "", stderr: "error" });
  assert.deepEqual(captureGhFields(fake), { "pr view": ["additions", "reviewDecision", "state"] });
});

test("the reason leads with a concrete retry, and names codex-pr-status only when it is installed", () => {
  const without = checkGhFields({ command: "gh pr view 42 --json state,timelineItems --jq .state", config, helperInstalled: () => false });
  assert.match(without.reason, /Retry with: `gh pr view 42 --json state --jq \.state`/);
  assert.doesNotMatch(without.reason, /codex-pr-status/, "never point at a tool that is not there");
  const withHelper = checkGhFields({ command: "gh pr view 42 --json timelineItems", config, helperInstalled: () => true });
  assert.match(withHelper.reason, /codex-pr-status/);
  assert.doesNotMatch(withHelper.reason, /Retry with/, "no valid field left to retry with");
});

test("the retry replaces the --json value itself, not an earlier identical substring", () => {
  const finding = checkGhFields({ command: "echo state,nope && gh pr view 42 --json state,nope", config, helperInstalled: () => false });
  assert.match(finding.reason, /Retry with: `echo state,nope && gh pr view 42 --json state`/);
  const eq = checkGhFields({ command: "gh pr view 42 --json=nope,state", config, helperInstalled: () => false });
  assert.match(eq.reason, /Retry with: `gh pr view 42 --json=state`/);
});
