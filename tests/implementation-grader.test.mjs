import assert from "node:assert/strict";
import test from "node:test";
import { gradeChangedPaths, gradeRepositoryPaths } from "../scripts/grade-implementation.mjs";

const expected = {
  allowedPaths: ["payment.mjs"],
  forbiddenPaths: ["behavior.specimen.mjs"],
  maxChangedFiles: 1
};

test("accepts a focused implementation", () => {
  assert.deepEqual(gradeChangedPaths(["payment.mjs"], expected), []);
});

test("rejects test tampering", () => {
  assert.match(gradeChangedPaths(["behavior.specimen.mjs"], expected).join("\n"), /outside the allowed scope|forbidden/);
});

test("rejects scenario expansion", () => {
  assert.match(gradeChangedPaths(["payment.mjs", "helper.mjs"], expected).join("\n"), /maximum is 1/);
});

test("rejects edits outside the selected workspace", () => {
  const result = gradeRepositoryPaths(
    ["scenarios/implementation/example/workspace/payment.mjs", "AGENTS.md"],
    "scenarios/implementation/example/workspace/",
    expected
  );
  assert.match(result.errors.join("\n"), /outside the selected workspace: AGENTS.md/);
});
