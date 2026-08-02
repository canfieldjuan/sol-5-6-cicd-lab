import { appendFile } from "node:fs/promises";
import path from "node:path";
import { assertExactKeys, fail, isMain, readJson } from "./lib.mjs";

function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }

function boundedText(value, maximum) {
  return nonEmpty(value) && value.length <= maximum;
}

export function validateReviewOutput(output) {
  const errors = [];
  assertExactKeys(output, ["status", "reviewedHeadSha", "summary", "blockers", "advisory", "verification"], [], "output", errors);
  if (!["pass", "block"].includes(output.status)) errors.push("output.status must be pass or block");
  if (!/^[a-f0-9]{7,64}$/.test(output.reviewedHeadSha ?? "")) errors.push("output.reviewedHeadSha is invalid");
  if (!nonEmpty(output.summary) || output.summary.length > 1000) errors.push("output.summary must contain 1-1000 characters");
  if (!Array.isArray(output.blockers) || output.blockers.length > 5) errors.push("output.blockers must be an array with at most five items");
  else for (const [index, blocker] of output.blockers.entries()) {
    const label = `output.blockers[${index}]`;
    const fields = ["ruleId", "severity", "title", "path", "line", "trigger", "impact", "evidence", "remediation"];
    assertExactKeys(blocker, fields, [], label, errors);
    if (!/^[A-Z][A-Z0-9_]*$/.test(blocker.ruleId ?? "")) errors.push(`${label}.ruleId is invalid`);
    if (!["P0", "P1"].includes(blocker.severity)) errors.push(`${label}.severity must be P0 or P1`);
    const limits = { title: 120, path: 300, trigger: 500, impact: 500, evidence: 800, remediation: 500 };
    for (const [field, maximum] of Object.entries(limits)) {
      if (!boundedText(blocker[field], maximum)) errors.push(`${label}.${field} must contain 1-${maximum} characters`);
    }
    if (!Number.isInteger(blocker.line) || blocker.line < 1) errors.push(`${label}.line must be a positive integer`);
  }
  assertExactKeys(output.advisory, ["count", "themes"], [], "output.advisory", errors);
  if (!Number.isInteger(output.advisory?.count) || output.advisory.count < 0) errors.push("output.advisory.count must be non-negative");
  if (!Array.isArray(output.advisory?.themes) || output.advisory.themes.length > 3 || output.advisory.themes.some((item) => !nonEmpty(item))) {
    errors.push("output.advisory.themes must contain at most three non-empty strings");
  }
  assertExactKeys(output.verification, ["commandsRun", "limitations"], [], "output.verification", errors);
  for (const key of ["commandsRun", "limitations"]) {
    const maximumItems = key === "commandsRun" ? 20 : 10;
    if (!Array.isArray(output.verification?.[key]) || output.verification[key].length > maximumItems || output.verification[key].some((item) => typeof item !== "string" || item.length > 500)) {
      errors.push(`output.verification.${key} must contain at most ${maximumItems} strings of up to 500 characters`);
    }
  }
  if (output.status === "pass" && output.blockers?.length) errors.push("pass output cannot contain blockers");
  if (output.status === "block" && !output.blockers?.length) errors.push("block output must contain blockers");
  return errors;
}

async function main() {
  const file = process.argv[2];
  if (!file) return fail("Usage: node scripts/validate-review-output.mjs <output.json> [--expected-sha SHA] [--github-output FILE]");
  const output = await readJson(path.resolve(file));
  const errors = validateReviewOutput(output);
  const shaIndex = process.argv.indexOf("--expected-sha");
  if (shaIndex >= 0 && output.reviewedHeadSha !== process.argv[shaIndex + 1]) errors.push("reviewedHeadSha does not match the requested head");
  if (errors.length) return fail(`Review output validation failed:\n- ${errors.join("\n- ")}`);
  const outputIndex = process.argv.indexOf("--github-output");
  if (outputIndex >= 0) await appendFile(process.argv[outputIndex + 1], `status=${output.status}\nblocker_count=${output.blockers.length}\n`, "utf8");
  console.log("Review output is valid.");
}

if (isMain(import.meta.url)) await main();
