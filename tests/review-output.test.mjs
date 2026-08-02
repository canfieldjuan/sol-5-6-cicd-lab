import assert from "node:assert/strict";
import test from "node:test";
import { validateReviewOutput } from "../scripts/validate-review-output.mjs";

function output(overrides = {}) {
  return {
    status: "pass",
    reviewedHeadSha: "0123456789abcdef0123456789abcdef01234567",
    summary: "No blocking defect was proven.",
    blockers: [],
    advisory: { count: 0, themes: [] },
    verification: { commandsRun: [], limitations: [] },
    ...overrides
  };
}

test("accepts a bounded pass result", () => {
  assert.deepEqual(validateReviewOutput(output()), []);
});

test("rejects blockers attached to a pass result", () => {
  const invalid = output({ blockers: [{
    ruleId: "REAL_DEFECT", severity: "P1", title: "Failure", path: "app.js", line: 4,
    trigger: "A request fails", impact: "Data is lost", evidence: "The handler discards it",
    remediation: "Preserve the request"
  }] });
  assert.match(validateReviewOutput(invalid).join("\n"), /pass output cannot contain blockers/);
});

test("rejects lower-severity blocking findings", () => {
  const invalid = output({ status: "block", blockers: [{
    ruleId: "STYLE_ONLY", severity: "P2", title: "Naming", path: "app.js", line: 4,
    trigger: "The file is read", impact: "A name is verbose", evidence: "The variable has a long name",
    remediation: "Rename it"
  }] });
  assert.match(validateReviewOutput(invalid).join("\n"), /severity must be P0 or P1/);
});
