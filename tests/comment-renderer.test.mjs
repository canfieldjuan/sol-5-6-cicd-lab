import assert from "node:assert/strict";
import test from "node:test";
import { marker, renderReviewComment } from "../scripts/render-review-comment.mjs";

test("renders one replaceable pass comment", () => {
  const comment = renderReviewComment({
    status: "pass",
    reviewedHeadSha: "0123456789abcdef0123456789abcdef01234567",
    summary: "No blocker.", blockers: [],
    advisory: { count: 1, themes: ["Naming"] },
    verification: { commandsRun: [], limitations: [] }
  });
  assert.ok(comment.startsWith(marker));
  assert.match(comment, /Blocking findings:\*\* None/);
  assert.match(comment, /This comment is replaced/);
});
