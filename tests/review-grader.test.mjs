import assert from "node:assert/strict";
import test from "node:test";
import { gradeReview } from "../scripts/grade-review.mjs";

const scenario = {
  expected: {
    status: "block",
    requiredRuleIds: ["DATA_UNKNOWN_AS_ZERO"],
    forbiddenRuleIds: [],
    maxBlockers: 1,
    maxAdvisory: 0
  }
};

function blocker(ruleId = "DATA_UNKNOWN_AS_ZERO") {
  return {
    ruleId, severity: "P1", title: "Unknown becomes zero", path: "schedule.js", line: 2,
    trigger: "The field is absent", impact: "Users see a false zero", evidence: "The fallback is zero",
    remediation: "Preserve the unknown state"
  };
}

function result(blockers = [blocker()]) {
  return {
    status: blockers.length ? "block" : "pass",
    reviewedHeadSha: "0123456789abcdef0123456789abcdef01234567",
    summary: "Review complete.", blockers,
    advisory: { count: 0, themes: [] },
    verification: { commandsRun: [], limitations: [] }
  };
}

test("grades the required root cause", () => {
  assert.deepEqual(gradeReview(scenario, result()), []);
});

test("rejects duplicate manifestations of one root cause", () => {
  assert.match(gradeReview({ ...scenario, expected: { ...scenario.expected, maxBlockers: 2 } }, result([blocker(), blocker()])).join("\n"), /Duplicate root-cause/);
});

test("rejects a missed blocking contract", () => {
  assert.match(gradeReview(scenario, result([])).join("\n"), /Expected status block|Missing required rule/);
});
